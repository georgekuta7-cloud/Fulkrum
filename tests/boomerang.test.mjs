import assert from 'node:assert/strict'
import test from 'node:test'
import { withServer, withWorkspace } from './helpers.mjs'

/**
 * The Boomerang rule, as a test that fails if it ever breaks: a child task
 * returns summary + evidence ids + verdict — never its tool log. The
 * dependent worker's assignment must carry evidence pointers it can resolve,
 * and must not carry the raw bytes those pointers stand for.
 */
test('a handoff carries evidence ids, never the tool output behind them', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-boomerang'
  const marker = `BOOMERANG-${'x'.repeat(40)}`
  const planJson = JSON.stringify({
    objective: 'Prove handoffs stay lean.',
    tasks: [
      { role: 'research', title: 'Read big', instructions: 'Read big.txt.', dependsOn: [] },
      { role: 'builder', title: 'Use the map', instructions: 'Build on it.', dependsOn: [0] },
    ],
  })
  const assignments = []
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
    if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) {
      return { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }
    }
    if (instructions.includes('You are Forge')) {
      assignments.push(messages[0]?.content ?? '')
      return { text: 'Built on the map.', toolCalls: [], usage: null }
    }
    if (!messages.some((message) => message.role === 'tool')) {
      return { text: 'Reading big.', toolCalls: [{ id: 'r1', name: 'workspace.read', arguments: { path: 'big.txt' } }], usage: null }
    }
    const evidence = '```evidence\n' + JSON.stringify({
      summary: 'Read big.txt.',
      findings: [{ claim: 'big.txt holds the marker.', path: 'big.txt', startLine: 1 }],
      artifacts: [],
      tests: [],
      openQuestions: [],
    }) + '\n```'
    return { text: `Read it.\n${evidence}`, toolCalls: [], usage: null }
  }
  try {
    await withWorkspace(async (directory) => {
      const { writeFile } = await import('node:fs/promises')
      const path = (await import('node:path')).default
      await writeFile(path.join(directory, 'big.txt'), `${marker}\n`, 'utf8')
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'boomerang fixture' })
        const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Prove handoffs stay lean.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(store.getRun(runId).status, 'review')
        assert.ok(assignments.length > 0, 'the dependent worker was assigned')

        const handoff = assignments.join('\n')
        assert.match(handoff, /\(#ev-[0-9a-f-]{8,}/, 'the handoff carries resolvable evidence ids')
        assert.equal(handoff.includes(marker), false, 'but never the tool output bytes behind them')
        assert.match(handoff, /big\.txt holds the marker/, 'the claim itself still travels')
      }, { model, workspaceRoot: directory })
    })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})
