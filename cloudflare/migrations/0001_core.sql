CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  keep_label TEXT NOT NULL DEFAULT 'Keep',
  discard_label TEXT NOT NULL DEFAULT 'Let go',
  cards_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id),
  parent_run_id TEXT REFERENCES runs(id),
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
  undone_at TEXT
);

CREATE INDEX IF NOT EXISTS runs_history_idx ON runs(collection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS decisions_run_position_idx ON decisions(run_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_decision_per_card
  ON decisions(run_id, card_id) WHERE undone_at IS NULL;
