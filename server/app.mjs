import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { openApiDocument } from './apiDocs.mjs'
import { buildArtifacts } from './artifacts.mjs'
import { canonicalJson } from './canonicalJson.mjs'
import { settingReport } from './config.mjs'
import { buildRunReport, reportToMarkdown } from './runReport.mjs'
import { findInjectionAttempts } from './injection.mjs'
import { formatSseFrame } from './sse.mjs'
import { privateProviderUrlsAllowed } from './networkPolicy.mjs'
import { PERMISSION_MODES, fingerprintToolCall, permissionMatrix } from './permissions.mjs'
import { agentRoles } from './roles.mjs'

export const MAX_JSON_BODY_BYTES = 100_000
export const MAX_TOOL_BODY_BYTES = 600_000

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * @typedef {import('node:http').ServerResponse & { allowedOrigin?: string | null }} BridgeResponse
 */

const problemTitles = {
  400: 'Bad request',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'Conflict',
  413: 'Payload too large',
  500: 'Internal error',
  502: 'Upstream provider error',
  503: 'Service unavailable',
}

/**
 * @param {BridgeResponse} response
 * @param {number} status
 * @param {any} payload
 */
export function sendJson(response, status, payload) {
  // Errors go out as RFC 9457 problem details, with `error` kept as a deprecated
  // alias so an existing client does not break. Success bodies are unchanged.
  const isProblem = status >= 400 && payload && typeof payload === 'object' && typeof payload.error === 'string'
  const headers = {
    'Content-Type': isProblem ? 'application/problem+json; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }
  if (response.allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = response.allowedOrigin
    headers.Vary = 'Origin'
  }
  response.writeHead(status, headers)
  response.end(JSON.stringify(isProblem
    ? { type: 'about:blank', title: problemTitles[status] ?? 'Error', status, detail: payload.error, ...payload }
    : payload))
}

/**
 * Read and parse a JSON body with a hard size cap.
 *
 * Oversized bodies are drained rather than destroying the socket, so the caller
 * can still return a useful status instead of a connection reset.
 */
export function readJson(request, maximumLength = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let body = ''
    let received = 0
    let settled = false
    const fail = (status, message) => {
      if (settled) return
      settled = true
      reject(new HttpError(status, message))
    }

    request.on('data', (chunk) => {
      if (settled) return
      // Count bytes, not UTF-16 code units: `body.length` undercounts any
      // multi-byte character, so a 100k-character CJK body is three times the
      // stated limit.
      received += chunk.length
      body += chunk
      if (received > maximumLength) {
        fail(413, `Request body must be ${maximumLength} bytes or fewer.`)
        request.resume()
      }
    })

    request.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON.'))
      }
    })

    request.on('error', (error) => fail(400, error instanceof Error ? error.message : 'Request stream failed.'))
  })
}

function safeHistory(history, message) {
  const normalized = Array.isArray(history)
    ? history
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
        .slice(-20)
        .map((item) => ({ role: item.role, content: item.content.slice(0, 20_000) }))
    : []

  if (normalized.at(-1)?.role !== 'user' || normalized.at(-1)?.content !== message) {
    normalized.push({ role: 'user', content: message })
  }

  return normalized
}

function demoReply(message) {
  return `I have your direction: “${message}”\n\nI am running in demo mode because the selected provider has no server-side key yet. Add its key to .env.local, restart Fulkrum, and this same chat will route through the live API. For now, the next controlled step is to turn your direction into a plan for Scout and Forge.`
}

const controlTransitions = {
  'approve-plan': ['executing', 'plan.approved'],
  pause: ['paused', 'run.paused'],
  resume: ['executing', 'run.resumed'],
  cancel: ['cancelled', 'run.cancelled'],
}

const resumableStatuses = new Set(['paused', 'executing', 'budget_exceeded'])

/**
 * Build the API bridge.
 *
 * Every handler runs inside a guard: an unexpected throw returns a status
 * instead of rejecting the server's callback promise, which Node would treat as
 * an unhandled rejection and use to terminate the process, orphaning every run.
 */
export function createApp({ store, toolBroker, providerRegistry, orchestrator, callProvider, planService, pricing, execution = null, allowedOrigins = new Set(), ownerId = 'local', serveUi = false, distDir = 'dist', breaker = null, version = '0.0.0' }) {
  const isAllowedOrigin = (origin) => !origin || allowedOrigins.has(origin)
  let draining = null
  /** Open event streams, so draining can end them and let the server close. */
  const openStreams = new Set()

  const distRoot = serveUi ? path.resolve(distDir) : null
  const uiIndex = distRoot ? path.join(distRoot, 'index.html') : null
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
  }

  /**
   * Serve the built UI from the bridge, so `npm start` needs no dev server.
   *
   * The path is resolved and proved to be inside the build directory before it is
   * read; an unknown path with no extension falls back to the entry document, so a
   * client-side route survives a reload. Vite hashes asset names, so those are
   * cached hard while the entry document never is.
   */
  const serveStatic = async (request, response, requestUrl) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'Only GET and HEAD are served here.' })
      return
    }
    let relative = requestUrl.pathname
    try {
      relative = decodeURIComponent(relative)
    } catch {
      // A malformed escape is not a file name; the resolve below refuses it.
    }
    const target = path.resolve(distRoot, `.${relative.startsWith('/') ? relative : `/${relative}`}`)
    if (target !== distRoot && !target.startsWith(distRoot + path.sep)) {
      sendJson(response, 404, { error: 'Not found.' })
      return
    }

    let file = target
    const stats = await stat(file).catch(() => null)
    if (!stats || stats.isDirectory()) {
      if (path.extname(file)) {
        sendJson(response, 404, { error: 'Not found.' })
        return
      }
      file = uiIndex
    }
    const body = await readFile(file).catch(() => null)
    if (!body) {
      sendJson(response, 500, { error: `The built UI is missing. Run \`npm run build\`, or point FULKRUM_DIST_DIR at it.` })
      return
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(body.byteLength),
      'Cache-Control': file === uiIndex ? 'no-store' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  }

  const handleChat = async (request, response) => {
    const body = await readJson(request)
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message) {
      sendJson(response, 400, { error: 'A chat message is required.' })
      return
    }

    const project = body.projectId ? store.getProject(body.projectId)?.project : store.ensureDefaultProject()
    if (!project) {
      sendJson(response, 404, { error: 'Project not found.' })
      return
    }
    const run = body.runId ? store.getRun(body.runId) : store.ensureActiveRun(project.id, body.mode)
    if (!run || run.projectId !== project.id) {
      sendJson(response, 404, { error: 'Run not found.' })
      return
    }

    let provider
    let model
    try {
      provider = providerRegistry.resolve(body.routing?.head)
      model = providerRegistry.model(provider, body.routing?.head)
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Unknown provider route.' })
      return
    }

    const history = safeHistory(body.history, message)
    store.appendMessage({ projectId: project.id, runId: run.id, role: 'user', content: message })
    store.appendEvent({ runId: run.id, type: 'message.user', agentId: 'head', payload: { content: message } })

    if (!providerRegistry.isConfigured(provider)) {
      const reply = demoReply(message)
      store.appendMessage({ projectId: project.id, runId: run.id, role: 'assistant', agentId: 'head', content: reply, metadata: { demo: true, provider: provider.id, model } })
      store.appendEvent({ runId: run.id, type: 'message.assistant', agentId: 'head', payload: { content: reply, demo: true, provider: provider.id, model } })
      sendJson(response, 200, { reply, demo: true, provider: provider.id, model, projectId: project.id, runId: run.id })
      return
    }

    try {
      // Chat streams too: the same sink the workers use, so a caller who reloads
      // mid-reply sees what has arrived rather than an empty bubble.
      const sink = store.partialSink(run.id, { role: 'head' })
      let completion
      try {
        completion = await callProvider(provider, model, history, { onDelta: sink.push })
      } finally {
        sink.done()
      }
      const reply = completion?.text
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('The provider returned an empty response.')
      const cleanReply = reply.trim()
      // Chat costs money too, so it goes in the same ledger as worker calls.
      const cost = pricing ? pricing.costOf({ model, usage: completion.usage }) : { costUsd: null, priced: false, version: null }
      store.recordModelCall({ runId: run.id, role: 'head', provider: provider.id, model, usage: completion.usage, cost, latencyMs: null })
      store.appendMessage({ projectId: project.id, runId: run.id, role: 'assistant', agentId: 'head', content: cleanReply, metadata: { demo: false, provider: provider.id, model } })
      store.appendEvent({ runId: run.id, type: 'message.assistant', agentId: 'head', payload: { content: cleanReply, demo: false, provider: provider.id, model } })
      sendJson(response, 200, { reply: cleanReply, demo: false, provider: provider.id, model, projectId: project.id, runId: run.id })
    } catch (error) {
      sendJson(response, 502, { error: `Provider request failed: ${error instanceof Error ? error.message : 'unknown error'}` })
    }
  }

  /** Runs one authorized tool call and records the outcome. */
  const runToolCall = async ({ runId, toolCall, input, resolved, approved }) => {
    store.updateToolCall(toolCall.id, { status: 'running', attempt: toolCall.attempt + 1 })
    store.appendEvent({ runId, type: 'tool.started', agentId: toolCall.agentId ?? 'head', payload: { toolCallId: toolCall.id, name: toolCall.name, approved } })
    try {
      const output = await toolBroker.execute(toolCall.name, input, resolved, { runId })
      const safeOutput = toolBroker.redact(output)
      store.updateToolCall(toolCall.id, { status: 'completed', output: safeOutput })
      store.appendEvent({ runId, type: 'tool.completed', agentId: toolCall.agentId ?? 'head', payload: { toolCallId: toolCall.id, name: toolCall.name, ...store.summarizeOutput(safeOutput), approved } })
      const injectionAttempts = findInjectionAttempts(safeOutput)
      if (injectionAttempts.length) {
        store.appendEvent({ runId, type: 'tool.output.suspicious', agentId: toolCall.agentId ?? 'head', payload: { toolCallId: toolCall.id, name: toolCall.name, patterns: injectionAttempts, note: 'Tool output contained text aimed at the model. It is data, and was treated as data.' } })
      }
      return { ok: true, output: safeOutput }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed.'
      store.updateToolCall(toolCall.id, { status: 'failed', error: message })
      store.appendEvent({ runId, type: 'tool.failed', agentId: toolCall.agentId ?? 'head', payload: { toolCallId: toolCall.id, name: toolCall.name, error: message, approved } })
      return { ok: false, error: message }
    }
  }

  /**
   * Take one tool call through the whole path: resolve it, decide it, record it, and
   * either run it or park it for approval.
   *
   * Shared by the tools endpoint and by anything else that submits a call on a
   * user's behalf — a revert, for instance — so those cannot drift away from the
   * policy, the fingerprint, or the audit trail.
   */
  const submitToolCall = async ({ runId, run, name, input, agentId = 'head', idempotencyKey = null }) => {
    const tool = toolBroker.get(name)
    const resolution = toolBroker.resolve(name, input)
    const authorization = toolBroker.authorize({ mode: run?.permissionMode, tool, resolution })

    const existing = store.findToolCallByIdempotencyKey(runId, idempotencyKey)
    if (existing && ['completed', 'running'].includes(existing.status)) {
      return { status: 200, payload: { replayed: true, toolCall: existing, output: existing.output } }
    }

    const toolCall = store.createToolCall({
      runId,
      agentId,
      name,
      kind: tool?.kind ?? 'unknown',
      input: toolBroker.sanitizeInput(name, input),
      rawInput: input,
      resolved: resolution.ok ? resolution.resolved : null,
      fingerprint: resolution.ok ? fingerprintToolCall(resolution) : null,
      idempotencyKey,
    })
    store.appendEvent({ runId, type: 'tool.requested', agentId, payload: { toolCallId: toolCall.id, name, kind: tool?.kind ?? 'unknown', input: store.summarizeInput(toolCall.input), resolved: toolCall.resolved, rule: authorization.ruleId } })

    if (!authorization.allowed) {
      const status = authorization.requiresApproval ? 'approval_required' : 'denied'
      store.updateToolCall(toolCall.id, { status, error: authorization.reason })
      store.appendEvent({ runId, type: authorization.requiresApproval ? 'approval.requested' : 'tool.denied', agentId, payload: { toolCallId: toolCall.id, name, reason: authorization.reason, rule: authorization.ruleId, fingerprint: toolCall.fingerprint, resolved: toolCall.resolved } })
      return {
        status: authorization.requiresApproval ? 409 : 403,
        payload: { error: authorization.reason, approvalRequired: authorization.requiresApproval, rule: authorization.ruleId, toolCall: store.getToolCall(toolCall.id) },
      }
    }

    const result = await runToolCall({ runId, toolCall, input, resolved: resolution, approved: false })
    return {
      status: result.ok ? 200 : 502,
      payload: result.ok ? { output: result.output, toolCall: store.getToolCall(toolCall.id) } : { error: result.error, toolCall: store.getToolCall(toolCall.id) },
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)

      if (draining) {
        sendJson(response, 503, { error: `The API bridge is shutting down: ${draining}` })
        return
      }

      const origin = request.headers.origin
      if (!isAllowedOrigin(origin)) {
        sendJson(response, 403, { error: 'Origin is not allowed.' })
        return
      }
      // Carried on the response so sendJson can echo only an allowed origin.
      /** @type {BridgeResponse} */ (response).allowedOrigin = origin || null

      if (request.method === 'OPTIONS') {
        const headers = { 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' }
        if (origin) {
          headers['Access-Control-Allow-Origin'] = origin
          headers.Vary = 'Origin'
        }
        response.writeHead(204, headers)
        response.end()
        return
      }

      if (distRoot && requestUrl.pathname !== '/api' && !requestUrl.pathname.startsWith('/api/')) {
        await serveStatic(request, response, requestUrl)
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/config') {
        const report = settingReport()
        sendJson(response, 200, {
          settings: report,
          problems: report.filter((entry) => entry.problem).map((entry) => ({ name: entry.name, message: entry.problem, using: entry.value })),
          // Key values are never returned, only whether one is present and where
          // it came from. A stored key wins over an environment variable.
          providers: providerRegistry.list().map((provider) => ({ id: provider.id, label: provider.label, envKey: provider.envKey, configured: provider.configured, hasKey: provider.hasKey, keySource: provider.keySource })),
          note: 'Bridge settings are read at startup; limits that can change without a restart are reported as they are right now.',
        })
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/openapi.json') {
        sendJson(response, 200, openApiDocument({ version: process.env.npm_package_version ?? '0.2.0-dev' }))
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
        const boundary = execution ? await execution.status() : { available: false, reason: 'No execution runtime is configured.' }
        // Read from the same source /api/config reports, so a value set in the
        // environment shows up here without the caller having to pass it in.
        const retention = settingReport().find((entry) => entry.name === 'FULKRUM_TOOL_OUTPUT_RETENTION_DAYS')
        sendJson(response, 200, {
          version,
          schemaVersion: store.stats().schemaVersion,
          storage: store.storageSize(),
          database: { path: store.filePath, ...store.stats() },
          backups: store.backupStatus(),
          anchor: { file: store.anchorFile, count: store.readAnchors().length },
          // Walking every chain is done on request, not on every status read.
          lastVerify: store.lastMaintenance('verify'),
          lastBackup: store.lastMaintenance('backup'),
          maintenance: store.listMaintenance({ limit: 10 }),
          execution: { ...boundary, running: execution?.runningNow?.() ?? [] },
          providers: providerRegistry.list().map((provider) => ({
            id: provider.id,
            label: provider.label,
            configured: provider.configured,
            keySource: provider.keySource,
            breaker: breaker?.state?.(provider.id) ?? null,
          })),
          retention: { toolOutputDays: retention?.value ?? null, source: retention?.source ?? null },

        })
        return
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/maintenance/verify') {
        const result = store.verifyEverything()
        const summary = result.ok
          ? `${result.runs} run(s), ${result.eventsChecked} event(s) verified`
          : `problems in ${result.truncated.length + result.broken.length + result.anchorMismatch.length + result.anchorOrphaned.length} run(s)`
        const record = store.recordMaintenance({ kind: 'verify', ok: result.ok, summary, payload: { runs: result.runs, eventsChecked: result.eventsChecked, truncated: result.truncated.map((run) => run.runId), broken: result.broken.map((run) => run.runId), anchorMismatch: result.anchorMismatch.map((run) => run.runId), anchorOrphaned: result.anchorOrphaned.map((run) => run.runId) } })
        sendJson(response, 200, { result, record })
        return
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/maintenance/backup') {
        const copy = store.backup()
        const record = store.recordMaintenance({ kind: 'backup', ok: true, summary: `copy written to ${copy.path}`, payload: { path: copy.path, anchorPath: copy.anchorPath, rotated: copy.removed } })
        sendJson(response, 200, { copy, record })
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
        const boundary = execution ? await execution.status() : { available: false, reason: 'No execution runtime is configured.' }
        sendJson(response, 200, {
          ok: true,
          service: 'fulkrum-api',
          workspaceRoot: toolBroker.workspaceRoot,
          tools: toolBroker.list().length,
          execution: boundary,
          store: store.stats(),
        })
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/tools') {
        const boundary = execution ? await execution.status() : { available: false, reason: 'No execution runtime is configured.' }
        sendJson(response, 200, {
          workspaceRoot: toolBroker.workspaceRoot,
          tools: toolBroker.list(),
          execution: boundary,
          roles: Object.fromEntries(Object.entries(agentRoles).map(([name, role]) => [name, { label: role.label, readOnly: role.readOnly, tools: role.tools }])),
          policy: permissionMatrix.map((rule) => ({ id: rule.id, decision: rule.decision })),
        })
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/providers') {
        sendJson(response, 200, { providers: providerRegistry.list() })
        return
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/providers') {
        try {
          const provider = providerRegistry.addCustom(await readJson(request))
          sendJson(response, 201, { provider: providerRegistry.list().find((item) => item.id === provider.id) })
        } catch (error) {
          sendJson(response, error instanceof HttpError ? error.status : 400, { error: error instanceof Error ? error.message : 'Invalid provider.' })
        }
        return
      }

      const providerTestMatch = requestUrl.pathname.match(/^\/api\/providers\/([^/]+)\/test$/)
      if (request.method === 'POST' && providerTestMatch) {
        let provider
        try {
          provider = providerRegistry.resolve({ providerId: decodeURIComponent(providerTestMatch[1]) })
        } catch (error) {
          sendJson(response, 404, { error: error instanceof Error ? error.message : 'Unknown provider.' })
          return
        }
        const result = await providerRegistry.testConnection(provider, { allowPrivate: privateProviderUrlsAllowed() })
        sendJson(response, result.reachable || !result.configured ? 200 : 502, { provider: providerRegistry.list().find((item) => item.id === provider.id), result })
        return
      }

      const providerMatch = requestUrl.pathname.match(/^\/api\/providers\/([^/]+)$/)
      if ((request.method === 'PATCH' || request.method === 'PUT') && providerMatch) {
        try {
          const provider = providerRegistry.updateSettings(decodeURIComponent(providerMatch[1]), await readJson(request))
          sendJson(response, 200, { provider })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid provider settings.'
          sendJson(response, /Unknown provider route/.test(message) ? 404 : 400, { error: message })
        }
        return
      }

      if (request.method === 'DELETE' && providerMatch) {
        try {
          const id = providerRegistry.removeCustom(decodeURIComponent(providerMatch[1]))
          sendJson(response, 200, { removed: id, providers: providerRegistry.list() })
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : 'Could not remove provider.' })
        }
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/projects') {
        sendJson(response, 200, { projects: store.listProjects() })
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/projects/default') {
        const project = store.ensureDefaultProject()
        const detail = store.getProject(project.id)
        sendJson(response, 200, detail ?? { project, runs: [] })
        return
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/projects') {
        try {
          const body = await readJson(request)
          sendJson(response, 201, { project: store.createProject({ name: body.name, settings: body.settings }) })
        } catch (error) {
          sendJson(response, error instanceof HttpError ? error.status : 400, { error: error instanceof Error ? error.message : 'Invalid project.' })
        }
        return
      }

      const projectMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)$/)
      if (request.method === 'GET' && projectMatch) {
        const project = store.getProject(decodeURIComponent(projectMatch[1]))
        sendJson(response, project ? 200 : 404, project ? project : { error: 'Project not found.' })
        return
      }

      if (request.method === 'PATCH' && projectMatch) {
        try {
          const body = await readJson(request)
          if (body.settings !== undefined && (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings))) {
            sendJson(response, 400, { error: 'Project settings must be an object.' })
            return
          }
          sendJson(response, 200, { project: store.updateProject(decodeURIComponent(projectMatch[1]), body) })
        } catch (error) {
          sendJson(response, error instanceof HttpError ? error.status : 400, { error: error instanceof Error ? error.message : 'Could not update project.' })
        }
        return
      }

      if (request.method === 'DELETE' && projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1])
        const detail = store.getProject(projectId)
        if (!detail) {
          sendJson(response, 404, { error: 'Project not found.' })
          return
        }
        // A project with a run in flight cannot be deleted: the orchestrator would
        // be working against rows that no longer exist.
        const activeRun = detail.runs.find((run) => ['executing', 'paused'].includes(run.status))
        if (activeRun) {
          sendJson(response, 409, { error: `Stop the active run in this project first (${activeRun.status}).` })
          return
        }
        if (store.listProjects().length <= 1) {
          sendJson(response, 409, { error: 'The last project cannot be deleted.' })
          return
        }
        store.deleteProject(projectId)
        sendJson(response, 200, { removed: projectId, projects: store.listProjects() })
        return
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/runs') {
        try {
          const body = await readJson(request)
          if (!store.getProject(body.projectId)) {
            sendJson(response, 404, { error: 'Project not found.' })
            return
          }
          sendJson(response, 201, { run: store.createRun({ projectId: body.projectId, mode: body.mode, permissionMode: body.permissionMode }) })
        } catch (error) {
          sendJson(response, error instanceof HttpError ? error.status : 400, { error: error instanceof Error ? error.message : 'Invalid run.' })
        }
        return
      }

      const runReportMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/report$/)
      if (request.method === 'GET' && runReportMatch) {
        const runId = decodeURIComponent(runReportMatch[1])
        const report = buildRunReport({ store, runId })
        if (!report) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        if (/^(md|markdown)$/i.test(String(requestUrl.searchParams.get('format') ?? ''))) {
          const body = reportToMarkdown(report)
          response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="fulkrum-${runId}.md"` })
          response.end(body)
          return
        }
        sendJson(response, 200, report)
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/runs') {
        const projectId = requestUrl.searchParams.get('projectId')
        const runs = store.listRuns({
          projectId: projectId || null,
          // Every active run at once, which is what a caller watching several
          // projects needs; one project's history is the same call with a projectId.
          activeOnly: /^(1|true)$/i.test(requestUrl.searchParams.get('active') ?? ''),
          status: requestUrl.searchParams.get('status') || null,
          limit: Math.min(Math.max(Number(requestUrl.searchParams.get('limit') ?? 50) || 50, 1), 200),
        })
        sendJson(response, 200, { runs })
        return
      }

      const runForkMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/fork$/)
      if (request.method === 'POST' && runForkMatch) {
        const sourceRunId = decodeURIComponent(runForkMatch[1])
        const source = store.getRun(sourceRunId)
        if (!source) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        const plan = (source.planId ? store.getPlan(source.planId) : null) ?? store.getLatestPlanForRun(sourceRunId)
        if (!plan) {
          sendJson(response, 409, { error: 'That run has no plan to re-run.' })
          return
        }
        const body = await readJson(request).catch(() => ({}))
        // A fork is a new run with the same plan as a fresh draft, plus the original
        // direction as its first message. Re-running is a decision, so the plan goes
        // through approval again rather than inheriting the old one.
        const forked = store.transaction(() => {
          const run = store.createRun({
            projectId: source.projectId,
            mode: source.mode,
            permissionMode: PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : source.permissionMode,
            ownerId,
          })
          const copy = store.createPlan({
            projectId: source.projectId,
            runId: run.id,
            objective: plan.plan.objective,
            tasks: plan.tasks.map((task) => ({ role: task.role, title: task.title, instructions: task.instructions, acceptanceCheck: task.acceptanceCheck, dependsOn: task.dependsOn })),
            contentHash: plan.plan.contentHash,
            source: 'fork',
          })
          store.updateRun(run.id, { planId: copy.plan.id })
          const direction = [...store.listMessages(sourceRunId)].reverse().find((message) => message.role === 'user')
          if (direction) store.appendMessage({ projectId: source.projectId, runId: run.id, role: 'user', content: direction.content })
          store.appendEvent({ runId: run.id, type: 'run.forked', agentId: 'head', payload: { from: sourceRunId, planId: copy.plan.id, version: copy.plan.version, objective: copy.plan.objective } })
          return { run: store.getRun(run.id), plan: copy }
        })
        sendJson(response, 201, { run: forked.run, plan: forked.plan, from: sourceRunId })
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/search') {
        const query = requestUrl.searchParams.get('q') ?? ''
        if (!query.trim()) {
          sendJson(response, 400, { error: 'A search needs a query: pass ?q=.' })
          return
        }
        sendJson(response, 200, store.search({
          query,
          projectId: requestUrl.searchParams.get('projectId') || null,
          limit: Math.min(Math.max(Number(requestUrl.searchParams.get('limit') ?? 30) || 30, 1), 100),
        }))
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/workspace/tree') {
        try {
          sendJson(response, 200, await toolBroker.listTree(requestUrl.searchParams.get('path') ?? '.', { depth: Number(requestUrl.searchParams.get('depth') ?? 2) }))
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : 'That path cannot be listed.' })
        }
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/workspace/history') {
        const target = requestUrl.searchParams.get('path') ?? ''
        if (!target.trim()) {
          sendJson(response, 400, { error: 'A file history needs a path: pass ?path=.' })
          return
        }
        const calls = store.listToolCallsForPath(target, { limit: Math.min(Math.max(Number(requestUrl.searchParams.get('limit') ?? 50) || 50, 1), 200) })
        sendJson(response, 200, {
          path: target,
          calls: calls.map((call) => ({
            id: call.id,
            runId: call.runId,
            agentId: call.agentId,
            name: call.name,
            kind: call.kind,
            status: call.status,
            approvedScope: call.approvalScope,
            at: call.completedAt ?? call.createdAt,
            bytes: call.output?.bytes ?? null,
            created: call.output?.created ?? null,
          })),
        })
        return
      }

      const runEventsMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/events$/)
      if (request.method === 'GET' && runEventsMatch) {
        const runId = decodeURIComponent(runEventsMatch[1])
        if (!store.getRun(runId)) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        const after = Number(requestUrl.searchParams.get('after') ?? 0)
        sendJson(response, 200, { events: store.listEvents(runId, Number.isFinite(after) ? after : 0) })
        return
      }

      const runAuditMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/audit$/)
      if (request.method === 'GET' && runAuditMatch) {
        const runId = decodeURIComponent(runAuditMatch[1])
        if (!store.getRun(runId)) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        sendJson(response, 200, store.verifyEventChain(runId))
        return
      }

      const runTraceMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/trace$/)
      if (request.method === 'GET' && runTraceMatch) {
        const runId = decodeURIComponent(runTraceMatch[1])
        if (!store.getRun(runId)) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        sendJson(response, 200, { ...store.getRunTrace(runId), pricingVersion: pricing?.version ?? null })
        return
      }

      const runStreamMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/stream$/)
      if (request.method === 'GET' && runStreamMatch) {
        const runId = decodeURIComponent(runStreamMatch[1])
        if (!store.getRun(runId)) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        // The cursor is the browser's own: on a reconnect it resends the last id it
        // saw, and that has to win over a stale `after` in the URL. An explicit
        // `after` is the fallback for a fresh connection that wants a starting point.
        const lastEventId = request.headers['last-event-id']
        const requested = lastEventId !== undefined ? Number(lastEventId) : Number(requestUrl.searchParams.get('after') ?? 0)
        const after = Number.isFinite(requested) ? requested : 0
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        response.write('retry: 1500\n\n')
        const writeEvent = (event) => {
          response.write(formatSseFrame({ id: event.sequence, event: 'fulkrum', data: JSON.stringify(event) }))
        }
        // Text in flight is sent as its own frame type rather than as an event, so a
        // client can render it without pretending it is part of the record.
        const writeDelta = (frame) => {
          response.write(formatSseFrame({ event: 'delta', data: JSON.stringify(frame) }))
        }
        const partial = store.getPartial(runId)
        if (partial) response.write(formatSseFrame({ event: 'partial', data: JSON.stringify({ text: partial }) }))
        for (const event of store.listEvents(runId, after)) writeEvent(event)
        const unsubscribe = store.subscribeEvents(runId, writeEvent)
        const unsubscribeEphemeral = store.subscribeEphemeral(runId, writeDelta)
        openStreams.add(response)
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
        request.on('close', () => {
          clearInterval(heartbeat)
          unsubscribe()
          unsubscribeEphemeral()
          openStreams.delete(response)
        })
        return
      }

      const runPlanMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/plan$/)
      if (runPlanMatch) {
        const runId = decodeURIComponent(runPlanMatch[1])
        const run = store.getRun(runId)
        if (!run) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        if (request.method === 'GET') {
          const plan = store.getLatestPlanForRun(runId)
          sendJson(response, plan ? 200 : 404, plan ? { ...plan, roles: agentRoles } : { error: 'This run has no plan yet.' })
          return
        }
        if (request.method === 'POST') {
          const body = await readJson(request)
          const routing = body.routing ?? store.getProject(run.projectId)?.project?.settings?.routing ?? {}
          const drafted = await planService.ensureDraft(run, { regenerate: body.regenerate === true, routing })
          sendJson(response, 200, { ...drafted.plan, created: Boolean(drafted.created), demo: Boolean(drafted.demo), fallbackReason: drafted.fallbackReason ?? null })
          return
        }
      }

      const runControlMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/control$/)
      if (request.method === 'POST' && runControlMatch) {
        const runId = decodeURIComponent(runControlMatch[1])
        const run = store.getRun(runId)
        const body = await readJson(request)

        if (body.action === 'set-permission') {
          const allowedModes = new Set(['guided', 'selective', 'autopilot'])
          if (!run || !allowedModes.has(body.permissionMode)) {
            sendJson(response, 400, { error: 'Unknown run or permission mode.' })
            return
          }
          const nextRun = store.updateRun(runId, { permissionMode: body.permissionMode })
          const event = store.appendEvent({ runId, type: 'run.permission.changed', payload: { permissionMode: body.permissionMode, source: 'user' } })
          sendJson(response, 200, { run: nextRun, event })
          return
        }

        if (body.action === 'set-budget') {
          if (!run) {
            sendJson(response, 404, { error: 'Run not found.' })
            return
          }
          const requested = body.budgetUsd === null ? null : Number(body.budgetUsd)
          if (requested !== null && (!Number.isFinite(requested) || requested <= 0)) {
            sendJson(response, 400, { error: 'A budget must be a positive number, or null for the environment default.' })
            return
          }
          const nextRun = store.updateRun(runId, { budgetUsd: requested })
          const event = store.appendEvent({ runId, type: 'run.budget.changed', payload: { budgetUsd: requested, source: 'user', spend: store.spendForRun(runId) } })
          sendJson(response, 200, { run: nextRun, event })
          return
        }

        const transition = controlTransitions[body.action]
        if (!run || !transition) {
          sendJson(response, 400, { error: 'Unknown run or control action.' })
          return
        }

        const routing = body.routing ?? store.getProject(run.projectId)?.project?.settings?.routing ?? {}
        let approvalPayload = null

        if (body.action === 'approve-plan') {
          // A plan is required to approve one. If the caller has not drafted one
          // yet, draft it now so the run is always bound to a stored artifact.
          let plan = typeof body.planId === 'string' ? store.getPlan(body.planId) : store.getLatestPlanForRun(runId)
          if (!plan) {
            const drafted = await planService.ensureDraft(run, { routing })
            plan = drafted.plan
          }
          if (plan.plan.runId && plan.plan.runId !== runId) {
            sendJson(response, 409, { error: 'That plan belongs to a different run.' })
            return
          }
          // Approval binds to the exact plan content the user was shown.
          if (typeof body.planHash === 'string' && body.planHash !== plan.plan.contentHash) {
            store.appendEvent({ runId, type: 'plan.approval.rejected', agentId: 'head', payload: { planId: plan.plan.id, expected: plan.plan.contentHash, received: body.planHash } })
            sendJson(response, 409, { error: 'This plan changed since it was shown. Review the current version and approve again.' })
            return
          }
          if (plan.plan.status !== 'approved') {
            // Three writes that only make sense together: a crash between them
            // would leave an approved plan the run never pointed at, with no event
            // to explain it.
            store.transaction(() => {
              store.approvePlan(plan.plan.id)
              store.updateRun(runId, { planId: plan.plan.id, planVersion: plan.plan.version })
              store.appendEvent({ runId, type: 'plan.approved', agentId: 'head', payload: { planId: plan.plan.id, version: plan.plan.version, hash: plan.plan.contentHash, tasks: plan.tasks.length, source: plan.plan.source } })
            })
          }
          approvalPayload = { planId: plan.plan.id, planVersion: plan.plan.version, planHash: plan.plan.contentHash, taskCount: plan.tasks.length }
        }

        if (body.action === 'resume' && !resumableStatuses.has(run.status) && run.status !== 'interrupted') {
          sendJson(response, 409, { error: `A run in ${run.status} state cannot be resumed.` })
          return
        }

        const patch = { status: transition[0] }
        if (body.action === 'resume' && run.status === 'interrupted') {
          patch.interruptedAt = null
          patch.interruptionReason = null
        }
        const nextRun = store.updateRun(runId, patch)
        const event = store.appendEvent({ runId, type: transition[1], payload: { source: 'user', previousStatus: run.status, ...(approvalPayload ?? {}) } })
        if (body.action === 'approve-plan' || body.action === 'resume') {
          orchestrator.start(runId, { routing })
        }
        if (body.action === 'cancel' && execution) {
          // The run stops at its next checkpoint, but a command already in the
          // container would keep working until its timeout. Cancelling stops both.
          const stopped = await execution.kill(runId, { reason: 'the run was cancelled' })
          if (stopped.stopped) {
            store.appendEvent({ runId, type: 'run.command.stopped', payload: { container: stopped.container, reason: stopped.reason } })
          }
        }
        sendJson(response, 200, { run: nextRun, event })
        return
      }

      const toolApprovalMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/tools\/([^/]+)\/approve$/)
      if (request.method === 'POST' && toolApprovalMatch) {
        const runId = decodeURIComponent(toolApprovalMatch[1])
        const toolCallId = decodeURIComponent(toolApprovalMatch[2])
        const run = store.getRun(runId)
        const toolCall = store.getToolCall(toolCallId)
        if (!run || !toolCall || toolCall.runId !== runId || toolCall.status !== 'approval_required') {
          sendJson(response, 409, { error: 'Tool call is no longer awaiting approval.' })
          return
        }

        // The body may confirm which fingerprint was approved. It can never
        // supply the arguments: those come from the stored request, so an
        // approval click cannot be redirected to a different payload.
        const body = await readJson(request)
        if (typeof body.fingerprint === 'string' && toolCall.fingerprint && body.fingerprint !== toolCall.fingerprint) {
          sendJson(response, 409, { error: 'The approved fingerprint does not match the recorded tool call.' })
          return
        }

        const scope = body.scope === 'run' ? 'run' : 'once'
        if (body.scope === 'always') {
          // A standing exception needs somewhere to review and revoke it, which
          // does not exist yet, so it is refused rather than quietly downgraded.
          sendJson(response, 400, { error: 'Only "once" and "run" scopes are supported. A persistent exception needs a management view first.' })
          return
        }
        // Execute the arguments as they were sent, not the redacted copy kept for
        // display: redaction would otherwise rewrite a file whose content happens
        // to match a secret pattern.
        const rawInput = store.getToolCallInput(toolCallId) ?? toolCall.input
        const resolution = toolBroker.resolve(toolCall.name, rawInput)
        if (!resolution.ok) {
          store.updateToolCall(toolCall.id, { status: 'denied', error: resolution.error })
          sendJson(response, 409, { error: `This tool call can no longer be executed: ${resolution.error}` })
          return
        }
        // Detect a row edited after the fact: the recorded fingerprint must still
        // describe the arguments this request is about to run.
        const expectedFingerprint = fingerprintToolCall(resolution)
        if (toolCall.fingerprint && toolCall.fingerprint !== expectedFingerprint) {
          store.updateToolCall(toolCall.id, { status: 'denied', error: 'The recorded arguments no longer match the approved fingerprint.' })
          store.appendEvent({ runId, type: 'tool.denied', agentId: toolCall.agentId ?? 'head', payload: { toolCallId: toolCall.id, name: toolCall.name, reason: 'Fingerprint mismatch.' } })
          sendJson(response, 409, { error: 'The recorded arguments no longer match the approved fingerprint.' })
          return
        }
        // The same check for the copy the user was shown: if it was edited, what
        // they approved is not what would run.
        if (toolCall.resolved && canonicalJson(toolCall.resolved) !== canonicalJson(resolution.resolved)) {
          store.updateToolCall(toolCall.id, { status: 'denied', error: 'The recorded arguments no longer describe this call.' })
          store.appendEvent({ runId, type: 'tool.denied', agentId: toolCall.agentId ?? 'head', payload: { toolCallId: toolCall.id, name: toolCall.name, reason: 'Resolved arguments do not match the record.' } })
          sendJson(response, 409, { error: 'The recorded arguments no longer describe this call.' })
          return
        }

        store.transaction(() => {
          store.markToolCallApproved(toolCall.id, scope)
          if (scope === 'run') {
            const grant = store.grantApproval({ runId, toolName: toolCall.name, kind: toolCall.kind })
            store.appendEvent({ runId, type: 'approval.granted', agentId: toolCall.agentId ?? 'head', payload: { toolName: toolCall.name, kind: toolCall.kind, scope: 'run', grantId: grant.id } })
          }
        })
        const resumed = await orchestrator.approveToolCall(toolCallId)
        if (resumed.handled) {
          sendJson(response, 200, { resumed: true, result: resumed.result, toolCall: store.getToolCall(toolCallId) })
          return
        }

        // No worker is parked on this call (it was raised through the tools API),
        // so execute it directly and record that no run resumed.
        const result = await runToolCall({ runId, toolCall: store.getToolCall(toolCallId), input: rawInput, resolved: resolution, approved: true })
        sendJson(response, result.ok ? 200 : 502, result.ok ? { output: result.output, toolCall: store.getToolCall(toolCallId), resumed: false } : { error: result.error, toolCall: store.getToolCall(toolCallId) })
        return
      }

      const toolDenialMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/tools\/([^/]+)\/deny$/)
      if (request.method === 'POST' && toolDenialMatch) {
        const runId = decodeURIComponent(toolDenialMatch[1])
        const toolCallId = decodeURIComponent(toolDenialMatch[2])
        const run = store.getRun(runId)
        const toolCall = store.getToolCall(toolCallId)
        if (!run || !toolCall || toolCall.runId !== runId || toolCall.status !== 'approval_required') {
          sendJson(response, 409, { error: 'Tool call is no longer awaiting approval.' })
          return
        }
        const body = await readJson(request)
        const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : 'Denied by the user.'
        store.transaction(() => {
          store.updateToolCall(toolCall.id, { status: 'denied', error: reason })
          store.appendEvent({ runId, type: 'tool.denied', agentId: toolCall.agentId ?? 'head', payload: { toolCallId, name: toolCall.name, reason, rule: 'deny.user', fingerprint: toolCall.fingerprint, resolved: toolCall.resolved } })
        })
        // The worker is waiting on this call, so tell it no: a denial it can read
        // is information it can act on.
        const handled = orchestrator.denyToolCall(toolCallId, reason)
        sendJson(response, 200, { denied: true, resumed: handled.handled, toolCall: store.getToolCall(toolCallId) })
        return
      }

      const runGrantsMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/grants$/)
      if (request.method === 'GET' && runGrantsMatch) {
        const runId = decodeURIComponent(runGrantsMatch[1])
        if (!store.getRun(runId)) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        sendJson(response, 200, { grants: store.listApprovalGrants(runId) })
        return
      }

      const runGrantMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/grants\/([^/]+)$/)
      if (request.method === 'DELETE' && runGrantMatch) {
        const runId = decodeURIComponent(runGrantMatch[1])
        const toolName = decodeURIComponent(runGrantMatch[2])
        if (!store.getRun(runId)) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        const revoked = store.revokeApprovalGrant(runId, toolName)
        if (revoked) store.appendEvent({ runId, type: 'approval.revoked', agentId: 'head', payload: { toolName, source: 'user' } })
        sendJson(response, revoked ? 200 : 404, revoked ? { revoked: toolName, grants: store.listApprovalGrants(runId) } : { error: 'No active grant for that tool.' })
        return
      }

      const runArtifactRevertMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)\/revert$/)
      if (request.method === 'POST' && runArtifactRevertMatch) {
        const runId = decodeURIComponent(runArtifactRevertMatch[1])
        const toolCallId = decodeURIComponent(runArtifactRevertMatch[2])
        const run = store.getRun(runId)
        if (!run) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }

        const artifact = buildArtifacts(store, runId).find((item) => item.toolCallId === toolCallId)
        if (!artifact) {
          sendJson(response, 404, { error: 'That write is not part of this run.' })
          return
        }
        const original = store.getToolCall(toolCallId)
        const previous = original?.output?.previousContent
        if (original?.output?.created === true) {
          sendJson(response, 409, { error: 'That write created the file, and there is no delete tool: remove it yourself rather than restoring an empty one.' })
          return
        }
        if (typeof previous !== 'string') {
          sendJson(response, 409, { error: original?.output?.previousTruncated ? 'The previous contents were too large to keep, so this change cannot be undone from here.' : 'There is no stored copy of this file to restore.' })
          return
        }

        // A revert is a write like any other: the same policy, the same fingerprint,
        // the same approval if the mode asks for one, and the same audit trail. It
        // restores bytes that were already on disk, so it is not a new capability.
        store.appendEvent({ runId, type: 'artifact.revert.requested', agentId: 'head', payload: { toolCallId, path: artifact.path, bytes: Buffer.byteLength(previous, 'utf8') } })
        const outcome = await submitToolCall({
          runId,
          run,
          name: 'workspace.write',
          input: { path: artifact.path, content: previous },
          agentId: 'head',
        })
        sendJson(response, outcome.status, { ...outcome.payload, reverted: outcome.status === 200, path: artifact.path })
        return
      }

      const runArtifactsMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/artifacts$/)
      if (request.method === 'GET' && runArtifactsMatch) {
        const runId = decodeURIComponent(runArtifactsMatch[1])
        if (!store.getRun(runId)) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        sendJson(response, 200, { artifacts: buildArtifacts(store, runId), grants: store.listApprovalGrants(runId) })
        return
      }

      const runToolsMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/tools$/)
      if (request.method === 'GET' && runToolsMatch) {
        const runId = decodeURIComponent(runToolsMatch[1])
        const run = store.getRun(runId)
        sendJson(response, run ? 200 : 404, run ? { toolCalls: store.listToolCalls(runId) } : { error: 'Run not found.' })
        return
      }

      if (request.method === 'POST' && runToolsMatch) {
        const runId = decodeURIComponent(runToolsMatch[1])
        const run = store.getRun(runId)
        if (!run || ['cancelled', 'completed', 'failed'].includes(run.status)) {
          sendJson(response, 409, { error: 'Tool calls require an active run.' })
          return
        }
        const body = await readJson(request, MAX_TOOL_BODY_BYTES)
        const outcome = await submitToolCall({
          runId,
          run,
          name: body.name,
          input: body.input ?? {},
          agentId: body.agentId ?? 'head',
          idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null,
        })
        sendJson(response, outcome.status, outcome.payload)
        return
      }

      const runMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)$/)
      if (request.method === 'GET' && runMatch) {
        const runId = decodeURIComponent(runMatch[1])
        const snapshot = store.getRunSnapshot(runId)
        if (!snapshot) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        sendJson(response, 200, {
          ...snapshot,
          audit: store.verifyEventChain(runId),
          spend: store.spendForRun(runId),
          budget: { runUsd: snapshot.run.budgetUsd, defaultRunUsd: Number(process.env.FULKRUM_RUN_BUDGET_USD ?? 0) || null, dailyUsd: Number(process.env.FULKRUM_DAILY_BUDGET_USD ?? 0) || null },
        })
        return
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/chat') {
        try {
          await handleChat(request, response)
        } catch (error) {
          sendJson(response, error instanceof HttpError ? error.status : 400, { error: error instanceof Error ? error.message : 'Invalid request.' })
        }
        return
      }

      sendJson(response, 404, { error: 'Not found.' })
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof Error ? error.message : 'Unexpected server error.'
      if (response.headersSent) {
        response.end()
        return
      }
      sendJson(response, status, { error: message })
    }
  })

  return {
    server,
    servingUi: Boolean(distRoot),
    // Stop accepting work without killing the process: a run mid-step deserves
    // the chance to finish writing its state.
    beginDraining(reason) {
      draining = reason
      // server.close() waits for open responses, and an event stream never ends on
      // its own: without this, shutdown hangs until the force timer.
      for (const stream of openStreams) {
        try {
          stream.end()
        } catch {
          // The client is already gone.
        }
      }
      openStreams.clear()
    },
    isDraining: () => draining,
    ownerId,
  }
}
