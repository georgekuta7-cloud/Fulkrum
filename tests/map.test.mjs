import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { decidePermission } from '../server/permissions.mjs'
import { agentRoles } from '../server/roles.mjs'
import { FulkrumToolBroker } from '../server/toolBroker.mjs'
import { isToolAllowedForRole, validateToolArguments } from '../server/tools.mjs'
import { withTempDirectory, withWorkspace } from './helpers.mjs'

test('a map needs no arguments, and rejects unknown ones', () => {
  assert.equal(validateToolArguments('workspace.map', {}).ok, true)
  assert.equal(validateToolArguments('workspace.map', { path: 'src' }).ok, true)
  assert.equal(validateToolArguments('workspace.map', { path: 4 }).ok, false)
  assert.equal(validateToolArguments('workspace.map', { nope: 1 }).ok, false)
})

test('both worker roles can see the map', () => {
  assert.equal(isToolAllowedForRole(agentRoles.research, 'workspace.map'), true)
  assert.equal(isToolAllowedForRole(agentRoles.builder, 'workspace.map'), true)
  assert.equal(decidePermission({ mode: 'selective', tool: { kind: 'read' }, resolution: { ok: true } }).allowed, true, 'a read is allowed, so no matrix row was needed')
})

test('a map outlines code and counts everything else', async () => {
  await withWorkspace(async (directory) => {
    await writeFile(path.join(directory, 'app.mjs'), 'export function start() {}\nexport const version = 2\n', 'utf8')
    await writeFile(path.join(directory, 'tool.py'), 'def run():\n    pass\n\nclass Worker:\n    pass\n', 'utf8')
    const broker = new FulkrumToolBroker({ workspaceRoot: directory })

    const mapped = await broker.execute('workspace.map', { path: '.' })
    const byPath = new Map(mapped.files.map((file) => [file.path, file]))

    const app = byPath.get('app.mjs')
    assert.ok(app, 'the new file is mapped')
    assert.deepEqual(app.symbols.map((symbol) => symbol.name).sort(), ['start', 'version'])
    assert.equal(app.symbols.find((symbol) => symbol.name === 'start').kind, 'function')

    const tool = byPath.get('tool.py')
    assert.deepEqual(tool.symbols.map((symbol) => symbol.name).sort(), ['Worker', 'run'])

    const readme = byPath.get('README.md')
    assert.equal(readme.lines, 1, 'prose gets a line count, not symbols')
    assert.deepEqual(readme.symbols, [])

    assert.equal(byPath.has('.env.local'), false, 'credential files are not mapped')
    assert.equal(mapped.clipped, false)
  })
})

test('a map honours ignore rules and never leaves the workspace', async (t) => {
  const outside = await mkdtemp(path.join(tmpdir(), 'fulkrum-map-outside-'))
  const inside = await mkdtemp(path.join(tmpdir(), 'fulkrum-map-inside-'))
  try {
    await writeFile(path.join(outside, 'secret.mjs'), 'export const key = 1\n', 'utf8')
    await writeFile(path.join(inside, 'kept.mjs'), 'export const kept = 1\n', 'utf8')
    await writeFile(path.join(inside, 'skipped.mjs'), 'export const skipped = 1\n', 'utf8')
    await writeFile(path.join(inside, '.fulkrumignore'), 'skipped.mjs\n', 'utf8')
    try {
      await symlink(outside, path.join(inside, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`cannot create a directory link here (${error.code})`)
      return
    }

    const broker = new FulkrumToolBroker({ workspaceRoot: inside })
    const mapped = await broker.execute('workspace.map', { path: '.' })
    const paths = mapped.files.map((file) => file.path)
    assert.ok(paths.includes('kept.mjs'))
    assert.equal(paths.includes('skipped.mjs'), false, 'the ignore file is honoured')
    assert.equal(paths.some((entry) => entry.includes('secret.mjs') || entry.startsWith('linked')), false, 'the link is not descended into')
  } finally {
    await rm(inside, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('a map reports huge files instead of outlining them, and fails unknown paths in resolution', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, 'big.mjs'), `${'export const x = 1\n'.repeat(40_000)}`, 'utf8')
    const broker = new FulkrumToolBroker({ workspaceRoot: directory })
    const mapped = await broker.execute('workspace.map', { path: '.' })
    const big = mapped.files.find((file) => file.path === 'big.mjs')
    assert.equal(big.outline, 'too large to outline')
    assert.ok(big.bytes > 500_000)

    await assert.rejects(() => broker.execute('workspace.map', { path: 'nope' }), 'an unknown path fails through resolution, not the walk')
  })
})
