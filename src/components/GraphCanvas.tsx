import { useMemo } from 'react'
import type { GraphEdge, GraphNode } from '../lib/runGraph'
import { money } from '../lib/tones'

/**
 * The main screen: the plan as a living map. Nodes are laid out in percentages
 * and the edge layer is one SVG stretched over the same space, so the two never
 * drift apart. Packets ride edges that have live traffic; a node that needs a
 * person pulses instead of blending in.
 */

const AVATAR: Record<string, string> = { you: '🧑', head: '🧠', research: '🔍', builder: '🔨', architect: '📐', editor: '✏️', debug: '🐛', reviewer: '🔎' }
const STATE_LABEL: Record<string, string> = { idle: 'queued', working: 'working', waiting: 'needs you', done: 'done', failed: 'failed', blocked: 'blocked' }

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
    <div className="graph-canvas">
      <svg className="graph-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {geometry.map(({ edge, x1, y1, x2, y2 }) => (
          <line key={edge.id} id={edge.id} x1={x1} y1={y1} x2={x2} y2={y2} className={`graph-edge ${edge.tone}`} vectorEffect="non-scaling-stroke" />
        ))}
        {geometry.map(({ edge, mx, my }) => (
          edge.tone === 'plain' ? null : (
            <text key={`${edge.id}-label`} x={mx} y={my - 1.5} className="graph-edge-label" textAnchor="middle">{edge.label}</text>
          )
        ))}
        {geometry.map(({ edge }) => (
          edge.tone === 'plain' ? null : (
            <circle key={`${edge.id}-packet`} r="0.9" className={`graph-packet ${edge.tone}`}>
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
          className={`graph-node ${node.state} ${selectedId === node.id ? 'selected' : ''}`}
          style={{ left: `${node.x}%`, top: `${node.y}%` }}
          onClick={() => onSelect(node)}
          title={node.subtitle}
        >
          <span className="graph-avatar">{AVATAR[node.agentId ?? node.kind] ?? '🤖'}</span>
          <span className="graph-name">{node.title}</span>
          <span className="graph-sub">{node.subtitle}</span>
          {node.model ? <span className="graph-model" title="Who plays this role — change it in the worker sheet">{node.model}</span> : null}
          <span className={`graph-state ${node.state}`}>
          {STATE_LABEL[node.state] ?? node.state}
          {node.costUsd !== null && node.costUsd > 0 ? ` · ${money(node.costUsd, 2)}` : ''}
          </span>
        </button>
      ))}
    </div>
  )
}
