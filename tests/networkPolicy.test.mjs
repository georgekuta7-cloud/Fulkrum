import assert from 'node:assert/strict'
import test from 'node:test'
import { validateOutboundUrl } from '../server/networkPolicy.mjs'
import { createProviderRegistry } from '../server/providerRegistry.mjs'
import { withStore } from './helpers.mjs'

test('outbound requests cannot reach local or private networks', async () => {
  await assert.rejects(() => validateOutboundUrl('http://127.0.0.1:8787/api/health'), /Private and local network targets/)
  await assert.rejects(() => validateOutboundUrl('http://localhost:11434/v1'), /Private and local network targets/)
  await assert.rejects(() => validateOutboundUrl('http://169.254.169.254/latest/meta-data/'), /Private and local network targets/)
  await assert.rejects(() => validateOutboundUrl('http://10.0.0.5/'), /Private and local network targets/)
  await assert.rejects(() => validateOutboundUrl('http://192.168.1.1/'), /Private and local network targets/)
  await assert.rejects(() => validateOutboundUrl('file:///etc/passwd'), /Only http and https/)
})

test('a host allowlist is enforced when one is configured', async () => {
  await assert.rejects(() => validateOutboundUrl('https://api.example.com/v1', { allowedHosts: ['allowed.test'] }), /not allowlisted/)
})

test('provider routes must resolve instead of silently falling back', async () => {
  await withStore((store) => {
    const registry = createProviderRegistry(store)
    assert.throws(() => registry.resolve('Totally Unknown · whatever'), /Unknown provider route/)
    assert.equal(registry.resolve('OpenAI · gpt-5').id, 'openai')
    assert.equal(registry.model(registry.resolve('OpenAI · gpt-5'), 'OpenAI · gpt-5'), 'gpt-5')
    assert.equal(registry.model(registry.resolve('OpenAI'), 'OpenAI'), registry.resolve('OpenAI').defaultModel)
    assert.equal(registry.resolve('').id, registry.list()[0].id)
  })
})

test('custom provider definitions are validated', async () => {
  await withStore((store) => {
    const registry = createProviderRegistry(store)
    assert.throws(() => registry.addCustom({ label: '', baseUrl: 'https://x.test/v1', model: 'm', envKey: 'A_KEY' }), /label/)
    assert.throws(() => registry.addCustom({ label: 'X', baseUrl: 'ftp://x.test', model: 'm', envKey: 'A_KEY' }), /http or https/)
    assert.throws(() => registry.addCustom({ label: 'X', baseUrl: 'https://x.test/v1', model: '', envKey: 'A_KEY' }), /model must be between/)
    assert.throws(() => registry.addCustom({ label: 'X', baseUrl: 'https://x.test/v1', model: 'm', envKey: '1BAD' }), /environment variable/)

    const provider = registry.addCustom({ label: 'Local Gateway', baseUrl: 'https://x.test/v1', model: 'm', envKey: 'CUSTOM_KEY' })
    assert.equal(provider.id, 'custom-local-gateway')
    assert.equal(registry.list().some((item) => item.id === provider.id), true)

    assert.throws(() => registry.removeCustom('openai'), /Built-in providers cannot be removed/)
    assert.equal(registry.removeCustom(provider.id), provider.id)
  })
})
