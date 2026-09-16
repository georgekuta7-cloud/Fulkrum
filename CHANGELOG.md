# Changelog

All notable changes to Fulkrum are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Live chat answered 502 on every turn.** The success path shadowed the HTTP
  response with the provider result and handed that to the JSON writer, which
  called `writeHead` on a provider payload. Demo mode returned earlier, so a
  keyless install never hit it; the call was still billed and recorded. Regression
  test added.
- **An approved write no longer writes the redacted text.** `tool_calls.input_json`
  holds the redacted copy for the audit log and the UI, and the approve path used
  to execute that same copy — so a file whose content matched a credential pattern
  was written as `[redacted:…]` while its fingerprint claimed the original bytes.
  Original arguments are now stored separately (`tool_call_inputs`), execution and
  the artifact diff read them, and the redacted copy stays for display.
- **`readJson` counted UTF-16 units, not bytes.** A body of multi-byte characters
  could exceed the stated cap by roughly 3×.
- **Reserved device names and alternate data streams were reachable through an
  absolute path.** The check returned early on a drive letter, so `C:\ws\CON.txt`
  and `C:\ws\a.txt:stream` passed. The colon and device-name tests now run on the
  path after the drive prefix.
- **The head review ran on a hardcoded route.** `Grok · grok-4` was used whether
  or not that provider had a key, so a user with any other provider silently got a
  demo review. The reviewer is now the run's route, the project setting, the
  configured fallbacks, or the first provider that actually holds a key.
- **A stale README `Current limits` section** contradicted the rest of the file
  (it still claimed a git-only shell, no cost accounting, and no artifacts view).
  Rewritten to state the limits that are actually current.

### Added
- **Any OpenAI-compatible endpoint, configured in the UI.** A custom provider can
  now carry its own key (stored locally, never returned by the API), an auth style
  (`Bearer`, `x-api-key`, Azure's `api-key`, a named header, or none), extra
  headers, a per-provider local-network opt-in, and a sampling policy. Role routes
  accept free text, so a model name does not have to be one the list offers.
- **Per-model sampling policy.** A temperature is sent only where the model takes
  one: `gpt-5`, the `o` series, and `deepseek-reasoner` omit it by default, and a
  provider that answers 400 complaining about temperature is retried once without
  it and the result is remembered. This is what made the default OpenAI model fail
  on every call.
- **A provider probe that reports what it found.** `POST /api/providers/:id/test`
  uses the configured credentials and auth style — including none — and returns
  status, latency, and the model list, with a plain explanation when an address is
  refused for being on the local network.
- **Explicit Node requirement.** `engines` is `>=22.13.0`, and the store explains
  itself instead of dying with "No such built-in module" when `node:sqlite` is
  unavailable in the running version.
- **Audit checkpoints, so a truncated log is detectable.** A hash chain proves
  nothing in the middle was edited, but deleting the last events leaves every
  remaining link valid. Each run's chain head is now anchored when the run stops
  moving (and on demand via `npm run audit:verify -- --anchor`); verification
  reports `TRUNCATED` for a shortened tail and an anchor mismatch for a rewritten
  one, and says which sequence the chain covers. Pre-chain events are anchored by
  a genesis checkpoint, so that boundary is a recorded fact rather than an open
  count. A checkpoint is a row in the same file, so this is tamper-evident rather
  than tamper-proof, and `SECURITY.md` says so.
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
- `FULKRUM_CONTAINER_CLI` points at the engine binary for shells where it is not
  on PATH, and a failed engine detection is re-probed rather than cached for the
  process lifetime, so installing an engine does not require a restart.
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
- A failed migration left the SQLite file locked rather than closed, so the error
  that mattered was masked by a file-in-use error from whatever cleaned up next.
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
