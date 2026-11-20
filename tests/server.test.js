import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAppServer } from "../server/index.js";
import { remapTransferBundleIDs, transferToWebWorkspace, validateTransfer, webWorkspaceToTransfer } from "../shared/transfer.js";

const roots = [];
const servers = [];

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sift-server-test-"));
  roots.push(root);
  const staticDir = path.join(root, "static");
  await mkdir(staticDir, { recursive: true });
  await writeFile(path.join(staticDir, "index.html"), "<!doctype html><title>Sift fixture</title>");
  await writeFile(path.join(staticDir, "app.js"), "console.log('fixture')");
  const server = createAppServer({
    dbPath: path.join(root, "db", "sift.sqlite"),
    staticDir,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  async function request(route, { method = "GET", body, originHeader = origin } = {}) {
    const response = await fetch(new URL(route, origin), {
      method,
      headers: {
        accept: "text/html",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(originHeader === null ? {} : { origin: originHeader }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : await response.text();
    return { status: response.status, json };
  }
  return { root, staticDir, server, origin, request };
}

const cards = [
  { id: "curiosity", text: "Curiosity", detail: "Keep learning.", pros: ["Stay curious"], cons: ["Takes time"] },
  { id: "health", text: "Health", detail: "Make room for rest." },
  { id: "family", text: "Family", detail: "Show up." },
  { id: "craft", text: "Craft", detail: "Make thoughtful things." },
];

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

async function collection(request, definitions = cards) {
  const created = await request("/api/collections", {
    method: "POST",
    body: {
      name: "Personal Values",
      description: "A values list.",
      keepLabel: "Keep",
      discardLabel: "Let go",
      cards: definitions,
    },
  });
  assert.equal(created.status, 201);
  return created.json.collection;
}

test("creates a collection and run, enforces the maximum keeps, and refines a completed round", async () => {
  const { request } = await fixture();
  const created = await collection(request);
  const start = await request("/api/runs", {
    method: "POST",
    body: { collectionId: created.id, keepLimit: 2 },
  });
  assert.equal(start.status, 201);
  const run = start.json.run;

  const keepCuriosity = await request(`/api/runs/${run.id}/decisions`, {
    method: "POST", body: { cardId: "curiosity", choice: "keep", expectedRevision: 0 },
  });
  assert.equal(keepCuriosity.status, 200);
  assert.equal(keepCuriosity.json.run.revision, 1);
  const keepHealth = await request(`/api/runs/${run.id}/decisions`, {
    method: "POST", body: { cardId: "health", choice: "keep", expectedRevision: 1 },
  });
  assert.equal(keepHealth.status, 200);

  const blockedExtraKeep = await request(`/api/runs/${run.id}/decisions`, {
    method: "POST", body: { cardId: "family", choice: "keep", expectedRevision: 2 },
  });
  assert.equal(blockedExtraKeep.status, 409);
  assert.equal(blockedExtraKeep.json.error.code, "keep_limit_reached");

  const conflict = await request(`/api/runs/${run.id}/decisions`, {
    method: "POST", body: { cardId: "family", choice: "discard", expectedRevision: 0 },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, "revision_conflict");

  const discardFamily = await request(`/api/runs/${run.id}/decisions`, {
    method: "POST", body: { cardId: "family", choice: "discard", expectedRevision: 2 },
  });
  assert.equal(discardFamily.json.run.revision, 3);
  const discardCraft = await request(`/api/runs/${run.id}/decisions`, {
    method: "POST", body: { cardId: "craft", choice: "discard", expectedRevision: 3 },
  });
  assert.equal(discardCraft.json.run.status, "complete");

  const nextRound = await request("/api/runs", {
    method: "POST", body: { parentRunId: run.id, keepLimit: 1 },
  });
  assert.equal(nextRound.status, 201);
  assert.equal(nextRound.json.run.parentRunId, run.id);
  assert.equal(nextRound.json.run.roundNumber, 2);
  assert.deepEqual(nextRound.json.run.cards.map((card) => card.id), ["curiosity", "health"]);
  assert.deepEqual(nextRound.json.run.cards[0].pros, ["Stay curious"]);
  assert.deepEqual(nextRound.json.run.cards[0].cons, ["Takes time"]);

  const collectionAfter = await request(`/api/collections/${created.id}`);
  assert.equal(collectionAfter.json.collection.cards.length, 4);
  const parentAfter = await request(`/api/runs/${run.id}`);
  assert.equal(parentAfter.json.run.status, "complete");
  assert.equal(parentAfter.json.run.decisions.length, 4);
});

test("transfer export includes complete web history and preview/import are add-only and idempotent", async () => {
  const { request } = await fixture();
  const created = await collection(request);
  const originalCollectionIDs = (await request("/api/collections")).json.collections.map((item) => item.id).sort();
  const started = (await request("/api/runs", { method: "POST", body: {
    collectionId: created.id, keepLimit: 2,
    rounds: [{ title: "First", keepLimit: 2 }, { title: "Next", keepLimit: 1 }],
  } })).json.run;
  const skipped = await request(`/api/runs/${started.id}/skip`, { method: "POST", body: { cardId: "curiosity", expectedRevision: 0 } });
  assert.equal(skipped.status, 200);
  let revision = skipped.json.run.revision;
  const firstDecision = await request(`/api/runs/${started.id}/decisions`, { method: "POST", body: { cardId: "curiosity", choice: "keep", expectedRevision: revision } });
  revision = firstDecision.json.run.revision;
  const replacement = await request(`/api/runs/${started.id}/revise`, { method: "POST", body: { cardId: "curiosity", choice: "discard", expectedRevision: revision } });
  assert.equal(replacement.status, 200);
  revision = replacement.json.run.revision;
  const undone = await request(`/api/runs/${started.id}/undo`, { method: "POST", body: { expectedRevision: revision } });
  assert.equal(undone.status, 200);
  revision = undone.json.run.revision;
  for (const [index, card] of started.cards.filter((card) => card.id !== "curiosity").entries()) {
    const result = await request(`/api/runs/${started.id}/decisions`, { method: "POST", body: {
      cardId: card.id, choice: index < 1 ? "keep" : "discard", expectedRevision: revision,
    } });
    assert.equal(result.status, 200);
    revision = result.json.run.revision;
  }
  const next = await request("/api/runs", { method: "POST", body: { parentRunId: started.id } });
  assert.equal(next.status, 201);
  const branch = await request(`/api/runs/${started.id}/revise`, { method: "POST", body: { cardId: "curiosity", choice: "keep", expectedRevision: revision } });
  assert.equal(branch.status, 200);
  const queuedRun = await request("/api/runs", { method: "POST", body: { collectionId: created.id, keepLimit: 2 } });
  assert.equal(queuedRun.status, 201);
  const queuedSkip = await request(`/api/runs/${queuedRun.json.run.id}/skip`, { method: "POST", body: { cardId: "family", expectedRevision: 0 } });
  assert.equal(queuedSkip.status, 200);

  const exported = await request(`/api/transfers/export?collectionId=${created.id}`);
  assert.equal(exported.status, 200);
  const archive = validateTransfer(exported.json.archive);
  assert.equal(archive.collections.length, 1);
  assert.ok(archive.collections[0].records.some((record) => record.kind === "sortAction"));
  assert.equal(archive.collections[0].records.filter((record) => record.kind === "sortSession").length, 2, "rounds and revised paths share one session while a separate queue stays isolated");
  const operations = archive.collections[0].records.filter((record) => record.kind === "sortAction")
    .map((record) => Object.keys(JSON.parse(Buffer.from(record.payload, "base64").toString("utf8")).operation)[0]);
  for (const operation of ["skipped", "undone", "roundStarted", "revisedPath"]) assert.ok(operations.includes(operation), `export includes ${operation} history`);
  await writeFile(path.join(os.tmpdir(), "sift-transfer-web-fixture.sift.json"), `${JSON.stringify(archive, null, 2)}\n`, { mode: 0o600 });

  const preview = await request("/api/transfers/preview", { method: "POST", body: { archive } });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.summary.duplicateCount, 1, "same-site backup is recognized as the same collection");
  assert.equal(preview.json.summary.collections[0].name, created.name);
  assert.equal(preview.json.summary.collections[0].cardCount, created.cards.length);
  assert.equal(preview.json.summary.collections[0].historyPathCount, 3);
  const imported = await request("/api/transfers/import", { method: "POST", body: { archive, previewToken: preview.json.previewToken } });
  assert.equal(imported.status, 200);
  const after = await request("/api/collections");
  assert.deepEqual(after.json.collections.map((item) => item.id).sort(), originalCollectionIDs, "import leaves the original library intact without duplicating it");
  const importedAgain = await request("/api/transfers/import", { method: "POST", body: { archive, previewToken: preview.json.previewToken } });
  assert.equal(importedAgain.status, 200);
  assert.equal(importedAgain.json.recordCount, 0);
  assert.equal(importedAgain.json.duplicateCount, 1);
  assert.match(importedAgain.json.message, /^Already present\./);
  assert.deepEqual((await request("/api/collections")).json.collections.map((item) => item.id).sort(), originalCollectionIDs);

  const changed = await request(`/api/collections/${created.id}`, { method: "PUT", body: {
    name: "Changed after preview", description: created.description, keepLabel: created.keepLabel, discardLabel: created.discardLabel,
    cards: created.cards, expectedUpdatedAt: created.updatedAt,
  } });
  assert.equal(changed.status, 200);
  const staleConfirmation = await request("/api/transfers/import", { method: "POST", body: { archive, previewToken: preview.json.previewToken } });
  assert.equal(staleConfirmation.status, 409, "a changed library requires a fresh preview before import");

  const copiedArchive = remapTransferBundleIDs(archive, archive.collections[0].id);
  const copyPreview = await request("/api/transfers/preview", { method: "POST", body: { archive: copiedArchive } });
  assert.equal(copyPreview.status, 200);
  const copyImport = await request("/api/transfers/import", { method: "POST", body: { archive: copiedArchive, previewToken: copyPreview.json.previewToken } });
  assert.equal(copyImport.status, 200);
  assert.equal(copyImport.json.recordCount, copiedArchive.collections[0].records.length);
  const copyRetryPreview = await request("/api/transfers/preview", { method: "POST", body: { archive: copiedArchive } });
  const copyRetry = await request("/api/transfers/import", { method: "POST", body: { archive: copiedArchive, previewToken: copyRetryPreview.json.previewToken } });
  assert.equal(copyRetry.json.recordCount, 0);
  assert.equal(copyRetry.json.duplicateCount, 1);
  assert.match(copyRetry.json.message, /^Already present\./);
  assert.equal((await request("/api/collections")).json.collections.length, originalCollectionIDs.length + 1);
});

test("native-valid grapheme strings survive website save validation", async () => {
  const { request } = await fixture();
  const title = "😀".repeat(100);
  const detail = "🧭".repeat(500);
  const collectionName = "🌱".repeat(100);
  const collectionDescription = "🪴".repeat(500);
  const label = "✨".repeat(36);
  const created = await request("/api/collections", { method: "POST", body: {
    name: collectionName,
    description: collectionDescription,
    keepLabel: label,
    discardLabel: label,
    cards: [{ id: "unicode-a", text: title, detail, pros: ["🌱".repeat(200)], cons: [] }, { id: "unicode-b", text: "Other" }],
  } });
  assert.equal(created.status, 201);
  const collectionValue = created.json.collection;
  assert.equal(collectionValue.name, collectionName);
  assert.equal(collectionValue.description, collectionDescription);
  assert.equal(collectionValue.keepLabel, label);
  const saved = await request(`/api/collections/${collectionValue.id}`, { method: "PUT", body: {
    name: collectionValue.name,
    description: collectionValue.description,
    keepLabel: collectionValue.keepLabel,
    discardLabel: collectionValue.discardLabel,
    cards: collectionValue.cards,
    expectedUpdatedAt: collectionValue.updatedAt,
  } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.collection.cards[0].text, title);
  assert.equal(saved.json.collection.cards[0].detail, detail);
  assert.equal(saved.json.collection.cards[0].pros[0], "🌱".repeat(200));
  assert.equal(saved.json.collection.name, collectionName);
  assert.equal(saved.json.collection.description, collectionDescription);
  assert.equal(saved.json.collection.keepLabel, label);
});

test("round titles use native grapheme counts", async () => {
  const { request } = await fixture();
  const created = await collection(request);
  const title = "🌱".repeat(40);
  const started = await request("/api/runs", { method: "POST", body: {
    collectionId: created.id,
    keepLimit: 2,
    rounds: [{ title, keepLimit: 2 }],
  } });
  assert.equal(started.status, 201);
  assert.equal(started.json.run.roundTitle, title);
  const edited = await request(`/api/runs/${started.json.run.id}/plan`, { method: "PATCH", body: {
    expectedPlanRevision: started.json.run.planRevision,
    rounds: [{ title, keepLimit: 2 }],
  } });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.run.roundPlan[0].title, title);
});

test("numeric card values and rating rounds survive review, round transitions, and transfer roundtrip", async () => {
  const { request } = await fixture();
  const fieldID = "9F13E773-A8CB-49E5-AAD4-2A4D57F82B21";
  const duplicateKeys = await request("/api/collections", { method: "POST", body: {
    name: "Duplicate field keys",
    numericFields: [{ id: fieldID, name: "Weight", minimum: -2, maximum: 2, step: 0.25, unit: "kg" }],
    cards: [{ id: "one", text: "One", numericValues: { [fieldID]: 0, [fieldID.toLowerCase()]: 1 } }, { id: "two", text: "Two" }],
  } });
  assert.equal(duplicateKeys.status, 400);
  assert.equal(duplicateKeys.json.error.code, "invalid_numeric_fields");
  const collectionResponse = await request("/api/collections", { method: "POST", body: {
    name: "Numeric values",
    numericFields: [{ id: fieldID, name: "123e4567-e89b-12d3-a456-426614174000", minimum: -2, maximum: 2, step: 0.25, unit: "kg" }],
    cards: [
      { id: "one", text: "One", numericValues: { [fieldID.toLowerCase()]: 0 } },
      { id: "two", text: "Two", numericValues: { [fieldID]: -0.5 } },
      { id: "three", text: "Three", numericValues: { [fieldID]: 1.25 } },
      { id: "four", text: "Four" },
    ],
  } });
  assert.equal(collectionResponse.status, 201);
  const collectionValue = collectionResponse.json.collection;
  assert.equal(collectionValue.numericFields[0].id, fieldID);
  assert.deepEqual(collectionValue.cards.map((card) => card.numericValues[fieldID] ?? null), [0, -0.5, 1.25, null]);
  const ratingScale = { name: " Value ", minimum: -1, maximum: 1, step: 0.25, unit: "points " };
  const first = await request("/api/runs", { method: "POST", body: {
    collectionId: collectionValue.id,
    rounds: [
      { title: "Value", ratingScale },
      { title: "Keepers", keepLimit: 2 },
      { title: "Final score", ratingScale: { name: "Score", minimum: 0, maximum: 5, step: 0.5, unit: "stars" } },
    ],
  } });
  assert.equal(first.status, 201);
  const run1 = first.json.run;
  assert.equal(run1.keepLimit, null, "rating rounds do not expose the internal card-count sentinel as a keep cap");
  assert.deepEqual(run1.ratingScale, ratingScale);
  assert.deepEqual(run1.numericFields, collectionValue.numericFields);
  const offGrid = await request(`/api/runs/${run1.id}/decisions`, { method: "POST", body: { cardId: "one", choice: "rating", value: 0.1, expectedRevision: 0 } });
  assert.equal(offGrid.status, 400);
  assert.equal(offGrid.json.error.code, "invalid_rating");
  const zero = await request(`/api/runs/${run1.id}/decisions`, { method: "POST", body: { cardId: "one", choice: "rating", value: 0, expectedRevision: 0 } });
  assert.equal(zero.status, 200);
  assert.equal(zero.json.run.decisions[0].value, 0);
  const skipped = await request(`/api/runs/${run1.id}/skip`, { method: "POST", body: { cardId: "two", expectedRevision: 1 } });
  assert.equal(skipped.status, 200);
  let revision = skipped.json.run.revision;
  for (const [cardId, value] of [["three", -0.5], ["four", 1], ["two", 0.25]]) {
    const result = await request(`/api/runs/${run1.id}/decisions`, { method: "POST", body: { cardId, choice: "rating", value, expectedRevision: revision } });
    assert.equal(result.status, 200);
    revision = result.json.run.revision;
  }
  const replacement = await request(`/api/runs/${run1.id}/revise`, { method: "POST", body: { cardId: "one", choice: "rating", value: -0.25, expectedRevision: revision } });
  assert.equal(replacement.status, 200);
  assert.equal(replacement.json.run.decisions.find((decision) => decision.cardId === "one" && !decision.undoneAt).value, -0.25);
  const restored = await request(`/api/runs/${run1.id}/undo`, { method: "POST", body: { expectedRevision: replacement.json.run.revision } });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.run.decisions.find((decision) => decision.cardId === "one" && !decision.undoneAt).value, 0);
  assert.equal(restored.json.run.status, "complete");

  const second = await request("/api/runs", { method: "POST", body: { parentRunId: run1.id } });
  assert.equal(second.status, 201);
  assert.deepEqual(second.json.run.cards.map((card) => card.id), ["one", "two", "three", "four"], "rating rounds pass every card onward");
  let choiceRevision = 0;
  for (const [index, card] of second.json.run.cards.entries()) {
    const result = await request(`/api/runs/${second.json.run.id}/decisions`, { method: "POST", body: {
      cardId: card.id, choice: index < 2 ? "keep" : "discard", expectedRevision: choiceRevision,
    } });
    assert.equal(result.status, 200);
    choiceRevision = result.json.run.revision;
  }
  const third = await request("/api/runs", { method: "POST", body: { parentRunId: second.json.run.id } });
  assert.equal(third.status, 201);
  assert.deepEqual(third.json.run.cards.map((card) => card.id), ["one", "two"], "choice rounds pass only keeps onward");
  assert.deepEqual(third.json.run.ratingScale, { name: "Score", minimum: 0, maximum: 5, step: 0.5, unit: "stars" });
  const rated = await request(`/api/runs/${third.json.run.id}/decisions`, { method: "POST", body: { cardId: "one", choice: "rating", value: 2.5, expectedRevision: 0 } });
  assert.equal(rated.status, 200);
  const exportResponse = await request(`/api/transfers/export?collectionId=${collectionValue.id}`);
  assert.equal(exportResponse.status, 200, JSON.stringify(exportResponse.json));
  const archive = validateTransfer(exportResponse.json.archive);
  assert.equal(archive.version, 2);
  await writeFile(path.join(os.tmpdir(), "sift-ratings-web-fixture.sift.json"), `${JSON.stringify(archive, null, 2)}\n`, { mode: 0o600 });
  const importedEnv = await fixture();
  const preview = await importedEnv.request("/api/transfers/preview", { method: "POST", body: { archive } });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const imported = await importedEnv.request("/api/transfers/import", { method: "POST", body: { archive, previewToken: preview.json.previewToken } });
  assert.equal(imported.status, 200, JSON.stringify(imported.json));
  const importedCollection = (await importedEnv.request("/api/collections")).json.collections.find((item) => item.name === collectionValue.name);
  assert.ok(importedCollection);
  assert.deepEqual(importedCollection.numericFields, collectionValue.numericFields);
  const importedRuns = (await importedEnv.request(`/api/runs?collectionId=${importedCollection.id}`)).json.runs;
  assert.equal(importedRuns.length, 3);
  const importedOneID = importedCollection.cards.find((card) => card.text === "One").id;
  assert.equal(importedRuns.find((run) => run.roundNumber === 1).decisions.find((decision) => decision.cardId === importedOneID && !decision.undoneAt).value, 0);
  const repeated = (await importedEnv.request(`/api/transfers/export?collectionId=${importedCollection.id}`));
  assert.equal(repeated.status, 200, JSON.stringify(repeated.json));
  assert.equal(validateTransfer(repeated.json.archive).version, 2);
  const importedRunDTO = await importedEnv.request(`/api/runs/${importedRuns.find((run) => run.roundNumber === 1).id}`);
  const planRun = importedRunDTO.json.run;
  const futureScale = { unit: "pts", step: 0.25, name: "Future", maximum: 2, minimum: 0 };
  const editedPlan = planRun.roundPlan.map((round) => ({ ...round, title: `Renamed ${round.title}`,
    ...(round.ratingScale ? { ratingScale: { unit: round.ratingScale.unit, step: round.ratingScale.step, name: round.ratingScale.name, maximum: round.ratingScale.maximum, minimum: round.ratingScale.minimum } } : {}),
  }));
  editedPlan.push({ title: "Future score", keepLimit: null, ratingScale: futureScale });
  const planResponse = await importedEnv.request(`/api/runs/${planRun.id}/plan`, { method: "PATCH", body: {
    expectedPlanRevision: planRun.planRevision, rounds: editedPlan,
  } });
  assert.equal(planResponse.status, 200, JSON.stringify(planResponse.json));
  assert.deepEqual(planResponse.json.run.roundPlan[0].ratingScale, ratingScale);
  const upgraded = await importedEnv.request(`/api/transfers/export?collectionId=${importedCollection.id}`);
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json));
  const upgradedArchive = validateTransfer(upgraded.json.archive);
  assert.ok(upgradedArchive.collections[0].records.some((record) => record.kind === "sortAction" && JSON.parse(Buffer.from(record.payload, "base64").toString("utf8")).operation.planEdited && record.version === 2));
});

test("export retains each run's numeric scale after current collection fields change", async () => {
  const { request } = await fixture();
  const fieldID = "8B63E71E-75B8-467C-8B25-7319270A1C4E";
  const created = await request("/api/collections", { method: "POST", body: {
    name: "Historical cost",
    numericFields: [{ id: fieldID, name: "Cost", minimum: 0, maximum: 100, step: 1, unit: "USD" }],
    cards: [{ id: "a", text: "A", numericValues: { [fieldID]: 80 } }, { id: "b", text: "B", numericValues: { [fieldID]: 60 } }],
  } });
  assert.equal(created.status, 201);
  const collectionValue = created.json.collection;
  const started = await request("/api/runs", { method: "POST", body: { collectionId: collectionValue.id, keepLimit: 1 } });
  const run = started.json.run;
  let revision = 0;
  for (const [index, card] of run.cards.entries()) {
    const result = await request(`/api/runs/${run.id}/decisions`, { method: "POST", body: {
      cardId: card.id, choice: index === 0 ? "keep" : "discard", expectedRevision: revision,
    } });
    assert.equal(result.status, 200);
    revision = result.json.run.revision;
  }
  const edited = await request(`/api/collections/${collectionValue.id}`, { method: "PUT", body: {
    name: collectionValue.name, description: collectionValue.description, keepLabel: collectionValue.keepLabel, discardLabel: collectionValue.discardLabel,
    numericFields: [{ id: fieldID, name: "Cost", minimum: 100, maximum: 200, step: 10, unit: "USD" }],
    cards: [{ id: "a", text: "A", numericValues: { [fieldID]: 150 } }, { id: "b", text: "B", numericValues: { [fieldID]: 120 } }],
    expectedUpdatedAt: collectionValue.updatedAt,
  } });
  assert.equal(edited.status, 200);
  const exported = await request(`/api/transfers/export?collectionId=${collectionValue.id}`);
  assert.equal(exported.status, 200, JSON.stringify(exported.json));
  const projection = transferToWebWorkspace(exported.json.archive);
  assert.deepEqual(projection.collections[0].numericFields[0], edited.json.collection.numericFields[0]);
  assert.equal(projection.collections[0].cards[0].numericValues[fieldID], 150);
  const history = projection.runs[0];
  assert.equal(history.numericFields[0].maximum, 100);
  assert.equal(history.cards[0].numericValues[fieldID], 80);
});

test("native collection version leaves remain individually addressable and export as one archive", async () => {
  const { request } = await fixture();
  const archive = JSON.parse(await readFile(new URL("./fixtures/transfer/native-multiple-leaves.json", import.meta.url), "utf8"));
  const preview = await request("/api/transfers/preview", { method: "POST", body: { archive } });
  assert.equal(preview.status, 200);
  const imported = await request("/api/transfers/import", { method: "POST", body: { archive, previewToken: preview.json.previewToken } });
  assert.equal(imported.status, 200);
  const aliases = (await request("/api/collections")).json.collections.filter((item) => item.transferBundleID === archive.collections[0].id);
  assert.equal(aliases.length, 2);
  assert.ok(aliases.every((item) => item.sourceRevisionID));
  const selected = await request(`/api/transfers/export?collectionId=${aliases[1].id}`);
  assert.equal(selected.status, 200);
  assert.equal(selected.json.archive.collections.length, 1);
  assert.equal(selected.json.archive.collections[0].records.length, archive.collections[0].records.length);
});

test("a deterministic alternate with different canonical records fails closed", async () => {
  const { request, root } = await fixture();
  const source = JSON.parse(await readFile(new URL("./fixtures/transfer/full-history.json", import.meta.url), "utf8"));
  const originalBranch = varyTransferTitles(source, " existing original");
  const importArchive = async (archive) => {
    const preview = await request("/api/transfers/preview", { method: "POST", body: { archive } });
    assert.equal(preview.status, 200);
    return request("/api/transfers/import", { method: "POST", body: { archive, previewToken: preview.json.previewToken } });
  };
  assert.equal((await importArchive(originalBranch)).status, 200);
  const alternateBranch = varyTransferTitles(remapTransferBundleIDs(source, source.collections[0].id), " changed");
  assert.equal((await importArchive(alternateBranch)).status, 200);
  const db = new DatabaseSync(path.join(root, "db", "sift.sqlite"));
  const counts = () => ({
    collections: db.prepare("SELECT COUNT(*) AS count FROM collections").get().count,
    runs: db.prepare("SELECT COUNT(*) AS count FROM runs").get().count,
    records: db.prepare("SELECT COUNT(*) AS count FROM transfer_records").get().count,
  });
  const before = counts();
  const rejected = await request("/api/transfers/preview", { method: "POST", body: { archive: source } });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json.error.code, "transfer_conflict");
  assert.deepEqual(counts(), before);
  db.close();
});

test("an unchanged collection with additional history imports as a separate complete version", async () => {
  const { request } = await fixture();
  const created = await collection(request);
  const baselineIDs = new Set((await request("/api/collections")).json.collections.map((item) => item.id));
  const initial = (await request(`/api/transfers/export?collectionId=${created.id}`)).json.archive;
  const timestamp = new Date().toISOString();
  const importedRun = {
    id: "1c52bb3e-2a47-4af0-9049-7fcaa1500111",
    sortId: "1c52bb3e-2a47-4af0-9049-7fcaa1500222",
    collectionId: created.id,
    roundNumber: 1,
    roundTitle: "Round 1",
    roundPlan: [{ title: "Round 1", keepLimit: 2 }],
    keepLimit: 2,
    cards: created.cards,
    queue: [],
    decisions: created.cards.map((card, index) => ({
      id: `1c52bb3e-2a47-4af0-9049-7fcaa1500${String(index + 300).padStart(3, "0")}`,
      cardId: card.id, choice: index < 2 ? "keep" : "discard", position: index, createdAt: timestamp, undoneAt: null,
    })),
    createdAt: timestamp,
  };
  const extended = webWorkspaceToTransfer({ collections: [created], runs: [importedRun] });
  assert.equal(extended.collections[0].records.length, initial.collections[0].records.length + 6);
  const preview = await request("/api/transfers/preview", { method: "POST", body: { archive: extended } });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.summary.duplicateCount, 0);
  assert.equal(preview.json.summary.conflictCount, 1);
  const imported = await request("/api/transfers/import", { method: "POST", body: { archive: extended, previewToken: preview.json.previewToken } });
  assert.equal(imported.status, 200);
  const collections = (await request("/api/collections")).json.collections;
  assert.equal(collections.length, baselineIDs.size + 1);
  const copy = collections.find((item) => !baselineIDs.has(item.id));
  const copiedArchive = (await request(`/api/transfers/export?collectionId=${copy.id}`)).json.archive;
  assert.ok(copiedArchive.collections[0].records.some((record) => record.kind === "sortSession"));
  const retry = structuredClone(extended);
  retry.exportedAt = new Date(Date.parse(retry.exportedAt) + 1000).toISOString();
  const retryPreview = await request("/api/transfers/preview", { method: "POST", body: { archive: retry } });
  assert.equal(retryPreview.json.summary.duplicateCount, 1);
  assert.equal(retryPreview.json.summary.conflictCount, 0);
  assert.equal((await request("/api/collections")).json.collections.length, baselineIDs.size + 1);
});

test("container API advertises that server-managed API keys are unavailable", async () => {
  const { request } = await fixture();
  const response = await request("/api/capabilities");
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { apiKeys: false });
});

test("undo reopens only the latest decision and retains its audit entry", async () => {
  const { request } = await fixture();
  const created = await collection(request);
  const run = (await request("/api/runs", {
    method: "POST", body: { collectionId: created.id, keepLimit: 2 },
  })).json.run;
  await request(`/api/runs/${run.id}/decisions`, {
    method: "POST", body: { cardId: "curiosity", choice: "keep", expectedRevision: 0 },
  });
  const undone = await request(`/api/runs/${run.id}/undo`, {
    method: "POST", body: { expectedRevision: 1 },
  });
  assert.equal(undone.status, 200);
  assert.equal(undone.json.run.keptCount, 0);
  assert.equal(undone.json.run.status, "in-progress");
  assert.ok(undone.json.run.decisions[0].undoneAt);
  assert.equal(undone.json.run.revision, 2);
});

test("round plans persist, skipping preserves queue order, and revisions fork after a later round", async () => {
  const { request } = await fixture();
  const created = await collection(request);
  const started = await request("/api/runs", {
    method: "POST",
    body: {
      collectionId: created.id,
      keepLimit: 3,
      rounds: [{ title: "Shortlist", keepLimit: 3 }, { title: "Finalists", keepLimit: 1 }],
    },
  });
  assert.equal(started.status, 201);
  const root = started.json.run;
  assert.equal(root.roundTitle, "Shortlist");
  assert.equal(root.roundPlan[1].title, "Finalists");

  const skipped = await request(`/api/runs/${root.id}/skip`, {
    method: "POST", body: { cardId: "curiosity", expectedRevision: 0 },
  });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.json.run.revision, 1);
  assert.deepEqual(skipped.json.run.queue, ["health", "family", "craft", "curiosity"]);
  assert.equal((await request(`/api/runs/${root.id}`)).json.run.queue.at(-1), "curiosity");

  const renamedPlan = await request(`/api/runs/${root.id}/plan`, {
    method: "PATCH",
    body: {
      expectedPlanRevision: root.planRevision,
      rounds: [{ title: "Shortlist renamed", keepLimit: 1 }, { title: "Finalists", keepLimit: 1 }],
    },
  });
  assert.equal(renamedPlan.status, 200);
  assert.equal(renamedPlan.json.run.keepLimit, 3, "editing a plan cannot change the started run cap");
  assert.equal(renamedPlan.json.run.roundPlan[0].keepLimit, 3);

  for (const [index, card] of root.cards.entries()) {
    const decision = await request(`/api/runs/${root.id}/decisions`, {
      method: "POST",
      body: { cardId: card.id, choice: index < 3 ? "keep" : "discard", expectedRevision: index + 1 },
    });
    assert.equal(decision.status, 200);
  }
  const childResponse = await request("/api/runs", { method: "POST", body: { parentRunId: root.id } });
  assert.equal(childResponse.status, 201);
  const child = childResponse.json.run;
  assert.equal(child.keepLimit, 1, "child uses the next round's preset");
  assert.equal(child.sortId, root.sortId);
  assert.equal(child.planRevision, renamedPlan.json.run.planRevision + 1, "starting a round advances the sort-plan CAS version");
  assert.equal(child.roundTitle, "Finalists");
  assert.equal((await request(`/api/runs/${root.id}`)).json.run.hasLaterResults, true);
  const blockedUndo = await request(`/api/runs/${root.id}/undo`, {
    method: "POST", body: { expectedRevision: 5 },
  });
  assert.equal(blockedUndo.status, 409);
  assert.equal(blockedUndo.json.error.code, "run_has_later_results");
  assert.equal((await request(`/api/runs/${root.id}`)).json.run.revision, 5);

  const forkResponse = await request(`/api/runs/${root.id}/revise`, {
    method: "POST", body: { cardId: "curiosity", choice: "discard", expectedRevision: 5 },
  });
  assert.equal(forkResponse.status, 200);
  const fork = forkResponse.json.run;
  assert.notEqual(fork.sortId, root.sortId);
  assert.equal(fork.revisesRunId, root.id);
  assert.equal(fork.decisions.find((decision) => decision.cardId === "curiosity" && !decision.undoneAt).choice, "discard");
  assert.equal((await request(`/api/runs/${root.id}`)).json.run.decisions.find((decision) => decision.cardId === "curiosity" && !decision.undoneAt).choice, "keep");
  assert.equal((await request(`/api/runs/${child.id}`)).json.run.status, "in-progress", "the old later round remains readable");
});

test("a revised answer without later rounds records a reversible replacement in place", async () => {
  const { request } = await fixture();
  const created = await collection(request);
  const run = (await request("/api/runs", { method: "POST", body: { collectionId: created.id, keepLimit: 2 } })).json.run;
  const decision = await request(`/api/runs/${run.id}/decisions`, {
    method: "POST", body: { cardId: "curiosity", choice: "keep", expectedRevision: 0 },
  });
  const revised = await request(`/api/runs/${run.id}/revise`, {
    method: "POST", body: { cardId: "curiosity", choice: "discard", expectedRevision: 1 },
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.json.run.id, run.id);
  assert.equal(revised.json.run.revision, 2);
  assert.ok(revised.json.run.decisions[0].undoneAt);
  assert.equal(revised.json.run.decisions[1].replacesDecisionId, decision.json.run.decisions[0].id);
  const undone = await request(`/api/runs/${run.id}/undo`, { method: "POST", body: { expectedRevision: 2 } });
  assert.equal(undone.json.run.status, "in-progress");
  assert.equal(undone.json.run.keptCount, 1);
  assert.equal(undone.json.run.decisions.find((entry) => !entry.undoneAt).choice, "keep");
  assert.ok(undone.json.run.decisions[1].undoneAt);
});

test("card lists default for old cards, survive SQLite reload and edits, and keep old run snapshots", async () => {
  const { request } = await fixture();
  const legacy = await collection(request, [
    { id: "one", text: "One", detail: "Description" },
    { id: "two", text: "Two" },
  ]);
  assert.deepEqual(legacy.cards[0].pros, []);
  assert.deepEqual(legacy.cards[0].cons, []);

  const start = await request("/api/runs", { method: "POST", body: { collectionId: legacy.id, keepLimit: 1 } });
  const run = start.json.run;
  const keep = await request(`/api/runs/${run.id}/decisions`, { method: "POST", body: { cardId: "one", choice: "keep", expectedRevision: 0 } });
  await request(`/api/runs/${run.id}/decisions`, { method: "POST", body: { cardId: "two", choice: "discard", expectedRevision: 1 } });
  assert.deepEqual(keep.json.run.cards[0].pros, []);

  const edited = await request(`/api/collections/${legacy.id}`, {
    method: "PUT",
    body: {
      name: "Renamed", description: legacy.description, keepLabel: legacy.keepLabel,
      discardLabel: legacy.discardLabel,
      cards: [
        { ...legacy.cards[0], pros: ["Trimmed pro"], cons: ["Trimmed con"] },
        legacy.cards[1],
      ],
      expectedUpdatedAt: legacy.updatedAt,
    },
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.json.collection.cards[0].pros, ["Trimmed pro"]);
  assert.equal(edited.json.collection.cards[0].id, "one");
  const reload = await request(`/api/collections/${legacy.id}`);
  assert.deepEqual(reload.json.collection.cards[0].cons, ["Trimmed con"]);
  const history = await request(`/api/runs/${run.id}`);
  assert.deepEqual(history.json.run.cards[0].pros, []);
  assert.deepEqual(history.json.run.cards[0].cons, []);
});

test("validates optional card pros and cons types, lengths, item counts, and empty rows", async () => {
  const { request } = await fixture();
  const valid = await collection(request, [
    { id: "one", text: "One", pros: ["  Bright  ", "", "  ", "Reason"], cons: ["Tradeoff"] },
    { id: "two", text: "Two", pros: Array(10).fill("A"), cons: [] },
  ]);
  assert.deepEqual(valid.cards[0].pros, ["Bright", "Reason"]);
  for (const invalid of [
    { pros: "one" },
    { pros: [1] },
    { pros: ["x".repeat(201)] },
    { cons: Array(11).fill("x") },
  ]) {
    const result = await request("/api/collections", { method: "POST", body: {
      name: "Invalid", cards: [{ id: "a", text: "A", ...invalid }, { id: "b", text: "B" }],
    } });
    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, "invalid_input");
  }
});

test("rejects a collection edit from a stale version across devices", async () => {
  const { request } = await fixture();
  const created = await collection(request);
  const olderCopy = await request(`/api/collections/${created.id}`);

  const saved = await request(`/api/collections/${created.id}`, {
    method: "PUT",
    body: {
      name: "New name",
      description: created.description,
      keepLabel: created.keepLabel,
      discardLabel: created.discardLabel,
      cards: created.cards,
      expectedUpdatedAt: created.updatedAt,
    },
  });
  assert.equal(saved.status, 200);
  assert.notEqual(saved.json.collection.updatedAt, created.updatedAt);

  const staleSave = await request(`/api/collections/${created.id}`, {
    method: "PUT",
    body: {
      name: "Overwritten from stale tab",
      description: olderCopy.json.collection.description,
      keepLabel: olderCopy.json.collection.keepLabel,
      discardLabel: olderCopy.json.collection.discardLabel,
      cards: olderCopy.json.collection.cards,
      expectedUpdatedAt: olderCopy.json.collection.updatedAt,
    },
  });
  assert.equal(staleSave.status, 409);
  assert.equal(staleSave.json.error.code, "revision_conflict");
  const latest = await request(`/api/collections/${created.id}`);
  assert.equal(latest.json.collection.name, "New name");
});

test("run history and decisions persist when the database is reopened", async () => {
  const env = await fixture();
  const created = await collection(env.request);
  const run = (await env.request("/api/runs", {
    method: "POST", body: { collectionId: created.id, keepLimit: 2 },
  })).json.run;
  await env.request(`/api/runs/${run.id}/decisions`, {
    method: "POST", body: { cardId: "curiosity", choice: "keep", expectedRevision: 0 },
  });

  await new Promise((resolve) => env.server.close(resolve));
  servers.splice(servers.indexOf(env.server), 1);
  const reopened = createAppServer({ dbPath: path.join(env.root, "db", "sift.sqlite"), staticDir: env.staticDir });
  reopened.listen(0, "127.0.0.1");
  await once(reopened, "listening");
  servers.push(reopened);
  const response = await fetch(`http://127.0.0.1:${reopened.address().port}/api/runs/${run.id}`);
  assert.equal(response.status, 200);
  const { run: saved } = await response.json();
  assert.equal(saved.revision, 1);
  assert.equal(saved.keptCount, 1);
  assert.equal(saved.decisions[0].cardId, "curiosity");
});

test("SQLite startup recovers an interrupted answer migration and preserves the legacy audit chain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sift-legacy-test-"));
  roots.push(root);
  const staticDir = path.join(root, "static");
  await mkdir(staticDir, { recursive: true });
  await writeFile(path.join(staticDir, "index.html"), "<!doctype html><title>Sift</title>");
  const dbPath = path.join(root, "db", "sift.sqlite");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const legacy = new DatabaseSync(dbPath);
  legacy.exec("PRAGMA foreign_keys = ON;");
  legacy.exec(`CREATE TABLE collections (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    keep_label TEXT NOT NULL DEFAULT 'Keep', discard_label TEXT NOT NULL DEFAULT 'Let go',
    cards_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id),
    parent_run_id TEXT REFERENCES runs(id), round_number INTEGER NOT NULL,
    keep_limit INTEGER NOT NULL CHECK (keep_limit > 0), revision INTEGER NOT NULL DEFAULT 0,
    keep_label TEXT NOT NULL, discard_label TEXT NOT NULL, cards_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE decisions (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), card_id TEXT NOT NULL,
    choice TEXT NOT NULL CHECK (choice IN ('keep', 'discard')), position INTEGER NOT NULL,
    created_at TEXT NOT NULL, undone_at TEXT, replaces_decision_id TEXT REFERENCES decisions(id)
  );`);
  const now = new Date().toISOString();
  const collectionId = "legacy-collection";
  const rootRunId = "legacy-root";
  const childRunId = "legacy-child";
  const cardsJson = JSON.stringify([{ id: "old-one", text: "Old one" }, { id: "old-two", text: "Old two" }]);
  legacy.prepare(`INSERT INTO collections (id, name, cards_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
    collectionId, "Legacy", cardsJson, now, now,
  );
  legacy.prepare(`INSERT INTO runs
    (id, collection_id, parent_run_id, round_number, keep_limit, revision, keep_label, discard_label, cards_json, created_at, updated_at)
    VALUES (?, ?, NULL, 1, 2, 0, 'Keep', 'Let go', ?, ?, ?),
           (?, ?, ?, 2, 1, 0, 'Keep', 'Let go', ?, ?, ?)`)
    .run(rootRunId, collectionId, cardsJson, now, now, childRunId, collectionId, rootRunId, cardsJson, now, now);
  legacy.prepare(`INSERT INTO decisions (id, run_id, card_id, choice, position, created_at, undone_at, replaces_decision_id)
    VALUES ('legacy-answer-old', ?, 'old-one', 'keep', 1, ?, ?, NULL),
           ('legacy-answer-new', ?, 'old-one', 'discard', 2, ?, NULL, 'legacy-answer-old')`)
    .run(rootRunId, now, now, rootRunId, now);
  const legacyDecisionFingerprint = legacy.prepare("SELECT id, run_id, card_id, choice, position, created_at, undone_at, replaces_decision_id FROM decisions ORDER BY position").all();
  legacy.exec(`CREATE TABLE sort_answers (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), card_id TEXT NOT NULL,
    choice TEXT NOT NULL CHECK (choice IN ('keep', 'discard', 'rating')), rating_value REAL,
    position INTEGER NOT NULL, created_at TEXT NOT NULL, undone_at TEXT,
    replaces_decision_id TEXT REFERENCES sort_answers(id),
    CHECK ((choice = 'rating' AND rating_value IS NOT NULL) OR (choice != 'rating' AND rating_value IS NULL))
  );`);
  legacy.close();
  const server = createAppServer({ dbPath, staticDir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/runs?collectionId=${collectionId}`);
  assert.equal(response.status, 200);
  const { runs } = await response.json();
  assert.equal(runs.length, 2);
  assert.ok(runs.every((run) => run.sortId === rootRunId));
  assert.deepEqual(runs.find((run) => run.id === childRunId).roundPlan, [
    { title: "Round 1", keepLimit: 2 },
    { title: "Round 2", keepLimit: 1 },
  ]);
  const migrated = new DatabaseSync(dbPath);
  migrated.exec("PRAGMA foreign_keys = ON;");
  assert.deepEqual(migrated.prepare("SELECT id, run_id, card_id, choice, position, created_at, undone_at, replaces_decision_id FROM decisions ORDER BY position").all(), legacyDecisionFingerprint);
  const copied = migrated.prepare("SELECT id, run_id, card_id, choice, position, created_at, undone_at, replaces_decision_id FROM sort_answers ORDER BY position").all();
  assert.equal(copied.length, 2);
  assert.equal(copied[1].replaces_decision_id, "legacy-answer-old");
  assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
  migrated.close();
});

test("rejects invalid input, cross-origin writes, and unauthorised keep labels before persistence", async () => {
  const { request } = await fixture();
  const crossOrigin = await request("/api/collections", {
    method: "POST", originHeader: "https://attacker.example", body: {
      name: "Example", cards,
    },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.json.error.code, "cross_origin_request");

  const invalidCollection = await request("/api/collections", {
    method: "POST", body: { name: "Blank deck", cards: [{ id: "only", text: "Only one" }] },
  });
  assert.equal(invalidCollection.status, 400);
  assert.equal(invalidCollection.json.error.code, "invalid_input");

  const created = await collection(request);
  const run = (await request("/api/runs", {
    method: "POST", body: { collectionId: created.id, keepLimit: 2 },
  })).json.run;
  const badDecision = await request(`/api/runs/${run.id}/decisions`, {
    method: "POST", body: { cardId: "curiosity", choice: "maybe", expectedRevision: 0 },
  });
  assert.equal(badDecision.status, 400);
  assert.equal(badDecision.json.error.code, "invalid_choice");
  assert.equal((await request(`/api/runs/${run.id}`)).json.run.revision, 0);
});

test("accepts the maximum supported collection and rejects request bodies above the size limit", async () => {
  const { request } = await fixture();
  const largeCollection = await request("/api/collections", {
    method: "POST",
    body: {
      name: "Maximum collection",
      description: "d".repeat(300),
      cards: Array.from({ length: 500 }, (_, index) => ({
        id: `card-${index}-${"x".repeat(70)}`,
        text: "t".repeat(120),
        detail: "d".repeat(500),
      })),
    },
  });
  assert.equal(largeCollection.status, 201);
  assert.equal(largeCollection.json.collection.cards.length, 500);

  const oversized = await request("/api/collections", {
    method: "POST",
    body: { name: "x".repeat(2 * 1024 * 1024) },
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.json.error.code, "body_too_large");
});

test("rejects DNS-rebinding hostnames before serving either API or the app shell", async () => {
  const { origin } = await fixture();
  const requestWithHost = (pathname) => new Promise((resolve, reject) => {
    const req = httpRequest(new URL(pathname, origin), { headers: { host: "attacker.example" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    });
    req.once("error", reject);
    req.end();
  });
  const health = await requestWithHost("/api/health");
  assert.equal(health.status, 421);
  assert.equal(health.json.error.code, "host_not_allowed");
  const shell = await requestWithHost("/");
  assert.equal(shell.status, 421);
  assert.equal(shell.json.error.code, "host_not_allowed");
});

test("serves app routes and assets, never converts missing API routes to HTML", async () => {
  const { request } = await fixture();
  const appRoute = await request("/history", { originHeader: null });
  assert.equal(appRoute.status, 200);
  assert.match(appRoute.json, /Sift fixture/);

  const asset = await request("/app.js", { originHeader: null });
  assert.equal(asset.status, 200);
  assert.equal(asset.json, "console.log('fixture')");

  const missingApi = await request("/api/no-such-route", { originHeader: null });
  assert.equal(missingApi.status, 404);
  assert.equal(missingApi.json.error.code, "not_found");

  const missingAsset = await request("/missing.js", { originHeader: null });
  assert.equal(missingAsset.status, 404);
});
