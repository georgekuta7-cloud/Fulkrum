-- Bounded retries need a counter that survives restarts.
--
-- A task that fails verification is retried, not resurrected: the attempt
-- number travels with the task row so a resumed run cannot hand the same task
-- a fresh allowance, and the repair loop can stop after FULKRUM_TASK_MAX_ATTEMPTS
-- instead of retrying forever. Turns keep accumulating across attempts, so the
-- retry sees why the previous one failed rather than starting blind.

ALTER TABLE run_tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
