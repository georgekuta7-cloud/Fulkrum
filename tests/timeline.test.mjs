import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { withServer, withWorkspace } from './helpers.mjs'

async function write(request, runId, relPath, content) {
  const response = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: relPath, content } })
  assert.equal(response.status, 200, JSON.stringify(response.payload))
  return response
}

function completedSeq(store, runId, toolCallId) {
  const event = store.listEvents(runId).find((item) => item.type === 'tool.completed' && item.payload?.toolCallId === toolCallId)
  assert.ok(event, 'the write completed on the chain')
  return event.sequence
}

async function toolCallIdFor(store, runId, relPath) {
  const call = store.listToolCalls(runId).find((item) => item.name === 'workspace.write' && item.resolved?.relative === relPath)
  assert.ok(call)
  return call.id
}

test('a timeline reconstructs every version, and names what it cannot prove', async () => {
  await withWorkspace(async (directory) => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'timeline fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id

      await write(request, runId, 'notes.txt', 'v1\n')
      const seq1 = completedSeq(store, runId, await toolCallIdFor(store, runId, 'notes.txt'))
      await write(request, runId, 'notes.txt', 'v2\n')
      const seq2 = completedSeq(store, runId, store.listToolCalls(runId).filter((item) => item.name === 'workspace.write').at(-1).id)
      await write(request, runId, 'fresh.txt', 'new\n')

      const at = async (seq) => (await request('GET', `/api/runs/${runId}/timeline/${seq}`)).payload

      const first = await at(seq1)
      assert.equal(first.files.find((file) => file.path === 'notes.txt').content, 'v1\n')
      assert.equal(first.files.find((file) => file.path === 'fresh.txt').content, null, 'not yet created')
      assert.deepEqual(first.gaps, [])

      const second = await at(seq2)
      assert.equal(second.files.find((file) => file.path === 'notes.txt').content, 'v2\n')

      const latest = await at(999_999)
      assert.equal(latest.files.find((file) => file.path === 'notes.txt').content, 'v2\n')
      assert.equal(latest.files.find((file) => file.path === 'fresh.txt').content, 'new\n')

      // A change from outside the run is a named gap, not a confident lie.
      await writeFile(path.join(directory, 'notes.txt'), 'outsider\n', 'utf8')
      const moved = await at(seq2)
      assert.equal(moved.files.find((file) => file.path === 'notes.txt').content, null)
      assert.deepEqual(moved.gaps, ['notes.txt'])

      assert.equal((await request('GET', `/api/runs/${runId}/timeline/nope`)).status, 400)
      assert.equal((await request('GET', '/api/runs/run-nope/timeline/1')).status, 404)
      assert.equal(store.verifyEventChain(runId).ok, true)
    }, { workspaceRoot: directory })
  })
})

test('a restore the policy parks is recorded as failed, never as done', async () => {
  await withWorkspace(async (directory) => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'parked restore' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id

      await write(request, runId, 'README.md', 'changed\n')
      const seq1 = completedSeq(store, runId, store.listToolCalls(runId).filter((item) => item.name === 'workspace.write').at(-1).id)
      // Flip to selective so the restore write parks instead of running.
      assert.equal((await request('POST', `/api/runs/${runId}/control`, { action: 'set-permission', permissionMode: 'selective' })).status, 200)

      // Selective mode parks the restore write: the chain must show the
      // refusal, and must not show a restore that never happened.
      const parked = await request('POST', `/api/runs/${runId}/timeline/${seq1}/restore`, { path: 'README.md' })
      assert.equal(parked.status, 409, JSON.stringify(parked.payload))
      assert.equal(parked.payload.approvalRequired, true)
      const types = store.listEvents(runId).map((event) => event.type)
      assert.ok(types.includes('timeline.restore.failed'), 'the refusal is on the chain')
      assert.equal(types.includes('timeline.restored'), false, 'no restore is recorded that did not run')
      assert.equal(store.verifyEventChain(runId).ok, true)
    }, { workspaceRoot: directory })
  })
})

test('timeline restore writes the old bytes through approval, or refuses honestly', async () => {
  await withWorkspace(async (directory) => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'restore fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id

      await write(request, runId, 'README.md', 'changed\n')
      const seq1 = completedSeq(store, runId, store.listToolCalls(runId).filter((item) => item.name === 'workspace.write').at(-1).id)
      await write(request, runId, 'README.md', 'changed again\n')

      const restored = await request('POST', `/api/runs/${runId}/timeline/${seq1}/restore`, { path: 'README.md' })
      assert.equal(restored.status, 200, JSON.stringify(restored.payload))
      assert.equal(restored.payload.restored, true)
      // Restoring the first write puts back what was there before it: the
      // original fixture bytes, not the first write's own content.
      assert.equal(await readFile(path.join(directory, 'README.md'), 'utf8'), '# Fixture readme\n')
      assert.ok(store.listEvents(runId).some((event) => event.type === 'timeline.restored'), 'the restore is on the chain')
      assert.equal(store.verifyEventChain(runId).ok, true)

      // Created files, unknown paths, and missing bodies all refuse plainly.
      await write(request, runId, 'brand-new.txt', 'new\n')
      const createdSeq = completedSeq(store, runId, store.listToolCalls(runId).filter((item) => item.name === 'workspace.write').at(-1).id)
      assert.equal((await request('POST', `/api/runs/${runId}/timeline/${createdSeq}/restore`, { path: 'brand-new.txt' })).status, 409)
      assert.equal((await request('POST', `/api/runs/${runId}/timeline/${seq1}/restore`, { path: 'nope.txt' })).status, 409)
      assert.equal((await request('POST', `/api/runs/${runId}/timeline/${seq1}/restore`, {})).status, 400)
    }, { workspaceRoot: directory })
  })
})
