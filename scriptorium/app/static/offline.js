// Work without a connection: registers the service worker (sw.js), shows whether the app is online,
// keeps unsent changes of transcriptions in this browser (IndexedDB "outbox") and sends them once
// the connection is back, and downloads books for offline work in advance.
// The manuscript keeps its own unsent copy (manuscript.js, localStorage) and resends it by itself.
"use strict";

(() => {
const t = (s, v) => (window.T ? window.T(s, v) : s);

// ---------- the open manuscript goes into the address of its data requests ----------
// (the server picks the manuscript by a cookie; stored offline copies must not mix different books)
const origFetch = window.fetch.bind(window);
function msId() {
  const m = document.cookie.match(/(?:^|;\s*)ms=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
window.fetch = (input, init) => {
  if (typeof input === "string" && /^api\/manuscript(\/|\?|$)/.test(input) && !/[?&]ms=/.test(input)) {
    const id = msId();
    if (id) input += (input.includes("?") ? "&" : "?") + "ms=" + encodeURIComponent(id);
  }
  return origFetch(input, init);
};

// ---------- outbox (IndexedDB) ----------
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("scriptorium", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("outbox", { keyPath: "key" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const s = d.transaction("outbox", mode).objectStore("outbox");
    const r = fn(s);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const Outbox = {
  put: (key, item) => tx("readwrite", (s) => s.put({ ...item, key, time: Date.now() })).then(() => { updateBanner(); }),
  get: (key) => tx("readonly", (s) => s.get(key)).catch(() => null),
  all: () => tx("readonly", (s) => s.getAll()).catch(() => []),
  del: (key) => tx("readwrite", (s) => s.delete(key)).then(() => { updateBanner(); }).catch(() => {}),
};

let flushing = false;
async function flush() {
  if (flushing || !navigator.onLine) return;
  const items = await Outbox.all();
  if (!items.length) return;
  flushing = true;
  updateBanner(t("Odesílám změny z doby bez připojení…"));
  let sent = 0, needLogin = false;
  for (const it of items) {
    try {
      const url = it.url + (it.url.includes("?") ? "&" : "?") + "offline=1";
      const res = await origFetch(url, { method: it.method, headers: { "Content-Type": "application/json" }, body: it.body, redirect: "manual" });
      if (res.ok) { await Outbox.del(it.key); sent++; continue; }
      if (res.status === 401 || res.type === "opaqueredirect") { needLogin = true; break; }
      if (res.status === 423) continue;   // the text of the book is being read: next time
    } catch (e) {
      break;                              // the connection dropped again
    }
  }
  flushing = false;
  updateBanner();
  if (sent && window.showToast) window.showToast(t("Změny z doby bez připojení jsou uložené na serveru ({n}). Co se mezitím uložilo jinde, zůstalo v Historii.", { n: sent }), 8000);
  if (needLogin && window.showToast) window.showToast(t("Pro odeslání změn se znovu přihlaste – změny zatím zůstávají v tomto počítači."), 10000);
}

// ---------- banner ----------
function banner() {
  let b = document.getElementById("offlineBanner");
  if (!b) {
    b = document.createElement("div");
    b.id = "offlineBanner";
    b.className = "offline-banner";
    b.hidden = true;
    document.body.prepend(b);
  }
  return b;
}
async function updateBanner(text) {
  const b = banner();
  const waiting = (await Outbox.all()).length;
  if (text) { b.textContent = text; b.hidden = false; b.classList.remove("off"); return; }
  if (!navigator.onLine) {
    b.textContent = t("☁ Bez připojení k internetu. Pracujete s kopií uloženou v tomto počítači; změny se ukládají a odešlou se, jakmile bude připojení zpět. Dotaz a čtení nových knih teď nefungují.");
    b.classList.add("off");
    b.hidden = false;
  } else if (waiting) {
    b.textContent = t("Čeká na odeslání: {n} změněných knih z doby bez připojení.", { n: waiting });
    b.classList.remove("off");
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}

window.addEventListener("online", () => { updateBanner(); flush(); });
window.addEventListener("offline", () => updateBanner());
setInterval(flush, 30000);
document.addEventListener("DOMContentLoaded", () => { updateBanner(); flush(); });
if (document.readyState !== "loading") setTimeout(() => { updateBanner(); flush(); }, 0);

// ---------- service worker ----------
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// logging out forgets the stored books (unsent changes are sent first)
document.addEventListener("click", async (e) => {
  const a = e.target.closest && e.target.closest("a.logout");
  if (!a) return;
  e.preventDefault();
  if ((await Outbox.all()).length) {
    await flush();
    if ((await Outbox.all()).length && !confirm(t("Některé změny z doby bez připojení se ještě neodeslaly. Po odhlášení zůstanou v tomto počítači a odešlou se po dalším přihlášení. Odhlásit?"))) return;
  }
  if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage("clear");
  location.href = a.href;
}, true);

// ---------- download books for offline work ----------
async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + " " + r.status);
  return r.json();
}
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

async function download(full, onProgress) {
  const urls = new Set();
  const steps = ["api/books", "api/manuscripts", "api/gallery", "api/me", "api/settings", "api/library"];
  for (const u of steps) { try { await json(u); } catch (e) { /* not essential */ } }
  const books = await json("api/books");
  for (const b of books) {
    onProgress(t("Načítám knihu {title}…", { title: b.title }), 0, 0);
    const p = await json(`api/books/${encodeURIComponent(b.id)}`);
    for (const page of p.pages || []) {
      if (page.preview) urls.add(`books/${encodeURIComponent(b.id)}/${enc(page.preview)}`);
      if (full && page.scan) urls.add(`books/${encodeURIComponent(b.id)}/${enc(page.scan)}`);
      for (const bl of page.blocks || []) {
        if (bl.type === "image" && bl.src && !bl.pending) urls.add(`books/${encodeURIComponent(b.id)}/${enc(bl.src)}?v=${bl.v || 0}`);
      }
    }
  }
  const mss = await json("api/manuscripts");
  for (const m of mss) {
    const q = "?ms=" + encodeURIComponent(m.id);
    const doc = await json("api/manuscript" + q);
    for (const u of ["api/manuscript/settings" + q, "api/manuscript/comments" + q]) { try { const st = await json(u); if (st && st.cover) urls.add(st.cover); } catch (e) { /* ignore */ } }
    for (const mm of (doc.html || "").matchAll(/src="([^"]+)"/g)) {
      const s = mm[1].replace(/^\/books\//, "books/");
      if (s.startsWith("books/")) urls.add(s);
    }
    if (m.cover) urls.add(m.cover);
  }
  try {
    for (const g of await json("api/gallery")) if (g.src && g.src.startsWith("books/")) urls.add(g.src);
  } catch (e) { /* ignore */ }
  const list = [...urls];
  let done = 0, bytes = 0, failed = 0;
  const worker = async () => {
    while (list.length) {
      const u = list.shift();
      try {
        const r = await fetch(u);
        if (r.ok) bytes += (await r.blob()).size; else failed++;
      } catch (e) { failed++; }
      done++;
      onProgress(t("Stahuji obrázky a skeny: {done} z {total}", { done, total: urls.size }), done, urls.size, bytes);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  try { localStorage.setItem("scriptorium.offlineAt", new Date().toISOString()); } catch (e) { /* ignore */ }
  return { files: urls.size, bytes, failed, books: books.length, manuscripts: mss.length };
}

window.Offline = { Outbox, flush, download, updateBanner, origFetch };
})();
