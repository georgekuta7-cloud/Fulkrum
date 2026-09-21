import { diffHunks } from './diff.mjs'

const evidenceItemLimit = () => Math.max(Number(process.env.FULKRUM_EVIDENCE_MAX_ITEMS ?? 20) || 20, 1)
const handoffCharLimit = () => Math.max(Number(process.env.FULKRUM_HANDOFF_MAX_CHARS ?? 4000) || 4000, 500)

/**
 * What a run actually changed.
 *
 * Every completed write is an artifact. The diff comes from the snapshot taken
 * immediately before the write, so it is the real change; a file written before
 * snapshots existed says so rather than showing an empty diff.
 *
 * Shared by the artifacts endpoint and the run report, so the two cannot drift.
 */

/**
 * Write pointers without diffs, for handoff digests.
 *
 * A dependent worker needs to know *what* was written — path, size, whether it
 * is new — not the full diff. Computing diffs for every handoff would redo the
 * artifacts view once per dependency, so digests use these pointers and the
 * verifier reads the bytes it needs.
 */
export function listWritePointers(store, runId, agentId = null) {
  return store
    .listToolCalls(runId)
    .filter((call) => call.kind === 'write' && call.status === 'completed' && (!agentId || call.agentId === agentId))
    .map((call) => {
      const output = call.output ?? {}
      const raw = store.getToolCallInput(call.id)
      const after = String((raw ?? call.input)?.content ?? '')
      return {
        toolCallId: call.id,
        agentId: call.agentId,
        path: output.path ?? call.resolved?.relative ?? String(call.input?.path ?? 'unknown'),
        bytes: output.bytes ?? Buffer.byteLength(after, 'utf8'),
        created: Boolean(output.created),
        diff: null,
        at: call.completedAt ?? call.createdAt,
      }
    })
}

export function buildArtifacts(store, runId) {
  return store
    .listToolCalls(runId)
    .filter((call) => call.kind === 'write' && call.status === 'completed')
    .map((call) => {
      const output = call.output ?? {}
      // The diff compares against what was actually written, so it reads the
      // original arguments rather than the redacted display copy.
      const raw = store.getToolCallInput(call.id)
      const after = String((raw ?? call.input)?.content ?? '')
      const before = typeof output.previousContent === 'string' ? output.previousContent : ''
      const snapshotAvailable = output.created === true || typeof output.previousContent === 'string'
      const diff = snapshotAvailable ? diffHunks(before, after) : null
      return {
        toolCallId: call.id,
        agentId: call.agentId,
        path: output.path ?? call.resolved?.relative ?? String(call.input?.path ?? 'unknown'),
        bytes: output.bytes ?? Buffer.byteLength(after, 'utf8'),
        created: Boolean(output.created),
        previousBytes: output.previousBytes ?? null,
        previousTruncated: Boolean(output.previousTruncated),
        diffAvailable: Boolean(diff),
        diff,
        at: call.completedAt ?? call.createdAt,
      }
    })
}

/**
 * The machine half of a task completion.
 *
 * A worker ends its final summary with a fenced ```evidence block carrying
 * typed records — findings with paths, artifacts with hashes, test receipts,
 * open questions. Prose stays the human half; this block is what downstream
 * workers and verifiers consume. Absent is allowed (legacy prose); present
 * but malformed is rejected with reasons the worker can act on.
 */
/** The last fenced ```name block in a reply, parsed as JSON. Verdicts reuse the same shape as evidence: a machine block at the end of human prose. */
export function extractFencedBlock(text, name) {
  if (typeof text !== 'string' || !text) return { found: false }
  const pattern = new RegExp(`\`\`\`${name}\\s*([\\s\\S]*?)\`\`\``, 'g')
  let last = null
  let match = null
  while ((match = pattern.exec(text)) !== null) last = match[1]
  if (last === null) return { found: false }
  try {
    return { found: true, value: JSON.parse(last) }
  } catch {
    return { found: true, value: null, invalidJson: true }
  }
}

export function extractStructuredCompletion(text) {
  return extractFencedBlock(text, 'evidence')
}

const completionString = (value, maximum, label, problems) => {
  if (typeof value !== 'string' || !value.trim()) {
    problems.push(`${label} must be a non-empty string.`)
    return ''
  }
  return value.trim().slice(0, maximum)
}

const completionLine = (value, label, problems) => {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) {
    problems.push(`${label} must be a line number of 1 or more.`)
    return null
  }
  return number
}

/** Validate a parsed ```evidence block. Returns normalized records or problems. */
export function validateStructuredCompletion(candidate) {
  const problems = []
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, problems: ['The evidence block must be a JSON object.'], completion: null }
  }
  const itemLimit = evidenceItemLimit()
  const listOf = (value, label) => {
    if (value === undefined) return []
    if (!Array.isArray(value)) {
      problems.push(`${label} must be an array.`)
      return []
    }
    if (value.length > itemLimit) problems.push(`${label} holds at most ${itemLimit} items.`)
    return value.slice(0, itemLimit)
  }

  const summary = completionString(candidate.summary, 2000, 'summary', problems)
  const findings = listOf(candidate.findings, 'findings').map((finding, index) => {
    if (!finding || typeof finding !== 'object') {
      problems.push(`findings[${index}] must be an object.`)
      return null
    }
    return {
      kind: 'finding',
      summary: completionString(finding.claim ?? finding.summary, 500, `findings[${index}].claim`, problems),
      path: typeof finding.path === 'string' && finding.path ? finding.path.slice(0, 500) : null,
      startLine: completionLine(finding.startLine, `findings[${index}].startLine`, problems),
      endLine: completionLine(finding.endLine, `findings[${index}].endLine`, problems),
      sha256: typeof finding.sha256 === 'string' && finding.sha256 ? finding.sha256.slice(0, 128) : null,
    }
  }).filter(Boolean)
  const artifacts = listOf(candidate.artifacts, 'artifacts').map((artifact, index) => {
    if (!artifact || typeof artifact !== 'object') {
      problems.push(`artifacts[${index}] must be an object.`)
      return null
    }
    const path = typeof artifact.path === 'string' ? artifact.path.trim().slice(0, 500) : ''
    if (!path) problems.push(`artifacts[${index}].path must be a non-empty string.`)
    const bytes = artifact.bytes === undefined || artifact.bytes === null ? null : Number(artifact.bytes)
    if (bytes !== null && (!Number.isFinite(bytes) || bytes < 0)) problems.push(`artifacts[${index}].bytes must be zero or more.`)
    return {
      kind: 'artifact',
      summary: typeof artifact.summary === 'string' && artifact.summary.trim() ? artifact.summary.trim().slice(0, 500) : `Wrote ${path}`,
      path,
      startLine: null,
      endLine: null,
      sha256: typeof artifact.sha256 === 'string' && artifact.sha256 ? artifact.sha256.slice(0, 128) : null,
      bytes,
    }
  }).filter((artifact) => artifact.path)
  const tests = listOf(candidate.tests, 'tests').map((receipt, index) => {
    if (!receipt || typeof receipt !== 'object') {
      problems.push(`tests[${index}] must be an object.`)
      return null
    }
    const command = typeof receipt.command === 'string' ? receipt.command.trim().slice(0, 500) : ''
    if (!command) problems.push(`tests[${index}].command must be a non-empty string.`)
    const exitCode = receipt.exitCode === undefined || receipt.exitCode === null ? null : Number(receipt.exitCode)
    if (exitCode !== null && !Number.isInteger(exitCode)) problems.push(`tests[${index}].exitCode must be an integer.`)
    return {
      kind: 'test',
      summary: `${command}${exitCode === null ? '' : ` (exit ${exitCode})`}`.slice(0, 500),
      path: null,
      startLine: null,
      endLine: null,
      sha256: typeof receipt.outputSha256 === 'string' && receipt.outputSha256 ? receipt.outputSha256.slice(0, 128) : null,
      command,
      exitCode,
    }
  }).filter((receipt) => receipt.command)
  const questions = [...listOf(candidate.openQuestions, 'openQuestions'), ...listOf(candidate.unresolved, 'unresolved')]
    .map((question) => (typeof question === 'string' ? question.trim().slice(0, 500) : ''))
    .filter(Boolean)
    .map((question) => ({ kind: 'question', summary: question, path: null, startLine: null, endLine: null, sha256: null }))

  if (problems.length) return { ok: false, problems, completion: null }
  return { ok: true, problems: [], completion: { summary, findings, artifacts, tests, questions } }
}

const clipLine = (value, maximum = 220) => {
  const text = String(value ?? '')
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text
}

/**
 * What a dependent task actually receives: the summary plus evidence pointers
 * and artifact pointers, bounded to FULKRUM_HANDOFF_MAX_CHARS. Full transcripts
 * stay in the audit log and the evidence ledger; the prompt carries references.
 * This is the Boomerang rule — a child returns summary + evidence ids +
 * verdict, never its tool log — and tests/boomerang.test.mjs fails if raw
 * tool output ever crosses a handoff.
 */
/** A verdict block names one result per acceptance criterion, and nothing else decides the overall. */
export function validateVerdictBlock(candidate) {
  const problems = []
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, problems: ['The verdict block must be a JSON object.'], verdict: null }
  }
  const results = Array.isArray(candidate.results) ? candidate.results : null
  if (!results) {
    return { ok: false, problems: ['The verdict block needs a results array.'], verdict: null }
  }
  const checked = results.slice(0, evidenceItemLimit()).map((result, index) => {
    if (!result || typeof result !== 'object') {
      problems.push(`results[${index}] must be an object.`)
      return null
    }
    const criterion = typeof result.criterion === 'string' ? result.criterion.trim().slice(0, 500) : ''
    if (!criterion) problems.push(`results[${index}].criterion must be a non-empty string.`)
    const status = String(result.status ?? '').trim().toUpperCase()
    if (!['PASS', 'FAIL', 'UNKNOWN'].includes(status)) problems.push(`results[${index}].status must be PASS, FAIL, or UNKNOWN.`)
    const evidence = Array.isArray(result.evidence) ? result.evidence.filter((id) => typeof id === 'string').slice(0, 20) : []
    return { criterion, status, evidence }
  }).filter(Boolean)
  if (!checked.length) problems.push('The verdict names no acceptance criterion.')
  // A FAIL that names nothing failed is a shrug, not a verdict: coerce problems
  // rather than letting an empty failure kill a run.
  if (problems.length) return { ok: false, problems, verdict: null }
  return { ok: true, problems: [], verdict: { results: checked } }
}

/**
 * The Head checkpoint decision: what a run with failed work does next.
 *
 * `repair` retries failed tasks inside the approved plan, bounded by attempts.
 * `replan` proposes a new plan version, which still needs a human approval.
 * `stop` ends the run as failed. `proceed` is only honest when nothing failed —
 * the orchestrator refuses it otherwise, so a checkpoint cannot wave through
 * work the verifier just refused.
 */
export function validateDecisionBlock(candidate, { failures = 0 } = {}) {
  const problems = []
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, problems: ['The decision block must be a JSON object.'], decision: null }
  }
  const decision = String(candidate.decision ?? '').trim().toLowerCase()
  if (!['repair', 'replan', 'stop', 'proceed'].includes(decision)) {
    problems.push('decision must be repair, replan, stop, or proceed.')
  }
  if (decision === 'proceed' && failures > 0) {
    problems.push('proceed is not available while tasks have failed: repair, replan, or stop.')
  }
  const reason = typeof candidate.reason === 'string' ? candidate.reason.trim().slice(0, 2000) : ''
  if (problems.length) return { ok: false, problems, decision: null }
  return { ok: true, problems: [], decision: { decision, reason, plan: candidate.plan ?? null } }
}

/** One overall from many criteria: any failure fails, any unknown clouds, else pass. */
export function summarizeVerdict(results) {
  const rows = Array.isArray(results) ? results : []
  if (!rows.length) return 'UNKNOWN'
  if (rows.some((result) => result?.status === 'FAIL')) return 'FAIL'
  if (rows.some((result) => result?.status === 'UNKNOWN')) return 'UNKNOWN'
  return 'PASS'
}

/**
 * @param {{ summary?: string, evidence?: Array<Record<string, any>>, artifacts?: Array<Record<string, any>>, verification?: { overall?: string, results?: Array<Record<string, any>> } | null, maxChars?: number }} [options]
 */
export function buildTaskHandoffDigest({ summary, evidence = [], artifacts = [], verification = null, maxChars = handoffCharLimit() } = {}) {
  // The summary gets at most half the budget: evidence and artifact pointers
  // are denser per character, so they must survive even a verbose summary.
  const lines = [`Summary: ${clipLine(summary ?? '(no summary)', Math.min(1500, Math.floor(maxChars / 2)))}`]
  const records = [...(evidence ?? [])].slice(0, evidenceItemLimit())
  if (records.length) {
    lines.push(`Evidence (${records.length}):`)
    for (const record of records) {
      const where = record.path ? ` — ${record.path}${record.startLine ? `:${record.startLine}${record.endLine ? `-${record.endLine}` : ''}` : ''}` : ''
      // Full ids, not truncated: the digest is a machine channel, and
      // verifiers cite these ids in verdicts. A truncated id cites nothing
      // that exists, which silently degrades every cited verdict to UNKNOWN.
      const id = record.id ? ` (#${record.id})` : ''
      lines.push(clipLine(`- [${record.kind}] ${record.summary}${where}${id}`))
    }
  }
  const pointers = [...(artifacts ?? [])].slice(0, evidenceItemLimit())
  if (pointers.length) {
    lines.push(`Artifacts (${pointers.length}):`)
    for (const artifact of pointers) {
      const size = artifact.bytes === null || artifact.bytes === undefined ? '' : ` · ${artifact.bytes} bytes`
      const delta = artifact.diff && !artifact.diff.truncated && artifact.diff.added !== null ? ` · +${artifact.diff.added}/-${artifact.diff.removed}` : ''
      const made = artifact.created ? ' · created' : ''
      lines.push(clipLine(`- ${artifact.path}${size}${delta}${made}`))
    }
  }
  // Verification travels with the work it judges: a dependent must know whether
  // its input was checked, and a FAIL here is louder than any summary.
  if (verification && verification.overall) {
    const failed = (verification.results ?? []).filter((result) => result?.status === 'FAIL')
    lines.push(failed.length
      ? `Verified: FAIL — ${failed.map((result) => result.criterion).join('; ').slice(0, 300)}`
      : `Verified: ${verification.overall}`)
  }
  const digest = lines.join('\n')
  if (digest.length <= maxChars) return digest
  return `${digest.slice(0, maxChars)}…\n[digest clipped to ${maxChars} chars; full summary and evidence stay in the run record]`
}
