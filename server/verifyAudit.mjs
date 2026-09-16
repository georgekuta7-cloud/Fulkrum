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
 * every remaining link valid. A checkpoint anchors the head in a row outside the
 * chain, which is what makes a shortened tail reportable.
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
  console.log(`database:       ${path.resolve(store.filePath)}`)
  console.log(`schema:         v${store.stats().schemaVersion}`)
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
    console.error(`TRUNCATED run ${run.runId}: the chain ends at ${run.total} but a checkpoint recorded event ${run.checkpoint.sequence}`)
  }
  for (const run of result.details.filter((candidate) => candidate.checkpoint && !candidate.checkpointHashIntact)) {
    console.error(`ANCHOR MISMATCH run ${run.runId}: the anchored event ${run.checkpoint.sequence} no longer has the recorded hash`)
  }

  console.log(result.ok ? '\naudit chain: intact' : `\naudit chain: PROBLEM in ${result.broken.length + result.details.filter((run) => run.truncated || (run.checkpoint && !run.checkpointHashIntact)).length} run(s)`)
  process.exitCode = result.ok ? 0 : 1
} finally {
  store.close()
}
