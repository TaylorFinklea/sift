import { authenticate, assertAppWriteOrigin, configuredHosts, handleKeyManagement } from "./security.js";
import { fail, HttpError, readBoundedJson, TRANSFER_JSON_LIMIT } from "./http.js";
import { defaultRoundTitle, fillRoundPlan, validateRoundPlan } from "../shared/sort-plan.js";
import { validateNumericFields, numericValueError, sameNumericScale } from "../shared/numeric-scale.js";
import { remapTransferBundleIDs, TransferValidationError, transferToWebWorkspace, validateTransfer, webWorkspaceToTransfer } from "../shared/transfer.js";

const MAX_CARDS = 500;
const MAX_SNAPSHOT_BYTES = 1_900_000;
const TRANSFER_CHUNK_BYTES = 1_400_000;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemeCount = (value) => [...graphemes.segment(String(value))].length;

function json(status, value, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      ...extraHeaders,
    },
  });
}

function errorResponse(error) {
  if (error instanceof HttpError) {
    return json(error.status, { error: { code: error.code, message: error.message } });
  }
  if (error instanceof TransferValidationError) {
    return json(400, { error: { code: "invalid_transfer", message: error.message } });
  }
  if (error?.code?.startsWith?.("SQLITE_CONSTRAINT")) {
    return json(409, { error: { code: "duplicate", message: "That ID already exists." } });
  }
  return json(500, { error: { code: "server_error", message: "The request could not be completed." } });
}

function cleanText(value, label, maxLength) {
  if (typeof value !== "string") fail(400, "invalid_input", `${label} must be text.`);
  const result = value.trim();
  if (!result || graphemeCount(result) > maxLength) {
    fail(400, "invalid_input", `${label} must contain 1 to ${maxLength} characters.`);
  }
  return result;
}

function cleanCards(cards) {
  if (!Array.isArray(cards) || cards.length < 2 || cards.length > MAX_CARDS) {
    fail(400, "invalid_input", `A collection needs 2 to ${MAX_CARDS} cards.`);
  }
  const ids = new Set();
  return cards.map((card) => {
    if (!card || typeof card !== "object" || Array.isArray(card)) {
      fail(400, "invalid_input", "Each card must be an object.");
    }
    const id = typeof card.id === "string" && card.id.trim()
      ? cleanText(card.id, "Card ID", 80)
      : crypto.randomUUID();
    if (ids.has(id)) fail(400, "invalid_input", "Card IDs must be unique.");
    ids.add(id);
    const detail = card.detail === undefined || card.detail === ""
      ? ""
      : cleanText(card.detail, "Card detail", 500);
    const cleanList = (value, label) => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 10) {
        fail(400, "invalid_input", `${label} must be a list of up to 10 items.`);
      }
      return value.map((item) => {
        if (typeof item !== "string") fail(400, "invalid_input", `${label} must be text.`);
        const trimmed = item.trim();
        if (graphemeCount(trimmed) > 200) fail(400, "invalid_input", `${label} must contain at most 200 characters.`);
        return trimmed;
      }).filter(Boolean);
    };
    const numericValues = Object.create(null);
    if (card.numericValues !== undefined && (!card.numericValues || typeof card.numericValues !== "object" || Array.isArray(card.numericValues))) fail(400, "invalid_numeric_fields", "Card numeric values must be an object.");
    for (const [key, value] of Object.entries(card.numericValues ?? {})) {
      const canonicalID = cleanText(key, "Numeric field ID", 80).toUpperCase();
      if (Object.hasOwn(numericValues, canonicalID)) fail(400, "invalid_numeric_fields", "Card values cannot repeat a numeric field ID.");
      numericValues[canonicalID] = value;
    }
    return {
      id,
      text: cleanText(card.text, "Card title", 120),
      detail,
      pros: cleanList(card.pros, "Card pro"),
      cons: cleanList(card.cons, "Card con"),
      numericValues,
      position: ids.size - 1,
    };
  });
}

function cleanNumericFields(fields, cards = []) {
  const error = validateNumericFields(fields, cards);
  if (error) fail(400, "invalid_numeric_fields", error);
  return (fields ?? []).map((field) => ({ id: field.id.toUpperCase(), name: field.name.trim(), minimum: field.minimum, maximum: field.maximum, step: field.step, unit: field.unit?.trim() ?? "" }));
}

function cleanRatingValue(value, scale) {
  const error = numericValueError(value, scale);
  if (error) fail(400, "invalid_rating", error);
  return value;
}

function optionalLabel(value, fallback) {
  return value === undefined ? fallback : cleanText(value, "Choice label", 36);
}

function cardsSnapshotJson(cards) {
  const snapshot = JSON.stringify(cards);
  if (new TextEncoder().encode(snapshot).byteLength > MAX_SNAPSHOT_BYTES) {
    fail(413, "snapshot_too_large", "This collection is too large to store in Cloudflare D1. Reduce the card descriptions, pros, or cons and try again.");
  }
  return snapshot;
}

function compatibleCards(cards) {
  return cards.map((card) => ({
    ...card,
    pros: Array.isArray(card.pros) ? card.pros : [],
    cons: Array.isArray(card.cons) ? card.cons : [],
    numericValues: card.numericValues && typeof card.numericValues === "object" && !Array.isArray(card.numericValues) ? card.numericValues : {},
  }));
}

function collectionDto(row) {
  const dto = {
    id: row.id,
    name: row.name,
    description: row.description,
    keepLabel: row.keep_label,
    discardLabel: row.discard_label,
    numericFields: JSON.parse(row.numeric_fields_json || "[]"),
    cards: compatibleCards(JSON.parse(row.cards_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.transfer_bundle_id && row.source_revision_id) {
    dto.transferBundleID = row.transfer_bundle_id;
    dto.sourceRevisionID = row.source_revision_id;
  }
  return dto;
}

function sameTransferBundle(left, right) {
  if (!left || !right || left.id.toUpperCase() !== right.id.toUpperCase() || left.records.length !== right.records.length) return false;
  const records = (bundle) => bundle.records.slice().sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(records(left)) === JSON.stringify(records(right));
}

function runDto(row, decisionRows) {
  const decisions = decisionRows.map((decision) => ({
    id: decision.id,
    cardId: decision.card_id,
    choice: decision.choice,
    ...(decision.choice === "rating" ? { value: decision.rating_value } : {}),
    position: decision.position,
    createdAt: decision.created_at,
    undoneAt: decision.undone_at,
    replacesDecisionId: decision.replaces_decision_id || null,
  }));
  const cards = compatibleCards(JSON.parse(row.cards_json));
  const active = decisions.filter((decision) => !decision.undoneAt);
  const roundPlan = fillRoundPlan(row.rounds_json ? JSON.parse(row.rounds_json) : [], row.round_number);
  const queue = row.queue_json ? JSON.parse(row.queue_json) : [];
  const cardIds = new Set(cards.map((card) => card.id));
  const activeIds = new Set(active.map((decision) => decision.cardId));
  const queuedIds = new Set();
  const queued = [];
  for (const cardId of queue) {
    if (cardIds.has(cardId) && !activeIds.has(cardId) && !queuedIds.has(cardId)) {
      queued.push(cardId);
      queuedIds.add(cardId);
    }
  }
  for (const card of cards) {
    if (!activeIds.has(card.id) && !queuedIds.has(card.id)) queued.push(card.id);
  }
  const ratingScale = row.rating_scale_json ? JSON.parse(row.rating_scale_json) : null;
  return {
    id: row.id,
    collectionId: row.collection_id,
    sortId: row.sort_id || row.id,
    roundTitle: roundPlan[row.round_number - 1]?.title || defaultRoundTitle(row.round_number - 1),
    roundPlan,
    planRevision: row.plan_revision ?? 0,
    revisesRunId: row.revises_run_id || null,
    hasLaterResults: Boolean(row.has_later_results),
    queue: queued,
    parentRunId: row.parent_run_id,
    roundNumber: row.round_number,
    keepLimit: ratingScale ? null : row.keep_limit,
    ratingScale,
    numericFields: JSON.parse(row.numeric_fields_json || "[]"),
    revision: row.revision,
    status: active.length === cards.length ? "complete" : "in-progress",
    keepLabel: row.keep_label,
    discardLabel: row.discard_label,
    cards,
    decisions,
    keptCount: active.filter((decision) => decision.choice === "keep").length,
    discardedCount: active.filter((decision) => decision.choice === "discard").length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getCollection(db, id) {
  const row = await db.prepare(`SELECT c.*, v.transfer_bundle_id, v.source_revision_id FROM collections c
    LEFT JOIN transfer_collection_versions v ON v.collection_id = c.id WHERE c.id = ?`).bind(id).first();
  if (!row) fail(404, "not_found", "Collection not found.");
  return row;
}

export async function loadRunHistory(db, collectionId = null) {
  const runQuery = collectionId
    ? db.prepare(`SELECT r.*, s.rounds_json, s.revision AS plan_revision,
        EXISTS (SELECT 1 FROM runs child WHERE child.parent_run_id = r.id) AS has_later_results FROM runs r
        LEFT JOIN sort_sessions s ON s.id = r.sort_id WHERE r.collection_id = ? ORDER BY r.created_at DESC`).bind(collectionId)
    : db.prepare(`SELECT r.*, s.rounds_json, s.revision AS plan_revision,
        EXISTS (SELECT 1 FROM runs child WHERE child.parent_run_id = r.id) AS has_later_results FROM runs r
        LEFT JOIN sort_sessions s ON s.id = r.sort_id ORDER BY r.created_at DESC`);
  const decisionQuery = collectionId
    ? db.prepare(`SELECT d.id, d.run_id, d.card_id, d.choice, d.rating_value, d.position, d.created_at, d.undone_at, d.replaces_decision_id
        FROM sort_answers d JOIN runs r ON r.id = d.run_id WHERE r.collection_id = ?
        ORDER BY r.created_at DESC, d.position`).bind(collectionId)
    : db.prepare(`SELECT d.id, d.run_id, d.card_id, d.choice, d.rating_value, d.position, d.created_at, d.undone_at, d.replaces_decision_id
        FROM sort_answers d JOIN runs r ON r.id = d.run_id ORDER BY r.created_at DESC, d.position`);
  const [runResult, decisionResult] = await db.batch([runQuery, decisionQuery]);
  const decisionsByRun = new Map();
  for (const decision of decisionResult.results) {
    const decisions = decisionsByRun.get(decision.run_id) || [];
    decisions.push(decision);
    decisionsByRun.set(decision.run_id, decisions);
  }
  return runResult.results.map((run) => runDto(run, decisionsByRun.get(run.id) || []));
}

async function digestText(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function chunksByBytes(items, maxBytes = TRANSFER_CHUNK_BYTES) {
  const chunks = []; let current = []; let currentBytes = 2;
  for (const item of items) {
    const itemBytes = new TextEncoder().encode(JSON.stringify(item)).byteLength;
    if (current.length && currentBytes + itemBytes + 1 > maxBytes) {
      chunks.push(current); current = []; currentBytes = 2;
    }
    currentBytes += itemBytes + (current.length ? 1 : 0);
    current.push(item);
    if (currentBytes > maxBytes) {
      fail(413, "transfer_record_too_large", "A transfer record is too large to store safely in Cloudflare D1.");
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function readTransferSnapshot(db) {
  const [collectionResult, runResult, decisionResult, recordResult] = await db.batch([
    db.prepare(`SELECT c.*, v.transfer_bundle_id, v.source_revision_id FROM collections c
      LEFT JOIN transfer_collection_versions v ON v.collection_id = c.id ORDER BY c.name COLLATE NOCASE`),
    db.prepare(`SELECT r.*, s.rounds_json, s.revision AS plan_revision,
      EXISTS (SELECT 1 FROM runs child WHERE child.parent_run_id = r.id) AS has_later_results FROM runs r
      LEFT JOIN sort_sessions s ON s.id = r.sort_id ORDER BY r.created_at DESC`),
    db.prepare(`SELECT d.id, d.run_id, d.card_id, d.choice, d.rating_value, d.position, d.created_at, d.undone_at, d.replaces_decision_id
      FROM sort_answers d JOIN runs r ON r.id = d.run_id ORDER BY r.created_at DESC, d.position`),
    db.prepare("SELECT collection_id, record_id, kind, version, owner_id, logical_id, payload FROM transfer_records"),
  ]);
  const byRun = new Map();
  for (const row of decisionResult.results) {
    const list = byRun.get(row.run_id) || [];
    list.push(row); byRun.set(row.run_id, list);
  }
  return {
    collections: collectionResult.results.map(collectionDto),
    runs: runResult.results.map((row) => runDto(row, byRun.get(row.id) || [])),
    records: recordResult.results.map((row) => ({ collectionID: row.collection_id, id: row.record_id, kind: row.kind,
      version: row.version, ownerID: row.owner_id, logicalID: row.logical_id, payload: row.payload })),
  };
}

async function prepareD1Transfer(db, value) {
  let archive = validateTransfer(value);
  if (!archive.collections.length) fail(400, "empty_transfer", "The transfer contains no collections.");
  const snapshot = await readTransferSnapshot(db);
  const collectionsByID = new Map(snapshot.collections.map((collection) => [collection.id.toUpperCase(), collection]));
  const existingRecords = new Map(snapshot.records.map((record) => [record.id, record]));
  const conflicts = [];
  const duplicates = new Set();
  const conflictEvidence = [];
  const currentBundle = (bundleID, currentArchive) => {
    const views = snapshot.collections.filter((collection) => String(collection.transferBundleID || collection.id).toUpperCase() === bundleID.toUpperCase());
    if (!views.length) return null;
    const preservedRecords = snapshot.records.filter((record) => String(record.collectionID).toUpperCase() === bundleID.toUpperCase());
    return webWorkspaceToTransfer({ collections: snapshot.collections, runs: snapshot.runs, preservedRecords }, {
      exportedAt: currentArchive.exportedAt, collectionId: views[0].id,
    }).collections[0] || null;
  };
  for (const sourceBundle of archive.collections.slice()) {
    const bundle = archive.collections.find((candidate) => candidate.id === sourceBundle.id);
    let recordConflict = false; let matching = 0;
    const existingCollection = collectionsByID.get(bundle.id.toUpperCase());
    for (const record of bundle.records) {
      const existing = existingRecords.get(record.id);
      if (!existing) continue;
      const same = existing.kind === record.kind && existing.version === record.version && existing.ownerID === record.ownerID
        && existing.logicalID === record.logicalID && existing.payload === record.payload;
      if (!same) recordConflict = true; else matching += 1;
      conflictEvidence.push([record.id, same ? "same" : existing]);
    }
    const existingBundle = currentBundle(bundle.id, archive);
    conflictEvidence.push([bundle.id, existingBundle?.records.map((record) => record.id).sort() || null]);
    if ((matching === bundle.records.length && !recordConflict) || sameTransferBundle(existingBundle, bundle)) {
      duplicates.add(bundle.id);
    } else if (recordConflict || existingCollection) {
      const bundleIndex = archive.collections.findIndex((candidate) => candidate.id === bundle.id);
      archive = remapTransferBundleIDs(archive, bundle.id, [bundle.id, ...bundle.records.map((record) => record.id)]);
      const remappedBundle = archive.collections[bundleIndex];
      const remappedCollection = collectionsByID.get(remappedBundle.id.toUpperCase());
      let storedRemappedCount = 0;
      let differentRemappedRecord = false;
      for (const record of remappedBundle.records) {
        const existing = existingRecords.get(record.id);
        if (!existing) continue;
        const same = existing.kind === record.kind && existing.version === record.version
          && existing.ownerID === record.ownerID && existing.logicalID === record.logicalID && existing.payload === record.payload;
        if (same) storedRemappedCount += 1;
        else differentRemappedRecord = true;
      }
      const remappedExistingBundle = currentBundle(remappedBundle.id, archive);
      const targetMatches = sameTransferBundle(remappedExistingBundle, remappedBundle);
      if (differentRemappedRecord || ((remappedCollection || storedRemappedCount > 0) && !targetMatches && storedRemappedCount !== remappedBundle.records.length)) {
        fail(409, "transfer_conflict", "The deterministic collection version already exists with different history. No data was changed.");
      }
      if (storedRemappedCount === remappedBundle.records.length || targetMatches) {
        duplicates.add(remappedBundle.id);
        conflictEvidence.push([remappedBundle.id, "already-present"]);
      } else {
        conflicts.push(bundle.id);
      }
    }
  }
  const converted = transferToWebWorkspace(archive);
  const previewToken = await digestText(JSON.stringify({ archive, conflictEvidence, conflicts, duplicates: [...duplicates].sort() }));
  return { archive, converted, conflicts, duplicates, previewToken, snapshot };
}

function jsonChunks(items) { return chunksByBytes(items.map((item) => item)); }

function transferPreviewCollections(prepared) {
  return prepared.converted.collections.map((collection) => {
    const history = prepared.converted.runs.filter((run) => String(run.collectionId).toUpperCase() === String(collection.id).toUpperCase());
    return {
      name: collection.name,
      cardCount: collection.cards.length,
      historyPathCount: new Set(history.map((run) => run.sortId || run.id)).size,
      roundCount: history.length,
    };
  });
}

async function commitD1Transfer(db, prepared) {
  const now = new Date().toISOString();
  const isDuplicateCollection = (id) => {
    const collection = prepared.converted.collections.find((item) => item.id.toUpperCase() === String(id).toUpperCase());
    return prepared.duplicates.has(collection?.transferBundleID || id);
  };
  const keptCollections = prepared.converted.collections.filter((item) => !isDuplicateCollection(item.id));
  const keptRuns = prepared.converted.runs.filter((item) => !isDuplicateCollection(item.collectionId));
  const bundles = prepared.archive.collections.filter((item) => !prepared.duplicates.has(item.id));
  const collectionRows = keptCollections.map((item) => ({ id: item.id, name: item.name, description: item.description || "", keep_label: item.keepLabel || "Keep", discard_label: item.discardLabel || "Let go", cards_json: JSON.stringify(item.cards), numeric_fields_json: JSON.stringify(item.numericFields || []), created_at: item.createdAt || now, updated_at: item.updatedAt || item.createdAt || now }));
  const versionRows = keptCollections.filter((item) => item.transferBundleID && item.sourceRevisionID)
    .map((item) => ({ collection_id: item.id, transfer_bundle_id: item.transferBundleID, source_revision_id: item.sourceRevisionID, created_at: now }));
  const sessionByID = new Map(keptRuns.map((run) => [run.sortId || run.id, ({ id: run.sortId || run.id, collection_id: run.collectionId, rounds_json: JSON.stringify(run.roundPlan?.length ? run.roundPlan : [{ title: run.roundTitle || "Round 1", keepLimit: run.keepLimit || run.cards.length }]), revision: 0, created_at: run.createdAt || now, updated_at: run.updatedAt || run.createdAt || now })]));
  const sessionRows = [...sessionByID.values()];
  const runRows = keptRuns.map((run) => ({ id: run.id, collection_id: run.collectionId, parent_run_id: run.parentRunId || null, sort_id: run.sortId || run.id, revises_run_id: run.revisesRunId || null, queue_json: JSON.stringify(run.queue || []), round_number: run.roundNumber || 1, keep_limit: Math.max(1, run.keepLimit || run.cards.length), revision: run.revision || 0, keep_label: run.keepLabel || "Keep", discard_label: run.discardLabel || "Let go", cards_json: JSON.stringify(run.cards), rating_scale_json: run.ratingScale ? JSON.stringify(run.ratingScale) : null, numeric_fields_json: JSON.stringify(run.numericFields || []), created_at: run.createdAt || now, updated_at: run.updatedAt || run.createdAt || now }));
  const decisionRows = keptRuns.flatMap((run) => (run.decisions || []).map((d) => ({ id: d.id, run_id: run.id, card_id: d.cardId, choice: d.choice, rating_value: d.choice === "rating" ? d.value : null, position: d.position || 0, created_at: d.createdAt || run.createdAt || now, undone_at: d.undoneAt || null, replaces_decision_id: d.replacesDecisionId || null })));
  const recordMap = new Map();
  for (const bundle of bundles) for (const record of bundle.records) {
    if (!recordMap.has(record.id)) recordMap.set(record.id, { collection_id: bundle.id, record_id: record.id, kind: record.kind, version: record.version, owner_id: record.ownerID, logical_id: record.logicalID, payload: record.payload });
  }
  const recordRows = [...recordMap.values()];
  const statements = [];
  const make = (rows, sql) => { for (const chunk of jsonChunks(rows)) statements.push(db.prepare(sql).bind(JSON.stringify(chunk))); };
  make(collectionRows, `INSERT INTO collections (id,name,description,keep_label,discard_label,cards_json,numeric_fields_json,created_at,updated_at)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.description'),json_extract(value,'$.keep_label'),json_extract(value,'$.discard_label'),json_extract(value,'$.cards_json'),json_extract(value,'$.numeric_fields_json'),json_extract(value,'$.created_at'),json_extract(value,'$.updated_at') FROM json_each(?)`);
  make(versionRows, `INSERT INTO transfer_collection_versions (collection_id,transfer_bundle_id,source_revision_id,created_at)
    SELECT json_extract(value,'$.collection_id'),json_extract(value,'$.transfer_bundle_id'),json_extract(value,'$.source_revision_id'),json_extract(value,'$.created_at') FROM json_each(?)`);
  make(sessionRows, `INSERT INTO sort_sessions (id,collection_id,rounds_json,revision,created_at,updated_at)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.collection_id'),json_extract(value,'$.rounds_json'),json_extract(value,'$.revision'),json_extract(value,'$.created_at'),json_extract(value,'$.updated_at') FROM json_each(?)`);
  make(runRows, `INSERT INTO runs (id,collection_id,parent_run_id,sort_id,revises_run_id,queue_json,round_number,keep_limit,revision,keep_label,discard_label,cards_json,rating_scale_json,numeric_fields_json,created_at,updated_at)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.collection_id'),json_extract(value,'$.parent_run_id'),json_extract(value,'$.sort_id'),json_extract(value,'$.revises_run_id'),json_extract(value,'$.queue_json'),json_extract(value,'$.round_number'),json_extract(value,'$.keep_limit'),json_extract(value,'$.revision'),json_extract(value,'$.keep_label'),json_extract(value,'$.discard_label'),json_extract(value,'$.cards_json'),json_extract(value,'$.rating_scale_json'),json_extract(value,'$.numeric_fields_json'),json_extract(value,'$.created_at'),json_extract(value,'$.updated_at') FROM json_each(?)`);
  make(decisionRows, `INSERT INTO sort_answers (id,run_id,card_id,choice,rating_value,position,created_at,undone_at,replaces_decision_id)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.run_id'),json_extract(value,'$.card_id'),json_extract(value,'$.choice'),json_extract(value,'$.rating_value'),json_extract(value,'$.position'),json_extract(value,'$.created_at'),json_extract(value,'$.undone_at'),json_extract(value,'$.replaces_decision_id') FROM json_each(?)`);
  make(recordRows, `INSERT INTO transfer_records (collection_id,record_id,kind,version,owner_id,logical_id,payload)
    SELECT json_extract(value,'$.collection_id'),json_extract(value,'$.record_id'),json_extract(value,'$.kind'),json_extract(value,'$.version'),json_extract(value,'$.owner_id'),json_extract(value,'$.logical_id'),json_extract(value,'$.payload') FROM json_each(?)`);
  const summary = { collectionCount: prepared.archive.collections.length, recordCount: recordRows.length, duplicateCount: prepared.duplicates.size, conflictCount: prepared.conflicts.length };
  const digest = await digestText(JSON.stringify(prepared.archive));
  statements.push(db.prepare("INSERT INTO transfer_receipts (digest,imported_at,summary_json) VALUES (?,?,?)").bind(digest, now, JSON.stringify(summary)));
  if (!statements.length) fail(400, "empty_transfer", "The transfer contains no new data.");
  if (statements.length > 50) fail(413, "transfer_too_large", "This transfer needs too many database writes to apply safely. Split the file into smaller collection groups.");
  await db.batch(statements);
  return summary;
}

export async function insertInitialRun(db, row, sourceUpdatedAt) {
  const sortId = row.sort_id || row.id;
  const roundsJson = row.rounds_json || JSON.stringify([{ title: defaultRoundTitle(0), keepLimit: row.keep_limit }]);
  const queueJson = row.queue_json || JSON.stringify(JSON.parse(row.cards_json).map((card) => card.id));
  const writes = await db.batch([
    db.prepare(`INSERT INTO sort_sessions (id, collection_id, rounds_json, revision, created_at, updated_at)
      SELECT ?, c.id, ?, 0, ?, ? FROM collections c WHERE c.id = ? AND c.updated_at = ?`)
      .bind(sortId, roundsJson, row.created_at, row.updated_at, row.collection_id, sourceUpdatedAt),
    db.prepare(`INSERT INTO runs
      (id, collection_id, parent_run_id, sort_id, revises_run_id, queue_json, round_number, keep_limit, revision,
       keep_label, discard_label, cards_json, rating_scale_json, numeric_fields_json, created_at, updated_at)
      SELECT ?, c.id, NULL, ?, NULL, ?, 1, ?, 0, c.keep_label, c.discard_label, ?, ?, c.numeric_fields_json, ?, ?
      FROM collections c WHERE c.id = ? AND c.updated_at = ?`)
      .bind(row.id, sortId, queueJson, row.keep_limit, row.cards_json, row.rating_scale_json ?? null, row.created_at, row.updated_at,
        row.collection_id, sourceUpdatedAt),
  ]);
  const inserted = writes[1];
  if (inserted.meta.changes !== 1) fail(409, "revision_conflict", "The collection changed while this round was starting. Reload and try again.");
  return inserted;
}

async function readRunSnapshot(db, id) {
  const [runResult, decisionResult] = await db.batch([
    db.prepare(`SELECT r.*, s.rounds_json, s.revision AS plan_revision,
      EXISTS (SELECT 1 FROM runs child WHERE child.parent_run_id = r.id) AS has_later_results FROM runs r
      LEFT JOIN sort_sessions s ON s.id = r.sort_id WHERE r.id = ?`).bind(id),
    db.prepare("SELECT id, run_id, card_id, choice, rating_value, position, created_at, undone_at, replaces_decision_id FROM sort_answers WHERE run_id = ? ORDER BY position").bind(id),
  ]);
  const row = runResult.results[0];
  if (!row) fail(404, "not_found", "Sort run not found.");
  return { row, dto: runDto(row, decisionResult.results) };
}

async function getRun(db, id) {
  const row = await db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first();
  if (!row) fail(404, "not_found", "Sort run not found.");
  return row;
}

function requireRevision(body, run) {
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    fail(400, "invalid_input", "expectedRevision must be a non-negative integer.");
  }
  if (body.expectedRevision !== run.revision) {
    fail(409, "revision_conflict", "This sort changed in another tab or device. Reload it before continuing.");
  }
}

async function readCollectionCards(db, collectionId) {
  const collection = await getCollection(db, collectionId);
  return { collection, cards: JSON.parse(collection.cards_json) };
}

function authorizeWrite(request, env, auth) {
  if (auth.channel === "app") return assertAppWriteOrigin(request, env);
  if (auth.permission !== "read_write") {
    return json(403, { error: { code: "read_only_key", message: "This API key does not permit changes." } });
  }
  return null;
}

async function routeApi(request, env, auth) {
  const { channel } = auth;
  const db = env.DB;
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const method = request.method;

  if (method === "GET" && url.pathname === "/api/health") {
    return json(200, { ok: true, storage: "d1" });
  }
  if (channel === "app" && (url.pathname === "/api/capabilities" || url.pathname.startsWith("/api/keys"))) {
    const response = await handleKeyManagement(request, env, auth);
    if (response) return response;
  }
  if (method === "GET" && url.pathname === "/api/transfers/export") {
    const snapshot = await readTransferSnapshot(db);
    const collectionId = url.searchParams.get("collectionId") || undefined;
    const archive = webWorkspaceToTransfer({ collections: snapshot.collections, runs: snapshot.runs, preservedRecords: snapshot.records }, { collectionId });
    return json(200, { archive });
  }
  if (method === "POST" && (url.pathname === "/api/transfers/preview" || url.pathname === "/api/transfers/import")) {
    const denied = authorizeWrite(request, env, auth);
    if (denied) return denied;
    const body = await readBoundedJson(request, TRANSFER_JSON_LIMIT);
    const prepared = await prepareD1Transfer(db, body.archive);
    if (method === "POST" && url.pathname === "/api/transfers/preview") {
      return json(200, { previewToken: prepared.previewToken, summary: {
        collectionCount: prepared.archive.collections.length,
        recordCount: prepared.archive.collections.reduce((sum, bundle) => sum + bundle.records.length, 0),
        duplicateCount: prepared.duplicates.size,
        conflictCount: prepared.conflicts.length,
        collections: transferPreviewCollections(prepared),
      } });
    }
    if (typeof body.previewToken !== "string") fail(400, "invalid_input", "Preview the transfer before importing it.");
    if (body.previewToken !== prepared.previewToken) fail(409, "transfer_changed", "The library changed after preview. Review a fresh preview before importing.");
    const digest = await digestText(JSON.stringify(prepared.archive));
    const prior = await db.prepare("SELECT summary_json FROM transfer_receipts WHERE digest = ?").bind(digest).first();
    const alreadyPresent = Boolean(prior);
    const summary = alreadyPresent
      ? { collectionCount: prepared.archive.collections.length, recordCount: 0,
        duplicateCount: prepared.archive.collections.length, conflictCount: 0 }
      : await commitD1Transfer(db, prepared);
    const message = alreadyPresent
      ? "Already present. No new collections or history records were added."
      : `Added ${summary.collectionCount - summary.duplicateCount} collections and ${summary.recordCount} complete history records. Existing library data was preserved.`;
    return json(200, { ...summary, message });
  }
  if (method === "GET" && segments.length === 2 && segments[1] === "collections") {
    const { results } = await db.prepare(`SELECT c.*, v.transfer_bundle_id, v.source_revision_id,
      (SELECT COUNT(*) FROM runs r WHERE r.collection_id = c.id) AS run_count
      FROM collections c LEFT JOIN transfer_collection_versions v ON v.collection_id = c.id ORDER BY c.name COLLATE NOCASE`).all();
    return json(200, { collections: results.map((row) => ({ ...collectionDto(row), runCount: row.run_count })) });
  }
  if (method === "POST" && segments.length === 2 && segments[1] === "collections") {
    const denied = authorizeWrite(request, env, auth);
    if (denied) return denied;
    const body = await readBoundedJson(request);
    const cards = cleanCards(body.cards);
    const numericFields = cleanNumericFields(body.numericFields, cards);
    const name = cleanText(body.name, "Collection name", 100);
    const description = body.description === undefined || body.description === "" ? "" : cleanText(body.description, "Description", 500);
    const keepLabel = optionalLabel(body.keepLabel, "Keep");
    const discardLabel = optionalLabel(body.discardLabel, "Let go");
    const cardsJson = cardsSnapshotJson(cards);
    const now = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(), name, description, keep_label: keepLabel,
      discard_label: discardLabel, cards_json: cardsJson, numeric_fields_json: JSON.stringify(numericFields), created_at: now, updated_at: now,
    };
    await db.prepare(`INSERT INTO collections
      (id, name, description, keep_label, discard_label, cards_json, numeric_fields_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      row.id, row.name, row.description, row.keep_label, row.discard_label,
      row.cards_json, row.numeric_fields_json, row.created_at, row.updated_at,
    ).run();
    return json(201, { collection: collectionDto(row) });
  }
  if (segments.length === 3 && segments[1] === "collections" && method === "GET") {
    return json(200, { collection: collectionDto(await getCollection(db, segments[2])) });
  }
  if (segments.length === 3 && segments[1] === "collections" && method === "PUT") {
    const denied = authorizeWrite(request, env, auth);
    if (denied) return denied;
    const body = await readBoundedJson(request);
    const current = await getCollection(db, segments[2]);
    if (typeof body.expectedUpdatedAt !== "string" || body.expectedUpdatedAt !== current.updated_at) {
      fail(409, "revision_conflict", "This collection changed in another tab or device. Reload it before saving.");
    }
    const cards = cleanCards(body.cards);
    const numericFields = cleanNumericFields(body.numericFields, cards);
    const name = cleanText(body.name, "Collection name", 100);
    const description = body.description === undefined || body.description === "" ? "" : cleanText(body.description, "Description", 500);
    const keepLabel = optionalLabel(body.keepLabel, "Keep");
    const discardLabel = optionalLabel(body.discardLabel, "Let go");
    const cardsJson = cardsSnapshotJson(cards);
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updated_at) + 1)).toISOString();
    const changed = await db.prepare(`UPDATE collections SET name = ?, description = ?, keep_label = ?,
      discard_label = ?, cards_json = ?, numeric_fields_json = ?, updated_at = ? WHERE id = ? AND updated_at = ?`).bind(
      name, description, keepLabel, discardLabel, cardsJson, JSON.stringify(numericFields), updatedAt, current.id, current.updated_at,
    ).run();
    if (changed.meta.changes !== 1) fail(409, "revision_conflict", "This collection changed in another tab or device. Reload it before saving.");
    return json(200, { collection: collectionDto(await getCollection(db, segments[2])) });
  }
  if (segments.length === 2 && segments[1] === "runs" && method === "GET") {
    const collectionId = url.searchParams.get("collectionId") || null;
    return json(200, { runs: await loadRunHistory(db, collectionId) });
  }
  if (segments.length === 2 && segments[1] === "runs" && method === "POST") {
    const denied = authorizeWrite(request, env, auth);
    if (denied) return denied;
    const body = await readBoundedJson(request);
    const now = new Date().toISOString();
    let collectionId;
    let cards;
    let parentRunId = null;
    let roundNumber = 1;
    let sortId;
    let roundPlan;
    let keepLabel;
    let discardLabel;
    let parent;
    let parentSnapshot;
    let parentDto;
    let sourceUpdatedAt;
    let collectionNumericFields = "[]";
    if (body.parentRunId !== undefined) {
      parentSnapshot = await readRunSnapshot(db, cleanText(body.parentRunId, "Parent run ID", 80));
      parent = parentSnapshot.row;
      parentDto = parentSnapshot.dto;
      if (parentDto.status !== "complete") fail(409, "run_incomplete", "Finish the current round before refining its kept cards.");
      cards = parentDto.ratingScale ? parentDto.cards : parentDto.decisions.filter((decision) => !decision.undoneAt && decision.choice === "keep")
        .map((decision) => parentDto.cards.find((card) => card.id === decision.cardId));
      if (cards.length < 2) fail(400, "not_enough_keeps", "Keep at least two cards to start another round.");
      collectionId = parent.collection_id;
      parentRunId = parent.id;
      roundNumber = parent.round_number + 1;
      sortId = parent.sort_id || parent.id;
      roundPlan = fillRoundPlan(parentDto.roundPlan, roundNumber);
      const nextPlan = roundPlan[roundNumber - 1];
      const ratingScale = nextPlan.ratingScale ?? null;
      const preset = nextPlan.keepLimit;
      if (!ratingScale && body.keepLimit === undefined && preset === null) {
        fail(400, "keep_limit_required", `Set a maximum keep count for ${roundPlan[roundNumber - 1].title} before starting it.`);
      }
      if (!ratingScale && preset !== null && body.keepLimit !== undefined && body.keepLimit !== preset) {
        fail(400, "invalid_keep_limit", `${roundPlan[roundNumber - 1].title} is planned to keep ${preset} cards.`);
      }
      if (ratingScale) body.keepLimit = cards.length;
      else if (body.keepLimit === undefined) body.keepLimit = preset;
      keepLabel = parent.keep_label;
      discardLabel = parent.discard_label;
    } else {
      collectionId = cleanText(body.collectionId, "Collection ID", 80);
      const source = await readCollectionCards(db, collectionId);
      cards = source.cards;
      collectionNumericFields = source.collection.numeric_fields_json || "[]";
      roundPlan = validateRoundPlan(body.rounds, fail);
      if (!roundPlan[0].ratingScale && roundPlan[0].keepLimit !== null && roundPlan[0].keepLimit !== body.keepLimit) {
        fail(400, "invalid_round_plan", "Round 1's planned keeps must match the maximum keeps for the first round.");
      }
      if (!roundPlan[0].ratingScale) roundPlan[0] = { ...roundPlan[0], keepLimit: body.keepLimit };
      else body.keepLimit = cards.length;
      sortId = crypto.randomUUID();
      keepLabel = source.collection.keep_label;
      discardLabel = source.collection.discard_label;
      sourceUpdatedAt = source.collection.updated_at;
    }
    if (!Number.isInteger(body.keepLimit) || body.keepLimit < 1 || body.keepLimit > cards.length) {
      fail(400, "invalid_keep_limit", `Maximum keeps must be from 1 to ${cards.length}.`);
    }
    const cardsJson = cardsSnapshotJson(cards);
    const row = {
      id: crypto.randomUUID(), collection_id: collectionId, parent_run_id: parentRunId,
      sort_id: sortId, revises_run_id: null, queue_json: JSON.stringify(cards.map((card) => card.id)),
      round_number: roundNumber, keep_limit: body.keepLimit, revision: 0,
      keep_label: keepLabel, discard_label: discardLabel,
      cards_json: cardsJson, rating_scale_json: JSON.stringify(roundPlan[roundNumber - 1]?.ratingScale ?? null),
      numeric_fields_json: parent ? parent.numeric_fields_json : collectionNumericFields,
      created_at: now, updated_at: now,
    };
    let statement;
    if (parent) {
      statement = db.prepare(`INSERT INTO runs
        (id, collection_id, parent_run_id, sort_id, revises_run_id, queue_json, round_number, keep_limit, revision, keep_label,
         discard_label, cards_json, rating_scale_json, numeric_fields_json, created_at, updated_at)
        SELECT ?, ?, p.id, ?, NULL, ?, ?, ?, 0, p.keep_label, p.discard_label, ?, ?, p.numeric_fields_json, ?, ? FROM runs p
        WHERE p.id = ? AND p.revision = ?
          AND EXISTS (SELECT 1 FROM sort_sessions s WHERE s.id = p.sort_id AND s.revision = ?)
          AND (SELECT COUNT(*) FROM sort_answers d WHERE d.run_id = p.id AND d.undone_at IS NULL) = json_array_length(p.cards_json)
          AND (p.rating_scale_json IS NOT NULL OR (SELECT COUNT(*) FROM sort_answers d WHERE d.run_id = p.id AND d.undone_at IS NULL AND d.choice = 'keep') >= 2)`)
        .bind(row.id, row.collection_id, sortId, row.queue_json, row.round_number, row.keep_limit, row.cards_json, row.rating_scale_json, row.created_at,
          row.updated_at, parent.id, parent.revision, parentSnapshot.row.plan_revision ?? 0);
      const updatePlan = db.prepare(`UPDATE sort_sessions SET rounds_json = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
          AND EXISTS (SELECT 1 FROM runs child WHERE child.id = ? AND child.parent_run_id = ?)`)
        .bind(JSON.stringify(roundPlan), now, sortId, parentSnapshot.row.plan_revision ?? 0, row.id, parent.id);
      const writes = await db.batch([statement, updatePlan]);
      if (writes[0].meta.changes !== 1 || writes[1].meta.changes !== 1) {
        fail(409, "revision_conflict", "The source changed while this round was starting. Reload and try again.");
      }
      return json(201, { run: (await readRunSnapshot(db, row.id)).dto });
    } else {
      row.rounds_json = JSON.stringify(roundPlan);
      await insertInitialRun(db, row, sourceUpdatedAt);
      return json(201, { run: (await readRunSnapshot(db, row.id)).dto });
    }
  }
  if (segments.length === 3 && segments[1] === "runs" && method === "GET") {
    const snapshot = await readRunSnapshot(db, segments[2]);
    return json(200, { run: snapshot.dto });
  }
  if (segments.length === 4 && segments[1] === "runs" && segments[3] === "plan" && method === "PATCH") {
    const denied = authorizeWrite(request, env, auth);
    if (denied) return denied;
    const body = await readBoundedJson(request);
    const snapshot = await readRunSnapshot(db, segments[2]);
    const current = snapshot.row;
    const sort = await db.prepare("SELECT * FROM sort_sessions WHERE id = ?").bind(current.sort_id).first();
    if (!sort) fail(404, "not_found", "Sort session not found.");
    if (!Number.isInteger(body.expectedPlanRevision) || body.expectedPlanRevision < 0) fail(400, "invalid_input", "expectedPlanRevision must be a non-negative integer.");
    if (body.expectedPlanRevision !== sort.revision) fail(409, "revision_conflict", "The round plan changed in another tab or device. Reload it before saving.");
    const plan = validateRoundPlan(body.rounds, fail);
    const started = await db.prepare("SELECT round_number, MAX(keep_limit) AS keep_limit, rating_scale_json FROM runs WHERE sort_id = ? GROUP BY round_number").bind(sort.id).all();
    const startedCount = started.results.reduce((count, row) => Math.max(count, row.round_number), 0);
    if (plan.length < startedCount) fail(400, "invalid_round_plan", `The plan must keep its ${startedCount} started rounds.`);
    for (const round of started.results) {
      const original = round.rating_scale_json ? JSON.parse(round.rating_scale_json) : null;
      if (!sameNumericScale(plan[round.round_number - 1]?.ratingScale ?? null, original)) fail(400, "invalid_round_plan", "The type and scale of a started round cannot be changed.");
      plan[round.round_number - 1] = { ...plan[round.round_number - 1], keepLimit: original ? null : round.keep_limit, ...(original ? { ratingScale: original } : {}) };
    }
    const now = new Date().toISOString();
    const changed = await db.prepare(`UPDATE sort_sessions SET rounds_json = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?`).bind(JSON.stringify(plan), now, sort.id, sort.revision).run();
    if (changed.meta.changes !== 1) fail(409, "revision_conflict", "The round plan changed in another tab or device. Reload it before saving.");
    return json(200, { run: (await readRunSnapshot(db, current.id)).dto });
  }
  if (segments.length === 4 && segments[1] === "runs" && segments[3] === "skip" && method === "POST") {
    const denied = authorizeWrite(request, env, auth);
    if (denied) return denied;
    const body = await readBoundedJson(request);
    const snapshot = await readRunSnapshot(db, segments[2]);
    const current = snapshot.row;
    requireRevision(body, current);
    if (snapshot.dto.status === "complete") fail(409, "run_complete", "This sort is complete.");
    const cardId = cleanText(body.cardId, "Card ID", 80);
    if (!snapshot.dto.cards.some((card) => card.id === cardId) || snapshot.dto.decisions.some((decision) => decision.cardId === cardId && !decision.undoneAt)) {
      fail(400, "card_already_sorted", "That card is not waiting to be sorted.");
    }
    if (snapshot.dto.queue.length > 1) {
      const queue = snapshot.dto.queue.filter((id) => id !== cardId);
      queue.push(cardId);
      const now = new Date().toISOString();
      const changed = await db.prepare(`UPDATE runs SET queue_json = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND EXISTS (SELECT 1 FROM json_each(cards_json) c WHERE json_extract(c.value, '$.id') = ?)
          AND NOT EXISTS (SELECT 1 FROM sort_answers d WHERE d.run_id = runs.id AND d.card_id = ? AND d.undone_at IS NULL)`)
        .bind(JSON.stringify(queue), now, current.id, current.revision, cardId, cardId).run();
      if (changed.meta.changes !== 1) fail(409, "revision_conflict", "This sort changed in another tab or device. Reload it before continuing.");
    }
    return json(200, { run: (await readRunSnapshot(db, current.id)).dto });
  }
  if (segments.length === 4 && segments[1] === "runs" && segments[3] === "revise" && method === "POST") {
    const denied = authorizeWrite(request, env, auth);
    if (denied) return denied;
    const body = await readBoundedJson(request);
    const current = await getRun(db, segments[2]);
    requireRevision(body, current);
    const scale = current.rating_scale_json ? JSON.parse(current.rating_scale_json) : null;
    const isRating = body.choice === "rating";
    if (isRating !== Boolean(scale) || (!isRating && !["keep", "discard"].includes(body.choice))) fail(400, "invalid_choice", "Answer type must match this round.");
    if (isRating) cleanRatingValue(body.value, scale);
    const snapshot = await readRunSnapshot(db, current.id);
    const dto = snapshot.dto;
    const cardId = cleanText(body.cardId, "Card ID", 80);
    if (!dto.cards.some((card) => card.id === cardId)) fail(404, "not_found", "Card not found in this sort.");
    const decision = dto.decisions.find((entry) => entry.cardId === cardId && !entry.undoneAt);
    if (!decision) fail(409, "card_not_decided", "That card has no answer to revise.");
    const existingIsRating = decision.choice === "rating";
    if (existingIsRating !== isRating) fail(400, "invalid_choice", "An answer must match this round's type.");
    const activeKeeps = dto.keptCount - (decision.choice === "keep" ? 1 : 0) + (body.choice === "keep" ? 1 : 0);
    if (!isRating && activeKeeps > current.keep_limit) fail(409, "keep_limit_reached", "The maximum keeps for this round has been reached.");
    const child = await db.prepare("SELECT 1 AS found FROM runs WHERE parent_run_id = ? LIMIT 1").bind(current.id).first();
    const now = new Date().toISOString();
    if (!child) {
      const replacementId = crypto.randomUUID();
      const position = (await db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM sort_answers WHERE run_id = ?").bind(current.id).first()).next;
      const writes = await db.batch([
        db.prepare(`UPDATE sort_answers SET undone_at = ? WHERE id = ? AND run_id = ? AND undone_at IS NULL
          AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND revision = ?)
          AND NOT EXISTS (SELECT 1 FROM runs child WHERE child.parent_run_id = ?)`)
          .bind(now, decision.id, current.id, current.id, current.revision, current.id),
        db.prepare(`INSERT INTO sort_answers (id, run_id, card_id, choice, rating_value, position, created_at, replaces_decision_id)
          SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM runs r WHERE r.id = ? AND r.revision = ?
            AND EXISTS (SELECT 1 FROM sort_answers WHERE id = ? AND run_id = r.id AND undone_at = ?)
            AND NOT EXISTS (SELECT 1 FROM runs child WHERE child.parent_run_id = r.id)`)
          .bind(replacementId, current.id, cardId, body.choice, isRating ? body.value : null, position, now, decision.id,
            current.id, current.revision, decision.id, now),
        db.prepare(`UPDATE runs SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?
          AND EXISTS (SELECT 1 FROM sort_answers WHERE id = ? AND run_id = ? AND undone_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM runs child WHERE child.parent_run_id = runs.id)`)
          .bind(now, current.id, current.revision, replacementId, current.id),
      ]);
      if (writes.some((write) => write.meta.changes !== 1)) fail(409, "revision_conflict", "This sort changed in another tab or device. Reload it before continuing.");
      return json(200, { run: (await readRunSnapshot(db, current.id)).dto });
    }
    const sort = await db.prepare("SELECT rounds_json FROM sort_sessions WHERE id = ?").bind(current.sort_id).first();
    const newSortId = crypto.randomUUID();
    const newRunId = crypto.randomUUID();
    const decisionIds = new Map(dto.decisions.map((entry) => [entry.id, crypto.randomUUID()]));
    const clonedDecisionId = decisionIds.get(decision.id);
    const copiedDecisionIds = JSON.stringify([...decisionIds]);
    const replacementId = crypto.randomUUID();
    const position = (await db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM sort_answers WHERE run_id = ?").bind(current.id).first()).next;
    const queueJson = JSON.stringify(dto.queue);
    const writes = await db.batch([
      db.prepare(`INSERT INTO sort_sessions (id, collection_id, rounds_json, revision, created_at, updated_at)
        SELECT ?, collection_id, ?, 0, ?, ? FROM runs WHERE id = ? AND revision = ?`)
        .bind(newSortId, sort?.rounds_json || JSON.stringify(dto.roundPlan), now, now, current.id, current.revision),
      db.prepare(`INSERT INTO runs (id, collection_id, parent_run_id, sort_id, revises_run_id, queue_json,
        round_number, keep_limit, revision, keep_label, discard_label, cards_json, rating_scale_json, numeric_fields_json, created_at, updated_at)
        SELECT ?, collection_id, parent_run_id, ?, ?, ?, round_number, keep_limit, 0, keep_label, discard_label, cards_json, rating_scale_json, numeric_fields_json, ?, ?
        FROM runs WHERE id = ? AND revision = ? AND EXISTS (SELECT 1 FROM sort_sessions WHERE id = ?)`)
        .bind(newRunId, newSortId, current.id, queueJson, now, now, current.id, current.revision, newSortId),
      db.prepare(`WITH decision_ids AS (
          SELECT json_extract(value, '$[0]') AS original_id, json_extract(value, '$[1]') AS copied_id
          FROM json_each(?)
        )
        INSERT INTO sort_answers (id, run_id, card_id, choice, rating_value, position, created_at, undone_at, replaces_decision_id)
        SELECT copied.copied_id, ?, d.card_id, d.choice, d.rating_value, d.position, d.created_at,
          CASE WHEN d.id = ? THEN ? ELSE d.undone_at END, replaced.copied_id
        FROM sort_answers d JOIN decision_ids copied ON copied.original_id = d.id
        LEFT JOIN decision_ids replaced ON replaced.original_id = d.replaces_decision_id
        WHERE d.run_id = ?
          AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND revision = ?)
          AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND revises_run_id = ?)`)
        .bind(copiedDecisionIds, newRunId, decision.id, now, current.id,
          current.id, current.revision, newRunId, current.id),
      db.prepare(`INSERT INTO sort_answers (id, run_id, card_id, choice, rating_value, position, created_at, replaces_decision_id)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM runs WHERE id = ? AND revision = ?
          AND EXISTS (SELECT 1 FROM sort_answers d WHERE d.id = ? AND d.run_id = ? AND d.undone_at IS NULL)
          AND EXISTS (SELECT 1 FROM sort_answers prior WHERE prior.id = ? AND prior.run_id = ? AND prior.undone_at = ?)`)
        .bind(replacementId, newRunId, cardId, body.choice, isRating ? body.value : null, position, now, clonedDecisionId,
          current.id, current.revision, decision.id, current.id, clonedDecisionId, newRunId, now),
    ]);
    if (writes[0].meta.changes !== 1 || writes[1].meta.changes !== 1
      || writes[2].meta.changes !== dto.decisions.length || writes[3].meta.changes !== 1) {
      fail(409, "revision_conflict", "This sort changed in another tab or device. Reload it before continuing.");
    }
    return json(200, { run: (await readRunSnapshot(db, newRunId)).dto });
  }
  if (segments.length === 4 && segments[1] === "runs" && segments[3] === "decisions" && method === "POST") {
    const denied = authorizeWrite(request, env, auth);
    if (denied) return denied;
    const body = await readBoundedJson(request);
    const snapshot = await readRunSnapshot(db, segments[2]);
    const current = snapshot.row;
    requireRevision(body, current);
    const dto = snapshot.dto;
    if (dto.status === "complete") fail(409, "run_complete", "This sort is complete.");
    const cardId = cleanText(body.cardId, "Card ID", 80);
    const card = dto.cards.find((entry) => entry.id === cardId);
    if (!card || dto.decisions.some((decision) => decision.cardId === cardId && !decision.undoneAt)) {
      fail(400, "card_already_sorted", "That card is not waiting to be sorted.");
    }
    const scale = current.rating_scale_json ? JSON.parse(current.rating_scale_json) : null;
    const isRating = body.choice === "rating";
    if (isRating !== Boolean(scale) || (!isRating && !["keep", "discard"].includes(body.choice))) fail(400, "invalid_choice", "Answer type must match this round.");
    if (isRating) cleanRatingValue(body.value, scale);
    if (!isRating && body.choice === "keep" && dto.keptCount >= current.keep_limit) {
      fail(409, "keep_limit_reached", "The maximum keeps for this round has been reached.");
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const queueJson = JSON.stringify(dto.queue.filter((queuedId) => queuedId !== cardId));
    const writes = await db.batch([
      db.prepare(`INSERT INTO sort_answers (id, run_id, card_id, choice, rating_value, position, created_at)
        SELECT ?, r.id, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM sort_answers WHERE run_id = r.id), ?
        FROM runs r WHERE r.id = ? AND r.revision = ?
          AND EXISTS (SELECT 1 FROM json_each(r.cards_json) c WHERE json_extract(c.value, '$.id') = ?)
          AND NOT EXISTS (SELECT 1 FROM sort_answers d WHERE d.run_id = r.id AND d.card_id = ? AND d.undone_at IS NULL)
          AND (? != 'keep' OR (SELECT COUNT(*) FROM sort_answers d WHERE d.run_id = r.id AND d.choice = 'keep' AND d.undone_at IS NULL) < r.keep_limit)`)
        .bind(id, cardId, body.choice, isRating ? body.value : null, now, current.id, current.revision, cardId, cardId, body.choice),
      db.prepare(`UPDATE runs SET queue_json = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND EXISTS (SELECT 1 FROM sort_answers WHERE id = ? AND run_id = ? AND undone_at IS NULL)`)
        .bind(queueJson, now, current.id, current.revision, id, current.id),
    ]);
    if (writes[0].meta.changes !== 1 || writes[1].meta.changes !== 1) {
      const latest = await getRun(db, current.id);
      if (latest.revision !== body.expectedRevision) fail(409, "revision_conflict", "This sort changed in another tab or device. Reload it before continuing.");
      fail(409, "revision_conflict", "This sort changed in another tab or device. Reload it before continuing.");
    }
    return json(200, { run: (await readRunSnapshot(db, current.id)).dto });
  }
  if (segments.length === 4 && segments[1] === "runs" && segments[3] === "undo" && method === "POST") {
    const denied = authorizeWrite(request, env, auth);
    if (denied) return denied;
    const body = await readBoundedJson(request);
    const snapshot = await readRunSnapshot(db, segments[2]);
    const current = snapshot.row;
    requireRevision(body, current);
    if (snapshot.dto.hasLaterResults) {
      fail(409, "run_has_later_results", "This round has later results. Revise an answer to start a new path.");
    }
    const decision = await db.prepare(`SELECT * FROM sort_answers WHERE run_id = ? AND undone_at IS NULL
      ORDER BY position DESC LIMIT 1`).bind(current.id).first();
    if (!decision) fail(409, "nothing_to_undo", "There is no decision to undo.");
    const now = new Date().toISOString();
    const queue = snapshot.dto.queue.filter((id) => id !== decision.card_id);
    if (!decision.replaces_decision_id) queue.unshift(decision.card_id);
    const statements = [
      db.prepare(`UPDATE sort_answers SET undone_at = ? WHERE id = ? AND run_id = ? AND undone_at IS NULL
        AND EXISTS (SELECT 1 FROM runs r WHERE r.id = ? AND r.revision = ?)
        AND NOT EXISTS (SELECT 1 FROM runs child WHERE child.parent_run_id = ?)
        AND position = (SELECT MAX(position) FROM sort_answers WHERE run_id = ? AND undone_at IS NULL)`)
        .bind(now, decision.id, current.id, current.id, current.revision, current.id, current.id),
    ];
    if (decision.replaces_decision_id) {
      statements.push(db.prepare(`UPDATE sort_answers SET undone_at = NULL WHERE id = ? AND run_id = ? AND undone_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM sort_answers latest WHERE latest.id = ? AND latest.run_id = ? AND latest.undone_at = ?)
        AND EXISTS (SELECT 1 FROM runs r WHERE r.id = ? AND r.revision = ?)
        AND NOT EXISTS (SELECT 1 FROM runs child WHERE child.parent_run_id = ?)`)
        .bind(decision.replaces_decision_id, current.id, decision.id, current.id, now, current.id, current.revision, current.id));
    }
    const restoreGuard = decision.replaces_decision_id
      ? "AND EXISTS (SELECT 1 FROM sort_answers prior WHERE prior.id = ? AND prior.run_id = ? AND prior.undone_at IS NULL)"
      : "";
    const runUpdate = decision.replaces_decision_id
      ? db.prepare(`UPDATE runs SET queue_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?
          AND EXISTS (SELECT 1 FROM sort_answers WHERE id = ? AND run_id = ? AND undone_at = ?)
          ${restoreGuard} AND NOT EXISTS (SELECT 1 FROM runs child WHERE child.parent_run_id = runs.id)`)
        .bind(JSON.stringify(queue), now, current.id, current.revision, decision.id, current.id, now,
          decision.replaces_decision_id, current.id)
      : db.prepare(`UPDATE runs SET queue_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?
          AND EXISTS (SELECT 1 FROM sort_answers WHERE id = ? AND run_id = ? AND undone_at = ?)
          AND NOT EXISTS (SELECT 1 FROM runs child WHERE child.parent_run_id = runs.id)`)
        .bind(JSON.stringify(queue), now, current.id, current.revision, decision.id, current.id, now);
    statements.push(runUpdate);
    const writes = await db.batch(statements);
    if (writes.some((write) => write.meta.changes !== 1)) {
      fail(409, "revision_conflict", "This sort changed in another tab or device. Reload it before continuing.");
    }
    return json(200, { run: (await readRunSnapshot(db, current.id)).dto });
  }
  return json(404, { error: { code: "not_found", message: "API endpoint not found." } });
}

async function handleRequest(request, env) {
  const requestUrl = new URL(request.url);
  if (requestUrl.protocol !== "https:") {
    return json(400, { error: { code: "https_required", message: "HTTPS is required." } });
  }
  const hosts = configuredHosts(env);
  if (!hosts) return json(503, { error: { code: "host_configuration_unavailable", message: "SIFT_APP_HOST and SIFT_API_HOST must be configured." } });
  const host = requestUrl.host.toLowerCase();
  const expectedChannel = host === hosts.app ? "app" : host === hosts.api ? "api" : null;
  if (!expectedChannel) return json(421, { error: { code: "host_not_allowed", message: "This hostname is not allowed." } });

  // App Store legal/help pages are public by design. Keep this allowlist exact:
  // no trailing slash, nested route, alternate encoding, or non-read method.
  const publicPage = expectedChannel === "app" && ["/privacy", "/support"].includes(requestUrl.pathname)
    && (request.method === "GET" || request.method === "HEAD");
  if (publicPage) {
    const assetRequest = new Request(new URL(requestUrl.pathname, requestUrl.origin), { method: "GET" });
    const assetResponse = await env.ASSETS.fetch(assetRequest);
    const marker = requestUrl.pathname === "/privacy" ? 'name="sift-public-page" content="privacy"' : 'name="sift-public-page" content="support"';
    const html = assetResponse.ok
      && (assetResponse.headers.get("content-type") || "").includes("text/html")
      && (await assetResponse.clone().text()).includes(marker);
    if (!html) {
      return json(404, { error: { code: "not_found", message: "Page not found." } });
    }
    const headers = new Headers(assetResponse.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "same-origin");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Content-Security-Policy", "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    headers.set("Cache-Control", "public, max-age=300, s-maxage=3600");
    return new Response(request.method === "HEAD" ? null : assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
  }

  const authentication = await authenticate(request, env);
  if (authentication instanceof Response) return authentication;
  const { channel } = authentication;
  if (channel !== expectedChannel) return json(421, { error: { code: "host_not_allowed", message: "This hostname is not allowed." } });
  if (requestUrl.pathname.startsWith("/api/")) {
    try {
      return await routeApi(request, env, authentication);
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (channel !== "app") return json(404, { error: { code: "not_found", message: "Page not found." } });
  const assetResponse = await env.ASSETS.fetch(request);
  const headers = new Headers(assetResponse.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Frame-Options", "DENY");
  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

export default { fetch: handleRequest };
export { handleRequest };
