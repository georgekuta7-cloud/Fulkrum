import { useCallback, useEffect, useState } from 'react'
import { useBridge } from './hooks/useBridge'
import { Header } from './components/Header'
import { Sidebar, type NavView } from './components/SideNav'
import { ChatView } from './components/ChatView'
import { EcosystemView } from './components/EcosystemView'
import { AutomationsPanel } from './components/AutomationsPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { ErrorBoundary } from './ErrorBoundary'

export default function App() {
  const bridge = useBridge()
  const [view, setView] = useState<NavView>('chat')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('fulkrum.theme') === 'light' ? 'light' : 'dark'))
  const [projectName, setProjectName] = useState('')

  useEffect(() => {
    // Toggle the class instead of rewriting className: anything else on
    // <html> (or set by tests) survives a theme flip.
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('fulkrum.theme', theme)
  }, [theme])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape' && settingsOpen) setSettingsOpen(false) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen])

  useEffect(() => {
    if (!bridge.approval) { document.title = 'Fulkrum'; return }
    document.title = '● approval needed — Fulkrum'
  }, [bridge.approval])

  useEffect(() => {
    if (!bridge.notice) return
    const t = setTimeout(() => bridge.setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [bridge.notice, bridge])

  const handleSettings = useCallback(() => setSettingsOpen(true), [])

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-surface text-on-surface antialiased selection:bg-primary-container selection:text-on-primary-container flex flex-col overflow-x-hidden">
        <Header bridge={bridge} onOpenSettings={handleSettings} />
        <Sidebar view={view} onViewChange={setView} />

        <main className="pl-16 pt-14 flex-1">
          {!bridge.booted ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-4">
                <div className="material-symbols-outlined text-6xl text-primary animate-pulse-subtle">hub</div>
                <p className="text-body-md text-on-surface-variant">Loading…</p>
              </div>
            </div>
          ) : bridge.projects.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-6 max-w-md">
                <div className="material-symbols-outlined text-6xl text-primary glow-primary rounded-2xl p-4 bg-surface-container">hub</div>
                <h1 className="text-headline-lg font-semibold tracking-tight">Start your first project</h1>
                <p className="text-body-md text-on-surface-variant">Runs, plans, and approvals live inside a project.</p>
                <div className="flex gap-3 justify-center">
                  <input
                    className="px-4 py-2.5 bg-surface-container border border-outline-variant/30 rounded-lg text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/50 w-64"
                    autoFocus value={projectName} placeholder="Project name"
                    onChange={(e) => setProjectName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && projectName.trim().length >= 2) { void bridge.createProject(projectName.trim()); setProjectName('') } }}
                  />
                  <button
                    className="px-5 py-2.5 bg-primary text-on-primary rounded-lg text-label-lg font-medium hover:bg-primary-container transition-colors disabled:opacity-40"
                    disabled={projectName.trim().length < 2}
                    onClick={() => { void bridge.createProject(projectName.trim()); setProjectName('') }}
                  >Create</button>
                </div>
              </div>
            </div>
          ) : !bridge.runId ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-6 max-w-md">
                <h1 className="text-headline-lg font-semibold tracking-tight">{bridge.projects.find((p: any) => p.id === bridge.projectId)?.name ?? 'Project'}</h1>
                <p className="text-body-md text-on-surface-variant">{bridge.runs.length} run(s) available</p>
                <div className="space-y-2">
                  {bridge.runs.map((r: any) => (
                    <button key={r.id} className="w-full px-4 py-3 bg-surface-container rounded-lg flex items-center justify-between hover:bg-surface-container-high transition-colors text-left"
                      onClick={() => void bridge.openRun(r.id)}>
                      <span className="text-body-md font-mono">{r.id.slice(0, 12)}</span>
                      <span className={`text-label-md px-2 py-0.5 rounded-full ${r.status === 'completed' ? 'bg-tertiary-container/30 text-tertiary' : r.status === 'failed' ? 'bg-error-container/30 text-error' : 'bg-surface-container-high text-on-surface-variant'}`}>{r.status}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : view === 'artifacts' ? (
            <EcosystemView bridge={bridge} />
          ) : view === 'automations' ? (
            <AutomationsPanel bridge={bridge} />
          ) : (
            <ChatView bridge={bridge} />
          )}
        </main>

        {settingsOpen && <SettingsPanel bridge={bridge} theme={theme} setTheme={setTheme} onClose={() => setSettingsOpen(false)} />}

        <div className="fixed bottom-20 right-4 z-50 space-y-2">
          {bridge.error && (
            <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-high border border-error/30 rounded-xl shadow-2xl max-w-sm" role="alert">
              <span className="material-symbols-outlined text-error">error</span>
              <span className="text-body-sm flex-1">{bridge.error}</span>
              <button onClick={() => bridge.setError(null)} aria-label="Dismiss" className="text-on-surface-variant hover:text-on-surface"><span className="material-symbols-outlined text-base">close</span></button>
            </div>
          )}
          {bridge.notice && (
            <div className="flex items-center gap-3 px-4 py-3 bg-surface-container-high border border-outline-variant/30 rounded-xl shadow-2xl max-w-sm">
              <span className="text-body-sm flex-1">{bridge.notice}</span>
              <button onClick={() => bridge.setNotice(null)} aria-label="Dismiss" className="text-on-surface-variant hover:text-on-surface"><span className="material-symbols-outlined text-base">close</span></button>
            </div>
          )}
        </div>
      </div>
    </ErrorBoundary>
  )
}
