-- Settings changed from the app, surviving restarts.
--
-- Every tunable used to live in the environment only, which meant every change
-- needed a terminal and a restart. Values saved through the settings API live
-- here instead. An explicitly set environment variable still wins over a saved
-- value, so operators and CI keep the final word; the API reports which source
-- each effective value came from.

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
