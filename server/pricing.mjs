import { readFileSync } from 'node:fs'

/**
 * Model prices, in USD per million tokens.
 *
 * These are approximate published list prices, not a live feed: providers change
 * them, and negotiated or cached rates differ. Treat this table as a starting
 * point you should correct for the models you actually use, either by editing
 * `prices.json` (see FULKRUM_PRICE_FILE) or by accepting that costs are marked
 * approximate.
 *
 * A model that is not in the table is reported as *unpriced* rather than costing
 * zero. Silent zeros are how a budget feature loses trust: an unknown model would
 * look free and the cap would never fire.
 */
export const PRICING_VERSION = 'builtin-2026-09'

const CACHE_READ_FACTOR = 0.1
const CACHE_WRITE_FACTOR = 1.25

function entry(input, output, overrides = {}) {
  return { input, output, cacheRead: input * CACHE_READ_FACTOR, cacheWrite: input * CACHE_WRITE_FACTOR, ...overrides }
}

const builtinPrices = {
  'grok-4': entry(3, 15),
  'gpt-5': entry(1.25, 10),
  'claude-opus-4-1': entry(15, 75),
  'claude-sonnet-4': entry(3, 15),
  'claude-haiku-4': entry(1, 5),
  'gemini-2.5-pro': entry(1.25, 10),
  'gemini-2.5-flash': entry(0.3, 2.5),
  'deepseek-chat': entry(0.27, 1.1),
  'deepseek-reasoner': entry(0.55, 2.19),
  'glm-4.5': entry(0.6, 2.2),
  'kimi-k2': entry(0.6, 2.5),
}

function readOverrides(filePath) {
  if (!filePath) return {}
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // A missing or malformed override file must not stop a run.
    return {}
  }
}

/** Longest known key that the model name starts with, so dated variants match. */
function findPrice(table, model) {
  const name = String(model ?? '').toLowerCase()
  if (!name) return null
  if (table[name]) return table[name]
  const candidates = Object.keys(table).filter((key) => name.startsWith(key)).sort((a, b) => b.length - a.length)
  return candidates.length ? table[candidates[0]] : null
}

/**
 * @param {{ filePath?: string, table?: Record<string, { input: number, output: number, cacheRead: number, cacheWrite: number }> }} [options]
 */
export function createPricing({ filePath = process.env.FULKRUM_PRICE_FILE, table = builtinPrices } = {}) {
  const overrides = readOverrides(filePath)
  const merged = { ...table, ...overrides }
  const version = Object.keys(overrides).length ? `${PRICING_VERSION}+overrides` : PRICING_VERSION

  return {
    version,
    known: Object.keys(merged).length,

    priceFor(model) {
      return findPrice(merged, model)
    },

    /**
     * Cost of one call. Returns priced:false when the model has no price, so the
     * caller can say "unknown" instead of "$0.00".
     */
    costOf({ model, usage }) {
      const price = findPrice(merged, model)
      if (!price || !usage) return { costUsd: null, priced: false, version }
      const perToken = (value) => (Number(value) || 0) / 1_000_000
      // Reasoning tokens are billed as output by every provider that reports
      // them (Google thoughts, OpenAI reasoning). Omitting them undercounts
      // cost and lets a budget cap fire too late.
      const costUsd =
        perToken(usage.billableInputTokens ?? usage.inputTokens) * price.input +
        perToken(usage.outputTokens) * price.output +
        perToken(usage.reasoningTokens) * price.output +
        perToken(usage.cacheReadTokens) * price.cacheRead +
        perToken(usage.cacheWriteTokens) * price.cacheWrite
      return { costUsd: Number(costUsd.toFixed(6)), priced: true, version }
    },
  }
}
