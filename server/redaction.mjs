/**
 * Two independent ways a secret escapes: it is stored under a key nobody thinks
 * to redact, or it appears in a free-text value that key-based redaction never
 * sees (a header, a stack trace, a config dump). The first is handled by key
 * matching, the second by scanning content.
 */

const secretKeyPattern = /key|token|secret|authorization|password|credential|cookie|session/i

const secretValuePatterns = [
  { kind: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'basic-auth-url', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
  { kind: 'bearer-header', pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g },
]

const redacted = (kind) => `[redacted:${kind}]`

/** Scan a string for credential shapes. Returns the kinds found. */
export function findSecrets(text) {
  if (typeof text !== 'string' || !text) return []
  const kinds = new Set()
  for (const { kind, pattern } of secretValuePatterns) {
    pattern.lastIndex = 0
    if (pattern.test(text)) kinds.add(kind)
  }
  return [...kinds]
}

/** Replace credential shapes inside a string. */
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text
  return secretValuePatterns.reduce((current, { kind, pattern }) => {
    pattern.lastIndex = 0
    return current.replace(pattern, redacted(kind))
  }, text)
}

/**
 * Recursively redact a tool result: values under sensitive-looking keys, and
 * credential shapes inside every string. Applied before output reaches the model
 * and before it is written to the audit log.
 */
export function redact(value, key = '') {
  if (typeof value === 'string') return secretKeyPattern.test(key) ? redacted('key') : redactSecrets(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, key))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([entryKey, item]) => [entryKey, redact(item, entryKey)]))
}
