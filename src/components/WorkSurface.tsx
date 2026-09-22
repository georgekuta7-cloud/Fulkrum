import { AlertTriangle, Check, X, Pen, Search, Hammer, Compass, Bug, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { ROLE_INFO } from '../lib/constants'

const ICONS: Record<string, any> = { Search, Hammer, Compass, Pen, Bug }

export function WorkSurface({ bridge }: { bridge: Bridge }) {
  const { tasks, toolCalls, streaming, approval } = bridge
  const [showGraph, setShowGraph] = useState(false)

  // Derive needsYou from parked approvals + run.ask
  const needsYou = []
  if (approval) {
    const isQuestion = approval.toolCall.kind === 'ask' || approval.toolCall.name === 'run.ask'
    needsYou.push({
      type: isQuestion ? 'question' : 'approval',
      id: approval.toolCall.id,
      name: approval.toolCall.name,
      resolved: approval.toolCall.resolved,
      warnings: approval.warnings,
    })
  }

  // Live work: the running task
  const liveTask = tasks?.find((t: any) => t.status === 'running')
  const liveAgent = liveTask?.agentId ?? null
  const liveRole = liveAgent ? ROLE_INFO[liveAgent as keyof typeof ROLE_INFO] : null
  const liveCalls = liveAgent ? (toolCalls ?? []).filter((c: any) => c.agentId === liveAgent).slice(-5) : []
  const liveStream = streaming?.role === liveAgent ? streaming.text : ''

  // Completed tasks
  const completed = (tasks ?? []).filter((t: any) => t.status === 'completed')

  return (
    <section className="work-surface">
      <div className="work-header">
        <span className="micro-label">Work Surface</span>
        <div className="work-header-actions">
          <button className={`btn btn-ghost btn-sm ${showGraph ? 'active' : ''}`} onClick={() => setShowGraph(!showGraph)}>
            {showGraph ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Graph
          </button>
        </div>
      </div>

      {/* NeedsYou — always visible when non-empty */}
      {needsYou.length > 0 && (
        <div className="needs-you">
          <div className="needs-you-header">
            <AlertTriangle size={14} />
            <span className="needs-you-title">Needs You</span>
          </div>
          {needsYou.map((item) => (
            <div key={item.id} className={`needs-you-item needs-you-${item.type}`}>
              {item.type === 'approval' ? (
                <>
                  <div className="needs-you-name">{item.name}</div>
                  <div className="needs-you-desc">{item.resolved?.argv?.join(' ') ?? item.resolved?.url ?? item.resolved?.relative ?? ''}</div>
                  {item.warnings?.length > 0 && (
                    <div className="needs-you-warnings">⚠ {item.warnings.map((w: any) => w.field).join(', ')}</div>
                  )}
                  <div className="needs-you-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => void bridge.approveCall('once')}><Check size={12} /> Approve</button>
                    <button className="btn btn-danger btn-sm" onClick={() => void bridge.denyCall('Denied by user.')}><X size={12} /> Deny</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="needs-you-name">Question from {item.name}</div>
                  <div className="needs-you-desc">{item.resolved?.question ?? ''}</div>
                  <div className="needs-you-answer">
                    <input className="input" placeholder="Type answer…" onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.target as HTMLInputElement).value) {
                        void bridge.answerCall((e.target as HTMLInputElement).value)
                        ;(e.target as HTMLInputElement).value = ''
                      }
                    }} />
                    <button className="btn btn-primary btn-sm" onClick={(e) => {
                      const input = (e.target as HTMLElement).closest('.needs-you-answer')?.querySelector('input') as HTMLInputElement
                      if (input?.value) { void bridge.answerCall(input.value); input.value = '' }
                    }}>Send</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Live work card */}
      {liveTask && liveRole && (
        <div className="live-card">
          <div className="live-card-header">
            {(() => { const I = ICONS[liveRole.icon]; return I ? <I size={16} /> : <span>🤖</span> })()}
            <span className="live-card-title">{liveRole.label} → {liveTask.title}</span>
            <span className="chip chip-busy">● working</span>
          </div>
          <div className="live-card-calls">
            {liveCalls.map((call: any) => (
              <div key={call.id} className={`live-call ${call.status === 'completed' ? 'ok' : call.status === 'failed' ? 'bad' : call.status === 'approval_required' ? 'warn' : ''}`}>
                <span className="live-call-icon">{call.status === 'completed' ? '✓' : call.status === 'failed' ? '✕' : call.status === 'approval_required' ? '⚠' : '●'}</span>
                <span className="live-call-name">{call.name.replace('workspace.', '').replace('shell.', '')}</span>
                <span className="live-call-target">{call.resolved?.relative ?? call.resolved?.argv?.join(' ') ?? ''}</span>
              </div>
            ))}
          </div>
          {liveStream && (
            <div className="live-stream">
              <span className="live-stream-text">{liveStream}</span>
              <span className="caret" />
            </div>
          )}
        </div>
      )}

      {/* Graph view (toggle) */}
      {showGraph && <div className="work-graph"><span className="muted">Graph view — dependency shape</span></div>}

      {/* Completed work */}
      {completed.length > 0 && (
        <div className="work-completed">
          <div className="work-completed-header">
            <span className="micro-label">Completed</span>
          </div>
          {completed.map((task: any) => {
            const role = ROLE_INFO[task.agentId as keyof typeof ROLE_INFO]
            const taskCalls = (toolCalls ?? []).filter((c: any) => c.agentId === task.agentId).length
            return (
              <div key={task.id} className="work-completed-item">
                <Check size={14} className="work-completed-icon" />
                <span className="work-completed-title">{role?.label ?? task.agentId} · {task.title}</span>
                <span className="work-completed-meta">{taskCalls} calls</span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
