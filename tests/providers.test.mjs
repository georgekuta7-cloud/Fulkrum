import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { providerAuthHeaders } from '../server/modelCall.mjs'
import { createProviderRegistry } from '../server/providerRegistry.mjs'
import { isPrivateAddress } from '../server/networkPolicy.mjs'
import { withServer, withStore } from './helpers.mjs'

/**
 * These tests point the application at a real HTTP server on loopback rather than
 * stubbing `fetch`: the transport now pins the connection to a validated address,
 * so the only honest way to check the request is to receive it.
 *
 * A loopback endpoint is refused by default, which is what the first test proves;
 * the others turn local access on for that one provider, the way a user would.
 */
async function withProviderServer(handler, callback) {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      let parsed = null
      try {
        parsed = body ? JSON.parse(body) : null
      } catch {
        parsed = body
      }
      const record = { method: request.method, url: request.url, headers: request.headers, body: parsed }
      requests.push(record)
      // Assertions belong in the test body: one that throws inside this handler
      // becomes an uncaught exception and takes the whole file's result with it.
      handler(record, response, requests.length)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  try {
    return await callback({ port, requests, baseUrl: `http://127.0.0.1:${port}/v1` })
  } finally {
    // Keep-alive sockets would otherwise hold the server open past the test.
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

const json = (response, payload, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  response.end(JSON.stringify(payload))
}

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

test('addresses that reach a private network are recognised in every notation', () => {
  // IPv4-mapped IPv6 used to slip through: it was compared as IPv6 against IPv4
  // prefixes, so ::ffff:127.0.0.1 reached loopback while looking unremarkable.
  for (const address of ['127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) {
    assert.equal(isPrivateAddress(address), true, `${address} must be blocked`)
  }
  for (const address of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '2001:db8::1', '2002::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:172.16.0.1', '::ffff:169.254.169.254', '::ffff:0.0.0.0', '::ffff:7f00:1', 'fe80::1%eth0']) {
    assert.equal(isPrivateAddress(address), true, `${address} must be blocked`)
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255', '192.0.1.1', '198.20.0.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, `${address} must be allowed`)
  }
  // Anything unparseable is refused: a check that cannot classify an address
  // cannot vouch for it.
  for (const address of ['', 'not-an-address', '999.999.999.999', '127.0.0.1.5']) {
    assert.equal(isPrivateAddress(address), true, `${JSON.stringify(address)} must be refused`)
  }
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
  await withProviderServer((_record, response) => {
    json(response, { choices: [{ message: { content: 'hello from the local server' } }] })
  }, async ({ baseUrl, requests }) => {
    await withServer(async ({ request }) => {
      const { projectId, runId } = await makeRun(request)
      const created = await request('POST', '/api/providers', { label: 'Local box', baseUrl, model: 'local-1', authStyle: 'none' })
      assert.equal(created.status, 201, JSON.stringify(created.payload))
      assert.equal(created.payload.provider.configured, true, 'an endpoint that needs no key is still configured')

      const blocked = await request('POST', '/api/chat', { projectId, runId, routing: { head: 'Local box · local-1' }, message: 'hello', history: [] })
      assert.equal(blocked.status, 502)
      assert.match(String(blocked.payload.error), /Private and local network/)
      assert.equal(requests.length, 0, 'the address was refused before any connection was made')

      const patched = await request('PATCH', `/api/providers/${created.payload.provider.id}`, { allowPrivate: true })
      assert.equal(patched.status, 200, JSON.stringify(patched.payload))
      assert.equal(patched.payload.provider.allowPrivate, true)

      const allowed = await request('POST', '/api/chat', { projectId, runId, routing: { head: 'Local box · local-1' }, message: 'hello', history: [] })
      assert.equal(allowed.status, 200, JSON.stringify(allowed.payload))
      assert.equal(allowed.payload.reply, 'hello from the local server')

      assert.equal(requests[0].url, '/v1/chat/completions')
      assert.equal(requests[0].method, 'POST')
      assert.equal(requests[0].body.model, 'local-1')
      assert.equal(requests[0].headers.authorization, undefined, 'no credential header for an endpoint that takes none')
      assert.equal(requests[0].headers.host, `127.0.0.1:${new URL(baseUrl).port}`, 'the Host header still names the endpoint')
    }, { realModelCall: true })
  })
})

test('a rejected temperature is retried without it, then remembered', async () => {
  await withProviderServer((_record, response, count) => {
    if (count === 1) json(response, { error: { message: 'Unsupported value: temperature is not supported with this model' } }, 400)
    else json(response, { choices: [{ message: { content: 'second attempt worked' } }] })
  }, async ({ baseUrl, requests }) => {
    await withServer(async ({ request }) => {
      const { projectId, runId } = await makeRun(request)
      await request('POST', '/api/providers', { label: 'Picky', baseUrl, model: 'mystery-2', apiKey: 'sk-picky', allowPrivate: true })

      const first = await request('POST', '/api/chat', { projectId, runId, routing: { head: 'Picky · mystery-2' }, message: 'hello', history: [] })
      assert.equal(first.status, 200, JSON.stringify(first.payload))
      assert.equal(first.payload.reply, 'second attempt worked')
      assert.equal(requests.length, 2, 'one rejected call, then one retry')
      assert.equal(requests[0].body.temperature, 0.3)
      assert.equal('temperature' in requests[1].body, false, 'the retry omits temperature')
      assert.equal(requests[0].headers.authorization, 'Bearer sk-picky')

      const provider = (await request('GET', '/api/providers')).payload.providers.find((item) => item.label === 'Picky')
      assert.equal(provider.temperature, 'omit', 'the model is remembered, so the rejection costs one call ever')
    }, { realModelCall: true })
  })
})

test('a provider that keeps failing is skipped, then probed once', async () => {
  const previous = {
    attempts: process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS,
    threshold: process.env.FULKRUM_BREAKER_THRESHOLD,
    cooldown: process.env.FULKRUM_BREAKER_COOLDOWN_MS,
  }
  // One attempt per call keeps this quick; two failed calls open the breaker.
  process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS = '1'
  process.env.FULKRUM_BREAKER_THRESHOLD = '2'
  process.env.FULKRUM_BREAKER_COOLDOWN_MS = '150'

  try {
    await withProviderServer((_record, response) => {
      json(response, { error: { message: 'the provider is having a bad day' } }, 500)
    }, async ({ baseUrl, requests }) => {
      await withServer(async ({ request }) => {
        const { projectId, runId } = await makeRun(request)
        await request('POST', '/api/providers', { label: 'Flaky', baseUrl, model: 'flaky-1', apiKey: 'sk-flaky', allowPrivate: true })
        const chat = () => request('POST', '/api/chat', { projectId, runId, routing: { head: 'Flaky · flaky-1' }, message: 'hello', history: [] })

        assert.equal((await chat()).status, 502)
        assert.equal((await chat()).status, 502)
        assert.equal(requests.length, 2, 'each failed call reached the provider once')

        // Two failures open the breaker: the next call is refused without dialing.
        const skipped = await chat()
        assert.equal(skipped.status, 502)
        assert.match(String(skipped.payload.error), /skipped/i)
        assert.equal(requests.length, 2, 'nothing was sent while the breaker was open')

        // After the cooldown, one call is allowed through as a probe.
        await new Promise((resolve) => setTimeout(resolve, 200))
        assert.equal((await chat()).status, 502)
        assert.equal(requests.length, 3, 'a half-open breaker probes exactly once')
      }, { realModelCall: true })
    })
  } finally {
    const restore = { FULKRUM_PROVIDER_MAX_ATTEMPTS: previous.attempts, FULKRUM_BREAKER_THRESHOLD: previous.threshold, FULKRUM_BREAKER_COOLDOWN_MS: previous.cooldown }
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('the provider probe reports what it found, and why it could not', async () => {
  await withProviderServer((_record, response) => {
    json(response, { data: [{ id: 'alpha' }, { id: 'beta' }] })
  }, async ({ baseUrl, requests }) => {
    await withServer(async ({ request }) => {
      const created = await request('POST', '/api/providers', { label: 'Probe me', baseUrl, model: 'alpha', apiKey: 'sk-probe', allowPrivate: true })
      const probed = await request('POST', `/api/providers/${created.payload.provider.id}/test`)
      assert.equal(probed.status, 200, JSON.stringify(probed.payload))
      assert.equal(probed.payload.result.reachable, true)
      assert.deepEqual(probed.payload.result.models, ['alpha', 'beta'])
      assert.equal(requests[0].url, '/v1/models')
      assert.equal(requests[0].headers.authorization, 'Bearer sk-probe')

      // Without local access the probe never connects, and says why.
      const local = await request('POST', '/api/providers', { label: 'Behind the firewall', baseUrl, model: 'x', authStyle: 'none' })
      const blocked = await request('POST', `/api/providers/${local.payload.provider.id}/test`)
      assert.equal(blocked.payload.result.blocked, true)
      assert.match(String(blocked.payload.result.error), /local-network access/)

      const keyless = await request('POST', '/api/providers', { label: 'Needs a key', baseUrl, model: 'x', allowPrivate: true })
      const unconfigured = await request('POST', `/api/providers/${keyless.payload.provider.id}/test`)
      assert.equal(unconfigured.payload.result.configured, false)
      assert.match(String(unconfigured.payload.result.error), /No key yet/)
    }, { realModelCall: true })
  })
})
