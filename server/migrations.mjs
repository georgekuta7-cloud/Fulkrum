import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

function readUserVersion(database) {
  const row = database.prepare('PRAGMA user_version').get()
  return Number(Object.values(row ?? {})[0] ?? 0)
}

/**
 * Apply ordered SQL migrations and record progress in SQLite's own
 * `user_version` header field.
 *
 * A schema built only from `CREATE TABLE IF NOT EXISTS` silently ignores every
 * later change, so an existing database never gains a new column. Versioned
 * files make each change explicit and replayable, and `user_version` is stored
 * in the database file itself, so it cannot drift from the schema it describes.
 */
export function applyMigrations(database, { directory = defaultDirectory, log = () => {} } = {}) {
  const files = readdirSync(directory)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort()

  const startingVersion = readUserVersion(database)
  let applied = 0

  for (const file of files) {
    const version = Number(file.slice(0, 3))
    if (version <= startingVersion) continue

    const sql = readFileSync(path.join(directory, file), 'utf8')
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(sql)
      // The version comes from a filename validated by the filter above, so it
      // is a literal integer and safe to interpolate (PRAGMA does not bind).
      database.exec(`PRAGMA user_version = ${version}`)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Migration ${file} failed: ${detail}`)
    }

    applied += 1
    log(file)
  }

  return { from: startingVersion, to: readUserVersion(database), applied }
}
