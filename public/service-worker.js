const CACHE_NAME = "sift-shell-v2";
const CORE_FILES = [
  "/manifest.webmanifest",
  "/assets/brand-mark.png",
  "/assets/brand-192.png",
  "/assets/brand-512.png",
  "/assets/brand-maskable-512.png",
  "/assets/brand-apple-180.png",
  "/assets/compass.png",
];

function assetsInStylesheet(stylesheet) {
  return [...stylesheet.matchAll(/url\(["']?(\/[^"')\s]+)["']?\)/g)]
    .map((match) => match[1])
    .filter((path) => path.startsWith("/assets/"));
}

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

async function appDocument(response) {
  if (!response || !response.ok || !sameOrigin(new URL(response.url))) return false;
  if (!(response.headers.get("content-type") || "").includes("text/html")) return false;
  return (await response.clone().text()).includes('name="sift-app" content="sift-card-sorter"');
}

async function safeAppResponse(request) {
  const response = await fetch(request);
  if (await appDocument(response)) return response;
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const response = await fetch("/", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    });
    if (!(await appDocument(response))) {
      throw new Error("Sift was not available at the app root; the service worker has not cached a sign-in page.");
    }
    await cache.put("/", response.clone());
    const html = await response.text();
    const referencedAssets = [...html.matchAll(/(?:src|href)="(\/[^"?#]+\.(?:js|css))"/g)]
      .map((match) => match[1]);
    const queue = [...new Set([...CORE_FILES, ...referencedAssets])];
    const visited = new Set();
    while (queue.length) {
      const path = queue.shift();
      if (visited.has(path)) continue;
      visited.add(path);
      const url = new URL(path, self.location.origin);
      if (!sameOrigin(url)) continue;
      try {
        const asset = await fetch(url, { cache: "no-store", credentials: "same-origin" });
        if (asset.ok && sameOrigin(new URL(asset.url)) && !(asset.headers.get("content-type") || "").includes("text/html")) {
          const stylesheet = /\.css(?:$|\?)/.test(url.pathname)
            ? await asset.clone().text()
            : null;
          await cache.put(url, asset);
          if (stylesheet !== null) {
            queue.push(...assetsInStylesheet(stylesheet));
          }
        }
      } catch {
        // Cache what is available. Live server access is required for sorting.
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("sift-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || !sameOrigin(url) || url.pathname.startsWith("/api/")) return;
  // These documents are public legal/help pages. Keep them network-only and
  // never substitute the authenticated app shell for them while offline.
  if (request.mode === "navigate" && (url.pathname === "/privacy" || url.pathname === "/support")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await safeAppResponse(request);
        if (await appDocument(response)) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("/", response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match("/");
        return cached || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.includes("/assets/") || /\.(?:js|css|webmanifest)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && sameOrigin(new URL(response.url)) && !(response.headers.get("content-type") || "").includes("text/html")) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })());
  }
});
