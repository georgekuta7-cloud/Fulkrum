# 0011. An unproven task is its own outcome

## Context

Verification returns one of three verdicts ([0009](0009-provable-work.md)):
PASS, FAIL, or UNKNOWN. The first two had consequences — a PASS completed the
task, a FAIL failed it and skipped its dependents — but UNKNOWN fell through to
the same completion path as PASS. A run could show every task completed while
nothing had been proven, and the status chip said `completed` for both. The
visibility half of this was fixed first (the verdict now renders beside the
status); this decision changes the continuation rule itself, deliberately.

## Decision

A task whose overall verdict is UNKNOWN is recorded as **unproven** — not
completed, not failed:

- The task status is `unproven` and the chain records `task.unproven`; no
  `task.completed` event is emitted for it.
- Dependents still run. Unproven is absence of proof, not a failure, and
  blocking a pipeline on it would turn a cautious verifier into a work-stopper.
  The handoff event carries `unproven: true`, so downstream work and its
  reviewers can see the ground it stands on.
- The run's review reports task-level tallies — proven, unproven, failed,
  skipped — beside the criterion tallies, and never folds unproven into proven.
- A resumed run re-runs unproven tasks. The work is not kept as done, and a
  resume is another chance to prove it; completed tasks are still kept.

## Consequences

- The control room draws unproven tasks distinctly, and the worker strip says
  `unproven` instead of `done`.
- The Head's repair packet counts unproven tasks, so repair decisions can be
  made on proof, not only on failures.
- The honest completion rate of a run is visible at both ends: per task on the
  plan card and in the graph, and in the review's proof packet.
