# 0009. Work must be provable, not just autonomous

## Context

Every competitor in the agent space optimizes for autonomy: more tools called,
more steps completed, longer runs. The failure mode that matters most to a
supervisor — someone who has to *trust* what an agent did — is not slowness but
unprovability: a verified-looking summary with no link to what it claims about.
Our verifications risked becoming exactly that: a PASS verdict whose basis was
prose.

Fulkrum already records more of the truth than the alternatives: the audit chain
hashes every event, fingerprints bind approvals to resolved arguments, budgets
reserve before spending. But records are not proof. A claim like "the flow
completes" sitting in a worker's summary is disconnected from the receipt that
would prove it — the exit code, the diff hash, the row in the evidence table.

## Decision

The value of a run is the fraction of its claims that are proven, and that
fraction is a computed property of the run, not a judgment. Concretely:

- Worker findings become **claims**: typed objects linking a statement to its
  evidence (file:line, diff hash, command receipt) — see [0007](0007-chain-records-hashes.md).
- A **verdict** is only PASS when it cites the evidence; anything else is
  honestly UNKNOWN. There is no "probably fine" state.
- Approval binds at both ends: the call fingerprint on execution ([0002](0002-approvals-bind-to-a-fingerprint.md)),
  and the run's acceptance checks against the completion review. You approved
  outcomes; the review reports which of those outcomes are proven.
- Automation inherits approvals — a scheduled run executes only under a
  previously approved plan bound to the same content hash. Approval is never
  bypassed for convenience; scheduled runs get the same chain, the same
  fingerprint checks, and their own budget ceiling.

Any feature that adds autonomy without adding provability — a tool nobody can
audit, a model switch nobody recorded, a scheduled run no human approved — is
rejected by this decision, however useful it looks.

## Consequences

- The review surface reports a claim-verification rate, not a thumbs-up.
- The permission matrix ([0003](0003-deny-ask-allow-one-table.md)) stays the
  only channel for capability: skills and plugins are discoverable by every
  agent but executable only through it; installation is a human act that
  pins a hash. See the roadmap's Arsenal wave.
- Workers collaborate through the shared evidence ledger, never through direct
  channels: task-to-task queries are routed through the Head and recorded,
  because an unrecorded conversation is unprovable collaboration.
- Scheduled runs, escalation policies, and role changes are events first and
  behavior second: what ran is always reconstructable from the chain.
