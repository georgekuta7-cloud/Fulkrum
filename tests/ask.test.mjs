import assert from 'node:assert/strict'
import test from 'node:test'
import { withServer, withWorkspace } from './helpers.mjs'

const planFor = (role) => JSON.stringify({
  objective: 'Prove the question behavior.',
  tasks: [{ role, title: 'Do the thing', instructions: 'Do it, asking if stuck.', dependsOn: [] }],
})

/**
 * A scripted worker: asks first, then reads. A reader reads while the question
 * pends (the parked placeholder is just another result); a writer never gets a
 * second turn until the answer lands, so it reads after. Either way the next
 * unread step is the read.
 */
const askingModel = (planJson) => async ({ messages, options }) => {
  const instructions = String(options?.instructions ?? '')
  if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
  if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) {
    return { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }
  }
  const results = messages.filter((message) => message.role === 'tool').flatMap((message) => message.results ?? [])
  const names = results.map((result) => result.name)
  if (!names.includes('run.ask')) {
    return { text: 'Asking first.', toolCalls: [{ id: 'q1', name: 'run.ask', arguments: { question: 'Which file matters?', context: 'Starting out.' } }], usage: null }
  }
  if (!names.includes('workspace.read')) {
    return { text: 'Reading.', toolCalls: [{ id: 'r1', name: 'workspace.read', arguments: { path: 'package.json' } }], usage: null }
  }
  return { text: 'Done, with the answer in hand.', toolCalls: [], usage: null }
}

async function startRun(request) {
  const project = await request('POST', '/api/projects', { name: 'ask fixture' })
  const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
  const runId = run.payload.run.id
  await request('POST', '/api/chat', { runId, message: 'Prove the question behavior.', history: [] })
  const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
  assert.equal(drafted.status, 200, JSON.stringify(drafted.payload))
  await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
  return runId
}

async function waitFor(store, runId, predicate, what, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = predicate()
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${what}; status=${store.getRun(runId).status}`)
}

async function withKey(callback) {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-ask'
  try {
    return await callback()
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
}

test('a reader that asks keeps reading, and its task is judged only after the answer', async () => {
  await withKey(async () => {
    // The fixture workspace has the file the worker reads; a bare temp
    // directory would fail the read and prove nothing about parking.
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const runId = await startRun(request)

        const question = await waitFor(store, runId,
          () => store.listToolCalls(runId).find((call) => call.name === 'run.ask' && call.status === 'approval_required') ?? null,
          'the parked question')
        assert.equal(question.agentId, 'research')

        // The worker did not park: a read completed while the question sat unanswered.
        const read = await waitFor(store, runId,
          () => store.listToolCalls(runId).find((call) => call.name === 'workspace.read' && call.status === 'completed') ?? null,
          'the meanwhile read')
        assert.ok(read.createdAt >= question.createdAt, 'the read happened after the question parked')

        // The task loop is done but the task is not judged yet: still running.
        const task = store.listTasks(runId)[0]
        assert.equal(task.status, 'running', 'verification waits for the answer')
        assert.equal(store.listEvents(runId).some((event) => event.type === 'task.completed' && event.payload?.taskId === task.id), false)

        const answered = await request('POST', `/api/runs/${runId}/tools/${question.id}/answer`, { answer: 'package.json matters.' })
        assert.equal(answered.status, 200, JSON.stringify(answered.payload))

        await waitFor(store, runId, () => (store.getRun(runId).status === 'review' ? true : null), 'review')
        const turns = store.listTaskTurns(task.id)
        assert.ok(turns.some((turn) => JSON.stringify(turn).includes('package.json matters.')), 'the answer reached the worker as a tool result')
        assert.equal(store.verifyEventChain(runId).ok, true)
      }, { model: askingModel(planFor('research')), workspaceRoot: directory })
    })
  })
})

test('a writer that asks still parks until the human answers', async () => {
  await withKey(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const runId = await startRun(request)

        const question = await waitFor(store, runId,
          () => store.listToolCalls(runId).find((call) => call.name === 'run.ask' && call.status === 'approval_required') ?? null,
          'the parked question')
        assert.equal(question.agentId, 'builder')

        // Nothing else runs while a writer's question is open: no read completes.
        await new Promise((resolve) => setTimeout(resolve, 1500))
        assert.equal(
          store.listToolCalls(runId).filter((call) => call.name === 'workspace.read' && call.status === 'completed').length,
          0,
          'a writer that asks is parked, not reading meanwhile',
        )
        assert.equal(store.getRun(runId).status, 'executing')

        const answered = await request('POST', `/api/runs/${runId}/tools/${question.id}/answer`, { answer: 'Read package.json.' })
        assert.equal(answered.status, 200, JSON.stringify(answered.payload))

        await waitFor(store, runId, () => (store.getRun(runId).status === 'review' ? true : null), 'review')
        assert.ok(store.listToolCalls(runId).some((call) => call.name === 'workspace.read' && call.status === 'completed'), 'the read ran after the answer')
      }, { model: askingModel(planFor('builder')), workspaceRoot: directory })
    })
  })
})
