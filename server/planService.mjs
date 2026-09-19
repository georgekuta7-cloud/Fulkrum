import { extractPlanJson, planContentHash, planPrompt, validatePlan } from './plans.mjs'
import { resolveReasoning } from './reasoning.mjs'

/**
 * Produce the plan a run will execute.
 *
 * There is exactly one way to get a plan: the model writes one, it validates,
 * and it is stored. Anything else — no key, no direction, an unusable reply,
 * a blown budget — is refused with a status and a reason, and the refusal is
 * recorded as a `plan.rejected` event. A run never starts on invented tasks.
 */
export class PlanDraftError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function createPlanService({ store, providerRegistry, callModel, pricing, checkBudget = async (_runId) => {} }) {
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

  const reject = (run, problems) => {
    store.appendEvent({ runId: run.id, type: 'plan.rejected', agentId: 'head', payload: { problems } })
  }

  const draftFromModel = async ({ run, direction, provider, route, reasoning = null }) => {
    const model = providerRegistry.model(provider, route)
    const instructions = 'You are Head AI. You plan work for a small agent team. Reply with JSON only, with no commentary and no code fences.'
    const messages = [{ role: 'user', content: planPrompt({ direction, workspaceRoot: 'the workspace root', maxTasks: 8 }) }]

    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Planning drafts bill the same ledger as worker calls, so they pass
      // the same ceiling first. A refusal propagates — it is answered with a
      // status, never papered over with a fallback plan.
      await checkBudget(run.id)
      const startedAt = Date.now()
      const response = await callModel(provider, model, messages, { tools: [], instructions, reasoning })
      // Planning costs money too, so it lands in the same ledger as worker calls.
      const cost = pricing ? pricing.costOf({ model, usage: response.usage }) : { costUsd: null, priced: false, version: null }
      store.recordModelCall({ runId: run.id, role: 'head', provider: provider.id, model, usage: response.usage, cost, latencyMs: Date.now() - startedAt })

      const candidate = extractPlanJson(response.text)
      const validation = validatePlan(candidate)
      if (validation.ok) return validation.plan

      const problems = validation.problems.length ? validation.problems : ['The reply did not contain a JSON object.']
      reject(run, problems)
      messages.push({ role: 'assistant', content: response.text })
      messages.push({ role: 'user', content: `That plan could not be used: ${problems.join(' ')} Reply again with JSON only, in the required shape.` })
    }

    throw new PlanDraftError(502, 'The model did not produce a usable plan after two attempts. The rejections are in the audit log.')
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

      const direction = directionFor(run.id).trim()
      if (!direction) {
        throw new PlanDraftError(400, 'Describe what you want first: a plan needs a direction to plan from.')
      }
      let provider = null
      const projectSettings = store.getProject(run.projectId)?.project?.settings
      const route = routing.head ?? projectSettings?.routing?.head ?? ''
      const reasoning = resolveReasoning(projectSettings, 'head')
      try {
        provider = providerRegistry.resolve(route)
      } catch {
        provider = null
      }

      if (!provider || !providerRegistry.isConfigured(provider)) {
        const label = provider?.label ?? 'The selected provider'
        throw new PlanDraftError(409, `No provider key is configured for ${label}. Add one in Workspace settings — providers, keys, endpoints, and models are all settable there — then draft again.`)
      }

      return { plan: persist({ run, built: await draftFromModel({ run, direction, provider, route, reasoning }), source: 'model' }), created: true }
    },
  }
}
