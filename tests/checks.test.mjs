import assert from 'node:assert/strict'
import test from 'node:test'
import { withServer } from './helpers.mjs'

const planJson = JSON.stringify({
  objective: 'Prove the checks run.',
  tasks: [
    { role: 'builder', title: 'Write the file', instructions: 'Write checked.txt.', dependsOn: [] },
  ],
})

/** A scripted team: the planner writes one builder task, the builder writes once, everything else summarizes. */
const model = async ({ messages, options }) => {
  const instructions = String(options?.instructions ?? '')
  if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
  if (instructions.includes('Forge') && !messages.some((message) => message.role === 'tool')) {
    return { text: 'Writing the file.', toolCalls: [{ id: 'w1', name: 'workspace.write', arguments: { path: 'checked.txt', content: 'checked\n' } }], usage: null }
  }
  return { text: 'A summary of the work.', toolCalls: [], usage: null }
}

async function runToReview(request, store, runId) {
  await request('POST', '/api/chat', { runId, message: 'Prove the checks run.', history: [] })
  const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
  assert.equal(drafted.status, 200, JSON.stringify(drafted.payload))
  await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline && !['review', 'failed', 'budget_exceeded'].includes(store.getRun(runId).status)) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return store.getRun(runId).status
}

async function withKey(callback) {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-checks'
  try {
    return await callback()
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
}

test('a configured check runs in the container after every write, and the receipt lands on the chain', async () => {
  await withKey(async () => {
    const seen = []
    const execution = { run: async (argv) => { seen.push(argv); return { stdout: 'ok\n', stderr: '', container: 'stub' } } }
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'checks fixture' })
      const projectId = project.payload.project.id
      const patched = await request('PATCH', `/api/projects/${projectId}`, { settings: { checks: { afterWrite: 'npm test' } } })
      assert.equal(patched.status, 200, JSON.stringify(patched.payload))

      const run = await request('POST', '/api/runs', { projectId, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      assert.equal(await runToReview(request, store, runId), 'review', `unexpected status ${store.getRun(runId).status}`)

      // The declared command ran once, as an argv the model never touched.
      assert.deepEqual(seen, [['npm', 'test']])
      const events = store.listEvents(runId)
      const check = events.find((event) => event.type === 'check.run')
      assert.ok(check, 'the check is an event on the chain')
      assert.equal(check.payload.command, 'npm test')
      assert.equal(check.payload.exitCode, 0)
      assert.match(check.payload.outputSha256, /^[0-9a-f]{64}$/)
      assert.ok(check.payload.durationMs >= 0)

      // The receipt is evidence the verifier can cite, and the worker saw it.
      const tasks = store.listTasks(runId)
      const evidence = store.listTaskEvidence(tasks[0].id)
      assert.ok(evidence.some((entry) => entry.kind === 'receipt' && entry.summary.includes('npm test')), 'the receipt is in the evidence ledger')
      const write = store.listToolCalls(runId).find((call) => call.name === 'workspace.write')
      const stored = store.getToolCall(write.id)
      assert.equal(stored.output.checks[0].exitCode, 0, 'the write the worker sees carries the receipt')
      assert.equal(store.verifyEventChain(runId).ok, true)
    }, { model, execution })
  })
})

test('a failing check does not fail the write it follows', async () => {
  await withKey(async () => {
    const execution = { run: async () => { throw new Error('The command failed. (exit 1)\nboom') } }
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'failing checks' })
      const projectId = project.payload.project.id
      await request('PATCH', `/api/projects/${projectId}`, { settings: { checks: { afterWrite: 'npm test' } } })

      const run = await request('POST', '/api/runs', { projectId, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      assert.equal(await runToReview(request, store, runId), 'review', `unexpected status ${store.getRun(runId).status}`)

      const check = store.listEvents(runId).find((event) => event.type === 'check.run')
      assert.equal(check.payload.exitCode, 1)
      assert.match(check.payload.error, /boom/)
      const write = store.listToolCalls(runId).find((call) => call.name === 'workspace.write')
      assert.equal(write.status, 'completed', 'the write stands; the failure is information, not a verdict')
      assert.equal(store.getToolCall(write.id).output.checks[0].exitCode, 1, 'and the worker saw the failure')
    }, { model, execution })
  })
})

test('without a configured check, writes run silent and the chain has no check events', async () => {
  await withKey(async () => {
    let calls = 0
    const execution = { run: async () => { calls += 1; return { stdout: 'ok', stderr: '', container: 'stub' } } }
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'unchecked fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      assert.equal(await runToReview(request, store, runId), 'review', `unexpected status ${store.getRun(runId).status}`)

      assert.equal(calls, 0, 'nothing configured, nothing ran')
      assert.equal(store.listEvents(runId).some((event) => event.type === 'check.run'), false)
      const write = store.listToolCalls(runId).find((call) => call.name === 'workspace.write')
      assert.equal('checks' in (store.getToolCall(write.id).output ?? {}), false)
    }, { model, execution })
  })
})

test('a configured check without an engine is recorded, not hidden', async () => {
  await withKey(async () => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'engineless fixture' })
      const projectId = project.payload.project.id
      await request('PATCH', `/api/projects/${projectId}`, { settings: { checks: { afterWrite: 'npm test' } } })

      const run = await request('POST', '/api/runs', { projectId, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      assert.equal(await runToReview(request, store, runId), 'review', `unexpected status ${store.getRun(runId).status}`)

      const check = store.listEvents(runId).find((event) => event.type === 'check.run')
      assert.ok(check, 'the promised check is accounted for even when it cannot run')
      assert.equal(check.payload.exitCode, null)
      assert.match(check.payload.error, /disabled/i)
      const write = store.listToolCalls(runId).find((call) => call.name === 'workspace.write')
      assert.equal(write.status, 'completed', 'the write still stands')
    }, { model })
  })
})
