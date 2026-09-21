import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveToolCall } from '../server/permissions.mjs'
import { withServer, withWorkspace } from './helpers.mjs'

const planJson = JSON.stringify({
  objective: 'Prove task queries.',
  tasks: [
    { role: 'research', title: 'Map the flow', instructions: 'Report the flow.', dependsOn: [] },
    { role: 'builder', title: 'Use the map', instructions: 'Build on the findings.', dependsOn: [0] },
  ],
})

const evidenceBlock = '```evidence\n' + JSON.stringify({
  summary: 'Mapped the flow.',
  findings: [{ claim: 'The flow completes end to end.', path: 'README.md', startLine: 1 }],
  artifacts: [],
  tests: [],
  openQuestions: [],
}) + '\n```'

const verdictStub = { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }

async function withKey(callback) {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-queries'
  try {
    return await callback()
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
}

test('task.query resolves the question and role, and rejects unknown roles', () => {
  const ok = resolveToolCall({ name: 'task.query', input: { question: 'What did you find?', role: 'research' }, workspaceRoot: process.cwd() })
  assert.equal(ok.ok, true)
  assert.equal(ok.resolved.role, 'research')

  const bad = resolveToolCall({ name: 'task.query', input: { question: 'x', role: 'wizard' }, workspaceRoot: process.cwd() })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /Unknown role/)

  const empty = resolveToolCall({ name: 'task.query', input: { question: '  ', role: 'research' }, workspaceRoot: process.cwd() })
  assert.equal(empty.ok, false)
})

test('a builder asks research and gets an answer from the record, on the chain', async () => {
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
    if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) return verdictStub
    if (instructions.includes('relaying a worker question')) {
      assert.match(messages[0].content, /Recorded findings from research/, 'the answerer sees the ledger, not the transcript')
      assert.match(messages[0].content, /The flow completes end to end/)
      return { text: 'The recorded finding says the flow completes end to end.', toolCalls: [], usage: null }
    }
    if (instructions.includes('You are Scout')) return { text: `Mapped it.\n${evidenceBlock}`, toolCalls: [], usage: null }
    if (instructions.includes('You are Forge')) {
      if (!messages.some((message) => message.role === 'tool')) {
        return { text: 'Asking first.', toolCalls: [{ id: 'q1', name: 'task.query', arguments: { question: 'Does the flow complete?', role: 'research' } }], usage: null }
      }
      return { text: 'Building on the answer.', toolCalls: [], usage: null }
    }
    return { text: 'Summary.', toolCalls: [], usage: null }
  }

  await withKey(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'queries fixture' })
        const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Prove task queries.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

        const deadline = Date.now() + 12_000
        while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(store.getRun(runId).status, 'review')

        const query = store.listToolCalls(runId).find((call) => call.name === 'task.query')
        assert.ok(query, 'the query ran as a recorded call')
        assert.equal(query.status, 'completed')
        assert.equal(query.agentId, 'builder')

        const answered = store.listEvents(runId).find((event) => event.type === 'task.query.answered')
        assert.ok(answered, 'the answer is an event on the chain')
        assert.equal(answered.payload.from, 'builder')
        assert.equal(answered.payload.to, 'research')
        assert.match(answered.payload.answerSha256, /^[0-9a-f]{64}$/)

        const builderTask = store.listTasks(runId).find((task) => task.agentId === 'builder')
        const turns = JSON.stringify(store.listTaskTurns(builderTask.id))
        assert.match(turns, /The recorded finding says the flow completes/, 'the answer reached the worker as a tool result')
        assert.equal(store.verifyEventChain(runId).ok, true)
      }, { model, workspaceRoot: directory })
    })
  })
})

test('asking your own role or an empty record answers honestly without inventing', async () => {
  const selfPlan = JSON.stringify({
    objective: 'Prove honest queries.',
    tasks: [{ role: 'builder', title: 'Ask around', instructions: 'Ask questions.', dependsOn: [] }],
  })
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: selfPlan, toolCalls: [], usage: null }
    if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) return verdictStub
    if (instructions.includes('relaying a worker question')) return { text: 'Should never be asked.', toolCalls: [], usage: null }
    const asked = messages.some((message) => message.role === 'tool')
    if (!asked) {
      return { text: 'Asking myself.', toolCalls: [{ id: 'q1', name: 'task.query', arguments: { question: 'What do I know?', role: 'builder' } }], usage: null }
    }
    return { text: 'Moving on without it.', toolCalls: [], usage: null }
  }

  await withKey(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'self query' })
        const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Prove honest queries.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(store.getRun(runId).status, 'review')

        const query = store.listToolCalls(runId).find((call) => call.name === 'task.query')
        assert.equal(query.status, 'failed', 'a self-query fails instead of looping')
        const turns = JSON.stringify(store.listTaskTurns(store.listTasks(runId)[0].id))
        assert.match(turns, /Ask a different role/, 'the worker is told why')
      }, { model, workspaceRoot: directory })
    })
  })
})
