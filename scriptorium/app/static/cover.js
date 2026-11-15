// Cover editor ("Obálka"): layout, photo you can move and zoom, background, text, Educie Press logo.
// The design is saved with the book, so the cover can be edited again later. It is drawn twice:
// e-book cover (1600 × 2560) and print cover for A4 (1600 × 2263). Home-screen thumbnails use the same drawing.
"use strict";

(() => {
const $ = (s) => document.querySelector(s);
const W = 1600;
const SIZES = { ebook: 2560, print: Math.round(1600 * 297 / 210) };
const DEFAULT = {
  layout: "text", image: "", zoom: 1, px: 0.5, py: 0.5, shade: 0, textPos: "bottom",
  bg: "#24364f", bg2: "#4a6a8f", grad: true, fg: "#f4ecd8", fg2: "#f4ecd8",
  font: "Georgia, serif", size: 100, size2: 100, authorTop: true, logo: "auto", dx: 0, dy: 0,
  frame: true, fw: 0.7, fh: 0.42, fx: 0.5, fy: 0.57, feather: 0,
};

let design = { ...DEFAULT };
let texts = { title: "", subtitle: "", author: "", line: "" };
let picture = null;     // loaded photo
let size = "ebook";     // which variant the editor shows
let photoBox = null;    // last photo area and scale, for dragging
let textBox = null;     // last text block area, for dragging
let dragMode = "move";  // frame layout: drag moves the picture ("move") or the crop inside it ("pan")

// ---------- images ----------
const imgCache = new Map();
function loadImg(src) {
  if (!src) return Promise.resolve(null);
  if (!imgCache.has(src)) {
    imgCache.set(src, new Promise((res) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = src;
    }));
  }
  return imgCache.get(src);
}

// ---------- drawing ----------
function wrap(ctx, text, maxW) {
  const out = [];
  let line = "";
  for (const w of String(text || "").split(/\s+/).filter(Boolean)) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

function luminance(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

// lay out the text block; shrink everything until it fits into the given height
function textBlock(ctx, d, tx, maxW, maxH) {
  const k2 = (d.size2 || 100) / (d.size || 100);
  for (let k = d.size / 100; k > 0.3; k *= 0.93) {
    const items = [];
    const add = (text, px, style, color, gapBefore) => {
      if (!text) return;
      ctx.font = `${style} ${Math.round(px * k)}px ${d.font}`;
      wrap(ctx, text, maxW).forEach((l, i) => items.push({ l, font: ctx.font, h: px * k * 1.18, color, gap: i ? 0 : gapBefore * k }));
    };
    const author = (tx.author || "").toUpperCase();
    if (d.authorTop) add(author, 62 * k2, "", d.fg2, 0);
    add(tx.title, 124, "bold", d.fg, items.length ? 60 : 0);
    add(tx.subtitle, 64 * k2, "italic", d.fg2, 44);
    if (!d.authorTop) add(author, 62 * k2, "", d.fg2, 70);
    const h = items.reduce((s, it) => s + it.h + it.gap, 0);
    if (h <= maxH || k < 0.35) return { items, h };
  }
  return { items: [], h: 0 };
}

function drawText(ctx, block, top, bottom, dx) {
  let y = top + Math.max(0, (bottom - top - block.h) / 2);
  const y0 = y;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  let maxW = 0;
  for (const it of block.items) {
    y += it.gap;
    ctx.font = it.font;
    ctx.fillStyle = it.color;
    ctx.fillText(it.l, W / 2 + dx, y);
    maxW = Math.max(maxW, ctx.measureText(it.l).width);
    y += it.h;
  }
  return { x: W / 2 + dx - maxW / 2 - 30, y: y0 - 30, w: maxW + 60, h: y - y0 + 60 };
}

function drawPhoto(ctx, pic, d, x, y, w, h, feather = 0) {
  const r = Math.max(w / pic.naturalWidth, h / pic.naturalHeight) * Math.max(1, d.zoom);
  const sw = w / r, sh = h / r;
  const sx = Math.min(Math.max(0, d.px * pic.naturalWidth - sw / 2), pic.naturalWidth - sw);
  const sy = Math.min(Math.max(0, d.py * pic.naturalHeight - sh / 2), pic.naturalHeight - sh);
  if (feather > 0) {
    // soft edges: draw into a separate canvas and fade its border to transparent
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    const x2 = c.getContext("2d");
    x2.drawImage(pic, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const f = Math.min(c.width, c.height) * 0.5 * feather / 100;
    x2.globalCompositeOperation = "destination-out";
    const edge = (gx0, gy0, gx1, gy1, rx, ry, rw, rh) => {
      const g = x2.createLinearGradient(gx0, gy0, gx1, gy1);
      g.addColorStop(0, "rgba(0,0,0,1)"); g.addColorStop(1, "rgba(0,0,0,0)");
      x2.fillStyle = g; x2.fillRect(rx, ry, rw, rh);
    };
    edge(0, 0, f, 0, 0, 0, f, c.height);
    edge(c.width, 0, c.width - f, 0, c.width - f, 0, f, c.height);
    edge(0, 0, 0, f, 0, 0, c.width, f);
    edge(0, c.height, 0, c.height - f, 0, c.height - f, c.width, f);
    ctx.drawImage(c, x, y, w, h);
  } else {
    ctx.drawImage(pic, sx, sy, sw, sh, x, y, w, h);
  }
  return { x, y, w, h, r, nw: pic.naturalWidth, nh: pic.naturalHeight };
}

function drawLogo(ctx, d, H, canvas, k) {
  if (d.logo === "none") return;
  const y = H - 170;
  let color = d.logo === "black" ? "#111111" : "#ffffff";
  if (d.logo === "auto") {
    let lum;
    try {
      const px = ctx.getImageData(Math.round((W / 2 - 280) * k), Math.round((y - 20) * k), Math.max(1, Math.round(560 * k)), Math.max(1, Math.round(100 * k))).data;
      let s = 0;
      for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      lum = s / (px.length / 4) / 255;
    } catch (e) { lum = luminance(d.grad ? d.bg2 : d.bg); }
    color = lum > 0.55 ? "#111111" : "#ffffff";
  }
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // "Educie.Press" with the dot in the publisher's colour
  ctx.font = `bold 60px Georgia, serif`;
  ctx.textAlign = "left";
  const a = ctx.measureText("Educie").width, dot = ctx.measureText(".").width, b = ctx.measureText("Press").width;
  let x = W / 2 - (a + dot + b) / 2;
  ctx.fillText("Educie", x, y + 30); x += a;
  ctx.fillStyle = "#B5390A"; ctx.fillText(".", x, y + 30); x += dot;
  ctx.fillStyle = color; ctx.fillText("Press", x, y + 30);
  ctx.textAlign = "center";
}

// draws a cover into `canvas` (any pixel size with the right aspect); returns the photo area
function draw(canvas, d, tx, pic, variant = "ebook") {
  const H = SIZES[variant];
  const ctx = canvas.getContext("2d");
  const k = canvas.width / W;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  // background
  if (d.grad) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, d.bg); g.addColorStop(1, d.bg2);
    ctx.fillStyle = g;
  } else ctx.fillStyle = d.bg;
  ctx.fillRect(0, 0, W, H);

  const usePic = d.layout !== "text" && pic;
  const hasBottom = d.logo !== "none" || tx.line;
  const foot = d.logo !== "none" ? (tx.line ? 330 : 240) : (tx.line ? 200 : 110);
  let box = null, top, bottom;
  const block = (t, b) => textBlock(ctx, d, tx, W - 240, b - t);

  if (usePic && d.layout === "full") {
    box = drawPhoto(ctx, pic, d, 0, 0, W, H);
    if (d.shade) { ctx.fillStyle = `rgba(0,0,0,${d.shade / 100})`; ctx.fillRect(0, 0, W, H); }
    const zones = { top: [150, H * 0.45], center: [H * 0.3, H * 0.7], bottom: [H * 0.52, H - foot - 40] };
    [top, bottom] = zones[d.textPos] || zones.bottom;
    // a soft shadow behind the text so it stays readable on any photo
    const g = ctx.createLinearGradient(0, top - 200, 0, bottom + 200);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(0.5, "rgba(0,0,0,.45)"); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, top - 200, W, bottom - top + 400);
  } else if (usePic && d.layout === "top") {
    const ph = Math.round(H * 0.58);
    box = drawPhoto(ctx, pic, d, 0, 0, W, ph);
    if (d.shade) { ctx.fillStyle = `rgba(0,0,0,${d.shade / 100})`; ctx.fillRect(0, 0, W, ph); }
    top = ph + 70; bottom = H - foot - 30;
  } else if (usePic && d.layout === "frame") {
    // the picture is a free box: position (centre) and size set by the user, frame optional
    const fw = Math.round(W * (d.fw || 0.7)), fh = Math.round(H * (d.fh || 0.42));
    const fx = Math.round(W * (d.fx ?? 0.5) - fw / 2), fy = Math.round(H * (d.fy ?? 0.57) - fh / 2);
    if (d.frame !== false) { ctx.fillStyle = d.fg2; ctx.fillRect(fx - 16, fy - 16, fw + 32, fh + 32); }
    box = drawPhoto(ctx, pic, d, fx, fy, fw, fh, d.frame === false ? d.feather || 0 : 0);
    if (d.shade) { ctx.fillStyle = `rgba(0,0,0,${d.shade / 100})`; ctx.fillRect(fx, fy, fw, fh); }
    box.free = true;
    // text above the picture, or below it when the picture sits high up
    if (fy > H * 0.3) { top = 150; bottom = fy - 70; } else { top = fy + fh + 70; bottom = H - foot - 40; }
  } else {
    top = H * 0.2; bottom = H - foot - 120;
  }
  // text moved by the user: shift the area; when it is moved, the block keeps its size instead of shrinking to the zone
  const dy = Math.max(-H, Math.min(H, d.dy || 0)), dx = Math.max(-W / 2, Math.min(W / 2, d.dx || 0));
  const tb = drawText(ctx, block(top, bottom), top + dy, bottom + dy, dx);

  if (tx.line) {
    ctx.fillStyle = d.fg2; ctx.globalAlpha = 0.9;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `44px ${d.font}`;
    const l = wrap(ctx, tx.line, W - 300)[0] || "";
    ctx.fillText(l, W / 2, H - (d.logo !== "none" ? 270 : 130));
    ctx.globalAlpha = 1;
  }
  if (hasBottom) drawLogo(ctx, d, H, canvas, k);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (box) box.text = tb;
  return box || { text: tb };
}

// ---------- book texts and saved design ----------
function field(name) { return document.querySelector(`#bookDlg [data-f="${name}"]`); }

function parseDesign(v) {
  try { return v ? { ...DEFAULT, ...(typeof v === "string" ? JSON.parse(v) : v) } : null; } catch (e) { return null; }
}

function textsFrom(st, d) {
  const line = d && d.logo !== "none" ? (st.series || "") : [st.publisher, st.series].filter(Boolean).join(" · ");
  return { title: st.title || "", subtitle: st.subtitle || "", author: st.author || "", line };
}

// ---------- editor ----------
function readForm() {
  design.bg = $("#cvBg").value; design.bg2 = $("#cvBg2").value; design.grad = $("#cvGrad").checked;
  design.fg = $("#cvFg").value; design.fg2 = $("#cvFg2").value; design.font = $("#cvFont").value;
  design.size = +$("#cvSize").value; design.size2 = +$("#cvSize2").value; design.authorTop = $("#cvAuthorTop").checked;
  design.logo = $("#cvLogo").value; design.zoom = +$("#cvZoom").value / 100; design.shade = +$("#cvShade").value;
  design.textPos = $("#cvTextPos").value;
  design.frame = $("#cvFrame").checked; design.fw = +$("#cvFw").value / 100; design.fh = +$("#cvFh").value / 100;
  design.feather = +$("#cvFeather").value;
  texts = { title: $("#cvTitle").value, subtitle: $("#cvSubtitle").value, author: $("#cvAuthor").value, line: $("#cvPublisher").value };
}

function writeForm() {
  $("#cvBg").value = design.bg; $("#cvBg2").value = design.bg2; $("#cvGrad").checked = !!design.grad;
  $("#cvFg").value = design.fg; $("#cvFg2").value = design.fg2; $("#cvFont").value = design.font;
  $("#cvSize").value = design.size; $("#cvSize2").value = design.size2 || 100; $("#cvAuthorTop").checked = design.authorTop !== false;
  $("#cvLogo").value = design.logo; $("#cvZoom").value = Math.round(design.zoom * 100); $("#cvShade").value = design.shade;
  $("#cvTextPos").value = design.textPos || "bottom";
  $("#cvFrame").checked = design.frame !== false; $("#cvFw").value = Math.round((design.fw || 0.7) * 100);
  $("#cvFh").value = Math.round((design.fh || 0.42) * 100); $("#cvFeather").value = design.feather || 0;
  $("#cvImage").value = [...$("#cvImage").options].some((o) => o.value === design.image) ? design.image : "";
}

function redraw() {
  readForm();
  const cv = $("#coverCanvas");
  const H = SIZES[size];
  cv.width = 800; cv.height = Math.round(800 * H / W);
  cv.style.height = Math.round(parseFloat(getComputedStyle(cv).width) * H / W) + "px";
  const res = draw(cv, design, texts, picture, size);
  textBox = res.text;
  photoBox = res.r ? res : null;
  $("#cvSizeVal").textContent = design.size + " %";
  $("#cvSize2Val").textContent = (design.size2 || 100) + " %";
  $("#cvZoomVal").textContent = Math.round(design.zoom * 100) + " %";
  $("#cvShadeVal").textContent = design.shade + " %";
  document.querySelectorAll("#cvLayouts button").forEach((b) => b.classList.toggle("on", b.dataset.layout === design.layout));
  const photoOn = design.layout !== "text";
  $("#cvPhotoSet").hidden = !photoOn;
  $("#cvTextPosL").hidden = design.layout !== "full";
  $("#cvFrameSet").hidden = design.layout !== "frame";
  $("#cvFeatherL").hidden = design.frame !== false;
  $("#cvFwVal").textContent = Math.round(design.fw * 100) + " %";
  $("#cvFhVal").textContent = Math.round(design.fh * 100) + " %";
  $("#cvFeatherVal").textContent = design.feather + " %";
  document.querySelectorAll("#cvDragMode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === dragMode));
  $("#cvPanHint").textContent = photoOn && picture
    ? "Text i fotografii posunete tažením myší (prstem) po obálce. Kolečko nad textem mění velikost textu, nad fotografií její přiblížení."
    : "Text posunete tažením myší (prstem) po obálce, kolečkem nad ním změníte jeho velikost.";
  cv.style.cursor = "grab";
}

async function setPicture(src) {
  design.image = src || "";
  picture = await loadImg(design.image);
  redraw();
}

async function openEditor() {
  const saved = parseDesign($("#coverDesignField").value);
  design = saved || { ...DEFAULT };
  $("#cvTitle").value = field("title").value;
  $("#cvSubtitle").value = field("subtitle").value;
  $("#cvAuthor").value = field("author").value;
  const st = { publisher: field("publisher").value, series: field("series").value };
  $("#cvPublisher").value = saved && saved.line != null ? saved.line : textsFrom(st, design).line;
  const items = await fetch("api/gallery").then((r) => r.json()).catch(() => []);
  const sel = $("#cvImage");
  sel.innerHTML = '<option value="">– vybrat z obrázků knih –</option>' + items.slice(0, 400).map((it) =>
    `<option value="${it.src.replace(/"/g, "&quot;")}">${(it.caption || it.where || it.src).slice(0, 70).replace(/</g, "")}</option>`).join("");
  if (design.image && ![...sel.options].some((o) => o.value === design.image)) {
    sel.insertAdjacentHTML("afterbegin", `<option value="${design.image.replace(/"/g, "&quot;")}">vlastní fotografie</option>`);
  }
  writeForm();
  size = "ebook";
  $("#cvSizeEbook").classList.add("on"); $("#cvSizePrint").classList.remove("on");
  $("#coverDlg").hidden = false;
  picture = await loadImg(design.image);
  requestAnimationFrame(redraw);
}

async function render(variant, d, tx, pic) {
  const c = document.createElement("canvas");
  c.width = W; c.height = SIZES[variant];
  draw(c, d, tx, pic, variant);
  return MS.uploadDataUrl(c.toDataURL("image/jpeg", 0.9));
}

async function saveEditor() {
  readForm();
  const btn = $("#coverSave");
  btn.disabled = true;
  try {
    $("#coverField").value = await render("ebook", design, texts, picture);
    $("#coverPrintField").value = await render("print", design, texts, picture);
    $("#coverDesignField").value = JSON.stringify({ ...design, generated: true, line: texts.line, stamp: stampOf(texts) });
    showPreview();
    $("#coverDlg").hidden = true;
    $("#bookResult").textContent = "Obálka je připravená. Nezapomeňte nastavení uložit.";
  } catch (e) {
    alert("Obálku se nepodařilo uložit: " + e.message);
  }
  btn.disabled = false;
}

function stampOf(tx) { return [tx.title, tx.subtitle, tx.author, tx.line].join("|"); }

// downscale big photos before uploading them
async function uploadPhoto(file) {
  const url = URL.createObjectURL(file);
  const im = await loadImg(url);
  if (!im) return "";
  const k = Math.min(1, 2400 / Math.max(im.naturalWidth, im.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
  c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
  return MS.uploadDataUrl(c.toDataURL("image/jpeg", 0.9));
}

// drag to move the photo, wheel to zoom
function initPan() {
  const cv = $("#coverCanvas");
  let drag = null;
  const toCover = (e) => {
    const r = cv.getBoundingClientRect(), unit = W / r.width;
    return { x: (e.clientX - r.left) * unit, y: (e.clientY - r.top) * unit };
  };
  const onText = (p) => textBox && p.x >= textBox.x && p.x <= textBox.x + textBox.w && p.y >= textBox.y && p.y <= textBox.y + textBox.h;
  cv.addEventListener("pointerdown", (e) => {
    const p = toCover(e);
    const inPhoto = photoBox && p.x >= photoBox.x && p.x <= photoBox.x + photoBox.w && p.y >= photoBox.y && p.y <= photoBox.y + photoBox.h;
    if (onText(p) || !picture || design.layout === "text" || !photoBox || (photoBox.free && !inPhoto)) {
      drag = { text: true, x: e.clientX, y: e.clientY, dx: design.dx || 0, dy: design.dy || 0 };
    } else if (photoBox.free && dragMode === "move") {
      drag = { box: true, x: e.clientX, y: e.clientY, fx: design.fx ?? 0.5, fy: design.fy ?? 0.57 };
    } else {
      drag = { x: e.clientX, y: e.clientY, px: design.px, py: design.py };
    }
    cv.setPointerCapture(e.pointerId);
    cv.style.cursor = "grabbing";
  });
  cv.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const unit = W / cv.getBoundingClientRect().width;   // screen px -> cover units
    if (drag.box) {
      const H = SIZES[size];
      design.fx = Math.min(1, Math.max(0, drag.fx + (e.clientX - drag.x) * unit / W));
      design.fy = Math.min(1, Math.max(0, drag.fy + (e.clientY - drag.y) * unit / H));
      if (Math.abs(design.fx - 0.5) < 0.015) design.fx = 0.5;   // snap to the centre line
      redraw();
      return;
    }
    if (drag.text) {
      design.dx = Math.round(drag.dx + (e.clientX - drag.x) * unit);
      design.dy = Math.round(drag.dy + (e.clientY - drag.y) * unit);
      if (Math.abs(design.dx) < 25) design.dx = 0;   // snap back to the centre line
      redraw();
      return;
    }
    const dx = (e.clientX - drag.x) * unit / photoBox.r / photoBox.nw;
    const dy = (e.clientY - drag.y) * unit / photoBox.r / photoBox.nh;
    const visW = photoBox.w / photoBox.r / photoBox.nw / 2, visH = photoBox.h / photoBox.r / photoBox.nh / 2;
    design.px = Math.min(1 - visW, Math.max(visW, drag.px - dx));
    design.py = Math.min(1 - visH, Math.max(visH, drag.py - dy));
    redraw();
  });
  const end = () => { if (drag) { drag = null; cv.style.cursor = "grab"; } };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("wheel", (e) => {
    if (onText(toCover(e)) || !picture || design.layout === "text") {
      e.preventDefault();
      const z = Math.min(140, Math.max(60, +$("#cvSize").value + (e.deltaY < 0 ? 5 : -5)));
      $("#cvSize").value = z; $("#cvSize2").value = Math.min(140, Math.max(60, +$("#cvSize2").value + (e.deltaY < 0 ? 5 : -5)));
      redraw();
      return;
    }
    e.preventDefault();
    const z = Math.min(400, Math.max(100, +$("#cvZoom").value * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
    $("#cvZoom").value = Math.round(z);
    redraw();
  }, { passive: false });
}

// ---------- book settings: preview, upload of a finished cover ----------
function showPreview() {
  const src = $("#coverField").value;
  $("#coverPreview").hidden = !src;
  if (src) $("#coverPreview").src = src;
  $("#coverMake").textContent = parseDesign($("#coverDesignField").value) ? "Upravit obálku…" : "Vytvořit obálku…";
}

// redraws the saved cover when the book's title, subtitle, author or edition changed
async function refresh(st) {
  const d = parseDesign(st.cover_design);
  if (!d || !d.generated) return st;
  const tx = textsFrom(st, d);
  if (d.line != null && d.line !== textsFrom({ publisher: "", series: "" }, d).line && d.stampLine === undefined) tx.line = d.line;
  if (d.stamp === stampOf(tx)) return st;
  const pic = d.layout !== "text" ? await loadImg(d.image) : null;
  const cover = await render("ebook", d, tx, pic);
  const coverPrint = await render("print", d, tx, pic);
  const cover_design = JSON.stringify({ ...d, line: tx.line, stamp: stampOf(tx) });
  return fetch("api/manuscript/settings", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cover, cover_print: coverPrint, cover_design }) }).then((r) => r.json());
}

// thumbnail for the home screen: the designed cover drawn live, an uploaded cover, or a default title cover
function thumbnail(book) {
  const box = document.createElement("div");
  box.className = "home-cover";
  const d = parseDesign(book.cover_design);
  if (book.cover && !(d && d.generated)) {
    box.innerHTML = `<img src="${String(book.cover).replace(/"/g, "&quot;")}" alt="">`;
    return box;
  }
  const des = d || { ...DEFAULT };
  const c = document.createElement("canvas");
  c.width = 240; c.height = Math.round(240 * SIZES.ebook / W);
  box.append(c);
  const tx = textsFrom(book, des);
  if (d && d.line != null) tx.line = d.line;
  draw(c, des, tx, null);
  if (des.layout !== "text" && des.image) loadImg(des.image).then((pic) => { if (pic) draw(c, des, tx, pic); });
  return box;
}

// ---------- wiring ----------
for (const id of ["#cvTitle", "#cvSubtitle", "#cvAuthor", "#cvPublisher", "#cvBg", "#cvBg2", "#cvGrad", "#cvFg", "#cvFg2",
  "#cvFont", "#cvSize", "#cvSize2", "#cvFrame", "#cvFw", "#cvFh", "#cvFeather", "#cvAuthorTop", "#cvLogo", "#cvZoom", "#cvShade", "#cvTextPos"]) {
  $(id).addEventListener("input", redraw);
  $(id).addEventListener("change", redraw);
}
document.querySelectorAll("#cvLayouts button").forEach((b) => b.addEventListener("click", () => {
  design.layout = b.dataset.layout;
  if (design.layout !== "text" && !picture && $("#cvImage").options.length > 1 && !design.image) {
    $("#cvImage").selectedIndex = 1; setPicture($("#cvImage").value);
  } else redraw();
}));
$("#cvImage").addEventListener("change", (e) => { design.px = 0.5; design.py = 0.5; setPicture(e.target.value); });
$("#cvImageFile").addEventListener("click", () => $("#cvFile").click());
$("#cvImageCam").addEventListener("click", () => $("#cvCam").click());
$("#cvImageNone").addEventListener("click", () => { $("#cvImage").value = ""; setPicture(""); });
for (const id of ["#cvFile", "#cvCam"]) {
  $(id).addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const src = await uploadPhoto(f);
    if (!src) return;
    $("#cvImage").insertAdjacentHTML("afterbegin", `<option value="${src.replace(/"/g, "&quot;")}">vlastní fotografie</option>`);
    $("#cvImage").value = src;
    design.px = 0.5; design.py = 0.5; $("#cvZoom").value = 100;
    if (design.layout === "text") design.layout = "full";
    setPicture(src);
  });
}
$("#cvCenter").addEventListener("click", () => { design.px = 0.5; design.py = 0.5; $("#cvZoom").value = 100; redraw(); });
document.querySelectorAll("#cvDragMode button").forEach((b) => b.addEventListener("click", () => { dragMode = b.dataset.mode; redraw(); }));
// box with the picture's own proportions, so nothing is cut off
$("#cvFit").addEventListener("click", () => {
  if (!picture) return;
  const H = SIZES[size];
  let fw = +$("#cvFw").value / 100;
  let fh = fw * W * picture.naturalHeight / picture.naturalWidth / H;
  if (fh > 0.8) { fh = 0.8; fw = fh * H * picture.naturalWidth / picture.naturalHeight / W; }
  $("#cvFw").value = Math.round(fw * 100); $("#cvFh").value = Math.round(fh * 100); $("#cvZoom").value = 100;
  design.px = 0.5; design.py = 0.5;
  redraw();
});
$("#cvFrameReset").addEventListener("click", () => {
  Object.assign(design, { fx: 0.5, fy: 0.57, px: 0.5, py: 0.5 });
  $("#cvFw").value = 70; $("#cvFh").value = 42; $("#cvZoom").value = 100; redraw();
});
$("#cvTextReset").addEventListener("click", () => { design.dx = 0; design.dy = 0; $("#cvSize").value = 100; $("#cvSize2").value = 100; redraw(); });
$("#cvSizeEbook").addEventListener("click", () => { size = "ebook"; $("#cvSizeEbook").classList.add("on"); $("#cvSizePrint").classList.remove("on"); redraw(); });
$("#cvSizePrint").addEventListener("click", () => { size = "print"; $("#cvSizePrint").classList.add("on"); $("#cvSizeEbook").classList.remove("on"); redraw(); });
initPan();
window.addEventListener("resize", () => { if (!$("#coverDlg").hidden) redraw(); });

$("#coverMake").addEventListener("click", openEditor);
$("#coverCancel").addEventListener("click", () => { $("#coverDlg").hidden = true; });
$("#coverSave").addEventListener("click", saveEditor);
$("#coverUpload").addEventListener("click", () => $("#coverFile").click());
$("#coverFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
  $("#coverField").value = await MS.uploadDataUrl(data);
  $("#coverPrintField").value = "";
  const d = parseDesign($("#coverDesignField").value);
  if (d) $("#coverDesignField").value = JSON.stringify({ ...d, generated: false });
  showPreview();
  e.target.value = "";
});
$("#coverRemove").addEventListener("click", () => {
  $("#coverField").value = ""; $("#coverPrintField").value = "";
  const d = parseDesign($("#coverDesignField").value);
  if (d) $("#coverDesignField").value = JSON.stringify({ ...d, generated: false });
  showPreview();
});
// refresh the preview whenever the settings dialog is opened
new MutationObserver(() => { if (!$("#bookDlg").hidden) showPreview(); }).observe($("#bookDlg"), { attributes: true, attributeFilter: ["hidden"] });

// keep a designed cover in step with the title typed in the editor
let titleTimer = null;
const msTitle = $("#msTitle");
if (msTitle) msTitle.addEventListener("input", () => {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(async () => {
    try { await refresh(await fetch("api/manuscript/settings").then((r) => r.json())); } catch (e) { /* ignore */ }
  }, 5000);
});

$("#msEpubBtn").addEventListener("click", async () => {
  if (window.MS && MS.save) await MS.save();
  const a = document.createElement("a");
  a.href = "api/manuscript/epub";
  document.body.append(a); a.click(); a.remove();
  if (window.showToast) window.showToast("E-kniha se stahuje (EPUB). Do Kindlu ji pošlete přes „Send to Kindle“.", 7000);
});

window.Cover = { draw, thumbnail, refresh, open: openEditor };
})();
