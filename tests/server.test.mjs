import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FulkrumStore } from '../server/store.mjs'
import { FulkrumToolBroker } from '../server/toolBroker.mjs'
import { validateOutboundUrl } from '../server/networkPolicy.mjs'
import { createProviderRegistry } from '../server/providerRegistry.mjs'

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'fulkrum-test-'))
  try {
    return await callback(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('project routing settings survive a store reload', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = path.join(directory, 'fulkrum.sqlite')
    const firstStore = new FulkrumStore(databasePath)
    firstStore.createProject({ id: 'project-test', name: 'Test project' })
    firstStore.updateProject('project-test', { settings: { routing: { head: 'OpenAI · gpt-5' } } })
    firstStore.close()

    const secondStore = new FulkrumStore(databasePath)
    const project = secondStore.getProject('project-test')?.project
    assert.equal(project?.settings?.routing?.head, 'OpenAI · gpt-5')
    secondStore.close()
  })
})

test('tool broker keeps reads inside the workspace and blocks traversal', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, 'notes.txt'), 'Fulkrum test content', 'utf8')
    const broker = new FulkrumToolBroker({ workspaceRoot: directory })
    const result = await broker.execute('workspace.read', { path: 'notes.txt' })
    assert.equal(result.content, 'Fulkrum test content')
    await assert.rejects(() => broker.execute('workspace.read', { path: '../outside.txt' }), /inside the Fulkrum workspace/)
  })
})

test('permission modes require approval for consequential tools', () => {
  const broker = new FulkrumToolBroker({ workspaceRoot: process.cwd() })
  const writeTool = broker.get('workspace.write')
  assert.deepEqual(broker.authorize('guided', writeTool), { allowed: false, requiresApproval: true, reason: 'write actions require approval in guided mode.' })
  assert.deepEqual(broker.authorize('selective', writeTool), { allowed: false, requiresApproval: true, reason: 'write actions require approval in selective mode.' })
  assert.deepEqual(broker.authorize('autopilot', writeTool), { allowed: true, requiresApproval: false, reason: 'Autopilot policy.' })
})

test('tool broker clips large reads', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, 'large.txt')
    await writeFile(filePath, 'x'.repeat(500_001), 'utf8')
    const broker = new FulkrumToolBroker({ workspaceRoot: directory })
    await assert.rejects(() => broker.execute('workspace.read', { path: 'large.txt' }), /500000-byte read limit/)
    assert.equal(await readFile(filePath, 'utf8').then((content) => content.length), 500_001)
  })
})

test('tool broker denies secrets and arbitrary interpreter commands', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, '.env.local'), 'SECRET_VALUE=do-not-read', 'utf8')
    const broker = new FulkrumToolBroker({ workspaceRoot: directory })
    await assert.rejects(() => broker.execute('workspace.read', { path: '.env.local' }), /Sensitive files/)
    const search = await broker.execute('workspace.search', { path: '.', query: 'SECRET_VALUE' })
    assert.deepEqual(search.results, [])
    await assert.rejects(() => broker.execute('shell.exec', { cwd: '.', command: 'node.exe', args: ['-e', 'console.log(1)'] }), /Only read-only git commands/)
  })
})

test('outbound network policy blocks local targets', async () => {
  await assert.rejects(() => validateOutboundUrl('http://127.0.0.1:8787/api/health'), /Private and local network targets/)
})

test('provider registry rejects unknown routes', async () => {
  await withTempDirectory(async (directory) => {
    const store = new FulkrumStore(path.join(directory, 'fulkrum.sqlite'))
    const registry = createProviderRegistry(store)
    assert.throws(() => registry.resolve('Totally Unknown · whatever'), /Unknown provider route/)
    store.close()
  })
})
