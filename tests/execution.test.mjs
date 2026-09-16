import assert from 'node:assert/strict'
import test from 'node:test'
import { containerArgs, createExecutionRuntime, defaultUserForWorkspace, toEnginePath } from '../server/execution.mjs'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FulkrumToolBroker } from '../server/toolBroker.mjs'
import { withWorkspace } from './helpers.mjs'

/** A stand-in engine: records the calls it receives and returns what it is told. */
function stubEngine({ version = '27.3.1\n', fail = null, hang = false, commandError = null } = {}) {
  const calls = []
  const execFileImpl = async (file, args, options) => {
    calls.push({ file, args: [...args], options })
    if (args[0] === 'version') {
      if (fail) throw Object.assign(new Error(fail), { code: 1 })
      return { stdout: version, stderr: '' }
    }
    // Detection inspects the image, so the stub has to answer that too: an engine
    // that is present but missing its image disables execution by design.
    if (args[0] === 'image') return { stdout: args.includes('{{json .RepoDigests}}') ? '[]\n' : 'sha256:stub-image\n', stderr: '' }
    if (hang) throw Object.assign(new Error('Command failed: timed out'), { killed: true, stdout: '', stderr: 'partial output' })
    if (commandError) throw commandError
    return { stdout: 'command output\n', stderr: '' }
  }
  return { calls, execFileImpl }
}

test('the container argv carries every isolation flag', () => {
  const args = containerArgs({
    argv: ['git', 'status', '--short'],
    workspaceRoot: 'D:/projects/fulkrum',
    workdir: 'src',
    name: 'fulkrum-test',
  })

  const value = (flag) => args[args.indexOf(flag) + 1]
  assert.equal(args[0], 'run')
  assert.equal(value('--network'), 'none', 'the container has no network by default')
  assert.equal(args.includes('--read-only'), true, 'the root filesystem is read-only')
  assert.match(value('--tmpfs'), /^\/tmp:/)
  assert.equal(value('--user'), '1000:1000', 'the agent does not run as root')
  assert.equal(value('--cap-drop'), 'ALL')
  assert.equal(value('--security-opt'), 'no-new-privileges')
  assert.equal(value('--pids-limit'), '256')
  assert.equal(value('--memory'), '2g')
  assert.equal(value('--cpus'), '2')
  assert.equal(value('--workdir'), '/workspace/src')
  assert.match(value('--volume'), /:\/workspace:rw$/, 'the workspace is the only writable mount')

  // The command is appended after the image, as separate argv entries.
  const imageIndex = args.indexOf('fulkrum-runner:local')
  assert.equal(imageIndex > 0, true)
  assert.deepEqual(args.slice(imageIndex + 1), ['git', 'status', '--short'])
  assert.equal(args.includes('sh'), false, 'nothing is wrapped in a shell')
  assert.equal(args.join(' ').includes(' -c '), false)
})

test('the container gets a writable home and bounded descriptors', () => {
  const args = containerArgs({ argv: ['npm', 'install'], workspaceRoot: process.cwd(), name: 'shape' })
  const firstTmpfs = args.indexOf('--tmpfs')
  const secondTmpfs = args.indexOf('--tmpfs', firstTmpfs + 1)
  assert.match(args[firstTmpfs + 1], /^\/tmp:/)
  // HOME needs exec: the root filesystem is read-only and /tmp cannot execute, so
  // npm and friends would fail installing into their home directory.
  assert.match(args[secondTmpfs + 1], /^\/home\/fulkrum:.*\bexec\b/)
  assert.equal(args[args.indexOf('--user') + 1], '1000:1000')
  assert.equal(args[args.indexOf('--ulimit') + 1], 'nofile=1024:1024')
  assert.equal(args.includes('--userns'), false, 'no user namespace remap by default')

  // A rootless setup maps ids differently, so both are configurable.
  const custom = containerArgs({ argv: ['ls'], workspaceRoot: process.cwd(), name: 'shape', runtimeUser: '1001:1001', userNamespace: 'keep-id', nofile: 512 })
  assert.equal(custom[custom.indexOf('--user') + 1], '1001:1001')
  assert.equal(custom[custom.indexOf('--userns') + 1], 'keep-id')
  assert.equal(custom[custom.indexOf('--ulimit') + 1], 'nofile=512:512')
})

test('the image must exist, and its identity is reported', async () => {
  const execFileImpl = async (_file, args) => {
    if (args[0] === 'image' && args.includes('{{.Id}}')) return { stdout: 'sha256:abc123\n' }
    if (args[0] === 'image') return { stdout: '["fulkrum-runner@sha256:deadbeef"]\n' }
    return { stdout: '29.8.0\n' }
  }

  const runtime = createExecutionRuntime({ execFileImpl, image: 'fulkrum-runner:local', workspaceRoot: process.cwd() })
  const status = await runtime.status()
  assert.equal(status.available, true)
  assert.equal(status.imageId, 'sha256:abc123')
  assert.equal(status.imageDigest, 'fulkrum-runner@sha256:deadbeef')
  assert.equal(status.imagePinned, false, 'a tag is not a pin')

  // A missing image disables execution rather than failing at the first command.
  const missing = createExecutionRuntime({
    execFileImpl: async (_file, args) => {
      // The engine answers, but the image is not there — whichever transport is
      // tried, including the one that reaches Docker through WSL.
      if (args.includes('image')) throw new Error('Error: No such image: fulkrum-runner:local')
      return { stdout: '29.8.0\n' }
    },
    image: 'fulkrum-runner:local',
    workspaceRoot: process.cwd(),
  })
  const absent = await missing.status()
  assert.equal(absent.available, false)
  assert.match(absent.reason, /runner image .* is not present/)
})

test('the container runs as whoever owns the workspace', () => {
  // A bind mount keeps the host's ownership, so the default has to be the owner:
  // a hardcoded uid cannot write to a checkout owned by someone else, which is
  // how CI caught it.
  const user = defaultUserForWorkspace(process.cwd())
  if (process.platform === 'win32') {
    assert.equal(user, '1000:1000', 'Windows mounts have no meaningful uid, so the conventional one stands')
  } else {
    const stats = statSync(process.cwd())
    assert.equal(user, `${stats.uid}:${stats.gid}`)
  }
  assert.equal(defaultUserForWorkspace(path.join(tmpdir(), 'does-not-exist-anywhere')).length > 0, true, 'a missing workspace falls back rather than throwing')
})

test('a configured uid wins over the derived one', () => {
  const runtime = createExecutionRuntime({ execFileImpl: stubEngine().execFileImpl, workspaceRoot: process.cwd(), runtimeUser: '4242:4242' })
  const args = runtime.describeRun(['ls'])
  assert.equal(args[args.indexOf('--user') + 1], '4242:4242')
})

test('cancelling a run takes its container with it', async () => {
  const calls = []
  /** @type {(value?: unknown) => void} */
  let releaseRun = () => {}
  const runGate = new Promise((resolve) => { releaseRun = resolve })
  const execFileImpl = async (_file, args) => {
    calls.push(args)
    if (args[0] === 'version') return { stdout: '29.8.0\n', stderr: '' }
    if (args[0] === 'image') return { stdout: args.includes('{{json .RepoDigests}}') ? '[]\n' : 'sha256:abc\n', stderr: '' }
    if (args[0] === 'run') {
      await runGate
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }

  const runtime = createExecutionRuntime({ execFileImpl, workspaceRoot: process.cwd() })
  const running = runtime.run(['sleep', '300'], { runId: 'run-cancel' })
  while (!calls.some((args) => args[0] === 'run')) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(runtime.runningNow().map((entry) => entry.runId), ['run-cancel'], 'the run is tracked while its command runs')

  const stopped = await runtime.kill('run-cancel')
  assert.equal(stopped.stopped, true)
  const removal = calls.find((args) => args[0] === 'rm')
  assert.ok(removal, 'the container was removed')
  assert.equal(removal[1], '--force')
  assert.equal(removal[2], stopped.containers[0], 'and it was the container that was running')
  assert.deepEqual(runtime.runningNow(), [], 'nothing is left marked as running')

  // Cancelling twice, or cancelling a run with nothing running, is not an error.
  assert.deepEqual(await runtime.kill('run-cancel'), { stopped: false, containers: [], errors: ['nothing could be removed'] })
  assert.deepEqual(await runtime.kill('run-that-never-ran'), { stopped: false, containers: [], errors: ['nothing could be removed'] })

  releaseRun()
  await running.catch(() => {})
})

test('paths are translated for an engine that lives inside WSL', () => {
  assert.equal(toEnginePath('D:\\projects\\fulkrum', { inWsl: true }), '/mnt/d/projects/fulkrum')
  assert.equal(toEnginePath('C:/Users/proga', { inWsl: true }), '/mnt/c/Users/proga')
  assert.equal(toEnginePath('D:\\projects\\fulkrum', { inWsl: false }).endsWith('fulkrum'), true)

  const args = containerArgs({ argv: ['ls'], workspaceRoot: 'D:\\projects\\fulkrum', inWsl: true, name: 'x' })
  assert.equal(args[args.indexOf('--volume') + 1], '/mnt/d/projects/fulkrum:/workspace:rw')
})

test('an unreachable engine disables execution with an actionable message', async () => {
  const { calls, execFileImpl } = stubEngine({ fail: 'cannot connect to the Docker daemon' })
  const runtime = createExecutionRuntime({ engine: 'docker', execFileImpl })

  const status = await runtime.status()
  assert.equal(status.available, false)
  assert.match(status.reason, /No container engine is reachable/)
  assert.match(status.hint, /WSL2|Docker Desktop/)

  // A failure is re-probed rather than cached forever, so installing an engine
  // does not require restarting the bridge.
  const probesAfterFirst = calls.length
  await runtime.status()
  assert.equal(calls.length, probesAfterFirst, 'within the retry window the answer is cached')
  await runtime.status({ refresh: true })
  assert.equal(calls.length > probesAfterFirst, true, 'an explicit refresh re-probes')

  await assert.rejects(() => runtime.run(['git', 'status']), /Execution is disabled/)
})

test('a failed detection is retried once the retry window passes', async () => {
  const { calls, execFileImpl } = stubEngine({ fail: 'no daemon' })
  const runtime = createExecutionRuntime({ engine: 'docker', execFileImpl, failureTtlMs: 0 })
  await runtime.status()
  const first = calls.length
  await runtime.status()
  assert.equal(calls.length > first, true, 'with no retry window the probe runs again')
})

test('commands run through the engine, never on the host', async () => {
  const { calls, execFileImpl } = stubEngine()
  const runtime = createExecutionRuntime({ engine: 'docker', workspaceRoot: 'D:/projects/fulkrum', execFileImpl })

  const status = await runtime.status()
  assert.equal(status.available, true)
  assert.equal(status.version, '27.3.1')
  assert.equal(status.network, 'none')

  const result = await runtime.run(['git', 'status'], { cwd: 'src' })
  assert.equal(result.stdout, 'command output\n')

  const runCall = calls.find((call) => call.args[0] === 'run')
  assert.ok(runCall, 'the engine received a run command')
  assert.equal(runCall.file, 'docker')
  assert.equal(runCall.args.includes('--read-only'), true)
  assert.deepEqual(runCall.args.slice(-2), ['git', 'status'])
})

test('an explicit CLI path is used when the engine is not on PATH', async () => {
  const { calls, execFileImpl } = stubEngine()
  const cliPath = 'C:\\Users\\proga\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe'
  const runtime = createExecutionRuntime({ cliPath, execFileImpl })

  const status = await runtime.status()
  assert.equal(status.available, true, 'with an explicit path there is nothing to guess')
  await runtime.run(['git', 'status'])

  assert.equal(calls.every((call) => call.file === cliPath), true, 'every call used the configured CLI')
})

test('an engine inside WSL is invoked through wsl.exe', async () => {
  const { calls, execFileImpl } = stubEngine()
  const runtime = createExecutionRuntime({ engine: 'docker-wsl', workspaceRoot: 'D:/projects/fulkrum', execFileImpl })
  await runtime.status()
  await runtime.run(['ls'])

  const versionCall = calls.find((call) => call.args.includes('version'))
  assert.equal(versionCall.file, 'wsl.exe')
  assert.deepEqual(versionCall.args.slice(0, 3), ['--exec', 'docker', 'version'])
})

test('a timed-out command is stopped and its container removed', async () => {
  const { calls, execFileImpl } = stubEngine({ hang: true })
  const runtime = createExecutionRuntime({ engine: 'docker', execFileImpl })
  await runtime.status()

  await assert.rejects(() => runtime.run(['sleep', '999'], { timeoutMs: 1_000 }), /exceeded 1000ms/)
  const cleanup = calls.find((call) => call.args[0] === 'rm')
  assert.ok(cleanup, 'the container is force-removed after a timeout')
  assert.equal(cleanup.args.includes('--force'), true)
})

test('a failed command reports the container output, not the engine command line', async () => {
  const commandError = Object.assign(new Error('Command failed: docker run --rm --name x --network none fulkrum-runner:local cmd.exe /c whoami\n'), {
    code: 127,
    stdout: '',
    stderr: 'exec: "cmd.exe": executable file not found in $PATH',
  })
  const { execFileImpl } = stubEngine({ commandError })
  const runtime = createExecutionRuntime({ engine: 'docker', execFileImpl })
  await runtime.status()

  const error = await runtime.run(['cmd.exe', '/c', 'whoami']).catch((thrown) => thrown)
  assert.match(error.message, /executable file not found/, 'the container output is what the caller sees')
  assert.equal(/docker run --rm/.test(error.message), false, 'the invocation details are not echoed back')
  assert.match(error.message, /exit 127/)
})

test('the broker refuses to execute without a boundary and never falls back to the host', async () => {
  await withWorkspace(async (directory) => {
    const broker = new FulkrumToolBroker({ workspaceRoot: directory })
    await assert.rejects(() => broker.execute('shell.exec', { command: 'git', args: ['status'] }), /Execution is disabled/)
  })
})

test('the broker sends the command through the container runtime', async () => {
  await withWorkspace(async (directory) => {
    const { calls, execFileImpl } = stubEngine()
    const execution = createExecutionRuntime({ engine: 'docker', workspaceRoot: directory, execFileImpl })
    const broker = new FulkrumToolBroker({ workspaceRoot: directory, execution })

    const result = await broker.execute('shell.exec', { command: 'node', args: ['--version'], cwd: 'src' })
    assert.equal(result.boundary, 'container')
    assert.deepEqual(result.argv, ['node', '--version'])
    assert.equal(result.cwd, 'src')

    const runCall = calls.find((call) => call.args[0] === 'run')
    assert.equal(runCall.args[runCall.args.indexOf('--workdir') + 1], '/workspace/src')
    assert.deepEqual(runCall.args.slice(-2), ['node', '--version'])
  })
})

test('malformed commands are refused before reaching the engine', async () => {
  await withWorkspace(async (directory) => {
    const { calls, execFileImpl } = stubEngine()
    const execution = createExecutionRuntime({ engine: 'docker', workspaceRoot: directory, execFileImpl })
    const broker = new FulkrumToolBroker({ workspaceRoot: directory, execution })

    await assert.rejects(() => broker.execute('shell.exec', { command: '   ' }), /command is required/)
    await assert.rejects(() => broker.execute('shell.exec', { command: 'echo', args: ['a\u0000b'] }), /null byte/)
    await assert.rejects(() => broker.execute('shell.exec', { command: 'ls', cwd: '../outside' }), /inside the Fulkrum workspace/)
    assert.equal(calls.filter((call) => call.args[0] === 'run').length, 0, 'nothing reached the engine')
  })
})
