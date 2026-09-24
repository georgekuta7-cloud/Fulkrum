import type { Bridge } from '../hooks/useBridge'
import { resolveRouteDisplay, roleLabel } from '../lib/runGraph'
import { Icon } from './Icon'
import { ProjectMenu } from './ProjectMenu'
import { RunControls } from './RunControls'

export function Header({ bridge, theme, onToggleTheme, onOpenSettings, onOpenChat = () => {} }: {
  bridge: Bridge
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onOpenSettings: () => void
  onOpenChat?: () => void
}) {
  const spent = bridge.spend?.costUsd ?? 0
  const ceiling = bridge.run?.budgetUsd ?? bridge.estimate?.ceilingUsd ?? null
  const engine = bridge.status?.execution
  const providersReady = bridge.providers.some((provider) => provider.configured)
  const routing = (bridge.projectSettings?.routing ?? {}) as Record<string, string>
  const castRoles = (['head', 'research', 'builder'] as const).filter((role) => (routing[role] ?? '').trim())
  return (
    <header className="fixed top-0 left-0 right-0 z-40 bg-surface-dim/95 border-b border-outline-variant/20">
      <div className="h-14 px-2 sm:px-4 flex items-center justify-between gap-2 sm:gap-4">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className="w-7 h-8 sm:w-8 rounded-lg bg-primary-container/40 flex items-center justify-center shrink-0" aria-hidden="true"><Icon name="hub" className="text-primary text-lg" /></div>
          <span className="text-headline-md hidden sm:inline">Fulkrum</span>
          <ProjectMenu bridge={bridge} onOpenChat={onOpenChat} />
          <div className="hidden md:flex shrink-0 items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-container-low border border-outline-variant/30" title={engine?.reason}>
            {engine?.available ? <><span className="w-1.5 h-1.5 rounded-full bg-secondary" aria-hidden="true" /><span className="text-label-sm text-secondary">{engine.label} sandbox</span></> : <span className="text-label-sm text-outline">commands: disabled</span>}
          </div>
        </div>
        <div className="hidden xl:flex min-w-0 max-w-lg items-center gap-2 px-2.5 py-1 rounded-lg bg-surface-container-low text-label-sm" aria-label="Casting">
          {castRoles.length ? castRoles.map((role) => <span key={role} className="truncate" title={`${roleLabel(role)}: ${resolveRouteDisplay(routing, bridge.providers, role)}`}><span className="text-outline">{roleLabel(role)}: </span>{resolveRouteDisplay(routing, bridge.providers, role)}</span>) : <span className="text-outline">No casting set</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          {!providersReady ? <button type="button" className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-error-container/20 border border-error/40 text-label-sm text-error" onClick={onOpenSettings}><Icon name="key_off" className="text-sm" />no provider key</button> : null}
          <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-container text-label-sm">
            <span className="text-on-surface-variant">Spend</span><span className="text-secondary font-mono">${spent.toFixed(2)}{bridge.spend?.unpricedCalls ? '+' : ''}</span>
            {ceiling !== null ? <span className="text-on-surface-variant font-mono">/ ${ceiling.toFixed(2)}</span> : null}
          </div>
          <RunControls key={bridge.runId} bridge={bridge} />
          <button type="button" className="w-7 h-8 sm:w-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high" title={theme === 'dark' ? 'Light theme' : 'Dark theme'} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={onToggleTheme}><Icon name={theme === 'dark' ? 'light_mode' : 'dark_mode'} className="text-xl" /></button>
          <button type="button" className="w-7 h-8 sm:w-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high" title="Settings" aria-label="Open settings" onClick={onOpenSettings}><Icon name="tune" className="text-xl" /></button>
        </div>
      </div>
    </header>
  )
}
