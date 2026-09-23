import { useMemo } from 'react'
import type { GraphEdge, GraphNode } from '../lib/runGraph'
import { money } from '../lib/tones'

/**
 * The plan as a living map: nodes in dependency layers, one SVG stretched over
 * the same space so positions never drift. Packets ride edges with live
 * traffic; a node that needs a person pulses instead of blending in. All
 * styling goes through the theme tokens — the graph reads like the rest of
 * the interface, light or dark.
 */

const AVATAR: Record<string, string> = { you: 'person', head: 'psychology', research: 'travel_explore', builder: 'construction', architect: 'architecture', editor: 'edit', debug: 'bug_report', reviewer: 'content_paste_search' }
const STATE_LABEL: Record<string, string> = { idle: 'queued', working: 'working', waiting: 'needs you', done: 'done', failed: 'failed', blocked: 'blocked' }

const NODE_TONE: Record<string, string> = {
  idle: 'border-outline-variant text-on-surface-variant',
  working: 'border-primary text-on-surface bg-surface-container',
  waiting: 'border-secondary text-on-surface bg-surface-container ring-2 ring-secondary/40 animate-pulse',
  done: 'border-tertiary text-on-surface bg-surface-container-low',
  failed: 'border-error text-on-surface bg-surface-container',
  blocked: 'border-outline-variant text-on-surface-variant opacity-40',
}

const STATE_TONE: Record<string, string> = {
  idle: 'text-on-surface-variant',
  working: 'text-primary',
  waiting: 'text-secondary',
  done: 'text-tertiary',
  failed: 'text-error',
  blocked: 'text-outline',
}

/** Trim a segment so it stops at the node boxes instead of running under them. */
function trim(x1: number, y1: number, x2: number, y2: number, pad: number) {
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  return { x1: x1 + ux * pad, y1: y1 + uy * pad, x2: x2 - ux * pad, y2: y2 - uy * pad }
}

export function GraphCanvas({ nodes, edges, selectedId, onSelect }: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  selectedId: string | null
  onSelect: (node: GraphNode) => void
}) {
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const geometry = useMemo(() => edges.map((edge) => {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) return null
    const { x1, y1, x2, y2 } = trim(from.x, from.y, to.x, to.y, 7)
    return { edge, x1, y1, x2, y2, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 }
  }).filter(Boolean) as Array<{ edge: GraphEdge; x1: number; y1: number; x2: number; y2: number; mx: number; my: number }>, [edges, byId])

  return (
    <div className="relative w-full h-full">
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {geometry.map(({ edge, x1, y1, x2, y2 }) => (
          <line
            key={edge.id}
            id={edge.id}
            x1={x1} y1={y1} x2={x2} y2={y2}
            className={edge.tone === 'flow' ? 'stroke-primary/50' : edge.tone === 'wait' ? 'stroke-secondary/50' : 'stroke-outline-variant/40'}
            strokeWidth={edge.tone === 'plain' ? 0.5 : 0.7}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {geometry.map(({ edge, mx, my }) => (
          edge.tone === 'plain' ? null : (
            <text key={`${edge.id}-label`} x={mx} y={my - 1.5} className="fill-outline font-mono" fontSize="2" textAnchor="middle">{edge.label}</text>
          )
        ))}
        {geometry.map(({ edge }) => (
          edge.tone === 'plain' ? null : (
            <circle key={`${edge.id}-packet`} r="0.9" className={edge.tone === 'wait' ? 'fill-secondary' : 'fill-primary'}>
              <animateMotion dur={edge.tone === 'wait' ? '3.2s' : '2.2s'} repeatCount="indefinite">
                <mpath href={`#${edge.id}`} />
              </animateMotion>
            </circle>
          )
        ))}
      </svg>

      {nodes.map((node) => (
        <button
          type="button"
          key={node.id}
          className={`absolute w-32 -translate-x-1/2 flex flex-col items-start gap-0.5 p-2.5 rounded-lg border bg-surface-container-low text-left transition-colors ${NODE_TONE[node.state] ?? NODE_TONE.idle} ${selectedId === node.id ? 'ring-2 ring-primary' : ''}`}
          style={{ left: `${node.x}%`, top: `${node.y}%` }}
          onClick={() => onSelect(node)}
          title={node.subtitle}
          aria-pressed={selectedId === node.id}
          aria-label={`${node.title} — ${node.subtitle}`}
        >
          <span className="flex items-center gap-1.5 self-stretch">
            <span className="material-symbols-outlined text-sm text-primary">{AVATAR[node.agentId ?? node.kind] ?? 'smart_toy'}</span>
            <span className="text-label-md font-semibold text-on-surface truncate">{node.title}</span>
          </span>
          <span className="text-label-sm text-on-surface-variant line-clamp-1">{node.subtitle}</span>
          {node.model ? <span className="font-mono text-label-sm text-primary truncate max-w-full" title="Who plays this role — change casting in Settings">{node.model}</span> : null}
          <span className={`font-mono text-label-sm ${STATE_TONE[node.state] ?? STATE_TONE.idle}`}>
            {STATE_LABEL[node.state] ?? node.state}
            {node.costUsd !== null && node.costUsd > 0 ? ` · ${money(node.costUsd, 2)}` : ''}
          </span>
        </button>
      ))}
    </div>
  )
}
