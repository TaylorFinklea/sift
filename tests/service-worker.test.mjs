import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("install caches fonts referenced by stylesheets before cache.put consumes the response", async () => {
  const source = await readFile(new URL("../public/service-worker.js", import.meta.url), "utf8");
  const handlers = new Map();
  const entries = new Map();
  const fetched = [];
  const origin = "https://sift.example";
  let rootAccept = "";
  let openedCacheName = "";
  const workerSelf = {
    location: { origin },
    addEventListener: (name, callback) => handlers.set(name, callback),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const cache = {
    put: async (url, response) => {
      const text = await response.text();
      entries.set(String(url), text);
    },
  };
  const fetchAsset = async (request, options = {}) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url, origin);
    fetched.push(url.href);
    let body = "asset";
    let contentType = "application/octet-stream";
    if (url.pathname === "/") {
      rootAccept = options.headers?.Accept || "";
      if (!rootAccept.includes("text/html")) {
        const missing = new Response(JSON.stringify({ error: { code: "not_found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
        Object.defineProperty(missing, "url", { value: url.href });
        return missing;
      }
      body = '<!doctype html><meta name="sift-app" content="sift-card-sorter"><link href="/assets/app.css" rel="stylesheet"><script src="/assets/app.js"></script>';
      contentType = "text/html";
    } else if (url.pathname.endsWith(".css")) {
      body = '@font-face { src: url("/assets/manrope.woff2") }';
      contentType = "text/css";
    } else if (url.pathname.endsWith(".js")) {
      contentType = "text/javascript";
    }
    const response = new Response(body, { headers: { "content-type": contentType } });
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  };
  const context = {
    self: workerSelf,
    caches: {
      open: async (name) => { openedCacheName = name; return cache; },
      keys: async () => [],
      match: async () => undefined,
    },
    fetch: fetchAsset,
    URL,
    Response,
  };
  vm.runInNewContext(source, context, { filename: "service-worker.js" });
  let installPromise;
  handlers.get("install")({ waitUntil: (promise) => { installPromise = promise; } });
  await installPromise;
  assert.equal(rootAccept, "text/html");
  assert.equal(openedCacheName, "sift-shell-v2");
  assert.ok(entries.has(`${origin}/assets/manrope.woff2`), `fetched:\n${fetched.join("\n")}\ncached:\n${[...entries.keys()].join("\n")}`);
  assert.ok(entries.has(`${origin}/assets/brand-maskable-512.png`));
});

test("public legal-page navigations bypass the cached private app-shell fallback", async () => {
  const source = await readFile(new URL("../public/service-worker.js", import.meta.url), "utf8");
  const handlers = new Map();
  const context = {
    self: {
      location: { origin: "https://sift.example" },
      addEventListener: (name, callback) => handlers.set(name, callback),
    },
    URL,
    caches: { match: async () => undefined },
    fetch: async () => { throw new Error("network unavailable"); },
    Response,
  };
  vm.runInNewContext(source, context, { filename: "service-worker.js" });
  for (const path of ["/privacy", "/support"]) {
    let intercepted = false;
    handlers.get("fetch")({
      request: { url: `https://sift.example${path}`, method: "GET", mode: "navigate" },
      respondWith: () => { intercepted = true; },
    });
    assert.equal(intercepted, false, `${path} should use the normal network request`);
  }
  let privateRouteIntercepted = false;
  handlers.get("fetch")({
    request: { url: "https://sift.example/", method: "GET", mode: "navigate" },
    respondWith: () => { privateRouteIntercepted = true; },
  });
  assert.equal(privateRouteIntercepted, true, "the private app shell keeps its offline behavior");
});
