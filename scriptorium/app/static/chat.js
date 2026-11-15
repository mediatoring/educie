// Publisher – questions over the books and the manuscript (answers with sources)
"use strict";

(() => {
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let busy = false;
let ctrl = null;
let sources = [];

// small markdown subset: **bold**, *italic*, bullet lines, paragraphs, [n] citations
function render(md) {
  const lines = esc(md).split(/\n/);
  let html = "", inList = false;
  for (const raw of lines) {
    let l = raw.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<i>$2</i>");
    l = l.replace(/\[(\d+)\]/g, (m, n) => `<button class="cite-chip" data-src="${n}" title="Otevřít zdroj ${n}">${n}</button>`);
    if (/^\s*[*\-•]\s+/.test(raw)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += "<li>" + l.replace(/^\s*[*\-•]\s+/, "") + "</li>";
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (l.trim()) html += "<p>" + l + "</p>";
    }
  }
  return html + (inList ? "</ul>" : "");
}

function openSource(i) {
  const s = sources[i - 1];
  if (!s) return;
  if (s.where === "manuscript") {
    window.ensureColumn("ms");
    const words = s.text.replace(/…/g, "").split(/\s+/).slice(3, 9);
    setTimeout(() => MS.scrollToMatch(words, 0), 50);
  } else {
    window.openBookBlock(s.book, s.page, s.block);
  }
}

function renderSources() {
  const box = $("#askSources");
  box.innerHTML = sources.length ? "<h3>Použité zdroje</h3>" : "";
  sources.forEach((s, i) => {
    const div = document.createElement("div");
    div.className = "ask-src";
    div.innerHTML = `<div class="ask-src-head"><span class="cite-chip static">${i + 1}</span> ${esc(s.label)}</div>
      <div class="ask-src-text">${esc(s.text)}</div>`;
    const act = document.createElement("div");
    act.className = "ask-src-act";
    const open = document.createElement("button");
    open.textContent = "Otevřít";
    open.addEventListener("click", () => openSource(i + 1));
    const quote = document.createElement("button");
    quote.textContent = "❝ Jako citace do rukopisu";
    quote.addEventListener("click", () => {
      window.ensureColumn("ms");
      MS.insertHtml(`<blockquote><p>${esc(s.text.replace(/^…|…$/g, ""))}</p><p class="cite">(${esc(s.label)})</p></blockquote>`, "Citace vložena do rukopisu.");
    });
    act.append(open, quote);
    div.append(act);
    box.append(div);
  });
}

async function ask() {
  const q = $("#askInput").value.trim();
  if (!q || busy) return;
  busy = true;
  $("#askBtn").disabled = true;
  $("#askClear").textContent = "Zastavit";
  $("#askAnswer").innerHTML = "";
  $("#askToMs").hidden = true;
  sources = [];
  renderSources();
  setStatus("Hledám v knihách a rukopisu…");
  let text = "";
  const started = Date.now();
  const timer = setInterval(() => {
    if (sources.length && !text) setStatus(`Model čte ${sources.length} úryvků a připravuje odpověď… ${Math.round((Date.now() - started) / 1000)} s (obvykle do 1–2 minut)`);
  }, 1000);
  try {
    ctrl = new AbortController();
    const res = await fetch("api/chat", { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!chunk.startsWith("data:")) continue;
        const ev = JSON.parse(chunk.slice(5));
        if (ev.type === "sources") { sources = ev.sources; renderSources(); }
        else if (ev.type === "delta") { text += ev.text; $("#askAnswer").innerHTML = render(text); setStatus("Píšu odpověď…"); }
        else if (ev.type === "error") { setStatus(ev.text, true); }
        else if (ev.type === "done") { setStatus(`Hotovo za ${Math.round((Date.now() - started) / 1000)} s.`); }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") setStatus(text ? "Odpověď zastavena." : "Dotaz zrušen.");
    else setStatus("Spojení se přerušilo: " + e.message, true);
  } finally {
    clearInterval(timer);
    ctrl = null;
    busy = false;
    $("#askClear").textContent = "Nový dotaz";
    $("#askBtn").disabled = false;
    $("#askToMs").hidden = !text;
    $("#askAnswer").dataset.md = text;
  }
}

function setStatus(t, err = false) {
  const s = $("#askStatus");
  s.textContent = t;
  s.classList.toggle("error", err);
}

function clearAsk() {
  if (ctrl) { ctrl.abort(); return; }
  $("#askInput").value = "";
  $("#askAnswer").innerHTML = "";
  $("#askAnswer").dataset.md = "";
  $("#askToMs").hidden = true;
  sources = [];
  renderSources();
  setStatus("Odpověď vzniká jen z přepsaných knih a rukopisu a u každého tvrzení je číslo zdroje.");
  $("#askInput").focus();
}

function init() {
  $("#askClear").addEventListener("click", clearAsk);
  $("#askBtn").addEventListener("click", ask);
  $("#askInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } });
  $("#askAnswer").addEventListener("click", (e) => { const b = e.target.closest(".cite-chip"); if (b) openSource(parseInt(b.dataset.src, 10)); });
  $("#askToMs").addEventListener("click", () => {
    window.ensureColumn("ms");
    const html = $("#askAnswer").innerHTML.replace(/<button class="cite-chip"[^>]*>(\d+)<\/button>/g, "[$1]");
    const list = sources.map((s, i) => `[${i + 1}] ${esc(s.label)}`).join("<br>");
    MS.insertHtml(`<div>${html}</div><p class="note"><small>${list}</small></p>`, "Odpověď vložena do rukopisu.");
  });
}

init();
})();
