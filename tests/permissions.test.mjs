import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { decidePermission, fingerprintInput, isSensitivePath, permissionMatrix, resolveWorkspacePath, resolveToolCall, standingScopeFor, standingScopeMatches, validateStandingScope } from '../server/permissions.mjs'
import { FulkrumToolBroker } from '../server/toolBroker.mjs'
import { withWorkspace } from './helpers.mjs'

const mode = (workspaceRoot, name, input) => resolveToolCall({ name, input, workspaceRoot })

test('a question parks in every mode, including autopilot', async () => {
  await withWorkspace(async (directory) => {
    const resolution = mode(directory, 'run.ask', { question: 'Which color?' })
    assert.equal(resolution.ok, true)
    assert.equal(resolution.resolved.question, 'Which color?')
    for (const permissionMode of ['guided', 'selective', 'autopilot']) {
      const decision = decidePermission({ mode: permissionMode, tool: { name: 'run.ask', kind: 'ask' }, resolution, httpAllowlist: [] })
      assert.equal(decision.requiresApproval, true, `${permissionMode} still parks a question`)
      assert.equal(decision.ruleId, 'ask.question')
    }
    assert.equal(mode(directory, 'run.ask', {}).ok, false, 'a question without a question is unresolvable')
  })
})

test('a secret-shaped body asks outside the allowlist, like a credential header', async () => {
  await withWorkspace(async (directory) => {
    const secret = mode(directory, 'http.request', { url: 'https://api.test/submit', method: 'POST', body: { token: 'sk-abcdefghijklmnopqrstuvwxyz0123' } })
    assert.equal(secret.ok, true)
    assert.equal(secret.resolved.bodyHasSecrets, true, 'the resolution records the shape, not the secret')
    const plain = mode(directory, 'http.request', { url: 'https://api.test/submit', method: 'POST', body: { note: 'hello' } })
    assert.equal(plain.resolved.bodyHasSecrets, false)

    const ask = decidePermission({ mode: 'autopilot', tool: { name: 'http.request', kind: 'http' }, resolution: secret, httpAllowlist: [] })
    assert.equal(ask.requiresApproval, true, 'autopilot cannot quietly POST a secret elsewhere')
    assert.equal(ask.ruleId, 'ask.http-secret-body')

    const trusted = decidePermission({ mode: 'autopilot', tool: { name: 'http.request', kind: 'http' }, resolution: secret, httpAllowlist: ['api.test'] })
    assert.equal(trusted.allowed, true, 'an allowlisted host is pre-approved trust')
  })
})

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

    // The same traps behind a drive letter. An absolute path used to return early,
    // so C:\ws\CON.txt reached the device and C:\ws\a.txt:stream reached an
    // alternate data stream — neither is visible in an ordinary listing.
    assert.throws(() => resolveWorkspacePath(directory, path.join(directory, 'CON.txt')), /Reserved device names/)
    assert.throws(() => resolveWorkspacePath(directory, path.join(directory, 'src', 'LPT1.md')), /Reserved device names/)
    assert.throws(() => resolveWorkspacePath(directory, path.join(directory, 'notes.txt:stream')), /Alternate data stream/)

    // An ordinary absolute path is still allowed.
    assert.doesNotThrow(() => resolveWorkspacePath(directory, path.join(directory, 'README.md')))
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

test('an outbound request that carries a credential needs approval', async () => {
  await withWorkspace(async (directory) => {
    const broker = new FulkrumToolBroker({ workspaceRoot: directory, httpAllowlist: [] })
    const httpTool = broker.get('http.request')

    const withAuth = broker.authorize({
      mode: 'autopilot',
      tool: httpTool,
      resolution: mode(directory, 'http.request', { url: 'https://example.com/api', headers: { Authorization: 'Bearer abc' } }),
    })
    assert.equal(withAuth.decision, 'ask', 'even autopilot pauses before handing a credential to a host')
    assert.equal(withAuth.ruleId, 'ask.http-credential-headers')

    // A header nobody thinks of as a credential is still a credential header.
    for (const header of ['Cookie', 'X-Api-Key', 'Proxy-Authorization', 'api-key']) {
      const decision = broker.authorize({ mode: 'autopilot', tool: httpTool, resolution: mode(directory, 'http.request', { url: 'https://example.com/api', headers: { [header]: 'v' } }) })
      assert.equal(decision.ruleId, 'ask.http-credential-headers', `${header} should be treated as a credential`)
    }

    const plain = broker.authorize({ mode: 'autopilot', tool: httpTool, resolution: mode(directory, 'http.request', { url: 'https://example.com/api' }) })
    assert.equal(plain.ruleId, 'ask.http-autopilot-without-allowlist', 'a request with no such header falls to the ordinary rule')

    // An allowlisted host is the user saying they trust it with the credential.
    const allowedHost = new FulkrumToolBroker({ workspaceRoot: directory, httpAllowlist: ['example.com'] })
    const allowlisted = allowedHost.authorize({
      mode: 'autopilot',
      tool: httpTool,
      resolution: mode(directory, 'http.request', { url: 'https://example.com/api', headers: { Authorization: 'Bearer abc' } }),
    })
    assert.equal(allowlisted.decision, 'allow')
  })
})

test('a standing scope is drawn where the risk ends', () => {
  // A file's scope is the directory it is in; a directory tool's scope is the
  // directory itself, which is the difference between usable and pointless.
  assert.deepEqual(standingScopeFor({ toolName: 'workspace.write', resolved: { relative: 'src/app.js' } }).value, 'src')
  assert.deepEqual(standingScopeFor({ toolName: 'workspace.list', resolved: { relative: 'src', directory: true } }).value, 'src')
  assert.equal(standingScopeFor({ toolName: 'http.request', resolved: { host: 'api.example.com' } }).kind, 'host')

  // Nothing to bound: the workspace root would cover everything, and a command has
  // no boundary at all.
  assert.equal(standingScopeFor({ toolName: 'workspace.write', resolved: { relative: 'README.md' } }).ok, false)
  assert.equal(standingScopeFor({ toolName: 'workspace.list', resolved: { relative: '.', directory: true } }).ok, false)
  assert.equal(standingScopeFor({ toolName: 'shell.exec', resolved: { argv: ['rm', '-rf', '/'] } }).ok, false)

  // Matching is on directory boundaries, not string prefixes, and a host grant is
  // exactly that host.
  const pathGrant = { scopeKind: 'path', scopeValue: 'src' }
  assert.equal(standingScopeMatches(pathGrant, { relative: 'src/app.js' }), true)
  assert.equal(standingScopeMatches(pathGrant, { relative: 'src' }), true, 'a directory tool on the scope itself is covered')
  assert.equal(standingScopeMatches(pathGrant, { relative: 'src2/app.js' }), false, 'a sibling with a shared prefix is not')
  assert.equal(standingScopeMatches({ scopeKind: 'host', scopeValue: 'api.example.com' }, { host: 'api.example.com' }), true)
  assert.equal(standingScopeMatches({ scopeKind: 'host', scopeValue: 'api.example.com' }, { host: 'evil.api.example.com' }), false)

  // Values a caller supplies directly are checked rather than trusted.
  for (const value of ['/etc', 'C:\\Windows', '../outside', '.', '', 'src/../../etc']) {
    assert.equal(validateStandingScope({ toolName: 'workspace.write', scopeKind: 'path', scopeValue: value }).ok, false, `${value} should be refused`)
  }
  assert.equal(validateStandingScope({ toolName: 'workspace.write', scopeKind: 'path', scopeValue: 'src/\\sub/' }).value, 'src/sub')
  assert.equal(validateStandingScope({ toolName: 'http.request', scopeKind: 'host', scopeValue: 'not a host' }).ok, false)
  assert.equal(validateStandingScope({ toolName: 'http.request', scopeKind: 'other', scopeValue: 'x' }).ok, false)
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
