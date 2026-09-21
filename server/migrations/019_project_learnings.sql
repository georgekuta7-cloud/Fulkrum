-- Project learnings: durable facts future runs should know.
--
-- Written once per reviewed run that produced evidence, by a single bounded
-- model call — never by a worker, never on the critical path. A learning is
-- advisory context for the planner, editable and deletable by the human it
-- serves: memory you cannot edit is a liability. The source run links every
-- fact to the work that taught it.
CREATE TABLE IF NOT EXISTS project_learnings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fact TEXT NOT NULL,
  source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_learnings_project ON project_learnings(project_id, created_at DESC);
