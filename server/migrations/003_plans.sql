-- A plan becomes a stored artifact rather than a hardcoded shape.
--
-- Approval binds to a specific plan version and its content hash, so editing a
-- plan cannot silently reuse an approval that was granted for different work.
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  objective TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  source TEXT NOT NULL DEFAULT 'model',
  created_at INTEGER NOT NULL,
  approved_at INTEGER
);

CREATE TABLE IF NOT EXISTS plan_tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  order_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  acceptance_check TEXT,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plans_run_created ON plans(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plans_project_created ON plans(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan_order ON plan_tasks(plan_id, order_index ASC);

-- Links the execution record back to the plan line it came from, so the audit
-- trail can show which approved task produced which work.
ALTER TABLE runs ADD COLUMN plan_id TEXT;
ALTER TABLE run_tasks ADD COLUMN plan_task_id TEXT;
ALTER TABLE run_tasks ADD COLUMN step_count INTEGER NOT NULL DEFAULT 0;
