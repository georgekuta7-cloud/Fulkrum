import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { canonicalJson } from './canonicalJson.mjs'
import { hostMatches } from './networkPolicy.mjs'

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
  // The drive-letter colon is legitimate; the rest of the path is not exempt.
  // Returning early here let C:\ws\CON.txt reach the device and C:\ws\a.txt:stream
  // address an alternate data stream, because both live after the prefix.
  const withoutDrive = raw.replace(/^[a-zA-Z]:/, '')
  if (withoutDrive.includes(':')) throw new Error('Alternate data stream paths are not available to agent tools.')
  const segments = withoutDrive.split(/[\\/]/).filter(Boolean)
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
  // Containment is judged on real paths. The configured root can be a short name,
  // a symlink, or a junction, and comparing a real path against a verbatim root
  // reports a false escape: a CI runner's temp directory is an 8.3 short name, so
  // every tool call there failed the containment check while passing locally.
  const configuredRoot = path.resolve(workspaceRoot)
  const root = realpathOrNull(configuredRoot) ?? configuredRoot
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
 *
 * @param {{ name: string, input?: Record<string, any>, workspaceRoot: string }} request
 * @returns {{ ok: boolean, error?: string, sensitive?: boolean, resolved?: Record<string, any> }}
 */
export function resolveToolCall({ name, input = {}, workspaceRoot }) {
  const raw = input && typeof input === 'object' ? input : {}
  try {
    if (name === 'workspace.list' || name === 'workspace.read' || name === 'workspace.search') {
      const target = resolveWorkspacePath(workspaceRoot, raw.path)
      return {
        ok: true,
        // `directory` is what tells a standing grant where to draw its boundary:
        // these two tools act on a directory, the others on a file.
        resolved: { tool: name, path: target.resolved, relative: target.relative, ...(name === 'workspace.read' ? {} : { directory: true }), query: name === 'workspace.search' ? String(raw.query ?? '') : undefined },
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
      if (!command) throw new Error('A command is required.')
      if ([command, ...args].some((part) => part.includes('\u0000'))) throw new Error('A command argument contained a null byte.')
      const target = resolveWorkspacePath(workspaceRoot, raw.cwd)
      // The command is kept exactly as given: it is resolved inside the container,
      // where a path like ./scripts/build.sh means something.
      return { ok: true, resolved: { tool: name, argv: [command, ...args], cwd: target.resolved }, sensitive: false }
    }

    if (name === 'run.ask') {
      const question = String(raw.question ?? '').trim()
      if (!question) throw new Error('A question is required.')
      if (question.includes('\u0000')) throw new Error('A question contained a null byte.')
      const context = raw.context === undefined || raw.context === null ? null : String(raw.context)
      // The question text is the resolved call: answering binds to exactly
      // what was asked, and an edited question parks again rather than
      // answering something else.
      return { ok: true, resolved: { tool: name, question: question.slice(0, 2000), context: context?.slice(0, 2000) ?? null }, sensitive: false }
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
 * Headers that carry a credential. An outbound request that sets one is asking to
 * hand a secret to a host, which is exactly the shape an injected instruction
 * takes: read a config file, then send its contents somewhere.
 */
const credentialHeaders = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key'])

function carriesCredentialHeader(resolution) {
  const names = resolution?.resolved?.headerNames
  return Array.isArray(names) && names.some((name) => credentialHeaders.has(String(name).toLowerCase()))
}

/**
 * The scope a standing grant could cover, derived from a call the user just
 * approved with "always".
 *
 * Only calls whose risk can be *bounded* get a scope. A file write is bounded by the
 * directory it is in; a request is bounded by its host. A command is bounded by
 * nothing — its argv can be anything — so it cannot be made standing, and a file in
 * the workspace root would scope to the whole workspace, which is the blanket
 * permission this exists to avoid. Both refuse with a reason rather than quietly
 * turning into more than the user asked for.
 */
export function standingScopeFor({ toolName, resolved }) {
  if (!resolved || typeof resolved !== 'object') return { ok: false, error: 'That call has no resolved arguments to scope a standing grant to.' }
  if (typeof resolved.relative === 'string' && resolved.relative) {
    // For a tool that works on a directory, the directory itself is the scope; for
    // a file, it is the directory the file is in.
    const scope = resolved.directory === true
      ? resolved.relative
      : resolved.relative.includes('/') ? resolved.relative.slice(0, resolved.relative.lastIndexOf('/')) : '.'
    if (scope === '.' || scope === '') {
      return { ok: false, error: 'That path is in the workspace root, so allowing it would allow anything in the workspace. Approve it once, or for this run.' }
    }
    return { ok: true, kind: 'path', value: scope, label: `${toolName} under ${scope}/` }
  }
  if (typeof resolved.host === 'string' && resolved.host) {
    return { ok: true, kind: 'host', value: resolved.host, label: `${toolName} to ${resolved.host}` }
  }
  return { ok: false, error: 'That tool has no scope to bind a standing grant to, so it has to be approved each time.' }
}

/** Whether an already-recorded standing grant covers this call. */
export function standingScopeMatches(grant, resolved) {
  if (!grant || !resolved) return false
  if (grant.scopeKind === 'path') {
    const relative = String(resolved.relative ?? '')
    if (!relative) return false
    const scope = String(grant.scopeValue ?? '')
    if (!scope) return false
    // A directory boundary, not a string prefix: `src` must not match `src2/a.txt`.
    return relative === scope || relative.startsWith(`${scope}/`)
  }
  if (grant.scopeKind === 'host') {
    // Exact, deliberately: a grant for api.example.com is not a grant for
    // anything.example.com.
    return String(resolved.host ?? '') === String(grant.scopeValue ?? '')
  }
  return false
}

/** Validate a scope a caller supplied directly, rather than one derived from a call. */
export function validateStandingScope({ toolName, scopeKind, scopeValue }) {
  if (!['path', 'host'].includes(scopeKind)) return { ok: false, error: 'A standing grant scope must be a path or a host.' }
  const value = String(scopeValue ?? '').trim()
  if (!value) return { ok: false, error: 'A standing grant needs a scope value.' }
  if (scopeKind === 'path') {
    if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)) return { ok: false, error: 'A path scope is relative to the workspace root.' }
    // Normalize before checking: `src/../etc` and `src//sub` are refused or reduced,
    // never stored as written, because the stored value is what matching compares.
    const normalized = value
      .replaceAll('\\', '/')
      .replace(/\/{2,}/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/+$/, '')
    if (value.split(/[\\/]/).includes('..')) return { ok: false, error: 'A path scope cannot leave the workspace.' }
    if (!normalized || normalized === '.') return { ok: false, error: 'Scoping to the workspace root would allow anything in it.' }
    return { ok: true, kind: 'path', value: normalized, label: `${toolName} under ${normalized}/` }
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(value)) return { ok: false, error: `"${value}" is not a host name.` }
  return { ok: true, kind: 'host', value: value.toLowerCase(), label: `${toolName} to ${value.toLowerCase()}` }
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
    id: 'ask.question',
    decision: 'ask',
    reason: 'A question needs a human answer in every mode, including autopilot: nothing else can answer it.',
    when: ({ tool }) => tool?.kind === 'ask',
  },
  {
    id: 'ask.shell-outside-autopilot',
    decision: 'ask',
    reason: ({ mode }) => `shell actions require approval in ${mode} mode.`,
    when: ({ tool, mode }) => tool?.kind === 'shell' && mode !== 'autopilot',
  },
  {
    id: 'ask.http-credential-headers',
    decision: 'ask',
    reason: 'A request that carries a credential header needs approval unless the host is allowlisted.',
    when: ({ tool, resolution, httpAllowlist }) => tool?.kind === 'http' && carriesCredentialHeader(resolution) && !hostMatches(resolution?.resolved?.host, httpAllowlist ?? []),
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
