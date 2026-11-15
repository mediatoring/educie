// Publisher – scan / text editor
"use strict";

// redirect to the login page whenever the session expires
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await nativeFetch(...args);
  if (res.status === 401) { location.href = "login.html"; throw new Error("login required"); }
  return res;
};
nativeFetch("api/me").then((r) => {
  if (r.status === 404) { document.getElementById("oldServer").hidden = false; return null; }
  return r.json();
}).then((me) => {
  if (!me || !me.auth) return;
  const a = document.createElement("a");
  a.href = "logout"; a.className = "logout"; a.textContent = "Odhlásit";
  a.title = "Přihlášen: " + me.user;
  document.querySelector(".main-head").append(a);
}).catch(() => {});

const state = {
  cols: [],
  cropTarget: null,
  bookId: null,
  project: null,
  pageIndex: 0,
  selectedBlockId: null,
  zoom: 1,          // 1 = fit width
  cropMode: false,
  recropBlockId: null,
  dirty: false,
  saveTimer: null,
  scanCache: {},    // full-resolution images for cropping
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
};
const newId = () => Math.random().toString(16).slice(2, 10);
const bookUrl = (path) => `books/${encodeURIComponent(state.bookId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
const currentPage = () => state.project.pages[state.pageIndex];

function showToast(msg, ms = 2600, undo = null) {
  const t = $("#toast");
  $("#toastText").textContent = msg;
  const btn = $("#toastUndo");
  btn.hidden = !undo;
  btn.onclick = undo ? () => { undo(); t.classList.remove("show"); } : null;
  t.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => t.classList.remove("show"), ms || 2600);
}
window.showToast = showToast;
const toast = (msg) => showToast(msg);

// ---------- loading & saving ----------

async function loadBooks() {
  const books = await (await fetch("api/books")).json();
  const sel = $("#bookSelect");
  sel.innerHTML = "";
  for (const b of books) {
    const t = b.title.length > 48 ? b.title.slice(0, 46).replace(/\s+\S*$/, "") + "…" : b.title;
    sel.append(el("option", { value: b.id, title: b.title }, `${t} (${b.pages} str.)`));
  }
  if (!books.length) {
    $("#blocks").innerHTML = '<div class="empty">Ve složce publisher není žádná kniha s project.json.</div>';
    return;
  }
  const wanted = decodeURIComponent(location.hash.slice(1)) || localStorage.getItem("publisher.book");
  const first = books.find((b) => b.id === wanted) ? wanted : books[0].id;
  sel.value = first;
  await openBook(first);
}

async function openBook(id) {
  if (state.dirty) await save();
  state.bookId = id;
  localStorage.setItem("publisher.book", id);
  // the address shows the source book only inside the work view; the bare address stays the home screen
  if (new URLSearchParams(location.search).has("open")) history.replaceState(null, "", location.pathname + location.search + "#" + encodeURIComponent(id));
  state.project = await (await fetch(`api/books/${encodeURIComponent(id)}`)).json();
  state.scanCache = {};
  setTimeout(() => watchOcr(id), 50);
  const savedPage = parseInt(localStorage.getItem(`publisher.page.${id}`) || "0", 10);
  state.pageIndex = Math.min(savedPage, state.project.pages.length - 1);
  const params = new URLSearchParams(location.search);
  if (params.has("page")) {
    state.pageIndex = Math.min(parseInt(params.get("page"), 10) || 0, state.project.pages.length - 1);
    state.selectedBlockId = params.get("block");
    history.replaceState(null, "", location.pathname + "?open=1#" + encodeURIComponent(id));
    setTimeout(() => { const n = document.querySelector(`.block[data-id="${state.selectedBlockId}"]`); if (n) n.scrollIntoView({ block: "center" }); }, 300);
  }
  $("#bookTitle").value = state.project.title || id;
  document.querySelectorAll(".tr-only").forEach((n) => { n.style.display = state.project.lang ? "" : "none"; });
  setSaveState("uloženo");
  renderAll();
}

function markDirty() {
  state.dirty = true;
  setSaveState("neuloženo…", "dirty");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, 1500);
}

async function save() {
  clearTimeout(state.saveTimer);
  if (!state.dirty || !state.project) return;
  if (state.ocrRunning) { setSaveState("čeká na dočtení textu", "dirty"); return; }
  state.dirty = false;
  setSaveState("ukládám…", "dirty");
  try {
    const res = await fetch(`api/books/${encodeURIComponent(state.bookId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.project),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    setSaveState(`uloženo ${data.saved}`);
  } catch (e) {
    state.dirty = true;
    setSaveState("chyba ukládání!", "error");
    toast("Uložení selhalo: " + e.message);
  }
}

function setSaveState(text, cls = "") {
  const s = $("#saveState");
  s.textContent = text;
  s.className = "save-state " + cls;
}

// ---------- rendering ----------

function renderAll() {
  renderPageList();
  renderPage();
}

function renderPageList() {
  const list = $("#pageList");
  list.innerHTML = "";
  state.project.pages.forEach((page, i) => {
    const thumb = el("div", {
      class: "page-thumb" + (i === state.pageIndex ? " current" : "") + (page.skip ? " skipped" : ""),
      draggable: "true",
      "data-index": i,
    },
      el("img", { src: bookUrl(page.preview), loading: "lazy", alt: "" }),
      !pageHasText(page) && !page.image_only ? el("span", { class: "thumb-badge", title: "Na straně není přečtený text" }, "bez textu") : null,
      el("div", { class: "lbl" }, el("span", {}, `${i + 1}.`), el("span", {}, page.page_no ? `s. ${page.page_no}` : page.id)));
    thumb.addEventListener("click", () => goToPage(i));
    // reorder pages
    thumb.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/page", String(i));
      e.dataTransfer.effectAllowed = "move";
    });
    thumb.addEventListener("dragover", (e) => {
      const types = e.dataTransfer.types;
      if (types.includes("text/page")) {
        e.preventDefault();
        const r = thumb.getBoundingClientRect();
        const top = e.clientY < r.top + r.height / 2;
        thumb.classList.toggle("drag-over-top", top);
        thumb.classList.toggle("drag-over-bottom", !top);
      } else if (types.includes("text/block")) {
        e.preventDefault();
        thumb.classList.add("drop-target");
      }
    });
    thumb.addEventListener("dragleave", () => thumb.classList.remove("drag-over-top", "drag-over-bottom", "drop-target"));
    thumb.addEventListener("drop", (e) => {
      e.preventDefault();
      thumb.classList.remove("drag-over-top", "drag-over-bottom", "drop-target");
      const pageFrom = e.dataTransfer.getData("text/page");
      const blockId = e.dataTransfer.getData("text/block");
      if (pageFrom !== "") {
        const r = thumb.getBoundingClientRect();
        movePage(parseInt(pageFrom, 10), i, e.clientY >= r.top + r.height / 2);
      } else if (blockId) {
        moveBlockToPage(blockId, i);
      }
    });
    list.append(thumb);
  });
  const cur = list.querySelector(".current");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

function renderPage() {
  const page = currentPage();
  if (!page) return;
  localStorage.setItem(`publisher.page.${state.bookId}`, String(state.pageIndex));
  $("#pageInfo").textContent = `${state.pageIndex + 1} / ${state.project.pages.length}`;
  $("#pageNoLabel").textContent = page.page_no ? `s. ${page.page_no}` : "";
  $("#pageNo").value = page.page_no ?? "";
  $("#pageSkip").checked = !!page.skip;
  const img = $("#scanImg");
  const url = bookUrl(page.preview);  // includes the book id – the same page name exists in every book
  if (img.dataset.src !== url) {
    img.dataset.src = url;
    img.src = url;
  }
  applyZoom();
  renderOverlay();
  renderBlocks();
}

function applyZoom() {
  const viewer = $("#viewer");
  if (!state.project) return;
  const page = currentPage();
  const avail = viewer.clientWidth - 20;
  const fitHeightRatio = (viewer.clientHeight - 20) / page.size[1] * page.size[0] / avail;
  const base = Math.min(1, Math.max(fitHeightRatio, 0.5));
  $("#scanBox").style.width = Math.round(avail * base * state.zoom) + "px";
}

const pageById = (id) => state.project.pages.find((p) => p.id === id);
const sourcePage = (b) => pageById(b.origin) || currentPage();

function placeRect(node, crop, rotate, page) {
  const [W, H] = page.size;
  const [x, y, w, h] = crop;
  Object.assign(node.style, {
    left: x / W * 100 + "%", top: y / H * 100 + "%", width: w / W * 100 + "%", height: h / H * 100 + "%",
    transform: rotate ? `rotate(${-rotate}deg)` : "",
  });
}

function renderOverlay() {
  const page = currentPage();
  const overlay = $("#overlay");
  overlay.innerHTML = "";
  // image blocks whose crop comes from this scan (also blocks moved to other pages)
  state.project.pages.forEach((p) => p.blocks.forEach((b, idx) => {
    if (b.type !== "image" || !b.crop) return;
    if ((b.origin || p.id) !== page.id) return;
    const selected = b.id === state.selectedBlockId;
    const label = p === page ? `obr. ${imageNumber(p, idx)}` : `obr. → str. ${state.project.pages.indexOf(p) + 1}`;
    const r = el("div", { class: "crop-rect" + (selected ? " hl" : ""), "data-id": b.id }, el("span", {}, label));
    placeRect(r, b.crop, b.rotate, page);
    if (selected && p === page) {
      for (const h of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) r.append(el("i", { class: "hd hd-" + h, "data-h": h }));
      r.classList.add("editable");
      r.addEventListener("mousedown", (e) => startRectDrag(e, b, r));
    } else {
      r.addEventListener("mousedown", (e) => { if (!state.cropMode) e.stopPropagation(); });
      r.addEventListener("click", () => {
        if (state.cropMode) return;
        if (p === page) selectBlock(b.id, true);
        else { goToPage(state.project.pages.indexOf(p)); selectBlock(b.id, true); }
      });
    }
    overlay.append(r);
  }));
}

// move / resize the selected crop rectangle directly on the scan
function startRectDrag(e, b, node) {
  if (state.cropMode || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const page = currentPage();
  const box = $("#scanBox").getBoundingClientRect();
  const k = page.size[0] / box.width;
  const handle = e.target.dataset.h || "move";
  const start = { x: e.clientX, y: e.clientY, crop: [...b.crop] };
  const [W, H] = page.size;
  const onMove = (ev) => {
    const dx = (ev.clientX - start.x) * k;
    const dy = (ev.clientY - start.y) * k;
    let [x, y, w, h] = start.crop;
    if (handle === "move") { x += dx; y += dy; }
    if (handle.includes("w")) { x += dx; w -= dx; }
    if (handle.includes("e")) { w += dx; }
    if (handle.includes("n")) { y += dy; h -= dy; }
    if (handle.includes("s")) { h += dy; }
    if (w < 20) { if (handle.includes("w")) x -= 20 - w; w = 20; }
    if (h < 20) { if (handle.includes("n")) y -= 20 - h; h = 20; }
    x = Math.max(0, Math.min(x, W - w));
    y = Math.max(0, Math.min(y, H - h));
    b.crop = [x, y, w, h].map(Math.round);
    placeRect(node, b.crop, b.rotate, page);
  };
  const onUp = async () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (b.crop.join() === start.crop.join()) return;
    await updateImage(b);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

// render the crop (with rotation) from the full-resolution scan
async function renderCrop(b) {
  const img = await loadFullScan(sourcePage(b));
  const [x, y, w, h] = b.crop;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((b.rotate || 0) * Math.PI / 180);
  ctx.drawImage(img, -(x + w / 2), -(y + h / 2));
  return canvas;
}

async function rotatedQuarter(b, dir) {
  b.quarter = (((b.quarter || 0) + dir) % 4 + 4) % 4;
  await updateImage(b);
}

async function finalCanvas(b) {
  let canvas = await renderCrop(b);
  const q = b.quarter || 0;
  if (q) {
    const out = document.createElement("canvas");
    out.width = q % 2 ? canvas.height : canvas.width;
    out.height = q % 2 ? canvas.width : canvas.height;
    const ctx = out.getContext("2d");
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(q * Math.PI / 2);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    canvas = out;
  }
  return canvas;
}

// re-render and upload the image of an existing block
async function updateImage(b) {
  setSaveState("vyřezávám…", "dirty");
  const canvas = await finalCanvas(b);
  const name = b.src.split("/").pop();
  const res = await fetch(`api/images/${encodeURIComponent(state.bookId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data: canvas.toDataURL("image/jpeg", 0.92) }),
  });
  if (!res.ok) { toast("Obrázek se nepodařilo uložit."); return; }
  b.v = (b.v || 0) + 1;
  markDirty();
  const img = document.querySelector(`.block[data-id="${b.id}"] img.pic`);
  if (img) img.src = bookUrl(b.src) + "?v=" + b.v;
}

function imageNumber(page, idx) {
  return page.blocks.slice(0, idx + 1).filter((b) => b.type === "image").length;
}

function renderBlocks() {
  setTimeout(refreshFormatBar, 0);
  const page = currentPage();
  const box = $("#blocks");
  const scroll = box.scrollTop;
  box.innerHTML = "";
  if (!pageHasText(page) && !page.image_only) {
    box.append(el("div", { class: "no-text-warn" },
      el("b", {}, "Na této straně se text nepodařilo přečíst."),
      " Může jít o ručně psaný text, fotografii nebo tabulku. Přepište text ručně tlačítkem + Odstavec dole, nebo stranu označte jako obrázek.",
      el("div", {},
        el("button", { onclick: () => { page.image_only = true; markDirty(); renderAll(); } }, "Je to jen obrázek nebo tabulka"))));
  }
  if (!page.blocks.length) box.append(el("div", { class: "empty" }, "Strana zatím nemá žádný obsah."));
  page.blocks.forEach((b, idx) => box.append(renderBlock(b, idx)));
  box.scrollTop = scroll;
}

function restoreOriginal(b) {
  if (!b.orig) { toast("Odstavec ještě nebyl upraven."); return; }
  const before = { html: b.html, tr: b.tr };
  for (const f of Object.keys(b.orig)) b[f] = b.orig[f];
  markDirty();
  renderBlocks();
  toast("Odstavec vrácen do původní podoby.", 8000, () => { Object.assign(b, before); markDirty(); renderBlocks(); });
}

function pageHasText(page) {
  return page.blocks.some((b) => b.type === "text" && (b.html || b.tr || "").replace(/<[^>]+>/g, "").trim());
}

function renderBlock(b, idx) {
  const page = currentPage();
  const node = el("div", { class: `block ${b.type}` + (b.id === state.selectedBlockId ? " selected" : ""), "data-id": b.id });
  const handle = el("span", { class: "handle", draggable: "true", title: "Táhni: přesun v rámci strany, nebo na náhled jiné strany vlevo" }, "⠿");
  handle.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/block", b.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setDragImage(node, 10, 10);
    node.classList.add("dragging");
  });
  handle.addEventListener("dragend", () => node.classList.remove("dragging"));
  node.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("text/block")) return;
    e.preventDefault();
    const r = node.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    node.classList.toggle("drop-before", before);
    node.classList.toggle("drop-after", !before);
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop-before", "drop-after"));
  node.addEventListener("drop", (e) => {
    e.preventDefault();
    const before = node.classList.contains("drop-before");
    node.classList.remove("drop-before", "drop-after");
    const id = e.dataTransfer.getData("text/block");
    if (id && id !== b.id) moveBlockWithinPage(id, b.id, before);
  });
  node.addEventListener("mousedown", () => selectBlock(b.id));

  const pageOptions = el("select", { title: "Přesunout na stranu" }, el("option", { value: "" }, "→ strana…"));
  state.project.pages.forEach((p, i) => {
    if (i !== state.pageIndex) pageOptions.append(el("option", { value: i }, `${i + 1}${p.page_no ? " (s. " + p.page_no + ")" : ""}`));
  });
  pageOptions.addEventListener("change", () => { if (pageOptions.value !== "") moveBlockToPage(b.id, parseInt(pageOptions.value, 10)); });

  if (b.orig && Object.keys(b.orig).some((f) => b.orig[f] !== b[f])) node.classList.add("edited");
  const restoreBtn = b.type === "text" ? el("button", { class: "restore-orig", title: "Vrátit text tohoto odstavce do podoby před vašimi úpravami", onclick: () => restoreOriginal(b) }, "↺ původní text") : null;
  const tools = el("div", { class: "tools" },
    restoreBtn,
    el("button", { title: "Nahoru", onclick: () => shiftBlock(b.id, -1) }, "↑"),
    el("button", { title: "Dolů", onclick: () => shiftBlock(b.id, 1) }, "↓"),
    pageOptions,
    b.type === "text" ? el("button", { title: "Spojit s předchozím textem (i z předchozí strany)", onclick: () => mergeWithPrevious(b.id) }, "⤒ spojit") : null,
    b.type === "image" ? el("button", { title: "Vyříznout znovu ze skenu", onclick: () => startRecrop(b.id) }, "✂ znovu") : null,

    el("button", { title: "Smazat blok", onclick: () => deleteBlock(b.id) }, "✕"));

  if (b.type === "text") {
    const makeEditor = (field, lang, label) => {
      const ed = el("div", { class: "text", contenteditable: "true", spellcheck: "true", lang, "data-style": b.style || "p", "data-field": field });
      ed.innerHTML = b[field] || "";
      applyBlockStyle(ed, b);
      const initial = b[field] || "";
      ed.addEventListener("input", () => {
        // keep the text as it was before the first change, so it can be brought back
        if (!b.orig || b.orig[field] === undefined) { b.orig = { ...(b.orig || {}), [field]: initial }; node.classList.add("edited"); }
        b[field] = cleanHtml(ed.innerHTML);
        markDirty();
      });
      ed.addEventListener("paste", (e) => {
        e.preventDefault();
        document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
      });
      ed.addEventListener("focus", () => selectBlock(b.id));
      if (!label) return ed;
      return el("div", { class: "lang-row lang-" + field }, el("span", { class: "lang-tag" }, label), ed);
    };
    const srcLang = state.project.lang;
    if (srcLang) {
      const view = state.view || "both";
      const parts = [];
      if (view !== "tr") parts.push(makeEditor("html", srcLang, srcLang.toUpperCase()));
      if (view !== "orig") parts.push(makeEditor("tr", "cs", "CS"));
      node.append(handle, tools, ...parts, blockActions(b));
    } else {
      node.append(handle, tools, makeEditor("html", "cs"), blockActions(b));
    }
  } else {
    const img = el("img", { class: "pic", src: bookUrl(b.src) + "?v=" + (b.v || 0), alt: "" });
    img.style.width = (b.width || 100) + "%";
    const frame = el("div", { class: "pic-frame" }, img);
    const cap = el("input", { class: "caption", placeholder: "Popisek obrázku…", value: b.caption || "" });
    cap.addEventListener("input", () => { b.caption = cap.value; markDirty(); });
    const srcIn = el("input", { class: "caption source", placeholder: "Zdroj (výchozí: " + sourceLabel(page) + ")", value: b.source || "" });
    srcIn.addEventListener("input", () => { b.source = srcIn.value || undefined; markDirty(); });

    // straightening: fine rotation with live preview, upload on release
    const angle = el("input", { type: "range", min: "-15", max: "15", step: "0.1", value: b.rotate || 0, title: "Narovnat (stupně)" });
    const angleNum = el("input", { type: "number", min: "-45", max: "45", step: "0.1", value: b.rotate || 0, class: "num" });
    let previewTimer = null;
    const preview = (v) => {
      b.rotate = Math.round(v * 10) / 10 || 0;
      angle.value = b.rotate;
      angleNum.value = b.rotate;
      frame.classList.add("grid");
      const rect = document.querySelector(`.crop-rect[data-id="${b.id}"]`);
      if (rect && b.crop) placeRect(rect, b.crop, b.rotate, sourcePage(b));
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        const c = await finalCanvas(b);
        img.src = c.toDataURL("image/jpeg", 0.8);
      }, 60);
    };
    const commit = async () => { frame.classList.remove("grid"); if (b.crop) await updateImage(b); };
    angle.addEventListener("input", () => preview(parseFloat(angle.value)));
    angle.addEventListener("change", commit);
    angleNum.addEventListener("change", () => { preview(parseFloat(angleNum.value) || 0); commit(); });

    const size = el("select", { title: "Velikost obrázku v knize" });
    for (const v of [25, 33, 50, 66, 75, 100]) size.append(el("option", { value: v }, `${v} %`));
    size.value = String(b.width || 100);
    size.addEventListener("change", () => {
      b.width = parseInt(size.value, 10);
      if (b.width === 100) delete b.width;
      img.style.width = (b.width || 100) + "%";
      markDirty();
    });

    const controls = el("div", { class: "img-controls" },
      el("span", {}, "Narovnat"), angle, angleNum, el("span", {}, "°"),
      el("button", { title: "Otočit o 90° doleva", onclick: () => rotatedQuarter(b, -1) }, "⟲ 90°"),
      el("button", { title: "Otočit o 90° doprava", onclick: () => rotatedQuarter(b, 1) }, "⟳ 90°"),
      el("span", { class: "sep" }, "Velikost"), size);
    if (!b.crop) controls.querySelectorAll("input,button").forEach((n) => { n.disabled = true; });

    node.append(handle, tools,
      el("div", { class: "img-label" }, `Obrázek ${imageNumber(page, idx)}` + (b.crop ? " · rozměr upravíš tažením rámečku na skenu" : "")),
      frame, controls, cap, srcIn, blockActions(b));
  }
  return node;
}

const FONT_CSS = { serif: "Georgia, serif", book: "'Times New Roman', serif", palatino: "Palatino, serif", sans: "Helvetica, Arial, sans-serif" };
const SIZE_CSS = { s: ".85em", l: "1.2em", xl: "1.45em" };

function applyBlockStyle(ed, b) {
  ed.dataset.style = b.style || "p";
  ed.style.textAlign = b.align || "";
  ed.style.fontFamily = FONT_CSS[b.font] || "";
  ed.style.fontSize = SIZE_CSS[b.size] || "";
}

function selectedBlock() {
  const f = state.selectedBlockId ? findBlock(state.selectedBlockId) : null;
  return f ? f.block : null;
}

function refreshFormatBar() {
  const b = selectedBlock();
  const bar = $("#fmtBar");
  const isText = b && b.type === "text";
  bar.classList.toggle("disabled", !isText);
  bar.querySelectorAll("button, select").forEach((n) => { n.disabled = !isText && !n.classList.contains("send-any"); });
  if (!isText) return;
  $("#fmtStyle").value = b.style || "p";
  $("#fmtFont").value = b.font || "";
  $("#fmtSize").value = b.size || "";
  bar.querySelectorAll("[data-align]").forEach((n) => n.classList.toggle("on", (b.align || "") === n.dataset.align));
}

function setBlockProp(prop, value) {
  const b = selectedBlock();
  if (!b || b.type !== "text") return;
  if (value) b[prop] = value; else delete b[prop];
  document.querySelectorAll(`.block[data-id="${b.id}"] .text`).forEach((ed) => applyBlockStyle(ed, b));
  markDirty();
  refreshFormatBar();
}

function sourceLabel(page) {
  const short = (state.project.title || state.bookId).replace(/\s*\(.*\)\s*$/, "");
  return `${short}${page && page.page_no ? ", s. " + page.page_no : ""}`;
}

const escHtml = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function copyImageToManuscript(src) {
  const res = await fetch("api/manuscript/copy-image", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ book: state.bookId, src }),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || res.status);
  return out.src;
}

async function sendToManuscript(b, kind) {
  const found = findBlock(b.id);
  const page = found ? state.project.pages[found.pi] : currentPage();
  let source = sourceLabel(page);
  try {
    if (window.MS && MS.visible()) {
      if (b.type === "image") {
        const src = await copyImageToManuscript(b.src);
        MS.insertImage(src, b.caption || "", "Obrázek vložen do rukopisu.", b.source || source);
        return;
      }
      const useTr = state.project.lang && (state.view || "both") !== "orig" && b.tr;
      const body = useTr ? b.tr : b.html;
      if (useTr) source += " (překlad)";
      if (kind === "quote") MS.insertHtml(`<blockquote><p>${body}</p><p class="cite">(${escHtml(source)})</p></blockquote>`, "Citace vložena do rukopisu.");
      else MS.insertHtml(`<p>${body}</p>`, "Odstavec vložen do rukopisu.");
      return;
    }
    let payload;
    if (b.type === "image") {
      payload = { kind: "image", book: state.bookId, src: b.src, caption: b.caption || "", width: b.width || 100, source, image_source: b.source || source };
    } else {
      const useTr = state.project.lang && (state.view || "both") !== "orig" && b.tr;
      payload = { kind, html: useTr ? b.tr : b.html, source: useTr ? source + " (překlad)" : source };
    }
    const res = await fetch("api/clips", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(res.status);
    toast("Uloženo do schránky rukopisu ✓ (rukopis je skrytý)");
  } catch (e) {
    toast("Přenos do rukopisu se nepovedl: " + e.message);
  }
}

async function cropToManuscript(page, crop) {
  const img = await loadFullScan(page);
  const [x, y, w, h] = crop;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(img, x, y, w, h, 0, 0, w, h);
  try {
    const src = await MS.uploadDataUrl(canvas.toDataURL("image/jpeg", 0.92));
    MS.insertImage(src, "", "Výřez vložen do rukopisu. Narovnat ho můžete tlačítkem Oříznout v rukopisu.", sourceLabel(page));
  } catch (e) {
    toast("Výřez se nepodařilo uložit: " + e.message);
  }
}

async function pageToManuscript() {
  const page = currentPage();
  try {
    const src = await copyImageToManuscript(page.scan);
    MS.insertImage(src, "", "Celá strana vložena do rukopisu.", sourceLabel(page));
  } catch (e) {
    toast("Stranu se nepodařilo vložit: " + e.message);
  }
}

function svgIcon(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", "ico");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", "#i-" + name);
  s.append(u);
  return s;
}

function blockActions(b) {
  // one button: text always goes to the manuscript as a quotation with its source
  return el("div", { class: "block-actions" },
    el("button", { class: "act", title: b.type === "image" ? "Vložit obrázek do rukopisu na označené místo" : "Vložit do rukopisu jako citaci s uvedením zdroje", onclick: () => sendToManuscript(b, b.type === "image" ? "text" : "quote") },
      b.type === "image" ? "➜ Obrázek do rukopisu" : "➜ Do rukopisu"));
}

function cleanHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const allowed = new Set(["B", "STRONG", "I", "EM", "SUP", "SUB", "BR", "U"]);
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        walk(child);
        if (!allowed.has(child.tagName)) {
          if (child.tagName === "DIV" || child.tagName === "P") child.before(document.createElement("br"));
          child.replaceWith(...child.childNodes);
        } else {
          for (const a of [...child.attributes]) child.removeAttribute(a.name);
        }
      } else if (child.nodeType !== 3) {
        child.remove();
      }
    }
  };
  walk(tmp);
  return tmp.innerHTML;
}

// ---------- actions ----------

function goToPage(i) {
  if (i < 0 || i >= state.project.pages.length) return;
  state.pageIndex = i;
  state.selectedBlockId = null;
  $("#blocks").scrollTop = 0;
  $("#viewer").scrollTop = 0;
  renderAll();
}

function selectBlock(id, scrollTo = false) {
  if (state.selectedBlockId === id) return;
  state.selectedBlockId = id;
  document.querySelectorAll(".block").forEach((n) => n.classList.toggle("selected", n.dataset.id === id));
  renderOverlay();
  refreshFormatBar();
  if (scrollTo) {
    const n = document.querySelector(`.block[data-id="${id}"]`);
    if (n) n.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function findBlock(id) {
  for (let pi = 0; pi < state.project.pages.length; pi++) {
    const bi = state.project.pages[pi].blocks.findIndex((b) => b.id === id);
    if (bi >= 0) return { pi, bi, block: state.project.pages[pi].blocks[bi] };
  }
  return null;
}

function shiftBlock(id, dir) {
  const blocks = currentPage().blocks;
  const i = blocks.findIndex((b) => b.id === id);
  const j = i + dir;
  if (j < 0 || j >= blocks.length) return;
  [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  markDirty();
  renderPage();
}

function moveBlockWithinPage(id, targetId, before) {
  const src = findBlock(id);
  if (!src) return;
  const [block] = state.project.pages[src.pi].blocks.splice(src.bi, 1);
  const blocks = currentPage().blocks;
  let ti = blocks.findIndex((b) => b.id === targetId);
  if (!before) ti += 1;
  blocks.splice(ti, 0, block);
  markDirty();
  renderAll();
}

function moveBlockToPage(id, pageIndex) {
  const src = findBlock(id);
  if (!src || src.pi === pageIndex) return;
  const [block] = state.project.pages[src.pi].blocks.splice(src.bi, 1);
  if (block.type === "image" && block.crop && !block.origin) block.origin = state.project.pages[src.pi].id;
  state.project.pages[pageIndex].blocks.push(block);
  markDirty();
  renderAll();
  toast(`Blok přesunut na stranu ${pageIndex + 1} (na konec).`);
}

function movePage(from, to, after) {
  const pages = state.project.pages;
  const current = pages[state.pageIndex];
  const [p] = pages.splice(from, 1);
  let target = to > from ? to - 1 : to;
  if (after) target += 1;
  pages.splice(target, 0, p);
  state.pageIndex = pages.indexOf(current);
  markDirty();
  renderAll();
}

function deleteBlock(id) {
  const src = findBlock(id);
  if (!src) return;
  const b = src.block;
  const preview = b.type === "text" ? b.html.replace(/<[^>]+>/g, "").slice(0, 80) : "obrázek";
  if (!confirm(`Smazat blok „${preview}…“?`)) return;
  state.project.pages[src.pi].blocks.splice(src.bi, 1);
  markDirty();
  renderPage();
}

function mergeWithPrevious(id) {
  const src = findBlock(id);
  if (!src) return;
  // previous text block on this page, or the last text block of the previous page
  let target = null;
  for (let i = src.bi - 1; i >= 0 && !target; i--) {
    if (state.project.pages[src.pi].blocks[i].type === "text") target = state.project.pages[src.pi].blocks[i];
  }
  for (let pi = src.pi - 1; pi >= 0 && !target; pi--) {
    const blocks = state.project.pages[pi].blocks;
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].type === "text") { target = blocks[i]; break; }
  }
  if (!target) return toast("Není s čím spojit.");
  let left = target.html.replace(/\s+$/, "");
  const right = src.block.html.replace(/^\s+/, "");
  if (/[A-Za-zÀ-ž]-$/.test(left)) left = left.slice(0, -1) + right;   // hyphenated word across pages
  else left = left + " " + right;
  target.html = left;
  if (target.tr !== undefined || src.block.tr !== undefined) {
    const l = (target.tr || "").replace(/\s+$/, "");
    const r = (src.block.tr || "").replace(/^\s+/, "");
    target.tr = /[A-Za-zÀ-ž]-$/.test(l) ? l.slice(0, -1) + r : (l + " " + r).trim();
  }
  state.project.pages[src.pi].blocks.splice(src.bi, 1);
  markDirty();
  renderPage();
  toast("Text spojen s předchozím odstavcem.");
}

function addTextBlock(style) {
  const page = currentPage();
  const block = { id: newId(), type: "text", html: "", style: style === "p" ? undefined : style };
  if (state.project.lang) block.tr = "";
  const i = page.blocks.findIndex((b) => b.id === state.selectedBlockId);
  page.blocks.splice(i >= 0 ? i + 1 : page.blocks.length, 0, block);
  state.selectedBlockId = block.id;
  markDirty();
  renderPage();
  const n = document.querySelector(`.block[data-id="${block.id}"] .text`);
  if (n) n.focus();
}

// ---------- cropping ----------

function setCropMode(on, recropId = null, target = "text") {
  state.cropMode = on;
  state.cropTarget = on ? target : null;
  state.recropBlockId = on ? recropId : null;
  $("#cropBtn").classList.toggle("active", on && target === "text");
  $("#cropMsBtn").classList.toggle("active", on && target === "ms");
  $("#viewer").classList.toggle("crop-mode", on);
  if (on) toast(recropId ? "Tažením na skenu vyznač nový výřez obrázku." : "Tažením na skenu vyznač obrázek. Esc = zrušit.");
}

function startRecrop(id) {
  selectBlock(id);
  setCropMode(true, id);
}

function initCropping() {
  const box = $("#scanBox");
  let start = null;
  let rect = null;
  const pos = (e) => {
    const r = box.getBoundingClientRect();
    return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height), r };
  };
  box.addEventListener("mousedown", (e) => {
    if (!state.cropMode || e.button !== 0) return;
    e.preventDefault();
    start = pos(e);
    rect = el("div", { class: "drawing" });
    $("#overlay").append(rect);
  });
  window.addEventListener("mousemove", (e) => {
    if (!start) return;
    const p = pos(e);
    Object.assign(rect.style, {
      left: Math.min(start.x, p.x) + "px", top: Math.min(start.y, p.y) + "px",
      width: Math.abs(p.x - start.x) + "px", height: Math.abs(p.y - start.y) + "px",
    });
  });
  window.addEventListener("mouseup", async (e) => {
    if (!start) return;
    const p = pos(e);
    const s = start;
    start = null;
    rect.remove();
    if (Math.abs(p.x - s.x) < 8 || Math.abs(p.y - s.y) < 8) return;
    const page = currentPage();
    const k = page.size[0] / p.r.width;
    const crop = [Math.min(s.x, p.x), Math.min(s.y, p.y), Math.abs(p.x - s.x), Math.abs(p.y - s.y)].map((v) => Math.round(v * k));
    if (state.cropTarget === "ms") await cropToManuscript(page, crop);
    else await createCrop(page, crop, state.recropBlockId);
    setCropMode(false);
  });
}

function loadFullScan(page) {
  if (!state.scanCache[page.id]) {
    state.scanCache[page.id] = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = bookUrl(page.scan);
    });
  }
  return state.scanCache[page.id];
}

async function createCrop(page, crop, replaceId) {
  let block = replaceId ? findBlock(replaceId)?.block : null;
  if (block) {
    block.crop = crop;
    if (findPageOf(block) === page) delete block.origin;
    else block.origin = page.id;
    await updateImage(block);
  } else {
    block = { id: newId(), type: "image", src: `images/${page.id}_${newId()}.jpg`, crop, caption: "" };
    const blocks = page.blocks;
    const sel = blocks.findIndex((b) => b.id === state.selectedBlockId);
    blocks.splice(sel >= 0 ? sel + 1 : blocks.length, 0, block);
    await updateImage(block);
  }
  state.selectedBlockId = block.id;
  markDirty();
  renderPage();
  toast("Hotovo. Rámeček na skenu můžeš posunout nebo roztáhnout, obrázek narovnat vpravo.");
}

function findPageOf(block) {
  return state.project.pages.find((p) => p.blocks.includes(block));
}

// ---------- helpers used by the gallery ----------
function whoText(w) {
  if (!w) return "";
  return [w.user, w.ip, w.dev, w.fp ? "zařízení " + w.fp.slice(0, 6) : ""].filter(Boolean).join(" · ");
}
window.whoText = whoText;
async function openBookHistory() {
  if (state.dirty) await save();
  const list = await fetch(`api/books/${encodeURIComponent(state.bookId)}/history`).then((r) => r.json());
  const box = $("#bookHistList");
  box.innerHTML = list.length ? "" : "Zatím žádné starší verze.";
  for (const h of list) {
    const row = el("div", { class: "hist-row" }, el("span", {}, `${h.time} · ${h.words} slov`, el("small", { class: "hist-who" }, whoText(h.who))),
      el("button", { onclick: async () => {
        state.project = await fetch(`api/books/${encodeURIComponent(state.bookId)}/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: h.name }) }).then((r) => r.json());
        $("#bookHistDlg").hidden = true;
        renderAll();
        toast(`Transkripce obnovena ze stavu ${h.time}.`);
      } }, "Obnovit"));
    box.append(row);
  }
  $("#bookHistDlg").hidden = false;
}
$("#bookHistBtn").addEventListener("click", openBookHistory);
$("#bookHistClose").addEventListener("click", () => { $("#bookHistDlg").hidden = true; });

// ---------- reading text (OCR) running on the server ----------
// While the server writes the book, the transcription is read-only and reloads as pages arrive.
async function watchOcr(id) {
  if (state.ocrWatching === id) return;
  state.ocrWatching = id;
  let lastDone = -1;
  const banner = $("#ocrBanner") || (() => {
    const b = el("div", { id: "ocrBanner", class: "ocr-banner" });
    $("#colText").prepend(b);
    return b;
  })();
  for (;;) {
    if (state.bookId !== id) break;
    const st = await fetch(`api/books/${encodeURIComponent(id)}/ocr`).then((r) => r.json()).catch(() => ({}));
    state.ocrRunning = !!st.running;
    if (!st.running) {
      banner.hidden = true;
      if (lastDone >= 0) {   // just finished: load the final text
        state.project = await (await fetch(`api/books/${encodeURIComponent(id)}`)).json();
        renderAll();
        toast(`Text knihy je přečtený${st.errors && st.errors.length ? `, ${st.errors.length} stran se přečíst nepodařilo` : ""}. Zkontrolujte ho proti skenu.`, 9000);
      }
      break;
    }
    banner.hidden = false;
    banner.textContent = `Čtu text knihy: hotovo ${st.done} z ${st.total} stran. Do té doby nelze transkripci upravovat.`;
    if (st.done !== lastDone && !state.dirty) {
      lastDone = st.done;
      state.project = await (await fetch(`api/books/${encodeURIComponent(id)}`)).json();
      state.pageIndex = Math.min(state.pageIndex, state.project.pages.length - 1);
      renderAll();
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  state.ocrWatching = null;
  cutPendingImages();
}

// picture blocks found by the OCR are cut out of the scan the first time the book is open
async function cutPendingImages() {
  if (!window.Importer || !state.project) return;
  if (!state.project.pages.some((p) => p.blocks.some((b) => b.pending))) return;
  const n = await Importer.cutPending(state.bookId, state.project);
  if (n) { markDirty(); renderAll(); }
}

async function readAgain(pages, label) {
  if (state.dirty) await save();
  const engine = localStorage.getItem("scriptorium.ocrEngine") || "auto";
  if (!confirm(`${label}\n\nSoučasný text ${pages === "empty" ? "stran bez textu" : "strany"} se nahradí nově přečteným. Předchozí stav zůstane v Historii transkripce.`)) return;
  const res = await fetch(`api/books/${encodeURIComponent(state.bookId)}/ocr`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pages, engine }) });
  if (!res.ok) { toast("Čtení textu se nepodařilo spustit."); return; }
  state.ocrWatching = null;
  watchOcr(state.bookId);
}

$("#ocrPageBtn").addEventListener("click", () => readAgain([state.pageIndex], `Znovu přečíst stranu ${state.pageIndex + 1}?`));
$("#ocrEmptyBtn").addEventListener("click", () => {
  const n = state.project.pages.filter((p) => !pageHasText(p)).length;
  if (!n) { toast("Všechny strany už text mají."); return; }
  readAgain("empty", `Přečíst ${n} stran bez textu?`);
});
$("#deleteBookBtn").addEventListener("click", async () => {
  if (!confirm(`Odebrat zdrojovou knihu „${state.project.title}“?\n\nZ aplikace zmizí i její transkripce. Na serveru zůstane v koši, takže ji správce může vrátit.`)) return;
  const res = await fetch(`api/books/${encodeURIComponent(state.bookId)}/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!res.ok) { toast("Knihu se nepodařilo odebrat."); return; }
  localStorage.removeItem("publisher.book");
  state.dirty = false;
  location.href = location.pathname;
});
$("#addPagesBtn").addEventListener("click", async () => {
  if (state.dirty) await save();
  if (window.Importer) Importer.open(state.bookId);
});

window.Book = {
  get project() { return state.project; },
  get pageIndex() { return state.pageIndex; },
  get view() { return state.view || "both"; },
  get id() { return state.bookId; },
  reload: async () => { state.project = await (await fetch(`api/books/${encodeURIComponent(state.bookId)}`)).json(); renderAll(); watchOcr(state.bookId); },
  goToPage: (i) => goToPage(i),
  selectBlock: (id) => selectBlock(id),
};
window.ensureColumn = (c) => { if (!state.cols.includes(c)) setCols([...state.cols, c]); };

window.openBookBlock = async (book, page, block) => {
  window.ensureColumn("text");
  if (book !== state.bookId) { $("#bookSelect").value = book; await openBook(book); }
  goToPage(page);
  selectBlock(block, true);
};

window.updateBookImage = async (book, blockId, { caption, source }) => {
  if (book === state.bookId) {
    const f = findBlock(blockId);
    if (f) { f.block.caption = caption; f.block.source = source || undefined; markDirty(); renderPage(); }
    return;
  }
  const project = await (await fetch(`api/books/${encodeURIComponent(book)}`)).json();
  for (const p of project.pages) for (const b of p.blocks) if (b.id === blockId) { b.caption = caption; b.source = source || undefined; }
  await fetch(`api/books/${encodeURIComponent(book)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(project) });
};

// ---------- columns ----------
// relative column widths, changed with the − / + buttons in each column header
const COL_DEFAULT = { scan: 1, text: 1, ms: 1.15, ask: 1, img: 1 };
function colWidths() {
  try { return Object.assign({}, COL_DEFAULT, JSON.parse(localStorage.getItem("publisher.widths") || "{}")); } catch (e) { return { ...COL_DEFAULT }; }
}
function resizeCol(col, delta) {
  const w = colWidths();
  w[col] = delta === 0 ? COL_DEFAULT[col] : Math.max(0.4, Math.min(3, Math.round((w[col] + delta) * 100) / 100));
  try { localStorage.setItem("publisher.widths", JSON.stringify(w)); } catch (e) { /* ignore */ }
  setCols(state.cols);
}
function addWidthButtons() {
  const map = { colScan: "scan", colText: "text", colMs: "ms", colAsk: "ask", colImg: "img" };
  for (const [id, col] of Object.entries(map)) {
    const head = document.querySelector(`#${id} .col-head`);
    if (!head || head.querySelector(".col-width")) continue;
    const g = document.createElement("span");
    g.className = "col-width";
    g.innerHTML = `<button data-d="-0.25" title="Zúžit sloupec">−</button><span title="Dvojklik vrátí původní šířku">šířka</span><button data-d="0.25" title="Rozšířit sloupec">+</button>`;
    g.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) resizeCol(col, parseFloat(b.dataset.d)); });
    g.addEventListener("dblclick", () => resizeCol(col, 0));
    head.append(g);
  }
}

function setCols(cols) {
  const order = ["scan", "text", "ms", "ask", "img"];
  cols = order.filter((c) => cols.includes(c));
  state.cols = cols;
  localStorage.setItem("publisher.cols", cols.join(","));
  $("#colScan").hidden = !cols.includes("scan");
  $("#colText").hidden = !cols.includes("text");
  $("#colMs").hidden = !cols.includes("ms");
  $("#colImg").hidden = !cols.includes("img");
  $("#colAsk").hidden = !cols.includes("ask");
  if (cols.includes("img") && window.Gallery) Gallery.reload();
  const bookVisible = cols.includes("scan") || cols.includes("text");
  $("#bookNav").hidden = !bookVisible;
  $("#emptyHint").hidden = cols.length > 0;
  const tpl = [];
  const w = colWidths();
  if (bookVisible) tpl.push("196px");
  for (const c of cols) tpl.push(`minmax(0, ${cols.length === 1 ? 1 : w[c]}fr)`);
  $("#workspace").style.gridTemplateColumns = tpl.join(" ") || "1fr";
  document.querySelectorAll(".col-btn").forEach((b) => b.classList.toggle("on", cols.includes(b.dataset.col)));
  document.querySelectorAll(".presets [data-preset]").forEach((b) => b.classList.toggle("on", b.dataset.preset === cols.join(",")));
  document.body.classList.toggle("ms-on", cols.includes("ms"));
  if (!cols.includes("ms") && state.cropTarget === "ms") setCropMode(false);
  requestAnimationFrame(() => { if (state.project) applyZoom(); if (window.MS) MS.refreshMark(); });
}

// ---------- init ----------

function init() {
  addWidthButtons();
  $("#bookSelect").addEventListener("change", (e) => openBook(e.target.value));
  $("#bookTitle").addEventListener("input", (e) => { state.project.title = e.target.value; markDirty(); });
  $("#prevPage").addEventListener("click", () => goToPage(state.pageIndex - 1));
  $("#nextPage").addEventListener("click", () => goToPage(state.pageIndex + 1));
  $("#pageNo").addEventListener("change", (e) => {
    const v = parseInt(e.target.value, 10);
    currentPage().page_no = Number.isFinite(v) ? v : null;
    markDirty();
    renderPageList();
  });
  $("#pageSkip").addEventListener("change", (e) => { currentPage().skip = e.target.checked || undefined; markDirty(); renderPageList(); });
  $("#cropBtn").addEventListener("click", () => setCropMode(!(state.cropMode && state.cropTarget === "text"), null, "text"));
  $("#zoomIn").addEventListener("click", () => { state.zoom = Math.min(4, state.zoom * 1.25); applyZoom(); });
  $("#zoomOut").addEventListener("click", () => { state.zoom = Math.max(0.3, state.zoom / 1.25); applyZoom(); });
  $("#zoomFit").addEventListener("click", () => { state.zoom = 1; applyZoom(); });
  $("#viewSelect").addEventListener("change", (e) => { state.view = e.target.value; localStorage.setItem("publisher.view", state.view); renderBlocks(); });
  state.view = localStorage.getItem("publisher.view") || "both";
  $("#viewSelect").value = state.view;
  $("#exportBtn").addEventListener("click", async () => {
    await save();
    const mode = state.project.lang ? $("#exportMode").value : "orig";
    window.open(`api/export/${encodeURIComponent(state.bookId)}?mode=${mode}`, "_blank");
  });
  document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => addTextBlock(b.dataset.add)));
  window.addEventListener("resize", applyZoom);
  // formatting bar (acts on the selected paragraph)
  document.querySelectorAll("#fmtBar button").forEach((b) => b.addEventListener("mousedown", (e) => e.preventDefault()));
  document.querySelectorAll("#fmtBar [data-cmd]").forEach((btn) => btn.addEventListener("click", () => {
    const ed = document.activeElement;
    if (!ed || !ed.isContentEditable) return toast("Nejdřív označte text v odstavci.");
    document.execCommand(btn.dataset.cmd);
    ed.dispatchEvent(new Event("input"));
  }));
  document.querySelectorAll("#fmtBar [data-align]").forEach((btn) => btn.addEventListener("click", () => setBlockProp("align", btn.dataset.align)));
  $("#fmtStyle").addEventListener("change", (e) => { setBlockProp("style", e.target.value === "p" ? "" : e.target.value); });
  $("#fmtFont").addEventListener("change", (e) => setBlockProp("font", e.target.value));
  $("#fmtSize").addEventListener("change", (e) => setBlockProp("size", e.target.value));
  // whole-interface size for poor eyesight
  let ui = parseFloat(localStorage.getItem("publisher.ui") || "1");
  const applyUi = () => { document.body.style.zoom = ui; localStorage.setItem("publisher.ui", ui); applyZoom(); };
  applyUi();
  $("#uiBigger").addEventListener("click", () => { ui = Math.min(1.8, Math.round((ui + 0.1) * 10) / 10); applyUi(); });
  $("#uiSmaller").addEventListener("click", () => { ui = Math.max(0.8, Math.round((ui - 0.1) * 10) / 10); applyUi(); });
  initLoupe();
  initSearch();
  const urlCols = new URLSearchParams(location.search).get("cols");
  setCols((urlCols || localStorage.getItem("publisher.cols") || "scan,text").split(",").filter(Boolean));
  document.querySelectorAll(".col-btn").forEach((b) => b.addEventListener("click", () => {
    const c = b.dataset.col;
    setCols(state.cols.includes(c) ? state.cols.filter((x) => x !== c) : [...state.cols, c]);
  }));
  document.querySelectorAll(".presets [data-preset]").forEach((b) => b.addEventListener("click", () => setCols(b.dataset.preset.split(","))));
  $("#cropMsBtn").addEventListener("click", () => setCropMode(!(state.cropMode && state.cropTarget === "ms"), null, "ms"));
  $("#pageToMs").addEventListener("click", pageToManuscript);
  window.addEventListener("keydown", (e) => {
    const editing = document.activeElement && (document.activeElement.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName));
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); state.dirty = true; save(); return; }
    if (e.key === "Escape" && state.cropMode) { setCropMode(false); return; }
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); goToPage(state.pageIndex - 1); return; }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); goToPage(state.pageIndex + 1); return; }
    if (editing) return;
    if (e.key === "ArrowLeft" || e.key === "PageUp") goToPage(state.pageIndex - 1);
    if (e.key === "ArrowRight" || e.key === "PageDown") goToPage(state.pageIndex + 1);
    if (e.key === "c") setCropMode(!state.cropMode);
  });
  window.addEventListener("beforeunload", (e) => { if (state.dirty) { save(); e.preventDefault(); } });
  initCropping();
  loadBooks();
}

// ---------- magnifier over the scan ----------
function initLoupe() {
  const box = $("#scanBox");
  const lens = el("div", { class: "lens" });
  box.append(lens);
  $("#loupeBtn").addEventListener("click", () => {
    state.loupe = !state.loupe;
    $("#loupeBtn").classList.toggle("active", state.loupe);
    if (!state.loupe) lens.style.display = "none";
    else toast("Lupa: přejeďte myší po skenu.");
  });
  box.addEventListener("mousemove", (e) => {
    if (!state.loupe || state.cropMode) return;
    const r = box.getBoundingClientRect();
    const zoom = 2.6;
    const k = box.offsetWidth / r.width;
    const x = (e.clientX - r.left) * k;
    const y = (e.clientY - r.top) * k;
    const w = box.offsetWidth, h = box.offsetHeight;
    const size = 340;
    Object.assign(lens.style, {
      display: "block", left: x - size / 2 + "px", top: y - size / 2 + "px", width: size + "px", height: size + "px",
      backgroundImage: `url("${bookUrl(currentPage().scan)}")`,
      backgroundSize: `${w * zoom}px ${h * zoom}px`,
      backgroundPosition: `${-(x * zoom - size / 2)}px ${-(y * zoom - size / 2)}px`,
    });
  });
  box.addEventListener("mouseleave", () => { lens.style.display = "none"; });
}

// ---------- search with suggestions ----------
function initSearch() {
  const input = $("#searchInput");
  const pop = $("#searchPop");
  let timer = null;
  let seq = 0;
  const close = () => { pop.hidden = true; };
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) return close();
    const my = ++seq;
    const data = await (await fetch("api/search?q=" + encodeURIComponent(q))).json();
    if (my !== seq) return;
    pop.innerHTML = "";
    if (data.suggest.length) {
      const row = el("div", { class: "sugg" });
      for (const w of data.suggest) {
        row.append(el("button", { onclick: () => {
          const parts = input.value.trim().split(/\s+/);
          parts[parts.length - 1] = w;
          input.value = parts.join(" ") + " ";
          input.focus();
          run();
        } }, w));
      }
      pop.append(row);
    }
    if (!data.hits.length) pop.append(el("div", { class: "hit none" }, "Nic nenalezeno."));
    const terms = q.split(/\s+/).filter(Boolean);
    let msIndex = 0;
    const hits = [...data.hits.filter((h) => h.where === "manuscript"), ...data.hits.filter((h) => h.where !== "manuscript")];
    for (const h of hits) {
      if (h.where === "manuscript") h.k = msIndex++;
      h.terms = terms;
      const where = h.where === "manuscript" ? "Můj rukopis" : `${h.title.replace(/\s*\(.*\)\s*$/, "")} · ${h.page_no ? "s. " + h.page_no : "str. " + (h.page + 1)}${h.field === "tr" ? " · překlad" : ""}`;
      const snip = el("div", { class: "snip" });
      snip.innerHTML = highlight(h.snippet, terms);
      const item = el("div", { class: "hit" }, el("div", { class: "where" }, where), snip);
      item.addEventListener("click", () => { close(); openHit(h); });
      pop.append(item);
    }
    pop.hidden = false;
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 180); });
  input.addEventListener("focus", () => { if (input.value.trim().length >= 2) run(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); input.blur(); }
    if (e.key === "Enter") { const first = pop.querySelector(".hit:not(.none)"); if (first) first.click(); }
  });
  document.addEventListener("mousedown", (e) => { if (!pop.contains(e.target) && e.target !== input) close(); });
}

function foldText(s) { return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }

function highlight(text, terms) {
  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const folded = foldText(text);
  const marks = new Array(text.length).fill(false);
  for (const t of terms.map(foldText)) {
    let i = folded.indexOf(t);
    while (i >= 0 && t) { for (let k = i; k < i + t.length; k++) marks[k] = true; i = folded.indexOf(t, i + t.length); }
  }
  let out = "", on = false;
  for (let i = 0; i < text.length; i++) {
    if (marks[i] !== on) { out += marks[i] ? "<mark>" : "</mark>"; on = marks[i]; }
    out += esc(text[i]);
  }
  return out + (on ? "</mark>" : "");
}

async function openHit(h) {
  if (h.where === "manuscript") {
    if (!state.cols.includes("ms")) setCols([...state.cols, "ms"]);
    setTimeout(() => MS.scrollToMatch(h.terms, h.k), 50);
    return;
  }
  if (!state.cols.includes("text")) setCols([...state.cols.filter((c) => c !== "ms" || state.cols.length < 2), "text"]);
  if (h.book !== state.bookId) { $("#bookSelect").value = h.book; await openBook(h.book); }
  if (h.field === "orig" || h.field === "tr") {
    if (state.project.lang && (state.view || "both") !== "both") { state.view = "both"; $("#viewSelect").value = "both"; }
  }
  goToPage(h.page);
  selectBlock(h.block, true);
}

init();
