# 0001. A container is the execution boundary, not an argument allowlist

## Context

Agents need to run commands: build, test, inspect a repository. The first version
allowed a fixed set of read-only git commands with a validated argument vector, on
the host. That was survivable rather than contained — a pager, a repository hook, a
`.gitattributes` textconv driver, or `--no-index` each offered a way out, and every
one of them was found by review rather than by design. Windows has no Seatbelt,
Landlock, or bubblewrap, so there was no way to sandbox a child process in place.

## Decision

Command execution happens only inside a fresh container per command. The argv is an
array, passed straight to the engine, so no shell interprets it on either side. The
container has no network, a read-only root filesystem with only the workspace
mounted writable, a non-root user, all capabilities dropped, `no-new-privileges`,
process/memory/CPU/descriptor limits, and a wall-clock timeout that stops and
removes it. With no engine reachable, execution is **disabled** and the app says so;
it never falls back to the host.

## Consequences

- The command surface is deliberately open: the containment does the work, so there
  is no argument allowlist to escape. The README says this plainly.
- The boundary is only as good as the image. The base is pinned by digest, the image
  must be present before anything runs, and its digest and id are reported at boot.
- Anything the agent installs into the container is gone when the command ends; a
  build that needs a warm cache pays for it each time. `HOME` is a tmpfs with exec
  allowed, which is what makes `npm`, `pip`, and `cargo` work at all under a
  read-only root.
- A user with no engine gets a smaller product, not a less safe one.
