import { realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.mjs'
import { createModelCaller } from '../server/modelCall.mjs'
import { createProviderRegistry } from '../server/providerRegistry.mjs'
import { createRunOrchestrator } from '../server/orchestrator.mjs'
import { createPlanService } from '../server/planService.mjs'
import { createPricing } from '../server/pricing.mjs'
import { FulkrumStore } from '../server/store.mjs'
import { FulkrumToolBroker } from '../server/toolBroker.mjs'

export async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'fulkrum-test-'))
  try {
    // Hand out the real path. Temp directories on Windows are routinely reached
    // through an 8.3 short name (RUNNER~1 on a CI runner), and the tools resolve
    // containment on real paths, so a test comparing against the spelled path
    // would be comparing two different strings for the same directory.
    return await callback(realpathSync.native(directory))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** A workspace with the files the worker definitions reach for, plus bait. */
export async function withWorkspace(callback) {
  return withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, 'src'), { recursive: true })
    await writeFile(path.join(directory, 'README.md'), '# Fixture readme\n', 'utf8')
    await writeFile(path.join(directory, 'package.json'), '{"name":"fixture"}\n', 'utf8')
    await writeFile(path.join(directory, 'src', 'notes.txt'), 'fixture note content\n', 'utf8')
    await writeFile(path.join(directory, '.env.local'), 'SECRET_VALUE=do-not-read\n', 'utf8')
    return callback(directory)
  })
}

export async function withStore(callback) {
  return withTempDirectory(async (directory) => {
    const store = new FulkrumStore(path.join(directory, 'fulkrum.sqlite'))
    try {
      return await callback(store, directory)
    } finally {
      store.close()
    }
  })
}

/**
 * Boot the real API bridge on an ephemeral port. Tests drive it over HTTP so
 * they exercise routing, guards, and persistence together.
 *
 * `model` scripts the model's replies, which is how the tool-calling loop is
 * tested without a network call.
 */
/**
 * @param {(context: any) => Promise<any>} callback
 * @param {{ workspaceRoot?: string, callProvider?: any, model?: any, pricing?: any, realModelCall?: boolean, serveUi?: boolean, distDir?: string }} [options]
 */
export async function withServer(callback, { workspaceRoot, callProvider, model, pricing, realModelCall = false, serveUi = false, distDir = 'dist' } = {}) {
  const directory = workspaceRoot ?? (await mkdtemp(path.join(tmpdir(), 'fulkrum-api-')))
  const store = new FulkrumStore(path.join(directory, 'fulkrum.sqlite'))
  const toolBroker = new FulkrumToolBroker({ workspaceRoot: directory, httpAllowlist: [] })
  const providerRegistry = createProviderRegistry(store)
  // A real caller builds the actual wire request — URL, headers, sampling — which
  // is what the provider tests need to inspect. Everything else is stubbed.
  const realCaller = realModelCall ? createModelCaller({ providerRegistry }) : null
  const modelCall = model ?? (async () => ({ text: 'stub model output', toolCalls: [], usage: null }))
  const activePricing = pricing ?? createPricing()
  const orchestrator = createRunOrchestrator({
    store,
    providerRegistry,
    toolBroker,
    ownerId: 'test-owner',
    pricing: activePricing,
    callModel: (provider, modelName, messages, options) => modelCall({ provider, model: modelName, messages, options }),
  })
  const planService = createPlanService({
    store,
    providerRegistry,
    pricing: activePricing,
    callModel: (provider, modelName, messages, options) => modelCall({ provider, model: modelName, messages, options }),
    checkBudget: async (runId) => { orchestrator.assertBudget(runId) },
  })
  const app = createApp({
    store,
    toolBroker,
    providerRegistry,
    orchestrator,
    planService,
    pricing: activePricing,
    allowedOrigins: new Set(['http://127.0.0.1:5173']),
    serveUi,
    distDir,
    callProvider: callProvider ?? (realCaller
      ? (provider, modelName, messages, instructions) => realCaller.callModel(provider, modelName, messages, { tools: [], instructions: instructions ?? 'test instructions' })
      : async () => ({ text: 'stub reply', usage: null })),
  })

  await new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = app.server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  const baseUrl = `http://127.0.0.1:${port}`

  const request = async (method, route, body, headers = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
    return { status: response.status, payload, headers: response.headers }
  }

  try {
    return await callback({ baseUrl, request, store, toolBroker, providerRegistry, orchestrator, directory })
  } finally {
    await new Promise((resolve) => app.server.close(resolve))
    store.close()
    if (!workspaceRoot) await rm(directory, { recursive: true, force: true })
  }
}
