-- Structured evidence behind task summaries.
--
-- A summary alone cannot carry a build forward: the next worker needs to know
-- what was found, where, and what proves it. Evidence rows are the machine
-- half of a task completion — typed, citable, bounded — while the summary
-- stays the human half. Handoffs reference evidence by id instead of pasting
-- whole transcripts, so context stays small and reviewable.

CREATE TABLE IF NOT EXISTS task_evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES run_tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  sha256 TEXT,
  tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_evidence_run_task ON task_evidence(run_id, task_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_task_evidence_tool_call ON task_evidence(tool_call_id);
