// Adding source books: photos or PDF -> ordered pages -> upload -> OCR in the background.
// Also "add pages" to an existing source book and re-reading pages from the book view.
"use strict";

(() => {
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const SCAN_MAX = 3000;      // longest side of the stored scan
const PREVIEW_W = 1400;     // width of the preview (also what the AI reads)

let items = [];             // {id, name, file, pdfPage, rotate, thumb}
let target = null;          // existing book id when adding pages, null for a new book
let pdfjs = null;
let nextId = 1;

async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import(new URL("vendor/pdfjs/pdf.min.mjs", document.baseURI).href);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs/pdf.worker.min.mjs", document.baseURI).href;
  }
  return pdfjs;
}

// ---------- rendering one page to a canvas ----------
async function pageCanvas(it, maxSide) {
  let src;
  if (it.pdfPage) {
    const page = await it.pdfPage.doc.getPage(it.pdfPage.n);
    const v1 = page.getViewport({ scale: 1 });
    const scale = maxSide / Math.max(v1.width, v1.height);
    const vp = page.getViewport({ scale });
    src = document.createElement("canvas");
    src.width = Math.round(vp.width); src.height = Math.round(vp.height);
    const ctx = src.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, src.width, src.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
  } else {
    const bmp = await createImageBitmap(it.file, { imageOrientation: "from-image" });
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    src = document.createElement("canvas");
    src.width = Math.round(bmp.width * k); src.height = Math.round(bmp.height * k);
    src.getContext("2d").drawImage(bmp, 0, 0, src.width, src.height);
    bmp.close && bmp.close();
  }
  const r = ((it.rotate || 0) % 360 + 360) % 360;
  if (!r) return src;
  const out = document.createElement("canvas");
  out.width = r % 180 ? src.height : src.width;
  out.height = r % 180 ? src.width : src.height;
  const ctx = out.getContext("2d");
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(r * Math.PI / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

function scaled(canvas, width) {
  const k = Math.min(1, width / canvas.width);
  const c = document.createElement("canvas");
  c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}

// ---------- choosing files ----------
async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith("image/") || f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  for (const f of list) {
    if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
      $("#impCount").textContent = T("Načítám PDF…");
      $("#impTools").hidden = false;
      try {
        const lib = await loadPdfJs();
        const doc = await lib.getDocument({ data: await f.arrayBuffer() }).promise;
        for (let n = 1; n <= doc.numPages; n++) items.push({ id: nextId++, name: `${f.name} – strana ${n}`, file: f, pdfPage: { doc, n }, rotate: 0 });
      } catch (e) {
        alert(T("PDF {name} se nepodařilo otevřít: {error}", { name: f.name, error: e.message }));
      }
    } else {
      items.push({ id: nextId++, name: f.name, file: f, rotate: 0 });
    }
  }
  renderGrid();
}

async function thumb(it) {
  if (it.thumb) return it.thumb;
  try {
    const c = await pageCanvas(it, 360);
    it.thumb = c.toDataURL("image/jpeg", 0.7);
  } catch (e) {
    it.thumb = "";
    it.bad = true;
  }
  return it.thumb;
}

function renderGrid() {
  const grid = $("#impGrid");
  grid.innerHTML = "";
  items.forEach((it, i) => {
    const card = document.createElement("div");
    card.className = "imp-card" + (it.bad ? " bad" : "");
    card.draggable = true;
    card.dataset.id = it.id;
    card.innerHTML = `<div class="imp-n">${i + 1}</div><div class="imp-img"><img alt=""></div>
      <div class="imp-name" title="${esc(it.name)}">${esc(it.name)}</div>
      <div class="imp-acts"><button data-a="left" title="O stranu dříve">◀</button><button data-a="rot" title="Otočit o 90°">⟳</button><button data-a="del" title="Odebrat stranu">✕</button><button data-a="right" title="O stranu později">▶</button></div>`;
    const img = card.querySelector("img");
    thumb(it).then((src) => { img.src = src; img.style.transform = ""; if (it.bad) card.classList.add("bad"); });
    card.addEventListener("click", (e) => {
      const a = e.target.dataset.a;
      if (!a) return;
      const k = items.indexOf(it);
      if (a === "del") items.splice(k, 1);
      if (a === "rot") { it.rotate = (it.rotate + 90) % 360; it.thumb = null; }
      if (a === "left" && k > 0) [items[k - 1], items[k]] = [items[k], items[k - 1]];
      if (a === "right" && k < items.length - 1) [items[k + 1], items[k]] = [items[k], items[k + 1]];
      renderGrid();
    });
    card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/imp", String(it.id)); card.classList.add("dragging"); });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/imp")) { e.preventDefault(); card.classList.add("over"); } });
    card.addEventListener("dragleave", () => card.classList.remove("over"));
    card.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation();
      card.classList.remove("over");
      const from = items.findIndex((x) => String(x.id) === e.dataTransfer.getData("text/imp"));
      if (from < 0) return;
      const [moved] = items.splice(from, 1);
      items.splice(items.indexOf(it) + (from <= items.indexOf(it) ? 1 : 0), 0, moved);
      renderGrid();
    });
    grid.append(card);
  });
  $("#impTools").hidden = !items.length;
  $("#impCount").textContent = items.length ? T(items.length === 1 ? "{n} strana" : items.length < 5 ? "{n} strany" : "{n} stran", { n: items.length }) : "";
  $("#impStart").disabled = !items.length;
}

// ---------- upload and OCR ----------
function progress(done, total, text) {
  $("#impBar").style.width = (total ? Math.round(100 * done / total) : 0) + "%";
  $("#impStatus").textContent = text;
}

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

async function start() {
  const engine = $("#impEngine").value;
  try { localStorage.setItem("scriptorium.ocrEngine", engine); } catch (e) { /* ignore */ }
  let book = target;
  if (!book) {
    const title = $("#impBookTitle").value.trim();
    if (!title) { $("#impBookTitle").focus(); return; }
    book = (await post("api/books", { title, lang: $("#impLang").value })).id;
  }
  $("#impStep1").hidden = true;
  $("#impStep2").hidden = false;
  $("#impErrors").innerHTML = "";
  const first = (await fetch(`api/books/${book}`).then((r) => r.json())).pages.length;
  const n = items.length;
  for (let i = 0; i < n; i++) {
    progress(i, n * 2, T("Nahrávám stranu {i} z {n}…", { i: i + 1, n }));
    try {
      const full = await pageCanvas(items[i], SCAN_MAX);
      const prev = scaled(full, PREVIEW_W);
      await post(`api/books/${book}/pages`, { scan: full.toDataURL("image/jpeg", 0.88), preview: prev.toDataURL("image/jpeg", 0.85),
        size: [full.width, full.height], name: items[i].name });
    } catch (e) {
      $("#impErrors").insertAdjacentHTML("beforeend", `<div>${esc(T("Strana {i} ({name}) se nenahrála: {error}", { i: i + 1, name: items[i].name, error: e.message }))}</div>`);
    }
  }
  const pages = Array.from({ length: n }, (_, i) => first + i);
  await post(`api/books/${book}/ocr`, { pages, engine });
  items = [];
  await watch(book, n);
}

// polls the OCR job; when it is done, cuts the pictures out of the scans
async function watch(book, total) {
  $("#impOpen").hidden = true;
  $("#impOpen").onclick = () => {
    if (window.Book && Book.id === book && new URLSearchParams(location.search).has("open")) { $("#importDlg").hidden = true; Book.reload(); return; }
    location.href = location.pathname + "?open=1&cols=scan,text#" + encodeURIComponent(book);
  };
  if (window.Book && Book.id === book && Book.reload) Book.reload();
  for (;;) {
    const st = await fetch(`api/books/${book}/ocr`).then((r) => r.json()).catch(() => ({ running: true }));
    const t = st.total || total || 1;
    if (st.running) {
      progress(t + (st.done || 0), t * 2, T("Čtu text: hotovo {done} z {total} stran. Okno můžete zavřít, čtení poběží dál.", { done: st.done || 0, total: t }));
      $("#impOpen").hidden = !(st.done > 0);
      $("#impOpen").textContent = T("Otevřít knihu (zbytek se dočte)");
    } else {
      const used = Object.entries(st.used || {}).map(([k, v]) => `${k === "ai" ? T("umělá inteligence") : "Tesseract"} ${v}×`).join(", ");
      const read = (st.done || 0) - (st.errors || []).length;
      const head = T("Hotovo: přečteno {read} z {total} stran", { read, total: t }) + (used ? " (" + used + ")" : "");
      progress(1, 1, head + ". " + T("Vyřezávám obrázky…"));
      (st.errors || []).forEach((e) => $("#impErrors").insertAdjacentHTML("beforeend", `<div>${esc(T("Strana {i}: {error}", { i: e.page + 1, error: e.error }))}</div>`));
      const cut = await cutPending(book);
      $("#impStatus").textContent = head + (cut ? T(", vyříznuto {n} obrázků", { n: cut }) : "") + ". " + T("Text zkontrolujte proti skenu, nejlépe s Korekturou.");
      $("#impOpen").textContent = T("Otevřít knihu");
      $("#impOpen").hidden = false;
      return;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
}

// cuts out picture blocks the OCR marked as pending (shared with the book view)
async function cutPending(book, project) {
  project = project || await fetch(`api/books/${book}`).then((r) => r.json());
  let count = 0;
  const scans = {};
  for (const page of project.pages) {
    for (const b of page.blocks) {
      if (b.type !== "image" || !b.pending || !b.crop) continue;
      try {
        if (!scans[page.scan]) {
          scans[page.scan] = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = `books/${book}/${page.scan}`; });
        }
        const [x, y, w, h] = b.crop;
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(scans[page.scan], x, y, w, h, 0, 0, w, h);
        await post(`api/images/${encodeURIComponent(book)}`, { name: b.src.split("/").pop(), data: c.toDataURL("image/jpeg", 0.92) });
        delete b.pending;
        count++;
      } catch (e) { /* stays pending, tried again next time */ }
    }
  }
  return count;
}

// ---------- dialog ----------
function open(addTo = null) {
  target = addTo;
  items = [];
  renderGrid();
  $("#impTitle").textContent = T(addTo ? "Přidat strany do zdrojové knihy" : "Přidat zdrojovou knihu");
  $("#impNewFields").hidden = !!addTo;
  $("#impBookTitle").value = "";
  try { $("#impEngine").value = localStorage.getItem("scriptorium.ocrEngine") || "auto"; } catch (e) { /* ignore */ }
  $("#impStep1").hidden = false;
  $("#impStep2").hidden = true;
  $("#importDlg").hidden = false;
}

$("#importBtn").addEventListener("click", () => open());
$("#impClose").addEventListener("click", () => {
  if (!$("#impStep1").hidden && items.length && !confirm(T("Zavřít bez nahrání vybraných stran?"))) return;
  $("#importDlg").hidden = true;
  if (window.Home && !$("#home").hidden) Home.show();
});
$("#impPick").addEventListener("click", () => $("#impFiles").click());
$("#impFiles").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
const drop = $("#impDrop");
drop.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); drop.classList.add("over"); } });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
$("#impSortName").addEventListener("click", () => {
  items.sort((a, b) => a.name.localeCompare(b.name, "cs", { numeric: true }) || (a.pdfPage?.n || 0) - (b.pdfPage?.n || 0));
  renderGrid();
});
$("#impClear").addEventListener("click", () => { items = []; renderGrid(); });
$("#impStart").addEventListener("click", () => start().catch((e) => {
  $("#impStep2").hidden = false;
  $("#impStatus").textContent = T("Nahrání se nepovedlo: ") + e.message;
}));

window.Importer = { open, watch, cutPending, post };
})();
