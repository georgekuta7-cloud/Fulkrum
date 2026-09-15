import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { withServer } from './helpers.mjs'

async function makeRun(request, { permissionMode = 'selective' } = {}) {
  const project = await request('POST', '/api/projects', { name: 'api fixture' })
  const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode })
  return { projectId: project.payload.project.id, runId: run.payload.run.id }
}

test('a malformed body is rejected without killing the bridge', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fulkrum-api-fixture-'))
  await writeFile(path.join(directory, 'notes.txt'), 'hi', 'utf8')
  try {
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
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
  const directory = await mkdtemp(path.join(tmpdir(), 'fulkrum-approval-'))
  try {
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
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a tool call against a credential path is denied, not queued for approval', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fulkrum-deny-'))
  await writeFile(path.join(directory, '.env.local'), 'SECRET=1\n', 'utf8')
  try {
    await withServer(async ({ request }) => {
      const { runId } = await makeRun(request, { permissionMode: 'autopilot' })
      const response = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.read', agentId: 'research', input: { path: '.env.local' } })
      assert.equal(response.status, 403)
      assert.match(String(response.payload.error), /Sensitive files/)
      assert.equal(response.payload.toolCall.status, 'denied')
    }, { workspaceRoot: directory })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
