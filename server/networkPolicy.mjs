import dns from 'node:dns/promises'
import net from 'node:net'

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const octets = address.split('.').map(Number)
    const [first, second] = octets
    return first === 0 || first === 10 || first === 127 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168 || first === 100 && second >= 64 && second <= 127
  }

  const normalized = address.toLowerCase()
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('::ffff:10.') || normalized.startsWith('::ffff:192.168.')
}

function parseHosts(value = '') {
  return String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
}

function hostMatches(host, allowedHosts) {
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

export async function validateOutboundUrl(rawUrl, { allowPrivate = false, allowedHosts = [] } = {}) {
  const url = new URL(String(rawUrl))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are allowed.')
  const host = url.hostname.toLowerCase()
  const hosts = Array.isArray(allowedHosts) ? allowedHosts : parseHosts(allowedHosts)
  if (hosts.length && !hostMatches(host, hosts)) throw new Error(`Outbound host is not allowlisted: ${host}`)

  const records = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true })
  if (!records.length) throw new Error(`Could not resolve outbound host: ${host}`)
  if (!allowPrivate && records.some((record) => isPrivateAddress(record.address))) throw new Error('Private and local network targets are blocked.')
  return url
}

export function configuredHttpAllowlist() {
  return parseHosts(process.env.FULKRUM_HTTP_ALLOWLIST ?? '')
}

export function privateProviderUrlsAllowed() {
  return /^(1|true|yes)$/i.test(process.env.FULKRUM_ALLOW_PRIVATE_PROVIDER_URLS ?? '')
}
