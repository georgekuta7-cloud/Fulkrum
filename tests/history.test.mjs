import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { withServer, withTempDirectory } from './helpers.mjs'

/** Two runs in one project, so history and forking have something to look at. */
async function twoRuns(request, { permissionMode = 'autopilot' } = {}) {
  const project = await request('POST', '/api/projects', { name: 'history fixture' })
  const projectId = project.payload.project.id
  const first = await request('POST', '/api/runs', { projectId, permissionMode })
  const second = await request('POST', '/api/runs', { projectId, permissionMode })
  return { projectId, first: first.payload.run.id, second: second.payload.run.id }
}

test('run history reports each run with what it cost and changed', async () => {
  await withTempDirectory(async (directory) => {
    await withServer(async ({ request, store }) => {
      const { projectId, first, second } = await twoRuns(request)
      await request('POST', `/api/runs/${first}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'one.txt', content: 'first\n' } })
      store.recordModelCall({ runId: first, role: 'head', provider: 'grok', model: 'grok-4', usage: { inputTokens: 10, outputTokens: 5 }, cost: { costUsd: 0.01, priced: true, version: 'test' } })
      await request('POST', `/api/runs/${second}/control`, { action: 'cancel' })

      const all = await request('GET', `/api/runs?projectId=${encodeURIComponent(projectId)}`)
      assert.equal(all.status, 200)
      assert.equal(all.payload.runs.length, 2, 'newest first')
      const written = all.payload.runs.find((run) => run.id === first)
      assert.equal(written.spend.costUsd, 0.01)
      assert.equal(written.spend.calls, 1)
      assert.equal(written.writes, 1, 'a completed write is counted')
      assert.equal(written.taskCount, 0)

      // Active runs across every project, which is what a supervisor view needs.
      const active = await request('GET', '/api/runs?active=1')
      assert.equal(active.payload.runs.some((run) => run.id === first), true, 'a planning run is active')
      assert.equal(active.payload.runs.some((run) => run.id === second), false, 'a cancelled run is not')

      const cancelled = await request('GET', '/api/runs?status=cancelled')
      assert.deepEqual(cancelled.payload.runs.map((run) => run.id), [second])

      // The history is queryable, not just listable.
      const stored = store.listRuns({ projectId })
      assert.equal(stored[0].spend.costUsd, 0, 'the second run spent nothing')
    }, { workspaceRoot: directory })
  })
})

test('a fork re-runs a plan under its own approval', async () => {
  await withTempDirectory(async (directory) => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'fork fixture' })
      const projectId = project.payload.project.id
      const source = await request('POST', '/api/runs', { projectId, permissionMode: 'autopilot' })
      const sourceRunId = source.payload.run.id
      await request('POST', '/api/chat', { projectId, runId: sourceRunId, message: 'Write the release notes.', history: [] })
      const drafted = await request('POST', `/api/runs/${sourceRunId}/plan`, {})
      await request('POST', `/api/runs/${sourceRunId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

      const fork = await request('POST', `/api/runs/${sourceRunId}/fork`, { permissionMode: 'selective' })
      assert.equal(fork.status, 201, JSON.stringify(fork.payload))
      const forkedRunId = fork.payload.run.id
      assert.notEqual(forkedRunId, sourceRunId)
      assert.equal(fork.payload.run.status, 'planning', 'a fork starts before its own approval')
      assert.equal(fork.payload.run.permissionMode, 'selective', 'and can run under different permissions')
      assert.equal(fork.payload.plan.plan.objective, drafted.payload.plan.objective, 'the same objective')
      assert.equal(fork.payload.plan.plan.status, 'draft', 'as a fresh draft, not an approved copy')
      assert.equal(fork.payload.plan.tasks.length, drafted.payload.tasks.length)

      const messages = store.listMessages(forkedRunId)
      assert.equal(messages.some((message) => message.role === 'user' && message.content === 'Write the release notes.'), true, 'the direction travels with it')
      assert.equal(store.listEvents(forkedRunId).some((event) => event.type === 'run.forked' && event.payload.from === sourceRunId), true)

      // The old approval does not carry over: the fork has to be approved itself.
      const stale = await request('POST', `/api/runs/${forkedRunId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
      assert.equal(stale.status, 409, 'the original plan belongs to the original run')

      const fresh = await request('POST', `/api/runs/${forkedRunId}/control`, { action: 'approve-plan', planId: fork.payload.plan.plan.id, planHash: fork.payload.plan.plan.contentHash, routing: {} })
      assert.equal(fresh.status, 200, JSON.stringify(fresh.payload))

      const missing = await request('POST', '/api/runs/run-nope/fork')
      assert.equal(missing.status, 404)
    }, { workspaceRoot: directory })
  })
})

test('search finds messages and events, and treats a wildcard as a character', async () => {
  await withTempDirectory(async (directory) => {
    await withServer(async ({ request, store }) => {
      const { projectId, first } = await twoRuns(request, { permissionMode: 'selective' })
      store.appendMessage({ projectId, runId: first, role: 'user', content: 'Please migrate the database to Postgres.' })
      store.appendMessage({ projectId, runId: first, role: 'assistant', content: 'I would keep the database local: SQLite covers 100% of installs.' })
      store.appendEvent({ runId: first, type: 'plan.drafted', payload: { objective: 'Migrate the database schema' } })

      const found = await request('GET', `/api/search?q=${encodeURIComponent('database')}`)
      assert.equal(found.status, 200)
      assert.equal(found.payload.messages.length, 2, 'both sides of the conversation match')
      assert.equal(found.payload.events.length, 1, 'and so does the plan event')
      assert.match(found.payload.events[0].type, /plan\.drafted/)
      assert.match(found.payload.messages.find((message) => message.role === 'user').snippet, /migrate the database to Postgres/i)

      // A long message is windowed around the match rather than returned whole.
      store.appendMessage({ projectId, runId: first, role: 'assistant', content: `${'x'.repeat(400)} keyword ${'y'.repeat(400)}` })
      const windowed = await request('GET', '/api/search?q=keyword')
      assert.equal(windowed.payload.messages.length, 1)
      assert.equal(windowed.payload.messages[0].snippet.length < 200, true, 'the snippet is a window, not the whole message')
      assert.match(windowed.payload.messages[0].snippet, /keyword/)
      assert.match(windowed.payload.messages[0].snippet, /^….*…$/, 'with the omitted parts marked')

      // A percent sign is a character, not "match anything".
      const percent = await request('GET', `/api/search?q=${encodeURIComponent('100%')}`)
      assert.equal(percent.payload.messages.length, 1, 'only the message that literally contains 100%')
      const wildcard = await request('GET', `/api/search?q=${encodeURIComponent('100_')}`)
      assert.equal(wildcard.payload.messages.length, 0, 'an underscore is not "any character" either')

      const scoped = await request('GET', `/api/search?q=database&projectId=${encodeURIComponent('project-nope')}`)
      assert.equal(scoped.payload.messages.length, 0, 'a project filter is applied')

      const empty = await request('GET', '/api/search?q=')
      assert.equal(empty.status, 400)
    }, { workspaceRoot: directory })
  })
})

test('the workspace tree shows what a tool would see, and nothing it would not', async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, 'src'), { recursive: true })
    await mkdir(path.join(directory, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(path.join(directory, 'README.md'), '# hi\n', 'utf8')
    await writeFile(path.join(directory, 'src', 'app.js'), 'console.log(1)\n', 'utf8')
    await writeFile(path.join(directory, '.env.local'), 'SECRET=1\n', 'utf8')
    await writeFile(path.join(directory, '.fulkrumignore'), 'ignored/\n', 'utf8')
    await mkdir(path.join(directory, 'ignored'), { recursive: true })
    await writeFile(path.join(directory, 'ignored', 'note.txt'), 'nothing\n', 'utf8')

    await withServer(async ({ request }) => {
      const tree = await request('GET', '/api/workspace/tree?depth=2')
      assert.equal(tree.status, 200)
      const byName = Object.fromEntries(tree.payload.entries.map((entry) => [entry.name, entry]))
      assert.equal(byName['src'].kind, 'directory')
      assert.equal(byName['src'].children[0].name, 'app.js')
      assert.equal(byName['src'].children[0].bytes > 0, true)
      assert.equal(byName['README.md'].kind, 'file')
      assert.equal(byName['node_modules'].kind, 'skipped', 'a skipped directory is named, not descended into')
      assert.equal(byName['.env.local'].kind, 'sensitive', 'a credential file is marked, not read')
      assert.equal(byName['ignored'].kind, 'skipped', 'and .fulkrumignore is honoured')
      assert.equal(JSON.stringify(tree.payload).includes('SECRET=1'), false, 'no file contents are returned')

      const outside = await request('GET', `/api/workspace/tree?path=${encodeURIComponent('../')}`)
      assert.equal(outside.status, 400)
      assert.match(String(outside.payload.error), /inside the Fulkrum workspace/)
    }, { workspaceRoot: directory })
  })
})

test('a file history spans runs', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, 'shared.txt'), 'first version\n', 'utf8')
    await withServer(async ({ request }) => {
      const { first, second } = await twoRuns(request)
      await request('POST', `/api/runs/${first}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'shared.txt', content: 'from the first run\n' } })
      await request('POST', `/api/runs/${second}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'shared.txt', content: 'from the second run\n' } })
      await request('POST', `/api/runs/${second}/tools`, { name: 'workspace.read', agentId: 'research', input: { path: 'shared.txt' } })

      const history = await request('GET', `/api/workspace/history?path=${encodeURIComponent('shared.txt')}`)
      assert.equal(history.status, 200)
      assert.equal(history.payload.calls.length, 3, 'two writes and a read')
      const runIds = new Set(history.payload.calls.map((call) => call.runId))
      assert.equal(runIds.size, 2, 'across both runs')
      assert.equal(history.payload.calls.filter((call) => call.kind === 'write').length, 2)

      const other = await request('GET', `/api/workspace/history?path=${encodeURIComponent('never-touched.txt')}`)
      assert.deepEqual(other.payload.calls, [])

      const missing = await request('GET', '/api/workspace/history')
      assert.equal(missing.status, 400)
    }, { workspaceRoot: directory })
  })
})
