import { useState } from 'react'
import { X } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'
import type { GraphNode } from '../lib/runGraph'
import { resolveRouteDisplay, roleLabel } from '../lib/runGraph'
import { ApprovalDock } from './ApprovalDock'

function RouteEditor({ bridge, role, current, label = 'plays as' }: { bridge: Bridge; role: string; current: string | null; label?: string }) {
  const [draft, setDraft] = useState(current ?? '')
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      await bridge.saveRouting(role, draft)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="sheet-row">
      <span className="sheet-key">{label}</span>
      <input
        value={draft}
        list={`providers-for-${role}`}
        placeholder="default provider"
        title="Type `Provider` or `Provider · model`. Empty clears back to the default."
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') void save() }}
      />
      <datalist id={`providers-for-${role}`}>
        {bridge.providers.map((provider) => (
          <option key={provider.id} value={`${provider.label} · ${provider.model}`} />
        ))}
      </datalist>
      <button type="button" className="tiny-button" disabled={saving || draft.trim() === (current ?? '')} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Cast'}
      </button>
    </div>
  )
}
import { ReasoningSelect } from './ReasoningSelect'
import type { AgentId } from '../api/types'

/**
 * What a node is doing, one click away. The sheet is a read-out of the same
 * records the feed shows — the task, its handoff, its tool calls, its live text —
 * grouped by who did them. When the run is parked, the approval arrives inside
 * the worker that is waiting, not as a separate panel competing for attention.
 */
export function WorkerSheet({ bridge, node, onClose }: { bridge: Bridge; node: GraphNode; onClose: () => void }) {
  const { tasks, toolCalls, events, streaming, approval, messages, plan } = bridge

  const task = node.kind === 'task' ? tasks.find((entry) => entry.id === node.id) ?? tasks.find((entry) => entry.agentId === node.agentId && entry.status === 'running') : null
  const agentId = node.agentId

  const ownCalls = agentId ? toolCalls.filter((call) => call.agentId === agentId).slice(-4) : []
  const handoff = agentId
    ? events.filter((event) => event.type === 'worker.handoff' && event.payload?.to === agentId).at(-1)
    : null
  const ownStream = streaming && streaming.role === agentId ? streaming.text : null
  const review = node.kind === 'head' ? events.find((event) => event.type === 'run.review.ready') : null
  const direction = node.kind === 'you' ? messages.filter((message) => message.role === 'user').at(-1) : null
  const approvalHere = approval && agentId && approval.toolCall.agentId === agentId

  return (
    <section className="worker-sheet" aria-label={`${node.title} details`}>
      <div className="worker-sheet-head">
        <strong>{node.title}</strong>
        <span className={`status-chip ${node.state === 'done' ? 'ok' : node.state === 'failed' ? 'bad' : node.state === 'waiting' ? 'warn' : node.state === 'working' ? 'busy' : ''}`}>
          {node.state === 'waiting' ? 'needs you' : node.state}
        </span>
        {task ? <span className="muted tiny">{task.title}{task.stepCount ? ` · step ${task.stepCount}` : ''}</span> : null}
        {agentId === 'head' || agentId === 'research' || agentId === 'builder' ? (
          <ReasoningSelect bridge={bridge} role={agentId as AgentId} label="thinks" />
        ) : null}
        <button type="button" className="icon sheet-close" onClick={onClose} title="Close"><X size={14} /></button>
      </div>

      <div className="worker-sheet-body">
        {agentId && (node.kind === 'task' || node.kind === 'head') ? (
          <RouteEditor
            bridge={bridge}
            role={agentId}
            current={resolveRouteDisplay(((bridge.projectSettings ?? {}).routing as Record<string, string> | undefined) ?? {}, bridge.providers, agentId)}
          />
        ) : null}
        {node.kind === 'head' ? (
          <RouteEditor
            bridge={bridge}
            role="reviewer"
            label="reviews as"
            current={resolveRouteDisplay(((bridge.projectSettings ?? {}).routing as Record<string, string> | undefined) ?? {}, bridge.providers, 'reviewer')}
          />
        ) : null}

        {direction ? (
          <div className="sheet-row">
            <span className="sheet-key">direction</span>
            <span>{direction.content}</span>
          </div>
        ) : null}

        {plan && node.kind === 'you' ? (
          <div className="sheet-row">
            <span className="sheet-key">plan</span>
            <span>v{plan.plan.version} · {plan.plan.status} · {plan.tasks.length} tasks</span>
          </div>
        ) : null}

        {handoff ? (
          <div className="sheet-row">
            <span className="sheet-key">handoff</span>
            <span>{String(handoff.payload?.summary ?? 'Earlier work was handed over.')}</span>
          </div>
        ) : null}

        {review ? (
          <div className="sheet-row">
            <span className="sheet-key">review</span>
            <span>{String(review.payload?.summary ?? '')}</span>
          </div>
        ) : null}

        {task?.result && task.status === 'completed' ? (
          <div className="sheet-row">
            <span className="sheet-key">result</span>
            <span>{task.result.length > 220 ? `${task.result.slice(0, 220)}…` : task.result}</span>
          </div>
        ) : null}

        {ownCalls.length ? (
          <div className="sheet-calls">
            {ownCalls.map((call) => (
              <div className="sheet-call" key={call.id}>
                <span className={`sheet-call-ic ${call.status === 'completed' ? 'ok' : call.status === 'approval_required' ? 'warn' : call.error ? 'bad' : 'busy'}`}>
                  {call.status === 'completed' ? '✓' : call.status === 'approval_required' ? '⚠' : call.error ? '✕' : '▸'}
                </span>
                <span>{call.name} {call.input?.path ? <code>{String(call.input.path)}</code> : null}</span>
                <span className="muted tiny">{call.status.replaceAll('_', ' ')}</span>
              </div>
            ))}
          </div>
        ) : null}

        {ownStream !== null ? (
          <div className="sheet-stream">{ownStream || '…'}<span className="caret" /></div>
        ) : null}

        {!direction && !handoff && !review && !ownCalls.length && ownStream === null && !task?.result ? (
          <p className="muted tiny">Nothing recorded for {roleLabel(node.agentId ?? node.kind)} yet — its work appears here as it happens.</p>
        ) : null}
      </div>

      {approvalHere ? (
        <div className="worker-sheet-approval">
          <ApprovalDock bridge={bridge} />
        </div>
      ) : null}
    </section>
  )
}
