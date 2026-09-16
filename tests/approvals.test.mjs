import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { diffHunks, lineDiff } from '../server/diff.mjs'
import { withServer } from './helpers.mjs'

test('a line diff reports additions, removals, and shared context', () => {
  const result = lineDiff('alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n')
  assert.equal(result.truncated, false)
  assert.equal(result.added, 1)
  assert.equal(result.removed, 1)
  assert.deepEqual(result.entries.map((entry) => entry.type), ['context', 'remove', 'add', 'context'])
  assert.equal(result.entries.find((entry) => entry.type === 'remove').line, 'beta')
  assert.equal(result.entries.find((entry) => entry.type === 'add').line, 'BETA')
})

test('a creation is all additions and an identical write has no changes', () => {
  const created = lineDiff('', 'line one\nline two\n')
  assert.equal(created.added, 2)
  assert.equal(created.removed, 0)

  const identical = lineDiff('same\n', 'same\n')
  assert.equal(identical.added, 0)
  assert.equal(identical.removed, 0)
  assert.equal(diffHunks('same\n', 'same\n').hunks.length, 0, 'no hunks when nothing changed')
})

test('hunks group nearby changes and keep context', () => {
  const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')
  const after = before.replace('line 5', 'line five').replace('line 30', 'line thirty')
  const result = diffHunks(before, after)
  assert.equal(result.hunks.length, 2, 'distant changes form separate hunks')
  for (const hunk of result.hunks) {
    assert.equal(hunk.entries.some((entry) => entry.type === 'context'), true, 'each hunk carries context')
  }
})

test('an oversized file is reported rather than diffed', () => {
  const huge = Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join('\n')
  const result = diffHunks(huge, 'tiny\n')
  assert.equal(result.truncated, true)
  assert.equal(result.hunks, undefined)
  assert.match(result.reason, /larger than/)
})

const planJson = JSON.stringify({
  objective: 'Write two files.',
  tasks: [
    { role: 'research', title: 'Look around', instructions: 'Report.', dependsOn: [] },
    { role: 'builder', title: 'Write files', instructions: 'Write the files.', dependsOn: [0] },
  ],
})

/** Forge asks to write a different file on each tool round. */
function twoWriteScript(files) {
  return async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
    if (instructions.includes('Forge')) {
      const rounds = messages.filter((message) => message.role === 'tool').length
      if (rounds < files.length) {
        return { text: `Writing ${files[rounds].path}`, toolCalls: [{ id: `f${rounds}`, name: 'workspace.write', arguments: files[rounds] }], usage: null }
      }
      return { text: 'Wrote everything requested.', toolCalls: [], usage: null }
    }
    return { text: 'Scout summary.', toolCalls: [], usage: null }
  }
}

async function startRun(request) {
  const project = await request('POST', '/api/projects', { name: 'approval fixture' })
  const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
  const runId = run.payload.run.id
  await request('POST', '/api/chat', { runId, message: 'Write the files.', history: [] })
  const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
  await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
  return runId
}

async function waitFor(store, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = predicate(store)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  return null
}

test('denying a call resumes the worker with an error it can act on', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-deny'
  const model = twoWriteScript([{ path: 'denied.txt', content: 'never written\n' }])

  try {
    await withServer(async ({ request, store, directory }) => {
      const runId = await startRun(request)
      const pending = await waitFor(store, () => store.listToolCalls(runId).find((call) => call.status === 'approval_required'))
      assert.ok(pending, 'the write should be waiting for approval')

      const denied = await request('POST', `/api/runs/${runId}/tools/${pending.id}/deny`, { reason: 'Not this file.' })
      assert.equal(denied.status, 200)
      assert.equal(denied.payload.denied, true)
      assert.equal(denied.payload.resumed, true, 'the parked worker is released')
      assert.equal(denied.payload.toolCall.status, 'denied')

      const finished = await waitFor(store, () => (store.getRun(runId).status === 'review' ? true : null))
      assert.ok(finished, `run should still finish, saw ${store.getRun(runId).status}`)
      await assert.rejects(() => import('node:fs/promises').then((fs) => fs.readFile(path.join(directory, 'denied.txt'), 'utf8')), /ENOENT/)

      const deniedEvent = store.listEvents(runId).find((event) => event.type === 'tool.denied')
      assert.equal(deniedEvent.payload.reason, 'Not this file.')
      assert.equal(deniedEvent.payload.rule, 'deny.user')
      assert.equal(store.verifyEventChain(runId).ok, true)
    }, { model })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})

test('granting a tool for the run stops the re-prompting, and the ledger shows it', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-grant'
  const model = twoWriteScript([
    { path: 'a.txt', content: 'new line\nshared line\n' },
    { path: 'b.txt', content: 'second file\n' },
  ])

  try {
    await withServer(async ({ request, store, directory }) => {
      // Pre-existing content, so the first write is a modification with a diff.
      await writeFile(path.join(directory, 'a.txt'), 'old line\nshared line\n', 'utf8')
      const runId = await startRun(request)

      const pending = await waitFor(store, () => store.listToolCalls(runId).find((call) => call.status === 'approval_required'))
      assert.ok(pending)

      const approved = await request('POST', `/api/runs/${runId}/tools/${pending.id}/approve`, { scope: 'run', fingerprint: pending.fingerprint })
      assert.equal(approved.status, 200)
      assert.equal(approved.payload.resumed, true)

      const finished = await waitFor(store, () => (store.getRun(runId).status === 'review' ? true : null))
      assert.ok(finished, `run should finish, saw ${store.getRun(runId).status}`)

      // The second write went through without a second prompt.
      const calls = store.listToolCalls(runId).filter((call) => call.name === 'workspace.write')
      assert.equal(calls.length, 2)
      assert.equal(calls.filter((call) => call.status === 'approval_required').length, 0, 'no call is left waiting')
      assert.equal(calls.every((call) => call.status === 'completed'), true)

      const grants = await request('GET', `/api/runs/${runId}/grants`)
      assert.equal(grants.payload.grants.length, 1)
      assert.equal(grants.payload.grants[0].toolName, 'workspace.write')
      const types = store.listEvents(runId).map((event) => event.type)
      assert.equal(types.includes('approval.granted'), true)

      // The second call records that a grant allowed it, not that a human did.
      const secondCallEvent = store.listEvents(runId).filter((event) => event.type === 'tool.requested' && event.payload.name === 'workspace.write')
      assert.equal(secondCallEvent.at(-1).payload.rule, 'allow.run-grant')

      const artifacts = await request('GET', `/api/runs/${runId}/artifacts`)
      assert.equal(artifacts.payload.artifacts.length, 2)
      const modified = artifacts.payload.artifacts.find((artifact) => artifact.path === 'a.txt')
      assert.equal(modified.created, false, 'a.txt existed, so this is a modification')
      assert.equal(modified.diffAvailable, true)
      assert.equal(modified.diff.added, 1)
      assert.equal(modified.diff.removed, 1)
      const created = artifacts.payload.artifacts.find((artifact) => artifact.path === 'b.txt')
      assert.equal(created.created, true)
      assert.equal(created.diff.added, 1)

      const revoked = await request('DELETE', `/api/runs/${runId}/grants/workspace.write`)
      assert.equal(revoked.status, 200)
      assert.deepEqual(revoked.payload.grants, [])
      assert.equal(store.findActiveGrant(runId, 'workspace.write'), null)
      assert.equal(store.listEvents(runId).some((event) => event.type === 'approval.revoked'), true)
    }, { model })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})

test('a run grant cannot override a deny rule', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-grant-deny'
  // The model tries to write a credential file directly.
  const model = twoWriteScript([{ path: '.env.local', content: 'SECRET=stolen\n' }])

  try {
    await withServer(async ({ request, store, directory }) => {
      const runId = await startRun(request)
      await waitFor(store, () => (store.getRun(runId).status === 'review' ? true : null))

      // Grant write for the run, then attempt the credential path through the tools API.
      store.grantApproval({ runId, toolName: 'workspace.write', kind: 'write' })
      const attempt = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: '.env.local', content: 'SECRET=stolen\n' } })
      assert.equal(attempt.status, 403, 'a grant only softens "ask"; deny still wins')
      assert.match(String(attempt.payload.error), /Sensitive files/)
      assert.equal(attempt.payload.rule, 'deny.sensitive-path', 'the denying rule is named')
      await assert.rejects(() => import('node:fs/promises').then((fs) => fs.readFile(path.join(directory, '.env.local'), 'utf8')), /ENOENT/)
    }, { model })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})

test('a persistent "always" approval is refused rather than silently downgraded', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-always'
  const model = twoWriteScript([{ path: 'c.txt', content: 'x\n' }])

  try {
    await withServer(async ({ request, store, orchestrator }) => {
      const runId = await startRun(request)
      const pending = await waitFor(store, () => store.listToolCalls(runId).find((call) => call.status === 'approval_required'))
      const response = await request('POST', `/api/runs/${runId}/tools/${pending.id}/approve`, { scope: 'always' })
      assert.equal(response.status, 400)
      assert.match(String(response.payload.error), /management view/)
      assert.equal(store.getToolCall(pending.id).status, 'approval_required', 'the call is untouched')
      orchestrator.denyToolCall(pending.id, 'test cleanup')
    }, { model })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})
