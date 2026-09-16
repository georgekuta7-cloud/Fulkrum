import { useEffect, useState } from 'react'
import { AlertTriangle, Check, CornerDownLeft, ShieldAlert, X } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'

/**
 * The pending call, and everything needed to decide it.
 *
 * This is the surface the whole permission system exists to reach, so it shows the
 * resolved call rather than a summary: the rule that stopped it, the absolute paths
 * or the final argv or the host that will be used, anything in the arguments that
 * looks like a credential, and — for a write — the diff it would make. The buttons
 * are the scopes the server supports, and "always" names the scope it would create
 * rather than promising something it will not do.
 */

function ResolvedArguments({ resolved, name }: { resolved: Record<string, any> | null; name: string }) {
  if (!resolved) return <p className="muted">No resolved arguments — this call could not be resolved.</p>
  if (Array.isArray(resolved.argv)) {
    return (
      <pre className="code-block">{resolved.argv.map((part: string) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')}{'\n'}<span className="muted">in {resolved.cwd}</span></pre>
    )
  }
  if (resolved.url) {
    return (
      <pre className="code-block">{resolved.method} {resolved.url}{resolved.headerNames?.length ? `\nheaders: ${resolved.headerNames.join(', ')}` : ''}{resolved.bodySha256 ? `\nbody sha256: ${String(resolved.bodySha256).slice(0, 16)}…` : ''}</pre>
    )
  }
  if (resolved.relative) {
    return (
      <pre className="code-block">{name === 'workspace.write' ? `write ${resolved.relative}` : `${name.split('.')[1]} ${resolved.relative}`}{resolved.bytes !== undefined ? `\n${resolved.bytes} bytes · sha256 ${String(resolved.contentSha256 ?? '').slice(0, 16)}…` : ''}{resolved.query ? `\nquery: ${resolved.query}` : ''}</pre>
    )
  }
  return <pre className="code-block">{JSON.stringify(resolved, null, 2)}</pre>
}

function DiffPreview({ preview }: { preview: any }) {
  if (!preview) return null
  const hunks = Array.isArray(preview.hunks) ? preview.hunks : []
  return (
    <div className="preview">
      <div className="preview-head">
        <span>{preview.created ? 'creates' : 'changes'} <strong>{preview.path}</strong></span>
        <span className="muted">
          {preview.created ? `${preview.bytes} bytes` : `+${preview.added} / -${preview.removed}`}
        </span>
      </div>
      {preview.truncated ? <p className="muted">{preview.reason}</p> : null}
      <div className="diff">
        {hunks.slice(0, 3).map((hunk: any, hunkIndex: number) => (
          <div className="diff-hunk" key={hunkIndex}>
            {hunk.entries.slice(0, 40).map((entry: any, entryIndex: number) => (
              <div className={`diff-line ${entry.type}`} key={entryIndex}>
                <span className="diff-gutter">{entry.type === 'add' ? '+' : entry.type === 'remove' ? '−' : ' '}</span>
                <span className="diff-text">{entry.line}</span>
              </div>
            ))}
          </div>
        ))}
        {hunks.length > 3 ? <p className="muted">{hunks.length - 3} more hunk(s) — see the Artifacts tab after it runs.</p> : null}
      </div>
    </div>
  )
}

export function ApprovalDock({ bridge }: { bridge: Bridge }) {
  const { approval, approveCall, denyCall } = bridge
  const [reason, setReason] = useState('')
  const [showDeny, setShowDeny] = useState(false)

  // Keyboard-first: this is the one surface where a decision is waiting on a person.
  useEffect(() => {
    if (!approval) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.key === 'a') void approveCall('once')
      else if (event.key === 'd') { setShowDeny(true); event.preventDefault() }
      else if (event.key === 'r') void approveCall('run')
      else if (event.key === 'Escape') setShowDeny(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [approval, approveCall])

  if (!approval) return null
  const { toolCall, rule, warnings, preview } = approval
  const standing = toolCall.resolved?.relative && toolCall.resolved.relative.includes('/')
    ? `${toolCall.name.split('.')[0]}.${toolCall.name.split('.')[1]} under ${toolCall.resolved.relative.replace(/\/[^/]*$/, '/')}`
    : null

  return (
    <section className="approval-dock" aria-live="polite">
      <header className="approval-head">
        <ShieldAlert size={15} />
        <strong>{toolCall.name}</strong>
        <span className="kind-chip">{toolCall.kind}</span>
        {rule ? <span className="rule-chip" title="The rule in the permission matrix that stopped this call">{rule}</span> : null}
        <span className="muted">{toolCall.error}</span>
      </header>

      <div className="approval-body">
        <ResolvedArguments resolved={toolCall.resolved} name={toolCall.name} />
        <DiffPreview preview={preview} />
        {warnings.length ? (
          <p className="warning">
            <AlertTriangle size={13} /> The arguments contain something shaped like a credential ({warnings.map((warning) => warning.kinds.join(', ')).join('; ')} in {warnings.map((warning) => warning.field).join(', ')}). It is stored redacted.
          </p>
        ) : null}
        {toolCall.fingerprint ? <p className="muted tiny">fingerprint {toolCall.fingerprint.slice(0, 16)}… — approving runs exactly this</p> : null}
      </div>

      <div className="approval-actions">
        <button type="button" className="primary" onClick={() => void approveCall('once')}><Check size={14} /> Approve once <kbd>a</kbd></button>
        <button type="button" onClick={() => void approveCall('run')}>For this run <kbd>r</kbd></button>
        <button type="button" title={standing ? `Creates a standing grant: ${standing}` : 'This call cannot be made standing'} onClick={() => void approveCall('always')} disabled={!standing}>
          Always{standing ? ` (${standing.split(' under ')[1] ?? toolCall.resolved?.host ?? ''})` : ''}
        </button>
        {showDeny ? (
          <span className="deny-row">
            <input autoFocus value={reason} placeholder="Why not? The worker reads this." onChange={(event) => setReason(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void denyCall(reason || 'Denied by the user.') }} />
            <button type="button" className="danger" onClick={() => void denyCall(reason || 'Denied by the user.')}><CornerDownLeft size={13} /> Send</button>
            <button type="button" onClick={() => setShowDeny(false)}><X size={13} /></button>
          </span>
        ) : (
          <button type="button" className="danger" onClick={() => setShowDeny(true)}>Deny <kbd>d</kbd></button>
        )}
      </div>
    </section>
  )
}
