import type { Plan, Run, Task, ToolCall } from '../api/types'

/**
 * The graph is a projection, never a source: everything a node or an edge shows
 * is derived from the run snapshot (plan, tasks, tool calls, spend) that the
 * bridge already holds, so the map cannot disagree with the record. Positions
 * are percentages of the canvas; the SVG layer stretches to match.
 */

export type GraphNodeState = 'idle' | 'working' | 'waiting' | 'done' | 'failed' | 'blocked'

export type GraphNode = {
  id: string
  kind: 'you' | 'head' | 'task'
  agentId: string | null
  title: string
  subtitle: string
  state: GraphNodeState
  costUsd: number | null
  /** Who plays this role, e.g. "Grok · grok-4" — null when unrouted. */
  model: string | null
  x: number
  y: number
}

export type RouteProvider = { id: string; label: string; model: string }

/**
 * What the casting says, in words. A route is `Label` or `Label · model`;
 * anything unresolvable is shown verbatim rather than hidden, so a stale route
 * is visible instead of silently wrong.
 */
export function resolveRouteDisplay(routing: Record<string, string>, providers: RouteProvider[], role: string): string | null {
  const route = (routing[role] ?? '').trim()
  if (!route) return null
  const [label, model] = route.split('·').map((part) => part.trim())
  const provider = providers.find((entry) => entry.id === (label ?? '').toLowerCase() || entry.label.toLowerCase() === (label ?? '').toLowerCase())
  if (!provider) return route
  return model ? `${provider.label} · ${model}` : `${provider.label} · ${provider.model}`
}

export type GraphEdge = {
  id: string
  from: string
  to: string
  label: string
  tone: 'flow' | 'wait' | 'plain'
}

export type GraphModel = { nodes: GraphNode[]; edges: GraphEdge[] }

const ROLE_LABEL: Record<string, string> = { research: 'Scout', builder: 'Forge', head: 'Head AI', architect: 'Architect', editor: 'Editor', debug: 'Debugger', reviewer: 'Reviewer' }
export const roleLabel = (role: string) => ROLE_LABEL[role] ?? role

/** Dependency depth: a task with no deps sits in layer 0, everything else one past its deepest prerequisite. */
export function taskLayers(tasks: Array<{ dependsOn: number[] }>): number[] {
  const layers: number[] = []
  for (let index = 0; index < tasks.length; index += 1) {
    const deps = tasks[index]?.dependsOn ?? []
    layers[index] = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => layers[dep] ?? 0))
  }
  return layers
}

function taskState(task: Task | undefined, waitingAgent: string | null): GraphNodeState {
  if (!task) return 'idle'
  if (waitingAgent && task.agentId === waitingAgent && task.status === 'running') return 'waiting'
  if (task.status === 'completed') return 'done'
  if (task.status === 'failed') return 'failed'
  if (task.status === 'blocked' || task.status === 'skipped' || task.status === 'cancelled') return 'blocked'
  if (task.status === 'running') return 'working'
  return 'idle'
}

/**
 * Lay the run out: you on top, the Head below you, and the plan's tasks in
 * dependency layers underneath — readers of the same layer side by side.
 */
export function buildGraph(input: {
  run: Run | null
  plan: Plan | null
  tasks: Task[]
  toolCalls: ToolCall[]
  byTask: Array<{ taskId: string | null; agentId: string | null; costUsd: number }>
  routing?: Record<string, string>
  providers?: RouteProvider[]
}): GraphModel {
  const { run, plan, tasks, toolCalls, byTask, routing = {}, providers = [] } = input
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  if (!run) return { nodes, edges }

  const runLive = ['planning', 'executing'].includes(run.status)
  const waitingCall = toolCalls.find((call) => call.status === 'approval_required')
  const waitingAgent = waitingCall?.agentId ?? null

  nodes.push({ id: 'you', kind: 'you', agentId: null, title: 'You', subtitle: plan?.plan.status === 'approved' ? `approved plan v${plan.plan.version}` : 'in control', state: 'idle', costUsd: null, model: null, x: 50, y: 9 })
  const headWorking = runLive || waitingAgent !== null
  nodes.push({ id: 'head', kind: 'head', agentId: 'head', title: 'Head AI', subtitle: run.status === 'review' ? 'review ready' : headWorking ? 'supervising' : run.status.replaceAll('_', ' '), state: run.status === 'review' ? 'done' : headWorking ? 'working' : 'idle', costUsd: null, model: resolveRouteDisplay(routing, providers, 'head'), x: 50, y: 27 })

  edges.push({ id: 'e-you-head', from: 'you', to: 'head', label: 'direction', tone: runLive ? 'flow' : 'plain' })

  const planTasks = plan?.tasks ?? []
  const layers = taskLayers(planTasks)
  const byLayer = new Map<number, number[]>()
  planTasks.forEach((_planTask, index) => {
    const layer = layers[index] ?? 0
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), index])
  })

  const maxLayer = Math.max(0, ...layers)
  // Cost per task first; a role-wide total only when the task row is unknown.
  const costByTask = new Map<string, number>()
  const costByAgent = new Map<string, number>()
  for (const entry of byTask) {
    if (entry.taskId) costByTask.set(entry.taskId, (costByTask.get(entry.taskId) ?? 0) + entry.costUsd)
    else if (entry.agentId) costByAgent.set(entry.agentId, (costByAgent.get(entry.agentId) ?? 0) + entry.costUsd)
  }

  // Tasks are matched to plan tasks by the plan task id they were materialized with.
  const taskByPlanId = new Map<string, Task>()
  for (const task of tasks) {
    if (task.planTaskId) taskByPlanId.set(task.planTaskId, task)
  }

  for (const [layer, indexes] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    const spread = indexes.length > 1 ? Math.min(40, 76 / (indexes.length - 1)) : 0
    const y = maxLayer === 0 ? 64 : 56 + (layer / Math.max(maxLayer, 1)) * 26
    indexes.forEach((planIndex, position) => {
      const planTask = planTasks[planIndex]
      const task = taskByPlanId.get(planTask.id)
      const state = taskState(task, waitingAgent)
      const x = 50 + (position - (indexes.length - 1) / 2) * spread
      const nodeId = task?.id ?? `plan-${planTask.id}`
      const cost = task ? costByTask.get(task.id) ?? costByAgent.get(task.agentId) ?? null : null
      nodes.push({
        id: nodeId,
        kind: 'task',
        agentId: task?.agentId ?? planTask.role,
        title: roleLabel(planTask.role),
        subtitle: `${planTask.title}${task?.stepCount ? ` · step ${task.stepCount}` : ''}`,
        state,
        costUsd: cost,
        model: resolveRouteDisplay(routing, providers, task?.agentId ?? planTask.role),
        x,
        y,
      })
      edges.push({ id: `e-head-${nodeId}`, from: 'head', to: nodeId, label: 'assigns', tone: state === 'working' || state === 'waiting' ? 'flow' : 'plain' })
      for (const dep of planTask.dependsOn) {
        const depPlanTask = planTasks[dep]
        if (!depPlanTask) continue
        const fromId = taskByPlanId.get(depPlanTask.id)?.id ?? `plan-${depPlanTask.id}`
        edges.push({ id: `e-${fromId}-${nodeId}`, from: fromId, to: nodeId, label: 'handoff', tone: state === 'working' || state === 'waiting' ? 'flow' : 'plain' })
      }
      edges.push({ id: `e-${nodeId}-head`, from: nodeId, to: 'head', label: 'verify', tone: state === 'waiting' ? 'wait' : state === 'working' ? 'flow' : 'plain' })
    })
  }

  return { nodes, edges }
}
