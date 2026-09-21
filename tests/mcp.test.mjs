import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { createMcpServer } from '../server/mcp.mjs'
import { FulkrumStore } from '../server/store.mjs'
import { FulkrumToolBroker } from '../server/toolBroker.mjs'
import { withTempDirectory } from './helpers.mjs'

async function withMcp(callback) {
  return withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, 'notes.txt'), 'the fixture note\n', 'utf8')
    const store = new FulkrumStore(path.join(directory, 'fulkrum.sqlite'))
    try {
      const toolBroker = new FulkrumToolBroker({ workspaceRoot: directory })
      return await callback(createMcpServer({ toolBroker, store }), { store, directory })
    } finally {
      store.close()
    }
  })
}

const call = (server, method, params, id = 1) => server.handleRequest({ jsonrpc: '2.0', id, method, params })

test('the server identifies itself and lists only the read tools', async () => {
  await withMcp(async (server) => {
    const hello = await call(server, 'initialize', {})
    assert.equal(hello.result.serverInfo.name, 'fulkrum')
    assert.ok(hello.result.capabilities.tools)

    const tools = await call(server, 'tools/list', {})
    const names = tools.result.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['run_report', 'skills_find', 'workspace_list', 'workspace_map', 'workspace_read', 'workspace_search'])
    for (const tool of tools.result.tools) {
      assert.equal(typeof tool.inputSchema.type, 'string', `${tool.name} carries a schema`)
    }
  })
})

test('reads walk the same policy path as the agents', async () => {
  await withMcp(async (server) => {
    const read = await call(server, 'tools/call', { name: 'workspace_read', arguments: { path: 'notes.txt' } })
    assert.match(read.result.content[0].text, /the fixture note/)

    const search = await call(server, 'tools/call', { name: 'workspace_search', arguments: { query: 'fixture' } })
    assert.match(search.result.content[0].text, /notes\.txt/)

    const refused = await call(server, 'tools/call', { name: 'workspace_read', arguments: { path: '.env' } })
    assert.equal(refused.result.isError, true, 'a refusal is a tool error, not an execution')
  })
})

test('writes are absent, unknown tools and methods fail closed', async () => {
  await withMcp(async (server, { store }) => {
    const write = await call(server, 'tools/call', { name: 'workspace_write', arguments: { path: 'x.txt', content: 'x' } })
    assert.equal(write.error.code, -32602, 'there is no write tool to reach for')

    const report = await call(server, 'tools/call', { name: 'run_report', arguments: { runId: 'run-nope' } })
    assert.equal(report.result.isError, true)

    const project = store.createProject({ name: 'mcp report' })
    const run = store.createRun({ projectId: project.id })
    const found = await call(server, 'tools/call', { name: 'run_report', arguments: { runId: run.id } })
    assert.match(found.result.content[0].text, /"status": "planning"/)

    const unknown = await call(server, 'nope', {})
    assert.equal(unknown.error.code, -32601)
    const invalid = await server.handleRequest({ nope: true })
    assert.equal(invalid.error.code, -32600)
  })
})
