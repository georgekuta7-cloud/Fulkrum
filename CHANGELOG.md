# Changelog

All notable changes to Fulkrum are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **The container execution boundary.** Agent commands run in a fresh container
  per command: no network, read-only root filesystem with only the workspace
  writable, non-root user, all capabilities dropped, `no-new-privileges`, memory
  and CPU and process limits, and a timeout that stops and removes the container.
  The argv is passed as an array, so no shell interprets it on either side.
- **The command surface is open inside that boundary.** The git-only argument
  allowlist is gone: it was survivable rather than contained (pager, hooks,
  textconv, `--no-index`), and the container is what does the work now. The build
  worker can compile, test, and inspect a repository offline.
- **No engine means no execution.** With no container engine reachable, command
  execution is disabled and reported as such at boot, in the permission dock, and
  in `/api/health`. It never falls back to running on the host, and WSL2 is not
  offered as a boundary because its interop layer can execute Windows binaries.
- **Denying a call.** An approval can be refused, and the worker receives the
  denial as a typed error so it can choose another approach instead of retrying.
- **Run-scoped approvals.** "Approve for this run" records a grant so the same
  tool stops re-prompting. A grant only ever turns *ask* into *allow* — deny rules
  are evaluated first and never overridden — and grants are listed in the UI,
  revocable, and recorded in the audit log. Persistent "always allow" is refused
  rather than approximated.
- **Artifacts with real diffs.** The contents of a file are snapshotted
  immediately before each write, so the artifacts tab shows the actual change.
  Files written before snapshots existed report that no diff is available, and
  oversized files say they are too large to diff rather than showing nothing.
- **Provider connectivity checks** in workspace settings, wired to the existing
  test endpoint, with the local-gateway requirement (`FULKRUM_ALLOW_PRIVATE_PROVIDER_URLS`)
  stated where the provider form is.
- **An error boundary** around the interface, so a render failure shows what broke
  instead of a blank page, and the composer's keyboard shortcut now actually
  works with a platform-correct label.
- **Cost accounting.** Every model call (chat, planning, and each worker step) is
  recorded with input, output, cache-read, cache-write, and reasoning tokens,
  latency, and computed cost, priced from a versioned table. `GET
  /api/runs/:id/trace` returns the ledger plus the trace.
- **Budgets that stop work.** Per-run (`FULKRUM_RUN_BUDGET_USD`), per-day
  (`FULKRUM_DAILY_BUDGET_USD`), or per-run overrides. Reaching a ceiling ends the
  run in a `budget_exceeded` state with the refused task marked `blocked`; the UI
  offers to raise the ceiling and resume, keeping completed work.
- **An unknown model is priced as unknown, not free.** Unpriced calls are counted
  separately, marked in the UI, and announce that spend is a lower bound, so a
  budget cannot silently do nothing.
- **Span traces** for runs, tasks, model calls, and tool calls, using the
  OpenTelemetry GenAI attribute names. Prompt and completion content is not stored.
- **Plans are stored artifacts.** The Head AI drafts a plan (objective, tasks with
  roles, acceptance checks, and dependencies); it is persisted with a content
  hash, and `Approve & start run` approves that exact content. A plan that changed
  after it was shown is refused rather than silently approved.
- **Workers choose their own tools.** Each task runs as a bounded tool-calling
  loop over OpenAI-compatible, Anthropic, and Google function calling, with
  per-role tool allowlists, JSON Schema validation of arguments, typed errors the
  model can act on, and a step budget (`FULKRUM_MAX_TOOL_STEPS`).
- **Dependency-aware scheduling.** Tasks run in layers: read-only research may
  overlap, writers are serialized, and each task receives the results of the tasks
  it depends on.
- Crash recovery: runs hold a lease and heartbeat, and a startup reconciler marks
  in-flight runs as interrupted instead of leaving them stranded forever.
- Approval integrity: every tool call carries a fingerprint over its normalized,
  resolved arguments, and an approval only executes the exact call it was shown.
- A single permission matrix (tool × mode → allow/ask/deny) evaluated
  deny → ask → allow, replacing scattered per-tool checks.
- Hash-chained run events, plus `npm run audit:verify` to prove the audit log has
  not been edited, and an explicit statement of what the log does not cover.
- SQLite migration runner (`PRAGMA user_version` + ordered SQL files) so schema
  changes apply to existing databases.
- Idempotency keys for side-effectful tools, and tool call rows written before
  execution so a crash between intent and completion is visible.
- Provider retry with exponential backoff and jitter, honoring `Retry-After`,
  plus optional ordered fallback routes.
- Continuous integration on Node 22 and 24, on both Linux and Windows.

### Changed
- The API bridge no longer exits on a malformed request body; all route handlers
  are guarded and a malformed body returns 400.
- Request bodies are capped (100 kB by default, 600 kB for tool calls) instead of
  accepting unbounded JSON.
- SQLite now runs in WAL mode and is checkpointed and closed cleanly on shutdown.
- The provider layer is one normalized message format translated per protocol, so
  tool calls, tool results, and usage are handled the same way everywhere.
- The run overview in the UI shows the stored plan, its source, and per-task
  status instead of hardcoded copy.
- The event stream resumes from the last event the UI saw. It previously reset its
  cursor on every reconnect and replayed the whole run, and the feed de-duplicated
  by title, which could drop genuinely distinct events.
- The interface no longer invents identity: the sidebar shows your real projects
  and workspace, and dead controls (a non-functional project picker, an account
  row, notifications, help, and two navigation entries with nothing behind them)
  were removed rather than left clickable.

### Fixed
- A malformed JSON body to `/api/runs/:id/control`, `/api/runs/:id/tools`, or the
  tools approval endpoint killed the whole API bridge process, orphaning every
  active run.
- `shell.exec` allowlist escapes: argument lists are validated as a whole rather
  than trusting the first element, closing `--no-index`, `-c`, `--config-env`,
  pager, hook, and textconv paths.

## [0.1.0] - 2026-09-15

Initial working state: a supervisor-style local multi-agent workspace with a Head
AI, a research worker (Scout) and a build worker (Forge); SQLite persistence of
projects, runs, messages, events, tasks and tool calls; an event-sourced run log
streamed to the UI over SSE; a server-side tool broker with permission modes and
approval prompts; and multi-provider model routing (OpenAI-compatible, Anthropic,
Google) with custom endpoints.
