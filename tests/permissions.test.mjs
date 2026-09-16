import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { decidePermission, fingerprintInput, isSensitivePath, permissionMatrix, resolveWorkspacePath, resolveToolCall } from '../server/permissions.mjs'
import { FulkrumToolBroker } from '../server/toolBroker.mjs'
import { withWorkspace } from './helpers.mjs'

const mode = (workspaceRoot, name, input) => resolveToolCall({ name, input, workspaceRoot })

test('paths cannot escape the workspace', async () => {
  await withWorkspace(async (directory) => {
    assert.throws(() => resolveWorkspacePath(directory, '../outside.txt'), /inside the Fulkrum workspace/)
    assert.throws(() => resolveWorkspacePath(directory, path.join(directory, '..', 'outside.txt')), /inside the Fulkrum workspace/)
    assert.doesNotThrow(() => resolveWorkspacePath(directory, path.join('src', 'notes.txt')))
  })
})

test('a workspace root reached through a link still contains its files', async (t) => {
  // The configured root can differ from its real path — an 8.3 short name on a CI
  // runner, a symlinked or junctioned project directory. Judging containment by
  // comparing real paths against the verbatim root reports a false escape, which
  // is what happened on the first CI run.
  const real = await mkdtemp(path.join(tmpdir(), 'fulkrum-real-'))
  const holder = await mkdtemp(path.join(tmpdir(), 'fulkrum-link-'))
  const link = path.join(holder, 'workspace')

  try {
    // A junction works on Windows without elevation and is the common real-world
    // case (linked project folders); elsewhere a plain directory symlink.
    await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    await rm(holder, { recursive: true, force: true })
    await rm(real, { recursive: true, force: true })
    t.skip(`cannot create a directory link here (${error.code})`)
    return
  }

  try {
    await writeFile(path.join(real, 'notes.txt'), 'link fixture content', 'utf8')
    const realRoot = realpathSync.native(real)

    // Resolution reports a path relative to the real root, not a traversal out of it.
    const resolution = resolveWorkspacePath(link, 'notes.txt')
    assert.equal(resolution.relative, 'notes.txt')
    assert.equal(resolution.resolved, path.join(realRoot, 'notes.txt'))

    // And the tool that actually reads files works through the linked root.
    const broker = new FulkrumToolBroker({ workspaceRoot: link })
    assert.equal(broker.workspaceRoot, realRoot, 'the broker normalizes its root once')
    assert.equal((await broker.execute('workspace.read', { path: 'notes.txt' })).content, 'link fixture content')

    // Containment still holds: a link inside the workspace cannot reach outside it.
    assert.throws(() => resolveWorkspacePath(link, '../outside.txt'), /inside the Fulkrum workspace/)
  } finally {
    await rm(holder, { recursive: true, force: true })
    await rm(real, { recursive: true, force: true })
  }
})

test('windows path traps are refused', async () => {
  await withWorkspace(async (directory) => {
    assert.throws(() => resolveWorkspacePath(directory, 'notes.txt:hidden'), /Alternate data stream/)
    assert.throws(() => resolveWorkspacePath(directory, 'CON'), /Reserved device names/)
    assert.throws(() => resolveWorkspacePath(directory, '\\\\server\\share\\file'), /UNC and device paths/)
  })
})

test('credential paths are recognised as sensitive', () => {
  for (const candidate of ['.env', '.env.local', 'secrets.pem', 'server.key', 'id_rsa', 'id_ed25519', 'id_ed25519.pub', '.npmrc', '.netrc', 'credentials.json', 'data/fulkrum.sqlite', 'dump.db', 'castore.p12']) {
    assert.equal(isSensitivePath(candidate), true, `${candidate} should be sensitive`)
  }
  for (const candidate of ['README.md', 'src/index.ts', 'notes.txt', 'package.json']) {
    assert.equal(isSensitivePath(candidate), false, `${candidate} should not be sensitive`)
  }
})

test('resolution reports resolved absolute paths, not the model\'s text', async () => {
  await withWorkspace(async (directory) => {
    const resolution = mode(directory, 'workspace.read', { path: './src/../README.md' })
    assert.equal(resolution.ok, true)
    assert.equal(resolution.resolved.path, path.join(directory, 'README.md'))
    assert.equal(resolution.resolved.relative, 'README.md')
  })
})

test('fingerprints are stable, and change when anything meaningful changes', async () => {
  await withWorkspace(async (directory) => {
    const first = fingerprintInput({ name: 'workspace.write', input: { path: 'a.txt', content: 'one' }, workspaceRoot: directory })
    const same = fingerprintInput({ name: 'workspace.write', input: { path: 'a.txt', content: 'one' }, workspaceRoot: directory })
    const differentContent = fingerprintInput({ name: 'workspace.write', input: { path: 'a.txt', content: 'two' }, workspaceRoot: directory })
    const differentPath = fingerprintInput({ name: 'workspace.write', input: { path: 'b.txt', content: 'one' }, workspaceRoot: directory })

    assert.equal(first, same)
    assert.notEqual(first, differentContent, 'a changed payload must invalidate the approval')
    assert.notEqual(first, differentPath)
  })
})

test('the permission matrix allows reads, asks for writes, and denies secrets in every mode', async () => {
  await withWorkspace(async (directory) => {
    const broker = new FulkrumToolBroker({ workspaceRoot: directory })
    const readTool = broker.get('workspace.read')
    const writeTool = broker.get('workspace.write')
    const shellTool = broker.get('shell.exec')
    const httpTool = broker.get('http.request')

    assert.equal(broker.authorize({ mode: 'guided', tool: readTool, resolution: mode(directory, 'workspace.read', { path: 'README.md' }) }).decision, 'allow')
    assert.equal(broker.authorize({ mode: 'guided', tool: writeTool, resolution: mode(directory, 'workspace.write', { path: 'a.txt', content: '' }) }).decision, 'ask')
    assert.equal(broker.authorize({ mode: 'selective', tool: writeTool, resolution: mode(directory, 'workspace.write', { path: 'a.txt', content: '' }) }).decision, 'ask')
    assert.equal(broker.authorize({ mode: 'autopilot', tool: writeTool, resolution: mode(directory, 'workspace.write', { path: 'a.txt', content: '' }) }).decision, 'allow')
    assert.equal(broker.authorize({ mode: 'autopilot', tool: shellTool, resolution: mode(directory, 'shell.exec', { command: 'git', args: ['status'], cwd: '.' }) }).decision, 'allow')
    assert.equal(broker.authorize({ mode: 'selective', tool: shellTool, resolution: mode(directory, 'shell.exec', { command: 'git', args: ['status'], cwd: '.' }) }).decision, 'ask')
    assert.equal(broker.authorize({ mode: 'autopilot', tool: httpTool, resolution: mode(directory, 'http.request', { url: 'https://example.com' }) }).decision, 'ask', 'autopilot HTTP without an allowlist still asks')

    // Deny outranks allow: autopilot cannot write to a credential file.
    const sensitive = broker.authorize({ mode: 'autopilot', tool: writeTool, resolution: mode(directory, 'workspace.write', { path: '.env.local', content: 'x' }) })
    assert.equal(sensitive.decision, 'deny')
    assert.match(sensitive.reason, /Sensitive files/)

    assert.equal(broker.authorize({ mode: 'autopilot', tool: null, resolution: { ok: false, error: 'Unknown tool.' } }).decision, 'deny')
    assert.equal(broker.authorize({ mode: 'autopilot', tool: readTool, resolution: { ok: false, error: 'Path must stay inside the Fulkrum workspace.' } }).decision, 'deny')
  })
})

test('deny rules are evaluated before ask and allow rules', () => {
  const decisions = permissionMatrix.map((rule) => rule.decision)
  const firstAsk = decisions.indexOf('ask')
  const firstAllow = decisions.indexOf('allow')
  assert.equal(decisions.slice(0, firstAsk).every((decision) => decision === 'deny'), true, 'deny rules must come first')
  assert.ok(firstAsk < firstAllow, 'ask rules must be evaluated before allow rules')

  // An unresolvable call is denied even in the most permissive mode.
  assert.equal(decidePermission({ mode: 'autopilot', tool: { kind: 'write' }, resolution: { ok: false, error: 'nope' } }).decision, 'deny')
})
