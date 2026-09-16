-- Original tool arguments, kept apart from the copy meant to be read.
--
-- tool_calls.input_json holds the redacted form: it is what the audit log and the
-- UI show, so a credential that passes through a call is not written into the log.
-- Execution needs the bytes the model actually sent, because a write whose content
-- merely looks like a secret must still write what was asked for. Keeping the two
-- apart means redaction can never corrupt a call, and the raw copy can be pruned
-- later without touching the hash-chained event log.

CREATE TABLE IF NOT EXISTS tool_call_inputs (
  tool_call_id TEXT PRIMARY KEY REFERENCES tool_calls(id) ON DELETE CASCADE,
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
