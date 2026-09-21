import assert from 'node:assert/strict'
import test from 'node:test'
import { planContentHash, validatePlan } from '../server/plans.mjs'
import { createScheduler, parseInterval } from '../server/schedules.mjs'
import { withServer, withStore, withWorkspace } from './helpers.mjs'

test('intervals parse as "every Nm/h/d" within bounds, nothing else', () => {
  assert.equal(parseInterval('every 30m'), 30)
  assert.equal(parseInterval('every 6h'), 360)
  assert.equal(parseInterval('every 1d'), 1440)
  assert.equal(parseInterval('  every  2  hours  '), 120)
  for (const bad of ['', 'hourly', 'every 0m', 'every -5h', 'every 50000d', 'every 1w', 'cron * * *']) {
    assert.equal(parseInterval(bad), null, `${bad} is not an interval`)
  }
})

async function approvedPlaybook(store, projectId) {
  const run = store.createRun({ projectId })
  const validated = validatePlan({ objective: 'Do it nightly.', tasks: [{ role: 'research', title: 'Look', instructions: 'Look.', dependsOn: [] }] })
  assert.equal(validated.ok, true)
  store.createPlan({ projectId, runId: run.id, objective: validated.plan.objective, tasks: validated.plan.tasks, contentHash: planContentHash(validated.plan), source: 'model' })
  const approved = store.approvePlan(store.getLatestPlanForRun(run.id).plan.id)
  return store.createPlaybook({ projectId, name: 'nightly', plan: store.getPlan(approved.plan.id), budgetUsd: 2 })
}

test('a due schedule fires its playbook once and advances; failures advance too', async () => {
  await withStore(async (store) => {
    const project = store.createProject({ name: 'schedule unit' })
    const playbook = await approvedPlaybook(store, project.id)
    const started = []
    const fakeOrchestrator = { start: (runId, options) => { started.push({ runId, options }) } }

    const schedule = store.createSchedule({ projectId: project.id, playbookId: playbook.id, everyMinutes: 60, budgetUsd: null })
    assert.equal(schedule.enabled, true)
    assert.ok(schedule.nextFireAt > Date.now())

    // Disabled schedules never fire, however due.
    store.updateSchedule(schedule.id, { enabled: false })
    await createScheduler({ store, orchestrator: fakeOrchestrator, clock: () => schedule.nextFireAt + 1 }).tick()
    assert.equal(started.length, 0)

    store.updateSchedule(schedule.id, { enabled: true })
    await createScheduler({ store, orchestrator: fakeOrchestrator, clock: () => schedule.nextFireAt + 1 }).tick()
    assert.equal(started.length, 1, 'the due schedule fired exactly once')
    const fired = store.getRun(started[0].runId)
    assert.equal(fired.status, 'executing')
    assert.equal(fired.budgetUsd, 2, 'the playbook ceiling travels')
    const after = store.getSchedule(schedule.id)
    assert.equal(after.lastRunId, fired.id)
    assert.ok(after.nextFireAt > schedule.nextFireAt, 'firing advances the next fire')

    // A drifted playbook refuses at fire time with its reason recorded.
    store.database.prepare('UPDATE playbooks SET plan_json = ? WHERE id = ?').run(JSON.stringify({ objective: 'Other.', tasks: [] }), playbook.id)
    const failing = store.createSchedule({ projectId: project.id, playbookId: playbook.id, everyMinutes: 60 })
    await createScheduler({ store, orchestrator: fakeOrchestrator, clock: () => failing.nextFireAt + 1 }).tick()
    assert.equal(started.length, 1, 'nothing started on a stale yes')
    const skipped = store.getSchedule(failing.id)
    assert.ok(skipped.nextFireAt > failing.nextFireAt, 'a broken schedule advances instead of hot-looping')
  })
})

test('schedules validate input and stay inside their project over HTTP', async () => {
  await withWorkspace(async (directory) => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'schedule http' })
      const projectId = project.payload.project.id
      const playbook = await approvedPlaybook(store, projectId)

      assert.equal((await request('POST', `/api/projects/${projectId}/schedules`, { playbookId: playbook.id, every: 'hourly' })).status, 400)
      assert.equal((await request('POST', `/api/projects/${projectId}/schedules`, { playbookId: 'playbook-nope', every: 'every 1h' })).status, 400)
      assert.equal((await request('POST', '/api/projects/project-nope/schedules', {})).status, 404)

      const created = await request('POST', `/api/projects/${projectId}/schedules`, { playbookId: playbook.id, every: 'every 2h', budgetUsd: 3 })
      assert.equal(created.status, 201, JSON.stringify(created.payload))
      assert.equal(created.payload.schedule.everyMinutes, 120)
      assert.equal(created.payload.schedule.budgetUsd, 3)

      const listed = await request('GET', `/api/projects/${projectId}/schedules`)
      assert.equal(listed.payload.schedules.length, 1)

      const toggled = await request('PATCH', `/api/projects/${projectId}/schedules/${created.payload.schedule.id}`, { enabled: false })
      assert.equal(toggled.payload.schedule.enabled, false)
      assert.equal((await request('PATCH', `/api/projects/${projectId}/schedules/schedule-nope`, { enabled: true })).status, 404)

      const other = await request('POST', '/api/projects', { name: 'other' })
      assert.equal((await request('DELETE', `/api/projects/${other.payload.project.id}/schedules/${created.payload.schedule.id}`)).status, 404)
      const removed = await request('DELETE', `/api/projects/${projectId}/schedules/${created.payload.schedule.id}`)
      assert.equal(removed.status, 200)
      assert.deepEqual(removed.payload.schedules, [])
    }, { workspaceRoot: directory })
  })
})

test('goals group runs under a shared ceiling and report member chains', async () => {
  await withStore(async (store) => {
    const project = store.createProject({ name: 'goal unit' })
    assert.throws(() => store.createGoal({ projectId: project.id, name: '  ' }), /name/)
    assert.throws(() => store.createGoal({ projectId: project.id, name: 'x', budgetUsd: -1 }), /positive/)
    const goal = store.createGoal({ projectId: project.id, name: 'Green CI', objective: 'Fix flakes.', acceptance: 'CI passes.', budgetUsd: 1.5 })
    assert.equal(goal.status, 'open')
    assert.deepEqual(store.listGoals(project.id).map((entry) => entry.id), [goal.id])
    assert.equal(store.goalSpend(goal.id), 0)
    assert.equal(store.deleteGoal('goal-nope'), false)
  })

  await withWorkspace(async (directory) => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'goal http' })
      const projectId = project.payload.project.id
      assert.equal((await request('POST', `/api/projects/${projectId}/goals`, { name: '' })).status, 400)
      const created = await request('POST', `/api/projects/${projectId}/goals`, { name: 'Green CI', objective: 'Fix flakes.', acceptance: 'CI passes.', budgetUsd: 1.5 })
      assert.equal(created.status, 201, JSON.stringify(created.payload))
      const goalId = created.payload.goal.id

      // A run joins the goal, spends against it, and the next run is refused.
      const first = await request('POST', '/api/runs', { projectId, goalId })
      assert.equal(first.status, 201, JSON.stringify(first.payload))
      assert.equal(first.payload.run.goalId, goalId)
      store.recordModelCall({ runId: first.payload.run.id, role: 'head', provider: 'grok', model: 'grok-4', usage: { inputTokens: 10, outputTokens: 5 }, cost: { costUsd: 2, priced: true, version: 'test' } })
      assert.equal(store.goalSpend(goalId), 2)

      const refused = await request('POST', '/api/runs', { projectId, goalId })
      assert.equal(refused.status, 402, JSON.stringify(refused.payload))
      assert.match(String(refused.payload.error), /Green CI/)

      // Another project cannot borrow the goal, and the report aggregates.
      const other = await request('POST', '/api/projects', { name: 'other' })
      assert.equal((await request('POST', '/api/runs', { projectId: other.payload.project.id, goalId })).status, 404)
      const report = await request('GET', `/api/projects/${projectId}/goals/${goalId}/report`)
      assert.equal(report.status, 200)
      assert.equal(report.payload.goal.name, 'Green CI')
      assert.equal(report.payload.runs.length, 1)
      assert.equal(report.payload.spend.totalCostUsd, 2)
      assert.equal(report.payload.spend.remainingUsd, -0.5)
      assert.equal((await request('GET', `/api/projects/${projectId}/goals/goal-nope/report`)).status, 404)

      const removed = await request('DELETE', `/api/projects/${projectId}/goals/${goalId}`)
      assert.equal(removed.status, 200)
      assert.deepEqual(removed.payload.goals, [])
    }, { workspaceRoot: directory })
  })
})
