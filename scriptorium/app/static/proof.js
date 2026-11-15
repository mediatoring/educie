// Proofreading ("Korektura"): highlights suspicious words and steps through them
// in the transcription of the open source book or in the manuscript.
"use strict";

(() => {
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hasHighlights = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";
const SKIP_KEY = "publisher.proof.skip";

let mode = null;      // "text" | "ms"
let items = [];       // occurrences in reading order
let pos = -1;

function skipped() { try { return new Set(JSON.parse(localStorage.getItem(SKIP_KEY) || "[]")); } catch (e) { return new Set(); } }
function addSkip(id) {
  const s = skipped(); s.add(id);
  try { localStorage.setItem(SKIP_KEY, JSON.stringify([...s].slice(-5000))); } catch (e) { /* ignore */ }
}

const plain = (html) => { const d = document.createElement("div"); d.innerHTML = html || ""; return d.textContent; };
const wordRe = (w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu");

// ---------- collecting ----------
function msBlocks() {
  return [...$("#msEditor").children].filter((n) => !n.classList.contains("var-toc") && !n.classList.contains("var-break"));
}

function collect() {
  if (mode === "text") {
    const p = window.Book.project;
    const out = [];
    p.pages.forEach((page, pi) => page.blocks.forEach((b) => {
      if (b.type !== "text") return;
      for (const field of ["html", "tr"]) {
        if (!b[field]) continue;
        out.push({ key: `${pi}|${b.id}|${field}`, text: plain(b[field]), lang: field === "html" ? (p.lang || "cs") : "cs", pi, block: b.id, field });
      }
    }));
    return out;
  }
  return msBlocks().map((n, i) => ({ key: String(i), text: n.textContent, lang: "cs", index: i }));
}

async function run() {
  const src = collect();
  setInfo("Hledám podezřelá slova…");
  const res = await fetch("api/proof/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: src.map(({ key, text, lang }) => ({ key, text, lang })) }) }).then((r) => r.json());
  const skip = skipped();
  items = [];
  for (const s of src) {
    const found = res[s.key];
    if (!found) continue;
    const occ = [];
    for (const f of found) {
      let n = 0;
      for (const m of s.text.matchAll(wordRe(f.word))) {
        occ.push({ ...s, word: f.word, reason: f.reason, n: n++, at: m.index, text: undefined });
      }
    }
    occ.sort((a, b) => a.at - b.at);
    for (const o of occ) {
      o.id = `${mode === "text" ? window.Book.id : "ms"}|${o.key}|${o.word}|${o.n}`;
      if (!skip.has(o.id)) items.push(o);
    }
  }
  pos = -1;
  if (!items.length) { setInfo("Nenašel jsem žádné podezřelé slovo. 👍"); paintAll(); return; }
  next(1);
}

// ---------- locating in the page ----------
function elementFor(it) {
  if (mode === "text") return document.querySelector(`.block[data-id="${it.block}"] .text[data-field="${it.field}"]`);
  return msBlocks()[it.index] || null;
}

function rangeFor(el, word, n) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let text = "";
  const nodes = [];
  for (let t = walker.nextNode(); t; t = walker.nextNode()) { nodes.push([t, text.length]); text += t.data; }
  let k = 0;
  for (const m of text.matchAll(wordRe(word))) {
    if (k++ !== n) continue;
    const start = m.index, end = m.index + word.length;
    const r = document.createRange();
    for (const [node, off] of nodes) {
      if (start >= off && start <= off + node.data.length) { r.setStart(node, start - off); break; }
    }
    for (const [node, off] of nodes) {
      if (end >= off && end <= off + node.data.length) { r.setEnd(node, end - off); break; }
    }
    return r;
  }
  return null;
}

function paintAll(current) {
  if (!hasHighlights) return;
  const all = new Highlight();
  for (const it of items) {
    if (mode === "text" && it.pi !== window.Book.pageIndex) continue;
    const el = elementFor(it);
    const r = el && rangeFor(el, it.word, it.n);
    if (r) all.add(r);
  }
  CSS.highlights.set("proof-all", all);
  if (current) CSS.highlights.set("proof-cur", new Highlight(current));
  else CSS.highlights.delete("proof-cur");
}

async function show(i) {
  const it = items[i];
  if (!it) return;
  pos = i;
  if (mode === "text") {
    window.ensureColumn("text");
    if (window.Book.pageIndex !== it.pi) { window.Book.goToPage(it.pi); await new Promise((r) => setTimeout(r, 60)); }
    window.Book.selectBlock(it.block);
  }
  const el = elementFor(it);
  const r = el && rangeFor(el, it.word, it.n);
  paintAll(r);
  if (r) {
    const rect = r.getBoundingClientRect();
    const scroller = mode === "text" ? $("#blocks") : $("#msDesk");
    const box = scroller.getBoundingClientRect();
    if (rect.top < box.top + 60 || rect.bottom > box.bottom - 120) scroller.scrollTop += rect.top - box.top - box.height / 3;
  }
  const where = mode === "text" ? ` · strana ${it.pi + 1}` : "";
  setInfo(`<b>${pos + 1} / ${items.length}</b>${where} · „<b>${esc(it.word)}</b>“ – ${esc(it.reason)}`, true);
  $("#proofSugg").innerHTML = '<button class="sugg-load">Navrhnout opravu</button>';
}

function next(dir) {
  if (!items.length) return;
  let i = pos + dir;
  if (i >= items.length) i = 0;
  if (i < 0) i = items.length - 1;
  show(i);
}

function dropCurrent(all = false) {
  const it = items[pos];
  if (!it) return;
  if (all) items = items.filter((x) => x.word.toLowerCase() !== it.word.toLowerCase());
  else items.splice(pos, 1);
  if (!items.length) { pos = -1; paintAll(); setInfo("Hotovo, všechna podezřelá slova jsou vyřešená. 👍"); return; }
  show(Math.min(pos, items.length - 1));
}

async function suggestions() {
  const it = items[pos];
  if (!it) return;
  $("#proofSugg").textContent = "Hledám návrhy…";
  const list = await fetch(`api/proof/suggest?w=${encodeURIComponent(it.word)}&lang=${encodeURIComponent(it.lang)}`).then((r) => r.json());
  const box = $("#proofSugg");
  box.innerHTML = list.length ? "" : "Žádný návrh. Opravte slovo přímo v textu.";
  for (const s of list) {
    const b = document.createElement("button");
    b.textContent = s;
    b.title = "Nahradit slovem " + s;
    b.addEventListener("click", () => replace(s));
    box.append(b);
  }
}

function replace(word) {
  const it = items[pos];
  const el = it && elementFor(it);
  const r = el && rangeFor(el, it.word, it.n);
  if (!r) return;
  r.deleteContents();
  r.insertNode(document.createTextNode(word));
  el.normalize();
  el.dispatchEvent(new Event("input", { bubbles: true }));
  // later occurrences of the same word in this paragraph move one place forward
  items.forEach((x) => { if (x !== it && x.key === it.key && x.word === it.word && x.n > it.n) x.n -= 1; });
  if (window.showToast) window.showToast(`Opraveno na „${word}“.`);
  dropCurrent();
}

async function addWord() {
  const it = items[pos];
  if (!it) return;
  await fetch("api/proof/word", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ word: it.word }) });
  if (window.showToast) window.showToast(`„${it.word}“ je ve slovníku a už se nebude označovat.`);
  dropCurrent(true);
}

function skip() {
  const it = items[pos];
  if (!it) return;
  addSkip(it.id);
  dropCurrent();
}

// ---------- panel ----------
function setInfo(html, active = false) {
  $("#proofInfo").innerHTML = html;
  $("#proofBar").classList.toggle("idle", !active);
}

function start(m) {
  mode = m;
  $("#proofBar").hidden = false;
  $("#proofTitle").textContent = m === "text" ? "Korektura transkripce" : "Korektura rukopisu";
  document.body.classList.add("proofing");
  run();
}

function stop() {
  mode = null; items = []; pos = -1;
  $("#proofBar").hidden = true;
  document.body.classList.remove("proofing");
  if (hasHighlights) { CSS.highlights.delete("proof-all"); CSS.highlights.delete("proof-cur"); }
}

$("#proofTextBtn").addEventListener("click", () => (mode === "text" ? stop() : start("text")));
$("#proofMsBtn").addEventListener("click", () => (mode === "ms" ? stop() : start("ms")));
$("#proofPrev").addEventListener("click", () => next(-1));
$("#proofNext").addEventListener("click", () => next(1));
$("#proofSkip").addEventListener("click", skip);
$("#proofAdd").addEventListener("click", addWord);
$("#proofAgain").addEventListener("click", run);
$("#proofClose").addEventListener("click", stop);
$("#proofSugg").addEventListener("click", (e) => { if (e.target.closest(".sugg-load")) suggestions(); });
// repaint after page changes or edits
document.addEventListener("input", () => { if (mode) setTimeout(() => paintAll(), 30); });
window.Proof = { repaint: () => mode && paintAll(), stop };
})();
