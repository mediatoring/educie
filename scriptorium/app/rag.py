"""Question answering over the transcribed books and the manuscript (RAG).

Retrieval is lexical (diacritics-insensitive, crude stemming) over the same index
as the search box; generation uses any OpenAI-compatible endpoint
(LLM_BASE_URL, LLM_MODEL, LLM_API_KEY), e.g. the local llama.cpp server with Gemma.
"""
import http.client
import json
import math
import os
import re
import ssl
from urllib.parse import urlparse

STOP = set("""a aby ale ani ano at az bez bude budou by byl byla byli bylo byt co což do i jak jake jaky je jeho jej jeji jejich jen jeste jsem jsou jste k kde kdo kdy kdyz ke ktera ktere kteri ktery ma mate me mezi mi mit mne mu muze my na nad nam nas ne nebo neni nez nic o od on ona oni ono pak po pod podle pokud pro proc proto pri s se si sve svuj ta tak take tam te tedy ten tento to toho tom tomu tu ty u uz v ve vsak z za ze zda
der die das und oder ist sind ein eine einer eines dem den des mit von zu im in auf fur nicht auch als wie wird werden war wurde bei aus nach sich es er sie so""".split())

SYSTEM_PROMPT = (
    "Jsi pečlivý pomocník autora knihy o historii numismatiky. Odpovídáš česky, srozumitelně a stručně, "
    "VÝHRADNĚ na základě přiložených úryvků ze zdrojových knih a z autorova rukopisu. "
    "Každé tvrzení doplň odkazem na úryvek v hranatých závorkách, např. [1] nebo [2][3]. "
    "Když odpověď v úryvcích není, napiš to otevřeně a nic si nedomýšlej. "
    "Německé úryvky překládej do češtiny."
)


def stems(text, fold):
    words = re.findall(r"[^\W\d_]{3,}", fold(text))
    return [w[:6] for w in words if w not in STOP]


def retrieve(question, entries, fold, k=6, max_chars=700):
    q = list(dict.fromkeys(stems(question, fold)))
    if not q:
        return []
    n = len(entries) or 1
    df = {s: sum(1 for e in entries if s in e["folded"]) for s in q}
    best = {}
    for e in entries:
        score = 0.0
        for s in q:
            c = e["folded"].count(s)
            if c:
                score += (1 + math.log(c)) * math.log(1 + n / (1 + df[s]))
        if score <= 0:
            continue
        key = e.get("block") or ("ms", e.get("para"))
        if e.get("field") == "tr":
            score *= 1.05  # prefer the Czech translation of a German paragraph
        if key not in best or best[key][0] < score:
            best[key] = (score, e)
    ranked = sorted(best.values(), key=lambda x: -x[0])[:k]
    out = []
    for score, e in ranked:
        text = e["text"]
        if len(text) > max_chars:
            # cut around the first matching stem
            pos = min([e["folded"].find(s) for s in q if s in e["folded"]] or [0])
            start = max(0, pos - max_chars // 3)
            text = ("…" if start else "") + text[start:start + max_chars] + "…"
        label = "Můj rukopis" if e["where"] == "manuscript" else (
            TITLE_PAREN.sub('', e['title']) + ", " + (f"s. {e['page_no']}" if e.get("page_no") else f"str. {e['page'] + 1}")
            + (" (překlad)" if e.get("field") == "tr" else ""))
        out.append({"label": label, "text": text, "where": e["where"], "book": e.get("book"),
                    "page": e.get("page"), "block": e.get("block"), "field": e.get("field"), "score": round(score, 2)})
    return out


TITLE_PAREN = re.compile(r'\s*\(.*\)\s*$')


def llm_stream(messages, max_tokens=700):
    """Yield text deltas from an OpenAI-compatible /chat/completions endpoint."""
    base = os.environ.get("LLM_BASE_URL", "http://127.0.0.1:18080/v1").rstrip("/")
    u = urlparse(base)
    if u.scheme == "https":
        ctx = ssl.create_default_context()
        if os.environ.get("LLM_VERIFY_TLS", "1") == "0":
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        conn = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=600, context=ctx)
    else:
        conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=600)
    headers = {"Content-Type": "application/json"}
    if os.environ.get("LLM_API_KEY"):
        headers["Authorization"] = "Bearer " + os.environ["LLM_API_KEY"]
    body = json.dumps({"model": os.environ.get("LLM_MODEL", "gemma-4-26b-a4b"), "messages": messages,
                       "stream": True, "max_tokens": max_tokens, "temperature": 0.2})
    conn.request("POST", u.path + "/chat/completions", body=body, headers=headers)
    resp = conn.getresponse()
    if resp.status != 200:
        raise RuntimeError(f"LLM {resp.status}: {resp.read()[:200]!r}")
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            delta = json.loads(data)["choices"][0].get("delta", {})
        except (ValueError, KeyError, IndexError):
            continue
        if delta.get("content"):
            yield delta["content"]
    conn.close()


def answer(question, entries, fold):
    """Events for the browser: sources first, then text deltas."""
    sources = retrieve(question, entries, fold)
    yield {"type": "sources", "sources": sources}
    if not sources:
        yield {"type": "delta", "text": "V přepsaných knihách ani v rukopisu jsem k této otázce nic nenašel. Zkuste ji položit jinými slovy."}
        return
    context = "\n\n".join(f"[{i + 1}] {s['label']}:\n{s['text']}" for i, s in enumerate(sources))
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Úryvky:\n{context}\n\nOtázka: {question}"},
    ]
    for chunk in llm_stream(messages):
        yield {"type": "delta", "text": chunk}
