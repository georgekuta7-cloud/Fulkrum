import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, ArrowLeft, FileDiff, FolderTree, ListChecks, Settings2, TriangleAlert, X } from 'lucide-react'
import { useBridge } from './hooks/useBridge'
import { TopBar } from './components/TopBar'
import type { CenterView, InspectorTab } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { GraphCanvas } from './components/GraphCanvas'
import { WorkerSheet } from './components/WorkerSheet'
import { ApprovalDock } from './components/ApprovalDock'
import { PlanPanel } from './components/PlanPanel'
import { ActivityPanel } from './components/ActivityPanel'
import { ArtifactsPanel, FilesPanel } from './components/FilesPanel'
import { ChatPanel } from './components/ChatPanel'
import { ContextRail } from './components/ContextRail'
import { SettingsPanel } from './components/SettingsPanel'
import { ErrorBoundary } from './ErrorBoundary'
import { buildGraph } from './lib/runGraph'
import type { GraphNode } from './lib/runGraph'
import './app.css'

/**
 * The shell: a status bar that never leaves, the run as a living map in the
 * middle, and the Head AI one panel away. The map is the main screen because it
 * answers the two questions everything else serves — what is it doing, and what
 * is it waiting for. The chat takes the center on demand; the inspector (plan,
 * activity, artifacts, workspace) is a view over the same records, not a mode
 * the app is stuck in.
 */

const inspectorTabs: Array<{ id: InspectorTab; label: string; icon: React.ReactNode }> = [
  { id: 'plan', label: 'Plan', icon: <ListChecks size={14} /> },
  { id: 'activity', label: 'Activity', icon: <Activity size={14} /> },
  { id: 'artifacts', label: 'Artifacts', icon: <FileDiff size={14} /> },
  { id: 'files', label: 'Workspace', icon: <FolderTree size={14} /> },
]

export default function App() {
  const bridge = useBridge()
  const [view, setView] = useState<CenterView>('graph')
  const [inspector, setInspector] = useState<InspectorTab | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('fulkrum.theme') === 'light' ? 'light' : 'dark'))

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
  }), [bridge.run, bridge.plan, bridge.tasks, bridge.toolCalls, bridge.byTask])

  // The node a pending approval belongs to, so the decision surfaces on the
  // worker that is actually waiting — even if the person is looking elsewhere.
  // An explicit click always wins; a dismissal is remembered per tool call so it
  // does not fight the next approval.
  const [dismissedCallId, setDismissedCallId] = useState<string | null>(null)
  const approvalNode = bridge.approval
    ? graph.nodes.find((node) => node.kind === 'task' && node.agentId === bridge.approval?.toolCall.agentId) ?? null
    : null
  const explicit = graph.nodes.find((node) => node.id === selectedId) ?? null
  const selected = explicit ?? (approvalNode && bridge.approval?.toolCall.id !== dismissedCallId ? approvalNode : null)

  const closeSheet = useCallback(() => {
    if (selected && approvalNode && selected.id === approvalNode.id && bridge.approval) setDismissedCallId(bridge.approval.toolCall.id)
    setSelectedId(null)
  }, [selected, approvalNode, bridge.approval])

  // Escape unwinds the topmost layer; ⌃1–4 open the inspector over the map.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName ?? '')
      if (event.key === 'Escape') {
        if (settingsOpen) setSettingsOpen(false)
        else if (inspector) setInspector(null)
        else closeSheet()
        return
      }
      if (typing || !(event.ctrlKey || event.metaKey)) return
      const tab = inspectorTabs[Number(event.key) - 1]
      if (tab) {
        event.preventDefault()
        setInspector(tab.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, inspector, closeSheet])

  // A run that parks on an approval is the one thing worth interrupting a person
  // for, and only when they are looking at something else.
  useEffect(() => {
    if (!bridge.approval) {
      document.title = 'fulkrum'
      return
    }
    document.title = '● approval needed — fulkrum'
    if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('Fulkrum needs a decision', { body: `${bridge.approval.toolCall.name} is waiting for approval.` })
    }
  }, [bridge.approval])

  useEffect(() => {
    if (!bridge.notice) return
    const timer = setTimeout(() => bridge.setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [bridge.notice, bridge])

  const noProvider = bridge.providers.length > 0 && !bridge.providers.some((provider) => provider.configured)
  const setupNeeded = noProvider || bridge.status?.execution.available === false

  return (
    <ErrorBoundary>
      <div className="app">
        <TopBar
          bridge={bridge}
          view={view}
          onViewChange={setView}
          onOpenInspector={setInspector}
          onOpenSettings={() => setSettingsOpen(true)}
          theme={theme}
          onToggleTheme={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
        />

        {setupNeeded ? (
          <div className="setup-card">
            <TriangleAlert size={15} />
            <div>
              <strong>Two steps before this can do anything</strong>
              <ul>
                {noProvider ? <li>No provider has a key yet: add one in Workspace settings, or point it at an endpoint on your own machine and turn on local access for that provider.</li> : null}
                {bridge.status?.execution.available === false ? <li>No container engine is reachable, so a worker cannot run commands. Start Docker Desktop or Podman, then build the runner image once: <code>npm run runner:build</code>.</li> : null}
              </ul>
            </div>
            <button type="button" className="primary" onClick={() => setSettingsOpen(true)}><Settings2 size={13} /> Open settings</button>
          </div>
        ) : null}

        {bridge.booted && bridge.projects.length === 0 ? (
          <div className="app-body">
            <main className="center">
              <div className="panel-empty">
                <h2>Start your first project</h2>
                <p>Runs, plans, and approvals live inside a project, and nothing is seeded — what you see is what you made.</p>
                <form
                  className="deny-row"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (projectName.trim().length >= 2) {
                      void bridge.createProject(projectName.trim())
                      setProjectName('')
                    }
                  }}
                >
                  <input autoFocus value={projectName} placeholder="Project name (at least 2 characters)" onChange={(event) => setProjectName(event.target.value)} />
                  <button type="submit" className="primary" disabled={projectName.trim().length < 2}>Create project</button>
                </form>
              </div>
            </main>
          </div>
        ) : (
        <div className={`app-body ${view === 'chat' ? 'chat-centered' : ''}`}>
          <Sidebar bridge={bridge} />

          <main className="center">
            {inspector ? (
              <>
                <nav className="tabs" role="tablist">
                  <button type="button" className="inspector-back" onClick={() => setInspector(null)} title="Back to the map">
                    <ArrowLeft size={14} />
                  </button>
                  {inspectorTabs.map((entry, index) => (
                    <button
                      type="button"
                      role="tab"
                      key={entry.id}
                      aria-selected={inspector === entry.id}
                      className={inspector === entry.id ? 'active' : ''}
                      onClick={() => setInspector(entry.id)}
                    >
                      {entry.icon} {entry.label}
                      {entry.id === 'activity' && bridge.streaming ? <span className="live-dot" title="text is arriving" /> : null}
                      {entry.id === 'artifacts' && bridge.artifacts.length ? <span className="count">{bridge.artifacts.length}</span> : null}
                      <kbd>⌃{index + 1}</kbd>
                    </button>
                  ))}
                </nav>
                <section className="panel">
                  {inspector === 'plan' ? <PlanPanel bridge={bridge} /> : null}
                  {inspector === 'activity' ? <ActivityPanel bridge={bridge} /> : null}
                  {inspector === 'artifacts' ? <ArtifactsPanel bridge={bridge} /> : null}
                  {inspector === 'files' ? <FilesPanel bridge={bridge} /> : null}
                </section>
              </>
            ) : view === 'graph' ? (
              <div className="graph-wrap">
                {graph.nodes.length ? (
                  <>
                    <p className="graph-hint">Click a worker to see what it is doing</p>
                    <GraphCanvas nodes={graph.nodes} edges={graph.edges} selectedId={selected?.id ?? null} onSelect={(node: GraphNode) => setSelectedId(node.id)} />
                    {selected ? <WorkerSheet bridge={bridge} node={selected} onClose={closeSheet} /> : null}
                    {!selected && bridge.approval && !approvalNode ? (
                      <div className="worker-sheet-fallback"><ApprovalDock bridge={bridge} /></div>
                    ) : null}
                  </>
                ) : (
                  <div className="panel-empty">
                    <h2>No run open</h2>
                    <p className="muted">Pick a run from the sidebar, or start one from the chat.</p>
                  </div>
                )}
              </div>
            ) : (
              <ChatPanel bridge={bridge} centered />
            )}
          </main>

          {view === 'graph' ? <ChatPanel bridge={bridge} /> : <ContextRail bridge={bridge} />}
        </div>
        )}

        {settingsOpen ? <SettingsPanel bridge={bridge} theme={theme} setTheme={setTheme} onClose={() => setSettingsOpen(false)} /> : null}

        <div className="toasts">
          {bridge.error ? (
            <div className="toast bad" role="alert">
              <TriangleAlert size={14} />
              <span>{bridge.error}</span>
              <button type="button" className="icon" onClick={() => bridge.setError(null)}><X size={12} /></button>
            </div>
          ) : null}
          {bridge.notice ? (
            <div className="toast">
              <span>{bridge.notice}</span>
              <button type="button" className="icon" onClick={() => bridge.setNotice(null)}><X size={12} /></button>
            </div>
          ) : null}
        </div>
      </div>
    </ErrorBoundary>
  )
}
