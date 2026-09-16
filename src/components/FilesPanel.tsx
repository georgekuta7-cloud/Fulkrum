import { useEffect, useState } from 'react'
import { FileDiff, FolderTree, RotateCcw } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'
import type { TreeNode } from '../api/types'

/**
 * What the run changed, and what the workspace looks like.
 *
 * The diff comes from the snapshot taken immediately before each write, so it is the
 * actual change; a revert restores those bytes through the same approval path as any
 * other write, which is why it is offered here rather than being automatic.
 */

function DiffView({ artifact }: { artifact: any }) {
  const diff = artifact.diff
  if (!artifact.diffAvailable) return <p className="muted tiny">No snapshot was taken for this file (it predates snapshots, or it was too large).</p>
  if (!diff || !diff.hunks?.length) return <p className="muted tiny">The file was written with identical content.</p>
  return (
    <div className="diff">
      {diff.hunks.map((hunk: any, index: number) => (
        <div className="diff-hunk" key={index}>
          {hunk.entries.map((entry: any, entryIndex: number) => (
            <div className={`diff-line ${entry.type}`} key={entryIndex}>
              <span className="diff-gutter">{entry.type === 'add' ? '+' : entry.type === 'remove' ? '−' : ' '}</span>
              <span className="diff-text">{entry.line}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function Tree({ nodes, onPick, depth = 0 }: { nodes: TreeNode[]; onPick: (path: string) => void; depth?: number }) {
  return (
    <ul className="tree" style={{ paddingLeft: depth ? 14 : 0 }}>
      {nodes.map((node) => (
        <li key={node.path} className={`tree-node ${node.kind}`}>
          {node.kind === 'file' ? (
            <button type="button" className="tree-file" onClick={() => onPick(node.path)}>
              {node.name} <span className="muted tiny">{node.bytes !== null && node.bytes !== undefined ? `${node.bytes} B` : ''}</span>
            </button>
          ) : (
            <span className="tree-label" title={node.kind === 'sensitive' ? 'A credential file: tools refuse it' : node.kind === 'link' ? 'A link: reported, never followed' : node.kind === 'skipped' ? 'Skipped by the tool rules' : undefined}>
              {node.name}
              {node.kind !== 'directory' ? <span className={`kind-chip ${node.kind}`}>{node.kind}</span> : null}
            </span>
          )}
          {node.children?.length ? <Tree nodes={node.children} onPick={onPick} depth={depth + 1} /> : null}
        </li>
      ))}
    </ul>
  )
}

export function FilesPanel({ bridge }: { bridge: Bridge }) {
  const { tree, fileHistory, revertArtifact } = bridge
  const [nodes, setNodes] = useState<TreeNode[] | null>(null)
  const [treeError, setTreeError] = useState('')
  const [picked, setPicked] = useState<{ path: string; calls: any[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    // The answer arrives after the await, and an unmount in between must not set
    // state on a component that is gone.
    let ignore = false
    void (async () => {
      try {
        const result = await tree('.', 2)
        if (!ignore) {
          setNodes(result.entries)
          setTreeError('')
        }
      } catch (caught) {
        if (!ignore) setTreeError(caught instanceof Error ? caught.message : 'The workspace could not be listed.')
      }
    })()
    return () => { ignore = true }
  }, [tree, reloadToken])

  const pick = async (path: string) => {
    setBusy(true)
    try {
      const result = await fileHistory(path)
      setPicked({ path, calls: result.calls })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="files-panel">
      <section className="files-tree">
        <div className="panel-bar">
          <FolderTree size={14} />
          <strong>Workspace</strong>
          <span className="muted tiny">as the tools see it — skipped, sensitive and linked entries are named, not opened</span>
          <button type="button" className="tiny-button" onClick={() => setReloadToken((token) => token + 1)}>refresh</button>
        </div>
        {treeError ? <p className="warning">{treeError}</p> : null}
        {nodes ? <Tree nodes={nodes} onPick={(path) => void pick(path)} /> : <p className="muted">Loading…</p>}
      </section>

      <section className="file-history">
        <div className="panel-bar">
          <FileDiff size={14} />
          <strong>{picked ? picked.path : 'Pick a file'}</strong>
          <span className="muted tiny">{picked ? `${picked.calls.length} call(s) across runs` : 'every tool call that touched it, newest first'}</span>
        </div>
        {busy ? <p className="muted">Loading…</p> : null}
        {picked && !picked.calls.length ? <p className="muted">No run has touched this file.</p> : null}
        <ul className="history-list">
          {(picked?.calls ?? []).map((call) => (
            <li key={call.id} className={`history-item ${call.kind}`}>
              <span className={`kind-chip ${call.kind}`}>{call.kind}</span>
              <span className="history-name">{call.name}</span>
              <span className="muted tiny">{call.runId.slice(0, 16)} · {new Date(call.at).toLocaleString()}</span>
              <span className={`status-chip ${call.status === 'completed' ? 'ok' : call.status === 'failed' ? 'bad' : 'idle'}`}>{call.status}</span>
              {call.kind === 'write' && call.status === 'completed' ? (
                <button type="button" className="tiny-button" title="Restore the contents from before this write" onClick={() => void revertArtifact(call.id)}>
                  <RotateCcw size={12} /> revert
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

export function ArtifactsPanel({ bridge }: { bridge: Bridge }) {
  const { artifacts, revertArtifact } = bridge
  const [open, setOpen] = useState<string | null>(null)

  if (!artifacts.length) {
    return <div className="panel-empty"><p>This run has not written any files. When a worker writes one, the change and its diff appear here.</p></div>
  }

  return (
    <div className="artifacts-panel">
      <ul className="artifact-list">
        {artifacts.map((artifact) => {
          const isOpen = open === artifact.toolCallId
          return (
            <li className={`artifact ${isOpen ? 'open' : ''}`} key={artifact.toolCallId}>
              <div className="artifact-head">
                <button type="button" className="artifact-toggle" onClick={() => setOpen(isOpen ? null : artifact.toolCallId)}>
                  <span className={`kind-chip ${artifact.created ? 'created' : 'modified'}`}>{artifact.created ? 'created' : 'modified'}</span>
                  <strong>{artifact.path}</strong>
                  <span className="muted tiny">
                    {artifact.diff?.added !== undefined ? `+${artifact.diff.added} / -${artifact.diff.removed}` : `${artifact.bytes} B`}
                    {artifact.agentId ? ` · ${artifact.agentId}` : ''}
                  </span>
                </button>
                <button type="button" className="tiny-button" title="Restore the contents from before this write" onClick={() => void revertArtifact(artifact.toolCallId)}>
                  <RotateCcw size={12} /> revert
                </button>
              </div>
              {isOpen ? <DiffView artifact={artifact} /> : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
