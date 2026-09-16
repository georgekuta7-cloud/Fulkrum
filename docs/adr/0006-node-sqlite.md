# 0006. `node:sqlite` instead of a native module

## Context

The store needs a transactional, embeddable database with a file the user can copy,
inspect, and back up. The obvious choices were `better-sqlite3` (fast, mature, a
native module with a build step) and `node:sqlite` (built in, no dependency, marked
*active development* by Node). A native module means a compiler or a prebuilt binary
for every platform the project runs on — Windows, Linux, and both under CI — and a
rebuild whenever Node's ABI moves.

## Decision

Use `node:sqlite`, with `engines` set to `>=22.13.0` (the release where it stopped
requiring `--experimental-sqlite`). The dependency graph for the server stays at zero.
Because the module is a built-in, a static import fails while Node links the module
graph, before any of our code can explain itself — so the import is dynamic and a
missing module produces one clear sentence naming the required version. A damaged file
is refused at boot by `PRAGMA quick_check` rather than failing later on a write, and a
backup can be taken at any time with `VACUUM INTO`.

## Consequences

- No build step, no ABI coupling, no native module in the supply chain. The price is a
  hard floor on the Node version, which the boot message states plainly.
- The API is marked active development, so a future Node release could change it. If
  that happens, the store is one file behind an interface the rest of the code does
  not see, and the fallback is a native module with the build step this avoided.
- Migrations, the hash chain, and the anchor file are ours either way, so they carry
  over unchanged.
