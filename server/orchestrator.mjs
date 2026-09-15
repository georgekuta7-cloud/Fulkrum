import { setTimeout as wait } from 'node:timers/promises'

const workerDefinitions = [
  {
    agentId: 'research',
    title: 'Validate assumptions',
    route: 'Anthropic · claude-opus-4-1',
    role: 'Scout, the research worker',
    instructions: 'Inspect the user direction and identify the most important assumptions, risks, and evidence needed before implementation. Return a concise findings summary with confidence and open questions.',
    tool: { name: 'workspace.search', input: { query: 'README', path: '.' } },
  },
  {
    agentId: 'builder',
    title: 'Shape the proof',
    route: 'OpenAI · gpt-5',
    role: 'Forge, the build worker',
    instructions: 'Turn the approved direction into a small proof-of-value implementation plan. Identify the first artifacts, checks, and dependencies. Use Scout findings when they are provided and call out any disagreement.',
    tool: { name: 'workspace.read', input: { path: 'package.json' } },
  },
]

const workerPrompt = (definition, goal, handoff = '') => `You are ${definition.role} inside Fulkrum. You are one worker in a bounded supervisor run. Do not claim to have changed files or called tools unless the system reports that action.\n\nProject direction:\n${goal}\n\nYour assignment:\n${definition.instructions}\n\n${handoff ? `Handoff from Scout:\n${handoff}\n` : ''}Return only a concise, decision-useful summary for Head AI.`

function demoResult(definition, goal, handoff = '') {
  if (definition.agentId === 'research') {
    return `Scout demo finding: the first proof should validate the narrowest user outcome, the selected provider path, and one observable success check. Open question: which external dependency matters most to the first release? Direction received: ${goal}`
  }

  return `Forge demo plan: start with one vertical slice, add a focused verification step, and keep the worker boundary reversible. Forge received Scout's handoff${handoff ? `: ${handoff}` : ' and is waiting for a live research result'}.`
}

function isCancelled(store, runId) {
  return store.getRun(runId)?.status === 'cancelled'
}

async function waitUntilRunnable(store, runId) {
  while (true) {
    const status = store.getRun(runId)?.status
    if (!status || ['cancelled', 'completed', 'failed'].includes(status)) return false
    if (status !== 'paused') return true
    await wait(100)
  }
}

export function createRunOrchestrator({ store, providerRegistry, toolBroker, callModel }) {
  const activeRuns = new Map()
  const approvalWaiters = new Map()

  const appendTaskEvent = (runId, type, task, payload = {}) => store.appendEvent({
    runId,
    type,
    agentId: task.agentId,
    payload: { taskId: task.id, title: task.title, ...payload },
  })

  const executeApprovedTool = async ({ runId, task, toolCall, input, approved = false }) => {
    store.updateToolCall(toolCall.id, { status: 'running' })
    store.appendEvent({ runId, type: 'tool.started', agentId: task.agentId, payload: { toolCallId: toolCall.id, name: toolCall.name, approved } })
    try {
      const output = await toolBroker.execute(toolCall.name, input)
      const safeOutput = toolBroker.redact(output)
      store.updateToolCall(toolCall.id, { status: 'completed', output: safeOutput })
      store.appendEvent({ runId, type: 'tool.completed', agentId: task.agentId, payload: { toolCallId: toolCall.id, name: toolCall.name, output: safeOutput, approved } })
      return { ok: true, output: safeOutput }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Worker tool failed.'
      store.updateToolCall(toolCall.id, { status: 'failed', error: message })
      store.appendEvent({ runId, type: 'tool.failed', agentId: task.agentId, payload: { toolCallId: toolCall.id, name: toolCall.name, error: message, approved } })
      return { ok: false, error: message }
    }
  }

  const invokeWorkerTool = async (runId, task, name, input) => {
    const run = store.getRun(runId)
    const tool = toolBroker?.get(name)
    const authorization = toolBroker?.authorize(run?.permissionMode, tool) ?? { allowed: false, requiresApproval: false, reason: 'Tool broker is unavailable.' }
    const safeInput = toolBroker?.redact(input) ?? input
    const toolCall = store.createToolCall({ runId, agentId: task.agentId, name, kind: tool?.kind ?? 'unknown', input: safeInput })
    store.appendEvent({ runId, type: 'tool.requested', agentId: task.agentId, payload: { toolCallId: toolCall.id, name, kind: tool?.kind ?? 'unknown', input: safeInput } })
    if (!authorization.allowed) {
      const status = authorization.requiresApproval ? 'approval_required' : 'denied'
      store.updateToolCall(toolCall.id, { status, error: authorization.reason })
      store.appendEvent({ runId, type: authorization.requiresApproval ? 'approval.requested' : 'tool.denied', agentId: task.agentId, payload: { toolCallId: toolCall.id, name, reason: authorization.reason } })
      if (authorization.requiresApproval) {
        return new Promise((resolve) => {
          approvalWaiters.set(toolCall.id, { runId, task, toolCall, input, resolve })
        })
      }
      return { ok: false, approvalRequired: authorization.requiresApproval, error: authorization.reason }
    }

    return executeApprovedTool({ runId, task, toolCall, input })
  }

  const executeTask = async (runId, task, definition, goal, route, handoff = '') => {
    if (!await waitUntilRunnable(store, runId)) return { task, result: 'Task cancelled before start.', demo: true, cancelled: true }
    store.updateTask(task.id, { status: 'running' })
    appendTaskEvent(runId, 'task.started', task)
    await wait(120)
    if (!await waitUntilRunnable(store, runId)) {
      store.updateTask(task.id, { status: 'cancelled', result: 'Task cancelled by user.' })
      appendTaskEvent(runId, 'task.cancelled', task)
      return { task, result: 'Task cancelled by user.', demo: true, cancelled: true }
    }
    appendTaskEvent(runId, 'task.progress', task, { summary: `Preparing ${definition.title.toLowerCase()}.` })
    const toolResult = definition.tool ? await invokeWorkerTool(runId, task, definition.tool.name, definition.tool.input) : null
    const toolContext = toolResult?.ok ? `Brokered workspace context from ${definition.tool.name}: ${JSON.stringify(toolResult.output).slice(0, 8_000)}` : toolResult?.error ? `Brokered tool note: ${toolResult.error}` : ''

    if (!await waitUntilRunnable(store, runId)) return { task, result: 'Task cancelled by user.', demo: true, cancelled: true }
    const provider = providerRegistry.resolve(route ?? definition.route)
    const model = providerRegistry.model(provider, route ?? definition.route)
    let result
    let demo = false

    if (!providerRegistry.secret(provider)) {
      demo = true
      result = `${demoResult(definition, goal, handoff)}${toolContext ? `\n\n${toolContext}` : ''}`
    } else {
      result = await callModel(provider, model, [{ role: 'user', content: `${workerPrompt(definition, goal, handoff)}\n\n${toolContext}` }], `You are ${definition.role}. Give concise worker summaries to a supervising Head AI.`)
    }

    if (isCancelled(store, runId)) {
      store.updateTask(task.id, { status: 'cancelled', result: 'Task cancelled by user.' })
      appendTaskEvent(runId, 'task.cancelled', task, { provider: provider.id, model })
      return { task, result: 'Task cancelled by user.', demo }
    }

    const cleanResult = typeof result === 'string' && result.trim() ? result.trim() : 'Worker returned no summary.'
    store.updateTask(task.id, { status: 'completed', result: cleanResult })
    appendTaskEvent(runId, 'task.completed', task, { summary: cleanResult, demo, provider: provider.id, model })
    return { task, result: cleanResult, demo, provider: provider.id, model }
  }

  const executeRun = async (runId, { routing = {} } = {}) => {
    const run = store.getRun(runId)
    if (!run) return
    const userMessages = store.listMessages(runId).filter((message) => message.role === 'user')
    const goal = userMessages.at(-1)?.content ?? 'Create a narrow proof-of-value for the project.'
    const tasks = workerDefinitions.map((definition) => store.createTask({
      runId,
      agentId: definition.agentId,
      title: definition.title,
      instructions: definition.instructions,
    }))

    for (const task of tasks) appendTaskEvent(runId, 'task.assigned', task, { mode: run.mode })

    const scoutTask = tasks.find((task) => task.agentId === 'research')
    const forgeTask = tasks.find((task) => task.agentId === 'builder')
    const scoutDefinition = workerDefinitions.find((definition) => definition.agentId === 'research')
    const forgeDefinition = workerDefinitions.find((definition) => definition.agentId === 'builder')
    if (!scoutTask || !forgeTask || !scoutDefinition || !forgeDefinition) return

    const scout = await executeTask(runId, scoutTask, scoutDefinition, goal, routing.research)
    if (isCancelled(store, runId)) return

    store.appendEvent({
      runId,
      type: 'worker.handoff',
      agentId: 'research',
      payload: { from: 'research', to: 'builder', summary: scout.result },
    })

    const forge = await executeTask(runId, forgeTask, forgeDefinition, goal, routing.builder, scout.result)
    if (isCancelled(store, runId)) return

    store.appendEvent({
      runId,
      type: 'head.review.started',
      agentId: 'head',
      payload: { workerCount: 2 },
    })
    const reviewProvider = providerRegistry.resolve(routing.head ?? 'Grok · grok-4')
    const reviewModel = providerRegistry.model(reviewProvider, routing.head ?? 'Grok · grok-4')
    const reviewPrompt = `Review the worker summaries for this project direction and produce a concise decision packet. Mention agreement, disagreement, the next action, and any approval needed.\n\nDirection:\n${goal}\n\nScout:\n${scout.result}\n\nForge:\n${forge.result}`
    const review = providerRegistry.secret(reviewProvider)
      ? await callModel(reviewProvider, reviewModel, [{ role: 'user', content: reviewPrompt }], 'You are Head AI reviewing worker outputs. Return a concise decision packet, not hidden reasoning.')
      : `Head demo review: Scout and Forge agree on a narrow proof-of-value. Next action: choose the first artifact and verification check, then review the worker outputs before any consequential tool call.`
    const cleanReview = typeof review === 'string' && review.trim() ? review.trim() : 'Head AI did not return a review summary.'
    if (!await waitUntilRunnable(store, runId)) return
    if (store.getRun(runId)?.status !== 'executing') return
    store.updateRun(runId, { status: 'review' })
    store.appendEvent({
      runId,
      type: 'run.review.ready',
      agentId: 'head',
      payload: { summary: cleanReview, provider: reviewProvider.id, model: reviewModel, demo: !providerRegistry.secret(reviewProvider) },
    })
  }

  const start = (runId, options = {}) => {
    if (activeRuns.has(runId)) return activeRuns.get(runId)
    const promise = executeRun(runId, options)
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Worker run failed.'
        store.updateRun(runId, { status: 'failed' })
        store.appendEvent({ runId, type: 'run.failed', agentId: 'head', payload: { error: message } })
      })
      .finally(() => activeRuns.delete(runId))
    activeRuns.set(runId, promise)
    return promise
  }

  const approveToolCall = async (toolCallId) => {
    const pending = approvalWaiters.get(toolCallId)
    if (!pending) return { handled: false }
    approvalWaiters.delete(toolCallId)
    const result = await executeApprovedTool({ ...pending, approved: true })
    pending.resolve(result)
    return { handled: true, result }
  }

  return { start, activeRuns, approveToolCall }
}