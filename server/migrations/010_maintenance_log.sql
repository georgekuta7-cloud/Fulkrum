-- A record of maintenance that was asked for and what it found.
--
-- Verification and backup results are the two facts nobody can reconstruct later:
-- "the chain was intact when I checked on Tuesday" and "a copy was taken before
-- this happened" are exactly what a person needs when something has gone wrong,
-- and neither is derivable from the state that follows it.

CREATE TABLE IF NOT EXISTS maintenance_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_maintenance_kind_created ON maintenance_log(kind, created_at DESC);
