import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { bodySendsTemperature, bodyWithoutTemperature, buildRequest, parseResponse, providerAuthHeaders, resolveToolNames, wireToolName, wireToolDefinitions } from '../server/modelCall.mjs'
import { createProviderRegistry } from '../server/providerRegistry.mjs'
import { isPrivateAddress } from '../server/networkPolicy.mjs'
import { agentRoles } from '../server/roles.mjs'
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

test('an unchanged empty key field preserves credentials; null explicitly removes the stored key', async () => {
  await withServer(async ({ request }) => {
    const created = await request('POST', '/api/providers', { label: 'Keep my key', baseUrl: 'https://example.invalid/v1', model: 'model-one', apiKey: 'fixture-credential' })
    const id = created.payload.provider.id
    const saved = await request('PATCH', `/api/providers/${id}`, { apiKey: '', allowPrivate: true })
    assert.equal(saved.status, 200)
    assert.equal(saved.payload.provider.hasKey, true, 'an untouched password field must not delete the stored credential')
    assert.equal(saved.payload.provider.keySource, 'stored')
    assert.equal(saved.payload.provider.allowPrivate, true)
    const removed = await request('PATCH', `/api/providers/${id}`, { apiKey: null })
    assert.equal(removed.payload.provider.hasKey, false, 'removal is an explicit operation')
  })
})

test('provider definition edits persist for custom and built-in providers and reach route resolution', async () => {
  await withServer(async ({ request, providerRegistry }) => {
    const created = await request('POST', '/api/providers', { label: 'Editable gateway', baseUrl: 'https://example.invalid/v1', model: 'model-one', authStyle: 'none' })
    for (const id of ['openai', created.payload.provider.id]) {
      const label = `Edited ${id}`
      const saved = await request('PATCH', `/api/providers/${id}`, { label, baseUrl: 'https://gateway.invalid/v2/', model: 'model-two' })
      assert.equal(saved.status, 200, JSON.stringify(saved.payload))
      assert.equal(saved.payload.provider.label, label)
      assert.equal(saved.payload.provider.baseUrl, 'https://gateway.invalid/v2')
      assert.equal(saved.payload.provider.model, 'model-two')
      const resolved = providerRegistry.resolve({ providerId: id })
      assert.equal(resolved.baseUrl, 'https://gateway.invalid/v2', 'the model caller sees the saved endpoint')
      assert.equal(providerRegistry.model(resolved), 'model-two')
    }
    const listed = (await request('GET', '/api/providers')).payload.providers
    assert.equal(listed.filter((p) => p.id === 'openai').length, 1, 'a built-in override is not a second provider')
    assert.equal(listed.find((p) => p.id === 'openai').custom, false)
  })
})

test('renaming a provider preserves previously saved routes across subsequent edits', async () => {
  await withStore(async (store) => {
    const registry = createProviderRegistry(store)
    const provider = registry.addCustom({ label: 'Original gateway', baseUrl: 'https://example.invalid', model: 'model-one', authStyle: 'none' })
    registry.updateSettings(provider.id, { label: 'Second name' })
    registry.updateSettings(provider.id, { label: 'Third name' })
    const reloaded = createProviderRegistry(store)
    for (const route of [provider.id, 'Original gateway', 'Second name', 'Third name']) {
      const resolved = reloaded.resolve(`${route} · specific-model`)
      assert.equal(resolved.id, provider.id)
      assert.equal(resolved.label, 'Third name')
      assert.equal(reloaded.model(resolved, `${route} · specific-model`), 'specific-model')
    }
  })
})

test('invalid provider edits are refused atomically instead of silently saving credentials', async () => {
  await withServer(async ({ request }) => {
    const created = await request('POST', '/api/providers', { label: 'Validated gateway', baseUrl: 'https://example.invalid', model: 'model-one', apiKey: 'fixture-credential' })
    const id = created.payload.provider.id
    for (const patch of [{ baseUrl: 'file:///local' }, { baseUrl: 'https://' }, { model: ' ' }, { label: ' ' }]) {
      const rejected = await request('PATCH', `/api/providers/${id}`, { ...patch, apiKey: null })
      assert.equal(rejected.status, 400, JSON.stringify(patch))
      const current = (await request('GET', '/api/providers')).payload.providers.find((p) => p.id === id)
      assert.equal(current.hasKey, true, 'a rejected edit must not partially clear the key')
      assert.equal(current.model, 'model-one')
    }
  })
})

test('an invalid custom-provider registration leaves no partial provider behind', async () => {
  await withServer(async ({ request }) => {
    const rejected = await request('POST', '/api/providers', { label: 'Invalid registration', baseUrl: 'https://example.invalid', model: 'model-one', authStyle: 'header' })
    assert.equal(rejected.status, 400)
    const listed = (await request('GET', '/api/providers')).payload.providers
    assert.equal(listed.some((p) => p.label === 'Invalid registration'), false)
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

test('credential-shaped headers are masked, kept, and never stored as dots', async () => {
  await withServer(async ({ request, store }) => {
    const created = await request('POST', '/api/providers', { label: 'Masked gateway', baseUrl: 'https://93.184.216.34/v1', model: 'm-1' })
    assert.equal(created.status, 201, JSON.stringify(created.payload))
    const id = created.payload.provider.id

    const saved = await request('PATCH', `/api/providers/${id}`, { headers: { Authorization: 'Bearer s3cr3t-live-value', 'X-Tenant': 'acme' } })
    assert.equal(saved.status, 200, JSON.stringify(saved.payload))
    assert.equal(saved.payload.provider.headers.Authorization, '••••••••', 'the secret value never comes back')
    assert.equal(saved.payload.provider.headers['X-Tenant'], 'acme', 'plain configuration still does')

    const listed = await request('GET', '/api/providers')
    assert.equal(JSON.stringify(listed.payload).includes('s3cr3t-live-value'), false, 'no endpoint serializes it back')

    // Saving the masked form keeps the stored secret instead of wiping it.
    const kept = await request('PATCH', `/api/providers/${id}`, { headers: { Authorization: '••••••••', 'X-Tenant': 'acme-2' } })
    assert.equal(kept.status, 200, JSON.stringify(kept.payload))
    assert.equal(store.getProviderSettings(id).headers.Authorization, 'Bearer s3cr3t-live-value', 'the stored value survived the round trip')
    assert.equal(store.getProviderSettings(id).headers['X-Tenant'], 'acme-2')

    // But a mask with nothing behind it is refused rather than stored.
    const fresh = await request('POST', '/api/providers', { label: 'Fresh gateway', baseUrl: 'https://93.184.216.34/v1', model: 'm-2' })
    const refused = await request('PATCH', `/api/providers/${fresh.payload.provider.id}`, { headers: { 'X-Token': '••••••••' } })
    assert.equal(refused.status, 400, JSON.stringify(refused.payload))
    assert.match(String(refused.payload.error ?? ''), /retype/)
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

test('a provider that keeps failing is skipped without being dialed', async () => {
  const previous = {
    attempts: process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS,
    threshold: process.env.FULKRUM_BREAKER_THRESHOLD,
    cooldown: process.env.FULKRUM_BREAKER_COOLDOWN_MS,
  }
  // One attempt per call keeps this quick, and a cooldown far longer than the test
  // means the window cannot close mid-test however loaded the machine is. The
  // half-open behaviour is checked against a controlled clock below, because a
  // timing window this narrow is not something a test should depend on.
  process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS = '1'
  process.env.FULKRUM_BREAKER_THRESHOLD = '2'
  process.env.FULKRUM_BREAKER_COOLDOWN_MS = '60000'

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

test('the breaker opens, probes once, and closes again on a controlled clock', async () => {
  const { createBreaker } = await import('../server/modelCall.mjs')
  let clock = 1_000
  const breaker = createBreaker({ threshold: 2, cooldownMs: 5_000, now: () => clock })

  assert.equal(breaker.reject('p', 'Provider'), null, 'a fresh provider is allowed')

  breaker.failed('p')
  assert.equal(breaker.reject('p', 'Provider'), null, 'one failure is not enough to open it')

  breaker.failed('p')
  assert.match(String(breaker.reject('p', 'Provider')), /skipped for another/, 'the second failure opens it')

  // The cooldown passes: exactly one call is let through to find out if it recovered.
  clock += 5_001
  assert.equal(breaker.reject('p', 'Provider'), null, 'a half-open breaker probes')
  assert.match(String(breaker.reject('p', 'Provider')), /still being probed/, 'and only once')

  // A probe that fails re-opens it immediately, without waiting for the threshold again.
  breaker.failed('p')
  assert.match(String(breaker.reject('p', 'Provider')), /skipped for another/, 'a failed probe re-opens the breaker')

  // A probe that succeeds closes it.
  clock += 5_001
  assert.equal(breaker.reject('p', 'Provider'), null)
  breaker.succeeded('p')
  assert.equal(breaker.reject('p', 'Provider'), null)
  breaker.failed('p')
  assert.equal(breaker.reject('p', 'Provider'), null, 'failures start again from zero after a success')
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

/**
 * The wire-name contract, reproducing a live failure: a strict gateway
 * rejected `tools[0].name` because our dotted names (`workspace.read`,
 * `plugin.my-skill`) violate the documented `^[a-zA-Z0-9_-]+$` pattern, and
 * the whole run died at its first tool call. Names cross the boundary in
 * wire form and come back real — reversibly, or the suite fails.
 */
const WIRE_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

function liveToolInventory() {
  const names = new Set()
  for (const role of Object.values(agentRoles)) {
    for (const tool of role.tools ?? []) names.add(tool)
  }
  // Plugin tools carry registry ids, which allow dots and hyphens.
  for (const id of ['my-skill', 'a.b', 'ocr.space']) names.add(`plugin.${id}`)
  return [...names]
}

test('every live tool name crosses the wire strictly valid, in all three protocols', () => {
  const tools = liveToolInventory().map((name) => ({ name, description: 'd', parameters: { type: 'object', properties: {} } }))
  // The reversibility invariant: no real name contains an underscore, so every
  // underscore on the wire came from a dot, and the mapping is exact.
  for (const name of liveToolInventory()) {
    assert.doesNotMatch(name, /_/, `${name} must not contain an underscore or the wire mapping stops being exact`)
  }
  for (const protocol of ['anthropic', 'google', 'openai-compatible']) {
    const { body } = buildRequest(protocol, { baseUrl: 'https://example.com/v1', model: 'm', messages: [], tools })
    const wireNames = protocol === 'anthropic'
      ? body.tools.map((tool) => tool.name)
      : protocol === 'google'
        ? body.tools[0].functionDeclarations.map((declaration) => declaration.name)
        : body.tools.map((tool) => tool.function.name)
    assert.ok(wireNames.length > 0, `${protocol} must carry the tools`)
    for (const wire of wireNames) {
      assert.match(wire, WIRE_PATTERN, `${protocol} sends ${wire}, which a strict gateway refuses`)
    }
    assert.ok(wireNames.includes('workspace_read'), `${protocol} must carry the sanitized read tool`)
    assert.ok(wireNames.includes('plugin_a_b'), `${protocol} must carry the sanitized dotted plugin id`)
    assert.ok(!wireNames.some((wire) => wire.includes('.')), `${protocol} must send no dotted names`)
  }
})

test('wire names parse back verbatim; only the declared map resolves them', () => {
  const openai = parseResponse('openai-compatible', {
    choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'workspace_read', arguments: '{"path":"x"}' } }, { id: 'c2', function: { name: 'plugin_a_b', arguments: '{}' } }] } }],
  })
  // The parser does not interpret: what crossed the wire is what comes back.
  assert.deepEqual(openai.toolCalls.map((call) => call.name), ['workspace_read', 'plugin_a_b'])

  const anthropic = parseResponse('anthropic', {
    content: [{ type: 'tool_use', id: 'c1', name: 'shell_exec', input: {} }],
  })
  assert.deepEqual(anthropic.toolCalls.map((call) => call.name), ['shell_exec'])

  const google = parseResponse('google', {
    candidates: [{ content: { parts: [{ functionCall: { name: 'run_ask', args: {} } }] } }],
  })
  assert.deepEqual(google.toolCalls.map((call) => call.name), ['run_ask'])
})

test('strict resolution admits declared tools and leaves everything else untouched', () => {
  const tools = [{ name: 'workspace.read' }, { name: 'plugin.a.b' }]
  const resolved = resolveToolNames(
    [{ id: 'c1', name: 'workspace_read' }, { id: 'c2', name: 'workspace.read' }, { id: 'c3', name: 'workspace_write' }, { id: 'c4', name: 'unknown' }],
    tools,
  )
  assert.deepEqual(resolved.map((call) => call.name), [
    'workspace.read', // declared wire name resolves to the real tool
    'workspace.read', // a dotted echo from a lenient gateway already names it
    'workspace_write', // undeclared: stays wire, so the broker rejects it as unknown
    'unknown', // unknown stays unknown
  ])
  assert.deepEqual(resolveToolNames([{ id: 'c1', name: 'workspace_read' }], []), [{ id: 'c1', name: 'workspace_read' }], 'with nothing declared, nothing resolves')
})

test('wire and real names round-trip exactly', () => {
  for (const name of liveToolInventory()) {
    assert.equal(resolveToolNames([{ id: 'c1', name: wireToolName(name) }], [{ name }])[0].name, name, `${name} must survive the crossing unchanged`)
  }
})

test('unsendable names fail fast as final provider errors', async () => {
  const { ProviderError } = await import('../server/modelCall.mjs')
  for (const bad of ['a'.repeat(65), 'has space', 'has:colon', '']) {
    assert.throws(() => wireToolName(bad), (error) => error instanceof ProviderError && error.status === 400 && error.retryable === false, `${JSON.stringify(bad)} must fail without a retry loop`)
  }
})

test('temperature is detected and dropped wherever the protocol nests it', () => {
  assert.equal(bodySendsTemperature({ temperature: 0.2 }), true)
  assert.equal(bodySendsTemperature({ generationConfig: { temperature: 0.2 } }), true, 'Google nests it — the old check missed this and retried forever')
  assert.equal(bodySendsTemperature({}), false)
  assert.deepEqual(bodyWithoutTemperature({ temperature: 0.2, model: 'm' }), { model: 'm' })
  assert.deepEqual(bodyWithoutTemperature({ generationConfig: { temperature: 0.2, topK: 40 } }), { generationConfig: { topK: 40 } })
})

test('declarations for one protocol cannot miss the mapping', () => {
  const tools = liveToolInventory().map((name) => ({ name, description: 'd', parameters: { type: 'object', properties: {} } }))
  const defs = wireToolDefinitions('openai-compatible', tools)
  assert.equal(defs.length, tools.length)
  for (const def of defs) assert.match(def.function.name, /^[a-zA-Z0-9_-]{1,64}$/)
})
