import { setTimeout as wait } from 'node:timers/promises'
import { fingerprintToolCall } from './permissions.mjs'
import { demoPlan, planContentHash, planLayers, splitLayerForConcurrency } from './plans.mjs'
import { agentRoles, roleOrDefault } from './roles.mjs'
import { isToolAllowedForRole, toolsForRole, validateToolArguments } from './tools.mjs'

const terminalStatuses = new Set(['cancelled', 'completed', 'failed', 'interrupted'])
const maxStepsPerTask = Number(process.env.FULKRUM_MAX_TOOL_STEPS ?? 8)
// Read-only work overlaps; writers are serialized. Parallel writers conflict over
// the same files, parallel readers do not.
const maxParallelReaders = Math.max(Number(process.env.FULKRUM_MAX_PARALLEL_RESEARCHERS ?? 3), 1)

export function createRunOrchestrator({ store, providerRegistry, toolBroker, callModel, ownerId = 'orchestrator', leaseMs = 60_000 }) {
  const activeRuns = new Map()
  const approvalWaiters = new Map()

  /** Resolve a route, falling back rather than failing the run on a stale setting. */
  const resolveRoute = (runId, requested, roleName) => {
    try {
      return providerRegistry.resolve(requested)
    } catch (error) {
      const fallback = providerRegistry.list()[0]
      store.appendEvent({ runId, type: 'run.route.invalid', agentId: roleName, payload: { requested: requested ?? '', error: error instanceof Error ? error.message : 'Unknown route', using: fallback.label } })
      return providerRegistry.resolve(fallback.label)
    }
  }

  async function waitUntilRunnable(runId) {
    while (true) {
      const status = store.getRun(runId)?.status
      if (!status || terminalStatuses.has(status)) return false
      if (status !== 'paused') return true
      await wait(100)
    }
  }

  const callModelWithFallback = async ({ runId, role, route, messages, tools = [], instructions }) => {
    const attempts = [route ?? '', ...providerRegistry.fallbackRoutes()]
    let lastError
    for (const [index, candidate] of attempts.entries()) {
      const provider = resolveRoute(runId, candidate, role)
      if (!providerRegistry.secret(provider)) {
        lastError = new Error(`No key configured for ${provider.label}.`)
        continue
      }
      const model = providerRegistry.model(provider, candidate)
      try {
        const response = await callModel(provider, model, messages, { tools, instructions })
        if (index > 0) {
          store.appendEvent({ runId, type: 'run.provider.fallback', agentId: role, payload: { from: attempts[0] || 'primary', to: candidate, reason: lastError instanceof Error ? lastError.message : 'Primary provider failed.' } })
        }
        return { ...response, provider, model }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('No provider route could serve this request.')
  }

  const executeResolvedTool = async ({ runId, task, toolCall, input, resolution, approved = false }) => {
    store.updateToolCall(toolCall.id, { status: 'running', attempt: toolCall.attempt + 1 })
    store.appendEvent({ runId, type: 'tool.started', agentId: task.agentId, payload: { toolCallId: toolCall.id, name: toolCall.name, approved } })
    try {
      const output = await toolBroker.execute(toolCall.name, input, resolution ?? null)
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

  /**
   * Request a tool. A consequential call parks the agent on a promise that the
   * approval endpoint resolves, so approving continues the same turn instead of
   * executing a side effect nothing consumes.
   */
  const invokeTool = async (runId, task, name, input) => {
    const run = store.getRun(runId)
    const tool = toolBroker?.get(name)
    const resolution = toolBroker?.resolve(name, input) ?? { ok: false, error: 'Tool broker is unavailable.' }
    const authorization = toolBroker?.authorize({ mode: run?.permissionMode, tool, resolution }) ?? { allowed: false, requiresApproval: false, reason: 'Tool broker is unavailable.' }
    const safeInput = toolBroker?.redact(input) ?? input
    const toolCall = store.createToolCall({
      runId,
      agentId: task.agentId,
      name,
      kind: tool?.kind ?? 'unknown',
      input: safeInput,
      resolved: resolution.ok ? resolution.resolved : null,
      fingerprint: resolution.ok ? fingerprintToolCall(resolution) : null,
    })
    store.appendEvent({ runId, type: 'tool.requested', agentId: task.agentId, payload: { toolCallId: toolCall.id, name, kind: tool?.kind ?? 'unknown', input: safeInput, resolved: toolCall.resolved, rule: authorization.ruleId } })

    if (!authorization.allowed) {
      const status = authorization.requiresApproval ? 'approval_required' : 'denied'
      store.updateToolCall(toolCall.id, { status, error: authorization.reason })
      store.appendEvent({ runId, type: authorization.requiresApproval ? 'approval.requested' : 'tool.denied', agentId: task.agentId, payload: { toolCallId: toolCall.id, name, reason: authorization.reason, rule: authorization.ruleId, fingerprint: toolCall.fingerprint, resolved: toolCall.resolved } })
      if (authorization.requiresApproval) {
        return new Promise((resolve) => {
          approvalWaiters.set(toolCall.id, { runId, task, toolCall, input, resolution, resolve })
        })
      }
      return { ok: false, denied: true, error: authorization.reason }
    }

    return executeResolvedTool({ runId, task, toolCall, input, resolution })
  }

  /**
   * Run one task as a bounded tool-calling loop: the model chooses tools, sees
   * typed results, and decides what to do next until it answers or runs out of
   * steps.
   */
  const runAgentTask = async ({ runId, task, role, roleInstructions, goal, route, handoff, acceptanceCheck }) => {
    const tools = toolsForRole(role)
    const instructions = `You are ${role.name}, ${role.label} inside Fulkrum, working as one agent in a bounded supervised run.

${roleInstructions}

Rules:
- Call the tools you need; do not claim you ran something you did not.
- Files outside the workspace are not readable, and credential files are refused.
- When you are done, reply with a concise summary for Head AI: what you found, what you produced, and anything unresolved. No preamble.`

    const context = [
      `Project direction:\n${goal}`,
      acceptanceCheck ? `Acceptance check for this task: ${acceptanceCheck}` : '',
      handoff ? `Handoff from earlier work:\n${handoff}` : '',
    ].filter(Boolean).join('\n\n')

    const messages = [{ role: 'user', content: context }]
    const usedTools = []
    let steps = 0

    while (steps < maxStepsPerTask) {
      if (!await waitUntilRunnable(runId)) return { cancelled: true, steps, usedTools, text: '' }

      const response = await callModelWithFallback({ runId, role: role.agentId, route, messages, tools, instructions })
      steps += 1

      if (!response.toolCalls?.length) {
        return { text: response.text, steps, usedTools, usage: response.usage, provider: response.provider.id, model: response.model }
      }

      messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls })
      const results = []

      for (const toolCall of response.toolCalls) {
        usedTools.push(toolCall.name)
        // A typed error is information the model can act on, unlike a silent gap.
        if (!isToolAllowedForRole(role, toolCall.name)) {
          results.push({ id: toolCall.id, name: toolCall.name, content: `Error: ${toolCall.name} is not available to ${role.name}. Available tools: ${role.tools.join(', ')}.`, isError: true })
          continue
        }
        if (toolCall.invalidJson) {
          results.push({ id: toolCall.id, name: toolCall.name, content: 'Error: the tool arguments were not valid JSON. Re-issue the call with a JSON object.', isError: true })
          continue
        }
        const validation = validateToolArguments(toolCall.name, toolCall.arguments)
        if (!validation.ok) {
          results.push({ id: toolCall.id, name: toolCall.name, content: `Error: ${validation.error}`, isError: true })
          continue
        }

        const outcome = await invokeTool(runId, task, toolCall.name, toolCall.arguments)
        results.push({
          id: toolCall.id,
          name: toolCall.name,
          content: outcome.ok ? JSON.stringify(outcome.output) : `Error: ${outcome.error}`,
          isError: !outcome.ok,
        })

        if (!await waitUntilRunnable(runId)) return { cancelled: true, steps, usedTools, text: '' }
      }

      messages.push({ role: 'tool', results })
      store.updateTask(task.id, { stepCount: steps })
    }

    // Out of steps: ask for a summary with no tools, so the run still produces
    // something the supervisor can review.
    const final = await callModelWithFallback({
      runId,
      role: role.agentId,
      route,
      messages: [...messages, { role: 'user', content: 'You have reached the tool-call limit for this task. Summarize what you found and what remains, with no further tool calls.' }],
      tools: [],
      instructions,
    })
    return { text: final.text, steps, usedTools, budgetExhausted: true, usage: final.usage, provider: final.provider.id, model: final.model }
  }

  const executeTask = async ({ runId, task, planTask, goal, route, handoff, resultsByPlanTask }) => {
    if (!await waitUntilRunnable(runId)) return { task, result: 'Task cancelled before start.', cancelled: true }
    const role = roleOrDefault(planTask.role)

    store.updateTask(task.id, { status: 'running' })
    store.appendEvent({ runId, type: 'task.started', agentId: task.agentId, payload: { taskId: task.id, title: task.title, role: planTask.role, planTaskId: planTask.id } })

    const dependencyHandoff = planTask.dependsOn
      .map((index) => resultsByPlanTask.get(index))
      .filter(Boolean)
      .join('\n\n')
    const combinedHandoff = [dependencyHandoff, handoff].filter(Boolean).join('\n\n')

    // Without a provider key the loop cannot run, so the task reports plainly
    // that it is a demo rather than inventing a result.
    const provider = resolveRoute(runId, route, role.agentId)
    let outcome
    if (!providerRegistry.secret(provider)) {
      outcome = { text: '', demo: true, steps: 0, usedTools: [] }
    } else {
      outcome = await runAgentTask({ runId, task, role, roleInstructions: role.instructions, goal, route, handoff: combinedHandoff, acceptanceCheck: planTask.acceptanceCheck })
    }

    if (outcome.cancelled) {
      store.updateTask(task.id, { status: 'cancelled', result: 'Task cancelled by user.', stepCount: outcome.steps })
      store.appendEvent({ runId, type: 'task.cancelled', agentId: task.agentId, payload: { taskId: task.id, title: task.title } })
      return { task, result: 'Task cancelled by user.', cancelled: true }
    }

    const cleanResult = typeof outcome.text === 'string' && outcome.text.trim()
      ? outcome.text.trim()
      : outcome.demo
        ? `Demo mode: no provider key is configured, so ${role.name} could not run. Add a key to .env.local to let this task investigate the workspace and report findings.`
        : 'Worker returned no summary.'

    store.updateTask(task.id, { status: 'completed', result: cleanResult, stepCount: outcome.steps })
    store.appendEvent({
      runId,
      type: 'task.completed',
      agentId: task.agentId,
      payload: {
        taskId: task.id,
        title: task.title,
        summary: cleanResult,
        demo: Boolean(outcome.demo),
        steps: outcome.steps,
        tools: outcome.usedTools,
        provider: outcome.provider ?? provider.id,
        model: outcome.model ?? providerRegistry.model(provider, route),
        budgetExhausted: Boolean(outcome.budgetExhausted),
      },
    })

    return { task, result: cleanResult, demo: Boolean(outcome.demo), handoff: cleanResult }
  }

  /**
   * Load the plan a run executes. A run without an approved plan gets the demo
   * plan, persisted like any other so the audit trail shows what actually ran.
   */
  const ensurePlan = (runId, run) => {
    const existing = run.planId ? store.getPlan(run.planId) : null
    if (existing) return existing

    const direction = store.listMessages(runId).filter((message) => message.role === 'user').at(-1)?.content ?? ''
    const built = demoPlan(direction)
    const plan = store.createPlan({ projectId: run.projectId, runId, objective: built.objective, tasks: built.tasks, contentHash: planContentHash(built), source: 'demo' })
    store.updateRun(runId, { planId: plan.plan.id, planVersion: plan.plan.version })
    store.appendEvent({ runId, type: 'run.plan.attached', agentId: 'head', payload: { planId: plan.plan.id, version: plan.plan.version, source: 'demo', objective: plan.plan.objective } })
    return plan
  }

  const executeRun = async (runId, { routing = {} } = {}) => {
    const run = store.getRun(runId)
    if (!run || terminalStatuses.has(run.status)) return

    store.acquireRunLease(runId, ownerId, leaseMs)
    const heartbeat = setInterval(() => {
      try {
        if (!store.heartbeatRun(runId, ownerId, leaseMs)) clearInterval(heartbeat)
      } catch {
        clearInterval(heartbeat)
      }
    }, Math.max(Math.floor(leaseMs / 3), 1_000))

    try {
      const plan = ensurePlan(runId, run)
      const goal = store.listMessages(runId).filter((message) => message.role === 'user').at(-1)?.content ?? plan.plan.objective
      const runTasks = store.materializeRunTasks({ runId, plan })
      const existing = store.listTasks(runId)
      const resumed = existing.some((task) => ['completed', 'interrupted'].includes(task.status))

      store.appendEvent({ runId, type: 'run.plan.loaded', agentId: 'head', payload: { planId: plan.plan.id, version: plan.plan.version, source: plan.plan.source, tasks: plan.tasks.length, resumed } })

      const taskByPlanTaskId = new Map(runTasks.map((task) => [task.planTaskId, task]))
      const resultsByPlanTask = new Map()
      const resultsByTaskId = new Map()

      // A resumed run keeps whatever already finished.
      for (const task of runTasks) {
        if (task.status === 'completed' && task.result) {
          const planTask = plan.tasks.find((candidate) => candidate.id === task.planTaskId)
          resultsByPlanTask.set(planTask?.orderIndex ?? -1, task.result)
          resultsByTaskId.set(task.id, task.result)
        }
      }

      const layers = planLayers(plan.tasks)
      for (const layer of layers) {
        if (!await waitUntilRunnable(runId)) return
        const { readers, writers } = splitLayerForConcurrency(layer, agentRoles)

        const runOne = async (planTask) => {
          const task = taskByPlanTaskId.get(planTask.id)
          if (!task) return null

          for (const dependency of planTask.dependsOn) {
            const from = plan.tasks[dependency]
            const fromTask = from ? taskByPlanTaskId.get(from.id) : null
            if (!from || !fromTask) continue
            store.appendEvent({ runId, type: 'worker.handoff', agentId: from.role, payload: { from: from.role, to: planTask.role, summary: String(resultsByPlanTask.get(dependency) ?? ''), planTaskId: planTask.id, fromCache: fromTask.status === 'completed' } })
          }

          const route = routing[planTask.role]
          if (task.status === 'completed') {
            store.appendEvent({ runId, type: 'task.skipped', agentId: task.agentId, payload: { taskId: task.id, title: task.title, reason: 'Already completed before the run was interrupted.' } })
            return { task, result: task.result, skipped: true }
          }

          const result = await executeTask({ runId, task, planTask, goal, route, resultsByPlanTask })
          if (result?.result) {
            resultsByPlanTask.set(planTask.orderIndex, result.result)
            resultsByTaskId.set(task.id, result.result)
          }
          return result
        }

        // Parallel readers, then serialized writers.
        const readerBatches = []
        for (let index = 0; index < readers.length; index += maxParallelReaders) {
          readerBatches.push(readers.slice(index, index + maxParallelReaders))
        }
        for (const batch of readerBatches) {
          if (!await waitUntilRunnable(runId)) return
          await Promise.all(batch.map((planTask) => runOne(planTask)))
        }
        for (const planTask of writers) {
          if (!await waitUntilRunnable(runId)) return
          await runOne(planTask)
        }

        if (store.getRun(runId)?.status === 'cancelled') return
      }

      const summaries = plan.tasks
        .map((planTask, index) => ({ planTask, result: resultsByPlanTask.get(index) ?? '(no summary)' }))

      store.appendEvent({ runId, type: 'head.review.started', agentId: 'head', payload: { workerCount: plan.tasks.length, planId: plan.plan.id } })
      const reviewRoute = routing.head ?? 'Grok · grok-4'
      const reviewProvider = resolveRoute(runId, reviewRoute, 'head')
      const reviewModel = providerRegistry.model(reviewProvider, reviewRoute)
      const reviewPrompt = `Review the worker summaries for this plan and produce a concise decision packet. State agreement, disagreement, the next action, and any approval still needed.

Objective:
${plan.plan.objective}

${summaries.map(({ planTask, result }) => `${planTask.role} · ${planTask.title}:\n${result}`).join('\n\n')}`

      let review
      if (providerRegistry.secret(reviewProvider)) {
        const response = await callModelWithFallback({ runId, role: 'head', route: reviewRoute, messages: [{ role: 'user', content: reviewPrompt }], tools: [], instructions: 'You are Head AI reviewing worker outputs. Return a concise decision packet, not hidden reasoning.' })
        review = response.text
      } else {
        review = 'Head demo review: the workers ran in demo mode, so there is nothing substantive to review yet. Add a provider key to .env.local and re-run this plan to get real findings.'
      }
      const cleanReview = typeof review === 'string' && review.trim() ? review.trim() : 'Head AI did not return a review summary.'

      if (!await waitUntilRunnable(runId)) return
      if (store.getRun(runId)?.status !== 'executing') return
      store.updateRun(runId, { status: 'review' })
      store.appendEvent({
        runId,
        type: 'run.review.ready',
        agentId: 'head',
        payload: { summary: cleanReview, provider: reviewProvider.id, model: reviewModel, demo: !providerRegistry.secret(reviewProvider), planId: plan.plan.id },
      })
    } finally {
      clearInterval(heartbeat)
      try {
        store.releaseRunLease(runId, ownerId)
      } catch {
        // The store was closed underneath us, which happens during shutdown.
      }
    }
  }

  const start = (runId, options = {}) => {
    if (activeRuns.has(runId)) return activeRuns.get(runId)
    const promise = executeRun(runId, options)
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Worker run failed.'
        try {
          store.updateRun(runId, { status: 'failed' })
          store.appendEvent({ runId, type: 'run.failed', agentId: 'head', payload: { error: message } })
        } catch {
          console.error(`[fulkrum] run ${runId} failed and could not be recorded: ${message}`)
        }
      })
      .finally(() => activeRuns.delete(runId))
    activeRuns.set(runId, promise)
    return promise
  }

  const approveToolCall = async (toolCallId) => {
    const pending = approvalWaiters.get(toolCallId)
    if (!pending) return { handled: false }
    approvalWaiters.delete(toolCallId)
    const result = await executeResolvedTool({ ...pending, approved: true })
    pending.resolve(result)
    return { handled: true, result }
  }

  const denyToolCall = (toolCallId, reason) => {
    const pending = approvalWaiters.get(toolCallId)
    if (!pending) return { handled: false }
    approvalWaiters.delete(toolCallId)
    pending.resolve({ ok: false, denied: true, error: reason })
    return { handled: true }
  }

  return { start, activeRuns, approvalWaiters, approveToolCall, denyToolCall, maxStepsPerTask }
}
