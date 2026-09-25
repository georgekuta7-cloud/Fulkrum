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

const contractPlanJson = JSON.stringify({
  objective: 'Prove the approved plan reaches the worker.',
  tasks: [
    { role: 'research', title: 'Look first', instructions: 'Report what is there.', dependsOn: [] },
    { role: 'builder', title: 'Write the contract proof', instructions: 'Write contract.txt exactly once.', acceptanceCheck: 'contract.txt exists with the approved content.', dependsOn: [0] },
  ],
})

test('an approved plan reaches the worker as title, instructions, and acceptance check', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-contract'
  let builderContext = null
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: contractPlanJson, toolCalls: [], usage: null }
    if (instructions.includes('Forge')) {
      builderContext = String(messages?.[0]?.content ?? '')
      return { text: 'Forge finished the contract proof.', toolCalls: [], usage: null }
    }
    return { text: 'Scout summary.', toolCalls: [], usage: null }
  }

  try {
    await withServer(async ({ request, store }) => {
      const runId = await makeRun(request)
      await request('POST', '/api/chat', { runId, message: 'Prove the contract path.', history: [] })
      const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
      const approved = await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
      assert.equal(approved.status, 200, JSON.stringify(approved.payload))

      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && (!builderContext || store.getRun(runId).status === 'executing')) {
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
      assert.ok(builderContext, 'the builder was given its assignment')
      assert.match(builderContext, /Write the contract proof/, 'the approved title reaches the worker')
      assert.match(builderContext, /Write contract\.txt exactly once\./, 'the approved instructions reach the worker')
      assert.match(builderContext, /contract\.txt exists with the approved content\./, 'the acceptance check reaches the worker')
      assert.equal(store.getRun(runId).status, 'review', 'the contracted run still completes')
    }, { model })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})

test('planning → pause → resume returns to planning without starting unapproved work', async () => {
  await withServer(async ({ request, store, orchestrator }) => {
    const runId = await makeRun(request)
    await request('POST', '/api/chat', { runId, message: 'Do the thing.', history: [] })

    const paused = await request('POST', `/api/runs/${runId}/control`, { action: 'pause' })
    assert.equal(paused.status, 200, JSON.stringify(paused.payload))
    const resumed = await request('POST', `/api/runs/${runId}/control`, { action: 'resume' })
    assert.equal(resumed.status, 200, JSON.stringify(resumed.payload))
    assert.equal(store.getRun(runId).status, 'planning', 'resume must not execute a plan nobody approved')
    assert.equal(orchestrator.activeRuns.size, 0)
    assert.equal(store.listEvents(runId).some((event) => event.type === 'run.plan.attached'), false, 'no plan was attached behind the user’s back')
  })
})

test('a fresh draft made during review can be approved on its displayed hash', async () => {
  await withServer(async ({ request, store, providerRegistry, orchestrator }) => {
    providerRegistry.addCustom({ label: 'Review fixture', baseUrl: 'https://example.invalid', model: 'fixture', authStyle: 'none' })
    const project = store.createProject({ name: 'Replan during review', settings: { routing: { head: 'Review fixture', research: 'Review fixture' } } })
    const run = store.createRun({ projectId: project.id })
    store.appendMessage({ projectId: project.id, runId: run.id, role: 'user', content: 'Inspect again.' })
    store.updateRun(run.id, { status: 'review' })
    const drafted = await request('POST', `/api/runs/${run.id}/plan`, { regenerate: true })
    const approved = await request('POST', `/api/runs/${run.id}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash })
    assert.equal(approved.status, 200, JSON.stringify(approved.payload))
    await Promise.allSettled([...orchestrator.activeRuns.values()])
  }, { model: async ({ options }) => ({ text: String(options?.instructions ?? '').includes('You plan work') ? JSON.stringify({ objective: 'Inspect again.', tasks: [{ role: 'research', title: 'Inspect', instructions: 'Report findings.', dependsOn: [] }] }) : 'Finished.', toolCalls: [], usage: null }) })
})

test('redrafting cannot replace a plan while a run is executing or ended', async () => {
  await withServer(async ({ request, store }) => {
    const runId = await makeRun(request)
    for (const status of ['executing', 'paused', 'cancelled', 'completed', 'failed']) {
      store.updateRun(runId, { status })
      const result = await request('POST', `/api/runs/${runId}/plan`, { regenerate: true })
      assert.equal(result.status, 409, status)
      assert.match(result.payload.detail, /cannot be drafted/)
    }
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
  // the test pauses and resumes it. Without a key the run cannot start at all,
  // which is why this fixture needs one.
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

test('cancelling one run leaves a second real worker parked on its own approval', async () => {
  const definition = { objective: 'Ask before continuing.', tasks: [{ role: 'builder', title: 'Ask a question', instructions: 'Ask the user before continuing.', dependsOn: [] }] }
  const model = async ({ messages, options }) => {
    if (String(options?.instructions ?? '').includes('You plan work')) return { text: JSON.stringify(definition), toolCalls: [], usage: null }
    if (messages.some((m) => m.role === 'tool')) return { text: 'Finished.', toolCalls: [], usage: null }
    return { text: 'Waiting.', toolCalls: [{ id: 'question', name: 'run.ask', arguments: { question: 'Continue?' } }], usage: null }
  }
  await withServer(async ({ request, store, providerRegistry, orchestrator }) => {
    providerRegistry.addCustom({ label: 'Scope fixture', baseUrl: 'https://example.invalid', model: 'fixture', authStyle: 'none' })
    const project = store.createProject({ name: 'Two workers', settings: { routing: { head: 'Scope fixture', builder: 'Scope fixture' } } })
    const ids = []
    try {
      for (let index = 0; index < 2; index += 1) {
        const run = store.createRun({ projectId: project.id })
        ids.push(run.id)
        store.appendMessage({ projectId: project.id, runId: run.id, role: 'user', content: 'Ask for a decision.' })
        const drafted = await request('POST', `/api/runs/${run.id}/plan`, {})
        const approved = await request('POST', `/api/runs/${run.id}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash })
        assert.equal(approved.status, 200)
      }
      const deadline = Date.now() + 5000
      while (orchestrator.approvalWaiters.size < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(orchestrator.approvalWaiters.size, 2)
      const otherCall = store.listToolCalls(ids[1]).find((call) => call.status === 'approval_required')
      await request('POST', `/api/runs/${ids[0]}/control`, { action: 'cancel' })
      assert.equal(store.getToolCall(otherCall.id).status, 'approval_required')
      assert.equal(orchestrator.approvalWaiters.has(otherCall.id), true)
      assert.equal(store.getRun(ids[1]).status, 'executing')
    } finally {
      for (const id of ids) await request('POST', `/api/runs/${id}/control`, { action: 'cancel' })
      orchestrator.abandonWaiters('test cleanup')
      await Promise.allSettled([...orchestrator.activeRuns.values()])
    }
  }, { model })
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

test('an approval racing a cancel loses: ended runs execute nothing', async () => {
  await withServer(async ({ request, store }) => {
    const runId = await makeRun(request)
    const requested = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'race.txt', content: 'x' } })
    assert.equal(requested.status, 409)
    const toolCallId = requested.payload.toolCall.id

    // The interleaving a cancel leaves behind: the run died after the call
    // parked but before anyone claimed it, so the claim succeeds and then the
    // pre-execution check must still refuse.
    store.updateRun(runId, { status: 'cancelled' })
    const approved = await request('POST', `/api/runs/${runId}/tools/${toolCallId}/approve`, { fingerprint: requested.payload.toolCall.fingerprint })
    assert.equal(approved.status, 409, JSON.stringify(approved.payload))
    assert.match(String(approved.payload.error ?? approved.payload.detail ?? ''), /run ended/)
    assert.equal(store.getToolCall(toolCallId).status, 'denied', 'the claimed call is denied, not left approved')
    const denial = store.listEvents(runId).find((event) => event.type === 'tool.denied' && event.payload.rule === 'deny.run-ended')
    assert.ok(denial, 'the audit names the reason')
  })
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

test('a control transition and its event save together or not at all', async () => {
  await withServer(async ({ request, store }) => {
    const runId = await makeRun(request)

    const original = store.appendEvent.bind(store)
    let once = true
    store.appendEvent = (...args) => {
      if (once) {
        once = false
        throw new Error('event write failed')
      }
      return original(...args)
    }
    const failed = await request('POST', `/api/runs/${runId}/control`, { action: 'pause' })
    store.appendEvent = original

    assert.equal(failed.status, 500, 'the failed transition surfaces as an error')
    assert.equal(store.getRun(runId).status, 'planning', 'the status change rolled back with the event')
    assert.equal(store.listEvents(runId).some((event) => event.type === 'run.paused'), false, 'no half-written transition is on the chain')

    const paused = await request('POST', `/api/runs/${runId}/control`, { action: 'pause' })
    assert.equal(paused.status, 200)
    assert.equal(store.getRun(runId).status, 'paused')
  })
})

test('permission changes are refused once a run has finished', async () => {
  await withServer(async ({ request, store }) => {
    const runId = await makeRun(request)
    store.updateRun(runId, { status: 'completed' })

    const refused = await request('POST', `/api/runs/${runId}/control`, { action: 'set-permission', permissionMode: 'autopilot' })
    assert.equal(refused.status, 409, 'a finished run no longer takes permission changes')
    assert.equal(store.getRun(runId).permissionMode, 'selective', 'and the mode was not changed')
  })
})
