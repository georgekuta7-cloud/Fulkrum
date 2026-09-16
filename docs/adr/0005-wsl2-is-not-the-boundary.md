# 0005. WSL2 hosts the container engine, but is not the boundary

## Context

On Windows, the practical way to get a container engine is Docker Desktop with the
WSL2 backend, or Docker installed inside a WSL distribution. It is tempting to treat
"it runs in WSL" as the sandbox: WSL is a real Linux kernel with namespaces, so a
process inside it is contained by Linux rules. But a WSL distribution can execute
Windows binaries through its interop layer (`/mnt/c/Windows/System32/*.exe`), and it
can reach the Windows filesystem. "Inside WSL" would therefore still mean "can run
things on the host".

## Decision

WSL2 is where the engine runs, never the boundary itself. The engine is detected in
this order: the Docker CLI on PATH, Podman on PATH, then Docker inside the default WSL
distribution. Everything a command runs in is a container, whichever of those
transports starts it, and the container arguments are built in one place so the
distinction cannot leak. Paths handed to a WSL-hosted engine are translated
(`D:\x` → `/mnt/d/x`) by matching the drive prefix as a string, because that
translation only makes sense for Windows paths and must behave identically when
exercised from a machine that is not Windows.

## Consequences

- A user who has WSL but no engine gets disabled execution rather than a false sense
  of containment.
- `FULKRUM_CONTAINER_ENGINE=docker-wsl` exists for setups where the engine is only
  reachable that way, and it is documented as a transport choice, not a security one.
- The Windows path translation is a small, testable function rather than a rule
  scattered through the runtime.
