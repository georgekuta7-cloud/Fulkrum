import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { findSecrets, redact } from '../server/redaction.mjs'
import { FulkrumToolBroker } from '../server/toolBroker.mjs'
import { withWorkspace } from './helpers.mjs'

test('search does not follow a link out of the workspace, and honours .fulkrumignore', async (t) => {
  const outside = await mkdtemp(path.join(tmpdir(), 'fulkrum-outside-'))
  const inside = await mkdtemp(path.join(tmpdir(), 'fulkrum-inside-'))
  try {
    await writeFile(path.join(outside, 'reachable.txt'), 'NEEDLE outside the workspace\n', 'utf8')
    try {
      // A junction works on Windows without elevation and is the common real-world
      // case; elsewhere a plain directory symlink. readdir reports a junction as an
      // ordinary directory, which is how the walk used to leave the workspace.
      await symlink(outside, path.join(inside, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`cannot create a directory link here (${error.code})`)
      return
    }

    await writeFile(path.join(inside, 'found.txt'), 'NEEDLE inside the workspace\n', 'utf8')
    await writeFile(path.join(inside, 'ignored.txt'), 'NEEDLE in an ignored file\n', 'utf8')
    await writeFile(path.join(inside, '.fulkrumignore'), 'ignored.txt\n', 'utf8')

    const broker = new FulkrumToolBroker({ workspaceRoot: inside })
    const search = await broker.execute('workspace.search', { path: '.', query: 'NEEDLE' })
    assert.deepEqual(search.results.map((result) => result.path), ['found.txt'], 'the link is skipped and the ignore file is honoured')
  } finally {
    await rm(inside, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

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

test('shell execution goes through the container boundary, never the host', async () => {
  await withWorkspace(async (directory) => {
    // No runtime configured: the broker must refuse rather than run anything.
    const hostless = new FulkrumToolBroker({ workspaceRoot: directory })
    await assert.rejects(() => hostless.execute('shell.exec', { command: 'node', args: ['-e', 'console.log(1)'], cwd: '.' }), /Execution is disabled/)

    // With a runtime, the command becomes container argv and the host is untouched.
    const calls = []
    const execution = {
      image: 'fulkrum-runner:local',
      run: async (argv, options) => {
        calls.push({ argv, options })
        return { stdout: 'container output\n', stderr: '' }
      },
    }
    const broker = new FulkrumToolBroker({ workspaceRoot: directory, execution })
    const result = await broker.execute('shell.exec', { command: 'node', args: ['-e', 'console.log(1)'], cwd: '.' })
    assert.equal(result.boundary, 'container')
    assert.deepEqual(calls[0].argv, ['node', '-e', 'console.log(1)'])
    assert.equal(result.stdout, 'container output\n')
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
