import { privateProviderUrlsAllowed, validateOutboundUrl } from './networkPolicy.mjs'

/**
 * One normalized conversation format over three provider protocols.
 *
 * Internal messages are one of:
 *   { role: 'user', content }
 *   { role: 'assistant', content?, toolCalls?: [{ id, name, arguments }] }
 *   { role: 'tool', results: [{ id, name, content, isError }] }
 *
 * Each protocol wants a different shape on the wire, so the translation lives
 * here in pure functions that can be tested without a network call.
 */

const maxTokens = Number(process.env.FULKRUM_MAX_OUTPUT_TOKENS ?? 4096)

function safeParseJson(value) {
  if (typeof value !== 'string') return { value, invalid: false }
  try {
    return { value: JSON.parse(value), invalid: false }
  } catch {
    return { value: {}, invalid: true }
  }
}

function toolResultText(result) {
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? null)
}

export function toOpenAiMessages(messages, instructions) {
  const output = [{ role: 'system', content: instructions }]
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const result of message.results) {
        output.push({ role: 'tool', tool_call_id: result.id, content: toolResultText(result) })
      }
      continue
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      output.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) } })),
      })
      continue
    }
    output.push({ role: message.role, content: message.content })
  }
  return output
}

export function toAnthropicMessages(messages) {
  const output = []
  for (const message of messages) {
    if (message.role === 'tool') {
      // Tool results are delivered as a user turn of tool_result blocks.
      output.push({
        role: 'user',
        content: message.results.map((result) => ({ type: 'tool_result', tool_use_id: result.id, content: toolResultText(result), is_error: Boolean(result.isError) })),
      })
      continue
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const blocks = []
      if (message.content) blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} })
      output.push({ role: 'assistant', content: blocks })
      continue
    }
    output.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content })
  }
  return output
}

export function toGoogleContents(messages) {
  const output = []
  for (const message of messages) {
    if (message.role === 'tool') {
      output.push({
        role: 'user',
        parts: message.results.map((result) => ({ functionResponse: { name: result.name, response: { result: toolResultText(result) } } })),
      })
      continue
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const parts = []
      if (message.content) parts.push({ text: message.content })
      for (const call of message.toolCalls) parts.push({ functionCall: { name: call.name, args: call.arguments ?? {} } })
      output.push({ role: 'model', parts })
      continue
    }
    output.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content ?? '' }] })
  }
  return output
}

export function buildRequest(protocol, { baseUrl, model, messages, tools = [], instructions }) {
  const endpoint = String(baseUrl).replace(/\/$/, '')

  if (protocol === 'anthropic') {
    return {
      url: `${endpoint}/messages`,
      body: {
        model,
        max_tokens: maxTokens,
        system: instructions,
        messages: toAnthropicMessages(messages),
        ...(tools.length ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
      },
    }
  }

  if (protocol === 'google') {
    return {
      url: `${endpoint}/models/${encodeURIComponent(model)}:generateContent`,
      body: {
        systemInstruction: { parts: [{ text: instructions }] },
        contents: toGoogleContents(messages),
        ...(tools.length ? { tools: [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }] } : {}),
        generationConfig: { temperature: 0.3 },
      },
    }
  }

  return {
    url: `${endpoint}/chat/completions`,
    body: {
      model,
      temperature: 0.3,
      messages: toOpenAiMessages(messages, instructions),
      ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })), tool_choice: 'auto' } : {}),
    },
  }
}

export function parseResponse(protocol, payload) {
  if (protocol === 'anthropic') {
    const blocks = Array.isArray(payload?.content) ? payload.content : []
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('').trim()
    const toolCalls = blocks.filter((block) => block.type === 'tool_use').map((block) => ({ id: block.id, name: block.name, arguments: block.input ?? {} }))
    return { text, toolCalls, usage: normalizeUsage(protocol, payload?.usage) }
  }

  if (protocol === 'google') {
    const parts = payload?.candidates?.[0]?.content?.parts ?? []
    const text = parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join('').trim()
    const toolCalls = parts
      .filter((part) => part.functionCall)
      .map((part, index) => ({ id: `google-call-${index}`, name: part.functionCall.name, arguments: part.functionCall.args ?? {} }))
    return { text, toolCalls, usage: normalizeUsage(protocol, payload?.usageMetadata) }
  }

  const message = payload?.choices?.[0]?.message ?? {}
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const toolCalls = rawCalls.map((call, index) => {
    const parsed = safeParseJson(call?.function?.arguments ?? '{}')
    return { id: call?.id ?? `call-${index}`, name: call?.function?.name ?? 'unknown', arguments: parsed.value, invalidJson: parsed.invalid }
  })
  return { text: typeof message.content === 'string' ? message.content.trim() : '', toolCalls, usage: normalizeUsage(protocol, payload?.usage) }
}

/**
 * Normalize token usage across providers.
 *
 * `inputTokens` is what the provider reported; `billableInputTokens` excludes
 * cached tokens, because OpenAI and Google include cached tokens in the prompt
 * total while Anthropic reports them separately. Billing the same tokens twice
 * would quietly inflate every cost figure.
 */
export function normalizeUsage(protocol, usage) {
  if (!usage) return null
  const nonNegative = (value) => Math.max(Number(value) || 0, 0)
  if (protocol === 'anthropic') {
    const inputTokens = nonNegative(usage.input_tokens)
    return {
      inputTokens,
      billableInputTokens: inputTokens,
      outputTokens: nonNegative(usage.output_tokens),
      cacheReadTokens: nonNegative(usage.cache_read_input_tokens),
      cacheWriteTokens: nonNegative(usage.cache_creation_input_tokens),
      reasoningTokens: 0,
    }
  }
  if (protocol === 'google') {
    const inputTokens = nonNegative(usage.promptTokenCount)
    const cacheReadTokens = nonNegative(usage.cachedContentTokenCount)
    return {
      inputTokens,
      billableInputTokens: Math.max(inputTokens - cacheReadTokens, 0),
      outputTokens: nonNegative(usage.candidatesTokenCount),
      cacheReadTokens,
      cacheWriteTokens: 0,
      reasoningTokens: nonNegative(usage.thoughtsTokenCount),
    }
  }
  const inputTokens = nonNegative(usage.prompt_tokens)
  const cacheReadTokens = nonNegative(usage.prompt_tokens_details?.cached_tokens)
  return {
    inputTokens,
    billableInputTokens: Math.max(inputTokens - cacheReadTokens, 0),
    outputTokens: nonNegative(usage.completion_tokens),
    cacheReadTokens,
    cacheWriteTokens: 0,
    reasoningTokens: nonNegative(usage.completion_tokens_details?.reasoning_tokens),
  }
}

const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const maxAttempts = Number(process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS ?? 3)
const requestTimeoutMs = Number(process.env.FULKRUM_PROVIDER_TIMEOUT_MS ?? 60_000)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function retryDelayMs(attempt, retryAfter) {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000)
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000)
  }
  // Exponential backoff with jitter, so parallel workers do not retry in lockstep.
  const base = Math.min(500 * 2 ** attempt, 8_000)
  return Math.round(base * (0.5 + Math.random() * 0.5))
}

export class ProviderError extends Error {
  constructor(message, { status, retryable, retryAfter = null } = {}) {
    super(message)
    this.status = status
    this.retryable = retryable
    this.retryAfter = retryAfter
  }
}

export function createModelCaller({ providerRegistry, allowPrivate = privateProviderUrlsAllowed() }) {
  const requestOnce = async (url, options) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
    let response
    try {
      response = await fetch(url, { ...options, redirect: 'manual', signal: controller.signal })
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      throw new ProviderError(aborted ? `Provider request timed out after ${requestTimeoutMs}ms.` : `Provider request failed: ${error instanceof Error ? error.message : 'unknown error'}`, { retryable: true })
    } finally {
      clearTimeout(timeout)
    }

    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message = payload?.error?.message ?? payload?.error ?? `Provider returned ${response.status}`
      throw new ProviderError(String(message).slice(0, 500), { status: response.status, retryable: retryableStatuses.has(response.status), retryAfter: response.headers.get('retry-after') })
    }
    return payload
  }

  const requestWithRetry = async (attempt, url, options) => {
    try {
      return await requestOnce(url, options)
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable || attempt + 1 >= maxAttempts) throw error
      await sleep(retryDelayMs(attempt, error.retryAfter))
      return requestWithRetry(attempt + 1, url, options)
    }
  }

  /**
   * Call a provider and normalize the answer, including tool calls.
   * Returns { text, toolCalls, usage }.
   */
  const callModel = async (provider, model, messages, { tools = [], instructions } = {}) => {
    const base = await validateOutboundUrl(provider.baseUrl, { allowPrivate })
    const { url, body } = buildRequest(provider.protocol, { baseUrl: base.toString(), model, messages, tools, instructions })
    const headers = { 'Content-Type': 'application/json' }
    if (provider.protocol === 'anthropic') {
      headers['x-api-key'] = providerRegistry.secret(provider)
      headers['anthropic-version'] = '2023-06-01'
    } else if (provider.protocol === 'google') {
      headers['x-goog-api-key'] = providerRegistry.secret(provider)
    } else {
      headers.Authorization = `Bearer ${providerRegistry.secret(provider)}`
    }

    const payload = await requestWithRetry(0, url, { method: 'POST', headers, body: JSON.stringify(body) })
    return parseResponse(provider.protocol, payload)
  }

  /** Text-only convenience wrapper for chat and plan generation. */
  const callText = async (provider, model, messages, instructions) => {
    const response = await callModel(provider, model, messages, { instructions })
    return response.text
  }

  return { callModel, callText, buildRequest }
}
