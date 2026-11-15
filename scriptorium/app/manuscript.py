"""Manuscript storage: the father's own book, clipboard tray and version history.

Layout on disk (next to the books):
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


class Manuscript:
    def __init__(self, root):
        self.dir = os.path.join(root, "_rukopis")
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
        return {"html": html, "version": meta["version"], "title": meta.get("title", "Můj rukopis")}

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
        return "books/_rukopis/images/" + name

    def copy_book_image(self, book_path, src):
        src_file = os.path.normpath(os.path.join(book_path, src.split("?")[0]))
        if not src_file.startswith(book_path + os.sep):
            raise ValueError("bad image path")
        name = os.path.basename(book_path) + "_" + uuid.uuid4().hex[:6] + "_" + os.path.basename(src_file)
        shutil.copy2(src_file, self._path("images", name))
        return "books/_rukopis/images/" + name

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
