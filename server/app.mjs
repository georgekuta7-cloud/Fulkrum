import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { openApiDocument } from './apiDocs.mjs'
import { buildArtifacts } from './artifacts.mjs'
import { createZip } from './zip.mjs'
import { canonicalJson } from './canonicalJson.mjs'
import { settingReport } from './config.mjs'
import { buildRunReport, reportToMarkdown } from './runReport.mjs'
import { diffHunks } from './diff.mjs'
import { findInjectionAttempts } from './injection.mjs'
import { formatSseFrame } from './sse.mjs'
import { maybeExportTrace } from './otel.mjs'
import { BudgetExceededError } from './orchestrator.mjs'
import { privateProviderUrlsAllowed } from './networkPolicy.mjs'
import { PERMISSION_MODES, fingerprintToolCall, permissionMatrix, standingScopeFor, validateStandingScope } from './permissions.mjs'
import { scanArguments } from './redaction.mjs'
import { planContentHash, validatePlan } from './plans.mjs'
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
      // mid-reply sees what has arrived rather than an empty bubble. The call
      // holds a budget reservation like a worker call: chat can overlap a
      // running loop, and a ceiling must stop it the same way.
      const sink = store.partialSink(run.id, { role: 'head' })
      let completion
      try {
        completion = await orchestrator.withBudget(run.id, () => callProvider(provider, model, history, { onDelta: sink.push }))
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
      if (error instanceof BudgetExceededError) {
        sendJson(response, 402, { error: error.message })
        return
      }
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
   * What a pending write would change, against the file as it is right now.
   *
   * The snapshot taken at write time is what a revert restores; this is for the
   * approval prompt, where the question is "what changes if I say yes".
   */
  const buildWritePreview = async (name, resolution, rawInput) => {
    if (name !== 'workspace.write' || !resolution?.ok) return null
    const after = String(rawInput?.content ?? '')
    const stats = await stat(resolution.resolved.path).catch(() => null)
    if (stats?.isDirectory()) return null
    const before = stats ? await readFile(resolution.resolved.path, 'utf8').catch(() => null) : null
    const diff = diffHunks(before ?? '', after)
    return {
      path: resolution.resolved.relative,
      created: before === null,
      bytes: Buffer.byteLength(after, 'utf8'),
      previousBytes: before === null ? null : Buffer.byteLength(before, 'utf8'),
      // The exact bytes the approval is about, so an edit-and-approve starts
      // from what was proposed rather than from memory. Same exposure as the
      // diff lines below; fetched on demand, never broadcast.
      content: after,
      ...diff,
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
    const decision = toolBroker.authorize({ mode: run?.permissionMode, tool, resolution })
    // A standing grant is consulted only when the decision was already "ask": it
    // softens a prompt and can never override a refusal.
    const standing = decision.decision === 'ask' && resolution.ok ? store.findStandingGrant({ toolName: name, resolved: resolution.resolved }) : null
    const authorization = standing
      ? { ...decision, decision: 'allow', allowed: true, requiresApproval: false, ruleId: 'allow.standing-grant', reason: `Allowed by a standing grant: ${standing.label}.`, standingGrantId: standing.id }
      : decision

    const existing = store.findToolCallByIdempotencyKey(runId, idempotencyKey)
    if (existing && ['completed', 'running'].includes(existing.status)) {
      return { status: 200, payload: { replayed: true, toolCall: existing, output: existing.output } }
    }

    // What is in the arguments, before anything decides about them: a call that
    // carries a credential is a fact the approver should see, and the audit should
    // record that it was there even though the stored copy is redacted.
    const warnings = scanArguments(input)
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
      ruleId: authorization.ruleId,
      warnings,
    })
    store.appendEvent({ runId, type: 'tool.requested', agentId, payload: { toolCallId: toolCall.id, name, kind: tool?.kind ?? 'unknown', input: store.summarizeInput(toolCall.input), resolved: toolCall.resolved, rule: authorization.ruleId } })
    if (warnings.length) {
      store.appendEvent({ runId, type: 'tool.arguments.suspicious', agentId, payload: { toolCallId: toolCall.id, name, warnings, note: 'The arguments contain something shaped like a credential. The stored copy is redacted; this records that it was there.' } })
    }

    if (!authorization.allowed) {
      const status = authorization.requiresApproval ? 'approval_required' : 'denied'
      store.updateToolCall(toolCall.id, { status, error: authorization.reason })
      store.appendEvent({ runId, type: authorization.requiresApproval ? 'approval.requested' : 'tool.denied', agentId, payload: { toolCallId: toolCall.id, name, reason: authorization.reason, rule: authorization.ruleId, fingerprint: toolCall.fingerprint, resolved: toolCall.resolved } })
      // What an approver needs to decide: why it stopped, what looks risky about the
      // arguments, and what a write would change.
      const preview = authorization.requiresApproval ? await buildWritePreview(name, resolution, input) : null
      return {
        status: authorization.requiresApproval ? 409 : 403,
        payload: { error: authorization.reason, approvalRequired: authorization.requiresApproval, rule: authorization.ruleId, toolCall: store.getToolCall(toolCall.id), warnings, ...(preview ? { preview } : {}) },
      }
    }

    const result = await runToolCall({ runId, toolCall, input, resolved: resolution, approved: false })
    return {
      status: result.ok ? 200 : 502,
      payload: result.ok ? { output: result.output, toolCall: store.getToolCall(toolCall.id), warnings } : { error: result.error, toolCall: store.getToolCall(toolCall.id), warnings },
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

      if (request.method === 'POST' && requestUrl.pathname === '/api/maintenance/export-trace') {
        const body = await readJson(request).catch(() => ({}))
        const runId = typeof body.runId === 'string' ? body.runId : null
        if (!runId || !store.getRun(runId)) {
          sendJson(response, 404, { error: 'Run not found: pass its runId.' })
          return
        }
        const exported = await maybeExportTrace({ store, runId })
        sendJson(response, 200, exported ? { exported: true, result: exported } : { exported: false, reason: 'No OTLP endpoint is configured (FULKRUM_OTLP_ENDPOINT).' })
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

      if (request.method === 'GET' && requestUrl.pathname === '/api/grants') {
        const includeRevoked = /^(1|true)$/i.test(requestUrl.searchParams.get('revoked') ?? '')
        sendJson(response, 200, {
          grants: store.listStandingGrants({ includeRevoked }),
          // When each was created or revoked, which is the part a reader needs and
          // the part that cannot be reconstructed from the grants themselves.
          history: store.listMaintenance({ limit: 50 }).filter((entry) => entry.kind === 'standing-grant'),
        })
        return
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/grants') {
        const body = await readJson(request)
        const tool = toolBroker.get(body.toolName)
        if (!tool) {
          sendJson(response, 400, { error: `Unknown tool: ${body.toolName ?? '(missing)'}` })
          return
        }
        if (tool.kind === 'shell') {
          // The same rule the "always" approval follows: a command's argv can be
          // anything, so there is no boundary to grant within.
          sendJson(response, 400, { error: 'A command has no scope to bind a standing grant to, so it has to be approved each time.' })
          return
        }
        const scope = validateStandingScope({ toolName: body.toolName, scopeKind: body.scopeKind ?? body.scope?.kind, scopeValue: body.scopeValue ?? body.scope?.value })
        if (!scope.ok) {
          sendJson(response, 400, { error: scope.error })
          return
        }
        const grant = store.createStandingGrant({ toolName: body.toolName, scopeKind: scope.kind, scopeValue: scope.value, label: typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : scope.label, createdBy: 'user' })
        sendJson(response, 201, { grant, grants: store.listStandingGrants() })
        return
      }

      const standingGrantMatch = requestUrl.pathname.match(/^\/api\/grants\/([^/]+)$/)
      if (request.method === 'DELETE' && standingGrantMatch) {
        const revoked = store.revokeStandingGrant(decodeURIComponent(standingGrantMatch[1]))
        sendJson(response, revoked ? 200 : 404, revoked ? { grant: revoked, grants: store.listStandingGrants() } : { error: 'No active standing grant with that id.' })
        return
      }

      const toolPreviewMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/tools\/([^/]+)\/preview$/)
      if (request.method === 'GET' && toolPreviewMatch) {
        const runId = decodeURIComponent(toolPreviewMatch[1])
        const toolCallId = decodeURIComponent(toolPreviewMatch[2])
        const toolCall = store.getToolCall(toolCallId)
        if (!toolCall || toolCall.runId !== runId) {
          sendJson(response, 404, { error: 'Tool call not found.' })
          return
        }
        const rawInput = store.getToolCallInput(toolCallId) ?? toolCall.input
        const resolution = toolBroker.resolve(toolCall.name, rawInput)
        if (!resolution.ok) {
          sendJson(response, 409, { error: `That call can no longer be resolved: ${resolution.error}` })
          return
        }
        const preview = await buildWritePreview(toolCall.name, resolution, rawInput)
        sendJson(response, 200, { toolCallId, rule: toolCall.ruleId, warnings: toolCall.warnings ?? [], status: toolCall.status, ...(preview ? { preview } : {}) })
        return
      }

      const runBundleMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/bundle$/)
      if (request.method === 'GET' && runBundleMatch) {
        const runId = decodeURIComponent(runBundleMatch[1])
        const report = buildRunReport({ store, runId })
        if (!report) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        const entries = [
          { name: `${runId}/report.md`, data: reportToMarkdown(report) },
          { name: `${runId}/report.json`, data: JSON.stringify(report, null, 2) },
          { name: `${runId}/events.json`, data: JSON.stringify(store.listEvents(runId), null, 2) },
          { name: `${runId}/artifacts.json`, data: JSON.stringify(buildArtifacts(store, runId), null, 2) },
        ]
        // Every file the run wrote, and the bytes it replaced, so the bundle can be
        // read without the database or the workspace. Capped: a run that wrote a
        // large tree would otherwise be assembled into memory whole.
        const maxBundleBytes = Math.max(Number(process.env.FULKRUM_BUNDLE_MAX_BYTES ?? 32_000_000), 100_000)
        let total = entries.reduce((sum, entry) => sum + Buffer.byteLength(String(entry.data), 'utf8'), 0)
        const omitted = []
        for (const call of store.listToolCalls(runId).filter((candidate) => candidate.kind === 'write' && candidate.status === 'completed')) {
          const rawInput = store.getToolCallInput(call.id) ?? call.input
          const relative = call.resolved?.relative ?? `unknown-${call.id}`
          const after = String(rawInput?.content ?? '')
          const before = typeof call.output?.previousContent === 'string' ? call.output.previousContent : null
          const size = Buffer.byteLength(after, 'utf8') + (before ? Buffer.byteLength(before, 'utf8') : 0)
          if (total + size > maxBundleBytes) {
            omitted.push(relative)
            continue
          }
          total += size
          entries.push({ name: `${runId}/files/after/${relative}`, data: after })
          if (before !== null) entries.push({ name: `${runId}/files/before/${relative}`, data: before })
        }
        if (omitted.length) {
          entries.push({ name: `${runId}/files/OMITTED.txt`, data: `These files were left out of the bundle because it would have exceeded ${maxBundleBytes} bytes:\n\n${omitted.join('\n')}\n` })
        }
        const zip = createZip(entries)
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="fulkrum-${runId}.zip"`,
          'Content-Length': String(zip.byteLength),
          'Cache-Control': 'no-store',
        })
        response.end(zip)
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/usage') {
        sendJson(response, 200, store.usageSummary({
          days: Number(requestUrl.searchParams.get('days') ?? 30),
          projectId: requestUrl.searchParams.get('projectId') || null,
        }))
        return
      }

      const runEstimateMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/estimate$/)
      if (request.method === 'GET' && runEstimateMatch) {
        const runId = decodeURIComponent(runEstimateMatch[1])
        const estimate = store.estimateRunCost(runId)
        if (!estimate) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        sendJson(response, 200, estimate)
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
        if (request.method === 'PATCH') {
          // A plan in use cannot be edited underneath the workers running it.
          if (['executing', 'paused'].includes(run.status)) {
            sendJson(response, 409, { error: `A plan cannot be edited while the run is ${run.status}. Wait for it to stop, or cancel it.` })
            return
          }
          const current = store.getLatestPlanForRun(runId)
          if (!current) {
            sendJson(response, 409, { error: 'There is no plan to edit yet. Draft one first.' })
            return
          }
          const body = await readJson(request)
          // Edits go through the same validation the model's own output gets, so a
          // hand-written plan cannot be looser than a generated one.
          const validation = validatePlan({ objective: body.objective ?? current.plan.objective, tasks: body.tasks ?? current.tasks })
          if (!validation.ok) {
            sendJson(response, 400, { error: `That plan cannot be used: ${validation.problems.join(' ')}`, problems: validation.problems })
            return
          }
          const edited = store.createPlan({
            projectId: run.projectId,
            runId,
            objective: validation.plan.objective,
            tasks: validation.plan.tasks,
            contentHash: planContentHash(validation.plan),
            source: 'edited',
          })
          // The new version supersedes the old one, so any approval the old hash
          // carried is no longer attached to what the run would execute.
          store.updateRun(runId, {
            planId: edited.plan.id,
            planVersion: edited.plan.version,
            ...(['review', 'interrupted'].includes(run.status) ? { status: 'planning' } : {}),
          })
          store.appendEvent({ runId, type: 'plan.edited', agentId: 'head', payload: { planId: edited.plan.id, version: edited.plan.version, hash: edited.plan.contentHash, tasks: edited.tasks.length, replacedVersion: current.plan.version, replacedHash: current.plan.contentHash } })
          sendJson(response, 200, { plan: edited.plan, tasks: edited.tasks, replacedVersion: current.plan.version })
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
        // Where a transition may start from.
        const allowedFrom = {
          'approve-plan': ['planning', 'review', 'interrupted'],
          pause: ['planning', 'executing', 'budget_exceeded'],
          // Interrupted is what resume exists for, budget_exceeded resumes once
          // the ceiling is raised, and failed resumes because failed tasks keep
          // their turns: the retry continues the conversation instead of
          // starting over.
          resume: ['paused', 'interrupted', 'budget_exceeded', 'failed'],
          cancel: ['planning', 'executing', 'paused', 'review', 'interrupted', 'budget_exceeded'],
        }
        if (!allowedFrom[body.action].includes(run.status)) {
          sendJson(response, 409, { error: `A run in ${run.status} state cannot be ${body.action === 'approve-plan' ? 'approved' : body.action + 'd'}.` })
          return
        }
        // Entering executing — by approval or by resume — requires an approved plan.
        // This is the guard that closes the bypass where pause in planning, followed
        // by resume, produced an executing run nobody had approved, from which
        // further pause → resume cycles kept it alive. A paused run from planning is
        // legitimate to *pause*, but resuming it into executing needs the plan.
        if (body.action === 'resume' || (body.action === 'approve-plan' && run.status !== 'planning')) {
          const plan = run.planId ? store.getPlan(run.planId) : store.getLatestPlanForRun(runId)
          if (!plan || plan.plan.status !== 'approved') {
            sendJson(response, 409, { error: 'That run has no approved plan to resume. Approve a plan first.' })
            return
          }
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
          // A superseded version is a plan the user replaced, by editing or by
          // redrafting. Approving it would quietly point the run back at it, so it
          // is refused rather than accepted: the hash matches, but the decision was
          // made about a plan that is no longer the current one.
          if (plan.plan.status === 'superseded') {
            store.appendEvent({ runId, type: 'plan.approval.rejected', agentId: 'head', payload: { planId: plan.plan.id, version: plan.plan.version, reason: 'superseded' } })
            sendJson(response, 409, { error: `Plan v${plan.plan.version} was replaced. Review the current version and approve that.` })
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

        const patch = { status: transition[0] }
        if (body.action === 'resume' && run.status === 'interrupted') {
          patch.interruptedAt = null
          patch.interruptionReason = null
        }
        const nextRun = store.updateRun(runId, patch)
        const event = store.appendEvent({ runId, type: transition[1], payload: { source: 'user', previousStatus: run.status, ...(approvalPayload ?? {}) } })
        if (body.action === 'resume') {
          // Resuming is only legitimate for a run whose plan somebody approved.
          // Guarding the transition alone was not enough: planning → pause → resume
          // produced an *executing* run with no approved plan, from which pause →
          // resume worked forever after. An interrupted run that never got as far as
          // approving a plan (planning → interrupted, no plan id) is in the same
          // boat: `ensurePlan` would quietly attach a demo plan and start it.
          const plan = run.planId ? store.getPlan(run.planId) : store.getLatestPlanForRun(runId)
          if (!plan || plan.plan.status !== 'approved') {
            sendJson(response, 409, { error: 'That run has no approved plan to resume. Approve a plan first.' })
            return
          }
        }
        if (body.action === 'approve-plan' || body.action === 'resume') {
          orchestrator.start(runId, { routing })
        }
        if (body.action === 'cancel' && execution) {
          // The run stops at its next checkpoint, but a command already in the
          // container would keep working until its timeout. Cancelling stops both.
          const stopped = await execution.kill(runId, { reason: 'the run was cancelled' })
          if (stopped.stopped) {
            store.appendEvent({ runId, type: 'run.command.stopped', payload: { containers: stopped.containers, reason: stopped.reason } })
          }
        }
        if (body.action === 'cancel') {
          // A worker parked on an approval holds a promise only an approve or a deny
          // resolves; cancelling the run has to end the call as well, or the worker
          // waits forever on a run that no longer exists.
          const abandoned = orchestrator.abandonWaiters('The run was cancelled while this call awaited approval.')
          if (abandoned.length) {
            store.appendEvent({ runId, type: 'run.cancelled', agentId: 'head', payload: { ...({ source: 'user', previousStatus: run.status }), abandonedCalls: abandoned.length } })
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

        // A question is answered, not approved: approving it would execute
        // nothing and strand the worker on a decision that never arrives.
        if (toolCall.name === 'run.ask') {
          sendJson(response, 409, { error: 'Questions are answered, not approved: reply through the answer endpoint or deny the call.' })
          return
        }

        // The body may confirm which fingerprint was approved. It can never
        // supply the arguments — unless it openly says it is editing them (see
        // below): those come from the stored request, so an approval click
        // cannot be redirected to a different payload.
        const body = await readJson(request)
        if (typeof body.fingerprint === 'string' && toolCall.fingerprint && body.fingerprint !== toolCall.fingerprint) {
          sendJson(response, 409, { error: 'The approved fingerprint does not match the recorded tool call.' })
          return
        }

        // Approve-with-edits: the user changes the arguments before they run.
        // This rides an explicit `editedInput` field — a bare `input` is still
        // ignored, so an approval click cannot be redirected to a different
        // payload. The edit is a new call, not a silent rewrite: the original
        // is denied as superseded, the parked worker is released with that
        // reason, and the edited arguments walk the whole
        // resolve-authorize-fingerprint path, parking again if asked.
        if (body.editedInput !== undefined && body.editedInput !== null) {
          if (typeof body.editedInput !== 'object' || Array.isArray(body.editedInput)) {
            sendJson(response, 400, { error: 'Edited arguments must be a JSON object.' })
            return
          }
          const edited = toolBroker.resolve(toolCall.name, body.editedInput)
          if (!edited.ok) {
            sendJson(response, 409, { error: `The edited arguments cannot be resolved: ${edited.error}` })
            return
          }
          const tool = toolBroker.get(toolCall.name)
          const authorization = toolBroker.authorize({ mode: run.permissionMode, tool, resolution: edited })
          if (!authorization.allowed && !authorization.requiresApproval) {
            sendJson(response, 403, { error: authorization.reason, rule: authorization.ruleId })
            return
          }
          if (['cancelled', 'completed', 'failed', 'interrupted'].includes(store.getRun(runId)?.status ?? '')) {
            sendJson(response, 409, { error: 'The run ended before this edit could run.' })
            return
          }
          store.updateToolCall(toolCall.id, { status: 'denied', error: 'Superseded by an edited approval.' })
          store.appendEvent({ runId, type: 'tool.denied', agentId: toolCall.agentId ?? 'head', payload: { toolCallId: toolCall.id, name: toolCall.name, reason: 'Superseded by an edited approval.', rule: 'deny.superseded', fingerprint: toolCall.fingerprint, resolved: toolCall.resolved } })
          orchestrator.denyToolCall(toolCall.id, 'Superseded by an edited approval: decide again on the new call if one parks.')
          const outcome = await submitToolCall({ runId, run, name: toolCall.name, input: body.editedInput, agentId: toolCall.agentId ?? 'head' })
          sendJson(response, outcome.status, { ...outcome.payload, edited: true, superseded: toolCall.id })
          return
        }

        const scope = body.scope === 'run' ? 'run' : body.scope === 'always' ? 'always' : 'once'
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

        let standingGrant = null
        // "Always" is not blanket: it is scoped to what this call can be bounded by,
        // and it refuses rather than widening when nothing bounds it. Derived here,
        // after the call is resolved, because the scope comes from the resolution.
        const standingScope = scope === 'always' ? standingScopeFor({ toolName: toolCall.name, resolved: resolution.resolved }) : null
        if (standingScope && !standingScope.ok) {
          sendJson(response, 400, { error: standingScope.error })
          return
        }
        // Claim the call atomically before anything else: two rapid approvals both
        // pass the status check above, but only one claim succeeds, so only one
        // execution happens. The claim is the same transaction as the grants it
        // produces, so a call is never both approved twice and granted once.
        const claim = store.claimToolCallForApproval(toolCall.id, scope)
        if (!claim.claimed) {
          sendJson(response, 409, { error: 'Tool call is no longer awaiting approval.' })
          return
        }
        // A cancel racing this approval must win: no work starts for a run that
        // already ended. Checked after the claim and immediately before anything
        // executes, with no awaits between the check and the handoff below, so
        // nothing can slip between them in a single-threaded bridge.
        const liveRun = store.getRun(runId)
        if (!liveRun || ['cancelled', 'completed', 'failed', 'interrupted'].includes(liveRun.status)) {
          store.updateToolCall(toolCall.id, { status: 'denied', error: `The run ended (${liveRun?.status ?? 'gone'}) before this call executed.` })
          store.appendEvent({ runId, type: 'tool.denied', agentId: toolCall.agentId ?? 'head', payload: { toolCallId: toolCall.id, name: toolCall.name, reason: 'The run ended before this call executed.', rule: 'deny.run-ended' } })
          sendJson(response, 409, { error: 'The run ended before this call executed.' })
          return
        }
        store.transaction(() => {
          if (scope === 'run') {
            const grant = store.grantApproval({ runId, toolName: toolCall.name, kind: toolCall.kind })
            store.appendEvent({ runId, type: 'approval.granted', agentId: toolCall.agentId ?? 'head', payload: { toolName: toolCall.name, kind: toolCall.kind, scope: 'run', grantId: grant.id } })
          }
          if (standingScope?.ok) {
            standingGrant = store.createStandingGrant({ toolName: toolCall.name, scopeKind: standingScope.kind, scopeValue: standingScope.value, label: standingScope.label, createdBy: 'user' })
            store.appendEvent({ runId, type: 'approval.standing', agentId: toolCall.agentId ?? 'head', payload: { grantId: standingGrant.id, toolName: toolCall.name, scopeKind: standingScope.kind, scopeValue: standingScope.value, label: standingScope.label } })
          }
        })
        const resumed = await orchestrator.approveToolCall(toolCallId)
        if (resumed.handled) {
          sendJson(response, 200, { resumed: true, result: resumed.result, toolCall: store.getToolCall(toolCallId), standingGrant })
          return
        }

        // No worker is parked on this call (it was raised through the tools API),
        // so execute it directly and record that no run resumed.
        const result = await runToolCall({ runId, toolCall: store.getToolCall(toolCallId), input: rawInput, resolved: resolution, approved: true })
        sendJson(response, result.ok ? 200 : 502, result.ok ? { output: result.output, toolCall: store.getToolCall(toolCallId), resumed: false, standingGrant } : { error: result.error, toolCall: store.getToolCall(toolCallId), standingGrant })
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
        // The same atomic claim an approval makes: a deny racing an approve (or
        // another deny) resolves the call exactly once.
        const claim = store.claimToolCallForApproval(toolCall.id, null)
        if (!claim.claimed) {
          sendJson(response, 409, { error: 'Tool call is no longer awaiting approval.' })
          return
        }
        store.updateToolCall(toolCall.id, { status: 'denied', error: reason })
        store.appendEvent({ runId, type: 'tool.denied', agentId: toolCall.agentId ?? 'head', payload: { toolCallId, name: toolCall.name, reason, rule: 'deny.user', fingerprint: toolCall.fingerprint, resolved: toolCall.resolved } })
        // The worker is waiting on this call, so tell it no: a denial it can read
        // is information it can act on.
        const handled = orchestrator.denyToolCall(toolCallId, reason)
        sendJson(response, 200, { denied: true, resumed: handled.handled, toolCall: store.getToolCall(toolCallId) })
        return
      }

      const toolAnswerMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/tools\/([^/]+)\/answer$/)
      if (request.method === 'POST' && toolAnswerMatch) {
        const runId = decodeURIComponent(toolAnswerMatch[1])
        const toolCallId = decodeURIComponent(toolAnswerMatch[2])
        const run = store.getRun(runId)
        const toolCall = store.getToolCall(toolCallId)
        if (!run || !toolCall || toolCall.runId !== runId || toolCall.status !== 'approval_required' || toolCall.name !== 'run.ask') {
          sendJson(response, 409, { error: 'No question is awaiting an answer on this call.' })
          return
        }
        const body = await readJson(request)
        const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
        if (!answer) {
          sendJson(response, 400, { error: 'An answer is required.' })
          return
        }
        if (Buffer.byteLength(answer, 'utf8') > 5000) {
          sendJson(response, 413, { error: 'The answer must be 5000 bytes or fewer.' })
          return
        }
        // Answering executes nothing: the words become the tool result, and the
        // parked worker continues on them the way it would on any tool output.
        const answered = orchestrator.answerToolCall(toolCallId, answer)
        if (!answered.handled) {
          sendJson(response, 409, { error: 'No worker is waiting on this question anymore.' })
          return
        }
        sendJson(response, 200, { answered: true, resumed: true, toolCall: store.getToolCall(toolCallId) })
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
