import assert from 'node:assert/strict'
import test from 'node:test'
import { withServer, withWorkspace } from './helpers.mjs'

const ghostPlan = JSON.stringify({
  objective: 'Prove casting advice.',
  tasks: [{ role: 'builder', title: 'Build the proof', instructions: 'Write real.txt.', acceptanceCheck: 'real.txt exists.', dependsOn: [] }],
})

const ghostWorker = async ({ options }) => {
  const instructions = String(options?.instructions ?? '')
  if (instructions.includes('You plan work')) return { text: ghostPlan, toolCalls: [], usage: null }
  if (instructions.includes('deciding the next step')) {
    return { text: 'Fixable.\n```decision\n{"decision": "repair", "reason": "Write it for real."}\n```', toolCalls: [], usage: null }
  }
  if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) {
    return { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }
  }
  return {
    text: 'Done, trust me.\n```evidence\n{"summary": "Ghost written.", "artifacts": [{"path": "ghost.txt"}]}\n```',
    toolCalls: [],
    usage: null,
  }
}

async function driveRun(request, store) {
  const project = await request('POST', '/api/projects', { name: 'casting fixture' })
  const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
  const runId = run.payload.run.id
  await request('POST', '/api/chat', { runId, message: 'Prove casting advice.', history: [] })
  const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
  await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && ['executing', 'planning'].includes(store.getRun(runId).status)) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { projectId: project.payload.project.id, runId }
}

async function withKeys(callback, openai = false) {
  const previousXai = process.env.XAI_API_KEY
  const previousOpenai = process.env.OPENAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-casting'
  if (openai) process.env.OPENAI_API_KEY = 'sk-test-key-for-casting-openai'
  try {
    return await callback()
  } finally {
    if (previousXai === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousXai
    if (previousOpenai === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenai
  }
}

test('every execution records the casting it ran under', async () => {
  await withKeys(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'routing record' })
        const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Prove casting advice.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: { head: 'openai' } })

        const deadline = Date.now() + 12_000
        while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        const recorded = store.listEvents(runId).find((event) => event.type === 'run.routing')
        assert.ok(recorded, 'the execution recorded its routing')
        assert.deepEqual(recorded.payload.routing, { head: 'openai' })
      }, { model: ghostWorker, workspaceRoot: directory })
    })
  }, true)
})

test('repeated verification failures advise re-casting, with the evidence attached', async () => {
  await withKeys(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const { runId } = await driveRun(request, store)
        assert.equal(store.getRun(runId).status, 'failed', 'two failed attempts exhaust the budget of tries')

        const advice = store.listEvents(runId).filter((event) => event.type === 'run.casting.advised')
        assert.equal(advice.length, 1, 'one advisory, not one per failure')
        assert.equal(advice[0].payload.role, 'builder')
        assert.equal(advice[0].payload.reason, 'repeated-verification-failure')
        assert.equal(advice[0].payload.consecutiveFailures, 2)
        assert.match(advice[0].payload.suggestion, /re-casting|stronger model/)
        assert.equal(store.verifyEventChain(runId).ok, true)
      }, { model: ghostWorker, workspaceRoot: directory })
    })
  })
})

test('an exhausted step budget advises instead of failing silently', async () => {
  const editorPlan = JSON.stringify({
    objective: 'Prove budget advice.',
    tasks: [{ role: 'editor', title: 'Poke around', instructions: 'Read everything.', dependsOn: [] }],
  })
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: editorPlan, toolCalls: [], usage: null }
    if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) {
      return { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }
    }
    const reads = messages.filter((message) => message.role === 'tool').length
    return { text: 'Still reading.', toolCalls: [{ id: `e${reads}`, name: 'workspace.read', arguments: { path: 'package.json' } }], usage: null }
  }
  await withKeys(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const { runId } = await driveRun(request, store)
        assert.equal(store.getRun(runId).status, 'review')

        const advice = store.listEvents(runId).find((event) => event.type === 'run.casting.advised')
        assert.ok(advice, 'the exhausted budget is advice, not silence')
        assert.equal(advice.payload.reason, 'step-budget-exhausted')
        assert.equal(advice.payload.role, 'editor')
        assert.equal(advice.payload.steps, 3)
      }, { model, workspaceRoot: directory })
    })
  })
})

test('a declared escalation re-routes the role after the threshold, on the record', async () => {
  await withKeys(async () => {
    const seenProviders = []
    const recording = async (context) => {
      if (!String(context.options?.instructions ?? '').includes('You plan work')) seenProviders.push(context.provider?.id)
      return ghostWorker(context)
    }
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'escalation fixture' })
        const projectId = project.payload.project.id
        await request('PATCH', `/api/projects/${projectId}`, {
          settings: { escalation: { builder: { to: 'openai', afterFailedVerifications: 1 } } },
        })
        const run = await request('POST', '/api/runs', { projectId, permissionMode: 'autopilot' })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Prove escalation.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

        const deadline = Date.now() + 15_000
        while (Date.now() < deadline && ['executing', 'planning'].includes(store.getRun(runId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }

        const escalated = store.listEvents(runId).find((event) => event.type === 'run.route.escalated')
        assert.ok(escalated, 'the escalation is an event')
        assert.equal(escalated.payload.role, 'builder')
        assert.equal(escalated.payload.to, 'openai')
        assert.equal(escalated.payload.afterFailures, 1)
        assert.ok(seenProviders.includes('openai'), 'work after the escalation runs on the new route')
        assert.ok(seenProviders.includes('grok'), 'work before it ran on the default')
        assert.equal(store.verifyEventChain(runId).ok, true)
      }, { model: recording, workspaceRoot: directory })
    })
  }, true)
})
