import assert from 'node:assert/strict'
import test from 'node:test'
import { withServer, withStore, withWorkspace } from './helpers.mjs'

const planJson = JSON.stringify({
  objective: 'Prove playbooks.',
  tasks: [{ role: 'builder', title: 'Write the proof', instructions: 'Write proof.txt.', acceptanceCheck: 'proof.txt exists.', dependsOn: [] }],
})

const model = async ({ messages, options }) => {
  const instructions = String(options?.instructions ?? '')
  if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
  if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) {
    return { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }
  }
  if (!messages.some((message) => message.role === 'tool')) {
    return { text: 'Writing.', toolCalls: [{ id: 'w1', name: 'workspace.write', arguments: { path: 'proof.txt', content: 'proved\n' } }], usage: null }
  }
  return { text: 'Wrote it.', toolCalls: [], usage: null }
}

async function withKey(callback) {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-playbooks'
  try {
    return await callback()
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
}

async function approvedRun(request, store, projectId) {
  const run = await request('POST', '/api/runs', { projectId, permissionMode: 'autopilot' })
  const runId = run.payload.run.id
  await request('POST', '/api/chat', { runId, message: 'Prove playbooks.', history: [] })
  const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
  assert.equal(drafted.status, 200, JSON.stringify(drafted.payload))
  await request('POST', `/api/runs/${runId}/control`, { action: 'set-budget', budgetUsd: 5 })
  await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(store.getRun(runId).status, 'review')
  return runId
}

test('only an approved plan becomes a playbook, and it carries its hash and budget', async () => {
  await withStore(async (store) => {
    const project = store.createProject({ name: 'playbook unit' })
    assert.throws(() => store.createPlaybook({ projectId: project.id, name: '  ', plan: null }), /name|approved/)
    assert.throws(() => store.createPlaybook({ projectId: project.id, name: 'x', plan: null }), /approved/)
    assert.throws(() => store.createPlaybook({ projectId: 'project-nope', name: 'x', plan: { plan: { status: 'approved' } } }), /Project not found/)
    assert.deepEqual(store.listPlaybooks(project.id), [])
    assert.equal(store.deletePlaybook('playbook-nope'), false)
  })

  await withKey(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'playbooks fixture' })
        const projectId = project.payload.project.id

        // A draft is not an approval: saving from it is refused.
        const draftRun = await request('POST', '/api/runs', { projectId, permissionMode: 'autopilot' })
        const draftRunId = draftRun.payload.run.id
        await request('POST', '/api/chat', { runId: draftRunId, message: 'Prove playbooks.', history: [] })
        await request('POST', `/api/runs/${draftRunId}/plan`, {})
        const refused = await request('POST', `/api/projects/${projectId}/playbooks`, { name: 'too early', runId: draftRunId })
        assert.equal(refused.status, 409, JSON.stringify(refused.payload))

        const runId = await approvedRun(request, store, projectId)
        const plan = store.getPlan(store.getRun(runId).planId)
        const saved = await request('POST', `/api/projects/${projectId}/playbooks`, { name: 'prove it', runId })
        assert.equal(saved.status, 201, JSON.stringify(saved.payload))
        assert.equal(saved.payload.playbook.contentHash, plan.plan.contentHash, 'the playbook pins the approved bytes')
        assert.equal(saved.payload.playbook.budgetUsd, 5, 'the ceiling travels with the template')

        const listed = await request('GET', `/api/projects/${projectId}/playbooks`)
        assert.equal(listed.payload.playbooks.length, 1)

        // Another project cannot see, run, or delete it.
        const other = await request('POST', '/api/projects', { name: 'other' })
        const otherId = other.payload.project.id
        assert.equal((await request('POST', `/api/projects/${otherId}/playbooks/${saved.payload.playbook.id}/runs`, {})).status, 404)
        assert.equal((await request('DELETE', `/api/projects/${otherId}/playbooks/${saved.payload.playbook.id}`)).status, 404)
        assert.equal((await request('GET', '/api/projects/project-nope/playbooks')).status, 404)
      }, { model, workspaceRoot: directory })
    })
  })
})

test('a playbook run inherits its approval and starts immediately', async () => {
  await withKey(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'inherit fixture' })
        const projectId = project.payload.project.id
        const runId = await approvedRun(request, store, projectId)
        const saved = await request('POST', `/api/projects/${projectId}/playbooks`, { name: 'inherit me', runId })

        const started = await request('POST', `/api/projects/${projectId}/playbooks/${saved.payload.playbook.id}/runs`, { permissionMode: 'autopilot' })
        assert.equal(started.status, 201, JSON.stringify(started.payload))
        const secondId = started.payload.run.id
        assert.notEqual(secondId, runId)
        assert.equal(started.payload.run.status, 'executing', 'no new approval was needed')
        assert.equal(started.payload.run.budgetUsd, 5, 'the playbook ceiling applies')
        assert.equal(started.payload.plan.plan.contentHash, saved.payload.playbook.contentHash)
        assert.equal(started.payload.plan.plan.source, 'playbook')

        const deadline = Date.now() + 12_000
        while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(secondId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(store.getRun(secondId).status, 'review')
        const approvals = store.listEvents(secondId).filter((event) => event.type === 'plan.approved')
        assert.ok(approvals.some((event) => event.payload.source === 'playbook' && event.payload.playbookId === saved.payload.playbook.id))
        assert.equal(store.verifyEventChain(secondId).ok, true)
      }, { model, workspaceRoot: directory })
    })
  })
})

test('a playbook run can join a goal, and the goal ceiling still applies', async () => {
  await withKey(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'goal playbook' })
        const projectId = project.payload.project.id
        const runId = await approvedRun(request, store, projectId)
        const saved = await request('POST', `/api/projects/${projectId}/playbooks`, { name: 'goal run', runId })
        const goal = await request('POST', `/api/projects/${projectId}/goals`, { name: 'Capped', budgetUsd: 100 })
        const goalId = goal.payload.goal.id

        const started = await request('POST', `/api/projects/${projectId}/playbooks/${saved.payload.playbook.id}/runs`, { permissionMode: 'autopilot', goalId })
        assert.equal(started.status, 201, JSON.stringify(started.payload))
        assert.equal(started.payload.run.goalId, goalId, 'the inherited run joins the goal')

        const deadline = Date.now() + 12_000
        while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(started.payload.run.id).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(store.getRun(started.payload.run.id).status, 'review')
        const report = await request('GET', `/api/projects/${projectId}/goals/${goalId}/report`)
        assert.equal(report.payload.runs.length, 1, 'the goal report counts the playbook run')
      }, { model, workspaceRoot: directory })
    })
  })
})

test('a playbook whose bytes drifted from its hash refuses to run', async () => {
  await withKey(async () => {
    await withWorkspace(async (directory) => {
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'drift fixture' })
        const projectId = project.payload.project.id
        const runId = await approvedRun(request, store, projectId)
        const saved = await request('POST', `/api/projects/${projectId}/playbooks`, { name: 'drift me', runId })
        const playbookId = saved.payload.playbook.id

        // Corrupt the template behind the API's back: the instantiate path
        // recomputes the hash rather than trusting the row.
        store.database.prepare("UPDATE playbooks SET plan_json = ? WHERE id = ?").run(
          JSON.stringify({ objective: 'Something else entirely.', tasks: [{ role: 'builder', title: 'Other', instructions: 'Other.', dependsOn: [] }] }),
          playbookId,
        )
        const refused = await request('POST', `/api/projects/${projectId}/playbooks/${playbookId}/runs`, {})
        assert.equal(refused.status, 409, JSON.stringify(refused.payload))
        assert.match(String(refused.payload.error), /no longer matches/)

        const removed = await request('DELETE', `/api/projects/${projectId}/playbooks/${playbookId}`)
        assert.equal(removed.status, 200)
        assert.deepEqual(removed.payload.playbooks, [])
      }, { model, workspaceRoot: directory })
    })
  })
})
