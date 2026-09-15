import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { canonicalJson } from './canonicalJson.mjs'

export const PERMISSION_MODES = ['guided', 'selective', 'autopilot']

// Credentials are refused by path, whatever the permission mode. This is a
// backstop, not a boundary: it cannot know about every secret a user keeps.
const sensitiveFilePattern = /^(\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|credentials(?:\..*)?|kubeconfig|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore|ppk|sqlite(?:-shm|-wal)?|db))$/i

// Windows resolves these names to devices, and a colon addresses an alternate
// data stream that ordinary listing hides.
const windowsReservedPattern = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

export function isSensitivePath(relativePath) {
  return String(relativePath ?? '').split(/[\\/]/).some((segment) => sensitiveFilePattern.test(segment))
}

function assertInsideWorkspace(root, candidate) {
  const relative = path.relative(root, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path must stay inside the Fulkrum workspace.')
  }
}

function realpathOrNull(target) {
  try {
    return realpathSync.native(target)
  } catch {
    return null
  }
}

function deepestExistingAncestor(target) {
  let current = target
  while (current && current !== path.dirname(current)) {
    if (realpathOrNull(current)) return current
    current = path.dirname(current)
  }
  return null
}

function assertNoWindowsTraps(candidate) {
  const raw = String(candidate ?? '')
  if (raw.startsWith('\\\\') || raw.startsWith('//')) throw new Error('UNC and device paths are not available to agent tools.')
  if (/^[a-zA-Z]:/.test(raw)) return // an absolute path is fine; containment is checked separately
  if (raw.includes(':')) throw new Error('Alternate data stream paths are not available to agent tools.')
  const segments = raw.split(/[\\/]/).filter(Boolean)
  if (segments.some((segment) => windowsReservedPattern.test(segment))) {
    throw new Error('Reserved device names are not available to agent tools.')
  }
}

/**
 * Resolve a workspace path and prove the *real* target is still inside the
 * workspace. A textual prefix check is not enough: a symlink or NTFS junction
 * inside the workspace can point anywhere, and the text of the path would still
 * look contained.
 */
export function resolveWorkspacePath(workspaceRoot, candidate, { forWrite = false } = {}) {
  const root = path.resolve(workspaceRoot)
  assertNoWindowsTraps(candidate)

  const resolved = path.resolve(root, String(candidate ?? '.'))
  assertInsideWorkspace(root, resolved)

  const ancestor = deepestExistingAncestor(resolved)
  if (ancestor) {
    const realAncestor = realpathOrNull(ancestor)
    if (realAncestor) assertInsideWorkspace(root, realAncestor)
  }

  const stats = (() => {
    try {
      return statSync(resolved)
    } catch {
      return null
    }
  })()

  if (stats?.isSymbolicLink?.() || (stats && !stats.isFile() && !stats.isDirectory())) {
    throw new Error('Only regular files and directories are available to agent tools.')
  }

  if (forWrite) {
    // A link at the destination would let a write escape the validated subtree.
    const realTarget = realpathOrNull(resolved)
    if (realTarget && path.resolve(realTarget) !== path.resolve(resolved)) {
      throw new Error('Refusing to write through a link inside the workspace.')
    }
  } else if (realTargetExists(resolved)) {
    const real = realpathOrNull(resolved)
    if (real) assertInsideWorkspace(root, real)
  }

  return { resolved, relative: (path.relative(root, resolved) || '.').split(path.sep).join('/') }
}

function realTargetExists(target) {
  try {
    statSync(target)
    return true
  } catch {
    return false
  }
}

function describeWrite(value) {
  const content = typeof value === 'string' ? value : ''
  return { bytes: Buffer.byteLength(content, 'utf8'), contentSha256: createHash('sha256').update(content, 'utf8').digest('hex') }
}

/**
 * Turn a raw tool request into the exact call that will run: resolved paths,
 * final argv, destination host. This is what the user approves, what the audit
 * log records, and what the fingerprint commits to. Never the model's summary.
 */
export function resolveToolCall({ name, input = {}, workspaceRoot }) {
  const raw = input && typeof input === 'object' ? input : {}
  try {
    if (name === 'workspace.list' || name === 'workspace.read' || name === 'workspace.search') {
      const target = resolveWorkspacePath(workspaceRoot, raw.path)
      return {
        ok: true,
        resolved: { tool: name, path: target.resolved, relative: target.relative, query: name === 'workspace.search' ? String(raw.query ?? '') : undefined },
        sensitive: isSensitivePath(target.relative),
      }
    }

    if (name === 'workspace.write') {
      const target = resolveWorkspacePath(workspaceRoot, raw.path, { forWrite: true })
      return {
        ok: true,
        resolved: { tool: name, path: target.resolved, relative: target.relative, ...describeWrite(raw.content) },
        sensitive: isSensitivePath(target.relative),
      }
    }

    if (name === 'shell.exec') {
      const command = String(raw.command ?? '').trim()
      const args = Array.isArray(raw.args) ? raw.args.map(String) : []
      const target = resolveWorkspacePath(workspaceRoot, raw.cwd)
      return { ok: true, resolved: { tool: name, command: path.basename(command).toLowerCase(), argv: [path.basename(command).toLowerCase(), ...args], cwd: target.resolved }, sensitive: false }
    }

    if (name === 'http.request') {
      const url = new URL(String(raw.url ?? ''))
      const method = String(raw.method ?? 'GET').toUpperCase()
      const headers = raw.headers && typeof raw.headers === 'object' ? Object.keys(raw.headers).map((key) => key.toLowerCase()).sort() : []
      const body = raw.body === undefined ? undefined : canonicalJson(raw.body)
      return {
        ok: true,
        // Header values and body contents are not stored: the audit record binds
        // to their hash so a changed payload invalidates the approval, without
        // putting credentials into the log.
        resolved: { tool: name, method, url: url.href, host: url.hostname.toLowerCase(), headerNames: headers, bodySha256: body === undefined ? null : createHash('sha256').update(body, 'utf8').digest('hex') },
        sensitive: false,
      }
    }

    return { ok: false, error: `Unknown tool: ${name}` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not resolve the tool call.' }
  }
}

export function fingerprintToolCall(resolution) {
  if (!resolution?.ok) throw new Error(resolution?.error ?? 'Cannot fingerprint an unresolved tool call.')
  return createHash('sha256').update(canonicalJson(resolution.resolved), 'utf8').digest('hex')
}

export function fingerprintInput({ name, input, workspaceRoot }) {
  return fingerprintToolCall(resolveToolCall({ name, input, workspaceRoot }))
}

/**
 * The single policy table. Order is the precedence: deny rules first, then ask,
 * then allow, and the first match wins. Specificity does not reorder it, so a
 * broad deny always beats a narrow allow.
 *
 * Exported as data so tests, the UI, and the documentation can all read the
 * same source of truth.
 */
export const permissionMatrix = [
  {
    id: 'deny.unknown-tool',
    decision: 'deny',
    reason: 'Unknown tool.',
    when: ({ tool }) => !tool,
  },
  {
    id: 'deny.unresolvable-input',
    decision: 'deny',
    reason: ({ resolution }) => resolution?.error ?? 'The tool call could not be resolved.',
    when: ({ resolution }) => resolution?.ok === false,
  },
  {
    id: 'deny.sensitive-path',
    decision: 'deny',
    reason: 'Sensitive files are not available to agent tools.',
    when: ({ resolution }) => resolution?.sensitive === true,
  },
  {
    id: 'ask.shell-outside-autopilot',
    decision: 'ask',
    reason: ({ mode }) => `shell actions require approval in ${mode} mode.`,
    when: ({ tool, mode }) => tool?.kind === 'shell' && mode !== 'autopilot',
  },
  {
    id: 'ask.http-autopilot-without-allowlist',
    decision: 'ask',
    reason: 'Autopilot HTTP requests require FULKRUM_HTTP_ALLOWLIST.',
    when: ({ tool, mode, httpAllowlist }) => tool?.kind === 'http' && mode === 'autopilot' && (httpAllowlist?.length ?? 0) === 0,
  },
  {
    id: 'allow.read',
    decision: 'allow',
    reason: 'Read-only tool.',
    when: ({ tool }) => tool?.kind === 'read',
  },
  {
    id: 'allow.autopilot',
    decision: 'allow',
    reason: 'Autopilot policy.',
    when: ({ mode }) => mode === 'autopilot',
  },
  {
    id: 'ask.default',
    decision: 'ask',
    reason: ({ mode, tool }) => `${tool?.kind ?? 'unknown'} actions require approval in ${mode} mode.`,
    when: () => true,
  },
]

/**
 * Decide one tool call. Unknown tools, unresolvable inputs, and sensitive paths
 * are refused outright; everything else falls through the table.
 */
export function decidePermission({ mode = 'selective', tool, resolution, httpAllowlist = [] }) {
  const context = { mode: PERMISSION_MODES.includes(mode) ? mode : 'guided', tool, resolution, httpAllowlist }
  const rule = permissionMatrix.find((candidate) => candidate.when(context))
  const reason = typeof rule.reason === 'function' ? rule.reason(context) : rule.reason
  return {
    ruleId: rule.id,
    decision: rule.decision,
    allowed: rule.decision === 'allow',
    requiresApproval: rule.decision === 'ask',
    reason,
  }
}
