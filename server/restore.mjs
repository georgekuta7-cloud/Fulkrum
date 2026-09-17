import path from 'node:path'
import { restoreBackup } from './backup.mjs'

/**
 * Put a backup back where the bridge expects it.
 *
 *   npm run db:restore -- <backup.sqlite> [--anchors <audit-heads.log>] [--force] [--db <target>]
 *
 * The target defaults to the database this bridge would open. Without --force
 * an existing database — or a write-ahead log that suggests a bridge is
 * running — refuses the restore rather than risking it. Afterwards the audit
 * chains are verified, and a problem exits non-zero instead of booting
 * hopefully onto a damaged file.
 */
const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  if (index === -1 || index + 1 >= args.length) return null
  return args[index + 1]
}
const backupPath = args.find((arg) => !arg.startsWith('--'))
const dataDir = process.env.FULKRUM_DATA_DIR ?? 'data'
const targetDbPath = flag('--db') ?? process.env.FULKRUM_DB_PATH ?? path.join(dataDir, 'fulkrum.sqlite')

if (!backupPath || args.includes('--help')) {
  console.log('Usage: npm run db:restore -- <backup.sqlite> [--anchors <audit-heads.log>] [--force] [--db <target>]')
  process.exit(args.includes('--help') ? 0 : 1)
}

try {
  const { dbPath, anchorPath, result } = restoreBackup({
    backupPath,
    anchorPath: flag('--anchors'),
    targetDbPath,
    force: args.includes('--force'),
  })
  console.log(`[fulkrum] restored ${backupPath} to ${dbPath}`)
  if (anchorPath) console.log(`[fulkrum] anchor log restored to ${anchorPath}`)
  console.log(`[fulkrum] ${result.runs} run(s), ${result.eventsChecked} event(s) checked`)
  if (!result.ok) {
    console.error('[fulkrum] PROBLEM: the restored audit chains do not verify — see the counts above, do not boot on this file blindly.')
    process.exitCode = 1
  } else {
    console.log('[fulkrum] audit chain: intact')
  }
} catch (error) {
  console.error(`[fulkrum] restore refused: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
}
