CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'read_write')),
  token_digest TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS api_keys_digest_idx ON api_keys(token_digest);
