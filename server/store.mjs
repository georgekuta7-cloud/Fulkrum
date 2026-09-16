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
        return { ok: false, checked, unverifiable, total: rows.length, brokenAt: event.sequence, eventId: event.eventId, checkpoint, truncated: false, anchored: false }
      }
      prevHash = expected
      checked += 1
    }

    // The chain is internally consistent. Whether the tail is intact is a
    // different question: deleting the last events would leave every remaining
    // link valid, so the anchor is what makes truncation detectable.
    const lastSequence = rows.length ? Number(rows[rows.length - 1].sequence) : 0
    const anchored = !checkpoint || lastSequence >= checkpoint.sequence
    const truncated = Boolean(checkpoint && lastSequence < checkpoint.sequence)
    const checkpointHashIntact = !checkpoint || !checkpoint.hash || rows.some((row) => row.sequence === checkpoint.sequence && row.hash === checkpoint.hash)

    return {
      ok: anchored && checkpointHashIntact,
      checked,
      unverifiable,
      total: rows.length,
      brokenAt: null,
      checkpoint,
      anchored,
      truncated,
      checkpointHashIntact,
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
    return this.getLatestCheckpoint(runId)
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
      broken: results.filter((result) => !result.ok && !result.truncated && result.checkpointHashIntact !== false),
      truncated: results.filter((result) => result.truncated),
      anchorMismatch: results.filter((result) => result.checkpoint && !result.checkpointHashIntact),
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

  /** A run's trace: spans, priced calls, and the totals for the header. */
  getRunTrace(runId) {
    return { spans: this.listSpans(runId), calls: this.listModelCalls(runId), spend: this.spendForRun(runId) }
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
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (runId) this.database.prepare("UPDATE plans SET status = 'superseded' WHERE run_id = ? AND status = 'draft'").run(runId)
      this.database.prepare('INSERT INTO plans(id, project_id, run_id, version, objective, content_hash, status, source, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, projectId, runId, version, objective, contentHash, 'draft', source, now)
      const insertTask = this.database.prepare('INSERT INTO plan_tasks(id, plan_id, order_index, role, title, instructions, acceptance_check, depends_on_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      tasks.forEach((task, index) => {
        insertTask.run(`plantask-${randomUUID()}`, id, index, task.role, task.title, task.instructions, task.acceptanceCheck ?? '', JSON.stringify(task.dependsOn ?? []), now)
      })
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
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
    return plan.tasks.map((planTask) => {
      const match = existing.find((task) => task.planTaskId === planTask.id)
      if (match) return match
      return this.createTask({
        runId,
        agentId: planTask.role,
        title: planTask.title,
        instructions: planTask.instructions,
        planTaskId: planTask.id,
      })
    })
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
