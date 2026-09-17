-- Fresh verification behind every completed task.
--
-- The worker that did the work may not judge it: a separate verifier session
-- checks the frozen acceptance criteria against the workspace and the evidence
-- ledger, and records one verdict per task. The verdict is what turns a task
-- summary from a claim into a checked fact — or refuses it loudly instead of
-- letting an unverified result flow silently downstream.

CREATE TABLE IF NOT EXISTS task_verdicts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES run_tasks(id) ON DELETE CASCADE,
  overall TEXT NOT NULL,
  results_json TEXT NOT NULL DEFAULT '[]',
  checked_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_verdicts_task ON task_verdicts(task_id, created_at ASC);
