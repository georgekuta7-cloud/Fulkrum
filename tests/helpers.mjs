import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.mjs'
import { createProviderRegistry } from '../server/providerRegistry.mjs'
import { createRunOrchestrator } from '../server/orchestrator.mjs'
import { FulkrumStore } from '../server/store.mjs'
import { FulkrumToolBroker } from '../server/toolBroker.mjs'

export async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), 'fulkrum-test-'))
  try {
    return await callback(directory)
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
 */
export async function withServer(callback, { workspaceRoot, callProvider } = {}) {
  const directory = workspaceRoot ?? (await mkdtemp(path.join(tmpdir(), 'fulkrum-api-')))
  const store = new FulkrumStore(path.join(directory, 'fulkrum.sqlite'))
  const toolBroker = new FulkrumToolBroker({ workspaceRoot: directory, httpAllowlist: [] })
  const providerRegistry = createProviderRegistry(store)
  const orchestrator = createRunOrchestrator({
    store,
    providerRegistry,
    toolBroker,
    ownerId: 'test-owner',
    callModel: async () => 'stub model output',
  })
  const app = createApp({
    store,
    toolBroker,
    providerRegistry,
    orchestrator,
    allowedOrigins: new Set(['http://127.0.0.1:5173']),
    callProvider: callProvider ?? (async () => 'stub reply'),
  })

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const { port } = app.server.address()
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
