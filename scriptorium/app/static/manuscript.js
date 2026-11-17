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
        } else if (n === "class" && /^(cite|src|var-toc|var-break|fn|cmt)$/.test(a.value)) {
          // keep our classes (citation, automatic parts, footnote, comment)
        } else if (n === "data-c" && child.tagName === "SPAN" && /^[a-z0-9]{4,12}$/.test(a.value)) {
          // keep citation class
        } else if (n === "data-origin" && child.tagName === "IMG" && /^[\w\-. ]+\/[\w\-. ]+$/.test(a.value)) {
          // which scan page the image was cut from (book/file), for cropping again from the original
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
  // automatic parts are stored as empty markers and generated again on display / export
  d.querySelectorAll("div.var-toc").forEach((el) => { el.innerHTML = "Obsah"; });
  d.querySelectorAll("div.var-break").forEach((el) => { el.innerHTML = "Zlom strany"; });
  return sanitize(d).innerHTML;
}

// insert an automatic block after the paragraph with the cursor (plain DOM, no execCommand)
function insertMarker(cls, message) {
  restoreSelection();
  const sel = window.getSelection();
  let anchor = sel.rangeCount && editor.contains(sel.anchorNode) ? sel.anchorNode : null;
  while (anchor && anchor.parentNode !== editor) anchor = anchor.parentNode;
  const box = document.createElement("div");
  box.className = cls;
  const after = document.createElement("p");
  after.innerHTML = "<br>";
  if (anchor) anchor.after(box); else editor.append(box);
  box.after(after);
  const r = document.createRange();
  r.setStart(after, 0); r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
  markDirty();
  refreshToc();
  toast(message, 6000, () => { box.remove(); if (!after.textContent.trim()) after.remove(); markDirty(); refreshToc(); });
}

// ---------- whole transcripts of source books ----------
let trSaved = null;
async function openTranscripts() {
  $("#insMenu").hidden = true;
  trSaved = savedRange;
  const books = await fetch("api/books").then((r) => r.json());
  const langName = { de: "němčina", en: "angličtina", la: "latina" };
  $("#trBooks").innerHTML = books.map((b) => `<label class="set-check"><input type="checkbox" value="${b.id}" data-lang="${b.lang ? escT(b.lang) : ""}"> ${b.title.replace(/[<&]/g, "")} <small>(${b.pages} str.${b.lang ? ", " + T(langName[b.lang] || b.lang) + T(" s českým překladem") : ""})</small></label>`).join("");
  // the language choice matters only for books with a translation
  const syncLang = () => { $("#trLangRow").hidden = !$("#trBooks").querySelector("input[data-lang]:not([data-lang='']):checked"); };
  $("#trBooks").onchange = syncLang;
  syncLang();
  $("#trResult").textContent = "";
  $("#trDlg").hidden = false;
}

const escT = (t) => String(t || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function transcriptHtml(bookId, opts) {
  const p = await fetch("api/books/" + encodeURIComponent(bookId)).then((r) => r.json());
  const short = (p.title || bookId).replace(/\s*\(.*\)\s*$/, "");
  let out = `<h1>${escT(short)}</h1>`;
  if (opts.sources) out += `<p class="cite">(Zdroj: ${escT(p.title || bookId)})</p>`;
  for (const [pi, page] of p.pages.entries()) {
    for (const b of page.blocks) {
      if (b.type === "image") {
        if (!opts.images || !b.src) continue;
        try {
          const r = await fetch("api/manuscript/copy-image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ book: bookId, src: b.src }) }).then((x) => x.json());
          const label = `${short}${page.page_no ? ", s. " + page.page_no : ""}`;
          out += `<figure><img src="${r.src}" style="width:${b.width || 70}%"><figcaption>${escT(b.caption || "")}<span class="src">Zdroj: ${escT(b.source || label)}</span></figcaption></figure>`;
        } catch (e) { /* skip image */ }
        continue;
      }
      let body = b.html || escT(b.text || "");
      // books with a translation: original, translation, or both (the translation follows in italics, same kind of block)
      let second = "";
      if (p.lang && b.tr && b.tr.replace(/<[^>]+>/g, "").trim()) {
        if (opts.lang === "tr") body = b.tr;
        else if (opts.lang === "both") second = `<i>${b.tr}</i>`;
      }
      if (!body.replace(/<[^>]+>/g, "").trim()) continue;
      let st = b.style;
      const plainText = body.replace(/<[^>]+>/g, "").trim();
      // the title page and lines like "JINDŘICH TEISINGER," are not chapter headings
      if ((st === "h1" || st === "h2" || st === "h3") && (pi === 0 || /[,:;]$/.test(plainText) || /^\S*\d{4}\.?$/.test(plainText))) st = pi === 0 ? "center" : null;
      const wrap = (h) => {
        if (st === "center") return `<p style="text-align:center">${h}</p>`;
        if (st === "h1" || st === "h2") return `<h2>${h}</h2>`;
        if (st === "h3") return `<h3>${h}</h3>`;
        if (st === "note") return `<p><small>${h}</small></p>`;
        if (st === "quote") return `<blockquote><p>${h}</p></blockquote>`;
        return `<p>${h}</p>`;
      };
      out += wrap(body);
      if (second) out += st === "h1" || st === "h2" || st === "h3" ? `<p style="text-align:center">${second}</p>` : wrap(second);
    }
  }
  return out;
}

async function insertTranscripts() {
  const ids = [...document.querySelectorAll("#trBooks input:checked")].map((i) => i.value);
  if (!ids.length) { $("#trResult").textContent = "Vyberte aspoň jednu knihu."; return; }
  const opts = { images: $("#trImages").checked, sources: $("#trSources").checked, lang: $("#trLang").value };
  $("#trOk").disabled = true;
  let html = "";
  try {
    for (let i = 0; i < ids.length; i++) {
      $("#trResult").textContent = `Připravuji ${i + 1}. knihu z ${ids.length}…`;
      html += await transcriptHtml(ids[i], opts);
    }
  } finally { $("#trOk").disabled = false; }
  $("#trDlg").hidden = true;
  savedRange = trSaved;
  insertFragment(html, `Vloženo ${ids.length === 1 ? "1 kniha" : ids.length + " knih(y)"} do rukopisu.`);
}

// insert larger HTML after the paragraph with the cursor (plain DOM; undo removes it again)
function insertFragment(html, message) {
  restoreSelection();
  const sel = window.getSelection();
  let anchor = sel.rangeCount && editor.contains(sel.anchorNode) ? sel.anchorNode : null;
  while (anchor && anchor.parentNode !== editor) anchor = anchor.parentNode;
  const tmp = document.createElement("div");
  tmp.innerHTML = cleanHtml(html);
  const nodes = [...tmp.childNodes];
  const frag = document.createDocumentFragment();
  nodes.forEach((n) => frag.append(n));
  if (anchor) anchor.after(frag); else editor.append(frag);
  if (nodes[0] && nodes[0].scrollIntoView) nodes[0].scrollIntoView({ block: "start" });
  markDirty();
  refreshToc();
  toast(message, 8000, () => { nodes.forEach((n) => n.remove()); markDirty(); refreshToc(); });
}

// pasted paragraphs, chapters and pictures go in as whole blocks: in front of the paragraph when the
// cursor is at its start (or the paragraph is empty, which they replace), otherwise after it
function pasteBlocks(container) {
  const sel = window.getSelection();
  if (sel.rangeCount && !sel.isCollapsed) document.execCommand("delete");
  const tmp = document.createElement("div");
  tmp.innerHTML = cleanHtml(container.innerHTML);
  const nodes = [...tmp.childNodes].filter((n) => (n.nodeType === 1 && n.tagName !== "BR") || (n.nodeType !== 1 && n.textContent.trim()));
  if (!nodes.length) return;
  const range = sel.rangeCount ? sel.getRangeAt(0) : null;
  const block = range && editor.contains(range.startContainer) ? topOf(range.startContainer) : null;
  const frag = document.createDocumentFragment();
  nodes.forEach((n) => frag.append(n));
  if (!block) {
    editor.append(frag);
  } else if (!block.textContent.trim() && !block.querySelector("img")) {
    block.replaceWith(frag);
  } else {
    const head = document.createRange();
    head.selectNodeContents(block);
    head.setEnd(range.startContainer, range.startOffset);
    if (!head.toString().trim()) block.before(frag); else block.after(frag);
  }
  const last = nodes[nodes.length - 1];
  const after = document.createRange();
  after.setStartAfter(last);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
  markDirty();
  refreshToc();
}

// render the automatic table of contents and page breaks inside the editor
function renderVars() {
  renderMarks();
  const heads = [...editor.querySelectorAll("h1, h2, h3")].filter((h) => h.textContent.trim());
  editor.querySelectorAll("div.var-toc").forEach((box) => {
    box.contentEditable = "false";
    const items = heads.map((h) => `<li class="l${h.tagName[1]}">${h.textContent.trim().replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</li>`).join("");
    box.innerHTML = `<div class="var-label">Obsah – vytváří se sám z kapitol</div><ol>${items || "<li>Zatím žádné kapitoly</li>"}</ol>`;
  });
  editor.querySelectorAll("div.var-break").forEach((box) => {
    box.contentEditable = "false";
    box.innerHTML = '<span class="var-label">Nová stránka – další text začne na nové straně</span>';
  });
}

// ---------- footnotes and comments ----------
// Footnote: <span class="fn">text</span> where the number belongs; the editor shows only the number.
// Comment: <span class="cmt" data-c="id">commented text</span>; the comment itself lives in comments.json.
const marks = { comments: [], tab: "outline" };
function renderMarks() {
  const fns = [...editor.querySelectorAll("span.fn")];
  fns.forEach((s, i) => { s.contentEditable = "false"; s.dataset.n = i + 1; s.title = T("Poznámka {n}: {text}", { n: i + 1, text: s.textContent }); });
  const byId = new Map(marks.comments.map((c) => [c.id, c]));
  editor.querySelectorAll("span.cmt").forEach((s) => {
    const c = byId.get(s.dataset.c);
    s.classList.toggle("resolved", !c || c.resolved);
    s.title = c && !c.resolved ? T("Komentář: {text}", { text: c.text }) : "";
  });
  renderNotesList(fns);
  renderCommentsList();
}

function renderNotesList(fns) {
  $("#fnCount").textContent = fns.length || "";
  const box = $("#notesList");
  box.innerHTML = fns.length ? "" : '<div class="empty">Zatím žádné poznámky pod čarou. Klikněte do textu a v nástrojích zvolte <b>Poznámka</b>.</div>';
  fns.forEach((s, i) => {
    const d = document.createElement("div");
    d.className = "side-card note-card";
    d.innerHTML = `<b>${i + 1}.</b> ${escT(s.textContent)}`;
    d.addEventListener("click", () => { s.scrollIntoView({ behavior: "smooth", block: "center" }); flash(s); editFootnote(s); });
    box.append(d);
  });
}

function renderCommentsList() {
  const open = marks.comments.filter((c) => !c.resolved);
  $("#cmtCount").textContent = open.length || "";
  const box = $("#cmtList");
  box.innerHTML = marks.comments.length ? "" : '<div class="empty">Zatím žádné komentáře. Označte v rukopisu text a v nástrojích zvolte <b>Komentář</b>.</div>';
  const list = [...open, ...marks.comments.filter((c) => c.resolved)];
  for (const c of list) {
    const span = editor.querySelector(`span.cmt[data-c="${c.id}"]`);
    const d = document.createElement("div");
    d.className = "side-card cmt-card" + (c.resolved ? " done" : "");
    d.dataset.c = c.id;
    d.innerHTML = `<div class="cmt-quote">${span ? "„" + escT(c.quote) + "“" : "<i>" + escT(T("Označený text byl z rukopisu smazán.")) + "</i>"}</div>
      <div class="cmt-text">${escT(c.text)}</div>
      <div class="cmt-meta">${escT(c.author || "")} · ${escT(c.time)}${c.resolved ? " · " + escT(T("vyřešeno")) : ""}</div>
      ${(c.replies || []).map((r) => `<div class="cmt-reply"><div>${escT(r.text)}</div><div class="cmt-meta">${escT(r.author || "")} · ${escT(r.time)}</div></div>`).join("")}
      <div class="cmt-acts">
        ${c.resolved ? '<button data-a="reopen">Znovu otevřít</button>' : '<button data-a="reply">Odpovědět</button><button data-a="resolve">✓ Vyřešeno</button>'}
        <button data-a="delete" class="danger">Smazat</button>
      </div>`;
    d.addEventListener("click", async (e) => {
      const a = e.target.dataset.a;
      if (!a) { if (span) { span.scrollIntoView({ behavior: "smooth", block: "center" }); flash(span); } return; }
      if (a === "reply") {
        noteDialog({ title: "Odpověď na komentář", quote: c.text, author: true, ok: (text, author) => commentAction(c.id, { action: "reply", text, author }) });
        return;
      }
      if (a === "delete") {
        if (!confirm(T("Smazat komentář? Text v rukopisu zůstane, jen se přestane zvýrazňovat."))) return;
        if (span) { span.replaceWith(...span.childNodes); markDirty(); }
      }
      await commentAction(c.id, { action: a, author: myName() });
    });
    box.append(d);
  }
}

function myName() { try { return localStorage.getItem("scriptorium.name") || ""; } catch (e) { return ""; } }

async function commentAction(id, body) {
  marks.comments = await fetch(`api/manuscript/comments/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  renderMarks();
}

async function loadComments() {
  marks.comments = await fetch("api/manuscript/comments").then((r) => r.json()).catch(() => []);
  renderMarks();
}

function flash(node) {
  node.classList.add("mark-flash");
  setTimeout(() => node.classList.remove("mark-flash"), 1600);
}

function showSide(tab) {
  marks.tab = tab;
  document.querySelectorAll("#sideTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelectorAll("#msOutline .side-pane").forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  $("#msOutline").classList.toggle("wide", tab === "comments");
  if ($("#msOutline").classList.contains("closed") || $("#msOutline").classList.contains("auto-closed")) $("#outlineToggle").click();
}

// one dialog for footnotes, comments and replies
function noteDialog({ title, label = "Text", quote = "", text = "", author = false, remove = null, ok }) {
  $("#noteTitle").textContent = T(title);
  $("#noteLabel").textContent = T(label);
  $("#noteQuote").hidden = !quote;
  $("#noteQuote").textContent = quote ? "„" + quote + "“" : "";
  $("#noteText").value = text;
  $("#noteAuthorL").hidden = !author;
  $("#noteAuthor").value = myName();
  $("#noteDelete").hidden = !remove;
  $("#noteDlg").hidden = false;
  setTimeout(() => $("#noteText").focus(), 50);
  const close = () => { $("#noteDlg").hidden = true; $("#noteOk").onclick = $("#noteDelete").onclick = $("#noteCancel").onclick = null; };
  $("#noteCancel").onclick = close;
  $("#noteDelete").onclick = () => { close(); remove(); };
  $("#noteOk").onclick = () => {
    const t = $("#noteText").value.trim();
    if (!t) { $("#noteText").focus(); return; }
    if (author) { try { localStorage.setItem("scriptorium.name", $("#noteAuthor").value.trim()); } catch (e) { /* ignore */ } }
    close();
    ok(t, $("#noteAuthor").value.trim());
  };
}

function insertFootnote() {
  const range = savedRange && editor.contains(savedRange.startContainer) ? savedRange.cloneRange() : null;
  if (!range) { toast(T("Klikněte do textu rukopisu tam, kam patří číslo poznámky, a pak na Poznámka.")); return; }
  noteDialog({
    title: "Poznámka pod čarou",
    label: "Text poznámky – v tisku a PDF bude dole na stránce, v e-knize na konci kapitoly",
    ok: (text) => {
      range.collapse(false);
      const s = document.createElement("span");
      s.className = "fn";
      s.textContent = text;
      range.insertNode(s);
      const after = document.createRange();
      after.setStartAfter(s);
      after.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(after);
      savedRange = after.cloneRange();
      markDirty();
      renderMarks();
      toast(T("Poznámka pod čarou vložena."));
    },
  });
}

function editFootnote(s) {
  noteDialog({
    title: T("Poznámka pod čarou {n}", { n: s.dataset.n || "" }),
    label: "Text poznámky",
    text: s.textContent,
    remove: () => { s.remove(); markDirty(); renderMarks(); toast(T("Poznámka odstraněna.")); },
    ok: (text) => { s.textContent = text; markDirty(); renderMarks(); },
  });
}

function addComment() {
  const range = savedRange && editor.contains(savedRange.startContainer) ? savedRange.cloneRange() : null;
  if (!range || range.collapsed || !range.toString().trim()) { toast(T("Nejdřív v rukopisu označte text, ke kterému chcete napsat komentář.")); return; }
  // a comment marks text inside one paragraph
  const blockOf = (n) => (n.nodeType === 1 ? n : n.parentElement).closest("p, h1, h2, h3, li, blockquote, figcaption");
  const b0 = blockOf(range.startContainer);
  if (b0 && !b0.contains(range.endContainer)) range.setEnd(b0, b0.childNodes.length);
  const quote = range.toString().trim().replace(/\s+/g, " ").slice(0, 300);
  noteDialog({
    title: "Komentář",
    label: "Komentář – do tisku ani e-knihy se nedostane",
    quote, author: true,
    ok: async (text, author) => {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(4)), (n) => n.toString(16).padStart(2, "0")).join("");
      const span = document.createElement("span");
      span.className = "cmt";
      span.dataset.c = id;
      span.append(range.extractContents());
      range.insertNode(span);
      markDirty();
      marks.comments = await fetch("api/manuscript/comments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, quote, text, author }) }).then((r) => r.json());
      save();
      renderMarks();
      showSide("comments");
    },
  });
}

function initMarks() {
  $("#fnBtn").addEventListener("mousedown", (e) => e.preventDefault());
  $("#cmtBtn").addEventListener("mousedown", (e) => e.preventDefault());
  $("#fnBtn").addEventListener("click", () => { rememberSelection(); insertFootnote(); });
  $("#cmtBtn").addEventListener("click", () => { rememberSelection(); addComment(); });
  document.querySelectorAll("#sideTabs button").forEach((b) => b.addEventListener("click", () => showSide(b.dataset.tab)));
  editor.addEventListener("click", (e) => {
    const fn = e.target.closest && e.target.closest("span.fn");
    if (fn) { e.preventDefault(); editFootnote(fn); return; }
    const cm = e.target.closest && e.target.closest("span.cmt:not(.resolved)");
    if (cm) {
      showSide("comments");
      const card = document.querySelector(`#cmtList .cmt-card[data-c="${cm.dataset.c}"]`);
      if (card) { card.scrollIntoView({ behavior: "smooth", block: "nearest" }); flash(card); }
    }
  });
  loadComments();
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
  renderVars();
  const heads = [...editor.querySelectorAll("h1, h2, h3")].filter((h) => h.textContent.trim());
  renderOutline(heads);
  for (const toc of [$("#toc")]) {
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

// ---------- moving chapters and page breaks from the outline ----------
// A chapter is its heading plus everything up to the next heading of the same or a higher level
// (a subchapter moves inside its chapter). A "new page" mark right before a heading moves with it.
const headLevel = (el) => (el && el.nodeType === 1 && /^H[1-3]$/.test(el.tagName) ? +el.tagName[1] : 0);
const isBreak = (el) => el && el.nodeType === 1 && el.classList.contains("var-break");

function topOf(node) {
  let n = node;
  while (n && n.parentElement !== editor) n = n.parentElement;
  return n;
}

function sectionOf(item) {
  const top = topOf(item);
  if (!top) return null;
  if (isBreak(top)) return { nodes: [top], level: 0, start: top, end: top };
  const level = headLevel(top) || 3;
  const nodes = [];
  const prev = top.previousElementSibling;
  if (isBreak(prev)) nodes.push(prev);
  nodes.push(top);
  let n = top.nextSibling;
  while (n) {
    const lv = headLevel(n);
    if (lv && lv <= level) break;
    if (isBreak(n) && headLevel(n.nextElementSibling) && headLevel(n.nextElementSibling) <= level) break;
    nodes.push(n);
    n = n.nextSibling;
  }
  return { nodes, level, start: nodes[0], end: nodes[nodes.length - 1] };
}

function moveSection(item, dir) {
  const sec = sectionOf(item);
  if (!sec) return false;
  const before = editor.innerHTML;
  if (sec.level === 0) {
    // a page break steps over one block
    const el = sec.start;
    const sib = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    if (!sib) return false;
    if (dir < 0) sib.before(el); else sib.after(el);
  } else if (dir < 0) {
    // the previous section of the same level; a higher-level heading on the way is the chapter's start
    let n = sec.start.previousElementSibling;
    while (n && !(headLevel(n) && headLevel(n) <= sec.level)) n = n.previousElementSibling;
    if (!n || headLevel(n) < sec.level) return false;
    const target = sectionOf(n);
    target.start.before(...sec.nodes);
  } else {
    let n = sec.end.nextElementSibling;
    if (isBreak(n) && headLevel(n.nextElementSibling)) n = n.nextElementSibling;
    if (!n || !headLevel(n) || headLevel(n) < sec.level) return false;
    const target = sectionOf(n);
    target.end.after(...sec.nodes);
  }
  afterMove(item, before);
  return true;
}

function moveSectionBefore(item, targetItem) {
  const sec = sectionOf(item);
  const target = sectionOf(targetItem);
  if (!sec || !target || sec.nodes.includes(target.start) || sec.nodes.includes(topOf(targetItem))) return;
  const before = editor.innerHTML;
  target.start.before(...sec.nodes);
  afterMove(item, before);
}

// the heading of the chapter a node is in (the nearest heading above it)
function headingAt(node) {
  let n = topOf(node);
  while (n && !headLevel(n)) n = n.previousElementSibling;
  return n;
}

let lastMove = null;
editor.addEventListener("input", () => { lastMove = null; });

function afterMove(item, before) {
  const undo = () => { lastMove = null; editor.innerHTML = before; renderVars(); markDirty(); refreshToc(); toast(T("Přesun vrácen.")); };
  lastMove = undo;
  markDirty();
  refreshToc();
  renderMarks();
  const el = topOf(item) || item;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  flash(el);
  toast(T(headLevel(el) ? "Kapitola přesunuta." : "Nová stránka přesunuta."), 7000, undo);
}

function renderOutline(heads) {
  const box = $("#outline");
  box.innerHTML = "";
  const items = [...editor.querySelectorAll("h1, h2, h3, div.var-break")].filter((n) => isBreak(n) || n.textContent.trim());
  if (!heads.length) { box.innerHTML = '<div class="empty">' + escT(T("Zatím žádné kapitoly. Nadpis kapitoly nastavíte v nabídce typu odstavce.")) + "</div>"; }
  let hi = 0;
  for (const node of items) {
    const row = document.createElement("div");
    const brk = isBreak(node);
    row.className = "ol-row " + (brk ? "ol-break" : "l" + node.tagName[1]);
    row.draggable = true;
    const a = document.createElement("a");
    if (brk) {
      a.textContent = "↧ " + T("Nová stránka");
    } else {
      a.className = "l" + node.tagName[1];
      a.dataset.i = hi++;
      a.textContent = node.textContent.trim();
    }
    a.title = a.textContent;
    a.addEventListener("click", () => { node.scrollIntoView({ behavior: "smooth", block: "start" }); });
    const up = document.createElement("button");
    up.className = "ol-mv"; up.textContent = "▲"; up.title = T(brk ? "Posunout novou stránku výš" : "Přesunout kapitolu výš");
    const down = document.createElement("button");
    down.className = "ol-mv"; down.textContent = "▼"; down.title = T(brk ? "Posunout novou stránku níž" : "Přesunout kapitolu níž");
    up.addEventListener("click", (e) => { e.stopPropagation(); if (!moveSection(node, -1)) toast(T(brk ? "Výš už to nejde." : "Výš to nejde – je první ve své kapitole.")); });
    down.addEventListener("click", (e) => { e.stopPropagation(); if (!moveSection(node, 1)) toast(T(brk ? "Níž už to nejde." : "Níž to nejde – je poslední ve své kapitole.")); });
    row.append(a, up, down);
    // drag with the mouse: drop onto another item to put this chapter in front of it
    row.addEventListener("dragstart", (e) => { outlineDrag = node; row.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", ""); });
    row.addEventListener("dragend", () => { outlineDrag = null; row.classList.remove("dragging"); box.querySelectorAll(".over").forEach((r) => r.classList.remove("over")); });
    row.addEventListener("dragover", (e) => { if (outlineDrag && outlineDrag !== node) { e.preventDefault(); row.classList.add("over"); } });
    row.addEventListener("dragleave", () => row.classList.remove("over"));
    row.addEventListener("drop", (e) => { e.preventDefault(); row.classList.remove("over"); if (outlineDrag && outlineDrag !== node) moveSectionBefore(outlineDrag, node); });
    box.append(row);
  }
  if (items.length) {
    const hint = document.createElement("div");
    hint.className = "ol-hint";
    hint.textContent = T("Šipkami ▲ ▼ přesunete kapitolu i s jejím textem. Myší lze kapitolu přetáhnout na jiné místo.");
    box.append(hint);
  }
}
let outlineDrag = null;

// highlight the chapter currently on screen in the outline
function markCurrentHeading() {
  const desk = $("#msDesk");
  const heads = [...editor.querySelectorAll("h1, h2, h3")].filter((h) => h.textContent.trim());
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

// change every paragraph touched by the selection (works for one or many paragraphs)
function setBlockType(tag) {
  editor.focus();
  restoreSelection();
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const top = (n) => { while (n && n.parentNode !== editor) n = n.parentNode; return n; };
  const first = top(range.startContainer), last = top(range.endContainer);
  if (!first) return;
  const blocks = [];
  for (let n = first; n; n = n.nextElementSibling) {
    blocks.push(n);
    if (n === last || !last) break;
  }
  const textTags = ["P", "H1", "H2", "H3", "BLOCKQUOTE", "DIV"];
  const changed = [];
  for (const b of blocks) {
    if (!textTags.includes(b.tagName) || b.classList.contains("var-toc") || b.classList.contains("var-break") || b.querySelector("img")) continue;
    if (b.tagName === tag.toUpperCase()) { changed.push(b); continue; }
    const nb = document.createElement(tag);
    if (b.tagName === "BLOCKQUOTE" && b.children.length) nb.innerHTML = [...b.children].map((c) => c.innerHTML).join("<br>");
    else nb.innerHTML = b.innerHTML;
    if (tag === "blockquote") nb.innerHTML = `<p>${nb.innerHTML}</p>`;
    const align = b.style.textAlign;
    if (align) nb.style.textAlign = align;
    b.replaceWith(nb);
    changed.push(nb);
  }
  if (changed.length) {
    const r = document.createRange();
    r.setStartBefore(changed[0]);
    r.setEndAfter(changed[changed.length - 1]);
    sel.removeAllRanges();
    sel.addRange(r);
    savedRange = r.cloneRange();
  }
  markDirty();
  updateToolbar();
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
    div.innerHTML = `<div class="t">${when}</div><div class="l">${escapeHtml(it.label || "")} · ${it.words} slov</div>`
      + (it.who && window.whoText ? `<div class="hist-who">${escapeHtml(whoText(it.who))}</div>` : "");
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
const crop = { img: null, target: null, angle: 0, rotated: null, rect: null, scale: 1, sepia: 0, origin: null, quad: null, persp: false };

function cropFilter() {
  const f = `brightness(${$("#adjBright").value}%) contrast(${$("#adjContrast").value}%) saturate(${$("#adjSat").value}%)` + (crop.sepia ? ` sepia(${crop.sepia}%)` : "");
  return f === "brightness(100%) contrast(100%) saturate(100%)" ? "none" : f;
}
function applyAdjust() { $("#cropCanvas").style.filter = cropFilter(); }
function resetAdjust() {
  $("#adjBright").value = 100; $("#adjContrast").value = 100; $("#adjSat").value = 100; crop.sepia = 0; applyAdjust();
}

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
  if (keepRect === "scale" && crop.rect && crop.prevScale) {
    const f = crop.scale / crop.prevScale;
    crop.rect = { x: crop.rect.x * f, y: crop.rect.y * f, w: crop.rect.w * f, h: crop.rect.h * f };
  }
  if (!keepRect || !crop.rect) crop.rect = { x: 0, y: 0, w: cv.width, h: cv.height };
  crop.rect.w = Math.min(crop.rect.w, cv.width); crop.rect.h = Math.min(crop.rect.h, cv.height);
  crop.rect.x = Math.max(0, Math.min(crop.rect.x, cv.width - crop.rect.w)); crop.rect.y = Math.max(0, Math.min(crop.rect.y, cv.height - crop.rect.h));
  crop.prevScale = crop.scale;
  placeCropRect();
  if (crop.persp) resetQuad();
  $("#rotValue").textContent = crop.angle.toFixed(1).replace(".", ",") + "°";
  const fine = crop.angle - Math.round(crop.angle / 90) * 90;
  $("#rotFine").value = fine.toFixed(1);
}

// ---------- perspective: four corners dragged onto the corners of the picture ----------
function resetQuad() {
  const r = crop.rect;
  crop.quad = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  drawQuad();
}

function drawQuad() {
  const svg = $("#perspSvg"), cv = $("#cropCanvas");
  svg.setAttribute("viewBox", `0 0 ${cv.width} ${cv.height}`);
  svg.querySelector("polygon").setAttribute("points", crop.quad.map((p) => p.join(",")).join(" "));
  svg.querySelectorAll("circle").forEach((c, i) => { c.setAttribute("cx", crop.quad[i][0]); c.setAttribute("cy", crop.quad[i][1]); });
}

function setPersp(on) {
  crop.persp = on;
  $("#perspSvg").toggleAttribute("hidden", !on);
  $("#cropRect").hidden = on;
  $("#cropPersp").classList.toggle("on", on);
  $("#cropPersp").textContent = T(on ? "✓ Srovnávám perspektivu – zpět na obdélník" : "Srovnat perspektivu (4 rohy)");
  if (on) resetQuad();
}

// projective mapping of the unit square onto a quadrilateral (Heckbert): (0,0)->p0, (1,0)->p1, (1,1)->p2, (0,1)->p3
function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, d = y1 - y0 + g * y1, e = y3 - y0 + h * y3;
  return (u, v) => { const w = g * u + h * v + 1; return [(a * u + b * v + x0) / w, (d * u + e * v + y0) / w]; };
}

// cuts the quadrilateral out of the source canvas and straightens it into a rectangle
function warpQuad(src, quad) {
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  let ow = Math.round((dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2);
  let oh = Math.round((dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2);
  const lim = Math.min(1, 4000 / Math.max(ow, oh));
  ow = Math.max(1, Math.round(ow * lim)); oh = Math.max(1, Math.round(oh * lim));
  const sw = src.width, sh = src.height;
  const sdata = src.getContext("2d").getImageData(0, 0, sw, sh).data;
  const out = document.createElement("canvas");
  out.width = ow; out.height = oh;
  const octx = out.getContext("2d");
  const img = octx.createImageData(ow, oh);
  const d = img.data;
  const map = squareToQuad(quad);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let [sx, sy] = map((x + 0.5) / ow, (y + 0.5) / oh);
      sx -= 0.5; sy -= 0.5;
      const o = (y * ow + x) * 4;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) { d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = 255; continue; }
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        const top = sdata[i00 + c] * (1 - fx) + sdata[i10 + c] * fx;
        const bot = sdata[i01 + c] * (1 - fx) + sdata[i11 + c] * fx;
        d[o + c] = top * (1 - fy) + bot * fy;
      }
      d[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// ---------- the original scan page ----------
async function findOrigin(img) {
  const key = img.dataset.origin || img.getAttribute("src").split("?")[0];
  try {
    const info = await fetch("api/manuscript/image-origin?src=" + encodeURIComponent(key)).then((r) => r.json());
    return info.found ? info : null;
  } catch (e) { return null; }
}

function loadOriginal() {
  const o = crop.origin;
  if (!o) return;
  const im = new Image();
  im.onload = () => {
    crop.img = im;
    crop.angle = (o.rotate || 0) + 90 * (o.quarter || 0);
    crop.loadedOriginal = true;
    crop.rect = null;
    drawCropPreview(false);
    // put the frame where the image was cut out (crop is in scan pixels before rotation, rotated about its centre)
    if (o.crop) {
      const [x, y, w, h] = o.crop;
      const rad = crop.angle * Math.PI / 180;
      const cx = x + w / 2 - im.naturalWidth / 2, cy = y + h / 2 - im.naturalHeight / 2;
      const rx = cx * Math.cos(rad) - cy * Math.sin(rad) + crop.rotated.width / 2;
      const ry = cx * Math.sin(rad) + cy * Math.cos(rad) + crop.rotated.height / 2;
      const odd = (o.quarter || 0) % 2;
      const rw = odd ? h : w, rh = odd ? w : h, s = crop.scale;
      crop.rect = { x: (rx - rw / 2) * s, y: (ry - rh / 2) * s, w: rw * s, h: rh * s };
      drawCropPreview(true);
    }
    $("#cropOriginInfo").textContent = o.page_no
      ? T("Původní strana: {title}, s. {n}. Rámeček můžete rozšířit.", { title: o.title, n: o.page_no })
      : T("Původní strana: {title}, {n}. strana skenu. Rámeček můžete rozšířit.", { title: o.title, n: o.page + 1 });
    $("#cropOrigin").disabled = true;
  };
  im.src = o.scan;
}

function placeCropRect() {
  const r = crop.rect, n = $("#cropRect");
  Object.assign(n.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
}

async function openCrop(img) {
  crop.target = img;
  crop.angle = 0;
  crop.rect = null;
  crop.loadedOriginal = false;
  setPersp(false);
  resetAdjust();
  $("#cropOrigin").hidden = true;
  $("#cropOrigin").disabled = false;
  $("#cropOriginInfo").textContent = "";
  crop.origin = null;
  findOrigin(img).then((o) => {
    crop.origin = o;
    $("#cropOrigin").hidden = !o;
    if (!o) $("#cropOriginInfo").textContent = "";
  });
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
  // corners of the perspective frame
  const svg = $("#perspSvg");
  svg.querySelectorAll("circle").forEach((c, i) => c.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    const cv = $("#cropCanvas");
    const move = (ev) => {
      const r = cv.getBoundingClientRect(), k = cv.width / r.width;
      crop.quad[i] = [Math.max(0, Math.min(cv.width, (ev.clientX - r.left) * k)), Math.max(0, Math.min(cv.height, (ev.clientY - r.top) * k))];
      drawQuad();
    };
    const up = () => { c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up); };
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
  }));
  $("#cropPersp").addEventListener("click", () => setPersp(!crop.persp));
  $("#cropOrigin").addEventListener("click", loadOriginal);
  let fineTimer = 0;
  $("#rotFine").addEventListener("input", () => {
    cancelAnimationFrame(fineTimer);
    fineTimer = requestAnimationFrame(() => {
      crop.angle = Math.round(crop.angle / 90) * 90 + parseFloat($("#rotFine").value);
      drawCropPreview("scale");
    });
  });
  document.querySelectorAll("[data-rot]").forEach((b) => b.addEventListener("click", () => {
    crop.angle = Math.round((crop.angle + parseFloat(b.dataset.rot)) * 10) / 10;
    drawCropPreview(Math.abs(parseFloat(b.dataset.rot)) < 90 ? "scale" : false);
  }));
  $("#cropReset").addEventListener("click", () => { crop.angle = 0; setPersp(false); drawCropPreview(false); });
  for (const id of ["#adjBright", "#adjContrast", "#adjSat"]) $(id).addEventListener("input", applyAdjust);
  $("#adjGray").addEventListener("click", () => { $("#adjSat").value = 0; crop.sepia = 0; applyAdjust(); });
  $("#adjSepia").addEventListener("click", () => { $("#adjSat").value = 100; crop.sepia = crop.sepia ? 0 : 70; applyAdjust(); });
  $("#adjReset").addEventListener("click", resetAdjust);
  $("#cropCancel").addEventListener("click", () => { $("#cropDlg").hidden = true; });
  $("#cropApply").addEventListener("click", async () => {
    const s = crop.scale, r = crop.rect;
    const out = document.createElement("canvas");
    const octx = out.getContext("2d");
    if (crop.persp) {
      $("#cropApply").disabled = true;
      await new Promise((res) => setTimeout(res, 30));
      const flat = warpQuad(crop.rotated, crop.quad.map(([x, y]) => [x / s, y / s]));
      out.width = flat.width; out.height = flat.height;
      octx.filter = cropFilter();
      octx.drawImage(flat, 0, 0);
      $("#cropApply").disabled = false;
    } else {
      out.width = Math.round(r.w / s); out.height = Math.round(r.h / s);
      octx.filter = cropFilter();
      octx.drawImage(crop.rotated, r.x / s, r.y / s, r.w / s, r.h / s, 0, 0, out.width, out.height);
    }
    const blob = await new Promise((res) => out.toBlob(res, "image/jpeg", 0.92));
    const src = await uploadImage(new File([blob], "crop.jpg", { type: "image/jpeg" }));
    if (src) {
      crop.target.setAttribute("src", src);
      if (crop.origin && !crop.target.dataset.origin) crop.target.dataset.origin = crop.origin.book + "/" + crop.origin.file;
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
  $("#blockStyle").addEventListener("change", (e) => { setBlockType(e.target.value); refreshToc(); });
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
  $("#insertBtn").addEventListener("mousedown", rememberSelection);
  $("#insertBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const m = $("#insMenu");
    if (!m.hidden) { m.hidden = true; return; }
    const r = $("#insertBtn").getBoundingClientRect();
    m.hidden = false;
    Object.assign(m.style, { left: Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 12)) + "px", top: r.bottom + 6 + "px" });
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#insMenu")) $("#insMenu").hidden = true; });
  $("#insToc").addEventListener("click", () => {
    $("#insMenu").hidden = true;
    if (editor.querySelector("div.var-toc")) { window.showToast("Obsah už v rukopisu je."); editor.querySelector("div.var-toc").scrollIntoView({ block: "center" }); return; }
    insertMarker("var-toc", "Obsah vložen. Sám se doplní podle kapitol.");
  });
  $("#insTr").addEventListener("click", openTranscripts);
  $("#trCancel").addEventListener("click", () => { $("#trDlg").hidden = true; });
  $("#trOk").addEventListener("click", insertTranscripts);
  $("#insBreak").addEventListener("click", () => {
    $("#insMenu").hidden = true;
    insertMarker("var-break", "Nová stránka vložena.");
  });
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
  const setOutline = (open) => { $("#msOutline").classList.toggle("closed", !open); if (open) $("#msOutline").classList.remove("auto-closed"); try { localStorage.setItem(outlineKey, open ? "1" : "0"); } catch (e) { /* ignore */ } };
  setOutline((localStorage.getItem(outlineKey) || "1") === "1");
  $("#outlineToggle").addEventListener("click", () => setOutline($("#msOutline").classList.contains("closed") || $("#msOutline").classList.contains("auto-closed")));
  // in a narrow column the outline folds away so the page keeps a readable width
  new ResizeObserver(() => {
    const w = $("#colMs").clientWidth;
    $("#msOutline").classList.toggle("auto-closed", w > 0 && w < 760);
  }).observe($("#colMs"));
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
      // our own pictures (copied inside the app come as full addresses) stay, pasted data: images
      // are uploaded, pictures from other sites are dropped
      const own = new URL("books/", document.baseURI).href;
      for (const img of [...d.querySelectorAll("img")]) {
        const src = img.getAttribute("src") || "";
        if (src.startsWith("data:")) {
          const blob = await (await fetch(src)).blob();
          const url = await uploadImage(new File([blob], "paste", { type: blob.type }));
          if (url) img.setAttribute("src", url); else img.remove();
        } else if (src.startsWith(own)) {
          img.setAttribute("src", "books/" + src.slice(own.length));
        } else if (!src.startsWith("books/")) {
          img.remove();
        }
      }
      // a copied comment mark stays only when the text was cut (moved), not when it is duplicated
      d.querySelectorAll("span.cmt").forEach((s) => {
        if (editor.querySelector(`span.cmt[data-c="${s.dataset.c}"]`)) s.replaceWith(...s.childNodes);
      });
      if (d.querySelector("p, h1, h2, h3, h4, figure, ul, ol, blockquote, div.var-break, div.var-toc, table")) pasteBlocks(d);
      else exec("insertHTML", sanitize(d).innerHTML);
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
  $("#msExportBtn").addEventListener("click", async () => {
    await save();
    const a = document.createElement("a");
    a.href = "api/manuscript/export?download=1";
    document.body.append(a); a.click(); a.remove();
    window.showToast("Rukopis se stahuje jako soubor HTML (otevře se v prohlížeči i ve Wordu).", 6000);
  });
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
    // move the chapter the cursor is in: Alt+Shift+↑/↓ on Windows, Ctrl+Shift+↑/↓ on a Mac
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.shiftKey && (mac ? e.ctrlKey && !e.altKey && !e.metaKey : e.altKey && !e.ctrlKey)) {
      const sel = window.getSelection();
      if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
      e.preventDefault();
      const head = headingAt(sel.anchorNode);
      if (!head) { toast(T("Kurzor není v žádné kapitole.")); return; }
      if (!moveSection(head, e.key === "ArrowUp" ? -1 : 1)) toast(T(e.key === "ArrowUp" ? "Výš to nejde – je první ve své kapitole." : "Níž to nejde – je poslední ve své kapitole."));
      return;
    }
    // Ctrl+Z / ⌘Z right after a move undoes the move
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && lastMove && editor.contains(document.activeElement || editor)) {
      e.preventDefault();
      lastMove();
      return;
    }
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
  initMarks();
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
