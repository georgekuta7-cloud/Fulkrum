import assert from 'node:assert/strict'
import test from 'node:test'
import { withServer } from './helpers.mjs'

/**
 * The attention queue is derived from state (P3.1): a reload reproduces it,
 * a decision removes its item, and items are ordered by how long they have
 * waited. Nothing here is a transient UI flag.
 */

test('the attention queue gathers everything waiting on a human, oldest first, and forgets decided items', async () => {
  await withServer(async ({ request, store }) => {
    const project = await request('POST', '/api/projects', { name: 'attention fixture' })
    const projectId = project.payload.project.id

    // A parked write: an approval waiting.
    const run = await request('POST', '/api/runs', { projectId, permissionMode: 'selective' })
    const runId = run.payload.run.id
    const requested = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'a.txt', content: 'x\n' } })
    assert.equal(requested.status, 409, 'the write parks')

    // A stopped run: a budget item.
    const stopped = await request('POST', '/api/runs', { projectId, permissionMode: 'selective' })
    store.updateRun(stopped.payload.run.id, { status: 'budget_exceeded' })

    const attention = await request('GET', '/api/attention')
    assert.equal(attention.status, 200)
    const kinds = attention.payload.items.map((item) => item.kind)
    assert.ok(kinds.includes('approval'), `approval in ${JSON.stringify(kinds)}`)
    assert.ok(kinds.includes('budget'), `budget in ${JSON.stringify(kinds)}`)
    assert.equal(attention.payload.total, attention.payload.items.length)
    assert.equal(attention.payload.counts.approval, 1)
    const since = attention.payload.items.map((item) => item.since)
    assert.deepEqual(since, [...since].sort((a, b) => a - b), 'oldest first')

    // The decision removes the item: the state that produced it is gone.
    const call = store.listToolCalls(runId).find((entry) => entry.status === 'approval_required')
    const denied = await request('POST', `/api/runs/${runId}/tools/${call.id}/deny`, { reason: 'not now' })
    assert.equal(denied.status, 200)
    const after = await request('GET', '/api/attention')
    assert.equal(after.payload.items.some((item) => item.kind === 'approval'), false)
    assert.equal(after.payload.items.some((item) => item.kind === 'budget'), true, 'the other item is untouched')
  })
})

test('a finished run awaiting its review and a revised draft read as review and replan', async () => {
  await withServer(async ({ request, store }) => {
    const project = await request('POST', '/api/projects', { name: 'review fixture' })
    const run = await request('POST', '/api/runs', { projectId: project.payload.project.id })
    const runId = run.payload.run.id
    const plan = store.createPlan({ projectId: project.payload.project.id, runId, objective: 'Review me.', contentHash: 'h', source: 'test', tasks: [{ role: 'research', title: 'Look', instructions: 'i', dependsOn: [] }] })
    store.updateRun(runId, { planId: plan.plan.id, status: 'review' })
    store.approvePlan(plan.plan.id)

    const reviewed = await request('GET', '/api/attention')
    assert.equal(reviewed.payload.items.find((item) => item.runId === runId)?.kind, 'review')

    // A revised draft (a replan) reads as needing approval.
    store.createPlan({ projectId: project.payload.project.id, runId, objective: 'Revised.', contentHash: 'h2', source: 'test', tasks: [{ role: 'research', title: 'Look again', instructions: 'i', dependsOn: [] }] })
    const replanned = await request('GET', '/api/attention')
    assert.equal(replanned.payload.items.find((item) => item.runId === runId)?.kind, 'replan')
  })
})

test('the plan previews the effective dispatch before approval', async () => {
  await withServer(async ({ request, store, providerRegistry }) => {
    providerRegistry.addCustom({ label: 'Solo', baseUrl: 'https://example.invalid/v1', model: 'solo-model', apiKey: 'sk-solo' })
    const project = await request('POST', '/api/projects', { name: 'dispatch fixture' })
    const projectId = project.payload.project.id
    const run = await request('POST', '/api/runs', { projectId })
    const runId = run.payload.run.id
    store.createPlan({ projectId, runId, objective: 'Preview.', contentHash: 'h', source: 'test', tasks: [
      { role: 'research', title: 'Look', instructions: 'Read.', dependsOn: [] },
      { role: 'builder', title: 'Build', instructions: 'Write.', dependsOn: [0] },
    ] })

    const plan = await request('GET', `/api/runs/${runId}/plan`)
    assert.equal(plan.status, 200)
    const dispatch = plan.payload.dispatch
    assert.equal(dispatch.rows.length, 2)
    assert.equal(dispatch.rows[0].provider, 'Solo', 'the effective provider is named, not "default"')
    assert.equal(dispatch.rows[0].model, 'solo-model')
    assert.equal(dispatch.rows[0].group, 'parallel', 'readers may overlap')
    assert.equal(dispatch.rows[1].group, 'sequential', 'writers are serialized')
    assert.equal(dispatch.sharedKey, true, 'one key across rows is stated')
    assert.equal(dispatch.providersReady, true)
  })
})

test('a revised draft reports what changed from the previous version', async () => {
  await withServer(async ({ request, store }) => {
    const project = await request('POST', '/api/projects', { name: 'revision fixture' })
    const projectId = project.payload.project.id
    const run = await request('POST', '/api/runs', { projectId })
    const runId = run.payload.run.id
    const first = store.createPlan({ projectId, runId, objective: 'v1', contentHash: 'h1', source: 'test', tasks: [
      { role: 'research', title: 'Look', instructions: 'Read.', dependsOn: [] },
      { role: 'builder', title: 'Build', instructions: 'Write.', dependsOn: [0] },
    ] })
    store.approvePlan(first.plan.id)
    store.createPlan({ projectId, runId, objective: 'v2', contentHash: 'h2', source: 'test', tasks: [
      { role: 'research', title: 'Look', instructions: 'Read deeper.', dependsOn: [] },
      { role: 'builder', title: 'Ship', instructions: 'Write.', dependsOn: [0] },
    ] })

    const plan = await request('GET', `/api/runs/${runId}/plan`)
    assert.equal(plan.status, 200)
    assert.equal(plan.payload.revision.previousVersion, 1)
    assert.equal(plan.payload.revision.previousStatus, 'approved')
    assert.deepEqual(plan.payload.revision.changed, ['Look'])
    assert.deepEqual(plan.payload.revision.added, ['Ship'])
    assert.deepEqual(plan.payload.revision.removed, ['Build'])
  })
})
