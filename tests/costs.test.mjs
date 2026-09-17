import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { createPricing, PRICING_VERSION } from '../server/pricing.mjs'
import { normalizeUsage } from '../server/modelCall.mjs'
import { withServer, withTempDirectory } from './helpers.mjs'

const usage = (overrides = {}) => ({ inputTokens: 0, billableInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, ...overrides })

const planJson = JSON.stringify({
  objective: 'Prove the cost path.',
  tasks: [
    { role: 'research', title: 'Look around', instructions: 'Report what is there.', dependsOn: [] },
    { role: 'builder', title: 'Write the proof', instructions: 'Write proof.txt.', dependsOn: [0] },
  ],
})

/** Two readers in one layer, so they run concurrently. */
const twoReaderPlan = JSON.stringify({
  objective: 'Research two things at once.',
  tasks: [
    { role: 'research', title: 'First', instructions: 'Report what is there.', dependsOn: [] },
    { role: 'research', title: 'Second', instructions: 'Report what is there.', dependsOn: [] },
  ],
})

/** A scripted model: planning gets JSON, everything else gets a summary. */
const modelStub = (callUsage) => async ({ options }) => {
  const instructions = String(options?.instructions ?? '')
  if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: callUsage }
  return { text: 'A summary of the work.', toolCalls: [], usage: callUsage }
}

test('costs are computed from the published table, per token class', () => {
  const pricing = createPricing({ table: { 'test-model': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } })

  const plain = pricing.costOf({ model: 'test-model', usage: usage({ inputTokens: 1_000_000, billableInputTokens: 1_000_000, outputTokens: 1_000_000 }) })
  assert.equal(plain.priced, true)
  assert.equal(plain.costUsd, 18)

  const cached = pricing.costOf({ model: 'test-model', usage: usage({ inputTokens: 1_000_000, billableInputTokens: 200_000, cacheReadTokens: 800_000 }) })
  // 200k at 3 + 800k at 0.3 = 0.6 + 0.24
  assert.equal(cached.costUsd, 0.84)

  const written = pricing.costOf({ model: 'test-model', usage: usage({ billableInputTokens: 100_000, cacheWriteTokens: 100_000 }) })
  assert.equal(written.costUsd, 0.675)
})

test('an unknown model is unpriced, never silently free', () => {
  const pricing = createPricing({ table: { 'known': { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 } } })
  const result = pricing.costOf({ model: 'mystery-model-9', usage: usage({ billableInputTokens: 5_000_000 }) })
  assert.equal(result.priced, false)
  assert.equal(result.costUsd, null, 'an unpriced call must not report a number')

  const noUsage = pricing.costOf({ model: 'known', usage: null })
  assert.equal(noUsage.priced, false)
})

test('dated model variants match the closest known price', () => {
  const pricing = createPricing({ table: { 'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } })
  assert.equal(pricing.priceFor('claude-sonnet-4-20260101')?.input, 3)
  assert.equal(pricing.priceFor('claude-opus-4-1'), null)
})

test('a price override file wins over the built-in table', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, 'prices.json')
    await writeFile(filePath, JSON.stringify({ 'grok-4': { input: 100, output: 200, cacheRead: 10, cacheWrite: 125 } }), 'utf8')
    const pricing = createPricing({ filePath })
    assert.equal(pricing.version.startsWith(PRICING_VERSION), true)
    assert.match(pricing.version, /overrides/)
    assert.equal(pricing.priceFor('grok-4').input, 100)
    assert.equal(pricing.costOf({ model: 'grok-4', usage: usage({ billableInputTokens: 1_000_000 }) }).costUsd, 100)
  })
})

test('cached tokens are not billed twice', () => {
  // OpenAI and Google include cached tokens in the prompt total; Anthropic does not.
  const openai = normalizeUsage('openai-compatible', { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 900 } })
  assert.equal(openai.inputTokens, 1000)
  assert.equal(openai.billableInputTokens, 100, 'only the uncached part is billed at the input rate')
  assert.equal(openai.cacheReadTokens, 900)

  const anthropic = normalizeUsage('anthropic', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 })
  assert.equal(anthropic.billableInputTokens, 100, 'Anthropic already excludes cached tokens from input_tokens')
  assert.equal(anthropic.cacheReadTokens, 900)
  assert.equal(anthropic.cacheWriteTokens, 50)

  const google = normalizeUsage('google', { promptTokenCount: 1000, candidatesTokenCount: 10, cachedContentTokenCount: 400, thoughtsTokenCount: 7 })
  assert.equal(google.billableInputTokens, 600)
  assert.equal(google.reasoningTokens, 7)
})

test('a priced run records every call, and the trace endpoint reports the totals', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-costs'
  const pricing = createPricing({ table: { 'grok-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } })
  const model = modelStub({ inputTokens: 1000, billableInputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })

  try {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'cost fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
      const runId = run.payload.run.id
      await request('POST', '/api/chat', { runId, message: 'Do the thing.', history: [] })

      const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
      assert.equal(drafted.payload.plan.source, 'model', 'planning should use the model here')

      await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && store.getRun(runId).status === 'executing') await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(store.getRun(runId).status, 'review')

      const trace = await request('GET', `/api/runs/${runId}/trace`)
      assert.equal(trace.status, 200)
      assert.equal(trace.payload.pricingVersion.includes('builtin'), true)
      // One planning call plus one per task.
      assert.equal(trace.payload.calls.length >= 3, true, `expected at least 3 calls, saw ${trace.payload.calls.length}`)
      assert.equal(trace.payload.calls.every((call) => call.priced), true)
      assert.equal(trace.payload.spend.unpricedCalls, 0)
      const expectedPerCall = (1000 * 3 + 500 * 15) / 1_000_000
      assert.equal(Math.abs(trace.payload.spend.costUsd - expectedPerCall * trace.payload.calls.length) < 1e-9, true)

      const kinds = trace.payload.spans.map((span) => span.kind)
      assert.equal(kinds.includes('run'), true)
      assert.equal(kinds.includes('task'), true)
      assert.equal(kinds.includes('llm'), true)
      const llm = trace.payload.spans.find((span) => span.kind === 'llm')
      assert.equal(llm.attributes['gen_ai.operation.name'], 'chat')
      assert.equal(llm.attributes['gen_ai.usage.input_tokens'], 1000)
      assert.equal(typeof llm.attributes['fulkrum.cost_usd'], 'number')
      const taskSpan = trace.payload.spans.find((span) => span.kind === 'task')
      assert.equal(taskSpan.parentSpanId, trace.payload.spans.find((span) => span.kind === 'run').id, 'task spans hang off the run span')
      assert.equal(trace.payload.spans.every((span) => span.endedAt !== null), true, 'every span is closed')

      const snapshot = await request('GET', `/api/runs/${runId}`)
      assert.equal(snapshot.payload.spend.calls, trace.payload.calls.length)
      assert.equal(snapshot.payload.budget.runUsd, null)
    }, { model, pricing })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})

test('a run stops when its budget is reached instead of overspending', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-budget'
  // $1 per single input token, so each call costs exactly $1.
  const pricing = createPricing({ table: { 'grok-4': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } })
  const model = modelStub({ inputTokens: 1, billableInputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })

  try {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'budget fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
      const runId = run.payload.run.id
      await request('POST', '/api/chat', { runId, message: 'Do the thing.', history: [] })

      const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
      assert.equal(store.spendForRun(runId).costUsd, 1, 'the planning call is on the ledger')

      const budget = await request('POST', `/api/runs/${runId}/control`, { action: 'set-budget', budgetUsd: 1.5 })
      assert.equal(budget.status, 200)
      assert.equal(budget.payload.run.budgetUsd, 1.5)

      const invalid = await request('POST', `/api/runs/${runId}/control`, { action: 'set-budget', budgetUsd: -5 })
      assert.equal(invalid.status, 400)

      await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && store.getRun(runId).status === 'executing') await new Promise((resolve) => setTimeout(resolve, 100))

      assert.equal(store.getRun(runId).status, 'budget_exceeded', `unexpected status ${store.getRun(runId).status}`)
      assert.equal(store.getRun(runId).budgetExceededAt > 0, true)

      const types = store.listEvents(runId).map((event) => event.type)
      assert.equal(types.includes('run.budget.exceeded'), true)

      const tasks = store.listTasks(runId)
      assert.equal(tasks.some((task) => task.status === 'blocked'), true, 'the refused task is marked blocked, not failed')
      // Verification calls cost budget like any other call: the ceiling stops the
      // research task at its verification step, and work that never started stays
      // queued rather than being invented.
      assert.equal(tasks.find((task) => task.agentId === 'research').status, 'blocked', 'the ceiling stopped the verification call after the first worker call')
      assert.equal(tasks.find((task) => task.agentId === 'builder').status, 'queued', 'work that never started stays queued')

      // Two calls were paid for: the planning call and the first worker call.
      const spend = store.spendForRun(runId)
      assert.equal(spend.costUsd, 2)
      assert.equal(spend.unpricedCalls, 0)

      // Raising the cap lets the run continue from where it stopped.
      await request('POST', `/api/runs/${runId}/control`, { action: 'set-budget', budgetUsd: 10 })
      const resumed = await request('POST', `/api/runs/${runId}/control`, { action: 'resume' })
      assert.equal(resumed.status, 200)
      const resumeDeadline = Date.now() + 10_000
      while (Date.now() < resumeDeadline && store.getRun(runId).status === 'executing') await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(store.getRun(runId).status, 'review', `unexpected status ${store.getRun(runId).status}`)
      assert.equal(store.listTasks(runId).every((task) => task.status === 'completed'), true)
    }, { model, pricing })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})

test('parallel readers cannot both slip past the same budget check', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-parallel-budget'
  // $1 per input token keeps the arithmetic obvious.
  const pricing = createPricing({ table: { 'grok-4': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } })
  const callUsage = usage({ inputTokens: 1, billableInputTokens: 1 })

  let releaseFirst
  const gate = new Promise((resolve) => { releaseFirst = resolve })
  let signalStarted
  const started = new Promise((resolve) => { signalStarted = resolve })
  let workerCalls = 0
  const model = async ({ options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: twoReaderPlan, toolCalls: [], usage: null }
    workerCalls += 1
    if (workerCalls === 1) {
      signalStarted()
      await gate
    }
    return { text: 'A summary of the work.', toolCalls: [], usage: callUsage }
  }

  try {
    await withServer(async ({ request, store, orchestrator }) => {
      const project = await request('POST', '/api/projects', { name: 'parallel budget' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id })
      const runId = run.payload.run.id
      await request('POST', '/api/chat', { runId, message: 'Research both.', history: [] })
      const drafted = await request('POST', `/api/runs/${runId}/plan`, {})

      // A ceiling that is larger than nothing spent but smaller than one
      // reservation: with the check reading recorded spend alone, both readers
      // would pass it before either returned.
      const budget = await request('POST', `/api/runs/${runId}/control`, { action: 'set-budget', budgetUsd: 0.02 })
      assert.equal(budget.status, 200)
      const approved = await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
      assert.equal(approved.status, 200)

      await Promise.race([started, new Promise((resolve) => setTimeout(resolve, 5_000))])
      assert.equal(orchestrator.inFlightBudget(runId) > 0, true, 'a call in flight is held against the ceiling')

      releaseFirst()
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && ['planning', 'executing', 'review'].includes(store.getRun(runId).status)) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const status = store.getRun(runId).status
      assert.equal(['budget_exceeded', 'review'].includes(status), true, `unexpected status ${status}`)
      assert.equal(store.listEvents(runId).some((event) => event.type === 'run.budget.exceeded'), true, 'the ceiling stopped the second reader')

      // A refused reader fails the batch while the first call is still finishing
      // its own work, so wait for it to land rather than asserting mid-flight.
      const settleDeadline = Date.now() + 5_000
      while (Date.now() < settleDeadline && orchestrator.inFlightBudget(runId) !== 0) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal(orchestrator.inFlightBudget(runId), 0, 'nothing stays reserved once the calls have settled')
    }, { model, pricing })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})

test('an unpriced model is reported, so a budget cannot silently do nothing', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-unpriced'
  const pricing = createPricing({ table: { 'some-other-model': { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 } } })
  const model = modelStub({ inputTokens: 10, billableInputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })

  try {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'unpriced fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
      const runId = run.payload.run.id
      await request('POST', '/api/chat', { runId, message: 'Do the thing.', history: [] })
      const drafted = await request('POST', `/api/runs/${runId}/plan`, {})

      await request('POST', `/api/runs/${runId}/control`, { action: 'set-budget', budgetUsd: 5 })
      await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && store.getRun(runId).status === 'executing') await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(store.getRun(runId).status, 'review', 'an unpriced run still completes rather than being blocked arbitrarily')

      const spend = store.spendForRun(runId)
      assert.equal(spend.unpricedCalls > 0, true)
      const types = store.listEvents(runId).map((event) => event.type)
      assert.equal(types.includes('run.budget.unmeasurable'), true, 'the run says its spend is a lower bound')
      assert.equal(types.filter((type) => type === 'run.budget.unmeasurable').length, 1, 'several unpriced calls still produce one lower-bound note')

      const trace = await request('GET', `/api/runs/${runId}/trace`)
      assert.equal(trace.payload.calls.some((call) => call.priced === false && call.costUsd === null), true)
    }, { model, pricing })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})

test('an override file with unusable JSON does not break pricing', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, 'broken.json')
    await writeFile(filePath, '{not json', 'utf8')
    const pricing = createPricing({ filePath })
    assert.equal(pricing.priceFor('grok-4')?.input, 3, 'the built-in table still applies')
    assert.equal(pricing.version, PRICING_VERSION)
  })
})
