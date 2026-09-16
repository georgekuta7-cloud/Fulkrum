# 0003. One permission matrix, deny → ask → allow, first match wins

## Context

Authorization started as scattered `if` statements in the tool broker: reads allowed,
writes asked for, credentials refused. Every new tool, mode, or exception edited that
tangle, and the order of the checks decided the outcome in ways nobody could see.
The published semantics of Claude Code and Codex are both "deny rules first, then
ask, then allow, first match wins" — for the same reason: an exception must not be
able to weaken a refusal.

## Decision

`permissions.mjs` exports the policy as **data**: an ordered list of rules, each with
an id, a decision, a reason (which may be a function of the context), and a predicate.
Evaluation is first-match-wins over deny → ask → allow. Unknown tools, unresolvable
arguments, and sensitive paths are denied by the rules at the top rather than
special-cased. A run grant is consulted only when the decision was already `ask`, so
it can soften a prompt but never override a denial. The matrix is exported to the UI
(`GET /api/tools`) and to the tests, so all three read one source.

## Consequences

- A new rule is a new entry, not a new branch; the ordering is the precedence.
- The reason strings are user-facing, and each carries the rule id, so "why was this
  denied" is answerable from the call alone.
- Broad denies beat narrow allows by construction, which is why `deny.sensitive-path`
  cannot be undone by a `workspace.write` grant.
