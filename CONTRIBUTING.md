# Contributing

Fulkrum is a single-user, local-first tool, and the code is written to be read by
whoever has to change it next. That shapes the conventions below more than any style
guide would.

## Getting set up

```powershell
npm install
npm run dev        # Vite on 5173, the bridge on 8787
```

```powershell
npm test           # boots the real API on an ephemeral port against a temp database
npm run test:coverage
npm run lint
npm run typecheck  # the client, plus the server and tests via checkJs
npm run build
```

Agent commands need a container engine: `npm run runner:build` once, and
`node tests/container/assertBoundary.mjs` to check the boundary against a live engine.
Everything else works without one.

## What a change should look like

**Write down the why, not the what.** Comments explain a constraint the code cannot
show: why a rule is ordered the way it is, why a value is not trusted, what was tried
and did not work. A comment that restates the next line is noise the moment it is
merged.

**Prefer a test that would have caught the bug.** Almost every test here exists because
something failed — a crash on a malformed body, a truncated log verifying as healthy,
a uid that could not write to the workspace. Tests boot the real server, use the real
store, and drive real HTTP; if a test needs an engine, it says so and skips politely
when there is none.

**Change the security story in the same commit as the code.** `SECURITY.md` states what
is and is not protected. If a change moves that line — a new tool, a new outbound path,
a new stored field — the document moves with it. An incomplete audit trail is worse
than a scoped one, and a stale threat model is worse than both.

**Update `CHANGELOG.md`** under `Unreleased`, in the voice of the existing entries:
what changed and why it mattered, not a list of files.

**Keep the dependency graph at zero for the server.** It is plain `.mjs` with no
runtime dependencies, and that is a feature: nothing to audit, nothing to rebuild.
Client dependencies are fine when they earn their place.

## Conventions that are not obvious

- The server is JavaScript checked by `tsconfig.server.json` (`checkJs`, not strict).
  Type errors are real errors: a syntax error once reached the test suite before this
  existed.
- Settings are declared in `server/config.mjs`. Add a variable there, with its kind and
  default, and it is validated, reported by `GET /api/config`, and documented in one
  place. Modules may still read `process.env` where the value should be able to change
  without a restart — that is deliberate, not an oversight.
- New routes go in the docs list (`server/apiDocs.mjs`). A test calls every documented
  route, so the spec and the server cannot drift apart.
- Admins of this repository: keep `main` green. The pipeline runs lint, typecheck,
  tests, a build, coverage thresholds, and the container boundary check.

## Reporting something

Open an issue with what you expected, what happened, and the smallest thing that
reproduces it. For a security problem, please do not open an issue: the project has no
private channel configured yet, so state it as a minimal reproduction without a working
exploit and say that you have one.
