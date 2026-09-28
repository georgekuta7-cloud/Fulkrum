-- P2.2: acceptance checks become explicit and typed. plan_tasks gains the
-- structured check (command, file assertion, or human criterion); the
-- existing acceptance_check text stays as the display form. Rows created
-- before this migration keep NULL and are labeled legacy, not rewritten.
ALTER TABLE plan_tasks ADD COLUMN check_json TEXT;
