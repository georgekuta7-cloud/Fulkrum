import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { FulkrumStore } from '../server/store.mjs'
import { withStore, withTempDirectory } from './helpers.mjs'

test('migrations apply once and are idempotent', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = path.join(directory, 'fulkrum.sqlite')

    const first = new FulkrumStore(databasePath)
    assert.equal(first.migrations.from, 0)
    assert.equal(first.migrations.applied > 0, true)
    const version = first.stats().schemaVersion
    first.close()

    const second = new FulkrumStore(databasePath)
    assert.equal(second.migrations.applied, 0, 'reopening must not reapply migrations')
    assert.equal(second.stats().schemaVersion, version)
    second.close()
  })
})

test('project routing settings survive a store reload', async () => {
  await withTempDirectory(async (directory) => {
    const databasePath = path.join(directory, 'fulkrum.sqlite')
    const firstStore = new FulkrumStore(databasePath)
    firstStore.createProject({ id: 'project-test', name: 'Test project' })
    firstStore.updateProject('project-test', { settings: { routing: { head: 'OpenAI · gpt-5' } } })
    firstStore.close()

    const secondStore = new FulkrumStore(databasePath)
    assert.equal(secondStore.getProject('project-test')?.project?.settings?.routing?.head, 'OpenAI · gpt-5')
    secondStore.close()
  })
})

test('run events form a verifiable hash chain', async () => {
  await withStore((store) => {
    const project = store.createProject({ name: 'chain' })
    const run = store.createRun({ projectId: project.id })
    store.appendEvent({ runId: run.id, type: 'first', payload: { a: 1, b: [1, 2] } })
    const second = store.appendEvent({ runId: run.id, type: 'second', payload: {} })

    assert.equal(store.verifyEventChain(run.id).ok, true)
    assert.equal(second.prevHash.length, 64)

    // Editing a stored payload must be detectable.
    store.database.prepare('UPDATE run_events SET payload_json = ? WHERE event_id = ?').run(JSON.stringify({ a: 999 }), store.listEvents(run.id)[0].eventId)
    const broken = store.verifyEventChain(run.id)
    assert.equal(broken.ok, false)
    assert.equal(broken.brokenAt, 1)

    // Deleting an event must be detectable too.
    store.database.prepare('DELETE FROM run_events WHERE event_id = ?').run(second.eventId)
    assert.equal(store.verifyEventChain(run.id).ok, false)
  })
})

test('events written before the chain existed are reported as unverifiable, not intact', async () => {
  await withStore((store) => {
    const project = store.createProject({ name: 'legacy' })
    const run = store.createRun({ projectId: project.id })
    // Simulate a pre-chain row.
    store.database.prepare('INSERT INTO run_events(event_id, run_id, sequence, type, agent_id, payload_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-1', run.id, 1, 'legacy', null, '{}', Date.now())

    const legacyOnly = store.verifyEventChain(run.id)
    assert.equal(legacyOnly.ok, true)
    assert.equal(legacyOnly.unverifiable, 1)
    assert.equal(legacyOnly.checked, 0)

    store.appendEvent({ runId: run.id, type: 'chained', payload: {} })
    const mixed = store.verifyEventChain(run.id)
    assert.equal(mixed.ok, true)
    assert.equal(mixed.unverifiable, 1)
    assert.equal(mixed.checked, 1)
  })
})

test('a checkpoint makes a truncated or rewritten tail detectable', async () => {
  await withStore((store) => {
    const project = store.createProject({ name: 'checkpoints' })
    const run = store.createRun({ projectId: project.id })
    store.appendEvent({ runId: run.id, type: 'one', payload: {} })
    store.appendEvent({ runId: run.id, type: 'two', payload: {} })
    store.appendEvent({ runId: run.id, type: 'three', payload: {} })

    const fresh = store.verifyEventChain(run.id)
    assert.equal(fresh.ok, true)
    assert.equal(fresh.truncated, false)
    assert.equal(fresh.verifiedFrom, 1, 'the whole chain is verifiable')

    const checkpoint = store.recordAuditCheckpoint(run.id, { source: 'test' })
    assert.equal(checkpoint.sequence, 3)
    assert.equal(checkpoint.eventCount, 3)

    // Growth past the anchor is normal, not a problem.
    store.appendEvent({ runId: run.id, type: 'four', payload: {} })
    const grown = store.verifyEventChain(run.id)
    assert.equal(grown.ok, true)
    assert.equal(grown.anchored, true)
    assert.equal(grown.truncated, false)

    // Deleting the tail leaves every remaining link valid: without the anchor this
    // would still report a healthy chain.
    store.database.prepare('DELETE FROM run_events WHERE run_id = ? AND sequence > ?').run(run.id, 1)
    const truncated = store.verifyEventChain(run.id)
    assert.equal(truncated.truncated, true, 'the missing tail is reported')
    assert.equal(truncated.ok, false)
    assert.equal(truncated.brokenAt, null, 'nothing in the remaining chain is inconsistent')

    // Rewriting the tail back to the same length is caught by the anchored hash.
    store.appendEvent({ runId: run.id, type: 'rewritten-two', payload: {} })
    store.appendEvent({ runId: run.id, type: 'rewritten-three', payload: {} })
    const rewritten = store.verifyEventChain(run.id)
    assert.equal(rewritten.truncated, false, 'the length matches the anchor again')
    assert.equal(rewritten.checkpointHashIntact, false, 'but the anchored content does not')
    assert.equal(rewritten.ok, false)

    const summary = store.verifyAllEventChains()
    assert.equal(summary.ok, false)
    assert.equal(summary.anchorMismatch.length, 1)
  })
})

test('an anchor alone cannot vouch for events written before the chain existed', async () => {
  await withStore((store) => {
    const project = store.createProject({ name: 'legacy anchor' })
    const run = store.createRun({ projectId: project.id })
    store.database.prepare('INSERT INTO run_events(event_id, run_id, sequence, type, agent_id, payload_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-1', run.id, 1, 'legacy', null, '{}', Date.now())
    store.appendEvent({ runId: run.id, type: 'chained', payload: {} })

    const checkpoint = store.recordAuditCheckpoint(run.id, { source: 'test' })
    assert.equal(checkpoint.sequence, 2)

    const result = store.verifyEventChain(run.id)
    assert.equal(result.ok, true)
    assert.equal(result.unverifiable, 1, 'the pre-chain event stays outside the guarantee')
    assert.equal(result.verifiedFrom, 2, 'and the report says where verification starts')
  })
})

test('run leases distinguish an active run from an abandoned one', async () => {
  await withStore((store) => {
    const project = store.createProject({ name: 'leases' })
    const run = store.createRun({ projectId: project.id })
    store.updateRun(run.id, { status: 'executing' })

    assert.equal(store.listStrandedRuns().length, 1, 'a run with no lease is treated as abandoned')
    store.acquireRunLease(run.id, 'owner-a', 60_000)
    assert.equal(store.listStrandedRuns().length, 0, 'a live lease is not stranded')
    assert.equal(store.listStrandedRuns(Date.now() + 120_000).length, 1, 'an expired lease is stranded')

    assert.equal(store.heartbeatRun(run.id, 'someone-else', 60_000), false, 'only the owner may renew')
    assert.equal(store.heartbeatRun(run.id, 'owner-a', 60_000), true)

    store.releaseRunLease(run.id, 'owner-a')
    assert.equal(store.getRun(run.id).ownerId, null)
  })
})

test('tool calls record a fingerprint and can be found by idempotency key', async () => {
  await withStore((store) => {
    const project = store.createProject({ name: 'tools' })
    const run = store.createRun({ projectId: project.id })
    const call = store.createToolCall({
      runId: run.id,
      agentId: 'builder',
      name: 'workspace.write',
      kind: 'write',
      input: { path: 'a.txt', content: 'x' },
      resolved: { tool: 'workspace.write', path: 'C:/ws/a.txt', bytes: 1, contentSha256: 'abc' },
      fingerprint: 'fingerprint-1',
      idempotencyKey: 'key-1',
    })

    assert.equal(call.fingerprint, 'fingerprint-1')
    assert.equal(call.resolved.path, 'C:/ws/a.txt')
    assert.equal(store.findToolCallByIdempotencyKey(run.id, 'key-1').id, call.id)
    assert.equal(store.findToolCallByIdempotencyKey(run.id, 'missing'), null)

    store.markToolCallApproved(call.id, 'run')
    assert.equal(store.getToolCall(call.id).approvalScope, 'run')
    assert.equal(store.getToolCall(call.id).approvedAt > 0, true)
  })
})

test('pruning removes stale tool output but never touches run events', async () => {
  await withStore((store) => {
    const project = store.createProject({ name: 'retention' })
    const run = store.createRun({ projectId: project.id })
    const event = store.appendEvent({ runId: run.id, type: 'keep.me', payload: {} })

    const old = store.createToolCall({ runId: run.id, name: 'workspace.read', kind: 'read', input: {} })
    store.updateToolCall(old.id, { status: 'completed', output: { big: 'x'.repeat(100) } })
    store.database.prepare('UPDATE tool_calls SET completed_at = ? WHERE id = ?').run(Date.now() - 40 * 24 * 60 * 60 * 1000, old.id)

    const recent = store.createToolCall({ runId: run.id, name: 'workspace.read', kind: 'read', input: {} })
    store.updateToolCall(recent.id, { status: 'completed', output: { keep: true } })

    const { pruned } = store.pruneToolOutputs({ retentionDays: 14 })
    assert.equal(pruned, 1)
    assert.equal(store.getToolCall(old.id).output, null)
    assert.equal(store.getToolCall(old.id).outputPrunedAt > 0, true)
    assert.deepEqual(store.getToolCall(recent.id).output, { keep: true })

    assert.equal(store.listEvents(run.id).some((item) => item.eventId === event.eventId), true)
    assert.equal(store.verifyEventChain(run.id).ok, true)
  })
})

test('interruption is recorded rather than leaving a run looking active', async () => {
  await withStore((store) => {
    const project = store.createProject({ name: 'recovery' })
    const run = store.createRun({ projectId: project.id })
    store.updateRun(run.id, { status: 'executing' })
    store.acquireRunLease(run.id, 'dead-owner', 1)
    store.createToolCall({ runId: run.id, agentId: 'builder', name: 'workspace.write', kind: 'write', input: {}, status: 'running' })

    store.updateRun(run.id, { status: 'interrupted' })
    store.markRunInterrupted(run.id, 'The API bridge stopped while this run was executing.')
    const updated = store.getRun(run.id)
    assert.equal(updated.status, 'interrupted')
    assert.equal(updated.interruptionReason.includes('stopped'), true)
    assert.equal(updated.ownerId, null)
  })
})
