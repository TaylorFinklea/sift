# Re-review of revised initial implementation diff — Sift card sorter

## 1. Verification that prior findings are actually fixed in source

**a) Vite LAN exposure — fixed.** `vite.config.mjs` now binds `server: { host: "127.0.0.1", port: 4173, strictPort: true, allowedHosts: ["terminal.local"] }`. Loopback-only; no `0.0.0.0`/`true`. Server dev/prod binds `127.0.0.1` (`server/index.js`: `const host = trustProxy ? "0.0.0.0" : "127.0.0.1"`, loopback unless the explicit `SIFT_TRUST_PROXY_AUTH=1` deployment flag). `compose.yaml` publishes only `127.0.0.1:3000`. Consistent with proxy-as-boundary scope.

**b) Hidden-view keyboard mutations — fixed.** `src/sort-keyboard.js`: `if (view !== "sort" || isTyping || hasDialog || metaKey || ctrlKey || altKey) return null;`. `App.jsx` keydown handler computes `typing` for `INPUT/TEXTAREA/SELECT/contentEditable`, passes `hasDialog: Boolean(dialog)`, and `decide`/`undo` re-guard `view === "sort"`, `run`, `activeCard`, `busy`, `isOffline`, `canUndo`. Tests in `tests/sort-keyboard.test.mjs` cover non-sort views, typing, dialogs, modifiers.

**c) Response clone after cache.put — fixed.** `public/service-worker.js` install: `await cache.put("/", response.clone()); const html = await response.text();` — clone is cached, original consumed after. Asset loop: stylesheet text read via `asset.clone().text()` **before** `await cache.put(url, asset)`. Navigate handler: `appDocument` clones internally, then `cache.put("/", response.clone())`, then returns the original with body intact. No body consumption before/after misuse remains.

**d) Valid large body rejected — fixed.** `server/index.js` limit is cumulative (`length > jsonLimit`) with a matching early `content-length` check; `tests/server.test.js` "accepts the maximum supported collection..." asserts 201 for 500 cards at max field lengths and 413 only for >2 MiB.

**e) Wrong history/refine collection name — fixed.** `src/collection-context.js` resolves by `run.collectionId`; `App.jsx` history rows use `collections.find((entry) => entry.id === savedRun.collectionId)` for the display name, and the refine dialog is seeded with `collectionForRun(parent, collections)` (plus server-side authority: the child run is built from the parent's kept cards inside `POST /api/runs`, not from any client-supplied name).

**f) SW install root 404 (Accept \*/\*) — fixed.** Install fetches `"headers: { Accept: "text/html" }"` and CACHE_NAME is `sift-shell-v2`; the server's SPA fallback in `staticResponse` requires `accept.includes("text/html")`, so the negotiation now matches. `tests/service-worker.test.mjs` models the 404-without-Accept branch, asserts `rootAccept === "text/html"` and cache v2, and verifies font precache from CSS.

**g) Per-decision full-history refresh — replaced.** `App.jsx` `perform({ mergeRun: true })` splices the authoritative run returned by the server (`runDto` computed within the same transaction as the write) via `mergeRunIntoWorkspace`, persisting the bounded cache; no full reload per card. Saving status: top bar shows `busy ? "Saving…" : …`, and desktop orbs, mobile keep/discard/undo and footer undo are all `disabled` on `busy`/`isOffline` (keep also disabled at `keptCards.length >= run.keepLimit`, matching the server's `keep_limit_reached`). Per instructions, the disabled-controls + explicit "Saving…" status is an acceptable saving model; out-of-band keep attempts (keyboard/swipe at cap) are still server-rejected with a clear message plus refresh — no silent state divergence.

## 2. Independent skeptical checks of current source

- **Server correctness/integrity:** revision guards on decisions/undo and `expectedUpdatedAt`+`WHERE updated_at = ?` double-check on PUT; `BEGIN IMMEDIATE` transactions; partial unique index permits re-deciding a card after undo; refinement requires complete parent and ≥2 keeps, recomputed server-side; snapshots immutable across edits; undo retains audit row with `undoneAt`. Consistent throughout.
- **Security:** host allowlist (421) before anything, `assertSameOrigin` on all mutations with exact-origin match to `SIFT_PUBLIC_ORIGIN` in proxy mode, no CORS reflect headers, `no-store` on API, nosniff/Referrer-Policy/X-Frame-Options, traversal-safe static resolution with SPA fallback only for extension-less HTML navigations and API/routes never fall back to HTML (tested). React JSX escaping everywhere; no `dangerouslySetInnerHTML`. No accounts demanded — proxy is the stated boundary.
- **Data loss:** collection edit re-generates card IDs but nothing outside runs references collection card IDs; run snapshots unaffected. 409 paths refresh rather than clobber. localStorage cache is bounded with overflow handling and never substitutes for server authority for writes (offline is hard read-only).
- **PWA:** network-first navigations with cached-"/" offline fallback; assets cache-first with install precache of HTML-referenced JS/CSS, fonts from CSS, manifest, and all referenced images (`compass.png`, brand marks, apple icon) present in `CORE_FILES` or HTML extraction; old `sift-shell-*` purged on activate; install failure (no app root) correctly aborts install. Offline write attempts are gated by disabled controls and fail-soft otherwise.

## 3. Non-material observations (no change required)

- `public/service-worker.js` uses a constant cache name; non-hashed static assets (brand PNGs, `compass.png`, `manifest.webmanifest`) go stale after redeploys until `CACHE_NAME` is bumped — routine maintenance, HTML/JS/CSS/fonts are handled correctly.
- The proxy must preserve the public `Host` header for `assertAllowedHost`; standard proxy config, and access-proxy integration is already documented as the user-owned step.
- Dev-only StrictMode dialog remount nuance in `Modal` (`close()` in cleanup fires `onClose`); StrictMode is a no-op in production builds where this ships.

No remaining material correctness, security, data-loss, or PWA issue within scope; all prior findings are substantively resolved in source, not merely in claims.

VERDICT: ready
