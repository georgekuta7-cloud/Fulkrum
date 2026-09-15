import http from 'node:http'
import { privateProviderUrlsAllowed, validateOutboundUrl } from './networkPolicy.mjs'
import { fingerprintToolCall } from './permissions.mjs'

export const MAX_JSON_BODY_BYTES = 100_000
export const MAX_TOOL_BODY_BYTES = 600_000

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function sendJson(response, status, payload) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }
  if (response.allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = response.allowedOrigin
    headers.Vary = 'Origin'
  }
  response.writeHead(status, headers)
  response.end(JSON.stringify(payload))
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
    let settled = false
    const fail = (status, message) => {
      if (settled) return
      settled = true
      reject(new HttpError(status, message))
    }

    request.on('data', (chunk) => {
      if (settled) return
      body += chunk
      if (body.length > maximumLength) {
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

const resumableStatuses = new Set(['paused', 'executing'])

/**
 * Build the API bridge.
 *
 * Every handler runs inside a guard: an unexpected throw returns a status
 * instead of rejecting the server's callback promise, which Node would treat as
 * an unhandled rejection and use to terminate the process, orphaning every run.
 */
export function createApp({ store, toolBroker, providerRegistry, orchestrator, callProvider, allowedOrigins = new Set(), ownerId = 'local' }) {
  const isAllowedOrigin = (origin) => !origin || allowedOrigins.has(origin)
  let draining = null

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

    if (!providerRegistry.secret(provider)) {
      const reply = demoReply(message)
      store.appendMessage({ projectId: project.id, runId: run.id, role: 'assistant', agentId: 'head', content: reply, metadata: { demo: true, provider: provider.id, model } })
      store.appendEvent({ runId: run.id, type: 'message.assistant', agentId: 'head', payload: { content: reply, demo: true, provider: provider.id, model } })
      sendJson(response, 200, { reply, demo: true, provider: provider.id, model, projectId: project.id, runId: run.id })
      return
    }

    try {
      const reply = await callProvider(provider, model, history)
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('The provider returned an empty response.')
      const cleanReply = reply.trim()
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
      const output = await toolBroker.execute(toolCall.name, input, resolved)
      const safeOutput = toolBroker.redact(output)
      store.updateToolCall(toolCall.id, { status: 'completed', output: safeOutput })
      store.appendEvent({ runId, type: 'tool.completed', agentId: toolCall.agentId ?? 'head', payload: { toolCallId: toolCall.id, name: toolCall.name, output: safeOutput, approved } })
      return { ok: true, output: safeOutput }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed.'
      store.updateToolCall(toolCall.id, { status: 'failed', error: message })
      store.appendEvent({ runId, type: 'tool.failed', agentId: toolCall.agentId ?? 'head', payload: { toolCallId: toolCall.id, name: toolCall.name, error: message, approved } })
      return { ok: false, error: message }
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
      response.allowedOrigin = origin || null

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

      if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
        sendJson(response, 200, {
          ok: true,
          service: 'fulkrum-api',
          workspaceRoot: toolBroker.workspaceRoot,
          tools: toolBroker.list().length,
          execution: 'host-restricted',
          store: store.stats(),
        })
        return
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/tools') {
        sendJson(response, 200, { workspaceRoot: toolBroker.workspaceRoot, tools: toolBroker.list() })
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
        const result = await providerRegistry.testConnection(provider, { allowPrivate: privateProviderUrlsAllowed(), validateUrl: validateOutboundUrl })
        sendJson(response, result.reachable || !result.configured ? 200 : 502, { provider: providerRegistry.list().find((item) => item.id === provider.id), result })
        return
      }

      const providerMatch = requestUrl.pathname.match(/^\/api\/providers\/([^/]+)$/)
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

      const runStreamMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/stream$/)
      if (request.method === 'GET' && runStreamMatch) {
        const runId = decodeURIComponent(runStreamMatch[1])
        if (!store.getRun(runId)) {
          sendJson(response, 404, { error: 'Run not found.' })
          return
        }
        // Last-Event-ID is what the browser resends after a dropped connection,
        // so a reconnect resumes from the last event it actually saw instead of
        // replaying the whole run.
        const lastEventId = request.headers['last-event-id']
        const requested = Number(requestUrl.searchParams.get('after') ?? Number(lastEventId ?? 0))
        const after = Number.isFinite(requested) ? requested : 0
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        response.write('retry: 1500\n\n')
        const writeEvent = (event) => {
          response.write(`id: ${event.sequence}\nevent: fulkrum\ndata: ${JSON.stringify(event)}\n\n`)
        }
        for (const event of store.listEvents(runId, after)) writeEvent(event)
        const unsubscribe = store.subscribeEvents(runId, writeEvent)
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
        request.on('close', () => {
          clearInterval(heartbeat)
          unsubscribe()
        })
        return
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

        const transition = controlTransitions[body.action]
        if (!run || !transition) {
          sendJson(response, 400, { error: 'Unknown run or control action.' })
          return
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
        const event = store.appendEvent({ runId, type: transition[1], payload: { source: 'user', previousStatus: run.status } })
        if (body.action === 'approve-plan' || body.action === 'resume') {
          orchestrator.start(runId, { routing: body.routing ?? store.getProject(run.projectId)?.project?.settings?.routing ?? {} })
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

        const scope = ['once', 'run', 'always'].includes(body.scope) ? body.scope : 'once'
        const resolution = toolCall.resolved ? { ok: true, resolved: toolCall.resolved, sensitive: false } : toolBroker.resolve(toolCall.name, toolCall.input)
        if (!resolution.ok) {
          store.updateToolCall(toolCall.id, { status: 'denied', error: resolution.error })
          sendJson(response, 409, { error: `This tool call can no longer be executed: ${resolution.error}` })
          return
        }
        // Detect a row edited after the fact: the recorded fingerprint must still
        // describe the recorded arguments.
        const expectedFingerprint = fingerprintToolCall(resolution)
        if (toolCall.fingerprint && toolCall.fingerprint !== expectedFingerprint) {
          store.updateToolCall(toolCall.id, { status: 'denied', error: 'The recorded arguments no longer match the approved fingerprint.' })
          store.appendEvent({ runId, type: 'tool.denied', agentId: toolCall.agentId ?? 'head', payload: { toolCallId: toolCall.id, name: toolCall.name, reason: 'Fingerprint mismatch.' } })
          sendJson(response, 409, { error: 'The recorded arguments no longer match the approved fingerprint.' })
          return
        }

        store.markToolCallApproved(toolCall.id, scope)
        const resumed = await orchestrator.approveToolCall(toolCallId)
        if (resumed.handled) {
          sendJson(response, 200, { resumed: true, result: resumed.result, toolCall: store.getToolCall(toolCallId) })
          return
        }

        // No worker is parked on this call (it was raised through the tools API),
        // so execute it directly and record that no run resumed.
        const result = await runToolCall({ runId, toolCall: store.getToolCall(toolCallId), input: toolCall.input, resolved: resolution, approved: true })
        sendJson(response, result.ok ? 200 : 502, result.ok ? { output: result.output, toolCall: store.getToolCall(toolCallId), resumed: false } : { error: result.error, toolCall: store.getToolCall(toolCallId) })
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
        const tool = toolBroker.get(body.name)
        const resolution = toolBroker.resolve(body.name, body.input ?? {})
        const authorization = toolBroker.authorize({ mode: run.permissionMode, tool, resolution })
        const agentId = body.agentId ?? 'head'
        const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null

        const existing = store.findToolCallByIdempotencyKey(runId, idempotencyKey)
        if (existing && ['completed', 'running'].includes(existing.status)) {
          sendJson(response, 200, { replayed: true, toolCall: existing, output: existing.output })
          return
        }

        const toolCall = store.createToolCall({
          runId,
          agentId,
          name: body.name,
          kind: tool?.kind ?? 'unknown',
          input: toolBroker.redact(body.input ?? {}),
          resolved: resolution.ok ? resolution.resolved : null,
          fingerprint: resolution.ok ? fingerprintToolCall(resolution) : null,
          idempotencyKey,
        })
        store.appendEvent({ runId, type: 'tool.requested', agentId, payload: { toolCallId: toolCall.id, name: body.name, kind: tool?.kind ?? 'unknown', input: toolCall.input, resolved: toolCall.resolved, rule: authorization.ruleId } })

        if (!authorization.allowed) {
          const status = authorization.requiresApproval ? 'approval_required' : 'denied'
          store.updateToolCall(toolCall.id, { status, error: authorization.reason })
          store.appendEvent({ runId, type: authorization.requiresApproval ? 'approval.requested' : 'tool.denied', agentId, payload: { toolCallId: toolCall.id, name: body.name, reason: authorization.reason, rule: authorization.ruleId, fingerprint: toolCall.fingerprint, resolved: toolCall.resolved } })
          sendJson(response, authorization.requiresApproval ? 409 : 403, { error: authorization.reason, approvalRequired: authorization.requiresApproval, rule: authorization.ruleId, toolCall: store.getToolCall(toolCall.id) })
          return
        }

        const result = await runToolCall({ runId, toolCall, input: body.input ?? {}, resolved: resolution, approved: false })
        sendJson(response, result.ok ? 200 : 502, result.ok ? { output: result.output, toolCall: store.getToolCall(toolCall.id) } : { error: result.error, toolCall: store.getToolCall(toolCall.id) })
        return
      }

      const runMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)$/)
      if (request.method === 'GET' && runMatch) {
        const snapshot = store.getRunSnapshot(decodeURIComponent(runMatch[1]))
        sendJson(response, snapshot ? 200 : 404, snapshot ? { ...snapshot, audit: store.verifyEventChain(snapshot.run.id) } : { error: 'Run not found.' })
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
    // Stop accepting work without killing the process: a run mid-step deserves
    // the chance to finish writing its state.
    beginDraining(reason) {
      draining = reason
    },
    isDraining: () => draining,
    ownerId,
  }
}
