/**
 * Every setting Fulkrum reads, in one place.
 *
 * Two problems this solves. A typo used to surface as a confusing runtime failure
 * rather than a startup message — a bad port, an allowlist entry that is not a
 * host, a timeout that is not a number. And nothing could answer "what is
 * actually in effect?", which meant reading nine files to find out.
 *
 * The settings that must be right before anything else works — where the database
 * is, what the bridge listens on, who may call it, whether the built UI is served
 * — are read once at boot from here. The rest are declared here so they can be
 * reported, while the modules that use them keep reading them where they are used:
 * a retry count or a concurrency limit can then change without a restart, and a
 * test can set one without reloading the module.
 */

/** @typedef {{ name: string, group: string, kind: 'int'|'port'|'bool'|'string'|'path'|'list'|'enum'|'money', default: any, description: string, min?: number, max?: number, choices?: string[], item?: 'host'|'origin' }} Setting */

const asBool = (value) => /^(1|true|yes)$/i.test(String(value ?? ''))
const asList = (value) => String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean)

const hostPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

/** @type {Setting[]} */
export const settings = [
  // --- Bridge ---------------------------------------------------------------
  { name: 'FULKRUM_API_PORT', group: 'bridge', kind: 'port', default: 8787, description: 'Port the local API bridge listens on. It only ever binds 127.0.0.1.' },
  { name: 'FULKRUM_ALLOWED_ORIGINS', group: 'bridge', kind: 'list', default: 'http://127.0.0.1:5173,http://localhost:5173', item: 'origin', description: 'Browser origins allowed to call the API. Requests with no Origin header are allowed by design.' },
  { name: 'FULKRUM_SERVE_UI', group: 'bridge', kind: 'bool', default: false, description: 'Serve the built UI from the bridge itself, so `npm start` needs no dev server.' },
  { name: 'FULKRUM_DIST_DIR', group: 'bridge', kind: 'path', default: 'dist', description: 'Where the built UI lives when the bridge serves it.' },

  // --- Local paths ----------------------------------------------------------
  { name: 'FULKRUM_DB_PATH', group: 'storage', kind: 'path', default: '', description: 'Database file. Overrides FULKRUM_DATA_DIR.' },
  { name: 'FULKRUM_DATA_DIR', group: 'storage', kind: 'path', default: 'data', description: 'Directory holding the database, anchor log, and backups.' },
  { name: 'FULKRUM_WORKSPACE_ROOT', group: 'storage', kind: 'path', default: '', description: 'The only directory agent tools may touch. Defaults to the working directory.' },
  { name: 'FULKRUM_ANCHOR_FILE', group: 'storage', kind: 'string', default: 'audit-heads.log', description: 'Where chain-head anchors are appended, beside the database. "off" disables them.' },
  { name: 'FULKRUM_BACKUP_INTERVAL_HOURS', group: 'storage', kind: 'int', default: 24, min: 0, description: 'Take a backup at boot when the newest is older than this. 0 disables it.' },
  { name: 'FULKRUM_BACKUP_KEEP', group: 'storage', kind: 'int', default: 7, min: 1, description: 'How many backups to keep before rotating the oldest out.' },
  { name: 'FULKRUM_WAL_AUTOCHECKPOINT', group: 'storage', kind: 'int', default: 1000, min: 0, description: 'WAL pages before SQLite checkpoints them into the main file.' },
  { name: 'FULKRUM_TOOL_OUTPUT_RETENTION_DAYS', group: 'storage', kind: 'int', default: 14, min: 0, description: 'How long tool outputs, raw inputs, and finished tasks turns are kept. 0 disables pruning.' },
  { name: 'FULKRUM_PRICE_FILE', group: 'storage', kind: 'path', default: '', description: 'JSON price overrides, in the shape model -> {input, output, cacheRead, cacheWrite}.' },

  // --- Limits ---------------------------------------------------------------
  { name: 'FULKRUM_MAX_PARALLEL_RESEARCHERS', group: 'limits', kind: 'int', default: 3, min: 1, description: 'Read-only tasks that may run at once. Writers are always serialized.' },
  { name: 'FULKRUM_MAX_TOOL_STEPS', group: 'limits', kind: 'int', default: 8, min: 1, description: 'Tool calls a single task may make before it is asked to summarize.' },
  { name: 'FULKRUM_MAX_OUTPUT_TOKENS', group: 'limits', kind: 'int', default: 4096, min: 1, description: 'Upper bound on a single model reply, where the protocol takes one.' },
  { name: 'FULKRUM_MAX_SNAPSHOT_BYTES', group: 'limits', kind: 'int', default: 64_000, min: 0, description: "How much of a file's previous content is kept so its change can be reviewed." },
  { name: 'FULKRUM_MAX_DIFF_LINES', group: 'limits', kind: 'int', default: 2000, min: 0, description: 'Lines a stored artifact diff may contain.' },
  { name: 'FULKRUM_MAX_HTTP_BODY_BYTES', group: 'limits', kind: 'int', default: 1_000_000, min: 1024, description: 'Response body the http.request tool reads before cutting the connection.' },
  { name: 'FULKRUM_MAX_PROVIDER_BYTES', group: 'limits', kind: 'int', default: 8_000_000, min: 1024, description: 'Provider response size treated as an error rather than parsed.' },

  // --- Timeouts and retries -------------------------------------------------
  { name: 'FULKRUM_HTTP_TIMEOUT_MS', group: 'providers', kind: 'int', default: 30_000, min: 1000, max: 120_000, description: 'Timeout for one outbound http.request call.' },
  { name: 'FULKRUM_PROVIDER_TIMEOUT_MS', group: 'providers', kind: 'int', default: 60_000, min: 1000, description: 'Timeout for one provider request.' },
  { name: 'FULKRUM_PROVIDER_MAX_ATTEMPTS', group: 'providers', kind: 'int', default: 3, min: 1, description: 'Attempts a retryable provider failure gets.' },
  { name: 'FULKRUM_PROVIDER_MAX_CONCURRENCY', group: 'providers', kind: 'int', default: 3, min: 1, description: 'Calls in flight to one provider before the rest queue.' },
  { name: 'FULKRUM_BREAKER_THRESHOLD', group: 'providers', kind: 'int', default: 3, min: 1, description: 'Retryable failures in a row before a provider is skipped.' },
  { name: 'FULKRUM_BREAKER_COOLDOWN_MS', group: 'providers', kind: 'int', default: 30_000, min: 0, description: 'How long a skipped provider is left alone before one probe.' },
  { name: 'FULKRUM_FALLBACK_ROUTES', group: 'providers', kind: 'list', default: '', description: 'Ordered "Provider · model" routes tried when the primary fails.' },

  // --- Budgets --------------------------------------------------------------
  { name: 'FULKRUM_RUN_BUDGET_USD', group: 'budgets', kind: 'money', default: 0, min: 0, description: 'Default ceiling per run. 0 means no ceiling.' },
  { name: 'FULKRUM_DAILY_BUDGET_USD', group: 'budgets', kind: 'money', default: 0, min: 0, description: 'Ceiling per day across every run. 0 means no ceiling.' },
  { name: 'FULKRUM_BUDGET_RESERVE_USD', group: 'budgets', kind: 'money', default: 0.02, min: 0, description: 'What a call in flight is assumed to cost against a ceiling.' },
  { name: 'FULKRUM_BUDGET_TIMEZONE', group: 'budgets', kind: 'enum', default: '', choices: ['', 'UTC'], description: 'Window for the daily ceiling: local midnight, or UTC.' },

  // --- Network policy -------------------------------------------------------
  { name: 'FULKRUM_HTTP_ALLOWLIST', group: 'security', kind: 'list', default: '', item: 'host', description: 'Hosts the http.request tool may reach. Empty means none are pre-approved.' },
  { name: 'FULKRUM_ALLOW_PRIVATE_PROVIDER_URLS', group: 'security', kind: 'bool', default: false, description: 'Allow provider endpoints on loopback or a private network, for every provider.' },

  // --- Execution boundary ---------------------------------------------------
  { name: 'FULKRUM_CONTAINER_ENGINE', group: 'execution', kind: 'enum', default: '', choices: ['', 'docker', 'docker-wsl', 'podman'], description: 'Container engine to use, or empty to detect one.' },
  { name: 'FULKRUM_CONTAINER_CLI', group: 'execution', kind: 'path', default: '', description: 'Absolute path to the engine CLI, for shells where it is not on PATH.' },
  { name: 'FULKRUM_RUNNER_IMAGE', group: 'execution', kind: 'string', default: 'fulkrum-runner:local', description: 'Runner image. Pin it by digest: the image is part of the boundary.' },
  { name: 'FULKRUM_RUNNER_USER', group: 'execution', kind: 'string', default: '', description: 'uid:gid a command runs as. Defaults to the owner of the workspace.' },
  { name: 'FULKRUM_RUNNER_USERNS', group: 'execution', kind: 'string', default: '', description: 'User-namespace mode, such as keep-id for rootless Podman.' },
  { name: 'FULKRUM_RUNNER_NOFILE', group: 'execution', kind: 'int', default: 1024, min: 16, description: 'File-descriptor limit inside the container.' },
  { name: 'FULKRUM_CONTAINER_MEMORY', group: 'execution', kind: 'string', default: '2g', description: 'Memory limit per command.' },
  { name: 'FULKRUM_CONTAINER_CPUS', group: 'execution', kind: 'string', default: '2', description: 'CPU limit per command.' },
  { name: 'FULKRUM_CONTAINER_PIDS', group: 'execution', kind: 'int', default: 256, min: 16, description: 'Process limit per command.' },
  { name: 'FULKRUM_EXEC_TIMEOUT_MS', group: 'execution', kind: 'int', default: 120_000, min: 1000, max: 600_000, description: 'Wall-clock timeout before a command is stopped and its container removed.' },
  { name: 'FULKRUM_ENGINE_RETRY_MS', group: 'execution', kind: 'int', default: 30_000, min: 0, description: 'How long an "engine unavailable" result is cached before probing again.' },

  // --- Provider endpoints and models ---------------------------------------
  { name: 'XAI_BASE_URL', group: 'providers', kind: 'string', default: 'https://api.x.ai/v1', description: 'Grok endpoint.' },
  { name: 'OPENAI_BASE_URL', group: 'providers', kind: 'string', default: 'https://api.openai.com/v1', description: 'OpenAI endpoint.' },
  { name: 'ANTHROPIC_BASE_URL', group: 'providers', kind: 'string', default: 'https://api.anthropic.com/v1', description: 'Anthropic endpoint.' },
  { name: 'GOOGLE_BASE_URL', group: 'providers', kind: 'string', default: 'https://generativelanguage.googleapis.com/v1beta', description: 'Google endpoint.' },
  { name: 'DEEPSEEK_BASE_URL', group: 'providers', kind: 'string', default: 'https://api.deepseek.com/v1', description: 'DeepSeek endpoint.' },
  { name: 'GLM_BASE_URL', group: 'providers', kind: 'string', default: 'https://open.bigmodel.cn/api/paas/v4', description: 'GLM endpoint.' },
  { name: 'KIMI_BASE_URL', group: 'providers', kind: 'string', default: 'https://api.moonshot.ai/v1', description: 'Kimi endpoint.' },
  { name: 'FULKRUM_GROK_MODEL', group: 'providers', kind: 'string', default: 'grok-4', description: 'Default model for Grok routes.' },
  { name: 'FULKRUM_OPENAI_MODEL', group: 'providers', kind: 'string', default: 'gpt-5', description: 'Default model for OpenAI routes.' },
  { name: 'FULKRUM_ANTHROPIC_MODEL', group: 'providers', kind: 'string', default: 'claude-opus-4-1', description: 'Default model for Anthropic routes.' },
  { name: 'FULKRUM_GOOGLE_MODEL', group: 'providers', kind: 'string', default: 'gemini-2.5-pro', description: 'Default model for Google routes.' },
  { name: 'FULKRUM_DEEPSEEK_MODEL', group: 'providers', kind: 'string', default: 'deepseek-chat', description: 'Default model for DeepSeek routes.' },
  { name: 'FULKRUM_GLM_MODEL', group: 'providers', kind: 'string', default: 'glm-4.5', description: 'Default model for GLM routes.' },
  { name: 'FULKRUM_KIMI_MODEL', group: 'providers', kind: 'string', default: 'kimi-k2', description: 'Default model for Kimi routes.' },
]

const byName = new Map(settings.map((setting) => [setting.name, setting]))

/** Validate one raw value against its descriptor. Returns the parsed value or a problem. */
export function parseSetting(setting, raw) {
  const text = String(raw ?? '').trim()
  const fallback = () => ({ value: setting.default })

  if (!text) return setting.kind === 'list' ? { value: typeof setting.default === 'string' ? asList(setting.default) : setting.default } : fallback()

  if (setting.kind === 'bool') return { value: asBool(text) }
  if (setting.kind === 'list') {
    const items = asList(text)
    if (setting.item === 'host') {
      const bad = items.find((item) => !hostPattern.test(item))
      if (bad) return { problem: `"${bad}" is not a host name (use a bare host, without scheme or port).`, value: setting.default }
    }
    if (setting.item === 'origin') {
      const bad = items.find((item) => {
        try {
          const url = new URL(item)
          return !['http:', 'https:'].includes(url.protocol)
        } catch {
          return true
        }
      })
      if (bad) return { problem: `"${bad}" is not an origin (expected something like http://127.0.0.1:5173).`, value: setting.default }
    }
    return { value: items.length ? items : setting.default }
  }
  if (setting.kind === 'enum') {
    if (setting.choices.includes(text)) return { value: text }
    if (setting.choices.includes(text.toUpperCase())) return { value: text.toUpperCase() }
    return { problem: `expected one of: ${setting.choices.filter(Boolean).join(', ')}${setting.choices.includes('') ? ' (or empty)' : ''}.`, value: setting.default }
  }
  if (setting.kind === 'int' || setting.kind === 'port' || setting.kind === 'money') {
    const numeric = Number(text)
    if (!Number.isFinite(numeric)) return { problem: `"${text}" is not a number.`, value: setting.default }
    if (setting.kind === 'port' && (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535)) return { problem: `"${text}" is not a port between 1 and 65535.`, value: setting.default }
    if (setting.min !== undefined && numeric < setting.min) return { problem: `${numeric} is below the minimum of ${setting.min}.`, value: setting.default }
    if (setting.max !== undefined && numeric > setting.max) return { problem: `${numeric} is above the maximum of ${setting.max}.`, value: setting.default }
    return { value: numeric }
  }
  if (setting.kind === 'string' && setting.name === 'FULKRUM_RUNNER_USER' && !/^\d+:\d+$/.test(text)) {
    return { problem: `"${text}" is not a uid:gid pair (for example 1000:1000).`, value: setting.default }
  }
  return { value: text }
}

/**
 * Every setting with its effective value, and every problem found. `source` says
 * whether the value came from the environment or the default, which is what makes
 * a stale .env.local visible.
 */
export function settingReport(env = process.env) {
  return settings.map((setting) => {
    const present = env[setting.name] !== undefined && String(env[setting.name]).trim() !== ''
    const parsed = parseSetting(setting, env[setting.name])
    return {
      name: setting.name,
      group: setting.group,
      description: setting.description,
      configured: present,
      source: present ? 'env' : 'default',
      value: parsed.value,
      problem: parsed.problem ?? null,
    }
  })
}

/** The resolved values plus the problems, for the caller that has to act on them. */
export function resolveSettings(env = process.env) {
  const values = {}
  const problems = []
  for (const entry of settingReport(env)) {
    values[entry.name] = entry.value
    if (entry.problem) problems.push({ name: entry.name, message: entry.problem, using: entry.value })
  }
  return { values, problems }
}

export function settingByName(name) {
  return byName.get(name) ?? null
}
