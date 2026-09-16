# Changelog

All notable changes to Fulkrum are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Replies stream, and the text arrives as it is written.** The request goes out with
  `stream: true` through the same pinned, byte-capped client as every other outbound
  call; three protocols stream three different ways and all three normalize into the
  same shape a buffered call returns. Text in flight is not an audit record — the
  finished reply is — so fragments go out as their own frame type, and a reader that
  connects mid-reply gets what has already arrived. A stream cut off part way is an
  error rather than a short, complete-looking answer.
- **Cancelling a run stops its work.** Containers are tracked per run, and a cancel
  removes them: previously the run stopped while the command kept going to its
  timeout. Every container a run started is stopped, not only the newest.
- **A write can be undone from the snapshot taken before it.** The revert is a write
  like any other — same policy, same fingerprint, same approval when the mode asks for
  one — so it is in the log as its own call. A creation and an oversized file refuse
  rather than pretending.
- **The app reports on itself**: `GET /api/status` (version, schema, database and WAL
  size, backup age, anchors, engine, provider health, retention) and verify/backup on
  demand, with the result recorded — "the chain was intact when I checked" and "a copy
  exists from before this" are the two facts nothing else can reconstruct.
- **History and replay**: runs with what each cost, a fork that re-runs a plan as a
  fresh draft awaiting its own approval, a search across messages and events, a
  workspace tree that applies the tool rules, and per-file history across runs.
- **A plan can be edited**, through the same validation the model's output gets, as a
  new version with a new hash — and a superseded version can no longer be approved by
  its old hash, which would have pointed the run back at the plan the user replaced.
- **Standing grants, scoped.** "Always" means within a directory or a host, never a
  blanket: a workspace-root path is refused, a command has no scope at all, matching is
  on directory boundaries, and a deny rule still wins. Grants list with use counts and
  revoke, and creation and revocation are recorded.
- **Cost, per task and over time**, with a pre-flight estimate that states its basis
  and says when it has no history to base one on.
- **Why a call stopped**: the deciding rule is stored on the call, credential-shaped
  arguments are recorded as warnings, a pending write carries the diff it would make,
  and a run can be exported as a bundle (report, events, artifacts, and every file it
  wrote plus the bytes it replaced) — a zip written without a dependency and checked in
  its test with PowerShell or unzip rather than with the code that wrote it.
- **The interface was rebuilt around the run.** A header with state, cost and its
  per-task breakdown, ceiling and run actions; a tabbed middle for plan, activity,
  artifacts and workspace; the Head AI in its own column; a drawer for health,
  containers, providers, grants and spend. Approvals show the rule, the resolved
  arguments, credential warnings and the write's diff, with `a`/`r`/`d` on the
  keyboard. The plan is editable, the workspace tab shows what the tools see, run
  history carries cost and a fork, and a first-run card names the two things that stop
  the app doing anything.
- **A typed API client and component tests.** One place talks to the bridge and turns a
  problem detail into something a component can explain; 12 component tests run in CI.

## [0.2.0] - 2026-09-16

### Added
- **Tool results are anchored outside the database.** The head of each run's chain

### Added
- **Tool results are anchored outside the database.** The head of each run's chain
  was recorded in a row in the same file, so deleting the row with the events it
  vouched for removed every trace. An append-only `audit-heads.log` next to the
  database now records the same head, and verification compares against both: a
  shortened tail, a rewritten anchor, and an anchor whose row has been deleted are
  reported separately. `npm run audit:verify` prints the anchor file.
- **A daily backup, and an integrity check at boot.** `npm run db:backup` writes a
  complete copy with `VACUUM INTO` — without stopping the app — copies the anchor
  log beside it, and rotates the oldest out. The bridge takes one at boot when the
  newest is older than `FULKRUM_BACKUP_INTERVAL_HOURS`, and `PRAGMA quick_check`
  refuses to open a damaged file with a message pointing at the backups instead of
  failing later on a write.
- **A resumed task continues its conversation.** The agent loop's turns are
  persisted per task, so a restart resumes a task where it stopped instead of
  starting it over and re-running tool calls it had already made. The step budget
  travels with the task, so a restart cannot hand a task a fresh allowance.

### Changed
- **Multi-statement writes are one transaction.** Approving a plan (approve, point
  the run at it, record the event), denying a call, and reconciling interrupted runs
  were separate autocommits: a crash between them left a state nothing could explain
  afterwards. `store.transaction()` makes each a unit, and subscribers are notified
  only for events that actually committed.
- **The audit chain records the hash of a tool result, not the result.** Every
  output was stored twice — once on the tool call, once inside the chain — and the
  copy inside the chain can never be pruned without breaking verification, which is
  why the retention policy shrank nothing. The chain still commits to the exact
  content, so an altered result is as detectable as before, and the bytes live where
  retention can reach them. Raw tool inputs get the same treatment.
- **A paused run no longer polls.** A parked worker checked the run's status every
  100 ms for the whole pause; it now waits on the store's event stream, with a slow
  re-check as a backstop.
- **A budget ceiling can no longer be passed by every parallel reader at once.** The
  check read recorded spend, and cost is only known after a call returns, so up to
  `maxParallelReaders` calls could clear the same ceiling together. A call that has
  started is reserved at its estimated cost, synchronously with the check, and the
  reservation is replaced by the real cost when the call lands.
- **A provider that is down is skipped rather than retried by everyone.** Only
  failures worth retrying count toward opening it, and after the cooldown a single
  probe decides whether it recovered. Calls to one provider are limited instead of
  piling up.
- **Shutdown waits for the workers.** The store used to be closed while runs were
  still writing to it; draining now ends open event streams so the server can close,
  and the store is closed after the active runs settle (or the same 5 s budget
  expires, which the lease makes visible on the next start).
- **A reconnecting event stream resumes from the cursor the browser actually has.**
  A stale `?after=` in the URL used to win over `Last-Event-ID`, so the header path
  was dead code; the header takes precedence now.
- **The daily budget window is documented** (local midnight) and can be pinned with
  `FULKRUM_BUDGET_TIMEZONE=UTC`.

### Added
- **A production mode.** `npm run build && npm start` runs one process that serves
  the interface, the API, and the event stream on loopback; previously `npm run dev`
  was the only way to run it, and `npm run preview` served the built UI without any
  API. Static files are containment-checked before they are read, the entry document
  is never cached while hashed assets are immutable, a client-side route falls back
  to the entry document, and a CSP plus `nosniff` and `no-referrer` are set. A
  `bin/fulkrum.mjs` launcher makes the same thing available as a linked command,
  with the working directory as the workspace.
- **One description of every setting, validated.** 58 environment variables were
  read across eleven modules with ad-hoc parsing; they are now declared in one place
  with a kind, a default, and a description, and `GET /api/config` reports each one
  with its effective value, its source, and any problem — a port that is not a port,
  an allowlist entry with a scheme in it, a timeout that is not a number. Startup
  says the same thing rather than leaving it to be discovered.
- **An API contract, and a test that keeps it honest.** `GET /api/openapi.json`
  describes every route, and `GET /api/runs/:id/report` writes up a run as JSON or
  Markdown: what was asked, the plan, each worker's result, the files changed, cost
  by model, and the audit verdict. Errors are RFC 9457 problem details now, with
  `error` kept as a deprecated alias, and a coverage test calls every documented
  route so the spec cannot drift away from the server.

### Security
- **Outbound connections are pinned to the address that was validated, and bodies
  are read with a byte cap.** Validation resolved a hostname and the request then
  resolved it again, so a host could answer publicly for the check and with
  `127.0.0.1` for the connection. The validated address is now what the socket
  connects to, with SNI and the `Host` header still carrying the original name, and
  every redirect hop is validated and pinned on its own. Response bodies are
  streamed and abandoned at the cap rather than buffered whole — `await
  response.text()` on a multi-gigabyte body ran the process out of memory before
  anything clipped it.
- **The private-address check is a CIDR table, and IPv4-mapped IPv6 is unwrapped
  first.** `::ffff:127.0.0.1`, `::ffff:172.16.x`, and `::ffff:169.254.x` used to
  pass as unremarkable IPv6; multicast, reserved, carrier-grade NAT, benchmarking,
  and documentation ranges are covered now too, and an address that cannot be
  parsed is refused rather than allowed.
- **A request that carries a credential needs approval.** `Authorization`,
  `Proxy-Authorization`, `Cookie`, `X-Api-Key`, and `Api-Key` make an outbound
  request an approval question even in autopilot, unless the host is allowlisted.
  The audit log records header names and a hash of each value, never the value.
- **Redaction stops eating ordinary words and starts catching the prefixes it
  missed.** `/key|token|secret/` redacted `monkey`, `keyboard`, and `sessionCount`;
  key names are matched by segment now. Added `glpat-`, `npm_`, `github_pat_`,
  `hf_`, `SG.`, `xai-`, `xapp-`, `dop_v1_`, and a narrow shape check for long
  unlabelled tokens — while hashes stay readable, because redacting a sha256 digest
  hides real information for no gain.
- **Workspace search cannot walk out through a link.** Directory entries are checked
  with `lstat`, so an NTFS junction — which a plain listing reports as an ordinary
  directory — is skipped, containment is re-proved for every directory descended
  into, and a `.fulkrumignore` in the workspace root extends the skip list.
- **The runner image is verified rather than assumed.** The base is pinned by
  digest; the image must be present or execution is disabled with an explanation;
  the boot log reports the digest and image id it found and says plainly when the
  image is only tagged; the uid is configurable, with `--userns=keep-id` for
  rootless Podman and a descriptor limit. `HOME` moved to a tmpfs mounted with exec
  allowed, because with a read-only root and a `noexec` `/tmp`, npm, pip, and cargo
  failed in a way that looked like the command's fault. CI builds the image and
  asserts the boundary against a live engine.
- **Injection attempts are reported.** Tool output reaches the model inside a
  labelled `<tool_result>` block, and output containing text aimed at the model is
  recorded as `tool.output.suspicious`. Telemetry, not a control: the threat model
  already assumes injection succeeds, and the permission matrix and the container
  are what limit the damage.
- **The local API's lack of authentication is stated at boot** instead of being
  left to be discovered.

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
