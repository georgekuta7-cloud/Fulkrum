import { demoPlan, extractPlanJson, planContentHash, planPrompt, validatePlan } from './plans.mjs'

/**
 * Produce the plan a run will execute.
 *
 * A model-written plan is preferred, but a plan is required for a run to start,
 * so a failed or unparseable generation falls back to the deterministic plan and
 * says so in the audit log rather than leaving the run stuck or inventing tasks
 * the model never proposed.
 */
export function createPlanService({ store, providerRegistry, callModel, pricing }) {
  const directionFor = (runId) => store.listMessages(runId).filter((message) => message.role === 'user').at(-1)?.content ?? ''

  const persist = ({ run, built, source }) => {
    const plan = store.createPlan({
      projectId: run.projectId,
      runId: run.id,
      objective: built.objective,
      tasks: built.tasks,
      contentHash: planContentHash(built),
      source,
    })
    store.updateRun(run.id, { planId: plan.plan.id, planVersion: plan.plan.version })
    store.appendEvent({
      runId: run.id,
      type: 'plan.drafted',
      agentId: 'head',
      payload: { planId: plan.plan.id, version: plan.plan.version, source, objective: plan.plan.objective, tasks: plan.tasks.map((task) => ({ role: task.role, title: task.title })) },
    })
    return plan
  }

  const draftFromModel = async ({ run, direction, provider, route }) => {
    const model = providerRegistry.model(provider, route)
    const instructions = 'You are Head AI. You plan work for a small agent team. Reply with JSON only, with no commentary and no code fences.'
    const messages = [{ role: 'user', content: planPrompt({ direction, workspaceRoot: 'the workspace root', maxTasks: 8 }) }]

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const startedAt = Date.now()
      const response = await callModel(provider, model, messages, { tools: [], instructions })
      // Planning costs money too, so it lands in the same ledger as worker calls.
      const cost = pricing ? pricing.costOf({ model, usage: response.usage }) : { costUsd: null, priced: false, version: null }
      store.recordModelCall({ runId: run.id, role: 'head', provider: provider.id, model, usage: response.usage, cost, latencyMs: Date.now() - startedAt })

      const candidate = extractPlanJson(response.text)
      const validation = validatePlan(candidate)
      if (validation.ok) return { built: validation.plan, problems: [] }

      const problems = validation.problems.length ? validation.problems : ['The reply did not contain a JSON object.']
      store.appendEvent({ runId: run.id, type: 'plan.rejected', agentId: 'head', payload: { attempt: attempt + 1, problems } })
      messages.push({ role: 'assistant', content: response.text })
      messages.push({ role: 'user', content: `That plan could not be used: ${problems.join(' ')} Reply again with JSON only, in the required shape.` })
    }

    return { built: null, problems: ['The model did not produce a usable plan.'] }
  }

  return {
    /** The newest plan for a run, drafting one if none exists. */
    /**
     * @param {any} run
     * @param {{ regenerate?: boolean, routing?: Record<string, string> }} [options]
     */
    async ensureDraft(run, { regenerate = false, routing = {} } = {}) {
      const existing = store.getLatestPlanForRun(run.id)
      if (existing && !regenerate) return { plan: existing, created: false }

      const direction = directionFor(run.id)
      let provider = null
      let route = routing.head ?? store.getProject(run.projectId)?.project?.settings?.routing?.head ?? ''
      try {
        provider = providerRegistry.resolve(route)
      } catch {
        provider = null
      }

      if (!provider || !providerRegistry.isConfigured(provider)) {
        return { plan: persist({ run, built: demoPlan(direction), source: 'demo' }), created: true, demo: true }
      }

      try {
        const { built, problems } = await draftFromModel({ run, direction, provider, route })
        if (built) return { plan: persist({ run, built, source: 'model' }), created: true }
        return { plan: persist({ run, built: demoPlan(direction), source: 'demo-fallback' }), created: true, fallbackReason: problems.join(' ') }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Plan generation failed.'
        store.appendEvent({ runId: run.id, type: 'plan.rejected', agentId: 'head', payload: { problems: [reason] } })
        return { plan: persist({ run, built: demoPlan(direction), source: 'demo-fallback' }), created: true, fallbackReason: reason }
      }
    },
  }
}
