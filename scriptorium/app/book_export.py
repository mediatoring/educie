"""Book output: print/PDF page (paged with paged.js) and EPUB 3 e-book.

Both are built from the same parts: cover, title page, colophon (tiráž), body with the
automatic table of contents and manual page breaks ("Nová stránka").
"""
import html
import io
import mimetypes
import os
import re
import time
import uuid
import zipfile

LANG_NAMES = {"cs": "cs", "de": "de", "en": "en"}


def esc(t):
    return html.escape(str(t or ""), quote=True)


def plain(t):
    return html.unescape(re.sub(r"<[^>]+>", "", t or "")).strip()


# ---------- shared parts ----------
def number_headings(body):
    """Give every chapter heading an id; return (body, [(level, id, text)])."""
    heads = []
    counter = [0]

    def tag_head(m):
        counter[0] += 1
        text = plain(m.group(3))
        if not text:
            return m.group(0)
        hid = f"kap-{counter[0]}"
        heads.append((int(m.group(1)), hid, text))
        attrs = re.sub(r'\s*id="[^"]*"', "", m.group(2))
        return f'<h{m.group(1)}{attrs} id="{hid}">{m.group(3)}</h{m.group(1)}>'
    body = re.sub(r"<h([123])([^>]*)>(.*?)</h\1>", tag_head, body, flags=re.S)
    return body, heads


def toc_html(heads, page_numbers=True):
    items = "".join(
        f'<li class="l{lvl}"><a href="#{hid}">{esc(t)}</a></li>' for lvl, hid, t in heads)
    return f'<nav class="toc{" toc-pages" if page_numbers else ""}"><h2 class="toc-title">Obsah</h2><ol>{items}</ol></nav>'


def title_page(st):
    lines = []
    if st.get("author"):
        lines.append(f'<p class="tp-author">{esc(st["author"])}</p>')
    lines.append(f'<h1 class="tp-title">{esc(st.get("title"))}</h1>')
    if st.get("subtitle"):
        lines.append(f'<p class="tp-subtitle">{esc(st["subtitle"])}</p>')
    if st.get("editor"):
        lines.append(f'<p class="tp-editor">{esc(st["editor"])}</p>')
    bottom = " · ".join(esc(x) for x in (st.get("publisher"), st.get("place"), st.get("year")) if x)
    if bottom:
        lines.append(f'<p class="tp-publisher">{bottom}</p>')
    return '<section class="title-page">' + "".join(lines) + "</section>"


def colophon(st):
    rows = []
    def add(label, key):
        if st.get(key):
            rows.append(f"<p>{esc(label)}{esc(st[key])}</p>" if label else f"<p>{esc(st[key])}</p>")
    who = st.get("author") or ""
    title = st.get("title") or ""
    rows.append(f"<p><b>{esc(who + (': ' if who else '') + title)}</b>{(' – ' + esc(st['subtitle'])) if st.get('subtitle') else ''}</p>")
    add("Edice: ", "series")
    add("", "editor")
    add("Vydání: ", "edition")
    pub = ", ".join(x for x in (st.get("publisher"), st.get("place"), st.get("year")) if x)
    if pub:
        rows.append(f"<p>Vydal(o) {esc(pub)}</p>")
    add("", "illustrations")
    add("", "thanks")
    add("", "note")
    add("", "license")
    add("", "copyright")
    if st.get("isbn_pdf"):
        rows.append(f"<p>ISBN {esc(st['isbn_pdf'])} (PDF)</p>")
    if st.get("isbn_epub"):
        rows.append(f"<p>ISBN {esc(st['isbn_epub'])} (ePub)</p>")
    return '<section class="colophon">' + "".join(r.replace("\n", "<br>") for r in rows) + "</section>"


def prepare_body(body, heads):
    body = re.sub(r'<div class="var-toc">.*?</div>', toc_html(heads), body, flags=re.S)
    body = re.sub(r'<div class="var-break">.*?</div>', '<div class="page-break"></div>', body, flags=re.S)
    return body


# ---------- print / PDF ----------
PRINT_CSS = """
@page { size: A4; margin: 24mm 22mm 26mm;
  @top-center { content: string(booktitle); font: 9pt Georgia, serif; color: #666; }
  @bottom-center { content: %(footer)s; font: 10pt Georgia, serif; color: #444; } }
@page:first { @top-center { content: none; } @bottom-center { content: none; } }
@page cover { margin: 0; @top-center { content: none; } @bottom-center { content: none; } }
@page front { @top-center { content: none; } @bottom-center { content: none; } }
body { font-family: Georgia, 'Times New Roman', serif; line-height: 1.6; color: #111; font-size: 11.5pt; }
.booktitle { string-set: booktitle content(text); display: none; }
.cover { page: cover; break-after: page; width: 210mm; height: 297mm; overflow: hidden; }
.cover img { width: 100%%; height: 100%%; object-fit: cover; display: block; }
.title-page { page: front; break-after: page; text-align: center; padding-top: 50mm; }
.tp-author { font-size: 15pt; letter-spacing: .05em; margin-bottom: 14mm; }
.title-page .tp-title { font-size: 28pt; font-weight: normal; line-height: 1.25; margin: 0 0 8mm; padding: 0; break-before: avoid; text-align: center; }
.title-page p, .colophon p { text-align: center; }
.colophon p { text-align: left; }
.tp-subtitle { font-size: 15pt; font-style: italic; }
.tp-editor { margin-top: 18mm; }
.tp-publisher { margin-top: 70mm; font-size: 11pt; letter-spacing: .04em; }
.colophon { page: front; break-after: page; font-size: 9.5pt; line-height: 1.5; padding-top: 150mm; }
.colophon p { margin: 0 0 2.5mm; }
h1:not(.tp-title) { font-size: 21pt; text-align: center; font-weight: normal; margin: 0 0 12mm; padding-top: 18mm; break-before: page; break-after: avoid; }
h2 { font-size: 15pt; font-weight: normal; margin: 9mm 0 3mm; break-after: avoid; }
h3 { font-size: 12.5pt; margin: 7mm 0 2mm; break-after: avoid; }
p { margin: 0 0 3mm; text-align: justify; hyphens: auto; orphans: 2; widows: 2; }
blockquote { margin: 4mm 10mm; font-style: italic; color: #333; }
blockquote .cite { font-style: normal; font-size: 9pt; text-align: right; }
figure { margin: 5mm 0; text-align: center; break-inside: avoid; }
img { max-width: 100%%; }
figcaption { font-size: 9pt; color: #444; text-align: center; }
figcaption .src { display: block; font-size: 8pt; color: #777; }
.toc { break-before: page; break-after: page; }
.toc-title { text-align: center; font-size: 18pt; margin-bottom: 8mm; }
.toc ol { list-style: none; padding: 0; margin: 0; }
.toc li { margin: 1.6mm 0; }
.toc li.l2 { padding-left: 7mm; } .toc li.l3 { padding-left: 14mm; font-size: 10pt; }
.toc a { color: inherit; text-decoration: none; display: flex; }
.toc-pages a::after { content: target-counter(attr(href), page); margin-left: auto; padding-left: 4mm; }
.toc-pages a { border-bottom: 1px dotted #bbb; }
.page-break { break-after: page; height: 0; }
.toolbar { position: fixed; top: 10px; right: 10px; z-index: 10; display: flex; gap: 8px; }
.toolbar button { font: 16px system-ui, sans-serif; padding: 10px 16px; border-radius: 8px; border: 1px solid #1f6feb; background: #1f6feb; color: #fff; cursor: pointer; }
.toolbar .wait { background: #fff; color: #333; border-color: #ccc; }
@media screen { body { background: #e9ebee; } .pagedjs_page { background: #fff; margin: 16px auto; box-shadow: 0 1px 8px rgba(0,0,0,.2); } }
@media print { .toolbar { display: none; } }
"""


def print_page(st, body, cover_src):
    body, heads = number_headings(body)
    body = prepare_body(body, heads)
    footer = "counter(page)" if st.get("footer_numbers", True) else "none"
    header = st.get("header") or st.get("title") or ""
    parts = []
    if cover_src:
        parts.append(f'<section class="cover"><img src="{esc(cover_src)}" alt=""></section>')
    parts.append(title_page(st).replace('<section class="title-page">', f'<section class="title-page"><p class="booktitle">{esc(header)}</p>', 1))
    parts.append(colophon(st))
    parts.append(body)
    lang = LANG_NAMES.get(st.get("language"), "cs")
    return f"""<!DOCTYPE html>
<html lang="{lang}"><head><meta charset="utf-8"><base href="../../"><title>{esc(st.get('title'))}</title>
<style>{PRINT_CSS % {"footer": footer}}</style>
<script>window.PagedConfig = {{ auto: true, after: () => {{ const b = document.getElementById("printBtn"); b.disabled = false; b.className = ""; b.textContent = "Tisk / uložit jako PDF"; }} }};</script>
<script src="vendor/paged.polyfill.min.js"></script>
</head><body>
<div class="toolbar"><button id="printBtn" class="wait" disabled onclick="window.print()">Připravuji stránky…</button></div>
{"".join(parts)}
</body></html>"""


# ---------- EPUB 3 ----------
EPUB_CSS = """
body { font-family: Georgia, serif; line-height: 1.55; margin: 0 4%; }
h1 { font-size: 1.6em; text-align: center; font-weight: normal; margin: 2em 0 1em; }
h2 { font-size: 1.25em; font-weight: normal; margin: 1.5em 0 .5em; }
h3 { font-size: 1.05em; margin: 1.2em 0 .4em; }
p { margin: 0 0 .6em; text-align: justify; }
blockquote { margin: 1em 1.5em; font-style: italic; }
blockquote .cite { font-style: normal; font-size: .85em; text-align: right; }
figure { margin: 1em 0; text-align: center; }
img { max-width: 100%; }
figcaption { font-size: .85em; color: #444; }
figcaption .src { display: block; font-size: .8em; color: #777; }
.title-page { text-align: center; margin-top: 20%; }
.tp-title { font-size: 2em; font-weight: normal; }
.tp-subtitle { font-style: italic; }
.tp-publisher { margin-top: 4em; }
.colophon { font-size: .85em; margin-top: 30%; }
.toc ol { list-style: none; padding: 0; } .toc li.l2 { padding-left: 1.5em; } .toc li.l3 { padding-left: 3em; }
.toc a { text-decoration: none; color: inherit; }
.cover { text-align: center; margin: 0; } .cover img { max-height: 100%; }
"""


def xhtml(title, body, lang):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{lang}" lang="{lang}">
<head><meta charset="utf-8"/><title>{esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>{body}</body></html>"""


def to_xhtml(fragment):
    """Make editor HTML well-formed XHTML."""
    fragment = re.sub(r"<(br|hr|img)([^>]*?)\s*/?>", r"<\1\2/>", fragment)
    fragment = fragment.replace("&nbsp;", "&#160;")
    fragment = re.sub(r"&(?!#?\w+;)", "&amp;", fragment)
    return fragment


def epub(st, body, read_image):
    """read_image(src) -> (bytes, mime) or None. Returns the .epub file as bytes."""
    lang = LANG_NAMES.get(st.get("language"), "cs")
    title = st.get("title") or "Kniha"
    body, heads = number_headings(body)
    images = {}

    def take_image(m):
        src = m.group(1)
        if src not in images:
            got = read_image(src)
            if not got:
                return m.group(0)
            data, mime = got
            ext = mimetypes.guess_extension(mime) or ".jpg"
            images[src] = (f"images/img{len(images) + 1}{ext}", data, mime)
        return f'src="{images[src][0]}"'
    body = re.sub(r'src="([^"]+)"', take_image, body)

    # split into chapter files at top-level headings and manual page breaks
    chunks, cur = [], ""
    for piece in re.split(r'(<h1[^>]*>.*?</h1>|<div class="var-break">.*?</div>)', body, flags=re.S):
        if not piece:
            continue
        if piece.startswith("<h1") and cur.strip():
            chunks.append(cur); cur = piece
        elif piece.startswith('<div class="var-break"'):
            if cur.strip():
                chunks.append(cur)
            cur = ""
        else:
            cur += piece
    if cur.strip():
        chunks.append(cur)
    files = []  # (name, title, xhtml body)
    where = {}
    for i, ch in enumerate(chunks, 1):
        name = f"text{i:03d}.xhtml"
        for hid in re.findall(r'<h[123][^>]* id="(kap-\d+)"', ch):
            where[hid] = name
        m = re.search(r"<h1[^>]*>(.*?)</h1>", ch, re.S)
        files.append([name, plain(m.group(1)) if m else title, ch])
    # automatic table of contents inside the text
    for f in files:
        if '<div class="var-toc">' in f[2]:
            items = "".join(f'<li class="l{lvl}"><a href="{where.get(hid, "")}#{hid}">{esc(t)}</a></li>' for lvl, hid, t in heads)
            f[2] = re.sub(r'<div class="var-toc">.*?</div>', f'<nav class="toc"><h2>Obsah</h2><ol>{items}</ol></nav>', f[2], flags=re.S)

    cover_name = None
    cover = st.get("cover")
    if cover:
        got = read_image(cover)
        if got:
            data, mime = got
            cover_name = "images/cover" + (mimetypes.guess_extension(mime) or ".jpg")
            images["__cover__"] = (cover_name, data, mime)

    book_id = st.get("isbn_epub") or "urn:uuid:" + str(uuid.uuid5(uuid.NAMESPACE_URL, title + (st.get("author") or "")))
    modified = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    front = [("title.xhtml", "Titulní strana", title_page(st)), ("colophon.xhtml", "Tiráž", colophon(st))]
    if cover_name:
        front.insert(0, ("cover.xhtml", "Obálka", f'<section class="cover" epub:type="cover"><img src="{cover_name}" alt="{esc(title)}"/></section>'))
    all_files = front + [tuple(f) for f in files]

    nav_items = "".join(f'<li><a href="{where.get(hid, "")}#{hid}">{esc(t)}</a></li>' for lvl, hid, t in heads if lvl == 1) \
        or "".join(f'<li><a href="{n}">{esc(t)}</a></li>' for n, t, _ in files)
    nav = f'<nav epub:type="toc" id="toc"><h1>Obsah</h1><ol>{nav_items}</ol></nav>'
    ncx_points = "".join(
        f'<navPoint id="np{i}" playOrder="{i}"><navLabel><text>{esc(t)}</text></navLabel><content src="{n}"/></navPoint>'
        for i, (n, t, _) in enumerate(all_files, 1))

    manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
                '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
                '<item id="css" href="style.css" media-type="text/css"/>']
    spine = []
    for i, (n, _, _) in enumerate(all_files, 1):
        manifest.append(f'<item id="f{i}" href="{n}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="f{i}"/>')
    for k, (name, _, mime) in images.items():
        props = ' properties="cover-image"' if k == "__cover__" else ""
        manifest.append(f'<item id="{name.replace("/", "_").replace(".", "_")}" href="{name}" media-type="{mime}"{props}/>')
    meta = [f"<dc:identifier id=\"bookid\">{esc(book_id)}</dc:identifier>", f"<dc:title>{esc(title)}</dc:title>",
            f"<dc:language>{lang}</dc:language>", f'<meta property="dcterms:modified">{modified}</meta>']
    if st.get("author"):
        meta.append(f"<dc:creator>{esc(st['author'])}</dc:creator>")
    if st.get("publisher"):
        meta.append(f"<dc:publisher>{esc(st['publisher'])}</dc:publisher>")
    if st.get("year"):
        meta.append(f"<dc:date>{esc(st['year'])}</dc:date>")
    if st.get("copyright") or st.get("license"):
        meta.append(f"<dc:rights>{esc(st.get('copyright') or st.get('license'))}</dc:rights>")
    if cover_name:
        meta.append(f'<meta name="cover" content="{images["__cover__"][0].replace("/", "_").replace(".", "_")}"/>')
    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="{lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">{''.join(meta)}</metadata>
<manifest>{''.join(manifest)}</manifest>
<spine toc="ncx">{''.join(spine)}</spine>
</package>"""
    ncx = f"""<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="{esc(book_id)}"/></head>
<docTitle><text>{esc(title)}</text></docTitle><navMap>{ncx_points}</navMap></ncx>"""

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>""", compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/toc.ncx", ncx, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", xhtml("Obsah", nav, lang), compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/style.css", EPUB_CSS, compress_type=zipfile.ZIP_DEFLATED)
        for n, t, b in all_files:
            z.writestr("OEBPS/" + n, xhtml(t, to_xhtml(b), lang), compress_type=zipfile.ZIP_DEFLATED)
        for name, data, _ in images.values():
            z.writestr("OEBPS/" + name, data, compress_type=zipfile.ZIP_STORED)
    return buf.getvalue()
