# Fulkrum Roadmap — the Provable Work program

**Thesis:** the value of an agent run is the fraction of its claims that are
proven. Every item here exists because it raises that fraction. See
[ADR 0009](adr/0009-provable-work.md).

**Reading the tables:** *Why* states the provability argument, not the feature's
charm. *Where* names the modules it touches. *Effort* is focused days, assuming
the suite (`npm test`, `test:ui`, lint, typecheck, coverage gates) stays green
throughout. No item ships without its tests.

**Invariants — nothing below may touch these:** loopback-only with origin
checks · container-or-nothing execution · fingerprint-bound approvals · the
hash-chained audit log with anchored heads · reserve-before-spend budgets ·
deny → ask → allow, where grants only ever soften `ask`.

---

## The moat, stated once

No competitor combines: a loopback-only unauthenticated-but-CORS-gated API, a
container that is the *only* execution path, approvals bound to fingerprints of
resolved arguments, a hash-chained event log with dual anchors, budgets that
reserve before a call is made, and a permission matrix where deny always wins.
New features do not get exceptions to any of this; they get events on the
chain. That is what "provable" means here: *reconstructable from records, by a
skeptic, after the fact.*

---

## Roles and casting — the model the program assumes

- **Roles are contracts** (tools, prompt, step budget, permission scope).
  `server/roles.mjs` becomes a registry; new roles are data, not code.
- **Models are casting.** The Head decides *which roles a plan needs* (it writes
  the tasks); the human owns *which model plays each role* (routing). Multiple
  roles share one model; a plan with five roles does not need five API keys.
- **Casting is not plan content.** Changing role→model never touches the plan
  hash, so it never triggers re-approval — but it is recorded as a
  `run.routing.changed` event, so "what ran" stays answerable.
- **The Head advises, never re-casts.** Symptoms the orchestrator already sees
  (failed verifications, exhausted step budgets, repeated bounces) become
  `run.casting.advised` recommendations. Automation beyond advice is a
  *declared* escalation policy per role (`builder: cheap, escalate after 1
  failed verification`), which fires auditable `run.route.escalated` events.
  Silent model-switching is rejected.
- **Collaboration goes through the ledger, never direct channels.**
  Task-to-task questions route through the Head and land as signed handoffs;
  the shared evidence ledger is what downstream tasks read. An unrecorded
  conversation is unprovable collaboration, so it is not offered.

---

## Wave 0 — quick wins, no schema break

Each item ships independently. Nothing here creates a new execution path.

| # | Item | Why (provability) | Where | Effort |
|---|---|---|---|---|
| 0.1 | **Repo map**: read-only `workspace.map` tool — per-file outlines (exports, signatures) with an honest line-count fallback | Scout's plans stop being blind on large repos; every claim about the codebase gets a basis | `server/tools.mjs`, `server/toolBroker.mjs`, one matrix row | 2d |
| 0.2 | **Checks after write** (opt-in): run `settings.checks.afterWrite` (e.g. `npm test`) in the container; store exit code + output hash as a receipt. Off by default — it spends container runs | Turns "I wrote it" into "it passes" with a citable artifact | `server/toolBroker.mjs`, task evidence gains `kind: 'receipt'` | 2d |
| 0.3 | **Non-blocking ask for readers**: a `run.ask` from a read-only role pauses that task's *verification*, not its reading. Writers unchanged | Less dead time without weakening a single guard | `server/tools.mjs`, orchestrator waiter map, one matrix row | 1d |
| 0.4 | **Complexity advisory**: 1–10 score rendered on the approval surface at ≥7 ("consider splitting"). Advisory, never a gate | Informed humans approve better plans; the number is a claim the review can check later | `server/planService.mjs` post-validation; approval UI | 1d |
| 0.5 | **Checkpoints**: `previousContent` snapshots already exist — add `run.snapshot` events (`run.checkpoint` was taken: the head's repair/replan/stop decision), timeline restore as a fingerprint-approved call, never a chain rewrite | Restore becomes a provable link, not a time machine that lies | `server/store.mjs`, Artifacts view | 2d |
| 0.6 | **Casting on display**: role→model on the plan card and graph nodes, editable per node, recorded, never part of the plan hash | The human sees who is playing whom before approving | UI on project routing; `run.routing.changed` | 1d |
| 0.7 | **Skills v0**: local `skills/` folder of SKILL.md-style markdown packs, trigger-matched injection into role prompts, wrapped as data (not instructions). No execution, no trust expansion | Knowledge with a name and a hash, citable in claims | prompt assembly in `server/orchestrator.mjs` | 1d |

**Exit:** all additive; coverage gates hold; complexity scores are honest on fixtures.

---

## Wave 1 — the spine (claims become objects)

The wave that separates Fulkrum from everything on the competitive map. After
this wave, every run reports a computed claim-verification rate.

| # | Item | Why (provability) | Where | Effort |
|---|---|---|---|---|
| 1.1 | **Claim graph**: worker evidence blocks become typed objects — `{claim, evidence: [file:line \| diffHash \| receiptId], verdict}` in a new additive `run_claims` table. Downstream tasks read upstream claims as ground truth | The review stops saying "looks good" and starts saying "5/6 verified, 1 UNKNOWN — the cache claim, no receipt" | `server/orchestrator.mjs`, `server/store.mjs`, review UI | 4d |
| 1.2 | **Receipts everywhere**: formalize `{command, exitCode, outputSha256, durationMs, containerDigest}`; shell.exec and Wave 0.2 checks emit them | Every PASS can point at something the machine did, not something the model said | `server/toolBroker.mjs`, evidence schema | 2d |
| 1.3 | **Verdicts must cite**: the verify pass cites receipt/evidence ids; a verdict without a citation degrades to UNKNOWN | Verification stops being vibes — an uncited PASS is an honest UNKNOWN | verify pass, `task.verified` payload | 2d |
| 1.4 | **Proof-carried approval**: plan acceptance checks become the run's *predicted claims*; completion review reports against what was approved ("3 outcomes approved → 2 proven, 1 UNKNOWN") | Approval means something at both ends of the run. Requires content-hash binding (have it) plus structured evidence (Wave 1.1) | plan approval flow, `run.review.ready` payload | 3d |
| 1.5 | **Reviewer formalized**: the existing read-only verify pass becomes a visible role row with its own routing slot — independent model, never the task's own | The judge is named, routed, and auditable instead of an anonymous step | `server/roles.mjs`, routing | 1d |
| 1.6 | **`skills.find` meta-tool + plugin manifests v1 (HTTP tools only)**: every role can discover skills and declarative API tools at any moment; plugin tools join the role's described set but run the *same* resolve → authorize → fingerprint path. Capability declared in the manifest or denied | Discovery is unlimited; execution is unchanged — the safest executable kind proves the pattern | new meta-tool, manifest schema, pinned-network call path | 3d |

**Exit:** claim-verification rate is computed and rendered; UNKNOWN rate is visible per run.

---

## Wave 2 — roles, rolled out by measured pain

Order is load-bearing: Architect first (needs the advisory, 0.4), Editor
second (needs precise intents, else it's a dumber Forge), Debug third (needs
receipts, 1.2, else it's guessing). Each role ships with its prompt and tests;
none ships without a measured reason.

| # | Item | Why (provability) | Where | Effort |
|---|---|---|---|---|
| 2.1 | **Architect** (read + write `.md` only): turns ≥7-complexity directions into decomposed intents with file refs and acceptance criteria. Thinks, cannot touch code | Sharper plans → fewer edits → more claims survive contact with reality | `server/roles.mjs`, planService expansion step | 3d |
| 2.2 | **Editor** (the Aider split): one narrow edit per call, step budget 1–3, cheap/fast default | Edits from precise intents verify at Forge's rate for less spend | role registry, agent loop budget override | 2d |
| 2.3 | **Debug**: explicit loop — hypothesis → instrument → rerun → revise. Owns stack traces; shell receipts are first-class evidence (requires 1.2) | A hypothesis per step makes debugging *refutable*, which is verification in another coat | role prompt + `debug.hypothesis` events | 3d |
| 2.4 | **Casting advice**: Head turns observed symptoms into `run.casting.advised` recommendations. Advises; never acts | The person who approves gets told *when the casting is the problem*, with the evidence attached | orchestrator observers, node UI | 2d |
| 2.5 | **Escalation policies**: declared per role, firing auditable events with reasons. Silent auto-switching stays rejected | Declared policy is reconstructable; emergent switching is not | routing + `run.route.escalated` | 2d |
| 2.6 | **Task-to-task queries**: routed through the Head, answered as signed handoffs. Workers cooperate; zero unrecorded channels | Cooperation that stays on the chain strengthens the moat; chat-soup would dissolve it | `run.ask` machinery generalized + `task.query*` events | 2d |
| 2.7 | **Boomerang formalized**: child returns only `summary + evidenceIds + verdict`. `forModel()` + `compactTaskMessages()` promoted to enforced contract with a failing test if a full log crosses a handoff | Parent context stays clean, so reviewers judge evidence, not noise | handoff payload validation | 1d |
| 2.8 | **Container plugins + MCP client bridge**: code plugins run in the locked-down runner; external MCP servers are consumed per-run with declared capabilities (the read-only exposure in `server/mcp.mjs` is the same protocol in reverse) | Same matrix, same sandbox, new capabilities — the trust proof from 1.6, extended | toolBroker execution paths, MCP client | 4d |

**Exit:** plan edit distance drops after Architect; Editor verifies at ≥ Forge's rate for less; no role without prompt + tests.

---

## Wave 3 — memory and automation, approval-inheriting

The Devin gap, closed the Fulkrum way: **automation that inherits approvals
instead of bypassing them.** A scheduled run executes only under a previously
approved plan bound to the same content hash, with the same chain, the same
fingerprint checks, and its own budget ceiling.

| # | Item | Why (provability) | Where | Effort |
|---|---|---|---|---|
| 3.1 | **AGENTS.md auto-context**: read at plan time, bounded, recorded in the plan event | "The plan saw what" is answerable | planService context assembly | 1d |
| 3.2 | **Learnings**: ≤3 durable facts per run, per project, editable/deletable in settings — memory you cannot edit is a liability | Knowledge accumulates *provably*, each fact sourced to its run | settings UI + store | 3d |
| 3.3 | **Playbooks**: a plan template approved once; re-runs inherit that approval bound to the hash | Repeatable work with one human decision instead of zero — the honest middle | gallery UI, scheduler trigger | 3d |
| 3.4 | **Scheduled runs + `/goal`**: cron in `index.mjs`; a goal is a named thread of runs sharing one ceiling and one chain, stopping when its acceptance check verifies | "Green CI until proven" with a receipt per pass; a scheduled run with no approved playbook refuses to start | scheduler, goal progress surface | 3d |
| 3.5 | **Team blueprints**: versioned local JSON (roles + routing + reasoning + permission preset); import renders a **diff of exactly which permissions change** — a blueprint can never silently elevate | Sharing without accounts, review without trust | project creation flow | 2d |
| 3.6 | **Marketplace index**: signed (ed25519, key pinned in settings), git-backed registry fetched read-only through the pinned HTTP layer, cached offline. Submission is a pull request — **git is the review process**, so no accounts, no portal, no moderation dashboard. Private marketplaces are one setting | Distribution without a service or telemetry | index fetcher, signature verification | 3d |
| 3.7 | **Install/update UX + playbook pinning**: every install/update renders the permission diff and pins `id + version + sha256`; no auto-update, ever; revocation kills scoped grants. Playbooks reference skills by id+hash | Installs are human acts on pinned hashes; a scheduled run's knowledge is as auditable as its plan | Arsenal settings surface, inspector tab | 2d |

**Exit:** a scheduled run's audit trail is indistinguishable from a manual one; blueprint import cannot add an `allow` without rendering it.

---

## Wave 4 — time travel (the moat, made visible)

Hash-chained events + `previousContent` snapshots = the workspace is
recomputable at any event index.

| # | Item | Why (provability) | Where | Effort |
|---|---|---|---|---|
| 4.1 | **Event-indexed reconstruction**: reverse-apply snapshots, verify against chain hashes (or say so) | Reconstruction a skeptic can rerun | store walk | 4d |
| 4.2 | **Timeline scrubber**: drag to event N — graph, files, and chat show that moment | The audit log becomes something people *see* instead of believe | graph canvas + file panel | 3d |
| 4.3 | **Restore as approved call**: Cursor-style checkpoints, except audit-grade and never a rewrite | Restore is a link, not a lie | artifact revert path | 1d |

---

## Program shape

| Wave | Theme | Effort | The demo |
|---|---|---|---|
| 0 | quick wins | ~10d | repo map, checks-with-receipts, checkpoints, skills v0 |
| 1 | the spine | ~15d | "5/6 claims proven" — the number nobody else can print |
| 2 | roles | ~19d | casting advice, escalation, visible cooperation on the graph |
| Arsenal | skills → tools → marketplace | (folded into 0/1/2/3 above) | skills cited in claims; install cards with permission diffs |
| 3 | memory & automation | ~17d | scheduled runs that inherit approvals |
| 4 | time travel | ~8d | the scrubber — the moat you can touch |

Dependency chain: 1.2 ← 0.2 · 2.1 ← 0.4 · 2.2 ← 2.1 · 2.3 ← 1.2 · 2.8 ← 1.6 · 3.3 ← 1.4 · 3.7 ← 3.3 ∧ 3.6. Everything else is parallelizable.

## Metrics — all computable from existing tables

1. **Claim-verification rate** (proved / total) — the thesis metric, from Wave 1 on.
2. **UNKNOWN rate** — should fall as receipts land; falling UNKNOWN is verification getting honest.
3. **Plan edit distance** — Architect earns its slot only if this drops.
4. **Approval decision time** — claim-linked evidence should shrink it.
5. **Escalation rate** — a role escalating >20% of runs means the default casting is wrong.
6. **Restore usage** — tells you if Wave 4 was worth it.

## Cut list — kept honest

- Worktrees/branches — **cut** (contradicts the execution-boundary decision); PR-style diffs without branches stay.
- Browser tool — **cut** for the foreseeable future; if ever, read-only DOM snapshots behind the matrix.
- Direct worker-to-worker chat — **cut permanently**; the ledger is the channel.
- Silent model switching — **cut permanently**; declared escalation policies only.
- Auto-updating plugins, "always allow" grants, telemetry-based reputation — **cut** on sight.
- Steer/queue — **kept but scoped**: queue = next-turn message; steer = injected at the next tool boundary with a `run.steered` event. Never a fingerprint bypass.

## License guardrails

Copy code with attribution: TaskMaster scorer/PRD shapes (MIT), Aider repo-map heuristics (Apache-2.0), Roo mode definitions as prompt reference (Apache-2.0).
Ideas only, never vendored: Cursor, Devin, GPT-Pilot (FSL — re-implement, don't vendor). Boomerang and mode isolation are patterns, safe throughout.
