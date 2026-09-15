import { randomUUID } from 'node:crypto'
import { createApp } from './app.mjs'
import { FulkrumStore } from './store.mjs'
import { createProviderRegistry } from './providerRegistry.mjs'
import { createRunOrchestrator } from './orchestrator.mjs'
import { FulkrumToolBroker } from './toolBroker.mjs'
import { createModelCaller } from './modelCall.mjs'
import { createPlanService } from './planService.mjs'
import { privateProviderUrlsAllowed } from './networkPolicy.mjs'
import { reconcileInterruptedRuns } from './recovery.mjs'

const port = Number(process.env.FULKRUM_API_PORT ?? 8787)
const ownerId = `bridge-${randomUUID().slice(0, 8)}`
const allowedOrigins = new Set((process.env.FULKRUM_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean))

const systemPrompt = `You are Fulkrum's Head AI. You are the supervisor of a small team with a research worker and a build worker. The user speaks to you in a shared project chat. Keep the conversation practical and concise. Explain the plan, identify the next decision, and never claim a worker completed something unless the system has reported it. Before execution, help the user shape and approve a plan. During execution, coordinate the workers and surface disagreements.`

const store = new FulkrumStore()
const providerRegistry = createProviderRegistry(store)
const toolBroker = new FulkrumToolBroker()
const modelCaller = createModelCaller({ providerRegistry, allowPrivate: privateProviderUrlsAllowed() })

// Chat has no tools: the Head plans and answers. Workers get tools through the
// orchestrator, restricted to their own role's allowlist.
const callProvider = (provider, model, messages, instructions) => modelCaller.callText(provider, model, messages, instructions ?? systemPrompt)
const callModel = (provider, model, messages, options = {}) => modelCaller.callModel(provider, model, messages, { ...options, instructions: options.instructions ?? systemPrompt })

const planService = createPlanService({ store, providerRegistry, callModel: (provider, model, messages, options) => modelCaller.callModel(provider, model, messages, options) })

const orchestrator = createRunOrchestrator({
  store,
  providerRegistry,
  toolBroker,
  ownerId,
  callModel,
})

const app = createApp({ store, toolBroker, providerRegistry, orchestrator, callProvider, planService, allowedOrigins, ownerId })

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
  app.server.close(() => {
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
