/**
 * The shapes the interface reads.
 *
 * Hand-written, and that is a trade worth stating: the OpenAPI document at
 * `/api/openapi.json` describes every route but not every field's schema, so
 * generating from it would produce types with no useful members. Describing the
 * field shapes in the spec is the follow-up; until then this file is the contract
 * the interface codes against, and the server's own tests are what keep it honest.
 */

export type Mode = 'plan' | 'review'
export type PermissionMode = 'guided' | 'selective' | 'autopilot'
export type AgentId = 'head' | 'research' | 'builder'

export type ReasoningLevel = 'minimal' | 'low' | 'medium' | 'high'

export type Project = {
  id: string
  name: string
  status?: string
  settings?: {
    routing?: Record<string, string>
    reasoning?: Partial<Record<AgentId | 'default', ReasoningLevel>>
  } & Record<string, unknown>
  createdAt?: number
  updatedAt?: number
}

export type Provider = {
  id: string
  label: string
  protocol: string
  baseUrl: string
  model: string
  envKey: string
  configured: boolean
  custom: boolean
  hasKey: boolean
  keySource: 'stored' | 'env' | null
  authStyle: string
  authHeader: string | null
  headers: Record<string, string>
  allowPrivate: boolean
  temperature: string
}

export type Run = {
  id: string
  projectId: string
  status: string
  mode: string
  permissionMode: string
  planId?: string | null
  planVersion: number
  budgetUsd: number | null
  interruptionReason?: string | null
  createdAt: number
  updatedAt: number
  objective?: string | null
  spend?: Spend
  taskCount?: number
  writes?: number
}

export type Spend = { costUsd: number; calls: number; unpricedCalls: number }

export type Task = {
  id: string
  agentId: string
  title: string
  status: string
  planTaskId?: string | null
  result?: string | null
  stepCount?: number
}

export type PlanTask = {
  id: string
  orderIndex: number
  role: string
  title: string
  instructions: string
  acceptanceCheck?: string
  dependsOn: number[]
}

export type Plan = {
  plan: { id: string; version: number; objective: string; contentHash: string; status: string; source: string; approvedAt?: number | null }
  tasks: PlanTask[]
  fallbackReason?: string | null
  created?: boolean
  demo?: boolean
}

export type RunEvent = {
  eventId: string
  runId: string
  sequence: number
  type: string
  agentId: string | null
  payload: Record<string, any>
  createdAt: number
}

export type ToolCall = {
  id: string
  runId: string
  agentId: string | null
  name: string
  kind: string
  status: string
  input: Record<string, any>
  resolved: Record<string, any> | null
  fingerprint: string | null
  ruleId: string | null
  warnings: Array<{ field: string; kinds: string[] }>
  approvalScope: string | null
  error: string | null
  createdAt: number
}

export type Artifact = {
  toolCallId: string
  agentId: string | null
  path: string
  bytes: number
  created: boolean
  previousBytes: number | null
  diffAvailable: boolean
  diff?: { added: number; removed: number; hunks: Array<{ entries: Array<{ type: string; line: string; number: number }> }>; truncated?: boolean; reason?: string }
  at: number
}

export type Estimate = {
  runId: string
  tasks: number
  expectedCalls: number
  basis: string
  estimateUsd: { low: number; average: number; high: number } | null
  perCall: { average: number; low: number; high: number } | null
  ceilingUsd: number | null
}

export type StandingGrant = {
  id: string
  toolName: string
  scopeKind: 'path' | 'host'
  scopeValue: string
  label: string
  createdAt: number
  lastUsedAt: number | null
  useCount: number
  revokedAt: number | null
}

export type Status = {
  version: string
  schemaVersion: number
  storage: { databaseBytes: number | null; walBytes: number | null; totalBytes: number }
  backups: { count: number; newestAgeMs: number | null; newestPath: string | null }
  anchor: { file: string | null; count: number }
  lastVerify: { ok: boolean; summary: string; createdAt: number } | null
  lastBackup: { ok: boolean; summary: string; createdAt: number } | null
  maintenance: Array<{ kind: string; ok: boolean; summary: string; createdAt: number }>
  execution: { available: boolean; label?: string; version?: string; image?: string; imageDigest?: string | null; imagePinned?: boolean; reason?: string; hint?: string; running?: Array<{ runId: string; container: string }> }
  providers: Array<{ id: string; label: string; configured: boolean; keySource: string | null; breaker: { failures: number; openUntil: number; open: boolean } | null }>
  retention: { toolOutputDays: number | null; source: string | null }
}

export type SearchResults = {
  query: string
  messages: Array<{ kind: 'message'; id: string; runId: string; role: string; agentId: string | null; snippet: string; createdAt: number }>
  events: Array<{ kind: 'event'; id: string; runId: string; type: string; agentId: string | null; sequence: number; snippet: string; createdAt: number }>
  truncated: boolean
}

export type TreeNode = {
  name: string
  path: string
  kind: 'file' | 'directory' | 'skipped' | 'sensitive' | 'link'
  bytes?: number | null
  children?: TreeNode[]
}

export type FileHistoryEntry = {
  id: string
  runId: string
  agentId: string | null
  name: string
  kind: string
  status: string
  approvedScope: string | null
  at: number
  bytes: number | null
  created: boolean | null
}

export type Usage = {
  since: number
  days: number
  totals: Spend
  byDay: Array<{ day: string; costUsd: number; calls: number; unpricedCalls: number }>
  byModel: Array<{ key: string; costUsd: number; calls: number; unpricedCalls: number }>
  byProvider: Array<{ key: string; costUsd: number; calls: number; unpricedCalls: number }>
  byRole: Array<{ key: string; costUsd: number; calls: number; unpricedCalls: number }>
}

export type ConfigReport = {
  settings: Array<{ name: string; group: string; description: string; configured: boolean; source: string; value: unknown; problem: string | null }>
  problems: Array<{ name: string; message: string; using: unknown }>
  providers: Array<{ id: string; label: string; envKey: string; configured: boolean; hasKey: boolean; keySource: string | null }>
}

export type AppSetting = {
  name: string
  group: string
  kind: string
  description: string
  choices: Array<string> | null
  default: unknown
  value: unknown
  source: 'env' | 'db' | 'default'
  restartRequired: boolean
  problem: string | null
}
