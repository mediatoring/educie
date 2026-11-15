"""Bug reports and feature requests sent from the app.

Every report is saved to <data>/_support/ (never served to the browser). With
SUPPORT_EMAIL_TO and SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM set it is also
e-mailed (e.g. into a CRM inbox). When
SUPPORT_GITHUB_REPO ("owner/repo") and SUPPORT_GITHUB_TOKEN (fine-grained token
with Issues: read and write on that one repo) are set, a GitHub issue is created too.
"""
import base64
import http.client
import smtplib
import ssl
from email.message import EmailMessage
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
        mailed = self.email(report, base + ".png" if report.get("screenshot") else None)
        return {"ok": True, "issue": issue, "mailed": mailed}

    def email(self, r, shot_path):
        """Send the report by e-mail (e.g. into a CRM inbox) when SMTP is configured."""
        to = os.environ.get("SUPPORT_EMAIL_TO", "")
        host = os.environ.get("SMTP_HOST", "")
        if not (to and host):
            return False
        label_name, _ = KINDS[r["kind"]]
        msg = EmailMessage()
        msg["Subject"] = f"[Scriptorium – {label_name}] {r['title']}"
        msg["From"] = os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER", "")
        msg["To"] = to
        ctx = "\n".join(f"{k}: {v}" for k, v in r["context"].items())
        msg.set_content(f"{label_name} z aplikace Educie Scriptorium\n\n{r['text']}\n\n---\n"
                        f"uživatel: {r['user'] or '-'}\nverze: {r['version']}\nčas: {r['time']}\n{ctx}\n")
        if shot_path and os.path.isfile(shot_path):
            with open(shot_path, "rb") as f:
                msg.add_attachment(f.read(), maintype="image", subtype="png", filename="obrazovka.png")
        port = int(os.environ.get("SMTP_PORT", "587"))
        try:
            if port == 465:
                srv = smtplib.SMTP_SSL(host, port, timeout=20, context=ssl.create_default_context())
            else:
                srv = smtplib.SMTP(host, port, timeout=20)
                srv.starttls(context=ssl.create_default_context())
            if os.environ.get("SMTP_USER"):
                srv.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASS", ""))
            srv.send_message(msg)
            srv.quit()
            return True
        except (OSError, smtplib.SMTPException):
            return False

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
