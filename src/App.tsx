import { useCallback, useEffect, useState } from 'react'
import { useBridge } from './hooks/useBridge'
import { Header } from './components/Header'
import { Sidebar, type NavView } from './components/SideNav'
import { ChatView } from './components/ChatView'
import { EcosystemView } from './components/EcosystemView'
import { SettingsPanel } from './components/SettingsPanel'
import { ErrorBoundary } from './ErrorBoundary'
import './app.css'

export default function App() {
  const bridge = useBridge()
  const [view, setView] = useState<NavView>('chat')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('fulkrum.theme') === 'light' ? 'light' : 'dark'))
  const [projectName, setProjectName] = useState('')

  useEffect(() => {
    document.documentElement.className = theme
    localStorage.setItem('fulkrum.theme', theme)
  }, [theme])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (settingsOpen) setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen])

  useEffect(() => {
    if (!bridge.approval) { document.title = 'Fulkrum'; return }
    document.title = '● approval needed — Fulkrum'
  }, [bridge.approval])

  useEffect(() => {
    if (!bridge.notice) return
    const timer = setTimeout(() => bridge.setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [bridge.notice, bridge])

  const handleSettings = useCallback(() => setSettingsOpen(true), [])

  return (
    <ErrorBoundary>
      <Header bridge={bridge} onOpenSettings={handleSettings} />
      <Sidebar view={view} onViewChange={setView} />

      <main className="m3-main">
        {!bridge.booted ? (
          <div className="m3-empty">
            <div className="m3-empty-icon">◈</div>
            <div className="m3-empty-title">Loading…</div>
          </div>
        ) : bridge.projects.length === 0 ? (
          <div className="m3-empty">
            <div className="m3-empty-icon">◈</div>
            <div className="m3-empty-title">Start your first project</div>
            <div className="m3-empty-sub">Runs, plans, and approvals live inside a project.</div>
            <input className="m3-input" autoFocus value={projectName} placeholder="Project name" onChange={(e) => setProjectName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && projectName.trim().length >= 2) { void bridge.createProject(projectName.trim()); setProjectName('') } }} />
            <button className="m3-btn-primary" disabled={projectName.trim().length < 2} onClick={() => { void bridge.createProject(projectName.trim()); setProjectName('') }}>Create project</button>
          </div>
        ) : !bridge.runId ? (
          <div className="m3-empty">
            <div className="m3-empty-icon">◈</div>
            <div className="m3-empty-title">{bridge.projects.find((p: any) => p.id === bridge.projectId)?.name ?? 'Project'}</div>
            <div className="m3-empty-sub">{bridge.runs.length} run(s) in this project.</div>
            {bridge.runs.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16, width: '100%', maxWidth: 400 }}>
                {bridge.runs.map((r: any) => (
                  <button key={r.id} className="m3-btn-card" style={{ justifyContent: 'space-between', width: '100%' }} onClick={() => void bridge.openRun(r.id)} type="button">
                    <span>{r.id.slice(0, 12)}</span>
                    <span style={{ color: r.status === 'completed' ? 'var(--tertiary)' : r.status === 'failed' ? 'var(--error)' : 'var(--on-surface-variant)' }}>{r.status}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : view === 'artifacts' ? (
          <EcosystemView bridge={bridge} />
        ) : (
          <ChatView bridge={bridge} />
        )}
      </main>

      {settingsOpen && (
        <SettingsPanel bridge={bridge} theme={theme} setTheme={setTheme} onClose={() => setSettingsOpen(false)} />
      )}

      <div className="m3-toasts">
        {bridge.error && (
          <div className="m3-toast error" role="alert">
            <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--error)' }}>error</span>
            <span>{bridge.error}</span>
            <button onClick={() => bridge.setError(null)} aria-label="Dismiss error" type="button">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
            </button>
          </div>
        )}
        {bridge.notice && (
          <div className="m3-toast">
            <span>{bridge.notice}</span>
            <button onClick={() => bridge.setNotice(null)} aria-label="Dismiss notice" type="button">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
            </button>
          </div>
        )}
      </div>
    </ErrorBoundary>
  )
}
