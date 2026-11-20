import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { remapTransferBundleIDs, transferToWebWorkspace, validateTransfer, webWorkspaceToTransfer } from "../shared/transfer.js";
const collection = { id: "web-collection-α", name: "Café choices", description: "Unicode ☕", keepLabel: "Choose 🌱", discardLabel: "Later", cards: [
  { id: "one", text: "A very long 🌳 choice", description: "細部", pros: ["Good"], cons: [] },
  { id: "two", text: "Second", description: "", pros: [], cons: ["No"] },
  { id: "three", text: "Third", description: "", pros: [], cons: [] }
] };
const workspace = { collections: [collection], runs: [{ id: "run-1", collectionId: collection.id, roundNumber: 1, roundTitle: "Warm up", roundPlan: [{ id: "round-a", title: "Warm up", keepLimit: 2 }, { id: "round-b", title: "Finalists", keepLimit: 1 }], keepLimit: 2, createdAt: "2026-10-02T03:04:05.678Z", updatedAt: "2026-10-02T03:05:06.789Z", cards: collection.cards, queue: ["three"], decisions: [
  { id: "d1", cardId: "one", choice: "keep", position: 1, createdAt: "2026-10-02T03:04:10.000Z", undoneAt: null, replacesDecisionId: null },
  { id: "d2", cardId: "two", choice: "discard", position: 2, createdAt: "2026-10-02T03:04:20.000Z", undoneAt: "2026-10-02T03:04:30.000Z", replacesDecisionId: null },
  { id: "d3", cardId: "two", choice: "keep", position: 3, createdAt: "2026-10-02T03:04:40.000Z", undoneAt: null, replacesDecisionId: "d2" }
] }] };
test("web workspace makes a deterministic, validated archive and projects without dropping canonical records", () => {
  const archive = webWorkspaceToTransfer(workspace, { exportedAt: "2026-11-06T12:00:00.123Z" });
  assert.deepEqual(webWorkspaceToTransfer(workspace, { exportedAt: "2026-11-06T12:00:00.123Z" }), archive);
  const projected = transferToWebWorkspace(archive);
  assert.equal(projected.records.length, archive.collections[0].records.length);
  assert.equal(projected.collections[0].name, collection.name);
  assert.equal(projected.runs[0].cards[0].text, collection.cards[0].text);
  const sessionRecord = archive.collections[0].records.find((record) => record.kind === "sortSession");
  const session = JSON.parse(Buffer.from(sessionRecord.payload, "base64").toString("utf8"));
  assert.equal(typeof session.createdAt, "number", "Core Date payloads use millisecond numbers");
  assert.equal(validateTransfer(archive).collections[0].records.length, archive.collections[0].records.length);
});
test("bundle remap is deterministic and validates as an alternate collection copy", () => {
  const archive = webWorkspaceToTransfer(workspace, { exportedAt: "2026-11-06T12:00:00.123Z" });
  const source = archive.collections[0].id;
  const one = remapTransferBundleIDs(archive, source, [source]);
  const two = remapTransferBundleIDs(archive, source, [source]);
  assert.deepEqual(one, two);
  assert.notEqual(one.collections[0].id, source);
  assert.equal(one.collections[0].records.length, archive.collections[0].records.length);
  assert.equal(validateTransfer(one).collections[0].id, one.collections[0].id);
});
test("validator rejects malformed payload and oversized bundle count", () => {
  const archive = webWorkspaceToTransfer(workspace, { exportedAt: "2026-11-06T12:00:00.123Z" });
  const malformed = structuredClone(archive);
  malformed.collections[0].records[0].payload = "eyJpZCI6MX0=";
  assert.throws(() => validateTransfer(malformed), /UUID|identity|inconsistent|bundle/i);
  const tooMany = { ...archive, collections: Array.from({ length: 101 }, (_, index) => ({ id: `invalid-${index}`, records: [] })) };
  assert.throws(() => validateTransfer(tooMany), /100/);
});
test("shared full-history fixture preserves both paths, rounds, Unicode snapshots, undo, and queue state", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/transfer/full-history.json", import.meta.url), "utf8"));
  const archive = validateTransfer(fixture);
  const workspaceProjection = transferToWebWorkspace(archive);
  assert.equal(workspaceProjection.records.length, archive.collections[0].records.length);
  assert.equal(workspaceProjection.runs.length, 3, "source and revised paths project each recorded round");
  assert.equal(workspaceProjection.runs.filter((run) => run.roundNumber === 2).length, 1);
  assert.ok(workspaceProjection.runs.some((run) => run.roundTitle === "Second"));
  assert.ok(workspaceProjection.runs.some((run) => run.cards.some((card) => card.text === "🌱".repeat(120))));
  assert.ok(workspaceProjection.runs.some((run) => run.cards.some((card) => card.text.includes("UUID literal FCB9900B-5DB5-4687-9EEE-0D7CA3C7E1C3"))));
  const remapped = remapTransferBundleIDs(archive, archive.collections[0].id, [archive.collections[0].id]);
  assert.notEqual(remapped.collections[0].id, archive.collections[0].id);
  assert.equal(remapped.collections[0].id, "97F33C2D-9700-80EF-B2F0-F16261AE0B5D");
  assert.equal(remapped.collections[0].records.length, archive.collections[0].records.length);
  const remappedCard = remapped.collections[0].records.find((record) => record.kind === "cardRevision");
  const remappedCardPayload = Buffer.from(remappedCard.payload, "base64").toString("utf8");
  assert.ok(remappedCardPayload.includes("🌱") || remappedCardPayload.includes("https://example.test/option/"));
});
const at = (seconds) => new Date(Date.UTC(2026, 10, 6, 12, 0, seconds)).toISOString();
const payload = (record) => JSON.parse(Buffer.from(record.payload, "base64").toString("utf8"));
const rewritePayload = (record, update) => {
  const p = payload(record);
  update(p);
  record.payload = Buffer.from(JSON.stringify(p)).toString("base64");
};
test("numeric fields and values remap by UUID key while rating round snapshots and canonical records survive", () => {
  const fieldID = "9F13E773-A8CB-49E5-AAD4-2A4D57F82B21";
  const fieldName = "123e4567-e89b-12d3-a456-426614174000";
  const scale = { name: "Weight", minimum: -1, maximum: 1, step: 0.25, unit: " kg " };
  const source = {
    collections: [{ ...collection, numericFields: [{ id: fieldID, name: fieldName, minimum: -2, maximum: 2, step: 0.000001, unit: "kg" }], cards: [
      { id: "one", text: "A", numericValues: { [fieldID.toLowerCase()]: 0.1 } },
      { id: "two", text: "B", numericValues: { [fieldID]: 0.3 } },
      { id: "three", text: "C", numericValues: { [fieldID]: 0.000001 } },
    ] }],
    runs: [{ id: "rating", collectionId: collection.id, roundNumber: 1, roundTitle: "Weight", roundPlan: [{ title: "Weight", ratingScale: scale }], ratingScale: scale, numericFields: [{ id: fieldID, name: fieldName, minimum: -2, maximum: 2, step: 0.000001, unit: "kg" }], keepLimit: 3, cards: [
      { id: "one", text: "A", numericValues: { [fieldID]: 0.1 } }, { id: "two", text: "B", numericValues: { [fieldID]: 0.3 } }, { id: "three", text: "C", numericValues: { [fieldID]: 0.000001 } },
    ], queue: ["one", "two", "three"], decisions: [], createdAt: at(0), updatedAt: at(0) }],
  };
  const archive = webWorkspaceToTransfer(source, { exportedAt: at(1) });
  assert.equal(archive.version, 2);
  const projection = transferToWebWorkspace(archive);
  assert.deepEqual(projection.collections[0].numericFields[0].id, fieldID);
  assert.deepEqual(projection.collections[0].cards[0].numericValues[fieldID], 0.1);
  assert.deepEqual(webWorkspaceToTransfer({ ...projection, preservedRecords: projection.records }, { exportedAt: archive.exportedAt }), archive);
  const remapped = remapTransferBundleIDs(archive, archive.collections[0].id);
  const remappedProjection = transferToWebWorkspace(remapped);
  const newFieldID = remappedProjection.collections[0].numericFields[0].id;
  assert.notEqual(newFieldID, fieldID);
  assert.equal(remappedProjection.collections[0].numericFields[0].name, fieldName, "UUID-looking user text remains literal");
  assert.equal(remappedProjection.collections[0].cards[0].numericValues[newFieldID], 0.1);
  assert.deepEqual(remappedProjection.runs[0].ratingScale, scale);

  const collectionRevision = archive.collections[0].records.find((record) => record.kind === "collectionRevision");
  const orphanCardID = "4E93C579-5A47-495C-8FB6-680136F01D35";
  const orphanRevisionID = "3B023FA8-4601-47C0-8A15-A0807A892384";
  const orphanPayload = { revisionID: orphanRevisionID, cardID: orphanCardID, collectionRevisionID: collectionRevision.id,
    title: "Unreferenced valid card", detail: "Preserve this snapshot", pros: [], cons: [], numericValues: { [fieldID]: 1.000001 } };
  const orphanRecord = { id: orphanRevisionID, kind: "cardRevision", version: 2, ownerID: collectionRevision.id, logicalID: orphanCardID,
    payload: Buffer.from(JSON.stringify(orphanPayload)).toString("base64") };
  const withOrphan = structuredClone(archive);
  withOrphan.collections[0].records.push(orphanRecord);
  const validOrphanArchive = validateTransfer(withOrphan);
  const orphanProjection = transferToWebWorkspace(validOrphanArchive);
  assert.deepEqual(orphanProjection.records.find((record) => record.id === orphanRevisionID), orphanRecord);
  const orphanReexport = webWorkspaceToTransfer({ ...orphanProjection, preservedRecords: orphanProjection.records }, { exportedAt: archive.exportedAt });
  assert.deepEqual(orphanReexport.collections[0].records.find((record) => record.id === orphanRevisionID), orphanRecord);

  const invalidOrphan = structuredClone(withOrphan);
  rewritePayload(invalidOrphan.collections[0].records.find((record) => record.id === orphanRevisionID), (p) => { p.numericValues[fieldID] = 1e9; });
  assert.throws(() => validateTransfer(invalidOrphan), /Enter a value/);
});
function chainWorkspace() {
  const cards = [...collection.cards, { id: "four", text: "Fourth", description: "", pros: [], cons: [] }];
  const c = { ...collection, cards };
  const plan = [{ title: "First", keepLimit: 3 }, { title: "Final", keepLimit: 1 }];
  const decisions = cards.map((card, i) => ({ id: `d${i}`, cardId: card.id, choice: i < 3 ? "keep" : "discard", position: i + 1, createdAt: at(i + 1), undoneAt: null, replacesDecisionId: null }));
  const first = { id: "first", sortId: "original", collectionId: c.id, roundNumber: 1, roundPlan: plan, keepLimit: 3, cards, queue: [], decisions, createdAt: at(0), updatedAt: at(5) };
  const second = { id: "second", sortId: "original", collectionId: c.id, parentRunId: "first", roundNumber: 2, roundPlan: plan, keepLimit: 1, cards: cards.slice(0, 3), queue: ["three", "two"], decisions: [{ id: "final-d", cardId: "one", choice: "keep", position: 1, createdAt: at(7), undoneAt: null }], createdAt: at(6), updatedAt: at(8) };
  const fork = { ...first, id: "fork", sortId: "revised", revisesRunId: "first", createdAt: at(9), updatedAt: at(10), decisions: [...decisions.map((d) => ({ ...d, id: `cloned-${d.id}`, undoneAt: d.id === "d0" ? at(9) : null })), { id: "revision", cardId: "one", choice: "discard", position: 5, createdAt: at(9), undoneAt: null, replacesDecisionId: "cloned-d0" }] };
  return { collections: [c], runs: [second, fork, first] };
}
test("web round chains and revised paths share one native session and retain final queue", () => {
  const source = chainWorkspace(), archive = webWorkspaceToTransfer(source, { exportedAt: at(20) });
  assert.equal(archive.collections[0].records.filter((r) => r.kind === "sortSession").length, 1);
  const ops = archive.collections[0].records.filter((r) => r.kind === "sortAction").map(payload);
  assert.ok(ops.some((a) => a.operation.roundStarted));
  assert.ok(ops.some((a) => a.operation.revisedPath));
  const projected = transferToWebWorkspace(archive);
  assert.equal(projected.runs.length, 3);
  const second = projected.runs.find((r) => r.roundNumber === 2);
  assert.deepEqual(second.queue, source.runs[0].queue.map((id) => projected.collections[0].cards[source.collections[0].cards.findIndex((c) => c.id === id)].id));
  assert.ok(projected.runs.some((r) => r.revisesRunId));
  assert.equal(new Set(projected.runs.flatMap((r) => r.decisions.map((d) => d.id))).size, projected.runs.reduce((sum, r) => sum + r.decisions.length, 0));
});
test("unchanged native projection exports the exact canonical record bytes without false versions", () => {
  const archive = JSON.parse(readFileSync(new URL("./fixtures/transfer/full-history.json", import.meta.url), "utf8"));
  const projected = transferToWebWorkspace(archive);
  projected.runs = projected.runs.map((r) => ({ ...r, roundPlan: r.roundPlan.map(({ title, keepLimit }) => ({ title, keepLimit })), revision: 12 }));
  const again = webWorkspaceToTransfer({ ...projected, preservedRecords: projected.records }, { exportedAt: archive.exportedAt });
  assert.deepEqual(again, validateTransfer(archive));
});
test("historical snapshots cannot become the editable current collection", () => {
  const c = structuredClone(collection), old = { ...c, cards: c.cards.slice(0, 2) };
  const archive = webWorkspaceToTransfer({ collections: [c], runs: [{ ...workspace.runs[0], id: "current-run", cards: c.cards }, { id: "old-run", collectionId: c.id, roundNumber: 1, keepLimit: 1, cards: old.cards, queue: old.cards.map((x) => x.id), decisions: [], createdAt: at(0) }] }, { exportedAt: at(20) });
  assert.equal(transferToWebWorkspace(archive).collections[0].cards.length, 3);
  assert.equal(transferToWebWorkspace(archive).runs.find((r) => r.cards.length === 2).cards.length, 2);
});
test("edits to imported active decisions, plans, queues and collections append while retaining canonical history", () => {
  const archive = webWorkspaceToTransfer({ collections: [collection], runs: [{ id: "pending", collectionId: collection.id, sortId: "pending-sort", roundNumber: 1, roundPlan: [{ title: "First", keepLimit: 2 }], keepLimit: 2, cards: collection.cards, queue: collection.cards.map((c) => c.id), decisions: [], createdAt: at(0), updatedAt: at(0) }] }, { exportedAt: at(10) });
  const p = transferToWebWorkspace(archive), r = p.runs[0];
  r.decisions = [{ id: "new-web-decision", cardId: r.cards[0].id, choice: "keep", position: 1, createdAt: at(11), undoneAt: null }];
  r.queue = [r.cards[2].id, r.cards[1].id];
  r.roundPlan[0].title = "Renamed";
  r.roundPlan.push({ title: "Future", keepLimit: 1 });
  p.collections[0].name = "Edited collection";
  const updated = webWorkspaceToTransfer({ ...p, preservedRecords: p.records }, { exportedAt: at(20) });
  for (const record of archive.collections[0].records) assert.deepEqual(updated.collections[0].records.find((r2) => r2.id === record.id), record);
  assert.ok(updated.collections[0].records.length > archive.collections[0].records.length);
  const projected = transferToWebWorkspace(updated);
  assert.equal(projected.collections[0].name, "Edited collection");
  assert.ok(projected.runs.some((r2) => r2.roundTitle === "Renamed" && r2.decisions.some((d) => d.choice === "keep") && r2.queue.join() === p.runs[0].queue.join()));
});
test("undo of a replacement restores the original decision without a false earlier undo", () => {
  const source = structuredClone(workspace);
  source.runs[0].decisions[2].undoneAt = at(10);
  source.runs[0].decisions[1].undoneAt = null;
  source.runs[0].queue = ["three"];
  const archive = webWorkspaceToTransfer(source, { exportedAt: at(20) }), r = transferToWebWorkspace(archive).runs[0];
  assert.equal(r.decisions.filter((d) => !d.undoneAt && d.cardId === r.cards[1].id)[0].choice, "discard");
  assert.equal(archive.collections[0].records.filter((r2) => r2.kind === "sortAction" && payload(r2).operation.undone).length, 1);
});
test("validator fails closed on replay errors, orphan dependencies, versions and collection cycles", () => {
  const source = webWorkspaceToTransfer(chainWorkspace(), { exportedAt: at(20) });
  const check = (select, edit, pattern = /invalid|inconsistent|cycle|missing|limit|version|graph/i) => {
    const a = structuredClone(source), r = a.collections[0].records.find(select);
    rewritePayload(r, edit);
    assert.throws(() => validateTransfer(a), pattern);
  };
  const action = (kind) => (r) => r.kind === "sortAction" && payload(r).operation[kind];
  check(action("roundStarted"), (p) => p.operation.roundStarted.cardIDs.reverse());
  check(action("roundStarted"), (p) => p.operation.roundStarted.keepLimit = 4);
  check(action("decided"), (p) => p.operation.decided._0.roundNumber = 2);
  check(action("decided"), (p) => p.rulesVersion = 999);
  check(action("revisedPath"), (p) => p.branchID = p.sessionID);
  check(action("revisedPath"), (p) => p.operation.revisedPath.sourceHeadID = p.id);
  check((r) => r.kind === "collectionRevision", (p) => p.parentRevisionID = p.id);
  check((r) => r.kind === "sortSession", (p) => p.titleSnapshot = "Wrong snapshot");
  const orphan = structuredClone(source);
  orphan.collections[0].records = orphan.collections[0].records.filter((r) => r.kind !== "sortAction");
  assert.throws(() => validateTransfer(orphan), /path|complete/i);
});

test("version 1 readers reject nested numeric and rating features instead of dropping them", () => {
  const legacy = webWorkspaceToTransfer(workspace, { exportedAt: at(20) });
  assert.equal(legacy.version, 1);
  const actionFor = (archive) => archive.collections[0].records.find((record) => record.kind === "sortAction");
  const downgrade = (archive) => {
    archive.version = 1;
    for (const record of archive.collections[0].records) record.version = 1;
  };
  const ratedDecision = structuredClone(legacy);
  downgrade(ratedDecision);
  const decision = actionFor(ratedDecision);
  rewritePayload(decision, (p) => {
    p.schemaVersion = 1;
    p.rulesVersion = 1;
    p.operation = { decided: { _0: { id: "BDFE26CE-DB4A-4BAC-8EAB-C3A69D973870", cardID: "38AF7B7C-02D0-436B-B223-28A8691DD391", choice: "rating", value: 0.25, roundNumber: 1 } } };
  });
  assert.throws(() => validateTransfer(ratedDecision), /version 2/i);

  const editedPlan = structuredClone(legacy);
  downgrade(editedPlan);
  const planAction = actionFor(editedPlan);
  rewritePayload(planAction, (p) => {
    p.schemaVersion = 1;
    p.rulesVersion = 1;
    p.operation = { planEdited: { _0: [{ id: "BDFE26CE-DB4A-4BAC-8EAB-C3A69D973870", title: "Rating", keepLimit: null, ratingScale: { name: "Score", minimum: 0, maximum: 5, step: 0.5, unit: "stars" } }] } };
  });
  assert.throws(() => validateTransfer(editedPlan), /version 2/i);

  const envelopeMismatch = structuredClone(legacy);
  envelopeMismatch.collections[0].records[0].version = 2;
  assert.throws(() => validateTransfer(envelopeMismatch), /version/i);
});

test("appending a future rating round upgrades only new actions and preserves v1 history", () => {
  const legacy = webWorkspaceToTransfer(workspace, { exportedAt: at(20) });
  assert.equal(legacy.version, 1);
  const originalRecords = structuredClone(legacy.collections[0].records);
  const projection = transferToWebWorkspace(legacy);
  const run = projection.runs.find((row) => row.roundNumber === 1);
  const ratingScale = { name: "Future score", minimum: 0, maximum: 5, step: 0.5, unit: "stars" };
  run.roundPlan = [...run.roundPlan, { title: "Future rating", keepLimit: null, ratingScale }];
  run.updatedAt = at(30);
  const appended = webWorkspaceToTransfer({ collections: projection.collections, runs: [run], preservedRecords: projection.records }, { exportedAt: at(40) });
  assert.equal(appended.version, 2);
  for (const original of originalRecords) assert.deepEqual(appended.collections[0].records.find((record) => record.id === original.id), original);
  const planAction = appended.collections[0].records.find((record) => record.kind === "sortAction" && payload(record).operation.planEdited);
  assert.equal(planAction.version, 2);
  assert.equal(payload(planAction).schemaVersion, 2);
  assert.equal(payload(planAction).rulesVersion, 2);
  assert.deepEqual(payload(planAction).operation.planEdited._0.at(-1).ratingScale, ratingScale);
  const roundtrip = transferToWebWorkspace(appended);
  assert.deepEqual(roundtrip.runs[0].roundPlan.at(-1).ratingScale, ratingScale);
  assert.deepEqual(webWorkspaceToTransfer({ ...roundtrip, preservedRecords: roundtrip.records }, { exportedAt: appended.exportedAt }), appended);
});

test("native concurrent decision and plan siblings project as independent editable paths", () => {
  const archive = JSON.parse(readFileSync(new URL("./fixtures/transfer/native-concurrent.json", import.meta.url), "utf8"));
  const p = transferToWebWorkspace(archive);
  assert.equal(p.runs.length, 7);
  assert.ok(p.runs.some((r) => r.roundPlan[1]?.keepLimit === 1));
  assert.ok(p.runs.some((r) => r.roundPlan[1]?.keepLimit === 2));
  assert.equal(new Set(p.runs.map((r) => r.sortId)).size, 6);
  assert.deepEqual(webWorkspaceToTransfer({ ...p, preservedRecords: p.records }, { exportedAt: archive.exportedAt }), validateTransfer(archive));
});

test("concurrent web next-round starts remain sibling paths in one session", () => {
  const w = chainWorkspace();
  w.runs = w.runs.filter((r) => !r.revisesRunId);
  const second = w.runs.find((r) => r.roundNumber === 2);
  w.runs.push({ ...structuredClone(second), id: "second-sibling", keepLimit: 2, decisions: [], queue: ["one", "two", "three"] });
  const archive = webWorkspaceToTransfer(w, { exportedAt: at(20) });
  assert.equal(archive.collections[0].records.filter((r) => r.kind === "sortSession").length, 1);
  const p = transferToWebWorkspace(archive);
  assert.equal(p.runs.filter((r) => r.roundNumber === 2).length, 2);
  assert.deepEqual(p.runs.filter((r) => r.roundNumber === 2).map((r) => r.keepLimit).sort(), [1, 2]);
});

test("captured real website export is a complete connected archive", () => {
  const archive = JSON.parse(readFileSync(new URL("./fixtures/transfer/web-generated.json", import.meta.url), "utf8"));
  validateTransfer(archive);
  assert.equal(archive.collections[0].records.filter((r) => r.kind === "sortSession").length, 2);
  const p = transferToWebWorkspace(archive);
  assert.ok(p.runs.some((r) => r.revisesRunId));
  assert.ok(p.runs.some((r) => r.roundNumber === 2));
  assert.deepEqual(webWorkspaceToTransfer({ ...p, preservedRecords: p.records }, { exportedAt: archive.exportedAt }), validateTransfer(archive));
});


test("typed lowercase UUID payload references validate without changing the canonical bytes", () => {
  const source = JSON.parse(readFileSync(new URL("./fixtures/transfer/full-history.json", import.meta.url), "utf8"));
  for (const record of source.collections[0].records) {
    const text = Buffer.from(record.payload, "base64").toString("utf8");
    // Also changes UUID-looking literal text: that text must remain exactly as supplied.
    record.payload = Buffer.from(text.replace(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g, (id) => id.toLowerCase())).toString("base64");
  }
  const archive = validateTransfer(source), projected = transferToWebWorkspace(archive);
  assert.deepEqual(archive.collections[0].records, source.collections[0].records);
  assert.deepEqual(webWorkspaceToTransfer({ ...projected, preservedRecords: projected.records }, { exportedAt: archive.exportedAt }), archive);
});


test("recorded later rounds may keep every incoming card without clamping", () => {
  const source = chainWorkspace();
  source.runs = source.runs.filter((r) => !r.revisesRunId);
  for (const r of source.runs) r.roundPlan[1].keepLimit = 3;
  const later = source.runs.find((r) => r.roundNumber === 2);
  later.keepLimit = 3;
  later.queue = [];
  later.decisions = later.cards.map((c, i) => ({ id: `equal-${i}`, cardId: c.id, choice: "keep", position: i + 1, createdAt: at(11 + i), undoneAt: null }));
  const archive = webWorkspaceToTransfer(source, { exportedAt: at(20) });
  const projected = transferToWebWorkspace(archive).runs.find((r) => r.roundNumber === 2);
  assert.equal(projected.keepLimit, projected.cards.length);
  assert.equal(projected.decisions.filter((d) => !d.undoneAt && d.choice === "keep").length, projected.cards.length);
  assert.equal(projected.status, "complete");
});

test("multiple native collection leaves become editable views with exact raw re-export", () => {
  const original = webWorkspaceToTransfer({ collections: [collection] }, { exportedAt: at(0) });
  const alternative = (name) => {
    const p = transferToWebWorkspace(original);
    p.collections[0].name = name;
    return webWorkspaceToTransfer({ ...p, preservedRecords: p.records }, { exportedAt: at(10) });
  };
  const a = alternative("Version A"), b = alternative("Version B");
  const records = new Map([...a.collections[0].records, ...b.collections[0].records].map((r) => [r.id, r]));
  const archive = validateTransfer({ ...a, collections: [{ id: a.collections[0].id, records: [...records.values()] }] });
  const projected = transferToWebWorkspace(archive);
  assert.equal(projected.collections.length, 2);
  assert.deepEqual(projected.collectionAlternatives.map((c) => c.name).sort(), ["Version A", "Version B"]);
  assert.deepEqual(webWorkspaceToTransfer({ ...projected, preservedRecords: projected.records }, { exportedAt: archive.exportedAt }), archive);
});

test("actual website equal-cap round-two export validates and round-trips without changing its limit", () => {
  const archive = JSON.parse(readFileSync(new URL("./fixtures/transfer/web-equal-cap.json", import.meta.url), "utf8"));
  const validated = validateTransfer(archive);
  const recorded = validated.collections[0].records.filter((r) => r.kind === "sortAction").map(payload).find((a) => a.operation.roundStarted && a.operation.roundStarted.keepLimit === a.operation.roundStarted.cardIDs.length);
  assert.ok(recorded);
  assert.equal(recorded.operation.roundStarted.keepLimit, 2);
  const projected = transferToWebWorkspace(validated);
  const second = projected.runs.find((r) => r.roundNumber === 2);
  assert.equal(second.keepLimit, second.cards.length);
  assert.equal(second.keepLimit, 2);
  assert.deepEqual(webWorkspaceToTransfer({ ...projected, preservedRecords: projected.records }, { exportedAt: validated.exportedAt }), validated);
});


function multipleLeafArchive() {
  const original = webWorkspaceToTransfer(workspace, { exportedAt: at(0) });
  const alternative = (name) => {
    const p = transferToWebWorkspace(original);
    p.collections[0].name = name;
    p.collections[0].cards[0].detail = `${name} details`;
    return webWorkspaceToTransfer({ ...p, preservedRecords: p.records }, { exportedAt: at(10) });
  };
  const a = alternative("Version A"), b = alternative("Version B");
  const records = new Map([...a.collections[0].records, ...b.collections[0].records].map((r) => [r.id, r]));
  return validateTransfer({ ...a, collections: [{ id: a.collections[0].id, records: [...records.values()] }] });
}

test("every collection leaf has a usable identity and single-view export includes the complete logical bundle", () => {
  const archive = multipleLeafArchive(), p = transferToWebWorkspace(archive);
  assert.equal(p.collections.length, 2);
  assert.equal(new Set(p.collections.map((c) => c.id)).size, 2);
  assert.equal(new Set(p.collections.map((c) => c.sourceRevisionID)).size, 2);
  for (const c of p.collections) {
    assert.equal(c.transferBundleID, archive.collections[0].id);
    assert.equal(c.cards[0].detail, `${c.name} details`);
  }
  const secondary = p.collections.find((c) => c.id !== c.transferBundleID);
  const exported = webWorkspaceToTransfer({ ...p, preservedRecords: p.records }, { exportedAt: archive.exportedAt, collectionId: secondary.id });
  assert.deepEqual(exported, archive);
  assert.equal(p.runs.length, transferToWebWorkspace(webWorkspaceToTransfer(workspace, { exportedAt: at(0) })).runs.length);
  assert.ok(p.runs.every((r) => r.collectionId === archive.collections[0].id), "shared ancestor history stays on the primary view");
});

test("editing a secondary leaf appends its own child and preserves both original versions and history", () => {
  const archive = multipleLeafArchive(), p = transferToWebWorkspace(archive);
  const secondary = p.collections.find((c) => c.id !== c.transferBundleID), sourceID = secondary.sourceRevisionID;
  secondary.name = "Edited secondary";
  secondary.cards[0].detail = "Updated secondary card details";
  const updated = webWorkspaceToTransfer({ ...p, preservedRecords: p.records }, { exportedAt: at(20) });
  assert.equal(updated.collections.length, 1);
  for (const r of archive.collections[0].records) assert.deepEqual(updated.collections[0].records.find((candidate) => candidate.id === r.id), r);
  assert.equal(updated.collections[0].records.filter((r) => r.kind === "sortSession").length, archive.collections[0].records.filter((r) => r.kind === "sortSession").length);
  const revised = updated.collections[0].records.filter((r) => r.kind === "collectionRevision").map(payload).find((r) => r.title === "Edited secondary");
  assert.equal(revised.parentRevisionID, sourceID);
  const projected = transferToWebWorkspace(updated);
  assert.equal(projected.collections.length, 2);
  assert.equal(projected.collections.find((c) => c.name === "Edited secondary").cards[0].detail, "Updated secondary card details");
  assert.deepEqual(webWorkspaceToTransfer({ ...projected, preservedRecords: projected.records }, { exportedAt: updated.exportedAt }), updated);
});

test("a new sort on a secondary version projects back onto that matching version", () => {
  const archive = multipleLeafArchive(), p = transferToWebWorkspace(archive), secondary = p.collections.find((c) => c.id !== c.transferBundleID);
  p.runs.push({ id:"secondary-sort-run", sortId:"secondary-sort", collectionId:secondary.id, roundNumber:1, roundPlan:[{title:"Secondary round",keepLimit:1}], keepLimit:1, cards:structuredClone(secondary.cards), queue:secondary.cards.map((c) => c.id), decisions:[], createdAt:at(11), updatedAt:at(11) });
  const updated = webWorkspaceToTransfer({ ...p, preservedRecords:p.records }, { exportedAt:at(20) });
  const projected = transferToWebWorkspace(updated), run = projected.runs.find((r) => r.roundTitle === "Secondary round");
  assert.equal(run.collectionId, secondary.id);
  assert.equal(projected.collections.find((c) => c.id === run.collectionId).name, secondary.name);
  assert.equal(run.cards[0].detail, secondary.cards[0].detail);
  assert.equal(updated.collections[0].records.filter((r) => r.kind === "sortSession").length, 2);
});

test("a valid path cannot hide a disconnected mutually-parented action cycle", () => {
  const archive = JSON.parse(readFileSync(new URL("./fixtures/transfer/invalid-disconnected-cycle.json", import.meta.url), "utf8"));
  assert.throws(() => validateTransfer(archive), /cycle|orphan|unreachable/i);
});
