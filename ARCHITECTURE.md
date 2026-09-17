# How Fulkrum is put together

A local-first multi-agent workspace: one Node process on loopback, a SQLite file,
a React interface, and a container for the commands agents ask to run. This
document is the map — what each module is for, what states a run moves through,
and where the boundaries are. `SECURITY.md` covers the threat model; `README.md`
covers using it.

## The shape of a request

```
browser ──▶ Vite dev server (5173, dev only) ─┐
                                              ├─▶ server/app.mjs
browser ──▶ the bridge itself (8787, npm start)┘
              │  origin check → route → JSON or problem+json
              ▼
        store (SQLite)  ──  orchestrator ──▶ modelCall ──▶ pinned HTTP ──▶ provider
                                 │
                                 └──▶ toolBroker ──▶ workspace files
                                                 └─▶ execution ──▶ container engine
```

`server/app.mjs` is the only HTTP surface. Every route runs inside one guard, so a
bad body or an unexpected throw answers with a status instead of killing the
process that is holding the runs.

## Modules

| Module | What it is for |
| --- | --- |
| `app.mjs` | The HTTP surface: routing, origin checks, request caps, static UI, SSE. |
| `index.mjs` | Boot: settings, store, wiring, leases, shutdown ordering, fatal handlers. |
| `config.mjs` | Every environment variable, its default, and its validation. |
| `store.mjs` | All persistence: migrations, the event chain, spans, spend, plans, tool calls, grants. |
| `orchestrator.mjs` | Runs a plan: scheduling, the bounded agent loop, budget gates, approvals, the head review. |
| `planService.mjs` / `plans.mjs` | Drafting a plan, parsing one, hashing it, ordering its tasks into layers. |
| `permissions.mjs` | Path resolution and the permission matrix — the single policy table. |
| `toolBroker.mjs` | The six tools, argument resolution, write snapshots, search. |
| `execution.mjs` | The container boundary: engine detection, argv, limits, timeouts. |
| `networkPolicy.mjs` / `outboundHttp.mjs` | Address validation (CIDR tables) and pinned, byte-capped HTTP. |
| `modelCall.mjs` | Three provider protocols, auth styles, sampling policy, retries, the breaker. |
| `providerRegistry.mjs` | Providers, credentials, custom endpoints, the connectivity probe. |
| `pricing.mjs` / `pricing/*.json` | The versioned price table and the cost of one call. |
| `redaction.mjs` / `injection.mjs` | What must not be stored or shown; what output is talking to the model. |
| `artifacts.mjs` / `diff.mjs` | What a run changed, and the diff of each write. |
| `runReport.mjs` / `apiDocs.mjs` | The written-up run, and the API contract. |
| `recovery.mjs` / `backup.mjs` / `verifyAudit.mjs` | Restart reconciliation, copies, and chain verification. |

## The run state machine

```
                    ┌──────────────┐
        create ────▶ │   planning   │
                    └──────┬───────┘
        approve-plan       │  cancel
                           ▼
                    ┌──────────────┐   pause   ┌────────┐
                    │  executing   │ ◀────────▶│ paused │
                    └──┬────┬───┬──┘  resume   └────────┘
                       │    │   │
      ceiling reached  │    │   └── crash ──▶ interrupted ── resume ──▶ executing
                       ▼    │                        │
              ┌────────────────┐                      └── abandon ──▶ cancelled
              │ budget_exceeded│ ── raise the ceiling ──▶ executing
              └────────────────┘
                       │
        last layer done ▼
                    ┌──────────────┐
                    │    review    │  (the run stops here: it is the user's move)
                    └──────────────┘

   failed  ◀── an unhandled error anywhere in the run
```

Transitions are written to the event log (`run.paused`, `run.resumed`,
`run.cancelled`, `run.interrupted`, `run.budget.exceeded`, `run.review.ready`,
`run.failed`), so the state of a run is always explainable from its own history.
A run holds a **lease** while it works: a process that dies leaves an expired
lease, which is how the next boot can tell "still working" from "gone".

## The plan lifecycle

1. **Draft.** The Head AI is asked for JSON; the reply is validated, and a reply
   that cannot be used falls back to a labelled template — recorded as
   `plan.rejected` rather than hidden. The stored plan carries a **content hash**.
2. **Approve.** `POST /api/runs/:id/control { action: 'approve-plan', planHash }`
   binds the approval to the exact content the user was shown. Approving a plan the
   user did not see is refused with 409.
3. **Supersede.** Redrafting marks the previous draft superseded, so an approval can
   only ever point at the newest version that was shown.
4. **Materialize.** Each plan task becomes a `run_tasks` row, reused if it already
   exists — which is what makes a resume idempotent.
5. **Layers.** Tasks are ordered by their dependencies. Read-only tasks in a layer
   run concurrently up to `FULKRUM_MAX_PARALLEL_RESEARCHERS`; tasks that write run
   one at a time, because parallel writers conflict over the same files.

## The task loop

A task is a bounded conversation, not a script. Each turn: the model is called with
the role's own tool list → it either answers or asks for tools → each call is
resolved, authorized, executed, and returned as typed content inside a
`<tool_result>` block → repeat until it answers or `FULKRUM_MAX_TOOL_STEPS` is
reached, at which point it is asked for a summary with no tools.

Turns are persisted as they happen (`task_turns`), so a restart resumes the task
where it stopped instead of starting it over, and the step budget it has used
travels with it.

## The tool-call lifecycle

```
requested ──▶ (policy) ──▶ allow ──▶ running ──▶ completed | failed
                  │
                  ├──▶ ask ──▶ approval_required ──┬── approve ──▶ running
                  │                               └── deny    ──▶ denied
                  └──▶ deny ──▶ denied
```

Every call is written **before** it executes, with a **fingerprint** over its
resolved arguments (absolute paths, final argv, destination host, and the hash of
any written content). Approval re-derives that fingerprint and refuses when it no
longer matches, so what the user approved is what runs. The original arguments are
kept apart from the redacted copy that goes in the log and the UI: redaction must
never change what a write produces.

## Events

The audit log is append-only and hash-chained, and it records its own vocabulary:

| Group | Types |
| --- | --- |
| Run | `run.plan.loaded`, `run.plan.attached`, `run.paused`, `run.resumed`, `run.cancelled`, `run.interrupted`, `run.failed`, `run.review.ready`, `run.route.invalid`, `run.provider.fallback`, `run.checkpoint` |
| Budget | `run.budget.exceeded`, `run.budget.unmeasurable` |
| Plan | `plan.drafted`, `plan.rejected`, `plan.approved`, `plan.approval.rejected` |
| Task | `task.started`, `task.completed`, `task.cancelled`, `task.skipped`, `task.resumed`, `task.retry`, `task.failed`, `task.verified`, `task.completion.invalid`, `task.context.compacted`, `worker.handoff` |
| Tool | `tool.requested`, `tool.started`, `tool.completed`, `tool.failed`, `tool.denied`, `tool.output.suspicious` |
| Approval | `approval.requested`, `approval.granted`, `approval.revoked` |
| Message | `message.user`, `message.assistant` |

Each event commits to the hash of the one before it, and the head is anchored both
in a row and in `audit-heads.log` beside the database — see `SECURITY.md` for what
that does and does not prove. Tool results are recorded as a hash and a size rather
than in full: the bytes live on the tool call, where the retention window can reach
them, and the chain still commits to them exactly.

## The boundaries

Four, and each is the only place its kind of thing happens.

- **Filesystem.** Every path a tool touches is resolved and proved to be inside the
  workspace, on real paths, with links, junctions, and Windows device traps refused.
  Credential paths are denied outright.
- **Network.** Outbound requests are validated against a CIDR table, then **pinned**
  to an address that was validated — the name is not resolved twice. Redirects are
  followed by hand so every hop is checked and pinned on its own.
- **Execution.** Commands run in a fresh container with no network, a read-only root,
  a writable workspace and home, dropped capabilities, limits, and a timeout. With
  no engine, execution is disabled rather than falling back to the host.
- **The API.** Loopback only, with an origin check and no authentication: CSRF
  protection, not access control, and the boot log says so.

## Money

Every model call — planning, worker turns, the review, and chat — is recorded in
`model_calls` with tokens, latency, and a cost from a **versioned** price table, so
historical costs stay reproducible when prices change. A model with no price is
recorded as unpriced rather than free, and a total that contains one is reported as
a lower bound. Ceilings are checked before each call against recorded spend **plus
what is in flight**, because cost is only known after a call returns.
