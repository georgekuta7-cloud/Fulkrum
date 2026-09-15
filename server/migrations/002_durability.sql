-- Durability, approval integrity, and audit integrity.
--
-- Run leases let a restart tell the difference between "still working" and
-- "abandoned when the process died", instead of leaving runs executing forever.
ALTER TABLE runs ADD COLUMN owner_id TEXT;
ALTER TABLE runs ADD COLUMN heartbeat_at INTEGER;
ALTER TABLE runs ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE runs ADD COLUMN interrupted_at INTEGER;
ALTER TABLE runs ADD COLUMN interruption_reason TEXT;

-- The fingerprint commits to the resolved call (absolute paths, final argv,
-- destination host). Resolved arguments are stored verbatim so the audit record
-- shows what was approved even if the resolver changes later.
ALTER TABLE tool_calls ADD COLUMN call_fingerprint TEXT;
ALTER TABLE tool_calls ADD COLUMN resolved_json TEXT;
ALTER TABLE tool_calls ADD COLUMN idempotency_key TEXT;
ALTER TABLE tool_calls ADD COLUMN approved_at INTEGER;
ALTER TABLE tool_calls ADD COLUMN approval_scope TEXT;
ALTER TABLE tool_calls ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tool_calls ADD COLUMN output_pruned_at INTEGER;

-- Each event commits to the hash of the event before it, so editing, deleting,
-- or reordering events is detectable.
ALTER TABLE run_events ADD COLUMN prev_hash TEXT;
ALTER TABLE run_events ADD COLUMN hash TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_status_lease ON runs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_idempotency ON tool_calls(run_id, idempotency_key);

-- Superseded by PRAGMA user_version, which cannot drift from the schema.
DROP TABLE IF EXISTS schema_migrations;
