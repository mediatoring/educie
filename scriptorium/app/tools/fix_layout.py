"""Re-OCR pages with a manual layout (figures + text regions in reading order)
and clean up paragraphs across the whole project.

Usage: python3 fix_layout.py <book_dir> [layout.json]
layout.json: {"p07": {"figures": [[x,y,w,h], ...], "regions": [[x,y,w,h], ...]}}
"""
import html
import json
import os
import re
import sys
import uuid

from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from process_book import ocr_tsv, build_paragraphs  # noqa: E402

END_PUNCT = re.compile(r"[.!?:;»«“”\")]$")


def new_id():
    return uuid.uuid4().hex[:8]


def ocr_region(img, box, tmp_path):
    x, y, w, h = box
    img.crop((x, y, x + w, y + h)).convert("L").save(tmp_path)
    return [p["text"] for p in build_paragraphs(ocr_tsv(tmp_path), h)]


def relayout_page(book_dir, page, spec):
    img = Image.open(os.path.join(book_dir, page["scan"])).convert("RGB")
    tmp = os.path.join(book_dir, ".region.png")
    blocks = []
    for i, box in enumerate(spec.get("figures", []), 1):
        x, y, w, h = box
        name = f"{page['id']}_fig{i}.jpg"
        img.crop((x, y, x + w, y + h)).save(os.path.join(book_dir, "images", name), quality=90)
        blocks.append({"id": new_id(), "type": "image", "src": "images/" + name, "crop": box, "caption": ""})
    for box in spec.get("regions", []):
        for text in ocr_region(img, box, tmp):
            if re.fullmatch(r"\d{1,3}", text):
                continue
            blocks.append({"id": new_id(), "type": "text", "html": html.escape(text)})
    if os.path.exists(tmp):
        os.remove(tmp)
    page["blocks"] = blocks


def merge_broken_paragraphs(page):
    """Join text blocks split mid-sentence by OCR (hyphen or lowercase continuation)."""
    out = []
    for b in page["blocks"]:
        prev = out[-1] if out else None
        if (prev and prev["type"] == "text" and b["type"] == "text"
                and not prev.get("style") and not b.get("style")):
            left, right = prev["html"].rstrip(), b["html"].lstrip()
            if left.endswith("-") and right[:1].islower():
                prev["html"] = left[:-1] + right
                continue
            if right[:1].islower() and not END_PUNCT.search(left):
                prev["html"] = left + " " + right
                continue
        out.append(b)
    page["blocks"] = out


def mark_headings(page):
    for b in page["blocks"]:
        if b["type"] != "text":
            continue
        t = html.unescape(b["html"])
        letters = [c for c in t if c.isalpha()]
        if 3 < len(t) < 90 and letters and sum(c.isupper() for c in letters) / len(letters) > 0.8:
            b["style"] = "h2"


def main(book_dir, layout_path=None):
    pj = os.path.join(book_dir, "project.json")
    project = json.load(open(pj, encoding="utf-8"))
    layout = json.load(open(layout_path)) if layout_path else {}
    for page in project["pages"]:
        for b in page["blocks"]:
            b.setdefault("id", new_id())
            if b["type"] == "text" and "html" not in b:
                b["html"] = html.escape(b.pop("text"))
        if page["id"] in layout:
            relayout_page(book_dir, page, layout[page["id"]])
            print("relayout", page["id"], len(page["blocks"]), "blocks")
        page["blocks"] = [b for b in page["blocks"]
                          if not (b["type"] == "text" and re.fullmatch(r"\s*\d{1,3}\s*", html.unescape(b["html"])))]
        mark_headings(page)
        merge_broken_paragraphs(page)
    json.dump(project, open(pj, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(*sys.argv[1:])
