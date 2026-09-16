const builtInProviders = [
  { id: 'grok', label: 'Grok', protocol: 'openai-compatible', envKeys: ['XAI_API_KEY'], baseUrl: process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1', defaultModel: process.env.FULKRUM_GROK_MODEL ?? 'grok-4' },
  { id: 'openai', label: 'OpenAI', protocol: 'openai-compatible', envKeys: ['OPENAI_API_KEY'], baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', defaultModel: process.env.FULKRUM_OPENAI_MODEL ?? 'gpt-5' },
  { id: 'anthropic', label: 'Anthropic', protocol: 'anthropic', envKeys: ['ANTHROPIC_API_KEY'], baseUrl: 'https://api.anthropic.com/v1', defaultModel: process.env.FULKRUM_ANTHROPIC_MODEL ?? 'claude-opus-4-1' },
  { id: 'google', label: 'Google', protocol: 'google', envKeys: ['GOOGLE_API_KEY'], baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: process.env.FULKRUM_GOOGLE_MODEL ?? 'gemini-2.5-pro' },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai-compatible', envKeys: ['DEEPSEEK_API_KEY'], baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1', defaultModel: process.env.FULKRUM_DEEPSEEK_MODEL ?? 'deepseek-chat' },
  { id: 'glm', label: 'GLM', protocol: 'openai-compatible', envKeys: ['GLM_API_KEY', 'ZAI_API_KEY'], baseUrl: process.env.GLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4', defaultModel: process.env.FULKRUM_GLM_MODEL ?? 'glm-4.5' },
  { id: 'kimi', label: 'Kimi', protocol: 'openai-compatible', envKeys: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'], baseUrl: process.env.KIMI_BASE_URL ?? 'https://api.moonshot.ai/v1', defaultModel: process.env.FULKRUM_KIMI_MODEL ?? 'kimi-k2' },
]

function secretFor(provider) {
  return provider.envKeys.map((key) => process.env[key]).find(Boolean)
}

function publicProvider(provider) {
  return {
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    model: provider.defaultModel,
    envKey: provider.envKeys.join(' or '),
    configured: Boolean(secretFor(provider)),
    custom: Boolean(provider.custom),
  }
}

function routeParts(route) {
  if (route && typeof route === 'object') {
    return { providerId: route.providerId, model: route.model }
  }
  const value = String(route ?? '')
  const [label, model] = value.split(' · ')
  return { providerId: label, model }
}

function validateCustomProvider(input) {
  const slug = String(input.id ?? input.label ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const id = slug.startsWith('custom-') ? slug : `custom-${slug}`
  const label = String(input.label ?? '').trim()
  const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/$/, '')
  const model = String(input.model ?? '').trim()
  const envKey = String(input.envKey ?? '').trim().toUpperCase()

  if (!label || label.length > 60) throw new Error('Custom provider label must be between 1 and 60 characters.')
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Custom provider base URL must use http or https.')
  if (!model) throw new Error('Custom provider model is required.')
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(envKey)) throw new Error('Custom provider env key must be an uppercase environment variable name.')

  return { id, label, protocol: 'openai-compatible', envKeys: [envKey], baseUrl, defaultModel: model, envKey, custom: true }
}

export function createProviderRegistry(store) {
  const all = () => [...builtInProviders, ...store.listCustomProviders().map((provider) => ({ ...provider, envKeys: [provider.envKey] }))]

  return {
    list() {
      return all().map(publicProvider)
    },

    resolve(route) {
      const parts = routeParts(route)
      const requested = String(parts.providerId ?? '').trim().toLowerCase()
      if (!requested) return all()[0]
      const provider = all().find((item) => item.id === requested || item.label.toLowerCase() === requested)
      if (!provider) throw new Error(`Unknown provider route: ${parts.providerId}`)
      return provider
    },

    model(provider, route) {
      const selectedModel = routeParts(route).model
      return selectedModel || provider.defaultModel
    },

    secret(provider) {
      return secretFor(provider)
    },

    /** Fallback routes, in order, from FULKRUM_FALLBACK_ROUTES. */
    fallbackRoutes() {
      return String(process.env.FULKRUM_FALLBACK_ROUTES ?? '')
        .split(',')
        .map((route) => route.trim())
        .filter(Boolean)
    },

    /**
     * Ask the provider whether it accepts our credentials. Only status and
     * latency are returned; never the key.
     *
     * @param {any} provider
     * @param {{ allowPrivate?: boolean, validateUrl?: (url: string, options?: Record<string, unknown>) => Promise<URL> | URL, timeoutMs?: number }} [options]
     */
    async testConnection(provider, { allowPrivate = false, validateUrl, timeoutMs = 10_000 } = {}) {
      const secret = secretFor(provider)
      if (!secret) return { configured: false, reachable: false, reason: `Missing ${provider.envKeys.join(' or ')}` }

      const startedAt = Date.now()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const base = validateUrl ? await validateUrl(provider.baseUrl, { allowPrivate }) : new URL(provider.baseUrl)
        const baseUrl = base.toString().replace(/\/$/, '')
        let url
        let headers = {}
        if (provider.protocol === 'google') {
          const googleUrl = new URL(`${baseUrl}/models`)
          googleUrl.searchParams.set('key', secret)
          googleUrl.searchParams.set('pageSize', '1')
          url = googleUrl
        } else if (provider.protocol === 'anthropic') {
          url = `${baseUrl}/models?limit=1`
          headers = { 'x-api-key': secret, 'anthropic-version': '2023-06-01' }
        } else {
          url = `${baseUrl}/models`
          headers = { Authorization: `Bearer ${secret}` }
        }

        const response = await fetch(url, { method: 'GET', headers, signal: controller.signal, redirect: 'manual' })
        const responseText = await response.text()
        let error
        if (!response.ok) {
          try {
            const payload = JSON.parse(responseText)
            error = payload?.error?.message ?? payload?.message ?? `Provider returned ${response.status}`
          } catch {
            error = `Provider returned ${response.status}`
          }
        }
        return { configured: true, reachable: response.ok, status: response.status, latencyMs: Date.now() - startedAt, error }
      } catch (error) {
        return { configured: true, reachable: false, latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : 'Provider connection failed.' }
      } finally {
        clearTimeout(timeout)
      }
    },

    addCustom(input) {
      const provider = validateCustomProvider(input)
      return store.saveCustomProvider(provider)
    },

    removeCustom(id) {
      if (builtInProviders.some((provider) => provider.id === id)) throw new Error('Built-in providers cannot be removed.')
      if (!store.removeCustomProvider(id)) throw new Error('Custom provider not found.')
      return id
    },
  }
}
