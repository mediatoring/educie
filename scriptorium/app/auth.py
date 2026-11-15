"""Simple single-user login: name + PIN, signed session cookie, brute-force lockout.

Login is enabled when PUBLISHER_USER and PUBLISHER_PIN_HASH are set (environment),
or when <data>/.auth.json exists. Without it the app runs open (local use on the Mac).

Create a PIN hash:  python3 auth.py <pin>
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time

COOKIE = "publisher_session"
SESSION_DAYS = 30
MAX_FAILS = 5                                                        # wrong attempts from one address -> ban
BAN_SECONDS = int(float(os.environ.get("LOGIN_BAN_HOURS", "24")) * 3600)
GLOBAL_FAILS = int(os.environ.get("LOGIN_GLOBAL_FAILS", "20"))       # wrong attempts from anywhere within an hour
GLOBAL_LOCK_SECONDS = int(os.environ.get("LOGIN_GLOBAL_LOCK_MINUTES", "60")) * 60
ITERATIONS = 200_000


def hash_pin(pin, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), ITERATIONS).hex()
    return f"pbkdf2:{salt}:{digest}"


def check_pin(pin, stored):
    try:
        _, salt, digest = stored.replace("$", ":").split(":")
    except ValueError:
        return False
    return hmac.compare_digest(hash_pin(pin, salt).split(":")[2], digest)


class Auth:
    def __init__(self, data_dir):
        self.user = os.environ.get("PUBLISHER_USER")
        self.pin_hash = os.environ.get("PUBLISHER_PIN_HASH")
        cfg = os.path.join(data_dir, ".auth.json")
        if not (self.user and self.pin_hash) and os.path.exists(cfg):
            with open(cfg, encoding="utf-8") as f:
                c = json.load(f)
            self.user, self.pin_hash = c.get("user"), c.get("pin_hash")
        self.enabled = bool(self.user and self.pin_hash)
        self.secure = os.environ.get("PUBLISHER_SECURE_COOKIE", "1" if self.enabled else "0") == "1"
        secret = os.environ.get("PUBLISHER_SECRET")
        if not secret:
            path = os.path.join(data_dir, ".secret")
            if os.path.exists(path):
                with open(path) as f:
                    secret = f.read().strip()
            else:
                secret = secrets.token_hex(32)
                with open(path, "w") as f:
                    f.write(secret)
                os.chmod(path, 0o600)
        self.secret = secret.encode()
        # failed attempts and bans survive restarts; deleting the file lifts all bans
        self.guard_path = os.path.join(data_dir, ".login_guard.json")
        self.alert = None   # callback(subject, text), set by the server

    # ----- sessions -----
    def _sign(self, payload):
        return hmac.new(self.secret, payload.encode(), hashlib.sha256).hexdigest()

    def make_cookie(self):
        expires = int(time.time()) + SESSION_DAYS * 86400
        payload = f"{self.user}|{expires}"
        token = base64.urlsafe_b64encode(f"{payload}|{self._sign(payload)}".encode()).decode()
        attrs = f"{COOKIE}={token}; Path=/; Max-Age={SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax"
        return attrs + ("; Secure" if self.secure else "")

    def clear_cookie(self):
        return f"{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" + ("; Secure" if self.secure else "")

    def is_logged_in(self, cookie_header):
        if not self.enabled:
            return True
        for part in (cookie_header or "").split(";"):
            name, _, value = part.strip().partition("=")
            if name != COOKIE:
                continue
            try:
                user, expires, sig = base64.urlsafe_b64decode(value.encode()).decode().split("|")
            except (ValueError, UnicodeDecodeError):
                return False
            payload = f"{user}|{expires}"
            return (hmac.compare_digest(sig, self._sign(payload)) and user == self.user
                    and int(expires) > time.time())
        return False

    # ----- login with bans -----
    def _guard(self):
        try:
            with open(self.guard_path, encoding="utf-8") as f:
                g = json.load(f)
        except (OSError, ValueError):
            g = {}
        g.setdefault("ips", {})      # ip -> {"fails": n, "names": [...], "banned_until": t}
        g.setdefault("recent", [])   # times of failed attempts from anywhere
        g.setdefault("global_until", 0)
        return g

    def _save_guard(self, g):
        tmp = self.guard_path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(g, f)
        os.replace(tmp, self.guard_path)

    def _notify(self, subject, text):
        if self.alert:
            try:
                self.alert(subject, text)
            except Exception:  # an alert must never break the login
                pass

    def login(self, ip, user, pin, device=""):
        """Returns (ok, message). Five wrong attempts from one address ban it; many from anywhere lock the login."""
        now = time.time()
        g = self._guard()
        rec = g["ips"].get(ip, {})
        if rec.get("banned_until", 0) > now:
            until = time.strftime("%d. %m. %Y %H:%M", time.localtime(rec["banned_until"]))
            return False, f"Přihlášení z tohoto připojení je po opakovaně chybném PINu zablokované do {until}. Správce o tom dostal zprávu."
        if g["global_until"] > now:
            wait = int(g["global_until"] - now) // 60 + 1
            return False, f"Přihlašování je kvůli mnoha chybným pokusům dočasně zastavené. Zkuste to znovu za {wait} min."
        ok = (user or "").strip().lower() == self.user.lower() and check_pin((pin or "").strip(), self.pin_hash)
        if ok:
            if ip in g["ips"]:
                g["ips"].pop(ip)
                self._save_guard(g)
            return True, ""
        rec["fails"] = rec.get("fails", 0) + 1
        rec["names"] = (rec.get("names", []) + [str(user or "")[:40]])[-MAX_FAILS:]
        rec["last"] = now
        g["recent"] = [t for t in g["recent"] if now - t < 3600] + [now]
        msg = "Jméno nebo PIN nesouhlasí."
        if rec["fails"] >= MAX_FAILS:
            rec["banned_until"] = now + BAN_SECONDS
            rec["fails"] = 0
            until = time.strftime("%d. %m. %Y %H:%M", time.localtime(rec["banned_until"]))
            msg = f"Pětkrát chybné přihlášení. Přihlášení z tohoto připojení je zablokované do {until}. Správce o tom dostal zprávu."
            self._notify("Scriptorium: zablokované přihlášení z " + ip,
                         f"Po {MAX_FAILS} chybných pokusech o přihlášení je adresa {ip} zablokovaná do {until}.\n\n"
                         f"Zadaná jména: {', '.join(rec['names'])}\nZařízení: {device or 'neznámé'}\n"
                         f"Čas: {time.strftime('%d. %m. %Y %H:%M:%S')}\n\n"
                         f"Pokud jste to byli vy, blokaci zrušíte na serveru smazáním souboru {self.guard_path}.")
        g["ips"][ip] = rec
        if len(g["recent"]) >= GLOBAL_FAILS and g["global_until"] < now:
            g["global_until"] = now + GLOBAL_LOCK_SECONDS
            g["recent"] = []
            self._notify("Scriptorium: přihlašování zastaveno",
                         f"Za poslední hodinu přišlo {GLOBAL_FAILS} chybných pokusů o přihlášení z různých adres. "
                         f"Přihlašování je zastavené na {GLOBAL_LOCK_SECONDS // 60} minut.\n\nPoslední adresa: {ip}\n"
                         f"Čas: {time.strftime('%d. %m. %Y %H:%M:%S')}\n\nZrušení: smazat soubor {self.guard_path}.")
            msg = "Přihlašování je kvůli mnoha chybným pokusům dočasně zastavené."
        # forget stale addresses that are neither banned nor recent
        for k in [k for k, v in g["ips"].items() if v.get("banned_until", 0) < now and now - v.get("last", 0) > 86400]:
            g["ips"].pop(k)
        self._save_guard(g)
        return False, msg


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Použití: python3 auth.py <PIN>")
        sys.exit(1)
    print(hash_pin(sys.argv[1]))
