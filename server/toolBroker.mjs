import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { configuredHttpAllowlist, validateOutboundUrl } from './networkPolicy.mjs'
import { decidePermission, fingerprintToolCall, isSensitivePath, resolveWorkspacePath, resolveToolCall } from './permissions.mjs'
import { redact } from './redaction.mjs'

const execFile = promisify(execFileCallback)
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
  { name: 'shell.exec', kind: 'shell', description: 'Run a read-only inspection through the container runtime.' },
  { name: 'http.request', kind: 'http', description: 'Call an HTTP or HTTPS endpoint.' },
]

// git is the only binary this broker will run, and only for read-only
// inspection. The subcommand is checked, then every flag must match an explicit
// allowlist: an allowlist that only checks the first argument lets
// --no-index read any file, -c/--config-env set arbitrary config for one
// invocation, and repo-defined textconv or hook helpers run code.
const gitSubcommands = new Set(['status', 'diff', 'log'])
const gitFlagAllowlist = [
  /^--short$/,
  /^--porcelain(?:=v\d)?$/,
  /^--stat$/,
  /^--oneline$/,
  /^--no-color$/,
  /^--color=(?:never|auto)$/,
  /^--name-only$/,
  /^--name-status$/,
  /^--no-renames$/,
  /^--max-count=\d{1,4}$/,
  /^-n\d{1,4}$/,
  /^--since=[\w:. +-]{1,40}$/,
  /^--until=[\w:. +-]{1,40}$/,
  /^--author=[\w@. +-]{1,60}$/,
  /^--grep=[\w .+*?^$[\]()-]{1,60}$/,
  /^--patch$/,
  /^-p$/,
  /^--no-patch$/,
  /^-s$/,
  /^--unified=\d{1,3}$/,
  /^-U\d{1,3}$/,
  /^--follow$/,
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

/** Config, pager, and hooks are the documented ways a git invocation runs code. */
function gitEnvironment(workspaceRoot) {
  const configHome = path.join(os.tmpdir(), 'fulkrum-git-config')
  return {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(configHome, 'global.gitconfig'),
      GIT_CONFIG_SYSTEM: path.join(configHome, 'system.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_PAGER: 'cat',
      GIT_EXTERNAL_DIFF: '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CEILING_DIRECTORIES: workspaceRoot,
      // A repo cannot supply hooks, and cannot follow symlinks out of the tree.
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: path.join(configHome, 'no-hooks'),
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'false',
    },
  }
}

export function validateGitArgv({ argv, workspaceRoot }) {
  const [command, ...args] = argv
  if (path.basename(String(command ?? '')).toLowerCase() !== 'git') {
    throw new Error('Only read-only git commands are available through the shell tool.')
  }
  const [subcommand, ...rest] = args
  if (!gitSubcommands.has(String(subcommand ?? ''))) {
    throw new Error('Only git status, diff, and log are allowlisted.')
  }

  const positional = []
  let afterSeparator = false
  for (const argument of rest) {
    if (afterSeparator) {
      positional.push(argument)
      continue
    }
    if (argument === '--') {
      afterSeparator = true
      continue
    }
    if (argument.startsWith('-')) {
      if (!gitFlagAllowlist.some((pattern) => pattern.test(argument))) {
        throw new Error(`The git flag is not allowlisted: ${argument}`)
      }
      continue
    }
    positional.push(argument)
  }

  // Positional arguments are pathspecs, so they must resolve inside the workspace.
  for (const spec of positional) resolveWorkspacePath(workspaceRoot, spec)

  // --no-textconv and --no-ext-diff are per-subcommand options, so they must
  // follow the subcommand. Together with the neutralized config they are what
  // stops a repo's own diff drivers from running code during a plain `git diff`.
  const safeFlags = subcommand === 'status' ? [] : ['--no-textconv', '--no-ext-diff']
  return { subcommand, argv: ['git', subcommand, ...safeFlags, ...rest] }
}

export class FulkrumToolBroker {
  constructor({ workspaceRoot = process.env.FULKRUM_WORKSPACE_ROOT ?? process.cwd(), httpAllowlist = configuredHttpAllowlist() } = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot)
    this.httpAllowlist = httpAllowlist
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
      const { subcommand, argv } = validateGitArgv({ argv: resolved.argv, workspaceRoot: this.workspaceRoot })
      // The model does not choose how long a process may run.
      const timeout = Math.min(Math.max(Number(process.env.FULKRUM_EXEC_TIMEOUT_MS) || 30_000, 1_000), 120_000)
      const { env } = gitEnvironment(this.workspaceRoot)
      const result = await execFile(argv[0], argv.slice(1), { cwd: resolved.cwd, timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell: false, env, killSignal: 'SIGKILL' })
      return { command: `git ${subcommand}`, cwd: path.relative(this.workspaceRoot, resolved.cwd) || '.', stdout: clipped(result.stdout), stderr: clipped(result.stderr) }
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
