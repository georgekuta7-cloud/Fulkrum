-- Definition overrides also use provider_configs for built-in providers.
-- Keep old display names resolvable when a user renames a cast provider.
ALTER TABLE provider_configs ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]';
