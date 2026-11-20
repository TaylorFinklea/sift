import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, SignJWT } from "jose";
import { build } from "esbuild";
import { createFetchMock, Miniflare } from "miniflare";
import {
  installPersistentAccessJwks,
  isAllowedPreviewHost,
  isAllowedPreviewMutationOrigin,
} from "./preview-origin.js";

// This loopback-only fixture signs real synthetic Access JWTs for local browser QA.
// It does not add a production bypass and never connects to Cloudflare services.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appOrigin = "https://sift.example.com";
const issuer = "https://sift-preview.cloudflareaccess.com";
const audience = "sift-local-preview-audience";
const ownerEmail = "preview-owner@example.test";
const port = Number(process.env.SIFT_PREVIEW_PORT || 8787);
const assetRoot = path.join(root, "dist/client");

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SIFT_PREVIEW_PORT must be a valid TCP port.");
if (!(await stat(path.join(assetRoot, "index.html")).catch(() => null))) {
  throw new Error("Build the client first; dist/client/index.html is missing.");
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(await exportJWK(publicKey)), kid: "sift-local-preview", use: "sig", alg: "RS256" };
const fetchMock = createFetchMock();
fetchMock.disableNetConnect();
installPersistentAccessJwks(fetchMock, issuer, jwk);

const bundle = await build({
  entryPoints: [path.join(root, "cloudflare/index.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
});

function mimeType(file) {
  switch (path.extname(file)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".webmanifest": return "application/manifest+json; charset=utf-8";
    case ".png": return "image/png";
    case ".svg": return "image/svg+xml";
    case ".woff2": return "font/woff2";
    case ".ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}

async function serveAsset(request) {
  let decoded;
  try { decoded = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response("Not found", { status: 404 }); }
  const resolved = path.resolve(assetRoot, `.${decoded}`);
  if (resolved !== assetRoot && !resolved.startsWith(`${assetRoot}${path.sep}`)) return new Response("Not found", { status: 404 });
  let file = resolved;
  if (!(await stat(file).then((info) => info.isFile()).catch(() => false))) {
    if (path.extname(decoded) || !request.headers.get("accept")?.includes("text/html")) return new Response("Not found", { status: 404 });
    file = path.join(assetRoot, "index.html");
  }
  const body = await readFile(file);
  return new Response(body, { headers: { "content-type": mimeType(file), "cache-control": "no-cache" } });
}

const miniflare = new Miniflare({
  name: "sift-local-preview",
  script: bundle.outputFiles[0].text,
  modules: true,
  compatibilityDate: "2026-08-06",
  d1Databases: { DB: "sift-local-preview-db" },
  bindings: {
    SIFT_APP_HOST: "sift.example.com",
    SIFT_API_HOST: "api.sift.example.com",
    SIFT_ACCESS_ISSUER: issuer,
    SIFT_ACCESS_AUD: audience,
    SIFT_ACCESS_OWNER_EMAIL: ownerEmail,
  },
  serviceBindings: { ASSETS: serveAsset },
  fetchMock,
  cf: false,
});

const db = await miniflare.getD1Database("DB");
const migrations = (await readdir(path.join(root, "cloudflare/migrations"))).filter((name) => name.endsWith(".sql")).sort();
for (const name of migrations) {
  const sql = await readFile(path.join(root, "cloudflare/migrations", name), "utf8");
  for (const statement of sql.split(/;\s*(?:\n|$)/u).map((part) => part.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
}

async function ownerToken() {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: ownerEmail })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

async function appApi(route, body) {
  const token = await ownerToken();
  const response = await miniflare.dispatchFetch(new URL(route, appOrigin).href, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      ...(body === undefined ? {} : { origin: appOrigin, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Local D1 seed failed (${response.status}, ${value.error?.code || "unknown"}).`);
  return value;
}

const cards = [
  ["Curiosity", "Making room to explore, learn, and ask better questions."],
  ["Family", "Showing up for the people who matter most."],
  ["Health", "Protecting energy, movement, and rest."],
  ["Integrity", "Letting your actions match your values."],
  ["Growth", "Continuing to learn, even when it feels uncomfortable."],
  ["Creativity", "Making space to imagine and build new things."],
  ["Community", "Contributing to a place and people beyond yourself."],
  ["Focus", "Giving your attention to what matters right now."],
  ["Adventure", "Trying new experiences and going beyond the familiar."],
  ["Kindness", "Treating yourself and others with care."],
  ["Financial stability", "Creating room for choice and peace of mind."],
  ["Craft", "Doing thoughtful work and getting better at it."],
].map(([text, detail], index) => ({
  id: `preview-card-${index + 1}`,
  text,
  detail,
  pros: index < 3 ? ["Worth making room for", "Supports long-term goals"] : [],
  cons: index < 3 ? ["Competes for attention"] : [],
}));
const { collection } = await appApi("/api/collections", {
  name: "Personal Values",
  description: "A synthetic Cloudflare preview collection.",
  cards,
});
const { run } = await appApi("/api/runs", { collectionId: collection.id, keepLimit: 4 });
for (const [index, card] of run.cards.slice(0, 3).entries()) {
  await miniflare.dispatchFetch(new URL(`/api/runs/${run.id}/decisions`, appOrigin).href, {
    method: "POST",
    headers: {
      "Cf-Access-Jwt-Assertion": await ownerToken(),
      origin: appOrigin,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cardId: card.id, choice: index === 1 ? "discard" : "keep", expectedRevision: index }),
  });
}

async function readIncoming(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return size ? Buffer.concat(chunks) : undefined;
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const incomingHost = incoming.headers.host || "";
    if (!isAllowedPreviewHost(incomingHost, port)) {
      outgoing.writeHead(421, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: { code: "host_not_allowed", message: "This hostname is not allowed." } }));
      return;
    }
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(incoming.method || "GET");
    if (mutating && !isAllowedPreviewMutationOrigin(incomingHost, incoming.headers.origin, port)) {
      outgoing.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      outgoing.end(JSON.stringify({ error: { code: "cross_origin_request", message: "A same-origin request is required." } }));
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (["host", "origin", "content-length", "connection", "transfer-encoding", "cf-access-jwt-assertion"].includes(name)) continue;
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    headers.set("Cf-Access-Jwt-Assertion", await ownerToken());
    if (mutating) headers.set("Origin", appOrigin);
    const body = await readIncoming(incoming);
    const target = new URL(incoming.url || "/", appOrigin);
    const response = await miniflare.dispatchFetch(target.href, {
      method: incoming.method,
      headers,
      body,
    });
    const responseHeaders = {};
    for (const [name, value] of response.headers) {
      if (!["connection", "content-length", "transfer-encoding"].includes(name.toLowerCase())) responseHeaders[name] = value;
    }
    outgoing.writeHead(response.status, responseHeaders);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const status = error?.message === "body_too_large" ? 413 : 500;
    outgoing.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    outgoing.end(JSON.stringify({ error: { code: status === 413 ? "body_too_large" : "preview_error", message: "Local preview request failed." } }));
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
console.log(`Sift local Worker/D1 preview: http://127.0.0.1:${port}/`);
console.log("Synthetic Access identity and D1 data are isolated to this process; no Cloudflare connection was made.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(async () => {
    await miniflare.dispose();
    process.exit(0);
  }));
}
