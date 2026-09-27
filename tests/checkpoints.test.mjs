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
