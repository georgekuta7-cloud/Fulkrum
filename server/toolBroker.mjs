import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { configuredHttpAllowlist, validateOutboundUrl } from './networkPolicy.mjs'
import { decidePermission, fingerprintToolCall, isSensitivePath, resolveToolCall, resolveWorkspacePath } from './permissions.mjs'
import { redact } from './redaction.mjs'

const MAX_FILE_BYTES = 500_000
const MAX_SNAPSHOT_BYTES = Number(process.env.FULKRUM_MAX_SNAPSHOT_BYTES ?? 64_000)
const MAX_OUTPUT_BYTES = 100_000
const MAX_SEARCH_FILES = 400
const MAX_REDIRECTS = 3
const skippedDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage', '.cache'])

const toolDefinitions = [
  { name: 'workspace.list', kind: 'read', description: 'List entries inside the approved workspace.' },
  { name: 'workspace.read', kind: 'read', description: 'Read a UTF-8 text file inside the approved workspace.' },
  { name: 'workspace.search', kind: 'read', description: 'Search text files inside the approved workspace.' },
  { name: 'workspace.write', kind: 'write', description: 'Write a UTF-8 text file inside the approved workspace.' },
  { name: 'shell.exec', kind: 'shell', description: 'Run a command inside the sandboxed workspace container.' },
  { name: 'http.request', kind: 'http', description: 'Call an HTTP or HTTPS endpoint.' },
]

function clipped(value, maximum = MAX_OUTPUT_BYTES) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > maximum ? `${text.slice(0, maximum)}\n[output clipped]` : text
}

async function walkFiles(directory, root, results, query) {
  if (results.length >= MAX_SEARCH_FILES) return
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (results.length >= MAX_SEARCH_FILES) return
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue
    if (!entry.isDirectory() && isSensitivePath(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(absolute, root, results, query)
      continue
    }
    try {
      const content = await fs.readFile(absolute, 'utf8')
      if (content.toLowerCase().includes(query.toLowerCase())) {
        const line = content.split(/\r?\n/).findIndex((item) => item.toLowerCase().includes(query.toLowerCase())) + 1
        results.push({ path: path.relative(root, absolute).replaceAll('\\', '/'), line })
      }
    } catch {
      // Binary or unreadable files are skipped by the search tool.
    }
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
      const snapshot = { previousBytes: bytes, previousSha256: null, previousTruncated: bytes > MAX_SNAPSHOT_BYTES }
      if (bytes <= MAX_SNAPSHOT_BYTES) {
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
  constructor({ workspaceRoot = process.env.FULKRUM_WORKSPACE_ROOT ?? process.cwd(), httpAllowlist = configuredHttpAllowlist(), execution = null } = {}) {
    // Normalized once, through the same resolver the tools use, so every path the
    // broker reports is relative to a real root. Otherwise a short-named or
    // symlinked workspace root makes result paths point outside themselves.
    this.workspaceRoot = resolveWorkspacePath(workspaceRoot, '.').resolved
    this.httpAllowlist = httpAllowlist
    this.execution = execution
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
    return decidePermission({ mode, tool, resolution, httpAllowlist: this.httpAllowlist })
  }

  /**
   * Execute a call that has already been resolved and authorized. Paths, argv,
   * and URLs come from the resolution the user approved, never from a fresh
   * parse of the request, so what runs is what was shown.
   */
  async execute(name, input = {}, resolution = null) {
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
        const content = await handle.readFile({ encoding: 'utf8' })
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte read limit.`)
        return { path: resolved.relative, content }
      } finally {
        await handle.close()
      }
    }

    if (name === 'workspace.search') {
      const query = String(resolved.query ?? '').trim()
      if (!query) throw new Error('Search query is required.')
      const results = []
      await walkFiles(resolved.path, this.workspaceRoot, results, query)
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
      // The argv goes to the container engine as an array: nothing here is
      // interpreted by a shell on either side of the boundary.
      const result = await this.execution.run(resolved.argv, { cwd: relativeCwd })
      return { argv: resolved.argv, cwd: relativeCwd, boundary: 'container', stdout: clipped(result.stdout), stderr: clipped(result.stderr) }
    }

    if (name === 'http.request') {
      const method = String(resolved.method ?? 'GET').toUpperCase()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(Number(process.env.FULKRUM_HTTP_TIMEOUT_MS) || 30_000, 1_000), 120_000))
      try {
        let currentUrl = resolved.url
        let response
        // Redirects are followed manually so every hop is re-checked. Following
        // automatically would let an allowed host bounce the request to a private
        // address that the first validation already refused.
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
          await validateOutboundUrl(currentUrl, { allowedHosts: this.httpAllowlist })
          response = await fetch(currentUrl, {
            method,
            headers: input?.headers && typeof input.headers === 'object' ? input.headers : {},
            body: input?.body === undefined ? undefined : JSON.stringify(input.body),
            redirect: 'manual',
            signal: controller.signal,
          })
          const location = response.headers.get('location')
          if (![301, 302, 303, 307, 308].includes(response.status) || !location) break
          if (hop === MAX_REDIRECTS) throw new Error('Too many redirects.')
          currentUrl = new URL(location, currentUrl).href
        }
        const text = await response.text()
        return { status: response.status, ok: response.ok, url: currentUrl, headers: Object.fromEntries(response.headers.entries()), body: clipped(text) }
      } finally {
        clearTimeout(timeout)
      }
    }

    throw new Error(`Unknown tool: ${name}`)
  }

  redact(value) {
    return redact(value)
  }
}
