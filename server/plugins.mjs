import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Plugin manifests v1: declarative HTTP tools, and nothing else.
 *
 * A plugin is a JSON file describing one HTTPS call the model may make: a
 * fixed method, a fixed URL, static headers, and the named string arguments
 * the model may supply. Everything the model does *not* control is the trust
 * story: the URL cannot be steered, headers cannot carry model-chosen secrets,
 * and the call walks the same pinned-DNS path and permission matrix as
 * `http.request` — including the private-address refusal, which no manifest
 * can lift.
 *
 * v1 limits, stated plainly: local manifests only (the marketplace index that
 * distributes them is Wave 3.6), HTTP only (container and MCP plugins are Wave
 * 2.8), string arguments only, no authentication (an endpoint that needs a key
 * waits for credential plumbing — a manifest that inlines one fails validation).
 *
 * A manifest that fails validation is skipped with a console warning, never
 * fatal: a broken JSON file must not take down the tool surface.
 */

const MAX_MANIFEST_BYTES = 32_000
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
const WORKER_ROLES = ['research', 'builder']

/** Plugin folders: configured, workspace-local, or nowhere when "off". */
export function pluginsDir(workspaceRoot) {
  const configured = String(process.env.FULKRUM_PLUGINS_DIR ?? '').trim()
  if (configured.toLowerCase() === 'off') return null
  return configured || path.join(workspaceRoot, 'plugins')
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Best-effort static classification of literal addresses: dotted quads, IPv6
 * (any colon means v6 — all v6 loopback/link-local forms refuse), hex/octal
 * parts, and single-integer forms. Hostnames are checked at request time by
 * the pinned layer (the real guard, with the full CIDR table) — this keeps
 * the approval UI from cheerfully offering a loopback destination, nothing more.
 */
function numericBytes(host) {
  const part = (text) => {
    if (/^0x[0-9a-f]+$/i.test(text)) return parseInt(text, 16)
    if (/^0[0-7]+$/.test(text) && text.length > 1) return parseInt(text, 8)
    if (/^\d+$/.test(text)) return Number(text)
    return null
  }
  if (/^0x[0-9a-f]+$/i.test(host) || /^\d+$/.test(host)) {
    // Single integer form: 2130706433 === 127.0.0.1.
    const value = host.startsWith('0x') || host.startsWith('0X') ? parseInt(host, 16) : Number(host)
    if (!Number.isSafeInteger(value) || value < 0 || value > 4294967295) return null
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
  }
  const parts = host.split('.')
  if (parts.length < 2 || parts.length > 4) return null
  const bytes = parts.map(part)
  if (bytes.some((byte) => byte === null || byte < 0 || byte > 255)) return null
  return bytes
}

function looksPrivateUrl(raw) {
  try {
    const url = new URL(String(raw))
    if (!['http:', 'https:'].includes(url.protocol)) return 'only http and https URLs are allowed'
    const host = url.hostname.toLowerCase()
    if (host.includes(':')) return 'private targets are blocked'
    if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return 'private targets are blocked'
    const bytes = numericBytes(host)
    if (bytes) {
      const [a, b] = bytes.length === 4 ? bytes : bytes.length === 3 ? [bytes[0], bytes[1]] : [bytes[0], 0]
      if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
        return 'private targets are blocked'
      }
    }
    return null
  } catch {
    return 'not a usable URL'
  }
}

/**
 * Validate one manifest object. Returns `{ ok, plugin }` or
 * `{ ok: false, problems }` — the caller decides whether to skip or fail.
 */
export function validatePluginManifest(name, candidate) {
  const problems = []
  if (!/^[a-z0-9]+([.-][a-z0-9]+)*$/.test(String(name ?? ''))) problems.push('the file name must be a lowercase dotted name like image.ocr')
  if (!isPlainObject(candidate)) return { ok: false, problems: [...problems, 'the manifest must be a JSON object'] }
  if (typeof candidate.description !== 'string' || !candidate.description.trim()) problems.push('description must be a non-empty string')
  if (!METHODS.includes(String(candidate.method ?? '').toUpperCase())) problems.push(`method must be one of: ${METHODS.join(', ')}`)
  const urlProblem = looksPrivateUrl(candidate.url)
  if (urlProblem) problems.push(`url ${urlProblem}`)
  if (candidate.headers !== undefined && !isPlainObject(candidate.headers)) problems.push('headers must be an object of static strings')
  else if (isPlainObject(candidate.headers)) {
    for (const [key, value] of Object.entries(candidate.headers)) {
      if (typeof value !== 'string') problems.push(`headers.${key} must be a string`)
    }
  }
  if (candidate.args !== undefined && !isPlainObject(candidate.args)) problems.push('args must be an object of named string parameters')
  else if (isPlainObject(candidate.args)) {
    for (const [key, spec] of Object.entries(candidate.args)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) problems.push(`args.${key} must be a valid parameter name`)
      else if (spec !== undefined && spec !== 'string' && !(isPlainObject(spec) && (spec.type === undefined || spec.type === 'string'))) {
        problems.push(`args.${key} must be a string parameter (v1 supports strings only)`)
      }
    }
  }
  if (candidate.roles !== undefined) {
    const roles = Array.isArray(candidate.roles) ? candidate.roles : null
    if (!roles || !roles.length || roles.some((role) => !WORKER_ROLES.includes(String(role)))) {
      problems.push(`roles must be a non-empty subset of: ${WORKER_ROLES.join(', ')}`)
    }
  }
  if (problems.length) return { ok: false, problems }
  return {
    ok: true,
    plugin: {
      name: String(name),
      toolName: `plugin.${name}`,
      description: String(candidate.description).trim().slice(0, 500),
      method: String(candidate.method).toUpperCase(),
      url: String(candidate.url),
      headers: Object.fromEntries(Object.entries(candidate.headers ?? {}).map(([key, value]) => [String(key).toLowerCase(), String(value)])),
      args: Object.keys(candidate.args ?? {}),
      roles: candidate.roles === undefined ? [...WORKER_ROLES] : [...candidate.roles],
    },
  }
}

/** Load and validate every manifest in the plugins folder. Synchronous, like skills. */
export function loadPluginManifests(workspaceRoot) {
  const dir = pluginsDir(workspaceRoot)
  if (!dir) return { plugins: [], problems: [] }
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { plugins: [], problems: [] }
  }
  const plugins = []
  const problems = []
  // Sorted so duplicate names resolve identically on every machine: readdir
  // order is filesystem-dependent, and "which manifest is live" must not be.
  const ordered = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of ordered) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const name = entry.name.slice(0, -'.json'.length)
    let text
    try {
      // Sized before reading: the byte cap must bound the read, not follow it.
      const size = statSync(path.join(dir, entry.name)).size
      if (size > MAX_MANIFEST_BYTES) throw new Error('manifest exceeds 32 kB')
      text = readFileSync(path.join(dir, entry.name), 'utf8')
    } catch (error) {
      problems.push(`${entry.name}: ${error instanceof Error ? error.message : 'unreadable'}`)
      continue
    }
    let candidate
    try {
      candidate = JSON.parse(text)
    } catch {
      problems.push(`${entry.name}: not valid JSON`)
      continue
    }
    const validation = validatePluginManifest(name, candidate)
    if (!validation.ok) problems.push(`${entry.name}: ${validation.problems.join('; ')}`)
    else if (!plugins.some((plugin) => plugin.toolName === validation.plugin.toolName)) plugins.push(validation.plugin)
    else problems.push(`${entry.name}: duplicate plugin name`)
  }
  return { plugins, problems }
}

/** Tool definitions for the roles a manifest names — the describe side. */
export function pluginToolDefinitions(plugins, role) {
  return (plugins ?? [])
    .filter((plugin) => plugin.roles.includes(role?.agentId ?? role))
    .map((plugin) => ({
      name: plugin.toolName,
      kind: 'http',
      description: `${plugin.description} (plugin ${plugin.name}; fixed ${plugin.method} ${plugin.url})`,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(plugin.args.map((arg) => [arg, { type: 'string', description: `Value for ${arg}.` }])),
        additionalProperties: false,
      },
    }))
}

/** Search installed plugins by name, description, and URL words. */
export function searchPlugins(plugins, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return (plugins ?? [])
    .map((plugin) => ({
      plugin,
      hits: words.filter((word) => `${plugin.name} ${plugin.description} ${plugin.url}`.toLowerCase().includes(word)).length,
    }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((entry) => entry.plugin)
}
