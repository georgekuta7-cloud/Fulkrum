/**
 * A minimal line diff, so the artifacts view can show what a write changed
 * without pulling in a dependency.
 *
 * This is a plain longest-common-subsequence diff over lines: good enough for
 * "what did the agent change in this file", and bounded so a huge file cannot
 * stall the request.
 */
// Read at use time, not import time: a value saved through the app must apply
// without restarting the bridge.
const maxDiffLines = () => Number(process.env.FULKRUM_MAX_DIFF_LINES ?? 2_000)
const contextLines = 3

function splitLines(text) {
  if (typeof text !== 'string' || text === '') return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // A trailing newline terminates the last line; it is not an extra empty line.
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** LCS table over the two line arrays, capped for safety. */
function commonSubsequenceMatrix(before, after) {
  const rows = before.length + 1
  const columns = after.length + 1
  const table = Array.from({ length: rows }, () => new Uint16Array(columns))
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

/** Sequence of { type: 'context' | 'add' | 'remove', line, beforeLine, afterLine } */
export function lineDiff(beforeText, afterText) {
  const before = splitLines(beforeText)
  const after = splitLines(afterText)

  if (before.length > maxDiffLines() || after.length > maxDiffLines()) {
    return { truncated: true, entries: [], added: null, removed: null, reason: `File is larger than ${maxDiffLines()} lines.` }
  }
  if (before.length === 0 && after.length === 0) return { truncated: false, entries: [], added: 0, removed: 0 }

  const table = commonSubsequenceMatrix(before, after)
  const entries = []
  let i = 0
  let j = 0
  let added = 0
  let removed = 0

  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      entries.push({ type: 'context', line: before[i], beforeLine: i + 1, afterLine: j + 1 })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      entries.push({ type: 'remove', line: before[i], beforeLine: i + 1, afterLine: null })
      removed += 1
      i += 1
    } else {
      entries.push({ type: 'add', line: after[j], beforeLine: null, afterLine: j + 1 })
      added += 1
      j += 1
    }
  }
  while (i < before.length) {
    entries.push({ type: 'remove', line: before[i], beforeLine: i + 1, afterLine: null })
    removed += 1
    i += 1
  }
  while (j < after.length) {
    entries.push({ type: 'add', line: after[j], beforeLine: null, afterLine: j + 1 })
    added += 1
    j += 1
  }

  return { truncated: false, entries, added, removed }
}

/** Collapse unchanged runs into hunks, keeping a few lines of context. */
export function diffHunks(beforeText, afterText, { context = contextLines } = {}) {
  const diff = lineDiff(beforeText, afterText)
  if (diff.truncated) return diff

  const changedIndexes = diff.entries.map((entry, index) => (entry.type === 'context' ? -1 : index)).filter((index) => index >= 0)
  if (!changedIndexes.length) return { ...diff, hunks: [] }

  const hunks = []
  let current = null
  for (const index of changedIndexes) {
    const start = Math.max(index - context, 0)
    const end = Math.min(index + context, diff.entries.length - 1)
    if (current && start <= current.end + 1) {
      current.end = Math.max(current.end, end)
      continue
    }
    current = { start, end }
    hunks.push(current)
  }

  return {
    ...diff,
    hunks: hunks.map((hunk) => ({
      beforeStart: diff.entries.slice(hunk.start, hunk.end + 1).find((entry) => entry.beforeLine !== null)?.beforeLine ?? null,
      afterStart: diff.entries.slice(hunk.start, hunk.end + 1).find((entry) => entry.afterLine !== null)?.afterLine ?? null,
      entries: diff.entries.slice(hunk.start, hunk.end + 1),
    })),
  }
}
