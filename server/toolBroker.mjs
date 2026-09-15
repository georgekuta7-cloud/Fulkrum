import { execFile as execFileCallback } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { configuredHttpAllowlist, validateOutboundUrl } from './networkPolicy.mjs'

const execFile = promisify(execFileCallback)
const MAX_FILE_BYTES = 500_000
const MAX_OUTPUT_BYTES = 100_000
const MAX_SEARCH_FILES = 400
const skippedDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage', '.cache'])
const sensitiveFilePattern = /^(\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|sqlite(?:-shm|-wal)?|db)|id_rsa(?:\.pub)?|credentials(?:\..*)?)$/i

const toolDefinitions = [
  { name: 'workspace.list', kind: 'read', description: 'List entries inside the approved workspace.' },
  { name: 'workspace.read', kind: 'read', description: 'Read a UTF-8 text file inside the approved workspace.' },
  { name: 'workspace.search', kind: 'read', description: 'Search text files inside the approved workspace.' },
  { name: 'workspace.write', kind: 'write', description: 'Write a UTF-8 text file inside the approved workspace.' },
  { name: 'shell.exec', kind: 'shell', description: 'Run an allowlisted local command in the approved workspace.' },
  { name: 'http.request', kind: 'http', description: 'Call an HTTP or HTTPS endpoint.' },
]

function clipped(value, maximum = MAX_OUTPUT_BYTES) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > maximum ? `${text.slice(0, maximum)}\n[output clipped]` : text
}

function safeRelative(root, candidate) {
  const resolved = path.resolve(root, String(candidate ?? '.'))
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path must stay inside the Fulkrum workspace.')
  return { resolved, relative: relative || '.' }
}

function isSensitivePath(relativePath) {
  return relativePath.split(/[\\/]/).some((segment) => sensitiveFilePattern.test(segment))
}

function safeWorkspacePath(root, candidate) {
  const target = safeRelative(root, candidate)
  if (isSensitivePath(target.relative)) throw new Error('Sensitive files are not available to agent tools.')
  return target
}

async function walkFiles(directory, root, results, query) {
  if (results.length >= MAX_SEARCH_FILES) return
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (results.length >= MAX_SEARCH_FILES) return
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue
    if (!entry.isDirectory() && sensitiveFilePattern.test(entry.name)) continue
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

function redact(value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redact)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => /key|token|secret|authorization|password/i.test(key) ? [key, '[redacted]'] : [key, redact(item)]))
}

export class FulkrumToolBroker {
  constructor({ workspaceRoot = process.env.FULKRUM_WORKSPACE_ROOT ?? process.cwd() } = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot)
  }

  list() {
    return toolDefinitions.map((tool) => ({ ...tool }))
  }

  get(name) {
    return toolDefinitions.find((tool) => tool.name === name) ?? null
  }

  authorize(permissionMode, tool) {
    if (!tool) return { allowed: false, requiresApproval: false, reason: 'Unknown tool.' }
    if (tool.kind === 'read') return { allowed: true, requiresApproval: false, reason: 'Read-only tool.' }
    if (tool.kind === 'http' && permissionMode === 'autopilot' && configuredHttpAllowlist().length === 0) return { allowed: false, requiresApproval: true, reason: 'Autopilot HTTP requests require FULKRUM_HTTP_ALLOWLIST.' }
    if (permissionMode === 'autopilot') return { allowed: true, requiresApproval: false, reason: 'Autopilot policy.' }
    return { allowed: false, requiresApproval: true, reason: `${tool.kind} actions require approval in ${permissionMode} mode.` }
  }

  async execute(name, input = {}) {
    if (name === 'workspace.list') {
      const target = safeWorkspacePath(this.workspaceRoot, input.path)
      const entries = await fs.readdir(target.resolved, { withFileTypes: true })
      return { path: target.relative, entries: entries.filter((entry) => !sensitiveFilePattern.test(entry.name)).slice(0, 200).map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })) }
    }

    if (name === 'workspace.read') {
      const target = safeWorkspacePath(this.workspaceRoot, input.path)
      const content = await fs.readFile(target.resolved, 'utf8')
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte read limit.`)
      return { path: target.relative, content }
    }

    if (name === 'workspace.search') {
      const query = String(input.query ?? '').trim()
      if (!query) throw new Error('Search query is required.')
      const target = safeWorkspacePath(this.workspaceRoot, input.path)
      const results = []
      await walkFiles(target.resolved, this.workspaceRoot, results, query)
      return { query, path: target.relative, results, clipped: results.length >= MAX_SEARCH_FILES }
    }

    if (name === 'workspace.write') {
      const target = safeWorkspacePath(this.workspaceRoot, input.path)
      const content = String(input.content ?? '')
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte write limit.`)
      await fs.mkdir(path.dirname(target.resolved), { recursive: true })
      await fs.writeFile(target.resolved, content, 'utf8')
      return { path: target.relative, bytes: Buffer.byteLength(content, 'utf8') }
    }

    if (name === 'shell.exec') {
      const command = String(input.command ?? '').trim()
      const commandName = path.basename(command).toLowerCase()
      if (commandName !== 'git') throw new Error('Only read-only git commands are available through the shell tool.')
      const args = Array.isArray(input.args) ? input.args.map(String) : []
      if (!['status', 'diff', 'log'].includes(args[0]) || args.some((arg) => arg === '-c' || arg.startsWith('--config'))) throw new Error('Only git status, diff, and log are allowlisted.')
      const target = safeWorkspacePath(this.workspaceRoot, input.cwd)
      const timeout = Math.min(Math.max(Number(input.timeoutMs) || 30_000, 1_000), 120_000)
      const result = await execFile(command, args, { cwd: target.resolved, timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell: false })
      return { command: commandName, cwd: target.relative, stdout: clipped(result.stdout), stderr: clipped(result.stderr) }
    }

    if (name === 'http.request') {
      const requestUrl = await validateOutboundUrl(input.url, { allowedHosts: configuredHttpAllowlist() })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(Number(input.timeoutMs) || 30_000, 1_000), 120_000))
      try {
        const response = await fetch(requestUrl, { method: String(input.method ?? 'GET').toUpperCase(), headers: input.headers && typeof input.headers === 'object' ? input.headers : {}, body: input.body === undefined ? undefined : JSON.stringify(input.body), signal: controller.signal })
        const text = await response.text()
        return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers.entries()), body: clipped(text) }
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
