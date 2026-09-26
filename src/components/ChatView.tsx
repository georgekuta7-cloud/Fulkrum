import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import type { ReasoningLevel } from '../api/types'
import { resolveRouteDisplay, roleLabel } from '../lib/runGraph'
import { canChatInRun } from '../lib/runState'
import { ApprovalCard } from './ApprovalCard'
import { Icon } from './Icon'
import { PlanCard } from './PlanCard'
import { RunRecovery } from './RunRecovery'
import { Button, Chip, selectClass } from './primitives'

const time = (value: number) => new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const MessageContent = lazy(() => import('./MessageContent').then((module) => ({ default: module.MessageContent })))
const WORKER_ROLES = ['head', 'research', 'builder', 'architect', 'editor', 'debug', 'reviewer'] as const
const REASONING_OPTIONS: ReasoningLevel[] = ['minimal', 'low', 'medium', 'high']

function WorkerStrip({ bridge }: { bridge: Bridge }) {
  const routing = (bridge.projectSettings?.routing ?? {}) as Record<string, string>
  const costs = new Map<string, number>()
  for (const entry of bridge.byTask ?? []) costs.set(entry.agentId ?? 'head', (costs.get(entry.agentId ?? 'head') ?? 0) + entry.costUsd)
  const visible = WORKER_ROLES.filter((role) => routing[role]?.trim() || bridge.tasks.some((task) => task.agentId === role))
  if (!visible.length) return null
  return <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2" aria-label="Workers">
    {visible.map((role) => {
      const tasks = bridge.tasks.filter((task) => task.agentId === role)
      const active = tasks.find((task) => task.status === 'running')
      const waiting = bridge.approval?.toolCall.agentId === role
      const state = waiting ? 'waiting' : active ? (bridge.run?.status === 'paused' ? 'paused' : 'working') : bridge.streaming?.role === role ? 'working' : tasks.at(-1)?.status === 'completed' ? 'done' : tasks.at(-1)?.status === 'failed' ? 'failed' : 'idle'
      return <div key={role} className="p-2 rounded-lg border border-outline-variant/40 bg-surface-container min-w-0 space-y-1">
        <div className="flex items-center justify-between gap-2"><span className="text-label-md font-semibold">{roleLabel(role)}</span><Chip tone={state === 'failed' ? 'bad' : waiting || state === 'done' ? 'ok' : state === 'working' ? 'busy' : 'idle'}>{state}</Chip></div>
        <p className="text-body-sm text-on-surface-variant truncate" title={active?.title}>{active?.title ?? (waiting ? 'parked on approval' : 'no active task')}</p>
        <p className="font-mono text-label-sm text-outline truncate" title={resolveRouteDisplay(routing, bridge.providers, role) ?? undefined}>{resolveRouteDisplay(routing, bridge.providers, role) ?? 'default provider'}{costs.get(role) ? ` · $${costs.get(role)!.toFixed(4)}` : ''}</p>
      </div>
    })}
  </div>
}

function PipelineStrip({ bridge }: { bridge: Bridge }) {
  const tasks = bridge.tasks
  if (!tasks.length) return null
  const done = tasks.filter((task) => task.status === 'completed').length
  return <div className="flex items-center gap-2 px-3 py-2 bg-surface-container rounded-lg border border-outline-variant/40 overflow-x-auto" role="status" aria-label={`Plan progress: ${done} of ${tasks.length} tasks done`}>
    {tasks.map((task, index) => <div key={task.id} className="flex items-center gap-2 shrink-0">
      {index > 0 ? <span className="w-6 h-px bg-outline-variant" aria-hidden="true" /> : null}
      <span className={`w-2 h-2 rounded-full ${task.status === 'completed' ? 'bg-secondary' : task.status === 'running' ? 'bg-primary' : task.status === 'failed' ? 'bg-error' : 'bg-outline-variant'}`} aria-hidden="true" />
      <span className="text-label-md whitespace-nowrap">{task.title}</span>
    </div>)}
    <span className="ml-auto font-mono text-label-sm text-secondary shrink-0">{Math.round((done / tasks.length) * 100)}%</span>
  </div>
}

function ProofSection({ bridge }: { bridge: Bridge }) {
  const claims = bridge.claims
  if (!claims.length) return null
  const proven = claims.filter((claim) => claim.verdict === 'PASS').length
  return <details className="bg-surface-container rounded-lg group">
    <summary className="flex items-center gap-2 p-4 cursor-pointer list-none"><Icon name="verified" className="text-secondary text-xl" /><span className="text-label-lg font-semibold">Proof</span><span className="font-mono text-label-sm text-secondary">{proven}/{claims.length} proven</span><span className="ml-auto text-label-sm text-outline group-open:hidden">show</span></summary>
    <div className="px-4 pb-4 space-y-2">
      <p className="text-label-sm text-outline">The fraction of claims proven is the value of the run.</p>
      {claims.map((claim) => <div key={claim.id} className="p-2.5 rounded-lg bg-surface-container-lowest space-y-1">
        <div className="flex items-center justify-between gap-2"><Chip tone={claim.verdict === 'PASS' ? 'ok' : claim.verdict === 'FAIL' ? 'bad' : 'idle'}>{claim.verdict === 'PASS' ? '✓ proven' : claim.verdict === 'FAIL' ? '✕ refuted' : '? unproven'}</Chip><span className="font-mono text-label-sm text-outline">{claim.kind}</span></div>
        <p className="text-body-sm break-words">{claim.summary}</p>
        {claim.path ? <p className="font-mono text-label-sm text-primary break-all">{claim.path}{claim.startLine ? `:${claim.startLine}` : ''}</p> : null}
      </div>)}
    </div>
  </details>
}

export function ChatView({ bridge, onOpenSettings }: { bridge: Bridge; onOpenSettings?: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const { messages, plan, approval, streaming, run } = bridge
  const providersReady = bridge.providers.some((provider) => provider.configured)
  const chatDisabled = !run || !canChatInRun(run.status) || bridge.projectLoading || bridge.runLoading
  const headRoute = ((bridge.projectSettings?.routing ?? {}) as Record<string, string>).head ?? ''
  const headReasoning = ((bridge.projectSettings?.reasoning ?? {}) as Record<string, string>).head ?? ''

  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }) }, [messages.length, streaming?.text])
  useEffect(() => {
    const input = inputRef.current
    if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 128)}px` }
  }, [prompt])

  const send = async () => {
    const text = prompt.trim()
    if (!text || sendingRef.current || chatDisabled || !providersReady) return
    sendingRef.current = true
    setSending(true)
    try {
      if (await bridge.chat(text)) setPrompt((current) => current.trim() === text ? '' : current)
    } finally { sendingRef.current = false; setSending(false) }
  }

  return (
    <div className="w-full max-w-4xl mx-auto px-3 sm:px-4 py-4 pb-48 flex flex-col gap-4 min-w-0">
      {!providersReady ? <div className="flex items-start gap-3 p-4 rounded-lg bg-error-container/20 border border-error/40" role="alert"><Icon name="key_off" className="text-error text-xl" /><div className="space-y-2 min-w-0"><p className="text-body-md">No provider has a key, so nothing can answer yet. Configure a provider in Settings.</p>{onOpenSettings ? <Button onClick={onOpenSettings}>Open provider settings</Button> : null}</div></div> : null}
      <RunRecovery key={run?.id} bridge={bridge} />
      <WorkerStrip bridge={bridge} />
      <PipelineStrip bridge={bridge} />
      {messages.length === 0 && !plan ? <p className="text-body-md text-on-surface-variant py-4">Give the Head AI a direction: what to build, fix, or investigate. Draft and inspect its plan before approving execution.</p> : null}
      {messages.map((message) => message.role === 'user' ? (
        <div className="flex justify-end pl-4 sm:pl-8 min-w-0" key={message.id}><div className="max-w-xl min-w-0 bg-surface-container-high rounded-lg rounded-tr-sm px-4 py-3"><p className="text-body-md whitespace-pre-wrap break-words">{message.content}</p><p className="text-right font-mono text-label-sm text-on-surface-variant mt-1">{time(message.createdAt)}</p></div></div>
      ) : (
        <div className="flex items-start gap-2 sm:gap-3 min-w-0" key={message.id}><div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-primary-container/40 flex items-center justify-center shrink-0" aria-hidden="true"><Icon name="smart_toy" className="text-primary text-lg" /></div><div className="flex-1 space-y-1 min-w-0"><div className="flex items-center gap-2"><span className="text-label-md font-semibold">{roleLabel(message.agentId ?? 'head')}</span><span className="font-mono text-label-sm text-on-surface-variant">{time(message.createdAt)}</span></div><Suspense fallback={<p className="text-body-md whitespace-pre-wrap break-words">{message.content}</p>}><MessageContent text={message.content} /></Suspense></div></div>
      ))}
      {streaming ? <div className="space-y-1 min-w-0" aria-live="polite"><span className="text-label-md font-semibold">{roleLabel(streaming.role)} · writing</span><p className="text-body-md whitespace-pre-wrap break-words">{streaming.text || '…'}</p></div> : null}
      <PlanCard key={plan?.plan.id ?? 'new-plan'} bridge={bridge} />
      {approval ? <ApprovalCard key={approval.toolCall.id} bridge={bridge} approval={approval} /> : null}
      {(bridge.runGrants ?? []).length ? <section aria-label="Run grants" className="space-y-2 p-3 bg-surface-container rounded-lg"><h2 className="text-label-md font-semibold">Allowed for this run</h2>{bridge.runGrants.map((grant) => <div key={grant.toolName} className="flex gap-2 items-center justify-between"><code className="font-mono text-body-sm break-all">{grant.toolName}</code><Button onClick={() => void bridge.revokeRunGrant(grant.toolName)}>Revoke</Button></div>)}</section> : null}
      <ProofSection bridge={bridge} />
      <div ref={endRef} aria-hidden="true" />
      <div className="fixed bottom-4 left-16 right-0 z-30 pointer-events-none">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 pointer-events-auto"><div className="bg-surface-container/95 rounded-lg border border-outline-variant/40 shadow-panel p-2.5">
          <label className="visually-hidden" htmlFor="chat-prompt">Direct the Head AI</label>
          {providersReady ? (
            <div className="flex items-center gap-2 px-2 pb-1.5 flex-wrap">
              <label className="visually-hidden" htmlFor="head-cast">Model speaking for the Head AI</label>
              <select
                id="head-cast"
                className={`${selectClass} !py-1 !px-2 !min-w-0 max-w-[240px] font-mono text-label-sm`}
                value={headRoute}
                onChange={(event) => void bridge.saveRouting('head', event.target.value)}
                title="Which configured provider speaks for the Head AI in this project"
              >
                <option value="">Head model: first configured</option>
                {bridge.providers.filter((provider) => provider.configured).map((provider) => (
                  <option key={provider.id} value={`${provider.label} · ${provider.model}`}>{provider.label} · {provider.model}</option>
                ))}
              </select>
              <label className="visually-hidden" htmlFor="head-reasoning">Reasoning level for the Head AI</label>
              <select
                id="head-reasoning"
                className={`${selectClass} !py-1 !px-2 !min-w-0 font-mono text-label-sm`}
                value={headReasoning}
                onChange={(event) => void bridge.setReasoning('head', (event.target.value || null) as ReasoningLevel | null)}
                title="How hard the Head AI thinks; default leaves it to the provider"
              >
                <option value="">Reasoning: provider default</option>
                {REASONING_OPTIONS.map((level) => <option key={level} value={level}>Reasoning: {level}</option>)}
              </select>
            </div>
          ) : null}
          <div className="flex items-end gap-2 px-2 pb-1">
            <textarea ref={inputRef} id="chat-prompt" className="w-full min-w-0 bg-transparent text-body-md placeholder:text-outline focus:outline-none resize-none max-h-32 py-1 leading-relaxed" rows={1} placeholder={chatDisabled ? 'Resume this run or start a new run…' : 'Direct the Head AI, or describe what to build…'} value={prompt} disabled={chatDisabled} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send() } }} />
            <Button variant="primary" className="!px-2.5 !py-2 shrink-0" disabled={!prompt.trim() || sending || chatDisabled || !providersReady} onClick={() => void send()} aria-label="Send (Ctrl+Enter)"><Icon name="arrow_upward" className="text-xl" /></Button>
          </div>
        </div></div>
      </div>
    </div>
  )
}
