#!/usr/bin/env python3
"""Publisher – local editor for scanned books.

Runs with the Python standard library only:
    python3 server.py            -> http://localhost:2209
The parent folder of app/ holds the books (any folder with project.json).
"""
import base64
import html
import json
import os
import re
import shutil
import sys
import time
import unicodedata
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, unquote, urlparse

from auth import Auth
from audit import Audit, device_label
from importer import Importer
from mcp_server import MCP
import rag
import book_export
from library import Library, figure_caption, gallery
from manuscript import Conflict, Manuscript, Manuscripts
from settings import Settings
from support import Support
from proof import Proofreader

PORT = int(os.environ.get("PUBLISHER_PORT", "2209"))
APP_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.environ.get("PUBLISHER_DATA") or os.path.dirname(APP_DIR))
HOST = os.environ.get("PUBLISHER_HOST", "127.0.0.1")
STATIC_DIR = os.path.join(APP_DIR, "static")
HISTORY_KEEP = 300
BOOK_SNAPSHOT_EVERY = 180
SAFE_NAME = re.compile(r"^[\w\-. ]+$")
MSS = Manuscripts(ROOT)
AUTH = Auth(ROOT)
LIB = Library(ROOT)
SETTINGS = Settings(ROOT)
SUPPORT = Support(ROOT, APP_DIR)
PROOF = Proofreader(ROOT)
AUDIT = Audit(ROOT)
AUTH.alert = SUPPORT.alert
PUBLIC_PATHS = {"/login.html", "/login.css", "/fp.js", "/api/login", "/healthz", "/favicon.ico"}


def book_dir(name):
    if not SAFE_NAME.match(name) or name.startswith("."):
        raise ValueError("bad book name")
    path = os.path.join(ROOT, name)
    if not os.path.isfile(os.path.join(path, "project.json")):
        raise FileNotFoundError(name)
    return path


def list_books():
    books = []
    for name in sorted(os.listdir(ROOT)):
        pj = os.path.join(ROOT, name, "project.json")
        if os.path.isfile(pj):
            try:
                with open(pj, encoding="utf-8") as f:
                    data = json.load(f)
                pages = data.get("pages", [])
                empty = sum(1 for p in pages if not any(b.get("type") == "text" and b.get("html") for b in p.get("blocks", [])))
                books.append({"id": name, "title": data.get("title", name), "pages": len(pages), "empty": empty,
                              "lang": data.get("lang", ""),
                              "ocr_running": IMPORTER.running(name)})
            except (OSError, ValueError):
                books.append({"id": name, "title": name + " (chyba v project.json)", "pages": 0})
    return books


def books_overview(max_chars=350):
    """Short description of every book (title + text of the first pages) for the question column."""
    out = []
    for b in list_books():
        try:
            with open(os.path.join(ROOT, b["id"], "project.json"), encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        bits = []
        for page in data.get("pages", [])[:3]:
            for blk in page.get("blocks", []):
                t = blk.get("text") or blk.get("caption") or re.sub(r"<[^>]+>", " ", blk.get("html", ""))
                if t and t.strip():
                    bits.append(" ".join(t.split()))
        text = " | ".join(bits)[:max_chars]
        out.append(f"- {data.get('title', b['id'])}: {text}")
    return "\n".join(out)


def book_history(path):
    hist = os.path.join(path, ".history")
    out = []
    if os.path.isdir(hist):
        for name in sorted((f for f in os.listdir(hist) if f.startswith("project-")), reverse=True):
            stamp = name[8:-5]
            try:
                with open(os.path.join(hist, name), encoding="utf-8") as f:
                    p = json.load(f)
                words = sum(len(plain(b.get("html", "")).split()) for pg in p.get("pages", []) for b in pg.get("blocks", []))
            except (OSError, ValueError):
                words = 0
            out.append({"name": name, "time": f"{stamp[6:8]}. {stamp[4:6]}. {stamp[:4]} {stamp[9:11]}:{stamp[11:13]}", "words": words})
    return with_editors("book:" + os.path.basename(path), out)


def with_editors(key, items):
    """Adds to each history item who made that version (login, IP, device), from the audit log."""
    times = []
    for it in items:
        m = re.search(r"(\d{8})-(\d{6})", it["name"])
        times.append(time.mktime(time.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")) if m else 0)
    for it, who in zip(items, AUDIT.editors(key, times)):
        it["who"] = who
    return items


def image_origin(src):
    """Finds the scan page an image of the manuscript was cut from.

    `src` is either "<book>/<file>" (data-origin of the image) or the manuscript image path,
    whose file name is "<book>_<6 hex>_<file>" when it was copied from a source book."""
    name = os.path.basename(src.split("?")[0])
    if "/" in src and not src.startswith("books/"):
        book, file = src.split("/", 1)
    else:
        m = re.match(r"^(.+?)_[0-9a-f]{6}_(.+)$", name)
        if not m:
            return {"found": False}
        book, file = m.group(1), m.group(2)
    try:
        path = book_dir(book)
    except (ValueError, FileNotFoundError):
        return {"found": False}
    with open(os.path.join(path, "project.json"), encoding="utf-8") as f:
        project = json.load(f)
    file = os.path.basename(file)
    for pi, page in enumerate(project.get("pages", [])):
        for b in page.get("blocks", []):
            if b.get("type") == "image" and os.path.basename(b.get("src", "")) == file and page.get("scan"):
                return {"found": True, "book": book, "file": file, "page": pi, "page_no": page.get("page_no"),
                        "scan": f"books/{book}/{page['scan']}", "size": page.get("size"),
                        "crop": b.get("crop"), "rotate": b.get("rotate", 0), "quarter": b.get("quarter", 0), "title": project.get("title", book)}
    return {"found": False}


def restore_book(path, name):
    src = os.path.join(path, ".history", os.path.basename(name))
    with open(src, encoding="utf-8") as f:
        project = json.load(f)
    pj = os.path.join(path, "project.json")
    shutil.copy2(pj, os.path.join(path, ".history", time.strftime("project-%Y%m%d-%H%M%S.json")))
    tmp = pj + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(project, f, ensure_ascii=False, indent=1)
    os.replace(tmp, pj)
    return project


def save_project(path, project):
    pj = os.path.join(path, "project.json")
    hist = os.path.join(path, ".history")
    os.makedirs(hist, exist_ok=True)
    if os.path.exists(pj):
        old = sorted(f for f in os.listdir(hist) if f.startswith("project-"))
        # a version every few minutes while working (autosave runs every few seconds)
        if not old or time.time() - os.path.getmtime(os.path.join(hist, old[-1])) > BOOK_SNAPSHOT_EVERY:
            shutil.copy2(pj, os.path.join(hist, time.strftime("project-%Y%m%d-%H%M%S.json")))
            old = sorted(f for f in os.listdir(hist) if f.startswith("project-"))
            for f in old[:-HISTORY_KEEP]:
                os.remove(os.path.join(hist, f))
    tmp = pj + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(project, f, ensure_ascii=False, indent=1)
    os.replace(tmp, pj)


IMPORTER = Importer(ROOT, SETTINGS, save_project, AUDIT)
MCPS = MCP(ROOT, book_dir, list_books, save_project, IMPORTER, AUDIT, SUPPORT.version())


FONTS = {"serif": "Georgia, serif", "book": "'Times New Roman', serif", "palatino": "Palatino, serif",
         "sans": "Helvetica, Arial, sans-serif"}
SIZES = {"s": ".85em", "l": "1.2em", "xl": "1.45em"}


def block_css(b):
    css = []
    if b.get("align") in ("left", "center", "right", "justify"):
        css.append(f"text-align:{b['align']}")
    if b.get("font") in FONTS:
        css.append(f"font-family:{FONTS[b['font']]}")
    if b.get("size") in SIZES:
        css.append(f"font-size:{SIZES[b['size']]}")
    return ";".join(css)


def last_paragraph(items):
    """Last text item if only page marks follow it, else None."""
    for it in reversed(items):
        if it[0] == "mark":
            continue
        return it if it[0] == "text" and it[1] == "p" else None
    return None


def prev_text_continues(left, right):
    plain_right = re.sub(r"<[^>]+>", "", right).lstrip()
    plain_left = re.sub(r"<[^>]+>", "", left).rstrip()
    if not plain_right or not plain_left:
        return False
    if plain_left.endswith("-"):
        return True
    return plain_right[0].islower() and plain_left[-1] not in ".!?:;"


def export_html(path, mode="orig"):
    with open(os.path.join(path, "project.json"), encoding="utf-8") as f:
        project = json.load(f)
    # items: ("mark", label) | ("text", style, html) | ("image", src, caption)
    items = []
    for page in project["pages"]:
        if page.get("skip"):
            continue
        label = f"s. {page['page_no']}" if page.get("page_no") else page["id"]
        items.append(["mark", label, page["id"]])
        for b in page["blocks"]:
            if b["type"] == "text":
                style = b.get("style") or "p"
                if style not in ("p", "h1", "h2", "h3", "note", "quote"):
                    style = "p"
                if mode == "tr" and b.get("tr"):
                    html_text = b["tr"].strip()
                elif mode == "both" and b.get("tr"):
                    html_text = b["html"].strip() + '<span class="tr">' + b["tr"].strip() + "</span>"
                else:
                    html_text = b["html"].strip()
                prev = last_paragraph(items)
                # paragraph continuing from the previous page: join it
                if (style == "p" and prev is not None and items[-1][0] == "mark"
                        and prev_text_continues(prev[2], html_text)):
                    mark = items.pop()
                    joiner = "" if prev[2].endswith("-") else " "
                    left = prev[2][:-1] if prev[2].endswith("-") else prev[2]
                    prev[2] = left + f'<span class="pm" title="{html.escape(mark[1])}"></span>' + joiner + html_text
                    continue
                css = block_css(b)
                items.append(["text", style, html_text, css])
            elif b["type"] == "image":
                src = b["src"] + (f"?v={b['v']}" if b.get("v") else "")
                items.append(["image", src, b.get("caption", ""), b.get("width", 100), b.get("source", "")])
    parts = []
    for it in items:
        if it[0] == "mark":
            parts.append(f'<div class="pagemark" id="{it[2]}">{html.escape(it[1])}</div>')
        elif it[0] == "text":
            attr = f' style="{it[3]}"' if len(it) > 3 and it[3] else ""
            if it[1] == "note":
                parts.append(f'<p class="note"{attr}>{it[2]}</p>')
            elif it[1] == "quote":
                parts.append(f"<blockquote{attr}>{it[2]}</blockquote>")
            else:
                parts.append(f"<{it[1]}{attr}>{it[2]}</{it[1]}>")
        else:
            cap = html.escape(it[2])
            src_line = f'<span class="src">Zdroj: {html.escape(it[4])}</span>' if len(it) > 4 and it[4] else ""
            parts.append(f'<figure><img src="{html.escape(it[1])}" alt="{cap}" style="width:{int(it[3])}%">'
                         + (f"<figcaption>{cap}{src_line}</figcaption>" if cap or src_line else "") + "</figure>")
    title = html.escape(project.get("title", ""))
    body = "\n".join(parts)
    return f"""<!DOCTYPE html>
<html lang="cs"><head><meta charset="utf-8"><title>{title}</title>
<style>
body{{font-family:Georgia,'Times New Roman',serif;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#222}}
h1,h2,h3{{font-weight:normal;text-align:center}}
figure{{margin:1.5rem 0;text-align:center}} figure img{{max-width:100%}}
figcaption{{font-size:.9rem;color:#555}} figcaption .src{{display:block;font-size:.8rem;color:#777}} blockquote{{margin:1rem 2rem;font-style:italic}} p.note{{font-size:.85rem;color:#444}}
.tr{{display:block;color:#1f4e9c;margin-top:.3rem}}
.pagemark{{font:11px sans-serif;color:#aaa;text-align:right;border-top:1px dotted #ddd;margin-top:2rem}}
.pm::before{{content:"|";color:#ccc;font:10px sans-serif;margin:0 2px}}
@media print{{.pagemark,.pm{{display:none}}}}
</style></head><body><h1>{title}</h1>
{body}
</body></html>"""


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript"}

    def log_message(self, fmt, *args):
        if args and "/api/" in str(args[0]):
            sys.stderr.write("%s\n" % (fmt % args))

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def translate_path(self, path):
        path = unquote(urlparse(path).path)
        if path.startswith("/books/"):
            rel = path[len("/books/"):]
            if "/" not in rel.strip("/") or any(seg.startswith(".") for seg in rel.split("/")):
                return os.path.join(STATIC_DIR, "404")  # hidden files: secrets, history
            top = rel.strip("/").split("/")[0]
            # only book folders, the manuscript and the image library are served (never settings or deploy files)
            if top != "images" and not Manuscripts.NAME.match(top) and not os.path.isfile(os.path.join(ROOT, top, "project.json")):
                return os.path.join(STATIC_DIR, "404")
            full = os.path.normpath(os.path.join(ROOT, rel))
            if not full.startswith(ROOT + os.sep):
                return os.path.join(STATIC_DIR, "404")
            return full
        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR):
            return os.path.join(STATIC_DIR, "404")
        return full

    def end_headers(self):
        if self.path.endswith((".js", ".css", ".html", "/")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def route(self):
        parts = [unquote(p) for p in urlparse(self.path).path.split("/") if p]
        return parts

    def ms(self):
        """The book being written that this browser has open (cookie set by the home screen)."""
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "ms":
                return MSS.get(unquote(v))
        return MSS.get("_rukopis")

    def who(self):
        fp = ""
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "fp":
                fp = re.sub(r"[^0-9a-f\-]", "", v)[:24]
        logged = AUTH.enabled and AUTH.is_logged_in(self.headers.get("Cookie"))
        return {"user": AUTH.user if logged else ("" if AUTH.enabled else "místně"), "ip": self.client_ip(),
                "fp": fp, "dev": device_label(self.headers.get("User-Agent"))}

    def handle_mcp(self, parts):
        if len(parts) != 2 or not MCPS.check(parts[1]):
            time.sleep(0.5)
            return self.send_json({"error": "unknown address"}, 404)
        try:
            msg = self.read_json()
        except ValueError:
            return self.send_json({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}, 400)
        who = {"user": "Claude (MCP)", "ip": self.client_ip(), "fp": "", "dev": device_label(self.headers.get("User-Agent")) + " · MCP"}
        if isinstance(msg, list):
            out = [r for r in (MCPS.handle(m, who) for m in msg) if r is not None]
        else:
            out = MCPS.handle(msg, who)
        if not out:
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        return self.send_json(out)

    def audit_edit(self, parts):
        """Logs a write request: which book or manuscript changed, by whom."""
        if parts[:1] != ["api"] or parts[1:2] in (["chat"], ["proof"], ["login"], ["support"]) or parts[1:3] == ["settings", "test"]:
            return
        if parts[1:2] == ["manuscript"] or parts[1:2] == ["manuscripts"]:
            key = "ms:" + self.ms().name
        elif parts[1:2] == ["books"] and len(parts) >= 3:
            key = "book:" + os.path.basename(parts[2])
        else:
            key = "/".join(parts[1:3])
        try:
            AUDIT.log("edit", self.who(), key=key, path=urlparse(self.path).path)
        except OSError:
            pass

    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For")
        return fwd.split(",")[0].strip() if fwd else self.client_address[0]

    def guard(self):
        """True when the request may continue; otherwise the response is already sent."""
        path = urlparse(self.path).path
        if path.startswith("/mcp/"):
            return True   # MCP clients prove themselves with the secret token in the address
        if path in PUBLIC_PATHS or AUTH.is_logged_in(self.headers.get("Cookie")):
            return True
        if path.startswith("/api/") or path.startswith("/books/"):
            self.send_json({"error": "login required"}, 401)
        else:
            self.send_response(302)
            self.send_header("Location", "login.html")
            self.end_headers()
        return False

    def do_GET(self):
        if not self.guard():
            return
        parts = self.route()
        if parts == ["healthz"]:
            return self.send_json({"ok": True})
        if parts[:1] == ["mcp"]:
            # no server-initiated stream: Streamable HTTP clients then use POST only
            self.send_response(405)
            self.send_header("Allow", "POST")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if parts == ["api", "mcp"]:
            tok = MCPS.token()
            return self.send_json({"enabled": bool(tok), "path": "mcp/" + tok if tok else ""})
        if parts == ["api", "me"]:
            return self.send_json({"auth": AUTH.enabled, "user": AUTH.user if AUTH.enabled else None, "version": SUPPORT.version()})
        if parts == ["logout"]:
            AUDIT.log("logout", self.who())
            self.send_response(302)
            self.send_header("Set-Cookie", AUTH.clear_cookie())
            self.send_header("Location", "login.html" if AUTH.enabled else "./")
            self.end_headers()
            return
        try:
            if parts == ["api", "settings"]:
                return self.send_json(SETTINGS.public())
            if parts == ["api", "audit"]:
                return self.send_json({"me": self.who(), "items": AUDIT.recent()})
            if parts[:2] == ["api", "books"] and len(parts) == 2:
                return self.send_json(list_books())
            if parts[:2] == ["api", "books"] and len(parts) == 4 and parts[3] == "history":
                return self.send_json(book_history(book_dir(parts[2])))
            if parts[:2] == ["api", "books"] and len(parts) == 4 and parts[3] == "ocr":
                return self.send_json(IMPORTER.status(parts[2]))
            if parts[:2] == ["api", "books"] and len(parts) == 3:
                with open(os.path.join(book_dir(parts[2]), "project.json"), encoding="utf-8") as f:
                    return self.send_json(json.load(f))
            if parts == ["api", "manuscripts"]:
                return self.send_json(MSS.list())
            if parts == ["api", "proof", "suggest"]:
                q = parse_qs(urlparse(self.path).query)
                return self.send_json(PROOF.suggest(q.get("w", [""])[0], q.get("lang", ["cs"])[0]))
            if parts == ["api", "manuscript", "settings"]:
                return self.send_json(self.ms().settings())
            if parts[:2] == ["api", "manuscript"]:
                if len(parts) == 2:
                    return self.send_json(self.ms().load())
                if parts[2] == "comments":
                    return self.send_json(self.ms().comments())
                if parts[2] == "image-origin":
                    return self.send_json(image_origin(parse_qs(urlparse(self.path).query).get("src", [""])[0]))
                if parts[2] == "history" and len(parts) == 3:
                    return self.send_json(with_editors("ms:" + self.ms().name, self.ms().history()))
                if parts[2] == "history" and len(parts) == 4:
                    return self.send_json({"html": self.ms().history_item(parts[3])})
                if parts[2] == "export":
                    doc = self.ms().load()
                    if parse_qs(urlparse(self.path).query).get("download"):
                        html_doc = inline_images(manuscript_export(doc["title"], doc["html"]))
                        name = re.sub(r"[^\w\-]+", "-", fold(doc["title"] or "rukopis")).strip("-")[:60] or "rukopis"
                        return self.send_html(html_doc, download=name + ".html")
                    st = self.ms().settings()
                    return self.send_html(book_export.print_page(st, doc["html"], st.get("cover_print") or st.get("cover")))
                if parts[2] == "epub":
                    doc = self.ms().load()
                    st = self.ms().settings()
                    data = book_export.epub(st, doc["html"], read_data_image)
                    name = re.sub(r"[^\w\-]+", "-", fold(st.get("title") or "kniha")).strip("-")[:60] or "kniha"
                    self.send_response(200)
                    self.send_header("Content-Type", "application/epub+zip")
                    self.send_header("Content-Disposition", f'attachment; filename="{name}.epub"')
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
            if parts[:2] == ["api", "clips"]:
                return self.send_json(self.ms().clips())
            if parts == ["api", "gallery"]:
                return self.send_json(gallery(ROOT, list_books(), LIB, self.ms().name))
            if parts[:2] == ["api", "search"]:
                q = parse_qs(urlparse(self.path).query).get("q", [""])[0]
                return self.send_json(do_search(q, ms=self.ms()))
            if parts[:2] == ["api", "export"] and len(parts) == 3:
                path = book_dir(parts[2])
                out = os.path.join(path, "export.html")
                with open(out, "w", encoding="utf-8") as f:
                    mode = parse_qs(urlparse(self.path).query).get("mode", ["orig"])[0]
                    f.write(export_html(path, mode if mode in ("orig", "tr", "both") else "orig"))
                self.send_response(302)
                self.send_header("Location", f"../../books/{parts[2]}/export.html")
                self.end_headers()
                return
        except FileNotFoundError:
            return self.send_json({"error": "not found"}, 404)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        return super().do_GET()

    def do_HEAD(self):
        if self.guard():
            super().do_HEAD()

    def do_PUT(self):
        if not self.guard():
            return
        parts = self.route()
        self.audit_edit(parts)
        try:
            if parts == ["api", "settings"]:
                return self.send_json(SETTINGS.save(self.read_json()))
            if parts[:2] == ["api", "library"] and len(parts) == 3:
                body = self.read_json()
                LIB.update(os.path.basename(parts[2]), body.get("caption", ""), body.get("source", ""))
                return self.send_json({"ok": True})
            if parts == ["api", "manuscript", "settings"]:
                return self.send_json(self.ms().save_settings(self.read_json()))
            if parts[:2] == ["api", "manuscript"] and len(parts) == 2:
                body = self.read_json()
                try:
                    version = self.ms().save(body["html"], body.get("version"), body.get("title"))
                except Conflict as c:
                    return self.send_json({"error": "conflict", "version": c.args[0]}, 409)
                return self.send_json({"ok": True, "version": version, "saved": time.strftime("%H:%M:%S")})
            if parts[:2] == ["api", "books"] and len(parts) == 3:
                if IMPORTER.running(parts[2]):
                    return self.send_json({"error": "ocr running"}, 423)
                project = self.read_json()
                if not isinstance(project.get("pages"), list):
                    raise ValueError("invalid project")
                save_project(book_dir(parts[2]), project)
                return self.send_json({"ok": True, "saved": time.strftime("%H:%M:%S")})
        except FileNotFoundError:
            return self.send_json({"error": "not found"}, 404)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        self.send_json({"error": "unknown endpoint"}, 404)

    def do_POST(self):
        if not self.guard():
            return
        parts = self.route()
        if parts[:1] == ["mcp"]:
            return self.handle_mcp(parts)
        self.audit_edit(parts)
        if parts == ["api", "mcp"]:
            action = self.read_json().get("action")
            if action == "new":
                MCPS.new_token()
            elif action == "remove":
                MCPS.remove_token()
            tok = MCPS.token()
            return self.send_json({"enabled": bool(tok), "path": "mcp/" + tok if tok else ""})
        if parts == ["api", "chat"]:
            return self.stream_chat(self.read_json().get("question", ""))
        if parts == ["api", "books"]:
            body = self.read_json()
            return self.send_json(IMPORTER.create(body.get("title", ""), body.get("lang", "cs")))
        if parts[:2] == ["api", "books"] and len(parts) == 4 and parts[3] in ("pages", "ocr", "delete"):
            try:
                if parts[3] == "pages":
                    return self.send_json(IMPORTER.add_page(parts[2], self.read_json()))
                if parts[3] == "ocr":
                    body = self.read_json()
                    return self.send_json(IMPORTER.start(parts[2], body.get("pages"), body.get("engine", "auto"), self.who()))
                return self.send_json(IMPORTER.delete_book(parts[2]))
            except FileNotFoundError:
                return self.send_json({"error": "not found"}, 404)
            except (ValueError, KeyError) as e:
                return self.send_json({"error": str(e)}, 400)
        if parts[:2] == ["api", "books"] and len(parts) == 4 and parts[3] == "restore":
            return self.send_json(restore_book(book_dir(parts[2]), self.read_json()["name"]))
        if parts == ["api", "proof", "check"]:
            body = self.read_json()
            return self.send_json(PROOF.check(body.get("items", []), body.get("scope")))
        if parts == ["api", "proof", "word"]:
            body = self.read_json()
            return self.send_json({"ok": PROOF.add_word(body.get("word", ""), body.get("scope"))})
        if parts == ["api", "manuscripts"]:
            body = self.read_json()
            return self.send_json(MSS.create(body.get("title", ""), body.get("author", "")))
        if parts == ["api", "support"]:
            return self.send_json(SUPPORT.submit(self.read_json(), AUTH.user if AUTH.enabled else ""))
        if parts == ["api", "settings", "test"]:
            return self.test_llm(self.read_json())
        if parts == ["api", "login"]:
            body = self.read_json()
            if not AUTH.enabled:
                return self.send_json({"ok": True})
            ok, msg = AUTH.login(self.client_ip(), body.get("user"), body.get("pin"), device_label(self.headers.get("User-Agent")))
            who = {**self.who(), "user": str(body.get("user") or "")[:60]}
            if isinstance(body.get("device"), dict):
                who["detail"] = json.dumps(body["device"], ensure_ascii=False)[:600]
            AUDIT.log("login" if ok else "login-failed", {k: v for k, v in who.items() if k != "detail"},
                      detail=who.get("detail", "") or ("" if ok else msg))
            if not ok:
                time.sleep(1)  # slow down guessing
                return self.send_json({"ok": False, "error": msg}, 403)
            body_bytes = json.dumps({"ok": True}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body_bytes)))
            self.send_header("Set-Cookie", AUTH.make_cookie())
            self.end_headers()
            self.wfile.write(body_bytes)
            return
        try:
            if parts[:3] == ["api", "manuscript", "images"]:
                return self.send_json({"ok": True, "src": self.ms().save_image(self.read_json()["data"])})
            if parts[:3] == ["api", "manuscript", "copy-image"]:
                body = self.read_json()
                base = LIB.dir if body.get("library") else book_dir(body["book"])
                return self.send_json({"ok": True, "src": self.ms().copy_book_image(base, body["src"])})
            if parts == ["api", "library"]:
                body = self.read_json()
                name = LIB.add(body["data"], body.get("caption", ""), body.get("source", ""), body.get("name", ""))
                return self.send_json({"ok": True, "file": name})
            if parts[:3] == ["api", "manuscript", "comments"]:
                return self.send_json(self.ms().comment(parts[3] if len(parts) == 4 else None, self.read_json(), self.who().get("user")))
            if parts[:3] == ["api", "manuscript", "snapshot"]:
                return self.send_json({"ok": True, "name": self.ms().snapshot(self.read_json().get("label", "verze"))})
            if parts[:3] == ["api", "manuscript", "restore"]:
                version = self.ms().restore(self.read_json()["name"])
                return self.send_json({"ok": True, "version": version})
            if parts[:2] == ["api", "clips"] and len(parts) == 2:
                return self.send_json(self.ms().add_clip(make_clip(self.read_json(), self.ms())))
            if parts[:2] == ["api", "clips"] and len(parts) == 4 and parts[3] == "delete":
                self.ms().remove_clip(parts[2])
                return self.send_json({"ok": True})
            # save an image cropped in the browser: {"name": "...jpg", "data": "data:image/jpeg;base64,..."}
            if parts[:2] == ["api", "images"] and len(parts) == 3:
                path = book_dir(parts[2])
                payload = self.read_json()
                name = os.path.basename(payload["name"])
                if not SAFE_NAME.match(name) or not name.endswith(".jpg"):
                    raise ValueError("bad image name")
                data = payload["data"].split(",", 1)[1]
                os.makedirs(os.path.join(path, "images"), exist_ok=True)
                with open(os.path.join(path, "images", name), "wb") as f:
                    f.write(base64.b64decode(data))
                IMPORTER.image_saved(parts[2], name) if re.match(r"^kniha-\d+$", parts[2]) else None
                return self.send_json({"ok": True, "src": "images/" + name})
        except FileNotFoundError:
            return self.send_json({"error": "not found"}, 404)
        except (ValueError, KeyError) as e:
            return self.send_json({"error": str(e)}, 400)
        self.send_json({"error": "unknown endpoint"}, 404)

    def test_llm(self, body):
        """Try the given (or saved) model settings with a tiny request."""
        cfg = SETTINGS.llm()
        if body.get("preset") and body.get("preset") != "server":
            cfg = {"base_url": (body.get("base_url") or "").rstrip("/"), "model": body.get("model") or "",
                   "api_key": body.get("api_key") or (SETTINGS._load().get("api_key", "") if not body.get("clear_key") else ""),
                   "verify_tls": bool(body.get("verify_tls", True))}
        if not cfg["base_url"].startswith(("http://", "https://")):
            return self.send_json({"ok": False, "error": "Adresa musí začínat http:// nebo https://"})
        started = time.time()
        if body.get("image"):
            # can the model read pictures? (needed for reading book pages)
            try:
                msg = [{"role": "user", "content": [
                    {"type": "text", "text": "Přepiš přesně text na obrázku. Odpověz jen tím textem."},
                    {"type": "image_url", "image_url": {"url": body["image"]}}]}]
                text = "".join(rag.llm_stream(msg, cfg, max_tokens=40))
                return self.send_json({"ok": True, "reply": text.strip()[:80], "seconds": round(time.time() - started, 1), "model": cfg["model"]})
            except Exception as e:
                return self.send_json({"ok": False, "error": str(e)[:300]})
        try:
            text = "".join(rag.llm_stream([{"role": "user", "content": "Odpověz jedním slovem: funguje to?"}], cfg, max_tokens=10))
            return self.send_json({"ok": True, "reply": text.strip()[:80], "seconds": round(time.time() - started, 1), "model": cfg["model"]})
        except Exception as e:
            return self.send_json({"ok": False, "error": str(e)[:300]})

    def stream_chat(self, question):
        """Server-sent events: sources, then the answer as it is generated."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True

        def send(ev):
            self.wfile.write(("data: " + json.dumps(ev, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()

        try:
            if not question.strip():
                send({"type": "error", "text": "Napište otázku."})
                return
            for ev in rag.answer(question, search_index(self.ms())["entries"], fold, SETTINGS.llm(), books_overview()):
                send(ev)
            send({"type": "done"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # LLM unavailable etc.
            try:
                send({"type": "error", "text": f"Jazykový model teď neodpovídá ({e})."})
            except OSError:
                pass

    def send_html(self, text, download=None):
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{download}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def read_data_image(src):
    """Image referenced from the manuscript (books/...) as (bytes, mime), or None."""
    rel = unquote(src.split("?")[0]).lstrip("/")
    if rel.startswith("books/"):
        rel = rel[len("books/"):]
    full = os.path.normpath(os.path.join(ROOT, rel))
    if not full.startswith(ROOT + os.sep) or not os.path.isfile(full):
        return None
    mime = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"}.get(os.path.splitext(full)[1].lower())
    if not mime:
        return None
    with open(full, "rb") as f:
        return f.read(), mime


def inline_images(doc):
    """Embed images from the data folder so a downloaded file works on its own."""
    def repl(m):
        rel = unquote(m.group(2)).lstrip("/")
        if rel.startswith("books/"):
            rel = rel[len("books/"):]
        full = os.path.normpath(os.path.join(ROOT, rel))
        if not full.startswith(ROOT + os.sep) or not os.path.isfile(full):
            return m.group(0)
        ext = os.path.splitext(full)[1].lower().lstrip(".")
        mime = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png", "gif": "gif", "webp": "webp"}.get(ext)
        if not mime:
            return m.group(0)
        with open(full, "rb") as f:
            data = base64.b64encode(f.read()).decode()
        return f'{m.group(1)}data:image/{mime};base64,{data}"'
    doc = re.sub(r'<base href="[^"]*">', "", doc)
    return re.sub(r'(<img[^>]*?src=")((?:\.\./\.\./)?/?books/[^"]+)"', repl, doc)


def fold(text):
    """Lowercase and strip diacritics for forgiving search (č -> c, ü -> u)."""
    text = unicodedata.normalize("NFD", text.lower())
    return "".join(c for c in text if unicodedata.category(c) != "Mn")


def plain(html_text):
    return html.unescape(re.sub(r"<[^>]+>", " ", html_text or "")).replace("\xa0", " ")


_index_cache = {"sig": None, "entries": [], "words": {}}


def search_index(ms=None):
    """Entries for every text block of every book plus manuscript paragraphs; rebuilt when files change."""
    ms = ms or MSS.get("_rukopis")
    files = [os.path.join(ROOT, b["id"], "project.json") for b in list_books()]
    files.append(os.path.join(ms.dir, "document.html"))
    sig = tuple((f, os.path.getmtime(f)) for f in files if os.path.exists(f))
    if sig == _index_cache["sig"]:
        return _index_cache
    entries = []
    for b in list_books():
        with open(os.path.join(ROOT, b["id"], "project.json"), encoding="utf-8") as f:
            project = json.load(f)
        for pi, page in enumerate(project["pages"]):
            for blk in page["blocks"]:
                if blk["type"] == "image":
                    texts = [("cap", blk.get("caption", ""))]
                else:
                    texts = [("orig", plain(blk.get("html"))), ("tr", plain(blk.get("tr")))]
                for field, t in texts:
                    if t.strip():
                        entries.append({"where": "book", "book": b["id"], "title": project.get("title", b["id"]),
                                        "page": pi, "page_no": page.get("page_no"), "block": blk["id"],
                                        "field": field, "text": t, "folded": fold(t)})
    doc = ms.load()["html"]
    ms_entries = []
    for i, para in enumerate(re.split(r"</(?:p|h1|h2|h3|li|blockquote|figcaption)>", doc)):
        t = plain(para).strip()
        if t:
            ms_entries.append({"where": "manuscript", "title": ms.load()["title"], "para": i, "field": "ms",
                            "text": t, "folded": fold(t)})
    entries = ms_entries + entries
    words = {}
    for e in entries:
        for w in re.findall(r"[^\W\d_]{3,}", e["text"]):
            key = w.lower()
            words[key] = words.get(key, 0) + 1
    _index_cache.update(sig=sig, entries=entries, words=words)
    return _index_cache


def do_search(q, limit=80, ms=None):
    idx = search_index(ms)
    fq = fold(q.strip())
    if len(fq) < 2:
        return {"hits": [], "suggest": []}
    terms = fq.split()
    hits = []
    for e in idx["entries"]:
        if all(t in e["folded"] for t in terms):
            pos = e["folded"].find(terms[0])
            start = max(0, pos - 60)
            snippet = ("…" if start else "") + e["text"][start:pos + 120] + ("…" if pos + 120 < len(e["text"]) else "")
            hit = {k: v for k, v in e.items() if k not in ("text", "folded")}
            hit["snippet"] = snippet
            hits.append(hit)
            if len(hits) >= limit:
                break
    last = terms[-1]
    suggest = sorted((w for w in idx["words"] if fold(w).startswith(last) and fold(w) != last),
                     key=lambda w: -idx["words"][w])[:8]
    return {"hits": hits, "suggest": suggest}


def make_clip(data, ms):
    """Build a tray item from a paragraph, quote or image sent from a source book."""
    kind = data.get("kind", "text")
    source = html.escape(data.get("source", ""))
    if kind == "image":
        src = ms.copy_book_image(book_dir(data["book"]), data["src"])
        cap = figure_caption(data.get("caption", ""), data.get("image_source") or data.get("source", ""))
        body = f'<figure><img src="{src}" style="width:{int(data.get("width", 100))}%"><figcaption>{cap}</figcaption></figure>'
    elif kind == "quote":
        body = f'<blockquote><p>{data["html"]}</p><p class="cite">({source})</p></blockquote>'
    else:
        body = f'<p>{data["html"]}</p>'
    return {"kind": kind, "html": body, "source": data.get("source", "")}


def render_vars(body):
    """Replace the editor markers: automatic table of contents and page breaks."""
    heads = []
    counter = [0]

    def tag_head(m):
        counter[0] += 1
        text = re.sub(r"<[^>]+>", "", m.group(3)).strip()
        if not text:
            return m.group(0)
        hid = f"kap-{counter[0]}"
        heads.append((int(m.group(1)), hid, text))
        return f'<h{m.group(1)}{m.group(2)} id="{hid}">{m.group(3)}</h{m.group(1)}>'
    body = re.sub(r"<h([123])([^>]*)>(.*?)</h\1>", tag_head, body, flags=re.S)
    items = "".join(f'<li class="l{lvl}"><a href="#{hid}">{t}</a></li>' for lvl, hid, t in heads)
    toc = f'<nav class="toc"><h2 class="toc-title">Obsah</h2><ol>{items}</ol></nav>'
    body = re.sub(r'<div class="var-toc">.*?</div>', toc, body, flags=re.S)
    body = re.sub(r'<div class="var-break">.*?</div>', '<div class="page-break"></div>', body, flags=re.S)
    return body


def manuscript_export(title, body):
    body = render_vars(body)
    return f"""<!DOCTYPE html>
<html lang="cs"><head><meta charset="utf-8"><base href="../../"><title>{html.escape(title)}</title>
<style>
@page{{size:A4;margin:22mm 20mm}}
body{{font-family:Georgia,'Times New Roman',serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#111;font-size:12pt}}
h1{{font-size:24pt;text-align:center;font-weight:normal;margin:2rem 0 1rem}} h2{{font-size:17pt;font-weight:normal;margin-top:2rem}} h3{{font-size:13pt}}
blockquote{{margin:1rem 2rem;font-style:italic;color:#333}} blockquote .cite{{font-style:normal;font-size:10pt;text-align:right}} figcaption .src{{display:block;font-size:9pt;color:#666}}
figure{{margin:1rem 0;text-align:center;break-inside:avoid}} img{{max-width:100%}} figcaption{{font-size:10pt;color:#444}}
.toc ol{{list-style:none;padding:0}} .toc li{{margin:.25rem 0}} .toc li.l2{{padding-left:1.5rem}} .toc li.l3{{padding-left:3rem;font-size:11pt}} .toc a{{color:inherit;text-decoration:none}} .toc-title{{text-align:center}}
.page-break{{break-after:page;height:0}} @media screen{{.page-break{{border-top:1px dashed #bbb;margin:2rem 0}}}}
.toolbar{{position:fixed;top:8px;right:8px}} .toolbar button{{font-size:16px;padding:8px 14px}}
@media print{{.toolbar{{display:none}} body{{margin:0;max-width:none}}}}
</style></head><body>
<div class="toolbar"><button onclick="window.print()">Tisk / uložit jako PDF</button></div>
{body}
</body></html>"""


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Publisher běží na http://{'localhost' if HOST == '127.0.0.1' else HOST}:{PORT}  (knihy ve složce {ROOT})")
    print("Přihlášení:", f"zapnuto (uživatel {AUTH.user})" if AUTH.enabled else "vypnuto (lokální režim)")
    print("Ukončení: Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
