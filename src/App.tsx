import { useEffect, useState } from 'react'
import { Activity, FileDiff, FolderTree, ListChecks, Settings2, TriangleAlert, X } from 'lucide-react'
import { useBridge } from './hooks/useBridge'
import { RunHeader } from './components/RunHeader'
import { Sidebar } from './components/Sidebar'
import { ApprovalDock } from './components/ApprovalDock'
import { PlanPanel } from './components/PlanPanel'
import { ActivityPanel } from './components/ActivityPanel'
import { ArtifactsPanel, FilesPanel } from './components/FilesPanel'
import { ChatPanel } from './components/ChatPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { ErrorBoundary } from './ErrorBoundary'
import './app.css'

/**
 * The shell: a header that says what state the run is in, the run itself in the
 * middle, the Head AI on the right, and the drawer for everything that is a decision
 * about the tool rather than about a run.
 *
 * The centre is tabbed because the four views answer different questions — what will
 * happen, what is happening, what changed, what is there — and showing them at once
 * meant none of them had room.
 */

type Tab = 'plan' | 'activity' | 'artifacts' | 'files'

const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: 'plan', label: 'Plan', icon: <ListChecks size={14} /> },
  { id: 'activity', label: 'Activity', icon: <Activity size={14} /> },
  { id: 'artifacts', label: 'Artifacts', icon: <FileDiff size={14} /> },
  { id: 'files', label: 'Workspace', icon: <FolderTree size={14} /> },
]

export default function App() {
  const bridge = useBridge()
  const [tab, setTab] = useState<Tab>('plan')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('fulkrum.theme') === 'light' ? 'light' : 'dark'))

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('fulkrum.theme', theme)
  }, [theme])

  // Escape closes the topmost overlay, which is the one thing a keyboard should do
  // without being told where the focus is.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
        <RunHeader bridge={bridge} />

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

        <div className="app-body">
          <Sidebar bridge={bridge} />

          <main className="center">
            <ApprovalDock bridge={bridge} />

            <nav className="tabs" role="tablist">
              {tabs.map((entry) => (
                <button
                  type="button"
                  role="tab"
                  key={entry.id}
                  aria-selected={tab === entry.id}
                  className={tab === entry.id ? 'active' : ''}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.icon} {entry.label}
                  {entry.id === 'activity' && bridge.streaming ? <span className="live-dot" title="text is arriving" /> : null}
                  {entry.id === 'artifacts' && bridge.artifacts.length ? <span className="count">{bridge.artifacts.length}</span> : null}
                </button>
              ))}
              <button type="button" className="settings-button" onClick={() => setSettingsOpen(true)} title="State, permissions and spend">
                <Settings2 size={14} />
                {bridge.status?.lastVerify && !bridge.status.lastVerify.ok ? <span className="live-dot bad" /> : null}
              </button>
            </nav>

            <section className="panel">
              {tab === 'plan' ? <PlanPanel bridge={bridge} /> : null}
              {tab === 'activity' ? <ActivityPanel bridge={bridge} /> : null}
              {tab === 'artifacts' ? <ArtifactsPanel bridge={bridge} /> : null}
              {tab === 'files' ? <FilesPanel bridge={bridge} /> : null}
            </section>
          </main>

          <ChatPanel bridge={bridge} />
        </div>

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
