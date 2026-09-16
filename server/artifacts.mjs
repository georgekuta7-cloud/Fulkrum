import { diffHunks } from './diff.mjs'

/**
 * What a run actually changed.
 *
 * Every completed write is an artifact. The diff comes from the snapshot taken
 * immediately before the write, so it is the real change; a file written before
 * snapshots existed says so rather than showing an empty diff.
 *
 * Shared by the artifacts endpoint and the run report, so the two cannot drift.
 */
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
