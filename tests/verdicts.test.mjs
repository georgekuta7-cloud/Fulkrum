import assert from 'node:assert/strict'
import test from 'node:test'
import { withServer, withWorkspace } from './helpers.mjs'

const planJson = JSON.stringify({
  objective: 'Prove verdicts cite.',
  tasks: [{ role: 'research', title: 'Map the flow', instructions: 'Report the flow.', acceptanceCheck: 'The flow is mapped.', dependsOn: [] }],
})

const evidenceBlock = '```evidence\n' + JSON.stringify({
  summary: 'Mapped the flow.',
  findings: [{ claim: 'The flow completes end to end.', path: 'README.md', startLine: 1 }],
  artifacts: [],
  tests: [],
  openQuestions: [],
}) + '\n```'

const verdictFor = (status, evidence) => '```verdict\n' + JSON.stringify({ results: [{ criterion: 'done', status, evidence }] }) + '\n```'

/**
 * A verifier that cites what the digest shows it: it reads (#ev-...) ids out
 * of the verification prompt and cites them — or cites nothing, on demand.
 */
const modelWithVerifier = (cite) => async ({ messages, options }) => {
  const instructions = String(options?.instructions ?? '')
  if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
  if (instructions.includes('verifying a worker task')) {
    const prompt = messages.map((message) => message.content ?? '').join('\n')
    const ids = cite ? [...prompt.matchAll(/\(#(ev-[0-9a-f-]{1,36})\)/g)].map((match) => match[1]) : []
    return { text: verdictFor('PASS', ids), toolCalls: [], usage: null }
  }
  if (instructions.includes('reviewing worker outputs')) {
    return { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }
  }
  return { text: `Mapped it.\n${evidenceBlock}`, toolCalls: [], usage: null }
}

async function runToReview(request, store, permissionMode = 'selective') {
  const project = await request('POST', '/api/projects', { name: 'verdicts fixture' })
  const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode })
  const runId = run.payload.run.id
  await request('POST', '/api/chat', { runId, message: 'Prove verdicts cite.', history: [] })
  const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
  await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return runId
}

async function withKey(callback) {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-verdicts'
  try {
    return await callback()
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
}

test('a PASS that cites recorded evidence judges the claims it cites', async () => {
  await withKey(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const runId = await runToReview(request, store)
        assert.equal(store.getRun(runId).status, 'review')

        const task = store.listTasks(runId)[0]
        const verdict = store.getTaskVerdict(task.id)
        assert.equal(verdict.overall, 'PASS')
        assert.ok(verdict.results[0].evidence.length > 0, 'the citation survived into the record')

        const claims = store.listRunClaims(runId)
        assert.equal(claims.length, 1)
        assert.equal(claims[0].verdict, 'PASS', 'the cited claim takes the verdict')

        // Proof-carried approval, closed: the acceptance check approved with
        // the plan is the predicted outcome, and the review reports what the
        // verdicts and claims say about it.
        const review = store.listEvents(runId).find((event) => event.type === 'run.review.ready')
        assert.deepEqual(review.payload.proof.predicted, ['The flow is mapped.'])
        assert.equal(review.payload.proof.verdicts.pass >= 1, true)
        assert.equal(review.payload.proof.claims.total, 1)
        assert.equal(review.payload.proof.claims.proven, 1)
        assert.equal(store.verifyEventChain(runId).ok, true)
      }, { model: modelWithVerifier(true), workspaceRoot: directory })
    })
  })
})

test('a PASS that cites nothing recorded degrades to UNKNOWN instead of passing', async () => {
  await withKey(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const runId = await runToReview(request, store)
        assert.equal(store.getRun(runId).status, 'review', 'an UNKNOWN verdict still completes the task')

        const task = store.listTasks(runId)[0]
        const verdict = store.getTaskVerdict(task.id)
        assert.equal(verdict.overall, 'UNKNOWN')
        assert.match(verdict.results[0].criterion, /no cited evidence/, 'the degradation names its reason')

        const claims = store.listRunClaims(runId)
        assert.equal(claims.length, 1)
        assert.equal(claims[0].verdict, null, 'an uncited verdict judges nothing')
      }, { model: modelWithVerifier(false), workspaceRoot: directory })
    })
  })
})

test('verification runs on the reviewer route when one is cast, else the task route', async () => {
  const previousXai = process.env.XAI_API_KEY
  const previousOpenai = process.env.OPENAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-reviewer'
  process.env.OPENAI_API_KEY = 'sk-test-key-for-reviewer-openai'
  try {
    for (const [name, routing, expected] of [
      ['cast reviewer', { reviewer: 'openai' }, 'openai'],
      ['unrouted reviewer', {}, 'grok'],
    ]) {
      await withWorkspace(async (directory) => {
        await withServer(async ({ request, store }) => {
          const project = await request('POST', '/api/projects', { name: `reviewer ${name}` })
          const projectId = project.payload.project.id
          await request('PATCH', `/api/projects/${projectId}`, { settings: { routing } })
          const run = await request('POST', '/api/runs', { projectId, permissionMode: 'selective' })
          const runId = run.payload.run.id
          await request('POST', '/api/chat', { runId, message: 'Prove verdicts cite.', history: [] })
          const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
          await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

          const deadline = Date.now() + 10_000
          while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          assert.equal(store.getRun(runId).status, 'review')

          const task = store.listTasks(runId)[0]
          const verdict = store.getTaskVerdict(task.id)
          assert.match(String(verdict.checkedBy), new RegExp(`head via ${expected}/`), `${name}: the reviewer route decides who judges`)
        }, { model: modelWithVerifier(true), workspaceRoot: directory })
      })
    }
  } finally {
    if (previousXai === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousXai
    if (previousOpenai === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenai
  }
})

test('a shell command leaves a receipt the verifier can cite', async () => {
  const shellPlan = JSON.stringify({
    objective: 'Prove shell receipts.',
    tasks: [{ role: 'builder', title: 'Run the check', instructions: 'Run echo.', dependsOn: [] }],
  })
  const shellModel = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: shellPlan, toolCalls: [], usage: null }
    if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) {
      return { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }
    }
    if (!messages.some((message) => message.role === 'tool')) {
      return { text: 'Running it.', toolCalls: [{ id: 's1', name: 'shell.exec', arguments: { command: 'echo', args: ['hi'] } }], usage: null }
    }
    return { text: 'Ran it.', toolCalls: [], usage: null }
  }
  await withKey(async () => {
    const execution = { run: async () => ({ stdout: 'hi\n', stderr: '', container: 'stub' }) }
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const runId = await runToReview(request, store, 'autopilot')
        assert.equal(store.getRun(runId).status, 'review')

        const task = store.listTasks(runId)[0]
        const receipts = store.listTaskEvidence(task.id).filter((entry) => entry.kind === 'receipt')
        assert.equal(receipts.length, 1)
        assert.match(receipts[0].summary, /echo hi/)
        assert.match(receipts[0].summary, /exited 0/)
        assert.match(receipts[0].sha256, /^[0-9a-f]{64}$/)
        const shell = store.listToolCalls(runId).find((call) => call.name === 'shell.exec')
        assert.equal(receipts[0].toolCallId, shell.id, 'the receipt points at the call it records')
      }, { model: shellModel, execution, workspaceRoot: directory })
    })
  })
})
