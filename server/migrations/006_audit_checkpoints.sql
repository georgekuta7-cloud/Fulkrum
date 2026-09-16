-- Audit checkpoints.
--
-- A hash chain proves a run's events were not edited or reordered in the middle.
-- It cannot prove the tail is intact: deleting the last N events leaves every
-- remaining link valid, so a truncated log still verifies.
--
-- A checkpoint records the chain head (sequence and hash) in a row that is not
-- part of the chain. Verification can then say "the chain is valid up to the
-- anchor, and the anchor is still present" instead of only "everything I can see
-- is consistent with itself".
--
-- The first checkpoint for an existing database is a genesis anchor: it records
-- how many events predate hash chaining at all, so that boundary is a stated fact
-- rather than an open-ended "unverifiable" count.
CREATE TABLE IF NOT EXISTS audit_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  hash TEXT,
  event_count INTEGER NOT NULL,
  anchored_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_checkpoints_run ON audit_checkpoints(run_id, sequence DESC);

INSERT INTO audit_checkpoints(run_id, sequence, hash, event_count, anchored_at, source, note)
SELECT head.run_id,
       head.sequence,
       head.hash,
       counts.event_count,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       'genesis',
       'Anchored when checkpoints were introduced. Events at or below this point predate hash chaining, so they have no hash to verify.'
FROM run_events head
JOIN (
  SELECT run_id, MAX(sequence) AS sequence, COUNT(*) AS event_count
  FROM run_events
  GROUP BY run_id
) counts ON counts.run_id = head.run_id AND counts.sequence = head.sequence;
