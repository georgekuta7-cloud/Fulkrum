import { useState } from 'react'
import { FileText, ShieldCheck, Trash2 } from 'lucide-react'

type DiffEntry = {
  type: 'context' | 'add' | 'remove'
  line: string
  beforeLine: number | null
  afterLine: number | null
}

type DiffHunk = {
  beforeStart: number | null
  afterStart: number | null
  entries: DiffEntry[]
}

export type Artifact = {
  toolCallId: string
  agentId: string | null
  path: string
  bytes: number
  created: boolean
  previousBytes: number | null
  previousTruncated: boolean
  diffAvailable: boolean
  diff: { truncated: boolean; entries: DiffEntry[]; hunks?: DiffHunk[]; added: number | null; removed: number | null; reason?: string } | null
  at: number
}

export type Grant = {
  id: string
  toolName: string
  kind: string
  grantedAt: number
}

const speaker = (agentId: string | null) => (agentId === 'research' ? 'Scout' : agentId === 'builder' ? 'Forge' : 'Head AI')

/**
 * What the run actually changed. Diffs come from a snapshot taken immediately
 * before each write, so a file that shows no diff genuinely did not change, and
 * one written before snapshots existed says so instead of pretending.
 */
export function ArtifactsPanel({ artifacts, grants, onRevoke, isLoading }: { artifacts: Artifact[]; grants: Grant[]; onRevoke: (toolName: string) => void; isLoading: boolean }) {
  const [openPath, setOpenPath] = useState<string | null>(null)

  return (
    <div className="artifacts-panel">
      {grants.length ? (
        <div className="grant-strip">
          <ShieldCheck size={14} />
          <span className="grant-label">Auto-approved for this run</span>
          {grants.map((grant) => (
            <span className="grant-chip" key={grant.id}>
              {grant.toolName}
              <button className="grant-revoke" type="button" title={`Revoke ${grant.toolName} for this run`} onClick={() => onRevoke(grant.toolName)}>
                <Trash2 size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {isLoading && !artifacts.length ? <p className="empty-note">Loading artifacts...</p> : null}
      {!isLoading && !artifacts.length ? <p className="empty-note">No files have been written by this run yet. When a worker writes, the change and its diff appear here.</p> : null}

      {artifacts.map((artifact) => {
        const open = openPath === artifact.toolCallId
        const added = artifact.diff?.added ?? 0
        const removed = artifact.diff?.removed ?? 0
        return (
          <article className="artifact" key={artifact.toolCallId}>
            <button className="artifact-head" type="button" onClick={() => setOpenPath(open ? null : artifact.toolCallId)}>
              <FileText size={14} />
              <span className="artifact-path">{artifact.path}</span>
              <span className="artifact-meta">{artifact.created ? 'created' : 'modified'}</span>
              {artifact.diffAvailable ? <span className="artifact-counts"><i className="plus">+{added}</i><i className="minus">-{removed}</i></span> : <span className="artifact-meta">diff unavailable</span>}
              <span className="artifact-meta">{speaker(artifact.agentId)}</span>
            </button>

            {open ? (
              <div className="artifact-body">
                {!artifact.diffAvailable ? (
                  <p className="empty-note">This file was written before snapshots were recorded, so the previous contents are unknown and no diff can be shown. The file itself is on disk.</p>
                ) : artifact.diff?.truncated ? (
                  <p className="empty-note">{artifact.diff.reason ?? 'This file is too large to diff.'}</p>
                ) : added === 0 && removed === 0 ? (
                  <p className="empty-note">The write left the file unchanged.</p>
                ) : (
                  (artifact.diff?.hunks ?? []).map((hunk, index) => (
                    <div className="diff-hunk" key={`${artifact.toolCallId}-hunk-${index}`}>
                      <div className="diff-range">before {hunk.beforeStart ?? 0} · after {hunk.afterStart ?? 0}</div>
                      {hunk.entries.map((entry, entryIndex) => (
                        <div className={`diff-line ${entry.type}`} key={`${entryIndex}-${entry.beforeLine ?? 'a'}-${entry.afterLine ?? 'b'}`}>
                          <span className="diff-gutter">{entry.type === 'add' ? entry.afterLine : entry.beforeLine ?? ''}</span>
                          <span className="diff-sign">{entry.type === 'add' ? '+' : entry.type === 'remove' ? '-' : ' '}</span>
                          <code>{entry.line || ' '}</code>
                        </div>
                      ))}
                    </div>
                  ))
                )}
                {artifact.previousTruncated ? <p className="artifact-note">The previous version was larger than the snapshot limit, so it was not kept in full.</p> : null}
              </div>
            ) : null}
          </article>
        )
      })}
    </div>
  )
}
