# 0002. An approval binds to a fingerprint of the resolved arguments

## Context

The first version asked the model what it wanted to do, showed that to the user, and
then executed `body.input` from the approval request. Approving one call could run
another, and the audit record described something the executed call had not done.
This is not hypothetical: it is the class that CVE-2025-54136 (Cursor) and
CVE-2025-53773 (Copilot) come from — approval is the place where the model's intent
and the user's decision are supposed to meet.

## Decision

Every tool call is resolved into what will actually run — absolute paths, the final
argv, the destination host, and the hash of any written content — and the
**fingerprint** is a hash of that resolution. It is computed when the call is
requested, shown to the user, and re-derived at approval time; a mismatch is a 409
and the call is denied rather than executed. The execution reads the same resolution
the user approved, and the original arguments are stored separately from the redacted
copy so that redaction cannot change what a write produces.

## Consequences

- The approval prompt shows resolved arguments, never the model's paraphrase.
- A row edited after the fact is detected: the fingerprint no longer matches, so the
  call cannot run.
- The UI has to render resolutions rather than inputs, which is more work but is the
  only way the two cannot diverge.
- A grant for the rest of a run is still bound to the tool *shape*, so it can only
  ever soften an `ask` — see [0003](0003-deny-ask-allow-one-table.md).
