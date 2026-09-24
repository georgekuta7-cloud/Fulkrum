import { useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { roleLabel, resolveRouteDisplay } from '../lib/runGraph'
import { canDraftPlan, PLAN_ROLES } from '../lib/runState'
import { Button, Chip, inputClass, selectClass } from './primitives'

export function PlanCard({ bridge }: { bridge: Bridge }) {
  const { plan, run } = bridge
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const [objective, setObjective] = useState(plan?.plan.objective ?? '')
  const [tasks, setTasks] = useState(() => (plan?.tasks ?? []).map((task) => ({ ...task, dependencies: task.dependsOn.map((dep) => dep + 1).join(', ') })))
  const plannable = !!run && canDraftPlan(run.status)
  const hasDirection = bridge.messages.some((message) => message.role === 'user')
  const providersReady = bridge.providers.some((provider) => provider.configured)
  const routing = (bridge.projectSettings?.routing ?? {}) as Record<string, string>
  const perform = async (operation: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    try { await operation() } finally { setBusy(false) }
  }

  if (!plan) return plannable ? (
    <section className="p-4 rounded-xl bg-surface-container space-y-3" aria-label="Execution plan">
      <p className="text-body-md text-on-surface-variant">{hasDirection ? 'Turn this direction into an executable plan. Review the tasks before starting work.' : 'Send a direction first, then draft a plan to review.'}</p>
      <Button variant="primary" disabled={busy || !hasDirection || !providersReady} onClick={() => void perform(() => bridge.draftPlan())}>{busy ? 'Drafting…' : 'Draft plan'}</Button>
    </section>
  ) : null

  return (
    <section className="bg-surface-container rounded-xl p-4 space-y-4 min-w-0" aria-label="Execution plan">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h2 className="text-label-lg font-semibold break-words">Plan: {plan.plan.objective}</h2>
        <Chip tone={plan.plan.status === 'approved' ? 'ok' : 'plan'}>v{plan.plan.version} · {plan.plan.status}</Chip>
      </div>
      {editing ? (
        <form className="space-y-4" onSubmit={async (event) => {
          event.preventDefault()
          if (busy) return
          setError('')
          const parsed = tasks.map((task) => ({ role: task.role, title: task.title, instructions: task.instructions, acceptanceCheck: task.acceptanceCheck ?? '', dependsOn: task.dependencies.trim() ? task.dependencies.split(',').map((value) => Number(value.trim()) - 1) : [] }))
          if (parsed.some((task, index) => task.dependsOn.some((dep) => !Number.isInteger(dep) || dep < 0 || dep >= index))) {
            setError('Dependencies must be earlier task numbers, separated by commas.')
            return
          }
          await perform(async () => { if (await bridge.editPlan(objective.trim(), parsed)) setEditing(false) })
        }}>
          <label className="flex flex-col gap-1 text-label-md">Objective<input className={inputClass} required value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
          {tasks.map((task, index) => (
            <fieldset key={task.id} className="min-w-0 p-3 rounded-lg bg-surface-container-lowest space-y-2">
              <legend className="text-label-md px-1">Task {index + 1}</legend>
              <label className="flex flex-col gap-1 text-label-md">Task {index + 1} title<input className={inputClass} required value={task.title} onChange={(event) => setTasks((current) => current.map((entry, i) => i === index ? { ...entry, title: event.target.value } : entry))} /></label>
              <label className="flex flex-col gap-1 text-label-md">Task {index + 1} role<select className={selectClass} value={task.role} onChange={(event) => setTasks((current) => current.map((entry, i) => i === index ? { ...entry, role: event.target.value } : entry))}>{PLAN_ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></label>
              <label className="flex flex-col gap-1 text-label-md">Task {index + 1} instructions<textarea className={inputClass} required rows={3} value={task.instructions} onChange={(event) => setTasks((current) => current.map((entry, i) => i === index ? { ...entry, instructions: event.target.value } : entry))} /></label>
              <label className="flex flex-col gap-1 text-label-md">Task {index + 1} acceptance<textarea className={inputClass} rows={2} value={task.acceptanceCheck ?? ''} onChange={(event) => setTasks((current) => current.map((entry, i) => i === index ? { ...entry, acceptanceCheck: event.target.value } : entry))} /></label>
              <label className="flex flex-col gap-1 text-label-md">Task {index + 1} dependencies<input className={inputClass} placeholder="Earlier task numbers, e.g. 1, 2" value={task.dependencies} onChange={(event) => setTasks((current) => current.map((entry, i) => i === index ? { ...entry, dependencies: event.target.value } : entry))} /></label>
            </fieldset>
          ))}
          {error ? <p role="alert" className="text-error text-body-sm">{error}</p> : null}
          <div className="flex gap-2 flex-wrap">
            <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save plan'}</Button>
            <Button disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <ol className="space-y-3">
          {plan.tasks.map((task, index) => {
            const status = bridge.tasks.find((entry) => entry.planTaskId === task.id)?.status ?? 'queued'
            return (
              <li key={task.id} className="space-y-1 p-3 bg-surface-container-lowest rounded-lg">
                <div className="flex justify-between items-start gap-2"><h3 className="text-body-md font-medium">{index + 1}. {task.title}</h3><Chip tone={status === 'completed' ? 'ok' : status === 'failed' ? 'bad' : 'idle'}>{status}</Chip></div>
                <p className="text-label-sm text-primary">{roleLabel(task.role)} · {resolveRouteDisplay(routing, bridge.providers, task.role) ?? 'default provider'}</p>
                <p className="text-body-sm whitespace-pre-wrap break-words">{task.instructions}</p>
                <p className="text-label-sm text-outline">Acceptance</p>
                <p className="text-body-sm whitespace-pre-wrap break-words">{task.acceptanceCheck || 'No explicit acceptance check.'}</p>
                {task.dependsOn.length ? <p className="text-label-sm text-outline">After task {task.dependsOn.map((dep) => dep + 1).join(', ')}</p> : null}
              </li>
            )
          })}
        </ol>
      )}
      {!editing && plannable ? (
        <div className="flex gap-2 flex-wrap">
          {plan.plan.status === 'draft' ? <Button variant="primary" disabled={busy || !providersReady} onClick={() => void perform(() => bridge.control('approve-plan', { planId: plan.plan.id, planHash: plan.plan.contentHash }))}>Approve & Run</Button> : null}
          <Button disabled={busy} onClick={() => {
            setObjective(plan.plan.objective)
            setTasks(plan.tasks.map((task) => ({ ...task, dependencies: task.dependsOn.map((dep) => dep + 1).join(', ') })))
            setEditing(true)
          }}>Edit plan</Button>
          <Button disabled={busy || !providersReady} onClick={() => void perform(() => bridge.draftPlan({ regenerate: true }))}>{busy ? 'Working…' : 'Redraft'}</Button>
        </div>
      ) : null}
      <details className="text-label-sm text-outline"><summary className="cursor-pointer">Plan identity and permissions</summary><p className="break-all font-mono mt-2">{plan.plan.contentHash}</p><p className="mt-1">Permission mode: {run?.permissionMode ?? 'selective'}. Editing creates a new version that needs approval.</p></details>
    </section>
  )
}
