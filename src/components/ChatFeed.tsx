import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'
import type { RunEvent, Task } from '../api/types'
import { money } from '../lib/tones'
import { roleLabel } from '../lib/runGraph'
import { CastingLine } from './CastingLine'

/**
 * The chat is the run narrated: what you asked, the plan it made, what each
 * worker did — reads, writes, what they added and removed — and the review at
 * the end. Everything here is built from the same messages, events, tool calls,
 * and artifacts the rest of the interface shows; the feed just puts them in
 * order, the way a host would tell it.
 */

type Message = { id: number; role: string; agentId: string | null; content: string; createdAt: number; metadata: any }

type FeedItem =
  | { kind: 'message'; at: number; message: Message }
  | { kind: 'plan'; at: number }
  | { kind: 'task'; at: number; task: Task }
  | { kind: 'review'; at: number; event: RunEvent }

const KIND_ORDER: Record<FeedItem['kind'], number> = { message: 0, plan: 1, task: 2, review: 3 }

function PlanCard({ bridge }: { bridge: Bridge }) {
  const { plan, run, estimate, control, draftPlan, events } = bridge
  if (!plan) return null
  const contextSources = events.filter((event) => event.type === 'plan.drafted').at(-1)?.payload?.contextSources ?? []
  const approvable = plan.plan.status === 'draft' && run && ['planning', 'review', 'interrupted'].includes(run.status)
  return (
    <div className="chat-plan-card">
      <div className="chat-plan-head">
        <span className="chat-plan-icon">◆</span>
        <strong>Plan v{plan.plan.version} · {plan.plan.objective}</strong>
        <span className={`status-chip ${plan.plan.status === 'approved' ? 'ok' : 'plan'}`}>{plan.plan.status}</span>
        <span className="chat-hash" title="Approval binds to this content hash">{plan.plan.contentHash.slice(0, 8)}…</span>
      </div>
      {plan.complexity && plan.complexity.score >= 7 ? (
        <div className="chat-plan-complexity" title={plan.complexity.factors.join('; ')}>
          ⚠ {plan.complexity.score}/10 — a broad plan. Consider a sharper direction before approving.
        </div>
      ) : null}
      <div className="chat-plan-casting">
        <CastingLine bridge={bridge} tasks={plan.tasks} />
        {contextSources.length ? <span className="muted tiny"> · read {contextSources.join(', ')}</span> : null}
      </div>
      <div className="chat-plan-tasks">
        {plan.tasks.map((task, index) => (
          <div className="chat-plan-task" key={task.id}>
            <span className="muted tiny">{index + 1}</span>
            <span>{roleLabel(task.role)} — {task.title}</span>
            <span className="muted tiny">{task.dependsOn.length ? `after ${task.dependsOn.map((dep) => dep + 1).join(', ')}` : 'no deps'}</span>
          </div>
        ))}
      </div>
      <div className="chat-plan-foot">
        {estimate?.estimateUsd ? <span className="muted tiny">est. {money(estimate.estimateUsd.low, 4)}–{money(estimate.estimateUsd.high, 4)}</span> : null}
        <span style={{ flex: 1 }} />
        <button type="button" className="tiny-button" onClick={() => void draftPlan({ regenerate: true })}>Redraft</button>
        {approvable ? (
          <button type="button" className="tiny-button primary" onClick={() => void control('approve-plan', { planId: plan.plan.id, planHash: plan.plan.contentHash, routing: {} })}>
            Approve &amp; run
          </button>
        ) : null}
      </div>
    </div>
  )
}

function WorkCard({ bridge, task, startedAt, endedAt }: { bridge: Bridge; task: Task; startedAt: number; endedAt: number | null }) {
  const { toolCalls, artifacts, byTask, streaming } = bridge
  const live = task.status === 'running'
  const [open, setOpen] = useState(live)

  // Calls are recorded per role, not per task, so they are windowed by the
  // task's own start and end events. Two readers of the same role working at
  // once would share a window — the card is a narration, not the ledger.
  const calls = toolCalls.filter((call) => call.agentId === task.agentId && call.createdAt >= startedAt - 1 && (endedAt === null || call.createdAt <= endedAt + 1))
  const cost = byTask.find((entry) => entry.taskId === task.id)
  const durationMs = endedAt !== null ? endedAt - startedAt : null
  const ownStream = streaming && streaming.role === task.agentId ? streaming.text : null

  return (
    <div className={`chat-work ${live ? 'live' : ''}`}>
      <button type="button" className="chat-work-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{{ research: '🔍', builder: '🔨', architect: '📐', editor: '✏️', debug: '🐛' }[task.agentId ?? ''] ?? '🤖'}</span>
        <span>
          <strong>{roleLabel(task.agentId)}</strong> {live ? 'is working' : task.status === 'completed' ? 'worked' : task.status}
          {durationMs !== null ? ` for ${(durationMs / 1000).toFixed(1)}s` : ''} · {calls.length} tool call{calls.length === 1 ? '' : 's'}
          {cost ? ` · ${money(cost.costUsd, 4)}` : ''}
        </span>
        {task.stepCount ? <span className="muted tiny">step {task.stepCount}</span> : null}
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open ? (
        <div className="chat-work-body">
          {calls.map((call) => {
            const artifact = artifacts.find((entry) => entry.toolCallId === call.id)
            return (
              <div className="chat-work-line" key={call.id}>
                <span className={`sheet-call-ic ${call.status === 'completed' ? 'ok' : call.status === 'approval_required' ? 'warn' : call.error ? 'bad' : 'busy'}`}>
                  {call.status === 'completed' ? '✓' : call.status === 'approval_required' ? '⚠' : call.error ? '✕' : '▸'}
                </span>
                <span>
                  {call.name.replace('workspace.', '').replace('shell.', '')} {call.input?.path ? <code>{String(call.input.path)}</code> : null}
                  {call.status === 'approval_required' ? ' — parked for approval' : ''}
                </span>
                <span className="chat-work-stat">
                  {artifact?.diff ? <><span className="add">+{artifact.diff.added}</span> <span className="del">−{artifact.diff.removed}</span></> : artifact ? `${artifact.bytes} B` : null}
                </span>
              </div>
            )
          })}
          {ownStream !== null ? <div className="sheet-stream">{ownStream || '…'}<span className="caret" /></div> : null}
          {task.status === 'completed' && task.result ? <div className="chat-work-result">{task.result.length > 280 ? `${task.result.slice(0, 280)}…` : task.result}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

function ReviewCard({ bridge, event }: { bridge: Bridge; event: RunEvent }) {
  const { artifacts, spend, run } = bridge
  const claims = bridge.claims ?? []
  const proven = claims.filter((claim) => claim.verdict === 'PASS').length
  const proof = (event.payload?.proof ?? null) as { predicted?: string[]; verdicts?: { pass: number; fail: number; unknown: number }; claims?: { total: number; proven: number; failed: number } } | null
  return (
    <div className="chat-review">
      <div className="chat-review-head">
        <span className="sheet-call-ic ok">✓</span>
        <strong>Run review</strong>
        <span className="status-chip ok">verified</span>
        {claims.length ? <span className="muted tiny">{proven}/{claims.length} claims proven</span> : null}
        <span style={{ flex: 1 }} />
        <span className="mono muted tiny">{money(spend.costUsd, 4)}</span>
      </div>
      {proof && proof.predicted?.length ? (
        <p className="chat-review-proof" title={proof.predicted.join('; ')}>
          {proof.predicted.length} approved outcome{proof.predicted.length === 1 ? '' : 's'} · {proof.claims?.proven ?? proven} proven · verdicts {proof.verdicts?.pass ?? 0} pass / {proof.verdicts?.fail ?? 0} fail / {proof.verdicts?.unknown ?? 0} unknown
        </p>
      ) : null}
      <p className="chat-review-summary">{String(event.payload?.summary ?? '')}</p>
      {claims.length ? (
        <div className="chat-review-claims">
          {claims.map((claim) => (
            <div className="chat-work-line" key={claim.id}>
              <span className={`sheet-call-ic ${claim.verdict === 'PASS' ? 'ok' : claim.verdict === 'FAIL' ? 'bad' : 'busy'}`}>
                {claim.verdict === 'PASS' ? '✓' : claim.verdict === 'FAIL' ? '✕' : '?'}
              </span>
              <span>{claim.summary}{claim.path ? <code> {claim.path}{claim.startLine ? `:${claim.startLine}` : ''}</code> : null}</span>
              <span className="chat-work-stat">{claim.kind}{claim.verdict ? ` · ${claim.verdict}` : ''}</span>
            </div>
          ))}
        </div>
      ) : null}
      {artifacts.length ? (
        <div className="chat-review-files">
          {artifacts.map((artifact) => (
            <div className="chat-work-line" key={artifact.toolCallId}>
              <span>📄</span>
              <code>{artifact.path}</code>
              <span className="chat-work-stat">
                {artifact.diff ? <><span className="add">+{artifact.diff.added}</span> <span className="del">−{artifact.diff.removed}</span></> : `${artifact.bytes} B`}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {run ? <a className="chat-review-link" href={`/api/runs/${encodeURIComponent(run.id)}/report?format=md`} target="_blank" rel="noreferrer">Full report ↓</a> : null}
    </div>
  )
}

/** Same contract as the activity feed: recent first-class, history one click away. */
const FEED_WINDOW = 100

export function ChatFeed({ bridge }: { bridge: Bridge }) {
  const { messages, plan, tasks, events, streaming } = bridge
  // Per-run like the activity feed: no reset effect, a new run just starts windowed.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const showAll = (bridge.runId && expanded[bridge.runId]) || false

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = messages.map((message) => ({ kind: 'message', at: message.createdAt, message }))

    const planEvent = events.filter((event) => event.type === 'plan.drafted' || event.type === 'plan.edited').at(-1)
    if (plan) items.push({ kind: 'plan', at: planEvent?.createdAt ?? Number.MAX_SAFE_INTEGER - 3 })

    const started = new Map<string, number>()
    const ended = new Map<string, number>()
    for (const event of events) {
      const taskId = typeof event.payload?.taskId === 'string' ? event.payload.taskId : null
      if (!taskId) continue
      if (event.type === 'task.started' && !started.has(taskId)) started.set(taskId, event.createdAt)
      if (['task.completed', 'task.failed', 'task.skipped', 'task.cancelled'].includes(event.type)) ended.set(taskId, event.createdAt)
    }
    for (const task of tasks) {
      items.push({ kind: 'task', at: started.get(task.id) ?? Number.MAX_SAFE_INTEGER - 2, task })
    }

    const review = events.find((event) => event.type === 'run.review.ready')
    if (review) items.push({ kind: 'review', at: review.createdAt, event: review })

    return items.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
  }, [messages, plan, tasks, events])

  const startedAt = useMemo(() => {
    const map = new Map<string, number>()
    for (const event of events) {
      if (event.type === 'task.started' && typeof event.payload?.taskId === 'string' && !map.has(event.payload.taskId)) map.set(event.payload.taskId, event.createdAt)
    }
    return map
  }, [events])
  const endedAt = useMemo(() => {
    const map = new Map<string, number>()
    for (const event of events) {
      if (['task.completed', 'task.failed', 'task.skipped', 'task.cancelled'].includes(event.type) && typeof event.payload?.taskId === 'string') map.set(event.payload.taskId, event.createdAt)
    }
    return map
  }, [events])

  const headStream = streaming && streaming.role === 'head' ? streaming.text : null

  const hidden = showAll ? 0 : Math.max(feed.length - FEED_WINDOW, 0)
  const visible = showAll ? feed : feed.slice(-FEED_WINDOW)

  return (
    <>
      {messages.length === 0 && feed.length === 0 ? (
        <p className="muted">Give the Head AI a direction: what to build, fix, or investigate. It answers in the provider you configured, and its plan is what you approve.</p>
      ) : null}
      {hidden > 0 ? (
        <p className="muted tiny"><button type="button" className="tiny-button" onClick={() => bridge.runId && setExpanded((current) => ({ ...current, [bridge.runId as string]: true }))}>Show {hidden} earlier item(s)</button></p>
      ) : null}
      {visible.map((item) => {
        if (item.kind === 'message') {
          return (
            <article className={`chat-message ${item.message.role}`} key={`m-${item.message.id}`}>
              <span className="chat-role">{item.message.role === 'user' ? 'you' : item.message.agentId ?? 'head'}</span>
              <p>{item.message.content}</p>
            </article>
          )
        }
        if (item.kind === 'plan') return <PlanCard bridge={bridge} key="plan" />
        if (item.kind === 'task') return <WorkCard bridge={bridge} task={item.task} startedAt={startedAt.get(item.task.id) ?? item.at} endedAt={endedAt.get(item.task.id) ?? null} key={item.task.id} />
        return <ReviewCard bridge={bridge} event={item.event} key="review" />
      })}
      {headStream !== null ? (
        <div className="chat-thinking-live">
          <span className="chat-role">head · writing</span>
          {headStream || '…'}<span className="caret" />
        </div>
      ) : null}
    </>
  )
}
