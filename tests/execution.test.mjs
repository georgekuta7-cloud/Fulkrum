import assert from 'node:assert/strict'
import test from 'node:test'
import { containerArgs, createExecutionRuntime, toEnginePath } from '../server/execution.mjs'
import { FulkrumToolBroker } from '../server/toolBroker.mjs'
import { withWorkspace } from './helpers.mjs'

/** A stand-in engine: records the calls it receives and returns what it is told. */
function stubEngine({ version = '27.3.1\n', fail = null, hang = false } = {}) {
  const calls = []
  const execFileImpl = async (file, args, options) => {
    calls.push({ file, args: [...args], options })
    if (args[0] === 'version') {
      if (fail) throw Object.assign(new Error(fail), { code: 1 })
      return { stdout: version, stderr: '' }
    }
    if (hang) throw Object.assign(new Error('Command failed: timed out'), { killed: true, stdout: '', stderr: 'partial output' })
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

test('paths are translated for an engine that lives inside WSL', () => {
  assert.equal(toEnginePath('D:\\projects\\fulkrum', { inWsl: true }), '/mnt/d/projects/fulkrum')
  assert.equal(toEnginePath('C:/Users/proga', { inWsl: true }), '/mnt/c/Users/proga')
  assert.equal(toEnginePath('D:\\projects\\fulkrum', { inWsl: false }).endsWith('fulkrum'), true)

  const args = containerArgs({ argv: ['ls'], workspaceRoot: 'D:\\projects\\fulkrum', inWsl: true, name: 'x' })
  assert.equal(args[args.indexOf('--volume') + 1], '/mnt/d/projects/fulkrum:/workspace:rw')
})

test('an unreachable engine disables execution with an actionable message', async () => {
  const { execFileImpl } = stubEngine({ fail: 'cannot connect to the Docker daemon' })
  const runtime = createExecutionRuntime({ engine: 'docker', execFileImpl })

  const status = await runtime.status()
  assert.equal(status.available, false)
  assert.match(status.reason, /No container engine is reachable/)
  assert.match(status.hint, /WSL2|Docker Desktop/)

  await assert.rejects(() => runtime.run(['git', 'status']), /Execution is disabled/)
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
