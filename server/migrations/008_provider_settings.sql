-- Per-provider settings and credentials, for built-in and custom providers alike.
--
-- provider_configs defines a custom endpoint (label, base URL, model). This table
-- holds how to talk to it, and the split matters: a built-in provider has settings
-- — a key entered in the UI, a LAN opt-in, a sampling policy — without ever having
-- a definition row. The key lives here rather than in the audit log or an event
-- payload, and it is never returned by the API.

CREATE TABLE IF NOT EXISTS provider_settings (
  provider_id TEXT PRIMARY KEY,
  api_key TEXT,
  auth_style TEXT NOT NULL DEFAULT 'auto',
  auth_header TEXT,
  headers_json TEXT NOT NULL DEFAULT '{}',
  allow_private INTEGER NOT NULL DEFAULT 0,
  temperature TEXT NOT NULL DEFAULT 'auto',
  updated_at INTEGER NOT NULL
);
