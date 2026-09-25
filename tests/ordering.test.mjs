import assert from 'node:assert/strict'
import test from 'node:test'
import { withStore } from './helpers.mjs'

/**
 * Ordering under timestamp ties. Fast machines create rows within the same
 * millisecond, and every one of these lists promises an order — "newest
 * first", "oldest first", "the latest one" — that a bare timestamp sort
 * cannot keep when two rows share one. The tiebreaker is the rowid, which
 * follows insertion. The clock is frozen so every row shares a single
 * timestamp: a missing tiebreaker is wrong here deterministically, instead
 * of red only on fast CI runners and green on slow laptops.
 */

const FROZEN = 1_700_000_000_000

async function frozen(work) {
  const realNow = Date.now
  Date.now = () => FROZEN
  try {
    return await work()
  } finally {
    Date.now = realNow
  }
}

test('newest-first lists stay newest-first when timestamps tie', async () => {
  await frozen(async () => {
    await withStore((store) => {
      const firstProject = store.createProject({ name: 'first' })
      const secondProject = store.createProject({ name: 'second' })
      assert.deepEqual(store.listProjects().map((row) => row.id), [secondProject.id, firstProject.id], 'projects')

      const project = store.createProject({ name: 'runs' })
      const firstRun = store.createRun({ projectId: project.id })
      const secondRun = store.createRun({ projectId: project.id })
      assert.deepEqual(store.getProject(project.id).runs.map((row) => row.id), [secondRun.id, firstRun.id], 'a project\'s runs')
      assert.deepEqual(store.listRuns({ projectId: project.id }).map((row) => row.id), [secondRun.id, firstRun.id], 'run history')
      assert.equal(store.ensureActiveRun(project.id).id, secondRun.id, 'the newest active run')

      const firstLearning = store.recordLearning({ projectId: project.id, fact: 'first' })
      const secondLearning = store.recordLearning({ projectId: project.id, fact: 'second' })
      assert.deepEqual(store.listProjectLearnings(project.id).map((row) => row.id), [secondLearning.id, firstLearning.id], 'learnings')

      const plan = { plan: { status: 'approved', objective: 'o', contentHash: 'h', approvedAt: FROZEN }, tasks: [] }
      const firstPlaybook = store.createPlaybook({ projectId: project.id, name: 'first', plan })
      const secondPlaybook = store.createPlaybook({ projectId: project.id, name: 'second', plan })
      assert.deepEqual(store.listPlaybooks(project.id).map((row) => row.id), [secondPlaybook.id, firstPlaybook.id], 'playbooks')

      const firstSchedule = store.createSchedule({ projectId: project.id, playbookId: firstPlaybook.id, everyMinutes: 30 })
      const secondSchedule = store.createSchedule({ projectId: project.id, playbookId: firstPlaybook.id, everyMinutes: 30 })
      assert.deepEqual(store.listSchedules(project.id).map((row) => row.id), [secondSchedule.id, firstSchedule.id], 'schedules')

      const firstGoal = store.createGoal({ projectId: project.id, name: 'first' })
      const secondGoal = store.createGoal({ projectId: project.id, name: 'second' })
      assert.deepEqual(store.listGoals(project.id).map((row) => row.id), [secondGoal.id, firstGoal.id], 'goals')

      const firstMessage = store.appendMessage({ projectId: project.id, runId: firstRun.id, role: 'user', content: 'needle one' })
      const secondMessage = store.appendMessage({ projectId: project.id, runId: firstRun.id, role: 'user', content: 'needle two' })
      store.appendEvent({ runId: firstRun.id, type: 'custom.first', payload: { note: 'needle' } })
      store.appendEvent({ runId: firstRun.id, type: 'custom.second', payload: { note: 'needle' } })
      const found = store.search({ query: 'needle' })
      assert.deepEqual(found.messages.map((row) => row.id), [String(secondMessage.id), String(firstMessage.id)], 'searched messages')
      assert.deepEqual(found.events.map((row) => row.type), ['custom.second', 'custom.first'], 'searched events')

      const firstCall = store.createToolCall({ runId: firstRun.id, agentId: 'builder', name: 'workspace.write', kind: 'write', input: { path: 'shared.txt' }, resolved: { relative: 'shared.txt' } })
      const secondCall = store.createToolCall({ runId: firstRun.id, agentId: 'builder', name: 'workspace.write', kind: 'write', input: { path: 'shared.txt' }, resolved: { relative: 'shared.txt' } })
      assert.deepEqual(store.listToolCallsForPath('shared.txt').map((row) => row.id), [secondCall.id, firstCall.id], 'file history')

      const verdictTaskId = store.createTask({ runId: firstRun.id, agentId: 'builder', title: 'verdict target', instructions: 'x' }).id
      store.recordTaskVerdict({ runId: firstRun.id, taskId: verdictTaskId, overall: 'PASS', results: [] })
      const secondVerdict = store.recordTaskVerdict({ runId: firstRun.id, taskId: verdictTaskId, overall: 'FAIL', results: [] })
      assert.equal(store.getTaskVerdict(verdictTaskId).id, secondVerdict.id, 'the latest verdict')

      const firstGrant = store.createStandingGrant({ toolName: 'workspace.read', scopeKind: 'path', scopeValue: 'a', label: 'first' })
      const secondGrant = store.createStandingGrant({ toolName: 'workspace.read', scopeKind: 'path', scopeValue: 'b', label: 'second' })
      assert.deepEqual(store.listStandingGrants({ includeRevoked: true }).map((row) => row.id), [secondGrant.id, firstGrant.id], 'standing grants')

      store.recordMaintenance({ kind: 'verify', ok: true, summary: 'first' })
      store.recordMaintenance({ kind: 'verify', ok: true, summary: 'second' })
      assert.equal(store.listMaintenance({ limit: 10 })[0].summary, 'second', 'maintenance log')
      assert.equal(store.lastMaintenance('verify').summary, 'second', 'the last verify')
    })
  })
})

test('oldest-first lists stay oldest-first when timestamps tie', async () => {
  await frozen(async () => {
    await withStore((store) => {
      const project = store.createProject({ name: 'asc' })
      const run = store.createRun({ projectId: project.id })

      const firstTask = store.createTask({ runId: run.id, agentId: 'builder', title: 'first', instructions: 'x' })
      const secondTask = store.createTask({ runId: run.id, agentId: 'builder', title: 'second', instructions: 'x' })
      assert.deepEqual(store.listTasks(run.id).map((row) => row.id), [firstTask.id, secondTask.id], 'tasks')

      const firstMessage = store.appendMessage({ projectId: project.id, runId: run.id, role: 'user', content: 'first' })
      const secondMessage = store.appendMessage({ projectId: project.id, runId: run.id, role: 'user', content: 'second' })
      assert.deepEqual(store.listMessages(run.id).map((row) => row.id), [firstMessage.id, secondMessage.id], 'messages')

      const firstCall = store.createToolCall({ runId: run.id, agentId: 'builder', name: 'a', kind: 'write' })
      const secondCall = store.createToolCall({ runId: run.id, agentId: 'builder', name: 'b', kind: 'write' })
      assert.deepEqual(store.listToolCalls(run.id).map((row) => row.id), [firstCall.id, secondCall.id], 'tool calls')

      const firstEvidence = store.appendTaskEvidence({ runId: run.id, taskId: firstTask.id, kind: 'finding', summary: 'first' })
      const secondEvidence = store.appendTaskEvidence({ runId: run.id, taskId: firstTask.id, kind: 'finding', summary: 'second' })
      assert.deepEqual(store.listTaskEvidence(firstTask.id).map((row) => row.id), [firstEvidence.id, secondEvidence.id], 'evidence')

      const firstClaim = store.recordRunClaim({ runId: run.id, taskId: firstTask.id, kind: 'finding', summary: 'first' })
      const secondClaim = store.recordRunClaim({ runId: run.id, taskId: firstTask.id, kind: 'finding', summary: 'second' })
      assert.deepEqual(store.listRunClaims(run.id).map((row) => row.id), [firstClaim.id, secondClaim.id], 'claims')
      assert.deepEqual(store.listTaskClaims(firstTask.id).map((row) => row.id), [firstClaim.id, secondClaim.id], 'task claims')

      store.recordTaskVerdict({ runId: run.id, taskId: firstTask.id, overall: 'PASS', results: [] })
      store.recordTaskVerdict({ runId: run.id, taskId: firstTask.id, overall: 'FAIL', results: [] })
      assert.deepEqual(store.listTaskVerdicts(firstTask.id).map((row) => row.overall), ['PASS', 'FAIL'], 'verdicts')

      store.recordModelCall({ runId: run.id, role: 'head', provider: 'grok', model: 'first', usage: null, cost: { costUsd: 0.01, priced: true, version: 't' } })
      store.recordModelCall({ runId: run.id, role: 'head', provider: 'grok', model: 'second', usage: null, cost: { costUsd: 0.02, priced: true, version: 't' } })
      assert.deepEqual(store.listModelCalls(run.id).map((row) => row.model), ['first', 'second'], 'model calls')

      const firstSpan = store.startSpan({ runId: run.id, kind: 'llm', name: 'first' })
      const secondSpan = store.startSpan({ runId: run.id, kind: 'llm', name: 'second' })
      assert.deepEqual(store.listSpans(run.id).map((row) => row.id), [firstSpan.id, secondSpan.id], 'spans')

      const firstGrant = store.grantApproval({ runId: run.id, toolName: 'workspace.write', kind: 'once' })
      const secondGrant = store.grantApproval({ runId: run.id, toolName: 'workspace.read', kind: 'once' })
      assert.deepEqual(store.listApprovalGrants(run.id).map((row) => row.toolName), [firstGrant.toolName, secondGrant.toolName], 'approval grants')

      const snapshot = store.getRunSnapshot(run.id, { light: true })
      assert.deepEqual(snapshot.tasks.map((row) => row.id), [firstTask.id, secondTask.id], 'light-snapshot tasks')
      assert.deepEqual(snapshot.toolCalls.map((row) => row.id), [firstCall.id, secondCall.id], 'light-snapshot calls')
    })
  })
})

test('the scheduler, goal history, and stranded scan stay ordered on ties', async () => {
  await frozen(async () => {
    await withStore((store) => {
      const project = store.createProject({ name: 'timed' })
      const plan = { plan: { status: 'approved', objective: 'o', contentHash: 'h', approvedAt: FROZEN }, tasks: [] }
      const playbook = store.createPlaybook({ projectId: project.id, name: 'pb', plan })
      const firstSchedule = store.createSchedule({ projectId: project.id, playbookId: playbook.id, everyMinutes: 30 })
      const secondSchedule = store.createSchedule({ projectId: project.id, playbookId: playbook.id, everyMinutes: 30 })
      assert.deepEqual(store.listDueSchedules(FROZEN + 60 * 60_000).map((row) => row.id), [firstSchedule.id, secondSchedule.id], 'due schedules, soonest first')

      const goal = store.createGoal({ projectId: project.id, name: 'g' })
      const firstGoalRun = store.createRun({ projectId: project.id, goalId: goal.id })
      const secondGoalRun = store.createRun({ projectId: project.id, goalId: goal.id })
      assert.deepEqual(store.listGoalRuns(goal.id).map((row) => row.id), [firstGoalRun.id, secondGoalRun.id], 'goal runs, oldest first')

      store.updateRun(firstGoalRun.id, { status: 'executing', leaseExpiresAt: FROZEN - 1 })
      store.updateRun(secondGoalRun.id, { status: 'executing', leaseExpiresAt: FROZEN - 1 })
      assert.deepEqual(store.listStrandedRuns(FROZEN).map((row) => row.id), [firstGoalRun.id, secondGoalRun.id], 'stranded runs')
    })
  })
})
