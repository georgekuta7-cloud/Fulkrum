import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, openRunStream } from '../api/client'
import type { AgentId, AppSetting, Artifact, ConfigReport, Estimate, FileHistoryEntry, Plan, Project, Provider, ReasoningLevel, Run, RunEvent, SearchResults, Spend, StandingGrant, Status, Task, ToolCall, TreeNode, Usage } from '../api/types'

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
  const [spend, setSpend] = useState<Spend>(emptySpend)
  const [byTask, setByTask] = useState<Array<{ taskId: string | null; title: string | null; agentId: string | null; costUsd: number; calls: number; unpricedCalls: number }>>([])
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [audit, setAudit] = useState<{ ok: boolean; checked: number; unverified?: number } | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [grants, setGrants] = useState<StandingGrant[]>([])
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

  const loadRun = useCallback(async (id: string) => {
    const snapshot = await api.get<{ run: Run; tasks: Task[]; toolCalls: ToolCall[]; events: RunEvent[]; messages: any[]; audit: any }>(`/api/runs/${encodeURIComponent(id)}`)
    // A late answer for a run the user has moved away from must not overwrite the
    // one they are looking at.
    if (runIdRef.current !== id) return null
    setRun(snapshot.run)
    setTasks(snapshot.tasks ?? [])
    setToolCalls(snapshot.toolCalls ?? [])
    setEvents(snapshot.events ?? [])
    setMessages(snapshot.messages ?? [])
    setAudit(snapshot.audit ?? null)
    return snapshot
  }, [])

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
    // Cheap and correct: the run row, the cost and the plan change for a handful of
    // event types, and re-reading a snapshot is one local request.
    if (event.type.startsWith('task.') || event.type.startsWith('run.') || event.type.startsWith('tool.') || event.type.startsWith('plan.')) {
      await Promise.all([loadRun(id), loadTrace(id), loadPlan(id)])
      if (event.type === 'tool.completed' || event.type === 'artifact.revert') await loadArtifacts(id)
      if (event.type === 'plan.drafted' || event.type === 'plan.edited') await loadEstimate(id)
    }
    if (event.type === 'approval.requested' || event.type === 'tool.denied' || event.type === 'approval.granted' || event.type === 'approval.standing') await loadGrants()
  }, [loadArtifacts, loadEstimate, loadGrants, loadPlan, loadRun, loadTrace])

  // The dock is a queue derived from the run's own state, not the last event that
  // happened to mention an approval: on load, or after a reconnect, whatever is
  // genuinely parked still shows, and a stale prompt never lingers after its call
  // has resolved.
  const syncApprovalQueue = useCallback(async (id: string) => {
    const snapshot = await loadRun(id)
    if (!snapshot) return
    const pending = (snapshot.toolCalls as ToolCall[]).filter((call) => call.status === 'approval_required')
    setApproval((current) => {
      const next = pending.find((call) => call.id === current?.toolCall.id) ?? pending[0] ?? null
      return next ? { toolCall: next, rule: next.ruleId ?? null, warnings: next.warnings ?? [], preview: null } : null
    })
  }, [loadRun])

  const ingestEvent = useCallback((event: RunEvent) => {
    if (runIdRef.current !== event.runId) return
    setEvents((current) => (current.some((candidate) => candidate.sequence === event.sequence) ? current : [...current, event]))
    if (event.type === 'message.assistant' || event.type === 'message.user') {
      setStreaming(null)
      void loadRun(event.runId)
    }
    const callId = event.payload?.toolCallId
    if (event.type === 'approval.requested' && typeof callId === 'string') {
      void (async () => {
        const detail = await api.get<{ status: string; rule: string | null; warnings: any[]; preview: any }>(`/api/runs/${encodeURIComponent(event.runId)}/tools/${encodeURIComponent(callId)}/preview`).catch(() => null)
        const call = (await loadRun(event.runId))?.toolCalls?.find((candidate: ToolCall) => candidate.id === callId)
        if (call) setApproval({ toolCall: call, rule: detail?.rule ?? call.ruleId ?? event.payload?.rule ?? null, warnings: detail?.warnings ?? call.warnings ?? [], preview: detail?.preview ?? null })
      })()
    }
    if ((event.type === 'tool.completed' || event.type === 'tool.denied' || event.type === 'tool.failed') && callId) {
      setApproval((current) => (current?.toolCall.id === callId ? null : current))
    }
    if (event.type === 'approval.requested') void syncApprovalQueue(event.runId)
    void refreshAfterEvent(event.runId, event)
  }, [loadRun, refreshAfterEvent, syncApprovalQueue])


  const ingestDelta = useCallback((frame: { role?: string; delta?: string }) => {
    if (!frame?.delta) return
    setStreaming((current) => ({ role: frame.role ?? current?.role ?? 'head', text: `${current?.text ?? ''}${frame.delta}` }))
  }, [])

  const watchRun = useCallback((id: string) => {
    streamRef.current?.close()
    setStreaming(null)
    const source = openRunStream(id, {
      onEvent: ingestEvent,
      onDelta: ingestDelta,
      onPartial: (text) => setStreaming((current) => ({ role: current?.role ?? 'head', text })),
    })
    streamRef.current = source
  }, [ingestDelta, ingestEvent])

  useEffect(() => () => streamRef.current?.close(), [])

  // --------------------------------------------------------------- open a run

  const openRun = useCallback(async (id: string) => {
    setRunId(id)
    runIdRef.current = id
    setApproval(null)
    setArtifacts([])
    setSpend(emptySpend)
    setByTask([])
    setStreaming(null)
    await Promise.all([loadRun(id), loadPlan(id), loadTrace(id), loadArtifacts(id), loadEstimate(id)])
    await syncApprovalQueue(id)
    watchRun(id)
  }, [loadArtifacts, loadEstimate, loadPlan, loadRun, loadTrace, syncApprovalQueue, watchRun])

  /** The newest run for a project, or a new one when there is none to resume. */
  const openProject = useCallback(async (forProject: string, { permissionMode = 'selective', preferRun = null }: { permissionMode?: string; preferRun?: string | null } = {}) => {
    setProjectId(forProject)
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
  }, [loadRuns, openRun])

  // ------------------------------------------------------------------ startup

  useEffect(() => {
    void (async () => {
      try {
        const [list] = await Promise.all([loadProjects(), loadProviders(), loadStatus(), loadGrants(), loadConfig(), loadSettings()])
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
        await api.post('/api/chat', { projectId, runId, message, history: messages.slice(-20).map((entry) => ({ role: entry.role, content: entry.content })) })
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
    search: (query: string) => api.get<SearchResults>(`/api/search?q=${encodeURIComponent(query)}`),
    tree: (path = '.', depth = 2) => api.get<{ path: string; entries: TreeNode[] }>(`/api/workspace/tree?path=${encodeURIComponent(path)}&depth=${depth}`),
    fileHistory: (path: string) => api.get<{ path: string; calls: FileHistoryEntry[] }>(`/api/workspace/history?path=${encodeURIComponent(path)}`),
    reloadRuns: () => loadRuns(projectId),
  }), [approval, loadArtifacts, loadConfig, loadEstimate, loadGrants, loadProjects, loadProviders, loadRun, loadRuns, loadStatus, messages, openProject, openRun, projectId, projects, report, runId])

  return {
    projects, projectId, runs, runId, run, tasks, messages, toolCalls, events, plan, artifacts, spend, byTask, estimate, audit,
    providers, status, grants, configReport, usage, error, notice, streaming, approval, booted, appSettings,
    setError, setNotice, setApproval,
    openProject, openRun, loadRuns, loadStatus, loadGrants, loadConfig, loadUsage, loadProviders, loadSettings,
    ...actions,
    approveWithKeyboard: (scope: 'once' | 'run' | 'always') => actions.approveCall(scope),
  }
}

export type Bridge = ReturnType<typeof useBridge>
