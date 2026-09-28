-- P2.5: the verifier step budget can be chosen per run at approval, instead
-- of only through FULKRUM_VERIFY_MAX_STEPS at boot. NULL keeps the setting.
ALTER TABLE runs ADD COLUMN verification_steps INTEGER;
