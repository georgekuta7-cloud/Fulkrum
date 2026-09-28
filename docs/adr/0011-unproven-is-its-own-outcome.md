# 0011. An unproven task is its own outcome

## Context

Verification returns one of three verdicts ([0009](0009-provable-work.md)):
PASS, FAIL, or UNKNOWN. The first two had consequences — a PASS completed the
task, a FAIL failed it and skipped its dependents — but UNKNOWN fell through to
the same completion path as PASS. A run could show every task completed while
nothing had been proven.

The first version of this decision kept the task's single status and let
dependents run on unproven ground with a flag in the handoff. The owner's plan
(Revision 2, P2.1) is stricter: **UNKNOWN never satisfies a required proven
dependency**, and a human waives a check explicitly, with a reason. This
revision records that rule.

## Decision

Execution and verification are two axes, persisted separately:

- A task's `status` says whether the work ran; `verification_status` says
  whether it was proven. A task whose verdict is UNKNOWN is execution-completed
  and verification-UNKNOWN. The migration identifies existing UNKNOWN tasks
  without rewriting history.
- A dependent needs a **proven predecessor**: PASS, or an explicit waiver. A
  predecessor that is unproven — or not finished — leaves the dependent queued
  with a `task.waiting` event naming the dependency and the reason. The run
  stops moving with those dependents still queued.
- A human **waives** an unproven or failed check with a required reason. The
  waiver (`task.waived`) is the explicit policy that lets dependents proceed;
  the run resumes from there, keeping its workspace writer slot.
- The reasons for an UNKNOWN are distinct events, never one blur: 
  `task.verification.invalid` (the reviewer returned an unusable verdict),
  `task.verification.uncited` (a claimed PASS cited nothing recorded),
  `task.blocked` (budget exhaustion), and `task.waived` (the human).
- The review counts proven (PASS or waived), unproven, failed, and skipped
  separately, and never folds unproven into proven.

## Consequences

- A run can legitimately end its walk with queued dependents; the review is
  the decision surface — waive, repair, or discard — and the workspace writer
  slot is held until that decision ([0010](0010-checkpointed-live-workspace.md)).
- The honest completion rate of a run is visible at both ends: per task
  (status and verdict beside each other) and in the review's proof packet.
- A cautious verifier can stall a plan; that is deliberate. The way out is a
  recorded human decision, not an automatic pass.
