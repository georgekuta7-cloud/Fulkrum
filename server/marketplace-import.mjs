import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseAgencyAgent } from './agencyAgents.mjs'

/**
 * Internet imports: turn unsigned public skills into installable catalog
 * entries without weakening the signed-index path.
 *
 * The trust story, honestly told: the signed index (`marketplace.mjs`) is
 * authenticated by ed25519 — the registry vouches for those entries. Imports
 * from ClawHub, SkillHub, GitHub, or a bare URL are authenticated by nothing
 * but their provenance, a sha256 pin, a heuristic scan, and the human who
 * clicks Install. They live in a separate local catalog, tagged
 * trust:'community', and install through the same hash-pinned bytes the
 * signed entries use — a byte that differs refuses either way.
 *
 * What this module never does: execute anything, grant anything, or install
 * anything. Import stages a candidate; the POST install route is the approval.
 */

const MAX_PACK_BYTES = 256_000
const MAX_CATALOG_BYTES = 512_000

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Frontmatter, strict edition. Flat `key: value` pairs plus one nested level
 * under `metadata:` (where registries put version/author/requires). Anything
 * deeper is kept as raw text — we read version out of it with a regex rather
 * than growing a YAML parser for a trust boundary.
 */
export function parseImportFrontmatter(text) {
  const body = String(text ?? '')
  if (!body.startsWith('---\n') && !body.startsWith('---\r\n')) return { fields: {}, meta: {}, content: body, closed: false }
  const lines = body.split(/\r?\n/)
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (closing < 0) return { fields: {}, meta: {}, content: body, closed: false }
  const fields = {}
  const meta = {}
  let inMeta = false
  for (const line of lines.slice(1, closing)) {
    if (/^\s*#/.test(line) || !line.trim()) continue
    const indented = /^\s+/.test(line)
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (!indented && key === 'metadata') {
      inMeta = true
      continue
    }
    if (inMeta && indented) {
      meta[key] = value
      continue
    }
    inMeta = false
    if (!indented) fields[key] = value
  }
  return { fields, meta, content: lines.slice(closing + 1).join('\n').trim(), closed: true }
}

const unquote = (value) => String(value ?? '').replace(/^['"]|['"]$/g, '').trim()

/** Strict per the Agent Skills spec: naming, lengths, required fields. */
export function validateSkillPack(text) {
  const problems = []
  if (!text || !String(text).trim()) return { ok: false, problems: ['the skill pack is empty'] }
  if (Buffer.byteLength(String(text), 'utf8') > MAX_PACK_BYTES) {
    return { ok: false, problems: ['the skill pack exceeds 256 kB'] }
  }
  const { fields, meta, content, closed } = parseImportFrontmatter(text)
  if (!closed) problems.push('SKILL.md must start with YAML frontmatter between --- lines')
  const name = unquote(fields.name ?? '')
  if (!name) problems.push('frontmatter needs a name')
  else if (name.length > 64) problems.push('name must be 64 characters or fewer')
  else if (!SKILL_NAME_PATTERN.test(name)) {
    problems.push('name must be lowercase alphanumerics and hyphens, not starting, ending, or doubling them')
  }
  const description = unquote(fields.description ?? '')
  if (!description) problems.push('frontmatter needs a description')
  else if (description.length > 1024) problems.push('description must be 1024 characters or fewer')
  const compatibility = unquote(fields.compatibility ?? '')
  if (compatibility && compatibility.length > 500) problems.push('compatibility must be 500 characters or fewer')
  if (problems.length) return { ok: false, problems }
  const version = unquote(meta.version ?? meta['openclaw.version'] ?? '') || '1.0.0'
  return {
    ok: true,
    skill: {
      name,
      description: description.slice(0, 500),
      license: unquote(fields.license ?? '').slice(0, 80),
      compatibility: compatibility.slice(0, 200),
      allowedTools: unquote(fields['allowed-tools'] ?? '').slice(0, 300),
      author: unquote(meta.author ?? '').slice(0, 120),
      version: version.slice(0, 40),
      contentLength: content.length,
    },
  }
}

/** @type {Array<[RegExp, string]>} */
const HIGH_RISK = [
  [/ignore\s+(all\s+)?(previous|prior|earlier)\s+instructions/i, 'prompt-injection directive: tells the agent to ignore its instructions'],
  [/exfiltrat/i, 'mentions exfiltration'],
  [/(send|post|upload|transmit).{0,40}(secret|private.?key|password|token)/i, 'sends secrets somewhere'],
  [/curl.{0,80}\$\{?[A-Z_]+(_KEY|_TOKEN|_SECRET)/, 'pipes a credential into a network call'],
  [/-----BEGIN .*PRIVATE KEY-----/, 'bundles a private key'],
  [/[A-Za-z0-9+/]{200,}={0,2}.*(exec|eval|curl|sh\s+-c|powershell)/is, 'obfuscated blob next to execution'],
]

/** @type {Array<[RegExp, string]>} */
const MEDIUM_SIGNALS = [
  [/\bcurl\b|\bwget\b|fetch\(['"]https?:/i, 'reaches the network'],
  [/\$\{?[A-Z][A-Z0-9_]+\}?/, 'reads environment variables'],
  [/^#![^\n]*\n/m, 'ships executable scripts'],
  [/(api[_-]?key|bearer\s|authorization\s*:)/i, 'handles credentials'],
]

/**
 * Best-effort scan, and labeled as such. The real guards are the hash pin and
 * the human approval; this exists so the approval UI can show *why* a skill
 * deserves a second look instead of a cheerful Install button. Heuristics
 * over-block and under-catch — a clean scan is not a clean bill of health.
 */
export function scanSkillPack(text) {
  const body = String(text ?? '')
  const findings = []
  for (const [pattern, label] of HIGH_RISK) {
    if (pattern.test(body)) findings.push({ severity: 'high', signal: label })
  }
  for (const [pattern, label] of MEDIUM_SIGNALS) {
    if (pattern.test(body)) findings.push({ severity: 'medium', signal: label })
  }
  return findings
}

export const importBlocked = (findings) => (findings ?? []).some((finding) => finding.severity === 'high')

const sha256Hex = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

/**
 * Stage validated bytes as a community catalog draft. Throws when invalid or
 * high-risk — the caller turns that into a 400/422 with the reasons attached,
 * never into a silent skip.
 */
export function draftCommunitySkill(text, { source }) {
  const validation = validateSkillPack(text)
  if (!validation.ok) {
    throw new Error(`Unusable skill pack: ${validation.problems.join('; ')}`)
  }
  const findings = scanSkillPack(text)
  if (importBlocked(findings)) {
    throw new Error(`Refused: ${findings.filter((finding) => finding.severity === 'high').map((finding) => finding.signal).join('; ')}`)
  }
  const { skill } = validation
  return {
    kind: 'skill',
    id: skill.name,
    version: skill.version,
    sha256: sha256Hex(text),
    url: null,
    description: skill.description,
    trust: 'community',
    license: skill.license,
    compatibility: skill.compatibility,
    allowedTools: skill.allowedTools,
    author: skill.author,
    findings,
    provenance: { source: String(source ?? 'import'), fetchedAt: Date.now() },
    // Staged bytes stay with the draft until install pins them into skills/.
    // The catalog is local data, never a trust root — the pin is the root.
    staged: String(text),
  }
}

/** Reject URLs that resolve to loopback, link-local, or private ranges. */
function assertPublicUrl(parsed) {
  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0') {
    throw new Error('Imports cannot target loopback addresses.')
  }
  if (/^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    throw new Error('Imports cannot target private or link-local addresses.')
  }
}

/**
 * @param {string} url
 * @param {{ fetchImpl?: (input: any, init?: any) => Promise<any> }} [options]
 */
async function downloadBounded(url, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(String(url), { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download answered ${response.status}.`)
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_PACK_BYTES) throw new Error('Download exceeds 256 kB.')
  return text
}

/**
 * Import one SKILL.md from a URL (raw GitHub file, gist, direct link).
 * @param {string} url
 * @param {{ fetchImpl?: (input: any, init?: any) => Promise<any> }} [options]
 */
export async function importSkillFromUrl(url, { fetchImpl } = {}) {
  const parsed = new URL(String(url))
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https URLs can be imported.')
  assertPublicUrl(parsed)
  const text = await downloadBounded(parsed.href, { fetchImpl })
  return draftCommunitySkill(text, { source: parsed.href })
}

/**
 * Import a local directory whose root holds SKILL.md (cloned repo, download).
 * Also accepts agency-agents markdown definitions.
 */
export function importSkillFromDirectory(dir) {
  const file = path.join(String(dir), 'SKILL.md')
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    // No SKILL.md — try agency-agents format
    return importAgencyAgentsFromDirectory(dir)
  }
  if (size > MAX_PACK_BYTES) throw new Error('The skill pack exceeds 256 kB.')
  const text = readFileSync(file, 'utf8')
  return draftCommunitySkill(text, { source: `local:${path.resolve(String(dir))}` })
}

/** Import agency-agents markdown definitions from a directory. */
function importAgencyAgentsFromDirectory(dir) {
  const entries = readdirSync(String(dir), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md'))
  if (!entries.length) throw new Error('No SKILL.md or agency-agents markdown at the directory root.')
  const entry = entries[0]
  const text = readFileSync(path.join(String(dir), entry.name), 'utf8')
  const parsed = parseAgencyAgent(text, { source: `agency-agents:${entry.name}` })
  if (!parsed.ok) throw new Error(`Unusable agency agent: ${parsed.problems?.join('; ') ?? 'invalid'}`)
  return draftCommunitySkill(text, { source: `agency-agents:${path.resolve(String(dir))}` })
}

/**
 * Fetch a public registry listing and normalize it tolerantly: ClawHub,
 * SkillHub, and mirrors all shape this differently ({skills}, {entries},
 * {results}, bare arrays; name/slug, download_url/url, stars/downloads).
 * Unknown shapes throw rather than guessing — a catalog built on misread
 * fields would point installs at wrong bytes.
 * @param {string} registryUrl
 * @param {{ fetchImpl?: (input: any, init?: any) => Promise<any> }} [options]
 */
export async function fetchRegistryCatalog(registryUrl, { fetchImpl = globalThis.fetch } = {}) {
  const parsedRegistry = new URL(String(registryUrl))
  if (!['http:', 'https:'].includes(parsedRegistry.protocol)) throw new Error('Only http and https registry URLs are supported.')
  assertPublicUrl(parsedRegistry)
  const response = await fetchImpl(String(registryUrl), { redirect: 'follow' })
  if (!response.ok) throw new Error(`The registry answered ${response.status}.`)
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_CATALOG_BYTES) throw new Error('The registry listing exceeds 512 kB.')
  let document = null
  try {
    document = JSON.parse(text)
  } catch {
    throw new Error('The registry listing is not valid JSON.')
  }
  const rawList = Array.isArray(document)
    ? document
    : Array.isArray(document?.skills) ? document.skills
      : Array.isArray(document?.entries) ? document.entries
        : Array.isArray(document?.results) ? document.results
          : Array.isArray(document?.data) ? document.data
            : null
  if (!rawList) throw new Error('The registry shape is not recognized: expected an array or {skills|entries|results|data}.')
  const candidates = []
  const skipped = []
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') {
      skipped.push('non-object row')
      continue
    }
    const id = unquote(raw.name ?? raw.slug ?? raw.id ?? '').toLowerCase()
    if (!SKILL_NAME_PATTERN.test(id)) {
      skipped.push(`bad id: ${String(raw.name ?? raw.slug ?? raw.id ?? '?').slice(0, 40)}`)
      continue
    }
    const url = raw.download_url ?? raw.url ?? raw.skill_url ?? raw.repo_url ?? null
    let usableUrl = null
    if (typeof url === 'string' && url.trim()) {
      try {
        const parsed = new URL(url.trim())
        if (['http:', 'https:'].includes(parsed.protocol)) usableUrl = parsed.href
      } catch {
        usableUrl = null
      }
    }
    candidates.push({
      kind: 'skill',
      id,
      version: String(raw.version ?? '1.0.0').slice(0, 40),
      description: String(raw.description ?? '').trim().slice(0, 500),
      url: usableUrl,
      trust: 'community',
      author: String(raw.author ?? raw.owner ?? '').slice(0, 120),
      signals: {
        downloads: Number(raw.downloads ?? raw.installs ?? 0) || 0,
        stars: Number(raw.stars ?? raw.stargazers_count ?? 0) || 0,
      },
      provenance: { source: String(registryUrl), fetchedAt: Date.now() },
    })
  }
  return { candidates, skipped, fetchedAt: Date.now() }
}

export function localCatalogFile() {
  const dir = String(process.env.FULKRUM_DATA_DIR ?? 'data')
  return path.resolve(dir, 'marketplace-local.json')
}

export function readLocalCatalog(catalogFile = localCatalogFile()) {
  try {
    const parsed = JSON.parse(readFileSync(catalogFile, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return { entries: [] }
    return { entries: parsed.entries.filter((entry) => entry && typeof entry === 'object') }
  } catch {
    return { entries: [] }
  }
}

/**
 * Upsert a staged draft: same id replaces, so re-importing after a registry
 * update stages the new bytes (which still need a fresh install approval —
 * staged bytes are never live).
 */
export function stageCommunityEntry(draft, catalogFile = localCatalogFile()) {
  if (!draft || typeof draft !== 'object' || !SKILL_NAME_PATTERN.test(String(draft.id ?? ''))) {
    throw new Error('Only validated skill drafts can be staged.')
  }
  const { entries } = readLocalCatalog(catalogFile)
  const next = entries.filter((entry) => entry.id !== draft.id)
  next.push(draft)
  mkdirSync(path.dirname(catalogFile), { recursive: true })
  writeFileSync(catalogFile, JSON.stringify({ entries: next, updatedAt: Date.now() }))
  return draft
}

/**
 * First-boot seed: stage the builtin packs so the store opens non-empty.
 * Runs only when the local catalog has no entries, never overwrites, never
 * throws — a seed failure is a log line, not a boot failure. Set
 * FULKRUM_MARKETPLACE_SEED_DIR=off to skip.
 * @param {{ seedDir?: string }} [options]
 */
export function seedBuiltinCatalog({ seedDir } = {}) {
  const configured = seedDir ?? process.env.FULKRUM_MARKETPLACE_SEED_DIR ?? ''
  if (String(configured).toLowerCase() === 'off') return { seeded: [], skipped: 'disabled' }
  const root = String(configured) || path.resolve('marketplace-seed')
  if (readLocalCatalog().entries.length > 0) return { seeded: [], skipped: 'catalog not empty' }
  let folders = []
  try {
    folders = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return { seeded: [], skipped: 'no seed directory' }
  }
  const seeded = []
  for (const folder of folders) {
    try {
      const draft = importSkillFromDirectory(path.join(root, folder))
      stageCommunityEntry({ ...draft, provenance: { source: `builtin:${draft.id}`, fetchedAt: Date.now() } })
      seeded.push(draft.id)
    } catch {
      // One bad seed pack must not poison the rest; the import route reports
      // the reason when a human retries it deliberately.
    }
  }
  return { seeded, skipped: null }
}
export function mergeCatalogs(signedEntries = [], communityEntries = []) {
  const seen = new Set()
  const merged = []
  for (const entry of [...(signedEntries ?? []), ...(communityEntries ?? [])]) {
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    merged.push({ ...entry, trust: entry.trust ?? 'verified' })
  }
  return merged
}
