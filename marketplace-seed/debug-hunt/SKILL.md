---
name: debug-hunt
description: Systematic root-cause debugging for failures, regressions, and flaky tests. Use when something breaks and the cause is unknown.
license: MIT
compatibility: Works anywhere you can read code and run commands.
metadata:
  author: fulkrum
  version: "1.0.0"
---

# Debug hunt

Reproduce first, hypothesize second, fix last.

1. **Reproduce.** Get the failure on demand with the smallest possible trigger. If it is flaky, loop it until you can make it fail within minutes — an unreproducible bug is an unfixable bug.
2. **Narrow.** Bisect: halve the suspect surface each step (files, commits, inputs, flags). Read the actual error and the actual code path; do not guess from the symptom.
3. **Hypothesize in writing.** State the single most likely cause before changing anything, and what evidence would disprove it. If the evidence disproves it, discard the hypothesis, not the evidence.
4. **Fix one thing.** Change the cause, not the symptom. Add a regression test that fails without the fix.
5. **Confirm.** Re-run the reproduction, the new test, and the surrounding suite. Check for the same failure class nearby — bugs cluster.

Edge cases: when the trail contradicts an earlier claim, trust the evidence and say what changed. When stuck after three hypotheses, widen the surface (environment, versions, concurrency) instead of deepening the same hole.
