import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, loadWorkspace, mergeRunIntoWorkspace, readCachedWorkspace, saveDecision } from "../src/lib/api.js";

function setupStorage() {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
  return values;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function runWithDecisions(count) {
  const cards = Array.from({ length: count }, (_, index) => ({ id: `card-${index}`, text: `Card ${index}`, detail: "", position: index }));
  const decisions = cards.map((card, index) => ({ id: `decision-${index}`, cardId: card.id, choice: index % 2 ? "discard" : "keep", position: index, undoneAt: null }));
  return { id: "run-1", collectionId: "collection-1", roundNumber: 1, status: "complete", revision: count, keepLimit: Math.ceil(count / 2), cards, decisions };
}

test("cached read model keeps every card and decision for each included sort", async () => {
  setupStorage();
  const run = runWithDecisions(240);
  globalThis.fetch = async (url) => url.endsWith("/collections")
    ? jsonResponse({ collections: [{ id: "collection-1", name: "Personal Values", cards: run.cards }] })
    : jsonResponse({ runs: [run] });

  const online = await loadWorkspace();
  assert.equal(online.connection, "online");
  assert.equal(online.runs[0].decisions.length, 240);

  globalThis.fetch = async () => { throw new TypeError("network is unavailable"); };
  const offline = await loadWorkspace();
  assert.equal(offline.connection, "offline");
  assert.equal(offline.runs[0].cards.length, 240);
  assert.equal(offline.runs[0].decisions.length, 240);
});

test("access proxy denial keeps cached reads marked as sign-in required", async () => {
  setupStorage();
  globalThis.fetch = async (url) => url.endsWith("/collections")
    ? jsonResponse({ collections: [{ id: "collection-1", name: "Personal Values", cards: [] }] })
    : jsonResponse({ runs: [] });
  await loadWorkspace();
  globalThis.fetch = async () => jsonResponse({ error: { code: "unauthorized", message: "Sign in again" } }, 401);

  const result = await loadWorkspace();
  assert.equal(result.connection, "proxy");
  assert.match(result.connectionMessage, /sign-in/i);
});

test("a delayed stale workspace read cannot overwrite the cached read model", async () => {
  setupStorage();
  globalThis.fetch = async (url) => url.endsWith("/collections")
    ? jsonResponse({ collections: [{ id: "current", name: "Current", cards: [] }] })
    : jsonResponse({ runs: [] });
  await loadWorkspace();

  let release;
  const delayedResponse = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url) => {
    await delayedResponse;
    return url.endsWith("/collections")
      ? jsonResponse({ collections: [{ id: "stale", name: "Stale", cards: [] }] })
      : jsonResponse({ runs: [] });
  };
  let currentSequence = 3;
  const staleRead = loadWorkspace({ shouldCommit: () => 3 === currentSequence });
  currentSequence = 4;
  release();
  await staleRead;

  assert.equal(readCachedWorkspace().collections[0].id, "current");
});

test("server revision conflicts surface the server message without silently retrying", async () => {
  const originalFetch = globalThis.fetch;
  let requestedBody;
  try {
    globalThis.fetch = async (_url, options) => {
      requestedBody = JSON.parse(options.body);
      return jsonResponse({ error: { code: "revision_conflict", message: "Another window made a choice." } }, 409);
    };
    await assert.rejects(
      saveDecision({ id: "run-1", revision: 17 }, "card-3", "keep"),
      (error) => error instanceof ApiError && error.status === 409 && error.message === "Another window made a choice.",
    );
    assert.deepEqual(requestedBody, { cardId: "card-3", choice: "keep", expectedRevision: 17 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collection updates carry the version opened by the edit form", async () => {
  const originalFetch = globalThis.fetch;
  let requestedBody;
  try {
    globalThis.fetch = async (_url, options) => {
      requestedBody = JSON.parse(options.body);
      return jsonResponse({ collection: { id: "collection-1", ...requestedBody } });
    };
    const { updateCollection } = await import("../src/lib/api.js");
    const input = { name: "Values", cards: [{ id: "one", text: "Curiosity" }] };
    await updateCollection("collection-1", input, "2026-11-01T12:00:00.000Z");
    assert.deepEqual(requestedBody, { ...input, expectedUpdatedAt: "2026-11-01T12:00:00.000Z" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("merging a saved run updates the active read model and persists it without losing history", async () => {
  setupStorage();
  let networkRequests = 0;
  const olderRun = { ...runWithDecisions(2), id: "older", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
  const newerRun = { ...runWithDecisions(1), id: "newer", createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" };
  globalThis.fetch = async (url) => {
    networkRequests += 1;
    return url.endsWith("/collections")
      ? jsonResponse({ collections: [{ id: "collection-1", name: "Personal Values" }] })
      : jsonResponse({ runs: [newerRun, olderRun] });
  };
  const loaded = await loadWorkspace();
  networkRequests = 0;

  const savedRun = { ...olderRun, revision: 3, updatedAt: "2026-10-03T00:00:00.000Z" };
  const merged = mergeRunIntoWorkspace(loaded, savedRun);
  assert.equal(networkRequests, 0);
  assert.equal(merged.runs[0].id, "older");
  assert.equal(merged.runs[0].revision, 3);
  assert.equal(merged.runs[1].id, "newer");
  assert.equal(readCachedWorkspace().runs[0].revision, 3);
});
