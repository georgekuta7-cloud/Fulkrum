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
import { RunHistory } from './components/RunHistory'
import { Icon } from './components/Icon'
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
  const [creatingProject, setCreatingProject] = useState(false)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('fulkrum.theme', theme)
  }, [theme])

  useEffect(() => {
    if (!bridge.approval) { document.title = 'Fulkrum'; return }
    document.title = '● approval needed — Fulkrum'
  }, [bridge.approval])

  const { notice, setNotice } = bridge
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice, setNotice])

  const openSettings = useCallback(() => setView('settings'), [])
  const openChat = useCallback(() => setView('chat'), [])
  const toggleTheme = useCallback(() => setTheme((current) => (current === 'dark' ? 'light' : 'dark')), [])

  return (
    <ErrorBoundary>
      <a href="#main" className="skip-link">Skip to content</a>
      <div className="min-h-screen bg-surface text-on-surface antialiased flex flex-col overflow-x-hidden">
        <Header bridge={bridge} theme={theme} onToggleTheme={toggleTheme} onOpenSettings={openSettings} onOpenChat={openChat} />
        <Nav view={view} onViewChange={setView} approvalWaiting={bridge.approval !== null} reachable={!!bridge.status} />

        <main id="main" tabIndex={-1} className="pl-16 pt-14 flex-1 min-w-0 focus:outline-none">
          <div key={`${view}:${bridge.projectId ?? ''}`} className="view-enter min-h-[calc(100dvh-3.5rem)]">
          {!bridge.booted ? (
            <div className="flex items-center justify-center min-h-[calc(100dvh-3.5rem)]" role="status">
              <div className="text-center space-y-4">
                <Icon name="hub" className="text-6xl text-primary" />
                <p className="text-body-md text-on-surface-variant">Loading…</p>
              </div>
            </div>
          ) : view === 'settings' ? (
            <SettingsView bridge={bridge} />
          ) : view === 'store' ? (
            <StoreView bridge={bridge} />
          ) : !bridge.status && bridge.error && bridge.projects.length === 0 ? (
            <div role="status" className="p-6 space-y-3"><h1 className="text-headline-md">Could not load the workspace</h1><p className="text-body-md text-on-surface-variant">Check that the local API bridge is running, then retry.</p><Button onClick={() => window.location.reload()}>Retry connection</Button></div>
          ) : bridge.projects.length === 0 ? (
            <div className="flex items-center justify-center min-h-[calc(100dvh-3.5rem)]">
              <div className="text-center space-y-4 max-w-md w-full px-4">
                <Icon name="hub" className="text-6xl text-primary" />
                <h1 className="text-headline-lg font-semibold tracking-tight">Start your first project</h1>
                <p className="text-body-md text-on-surface-variant">Runs, plans, and approvals live inside a project.</p>
                <form
                  className="flex gap-2 justify-center flex-wrap"
                  onSubmit={async (event) => {
                    event.preventDefault()
                    if (!creatingProject && projectName.trim().length >= 2) {
                      setCreatingProject(true)
                      try { if (await bridge.createProject(projectName.trim())) setProjectName('') } finally { setCreatingProject(false) }
                    }
                  }}
                >
                  <label className="visually-hidden" htmlFor="first-project-name">Project name</label>
                  <input
                    id="first-project-name"
                    className="px-4 py-2.5 bg-surface-container border border-outline-variant/40 hover:border-outline-variant rounded-lg text-body-md text-on-surface placeholder:text-outline focus:outline-none focus:border-primary w-full min-w-0 sm:w-64"
                    autoFocus value={projectName} placeholder="Project name"
                    disabled={creatingProject}
                    onChange={(event) => setProjectName(event.target.value)}
                  />
                  <Button variant="primary" type="submit" disabled={creatingProject || projectName.trim().length < 2}>{creatingProject ? 'Creating…' : 'Create'}</Button>
                </form>
              </div>
            </div>
          ) : bridge.projectLoading || bridge.runLoading ? (
            <div role="status" className="p-6 text-body-md text-on-surface-variant">Loading {bridge.projectLoading ? 'project' : 'run'}…</div>
          ) : view === 'automations' ? (
            <AutomationsView bridge={bridge} />
          ) : !bridge.runId ? (
            <RunHistory bridge={bridge} />
          ) : view === 'control' ? (
            <ControlView bridge={bridge} onOpenChat={() => setView('chat')} />
          ) : view === 'files' ? (
            <FilesView key={bridge.runId} bridge={bridge} />
          ) : (
            <ChatView key={bridge.runId} bridge={bridge} onOpenSettings={openSettings} />
          )}
          </div>
        </main>

        <div className="fixed bottom-24 right-3 left-20 sm:left-auto sm:bottom-4 sm:right-4 z-50 space-y-2" aria-live="polite">
          {bridge.error ? (
            <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-high border border-error/40 rounded-lg shadow-panel max-w-sm" role="alert">
              <Icon name="error" className="text-error text-xl" />
              <span className="text-body-sm flex-1 min-w-0 break-words">{bridge.error}</span>
              <button type="button" onClick={() => bridge.setError(null)} aria-label="Dismiss error" className="text-on-surface-variant hover:text-on-surface p-1"><Icon name="close" className="text-base" /></button>
            </div>
          ) : null}
          {bridge.notice ? (
            <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-high border border-outline-variant/40 rounded-lg shadow-panel max-w-sm">
              <span className="text-body-sm flex-1">{bridge.notice}</span>
              <button type="button" onClick={() => bridge.setNotice(null)} aria-label="Dismiss notice" className="text-on-surface-variant hover:text-on-surface p-1"><Icon name="close" className="text-base" /></button>
            </div>
          ) : null}
        </div>
      </div>
    </ErrorBoundary>
  )
}
