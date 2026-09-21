-- Playbooks pin the skills they were approved with.
--
-- A playbook that names skills records each skill's content hash beside the
-- plan hash. Instantiation re-checks every pin: a skill edited since approval
-- refuses the run exactly like a drifted plan does, because scheduled
-- knowledge that changed silently is the same failure as a changed plan.
ALTER TABLE playbooks ADD COLUMN skills_json TEXT;
