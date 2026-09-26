import { createSseParser } from './sse.mjs'
import { privateProviderUrlsAllowed } from './networkPolicy.mjs'
import { pinnedRequest, pinnedStream } from './outboundHttp.mjs'
import { reasoningOffPayload, reasoningPayload } from './reasoning.mjs'

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

const nonNegative = (value) => Math.max(Number(value) || 0, 0)

// Read at use time, not import time: values saved through the app apply live.
const maxTokens = () => Number(process.env.FULKRUM_MAX_OUTPUT_TOKENS ?? 4096)

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

/**
 * Tool names cross the provider boundary in wire form.
 *
 * Our names (`workspace.read`, `plugin.my-skill`) contain dots, and every
 * protocol documents `^[a-zA-Z0-9_-]+$` for function names — a strict gateway
 * refuses the call and the run dies at its first tool use, which is exactly
 * what happened live. Internal records, approvals, receipts, and the broker
 * keep the real names; only the wire functions translate.
 *
 * Resolution is a strict map from what was actually declared, never a string
 * reversal: a hallucinated wire name must stay unknown so the broker rejects
 * it, not silently become a real tool. Dotted echoes from lenient gateways
 * pass through untouched because they already name real tools.
 */
export function wireToolName(name) {
  const wire = String(name ?? '').replace(/\./g, '_')
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(wire)) {
    // Deterministic, so retrying on another provider is pure waste: fail in a
    // way the fallback loop recognizes as final.
    throw new ProviderError(`Tool name ${JSON.stringify(String(name))} cannot cross the provider boundary.`, { status: 400, retryable: false })
  }
  return wire
}

/** The single choke point for declarations: every protocol's envelope is built here, so none can miss the mapping. */
export function wireToolDefinitions(protocol, tools) {
  const wired = (tools ?? []).map((tool) => ({ ...tool, name: wireToolName(tool.name) }))
  if (protocol === 'anthropic') {
    return wired.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
  }
  if (protocol === 'google') {
    return [{ functionDeclarations: wired.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }]
  }
  return wired.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
}

/**
 * Strict parse-back: names the model returned resolve against what was
 * declared this turn. Declared wire names become real tools; everything else
 * — dotted echoes, hallucinations, mangled truncations — passes through
 * verbatim, and the broker rejects what it does not know. With no declared
 * tools there is nothing to resolve against, so everything passes through.
 */
export function resolveToolNames(toolCalls, tools = []) {
  if (!tools.length) return toolCalls
  const known = new Map(tools.map((tool) => [wireToolName(tool.name), tool.name]))
  return (toolCalls ?? []).map((call) => (known.has(call.name) ? { ...call, name: known.get(call.name) } : call))
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
        tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: wireToolName(call.name), arguments: JSON.stringify(call.arguments ?? {}) } })),
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
      for (const call of message.toolCalls) blocks.push({ type: 'tool_use', id: call.id, name: wireToolName(call.name), input: call.arguments ?? {} })
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
        parts: message.results.map((result) => ({ functionResponse: { name: wireToolName(result.name), response: { result: toolResultText(result) } } })),
      })
      continue
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const parts = []
      if (message.content) parts.push({ text: message.content })
      for (const call of message.toolCalls) parts.push({ functionCall: { name: wireToolName(call.name), args: call.arguments ?? {} } })
      output.push({ role: 'model', parts })
      continue
    }
    output.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content ?? '' }] })
  }
  return output
}

/**
 * Build the wire request for a protocol.
 *
 * The body genuinely differs per protocol, so it is left untyped rather than
 * unioned: a union would force callers to narrow three shapes to read one field.
 *
 * `temperature` is resolved by the provider registry, not here, because whether a
 * model accepts one is a property of the model: reasoning models reject any value
 * other than their own default with a 400.
 *
 * @param {string} protocol
 * @param {{ baseUrl: string, model: string, messages: Array<Record<string, any>>, tools?: Array<Record<string, any>>, instructions?: string, temperature?: number, stream?: boolean, reasoning?: string | null }} request
 * @returns {{ url: string, body: any }}
 */
export function buildRequest(protocol, { baseUrl, model, messages, tools = [], instructions, temperature, stream = false, reasoning = null }) {
  const endpoint = String(baseUrl).replace(/\/$/, '')
  // Model-native reasoning, in the dialect this protocol speaks. Empty when the
  // level is unset or the model does not reason, so the spread is always safe.
  // 'none' is the learned explicit off — it goes to any model, because the
  // provider that asked for it has already stated its rules.
  const effort = reasoning === 'none'
    ? reasoningOffPayload(protocol)
    : reasoningPayload(protocol, model, reasoning, maxTokens())

  if (protocol === 'anthropic') {
    return {
      url: `${endpoint}/messages`,
      body: {
        model,
        max_tokens: maxTokens(),
        system: instructions,
        messages: toAnthropicMessages(messages),
        ...(temperature === undefined ? {} : { temperature }),
        ...effort,
        ...(stream ? { stream: true } : {}),
        ...(tools.length ? { tools: wireToolDefinitions('anthropic', tools) } : {}),
      },
    }
  }

  if (protocol === 'google') {
    return {
      // The streaming endpoint is a different path on the same resource.
      url: `${endpoint}/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
      body: {
        systemInstruction: { parts: [{ text: instructions }] },
        contents: toGoogleContents(messages),
        ...(tools.length ? { tools: wireToolDefinitions('google', tools) } : {}),
        ...(temperature === undefined && !effort.thinkingConfig ? {} : { generationConfig: { ...(temperature === undefined ? {} : { temperature }), ...effort } }),
      },
    }
  }

  return {
    url: `${endpoint}/chat/completions`,
    body: {
      model,
      ...(temperature === undefined ? {} : { temperature }),
      ...effort,
      messages: toOpenAiMessages(messages, instructions),
      // Token counts arrive in the final chunk only when the provider is asked for
      // them; a provider that ignores the option simply reports no usage.
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        ...(tools.length ? { tools: wireToolDefinitions('openai-compatible', tools), tool_choice: 'auto' } : {}),
    },
  }
}

/**
 * Temperature lives top-level for OpenAI/Anthropic but nested under
 * generationConfig for Google — the retry that drops it on a 400 must look
 * in both places, or Gemini models that fix their own sampling retry forever.
 */
export function bodySendsTemperature(body) {
  return body?.temperature !== undefined || body?.generationConfig?.temperature !== undefined
}

export function bodyWithoutTemperature(body) {
  const retryBody = { ...(body ?? {}) }
  delete retryBody.temperature
  if (retryBody.generationConfig) {
    const { temperature: _dropped, ...rest } = retryBody.generationConfig
    retryBody.generationConfig = rest
  }
  return retryBody
}

/**
 * Headers that carry credentials.
 *
 * `auto` follows the protocol's own convention. Any other style is the caller's,
 * @param {string} protocol
 * @param {{ key?: string | null, style?: string, headerName?: string | null, headers?: Record<string, string> }} credentials
 */
export function providerAuthHeaders(protocol, credentials = {}) {
  const headers = { ...(credentials.headers ?? {}) }
  const key = credentials.key ?? null
  const style = credentials.style ?? 'auto'
  const resolved = style === 'auto' ? (protocol === 'anthropic' ? 'x-api-key' : protocol === 'google' ? 'x-goog-api-key' : 'bearer') : style

  if (key && resolved === 'bearer') headers.Authorization = `Bearer ${key}`
  else if (key && resolved === 'x-api-key') headers['x-api-key'] = key
  else if (key && resolved === 'api-key') headers['api-key'] = key
  else if (key && resolved === 'header' && credentials.headerName) headers[credentials.headerName] = key
  if (protocol === 'anthropic') headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01'
  return headers
}

/**
 * Turn a provider's stream into the same shape `parseResponse` returns.
 *
 * Each protocol streams differently: OpenAI sends a `choices[0].delta` per chunk
 * with tool calls arriving as a name and then fragments of JSON; Anthropic sends
 * typed events, with tool input as `input_json_delta`; Google sends whole parts per
 * chunk. They all end up as `{ text, toolCalls, usage }`, so nothing downstream has
 * to know which one it was talking to.
 */
export function createProviderStream(protocol) {
  const events = createSseParser()
  let text = ''
  let usage = null
  /** @type {Array<{ id?: string, name: string, json: string }>} */
  const toolBlocks = []

  const ingestOpenAi = (payload) => {
    if (payload?.usage) usage = normalizeUsage('openai-compatible', payload.usage)
    const choice = payload?.choices?.[0]
    const delta = choice?.delta
    let piece = ''
    if (delta?.content) {
      piece = String(delta.content)
      text += piece
    }
    for (const call of delta?.tool_calls ?? []) {
      const index = Number(call.index ?? 0)
      const entry = toolBlocks[index] ?? (toolBlocks[index] = { name: '', json: '' })
      if (call.id) entry.id = call.id
      // A name can arrive whole or in fragments, and a gateway may resend what it
      // already sent; appending blindly would produce "readread".
      if (call.function?.name && !entry.name.includes(call.function.name)) entry.name += call.function.name
      if (call.function?.arguments) entry.json += call.function.arguments
    }
    return piece
  }

  const ingestAnthropic = (payload) => {
    let piece = ''
    if (payload?.type === 'message_start') {
      usage = normalizeUsage('anthropic', payload.message?.usage)
    } else if (payload?.type === 'content_block_start') {
      const block = payload.content_block
      if (block?.type === 'tool_use') toolBlocks[payload.index ?? toolBlocks.length] = { id: block.id, name: block.name ?? '', json: '' }
    } else if (payload?.type === 'content_block_delta') {
      const delta = payload.delta
      if (delta?.type === 'text_delta' && delta.text) {
        piece = String(delta.text)
        text += piece
      } else if (delta?.type === 'input_json_delta') {
        const entry = toolBlocks[payload.index ?? 0] ?? (toolBlocks[payload.index ?? 0] = { name: '', json: '' })
        entry.json += delta.partial_json ?? ''
      }
    } else if (payload?.type === 'message_delta' && payload.usage) {
      usage = { ...(usage ?? normalizeUsage('anthropic', {})), outputTokens: nonNegative(payload.usage.output_tokens) }
    }
    return piece
  }

  const ingestGoogle = (payload) => {
    if (payload?.usageMetadata) usage = normalizeUsage('google', payload.usageMetadata)
    const parts = payload?.candidates?.[0]?.content?.parts ?? []
    let piece = ''
    for (const part of parts) {
      if (typeof part.text === 'string') {
        piece += part.text
      } else if (part.functionCall) {
        toolBlocks.push({ id: `google-call-${toolBlocks.length}`, name: part.functionCall.name ?? 'unknown', json: JSON.stringify(part.functionCall.args ?? {}) })
      }
    }
    text += piece
    return piece
  }

  const ingest = protocol === 'anthropic' ? ingestAnthropic : protocol === 'google' ? ingestGoogle : ingestOpenAi

  return {
    /** Feed a chunk of the response body; returns any text it completed. */
    push(chunk) {
      let delta = ''
      for (const frame of events.push(chunk)) {
        if (!frame.data || frame.data === '[DONE]') continue
        let payload
        try {
          payload = JSON.parse(frame.data)
        } catch {
          continue
        }
        delta += ingest(payload)
      }
      return delta
    },
    /** The normalized result, identical in shape to a non-streamed reply. */
    finish() {
      const toolCalls = toolBlocks.filter(Boolean).map((block, index) => {
        if (protocol === 'google') {
          const parsed = safeParseJson(block.json)
          return { id: block.id ?? `google-call-${index}`, name: block.name || 'unknown', arguments: parsed.value, invalidJson: parsed.invalid }
        }
        const parsed = safeParseJson(block.json || '{}')
        return { id: block.id ?? `call-${index}`, name: block.name || 'unknown', arguments: parsed.value, invalidJson: parsed.invalid }
      })
      return { text: text.trim(), toolCalls, usage }
    },
  }
}

export function parseResponse(protocol, payload) {
  if (protocol === 'anthropic') {
    const blocks = Array.isArray(payload?.content) ? payload.content : []
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('').trim()
    const toolCalls = blocks.filter((block) => block.type === 'tool_use').map((block) => ({ id: block.id, name: block.name ?? 'unknown', arguments: block.input ?? {} }))
    return { text, toolCalls, usage: normalizeUsage(protocol, payload?.usage) }
  }

  if (protocol === 'google') {
    const parts = payload?.candidates?.[0]?.content?.parts ?? []
    const text = parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join('').trim()
    const toolCalls = parts
      .filter((part) => part.functionCall)
      .map((part, index) => ({ id: `google-call-${index}`, name: part.functionCall.name ?? 'unknown', arguments: part.functionCall.args ?? {} }))
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
const defaultMaxAttempts = 3
const requestTimeoutMs = () => Number(process.env.FULKRUM_PROVIDER_TIMEOUT_MS ?? 60_000)
const maxResponseBytes = () => Number(process.env.FULKRUM_MAX_PROVIDER_BYTES ?? 8_000_000)

// Read where they are used rather than at import, so a caller can configure them
// before the first call and a test does not have to reload the module.
const configuredMaxAttempts = () => Number(process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS ?? defaultMaxAttempts)
const configuredConcurrency = () => Math.max(Number(process.env.FULKRUM_PROVIDER_MAX_CONCURRENCY ?? 3), 1)

/**
 * One provider at a time, up to a limit.
 *
 * Parallel readers share a provider, and a slow one otherwise holds a worker for
 * the whole timeout on every attempt. Queuing here bounds how many are in flight
 * rather than letting them pile up.
 */
export function createLimiter(max = configuredConcurrency()) {
  let active = 0
  const queue = []
  return {
    async run(task) {
      if (active < max) {
        active += 1
      } else {
        // The slot is handed over inside the releaser, which is why nothing is
        // incremented here.
        await new Promise((resolve) => queue.push(resolve))
      }
      try {
        return await task()
      } finally {
        active -= 1
        const resume = queue.shift()
        if (resume) {
          active += 1
          resume()
        }
      }
    },
  }
}

/**
 * A breaker per provider, half-open after a cooldown.
 *
 * Without one, a provider that is down keeps costing every worker a full timeout
 * per attempt. Only failures that were worth retrying count: a 400 says the
 * request was wrong, not that the provider is unavailable.
 */
export function createBreaker({ threshold = Number(process.env.FULKRUM_BREAKER_THRESHOLD ?? 3), cooldownMs = Number(process.env.FULKRUM_BREAKER_COOLDOWN_MS ?? 30_000), now = () => Date.now() } = {}) {
  const states = new Map()
  const stateFor = (key) => states.get(key) ?? { failures: 0, openUntil: 0, probing: false }
  return {
    /** Why the provider is being skipped, or null when a call may proceed. */
    reject(key, label) {
      const state = stateFor(key)
      const nowMs = now()
      if (state.openUntil === 0) return null
      if (nowMs < state.openUntil) {
        return `${label} is being skipped for another ${Math.max(Math.ceil((state.openUntil - nowMs) / 1000), 1)}s after repeated failures.`
      }
      // Half-open: the cooldown has passed, so exactly one call is let through to
      // find out whether the provider recovered.
      if (state.probing) return `${label} is still being probed after repeated failures.`
      state.probing = true
      states.set(key, state)
      return null
    },
    succeeded(key) {
      states.set(key, { failures: 0, openUntil: 0, probing: false })
    },
    failed(key) {
      const state = stateFor(key)
      // A failed probe re-opens immediately: the provider just answered badly.
      const wasProbing = state.probing
      state.probing = false
      state.failures += 1
      if (wasProbing || state.failures >= threshold) {
        state.openUntil = now() + cooldownMs
        state.failures = 0
      }
      states.set(key, state)
    },
    state(key) {
      const state = stateFor(key)
      return { failures: state.failures, openUntil: state.openUntil, open: state.openUntil > now() }
    },
  }
}

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
  /**
   * @param {string} message
   * @param {{ status?: number, retryable?: boolean, retryAfter?: string | null }} [options]
   */
  constructor(message, { status, retryable, retryAfter = null } = {}) {
    super(message)
    this.status = status
    this.retryable = retryable
    this.retryAfter = retryAfter
  }
}

export function createModelCaller({ providerRegistry, allowPrivate = privateProviderUrlsAllowed() }) {
  const limiter = createLimiter()
  const breaker = createBreaker()
  /**
   * One request, to an address that was validated and is then pinned: the name is
   * resolved once, the socket goes to that address, and the response is read with
   * a byte cap instead of being buffered whole. Redirects are not followed here —
   * a provider that answers 3xx is an error, not a new destination.
   */
  const requestOnce = async (url, { method, headers, body, allowPrivate: allowRequest = allowPrivate }) => {
    let response
    try {
      response = await pinnedRequest(url, { method, headers, body, allowPrivate: allowRequest, maxBytes: maxResponseBytes(), timeoutMs: requestTimeoutMs() })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const timedOut = name === 'AbortError' || name === 'TimeoutError'
      throw new ProviderError(timedOut ? `Provider request timed out after ${requestTimeoutMs()}ms.` : `Provider request failed: ${error instanceof Error ? error.message : 'unknown error'}`, { retryable: true })
    }

    if (response.truncated) {
      throw new ProviderError(`The provider response exceeded ${maxResponseBytes()} bytes and was cut off.`, { retryable: false })
    }

    let payload = /** @type {any} */ ({})
    try {
      payload = JSON.parse(response.text)
    } catch {
      payload = {}
    }

    if (!response.ok) {
      const message = payload?.error?.message ?? payload?.error ?? `Provider returned ${response.status}`
      throw new ProviderError(String(message).slice(0, 500), { status: response.status, retryable: retryableStatuses.has(response.status), retryAfter: response.headers['retry-after'] ?? null })
    }
    return payload
  }

  const requestWithRetry = async (attempt, url, options) => {
    const maxAttempts = configuredMaxAttempts()
    try {
      return await requestOnce(url, options)
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable || attempt + 1 >= maxAttempts) throw error
      await sleep(retryDelayMs(attempt, error.retryAfter))
      return requestWithRetry(attempt + 1, url, options)
    }
  }

  /**
   * One streamed request, parsed as it arrives.
   *
   * A failure after the first token is reported rather than retried: the caller has
   * already been shown part of the reply, and a retry would duplicate it on screen.
   */
  const streamOnce = async (url, requestOptions, protocol, onDelta, sawDelta) => {
    const stream = await pinnedStream(url, {
      method: 'POST',
      headers: requestOptions.headers,
      body: requestOptions.body,
      allowPrivate: requestOptions.allowPrivate,
      maxBytes: maxResponseBytes(),
      timeoutMs: requestTimeoutMs(),
    })

    if (!stream.ok) {
      // Read enough of the error body to report the provider's own message.
      let detail = ''
      for await (const chunk of stream) {
        detail += chunk.toString('utf8')
        if (detail.length > 4_000) break
      }
      let payload = /** @type {any} */ ({})
      try {
        payload = JSON.parse(detail)
      } catch {
        payload = {}
      }
      const message = payload?.error?.message ?? payload?.error ?? `Provider returned ${stream.status}`
      throw new ProviderError(String(message).slice(0, 500), { status: stream.status, retryable: retryableStatuses.has(stream.status), retryAfter: stream.headers['retry-after'] ?? null })
    }

    const parser = createProviderStream(protocol)
    for await (const chunk of stream) {
      const delta = parser.push(chunk.toString('utf8'))
      if (delta) {
        sawDelta.value = true
        onDelta(delta)
      }
    }
    if (stream.truncated) throw new ProviderError(`The provider response exceeded ${maxResponseBytes()} bytes and was cut off.`, { retryable: false })
    return parser.finish()
  }

  const requestStream = async (url, requestOptions, protocol, onDelta) => {
    const sawDelta = { value: false }
    const attempt = async (attemptsLeft, options) => {
      try {
        return await streamOnce(url, options, protocol, onDelta, sawDelta)
      } catch (error) {
        const worthRetrying = error instanceof ProviderError && error.retryable === true && !sawDelta.value && attemptsLeft > 1
        if (!worthRetrying) throw error
        await sleep(retryDelayMs(configuredMaxAttempts() - attemptsLeft, error.retryAfter))
        return attempt(attemptsLeft - 1, options)
      }
    }
    return attempt(configuredMaxAttempts(), requestOptions)
  }

  /**
   * Call a provider and normalize the answer, including tool calls.
   * Returns { text, toolCalls, usage }.
   *
   * With `onDelta`, the reply is streamed: each piece of text is handed over as it
   * arrives, and the return value is the same shape as a buffered call.
   *
   * @param {any} provider
   * @param {string} model
   * @param {Array<Record<string, any>>} messages
   * @param {{ tools?: Array<Record<string, any>>, instructions?: string, onDelta?: (delta: string) => void, reasoning?: string | null }} [options]
   */
  const callModel = async (provider, model, messages, { tools = [], instructions, onDelta, reasoning = null } = {}) => {
    const credentials = providerRegistry.credentials(provider)
    // A provider marked as local is allowed to resolve to a private address; the
    // global flag stays as the fallback for everyone else. The address is checked
    // and pinned by the request itself, per hop and per attempt.
    const allow = credentials.allowPrivate || allowPrivate
    const sampling = providerRegistry.sampling(provider, model)
    const streaming = typeof onDelta === 'function'
    // A provider that reasons by default can refuse tools unless told off out
    // loud; the lesson is stored with its settings and applied before the ask.
    const learnedReasoningOff = tools.length ? providerRegistry.reasoningWithTools?.(provider) : null
    const effectiveReasoning = learnedReasoningOff === 'none' ? 'none' : reasoning
    const { url, body } = buildRequest(provider.protocol, { baseUrl: provider.baseUrl, model, messages, tools, instructions, temperature: sampling.temperature, stream: streaming, reasoning: effectiveReasoning })
    const headers = { 'Content-Type': 'application/json', ...providerAuthHeaders(provider.protocol, credentials) }
    const requestOptions = { method: 'POST', headers, body: JSON.stringify(body), allowPrivate: allow }

    const skipReason = breaker.reject(provider.id, provider.label)
    if (skipReason) throw new ProviderError(`${provider.label} is being skipped: ${skipReason}`, { status: 503, retryable: false })

    let payload
    try {
      payload = await limiter.run(async () => {
        const send = (options) => (streaming ? requestStream(url, options, provider.protocol, onDelta) : requestWithRetry(0, url, options))
        try {
          return await send(requestOptions)
        } catch (error) {
          // A model that fixes its own sampling settings answers 400 to any
          // temperature we send. Retry once without it and remember the answer, so
          // a model this application has never seen costs at most one rejected call.
          const rejectedTemperature = bodySendsTemperature(body) && error instanceof ProviderError && error.status === 400 && /temperature/i.test(error.message)
          if (rejectedTemperature) {
            const retried = await send({ ...requestOptions, body: JSON.stringify(bodyWithoutTemperature(body)) })
            providerRegistry.rememberTemperature?.(provider, 'omit')
            return retried
          }
          // "Function tools with reasoning_effort are not supported… set
          // reasoning_effort to 'none'": the provider reasons by default and
          // refuses tools unless the request says off explicitly — absence is
          // not off for it. The retry says the word in its dialect, and the
          // lesson is remembered so the conflict costs one call ever.
          const rejectedReasoningWithTools = tools.length && error instanceof ProviderError && error.status === 400 && /reasoning/i.test(error.message)
          if (rejectedReasoningWithTools) {
            const retry = buildRequest(provider.protocol, { baseUrl: provider.baseUrl, model, messages, tools, instructions, temperature: sampling.temperature, stream: streaming, reasoning: 'none' })
            const retried = await send({ ...requestOptions, body: JSON.stringify(retry.body) })
            providerRegistry.rememberReasoningWithTools?.(provider)
            return retried
          }
          throw error
        }
      })
    } catch (error) {
      // Only failures worth retrying count against the provider's health.
      if (error instanceof ProviderError && (error.retryable || error.status === undefined)) breaker.failed(provider.id)
      throw error
    }
    breaker.succeeded(provider.id)
    // Strict parse-back against what was declared this turn: wire names become
    // real tools, and anything else stays exactly as the model sent it so the
    // broker rejects what it does not know. Both the streamed and the buffered
    // paths land here, so neither can bypass the map.
    if (streaming) {
      return { ...payload, toolCalls: resolveToolNames(payload.toolCalls, tools) }
    }
    const parsed = parseResponse(provider.protocol, payload)
    return { ...parsed, toolCalls: resolveToolNames(parsed.toolCalls, tools) }
  }

  return { callModel, buildRequest, breaker }
}
