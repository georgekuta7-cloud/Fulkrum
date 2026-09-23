import type { Bridge } from '../hooks/useBridge'

export function Header({ bridge, onOpenSettings }: { bridge: Bridge; onOpenSettings: () => void }) {
  const run = bridge.run
  const spend = bridge.spend
  // No invented ceiling: when nothing is set, show what was spent, not a
  // made-up limit. A fabricated cap on the status bar is exactly the kind of
  // number this product refuses to print.
  const ceiling = run?.budgetUsd ?? bridge.estimate?.ceilingUsd ?? null
  const spent = spend?.costUsd ?? 0
  const project = bridge.projects.find((p: any) => p.id === bridge.projectId)

  return (
    <header className="fixed top-0 left-0 right-0 z-40 bg-surface-dim/80 backdrop-blur-xl border-b border-outline-variant/20">
      <div className="h-14 px-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-secondary-container/40 flex items-center justify-center border border-outline-variant/30 glow-primary">
            <span className="material-symbols-outlined text-primary text-lg">hub</span>
          </div>
          <span className="text-headline-md font-semibold tracking-tight text-primary">Fulkrum</span>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-container text-label-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-sm text-secondary">folder</span>
            <span className="truncate max-w-[200px]">{project?.name ?? 'No project'}</span>
            {run && <span className="text-secondary text-[11px]">:8787</span>}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-container text-label-lg">
            <span className="text-on-surface-variant">Spend</span>
            <span className="text-tertiary font-medium">${spent.toFixed(2)}</span>
            {ceiling !== null && (
              <>
                <span className="text-secondary">/</span>
                <span className="text-on-surface-variant">${ceiling.toFixed(2)}</span>
              </>
            )}
          </div>
          {run && (
            <div className="flex items-center gap-1">
              {run.status === 'paused' && (
                <button className="w-8 h-8 rounded flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors" title="Resume" onClick={() => void bridge.control('resume')}>
                  <span className="material-symbols-outlined">play_arrow</span>
                </button>
              )}
              {['executing', 'planning'].includes(run.status) && (
                <button className="w-8 h-8 rounded flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors" title="Pause" onClick={() => void bridge.control('pause')}>
                  <span className="material-symbols-outlined">pause</span>
                </button>
              )}
              {!['cancelled', 'completed', 'review'].includes(run.status) && (
                <button className="w-8 h-8 rounded flex items-center justify-center text-error hover:bg-error-container/30 transition-colors" title="Stop" onClick={() => void bridge.control('cancel')}>
                  <span className="material-symbols-outlined">stop</span>
                </button>
              )}
            </div>
          )}
          <button className="w-8 h-8 rounded flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors" title="Settings" onClick={onOpenSettings}>
            <span className="material-symbols-outlined">tune</span>
          </button>
        </div>
      </div>
    </header>
  )
}
