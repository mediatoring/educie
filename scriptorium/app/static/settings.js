// Settings dialog: which language model answers in the question column
"use strict";

(() => {
const $ = (s) => document.querySelector(s);
let presets = [];
let state = null;

function preset() { return presets.find((p) => p.id === $("#setPreset").value) || presets[0]; }

function refreshRows() {
  const p = preset();
  const custom = p.id !== "server";
  $("#setUrlRow").hidden = !custom;
  $("#setModelRow").hidden = !custom;
  $("#setKeyRow").hidden = !custom;
  $("#setTlsRow").hidden = !custom;
  $("#setKeyInfo").textContent = state && state.has_key
    ? "Klíč je uložený. Nechte pole prázdné, pokud ho nechcete měnit."
    : (p.needs_key ? "Klíč najdete v účtu u poskytovatele. Uloží se jen na serveru, do prohlížeče se už nevrací." : "U modelu v počítači klíč obvykle není potřeba.");
  if (p.id === "server") $("#setResult").textContent = "Používá se model nastavený na serveru (" + (state ? state.server_model : "") + ").";
}

function applyPreset() {
  const p = preset();
  $("#setUrl").value = p.base_url;
  $("#setModel").value = p.model;
  $("#setResult").textContent = "";
  refreshRows();
}

function form() {
  return {
    preset: $("#setPreset").value,
    base_url: $("#setUrl").value.trim(),
    model: $("#setModel").value.trim(),
    api_key: $("#setKey").value.trim(),
    verify_tls: $("#setTls").checked,
  };
}

function result(t, err) {
  const r = $("#setResult");
  r.textContent = t;
  r.classList.toggle("error", !!err);
}

async function open() {
  const res = await fetch("api/settings");
  state = await res.json();
  presets = state.presets;
  $("#setPreset").innerHTML = presets.map((p) => `<option value="${p.id}">${p.label}</option>`).join("");
  $("#setPreset").value = state.preset;
  $("#setUrl").value = state.base_url;
  $("#setModel").value = state.model;
  $("#setKey").value = "";
  $("#setTls").checked = state.verify_tls !== false;
  result("");
  refreshRows();
  $("#setDlg").hidden = false;
}

async function test() {
  result("Zkouším spojení s modelem…");
  $("#setTest").disabled = true;
  try {
    const r = await fetch("api/settings/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form()) }).then((x) => x.json());
    if (r.ok) result(`Funguje. Model ${r.model || ""} odpověděl za ${r.seconds} s: „${r.reply}“`);
    else result("Nefunguje: " + r.error, true);
  } catch (e) {
    result("Nefunguje: " + e.message, true);
  } finally {
    $("#setTest").disabled = false;
  }
}

async function save() {
  const f = form();
  if (f.preset !== "server" && !/^https?:\/\//.test(f.base_url)) return result("Adresa musí začínat http:// nebo https://", true);
  if (f.preset !== "server" && !f.model) return result("Doplňte název modelu.", true);
  state = await fetch("api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) }).then((x) => x.json());
  $("#setKey").value = "";
  refreshRows();
  result("Uloženo. Další dotazy už půjdou na tento model.");
  if (window.showToast) window.showToast("Nastavení modelu uloženo.");
}

$("#settingsBtn").addEventListener("click", open);
$("#setPreset").addEventListener("change", applyPreset);
$("#setTest").addEventListener("click", test);
$("#setSave").addEventListener("click", save);
$("#setCancel").addEventListener("click", () => { $("#setDlg").hidden = true; });
window.openSettings = open;
})();
