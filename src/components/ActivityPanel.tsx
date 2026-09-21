import { useEffect, useRef, useState } from 'react'
import { Bot, Hammer, Search, ShieldCheck, TriangleAlert, Zap } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'
import type { RunEvent } from '../api/types'

/**
 * What is happening, as it happens.
 *
 * The feed is the event log, so it says only what was recorded; the text of a reply
 * in flight is a separate, temporary thing and is shown as such rather than being
 * mixed into the record. A tool call shows the rule that decided it, which is how
 * "why did it do that" is answered without opening the database.
 */

const agentIcon = (agentId: string | null) => (agentId === 'builder' ? <Hammer size={13} /> : agentId === 'research' ? <Search size={13} /> : <Bot size={13} />)

const label = (event: RunEvent): { title: string; detail?: string; tone: string } => {
  const payload = event.payload ?? {}
  switch (event.type) {
    case 'plan.drafted': return { title: 'Plan drafted', detail: `v${payload.version} · ${payload.tasks?.length ?? 0} task(s) · ${payload.source}`, tone: 'plan' }
    case 'plan.edited': return { title: 'Plan edited', detail: `v${payload.version} replaces v${payload.replacedVersion}`, tone: 'plan' }
    case 'plan.approved': return { title: 'Plan approved', detail: `v${payload.version} · ${String(payload.hash ?? '').slice(0, 12)}…`, tone: 'ok' }
    case 'plan.approval.rejected': return { title: 'Approval refused', detail: String(payload.reason ?? 'the plan changed'), tone: 'warn' }
    case 'task.started': return { title: `${payload.role ?? event.agentId} started`, detail: String(payload.title ?? ''), tone: 'busy' }
    case 'task.completed': return { title: `${payload.title} finished`, detail: payload.demo ? 'demo mode — no key was configured' : `${payload.steps ?? 0} step(s) · ${payload.model ?? ''}`, tone: payload.demo ? 'warn' : 'ok' }
    case 'task.skipped': return { title: `${payload.title} skipped`, detail: String(payload.reason ?? ''), tone: 'idle' }
    case 'task.resumed': return { title: `${payload.turns} turn(s) restored`, detail: 'continuing where it stopped', tone: 'busy' }
    case 'worker.handoff': return { title: `${payload.from} → ${payload.to}`, detail: String(payload.summary ?? '').slice(0, 140), tone: 'idle' }
    case 'tool.requested': return { title: `${payload.name} requested`, detail: `rule ${payload.rule ?? '—'}`, tone: 'idle' }
    case 'tool.completed': return { title: `${payload.name} completed`, detail: payload.outputBytes !== undefined ? `${payload.outputBytes} bytes of output` : '', tone: 'ok' }
    case 'tool.failed': return { title: `${payload.name} failed`, detail: String(payload.error ?? ''), tone: 'bad' }
    case 'tool.denied': return { title: `${payload.name} denied`, detail: String(payload.reason ?? ''), tone: 'bad' }
    case 'tool.arguments.suspicious': return { title: 'Something credential-shaped in the arguments', detail: (payload.warnings ?? []).map((warning: any) => warning.kinds?.join(', ')).join('; '), tone: 'warn' }
    case 'tool.output.suspicious': return { title: 'Tool output talked to the model', detail: (payload.patterns ?? []).join(', '), tone: 'warn' }
    case 'approval.requested': return { title: `${payload.name} needs you`, detail: String(payload.reason ?? ''), tone: 'warn' }
    case 'approval.granted': return { title: `${payload.toolName} allowed for this run`, detail: '', tone: 'ok' }
    case 'approval.standing': return { title: 'Standing grant created', detail: String(payload.label ?? ''), tone: 'ok' }
    case 'approval.revoked': return { title: `${payload.toolName} grant revoked`, detail: '', tone: 'idle' }
    case 'artifact.revert.requested': return { title: `Reverting ${payload.path}`, detail: '', tone: 'warn' }
    case 'run.snapshot': return { title: `Checkpoint · ${payload.path}`, detail: 'restorable to before this write', tone: 'plan' }
    case 'timeline.restored': return { title: `Restored ${payload.path}`, detail: `to its state at event ${payload.seq ?? '?'}`, tone: 'warn' }
    case 'timeline.restore.failed': return { title: `Restore refused · ${payload.path}`, detail: String(payload.reason ?? ''), tone: 'bad' }
    case 'claims.recorded': return { title: `${(payload.claims ?? []).length} claim(s) recorded`, detail: 'assertions with evidence behind them', tone: 'plan' }
    case 'task.query.answered': return { title: `${payload.from} asked ${payload.to}`, detail: String(payload.question ?? '').slice(0, 140), tone: 'idle' }
    case 'learning.recorded': return { title: 'Learned', detail: String(payload.fact ?? '').slice(0, 160), tone: 'ok' }
    case 'check.run': return { title: `Check ${payload.command}`, detail: payload.error ? `failed: ${String(payload.error).slice(0, 100)}` : `exit ${payload.exitCode} in ${payload.durationMs}ms`, tone: payload.error ? 'bad' : 'ok' }
    case 'run.provider.fallback': return { title: 'Provider fallback', detail: `${payload.from} → ${payload.to}`, tone: 'warn' }
    case 'run.routing': return { title: 'Casting recorded', detail: Object.entries(payload.routing ?? {}).map(([role, route]) => `${role} → ${route}`).join('; ') || 'defaults', tone: 'idle' }
    case 'run.casting.advised': return { title: `Casting advice · ${payload.role}`, detail: String(payload.suggestion ?? payload.reason ?? ''), tone: 'warn' }
    case 'run.route.escalated': return { title: `${payload.role} escalated`, detail: `${payload.from ?? 'default'} → ${payload.to} after ${payload.afterFailures} failure(s)`, tone: 'busy' }
    case 'run.budget.exceeded': return { title: 'Budget reached', detail: String(payload.error ?? ''), tone: 'bad' }
    case 'run.budget.changed': return { title: 'Budget changed', detail: `now $${payload.budgetUsd ?? 'none'}`, tone: 'idle' }
    case 'run.command.stopped': return { title: 'Running command stopped', detail: 'the run was cancelled', tone: 'warn' }
    case 'run.interrupted': return { title: 'Run interrupted', detail: String(payload.reason ?? ''), tone: 'warn' }
    case 'run.review.ready': return { title: 'Review ready', detail: String(payload.summary ?? '').slice(0, 200), tone: 'ok' }
    case 'run.paused': return { title: 'Paused', detail: '', tone: 'warn' }
    case 'run.resumed': return { title: 'Resumed', detail: '', tone: 'busy' }
    case 'run.cancelled': return { title: 'Cancelled', detail: '', tone: 'bad' }
    case 'run.failed': return { title: 'Failed', detail: String(payload.error ?? ''), tone: 'bad' }
    case 'run.forked': return { title: 'Forked from another run', detail: String(payload.from ?? ''), tone: 'plan' }
    case 'message.user': return { title: 'You', detail: String(payload.content ?? '').slice(0, 160), tone: 'idle' }
    case 'message.assistant': return { title: 'Head AI', detail: String(payload.content ?? '').slice(0, 160), tone: payload.demo ? 'warn' : 'ok' }
    default: return { title: event.type, detail: '', tone: 'idle' }
  }
}

/** How many rows render before the rest waits behind a button: a 10k-event run
 * must not cost 10k DOM nodes to glance at. */
const EVENT_WINDOW = 300

export function ActivityPanel({ bridge }: { bridge: Bridge }) {
  const { events, streaming, tasks, timeline } = bridge
  const [filter, setFilter] = useState<'all' | 'tools' | 'decisions'>('all')
  const [follow, setFollow] = useState(true)
  // Per-run on purpose: a new run starts windowed without any reset effect,
  // and scrubbing to a hidden event opens the window at render time instead
  // of seeking to a row that is not rendered.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const endRef = useRef<HTMLDivElement | null>(null)
  const feedRef = useRef<HTMLOListElement | null>(null)
  const scrubHidden = Boolean(timeline && timeline.seq < (events.at(-EVENT_WINDOW)?.sequence ?? Infinity))
  const showAll = (bridge.runId && expanded[bridge.runId]) || scrubHidden

  useEffect(() => {
    // Same guard as the scrub seek below: environments without layout have no
    // scrollIntoView, and following must not crash there.
    if (follow && typeof endRef.current?.scrollIntoView === 'function') endRef.current.scrollIntoView({ block: 'end' })
  }, [events.length, streaming?.text, follow])

  // The timeline scrubber drives the feed: scrubbing seeks the event the
  // files are shown as of, so the two views cannot disagree about "when".
  useEffect(() => {
    if (!timeline) return
    const row = feedRef.current?.querySelector(`[data-sequence="${timeline.seq}"]`) as HTMLElement | null
    // jsdom has no scrollIntoView; the guard keeps the effect test-safe.
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' })
  }, [timeline])

  const filtered = events.filter((event) => {
    if (filter === 'tools') return event.type.startsWith('tool.') || event.type.startsWith('approval.')
    if (filter === 'decisions') return ['approval.requested', 'approval.granted', 'approval.standing', 'tool.denied', 'plan.approved', 'plan.approval.rejected', 'tool.arguments.suspicious', 'tool.output.suspicious'].includes(event.type)
    return true
  })
  const hidden = showAll ? 0 : Math.max(filtered.length - EVENT_WINDOW, 0)
  const visible = showAll ? filtered : filtered.slice(-EVENT_WINDOW)

  return (
    <div className="activity-panel">
      <div className="panel-bar">
        <div className="segmented">
          {(['all', 'tools', 'decisions'] as const).map((option) => (
            <button type="button" key={option} className={filter === option ? 'active' : ''} onClick={() => setFilter(option)}>{option}</button>
          ))}
        </div>
        <label className="follow-toggle"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> follow</label>
        <span className="muted tiny">{events.length} event(s)</span>
      </div>

      <ol className="feed" ref={feedRef}>
        {hidden > 0 ? (
          <li className="feed-item idle">
            <div className="feed-body">
              <button type="button" className="tiny-button" onClick={() => bridge.runId && setExpanded((current) => ({ ...current, [bridge.runId as string]: true }))}>Show {hidden} earlier event(s)</button>
            </div>
          </li>
        ) : null}
        {visible.map((event) => {
          const { title, detail, tone } = label(event)
          return (
            <li className={`feed-item ${tone}${timeline && event.sequence === timeline.seq ? ' pinned' : ''}`} key={event.eventId} data-sequence={event.sequence}>
              <span className="feed-icon">{event.type.startsWith('approval') ? <ShieldCheck size={13} /> : event.type.startsWith('tool') ? <Zap size={13} /> : agentIcon(event.agentId)}</span>
              <div className="feed-body">
                <span className="feed-title">{title}{event.agentId ? <span className="muted"> · {event.agentId}</span> : null}</span>
                {detail ? <span className="feed-detail">{detail}</span> : null}
              </div>
              <span className="feed-seq">#{event.sequence}</span>
            </li>
          )
        })}
        {streaming ? (
          <li className="feed-item busy streaming">
            <span className="feed-icon"><Bot size={13} /></span>
            <div className="feed-body">
              <span className="feed-title">{streaming.role} is writing…</span>
              <span className="feed-detail streaming-text">{streaming.text || '…'}<span className="caret" /></span>
            </div>
          </li>
        ) : null}
        <div ref={endRef} />
      </ol>

      {tasks.some((task) => task.status === 'blocked' || task.status === 'failed') ? (
        <p className="warning"><TriangleAlert size={13} /> A task did not finish — its result is in the plan below.</p>
      ) : null}
    </div>
  )
}
