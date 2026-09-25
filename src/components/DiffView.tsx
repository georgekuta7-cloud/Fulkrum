import type { LineDiff } from '../api/types'

export function DiffView({ diff }: { diff: LineDiff }) {
  if (diff.truncated) return <p className="text-body-sm text-on-surface-variant">{diff.reason ?? 'This diff is too large to display.'}</p>
  if (!diff.hunks?.length) return <p className="text-body-sm text-on-surface-variant">No line changes.</p>
  return (
    <div className="max-h-80 overflow-auto rounded-lg bg-surface-container-lowest border border-outline-variant/40 p-2.5 font-mono text-body-sm" aria-label="File diff" tabIndex={0}>
      {diff.hunks.map((hunk, index) => (
        <div key={index}>
          <p className="text-outline py-1 text-label-sm tracking-[0.04em]">@@ {hunk.beforeStart ?? '—'} → {hunk.afterStart ?? '—'} @@</p>
          {hunk.entries.map((entry, line) => (
            <pre key={line} className={`px-1 ${entry.type === 'add' ? 'text-secondary bg-secondary/10' : entry.type === 'remove' ? 'text-error bg-error/10' : 'text-on-surface-variant'}`}>
              {entry.type === 'add' ? '+' : entry.type === 'remove' ? '−' : ' '} {entry.line}
            </pre>
          ))}
        </div>
      ))}
    </div>
  )
}
