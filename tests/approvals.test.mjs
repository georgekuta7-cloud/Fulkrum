import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
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

async function startRun(request, routing = {}) {
  const project = await request('POST', '/api/projects', { name: 'approval fixture' })
  const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
  const runId = run.payload.run.id
  await request('POST', '/api/chat', { runId, message: 'Write the files.', history: [] })
  const drafted = await request('POST', `/api/runs/${runId}/plan`, { routing })
  await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing })
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

test('"always" creates a scoped standing grant, and the scope is what holds', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-standing'
  // Three writes: two in one directory, one outside it.
  const model = twoWriteScript([
    { path: 'src/a.txt', content: 'first\n' },
    { path: 'src/b.txt', content: 'second\n' },
    { path: 'docs/c.txt', content: 'third\n' },
  ])

  try {
    await withServer(async ({ request, store }) => {
      const runId = await startRun(request)
      const pending = await waitFor(store, () => store.listToolCalls(runId).find((call) => call.status === 'approval_required'))
      assert.ok(pending, 'the first write waits')

      const approved = await request('POST', `/api/runs/${runId}/tools/${pending.id}/approve`, { scope: 'always', fingerprint: pending.fingerprint })
      assert.equal(approved.status, 200, JSON.stringify(approved.payload))
      assert.equal(approved.payload.standingGrant.scopeKind, 'path')
      assert.equal(approved.payload.standingGrant.scopeValue, 'src', 'scoped to the directory the file is in, not to the file')

      // The second write is in the same directory, so it does not ask again.
      const inside = await waitFor(store, () => store.listToolCalls(runId).find((call) => call.input?.path === 'src/b.txt' && call.status === 'completed'))
      assert.ok(inside, 'the second write in the same directory ran without a prompt')

      // ...while one outside the scope stopped for a person, which is the whole
      // point of scoping rather than allowing the tool outright.
      const outside = await waitFor(store, () => store.listToolCalls(runId).find((call) => call.input?.path === 'docs/c.txt' && call.status === 'approval_required'))
      assert.ok(outside, 'a write outside the scope asks')
      assert.equal(store.listEvents(runId).some((event) => event.type === 'approval.requested' && event.payload.rule === 'ask.default'), true)

      // Denying it lets the run finish: the point was that it asked at all.
      const denied = await request('POST', `/api/runs/${runId}/tools/${outside.id}/deny`, { reason: 'outside the granted scope' })
      assert.equal(denied.status, 200)
      const finished = await waitFor(store, () => (store.getRun(runId).status === 'review' ? true : null))
      assert.ok(finished, `run should finish, saw ${store.getRun(runId).status}`)

      const grants = await request('GET', '/api/grants')
      assert.equal(grants.payload.grants.length, 1)
      assert.equal(grants.payload.grants[0].useCount >= 1, true, 'using a grant records that it was used')
      assert.equal(grants.payload.history.some((entry) => entry.summary.includes('allowed')), true, 'and creating it is recorded')

      // Revoking it puts the prompt back for the directory it covered.
      const revoked = await request('DELETE', `/api/grants/${grants.payload.grants[0].id}`)
      assert.equal(revoked.status, 200)
      assert.deepEqual(revoked.payload.grants, [])
      assert.equal(store.findStandingGrant({ toolName: 'workspace.write', resolved: { relative: 'src/a.txt' } }), null)

      // The audit shows both the grant and the call it covered.
      const types = store.listEvents(runId).map((event) => event.type)
      assert.equal(types.includes('approval.standing'), true)
      assert.equal(store.verifyEventChain(runId).ok, true)
    }, { model })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})

test('"always" refuses when the scope would be unbounded', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-unbounded'
  const model = twoWriteScript([{ path: 'top-level.txt', content: 'x\n' }])

  try {
    await withServer(async ({ request, store }) => {
      const runId = await startRun(request)
      const pending = await waitFor(store, () => store.listToolCalls(runId).find((call) => call.status === 'approval_required'))
      assert.ok(pending)

      // A file in the workspace root scopes to the whole workspace, which is the
      // blanket permission this avoids.
      const response = await request('POST', `/api/runs/${runId}/tools/${pending.id}/approve`, { scope: 'always' })
      assert.equal(response.status, 400)
      assert.match(String(response.payload.error), /workspace root/)
      assert.equal(store.listStandingGrants().length, 0)
      assert.equal(store.getToolCall(pending.id).status, 'approval_required', 'and the call is untouched')
    }, { model })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})

test('a standing grant cannot be created for a command, or override a refusal', async () => {
  await withServer(async ({ request, store }) => {
    // A command has no boundary to grant within.
    const shellGrant = await request('POST', '/api/grants', { toolName: 'shell.exec', scopeKind: 'path', scopeValue: 'src' })
    assert.equal(shellGrant.status, 400)
    assert.match(String(shellGrant.payload.error), /no scope/)

    // A path scope must be relative, inside the workspace, and not the root.
    for (const scopeValue of ['/etc', 'C:\\Windows', '../outside', '.', '']) {
      const attempt = await request('POST', '/api/grants', { toolName: 'workspace.write', scopeKind: 'path', scopeValue })
      assert.equal(attempt.status, 400, `${scopeValue} should be refused`)
    }

    const { runId } = { runId: (await request('POST', '/api/runs', { projectId: (await request('POST', '/api/projects', { name: 'deny fixture' })).payload.project.id })).payload.run.id }
    const good = await request('POST', '/api/grants', { toolName: 'workspace.write', scopeKind: 'path', scopeValue: 'src' })
    assert.equal(good.status, 201)
    assert.equal(store.findStandingGrant({ toolName: 'workspace.write', resolved: { relative: 'src/deep/file.txt' } }).id, good.payload.grant.id, 'a path scope covers what is under it')
    assert.equal(store.findStandingGrant({ toolName: 'workspace.write', resolved: { relative: 'src2/file.txt' } }), null, 'but not a sibling with a shared prefix')

    // The grant exists, and a credential path is still denied rather than allowed.
    const denied = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'src/.env.local', content: 'SECRET=1\n' } })
    assert.equal(denied.status, 403, 'a standing grant softens "ask", and deny still wins')
    assert.equal(denied.payload.rule, 'deny.sensitive-path')

    const mismatched = await request('DELETE', '/api/grants/standing-nope')
    assert.equal(mismatched.status, 404)
  })
})

test('an approved write lands the original bytes, not the redacted copy', async () => {
  await withServer(async ({ request, store, directory }) => {
    const project = await request('POST', '/api/projects', { name: 'write fixture' })
    const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })

    // The content is deliberately shaped like a credential. Redaction is for the
    // log and the UI; it must never change what is written, or the file a user
    // approved is not the file they get.
    const secret = 'sk-live-EXAMPLE0123456789abcd'
    const content = `API_KEY=${secret}\n`
    const requested = await request('POST', `/api/runs/${run.payload.run.id}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'config.js', content } })
    assert.equal(requested.status, 409, 'a write waits for approval in selective mode')
    const toolCall = requested.payload.toolCall
    assert.equal(toolCall.input.content.includes('[redacted:'), true, 'the copy kept for display is redacted')

    const approved = await request('POST', `/api/runs/${run.payload.run.id}/tools/${toolCall.id}/approve`, { fingerprint: toolCall.fingerprint })
    assert.equal(approved.status, 200)
    assert.equal(await readFile(path.join(directory, 'config.js'), 'utf8'), content, 'the file matches what was approved')

    assert.equal(store.getToolCallInput(toolCall.id).content, content, 'the original arguments are kept apart from the display copy')
    assert.equal(JSON.stringify(store.listEvents(run.payload.run.id)).includes(secret), false, 'the raw secret never enters the audit chain')
  })
})

test('a worker question parks, and the answer resumes it with words it can use', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-ask'
  const askPlan = JSON.stringify({
    objective: 'Ask one question.',
    tasks: [{ role: 'builder', title: 'Ask first', instructions: 'Ask before doing anything.', dependsOn: [] }],
  })
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: askPlan, toolCalls: [], usage: null }
    if (instructions.includes('Forge')) {
      if (!messages.some((message) => message.role === 'tool')) {
        return { text: 'Blocked on a decision.', toolCalls: [{ id: 'q0', name: 'run.ask', arguments: { question: 'Which color?', context: 'red or blue' } }], usage: null }
      }
      const transcript = JSON.stringify(messages)
      // The answer arrives inside a tool result, so its quotes are escaped in
      // the transcript JSON: match the escaped form, not the pretty one.
      const answer = /\\"answer\\":\\"([^"\\]+)\\"/.exec(transcript)?.[1] ?? '(none)'
      return { text: `Continuing with ${answer}.`, toolCalls: [], usage: null }
    }
    return { text: 'Scout summary.', toolCalls: [], usage: null }
  }

  try {
    await withServer(async ({ request, store }) => {
      const runId = await startRun(request)
      const pending = await waitFor(store, () => store.listToolCalls(runId).find((call) => call.status === 'approval_required'))
      assert.ok(pending, 'the question should be waiting for a human')
      assert.equal(pending.name, 'run.ask')
      assert.equal(pending.ruleId, 'ask.question', 'questions carry their own rule, in every mode')

      const approved = await request('POST', `/api/runs/${runId}/tools/${pending.id}/approve`, { fingerprint: pending.fingerprint })
      assert.equal(approved.status, 409, 'a question is answered, not approved')

      const answered = await request('POST', `/api/runs/${runId}/tools/${pending.id}/answer`, { answer: 'blue' })
      assert.equal(answered.status, 200)
      assert.equal(answered.payload.answered, true)
      assert.equal(answered.payload.toolCall.status, 'completed')

      const finished = await waitFor(store, () => (store.getRun(runId).status === 'review' ? true : null))
      assert.ok(finished, `run should finish on the answer, saw ${store.getRun(runId).status}`)
      const task = store.listTasks(runId)[0]
      assert.match(String(task.result), /Continuing with blue/, 'the worker continued on the human words')
      const completed = store.listEvents(runId).find((event) => event.type === 'tool.completed' && event.payload.toolCallId === pending.id)
      assert.equal(completed.payload.answered, true, 'the audit says this was an answer')
      assert.equal(store.verifyEventChain(runId).ok, true)
    }, { model })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})

test('declining a question releases the worker with the reason', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-decline'
  const askPlan = JSON.stringify({
    objective: 'Ask one question.',
    tasks: [{ role: 'builder', title: 'Ask first', instructions: 'Ask before doing anything.', dependsOn: [] }],
  })
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: askPlan, toolCalls: [], usage: null }
    if (instructions.includes('Forge')) {
      // Ask once: after the denial the worker must finish on its own, or the
      // run would park again on a question nobody will answer twice.
      if (!messages.some((message) => message.role === 'tool')) {
        return { text: 'Blocked.', toolCalls: [{ id: 'q0', name: 'run.ask', arguments: { question: 'Which color?' } }], usage: null }
      }
      return { text: 'Deciding alone, then.', toolCalls: [], usage: null }
    }
    return { text: 'Scout summary.', toolCalls: [], usage: null }
  }

  try {
    await withServer(async ({ request, store }) => {
      const runId = await startRun(request)
      const pending = await waitFor(store, () => store.listToolCalls(runId).find((call) => call.status === 'approval_required'))
      assert.ok(pending)
      const denied = await request('POST', `/api/runs/${runId}/tools/${pending.id}/deny`, { reason: 'You decide.' })
      assert.equal(denied.status, 200)
      assert.equal(denied.payload.resumed, true, 'declining releases the parked worker')
      const finished = await waitFor(store, () => (store.getRun(runId).status === 'review' ? true : null))
      assert.ok(finished, `run should finish after a decline, saw ${store.getRun(runId).status}`)
    }, { model })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})

test('approving with edits runs the edited arguments as a new call', async () => {
  await withServer(async ({ request, store, directory }) => {
    const project = await request('POST', '/api/projects', { name: 'edit fixture' })
    const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
    const runId = run.payload.run.id
    const requested = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'draft.txt', content: 'first version\n' } })
    assert.equal(requested.status, 409)
    const original = requested.payload.toolCall

    const edited = await request('POST', `/api/runs/${runId}/tools/${original.id}/approve`, {
      scope: 'once',
      fingerprint: original.fingerprint,
      editedInput: { path: 'draft.txt', content: 'second version\n' },
    })
    // Selective mode still asks about the edited write: an edit walks the
    // policy path like any other call instead of inheriting the old approval.
    assert.equal(edited.status, 409, JSON.stringify(edited.payload))
    assert.equal(edited.payload.edited, true, 'the response says this was an edit, not the original')
    assert.equal(edited.payload.superseded, original.id)
    assert.equal(edited.payload.approvalRequired, true)

    const parked = edited.payload.toolCall
    const approved = await request('POST', `/api/runs/${runId}/tools/${parked.id}/approve`, { fingerprint: parked.fingerprint })
    assert.equal(approved.status, 200, JSON.stringify(approved.payload))
    assert.equal(await readFile(path.join(directory, 'draft.txt'), 'utf8'), 'second version\n', 'the edited bytes are what ran')
    assert.equal(store.getToolCall(original.id).status, 'denied', 'the original is dead, not pending')
    assert.match(String(store.getToolCall(original.id).error), /Superseded/)
    const superseded = store.listEvents(runId).find((event) => event.type === 'tool.denied' && event.payload.rule === 'deny.superseded')
    assert.ok(superseded, 'the audit shows the supersede')
  })
})

test('an edit that still asks parks again instead of running', async () => {
  await withServer(async ({ request }) => {
    const project = await request('POST', '/api/projects', { name: 'edit parks fixture' })
    const run = await request('POST', `/api/runs`, { projectId: project.payload.project.id, permissionMode: 'selective' })
    const runId = run.payload.run.id
    const requested = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'a.txt', content: 'a\n' } })
    assert.equal(requested.status, 409)

    const edited = await request('POST', `/api/runs/${runId}/tools/${requested.payload.toolCall.id}/approve`, {
      scope: 'once',
      fingerprint: requested.payload.toolCall.fingerprint,
      editedInput: { path: 'b.txt', content: 'b\n' },
    })
    assert.equal(edited.status, 409, 'the edited call asks on its own merits')
    assert.equal(edited.payload.approvalRequired, true)
    assert.ok(edited.payload.toolCall, 'and the new pending call is returned')
    assert.notEqual(edited.payload.toolCall.id, requested.payload.toolCall.id, 'it is a new call, not the old one')
  })
})

test('the head review runs on a provider that has a key, not a hardcoded route', async () => {
  const previousXai = process.env.XAI_API_KEY
  const previousOpenai = process.env.OPENAI_API_KEY
  delete process.env.XAI_API_KEY
  process.env.OPENAI_API_KEY = 'sk-test-key-for-review'

  // No tool calls, so the plan finishes and the run reaches its review.
  const model = async ({ options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
    if (instructions.includes('reviewing worker outputs')) return { text: 'Review from the configured provider.', toolCalls: [], usage: null }
    return { text: 'Worker summary.', toolCalls: [], usage: null }
  }

  try {
    await withServer(async ({ request, store }) => {
      // Every role is routed at the provider that holds a key: workers resolve
      // their own role route strictly, so `head` alone would leave them refused.
      const runId = await startRun(request, { head: 'openai', research: 'openai', builder: 'openai' })
      const finished = await waitFor(store, () => (store.getRun(runId).status === 'review' ? true : null))
      assert.ok(finished, `run should reach review, saw ${store.getRun(runId).status}`)

      const review = store.listEvents(runId).find((event) => event.type === 'run.review.ready')
      assert.equal(review.payload.provider, 'openai', 'the review used the provider that holds a key')
      assert.equal(review.payload.summary, 'Review from the configured provider.')
    }, { model })
  } finally {
    if (previousXai === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousXai
    if (previousOpenai === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenai
  }
})
