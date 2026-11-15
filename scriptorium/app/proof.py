"""Proofreading: finds suspicious words in transcriptions and in the manuscript.

A word is suspicious when it is not in the Czech or German dictionary (and not in the
user's own word list), or when it looks like a typical OCR error (digits or brackets
inside a word, a capital letter in the middle of a word).
"""
import os
import re
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

DICT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dict")
DICT_FILES = {"cs": "cs_CZ", "de": "de_DE_frami"}
WORD = re.compile(r"[^\W_]+(?:[-'’][^\W_]+)*|\S*\d\S*", re.UNICODE)
OCR_DIGIT = re.compile(r"(?<=[^\W\d_])\d|\d(?=[^\W\d_])")
OCR_JUNK = re.compile(r"[^\W\d_][()\[\]{}|<>\\/][^\W\d_]")
MID_CAPS = re.compile(r"^[a-záčďéěíňóřšťúůýž]+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]")


class Proofreader:
    def __init__(self, root):
        self.dict_dir = os.path.join(root, "_dict")
        self.user_path = os.path.join(self.dict_dir, "user.txt")
        self.scoped = {}
        self.dicts = {}
        self.lock = threading.Lock()
        self.cache = {}
        self.user = self._load_user()
        threading.Thread(target=self._preload, daemon=True).start()

    def _preload(self):
        for lang in DICT_FILES:
            try:
                self._dict(lang)
            except Exception:  # missing dictionary – proofreading then uses only OCR rules
                pass

    def _dict(self, lang):
        lang = lang if lang in DICT_FILES else "cs"
        with self.lock:
            if lang not in self.dicts:
                from spylls.hunspell import Dictionary
                self.dicts[lang] = Dictionary.from_files(os.path.join(DICT_DIR, DICT_FILES[lang]))
            return self.dicts[lang]

    def _load_user(self, path=None):
        try:
            with open(path or self.user_path, encoding="utf-8") as f:
                return {w.strip().lower() for w in f if w.strip()}
        except OSError:
            return set()

    def _scope_path(self, scope):
        safe = re.sub(r"[^\w\-]", "", scope or "")[:60]
        return os.path.join(self.dict_dir, "book-" + safe + ".txt") if safe else None

    def scope_words(self, scope):
        """Words of one book's own dictionary (source book or book being written)."""
        path = self._scope_path(scope)
        if not path:
            return set()
        if scope not in self.scoped:
            self.scoped[scope] = self._load_user(path)
        return self.scoped[scope]

    def add_word(self, word, scope=None):
        """Add to the central dictionary of this app, or to one book's dictionary when scope is given."""
        word = word.strip()
        if not word or len(word) > 80:
            return False
        path = self._scope_path(scope) if scope else self.user_path
        os.makedirs(self.dict_dir, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(word + "\n")
        (self.scope_words(scope) if scope else self.user).add(word.lower())
        return True

    def reason(self, word, lang, scope=None):
        """None when the word looks fine, otherwise a short Czech explanation."""
        if OCR_DIGIT.search(word) and not word.isdigit() and not re.fullmatch(r"\d+(\.|-?ti|-?tý|-?té|-?ho|-?mu)?", word):
            return "číslice uvnitř slova – častá chyba OCR"
        if OCR_JUNK.search(word):
            return "nečekaný znak uvnitř slova"
        letters = re.sub(r"[^\W\d_]", "", word) == ""
        if not letters or any(ch.isdigit() for ch in word) or len(word) < 3:
            return None
        if MID_CAPS.match(word):
            return "velké písmeno uprostřed slova"
        low = word.lower()
        if low in self.user or (scope and low in self.scope_words(scope)):
            return None
        key = (lang, word)
        if key in self.cache:
            return self.cache[key]
        try:
            d = self._dict(lang)
            ok = d.lookup(word) or d.lookup(low) or d.lookup(word.capitalize())
            if not ok and "-" in word:
                ok = all(d.lookup(p) or d.lookup(p.lower()) for p in word.split("-") if p)
        except Exception:
            ok = True
        result = None if ok else "není ve slovníku"
        self.cache[key] = result
        return result

    def check(self, items, scope=None):
        """items: [{key, text, lang}] -> {key: [{word, reason}]} (each distinct word once)."""
        out = {}
        for it in items[:5000]:
            seen, found = set(), []
            for w in WORD.findall(it.get("text") or ""):
                w = w.strip(".,;:!?„“”\"'()[]«»…–—-")
                if not w or w in seen:
                    continue
                seen.add(w)
                r = self.reason(w, it.get("lang") or "cs", scope)
                if r:
                    found.append({"word": w, "reason": r})
            if found:
                out[it["key"]] = found
        return out

    def suggest(self, word, lang):
        try:
            return list(self._dict(lang).suggest(word))[:6]
        except Exception:
            return []
