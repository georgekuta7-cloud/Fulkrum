import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const defaultExecFile = promisify(execFileCallback)

/**
 * The execution boundary.
 *
 * Agent commands run inside a container, never on the host. Windows has no
 * equivalent of Seatbelt or Landlock, so a container is the only boundary
 * available, and an argument allowlist is not one: the git-only allowlist this
 * replaces was an escape surface (pager, hooks, textconv, --no-index) that
 * happened to be survivable rather than contained.
 *
 * WSL2 is not the boundary on its own. A WSL distribution can execute Windows
 * binaries through its interop layer, so "inside WSL" would still mean "can run
 * things on Windows". WSL2 is where the engine runs, not what contains it.
 *
 * When no engine is reachable, execution is disabled and says so. It never falls
 * back to the host.
 */

const engines = {
  docker: { label: 'Docker' },
  podman: { label: 'Podman' },
}

const defaultImage = process.env.FULKRUM_RUNNER_IMAGE ?? 'fulkrum-runner:local'
const containerWorkdir = '/workspace'
const maxOutputBytes = 100_000
// The uid the runtime uses inside the container. It has to match the owner of the
// bind-mounted workspace for writes to land, which is why it is derived rather
// than fixed: a rootless setup maps ids differently, and a CI checkout is owned by
// whoever ran it. FULKRUM_RUNNER_USER overrides this.
const configuredRuntimeUser = String(process.env.FULKRUM_RUNNER_USER ?? '').trim()
const fallbackRuntimeUser = '1000:1000'
const defaultNofile = Number(process.env.FULKRUM_RUNNER_NOFILE ?? 1024)

/**
 * Who a command runs as, when nothing is configured.
 *
 * A bind mount keeps the host's ownership, so a workspace owned by another uid is
 * writable only by that uid — the same image works for every owner. Windows has no
 * meaningful uid on a mount, so the conventional non-root id stands there.
 */
export function defaultUserForWorkspace(workspaceRoot) {
  if (process.platform === 'win32') return fallbackRuntimeUser
  try {
    const stats = statSync(workspaceRoot)
    if (stats.uid > 0) return `${stats.uid}:${stats.gid}`
  } catch {
    // A missing or unreadable workspace is reported by the command that needs it.
  }
  return fallbackRuntimeUser
}

/** Convert a Windows path to the path an engine running inside WSL sees. */
export function toEnginePath(target, { inWsl = false } = {}) {
  const raw = String(target)
  if (!inWsl) return path.resolve(raw)
  // Drive letters are matched on the string, not through the host's path rules:
  // this translation only makes sense for Windows paths, and it must behave the
  // same when it is exercised from a machine that is not Windows.
  const driveMatch = raw.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!driveMatch) return raw.replaceAll('\\', '/')
  return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2].replaceAll('\\', '/')}`
}

/**
 * The exact argv used for one agent command. Everything that makes the container
 * a boundary lives here, so a test can assert it rather than trust it.
 */
export function containerArgs({ argv, workspaceRoot, workdir = '.', image = defaultImage, network = 'none', inWsl = false, name = 'fulkrum-preview', memory = '2g', cpus = '2', pidsLimit = 256, runtimeUser = fallbackRuntimeUser, userNamespace = '', nofile = defaultNofile, runtime = '' }) {
  // Normalize backslashes: a Windows-style `src\utils` would produce an
  // invalid `--workdir /workspace/src\utils` inside a Linux container.
  const normalizedWorkdir = String(workdir).replaceAll('\\', '/')
  const containerDir = normalizedWorkdir.startsWith('/') ? normalizedWorkdir : `${containerWorkdir}/${normalizedWorkdir}`.replace(/\/+$/, '')
  return [
    'run',
    // A user-space kernel (gVisor's runsc) interposes syscalls between the
    // container and the host: stronger than namespaces alone, cheaper than a
    // microVM, and one flag because the rest of the boundary is unchanged.
    ...(runtime ? ['--runtime', runtime] : []),
    '--rm',
    '--name',
    name,
    '--network',
    network,
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    // HOME gets its own tmpfs with exec allowed. The root filesystem is read-only
    // and /tmp cannot execute, so a tool that installs into its home directory —
    // npm, pip, cargo — fails for a reason that looks like the command's fault.
    '--tmpfs',
    '/home/fulkrum:rw,exec,nosuid,size=256m,mode=1777',
    '--user',
    runtimeUser,
    ...(userNamespace ? ['--userns', userNamespace] : []),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(pidsLimit),
    '--ulimit',
    `nofile=${nofile}:${nofile}`,
    '--memory',
    memory,
    '--cpus',
    cpus,
    '--workdir',
    containerDir || containerWorkdir,
    '--volume',
    `${toEnginePath(workspaceRoot, { inWsl })}:${containerWorkdir}:rw`,
    image,
    ...argv,
  ]
}

function clip(text, maximum = maxOutputBytes) {
  const value = typeof text === 'string' ? text : ''
  return value.length > maximum ? `${value.slice(0, maximum)}\n[output clipped]` : value
}

/**
 * @param {{
 *   engine?: string,
 *   cliPath?: string,
 *   image?: string,
 *   workspaceRoot?: string,
 *   memory?: string,
 *   cpus?: string,
 *   pidsLimit?: number,
 *   runtimeUser?: string,
 *   userNamespace?: string,
 *   nofile?: number,
 *   runtime?: string,
 *   defaultTimeoutMs?: number,
 *   failureTtlMs?: number,
 *   execFileImpl?: (file: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout?: string, stderr?: string }>
 * }} [options] Injectable so tests can exercise detection and execution without an engine.
 */
export function createExecutionRuntime({
  engine = process.env.FULKRUM_CONTAINER_ENGINE ?? '',
  // An absolute path to the engine CLI. On Windows the CLI is often installed
  // into a per-user directory that a non-interactive shell does not have on PATH,
  // which shows up as `spawn docker ENOENT` even though Docker is installed.
  cliPath = process.env.FULKRUM_CONTAINER_CLI ?? '',
  image = defaultImage,
  workspaceRoot = process.cwd(),
  memory = process.env.FULKRUM_CONTAINER_MEMORY ?? '2g',
  cpus = process.env.FULKRUM_CONTAINER_CPUS ?? '2',
  pidsLimit = Number(process.env.FULKRUM_CONTAINER_PIDS ?? 256),
  runtimeUser = configuredRuntimeUser,
  userNamespace = process.env.FULKRUM_RUNNER_USERNS ?? '',
  nofile = defaultNofile,
  runtime: configuredRuntime = process.env.FULKRUM_CONTAINER_RUNTIME ?? '',
  defaultTimeoutMs = Number(process.env.FULKRUM_EXEC_TIMEOUT_MS ?? 120_000),
  // A success is cached for the process lifetime; a failure is re-probed, so
  // installing an engine does not require restarting the bridge.
  failureTtlMs = Number(process.env.FULKRUM_ENGINE_RETRY_MS ?? 30_000),
  execFileImpl = defaultExecFile,
} = {}) {
  const requested = String(engine).trim()
  const explicitCli = String(cliPath).trim()
  const containerRuntime = String(configuredRuntime).trim()
  let detected = null
  /**
   * Containers that are running right now, by run id.
   *
   * A cancelled run used to leave its command running to completion or to its
   * timeout: the run stopped, the work did not. Keyed by run so a cancel can find
   * them, and a set per run because a run is not guaranteed to have only one in
   * flight forever — an overwritten entry would be a container nobody could stop.
   */
  const running = new Map()

  /** The configured uid, or the one that owns the workspace it has to write to. */
  const effectiveUser = () => String(runtimeUser).trim() || defaultUserForWorkspace(workspaceRoot)

  /** Which transports to try, in order. 'docker-wsl' means the engine lives in WSL. */
  const candidates = () => {
    if (requested === 'docker-wsl') return [{ id: 'docker', viaWsl: true }]
    if (engines[requested]) return [{ id: requested, viaWsl: false }]
    // With an explicit CLI path there is nothing to guess.
    if (explicitCli) return [{ id: 'docker', viaWsl: false }]
    return [
      { id: 'docker', viaWsl: false },
      { id: 'podman', viaWsl: false },
      { id: 'docker', viaWsl: true },
    ]
  }

  const invoke = (candidate, args, options) => (candidate.viaWsl
    ? execFileImpl('wsl.exe', ['--exec', candidate.id, ...args], options)
    : execFileImpl(explicitCli || candidate.id, args, options))

  const runtime = {
    image,

    /** Which engine is usable, and why not when none is. */
    async detect({ refresh = false } = {}) {
      if (detected && !refresh) {
        const fresh = detected.available || Date.now() - detected.checkedAt < failureTtlMs
        if (fresh) return detected
      }

      const failures = []
      for (const candidate of candidates()) {
        const label = `${engines[candidate.id].label}${candidate.viaWsl ? ' (inside WSL)' : ''}`
        try {
          const result = await invoke(candidate, ['version', '--format', '{{.Server.Version}}'], { timeout: 8_000, windowsHide: true })
          const version = String(result.stdout ?? '').trim().split('\n')[0]
          if (!version) {
            failures.push(`${label} reported no version`)
            continue
          }

          // The image is part of the boundary, so its presence and identity are
          // checked at detection time rather than discovered by the first command.
          let imageId = null
          try {
            const inspected = await invoke(candidate, ['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 8_000, windowsHide: true })
            imageId = String(inspected.stdout ?? '').trim().split('\n')[0] || null
          } catch {
            failures.push(`${label}: the runner image "${image}" is not present (build it with \`npm run runner:build\`)`)
            continue
          }

          // A locally built image has no repository digest until it is pushed, so
          // this reports what is known instead of inventing an identifier.
          let imageDigest = null
          try {
            const digests = await invoke(candidate, ['image', 'inspect', '--format', '{{json .RepoDigests}}', image], { timeout: 8_000, windowsHide: true })
            const parsed = JSON.parse(String(digests.stdout ?? '[]').trim() || '[]')
            if (Array.isArray(parsed) && parsed.length) imageDigest = String(parsed[0])
          } catch {
            imageDigest = null
          }

          detected = { available: true, engine: candidate.id, label, version, image, imageId, imageDigest, network: 'none', checkedAt: Date.now(), ...candidate }
          return detected
        } catch (error) {
          const detail = error instanceof Error ? error.message.split('\n')[0] : 'unreachable'
          failures.push(`${label}: ${detail}`)
        }
      }

      detected = {
        available: false,
        engine: null,
        checkedAt: Date.now(),
        reason: `No container engine is reachable. ${failures.join('; ')}`,
        hint: 'Install Docker Engine inside WSL2 and start it (`sudo service docker start`), or install Docker Desktop with the WSL2 backend, then confirm `docker run --rm hello-world` and reload.',
      }
      return detected
    },

    async status({ refresh = false } = {}) {
      const result = await runtime.detect({ refresh })
      if (!result.available) return { available: false, reason: result.reason, hint: result.hint }
      return { available: true, engine: result.engine, label: result.label, version: result.version, image: result.image, imageId: result.imageId, imageDigest: result.imageDigest, imagePinned: result.image.includes('@sha256:'), network: result.network, runtime: containerRuntime || 'default' }
    },

    /**
     * Run one command inside a fresh container. The argv is passed as an array:
     * nothing here is interpreted by a shell.
     */
    async run(argv, { cwd = '.', timeoutMs = defaultTimeoutMs, runId = null } = {}) {
      const status = await runtime.detect()
      if (!status.available) throw new Error(`Execution is disabled. ${status.reason} ${status.hint}`)
      if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== 'string' || part === '')) {
        throw new Error('A command needs a non-empty argv of strings.')
      }
      if (argv.some((part) => part.includes('\u0000'))) throw new Error('A command argument contained a null byte.')

      const candidate = { id: status.engine, viaWsl: status.viaWsl }
      const name = `fulkrum-${randomUUID().slice(0, 8)}`
      const args = containerArgs({ argv, workspaceRoot, workdir: cwd, image, network: status.network, inWsl: status.viaWsl, name, memory, cpus, pidsLimit, runtimeUser: effectiveUser(), userNamespace, nofile, runtime: containerRuntime })
      const timeout = Math.min(Math.max(Number(timeoutMs) || defaultTimeoutMs, 1_000), 600_000)
      const handle = { name, candidate }
      if (runId) {
        const handles = running.get(runId) ?? new Set()
        handles.add(handle)
        running.set(runId, handles)
      }

      try {
        const result = await invoke(candidate, args, { timeout, maxBuffer: maxOutputBytes, windowsHide: true, killSignal: 'SIGKILL' })
        return { stdout: clip(result.stdout), stderr: clip(result.stderr), container: name }
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : 'The command failed.'
        const killed = Boolean(error?.killed) || /timed out/i.test(rawMessage)
        // maxBuffer errors also set error.killed; distinguishing them prevents
        // "output too large" from being reported as "timed out".
        const maxBufferExceeded = /maxBuffer/i.test(rawMessage) || Boolean(error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        if (killed || maxBufferExceeded) {
          // A killed container can outlive the client, so remove it explicitly.
          try {
            await invoke(candidate, ['rm', '--force', name], { timeout: 15_000, windowsHide: true })
          } catch {
            // Either nothing was left to clean up, or the engine is gone.
          }
        }
        // Node prefixes execFile failures with the entire command line, which tells
        // the model nothing. The container's own output is the useful part.
        const withoutCommand = rawMessage.replace(/^Command failed:[^\n]*\n?/, '').trim()
        const stderr = clip(error?.stderr ?? '')
        const stdout = clip(error?.stdout ?? '')
        const exitCode = typeof error?.code === 'number' ? ` (exit ${error.code})` : ''
        const detail = [stderr, withoutCommand].filter(Boolean).join('\n')
        if (maxBufferExceeded) {
          throw new Error(`The command produced more than ${maxOutputBytes} bytes of output and was stopped.${detail ? `\n${detail}` : ''}`)
        }
        if (killed) {
          throw new Error(`The command exceeded ${timeout}ms and its container was stopped.${detail ? `\n${detail}` : ''}`)
        }
        throw new Error(`${detail || 'The command failed.'}${exitCode}${stdout ? `\n${stdout}` : ''}`)
      } finally {
        if (runId) {
          const handles = running.get(runId)
          if (handles) {
            handles.delete(handle)
            if (!handles.size) running.delete(runId)
          }
        }
      }
    },

    /**
     * Stop whatever this run is running, if anything.
     *
     * Called when a run is cancelled: the command is removed rather than left to
     * finish work nobody is waiting for any more. The client's own `execFile` is
     * killed as a side effect of the container disappearing.
     */
    async kill(runId, { reason = 'the run was cancelled' } = {}) {
      const handles = running.get(runId)
      if (!handles?.size) return { stopped: false, containers: [], errors: ['nothing could be removed'] }
      running.delete(runId)
      const stopped = []
      const failures = []
      for (const handle of handles) {
        try {
          await invoke(handle.candidate, ['rm', '--force', handle.name], { timeout: 15_000, windowsHide: true })
          stopped.push(handle.name)
        } catch (error) {
          failures.push(error instanceof Error ? error.message : 'could not remove the container')
        }
      }
      if (!stopped.length) return { stopped: false, containers: [], errors: failures.length ? failures : ['nothing could be removed'] }
      return { stopped: true, containers: stopped, reason, ...(failures.length ? { errors: failures } : {}) }
    },

    /** What is running right now, for the status panel. */
    runningNow() {
      return [...running.entries()].flatMap(([runId, handles]) => [...handles].map((handle) => ({ runId, container: handle.name })))
    },

    /** Exposed for tests and documentation: the exact argv a run would use. */
    describeRun(argv, options = {}) {
      return containerArgs({ argv, workspaceRoot, workdir: options.cwd ?? '.', image, network: 'none', inWsl: requested === 'docker-wsl', name: 'fulkrum-preview', memory, cpus, pidsLimit, runtimeUser: effectiveUser(), userNamespace, nofile, runtime: containerRuntime })
    },
  }

  return runtime
}
