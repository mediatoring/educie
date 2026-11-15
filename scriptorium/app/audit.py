"""Access and change log: who (login), from where (IP) and on which device (browser fingerprint).

Lines go to <data>/_audit/YYYY-MM.jsonl, one JSON object per line:
    {"t": 1763200000.1, "ev": "login", "user": "...", "ip": "...", "fp": "...", "dev": "Chrome · macOS", "key": "...", "path": "..."}

Events: login, login-failed, logout, edit (a write request; repeated autosaves of the same
thing by the same person are merged into one line per EDIT_GAP seconds).
The histories of transcriptions and manuscripts look up here who made each saved version.
"""
import json
import os
import re
import threading
import time

EDIT_GAP = 60          # seconds: autosaves closer than this are logged once
SHOW_LAST = 300        # lines returned to the settings dialog


def device_label(ua):
    """Short human description of the browser and system from the User-Agent."""
    ua = ua or ""
    if "Edg/" in ua:
        browser = "Edge"
    elif "OPR/" in ua:
        browser = "Opera"
    elif "Firefox/" in ua:
        browser = "Firefox"
    elif "Chrome/" in ua or "CriOS/" in ua:
        browser = "Chrome"
    elif "Safari/" in ua:
        browser = "Safari"
    else:
        browser = "prohlížeč"
    if "iPhone" in ua:
        system = "iPhone"
    elif "iPad" in ua:
        system = "iPad"
    elif "Android" in ua:
        system = "Android"
    elif "Mac OS X" in ua or "Macintosh" in ua:
        system = "macOS"
    elif "Windows" in ua:
        system = "Windows"
    elif "Linux" in ua:
        system = "Linux"
    else:
        system = ""
    return f"{browser} · {system}" if system else browser


class Audit:
    def __init__(self, root):
        self.dir = os.path.join(root, "_audit")
        os.makedirs(self.dir, exist_ok=True)
        self.lock = threading.Lock()
        self.last_edit = {}   # (key, user, ip, fp) -> time of the last logged edit

    def _file(self, t=None):
        return os.path.join(self.dir, time.strftime("%Y-%m", time.localtime(t or time.time())) + ".jsonl")

    def log(self, ev, who, key="", path="", detail=""):
        t = time.time()
        if ev == "edit":
            k = (key, who.get("user"), who.get("ip"), who.get("fp"))
            if t - self.last_edit.get(k, 0) < EDIT_GAP:
                return
            self.last_edit[k] = t
        line = {"t": round(t, 1), "ev": ev, **who}
        if key:
            line["key"] = key
        if path:
            line["path"] = path[:200]
        if detail:
            line["detail"] = str(detail)[:300]
        with self.lock, open(self._file(t), "a", encoding="utf-8") as f:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")

    def _lines(self, months=3):
        files = sorted((f for f in os.listdir(self.dir) if re.match(r"\d{4}-\d{2}\.jsonl$", f)), reverse=True)[:months]
        out = []
        for name in reversed(files):
            try:
                with open(os.path.join(self.dir, name), encoding="utf-8") as f:
                    for raw in f:
                        try:
                            out.append(json.loads(raw))
                        except ValueError:
                            pass
            except OSError:
                pass
        return out

    def recent(self, limit=SHOW_LAST):
        return list(reversed(self._lines()[-limit:]))

    def editors(self, key, times):
        """For each time (seconds), who last changed `key` before it. Returns a list of dicts or None."""
        edits = [x for x in self._lines(months=12) if x.get("ev") == "edit" and x.get("key") == key]
        out = []
        for t in times:
            who = None
            for x in edits:
                if x["t"] <= t + 1:
                    who = x
                else:
                    break
            out.append({k: who.get(k) for k in ("user", "ip", "dev", "fp")} if who else None)
        return out
