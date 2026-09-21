import { readFileSync } from 'node:fs'
import path from 'node:path'
import { extractPlanJson, planContentHash, planPrompt, scoreComplexity, validatePlan } from './plans.mjs'
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

export function createPlanService({ store, providerRegistry, callModel, pricing, workspaceRoot = null, checkBudget = async (_runId) => {} }) {
  const directionFor = (runId) => store.listMessages(runId).filter((message) => message.role === 'user').at(-1)?.content ?? ''

  /**
   * Project context for the planner: AGENTS.md when the workspace has one,
   * plus recent learnings. Bounded and marked. Synchronous and silent when
   * absent — missing context is normal, and planning must never depend on it.
   */
  const readProjectContext = (projectId) => {
    const parts = []
    const sources = []
    if (workspaceRoot) {
      let content = null
      try {
        content = readFileSync(path.join(workspaceRoot, 'AGENTS.md'), 'utf8')
      } catch {
        content = null
      }
      if (content && content.trim()) {
        const clipped = content.length > 4096
        parts.push(clipped ? `${content.slice(0, 4096)}\n[truncated: AGENTS.md exceeds 4 kB]` : content)
        sources.push('AGENTS.md')
      }
    }
    if (projectId) {
      const learnings = store.listProjectLearnings(projectId, 5)
      if (learnings.length) {
        let text = `Project learnings (from past runs):\n${learnings.map((learning) => `- ${learning.fact}`).join('\n')}`
        if (text.length > 1500) text = `${text.slice(0, 1500)}\n[truncated: showing recent learnings]`
        parts.push(text)
        sources.push(`${learnings.length} learnings`)
      }
    }
    return { text: parts.join('\n\n'), sources }
  }

  const persist = ({ run, built, source, direction, contextSources = [] }) => {
    const plan = store.createPlan({
      projectId: run.projectId,
      runId: run.id,
      objective: built.objective,
      tasks: built.tasks,
      contentHash: planContentHash(built),
      source,
    })
    store.updateRun(run.id, { planId: plan.plan.id, planVersion: plan.plan.version })
    // The complexity score is advisory display, not a gate: it travels with
    // the draft event and the draft response so the approval surface can show
    // it, and it is recomputed from the same inputs anywhere else it appears.
    const complexity = scoreComplexity({ direction, plan: built })
    store.appendEvent({
      runId: run.id,
      type: 'plan.drafted',
      agentId: 'head',
      payload: { planId: plan.plan.id, version: plan.plan.version, source, objective: plan.plan.objective, tasks: plan.tasks.map((task) => ({ role: task.role, title: task.title })), complexity, contextSources },
    })
    return { plan, complexity, contextSources }
  }

  const reject = (run, problems) => {
    store.appendEvent({ runId: run.id, type: 'plan.rejected', agentId: 'head', payload: { problems } })
  }

  const draftFromModel = async ({ run, direction, provider, route, reasoning = null, projectContext = { text: '', sources: [] } }) => {
    const model = providerRegistry.model(provider, route)
    const instructions = 'You are Head AI. You plan work for a small agent team. Reply with JSON only, with no commentary and no code fences.'
    const messages = [{ role: 'user', content: planPrompt({ direction, workspaceRoot: 'the workspace root', maxTasks: 8, projectContext: projectContext.text }) }]

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
      const direction = directionFor(run.id).trim()
      const existing = store.getLatestPlanForRun(run.id)
      if (existing && !regenerate) {
        // A reused draft is scored with the direction as it stands: advisory
        // display recomputed from the same inputs, never a stored verdict.
        return { plan: existing, created: false, complexity: scoreComplexity({ direction, plan: { objective: existing.plan.objective, tasks: existing.tasks } }) }
      }
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

      const projectContext = readProjectContext(run.projectId)
      const drafted = persist({ run, built: await draftFromModel({ run, direction, provider, route, reasoning, projectContext }), source: 'model', direction, contextSources: projectContext.sources })
      return { plan: drafted.plan, created: true, complexity: drafted.complexity, contextSources: drafted.contextSources }
    },
  }
}
