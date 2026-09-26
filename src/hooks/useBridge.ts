import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, openRunStream } from '../api/client'
import { roleLabel } from '../lib/runGraph'
import { createRequestScope } from './requestScope'
import { useWorkspaceBridge } from './useWorkspaceBridge'
import type { AgentId, ApprovalDetails, Artifact, Claim, Estimate, FileHistoryEntry, Message, Plan, Project, ReasoningLevel, Run, RunEvent, RunGrant, RunSnapshot, SearchResults, Spend, Task, TaskSpend, ToolCall, TreeNode, WritePreview } from '../api/types'

/**
 * Everything the interface reads, and the actions it takes, in one place.
 *
 * The alternative — each panel fetching for itself — is how an interface ends up
 * with six copies of the same snapshot and no agreement about which is current. One
 * owner of the run, its plan, its events and its cost; panels render what they are
 * given and call the actions here.
 */

const emptySpend: Spend = { costUsd: 0, calls: 0, unpricedCalls: 0 }

export type Approval = { toolCall: ToolCall; rule: string | null; warnings: ToolCall['warnings']; preview: WritePreview | null }

function upsertRows<T extends { id: string; status: string }>(current: T[], rows: T[], statuses: Array<{ id: string; status: string }> = []): T[] {
  const live = new Map(rows.map((row) => [row.id, row]))
  const states = new Map(statuses.map((row) => [row.id, row.status]))
  const known = new Set(current.map((row) => row.id))
  return [
    ...current.map((row) => live.get(row.id) ?? (states.has(row.id) ? { ...row, status: states.get(row.id)! } : row)),
    ...rows.filter((row) => !known.has(row.id)),
  ]
}

export function useBridge() {
  const [projectScope] = useState(createRequestScope)
  const [runScope] = useState(createRequestScope)
  const [projectLoading, setProjectLoading] = useState(false)
  const [runLoading, setRunLoading] = useState(false)
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
  const [messages, setMessages] = useState<Message[]>([])
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([])
  const [events, setEvents] = useState<RunEvent[]>([])
  const [plan, setPlan] = useState<Plan | null>(null)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [claims, setClaims] = useState<Claim[]>([])
  const [spend, setSpend] = useState<Spend>(emptySpend)
  const [byTask, setByTask] = useState<TaskSpend[]>([])
  const [runGrants, setRunGrants] = useState<RunGrant[]>([])
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [audit, setAudit] = useState<{ ok: boolean; checked: number; unverified?: number } | null>(null)
  const [learnings, setLearnings] = useState<Array<{ id: string; projectId: string; fact: string; sourceRunId: string | null; createdAt: number }>>([])
  const [playbooks, setPlaybooks] = useState<Array<{ id: string; projectId: string; name: string; contentHash: string; budgetUsd: number | null; approvedAt: number | null; createdAt: number }>>([])
  const [schedules, setSchedules] = useState<Array<{ id: string; projectId: string; playbookId: string; everyMinutes: number; budgetUsd: number | null; enabled: boolean; nextFireAt: number; lastRunId: string | null; createdAt: number }>>([])
  const [goals, setGoals] = useState<Array<{ id: string; projectId: string; name: string; objective: string; acceptance: string; budgetUsd: number | null; status: string; createdAt: number; spendUsd?: number; runCount?: number }>>([])
  const [blueprints, setBlueprints] = useState<Array<{ name: string; version: string; description: string; source: string }>>([])
  const [timeline, setTimeline] = useState<{ seq: number; files: Array<{ path: string; content: string | null; truncated: boolean; unknown: string | null }>; gaps: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // False until the first load finishes, so an empty project list reads as
  // "nothing here yet" rather than flashing on every boot.
  const [booted, setBooted] = useState(false)
  // Text arriving for the call in flight: cleared when the stream says it landed.
  const [streaming, setStreaming] = useState<{ role: string; text: string } | null>(null)
  const [approval, setApproval] = useState<Approval | null>(null)

  const streamRef = useRef<EventSource | null>(null)
  const rowsRef = useRef<{ tasks: Task[]; calls: ToolCall[] }>({ tasks: [], calls: [] })
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
  const workspace = useWorkspaceBridge(report, setNotice)
  const { loadProviders, loadStatus, loadGrants, loadConfig, loadSettings } = workspace

  // ---------------------------------------------------------------- reads

  const loadProjects = useCallback(async () => {
    const payload = await api.get<{ projects: Array<{ id: string; name: string }> }>('/api/projects')
    setProjects(payload.projects)
    return payload.projects
  }, [])

  const loadRuns = useCallback(async (forProject: string | null) => {
    const selection = projectScope.capture(forProject)
    const query = forProject ? `?projectId=${encodeURIComponent(forProject)}&limit=50` : '?limit=50'
    const payload = await api.get<{ runs: Run[] }>(`/api/runs${query}`, { signal: selection.signal })
    if (selection.isCurrent()) setRuns(payload.runs)
    return payload.runs
  }, [projectScope])

  const trackSeq = useCallback((id: string, events: RunEvent[]) => {
    const max = events.reduce((top, event) => Math.max(top, Number(event.sequence ?? 0) || 0), 0)
    if (max > 0) seqRef.current[id] = Math.max(seqRef.current[id] ?? 0, max)
  }, [])

  const loadRun = useCallback(async (id: string, options: { light?: boolean } = {}) => {
    const selection = runScope.capture(id)
    if (!selection.isCurrent()) return null
    const query = options.light ? `?light=1&since=${baseSeqRef.current[id] ?? 0}` : ''
    const snapshot = await api.get<RunSnapshot>(`/api/runs/${encodeURIComponent(id)}${query}`, { signal: selection.signal }).catch(() => null)
    if (!snapshot || !selection.isCurrent() || snapshot.run.projectId !== projectScope.id) return null
    setRun(snapshot.run)
    const nextTasks = snapshot.light ? upsertRows(rowsRef.current.tasks, snapshot.tasks ?? [], snapshot.taskStatuses) : snapshot.tasks ?? []
    const nextCalls = snapshot.light ? upsertRows(rowsRef.current.calls, snapshot.toolCalls ?? [], snapshot.toolCallStatuses) : snapshot.toolCalls ?? []
    rowsRef.current = { tasks: nextTasks, calls: nextCalls }
    setTasks(nextTasks)
    setToolCalls(nextCalls)
    setApproval((current) => {
      const pending = nextCalls.filter((call) => call.status === 'approval_required')
      const call = pending.find((entry) => entry.id === current?.toolCall.id) ?? pending[0]
      if (!call) return null
      const same = current?.toolCall.id === call.id && current.toolCall.fingerprint === call.fingerprint
      return { toolCall: call, rule: call.ruleId, warnings: call.warnings ?? [], preview: same ? current.preview : null }
    })
    if (snapshot.light) return snapshot
    setEvents(snapshot.events ?? [])
    setMessages(snapshot.messages ?? [])
    setAudit(snapshot.audit ?? null)
    trackSeq(id, snapshot.events ?? [])
    baseSeqRef.current[id] = seqRef.current[id] ?? 0
    return snapshot
  }, [projectScope, runScope, trackSeq])

  const loadPlan = useCallback(async (id: string) => {
    const selection = runScope.capture(id)
    if (!selection.isCurrent()) return null
    const payload = await api.get<Plan>(`/api/runs/${encodeURIComponent(id)}/plan`, { signal: selection.signal }).catch(() => null)
    if (selection.isCurrent()) setPlan(payload)
    return payload
  }, [runScope])

  const loadTrace = useCallback(async (id: string) => {
    const selection = runScope.capture(id)
    if (!selection.isCurrent()) return null
    const payload = await api.get<{ spend: Spend; byTask: TaskSpend[] }>(`/api/runs/${encodeURIComponent(id)}/trace`, { signal: selection.signal }).catch(() => null)
    if (payload && selection.isCurrent()) {
      setSpend(payload.spend ?? emptySpend)
      setByTask(payload.byTask ?? [])
    }
    return payload
  }, [runScope])

  const loadArtifacts = useCallback(async (id: string) => {
    const selection = runScope.capture(id)
    if (!selection.isCurrent()) return null
    const payload = await api.get<{ artifacts: Artifact[]; grants: RunGrant[] }>(`/api/runs/${encodeURIComponent(id)}/artifacts`, { signal: selection.signal }).catch(() => null)
    if (payload && selection.isCurrent()) {
      setArtifacts(payload.artifacts ?? [])
      setRunGrants(payload.grants ?? [])
    }
    return payload
  }, [runScope])

  const loadClaims = useCallback(async (id: string) => {
    const selection = runScope.capture(id)
    if (!selection.isCurrent()) return null
    const payload = await api.get<{ claims: Claim[] }>(`/api/runs/${encodeURIComponent(id)}/claims`, { signal: selection.signal }).catch(() => null)
    if (payload && selection.isCurrent()) setClaims(payload.claims ?? [])
    return payload
  }, [runScope])

  const loadEstimate = useCallback(async (id: string) => {
    const selection = runScope.capture(id)
    if (!selection.isCurrent()) return null
    const payload = await api.get<Estimate>(`/api/runs/${encodeURIComponent(id)}/estimate`, { signal: selection.signal }).catch(() => null)
    if (selection.isCurrent()) setEstimate(payload)
    return payload
  }, [runScope])

  const loadLearnings = useCallback(async (forProject: string | null) => {
    const selection = projectScope.capture(forProject)
    if (!selection.isCurrent()) return []
    if (!forProject) {
      setLearnings([])
      return []
    }
    const payload = await api.get<{ learnings: Array<{ id: string; projectId: string; fact: string; sourceRunId: string | null; createdAt: number }> }>(`/api/projects/${encodeURIComponent(forProject)}/learnings`, { signal: selection.signal }).catch(() => null)
    if (payload && selection.isCurrent()) setLearnings(payload.learnings ?? [])
    return payload?.learnings ?? []
  }, [projectScope])

  const loadPlaybooksFor = useCallback(async (forProject: string | null) => {
    const selection = projectScope.capture(forProject)
    if (!selection.isCurrent()) return []
    if (!forProject) {
      setPlaybooks([])
      return []
    }
    const payload = await api.get<{ playbooks: Array<{ id: string; projectId: string; name: string; contentHash: string; budgetUsd: number | null; approvedAt: number | null; createdAt: number }> }>(`/api/projects/${encodeURIComponent(forProject)}/playbooks`, { signal: selection.signal }).catch(() => null)
    if (payload && selection.isCurrent()) setPlaybooks(payload.playbooks ?? [])
    return payload?.playbooks ?? []
  }, [projectScope])

  const loadSchedulesFor = useCallback(async (forProject: string | null) => {
    const selection = projectScope.capture(forProject)
    if (!selection.isCurrent()) return []
    if (!forProject) {
      setSchedules([])
      return []
    }
    const payload = await api.get<{ schedules: Array<{ id: string; projectId: string; playbookId: string; everyMinutes: number; budgetUsd: number | null; enabled: boolean; nextFireAt: number; lastRunId: string | null; createdAt: number }> }>(`/api/projects/${encodeURIComponent(forProject)}/schedules`, { signal: selection.signal }).catch(() => null)
    if (payload && selection.isCurrent()) setSchedules(payload.schedules ?? [])
    return payload?.schedules ?? []
  }, [projectScope])

  const loadBlueprintsFor = useCallback(async () => {
    const payload = await api.get<{ blueprints: Array<{ name: string; version: string; description: string; source: string }> }>('/api/blueprints').catch(() => null)
    if (payload) setBlueprints(payload.blueprints ?? [])
    return payload?.blueprints ?? []
  }, [])

  const loadGoalsFor = useCallback(async (forProject: string | null) => {
    const selection = projectScope.capture(forProject)
    if (!selection.isCurrent()) return []
    if (!forProject) {
      setGoals([])
      return []
    }
    const payload = await api.get<{ goals: Array<{ id: string; projectId: string; name: string; objective: string; acceptance: string; budgetUsd: number | null; status: string; createdAt: number; spendUsd?: number; runCount?: number }> }>(`/api/projects/${encodeURIComponent(forProject)}/goals`, { signal: selection.signal }).catch(() => null)
    if (payload && selection.isCurrent()) setGoals(payload.goals ?? [])
    return payload?.goals ?? []
  }, [projectScope])

  // ---------------------------------------------------------------- stream

  const refreshAfterEvent = useCallback(async (id: string, event: RunEvent) => {
    // Cheap and correct: the light snapshot carries status and live rows, so
    // the hot path (every tool call fires two of these) never re-reads the
    // run's whole history. Only new message content needs the full copy.
    if (event.type === 'message.assistant' || event.type === 'message.user') {
      await Promise.all([loadRun(id), loadTrace(id)])
    } else if (['task.', 'run.', 'tool.', 'plan.', 'approval.'].some((prefix) => event.type.startsWith(prefix))) {
      // The light snapshot arrives first and carries planId, so a planless
      // run never asks the plan endpoint for what it cannot have — the 404
      // is the designed answer there, and asking logs a console error.
      const snapshot = await loadRun(id, { light: true })
      const hasPlan = Boolean(snapshot?.run?.planId)
      await Promise.all([loadTrace(id), hasPlan ? loadPlan(id) : Promise.resolve(null)])
      if (event.type === 'plan.drafted' || event.type === 'plan.edited') await loadEstimate(id)
    }
    if (event.type === 'tool.completed' || event.type === 'artifact.revert' || event.type === 'approval.granted' || event.type === 'approval.revoked') await loadArtifacts(id)
    if (event.type === 'claims.recorded' || event.type === 'task.completed') await loadClaims(id)
    if (event.type === 'run.review.ready' || event.type === 'learning.recorded') await loadLearnings(projectScope.id)
    if (event.type === 'approval.requested' || event.type === 'tool.denied' || event.type === 'approval.granted' || event.type === 'approval.standing') await loadGrants()
  }, [loadArtifacts, loadClaims, loadEstimate, loadGrants, loadLearnings, loadPlan, loadRun, loadTrace, projectScope])

  // Preview on initial load as well as live events. A queue refresh must not
  // erase a fetched diff, and a late preview cannot attach to a different call.
  const approvalId = approval?.toolCall.id
  const approvalFingerprint = approval?.toolCall.fingerprint
  useEffect(() => {
    if (!runId || !approvalId) return
    const selection = runScope.capture(runId)
    let live = true
    void api.get<ApprovalDetails>(`/api/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(approvalId)}/preview`, { signal: selection.signal })
      .then((detail) => {
        if (!live || !selection.isCurrent()) return
        setApproval((current) => current?.toolCall.id === approvalId && current.toolCall.fingerprint === approvalFingerprint
          ? { ...current, rule: detail.rule, warnings: detail.warnings ?? [], preview: detail.preview }
          : current)
      }).catch(() => {})
    return () => { live = false }
  }, [approvalId, approvalFingerprint, runId, runScope])

  const ingestEvent = useCallback((event: RunEvent) => {
    if (runScope.id !== event.runId) return
    trackSeq(event.runId, [event])
    setEvents((current) => (current.some((candidate) => candidate.sequence === event.sequence) ? current : [...current, event]))
    if (event.type === 'message.assistant' || event.type === 'message.user') {
      setStreaming(null)
    }
    const callId = event.payload?.toolCallId
    if ((event.type === 'tool.completed' || event.type === 'tool.denied' || event.type === 'tool.failed') && callId) {
      setApproval((current) => (current?.toolCall.id === callId ? null : current))
    }
    void refreshAfterEvent(event.runId, event)
  }, [refreshAfterEvent, runScope, trackSeq])


  const ingestDelta = useCallback((frame: { role?: string; delta?: string }) => {
    if (!frame?.delta) return
    setStreaming((current) => ({ role: frame.role ?? current?.role ?? 'head', text: `${current?.text ?? ''}${frame.delta}` }))
  }, [])

  const watchRun = useCallback((id: string) => {
    const selection = runScope.capture(id)
    if (!selection.isCurrent()) return
    streamRef.current?.close()
    setStreaming(null)
    // Resume, never replay: the server replays from the cursor, and ingest
    // dedupes by sequence, so overlap between the snapshot and the stream is
    // harmless but unbounded replay is gone.
    const source = openRunStream(id, {
      onEvent: (event) => { if (selection.isCurrent()) ingestEvent(event) },
      onDelta: (frame) => { if (selection.isCurrent()) ingestDelta(frame) },
      onPartial: (text) => { if (selection.isCurrent()) setStreaming((current) => ({ role: current?.role ?? 'head', text })) },
    }, seqRef.current[id] ?? 0)
    streamRef.current = source
  }, [ingestDelta, ingestEvent, runScope])

  // --------------------------------------------------------------- open a run

  const closeRun = useCallback(() => {
    runScope.select(null)
    streamRef.current?.close()
    streamRef.current = null
    setRunId(null)
    setRun(null)
    setRunLoading(false)
    setTasks([])
    setMessages([])
    setToolCalls([])
    setEvents([])
    setPlan(null)
    setEstimate(null)
    setAudit(null)
    rowsRef.current = { tasks: [], calls: [] }
    setApproval(null)
    setArtifacts([])
    setClaims([])
    setTimeline(null)
    setSpend(emptySpend)
    setByTask([])
    setRunGrants([])
    setStreaming(null)
  }, [runScope])

  const openRun = useCallback(async (id: string) => {
    if (!projectScope.id) return null
    closeRun()
    runScope.select(id)
    const selection = runScope.capture(id)
    setRunId(id)
    setRunLoading(true)
    // The plan and its estimate are plan-bound subresources: a run that has
    // never drafted one answers them 404 by design, and asking anyway logs a
    // console error on every fresh run. The run row carries planId, so a
    // planless run simply does not ask.
    const snapshot = await loadRun(id)
    const hasPlan = Boolean(snapshot?.run?.planId)
    await Promise.all([
      hasPlan ? loadPlan(id) : Promise.resolve(null),
      loadTrace(id),
      loadArtifacts(id),
      loadClaims(id),
      hasPlan ? loadEstimate(id) : Promise.resolve(null),
    ])
    if (!selection.isCurrent()) return null
    if (!snapshot) {
      closeRun()
      report(new Error('Could not open this run. Try again from run history.'), 'Could not open the run.')
      return null
    }
    watchRun(id)
    setRunLoading(false)
    return id
  }, [closeRun, loadArtifacts, loadClaims, loadEstimate, loadPlan, loadRun, loadTrace, projectScope, report, runScope, watchRun])

  const loadProjectSettings = useCallback(async (forProject: string) => {
    const selection = projectScope.capture(forProject)
    const payload = await api.get<{ project: Project }>(`/api/projects/${encodeURIComponent(forProject)}`, { signal: selection.signal })
    const settings = payload.project.settings ?? {}
    if (selection.isCurrent()) setProjectSettings(settings)
    return settings
  }, [projectScope])

  const openProject = useCallback(async (forProject: string, { preferRun = null }: { preferRun?: string | null } = {}) => {
    projectScope.select(forProject)
    const selection = projectScope.capture(forProject)
    closeRun()
    setProjectId(forProject)
    setProjectLoading(true)
    setProjectSettings({})
    setRuns([])
    setLearnings([])
    setPlaybooks([])
    setSchedules([])
    setGoals([])
    setError(null)
    setNotice(null)
    try {
      const [list] = await Promise.all([loadRuns(forProject), loadProjectSettings(forProject), loadLearnings(forProject), loadPlaybooksFor(forProject), loadSchedulesFor(forProject), loadGoalsFor(forProject)])
      if (!selection.isCurrent()) return null
      const target = (preferRun ? list.find((candidate) => candidate.id === preferRun) : null)
        ?? list.find((candidate) => !['cancelled', 'completed', 'failed'].includes(candidate.status))
        ?? list[0]
      // Reading an empty project must not create work (or create it twice under
      // StrictMode). The history surface offers an explicit New run action.
      return target ? await openRun(target.id) : null
    } catch (caught) {
      if (selection.isCurrent()) report(caught, 'Could not open the project.')
      return null
    } finally {
      if (selection.isCurrent()) setProjectLoading(false)
    }
  }, [closeRun, loadGoalsFor, loadLearnings, loadPlaybooksFor, loadProjectSettings, loadRuns, loadSchedulesFor, openRun, projectScope, report])

  // ------------------------------------------------------------------ startup

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const [list] = await Promise.all([loadProjects(), loadProviders(), loadStatus(), loadGrants(), loadConfig(), loadSettings(), loadBlueprintsFor()])
        const first = list[0]
        if (live && first) await openProject(first.id)
      } catch (caught) {
        if (live) report(caught, 'Could not reach the local API.')
      } finally {
        if (live) setBooted(true)
      }
    })()
    return () => {
      live = false
      projectScope.select(null)
      runScope.select(null)
      streamRef.current?.close()
    }
    // Runs once: the bridge is local, and a project switch loads what it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ----------------------------------------------------------------- actions

  const canActOnRun = useCallback(() => Boolean(
    run && runId && !runLoading && !projectLoading && run.id === runId && run.projectId === projectId
    && runScope.id === runId && projectScope.id === projectId,
  ), [projectId, projectLoading, projectScope, run, runId, runLoading, runScope])
  const tree = useCallback((path = '.', depth = 2) => api.get<{ path: string; entries: TreeNode[] }>(`/api/workspace/tree?path=${encodeURIComponent(path)}&depth=${depth}`), [])
  const fileHistory = useCallback((path: string) => api.get<{ path: string; calls: FileHistoryEntry[] }>(`/api/workspace/history?path=${encodeURIComponent(path)}`), [])

  const actions = useMemo(() => ({
    async createProject(name: string) {
      const selection = projectScope.capture()
      try {
        const created = await api.post<{ project: { id: string } }>('/api/projects', { name })
        await loadProjects()
        if (!selection.isCurrent()) return null
        await openProject(created.project.id)
        return created.project.id
      } catch (caught) {
        if (selection.isCurrent()) report(caught, 'Could not create the project.')
        return null
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
     * Start a fresh run in the current project and open it. This is the way
     * out of a terminal run: the server refuses chat into failed, cancelled,
     * or completed runs, so the interface must offer the alternative it names.
     */
    async createRun() {
      const selection = projectScope.capture(projectId)
      if (!projectId || projectLoading || !selection.isCurrent()) return null
      try {
        const created = await api.post<{ run: Run }>('/api/runs', { projectId })
        await loadRuns(projectId)
        if (!selection.isCurrent()) return null
        await openRun(created.run.id)
        return created.run.id
      } catch (caught) {
        if (selection.isCurrent()) report(caught, 'Could not start a new run.')
        return null
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
      if (!canActOnRun() || !runId) return false
      const selection = runScope.capture(runId)
      try {
        setStreaming({ role: 'head', text: '' })
        const routing = (projectSettings?.routing as Record<string, string> | undefined) ?? {}
        await api.post('/api/chat', { projectId, runId, message, routing, history: messages.slice(-20).map((entry) => ({ role: entry.role, content: entry.content })) })
        return true
      } catch (caught) {
        if (selection.isCurrent()) report(caught, 'The message could not be sent.')
        return false
      } finally {
        if (selection.isCurrent()) {
          setStreaming(null)
          await loadRun(runId)
        }
      }
    },
    async draftPlan({ regenerate = false } = {}) {
      if (!canActOnRun() || !runId) return false
      const selection = runScope.capture(runId)
      try {
        setEstimate(null)
        const drafted = await api.post<Plan>(`/api/runs/${encodeURIComponent(runId)}/plan`, { regenerate })
        if (!selection.isCurrent()) return false
        setPlan(drafted)
        await Promise.all([loadEstimate(runId), loadRun(runId)])
        return true
      } catch (caught) {
        if (selection.isCurrent()) report(caught, 'The plan could not be drafted.')
        return false
      }
    },
    async editPlan(objective: string, tasks: Array<{ role: string; title: string; instructions: string; dependsOn: number[]; acceptanceCheck?: string }>) {
      if (!canActOnRun() || !runId) return false
      const selection = runScope.capture(runId)
      try {
        const edited = await api.patch<Plan>(`/api/runs/${encodeURIComponent(runId)}/plan`, { objective, tasks })
        if (!selection.isCurrent()) return false
        setPlan(edited)
        setNotice(`Plan v${edited.plan.version} saved. It needs approving again.`)
        await Promise.all([loadEstimate(runId), loadRun(runId)])
        return true
      } catch (caught) {
        if (selection.isCurrent()) report(caught, 'The plan could not be saved.')
        return false
      }
    },
    async control(action: string, body: Record<string, unknown> = {}) {
      if (!canActOnRun() || !runId) return null
      const selection = runScope.capture(runId)
      try {
        const result = await api.post<{ run: Run }>(`/api/runs/${encodeURIComponent(runId)}/control`, { action, ...body })
        if (!selection.isCurrent()) return null
        setRun(result.run)
        await Promise.all([loadRun(runId), loadRuns(projectId)])
        return result.run
      } catch (caught) {
        if (selection.isCurrent()) report(caught, `Could not ${action}.`)
        return null
      }
    },
    async approveCall(scope: 'once' | 'run' | 'always', input?: Record<string, unknown>) {
      if (!canActOnRun() || !runId || !approval || approval.toolCall.runId !== runId) return false
      const selection = runScope.capture(runId)
      const callId = approval.toolCall.id
      try {
        await api.post(`/api/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(approval.toolCall.id)}/approve`, { scope, fingerprint: approval.toolCall.fingerprint, ...(input === undefined ? {} : { editedInput: input }) })
        if (!selection.isCurrent()) return false
        setApproval((current) => current?.toolCall.id === callId ? null : current)
        setNotice(input === undefined
          ? scope === 'always' ? 'Approved, and allowed within that scope from now on.' : scope === 'run' ? 'Approved for the rest of this run.' : 'Approved.'
          : 'Approved with your edits, as a new call.')
        await Promise.all([loadRun(runId), loadGrants(), loadArtifacts(runId)])
        return true
      } catch (caught) {
        if (selection.isCurrent()) report(caught, 'The call could not be approved.')
        return false
      }
    },
    async answerCall(answer: string) {
      if (!canActOnRun() || !runId || !approval || approval.toolCall.runId !== runId) return false
      const selection = runScope.capture(runId)
      const callId = approval.toolCall.id
      try {
        await api.post(`/api/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(approval.toolCall.id)}/answer`, { answer })
        if (!selection.isCurrent()) return false
        setApproval((current) => current?.toolCall.id === callId ? null : current)
        setNotice('Answered, and the worker continues on it.')
        await loadRun(runId)
        return true
      } catch (caught) {
        if (selection.isCurrent()) report(caught, 'The question could not be answered.')
        return false
      }
    },
    async denyCall(reason: string) {
      if (!canActOnRun() || !runId || !approval || approval.toolCall.runId !== runId) return false
      const selection = runScope.capture(runId)
      const callId = approval.toolCall.id
      try {
        await api.post(`/api/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(approval.toolCall.id)}/deny`, { reason })
        if (!selection.isCurrent()) return false
        setApproval((current) => current?.toolCall.id === callId ? null : current)
        setNotice('Denied, and the worker was told why.')
        await loadRun(runId)
        return true
      } catch (caught) {
        if (selection.isCurrent()) report(caught, 'The call could not be denied.')
        return false
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
      if (!canActOnRun() || !runId) return
      try {
        await api.delete(`/api/runs/${encodeURIComponent(runId)}/grants/${encodeURIComponent(toolName)}`)
        await Promise.all([loadRun(runId), loadArtifacts(runId)])
      } catch (caught) {
        report(caught, 'The grant could not be revoked.')
      }
    },
    async forkRun() {
      if (!canActOnRun() || !runId) return
      const selection = runScope.capture(runId)
      try {
        const forked = await api.post<{ run: Run }>(`/api/runs/${encodeURIComponent(runId)}/fork`)
        await loadRuns(projectId)
        if (!selection.isCurrent()) return
        await openRun(forked.run.id)
        setNotice('Forked: the same plan as a new draft, waiting for approval.')
      } catch (caught) {
        if (selection.isCurrent()) report(caught, 'The run could not be forked.')
      }
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
    async loadTimeline(seq: number) {
      if (!runId) return null
      const selection = runScope.capture(runId)
      const payload = await api.get<{ seq: number; files: Array<{ path: string; content: string | null; truncated: boolean; unknown: string | null }>; gaps: string[] }>(`/api/runs/${encodeURIComponent(runId)}/timeline/${seq}`, { signal: selection.signal }).catch(() => null)
      if (payload && selection.isCurrent()) setTimeline(payload)
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
    async saveRouting(role: string, route: string) {
      const selection = projectScope.capture(projectId)
      if (!projectId || !selection.isCurrent()) return false
      // Settings replace wholesale, so the current object is read first and
      // merged: a routing edit must never drop checks, reasoning, or anything
      // else the project carries. Casting is not plan content, so no
      // re-approval follows — but the change is an event on the run's chain
      // the next time the run starts, like any routing change.
      try {
        const current = await loadProjectSettings(projectId)
        if (!selection.isCurrent()) return false
        const routing = { ...((current.routing as Record<string, string> | undefined) ?? {}), [role]: route.trim() }
        const updated = await api.patch<{ project: { settings?: Record<string, unknown> } }>(`/api/projects/${encodeURIComponent(projectId)}`, { settings: { ...current, routing } })
        if (!selection.isCurrent()) return false
        setProjectSettings(updated.project?.settings ?? { ...current, routing })
        setNotice(`${roleLabel(role)} now runs on ${route.trim() || 'the default provider'}.`)
        return true
      } catch (caught) {
        if (selection.isCurrent()) report(caught, 'The routing could not be saved.')
        return false
      }
    },
    search: (query: string) => api.get<SearchResults>(`/api/search?q=${encodeURIComponent(query)}`),
    tree,
    fileHistory,
    reloadRuns: () => loadRuns(projectId),
  }), [approval, canActOnRun, fileHistory, loadArtifacts, loadEstimate, loadGoalsFor, loadGrants, loadLearnings, loadPlaybooksFor, loadProjectSettings, loadProjects, loadRun, loadRuns, loadSchedulesFor, messages, openProject, openRun, projectId, projectLoading, projectScope, projects, projectSettings, report, runId, runScope, timeline, tree])

  const bridge = useMemo(() => ({
    ...workspace,
    projects, projectId, projectLoading, runs, runId, runLoading, run, tasks, messages, toolCalls, events, plan, artifacts, claims, spend, byTask, runGrants, estimate, audit,
    learnings, playbooks, schedules, goals, blueprints, timeline, error, notice, streaming, approval, booted, projectSettings,
    setError, setNotice, setApproval,
    openProject, openRun, closeRun, loadRuns, loadClaims, loadLearnings, loadPlaybooksFor, loadSchedulesFor, loadGoalsFor, loadBlueprintsFor,
    ...actions,
    approveWithKeyboard: (scope: 'once' | 'run' | 'always') => actions.approveCall(scope),
  }), [workspace, projects, projectId, projectLoading, runs, runId, runLoading, run, tasks, messages, toolCalls, events, plan, artifacts, claims, spend, byTask, runGrants, estimate, audit, learnings, playbooks, schedules, goals, blueprints, timeline, error, notice, streaming, approval, booted, projectSettings, actions, openProject, openRun, closeRun, loadRuns, loadClaims, loadLearnings, loadPlaybooksFor, loadSchedulesFor, loadGoalsFor, loadBlueprintsFor])
  return bridge
}

export type Bridge = ReturnType<typeof useBridge>
