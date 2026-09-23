import { useMemo, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import type { GraphNode } from '../lib/runGraph'
import { buildGraph, roleLabel } from '../lib/runGraph'
import { money } from '../lib/tones'
import { GraphCanvas } from './GraphCanvas'

/**
 * The Control Room: the run's dispatch as one living map — who is cast where,
 * what each worker is doing, what it costs, and the one thing that needs a
 * human, surfaced instead of buried. Everything is a projection of the same
 * run snapshot the chat and the ledger show; the map cannot disagree with the
 * record.
 */

const NODE_STATE_LABEL: Record<string, string> = { idle: 'queued', working: 'working', waiting: 'needs you', done: 'done', failed: 'failed', blocked: 'blocked' }

export function ControlRoomView({ bridge, onOpenChat }: { bridge: Bridge; onOpenChat: () => void }) {
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

  if (!bridge.runId || !bridge.run) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3 max-w-md">
          <span className="material-symbols-outlined text-5xl text-primary">account_tree</span>
          <h2 className="text-headline-md text-on-surface">No run open</h2>
          <p className="text-body-md text-on-surface-variant">The control room shows the run's dispatch: cast roles, live workers, handoffs, and what is waiting on you. Open a run from the chat to see it.</p>
          <button type="button" className="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-md font-medium" onClick={onOpenChat}>Go to chat</button>
        </div>
      </div>
    )
  }

  const routing = ((bridge.projectSettings ?? {}).routing ?? {}) as Record<string, string>
  const selected: GraphNode | null = graph.nodes.find((node) => node.id === selectedId) ?? null
  const runningTasks = bridge.tasks.filter((task) => task.status === 'running')
  const costByAgent = new Map<string, number>()
  for (const entry of bridge.byTask) {
    const key = entry.agentId ?? 'head'
    costByAgent.set(key, (costByAgent.get(key) ?? 0) + entry.costUsd)
  }
  const roleSpend = [...costByAgent.entries()].sort((a, b) => b[1] - a[1])
  const maxRoleSpend = roleSpend[0]?.[1] ?? 0
  const proven = bridge.claims.filter((claim) => claim.verdict === 'PASS').length
  const decided = bridge.claims.filter((claim) => claim.verdict !== null).length

  return (
    <div className="w-full max-w-7xl mx-auto px-4 lg:px-8 py-4 flex flex-col gap-4">
      {bridge.approval ? (
        <button type="button" className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-secondary/10 border border-secondary/40 text-left hover:bg-secondary/15 transition-colors" onClick={onOpenChat}>
          <span className="flex items-center gap-2.5 min-w-0">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-secondary" />
            </span>
            <span className="text-body-md text-on-surface font-medium truncate">A decision is waiting: {bridge.approval.toolCall.name}</span>
          </span>
          <span className="text-label-md text-secondary whitespace-nowrap flex items-center gap-1">open chat <span className="material-symbols-outlined text-sm">arrow_forward</span></span>
        </button>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-stretch">
        <div className="xl:col-span-8 bg-surface-container-low rounded-xl p-3 flex flex-col gap-3 min-h-[420px]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-primary text-[18px]">account_tree</span>
              <span className="text-label-lg font-semibold text-on-surface">Dispatch</span>
              <span className="font-mono text-label-sm text-outline">{graph.nodes.length} nodes · {graph.edges.length} edges</span>
            </div>
            <span className="font-mono text-label-sm text-outline">run {bridge.run.id.slice(0, 12)}</span>
          </div>
          <div className="flex-1 min-h-[380px]">
            {graph.nodes.length ? (
              <GraphCanvas nodes={graph.nodes} edges={graph.edges} selectedId={selectedId} onSelect={(node) => setSelectedId((current) => current === node.id ? null : node.id)} />
            ) : (
              <p className="text-body-md text-on-surface-variant flex items-center justify-center h-full">No plan yet — ask the Head AI for one.</p>
            )}
          </div>
          {selected ? (
            <div className="p-3 rounded-lg bg-surface-container flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-label-lg font-semibold text-on-surface">{selected.title}</span>
                <span className="font-mono text-label-sm text-outline">{NODE_STATE_LABEL[selected.state] ?? selected.state}{selected.costUsd !== null && selected.costUsd > 0 ? ` · ${money(selected.costUsd, 2)}` : ''}</span>
              </div>
              <p className="text-body-sm text-on-surface-variant">{selected.subtitle}</p>
              {selected.model ? <p className="font-mono text-label-sm text-primary">cast: {selected.model}</p> : <p className="font-mono text-label-sm text-outline">not cast — planning only</p>}
            </div>
          ) : null}
        </div>

        <div className="xl:col-span-4 flex flex-col gap-4">
          <div className="bg-surface-container-low rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-label-lg font-semibold text-on-surface">Live workers</span>
              <span className="font-mono text-label-sm text-outline">{runningTasks.length} active</span>
            </div>
            {runningTasks.length ? runningTasks.map((task) => (
              <div key={task.id} className="p-2.5 rounded-lg bg-surface-container flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-body-md text-on-surface font-medium">{roleLabel(task.agentId)}</span>
                  <span className="font-mono text-label-sm text-primary flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" /> working
                  </span>
                </div>
                <p className="text-body-sm text-on-surface-variant truncate">{task.title}</p>
                <span className="font-mono text-label-sm text-outline">
                  {routing[task.agentId] ?? 'not cast'}{task.stepCount ? ` · step ${task.stepCount}` : ''}
                </span>
              </div>
            )) : <p className="text-body-sm text-outline">Nothing running. Workers appear when a task starts.</p>}
          </div>

          <div className="bg-surface-container-low rounded-xl p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-label-lg font-semibold text-on-surface">Spend by role</span>
              <span className="font-mono text-label-sm text-secondary">{money(bridge.spend.costUsd, 4)}</span>
            </div>
            {roleSpend.length ? roleSpend.map(([agent, cost]) => (
              <div key={agent} className="flex flex-col gap-0.5">
                <div className="flex justify-between font-mono text-label-sm">
                  <span className="text-on-surface-variant">{roleLabel(agent)}</span>
                  <span className="text-on-surface">{money(cost, 4)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-surface-container-highest overflow-hidden">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${maxRoleSpend > 0 ? Math.max((cost / maxRoleSpend) * 100, 2) : 0}%` }} />
                </div>
              </div>
            )) : <p className="text-body-sm text-outline">No priced calls yet.</p>}
          </div>

          <div className="bg-surface-container-low rounded-xl p-4 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-label-lg font-semibold text-on-surface">Proven so far</span>
              <span className="font-mono text-label-sm text-secondary">{proven}/{decided} decided</span>
            </div>
            <p className="text-body-sm text-on-surface-variant">
              {bridge.claims.length ? `${proven} of ${bridge.claims.length} claims proven — the fraction of claims proven is the value of the run.` : 'No claims recorded yet. Workers record claims as they work; verification decides them.'}
            </p>
            <button type="button" className="self-start mt-1 px-3 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-label-md text-on-surface transition-colors" onClick={onOpenChat}>See evidence in chat</button>
          </div>
        </div>
      </div>
    </div>
  )
}
