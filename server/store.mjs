import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { canonicalJson } from './canonicalJson.mjs'
import { applyMigrations } from './migrations.mjs'
import { standingScopeMatches } from './permissions.mjs'

const anchorFileName = 'audit-heads.log'

// node:sqlite exists from Node 22.5 but was gated behind --experimental-sqlite
// until 22.13. A static import would fail while Node links this module's imports,
// before any of our code runs, so `engines` and a version check could never
// explain it — the process would just die with "No such built-in module".
const requireBuiltin = createRequire(import.meta.url)
/** @type {typeof import('node:sqlite').DatabaseSync} */
let DatabaseSync
try {
  ({ DatabaseSync } = requireBuiltin('node:sqlite'))
} catch {
  throw new Error(`Fulkrum needs Node 22.13 or newer: node:sqlite is unavailable in ${process.version}. Upgrade Node and start Fulkrum again.`)
}

const genesisHash = 'genesis'

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    settings: parseJson(row.settings_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function runFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    mode: row.mode,
    permissionMode: row.permission_mode,
    planVersion: Number(row.plan_version),
    planId: row.plan_id ?? null,
    budgetUsd: row.budget_usd === null || row.budget_usd === undefined ? null : Number(row.budget_usd),
    budgetExceededAt: row.budget_exceeded_at === null || row.budget_exceeded_at === undefined ? null : Number(row.budget_exceeded_at),
    ownerId: row.owner_id ?? null,
    heartbeatAt: row.heartbeat_at === null || row.heartbeat_at === undefined ? null : Number(row.heartbeat_at),
    leaseExpiresAt: row.lease_expires_at === null || row.lease_expires_at === undefined ? null : Number(row.lease_expires_at),
    interruptedAt: row.interrupted_at === null || row.interrupted_at === undefined ? null : Number(row.interrupted_at),
    interruptionReason: row.interruption_reason ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function planFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id ?? null,
    version: Number(row.version),
    objective: row.objective,
    contentHash: row.content_hash,
    status: row.status,
    source: row.source,
    approvedAt: row.approved_at === null || row.approved_at === undefined ? null : Number(row.approved_at),
    createdAt: Number(row.created_at),
  }
}

function planTaskFromRow(row) {
  return {
    id: row.id,
    planId: row.plan_id,
    orderIndex: Number(row.order_index),
    role: row.role,
    title: row.title,
    instructions: row.instructions,
    acceptanceCheck: row.acceptance_check ?? '',
    dependsOn: parseJson(row.depends_on_json, []),
    createdAt: Number(row.created_at),
  }
}

function messageFromRow(row) {
  return {
    id: Number(row.id),
    projectId: row.project_id,
    runId: row.run_id,
    role: row.role,
    agentId: row.agent_id,
    content: row.content,
    metadata: parseJson(row.metadata_json),
    createdAt: Number(row.created_at),
  }
}

function eventFromRow(row) {
  return {
    eventId: row.event_id,
    runId: row.run_id,
    sequence: Number(row.sequence),
    type: row.type,
    agentId: row.agent_id,
    payload: parseJson(row.payload_json),
    prevHash: row.prev_hash ?? null,
    hash: row.hash ?? null,
    createdAt: Number(row.created_at),
  }
}

function taskFromRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    agentId: row.agent_id,
    title: row.title,
    instructions: row.instructions,
    status: row.status,
    result: row.result,
    planTaskId: row.plan_task_id ?? null,
    stepCount: Number(row.step_count ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function standingGrantFromRow(row) {
  return {
    id: row.id,
    toolName: row.tool_name,
    scopeKind: row.scope_kind,
    scopeValue: row.scope_value,
    label: row.label,
    createdBy: row.created_by ?? null,
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
    useCount: Number(row.use_count ?? 0),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
  }
}

/** A window of text around the first match, so a result can be judged at a glance. */
function snippet(text, phrase, radius = 60) {
  const value = String(text ?? '')
  const needle = String(phrase ?? '')
  const at = value.toLowerCase().indexOf(needle.toLowerCase())
  if (at === -1) return value.slice(0, radius * 2)
  const start = Math.max(at - radius, 0)
  const end = Math.min(at + needle.length + radius, value.length)
  return `${start > 0 ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`
}

function providerSettingsFromRow(row) {
  return {
    providerId: row.provider_id,
    apiKey: row.api_key ?? null,
    authStyle: row.auth_style ?? 'auto',
    authHeader: row.auth_header ?? null,
    headers: parseJson(row.headers_json, {}),
    allowPrivate: Number(row.allow_private) === 1,
    temperature: row.temperature ?? 'auto',
    updatedAt: Number(row.updated_at),
  }
}

function toolCallFromRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    agentId: row.agent_id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    input: parseJson(row.input_json),
    resolved: parseJson(row.resolved_json, null),
    fingerprint: row.call_fingerprint ?? null,
    ruleId: row.rule_id ?? null,
    warnings: parseJson(row.warnings_json, []),
    idempotencyKey: row.idempotency_key ?? null,
    approvedAt: row.approved_at === null || row.approved_at === undefined ? null : Number(row.approved_at),
    approvalScope: row.approval_scope ?? null,
    attempt: Number(row.attempt ?? 1),
    output: parseJson(row.output_json, null),
    outputPrunedAt: row.output_pruned_at === null || row.output_pruned_at === undefined ? null : Number(row.output_pruned_at),
    error: row.error,
    createdAt: Number(row.created_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  }
}

export class FulkrumStore {
  constructor(filePath = process.env.FULKRUM_DB_PATH ?? path.join(process.env.FULKRUM_DATA_DIR ?? 'data', 'fulkrum.sqlite')) {
    mkdirSync(path.dirname(filePath), { recursive: true })
    this.filePath = filePath
    this.database = new DatabaseSync(filePath)
    this.eventListeners = new Map()
    this.ephemeralListeners = new Map()
    this.partials = new Map()
    // Set while a transaction is open, so nested calls join it instead of
    // committing early, and listeners fire after the commit rather than before.
    this.transactionDepth = 0
    this.deferredEvents = null
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec('PRAGMA busy_timeout = 5000')
    // WAL with the default synchronous setting can lose the last commits to a
    // power cut; this is a single-user tool, so paying for durability is cheap.
    this.database.exec('PRAGMA synchronous = FULL')
    this.database.exec(`PRAGMA wal_autocheckpoint = ${Number(process.env.FULKRUM_WAL_AUTOCHECKPOINT ?? 1000)}`)
    // Anchors live beside the database unless told otherwise, and `off` disables
    // writing them at all.
    const requestedAnchorFile = String(process.env.FULKRUM_ANCHOR_FILE ?? '').trim()
    this.anchorFile = requestedAnchorFile.toLowerCase() === 'off'
      ? null
      : requestedAnchorFile || path.join(path.dirname(filePath), anchorFileName)
    try {
      this.migrations = applyMigrations(this.database)
    } catch (error) {
      // A failed migration must not leave the file locked: the caller cannot close
      // a store it never received.
      try {
        this.database.close()
      } catch {
        // Already unusable.
      }
      throw error
    }

    // A damaged file is worth knowing about now, not at the first write that
    // quietly lands in a corrupted page.
    const verdict = Object.values(this.database.prepare('PRAGMA quick_check(1)').get() ?? {})[0]
    if (verdict !== 'ok') {
      try {
        this.database.close()
      } catch {
        // Already unusable.
      }
      throw new Error(`The database failed its integrity check (${verdict ?? 'no result'}). Restore a backup from ${path.join(path.dirname(filePath), 'backups')} rather than writing to this file.`)
    }
  }

  /**
   * Run several writes as one unit.
   *
   * Three separate autocommits — approve a plan, point the run at it, record the
   * event — leave a crash free to stop between them, and the audit log then cannot
   * explain the state it finds. Nested calls join the open transaction: the store
   * holds one connection, so a second BEGIN would either deadlock or commit the
   * outer unit early.
   */
  transaction(fn) {
    if (this.transactionDepth > 0) return fn()
    this.database.exec('BEGIN IMMEDIATE')
    this.transactionDepth += 1
    this.deferredEvents = []
    let committed = false
    try {
      const result = fn()
      this.database.exec('COMMIT')
      committed = true
      return result
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // The transaction is already gone; the original error is what matters.
      }
      throw error
    } finally {
      this.transactionDepth -= 1
      const pending = this.deferredEvents ?? []
      this.deferredEvents = null
      // Listeners run only for events that survived the commit, and only when it
      // happened: a subscriber must not see an event that was rolled back.
      if (committed) {
        for (const event of pending) this.notifyEvent(event)
      }
    }
  }

  notifyEvent(event) {
    for (const listener of this.eventListeners.get(event.runId) ?? []) {
      try {
        listener(event)
      } catch {
        // A disconnected stream must not interrupt event persistence.
      }
    }
  }

  listProjects() {
    return this.database.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all().map(projectFromRow)
  }

  getProject(projectId) {
    const row = this.database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
    if (!row) return null
    return {
      project: projectFromRow(row),
      runs: this.database.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY updated_at DESC').all(projectId).map(runFromRow),
    }
  }

  createProject({ id = `project-${randomUUID()}`, name = 'Untitled project', settings = {} } = {}) {
    const now = Date.now()
    this.database.prepare('INSERT INTO projects(id, name, settings_json, created_at, updated_at) VALUES(?, ?, ?, ?, ?)').run(id, name.trim() || 'Untitled project', JSON.stringify(settings), now, now)
    return this.getProject(id).project
  }

  updateProject(projectId, patch = {}) {
    const current = this.getProject(projectId)?.project
    if (!current) throw new Error(`Project not found: ${projectId}`)
    const settings = patch.settings === undefined ? current.settings : patch.settings
    const name = patch.name === undefined ? current.name : String(patch.name).trim() || current.name
    const now = Date.now()
    this.database.prepare('UPDATE projects SET name = ?, settings_json = ?, updated_at = ? WHERE id = ?').run(name, JSON.stringify(settings), now, projectId)
    return this.getProject(projectId).project
  }

  ensureDefaultProject() {
    const existing = this.getProject('project-default')
    return existing?.project ?? this.createProject({ id: 'project-default', name: 'Launch plan' })
  }

  /** Remove a project and everything it owns. Foreign keys cascade. */
  deleteProject(projectId) {
    const result = this.database.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    return Number(result.changes) > 0
  }

  createRun({ projectId, id = `run-${randomUUID()}`, mode = 'plan', permissionMode = 'selective', ownerId = null }) {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`)
    const now = Date.now()
    this.database.prepare('INSERT INTO runs(id, project_id, status, mode, permission_mode, owner_id, heartbeat_at, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, 'planning', mode, permissionMode, ownerId, ownerId ? now : null, now, now)
    return this.getRun(id)
  }

  ensureActiveRun(projectId, mode = 'plan') {
    const row = this.database.prepare("SELECT * FROM runs WHERE project_id = ? AND status NOT IN ('cancelled', 'completed') ORDER BY updated_at DESC LIMIT 1").get(projectId)
    return row ? runFromRow(row) : this.createRun({ projectId, mode })
  }

  getRun(runId) {
    const row = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
    return row ? runFromRow(row) : null
  }

  /**
   * Runs with what they cost, for a history view.
   *
   * Spend is aggregated in the same query rather than by calling `spendForRun` per
   * row: a history list should not be a loop of queries.
   */
  listRuns({ projectId = null, activeOnly = false, status = null, limit = 50 } = {}) {
    const conditions = []
    const parameters = []
    if (projectId) {
      conditions.push('r.project_id = ?')
      parameters.push(projectId)
    }
    if (activeOnly) conditions.push("r.status NOT IN ('cancelled', 'completed', 'failed')")
    if (status) {
      conditions.push('r.status = ?')
      parameters.push(status)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    return this.database
      .prepare(`SELECT r.*,
          COALESCE((SELECT SUM(cost_usd) FROM model_calls WHERE run_id = r.id), 0) AS cost_usd,
          (SELECT COUNT(*) FROM model_calls WHERE run_id = r.id) AS call_count,
          (SELECT COUNT(*) FROM model_calls WHERE run_id = r.id AND priced = 0) AS unpriced_count,
          (SELECT COUNT(*) FROM run_tasks WHERE run_id = r.id) AS task_count,
          (SELECT COUNT(*) FROM tool_calls WHERE run_id = r.id AND kind = 'write' AND status = 'completed') AS write_count,
          (SELECT objective FROM plans WHERE plans.id = r.plan_id) AS objective
        FROM runs r ${where} ORDER BY r.updated_at DESC LIMIT ?`)
      .all(...parameters, limit)
      .map((row) => ({
        ...runFromRow(row),
        objective: row.objective ?? null,
        spend: { costUsd: Number(row.cost_usd ?? 0), calls: Number(row.call_count ?? 0), unpricedCalls: Number(row.unpriced_count ?? 0) },
        taskCount: Number(row.task_count ?? 0),
        writes: Number(row.write_count ?? 0),
      }))
  }

  /** Tool calls that touched one file, newest first, across every run. */
  listToolCallsForPath(relativePath, { limit = 50 } = {}) {
    // `resolved_json` holds the canonical resolution, so the relative path appears
    // in it verbatim; the LIKE is a coarse filter and the caller sees the rows.
    const needle = `%"relative":"${String(relativePath).replaceAll('"', '')}"%`
    return this.database.prepare('SELECT * FROM tool_calls WHERE resolved_json LIKE ? ORDER BY created_at DESC LIMIT ?').all(needle, limit).map(toolCallFromRow)
  }

  /**
   * Messages and events matching a phrase.
   *
   * `%` and `_` are escaped so a search for "100%" does not become a wildcard, and
   * results are snippets rather than whole payloads: the point is to find the place,
   * not to read it here.
   */
  search({ query, projectId = null, limit = 30 }) {
    const phrase = String(query ?? '').trim()
    if (!phrase) return { query: '', messages: [], events: [], truncated: false }
    const escaped = phrase.replace(/[%_\\]/g, (character) => `\\${character}`)
    const like = `%${escaped}%`
    const scope = projectId ? 'AND r.project_id = ?' : ''
    const parameters = projectId ? [like, projectId, limit] : [like, limit]

    const messages = this.database
      .prepare(`SELECT m.id, m.run_id, m.project_id, m.role, m.agent_id, m.content, m.created_at
        FROM messages m JOIN runs r ON r.id = m.run_id
        WHERE m.content LIKE ? ESCAPE '\\' ${scope} ORDER BY m.created_at DESC LIMIT ?`)
      .all(...parameters)
      .map((row) => ({
        kind: 'message',
        id: String(row.id),
        runId: row.run_id,
        projectId: row.project_id,
        role: row.role,
        agentId: row.agent_id,
        snippet: snippet(row.content, phrase),
        createdAt: Number(row.created_at),
      }))

    const events = this.database
      .prepare(`SELECT e.event_id, e.run_id, r.project_id, e.type, e.agent_id, e.payload_json, e.sequence, e.created_at
        FROM run_events e JOIN runs r ON r.id = e.run_id
        WHERE e.payload_json LIKE ? ESCAPE '\\' ${scope} ORDER BY e.created_at DESC LIMIT ?`)
      .all(...parameters)
      .map((row) => ({
        kind: 'event',
        id: row.event_id,
        runId: row.run_id,
        projectId: row.project_id,
        type: row.type,
        agentId: row.agent_id,
        sequence: Number(row.sequence),
        snippet: snippet(row.payload_json, phrase),
        createdAt: Number(row.created_at),
      }))

    return { query: phrase, messages, events, truncated: messages.length >= limit || events.length >= limit }
  }

  updateRun(runId, patch = {}) {
    const current = this.getRun(runId)
    if (!current) throw new Error(`Run not found: ${runId}`)
    const next = {
      status: patch.status ?? current.status,
      mode: patch.mode ?? current.mode,
      permissionMode: patch.permissionMode ?? current.permissionMode,
      planVersion: patch.planVersion ?? current.planVersion,
      planId: patch.planId === undefined ? current.planId : patch.planId,
      budgetUsd: patch.budgetUsd === undefined ? current.budgetUsd : patch.budgetUsd,
      budgetExceededAt: patch.budgetExceededAt === undefined ? current.budgetExceededAt : patch.budgetExceededAt,
      ownerId: patch.ownerId === undefined ? current.ownerId : patch.ownerId,
      heartbeatAt: patch.heartbeatAt === undefined ? current.heartbeatAt : patch.heartbeatAt,
      leaseExpiresAt: patch.leaseExpiresAt === undefined ? current.leaseExpiresAt : patch.leaseExpiresAt,
      interruptedAt: patch.interruptedAt === undefined ? current.interruptedAt : patch.interruptedAt,
      interruptionReason: patch.interruptionReason === undefined ? current.interruptionReason : patch.interruptionReason,
    }
    this.database.prepare('UPDATE runs SET status = ?, mode = ?, permission_mode = ?, plan_version = ?, plan_id = ?, budget_usd = ?, budget_exceeded_at = ?, owner_id = ?, heartbeat_at = ?, lease_expires_at = ?, interrupted_at = ?, interruption_reason = ?, updated_at = ? WHERE id = ?')
      .run(next.status, next.mode, next.permissionMode, next.planVersion, next.planId, next.budgetUsd, next.budgetExceededAt, next.ownerId, next.heartbeatAt, next.leaseExpiresAt, next.interruptedAt, next.interruptionReason, Date.now(), runId)
    return this.getRun(runId)
  }

  /**
   * Take ownership of a run and start a lease. A run whose lease has expired was
   * abandoned by a process that died, which is how a restart can tell the
   * difference between "still working" and "gone".
   */
  acquireRunLease(runId, ownerId, leaseMs) {
    const now = Date.now()
    this.database.prepare('UPDATE runs SET owner_id = ?, heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?').run(ownerId, now, now + leaseMs, now, runId)
    return this.getRun(runId)
  }

  heartbeatRun(runId, ownerId, leaseMs) {
    const now = Date.now()
    const result = this.database.prepare('UPDATE runs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(now, now + leaseMs, now, runId, ownerId)
    return Number(result.changes) > 0
  }

  releaseRunLease(runId, ownerId) {
    this.database.prepare('UPDATE runs SET owner_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND owner_id = ?').run(Date.now(), runId, ownerId)
  }

  /** Runs that claim to be active but whose owner is gone or whose lease lapsed. */
  listStrandedRuns(now = Date.now()) {
    return this.database.prepare("SELECT * FROM runs WHERE status IN ('executing', 'paused') AND (lease_expires_at IS NULL OR lease_expires_at < ?) ORDER BY updated_at ASC").all(now).map(runFromRow)
  }

  markRunInterrupted(runId, reason) {
    const now = Date.now()
    this.database.prepare('UPDATE runs SET interrupted_at = ?, interruption_reason = ?, owner_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?').run(now, reason, now, runId)
    return this.getRun(runId)
  }

  appendMessage({ projectId, runId, role, agentId = null, content, metadata = {} }) {
    this.database.prepare('INSERT INTO messages(project_id, run_id, role, agent_id, content, metadata_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(projectId, runId, role, agentId, content, JSON.stringify(metadata), Date.now())
    const row = this.database.prepare('SELECT * FROM messages WHERE run_id = ? ORDER BY id DESC LIMIT 1').get(runId)
    return row ? messageFromRow(row) : null
  }

  listMessages(runId) {
    return this.database.prepare('SELECT * FROM messages WHERE run_id = ? ORDER BY created_at ASC, id ASC').all(runId).map(messageFromRow)
  }

  /**
   * Append an event and link it to the previous one by hash. The chain makes
   * edits, deletions, and reordering detectable after the fact, which is the
   * whole point of keeping an audit log.
   */
  appendEvent({ runId, type, agentId = null, payload = {} }) {
    const previous = this.database.prepare('SELECT sequence, hash FROM run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1').get(runId)
    const sequence = Number(previous?.sequence ?? 0) + 1
    const prevHash = previous?.hash ?? genesisHash
    const createdAt = Date.now()
    const body = { runId, sequence, type, agentId, payload, createdAt }
    const hash = createHash('sha256').update(`${prevHash}\n${canonicalJson(body)}`, 'utf8').digest('hex')
    const event = { eventId: `evt-${randomUUID()}`, runId, ...body, prevHash, hash }

    this.database.prepare('INSERT INTO run_events(event_id, run_id, sequence, type, agent_id, payload_json, prev_hash, hash, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(event.eventId, runId, sequence, type, agentId, JSON.stringify(payload), prevHash, hash, createdAt)
    this.database.prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run(createdAt, runId)
    if (this.deferredEvents) this.deferredEvents.push(event)
    else this.notifyEvent(event)
    return event
  }

  listEvents(runId, afterSequence = 0) {
    return this.database.prepare('SELECT * FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC').all(runId, afterSequence).map(eventFromRow)
  }

  /**
   * Recompute the chain and report the first event that does not match, plus
   * whether the recorded head is still present.
   *
   * Events written before hash chaining existed carry no hash. Those cannot be
   * verified, so they are counted separately rather than reported as tampering:
   * claiming a legacy event is intact would be as dishonest as claiming it was
   * altered.
   */
  verifyEventChain(runId) {
    const rows = this.database.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC').all(runId)
    const checkpoint = this.getLatestCheckpoint(runId)
    const anchor = this.latestAnchor(runId)
    let prevHash = genesisHash
    let checked = 0
    let unverifiable = 0
    for (const row of rows) {
      const event = eventFromRow(row)
      if (!event.hash) {
        unverifiable += 1
        continue
      }
      const body = { runId: event.runId, sequence: event.sequence, type: event.type, agentId: event.agentId, payload: event.payload, createdAt: event.createdAt }
      const expected = createHash('sha256').update(`${prevHash}\n${canonicalJson(body)}`, 'utf8').digest('hex')
      if (event.prevHash !== prevHash || event.hash !== expected) {
        return { ok: false, checked, unverifiable, total: rows.length, brokenAt: event.sequence, eventId: event.eventId, checkpoint, anchor, truncated: false, anchored: false, checkpointMissing: false }
      }
      prevHash = expected
      checked += 1
    }

    // The chain is internally consistent. Whether the tail is intact is a
    // different question: deleting the last events would leave every remaining
    // link valid, so the anchor is what makes truncation detectable. There are two
    // of them, and the one outside the database is the one that survives the row
    // being deleted with the events.
    const lastSequence = rows.length ? Number(rows[rows.length - 1].sequence) : 0
    const recorded = [checkpoint?.sequence, anchor?.sequence].filter((value) => Number.isFinite(value))
    const highest = recorded.length ? Math.max(...recorded) : null
    const truncated = highest !== null && lastSequence < highest
    const anchored = highest === null || lastSequence >= highest
    const checkpointHashIntact = !checkpoint || !checkpoint.hash || rows.some((row) => row.sequence === checkpoint.sequence && row.hash === checkpoint.hash)
    // An anchor exists for this run but the row that recorded it does not: the row
    // was removed, which is a deletion rather than a run that never anchored.
    const checkpointMissing = Boolean(anchor && !checkpoint)

    return {
      ok: anchored && checkpointHashIntact && !checkpointMissing,
      checked,
      unverifiable,
      total: rows.length,
      brokenAt: null,
      checkpoint,
      anchor,
      anchored,
      truncated,
      checkpointHashIntact,
      checkpointMissing,
      // The first sequence covered by the chain, for an honest summary line.
      verifiedFrom: rows.find((row) => row.hash)?.sequence ?? null,
    }
  }

  recordAuditCheckpoint(runId, { source = 'manual', note = null } = {}) {
    const head = this.database.prepare('SELECT sequence, hash FROM run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1').get(runId)
    if (!head) return null
    const count = Number(this.database.prepare('SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?').get(runId).count)
    this.database.prepare('INSERT INTO audit_checkpoints(run_id, sequence, hash, event_count, anchored_at, source, note) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(runId, Number(head.sequence), head.hash ?? null, count, Date.now(), source, note)
    const checkpoint = this.getLatestCheckpoint(runId)
    this.appendAnchor(checkpoint)
    return checkpoint
  }

  /**
   * Record the anchored head outside the database.
   *
   * A checkpoint inside the file cannot survive someone deleting the file's
   * contents, which is exactly what tampering looks like. An append-only line
   * elsewhere turns "delete some rows" into "delete some rows and also edit a file
   * you had to know about", and it is what verification compares against.
   */
  appendAnchor(checkpoint) {
    if (!this.anchorFile || !checkpoint) return
    const line = `${canonicalJson({ runId: checkpoint.runId, sequence: checkpoint.sequence, hash: checkpoint.hash, eventCount: checkpoint.eventCount, anchoredAt: checkpoint.anchoredAt, source: checkpoint.source })}\n`
    try {
      appendFileSync(this.anchorFile, line, 'utf8')
    } catch (error) {
      // Losing the anchor must not lose the checkpoint that was just recorded, but
      // it is worth saying out loud rather than discovering later.
      console.error(`[fulkrum] could not append to the anchor file ${this.anchorFile}: ${error instanceof Error ? error.message : error}`)
    }
  }

  /** Every anchor line, oldest first. A missing or unreadable file reads as none. */
  readAnchors() {
    if (!this.anchorFile) return []
    try {
      return readFileSync(this.anchorFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }

  latestAnchor(runId) {
    const anchors = this.readAnchors().filter((anchor) => anchor.runId === runId)
    return anchors.length ? anchors[anchors.length - 1] : null
  }

  /**
   * What the audit chain records about a tool result: the hash of the payload and
   * its size, never the payload itself.
   *
   * Every output used to be stored twice — once on the tool call, once inside the
   * chain — and the copy inside the chain can never be pruned without breaking
   * verification, which is how a retention policy ends up shrinking nothing. The
   * chain still commits to the exact content, so an altered result is as
   * detectable as before, and the bytes live where retention can reach them.
   */
  summarizeOutput(output) {
    const serialized = JSON.stringify(output ?? null)
    return { outputSha256: createHash('sha256').update(serialized, 'utf8').digest('hex'), outputBytes: Buffer.byteLength(serialized, 'utf8') }
  }

  /** The same treatment for an input whose bulk is file content. */
  summarizeInput(input) {
    if (!input || typeof input !== 'object' || typeof input.content !== 'string') return input
    const { content, ...rest } = input
    return { ...rest, contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'), contentBytes: Buffer.byteLength(content, 'utf8') }
  }

  /**
   * A consistent copy of the database without stopping the process: VACUUM INTO
   * writes a complete file from the current contents. Rotation keeps the newest
   * few, because a backup that fills the disk is its own outage. The anchor log is
   * copied alongside, so restoring both together does not look like tampering.
   */
  backup({ directory = path.join(path.dirname(this.filePath), 'backups'), keep = Number(process.env.FULKRUM_BACKUP_KEEP ?? 7), now = new Date() } = {}) {
    mkdirSync(directory, { recursive: true })
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    const target = path.join(directory, `fulkrum-${stamp}.sqlite`)
    this.database.prepare('VACUUM INTO ?').run(target)

    let anchorCopy = null
    if (this.anchorFile) {
      anchorCopy = path.join(directory, `audit-heads-${stamp}.log`)
      try {
        copyFileSync(this.anchorFile, anchorCopy)
      } catch {
        anchorCopy = null
      }
    }

    const removed = []
    const existing = readdirSync(directory).filter((name) => /^fulkrum-.*\.sqlite$/.test(name)).sort()
    for (const name of existing.slice(0, Math.max(existing.length - keep, 0))) {
      rmSync(path.join(directory, name), { force: true })
      removed.push(name)
    }
    return { path: target, anchorPath: anchorCopy, removed, keep }
  }

  getLatestCheckpoint(runId) {
    const row = this.database.prepare('SELECT * FROM audit_checkpoints WHERE run_id = ? ORDER BY sequence DESC, anchored_at DESC LIMIT 1').get(runId)
    if (!row) return null
    return {
      id: Number(row.id),
      runId: row.run_id,
      sequence: Number(row.sequence),
      hash: row.hash ?? null,
      eventCount: Number(row.event_count),
      anchoredAt: Number(row.anchored_at),
      source: row.source,
      note: row.note ?? null,
    }
  }

  verifyAllEventChains() {
    const runIds = this.database.prepare('SELECT DISTINCT run_id FROM run_events ORDER BY run_id').all().map((row) => String(row.run_id))
    const results = runIds.map((runId) => ({ runId, ...this.verifyEventChain(runId) }))
    return {
      ok: results.every((result) => result.ok),
      runs: results.length,
      details: results,
      eventsChecked: results.reduce((total, result) => total + result.checked, 0),
      eventsUnverifiable: results.reduce((total, result) => total + result.unverifiable, 0),
      // A chain can be internally valid and still have lost its tail, so both are
      // reported separately rather than folded into one boolean.
      broken: results.filter((result) => !result.ok && !result.truncated && result.checkpointHashIntact !== false && !result.checkpointMissing),
      truncated: results.filter((result) => result.truncated),
      anchorMismatch: results.filter((result) => result.checkpoint && !result.checkpointHashIntact),
      // An anchor outside the database with no row to match it means the row was
      // deleted, which a checkpoint-only scheme cannot notice.
      anchorOrphaned: results.filter((result) => result.checkpointMissing),
    }
  }

  subscribeEvents(runId, listener) {
    const listeners = this.eventListeners.get(runId) ?? new Set()
    listeners.add(listener)
    this.eventListeners.set(runId, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.eventListeners.delete(runId)
    }
  }

  /**
   * Frames that are not audit records: text as it is being written.
   *
   * A half-finished reply is not a fact about what happened — the finished text is
   * recorded as a message and an event when the call returns — so these are pushed
   * to whoever is watching and never written to the database.
   */
  publishEphemeral(runId, frame) {
    for (const listener of this.ephemeralListeners.get(runId) ?? []) {
      try {
        listener(frame)
      } catch {
        // A dropped stream must not interrupt the call that is producing text.
      }
    }
  }

  subscribeEphemeral(runId, listener) {
    const listeners = this.ephemeralListeners.get(runId) ?? new Set()
    listeners.add(listener)
    this.ephemeralListeners.set(runId, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.ephemeralListeners.delete(runId)
    }
  }

  /** Text that has arrived for a call still in flight, so a reload shows it. */
  setPartial(runId, text) {
    if (text) this.partials.set(runId, text)
    else this.partials.delete(runId)
  }

  getPartial(runId) {
    return this.partials.get(runId) ?? null
  }

  /**
   * A sink for one streamed call: it accumulates for a reader that arrives late and
   * publishes each piece as it lands. `done()` clears the partial and returns what
   * was accumulated.
   */
  partialSink(runId, { role = 'head' } = {}) {
    let text = ''
    return {
      push: (delta) => {
        text += delta
        this.setPartial(runId, text)
        this.publishEphemeral(runId, { kind: 'text', role, delta })
      },
      done: () => {
        this.setPartial(runId, null)
        return text
      },
    }
  }

  createTask({ runId, agentId, title, instructions, planTaskId = null, id = `task-${randomUUID()}` }) {
    const now = Date.now()
    this.database.prepare('INSERT INTO run_tasks(id, run_id, agent_id, title, instructions, status, plan_task_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, runId, agentId, title, instructions, 'queued', planTaskId, now, now)
    return this.getTask(id)
  }

  getTask(taskId) {
    const row = this.database.prepare('SELECT * FROM run_tasks WHERE id = ?').get(taskId)
    return row ? taskFromRow(row) : null
  }

  updateTask(taskId, patch = {}) {
    const current = this.getTask(taskId)
    if (!current) throw new Error(`Task not found: ${taskId}`)
    const next = {
      status: patch.status ?? current.status,
      result: patch.result ?? current.result,
      stepCount: patch.stepCount ?? current.stepCount,
    }
    this.database.prepare('UPDATE run_tasks SET status = ?, result = ?, step_count = ?, updated_at = ? WHERE id = ?').run(next.status, next.result, next.stepCount, Date.now(), taskId)
    return this.getTask(taskId)
  }

  listTasks(runId) {
    return this.database.prepare('SELECT * FROM run_tasks WHERE run_id = ? ORDER BY created_at ASC').all(runId).map(taskFromRow)
  }

  /**
   * The turns a task has already taken. Appended as the agent loop runs, so a
   * restart can continue the same conversation instead of starting it again.
   */
  appendTaskTurn(taskId, message) {
    const row = this.database.prepare('SELECT COALESCE(MAX(turn_index), -1) + 1 AS next FROM task_turns WHERE task_id = ?').get(taskId)
    this.database.prepare('INSERT INTO task_turns(task_id, turn_index, message_json, created_at) VALUES(?, ?, ?, ?)')
      .run(taskId, Number(row?.next ?? 0), JSON.stringify(message), Date.now())
  }

  listTaskTurns(taskId) {
    return this.database
      .prepare('SELECT message_json FROM task_turns WHERE task_id = ? ORDER BY turn_index ASC')
      .all(taskId)
      .map((row) => parseJson(row.message_json, null))
      .filter(Boolean)
  }

  countTaskTurns(taskId) {
    return Number(this.database.prepare('SELECT COUNT(*) AS count FROM task_turns WHERE task_id = ?').get(taskId).count)
  }

  createToolCall({ runId, agentId = null, name, kind, input = {}, rawInput = null, resolved = null, fingerprint = null, idempotencyKey = null, status = 'requested', ruleId = null, warnings = [], id = `tool-${randomUUID()}` }) {
    const now = Date.now()
    this.database.prepare('INSERT INTO tool_calls(id, run_id, agent_id, name, kind, status, input_json, resolved_json, call_fingerprint, idempotency_key, rule_id, warnings_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, runId, agentId, name, kind, status, JSON.stringify(input), resolved ? JSON.stringify(resolved) : null, fingerprint, idempotencyKey, ruleId, JSON.stringify(warnings ?? []), now)
    if (rawInput !== null && rawInput !== undefined) {
      this.database.prepare('INSERT INTO tool_call_inputs(tool_call_id, raw_json, created_at) VALUES(?, ?, ?)').run(id, JSON.stringify(rawInput), now)
    }
    return this.getToolCall(id)
  }

  /**
   * The arguments as the model sent them. `input` on the row is redacted for
   * display, so anything that executes a call must read it from here.
   */
  getToolCallInput(toolCallId) {
    const row = this.database.prepare('SELECT raw_json FROM tool_call_inputs WHERE tool_call_id = ?').get(toolCallId)
    return row ? parseJson(row.raw_json, null) : null
  }

  findToolCallByIdempotencyKey(runId, idempotencyKey) {
    if (!idempotencyKey) return null
    const row = this.database.prepare('SELECT * FROM tool_calls WHERE run_id = ? AND idempotency_key = ? LIMIT 1').get(runId, idempotencyKey)
    return row ? toolCallFromRow(row) : null
  }

  getToolCall(toolCallId) {
    const row = this.database.prepare('SELECT * FROM tool_calls WHERE id = ?').get(toolCallId)
    return row ? toolCallFromRow(row) : null
  }

  updateToolCall(toolCallId, patch = {}) {
    const current = this.getToolCall(toolCallId)
    if (!current) throw new Error(`Tool call not found: ${toolCallId}`)
    const next = {
      status: patch.status ?? current.status,
      output: patch.output === undefined ? current.output : patch.output,
      error: patch.error === undefined ? (['running', 'completed'].includes(patch.status) ? null : current.error) : patch.error,
      completedAt: patch.completedAt ?? (patch.status && !['running', 'requested', 'intent'].includes(patch.status) ? Date.now() : current.completedAt),
      approvedAt: patch.approvedAt === undefined ? current.approvedAt : patch.approvedAt,
      approvalScope: patch.approvalScope === undefined ? current.approvalScope : patch.approvalScope,
      attempt: patch.attempt ?? current.attempt,
    }
    this.database.prepare('UPDATE tool_calls SET status = ?, output_json = ?, error = ?, completed_at = ?, approved_at = ?, approval_scope = ?, attempt = ? WHERE id = ?')
      .run(next.status, next.output === null ? null : JSON.stringify(next.output), next.error, next.completedAt, next.approvedAt, next.approvalScope, next.attempt, toolCallId)
    return this.getToolCall(toolCallId)
  }

  markToolCallApproved(toolCallId, scope = 'once') {
    this.database.prepare('UPDATE tool_calls SET approved_at = ?, approval_scope = ? WHERE id = ?').run(Date.now(), scope, toolCallId)
    return this.getToolCall(toolCallId)
  }

  listToolCalls(runId) {
    return this.database.prepare('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY created_at ASC').all(runId).map(toolCallFromRow)
  }

  getRunSnapshot(runId) {
    const run = this.getRun(runId)
    if (!run) return null
    return { run, messages: this.listMessages(runId), tasks: this.listTasks(runId), toolCalls: this.listToolCalls(runId), events: this.listEvents(runId) }
  }

  recordModelCall({ runId = null, taskId = null, spanId = null, role = null, provider, model, status = 'ok', usage = null, cost = null, latencyMs = null, id = `call-${randomUUID()}` }) {
    this.database.prepare(`INSERT INTO model_calls(id, run_id, task_id, span_id, role, provider, model, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, billable_input_tokens, cost_usd, priced, price_version, latency_ms, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      runId,
      taskId,
      spanId,
      role,
      provider,
      model,
      status,
      usage?.inputTokens ?? 0,
      usage?.outputTokens ?? 0,
      usage?.cacheReadTokens ?? 0,
      usage?.cacheWriteTokens ?? 0,
      usage?.reasoningTokens ?? 0,
      usage?.billableInputTokens ?? 0,
      cost?.costUsd ?? null,
      cost?.priced ? 1 : 0,
      cost?.version ?? null,
      latencyMs,
      Date.now(),
    )
    return id
  }

  listModelCalls(runId) {
    return this.database.prepare('SELECT * FROM model_calls WHERE run_id = ? ORDER BY created_at ASC').all(runId).map((row) => ({
      id: row.id,
      runId: row.run_id,
      taskId: row.task_id,
      spanId: row.span_id,
      role: row.role,
      provider: row.provider,
      model: row.model,
      status: row.status,
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
      reasoningTokens: Number(row.reasoning_tokens),
      costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
      priced: Number(row.priced) === 1,
      priceVersion: row.price_version,
      latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
      createdAt: Number(row.created_at),
    }))
  }

  /**
   * A run's spend. `unpricedCalls` is reported separately so an unknown model
   * cannot masquerade as a free one.
   */
  spendForRun(runId) {
    const row = this.database.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS calls, SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END) AS unpriced FROM model_calls WHERE run_id = ?').get(runId)
    return { costUsd: Number(row?.cost ?? 0), calls: Number(row?.calls ?? 0), unpricedCalls: Number(row?.unpriced ?? 0) }
  }

  spendSince(timestamp) {
    const row = this.database.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS calls, SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END) AS unpriced FROM model_calls WHERE created_at >= ?').get(timestamp)
    return { costUsd: Number(row?.cost ?? 0), calls: Number(row?.calls ?? 0), unpricedCalls: Number(row?.unpriced ?? 0) }
  }

  startSpan({ runId, parentSpanId = null, kind, name, attributes = {}, id = `span-${randomUUID()}` }) {
    const now = Date.now()
    this.database.prepare('INSERT INTO spans(id, run_id, parent_span_id, kind, name, status, started_at, attributes_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, runId, parentSpanId, kind, name, 'running', now, JSON.stringify(attributes))
    return { id, startedAt: now }
  }

  endSpan(spanId, { status = 'ok', attributes = null } = {}) {
    const now = Date.now()
    if (attributes) {
      const row = this.database.prepare('SELECT attributes_json FROM spans WHERE id = ?').get(spanId)
      const merged = { ...parseJson(row?.attributes_json, {}), ...attributes }
      this.database.prepare('UPDATE spans SET status = ?, ended_at = ?, attributes_json = ? WHERE id = ?').run(status, now, JSON.stringify(merged), spanId)
      return
    }
    this.database.prepare('UPDATE spans SET status = ?, ended_at = ? WHERE id = ?').run(status, now, spanId)
  }

  listSpans(runId) {
    return this.database.prepare('SELECT * FROM spans WHERE run_id = ? ORDER BY started_at ASC').all(runId).map((row) => ({
      id: row.id,
      runId: row.run_id,
      parentSpanId: row.parent_span_id,
      kind: row.kind,
      name: row.name,
      status: row.status,
      startedAt: Number(row.started_at),
      endedAt: row.ended_at === null ? null : Number(row.ended_at),
      durationMs: row.ended_at === null ? null : Number(row.ended_at) - Number(row.started_at),
      attributes: parseJson(row.attributes_json),
    }))
  }

  /** A run's trace: spans, priced calls, where the money went, and the totals. */
  getRunTrace(runId) {
    return { spans: this.listSpans(runId), calls: this.listModelCalls(runId), spend: this.spendForRun(runId), byTask: this.spendByTask(runId) }
  }

  /**
   * What each task cost.
   *
   * Calls with no task are the supervisor's own — planning, chat, and the review —
   * and are reported as such rather than being dropped or attributed to a worker.
   */
  spendByTask(runId) {
    const rows = this.database
      .prepare(`SELECT task_id,
          COALESCE(SUM(cost_usd), 0) AS cost,
          COUNT(*) AS calls,
          SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END) AS unpriced,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens
        FROM model_calls WHERE run_id = ? GROUP BY task_id`)
      .all(runId)
    const tasks = new Map(this.listTasks(runId).map((task) => [task.id, task]))
    return rows.map((row) => ({
      taskId: row.task_id ?? null,
      title: row.task_id ? tasks.get(row.task_id)?.title ?? null : 'supervisor',
      agentId: row.task_id ? tasks.get(row.task_id)?.agentId ?? null : 'head',
      costUsd: Number(row.cost ?? 0),
      calls: Number(row.calls ?? 0),
      unpricedCalls: Number(row.unpriced ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
    }))
  }

  /**
   * Spend over time, by model, and by project.
   *
   * Grouped in SQL rather than in the caller: a usage view over a month of runs is
   * not something to assemble row by row.
   */
  usageSummary({ days = 30, projectId = null, now = Date.now() } = {}) {
    const window = Math.min(Math.max(Number(days) || 30, 1), 365)
    const since = now - window * 24 * 60 * 60 * 1000
    const scope = projectId ? 'AND r.project_id = ?' : ''
    const args = projectId ? [since, projectId] : [since]
    const group = (expression, alias) => this.database
      .prepare(`SELECT ${expression} AS ${alias}, COALESCE(SUM(c.cost_usd), 0) AS cost, COUNT(*) AS calls,
          SUM(CASE WHEN c.priced = 0 THEN 1 ELSE 0 END) AS unpriced
        FROM model_calls c LEFT JOIN runs r ON r.id = c.run_id
        WHERE c.created_at >= ? ${scope} GROUP BY ${alias} ORDER BY cost DESC`)
      .all(...args)
      .map((row) => ({ key: row[alias] ?? 'unknown', costUsd: Number(row.cost ?? 0), calls: Number(row.calls ?? 0), unpricedCalls: Number(row.unpriced ?? 0) }))

    const byDay = this.database
      .prepare(`SELECT date(c.created_at / 1000, 'unixepoch', 'localtime') AS day, COALESCE(SUM(c.cost_usd), 0) AS cost, COUNT(*) AS calls,
          SUM(CASE WHEN c.priced = 0 THEN 1 ELSE 0 END) AS unpriced
        FROM model_calls c LEFT JOIN runs r ON r.id = c.run_id
        WHERE c.created_at >= ? ${scope} GROUP BY day ORDER BY day ASC`)
      .all(...args)
      .map((row) => ({ day: row.day, costUsd: Number(row.cost ?? 0), calls: Number(row.calls ?? 0), unpricedCalls: Number(row.unpriced ?? 0) }))

    const totals = byDay.reduce((sum, row) => ({ costUsd: sum.costUsd + row.costUsd, calls: sum.calls + row.calls, unpricedCalls: sum.unpricedCalls + row.unpricedCalls }), { costUsd: 0, calls: 0, unpricedCalls: 0 })
    return { since, days: window, totals, byDay, byModel: group('c.model', 'model'), byProvider: group('c.provider', 'provider'), byRole: group('c.role', 'role') }
  }

  /**
   * What a plan is likely to cost, as a range from this database's own history.
   *
   * Cost is only known after a call returns, so this cannot be a number. It reports
   * the basis it used and says when there is no history to base it on, rather than
   * presenting a guess as an estimate.
   */
  estimateRunCost(runId, { callsPerTask = Number(process.env.FULKRUM_ESTIMATE_CALLS_PER_TASK ?? 4) } = {}) {
    const run = this.getRun(runId)
    if (!run) return null
    const plan = (run.planId ? this.getPlan(run.planId) : null) ?? this.getLatestPlanForRun(runId)
    const tasks = plan?.tasks.length ?? 0
    const observed = this.database.prepare('SELECT COUNT(*) AS calls, AVG(cost_usd) AS average, MIN(cost_usd) AS low, MAX(cost_usd) AS high, SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END) AS unpriced FROM model_calls WHERE priced = 1').get()
    const pricedCalls = Number(observed?.calls ?? 0)
    // One call per step, each task ending with a summary, plus planning and review.
    const expectedCalls = tasks * Math.max(Number(callsPerTask) || 1, 1) + 2
    if (!pricedCalls) {
      return { runId, tasks, expectedCalls, basis: 'no priced calls in this database yet', estimateUsd: null, perCall: null }
    }
    const average = Number(observed.average ?? 0)
    const low = Number(observed.low ?? 0)
    const high = Number(observed.high ?? 0)
    return {
      runId,
      tasks,
      expectedCalls,
      basis: `from ${pricedCalls} priced call(s) in this database${Number(observed.unpriced ?? 0) ? `, ${observed.unpriced} unpriced and excluded` : ''}`,
      perCall: { average, low, high },
      estimateUsd: { low: Number((low * expectedCalls).toFixed(4)), average: Number((average * expectedCalls).toFixed(4)), high: Number((high * expectedCalls).toFixed(4)) },
      ceilingUsd: run.budgetUsd ?? null,
    }
  }

  nextPlanVersion(projectId) {
    const row = this.database.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM plans WHERE project_id = ?').get(projectId)
    return Number(row?.next_version ?? 1)
  }

  /**
   * Store a plan. Drafts for the same run are superseded, so an approval can only
   * ever point at the newest version the user was actually shown.
   */
  createPlan({ projectId, runId = null, objective, tasks, contentHash, source = 'model', id = `plan-${randomUUID()}` }) {
    const now = Date.now()
    const version = this.nextPlanVersion(projectId)
    this.transaction(() => {
      if (runId) this.database.prepare("UPDATE plans SET status = 'superseded' WHERE run_id = ? AND status = 'draft'").run(runId)
      this.database.prepare('INSERT INTO plans(id, project_id, run_id, version, objective, content_hash, status, source, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, projectId, runId, version, objective, contentHash, 'draft', source, now)
      const insertTask = this.database.prepare('INSERT INTO plan_tasks(id, plan_id, order_index, role, title, instructions, acceptance_check, depends_on_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      tasks.forEach((task, index) => {
        insertTask.run(`plantask-${randomUUID()}`, id, index, task.role, task.title, task.instructions, task.acceptanceCheck ?? '', JSON.stringify(task.dependsOn ?? []), now)
      })
    })
    return this.getPlan(id)
  }

  getPlan(planId) {
    const row = this.database.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
    if (!row) return null
    return {
      plan: planFromRow(row),
      tasks: this.database.prepare('SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY order_index ASC').all(planId).map(planTaskFromRow),
    }
  }

  getLatestPlanForRun(runId) {
    const row = this.database.prepare('SELECT * FROM plans WHERE run_id = ? ORDER BY version DESC LIMIT 1').get(runId)
    return row ? this.getPlan(row.id) : null
  }

  approvePlan(planId) {
    this.database.prepare("UPDATE plans SET status = 'approved', approved_at = ? WHERE id = ?").run(Date.now(), planId)
    return this.getPlan(planId)
  }

  /** Create the execution rows for a plan, reusing any that already exist. */
  materializeRunTasks({ runId, plan }) {
    const existing = this.listTasks(runId)
    return this.transaction(() => plan.tasks.map((planTask) => {
      const match = existing.find((task) => task.planTaskId === planTask.id)
      if (match) return match
      return this.createTask({
        runId,
        agentId: planTask.role,
        title: planTask.title,
        instructions: planTask.instructions,
        planTaskId: planTask.id,
      })
    }))
  }

  /**
   * Record that the user allowed a tool for the rest of a run. A grant only ever
   * turns "ask" into "allow": deny rules are evaluated first and are never
   * overridden, so credentials and path escapes stay refused.
   */
  grantApproval({ runId, toolName, kind, grantedBy = 'user' }) {
    this.database.prepare(`INSERT INTO approval_grants(id, run_id, tool_name, kind, granted_at, granted_by, revoked_at)
      VALUES(?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(run_id, tool_name) DO UPDATE SET granted_at = excluded.granted_at, granted_by = excluded.granted_by, kind = excluded.kind, revoked_at = NULL`)
      .run(`grant-${randomUUID()}`, runId, toolName, kind, Date.now(), grantedBy)
    return this.findActiveGrant(runId, toolName)
  }

  findActiveGrant(runId, toolName) {
    const row = this.database.prepare('SELECT * FROM approval_grants WHERE run_id = ? AND tool_name = ? AND revoked_at IS NULL').get(runId, toolName)
    if (!row) return null
    return { id: row.id, runId: row.run_id, toolName: row.tool_name, kind: row.kind, grantedAt: Number(row.granted_at), grantedBy: row.granted_by }
  }

  listApprovalGrants(runId, { includeRevoked = false } = {}) {
    const rows = includeRevoked
      ? this.database.prepare('SELECT * FROM approval_grants WHERE run_id = ? ORDER BY granted_at ASC').all(runId)
      : this.database.prepare('SELECT * FROM approval_grants WHERE run_id = ? AND revoked_at IS NULL ORDER BY granted_at ASC').all(runId)
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      toolName: row.tool_name,
      kind: row.kind,
      grantedAt: Number(row.granted_at),
      grantedBy: row.granted_by,
      revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
    }))
  }

  revokeApprovalGrant(runId, toolName) {
    const result = this.database.prepare('UPDATE approval_grants SET revoked_at = ? WHERE run_id = ? AND tool_name = ? AND revoked_at IS NULL').run(Date.now(), runId, toolName)
    return Number(result.changes) > 0
  }

  /**
   * A grant that keeps applying to later runs, bounded by a scope.
   *
   * Creation and revocation are recorded in the maintenance log: they are security
   * decisions with no run of their own to attach to, and a reader needs to know when
   * one was made and when it stopped.
   */
  createStandingGrant({ toolName, scopeKind, scopeValue, label, createdBy = 'user', id = `standing-${randomUUID()}` }) {
    const now = Date.now()
    this.database.prepare('INSERT INTO standing_grants(id, tool_name, scope_kind, scope_value, label, created_at, created_by) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(id, toolName, scopeKind, scopeValue, label, now, createdBy)
    this.recordMaintenance({ kind: 'standing-grant', ok: true, summary: `allowed ${label}`, payload: { action: 'created', id, toolName, scopeKind, scopeValue } })
    return this.getStandingGrant(id)
  }

  getStandingGrant(grantId) {
    const row = this.database.prepare('SELECT * FROM standing_grants WHERE id = ?').get(grantId)
    return row ? standingGrantFromRow(row) : null
  }

  listStandingGrants({ includeRevoked = false } = {}) {
    const rows = includeRevoked
      ? this.database.prepare('SELECT * FROM standing_grants ORDER BY created_at DESC').all()
      : this.database.prepare('SELECT * FROM standing_grants WHERE revoked_at IS NULL ORDER BY created_at DESC').all()
    return rows.map(standingGrantFromRow)
  }

  revokeStandingGrant(grantId) {
    const grant = this.getStandingGrant(grantId)
    if (!grant || grant.revokedAt) return null
    this.database.prepare('UPDATE standing_grants SET revoked_at = ? WHERE id = ?').run(Date.now(), grantId)
    this.recordMaintenance({ kind: 'standing-grant', ok: true, summary: `revoked ${grant.label}`, payload: { action: 'revoked', id: grantId, toolName: grant.toolName, scopeKind: grant.scopeKind, scopeValue: grant.scopeValue } })
    return this.getStandingGrant(grantId)
  }

  /**
   * The standing grant that covers this call, if one does. Using one records that
   * it was used, so a grant nobody needs can be recognised and revoked.
   */
  findStandingGrant({ toolName, resolved }) {
    const candidates = this.database.prepare('SELECT * FROM standing_grants WHERE tool_name = ? AND revoked_at IS NULL').all(toolName)
    const match = candidates.map(standingGrantFromRow).find((grant) => standingScopeMatches(grant, resolved))
    if (!match) return null
    this.database.prepare('UPDATE standing_grants SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?').run(Date.now(), match.id)
    return match
  }

  listCustomProviders() {
    return this.database.prepare('SELECT * FROM provider_configs ORDER BY label ASC').all().map((row) => ({
      id: row.id,
      label: row.label,
      protocol: row.protocol,
      baseUrl: row.base_url,
      defaultModel: row.model,
      envKey: row.env_key ?? '',
      custom: true,
    }))
  }

  saveCustomProvider(provider) {
    const now = Date.now()
    this.database.prepare(`INSERT INTO provider_configs(id, label, protocol, base_url, model, env_key, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, protocol = excluded.protocol, base_url = excluded.base_url, model = excluded.model, env_key = excluded.env_key, updated_at = excluded.updated_at`).run(provider.id, provider.label, provider.protocol, provider.baseUrl, provider.defaultModel, provider.envKey ?? '', now, now)
    return this.listCustomProviders().find((item) => item.id === provider.id)
  }

  removeCustomProvider(providerId) {
    const result = this.database.prepare('DELETE FROM provider_configs WHERE id = ?').run(providerId)
    return Number(result.changes) > 0
  }

  getProviderSettings(providerId) {
    const row = this.database.prepare('SELECT * FROM provider_settings WHERE provider_id = ?').get(providerId)
    return row ? providerSettingsFromRow(row) : null
  }

  listProviderSettings() {
    return this.database.prepare('SELECT * FROM provider_settings').all().map(providerSettingsFromRow)
  }

  /** Upsert a partial change: only the fields present in the patch are touched. */
  saveProviderSettings(providerId, patch = {}) {
    const current = this.getProviderSettings(providerId)
    const next = {
      apiKey: patch.apiKey === undefined ? current?.apiKey ?? null : patch.apiKey,
      authStyle: patch.authStyle ?? current?.authStyle ?? 'auto',
      authHeader: patch.authHeader === undefined ? current?.authHeader ?? null : patch.authHeader,
      headers: patch.headers === undefined ? current?.headers ?? {} : patch.headers,
      allowPrivate: patch.allowPrivate === undefined ? current?.allowPrivate ?? false : Boolean(patch.allowPrivate),
      temperature: patch.temperature ?? current?.temperature ?? 'auto',
    }
    this.database.prepare(`INSERT INTO provider_settings(provider_id, api_key, auth_style, auth_header, headers_json, allow_private, temperature, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET api_key = excluded.api_key, auth_style = excluded.auth_style, auth_header = excluded.auth_header, headers_json = excluded.headers_json, allow_private = excluded.allow_private, temperature = excluded.temperature, updated_at = excluded.updated_at`)
      .run(providerId, next.apiKey, next.authStyle, next.authHeader, JSON.stringify(next.headers), next.allowPrivate ? 1 : 0, next.temperature, Date.now())
    return this.getProviderSettings(providerId)
  }

  removeProviderSettings(providerId) {
    const result = this.database.prepare('DELETE FROM provider_settings WHERE provider_id = ?').run(providerId)
    return Number(result.changes) > 0
  }

  /**
   * Tool outputs are the bulkiest data and the least useful once a run is old,
   * so they are pruned first. Events are hash-chained and never pruned: deleting
   * one would break verification of every event after it.
   */
  pruneToolOutputs({ retentionDays = Number(process.env.FULKRUM_TOOL_OUTPUT_RETENTION_DAYS ?? 14), now = Date.now() } = {}) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { pruned: 0, prunedInputs: 0, prunedTurns: 0 }
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
    const result = this.database.prepare('UPDATE tool_calls SET output_json = NULL, output_pruned_at = ? WHERE completed_at IS NOT NULL AND completed_at < ? AND output_json IS NOT NULL').run(now, cutoff)
    // Raw inputs go with their outputs, but only for calls that can no longer be
    // approved: a pending approval must keep the arguments it will execute.
    const inputs = this.database.prepare("DELETE FROM tool_call_inputs WHERE created_at < ? AND tool_call_id IN (SELECT id FROM tool_calls WHERE status IN ('completed', 'denied', 'failed'))").run(cutoff)
    // Task turns carry tool results, so they are pruned on the same window — and
    // only for runs that can no longer be resumed.
    const turns = this.database
      .prepare("DELETE FROM task_turns WHERE created_at < ? AND task_id IN (SELECT t.id FROM run_tasks t JOIN runs r ON r.id = t.run_id WHERE r.status IN ('completed', 'cancelled', 'failed'))")
      .run(cutoff)
    return { pruned: Number(result.changes), prunedInputs: Number(inputs.changes), prunedTurns: Number(turns.changes), cutoff }
  }

  /**
   * Record what a maintenance action did.
   *
   * These are the two facts nobody can reconstruct afterwards: that the chain was
   * intact when it was checked, and that a copy exists from before something went
   * wrong. Neither follows from the state that comes after.
   */
  recordMaintenance({ kind, ok, summary, payload = {} }) {
    this.database.prepare('INSERT INTO maintenance_log(kind, ok, summary, payload_json, created_at) VALUES(?, ?, ?, ?, ?)')
      .run(kind, ok ? 1 : 0, String(summary).slice(0, 500), JSON.stringify(payload), Date.now())
    return this.lastMaintenance(kind)
  }

  lastMaintenance(kind) {
    const row = this.database.prepare('SELECT * FROM maintenance_log WHERE kind = ? ORDER BY created_at DESC LIMIT 1').get(kind)
    if (!row) return null
    return { kind: row.kind, ok: Number(row.ok) === 1, summary: row.summary, payload: parseJson(row.payload_json), createdAt: Number(row.created_at) }
  }

  listMaintenance({ limit = 20 } = {}) {
    return this.database.prepare('SELECT * FROM maintenance_log ORDER BY created_at DESC LIMIT ?').all(limit).map((row) => ({
      kind: row.kind,
      ok: Number(row.ok) === 1,
      summary: row.summary,
      createdAt: Number(row.created_at),
    }))
  }

  /** How big the database and its write-ahead log are right now. */
  storageSize() {
    const sizeOf = (target) => {
      try {
        return statSync(target).size
      } catch {
        return null
      }
    }
    const database = sizeOf(this.filePath)
    const wal = sizeOf(`${this.filePath}-wal`)
    const shm = sizeOf(`${this.filePath}-shm`)
    return { databaseBytes: database, walBytes: wal, shmBytes: shm, totalBytes: [database, wal, shm].filter((value) => value !== null).reduce((sum, value) => sum + value, 0) }
  }

  /** Every run's chain, walked. Expensive on a large database, so it is on demand. */
  verifyEverything() {
    return this.verifyAllEventChains()
  }

  /** When the newest backup was taken, so a daily one can be skipped. */
  backupStatus({ directory = path.join(path.dirname(this.filePath), 'backups') } = {}) {
    try {
      const files = readdirSync(directory)
        .filter((name) => /^fulkrum-.*\.sqlite$/.test(name))
        .map((name) => ({ name, mtimeMs: statSync(path.join(directory, name)).mtimeMs }))
        .sort((left, right) => left.mtimeMs - right.mtimeMs)
      const newest = files.length ? files[files.length - 1] : null
      return { count: files.length, newestAgeMs: newest === null ? null : Date.now() - newest.mtimeMs, newestPath: newest === null ? null : path.join(directory, newest.name) }
    } catch {
      return { count: 0, newestAgeMs: null, newestPath: null }
    }
  }

  checkpoint() {
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  stats() {
    const count = (table) => Number(this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
    return {
      projects: count('projects'),
      runs: count('runs'),
      messages: count('messages'),
      events: count('run_events'),
      toolCalls: count('tool_calls'),
      schemaVersion: Number(Object.values(this.database.prepare('PRAGMA user_version').get() ?? {})[0] ?? 0),
    }
  }

  close() {
    this.eventListeners.clear()
    this.ephemeralListeners.clear()
    this.partials.clear()
    try {
      this.checkpoint()
    } catch {
      // A checkpoint failure must not stop the process from closing the handle.
    }
    this.database.close()
  }
}
