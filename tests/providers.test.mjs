import assert from 'node:assert/strict'
import test from 'node:test'
import { providerAuthHeaders } from '../server/modelCall.mjs'
import { createProviderRegistry } from '../server/providerRegistry.mjs'
import { withServer, withStore } from './helpers.mjs'

/**
 * Every provider test below stays off the network two ways: the base URL is an IP
 * literal (so nothing has to resolve a name) and `fetch` is replaced. Only the
 * provider's own hosts are intercepted — the test harness talks to the bridge
 * through the same global fetch, so everything else passes straight through.
 */
function stubFetch(providerHosts, handler) {
  const original = globalThis.fetch
  const calls = /** @type {Array<{ url: string, method: string, headers: any, body: any }>} */ ([])
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    if (!providerHosts.some((host) => target.includes(`//${host}`))) return original(url, options)
    calls.push({ url: target, method: String(options.method ?? 'GET'), headers: options.headers ?? {}, body: options.body ? JSON.parse(String(options.body)) : null })
    return handler(calls.length, url, options)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

async function makeRun(request) {
  const project = await request('POST', '/api/projects', { name: 'provider fixture' })
  const run = await request('POST', '/api/runs', { projectId: project.payload.project.id })
  return { projectId: project.payload.project.id, runId: run.payload.run.id }
}

test('auth headers follow the configured style, not only the protocol', () => {
  assert.equal(providerAuthHeaders('openai-compatible', { key: 'k', style: 'auto' }).Authorization, 'Bearer k')
  assert.equal(providerAuthHeaders('anthropic', { key: 'k', style: 'auto' })['x-api-key'], 'k')
  assert.equal(providerAuthHeaders('anthropic', { key: 'k', style: 'auto' })['anthropic-version'], '2023-06-01')
  assert.equal(providerAuthHeaders('openai-compatible', { key: 'k', style: 'api-key' })['api-key'], 'k', 'Azure style')
  assert.equal(providerAuthHeaders('openai-compatible', { key: 'k', style: 'x-api-key' })['x-api-key'], 'k')
  assert.equal(providerAuthHeaders('openai-compatible', { key: 'k', style: 'header', headerName: 'X-Token' })['X-Token'], 'k')

  const anonymous = providerAuthHeaders('openai-compatible', { style: 'none' })
  assert.deepEqual(Object.keys(anonymous), [], 'an endpoint that needs no key gets no auth header')

  const extra = providerAuthHeaders('openai-compatible', { key: 'k', style: 'bearer', headers: { 'HTTP-Referer': 'https://app.example' } })
  assert.equal(extra['HTTP-Referer'], 'https://app.example', 'configured extra headers are sent')

  const noDisplacement = providerAuthHeaders('openai-compatible', { key: 'k', style: 'bearer', headers: { Authorization: 'Bearer attacker' } })
  assert.equal(noDisplacement.Authorization, 'Bearer k', 'an extra header cannot displace the credential')
})

test('sampling parameters follow the model, not one hardcoded default', async () => {
  await withStore(async (store) => {
    const registry = createProviderRegistry(store)

    // Reasoning models answer 400 to any temperature of their own choosing, which
    // is exactly how the default OpenAI model failed on every call.
    assert.equal(registry.sampling(registry.resolve('OpenAI'), 'gpt-5').temperature, undefined)
    assert.equal(registry.sampling(registry.resolve('OpenAI'), 'gpt-5-mini').temperature, undefined)
    assert.equal(registry.sampling(registry.resolve('OpenAI'), 'gpt-4o').temperature, 0.3)
    assert.equal(registry.sampling(registry.resolve('Grok'), 'grok-4').temperature, 0.3)
    assert.equal(registry.sampling(registry.resolve('Anthropic'), 'claude-opus-4-1').temperature, undefined, 'the Claude builder never sent one')

    // A number set by the user wins; "omit" means omit, whatever the model is.
    registry.updateSettings('openai', { temperature: '0.9' })
    assert.equal(registry.sampling(registry.resolve('OpenAI'), 'gpt-5').temperature, 0.9)
    registry.updateSettings('openai', { temperature: 'omit' })
    assert.equal(registry.sampling(registry.resolve('OpenAI'), 'gpt-4o').temperature, undefined)

    assert.throws(() => registry.updateSettings('openai', { temperature: 'warm' }), /Temperature must be/)
    assert.throws(() => registry.updateSettings('openai', { authStyle: 'telepathy' }), /Auth style must be/)
    assert.throws(() => registry.updateSettings('openai', { headers: { 'bad header': 'x' } }), /not a valid header name/)
    assert.throws(() => registry.updateSettings('openai', { authStyle: 'header' }), /header name/)
  })
})

test('a key entered in the UI is stored, used, and never handed back', async () => {
  await withServer(async ({ request }) => {
    const created = await request('POST', '/api/providers', { label: 'My gateway', baseUrl: 'https://93.184.216.34/v1', model: 'mystery-1', apiKey: 'sk-my-secret-value' })
    assert.equal(created.status, 201, JSON.stringify(created.payload))
    assert.equal(created.payload.provider.hasKey, true)
    assert.equal(created.payload.provider.keySource, 'stored')
    assert.equal(created.payload.provider.configured, true)

    const listed = await request('GET', '/api/providers')
    assert.equal(JSON.stringify(listed.payload).includes('sk-my-secret-value'), false, 'the key is never serialized back')

    // An environment variable still works, and is reported as its source.
    const previous = process.env.FULKRUM_TEST_PROVIDER_KEY
    process.env.FULKRUM_TEST_PROVIDER_KEY = 'sk-from-the-environment'
    try {
      await request('POST', '/api/providers', { label: 'From env', baseUrl: 'https://93.184.216.34/v1', model: 'mystery-2', envKey: 'FULKRUM_TEST_PROVIDER_KEY' })
      const withEnv = (await request('GET', '/api/providers')).payload.providers.find((item) => item.label === 'From env')
      assert.equal(withEnv.keySource, 'env')
      assert.equal(withEnv.hasKey, true)
      assert.equal(JSON.stringify(withEnv).includes('sk-from-the-environment'), false, 'an environment key is not returned either')
    } finally {
      if (previous === undefined) delete process.env.FULKRUM_TEST_PROVIDER_KEY
      else process.env.FULKRUM_TEST_PROVIDER_KEY = previous
    }
  })
})

test('a loopback endpoint is refused until local access is enabled for it', async () => {
  const stub = stubFetch(['127.0.0.1:1234'], () => json({ choices: [{ message: { content: 'hello from the local server' } }] }))
  try {
    await withServer(async ({ request }) => {
      const { projectId, runId } = await makeRun(request)
      const created = await request('POST', '/api/providers', { label: 'Local box', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-1', authStyle: 'none' })
      assert.equal(created.status, 201, JSON.stringify(created.payload))
      assert.equal(created.payload.provider.configured, true, 'an endpoint that needs no key is still configured')

      const blocked = await request('POST', '/api/chat', { projectId, runId, routing: { head: 'Local box · local-1' }, message: 'hello', history: [] })
      assert.equal(blocked.status, 502)
      assert.match(String(blocked.payload.error), /Private and local network/)

      const patched = await request('PATCH', `/api/providers/${created.payload.provider.id}`, { allowPrivate: true })
      assert.equal(patched.status, 200, JSON.stringify(patched.payload))
      assert.equal(patched.payload.provider.allowPrivate, true)

      const allowed = await request('POST', '/api/chat', { projectId, runId, routing: { head: 'Local box · local-1' }, message: 'hello', history: [] })
      assert.equal(allowed.status, 200, JSON.stringify(allowed.payload))
      assert.equal(allowed.payload.reply, 'hello from the local server')

      assert.equal(stub.calls[0].url, 'http://127.0.0.1:1234/v1/chat/completions')
      assert.equal(stub.calls[0].body.model, 'local-1')
      assert.equal(stub.calls[0].headers.Authorization, undefined, 'no credential header for an endpoint that takes none')
    }, { realModelCall: true })
  } finally {
    stub.restore()
  }
})

test('a rejected temperature is retried without it, then remembered', async () => {
  const stub = stubFetch(['93.184.216.34'], (index) => index === 1
    ? json({ error: { message: 'Unsupported value: temperature is not supported with this model' } }, 400)
    : json({ choices: [{ message: { content: 'second attempt worked' } }] }))
  try {
    await withServer(async ({ request }) => {
      const { projectId, runId } = await makeRun(request)
      await request('POST', '/api/providers', { label: 'Picky', baseUrl: 'https://93.184.216.34/v1', model: 'mystery-2', apiKey: 'sk-picky' })

      const first = await request('POST', '/api/chat', { projectId, runId, routing: { head: 'Picky · mystery-2' }, message: 'hello', history: [] })
      assert.equal(first.status, 200, JSON.stringify(first.payload))
      assert.equal(first.payload.reply, 'second attempt worked')
      assert.equal(stub.calls.length, 2, 'one rejected call, then one retry')
      assert.equal(stub.calls[0].body.temperature, 0.3)
      assert.equal('temperature' in stub.calls[1].body, false, 'the retry omits temperature')

      const provider = (await request('GET', '/api/providers')).payload.providers.find((item) => item.label === 'Picky')
      assert.equal(provider.temperature, 'omit', 'the model is remembered, so the rejection costs one call ever')
    }, { realModelCall: true })
  } finally {
    stub.restore()
  }
})

test('the provider probe reports what it found, and why it could not', async () => {
  const stub = stubFetch(['93.184.216.34'], () => json({ data: [{ id: 'alpha' }, { id: 'beta' }] }))
  try {
    await withServer(async ({ request }) => {
      const created = await request('POST', '/api/providers', { label: 'Probe me', baseUrl: 'https://93.184.216.34/v1', model: 'alpha', apiKey: 'sk-probe' })
      const probed = await request('POST', `/api/providers/${created.payload.provider.id}/test`)
      assert.equal(probed.status, 200, JSON.stringify(probed.payload))
      assert.equal(probed.payload.result.reachable, true)
      assert.deepEqual(probed.payload.result.models, ['alpha', 'beta'])
      assert.equal(stub.calls[0].headers.Authorization, 'Bearer sk-probe')
      assert.equal(stub.calls[0].url, 'https://93.184.216.34/v1/models')

      const local = await request('POST', '/api/providers', { label: 'Behind the firewall', baseUrl: 'http://127.0.0.1:1234/v1', model: 'x', authStyle: 'none' })
      const blocked = await request('POST', `/api/providers/${local.payload.provider.id}/test`)
      assert.equal(blocked.payload.result.blocked, true)
      assert.match(String(blocked.payload.result.error), /local-network access/)

      const keyless = await request('POST', '/api/providers', { label: 'Needs a key', baseUrl: 'https://93.184.216.34/v1', model: 'x' })
      const unconfigured = await request('POST', `/api/providers/${keyless.payload.provider.id}/test`)
      assert.equal(unconfigured.payload.result.configured, false)
      assert.match(String(unconfigured.payload.result.error), /No key yet/)
    }, { realModelCall: true })
  } finally {
    stub.restore()
  }
})
