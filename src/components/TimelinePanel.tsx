import { X } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'

/**
 * Time travel, read-only until you say otherwise. The slider walks the run's
 * event index; the panel shows what the run's written files looked like then,
 * with honest gaps where the records cannot prove an answer. Restore writes
 * old bytes through the same approval path as any write — scrubbing never
 * edits anything by itself.
 */
export function TimelinePanel({ bridge, maxSeq, onClose }: { bridge: Bridge; maxSeq: number; onClose: () => void }) {
  const { timeline, loadTimeline, clearTimeline, restoreTimelineFile } = bridge
  const seq = timeline?.seq ?? maxSeq

  return (
    <section className="worker-sheet" aria-label="Timeline">
      <div className="worker-sheet-head">
        <strong>Timeline</strong>
        <span className="muted tiny">read-only{timeline ? ` · event ${timeline.seq} of ${maxSeq}` : ''}</span>
        <input
          type="range"
          min={0}
          max={maxSeq}
          value={seq}
          aria-label="Event index"
          onChange={(event) => void loadTimeline(Number(event.target.value))}
          style={{ flex: 1, minWidth: 120 }}
        />
        <button type="button" className="tiny-button primary" onClick={() => { clearTimeline(); onClose() }}>Live</button>
        <button type="button" className="icon sheet-close" onClick={() => { clearTimeline(); onClose() }} title="Close"><X size={14} /></button>
      </div>

      <div className="worker-sheet-body">
        {!timeline ? (
          <p className="muted tiny">Drag to an event index to see the run's files as they were then.</p>
        ) : timeline.files.length === 0 ? (
          <p className="muted tiny">No files written up to event {timeline.seq}.</p>
        ) : (
          <div className="sheet-calls">
            {timeline.files.map((file) => (
              <div className="sheet-call" key={file.path}>
                <span className={`sheet-call-ic ${file.unknown ? 'warn' : 'ok'}`}>{file.unknown ? '?' : '✓'}</span>
                <span><code>{file.path}</code></span>
                <span className="muted tiny">
                  {file.unknown ? `unknown — ${file.unknown}` : file.content === null ? 'did not exist yet' : `${file.content.split('\n').length} lines${file.truncated ? ' (truncated)' : ''}`}
                </span>
                {!file.unknown && file.content !== null ? (
                  <button type="button" className="tiny-button" title={`Restore ${file.path} to event ${timeline.seq}`} onClick={() => void restoreTimelineFile(file.path)}>
                    Restore
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {timeline && timeline.gaps.length ? (
          <p className="warning tiny">Gaps the records cannot prove: {timeline.gaps.join(', ')}</p>
        ) : null}
      </div>
    </section>
  )
}
