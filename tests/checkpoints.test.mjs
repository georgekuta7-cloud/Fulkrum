import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { createCheckpointStore } from '../server/checkpoints.mjs'
import { withServer, withTempDirectory } from './helpers.mjs'

/**
 * The shadow repository is the undo the live workspace does not otherwise
 * have. These tests pin the parts a review called load-bearing: it never
 * touches the user's workspace or Git state, the host's configuration cannot
 * leak into it, and its vocabulary is the same one the tools obey.
 */

test('the shadow repository lives in the data directory, never in the workspace', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    const ready = await checkpoints.ensure()
    assert.equal(ready.initialized, true)
    assert.equal(existsSync(path.join(workspace, '.git')), false, 'no repository is planted in the user workspace')
    assert.equal(existsSync(path.join(dataDir, 'checkpoints', 'repo.git')), true, 'the repository lives under the data directory')
    const inside = await checkpoints.run(['rev-parse', '--is-inside-work-tree'])
    assert.equal(inside.stdout.trim(), 'true', 'the workspace is the work tree')
  })
})

test('repository config is pinned and the host Git config cannot leak in', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    const leaky = path.join(workspace, 'leaky.gitconfig')
    await writeFile(leaky, '[leak]\n\tvalue = yes\n[core]\n\tautocrlf = true\n')
    const previous = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = leaky
    try {
      const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
      await checkpoints.ensure()
      assert.equal((await checkpoints.run(['config', '--get', 'core.autocrlf'])).stdout.trim(), 'false', 'no line-ending translation')
      assert.equal((await checkpoints.run(['config', '--get', 'core.fileMode'])).stdout.trim(), 'false', 'no mode-bit surprises')
      assert.equal((await checkpoints.run(['config', '--get', 'user.name'])).stdout.trim(), 'Fulkrum')
      await assert.rejects(() => checkpoints.run(['config', '--get', 'leak.value']), 'the host global config is ignored entirely')
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previous
    }
  })
})

test('the exclude vocabulary mirrors what the tools can touch', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    await writeFile(path.join(workspace, '.fulkrumignore'), '# custom rules\nsecrets-dir/\n*.local\n')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    await checkpoints.ensure()
    const exclude = await readFile(path.join(dataDir, 'checkpoints', 'repo.git', 'info', 'exclude'), 'utf8')
    for (const pattern of ['.git/', 'node_modules/', 'dist/', 'coverage/', '.cache/']) {
      assert.match(exclude, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `skipped directory ${pattern}`)
    }
    for (const pattern of ['.env*', '.npmrc', '.netrc', '.git-credentials', 'credentials*', 'kubeconfig', 'id_rsa', 'id_ed25519.pub', '*.pem', '*.key', '*.p12', '*.sqlite', '*.db']) {
      assert.match(exclude, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `sensitive pattern ${pattern}`)
    }
    assert.match(exclude, /^data\/$/m, 'the data directory is Fulkrum\u2019s own')
    assert.match(exclude, /^secrets-dir\/$/m, 'the workspace .fulkrumignore is honored')
    assert.match(exclude, /^\*\.local$/m, 'including file rules')
    assert.equal(existsSync(path.join(workspace, '.gitignore')), false, 'the workspace is not written to')
  })
})

test('a missing host Git is reported, and initialization refuses', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    const execFileImpl = async () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    }
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir, execFileImpl })
    const availability = await checkpoints.available()
    assert.equal(availability.ok, false)
    assert.match(availability.reason, /Git/)
    await assert.rejects(() => checkpoints.ensure(), /Git/)
    const status = await checkpoints.status()
    assert.equal(status.available, false)
    assert.equal(status.initialized, false)
    assert.equal(status.checkpoints, 0)
  })
})

test('status is honest before any checkpoint exists', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    await checkpoints.ensure()
    const status = await checkpoints.status()
    assert.equal(status.available, true)
    assert.equal(status.initialized, true)
    assert.equal(status.checkpoints, 0, 'an empty repository has no checkpoints')
    assert.equal(status.latest, null)
    assert.equal(status.bytes > 0, true, 'the repository directory has a size')
    assert.equal(status.gitDir, path.join(dataDir, 'checkpoints', 'repo.git'))
  })
})

test('ensure is idempotent', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    const first = await checkpoints.ensure()
    const second = await checkpoints.ensure()
    assert.equal(first.initialized, true)
    assert.equal(second.initialized, true)
    assert.equal(second.created, false, 'the second call finds the repository already there')
  })
})

test('a baseline checkpoint covers the covered tree, honors .gitignore, and gets one ref per run', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    await writeFile(path.join(workspace, '.gitignore'), 'ignored-by-git/\n')
    await mkdir(path.join(workspace, 'ignored-by-git'), { recursive: true })
    await writeFile(path.join(workspace, 'ignored-by-git', 'x.js'), 'x\n')
    await writeFile(path.join(workspace, 'src.txt'), 'hello\n')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    const first = await checkpoints.baseline({ runId: 'run-abc' })
    assert.ok(first.commit, 'the baseline is a commit')
    assert.equal(first.reused, false)
    assert.equal(first.files >= 1, true)
    const tree = await checkpoints.run(['ls-tree', '--name-only', '-r', 'HEAD'])
    assert.ok(tree.stdout.includes('src.txt'))
    assert.equal(tree.stdout.includes('ignored-by-git'), false, 'the workspace .gitignore is honored')
    const ref = await checkpoints.run(['rev-parse', 'refs/runs/run-abc'])
    assert.equal(ref.stdout.trim(), first.commit, 'one private ref per run')

    const second = await checkpoints.baseline({ runId: 'run-abc' })
    assert.equal(second.reused, true, 'a resumed run keeps its original baseline')
    assert.equal(second.commit, first.commit)
  })
})

test('approving a plan takes a baseline checkpoint before any work', async () => {
  const definition = { objective: 'Baseline.', tasks: [{ role: 'research', title: 'Look', instructions: 'Report.', dependsOn: [] }] }
  const model = async ({ options }) => {
    if (String(options?.instructions ?? '').includes('You plan work')) return { text: JSON.stringify(definition), toolCalls: [], usage: null }
    return { text: 'Summary.', toolCalls: [], usage: null }
  }
  await withTempDirectory(async (workspace) => {
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir: path.join(workspace, 'data') })
    await withServer(async ({ request, store, providerRegistry }) => {
      providerRegistry.addCustom({ label: 'Baseline fixture', baseUrl: 'https://example.invalid/v1', model: 'fixture-model', apiKey: 'fixture-key' })
      const project = await request('POST', '/api/projects', { name: 'baseline fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id })
      const runId = run.payload.run.id
      await request('POST', '/api/chat', { runId, message: 'Do the thing.', history: [] })
      const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
      const approved = await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
      assert.equal(approved.status, 200, JSON.stringify(approved.payload))

      const deadline = Date.now() + 10_000
      let baseline = null
      while (Date.now() < deadline && !baseline) {
        baseline = store.listEvents(runId).find((event) => event.type === 'checkpoint.baseline')
        if (!baseline) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.ok(baseline, `the run starts with a baseline on the chain: ${JSON.stringify(store.listEvents(runId).map((event) => [event.type, event.payload?.reason ?? event.payload?.error ?? '']))}`)
      assert.ok(baseline.payload.commit)
      const ref = await checkpoints.run(['rev-parse', `refs/runs/${runId}`])
      assert.equal(ref.stdout.trim(), baseline.payload.commit)

      // Let the run settle before the harness cleans up: a background
      // finalize racing the temp-directory removal locks files on Windows.
      const settle = Date.now() + 10_000
      while (Date.now() < settle && store.getRun(runId).status === 'executing') await new Promise((resolve) => setTimeout(resolve, 100))
    }, { workspaceRoot: workspace, checkpoints, model })
  })
})

test('a run does not start when the baseline cannot be taken', async () => {
  const definition = { objective: 'No git.', tasks: [{ role: 'research', title: 'Look', instructions: 'Report.', dependsOn: [] }] }
  const model = async ({ options }) => {
    if (String(options?.instructions ?? '').includes('You plan work')) return { text: JSON.stringify(definition), toolCalls: [], usage: null }
    return { text: 'Summary.', toolCalls: [], usage: null }
  }
  const execFileImpl = async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }
  await withTempDirectory(async (workspace) => {
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir: path.join(workspace, 'data'), execFileImpl })
    await withServer(async ({ request, store, providerRegistry }) => {
      providerRegistry.addCustom({ label: 'No git fixture', baseUrl: 'https://example.invalid/v1', model: 'fixture-model', apiKey: 'fixture-key' })
      const project = await request('POST', '/api/projects', { name: 'no git baseline fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id })
      const runId = run.payload.run.id
      await request('POST', '/api/chat', { runId, message: 'Do the thing.', history: [] })
      const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
      await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && ['planning', 'executing'].includes(store.getRun(runId).status)) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const stopped = store.getRun(runId)
      assert.equal(stopped.status, 'interrupted', 'the run never started')
      assert.match(String(stopped.interruptionReason), /checkpoint/)
      assert.match(String(stopped.interruptionReason), /Git/)
      assert.equal(store.listEvents(runId).some((event) => event.type === 'task.started'), false, 'no task started')
      assert.ok(store.listEvents(runId).find((event) => event.type === 'checkpoint.failed'), 'the refusal is on the chain')
    }, { workspaceRoot: workspace, checkpoints, model })
  })
})

test('a shell command that changes files is snapshotted, even when it fails', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    let calls = 0
    const execution = { run: async () => {
      calls += 1
      if (calls === 1) {
        await writeFile(path.join(workspace, 'out.txt'), 'v1\n', 'utf8')
        return { stdout: 'ok\n', stderr: '', container: 'stub' }
      }
      await writeFile(path.join(workspace, 'out.txt'), 'v2\n', 'utf8')
      throw Object.assign(new Error('The command failed. (exit 1)\nboom'), { code: 1, stderr: 'boom\n' })
    } }
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'shell snapshot fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id

      const first = await request('POST', `/api/runs/${runId}/tools`, { name: 'shell.exec', agentId: 'builder', input: { command: 'make', args: ['one'] } })
      assert.equal(first.status, 200, JSON.stringify(first.payload))
      const firstEvent = store.listEvents(runId).find((event) => event.type === 'checkpoint.shell')
      assert.ok(firstEvent, 'the success is snapshotted')
      assert.match(String(firstEvent.payload.note), /not proof of causation/)
      const blob1 = await checkpoints.run(['show', `${firstEvent.payload.commit}:out.txt`])
      assert.equal(blob1.stdout, 'v1\n')

      const second = await request('POST', `/api/runs/${runId}/tools`, { name: 'shell.exec', agentId: 'builder', input: { command: 'make', args: ['two'] } })
      assert.equal(second.status, 502, 'the command failed')
      const shellEvents = store.listEvents(runId).filter((event) => event.type === 'checkpoint.shell')
      assert.equal(shellEvents.length, 2, 'the failed command is snapshotted too')
      const blob2 = await checkpoints.run(['show', `${shellEvents[1].payload.commit}:out.txt`])
      assert.equal(blob2.stdout, 'v2\n', 'the bytes the failed command left are captured')
      assert.equal(store.getToolCall(store.listToolCalls(runId).filter((call) => call.name === 'shell.exec').at(-1).id).status, 'failed')
    }, { workspaceRoot: workspace, checkpoints, execution })
  })
})

test('the run-end snapshot and diff show what the run changed, reproducibly', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    await writeFile(path.join(workspace, 'keep.txt'), 'unchanged\n')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    const baseline = await checkpoints.baseline({ runId: 'run-diff' })
    await writeFile(path.join(workspace, 'keep.txt'), 'changed\n')
    await writeFile(path.join(workspace, 'new.txt'), 'brand new\n')
    const final = await checkpoints.snapshot({ message: 'run end' })
    const files = await checkpoints.diff({ from: baseline.commit, to: final.commit })
    assert.deepEqual(files.map((file) => [file.path, file.change]).sort(), [['keep.txt', 'modified'], ['new.txt', 'added']])
    const modified = files.find((file) => file.path === 'keep.txt')
    assert.equal(modified.added, 1)
    assert.equal(modified.removed, 1)
  })
})

test('a finished run has a baseline-to-final diff of covered changes', async () => {
  const definition = { objective: 'Diff.', tasks: [{ role: 'builder', title: 'Write', instructions: 'Write out.txt.', dependsOn: [] }] }
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: JSON.stringify(definition), toolCalls: [], usage: null }
    if (instructions.includes('Forge') && !messages.some((message) => message.role === 'tool')) {
      return { text: 'Writing.', toolCalls: [{ id: 'w1', name: 'workspace.write', arguments: { path: 'out.txt', content: 'diff me\n' } }], usage: null }
    }
    return { text: 'Done.', toolCalls: [], usage: null }
  }
  await withTempDirectory(async (workspace) => {
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir: path.join(workspace, 'data') })
    await withServer(async ({ request, store, providerRegistry }) => {
      providerRegistry.addCustom({ label: 'Diff fixture', baseUrl: 'https://example.invalid/v1', model: 'fixture-model', apiKey: 'fixture-key' })
      const project = await request('POST', '/api/projects', { name: 'diff fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      await request('POST', '/api/chat', { runId, message: 'Do the thing.', history: [] })
      const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
      await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && store.getRun(runId).status === 'executing') await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(store.getRun(runId).status, 'review', `unexpected status ${store.getRun(runId).status}`)
      assert.ok(store.listEvents(runId).find((event) => event.type === 'checkpoint.baseline'), 'the baseline is on the chain')
      assert.ok(store.listEvents(runId).find((event) => event.type === 'checkpoint.final'), 'and the run-end snapshot too')

      const diff = await request('GET', `/api/runs/${runId}/checkpoint-diff`)
      assert.equal(diff.status, 200)
      assert.equal(diff.payload.available, true, JSON.stringify(diff.payload))
      const entry = diff.payload.files.find((file) => file.path === 'out.txt')
      assert.ok(entry, `out.txt in ${JSON.stringify(diff.payload.files)}`)
      assert.equal(entry.change, 'added')
      assert.ok(entry.added >= 1)
    }, { workspaceRoot: workspace, checkpoints, model })
  })
})

test('discard restores covered originals, removes run-created files, and never touches conflicts', async () => {
  const files = [
    { path: 'keep.txt', content: 'changed by the run\n' },
    { path: 'out.txt', content: 'created by the run\n' },
    { path: 'gone.txt', content: 'created and untouched\n' },
  ]
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: JSON.stringify({ objective: 'Discard.', tasks: [{ role: 'builder', title: 'Write', instructions: 'Write files.', dependsOn: [] }] }), toolCalls: [], usage: null }
    if (instructions.includes('Forge')) {
      const rounds = messages.filter((message) => message.role === 'tool').length
      if (rounds < files.length) return { text: `Writing ${files[rounds].path}`, toolCalls: [{ id: `w${rounds}`, name: 'workspace.write', arguments: files[rounds] }], usage: null }
    }
    return { text: 'Done.', toolCalls: [], usage: null }
  }
  await withTempDirectory(async (workspace) => {
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir: path.join(workspace, 'data') })
    await writeFile(path.join(workspace, 'keep.txt'), 'original\n', 'utf8')
    await withServer(async ({ request, store, providerRegistry }) => {
      providerRegistry.addCustom({ label: 'Discard fixture', baseUrl: 'https://example.invalid/v1', model: 'fixture-model', apiKey: 'fixture-key' })
      const project = await request('POST', '/api/projects', { name: 'discard fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      await request('POST', '/api/chat', { runId, message: 'Do the thing.', history: [] })
      const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
      await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && store.getRun(runId).status === 'executing') await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(store.getRun(runId).status, 'review', `unexpected status ${store.getRun(runId).status}`)
      // An edit after the run ended: out.txt is now a conflict.
      await writeFile(path.join(workspace, 'out.txt'), 'edited after the run\n', 'utf8')
      const diff = await request('GET', `/api/runs/${runId}/checkpoint-diff`)
      assert.equal(diff.payload.files.find((file) => file.path === 'out.txt')?.conflict, true, 'the diff marks what moved since the run ended')
      assert.equal(diff.payload.files.find((file) => file.path === 'keep.txt')?.conflict, false)

      const discarded = await request('POST', `/api/runs/${runId}/checkpoint-discard`, {})
      assert.equal(discarded.status, 200, JSON.stringify(discarded.payload))
      assert.deepEqual(discarded.payload.restored.restored, ['keep.txt'])
      assert.deepEqual(discarded.payload.restored.removed, ['gone.txt'])
      assert.deepEqual(discarded.payload.restored.skipped, [{ path: 'out.txt', reason: 'changed since the run ended' }])
      assert.equal(await readFile(path.join(workspace, 'keep.txt'), 'utf8'), 'original\n', 'the original bytes are back')
      assert.equal(existsSync(path.join(workspace, 'gone.txt')), false, 'a run-created file is removed')
      assert.equal(await readFile(path.join(workspace, 'out.txt'), 'utf8'), 'edited after the run\n', 'a conflict is left alone')

      const recorded = store.listEvents(runId).find((event) => event.type === 'checkpoint.discarded')
      assert.ok(recorded, 'the decision and its receipts are on the chain')
      assert.deepEqual(recorded.payload.skipped, [{ path: 'out.txt', reason: 'changed since the run ended' }])
      const repeated = await request('POST', `/api/runs/${runId}/checkpoint-discard`, {})
      assert.equal(repeated.status, 409, 'restart never repeats a completed restore')
    }, { workspaceRoot: workspace, checkpoints, model })
  })
})

test('accept records the decision without touching files, and undo restores afterwards', async () => {
  const definition = { objective: 'Accept.', tasks: [{ role: 'builder', title: 'Write', instructions: 'Write out.txt.', dependsOn: [] }] }
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: JSON.stringify(definition), toolCalls: [], usage: null }
    if (instructions.includes('Forge') && !messages.some((message) => message.role === 'tool')) {
      return { text: 'Writing.', toolCalls: [{ id: 'w1', name: 'workspace.write', arguments: { path: 'out.txt', content: 'accepted\n' } }], usage: null }
    }
    return { text: 'Done.', toolCalls: [], usage: null }
  }
  await withTempDirectory(async (workspace) => {
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir: path.join(workspace, 'data') })
    await withServer(async ({ request, store, providerRegistry }) => {
      providerRegistry.addCustom({ label: 'Accept fixture', baseUrl: 'https://example.invalid/v1', model: 'fixture-model', apiKey: 'fixture-key' })
      const project = await request('POST', '/api/projects', { name: 'accept fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      await request('POST', '/api/chat', { runId, message: 'Do the thing.', history: [] })
      const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
      await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && store.getRun(runId).status === 'executing') await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(store.getRun(runId).status, 'review')

      const refused = await request('POST', `/api/runs/${runId}/checkpoint-accept`, {})
      assert.equal(refused.status, 409, 'unproven outcomes cannot be accepted silently')
      assert.equal(refused.payload.unresolved.length, 1)
      const accepted = await request('POST', `/api/runs/${runId}/checkpoint-accept`, { acknowledged: true })
      assert.equal(accepted.status, 200, JSON.stringify(accepted.payload))
      assert.equal(accepted.payload.already, false)
      assert.equal(accepted.payload.unresolved, 1, 'the acknowledgment is recorded with the count')
      assert.equal(existsSync(path.join(workspace, 'out.txt')), true, 'accept never re-applies or removes anything')
      const again = await request('POST', `/api/runs/${runId}/checkpoint-accept`, { acknowledged: true })
      assert.equal(again.payload.already, true, 'the decision is recorded once')

      const undone = await request('POST', `/api/runs/${runId}/checkpoint-discard`, { mode: 'undo' })
      assert.equal(undone.status, 200, JSON.stringify(undone.payload))
      assert.equal(existsSync(path.join(workspace, 'out.txt')), false, 'undo removes the accepted creation')
      assert.ok(store.listEvents(runId).find((event) => event.type === 'checkpoint.undone'), 'the undo is on the chain')
      assert.ok(store.verifyEventChain(runId).ok)
    }, { workspaceRoot: workspace, checkpoints, model })
  })
})

test('a second write-capable run waits for the first and starts when it is decided', async () => {
  const definition = { objective: 'Queue.', tasks: [{ role: 'research', title: 'Look', instructions: 'Report.', dependsOn: [] }] }
  const model = async ({ options }) => {
    if (String(options?.instructions ?? '').includes('You plan work')) return { text: JSON.stringify(definition), toolCalls: [], usage: null }
    return { text: 'Summary.', toolCalls: [], usage: null }
  }
  await withTempDirectory(async (workspace) => {
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir: path.join(workspace, 'data') })
    await withServer(async ({ request, store, providerRegistry }) => {
      providerRegistry.addCustom({ label: 'Queue fixture', baseUrl: 'https://example.invalid/v1', model: 'fixture-model', apiKey: 'fixture-key' })
      const startRun = async (name) => {
        const project = await request('POST', '/api/projects', { name })
        const run = await request('POST', '/api/runs', { projectId: project.payload.project.id })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Do the thing.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
        return runId
      }
      const waitFor = async (predicate, label) => {
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline && !predicate()) await new Promise((resolve) => setTimeout(resolve, 100))
        assert.ok(predicate(), label)
      }

      const first = await startRun('queue first')
      await waitFor(() => store.getRun(first).status === 'review', 'the first run reaches review and holds the writer slot')

      const second = await startRun('queue second')
      await waitFor(() => store.listEvents(second).some((event) => event.type === 'workspace.waiting'), 'the second run waits')
      const waiting = store.listEvents(second).find((event) => event.type === 'workspace.waiting')
      assert.equal(waiting.payload.holder, first, 'and it is told who holds the slot')
      assert.equal(store.listEvents(second).some((event) => event.type === 'task.started'), false, 'no work starts while waiting')

      // The decision releases the slot; the queued run starts on its own.
      const accepted = await request('POST', `/api/runs/${first}/checkpoint-accept`, { acknowledged: true })
      assert.equal(accepted.status, 200, JSON.stringify(accepted.payload))
      await waitFor(() => store.listEvents(second).some((event) => event.type === 'task.started'), 'the queued run starts after the decision')
      await waitFor(() => store.getRun(second).status === 'review', 'and finishes')
    }, { workspaceRoot: workspace, checkpoints, model })
  })
})

test('the status endpoint reports the checkpoint store honestly', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    await withServer(async ({ request }) => {
      const before = await request('GET', '/api/status')
      assert.equal(before.payload.checkpoints.available, true, 'host Git is present on this machine')
      assert.equal(before.payload.checkpoints.initialized, false, 'nothing is created until the first write needs it')
      assert.equal(before.payload.checkpoints.bytes, 0)

      await checkpoints.ensure()
      const after = await request('GET', '/api/status')
      assert.equal(after.payload.checkpoints.initialized, true)
      assert.equal(after.payload.checkpoints.checkpoints, 0, 'an empty repository has no checkpoints yet')
      assert.equal(after.payload.checkpoints.bytes > 0, true, 'the cost of the store is visible')
    }, { workspaceRoot: workspace, checkpoints })
  })
})

test('a checkpoint commits the change and binds it to its cause', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    await writeFile(path.join(workspace, 'a.txt'), 'one\n')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    const result = await checkpoints.checkpoint({ paths: ['a.txt'], runId: 'run-1', taskId: 'task-1', toolCallId: 'call-1' })
    assert.ok(result.commit, 'a commit exists')
    assert.equal(result.unchanged, false)
    const subject = (await checkpoints.run(['log', '-1', '--format=%s'])).stdout.trim()
    assert.match(subject, /run-1/)
    assert.match(subject, /task-1/)
    assert.match(subject, /call-1/)
    assert.equal((await checkpoints.status()).checkpoints, 1)
  })
})

test('the persistent index snapshots the whole tree from a one-path add', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    await writeFile(path.join(workspace, 'a.txt'), 'one\n')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    await checkpoints.checkpoint({ paths: ['a.txt'] })
    await writeFile(path.join(workspace, 'b.txt'), 'bee\n')
    await checkpoints.checkpoint({ paths: ['b.txt'] })
    const tree = await checkpoints.run(['ls-tree', '--name-only', 'HEAD'])
    assert.deepEqual(tree.stdout.trim().split('\n').sort(), ['a.txt', 'b.txt'], 'the newest commit carries every tracked path')
  })
})

test('a checkpoint stores the bytes on disk, line endings included', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    await writeFile(path.join(workspace, 'crlf.txt'), 'line one\r\nline two\r\n')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    await checkpoints.checkpoint({ paths: ['crlf.txt'] })
    const blob = await checkpoints.run(['show', 'HEAD:crlf.txt'])
    assert.equal(blob.stdout, 'line one\r\nline two\r\n', 'no translation between disk and history')
  })
})

test('an unchanged write and an excluded write are reported, not committed', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    await writeFile(path.join(workspace, '.fulkrumignore'), 'generated/\n')
    await writeFile(path.join(workspace, 'a.txt'), 'one\n')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    await checkpoints.checkpoint({ paths: ['a.txt'] })
    const again = await checkpoints.checkpoint({ paths: ['a.txt'] })
    assert.equal(again.commit, null)
    assert.equal(again.unchanged, true)
    await mkdir(path.join(workspace, 'generated'), { recursive: true })
    await writeFile(path.join(workspace, 'generated', 'out.js'), 'built\n')
    const excluded = await checkpoints.checkpoint({ paths: ['generated/out.js'] })
    assert.equal(excluded.commit, null, 'an excluded path is legitimate but not checkpointed')
    assert.deepEqual(excluded.ignored, ['generated/out.js'])
    assert.equal((await checkpoints.status()).checkpoints, 1, 'still just the one commit')
  })
})

test('paths outside the workspace are dropped, never checkpointed', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    await writeFile(path.join(workspace, 'a.txt'), 'inside\n')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    const result = await checkpoints.checkpoint({ paths: ['../outside.txt', 'a.txt'] })
    assert.ok(result.commit, 'the inside path is checkpointed')
    const tree = await checkpoints.run(['ls-tree', '--name-only', 'HEAD'])
    assert.deepEqual(tree.stdout.trim().split('\n'), ['a.txt'], 'the outside path never enters history')
  })
})

test('an approved write becomes a checkpoint on the chain', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'checkpoint fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
      const runId = run.payload.run.id
      const requested = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'proof.txt', content: 'checkpoint me\n' } })
      assert.equal(requested.status, 409, 'the write waits for approval')
      const approved = await request('POST', `/api/runs/${runId}/tools/${requested.payload.toolCall.id}/approve`, { fingerprint: requested.payload.toolCall.fingerprint })
      assert.equal(approved.status, 200, JSON.stringify(approved.payload))

      const created = store.listEvents(runId).find((event) => event.type === 'checkpoint.created')
      assert.ok(created, 'the write is bound to a checkpoint on the chain')
      assert.equal(created.payload.path, 'proof.txt')
      const blob = await checkpoints.run(['show', `${created.payload.commit}:proof.txt`])
      assert.equal(blob.stdout, 'checkpoint me\n', 'the commit holds the bytes that were written')
      assert.equal((await checkpoints.status()).checkpoints >= 1, true)
    }, { workspaceRoot: workspace, checkpoints })
  })
})

test('a write that cannot be checkpointed interrupts the run', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    await checkpoints.ensure()
    checkpoints.checkpoint = async () => { throw new Error('disk full') }
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'broken checkpoint fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
      const runId = run.payload.run.id
      const requested = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'proof.txt', content: 'x\n' } })
      const approved = await request('POST', `/api/runs/${runId}/tools/${requested.payload.toolCall.id}/approve`, { fingerprint: requested.payload.toolCall.fingerprint })
      assert.equal(approved.status, 502, JSON.stringify(approved.payload))
      assert.match(String(approved.payload.error), /could not be checkpointed: disk full/)
      const failed = store.getToolCall(requested.payload.toolCall.id)
      assert.equal(failed.status, 'failed')
      const interrupted = store.getRun(runId)
      assert.equal(interrupted.status, 'interrupted', 'the run does not continue over unrecorded state')
      assert.equal(interrupted.interruptedFrom, 'executing')
      assert.match(String(interrupted.interruptionReason), /could not be checkpointed/)
    }, { workspaceRoot: workspace, checkpoints })
  })
})

test('without host Git, a write is refused before it happens', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    const execFileImpl = async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir, execFileImpl })
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'no git fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
      const runId = run.payload.run.id
      const requested = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'proof.txt', content: 'x\n' } })
      const approved = await request('POST', `/api/runs/${runId}/tools/${requested.payload.toolCall.id}/approve`, { fingerprint: requested.payload.toolCall.fingerprint })
      assert.equal(approved.status, 502)
      assert.match(String(approved.payload.error), /Git/)
      assert.equal(existsSync(path.join(workspace, 'proof.txt')), false, 'nothing was written')
      assert.equal(store.getToolCall(requested.payload.toolCall.id).status, 'failed')
      assert.equal(store.getRun(runId).status, 'planning', 'a refusal is not an interruption — the run is untouched')
    }, { workspaceRoot: workspace, checkpoints })
  })
})

test('a restore brings back the bytes a checkpoint captured and records itself', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    await writeFile(path.join(workspace, 'note.txt'), 'first\n')
    const first = await checkpoints.checkpoint({ paths: ['note.txt'], message: 'write note.txt' })
    await writeFile(path.join(workspace, 'note.txt'), 'second\n')
    await checkpoints.checkpoint({ paths: ['note.txt'], message: 'write note.txt' })
    const restored = await checkpoints.restore({ commit: first.commit })
    assert.equal(restored.from, first.commit)
    assert.deepEqual(restored.paths, ['note.txt'])
    assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'first\n', 'the disk holds the captured bytes')
    assert.ok(restored.commit, 'the restore is itself a checkpoint')
    const entries = await checkpoints.list()
    assert.equal(entries[0].commit, restored.commit)
    assert.match(entries[0].subject, /restore/)
  })
})

test('a restore of an unknown commit is refused, and history never rewinds', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    await writeFile(path.join(workspace, 'note.txt'), 'first\n')
    const first = await checkpoints.checkpoint({ paths: ['note.txt'] })
    await assert.rejects(() => checkpoints.restore({ commit: 'deadbeef' }))
    assert.equal((await checkpoints.list())[0].commit, first.commit, 'the failed restore wrote no checkpoint')
  })
})

test('the restore endpoint rewinds a write and says so on the chain', async () => {
  await withTempDirectory(async (workspace) => {
    const dataDir = path.join(workspace, 'data')
    const checkpoints = createCheckpointStore({ workspaceRoot: workspace, dataDir })
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'restore fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
      const runId = run.payload.run.id
      const write = async (content) => {
        const requested = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'note.txt', content } })
        const approved = await request('POST', `/api/runs/${runId}/tools/${requested.payload.toolCall.id}/approve`, { fingerprint: requested.payload.toolCall.fingerprint })
        assert.equal(approved.status, 200, JSON.stringify(approved.payload))
      }
      await write('first\n')
      await write('second\n')
      const first = store.listEvents(runId).filter((event) => event.type === 'checkpoint.created')[0]
      assert.ok(first, 'both writes are checkpointed')

      const restored = await request('POST', `/api/runs/${runId}/checkpoints/restore`, { commit: first.payload.commit })
      assert.equal(restored.status, 200, JSON.stringify(restored.payload))
      assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'first\n')
      const recorded = store.listEvents(runId).find((event) => event.type === 'checkpoint.restored')
      assert.equal(recorded.payload.from, first.payload.commit)
      assert.deepEqual(recorded.payload.paths, ['note.txt'])

      store.updateRun(runId, { status: 'executing' })
      const refused = await request('POST', `/api/runs/${runId}/checkpoints/restore`, { commit: first.payload.commit })
      assert.equal(refused.status, 409, 'a running run is not restored under its workers')
      store.updateRun(runId, { status: 'planning' })

      const malformed = await request('POST', `/api/runs/${runId}/checkpoints/restore`, { commit: '--all' })
      assert.equal(malformed.status, 400, 'a commit argument is validated as a hash, never trusted as text')
      const unknown = await request('POST', `/api/runs/${runId}/checkpoints/restore`, { commit: 'deadbeef' })
      assert.equal(unknown.status, 409)
    }, { workspaceRoot: workspace, checkpoints })
  })
})
