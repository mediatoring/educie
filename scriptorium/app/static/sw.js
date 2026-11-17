// Offline mode: the app and the books that were opened (or downloaded with "Stáhnout pro práci bez
// připojení") stay in the browser, so Scriptorium also opens without internet or on a slow line.
//   app files   network first (max. 4 s), otherwise the stored copy
//   data (api)  network first, the stored copy only when the server cannot be reached
//   pictures    stored copy first (scans and pictures do not change under the same name)
// Saving is not handled here: the pages keep unsent changes themselves (offline.js) and send them later.
"use strict";

const APP = "scriptorium-app-v1";
const DATA = "scriptorium-data-v1";
const IMG = "scriptorium-img-v1";
const SHELL = [
  "./", "style.css", "manuscript.css", "i18n.json", "fp.js", "offline.js", "i18n.js", "app.js", "manuscript.js",
  "gallery.js", "chat.js", "settings.js", "help.js", "home.js", "proof.js", "cover.js", "import.js",
];
// data that is worth keeping for offline work (other requests always go to the server)
const DATA_PATHS = /^api\/(books(\/[^/]+)?|manuscripts|manuscript(\/(settings|comments))?|gallery|me|settings|clips|library)$/;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP);
    await Promise.all(SHELL.map(async (u) => {
      try {
        const res = await fetch(u, { cache: "no-cache" });
        if (res.ok && !res.redirected) await cache.put(u === "./" ? "./" : u, res);
      } catch (e) { /* offline during install: filled in on the next visit */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = [APP, DATA, IMG];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

// messages from the pages: forget everything stored (logout)
self.addEventListener("message", (event) => {
  if (event.data === "clear") event.waitUntil(Promise.all([caches.delete(DATA), caches.delete(IMG)]));
});

function rel(url) {
  const scope = new URL(self.registration.scope);
  return url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : null;
}

const good = (res) => res && res.ok && !res.redirected && res.type === "basic";

async function networkFirst(request, cacheName, key, timeout) {
  const cache = await caches.open(cacheName);
  const net = fetch(request).then(async (res) => {
    if (good(res)) await cache.put(key, res.clone());
    return res;
  });
  try {
    if (!timeout) return await net;
    return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), timeout))]);
  } catch (e) {
    const hit = await cache.match(key);
    if (hit) {
      net.catch(() => {});   // let a slow answer still refresh the stored copy
      return hit;
    }
    return net;              // nothing stored: wait for the network after all (or fail)
  }
}

async function cacheFirst(request, key) {
  const cache = await caches.open(IMG);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(request);
  if (good(res)) await cache.put(key, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = rel(url);
  if (path === null) return;

  // pages: the app shell (one page for every address – the views are chosen by the script)
  if (req.mode === "navigate") {
    if (path !== "" && path !== "index.html") return;   // login, logout, exports go straight to the server
    event.respondWith(networkFirst(req, APP, "./", 4000).catch(async () => (await caches.match("./")) || Response.error()));
    return;
  }
  if (SHELL.includes(path) || path.startsWith("vendor/")) {
    event.respondWith(networkFirst(req, APP, path, 4000));
    return;
  }
  if (path.startsWith("books/")) {
    event.respondWith(cacheFirst(req, path + url.search));
    return;
  }
  if (path.startsWith("api/") && DATA_PATHS.test(path)) {
    event.respondWith(networkFirst(req, DATA, path + url.search, 0).catch(() =>
      new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } })));
  }
});
