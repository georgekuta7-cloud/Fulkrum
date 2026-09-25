import { useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { Button, inputClass } from './primitives'

export function RunRecovery({ bridge }: { bridge: Bridge }) {
  const run = bridge.run
  const [budget, setBudget] = useState(String(run?.budgetUsd ?? bridge.estimate?.ceilingUsd ?? ''))
  const [busy, setBusy] = useState(false)
  if (!run || !['failed', 'cancelled', 'completed', 'interrupted', 'budget_exceeded', 'paused'].includes(run.status)) return null
  const terminal = ['cancelled', 'completed'].includes(run.status)
  const message = terminal ? 'This run is a report. Start a new run to keep working.'
    : run.status === 'budget_exceeded' ? 'Raise the run ceiling below or the daily ceiling in Settings, then use Resume in the header.'
      : run.status === 'failed' ? 'The run failed. Resume retries work under its approved plan; you can also start a new run.'
        : run.status === 'interrupted' ? 'The bridge stopped before this run finished. Resume continues approved work; an unapproved plan must be reviewed first.'
          : 'This run is paused. Resume returns to planning if no plan was approved, or continues the approved work.'
  const latestFailure = [...(bridge.events ?? [])].reverse().find((event) => event.type === 'run.failed')?.payload?.error
  return (
    <section aria-label="Run status" className="space-y-3 p-4 rounded-lg bg-surface-container border border-outline-variant/40">
      <h2 className="text-label-lg font-semibold">This run is {run.status.replaceAll('_', ' ')}</h2>
      <p className="text-body-md text-on-surface-variant">{message}</p>
      {run.interruptionReason || latestFailure ? <p className="text-body-sm text-error break-words">{run.interruptionReason ?? String(latestFailure)}</p> : null}
      {run.status === 'budget_exceeded' ? <form className="flex flex-wrap items-end gap-2" onSubmit={async (event) => {
        event.preventDefault()
        const value = budget.trim() ? Number(budget) : null
        if (value !== null && (!Number.isFinite(value) || value <= 0)) return
        setBusy(true)
        try { await bridge.control('set-budget', { budgetUsd: value }) } finally { setBusy(false) }
      }}><label className="flex flex-col gap-1 text-label-md">Run budget (USD)<input className={inputClass} type="number" min="0.01" step="0.01" placeholder="Default ceiling" value={budget} onChange={(event) => setBudget(event.target.value)} /></label><Button type="submit" disabled={busy}>Update budget</Button></form> : null}
      <Button disabled={busy} variant="primary" onClick={async () => { setBusy(true); try { await bridge.createRun() } finally { setBusy(false) } }}>Start a new run</Button>
    </section>
  )
}
