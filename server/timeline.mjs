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
 * Shell commands are not writes: their receipts name the files they changed
 * but never their bytes, so a path only a command touched appears as an
 * unknown, named by the reason. A path with write history whose disk bytes a
 * command moved is caught by the hash checks like any outside change, and the
 * reason says a command was involved when the receipt proves it.
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

  // What the shell changed, from the receipts: names, never bytes.
  const shellTouched = new Map()
  for (const call of store.listToolCalls(runId)) {
    if (call.name !== 'shell.exec' || call.status !== 'completed' || !completedSeq.has(call.id)) continue
    const changed = call.output?.changedFiles
    if (!changed) continue
    const seq = completedSeq.get(call.id) ?? 0
    for (const relative of [...(changed.added ?? []), ...(changed.modified ?? []), ...(changed.removed ?? [])]) {
      if (typeof relative !== 'string' || !relative) continue
      if (!shellTouched.has(relative) || shellTouched.get(relative) < seq) shellTouched.set(relative, seq)
    }
  }

  const writePaths = new Set(writes.map((call) => call.resolved?.relative).filter(Boolean))
  const paths = [...new Set([...writePaths, ...shellTouched.keys()])]
  const files = []
  const gaps = []
  for (const relative of paths) {
    if (!writePaths.has(relative)) {
      // A path only a shell command touched: its bytes were never captured,
      // so it is present as an unknown instead of silently omitted.
      gaps.push(relative)
      files.push({ path: relative, content: null, truncated: false, unknown: 'changed by a shell command; its content is not recorded' })
      continue
    }
    const state = reverseTo(workspaceRoot, writes, completedSeq, relative, at, shellTouched)
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

function reverseTo(workspaceRoot, writes, completedSeq, relative, at, shellTouched = new Map()) {
  const relevant = writes.filter((call) => call.resolved?.relative === relative)
  const newer = relevant.filter((call) => (completedSeq.get(call.id) ?? 0) > at)
  const older = relevant.filter((call) => (completedSeq.get(call.id) ?? 0) <= at)
  // The reason a hash check failed is worth naming: a command this run ran
  // after the index is not "outside the run", and the receipt proves it
  // touched this path. A command older than the index is not blamed for a
  // mismatch it cannot have caused.
  const movedReason = (shellTouched.get(relative) ?? -1) > at ? 'changed by a shell command' : 'changed outside the run afterwards'
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
      return { unknown: true, reason: movedReason }
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
      return { unknown: true, reason: movedReason }
    }
  }
  return current
}
