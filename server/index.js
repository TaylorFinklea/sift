import { createServer as createHttpServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRoundTitle, fillRoundPlan, validateRoundPlan } from "../shared/sort-plan.js";
import { validateNumericFields, validateNumericScale, numericValueError, sameNumericScale } from "../shared/numeric-scale.js";
import { TransferValidationError, validateTransfer, transferToWebWorkspace, webWorkspaceToTransfer, remapTransferBundleIDs } from "../shared/transfer.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsonLimit = 2 * 1024 * 1024;
const transferJsonLimit = 17 * 1024 * 1024;
const maxCards = 500;
const trustProxy = process.env.SIFT_TRUST_PROXY_AUTH === "1";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemeCount = (value) => [...graphemes.segment(String(value))].length;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new HttpError(status, code, message);
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
  if (!Array.isArray(cards) || cards.length < 2 || cards.length > maxCards) {
    fail(400, "invalid_input", `A collection needs 2 to ${maxCards} cards.`);
  }
  const ids = new Set();
  return cards.map((card) => {
    if (!card || typeof card !== "object" || Array.isArray(card)) {
      fail(400, "invalid_input", "Each card must be an object.");
    }
    const id = typeof card.id === "string" && card.id.trim()
      ? cleanText(card.id, "Card ID", 80)
      : randomUUID();
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

function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function transferDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameTransferBundle(left, right) {
  if (!left || !right || left.id.toUpperCase() !== right.id.toUpperCase() || left.records.length !== right.records.length) return false;
  const records = (bundle) => bundle.records.slice().sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(records(left)) === JSON.stringify(records(right));
}

function currentTransferBundle(db, bundleID, archive) {
  const rows = db.prepare(`SELECT c.*, v.transfer_bundle_id, v.source_revision_id
    FROM collections c LEFT JOIN transfer_collection_versions v ON v.collection_id = c.id
    WHERE upper(COALESCE(v.transfer_bundle_id, c.id)) = upper(?)`).all(bundleID);
  if (!rows.length) return null;
  const ids = new Set(rows.map((row) => row.id.toUpperCase()));
  const collections = rows.map(collectionDto);
  const runs = db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all()
    .filter((run) => ids.has(run.collection_id.toUpperCase())).map((run) => runDto(db, run));
  const preservedRecords = db.prepare(`SELECT record_id, kind, version, owner_id, logical_id, payload
    FROM transfer_records WHERE upper(collection_id) = upper(?)`).all(bundleID)
    .map((record) => ({ id: record.record_id, kind: record.kind, version: record.version, ownerID: record.owner_id, logicalID: record.logical_id, payload: record.payload }));
  return webWorkspaceToTransfer({ collections, runs, preservedRecords }, { exportedAt: archive.exportedAt, collectionId: rows[0].id }).collections[0] || null;
}

function prepareTransferImport(db, value) {
  let archive = validateTransfer(value);
  if (!archive.collections.length) fail(400, "empty_transfer", "The transfer contains no collections.");
  const existingRecordsList = db.prepare("SELECT collection_id, record_id, kind, version, owner_id, logical_id, payload FROM transfer_records").all();
  const existingRecords = new Map(existingRecordsList.map((row) => [row.record_id, row]));
  let conflicts = 0;
  let duplicates = 0;
  const duplicateIDs = new Set();
  const conflictEvidence = [];
  for (const sourceBundle of archive.collections.slice()) {
    const bundle = archive.collections.find((candidate) => candidate.id === sourceBundle.id);
    const records = bundle.records;
    const existingCollection = db.prepare("SELECT * FROM collections WHERE upper(id) = upper(?)").get(bundle.id);
    let recordConflict = false;
    let matchingRecords = 0;
    for (const record of records) {
      const existing = existingRecords.get(record.id);
      if (!existing) continue;
      const same = existing.kind === record.kind && existing.version === record.version
        && existing.owner_id === record.ownerID && existing.logical_id === record.logicalID && existing.payload === record.payload;
      if (!same) recordConflict = true;
      else matchingRecords += 1;
      conflictEvidence.push([record.id, same ? "same" : JSON.stringify(existing)]);
    }
    const existingBundle = currentTransferBundle(db, bundle.id, archive);
    conflictEvidence.push([bundle.id, existingBundle?.records.map((record) => record.id).sort() || null]);
    const fullyStored = matchingRecords === records.length && !recordConflict;
    if (fullyStored || sameTransferBundle(existingBundle, bundle)) {
      duplicates += 1;
      duplicateIDs.add(bundle.id);
    } else if (recordConflict || existingCollection) {
      const bundleIndex = archive.collections.findIndex((candidate) => candidate.id === bundle.id);
      archive = remapTransferBundleIDs(archive, bundle.id, [bundle.id, ...records.map((record) => record.id)]);
      const remappedBundle = archive.collections[bundleIndex];
      const remappedCollection = db.prepare("SELECT * FROM collections WHERE upper(id) = upper(?)").get(remappedBundle.id);
      let storedRemappedCount = 0;
      let differentRemappedRecord = false;
      for (const record of remappedBundle.records) {
        const existing = existingRecords.get(record.id);
        if (!existing) continue;
        const same = existing.kind === record.kind && existing.version === record.version
          && existing.owner_id === record.ownerID && existing.logical_id === record.logicalID && existing.payload === record.payload;
        if (same) storedRemappedCount += 1;
        else differentRemappedRecord = true;
      }
      const remappedExistingBundle = currentTransferBundle(db, remappedBundle.id, archive);
      const targetMatches = sameTransferBundle(remappedExistingBundle, remappedBundle);
      if (differentRemappedRecord || ((remappedCollection || storedRemappedCount > 0) && !targetMatches && storedRemappedCount !== remappedBundle.records.length)) {
        fail(409, "transfer_conflict", "The deterministic collection version already exists with different history. No data was changed.");
      }
      if (storedRemappedCount === remappedBundle.records.length || targetMatches) {
        duplicates += 1;
        duplicateIDs.add(remappedBundle.id);
        conflictEvidence.push([remappedBundle.id, "already-present"]);
      } else {
        conflicts += 1;
      }
    }
  }
  const converted = transferToWebWorkspace(archive);
  const token = transferDigest({ archive, conflictEvidence, conflicts, duplicates });
  return { archive, converted, conflicts, duplicates, token, conflictEvidence, duplicateIDs };
}

function writeTransferImport(db, prepared) {
  const now = new Date().toISOString();
  const isDuplicateCollection = (id) => {
    const collection = prepared.converted.collections.find((item) => item.id.toUpperCase() === String(id).toUpperCase());
    return prepared.duplicateIDs.has(collection?.transferBundleID || id);
  };
  const allCollections = prepared.converted.collections.filter((item) => !isDuplicateCollection(item.id));
  const runs = prepared.converted.runs.filter((item) => !isDuplicateCollection(item.collectionId));
  for (const collection of allCollections) {
    const existing = db.prepare("SELECT 1 FROM collections WHERE id = ?").get(collection.id);
    if (!existing) {
      const stamp = collection.createdAt || now;
      db.prepare(`INSERT INTO collections (id, name, description, keep_label, discard_label, cards_json, numeric_fields_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(collection.id, collection.name, collection.description || "",
        collection.keepLabel || "Keep", collection.discardLabel || "Let go", JSON.stringify(collection.cards), JSON.stringify(collection.numericFields || []), stamp, collection.updatedAt || stamp);
    }
    if (collection.transferBundleID && collection.sourceRevisionID) {
      db.prepare(`INSERT OR IGNORE INTO transfer_collection_versions
        (collection_id, transfer_bundle_id, source_revision_id, created_at) VALUES (?, ?, ?, ?)`)
        .run(collection.id, collection.transferBundleID, collection.sourceRevisionID, now);
    }
  }
  for (const run of runs) {
    const exists = db.prepare("SELECT 1 FROM runs WHERE id = ?").get(run.id);
    if (exists) continue;
    const collection = allCollections.find((item) => item.id === run.collectionId);
    if (!collection) continue;
    const nowAt = run.createdAt || now;
    const roundPlan = run.roundPlan?.length ? run.roundPlan : [{ title: run.roundTitle || "Round 1", keepLimit: run.keepLimit || run.cards.length }];
    db.prepare(`INSERT OR IGNORE INTO sort_sessions (id, collection_id, rounds_json, revision, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)`).run(run.sortId || run.id, run.collectionId, JSON.stringify(roundPlan), nowAt, run.updatedAt || nowAt);
    db.prepare(`INSERT INTO runs (id, collection_id, parent_run_id, sort_id, revises_run_id, queue_json, round_number, keep_limit, revision,
      keep_label, discard_label, cards_json, rating_scale_json, numeric_fields_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.id, run.collectionId, run.parentRunId || null, run.sortId || run.id, run.revisesRunId || null,
        JSON.stringify(run.queue || []), run.roundNumber || 1, Math.max(1, run.keepLimit || run.cards.length), run.revision || 0,
        run.keepLabel || collection.keepLabel || "Keep", run.discardLabel || collection.discardLabel || "Let go",
        JSON.stringify(run.cards || collection.cards), run.ratingScale ? JSON.stringify(run.ratingScale) : null,
        JSON.stringify(run.numericFields || []), nowAt, run.updatedAt || nowAt);
    for (const decision of run.decisions || []) {
      db.prepare(`INSERT OR IGNORE INTO sort_answers (id, run_id, card_id, choice, rating_value, position, created_at, undone_at, replaces_decision_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(decision.id, run.id, decision.cardId, decision.choice,
        decision.choice === "rating" ? decision.value : null, decision.position || 0,
        decision.createdAt || nowAt, decision.undoneAt || null, decision.replacesDecisionId || null);
    }
  }
  for (const bundle of prepared.archive.collections.filter((item) => !prepared.duplicateIDs.has(item.id))) for (const record of bundle.records) {
    db.prepare(`INSERT OR IGNORE INTO transfer_records (collection_id, record_id, kind, version, owner_id, logical_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(bundle.id, record.id, record.kind, record.version, record.ownerID, record.logicalID, record.payload);
  }
  const newBundles = prepared.archive.collections.filter((item) => !prepared.duplicateIDs.has(item.id));
  const newRecordIDs = new Set(newBundles.flatMap((bundle) => bundle.records.map((record) => record.id)));
  const summary = { collectionCount: prepared.archive.collections.length, recordCount: newRecordIDs.size, duplicateCount: prepared.duplicates, conflictCount: prepared.conflicts };
  db.prepare("INSERT OR IGNORE INTO transfer_receipts (digest, imported_at, summary_json) VALUES (?, ?, ?)")
    .run(transferDigest(prepared.archive), now, JSON.stringify(summary));
  return summary;
}

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

function seedDemo(db) {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM collections").get().count;
  if (existing > 0 || process.env.SIFT_SEED_DEMO === "0") return;
  const now = new Date().toISOString();
  const id = "personal-values";
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
  ].map(([text, detail], position) => ({ id: `value-${position + 1}`, text, detail, position }));
  db.prepare(`INSERT INTO collections
    (id, name, description, keep_label, discard_label, cards_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, "Personal Values", "A first collection to make the sorting flow easy to try.",
    "Keep", "Let go", JSON.stringify(cards), now, now,
  );
}

function openDatabase(dbPath) {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    keep_label TEXT NOT NULL DEFAULT 'Keep',
    discard_label TEXT NOT NULL DEFAULT 'Let go',
    cards_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sort_sessions (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections(id),
    rounds_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections(id),
    parent_run_id TEXT REFERENCES runs(id),
    sort_id TEXT REFERENCES sort_sessions(id),
    revises_run_id TEXT REFERENCES runs(id),
    queue_json TEXT NOT NULL DEFAULT '[]',
    round_number INTEGER NOT NULL,
    keep_limit INTEGER NOT NULL CHECK (keep_limit > 0),
    revision INTEGER NOT NULL DEFAULT 0,
    keep_label TEXT NOT NULL,
    discard_label TEXT NOT NULL,
    cards_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    card_id TEXT NOT NULL,
    choice TEXT NOT NULL CHECK (choice IN ('keep', 'discard')),
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    undone_at TEXT,
    replaces_decision_id TEXT REFERENCES decisions(id)
  );
  CREATE TABLE IF NOT EXISTS transfer_records (
    collection_id TEXT NOT NULL,
    record_id TEXT NOT NULL PRIMARY KEY,
    kind TEXT NOT NULL,
    version INTEGER NOT NULL,
    owner_id TEXT NOT NULL,
    logical_id TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS transfer_records_collection_idx ON transfer_records(collection_id);
  CREATE TABLE IF NOT EXISTS transfer_collection_versions (
    collection_id TEXT PRIMARY KEY REFERENCES collections(id),
    transfer_bundle_id TEXT NOT NULL,
    source_revision_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS transfer_collection_versions_bundle_idx ON transfer_collection_versions(transfer_bundle_id);
  CREATE TABLE IF NOT EXISTS transfer_receipts (
    digest TEXT PRIMARY KEY,
    imported_at TEXT NOT NULL,
    summary_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runs_history_idx ON runs(collection_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS runs_parent_run_idx ON runs(parent_run_id);
  CREATE INDEX IF NOT EXISTS decisions_run_position_idx ON decisions(run_id, position);
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_decision_per_card
    ON decisions(run_id, card_id) WHERE undone_at IS NULL;
  `);
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  const collectionColumns = columns("collections");
  if (!collectionColumns.has("numeric_fields_json")) db.exec("ALTER TABLE collections ADD COLUMN numeric_fields_json TEXT NOT NULL DEFAULT '[]'");
  const runColumns = columns("runs");
  if (!runColumns.has("rating_scale_json")) db.exec("ALTER TABLE runs ADD COLUMN rating_scale_json TEXT");
  if (!runColumns.has("numeric_fields_json")) db.exec("ALTER TABLE runs ADD COLUMN numeric_fields_json TEXT NOT NULL DEFAULT '[]'");
  if (!runColumns.has("sort_id")) db.exec("ALTER TABLE runs ADD COLUMN sort_id TEXT REFERENCES sort_sessions(id)");
  if (!runColumns.has("revises_run_id")) db.exec("ALTER TABLE runs ADD COLUMN revises_run_id TEXT REFERENCES runs(id)");
  if (!runColumns.has("queue_json")) db.exec("ALTER TABLE runs ADD COLUMN queue_json TEXT NOT NULL DEFAULT '[]'");
  const decisionColumns = columns("decisions");
  if (!decisionColumns.has("replaces_decision_id")) db.exec("ALTER TABLE decisions ADD COLUMN replaces_decision_id TEXT REFERENCES decisions(id)");

  // Copy legacy answers idempotently. The table creation, copy and indexes are
  // one transaction so a restart can safely retry an interrupted migration.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS sort_answers (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      card_id TEXT NOT NULL,
      choice TEXT NOT NULL CHECK (choice IN ('keep', 'discard', 'rating')),
      rating_value REAL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      undone_at TEXT,
      replaces_decision_id TEXT REFERENCES sort_answers(id),
      CHECK ((choice = 'rating' AND rating_value IS NOT NULL) OR (choice != 'rating' AND rating_value IS NULL))
    );
    INSERT OR IGNORE INTO sort_answers (id, run_id, card_id, choice, rating_value, position, created_at, undone_at, replaces_decision_id)
      SELECT id, run_id, card_id, choice, NULL, position, created_at, undone_at, replaces_decision_id FROM decisions ORDER BY run_id, position;
    CREATE INDEX IF NOT EXISTS runs_sort_history_idx ON runs(sort_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS sort_answers_run_position_idx ON sort_answers(run_id, position);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_answer_per_card ON sort_answers(run_id, card_id) WHERE undone_at IS NULL;
    WITH RECURSIVE lineage(id, root_id) AS (
    SELECT id, id FROM runs WHERE parent_run_id IS NULL
    UNION ALL SELECT child.id, lineage.root_id FROM runs child JOIN lineage ON child.parent_run_id = lineage.id
  ) INSERT OR IGNORE INTO sort_sessions (id, collection_id, rounds_json, revision, created_at, updated_at)
  SELECT root.id, root.collection_id,
    (SELECT json_group_array(json_object('title', 'Round ' || rounds.round_number, 'keepLimit', rounds.keep_limit))
     FROM (SELECT member.round_number, MAX(member.keep_limit) AS keep_limit FROM runs member
       JOIN lineage ON lineage.id = member.id WHERE lineage.root_id = root.id
       GROUP BY member.round_number ORDER BY member.round_number) rounds),
    0, root.created_at, root.updated_at FROM runs root WHERE root.parent_run_id IS NULL;
  WITH RECURSIVE lineage(id, root_id) AS (
    SELECT id, id FROM runs WHERE parent_run_id IS NULL
    UNION ALL SELECT child.id, lineage.root_id FROM runs child JOIN lineage ON child.parent_run_id = lineage.id
  ) UPDATE runs SET sort_id = (SELECT root_id FROM lineage WHERE lineage.id = runs.id) WHERE sort_id IS NULL;
  UPDATE runs SET queue_json = COALESCE((SELECT json_group_array(json_extract(card.value, '$.id'))
    FROM json_each(runs.cards_json) card WHERE NOT EXISTS (SELECT 1 FROM sort_answers d WHERE d.run_id = runs.id
      AND d.card_id = json_extract(card.value, '$.id') AND d.undone_at IS NULL)), '[]') WHERE queue_json = '[]';`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  seedDemo(db);
  return db;
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

function getCollection(db, id) {
  const row = db.prepare(`SELECT c.*, v.transfer_bundle_id, v.source_revision_id FROM collections c
    LEFT JOIN transfer_collection_versions v ON v.collection_id = c.id WHERE c.id = ?`).get(id);
  if (!row) fail(404, "not_found", "Collection not found.");
  return row;
}

function runDto(db, row) {
  const decisions = db.prepare(
    "SELECT id, card_id, choice, rating_value, position, created_at, undone_at, replaces_decision_id FROM sort_answers WHERE run_id = ? ORDER BY position",
  ).all(row.id).map((decision) => ({
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
  const sort = row.sort_id ? db.prepare("SELECT * FROM sort_sessions WHERE id = ?").get(row.sort_id) : null;
  const roundPlan = fillRoundPlan(sort ? JSON.parse(sort.rounds_json) : [], row.round_number);
  const ratingScale = row.rating_scale_json ? JSON.parse(row.rating_scale_json) : null;
  const numericFields = JSON.parse(row.numeric_fields_json || "[]");
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
  const hasLaterResults = Boolean(db.prepare("SELECT 1 FROM runs WHERE parent_run_id = ? LIMIT 1").get(row.id));
  return {
    id: row.id,
    collectionId: row.collection_id,
    sortId: row.sort_id || row.id,
    roundTitle: roundPlan[row.round_number - 1]?.title || defaultRoundTitle(row.round_number - 1),
    roundPlan,
    planRevision: sort?.revision ?? 0,
    revisesRunId: row.revises_run_id || null,
    hasLaterResults,
    queue: queued,
    parentRunId: row.parent_run_id,
    roundNumber: row.round_number,
    keepLimit: ratingScale ? null : row.keep_limit,
    ratingScale,
    numericFields,
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

function getRun(db, id) {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
  if (!row) fail(404, "not_found", "Sort run not found.");
  return row;
}

async function readJson(req, limit = jsonLimit) {
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (declaredLength > limit) fail(413, "body_too_large", "Request body is too large.");
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) fail(413, "body_too_large", "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(400, "invalid_input", "Request body must be a JSON object.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function requireRevision(body, run) {
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    fail(400, "invalid_input", "expectedRevision must be a non-negative integer.");
  }
  if (body.expectedRevision !== run.revision) {
    fail(409, "revision_conflict", "This sort changed in another tab or device. Reload it before continuing.");
  }
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) fail(403, "origin_required", "A same-origin request is required.");
  try {
    const parsed = new URL(origin);
    const trustedPublicOrigin = process.env.SIFT_PUBLIC_ORIGIN;
    const expectedOrigin = trustProxy
      ? trustedPublicOrigin
      : `http://${host}`;
    if (!expectedOrigin || parsed.origin !== new URL(expectedOrigin).origin) {
      fail(403, "cross_origin_request", "Cross-origin requests are not allowed.");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(403, "cross_origin_request", "Cross-origin requests are not allowed.");
  }
}

function assertAllowedHost(req) {
  const host = req.headers.host;
  if (!host || host.length > 255 || /[/\\\\?#@\s\u0000-\u001f]/.test(host)) {
    fail(400, "invalid_host", "A valid Host header is required.");
  }
  let hostname;
  let port;
  try {
    const parsed = new URL(`http://${host}`);
    hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    port = parsed.port;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      fail(400, "invalid_host", "A valid Host header is required.");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, "invalid_host", "A valid Host header is required.");
  }
  if (port && (Number(port) < 1 || Number(port) > 65535)) {
    fail(400, "invalid_host", "A valid Host port is required.");
  }
  let allowed = ["localhost", "127.0.0.1", "::1"];
  if (trustProxy) {
    try {
      allowed = [new URL(process.env.SIFT_PUBLIC_ORIGIN).hostname.toLowerCase().replace(/^\[|\]$/g, "")];
    } catch {
      fail(500, "proxy_origin_missing", "The proxy origin is not configured.");
    }
  } else if (process.env.SIFT_DEV_HOST) {
    const devHost = process.env.SIFT_DEV_HOST.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(devHost) || devHost === "localhost" || devHost.endsWith(".localhost")) {
      fail(500, "invalid_dev_host", "SIFT_DEV_HOST must be a specific preview hostname.");
    }
    allowed.push(devHost);
  }
  if (!allowed.includes(hostname)) {
    fail(421, "host_not_allowed", "This hostname is not allowed.");
  }
}

function mimeType(filePath) {
  switch (path.extname(filePath)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": case ".webmanifest": return "application/manifest+json; charset=utf-8";
    case ".png": return "image/png";
    case ".svg": return "image/svg+xml";
    case ".ico": return "image/x-icon";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function streamFile(res, filePath, status = 200) {
  res.writeHead(status, { "Content-Type": mimeType(filePath), "Cache-Control": "no-cache" });
  const stream = createReadStream(filePath);
  stream.once("error", () => {
    if (!res.headersSent) sendJson(res, 404, { error: { code: "not_found", message: "File not found." } });
    else res.destroy();
  });
  stream.pipe(res);
}

function staticResponse(req, res, pathname, staticDir) {
  if (!staticDir) return false;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  const root = path.resolve(staticDir);
  const filePath = path.resolve(root, `.${decoded}`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return false;
  try {
    if (statSync(filePath).isFile()) {
      streamFile(res, filePath);
      return true;
    }
  } catch { /* SPA fallback below. */ }
  if (!path.extname(decoded) && req.headers.accept?.includes("text/html")) {
    try {
      const index = path.join(root, "index.html");
      if (statSync(index).isFile()) {
        streamFile(res, index);
        return true;
      }
    } catch { /* A build is not available yet. */ }
  }
  return false;
}

export function createAppServer({ dbPath = process.env.SIFT_DB_PATH || path.join(projectRoot, ".local", "sift.sqlite"), staticDir = path.join(projectRoot, "dist", "client") } = {}) {
  const db = openDatabase(dbPath);
  const server = createHttpServer(async (req, res) => {
    setSecurityHeaders(res);
    try {
      assertAllowedHost(req);
      const url = new URL(req.url || "/", "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);
      const method = req.method || "GET";
      if (segments[0] !== "api") {
        if (staticResponse(req, res, url.pathname, staticDir)) return;
        sendJson(res, 404, { error: { code: "not_found", message: "Page not found." } });
        return;
      }

      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true, storage: "sqlite" });
        return;
      }

      if (method === "GET" && url.pathname === "/api/capabilities") {
        sendJson(res, 200, { apiKeys: false });
        return;
      }

      if (method === "GET" && url.pathname === "/api/transfers/export") {
        const collectionId = url.searchParams.get("collectionId") || undefined;
        const collections = db.prepare(`SELECT c.*, v.transfer_bundle_id, v.source_revision_id FROM collections c
          LEFT JOIN transfer_collection_versions v ON v.collection_id = c.id ORDER BY c.name COLLATE NOCASE`).all().map(collectionDto);
        const runs = db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all().map((row) => runDto(db, row));
        const preservedRecords = db.prepare("SELECT record_id, kind, version, owner_id, logical_id, payload FROM transfer_records").all()
          .map((row) => ({ id: row.record_id, kind: row.kind, version: row.version, ownerID: row.owner_id, logicalID: row.logical_id, payload: row.payload }));
        const archive = webWorkspaceToTransfer({ collections, runs, preservedRecords }, { collectionId });
        sendJson(res, 200, { archive });
        return;
      }

      const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
      if (mutating) assertSameOrigin(req);

      if (method === "POST" && url.pathname === "/api/transfers/preview") {
        const body = await readJson(req, transferJsonLimit);
        const prepared = prepareTransferImport(db, body.archive);
        sendJson(res, 200, { previewToken: prepared.token, summary: {
          collectionCount: prepared.archive.collections.length,
          recordCount: prepared.archive.collections.reduce((sum, bundle) => sum + bundle.records.length, 0),
          duplicateCount: prepared.duplicates,
          conflictCount: prepared.conflicts,
          collections: transferPreviewCollections(prepared),
        } });
        return;
      }

      if (method === "POST" && url.pathname === "/api/transfers/import") {
        const body = await readJson(req, transferJsonLimit);
        if (typeof body.previewToken !== "string") fail(400, "invalid_input", "Preview the transfer before importing it.");
        const summary = transaction(db, () => {
          const prepared = prepareTransferImport(db, body.archive);
          if (prepared.token !== body.previewToken) fail(409, "transfer_changed", "The library changed after preview. Review a fresh preview before importing.");
          const digest = transferDigest(prepared.archive);
          const prior = db.prepare("SELECT summary_json FROM transfer_receipts WHERE digest = ?").get(digest);
          if (prior) return {
            alreadyPresent: true,
            summary: { collectionCount: prepared.archive.collections.length, recordCount: 0,
              duplicateCount: prepared.archive.collections.length, conflictCount: 0 },
          };
          return { alreadyPresent: false, summary: writeTransferImport(db, prepared) };
        });
        const message = summary.alreadyPresent
          ? "Already present. No new collections or history records were added."
          : `Added ${summary.summary.collectionCount - summary.summary.duplicateCount} collections and ${summary.summary.recordCount} complete history records. Existing library data was preserved.`;
        sendJson(res, 200, { ...summary.summary, message });
        return;
      }

      if (segments.length === 2 && segments[1] === "collections" && method === "GET") {
        const rows = db.prepare(`SELECT c.*, v.transfer_bundle_id, v.source_revision_id FROM collections c
          LEFT JOIN transfer_collection_versions v ON v.collection_id = c.id ORDER BY c.name COLLATE NOCASE`).all();
        const collections = rows.map((row) => ({
          ...collectionDto(row),
          runCount: db.prepare("SELECT COUNT(*) AS count FROM runs WHERE collection_id = ?").get(row.id).count,
        }));
        sendJson(res, 200, { collections });
        return;
      }

      if (segments.length === 2 && segments[1] === "collections" && method === "POST") {
        const body = await readJson(req);
        const cards = cleanCards(body.cards);
        const numericFields = cleanNumericFields(body.numericFields, cards);
        const name = cleanText(body.name, "Collection name", 100);
        const description = body.description === undefined || body.description === ""
          ? ""
          : cleanText(body.description, "Description", 500);
        const keepLabel = optionalLabel(body.keepLabel, "Keep");
        const discardLabel = optionalLabel(body.discardLabel, "Let go");
        const now = new Date().toISOString();
        const collection = transaction(db, () => {
          const row = {
            id: randomUUID(), name, description, keep_label: keepLabel,
            discard_label: discardLabel, cards_json: JSON.stringify(cards), numeric_fields_json: JSON.stringify(numericFields),
            created_at: now, updated_at: now,
          };
          db.prepare(`INSERT INTO collections
            (id, name, description, keep_label, discard_label, cards_json, numeric_fields_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            row.id, row.name, row.description, row.keep_label, row.discard_label,
            row.cards_json, row.numeric_fields_json, row.created_at, row.updated_at,
          );
          return collectionDto(row);
        });
        sendJson(res, 201, { collection });
        return;
      }

      if (segments.length === 3 && segments[1] === "collections" && method === "GET") {
        sendJson(res, 200, { collection: collectionDto(getCollection(db, segments[2])) });
        return;
      }

      if (segments.length === 3 && segments[1] === "collections" && method === "PUT") {
        const body = await readJson(req);
        const current = getCollection(db, segments[2]);
        if (typeof body.expectedUpdatedAt !== "string" || body.expectedUpdatedAt !== current.updated_at) {
          fail(409, "revision_conflict", "This collection changed in another tab or device. Reload it before saving.");
        }
        const cards = cleanCards(body.cards);
        const numericFields = cleanNumericFields(body.numericFields, cards);
        const name = cleanText(body.name, "Collection name", 100);
        const description = body.description === undefined || body.description === ""
          ? ""
          : cleanText(body.description, "Description", 500);
        const keepLabel = optionalLabel(body.keepLabel, "Keep");
        const discardLabel = optionalLabel(body.discardLabel, "Let go");
        const updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updated_at) + 1)).toISOString();
        const changed = db.prepare(`UPDATE collections SET name = ?, description = ?, keep_label = ?,
          discard_label = ?, cards_json = ?, numeric_fields_json = ?, updated_at = ? WHERE id = ? AND updated_at = ?`).run(
          name, description, keepLabel, discardLabel, JSON.stringify(cards), JSON.stringify(numericFields), updatedAt, current.id, current.updated_at,
        );
        if (changed.changes !== 1) fail(409, "revision_conflict", "This collection changed in another tab or device. Reload it before saving.");
        sendJson(res, 200, { collection: collectionDto(getCollection(db, segments[2])) });
        return;
      }

      if (segments.length === 2 && segments[1] === "runs" && method === "GET") {
        const collectionId = url.searchParams.get("collectionId");
        const rows = collectionId
          ? db.prepare("SELECT * FROM runs WHERE collection_id = ? ORDER BY created_at DESC").all(collectionId)
          : db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all();
        sendJson(res, 200, { runs: rows.map((row) => runDto(db, row)) });
        return;
      }

      if (segments.length === 2 && segments[1] === "runs" && method === "POST") {
        const body = await readJson(req);
        const now = new Date().toISOString();
        const run = transaction(db, () => {
          let collectionId;
          let cards;
          let parentRunId = null;
          let roundNumber = 1;
          let keepLabel;
          let discardLabel;
          let sortId;
          let roundPlan;
          if (body.parentRunId !== undefined) {
            const parent = getRun(db, cleanText(body.parentRunId, "Parent run ID", 80));
            const parentDto = runDto(db, parent);
            if (parentDto.status !== "complete") fail(409, "run_incomplete", "Finish the current round before refining its kept cards.");
            cards = parentDto.ratingScale ? parentDto.cards : parentDto.decisions
              .filter((decision) => !decision.undoneAt && decision.choice === "keep")
              .map((decision) => parentDto.cards.find((card) => card.id === decision.cardId));
            if (cards.length < 2) fail(400, "not_enough_keeps", "Keep at least two cards to start another round.");
            collectionId = parent.collection_id;
            parentRunId = parent.id;
            roundNumber = parent.round_number + 1;
            sortId = parent.sort_id || parent.id;
            roundPlan = fillRoundPlan(parentDto.roundPlan, roundNumber);
            keepLabel = parent.keep_label;
            discardLabel = parent.discard_label;
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
            db.prepare("UPDATE sort_sessions SET rounds_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
              .run(JSON.stringify(roundPlan), now, sortId);
          } else {
            collectionId = cleanText(body.collectionId, "Collection ID", 80);
            const collection = getCollection(db, collectionId);
            cards = JSON.parse(collection.cards_json);
            roundPlan = validateRoundPlan(body.rounds, fail);
            if (roundPlan[0].keepLimit !== null && roundPlan[0].keepLimit !== body.keepLimit) {
              fail(400, "invalid_round_plan", "Round 1's planned keeps must match the maximum keeps for the first round.");
            }
            if (!roundPlan[0].ratingScale) roundPlan[0] = { ...roundPlan[0], keepLimit: body.keepLimit };
            else body.keepLimit = cards.length;
            sortId = randomUUID();
            keepLabel = collection.keep_label;
            discardLabel = collection.discard_label;
          }
          if (!Number.isInteger(body.keepLimit) || body.keepLimit < 1 || body.keepLimit > cards.length) {
            fail(400, "invalid_keep_limit", `Maximum keeps must be from 1 to ${cards.length}.`);
          }
          const row = {
            id: randomUUID(), collection_id: collectionId, parent_run_id: parentRunId, sort_id: sortId,
            revises_run_id: null, queue_json: JSON.stringify(cards.map((card) => card.id)),
            round_number: roundNumber, keep_limit: body.keepLimit, revision: 0,
            keep_label: keepLabel, discard_label: discardLabel,
            cards_json: JSON.stringify(cards), rating_scale_json: JSON.stringify(roundPlan[roundNumber - 1]?.ratingScale ?? null),
            numeric_fields_json: parentRunId ? (getRun(db, parentRunId).numeric_fields_json || "[]") : (getCollection(db, collectionId).numeric_fields_json || "[]"),
            created_at: now, updated_at: now,
          };
          if (!parentRunId) db.prepare(`INSERT INTO sort_sessions (id, collection_id, rounds_json, revision, created_at, updated_at)
            VALUES (?, ?, ?, 0, ?, ?)`).run(sortId, collectionId, JSON.stringify(roundPlan), now, now);
          db.prepare(`INSERT INTO runs
            (id, collection_id, parent_run_id, sort_id, revises_run_id, queue_json, round_number, keep_limit, revision, keep_label,
             discard_label, cards_json, rating_scale_json, numeric_fields_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            row.id, row.collection_id, row.parent_run_id, row.sort_id, row.revises_run_id, row.queue_json, row.round_number, row.keep_limit,
            row.revision, row.keep_label, row.discard_label, row.cards_json, row.rating_scale_json, row.numeric_fields_json, row.created_at, row.updated_at,
          );
          return runDto(db, row);
        });
        sendJson(res, 201, { run });
        return;
      }

      if (segments.length === 3 && segments[1] === "runs" && method === "GET") {
        sendJson(res, 200, { run: runDto(db, getRun(db, segments[2])) });
        return;
      }

      if (segments.length === 4 && segments[1] === "runs" && segments[3] === "plan" && method === "PATCH") {
        const body = await readJson(req);
        const result = transaction(db, () => {
          const current = getRun(db, segments[2]);
          const sort = db.prepare("SELECT * FROM sort_sessions WHERE id = ?").get(current.sort_id);
          if (!sort) fail(404, "not_found", "Sort session not found.");
          if (!Number.isInteger(body.expectedPlanRevision) || body.expectedPlanRevision < 0) fail(400, "invalid_input", "expectedPlanRevision must be a non-negative integer.");
          if (body.expectedPlanRevision !== sort.revision) fail(409, "revision_conflict", "The round plan changed in another tab or device. Reload it before saving.");
          const plan = validateRoundPlan(body.rounds, fail);
          const started = db.prepare("SELECT round_number, MAX(keep_limit) AS keep_limit, rating_scale_json FROM runs WHERE sort_id = ? GROUP BY round_number").all(sort.id);
          const startedCount = started.reduce((count, row) => Math.max(count, row.round_number), 0);
          if (plan.length < startedCount) fail(400, "invalid_round_plan", `The plan must keep its ${startedCount} started rounds.`);
          for (const round of started) {
            const original = round.rating_scale_json ? JSON.parse(round.rating_scale_json) : null;
            if (!sameNumericScale(plan[round.round_number - 1]?.ratingScale ?? null, original)) fail(400, "invalid_round_plan", `The type and scale for started ${plan[round.round_number - 1]?.title || "round"} cannot be changed.`);
            plan[round.round_number - 1] = { ...plan[round.round_number - 1], keepLimit: original ? null : round.keep_limit, ...(original ? { ratingScale: original } : {}) };
          }
          const now = new Date().toISOString();
          const changed = db.prepare("UPDATE sort_sessions SET rounds_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
            .run(JSON.stringify(plan), now, sort.id, sort.revision);
          if (changed.changes !== 1) fail(409, "revision_conflict", "The round plan changed in another tab or device. Reload it before saving.");
          return runDto(db, getRun(db, current.id));
        });
        sendJson(res, 200, { run: result });
        return;
      }

      if (segments.length === 4 && segments[1] === "runs" && segments[3] === "skip" && method === "POST") {
        const body = await readJson(req);
        const result = transaction(db, () => {
          const current = getRun(db, segments[2]);
          requireRevision(body, current);
          const dto = runDto(db, current);
          if (dto.status === "complete") fail(409, "run_complete", "This sort is complete.");
          const cardId = cleanText(body.cardId, "Card ID", 80);
          if (!dto.cards.some((card) => card.id === cardId) || dto.decisions.some((decision) => decision.cardId === cardId && !decision.undoneAt)) {
            fail(400, "card_already_sorted", "That card is not waiting to be sorted.");
          }
          if (dto.queue.length > 1) {
            const queue = dto.queue.filter((id) => id !== cardId);
            queue.push(cardId);
            const now = new Date().toISOString();
            db.prepare("UPDATE runs SET queue_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
              .run(JSON.stringify(queue), now, current.id, current.revision);
          }
          return runDto(db, getRun(db, current.id));
        });
        sendJson(res, 200, { run: result });
        return;
      }

      if (segments.length === 4 && segments[1] === "runs" && segments[3] === "revise" && method === "POST") {
        const body = await readJson(req);
        const now = new Date().toISOString();
        const result = transaction(db, () => {
          const current = getRun(db, segments[2]);
          requireRevision(body, current);
          const scale = current.rating_scale_json ? JSON.parse(current.rating_scale_json) : null;
          const isRating = body.choice === "rating";
          if (isRating !== Boolean(scale) || (!isRating && !["keep", "discard"].includes(body.choice))) fail(400, "invalid_choice", "Choose a value for a rating round, or Keep/Let go for a choice round.");
          if (isRating) cleanRatingValue(body.value, scale);
          const dto = runDto(db, current);
          const cardId = cleanText(body.cardId, "Card ID", 80);
          if (!dto.cards.some((card) => card.id === cardId)) fail(404, "not_found", "Card not found in this sort.");
          const decision = dto.decisions.find((entry) => entry.cardId === cardId && !entry.undoneAt);
          if (!decision) fail(409, "card_not_decided", "That card has no answer to revise.");
          const existingIsRating = decision.choice === "rating";
          if (existingIsRating !== isRating) fail(400, "invalid_choice", "An answer must match this round's type.");
          const activeKeeps = dto.keptCount - (decision.choice === "keep" ? 1 : 0) + (body.choice === "keep" ? 1 : 0);
          if (!isRating && activeKeeps > current.keep_limit) fail(409, "keep_limit_reached", "The maximum keeps for this round has been reached.");
          const hasChildren = Boolean(db.prepare("SELECT 1 FROM runs WHERE parent_run_id = ? LIMIT 1").get(current.id));
          if (!hasChildren) {
            db.prepare("UPDATE sort_answers SET undone_at = ? WHERE id = ? AND run_id = ? AND undone_at IS NULL").run(now, decision.id, current.id);
            const position = db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM sort_answers WHERE run_id = ?").get(current.id).next;
            db.prepare(`INSERT INTO sort_answers (id, run_id, card_id, choice, rating_value, position, created_at, replaces_decision_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), current.id, cardId, body.choice, isRating ? body.value : null, position, now, decision.id);
            db.prepare("UPDATE runs SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?").run(now, current.id, current.revision);
            return runDto(db, getRun(db, current.id));
          }
          const sort = db.prepare("SELECT * FROM sort_sessions WHERE id = ?").get(current.sort_id);
          const newSortId = randomUUID();
          const newRunId = randomUUID();
          db.prepare(`INSERT INTO sort_sessions (id, collection_id, rounds_json, revision, created_at, updated_at)
            VALUES (?, ?, ?, 0, ?, ?)`).run(newSortId, current.collection_id, sort.rounds_json, now, now);
          const row = { ...current, id: newRunId, sort_id: newSortId, revises_run_id: current.id, revision: 0, created_at: now, updated_at: now };
          db.prepare(`INSERT INTO runs (id, collection_id, parent_run_id, sort_id, revises_run_id, queue_json,
            round_number, keep_limit, revision, keep_label, discard_label, cards_json, rating_scale_json, numeric_fields_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            row.id, row.collection_id, row.parent_run_id, row.sort_id, row.revises_run_id, row.queue_json,
            row.round_number, row.keep_limit, row.revision, row.keep_label, row.discard_label,
            row.cards_json, row.rating_scale_json, row.numeric_fields_json, row.created_at, row.updated_at,
          );
          const idMap = new Map();
          for (const entry of dto.decisions) idMap.set(entry.id, randomUUID());
          const oldRows = db.prepare("SELECT * FROM sort_answers WHERE run_id = ? ORDER BY position").all(current.id);
          for (const old of oldRows) {
            const isTarget = old.id === decision.id;
            db.prepare(`INSERT INTO sort_answers (id, run_id, card_id, choice, rating_value, position, created_at, undone_at, replaces_decision_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(idMap.get(old.id), newRunId, old.card_id, old.choice, old.rating_value,
              old.position, old.created_at, isTarget ? now : old.undone_at,
              old.replaces_decision_id ? idMap.get(old.replaces_decision_id) || null : null);
          }
          const position = db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM sort_answers WHERE run_id = ?").get(newRunId).next;
          db.prepare(`INSERT INTO sort_answers (id, run_id, card_id, choice, rating_value, position, created_at, replaces_decision_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), newRunId, cardId, body.choice, isRating ? body.value : null, position, now, idMap.get(decision.id));
          return runDto(db, getRun(db, newRunId));
        });
        sendJson(res, 200, { run: result });
        return;
      }

      if (segments.length === 4 && segments[1] === "runs" && segments[3] === "decisions" && method === "POST") {
        const body = await readJson(req);
        const now = new Date().toISOString();
        const run = transaction(db, () => {
          const current = getRun(db, segments[2]);
          requireRevision(body, current);
          const dto = runDto(db, current);
          if (dto.status === "complete") fail(409, "run_complete", "This sort is complete.");
          const cardId = cleanText(body.cardId, "Card ID", 80);
          const card = dto.cards.find((entry) => entry.id === cardId);
          if (!card || dto.decisions.some((decision) => decision.cardId === cardId && !decision.undoneAt)) {
            fail(400, "card_already_sorted", "That card is not waiting to be sorted.");
          }
          const scale = current.rating_scale_json ? JSON.parse(current.rating_scale_json) : null;
          const isRating = body.choice === "rating";
          if (isRating !== Boolean(scale) || (!isRating && !["keep", "discard"].includes(body.choice))) fail(400, "invalid_choice", "Choose a value for a rating round, or Keep/Let go for a choice round.");
          if (isRating) cleanRatingValue(body.value, scale);
          if (!isRating && body.choice === "keep" && dto.keptCount >= current.keep_limit) {
            fail(409, "keep_limit_reached", "The maximum keeps for this round has been reached.");
          }
          const position = db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM sort_answers WHERE run_id = ?").get(current.id).next;
          db.prepare(`INSERT INTO sort_answers (id, run_id, card_id, choice, rating_value, position, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), current.id, cardId, body.choice, isRating ? body.value : null, position, now);
          const queue = dto.queue.filter((id) => id !== cardId);
          db.prepare("UPDATE runs SET queue_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(queue), now, current.id);
          return runDto(db, getRun(db, current.id));
        });
        sendJson(res, 200, { run });
        return;
      }

      if (segments.length === 4 && segments[1] === "runs" && segments[3] === "undo" && method === "POST") {
        const body = await readJson(req);
        const now = new Date().toISOString();
        const run = transaction(db, () => {
          const current = getRun(db, segments[2]);
          requireRevision(body, current);
          if (db.prepare("SELECT 1 FROM runs WHERE parent_run_id = ? LIMIT 1").get(current.id)) {
            fail(409, "run_has_later_results", "This round has later results. Revise an answer to start a new path.");
          }
          const decision = db.prepare(`SELECT * FROM sort_answers WHERE run_id = ? AND undone_at IS NULL
            ORDER BY position DESC LIMIT 1`).get(current.id);
          if (!decision) fail(409, "nothing_to_undo", "There is no decision to undo.");
          const undone = db.prepare("UPDATE sort_answers SET undone_at = ? WHERE id = ? AND run_id = ? AND undone_at IS NULL").run(now, decision.id, current.id);
          if (undone.changes !== 1) fail(409, "revision_conflict", "This sort changed in another tab or device. Reload it before continuing.");
          if (decision.replaces_decision_id) {
            const restored = db.prepare("UPDATE sort_answers SET undone_at = NULL WHERE id = ? AND run_id = ? AND undone_at IS NOT NULL")
              .run(decision.replaces_decision_id, current.id);
            if (restored.changes !== 1) fail(409, "revision_conflict", "The answer this revision replaced is no longer available.");
          }
          const dto = runDto(db, current);
          const queue = dto.queue.filter((id) => id !== decision.card_id);
          if (!decision.replaces_decision_id) queue.unshift(decision.card_id);
          db.prepare("UPDATE runs SET queue_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(queue), now, current.id);
          return runDto(db, getRun(db, current.id));
        });
        sendJson(res, 200, { run });
        return;
      }

      sendJson(res, 404, { error: { code: "not_found", message: "API endpoint not found." } });
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      } else if (error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        sendJson(res, 409, { error: { code: "duplicate", message: "That ID already exists." } });
      } else if (error instanceof TransferValidationError) {
        sendJson(res, 400, { error: { code: "invalid_transfer", message: error.message } });
      } else {
        console.error("Request failed:", error?.message || "unknown error");
        sendJson(res, 500, { error: { code: "server_error", message: "The request could not be completed." } });
      }
    }
  });

  server.on("close", () => db.close());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (trustProxy) {
    const publicOrigin = process.env.SIFT_PUBLIC_ORIGIN;
    if (!publicOrigin) throw new Error("Set SIFT_PUBLIC_ORIGIN when proxy-protected mode is enabled.");
    const parsedOrigin = new URL(publicOrigin);
    if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== publicOrigin) {
      throw new Error("SIFT_PUBLIC_ORIGIN must be an exact HTTPS origin without a path.");
    }
  }
  const server = createAppServer();
  const host = trustProxy ? "0.0.0.0" : "127.0.0.1";
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid port number.");
  }
  server.listen(port, host, () => {
    console.log(`Sift listening on ${host}:${port} (${trustProxy ? "proxy-protected mode: ensure direct access is blocked" : "loopback-only mode"})`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}
