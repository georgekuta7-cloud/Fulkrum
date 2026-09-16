import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { withServer } from './helpers.mjs'

/**
 * The control surface decides what may run and what may not, so its guarantees get
 * their own tests: the bypass that existed, the race that existed, and the promise
 * that a parked worker is never left holding a promise nobody will resolve.
 */

async function makeRun(request, { permissionMode = 'selective' } = {}) {
  const project = await request('POST', '/api/projects', { name: 'control fixture' })
  const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode })
  return run.payload.run.id
}

/** A run with an approved plan — the state every legitimate resume starts from. */
async function makeApprovedRun(request, message = 'Do the thing.') {
  const runId = await makeRun(request)
  await request('POST', '/api/chat', { runId, message, history: [] })
  const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
  const approved = await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
  assert.equal(approved.status, 200, `approve-plan failed: ${JSON.stringify(approved.payload)}`)
  return runId
}

const planJson = JSON.stringify({
  objective: 'Control fixture.',
  tasks: [
    { role: 'research', title: 'Look', instructions: 'Report what is there.', dependsOn: [] },
    { role: 'builder', title: 'Write it', instructions: 'Write out.txt.', dependsOn: [0] },
  ],
})

test('planning → pause → resume cannot start a run nobody approved', async () => {
  await withServer(async ({ request, store }) => {
    const runId = await makeRun(request)
    await request('POST', '/api/chat', { runId, message: 'Do the thing.', history: [] })

    const paused = await request('POST', `/api/runs/${runId}/control`, { action: 'pause' })
    assert.equal(paused.status, 200, JSON.stringify(paused.payload))
    const resumed = await request('POST', `/api/runs/${runId}/control`, { action: 'resume' })
    // This used to be 200 and would start the run with a plan nobody approved.
    assert.equal(resumed.status, 409, JSON.stringify(resumed.payload))
    assert.match(String(resumed.payload.error), /no approved plan/)
    // Give any wrongly-started run time to have written something; then check it did not.
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.notEqual(store.getRun(runId).status, 'executing', 'the run must not be executing')
    assert.equal(store.listEvents(runId).some((event) => event.type === 'run.plan.attached'), false, 'no plan was attached behind the user’s back')
  })
})

test('transitions are refused from states that cannot make them', async () => {
  await withServer(async ({ request, store }) => {
    const runId = await makeRun(request)
    store.updateRun(runId, { status: 'completed' })
    assert.equal((await request('POST', `/api/runs/${runId}/control`, { action: 'pause' })).status, 409)
    assert.equal((await request('POST', `/api/runs/${runId}/control`, { action: 'cancel' })).status, 409)
    assert.equal((await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan' })).status, 409)

    store.updateRun(runId, { status: 'review' })
    assert.equal((await request('POST', `/api/runs/${runId}/control`, { action: 'resume' })).status, 409, 'a review cannot be resumed')
    store.updateRun(runId, { status: 'cancelled' })
    assert.equal((await request('POST', `/api/runs/${runId}/control`, { action: 'resume' })).status, 409, 'a cancelled run cannot be resumed')
    assert.equal(store.getRun(runId).status, 'cancelled', 'and none of that changed the run')
  })
})

test('interrupted and budget-stopped runs still resume — that is what resume is for', async () => {
  process.env.XAI_API_KEY = 'sk-test-key-for-resume'
  // A run with a key parks on a real write approval, so it is still executing when
  // the test pauses and resumes it. A keyless demo run finishes in milliseconds,
  // which is why this fixture needs the key.
  const model = async ({ options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
    // Forge parks on a write approval and stays parked: that is what keeps the run
    // in `executing` long enough to pause and resume it. The parked call is denied
    // afterwards so nothing outlives the server.
    if (instructions.includes('Forge')) {
      return { text: 'Writing.', toolCalls: [{ id: 'f0', name: 'workspace.write', arguments: { path: 'out.txt', content: 'x' } }], usage: null }
    }
    return { text: 'Scout summary.', toolCalls: [], usage: null }
  }

  try {
    await withServer(async ({ request, store, orchestrator }) => {
      // Both resume paths were executing under an approved plan when they stopped,
      // which is why resume accepts them while planning is refused.
      const runId = await makeApprovedRun(request)
      store.updateRun(runId, { status: 'interrupted', interruptedFrom: 'executing' })
      store.markRunInterrupted(runId, 'bridge stopped')
      assert.equal((await request('POST', `/api/runs/${runId}/control`, { action: 'resume' })).status, 200, 'interrupted resumes')
      assert.equal(store.getRun(runId).interruptedAt, null, 'the interruption is cleared')

      const paused = await makeApprovedRun(request, 'Second direction.')
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && !orchestrator.approvalWaiters.size) {
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
      assert.ok(orchestrator.approvalWaiters.size, 'the second run is parked, so it is executing')

      const pauseResult = await request('POST', `/api/runs/${paused}/control`, { action: 'pause' })
      assert.equal(pauseResult.status, 200, `pause failed: ${JSON.stringify(pauseResult.payload)}`)
      const resumeResult = await request('POST', `/api/runs/${paused}/control`, { action: 'resume' })
      assert.equal(resumeResult.status, 200, `resume failed: ${JSON.stringify(resumeResult.payload)}`)

      for (const [callId] of orchestrator.approvalWaiters) orchestrator.denyToolCall(callId, 'test cleanup')
    }, { model })
  } finally {
    delete process.env.XAI_API_KEY
  }
})

test('a cancelled run ends its parked approval instead of leaving it forever', async () => {
  process.env.XAI_API_KEY = 'sk-test-key-for-cancel'
  const model = async ({ options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
    if (String(options?.instructions ?? '').includes('Forge')) {
      return { text: 'Writing.', toolCalls: [{ id: 'f0', name: 'workspace.write', arguments: { path: 'out.txt', content: 'x' } }], usage: null }
    }
    return { text: 'Scout summary.', toolCalls: [], usage: null }
  }

  try {
    await withServer(async ({ request, store, orchestrator }) => {
      const project = await request('POST', '/api/projects', { name: 'cancel fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
      const runId = run.payload.run.id
      await request('POST', '/api/chat', { runId, message: 'Write the file.', history: [] })
      const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
      const approved = await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
      assert.equal(approved.status, 200, JSON.stringify(approved.payload))

      let pending = null
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        pending = store.listToolCalls(runId).find((call) => call.status === 'approval_required')
        if (pending) break
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
      assert.ok(pending, 'the write parks for approval')
      assert.equal(orchestrator.approvalWaiters.has(pending.id), true, 'a worker is parked on it')

      const cancelled = await request('POST', `/api/runs/${runId}/control`, { action: 'cancel' })
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.payload))
      assert.equal(orchestrator.approvalWaiters.size, 0, 'no worker is left parked')
      assert.equal(store.getToolCall(pending.id).status, 'interrupted', 'the call ends as a fact')
      assert.equal(store.listEvents(runId).some((event) => event.type === 'tool.denied' && event.payload.rule === 'deny.run-ended'), true, 'and the audit says why')
    }, { model })
  } finally {
    delete process.env.XAI_API_KEY
  }
})

test('approving twice executes the call once', async () => {
  await withServer(async ({ request, store, directory }) => {
    const runId = await makeRun(request)
    const requested = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'once.txt', content: 'written once\n' } })
    assert.equal(requested.status, 409)
    const toolCallId = requested.payload.toolCall.id

    const body = { fingerprint: requested.payload.toolCall.fingerprint }
    // Two approvals in flight at once: both pass the status check at the top of the
    // endpoint, and only one may claim the call.
    const [first, second] = await Promise.all([
      request('POST', `/api/runs/${runId}/tools/${toolCallId}/approve`, body),
      request('POST', `/api/runs/${runId}/tools/${toolCallId}/approve`, body),
    ])
    const statuses = [first.status, second.status].sort()
    assert.deepEqual(statuses, [200, 409], `one wins, one is told it was taken (${first.status}, ${second.status})`)

    const content = await import('node:fs/promises').then((fs) => fs.readFile(path.join(directory, 'once.txt'), 'utf8'))
    assert.equal(content, 'written once\n')
    // The events must show one execution, not two.
    assert.equal(store.listEvents(runId).filter((event) => event.type === 'tool.completed' && event.payload.toolCallId === toolCallId).length, 1)

    // And a third approval is refused on its own.
    assert.equal((await request('POST', `/api/runs/${runId}/tools/${toolCallId}/approve`, body)).status, 409)
  })
})

test('denying twice, or denying a call that was approved, resolves once', async () => {
  await withServer(async ({ request }) => {
    const runId = await makeRun(request)
    const requested = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'denied.txt', content: 'x' } })
    const toolCallId = requested.payload.toolCall.id
    const body = { reason: 'no' }

    const [deny, denyAgain] = await Promise.all([
      request('POST', `/api/runs/${runId}/tools/${toolCallId}/deny`, body),
      request('POST', `/api/runs/${runId}/tools/${toolCallId}/deny`, body),
    ])
    assert.deepEqual([deny.status, denyAgain.status].sort(), [200, 409])
    assert.equal((await request('POST', `/api/runs/${runId}/tools/${toolCallId}/approve`, { fingerprint: requested.payload.toolCall.fingerprint })).status, 409, 'a denied call cannot then be approved')
  })
})
