import { useEffect, useRef, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { resolveRouteDisplay, roleLabel } from '../lib/runGraph'

/**
 * The one bar that never leaves: what you're in, who is cast where, what it
 * has spent, and the run's controls. Everything is read from the bridge —
 * a route that is not configured says so rather than showing a stale name.
 */
export function Header({ bridge, onOpenSettings }: { bridge: Bridge; onOpenSettings: () => void }) {
  const run = bridge.run
  const spend = bridge.spend
  const ceiling = run?.budgetUsd ?? bridge.estimate?.ceilingUsd ?? null
  const spent = spend?.costUsd ?? 0
  const project = bridge.projects.find((p: any) => p.id === bridge.projectId)
  const engine = bridge.status?.execution

  const [menuOpen, setMenuOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuOpen])

  const routing = (bridge.projectSettings?.routing ?? {}) as Record<string, string>
  const castRoles = (['head', 'research', 'builder'] as const).filter((role) => (routing[role] ?? '').trim())

  return (
    <header className="fixed top-0 left-0 right-0 z-40 bg-surface-dim/80 backdrop-blur-xl border-b border-outline-variant/20">
      <div className="h-14 px-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-primary-container/40 flex items-center justify-center border border-outline-variant/30">
            <span className="material-symbols-outlined text-primary text-lg">hub</span>
          </div>
          <span className="text-headline-md text-on-surface hidden sm:inline">Fulkrum</span>

          {/* Project switcher: everything routes through openProject. */}
          <div className="relative" ref={wrapRef}>
            <button
              type="button"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-container text-label-md text-on-surface hover:bg-surface-container-high transition-colors"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className="material-symbols-outlined text-sm text-primary">folder_open</span>
              <span className="truncate max-w-[180px]">{project?.name ?? 'No project'}</span>
              <span className="material-symbols-outlined text-sm text-outline">expand_more</span>
            </button>
            {menuOpen ? (
              <div role="menu" className="absolute left-0 top-full mt-1.5 w-64 bg-surface-container-high rounded-lg p-1.5 shadow-2xl z-50">
                {bridge.projects.map((p: any) => (
                  <button
                    key={p.id}
                    role="menuitem"
                    type="button"
                    className={`w-full flex items-center justify-between px-2.5 py-2 rounded font-body-md text-body-md text-left transition-colors ${p.id === bridge.projectId ? 'bg-surface-container text-primary' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'}`}
                    onClick={() => { setMenuOpen(false); void bridge.openProject(p.id) }}
                  >
                    <span className="truncate">{p.name}</span>
                    {p.id === bridge.projectId ? <span className="material-symbols-outlined text-sm text-secondary">check</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {engine?.available ? (
            <div className="hidden md:flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-surface-container-low border border-secondary/20">
              <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-pulse" />
              <span className="text-label-sm text-secondary">{engine.label} sandbox</span>
            </div>
          ) : null}
        </div>

        {/* Casting chips: who plays whom, from routing — not from vibes. */}
        <div className="hidden lg:flex items-center gap-1 px-2.5 py-1 rounded bg-surface-container-low border border-outline-variant/30 text-label-sm">
          {castRoles.length ? castRoles.map((role) => (
            <span key={role} className="flex items-center gap-1">
              <span className="text-outline">{roleLabel(role)}:</span>
              <span className="text-on-surface">{resolveRouteDisplay(routing, bridge.providers, role)}</span>
              {role !== castRoles[castRoles.length - 1] ? <span className="text-outline">·</span> : null}
            </span>
          )) : <span className="text-outline">No casting set</span>}
        </div>

        <div className="flex items-center gap-2.5">
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-container text-label-sm">
            <span className="text-on-surface-variant">Spend</span>
            <span className="text-secondary font-medium font-mono">${spent.toFixed(2)}</span>
            {ceiling !== null ? (
              <>
                <span className="text-outline">/</span>
                <span className="text-on-surface-variant font-mono">${ceiling.toFixed(2)}</span>
              </>
            ) : null}
          </div>
          {run && (
            <div className="flex items-center gap-1">
              {run.status === 'paused' && (
                <button type="button" className="w-8 h-8 rounded flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors" title="Resume" onClick={() => void bridge.control('resume')}>
                  <span className="material-symbols-outlined">play_arrow</span>
                </button>
              )}
              {['executing', 'planning'].includes(run.status) && (
                <button type="button" className="w-8 h-8 rounded flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors" title="Pause" onClick={() => void bridge.control('pause')}>
                  <span className="material-symbols-outlined">pause</span>
                </button>
              )}
              {!['cancelled', 'completed', 'review'].includes(run.status) && (
                <button type="button" className="w-8 h-8 rounded flex items-center justify-center text-error hover:bg-error-container/30 transition-colors" title="Stop" onClick={() => void bridge.control('cancel')}>
                  <span className="material-symbols-outlined">stop</span>
                </button>
              )}
            </div>
          )}
          <button type="button" className="w-8 h-8 rounded flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors" title="Settings" onClick={onOpenSettings}>
            <span className="material-symbols-outlined">tune</span>
          </button>
        </div>
      </div>
    </header>
  )
}
