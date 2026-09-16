import { randomUUID } from 'node:crypto'
import { createApp } from './app.mjs'
import { FulkrumStore } from './store.mjs'
import { createProviderRegistry } from './providerRegistry.mjs'
import { createRunOrchestrator } from './orchestrator.mjs'
import { FulkrumToolBroker } from './toolBroker.mjs'
import { createModelCaller } from './modelCall.mjs'
import { createPlanService } from './planService.mjs'
import { createPricing } from './pricing.mjs'
import { createExecutionRuntime } from './execution.mjs'
import { privateProviderUrlsAllowed } from './networkPolicy.mjs'
import { reconcileInterruptedRuns } from './recovery.mjs'

const port = Number(process.env.FULKRUM_API_PORT ?? 8787)
const ownerId = `bridge-${randomUUID().slice(0, 8)}`
const allowedOrigins = new Set((process.env.FULKRUM_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean))

const systemPrompt = `You are Fulkrum's Head AI. You are the supervisor of a small team with a research worker and a build worker. The user speaks to you in a shared project chat. Keep the conversation practical and concise. Explain the plan, identify the next decision, and never claim a worker completed something unless the system has reported it. Before execution, help the user shape and approve a plan. During execution, coordinate the workers and surface disagreements.`

const store = new FulkrumStore()
const providerRegistry = createProviderRegistry(store)
const execution = createExecutionRuntime()
const toolBroker = new FulkrumToolBroker({ execution })
const pricing = createPricing()
const modelCaller = createModelCaller({ providerRegistry, allowPrivate: privateProviderUrlsAllowed() })

// Chat has no tools: the Head plans and answers. Workers get tools through the
// orchestrator, restricted to their own role's allowlist. Both return usage so
// every call can be priced.
const callProvider = (provider, model, messages, instructions) => modelCaller.callModel(provider, model, messages, { tools: [], instructions: instructions ?? systemPrompt })
const callModel = (provider, model, messages, options = {}) => modelCaller.callModel(provider, model, messages, { ...options, instructions: options.instructions ?? systemPrompt })

const planService = createPlanService({ store, providerRegistry, pricing, callModel: (provider, model, messages, options) => modelCaller.callModel(provider, model, messages, options) })

const orchestrator = createRunOrchestrator({
  store,
  providerRegistry,
  toolBroker,
  ownerId,
  callModel,
  pricing,
})

const app = createApp({ store, toolBroker, providerRegistry, orchestrator, callProvider, planService, pricing, execution, allowedOrigins, ownerId })

const interrupted = reconcileInterruptedRuns({ store, log: (message) => console.log(`[fulkrum] ${message}`) })
if (interrupted.interrupted.length) {
  console.log(`[fulkrum] ${interrupted.interrupted.length} run(s) were interrupted by a previous shutdown; resume or cancel them from the control room.`)
}

const { pruned } = store.pruneToolOutputs()
if (pruned > 0) console.log(`[fulkrum] pruned ${pruned} stored tool output(s) past the retention window`)

// A daily copy, written from the live database with VACUUM INTO. A corrupted file
// with no backup is the one failure this store cannot recover from on its own.
const backupIntervalHours = Number(process.env.FULKRUM_BACKUP_INTERVAL_HOURS ?? 24)
if (Number.isFinite(backupIntervalHours) && backupIntervalHours > 0) {
  try {
    const { newestAgeMs } = store.backupStatus()
    if (newestAgeMs === null || newestAgeMs > backupIntervalHours * 3_600_000) {
      const result = store.backup()
      console.log(`[fulkrum] database backed up to ${result.path}`)
    }
  } catch (error) {
    console.log(`[fulkrum] could not back up the database: ${error instanceof Error ? error.message : error}`)
  }
}

app.server.listen(port, '127.0.0.1', async () => {
  console.log(`Fulkrum API bridge listening on http://127.0.0.1:${port}`)
  console.log(`[fulkrum] schema version ${store.stats().schemaVersion}, owner ${ownerId}, prices ${pricing.version} (${pricing.known} models)`)
  // Say this at boot rather than leaving it to be discovered: it is the one
  // control this application deliberately does not have.
  console.log('[fulkrum] note: the local API has no authentication. It binds loopback and refuses unapproved browser origins,')
  console.log('[fulkrum]       so this is CSRF protection, not access control — any process on this machine can call it,')
  console.log('[fulkrum]       including approving tool calls. Do not run untrusted code alongside it.')
  const runBudget = Number(process.env.FULKRUM_RUN_BUDGET_USD ?? 0)
  const dayBudget = Number(process.env.FULKRUM_DAILY_BUDGET_USD ?? 0)
  if (runBudget || dayBudget) console.log(`[fulkrum] budgets: per run $${runBudget || 'unset'}, per day $${dayBudget || 'unset'}`)

  // Report the boundary at boot rather than at the first command, so an
  // unavailable engine is a startup fact instead of a surprise mid-run.
  const boundary = await execution.status()
  if (boundary.available) {
    console.log(`[fulkrum] execution boundary: ${boundary.label} ${boundary.version}, image ${boundary.image}, network ${boundary.network}`)
    if (boundary.imageDigest) console.log(`[fulkrum] runner image digest ${boundary.imageDigest}`)
    if (!boundary.imagePinned) {
      console.log('[fulkrum] note: the runner image is identified by tag. A tag can be moved, and this image is part of the')
      console.log(`[fulkrum]       boundary — pin it with FULKRUM_RUNNER_IMAGE=${boundary.imageDigest ?? '<image>@sha256:<digest>'}`)
    }
  } else {
    console.log('[fulkrum] execution is DISABLED: agent commands cannot run.')
    console.log(`[fulkrum]   ${boundary.reason}`)
    console.log(`[fulkrum]   ${boundary.hint}`)
  }
})

let shuttingDown = false

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[fulkrum] received ${signal}; draining`)
  // Draining refuses new work and ends open event streams, so the server can
  // actually close instead of waiting on a stream that never ends.
  app.beginDraining(signal)
  const closeStore = () => {
    try {
      store.close()
    } catch {
      // Already closed.
    }
  }
  const force = setTimeout(() => {
    // Give in-flight steps a moment to record what they did, then close anyway.
    closeStore()
    process.exit(0)
  }, 5_000)
  force.unref()

  app.server.closeIdleConnections?.()
  app.server.close(() => {
    // Workers write to the store, so it closes after they stop rather than
    // underneath them. A run still mid-step at the 5 s mark is stopped by the
    // timer above; its lease makes that visible on the next start.
    Promise.allSettled([...orchestrator.activeRuns.values()]).finally(() => {
      clearTimeout(force)
      closeStore()
      console.log('[fulkrum] stopped')
      process.exit(0)
    })
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
