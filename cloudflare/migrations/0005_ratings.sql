ALTER TABLE collections ADD COLUMN numeric_fields_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE runs ADD COLUMN rating_scale_json TEXT;
ALTER TABLE runs ADD COLUMN numeric_fields_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE sort_answers (
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
INSERT INTO sort_answers (id, run_id, card_id, choice, rating_value, position, created_at, undone_at, replaces_decision_id)
  SELECT id, run_id, card_id, choice, NULL, position, created_at, undone_at, replaces_decision_id FROM decisions;
CREATE INDEX sort_answers_run_position_idx ON sort_answers(run_id, position);
CREATE UNIQUE INDEX one_active_answer_per_card ON sort_answers(run_id, card_id) WHERE undone_at IS NULL;
