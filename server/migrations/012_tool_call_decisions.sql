-- What a decision left on the call itself, and what looked dangerous about it.
--
-- The rule that decided a call was only in the event log and the HTTP response, so a
-- stored call could not answer "why". Warnings about arguments that look like
-- credentials are recorded for the same reason: a person reviewing a run should see
-- that a call carried something secret-shaped without having to find the event.

ALTER TABLE tool_calls ADD COLUMN rule_id TEXT;
ALTER TABLE tool_calls ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '[]';
