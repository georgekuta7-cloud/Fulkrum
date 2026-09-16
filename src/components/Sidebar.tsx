import { useState } from 'react'
import { GitBranch, Plus, Search, Trash2 } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'
import type { SearchResults } from '../api/types'

/**
 * Projects, the runs inside the open one, and a search across what was said and
 * recorded. The history is where "what did this thing do last week" is answered, and
 * a fork is how a plan gets run again without retyping the direction.
 */

const statusTone = (status: string) => {
  if (['review', 'completed'].includes(status)) return 'ok'
  if (['executing', 'planning'].includes(status)) return 'busy'
  if (['paused', 'interrupted', 'budget_exceeded'].includes(status)) return 'warn'
  if (['failed', 'cancelled'].includes(status)) return 'bad'
  return 'idle'
}

export function Sidebar({ bridge }: { bridge: Bridge }) {
  const { projects, projectId, runs, runId, openProject, openRun, createProject, deleteProject, forkRun, search } = bridge
  const [draftName, setDraftName] = useState('')
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [searching, setSearching] = useState(false)

  const submitSearch = async (value: string) => {
    setQuery(value)
    if (value.trim().length < 2) {
      setResults(null)
      return
    }
    setSearching(true)
    try {
      setResults(await search(value))
    } finally {
      setSearching(false)
    }
  }

  return (
    <aside className="sidebar">
      <section className="sidebar-section">
        <div className="panel-bar">
          <strong>Projects</strong>
          <button type="button" className="tiny-button" onClick={() => setAdding((open) => !open)}><Plus size={12} /> new</button>
        </div>
        {adding ? (
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (!draftName.trim()) return
              void createProject(draftName.trim())
              setDraftName('')
              setAdding(false)
            }}
          >
            <input autoFocus value={draftName} placeholder="Project name" onChange={(event) => setDraftName(event.target.value)} />
            <button type="submit" className="primary">Add</button>
          </form>
        ) : null}
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id} className={project.id === projectId ? 'active' : ''}>
              <button type="button" className="project-button" onClick={() => void openProject(project.id)}>{project.name}</button>
              {projects.length > 1 ? (
                <button type="button" className="icon danger" title={`Delete ${project.name}`} onClick={() => { if (window.confirm(`Delete ${project.name} and everything in it?`)) void deleteProject(project.id) }}>
                  <Trash2 size={12} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="sidebar-section">
        <div className="panel-bar">
          <strong>Runs</strong>
          <span className="muted tiny">{runs.length}</span>
        </div>
        <ul className="run-list">
          {runs.map((run) => (
            <li key={run.id} className={run.id === runId ? 'active' : ''}>
              <button type="button" className="run-button" onClick={() => void openRun(run.id)}>
                <span className={`status-chip ${statusTone(run.status)}`}>{run.status.replaceAll('_', ' ')}</span>
                <span className="run-objective">{run.objective ?? 'no plan yet'}</span>
                <span className="muted tiny">
                  {run.spend?.costUsd ? `$${run.spend.costUsd.toFixed(4)}` : '—'} · {run.writes ?? 0} write(s) · {new Date(run.updatedAt).toLocaleDateString()}
                </span>
              </button>
              {run.id === runId ? (
                <button type="button" className="tiny-button" title="Run this plan again as a new draft" onClick={() => void forkRun()}>
                  <GitBranch size={12} /> fork
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="sidebar-section">
        <div className="panel-bar">
          <Search size={13} />
          <input className="search-input" value={query} placeholder="Search messages and events" onChange={(event) => void submitSearch(event.target.value)} />
        </div>
        {searching ? <p className="muted tiny">searching…</p> : null}
        {results ? (
          <ul className="search-results">
            {[...results.messages, ...results.events].slice(0, 20).map((hit) => (
              <li key={`${hit.kind}-${hit.id}`}>
                <button type="button" onClick={() => void openRun(hit.runId)}>
                  <span className={`kind-chip ${hit.kind}`}>{hit.kind}</span>
                  <span className="hit-snippet">{hit.snippet}</span>
                </button>
              </li>
            ))}
            {!results.messages.length && !results.events.length ? <li className="muted tiny">nothing found</li> : null}
          </ul>
        ) : null}
      </section>
    </aside>
  )
}
