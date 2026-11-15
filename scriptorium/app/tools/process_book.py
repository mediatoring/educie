"""Process an ordered set of page scans into a publisher project.

For every page: detect illustration / table regions, OCR the remaining text
(Czech), and write project.json with text and image blocks in reading order.

Usage: python3 process_book.py <book_dir>
<book_dir> must contain scans/pNN.jpg and order.json.
"""
import json
import os
import re
import subprocess
import sys

import cv2
import numpy as np
from PIL import Image

TESSDATA = os.environ.get("TESSDATA_PREFIX", os.path.expanduser("~/tessdata"))
PREVIEW_WIDTH = 1400


def detect_image_regions(gray):
    """Return list of [x, y, w, h] boxes that look like pictures or tables."""
    h, w = gray.shape
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    # ignore scanner borders
    margin = int(0.02 * w)
    binary[:margin, :] = 0
    binary[-margin:, :] = 0
    binary[:, :margin] = 0
    binary[:, -margin:] = 0

    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    big = np.zeros_like(binary)
    char_h = 0.018 * h  # typical text height upper bound
    for i in range(1, count):
        x, y, bw, bh, area = stats[i]
        if bh > 3 * char_h and bw > 3 * char_h:
            big[labels == i] = 255
        elif bh > 2.2 * char_h and bw > 2.2 * char_h and area / (bw * bh) > 0.08:
            big[labels == i] = 255
    # merge nearby large components (coins, drawings, table cells)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (int(0.03 * w), int(0.02 * h)))
    merged = cv2.dilate(big, kernel)
    contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for c in contours:
        x, y, bw, bh = cv2.boundingRect(c)
        if bw * bh < 0.01 * w * h:
            continue
        pad = int(0.008 * w)
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(w, x + bw + pad), min(h, y + bh + pad)
        boxes.append([x0, y0, x1 - x0, y1 - y0])
    return merge_overlaps(boxes)


def merge_overlaps(boxes):
    changed = True
    while changed:
        changed = False
        out = []
        for b in boxes:
            for o in out:
                if not (b[0] > o[0] + o[2] or o[0] > b[0] + b[2] or b[1] > o[1] + o[3] or o[1] > b[1] + b[3]):
                    x0, y0 = min(b[0], o[0]), min(b[1], o[1])
                    x1 = max(b[0] + b[2], o[0] + o[2])
                    y1 = max(b[1] + b[3], o[1] + o[3])
                    o[:] = [x0, y0, x1 - x0, y1 - y0]
                    changed = True
                    break
            else:
                out.append(list(b))
        boxes = out
    return boxes


def ocr_tsv(img_path):
    res = subprocess.run(
        ["tesseract", img_path, "stdout", "-l", os.environ.get("OCR_LANG", "ces"), "--psm", "3", "--tessdata-dir", TESSDATA, "tsv"],
        capture_output=True, text=True, check=True)
    rows = [r.split("\t") for r in res.stdout.splitlines()[1:]]
    return [r for r in rows if len(r) == 12]


def build_paragraphs(rows, page_h):
    """Group TSV words into paragraphs with their top y coordinate."""
    paragraphs = {}
    for r in rows:
        level, _, block, par, line, _, left, top, width, height, conf, text = r
        if level != "5" or not text.strip():
            continue
        key = (int(block), int(par))
        p = paragraphs.setdefault(key, {"top": int(top), "bottom": 0, "lines": {}, "heights": []})
        p["top"] = min(p["top"], int(top))
        p["bottom"] = max(p["bottom"], int(top) + int(height))
        p["lines"].setdefault(int(line), []).append(text)
        p["heights"].append(int(height))
    result = []
    for key in sorted(paragraphs, key=lambda k: paragraphs[k]["top"]):
        p = paragraphs[key]
        lines = [" ".join(p["lines"][k]) for k in sorted(p["lines"])]
        text = ""
        for ln in lines:
            if text.endswith("-") and len(text) > 1 and text[-2].isalpha():
                text = text[:-1] + ln
            else:
                text = (text + " " + ln).strip()
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            continue
        result.append({"top": p["top"], "bottom": p["bottom"], "text": text,
                       "height": float(np.median(p["heights"]))})
    return result


def main(book_dir):
    order = json.load(open(os.path.join(book_dir, "order.json")))
    os.makedirs(os.path.join(book_dir, "preview"), exist_ok=True)
    os.makedirs(os.path.join(book_dir, "images"), exist_ok=True)
    tmp = os.path.join(book_dir, ".tmp")
    os.makedirs(tmp, exist_ok=True)
    pages = []
    for entry in order:
        pid = entry["id"]
        scan_path = os.path.join(book_dir, entry["scan"])
        img = Image.open(scan_path).convert("RGB")
        w, h = img.size
        prev = img.copy()
        prev.thumbnail((PREVIEW_WIDTH, PREVIEW_WIDTH * 2))
        prev.save(os.path.join(book_dir, "preview", pid + ".jpg"), quality=82)

        gray = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2GRAY)
        boxes = detect_image_regions(gray)

        masked = gray.copy()
        for x, y, bw, bh in boxes:
            masked[y:y + bh, x:x + bw] = 255
        masked_path = os.path.join(tmp, pid + ".png")
        cv2.imwrite(masked_path, masked)
        paragraphs = build_paragraphs(ocr_tsv(masked_path), h)

        blocks = []
        page_no = None
        for p in paragraphs:
            if re.fullmatch(r"\d{1,3}", p["text"]) and p["top"] > 0.85 * h:
                page_no = int(p["text"])
                continue
            blocks.append({"type": "text", "y": p["top"], "text": p["text"]})
        for i, (x, y, bw, bh) in enumerate(boxes, 1):
            name = f"{pid}_img{i}.jpg"
            img.crop((x, y, x + bw, y + bh)).save(os.path.join(book_dir, "images", name), quality=88)
            blocks.append({"type": "image", "y": y, "src": "images/" + name,
                           "crop": [x, y, bw, bh], "caption": ""})
        blocks.sort(key=lambda b: b["y"])
        for b in blocks:
            b.pop("y", None)
        pages.append({"id": pid, "source": entry["source"], "scan": entry["scan"],
                      "preview": "preview/" + pid + ".jpg", "size": [w, h],
                      "page_no": page_no, "blocks": blocks})
        print(pid, "boxes", len(boxes), "paragraphs", len(paragraphs), "page", page_no, flush=True)

    project = {"title": os.path.basename(os.path.abspath(book_dir)), "pages": pages}
    with open(os.path.join(book_dir, "project.json"), "w") as f:
        json.dump(project, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(sys.argv[1])
