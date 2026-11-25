// Offline support for the capture page only (scope: /capture).
//
// The page asks this worker to store a copy of itself and of the script files
// it runs on. After that, opening /capture with no signal shows the stored copy.
// Nothing else on the site is touched.
const CACHE = "capture-v1";
const PAGE = "/capture";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function store(urls) {
  const cache = await caches.open(CACHE);
  let stored = 0;
  await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (res.ok && !res.redirected) {
          await cache.put(url, res);
          stored += 1;
        }
      } catch {
        /* no signal right now; it will be stored next time */
      }
    }),
  );
  return stored;
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "store" || !Array.isArray(data.urls)) return;
  const urls = data.urls.filter((u) => typeof u === "string" && (u === PAGE || u.startsWith("/_next/static/")));
  event.waitUntil(
    store(urls).then(async (stored) => {
      const page = await caches.match(PAGE);
      if (event.source) event.source.postMessage({ type: "stored", stored, wanted: urls.length, ready: !!page && stored === urls.length });
    }),
  );
});

const OFFLINE_PAGE =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>Capture</title><body style=\"font:16px system-ui;padding:24px;max-width:32em;margin:auto\">" +
  "<h1>No signal</h1><p>This phone has not stored the capture page yet. Open it once while you have signal " +
  "and wait for it to say it is ready for offline use.</p></body>";

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Script and style files never change once built: the stored copy is always right.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(req, { ignoreSearch: false }).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) caches.open(CACHE).then((cache) => cache.put(req, res.clone()));
            return res;
          }),
      ),
    );
    return;
  }

  // The page itself: fresh when there is signal, the stored copy when there is not.
  if (req.mode === "navigate" && url.pathname === PAGE) {
    event.respondWith(
      fetch(req).catch(async () => {
        const hit = await caches.match(PAGE);
        return hit || new Response(OFFLINE_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }),
    );
  }
});
