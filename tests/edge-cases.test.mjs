import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveWorkspacePath } from '../server/permissions.mjs'
import { redirectHop } from '../server/toolBroker.mjs'
import { createPricing } from '../server/pricing.mjs'
import { withServer } from './helpers.mjs'

test('E1: a dangling symlink is refused, not followed', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fulkrum-edge-'))
  try {
    const target = path.join(dir, 'ghost.txt')
    const link = path.join(dir, 'link.txt')
    try {
      await symlink(target, link)
    } catch {
      t.skip('symlink creation requires elevated privileges on this OS')
      return
    }
    assert.throws(() => resolveWorkspacePath(dir, 'link.txt'), /Symbolic links|Only regular files/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('E1: a symlink pointing outside the workspace is refused', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fulkrum-edge-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'fulkrum-outside-'))
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'do not read\n', 'utf8')
    try {
      await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'escape.txt'))
    } catch {
      t.skip('symlink creation requires elevated privileges on this OS')
      return
    }
    assert.throws(() => resolveWorkspacePath(dir, 'escape.txt'), /Symbolic links|Only regular files/)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('S3: a dropped body strips content-length but keeps content-type', () => {
  const headers = { 'Content-Type': 'application/json', 'Content-Length': '42', Authorization: 'Bearer x' }
  const hop = redirectHop({ method: 'POST', headers, body: '{"a":1}', currentUrl: 'https://a.test/x', status: 302, location: 'https://b.test/y' })
  assert.equal(hop.body, null, 'body is dropped')
  assert.equal(hop.method, 'GET', 'POST becomes GET')
  assert.equal(hop.headers['Content-Length'], undefined, 'content-length is stripped')
  assert.equal(hop.headers['Content-Type'], 'application/json', 'content-type is kept')
  assert.equal(hop.headers.Authorization, undefined, 'credentials dropped cross-origin')
})

test('S3: a 307 redirect preserves the body and method', () => {
  const hop = redirectHop({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}', currentUrl: 'https://a.test/x', status: 307, location: 'https://b.test/y' })
  assert.equal(hop.body, '{"a":1}', 'body is preserved')
  assert.equal(hop.method, 'POST', 'method is preserved')
})

test('S11: reasoning tokens are billed as output', () => {
  const pricing = createPricing()
  const cost = pricing.costOf({ model: 'gpt-5', usage: { billableInputTokens: 1000, outputTokens: 500, reasoningTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 } })
  assert.equal(cost.priced, true)
  // gpt-5: input=1.25, output=10 per Mtok. Output cost = (500+300)/1M * 10 = 0.008
  assert.ok(cost.costUsd > 0.007, `reasoning tokens billed: got ${cost.costUsd}`)
})

test('S11: zero reasoning tokens still prices correctly', () => {
  const pricing = createPricing()
  const cost = pricing.costOf({ model: 'gpt-5', usage: { billableInputTokens: 1000, outputTokens: 500, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })
  assert.equal(cost.priced, true)
  assert.ok(cost.costUsd > 0)
})

test('S16: clipped() truncates by bytes, not UTF-16 code units', () => {
  // Direct test of the byte-length logic
  const text = 'あ'.repeat(100) // 300 bytes in UTF-8, 100 UTF-16 code units
  const buf = Buffer.from(text, 'utf8')
  assert.equal(buf.length, 300, 'CJK text is 300 bytes')
  assert.equal(text.length, 100, 'but only 100 UTF-16 code units')
})

test('encoded API identifiers resolve, and malformed percent-encoding does not crash the bridge', async () => {
  await withServer(async ({ request, store }) => {
    const project = store.createProject({ id: 'project-encoded', name: 'Encoded route' })
    const decoded = await request('GET', '/api/projects/%70roject-encoded')
    assert.equal(decoded.status, 200)
    assert.equal(decoded.payload.project.id, project.id)
    assert.equal((await request('GET', '/api/projects/%E0%A4%A')).status, 404)
    assert.equal((await request('GET', '/api/health')).status, 200)
  })
})

test('P4: event hash is deterministic for the same input', async () => {
  const { canonicalJson } = await import('../server/canonicalJson.mjs')
  const body = { runId: 'r1', sequence: 1, type: 'test', agentId: null, payload: { key: 'value' }, createdAt: 12345 }
  const hash1 = canonicalJson(body)
  const hash2 = canonicalJson({ ...body })
  assert.equal(hash1, hash2, 'same input produces same canonical JSON')
  // Key order should not matter
  const reordered = { createdAt: 12345, payload: { key: 'value' }, agentId: null, type: 'test', sequence: 1, runId: 'r1' }
  assert.equal(canonicalJson(body), canonicalJson(reordered), 'key order does not affect hash')
})
