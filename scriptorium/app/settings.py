"""Language model settings editable from the app (stored in the data folder, never in git).

Values saved here override the LLM_* environment variables. The API key is never sent
back to the browser; the client only learns whether one is set.
"""
import json
import os
import threading

PRESETS = [
    {"id": "server", "label": "Výchozí model serveru", "base_url": "", "model": "", "needs_key": False},
    {"id": "openai", "label": "OpenAI (vlastní klíč)", "base_url": "https://api.openai.com/v1", "model": "", "needs_key": True},
    {"id": "anthropic", "label": "Anthropic Claude (vlastní klíč)", "base_url": "https://api.anthropic.com/v1", "model": "claude-sonnet-5-5", "needs_key": True},
    {"id": "lmstudio", "label": "LM Studio (běží tam, kde aplikace)", "base_url": "http://127.0.0.1:1234/v1", "model": "", "needs_key": False},
    {"id": "ollama", "label": "Ollama (běží tam, kde aplikace)", "base_url": "http://127.0.0.1:11434/v1", "model": "", "needs_key": False},
    {"id": "custom", "label": "Vlastní adresa (OpenAI-kompatibilní API)", "base_url": "", "model": "", "needs_key": False},
]

FIELDS = ("preset", "base_url", "model", "api_key", "verify_tls")


class Settings:
    def __init__(self, root):
        self.dir = os.path.join(root, "_settings")
        self.path = os.path.join(self.dir, "llm.json")
        self.lock = threading.Lock()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def llm(self):
        """Effective configuration used for requests (saved values override env)."""
        s = self._load()
        if s.get("preset", "server") == "server":
            s = {}
        return {
            "base_url": (s.get("base_url") or os.environ.get("LLM_BASE_URL", "http://127.0.0.1:18080/v1")).rstrip("/"),
            "model": s.get("model") or os.environ.get("LLM_MODEL", "gemma-4-26b-a4b"),
            "api_key": s.get("api_key") if s else os.environ.get("LLM_API_KEY", ""),
            "verify_tls": s.get("verify_tls", os.environ.get("LLM_VERIFY_TLS", "1") != "0") if s else os.environ.get("LLM_VERIFY_TLS", "1") != "0",
        }

    def public(self):
        s = self._load()
        return {
            "preset": s.get("preset", "server"),
            "base_url": s.get("base_url", ""),
            "model": s.get("model", ""),
            "has_key": bool(s.get("api_key")),
            "verify_tls": s.get("verify_tls", True),
            "presets": PRESETS,
            "server_model": os.environ.get("LLM_MODEL", "gemma-4-26b-a4b"),
        }

    def save(self, data):
        with self.lock:
            cur = self._load()
            for k in FIELDS:
                if k not in data:
                    continue
                if k == "api_key":
                    if data.get("clear_key"):
                        cur.pop("api_key", None)
                    elif data[k]:  # empty = keep the stored key
                        cur["api_key"] = str(data[k]).strip()
                elif k == "verify_tls":
                    cur[k] = bool(data[k])
                else:
                    cur[k] = str(data[k]).strip()
            if data.get("clear_key"):
                cur.pop("api_key", None)
            os.makedirs(self.dir, exist_ok=True)
            tmp = self.path + ".tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(cur, f, ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)
        return self.public()
