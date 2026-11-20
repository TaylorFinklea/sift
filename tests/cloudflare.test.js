import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { after, test } from "node:test";
import { exportJWK, SignJWT } from "jose";
import { build } from "esbuild";
import { createFetchMock, Miniflare } from "miniflare";
import { handleRequest, insertInitialRun, loadRunHistory } from "../cloudflare/index.js";
import { remapTransferBundleIDs, validateTransfer, webWorkspaceToTransfer } from "../shared/transfer.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function varyTransferTitles(value, suffix) {
  const archive = structuredClone(value);
  for (const bundle of archive.collections) for (const record of bundle.records) {
    if (record.kind !== "collectionRevision" && record.kind !== "sortSession") continue;
    const payload = JSON.parse(Buffer.from(record.payload, "base64").toString("utf8"));
    const field = record.kind === "collectionRevision" ? "title" : "titleSnapshot";
    if (typeof payload[field] === "string") {
      payload[field] += suffix;
      record.payload = Buffer.from(JSON.stringify(payload)).toString("base64");
    }
  }
  return validateTransfer(archive);
}
const appOrigin = "https://sift.example.com";
const apiOrigin = "https://api.sift.example.com";
const issuer = "https://sift-test.cloudflareaccess.com";
const audience = "sift-local-test-audience";
const ownerEmail = "owner@example.test";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = "sift-local-test-key";
publicJwk.use = "sig";
publicJwk.alg = "RS256";

const fetchMock = createFetchMock();
fetchMock.disableNetConnect();
fetchMock.get(issuer).intercept({ method: "GET", path: /\/cdn-cgi\/access\/certs/u })
  .reply(200, { keys: [publicJwk] });

const workerBundle = await build({
  entryPoints: [path.join(root, "cloudflare/index.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
});

const miniflare = new Miniflare({
  name: "sift-test",
  script: workerBundle.outputFiles[0].text,
  modules: true,
  compatibilityDate: "2026-08-06",
  d1Databases: { DB: "sift-test-db", LEGACY_DB: "sift-legacy-test-db" },
  bindings: {
    SIFT_APP_HOST: "sift.example.com",
    SIFT_API_HOST: "api.sift.example.com",
    SIFT_ACCESS_ISSUER: issuer,
    SIFT_ACCESS_AUD: audience,
    SIFT_ACCESS_OWNER_EMAIL: ownerEmail,
  },
  serviceBindings: {
    ASSETS: async (request) => {
      const pages = {
        "/privacy": '<!doctype html><meta name="sift-public-page" content="privacy"><title>Privacy</title><main>Privacy notice</main>',
        "/support": '<!doctype html><meta name="sift-public-page" content="support"><title>Support</title><main>Support help</main>',
      };
      return new Response(pages[new URL(request.url).pathname] || "<main>local preview shell</main>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  },
  fetchMock,
  cf: false,
});

const db = await miniflare.getD1Database("DB");
const legacyDb = await miniflare.getD1Database("LEGACY_DB");
for (const name of ["0001_core.sql", "0002_api_keys.sql", "0003_sort_sessions.sql", "0004_transfers.sql", "0005_ratings.sql"]) {
  const migration = await readFile(path.join(root, "cloudflare/migrations", name), "utf8");
  for (const statement of migration.split(/;\s*(?:\n|$)/u).map((sql) => sql.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
}
for (const name of ["0001_core.sql", "0002_api_keys.sql"]) {
  const migration = await readFile(path.join(root, "cloudflare/migrations", name), "utf8");
  for (const statement of migration.split(/;\s*(?:\n|$)/u).map((sql) => sql.trim()).filter(Boolean)) {
    await legacyDb.prepare(statement).run();
  }
}
const legacyCollectionId = crypto.randomUUID();
const legacyRootId = crypto.randomUUID();
const legacyChildId = crypto.randomUUID();
const legacyBranchId = crypto.randomUUID();
const legacyDecisionID = crypto.randomUUID();
const legacyReplacementID = crypto.randomUUID();
const legacyNow = new Date().toISOString();
const legacyCards = JSON.stringify([{ id: "legacy-one", text: "One" }, { id: "legacy-two", text: "Two" }]);
await legacyDb.prepare(`INSERT INTO collections
  (id, name, description, keep_label, discard_label, cards_json, created_at, updated_at)
  VALUES (?, 'Legacy rounds', '', 'Keep', 'Let go', ?, ?, ?)`).bind(
  legacyCollectionId, legacyCards, legacyNow, legacyNow,
).run();
for (const [id, parentId, roundNumber, keepLimit] of [
  [legacyRootId, null, 1, 2],
  [legacyChildId, legacyRootId, 2, 1],
  [legacyBranchId, legacyRootId, 2, 2],
]) {
  await legacyDb.prepare(`INSERT INTO runs
    (id, collection_id, parent_run_id, round_number, keep_limit, revision, keep_label, discard_label, cards_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 'Keep', 'Let go', ?, ?, ?)`).bind(
    id, legacyCollectionId, parentId, roundNumber, keepLimit, legacyCards, legacyNow, legacyNow,
  ).run();
}
await legacyDb.prepare(`INSERT INTO decisions (id, run_id, card_id, choice, position, created_at, undone_at)
  VALUES (?, ?, 'legacy-one', 'keep', 1, ?, NULL)`).bind(legacyDecisionID, legacyRootId, legacyNow).run();
{
  const migration = await readFile(path.join(root, "cloudflare/migrations/0003_sort_sessions.sql"), "utf8");
  for (const statement of migration.split(/;\s*(?:\n|$)/u).map((sql) => sql.trim()).filter(Boolean)) {
    await legacyDb.prepare(statement).run();
  }
}
await legacyDb.prepare("UPDATE decisions SET undone_at = ?, replaces_decision_id = NULL WHERE id = ?")
  .bind(legacyNow, legacyDecisionID).run();
await legacyDb.prepare(`INSERT INTO decisions (id, run_id, card_id, choice, position, created_at, undone_at, replaces_decision_id)
  VALUES (?, ?, 'legacy-one', 'discard', 2, ?, NULL, ?)`)
  .bind(legacyReplacementID, legacyRootId, legacyNow, legacyDecisionID).run();
const legacyDecisionFingerprint = await legacyDb.prepare(`SELECT id, run_id, card_id, choice, position, created_at, undone_at, replaces_decision_id
  FROM decisions ORDER BY position`).all();
for (const name of ["0004_transfers.sql", "0005_ratings.sql"]) {
  const migration = await readFile(path.join(root, "cloudflare/migrations", name), "utf8");
  for (const statement of migration.split(/;\s*(?:\n|$)/u).map((sql) => sql.trim()).filter(Boolean)) {
    await legacyDb.prepare(statement).run();
  }
}

after(async () => {
  await miniflare.dispose();
});

test("authenticated owner export reads the complete authoritative D1 library and round history", async () => {
  const token = await ownerToken();
  const created = await appRequest("/api/collections", { method: "POST", token, body: {
    name: "Full export fixture",
    cards: ["One", "Two", "Three", "Four"].map((text, index) => ({ id: `full-export-${index}`, text })),
  } });
  const { collection } = await jsonResponse(created);
  const started = await appRequest("/api/runs", { method: "POST", token, body: {
    collectionId: collection.id, keepLimit: 2,
    rounds: [{ title: "Shortlist", keepLimit: 2 }, { title: "Final", keepLimit: 1 }],
  } });
  const { run } = await jsonResponse(started);
  let revision = run.revision;
  for (const [index, card] of run.cards.entries()) {
    const response = await appRequest(`/api/runs/${run.id}/decisions`, { method: "POST", token, body: {
      cardId: card.id, choice: index < 2 ? "keep" : "discard", expectedRevision: revision,
    } });
    const result = await jsonResponse(response);
    assert.equal(response.status, 200);
    revision = result.run.revision;
  }
  const next = await appRequest("/api/runs", { method: "POST", token, body: { parentRunId: run.id } });
  assert.equal(next.status, 201);
  const response = await appRequest("/api/transfers/export", { token });
  assert.equal(response.status, 200);
  const { archive } = await jsonResponse(response);
  assert.equal(archive.collections.length, 1);
  assert.equal(archive.collections[0].records.filter((record) => record.kind === "sortSession").length, 1);
  assert.ok(archive.collections[0].records.some((record) => record.kind === "sortAction"));
});

test("D1 stores numeric card snapshots and rating values and imports a remapped v2 archive", async () => {
  const token = await ownerToken();
  const appApi = (route, { method = "GET", body } = {}) => appRequest(route, { method, body, token });
  const fieldID = "9F13E773-A8CB-49E5-AAD4-2A4D57F82B21";
  const duplicateKeys = await appApi("/api/collections", { method: "POST", body: {
    name: "D1 duplicate field keys",
    numericFields: [{ id: fieldID, name: "Weight", minimum: -2, maximum: 2, step: 0.25, unit: "kg" }],
    cards: [{ id: "d1-dup-a", text: "A", numericValues: { [fieldID]: 0, [fieldID.toLowerCase()]: 1 } }, { id: "d1-dup-b", text: "B" }],
  } });
  assert.equal(duplicateKeys.status, 400);
  assert.equal((await jsonResponse(duplicateKeys)).error.code, "invalid_numeric_fields");
  const created = await appApi("/api/collections", { method: "POST", body: {
    name: "D1 rating fixture",
    numericFields: [{ id: fieldID, name: "Weight", minimum: -2, maximum: 2, step: 0.25, unit: "kg" }],
    cards: [{ id: "d1-a", text: "A", numericValues: { [fieldID]: 0 } }, { id: "d1-b", text: "B", numericValues: { [fieldID]: -0.5 } }],
  } });
  const { collection } = await jsonResponse(created);
  assert.equal(created.status, 201);
  const scale = { name: " Rating ", minimum: 0, maximum: 5, step: 0.5, unit: "stars " };
  const started = await appApi("/api/runs", { method: "POST", body: {
    collectionId: collection.id, rounds: [{ title: "Rate", ratingScale: scale }],
  } });
  const { run } = await jsonResponse(started);
  assert.equal(started.status, 201);
  assert.equal(run.keepLimit, null);
  assert.deepEqual(run.ratingScale, scale);
  const saved = await appApi(`/api/runs/${run.id}/decisions`, { method: "POST", body: {
    cardId: "d1-a", choice: "rating", value: 0, expectedRevision: 0,
  } });
  const { run: rated } = await jsonResponse(saved);
  assert.equal(saved.status, 200);
  assert.equal(rated.decisions[0].value, 0);
  assert.deepEqual(rated.numericFields, collection.numericFields);
  const exported = await appApi(`/api/transfers/export?collectionId=${collection.id}`);
  const { archive } = await jsonResponse(exported);
  assert.equal(exported.status, 200);
  assert.equal(archive.version, 2);
  const remapped = remapTransferBundleIDs(archive, archive.collections[0].id);
  const preview = await appApi("/api/transfers/preview", { method: "POST", body: { archive: remapped } });
  const previewBody = await jsonResponse(preview);
  assert.equal(preview.status, 200);
  const imported = await appApi("/api/transfers/import", { method: "POST", body: { archive: remapped, previewToken: previewBody.previewToken } });
  assert.equal(imported.status, 200);
  const importedCollection = await db.prepare("SELECT id, numeric_fields_json, cards_json FROM collections WHERE id != ? AND name = ? ORDER BY created_at DESC LIMIT 1")
    .bind(collection.id, collection.name).first();
  assert.ok(importedCollection);
  const importedFields = JSON.parse(importedCollection.numeric_fields_json);
  const importedCards = JSON.parse(importedCollection.cards_json);
  assert.notEqual(importedFields[0].id, fieldID);
  assert.equal(importedCards[0].numericValues[importedFields[0].id], 0);
  const importedRun = await db.prepare("SELECT id, rating_scale_json, numeric_fields_json FROM runs WHERE collection_id = ?")
    .bind(importedCollection.id).first();
  assert.deepEqual(JSON.parse(importedRun.rating_scale_json), scale);
  assert.deepEqual(JSON.parse(importedRun.numeric_fields_json), importedFields);
  const importedAnswer = await db.prepare("SELECT choice, rating_value FROM sort_answers WHERE run_id = ?")
    .bind(importedRun.id).first();
  assert.deepEqual(importedAnswer, { choice: "rating", rating_value: 0 });
  const importedDTOResponse = await appApi(`/api/runs/${importedRun.id}`);
  const { run: importedDTO } = await jsonResponse(importedDTOResponse);
  const futureScale = { unit: "pts", step: 0.25, name: "Future", maximum: 2, minimum: 0 };
  const renamedRounds = importedDTO.roundPlan.map((round) => ({ ...round, title: "Renamed native round" }));
  renamedRounds.push({ title: "Future rating", keepLimit: null, ratingScale: futureScale });
  const changedPlan = await appApi(`/api/runs/${importedRun.id}/plan`, { method: "PATCH", body: {
    expectedPlanRevision: importedDTO.planRevision, rounds: renamedRounds,
  } });
  const changedPlanBody = await jsonResponse(changedPlan);
  assert.equal(changedPlan.status, 200, JSON.stringify(changedPlanBody));
  assert.equal(changedPlanBody.run.roundPlan[0].title, "Renamed native round");
  assert.deepEqual(changedPlanBody.run.roundPlan[0].ratingScale, scale, "started scale survives Swift's sorted payload key order");
  const upgraded = await appApi(`/api/transfers/export?collectionId=${importedCollection.id}`);
  const { archive: upgradedArchive } = await jsonResponse(upgraded);
  assert.equal(upgraded.status, 200);
  validateTransfer(upgradedArchive);
  assert.equal(upgradedArchive.version, 2);
  assert.ok(upgradedArchive.collections[0].records.some((record) => record.kind === "sortAction" && JSON.parse(Buffer.from(record.payload, "base64").toString("utf8")).operation.planEdited && record.version === 2));
});

test("large history reads each card snapshot once in a constant two-statement D1 batch", async () => {
  const collectionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const cards = Array.from({ length: 4 }, (_, index) => ({
    id: `history-card-${index}`,
    text: `History card ${index}`,
    detail: "d".repeat(35_000),
    pros: [],
    cons: [],
    position: index,
  }));
  const cardsJson = JSON.stringify(cards);
  await db.prepare(`INSERT INTO collections
    (id, name, description, keep_label, discard_label, cards_json, created_at, updated_at)
    VALUES (?, ?, '', 'Keep', 'Let go', ?, ?, ?)`)
    .bind(collectionId, "Large history fixture", cardsJson, now, now).run();
  const expectedIds = [];
  for (let runIndex = 0; runIndex < 6; runIndex += 1) {
    const runId = crypto.randomUUID();
    expectedIds.push(runId);
    const createdAt = new Date(Date.now() + runIndex).toISOString();
    await db.prepare(`INSERT INTO runs
      (id, collection_id, parent_run_id, round_number, keep_limit, revision, keep_label,
       discard_label, cards_json, created_at, updated_at)
      VALUES (?, ?, NULL, 1, 2, 20, 'Keep', 'Let go', ?, ?, ?)`)
      .bind(runId, collectionId, cardsJson, createdAt, createdAt).run();
    for (let position = 0; position < 16; position += 1) {
      await db.prepare(`INSERT INTO sort_answers
        (id, run_id, card_id, choice, position, created_at, undone_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          crypto.randomUUID(), runId, cards[position % cards.length].id,
          position % 2 === 0 ? "keep" : "discard", position + 1, createdAt,
          position < 12 ? createdAt : null,
        ).run();
    }
  }

  let batchCalls = 0;
  let statementCount = 0;
  const countedDb = {
    prepare: (...args) => db.prepare(...args),
    batch: (statements) => {
      batchCalls += 1;
      statementCount += statements.length;
      return db.batch(statements);
    },
  };
  const runs = await loadRunHistory(countedDb, collectionId);
  assert.equal(batchCalls, 1);
  assert.equal(statementCount, 2);
  assert.equal(runs.length, expectedIds.length);
  assert.deepEqual(new Set(runs.map((run) => run.id)), new Set(expectedIds));
  assert.ok(runs.every((run) => run.decisions.length === 16));
  assert.ok(runs.every((run) => run.cards[0].detail.length === 35_000));
});

test("history descendant checks use the parent-run index", async () => {
  const plan = await db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM runs child WHERE child.parent_run_id = ? LIMIT 1")
    .bind("index-explain-run").all();
  assert.ok(plan.results.some((row) => String(row.detail).includes("runs_parent_run_idx")), JSON.stringify(plan.results));
});

test("the additive D1 migration preserves populated parent chains with foreign keys enabled", async () => {
  const rows = await legacyDb.prepare(`SELECT id, sort_id FROM runs WHERE collection_id = ? ORDER BY round_number`)
    .bind(legacyCollectionId).all();
  assert.deepEqual(new Map(rows.results.map((row) => [row.id, row.sort_id])), new Map([
    [legacyRootId, legacyRootId],
    [legacyChildId, legacyRootId],
    [legacyBranchId, legacyRootId],
  ]));
  const session = await legacyDb.prepare("SELECT rounds_json FROM sort_sessions WHERE id = ?").bind(legacyRootId).first();
  assert.deepEqual(JSON.parse(session.rounds_json), [
    { title: "Round 1", keepLimit: 2 },
    { title: "Round 2", keepLimit: 2 },
  ]);
  const preservedBranch = await legacyDb.prepare("SELECT keep_limit FROM runs WHERE id = ?").bind(legacyChildId).first();
  assert.equal(preservedBranch.keep_limit, 1, "migration keeps each historical branch's actual cap");
  const copied = await legacyDb.prepare(`SELECT id, run_id, card_id, choice, position, created_at, undone_at, replaces_decision_id
    FROM sort_answers ORDER BY position`).all();
  assert.deepEqual(copied.results, legacyDecisionFingerprint.results);
  const foreignKeyViolations = await legacyDb.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(foreignKeyViolations.results, []);
});

test("initial run insertion rejects a collection edit between snapshot read and insert", async () => {
  const collectionId = crypto.randomUUID();
  const originalCards = JSON.stringify([{ id: "old-a", text: "Old A" }, { id: "old-b", text: "Old B" }]);
  const updatedCards = JSON.stringify([{ id: "new-a", text: "New A" }, { id: "new-b", text: "New B" }]);
  const createdAt = new Date().toISOString();
  const oldUpdatedAt = createdAt;
  const currentUpdatedAt = new Date(Date.parse(createdAt) + 1).toISOString();
  await db.prepare(`INSERT INTO collections
    (id, name, description, keep_label, discard_label, cards_json, created_at, updated_at)
    VALUES (?, 'Run race fixture', '', 'Keep', 'Let go', ?, ?, ?)`)
    .bind(collectionId, originalCards, createdAt, oldUpdatedAt).run();

  const staleRun = {
    id: crypto.randomUUID(),
    collection_id: collectionId,
    keep_limit: 1,
    cards_json: originalCards,
    created_at: createdAt,
    updated_at: createdAt,
  };
  await db.prepare(`UPDATE collections SET name = ?, keep_label = ?, discard_label = ?, cards_json = ?, updated_at = ? WHERE id = ?`)
    .bind("Edited during run creation", "Choose", "Skip", updatedCards, currentUpdatedAt, collectionId).run();

  await assert.rejects(insertInitialRun(db, staleRun, oldUpdatedAt), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "revision_conflict");
    return true;
  });
  const staleCount = await db.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = ?").bind(staleRun.id).first();
  assert.equal(staleCount.count, 0);

  const freshRun = { ...staleRun, id: crypto.randomUUID(), cards_json: updatedCards };
  await insertInitialRun(db, freshRun, currentUpdatedAt);
  const saved = await db.prepare("SELECT keep_label, discard_label, cards_json FROM runs WHERE id = ?").bind(freshRun.id).first();
  assert.equal(saved.keep_label, "Choose");
  assert.equal(saved.discard_label, "Skip");
  assert.equal(saved.cards_json, updatedCards);
});

test("D1 stores round plans, skip queues, and audited revised paths", async () => {
  const token = await ownerToken();
  const appApi = (route, { method = "GET", body } = {}) => appRequest(route, { method, body, token });
  const collectionResponse = await appApi("/api/collections", {
    method: "POST",
    body: {
      name: "Rounds",
      cards: ["one", "two", "three", "four"].map((id) => ({ id, text: id })),
    },
  });
  const { collection } = await jsonResponse(collectionResponse);
  const startResponse = await appApi("/api/runs", {
    method: "POST",
    body: {
      collectionId: collection.id,
      keepLimit: 3,
      rounds: [{ title: "Shortlist", keepLimit: 3 }, { title: "Finalists", keepLimit: 1 }],
    },
  });
  assert.equal(startResponse.status, 201);
  const { run: rootRun } = await jsonResponse(startResponse);
  const skipped = await appApi(`/api/runs/${rootRun.id}/skip`, {
    method: "POST", body: { cardId: "one", expectedRevision: 0 },
  });
  const { run: afterSkip } = await jsonResponse(skipped);
  assert.deepEqual(afterSkip.queue, ["two", "three", "four", "one"]);
  const wrongPlanVersion = await appApi(`/api/runs/${rootRun.id}/plan`, {
    method: "PATCH",
    body: { expectedPlanRevision: 9, rounds: [{ title: "Only", keepLimit: 1 }] },
  });
  assert.equal(wrongPlanVersion.status, 409);

  for (const [index, card] of rootRun.cards.entries()) {
    const response = await appApi(`/api/runs/${rootRun.id}/decisions`, {
      method: "POST",
      body: { cardId: card.id, choice: index < 3 ? "keep" : "discard", expectedRevision: index + 1 },
    });
    assert.equal(response.status, 200);
  }
  const childResponse = await appApi("/api/runs", { method: "POST", body: { parentRunId: rootRun.id } });
  assert.equal(childResponse.status, 201);
  const { run: child } = await jsonResponse(childResponse);
  assert.equal(child.keepLimit, 1);
  assert.equal(child.sortId, rootRun.sortId);
  assert.equal(child.planRevision, rootRun.planRevision + 1);
  assert.equal(child.roundTitle, "Finalists");
  assert.equal(child.hasLaterResults, false);
  const blockedUndo = await appApi(`/api/runs/${rootRun.id}/undo`, {
    method: "POST", body: { expectedRevision: 5 },
  });
  assert.equal(blockedUndo.status, 409);
  assert.equal((await blockedUndo.json()).error.code, "run_has_later_results");
  const forkResponse = await appApi(`/api/runs/${rootRun.id}/revise`, {
    method: "POST",
    body: { cardId: "one", choice: "discard", expectedRevision: 5 },
  });
  assert.equal(forkResponse.status, 200);
  const { run: fork } = await jsonResponse(forkResponse);
  assert.equal(fork.revisesRunId, rootRun.id);
  assert.notEqual(fork.sortId, rootRun.sortId);
  const forkUndoResponse = await appApi(`/api/runs/${fork.id}/undo`, {
    method: "POST", body: { expectedRevision: fork.revision },
  });
  assert.equal(forkUndoResponse.status, 200);
  const { run: afterForkUndo } = await jsonResponse(forkUndoResponse);
  assert.equal(afterForkUndo.decisions.find((decision) => decision.cardId === "one" && !decision.undoneAt).choice, "keep");
  assert.equal(afterForkUndo.keptCount, 3);
  const oldResponse = await appApi(`/api/runs/${rootRun.id}`);
  const { run: oldRun } = await jsonResponse(oldResponse);
  assert.equal(oldRun.hasLaterResults, true);
  assert.equal(oldRun.decisions.find((decision) => decision.cardId === "one" && !decision.undoneAt).choice, "keep");
});

test("D1 forks retain every answer replacement so repeated Undo restores the full audit chain", async () => {
  const token = await ownerToken();
  const appApi = (route, { method = "GET", body } = {}) => appRequest(route, { method, body, token });
  const collectionResponse = await appApi("/api/collections", {
    method: "POST",
    body: { name: "Fork audit chain", cards: ["a", "b", "c", "d"].map((id) => ({ id, text: id })) },
  });
  const { collection } = await jsonResponse(collectionResponse);
  const startResponse = await appApi("/api/runs", {
    method: "POST", body: { collectionId: collection.id, keepLimit: 3 },
  });
  const { run: source } = await jsonResponse(startResponse);
  for (const [index, card] of source.cards.entries()) {
    const response = await appApi(`/api/runs/${source.id}/decisions`, {
      method: "POST",
      body: { cardId: card.id, choice: index < 3 ? "keep" : "discard", expectedRevision: index },
    });
    assert.equal(response.status, 200);
  }
  const revisedResponse = await appApi(`/api/runs/${source.id}/revise`, {
    method: "POST", body: { cardId: "a", choice: "discard", expectedRevision: 4 },
  });
  assert.equal(revisedResponse.status, 200);
  const { run: revisedSource } = await jsonResponse(revisedResponse);
  assert.equal(revisedSource.keptCount, 2);
  const childResponse = await appApi("/api/runs", {
    method: "POST", body: { parentRunId: source.id, keepLimit: 1 },
  });
  assert.equal(childResponse.status, 201);
  const { run: child } = await jsonResponse(childResponse);
  const sourceBefore = (await jsonResponse(await appApi(`/api/runs/${source.id}`))).run;
  const forkResponse = await appApi(`/api/runs/${source.id}/revise`, {
    method: "POST", body: { cardId: "b", choice: "discard", expectedRevision: revisedSource.revision },
  });
  assert.equal(forkResponse.status, 200);
  const { run: fork } = await jsonResponse(forkResponse);
  assert.equal(fork.decisions.length, sourceBefore.decisions.length + 1);
  const sourceDecisionIds = new Set(sourceBefore.decisions.map((entry) => entry.id));
  const forkDecisionIds = new Set(fork.decisions.map((entry) => entry.id));
  assert.ok(fork.decisions.every((entry) => !sourceDecisionIds.has(entry.id)));
  assert.ok(fork.decisions.every((entry) => !entry.replacesDecisionId || forkDecisionIds.has(entry.replacesDecisionId)));

  const undoBResponse = await appApi(`/api/runs/${fork.id}/undo`, {
    method: "POST", body: { expectedRevision: fork.revision },
  });
  assert.equal(undoBResponse.status, 200);
  const { run: afterUndoB } = await jsonResponse(undoBResponse);
  assert.equal(afterUndoB.decisions.find((entry) => entry.cardId === "b" && !entry.undoneAt).choice, "keep");
  assert.equal(afterUndoB.decisions.find((entry) => entry.cardId === "a" && !entry.undoneAt).choice, "discard");
  const undoAResponse = await appApi(`/api/runs/${fork.id}/undo`, {
    method: "POST", body: { expectedRevision: afterUndoB.revision },
  });
  assert.equal(undoAResponse.status, 200);
  const { run: restored } = await jsonResponse(undoAResponse);
  assert.equal(restored.decisions.find((entry) => entry.cardId === "a" && !entry.undoneAt).choice, "keep");
  assert.equal(restored.keptCount, 3);
  assert.equal(restored.status, "complete");
  assert.deepEqual(restored.queue, []);
  const sourceAfter = (await jsonResponse(await appApi(`/api/runs/${source.id}`))).run;
  const childAfter = (await jsonResponse(await appApi(`/api/runs/${child.id}`))).run;
  assert.deepEqual(sourceAfter.decisions, sourceBefore.decisions);
  assert.equal(sourceAfter.revision, sourceBefore.revision);
  assert.deepEqual(childAfter.cards, child.cards);
  assert.deepEqual(childAfter.decisions, child.decisions);
});

test("D1 Undo after an in-place answer revision restores the replaced choice", async () => {
  const token = await ownerToken();
  const appApi = (route, { method = "GET", body } = {}) => appRequest(route, { method, body, token });
  const collectionResponse = await appApi("/api/collections", {
    method: "POST", body: { name: "Undo revision", cards: [{ id: "a", text: "A" }, { id: "b", text: "B" }] },
  });
  const { collection } = await jsonResponse(collectionResponse);
  const started = await appApi("/api/runs", { method: "POST", body: { collectionId: collection.id, keepLimit: 1 } });
  const { run } = await jsonResponse(started);
  const decided = await appApi(`/api/runs/${run.id}/decisions`, {
    method: "POST", body: { cardId: "a", choice: "keep", expectedRevision: 0 },
  });
  assert.equal(decided.status, 200);
  const revised = await appApi(`/api/runs/${run.id}/revise`, {
    method: "POST", body: { cardId: "a", choice: "discard", expectedRevision: 1 },
  });
  assert.equal(revised.status, 200);
  const undone = await appApi(`/api/runs/${run.id}/undo`, {
    method: "POST", body: { expectedRevision: 2 },
  });
  assert.equal(undone.status, 200);
  const { run: restored } = await jsonResponse(undone);
  assert.equal(restored.keptCount, 1);
  assert.equal(restored.decisions.find((decision) => !decision.undoneAt).choice, "keep");
});

test("D1 concurrent round-plan editing and child creation cannot partially update the plan", async () => {
  const token = await ownerToken();
  const appApi = (route, { method = "GET", body } = {}) => appRequest(route, { method, body, token });
  const collectionResponse = await appApi("/api/collections", {
    method: "POST", body: { name: "Plan race", cards: ["a", "b", "c", "d"].map((id) => ({ id, text: id })) },
  });
  const { collection } = await jsonResponse(collectionResponse);
  const started = await appApi("/api/runs", {
    method: "POST", body: { collectionId: collection.id, keepLimit: 3, rounds: [
      { title: "First", keepLimit: 3 }, { title: "Second", keepLimit: 1 },
    ] },
  });
  const { run } = await jsonResponse(started);
  for (const [index, card] of run.cards.entries()) {
    const response = await appApi(`/api/runs/${run.id}/decisions`, {
      method: "POST", body: { cardId: card.id, choice: index < 3 ? "keep" : "discard", expectedRevision: index },
    });
    assert.equal(response.status, 200);
  }
  const [planEdit, childStart] = await Promise.all([
    appApi(`/api/runs/${run.id}/plan`, {
      method: "PATCH", body: { expectedPlanRevision: run.planRevision, rounds: [{ title: "First", keepLimit: 3 }] },
    }),
    appApi("/api/runs", { method: "POST", body: { parentRunId: run.id } }),
  ]);
  const [planBody, childBody] = await Promise.all([planEdit.json(), childStart.json()]);
  const childCount = await db.prepare("SELECT COUNT(*) AS count FROM runs WHERE parent_run_id = ?").bind(run.id).first();
  const session = await db.prepare("SELECT rounds_json, revision FROM sort_sessions WHERE id = ?").bind(run.sortId).first();
  if (childStart.status === 201) {
    assert.ok([400, 409].includes(planEdit.status), JSON.stringify(planBody));
    assert.ok(["invalid_round_plan", "revision_conflict"].includes(planBody.error?.code));
    assert.equal(childCount.count, 1);
    assert.equal(JSON.parse(session.rounds_json).length, 2);
    assert.equal(session.revision, run.planRevision + 1);
  } else {
    assert.equal(planEdit.status, 200, JSON.stringify({ planBody, childBody }));
    assert.ok([400, 409].includes(childStart.status));
    assert.equal(childCount.count, 0);
    assert.equal(JSON.parse(session.rounds_json).length, 1, "a rejected child start cannot extend or revision-bump the saved plan");
    assert.equal(session.revision, run.planRevision + 1, "only the successful plan edit advances the session");
  }
});

test("D1 concurrent answer revision and child creation either fork or CAS without overwriting history", async () => {
  const token = await ownerToken();
  const appApi = (route, { method = "GET", body } = {}) => appRequest(route, { method, body, token });
  const collectionResponse = await appApi("/api/collections", {
    method: "POST", body: { name: "Revision race", cards: ["a", "b", "c", "d"].map((id) => ({ id, text: id })) },
  });
  const { collection } = await jsonResponse(collectionResponse);
  const started = await appApi("/api/runs", {
    method: "POST", body: { collectionId: collection.id, keepLimit: 3, rounds: [
      { title: "First", keepLimit: 3 }, { title: "Second", keepLimit: 1 },
    ] },
  });
  const { run } = await jsonResponse(started);
  for (const [index, card] of run.cards.entries()) {
    const response = await appApi(`/api/runs/${run.id}/decisions`, {
      method: "POST", body: { cardId: card.id, choice: index < 3 ? "keep" : "discard", expectedRevision: index },
    });
    assert.equal(response.status, 200);
  }
  const [childStart, answerRevision] = await Promise.all([
    appApi("/api/runs", { method: "POST", body: { parentRunId: run.id } }),
    appApi(`/api/runs/${run.id}/revise`, {
      method: "POST", body: { cardId: "a", choice: "discard", expectedRevision: 4 },
    }),
  ]);
  const [childBody, revisionBody] = await Promise.all([childStart.json(), answerRevision.json()]);
  if (childStart.status === 201) {
    assert.ok([200, 409].includes(answerRevision.status));
    if (answerRevision.status === 200) {
      assert.equal(revisionBody.run.revisesRunId, run.id);
      assert.notEqual(revisionBody.run.id, run.id);
    }
    const original = await appApi(`/api/runs/${run.id}`);
    const { run: saved } = await jsonResponse(original);
    assert.equal(saved.decisions.find((decision) => decision.cardId === "a" && !decision.undoneAt).choice, "keep");
    assert.equal(childBody.run.parentRunId, run.id);
  } else {
    assert.equal(answerRevision.status, 200);
    assert.equal(revisionBody.run.id, run.id);
    assert.equal(revisionBody.run.decisions.find((decision) => decision.cardId === "a" && !decision.undoneAt).choice, "discard");
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM runs WHERE parent_run_id = ?").bind(run.id).first()).count, 0);
  }
});

async function ownerToken(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: ownerEmail, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

async function appRequest(route, { method = "GET", body, token, origin = appOrigin } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && origin !== null) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return miniflare.dispatchFetch(new URL(route, appOrigin).href, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function apiRequest(route, { method = "GET", body, key, origin } = {}) {
  const headers = { accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return miniflare.dispatchFetch(new URL(route, apiOrigin).href, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function jsonResponse(response) {
  return response.json();
}

test("local Worker authenticates both hosts, persists D1 data, and enforces CAS and key scope", async () => {
  const token = await ownerToken();
  const noAccess = await appRequest("/api/collections");
  assert.equal(noAccess.status, 401);
  const noKey = await apiRequest("/api/collections");
  assert.equal(noKey.status, 401);

  const shell = await appRequest("/sort", { token });
  assert.equal(shell.status, 200, `${await shell.clone().text()} (pending JWKS mocks: ${fetchMock.pendingInterceptors().length})`);
  assert.match(await shell.text(), /local preview shell/);
  assert.equal(shell.headers.get("X-Frame-Options"), "DENY");
  assert.equal(shell.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(shell.headers.get("Referrer-Policy"), "same-origin");
  const forgedParts = token.split(".");
  forgedParts[2] = `${forgedParts[2][0] === "A" ? "B" : "A"}${forgedParts[2].slice(1)}`;
  const forgedAccess = await appRequest("/api/collections", { token: forgedParts.join(".") });
  assert.equal(forgedAccess.status, 401);
  assert.equal((await forgedAccess.json()).error.code, "invalid_access_assertion");
  const unauthorizedOwner = await appRequest("/api/collections", {
    token: await ownerToken({ email: "other@example.test" }),
  });
  assert.equal(unauthorizedOwner.status, 403);
  const appApiOnApiHost = await apiRequest("/api/capabilities", { key: "irrelevant" });
  assert.equal(appApiOnApiHost.status, 401);
  const forbiddenHost = await miniflare.dispatchFetch("https://other.example.com/", {
    headers: { "Cf-Access-Jwt-Assertion": token },
  });
  assert.equal(forbiddenHost.status, 421);

  const capabilities = await appRequest("/api/capabilities", { token });
  assert.deepEqual(await jsonResponse(capabilities), {
    apiKeys: true,
    apiBaseUrl: apiOrigin,
  });
  const createdKey = await appRequest("/api/keys", {
    method: "POST",
    token,
    body: { name: "local test key", scope: "read_write", expiresInDays: null },
  });
  assert.equal(createdKey.status, 201);
  const { key: keyData, token: bearer } = await jsonResponse(createdKey);
  assert.match(bearer, /^sift_live_/);
  assert.equal(keyData.scope, "read_write");
  const insecureApi = await miniflare.dispatchFetch("http://api.sift.example.com/api/collections", {
    headers: { authorization: `Bearer ${bearer}` },
  });
  assert.equal(insecureApi.status, 400);
  assert.equal((await insecureApi.json()).error.code, "https_required");

  const collectionResponse = await apiRequest("/api/collections", {
    method: "POST",
    key: bearer,
    body: {
      name: "Tradeoffs",
      description: "A D1-backed collection",
      cards: [
        { id: "one", text: "One", detail: "More detail", pros: ["Pro"], cons: ["Con"] },
        { id: "two", text: "Two" },
        { id: "three", text: "Three" },
      ],
    },
  });
  assert.equal(collectionResponse.status, 201);
  const { collection } = await jsonResponse(collectionResponse);
  assert.deepEqual(collection.cards[0].pros, ["Pro"]);
  assert.deepEqual(collection.cards[1].pros, []);
  assert.deepEqual(collection.cards[1].cons, []);

  const readOnlyResponse = await appRequest("/api/keys", {
    method: "POST",
    token,
    body: { name: "read key", scope: "read", expiresInDays: 30 },
  });
  assert.equal(readOnlyResponse.status, 201);
  const { token: readBearer } = await jsonResponse(readOnlyResponse);
  const readDenied = await apiRequest("/api/collections", {
    method: "POST", key: readBearer,
    body: { name: "Blocked", cards: [{ id: "a", text: "A" }, { id: "b", text: "B" }] },
  });
  assert.equal(readDenied.status, 403);

  const longReason = "r".repeat(200);
  const tooLargeCards = Array.from({ length: 480 }, (_, index) => ({
    id: `large-${index}`,
    text: `Large card ${index}`,
    pros: Array(10).fill(longReason),
    cons: Array(10).fill(longReason),
  }));
  assert.ok(new TextEncoder().encode(JSON.stringify({ name: "D1 row cap", cards: tooLargeCards })).byteLength < 2 * 1024 * 1024);
  const tooLargeSnapshot = await apiRequest("/api/collections", {
    method: "POST", key: bearer,
    body: { name: "D1 row cap", cards: tooLargeCards },
  });
  assert.equal(tooLargeSnapshot.status, 413);
  assert.equal((await tooLargeSnapshot.json()).error.code, "snapshot_too_large");

  const appMutationMissingOrigin = await appRequest("/api/collections", {
    method: "POST", token, origin: null,
    body: { name: "Blocked", cards: [{ id: "a", text: "A" }, { id: "b", text: "B" }] },
  });
  assert.equal(appMutationMissingOrigin.status, 403);

  const createdRun = await apiRequest("/api/runs", {
    method: "POST", key: bearer, body: { collectionId: collection.id, keepLimit: 1 },
  });
  assert.equal(createdRun.status, 201);
  const { run } = await jsonResponse(createdRun);

  const readOnlyMutations = await Promise.all([
    apiRequest(`/api/runs/${run.id}/plan`, {
      method: "PATCH", key: readBearer, body: { expectedPlanRevision: 0, rounds: [{ title: "Round 1", keepLimit: 1 }] },
    }),
    apiRequest(`/api/runs/${run.id}/skip`, {
      method: "POST", key: readBearer, body: { cardId: "one", expectedRevision: 0 },
    }),
    apiRequest(`/api/runs/${run.id}/revise`, {
      method: "POST", key: readBearer, body: { cardId: "one", choice: "discard", expectedRevision: 0 },
    }),
  ]);
  assert.deepEqual(readOnlyMutations.map((response) => response.status), [403, 403, 403]);

  const concurrentKeeps = await Promise.all([
    apiRequest(`/api/runs/${run.id}/decisions`, {
      method: "POST", key: bearer,
      body: { cardId: "one", choice: "keep", expectedRevision: 0 },
    }),
    apiRequest(`/api/runs/${run.id}/decisions`, {
      method: "POST", key: bearer,
      body: { cardId: "two", choice: "keep", expectedRevision: 0 },
    }),
  ]);
  assert.deepEqual(concurrentKeeps.map((response) => response.status).sort(), [200, 409]);
  let savedRun = (await jsonResponse(concurrentKeeps.find((response) => response.status === 200))).run;
  assert.equal(savedRun.keptCount, 1);
  assert.equal(savedRun.revision, 1);
  const concurrentUndo = await Promise.all([
    apiRequest(`/api/runs/${run.id}/undo`, {
      method: "POST", key: bearer, body: { expectedRevision: savedRun.revision },
    }),
    apiRequest(`/api/runs/${run.id}/undo`, {
      method: "POST", key: bearer, body: { expectedRevision: savedRun.revision },
    }),
  ]);
  assert.deepEqual(concurrentUndo.map((response) => response.status).sort(), [200, 409]);
  savedRun = (await jsonResponse(concurrentUndo.find((response) => response.status === 200))).run;
  assert.equal(savedRun.revision, 2);
  assert.ok(savedRun.decisions[0].undoneAt);

  const editInputs = (name) => ({
    name,
    description: collection.description,
    keepLabel: collection.keepLabel,
    discardLabel: collection.discardLabel,
    cards: collection.cards,
    expectedUpdatedAt: collection.updatedAt,
  });
  const concurrentEdits = await Promise.all([
    apiRequest(`/api/collections/${collection.id}`, { method: "PUT", key: bearer, body: editInputs("Updated A") }),
    apiRequest(`/api/collections/${collection.id}`, { method: "PUT", key: bearer, body: editInputs("Updated B") }),
  ]);
  assert.deepEqual(concurrentEdits.map((response) => response.status).sort(), [200, 409]);
  const edited = (await jsonResponse(concurrentEdits.find((response) => response.status === 200))).collection;
  const oldSnapshot = await apiRequest(`/api/runs/${run.id}`, { key: bearer });
  assert.equal((await jsonResponse(oldSnapshot)).run.cards[0].detail, "More detail");

  const secondRunResponse = await apiRequest("/api/runs", {
    method: "POST", key: bearer, body: { collectionId: collection.id, keepLimit: 2 },
  });
  const secondRun = (await jsonResponse(secondRunResponse)).run;
  for (const [index, card] of secondRun.cards.entries()) {
    const decision = await apiRequest(`/api/runs/${secondRun.id}/decisions`, {
      method: "POST", key: bearer,
      body: { cardId: card.id, choice: index < 2 ? "keep" : "discard", expectedRevision: index },
    });
    assert.equal(decision.status, 200);
  }
  const [refine, parentUndo] = await Promise.all([
    apiRequest("/api/runs", {
      method: "POST", key: bearer,
      body: { parentRunId: secondRun.id, keepLimit: 1 },
    }),
    apiRequest(`/api/runs/${secondRun.id}/undo`, {
      method: "POST", key: bearer,
      body: { expectedRevision: secondRun.cards.length },
    }),
  ]);
  assert.ok([201, 409].includes(refine.status));
  if (refine.status === 201) {
    assert.equal(parentUndo.status, 409);
    assert.equal((await parentUndo.json()).error.code, "run_has_later_results");
  } else {
    assert.equal(parentUndo.status, 200);
  }
  if (refine.status === 201) {
    const { run: child } = await jsonResponse(refine);
    assert.equal(child.parentRunId, secondRun.id);
    assert.deepEqual(child.cards.map((card) => card.id), secondRun.cards.slice(0, 2).map((card) => card.id));
  }
  const history = await apiRequest("/api/runs", { key: bearer });
  const historyRuns = (await jsonResponse(history)).runs;
  assert.ok(historyRuns.some((historyRun) => historyRun.id === run.id));
  assert.ok(historyRuns.every((historyRun) => Array.isArray(historyRun.decisions)));

  const apiAdmin = await apiRequest("/api/keys", { key: bearer });
  assert.equal(apiAdmin.status, 404);
  const unknownHost = await miniflare.dispatchFetch("https://not-sift.example/api/collections");
  assert.equal(unknownHost.status, 421);

  const keysAfter = await appRequest("/api/keys", { token });
  const { keys } = await jsonResponse(keysAfter);
  assert.equal(keys.length, 2);
  assert.equal(edited.cards[0].pros[0], "Pro");
});

test("transfer routes require write auth to preview/import and preserve exports add-only", async () => {
  const token = await ownerToken();
  const unauthenticated = await appRequest("/api/transfers/preview", { method: "POST", body: { archive: {} } });
  assert.equal(unauthenticated.status, 401);
  const created = await appRequest("/api/collections", { method: "POST", token, body: {
    name: "Transfer fixture",
    cards: [
      { id: "transfer-a", text: "First", detail: "Context", pros: ["Pro"], cons: ["Con"] },
      { id: "transfer-b", text: "Second" },
    ],
  } });
  assert.equal(created.status, 201);
  const { collection } = await jsonResponse(created);
  const exportedResponse = await appRequest(`/api/transfers/export?collectionId=${collection.id}`, { token });
  assert.equal(exportedResponse.status, 200);
  const { archive } = await jsonResponse(exportedResponse);
  assert.equal(archive.collections.length, 1);
  const previewResponse = await appRequest("/api/transfers/preview", { method: "POST", token, body: { archive } });
  assert.equal(previewResponse.status, 200);
  const preview = await jsonResponse(previewResponse);
  assert.equal(preview.summary.duplicateCount, 1);
  assert.equal(preview.summary.collections[0].name, collection.name);
  assert.equal(preview.summary.collections[0].cardCount, collection.cards.length);
  const badLaterBundle = structuredClone(archive);
  badLaterBundle.collections.push({ id: crypto.randomUUID(), records: [] });
  const rejected = await appRequest("/api/transfers/preview", { method: "POST", token, body: { archive: badLaterBundle } });
  assert.equal(rejected.status, 400);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM collections WHERE id = ?").bind(collection.id).first()).count, 1);
  const imported = await appRequest("/api/transfers/import", { method: "POST", token, body: { archive, previewToken: preview.previewToken } });
  assert.equal(imported.status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM collections WHERE id = ?").bind(collection.id).first()).count, 1);

  const changedResponse = await appRequest(`/api/collections/${collection.id}`, { method: "PUT", token, body: {
    name: "Changed after preview", description: collection.description, keepLabel: collection.keepLabel,
    discardLabel: collection.discardLabel, cards: collection.cards, expectedUpdatedAt: collection.updatedAt,
  } });
  assert.equal(changedResponse.status, 200);
  const staleConfirmation = await appRequest("/api/transfers/import", { method: "POST", token, body: { archive, previewToken: preview.previewToken } });
  assert.equal(staleConfirmation.status, 409, "concurrent library changes require a new preview");

  const copiedArchive = remapTransferBundleIDs(archive, archive.collections[0].id);
  const copiedPreviewResponse = await appRequest("/api/transfers/preview", { method: "POST", token, body: { archive: copiedArchive } });
  const copiedPreview = await jsonResponse(copiedPreviewResponse);
  assert.equal(copiedPreviewResponse.status, 200);
  const copiedImport = await appRequest("/api/transfers/import", { method: "POST", token, body: { archive: copiedArchive, previewToken: copiedPreview.previewToken } });
  assert.equal(copiedImport.status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM transfer_records WHERE collection_id = ?").bind(copiedArchive.collections[0].id).first()).count,
    copiedArchive.collections[0].records.length, "canonical records persist in the additive transfer table");
  const copiedRetryPreviewResponse = await appRequest("/api/transfers/preview", { method: "POST", token, body: { archive: copiedArchive } });
  const copiedRetryPreview = await jsonResponse(copiedRetryPreviewResponse);
  const copiedRetry = await appRequest("/api/transfers/import", { method: "POST", token, body: { archive: copiedArchive, previewToken: copiedRetryPreview.previewToken } });
  const copiedRetrySummary = await jsonResponse(copiedRetry);
  assert.equal(copiedRetrySummary.recordCount, 0);
  assert.equal(copiedRetrySummary.duplicateCount, 1);
  assert.match(copiedRetrySummary.message, /^Already present\./);
  const changedExportTime = structuredClone(copiedArchive);
  changedExportTime.exportedAt = new Date(Date.parse(changedExportTime.exportedAt) + 1000).toISOString();
  const retryResponse = await appRequest("/api/transfers/preview", { method: "POST", token, body: { archive: changedExportTime } });
  const retryPreview = await jsonResponse(retryResponse);
  assert.equal(retryPreview.summary.duplicateCount, 1, "deterministically remapped archive remains a duplicate when exported later");
  assert.equal(retryPreview.summary.conflictCount, 0);

  const keyResponse = await appRequest("/api/keys", { method: "POST", token, body: { name: "Transfer read key", scope: "read", expiresInDays: 30 } });
  const { token: readKey } = await jsonResponse(keyResponse);
  const readExport = await apiRequest(`/api/transfers/export?collectionId=${collection.id}`, { key: readKey });
  assert.equal(readExport.status, 200, JSON.stringify(await readExport.clone().json()));
  const readImport = await apiRequest("/api/transfers/import", { method: "POST", key: readKey, body: { archive, previewToken: preview.previewToken } });
  assert.equal(readImport.status, 403);
  assert.equal((await jsonResponse(readImport)).error.code, "read_only_key");
});

test("D1 retains new canonical history and native collection versions through export", async () => {
  const token = await ownerToken();
  const collectionResponse = await appRequest("/api/collections", { method: "POST", token, body: {
    name: "History transfer",
    cards: [{ id: "history-a", text: "First" }, { id: "history-b", text: "Second" },
      { id: "history-c", text: "Third" }, { id: "history-d", text: "Fourth" }],
  } });
  const { collection } = await jsonResponse(collectionResponse);
  const initialResponse = await appRequest(`/api/transfers/export?collectionId=${collection.id}`, { token });
  const initial = (await jsonResponse(initialResponse)).archive;
  const timestamp = new Date().toISOString();
  const decisions = collection.cards.map((card, index) => ({
    id: crypto.randomUUID(), cardId: card.id, choice: index < 2 ? "keep" : "discard", position: index, createdAt: timestamp, undoneAt: null,
  }));
  const extended = webWorkspaceToTransfer({ collections: [collection], runs: [{
    id: crypto.randomUUID(), sortId: crypto.randomUUID(), collectionId: collection.id, roundNumber: 1,
    roundTitle: "Round 1", roundPlan: [{ title: "Round 1", keepLimit: 2 }], keepLimit: 2,
    cards: collection.cards, queue: [], decisions, createdAt: timestamp,
  }] });
  assert.equal(extended.collections[0].records.length, initial.collections[0].records.length + 6);
  const previewResponse = await appRequest("/api/transfers/preview", { method: "POST", token, body: { archive: extended } });
  const preview = await jsonResponse(previewResponse);
  assert.equal(preview.summary.duplicateCount, 0);
  assert.equal(preview.summary.conflictCount, 1);
  const before = await db.prepare("SELECT COUNT(*) AS count FROM collections").first();
  const importResponse = await appRequest("/api/transfers/import", { method: "POST", token, body: { archive: extended, previewToken: preview.previewToken } });
  assert.equal(importResponse.status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM collections").first()).count, before.count + 1);
  const retained = await db.prepare("SELECT COUNT(*) AS count FROM transfer_records WHERE collection_id != ?").bind(collection.id).first();
  assert.ok(retained.count >= extended.collections[0].records.length);
  const later = structuredClone(extended);
  later.exportedAt = new Date(Date.parse(later.exportedAt) + 1000).toISOString();
  const retryResponse = await appRequest("/api/transfers/preview", { method: "POST", token, body: { archive: later } });
  const retry = await jsonResponse(retryResponse);
  assert.equal(retry.summary.duplicateCount, 1);
  assert.equal(retry.summary.conflictCount, 0);

  const nativeVersions = JSON.parse(await readFile(path.join(root, "tests/fixtures/transfer/native-multiple-leaves.json"), "utf8"));
  const versionBundle = nativeVersions.collections[0];
  const versionPreviewResponse = await appRequest("/api/transfers/preview", { method: "POST", token, body: { archive: nativeVersions } });
  const versionPreview = await jsonResponse(versionPreviewResponse);
  const versionImport = await appRequest("/api/transfers/import", { method: "POST", token, body: { archive: nativeVersions, previewToken: versionPreview.previewToken } });
  assert.equal(versionImport.status, 200);
  const aliases = await db.prepare("SELECT collection_id, transfer_bundle_id, source_revision_id FROM transfer_collection_versions WHERE transfer_bundle_id = ?")
    .bind(versionBundle.id).all();
  assert.equal(aliases.results.length, 2);
  assert.ok(aliases.results.every((item) => item.source_revision_id));
  const selected = aliases.results[1].collection_id;
  const versionExportResponse = await appRequest(`/api/transfers/export?collectionId=${selected}`, { token });
  const versionExport = (await jsonResponse(versionExportResponse)).archive;
  assert.equal(versionExport.collections.length, 1);
  assert.equal(versionExport.collections[0].records.length, versionBundle.records.length);
});

test("D1 collection and round titles accept native grapheme limits", async () => {
  const token = await ownerToken();
  const name = "🌱".repeat(100);
  const description = "🪴".repeat(500);
  const label = "✨".repeat(36);
  const createdResponse = await appRequest("/api/collections", { method: "POST", token, body: {
    name, description, keepLabel: label, discardLabel: label,
    cards: [{ id: "unicode-a", text: "A" }, { id: "unicode-b", text: "B" }],
  } });
  const created = await jsonResponse(createdResponse);
  assert.equal(createdResponse.status, 201);
  const update = await appRequest(`/api/collections/${created.collection.id}`, { method: "PUT", token, body: {
    ...created.collection, expectedUpdatedAt: created.collection.updatedAt,
  } });
  assert.equal(update.status, 200);
  assert.equal((await jsonResponse(update)).collection.name, name);
  const roundTitle = "🌱".repeat(40);
  const runResponse = await appRequest("/api/runs", { method: "POST", token, body: {
    collectionId: created.collection.id, keepLimit: 1, rounds: [{ title: roundTitle, keepLimit: 1 }],
  } });
  assert.equal(runResponse.status, 201);
  assert.equal((await jsonResponse(runResponse)).run.roundTitle, roundTitle);
});

test("D1 rejects a deterministic alternate that already has different canonical records", async () => {
  const token = await ownerToken();
  const source = JSON.parse(await readFile(path.join(root, "tests/fixtures/transfer/full-history.json"), "utf8"));
  const importArchive = async (archive) => {
    const previewResponse = await appRequest("/api/transfers/preview", { method: "POST", token, body: { archive } });
    assert.equal(previewResponse.status, 200);
    const preview = await jsonResponse(previewResponse);
    return appRequest("/api/transfers/import", { method: "POST", token, body: { archive, previewToken: preview.previewToken } });
  };
  assert.equal((await importArchive(varyTransferTitles(source, " existing original"))).status, 200);
  const alternate = varyTransferTitles(remapTransferBundleIDs(source, source.collections[0].id), " changed");
  assert.equal((await importArchive(alternate)).status, 200);
  const before = {
    collections: (await db.prepare("SELECT COUNT(*) AS count FROM collections").first()).count,
    runs: (await db.prepare("SELECT COUNT(*) AS count FROM runs").first()).count,
    records: (await db.prepare("SELECT COUNT(*) AS count FROM transfer_records").first()).count,
  };
  const rejected = await appRequest("/api/transfers/preview", { method: "POST", token, body: { archive: source } });
  assert.equal(rejected.status, 409);
  assert.equal((await jsonResponse(rejected)).error.code, "transfer_conflict");
  assert.deepEqual({
    collections: (await db.prepare("SELECT COUNT(*) AS count FROM collections").first()).count,
    runs: (await db.prepare("SELECT COUNT(*) AS count FROM runs").first()).count,
    records: (await db.prepare("SELECT COUNT(*) AS count FROM transfer_records").first()).count,
  }, before);
});

test("only exact public privacy and support reads bypass app authentication", async () => {
  for (const [route, title] of [["/privacy", "Privacy"], ["/support", "Support"]]) {
    const response = await appRequest(route);
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp(`<title>${title}</title>`));
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "public, max-age=300, s-maxage=3600");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.match(response.headers.get("Content-Security-Policy"), /script-src 'none'/u);
    assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/u);
    const head = await appRequest(route, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  }

  for (const [origin, route, method] of [
    [appOrigin, "/", "GET"],
    [appOrigin, "/privacy/", "GET"],
    [appOrigin, "/priv%61cy", "GET"],
    [appOrigin, "/privacy%2F", "GET"],
    [appOrigin, "/privacy/extra", "GET"],
    [appOrigin, "/support/", "GET"],
    [appOrigin, "/privacy", "POST"],
    [apiOrigin, "/privacy", "GET"],
  ]) {
    const response = await miniflare.dispatchFetch(new URL(route, origin).href, { method });
    assert.equal(response.status, 401, `${method} ${origin}${route} must remain authenticated`);
  }
});

test("public privacy and support documents are self-contained HTML without scripts", async () => {
  for (const name of ["privacy.html", "support.html"]) {
    const html = await readFile(path.join(root, "public", name), "utf8");
    assert.doesNotMatch(html, /<script\b|\bsrc="https?:/iu);
    assert.match(html, /name="sift-public-page"/u);
  }
  const privacy = await readFile(path.join(root, "public/privacy.html"), "utf8");
  assert.match(privacy, /Effective November 9, 2026/u);
  assert.match(privacy, /Cloudflare Web Analytics/u);
  assert.match(privacy, /user-accessible library erasure feature/u);
});

test("public paths fail closed when ASSETS returns a private app-shell fallback", async () => {
  const response = await handleRequest(new Request(new URL("/privacy", appOrigin)), {
    SIFT_APP_HOST: "sift.example.com",
    SIFT_API_HOST: "api.sift.example.com",
    ASSETS: { fetch: async () => new Response('<html><meta name="sift-app" content="sift-card-sorter"></html>', {
      headers: { "content-type": "text/html; charset=utf-8" },
    }) },
  });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
