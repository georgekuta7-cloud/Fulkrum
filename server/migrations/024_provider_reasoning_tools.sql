-- A provider that reasons by default can refuse function tools unless the
-- request says off explicitly — for it, absence is not off. The learned
-- answer is stored with the provider's own settings: null means nothing
-- learned, 'none' means every call carrying tools also carries the explicit
-- off, in the provider's dialect.
ALTER TABLE provider_settings ADD COLUMN reasoning_tools TEXT;
