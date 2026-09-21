-- Playbooks: approved plans, reusable.
--
-- A playbook snapshots a plan somebody already approved, so re-running it
-- inherits that approval instead of asking again. The content hash is the
-- mechanism: instantiation recomputes the hash and refuses on mismatch, so an
-- edited template can never ride an old approval. A playbook with no approved
-- plan behind it cannot be saved at all.
CREATE TABLE IF NOT EXISTS playbooks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  budget_usd REAL,
  approved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playbooks_project ON playbooks(project_id, created_at DESC);
