# 0007. The audit chain records hashes of tool results

## Context

The chain commits to every event, including tool results, which is what makes an
edited result detectable. But a chain cannot be pruned without breaking every link
after the pruned event, so retention could not shrink anything: the outputs were on
the tool call (prunable) **and** inside the chain (not prunable), and a two-week-old
run kept both. A pruned credential stayed in the log, which is the opposite of what
redaction and retention were for.

## Decision

The chain records the **hash and size** of a tool result, never its bytes. The bytes
live on the tool call where the retention window can reach them, and the artifact
diff reads the original arguments from their own table. Raw tool inputs whose bulk is
file content get the same treatment. Verification still recomputes each event's hash,
so an altered result is exactly as detectable; what changes is that a pruned result
leaves a committed hash behind rather than a copy of its content.

Verification compares the chain head against two anchors: a row in the database, and
an append-only file beside it. Deleting the row together with the events used to erase
every trace; the file is what makes that detectable, and an anchor with no row is now
reported as its own finding.

## Consequences

- Retention now shrinks the database, and a pruned secret is gone rather than archived.
- An auditor can prove *that* a result existed and that it has not changed, but cannot
  read it back after the retention window. That is the trade the policy asks for.
- The chain is still only as trustworthy as the machine it is written on: both anchors
  are local files, and signing them with a key that lives next to them would add
  little. `SECURITY.md` says this rather than implying more.
