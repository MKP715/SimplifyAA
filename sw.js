/*
 * SimplifyAA service worker.
 *
 * Two jobs:
 *   1. Make the page installable and usable offline, so the index works on a
 *      phone with no signal at a meeting.
 *   2. Notice when aa.org has new documents and say so.
 *
 * On job 2, one thing is worth being clear about. This site is static -- there
 * is no server that can send a push message -- so notifications are produced
 * by this worker waking up and checking data/changes.json itself, using
 * Periodic Background Sync. That genuinely runs with no tab open, but only
 * where the browser supports it (Chrome and Edge, and only once the app is
 * installed). Everywhere else the same check runs whenever the app is opened,
 * which still reports everything that arrived in between -- it just cannot
 * arrive unprompted. See the notification settings in the app for what the
 * current device supports.
 */

const VERSION = "v1";
const SHELL_CACHE = "simplifyaa-shell-" + VERSION;
const DATA_CACHE = "simplifyaa-data-" + VERSION;
const CDN_CACHE = "simplifyaa-cdn-" + VERSION;

const SHELL = [
  "./",
  "./index.html",
  "./site.webmanifest",
  "./favicon.svg",
  "./favicon.ico",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
];
const DATA_FILES = [
  "./data/pdfs.csv",
  "./data/meta.json",
  "./data/kits.csv",
  "./data/changes.json",
];

const CHECK_TAG = "simplifyaa-check-new";

/* ------------------------------ tiny IndexedDB ---------------------------- */
/* Shared shape with the page: a key/value "state" store and a "notifications"
   log. Kept deliberately small rather than pulling in a library. */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("simplifyaa", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("state")) db.createObjectStore("state");
      if (!db.objectStoreNames.contains("notifications")) {
        db.createObjectStore("notifications", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(store, key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

function idbSet(store, key, value) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    // The notifications store uses an in-line key, state uses an out-of-line one.
    const r = key === undefined ? os.add(value) : os.put(value, key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

/* --------------------------------- install -------------------------------- */
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // Individually, so one 404 cannot fail the whole install.
    await Promise.all(SHELL.map((u) =>
      shell.add(new Request(u, { cache: "reload" })).catch(() => {})));
    const data = await caches.open(DATA_CACHE);
    await Promise.all(DATA_FILES.map((u) =>
      data.add(new Request(u, { cache: "reload" })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, DATA_CACHE, CDN_CACHE];
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("simplifyaa-") && !keep.includes(n))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* ---------------------------------- fetch --------------------------------- */
const isData = (url) => /\/data\/.+\.(csv|json)$/i.test(url.pathname);
const isPdf = (url) => /\.pdf(\?|$)/i.test(url.pathname + url.search);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never cache the documents themselves -- they are large and belong to aa.org.
  if (isPdf(url)) return;

  // Navigations: serve the app shell when offline.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (e) {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match("./index.html")) ||
               (await cache.match("./")) ||
               new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // The index itself: fresh when possible, cached copy when not.
  if (url.origin === self.location.origin && isData(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      try {
        const res = await fetch(req, { cache: "no-store" });
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        throw e;
      }
    })());
    return;
  }

  // Same-origin assets: cache first, they change only on release.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return new Response("", { status: 504 });
      }
    })());
    return;
  }

  // Libraries and fonts from the CDNs: cache first so the app opens offline.
  if (/(^|\.)jsdelivr\.net$|(^|\.)cdnjs\.cloudflare\.com$|(^|\.)gstatic\.com$/
        .test(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CDN_CACHE);
      const hit = await cache.match(req);
      if (hit) {
        // Refresh quietly for next time.
        fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); })
          .catch(() => {});
        return hit;
      }
      const res = await fetch(req);
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
      return res;
    })());
  }
});

/* ------------------------- checking for new documents --------------------- */
async function fetchChanges() {
  const res = await fetch("./data/changes.json?cb=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("changes.json " + res.status);
  return res.json();
}

function summarise(runs) {
  const added = [];
  runs.forEach((r) => (r.added || []).forEach((a) => added.push(a)));
  return added;
}

/**
 * Compare the newest run against what this device has already been told about.
 * Returns the notification record if one was raised.
 */
async function checkForNewDocuments(reason) {
  let data;
  try {
    data = await fetchChanges();
  } catch (e) {
    return null;
  }
  const runs = data.runs || [];
  if (!runs.length) return null;

  const seen = (await idbGet("state", "lastSeenRun").catch(() => null)) || "";
  const fresh = runs.filter((r) => r.generated_utc > seen && !r.first_run);
  const newest = runs[0].generated_utc;

  // Remember where we got to even when there is nothing to say, so the next
  // check does not re-report the same run.
  await idbSet("state", "lastSeenRun", newest).catch(() => {});
  await idbSet("state", "lastCheck", new Date().toISOString()).catch(() => {});

  const addedCount = fresh.reduce((n, r) => n + (r.added_count || 0), 0);
  if (!seen || addedCount === 0) return null;   // first sight: set the baseline only

  const items = summarise(fresh).slice(0, 8);
  const titles = items.slice(0, 3).map((a) =>
    (a.item_code ? a.item_code + " " : "") + a.title);
  const body = titles.join("\n") +
    (addedCount > titles.length ? "\nand " + (addedCount - titles.length) + " more" : "");

  const record = {
    time: new Date().toISOString(),
    runTime: newest,
    count: addedCount,
    title: addedCount === 1 ? "1 new document on aa.org"
                            : addedCount + " new documents on aa.org",
    body: body,
    items: items,
    reason: reason || "check",
    read: false,
  };
  await idbSet("notifications", undefined, record).catch(() => {});

  if (self.registration && Notification.permission === "granted") {
    await self.registration.showNotification(record.title, {
      body: body,
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      tag: "simplifyaa-new-" + newest,
      renotify: false,
      data: { url: "./#view=new" },
    }).catch(() => {});
  }

  // Tell any open tab so its bell updates without a reload.
  const clientList = await self.clients.matchAll({ includeUncontrolled: true });
  clientList.forEach((c) => c.postMessage({ type: "new-documents", record: record }));
  return record;
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === CHECK_TAG) {
    event.waitUntil(checkForNewDocuments("periodicsync"));
  }
});

// One-off background sync, used as a fallback where periodic sync is missing.
self.addEventListener("sync", (event) => {
  if (event.tag === CHECK_TAG) {
    event.waitUntil(checkForNewDocuments("sync"));
  }
});

// If a real push service is ever put in front of this, the payload is optional:
// the worker re-checks the index either way.
self.addEventListener("push", (event) => {
  event.waitUntil(checkForNewDocuments("push"));
});

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "check-now") {
    event.waitUntil((async () => {
      const record = await checkForNewDocuments("manual");
      if (event.source) {
        event.source.postMessage({ type: "check-complete", record: record || null });
      }
    })());
  }
  if (msg.type === "skip-waiting") self.skipWaiting();
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.registration.scope)) {
        await c.focus();
        c.postMessage({ type: "show-new" });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
