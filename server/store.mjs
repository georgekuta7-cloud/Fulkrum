import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'plan',
  permission_mode TEXT NOT NULL DEFAULT 'selective',
  plan_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  agent_id TEXT,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  agent_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, sequence)
);

CREATE TABLE IF NOT EXISTS run_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS provider_configs (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  env_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_project_updated ON runs(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_run_created ON messages(run_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_events_run_sequence ON run_events(run_id, sequence ASC);
CREATE INDEX IF NOT EXISTS idx_tasks_run_updated ON run_tasks(run_id, updated_at ASC);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run_created ON tool_calls(run_id, created_at ASC);
`

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
    output: parseJson(row.output_json, null),
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
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec(schema)
    this.database.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(1, Date.now())
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

  createRun({ projectId, id = `run-${randomUUID()}`, mode = 'plan', permissionMode = 'selective' }) {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`)
    const now = Date.now()
    this.database.prepare('INSERT INTO runs(id, project_id, status, mode, permission_mode, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(id, projectId, 'planning', mode, permissionMode, now, now)
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
    }
    this.database.prepare('UPDATE runs SET status = ?, mode = ?, permission_mode = ?, plan_version = ?, updated_at = ? WHERE id = ?').run(next.status, next.mode, next.permissionMode, next.planVersion, Date.now(), runId)
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

  appendEvent({ runId, type, agentId = null, payload = {} }) {
    const sequenceRow = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM run_events WHERE run_id = ?').get(runId)
    const event = {
      eventId: `evt-${randomUUID()}`,
      runId,
      sequence: Number(sequenceRow.next_sequence),
      type,
      agentId,
      payload,
      createdAt: Date.now(),
    }
    this.database.prepare('INSERT INTO run_events(event_id, run_id, sequence, type, agent_id, payload_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(event.eventId, runId, event.sequence, type, agentId, JSON.stringify(payload), event.createdAt)
    this.database.prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run(event.createdAt, runId)
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

  createToolCall({ runId, agentId = null, name, kind, input = {}, id = `tool-${randomUUID()}` }) {
    const now = Date.now()
    this.database.prepare('INSERT INTO tool_calls(id, run_id, agent_id, name, kind, status, input_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(id, runId, agentId, name, kind, 'requested', JSON.stringify(input), now)
    return this.getToolCall(id)
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
      completedAt: patch.completedAt ?? (patch.status && !['running', 'requested'].includes(patch.status) ? Date.now() : current.completedAt),
    }
    this.database.prepare('UPDATE tool_calls SET status = ?, output_json = ?, error = ?, completed_at = ? WHERE id = ?').run(next.status, next.output === null ? null : JSON.stringify(next.output), next.error, next.completedAt, toolCallId)
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

  stats() {
    const count = (table) => Number(this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
    return { projects: count('projects'), runs: count('runs'), messages: count('messages'), events: count('run_events'), toolCalls: count('tool_calls') }
  }

  close() {
    this.eventListeners.clear()
    this.database.close()
  }
}