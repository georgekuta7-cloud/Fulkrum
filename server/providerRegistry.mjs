import { providerAuthHeaders } from './modelCall.mjs'
import { pinnedRequest } from './outboundHttp.mjs'
import { isSensitiveKeyName } from './redaction.mjs'

/**
 * What a credential-shaped header value looks like once it has left the
 * server: present, but unreadable. The editor round-trips it back verbatim,
 * and the registry resolves it against the stored value — so masking never
 * wipes a key, and a masked value with nothing stored is refused outright.
 */
export const MASKED_HEADER_VALUE = '••••••••'

// Built fresh on every read, not cached at import: endpoints and default models
// saved through the app must apply without restarting the bridge.
const builtInProviders = () => [
  { id: 'grok', label: 'Grok', protocol: 'openai-compatible', envKeys: ['XAI_API_KEY'], baseUrl: process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1', defaultModel: process.env.FULKRUM_GROK_MODEL ?? 'grok-4' },
  { id: 'openai', label: 'OpenAI', protocol: 'openai-compatible', envKeys: ['OPENAI_API_KEY'], baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', defaultModel: process.env.FULKRUM_OPENAI_MODEL ?? 'gpt-5' },
  { id: 'anthropic', label: 'Anthropic', protocol: 'anthropic', envKeys: ['ANTHROPIC_API_KEY'], baseUrl: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1', defaultModel: process.env.FULKRUM_ANTHROPIC_MODEL ?? 'claude-opus-4-1' },
  { id: 'google', label: 'Google', protocol: 'google', envKeys: ['GOOGLE_API_KEY'], baseUrl: process.env.GOOGLE_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta', defaultModel: process.env.FULKRUM_GOOGLE_MODEL ?? 'gemini-2.5-pro' },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai-compatible', envKeys: ['DEEPSEEK_API_KEY'], baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1', defaultModel: process.env.FULKRUM_DEEPSEEK_MODEL ?? 'deepseek-chat' },
  { id: 'glm', label: 'GLM', protocol: 'openai-compatible', envKeys: ['GLM_API_KEY', 'ZAI_API_KEY'], baseUrl: process.env.GLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4', defaultModel: process.env.FULKRUM_GLM_MODEL ?? 'glm-4.5' },
  { id: 'kimi', label: 'Kimi', protocol: 'openai-compatible', envKeys: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'], baseUrl: process.env.KIMI_BASE_URL ?? 'https://api.moonshot.ai/v1', defaultModel: process.env.FULKRUM_KIMI_MODEL ?? 'kimi-k2' },
]

export const AUTH_STYLES = ['auto', 'bearer', 'x-api-key', 'api-key', 'header', 'none']

/**
 * Models that fix their own sampling settings. Sending a temperature to one of
 * these is a 400 on every call, which is how the default OpenAI model failed out
 * of the box. This list only avoids the first rejected call; anything else is
 * learned from the provider's own answer and remembered.
 */
const fixedSamplingPattern = /^(gpt-5|o[1-4](?:-|$)|deepseek-reasoner)/i

/** The key for a provider: one entered in the UI wins, then an environment variable. */
function credentialFor(provider, settings) {
  const stored = settings?.apiKey ? String(settings.apiKey) : ''
  if (stored) return { key: stored, keySource: 'stored' }
  const envName = (provider.envKeys ?? []).find((name) => name && process.env[name])
  return { key: envName ? String(process.env[envName]) : null, keySource: envName ? 'env' : null }
}

function credentialsFor(provider, settings) {
  const { key, keySource } = credentialFor(provider, settings)
  return {
    key,
    keySource,
    style: settings?.authStyle ?? 'auto',
    headerName: settings?.authHeader ?? null,
    // Extra headers are configuration, not credentials, and are stored as given.
    headers: settings?.headers && typeof settings.headers === 'object' ? settings.headers : {},
    allowPrivate: Boolean(settings?.allowPrivate),
    temperature: settings?.temperature ?? 'auto',
  }
}

function isConfiguredProvider(provider, settings) {
  const credentials = credentialsFor(provider, settings)
  // "No auth" is a real configuration: a server on your own machine may simply
  // not take a key, and treating that as unconfigured would refuse calls that
  // need no key at all.
  return Boolean(credentials.key) || credentials.style === 'none'
}

function publicProvider(provider, settings) {
  const credentials = credentialsFor(provider, settings)
  return {
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    model: provider.defaultModel,
    envKey: (provider.envKeys ?? []).join(' or '),
    configured: isConfiguredProvider(provider, settings),
    custom: Boolean(provider.custom),
    // The key itself is never returned; only where it came from.
    hasKey: Boolean(credentials.key),
    keySource: credentials.keySource,
    authStyle: credentials.style,
    authHeader: credentials.headerName,
    // Names travel; credential-shaped values do not. The editor shows the mask
    // and sends it back unchanged, which updateSettings resolves below.
    headers: Object.fromEntries(Object.entries(credentials.headers).map(([name, value]) => [
      name,
      isSensitiveKeyName(name) ? MASKED_HEADER_VALUE : value,
    ])),
    allowPrivate: credentials.allowPrivate,
    temperature: credentials.temperature,
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

/** Settings an API request may change, validated field by field. */
export function parseProviderSettings(input = {}) {
  const patch = {}
  if (input.apiKey !== undefined) patch.apiKey = input.apiKey === null || input.apiKey === '' ? null : String(input.apiKey).slice(0, 500)
  if (input.authStyle !== undefined) {
    const style = String(input.authStyle).toLowerCase()
    if (!AUTH_STYLES.includes(style)) throw new Error(`Auth style must be one of: ${AUTH_STYLES.join(', ')}.`)
    patch.authStyle = style
  }
  if (input.authHeader !== undefined) patch.authHeader = input.authHeader ? String(input.authHeader).trim().slice(0, 100) : null
  if (input.headers !== undefined) {
    if (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers)) throw new Error('Extra headers must be an object of name and value pairs.')
    const entries = Object.entries(input.headers).slice(0, 20)
    for (const [name, value] of entries) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`"${name}" is not a valid header name.`)
      if (typeof value !== 'string' || value.length > 1000) throw new Error(`Header "${name}" must be a string under 1000 characters.`)
    }
    patch.headers = Object.fromEntries(entries)
  }
  if (input.allowPrivate !== undefined) patch.allowPrivate = Boolean(input.allowPrivate)
  if (input.temperature !== undefined) {
    const value = String(input.temperature).trim().toLowerCase()
    if (value === 'auto' || value === 'omit') {
      patch.temperature = value
    } else {
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > 2) throw new Error('Temperature must be "auto", "omit", or a number between 0 and 2.')
      patch.temperature = String(numeric)
    }
  }
  return patch
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
  // A key can be entered in the UI instead, so the environment variable is optional.
  if (envKey && !/^[A-Z][A-Z0-9_]{2,63}$/.test(envKey)) throw new Error('Environment key must be an uppercase environment variable name.')

  return { id, label, protocol: 'openai-compatible', envKeys: envKey ? [envKey] : [], baseUrl, defaultModel: model, envKey, custom: true }
}

/** Model ids out of a `/models` answer, for whatever shape the endpoint returns. */
function extractModelIds(text) {
  try {
    const payload = JSON.parse(text)
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
    return rows
      .map((row) => String(row?.id ?? row?.name ?? '').replace(/^models\//, ''))
      .filter(Boolean)
      .slice(0, 50)
  } catch {
    return []
  }
}

export function createProviderRegistry(store) {
  const settingsFor = (providerId) => store.getProviderSettings(providerId)
  const all = () => [...builtInProviders(), ...store.listCustomProviders().map((provider) => ({ ...provider, envKeys: provider.envKey ? [provider.envKey] : [] }))]

  return {
    list() {
      return all().map((provider) => publicProvider(provider, settingsFor(provider.id)))
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

    credentials(provider) {
      return credentialsFor(provider, settingsFor(provider.id))
    },

    /** Whether this provider can be called at all, with or without a key. */
    isConfigured(provider) {
      return isConfiguredProvider(provider, settingsFor(provider.id))
    },

    /** Providers that can be called right now, in declaration order. */
    configuredProviders() {
      return all().filter((provider) => isConfiguredProvider(provider, settingsFor(provider.id)))
    },

    /**
     * The sampling parameters for one model. `auto` keeps each protocol's own
     * default, except where the model is known to reject a temperature; a number
     * is used as given; `omit` sends nothing.
     */
    sampling(provider, model) {
      const policy = credentialsFor(provider, settingsFor(provider.id)).temperature
      if (policy === 'omit') return { temperature: undefined, reason: 'this provider is set to omit sampling parameters' }
      const explicit = Number(policy)
      if (policy !== 'auto' && Number.isFinite(explicit)) return { temperature: explicit, reason: 'set for this provider' }
      if (fixedSamplingPattern.test(String(model ?? ''))) return { temperature: undefined, reason: 'this model rejects a custom temperature' }
      if (provider.protocol === 'anthropic') return { temperature: undefined, reason: 'the provider default is used' }
      return { temperature: 0.3, reason: 'the default' }
    },

    /** Record that a provider rejected a temperature, so no later call repeats it. */
    rememberTemperature(provider, temperature) {
      if (settingsFor(provider.id)?.temperature === temperature) return
      store.saveProviderSettings(provider.id, { temperature })
      console.log(`[fulkrum] ${provider.label} rejected a temperature value; calls to it will omit sampling parameters from now on.`)
    },

    /** Fallback routes, in order, from FULKRUM_FALLBACK_ROUTES. */
    fallbackRoutes() {
      return String(process.env.FULKRUM_FALLBACK_ROUTES ?? '')
        .split(',')
        .map((route) => route.trim())
        .filter(Boolean)
    },

    /**
     * Ask the provider whether it accepts our credentials. Only status, latency,
     * and the model list are returned; never the key. The request is pinned to a
     * validated address, so this cannot be pointed somewhere else by a name that
     * resolves differently the second time.
     *
     * @param {any} provider
     * @param {{ allowPrivate?: boolean, timeoutMs?: number }} [options]
     */
    async testConnection(provider, { allowPrivate = false, timeoutMs = 10_000 } = {}) {
      const credentials = credentialsFor(provider, settingsFor(provider.id))
      if (!credentials.key && credentials.style !== 'none') {
        return { configured: false, reachable: false, error: `No key yet: enter one for ${provider.label}${provider.envKeys?.length ? ` or set ${provider.envKeys.join(' or ')}` : ''}.` }
      }

      const startedAt = Date.now()
      try {
        const headers = providerAuthHeaders(provider.protocol, credentials)
        let url = `${String(provider.baseUrl).replace(/\/$/, '')}/models`

        if (provider.protocol === 'google' && credentials.style === 'auto') {
          const googleUrl = new URL(url)
          if (credentials.key) googleUrl.searchParams.set('key', credentials.key)
          googleUrl.searchParams.set('pageSize', '20')
          url = googleUrl.toString()
        } else if (provider.protocol === 'anthropic') {
          url = `${url}?limit=20`
        }

        const response = await pinnedRequest(url, {
          method: 'GET',
          headers,
          allowPrivate: credentials.allowPrivate || allowPrivate,
          timeoutMs,
          maxBytes: 200_000,
        })
        const latencyMs = Date.now() - startedAt
        if (!response.ok) {
          let detail = `Provider returned ${response.status}`
          try {
            const payload = JSON.parse(response.text)
            detail = String(payload?.error?.message ?? payload?.message ?? payload?.error ?? detail)
          } catch {
            // A non-JSON error body keeps the status line.
          }
          return { configured: true, reachable: false, status: response.status, latencyMs, models: [], error: detail.slice(0, 300) }
        }
        return { configured: true, reachable: true, status: response.status, latencyMs, models: extractModelIds(response.text) }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Provider connection failed.'
        const blocked = /private and local network/i.test(message)
        return {
          configured: true,
          reachable: false,
          latencyMs: Date.now() - startedAt,
          models: [],
          blocked,
          error: blocked ? `This endpoint is on a private or loopback address. Turn on local-network access for ${provider.label} to allow it.` : message,
        }
      }
    },

    addCustom(input) {
      const provider = validateCustomProvider(input)
      store.saveCustomProvider(provider)
      const patch = parseProviderSettings(input)
      if (Object.values(patch.headers ?? {}).includes(MASKED_HEADER_VALUE)) {
        throw new Error('A masked header value needs a stored value to keep: retype the header.')
      }
      if (Object.keys(patch).length) store.saveProviderSettings(provider.id, patch)
      return provider
    },

    /** Update credentials and call settings for any provider, built-in or custom. */
    updateSettings(providerId, input) {
      const provider = this.resolve({ providerId })
      const patch = parseProviderSettings(input)
      const mergedStyle = patch.authStyle ?? settingsFor(provider.id)?.authStyle ?? 'auto'
      const mergedHeader = patch.authHeader ?? settingsFor(provider.id)?.authHeader ?? null
      if (mergedStyle === 'header' && !mergedHeader) throw new Error('A custom auth header needs a header name.')
      if (patch.headers) {
        // The editor sends masked values back for headers it never saw. Resolve
        // each against what is stored: replace semantics are preserved (an
        // omitted name is still deleted), and a mask with nothing behind it is
        // refused rather than stored as a row of dots.
        const stored = settingsFor(provider.id)?.headers ?? {}
        const resolved = {}
        for (const [name, value] of Object.entries(patch.headers)) {
          if (value === MASKED_HEADER_VALUE) {
            if (stored[name] === undefined) throw new Error(`Header "${name}" shows a masked value with nothing stored: retype it.`)
            resolved[name] = stored[name]
          } else {
            resolved[name] = value
          }
        }
        patch.headers = resolved
      }
      store.saveProviderSettings(provider.id, patch)
      return this.list().find((item) => item.id === provider.id)
    },

    removeCustom(id) {
      if (builtInProviders().some((provider) => provider.id === id)) throw new Error('Built-in providers cannot be removed.')
      if (!store.removeCustomProvider(id)) throw new Error('Custom provider not found.')
      store.removeProviderSettings(id)
      return id
    },
  }
}
