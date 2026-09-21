import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequest } from '../server/modelCall.mjs'
import { normalizeReasoningLevel, reasoningPayload, resolveReasoning } from '../server/reasoning.mjs'

const base = { baseUrl: 'https://example.test/v1', messages: [{ role: 'user', content: 'hi' }], instructions: 'sys' }

test('a level is one of the known words, or nothing', () => {
  assert.equal(normalizeReasoningLevel('high'), 'high')
  assert.equal(normalizeReasoningLevel(' Medium '), 'medium')
  assert.equal(normalizeReasoningLevel('ludicrous'), null)
  assert.equal(normalizeReasoningLevel(''), null)
  assert.equal(normalizeReasoningLevel(null), null)
})

test('a role reads its own level, then the project default, then nothing', () => {
  const settings = { reasoning: { head: 'high', default: 'low' } }
  assert.equal(resolveReasoning(settings, 'head'), 'high')
  assert.equal(resolveReasoning(settings, 'builder'), 'low')
  assert.equal(resolveReasoning({ reasoning: {} }, 'head'), null)
  assert.equal(resolveReasoning({}, 'head'), null)
  assert.equal(resolveReasoning(null, 'head'), null)
})

test('openai-compatible reasoning becomes an effort word', () => {
  assert.deepEqual(reasoningPayload('openai-compatible', 'grok-4', 'high'), { reasoning_effort: 'high' })
  assert.deepEqual(reasoningPayload('openai-compatible', 'gpt-5', 'minimal'), { reasoning_effort: 'minimal' })
})

test('anthropic reasoning becomes a thinking budget', () => {
  assert.deepEqual(reasoningPayload('anthropic', 'claude-opus-4-1', 'medium'), { thinking: { type: 'enabled', budget_tokens: 8192 } })
})

test('an anthropic budget never contradicts the output ceiling', () => {
  // A high setting against the default 4096 ceiling is capped under it, and the
  // ceiling is lifted past the budget so the two never ask for the impossible.
  const high = reasoningPayload('anthropic', 'claude-opus-4-1', 'high', 4096)
  assert.equal(high.thinking.budget_tokens <= high.max_tokens, true)
  assert.equal(high.thinking.budget_tokens, 2048)

  const low = reasoningPayload('anthropic', 'claude-opus-4-1', 'low', 4096)
  assert.equal(low.thinking.budget_tokens, 2048)
  assert.equal('max_tokens' in low, false, 'a budget under the ceiling leaves max_tokens alone')
})

test('google reasoning becomes a thinking budget', () => {
  assert.deepEqual(reasoningPayload('google', 'gemini-2.5-pro', 'low'), { thinkingConfig: { thinkingBudget: 2048 } })
})

test('a model that does not reason is sent nothing', () => {
  assert.deepEqual(reasoningPayload('openai-compatible', 'deepseek-chat', 'high'), {})
  assert.deepEqual(reasoningPayload('openai-compatible', 'grok-4', null), {})
  assert.deepEqual(reasoningPayload('anthropic', 'claude-opus-4-1', 'ludicrous'), {})
})

test('buildRequest spreads the translated reasoning into each dialect', () => {
  const openai = buildRequest('openai-compatible', { ...base, model: 'grok-4', reasoning: 'high' })
  assert.equal(openai.body.reasoning_effort, 'high')

  const anthropic = buildRequest('anthropic', { ...base, model: 'claude-opus-4-1', reasoning: 'low' })
  assert.deepEqual(anthropic.body.thinking, { type: 'enabled', budget_tokens: 2048 })

  const google = buildRequest('google', { ...base, model: 'gemini-2.5-pro', reasoning: 'high' })
  assert.equal(google.body.generationConfig.thinkingConfig.thinkingBudget, 16384)

  const silent = buildRequest('openai-compatible', { ...base, model: 'deepseek-chat', reasoning: 'high' })
  assert.equal('reasoning_effort' in silent.body, false)

  const unset = buildRequest('anthropic', { ...base, model: 'claude-opus-4-1' })
  assert.equal('thinking' in unset.body, false)
})
