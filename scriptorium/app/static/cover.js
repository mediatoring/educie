// Cover designer and cover field in the book settings; EPUB download button
"use strict";

(() => {
const $ = (s) => document.querySelector(s);
const W = 1600, H = 2560;   // e-book cover size (1 : 1.6)
let picture = null;          // HTMLImageElement used on the cover

function field(name) { return document.querySelector(`#bookDlg [data-f="${name}"]`); }

function showCoverPreview() {
  const src = $("#coverField").value;
  $("#coverPreview").hidden = !src;
  if (src) $("#coverPreview").src = src;
}

// wrap text into lines that fit the width
function lines(ctx, text, maxW) {
  const out = [];
  let line = "";
  for (const w of String(text || "").split(/\s+/)) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

function drawCover(canvas) {
  const ctx = canvas.getContext("2d");
  const k = canvas.width / W;
  ctx.save();
  ctx.scale(k, k);
  const layout = $("#cvLayout").value, bg = $("#cvBg").value, fg = $("#cvFg").value, font = $("#cvFont").value;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const pic = layout !== "text" ? picture : null;
  const cover = (x, y, w, h) => {
    const r = Math.max(w / pic.naturalWidth, h / pic.naturalHeight);
    const sw = w / r, sh = h / r;
    ctx.drawImage(pic, (pic.naturalWidth - sw) / 2, (pic.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
  };
  let textTop = 1700;
  if (pic && layout === "top") { cover(0, 0, W, 1550); textTop = 1700; }
  if (pic && layout === "full") {
    cover(0, 0, W, H);
    const g = ctx.createLinearGradient(0, H * 0.45, 0, H);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.75)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    textTop = 1650;
  }
  if (pic && layout === "frame") {
    const fw = 1100, fh = 1100 * Math.min(1.1, pic.naturalHeight / pic.naturalWidth);
    ctx.fillStyle = fg; ctx.fillRect((W - fw) / 2 - 18, 760 - 18, fw + 36, fh + 36);
    ctx.drawImage(pic, (W - fw) / 2, 760, fw, fh);
    textTop = 220;
  }
  if (!pic) textTop = 700;
  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  let y = textTop;
  const author = $("#cvAuthor").value.trim();
  if (author && layout !== "frame") { ctx.font = `64px ${font}`; ctx.fillText(author.toUpperCase(), W / 2, y); y += 130; }
  ctx.font = `bold 120px ${font}`;
  for (const l of lines(ctx, $("#cvTitle").value, W - 220)) { ctx.fillText(l, W / 2, y); y += 140; }
  const sub = $("#cvSubtitle").value.trim();
  if (sub) { y += 20; ctx.font = `italic 64px ${font}`; for (const l of lines(ctx, sub, W - 260)) { ctx.fillText(l, W / 2, y); y += 84; } }
  if (author && layout === "frame") { y += 40; ctx.font = `64px ${font}`; ctx.fillText(author.toUpperCase(), W / 2, y); }
  const pub = $("#cvPublisher").value.trim();
  if (pub) { ctx.font = `48px ${font}`; ctx.globalAlpha = 0.85; ctx.fillText(pub, W / 2, H - 150); ctx.globalAlpha = 1; }
  ctx.restore();
}

function redraw() { drawCover($("#coverCanvas")); }

function loadPicture(src) {
  if (!src) { picture = null; redraw(); return; }
  const img = new Image();
  img.onload = () => { picture = img; redraw(); };
  img.src = src;
}

async function openDesigner() {
  $("#cvTitle").value = field("title").value;
  $("#cvSubtitle").value = field("subtitle").value;
  $("#cvAuthor").value = field("author").value;
  $("#cvPublisher").value = [field("publisher").value, field("series").value].filter(Boolean).join(" · ");
  const items = await fetch("api/gallery").then((r) => r.json());
  const sel = $("#cvImage");
  sel.innerHTML = '<option value="">– bez obrázku –</option>' + items.slice(0, 300).map((it) =>
    `<option value="${it.src.replace(/"/g, "&quot;")}">${(it.caption || it.where || it.src).slice(0, 70).replace(/</g, "")}</option>`).join("");
  $("#coverDlg").hidden = false;
  loadPicture(sel.value);
}

async function saveDesigned() {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  drawCover(c);
  try {
    const src = await MS.uploadDataUrl(c.toDataURL("image/jpeg", 0.9));
    $("#coverField").value = src;
    showCoverPreview();
    $("#coverDlg").hidden = true;
    $("#bookResult").textContent = "Obálka je připravená. Nezapomeňte nastavení uložit.";
  } catch (e) {
    alert("Obálku se nepodařilo uložit: " + e.message);
  }
}

for (const id of ["#cvLayout", "#cvTitle", "#cvSubtitle", "#cvAuthor", "#cvPublisher", "#cvBg", "#cvFg", "#cvFont"]) {
  $(id).addEventListener("input", redraw);
}
$("#cvImage").addEventListener("change", (e) => loadPicture(e.target.value));
$("#cvImageFile").addEventListener("click", () => $("#cvFile").click());
$("#cvFile").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) loadPicture(URL.createObjectURL(f)); });
$("#coverMake").addEventListener("click", openDesigner);
$("#coverCancel").addEventListener("click", () => { $("#coverDlg").hidden = true; });
$("#coverSave").addEventListener("click", saveDesigned);
$("#coverUpload").addEventListener("click", () => $("#coverFile").click());
$("#coverFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
  $("#coverField").value = await MS.uploadDataUrl(data);
  showCoverPreview();
  e.target.value = "";
});
$("#coverRemove").addEventListener("click", () => { $("#coverField").value = ""; showCoverPreview(); });
// refresh the preview whenever the settings dialog is opened
new MutationObserver(() => { if (!$("#bookDlg").hidden) showCoverPreview(); }).observe($("#bookDlg"), { attributes: true, attributeFilter: ["hidden"] });

$("#msEpubBtn").addEventListener("click", async () => {
  if (window.MS && MS.save) await MS.save();
  const a = document.createElement("a");
  a.href = "api/manuscript/epub";
  document.body.append(a); a.click(); a.remove();
  if (window.showToast) window.showToast("E-kniha se stahuje (EPUB). Do Kindlu ji pošlete přes „Send to Kindle“.", 7000);
});
})();
