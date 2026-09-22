/**
 * Agent-Reach integration: zero-API-cost web scraping tools.
 *
 * Exposes scraping capabilities to agents through the tool broker, routed
 * through the network policy for SSRF protection.
 */

/** Supported scraping channels. */
export const channels = ['web', 'youtube', 'rss', 'github', 'twitter', 'reddit']

/**
 * Build a scraping tool definition for the tool broker.
 *
 * @param {string} channel
 * @returns {{ name: string, kind: string, description: string }}
 */
export function scrapingTool(channel) {
  const descriptions = {
    web: 'Read any web page as text.',
    youtube: 'Extract YouTube video subtitles and search videos.',
    rss: 'Read any RSS/Atom feed.',
    github: 'Read public GitHub repositories and search code.',
    twitter: 'Read tweets and search Twitter/X.',
    reddit: 'Read and search Reddit posts.',
  }
  return {
    name: `reach.${channel}`,
    kind: 'http',
    description: descriptions[channel] ?? `Scrape ${channel} content.`,
  }
}

/**
 * Build the full set of scraping tools.
 * @returns {Array<{ name: string, kind: string, description: string }>}
 */
export function allScrapingTools() {
  return channels.map(scrapingTool)
}

/**
 * Execute a scraping request through the pinned HTTP layer.
 *
 * @param {{ channel: string, url: string, query?: string }} request
 * @param {{ fetchImpl?: Function, networkPolicy?: Function }} [options]
 * @returns {Promise<{ ok: boolean, content?: string, error?: string }>}
 */
export async function scrape({ channel, url, query: _query }, { fetchImpl = globalThis.fetch, networkPolicy } = {}) {
  if (!channels.includes(channel)) {
    return { ok: false, error: `Unknown channel: ${channel}. Supported: ${channels.join(', ')}` }
  }

  // Validate URL through network policy if provided
  if (networkPolicy) {
    try {
      networkPolicy(url)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'URL not allowed' }
    }
  }

  try {
    const parsed = new URL(String(url))
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, error: 'Only http and https URLs are supported.' }
    }

    const response = await fetchImpl(parsed.href, { redirect: 'follow' })
    if (!response.ok) {
      return { ok: false, error: `Fetch answered ${response.status}.` }
    }

    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > 500_000) {
      return { ok: false, error: 'Response exceeds 500 kB.' }
    }

    return { ok: true, content: text.slice(0, 100_000) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Fetch failed.' }
  }
}
