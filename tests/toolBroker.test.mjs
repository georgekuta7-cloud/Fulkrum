import assert from 'node:assert/strict'
import test from 'node:test'
import { findSecrets, redact } from '../server/redaction.mjs'
import { FulkrumToolBroker, validateGitArgv } from '../server/toolBroker.mjs'
import { withWorkspace } from './helpers.mjs'

test('the broker refuses to read credentials', async () => {
  await withWorkspace(async (directory) => {
    const broker = new FulkrumToolBroker({ workspaceRoot: directory })
    await assert.rejects(() => broker.execute('workspace.read', { path: '.env.local' }), /Sensitive files/)
    await assert.rejects(() => broker.execute('workspace.read', { path: './src/../.env.local' }), /Sensitive files/)
    assert.equal((await broker.execute('workspace.read', { path: 'README.md' })).content, '# Fixture readme\n')
  })
})

test('search does not surface secrets and listings hide them', async () => {
  await withWorkspace(async (directory) => {
    const broker = new FulkrumToolBroker({ workspaceRoot: directory })
    const search = await broker.execute('workspace.search', { path: '.', query: 'SECRET_VALUE' })
    assert.deepEqual(search.results, [])

    const listing = await broker.execute('workspace.list', { path: '.' })
    assert.equal(listing.entries.some((entry) => entry.name === '.env.local'), false)

    const readable = await broker.execute('workspace.search', { path: '.', query: 'fixture' })
    assert.ok(readable.results.length > 0)
  })
})

test('shell execution is limited to read-only git inspection', async () => {
  await withWorkspace(async (directory) => {
    const broker = new FulkrumToolBroker({ workspaceRoot: directory })
    await assert.rejects(() => broker.execute('shell.exec', { command: 'node', args: ['-e', 'console.log(1)'], cwd: '.' }), /Only read-only git commands/)
    await assert.rejects(() => broker.execute('shell.exec', { command: 'powershell', args: ['-Command', 'whoami'], cwd: '.' }), /Only read-only git commands/)
    await assert.rejects(() => broker.execute('shell.exec', { command: 'git', args: ['push'], cwd: '.' }), /status, diff, and log/)

    // The argument vector is validated, not just the first element.
    assert.throws(() => validateGitArgv({ argv: ['git', 'diff', '--no-index', '/etc/passwd', '/etc/hosts'], workspaceRoot: directory }), /not allowlisted/)
    assert.throws(() => validateGitArgv({ argv: ['git', '-c', 'core.pager=sh', 'log'], workspaceRoot: directory }), /not allowlisted|status, diff, and log/)
    assert.throws(() => validateGitArgv({ argv: ['git', 'diff', '--ext-diff'], workspaceRoot: directory }), /not allowlisted/)
    assert.throws(() => validateGitArgv({ argv: ['git', 'log', '--config-env=core.pager=EVIL'], workspaceRoot: directory }), /not allowlisted/)
    assert.throws(() => validateGitArgv({ argv: ['git', 'diff', '--', '../outside.txt'], workspaceRoot: directory }), /inside the Fulkrum workspace/)
    assert.throws(() => validateGitArgv({ argv: ['git', 'status', '--output=/tmp/x'], workspaceRoot: directory }), /not allowlisted/)

    // A read-only inspection of the workspace is allowed.
    const allowed = validateGitArgv({ argv: ['git', 'status', '--short'], workspaceRoot: directory })
    assert.deepEqual(allowed.argv, ['git', 'status', '--short'])
    const diff = validateGitArgv({ argv: ['git', 'diff', '--stat'], workspaceRoot: directory })
    assert.deepEqual(diff.argv, ['git', 'diff', '--no-textconv', '--no-ext-diff', '--stat'])
  })
})

test('credential shapes are redacted from tool output and audit payloads', () => {
  const secretText = 'key=sk-abcdefghijklmnopqrstuvwxyz token=ghp_abcdefghijklmnopqrstuvwxyz0123'
  assert.deepEqual(findSecrets(secretText).sort(), ['github-token', 'openai-key'])
  assert.deepEqual(findSecrets('nothing to see here'), [])

  const redacted = redact({
    Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
    stdout: 'OPENAI=sk-abcdefghijklmnopqrstuvwxyz',
    nested: { note: 'AKIAIOSFODNN7EXAMPLE' },
    kept: 'ordinary text',
  })
  assert.equal(redacted.Authorization, '[redacted:key]')
  assert.equal(redacted.stdout.includes('sk-abcdefghijklmnopqrstuvwxyz'), false)
  assert.equal(redacted.nested.note.includes('AKIAIOSFODNN7EXAMPLE'), false)
  assert.equal(redacted.kept, 'ordinary text')
})

test('reads are clipped to the file size limit', async () => {
  await withWorkspace(async (directory) => {
    const broker = new FulkrumToolBroker({ workspaceRoot: directory })
    const { writeFile } = await import('node:fs/promises')
    const path = await import('node:path')
    await writeFile(path.join(directory, 'src', 'large.txt'), 'x'.repeat(500_001), 'utf8')
    await assert.rejects(() => broker.execute('workspace.read', { path: 'src/large.txt' }), /500000-byte read limit/)
  })
})
