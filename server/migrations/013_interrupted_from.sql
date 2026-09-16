-- What a run was doing when it was interrupted.
--
-- "interrupted" alone cannot answer whether resuming is legitimate: a run
-- interrupted while executing was working under an approved plan, and one
-- interrupted while planning had none. The resume guard needs that distinction, and
-- reconstructing it from events is exactly the kind of guess this column avoids.

ALTER TABLE runs ADD COLUMN interrupted_from TEXT;
