import { useState } from 'react'
import type { Bridge } from '../hooks/useBridge'

export function ContextPanel({ bridge }: { bridge: Bridge }) {
  const [tab, setTab] = useState<'plan' | 'files' | 'spend'>('plan')
  const plan = bridge.plan
  const byTask = bridge.byTask ?? []
  const artifacts = bridge.artifacts ?? []

  return (
    <aside className="context-panel">
      <div className="context-tabs">
        <button className={`context-tab ${tab === 'plan' ? 'active' : ''}`} onClick={() => setTab('plan')}>Plan</button>
        <button className={`context-tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>Files</button>
        <button className={`context-tab ${tab === 'spend' ? 'active' : ''}`} onClick={() => setTab('spend')}>Spend</button>
      </div>
      <div className="context-content">
        {tab === 'plan' && (
          <>
            <div className="ctx-section">
              <div className="ctx-label">Objective</div>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 'var(--text-sub)', fontWeight: 600, marginBottom: 'var(--sp-3)' }}>{plan?.plan.objective || 'No plan yet'}</div>
              {plan && (
                <div style={{ display: 'flex', gap: 'var(--sp-2)', marginBottom: 'var(--sp-4)' }}>
                  <span className={`chip ${plan.plan.status === 'approved' ? 'chip-ok' : 'chip-plan'}`}>v{plan.plan.version} {plan.plan.status}</span>
                  <span className="chip chip-idle">{plan.plan.contentHash?.slice(0, 8)}</span>
                </div>
              )}
            </div>
            <div className="ctx-section">
              <div className="ctx-label">Tasks</div>
              {plan?.tasks?.map((t: any, i: number) => {
                const task = bridge.tasks?.find((r: any) => r.planTaskId === t.id)
                const state = task?.status === 'completed' ? 'done' : task?.status === 'running' ? 'active' : ''
                return (
                  <div key={t.id} className={`plan-task ${state}`}>
                    <div className="plan-task-num">{state === 'done' ? '✓' : i + 1}</div>
                    <div className="plan-task-text">{t.title}</div>
                  </div>
                )
              })}
            </div>
            {bridge.estimate?.estimateUsd && (
              <div className="ctx-section">
                <div className="ctx-label">Cost Estimate</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 600, color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>
                  ${bridge.estimate.estimateUsd.low?.toFixed(2)} – ${bridge.estimate.estimateUsd.high?.toFixed(2)}
                </div>
                <div className="micro-label">Estimated range</div>
              </div>
            )}
          </>
        )}
        {tab === 'files' && (
          <div className="ctx-section">
            <div className="ctx-label">Files Touched</div>
            {artifacts.length === 0 && <div style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>Nothing written yet.</div>}
            {artifacts.map((a: any) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: '5px 0', fontSize: 'var(--text-small)' }}>
                <span style={{ color: 'var(--muted)', fontSize: 'var(--text-tiny)' }}>{a.path?.split('.').pop()?.toUpperCase()}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.path}</span>
                <span style={{ color: 'var(--ok)' }}>+{a.added ?? 0}</span>
                <span style={{ color: 'var(--bad)' }}>-{a.removed ?? 0}</span>
              </div>
            ))}
          </div>
        )}
        {tab === 'spend' && (
          <div className="ctx-section">
            <div className="ctx-label">Spend · ${(bridge.spend?.costUsd ?? 0).toFixed(2)}</div>
            {byTask.length === 0 && <div style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>No calls yet.</div>}
            {byTask.map((t: any) => (
              <div key={t.taskId ?? 'super'} style={{ display: 'flex', justifyContent: 'space-between', padding: 'var(--sp-2) 0', borderBottom: '1px solid var(--line)', fontSize: 'var(--text-small)' }}>
                <span style={{ color: 'var(--muted)' }}>{t.title || 'supervisor'} · {t.agentId}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>${(t.costUsd ?? 0).toFixed(4)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
