import { createHash, verify } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { canonicalJson } from './canonicalJson.mjs'
import { validatePluginManifest } from './plugins.mjs'

/**
 * The marketplace: a signed index of skills and plugin manifests, plus the
 * install machinery. Trust root is the signature, not the transport — bytes
 * fetched over plain HTTPS are verified against the pinned ed25519 key before
 * anything is believed, so even a hostile mirror cannot forge an entry.
 *
 * Nothing here executes. Install writes files a human approved (the POST is
 * the approval); plugins execute only through the Wave 1.6 path with the
 * matrix watching. Updates are new versions with new hashes, which need new
 * approvals; uninstall deletes the files and revokes any standing grants
 * scoped to that plugin's tools.
 */

const MAX_INDEX_BYTES = 512_000
const MAX_DOWNLOAD_BYTES = 256_000
const MAX_REDIRECTS = 3

const ENTRY_ID_PATTERN = /^[a-z0-9]+([.-][a-z0-9]+)*$/

/**
 * Entry ids become directory and file names. Anything that is not exactly
 * this pattern is refused before it touches path.join — a traversal id must
 * never reach a recursive rm, no matter which route or caller supplied it.
 */
export function assertEntryId(id) {
  if (!ENTRY_ID_PATTERN.test(String(id ?? ''))) throw new Error(`Unknown marketplace entry: ${id}`)
}

export function marketplaceConfig() {
  return {
    url: String(process.env.FULKRUM_MARKETPLACE_URL ?? '').trim(),
    publicKey: String(process.env.FULKRUM_MARKETPLACE_KEY ?? '').trim(),
  }
}

export function marketplaceEnabled() {
  const { url, publicKey } = marketplaceConfig()
  return Boolean(url && publicKey)
}

export function marketplaceCacheFile() {
  // Resolved against cwd like FULKRUM_DATA_DIR itself: callers that run
  // somewhere else pass an explicit cacheFile instead of relying on this.
  const dir = String(process.env.FULKRUM_DATA_DIR ?? 'data')
  return path.resolve(dir, 'marketplace.json')
}

/** Verify a canonical index body against a base64 DER SPKI ed25519 key. */
export function verifyIndexSignature(canonicalBody, signatureB64, publicKeyB64) {
  try {
    const publicKey = Buffer.from(String(publicKeyB64), 'base64')
    const signature = Buffer.from(String(signatureB64), 'base64')
    if (publicKey.length === 0 || signature.length === 0) return false
    // One-shot form: the streaming Verify object does not serve ed25519.
    return verify(null, Buffer.from(String(canonicalBody), 'utf8'), { key: publicKey, format: 'der', type: 'spki' }, signature)
  } catch {
    return false
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** An index entry, validated strictly: the index is third-party data. */
export function validateIndexEntry(entry) {
  const problems = []
  if (!isPlainObject(entry)) return { ok: false, problems: ['entry must be an object'] }
  if (entry.kind !== 'skill' && entry.kind !== 'plugin') problems.push('kind must be skill or plugin')
  if (!/^[a-z0-9]+([.-][a-z0-9]+)*$/.test(String(entry.id ?? ''))) problems.push('id must be a lowercase dotted name')
  if (typeof entry.version !== 'string' || !entry.version.trim()) problems.push('version must be a non-empty string')
  if (!/^[0-9a-f]{64}$/.test(String(entry.sha256 ?? ''))) problems.push('sha256 must be 64 hex characters')
  try {
    const url = new URL(String(entry.url ?? ''))
    if (!['http:', 'https:'].includes(url.protocol)) problems.push('url must be http or https')
  } catch {
    problems.push('url must be a usable URL')
  }
  if (typeof entry.description !== 'string' || !entry.description.trim()) problems.push('description must be a non-empty string')
  if (problems.length) return { ok: false, problems }
  return {
    ok: true,
    entry: {
      kind: entry.kind,
      id: String(entry.id),
      version: String(entry.version).slice(0, 40),
      sha256: String(entry.sha256).toLowerCase(),
      url: String(entry.url),
      description: String(entry.description).trim().slice(0, 500),
    },
  }
}

/**
 * Fetch, verify, and validate an index. Throws on anything untrustworthy.
 * @param {{ url?: string, publicKey?: string, fetchImpl?: (input: any, init?: any) => Promise<any> }} [options]
 */
export async function fetchMarketplaceIndex({ url, publicKey, fetchImpl = globalThis.fetch } = {}) {
  const endpoint = url ?? marketplaceConfig().url
  const key = publicKey ?? marketplaceConfig().publicKey
  if (!endpoint || !key) throw new Error('The marketplace is not configured: set FULKRUM_MARKETPLACE_URL and FULKRUM_MARKETPLACE_KEY.')
  const response = await fetchImpl(endpoint, { redirect: 'manual' })
  const text = await response.text()
  if (!response.ok) throw new Error(`The marketplace answered ${response.status}.`)
  if (Buffer.byteLength(text, 'utf8') > MAX_INDEX_BYTES) throw new Error('The marketplace index is larger than 512 kB.')
  let document = null
  try {
    document = JSON.parse(text)
  } catch {
    throw new Error('The marketplace index is not valid JSON.')
  }
  if (!isPlainObject(document) || !Array.isArray(document.entries) || typeof document.signature !== 'string') {
    throw new Error('The marketplace index is malformed.')
  }
  const { signature, ...unsigned } = document
  if (!verifyIndexSignature(canonicalJson(unsigned), signature, key)) {
    throw new Error('The marketplace signature does not verify: nothing in it is trusted.')
  }
  const entries = []
  const problems = []
  for (const raw of document.entries) {
    const validation = validateIndexEntry(raw)
    if (validation.ok) entries.push(validation.entry)
    else problems.push(`entry ${raw?.id ?? '?'}: ${validation.problems.join('; ')}`)
  }
  return { entries, problems, fetchedAt: Date.now() }
}

export function readMarketplaceCache(cacheFile = marketplaceCacheFile()) {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (!isPlainObject(parsed) || !Array.isArray(parsed.entries)) return null
    return { entries: parsed.entries, fetchedAt: Number(parsed.fetchedAt) || 0 }
  } catch {
    return null
  }
}

/**
 * @param {{ cacheFile?: string, fetchImpl?: (input: any, init?: any) => Promise<any> }} [options]
 */
export async function refreshMarketplace({ cacheFile = marketplaceCacheFile(), fetchImpl } = {}) {
  const fresh = await fetchMarketplaceIndex({ fetchImpl })
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify({ entries: fresh.entries, fetchedAt: fresh.fetchedAt }))
  } catch {
    // A cache write failing must not fail the refresh the caller already has.
  }
  return fresh
}

/**
 * @param {string} url
 * @param {{ fetchImpl?: (input: any, init?: any) => Promise<any> }} [options]
 */
async function downloadBounded(url, { fetchImpl = globalThis.fetch } = {}) {
  let current = String(url)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current, { redirect: 'manual' })
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
      current = new URL(response.headers.get('location'), current).href
      continue
    }
    if (!response.ok) throw new Error(`Download answered ${response.status}.`)
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_DOWNLOAD_BYTES) throw new Error('Download exceeds 256 kB.')
    return text
  }
  throw new Error('Too many redirects.')
}

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Install one index entry into the workspace arsenal. The hash pins what was
 * reviewed: a byte that differs refuses rather than installs. Skills land as
 * SKILL.md packs, plugins as manifests re-validated through the same gate as
 * hand-written ones — installation never invents trust the validator would
 * refuse. Returns what was installed plus the permission footprint, so the UI
 * can show the diff the POST already approved.
 */
/**
 * @param {{ workspaceRoot: string, entry: any, fetchImpl?: (input: any, init?: any) => Promise<any> }} options
 */
export async function installMarketplaceEntry({ workspaceRoot, entry, fetchImpl }) {
  const skillsRoot = path.join(workspaceRoot, 'skills')
  const pluginsRoot = path.join(workspaceRoot, 'plugins')
  // Community imports arrive with their reviewed bytes already staged (no URL
  // to download from); the pin check below treats both paths identically —
  // staged or downloaded, a byte that differs refuses.
  const text = typeof entry.url === 'string' && entry.url
    ? await downloadBounded(entry.url, { fetchImpl })
    : String(entry.staged ?? '')
  if (!text.trim()) throw new Error(`Nothing to install for ${entry.id}: no staged bytes and no download URL.`)
  if (sha256Hex(text) !== entry.sha256) {
    throw new Error(`Checksum mismatch for ${entry.id} v${entry.version}: the bytes are not what the index signed.`)
  }
  if (entry.kind === 'skill') {
    if (!text.trim()) throw new Error('The skill pack is empty.')
    mkdirSync(path.join(skillsRoot, entry.id), { recursive: true })
    writeFileSync(path.join(skillsRoot, entry.id, 'SKILL.md'), text)
    return { installed: { kind: 'skill', id: entry.id, version: entry.version }, permissions: { tools: [], hosts: [] } }
  }
  let manifest = null
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new Error('The plugin manifest is not valid JSON.')
  }
  const validation = validatePluginManifest(entry.id, manifest)
  if (!validation.ok) throw new Error(`The plugin manifest is unusable: ${validation.problems.join('; ')}`)
  mkdirSync(pluginsRoot, { recursive: true })
  // The verified bytes, verbatim — not re-serialized. What is on disk must
  // hash to what the index signed, or update detection (and honesty) breaks.
  writeFileSync(path.join(pluginsRoot, `${entry.id}.json`), text)
  const plugin = validation.plugin
  return {
    installed: { kind: 'plugin', id: entry.id, version: entry.version, tool: plugin.toolName },
    permissions: { tools: [plugin.toolName], hosts: [new URL(plugin.url).hostname.toLowerCase()], method: plugin.method },
  }
}

/**
 * Verify skill pins against installed bytes: every pin names a skill whose
 * current content hashes to the pinned value. Returns the drifted ids —
 * empty means the knowledge is exactly what was approved.
 */
export function verifySkillPins({ workspaceRoot, pins = [] }) {
  const drifted = []
  for (const pin of pins ?? []) {
    if (!pin || typeof pin.id !== 'string' || typeof pin.sha256 !== 'string') {
      drifted.push(pin?.id ?? '?')
      continue
    }
    let text = null
    try {
      text = readFileSync(path.join(workspaceRoot, 'skills', pin.id, 'SKILL.md'), 'utf8')
    } catch {
      text = null
    }
    if (!text || sha256Hex(text) !== pin.sha256.toLowerCase()) drifted.push(pin.id)
  }
  return drifted
}

/**
 * Uninstall by id: files go, and standing grants scoped to its tools die with it.
 * @param {{ workspaceRoot: string, store: any, id: string }} options
 */
export function uninstallMarketplaceEntry({ workspaceRoot, store, id }) {
  assertEntryId(id)
  const skillDir = path.join(workspaceRoot, 'skills', String(id))
  const pluginFile = path.join(workspaceRoot, 'plugins', `${String(id)}.json`)
  rmSync(skillDir, { recursive: true, force: true })
  rmSync(pluginFile, { force: true })
  const revoked = []
  for (const grant of store.listStandingGrants()) {
    if (grant.toolName === `plugin.${id}`) {
      store.revokeStandingGrant(grant.id)
      revoked.push(grant.id)
    }
  }
  return { removed: id, revokedGrants: revoked }
}

/**
 * What is installed locally, joined against the index where it knows more.
 * Versions and update detection come from comparing installed bytes against
 * signed index hashes — a file whose bytes match no index entry is local-only
 * and says so, rather than borrowing a version it never had.
 */
export function listInstalledArsenal({ workspaceRoot, index = [] }) {
  const byId = new Map(index.map((entry) => [entry.id, entry]))
  const skills = []
  const plugins = []
  let skillFolders = []
  try {
    skillFolders = readdirSync(path.join(workspaceRoot, 'skills'), { withFileTypes: true })
  } catch {
    skillFolders = []
  }
  for (const folder of skillFolders) {
    if (!folder.isDirectory()) continue
    let text = null
    try {
      text = readFileSync(path.join(workspaceRoot, 'skills', folder.name, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    if (!text.trim()) continue
    const digest = sha256Hex(text)
    const known = byId.get(folder.name)
    skills.push({
      kind: 'skill',
      id: folder.name,
      version: known && known.sha256 === digest ? known.version : null,
      description: known?.description ?? '',
      updateAvailable: Boolean(known && known.kind === 'skill' && known.sha256 !== digest),
    })
  }
  let pluginFiles = []
  try {
    pluginFiles = readdirSync(path.join(workspaceRoot, 'plugins'), { withFileTypes: true })
  } catch {
    pluginFiles = []
  }
  for (const file of pluginFiles) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue
    const id = file.name.slice(0, -'.json'.length)
    let text = null
    try {
      text = readFileSync(path.join(workspaceRoot, 'plugins', file.name), 'utf8')
    } catch {
      continue
    }
    const digest = sha256Hex(text)
    const known = byId.get(id)
    let manifest = null
    try {
      manifest = JSON.parse(text)
    } catch {
      manifest = null
    }
    plugins.push({
      kind: 'plugin',
      id,
      tool: `plugin.${id}`,
      version: known && known.sha256 === digest ? known.version : null,
      description: known?.description ?? (typeof manifest?.description === 'string' ? manifest.description.slice(0, 200) : ''),
      updateAvailable: Boolean(known && known.kind === 'plugin' && known.sha256 !== digest),
    })
  }
  return { skills, plugins }
}
