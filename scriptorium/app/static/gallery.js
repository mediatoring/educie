// Publisher – gallery of all images (library, books, manuscript) + caption/source dialog
"use strict";

(() => {
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const gal = { items: [], filter: "all", query: "", open: -1, visible: [] };

// ---------- caption + source dialog (used everywhere) ----------
window.editCaption = ({ caption = "", source = "", image = "", title = "Popisek a zdroj obrázku", okLabel = "Uložit" } = {}) =>
  new Promise((resolve) => {
    const dlg = $("#capDlg");
    $("#capTitle").textContent = title;
    $("#capCaption").value = caption;
    $("#capSource").value = source;
    $("#capPreview").src = image || "";
    $("#capPreview").hidden = !image;
    $("#capOk").textContent = okLabel;
    dlg.hidden = false;
    setTimeout(() => $("#capCaption").focus(), 50);
    const done = (val) => { dlg.hidden = true; $("#capOk").onclick = $("#capCancel").onclick = null; resolve(val); };
    $("#capOk").onclick = () => done({ caption: $("#capCaption").value.trim(), source: $("#capSource").value.trim() });
    $("#capCancel").onclick = () => done(null);
  });

// ---------- loading ----------
async function load() {
  try {
    gal.items = await (await fetch("api/gallery")).json();
  } catch (e) { return; }
  render();
}

function matches(it) {
  if (gal.filter !== "all" && it.kind !== gal.filter) return false;
  if (!gal.query) return true;
  const f = (t) => (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const hay = f(it.caption + " " + it.source + " " + it.where);
  return f(gal.query).split(/\s+/).every((w) => hay.includes(w));
}

function render() {
  const grid = $("#galGrid");
  gal.visible = gal.items.filter(matches);
  const counts = { all: gal.items.length, library: 0, book: 0, manuscript: 0 };
  gal.items.forEach((i) => { counts[i.kind]++; });
  document.querySelectorAll("#galFilters [data-f]").forEach((b) => {
    b.classList.toggle("on", b.dataset.f === gal.filter);
    b.querySelector("small").textContent = counts[b.dataset.f];
  });
  grid.innerHTML = "";
  if (!gal.visible.length) { grid.innerHTML = '<div class="gal-empty">Žádné obrázky.</div>'; return; }
  gal.visible.forEach((it, i) => {
    const card = document.createElement("button");
    card.className = "gal-card";
    card.innerHTML = `<span class="gal-thumb"><img src="${esc(it.src)}" loading="lazy" alt=""></span>
      <span class="gal-cap">${esc(it.caption) || '<em class="missing">bez popisku</em>'}</span>
      <span class="gal-src">${it.source ? "Zdroj: " + esc(it.source) : '<em class="missing">bez zdroje</em>'}</span>
      <span class="gal-where">${esc(it.where)}</span>`;
    card.addEventListener("click", () => openLightbox(i));
    grid.append(card);
  });
}

// ---------- lightbox ----------
function openLightbox(i) {
  gal.open = i;
  const it = gal.visible[i];
  if (!it) return;
  $("#lbImg").src = it.src;
  $("#lbCaption").textContent = it.caption || "bez popisku";
  $("#lbSource").textContent = it.source ? "Zdroj: " + it.source : "bez zdroje";
  $("#lbWhere").textContent = it.where;
  $("#lbCount").textContent = `${i + 1} / ${gal.visible.length}`;
  $("#lbToMs").hidden = it.kind === "manuscript";
  $("#lbEdit").hidden = it.kind === "manuscript";
  $("#lbGoto").textContent = it.kind === "manuscript" ? "Ukázat v rukopisu" : it.kind === "book" ? "Ukázat v knize" : "";
  $("#lbGoto").hidden = it.kind === "library";
  $("#lightbox").hidden = false;
}

function closeLightbox() { $("#lightbox").hidden = true; gal.open = -1; }

async function editCurrent() {
  const it = gal.visible[gal.open];
  if (!it) return;
  const res = await window.editCaption({ caption: it.caption, source: it.source, image: it.src });
  if (!res) return;
  if (it.kind === "library") {
    await fetch(`api/library/${encodeURIComponent(it.file)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(res) });
  } else if (it.kind === "book") {
    await window.updateBookImage(it.book, it.block, res);
  }
  Object.assign(it, res);
  render();
  openLightbox(gal.visible.indexOf(it) >= 0 ? gal.visible.indexOf(it) : 0);
  window.showToast("Popisek a zdroj uloženy.");
}

async function sendCurrent() {
  const it = gal.visible[gal.open];
  if (!it || !window.MS) return;
  if (!MS.visible()) window.ensureColumn("ms");
  const body = it.kind === "library" ? { library: true, src: it.file } : { book: it.book, src: it.bookSrc };
  const res = await fetch("api/manuscript/copy-image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json();
  if (!res.ok) { window.showToast("Obrázek se nepodařilo vložit."); return; }
  closeLightbox();
  MS.insertImage(out.src, it.caption, "Obrázek vložen do rukopisu.", it.source);
}

function gotoCurrent() {
  const it = gal.visible[gal.open];
  if (!it) return;
  closeLightbox();
  if (it.kind === "manuscript") { window.ensureColumn("ms"); MS.scrollToImage(it.index); }
  else if (it.kind === "book") window.openBookBlock(it.book, it.page, it.block);
}

// ---------- adding to the library ----------
async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
    const meta = await window.editCaption({ image: data, title: "Nový obrázek do knihovny", okLabel: "Přidat do knihovny" });
    if (!meta) continue;
    await fetch("api/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data, name: f.name, ...meta }) });
  }
  await load();
  window.showToast("Obrázky přidány do knihovny.");
}

function init() {
  document.querySelectorAll("#galFilters [data-f]").forEach((b) => b.addEventListener("click", () => { gal.filter = b.dataset.f; render(); }));
  $("#galSearch").addEventListener("input", (e) => { gal.query = e.target.value.trim(); render(); });
  $("#galAdd").addEventListener("click", () => $("#galFile").click());
  $("#galFile").addEventListener("change", async (e) => { await addFiles([...e.target.files]); e.target.value = ""; });
  $("#galReload").addEventListener("click", load);
  $("#lbClose").addEventListener("click", closeLightbox);
  $("#lbPrev").addEventListener("click", () => openLightbox((gal.open - 1 + gal.visible.length) % gal.visible.length));
  $("#lbNext").addEventListener("click", () => openLightbox((gal.open + 1) % gal.visible.length));
  $("#lbEdit").addEventListener("click", editCurrent);
  $("#lbToMs").addEventListener("click", sendCurrent);
  $("#lbGoto").addEventListener("click", gotoCurrent);
  $("#lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
  window.addEventListener("keydown", (e) => {
    if ($("#lightbox").hidden || !$("#capDlg").hidden) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") $("#lbPrev").click();
    if (e.key === "ArrowRight") $("#lbNext").click();
  });
  const drop = $("#colImg");
  drop.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); });
  drop.addEventListener("drop", (e) => { const f = [...e.dataTransfer.files]; if (f.length) { e.preventDefault(); addFiles(f); } });
  window.Gallery = { reload: load };
  load();
}

init();
})();
