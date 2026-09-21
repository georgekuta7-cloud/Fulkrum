import assert from 'node:assert/strict'
import test from 'node:test'
import { decidePermission } from '../server/permissions.mjs'
import { agentRoles } from '../server/roles.mjs'
import { validatePlan } from '../server/plans.mjs'
import { withServer, withWorkspace } from './helpers.mjs'

test('plans accept the full role set, and nothing else', () => {
  for (const role of ['research', 'builder', 'architect', 'editor', 'debug']) {
    const result = validatePlan({ objective: 'x', tasks: [{ role, title: 't', instructions: 'i' }] })
    assert.equal(result.ok, true, `${role} should be a valid plan role`)
  }
  assert.equal(validatePlan({ objective: 'x', tasks: [{ role: 'wizard', title: 't', instructions: 'i' }] }).ok, false)
  assert.deepEqual(Object.keys(agentRoles).sort(), ['architect', 'builder', 'debug', 'editor', 'research'])
  assert.equal(agentRoles.editor.maxSteps, 3, 'the editor budget is data, not a comment')
  assert.equal(agentRoles.editor.singleWritePerTurn, true)
})

test('architects write markdown only, everyone else is unaffected', () => {
  const write = (agentId, relative) => decidePermission({
    mode: 'autopilot',
    tool: { name: 'workspace.write', kind: 'write' },
    resolution: { ok: true, resolved: { tool: 'workspace.write', relative } },
    agentId,
  })
  assert.equal(write('architect', 'notes.md').ruleId, 'allow.autopilot')
  assert.equal(write('architect', 'docs/plan.markdown').allowed, true)
  const refused = write('architect', 'app.js')
  assert.equal(refused.decision, 'deny')
  assert.equal(refused.ruleId, 'deny.architect-non-markdown')
  assert.equal(write('builder', 'app.js').ruleId, 'allow.autopilot', 'the boundary is per-role')
  assert.equal(write(undefined, 'app.js').ruleId, 'allow.autopilot', 'callers without a role see no change')
})

test('an architect writing code is refused at the tools endpoint, markdown passes', async () => {
  await withWorkspace(async (directory) => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'architect fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id

      const code = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'architect', input: { path: 'app.js', content: 'x\n' } })
      assert.equal(code.status, 403, JSON.stringify(code.payload))
      assert.equal(code.payload.rule, 'deny.architect-non-markdown')

      const doc = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'architect', input: { path: 'notes.md', content: 'plan\n' } })
      assert.equal(doc.status, 200, JSON.stringify(doc.payload))
      assert.equal(store.verifyEventChain(runId).ok, true)
    }, { workspaceRoot: directory })
  })
})

async function withKey(callback) {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-roles'
  try {
    return await callback()
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
}

const verdictStub = { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }

test('an editor stops after its own step budget, not the global one', async () => {
  await withKey(async () => {
    const planJson = JSON.stringify({
      objective: 'Prove the editor budget.',
      tasks: [{ role: 'editor', title: 'Poke around', instructions: 'Read everything, slowly.', dependsOn: [] }],
    })
    let workerCalls = 0
    const model = async ({ options }) => {
      const instructions = String(options?.instructions ?? '')
      if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
      if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) return verdictStub
      workerCalls += 1
      return { text: 'Still reading.', toolCalls: [{ id: `e${workerCalls}`, name: 'workspace.read', arguments: { path: 'package.json' } }], usage: null }
    }
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'editor budget' })
        const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Prove the editor budget.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(store.getRun(runId).status, 'review')
        // Three tool steps plus the out-of-steps summary: the global budget of
        // 8 would have allowed nine calls. The summary call spends no step.
        assert.ok(workerCalls <= 4, `the editor gets 3 steps plus a summary, took ${workerCalls}`)
        assert.equal(store.listTasks(runId)[0].stepCount <= 3, true)
      }, { model, workspaceRoot: directory })
    })
  })
})

test('an editor writes once per turn; the second write waits with a reason', async () => {
  await withKey(async () => {
    const planJson = JSON.stringify({
      objective: 'Prove one write per turn.',
      tasks: [{ role: 'editor', title: 'Edit twice', instructions: 'Write two files.', dependsOn: [] }],
    })
    const model = async ({ messages, options }) => {
      const instructions = String(options?.instructions ?? '')
      if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
      if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) return verdictStub
      if (!messages.some((message) => message.role === 'tool')) {
        return {
          text: 'Two edits at once.',
          toolCalls: [
            { id: 'w1', name: 'workspace.write', arguments: { path: 'one.txt', content: 'one\n' } },
            { id: 'w2', name: 'workspace.write', arguments: { path: 'two.txt', content: 'two\n' } },
          ],
          usage: null,
        }
      }
      return { text: 'First one landed.', toolCalls: [], usage: null }
    }
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'editor writes' })
        const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Prove one write per turn.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(store.getRun(runId).status, 'review')

        const writes = store.listToolCalls(runId).filter((call) => call.name === 'workspace.write')
        assert.equal(writes.length, 1, 'only the first write ran; the second never became a call')
        assert.equal(writes[0].status, 'completed')
        const turns = JSON.stringify(store.listTaskTurns(store.listTasks(runId)[0].id))
        assert.match(turns, /one write per turn/, 'the refusal taught the shape')
      }, { model, workspaceRoot: directory })
    })
  })
})

test('a debugger runs its loop and the run completes', async () => {
  await withKey(async () => {
    const planJson = JSON.stringify({
      objective: 'Prove debugging.',
      tasks: [{ role: 'debug', title: 'Find it', instructions: 'Hypothesize and check.', dependsOn: [] }],
    })
    const model = async ({ options }) => {
      const instructions = String(options?.instructions ?? '')
      if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
      if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) return verdictStub
      return { text: 'Hypothesis: nothing is broken. Checked the tree — confirmed.', toolCalls: [], usage: null }
    }
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'debug fixture' })
        const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Prove debugging.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        assert.equal(drafted.status, 200, JSON.stringify(drafted.payload))
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(store.getRun(runId).status, 'review')
        assert.equal(store.listTasks(runId)[0].agentId, 'debug')
        assert.equal(store.verifyEventChain(runId).ok, true)
      }, { model, workspaceRoot: directory })
    })
  })
})
