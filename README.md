# Fulkrum

Fulkrum is a supervisor-style multi-agent workspace: you chat with the Head AI, approve a plan, and then route work to Scout and Forge.

After approval, the current worker slice runs Scout first, hands its findings to Forge, and then asks Head AI to prepare a review checkpoint. With no provider key configured this flow runs in explicit demo mode; with keys configured, each role uses its selected server-side provider.

Fulkrum is a **single-user, local-first** tool. The API bridge binds to `127.0.0.1` only, there are no accounts, and nothing is sent anywhere except to the model providers you configure.

## Run it

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`. `npm run dev` starts both the Vite UI and the local API bridge.

## Checks

```powershell
npm test               # 81 tests: policy, persistence, execution boundary, and the HTTP API
npm run lint
npm run typecheck      # the client, and the server and tests via checkJs
npm run build
npm run audit:verify   # prove the run event log has not been edited
```

`npm test` boots the real API bridge on an ephemeral port against a temporary
database and workspace, so the tests never touch your data.

The server is plain JavaScript, so `tsconfig.server.json` type-checks it and the
tests with `checkJs`. It is deliberately not `strict` yet: the value is catching
misspelled identifiers, wrong argument counts, and signature mismatches, which is
how a syntax error once reached the test suite before this existed.

## Add provider APIs

Copy `.env.example` to `.env.local` and fill in what you need. Every supported
variable is documented in that file; the short version:

- `XAI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, `GLM_API_KEY`/`ZAI_API_KEY`, `KIMI_API_KEY`/`MOONSHOT_API_KEY` for the built-in providers.
- `FULKRUM_FALLBACK_ROUTES` for an ordered list of routes to try when the primary provider fails after retries.
- `FULKRUM_ALLOWED_ORIGINS`, `FULKRUM_HTTP_ALLOWLIST`, `FULKRUM_ALLOW_PRIVATE_PROVIDER_URLS` for the security controls described in `SECURITY.md`.
- `FULKRUM_DB_PATH`, `FULKRUM_WORKSPACE_ROOT`, `FULKRUM_API_PORT` for local configuration.

Custom OpenAI-compatible providers can be added or removed from **Workspace settings**. The provider definition is stored locally; the API key stays an environment variable on the server. Restart `npm run dev` after changing `.env.local`.

A custom provider URL must use a public host: loopback and private addresses are
refused so the agent cannot reach services on your own machine. If you run a local
model gateway such as Ollama, set `FULKRUM_ALLOW_PRIVATE_PROVIDER_URLS=1`.

## How a run behaves

A run executes a **plan**, not a fixed script. The Head AI turns your direction
into a plan — an objective plus tasks with roles, acceptance checks, and
dependencies — and that plan is stored with a content hash before you see it.

`Approve & start run` approves that exact content. If the plan changes after you
were shown it, the approval is refused (`This plan changed since it was shown`)
rather than applied to work you did not read. **Redraft plan** asks the Head AI
for a new version, which supersedes the old draft.

Tasks then run in dependency layers. Read-only research may overlap; anything
that can write is serialized, because parallel writers conflict over the same
files and parallel readers do not. Each task hands its findings to the tasks that
depend on it.

Inside a task the worker is an actual agent: it is given its own tool allowlist
and decides which tools to call, sees the typed result, and continues until it
answers or hits its step budget (`FULKRUM_MAX_TOOL_STEPS`, default 8). When the
budget runs out it is asked for a summary with no tools, so a run still produces
something reviewable.

Role tool scopes are enforced twice: a tool outside a role's allowlist is not
even described to the model, and a call to one is refused with a typed error the
model can read and act on. Arguments are validated against the tool's JSON Schema
before the broker sees them, and the broker then re-resolves and re-checks
everything from scratch.

Each run has a permission mode: `Guided` pauses consequential actions,
`Selective` allows low-level work while guarding risky actions, and `Autopilot`
proceeds within the approved plan and configured boundaries. Routing decisions
come from one policy table (`server/permissions.mjs`), evaluated
deny → ask → allow, so a broad deny always beats a narrow allow and anything
unknown or unparseable is denied rather than guessed at.

Two properties are worth knowing as a user:

**Approvals are bound to the exact call.** Every tool call records a fingerprint
over its normalized, resolved arguments — absolute paths, the final argument
vector, the destination host. The approval prompt shows those resolved arguments,
not a model-written summary, and approving executes exactly that call. Approving
one payload cannot run a different one. You can also **deny** a call, which tells
the worker no so it can choose another approach instead of retrying.

**A decision can cover the rest of the run.** "Approve for this run" records a
grant so the same tool stops asking. A grant only ever turns *ask* into *allow*:
deny rules are evaluated first and are never overridden, so a grant for
`workspace.write` still cannot write a credential file. Active grants are shown
above the artifact list with a revoke button, and both the grant and its
revocation are events in the audit log. Persistent "always allow" is deliberately
not offered — a standing exception needs somewhere to review it first.

**You can see what changed.** The Artifacts tab lists every file a run wrote, with
a real diff: the contents immediately before each write are snapshotted, so the
diff is the actual change rather than a guess. Files written before snapshots
existed say so instead of showing an empty diff, and oversized files report that
they are too large to diff.

**Interrupted runs are recoverable.** A run holds a lease while it works. If the
bridge is killed mid-run, the next start marks the run `interrupted` instead of
leaving it looking alive forever, and the control room offers **Resume** (which
continues from the last completed step) or **Abandon**.

## Execution boundary

Agent commands run inside a container and never on the host. Windows has no
Seatbelt, Landlock, or bubblewrap, so a container is the only boundary available
— and an argument allowlist is not one. The previous git-only allowlist was
survivable rather than contained: a pager, a repo hook, a `.gitattributes`
textconv driver, or `--no-index` each offered a way out of it.

The container is created per command with:

- no network (`--network none`)
- a read-only root filesystem, with only the workspace mounted writable
- a non-root user, all capabilities dropped, and `no-new-privileges`
- a tmpfs `/tmp`, plus memory, CPU, and process-count limits
- a wall-clock timeout that stops the container and removes it

The argv is passed as an array, so no shell interprets it on either side of the
boundary. Because the boundary does the work, the command surface is open: the
build worker can compile, run tests, and inspect a repository offline.

**WSL2 is where the engine runs, not what contains it.** A WSL distribution can
execute Windows binaries through its interop layer, so "inside WSL" would still
mean "can run things on Windows". Fulkrum therefore does not offer WSL2 as a
fallback boundary: without a container engine, command execution is disabled and
the app says so rather than running unsandboxed.

Set it up once:

```bash
# Inside the Ubuntu distribution
sudo apt-get update && sudo apt-get install -y docker.io
sudo service docker start
sudo usermod -aG docker "$USER"     # then re-open the shell

# From the project root
docker build -t fulkrum-runner:local server/runner
docker run --rm hello-world
```

Then either leave `FULKRUM_CONTAINER_ENGINE` unset for auto-detection, or set it
to `docker` (CLI on PATH), `docker-wsl` (engine inside the default distribution),
or `podman`. The permission dock shows which boundary is live, and `/api/health`
reports the same thing: `commands: docker container` or `commands: disabled` with
the reason.

If the CLI is installed but not on the PATH your shell gives to Fulkrum — which is
what `spawn docker ENOENT` means on a Windows service or non-interactive shell —
point `FULKRUM_CONTAINER_CLI` at the binary.

Verify the boundary yourself: ask for a command through the tools API, or run the
container directly.

```bash
curl -s -X POST http://127.0.0.1:8787/api/runs/<run-id>/tools \
  -H 'Content-Type: application/json' \
  -d '{"name":"shell.exec","agentId":"builder","input":{"command":"sh","args":["-c","echo kernel=$(uname -s) uid=$(id -u)"]}}'
```

A working boundary answers `kernel=Linux uid=1000` and reports `"boundary":"container"`.
A command that does not exist in the image fails with `executable file not found`,
which is the proof that nothing ran on the host.

## Cost, budgets, and traces

Every model call — chat, planning, and each worker step — is written to a ledger
with its token counts, latency, and computed cost. The run header shows the
running total, and `GET /api/runs/:id/trace` returns the full trace.

Two things are deliberate:

- **An unknown model is "unpriced", not free.** If a model has no known price the
  call is recorded with `priced: false` and `costUsd: null`, the run header says
  *some unpriced*, and a run with a budget emits `run.budget.unmeasurable` to say
  its spend is only a lower bound. Silent zeros would let a budget quietly do
  nothing, which is worse than having no budget.
- **Prices are approximate.** The built-in table (`server/pricing.mjs`) holds
  published list prices, not a live feed, and providers change them. Override any
  entry with `FULKRUM_PRICE_FILE`, a JSON map of model → `{input, output,
  cacheRead, cacheWrite}` in USD per million tokens. Costs also do not include
  cache-write pricing subtleties beyond the factors in that table.

Set a ceiling with `FULKRUM_RUN_BUDGET_USD` (per run), `FULKRUM_DAILY_BUDGET_USD`
(across all runs today), or `set-budget` on a single run. When a ceiling is
reached the run stops in a `budget_exceeded` state, tasks it already finished are
kept, the refused task is marked `blocked`, and the control room offers **Raise &
resume** or **Stop**. Because cost is only known after a call, a run can overshoot
a ceiling by at most one call.

Traces are spans using the OpenTelemetry GenAI attribute names
(`gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.usage.*`,
`gen_ai.tool.name`), so a local trace can be exported later without rewriting what
was recorded. Prompt and completion content is **not** stored.

## Data and the audit log

Runs, messages, provider definitions, tool calls, and audit events are stored in
`data/fulkrum.sqlite` by default; override with `FULKRUM_DB_PATH`. The database
runs in WAL mode and is checkpointed on shutdown.

Every broker-mediated action is appended to a hash-chained event log, so edits
and deletions are detectable: `npm run audit:verify` recomputes the chain and
exits non-zero on a mismatch. Events written before chaining existed are reported
as unverifiable rather than assumed intact.

`SECURITY.md` documents the threat model, the controls, and — importantly — what
the audit log does **not** cover.

## Current limits

- **Execution is host-restricted.** `shell.exec` is limited to read-only `git status`, `git diff`, and `git log` with a validated argument vector, so no worker can currently run an arbitrary command. Windows has no OS sandbox primitive (no Seatbelt, Landlock, or bubblewrap), so general command execution is deliberately absent rather than run unsandboxed. The container runner is the next phase; `FULKRUM_RUNNER_IMAGE` and friends are reserved in `.env.example`.
- **No cost accounting yet.** The Autopilot description mentions budget boundaries; nothing enforces a budget so far, and token usage is captured but not priced.
- **The UI still carries placeholder identity.** Names such as "Atlas studio" and "Alex Rivera" are hardcoded in the interface, and the artifacts view is not built.
- **Plan quality depends on the model.** With no provider key the workers cannot run at all, and the plan falls back to a labelled template. When a model plan cannot be parsed, the fallback is recorded in the audit log rather than hidden.
