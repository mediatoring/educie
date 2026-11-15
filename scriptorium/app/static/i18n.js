// Interface language (Czech, English, German) and light/dark appearance.
// Czech is the source language; other languages come from i18n.json (Czech text -> [en, de]).
"use strict";

(() => {
const LANGS = { cs: "Čeština", en: "English", de: "Deutsch" };
let lang = "cs";
try { lang = localStorage.getItem("publisher.lang") || (navigator.language || "cs").slice(0, 2); } catch (e) { /* ignore */ }
if (!LANGS[lang]) lang = "cs";
let dict = {};
const col = lang === "en" ? 0 : 1;

// user content is never translated
const SKIP = "script, style, textarea, [contenteditable], .text, #msEditor, .ask-answer, .ask-src-text, .gal-cap, .gal-src, .home-meta h3, .home-subt, .home-info, .home-source b, #bookSelect, .lb-caption, .clips, .cv-keep";

// T("Hotovo {n} z {total}", { n: 3, total: 9 }): translation with placeholders filled in
function T(s, vars) {
  let out = s;
  if (lang !== "cs" && s) {
    const hit = dict[s] || dict[String(s).trim()];
    if (hit) out = hit[col];
  }
  if (vars && out) out = String(out).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return out;
}

function translateNode(node) {
  if (lang === "cs") return;
  if (node.nodeType === 3) {
    const p = node.parentElement;
    if (!p || p.closest(SKIP)) return;
    const raw = node.data;
    const key = raw.replace(/\s+/g, " ").trim();
    if (!key || !dict[key] || dict[key][col] === key) return;
    const lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0];
    const out = lead.replace(/\n/g, " ") + dict[key][col] + trail.replace(/\n/g, " ");
    if (out !== raw) node.data = out;
    return;
  }
  if (node.nodeType !== 1 || node.closest(SKIP)) return;
  for (const a of ["title", "placeholder", "aria-label"]) {
    const v = node.getAttribute(a);
    if (v && dict[v.trim()] && dict[v.trim()][col] !== v) node.setAttribute(a, dict[v.trim()][col]);
  }
  for (const child of node.childNodes) translateNode(child);
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("publisher.theme", theme); } catch (e) { /* ignore */ }
  document.querySelectorAll(".theme-toggle").forEach((b) => { b.textContent = theme === "dark" ? T("☀ Světlý režim") : T("☾ Tmavý režim"); });
}

function controls() {
  document.querySelectorAll(".lang-select").forEach((sel) => {
    sel.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${k === lang ? " selected" : ""}>${v}</option>`).join("");
    sel.addEventListener("change", () => {
      try {
        localStorage.setItem("publisher.lang", sel.value);
        const home = document.getElementById("home");
        if (home && !home.hidden) sessionStorage.setItem("scriptorium.home", "1");
      } catch (e) { /* ignore */ }
      location.reload();
    });
  });
  document.querySelectorAll(".theme-toggle").forEach((b) => b.addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")));
  setTheme(document.documentElement.dataset.theme || "light");
}

window.T = T;
window.I18N = { lang, T };
document.documentElement.lang = lang;
try { document.documentElement.dataset.theme = localStorage.getItem("publisher.theme") || "light"; } catch (e) { /* ignore */ }

async function start() {
  if (lang !== "cs") {
    try { dict = await fetch("i18n.json").then((r) => r.json()); } catch (e) { dict = {}; }
    translateNode(document.body);
    document.title = T(document.title);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "characterData") translateNode(m.target);
        else if (m.type === "attributes") translateNode(m.target);
        else m.addedNodes.forEach(translateNode);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["title", "placeholder"] });
  }
  controls();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
