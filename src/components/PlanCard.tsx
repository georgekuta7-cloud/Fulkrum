import { useState } from 'react'
import type { Estimate, PlanCheck } from '../api/types'
import type { Bridge } from '../hooks/useBridge'
import { roleLabel, resolveRouteDisplay } from '../lib/runGraph'
import { canDraftPlan, PLAN_ROLES } from '../lib/runState'
import { Button, Chip, inputClass, selectClass } from './primitives'

/** The editor keeps every check field as a string; the API gets the typed shape. */
type EditorCheck = {
  type: 'human' | 'command' | 'file'
  criterion: string
  command: string
  args: string
  expectExit: string | number
  path: string
  exists: boolean
  contains: string
  derived?: boolean
}

function toEditorCheck(check?: PlanCheck | null, acceptanceCheck?: string): EditorCheck {
  const base: EditorCheck = { type: 'human', criterion: acceptanceCheck ?? '', command: '', args: '', expectExit: 0, path: '', exists: true, contains: '' }
  if (check?.type === 'command') return { ...base, type: 'command', command: check.command, args: (check.args ?? []).join(' '), expectExit: check.expectExit ?? 0 }
  if (check?.type === 'file') return { ...base, type: 'file', path: check.path, exists: check.exists !== false, contains: check.contains ?? '' }
  if (check?.type === 'human') return { ...base, criterion: check.criterion, derived: check.derived }
  return base
}

export function PlanCard({ bridge }: { bridge: Bridge }) {
  const { plan, run } = bridge
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const [unlimitedAcknowledged, setUnlimitedAcknowledged] = useState(false)
  const [limit, setLimit] = useState('')
  const [verifierSteps, setVerifierSteps] = useState('3')
  const [objective, setObjective] = useState(plan?.plan.objective ?? '')
  const [tasks, setTasks] = useState(() => (plan?.tasks ?? []).map((task) => ({ ...task, dependencies: task.dependsOn.map((dep) => dep + 1).join(', '), check: toEditorCheck(task.check, task.acceptanceCheck) })))
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
    <section className="p-4 rounded-lg bg-surface-container space-y-3" aria-label="Execution plan">
      <p className="text-body-md text-on-surface-variant">{hasDirection ? 'Turn this direction into an executable plan. Review the tasks before starting work.' : 'Send a direction first, then draft a plan to review.'}</p>
      <Button variant="primary" disabled={busy || !hasDirection || !providersReady} onClick={() => void perform(() => bridge.draftPlan())}>{busy ? 'Drafting…' : 'Draft plan'}</Button>
    </section>
  ) : null

  // The estimate the human approved, from the chain: once it exists it wins
  // over the live recalculation, because what was promised at the decision is
  // the number this plan is accountable to.
  let recordedEstimate: Estimate | null = null
  for (let index = bridge.events.length - 1; index >= 0; index -= 1) {
    const event = bridge.events[index]
    if (event.type === 'plan.estimate' && event.payload?.planId === plan.plan.id) {
      recordedEstimate = (event.payload.estimate as Estimate | undefined) ?? null
      break
    }
  }
  const shownEstimate = recordedEstimate ?? bridge.estimate
  // A draft with no ceiling: approving it spends without a stop. The human
  // says so out loud, or sets a limit first — the approval is recorded either
  // way, and the event carries which one it was.
  const unlimited = !!run && run.budgetUsd === null

  return (
    <section className="bg-surface-container rounded-lg p-4 space-y-4 min-w-0" aria-label="Execution plan">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h2 className="text-label-lg font-semibold break-words">Plan: {plan.plan.objective}</h2>
        <Chip tone={plan.plan.status === 'approved' ? 'ok' : 'plan'}>v{plan.plan.version} · {plan.plan.status}</Chip>
      </div>
      {shownEstimate ? (
        <p className="font-mono text-label-sm text-outline">
          {shownEstimate.tasks} task(s) · ~{shownEstimate.expectedCalls} model calls
          {shownEstimate.estimateUsd
            ? ` · est. $${shownEstimate.estimateUsd.low.toFixed(2)}–$${shownEstimate.estimateUsd.high.toFixed(2)} (${shownEstimate.basis})`
            : ` · cost not estimable yet (${shownEstimate.basis})`}
          {recordedEstimate ? ' · recorded at approval' : ''}
        </p>
      ) : null}
      {editing ? (
        <form className="space-y-4" onSubmit={async (event) => {
          event.preventDefault()
          if (busy) return
          setError('')
          const parsed = tasks.map((task) => {
            const check = task.check.type === 'command'
              ? { type: 'command', command: task.check.command.trim(), args: task.check.args.trim() ? task.check.args.trim().split(/\s+/) : [], expectExit: Number(task.check.expectExit ?? 0) }
              : task.check.type === 'file'
                ? { type: 'file', path: task.check.path.trim(), exists: task.check.exists !== false, ...(task.check.contains.trim() ? { contains: task.check.contains.trim() } : {}) }
                : { type: 'human', criterion: task.check.criterion.trim() }
            return { role: task.role, title: task.title, instructions: task.instructions, check, dependsOn: task.dependencies.trim() ? task.dependencies.split(',').map((value) => Number(value.trim()) - 1) : [] }
          })
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
              <label className="flex flex-col gap-1 text-label-md">Task {index + 1} check type
                <select className={selectClass} value={task.check.type} onChange={(event) => {
                  const type = event.target.value
                  const blank = (type === 'command' ? { type: 'command' as const, command: '', args: '', expectExit: 0 } : type === 'file' ? { type: 'file' as const, path: '', exists: true, contains: '' } : { type: 'human' as const, criterion: '' })
                  const base: EditorCheck = { type: blank.type, criterion: '', command: '', args: '', expectExit: 0, path: '', exists: true, contains: '' }
                  const next: EditorCheck = { ...base, ...blank }
                  setTasks((current) => current.map((entry, i) => i === index ? { ...entry, check: next } : entry))
                }}>
                  <option value="human">Human-review criterion</option>
                  <option value="command">Runnable command</option>
                  <option value="file">File assertion</option>
                </select>
              </label>
              {task.check.type === 'command' ? (
                <>
                  <label className="flex flex-col gap-1 text-label-md">Task {index + 1} command<input className={inputClass} required value={task.check.command} onChange={(event) => setTasks((current) => current.map((entry, i) => i === index ? { ...entry, check: { ...entry.check, command: event.target.value } } : entry))} /></label>
                  <label className="flex flex-col gap-1 text-label-md">Task {index + 1} arguments<input className={inputClass} placeholder="Space-separated, e.g. test --silent" value={task.check.args} onChange={(event) => setTasks((current) => current.map((entry, i) => i === index ? { ...entry, check: { ...entry.check, args: event.target.value } } : entry))} /></label>
                  <label className="flex flex-col gap-1 text-label-md">Task {index + 1} expected exit code<input className={inputClass} type="number" value={task.check.expectExit} onChange={(event) => setTasks((current) => current.map((entry, i) => i === index ? { ...entry, check: { ...entry.check, expectExit: event.target.value } } : entry))} /></label>
                </>
              ) : task.check.type === 'file' ? (
                <>
                  <label className="flex flex-col gap-1 text-label-md">Task {index + 1} file path<input className={inputClass} required placeholder="Workspace-relative, e.g. out.txt" value={task.check.path} onChange={(event) => setTasks((current) => current.map((entry, i) => i === index ? { ...entry, check: { ...entry.check, path: event.target.value } } : entry))} /></label>
                  <label className="flex items-center gap-2 text-label-md"><input type="checkbox" checked={task.check.exists !== false} onChange={(event) => setTasks((current) => current.map((entry, i) => i === index ? { ...entry, check: { ...entry.check, exists: event.target.checked } } : entry))} /> Must exist</label>
                  <label className="flex flex-col gap-1 text-label-md">Task {index + 1} contains (optional)<input className={inputClass} value={task.check.contains} onChange={(event) => setTasks((current) => current.map((entry, i) => i === index ? { ...entry, check: { ...entry.check, contains: event.target.value } } : entry))} /></label>
                </>
              ) : (
                <label className="flex flex-col gap-1 text-label-md">Task {index + 1} criterion<textarea className={inputClass} rows={2} value={task.check.criterion} onChange={(event) => setTasks((current) => current.map((entry, i) => i === index ? { ...entry, check: { ...entry.check, criterion: event.target.value } } : entry))} /></label>
              )}
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
            const live = bridge.tasks.find((entry) => entry.planTaskId === task.id)
            const status = live?.status ?? 'queued'
            const verdict = live ? bridge.verdicts.find((entry) => entry.taskId === live.id) : undefined
            return (
              <li key={task.id} className="space-y-1 p-3 bg-surface-container-lowest rounded-lg">
                <div className="flex justify-between items-start gap-2">
                  <h3 className="text-body-md font-medium">{index + 1}. {task.title}</h3>
                  <span className="flex items-center gap-1.5 flex-wrap justify-end">
                    <Chip tone={status === 'completed' ? 'ok' : status === 'failed' ? 'bad' : 'idle'}>{status}</Chip>
                    {verdict ? (
                      <Chip tone={verdict.overall === 'PASS' ? 'ok' : verdict.overall === 'FAIL' ? 'bad' : 'busy'}>
                        {verdict.overall === 'PASS' ? 'verified' : verdict.overall === 'FAIL' ? 'refuted' : 'unproven'}
                      </Chip>
                    ) : null}
                  </span>
                </div>
                <p className="text-label-sm text-primary">{roleLabel(task.role)} · {resolveRouteDisplay(routing, bridge.providers, task.role) ?? 'default provider'}</p>
                <p className="text-body-sm whitespace-pre-wrap break-words">{task.instructions}</p>
                <p className="text-label-sm text-outline">
                  Acceptance{task.check ? ` · ${task.check.type} check${task.check.derived ? ' · derived from the task — review it' : ''}` : ' · legacy plan, no typed check'}
                </p>
                <p className="text-body-sm whitespace-pre-wrap break-words">{task.acceptanceCheck || 'No explicit acceptance check.'}</p>
                {task.dependsOn.length ? <p className="text-label-sm text-outline">After task {task.dependsOn.map((dep) => dep + 1).join(', ')}</p> : null}
              </li>
            )
          })}
        </ol>
      )}
      {!editing && plannable && plan.plan.status === 'draft' ? (
        <div className="flex items-end gap-3 flex-wrap">
          <p className="text-label-md text-outline min-w-0">
            Reviewer: {routing.reviewer?.trim() ? resolveRouteDisplay(routing, bridge.providers, 'reviewer') ?? routing.reviewer : 'same as the worker\u2019s route — an independent reviewer is recommended'}
          </p>
          <label className="flex flex-col gap-1 text-label-md">Verifier steps
            <input className={inputClass} type="number" min={1} max={50} value={verifierSteps} onChange={(event) => setVerifierSteps(event.target.value)} title="How many read-only steps the verifier may take per task (1–50)" />
          </label>
        </div>
      ) : null}
      {!editing && plannable && plan.plan.status === 'draft' && unlimited ? (
        <div role="note" className="p-3 rounded-lg bg-surface-container-lowest space-y-3">
          <p className="text-body-sm">This run has no spending limit. Model calls keep going until the plan finishes, and only you can stop a runaway.</p>
          <div className="flex items-end gap-2 flex-wrap">
            <label className="flex flex-col gap-1 text-label-md">Set a limit ($)
              <input className={inputClass} type="number" min="0" step="0.01" value={limit} onChange={(event) => setLimit(event.target.value)} />
            </label>
            <Button disabled={busy || !(Number(limit) > 0)} onClick={() => void perform(async () => { if (await bridge.control('set-budget', { budgetUsd: Number(limit) })) setLimit('') })}>Set limit</Button>
          </div>
          <label className="flex items-center gap-2 text-body-sm">
            <input type="checkbox" checked={unlimitedAcknowledged} onChange={(event) => setUnlimitedAcknowledged(event.target.checked)} />
            Approve without a limit — I understand the run can keep spending.
          </label>
        </div>
      ) : null}
      {!editing && plannable ? (
        <div className="flex gap-2 flex-wrap">
          {plan.plan.status === 'draft' ? <Button variant="primary" disabled={busy || !providersReady || (unlimited && !unlimitedAcknowledged)} onClick={() => void perform(() => bridge.control('approve-plan', { planId: plan.plan.id, planHash: plan.plan.contentHash, ...(unlimited ? { unlimitedAcknowledged: true } : {}), ...(Number(verifierSteps) >= 1 ? { verificationSteps: Number(verifierSteps) } : {}) }))}>Approve & Run</Button> : null}
          <Button disabled={busy} onClick={() => {
            setObjective(plan.plan.objective)
            setTasks(plan.tasks.map((task) => ({ ...task, dependencies: task.dependsOn.map((dep) => dep + 1).join(', '), check: toEditorCheck(task.check, task.acceptanceCheck) })))
            setEditing(true)
          }}>Edit plan</Button>
          <Button disabled={busy || !providersReady} onClick={() => void perform(() => bridge.draftPlan({ regenerate: true }))}>{busy ? 'Working…' : 'Redraft'}</Button>
        </div>
      ) : null}
      <details className="text-label-sm text-outline"><summary className="cursor-pointer">Plan identity and permissions</summary><p className="break-all font-mono mt-2">{plan.plan.contentHash}</p><p className="mt-1">Permission mode: {run?.permissionMode ?? 'selective'}. Editing creates a new version that needs approval.</p></details>
    </section>
  )
}
