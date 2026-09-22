/**
 * Smart model routing: classify each turn's work and route to the best model.
 *
 * Three routing tiers:
 *   hard    — must use the named model (user pin, escalation target)
 *   simple  — cheap model for reads, searches, formatting
 *   medium  — balanced model for code edits, analysis
 *
 * The router is advisory: it returns a recommendation the orchestrator can
 * accept, override, or log. It never silently switches models — every route
 * decision lands on the audit chain.
 */

/** Work classification, derived from the task's role and content. */
export const workKinds = ['read', 'write', 'analyze', 'plan', 'verify', 'chat']

/**
 * Classify a turn's work from its role and prompt.
 * @param {string} role
 * @param {string} text
 * @returns {string} one of workKinds
 */
export function classifyWork(role, text = '') {
  const lower = String(text).toLowerCase()
  if (role === 'architect' || role === 'head') return 'plan'
  if (role === 'research') return /\b(find|search|read|list|map|outline)\b/.test(lower) ? 'read' : 'analyze'
  if (role === 'editor') return 'write'
  if (role === 'debug') return 'analyze'
  if (role === 'builder') return /\b(test|verify|check|assert)\b/.test(lower) ? 'verify' : 'write'
  return 'chat'
}

/**
 * Routing table: work kind → model tier.
 * Read at use time so a settings change applies immediately.
 */
export function routingTable() {
  return {
    read: process.env.FULKRUM_ROUTE_READ ?? 'simple',
    write: process.env.FULKRUM_ROUTE_WRITE ?? 'medium',
    analyze: process.env.FULKRUM_ROUTE_ANALYZE ?? 'medium',
    plan: process.env.FULKRUM_ROUTE_PLAN ?? 'hard',
    verify: process.env.FULKRUM_ROUTE_VERIFY ?? 'simple',
    chat: process.env.FULKRUM_ROUTE_CHAT ?? 'simple',
  }
}

/**
 * Model pools per tier. A tier with no pool falls back to the primary route.
 */
export function modelPools() {
  return {
    hard: (process.env.FULKRUM_POOL_HARD ?? '').split(',').filter(Boolean),
    simple: (process.env.FULKRUM_POOL_SIMPLE ?? '').split(',').filter(Boolean),
    medium: (process.env.FULKRUM_POOL_MEDIUM ?? '').split(',').filter(Boolean),
  }
}

/**
 * Recommend a model for one turn.
 *
 * @param {{ role: string, text: string, primaryRoute: string, escalationTarget?: string | null }} input
 * @returns {{ kind: string, tier: string, model: string, reason: string }}
 */
export function routeTurn({ role, text = '', primaryRoute = '', escalationTarget = null }) {
  const kind = classifyWork(role, text)
  const table = routingTable()
  const tier = table[kind] ?? 'medium'
  const pools = modelPools()
  const pool = pools[tier] ?? []

  // An escalation target always wins: the user declared this role needs a
  // stronger model after repeated failures.
  if (escalationTarget) {
    return { kind, tier: 'hard', model: escalationTarget, reason: 'escalation target declared for this role' }
  }

  // A hard tier with no pool uses the primary route.
  if (tier === 'hard' || !pool.length) {
    return { kind, tier, model: primaryRoute, reason: pool.length ? 'hard tier: primary route' : `no ${tier} pool configured, using primary` }
  }

  // Pick from the pool deterministically (first entry) so the same work kind
  // routes consistently. Random selection would make cost tracking noisy.
  return { kind, tier, model: pool[0], reason: `${tier} pool: ${pool[0]}` }
}

/**
 * Should this turn escalate to a stronger model?
 *
 * @param {{ consecutiveFailures: number, threshold?: number }} input
 * @returns {boolean}
 */
export function shouldEscalate({ consecutiveFailures, threshold = 2 }) {
  return consecutiveFailures >= threshold
}
