const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 2e4;
const MAX_COLLECTIONS = 100;
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const KINDS = /* @__PURE__ */ new Set(["collectionRevision", "cardRevision", "sortSession", "sortAction"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export class TransferValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransferValidationError";
  }
}
function fail(message) {
  throw new TransferValidationError(message);
}
function uuid(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) fail(`${label} must be a UUID.`);
  const normalized = value.toUpperCase();
  if (!UUID.test(normalized)) fail(`${label} must be a UUID.`);
  return normalized;
}
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  if (typeof value === "number" && !Number.isFinite(value)) fail("Transfer contains a non-finite number.");
  return value;
}
const graphemeCount = (text) => typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter(void 0, { granularity: "grapheme" }).segment(text)].length : [...text].length;
function validText(value, max, label, { allowEmpty = false, trim = true } = {}) {
  if (typeof value !== "string") fail(`${label} must be text.`);
  const count = graphemeCount(trim ? value.trim() : value);
  if (count > max || !allowEmpty && count === 0) fail(`${label} must contain ${allowEmpty ? "at most" : "1 to"} ${max} characters.`);
}
function validRoundPlan(plan) {
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 50) fail("A sort must have between 1 and 50 rounds.");
  for (const [index, round] of plan.entries()) {
    uuid(round?.id, `Round ${index + 1} id`);
    validText(round.title, 60, `Round ${index + 1} title`);
    if (round.keepLimit != null && (!Number.isInteger(round.keepLimit) || round.keepLimit < 1 || round.keepLimit > 500)) fail("Round keep limits must be from 1 to 500.");
    if (round.ratingScale != null) {
      const error = validateNumericScale(round.ratingScale);
      if (error) fail(error);
      if (round.keepLimit != null) fail("Rating rounds cannot have a keep limit.");
    }
  }
}
function stableJSON(value) {
  return JSON.stringify(sorted(value));
}
function decodePayload(base64) {
  if (typeof base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) fail("Record payload must be valid base64.");
  let bytes;
  try {
    bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    fail("Record payload must be valid base64.");
  }
  let payload;
  try {
    payload = JSON.parse(decoder.decode(bytes));
  } catch {
    fail("Record payload must contain UTF-8 JSON.");
  }
  return payload;
}
function encodePayload(payload) {
  const bytes = encoder.encode(stableJSON(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function sha256(input) {
  const K = [1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298];
  const data = [...encoder.encode(input)], bitLength = data.length * 8;
  data.push(128);
  while (data.length % 64 !== 56) data.push(0);
  for (let i = 7; i >= 0; i--) data.push(i < 4 ? bitLength >>> i * 8 & 255 : 0);
  const H = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225], rotr = (x, n) => x >>> n | x << 32 - n;
  for (let offset = 0; offset < data.length; offset += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i++) w[i] = (data[offset + i * 4] << 24 | data[offset + i * 4 + 1] << 16 | data[offset + i * 4 + 2] << 8 | data[offset + i * 4 + 3]) >>> 0;
    for (let i = 16; i < 64; i++) {
      const a2 = w[i - 15], b2 = w[i - 2], s0 = rotr(a2, 7) ^ rotr(a2, 18) ^ a2 >>> 3, s1 = rotr(b2, 17) ^ rotr(b2, 19) ^ b2 >>> 10;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = e & f ^ ~e & g, t1 = h + s1 + ch + K[i] + w[i] >>> 0, s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = a & b ^ a & c ^ b & c, t2 = s0 + maj >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => H[i] = H[i] + v >>> 0);
  }
  return H.map((v) => v.toString(16).padStart(8, "0")).join("");
}
function uuidFromText(text) {
  const hex = sha256(text).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = (parseInt(hex[16], 16) & 3 | 8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`.toUpperCase();
}
const dateISO = (value, label) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail(`${label} must be an ISO-8601 date.`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail(`${label} must be an ISO-8601 date.`);
  return new Date(Math.round(time)).toISOString();
};
const dateMillis = (value, label) => Date.parse(dateISO(value, label));
const webCollectionID = (value) => /^[0-9a-f-]{36}$/i.test(String(value)) ? uuid(value, "Collection id") : uuidFromText(`sift-web-collection-v1|${value}`);
// Interpret UUIDs like Swift's UUID decoder, without rewriting original payload bytes.
function recordPayload(record) {
  const p = decodePayload(record.payload);
  const fields = (object, names) => {
    if (!object || typeof object !== "object") return;
    for (const name of names) if (typeof object[name] === "string") object[name] = object[name].toUpperCase();
  };
  const refs = (values) => { if (Array.isArray(values)) for (const value of values) fields(value,["cardID","revisionID"]); };
  const plan = (values) => { if (Array.isArray(values)) for (const value of values) fields(value,["id"]); };
  fields(p, { collectionRevision:["id","collectionID","parentRevisionID"], cardRevision:["revisionID","cardID","collectionRevisionID"], sortSession:["id","collectionID","collectionRevisionID"], sortAction:["id","sessionID","branchID","parentActionID"] }[record.kind] ?? []);
  if (record.kind === "collectionRevision" || record.kind === "sortSession") refs(p?.cards);
  if (record.kind === "sortSession") { plan(p?.roundPlan); for (const field of p?.numericFields ?? []) fields(field, ["id"]); }
  if (record.kind === "collectionRevision") for (const field of p?.numericFields ?? []) fields(field, ["id"]);
  if (record.kind === "cardRevision" && p?.numericValues && typeof p.numericValues === "object" && !Array.isArray(p.numericValues)) {
    const normalized = {};
    for (const [id, value] of Object.entries(p.numericValues)) {
      const key = uuid(id, "Numeric value field id");
      if (Object.hasOwn(normalized, key)) fail("Card values cannot repeat a numeric field ID.");
      normalized[key] = value;
    }
    p.numericValues = normalized;
  }
  if (record.kind === "sortAction" && p?.operation && typeof p.operation === "object") {
    const [kind] = Object.keys(p.operation), operation = p.operation[kind];
    fields(operation,["cardID","targetActionID","sourceHeadID"]);
    if (Array.isArray(operation?.cardIDs)) operation.cardIDs = operation.cardIDs.map((id) => typeof id === "string" ? id.toUpperCase() : id);
    if (kind === "decided" || kind === "revisedPath") fields(operation?._0,["id","cardID","replacesActionID"]);
    if (kind === "planEdited") plan(operation?._0);
  }
  return p;
}

function preservedBundles(records) {
  const payloads = records.map((record) => ({ record, payload: recordPayload(record) }));
  const revisionOwners = new Map(payloads.filter((x) => x.record.kind === "collectionRevision").map((x) => [x.payload.id, x.payload.collectionID]));
  const sessionOwners = new Map(payloads.filter((x) => x.record.kind === "sortSession").map((x) => [x.payload.id, x.payload.collectionID]));
  const byCollection = /* @__PURE__ */ new Map();
  for (const { record, payload } of payloads) {
    let owner;
    if (record.kind === "collectionRevision" || record.kind === "sortSession") owner = payload.collectionID;
    else if (record.kind === "cardRevision") owner = revisionOwners.get(payload.collectionRevisionID);
    else owner = sessionOwners.get(payload.sessionID);
    if (!owner) fail(`Cannot locate collection dependency for preserved record ${record.id}.`);
    const list = byCollection.get(owner) ?? [];
    list.push(record);
    byCollection.set(owner, list);
  }
  return byCollection;
}
export function validateTransfer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Transfer must be an object.");
  if (encoder.encode(JSON.stringify(value)).length > MAX_BYTES) fail(`Transfer exceeds ${MAX_BYTES} bytes.`);
  if (value.format !== "sift" || ![1, 2].includes(value.version)) fail("Unsupported transfer format or version.");
  const exportedAt = dateISO(value.exportedAt, "exportedAt");
  if (!Array.isArray(value.collections) || value.collections.length > MAX_COLLECTIONS) fail(`Transfer must contain at most ${MAX_COLLECTIONS} collection bundles.`);
  const seenGlobal = /* @__PURE__ */ new Map();
  let recordCount = 0;
  const bundleIDs = /* @__PURE__ */ new Set();
  const collections = value.collections.map((bundle) => {
    const id = uuid(bundle?.id, "Collection bundle id");
    if (bundleIDs.has(id)) fail(`Duplicate collection bundle ${id}.`);
    bundleIDs.add(id);
    if (!Array.isArray(bundle.records) || bundle.records.length === 0) fail(`Collection ${id} has no records.`);
    recordCount += bundle.records.length;
    const local = /* @__PURE__ */ new Map();
    const records = bundle.records.map((source) => {
      if (!source || typeof source !== "object") fail("Invalid domain record.");
      const kind = source.kind;
      if (!KINDS.has(kind) || ![1, 2].includes(source.version) || (value.version === 1 && source.version !== 1)) fail("Unsupported domain record kind or version.");
      const normalized = { id: uuid(source.id, "Record id"), kind, version: source.version, ownerID: uuid(source.ownerID, "Record ownerID"), logicalID: uuid(source.logicalID, "Record logicalID"), payload: source.payload };
      const payload = recordPayload(normalized);
      const canonical = stableJSON(normalized);
      const duplicate = local.get(normalized.id) || seenGlobal.get(normalized.id);
      if (duplicate) fail(`Duplicate record id ${normalized.id}.`);
      local.set(normalized.id, canonical);
      local.set(`${normalized.id}:record`, normalized);
      seenGlobal.set(normalized.id, canonical);
      checkPayload(normalized, payload);
      return normalized;
    });
    if (recordCount > MAX_RECORDS) fail(`Transfer exceeds ${MAX_RECORDS} records.`);
    validateBundle(id, records);
    return { id, records };
  });
  const archive = { format: "sift", version: value.version, exportedAt, collections };
  if (encoder.encode(stableJSON(archive)).length > MAX_BYTES) fail(`Transfer exceeds ${MAX_BYTES} bytes.`);
  return archive;
}
function checkPayload(record, p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) fail("Record payload must be an object.");
  const required = { collectionRevision: ["id", "collectionID"], cardRevision: ["revisionID", "cardID", "collectionRevisionID"], sortSession: ["id", "collectionID", "collectionRevisionID"], sortAction: ["id", "sessionID", "branchID"] };
  for (const key2 of required[record.kind]) uuid(p[key2], `${record.kind}.${key2}`);
  for (const key2 of ["parentRevisionID", "parentActionID"]) if (p[key2] != null) uuid(p[key2], key2);
  const hasNumericPayload = (record.kind === "collectionRevision" && (p.numericFields?.length > 0))
    || (record.kind === "cardRevision" && Object.keys(p.numericValues ?? {}).length > 0)
    || (record.kind === "sortSession" && (p.numericFields?.length > 0 || p.roundPlan?.some((round) => round.ratingScale)))
    || (record.kind === "sortAction" && p.operation && Object.values(p.operation).some((op) => op?._0?.choice === "rating"
      || op?._0?.ratingScale || (Array.isArray(op?._0) && op._0.some((round) => round?.ratingScale))));
  if (record.version === 1 && hasNumericPayload) fail("Numeric rating data requires transfer record version 2.");
  if (record.version === 2 && !hasNumericPayload && record.kind === "sortAction" && p.schemaVersion !== 2) fail("Version 2 action payload is malformed.");
  if (record.kind === "collectionRevision" || record.kind === "sortSession") {
    if (!Array.isArray(p.cards)) fail("Card references must be an array.");
    for (const ref of p.cards) {
      uuid(ref?.cardID, "cardID");
      uuid(ref?.revisionID, "revisionID");
    }
  }
  if (record.kind === "collectionRevision") {
    const error = validateNumericFields(p.numericFields ?? []);
    if (error) fail(error);
  }
  if (record.kind === "cardRevision") {
    if (!p.numericValues && record.version >= 2) p.numericValues = {};
    if (p.numericValues !== undefined && (!p.numericValues || typeof p.numericValues !== "object" || Array.isArray(p.numericValues))) fail("Card numeric values must be an object.");
    for (const [id, value] of Object.entries(p.numericValues ?? {})) uuid(id, "Numeric value field id");
  }
  if (record.kind === "sortSession") {
    const error = validateNumericFields(p.numericFields ?? []);
    if (error) fail(error);
  }
  if (record.kind === "sortSession") {
    validRoundPlan(p.roundPlan);
    if (!Number.isFinite(p.createdAt)) fail("Sort session timestamp is invalid.");
  }
  if (record.kind !== "sortAction") return;
  if (![1, 2].includes(p.schemaVersion) || ![1, 2].includes(p.rulesVersion) || !Number.isFinite(p.recordedAt) || record.version !== p.schemaVersion || p.schemaVersion !== p.rulesVersion) fail("Sort action version or timestamp is invalid.");
  if (!p.operation || typeof p.operation !== "object" || Object.keys(p.operation).length !== 1) fail("Sort action operation is malformed.");
  const [key] = Object.keys(p.operation), op = p.operation[key];
  if (!op || typeof op !== "object") fail("Sort action operation is malformed.");
  if (!["started", "decided", "revisedPath", "skipped", "undone", "planEdited", "roundStarted"].includes(key)) fail(`Unsupported sort action operation ${key}.`);
  if (["started", "skipped", "roundStarted"].includes(key) && !Number.isInteger(op.roundNumber)) fail("Operation round number is invalid.");
  if (key === "decided" || key === "revisedPath") {
    const d = op._0;
    uuid(d?.id, "Decision id");
    uuid(d?.cardID, "Decision cardID");
    if (d.replacesActionID != null) uuid(d.replacesActionID, "Decision replacement");
    if (!(["keep", "discard"].includes(d.choice) && d.value == null) && !(d.choice === "rating" && Number.isFinite(d.value))) fail("Decision action is malformed.");
    if (!Number.isInteger(d.roundNumber)) fail("Decision action is malformed.");
  }
  if (key === "revisedPath" || key === "roundStarted") {
    if (!Array.isArray(op.cardIDs)) fail("Operation card IDs must be an array.");
    op.cardIDs.forEach((id) => uuid(id, "Operation card id"));
  }
  if (key === "revisedPath") {
    uuid(op.sourceHeadID, "Source head");
    if (!Number.isInteger(op.reviewedRound)) fail("Reviewed round is invalid.");
  }
  if (key === "skipped") uuid(op.cardID, "Skipped card");
  if (key === "undone") uuid(op.targetActionID, "Undo target");
  if (key === "planEdited") validRoundPlan(op._0);
  if (key === "roundStarted" && (!Number.isInteger(op.keepLimit) || op.proposedKeepLimit != null && !Number.isInteger(op.proposedKeepLimit))) fail("Round start keep limit is invalid.");
}
function validateBundle(bundleID, records) {
  const byID = new Map(records.map((r) => [r.id, { record: r, payload: recordPayload(r) }]));
  const has = (id, kind) => {
    const e = byID.get(id);
    if (!e || e.record.kind !== kind) fail(`Collection ${bundleID} is missing dependency ${id}.`);
    return e.payload;
  };
  const revisions = records.filter((r) => r.kind === "collectionRevision").map(recordPayload);
  if (!revisions.length) fail("Collection bundle has no collection revisions.");
  for (const { record: r, payload: p } of byID.values()) {
    if (r.kind === "collectionRevision") {
      if (r.logicalID !== bundleID || r.ownerID !== bundleID || p.id !== r.id || p.collectionID !== bundleID) fail("Collection revision identity does not match its bundle.");
      validText(p.title, 100, "Collection title");
      validText(p.description, 500, "Collection description", { allowEmpty: true, trim: false });
      validText(p.choiceLabels?.keep, 36, "Keep label");
      validText(p.choiceLabels?.discard, 36, "Discard label");
      const numericError = validateNumericFields(p.numericFields ?? []);
      if (numericError) fail(numericError);
      if (p.cards.length < 2 || p.cards.length > 500 || new Set(p.cards.map((x) => x.cardID)).size !== p.cards.length) fail("Collection has an invalid or duplicate card list.");
      let cursor = p;
      const seen = /* @__PURE__ */ new Set();
      while (cursor) {
        if (seen.has(cursor.id)) fail("Collection revision cycle.");
        seen.add(cursor.id);
        cursor = cursor.parentRevisionID ? has(cursor.parentRevisionID, "collectionRevision") : null;
      }
      for (const ref of p.cards) {
        const c = has(ref.revisionID, "cardRevision");
        if (c.cardID !== ref.cardID || c.collectionRevisionID !== p.id) fail("Collection card reference is inconsistent.");
        const values = c.numericValues ?? {};
        const valuesError = validateNumericFields(p.numericFields ?? [], [{ numericValues: values }]);
        if (valuesError) fail(valuesError);
      }
    } else if (r.kind === "cardRevision") {
      if (r.logicalID !== p.cardID || r.ownerID !== p.collectionRevisionID || r.id !== p.revisionID) fail("Card revision identity is inconsistent.");
      const revision = has(p.collectionRevisionID, "collectionRevision");
      validText(p.title, 120, "Card title");
      validText(p.detail, 500, "Card detail", { allowEmpty: true, trim: false });
      const valuesError = validateNumericFields(revision.numericFields ?? [], [{ numericValues: p.numericValues ?? {} }]);
      if (valuesError) fail(valuesError);
      for (const values of [p.pros, p.cons]) {
        if (!Array.isArray(values) || values.length > 10) fail("Card context list is invalid.");
        for (const item of values) validText(item, 200, "Card context", { allowEmpty: true, trim: false });
      }
    } else if (r.kind === "sortSession") {
      if (r.logicalID !== r.id || r.ownerID !== bundleID || p.id !== r.id || p.collectionID !== bundleID) fail("Sort session identity is inconsistent.");
      const revision = has(p.collectionRevisionID, "collectionRevision");
      if (stableJSON(p.cards) !== stableJSON(revision.cards) || p.titleSnapshot !== revision.title || p.descriptionSnapshot !== revision.description || stableJSON(p.choiceLabels) !== stableJSON(revision.choiceLabels)) fail("Sort session snapshot is inconsistent with its collection revision.");
      if (stableJSON(p.numericFields ?? []) !== stableJSON(revision.numericFields ?? [])) fail("Sort session numeric field snapshot is inconsistent with its collection revision.");
      if (p.roundPlan[0].keepLimit != null && p.roundPlan[0].keepLimit > p.cards.length) fail("Round 1 keep limit exceeds card count.");
    } else {
      const session = has(p.sessionID, "sortSession");
      if (r.id !== p.id || r.logicalID !== p.sessionID || r.ownerID !== p.sessionID || session.collectionID !== bundleID) fail("Sort action identity is inconsistent.");
      if (p.parentActionID && has(p.parentActionID, "sortAction").sessionID !== p.sessionID) fail("Action parent belongs to another session.");
    }
  }
  for (const r of records.filter((r2) => r2.kind === "sortSession")) {
    const session = recordPayload(r), actions = new Map(records.filter((x) => x.kind === "sortAction" && x.ownerID === r.id).map((x) => [x.id, recordPayload(x)]));
    const leaves = actionLeaves(actions);
    if (!leaves.length) fail("Sort session has no complete action path.");
    // Every component must reach a valid leaf path. A disconnected cycle has no leaf.
    const covered = new Set();
    for (const action of leaves) {
      const state = replayPath(session, actions, action.id);
      for (const ancestor of state.path) covered.add(ancestor.id);
    }
    if (covered.size !== actions.size) fail("Sort action graph contains an unreachable cycle or orphan component.");
  }
}
function actionLeaves(actions) {
  const parents = new Set([...actions.values()].filter((a) => a.parentActionID).map((a) => `${a.parentActionID}|${a.branchID}`));
  return [...actions.values()].filter((a) => !parents.has(`${a.id}|${a.branchID}`)).sort((a, b) => a.id.localeCompare(b.id));
}
function replayPath(session, actions, headID) {
  const path = [], seen = /* @__PURE__ */ new Set();
  let cursor = headID;
  while (cursor) {
    if (seen.has(cursor) || !actions.has(cursor)) fail("Sort action graph contains a cycle or missing parent.");
    seen.add(cursor);
    const a = actions.get(cursor);
    if (a.sessionID !== session.id) fail("Action belongs to another session.");
    path.push(a);
    cursor = a.parentActionID;
  }
  path.reverse();
  const state = { plan: structuredClone(session.roundPlan), activeRound: 0, rounds: /* @__PURE__ */ new Map(), undone: /* @__PURE__ */ new Set(), path, headID };
  const decisionIDs = /* @__PURE__ */ new Set(), branches = /* @__PURE__ */ new Set();
  const invalid = () => fail(`Invalid sort action graph at ${headID}.`);
  const effective = (number) => {
    const out = /* @__PURE__ */ new Map();
    for (const e of state.rounds.get(number)?.events ?? []) if (!state.undone.has(e.action.id)) out.set(e.d.cardID, e);
    return out;
  };
  const decide = (a, d, number) => {
    const round = state.rounds.get(number), current = effective(number), old = current.get(d.cardID);
    if (d.roundNumber !== number || !round?.ids.includes(d.cardID) || decisionIDs.has(d.id)) invalid();
    decisionIDs.add(d.id);
    if (d.replacesActionID ? old?.action.id !== d.replacesActionID : old != null) invalid();
    const isRating = Boolean(round.ratingScale);
    if (isRating !== (d.choice === "rating") || (isRating ? numericValueError(d.value, round.ratingScale) !== "" : d.value != null)) invalid();
    const kept = [...current.values()].filter((e) => e.d.choice === "keep").length - (old?.d.choice === "keep" ? 1 : 0);
    if (!isRating && d.choice === "keep" && kept >= round.cap) fail("Sort keep limit exceeded.");
    round.events.push({ action: a, d });
  };
  for (let i = 0; i < path.length; i++) {
    const a = path[i], [kind] = Object.keys(a.operation), op = a.operation[kind], parent = path[i - 1];
    if (i === 0 ? a.branchID !== session.id : kind === "revisedPath" ? a.branchID === parent.branchID || branches.has(a.branchID) : a.branchID !== parent.branchID) invalid();
    branches.add(a.branchID);
    if (kind === "started") {
      if (i !== 0 || op.roundNumber !== 1 || state.activeRound !== 0) invalid();
      state.activeRound = 1;
      state.rounds.set(1, { ids: session.cards.map((x) => x.cardID), cap: state.plan[0].ratingScale ? session.cards.length : state.plan[0].keepLimit ?? Infinity, ratingScale: state.plan[0].ratingScale ?? null, events: [], skips: [] });
    } else if (kind === "decided") decide(a, op._0, state.activeRound);
    else if (kind === "revisedPath") {
      const n = op.reviewedRound, round = state.rounds.get(n), target = effective(n).get(op._0.cardID);
      if (a.parentActionID !== op.sourceHeadID || !seen.has(op.sourceHeadID) || state.activeRound <= n || n < 1 || target?.action.id !== op._0.replacesActionID || stableJSON(round?.ids) !== stableJSON(op.cardIDs) || target.action.branchID === a.branchID) invalid();
      decide(a, op._0, n);
      for (const number of state.rounds.keys()) if (number > n) state.rounds.delete(number);
      state.activeRound = n;
    } else if (kind === "skipped") {
      if (op.roundNumber !== state.activeRound || !state.rounds.get(op.roundNumber)?.ids.includes(op.cardID) || effective(op.roundNumber).has(op.cardID)) invalid();
      state.rounds.get(op.roundNumber).skips.push(op.cardID);
    } else if (kind === "undone") {
      const events = state.rounds.get(state.activeRound)?.events ?? [], latest = events.filter((e) => !state.undone.has(e.action.id)).at(-1);
      if (!seen.has(op.targetActionID) || state.undone.has(op.targetActionID) || latest?.action.id !== op.targetActionID) invalid();
      state.undone.add(op.targetActionID);
    } else if (kind === "planEdited") {
      validRoundPlan(op._0);
      if (op._0.length < state.activeRound) invalid();
      for (let n = 0; n < state.activeRound; n++) if ((state.plan[n].keepLimit ?? null) !== (op._0[n].keepLimit ?? null) || stableJSON(state.plan[n].ratingScale ?? null) !== stableJSON(op._0[n].ratingScale ?? null)) invalid();
      state.plan = structuredClone(op._0);
    } else if (kind === "roundStarted") {
      const n = op.roundNumber, previous = state.rounds.get(state.activeRound), current = effective(state.activeRound);
      const incoming = previous?.ratingScale ? [...previous.ids] : previous?.ids.filter((id) => current.get(id)?.d.choice === "keep");
      const nextScale = state.plan[n - 1]?.ratingScale ?? null;
      if (n !== state.activeRound + 1 || !state.plan[n - 1] || previous.ids.some((id) => !current.has(id)) || incoming.length < 2 || stableJSON(incoming) !== stableJSON(op.cardIDs)) invalid();
      if (nextScale ? op.keepLimit !== incoming.length || op.proposedKeepLimit != null || state.plan[n - 1].keepLimit != null
        : op.keepLimit < 1 || op.keepLimit > incoming.length || (op.proposedKeepLimit != null ? op.proposedKeepLimit !== op.keepLimit : state.plan[n - 1].keepLimit !== op.keepLimit)) invalid();
      state.plan[n - 1] = { ...state.plan[n - 1], keepLimit: nextScale ? null : op.keepLimit };
      state.activeRound = n;
      state.rounds.set(n, { ids: op.cardIDs, cap: nextScale ? op.keepLimit : op.keepLimit, ratingScale: nextScale, events: [], skips: [] });
    } else invalid();
  }
  if (!state.activeRound) invalid();
  for (const [n, round] of state.rounds) {
    round.effective = effective(n);
    round.queue = round.ids.filter((id) => !round.effective.has(id));
    for (const id of round.skips) {
      const i = round.queue.indexOf(id);
      if (i >= 0) {
        round.queue.splice(i, 1);
        round.queue.push(id);
      }
    }
  }
  return state;
}
function domainRecord(id, kind, ownerID, logicalID, payload) {
  const hasData = kind === "collectionRevision" ? payload.numericFields?.length > 0
    : kind === "cardRevision" ? Object.keys(payload.numericValues ?? {}).length > 0
      : kind === "sortSession" ? payload.numericFields?.length > 0 || payload.roundPlan?.some((r) => r.ratingScale)
        : payload.schemaVersion >= 2;
  return { id, kind, version: hasData ? 2 : 1, ownerID, logicalID, payload: encodePayload(payload) };
}
const cardDTO = (card) => {
  const numericValues = {};
  for (const [id, value] of Object.entries(card.numericValues ?? {})) {
    const key = uuid(id, "Numeric value field id");
    if (Object.hasOwn(numericValues, key)) fail("Card values cannot repeat a numeric field ID.");
    numericValues[key] = value;
  }
  return { id: String(card.id), text: String(card.text ?? card.title ?? ""), detail: String(card.detail ?? card.description ?? ""), pros: card.pros ?? [], cons: card.cons ?? [], ...(Object.keys(numericValues).length ? { numericValues } : {}) };
};
const collectionDTO = (c) => ({ name: String(c.name ?? c.title ?? ""), description: String(c.description ?? ""), keepLabel: String(c.keepLabel ?? "Keep"), discardLabel: String(c.discardLabel ?? "Let go"), ...(c.numericFields?.length ? { numericFields: c.numericFields.map((field) => ({ ...field, id: uuid(field.id, "Numeric field id") })) } : {}), cards: (c.cards ?? []).map(cardDTO) });
const planDTO = (plan) => (plan ?? []).map((r) => ({ title: r.title, keepLimit: r.keepLimit ?? null, ...(r.ratingScale ? { ratingScale: r.ratingScale } : {}) }));
const runDTO = (r) => ({ cards: (r.cards ?? []).map(cardDTO), queue: r.queue ?? [], decisions: (r.decisions ?? []).map((d) => ({ id: d.id, cardId: d.cardId, choice: d.choice, ...(d.choice === "rating" ? { value: d.value } : {}), position: d.position, createdAt: d.createdAt, undoneAt: d.undoneAt ?? null, replacesDecisionId: d.replacesDecisionId ?? null })), roundNumber: r.roundNumber, roundPlan: planDTO(r.roundPlan), keepLimit: r.keepLimit ?? r.cards?.length ?? null, ...(r.ratingScale ? { ratingScale: r.ratingScale } : {}), ...(r.numericFields?.length ? { numericFields: r.numericFields } : {}) });
const projectionSortID = (sessionID, headID) => uuidFromText(`sift-web-projection-sort-v1|${sessionID}|${headID}`);
const projectionRunID = (sessionID, headID, round) => uuidFromText(`sift-web-projection-run-v1|${sessionID}|${headID}|${round}`);
const projectionDecisionID = (headID, round, actionID) => uuidFromText(`sift-web-projection-decision-v1|${headID}|${round}|${actionID}`);
function projectBundle(bundle) {
  const entries = new Map(bundle.records.map((r) => [r.id, { r, p: recordPayload(r) }]));
  const revisions = [...entries.values()].filter((e) => e.r.kind === "collectionRevision").map((e) => e.p);
  const parents = new Set(revisions.map((p) => p.parentRevisionID).filter(Boolean));
  const leaves = revisions.filter((p) => !parents.has(p.id)).sort((a, b) => a.id.localeCompare(b.id));
  const cardForRef = (ref) => {
    const c = entries.get(ref.revisionID).p;
    return { id: c.cardID, text: c.title, detail: c.detail, description: c.detail, pros: c.pros, cons: c.cons, ...(Object.keys(c.numericValues ?? {}).length ? { numericValues: c.numericValues } : {}) };
  };
  const versionID = (p) => p.id === leaves[0].id ? bundle.id : uuidFromText(`sift-web-collection-version-v1|${bundle.id}|${p.id}`);
  const asCollection = (p) => ({ id: versionID(p), transferBundleID:bundle.id, sourceRevisionID:p.id, name: p.title, description: p.description, keepLabel: p.choiceLabels.keep, discardLabel: p.choiceLabels.discard, numericFields: p.numericFields ?? [], cards: p.cards.map(cardForRef) });
  const collections = leaves.map(asCollection);
  const collectionAlternatives = collections.map((c) => ({ collectionId:c.id, revisionID:c.sourceRevisionID, ...c }));
  const revisionCollections = new Map(revisions.map((p) => [p.id,asCollection(p)]));
  const collectionForRevision = (id) => {
    const candidates = leaves.filter((leaf) => {
      let cursor = leaf;
      while (cursor) {
        if (cursor.id === id) return true;
        cursor = cursor.parentRevisionID ? entries.get(cursor.parentRevisionID)?.p : null;
      }
      return false;
    });
    return candidates.length === 1 ? versionID(candidates[0]) : collections[0].id;
  };
  const runs = [], contexts = /* @__PURE__ */ new Map(), sessionContexts = /* @__PURE__ */ new Map();
  for (const { r, p: session } of entries.values()) if (r.kind === "sortSession") {
    const actions = new Map([...entries.values()].filter((e) => e.r.kind === "sortAction" && e.p.sessionID === session.id).map((e) => [e.p.id, e.p]));
    const leafActions = actionLeaves(actions), byHead = /* @__PURE__ */ new Map();
    for (const leaf of leafActions) {
      const state = replayPath(session, actions, leaf.id), sortId = projectionSortID(session.id, leaf.id), rows = [], actionIDs = /* @__PURE__ */ new Map();
      let parentRunId = null;
      for (const [n, round] of state.rounds) {
        const ids = new Map(round.events.map((e) => [e.action.id, projectionDecisionID(leaf.id, n, e.action.id)]));
        const decisions = round.events.map(({ action, d }, index) => {
          const effective = round.effective.get(d.cardID)?.action.id === action.id;
          const undo = state.path.find((a) => a.operation.undone?.targetActionID === action.id);
          const replacement = round.events.find((e) => e.d.replacesActionID === action.id && !state.undone.has(e.action.id));
          const id2 = ids.get(action.id);
          actionIDs.set(id2, action.id);
          return { id: id2, cardId: d.cardID, choice: d.choice, ...(d.choice === "rating" ? { value: d.value } : {}), position: index + 1, createdAt: new Date(action.recordedAt).toISOString(), undoneAt: effective ? null : new Date(undo?.recordedAt ?? replacement?.action.recordedAt ?? leaf.recordedAt).toISOString(), replacesDecisionId: ids.get(d.replacesActionID) ?? null };
        });
        const cards = round.ids.map((id2) => cardForRef(session.cards.find((ref) => ref.cardID === id2))), id = projectionRunID(session.id, leaf.id, n);
        const row = { id, collectionId: collectionForRevision(session.collectionRevisionID), sortId, roundPlan: state.plan, roundNumber: n, roundTitle: state.plan[n - 1].title, keepLimit: round.ratingScale ? null : Number.isFinite(round.cap) ? round.cap : null, ratingScale: round.ratingScale, numericFields: session.numericFields ?? [], keepLabel: session.choiceLabels.keep, discardLabel: session.choiceLabels.discard, queue: round.queue, cards, decisions, createdAt: new Date(n === 1 ? session.createdAt : state.path.find((a) => a.operation.roundStarted?.roundNumber === n)?.recordedAt ?? session.createdAt).toISOString(), updatedAt: new Date(leaf.recordedAt).toISOString(), parentRunId, revisesRunId: null, hasLaterResults: n < state.activeRound, revision: 0, status: round.queue.length ? "in-progress" : "complete" };
        rows.push(row);
        runs.push(row);
        parentRunId = id;
      }
      const context = { session, actions, headID: leaf.id, state, rows, actionIDs };
      byHead.set(leaf.id, context);
      sessionContexts.set(sortId, context);
      for (const row of rows) contexts.set(row.id, context);
    }
    for (const context of byHead.values()) for (const action of context.state.path) {
      const revised = action.operation.revisedPath;
      if (!revised) continue;
      const source = byHead.get(revised.sourceHeadID);
      const row = context.rows.find((r2) => r2.roundNumber === revised.reviewedRound);
      if (row && source) row.revisesRunId = source.rows.find((r2) => r2.roundNumber === revised.reviewedRound)?.id ?? null;
    }
  }
  const ordered = [], pending = [...runs];
  while (pending.length) {
    const i = pending.findIndex((r) => (!r.parentRunId || ordered.some((p) => p.id === r.parentRunId)) && (!r.revisesRunId || ordered.some((p) => p.id === r.revisesRunId)));
    if (i < 0) fail("Projected runs contain a dependency cycle.");
    ordered.push(pending.splice(i, 1)[0]);
  }
  return { collections, collectionAlternatives, revisionCollections, runs: ordered, contexts, sessionContexts };
}
export function transferToWebWorkspace(value) {
  const archive = validateTransfer(value), collections = [], runs = [], records = [], collectionAlternatives = [];
  for (const bundle of archive.collections) {
    const p = projectBundle(bundle);
    collections.push(...p.collections);
    runs.push(...p.runs);
    collectionAlternatives.push(...p.collectionAlternatives);
    records.push(...bundle.records);
  }
  return { collections, runs, records, collectionAlternatives };
}
export function webWorkspaceToTransfer({ collections = [], runs = [], preservedRecords = [] } = {}, { exportedAt = (/* @__PURE__ */ new Date()).toISOString(), collectionId } = {}) {
  if (!Array.isArray(collections) || !Array.isArray(runs) || !Array.isArray(preservedRecords)) fail("Workspace collections, runs, and preservedRecords must be arrays.");
  const selected = collectionId ? collections.filter((c) => String(c.id) === String(collectionId)) : collections;
  if (collectionId && selected.length !== 1) fail("Requested collection was not found.");
  const bundleFor = (c) => c.transferBundleID ? uuid(c.transferBundleID,"Collection transferBundleID") : webCollectionID(c.id);
  const selectedIDs = new Set(selected.map(bundleFor));
  if (selectedIDs.size > MAX_COLLECTIONS) fail("Transfer exceeds 100 collections.");
  const viewsByBundle = new Map();
  for (const c of collections) {
    const id = bundleFor(c);
    if (!selectedIDs.has(id)) continue;
    const views = viewsByBundle.get(id) ?? [];
    views.push(c); viewsByBundle.set(id,views);
  }
  const retained = preservedBundles(preservedRecords), bundles = [];
  for (const [cid, views] of viewsByBundle) {
    const original = retained.get(cid) ?? [], records = new Map(original.map((r) => [r.id, r]));
    let baseline = null;
    if (original.length) {
      const archive = validateTransfer({ format: "sift", version: original.some((record) => record.version === 2) ? 2 : 1, exportedAt, collections: [{ id: cid, records: original }] });
      baseline = projectBundle(archive.collections[0]);
    }
    const put = (r) => {
      const old = records.get(r.id);
      if (old && stableJSON(old) !== stableJSON(r)) fail(`Conflicting records generated for ${r.id}.`);
      records.set(r.id, old ?? r);
    };
    const cardID = (id) => /^[0-9a-f-]{36}$/i.test(String(id)) ? uuid(id, "Card id") : uuidFromText(`sift-web-card-v1|${cid}|${id}`);
    for (const collection of views) {
    const sourceRevisionID = collection.sourceRevisionID ? uuid(collection.sourceRevisionID,"Collection sourceRevisionID") : baseline?.collections.find((c) => c.id === collection.id)?.sourceRevisionID ?? baseline?.collections[0]?.sourceRevisionID ?? null;
    const sourceView = sourceRevisionID ? baseline?.revisionCollections.get(sourceRevisionID) : null;
    if (collection.sourceRevisionID && !sourceView) fail("Collection source revision is missing from canonical history.");
    const normalizedCollection = collectionDTO(collection);
    let lastRevision = sourceRevisionID;
    const ensureRevision = (dto, key, asCurrent = false) => {
      const clean = collectionDTO(dto), nativeCards = clean.cards.map((c) => ({ ...c, id: cardID(c.id) }));
      for (const r of records.values()) if (r.kind === "collectionRevision") {
        const p2 = recordPayload(r);
        if (p2.title !== clean.name || p2.description !== clean.description || p2.choiceLabels.keep !== clean.keepLabel || p2.choiceLabels.discard !== clean.discardLabel) continue;
        const existing = p2.cards.map((ref) => {
          const c = recordPayload(records.get(ref.revisionID));
          return { id: c.cardID, text: c.title, detail: c.detail, pros: c.pros, cons: c.cons, ...(Object.keys(c.numericValues ?? {}).length ? { numericValues: c.numericValues } : {}) };
        });
        if (asCurrent && sourceRevisionID && p2.id !== sourceRevisionID && p2.parentRevisionID !== sourceRevisionID) continue;
        if (stableJSON(existing) === stableJSON(nativeCards) && stableJSON(p2.numericFields ?? []) === stableJSON(clean.numericFields ?? [])
          && (!asCurrent || ![...records.values()].some((candidate) => candidate.kind === "collectionRevision" && recordPayload(candidate).parentRevisionID === p2.id))) return p2;
      }
      const id = uuidFromText(`sift-web-revision-v2|${cid}|${key}|${lastRevision ?? ""}|${stableJSON(nativeCards)}|${stableJSON({ ...clean, cards: [] })}`);
      const refs = nativeCards.map((c) => {
        const revisionID = uuidFromText(`sift-web-card-revision-v2|${id}|${stableJSON(c)}`);
        put(domainRecord(revisionID, "cardRevision", id, c.id, { revisionID, cardID: c.id, collectionRevisionID: id, title: c.text, detail: c.detail, pros: c.pros, cons: c.cons, ...(Object.keys(c.numericValues ?? {}).length ? { numericValues: c.numericValues } : {}) }));
        return { cardID: c.id, revisionID };
      });
      const p = { id, collectionID: cid, parentRevisionID: lastRevision, title: clean.name, description: clean.description, choiceLabels: { keep: clean.keepLabel, discard: clean.discardLabel }, ...(clean.numericFields?.length ? { numericFields: clean.numericFields } : {}), cards: refs };
      put(domainRecord(id, "collectionRevision", cid, cid, p));
      lastRevision = id;
      return p;
    };
    const collectionRuns = runs.filter((r) => String(r.collectionId) === String(collection.id)), runByID = new Map(collectionRuns.map((r) => [String(r.id), r]));
    const groupKey = (r, seen = /* @__PURE__ */ new Set()) => {
      if (r.sortId) return String(r.sortId);
      if (seen.has(r.id)) fail("Web run parent cycle.");
      seen.add(r.id);
      return r.parentRunId && runByID.has(String(r.parentRunId)) ? groupKey(runByID.get(String(r.parentRunId)), seen) : String(r.id);
    };
    const groups = /* @__PURE__ */ new Map();
    for (const r of collectionRuns) {
      const key = groupKey(r), g = groups.get(key) ?? [];
      g.push(r);
      groups.set(key, g);
    }
    const completed = /* @__PURE__ */ new Map(), contextByRun = new Map(baseline?.contexts ?? []), building = /* @__PURE__ */ new Set();
    const buildGroup = (key) => {
      if (completed.has(key)) return completed.get(key);
      if (building.has(key)) fail("Web revised path dependency cycle.");
      building.add(key);
      const rows = groups.get(key).slice().sort((a, b) => (a.roundNumber ?? 1) - (b.roundNumber ?? 1));
      if (rows.filter((r) => (r.roundNumber ?? 1) === 1).length > 1) fail("A web sort has multiple independent roots.");
      const initial = rows[0], known = baseline?.sessionContexts.get(key);
      let session, actions, headID, branchID, baseRows = [], mapping = /* @__PURE__ */ new Map(), fork = false, sourceRow = null;
      if (known) {
        ({ session, headID } = known);
        actions = new Map(known.actions);
        branchID = actions.get(headID).branchID;
        baseRows = known.rows;
        mapping = new Map(known.actionIDs);
      } else if (initial.revisesRunId) {
        const source = runByID.get(String(initial.revisesRunId));
        if (source) buildGroup(groupKey(source));
        const context2 = contextByRun.get(String(initial.revisesRunId));
        if (!context2) fail("Revised path is missing its source history.");
        ({ session, headID } = context2);
        actions = new Map(context2.actions);
        branchID = uuidFromText(`sift-web-branch-v2|${cid}|${key}`);
        fork = true;
        sourceRow = source ?? context2.rows.find((r) => r.id === initial.revisesRunId);
        if (!sourceRow) fail("Revised source round is missing.");
        const sourceDecisions = sourceRow.decisions ?? [];
        for (const d of initial.decisions ?? []) {
          const old = sourceDecisions.find((x) => x.position === d.position && String(x.cardId) === String(d.cardId) && x.choice === d.choice && x.createdAt === d.createdAt);
          if (old) {
            const a = context2.actionIDs.get(old.id);
            if (a) mapping.set(d.id, a);
          }
        }
      } else {
        if ((initial.roundNumber ?? 1) !== 1) fail("Web sort is missing round 1 history.");
        const snapshot = ensureRevision({ ...collection, cards: initial.cards, numericFields: initial.numericFields ?? [], keepLabel: initial.keepLabel ?? collection.keepLabel, discardLabel: initial.discardLabel ?? collection.discardLabel }, `snapshot|${initial.id}`);
        const id = uuidFromText(`sift-web-session-v2|${cid}|${key}`), plan = normalizePlan(initial.roundPlan, id, initial);
        session = { id, collectionID: cid, collectionRevisionID: snapshot.id, cards: snapshot.cards, titleSnapshot: snapshot.title, descriptionSnapshot: snapshot.description, choiceLabels: snapshot.choiceLabels, ...(snapshot.numericFields?.length ? { numericFields: snapshot.numericFields } : {}), roundPlan: plan, createdAt: dateMillis(initial.createdAt ?? exportedAt, "run.createdAt") };
        put(domainRecord(id, "sortSession", cid, id, session));
        actions = /* @__PURE__ */ new Map();
        headID = null;
        branchID = id;
      }
      const state = () => replayPath(session, actions, headID);
      const add = (operation, identity, at) => {
        const id = uuidFromText(`sift-web-action-v2|${session.id}|${key}|${headID ?? ""}|${identity}|${stableJSON(operation)}|${at}`);
        const currentPlan = headID ? state().plan : session.roundPlan;
        const currentPlanHasRatings = currentPlan.some((round) => round.ratingScale);
        const editedPlanHasRatings = operation.planEdited?._0?.some((round) => round.ratingScale);
        const usesRatings = Boolean(session.numericFields?.length || session.roundPlan.some((round) => round.ratingScale) || currentPlanHasRatings || editedPlanHasRatings);
        const action = { id, sessionID: session.id, branchID, parentActionID: headID, schemaVersion: usesRatings ? 2 : 1, rulesVersion: usesRatings ? 2 : 1, recordedAt: dateMillis(at ?? exportedAt, "action date"), operation };
        put(domainRecord(id, "sortAction", session.id, session.id, action));
        actions.set(id, action);
        headID = id;
        return id;
      };
      if (!headID) add({ started: { roundNumber: 1 } }, "start", initial.createdAt ?? exportedAt);
      const checkpoints = new Map();
      const checkpoint = (row, selectedHead = headID) => {
        const prefix = replayPath(session, actions, selectedHead);
        const ids = new Set(prefix.path.map((a) => a.id));
        const value = { session, actions, headID:selectedHead, state:prefix, rows, actionIDs:new Map([...mapping].filter(([,id]) => ids.has(id))) };
        checkpoints.set(String(row.id), value);
        return value;
      };
      const matchCard = (r) => {
        const actual = (r.cards ?? []).map(cardDTO).map((c) => ({ ...c, id: cardID(c.id) }));
        const expected = session.cards.filter((ref) => actual.some((c) => c.id === ref.cardID)).map((ref) => {
          const c = recordPayload(records.get(ref.revisionID));
          return { id: c.cardID, text: c.title, detail: c.detail, pros: c.pros, cons: c.cons, ...(Object.keys(c.numericValues ?? {}).length ? { numericValues: c.numericValues } : {}) };
        });
        if (actual.length !== expected.length || stableJSON(actual.slice().sort((a, b) => a.id.localeCompare(b.id))) !== stableJSON(expected.slice().sort((a, b) => a.id.localeCompare(b.id)))) fail("Web round card snapshot differs from its source session.");
      };
      for (const row of rows) {
        const n = row.roundNumber ?? 1, base = baseRows.find((r) => r.id === row.id);
        matchCard(row);
        if (base && stableJSON(runDTO(base)) === stableJSON(runDTO(row))) {
          const nextRound = state().path.find((a) => a.operation.roundStarted?.roundNumber === n + 1);
          checkpoint(row, nextRound?.parentActionID ?? known.headID);
          continue;
        }
        if (!fork && row.parentRunId && checkpoints.has(String(row.parentRunId)) && !base) {
          const parent = checkpoints.get(String(row.parentRunId));
          headID = parent.headID;
          branchID = actions.get(headID).branchID;
          mapping = new Map(parent.actionIDs);
        }
        const targetPlan = normalizePlan(row.roundPlan, session.id, row, state().plan);
        if (!fork && stableJSON(targetPlan) !== stableJSON(state().plan)) add({ planEdited: { _0: targetPlan } }, `plan|${row.id}`, row.updatedAt ?? row.createdAt ?? exportedAt);
        if (!fork && n > state().activeRound) {
          const prev = state().rounds.get(n - 1);
          if (!prev || n !== state().activeRound + 1) fail("Web sort is missing earlier rounds.");
          const ids = prev.ratingScale ? [...prev.ids] : prev.ids.filter((id) => prev.effective.get(id)?.d.choice === "keep");
          const nextScale = row.ratingScale ?? targetPlan[n - 1]?.ratingScale ?? null;
          const limit = nextScale ? ids.length : row.keepLimit;
          add({ roundStarted: { roundNumber: n, cardIDs: ids, keepLimit: limit, proposedKeepLimit: nextScale ? null : limit } }, `round|${row.id}`, row.createdAt ?? exportedAt);
        }
        if (!fork && n !== state().activeRound) {
          if (base) continue;
          fail("Web edits to an earlier round require a revised path.");
        }
        const decisions = (row.decisions ?? []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        const replaced = new Set(decisions.map((d) => d.replacesDecisionId).filter(Boolean));
        // Mutable replacement targets carry undoneAt too; only literal undos become undo events.
        const events = [];
        for (const d of decisions) {
          if (!mapping.has(d.id)) events.push({ type: "decision", d, at: d.createdAt ?? row.createdAt ?? exportedAt });
          const before = base?.decisions.find((x) => x.id === d.id);
          if (d.undoneAt && !replaced.has(d.id) && (!before || before.undoneAt !== d.undoneAt)) {
            // A fork clones SQL decision IDs; match the preserved source chronology.
            const old = sourceRow?.decisions.find((x) => x.position === d.position && x.createdAt === d.createdAt && x.choice === d.choice && String(x.cardId) === String(d.cardId));
            if (!old || old.undoneAt !== d.undoneAt) events.push({ type: "undo", d, at: d.undoneAt });
          }
        }
        events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.d.position ?? 0) - (b.d.position ?? 0) || (a.type === "decision" ? -1 : 1));
        for (const event of events) {
          const { d, at } = event;
          if (event.type === "undo") {
            const target = mapping.get(d.id);
            if (!target) fail("Undo target is missing from web history.");
            add({ undone: { targetActionID: target } }, `undo|${row.id}|${d.id}`, at);
            continue;
          }
          const replacement = d.replacesDecisionId ? mapping.get(d.replacesDecisionId) : null;
          if (d.replacesDecisionId && !replacement) fail("Decision replacement is missing from web history.");
          const decision = { id: uuidFromText(`sift-web-decision-v2|${session.id}|${row.id}|${d.id}`), cardID: cardID(d.cardId), choice: d.choice, ...(d.choice === "rating" ? { value: d.value } : {}), roundNumber: n, ...replacement ? { replacesActionID: replacement } : {} };
          let id;
          if (fork) {
            if (!replacement) fail("A revised path must begin with its recorded replacement.");
            const prior = state(), round = prior.rounds.get(n);
            id = add({ revisedPath: { _0: decision, reviewedRound: n, cardIDs: round?.ids ?? [], sourceHeadID: headID } }, `revise|${row.id}|${d.id}`, at);
            fork = false;
          } else id = add({ decided: { _0: decision } }, `decision|${row.id}|${d.id}`, at);
          mapping.set(d.id, id);
        }
        if (fork) fail("Revised path is missing its replacement decision.");
        if (stableJSON(targetPlan) !== stableJSON(state().plan)) add({ planEdited: { _0: targetPlan } }, `plan|${row.id}`, row.updatedAt ?? row.createdAt ?? exportedAt);
        const queue = (row.queue ?? state().rounds.get(n).queue).map(cardID), current = state().rounds.get(n);
        if (new Set(queue).size !== queue.length || stableJSON([...queue].sort()) !== stableJSON([...current.queue].sort())) fail("Web queue is inconsistent with recorded decisions.");
        // Normalize the final queue at its last known update; original skip chronology is unavailable.
        if (stableJSON(queue) !== stableJSON(current.queue)) for (const id of queue) add({ skipped: { cardID: id, roundNumber: n } }, `queue|${row.id}|${id}`, row.updatedAt ?? row.createdAt ?? exportedAt);
        checkpoint(row);
      }
      const context = { session, actions, headID, state: state(), rows, actionIDs: mapping };
      completed.set(key, context);
      for (const row of rows) {
        const own = checkpoints.get(String(row.id));
        if (!own) continue;
        // A revision of an earlier round must fork from a later descendant on that source path.
        const descendants = [...checkpoints.values()].filter((c) => c.state.path.some((a) => a.id === own.headID));
        descendants.sort((a,b) => b.state.activeRound-a.state.activeRound || a.headID.localeCompare(b.headID));
        contextByRun.set(String(row.id), descendants[0] ?? own);
      }
      building.delete(key);
      return context;
    };
    for (const key of groups.keys()) buildGroup(key);
    // Current editable content must remain a leaf after historical snapshots are captured.
    const unchanged = sourceView && stableJSON(collectionDTO(sourceView)) === stableJSON(normalizedCollection);
    if (!unchanged || lastRevision !== sourceRevisionID) ensureRevision(collection, `current|${collection.id}`, true);
    }
    bundles.push({ id: cid, records: [...records.values()] });
  }
  return validateTransfer({ format: "sift", version: bundles.some((bundle) => bundle.records.some((record) => record.version === 2)) ? 2 : 1, exportedAt, collections: bundles });
}
function normalizePlan(input, sessionID, row, existing = []) {
  const plan = input?.length ? input : [{ title: row.roundTitle ?? "Round 1", keepLimit: row.keepLimit ?? null }];
  return plan.map((r, i) => ({ id: existing[i]?.id ?? (/^[0-9a-f-]{36}$/i.test(String(r.id)) ? uuid(r.id, "Round id") : uuidFromText(`sift-web-round-v2|${sessionID}|${r.id ?? i + 1}`)), title: String(r.title ?? `Round ${i + 1}`), keepLimit: r.ratingScale ? null : i === (row.roundNumber ?? 1) - 1 && row.keepLimit != null && (i > 0 || !existing.length || existing[i]?.keepLimit != null || row.keepLimit !== row.cards?.length) ? row.keepLimit : r.keepLimit ?? null, ...(r.ratingScale ? { ratingScale: r.ratingScale } : {}) }));
}
export function remapTransferBundleIDs(value, sourceBundleID, conflictingIDs = []) {
  const archive = validateTransfer(value);
  const bundleID = uuid(sourceBundleID, "Source bundle id");
  const bundle = archive.collections.find((item) => item.id === bundleID);
  if (!bundle) fail("Source collection bundle was not found.");
  const namespace = sha256(`sift-transfer-remap-v1
${bundle.records.slice().sort((a, b) => a.id.localeCompare(b.id)).map((r) => `${r.id}|${r.kind}|${r.version}|${r.ownerID}|${r.logicalID}|${r.payload}`).join("\n")}`);
  const map = /* @__PURE__ */ new Map();
  const remap = (id) => {
    if (!id) return id;
    const normalized = uuid(id, "UUID reference");
    if (!map.has(normalized)) {
      const hex = sha256(`${namespace}|${normalized}`).slice(0, 32).split("");
      hex[12] = "8";
      hex[16] = (parseInt(hex[16], 16) & 3 | 8).toString(16);
      const raw = hex.join("");
      map.set(normalized, `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`.toUpperCase());
    }
    return map.get(normalized);
  };
  const refs = { collectionRevision: ["id", "collectionID", "parentRevisionID"], cardRevision: ["revisionID", "cardID", "collectionRevisionID"], sortSession: ["id", "collectionID", "collectionRevisionID"], sortAction: ["id", "sessionID", "branchID", "parentActionID"] };
  const rewrite = (kind, p) => {
    const out = structuredClone(p);
    for (const key of refs[kind]) if (out[key]) out[key] = remap(out[key]);
    if (kind === "collectionRevision") out.cards.forEach((x) => {
      x.cardID = remap(x.cardID);
      x.revisionID = remap(x.revisionID);
    });
    if (kind === "collectionRevision") for (const field of out.numericFields ?? []) field.id = remap(field.id);
    if (kind === "cardRevision" && out.numericValues) {
      out.numericValues = Object.fromEntries(Object.entries(out.numericValues).map(([id, value]) => [remap(id), value]));
    }
    if (kind === "sortSession") {
      out.cards.forEach((x) => {
        x.cardID = remap(x.cardID);
        x.revisionID = remap(x.revisionID);
      });
      out.roundPlan.forEach((x) => x.id = remap(x.id));
      for (const field of out.numericFields ?? []) field.id = remap(field.id);
    }
    if (kind === "sortAction") {
      const [key] = Object.keys(out.operation), op = out.operation[key];
      if (key === "decided" || key === "revisedPath") {
        op._0.id = remap(op._0.id);
        op._0.cardID = remap(op._0.cardID);
        if (op._0.replacesActionID) op._0.replacesActionID = remap(op._0.replacesActionID);
      }
      for (const f of ["cardID", "targetActionID", "sourceHeadID"]) if (op[f]) op[f] = remap(op[f]);
      if (op.cardIDs) op.cardIDs = op.cardIDs.map(remap);
      if (key === "planEdited") op._0.forEach((round) => {
        round.id = remap(round.id);
      });
    }
    return out;
  };
  const records = bundle.records.map((r) => {
    const payload = rewrite(r.kind, recordPayload(r));
    return { ...r, id: remap(r.id), ownerID: remap(r.ownerID), logicalID: remap(r.logicalID), payload: encodePayload(payload) };
  });
  const next = { ...archive, collections: archive.collections.map((item) => item === bundle ? { id: remap(item.id), records } : item) };
  if (conflictingIDs.length && !conflictingIDs.map((id) => uuid(id, "Conflict id")).some((id) => records.some((r) => r.id === id))) return validateTransfer(next);
  return validateTransfer(next);
}
import { validateNumericFields, validateNumericScale, numericValueError } from "./numeric-scale.js";
