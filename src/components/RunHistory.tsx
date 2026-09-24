import { useEffect, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { Button, Chip } from './primitives'

export function RunHistory({ bridge }: { bridge: Bridge }) {
  const [busy, setBusy] = useState(false)
  const project = bridge.projects.find((entry) => entry.id === bridge.projectId)
  const { projectId, loadRuns } = bridge
  // Statuses change outside this view (a run pauses, fails, or another window
  // drives it), so the summary list is refreshed when the surface opens.
  useEffect(() => {
    if (projectId) void loadRuns(projectId).catch(() => {})
  }, [projectId, loadRuns])
  return (
    <section aria-label="Run history" className="w-full max-w-4xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-headline-lg break-words">{project?.name ?? 'Project'}</h1>
          <p className="text-body-md text-on-surface-variant">{bridge.runs.length} run(s) in this project.</p>
        </div>
        <Button variant="primary" disabled={busy || !bridge.projectId} onClick={async () => {
          setBusy(true)
          try { await bridge.createRun() } finally { setBusy(false) }
        }}>{busy ? 'Starting…' : 'Start a new run'}</Button>
      </div>
      {bridge.runs.length ? (
        <ul className="space-y-2">
          {bridge.runs.map((run) => (
            <li key={run.id}>
              <button type="button" aria-label={`Open run ${run.id}`} className="w-full p-4 bg-surface-container rounded-xl flex items-start justify-between gap-3 hover:bg-surface-container-high text-left" onClick={() => void bridge.openRun(run.id)}>
                <span className="min-w-0 space-y-1">
                  <span className="block text-body-md break-words">{run.objective || 'Untitled run'}</span>
                  <span className="block font-mono text-label-sm text-on-surface-variant break-all">{run.id}</span>
                  <span className="block text-label-sm text-outline">{new Date(run.createdAt).toLocaleString()}{run.spend ? ` · $${run.spend.costUsd.toFixed(4)}${run.spend.unpricedCalls ? ' + unpriced calls' : ''}` : ''}</span>
                </span>
                <Chip tone={run.status === 'failed' ? 'bad' : run.status === 'review' || run.status === 'completed' ? 'ok' : 'idle'}>{run.status.replaceAll('_', ' ')}</Chip>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="text-body-md text-on-surface-variant">No runs yet. Start one, then describe what you want the Head AI to investigate or build.</p>}
    </section>
  )
}
