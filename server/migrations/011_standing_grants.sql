-- Approvals that outlive a run, bounded by a scope.
--
-- "Approve for this run" is a grant in approval_grants, keyed by run. This is the
-- other half of that idea: a decision that keeps applying to later runs, but only
-- within something the user can describe — a directory, or a host. A grant with no
-- scope is not representable here on purpose: an unbounded "always allow writes"
-- would make the approval system decorative, and the permission for a command has
-- no boundary to draw at all.

CREATE TABLE IF NOT EXISTS standing_grants (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_standing_grants_active ON standing_grants(tool_name, revoked_at);
