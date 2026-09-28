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

/** A plan whose one task carries an approved check of the given shape. */
const planWithCheck = (check) => JSON.stringify({
  objective: 'Machine-checked.',
  tasks: [{ role: 'builder', title: 'Write it', instructions: 'Write checked.txt.', check, dependsOn: [] }],
})

const modelWithCheck = (plan) => async ({ messages, options }) => {
  const instructions = String(options?.instructions ?? '')
  if (instructions.includes('You plan work')) return { text: plan, toolCalls: [], usage: null }
  if (instructions.includes('Forge') && !messages.some((message) => message.role === 'tool')) {
    return { text: 'Writing.', toolCalls: [{ id: 'w1', name: 'workspace.write', arguments: { path: 'checked.txt', content: 'checked\n' } }], usage: null }
  }
  return { text: 'Summary.', toolCalls: [], usage: null }
}

test('an approved command check runs, and its receipt is the proof', async () => {
  const seen = []
  const execution = { run: async (argv) => { seen.push(argv); return { stdout: 'ok\n', stderr: '', container: 'stub' } } }
  await withKey(async () => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'command check fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      assert.equal(await runToReview(request, store, runId), 'review', `unexpected status ${store.getRun(runId).status}`)

      assert.ok(seen.some((argv) => argv.join(' ') === 'npm test'), 'the approved check ran in the container')
      const receipt = store.listEvents(runId).find((event) => event.type === 'check.receipt')
      assert.ok(receipt, 'the receipt is on the chain')
      assert.equal(receipt.payload.exitCode, 0)
      assert.equal(receipt.payload.passed, true)
      assert.equal(typeof receipt.payload.outputSha256, 'string')
      const task = store.listTasks(runId)[0]
      assert.equal(task.status, 'completed')
      assert.equal(task.verificationStatus, 'PASS', 'the receipt is the proof — no model judgment needed')
      assert.match(store.getTaskVerdict(task.id).results[0].criterion, /exited 0 \(expected 0\)/)
      const review = store.listEvents(runId).find((event) => event.type === 'run.review.ready')
      assert.equal(review.payload.proof.outcomes.tallies.proven, 1, 'the approved outcome is proven by the receipt')
      assert.equal(review.payload.proof.outcomes.items[0].provenance, 'executed check')
    }, { model: modelWithCheck(planWithCheck({ type: 'command', command: 'npm', args: ['test'], expectExit: 0 })), execution })
  })
})

test('a failing command check fails the task, with the check named', async () => {
  const execution = { run: async () => { throw Object.assign(new Error('The command failed. (exit 1)\nboom'), { code: 1 }) } }
  await withKey(async () => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'failing check fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      assert.equal(await runToReview(request, store, runId), 'failed', `unexpected status ${store.getRun(runId).status}`)

      const receipt = store.listEvents(runId).find((event) => event.type === 'check.receipt')
      assert.equal(receipt.payload.passed, false)
      const task = store.listTasks(runId)[0]
      assert.equal(task.status, 'failed')
      assert.equal(task.verificationStatus, 'FAIL')
      assert.match(String(task.result), /Approved check: `npm test` exited 1 \(expected 0\)/)
    }, { model: modelWithCheck(planWithCheck({ type: 'command', command: 'npm', args: ['test'], expectExit: 0 })), execution })
  })
})

test('a missing engine means the approved check did not run — never a pass', async () => {
  await withKey(async () => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'checkless engine fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      assert.equal(await runToReview(request, store, runId), 'review', `unexpected status ${store.getRun(runId).status}`)

      const notRun = store.listEvents(runId).find((event) => event.type === 'check.not_run')
      assert.ok(notRun, 'the check that could not run is accounted for')
      assert.match(String(notRun.payload.reason), /no execution runtime/)
      assert.equal(store.listEvents(runId).some((event) => event.type === 'check.receipt'), false)
      const task = store.listTasks(runId)[0]
      assert.equal(task.status, 'completed')
      assert.equal(task.verificationStatus, 'UNKNOWN', 'not run is not proven')
    }, { model: modelWithCheck(planWithCheck({ type: 'command', command: 'npm', args: ['test'], expectExit: 0 })) })
  })
})

test('a file assertion is evaluated against the covered workspace', async () => {
  await withKey(async () => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'file check fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      assert.equal(await runToReview(request, store, runId), 'review', `unexpected status ${store.getRun(runId).status}`)

      const assertion = store.listEvents(runId).find((event) => event.type === 'check.assertion')
      assert.ok(assertion, 'the assertion is on the chain')
      assert.equal(assertion.payload.passed, true)
      assert.match(String(assertion.payload.detail), /checked\.txt exists and contains "checked"/)
      const task = store.listTasks(runId)[0]
      assert.equal(task.verificationStatus, 'PASS')
    }, { model: modelWithCheck(planWithCheck({ type: 'file', path: 'checked.txt', contains: 'checked' })) })
  })
})

test('a failing check can be re-run to a passing receipt, and the task recovers', async () => {
  let calls = 0
  const execution = { run: async () => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error('The command failed. (exit 1)\nflaky'), { code: 1 })
    return { stdout: 'ok\n', stderr: '', container: 'stub' }
  } }
  await withKey(async () => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'rerun fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      assert.equal(await runToReview(request, store, runId), 'failed', `unexpected status ${store.getRun(runId).status}`)
      assert.equal(store.listTasks(runId)[0].verificationStatus, 'FAIL')

      const rerun = await request('POST', `/api/runs/${runId}/checks/rerun`, {})
      assert.equal(rerun.status, 200, JSON.stringify(rerun.payload))
      assert.equal(rerun.payload.outcomes[0].status, 'PASS')
      assert.equal(rerun.payload.outcomes[0].detail, 'Approved check: `npm test` exited 0 (expected 0)')

      const task = store.listTasks(runId)[0]
      assert.equal(task.status, 'completed', 'a passing re-run recovers the task')
      assert.equal(task.verificationStatus, 'PASS')
      const receipts = store.listEvents(runId).filter((event) => event.type === 'check.receipt')
      assert.equal(receipts.length, 2, 'the new receipt is appended, never a rewrite')
      assert.equal(receipts[1].payload.rerun, true)
      assert.ok(store.listEvents(runId).find((event) => event.type === 'task.recovered'))
      assert.ok(store.verifyEventChain(runId).ok)
    }, { model: modelWithCheck(planWithCheck({ type: 'command', command: 'npm', args: ['test'], expectExit: 0 })), execution })
  })
})
