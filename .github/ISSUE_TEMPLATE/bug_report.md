---
name: Bug report
about: Something did not do what it should
labels: bug
---

**What happened**

**What you expected**

**How to reproduce**
The smallest sequence: the direction you gave, the mode, and what the run did. If it
came from the API, the request and the response body are ideal.

**Where it happened**
- Version or commit:
- How it runs: `npm run dev` / `npm start` / `npm run api`
- Node version (`node --version`):
- Container engine, if agent commands are involved (`docker version`):
- Model and provider route, if a run is involved:

**What the audit log says**
`npm run audit:verify` and the run's report (`GET /api/runs/:id/report?format=md`)
usually narrow it down. Paste what is relevant, and please remove anything private
first.
