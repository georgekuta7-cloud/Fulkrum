import dns from 'node:dns/promises'
import net from 'node:net'

/**
 * Ranges a tool must never reach. Loopback and private space are obvious; the
 * rest are the ranges that reach them indirectly or mean something else entirely
 * — link-local (cloud metadata lives at 169.254.169.254), carrier-grade NAT,
 * benchmarking, documentation, multicast, and reserved space.
 *
 * A CIDR table rather than prefix comparisons: `fe80` was matched as a string,
 * which missed the addresses one bit away, and every range added by hand is one
 * more chance to get the boundary wrong.
 */
const blockedIpv4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

const blockedIpv6 = [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]

function ipv4ToBytes(address) {
  const parts = String(address).split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null
}

/** 16 bytes for an IPv6 address, with an embedded dotted quad folded in. */
export function ipv6ToBytes(address) {
  let value = String(address).toLowerCase()
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)

  const lastColon = value.lastIndexOf(':')
  const tail = value.slice(lastColon + 1)
  if (tail.includes('.')) {
    const quad = ipv4ToBytes(tail)
    if (!quad) return null
    value = `${value.slice(0, lastColon + 1)}${((quad[0] << 8) | quad[1]).toString(16)}:${((quad[2] << 8) | quad[3]).toString(16)}`
  }

  const pieces = value.split('::')
  if (pieces.length > 2) return null
  const head = pieces[0] ? pieces[0].split(':') : []
  const rest = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (missing < 0 || (pieces.length === 1 && missing !== 0)) return null
  const groups = pieces.length === 2 ? [...head, ...Array(missing).fill('0'), ...rest] : head
  if (groups.length !== 8) return null

  const bytes = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    const value16 = Number.parseInt(group, 16)
    bytes.push(value16 >> 8, value16 & 0xff)
  }
  return bytes
}

/** The IPv4 address an IPv4-mapped IPv6 address carries, if that is what it is. */
function mappedIpv4(bytes) {
  const mappedPrefix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]
  return mappedPrefix.every((byte, index) => bytes[index] === byte) ? bytes.slice(12) : null
}

function matchesCidr(bytes, entry) {
  const [network, prefix] = entry
  const networkBytes = network.includes(':') ? ipv6ToBytes(network) : ipv4ToBytes(network)
  if (!networkBytes || networkBytes.length !== bytes.length) return false
  const fullBytes = Math.floor(prefix / 8)
  const remainingBits = prefix % 8
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== networkBytes[index]) return false
  }
  if (!remainingBits) return true
  const mask = 0xff << (8 - remainingBits)
  return (bytes[fullBytes] & mask) === (networkBytes[fullBytes] & mask)
}

/**
 * Whether an address is one a tool may not reach.
 *
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is unwrapped to IPv4 first: it reaches
 * loopback exactly as `127.0.0.1` does, and comparing it as IPv6 against IPv4
 * prefixes is how those addresses used to slip through. An address that cannot
 * be parsed is reported as blocked, because a check that cannot classify an
 * address cannot vouch for it.
 */
export function isPrivateAddress(address) {
  const raw = String(address ?? '').trim()
  if (net.isIPv4(raw)) {
    const bytes = ipv4ToBytes(raw)
    return bytes ? blockedIpv4.some((entry) => matchesCidr(bytes, entry)) : true
  }
  if (net.isIPv6(raw)) {
    const bytes = ipv6ToBytes(raw)
    if (!bytes) return true
    const mapped = mappedIpv4(bytes)
    if (mapped) return blockedIpv4.some((entry) => matchesCidr(mapped, entry))
    return blockedIpv6.some((entry) => matchesCidr(bytes, entry))
  }
  return true
}

function parseHosts(value = '') {
  return String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
}

/** `example.com` matches itself and its subdomains, and nothing else. */
export function hostMatches(host, allowedHosts) {
  const normalized = String(host ?? '').toLowerCase()
  return allowedHosts.some((allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`))
}

/**
 * Resolve a URL and prove every address behind it is one a tool may reach.
 *
 * The addresses are returned, not just the URL: the caller must connect to one
 * of them. Validating a name and then letting the platform resolve it again
 * leaves a gap a rebinding host can walk through.
 *
 * @param {string} rawUrl
 * @param {{ allowPrivate?: boolean, allowedHosts?: string[] | string }} [options]
 * @returns {Promise<{ url: URL, host: string, addresses: string[] }>}
 */
export async function resolveOutboundTarget(rawUrl, { allowPrivate = false, allowedHosts = [] } = {}) {
  const url = new URL(String(rawUrl))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are allowed.')
  const host = url.hostname.toLowerCase()
  const hosts = Array.isArray(allowedHosts) ? allowedHosts : parseHosts(allowedHosts)
  if (hosts.length && !hostMatches(host, hosts)) throw new Error(`Outbound host is not allowlisted: ${host}`)

  const records = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true })
  if (!records.length) throw new Error(`Could not resolve outbound host: ${host}`)
  if (!allowPrivate && records.some((record) => isPrivateAddress(record.address))) throw new Error('Private and local network targets are blocked.')
  return { url, host, addresses: records.map((record) => record.address) }
}

/**
 * The validated URL, for callers that only need to know it is allowed.
 *
 * @param {string} rawUrl
 * @param {{ allowPrivate?: boolean, allowedHosts?: string[] | string }} [options]
 */
export async function validateOutboundUrl(rawUrl, options) {
  return (await resolveOutboundTarget(rawUrl, options)).url
}

export function configuredHttpAllowlist() {
  return parseHosts(process.env.FULKRUM_HTTP_ALLOWLIST ?? '')
}

export function privateProviderUrlsAllowed() {
  return /^(1|true|yes)$/i.test(process.env.FULKRUM_ALLOW_PRIVATE_PROVIDER_URLS ?? '')
}
