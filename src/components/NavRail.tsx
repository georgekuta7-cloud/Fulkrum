import { Boxes, Compass, GitBranch, Plus, Search, Settings2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import type { CenterView } from '../lib/constants'

export function NavRail({ view, onViewChange, onOpenSettings, sidebarOpen, onToggleSidebar }: {
  view: CenterView
  onViewChange: (v: CenterView) => void
  onOpenSettings: () => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
}) {
  return (
    <nav className="nav-rail" aria-label="Main navigation">
      <button className={`nav-btn ${sidebarOpen ? 'active' : ''}`} aria-label="Projects & Runs" aria-pressed={sidebarOpen} onClick={onToggleSidebar}><Boxes size={16} /></button>
      <span className="nav-sep" />
      <button className={`nav-btn ${view === 'marketplace' ? 'active' : ''}`} aria-label="Store" aria-pressed={view === 'marketplace'} onClick={() => onViewChange('marketplace')}><Compass size={16} /></button>
      <button className={`nav-btn ${view === 'arsenal' ? 'active' : ''}`} aria-label="Arsenal" aria-pressed={view === 'arsenal'} onClick={() => onViewChange('arsenal')}><Boxes size={16} /></button>
      <button className={`nav-btn ${view === 'automations' ? 'active' : ''}`} aria-label="Automations" aria-pressed={view === 'automations'} onClick={() => onViewChange('automations')}><GitBranch size={16} /></button>
      <span className="nav-spacer" />
      <span className="nav-sep" />
      <button className="nav-btn" aria-label="Settings" onClick={onOpenSettings}><Settings2 size={16} /></button>
    </nav>
  )
}

export function Sidebar({ bridge }: { bridge: Bridge }) {
  const [draftName, setDraftName] = useState('')
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any>(null)
  const [searching, setSearching] = useState(false)

  const doSearch = async (q: string) => {
    setQuery(q)
    if (q.trim().length < 2) { setResults(null); return }
    setSearching(true)
    try { setResults(await bridge.search(q)) } finally { setSearching(false) }
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="micro-label">Projects</span>
        <button className="btn btn-ghost btn-sm" aria-label="New project" onClick={() => setAdding(!adding)}><Plus size={12} /></button>
      </div>
      {adding && (
        <div className="sidebar-form">
          <input className="input" autoFocus placeholder="Project name" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
          <button className="btn btn-primary btn-sm" disabled={draftName.trim().length < 2} onClick={() => { void bridge.createProject(draftName.trim()); setDraftName(''); setAdding(false) }}>Create project</button>
        </div>
      )}
      <ul className="project-list">
        {bridge.projects.map((p) => (
          <li key={p.id} className={p.id === bridge.projectId ? 'active' : ''}>
            <button className="project-button" onClick={() => void bridge.openProject(p.id)}>
              <span className="run-objective">{p.name}</span>
            </button>
            {bridge.projects.length > 1 && <button className="btn btn-ghost btn-sm" aria-label={`Delete ${p.name}`} onClick={() => { if (window.confirm(`Delete ${p.name} and everything in it?`)) void bridge.deleteProject(p.id) }}><Trash2 size={11} /></button>}
          </li>
        ))}
      </ul>
      <div className="sidebar-header">
        <span className="micro-label">Runs ({bridge.runs?.length ?? 0})</span>
      </div>
      <ul className="run-list">
        {bridge.runs?.map((r) => (
          <li key={r.id} className={r.id === bridge.runId ? 'active' : ''}>
            <button className="run-button" onClick={() => void bridge.openRun(r.id)}>
              <div className="run-objective">{r.objective || 'no plan yet'}</div>
              <div className="run-meta">${(r.spend?.costUsd ?? 0).toFixed(4)} · {r.writes ?? 0} writes</div>
            </button>
            {r.id === bridge.runId && <button className="btn btn-ghost btn-sm" aria-label="Fork run" onClick={() => void bridge.forkRun()}><GitBranch size={11} /></button>}
          </li>
        ))}
      </ul>
      <div className="sidebar-search">
        <Search size={12} className="sidebar-search-icon" />
        <input className="input" placeholder="Search messages and events" value={query} onChange={(e) => void doSearch(e.target.value)} />
      </div>
      {searching && <div className="muted tiny">searching…</div>}
      {results && (
        <div className="search-results">
          {[...(results.messages ?? []), ...(results.events ?? [])].slice(0, 20).map((hit: any) => (
            <button key={hit.id} className="search-result" onClick={() => void bridge.openRun(hit.runId)}>
              <span className={`chip chip-${hit.kind === 'message' ? 'accent' : 'plan'}`}>{hit.kind}</span>
              <span className="hit-snippet">{hit.snippet?.slice(0, 40)}</span>
            </button>
          ))}
          {![...(results.messages ?? []), ...(results.events ?? [])].length && <div className="muted tiny">nothing found</div>}
        </div>
      )}
    </div>
  )
}
