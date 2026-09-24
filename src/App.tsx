import { useCallback, useEffect, useState } from 'react'
import { useBridge } from './hooks/useBridge'
import { Header } from './components/Header'
import { Nav, type NavView } from './components/Nav'
import { ChatView } from './components/ChatView'
import { ControlView } from './components/ControlView'
import { FilesView } from './components/FilesView'
import { StoreView } from './components/StoreView'
import { AutomationsView } from './components/AutomationsView'
import { SettingsView } from './components/SettingsView'
import { Button } from './components/primitives'
import { ErrorBoundary } from './ErrorBoundary'
import './index.css'

/**
 * The shell: six destinations, each rendering something real, and gates that
 * say what is missing instead of rendering a broken view. Settings and the
 * store belong to the workspace, so they never wait on a run; everything else
 * names the run it needs or offers to start one.
 */
export default function App() {
  const bridge = useBridge()
  const [view, setView] = useState<NavView>('chat')
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('fulkrum.theme') === 'light' ? 'light' : 'dark'))
  const [projectName, setProjectName] = useState('')

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('fulkrum.theme', theme)
  }, [theme])

  useEffect(() => {
    if (!bridge.approval) { document.title = 'Fulkrum'; return }
    document.title = '● approval needed — Fulkrum'
  }, [bridge.approval])

  useEffect(() => {
    if (!bridge.notice) return
    const timer = setTimeout(() => bridge.setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [bridge.notice, bridge])

  const openSettings = useCallback(() => setView('settings'), [])
  const toggleTheme = useCallback(() => setTheme((current) => (current === 'dark' ? 'light' : 'dark')), [])

  return (
    <ErrorBoundary>
      <a href="#main" className="skip-link">Skip to content</a>
      <div className="min-h-screen bg-surface text-on-surface antialiased flex flex-col overflow-x-hidden">
        <Header bridge={bridge} theme={theme} onToggleTheme={toggleTheme} onOpenSettings={openSettings} />
        <Nav view={view} onViewChange={setView} approvalWaiting={bridge.approval !== null} />

        <main id="main" tabIndex={-1} className="pl-16 pt-14 flex-1 focus:outline-none">
          <div key={view} className="view-enter">
          {!bridge.booted ? (
            <div className="flex items-center justify-center h-full" role="status">
              <div className="text-center space-y-4">
                <span className="material-symbols-outlined text-6xl text-primary" aria-hidden="true">hub</span>
                <p className="text-body-md text-on-surface-variant">Loading…</p>
              </div>
            </div>
          ) : view === 'settings' ? (
            <SettingsView bridge={bridge} />
          ) : view === 'store' ? (
            <StoreView bridge={bridge} />
          ) : bridge.projects.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-4 max-w-md px-4">
                <span className="material-symbols-outlined text-6xl text-primary" aria-hidden="true">hub</span>
                <h1 className="text-headline-lg font-semibold tracking-tight">Start your first project</h1>
                <p className="text-body-md text-on-surface-variant">Runs, plans, and approvals live inside a project.</p>
                <form
                  className="flex gap-2 justify-center"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (projectName.trim().length >= 2) {
                      void bridge.createProject(projectName.trim())
                      setProjectName('')
                    }
                  }}
                >
                  <label className="visually-hidden" htmlFor="first-project-name">Project name</label>
                  <input
                    id="first-project-name"
                    className="px-4 py-2.5 bg-surface-container border border-outline-variant/30 rounded-lg text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/50 w-64"
                    autoFocus value={projectName} placeholder="Project name"
                    onChange={(event) => setProjectName(event.target.value)}
                  />
                  <Button variant="primary" type="submit" disabled={projectName.trim().length < 2}>Create</Button>
                </form>
              </div>
            </div>
          ) : view === 'automations' ? (
            <AutomationsView bridge={bridge} />
          ) : !bridge.runId ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-3 max-w-md px-4">
                <h1 className="text-headline-lg font-semibold tracking-tight">{bridge.projects.find((p: any) => p.id === bridge.projectId)?.name ?? 'Project'}</h1>
                <p className="text-body-md text-on-surface-variant">{bridge.runs.length} run(s) in this project.</p>
                <div className="space-y-2">
                  {bridge.runs.map((r: any) => (
                    <button key={r.id} type="button" className="w-full px-4 py-3 bg-surface-container rounded-xl flex items-center justify-between hover:bg-surface-container-high transition-colors text-left" onClick={() => void bridge.openRun(r.id)}>
                      <span className="text-body-md font-mono">{r.id.slice(0, 12)}</span>
                      <span className={`text-label-sm px-2 py-0.5 rounded-full ${r.status === 'completed' ? 'bg-tertiary-container/30 text-tertiary' : r.status === 'failed' ? 'bg-error-container/30 text-error' : 'bg-surface-container-high text-on-surface-variant'}`}>{r.status}</span>
                    </button>
                  ))}
                  <Button variant="primary" className="w-full justify-center py-3" onClick={() => void bridge.createRun()}>Start a new run</Button>
                </div>
              </div>
            </div>
          ) : view === 'control' ? (
            <ControlView bridge={bridge} onOpenChat={() => setView('chat')} />
          ) : view === 'files' ? (
            <FilesView bridge={bridge} />
          ) : (
            <ChatView bridge={bridge} />
          )}
          </div>
        </main>

        <div className="fixed bottom-4 right-4 z-50 space-y-2" aria-live="polite">
          {bridge.error ? (
            <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-high border border-error/30 rounded-xl shadow-float max-w-sm" role="alert">
              <span className="material-symbols-outlined text-error" aria-hidden="true">error</span>
              <span className="text-body-sm flex-1">{bridge.error}</span>
              <button type="button" onClick={() => bridge.setError(null)} aria-label="Dismiss error" className="text-on-surface-variant hover:text-on-surface"><span className="material-symbols-outlined text-base" aria-hidden="true">close</span></button>
            </div>
          ) : null}
          {bridge.notice ? (
            <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-high border border-outline-variant/30 rounded-xl shadow-float max-w-sm">
              <span className="text-body-sm flex-1">{bridge.notice}</span>
              <button type="button" onClick={() => bridge.setNotice(null)} aria-label="Dismiss notice" className="text-on-surface-variant hover:text-on-surface"><span className="material-symbols-outlined text-base" aria-hidden="true">close</span></button>
            </div>
          ) : null}
        </div>
      </div>
    </ErrorBoundary>
  )
}
