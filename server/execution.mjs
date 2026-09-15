import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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

/** Convert a Windows path to the path an engine running inside WSL sees. */
export function toEnginePath(target, { inWsl = false } = {}) {
  const resolved = path.resolve(target)
  if (!inWsl) return resolved
  const driveMatch = resolved.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!driveMatch) return resolved.replaceAll('\\', '/')
  return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2].replaceAll('\\', '/')}`
}

/**
 * The exact argv used for one agent command. Everything that makes the container
 * a boundary lives here, so a test can assert it rather than trust it.
 */
export function containerArgs({ argv, workspaceRoot, workdir = '.', image = defaultImage, network = 'none', inWsl = false, name = 'fulkrum-preview', memory = '2g', cpus = '2', pidsLimit = 256 }) {
  const containerDir = workdir.startsWith('/') ? workdir : `${containerWorkdir}/${workdir}`.replace(/\/+$/, '')
  return [
    'run',
    '--rm',
    '--name',
    name,
    '--network',
    network,
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(pidsLimit),
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

export function createExecutionRuntime({
  engine = process.env.FULKRUM_CONTAINER_ENGINE ?? '',
  image = defaultImage,
  workspaceRoot = process.cwd(),
  memory = process.env.FULKRUM_CONTAINER_MEMORY ?? '2g',
  cpus = process.env.FULKRUM_CONTAINER_CPUS ?? '2',
  pidsLimit = Number(process.env.FULKRUM_CONTAINER_PIDS ?? 256),
  defaultTimeoutMs = Number(process.env.FULKRUM_EXEC_TIMEOUT_MS ?? 120_000),
  // A success is cached for the process lifetime; a failure is re-probed, so
  // installing an engine does not require restarting the bridge.
  failureTtlMs = Number(process.env.FULKRUM_ENGINE_RETRY_MS ?? 30_000),
  execFileImpl = defaultExecFile,
} = {}) {
  const requested = String(engine).trim()
  let detected = null

  /** Which transports to try, in order. 'docker-wsl' means the engine lives in WSL. */
  const candidates = () => {
    if (requested === 'docker-wsl') return [{ id: 'docker', viaWsl: true }]
    if (engines[requested]) return [{ id: requested, viaWsl: false }]
    return [
      { id: 'docker', viaWsl: false },
      { id: 'podman', viaWsl: false },
      { id: 'docker', viaWsl: true },
    ]
  }

  const invoke = (candidate, args, options) => (candidate.viaWsl
    ? execFileImpl('wsl.exe', ['--exec', candidate.id, ...args], options)
    : execFileImpl(candidate.id, args, options))

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
          detected = { available: true, engine: candidate.id, label, version, image, network: 'none', checkedAt: Date.now(), ...candidate }
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
      return { available: true, engine: result.engine, label: result.label, version: result.version, image: result.image, network: result.network }
    },

    /**
     * Run one command inside a fresh container. The argv is passed as an array:
     * nothing here is interpreted by a shell.
     */
    async run(argv, { cwd = '.', timeoutMs = defaultTimeoutMs } = {}) {
      const status = await runtime.detect()
      if (!status.available) throw new Error(`Execution is disabled. ${status.reason} ${status.hint}`)
      if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== 'string' || part === '')) {
        throw new Error('A command needs a non-empty argv of strings.')
      }
      if (argv.some((part) => part.includes('\u0000'))) throw new Error('A command argument contained a null byte.')

      const candidate = { id: status.engine, viaWsl: status.viaWsl }
      const name = `fulkrum-${randomUUID().slice(0, 8)}`
      const args = containerArgs({ argv, workspaceRoot, workdir: cwd, image, network: status.network, inWsl: status.viaWsl, name, memory, cpus, pidsLimit })
      const timeout = Math.min(Math.max(Number(timeoutMs) || defaultTimeoutMs, 1_000), 600_000)

      try {
        const result = await invoke(candidate, args, { timeout, maxBuffer: maxOutputBytes, windowsHide: true, killSignal: 'SIGKILL' })
        return { stdout: clip(result.stdout), stderr: clip(result.stderr), container: name }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The command failed.'
        const killed = Boolean(error?.killed) || /timed out/i.test(message)
        if (killed) {
          // A killed container can outlive the client, so remove it explicitly.
          try {
            await invoke(candidate, ['rm', '--force', name], { timeout: 15_000, windowsHide: true })
          } catch {
            // Either nothing was left to clean up, or the engine is gone.
          }
        }
        const stderr = clip(error?.stderr ?? '')
        const stdout = clip(error?.stdout ?? '')
        throw new Error(killed
          ? `The command exceeded ${timeout}ms and its container was stopped.${stderr ? `\n${stderr}` : ''}`
          : `${message}${stderr ? `\n${stderr}` : ''}${stdout ? `\n${stdout}` : ''}`)
      }
    },

    /** Exposed for tests and documentation: the exact argv a run would use. */
    describeRun(argv, options = {}) {
      return containerArgs({ argv, workspaceRoot, workdir: options.cwd ?? '.', image, network: 'none', inWsl: requested === 'docker-wsl', name: 'fulkrum-preview', memory, cpus, pidsLimit })
    },
  }

  return runtime
}
