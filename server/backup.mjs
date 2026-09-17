import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * Back up unless the newest copy is still fresh. Backups used to happen only
 * at boot, so a bridge left running for weeks quietly stopped being backed
 * up; the hourly timer in index.mjs calls this instead.
 */
/**
 * @param {any} store
 * @param {{ intervalHours?: number, log?: (message: string) => void }} [options]
 */
export function backupIfStale(store, { intervalHours = 24, log = () => {} } = {}) {
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) return null
  const { newestAgeMs } = store.backupStatus()
  if (newestAgeMs !== null && newestAgeMs <= intervalHours * 3_600_000) return null
  const result = store.backup()
  log(`[fulkrum] database backed up to ${result.path}`)
  return result
}

/**
 * Put a backup back where the bridge expects it, then prove it is usable.
 *
 * Refuses to overwrite a live database unless forced, and refuses when a
 * write-ahead log sits beside the target — that file means a bridge may be
 * holding the database open right now. Opening the restored copy runs the
 * migrations and the integrity check, and the returned verification says
 * whether the audit chains survived the round trip.
 */
export function restoreBackup({ backupPath, anchorPath = null, targetDbPath, targetAnchorPath = null, force = false }) {
  if (!backupPath || !existsSync(backupPath)) throw new Error(`Backup not found: ${backupPath ?? '(missing)'}`)
  if (!targetDbPath) throw new Error('A restore needs a target database path.')
  if (existsSync(targetDbPath) && !force) {
    throw new Error(`Refusing to overwrite ${targetDbPath} without --force. Stop the bridge first if this is really a restore.`)
  }
  if (existsSync(`${targetDbPath}-wal`) && !force) {
    throw new Error(`A write-ahead log sits beside ${targetDbPath}: a bridge may be running. Stop it first, or pass --force.`)
  }
  mkdirSync(path.dirname(targetDbPath), { recursive: true })
  copyFileSync(backupPath, targetDbPath)
  let restoredAnchor = null
  if (anchorPath) {
    if (!existsSync(anchorPath)) throw new Error(`Anchor log not found: ${anchorPath}`)
    restoredAnchor = targetAnchorPath ?? path.join(path.dirname(targetDbPath), 'audit-heads.log')
    copyFileSync(anchorPath, restoredAnchor)
  }
  const store = new FulkrumStore(targetDbPath)
  try {
    return { dbPath: targetDbPath, anchorPath: restoredAnchor, result: store.verifyEverything() }
  } finally {
    store.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
}
