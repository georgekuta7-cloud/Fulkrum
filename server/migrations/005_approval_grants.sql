-- Approvals that can be scoped to a run.
--
-- Re-approving the same shape of action on every step is the fastest way to make
-- a user click through prompts without reading them. A grant records that the
-- user allowed one tool for the rest of a run, so it is visible and revocable
-- rather than an invisible preference.
--
-- A grant only ever converts "ask" into "allow". Deny rules are evaluated first
-- and are never overridden by a grant, so credentials, path escapes, and
-- unparseable calls stay refused.
CREATE TABLE IF NOT EXISTS approval_grants (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  granted_by TEXT NOT NULL DEFAULT 'user',
  revoked_at INTEGER,
  UNIQUE(run_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_approval_grants_run ON approval_grants(run_id, granted_at ASC);
