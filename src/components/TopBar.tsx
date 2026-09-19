import { useEffect, useRef, useState } from 'react'
import { Activity, ChevronDown, Coins, FileDiff, FolderTree, GitFork, ListChecks, Moon, MoreHorizontal, Pause, Play, Settings2, Square, Sun, TriangleAlert } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'
import { money, statusTone } from '../lib/tones'

/**
 * The one bar that is always on screen: what the run is, what state it is in,
 * what it has spent against its ceiling, and where the work is shown. Everything
 * else — the controls, the downloads, the secondary views — lives in the menu,
 * because a control you use twice a day does not deserve permanent pixels.
 */

export type CenterView = 'graph' | 'chat'
export type InspectorTab = 'plan' | 'activity' | 'artifacts' | 'files'

function SpendBreakdown({ bridge }: { bridge: Bridge }) {
  const { spend, byTask } = bridge
  return (
    <div className="spend-breakdown">
      <div className="popover-row"><span>Total</span><strong>{money(spend.costUsd)}</strong></div>
      <div className="popover-row"><span>Calls</span><strong>{spend.calls}</strong></div>
      {spend.unpricedCalls > 0 ? (
        <p className="popover-note warn"><TriangleAlert size={12} /> {spend.unpricedCalls} call(s) used a model with no known price — the total is a lower bound.</p>
      ) : null}
      {byTask.length ? (
        <table className="mini-table">
          <thead><tr><th>task</th><th>calls</th><th>cost</th></tr></thead>
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

export function TopBar({ bridge, view, onViewChange, onOpenInspector, onOpenSettings, theme, onToggleTheme }: {
  bridge: Bridge
  view: CenterView
  onViewChange: (view: CenterView) => void
  onOpenInspector: (tab: InspectorTab) => void
  onOpenSettings: () => void
  theme: 'dark' | 'light'
  onToggleTheme: () => void
}) {
  const { run, plan, tasks, status, spend, estimate, control, approval, messages } = bridge
  const [menuOpen, setMenuOpen] = useState(false)
  const [spendOpen, setSpendOpen] = useState(false)
  const [budgetDraft, setBudgetDraft] = useState('')
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // Popovers close on any outside click — a toggle that only its button closes
  // is a trap you have to remember the way out of.
  useEffect(() => {
    if (!menuOpen && !spendOpen) return
    const close = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
        setSpendOpen(false)
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuOpen, spendOpen])

  if (!run) {
    return <header className="topbar"><span className="muted">fulkrum</span></header>
  }

  const done = tasks.filter((task) => task.status === 'completed').length
  const title = plan?.plan.objective ?? messages.filter((message) => message.role === 'user').at(-1)?.content ?? run.id
  const ceiling = run.budgetUsd ?? estimate?.ceilingUsd ?? null
  const fill = ceiling ? Math.min(100, (spend.costUsd / ceiling) * 100) : 0
  const engine = status?.execution
  const breakers = (status?.providers ?? []).filter((provider) => provider.breaker?.open)

  return (
    <header className="topbar" ref={wrapRef}>
      <span className="topbar-title" title={title}>{title}</span>
      <span className={`status-chip ${statusTone(run.status)}`}>{run.status.replaceAll('_', ' ')}</span>
      <span className="muted tiny">{done}/{tasks.length || '0'} tasks</span>

      <span className="topbar-spacer" />

      <button type="button" className="budget-meter" onClick={() => { setBudgetDraft(String(run.budgetUsd ?? '')); setSpendOpen((open) => !open); setMenuOpen(false) }} aria-expanded={spendOpen} title="Spend against the ceiling — opens the breakdown">
        <Coins size={13} />
        <span className="mono">{money(spend.costUsd, 4)}{ceiling ? ` / ${money(ceiling, 2)}` : ''}</span>
        {ceiling ? <span className="meter"><i style={{ width: `${fill}%` }} /></span> : null}
        {spend.unpricedCalls ? <span className="metric-flag">+{spend.unpricedCalls}</span> : null}
        <ChevronDown size={12} />
      </button>

      <span className={`status-chip ${engine?.available ? 'ok' : 'bad'}`} title={engine?.available ? `${engine.label} ${engine.version ?? ''} · ${engine.image ?? ''}` : engine?.reason ?? 'No container engine'}>
        {engine?.available ? '⛁ docker' : 'no engine'}
      </span>
      {breakers.length ? (
        <span className="status-chip bad" title={breakers.map((provider) => provider.label).join(', ')}>{breakers.length} provider(s) skipped</span>
      ) : null}

      <div className="view-toggle" role="tablist" aria-label="Center view">
        <button type="button" role="tab" aria-selected={view === 'graph'} className={view === 'graph' ? 'on' : ''} onClick={() => onViewChange('graph')}>◈ Graph</button>
        <button type="button" role="tab" aria-selected={view === 'chat'} className={view === 'chat' ? 'on' : ''} onClick={() => onViewChange('chat')}>
          💬 Chat {approval ? <span className="attn-dot" title="A decision is waiting" /> : null}
        </button>
      </div>

      <div className="menu-wrap">
        <button type="button" className="icon topbar-menu-button" onClick={() => { setMenuOpen((open) => !open); setSpendOpen(false) }} aria-expanded={menuOpen} title="Run controls and views">
          <MoreHorizontal size={16} />
        </button>
        {menuOpen ? (
          <div className="menu" role="menu">
            {run.status === 'paused' ? <button type="button" onClick={() => void control('resume')}><span><Play size={13} /> Resume</span></button> : null}
            {['executing', 'planning'].includes(run.status) ? <button type="button" onClick={() => void control('pause')}><span><Pause size={13} /> Pause</span></button> : null}
            {!['cancelled', 'completed', 'review'].includes(run.status) ? <button type="button" className="danger" onClick={() => void control('cancel')}><span><Square size={13} /> Stop</span></button> : null}
            <button type="button" onClick={() => void bridge.forkRun()}><span><GitFork size={13} /> Fork run</span></button>
            <div className="menu-sep" />
            <button type="button" onClick={() => { onOpenInspector('plan'); setMenuOpen(false) }}><span><ListChecks size={13} /> Plan &amp; tasks</span><kbd>⌃1</kbd></button>
            <button type="button" onClick={() => { onOpenInspector('activity'); setMenuOpen(false) }}><span><Activity size={13} /> Activity</span><kbd>⌃2</kbd></button>
            <button type="button" onClick={() => { onOpenInspector('artifacts'); setMenuOpen(false) }}><span><FileDiff size={13} /> Artifacts</span><kbd>⌃3</kbd></button>
            <button type="button" onClick={() => { onOpenInspector('files'); setMenuOpen(false) }}><span><FolderTree size={13} /> Workspace</span><kbd>⌃4</kbd></button>
            <div className="menu-sep" />
            <a href={`/api/runs/${encodeURIComponent(run.id)}/report?format=md`} target="_blank" rel="noreferrer"><span>Report</span><span className="muted">↓ md</span></a>
            <a href={`/api/runs/${encodeURIComponent(run.id)}/bundle`}><span>Bundle</span><span className="muted">↓ zip</span></a>
            <div className="menu-sep" />
            <button type="button" onClick={() => { onOpenSettings(); setMenuOpen(false) }}><span><Settings2 size={13} /> Settings</span></button>
            <button type="button" onClick={onToggleTheme}><span>{theme === 'dark' ? <Moon size={13} /> : <Sun size={13} />} Theme: {theme}</span></button>
          </div>
        ) : null}
      </div>

      {spendOpen ? (
        <div className="popover topbar-spend">
          <SpendBreakdown bridge={bridge} />
          <div className="popover-actions">
            <input value={budgetDraft} inputMode="decimal" placeholder="Ceiling USD, empty for none" onChange={(event) => setBudgetDraft(event.target.value)} />
            <button type="button" className="primary" onClick={() => { void control('set-budget', { budgetUsd: budgetDraft === '' ? null : Number(budgetDraft) }); setSpendOpen(false) }}>Set</button>
          </div>
        </div>
      ) : null}
    </header>
  )
}
