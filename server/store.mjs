import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJson } from './canonicalJson.mjs'
import { applyMigrations } from './migrations.mjs'

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
    ownerId: row.owner_id ?? null,
    heartbeatAt: row.heartbeat_at === null || row.heartbeat_at === undefined ? null : Number(row.heartbeat_at),
    leaseExpiresAt: row.lease_expires_at === null || row.lease_expires_at === undefined ? null : Number(row.lease_expires_at),
    interruptedAt: row.interrupted_at === null || row.interrupted_at === undefined ? null : Number(row.interrupted_at),
    interruptionReason: row.interruption_reason ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
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
    createdAt: Number(row.created_at),
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
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.migrations = applyMigrations(this.database)
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

  updateRun(runId, patch = {}) {
    const current = this.getRun(runId)
    if (!current) throw new Error(`Run not found: ${runId}`)
    const next = {
      status: patch.status ?? current.status,
      mode: patch.mode ?? current.mode,
      permissionMode: patch.permissionMode ?? current.permissionMode,
      planVersion: patch.planVersion ?? current.planVersion,
      ownerId: patch.ownerId === undefined ? current.ownerId : patch.ownerId,
      heartbeatAt: patch.heartbeatAt === undefined ? current.heartbeatAt : patch.heartbeatAt,
      leaseExpiresAt: patch.leaseExpiresAt === undefined ? current.leaseExpiresAt : patch.leaseExpiresAt,
      interruptedAt: patch.interruptedAt === undefined ? current.interruptedAt : patch.interruptedAt,
      interruptionReason: patch.interruptionReason === undefined ? current.interruptionReason : patch.interruptionReason,
    }
    this.database.prepare('UPDATE runs SET status = ?, mode = ?, permission_mode = ?, plan_version = ?, owner_id = ?, heartbeat_at = ?, lease_expires_at = ?, interrupted_at = ?, interruption_reason = ?, updated_at = ? WHERE id = ?')
      .run(next.status, next.mode, next.permissionMode, next.planVersion, next.ownerId, next.heartbeatAt, next.leaseExpiresAt, next.interruptedAt, next.interruptionReason, Date.now(), runId)
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
    for (const listener of this.eventListeners.get(runId) ?? []) {
      try {
        listener(event)
      } catch {
        // A disconnected stream must not interrupt event persistence.
      }
    }
    return event
  }

  listEvents(runId, afterSequence = 0) {
    return this.database.prepare('SELECT * FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC').all(runId, afterSequence).map(eventFromRow)
  }

  /**
   * Recompute the chain and report the first event that does not match.
   *
   * Events written before hash chaining existed carry no hash. Those cannot be
   * verified, so they are counted separately rather than reported as tampering:
   * claiming a legacy event is intact would be as dishonest as claiming it was
   * altered.
   */
  verifyEventChain(runId) {
    const rows = this.database.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC').all(runId)
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
        return { ok: false, checked, unverifiable, total: rows.length, brokenAt: event.sequence, eventId: event.eventId }
      }
      prevHash = expected
      checked += 1
    }
    return { ok: true, checked, unverifiable, total: rows.length, brokenAt: null }
  }

  verifyAllEventChains() {
    const runIds = this.database.prepare('SELECT DISTINCT run_id FROM run_events ORDER BY run_id').all().map((row) => row.run_id)
    const results = runIds.map((runId) => ({ runId, ...this.verifyEventChain(runId) }))
    return {
      ok: results.every((result) => result.ok),
      runs: results.length,
      eventsChecked: results.reduce((total, result) => total + result.checked, 0),
      eventsUnverifiable: results.reduce((total, result) => total + result.unverifiable, 0),
      broken: results.filter((result) => !result.ok),
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

  createTask({ runId, agentId, title, instructions, id = `task-${randomUUID()}` }) {
    const now = Date.now()
    this.database.prepare('INSERT INTO run_tasks(id, run_id, agent_id, title, instructions, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(id, runId, agentId, title, instructions, 'queued', now, now)
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
    }
    this.database.prepare('UPDATE run_tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?').run(next.status, next.result, Date.now(), taskId)
    return this.getTask(taskId)
  }

  listTasks(runId) {
    return this.database.prepare('SELECT * FROM run_tasks WHERE run_id = ? ORDER BY created_at ASC').all(runId).map(taskFromRow)
  }

  createToolCall({ runId, agentId = null, name, kind, input = {}, resolved = null, fingerprint = null, idempotencyKey = null, status = 'requested', id = `tool-${randomUUID()}` }) {
    const now = Date.now()
    this.database.prepare('INSERT INTO tool_calls(id, run_id, agent_id, name, kind, status, input_json, resolved_json, call_fingerprint, idempotency_key, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, runId, agentId, name, kind, status, JSON.stringify(input), resolved ? JSON.stringify(resolved) : null, fingerprint, idempotencyKey, now)
    return this.getToolCall(id)
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

  listCustomProviders() {
    return this.database.prepare('SELECT * FROM provider_configs ORDER BY label ASC').all().map((row) => ({
      id: row.id,
      label: row.label,
      protocol: row.protocol,
      baseUrl: row.base_url,
      defaultModel: row.model,
      envKey: row.env_key,
      custom: true,
    }))
  }

  saveCustomProvider(provider) {
    const now = Date.now()
    this.database.prepare(`INSERT INTO provider_configs(id, label, protocol, base_url, model, env_key, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, protocol = excluded.protocol, base_url = excluded.base_url, model = excluded.model, env_key = excluded.env_key, updated_at = excluded.updated_at`).run(provider.id, provider.label, provider.protocol, provider.baseUrl, provider.defaultModel, provider.envKey, now, now)
    return this.listCustomProviders().find((item) => item.id === provider.id)
  }

  removeCustomProvider(providerId) {
    const result = this.database.prepare('DELETE FROM provider_configs WHERE id = ?').run(providerId)
    return Number(result.changes) > 0
  }

  /**
   * Tool outputs are the bulkiest data and the least useful once a run is old,
   * so they are pruned first. Events are hash-chained and never pruned: deleting
   * one would break verification of every event after it.
   */
  pruneToolOutputs({ retentionDays = Number(process.env.FULKRUM_TOOL_OUTPUT_RETENTION_DAYS ?? 14), now = Date.now() } = {}) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { pruned: 0 }
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
    const result = this.database.prepare('UPDATE tool_calls SET output_json = NULL, output_pruned_at = ? WHERE completed_at IS NOT NULL AND completed_at < ? AND output_json IS NOT NULL').run(now, cutoff)
    return { pruned: Number(result.changes), cutoff }
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
    try {
      this.checkpoint()
    } catch {
      // A checkpoint failure must not stop the process from closing the handle.
    }
    this.database.close()
  }
}
