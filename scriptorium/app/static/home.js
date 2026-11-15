// Home screen: books being written (each with its own settings), source books and basic help
"use strict";

(() => {
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function currentId() {
  const m = document.cookie.match(/(?:^|;\s*)ms=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "_rukopis";
}

function setCurrent(id) {
  document.cookie = `ms=${encodeURIComponent(id)}; path=/; max-age=31536000; SameSite=Lax`;
}

// switching books always reloads, so the editor can never save into the wrong book
function openBook(id, extra = "") {
  if (window.MS && MS.save) { try { MS.save(); } catch (e) { /* ignore */ } }
  setCurrent(id);
  location.href = location.pathname + "?open=1" + extra;
}

function wordsLabel(n) {
  if (!n) return "zatím prázdná";
  return n.toLocaleString("cs-CZ") + (n === 1 ? " slovo" : n < 5 ? " slova" : " slov");
}

async function render() {
  const [books, sources] = await Promise.all([
    fetch("api/manuscripts").then((r) => r.json()),
    fetch("api/books").then((r) => r.json()),
  ]);
  const cur = currentId();
  const curBook = books.find((b) => b.id === cur) || books[0];
  if (curBook) $("#homeBookTitle").textContent = curBook.title;
  const box = $("#homeBooks");
  box.innerHTML = "";
  for (const b of books) {
    const card = document.createElement("div");
    card.className = "home-card" + (b.id === cur ? " current" : "");
    card.innerHTML = `
      <div class="home-cover-slot"></div>
      <div class="home-meta">
        <h3>${esc(b.title)}</h3>
        ${b.subtitle ? `<div class="home-subt">${esc(b.subtitle)}</div>` : ""}
        <div class="home-info">${esc(b.author || "autor nevyplněn")} · ${wordsLabel(b.words)}${b.updated ? " · upraveno " + esc(b.updated) : ""}</div>
        <div class="home-btns">
          <button class="big primary" data-act="open">${b.id === cur ? "Pokračovat v psaní" : "Otevřít"}</button>
          <button class="big" data-act="settings">Nastavení a tiráž</button>
          <button class="big" data-act="cover">Obálka</button>
        </div>
      </div>`;
    const slot = card.querySelector(".home-cover-slot");
    slot.replaceWith(window.Cover ? Cover.thumbnail(b) : Object.assign(document.createElement("div"), { className: "home-cover", textContent: b.title.slice(0, 1) }));
    card.querySelector('[data-act="open"]').addEventListener("click", () => {
      if (b.id === cur && location.search.includes("open=1")) hide();
      else openBook(b.id, "&cols=text,ms");
    });
    card.querySelector('[data-act="settings"]').addEventListener("click", () => {
      if (b.id === cur && location.search.includes("open=1")) { hide(); openSettings(); }
      else openBook(b.id, "&settings=1");
    });
    const openCover = () => {
      if (b.id === cur && location.search.includes("open=1")) { hide(); openSettings().then(() => Cover.open()); }
      else openBook(b.id, "&settings=1&cover=1");
    };
    card.querySelector('[data-act="cover"]').addEventListener("click", openCover);
    card.querySelector(".home-cover").addEventListener("click", openCover);
    card.querySelector(".home-cover").title = "Upravit obálku";
    box.append(card);
  }
  const add = document.createElement("div");
  add.className = "home-card home-new";
  add.innerHTML = `
    <h3>Nová kniha</h3>
    <label>Název<input id="newTitle" placeholder="např. Mince Českých Budějovic"></label>
    <label>Autor<input id="newAuthor" placeholder="jméno autora"></label>
    <button class="big primary" id="newCreate">Založit knihu</button>`;
  box.append(add);
  $("#newCreate").addEventListener("click", async () => {
    const title = $("#newTitle").value.trim();
    if (!title) { $("#newTitle").focus(); return; }
    const b = await fetch("api/manuscripts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, author: $("#newAuthor").value }) }).then((r) => r.json());
    openBook(b.id, "&cols=text,ms&settings=1");
  });

  const src = $("#homeSources");
  src.innerHTML = sources.map((s) => `<button class="home-source" data-id="${esc(s.id)}"><b>${esc(s.title)}</b><small>${s.pages} stran${s.ocr_running ? " · <span class=\"ocr-run\">čte se text…</span>" : s.empty ? ` · ${s.empty} bez textu` : ""}</small></button>`).join("")
    || '<p class="home-empty">Zatím žádná. Přidejte první knihu tlačítkem <b>Přidat zdrojovou knihu</b>.</p>';
  src.querySelectorAll(".home-source").forEach((btn) => btn.addEventListener("click", () => {
    try { localStorage.setItem("publisher.book", btn.dataset.id); } catch (e) { /* ignore */ }
    if (location.search.includes("open=1")) { hide(); location.hash = btn.dataset.id; location.reload(); }
    else location.href = location.pathname + "?open=1&cols=scan,text#" + encodeURIComponent(btn.dataset.id);
  }));
}

function show() {
  $("#homeClose").hidden = !location.search.includes("open=1");
  $("#home").hidden = false;
  document.body.classList.add("home-open");
  render();
}

function hide() {
  $("#home").hidden = true;
  document.body.classList.remove("home-open");
}

// ---------- book settings ----------
async function openSettings() {
  const [st, sources] = await Promise.all([
    fetch("api/manuscript/settings").then((r) => r.json()),
    fetch("api/books").then((r) => r.json()),
  ]);
  document.querySelectorAll("#bookDlg [data-f]").forEach((el) => {
    const v = st[el.dataset.f];
    if (el.type === "checkbox") el.checked = v !== false;
    else el.value = v ?? "";
  });
  const chosen = new Set(st.sources || []);
  $("#bookSources").innerHTML = sources.map((s) => `<label class="set-check"><input type="checkbox" value="${esc(s.id)}" ${chosen.has(s.id) ? "checked" : ""}> ${esc(s.title)}</label>`).join("")
    + '<small>Vybrané knihy se nabídnou jako první při vkládání transkripcí a použijí se pro seznam pramenů.</small>';
  $("#bookResult").textContent = "";
  $("#bookDlgTitle").textContent = "Nastavení knihy – " + (st.title || "");
  $("#bookDlg").hidden = false;
}

async function saveSettings() {
  const data = {};
  document.querySelectorAll("#bookDlg [data-f]").forEach((el) => { data[el.dataset.f] = el.type === "checkbox" ? el.checked : el.value; });
  data.sources = [...document.querySelectorAll("#bookSources input:checked")].map((i) => i.value);
  if (!data.title.trim()) { $("#bookResult").textContent = "Název knihy nesmí být prázdný."; $("#bookResult").classList.add("error"); return; }
  let st = await fetch("api/manuscript/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then((r) => r.json());
  // a designed cover follows changes of the title, subtitle, author or edition
  if (window.Cover) {
    try {
      st = await Cover.refresh(st);
      for (const f of ["cover", "cover_print", "cover_design"]) { const el = document.querySelector(`#bookDlg [data-f="${f}"]`); if (el) el.value = st[f] || ""; }
    } catch (e) { /* the old cover stays */ }
  }
  // keep the title field of the editor in step
  const t = $("#msTitle");
  if (t && t.value !== st.title) { t.value = st.title; t.dispatchEvent(new Event("input")); }
  $("#homeBookTitle").textContent = st.title;
  $("#bookResult").classList.remove("error");
  $("#bookResult").textContent = "Uloženo.";
  if (window.showToast) window.showToast("Nastavení knihy uloženo.");
}

$("#homeBtn").addEventListener("click", () => ($("#home").hidden ? show() : hide()));
$("#homeClose").addEventListener("click", hide);
$("#homeHelp").addEventListener("click", () => { hide(); $("#helpBtn").click(); });
$("#homeSettings").addEventListener("click", () => { if (window.openSettings) window.openSettings(); });
$("#bookSettingsBtn").addEventListener("click", openSettings);

// ---------- access and change log ----------
const EVENTS = { login: "přihlášení", "login-failed": "neúspěšné přihlášení", logout: "odhlášení", edit: "úprava" };
const evLabel = (e) => (window.T ? T(EVENTS[e] || e) : EVENTS[e] || e);
async function openAudit() {
  const [data, books, sources] = await Promise.all([
    fetch("api/audit").then((r) => r.json()),
    fetch("api/manuscripts").then((r) => r.json()),
    fetch("api/books").then((r) => r.json()),
  ]);
  const names = {};
  books.forEach((b) => { names["ms:" + b.id] = T("rukopis „{title}“", { title: b.title }); });
  sources.forEach((b) => { names["book:" + b.id] = T("transkripce „{title}“", { title: b.title }); });
  const who = (x) => [x.user, x.ip, x.dev, x.fp ? T("zařízení {id}", { id: x.fp.slice(0, 6) }) : ""].filter(Boolean).join(" · ");
  $("#auditMe").textContent = T("Toto zařízení: ") + who(data.me);
  $("#auditList").innerHTML = data.items.length ? data.items.map((x) => {
    const d = new Date(x.t * 1000);
    const when = d.toLocaleDateString("cs-CZ") + " " + d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
    const what = x.ev === "edit" ? (names[x.key] || x.key || "") : (x.ev === "login-failed" ? x.detail || "" : "");
    return `<div class="audit-row ev-${esc(x.ev)}"><b>${esc(when)}</b> <span>${esc(evLabel(x.ev))}${what ? " – " + esc(what) : ""}</span><small>${esc(who(x))}</small></div>`;
  }).join("") : esc(T("Zatím žádné záznamy."));
  $("#auditDlg").hidden = false;
}
$("#homeAudit").addEventListener("click", openAudit);
$("#auditClose").addEventListener("click", () => { $("#auditDlg").hidden = true; });
$("#bookCancel").addEventListener("click", () => { $("#bookDlg").hidden = true; });
$("#bookSave").addEventListener("click", saveSettings);
$("#msTitle").addEventListener("input", (e) => { $("#homeBookTitle").textContent = e.target.value || "Moje knihy"; });

window.Home = { show, hide, openSettings, current: currentId };

// start on the home screen unless a book or view was asked for in the address;
// after switching the interface language the page comes back to what was on screen
const params = new URLSearchParams(location.search);
let reopenHome = false;
try { reopenHome = sessionStorage.getItem("scriptorium.home") === "1"; sessionStorage.removeItem("scriptorium.home"); } catch (e) { /* ignore */ }
if (reopenHome) {
  show();
} else if (params.has("open") || params.has("cols")) {
  fetch("api/manuscripts").then((r) => r.json()).then((books) => {
    const b = books.find((x) => x.id === currentId()) || books[0];
    if (b) $("#homeBookTitle").textContent = b.title;
  });
  if (params.has("settings")) {
    // one-off requests: drop them from the address so a refresh does not open the dialog again
    const clean = new URLSearchParams(location.search);
    clean.delete("settings"); clean.delete("cover");
    history.replaceState(null, "", location.pathname + "?" + clean.toString() + location.hash);
    setTimeout(() => openSettings().then(() => { if (params.has("cover") && window.Cover) Cover.open(); }), 600);
  }
} else {
  show();
}
})();
