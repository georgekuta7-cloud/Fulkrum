# ADRs

Decisions that shape Fulkrum, with the reasoning that produced them. Each is small
on purpose: the point is to record why, not to restate the code.

| # | Decision |
| --- | --- |
| [0001](0001-container-is-the-execution-boundary.md) | A container is the execution boundary, not an argument allowlist |
| [0002](0002-approvals-bind-to-a-fingerprint.md) | An approval binds to a fingerprint of the resolved arguments |
| [0003](0003-deny-ask-allow-one-table.md) | One permission matrix, deny → ask → allow, first match wins |
| [0004](0004-parallelise-research-serialise-writes.md) | Research parallelizes; writing serializes |
| [0005](0005-wsl2-is-not-the-boundary.md) | WSL2 hosts the engine but is not the boundary |
| [0006](0006-node-sqlite.md) | `node:sqlite` instead of a native module |
| [0007](0007-chain-records-hashes.md) | The audit chain records hashes of tool results |
| [0008](0008-loopback-without-authentication.md) | The local API is loopback-only and unauthenticated |
