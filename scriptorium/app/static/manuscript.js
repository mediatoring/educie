// Publisher – manuscript editor (large controls, autosave, version history)
"use strict";

(() => {



const $ = (s) => document.querySelector(s);
const editor = $("#msEditor");
const msState = { version: null, dirty: false, saving: false, timer: null, selectedImg: null, clipsSig: "", histSel: null };
const BACKUP_KEY = "publisher.manuscript.backup";

const toast = (msg, ms, undo) => window.showToast(msg, ms, undo);

function setState(text, cls = "") {
  const s = $("#msSaveState");
  s.textContent = text;
  s.className = "save-state " + cls;
}

// ---------- sanitizing ----------
const ALLOWED = new Set(["P", "H1", "H2", "H3", "BLOCKQUOTE", "B", "STRONG", "I", "EM", "U", "BR", "UL", "OL", "LI",
  "FIGURE", "FIGCAPTION", "IMG", "SPAN", "SUP", "SUB", "DIV", "FONT"]);
const STYLE_PROPS = ["text-align", "font-family", "font-size", "font-weight", "font-style", "text-decoration", "width"];

function sanitize(root) {
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) { child.remove(); continue; }
      if (child.nodeType !== 1) continue;
      walk(child);
      if (!ALLOWED.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
      for (const a of [...child.attributes]) {
        const n = a.name.toLowerCase();
        if (n === "style") {
          const keep = STYLE_PROPS.map((p) => child.style.getPropertyValue(p) ? `${p}:${child.style.getPropertyValue(p)}` : "").filter(Boolean).join(";");
          if (keep) child.setAttribute("style", keep); else child.removeAttribute("style");
        } else if (n === "src" && child.tagName === "IMG") {
          // keep only our own images; data: images are uploaded separately
        } else if (n === "class" && /^(cite|src)$/.test(a.value)) {
          // keep citation class
        } else if ((n === "face" || n === "size") && child.tagName === "FONT") {
          // legacy font tags from execCommand
        } else {
          child.removeAttribute(a.name);
        }
      }
    }
  };
  walk(root);
  return root;
}

function cleanHtml(html) {
  const d = document.createElement("div");
  d.innerHTML = html;
  return sanitize(d).innerHTML;
}

// ---------- camera ----------
let camStream = null;
async function openCamera() {
  $("#imgMenu").hidden = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // phones/tablets without camera API: the system picker offers the camera
    $("#cameraFile").click();
    return;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } }, audio: false });
    $("#camVideo").srcObject = camStream;
    $("#camDlg").hidden = false;
  } catch (e) {
    window.showToast("Kameru se nepodařilo zapnout. Povolte ji v prohlížeči, nebo vyberte fotku z počítače.", 7000);
  }
}
function closeCamera() {
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  $("#camDlg").hidden = true;
}

// ---------- load & save ----------
async function load() {
  const res = await fetch("api/manuscript");
  const doc = await res.json();
  msState.version = doc.version;
  msState.title = doc.title || "Můj rukopis";
  $("#msTitle").value = msState.title;
  editor.dataset.title = msState.title;
  editor.innerHTML = doc.html.replace(/src="\/books\//g, 'src="books/');
  // unsaved text left in this browser after a crash or closed window?
  try {
    const backup = JSON.parse(localStorage.getItem(BACKUP_KEY) || "null");
    if (backup && backup.html && backup.html !== doc.html && (backup.baseVersion === doc.version || backup.baseVersion == null)) {
      editor.innerHTML = backup.html;
      markDirty();
      toast("Obnoven neuložený text z minula – ukládám.", 4000);
    }
  } catch (e) { /* storage unavailable */ }
  setState("✓ uloženo");
  refreshToc();
}

function markDirty() {
  msState.dirty = true;
  setState("● píšete…", "dirty");
  try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ html: editor.innerHTML, baseVersion: msState.version, t: Date.now() })); } catch (e) { /* ignore */ }
  clearTimeout(msState.timer);
  msState.timer = setTimeout(save, 1500);
}

async function save() {
  clearTimeout(msState.timer);
  if (!msState.dirty || msState.saving) return;
  msState.saving = true;
  msState.dirty = false;
  setState("ukládám…", "dirty");
  try {
    const res = await fetch("api/manuscript", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: cleanHtml(editor.innerHTML), version: msState.version, title: msState.title }),
    });
    const data = await res.json();
    if (res.status === 409) {
      msState.dirty = true;
      setState("⚠ rukopis je otevřený i jinde", "error");
      if (confirm("Rukopis byl mezitím uložen z jiného okna.\n\nOK = ponechat tento text a uložit ho (druhá verze zůstane v historii)\nZrušit = načíst text z druhého okna")) {
        msState.version = data.version;
        msState.saving = false;
        return save();
      }
      localStorage.removeItem(BACKUP_KEY);
      msState.saving = false;
      return load();
    }
    if (!res.ok) throw new Error(data.error || res.status);
    msState.version = data.version;
    localStorage.removeItem(BACKUP_KEY);
    setState(msState.dirty ? "● píšete…" : `✓ uloženo ${data.saved}`, msState.dirty ? "dirty" : "");
  } catch (e) {
    msState.dirty = true;
    setState("⚠ neuloženo – zkouším znovu", "error");
    clearTimeout(msState.timer);
    msState.timer = setTimeout(save, 5000);
  } finally {
    msState.saving = false;
    if (msState.dirty) { clearTimeout(msState.timer); msState.timer = setTimeout(save, 1500); }
  }
}

// ---------- table of contents ----------
function refreshToc() {
  const heads = [...editor.querySelectorAll("h1, h2, h3")];
  for (const toc of [$("#toc"), $("#outline")]) {
    toc.innerHTML = "";
    if (!heads.length) { toc.innerHTML = '<div class="empty">Zatím žádné kapitoly. Nadpis kapitoly nastavíte v nabídce typu odstavce.</div>'; continue; }
    heads.forEach((h, i) => {
      const a = document.createElement("a");
      a.className = "l" + h.tagName[1];
      a.dataset.i = i;
      a.textContent = h.textContent.trim() || "(bez názvu)";
      a.title = a.textContent;
      a.addEventListener("click", () => h.scrollIntoView({ behavior: "smooth", block: "start" }));
      toc.append(a);
    });
  }
  markCurrentHeading();
}

// highlight the chapter currently on screen in the outline
function markCurrentHeading() {
  const desk = $("#msDesk");
  const heads = [...editor.querySelectorAll("h1, h2, h3")];
  const top = desk.getBoundingClientRect().top + 80;
  let cur = -1;
  heads.forEach((h, i) => { if (h.getBoundingClientRect().top <= top) cur = i; });
  document.querySelectorAll("#outline a").forEach((a) => a.classList.toggle("current", +a.dataset.i === cur));
}

// ---------- formatting ----------
function exec(cmd, value = null) {
  editor.focus();
  restoreSelection();
  document.execCommand("styleWithCSS", false, true);
  document.execCommand(cmd, false, value);
  markDirty();
  updateToolbar();
}

let savedRange = null;
function rememberSelection() {
  const sel = window.getSelection();
  if (sel.rangeCount && editor.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
}
function restoreSelection() {
  if (!savedRange) return;
  const sel = window.getSelection();
  if (sel.rangeCount && editor.contains(sel.anchorNode)) return;
  sel.removeAllRanges();
  sel.addRange(savedRange);
}

function updateToolbar() {
  for (const b of document.querySelectorAll(".tb[data-cmd]")) {
    try { b.classList.toggle("on", document.queryCommandState(b.dataset.cmd)); } catch (e) { /* ignore */ }
  }
  let block = "p";
  try { block = (document.queryCommandValue("formatBlock") || "p").toLowerCase(); } catch (e) { /* ignore */ }
  $("#blockStyle").value = ["h1", "h2", "h3", "blockquote"].includes(block) ? block : "p";
}

// ---------- images ----------
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function uploadImage(file) {
  setState("nahrávám obrázek…", "dirty");
  const data = await readAsDataUrl(file);
  const res = await fetch("api/manuscript/images", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }),
  });
  const out = await res.json();
  if (!res.ok) { toast("Obrázek se nepodařilo uložit: " + out.error); return null; }
  return out.src;
}

async function insertImages(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    const src = await uploadImage(f);
    if (src) {
      insertBlockHtml(`<figure><img src="${src}" style="width:100%"><figcaption></figcaption></figure>`, "Obrázek vložen. Oříznout ho můžete tlačítkem ✂ nad textem.");
      const img = editor.querySelector(`img[src="${src}"]`);
      if (img) selectImage(img);
    }
  }
}

function selectImage(img) {
  editor.querySelectorAll("img.selected").forEach((i) => i.classList.remove("selected"));
  msState.selectedImg = img;
  $("#imgBar").hidden = !img;
  if (img) img.classList.add("selected");
}

// ---------- clipboard tray ----------
async function loadClips() {
  let clips = [];
  try { clips = await (await fetch("api/clips")).json(); } catch (e) { return; }
  const sig = JSON.stringify(clips.map((c) => c.id));
  if (sig === msState.clipsSig) return;
  const added = msState.clipsSig && clips.length > JSON.parse(msState.clipsSig).length;
  msState.clipsSig = sig;
  const box = $("#clips");
  box.innerHTML = "";
  const badge = $("#clipCount");
  badge.textContent = clips.length;
  badge.hidden = !clips.length;
  if (!clips.length) { box.innerHTML = '<div class="empty">Schránka je prázdná.</div>'; return; }
  const kinds = { text: "Odstavec", quote: "Citace", image: "Obrázek" };
  for (const c of [...clips].reverse()) {
    const div = document.createElement("div");
    div.className = "clip";
    div.innerHTML = `<div class="kind">${kinds[c.kind] || "Text"}${c.source ? " · " + escapeHtml(c.source) : ""}</div><div class="body">${c.html}</div>`;
    const actions = document.createElement("div");
    actions.className = "actions";
    const ins = document.createElement("button");
    ins.className = "primary";
    ins.textContent = "Vložit sem";
    ins.addEventListener("mousedown", (e) => e.preventDefault()); // keep the cursor in the text
    ins.addEventListener("click", () => insertClip(c));
    const del = document.createElement("button");
    del.textContent = "Odebrat";
    del.addEventListener("click", async () => {
      await fetch(`api/clips/${c.id}/delete`, { method: "POST" });
      loadClips();
    });
    actions.append(ins, del);
    div.append(actions);
    box.append(div);
  }
  if (added && $("#colMs").hidden) toast("Ve schránce rukopisu je nová položka.");
}

// insert block content (paragraph, figure, quote) as its own block after the paragraph with the cursor
function insertBlockHtml(html, message) {
  const hadCursor = !!savedRange;
  editor.focus();
  restoreSelection();
  const sel = window.getSelection();
  let anchor = hadCursor && sel.rangeCount && editor.contains(sel.anchorNode) ? sel.anchorNode : null;
  while (anchor && anchor.parentNode !== editor) anchor = anchor.parentNode;
  // replace an empty trailing paragraph instead of leaving gaps
  const holder = document.createElement("p");
  holder.innerHTML = "<br>";
  if (anchor) anchor.after(holder); else editor.append(holder);
  const before = new Set(editor.children);
  const r = document.createRange();
  r.selectNode(holder);
  sel.removeAllRanges();
  sel.addRange(r);
  document.execCommand("insertHTML", false, html + "<p><br></p>");
  const added = [...editor.children].filter((n) => !before.has(n));
  const first = added.find((n) => n.textContent.trim() || n.querySelector("img")) || added[0];
  // cursor after the inserted content, so the next insert follows it
  const last = added[added.length - 1];
  if (last) {
    const after = document.createRange();
    after.selectNodeContents(last);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    savedRange = after.cloneRange();
  }
  if (first) {
    first.scrollIntoView({ behavior: "smooth", block: "center" });
    first.classList.add("flash");
    setTimeout(() => first.classList.remove("flash"), 1800);
  }
  markDirty();
  refreshToc();
  toast(message || "Vloženo do rukopisu.", 5000, () => { editor.focus(); document.execCommand("undo"); markDirty(); refreshToc(); });
  showInsertMark();
  return first;
}

// visible marker where the next transfer will land (the caret disappears when the editor loses focus)
function showInsertMark() {
  const mark = $("#insertMark");
  if (!savedRange || document.activeElement === editor || $("#colMs").hidden) { mark.hidden = true; return; }
  let rect = savedRange.getBoundingClientRect();
  if (!rect || (!rect.height && !rect.width)) {
    const node = savedRange.startContainer.nodeType === 1 ? savedRange.startContainer : savedRange.startContainer.parentElement;
    rect = node.getBoundingClientRect();
  }
  const desk = $("#msDesk");
  const d = desk.getBoundingClientRect();
  const k = desk.offsetWidth / d.width || 1;
  mark.style.top = (rect.top - d.top) * k + desk.scrollTop + "px";
  mark.style.left = (rect.left - d.left) * k + desk.scrollLeft + "px";
  mark.style.height = Math.max(20, rect.height * k) + "px";
  mark.hidden = false;
}

function insertClip(c) {
  const sel = window.getSelection();
  if (!(sel.rangeCount && editor.contains(sel.anchorNode)) && !savedRange) {
    // no cursor yet: append at the end
    const r = document.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  insertBlockHtml(c.html, "Vloženo ze schránky.");
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

// ---------- history ----------
async function openHistory() {
  if (msState.dirty) await save();
  $("#historyDlg").hidden = false;
  const list = $("#historyList");
  list.innerHTML = "Načítám…";
  const items = await (await fetch("api/manuscript/history")).json();
  list.innerHTML = "";
  if (!items.length) list.innerHTML = '<div class="hist-item">Zatím žádné starší verze. Ukládají se automaticky každé 3 minuty psaní.</div>';
  for (const it of items) {
    const t = it.time;
    const when = `${t.slice(6, 8)}. ${t.slice(4, 6)}. ${t.slice(0, 4)}  ${t.slice(9, 11)}:${t.slice(11, 13)}`;
    const div = document.createElement("div");
    div.className = "hist-item";
    div.innerHTML = `<div class="t">${when}</div><div class="l">${escapeHtml(it.label || "")} · ${it.words} slov</div>`;
    div.addEventListener("click", async () => {
      list.querySelectorAll(".hist-item").forEach((n) => n.classList.remove("on"));
      div.classList.add("on");
      const data = await (await fetch(`api/manuscript/history/${encodeURIComponent(it.name)}`)).json();
      $("#histView").innerHTML = data.html;
      $("#histInfo").textContent = `Verze z ${when}`;
      msState.histSel = it.name;
      $("#histRestore").disabled = false;
    });
    list.append(div);
  }
}

async function restoreVersion() {
  if (!msState.histSel) return;
  if (!confirm("Obnovit vybranou verzi?\n\nSoučasný text se předtím uloží do historie, takže o nic nepřijdete.")) return;
  const res = await fetch("api/manuscript/restore", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: msState.histSel }),
  });
  if (!res.ok) { toast("Obnovení se nepovedlo."); return; }
  $("#historyDlg").hidden = true;
  await load();
  toast("Verze obnovena.");
}

// ---------- crop & straighten ----------
const crop = { img: null, target: null, angle: 0, rotated: null, rect: null, scale: 1 };

function rotatedCanvas(img, angle) {
  const rad = angle * Math.PI / 180;
  const w = img.naturalWidth, h = img.naturalHeight;
  const cw = Math.round(Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad)));
  const ch = Math.round(Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)));
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);
  ctx.translate(cw / 2, ch / 2); ctx.rotate(rad);
  ctx.drawImage(img, -w / 2, -h / 2);
  return c;
}

function drawCropPreview(keepRect) {
  crop.rotated = rotatedCanvas(crop.img, crop.angle);
  const cv = $("#cropCanvas");
  const stage = $("#cropStage");
  const maxW = stage.clientWidth - 60, maxH = stage.clientHeight - 60;
  crop.scale = Math.min(1, maxW / crop.rotated.width, maxH / crop.rotated.height);
  cv.width = Math.round(crop.rotated.width * crop.scale);
  cv.height = Math.round(crop.rotated.height * crop.scale);
  const ctx = cv.getContext("2d");
  ctx.drawImage(crop.rotated, 0, 0, cv.width, cv.height);
  // helper grid for straightening
  ctx.strokeStyle = "rgba(31,111,235,.35)"; ctx.lineWidth = 1;
  for (let x = 40; x < cv.width; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); ctx.stroke(); }
  for (let y = 40; y < cv.height; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke(); }
  if (!keepRect || !crop.rect) crop.rect = { x: 0, y: 0, w: cv.width, h: cv.height };
  crop.rect.w = Math.min(crop.rect.w, cv.width); crop.rect.h = Math.min(crop.rect.h, cv.height);
  crop.rect.x = Math.min(crop.rect.x, cv.width - crop.rect.w); crop.rect.y = Math.min(crop.rect.y, cv.height - crop.rect.h);
  placeCropRect();
  $("#rotValue").textContent = crop.angle.toFixed(1).replace(".", ",") + "°";
}

function placeCropRect() {
  const r = crop.rect, n = $("#cropRect");
  Object.assign(n.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
}

function openCrop(img) {
  crop.target = img;
  crop.angle = 0;
  crop.rect = null;
  crop.img = new Image();
  crop.img.onload = () => { $("#cropDlg").hidden = false; requestAnimationFrame(() => drawCropPreview(false)); };
  crop.img.src = img.getAttribute("src").split("?")[0] + "?t=" + Date.now();
}

function initCrop() {
  const rectNode = $("#cropRect");
  rectNode.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const handle = [...e.target.classList].find((c) => ["nw", "n", "ne", "e", "se", "s", "sw", "w"].includes(c)) || "move";
    const start = { x: e.clientX, y: e.clientY, r: { ...crop.rect } };
    const cv = $("#cropCanvas");
    const k = cv.width / cv.getBoundingClientRect().width;
    const move = (ev) => {
      const dx = (ev.clientX - start.x) * k, dy = (ev.clientY - start.y) * k;
      let { x, y, w, h } = start.r;
      if (handle === "move") { x += dx; y += dy; }
      if (handle.includes("w")) { x += dx; w -= dx; }
      if (handle.includes("e")) w += dx;
      if (handle.includes("n")) { y += dy; h -= dy; }
      if (handle.includes("s")) h += dy;
      w = Math.max(30, w); h = Math.max(30, h);
      x = Math.max(0, Math.min(x, cv.width - w)); y = Math.max(0, Math.min(y, cv.height - h));
      w = Math.min(w, cv.width - x); h = Math.min(h, cv.height - y);
      crop.rect = { x, y, w, h };
      placeCropRect();
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  document.querySelectorAll("[data-rot]").forEach((b) => b.addEventListener("click", () => {
    crop.angle = Math.round((crop.angle + parseFloat(b.dataset.rot)) * 10) / 10;
    drawCropPreview(Math.abs(parseFloat(b.dataset.rot)) < 90);
  }));
  $("#cropReset").addEventListener("click", () => { crop.angle = 0; drawCropPreview(false); });
  $("#cropCancel").addEventListener("click", () => { $("#cropDlg").hidden = true; });
  $("#cropApply").addEventListener("click", async () => {
    const s = crop.scale, r = crop.rect;
    const out = document.createElement("canvas");
    out.width = Math.round(r.w / s); out.height = Math.round(r.h / s);
    out.getContext("2d").drawImage(crop.rotated, r.x / s, r.y / s, r.w / s, r.h / s, 0, 0, out.width, out.height);
    const blob = await new Promise((res) => out.toBlob(res, "image/jpeg", 0.92));
    const src = await uploadImage(new File([blob], "crop.jpg", { type: "image/jpeg" }));
    if (src) {
      crop.target.setAttribute("src", src);
      markDirty();
      toast("Obrázek upraven. Původní zůstává v historii verzí.");
    }
    $("#cropDlg").hidden = true;
  });
}

// ---------- search ----------
function foldText(t) { return t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }

function highlight(text, terms) {
  const folded = foldText(text);
  const marks = new Array(text.length).fill(false);
  for (const t of terms.map(foldText)) {
    let i = folded.indexOf(t);
    while (i >= 0 && t) { for (let k = i; k < i + t.length; k++) marks[k] = true; i = folded.indexOf(t, i + t.length); }
  }
  let out = "", on = false;
  for (let i = 0; i < text.length; i++) {
    if (marks[i] !== on) { out += marks[i] ? "<mark>" : "</mark>"; on = marks[i]; }
    out += escapeHtml(text[i]);
  }
  return out + (on ? "</mark>" : "");
}

function scrollToPara(n) {
  const blocks = editor.querySelectorAll("p, h1, h2, h3, li, blockquote, figcaption");
  const target = blocks[Math.min(n, blocks.length - 1)];
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1800);
}

function scrollToMatch(terms, k) {
  const folded = terms.map(foldText);
  const els = [...editor.querySelectorAll("p, h1, h2, h3, li, figcaption")]
    .filter((n) => { const t = foldText(n.textContent); return folded.every((f) => t.includes(f)); });
  const target = els[Math.min(k, els.length - 1)];
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1800);
}

// ---------- wiring ----------
function init() {
  document.querySelectorAll(".tb[data-cmd]").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => exec(b.dataset.cmd));
  });
  $("#blockStyle").addEventListener("change", (e) => { exec("formatBlock", e.target.value); refreshToc(); });
  $("#fontName").addEventListener("change", (e) => { if (e.target.value) exec("fontName", e.target.value); e.target.value = ""; });
  $("#fontSize").addEventListener("change", (e) => { if (e.target.value) exec("fontSize", e.target.value); e.target.value = ""; });
  for (const sel of ["#blockStyle", "#fontName", "#fontSize"]) $(sel).addEventListener("mousedown", rememberSelection);

  $("#imageBtn").addEventListener("mousedown", rememberSelection);
  $("#imageBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const m = $("#imgMenu");
    if (!m.hidden) { m.hidden = true; return; }
    const r = $("#imageBtn").getBoundingClientRect();
    m.hidden = false;
    Object.assign(m.style, { left: Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 12)) + "px", top: r.bottom + 6 + "px" });
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#imgMenu")) $("#imgMenu").hidden = true; });
  $("#imgFromFile").addEventListener("click", () => { $("#imgMenu").hidden = true; $("#imageFile").click(); });
  $("#imgFromGallery").addEventListener("click", () => {
    $("#imgMenu").hidden = true;
    window.ensureColumn("img");
    window.showToast("Klikněte na obrázek v Obrázkách a pak na „Vložit do rukopisu“.", 6000);
  });
  $("#imgFromCamera").addEventListener("click", openCamera);
  $("#camCancel").addEventListener("click", closeCamera);
  $("#camShot").addEventListener("click", async () => {
    const v = $("#camVideo");
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    closeCamera();
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.9));
    await insertImages([new File([blob], "foto.jpg", { type: "image/jpeg" })]);
  });
  $("#imageFile").addEventListener("change", async (e) => { await insertImages(e.target.files); e.target.value = ""; });
  $("#cameraFile").addEventListener("change", async (e) => { await insertImages(e.target.files); e.target.value = ""; });

  const zoomKey = "publisher.manuscript.zoom";
  let zoom = parseInt(localStorage.getItem(zoomKey) || "20", 10);
  const applyZoom = () => { editor.style.setProperty("--zoom", zoom + "px"); localStorage.setItem(zoomKey, zoom); };
  applyZoom();
  $("#msZoomIn").addEventListener("click", () => { zoom = Math.min(36, zoom + 2); applyZoom(); });
  $("#msZoomOut").addEventListener("click", () => { zoom = Math.max(14, zoom - 2); applyZoom(); });

  $("#msDesk").addEventListener("scroll", () => { clearTimeout(msState.spyTimer); msState.spyTimer = setTimeout(markCurrentHeading, 80); });
  const outlineKey = "publisher.outline";
  const setOutline = (open) => { $("#msOutline").classList.toggle("closed", !open); try { localStorage.setItem(outlineKey, open ? "1" : "0"); } catch (e) { /* ignore */ } };
  setOutline((localStorage.getItem(outlineKey) || "1") === "1");
  $("#outlineToggle").addEventListener("click", () => setOutline($("#msOutline").classList.contains("closed")));
  editor.addEventListener("input", () => { markDirty(); clearTimeout(msState.tocTimer); msState.tocTimer = setTimeout(refreshToc, 800); });
  editor.addEventListener("keyup", () => { rememberSelection(); updateToolbar(); });
  editor.addEventListener("mouseup", () => { rememberSelection(); updateToolbar(); });
  editor.addEventListener("click", (e) => selectImage(e.target.tagName === "IMG" ? e.target : null));

  editor.addEventListener("paste", async (e) => {
    const files = [...(e.clipboardData.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); await insertImages(files); return; }
    const html = e.clipboardData.getData("text/html");
    if (html) {
      e.preventDefault();
      const d = document.createElement("div");
      d.innerHTML = html;
      // images pasted as data: URLs get uploaded, foreign URLs are dropped
      for (const img of [...d.querySelectorAll("img")]) {
        const src = img.getAttribute("src") || "";
        if (src.startsWith("data:")) {
          const blob = await (await fetch(src)).blob();
          const url = await uploadImage(new File([blob], "paste", { type: blob.type }));
          if (url) img.setAttribute("src", url); else img.remove();
        } else if (!src.startsWith("books/") && !src.startsWith(location.origin + "books/")) {
          img.remove();
        }
      }
      exec("insertHTML", sanitize(d).innerHTML);
    }
  });
  editor.addEventListener("drop", async (e) => {
    const files = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    if (range) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(range); }
    await insertImages(files);
  });

  // image toolbar
  document.querySelectorAll("#imgBar [data-w]").forEach((b) => b.addEventListener("click", () => {
    if (!msState.selectedImg) return;
    msState.selectedImg.style.width = b.dataset.w + "%";
    markDirty();
  }));
  $("#imgCaption").addEventListener("click", async () => {
    const img = msState.selectedImg;
    if (!img) return;
    let fig = img.closest("figure");
    let cap = fig ? fig.querySelector("figcaption") : null;
    const srcSpan = cap ? cap.querySelector(".src") : null;
    const curSource = srcSpan ? srcSpan.textContent.replace(/^Zdroj:\s*/, "") : "";
    const curCaption = cap ? [...cap.childNodes].filter((n) => n !== srcSpan).map((n) => n.textContent).join("").trim() : "";
    const res = await window.editCaption({ caption: curCaption, source: curSource, image: img.src });
    if (!res) return;
    if (!fig) { fig = document.createElement("figure"); img.replaceWith(fig); fig.append(img); }
    if (!cap) { cap = document.createElement("figcaption"); fig.append(cap); }
    cap.innerHTML = captionHtml(res.caption, res.source);
    markDirty();
  });
  $("#imgCrop").addEventListener("click", () => { if (msState.selectedImg) openCrop(msState.selectedImg); });
  $("#imgDelete").addEventListener("click", () => {
    const img = msState.selectedImg;
    if (!img || !confirm("Odstranit obrázek z textu?\n(Lze vrátit tlačítkem Zpět nebo z historie.)")) return;
    (img.closest("figure") || img).remove();
    selectImage(null);
    markDirty();
  });

  $("#printBtn").addEventListener("click", async () => { await save(); window.open("api/manuscript/export", "_blank"); });
  $("#snapshotBtn").addEventListener("click", async () => {
    const label = prompt("Pojmenujte verzi (např. „hotová kapitola 2“):", "");
    if (label === null) return;
    await save();
    await fetch("api/manuscript/snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: label || "verze" }) });
    toast("Verze uložena do historie.");
  });
  $("#historyBtn").addEventListener("click", openHistory);
  $("#historyClose").addEventListener("click", () => { $("#historyDlg").hidden = true; });
  $("#histRestore").addEventListener("click", restoreVersion);

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); msState.dirty = true; save(); }
    if (e.key === "Escape") { $("#historyDlg").hidden = true; selectImage(null); }
  });
  window.addEventListener("beforeunload", (e) => { if (msState.dirty) { save(); e.preventDefault(); } });
  document.addEventListener("visibilitychange", () => { if (document.hidden) save(); else loadClips(); });
  setInterval(() => { if (msState.dirty) save(); }, 20000);
  setInterval(loadClips, 3000);

  $("#msTitle").addEventListener("input", (e) => { msState.title = e.target.value; editor.dataset.title = e.target.value; markDirty(); });
  $("#msDrawerBtn").addEventListener("click", () => { $("#msDrawer").hidden = !$("#msDrawer").hidden; });
  editor.addEventListener("blur", () => { rememberSelection(); setTimeout(showInsertMark, 0); });
  editor.addEventListener("focus", () => { $("#insertMark").hidden = true; });
  $("#msDesk").addEventListener("scroll", () => { if (!$("#insertMark").hidden) showInsertMark(); });
  window.addEventListener("resize", showInsertMark);

  initCrop();
  load().then(loadClips);
}

function captionHtml(caption, source) {
  return escapeHtml(caption || "") + (source ? `<span class="src">Zdroj: ${escapeHtml(source)}</span>` : "");
}

function scrollToImage(index) {
  const img = editor.querySelectorAll("img")[index];
  if (!img) return;
  img.scrollIntoView({ behavior: "smooth", block: "center" });
  selectImage(img);
}

// API for the rest of the workspace
window.MS = {
  visible: () => !$("#colMs").hidden,
  insertHtml: (html, message) => insertBlockHtml(html, message),
  insertImage: (src, caption, message, source) => insertBlockHtml(
    `<figure><img src="${src}" style="width:100%"><figcaption>${captionHtml(caption, source)}</figcaption></figure>`, message),
  scrollToImage: (i) => scrollToImage(i),
  uploadDataUrl: async (data) => {
    const res = await fetch("api/manuscript/images", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || res.status);
    return out.src;
  },
  scrollToMatch: (terms, k) => scrollToMatch(terms, k),
  refreshMark: () => showInsertMark(),
  save: () => save(),
};

init();
})();
