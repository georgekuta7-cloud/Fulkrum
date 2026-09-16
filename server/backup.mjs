import { FulkrumStore } from './store.mjs'

/**
 * Take a consistent copy of the database without stopping the app.
 *
 * VACUUM INTO writes a complete file from the current contents, so the copy is
 * usable on its own. Rotating keeps the newest few: a backup directory that grows
 * without limit is its own outage. The anchor log is copied beside it, so a
 * restore does not end up looking like a truncated audit trail.
 *
 *   npm run db:backup
 */
const store = new FulkrumStore()
try {
  const result = store.backup()
  console.log(`[fulkrum] backup written to ${result.path}`)
  if (result.anchorPath) console.log(`[fulkrum] anchor log copied to ${result.anchorPath}`)
  for (const name of result.removed) console.log(`[fulkrum] rotated out ${name}`)
  console.log(`[fulkrum] keeping the newest ${result.keep}`)
} finally {
  store.close()
}
