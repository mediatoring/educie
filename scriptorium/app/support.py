"""Bug reports and feature requests sent from the app.

Every report is saved to <data>/_support/ (never served to the browser). When
SUPPORT_GITHUB_REPO ("owner/repo") and SUPPORT_GITHUB_TOKEN (fine-grained token
with Issues: read and write on that one repo) are set, a GitHub issue is created too.
"""
import base64
import http.client
import json
import os
import re
import time

KINDS = {
    "bug": ("Chyba", "bug"),
    "idea": ("Nápad na novou funkci", "enhancement"),
    "question": ("Dotaz", "question"),
}


class Support:
    def __init__(self, root, app_dir):
        self.dir = os.path.join(root, "_support")
        self.app_dir = app_dir

    def version(self):
        try:
            with open(os.path.join(self.app_dir, "VERSION"), encoding="utf-8") as f:
                return f.read().strip()[:12]
        except OSError:
            return "vývojová"

    def submit(self, data, user):
        kind = data.get("kind") if data.get("kind") in KINDS else "bug"
        title = " ".join(str(data.get("title", "")).split())[:120]
        text = str(data.get("text", "")).strip()[:8000]
        if not title or not text:
            return {"ok": False, "error": "Vyplňte prosím nadpis i popis."}
        report = {
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "kind": kind,
            "title": title,
            "text": text,
            "user": user or "",
            "context": {k: str(v)[:300] for k, v in (data.get("context") or {}).items()},
            "version": self.version(),
        }
        shot = data.get("screenshot") or ""
        os.makedirs(self.dir, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base = os.path.join(self.dir, f"{stamp}-{kind}")
        if shot.startswith("data:image/png;base64,"):
            try:
                with open(base + ".png", "wb") as f:
                    f.write(base64.b64decode(shot.split(",", 1)[1])[:8_000_000])
                report["screenshot"] = os.path.basename(base) + ".png"
            except ValueError:
                pass
        with open(base + ".json", "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
        issue = self.github_issue(report)
        return {"ok": True, "issue": issue}

    def github_issue(self, r):
        repo = os.environ.get("SUPPORT_GITHUB_REPO", "")
        token = os.environ.get("SUPPORT_GITHUB_TOKEN", "")
        if not (repo and token and re.fullmatch(r"[\w.-]+/[\w.-]+", repo)):
            return None
        label_name, label = KINDS[r["kind"]]
        ctx = "\n".join(f"- {k}: {v}" for k, v in r["context"].items())
        body = (f"**{label_name}** nahlášená z aplikace Scriptorium\n\n{r['text']}\n\n---\n"
                f"- verze: {r['version']}\n- čas: {r['time']}\n{ctx}\n"
                + ("- snímek obrazovky je uložen na serveru: `" + r["screenshot"] + "`\n" if r.get("screenshot") else ""))
        payload = json.dumps({"title": f"[{label_name}] {r['title']}", "body": body, "labels": [label, "z-aplikace"]})
        try:
            conn = http.client.HTTPSConnection("api.github.com", timeout=20)
            conn.request("POST", f"/repos/{repo}/issues", body=payload, headers={
                "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                "User-Agent": "educie-scriptorium", "Content-Type": "application/json"})
            resp = conn.getresponse()
            data = json.loads(resp.read() or b"{}")
            if resp.status == 201:
                return data.get("number")
        except (OSError, ValueError):
            pass
        return None
