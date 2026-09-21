import assert from 'node:assert/strict'
import test from 'node:test'
import { withServer, withStore } from './helpers.mjs'

async function makeRun(request) {
  const project = await request('POST', '/api/projects', { name: 'scale fixture' })
  const run = await request('POST', '/api/runs', { projectId: project.payload.project.id })
  return { projectId: project.payload.project.id, runId: run.payload.run.id }
}

test('a light snapshot carries live rows, status maps, and counts — never history', async () => {
  await withStore(async (store) => {
    const project = store.createProject({ name: 'scale' })
    const run = store.createRun({ projectId: project.id })
    const live = store.createTask({ runId: run.id, agentId: 'builder', title: 'Live work', instructions: 'do it' })
    const done = store.createTask({ runId: run.id, agentId: 'builder', title: 'Old work', instructions: 'did it' })
    store.updateTask(done.id, { status: 'completed', result: 'done' })
    const call = store.createToolCall({ runId: run.id, agentId: 'builder', name: 'workspace.read', kind: 'read' })
    assert(call?.id, 'expected a tool call row')
    store.appendEvent({ runId: run.id, type: 'task.created', payload: { taskId: live.id } })
    store.appendEvent({ runId: run.id, type: 'task.completed', payload: { taskId: done.id } })

    const light = store.getRunSnapshot(run.id, { light: true })
    assert.equal(light.light, true)
    assert.deepEqual(light.messages, [])
    assert.deepEqual(light.events, [])
    assert.equal(light.tasks.length, 1, 'only the live task rides along')
    assert.equal(light.tasks[0].id, live.id)
    assert.equal(light.taskStatuses.length, 2, 'but every status flips')
    assert.ok(light.taskStatuses.some((entry) => entry.id === done.id && entry.status === 'completed'))
    assert.deepEqual(light.counts, { messages: 0, tasks: 2, toolCalls: 1, events: 2 })

    // The delta cursor: a row created after the cursor rides along whole,
    // while an older completed row stays a status flip.
    const full = store.getRunSnapshot(run.id)
    const lastSeq = full.events.at(-1).sequence
    const late = store.createTask({ runId: run.id, agentId: 'builder', title: 'Late work', instructions: 'do it later' })
    const light2 = store.getRunSnapshot(run.id, { light: true, sinceSequence: lastSeq })
    assert.deepEqual(light2.tasks.map((task) => task.id).sort(), [live.id, late.id].sort())
    assert.ok(light2.taskStatuses.some((entry) => entry.id === done.id && entry.status === 'completed'))
  })
})

test('?light=1 answers the hot path without history, audit, or spend', async () => {
  await withServer(async ({ request }) => {
    const { runId } = await makeRun(request)
    const full = await request('GET', `/api/runs/${runId}`)
    assert.equal(full.status, 200)
    assert.ok(full.payload.audit, 'the full snapshot still verifies the chain')
    const light = await request('GET', `/api/runs/${runId}?light=1`)
    assert.equal(light.status, 200)
    assert.equal(light.payload.light, true)
    assert.deepEqual(light.payload.events, [])
    assert.deepEqual(light.payload.messages, [])
    assert.equal(light.payload.audit, undefined, 'no chain walk on the hot path')
    assert.deepEqual(light.payload.counts, { messages: 0, tasks: 0, toolCalls: 0, events: 0 })
    const missing = await request('GET', '/api/runs/run-nope?light=1')
    assert.equal(missing.status, 404)
  })
})

test('the event stream resumes from ?after= instead of replaying', async () => {
  await withServer(async ({ baseUrl, request, store }) => {
    const { runId } = await makeRun(request)
    store.appendEvent({ runId, type: 'run.note', payload: { text: 'history' } })
    const readStream = async (query) => {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/stream${query}`, { headers: { Accept: 'text/event-stream' } })
      assert.equal(response.status, 200)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let text = ''
      const deadline = Date.now() + 3000
      // Read until the first fulkrum frame or the deadline: an empty resume
      // must deliver nothing, which is itself the assertion.
      while (Date.now() < deadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise((resolve) => setTimeout(() => resolve({ done: true, value: null }), 500)),
        ])
        if (done) break
        if (value) {
          text += decoder.decode(value, { stream: true })
          if (/event: fulkrum/.test(text)) break
        }
      }
      reader.cancel()
      return text
    }
    const replayed = await readStream('?after=0')
    assert.match(replayed, /event: fulkrum/, 'from zero the run replays what it recorded')
    const resumed = await readStream('?after=999999')
    assert.doesNotMatch(resumed, /event: fulkrum/, 'past the head nothing replays')
  })
})
