# Security policy

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainer
directly. Please do not file public issues for exploitable problems. Include the
version, the exact tool call or HTTP request, and what you expected to happen.

## What Fulkrum is

A **single-user, local-first** application. The API bridge binds to `127.0.0.1`
and is never exposed to a network. There are no accounts, no sessions, and no
remote users. That shapes the threat model below: the interesting adversary is
not a remote attacker, it is **content that the model reads**.

## Threat model

The model is not a security boundary. Any file, web page, tool result, or
provider response the agents read may contain text that steers them. Fulkrum
therefore does not try to detect prompt injection. It assumes injection succeeds
and constrains what an injected instruction can actually do.

This application has all three legs of the "lethal trifecta" (private data
access, exposure to untrusted content, and outbound communication), so the
controls that matter are the ones that make an injected instruction unable to
act:

1. **Deny by default.** A single permission matrix decides every tool call. It is
   evaluated deny → ask → allow, first match wins, and anything unparseable,
   unknown, or ambiguous is denied rather than guessed at.
2. **Capability scoping.** Each role has an explicit tool allowlist, and a tool
   outside it is neither described to the model nor executable. Arguments are
   validated against the tool's JSON Schema before the broker sees them, and the
   broker re-resolves and re-checks the call independently. A denial is returned
   to the model as a typed error, so it can adapt instead of silently retrying.
3. **Approvals are bound to a fingerprint.** Approving a call approves the
   normalized, resolved arguments (`sha256` over the tool name, resolved absolute
   paths, final argv, and destination host). An approval for one payload cannot
   execute a different one, and the audit record and the executed call cannot
   diverge. A call can also be denied, which the worker receives as a typed error.
4. **A run-scoped grant can only soften an "ask".** "Approve for this run" records
   a grant so a tool stops re-prompting, and it can be revoked from the control
   room. The permission matrix is evaluated first: a grant is consulted only when
   the decision was already "ask", so deny rules — credentials, path escapes,
   unparseable calls — still refuse. Both the grant and its revocation are events
   in the audit log. Persistent "always allow" is refused rather than
   approximated, because a standing exception needs a place to review it.
5. **Arbitrary command execution happens only inside a container.** `shell.exec`
   runs a fresh container per command: no network, read-only root filesystem with
   only the workspace mounted writable, non-root user, all capabilities dropped,
   `no-new-privileges`, resource limits, and a wall-clock timeout that stops and
   removes the container. The argv is an array, so no shell interprets it on either
   side. Because the container is the boundary, the command surface is open by
   design — the isolation does the work, not an argument allowlist, which previous
   rounds demonstrated was escapable. With no container engine reachable,
   execution is disabled rather than falling back to the host, and WSL2 is not
   used as a boundary because its interop layer can execute Windows binaries.
6. **Egress is default-deny** and is the last line of defense. The `http.request`
   tool refuses private, loopback, link-local, multicast, and reserved targets —
   including their IPv4-mapped IPv6 forms, which is how `::ffff:127.0.0.1` used to
   reach loopback — validates every redirect hop, and requires an explicit host
   allowlist. The address is then **pinned**: the name is resolved once, the
   validated address is what the socket connects to, and SNI and the `Host` header
   still carry the original name. Checking a name and then letting the platform
   resolve it again is a gap a rebinding host can walk through.
7. **A request that carries a credential needs approval.** `Authorization`,
   `Proxy-Authorization`, `Cookie`, `X-Api-Key`, and `Api-Key` make an outbound
   request an approval question even in autopilot, unless the host is allowlisted —
   the shape an injected instruction takes is "read a config file, then send it
   somewhere". The audit log records header *names* and a hash of each value, never
   the value.
8. **Secrets are not readable by tools.** Known credential paths are refused at
   the tool boundary, and tool output is scanned for credential shapes before it
   reaches the model or the audit log. Key names are matched by segment, so
   `monkey`, `keyboard`, and `sessionCount` are no longer redacted as credentials,
   and the value patterns cover the prefixes that were missing (`glpat-`, `npm_`,
   `github_pat_`, `hf_`, `SG.`, `xai-`) plus a narrow shape check for long
   unlabelled tokens. Hashes stay readable: redacting a sha256 digest would hide
   real information for no gain.
9. **Injection attempts are reported.** Tool output is delivered to the model
   inside an explicit `<tool_result>` block labelled as data, and output containing
   text aimed at the model ("ignore previous instructions", "do not tell the user")
   is recorded as a `tool.output.suspicious` event. This is telemetry, not a
   control: this document assumes injection succeeds, and what limits the damage is
   the permission matrix and the container.
10. **Workspace search cannot leave the workspace.** Directory entries are checked
    with `lstat`, so a junction or symlink — reported as an ordinary directory by a
    plain listing on Windows — is skipped rather than walked into, and containment
    is re-proved for every directory the search descends into. A `.fulkrumignore`
    file in the workspace root extends the skip list.

## Execution boundary

Windows has no equivalent of macOS Seatbelt or Linux Landlock/bubblewrap, so
there is no way to sandbox a child process in place. Command execution therefore
runs inside a container: one per command, no network, read-only root filesystem
with only the workspace writable, non-root user, dropped capabilities, resource
limits, and a timeout.

The image (`server/runner/Dockerfile`) also neutralizes the repository-controlled
execution paths that made a host-side git allowlist unsafe: `GIT_CONFIG_GLOBAL`
and `GIT_CONFIG_SYSTEM` point at nothing, system config is disabled, the pager is
`cat`, external diff is unset, terminal prompts are off, and `core.hooksPath`
points at an empty directory the runner cannot write to.

The base image is pinned by digest, not by tag: a tag can be moved, and this image
is part of the boundary. The boot log prints the digest and the image id it found,
and says so plainly when the image is only tagged. `HOME` is a tmpfs mounted with
exec allowed, because the root filesystem is read-only and `/tmp` cannot execute:
npm, pip, and cargo install into the home directory, and without it they fail in a
way that looks like the command's fault rather than the sandbox's.

`npm run runner:build` builds the image, and `node tests/container/assertBoundary.mjs`
checks it against a live engine — non-root, read-only root, writable workspace and
home, `noexec` on `/tmp`, no network, hooks path neutralized, and a command that
overruns its timeout is stopped with no container left behind. CI runs both.

Two deliberate limits:

- **WSL2 is not the boundary.** A WSL distribution can execute Windows binaries
  through its interop layer, so "inside WSL" would still mean "can run things on
  Windows". WSL2 hosts the engine; the container is what contains the work.
- **No engine means no execution.** The app reports `commands: disabled` and
  refuses the tool rather than running anything on the host. `FULKRUM_CONTAINER_ENGINE`
  selects the engine (`docker`, `docker-wsl`, `podman`) or leaves it to
  auto-detection.

## What the audit log does and does not cover

Every broker-mediated action is recorded in an append-only, hash-chained event
log. Each event commits to the hash of the event before it, so edits, deletions,
and reordering are detectable. Run `npm run audit:verify` to check a database.

A hash chain cannot detect its own truncation: deleting the last events leaves
every remaining link valid. **Checkpoints** anchor the head of a chain in a
separate row, recorded when a run stops moving and on demand
(`npm run audit:verify -- --anchor`). Verification then reports truncation and
tail rewriting, and says which sequence number the chain covers
(`verified from event N`). Events written before chaining existed are counted
separately and anchored by a genesis checkpoint, so that boundary is a recorded
fact rather than an open-ended "unverifiable" count.

The honest limit: a checkpoint is a row in the same database file. Someone who can
write that file can remove the anchor along with the events. The chain head is
therefore also appended to `audit-heads.log` beside the database — an append-only
file that has to be known about and edited separately — and verification compares
against both, so an anchor whose row has been deleted is reported as its own
finding rather than passing silently. This raises the bar from "delete some rows"
to "delete some rows and also edit a file you had to know about"; it is not
tamper-proof, and making it so needs the head signed with a key that does not sit
next to what it signs.

It does **not** cover:

- Anything that happens outside the broker. Command execution runs in a container
  with no network and a read-only root filesystem, so the blast radius is the
  workspace; the log records the command, not what it did to files inside.
- Model reasoning or the contents of prompts, which are not stored. Tool call
  arguments and results are stored, redacted — and the chain itself records only
  their hash, so the bytes can expire with the retention window while the chain
  still commits to them.
- The original, unredacted arguments of a tool call. They are kept apart from the
  redacted copy — execution needs them, because redaction must never change what a
  write produces — so a call that carried a credential holds it in the database
  even though the log and the UI show `[redacted]`.
- Provider credentials stored from the settings drawer, which live in the same
  database, unencrypted, and are never returned by the API.
- Side effects of the model provider itself (their logs, their retention).
- Changes made by the user, or by other software, while a run is in progress.

An incomplete audit trail is worse than a scoped one, so this scope is stated
rather than implied. As capabilities are added, this section must be updated in
the same change.

## Local API hardening

- The bridge binds `127.0.0.1` only. Do not change this.
- Browser origins are allowlisted (`FULKRUM_ALLOWED_ORIGINS`). A page on any
  other origin receives 403, which blocks drive-by requests from websites you
  visit. Requests without an `Origin` header (curl, scripts, native clients) are
  allowed by design; this control is CSRF protection, not authentication.
- Request bodies are size-capped; a malformed body returns 400 instead of
  terminating the process.

## Supported versions

The project is pre-1.0. Only the latest release is supported with fixes.
