import { useCallback, useEffect, useMemo, useState } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { useBridge } from './hooks/useBridge'
import { CockpitBar } from './components/CockpitBar'
import type { CenterView, InspectorTab } from './lib/constants'
import { NavRail, Sidebar } from './components/NavRail'
import { MissionPanel } from './components/MissionPanel'
import { WorkSurface } from './components/WorkSurface'
import { EvidencePanel } from './components/EvidencePanel'
import { CommandBar } from './components/CommandBar'
import { MarketplacePanel } from './components/MarketplacePanel'
import { ArsenalPanel } from './components/ArsenalPanel'
import { AutomationsPanel } from './components/AutomationsPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { ErrorBoundary } from './ErrorBoundary'
import { buildGraph } from './lib/runGraph'
import './app.css'

export default function App() {
  const bridge = useBridge()
  const [view, setView] = useState<CenterView>('graph')
  const [inspector, setInspector] = useState<InspectorTab | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [projectName, setProjectName] = useState('')
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('fulkrum.theme') === 'light' ? 'light' : 'dark'))
  const [dismissedCallId, setDismissedCallId] = useState<string | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('fulkrum.theme', theme)
  }, [theme])

  const graph = useMemo(() => buildGraph({
    run: bridge.run,
    plan: bridge.plan,
    tasks: bridge.tasks,
    toolCalls: bridge.toolCalls,
    byTask: bridge.byTask,
    routing: ((bridge.projectSettings ?? {}) as any).routing ?? {},
    providers: bridge.providers,
  }), [bridge.run, bridge.plan, bridge.tasks, bridge.toolCalls, bridge.byTask, bridge.projectSettings, bridge.providers])

  const approvalNode = bridge.approval
    ? graph.nodes.find((node) => node.agentId === bridge.approval?.toolCall.agentId) ?? null
    : null
  const explicit = graph.nodes.find((node) => node.id === selectedId) ?? null
  const selected = explicit ?? (approvalNode && bridge.approval?.toolCall.id !== dismissedCallId ? approvalNode : null)

  const closeSheet = useCallback(() => {
    if (selected && approvalNode && selected.id === approvalNode.id && bridge.approval) setDismissedCallId(bridge.approval.toolCall.id)
    setSelectedId(null)
  }, [selected, approvalNode, bridge.approval])

  // Keyboard: Esc unwinds, Ctrl+1-4 opens inspector
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')
      if (event.key === 'Escape') {
        if (settingsOpen) setSettingsOpen(false)
        else if (inspector) setInspector(null)
        else closeSheet()
        return
      }
      if (typing || !(event.ctrlKey || event.metaKey)) return
      const tabs: InspectorTab[] = ['plan', 'activity', 'artifacts', 'files']
      const tab = tabs[Number(event.key) - 1]
      if (tab) { event.preventDefault(); setInspector(tab) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen, inspector, closeSheet])

  // Notification on approval
  useEffect(() => {
    if (!bridge.approval) { document.title = 'fulkrum'; return }
    document.title = '● approval needed — fulkrum'
    if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('Fulkrum needs a decision', { body: `${bridge.approval.toolCall.name} is waiting for approval.` })
    }
  }, [bridge.approval])

  // Auto-dismiss notices
  useEffect(() => {
    if (!bridge.notice) return
    const timer = setTimeout(() => bridge.setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [bridge.notice, bridge])

  const noProvider = bridge.providers.length > 0 && !bridge.providers.some((p: any) => p.configured)
  const setupNeeded = noProvider || bridge.status?.execution.available === false

  return (
    <ErrorBoundary>
      <div className="app">
        <CockpitBar bridge={bridge} theme={theme} onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} onOpenSettings={() => setSettingsOpen(true)} />

        {setupNeeded && (
          <div className="setup-card">
            <TriangleAlert size={15} style={{ color: 'var(--warn)' }} />
            <div style={{ flex: 1 }}>
              <strong style={{ fontFamily: 'var(--font-sans)' }}>Two steps before this can do anything</strong>
              <ul style={{ marginLeft: 'var(--sp-4)', fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>
                {noProvider && <li>No provider has a key yet: add one in Workspace settings.</li>}
                {bridge.status?.execution.available === false && <li>No container engine is reachable. Start Docker Desktop or Podman.</li>}
              </ul>
            </div>
            <button className="btn btn-primary" onClick={() => setSettingsOpen(true)}>Open settings</button>
          </div>
        )}

        {bridge.booted && bridge.projects.length === 0 ? (
          <div className="app-body no-rail">
            <div />
            <main className="work-surface" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {view === 'marketplace' ? <MarketplacePanel bridge={bridge} /> : view === 'arsenal' ? <ArsenalPanel bridge={bridge} /> : view === 'automations' ? <AutomationsPanel bridge={bridge} /> : (
                <div className="empty-state">
                  <div className="empty-icon">◈</div>
                  <div className="empty-text">Start your first project</div>
                  <div className="empty-sub" style={{ marginBottom: 'var(--sp-4)' }}>Runs, plans, and approvals live inside a project.</div>
                  <input className="input" autoFocus value={projectName} placeholder="Project name (at least 2 characters)" onChange={(e) => setProjectName(e.target.value)} style={{ marginBottom: 'var(--sp-3)', maxWidth: 300 }} />
                  <button className="btn btn-primary" disabled={projectName.trim().length < 2} onClick={() => { void bridge.createProject(projectName.trim()); setProjectName('') }}>Create project</button>
                </div>
              )}
            </main>
          </div>
        ) : (
          <div className={`app-body ${sidebarOpen ? 'has-sidebar' : 'no-sidebar'}`}>
            <NavRail view={view} onViewChange={setView} onOpenSettings={() => setSettingsOpen(true)} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
            {sidebarOpen && <Sidebar bridge={bridge} />}

            {/* Workbench layout for run views */}
            {view === 'graph' || view === 'chat' ? (
              <>
                <MissionPanel bridge={bridge} />
                <WorkSurface bridge={bridge} />
                <EvidencePanel bridge={bridge} />
              </>
            ) : (
              <main style={{ overflow: 'auto' }}>
                {view === 'marketplace' ? <MarketplacePanel bridge={bridge} /> : view === 'arsenal' ? <ArsenalPanel bridge={bridge} /> : <AutomationsPanel bridge={bridge} />}
              </main>
            )}
          </div>
        )}

        <CommandBar bridge={bridge} />

        {settingsOpen && <SettingsPanel bridge={bridge} theme={theme} setTheme={setTheme} onClose={() => setSettingsOpen(false)} />}

        <div className="toasts">
          {bridge.error && (
            <div className="toast bad" role="alert">
              <TriangleAlert size={14} />
              <span>{bridge.error}</span>
              <button onClick={() => bridge.setError(null)} aria-label="Dismiss error"><X size={12} /></button>
            </div>
          )}
          {bridge.notice && (
            <div className="toast">
              <span>{bridge.notice}</span>
              <button onClick={() => bridge.setNotice(null)} aria-label="Dismiss notice"><X size={12} /></button>
            </div>
          )}
        </div>
      </div>
    </ErrorBoundary>
  )
}
