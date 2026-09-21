---
name: tdd-autopilot
description: Red-green-refactor discipline for code tasks. Use when implementing features, fixing bugs, or changing behavior covered by tests.
license: MIT
compatibility: Works with any project that has a test runner.
metadata:
  author: fulkrum
  version: "1.0.0"
---

# TDD autopilot

Write the failing test first, then the smallest change that passes, then refactor.

1. **Red.** Add or update a test that captures the desired behavior. Run it and watch it fail for the right reason — a test that passes before the fix proves nothing.
2. **Green.** Make the minimal production change. No refactoring, no adjacent cleanup, no new abstractions while red.
3. **Refactor.** With green tests, clean up duplication and naming. Re-run the full suite after every refactor step.
4. **Verify.** Run typecheck, lint, and the full test suite before declaring done. A green subset is not done.

Edge cases: when no test harness exists, write the reproduction as a script first and treat its output as the test. When fixing a regression, add the test before touching the fix so the suite guards the boundary going forward.
