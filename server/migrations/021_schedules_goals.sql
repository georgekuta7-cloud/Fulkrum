-- Schedules and goals: automation that inherits approvals.
--
-- A schedule fires a playbook on an interval. A goal groups runs under one
-- objective and one shared budget. Neither invents authority: a schedule can
-- only run a playbook whose hash still matches its approval (checked at every
-- fire, not just at creation), and a goal shares a budget ceiling, never an
-- audit chain — per-run chains stay load-bearing, so the goal report lists
-- member chains rather than merging them.
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  playbook_id TEXT NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  every_minutes INTEGER NOT NULL,
  budget_usd REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_fire_at INTEGER NOT NULL,
  last_run_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_fire_at);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  budget_usd REAL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goal_runs (
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (goal_id, run_id)
);

ALTER TABLE runs ADD COLUMN goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL;
