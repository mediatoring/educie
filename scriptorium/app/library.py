"""Image library: free-standing images (downloaded, scanned photos…) with caption and source,
plus an aggregated gallery of all images in books and in the manuscript.

    <data>/images/<file>          image files
    <data>/images/library.json    [{file, caption, source, url, added}]
"""
import base64
import html
import json
import os
import re
import time
import uuid

IMAGE_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}


class Library:
    def __init__(self, root):
        self.root = root
        self.dir = os.path.join(root, "images")
        os.makedirs(self.dir, exist_ok=True)
        self.meta = os.path.join(self.dir, "library.json")

    def items(self):
        try:
            with open(self.meta, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = []
        known = {d["file"] for d in data}
        # files copied into the folder by hand appear too
        for name in sorted(os.listdir(self.dir)):
            if os.path.splitext(name)[1].lower() in (".jpg", ".jpeg", ".png", ".gif", ".webp") and name not in known:
                data.append({"file": name, "caption": "", "source": "", "added": ""})
        return [d for d in data if os.path.exists(os.path.join(self.dir, d["file"]))]

    def _write(self, items):
        tmp = self.meta + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.meta)

    def add(self, data_url, caption="", source="", original_name=""):
        head, data = data_url.split(",", 1)
        ext = IMAGE_EXT.get(head.split(":")[1].split(";")[0])
        if not ext:
            raise ValueError("nepodporovaný typ obrázku")
        base = re.sub(r"[^\w\-]+", "_", os.path.splitext(original_name)[0])[:40] or "obrazek"
        name = f"{time.strftime('%Y%m%d')}_{uuid.uuid4().hex[:5]}_{base}{ext}"
        items = self.items()
        with open(os.path.join(self.dir, name), "wb") as f:
            f.write(base64.b64decode(data))
        items.append({"file": name, "caption": caption, "source": source, "added": time.strftime("%Y-%m-%d")})
        self._write(items)
        return name

    def update(self, file, caption, source):
        items = self.items()
        for it in items:
            if it["file"] == file:
                it["caption"], it["source"] = caption, source
        self._write(items)


def figure_caption(caption, source):
    """HTML caption with separate source line, used in the manuscript."""
    cap = html.escape(caption or "")
    src = html.escape(source or "")
    return cap + (f'<span class="src">Zdroj: {src}</span>' if src else "")


def gallery(root, books, library):
    """All images: library, book image blocks, manuscript figures."""
    out = []
    for it in library.items():
        out.append({"kind": "library", "src": "books/images/" + it["file"], "file": it["file"],
                    "caption": it.get("caption", ""), "source": it.get("source", ""), "where": "Knihovna obrázků"})
    for b in books:
        with open(os.path.join(root, b["id"], "project.json"), encoding="utf-8") as f:
            project = json.load(f)
        title = re.sub(r"\s*\(.*\)\s*$", "", project.get("title", b["id"]))
        for pi, page in enumerate(project["pages"]):
            for blk in page["blocks"]:
                if blk["type"] != "image":
                    continue
                default_src = f"{title}{', s. ' + str(page['page_no']) if page.get('page_no') else ''}"
                out.append({"kind": "book", "src": f"books/{b['id']}/{blk['src']}" + (f"?v={blk['v']}" if blk.get("v") else ""),
                            "book": b["id"], "bookSrc": blk["src"], "page": pi, "block": blk["id"],
                            "caption": blk.get("caption", ""), "source": blk.get("source") or default_src,
                            "where": f"{title} · {'s. ' + str(page['page_no']) if page.get('page_no') else 'str. ' + str(pi + 1)}"})
    doc_path = os.path.join(root, "_rukopis", "document.html")
    if os.path.exists(doc_path):
        with open(doc_path, encoding="utf-8") as f:
            doc = f.read()
        for i, m in enumerate(re.finditer(r'<img[^>]*src="([^"]+)"[^>]*>(?:\s*<figcaption>(.*?)</figcaption>)?', doc, re.S)):
            cap_html = m.group(2) or ""
            src_m = re.search(r'<span class="src">Zdroj:\s*(.*?)</span>', cap_html, re.S)
            caption = html.unescape(re.sub(r"<[^>]+>", "", re.sub(r'<span class="src">.*?</span>', "", cap_html))).strip()
            out.append({"kind": "manuscript", "src": m.group(1), "index": i, "caption": caption,
                        "source": html.unescape(src_m.group(1)).strip() if src_m else "", "where": "Můj rukopis"})
    return out
