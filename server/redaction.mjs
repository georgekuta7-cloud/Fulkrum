import { createHash } from 'node:crypto'

/**
 * Two independent ways a secret escapes: it is stored under a key nobody thinks
 * to redact, or it appears in a free-text value that key-based redaction never
 * sees (a header, a stack trace, a config dump). The first is handled by key
 * matching, the second by scanning content.
 */

/**
 * Names that mean "the value is a credential".
 *
 * Matched per segment rather than as a substring: `/key|token/i` also redacts
 * `monkey`, `keyboard`, and `sessionCount`, which hides real content from the
 * model and makes the redaction marker meaningless.
 */
const sensitiveNameSegments = new Set([
  'key', 'keys', 'apikey', 'secret', 'secrets', 'token', 'tokens', 'authorization', 'auth',
  'password', 'passwd', 'passphrase', 'credential', 'credentials', 'cookie', 'cookies',
  'signature', 'sessionid', 'privatekey', 'clientsecret', 'accesskey', 'refreshtoken', 'bearertoken',
])

const camelCaseCredential = /(apikey|accesskey|authtoken|clientsecret|privatekey|refreshtoken|bearertoken|idtoken|sessionid|accesstoken)/i

export function isSensitiveKeyName(name) {
  const normalized = String(name ?? '').toLowerCase()
  if (!normalized) return false
  if (normalized.split(/[^a-z0-9]+/).filter(Boolean).some((segment) => sensitiveNameSegments.has(segment))) return true
  return camelCaseCredential.test(normalized)
}

const secretValuePatterns = [
  { kind: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'xai-key', pattern: /\bxai-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { kind: 'huggingface-token', pattern: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { kind: 'sendgrid-key', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'digitalocean-token', pattern: /\bdop_v1_[a-f0-9]{40,}\b/gi },
  { kind: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'slack-app-token', pattern: /\bxapp-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'basic-auth-url', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
  { kind: 'bearer-header', pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g },
]

/** Shapes that are hashes rather than credentials, so content stays readable. */
const hashShape = /^[a-f0-9]{7,64}$/i
const opaqueCandidate = /\b[A-Za-z0-9+/=_-]{40,}\b/g

/**
 * A long, mixed, unlabelled string: the shape of a token from a gateway that
 * uses no recognizable prefix. Deliberately narrow — hashes stay readable, and a
 * plain word or a path is never a candidate — because redacting real content is
 * not free either.
 */
export function looksLikeOpaqueToken(value) {
  const text = String(value ?? '')
  if (text.length < 40 || text.length > 512) return false
  if (hashShape.test(text)) return false
  if (!/\d/.test(text)) return false
  if (!/[a-z]/.test(text) || !/[A-Z]/.test(text)) return false
  if (text.includes('/') || text.includes('.') || text.includes(':')) return false
  return true
}

const redacted = (kind) => `[redacted:${kind}]`

/** Scan a string for credential shapes. Returns the kinds found. */
export function findSecrets(text) {
  if (typeof text !== 'string' || !text) return []
  const kinds = new Set()
  for (const { kind, pattern } of secretValuePatterns) {
    pattern.lastIndex = 0
    if (pattern.test(text)) kinds.add(kind)
  }
  opaqueCandidate.lastIndex = 0
  for (const match of text.matchAll(opaqueCandidate)) {
    if (looksLikeOpaqueToken(match[0])) kinds.add('opaque-token')
  }
  return [...kinds]
}

/** Replace credential shapes inside a string. */
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text
  const replaced = secretValuePatterns.reduce((current, { kind, pattern }) => {
    pattern.lastIndex = 0
    return current.replace(pattern, redacted(kind))
  }, text)
  opaqueCandidate.lastIndex = 0
  return replaced.replace(opaqueCandidate, (match) => (looksLikeOpaqueToken(match) ? redacted('opaque-token') : match))
}

/**
 * Recursively redact a tool result: values under sensitive-looking keys, and
 * credential shapes inside every string. Applied before output reaches the model
 * and before it is written to the audit log.
 */
export function redact(value, key = '') {
  if (typeof value === 'string') return isSensitiveKeyName(key) ? redacted('key') : redactSecrets(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, key))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([entryKey, item]) => [entryKey, redact(item, entryKey)]))
}

/**
 * Header names are kept, values are not: the audit log records that a request
 * carried an Authorization header and what it hashed to, so a changed payload
 * invalidates an approval without putting the credential in the log.
 */
export function hashHeaderValues(headers) {
  if (!headers || typeof headers !== 'object') return {}
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    String(name).toLowerCase(),
    `sha256:${createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 16)}`,
  ]))
}
