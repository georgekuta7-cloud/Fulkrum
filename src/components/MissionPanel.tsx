import { useState } from 'react'
import { Check, FilePen, Plus, RefreshCw, Trash2, Search, Hammer, Compass, Pen, Bug } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'
import { ALL_ROLES, ROLE_INFO } from '../lib/constants'
import { ProviderSelect } from './ProviderSelect'

const ICONS: Record<string, any> = { Search, Hammer, Compass, Pen, Bug }

export function MissionPanel({ bridge }: { bridge: Bridge }) {
  const { plan, run, estimate, draftPlan, editPlan, control } = bridge
  const [editing, setEditing] = useState(false)
  const [objective, setObjective] = useState('')
  const [tasks, setTasks] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const shown = editing ? tasks : (plan?.tasks ?? [])
  const approved = plan?.plan.status === 'approved'
  const canApprove = ['planning', 'review', 'interrupted'].includes(run?.status ?? '') && !approved

  const startEditing = () => {
    if (!plan) return
    setObjective(plan.plan.objective)
    setTasks(plan.tasks.map((t: any) => ({ role: t.role, title: t.title, instructions: t.instructions, acceptanceCheck: t.acceptanceCheck ?? '', dependsOn: t.dependsOn ?? [] })))
    setEditing(true)
  }

  const save = async () => {
    setBusy(true)
    const ok = await editPlan(objective, tasks.map((t: any) => ({ ...t, dependsOn: t.dependsOn })))
    setBusy(false)
    if (ok) setEditing(false)
  }

  return (
    <aside className="mission-panel">
      <div className="mission-header">
        <span className="micro-label">Mission</span>
      </div>
      {!plan ? (
        <div className="mission-empty">
          <p>No plan yet. Draft one to see what the workers would do.</p>
          <button className="btn btn-primary" onClick={() => void draftPlan()}>Draft a plan</button>
        </div>
      ) : (
        <>
          <div className="mission-objective">
            {editing ? (
              <textarea className="input" rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Objective" />
            ) : (
              <h2 className="mission-title">{plan.plan.objective}</h2>
            )}
            <div className="mission-meta">
              <span className={`chip ${approved ? 'chip-ok' : 'chip-idle'}`}>v{plan.plan.version} {plan.plan.status}</span>
              <span className="mono tiny muted">{plan.plan.contentHash?.slice(0, 8)}</span>
            </div>
          </div>

          <div className="mission-section">
            <span className="micro-label">Workers</span>
            <div className="mission-workers">
              {ALL_ROLES.map((role) => {
                const info = ROLE_INFO[role]
                const Icon = ICONS[info.icon]
                return (
                  <div key={role} className="mission-worker">
                    <div className="mission-worker-head">
                      <Icon size={14} className="mission-worker-icon" />
                      <span className="mission-worker-label">{info.label}</span>
                      <ProviderSelect bridge={bridge} role={role} label="" />
                    </div>
                    <div className="mission-worker-sub">{info.subtitle}</div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="mission-section">
            <span className="micro-label">Plan</span>
            <div className="mission-actions">
              {editing ? (
                <>
                  <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
                </>
              ) : (
                <>
                  <button className="btn btn-ghost btn-sm" onClick={startEditing}><FilePen size={12} /> Edit</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => void draftPlan({ regenerate: true })}><RefreshCw size={12} /> Redraft</button>
                  {canApprove && <button className="btn btn-primary btn-sm" onClick={() => void control('approve-plan', { planId: plan.plan.id, planHash: plan.plan.contentHash })}><Check size={12} /> Approve</button>}
                </>
              )}
            </div>
            <div className="mission-tasks">
              {shown.map((task: any, i: number) => {
                const taskData = bridge.tasks?.find((t: any) => t.planTaskId === task.id)
                const state = taskData?.status === 'completed' ? 'done' : taskData?.status === 'running' ? 'active' : ''
                return (
                  <div key={i} className={`mission-task ${state}`}>
                    <span className="mission-task-num">{state === 'done' ? '✓' : i + 1}</span>
                    {editing ? (
                      <input className="input" value={task.title} onChange={(e) => setTasks((cur) => cur.map((t, at) => at === i ? { ...t, title: e.target.value } : t))} />
                    ) : (
                      <span className="mission-task-title">{task.title}</span>
                    )}
                    {editing && shown.length > 1 && (
                      <button className="btn btn-ghost btn-sm" aria-label="Remove task" onClick={() => setTasks((cur) => cur.filter((_, at) => at !== i))}><Trash2 size={11} /></button>
                    )}
                  </div>
                )
              })}
            </div>
            {editing && (
              <button className="btn btn-ghost btn-sm" disabled={shown.length >= 8} onClick={() => setTasks((cur) => [...cur, { role: 'research', title: '', instructions: '', acceptanceCheck: '', dependsOn: [] }])}>
                <Plus size={12} /> Add task {shown.length >= 8 ? '(limit)' : ''}
              </button>
            )}
          </div>

          {estimate?.estimateUsd && (
            <div className="mission-section">
              <span className="micro-label">Estimate</span>
              <div className="mission-estimate">${estimate.estimateUsd.low?.toFixed(2)} – ${estimate.estimateUsd.high?.toFixed(2)}</div>
            </div>
          )}
        </>
      )}
    </aside>
  )
}
