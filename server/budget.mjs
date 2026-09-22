import { randomUUID } from 'node:crypto'

/** Thrown when a run cannot afford another model call. */
export class BudgetExceededError extends Error {
  constructor(message, { scope }) {
    super(message)
    this.scope = scope
  }
}

/**
 * Budget ceiling enforcement for model calls.
 *
 * Reservations are taken synchronously with the check, which is atomic in a
 * single-threaded runtime, so parallel callers cannot all pass the same check
 * together and overshoot the cap.
 */
export function createBudgetGuard({ store }) {
  /** @type {Map<string, { runId: string, costUsd: number }>} */
  const reservations = new Map()
  /** Runs that have had the unmeasurable-spend note logged. */
  const unmeasurableLogged = new Set()

  const startOfToday = () => {
    const now = new Date()
    if (/^utc$/i.test(process.env.FULKRUM_BUDGET_TIMEZONE ?? '')) {
      return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    }
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return midnight.getTime()
  }

  const reservedFor = (runId) => {
    let total = 0
    for (const entry of reservations.values()) {
      if (entry.runId === runId) total += entry.costUsd
    }
    return total
  }

  const reservedTotal = () => {
    let total = 0
    for (const entry of reservations.values()) total += entry.costUsd
    return total
  }

  const estimateCallCost = (runId) => {
    const largest = store.listModelCalls(runId).reduce((max, call) => Math.max(max, call.costUsd ?? 0), 0)
    return Math.max(largest, Number(process.env.FULKRUM_BUDGET_RESERVE_USD ?? 0.02))
  }

  const reserve = (runId) => {
    const id = `res-${randomUUID()}`
    reservations.set(id, { runId, costUsd: estimateCallCost(runId) })
    return id
  }

  const release = (id) => {
    reservations.delete(id)
  }

  function assertWithinBudget(runId) {
    const run = store.getRun(runId)
    const runCap = run?.budgetUsd ?? (Number(process.env.FULKRUM_RUN_BUDGET_USD ?? 0) || null)
    const dayCap = Number(process.env.FULKRUM_DAILY_BUDGET_USD ?? 0) || null

    if (runCap) {
      const { costUsd, unpricedCalls } = store.spendForRun(runId)
      const committed = costUsd + reservedFor(runId)
      if (unpricedCalls > 0 && !run?.budgetExceededAt && !unmeasurableLogged.has(runId)) {
        unmeasurableLogged.add(runId)
        store.appendEvent({ runId, type: 'run.budget.unmeasurable', agentId: 'head', payload: { unpricedCalls, reason: 'Some calls used a model with no known price, so spend is a lower bound.' } })
      }
      if (committed >= runCap) throw new BudgetExceededError(`This run reached its $${runCap.toFixed(2)} budget (spent $${costUsd.toFixed(4)}${reservedFor(runId) > 0 ? `, plus $${reservedFor(runId).toFixed(4)} in flight` : ''}).`, { scope: 'run' })
    }

    if (dayCap) {
      const { costUsd } = store.spendSince(startOfToday())
      const committed = costUsd + reservedTotal()
      if (committed >= dayCap) throw new BudgetExceededError(`Today's spend reached the $${dayCap.toFixed(2)} daily budget (spent $${costUsd.toFixed(4)}${reservedTotal() > 0 ? `, plus $${reservedTotal().toFixed(4)} in flight` : ''}).`, { scope: 'day' })
    }
  }

  const assertBudget = (runId) => {
    assertWithinBudget(runId)
  }

  const withBudget = async (runId, task) => {
    assertWithinBudget(runId)
    const reservationId = reserve(runId)
    try {
      return await task()
    } finally {
      release(reservationId)
    }
  }

  return { BudgetExceededError, assertBudget, withBudget, reserve, release, reservedFor, resetUnmeasurable: (runId) => unmeasurableLogged.delete(runId) }
}
