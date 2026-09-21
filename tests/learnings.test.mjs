import assert from 'node:assert/strict'
import test from 'node:test'
import { withServer, withStore, withWorkspace } from './helpers.mjs'

const planJson = JSON.stringify({
  objective: 'Prove learnings.',
  tasks: [{ role: 'research', title: 'Map the flow', instructions: 'Report the flow.', dependsOn: [] }],
})

const evidenceBlock = '```evidence\n' + JSON.stringify({
  summary: 'Mapped the flow.',
  findings: [{ claim: 'The flow completes end to end.', path: 'README.md', startLine: 1 }],
  artifacts: [],
  tests: [],
  openQuestions: [],
}) + '\n```'

async function withKey(callback) {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-learnings'
  try {
    return await callback()
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
}

function modelWithLearnings({ learnings = ['Tests need --runInBand here.'], plannerPrompt = null } = {}) {
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) {
      if (plannerPrompt) plannerPrompt.text = messages.map((message) => message.content ?? '').join('\n')
      return { text: planJson, toolCalls: [], usage: null }
    }
    if (instructions.includes('recording durable learnings')) return { text: JSON.stringify(learnings), toolCalls: [], usage: null }
    if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) {
      return { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }
    }
    return { text: `Mapped it.\n${evidenceBlock}`, toolCalls: [], usage: null }
  }
  return model
}

async function runToReview(request, store) {
  const project = await request('POST', '/api/projects', { name: 'learnings fixture' })
  const projectId = project.payload.project.id
  const run = await request('POST', '/api/runs', { projectId, permissionMode: 'selective' })
  const runId = run.payload.run.id
  await request('POST', '/api/chat', { runId, message: 'Prove learnings.', history: [] })
  const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
  await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { projectId, runId }
}

async function waitForLearnings(store, projectId, count, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = store.listProjectLearnings(projectId)
    if (rows.length >= count) return rows
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return store.listProjectLearnings(projectId)
}

test('a reviewed run with evidence teaches learnings, on the chain', async () => {
  await withKey(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const { projectId, runId } = await runToReview(request, store)
        assert.equal(store.getRun(runId).status, 'review')

        const rows = await waitForLearnings(store, projectId, 1)
        assert.equal(rows.length, 1)
        assert.equal(rows[0].fact, 'Tests need --runInBand here.')
        assert.equal(rows[0].sourceRunId, runId, 'every fact links the work that taught it')
        const events = store.listEvents(runId).filter((event) => event.type === 'learning.recorded')
        assert.equal(events.length, 1)
        assert.equal(events[0].payload.learningId, rows[0].id)
        assert.equal(store.verifyEventChain(runId).ok, true)
      }, { model: modelWithLearnings(), workspaceRoot: directory })
    })
  })
})

test('an unusable learning reply teaches nothing and breaks nothing', async () => {
  const proseModel = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('recording durable learnings')) return { text: 'just some prose, no list', toolCalls: [], usage: null }
    return modelWithLearnings()({ messages, options })
  }
  await withKey(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const { projectId, runId } = await runToReview(request, store)
        assert.equal(store.getRun(runId).status, 'review')
        await new Promise((resolve) => setTimeout(resolve, 1500))
        assert.deepEqual(store.listProjectLearnings(projectId), [], 'prose is not a fact')
        assert.equal(store.listEvents(runId).some((event) => event.type === 'learning.recorded'), false)
      }, { model: proseModel, workspaceRoot: directory })
    })
  })
})

test('learnings list, delete, and stay inside their project', async () => {
  await withStore(async (store) => {
    const project = store.createProject({ name: 'learn unit' })
    const other = store.createProject({ name: 'other unit' })
    assert.deepEqual(store.listProjectLearnings(project.id), [])
    assert.throws(() => store.recordLearning({ projectId: project.id, fact: '  ' }), /non-empty fact/)
    assert.throws(() => store.recordLearning({ projectId: 'project-nope', fact: 'x' }), /Project not found/)
    const first = store.recordLearning({ projectId: project.id, fact: 'First fact.', sourceRunId: null })
    const second = store.recordLearning({ projectId: project.id, fact: 'Second fact.', sourceRunId: null })
    assert.deepEqual(store.listProjectLearnings(project.id).map((row) => row.id), [second.id, first.id], 'newest first')
    assert.equal(store.deleteLearning(first.id), true)
    assert.equal(store.deleteLearning(first.id), false, 'deleting twice reports the absence')
    assert.deepEqual(store.listProjectLearnings(project.id).map((row) => row.id), [second.id])
    assert.deepEqual(store.listProjectLearnings(other.id), [])
  })

  await withKey(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'learned http' })
        const projectId = project.payload.project.id
        const other = await request('POST', '/api/projects', { name: 'other http' })
        const otherId = other.payload.project.id

        const listed = await request('GET', `/api/projects/${projectId}/learnings`)
        assert.equal(listed.status, 200)
        assert.deepEqual(listed.payload.learnings, [])
        assert.equal((await request('GET', '/api/projects/project-nope/learnings')).status, 404)

        const { projectId: learnedId } = await runToReview(request, store)
        const rows = await waitForLearnings(store, learnedId, 1)
        const victim = rows[0]

        // Deleting from the wrong project is a 404, not a cross-project delete.
        assert.equal(victim.projectId, learnedId)
        assert.equal((await request('DELETE', `/api/projects/${otherId}/learnings/${victim.id}`)).status, 404)
        const removed = await request('DELETE', `/api/projects/${victim.projectId}/learnings/${victim.id}`)
        assert.equal(removed.status, 200)
        assert.equal(removed.payload.removed, victim.id)
        assert.deepEqual(removed.payload.learnings, [])
        assert.equal((await request('DELETE', `/api/projects/${victim.projectId}/learnings/${victim.id}`)).status, 404)
      }, { model: modelWithLearnings(), workspaceRoot: directory })
    })
  })
})

test('the next plan reads what the last run learned', async () => {
  await withKey(async () => {
    const plannerPrompt = { text: '' }
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const first = await runToReview(request, store)
        await waitForLearnings(store, first.projectId, 1)

        const second = await request('POST', '/api/runs', { projectId: first.projectId, permissionMode: 'selective' })
        const runId = second.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Prove learnings again.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        assert.equal(drafted.status, 200, JSON.stringify(drafted.payload))
        assert.match(plannerPrompt.text, /Tests need --runInBand here\./, 'the fact reaches the planner')
        const event = store.listEvents(runId).find((event) => event.type === 'plan.drafted')
        assert.ok(event.payload.contextSources.some((source) => source.includes('learnings')), 'and the draft records reading it')
      }, { model: modelWithLearnings({ plannerPrompt }), workspaceRoot: directory })
    })
  })
})
