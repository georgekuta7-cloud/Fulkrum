import { verifySkillPins } from './marketplace.mjs'
import { planContentHash, validatePlan } from './plans.mjs'

/**
 * Playbook instantiation, shared by the HTTP endpoint and the scheduler.
 *
 * A run inherits the playbook's approval because it IS the approved bytes:
 * the hash is recomputed from the stored template and must match, or the
 * template drifted and the run refuses instead of riding a stale yes. The
 * approval event carries source 'playbook' plus the playbook id, so the chain
 * shows where the authority came from.
 */

export class PlaybookError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function instantiatePlaybookRun({ store, orchestrator, projectId, playbookId, permissionMode = 'selective', routing = {}, budgetUsd = undefined, goalId = null, workspaceRoot = null }) {
  const playbook = store.getPlaybook(playbookId)
  if (!playbook || playbook.projectId !== projectId) {
    throw new PlaybookError(404, 'Playbook not found in this project.')
  }
  const validation = validatePlan(playbook.plan)
  if (!validation.ok || planContentHash(validation.plan) !== playbook.contentHash) {
    throw new PlaybookError(409, 'The playbook no longer matches its approved hash. Save it again from a current approval.')
  }
  if (goalId !== null && goalId !== undefined) {
    const goal = store.getGoal(String(goalId))
    if (!goal || goal.projectId !== projectId) {
      throw new PlaybookError(404, 'Goal not found in this project.')
    }
    if (goal.budgetUsd !== null && store.goalSpend(goal.id) >= goal.budgetUsd) {
      throw new PlaybookError(402, `Goal "${goal.name}" reached its $${goal.budgetUsd.toFixed(2)} budget.`)
    }
  }
  // Pinned skills are knowledge with a hash: a pack edited since approval
  // refuses the run exactly like a drifted plan does.
  const drifted = verifySkillPins({ workspaceRoot: workspaceRoot ?? process.cwd(), pins: playbook.skills ?? [] })
  if (drifted.length) {
    throw new PlaybookError(409, `Pinned skills changed since approval: ${drifted.join(', ')}. Save the playbook again.`)
  }
  const run = store.createRun({ projectId, permissionMode, goalId })
  const created = store.createPlan({ projectId, runId: run.id, objective: validation.plan.objective, tasks: validation.plan.tasks, contentHash: playbook.contentHash, source: 'playbook' })
  const ceiling = budgetUsd !== undefined ? budgetUsd : playbook.budgetUsd
  store.transaction(() => {
    store.approvePlan(created.plan.id)
    store.updateRun(run.id, { planId: created.plan.id, planVersion: created.plan.version, status: 'executing', ...(ceiling !== null && ceiling !== undefined ? { budgetUsd: ceiling } : {}) })
    store.appendEvent({ runId: run.id, type: 'plan.approved', agentId: 'head', payload: { planId: created.plan.id, version: created.plan.version, hash: created.plan.contentHash, tasks: created.tasks.length, source: 'playbook', playbookId: playbook.id } })
  })
  orchestrator.start(run.id, { routing })
  return { run: store.getRun(run.id), plan: store.getPlan(created.plan.id) }
}
