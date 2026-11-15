"""Manuscript storage: the author's own books, clipboard tray and version history.

Every book being written has its own folder next to the source books. The first one is
"_rukopis", further ones "_rukopis-<id>":
    _rukopis/document.html      current text
    _rukopis/meta.json          version counter, last snapshot time
    _rukopis/history/*.html     snapshots (automatic every few minutes + named ones)
    _rukopis/images/            pasted and transferred images
    _rukopis/clips.json         tray of paragraphs / quotes / images sent from the books
"""
import base64
import json
import os
import re
import shutil
import time
import uuid

SNAPSHOT_EVERY = 180      # seconds between automatic snapshots while writing
HISTORY_KEEP = 400
IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}


class Conflict(Exception):
    pass


BOOK_FIELDS = ("title", "subtitle", "author", "editor", "publisher", "series", "place", "year", "edition",
               "isbn_pdf", "isbn_epub", "copyright", "license", "thanks", "note", "language",
               "header", "footer_numbers", "cover", "cover_print", "cover_design", "sources", "illustrations")


class Manuscript:
    def __init__(self, root, name="_rukopis"):
        self.name = name
        self.dir = os.path.join(root, name)
        self.root = root
        for sub in ("", "history", "images"):
            os.makedirs(os.path.join(self.dir, sub), exist_ok=True)

    # ---------- helpers ----------
    def _path(self, *p):
        return os.path.join(self.dir, *p)

    def _meta(self):
        try:
            with open(self._path("meta.json"), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {"version": 0, "last_snapshot": 0}

    def _write(self, name, text):
        tmp = self._path(name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, self._path(name))

    # ---------- document ----------
    def load(self):
        try:
            with open(self._path("document.html"), encoding="utf-8") as f:
                html = f.read()
        except OSError:
            html = "<h1>Kapitola 1</h1><p>Sem pište text…</p>"
        meta = self._meta()
        return {"html": html, "version": meta["version"], "title": meta.get("title", "Můj rukopis"), "id": self.name}

    # ---------- book settings (title page, colophon, header/footer, cover) ----------
    def settings(self):
        meta = self._meta()
        out = dict(meta.get("book", {}))
        out["title"] = meta.get("title", "Můj rukopis")
        out.setdefault("language", "cs")
        out.setdefault("footer_numbers", True)
        return out

    def save_settings(self, data):
        meta = self._meta()
        book = meta.get("book", {})
        for k in BOOK_FIELDS:
            if k in data:
                v = data[k]
                if k == "footer_numbers":
                    book[k] = bool(v)
                elif k == "sources":
                    book[k] = [str(x) for x in v][:50] if isinstance(v, list) else []
                else:
                    book[k] = str(v).strip()[:4000]
        if book.get("title"):
            meta["title"] = book.pop("title")
        book.pop("title", None)
        meta["book"] = book
        self._write("meta.json", json.dumps(meta, ensure_ascii=False))
        return self.settings()

    def info(self):
        meta = self._meta()
        doc = self._path("document.html")
        words = 0
        updated = None
        if os.path.exists(doc):
            with open(doc, encoding="utf-8") as f:
                words = len(re.sub(r"<[^>]+>", " ", f.read()).split())
            updated = time.strftime("%d. %m. %Y %H:%M", time.localtime(os.path.getmtime(doc)))
        book = meta.get("book", {})
        return {"id": self.name, "title": meta.get("title", "Můj rukopis"), "author": book.get("author", ""),
                "subtitle": book.get("subtitle", ""), "cover": book.get("cover", ""), "cover_design": book.get("cover_design", ""),
                "series": book.get("series", ""), "publisher": book.get("publisher", ""), "words": words,
                "updated": updated, "created": meta.get("created", 0)}

    def save(self, html, base_version, title=None, force=False):
        meta = self._meta()
        if not force and base_version is not None and base_version != meta["version"]:
            raise Conflict(meta["version"])
        now = time.time()
        if now - meta.get("last_snapshot", 0) > SNAPSHOT_EVERY and os.path.exists(self._path("document.html")):
            self.snapshot(label="automaticky")
            meta = self._meta()
        self._write("document.html", html)
        meta["version"] += 1
        if title:
            meta["title"] = title
        self._write("meta.json", json.dumps(meta))
        return meta["version"]

    def snapshot(self, label=""):
        src = self._path("document.html")
        if not os.path.exists(src):
            return None
        label = re.sub(r"[^\w\- ]", "", label, flags=re.UNICODE)[:40].strip()
        name = time.strftime("%Y%m%d-%H%M%S") + (f"__{label.replace(' ', '_')}" if label else "") + ".html"
        shutil.copy2(src, self._path("history", name))
        meta = self._meta()
        meta["last_snapshot"] = time.time()
        self._write("meta.json", json.dumps(meta))
        files = sorted(os.listdir(self._path("history")))
        auto = [f for f in files if "__automaticky" in f]
        for f in auto[:-HISTORY_KEEP]:
            os.remove(self._path("history", f))
        return name

    def history(self):
        out = []
        for name in sorted(os.listdir(self._path("history")), reverse=True):
            if not name.endswith(".html"):
                continue
            stamp, _, label = name[:-5].partition("__")
            with open(self._path("history", name), encoding="utf-8") as f:
                text = re.sub(r"<[^>]+>", " ", f.read())
            out.append({"name": name, "time": stamp, "label": label.replace("_", " "),
                        "words": len(text.split())})
        return out

    def history_item(self, name):
        name = os.path.basename(name)
        with open(self._path("history", name), encoding="utf-8") as f:
            return f.read()

    def restore(self, name):
        html = self.history_item(name)
        self.snapshot(label="pred obnovenim")
        return self.save(html, None, force=True)

    # ---------- images ----------
    def save_image(self, data_url):
        head, data = data_url.split(",", 1)
        mime = head.split(":")[1].split(";")[0]
        ext = IMAGE_TYPES.get(mime)
        if not ext:
            raise ValueError("nepodporovaný typ obrázku")
        name = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6] + ext
        with open(self._path("images", name), "wb") as f:
            f.write(base64.b64decode(data))
        return f"books/{self.name}/images/" + name

    def copy_book_image(self, book_path, src):
        src_file = os.path.normpath(os.path.join(book_path, src.split("?")[0]))
        if not src_file.startswith(book_path + os.sep):
            raise ValueError("bad image path")
        name = os.path.basename(book_path) + "_" + uuid.uuid4().hex[:6] + "_" + os.path.basename(src_file)
        shutil.copy2(src_file, self._path("images", name))
        return f"books/{self.name}/images/" + name

    # ---------- comments (kept beside the text; the text only carries <span class="cmt" data-c="id">) ----------
    def comments(self):
        try:
            with open(self._path("comments.json"), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return []

    def _save_comments(self, items):
        self._write("comments.json", json.dumps(items, ensure_ascii=False, indent=1))

    def comment(self, cid, data, who):
        """Creates (cid=None) or changes a comment. data: {id, quote, text} or {action, text}."""
        items = self.comments()
        now = time.strftime("%d. %m. %Y %H:%M")
        author = str(data.get("author") or who or "")[:60]
        if cid is None:
            new_id = re.sub(r"[^a-z0-9]", "", str(data.get("id", "")))[:12] or uuid.uuid4().hex[:8]
            items.append({"id": new_id, "quote": str(data.get("quote", ""))[:400], "text": str(data.get("text", ""))[:4000],
                          "author": author, "time": now, "resolved": False, "replies": []})
            self._save_comments(items)
            return items
        for c in items:
            if c["id"] != cid:
                continue
            act = data.get("action")
            if act == "reply" and str(data.get("text", "")).strip():
                c["replies"].append({"text": str(data["text"])[:4000], "author": author, "time": now})
            elif act == "edit":
                c["text"] = str(data.get("text", ""))[:4000]
            elif act in ("resolve", "reopen"):
                c["resolved"] = act == "resolve"
                c["resolved_by"] = author if act == "resolve" else ""
            elif act == "delete":
                items.remove(c)
            break
        self._save_comments(items)
        return items

    # ---------- clipboard tray ----------
    def clips(self):
        try:
            with open(self._path("clips.json"), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return []

    def add_clip(self, clip):
        clips = self.clips()
        clip["id"] = uuid.uuid4().hex[:8]
        clip["created"] = time.strftime("%Y-%m-%d %H:%M")
        clips.append(clip)
        self._write("clips.json", json.dumps(clips, ensure_ascii=False, indent=1))
        return clip

    def remove_clip(self, clip_id):
        clips = [c for c in self.clips() if c["id"] != clip_id]
        self._write("clips.json", json.dumps(clips, ensure_ascii=False, indent=1))


class Manuscripts:
    """All books being written. Folder names are their ids."""
    NAME = re.compile(r"^_rukopis(-[a-z0-9]{6})?$")

    def __init__(self, root):
        self.root = root
        Manuscript(root, "_rukopis")  # the first book always exists

    def ids(self):
        return [n for n in os.listdir(self.root) if self.NAME.match(n) and os.path.isdir(os.path.join(self.root, n))]

    def get(self, name):
        if not name or not self.NAME.match(name) or not os.path.isdir(os.path.join(self.root, name)):
            name = "_rukopis"
        return Manuscript(self.root, name)

    def list(self):
        items = [Manuscript(self.root, n).info() for n in self.ids()]
        return sorted(items, key=lambda i: (i["id"] != "_rukopis", i["created"]))

    def create(self, title, author=""):
        name = "_rukopis-" + uuid.uuid4().hex[:6]
        ms = Manuscript(self.root, name)
        meta = {"version": 0, "last_snapshot": 0, "title": (title or "Nová kniha").strip()[:200],
                "created": time.time(), "book": {"author": author.strip()[:200]}}
        ms._write("meta.json", json.dumps(meta, ensure_ascii=False))
        ms._write("document.html", "<h1>Kapitola 1</h1><p>Sem pište text…</p>")
        return ms.info()
