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

/** The answer to a worker question. Keyed by call so a draft typed for one question can never leak into the next. */
function AnswerBox({ onAnswer }: { onAnswer: (answer: string) => void }) {
  const [answer, setAnswer] = useState('')
  return (
    <span className="deny-row">
      <input autoFocus value={answer} placeholder="Answer — the worker continues on your words." onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onAnswer(answer) }} />
      <button type="button" className="primary" disabled={!answer.trim()} onClick={() => onAnswer(answer)}><CornerDownLeft size={13} /> Send answer</button>
    </span>
  )
}

/** Edit-and-approve for a pending write. Keyed by call so an edit always starts from what was proposed. */
function WriteEditor({ initial, path, onApprove }: { initial: string; path: string; onApprove: (input: { path: string; content: string }) => void }) {
  const [editing, setEditing] = useState(false)
  const [content, setContent] = useState(initial)
  if (!editing) return <button type="button" onClick={() => setEditing(true)}>Edit &amp; approve</button>
  return (
    <span className="deny-row">
      <textarea rows={4} value={content} onChange={(event) => setContent(event.target.value)} />
      <button type="button" className="primary" onClick={() => onApprove({ path, content })}><Check size={13} /> Approve edits</button>
      <button type="button" onClick={() => setEditing(false)}><X size={13} /></button>
    </span>
  )
}

export function ApprovalDock({ bridge }: { bridge: Bridge }) {
  const { approval, approveCall, denyCall, answerCall } = bridge
  const [reason, setReason] = useState('')
  const [showDeny, setShowDeny] = useState(false)

  const isQuestion = approval?.toolCall.kind === 'ask' || approval?.toolCall.name === 'run.ask'

  // Keyboard-first: this is the one surface where a decision is waiting on a person.
  useEffect(() => {
    if (!approval || isQuestion) return
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
  }, [approval, approveCall, isQuestion])

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
        {isQuestion ? (
          <div className="question">
            <p className="question-text">{String(toolCall.resolved?.question ?? 'The worker has a question.')}</p>
            {toolCall.resolved?.context ? <p className="muted">{String(toolCall.resolved.context)}</p> : null}
          </div>
        ) : (
          <>
            <ResolvedArguments resolved={toolCall.resolved} name={toolCall.name} />
            <DiffPreview preview={preview} />
          </>
        )}
        {warnings.length ? (
          <p className="warning">
            <AlertTriangle size={13} /> The arguments contain something shaped like a credential ({warnings.map((warning) => warning.kinds.join(', ')).join('; ')} in {warnings.map((warning) => warning.field).join(', ')}). It is stored redacted.
          </p>
        ) : null}
        {toolCall.fingerprint ? <p className="muted tiny">fingerprint {toolCall.fingerprint.slice(0, 16)}… — approving runs exactly this</p> : null}
      </div>

      <div className="approval-actions">
        {isQuestion ? (
          <AnswerBox key={toolCall.id} onAnswer={(text) => void answerCall(text)} />
        ) : (
          <>
            <button type="button" className="primary" onClick={() => void approveCall('once')}><Check size={14} /> Approve once <kbd>a</kbd></button>
            <button type="button" onClick={() => void approveCall('run')}>For this run <kbd>r</kbd></button>
            <button type="button" title={standing ? `Creates a standing grant: ${standing}` : 'This call cannot be made standing'} onClick={() => void approveCall('always')} disabled={!standing}>
              Always{standing ? ` (${standing.split(' under ')[1] ?? toolCall.resolved?.host ?? ''})` : ''}
            </button>
            {toolCall.name === 'workspace.write' && typeof preview?.content === 'string' ? (
              <WriteEditor key={toolCall.id} initial={preview.content} path={preview.path} onApprove={(input) => void approveCall('once', input)} />
            ) : null}
          </>
        )}
        {showDeny ? (
          <span className="deny-row">
            <input autoFocus value={reason} placeholder="Why not? The worker reads this." onChange={(event) => setReason(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void denyCall(reason || 'Denied by the user.') }} />
            <button type="button" className="danger" onClick={() => void denyCall(reason || 'Denied by the user.')}><CornerDownLeft size={13} /> Send</button>
            <button type="button" onClick={() => setShowDeny(false)}><X size={13} /></button>
          </span>
        ) : (
          <button type="button" className="danger" onClick={() => setShowDeny(true)}>{isQuestion ? 'Decline' : 'Deny'} <kbd>d</kbd></button>
        )}
      </div>
    </section>
  )
}
