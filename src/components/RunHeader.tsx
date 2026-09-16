import { useState } from 'react'
import { ChevronDown, Pause, Play, Square, Coins, Cpu, AlertTriangle, CheckCircle2, Clock } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'

/**
 * The run header: what state this run is in, what it has cost, and what can be done
 * to it. Every number here is real — the breakdown opens so "why does it say $0.04"
 * has an answer rather than a tooltip's guess.
 */

const statusTone = (status: string) => {
  if (status === 'review' || status === 'completed') return 'ok'
  if (status === 'executing' || status === 'planning') return 'busy'
  if (status === 'paused' || status === 'interrupted') return 'warn'
  if (status === 'budget_exceeded' || status === 'failed' || status === 'cancelled') return 'bad'
  return 'idle'
}

const money = (value: number, digits = 4) => `$${value.toFixed(digits)}`

function SpendBreakdown({ bridge }: { bridge: Bridge }) {
  const { spend, byTask, estimate, run } = bridge
  const ceiling = run?.budgetUsd ?? estimate?.ceilingUsd ?? null
  return (
    <div className="popover spend-breakdown">
      <div className="popover-row">
        <span>Total</span>
        <strong>{money(spend.costUsd)}</strong>
      </div>
      <div className="popover-row">
        <span>Calls</span>
        <strong>{spend.calls}</strong>
      </div>
      {spend.unpricedCalls > 0 ? (
        <p className="popover-note warn">
          <AlertTriangle size={12} /> {spend.unpricedCalls} call(s) used a model with no known price, so this total is a lower bound.
        </p>
      ) : null}
      {ceiling ? (
        <div className="popover-row">
          <span>Ceiling</span>
          <strong>{money(ceiling, 2)}</strong>
        </div>
      ) : null}
      {byTask.length ? (
        <table className="mini-table">
          <thead>
            <tr><th>task</th><th>calls</th><th>cost</th></tr>
          </thead>
          <tbody>
            {byTask.map((entry) => (
              <tr key={entry.taskId ?? 'supervisor'}>
                <td>{entry.title ?? 'untitled'}{entry.agentId ? <span className="muted"> · {entry.agentId}</span> : null}</td>
                <td>{entry.calls}</td>
                <td>{entry.unpricedCalls ? `${money(entry.costUsd)}+` : money(entry.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="popover-note">No calls have been priced yet.</p>}
    </div>
  )
}

export function RunHeader({ bridge }: { bridge: Bridge }) {
  const { run, runId, tasks, status, spend, estimate, events, control } = bridge
  const [showSpend, setShowSpend] = useState(false)
  const [showBudget, setShowBudget] = useState(false)
  const [budgetDraft, setBudgetDraft] = useState('')

  if (!run) {
    return (
      <header className="run-header empty">
        <span className="run-id muted">no run open</span>
      </header>
    )
  }

  const done = tasks.filter((task) => task.status === 'completed').length
  const lastEvent = events.at(-1)
  const engine = status?.execution
  const providerHealth = (status?.providers ?? []).filter((provider) => provider.breaker?.open)

  return (
    <header className="run-header">
      <div className="run-identity">
        <span className={`status-chip ${statusTone(run.status)}`}>{run.status.replaceAll('_', ' ')}</span>
        <span className="run-id" title={run.id}>{runId?.slice(0, 18)}</span>
        <span className="muted">{run.permissionMode} · {done}/{tasks.length || '0'} tasks</span>
      </div>

      <div className="run-metrics">
        <button type="button" className="metric" onClick={() => setShowSpend((open) => !open)} aria-expanded={showSpend}>
          <Coins size={13} />
          <span>{money(spend.costUsd)}</span>
          {spend.unpricedCalls ? <span className="metric-flag">+{spend.unpricedCalls} unpriced</span> : null}
          <ChevronDown size={12} />
        </button>
        {estimate?.estimateUsd ? (
          <span className="metric static" title={estimate.basis}>
            <Clock size={13} />
            <span>{money(estimate.estimateUsd.low, 4)}–{money(estimate.estimateUsd.high, 4)} expected</span>
          </span>
        ) : null}
        <span className={`metric static ${engine?.available ? 'ok' : 'bad'}`} title={engine?.available ? `${engine.label} ${engine.version} · ${engine.image}` : engine?.reason}>
          {engine?.available ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
          <span>{engine?.available ? 'commands' : 'no engine'}</span>
        </span>
        {providerHealth.length ? (
          <span className="metric static bad" title={providerHealth.map((provider) => provider.label).join(', ')}>
            <AlertTriangle size={13} /> <span>{providerHealth.length} provider(s) skipped</span>
          </span>
        ) : null}
      </div>

      <div className="run-controls">
        {run.status === 'paused'
          ? <button type="button" onClick={() => void control('resume')}><Play size={14} /> Resum</button>
          : null}
        {['executing', 'planning'].includes(run.status)
          ? <button type="button" onClick={() => void control('pause')}><Pause size={14} /> Pause</button>
          : null}
        {!['cancelled', 'completed'].includes(run.status)
          ? <button type="button" className="danger" onClick={() => void control('cancel')}><Square size={13} /> Stop</button>
          : null}
        <button type="button" onClick={() => { setBudgetDraft(String(run.budgetUsd ?? '')); setShowBudget((open) => !open) }}>Budget</button>
        <a className="button" href={`/api/runs/${encodeURIComponent(run.id)}/report?format=md`} target="_blank" rel="noreferrer">Report</a>
        <a className="button" href={`/api/runs/${encodeURIComponent(run.id)}/bundle`}>Bundle</a>
      </div>

      {showBudget ? (
        <div className="popover budget-popover">
          <label>
            <span>Ceiling for this run (USD, empty for none)</span>
            <input value={budgetDraft} inputMode="decimal" onChange={(event) => setBudgetDraft(event.target.value)} />
          </label>
          <div className="popover-actions">
            <button type="button" className="primary" onClick={() => { void control('set-budget', { budgetUsd: budgetDraft === '' ? null : Number(budgetDraft) }); setShowBudget(false) }}>Set</button>
            <button type="button" onClick={() => setShowBudget(false)}>Cancel</button>
          </div>
        </div>
      ) : null}

      {showSpend ? <SpendBreakdown bridge={bridge} /> : null}

      {lastEvent ? <div className="run-last"><Cpu size={12} /> <span className="muted">{lastEvent.type}</span></div> : null}
    </header>
  )
}
