-- The conversation a task has had so far.
--
-- A task stops mid-loop when the process dies, and recovery could only mark it
-- interrupted: resuming restarted the task from step zero, throwing away work the
-- model had already done and re-running any tool calls it had made. Persisting the
-- turns lets a resumed task continue from where it stopped, and makes the step
-- budget a property of the task rather than of the process that happened to be
-- running it.

CREATE TABLE IF NOT EXISTS task_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES run_tasks(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_task_turns_task ON task_turns(task_id, turn_index ASC);
