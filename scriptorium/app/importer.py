"""Adding source books: new book, page upload, OCR in the background.

The browser prepares the pages (photos or PDF pages rendered by pdf.js): a full scan and a
smaller preview, both JPEG, so the server needs no image libraries.

OCR engines
  ai         the language model from "Nastavení AI" reads the preview image and returns paragraphs
             with their kind (heading, text, note) and the positions of pictures (0-1000 scale)
  tesseract  Tesseract on the server (Czech, German, Fraktur when installed); text only
  auto       AI first, Tesseract when the model fails or cannot read images

Picture blocks are written with "pending": true; the browser cuts them out of the scan
and uploads them (POST /api/images/<book>), which clears the flag.
"""
import base64
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid

import rag

SAFE_BOOK = re.compile(r"^kniha-\d+$")
LOCKS = {}
LOCKS_GUARD = threading.Lock()

AI_PROMPT = """Jsi přesný přepisovač naskenovaných starých tisků (čeština, němčina, i švabach / Fraktur).
Přepiš text stránky na obrázku a urči, kde na ní jsou obrázky.

Vrať POUZE JSON bez dalšího textu, v tomto tvaru:
{"page_no": "číslo strany vytištěné na stránce nebo null",
 "blocks": [
   {"type": "text", "style": "h1|h2|h3|center|note|quote|p", "text": "..."},
   {"type": "image", "box": [x0, y0, x1, y1], "caption": "popisek pod obrázkem nebo prázdné"}
 ]}

Pravidla:
- Bloky v pořadí čtení, shora dolů (u dvou sloupců nejdřív celý levý sloupec).
- Přepisuj doslova, se starým pravopisem a interpunkcí; nic neopravuj, nic nepřidávej, nepřekládej.
- Švabach / Fraktur přepiš latinkou (ſ jako s).
- Jeden odstavec = jeden blok. Řádky uvnitř odstavce spoj mezerou, slova rozdělená na konci řádku spoj (rozdě- lení → rozdělení).
- style: h1 nadpis knihy nebo velké kapitoly, h2 nadpis kapitoly, h3 podnadpis, center text na střed (titulní strana, věnování), note poznámka pod čarou, quote citace, p běžný odstavec.
- Živé záhlaví a samotné číslo strany nepřepisuj do bloků; číslo strany dej do page_no.
- Obrázky, kresby mincí, fotografie, mapy, tabulky a vyobrazení dej jako blok image; box jsou souřadnice rohů v rozsahu 0–1000 vzhledem k šířce a výšce celé stránky. Popisek pod obrázkem dej do caption a nepřepisuj ho znovu jako text.
- Prázdná stránka: {"page_no": null, "blocks": []}."""


def book_lock(book):
    with LOCKS_GUARD:
        return LOCKS.setdefault(book, threading.Lock())


def esc(t):
    return (t or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Importer:
    def __init__(self, root, settings, save_project, audit=None):
        self.root = root
        self.settings = settings
        self.save_project = save_project
        self.audit = audit
        self.jobs = {}   # book -> status dict

    # ---------- books and pages ----------
    def _dir(self, book):
        if not SAFE_BOOK.match(book or ""):
            raise ValueError("bad book id")
        path = os.path.join(self.root, book)
        if not os.path.isfile(os.path.join(path, "project.json")):
            raise FileNotFoundError(book)
        return path

    def _load(self, path):
        with open(os.path.join(path, "project.json"), encoding="utf-8") as f:
            return json.load(f)

    def create(self, title, lang="cs"):
        n = 1
        while os.path.exists(os.path.join(self.root, f"kniha-{n}")):
            n += 1
        book = f"kniha-{n}"
        path = os.path.join(self.root, book)
        for d in ("scans", "preview", "images"):
            os.makedirs(os.path.join(path, d), exist_ok=True)
        project = {"title": (title or "").strip()[:200] or book, "ocr_lang": lang if lang in ("cs", "de", "cs+de") else "cs",
                   "created": time.strftime("%Y-%m-%d %H:%M"), "pages": []}
        with open(os.path.join(path, "project.json"), "w", encoding="utf-8") as f:
            json.dump(project, f, ensure_ascii=False, indent=1)
        return {"id": book, "title": project["title"]}

    def add_page(self, book, data):
        """data: {"scan": dataURL, "preview": dataURL, "size": [w, h], "name": original file name}"""
        path = self._dir(book)
        with book_lock(book):
            project = self._load(path)
            used = {p["id"] for p in project["pages"]}
            n = len(project["pages"]) + 1
            while f"p{n:02d}" in used:
                n += 1
            pid = f"p{n:02d}"
            # the file name is unique, because browsers keep scans for a long time under their name
            fname = f"{pid}-{uuid.uuid4().hex[:6]}.jpg"
            for kind, folder in (("scan", "scans"), ("preview", "preview")):
                raw = data[kind].split(",", 1)[1]
                with open(os.path.join(path, folder, fname), "wb") as f:
                    f.write(base64.b64decode(raw))
            size = data.get("size") or [0, 0]
            project["pages"].append({"id": pid, "source": os.path.basename(str(data.get("name", "")))[:200],
                                     "scan": f"scans/{fname}", "preview": f"preview/{fname}",
                                     "size": [int(size[0]), int(size[1])], "page_no": None, "blocks": []})
            self.save_project(path, project)
        return {"ok": True, "page": pid, "index": len(project["pages"]) - 1}

    def delete_book(self, book):
        """Removes a source book (moved to _trash, never deleted outright)."""
        path = self._dir(book)
        trash = os.path.join(self.root, "_trash")
        os.makedirs(trash, exist_ok=True)
        shutil.move(path, os.path.join(trash, f"{book}-{time.strftime('%Y%m%d-%H%M%S')}"))
        return {"ok": True}

    def image_saved(self, book, name):
        """The browser uploaded a cut-out picture: clear its pending flag."""
        path = self._dir(book)
        with book_lock(book):
            project = self._load(path)
            changed = False
            for page in project["pages"]:
                for b in page["blocks"]:
                    if b.get("type") == "image" and b.get("src") == "images/" + name and b.get("pending"):
                        b.pop("pending")
                        changed = True
            if changed:
                self.save_project(path, project)

    # ---------- OCR job ----------
    def status(self, book):
        job = self.jobs.get(book)
        if not job:
            return {"running": False}
        return {k: v for k, v in job.items() if k != "thread"}

    def running(self, book):
        job = self.jobs.get(book)
        return bool(job and job.get("running"))

    def start(self, book, pages=None, engine="auto", who=None):
        path = self._dir(book)
        if self.running(book):
            return self.status(book)
        project = self._load(path)
        if pages in (None, "all"):
            todo = list(range(len(project["pages"])))
        elif pages == "empty":
            todo = [i for i, p in enumerate(project["pages"]) if not any(b.get("type") == "text" and b.get("html") for b in p["blocks"])]
        else:
            todo = [int(i) for i in pages if 0 <= int(i) < len(project["pages"])]
        job = {"running": True, "total": len(todo), "done": 0, "current": None, "errors": [], "engine": engine,
               "used": {}, "started": time.time(), "finished": None}
        self.jobs[book] = job
        t = threading.Thread(target=self._run, args=(book, path, todo, engine, who), daemon=True)
        job["thread"] = t
        t.start()
        return self.status(book)

    def _run(self, book, path, todo, engine, who):
        job = self.jobs[book]
        for i in todo:
            job["current"] = i
            try:
                with book_lock(book):
                    page = self._load(path)["pages"][i]
                result, used = self.read_page(path, page, engine, self._load(path).get("ocr_lang", "cs"))
                job["used"][used] = job["used"].get(used, 0) + 1
                with book_lock(book):
                    project = self._load(path)
                    page = project["pages"][i]
                    page["blocks"] = self._blocks(page, result)
                    if result.get("page_no") not in (None, "", "null"):
                        page["page_no"] = result["page_no"]
                    page["ocr"] = {"engine": used, "time": time.strftime("%Y-%m-%d %H:%M")}
                    self.save_project(path, project)
            except Exception as e:  # keep going with the next page
                job["errors"].append({"page": i, "error": str(e)[:300]})
            job["done"] += 1
        job["running"] = False
        job["current"] = None
        job["finished"] = time.time()
        if self.audit and who:
            self.audit.log("edit", who, key="book:" + book, path=f"/ocr ({job['done']} stran)")

    def _blocks(self, page, result):
        w, h = page.get("size") or [0, 0]
        out, fig = [], 0
        for b in result.get("blocks", []):
            if b.get("type") == "image" and w and h:
                try:
                    x0, y0, x1, y1 = [float(v) for v in b.get("box", [])][:4]
                except (TypeError, ValueError):
                    continue
                x0, x1 = sorted((max(0, min(1000, x0)), max(0, min(1000, x1))))
                y0, y1 = sorted((max(0, min(1000, y0)), max(0, min(1000, y1))))
                if (x1 - x0) < 20 or (y1 - y0) < 20:
                    continue
                fig += 1
                pad = 0.01
                cx, cy = max(0, x0 / 1000 - pad), max(0, y0 / 1000 - pad)
                cw, ch = min(1, x1 / 1000 + pad) - cx, min(1, y1 / 1000 + pad) - cy
                out.append({"type": "image", "id": uuid.uuid4().hex[:8], "src": f"images/{page['id']}_fig{fig}.jpg",
                            "crop": [round(cx * w), round(cy * h), round(cw * w), round(ch * h)],
                            "caption": (b.get("caption") or "").strip(), "pending": True, "v": 1})
            elif b.get("type", "text") == "text":
                text = (b.get("text") or "").strip()
                if not text:
                    continue
                blk = {"type": "text", "id": uuid.uuid4().hex[:8], "html": esc(text)}
                style = b.get("style")
                if style in ("h1", "h2", "h3", "center", "note", "quote"):
                    blk["style"] = style
                out.append(blk)
        return out

    def read_page(self, path, page, engine, lang):
        """Returns ({"page_no": ..., "blocks": [...]}, engine actually used)."""
        if engine in ("ai", "auto"):
            try:
                return self.read_ai(path, page), "ai"
            except Exception as e:
                if engine == "ai":
                    raise
                ai_error = str(e)
        try:
            return self.read_tesseract(path, page, lang), "tesseract"
        except Exception as e:
            if engine == "auto":
                raise RuntimeError(f"AI: {ai_error[:150]} · Tesseract: {str(e)[:150]}")
            raise

    def read_ai(self, path, page):
        cfg = self.settings.llm()
        with open(os.path.join(path, page.get("preview") or page["scan"]), "rb") as f:
            data = base64.b64encode(f.read()).decode()
        messages = [{"role": "user", "content": [
            {"type": "text", "text": AI_PROMPT},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + data}},
        ]}]
        text = "".join(rag.llm_stream(messages, cfg, max_tokens=6000))
        return parse_json(text)

    def read_tesseract(self, path, page, lang):
        if not shutil.which("tesseract"):
            raise RuntimeError("Tesseract není na serveru nainstalovaný")
        have = set(subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=30).stdout.split())
        want = {"cs": ["ces"], "de": ["deu", "deu_latf", "frk"], "cs+de": ["ces", "deu", "deu_latf"]}.get(lang, ["ces"])
        langs = [l for l in want if l in have] or [l for l in ("ces", "eng") if l in have] or ["eng"]
        res = subprocess.run(["tesseract", os.path.join(path, page["scan"]), "stdout", "-l", "+".join(langs), "--psm", "3"],
                             capture_output=True, text=True, timeout=300)
        if res.returncode != 0:
            raise RuntimeError(res.stderr.strip()[:200] or "Tesseract selhal")
        blocks = []
        for para in re.split(r"\n\s*\n", res.stdout):
            lines = [l.strip() for l in para.splitlines() if l.strip()]
            if not lines:
                continue
            text = ""
            for l in lines:
                if text.endswith("-") and l[:1].islower():
                    text = text[:-1] + l
                else:
                    text = (text + " " + l).strip()
            if re.fullmatch(r"[-–—\s\d.]+", text):   # lone page number
                continue
            blocks.append({"type": "text", "style": "p", "text": text})
        return {"page_no": None, "blocks": blocks}


def parse_json(text):
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    a, b = t.find("{"), t.rfind("}")
    if a < 0 or b <= a:
        raise ValueError("model nevrátil JSON: " + text[:120])
    data = json.loads(t[a:b + 1])
    if not isinstance(data.get("blocks"), list):
        raise ValueError("v odpovědi chybí blocks")
    return data
