import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.mjs'
import { resolveSettings } from './config.mjs'
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
import { backupIfStale } from './backup.mjs'
import { applySavedSettings } from './settings.mjs'
import { createScheduler } from './schedules.mjs'
import { seedBuiltinCatalog } from './marketplace-import.mjs'

// Read once, validated, with any problems reported below.
const bootSettings = resolveSettings()
const bootDatabasePath = bootSettings.values.FULKRUM_DB_PATH
  || path.join(bootSettings.values.FULKRUM_DATA_DIR || 'data', 'fulkrum.sqlite')

// Reported by /api/status and the OpenAPI document, so a running instance can say
// which version it is rather than being guessed at.
const version = (() => {
  try {
    return JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const systemPrompt = `You are Fulkrum's Head AI. You are the supervisor of a small team with a research worker and a build worker. The user speaks to you in a shared project chat. Keep the conversation practical and concise. Explain the plan, identify the next decision, and never claim a worker completed something unless the system has reported it. Before execution, help the user shape and approve a plan. During execution, coordinate the workers and surface disagreements.`

const store = new FulkrumStore(bootDatabasePath)
// Values saved through the app land here on the way in: anything the
// environment left empty is filled from the database, so the resolved
// settings below already include in-app changes from previous boots.
applySavedSettings(store, { log: (message) => console.log(message) })
const resolved = resolveSettings()
// Problems from either pass are startup facts: the first covers the database
// location itself, the second everything applied on top of it.
const settings = resolved.values
const settingProblems = [...bootSettings.problems, ...resolved.problems]
const port = settings.FULKRUM_API_PORT
const ownerId = `bridge-${randomUUID().slice(0, 8)}`
const allowedOrigins = new Set(settings.FULKRUM_ALLOWED_ORIGINS)
const providerRegistry = createProviderRegistry(store)
const execution = createExecutionRuntime()
const toolBroker = new FulkrumToolBroker({ execution, workspaceRoot: settings.FULKRUM_WORKSPACE_ROOT || process.cwd() })
const pricing = createPricing()
const modelCaller = createModelCaller({ providerRegistry, allowPrivate: privateProviderUrlsAllowed() })

// Chat has no tools: the Head plans and answers. Workers get tools through the
// orchestrator, restricted to their own role's allowlist. Both return usage so
// every call can be priced.
const callProvider = (provider, model, messages, options = {}) => modelCaller.callModel(provider, model, messages, { tools: [], instructions: options.instructions ?? systemPrompt, onDelta: options.onDelta, reasoning: options.reasoning ?? null })
const callModel = (provider, model, messages, options = {}) => modelCaller.callModel(provider, model, messages, { ...options, instructions: options.instructions ?? systemPrompt })

const orchestrator = createRunOrchestrator({
  store,
  providerRegistry,
  toolBroker,
  ownerId,
  callModel,
  pricing,
})

const planService = createPlanService({ store, providerRegistry, pricing, workspaceRoot: toolBroker.workspaceRoot, callModel: (provider, model, messages, options) => modelCaller.callModel(provider, model, messages, options), checkBudget: async (runId) => { orchestrator.assertBudget(runId) } })

const app = createApp({
  store,
  toolBroker,
  providerRegistry,
  orchestrator,
  callProvider,
  planService,
  pricing,
  execution,
  allowedOrigins,
  ownerId,
  serveUi: Boolean(settings.FULKRUM_SERVE_UI),
  distDir: settings.FULKRUM_DIST_DIR || 'dist',
  breaker: modelCaller.breaker,
  version,
})

// A setting that could not be used as given is a startup fact, not something to
// discover later through a puzzling failure.
if (settingProblems.length) {
  console.log(`[fulkrum] ${settingProblems.length} setting(s) could not be used as given:`)
  for (const problem of settingProblems) {
    console.log(`[fulkrum]   ${problem.name}: ${problem.message} (using ${JSON.stringify(problem.using)})`)
  }
}

const interrupted = reconcileInterruptedRuns({ store, log: (message) => console.log(`[fulkrum] ${message}`) })
if (interrupted.interrupted.length) {
  console.log(`[fulkrum] ${interrupted.interrupted.length} run(s) were interrupted by a previous shutdown; resume or cancel them from the control room.`)
}

const { pruned } = store.pruneToolOutputs()
if (pruned > 0) console.log(`[fulkrum] pruned ${pruned} stored tool output(s) past the retention window`)

try {
  const seedRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'marketplace-seed')
  const seed = seedBuiltinCatalog({ seedDir: process.env.FULKRUM_MARKETPLACE_SEED_DIR || seedRoot })
  if (seed.seeded.length) console.log(`[fulkrum] staged ${seed.seeded.length} builtin marketplace skill(s): ${seed.seeded.join(', ')}`)
} catch (error) {
  console.log(`[fulkrum] marketplace seed skipped: ${error instanceof Error ? error.message : error}`)
}

// A daily copy, written from the live database with VACUUM INTO. A corrupted file
// with no backup is the one failure this store cannot recover from on its own.
// The timer below keeps that true for a bridge that runs for weeks, not just
// for one that restarts daily.
const backupIntervalHours = Number(settings.FULKRUM_BACKUP_INTERVAL_HOURS ?? 24)
try {
  backupIfStale(store, { intervalHours: backupIntervalHours, log: (message) => console.log(message) })
} catch (error) {
  console.log(`[fulkrum] could not back up the database: ${error instanceof Error ? error.message : error}`)
}
const backupTimer = setInterval(() => {
  try {
    backupIfStale(store, { intervalHours: backupIntervalHours, log: (message) => console.log(message) })
  } catch (error) {
    console.log(`[fulkrum] could not back up the database: ${error instanceof Error ? error.message : error}`)
  }
}, 3_600_000)
backupTimer.unref?.()

// Schedules fire playbooks while the bridge runs — there is no daemon, so a
// stopped bridge fires nothing, and a restart fires whatever came due. The
// tick is best-effort and self-recording; see server/schedules.mjs.
const scheduler = createScheduler({ store, orchestrator, workspaceRoot: toolBroker.workspaceRoot })
scheduler.start()

app.server.listen(port, '127.0.0.1', async () => {
  console.log(`Fulkrum API bridge listening on http://127.0.0.1:${port}`)
  if (app.servingUi) console.log(`[fulkrum] serving the built UI from ${path.resolve(settings.FULKRUM_DIST_DIR || 'dist')} — open http://127.0.0.1:${port}/`)
  else console.log(`[fulkrum] the UI is not served here; run \`npm run dev\` for the dev server, or set FULKRUM_SERVE_UI=1 after a build`)
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
    console.log(`[fulkrum] execution boundary: ${boundary.label} ${boundary.version}, image ${boundary.image}, network ${boundary.network}, runtime ${boundary.runtime ?? 'default'}`)
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
  clearInterval(backupTimer)
  try {
    scheduler.stop()
  } catch {
    // Never constructed or already stopped; shutdown must not depend on it.
  }
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
