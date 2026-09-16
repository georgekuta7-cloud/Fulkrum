/**
 * Verify the audit chain of a Fulkrum database.
 *
 *   npm run audit:verify              # check every run's chain
 *   npm run audit:verify -- --anchor  # also record a checkpoint for each run
 *
 * Exits non-zero when a chained event does not match, which is the signal that
 * the log was edited, reordered, or truncated after it was written.
 *
 * A hash chain cannot detect its own truncation: deleting the last events leaves
 * every remaining link valid. The head is therefore anchored twice — in a row
 * outside the chain, and in an append-only file next to the database. The file is
 * what survives someone deleting the row along with the events.
 */
import path from 'node:path'
import { FulkrumStore } from './store.mjs'

const anchor = process.argv.includes('--anchor')
const store = new FulkrumStore()

try {
  const runIds = store.database.prepare('SELECT DISTINCT run_id FROM run_events ORDER BY run_id').all().map((row) => row.run_id)

  if (anchor) {
    let anchored = 0
    for (const runId of runIds) {
      if (store.recordAuditCheckpoint(runId, { source: 'cli', note: 'Recorded by audit:verify --anchor.' })) anchored += 1
    }
    console.log(`anchored ${anchored} run(s)\n`)
  }

  const result = store.verifyAllEventChains()
  const anchorCount = store.readAnchors().length
  console.log(`database:       ${path.resolve(store.filePath)}`)
  console.log(`schema:         v${store.stats().schemaVersion}`)
  console.log(`anchor file:    ${store.anchorFile ? `${path.resolve(store.anchorFile)} (${anchorCount} anchor(s))` : 'disabled'}`)
  console.log(`runs checked:   ${result.runs}`)
  console.log(`events chained: ${result.eventsChecked}`)

  for (const run of result.details.filter((candidate) => candidate.unverifiable > 0 || candidate.verifiedFrom)) {
    const from = run.verifiedFrom ? `verified from event ${run.verifiedFrom}` : 'nothing chained yet'
    console.log(`  ${run.runId.slice(0, 24).padEnd(26)} ${run.checked} verified, ${run.unverifiable} outside the chain (${from})`)
  }

  if (result.eventsUnverifiable > 0) {
    console.log(`\n${result.eventsUnverifiable} event(s) predate hash chaining and are outside its guarantee.`)
    console.log('  They are anchored by a genesis checkpoint, so the boundary is a recorded fact rather than an open count.')
  }

  for (const broken of result.broken) {
    console.error(`MISMATCH run ${broken.runId} at sequence ${broken.brokenAt} (event ${broken.eventId})`)
  }
  for (const run of result.details.filter((candidate) => candidate.truncated)) {
    const recorded = [run.checkpoint?.sequence, run.anchor?.sequence].filter((value) => Number.isFinite(value))
    console.error(`TRUNCATED run ${run.runId}: the chain ends at sequence ${run.total} but an anchor recorded ${Math.max(...recorded)}`)
    console.error('  Either the tail was removed, or this file was restored from a backup taken before those events.')
  }
  for (const run of result.details.filter((candidate) => candidate.checkpoint && !candidate.checkpointHashIntact)) {
    console.error(`ANCHOR MISMATCH run ${run.runId}: the anchored event ${run.checkpoint.sequence} no longer has the recorded hash`)
  }
  for (const run of result.anchorOrphaned) {
    console.error(`ANCHOR WITHOUT CHECKPOINT run ${run.runId}: an anchor records event ${run.anchor.sequence}, but the checkpoint row that wrote it is gone`)
  }

  const problems = result.broken.length + result.truncated.length + result.anchorMismatch.length + result.anchorOrphaned.length
  console.log(result.ok ? '\naudit chain: intact' : `\naudit chain: PROBLEM in ${problems} run(s)`)
  process.exitCode = result.ok ? 0 : 1
} finally {
  store.close()
}
