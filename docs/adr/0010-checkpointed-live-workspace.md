# 0010. The live workspace is checkpointed by a private shadow Git

## Context

The owner decision for this phase: **one live workspace**, no staging copies, no
worktrees, no branches. That is consistent with the existing decisions — writes
already serialize ([0004](0004-parallelise-research-serialise-writes.md)), and
worktrees were cut from the roadmap because they contradict the
execution-boundary model ([0001](0001-container-is-the-execution-boundary.md)).

But a live workspace written by agents needs an undo that is itself provable.
Artifacts and reverts exist for writes the tools recorded; they cannot recover
from a shell side effect, an edit made outside the app, or a write whose
record is in doubt. Restore must be a link, not a time machine that lies —
and it must not require the user's repository to be a Git repository at all.

Three constraints shaped the design, each from a review finding:

- Host Git configuration must not leak into checkpointing: a global
  `core.autocrlf`, hooks, or signing config could silently alter what is
  snapshotted or run user code.
- Windows line-ending translation must not poison the hashes: a checkpoint
  that differs from the bytes on disk is not a checkpoint.
- Checkpoint storage is unbounded unless said otherwise: it lives in the data
  directory, so its cost must be visible and its growth controllable.

## Decision

A single private **shadow Git repository** per bridge, living under the data
directory (`<FULKRUM_DATA_DIR>/checkpoints/`), with the live workspace as its
work tree. It is not the user's repository, never appears inside the workspace,
and never consults the user's Git state. Concretely:

1. **The index persists in the data directory** (`GIT_INDEX_FILE`), not in the
   workspace. Commits after adding only the paths a write touched still
   snapshot the whole tree, because the index accumulates every tracked path
   across the bridge's life. A checkpoint costs the size of the change, not
   the size of the tree.
2. **Every Git invocation is neutralized.** `GIT_CONFIG_GLOBAL` and
   `GIT_CONFIG_SYSTEM` point at the null device, `GIT_CONFIG_NOSYSTEM=1` and
   `GIT_TERMINAL_PROMPT=0` are set, hooks are disabled, and signing is off.
   Repository-local config pins `user.name`/`user.email`,
   `core.autocrlf=false`, `core.fileMode=false`, and `core.quotepath=false`.
3. **Host Git is a hard requirement for write runs.** Without it, a write is
   refused with a clear error; reading and planning still work. A write that
   cannot be checkpointed is a write that cannot be undone, and provability
   outranks convenience ([0009](0009-provable-work.md)).
4. **The coverage vocabulary is exactly what the tools can touch**: the
   workspace's `.fulkrumignore` rules, the skipped directories
   (`.git`, `node_modules`, `dist`, `coverage`, `.cache`), the sensitive-file
   patterns, and the data directory are excluded through the shadow
   repository's own `info/exclude`. The workspace's `.gitignore` is honored
   read-only — its lines join the same exclude file, refreshed before every
   baseline — and no `.gitignore` is ever written or created by Fulkrum. The
   exclude file is the only vocabulary the shadow repository uses.
5. **A checkpoint is a commit bound to its cause.** The commit message names
   the run, task, and tool call that produced it, and the chain records a
   `checkpoint.created` event naming the commit (`run.checkpoint` is already
   the Head's repair/replan/stop decision, and is an audit anchor point).
   Checkpointing happens after a successful write; if it fails, the run is
   interrupted with that reason rather than continuing over unrecorded state.
   A write-capable run **starts** with a baseline checkpoint — a full
   snapshot of covered content — recorded as `checkpoint.baseline` and kept
   under one private ref per run (`refs/runs/<id>`), so a resumed run keeps
   its original baseline across restarts. A run whose baseline cannot be
   taken does not start: it is interrupted with the reason on the chain
   (`checkpoint.failed`).
6. **Restore is an explicit, recorded human action.** It checkpoints the
   current state first, then checks out the named paths from the named commit,
   and records a `checkpoint.restored` event. It is never a chain rewrite, and
   agents cannot call it: it is not in the tool matrix.
7. **Disk usage is visible.** The status endpoint reports the shadow
   repository's size and checkpoint count, and the store is prunable.

## Consequences

- A restore in the Files view becomes a provable link: the commit, the event,
  and the file bytes agree.
- Phase 4's event-indexed reconstruction gets its substrate for free: the
  shadow repository is a tree-per-checkpoint store the chain already names.
- Shell side effects and out-of-band edits become recoverable for the first
  time, because checkpointing snapshots the tree, not the tool log.
- The data directory grows with change volume; the status line and pruning
  exist so that growth is a choice, not a surprise.
- A machine without Git can still plan and read, but cannot run a writing
  run — the refusal says exactly that.
