CREATE TABLE IF NOT EXISTS sort_sessions (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id),
  rounds_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE runs ADD COLUMN sort_id TEXT REFERENCES sort_sessions(id);
ALTER TABLE runs ADD COLUMN revises_run_id TEXT REFERENCES runs(id);
ALTER TABLE runs ADD COLUMN queue_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE decisions ADD COLUMN replaces_decision_id TEXT REFERENCES decisions(id);

WITH RECURSIVE lineage(id, root_id) AS (
  SELECT id, id FROM runs WHERE parent_run_id IS NULL
  UNION ALL
  SELECT child.id, lineage.root_id FROM runs child JOIN lineage ON child.parent_run_id = lineage.id
)
INSERT OR IGNORE INTO sort_sessions (id, collection_id, rounds_json, revision, created_at, updated_at)
SELECT root.id, root.collection_id,
  (SELECT json_group_array(json_object('title', 'Round ' || rounds.round_number, 'keepLimit', rounds.keep_limit))
   FROM (SELECT member.round_number, MAX(member.keep_limit) AS keep_limit
     FROM runs member JOIN lineage ON lineage.id = member.id
     WHERE lineage.root_id = root.id GROUP BY member.round_number ORDER BY member.round_number) rounds),
  0, root.created_at, root.updated_at
FROM runs root WHERE root.parent_run_id IS NULL;

WITH RECURSIVE lineage(id, root_id) AS (
  SELECT id, id FROM runs WHERE parent_run_id IS NULL
  UNION ALL
  SELECT child.id, lineage.root_id FROM runs child JOIN lineage ON child.parent_run_id = lineage.id
)
UPDATE runs SET sort_id = (SELECT root_id FROM lineage WHERE lineage.id = runs.id)
WHERE sort_id IS NULL;

UPDATE runs SET queue_json = COALESCE((
  SELECT json_group_array(json_extract(card.value, '$.id'))
  FROM json_each(runs.cards_json) card
  WHERE NOT EXISTS (
    SELECT 1 FROM decisions d WHERE d.run_id = runs.id AND d.card_id = json_extract(card.value, '$.id') AND d.undone_at IS NULL
  )
), '[]') WHERE queue_json = '[]';

CREATE INDEX IF NOT EXISTS runs_sort_history_idx ON runs(sort_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_parent_run_idx ON runs(parent_run_id);
