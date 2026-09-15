-- Cost accounting and traces.
--
-- Every model call is recorded with its token counts and computed cost, so a
-- run's spend is a query rather than a guess. Prices are versioned per row: a
-- later price change must not silently rewrite what a past run cost.
CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  span_id TEXT,
  role TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  billable_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  priced INTEGER NOT NULL DEFAULT 0,
  price_version TEXT,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_calls_run ON model_calls(run_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_model_calls_created ON model_calls(created_at ASC);

-- Spans follow the OpenTelemetry GenAI attribute names so a local trace can be
-- exported later without rewriting what was recorded. Prompt and completion
-- content is not stored by default.
CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_span_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  attributes_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_spans_run ON spans(run_id, started_at ASC);

-- Per-run ceiling. NULL means the environment default applies.
ALTER TABLE runs ADD COLUMN budget_usd REAL;
ALTER TABLE runs ADD COLUMN budget_exceeded_at INTEGER;
