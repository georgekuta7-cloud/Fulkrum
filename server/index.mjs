import http from 'node:http'
import { FulkrumStore } from './store.mjs'
import { createProviderRegistry } from './providerRegistry.mjs'
import { createRunOrchestrator } from './orchestrator.mjs'
import { FulkrumToolBroker } from './toolBroker.mjs'
import { privateProviderUrlsAllowed, validateOutboundUrl } from './networkPolicy.mjs'

const port = Number(process.env.FULKRUM_API_PORT ?? 8787)
const store = new FulkrumStore()
const providerRegistry = createProviderRegistry(store)
const toolBroker = new FulkrumToolBroker()

const systemPrompt = `You are Fulkrum's Head AI. You are the supervisor of a small team with a research worker and a build worker. The user speaks to you in a shared project chat. Keep the conversation practical and concise. Explain the plan, identify the next decision, and never claim a worker completed something unless the system has reported it. Before execution, help the user shape and approve a plan. During execution, coordinate the workers and surface disagreements.`

const allowedOrigins = new Set((process.env.FULKRUM_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean))

function isAllowedOrigin(origin) {
  return !origin || allowedOrigins.has(origin)
}

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

function sendJson(response, status, payload) {
  const headers = { ...jsonHeaders }
  if (response.allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = response.allowedOrigin
    headers.Vary = 'Origin'
  }
  response.writeHead(status, headers)
  response.end(JSON.stringify(payload))
}

function readJson(request, maximumLength = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = ''

    request.on('data', (chunk) => {
      body += chunk
      if (body.length > maximumLength) {
        reject(new Error('Request body is too large.'))
        request.destroy()
      }
    })

    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('Request body must be valid JSON.'))
      }
    })

    request.on('error', reject)
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

async function fetchJson(url, options) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  const response = await fetch(url, { ...options, signal: controller.signal })
  const payload = await response.json().catch(() => ({}))
  clearTimeout(timeout)

  if (!response.ok) {
    const providerMessage = payload?.error?.message ?? payload?.error ?? `Provider returned ${response.status}`
    throw new Error(String(providerMessage).slice(0, 500))
  }

  return payload
}

async function callOpenAiCompatible(provider, model, messages, instructions = systemPrompt) {
  const baseUrl = await validateOutboundUrl(provider.baseUrl, { allowPrivate: privateProviderUrlsAllowed() })
  const payload = await fetchJson(`${baseUrl.toString().replace(/\/$/, '')}/chat/completions`, {
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
  const payload = await fetchJson('https://api.anthropic.com/v1/messages', {
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
  const payload = await fetchJson(`${baseUrl.toString().replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(providerRegistry.secret(provider))}`, {
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
  if (provider.protocol === 'anthropic') {
    return callAnthropic(provider, model, messages, instructions)
  }

  if (provider.protocol === 'google') {
    return callGoogle(provider, model, messages, instructions)
  }

  return callOpenAiCompatible(provider, model, messages, instructions)
}

async function testProvider(provider) {
  const secret = providerRegistry.secret(provider)
  if (!secret) {
    return { configured: false, reachable: false, reason: `Missing ${provider.envKeys.join(' or ')}` }
  }

  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const providerBaseUrl = await validateOutboundUrl(provider.baseUrl, { allowPrivate: privateProviderUrlsAllowed() })
    let url
    let headers = {}
    if (provider.protocol === 'google') {
      const googleUrl = new URL(`${providerBaseUrl.toString().replace(/\/$/, '')}/models`)
      googleUrl.searchParams.set('key', secret)
      googleUrl.searchParams.set('pageSize', '1')
      url = googleUrl
    } else if (provider.protocol === 'anthropic') {
      url = `${providerBaseUrl.toString().replace(/\/$/, '')}/models?limit=1`
      headers = { 'x-api-key': secret, 'anthropic-version': '2023-06-01' }
    } else {
      url = `${providerBaseUrl.toString().replace(/\/$/, '')}/models`
      headers = { Authorization: `Bearer ${secret}` }
    }

    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    const responseText = await response.text()
    let error
    if (!response.ok) {
      try {
        const payload = JSON.parse(responseText)
        error = payload?.error?.message ?? payload?.message ?? `Provider returned ${response.status}`
      } catch {
        error = `Provider returned ${response.status}`
      }
    }
    return { configured: true, reachable: response.ok, status: response.status, latencyMs: Date.now() - startedAt, error }
  } catch (error) {
    return { configured: true, reachable: false, latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : 'Provider connection failed.' }
  } finally {
    clearTimeout(timeout)
  }
}

const orchestrator = createRunOrchestrator({
  store,
  providerRegistry,
  toolBroker,
  callModel: (provider, model, messages, instructions) => callProvider(provider, model, messages, instructions),
})

async function handleChat(request, response) {
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
  const provider = providerRegistry.resolve(body.routing?.head)
  const model = providerRegistry.model(provider, body.routing?.head)
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

    if (typeof reply !== 'string' || !reply.trim()) {
      throw new Error('The provider returned an empty response.')
    }

    const cleanReply = reply.trim()
    store.appendMessage({ projectId: project.id, runId: run.id, role: 'assistant', agentId: 'head', content: cleanReply, metadata: { demo: false, provider: provider.id, model } })
    store.appendEvent({ runId: run.id, type: 'message.assistant', agentId: 'head', payload: { content: cleanReply, demo: false, provider: provider.id, model } })
    sendJson(response, 200, { reply: cleanReply, demo: false, provider: provider.id, model, projectId: project.id, runId: run.id })
  } catch (error) {
    sendJson(response, 502, { error: `Provider request failed: ${error instanceof Error ? error.message : 'unknown error'}` })
  }
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)

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
    sendJson(response, 200, { ok: true, service: 'fulkrum-api', workspaceRoot: toolBroker.workspaceRoot, tools: toolBroker.list().length, store: store.stats() })
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
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid provider.' })
    }
    return
  }

  const providerTestMatch = requestUrl.pathname.match(/^\/api\/providers\/([^/]+)\/test$/)
  if (request.method === 'POST' && providerTestMatch) {
    try {
      const provider = providerRegistry.resolve({ providerId: decodeURIComponent(providerTestMatch[1]) })
      const result = await testProvider(provider)
      sendJson(response, result.reachable || !result.configured ? 200 : 502, { provider: providerRegistry.list().find((item) => item.id === provider.id), result })
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Provider test failed.' })
    }
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
      const project = store.createProject({ name: body.name, settings: body.settings })
      sendJson(response, 201, { project })
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid project.' })
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
      const project = store.updateProject(decodeURIComponent(projectMatch[1]), body)
      sendJson(response, 200, { project })
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Could not update project.' })
    }
    return
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/runs') {
    try {
      const body = await readJson(request)
      const project = store.getProject(body.projectId)
      if (!project) {
        sendJson(response, 404, { error: 'Project not found.' })
        return
      }
      sendJson(response, 201, { run: store.createRun({ projectId: body.projectId, mode: body.mode, permissionMode: body.permissionMode }) })
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid run.' })
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

  const runStreamMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)\/stream$/)
  if (request.method === 'GET' && runStreamMatch) {
    const runId = decodeURIComponent(runStreamMatch[1])
    if (!store.getRun(runId)) {
      sendJson(response, 404, { error: 'Run not found.' })
      return
    }
    const after = Number(requestUrl.searchParams.get('after') ?? 0)
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
    for (const event of store.listEvents(runId, Number.isFinite(after) ? after : 0)) writeEvent(event)
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
    const transitions = { 'approve-plan': ['executing', 'plan.approved'], pause: ['paused', 'run.paused'], resume: ['executing', 'run.resumed'], cancel: ['cancelled', 'run.cancelled'] }
    const transition = transitions[body.action]
    if (!run || !transition) {
      sendJson(response, 400, { error: 'Unknown run or control action.' })
      return
    }
    const nextRun = store.updateRun(runId, { status: transition[0] })
    const event = store.appendEvent({ runId, type: transition[1], payload: { source: 'user' } })
    if (body.action === 'approve-plan') {
      orchestrator.start(runId, { routing: body.routing ?? {} })
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
    await readJson(request, 200_000)
    const resumed = await orchestrator.approveToolCall(toolCallId)
    if (resumed.handled) {
      sendJson(response, 200, { resumed: true, result: resumed.result, toolCall: store.getToolCall(toolCallId) })
      return
    }
    const input = toolCall.input
    store.updateToolCall(toolCallId, { status: 'running' })
    store.appendEvent({ runId, type: 'tool.started', agentId: toolCall.agentId ?? 'head', payload: { toolCallId, name: toolCall.name, approved: true } })
    try {
      const output = await toolBroker.execute(toolCall.name, input)
      const safeOutput = toolBroker.redact(output)
      store.updateToolCall(toolCallId, { status: 'completed', output: safeOutput })
      store.appendEvent({ runId, type: 'tool.completed', agentId: toolCall.agentId ?? 'head', payload: { toolCallId, name: toolCall.name, output: safeOutput, approved: true } })
      sendJson(response, 200, { output, toolCall: store.getToolCall(toolCallId) })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Approved tool execution failed.'
      store.updateToolCall(toolCallId, { status: 'failed', error: message })
      store.appendEvent({ runId, type: 'tool.failed', agentId: toolCall.agentId ?? 'head', payload: { toolCallId, name: toolCall.name, error: message, approved: true } })
      sendJson(response, 502, { error: message, toolCall: store.getToolCall(toolCallId) })
    }
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
    const body = await readJson(request, 200_000)
    const tool = toolBroker.get(body.name)
    const authorization = toolBroker.authorize(run.permissionMode, tool)
    const agentId = body.agentId ?? 'head'
    const toolCall = store.createToolCall({ runId, agentId, name: body.name, kind: tool?.kind ?? 'unknown', input: toolBroker.redact(body.input ?? {}) })
    store.appendEvent({ runId, type: 'tool.requested', agentId, payload: { toolCallId: toolCall.id, name: body.name, kind: tool?.kind ?? 'unknown', input: toolBroker.redact(body.input ?? {}) } })
    if (!authorization.allowed) {
      const status = authorization.requiresApproval ? 'approval_required' : 'denied'
      store.updateToolCall(toolCall.id, { status, error: authorization.reason })
      store.appendEvent({ runId, type: authorization.requiresApproval ? 'approval.requested' : 'tool.denied', agentId, payload: { toolCallId: toolCall.id, name: body.name, reason: authorization.reason } })
      sendJson(response, authorization.requiresApproval ? 409 : 403, { error: authorization.reason, approvalRequired: authorization.requiresApproval, toolCall: store.getToolCall(toolCall.id) })
      return
    }
    store.updateToolCall(toolCall.id, { status: 'running' })
    store.appendEvent({ runId, type: 'tool.started', agentId, payload: { toolCallId: toolCall.id, name: body.name } })
    try {
      const output = await toolBroker.execute(body.name, body.input ?? {})
      const safeOutput = toolBroker.redact(output)
      store.updateToolCall(toolCall.id, { status: 'completed', output: safeOutput })
      store.appendEvent({ runId, type: 'tool.completed', agentId, payload: { toolCallId: toolCall.id, name: body.name, output: safeOutput } })
      sendJson(response, 200, { output, toolCall: store.getToolCall(toolCall.id) })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed.'
      store.updateToolCall(toolCall.id, { status: 'failed', error: message })
      store.appendEvent({ runId, type: 'tool.failed', agentId, payload: { toolCallId: toolCall.id, name: body.name, error: message } })
      sendJson(response, 502, { error: message, toolCall: store.getToolCall(toolCall.id) })
    }
    return
  }

  const runMatch = requestUrl.pathname.match(/^\/api\/runs\/([^/]+)$/)
  if (request.method === 'GET' && runMatch) {
    const snapshot = store.getRunSnapshot(decodeURIComponent(runMatch[1]))
    sendJson(response, snapshot ? 200 : 404, snapshot ? snapshot : { error: 'Run not found.' })
    return
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/chat') {
    try {
      await handleChat(request, response)
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid request.' })
    }
    return
  }

  sendJson(response, 404, { error: 'Not found.' })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Fulkrum API bridge listening on http://127.0.0.1:${port}`)
})

function shutdown(signal) {
  console.log(`Fulkrum API bridge received ${signal}; stopping`)
  server.close(() => {
    store.close()
    process.exit(0)
  })
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))