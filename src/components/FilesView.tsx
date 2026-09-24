import { useEffect, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { Button, Chip, EmptyState, Panel } from './primitives'

/**
 * What the run wrote: every artifact with its diff and a revert path, the
 * file history scrubber for time travel, and the workspace tree itself.
 * Diffs show additions and removals together — proof reads both directions.
 */

function ArtifactCard({ bridge, artifact }: { bridge: Bridge; artifact: any }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const hunks = artifact.diff?.hunks ?? []
  return (
    <div className="p-3 rounded-lg bg-surface-container flex flex-col gap-2">
      <button type="button" className="flex items-center justify-between gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={artifact.path}>
        <span className="font-mono text-body-sm text-on-surface truncate">{artifact.path}</span>
        <span className="flex items-center gap-2 flex-shrink-0">
          {artifact.diff ? (
            <span className="font-mono text-label-sm">
              <span className="text-tertiary">+{artifact.diff.added}</span> <span className="text-error">−{artifact.diff.removed}</span>
            </span>
          ) : <span className="font-mono text-label-sm text-on-surface-variant">{artifact.bytes} B</span>}
          <Chip tone={artifact.created ? 'ok' : 'idle'}>{artifact.created ? 'created' : 'modified'}</Chip>
        </span>
      </button>
      {open && hunks.length ? (
        <div className="rounded-lg bg-surface-container-lowest p-2.5 font-mono text-label-md leading-relaxed overflow-x-auto space-y-1">
          {hunks.slice(0, 3).map((h: any, hi: number) => (
            <div key={hi}>
              {(h.entries ?? []).slice(0, 12).map((e: any, ei: number) => (
                <div key={ei} className={`${e.type === 'add' ? 'text-tertiary bg-tertiary-container/30' : e.type === 'remove' ? 'text-error bg-error-container/30' : 'text-on-surface-variant'} px-1 rounded whitespace-pre`}>
                  {e.type === 'add' ? '+' : e.type === 'remove' ? '−' : ' '} {e.line}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      <div>
        <Button
          className="!px-2.5 !py-1 text-label-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await bridge.revertArtifact(artifact.toolCallId)
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Reverting…' : 'Revert to before this write'}
        </Button>
      </div>
    </div>
  )
}

function TimeTravel({ bridge }: { bridge: Bridge }) {
  const timeline = bridge.timeline
  const maxSeq = (bridge.events ?? []).length ? bridge.events[bridge.events.length - 1].sequence : 0
  if (!timeline) {
    return (
      <div>
        <Button onClick={() => void bridge.loadTimeline(maxSeq)} disabled={!maxSeq}>
          Scrub this run's file history
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <label className="visually-hidden" htmlFor="timeline-seq">Event index</label>
        <input
          id="timeline-seq"
          type="range"
          min={0}
          max={maxSeq}
          value={timeline.seq}
          className="flex-1 accent-primary"
          onChange={(e) => void bridge.loadTimeline(Number(e.target.value))}
        />
        <span className="font-mono text-label-md text-on-surface-variant whitespace-nowrap">event {timeline.seq}/{maxSeq}</span>
        <Button onClick={() => bridge.clearTimeline()}>Close</Button>
      </div>
      {timeline.gaps?.length ? <p className="text-label-sm text-error">Gaps the records cannot prove: {timeline.gaps.join('; ')}</p> : null}
      {timeline.files.length ? timeline.files.map((file: any) => (
          <div key={file.path} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-surface-container" title={file.path}>
          <span className="font-mono text-body-sm text-on-surface truncate">{file.path}</span>
          <Button className="!px-2.5 !py-1 text-label-sm" onClick={() => void bridge.restoreTimelineFile(file.path)}>Restore this version</Button>
        </div>
      )) : <p className="text-body-sm text-outline">No files written up to event {timeline.seq}.</p>}
    </div>
  )
}

function WorkspaceTree({ bridge }: { bridge: Bridge }) {
  const [path, setPath] = useState('.')
  const [entries, setEntries] = useState<Array<any>>([])
  const [history, setHistory] = useState<Record<string, Array<any>>>({})
  const { tree } = bridge
  useEffect(() => {
    let live = true
    void tree(path, 2).then((payload: any) => {
      if (live) setEntries(payload?.entries ?? [])
    }).catch(() => {
      if (live) setEntries([])
    })
    return () => { live = false }
  }, [tree, path])
  const up = path === '.' ? null : path.split('/').slice(0, -1).join('/') || '.'
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {up ? <Button className="!px-2 !py-1 text-label-sm" onClick={() => setPath(up)}>↑ up</Button> : null}
        <span className="font-mono text-label-md text-on-surface-variant truncate">{path}</span>
      </div>
      {entries.length ? entries.map((entry: any) => (
        <div key={entry.name}>
          <div className="flex items-center justify-between gap-2 py-1">
            {entry.kind === 'directory' ? (
              <button type="button" className="font-mono text-body-sm text-primary hover:underline truncate" onClick={() => setPath(path === '.' ? entry.name : `${path}/${entry.name}`)}>
                {entry.name}/
              </button>
            ) : (
              <span className="font-mono text-body-sm text-on-surface truncate">{entry.name}</span>
            )}
            <span className="font-mono text-label-sm text-outline flex-shrink-0">
              {entry.kind === 'directory' ? '' : `${entry.bytes ?? '?'} B `}
              {entry.kind === 'file' ? (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => {
                    const full = path === '.' ? entry.name : `${path}/${entry.name}`
                    if (history[full]) {
                      setHistory((current) => {
                        const next = { ...current }
                        delete next[full]
                        return next
                      })
                    } else {
                      void bridge.fileHistory(full).then((payload: any) => setHistory((current) => ({ ...current, [full]: payload?.calls ?? [] }))).catch(() => {})
                    }
                  }}
                >
                  history
                </button>
              ) : null}
            </span>
          </div>
          {(() => {
            const full = path === '.' ? entry.name : `${path}/${entry.name}`
            const calls = history[full]
            if (!calls) return null
            return (
              <div className="ml-4 mb-1 p-2 rounded bg-surface-container-lowest font-mono text-label-sm text-on-surface-variant">
                {calls.length ? calls.slice(-5).map((call: any, i: number) => (
                  <div key={i}>{call.name} · {call.status}{call.at ? ` · ${new Date(call.at).toLocaleString()}` : ''}</div>
                )) : 'No recorded calls touched this file.'}
              </div>
            )
          })()}
        </div>
      )) : <p className="text-body-sm text-outline">Empty or unreadable.</p>}
    </div>
  )
}

export function FilesView({ bridge }: { bridge: Bridge }) {
  if (!bridge.run) {
    return <EmptyState icon="difference" title="No run open" body="Files belong to runs. Open one from the chat to see what it wrote." />
  }
  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-4 flex flex-col gap-4">
      <Panel title="Artifacts" action={<span className="font-mono text-label-sm text-outline">{(bridge.artifacts ?? []).length} file(s)</span>}>
        {(bridge.artifacts ?? []).length ? (bridge.artifacts ?? []).map((a: any) => (
          <ArtifactCard key={a.toolCallId ?? a.path} bridge={bridge} artifact={a} />
        )) : <p className="text-body-sm text-outline">This run has not written any files.</p>}
      </Panel>
      <Panel title="Time travel">
        <TimeTravel bridge={bridge} />
      </Panel>
      <Panel title="Workspace">
        <WorkspaceTree bridge={bridge} />
      </Panel>
    </div>
  )
}
