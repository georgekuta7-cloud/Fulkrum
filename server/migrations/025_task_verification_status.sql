-- Execution and verification are two axes (plan P2.1). The task's status says
-- whether the work ran; verification_status says whether it was proven.
-- Existing rows are identified, not rewritten: the short-lived 'unproven'
-- status (execution finished, verdict UNKNOWN) maps to completed + UNKNOWN,
-- and completed tasks with a stored verdict take it as their status.
ALTER TABLE run_tasks ADD COLUMN verification_status TEXT;

UPDATE run_tasks SET status = 'completed', verification_status = 'UNKNOWN' WHERE status = 'unproven';

UPDATE run_tasks SET verification_status = (
  SELECT v.overall FROM task_verdicts v
  WHERE v.task_id = run_tasks.id
  ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1
)
WHERE verification_status IS NULL
  AND EXISTS (SELECT 1 FROM task_verdicts v WHERE v.task_id = run_tasks.id);
