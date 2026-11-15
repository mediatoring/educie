"""MCP server (Streamable HTTP, JSON responses) for Claude Desktop, claude.ai and other MCP clients.

The address is /mcp/<token>; the token is created in the app (Nastavení AI -> Připojení pro Claude)
and can be replaced at any time, which cuts off the old address. Claude then reads the page scans
itself and writes or corrects the transcription, within the user's own subscription.
"""
import base64
import html
import json
import os
import re
import secrets
import threading
import time
import uuid

PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
INSTRUCTIONS = (
    "Educie Scriptorium: zdrojové knihy jsou naskenované staré tisky (čeština, němčina, švabach) s transkripcí po stranách. "
    "Postup přepisu: list_books -> list_pages (strany bez textu) -> get_page (obrázek strany a současný text) -> "
    "set_page_text (celý text strany po odstavcích) nebo update_block (oprava jednoho odstavce). "
    "Přepisuj doslova se starým pravopisem, nic nepřekládej, švabach přepiš latinkou, rozdělená slova na konci řádku spoj. "
    "Čísla stran v tools jsou od 1."
)

TOOLS = [
    {"name": "list_books", "description": "Seznam zdrojových knih: id, název, počet stran a kolik stran zatím nemá text.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "list_pages", "description": "Strany jedné zdrojové knihy: pořadí (od 1), vytištěné číslo strany, počet slov textu, počet obrázků, čím byl text přečten.",
     "inputSchema": {"type": "object", "properties": {"book_id": {"type": "string"}}, "required": ["book_id"]}},
    {"name": "get_page", "description": "Obrázek naskenované strany a její současná transkripce po odstavcích (s id odstavců).",
     "inputSchema": {"type": "object", "properties": {"book_id": {"type": "string"}, "page": {"type": "integer", "minimum": 1},
                                                      "full_resolution": {"type": "boolean", "description": "plné rozlišení skenu místo náhledu (větší)"}},
                     "required": ["book_id", "page"]}},
    {"name": "set_page_text", "description": "Nahradí celý text strany novými odstavci (obrázky na straně zůstanou). Předchozí stav se uloží do historie.",
     "inputSchema": {"type": "object", "properties": {
         "book_id": {"type": "string"}, "page": {"type": "integer", "minimum": 1},
         "page_no": {"type": ["string", "null"], "description": "číslo strany vytištěné na stránce"},
         "blocks": {"type": "array", "items": {"type": "object", "properties": {
             "text": {"type": "string"},
             "style": {"type": "string", "enum": ["p", "h1", "h2", "h3", "center", "note", "quote"]}}, "required": ["text"]}}},
         "required": ["book_id", "page", "blocks"]}},
    {"name": "update_block", "description": "Opraví text jednoho odstavce (id z get_page). Původní znění si aplikace pamatuje a jde vrátit.",
     "inputSchema": {"type": "object", "properties": {"book_id": {"type": "string"}, "block_id": {"type": "string"},
                                                      "text": {"type": "string"},
                                                      "style": {"type": "string", "enum": ["p", "h1", "h2", "h3", "center", "note", "quote"]}},
                     "required": ["book_id", "block_id", "text"]}},
    {"name": "search_text", "description": "Hledá slovo nebo frázi v transkripcích všech zdrojových knih (bez ohledu na diakritiku a velikost písmen).",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["query"]}},
]


def plain(h):
    return html.unescape(re.sub(r"<[^>]+>", " ", h or "")).replace(" ", " ").strip()


def fold(t):
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", t.lower()) if unicodedata.category(c) != "Mn")


class MCP:
    def __init__(self, root, book_dir, list_books, save_project, importer, audit, version=""):
        self.root = root
        self.book_dir = book_dir
        self.list_books = list_books
        self.save_project = save_project
        self.importer = importer
        self.audit = audit
        self.version = version
        self.path = os.path.join(root, "_settings", "mcp.json")
        self.lock = threading.Lock()

    # ---------- token ----------
    def token(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                return json.load(f).get("token", "")
        except (OSError, ValueError):
            return ""

    def new_token(self):
        tok = secrets.token_urlsafe(24)
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"token": tok, "created": time.strftime("%Y-%m-%d %H:%M")}, f)
        return tok

    def remove_token(self):
        if os.path.exists(self.path):
            os.remove(self.path)

    def check(self, tok):
        cur = self.token()
        return bool(cur) and secrets.compare_digest(cur, tok or "")

    # ---------- JSON-RPC ----------
    def handle(self, msg, who):
        """Returns the response object, or None for notifications."""
        if not isinstance(msg, dict) or "method" not in msg:
            return None
        mid, method, params = msg.get("id"), msg["method"], msg.get("params") or {}
        if mid is None:   # notification
            return None
        try:
            if method == "initialize":
                want = params.get("protocolVersion")
                result = {"protocolVersion": want if want in PROTOCOLS else PROTOCOLS[0],
                          "capabilities": {"tools": {"listChanged": False}},
                          "serverInfo": {"name": "educie-scriptorium", "title": "Educie Scriptorium", "version": self.version or "1"},
                          "instructions": INSTRUCTIONS}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": TOOLS}
            elif method == "tools/call":
                result = self.call(params.get("name"), params.get("arguments") or {}, who)
            else:
                return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"unknown method {method}"}}
        except Exception as e:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": str(e)[:300]}}
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    # ---------- tools ----------
    def call(self, name, args, who):
        try:
            fn = getattr(self, "t_" + str(name))
        except AttributeError:
            return {"content": [{"type": "text", "text": f"Neznámý nástroj {name}"}], "isError": True}
        try:
            return fn(args, who)
        except FileNotFoundError:
            return {"content": [{"type": "text", "text": "Kniha nebo strana neexistuje."}], "isError": True}
        except (ValueError, KeyError, IndexError, TypeError) as e:
            return {"content": [{"type": "text", "text": f"Chyba: {e}"}], "isError": True}

    def _text(self, data):
        return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=1)}]}

    def _load(self, book):
        path = self.book_dir(book)
        with open(os.path.join(path, "project.json"), encoding="utf-8") as f:
            return path, json.load(f)

    def _page(self, project, n):
        n = int(n)
        if not 1 <= n <= len(project["pages"]):
            raise IndexError(f"strana {n} neexistuje (kniha má {len(project['pages'])} stran)")
        return project["pages"][n - 1]

    def _writable(self, book):
        if self.importer.running(book):
            raise ValueError("v knize právě probíhá čtení textu v aplikaci, zkuste to za chvíli")

    def t_list_books(self, args, who):
        return self._text([{"book_id": b["id"], "title": b["title"], "pages": b["pages"], "pages_without_text": b.get("empty", 0)}
                           for b in self.list_books()])

    def t_list_pages(self, args, who):
        _, p = self._load(args["book_id"])
        out = []
        for i, page in enumerate(p["pages"]):
            words = sum(len(plain(b.get("html", "")).split()) for b in page["blocks"] if b.get("type") == "text")
            out.append({"page": i + 1, "page_no": page.get("page_no"), "words": words,
                        "images": sum(1 for b in page["blocks"] if b.get("type") == "image"),
                        "read_by": (page.get("ocr") or {}).get("engine", ""), "skip": bool(page.get("skip"))})
        return self._text({"book_id": args["book_id"], "title": p.get("title"), "pages": out})

    def t_get_page(self, args, who):
        path, p = self._load(args["book_id"])
        page = self._page(p, args["page"])
        rel = page["scan"] if args.get("full_resolution") or not page.get("preview") else page["preview"]
        with open(os.path.join(path, rel), "rb") as f:
            img = base64.b64encode(f.read()).decode()
        blocks = []
        for b in page["blocks"]:
            if b.get("type") == "image":
                blocks.append({"id": b["id"], "type": "image", "caption": b.get("caption", "")})
            else:
                blocks.append({"id": b["id"], "style": b.get("style", "p"), "text": plain(b.get("html", ""))})
        info = {"book_id": args["book_id"], "title": p.get("title"), "page": int(args["page"]), "of": len(p["pages"]),
                "page_no": page.get("page_no"), "blocks": blocks}
        return {"content": [{"type": "image", "data": img, "mimeType": "image/jpeg"},
                            {"type": "text", "text": json.dumps(info, ensure_ascii=False, indent=1)}]}

    def t_set_page_text(self, args, who):
        book = args["book_id"]
        self._writable(book)
        from importer import book_lock, esc
        with book_lock(book):
            path, p = self._load(book)
            page = self._page(p, args["page"])
            new = []
            for b in args["blocks"]:
                text = str(b.get("text", "")).strip()
                if not text:
                    continue
                blk = {"type": "text", "id": uuid.uuid4().hex[:8], "html": esc(text)}
                if b.get("style") in ("h1", "h2", "h3", "center", "note", "quote"):
                    blk["style"] = b["style"]
                new.append(blk)
            # pictures keep their place relative to the start of the page
            for idx, b in enumerate(page["blocks"]):
                if b.get("type") == "image":
                    new.insert(min(idx, len(new)), b)
            page["blocks"] = new
            if "page_no" in args:
                page["page_no"] = args["page_no"]
            page["ocr"] = {"engine": "mcp", "time": time.strftime("%Y-%m-%d %H:%M")}
            self.save_project(path, p)
        self.audit.log("edit", who, key="book:" + book, path=f"/mcp set_page_text {args['page']}")
        return self._text({"ok": True, "page": int(args["page"]), "paragraphs": sum(1 for b in new if b["type"] == "text")})

    def t_update_block(self, args, who):
        book = args["book_id"]
        self._writable(book)
        from importer import book_lock, esc
        with book_lock(book):
            path, p = self._load(book)
            for i, page in enumerate(p["pages"]):
                for b in page["blocks"]:
                    if b.get("id") == args["block_id"] and b.get("type") == "text":
                        b.setdefault("orig", {"html": b.get("html", "")})
                        b["html"] = esc(str(args["text"]).strip())
                        if args.get("style"):
                            if args["style"] == "p":
                                b.pop("style", None)
                            else:
                                b["style"] = args["style"]
                        self.save_project(path, p)
                        self.audit.log("edit", who, key="book:" + book, path=f"/mcp update_block {args['block_id']}")
                        return self._text({"ok": True, "page": i + 1, "block_id": b["id"]})
        raise KeyError("odstavec s tímto id neexistuje")

    def t_search_text(self, args, who):
        q = fold(str(args["query"]).strip())
        if len(q) < 2:
            raise ValueError("zadejte aspoň dva znaky")
        limit = min(int(args.get("limit") or 30), 100)
        hits = []
        for bk in self.list_books():
            try:
                _, p = self._load(bk["id"])
            except (OSError, ValueError, FileNotFoundError):
                continue
            for i, page in enumerate(p["pages"]):
                for b in page["blocks"]:
                    t = plain(b.get("html", ""))
                    k = fold(t).find(q)
                    if k >= 0:
                        hits.append({"book_id": bk["id"], "title": bk["title"], "page": i + 1, "block_id": b.get("id"),
                                     "text": ("…" if k > 60 else "") + t[max(0, k - 60):k + len(q) + 60] + "…"})
                        if len(hits) >= limit:
                            return self._text(hits)
        return self._text(hits)
