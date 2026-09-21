import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { canonicalJson } from '../server/canonicalJson.mjs'
import { fetchMarketplaceIndex, verifyIndexSignature } from '../server/marketplace.mjs'
import { withServer, withTempDirectory, withWorkspace } from './helpers.mjs'

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey,
  }
}

const skillText = '# Team Postgres\n\nExpand, then contract.\n'
const pluginManifest = {
  description: 'Read text from images.',
  method: 'POST',
  url: 'https://api.ocr.space/parse/image',
  headers: {},
  args: { imageUrl: 'string' },
}

test('traversal ids cannot escape the workspace on uninstall', async () => {
  // Regression: the id once rode straight from the URL into a recursive rm.
  // If this ever regresses, outside.txt dies and the suite tells us.
  await withTempDirectory(async (outer) => {
    const workspace = path.join(outer, 'ws')
    await mkdir(path.join(workspace, 'skills'), { recursive: true })
    await writeFile(path.join(workspace, 'skills', 'keep.txt'), 'keep', 'utf8')
    await writeFile(path.join(outer, 'outside.txt'), 'do not delete', 'utf8')
    await withServer(async ({ request }) => {
      const response = await request('DELETE', '/api/marketplace/..%2f..', {})
      assert.equal(response.status, 404, JSON.stringify(response.payload))
      assert.equal(await readFile(path.join(outer, 'outside.txt'), 'utf8'), 'do not delete')
      assert.equal(await readFile(path.join(workspace, 'skills', 'keep.txt'), 'utf8'), 'keep')
    }, { workspaceRoot: workspace })
    await rm(outer, { recursive: true, force: true })
  })
})

test('signatures verify, tampering fails, entries validate strictly', () => {
  const { publicB64, privateKey } = keypair()
  const unsigned = { version: 1, generated_at: 1, entries: [] }
  const signature = sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), privateKey).toString('base64')
  assert.equal(verifyIndexSignature(canonicalJson(unsigned), signature, publicB64), true)
  assert.equal(verifyIndexSignature(canonicalJson({ ...unsigned, generated_at: 2 }), signature, publicB64), false, 'a changed byte breaks the signature')
  assert.equal(verifyIndexSignature(canonicalJson(unsigned), signature, keypair().publicB64), false, 'a different key breaks it')
})

async function withIndexServer(getBody, files, callback) {
  const server = http.createServer((request, response) => {
    if (request.url === '/index.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(getBody())
      return
    }
    const file = files[request.url]
    if (file !== undefined) {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end(file)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  try {
    return await callback(baseUrl)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function signedBody(baseUrl, privateKey, mutate = null) {
  const unsigned = {
    version: 1,
    generated_at: Date.now(),
    entries: [
      { kind: 'skill', id: 'db.moves', version: '2', sha256: sha256(skillText), url: `${baseUrl}/db.md`, description: 'Migrate safely.' },
      { kind: 'plugin', id: 'ocr', version: '1', sha256: sha256(JSON.stringify(pluginManifest)), url: `${baseUrl}/ocr.json`, description: 'Read text from images.' },
    ],
  }
  const body = mutate ? mutate(structuredClone(unsigned)) : unsigned
  const real = sign(null, Buffer.from(canonicalJson(body), 'utf8'), privateKey).toString('base64')
  return JSON.stringify({ ...body, signature: real })
}

async function withMarketplaceEnv(baseUrl, publicB64, dataDir, callback) {
  const previous = {
    url: process.env.FULKRUM_MARKETPLACE_URL,
    key: process.env.FULKRUM_MARKETPLACE_KEY,
    data: process.env.FULKRUM_DATA_DIR,
  }
  process.env.FULKRUM_MARKETPLACE_URL = `${baseUrl}/index.json`
  process.env.FULKRUM_MARKETPLACE_KEY = publicB64
  process.env.FULKRUM_DATA_DIR = dataDir
  try {
    return await callback()
  } finally {
    for (const [env, value] of [['FULKRUM_MARKETPLACE_URL', previous.url], ['FULKRUM_MARKETPLACE_KEY', previous.key], ['FULKRUM_DATA_DIR', previous.data]]) {
      if (value === undefined) delete process.env[env]
      else process.env[env] = value
    }
  }
}

test('refresh verifies before believing; a forged index is a 502, not data', async () => {
  const { publicB64, privateKey } = keypair()
  const files = { '/db.md': skillText, '/ocr.json': JSON.stringify(pluginManifest) }
  let body = ''
  await withTempDirectory(async (dataDir) => {
    await withIndexServer(() => body, files, async (baseUrl) => {
      body = signedBody(baseUrl, privateKey)
      await withMarketplaceEnv(baseUrl, publicB64, dataDir, async () => {
        const fresh = await fetchMarketplaceIndex({})
        assert.equal(fresh.entries.length, 2)
        assert.ok(fresh.fetchedAt > 0)
      })
      // Same bytes, attacker's signature: refused before parsing matters.
      body = signedBody(baseUrl, keypair().privateKey)
      await withMarketplaceEnv(baseUrl, publicB64, dataDir, async () => {
        await assert.rejects(() => fetchMarketplaceIndex({}), /does not verify/)
      })
    })
  })
})

test('install pins reviewed bytes; mismatch refuses; uninstall revokes scoped grants', async () => {
  const { publicB64, privateKey } = keypair()
  const files = { '/db.md': skillText, '/ocr.json': JSON.stringify(pluginManifest) }
  let body = ''
  await withTempDirectory(async (dataDir) => {
    await withIndexServer(() => body, files, async (baseUrl) => {
      body = signedBody(baseUrl, privateKey)
      await withMarketplaceEnv(baseUrl, publicB64, dataDir, async () => {
        await withWorkspace(async (directory) => {
          await withServer(async ({ request, store, toolBroker }) => {
            assert.equal((await request('GET', '/api/marketplace')).payload.enabled, true)
            assert.equal((await request('POST', '/api/marketplace/refresh', {})).status, 200)

            const skill = await request('POST', '/api/marketplace/db.moves', {})
            assert.equal(skill.status, 201, JSON.stringify(skill.payload))
            assert.equal(skill.payload.installed.kind, 'skill')
            assert.equal(await readFile(path.join(directory, 'skills', 'db.moves', 'SKILL.md'), 'utf8'), skillText)

            const plugin = await request('POST', '/api/marketplace/ocr', {})
            assert.equal(plugin.status, 201, JSON.stringify(plugin.payload))
            assert.deepEqual(plugin.payload.permissions.tools, ['plugin.ocr'])
            assert.deepEqual(plugin.payload.permissions.hosts, ['api.ocr.space'])
            assert.equal(toolBroker.get('plugin.ocr')?.kind, 'http', 'the installed manifest is a live tool')
            assert.equal(await readFile(path.join(directory, 'plugins', 'ocr.json'), 'utf8'), JSON.stringify(pluginManifest))

            const arsenal = await request('GET', '/api/arsenal')
            assert.ok(arsenal.payload.skills.some((entry) => entry.id === 'db.moves' && entry.version === '2'), 'installed skills report their pinned version')
            assert.ok(arsenal.payload.plugins.some((entry) => entry.id === 'ocr' && entry.version === '1'))

            // A standing grant scoped to the plugin's tool dies with it.
            await request('POST', '/api/grants', { toolName: 'plugin.ocr', scopeKind: 'host', scopeValue: 'api.ocr.space' })
            assert.equal(store.listStandingGrants().length, 1)
            const removed = await request('DELETE', '/api/marketplace/ocr', {})
            assert.equal(removed.status, 200)
            assert.deepEqual(removed.payload.revokedGrants.length, 1)
            assert.equal(store.listStandingGrants().length, 0)
            const after = await request('GET', '/api/arsenal')
            assert.equal(after.payload.plugins.some((entry) => entry.id === 'ocr'), false)

            assert.equal((await request('POST', '/api/marketplace/entry-nope', {})).status, 404)
          }, { workspaceRoot: directory })
        })
      })
    })
  })
})

test('a playbook pins its skills, and drifted knowledge refuses like a drifted plan', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-pins'
  const planJson = JSON.stringify({
    objective: 'Prove skill pins.',
    tasks: [{ role: 'research', title: 'Map', instructions: 'Report.', dependsOn: [] }],
  })
  const evidenceBlock = '```evidence\n' + JSON.stringify({
    summary: 'Mapped.',
    findings: [{ claim: 'Done.', path: 'README.md', startLine: 1 }],
    artifacts: [],
    tests: [],
    openQuestions: [],
  }) + '\n```'
  const model = async ({ options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
    if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) {
      return { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }
    }
    return { text: `Mapped.\n${evidenceBlock}`, toolCalls: [], usage: null }
  }
  try {
    await withWorkspace(async (directory) => {
      await mkdir(path.join(directory, 'skills', 'db.moves'), { recursive: true })
      await writeFile(path.join(directory, 'skills', 'db.moves', 'SKILL.md'), skillText, 'utf8')
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'pins fixture' })
        const projectId = project.payload.project.id
        const run = await request('POST', '/api/runs', { projectId, permissionMode: 'autopilot' })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Prove skill pins.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
        const deadline = Date.now() + 12_000
        while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(store.getRun(runId).status, 'review')

        const pins = [{ id: 'db.moves', sha256: sha256(skillText) }]
        const saved = await request('POST', `/api/projects/${projectId}/playbooks`, { name: 'pinned', runId, skills: pins })
        assert.equal(saved.status, 201, JSON.stringify(saved.payload))
        assert.deepEqual(saved.payload.playbook.skills, pins)

        // Pinning what is not installed as given is refused at save time.
        const badPin = await request('POST', `/api/projects/${projectId}/playbooks`, { name: 'bad', runId, skills: [{ id: 'db.moves', sha256: '0'.repeat(64) }] })
        assert.equal(badPin.status, 400)

        const started = await request('POST', `/api/projects/${projectId}/playbooks/${saved.payload.playbook.id}/runs`, { permissionMode: 'autopilot' })
        assert.equal(started.status, 201, JSON.stringify(started.payload))

        // Edit the skill behind the playbook's back: the next run refuses.
        await writeFile(path.join(directory, 'skills', 'db.moves', 'SKILL.md'), '# Edited.\n', 'utf8')
        const refused = await request('POST', `/api/projects/${projectId}/playbooks/${saved.payload.playbook.id}/runs`, { permissionMode: 'autopilot' })
        assert.equal(refused.status, 409, JSON.stringify(refused.payload))
        assert.match(String(refused.payload.error), /db\.moves/)
      }, { model, workspaceRoot: directory })
    })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})

test('bytes that differ from the signed hash refuse instead of installing', async () => {
  const { publicB64, privateKey } = keypair()
  // The index signs the honest bytes, but the server hands over others.
  const files = { '/db.md': '# Tampered.\n' }
  let body = ''
  await withTempDirectory(async (dataDir) => {
    await withIndexServer(() => body, files, async (baseUrl) => {
      body = signedBody(baseUrl, privateKey)
      await withMarketplaceEnv(baseUrl, publicB64, dataDir, async () => {
        await withWorkspace(async (directory) => {
          await withServer(async ({ request }) => {
            await request('POST', '/api/marketplace/refresh', {})
            const refused = await request('POST', '/api/marketplace/db.moves', {})
            assert.equal(refused.status, 400, JSON.stringify(refused.payload))
            assert.match(String(refused.payload.error), /Checksum mismatch/)
          }, { workspaceRoot: directory })
        })
      })
    })
  })
})
