import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, openRunStream } from '../api/client'
import { roleLabel } from '../lib/runGraph'
import type { AgentId, AppSetting, ArsenalItem, Artifact, Claim, ConfigReport, Estimate, FileHistoryEntry, MarketplaceEntry, Plan, Project, Provider, ReasoningLevel, Run, RunEvent, SearchResults, Spend, StandingGrant, Status, Task, ToolCall, TreeNode, Usage } from '../api/types'

/**
 * Everything the interface reads, and the actions it takes, in one place.
 *
 * The alternative — each panel fetching for itself — is how an interface ends up
 * with six copies of the same snapshot and no agreement about which is current. One
 * owner of the run, its plan, its events and its cost; panels render what they are
 * given and call the actions here.
 */

const emptySpend: Spend = { costUsd: 0, calls: 0, unpricedCalls: 0 }

export type Approval = { toolCall: ToolCall; rule: string | null; warnings: Array<{ field: string; kinds: string[] }>; preview: any }

export function useBridge() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  // The open project's settings (routing, reasoning, checks): the casting the
  // graph and plan card display, and what saveRouting edits.
  const [projectSettings, setProjectSettings] = useState<Record<string, unknown>>({})
  // A history list holds summaries; the open run is fetched in full.
  const [runs, setRuns] = useState<Run[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [messages, setMessages] = useState<Array<{ id: number; role: string; agentId: string | null; content: string; createdAt: number; metadata: any }>>([])
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([])
  const [events, setEvents] = useState<RunEvent[]>([])
  const [plan, setPlan] = useState<Plan | null>(null)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [claims, setClaims] = useState<Claim[]>([])
  const [spend, setSpend] = useState<Spend>(emptySpend)
  const [byTask, setByTask] = useState<Array<{ taskId: string | null; title: string | null; agentId: string | null; costUsd: number; calls: number; unpricedCalls: number }>>([])
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [audit, setAudit] = useState<{ ok: boolean; checked: number; unverified?: number } | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [grants, setGrants] = useState<StandingGrant[]>([])
  const [learnings, setLearnings] = useState<Array<{ id: string; projectId: string; fact: string; sourceRunId: string | null; createdAt: number }>>([])
  const [playbooks, setPlaybooks] = useState<Array<{ id: string; projectId: string; name: string; contentHash: string; budgetUsd: number | null; approvedAt: number | null; createdAt: number }>>([])
  const [schedules, setSchedules] = useState<Array<{ id: string; projectId: string; playbookId: string; everyMinutes: number; budgetUsd: number | null; enabled: boolean; nextFireAt: number; lastRunId: string | null; createdAt: number }>>([])
  const [goals, setGoals] = useState<Array<{ id: string; projectId: string; name: string; objective: string; acceptance: string; budgetUsd: number | null; status: string; createdAt: number; spendUsd?: number; runCount?: number }>>([])
  const [blueprints, setBlueprints] = useState<Array<{ name: string; version: string; description: string; source: string }>>([])
  const [timeline, setTimeline] = useState<{ seq: number; files: Array<{ path: string; content: string | null; truncated: boolean; unknown: string | null }>; gaps: string[] } | null>(null)
  const [marketplace, setMarketplace] = useState<{ enabled: boolean; signed: boolean; entries: MarketplaceEntry[]; fetchedAt: number | null; stale: boolean }>({ enabled: false, signed: false, entries: [], fetchedAt: null, stale: false })
  const [arsenal, setArsenal] = useState<{ skills: ArsenalItem[]; plugins: ArsenalItem[] }>({ skills: [], plugins: [] })
  const [registry, setRegistry] = useState<{ candidates: MarketplaceEntry[]; skipped: string[]; fetchedAt: number } | null>(null)
  const [configReport, setConfigReport] = useState<ConfigReport | null>(null)
  const [appSettings, setAppSettings] = useState<AppSetting[]>([])
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // False until the first load finishes, so an empty project list reads as
  // "nothing here yet" rather than flashing on every boot.
  const [booted, setBooted] = useState(false)
  // Text arriving for the call in flight: cleared when the stream says it landed.
  const [streaming, setStreaming] = useState<{ role: string; text: string } | null>(null)
  const [approval, setApproval] = useState<Approval | null>(null)

  const streamRef = useRef<EventSource | null>(null)
  const runIdRef = useRef<string | null>(null)
  runIdRef.current = runId
  // Newest event sequence seen per run (stream resume cursor) and newest
  // sequence covered by a *full* snapshot (light-snapshot delta cursor).
  // Kept separate on purpose: the delta cursor must only advance on full
  // loads, or rows created between the full load and a newer event fall in
  // the gap. Refs, not state — handlers read them without re-subscribing.
  const seqRef = useRef<Record<string, number>>({})
  const baseSeqRef = useRef<Record<string, number>>({})

  const report = useCallback((caught: unknown, fallback: string) => {
    const message = caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : fallback
    setError(message)
    return message
  }, [])

  // ---------------------------------------------------------------- reads

  const loadProjects = useCallback(async () => {
    const payload = await api.get<{ projects: Array<{ id: string; name: string }> }>('/api/projects')
    setProjects(payload.projects)
    return payload.projects
  }, [])

  const loadRuns = useCallback(async (forProject: string | null) => {
    const query = forProject ? `?projectId=${encodeURIComponent(forProject)}&limit=50` : '?limit=50'
    const payload = await api.get<{ runs: Run[] }>(`/api/runs${query}`)
    setRuns(payload.runs)
    return payload.runs
  }, [])

  type Snapshot = { run: Run; tasks: Task[]; toolCalls: ToolCall[]; events: RunEvent[]; messages: any[]; audit: any; light?: boolean; taskStatuses?: Array<{ id: string; status: string }>; toolCallStatuses?: Array<{ id: string; status: string }>; counts?: { messages: number; tasks: number; toolCalls: number; events: number } }

  const trackSeq = useCallback((id: string, events: RunEvent[]) => {
    const max = events.reduce((top, event) => Math.max(top, Number(event.sequence ?? 0) || 0), 0)
    if (max > 0) seqRef.current[id] = Math.max(seqRef.current[id] ?? 0, max)
  }, [])

  const loadRun = useCallback(async (id: string, options: { light?: boolean } = {}) => {
    const query = options.light ? `?light=1&since=${baseSeqRef.current[id] ?? 0}` : ''
    const snapshot = await api.get<Snapshot>(`/api/runs/${encodeURIComponent(id)}${query}`).catch(() => null)
    // A late answer for a run the user has moved away from must not overwrite the
    // one they are looking at.
    if (!snapshot || runIdRef.current !== id) return null
    if (snapshot.light) {
      // Merge, never replace: full rows upsert by id, status maps flip stale
      // rows. New rows are covered because the delta cursor only advances on
      // full loads, so everything created since is in this payload.
      setRun(snapshot.run)
      const taskStatus = new Map((snapshot.taskStatuses ?? []).map((entry) => [entry.id, entry.status]))
      const callStatus = new Map((snapshot.toolCallStatuses ?? []).map((entry) => [entry.id, entry.status]))
      const liveTasks = new Map((snapshot.tasks ?? []).map((task) => [task.id, task]))
      const liveCalls = new Map((snapshot.toolCalls ?? []).map((call) => [call.id, call]))
      const upsert = <T extends { id: string; status: string }>(current: T[], live: Map<string, T>, statuses: Map<string, string>): T[] => {
        const next = current.map((row) => (live.get(row.id) ?? (statuses.has(row.id) ? { ...row, status: statuses.get(row.id) as T['status'] } : row)))
        const known = new Set(current.map((row) => row.id))
        for (const row of live.values()) {
          if (!known.has(row.id)) next.push(row)
        }
        return next
      }
      setTasks((current) => upsert(current, liveTasks as Map<string, Task>, taskStatus))
      setToolCalls((current) => {
        const next = upsert(current, liveCalls as Map<string, ToolCall>, callStatus)
        setApproval((approvalCurrent) => {
          const parked = next.filter((call) => call.status === 'approval_required')
          if (!parked.length) return approvalCurrent?.toolCall.status === 'approval_required' ? null : approvalCurrent
          return approvalCurrent && parked.some((call) => call.id === approvalCurrent.toolCall.id) ? approvalCurrent : { toolCall: parked[0], rule: parked[0].ruleId ?? null, warnings: parked[0].warnings ?? [], preview: null }
        })
        return next
      })
      return snapshot
    }
    setRun(snapshot.run)
    setTasks(snapshot.tasks ?? [])
    setToolCalls(snapshot.toolCalls ?? [])
    setEvents(snapshot.events ?? [])
    setMessages(snapshot.messages ?? [])
    setAudit(snapshot.audit ?? null)
    trackSeq(id, snapshot.events ?? [])
    baseSeqRef.current[id] = seqRef.current[id] ?? 0
    return snapshot
  }, [trackSeq])

  const loadPlan = useCallback(async (id: string) => {
    const payload = await api.get<Plan>(`/api/runs/${encodeURIComponent(id)}/plan`).catch(() => null)
    if (runIdRef.current === id) setPlan(payload)
    return payload
  }, [])

  const loadTrace = useCallback(async (id: string) => {
    const payload = await api.get<{ spend: Spend; byTask: any[] }>(`/api/runs/${encodeURIComponent(id)}/trace`).catch(() => null)
    if (payload && runIdRef.current === id) {
      setSpend(payload.spend ?? emptySpend)
      setByTask(payload.byTask ?? [])
    }
    return payload
  }, [])

  const loadArtifacts = useCallback(async (id: string) => {
    const payload = await api.get<{ artifacts: Artifact[] }>(`/api/runs/${encodeURIComponent(id)}/artifacts`).catch(() => null)
    if (payload && runIdRef.current === id) setArtifacts(payload.artifacts ?? [])
    return payload
  }, [])

  const loadClaims = useCallback(async (id: string) => {
    const payload = await api.get<{ claims: Claim[] }>(`/api/runs/${encodeURIComponent(id)}/claims`).catch(() => null)
    if (payload && runIdRef.current === id) setClaims(payload.claims ?? [])
    return payload
  }, [])

  const loadEstimate = useCallback(async (id: string) => {
    const payload = await api.get<Estimate>(`/api/runs/${encodeURIComponent(id)}/estimate`).catch(() => null)
    if (runIdRef.current === id) setEstimate(payload)
    return payload
  }, [])

  const loadProviders = useCallback(async () => {
    const payload = await api.get<{ providers: Provider[] }>('/api/providers')
    setProviders(payload.providers)
    return payload.providers
  }, [])

  const loadStatus = useCallback(async () => {
    const payload = await api.get<Status>('/api/status').catch(() => null)
    setStatus(payload)
    return payload
  }, [])

  const loadGrants = useCallback(async () => {
    const payload = await api.get<{ grants: StandingGrant[]; history: any[] }>('/api/grants').catch(() => ({ grants: [], history: [] }))
    setGrants(payload.grants ?? [])
    return payload
  }, [])

  const loadLearnings = useCallback(async (forProject: string | null) => {
    if (!forProject) {
      setLearnings([])
      return []
    }
    const payload = await api.get<{ learnings: Array<{ id: string; projectId: string; fact: string; sourceRunId: string | null; createdAt: number }> }>(`/api/projects/${encodeURIComponent(forProject)}/learnings`).catch(() => null)
    if (payload) setLearnings(payload.learnings ?? [])
    return payload?.learnings ?? []
  }, [])

  const loadPlaybooksFor = useCallback(async (forProject: string | null) => {
    if (!forProject) {
      setPlaybooks([])
      return []
    }
    const payload = await api.get<{ playbooks: Array<{ id: string; projectId: string; name: string; contentHash: string; budgetUsd: number | null; approvedAt: number | null; createdAt: number }> }>(`/api/projects/${encodeURIComponent(forProject)}/playbooks`).catch(() => null)
    if (payload) setPlaybooks(payload.playbooks ?? [])
    return payload?.playbooks ?? []
  }, [])

  const loadSchedulesFor = useCallback(async (forProject: string | null) => {
    if (!forProject) {
      setSchedules([])
      return []
    }
    const payload = await api.get<{ schedules: Array<{ id: string; projectId: string; playbookId: string; everyMinutes: number; budgetUsd: number | null; enabled: boolean; nextFireAt: number; lastRunId: string | null; createdAt: number }> }>(`/api/projects/${encodeURIComponent(forProject)}/schedules`).catch(() => null)
    if (payload) setSchedules(payload.schedules ?? [])
    return payload?.schedules ?? []
  }, [])

  const loadBlueprintsFor = useCallback(async () => {
    const payload = await api.get<{ blueprints: Array<{ name: string; version: string; description: string; source: string }> }>('/api/blueprints').catch(() => null)
    if (payload) setBlueprints(payload.blueprints ?? [])
    return payload?.blueprints ?? []
  }, [])

  const loadMarketplaceState = useCallback(async () => {
    const payload = await api.get<{ enabled: boolean; signed: boolean; entries: MarketplaceEntry[]; fetchedAt: number | null; stale: boolean }>('/api/marketplace').catch(() => null)
    if (payload) setMarketplace({ enabled: payload.enabled, signed: payload.signed ?? false, entries: payload.entries ?? [], fetchedAt: payload.fetchedAt, stale: payload.stale })
    return payload
  }, [])

  const loadArsenalState = useCallback(async () => {
    const payload = await api.get<{ skills: ArsenalItem[]; plugins: ArsenalItem[] }>('/api/arsenal').catch(() => null)
    if (payload) setArsenal({ skills: payload.skills ?? [], plugins: payload.plugins ?? [] })
    return payload
  }, [])

  const loadGoalsFor = useCallback(async (forProject: string | null) => {
    if (!forProject) {
      setGoals([])
      return []
    }
    const payload = await api.get<{ goals: Array<{ id: string; projectId: string; name: string; objective: string; acceptance: string; budgetUsd: number | null; status: string; createdAt: number; spendUsd?: number; runCount?: number }> }>(`/api/projects/${encodeURIComponent(forProject)}/goals`).catch(() => null)
    if (payload) setGoals(payload.goals ?? [])
    return payload?.goals ?? []
  }, [])

  const loadConfig = useCallback(async () => {
    const payload = await api.get<ConfigReport>('/api/config').catch(() => null)
    setConfigReport(payload)
    return payload
  }, [])

  const loadSettings = useCallback(async () => {
    const payload = await api.get<{ settings: AppSetting[] }>('/api/settings').catch(() => null)
    if (payload) setAppSettings(payload.settings)
    return payload?.settings ?? []
  }, [])

  const loadUsage = useCallback(async (days = 30) => {
    const payload = await api.get<Usage>(`/api/usage?days=${days}`).catch(() => null)
    setUsage(payload)
    return payload
  }, [])

  // ---------------------------------------------------------------- stream

  const refreshAfterEvent = useCallback(async (id: string, event: RunEvent) => {
    // Cheap and correct: the light snapshot carries status and live rows, so
    // the hot path (every tool call fires two of these) never re-reads the
    // run's whole history. Only new message content needs the full copy.
    if (event.type === 'message.assistant' || event.type === 'message.user') {
      await Promise.all([loadRun(id), loadTrace(id)])
    } else if (event.type.startsWith('task.') || event.type.startsWith('run.') || event.type.startsWith('tool.') || event.type.startsWith('plan.')) {
      await Promise.all([loadRun(id, { light: true }), loadTrace(id), loadPlan(id)])
      if (event.type === 'tool.completed' || event.type === 'artifact.revert') await loadArtifacts(id)
      if (event.type === 'plan.drafted' || event.type === 'plan.edited') await loadEstimate(id)
    }
    if (event.type === 'claims.recorded' || event.type === 'task.completed') await loadClaims(id)
    if (event.type === 'run.review.ready' || event.type === 'learning.recorded') await loadLearnings(projectId)
    if (event.type === 'approval.requested' || event.type === 'tool.denied' || event.type === 'approval.granted' || event.type === 'approval.standing') await loadGrants()
  }, [loadArtifacts, loadClaims, loadEstimate, loadGrants, loadLearnings, loadPlan, loadRun, loadTrace, projectId])

  // The dock is a queue derived from the run's own state, not the last event that
  // happened to mention an approval: on load, or after a reconnect, whatever is
  // genuinely parked still shows, and a stale prompt never lingers after its call
  // has resolved.
  const syncApprovalQueue = useCallback(async (id: string) => {
    // Light is enough: parked approvals ride the light snapshot by design.
    const snapshot = await loadRun(id, { light: true })
    if (!snapshot) return
    const pending = (snapshot.toolCalls as ToolCall[]).filter((call) => call.status === 'approval_required')
    setApproval((current) => {
      const next = pending.find((call) => call.id === current?.toolCall.id) ?? pending[0] ?? null
      return next ? { toolCall: next, rule: next.ruleId ?? null, warnings: next.warnings ?? [], preview: null } : null
    })
  }, [loadRun])

  const ingestEvent = useCallback((event: RunEvent) => {
    if (runIdRef.current !== event.runId) return
    trackSeq(event.runId, [event])
    setEvents((current) => (current.some((candidate) => candidate.sequence === event.sequence) ? current : [...current, event]))
    if (event.type === 'message.assistant' || event.type === 'message.user') {
      setStreaming(null)
      void loadRun(event.runId)
    }
    const callId = event.payload?.toolCallId
    if (event.type === 'approval.requested' && typeof callId === 'string') {
      void (async () => {
        const detail = await api.get<{ status: string; rule: string | null; warnings: any[]; preview: any }>(`/api/runs/${encodeURIComponent(event.runId)}/tools/${encodeURIComponent(callId)}/preview`).catch(() => null)
        const call = (await loadRun(event.runId, { light: true }))?.toolCalls?.find((candidate: ToolCall) => candidate.id === callId)
        if (call) setApproval({ toolCall: call, rule: detail?.rule ?? call.ruleId ?? event.payload?.rule ?? null, warnings: detail?.warnings ?? call.warnings ?? [], preview: detail?.preview ?? null })
      })()
    }
    if ((event.type === 'tool.completed' || event.type === 'tool.denied' || event.type === 'tool.failed') && callId) {
      setApproval((current) => (current?.toolCall.id === callId ? null : current))
    }
    if (event.type === 'approval.requested') void syncApprovalQueue(event.runId)
    void refreshAfterEvent(event.runId, event)
  }, [loadRun, refreshAfterEvent, syncApprovalQueue, trackSeq])


  const ingestDelta = useCallback((frame: { role?: string; delta?: string }) => {
    if (!frame?.delta) return
    setStreaming((current) => ({ role: frame.role ?? current?.role ?? 'head', text: `${current?.text ?? ''}${frame.delta}` }))
  }, [])

  const watchRun = useCallback((id: string) => {
    streamRef.current?.close()
    setStreaming(null)
    // Resume, never replay: the server replays from the cursor, and ingest
    // dedupes by sequence, so overlap between the snapshot and the stream is
    // harmless but unbounded replay is gone.
    const source = openRunStream(id, {
      onEvent: ingestEvent,
      onDelta: ingestDelta,
      onPartial: (text) => setStreaming((current) => ({ role: current?.role ?? 'head', text })),
    }, seqRef.current[id] ?? 0)
    streamRef.current = source
  }, [ingestDelta, ingestEvent])

  useEffect(() => () => streamRef.current?.close(), [])

  // --------------------------------------------------------------- open a run

  const openRun = useCallback(async (id: string) => {
    setRunId(id)
    runIdRef.current = id
    setApproval(null)
    setArtifacts([])
    setClaims([])
    setTimeline(null)
    setSpend(emptySpend)
    setByTask([])
    setStreaming(null)
    await Promise.all([loadRun(id), loadPlan(id), loadTrace(id), loadArtifacts(id), loadClaims(id), loadEstimate(id)])
    await syncApprovalQueue(id)
    watchRun(id)
  }, [loadArtifacts, loadClaims, loadEstimate, loadPlan, loadRun, loadTrace, syncApprovalQueue, watchRun])

  /** The newest run for a project, or a new one when there is none to resume. */
  const loadProjectSettings = useCallback(async (forProject: string) => {
    const payload = await api.get<{ project: { settings?: Record<string, unknown> } }>(`/api/projects/${encodeURIComponent(forProject)}`).catch(() => null)
    const settings = payload?.project?.settings ?? {}
    setProjectSettings(settings)
    return settings
  }, [])

  const openProject = useCallback(async (forProject: string, { permissionMode = 'selective', preferRun = null }: { permissionMode?: string; preferRun?: string | null } = {}) => {
    setProjectId(forProject)
    await loadProjectSettings(forProject)
    await loadLearnings(forProject)
    await loadPlaybooksFor(forProject)
    await loadSchedulesFor(forProject)
    await loadGoalsFor(forProject)
    const list = await loadRuns(forProject)
    const target = (preferRun ? list.find((candidate) => candidate.id === preferRun) : null)
      ?? list.find((candidate) => !['cancelled', 'completed', 'failed'].includes(candidate.status))
      ?? list[0]
    if (target) {
      await openRun(target.id)
      return target.id
    }
    const created = await api.post<{ run: Run }>('/api/runs', { projectId: forProject, permissionMode })
    await loadRuns(forProject)
    await openRun(created.run.id)
    return created.run.id
  }, [loadGoalsFor, loadLearnings, loadPlaybooksFor, loadProjectSettings, loadRuns, loadSchedulesFor, openRun])

  // ------------------------------------------------------------------ startup

  useEffect(() => {
    void (async () => {
      try {
        const [list] = await Promise.all([loadProjects(), loadProviders(), loadStatus(), loadGrants(), loadConfig(), loadSettings(), loadBlueprintsFor()])
        const first = list[0]
        if (first) await openProject(first.id)
      } catch (caught) {
        report(caught, 'Could not reach the local API.')
      } finally {
        setBooted(true)
      }
    })()
    // Runs once: the bridge is local, and a project switch loads what it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ----------------------------------------------------------------- actions

  const actions = useMemo(() => ({
    async createProject(name: string) {
      try {
        const created = await api.post<{ project: { id: string } }>('/api/projects', { name })
        await loadProjects()
        await openProject(created.project.id)
      } catch (caught) {
        report(caught, 'Could not create the project.')
      }
    },
    async deleteProject(id: string) {
      try {
        await api.delete(`/api/projects/${encodeURIComponent(id)}`)
        const remaining = await loadProjects()
        if (projectId === id && remaining[0]) await openProject(remaining[0].id)
      } catch (caught) {
        report(caught, 'Could not delete the project.')
      }
    },
    /**
     * Set how hard a role thinks, stored on the project beside its routing. A
     * null level hands the decision back to the provider. The projects list is
     * reloaded so the new value is what every panel renders.
     */
    async setReasoning(role: AgentId | 'default', level: ReasoningLevel | null) {
      if (!projectId) return
      const current = projects.find((project) => project.id === projectId)
      const reasoning: Record<string, ReasoningLevel> = { ...(current?.settings?.reasoning ?? {}) }
      if (level) reasoning[role] = level
      else delete reasoning[role]
      const settings = { ...(current?.settings ?? {}), reasoning }
      try {
        await api.patch(`/api/projects/${encodeURIComponent(projectId)}`, { settings })
        await loadProjects()
        setNotice(level ? `${role === 'default' ? 'All roles' : role} now thinks at ${level}.` : `${role === 'default' ? 'All roles' : role} reasoning is back to the provider default.`)
      } catch (caught) {
        report(caught, 'The reasoning level could not be saved.')
      }
    },
    async chat(message: string) {
      if (!runId) return
      try {
        setStreaming({ role: 'head', text: '' })
        const routing = (projectSettings?.routing as Record<string, string> | undefined) ?? {}
        await api.post('/api/chat', { projectId, runId, message, routing, history: messages.slice(-20).map((entry) => ({ role: entry.role, content: entry.content })) })
      } catch (caught) {
        setStreaming(null)
        report(caught, 'The message could not be sent.')
      } finally {
        void loadRun(runId)
      }
    },
    async draftPlan({ regenerate = false } = {}) {
      if (!runId) return
      try {
        setEstimate(null)
        const drafted = await api.post<Plan>(`/api/runs/${encodeURIComponent(runId)}/plan`, { regenerate })
        setPlan(drafted)
        await Promise.all([loadEstimate(runId), loadRun(runId)])
      } catch (caught) {
        report(caught, 'The plan could not be drafted.')
      }
    },
    async editPlan(objective: string, tasks: Array<{ role: string; title: string; instructions: string; dependsOn: number[]; acceptanceCheck?: string }>) {
      if (!runId) return false
      try {
        const edited = await api.patch<Plan>(`/api/runs/${encodeURIComponent(runId)}/plan`, { objective, tasks })
        setPlan(edited)
        setNotice(`Plan v${edited.plan.version} saved. It needs approving again.`)
        await Promise.all([loadEstimate(runId), loadRun(runId)])
        return true
      } catch (caught) {
        report(caught, 'The plan could not be saved.')
        return false
      }
    },
    async control(action: string, body: Record<string, unknown> = {}) {
      if (!runId) return null
      try {
        const result = await api.post<{ run: Run }>(`/api/runs/${encodeURIComponent(runId)}/control`, { action, ...body })
        setRun(result.run)
        await Promise.all([loadRun(runId), loadRuns(projectId)])
        return result.run
      } catch (caught) {
        report(caught, `Could not ${action}.`)
        return null
      }
    },
    async approveCall(scope: 'once' | 'run' | 'always', input?: Record<string, unknown>) {
      if (!runId || !approval) return
      try {
        await api.post(`/api/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(approval.toolCall.id)}/approve`, { scope, fingerprint: approval.toolCall.fingerprint, ...(input === undefined ? {} : { editedInput: input }) })
        setApproval(null)
        setNotice(input === undefined
          ? scope === 'always' ? 'Approved, and allowed within that scope from now on.' : scope === 'run' ? 'Approved for the rest of this run.' : 'Approved.'
          : 'Approved with your edits, as a new call.')
        await Promise.all([loadRun(runId), loadGrants(), loadArtifacts(runId)])
      } catch (caught) {
        report(caught, 'The call could not be approved.')
      }
    },
    async answerCall(answer: string) {
      if (!runId || !approval) return
      try {
        await api.post(`/api/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(approval.toolCall.id)}/answer`, { answer })
        setApproval(null)
        setNotice('Answered, and the worker continues on it.')
        await loadRun(runId)
      } catch (caught) {
        report(caught, 'The question could not be answered.')
      }
    },
    async denyCall(reason: string) {
      if (!runId || !approval) return
      try {
        await api.post(`/api/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(approval.toolCall.id)}/deny`, { reason })
        setApproval(null)
        setNotice('Denied, and the worker was told why.')
        await loadRun(runId)
      } catch (caught) {
        report(caught, 'The call could not be denied.')
      }
    },
    async revertArtifact(toolCallId: string) {
      if (!runId) return
      try {
        await api.post(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(toolCallId)}/revert`)
        setNotice('Reverted to the contents from before that write.')
        await Promise.all([loadArtifacts(runId), loadRun(runId)])
      } catch (caught) {
        report(caught, 'That write could not be reverted.')
      }
    },
    async revokeRunGrant(toolName: string) {
      if (!runId) return
      try {
        await api.delete(`/api/runs/${encodeURIComponent(runId)}/grants/${encodeURIComponent(toolName)}`)
        await loadRun(runId)
      } catch (caught) {
        report(caught, 'The grant could not be revoked.')
      }
    },
    async forkRun() {
      if (!runId) return
      try {
        const forked = await api.post<{ run: Run }>(`/api/runs/${encodeURIComponent(runId)}/fork`)
        await loadRuns(projectId)
        await openRun(forked.run.id)
        setNotice('Forked: the same plan as a new draft, waiting for approval.')
      } catch (caught) {
        report(caught, 'The run could not be forked.')
      }
    },
    async saveProvider(provider: Provider, settings: Record<string, unknown>) {
      const updated = await api.patch<{ provider: Provider }>(`/api/providers/${encodeURIComponent(provider.id)}`, settings)
      await loadProviders()
      return updated.provider
    },
    async addProvider(input: Record<string, unknown>) {
      await api.post('/api/providers', input)
      await loadProviders()
    },
    async removeProvider(id: string) {
      await api.delete(`/api/providers/${encodeURIComponent(id)}`)
      await loadProviders()
    },
    async testProvider(id: string) {
      return api.post<{ result: any }>(`/api/providers/${encodeURIComponent(id)}/test`)
    },
    async createGrant(toolName: string, scopeKind: 'path' | 'host', scopeValue: string) {
      await api.post('/api/grants', { toolName, scopeKind, scopeValue })
      await loadGrants()
    },
    async revokeGrant(id: string) {
      await api.delete(`/api/grants/${encodeURIComponent(id)}`)
      await loadGrants()
    },
    async deleteLearning(id: string) {
      if (!projectId) return
      await api.delete(`/api/projects/${encodeURIComponent(projectId)}/learnings/${encodeURIComponent(id)}`)
      await loadLearnings(projectId)
      setNotice('Forgotten. Future plans will not see it.')
    },
    async savePlaybook(name: string) {
      if (!projectId || !runId) return null
      try {
        const saved = await api.post<{ playbook: { id: string } }>(`/api/projects/${encodeURIComponent(projectId)}/playbooks`, { name, runId })
        await loadPlaybooksFor(projectId)
        setNotice(`Playbook saved. Re-running it inherits this approval.`)
        return saved.playbook
      } catch (caught) {
        report(caught, 'The playbook could not be saved. Only an approved plan can become one.')
        return null
      }
    },
    async instantiatePlaybook(id: string) {
      if (!projectId) return null
      try {
        const started = await api.post<{ run: Run }>(`/api/projects/${encodeURIComponent(projectId)}/playbooks/${encodeURIComponent(id)}/runs`, {})
        await loadRuns(projectId)
        await openRun(started.run.id)
        setNotice('Playbook running under its inherited approval.')
        return started.run
      } catch (caught) {
        report(caught, 'The playbook could not start.')
        return null
      }
    },
    async deletePlaybook(id: string) {
      if (!projectId) return
      await api.delete(`/api/projects/${encodeURIComponent(projectId)}/playbooks/${encodeURIComponent(id)}`)
      await loadPlaybooksFor(projectId)
    },
    async saveSchedule(playbookId: string, every: string, budgetUsd: number | null) {
      if (!projectId) return null
      try {
        const saved = await api.post<{ schedule: { id: string } }>(`/api/projects/${encodeURIComponent(projectId)}/schedules`, { playbookId, every, budgetUsd })
        await loadSchedulesFor(projectId)
        setNotice('Scheduled. It fires while the bridge runs.')
        return saved.schedule
      } catch (caught) {
        report(caught, 'The schedule could not be saved. Use an interval like "every 6h".')
        return null
      }
    },
    async toggleSchedule(id: string, enabled: boolean) {
      if (!projectId) return
      await api.patch(`/api/projects/${encodeURIComponent(projectId)}/schedules/${encodeURIComponent(id)}`, { enabled })
      await loadSchedulesFor(projectId)
    },
    async deleteSchedule(id: string) {
      if (!projectId) return
      await api.delete(`/api/projects/${encodeURIComponent(projectId)}/schedules/${encodeURIComponent(id)}`)
      await loadSchedulesFor(projectId)
    },
    async createGoal(name: string, objective: string, acceptance: string, budgetUsd: number | null) {
      if (!projectId) return null
      try {
        const created = await api.post<{ goal: { id: string } }>(`/api/projects/${encodeURIComponent(projectId)}/goals`, { name, objective, acceptance, budgetUsd })
        await loadGoalsFor(projectId)
        setNotice(budgetUsd ? `Goal started. Runs under it share a $${Number(budgetUsd).toFixed(2)} ceiling.` : 'Goal started. Runs under it are grouped, with no shared ceiling.')
        return created.goal
      } catch (caught) {
        report(caught, 'The goal could not be created.')
        return null
      }
    },
    async deleteGoal(id: string) {
      if (!projectId) return
      await api.delete(`/api/projects/${encodeURIComponent(projectId)}/goals/${encodeURIComponent(id)}`)
      await loadGoalsFor(projectId)
    },
    async refreshMarketplace() {
      try {
        const fresh = await api.post<{ entries: unknown[]; fetchedAt: number }>('/api/marketplace/refresh', {})
        await loadMarketplaceState()
        setNotice(`Marketplace refreshed: ${fresh.entries.length} entries.`)
        return fresh
      } catch (caught) {
        report(caught, 'The marketplace could not be refreshed.')
        return null
      }
    },
    async installMarketplaceEntry(id: string) {
      try {
        const installed = await api.post<{ installed: { kind: string; id: string; version: string }; permissions: { tools: string[]; hosts: string[] } }>(`/api/marketplace/${encodeURIComponent(id)}`, {})
        await Promise.all([loadMarketplaceState(), loadArsenalState()])
        const permissions = [...installed.permissions.tools, ...installed.permissions.hosts].filter(Boolean).join(', ')
        setNotice(`Installed ${installed.installed.id} v${installed.installed.version}${permissions ? ` (${permissions})` : ''}.`)
        return installed
      } catch (caught) {
        report(caught, 'That entry could not be installed.')
        return null
      }
    },
    async uninstallMarketplaceEntry(id: string) {
      await api.delete(`/api/marketplace/${encodeURIComponent(id)}`)
      await Promise.all([loadMarketplaceState(), loadArsenalState()])
      setNotice(`Removed ${id} and revoked its scoped grants.`)
    },
    async browseRegistry(registryUrl: string) {
      try {
        const catalog = await api.post<{ candidates: MarketplaceEntry[]; skipped: string[]; fetchedAt: number }>('/api/marketplace/browse', { registry: registryUrl })
        setRegistry(catalog)
        return catalog
      } catch (caught) {
        report(caught, 'That registry could not be read.')
        return null
      }
    },
    clearRegistry() {
      setRegistry(null)
    },
    async importMarketplaceSkill(input: { url?: string; localPath?: string }) {
      try {
        const result = await api.post<{ staged: MarketplaceEntry }>('/api/marketplace/import', input)
        await loadMarketplaceState()
        const findings = result.staged.findings ?? []
        const flagged = findings.filter((finding) => finding.severity === 'medium').length
        setNotice(`Staged ${result.staged.id} v${result.staged.version} for review${flagged ? ` (${flagged} thing${flagged === 1 ? '' : 's'} worth a look)` : ''}. Install it when ready.`)
        return result
      } catch (caught) {
        report(caught, 'That skill could not be staged.')
        return null
      }
    },
    async loadTimeline(seq: number) {
      if (!runId) return null
      const payload = await api.get<{ seq: number; files: Array<{ path: string; content: string | null; truncated: boolean; unknown: string | null }>; gaps: string[] }>(`/api/runs/${encodeURIComponent(runId)}/timeline/${seq}`).catch(() => null)
      if (payload) setTimeline(payload)
      return payload
    },
    clearTimeline() {
      setTimeline(null)
    },
    async restoreTimelineFile(relPath: string) {
      if (!runId || timeline === null) return null
      try {
        const restored = await api.post<{ restored?: boolean; path?: string }>(`/api/runs/${encodeURIComponent(runId)}/timeline/${timeline.seq}/restore`, { path: relPath })
        if (restored.restored) {
          setNotice(`${relPath} restored to its state at event ${timeline.seq}.`)
          await Promise.all([loadArtifacts(runId), loadRuns(projectId)])
        } else {
          setNotice('The restore parked for approval — decide in the dock.')
          await loadRuns(projectId)
        }
        return restored
      } catch (caught) {
        report(caught, 'That file could not be restored from the timeline.')
        return null
      }
    },
    async previewBlueprint(ref: { name?: string; blueprint?: unknown }) {
      if (!projectId) return null
      try {
        const preview = await api.post<{ diff: unknown }>(`/api/projects/${encodeURIComponent(projectId)}/blueprints/preview`, ref)
        return preview.diff
      } catch (caught) {
        report(caught, 'That blueprint cannot be previewed.')
        return null
      }
    },
    async applyBlueprint(ref: { name?: string; blueprint?: unknown }) {
      if (!projectId) return null
      try {
        const applied = await api.post<{ applied: unknown }>(`/api/projects/${encodeURIComponent(projectId)}/blueprints/apply`, ref)
        await Promise.all([loadProjectSettings(projectId), loadGrants()])
        setNotice('Blueprint applied. Grants went through the normal path — nothing was silently elevated.')
        return applied.applied
      } catch (caught) {
        report(caught, 'That blueprint could not be applied.')
        return null
      }
    },
    async verifyAudit() {
      const result = await api.post<{ record: any }>('/api/maintenance/verify')
      await loadStatus()
      setNotice(result.record?.ok ? 'Audit chain intact.' : 'Audit verification found a problem — see the status panel.')
      return result
    },
    async saveSetting(name: string, value: unknown) {
      try {
        const updated = await api.patch<{ setting: AppSetting; settings: AppSetting[] }>('/api/settings', { name, value })
        setAppSettings(updated.settings)
        const saved = updated.setting
        setNotice(saved.restartRequired
          ? `${name} saved. It takes effect after a restart.`
          : `${name} saved and live.`)
        await loadConfig()
        return saved
      } catch (caught) {
        report(caught, 'The setting could not be saved.')
        return null
      }
    },
    async resetSetting(name: string) {
      try {
        const updated = await api.patch<{ setting: AppSetting; settings: AppSetting[] }>('/api/settings', { name, value: null })
        setAppSettings(updated.settings)
        setNotice(`${name} reset to its default.`)
        await loadConfig()
        return updated.setting
      } catch (caught) {
        report(caught, 'The setting could not be reset.')
        return null
      }
    },
    async backupNow() {
      const result = await api.post<{ record: any }>('/api/maintenance/backup')
      await loadStatus()
      setNotice('A copy of the database was written.')
      return result
    },
    async saveRouting(role: string, route: string) {
      if (!projectId) return false
      // Settings replace wholesale, so the current object is read first and
      // merged: a routing edit must never drop checks, reasoning, or anything
      // else the project carries. Casting is not plan content, so no
      // re-approval follows — but the change is an event on the run's chain
      // the next time the run starts, like any routing change.
      try {
        const current = await loadProjectSettings(projectId)
        const routing = { ...((current.routing as Record<string, string> | undefined) ?? {}), [role]: route.trim() }
        const updated = await api.patch<{ project: { settings?: Record<string, unknown> } }>(`/api/projects/${encodeURIComponent(projectId)}`, { settings: { ...current, routing } })
        setProjectSettings(updated.project?.settings ?? { ...current, routing })
        setNotice(`${roleLabel(role)} now runs on ${route.trim() || 'the default provider'}.`)
        return true
      } catch (caught) {
        report(caught, 'The routing could not be saved.')
        return false
      }
    },
    search: (query: string) => api.get<SearchResults>(`/api/search?q=${encodeURIComponent(query)}`),
    tree: (path = '.', depth = 2) => api.get<{ path: string; entries: TreeNode[] }>(`/api/workspace/tree?path=${encodeURIComponent(path)}&depth=${depth}`),
    fileHistory: (path: string) => api.get<{ path: string; calls: FileHistoryEntry[] }>(`/api/workspace/history?path=${encodeURIComponent(path)}`),
    reloadRuns: () => loadRuns(projectId),
  }), [approval, loadArsenalState, loadArtifacts, loadConfig, loadEstimate, loadGoalsFor, loadGrants, loadLearnings, loadMarketplaceState, loadPlaybooksFor, loadProjectSettings, loadProjects, loadProviders, loadRun, loadRuns, loadSchedulesFor, loadStatus, messages, openProject, openRun, projectId, projects, projectSettings, report, runId, timeline])

  const bridge = useMemo(() => ({
    projects, projectId, runs, runId, run, tasks, messages, toolCalls, events, plan, artifacts, claims, spend, byTask, estimate, audit,
    providers, status, grants, learnings, playbooks, schedules, goals, blueprints, marketplace, arsenal, registry, timeline, configReport, usage, error, notice, streaming, approval, booted, appSettings, projectSettings,
    setError, setNotice, setApproval,
    openProject, openRun, loadRuns, loadStatus, loadGrants, loadConfig, loadUsage, loadProviders, loadSettings, loadClaims, loadLearnings, loadPlaybooksFor, loadSchedulesFor, loadGoalsFor, loadMarketplaceState, loadArsenalState, loadBlueprintsFor,
    ...actions,
    approveWithKeyboard: (scope: 'once' | 'run' | 'always') => actions.approveCall(scope),
  }), [projects, projectId, runs, runId, run, tasks, messages, toolCalls, events, plan, artifacts, claims, spend, byTask, estimate, audit, providers, status, grants, learnings, playbooks, schedules, goals, blueprints, marketplace, arsenal, registry, timeline, configReport, usage, error, notice, streaming, approval, booted, appSettings, projectSettings, actions, openProject, openRun, loadRuns, loadStatus, loadGrants, loadConfig, loadUsage, loadProviders, loadSettings, loadClaims, loadLearnings, loadPlaybooksFor, loadSchedulesFor, loadGoalsFor, loadMarketplaceState, loadArsenalState, loadBlueprintsFor])
  return bridge
}

export type Bridge = ReturnType<typeof useBridge>
