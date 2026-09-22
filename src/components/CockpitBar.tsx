import { Moon, Pause, Play, Settings2, Square, Sun, Bell } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'
import { statusTone } from '../lib/constants'

export function CockpitBar({ bridge, theme, onToggleTheme, onOpenSettings }: {
  bridge: Bridge
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onOpenSettings: () => void
}) {
  const run = bridge.run
  const spend = bridge.spend
  const ceiling = run?.budgetUsd ?? bridge.estimate?.ceilingUsd ?? null
  const spent = spend?.costUsd ?? 0
  const fill = ceiling ? Math.min((spent / ceiling) * 100, 100) : 0
  const tasks = bridge.tasks ?? []
  const done = tasks.filter((t) => t.status === 'completed').length
  const title = bridge.plan?.plan.objective || bridge.messages?.at(-1)?.content?.slice(0, 60) || run?.id || ''
  const approvalCount = bridge.approval ? 1 : 0
  const tone = run ? statusTone(run.status) : 'idle'

  return (
    <header className="cockpit-bar">
      <span className="cockpit-brand">FULKRUM</span>
      <span className="cockpit-sep" />
      {run ? (
        <>
          <span className="cockpit-run" title={title}>{run.id.slice(0, 12)}</span>
          <span className={`chip chip-${tone}`}>{run.status.replaceAll('_', ' ')}</span>
          <span className="cockpit-tasks">{done}/{tasks.length || '0'}</span>
          {ceiling ? (
            <button className="cockpit-budget" aria-label={`Spend $${spent.toFixed(2)} of $${ceiling.toFixed(2)}`}>
              <span className="cockpit-budget-bar">
                <span className="cockpit-budget-fill" style={{ width: `${fill}%` }} />
              </span>
              <span className="cockpit-budget-text"><strong>${spent.toFixed(2)}</strong>/${ceiling.toFixed(2)}</span>
            </button>
          ) : <span className="cockpit-spacer" />}
          {approvalCount > 0 && (
            <span className="cockpit-bell" aria-label={`${approvalCount} approval needed`}>
              <Bell size={14} />
              <span className="cockpit-bell-count">{approvalCount}</span>
            </span>
          )}
          <span className="cockpit-sep" />
          {run.status === 'paused' && <button className="cockpit-btn" aria-label="Resume" onClick={() => void bridge.control('resume')}><Play size={14} /></button>}
          {['executing', 'planning'].includes(run.status) && <button className="cockpit-btn" aria-label="Pause" onClick={() => void bridge.control('pause')}><Pause size={14} /></button>}
          {!['cancelled', 'completed', 'review'].includes(run.status) && <button className="cockpit-btn cockpit-btn-danger" aria-label="Stop" onClick={() => void bridge.control('cancel')}><Square size={14} /></button>}
        </>
      ) : <span className="cockpit-spacer" />}
      <button className="cockpit-btn" aria-label="Settings" onClick={onOpenSettings}><Settings2 size={14} /></button>
      <button className="cockpit-btn" aria-label="Toggle theme" onClick={onToggleTheme}>{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}</button>
    </header>
  )
}
