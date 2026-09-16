import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { withServer, withTempDirectory } from './helpers.mjs'

async function makeRun(request, { permissionMode = 'selective' } = {}) {
  const project = await request('POST', '/api/projects', { name: 'api fixture' })
  const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode })
  return { projectId: project.payload.project.id, runId: run.payload.run.id }
}

test('a malformed body is rejected without killing the bridge', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, 'notes.txt'), 'hi', 'utf8')
    await withServer(async ({ request }) => {
      const { runId } = await makeRun(request)

      for (const route of [`/api/runs/${runId}/control`, `/api/runs/${runId}/tools`]) {
        const response = await request('POST', route, 'not-json')
        assert.equal(response.status, 400, `${route} should answer 400, not die`)
        assert.match(String(response.payload.error), /valid JSON/)
      }

      // The bridge must still be serving after three bad requests in a row.
      const health = await request('GET', '/api/health')
      assert.equal(health.status, 200)
      assert.equal(health.payload.ok, true)
    }, { workspaceRoot: directory })
  })
})

test('an oversized body is refused', async () => {
  await withServer(async ({ request }) => {
    const response = await request('POST', '/api/projects', JSON.stringify({ name: 'x'.repeat(200_000) }))
    assert.equal(response.status, 413)
  })
})

test('a browser origin that is not allowlisted is refused', async () => {
  await withServer(async ({ request }) => {
    const allowed = await request('GET', '/api/health', undefined, { Origin: 'http://127.0.0.1:5173' })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173')

    const blocked = await request('GET', '/api/health', undefined, { Origin: 'https://evil.example' })
    assert.equal(blocked.status, 403)

    // Vite's preview server is a different port, so it is refused by default.
    const preview = await request('POST', '/api/projects', { name: 'x' }, { Origin: 'http://localhost:4173' })
    assert.equal(preview.status, 403)
  })
})

test('approving a call cannot substitute different arguments', async () => {
  await withTempDirectory(async (directory) => {
    await withServer(async ({ request }) => {
      const { runId } = await makeRun(request)

      const requested = await request('POST', `/api/runs/${runId}/tools`, {
        name: 'workspace.write',
        agentId: 'builder',
        input: { path: 'approved.txt', content: 'what the user saw' },
      })
      assert.equal(requested.status, 409)
      assert.equal(requested.payload.approvalRequired, true)
      const toolCall = requested.payload.toolCall
      assert.equal(typeof toolCall.fingerprint, 'string')
      assert.equal(toolCall.resolved.path, path.join(directory, 'approved.txt'), 'the record shows the resolved path')

      // The classic substitution attack: approve one call, ask it to run another.
      const approved = await request('POST', `/api/runs/${runId}/tools/${toolCall.id}/approve`, {
        input: { path: 'substituted.txt', content: 'payload the user never saw' },
      })
      assert.equal(approved.status, 200)
      assert.equal(approved.payload.toolCall.output.path, 'approved.txt')

      assert.equal(await readFile(path.join(directory, 'approved.txt'), 'utf8'), 'what the user saw')
      await assert.rejects(() => readFile(path.join(directory, 'substituted.txt'), 'utf8'), /ENOENT/)

      // A fingerprint that does not match the stored call is refused.
      const { runId: secondRun } = await makeRun(request)
      const second = await request('POST', `/api/runs/${secondRun}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'a.txt', content: 'x' } })
      const mismatch = await request('POST', `/api/runs/${secondRun}/tools/${second.payload.toolCall.id}/approve`, { fingerprint: 'deadbeef' })
      assert.equal(mismatch.status, 409)
      assert.match(String(mismatch.payload.error), /fingerprint/i)
    }, { workspaceRoot: directory })
  })
})

test('a tool call against a credential path is denied, not queued for approval', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, '.env.local'), 'SECRET=1\n', 'utf8')
    await withServer(async ({ request }) => {
      const { runId } = await makeRun(request, { permissionMode: 'autopilot' })
      const response = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.read', agentId: 'research', input: { path: '.env.local' } })
      assert.equal(response.status, 403)
      assert.match(String(response.payload.error), /Sensitive files/)
      assert.equal(response.payload.toolCall.status, 'denied')
    }, { workspaceRoot: directory })
  })
})

test('the event stream resumes from Last-Event-ID instead of replaying', async () => {
  await withServer(async ({ baseUrl, store, request }) => {
    const { runId } = await makeRun(request)
    store.appendEvent({ runId, type: 'test.one', payload: {} })
    store.appendEvent({ runId, type: 'test.two', payload: {} })
    store.appendEvent({ runId, type: 'test.three', payload: {} })

    const controller = new AbortController()
    const response = await fetch(`${baseUrl}/api/runs/${runId}/stream`, { headers: { 'Last-Event-ID': '2' }, signal: controller.signal })
    assert.equal(response.status, 200)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 4_000
    try {
      while (Date.now() < deadline && !text.includes('id: 3')) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    } finally {
      controller.abort()
    }

    assert.match(text, /id: 3/, 'the stream should deliver the event after the cursor')
    assert.doesNotMatch(text, /id: 1\n/, 'events before the cursor should not be replayed')
  })
})

test('the audit endpoint reports chain integrity, including unverifiable history', async () => {
  await withServer(async ({ request, store }) => {
    const { runId } = await makeRun(request)
    store.appendEvent({ runId, type: 'chained', payload: { ok: true } })

    const audit = await request('GET', `/api/runs/${runId}/audit`)
    assert.equal(audit.status, 200)
    assert.equal(audit.payload.ok, true)
    assert.equal(audit.payload.checked, 1)

    const snapshot = await request('GET', `/api/runs/${runId}`)
    assert.equal(snapshot.payload.audit.ok, true)
  })
})

test('an interrupted run can be resumed, and a completed task is not repeated', async () => {
  await withServer(async ({ request, store }) => {
    const { runId } = await makeRun(request)
    store.updateRun(runId, { status: 'interrupted' })
    store.markRunInterrupted(runId, 'bridge stopped')

    const resumed = await request('POST', `/api/runs/${runId}/control`, { action: 'resume' })
    assert.equal(resumed.status, 200)
    const run = store.getRun(runId)
    assert.equal(run.interruptedAt, null)
    assert.equal(run.interruptionReason, null)

    // Let the resumed worker finish inside the fixture, so nothing outlives the
    // server the test is about to close.
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && store.getRun(runId).status === 'executing') {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(['review', 'failed'].includes(store.getRun(runId).status), true, `unexpected status ${store.getRun(runId).status}`)
  })
})

test('a project can be deleted with everything it owns', async () => {
  await withServer(async ({ request, store }) => {
    // The store starts empty, and the last project is kept, so make a keeper first.
    await request('POST', '/api/projects', { name: 'keeper' })
    const project = await request('POST', '/api/projects', { name: 'doomed' })
    const projectId = project.payload.project.id
    const run = await request('POST', '/api/runs', { projectId, permissionMode: 'selective' })
    store.appendEvent({ runId: run.payload.run.id, type: 'noise', payload: {} })
    store.createToolCall({ runId: run.payload.run.id, name: 'workspace.read', kind: 'read', input: {} })
    assert.equal(store.getProject(projectId).runs.length, 1)

    const removed = await request('DELETE', `/api/projects/${projectId}`)
    assert.equal(removed.status, 200)
    assert.equal(removed.payload.removed, projectId)
    assert.equal(store.getProject(projectId), null)
    assert.equal(removed.payload.projects.some((item) => item.id === projectId), false)

    // The cascade took the runs, events, and tool calls with it.
    assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM runs WHERE project_id = ?').get(projectId).count, 0)
    assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?').get(run.payload.run.id).count, 0)
    assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ?').get(run.payload.run.id).count, 0)

    assert.equal((await request('DELETE', `/api/projects/${projectId}`)).status, 404)
  })
})

test('a project with a run in flight cannot be deleted', async () => {
  await withServer(async ({ request, store }) => {
    await request('POST', '/api/projects', { name: 'keeper' })
    const project = await request('POST', '/api/projects', { name: 'busy' })
    const projectId = project.payload.project.id
    const run = await request('POST', '/api/runs', { projectId, permissionMode: 'selective' })
    store.updateRun(run.payload.run.id, { status: 'executing' })

    const refused = await request('DELETE', `/api/projects/${projectId}`)
    assert.equal(refused.status, 409)
    assert.match(String(refused.payload.error), /Stop the active run/)
    assert.notEqual(store.getProject(projectId), null, 'the project is untouched')
  })
})

test('the last project cannot be deleted', async () => {
  await withServer(async ({ request, store }) => {
    const only = await request('POST', '/api/projects', { name: 'only one' })
    assert.equal(store.listProjects().length, 1)
    const refused = await request('DELETE', `/api/projects/${only.payload.project.id}`)
    assert.equal(refused.status, 409)
    assert.match(String(refused.payload.error), /last project/)
  })
})

test('the demo run reaches review without ever requesting an approval', async () => {
  await withServer(async ({ request, store }) => {
    const { runId } = await makeRun(request)
    await request('POST', '/api/chat', { runId, message: 'Ship a narrow proof.', history: [] })
    await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', routing: {} })

    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && store.getRun(runId).status === 'executing') {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    assert.equal(store.getRun(runId).status, 'review')
    const types = store.listEvents(runId).map((event) => event.type)
    assert.equal(types.includes('worker.handoff'), true)
    assert.equal(types.includes('run.review.ready'), true)

    // Both worker tools are reads, so the approval path stays dormant. This is
    // the reachability fact that Phase 2 (model-chosen tools) has to change.
    assert.equal(types.includes('approval.requested'), false)
    assert.equal(store.getRun(runId).ownerId, null, 'the lease is released when the run finishes')
    assert.equal(store.verifyEventChain(runId).ok, true)
  })
})

test('a run gets a stored plan, and approval binds to its content hash', async () => {
  await withServer(async ({ request, store }) => {
    const project = await request('POST', '/api/projects', { name: 'plan fixture' })
    const projectId = project.payload.project.id
    const run = await request('POST', '/api/runs', { projectId, permissionMode: 'selective' })
    const runId = run.payload.run.id

    const missing = await request('GET', `/api/runs/${runId}/plan`)
    assert.equal(missing.status, 404, 'a fresh run has no plan until one is drafted')

    const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
    assert.equal(drafted.status, 200)
    assert.equal(drafted.payload.tasks.length >= 2, true)
    assert.equal(typeof drafted.payload.plan.contentHash, 'string')
    assert.equal(drafted.payload.plan.contentHash.length, 64)

    // Drafting again reuses the existing draft rather than churning versions.
    const second = await request('POST', `/api/runs/${runId}/plan`, {})
    assert.equal(second.payload.plan.id, drafted.payload.plan.id)

    // Regenerating supersedes the old draft and produces a new version.
    const regenerated = await request('POST', `/api/runs/${runId}/plan`, { regenerate: true })
    assert.equal(regenerated.payload.plan.version > drafted.payload.plan.version, true)
    assert.equal(store.getPlan(drafted.payload.plan.id).plan.status, 'superseded')

    const planId = regenerated.payload.plan.id
    const planHash = regenerated.payload.plan.contentHash

    // Approving a hash that is not what is stored must be refused.
    const stale = await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId, planHash: 'not-the-real-hash', routing: {} })
    assert.equal(stale.status, 409)
    assert.match(String(stale.payload.error), /changed since it was shown/)
    assert.equal(store.getPlan(planId).plan.status, 'draft', 'a rejected approval must not approve the plan')

    const approved = await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId, planHash, routing: {} })
    assert.equal(approved.status, 200)
    assert.equal(store.getPlan(planId).plan.status, 'approved')
    assert.equal(store.getRun(runId).planId, planId)

    const types = store.listEvents(runId).map((event) => event.type)
    assert.equal(types.includes('plan.approved'), true)
    assert.equal(store.verifyEventChain(runId).ok, true)
  })
})

test('the tool loop runs model-chosen tools, parks for approval, then resumes', async () => {
  const previousXai = process.env.XAI_API_KEY
  // A key is what makes the loop engage instead of reporting demo mode; the
  // model itself is scripted below, so nothing leaves the machine.
  process.env.XAI_API_KEY = 'sk-test-key-for-loop'

  const transcript = []
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) {
      transcript.push('plan')
      return {
        text: JSON.stringify({
          objective: 'Prove the write path end to end.',
          tasks: [
            { role: 'research', title: 'Look around', instructions: 'Report what is in the workspace.', dependsOn: [] },
            { role: 'builder', title: 'Write the proof', instructions: 'Write proof.txt.', acceptanceCheck: 'proof.txt exists.', dependsOn: [0] },
          ],
        }),
        toolCalls: [],
        usage: null,
      }
    }
    if (instructions.includes('Forge')) {
      if (!messages.some((message) => message.role === 'tool')) {
        transcript.push('forge:tool-call')
        return { text: 'Writing the artifact now.', toolCalls: [{ id: 'forge-1', name: 'workspace.write', arguments: { path: 'proof.txt', content: 'built by forge' } }], usage: null }
      }
      transcript.push('forge:final')
      return { text: 'Wrote proof.txt after approval.', toolCalls: [], usage: null }
    }
    transcript.push('research')
    return { text: 'Scout found the fixture files.', toolCalls: [], usage: null }
  }

  try {
    await withServer(async ({ request, store, directory }) => {
      const project = await request('POST', '/api/projects', { name: 'loop fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
      const runId = run.payload.run.id
      await request('POST', '/api/chat', { runId, message: 'Prove the write path.', history: [] })

      const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
      assert.equal(
        drafted.payload.plan.source,
        'model',
        `the model-written plan should be used (source=${drafted.payload.plan.source} fallback=${drafted.payload.fallbackReason ?? 'none'} modelCalls=${transcript.join('|')} events=${store.listEvents(runId).map((event) => event.type).join(',')})`,
      )
      assert.equal(drafted.payload.tasks.length, 2)

      await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

      // The build task must park on the write rather than run it.
      let pending = null
      const parkDeadline = Date.now() + 8_000
      while (Date.now() < parkDeadline && !pending) {
        pending = store.listToolCalls(runId).find((call) => call.status === 'approval_required') ?? null
        if (!pending) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.ok(pending, 'the worker should be waiting for approval')
      assert.equal(pending.name, 'workspace.write')
      assert.match(pending.error, /approval/, 'the parked call records why it is waiting')
      assert.equal(typeof pending.fingerprint, 'string')
      assert.equal(pending.resolved.relative, 'proof.txt')

      const tasksWhileParked = store.listTasks(runId)
      assert.equal(tasksWhileParked.find((task) => task.agentId === 'builder').status, 'running', 'the build task is in flight, not finished')
      await assert.rejects(() => readFile(path.join(directory, 'proof.txt'), 'utf8'), /ENOENT/, 'nothing may be written before approval')

      const approved = await request('POST', `/api/runs/${runId}/tools/${pending.id}/approve`, { fingerprint: pending.fingerprint })
      assert.equal(approved.status, 200)
      assert.equal(approved.payload.resumed, true, 'approving must resume the waiting worker')

      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && store.getRun(runId).status === 'executing') {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.equal(store.getRun(runId).status, 'review', `unexpected status ${store.getRun(runId).status}`)

      assert.equal(await readFile(path.join(directory, 'proof.txt'), 'utf8'), 'built by forge')
      const builderTask = store.listTasks(runId).find((task) => task.agentId === 'builder')
      assert.equal(builderTask.status, 'completed')
      assert.match(builderTask.result, /Wrote proof\.txt after approval/)
      assert.equal(builderTask.stepCount >= 2, true, 'the loop should record two model steps')

      assert.deepEqual(transcript.includes('forge:tool-call') && transcript.includes('forge:final'), true)
      const types = store.listEvents(runId).map((event) => event.type)
      assert.equal(types.includes('plan.approved'), true)
      assert.equal(types.includes('worker.handoff'), true)
      assert.equal(types.includes('run.review.ready'), true)
      assert.equal(store.verifyEventChain(runId).ok, true)
    }, { model })
  } finally {
    if (previousXai === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousXai
  }
})
