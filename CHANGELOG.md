# Changelog

All notable changes to Fulkrum are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- Token usage is captured per model call (input, output, cache read/write,
  reasoning) as the basis for cost accounting.
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
