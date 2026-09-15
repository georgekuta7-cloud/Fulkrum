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
npm test          # 33 tests: policy, persistence, and the HTTP API
npm run lint
npm run build
npm run audit:verify   # prove the run event log has not been edited
```

`npm test` boots the real API bridge on an ephemeral port against a temporary
database and workspace, so the tests never touch your data.

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
one payload cannot run a different one.

**Interrupted runs are recoverable.** A run holds a lease while it works. If the
bridge is killed mid-run, the next start marks the run `interrupted` instead of
leaving it looking alive forever, and the control room offers **Resume** (which
continues from the last completed step) or **Abandon**.

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

- **Execution is host-restricted.** `shell.exec` is limited to read-only `git status`, `git diff`, and `git log` with a validated argument vector. Windows has no OS sandbox primitive (no Seatbelt, Landlock, or bubblewrap), so general command execution is deliberately absent rather than run unsandboxed. The container runner is the next phase; `FULKRUM_RUNNER_IMAGE` and friends are reserved in `.env.example`.
- **Workers still use fixed tools.** The research and build workers each call one preconfigured tool rather than choosing tools themselves, so the approval-and-resume path stays dormant in a normal run.
- **No cost accounting yet.** The Autopilot description mentions budget boundaries; nothing enforces a budget so far.
- **The UI carries placeholder identity.** Names such as "Atlas studio" and "Alex Rivera" are still hardcoded in the interface.
