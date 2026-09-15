import { type FormEvent, useEffect, useRef, useState } from 'react'
import {
  Activity,
  ArrowUpRight,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Eye,
  FileText,
  GitBranch,
  LayoutGrid,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Radio,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Users,
  X,
  Zap,
} from 'lucide-react'
import './App.css'

type Mode = 'plan' | 'execute' | 'review'
type PermissionMode = 'guided' | 'selective' | 'autopilot'
type AgentId = 'head' | 'research' | 'builder'
type AgentTone = 'orange' | 'teal' | 'blue'

type Agent = {
  id: AgentId
  name: string
  role: string
  description: string
  status: string
  tone: AgentTone
  avatar: string
}

type ActivityItem = {
  id: string
  kind: AgentId | 'system'
  title: string
  detail: string
  stamp: string
  tag: string
  toolCallId?: string
  approvalRequired?: boolean
}

type PendingApproval = {
  toolCallId: string
  name: string
  reason: string
}

type ChatMessage = {
  role: 'head' | 'you'
  text: string
  stamp: string
}

type ProviderStatus = {
  id: string
  label: string
  envKey: string
  model: string
  protocol: string
  baseUrl: string
  configured: boolean
  custom: boolean
}

type WorkspaceRun = {
  id: string
  projectId: string
  status: string
  mode: Mode
  permissionMode: string
  planVersion: number
  createdAt: number
  updatedAt: number
}

type WorkspaceProject = {
  id: string
  name: string
  status: string
  settings?: {
    routing?: Partial<Record<AgentId, string>>
  }
  runs?: WorkspaceRun[]
}

type WorkspaceEvent = {
  eventId: string
  runId: string
  sequence: number
  type: string
  agentId: string | null
  payload: Record<string, unknown>
  createdAt: number
}

function activityFromEvent(event: WorkspaceEvent): ActivityItem | null {
  const content = typeof event.payload.content === 'string' ? event.payload.content : ''
  const demo = event.payload.demo === true

  if (event.type === 'message.user') {
    return { id: event.eventId, kind: 'head', title: 'Head AI received your direction', detail: content, stamp: 'just now', tag: 'COMMAND' }
  }

  if (event.type === 'message.assistant') {
    return {
      id: event.eventId,
      kind: 'head',
      title: demo ? 'Head AI answered in demo mode' : 'Head AI answered through the selected API',
      detail: demo ? 'Add a provider key in .env.local to route this conversation to a live model.' : 'The response returned through the selected server-side provider route.',
      stamp: 'just now',
      tag: demo ? 'DEMO' : 'API',
    }
  }

  if (event.type.startsWith('task.')) {
    const kind = event.agentId === 'research' ? 'research' : event.agentId === 'builder' ? 'builder' : 'system'
    const workerName = event.agentId === 'research' ? 'Scout' : event.agentId === 'builder' ? 'Forge' : 'Head AI'
    const title = typeof event.payload.title === 'string' ? event.payload.title : 'Worker task'
    const summary = typeof event.payload.summary === 'string' ? event.payload.summary : ''
    const statusText: Record<string, string> = {
      'task.assigned': `${workerName} received a new task`,
      'task.started': `${workerName} started working`,
      'task.progress': `${workerName} reported progress`,
      'task.completed': `${workerName} completed a task`,
      'task.cancelled': `${workerName} task was cancelled`,
    }
    const tag: Record<string, string> = {
      'task.assigned': 'ASSIGNED',
      'task.started': 'WORKING',
      'task.progress': 'PROGRESS',
      'task.completed': 'DONE',
      'task.cancelled': 'CANCELLED',
    }
    return { id: event.eventId, kind, title: statusText[event.type] ?? title, detail: summary || title, stamp: 'just now', tag: tag[event.type] ?? 'TASK' }
  }

  if (event.type === 'worker.handoff') {
    const summary = typeof event.payload.summary === 'string' ? event.payload.summary : 'Findings were passed to the next worker.'
    return { id: event.eventId, kind: 'research', title: 'Scout handed findings to Forge', detail: summary, stamp: 'just now', tag: 'HANDOFF' }
  }

  if (event.type === 'head.review.started') {
    return { id: event.eventId, kind: 'head', title: 'Head AI is reviewing the worker round', detail: 'The Head is comparing Scout and Forge before preparing the next decision packet.', stamp: 'just now', tag: 'REVIEW' }
  }

  if (event.type === 'run.review.ready') {
    const summary = typeof event.payload.summary === 'string' ? event.payload.summary : 'The worker round is ready for your review.'
    return { id: event.eventId, kind: 'head', title: 'Head AI prepared a review packet', detail: summary, stamp: 'just now', tag: 'REVIEW READY' }
  }

  if (event.type.startsWith('tool.') || event.type === 'approval.requested') {
    const workerKind = event.agentId === 'research' ? 'research' : event.agentId === 'builder' ? 'builder' : 'head'
    const workerName = event.agentId === 'research' ? 'Scout' : event.agentId === 'builder' ? 'Forge' : 'Head AI'
    const toolName = typeof event.payload.name === 'string' ? event.payload.name : 'tool action'
    const reason = typeof event.payload.reason === 'string' ? event.payload.reason : ''
    const statusText: Record<string, string> = {
      'tool.requested': `${workerName} requested ${toolName}`,
      'tool.started': `${workerName} started ${toolName}`,
      'tool.completed': `${workerName} completed ${toolName}`,
      'tool.failed': `${workerName} failed ${toolName}`,
      'tool.denied': `${workerName} was denied ${toolName}`,
      'approval.requested': `Approval required for ${toolName}`,
    }
    const tag: Record<string, string> = {
      'tool.requested': 'TOOL',
      'tool.started': 'TOOL',
      'tool.completed': 'TOOL DONE',
      'tool.failed': 'TOOL ERROR',
      'tool.denied': 'DENIED',
      'approval.requested': 'APPROVAL',
    }
    return { id: event.eventId, kind: event.type === 'approval.requested' ? 'system' : workerKind, title: statusText[event.type] ?? `${workerName} used ${toolName}`, detail: reason || 'The action was recorded in the run audit.', stamp: 'just now', tag: tag[event.type] ?? 'TOOL', toolCallId: typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : undefined, approvalRequired: event.type === 'approval.requested' }
  }

  if (event.type === 'run.failed') {
    const error = typeof event.payload.error === 'string' ? event.payload.error : 'The worker run failed.'
    return { id: event.eventId, kind: 'system', title: 'The worker run failed', detail: error, stamp: 'just now', tag: 'RUN ERROR' }
  }

  if (event.type === 'run.permission.changed') {
    const mode = typeof event.payload.permissionMode === 'string' ? event.payload.permissionMode : 'selective'
    return { id: event.eventId, kind: 'system', title: `Permission mode changed to ${mode}`, detail: mode === 'guided' ? 'Consequential actions will pause for your approval.' : mode === 'selective' ? 'Low-risk work can proceed; writes, credentials, and external actions can pause.' : 'The run can proceed within its approved plan, workspace, and budget boundaries.', stamp: 'just now', tag: 'POLICY' }
  }

  const runEvents: Record<string, Omit<ActivityItem, 'id' | 'stamp'>> = {
    'plan.approved': { kind: 'system', title: 'You approved the plan and started the run', detail: 'Scout and Forge can now work in parallel. Head AI is overseeing the handoffs.', tag: 'RUN STARTED' },
    'run.paused': { kind: 'system', title: 'You paused the active run', detail: 'Agents will keep their context and wait for your next instruction.', tag: 'PAUSED' },
    'run.resumed': { kind: 'system', title: 'You resumed the active run', detail: 'The team can continue from the last confirmed checkpoint.', tag: 'RESUMED' },
    'run.cancelled': { kind: 'system', title: 'You reset the run back to planning', detail: 'No worker can make changes until a new plan is approved.', tag: 'RESET' },
  }
  const mapped = runEvents[event.type]
  return mapped ? { ...mapped, id: event.eventId, stamp: 'just now' } : null
}

function pendingApprovalFromEvent(event: WorkspaceEvent): PendingApproval | null {
  if (event.type !== 'approval.requested' || typeof event.payload.toolCallId !== 'string' || typeof event.payload.name !== 'string') return null
  return { toolCallId: event.payload.toolCallId, name: event.payload.name, reason: typeof event.payload.reason === 'string' ? event.payload.reason : 'This action requires your approval.' }
}

const agents: Agent[] = [
  {
    id: 'head',
    name: 'Head AI',
    role: 'Orchestrator',
    description: 'Owns the plan, resolves conflicts, and keeps the run moving.',
    status: 'Planning',
    tone: 'orange',
    avatar: 'H',
  },
  {
    id: 'research',
    name: 'Scout',
    role: 'Research worker',
    description: 'Finds evidence, patterns, and risks before work begins.',
    status: 'Ready',
    tone: 'teal',
    avatar: 'S',
  },
  {
    id: 'builder',
    name: 'Forge',
    role: 'Build worker',
    description: 'Turns an approved plan into artifacts, code, and checks.',
    status: 'Ready',
    tone: 'blue',
    avatar: 'F',
  },
]

const modes: { id: Mode; label: string; number: string }[] = [
  { id: 'plan', label: 'Plan', number: '01' },
  { id: 'execute', label: 'Execute', number: '02' },
  { id: 'review', label: 'Review', number: '03' },
]

const modelOptions: Record<AgentId, string[]> = {
  head: ['Grok · grok-4', 'OpenAI · gpt-5', 'Anthropic · claude-opus-4-1', 'Google · gemini-2.5-pro', 'DeepSeek · deepseek-chat', 'GLM · glm-4.5', 'Kimi · kimi-k2'],
  research: ['Anthropic · claude-opus-4-1', 'Grok · grok-4', 'Google · gemini-2.5-pro', 'DeepSeek · deepseek-chat', 'GLM · glm-4.5', 'Kimi · kimi-k2'],
  builder: ['OpenAI · gpt-5', 'Anthropic · claude-opus-4-1', 'Grok · grok-4', 'DeepSeek · deepseek-chat', 'GLM · glm-4.5', 'Kimi · kimi-k2'],
}

const starterRouting: Record<AgentId, string> = {
  head: modelOptions.head[0],
  research: 'Anthropic · claude-opus-4-1',
  builder: 'OpenAI · gpt-5',
}

const providerCatalog: ProviderStatus[] = [
  { id: 'grok', label: 'Grok', envKey: 'XAI_API_KEY', model: 'grok-4', protocol: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', configured: false, custom: false },
  { id: 'openai', label: 'OpenAI', envKey: 'OPENAI_API_KEY', model: 'gpt-5', protocol: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', configured: false, custom: false },
  { id: 'anthropic', label: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', model: 'claude-opus-4-1', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', configured: false, custom: false },
  { id: 'google', label: 'Google', envKey: 'GOOGLE_API_KEY', model: 'gemini-2.5-pro', protocol: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', configured: false, custom: false },
  { id: 'deepseek', label: 'DeepSeek', envKey: 'DEEPSEEK_API_KEY', model: 'deepseek-chat', protocol: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', configured: false, custom: false },
  { id: 'glm', label: 'GLM', envKey: 'GLM_API_KEY or ZAI_API_KEY', model: 'glm-4.5', protocol: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', configured: false, custom: false },
  { id: 'kimi', label: 'Kimi', envKey: 'KIMI_API_KEY or MOONSHOT_API_KEY', model: 'kimi-k2', protocol: 'openai-compatible', baseUrl: 'https://api.moonshot.ai/v1', configured: false, custom: false },
]

function App() {
  const [mode, setMode] = useState<Mode>('plan')
  const [approved, setApproved] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [routingOpen, setRoutingOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<AgentId>('head')
  const [routing, setRouting] = useState(starterRouting)
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [message, setMessage] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [providerStatus, setProviderStatus] = useState(providerCatalog)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [customProvider, setCustomProvider] = useState({ label: '', baseUrl: '', model: '', envKey: '' })
  const [customProviderError, setCustomProviderError] = useState('')
  const [isAddingProvider, setIsAddingProvider] = useState(false)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('selective')
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const eventCursor = useRef(0)

  const selected = agents.find((agent) => agent.id === selectedAgent) ?? agents[0]
  const runLabel = isPaused ? 'Paused' : mode === 'review' ? 'Review ready' : approved ? 'Live run' : 'Awaiting approval'
  const headProviderLabel = routing.head.split(' · ')[0]
  const headProviderReady = providerStatus.some((provider) => provider.label === headProviderLabel && provider.configured)

  const routeOptions = (agentId: AgentId) => {
    const configuredOptions = providerStatus.map((provider) => `${provider.label} · ${provider.model}`)
    return configuredOptions.length ? configuredOptions : modelOptions[agentId]
  }

  const persistRouting = async (nextRouting: Record<AgentId, string>) => {
    if (!projectId) return
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { routing: nextRouting } }),
    })
    if (!response.ok) throw new Error('Could not save model routing.')
  }

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      const providerResponse = await fetch('/api/providers')
      if (providerResponse.ok) {
        const providerPayload = (await providerResponse.json()) as { providers?: ProviderStatus[] }
        if (!cancelled && providerPayload.providers?.length) {
          setProviderStatus(providerPayload.providers)
          for (const agentId of Object.keys(modelOptions) as AgentId[]) {
            for (const provider of providerPayload.providers) {
              const route = `${provider.label} · ${provider.model}`
              if (!modelOptions[agentId].includes(route)) modelOptions[agentId].push(route)
            }
          }
        }
      }

      const defaultProjectResponse = await fetch('/api/projects/default')
      if (!defaultProjectResponse.ok) return
      const defaultProjectPayload = await defaultProjectResponse.json() as { project?: WorkspaceProject; runs?: WorkspaceRun[] }
      const initialProject = defaultProjectPayload.project ? { ...defaultProjectPayload.project, runs: defaultProjectPayload.runs ?? [] } : undefined

      if (!initialProject || cancelled) return
      const projectDetailResponse = await fetch(`/api/projects/${encodeURIComponent(initialProject.id)}`)
      const projectDetail = projectDetailResponse.ok ? await projectDetailResponse.json() as { project?: WorkspaceProject; runs?: WorkspaceRun[] } : {}
      const project = projectDetail.project ? { ...projectDetail.project, runs: projectDetail.runs ?? [] } : initialProject
      if (project.settings?.routing) {
        setRouting((current) => ({ ...current, ...project.settings?.routing }))
      }
      let activeRun = project.runs?.find((item) => !['cancelled', 'completed'].includes(item.status))
      if (!activeRun) {
        const createRunResponse = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: project.id, mode: 'plan', permissionMode: 'selective' }),
        })
        if (!createRunResponse.ok) return
        activeRun = (await createRunResponse.json() as { run?: WorkspaceRun }).run
      }

      if (!activeRun || cancelled) return
      setProjectId(project.id)
      setRunId(activeRun.id)
      setPermissionMode(activeRun.permissionMode as PermissionMode)
      const runIsApproved = ['executing', 'paused', 'review'].includes(activeRun.status)
      setApproved(runIsApproved)
      setIsPaused(activeRun.status === 'paused')
      setMode(activeRun.status === 'review' ? 'review' : runIsApproved ? 'execute' : activeRun.mode)
      const snapshotResponse = await fetch(`/api/runs/${encodeURIComponent(activeRun.id)}`)
      if (!snapshotResponse.ok || cancelled) return
      const snapshot = await snapshotResponse.json() as { messages?: Array<{ role: string; content: string; createdAt: number }>; events?: WorkspaceEvent[] }
      if (snapshot.messages?.length) {
        setMessages(snapshot.messages.filter((item) => item.role === 'user' || item.role === 'assistant').map((item) => ({
          role: item.role === 'user' ? 'you' : 'head',
          text: item.content,
          stamp: new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        })))
      }
      if (snapshot.events?.length) {
        eventCursor.current = Math.max(...snapshot.events.map((item) => item.sequence))
        const persistedActivity = snapshot.events.flatMap((item) => {
          const mapped = activityFromEvent(item)
          return mapped ? [mapped] : []
        })
        setActivity((current) => {
          const existing = new Set(current.map((item) => `${item.title}|${item.detail}|${item.tag}`))
          return [...persistedActivity.filter((item) => !existing.has(`${item.title}|${item.detail}|${item.tag}`)), ...current]
        })
        const latestApproval = [...snapshot.events].reverse().map(pendingApprovalFromEvent).find((item): item is PendingApproval => item !== null)
        if (latestApproval) setPendingApproval(latestApproval)
      }
    }

    bootstrap().catch(() => {
      // The UI remains usable in demo mode when the API bridge is not running.
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!projectId) return
    void fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { routing } }),
    }).catch(() => undefined)
  }, [projectId, routing])

  useEffect(() => {
    if (!runId) return
    eventCursor.current = 0

    const ingestEvent = (event: WorkspaceEvent) => {
      eventCursor.current = Math.max(eventCursor.current, event.sequence)
      if (event.type === 'run.review.ready') setMode('review')
      const approval = pendingApprovalFromEvent(event)
      if (approval) setPendingApproval(approval)
      if (['tool.completed', 'tool.failed', 'tool.denied'].includes(event.type) && event.payload.toolCallId === pendingApproval?.toolCallId) setPendingApproval(null)
      const mapped = activityFromEvent(event)
      if (!mapped) return
      setActivity((current) => {
        const existing = new Set(current.map((item) => `${item.title}|${item.detail}|${item.tag}`))
        const key = `${mapped.title}|${mapped.detail}|${mapped.tag}`
        return existing.has(key) ? current : [mapped, ...current]
      })
    }

    const eventSource = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream?after=${eventCursor.current}`)
    const handleEvent = (event: Event) => {
      try {
        const message = event as MessageEvent<string>
        ingestEvent(JSON.parse(message.data) as WorkspaceEvent)
      } catch {
        // Ignore malformed stream frames; the next reconnect will replay by sequence.
      }
    }
    eventSource.addEventListener('fulkrum', handleEvent)

    return () => {
      eventSource.removeEventListener('fulkrum', handleEvent)
      eventSource.close()
    }
  }, [runId, pendingApproval?.toolCallId])

  const addCustomProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCustomProviderError('')
    setIsAddingProvider(true)

    try {
      const response = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(customProvider),
      })
      const payload = (await response.json()) as { provider?: ProviderStatus; error?: string }
      if (!response.ok || !payload.provider) throw new Error(payload.error ?? 'Could not add provider.')
      setProviderStatus((current) => [...current.filter((item) => item.id !== payload.provider?.id), payload.provider as ProviderStatus])
      const providerRoute = `${payload.provider.label} · ${payload.provider.model}`
      for (const agentId of Object.keys(modelOptions) as AgentId[]) {
        if (!modelOptions[agentId].includes(providerRoute)) modelOptions[agentId].push(providerRoute)
      }
      const nextRouting = { ...routing, head: providerRoute }
      setRouting(nextRouting)
      void persistRouting(nextRouting).catch(() => undefined)
      setCustomProvider({ label: '', baseUrl: '', model: '', envKey: '' })
    } catch (error) {
      setCustomProviderError(error instanceof Error ? error.message : 'Could not add provider.')
    } finally {
      setIsAddingProvider(false)
    }
  }

  const removeProvider = async (provider: ProviderStatus) => {
    if (!provider.custom || !window.confirm(`Remove ${provider.label} from Fulkrum?`)) return
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' })
      const payload = (await response.json().catch(() => ({}))) as { providers?: ProviderStatus[]; error?: string }
      if (!response.ok || !payload.providers) throw new Error(payload.error ?? 'Could not remove provider.')
      setProviderStatus(payload.providers)
      for (const agentId of Object.keys(modelOptions) as AgentId[]) {
        const nextOptions = modelOptions[agentId].filter((option) => !option.startsWith(`${provider.label} · `))
        modelOptions[agentId].splice(0, modelOptions[agentId].length, ...nextOptions)
      }
      setRouting((current) => ({
        ...current,
        head: current.head.startsWith(`${provider.label} · `) ? modelOptions.head[0] : current.head,
        research: current.research.startsWith(`${provider.label} · `) ? modelOptions.research[0] : current.research,
        builder: current.builder.startsWith(`${provider.label} · `) ? modelOptions.builder[0] : current.builder,
      }))
      addActivity({ kind: 'system', title: `${provider.label} removed`, detail: 'The provider route was removed from the workspace.', tag: 'SETTINGS' })
    } catch (error) {
      addActivity({ kind: 'system', title: 'Could not remove provider', detail: error instanceof Error ? error.message : 'Provider removal failed.', tag: 'API ERROR' })
    }
  }

  const addActivity = (item: Omit<ActivityItem, 'id' | 'stamp'>) => {
    setActivity((current) => [
      { ...item, id: `${item.tag}-${Date.now()}`, stamp: 'just now' },
      ...current,
    ])
  }

  const controlRun = async (action: 'approve-plan' | 'pause' | 'resume' | 'cancel' | 'set-permission', details: Record<string, unknown> = {}) => {
    if (!runId) return
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...details }),
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      throw new Error(payload.error ?? 'Run control request failed.')
    }
  }

  const changePermissionMode = async (nextMode: PermissionMode) => {
    try {
      await controlRun('set-permission', { permissionMode: nextMode })
      setPermissionMode(nextMode)
      addActivity({
        kind: 'system',
        title: `Permission mode changed to ${nextMode}`,
        detail: nextMode === 'guided' ? 'Consequential actions will pause for your approval.' : nextMode === 'selective' ? 'Low-risk work can proceed; writes, credentials, and external actions can pause.' : 'The run can proceed within its approved plan, workspace, and budget boundaries.',
        tag: 'POLICY',
      })
    } catch (error) {
      addActivity({ kind: 'system', title: 'Could not change permission mode', detail: error instanceof Error ? error.message : 'Run control request failed.', tag: 'API ERROR' })
    }
  }

  const approveToolCall = async () => {
    if (!runId || !pendingApproval) return
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/tools/${encodeURIComponent(pendingApproval.toolCallId)}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'Tool approval failed.')
      setPendingApproval(null)
    } catch (error) {
      addActivity({ kind: 'system', title: 'Could not approve the tool call', detail: error instanceof Error ? error.message : 'Tool approval failed.', tag: 'API ERROR' })
    }
  }

  const approvePlan = async () => {
    try {
      await controlRun('approve-plan', { routing })
    } catch (error) {
      addActivity({ kind: 'system', title: 'Could not approve the plan', detail: error instanceof Error ? error.message : 'Run control request failed.', tag: 'API ERROR' })
      return
    }
    setApproved(true)
    setIsPaused(false)
    setMode('execute')
    addActivity({
      kind: 'system',
      title: 'You approved the plan and started the run',
      detail: 'Scout and Forge can now work in parallel. Head AI is overseeing the handoffs.',
      tag: 'RUN STARTED',
    })
  }

  const togglePause = async () => {
    const nextPaused = !isPaused
    try {
      await controlRun(nextPaused ? 'pause' : 'resume')
    } catch (error) {
      addActivity({ kind: 'system', title: nextPaused ? 'Could not pause the run' : 'Could not resume the run', detail: error instanceof Error ? error.message : 'Run control request failed.', tag: 'API ERROR' })
      return
    }
    setIsPaused(nextPaused)
    addActivity({
      kind: 'system',
      title: nextPaused ? 'You paused the active run' : 'You resumed the active run',
      detail: nextPaused ? 'Agents will keep their context and wait for your next instruction.' : 'The team can continue from the last confirmed checkpoint.',
      tag: nextPaused ? 'PAUSED' : 'RESUMED',
    })
  }

  const stopRun = async () => {
    try {
      await controlRun('cancel')
    } catch (error) {
      addActivity({ kind: 'system', title: 'Could not stop the run', detail: error instanceof Error ? error.message : 'Run control request failed.', tag: 'API ERROR' })
      return
    }
    setApproved(false)
    setIsPaused(false)
    setMode('plan')
    addActivity({
      kind: 'system',
      title: 'You reset the run back to planning',
      detail: 'No worker can make changes until a new plan is approved.',
      tag: 'RESET',
    })
  }

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedMessage = message.trim()

    if (!trimmedMessage || isPaused || isSending) {
      return
    }

    const nextMessages = [
      ...messages,
      { role: 'you' as const, text: trimmedMessage, stamp: 'now' },
    ]

    setMessages((current) => [
      ...current,
      { role: 'you', text: trimmedMessage, stamp: 'now' },
    ])
    setMessage('')
    addActivity({
      kind: 'head',
      title: 'Head AI received your direction',
      detail: trimmedMessage,
      tag: 'COMMAND',
    })
    setIsSending(true)

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmedMessage,
          history: nextMessages.map((item) => ({
            role: item.role === 'you' ? 'user' : 'assistant',
            content: item.text,
          })),
          routing: { head: routing.head },
          mode,
          projectId,
          runId,
        }),
      })
      const payload = (await response.json()) as { reply?: string; demo?: boolean; error?: string; projectId?: string; runId?: string }

      if (!response.ok || !payload.reply) {
        throw new Error(payload.error ?? 'The Head AI could not answer.')
      }

      if (payload.projectId) setProjectId(payload.projectId)
      if (payload.runId) setRunId(payload.runId)
      setMessages((current) => [...current, { role: 'head', text: payload.reply ?? '', stamp: 'now' }])
      addActivity({
        kind: 'head',
        title: payload.demo ? 'Head AI answered in demo mode' : `Head AI answered through ${headProviderLabel}`,
        detail: payload.demo ? 'Add a provider key in .env.local to route this conversation to a live model.' : 'The response returned through the selected server-side provider route.',
        tag: payload.demo ? 'DEMO' : 'API',
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'The Head AI could not answer.'
      setMessages((current) => [...current, { role: 'head', text: errorMessage, stamp: 'now' }])
      addActivity({
        kind: 'system',
        title: 'Head AI could not reach the selected API',
        detail: errorMessage,
        tag: 'API ERROR',
      })
    } finally {
      setIsSending(false)
    }
  }

  const changeMode = (nextMode: Mode) => {
    if (nextMode === 'execute' && !approved) {
      return
    }
    setMode(nextMode)
  }

  return (
    <div className="fulkrum-app">
      <aside className="sidebar">
        <div className="brand-lockup"><div className="brand-mark"><Sparkles size={17} strokeWidth={2.5} /></div><span>fulkrum</span></div>
        <button className="workspace-picker" type="button"><span className="workspace-avatar">A</span><span className="workspace-copy"><strong>Atlas studio</strong><small>Personal workspace</small></span><ChevronDown size={15} /></button>
        <nav className="primary-nav" aria-label="Primary navigation"><p className="nav-label">Workspace</p><button className="nav-item active" type="button"><LayoutGrid size={17} /><span>Command center</span><span className="nav-count">1</span></button><button className="nav-item" type="button"><MessageCircle size={17} /><span>Conversations</span></button><button className="nav-item" type="button"><FileText size={17} /><span>Artifacts</span></button><button className="nav-item" type="button"><Activity size={17} /><span>Run history</span></button></nav>
        <div className="project-section"><div className="section-label-row"><p className="nav-label">Projects</p><button className="icon-button subtle" type="button" title="New project"><Plus size={15} /></button></div><button className="project-item active" type="button"><span className="project-dot coral"></span><span><strong>Launch plan</strong><small>3 agents · active</small></span><MoreHorizontal size={16} /></button><button className="project-item" type="button"><span className="project-dot teal"></span><span><strong>Website refresh</strong><small>2 agents · idle</small></span></button></div>
        <div className="sidebar-bottom"><div className="sidebar-note"><ShieldCheck size={16} /><span>Keys stay server-side</span></div><button className="account-row" type="button"><span className="account-avatar">AR</span><span><strong>Alex Rivera</strong><small>Builder account</small></span><MoreHorizontal size={16} /></button></div>
      </aside>

      <main className="main-column">
        <header className="topbar"><div className="breadcrumb"><span>Atlas studio</span><ChevronRight size={14} /><strong>Launch plan</strong></div><div className="topbar-actions"><span className="live-pill"><span className="live-dot"></span>{runLabel}</span><button className="icon-button" type="button" title="Notifications"><Bell size={17} /></button><button className="help-button" type="button"><CircleHelp size={16} /> Help</button><button className="user-avatar" type="button">AR</button></div></header>

        <div className="content-wrap">
          <section className="page-heading"><div><p className="eyebrow">Project 04 / team room</p><h1>Work with your AI team</h1><p className="heading-copy">Talk to Head AI, watch Scout and Forge work, and keep every meaningful action visible.</p></div><button className="routing-button" type="button" onClick={() => setSettingsOpen(true)}><SlidersHorizontal size={17} /><span><strong>Workspace settings</strong><small>Providers, routing, and permissions</small></span><ArrowUpRight size={16} /></button></section>

          <div className="mode-row"><div className="mode-switch" role="tablist" aria-label="Run mode">{modes.map((item) => <button key={item.id} className={`mode-tab ${mode === item.id ? 'selected' : ''} ${item.id === 'execute' && !approved ? 'locked' : ''}`} type="button" role="tab" aria-selected={mode === item.id} onClick={() => changeMode(item.id)}><span className="mode-number">{item.number}</span><span>{item.label}</span>{item.id === 'execute' && !approved ? <ShieldCheck size={14} /> : null}</button>)}</div><div className="run-controls"><span className="run-id"><GitBranch size={14} /> run-014</span>{approved ? <button className="control-button" type="button" onClick={togglePause}>{isPaused ? <Play size={15} /> : <Pause size={15} />}{isPaused ? 'Resume' : 'Pause'}</button> : null}<button className="control-button stop" type="button" onClick={stopRun}><Square size={13} fill="currentColor" /> Stop</button></div></div>

          <section className={`run-overview ${mode}`}><div className="run-copy"><div className="run-meta"><span className="run-kicker"><Zap size={13} fill="currentColor" /> {mode === 'plan' ? 'PLAN IN REVIEW' : mode === 'execute' ? 'EXECUTION ACTIVE' : 'REVIEW CHECKPOINT'}</span><span className="run-time"><Clock3 size={13} /> started 09:38</span></div><h2>Prove the first release before scaling the machine.</h2><p>Three agents, one approved brief, and a visible handoff at every decision that matters.</p></div><div className="run-action"><span className="approval-label"><span className={`approval-dot ${approved ? 'approved' : ''}`}></span>{approved ? 'Plan approved' : 'Waiting for your approval'}</span>{!approved ? <button className="primary-button" type="button" onClick={approvePlan}><CheckCircle2 size={17} />Approve &amp; start run</button> : <button className="secondary-button" type="button" onClick={() => setMode('review')}><Eye size={16} />Open review</button>}</div><div className="progress-line"><div className="progress-step complete"><span><Check size={14} /></span><small>Brief</small></div><div className={`progress-step ${approved ? 'complete' : 'current'}`}><span>{approved ? <Check size={14} /> : '2'}</span><small>Build</small></div><div className="progress-step"><span>3</span><small>Review</small></div><div className="progress-track"><i className={approved ? 'filled-two' : 'filled-one'}></i></div></div></section>

          <section className="agents-section"><div className="section-heading"><div><p className="eyebrow">Active crew</p><h2>Three minds, one outcome</h2></div><button className="text-action" type="button" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /> Edit routing</button></div><div className="agents-grid">{agents.map((agent) => { const isSelected = selectedAgent === agent.id; const status = isPaused ? 'Paused' : approved ? (agent.id === 'head' ? 'Overseeing' : 'Working') : agent.status; return <button key={agent.id} className={`agent-card ${agent.tone} ${isSelected ? 'selected' : ''}`} type="button" onClick={() => setSelectedAgent(agent.id)}><div className="agent-card-top"><span className="agent-avatar">{agent.avatar}</span><span className={`agent-status ${status === 'Ready' ? 'ready' : status === 'Paused' ? 'paused' : ''}`}><span></span>{status}</span><MoreHorizontal size={16} /></div><div className="agent-card-body"><strong>{agent.name}</strong><span>{agent.role}</span><p>{agent.description}</p></div><div className="agent-card-footer"><span className="model-label"><Bot size={14} />{routing[agent.id]}</span><ArrowUpRight size={15} /></div></button> })}</div></section>

          <div className="focus-strip"><span className="focus-icon"><Bot size={16} /></span><span><strong>{selected.name} selected</strong><small>{selected.id === 'head' ? 'You are speaking to the Head AI. It sees the full team context.' : `${selected.name} is visible to Head AI and can contribute to the shared task room.`}</small></span><span className="focus-spacer"></span><span className="focus-model">{routing[selected.id]}</span></div>

          <section className="provider-setup-panel"><div className="provider-setup-heading"><div><p className="eyebrow">Bring your own model</p><h2>Add a custom API</h2><p>OpenAI-compatible endpoints such as DeepSeek, GLM, Kimi, or a private gateway can join the team without changing the UI.</p></div><span className="provider-count"><Bot size={14} />{routeOptions('head').length} routes</span></div><form className="provider-setup-form" onSubmit={addCustomProvider}><label><span>Provider name</span><input value={customProvider.label} onChange={(event) => setCustomProvider((current) => ({ ...current, label: event.target.value }))} placeholder="e.g. Local gateway" /></label><label><span>Base URL</span><input value={customProvider.baseUrl} onChange={(event) => setCustomProvider((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" /></label><label><span>Model</span><input value={customProvider.model} onChange={(event) => setCustomProvider((current) => ({ ...current, model: event.target.value }))} placeholder="model-name" /></label><label><span>Environment key</span><input value={customProvider.envKey} onChange={(event) => setCustomProvider((current) => ({ ...current, envKey: event.target.value }))} placeholder="CUSTOM_API_KEY" /></label><button className="primary-button provider-submit" type="submit" disabled={isAddingProvider}>{isAddingProvider ? 'Adding...' : <><Plus size={15} />Add provider</>}</button></form>{customProviderError ? <p className="provider-form-error">{customProviderError}</p> : null}</section>

          <section className="workbench-grid"><section className="panel activity-panel"><header className="panel-header"><div><p className="eyebrow">Live coordination</p><h2>Team feed</h2></div><span className="event-counter"><Radio size={13} />{activity.length} events</span></header><div className="activity-list">{activity.map((item) => { const Icon = item.kind === 'head' ? Sparkles : item.kind === 'research' ? Eye : item.kind === 'builder' ? Code2 : Radio; const speaker = item.kind === 'head' ? 'Head AI' : item.kind === 'research' ? 'Scout' : item.kind === 'builder' ? 'Forge' : 'You'; return <article className={`activity-item ${item.kind}`} key={item.id}><div className="activity-icon"><Icon size={16} /></div><div className="activity-body"><div className="activity-title"><strong>{item.title}</strong><span className="activity-tag">{item.tag}</span></div><p>{item.detail}</p><div className="activity-footer"><span>{speaker}</span><span>{item.stamp}</span></div></div></article> })}</div><footer className="activity-note"><Activity size={14} /><span>Everything the agents do appears here before it becomes part of the final result.</span></footer></section>

            <section className="panel chat-panel"><header className="panel-header chat-header"><div className="chat-title"><span className="head-avatar"><Sparkles size={16} /></span><div><p className="eyebrow">Private channel</p><h2>Head AI</h2></div><span className={`online-indicator ${headProviderReady ? '' : 'demo'}`}>{headProviderReady ? 'api ready' : 'demo mode'}</span></div><button className="icon-button" type="button" title="Head AI settings"><Settings2 size={17} /></button></header><div className="chat-context"><Users size={14} /><span>Full team context</span><span className="context-dot">·</span><span>{approved ? 'Execution is live' : 'Planning together'}</span><span className="context-spacer"></span><span className="route-context">{headProviderLabel}</span></div><div className="messages" aria-live="polite">{messages.map((item, index) => <div className={`message-row ${item.role}`} key={`${item.stamp}-${index}`}><div className="message-avatar">{item.role === 'head' ? <Sparkles size={14} /> : 'AR'}</div><div className="message-bubble"><div className="message-meta"><strong>{item.role === 'head' ? 'Head AI' : 'You'}</strong><span>{item.stamp}</span></div><p>{item.text}</p></div></div>)}</div><form className="composer" onSubmit={sendMessage}><textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder={isPaused ? 'Resume the run to send a direction...' : isSending ? 'Head AI is thinking...' : 'Direct the Head AI...'} rows={2} disabled={isPaused || isSending} /><div className="composer-footer"><span><span className="key-hint">⌘</span> + Enter to direct the team</span><button className="send-button" type="submit" title="Send direction" disabled={!message.trim() || isPaused || isSending}>{isSending ? <span className="send-spinner"></span> : <Send size={16} />}</button></div></form></section></section>
        </div>
      </main>

      <div className="permission-dock"><ShieldCheck size={15} /><span><strong>Permission mode</strong><small>{permissionMode === 'guided' ? 'Ask before consequential actions' : permissionMode === 'selective' ? 'Pause on risky actions' : 'Run within approved boundaries'}</small></span><select aria-label="Permission mode" value={permissionMode} onChange={(event) => void changePermissionMode(event.target.value as PermissionMode)}><option value="guided">Guided</option><option value="selective">Selective</option><option value="autopilot">Autopilot</option></select></div>

      {settingsOpen ? <div className="routing-layer settings-layer"><button className="drawer-backdrop" type="button" aria-label="Close workspace settings" onClick={() => setSettingsOpen(false)}></button><aside className="routing-drawer settings-drawer"><header className="drawer-header"><div><p className="eyebrow">Workspace settings</p><h2>Make the team yours</h2></div><button className="icon-button" type="button" title="Close workspace settings" onClick={() => setSettingsOpen(false)}><X size={18} /></button></header><p className="drawer-copy">Connect the models you already use, assign one to each role, and choose how much autonomy this run has.</p><section className="settings-section"><div className="settings-section-heading"><div><p className="drawer-section-label">Provider APIs</p><small>Built-ins stay available. Custom endpoints can be removed at any time.</small></div><span className="provider-count"><Bot size={14} />{providerStatus.filter((provider) => provider.configured).length} connected</span></div><div className="settings-provider-list">{providerStatus.map((provider) => <div className="settings-provider-row" key={provider.id}><span className="settings-provider-main"><span className={`provider-state-dot ${provider.configured ? 'connected' : ''}`}></span><span><strong>{provider.label}</strong><small>{provider.model} · {provider.envKey}</small></span></span><span className="settings-provider-actions"><span className={`provider-state ${provider.configured ? 'connected' : ''}`}>{provider.configured ? 'Connected' : 'Add key'}</span>{provider.custom ? <button className="icon-button danger" type="button" title={`Remove ${provider.label}`} onClick={() => void removeProvider(provider)}><Trash2 size={15} /></button> : <span className="provider-built-in">Built-in</span>}</span></div>)}</div></section><section className="settings-section"><p className="drawer-section-label">Add custom OpenAI-compatible API</p><form className="settings-provider-form" onSubmit={addCustomProvider}><label><span>Name</span><input value={customProvider.label} onChange={(event) => setCustomProvider((current) => ({ ...current, label: event.target.value }))} placeholder="Local gateway" /></label><label><span>Base URL</span><input value={customProvider.baseUrl} onChange={(event) => setCustomProvider((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" /></label><label><span>Model</span><input value={customProvider.model} onChange={(event) => setCustomProvider((current) => ({ ...current, model: event.target.value }))} placeholder="model-name" /></label><label><span>Environment key</span><input value={customProvider.envKey} onChange={(event) => setCustomProvider((current) => ({ ...current, envKey: event.target.value }))} placeholder="CUSTOM_API_KEY" /></label><button className="primary-button" type="submit" disabled={isAddingProvider}>{isAddingProvider ? 'Adding...' : <><Plus size={15} />Add API</>}</button></form>{customProviderError ? <p className="provider-form-error">{customProviderError}</p> : null}</section><section className="settings-section"><p className="drawer-section-label">Role routing</p><div className="settings-routing-list">{agents.map((agent) => <label className="route-field" key={agent.id}><span className={`route-avatar ${agent.tone}`}>{agent.avatar}</span><span className="route-label"><strong>{agent.name}</strong><small>{agent.role}</small></span><select value={routing[agent.id]} onChange={(event) => setRouting((current) => ({ ...current, [agent.id]: event.target.value }))}>{modelOptions[agent.id].map((option) => <option key={option}>{option}</option>)}</select></label>)}</div></section><section className="settings-section"><div className="settings-permission"><span><strong>Permission mode</strong><small>{permissionMode === 'guided' ? 'Ask before consequential actions' : permissionMode === 'selective' ? 'Pause on risky actions' : 'Run inside approved boundaries'}</small></span><select aria-label="Permission mode" value={permissionMode} onChange={(event) => void changePermissionMode(event.target.value as PermissionMode)}><option value="guided">Guided</option><option value="selective">Selective</option><option value="autopilot">Autopilot</option></select></div></section><footer className="drawer-footer"><button className="primary-button" type="button" onClick={() => setSettingsOpen(false)}><Check size={16} />Done</button></footer></aside></div> : null}

      {routingOpen ? <div className="routing-layer"><button className="drawer-backdrop" type="button" aria-label="Close routing panel" onClick={() => setRoutingOpen(false)}></button><aside className="routing-drawer"><header className="drawer-header"><div><p className="eyebrow">Model routing</p><h2>Choose the brains</h2></div><button className="icon-button" type="button" title="Close routing" onClick={() => setRoutingOpen(false)}><X size={18} /></button></header><p className="drawer-copy">Choose a model for each role. Add the matching key to <code>.env.local</code>; the browser only sees connection status.</p><div className="provider-connections"><p className="drawer-section-label">Provider connections</p>{providerStatus.map((provider) => <div className="provider-row" key={provider.id}><span><strong>{provider.label}</strong><small>{provider.envKey}</small></span><span className={`provider-state ${provider.configured ? 'connected' : ''}`}><span></span>{provider.configured ? 'Connected' : 'Add key'}</span></div>)}</div><div className="route-fields"><p className="drawer-section-label">Role routing</p>{agents.map((agent) => <label className="route-field" key={agent.id}><span className={`route-avatar ${agent.tone}`}>{agent.avatar}</span><span className="route-label"><strong>{agent.name}</strong><small>{agent.role}</small></span><select value={routing[agent.id]} onChange={(event) => setRouting((current) => ({ ...current, [agent.id]: event.target.value }))}>{modelOptions[agent.id].map((option) => <option key={option}>{option}</option>)}</select></label>)}</div><div className="drawer-callout"><ShieldCheck size={17} /><span><strong>API keys are not stored in the browser.</strong><small>Fulkrum sends chat requests through the local server adapter.</small></span></div><footer className="drawer-footer"><button className="secondary-button" type="button" onClick={() => setRoutingOpen(false)}>Cancel</button><button className="primary-button" type="button" onClick={() => setRoutingOpen(false)}><Check size={16} />Save routing</button></footer></aside></div> : null}
      {pendingApproval ? <div className="tool-approval-banner"><ShieldCheck size={17} /><span><strong>Approval needed for {pendingApproval.name}</strong><small>{pendingApproval.reason}</small></span><button className="primary-button" type="button" onClick={() => void approveToolCall()}><Check size={15} />Approve once</button></div> : null}
    </div>
  )
}

export default App
