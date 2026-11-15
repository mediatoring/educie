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
MAX_FAILS = 5
LOCK_SECONDS = 300
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
        self.fails = {}  # ip -> [count, locked_until]

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

    # ----- login with lockout -----
    def login(self, ip, user, pin):
        """Returns (ok, message)."""
        count, locked = self.fails.get(ip, [0, 0])
        if locked > time.time():
            wait = int(locked - time.time()) // 60 + 1
            return False, f"Příliš mnoho pokusů. Zkuste to znovu za {wait} min."
        ok = (user or "").strip().lower() == self.user.lower() and check_pin((pin or "").strip(), self.pin_hash)
        if ok:
            self.fails.pop(ip, None)
            return True, ""
        count += 1
        if count >= MAX_FAILS:
            self.fails[ip] = [0, time.time() + LOCK_SECONDS]
            return False, "Příliš mnoho pokusů. Přihlášení je na 5 minut zablokováno."
        self.fails[ip] = [count, 0]
        return False, "Jméno nebo PIN nesouhlasí."


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Použití: python3 auth.py <PIN>")
        sys.exit(1)
    print(hash_pin(sys.argv[1]))
