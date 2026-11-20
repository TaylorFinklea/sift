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
