import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { configuredHttpAllowlist } from './networkPolicy.mjs'
import { pinnedRequest } from './outboundHttp.mjs'
import { decidePermission, fingerprintToolCall, isSensitivePath, resolveToolCall, resolveWorkspacePath } from './permissions.mjs'
import { hashHeaderValues, redact } from './redaction.mjs'

const MAX_FILE_BYTES = 500_000
// Read at use time, not import time: a value saved through the app applies live.
const maxSnapshotBytes = () => Number(process.env.FULKRUM_MAX_SNAPSHOT_BYTES ?? 64_000)
const MAX_OUTPUT_BYTES = 100_000
const MAX_SEARCH_FILES = 400
const MAX_REDIRECTS = 3
const MAX_IGNORE_RULES = 200
const MAX_READ_CACHE_ENTRIES = 200
const MAX_MANIFEST_LIST = 50
const skippedDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage', '.cache'])

// How many workspace files a shell manifest may name. A command's receipt is
// names, sizes, and mtimes — never contents — so the cap bounds the walk, not
// the honesty: over the cap the receipt says so.
const manifestFileLimit = () => Math.max(Number(process.env.FULKRUM_SHELL_MANIFEST_MAX_FILES ?? 2000) || 0, 0)

/**
 * Extra patterns the workspace owner can add, one per line, `*` and `?` allowed.
 * A deny list in code cannot know what a particular repository considers
 * sensitive; this is how a user extends it without editing the code. A trailing
 * slash means "this directory", as it does in a .gitignore.
 */
async function readIgnoreRules(root) {
  try {
    const text = await fs.readFile(path.join(root, '.fulkrumignore'), 'utf8')
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .slice(0, MAX_IGNORE_RULES)
      .map((line) => line.replace(/\/+$/, ''))
      .filter(Boolean)
      .map((line) => new RegExp(`^${line.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`))
  } catch {
    return []
  }
}

function isIgnored(relativePath, rules) {
  if (!rules.length) return false
  const segments = relativePath.split('/')
  return rules.some((rule) => rule.test(relativePath) || segments.some((segment) => rule.test(segment)))
}

const toolDefinitions = [
  { name: 'workspace.list', kind: 'read', description: 'List entries inside the approved workspace.' },
  { name: 'workspace.read', kind: 'read', description: 'Read a UTF-8 text file inside the approved workspace.' },
  { name: 'workspace.search', kind: 'read', description: 'Search text files inside the approved workspace.' },
  { name: 'workspace.write', kind: 'write', description: 'Write a UTF-8 text file inside the approved workspace.' },
  { name: 'run.ask', kind: 'ask', description: 'Ask the human a question and wait for the answer.' },
  { name: 'shell.exec', kind: 'shell', description: 'Run a command inside the sandboxed workspace container.' },
  { name: 'http.request', kind: 'http', description: 'Call an HTTP or HTTPS endpoint.' },
]

function clipped(value, maximum = MAX_OUTPUT_BYTES) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > maximum ? `${text.slice(0, maximum)}\n[output clipped]` : text
}

async function walkFiles(directory, root, results, query, rules) {
  if (results.length >= MAX_SEARCH_FILES) return
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (results.length >= MAX_SEARCH_FILES) return
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    const relative = path.relative(root, absolute).replaceAll('\\', '/')
    if (isIgnored(relative, rules)) continue
    if (!entry.isDirectory() && isSensitivePath(entry.name)) continue

    if (entry.isDirectory()) {
      // A junction or symlink is followed by readdir but resolves somewhere else
      // entirely, and on Windows a junction is reported as an ordinary directory.
      // lstat does not follow, and containment is re-proved for every directory
      // the walk descends into rather than only for the root it started from.
      const stats = await fs.lstat(absolute).catch(() => null)
      if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) continue
      try {
        resolveWorkspacePath(root, absolute)
      } catch {
        continue
      }
      await walkFiles(absolute, root, results, query, rules)
      continue
    }

    try {
      const content = await fs.readFile(absolute, 'utf8')
      if (content.toLowerCase().includes(query.toLowerCase())) {
        const line = content.split(/\r?\n/).findIndex((item) => item.toLowerCase().includes(query.toLowerCase())) + 1
        results.push({ path: relative, line })
      }
    } catch {
      // Binary or unreadable files are skipped by the search tool.
    }
  }
}

/**
 * Names, sizes, and mtimes of the workspace as one command sees it.
 *
 * The same traversal rules as a search — skipped directories, ignored paths,
 * credential files, links never followed — so the receipt cannot see a file
 * the tools would refuse. Content is never read: the receipt proves *that*
 * files changed, and the verifier reads the ones that matter.
 */
async function snapshotManifest(root, directory, results, rules, limit) {
  if (results.size >= limit) return
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (results.size >= limit) return
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    const relative = path.relative(root, absolute).replaceAll('\\', '/')
    if (isIgnored(relative, rules)) continue
    if (entry.isDirectory()) {
      const stats = await fs.lstat(absolute).catch(() => null)
      if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) continue
      try {
        resolveWorkspacePath(root, absolute)
      } catch {
        continue
      }
      await snapshotManifest(root, absolute, results, rules, limit)
      continue
    }
    if (isSensitivePath(entry.name)) continue
    const stats = await fs.stat(absolute).catch(() => null)
    if (stats) results.set(relative, { size: stats.size, mtimeMs: stats.mtimeMs })
  }
}

/**
 * Credential headers, by name. Values are never inspected here — the name is
 * enough to know a header must not cross an origin boundary.
 */
const credentialHeaderNames = new Set(['authorization', 'proxy-authorization', 'cookie', 'cookie2'])

/** A header name shaped like it carries a secret: api keys, tokens, auth. */
function isCredentialHeaderName(name) {
  const normalized = String(name ?? '').toLowerCase()
  if (credentialHeaderNames.has(normalized)) return true
  return /(api[-_]?key|auth|token|secret|cookie|session)/.test(normalized)
}

/**
 * The next request after a redirect response, or null when the chain ends.
 *
 * Each hop is decided from data, never trusted blindly: a cross-origin hop
 * drops credential headers (an allowlisted host must not forward your
 * Authorization header to wherever it points next), and 301/302/303 turn a
 * body-carrying method into GET, the way browsers and fetch do — resending a
 * POST body to a new URL is how credentials end up where nobody approved.
 */
export function redirectHop({ method, headers, body, currentUrl, status, location }) {
  if (![301, 302, 303, 307, 308].includes(status) || !location) return null
  const nextUrl = new URL(location, currentUrl).href
  const crossedOrigin = new URL(nextUrl).origin !== new URL(currentUrl).origin
  let nextHeaders = headers
  if (crossedOrigin) {
    nextHeaders = Object.fromEntries(
      Object.entries(headers ?? {}).filter(([name]) => !isCredentialHeaderName(name)),
    )
  }
  let nextMethod = method
  let nextBody = body
  // Fetch semantics: 303 always becomes GET (except HEAD), 301/302 convert
  // POST to GET, 307/308 preserve everything. A dropped body takes its
  // content headers with it below, at the call site.
  const dropBody = (status === 303 && method !== 'GET' && method !== 'HEAD')
    || ((status === 301 || status === 302) && method === 'POST')
  if (dropBody) {
    nextMethod = 'GET'
    nextBody = null
  }
  return { method: nextMethod, headers: nextHeaders, body: nextBody, url: nextUrl }
}

/** Added, modified, and removed paths between two manifests, bounded. */
function diffManifests(before, after) {
  const added = []
  const modified = []
  const removed = []
  for (const [relative, next] of after) {
    const previous = before.get(relative)
    if (!previous) added.push(relative)
    else if (previous.size !== next.size || previous.mtimeMs !== next.mtimeMs) modified.push(relative)
  }
  for (const relative of before.keys()) {
    if (!after.has(relative)) removed.push(relative)
  }
  const truncated = added.length > MAX_MANIFEST_LIST || modified.length > MAX_MANIFEST_LIST || removed.length > MAX_MANIFEST_LIST
  return {
    added: added.slice(0, MAX_MANIFEST_LIST),
    modified: modified.slice(0, MAX_MANIFEST_LIST),
    removed: removed.slice(0, MAX_MANIFEST_LIST),
    ...(truncated ? { truncated: true, note: 'More files changed than the receipt lists; the workspace holds the rest.' } : {}),
  }
}

/**
 * Record a file's previous state before it is overwritten. The content is stored
 * so the change can be shown later; oversized files keep their size and hash but
 * not their bytes.
 */
async function snapshotFile(absolutePath) {
  try {
    const handle = await fs.open(absolutePath, 'r')
    try {
      const stats = await handle.stat()
      if (stats.isDirectory()) return null
      const bytes = Number(stats.size)
      const snapshotLimit = maxSnapshotBytes()
      const snapshot = { previousBytes: bytes, previousSha256: null, previousTruncated: bytes > snapshotLimit }
      if (bytes <= snapshotLimit) {
        const content = await handle.readFile({ encoding: 'utf8' })
        snapshot.previousContent = content
        snapshot.previousSha256 = createHash('sha256').update(content, 'utf8').digest('hex')
      }
      return snapshot
    } finally {
      await handle.close()
    }
  } catch {
    // The file does not exist yet, which makes this a creation.
    return null
  }
}


export class FulkrumToolBroker {
  constructor({ workspaceRoot = process.env.FULKRUM_WORKSPACE_ROOT ?? process.cwd(), httpAllowlist = null, execution = null } = {}) {
    // Normalized once, through the same resolver the tools use, so every path the
    // broker reports is relative to a real root. Otherwise a short-named or
    // symlinked workspace root makes result paths point outside themselves.
    // A null allowlist follows the live setting instead of the value captured
    // at construction; an explicit array (as tests pass) stays pinned.
    this.workspaceRoot = resolveWorkspacePath(workspaceRoot, '.').resolved
    this.httpAllowlist = httpAllowlist
    this.execution = execution
    // Reads are cached by path, size, and mtime: repeated reads across parallel
    // workers cost one disk read, and any modification — by a worker, a shell
    // command, or a human — changes the key and misses honestly.
    this.readCache = new Map()
    // Writes and shell commands serialize process-wide across runs. Readers
    // never wait; two writers never interleave on the same workspace.
    /** @type {Promise<unknown>} */
    this.writeChain = Promise.resolve()
  }

  /**
   * Run one mutating call after every earlier one finished.
   *
   * A promise chain, not a lock object: a rejection still hands the turn to
   * the next waiter (via the second `then` branch) while the chain itself
   * stays healthy through the caught copy. No nesting exists — execute never
   * calls execute — so this cannot deadlock.
   *
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  withWriteLock(task) {
    const next = this.writeChain.then(task, task)
    this.writeChain = next.catch(() => {})
    return next
  }

  list() {
    return toolDefinitions.map((tool) => ({ ...tool }))
  }

  get(name) {
    return toolDefinitions.find((tool) => tool.name === name) ?? null
  }

  /** Resolve a raw request into the exact call that would run. */
  resolve(name, input) {
    return resolveToolCall({ name, input, workspaceRoot: this.workspaceRoot })
  }

  fingerprint(resolution) {
    return fingerprintToolCall(resolution)
  }

  authorize({ mode, tool, resolution }) {
    return decidePermission({ mode, tool, resolution, httpAllowlist: this.httpAllowlist ?? configuredHttpAllowlist() })
  }

  /**
   * Execute a call that has already been resolved and authorized. Paths, argv,
   * and URLs come from the resolution the user approved, never from a fresh
   * parse of the request, so what runs is what was shown.
   *
   * Mutations take the write lock: within a run writers are already serial,
   * and this extends the same guarantee across concurrent runs.
   *
   * @returns {Promise<any>}
   */
  async execute(name, input = {}, resolution = null, options = {}) {
    if (name === 'workspace.write' || name === 'shell.exec') {
      return this.withWriteLock(() => this.executeUnclocked(name, input, resolution, options))
    }
    return this.executeUnclocked(name, input, resolution, options)
  }

  /**
   * @returns {Promise<any>}
   */
  async executeUnclocked(name, input = {}, resolution = null, { runId = null } = {}) {
    const outcome = resolution ?? this.resolve(name, input)
    if (!outcome?.ok) throw new Error(outcome?.error ?? `Could not resolve ${name}.`)
    // Refuse credentials here as well as in the policy table: the broker must be
    // safe to call directly, not only after an authorization check.
    if (outcome.sensitive) throw new Error('Sensitive files are not available to agent tools.')
    const resolved = outcome.resolved

    if (name === 'workspace.list') {
      const entries = await fs.readdir(resolved.path, { withFileTypes: true })
      return { path: resolved.relative, entries: entries.filter((entry) => !isSensitivePath(entry.name)).slice(0, 200).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })) }
    }

    if (name === 'workspace.read') {
      const handle = await fs.open(resolved.path, 'r')
      try {
        const stats = await handle.stat()
        if (stats.isDirectory()) throw new Error('That path is a directory, not a file.')
        if (stats.size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte read limit.`)
        // Unchanged files come from memory: parallel researchers reading the
        // same tree share one disk read, and any write changes the key.
        const cacheKey = `${resolved.path}:${stats.size}:${stats.mtimeMs}`
        const cached = this.readCache.get(cacheKey)
        if (cached !== undefined) return { path: resolved.relative, content: cached, cached: true }
        const content = await handle.readFile({ encoding: 'utf8' })
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte read limit.`)
        this.readCache.set(cacheKey, content)
        if (this.readCache.size > MAX_READ_CACHE_ENTRIES) {
          this.readCache.delete(this.readCache.keys().next().value)
        }
        return { path: resolved.relative, content }
      } finally {
        await handle.close()
      }
    }

    if (name === 'workspace.search') {
      const query = String(resolved.query ?? '').trim()
      if (!query) throw new Error('Search query is required.')
      const results = []
      await walkFiles(resolved.path, this.workspaceRoot, results, query, await readIgnoreRules(this.workspaceRoot))
      return { query, path: resolved.relative, results, clipped: results.length >= MAX_SEARCH_FILES }
    }

    if (name === 'workspace.write') {
      const content = String(input?.content ?? '')
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte write limit.`)
      // Capture what was there first. Without it a write is auditable but not
      // reviewable: you can see that a file changed, not what changed.
      const previous = await snapshotFile(resolved.path)
      await fs.mkdir(path.dirname(resolved.path), { recursive: true })
      await fs.writeFile(resolved.path, content, 'utf8')
      return {
        path: resolved.relative,
        bytes: Buffer.byteLength(content, 'utf8'),
        created: previous === null,
        ...(previous ?? {}),
      }
    }

    if (name === 'shell.exec') {
      if (!this.execution) throw new Error('Execution is disabled: no execution runtime is configured. Commands never run on the host.')
      const relativeCwd = path.relative(this.workspaceRoot, resolved.cwd) || '.'
      // A command's receipt: what the workspace looked like before and after.
      // Shell work used to be invisible to everyone except the model that ran
      // it — reviewers and verifiers can now see which paths a command touched
      // and read the ones that matter.
      const manifestLimit = manifestFileLimit()
      const before = new Map()
      if (manifestLimit > 0) {
        await snapshotManifest(this.workspaceRoot, this.workspaceRoot, before, await readIgnoreRules(this.workspaceRoot), manifestLimit)
      }
      // The argv goes to the container engine as an array: nothing here is
      // interpreted by a shell on either side of the boundary. The run id lets a
      // cancellation stop this command rather than wait for its timeout.
      const result = await this.execution.run(resolved.argv, { cwd: relativeCwd, runId })
      let changedFiles = null
      if (manifestLimit > 0) {
        const after = new Map()
        await snapshotManifest(this.workspaceRoot, this.workspaceRoot, after, await readIgnoreRules(this.workspaceRoot), manifestLimit)
        changedFiles = diffManifests(before, after)
      }
      return { argv: resolved.argv, cwd: relativeCwd, boundary: 'container', stdout: clipped(result.stdout), stderr: clipped(result.stderr), ...(changedFiles ? { changedFiles } : {}) }
    }

    if (name === 'run.ask') {
      // Answered, never executed: the answer endpoint resolves the parked call
      // directly. A run grant that somehow allowed this far still cannot run a
      // question unattended, so it fails here with words the worker can read.
      throw new Error('Questions need a human answer: they park for approval in every mode and cannot run unattended.')
    }

    if (name === 'http.request') {
      let method = String(resolved.method ?? 'GET').toUpperCase()
      let requestHeaders = input?.headers && typeof input.headers === 'object' ? { ...input.headers } : {}
      let body = input?.body === undefined ? null : JSON.stringify(input.body)
      let currentUrl = resolved.url
      let response = null
      // Redirects are followed manually so every hop is validated and pinned on
      // its own. Following automatically would let an allowed host bounce the
      // request to a private address the first check already refused — and
      // would forward credential headers and bodies wherever it points.
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        response = await pinnedRequest(currentUrl, { method, headers: requestHeaders, body, allowedHosts: this.httpAllowlist ?? configuredHttpAllowlist() })
        if (hop === MAX_REDIRECTS && [301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
          throw new Error('Too many redirects.')
        }
        const next = redirectHop({ method, headers: requestHeaders, body, currentUrl, status: response.status, location: response.headers.location })
        if (!next) break
        ;({ method, headers: requestHeaders, body, url: currentUrl } = next)
      }
      return {
        status: response.status,
        ok: response.ok,
        url: currentUrl,
        bytes: response.bytes,
        headers: response.headers,
        body: clipped(response.text),
        ...(response.truncated ? { truncated: true, note: 'The response was larger than the byte cap and was cut off rather than buffered.' } : {}),
      }
    }

    throw new Error(`Unknown tool: ${name}`)
  }

  redact(value) {
    return redact(value)
  }

  /**
   * What is in the workspace, as the tools see it.
   *
   * The same rules as a search apply — skipped directories, credential files, and
   * anything `.fulkrumignore` names, with links reported rather than followed — so
   * this view cannot show a file a tool would refuse to read, or hide one it would
   * happily return.
   */
  async listTree(relativePath = '.', { depth = 2, limit = 500 } = {}) {
    const target = resolveWorkspacePath(this.workspaceRoot, relativePath)
    const rules = await readIgnoreRules(this.workspaceRoot)

    const walk = async (directory, remaining) => {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      const nodes = []
      for (const entry of entries.slice(0, limit)) {
        const absolute = path.join(directory, entry.name)
        const relative = path.relative(this.workspaceRoot, absolute).replaceAll('\\', '/')
        if (skippedDirectories.has(entry.name) || isIgnored(relative, rules)) {
          nodes.push({ name: entry.name, path: relative, kind: 'skipped' })
          continue
        }
        if (entry.isDirectory()) {
          // A junction or symlink is reported, never descended into: on Windows a
          // plain listing says it is an ordinary directory.
          const stats = await fs.lstat(absolute).catch(() => null)
          if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
            nodes.push({ name: entry.name, path: relative, kind: 'link' })
            continue
          }
          const node = { name: entry.name, path: relative, kind: 'directory' }
          if (remaining > 1) node.children = await walk(absolute, remaining - 1)
          nodes.push(node)
          continue
        }
        if (isSensitivePath(entry.name)) {
          nodes.push({ name: entry.name, path: relative, kind: 'sensitive' })
          continue
        }
        const stats = await fs.stat(absolute).catch(() => null)
        nodes.push({ name: entry.name, path: relative, kind: 'file', bytes: stats?.size ?? null })
      }
      return nodes.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : right.kind === 'directory' ? 1 : 0
        return left.name.localeCompare(right.name)
      })
    }

    return { path: target.relative, depth: Math.min(Math.max(Number(depth) || 1, 1), 4), entries: await walk(target.resolved, Math.min(Math.max(Number(depth) || 1, 1), 4)) }
  }

  /**
   * The input as it may be stored or shown: values under sensitive-looking keys
   * are replaced, and an HTTP request's header values become hashes. The log then
   * records that a header was sent and what it hashed to, without keeping the
   * value; the original arguments are stored separately so the call can still run.
   */
  sanitizeInput(name, input) {
    const safe = redact(input)
    if (name === 'http.request' && safe && typeof safe === 'object' && safe.headers && typeof safe.headers === 'object') {
      return { ...safe, headers: hashHeaderValues(input.headers) }
    }
    return safe
  }
}
