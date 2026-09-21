-- Claims: the typed half of a task completion, queryable on its own.
--
-- Evidence rows already hold what a worker claimed; claims name the claim
-- itself so verdicts (Wave 1.3) have something to attach to and downstream
-- tasks have ground truth to read instead of prose. Linked to the evidence
-- row they came from; the verdict starts NULL and is set only by a cited
-- verdict, never by default.
CREATE TABLE IF NOT EXISTS run_claims (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES run_tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  sha256 TEXT,
  evidence_id TEXT REFERENCES task_evidence(id) ON DELETE SET NULL,
  verdict TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_claims_run ON run_claims(run_id);
CREATE INDEX IF NOT EXISTS idx_run_claims_task ON run_claims(task_id);
