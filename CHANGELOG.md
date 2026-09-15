# Changelog

All notable changes to Fulkrum are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- Idempotency keys and write-before-execute intent rows for side-effectful tools.
- Provider retry with exponential backoff and jitter, honoring `Retry-After`,
  plus optional ordered fallback routes.
- Continuous integration on Node 22 and 24, on both Linux and Windows.

### Changed
- The API bridge no longer exits on a malformed request body; all route handlers
  are guarded and a malformed body returns 400.
- Request bodies are capped (100 kB by default, 600 kB for tool calls) instead of
  accepting unbounded JSON.
- SQLite now runs in WAL mode and is checkpointed and closed cleanly on shutdown.

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
