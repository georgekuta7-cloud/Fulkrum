import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { withServer, withWorkspace } from './helpers.mjs'

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

async function withKey(callback) {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-checkpoints'
  try {
    return await callback()
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
}

test('a modifying write leaves a checkpoint pointing at the superseded bytes, a create does not', async () => {
  await withWorkspace(async (directory) => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'checkpoint fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id

      const created = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'fresh.txt', content: 'v1\n' } })
      assert.equal(created.status, 200, JSON.stringify(created.payload))
      assert.equal(store.listEvents(runId).some((event) => event.type === 'run.snapshot'), false, 'a create has no past to restore')

      const modified = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'fresh.txt', content: 'v2\n' } })
      assert.equal(modified.status, 200, JSON.stringify(modified.payload))
      const checkpoint = store.listEvents(runId).find((event) => event.type === 'run.snapshot')
      assert.ok(checkpoint, 'the modifying write left a checkpoint')
      assert.equal(checkpoint.payload.path, 'fresh.txt')
      assert.equal(checkpoint.payload.previousSha256, sha256('v1\n'), 'the checkpoint commits to the superseded bytes')
      assert.equal(store.verifyEventChain(runId).ok, true)
    }, { workspaceRoot: directory })
  })
})

test('a checkpoint restores through the same policy path as any write', async () => {
  await withWorkspace(async (directory) => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'restore fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id

      await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'README.md', content: 'changed\n' } })
      const write = store.listToolCalls(runId).find((call) => call.name === 'workspace.write')
      assert.equal(await readFile(path.join(directory, 'README.md'), 'utf8'), 'changed\n')

      const reverted = await request('POST', `/api/runs/${runId}/artifacts/${write.id}/revert`, {})
      assert.equal(reverted.status, 200, JSON.stringify(reverted.payload))
      assert.equal(await readFile(path.join(directory, 'README.md'), 'utf8'), '# Fixture readme\n', 'the checkpoint bytes are back on disk')
      assert.equal(store.verifyEventChain(runId).ok, true, 'restore is a new link, not a rewrite')
    }, { workspaceRoot: directory })
  })
})

test('worker writes checkpoint too, on the same event', async () => {
  const planJson = JSON.stringify({
    objective: 'Prove worker checkpoints.',
    tasks: [{ role: 'builder', title: 'Write twice', instructions: 'Write README.md twice.', dependsOn: [] }],
  })
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
    if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) {
      return { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }
    }
    const writes = messages.filter((message) => message.role === 'tool').flatMap((message) => message.results ?? []).filter((result) => result.name === 'workspace.write').length
    if (writes === 0) return { text: 'Writing v1.', toolCalls: [{ id: 'w1', name: 'workspace.write', arguments: { path: 'README.md', content: 'v1\n' } }], usage: null }
    if (writes === 1) return { text: 'Writing v2.', toolCalls: [{ id: 'w2', name: 'workspace.write', arguments: { path: 'README.md', content: 'v2\n' } }], usage: null }
    return { text: 'Wrote twice.', toolCalls: [], usage: null }
  }

  await withKey(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'worker checkpoint' })
        const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Prove worker checkpoints.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

        const deadline = Date.now() + 12_000
        while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(store.getRun(runId).status, 'review', `unexpected status ${store.getRun(runId).status}`)

        const checkpoints = store.listEvents(runId).filter((event) => event.type === 'run.snapshot')
        assert.equal(checkpoints.length, 2, 'both modifying worker writes checkpointed')
        assert.equal(checkpoints[0].payload.previousSha256, sha256('# Fixture readme\n'), 'the first checkpoint points at the original bytes')
        assert.equal(checkpoints[1].payload.previousSha256, sha256('v1\n'), 'the second points at the first write')
        assert.equal(store.verifyEventChain(runId).ok, true)
      }, { model, workspaceRoot: directory })
    })
  })
})
