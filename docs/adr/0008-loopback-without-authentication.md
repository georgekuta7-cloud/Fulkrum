# 0008. The local API is loopback-only and unauthenticated

## Context

The bridge is a local HTTP server that can start runs, approve tool calls, and read
the database. It binds `127.0.0.1` and checks the `Origin` header of browser requests,
which stops a web page from driving it. It does not authenticate anything: any process
on the machine can call it, including approving a write or a command. For a single-user
desktop tool that is a deliberate position — but it is a position, not an accident, and
it has to be stated or it becomes a false assumption.

## Decision

Keep it as it is, and say so:

- The origin check is **CSRF protection, not access control**. Loopback binding is the
  actual barrier.
- The boot log states that there is no authentication and what that means, so nobody
  has to discover it.
- `SECURITY.md` lists it as a deliberate limit, and `GET /api/config` shows the origin
  allowlist so the one control that does exist is visible.

A per-boot bearer token was considered and rejected for now: it breaks `curl` and every
script against the bridge, and the threat it addresses — a malicious local process
running as the same user — can read the token file anyway. It would add friction to the
common case for a partial gain. If the bridge is ever exposed beyond loopback, that
changes, and the token becomes necessary rather than optional.

## Consequences

- Do not run untrusted code on the same machine while Fulkrum is running. The boot log
  says this too.
- Anything that needs to be authoritative must be enforced where the work happens —
  the permission matrix, the container, and the address pinning — because the API
  itself is not a trust boundary.
- If a future version adds multi-user or remote access, this ADR is the one that must
  be superseded first.
