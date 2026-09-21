import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { PERMISSION_MODES, validateStandingScope } from './permissions.mjs'
import { normalizeReasoningLevel } from './reasoning.mjs'
import { agentRoles } from './roles.mjs'

/**
 * Blueprints: versioned team setups as files, not accounts.
 *
 * A blueprint names roles with their casting (route + reasoning level),
 * project defaults, and standing grants to create. Applying one is always
 * two steps — preview renders the exact diff, apply writes it — and a
 * blueprint can never silently elevate: grants go through the same creation
 * path as the API (shell tools refused, unknown tools refused, scopes
 * validated), and routing/reasoning are plain settings writes.
 *
 * Builtins ship in blueprints/ beside the server; FULKRUM_BLUEPRINTS_DIR
 * adds a team folder. Files are the distribution: shareable, versioned,
 * reviewable in git, with no service behind them.
 */

const MAX_BLUEPRINT_BYTES = 32_000

export function builtinBlueprintsDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'blueprints')
}

export function customBlueprintsDir() {
  const configured = String(process.env.FULKRUM_BLUEPRINTS_DIR ?? '').trim()
  if (!configured || configured.toLowerCase() === 'off') return null
  return configured
}

function readDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Every available blueprint: builtins plus the team folder, team wins ties. */
export function listBlueprints() {
  const found = new Map()
  for (const [dir, source] of [[builtinBlueprintsDir(), 'builtin'], [customBlueprintsDir(), 'custom']]) {
    if (!dir) continue
    for (const entry of readDir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      let parsed = null
      try {
        const text = readFileSync(path.join(dir, entry.name), 'utf8')
        if (Buffer.byteLength(text, 'utf8') > MAX_BLUEPRINT_BYTES) continue
        parsed = JSON.parse(text)
      } catch {
        continue
      }
      const name = typeof parsed?.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 120) : entry.name.slice(0, -'.json'.length)
      found.set(name, { name, version: typeof parsed?.version === 'string' ? parsed.version.slice(0, 40) : '1', description: typeof parsed?.description === 'string' ? parsed.description.slice(0, 500) : '', source })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function readBlueprint(name) {
  for (const [dir, source] of [[customBlueprintsDir(), 'custom'], [builtinBlueprintsDir(), 'builtin']]) {
    if (!dir) continue
    for (const entry of readDir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(path.join(dir, entry.name), 'utf8'))
        const candidate = typeof parsed?.name === 'string' && parsed.name.trim() ? parsed.name.trim() : entry.name.slice(0, -'.json'.length)
        if (candidate === name) return { blueprint: parsed, source }
      } catch {
        continue
      }
    }
  }
  return null
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Validate a blueprint object. Returns `{ ok, blueprint }` normalized, or
 * `{ ok: false, problems }`. Unknown roles, levels, modes, and grant shapes
 * are all refused here, before anything is previewed or written.
 */
export function validateBlueprint(candidate) {
  const problems = []
  if (!isPlainObject(candidate)) return { ok: false, problems: ['A blueprint must be a JSON object.'] }
  const roleNames = Object.keys(agentRoles)

  const roles = {}
  if (candidate.roles !== undefined) {
    if (!isPlainObject(candidate.roles)) problems.push('roles must be an object of role name to casting.')
    else {
      for (const [role, casting] of Object.entries(candidate.roles)) {
        if (!roleNames.includes(role)) {
          problems.push(`Unknown role: ${role}. Roles are: ${roleNames.join(', ')}.`)
          continue
        }
        if (!isPlainObject(casting)) {
          problems.push(`roles.${role} must be an object with route and/or reasoning.`)
          continue
        }
        const entry = {}
        if (casting.route !== undefined) {
          if (typeof casting.route !== 'string' || !casting.route.trim()) problems.push(`roles.${role}.route must be a non-empty string.`)
          else entry.route = casting.route.trim().slice(0, 300)
        }
        if (casting.reasoning !== undefined) {
          const level = normalizeReasoningLevel(casting.reasoning)
          if (!level) problems.push(`roles.${role}.reasoning must be one of: minimal, low, medium, high.`)
          else entry.reasoning = level
        }
        if (Object.keys(entry).length) roles[role] = entry
      }
    }
  }

  const defaults = {}
  if (candidate.defaults !== undefined) {
    if (!isPlainObject(candidate.defaults)) problems.push('defaults must be an object.')
    else {
      if (candidate.defaults.permissionMode !== undefined) {
        if (!PERMISSION_MODES.includes(candidate.defaults.permissionMode)) problems.push(`defaults.permissionMode must be one of: ${PERMISSION_MODES.join(', ')}.`)
        else defaults.permissionMode = candidate.defaults.permissionMode
      }
      if (candidate.defaults.budgetUsd !== undefined && candidate.defaults.budgetUsd !== null) {
        const budget = Number(candidate.defaults.budgetUsd)
        if (!Number.isFinite(budget) || budget <= 0) problems.push('defaults.budgetUsd must be a positive number or null.')
        else defaults.budgetUsd = budget
      }
    }
  }

  const grants = []
  if (candidate.grants !== undefined) {
    if (!Array.isArray(candidate.grants)) problems.push('grants must be an array.')
    else {
      candidate.grants.forEach((grant, index) => {
        if (!isPlainObject(grant) || typeof grant.tool !== 'string' || !grant.tool) {
          problems.push(`grants[${index}].tool must be a tool name.`)
          return
        }
        const scope = validateStandingScope({ toolName: grant.tool, scopeKind: grant.scopeKind, scopeValue: grant.scopeValue })
        if (!scope.ok) {
          problems.push(`grants[${index}]: ${scope.error}`)
          return
        }
        grants.push({ tool: grant.tool, scopeKind: scope.kind, scopeValue: scope.value, label: scope.label })
      })
    }
  }

  if (problems.length) return { ok: false, problems }
  return {
    ok: true,
    blueprint: {
      name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim().slice(0, 120) : 'blueprint',
      version: typeof candidate.version === 'string' ? candidate.version.slice(0, 40) : '1',
      description: typeof candidate.description === 'string' ? candidate.description.slice(0, 500) : '',
      roles,
      defaults,
      grants,
    },
  }
}

/** What applying would change, without writing anything. */
export function previewBlueprint({ store, projectId, blueprint }) {
  const project = store.getProject(projectId)?.project
  if (!project) throw new Error(`Project not found: ${projectId}`)
  const settings = project.settings ?? {}
  const currentRouting = settings.routing ?? {}
  const currentReasoning = settings.reasoning ?? {}
  const currentDefaults = settings.defaults ?? {}
  const diff = { routing: [], reasoning: [], defaults: [], grants: [] }
  for (const [role, casting] of Object.entries(blueprint.roles ?? {})) {
    if (casting.route !== undefined && currentRouting[role] !== casting.route) {
      diff.routing.push({ role, from: currentRouting[role] ?? null, to: casting.route })
    }
    if (casting.reasoning !== undefined && currentReasoning[role] !== casting.reasoning) {
      diff.reasoning.push({ role, from: currentReasoning[role] ?? null, to: casting.reasoning })
    }
  }
  if (blueprint.defaults?.permissionMode !== undefined && currentDefaults.permissionMode !== blueprint.defaults.permissionMode) {
    diff.defaults.push({ key: 'permissionMode', from: currentDefaults.permissionMode ?? null, to: blueprint.defaults.permissionMode })
  }
  if (blueprint.defaults?.budgetUsd !== undefined && currentDefaults.budgetUsd !== blueprint.defaults.budgetUsd) {
    diff.defaults.push({ key: 'budgetUsd', from: currentDefaults.budgetUsd ?? null, to: blueprint.defaults.budgetUsd })
  }
  for (const grant of blueprint.grants ?? []) {
    const exists = store.listStandingGrants().some((entry) => entry.toolName === grant.tool && entry.scopeKind === grant.scopeKind && entry.scopeValue === grant.scopeValue && !entry.revokedAt)
    if (!exists) diff.grants.push({ ...grant, note: 'creates a standing grant: softens ask, never overrides deny' })
  }
  return diff
}

/**
 * Apply a validated blueprint: routing and reasoning merge into project
 * settings, defaults merge beside them, and grants are created through the
 * same checks as the API — unknown tools and shell commands are refused
 * rather than stored, so a blueprint file can never smuggle elevation.
 */
export function applyBlueprint({ store, toolBroker, projectId, blueprint }) {
  const project = store.getProject(projectId)?.project
  if (!project) throw new Error(`Project not found: ${projectId}`)
  // Validate everything before writing anything: tool kinds live behind the
  // broker, so an unknown tool or a shell grant must fail before the settings
  // commit, not after a partial apply the UI already reported as failed.
  for (const grant of blueprint.grants ?? []) {
    const tool = toolBroker.get(grant.tool)
    if (!tool) throw new Error(`Unknown tool in blueprint: ${grant.tool}`)
    if (tool.kind === 'shell') throw new Error('A command has no scope to bind a standing grant to.')
  }
  const settings = { ...(project.settings ?? {}) }
  const applied = { routing: [], reasoning: [], defaults: [], grants: [] }
  for (const [role, casting] of Object.entries(blueprint.roles ?? {})) {
    if (casting.route !== undefined) {
      settings.routing = { ...(settings.routing ?? {}), [role]: casting.route }
      applied.routing.push(role)
    }
    if (casting.reasoning !== undefined) {
      settings.reasoning = { ...(settings.reasoning ?? {}), [role]: casting.reasoning }
      applied.reasoning.push(role)
    }
  }
  for (const [key, value] of Object.entries(blueprint.defaults ?? {})) {
    settings.defaults = { ...(settings.defaults ?? {}), [key]: value }
    applied.defaults.push(key)
  }
  const grantIds = []
  store.transaction(() => {
    store.updateProject(projectId, { settings })
    for (const grant of blueprint.grants ?? []) {
      const created = store.createStandingGrant({ toolName: grant.tool, scopeKind: grant.scopeKind, scopeValue: grant.scopeValue, label: grant.label, createdBy: 'blueprint' })
      grantIds.push(created.id)
    }
  })
  applied.grants.push(...grantIds)
  return applied
}
