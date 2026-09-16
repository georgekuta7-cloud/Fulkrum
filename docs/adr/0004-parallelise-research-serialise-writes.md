# 0004. Research parallelizes; writing serializes

## Context

Multi-agent is contested. Cognition argues against it outright; Anthropic reports
large gains but only for breadth-first tasks that do not need shared context, and
notes that most coding work has few truly parallelizable tasks. What everyone agrees
on is where parallelism stops being free: two writers touching the same files produce
conflicts that no amount of orchestration makes pleasant, and a supervisor that has to
reconcile disagreeing writers produces a worse answer than one writer would have.

## Decision

Tasks in a plan are ordered into layers by their dependencies. Within a layer,
read-only tasks run concurrently (up to `FULKRUM_MAX_PARALLEL_RESEARCHERS`, default
3), and tasks that write run one at a time. Each task's dependencies are passed to it
as handoff context, so a writer starts from the researchers' findings rather than
re-deriving them.

## Consequences

- The plan, not a heuristic, decides what runs concurrently: a task that declares
  itself a reader is one.
- Parallel readers each hold their own context and their own budget reservation, so
  the cost model had to become concurrency-aware (see the reservation in
  `orchestrator.mjs`).
- A plan whose writers all depend on each other degenerates to sequential, which is
  the correct outcome rather than a failure.
- The product copy says "parallelize research, serialize the build" because that is
  what the scheduler actually does; marketing that claims more would be false.
