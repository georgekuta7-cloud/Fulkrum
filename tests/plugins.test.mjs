import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { decidePermission, fingerprintToolCall, resolveToolCall } from '../server/permissions.mjs'
import { isToolAllowedForRole, validateToolArguments } from '../server/tools.mjs'
import { FulkrumToolBroker } from '../server/toolBroker.mjs'
import { loadPluginManifests, pluginToolDefinitions, validatePluginManifest } from '../server/plugins.mjs'
import { withServer, withWorkspace } from './helpers.mjs'

const goodManifest = {
  description: 'Read text from an image URL.',
  method: 'POST',
  url: 'https://api.ocr.space/parse/image',
  headers: { 'x-client': 'fulkrum-test' },
  args: { imageUrl: 'string', language: 'string' },
  roles: ['builder'],
}

test('a manifest is validated field by field, and private targets never load', () => {
  assert.equal(validatePluginManifest('image.ocr', goodManifest).ok, true)

  const badName = validatePluginManifest('Nope!', goodManifest)
  assert.equal(badName.ok, false)

  const badMethod = validatePluginManifest('image.ocr', { ...goodManifest, method: 'BREW' })
  assert.ok(badMethod.problems.some((problem) => problem.includes('method')))

  for (const url of ['http://127.0.0.1/x', 'https://10.0.0.5/', 'http://localhost:9/', 'ftp://x.test/']) {
    const rejected = validatePluginManifest('image.ocr', { ...goodManifest, url })
    assert.equal(rejected.ok, false, `${url} must not load`)
  }

  const secretArgs = validatePluginManifest('image.ocr', { ...goodManifest, args: { imageUrl: 'number' } })
  assert.equal(secretArgs.ok, false, 'v1 supports string arguments only')

  const badRoles = validatePluginManifest('image.ocr', { ...goodManifest, roles: ['head'] })
  assert.equal(badRoles.ok, false, 'only worker roles are castable')

  const minimal = validatePluginManifest('ping', { description: 'Ping.', method: 'GET', url: 'https://example.com/ping' })
  assert.equal(minimal.ok, true)
  assert.deepEqual(minimal.plugin.roles, ['research', 'builder'], 'roles default to both workers')
  assert.deepEqual(minimal.plugin.args, [])
})

test('manifests load from the plugins folder; broken ones are skipped, never fatal', async () => {
  await withWorkspace(async (directory) => {
    await mkdir(path.join(directory, 'plugins'), { recursive: true })
    await writeFile(path.join(directory, 'plugins', 'ocr.json'), JSON.stringify({ ...goodManifest, name: 'ignored-outside' }), 'utf8')
    await writeFile(path.join(directory, 'plugins', 'broken.json'), '{not json', 'utf8')
    await writeFile(path.join(directory, 'plugins', 'evil.json'), JSON.stringify({ ...goodManifest, url: 'http://127.0.0.1/x' }), 'utf8')
    await writeFile(path.join(directory, 'plugins', 'notes.txt'), 'not a manifest', 'utf8')

    const broker = new FulkrumToolBroker({ workspaceRoot: directory })
    const { plugins, problems } = loadPluginManifests(directory)
    assert.equal(plugins.length, 1)
    assert.equal(plugins[0].toolName, 'plugin.ocr')
    assert.equal(problems.length, 2, 'broken JSON and the private URL are reported')
    assert.ok(broker.get('plugin.ocr')?.kind === 'http', 'the broker describes plugin tools as http')
    assert.equal(broker.get('plugin.nope'), null)
  })
})

test('plugin tools are described only to the roles their manifests name', () => {
  const { plugins } = { plugins: [validatePluginManifest('ocr', goodManifest).plugin] }
  assert.deepEqual(pluginToolDefinitions(plugins, { agentId: 'builder' }).map((tool) => tool.name), ['plugin.ocr'])
  assert.deepEqual(pluginToolDefinitions(plugins, { agentId: 'research' }), [])
  assert.equal(isToolAllowedForRole({ tools: ['workspace.read'] }, 'plugin.ocr', ['plugin.ocr']), true)
  assert.equal(isToolAllowedForRole({ tools: ['workspace.read'] }, 'plugin.ocr'), false)
  assert.equal(validateToolArguments('plugin.ocr', { imageUrl: 'x' }, plugins).ok, true)
  assert.equal(validateToolArguments('plugin.ocr', { imageUrl: 'x', injected: 'y' }, plugins).ok, false, 'undeclared arguments do not pass')
  assert.equal(validateToolArguments('plugin.nope', {}, plugins).ok, false)
})

test('resolution binds the fixed destination, and the fingerprint commits to it', async () => {
  await withWorkspace(async (directory) => {
    await mkdir(path.join(directory, 'plugins'), { recursive: true })
    await writeFile(path.join(directory, 'plugins', 'ocr.json'), JSON.stringify(goodManifest), 'utf8')

    const resolved = resolveToolCall({ name: 'plugin.ocr', input: { imageUrl: 'https://x.test/i.png', language: 'en', injected: 'drop' }, workspaceRoot: directory })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.resolved.url, 'https://api.ocr.space/parse/image')
    assert.equal(resolved.resolved.host, 'api.ocr.space')
    assert.deepEqual(resolved.resolved.args, { imageUrl: 'https://x.test/i.png', language: 'en' }, 'the model steers values, never destinations')
    assert.deepEqual(resolved.resolved.headerNames, ['x-client'])

    const fingerprint = fingerprintToolCall(resolved)
    assert.match(fingerprint, /^[0-9a-f]{64}$/)
    // The approval shows the destination, and the matrix sees an http call:
    // a POST parks in selective mode exactly like http.request would.
    const decision = decidePermission({ mode: 'selective', tool: { kind: 'http' }, resolution: resolved, httpAllowlist: [] })
    assert.equal(decision.decision, 'ask')
    assert.equal(decision.requiresApproval, true)

    const moved = resolveToolCall({ name: 'plugin.ocr', input: { imageUrl: 'https://y.test/i.png' }, workspaceRoot: directory })
    assert.notEqual(fingerprintToolCall(moved), fingerprint, 'different values, different fingerprint')
  })
})

test('skills.find returns matching packs and plugin tools in one answer', async () => {
  await withWorkspace(async (directory) => {
    await mkdir(path.join(directory, 'skills', 'db'), { recursive: true })
    await writeFile(path.join(directory, 'skills', 'db', 'SKILL.md'), '---\ntriggers: postgres, migrate\n---\nExpand, then contract.\n', 'utf8')
    await mkdir(path.join(directory, 'plugins'), { recursive: true })
    await writeFile(path.join(directory, 'plugins', 'ocr.json'), JSON.stringify(goodManifest), 'utf8')

    const broker = new FulkrumToolBroker({ workspaceRoot: directory })
    const found = await broker.execute('skills.find', { query: 'read text from screenshots with ocr' })
    assert.ok(found.plugins.some((plugin) => plugin.tool === 'plugin.ocr'), 'the plugin matches by description')
    assert.equal(found.plugins[0].tool, 'plugin.ocr')

    const skilled = await broker.execute('skills.find', { query: 'postgres migration help' })
    assert.ok(skilled.skills.some((skill) => skill.name === 'db'), 'the pack matches by trigger')
    assert.match(skilled.skills[0].content, /Expand, then contract/)

    const empty = await broker.execute('skills.find', { query: 'quantum knitting patterns' })
    assert.deepEqual(empty.skills, [])
    assert.deepEqual(empty.plugins, [])
  })
})

test('a worker can call a plugin tool end to end, approved once, executed once', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-plugins'
  const seen = []
  const httpRequest = async (url, { method, headers, body }) => {
    seen.push({ url, method, headers, body })
    return { status: 200, ok: true, headers: {}, text: '{"text":"screenshot says hi"}', bytes: 24 }
  }
  const planJson = JSON.stringify({
    objective: 'Prove plugins run.',
    tasks: [{ role: 'builder', title: 'Read the screenshot', instructions: 'OCR the image.', dependsOn: [] }],
  })
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
    if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) {
      return { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }
    }
    if (!messages.some((message) => message.role === 'tool')) {
      // Declared arguments only: undeclared ones are rejected with a typed
      // error (see the validation test), never silently dropped here.
      return { text: 'Reading it.', toolCalls: [{ id: 'p1', name: 'plugin.ocr', arguments: { imageUrl: 'https://x.test/i.png', language: 'en' } }], usage: null }
    }
    return { text: 'Read it.', toolCalls: [], usage: null }
  }
  try {
    await withWorkspace(async (directory) => {
      await mkdir(path.join(directory, 'plugins'), { recursive: true })
      await writeFile(path.join(directory, 'plugins', 'ocr.json'), JSON.stringify(goodManifest), 'utf8')
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'plugins fixture' })
        const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Prove plugins run.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

        // The plugin call parks like any consequential call, showing the fixed URL.
        const deadline = Date.now() + 10_000
        let pending = null
        while (Date.now() < deadline && !pending) {
          pending = store.listToolCalls(runId).find((call) => call.status === 'approval_required') ?? null
          if (!pending) await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.ok(pending, 'the plugin call parks for approval')
        assert.equal(pending.name, 'plugin.ocr')
        assert.match(String(pending.resolved?.url ?? ''), /api\.ocr\.space/, 'the approval shows the manifest destination, not model text')

        const approved = await request('POST', `/api/runs/${runId}/tools/${pending.id}/approve`, {})
        assert.equal(approved.status, 200, JSON.stringify(approved.payload))

        const done = Date.now() + 10_000
        while (Date.now() < done && !['review', 'failed'].includes(store.getRun(runId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(store.getRun(runId).status, 'review')

        assert.equal(seen.length, 1, 'the manifest executed exactly once')
        assert.equal(seen[0].url, 'https://api.ocr.space/parse/image')
        assert.equal(seen[0].method, 'POST')
        assert.equal(seen[0].headers['x-client'], 'fulkrum-test')
        assert.deepEqual(JSON.parse(seen[0].body), { imageUrl: 'https://x.test/i.png', language: 'en' }, 'declared args travel, undeclared args do not')
        assert.equal(store.verifyEventChain(runId).ok, true)
      }, { model, httpRequest, workspaceRoot: directory })
    })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})
