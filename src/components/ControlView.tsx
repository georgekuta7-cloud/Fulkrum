import { useMemo, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { buildGraph, roleLabel, type GraphNode } from '../lib/runGraph'
import { Button, EmptyState, Panel } from './primitives'
import { Icon, type IconName } from './Icon'

/**
 * The run as a living map: you, the Head, and one node per plan task in
 * dependency layers, with the waiting worker pulsing instead of blending in.
 * Beside it: live workers with real cost, and the proven fraction. The map is
 * a projection of the same snapshot the chat shows — it cannot disagree with
 * the record, and clicking a node explains it rather than navigating away.
 */

const NODE_TONE: Record<string, string> = {
  idle: 'border-outline-variant text-on-surface-variant',
  working: 'border-primary text-on-surface bg-surface-container',
  waiting: 'border-secondary text-on-surface bg-surface-container ring-2 ring-secondary/40',
  done: 'border-tertiary text-on-surface bg-surface-container-low',
  failed: 'border-error text-on-surface bg-surface-container',
  blocked: 'border-outline-variant text-on-surface-variant opacity-50',
}

const ICONS: Record<string, IconName> = { you: 'person', head: 'psychology', research: 'travel_explore', builder: 'construction', architect: 'architecture', editor: 'edit', debug: 'bug_report', reviewer: 'content_paste_search' }

function trimEdge(x1: number, y1: number, x2: number, y2: number, pad: number) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  return { x1: x1 + (dx / len) * pad, y1: y1 + (dy / len) * pad, x2: x2 - (dx / len) * pad, y2: y2 - (dy / len) * pad }
}

function MapCanvas({ bridge }: { bridge: Bridge }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const graph = useMemo(() => buildGraph({
    run: bridge.run,
    plan: bridge.plan,
    tasks: bridge.tasks,
    toolCalls: bridge.toolCalls,
    byTask: bridge.byTask,
    routing: ((bridge.projectSettings ?? {}).routing as Record<string, string> | undefined) ?? {},
    providers: bridge.providers,
  }), [bridge.run, bridge.plan, bridge.tasks, bridge.toolCalls, bridge.byTask, bridge.projectSettings, bridge.providers])

  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph])
  const selected: GraphNode | null = (selectedId && byId.get(selectedId)) || null

  if (!graph.nodes.length) {
    return <p className="text-body-md text-on-surface-variant text-center py-10">No plan yet — ask the Head AI for one in the chat.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-full min-h-[380px]" role="group" aria-label="Run dispatch map">
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {graph.edges.map((e) => {
            const from = byId.get(e.from)
            const to = byId.get(e.to)
            if (!from || !to) return null
            const p = trimEdge(from.x, from.y, to.x, to.y, 8)
            return <line key={e.id} id={`edge-${e.id}`} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} className={e.tone === 'flow' ? 'stroke-primary/50' : e.tone === 'wait' ? 'stroke-secondary/50' : 'stroke-outline-variant/40'} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
          })}
          {graph.edges.map((e) => (
            e.tone === 'plain' ? null : (
              <circle key={`${e.id}-packet`} r="0.9" className={e.tone === 'wait' ? 'fill-secondary' : 'fill-primary'}>
                <animateMotion dur={e.tone === 'wait' ? '3.2s' : '2.2s'} repeatCount="indefinite">
                  <mpath href={`#edge-${e.id}`} />
                </animateMotion>
              </circle>
            )
          ))}
        </svg>
        {graph.nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            className={`absolute w-32 -translate-x-1/2 flex flex-col items-start gap-0.5 p-2 rounded-lg border bg-surface-container-low text-left transition-colors ${NODE_TONE[node.state] ?? NODE_TONE.idle} ${selectedId === node.id ? 'ring-2 ring-primary' : ''}`}
            style={{ left: `${node.x}%`, top: `${node.y}%` }}
            onClick={() => setSelectedId((current) => (current === node.id ? null : node.id))}
            aria-pressed={selectedId === node.id}
            aria-label={`${node.title} — ${node.subtitle}`}
          >
            <span className="flex items-center gap-1.5 self-stretch min-w-0">
              <Icon name={ICONS[node.agentId ?? node.kind] ?? 'smart_toy'} className="text-sm text-primary" />
              <span className="text-label-md font-semibold text-on-surface truncate">{node.title}</span>
            </span>
            <span className="text-label-sm text-on-surface-variant line-clamp-1">{node.subtitle}</span>
            {node.model ? <span className="font-mono text-label-sm text-primary truncate max-w-full">{node.model}</span> : null}
          </button>
        ))}
      </div>
      {selected ? (
        <div className="p-3 rounded-lg bg-surface-container flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-label-lg font-semibold text-on-surface">{selected.title}</span>
            <span className="font-mono text-label-sm text-outline">{selected.state.replaceAll('_', ' ')}{selected.costUsd !== null && selected.costUsd > 0 ? ` · $${selected.costUsd.toFixed(2)}` : ''}</span>
          </div>
          <p className="text-body-sm text-on-surface-variant">{selected.subtitle}</p>
          {selected.model ? <p className="font-mono text-label-sm text-primary">cast: {selected.model}</p> : <p className="font-mono text-label-sm text-outline">not cast — planning only</p>}
        </div>
      ) : null}
    </div>
  )
}

export function ControlView({ bridge, onOpenChat }: { bridge: Bridge; onOpenChat: () => void }) {
  const running = (bridge.tasks ?? []).filter((t: any) => t.status === 'running')
  const costByAgent = new Map<string, number>()
  for (const entry of bridge.byTask ?? []) {
    const key = entry.agentId ?? 'head'
    costByAgent.set(key, (costByAgent.get(key) ?? 0) + entry.costUsd)
  }
  const roleSpend = [...costByAgent.entries()].sort((a, b) => b[1] - a[1])
  const maxSpend = roleSpend[0]?.[1] ?? 0
  const claims = bridge.claims ?? []
  const proven = claims.filter((c: any) => c.verdict === 'PASS').length
  const routing = ((bridge.projectSettings ?? {}).routing ?? {}) as Record<string, string>

  if (!bridge.run) {
    return <EmptyState icon="account_tree" title="No run open" body="The control room shows the run's dispatch: cast roles, live workers, handoffs, and what is waiting on you." action={<Button variant="primary" onClick={onOpenChat}>Go to chat</Button>} />
  }

  return (
    <div className="w-full max-w-7xl mx-auto px-4 py-4 flex flex-col gap-4">
      {bridge.approval ? (
        <button type="button" className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-secondary/10 border border-secondary/40 text-left hover:bg-secondary/15 transition-colors" onClick={onOpenChat}>
          <span className="flex items-center gap-2.5 min-w-0">
            <span className="relative flex h-2.5 w-2.5 flex-shrink-0" aria-hidden="true">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-secondary" />
            </span>
            <span className="text-body-md text-on-surface font-medium truncate">A decision is waiting: {bridge.approval.toolCall.name}</span>
          </span>
          <span className="text-label-md text-secondary whitespace-nowrap">open chat →</span>
        </button>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        <div className="xl:col-span-8 bg-surface-container-low rounded-xl p-3">
          <MapCanvas bridge={bridge} />
        </div>
        <div className="xl:col-span-4 flex flex-col gap-4">
          <Panel title="Live workers" action={<span className="font-mono text-label-sm text-outline">{running.length} active</span>}>
            {running.length ? running.map((task: any) => (
              <div key={task.id} className="p-2.5 rounded-lg bg-surface-container flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-body-md text-on-surface font-medium">{roleLabel(task.agentId)}</span>
                  <span className="font-mono text-label-sm text-primary flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" aria-hidden="true" /> working
                  </span>
                </div>
                <p className="text-body-sm text-on-surface-variant truncate">{task.title}</p>
                <span className="font-mono text-label-sm text-outline">{routing[task.agentId] ?? 'not cast'}{task.stepCount ? ` · step ${task.stepCount}` : ''}</span>
              </div>
            )) : <p className="text-body-sm text-outline">Nothing running. Workers appear when a task starts.</p>}
          </Panel>
          <Panel title="Spend by role" action={<span className="font-mono text-label-sm text-secondary">${bridge.spend.costUsd.toFixed(4)}</span>}>
            {roleSpend.length ? roleSpend.map(([agent, cost]) => (
              <div key={agent} className="flex flex-col gap-0.5">
                <div className="flex justify-between font-mono text-label-sm">
                  <span className="text-on-surface-variant">{roleLabel(agent)}</span>
                  <span className="text-on-surface">${cost.toFixed(4)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-surface-container-highest overflow-hidden" role="img" aria-label={`${roleLabel(agent)} spent $${cost.toFixed(4)}`}>
                  <div className="h-full rounded-full bg-primary" style={{ width: `${maxSpend > 0 ? Math.max((cost / maxSpend) * 100, 2) : 0}%` }} />
                </div>
              </div>
            )) : <p className="text-body-sm text-outline">No priced calls yet.</p>}
          </Panel>
          <Panel title="Proven so far" action={<span className="font-mono text-label-sm text-secondary">{proven}/{claims.length}</span>}>
            <p className="text-body-sm text-on-surface-variant">{claims.length ? 'The fraction of claims proven is the value of the run.' : 'No claims recorded yet. Workers record what they assert; verification decides it.'}</p>
          </Panel>
        </div>
      </div>
    </div>
  )
}
