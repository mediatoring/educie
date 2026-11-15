// Device fingerprint for the access and change log: a hash of browser and screen properties
// plus a random id kept in this browser. Stored in the cookie "fp" so the server sees it on every request.
"use strict";

(() => {
function hash(s) {
  // FNV-1a, two rounds with different seeds -> 16 hex characters
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return ((a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0"));
}

function canvasPrint() {
  try {
    const c = document.createElement("canvas");
    c.width = 220; c.height = 40;
    const x = c.getContext("2d");
    x.textBaseline = "top"; x.font = "16px Arial"; x.fillStyle = "#f60"; x.fillRect(100, 1, 60, 20);
    x.fillStyle = "#069"; x.fillText("Scriptorium ěščř 1726", 2, 15);
    return c.toDataURL();
  } catch (e) { return ""; }
}

function glRenderer() {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
  } catch (e) { return ""; }
}

let device = "";
try {
  device = localStorage.getItem("scriptorium.device") || "";
  if (!device) {
    device = Array.from(crypto.getRandomValues(new Uint8Array(4)), (n) => n.toString(16).padStart(2, "0")).join("");
    localStorage.setItem("scriptorium.device", device);
  }
} catch (e) { /* private mode */ }

const parts = [
  navigator.userAgent, navigator.language, (navigator.languages || []).join(","), navigator.platform,
  screen.width + "x" + screen.height + "x" + screen.colorDepth, window.devicePixelRatio,
  Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.hardwareConcurrency, navigator.deviceMemory,
  navigator.maxTouchPoints, glRenderer(), hash(canvasPrint()),
];
const fp = hash(parts.join("|")).slice(0, 12) + (device ? "-" + device : "");
document.cookie = `fp=${fp}; path=/; max-age=31536000; SameSite=Lax`;
window.DEVICE_FP = fp;
})();
