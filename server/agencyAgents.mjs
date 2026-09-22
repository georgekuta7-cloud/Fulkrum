/**
 * Agency Agents integration: import persona packs from msitarzewski/agency-agents.
 *
 * Each agent is a markdown definition with personality, process, and
 * deliverables. This module parses them into Fulkrum skill packs.
 */

const AGENT_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Parse an agency-agents markdown definition into a skill pack.
 *
 * @param {string} text
 * @param {{ source?: string }} [options]
 * @returns {{ ok: boolean, skill?: object, problems?: string[] }}
 */
export function parseAgencyAgent(text, { source: _source = 'agency-agents' } = {}) {
  const body = String(text ?? '')
  if (!body.trim()) return { ok: false, problems: ['the agent definition is empty'] }

  // Extract name from first heading
  const nameMatch = body.match(/^#\s+(.+)$/m)
  const rawName = nameMatch ? nameMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : ''
  if (!rawName || !AGENT_NAME_PATTERN.test(rawName)) {
    return { ok: false, problems: ['could not derive a valid skill name from the heading'] }
  }

  // Extract description from first paragraph after heading
  const descMatch = body.match(/^#\s+.+\n+(.+)$/m)
  const description = descMatch ? descMatch[1].trim().slice(0, 500) : `Agency agent: ${rawName}`

  // Extract division from directory path or frontmatter
  const divisionMatch = body.match(/^division:\s*(.+)$/m)
  const division = divisionMatch ? divisionMatch[1].trim() : 'specialized'

  return {
    ok: true,
    skill: {
      name: rawName,
      description,
      license: 'MIT',
      compatibility: 'Fulkrum agents',
      allowedTools: '',
      author: 'agency-agents',
      version: '1.0.0',
      contentLength: body.length,
      division,
      content: body,
    },
  }
}

/**
 * Import a local directory containing agency-agents markdown files.
 *
 * @param {string} dir
 * @returns {{ imported: string[], skipped: Array<{ file: string, reason: string }> }}
 */
export function importAgencyAgentsDirectory(dir) {
  const { readdirSync, readFileSync, statSync } = require('node:fs')
  const path = require('node:path')
  const imported = []
  const skipped = []

  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { imported, skipped: [{ file: dir, reason: 'directory not readable' }] }
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const filePath = path.join(dir, entry.name)
    try {
      const stats = statSync(filePath)
      if (stats.size > 256_000) {
        skipped.push({ file: entry.name, reason: 'exceeds 256 kB' })
        continue
      }
      const text = readFileSync(filePath, 'utf8')
      const result = parseAgencyAgent(text, { source: `agency-agents:${entry.name}` })
      if (result.ok) {
        imported.push(result.skill.name)
      } else {
        skipped.push({ file: entry.name, reason: result.problems?.join('; ') ?? 'invalid' })
      }
    } catch (error) {
      skipped.push({ file: entry.name, reason: error instanceof Error ? error.message : 'read failed' })
    }
  }

  return { imported, skipped }
}
