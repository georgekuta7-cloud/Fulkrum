import { useEffect, useRef, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { resolveRouteDisplay, roleLabel } from '../lib/runGraph'
import { Button, Chip } from './primitives'

/**
 * The core surface: the conversation, the plan it produced, the decision it
 * is waiting on, and what it has proven — in that order, in one column.
 * Approvals render inline where the work is described, never in a hidden tab:
 * the question this screen answers first is "what needs me right now". The
 * worker strip answers the second: "who is doing what, right now".
 */

const time = (value: number) => new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const WORKER_ROLES = ['head', 'research', 'builder', 'architect', 'editor', 'debug'] as const

function WorkerStrip({ bridge }: { bridge: Bridge }) {
  const routing = (bridge.projectSettings?.routing ?? {}) as Record<string, string>
  const costByAgent = new Map<string, number>()
  for (const entry of bridge.byTask ?? []) {
    const key = entry.agentId ?? 'head'
    costByAgent.set(key, (costByAgent.get(key) ?? 0) + entry.costUsd)
  }
  const waitingAgent = bridge.approval?.toolCall.agentId ?? null
  const visible = WORKER_ROLES.filter((role) => (routing[role] ?? '').trim() || (bridge.tasks ?? []).some((t: any) => t.agentId === role))
  if (!visible.length) return null
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-2" aria-label="Workers">
      {visible.map((role) => {
        const running = (bridge.tasks ?? []).find((t: any) => t.agentId === role && t.status === 'running')
        const waiting = waitingAgent === role
        const cost = costByAgent.get(role) ?? 0
        return (
          <div key={role} className={`p-2.5 rounded-xl border bg-surface-container flex flex-col gap-1 ${waiting ? 'border-secondary/60' : running ? 'border-primary/40' : 'border-outline-variant/30'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-label-md font-semibold text-on-surface">{roleLabel(role)}</span>
              <span className={`flex items-center gap-1 font-mono text-label-sm ${waiting ? 'text-secondary' : running ? 'text-primary' : 'text-outline'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${waiting || running ? 'bg-current animate-pulse' : 'bg-current'}`} aria-hidden="true" />
                {waiting ? 'waiting' : running ? 'working' : 'idle'}
              </span>
            </div>
            <p className="text-body-sm text-on-surface-variant truncate">{running?.title ?? (waiting ? 'parked on approval' : 'no active task')}</p>
            <p className="font-mono text-label-sm text-outline truncate">{resolveRouteDisplay(routing, bridge.providers, role) ?? 'not cast'}{cost > 0 ? ` · $${cost.toFixed(4)}` : ''}</p>
          </div>
        )
      })}
    </div>
  )
}

function PipelineStrip({ bridge }: { bridge: Bridge }) {
  const tasks = bridge.tasks ?? []
  if (!tasks.length) return null
  const done = tasks.filter((t: any) => t.status === 'completed').length
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-surface-container rounded-xl overflow-x-auto" role="status" aria-label={`Plan progress: ${done} of ${tasks.length} tasks done`}>
      {tasks.map((task: any, i: number) => (
        <div key={task.id} className="flex items-center gap-2 flex-shrink-0">
          {i > 0 ? <span className="w-6 h-px bg-outline-variant" aria-hidden="true" /> : null}
          <span className={`w-2 h-2 rounded-full ${task.status === 'completed' ? 'bg-tertiary' : task.status === 'running' ? 'bg-primary animate-pulse' : task.status === 'failed' ? 'bg-error' : 'bg-outline-variant'}`} aria-hidden="true" />
          <span className={`text-label-md whitespace-nowrap ${task.status === 'completed' ? 'text-on-surface-variant line-through' : task.status === 'running' ? 'text-primary font-semibold' : 'text-on-surface-variant'}`}>
            {task.title}
          </span>
        </div>
      ))}
      <span className="ml-auto font-mono text-label-sm text-tertiary flex-shrink-0">{Math.round((done / tasks.length) * 100)}%</span>
    </div>
  )
}

function ApprovalCard({ bridge }: { bridge: Bridge }) {
  const approval = bridge.approval
  const [showDeny, setShowDeny] = useState(false)
  const [reason, setReason] = useState('')
  const [answer, setAnswer] = useState('')
  if (!approval) return null
  const call = approval.toolCall
  const isQuestion = call.kind === 'ask' || call.name === 'run.ask'
  const question = String(call.resolved?.question ?? call.resolved?.context ?? 'The worker has a question.')
  const command = call.resolved?.argv?.join(' ') ?? call.resolved?.relative ?? call.name

  return (
    <div className="bg-surface-container-low rounded-xl p-4 shadow-md space-y-3 relative overflow-hidden" role="alert" aria-label={isQuestion ? 'Worker question' : 'Approval required'}>
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-secondary" aria-hidden="true" />
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-secondary text-lg" aria-hidden="true">{isQuestion ? 'help' : 'gavel'}</span>
        <span className="text-label-lg font-semibold text-on-surface">{isQuestion ? 'Question' : 'Approval required'}</span>
        <code className="font-mono text-label-sm text-on-surface-variant px-1.5 py-0.5 rounded bg-surface-container">{call.name}</code>
      </div>
      {isQuestion ? (
        <div className="space-y-3">
          <p className="text-body-md text-on-surface">{question}</p>
          <div className="flex gap-2">
            <label className="visually-hidden" htmlFor="approval-answer">Answer</label>
            <input
              id="approval-answer"
              className="flex-1 px-3 py-1.5 bg-surface-container rounded-lg text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Answer…"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && answer.trim()) { void bridge.answerCall(answer.trim()); setAnswer('') } }}
            />
            <Button variant="primary" disabled={!answer.trim()} onClick={() => { void bridge.answerCall(answer.trim()); setAnswer('') }}>Send</Button>
            <Button variant="danger" onClick={() => void bridge.denyCall('Declined.')}>Decline</Button>
          </div>
        </div>
      ) : (
        <>
          <p className="font-mono text-body-sm text-on-surface-variant truncate"><span className="text-tertiary">$</span> {command}</p>
          {approval.warnings?.length ? (
            <p className="text-body-sm text-error">Shaped like a credential: {approval.warnings.map((w: any) => w.field ?? w.kind ?? 'secret').join(', ')}</p>
          ) : null}
          {showDeny ? (
            <div className="flex gap-2">
              <label className="visually-hidden" htmlFor="deny-reason">Why not</label>
              <input
                id="deny-reason"
                className="flex-1 px-3 py-1.5 bg-surface-container rounded-lg text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-1 focus:ring-primary"
                autoFocus
                placeholder="Why not? The worker reads this."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { void bridge.denyCall(reason || 'Denied.'); setReason(''); setShowDeny(false) } }}
              />
              <Button variant="danger" onClick={() => { void bridge.denyCall(reason || 'Denied.'); setReason(''); setShowDeny(false) }}>Send</Button>
              <Button onClick={() => setShowDeny(false)}>Cancel</Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={() => void bridge.approveCall('once')}>Approve <kbd className="opacity-70">a</kbd></Button>
              <Button onClick={() => void bridge.approveCall('run')}>For run <kbd className="opacity-70">r</kbd></Button>
              <Button variant="danger" id="deny-open" className="ml-auto" onClick={() => setShowDeny(true)}>Deny <kbd className="opacity-70">d</kbd></Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ProofSection({ bridge }: { bridge: Bridge }) {
  const claims = bridge.claims ?? []
  if (!claims.length) return null
  const proven = claims.filter((c: any) => c.verdict === 'PASS').length
  return (
    <details className="bg-surface-container rounded-xl shadow-sm group">
      <summary className="flex items-center gap-2 p-4 cursor-pointer list-none">
        <span className="material-symbols-outlined text-tertiary" aria-hidden="true">verified</span>
        <span className="text-label-lg font-semibold text-on-surface">Proof</span>
        <span className="font-mono text-label-sm text-tertiary">{proven}/{claims.length} proven</span>
        <span className="ml-auto text-label-sm text-outline group-open:hidden">show</span>
      </summary>
      <div className="px-4 pb-4 space-y-2">
        <p className="text-label-sm text-outline">The fraction of claims proven is the value of the run.</p>
        {claims.map((claim: any) => (
          <div key={claim.id} className="p-2.5 rounded-lg bg-surface-container-lowest flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <Chip tone={claim.verdict === 'PASS' ? 'ok' : claim.verdict === 'FAIL' ? 'bad' : 'idle'}>
                {claim.verdict === 'PASS' ? '✓ proven' : claim.verdict === 'FAIL' ? '✕ refuted' : '? unproven'}
              </Chip>
              <span className="font-mono text-label-sm text-outline">{claim.kind}</span>
            </div>
            <p className="text-body-sm text-on-surface">{claim.summary}</p>
            {claim.path ? <p className="font-mono text-label-sm text-primary truncate">{claim.path}{claim.startLine ? `:${claim.startLine}` : ''}</p> : null}
          </div>
        ))}
      </div>
    </details>
  )
}

export function ChatView({ bridge }: { bridge: Bridge }) {
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const { messages, plan, approval, streaming, run } = bridge
  const providersReady = bridge.providers.some((p: any) => p.configured)
  const runFailed = run && ['failed', 'cancelled', 'completed'].includes(run.status)

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [messages.length, streaming?.text])

  // Keyboard-first approvals: single keys decide, but never while typing.
  useEffect(() => {
    if (!approval || approval.toolCall.kind === 'ask' || approval.toolCall.name === 'run.ask') return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.key === 'a') void bridge.approveCall('once')
      else if (event.key === 'd') { event.preventDefault(); document.getElementById('deny-open')?.click() }
      else if (event.key === 'r') void bridge.approveCall('run')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [approval, bridge])

  const send = async () => {
    const text = prompt.trim()
    if (!text || sending) return
    setPrompt('')
    setSending(true)
    try {
      await bridge.chat(text)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-4 pb-40 flex flex-col gap-4">
      {!providersReady ? (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-error-container/20 border border-error/40" role="alert">
          <span className="material-symbols-outlined text-error" aria-hidden="true">key_off</span>
          <p className="text-body-md text-on-surface flex-1">No provider has a key, so nothing can answer yet. Add one in Settings — keys stay on this machine, and this same screen works after.</p>
        </div>
      ) : null}

      {runFailed ? (
        <div className="flex flex-col gap-3 p-4 rounded-xl bg-surface-container border border-outline-variant/40">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-error" aria-hidden="true">error</span>
            <span className="text-label-lg font-semibold text-on-surface">This run is {run.status}</span>
          </div>
          <p className="text-body-md text-on-surface-variant">It cannot continue. Its history below still reads as a report; start a new run to keep working.</p>
          <div>
            <Button variant="primary" onClick={() => void bridge.createRun()}>Start a new run</Button>
          </div>
        </div>
      ) : null}

      <WorkerStrip bridge={bridge} />
      <PipelineStrip bridge={bridge} />

      {messages.length === 0 && !plan ? (
        <p className="text-body-md text-on-surface-variant text-center py-6">Give the Head AI a direction: what to build, fix, or investigate. It answers in the provider you configured, and its plan is what you approve.</p>
      ) : null}

      {messages.map((msg: any) => msg.role === 'user' ? (
        <div className="flex justify-end pl-8" key={msg.id}>
          <div className="max-w-xl bg-surface-container-high rounded-2xl rounded-tr-sm px-4 py-3 shadow-sm">
            <p className="text-body-md text-on-surface leading-relaxed">{msg.content}</p>
            <p className="text-right font-mono text-label-sm text-on-surface-variant mt-1">{time(msg.createdAt)}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3 pr-4" key={msg.id}>
          <div className="w-8 h-8 rounded-full bg-primary-container/40 flex items-center justify-center flex-shrink-0 mt-0.5" aria-hidden="true">
            <span className="material-symbols-outlined text-primary text-lg">smart_toy</span>
          </div>
          <div className="flex-1 space-y-1 max-w-2xl min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-label-md font-semibold text-on-surface">{msg.agentId && msg.agentId !== 'head' ? msg.agentId : 'Head AI'}</span>
              <span className="font-mono text-label-sm text-on-surface-variant">{time(msg.createdAt)}</span>
            </div>
            <p className="text-body-md text-on-surface leading-relaxed">{msg.content}</p>
          </div>
        </div>
      ))}

      {streaming ? (
        <div className="flex items-start gap-3 pr-4" aria-live="polite">
          <div className="w-8 h-8 rounded-full bg-primary-container/40 flex items-center justify-center flex-shrink-0 mt-0.5" aria-hidden="true">
            <span className="material-symbols-outlined text-primary text-lg">smart_toy</span>
          </div>
          <div className="flex-1 space-y-1 max-w-2xl min-w-0">
            <span className="text-label-md font-semibold text-on-surface">{streaming.role === 'head' ? 'Head AI' : streaming.role} · writing</span>
            <p className="text-body-md text-on-surface leading-relaxed">{streaming.text || '…'}</p>
          </div>
        </div>
      ) : null}

      {plan ? (
        <div className="flex items-start gap-3 pr-4">
          <div className="w-8 h-8 rounded-full bg-primary-container/40 flex items-center justify-center flex-shrink-0 mt-0.5" aria-hidden="true">
            <span className="material-symbols-outlined text-primary text-lg">checklist</span>
          </div>
          <div className="flex-1 max-w-2xl min-w-0 bg-surface-container rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2 pb-3">
              <span className="text-label-lg font-semibold text-on-surface">Plan: {plan.plan.objective}</span>
              <Chip tone={plan.plan.status === 'approved' ? 'ok' : 'plan'}>v{plan.plan.version} · {plan.plan.status}</Chip>
            </div>
            <ol className="space-y-2">
              {(plan.tasks ?? []).map((task: any, i: number) => {
                const live = (bridge.tasks ?? []).find((t: any) => t.planTaskId === task.id)
                const state = live?.status ?? 'queued'
                return (
                  <li key={task.id ?? i} className={`flex items-center gap-2.5 text-label-md ${state === 'completed' ? 'text-on-surface-variant' : 'text-on-surface'}`}>
                    <span className={`w-3.5 h-3.5 rounded-full flex items-center justify-center flex-shrink-0 ${state === 'completed' ? 'bg-tertiary' : state === 'running' ? 'bg-primary/20' : 'bg-surface-container-highest'}`} aria-hidden="true">
                      {state === 'completed' ? <span className="material-symbols-outlined text-[10px] text-on-primary">check</span> : state === 'running' ? <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" /> : <span className="font-mono text-[9px] text-on-surface-variant">{i + 1}</span>}
                    </span>
                    <span className={state === 'completed' ? 'line-through' : undefined}>{task.title}</span>
                  </li>
                )
              })}
            </ol>
            {plan.plan.status === 'draft' && ['planning', 'review', 'interrupted'].includes(run?.status ?? '') ? (
              <div className="flex gap-2 pt-3">
                <Button variant="primary" onClick={() => void bridge.control('approve-plan', { planId: plan.plan.id, planHash: plan.plan.contentHash })}>Approve & Run</Button>
                <Button onClick={() => void bridge.draftPlan({ regenerate: true })}>Redraft</Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <ApprovalCard bridge={bridge} />
      <ProofSection bridge={bridge} />
      <div ref={endRef} aria-hidden="true" />

      <div className="fixed bottom-4 left-16 right-0 z-30 pointer-events-none">
        <div className="max-w-4xl mx-auto px-4 pointer-events-auto">
          <div className="bg-surface-container/95 backdrop-blur-xl rounded-2xl shadow-2xl p-2.5">
            <label className="visually-hidden" htmlFor="chat-prompt">Direct the Head AI</label>
            <div className="flex items-end gap-2 px-2 pb-1">
              <textarea
                id="chat-prompt"
                className="w-full bg-transparent text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none resize-none max-h-32 py-1 leading-relaxed"
                rows={1}
                placeholder={runFailed ? 'Start a new run above to continue…' : 'Direct the Head AI, or describe what to build…'}
                value={prompt}
                disabled={!!runFailed}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send() } }}
                onInput={(e) => { const t = e.target as HTMLTextAreaElement; t.style.height = ''; t.style.height = `${t.scrollHeight}px` }}
              />
              <Button variant="primary" className="!px-2.5 !py-2" disabled={!prompt.trim() || sending || !!runFailed} onClick={() => void send()} aria-label="Send (Ctrl+Enter)">
                <span className="material-symbols-outlined" aria-hidden="true">arrow_upward</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
