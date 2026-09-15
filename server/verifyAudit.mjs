/**
 * Verify the audit chain of a Fulkrum database.
 *
 *   npm run audit:verify
 *
 * Exits non-zero when a chained event does not match, which is the signal that
 * the log was edited, reordered, or truncated after it was written.
 */
import path from 'node:path'
import { FulkrumStore } from './store.mjs'

const store = new FulkrumStore()

try {
  const result = store.verifyAllEventChains()
  console.log(`database:      ${path.resolve(store.filePath)}`)
  console.log(`schema:        v${store.stats().schemaVersion}`)
  console.log(`runs checked:  ${result.runs}`)
  console.log(`events chained: ${result.eventsChecked}`)

  if (result.eventsUnverifiable > 0) {
    console.log(`events before the chain existed: ${result.eventsUnverifiable}`)
    console.log('  These were written before events were hash-chained, so they can be neither verified nor shown to be intact.')
  }

  for (const broken of result.broken) {
    console.error(`MISMATCH run ${broken.runId} at sequence ${broken.brokenAt} (event ${broken.eventId})`)
  }

  console.log(result.ok ? 'audit chain: intact' : `audit chain: BROKEN in ${result.broken.length} run(s)`)
  process.exitCode = result.ok ? 0 : 1
} finally {
  store.close()
}
