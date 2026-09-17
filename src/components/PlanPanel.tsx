import { useState } from 'react'
import { Check, FilePen, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'

/**
 * The plan: what the run will do, and the place it can be changed before it does.
 *
 * An edit goes through the same validation the model's own output gets and produces a
 * new version with a new hash, so an approval always attaches to the version that was
 * on screen. The estimate is shown with its basis, because a number without its
 * reasoning is a guess dressed up.
 */

const roles = ['research', 'builder']

type DraftTask = { role: string; title: string; instructions: string; acceptanceCheck: string; dependsOn: number[] }

export function PlanPanel({ bridge }: { bridge: Bridge }) {
  const { plan, run, estimate, draftPlan, editPlan, control } = bridge
  const [editing, setEditing] = useState(false)
  const [objective, setObjective] = useState('')
  const [tasks, setTasks] = useState<DraftTask[]>([])
  const [busy, setBusy] = useState(false)

  /** Start from what the plan says now, rather than syncing through an effect. */
  const startEditing = () => {
    if (!plan) return
    setObjective(plan.plan.objective)
    setTasks(plan.tasks.map((task) => ({ role: task.role, title: task.title, instructions: task.instructions, acceptanceCheck: task.acceptanceCheck ?? '', dependsOn: task.dependsOn ?? [] })))
    setEditing(true)
  }

  // What is on screen: the plan itself, or the draft while it is being edited.
  // Deriving it is what keeps the view from showing an empty list just because a
  // draft has not been seeded — the bug this had when the draft was the only source.
  const shown: DraftTask[] = editing
    ? tasks
    : (plan?.tasks ?? []).map((task) => ({ role: task.role, title: task.title, instructions: task.instructions, acceptanceCheck: task.acceptanceCheck ?? '', dependsOn: task.dependsOn ?? [] }))

  if (!plan) {
    return (
      <div className="panel-empty">
        <p>This run has no plan yet. Draft one to see exactly what the workers would do before you approve it.</p>
        <button type="button" className="primary" onClick={() => void draftPlan()}>Draft a plan</button>
      </div>
    )
  }

  const approved = plan.plan.status === 'approved'
  // Paused is deliberately absent: the bridge refuses approve-plan from a
  // paused run, so offering the button would only produce a 409.
  const canApprove = ['planning', 'review', 'interrupted'].includes(run?.status ?? '') && !approved

  const save = async () => {
    setBusy(true)
    const ok = await editPlan(objective, tasks.map((task) => ({ ...task, dependsOn: task.dependsOn })))
    setBusy(false)
    if (ok) setEditing(false)
  }

  return (
    <div className="plan-panel">
      <div className="plan-head">
        <div>
          <span className={`status-chip ${approved ? 'ok' : 'idle'}`}>v{plan.plan.version} · {plan.plan.status}</span>
          <span className="muted">{plan.plan.source === 'model' ? 'written by the model' : plan.plan.source === 'edited' ? 'edited by you' : 'template'}</span>
          <span className="muted tiny">hash {plan.plan.contentHash.slice(0, 12)}…</span>
        </div>
        <div className="plan-actions">
          {editing ? (
            <>
              <button type="button" className="primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save plan'}</button>
              <button type="button" onClick={() => setEditing(false)}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" onClick={startEditing}><FilePen size={13} /> Edit</button>
              <button type="button" onClick={() => void draftPlan({ regenerate: true })}><RefreshCw size={13} /> Redraft</button>
              {canApprove ? (
                <button type="button" className="primary" onClick={() => void control('approve-plan', { planId: plan.plan.id, planHash: plan.plan.contentHash })}>
                  <Check size={14} /> Approve &amp; run
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {estimate ? (
        <p className="estimate">
          {estimate.estimateUsd
            ? <>Expected cost <strong>${estimate.estimateUsd.low.toFixed(4)}–${estimate.estimateUsd.high.toFixed(4)}</strong> for {estimate.expectedCalls} call(s) across {estimate.tasks} task(s). <span className="muted">{estimate.basis}.</span></>
            : <><TriangleAlert size={13} /> No cost estimate: <span className="muted">{estimate.basis}.</span></>}
        </p>
      ) : null}

      {plan.fallbackReason ? <p className="warning"><TriangleAlert size={13} /> {plan.fallbackReason}</p> : null}

      {editing ? (
        <label className="objective-edit">
          <span>Objective</span>
          <textarea rows={2} value={objective} onChange={(event) => setObjective(event.target.value)} />
        </label>
      ) : (
        <h3 className="objective">{plan.plan.objective}</h3>
      )}

      <ol className="plan-tasks">
        {shown.map((task, index) => (
          <li className="plan-task" key={index}>
            <div className="plan-task-head">
              {editing ? (
                <select value={task.role} onChange={(event) => setTasks((current) => current.map((entry, at) => (at === index ? { ...entry, role: event.target.value } : entry)))}>
                  {roles.map((role) => <option key={role} value={role}>{role}</option>)}
                </select>
              ) : (
                <span className={`role-chip ${task.role}`}>{task.role}</span>
              )}
              <span className="task-index">{index + 1}</span>
              {editing ? (
                <input value={task.title} onChange={(event) => setTasks((current) => current.map((entry, at) => (at === index ? { ...entry, title: event.target.value } : entry)))} />
              ) : (
                <strong>{task.title}</strong>
              )}
              {editing && shown.length > 1 ? (
                <button type="button" className="icon danger" title="Remove this task" onClick={() => setTasks((current) => current.filter((_, at) => at !== index).map((entry) => ({ ...entry, dependsOn: entry.dependsOn.filter((dependency) => dependency !== index).map((dependency) => (dependency > index ? dependency - 1 : dependency)) })))}>
                  <Trash2 size={13} />
                </button>
              ) : null}
            </div>

            {editing ? (
              <textarea rows={3} value={task.instructions} onChange={(event) => setTasks((current) => current.map((entry, at) => (at === index ? { ...entry, instructions: event.target.value } : entry)))} />
            ) : (
              <p className="task-instructions">{task.instructions}</p>
            )}

            {editing ? (
              <div className="task-deps">
                <span className="muted tiny">after:</span>
                {index === 0 ? <span className="muted tiny">nothing — it starts first</span> : shown.slice(0, index).map((candidate, candidateIndex) => (
                  <label key={candidateIndex} className="dep-check" title={candidate.title || `task ${candidateIndex + 1}`}>
                    <input
                      type="checkbox"
                      checked={task.dependsOn.includes(candidateIndex)}
                      onChange={(event) => setTasks((current) => current.map((entry, at) => (at === index
                        ? { ...entry, dependsOn: event.target.checked ? [...entry.dependsOn, candidateIndex].sort((left, right) => left - right) : entry.dependsOn.filter((dependency) => dependency !== candidateIndex) }
                        : entry)))}
                    />
                    {candidateIndex + 1}
                  </label>
                ))}
              </div>
            ) : task.dependsOn.length ? (
              <p className="muted tiny">after {task.dependsOn.map((dependency) => dependency + 1).join(', ')}{task.acceptanceCheck ? ` · acceptance: ${task.acceptanceCheck}` : ''}</p>
            ) : task.acceptanceCheck ? <p className="muted tiny">acceptance: {task.acceptanceCheck}</p> : null}
          </li>
        ))}
      </ol>

      {editing ? (
        <button type="button" className="add-task" disabled={shown.length >= 8} onClick={() => setTasks((current) => [...current, { role: 'research', title: '', instructions: '', acceptanceCheck: '', dependsOn: [] }])}>
          <Plus size={13} /> Add a task {shown.length >= 8 ? '(limit reached)' : ''}
        </button>
      ) : null}
    </div>
  )
}
