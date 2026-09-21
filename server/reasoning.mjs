/**
 * Reasoning-level control, model-native.
 *
 * One cross-provider vocabulary — minimal, low, medium, high — that each
 * protocol hears in its own tongue. The level is chosen per role in a project's
 * settings and travels with the call; the translation lives here, in pure
 * functions, so the mapping is testable without a network and the wire bodies
 * stay the single place that knows a provider's dialect.
 *
 * An unset level means "the provider's default", and sends nothing: a model
 * that does not reason is never handed a knob it would only reject.
 */

export const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high']

const LEVELS = new Set(REASONING_LEVELS)

/** A stored level is one of the known words, or nothing at all. */
export function normalizeReasoningLevel(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return LEVELS.has(text) ? text : null
}

/**
 * The level a role should think at. A role's own setting wins; absent one, the
 * project-wide `default` entry; absent that, nothing — the provider decides.
 */
export function resolveReasoning(settings, role) {
  const table = settings?.reasoning
  if (!table || typeof table !== 'object') return null
  return normalizeReasoningLevel(table[role]) ?? normalizeReasoningLevel(table.default)
}

/**
 * Models that understand a reasoning control. Anything else is sent nothing:
 * an unknown model gets no knob, the same rule that governs temperature.
 */
const reasoningCapable = (model) => /^(grok|gpt-5|o[1-4]|claude|gemini|deepseek-reasoner)/i.test(String(model ?? ''))

/**
 * Claude thinks in a token budget, not a word. The level names a share of a
 * generous ceiling, so "medium" is meaningfully more than "low" without the
 * caller needing to know the currency.
 */
const anthropicBudget = { minimal: 1024, low: 2048, medium: 8192, high: 16384 }

/**
 * Translate a level into the fields a protocol's request body understands.
 * Returns an object to spread into the body, or an empty object when the level
 * is unset or the model does not reason — the caller spreads it unconditionally.
 *
 * `maxOutputTokens` guards the budgeted dialects: Anthropic requires a thinking
 * budget strictly below `max_tokens`, so the budget is clamped to leave the
 * answer room, and `max_tokens` is raised above the budget so the two never
 * contradict. Without it the provider default ladder is used untouched.
 */
export function reasoningPayload(protocol, model, level, maxOutputTokens = null) {
  const normalized = normalizeReasoningLevel(level)
  if (!normalized || !reasoningCapable(model)) return {}
  const budget = anthropicBudget[normalized] ?? anthropicBudget.medium
  if (protocol === 'anthropic') {
    // Leave headroom for the answer. Without a ceiling the ladder is used
    // untouched; with one, a budget that fits leaves max_tokens alone, and a
    // budget that does not is capped to half the ceiling while the ceiling is
    // lifted past it — so the two never ask for the impossible.
    const ceiling = typeof maxOutputTokens === 'number' && maxOutputTokens > 0 ? maxOutputTokens : null
    if (ceiling === null) return { thinking: { type: 'enabled', budget_tokens: budget } }
    const headroom = Math.max(Math.floor(ceiling / 2), 1024)
    if (budget <= headroom) return { thinking: { type: 'enabled', budget_tokens: budget } }
    return { thinking: { type: 'enabled', budget_tokens: headroom }, max_tokens: Math.max(ceiling, headroom + 4096) }
  }
  if (protocol === 'google') {
    // Gemini reads a numeric budget; reuse the same ladder.
    return { thinkingConfig: { thinkingBudget: budget } }
  }
  // openai-compatible: grok and gpt-5 both take an effort word.
  return { reasoning_effort: normalized }
}
