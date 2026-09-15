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
   diverge.
4. **Arbitrary command execution is not available on the host.** `shell.exec` is
   limited to a fixed set of read-only git subcommands, and the whole argument
   vector is validated, not just the first element. General code execution is
   planned to run inside a container (see "Execution boundary" below); until
   that lands, the capability is absent rather than unsandboxed.
5. **Egress is default-deny** and is the last line of defense. The `http.request`
   tool refuses private, loopback, link-local, and multicast targets, validates
   every redirect hop, and requires an explicit host allowlist.
6. **Secrets are not readable by tools.** Known credential paths are refused at
   the tool boundary, and tool output is scanned for credential shapes before it
   reaches the model or the audit log.

## Execution boundary

Windows has no equivalent of macOS Seatbelt or Linux Landlock/bubblewrap, so
there is no cheap way to sandbox a child process on this platform. Command
execution is therefore designed to run inside a container (one container per
run, read-only root filesystem, workspace mounted read-write, no network by
default, non-root user, dropped capabilities, resource limits).

Until that runner is implemented, Fulkrum does not execute arbitrary commands at
all: the only shell capability is the read-only git subset described above. When
the container runner lands, this section will describe how to verify it, and the
`FULKRUM_*` variables that control it are already reserved in `.env.example`
(`FULKRUM_RUNNER_IMAGE`, `FULKRUM_CONTAINER_MEMORY`, `FULKRUM_CONTAINER_CPUS`,
`FULKRUM_EXEC_TIMEOUT_MS`).

## What the audit log does and does not cover

Every broker-mediated action is recorded in an append-only, hash-chained event
log. Each event commits to the hash of the event before it, so edits, deletions,
and reordering are detectable. Run `npm run audit:verify` to check a database.

It does **not** cover:

- Anything that happens outside the broker. While execution runs on the host the
  agents cannot spawn processes at all, so this gap is currently closed by
  capability removal rather than by monitoring.
- Model reasoning or the contents of prompts, which are not stored.
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
