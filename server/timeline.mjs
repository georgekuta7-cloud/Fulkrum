import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Time travel, honestly: what the files this run wrote looked like at an
 * event index.
 *
 * Reconstruction walks writes newest-first, undoing every write newer than
 * the index. Each undo is verified: the bytes on hand must hash to what the
 * write's own resolution committed to, or the file is marked unknown instead
 * of guessed at. Anything the records cannot prove — a pruned snapshot, a
 * file changed outside the run afterwards, a path that never went through a
 * write — is a named gap, never invented content.
 *
 * Reads current disk state, so reconstruction reflects the world as it is;
 * the hash checks are what stop a changed world from producing a confident lie.
 */

const MAX_PREVIEW_BYTES = 64_000

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Reconstruct the run's written files as of event sequence `seq`.
 * Returns `{ seq, files: [{ path, content, truncated, unknown }], gaps: [path] }`.
 * `content` is null when the file did not exist at `seq` or cannot be proven.
 */
export function reconstructAt({ store, workspaceRoot, runId, seq }) {
  const run = store.getRun(runId)
  if (!run) return null
  const events = store.listEvents(runId)
  const maxSeq = events.length ? events[events.length - 1].sequence : 0
  const at = Math.max(0, Math.min(Number(seq) || 0, maxSeq))

  // Completion order is event order: the chain, not wall-clock, decides what
  // "newest" means. Only completed writes with a completion event count —
  // anything else never verifiably happened.
  const completedSeq = new Map()
  for (const event of events) {
    if (event.type === 'tool.completed' && event.payload?.toolCallId) {
      completedSeq.set(event.payload.toolCallId, event.sequence)
    }
  }
  const writes = store.listToolCalls(runId)
    .filter((call) => call.name === 'workspace.write' && call.status === 'completed' && completedSeq.has(call.id))
    .sort((a, b) => (completedSeq.get(b.id) ?? 0) - (completedSeq.get(a.id) ?? 0))

  const paths = [...new Set(writes.map((call) => call.resolved?.relative).filter(Boolean))]
  const files = []
  const gaps = []
  for (const relative of paths) {
    const state = reverseTo(workspaceRoot, writes, completedSeq, relative, at)
    if (state.unknown) {
      gaps.push(relative)
      files.push({ path: relative, content: null, truncated: false, unknown: state.reason })
    } else if (state.absent) {
      files.push({ path: relative, content: null, truncated: false, unknown: null })
    } else {
      const content = state.bytes ?? ''
      files.push({
        path: relative,
        content: content.length > MAX_PREVIEW_BYTES ? `${content.slice(0, MAX_PREVIEW_BYTES)}\n[truncated: file exceeds 64 kB]` : content,
        truncated: content.length > MAX_PREVIEW_BYTES,
        unknown: null,
      })
    }
  }
  return { seq: at, files, gaps }
}

function reverseTo(workspaceRoot, writes, completedSeq, relative, at) {
  const relevant = writes.filter((call) => call.resolved?.relative === relative)
  const newer = relevant.filter((call) => (completedSeq.get(call.id) ?? 0) > at)
  const older = relevant.filter((call) => (completedSeq.get(call.id) ?? 0) <= at)
  // Current bytes are the starting point; the first hash check proves the
  // world did not move under the run before any undoing begins.
  let disk = null
  try {
    disk = readFileSync(path.join(workspaceRoot, relative), 'utf8')
  } catch {
    disk = null
  }
  let current = disk === null ? null : { bytes: disk, sha: sha256(disk) }
  for (const call of newer) {
    const output = call.output ?? null
    if (!output) return { unknown: true, reason: 'pruned' }
    if (output.created === true) {
      // A create undone: before it, nothing existed. Older writes to a path
      // that did not exist are impossible without an intervening delete, and
      // there is no delete tool — so absent is proven, not assumed.
      current = null
      continue
    }
    if (typeof output.previousContent !== 'string' || typeof output.previousSha256 !== 'string') {
      return { unknown: true, reason: output.previousTruncated ? 'snapshot too large to keep' : 'pruned' }
    }
    const writtenSha = call.resolved?.contentSha256 ?? null
    if (current !== null && writtenSha && current.sha !== writtenSha) {
      return { unknown: true, reason: 'changed outside the run afterwards' }
    }
    if (current === null) {
      // The file is gone now but a modification claims to predate the gap:
      // without bytes to verify against, the chain stops here honestly.
      return { unknown: true, reason: 'deleted since' }
    }
    current = { bytes: output.previousContent, sha: output.previousSha256 }
  }
  if (current === null) {
    // Absent now: proven absent at the index only when no older write claims
    // the file existed then. Otherwise it was deleted outside the run.
    return older.length ? { unknown: true, reason: 'deleted since' } : { absent: true }
  }
  if (older.length) {
    // Nothing newer left to undo: the bytes on hand must equal what the
    // newest older write left, or the world moved afterwards.
    const expected = older[0].resolved?.contentSha256 ?? null
    if (expected && current.sha !== expected) {
      return { unknown: true, reason: 'changed outside the run afterwards' }
    }
  }
  return current
}
