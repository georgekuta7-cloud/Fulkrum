import type { Bridge } from '../hooks/useBridge'

export function Header({ bridge, onOpenSettings }: { bridge: Bridge; onOpenSettings: () => void }) {
  const run = bridge.run
  const spend = bridge.spend
  const ceiling = run?.budgetUsd ?? bridge.estimate?.ceilingUsd ?? 2
  const spent = spend?.costUsd ?? 0
  const project = bridge.projects.find((p: any) => p.id === bridge.projectId)

  return (
    <header className="m3-header">
      <div className="m3-header-inner">
        <div className="m3-header-left">
          <span className="m3-brand">Fulkrum</span>
          <div className="m3-path">
            <span className="material-symbols-outlined">folder</span>
            <span className="m3-path-truncate">{project?.name ?? 'No project'}</span>
            {run && <span className="m3-path-port">:8787</span>}
          </div>
        </div>
        <div className="m3-header-right">
          <div className="m3-spend">
            <span className="m3-spend-label">Spend</span>
            <span className="m3-spend-value">${spent.toFixed(2)}</span>
            <span className="m3-spend-sep">/</span>
            <span className="m3-spend-ceiling">${ceiling.toFixed(2)}</span>
          </div>
          {run && (
            <div style={{ display: 'flex', gap: 4 }}>
              {run.status === 'paused' && (
                <button className="m3-icon-btn icon-only" title="Resume" onClick={() => void bridge.control('resume')} type="button">
                  <span className="material-symbols-outlined">play_arrow</span>
                </button>
              )}
              {['executing', 'planning'].includes(run.status) && (
                <button className="m3-icon-btn icon-only" title="Pause" onClick={() => void bridge.control('pause')} type="button">
                  <span className="material-symbols-outlined">pause</span>
                </button>
              )}
              {!['cancelled', 'completed', 'review'].includes(run.status) && (
                <button className="m3-icon-btn icon-only" title="Stop" onClick={() => void bridge.control('cancel')} type="button">
                  <span className="material-symbols-outlined">stop</span>
                </button>
              )}
            </div>
          )}
          <button className="m3-icon-btn icon-only" title="Settings" onClick={onOpenSettings} type="button">
            <span className="material-symbols-outlined">tune</span>
          </button>
        </div>
      </div>
    </header>
  )
}
