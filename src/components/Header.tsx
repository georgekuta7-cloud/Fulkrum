import { useEffect, useRef, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { resolveRouteDisplay, roleLabel } from '../lib/runGraph'

/**
 * The one bar that never leaves: what you're in, who is cast where, what it
 * has spent, and the run's controls — plus the two states the old header
 * hid: no provider configured, and light/dark. Everything is read from the
 * bridge; a route that is not configured says so rather than showing a stale
 * name, and a missing ceiling shows spend alone instead of an invented cap.
 */
export function Header({ bridge, theme, onToggleTheme, onOpenSettings }: {
  bridge: Bridge
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onOpenSettings: () => void
}) {
  const run = bridge.run
  const spent = bridge.spend?.costUsd ?? 0
  const ceiling = run?.budgetUsd ?? bridge.estimate?.ceilingUsd ?? null
  const project = bridge.projects.find((p: any) => p.id === bridge.projectId)
  const engine = bridge.status?.execution
  const providersReady = bridge.providers.some((p: any) => p.configured)

  const [menuOpen, setMenuOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const routing = (bridge.projectSettings?.routing ?? {}) as Record<string, string>
  const castRoles = (['head', 'research', 'builder'] as const).filter((role) => (routing[role] ?? '').trim())

  return (
    <header className="fixed top-0 left-0 right-0 z-40 bg-surface-dim/80 backdrop-blur-xl border-b border-outline-variant/20">
      <div className="h-14 px-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-primary-container/40 flex items-center justify-center border border-outline-variant/30" aria-hidden="true">
            <span className="material-symbols-outlined text-primary text-lg">hub</span>
          </div>
          <span className="text-headline-md text-on-surface hidden sm:inline">Fulkrum</span>

          <div className="relative" ref={wrapRef}>
            <button
              type="button"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-container text-label-md text-on-surface hover:bg-surface-container-high transition-colors"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className="material-symbols-outlined text-sm text-primary" aria-hidden="true">folder_open</span>
              <span className="truncate max-w-[180px]">{project?.name ?? 'No project'}</span>
              <span className="material-symbols-outlined text-sm text-outline" aria-hidden="true">expand_more</span>
            </button>
            {menuOpen ? (
              <div role="menu" className="absolute left-0 top-full mt-1.5 w-64 bg-surface-container-high rounded-lg p-1.5 shadow-2xl z-50">
                {bridge.projects.map((p: any) => (
                  <button
                    key={p.id}
                    role="menuitem"
                    type="button"
                    className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg font-body-md text-body-md text-left transition-colors ${p.id === bridge.projectId ? 'bg-surface-container text-primary' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'}`}
                    onClick={() => { setMenuOpen(false); void bridge.openProject(p.id) }}
                  >
                    <span className="truncate">{p.name}</span>
                    {p.id === bridge.projectId ? <span className="material-symbols-outlined text-sm text-secondary" aria-hidden="true">check</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {engine?.available ? (
            <div className="hidden md:flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-surface-container-low border border-secondary/20">
              <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-pulse" aria-hidden="true" />
              <span className="text-label-sm text-secondary">{engine.label} sandbox</span>
            </div>
          ) : (
            <div className="hidden md:flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-surface-container-low border border-outline-variant/30" title={engine?.reason ?? 'No container engine'}>
              <span className="text-label-sm text-outline">commands: disabled</span>
            </div>
          )}
        </div>

        <div className="hidden lg:flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface-container-low border border-outline-variant/30 text-label-sm" aria-label="Casting">
          {castRoles.length ? castRoles.map((role) => (
            <span key={role} className="flex items-center gap-1">
              <span className="text-outline">{roleLabel(role)}:</span>
              <span className="text-on-surface">{resolveRouteDisplay(routing, bridge.providers, role)}</span>
              {role !== castRoles[castRoles.length - 1] ? <span className="text-outline" aria-hidden="true">·</span> : null}
            </span>
          )) : <span className="text-outline">No casting set</span>}
        </div>

        <div className="flex items-center gap-2">
          {!providersReady ? (
            <button type="button" className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-error-container/20 border border-error/40 text-label-sm text-error hover:bg-error-container/30 transition-colors" onClick={onOpenSettings} title="No provider has a key — add one in Settings">
              <span className="material-symbols-outlined text-sm" aria-hidden="true">key_off</span>
              no provider key
            </button>
          ) : null}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-container text-label-sm">
            <span className="text-on-surface-variant">Spend</span>
            <span className="text-secondary font-medium font-mono">${spent.toFixed(2)}</span>
            {ceiling !== null ? (
              <>
                <span className="text-outline" aria-hidden="true">/</span>
                <span className="text-on-surface-variant font-mono">${ceiling.toFixed(2)}</span>
              </>
            ) : null}
          </div>
          {run && (
            <div className="flex items-center gap-1" role="group" aria-label="Run controls">
              {run.status === 'paused' && (
                <button type="button" className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors" title="Resume" aria-label="Resume run" onClick={() => void bridge.control('resume')}>
                  <span className="material-symbols-outlined" aria-hidden="true">play_arrow</span>
                </button>
              )}
              {['executing', 'planning'].includes(run.status) && (
                <button type="button" className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors" title="Pause" aria-label="Pause run" onClick={() => void bridge.control('pause')}>
                  <span className="material-symbols-outlined" aria-hidden="true">pause</span>
                </button>
              )}
              {!['cancelled', 'completed', 'review'].includes(run.status) && (
                <button type="button" className="w-8 h-8 rounded-lg flex items-center justify-center text-error hover:bg-error-container/30 transition-colors" title="Stop" aria-label="Stop run" onClick={() => void bridge.control('cancel')}>
                  <span className="material-symbols-outlined" aria-hidden="true">stop</span>
                </button>
              )}
            </div>
          )}
          <button type="button" className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors" title={theme === 'dark' ? 'Light theme' : 'Dark theme'} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={onToggleTheme}>
            <span className="material-symbols-outlined" aria-hidden="true">{theme === 'dark' ? 'light_mode' : 'dark_mode'}</span>
          </button>
          <button type="button" className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors" title="Settings" aria-label="Open settings" onClick={onOpenSettings}>
            <span className="material-symbols-outlined" aria-hidden="true">tune</span>
          </button>
        </div>
      </div>
    </header>
  )
}
