import { randomUUID } from 'node:crypto'
import { createApp } from './app.mjs'
import { FulkrumStore } from './store.mjs'
import { createProviderRegistry } from './providerRegistry.mjs'
import { createRunOrchestrator } from './orchestrator.mjs'
import { FulkrumToolBroker } from './toolBroker.mjs'
import { privateProviderUrlsAllowed, validateOutboundUrl } from './networkPolicy.mjs'
import { reconcileInterruptedRuns } from './recovery.mjs'

const port = Number(process.env.FULKRUM_API_PORT ?? 8787)
const ownerId = `bridge-${randomUUID().slice(0, 8)}`
const allowedOrigins = new Set((process.env.FULKRUM_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean))

const systemPrompt = `You are Fulkrum's Head AI. You are the supervisor of a small team with a research worker and a build worker. The user speaks to you in a shared project chat. Keep the conversation practical and concise. Explain the plan, identify the next decision, and never claim a worker completed something unless the system has reported it. Before execution, help the user shape and approve a plan. During execution, coordinate the workers and surface disagreements.`

const store = new FulkrumStore()
const providerRegistry = createProviderRegistry(store)
const toolBroker = new FulkrumToolBroker()

const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const maxAttempts = Number(process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS ?? 3)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function retryDelay(attempt, retryAfter) {
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

class ProviderError extends Error {
  constructor(message, { status, retryable, retryAfter = null } = {}) {
    super(message)
    this.status = status
    this.retryable = retryable
    this.retryAfter = retryAfter
  }
}

async function requestJson(url, options, { timeoutMs = 60_000 } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(url, { ...options, redirect: 'manual', signal: controller.signal })
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? `Provider request timed out after ${timeoutMs}ms.` : `Provider request failed: ${error instanceof Error ? error.message : 'unknown error'}`
    throw new ProviderError(message, { retryable: true })
  } finally {
    clearTimeout(timeout)
  }

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const providerMessage = payload?.error?.message ?? payload?.error ?? `Provider returned ${response.status}`
    throw new ProviderError(String(providerMessage).slice(0, 500), { status: response.status, retryable: retryableStatuses.has(response.status), retryAfter: response.headers.get('retry-after') })
  }
  return payload
}

async function withRetry(attempt, url, options, settings) {
  try {
    return await requestJson(url, options, settings)
  } catch (error) {
    const retryable = error instanceof ProviderError && error.retryable
    if (!retryable || attempt + 1 >= maxAttempts) throw error
    await sleep(retryDelay(attempt, error.retryAfter))
    return withRetry(attempt + 1, url, options, settings)
  }
}

async function callOpenAiCompatible(provider, model, messages, instructions = systemPrompt) {
  const baseUrl = await validateOutboundUrl(provider.baseUrl, { allowPrivate: privateProviderUrlsAllowed() })
  const payload = await withRetry(0, `${baseUrl.toString().replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${providerRegistry.secret(provider)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: instructions }, ...messages], temperature: 0.3 }),
  })
  return payload.choices?.[0]?.message?.content
}

async function callAnthropic(provider, model, messages, instructions = systemPrompt) {
  const payload = await withRetry(0, 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': providerRegistry.secret(provider),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: 1200, system: instructions, messages }),
  })
  return payload.content?.find((item) => item.type === 'text')?.text
}

async function callGoogle(provider, model, messages, instructions = systemPrompt) {
  const baseUrl = await validateOutboundUrl(provider.baseUrl, { allowPrivate: privateProviderUrlsAllowed() })
  const payload = await withRetry(0, `${baseUrl.toString().replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(providerRegistry.secret(provider))}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instructions }] },
      contents: messages.map((item) => ({
        role: item.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: item.content }],
      })),
      generationConfig: { temperature: 0.3 },
    }),
  })
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('')
}

async function callProvider(provider, model, messages, instructions = systemPrompt) {
  if (provider.protocol === 'anthropic') return callAnthropic(provider, model, messages, instructions)
  if (provider.protocol === 'google') return callGoogle(provider, model, messages, instructions)
  return callOpenAiCompatible(provider, model, messages, instructions)
}

const orchestrator = createRunOrchestrator({
  store,
  providerRegistry,
  toolBroker,
  ownerId,
  callModel: (provider, model, messages, instructions) => callProvider(provider, model, messages, instructions),
})

const app = createApp({ store, toolBroker, providerRegistry, orchestrator, callProvider, allowedOrigins, ownerId })

const interrupted = reconcileInterruptedRuns({ store, log: (message) => console.log(`[fulkrum] ${message}`) })
if (interrupted.interrupted.length) {
  console.log(`[fulkrum] ${interrupted.interrupted.length} run(s) were interrupted by a previous shutdown; resume or cancel them from the control room.`)
}

const { pruned } = store.pruneToolOutputs()
if (pruned > 0) console.log(`[fulkrum] pruned ${pruned} stored tool output(s) past the retention window`)

app.server.listen(port, '127.0.0.1', () => {
  console.log(`Fulkrum API bridge listening on http://127.0.0.1:${port}`)
  console.log(`[fulkrum] schema version ${store.stats().schemaVersion}, owner ${ownerId}`)
})

let shuttingDown = false

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[fulkrum] received ${signal}; draining`)
  app.beginDraining(signal)
  const force = setTimeout(() => {
    // Give in-flight steps a moment to record what they did, then close anyway.
    try {
      store.close()
    } catch {
      // Already closed.
    }
    process.exit(0)
  }, 5_000)
  force.unref()

  app.server.closeIdleConnections?.()
  app.server.close(() => {
    clearTimeout(force)
    store.close()
    console.log('[fulkrum] stopped')
    process.exit(0)
  })
}

function fatal(kind, error) {
  console.error(`[fulkrum] ${kind}:`, error)
  if (shuttingDown) return
  shuttingDown = true
  // Stop accepting work, then die loudly. Continuing after an unknown failure
  // risks writing state nobody can interpret later.
  app.beginDraining(kind)
  app.server.close(async () => {
    store.close()
    process.exitCode = 1
  })
  setTimeout(() => {
    try {
      store.close()
    } catch {
      // Already closed.
    }
    process.exit(1)
  }, 3_000).unref()
}

process.on('unhandledRejection', (reason) => fatal('unhandled rejection', reason))
process.on('uncaughtException', (error) => fatal('uncaught exception', error))
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
