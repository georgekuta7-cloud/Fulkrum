import assert from 'node:assert/strict'
import test from 'node:test'
import { withServer, withStore, withWorkspace } from './helpers.mjs'

test('claims record what was asserted and link the evidence behind it', async () => {
  await withStore(async (store) => {
    const project = store.createProject({ name: 'claims unit' })
    const run = store.createRun({ projectId: project.id })
    const task = store.createTask({ runId: run.id, agentId: 'research', title: 'Look', instructions: 'Look.' })

    assert.deepEqual(store.listRunClaims(run.id), [])
    assert.throws(() => store.recordRunClaim({ runId: run.id, taskId: task.id, kind: 'hunch', summary: 'x' }), /Unknown claim kind/)
    assert.throws(() => store.recordRunClaim({ runId: run.id, taskId: task.id, kind: 'finding', summary: '  ' }), /non-empty summary/)

    const evidence = store.appendTaskEvidence({ runId: run.id, taskId: task.id, kind: 'finding', summary: 'The flow completes.' })
    const claim = store.recordRunClaim({ runId: run.id, taskId: task.id, kind: 'finding', summary: 'The flow completes.', path: 'README.md', startLine: 1, evidenceId: evidence.id })
    assert.equal(claim.verdict, null, 'a fresh claim is unverdict — verdicts arrive cited, never by default')
    assert.equal(claim.evidenceId, evidence.id)

    assert.equal(store.listRunClaims(run.id).length, 1)
    assert.equal(store.listTaskClaims(task.id).length, 1)
    assert.equal(store.listTaskClaims('task-nope').length, 0)
  })
})

test('a worker evidence block becomes claims, questions excepted, served over HTTP', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-claims'
  const planJson = JSON.stringify({
    objective: 'Prove claims.',
    tasks: [{ role: 'research', title: 'Map the flow', instructions: 'Report the flow.', dependsOn: [] }],
  })
  const evidenceBlock = '```evidence\n' + JSON.stringify({
    summary: 'Mapped the flow.',
    findings: [{ claim: 'The flow completes end to end.', path: 'README.md', startLine: 1 }],
    artifacts: [],
    tests: [{ command: 'npm test', exitCode: 0 }],
    openQuestions: ['Is the cache needed?'],
  }) + '\n```'
  const model = async ({ options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
    if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) {
      return { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }
    }
    return { text: `Mapped it.\n${evidenceBlock}`, toolCalls: [], usage: null }
  }
  try {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'claims fixture' })
        const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Prove claims.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(store.getRun(runId).status, 'review')

        const claims = store.listRunClaims(runId)
        assert.equal(claims.length, 2, 'the finding and the test receipt are claims; the open question is not')
        assert.deepEqual(claims.map((claim) => claim.kind).sort(), ['finding', 'test'])
        const finding = claims.find((claim) => claim.kind === 'finding')
        assert.equal(finding.path, 'README.md')
        assert.equal(finding.startLine, 1)
        assert.ok(finding.evidenceId, 'the claim links its evidence row')
        assert.ok(claims.every((claim) => claim.verdict === null))
        assert.ok(store.listEvents(runId).some((event) => event.type === 'claims.recorded'), 'the recording is on the chain')

        const fetched = await request('GET', `/api/runs/${runId}/claims`)
        assert.equal(fetched.status, 200)
        assert.equal(fetched.payload.claims.length, 2)
        assert.equal((await request('GET', '/api/runs/run-nope/claims')).status, 404)
        assert.equal(store.verifyEventChain(runId).ok, true)
      }, { model, workspaceRoot: directory })
    })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})
