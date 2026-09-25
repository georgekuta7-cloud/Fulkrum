import { useCallback, useEffect, useRef, useState } from 'react'
import type { Approval, Bridge } from '../hooks/useBridge'
import { roleLabel } from '../lib/runGraph'
import { Button, inputClass } from './primitives'
import { DiffView } from './DiffView'
import { Icon } from './Icon'

export function ApprovalCard({ bridge, approval }: { bridge: Bridge; approval: Approval }) {
  const [showDeny, setShowDeny] = useState(false)
  const [reason, setReason] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const denyButton = useRef<HTMLButtonElement>(null)
  const call = approval.toolCall
  const isQuestion = call.kind === 'ask' || call.name === 'run.ask'
  const isWrite = call.name === 'workspace.write'
  const canApprove = !isWrite || !!approval.preview
  const approve = bridge.approveCall
  const perform = useCallback(async (operation: () => Promise<unknown>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try { await operation() } finally { inFlight.current = false; setBusy(false) }
  }, [])

  useEffect(() => {
    if (isQuestion) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"]')) return
      if (event.key === 'd') { event.preventDefault(); denyButton.current?.click() }
      else if (canApprove && (event.key === 'a' || event.key === 'r')) {
        event.preventDefault()
        void perform(() => approve(event.key === 'a' ? 'once' : 'run'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [approve, canApprove, isQuestion, perform])

  return (
    <section className="bg-surface-container-low rounded-lg border border-outline-variant/40 border-l-2 border-l-secondary p-4 space-y-3 min-w-0" role="alert" aria-label={isQuestion ? 'Worker question' : 'Approval required'}>
      <div className="flex items-center gap-2 flex-wrap">
        <Icon name={isQuestion ? 'help' : 'gavel'} className="text-secondary text-lg" />
        <h2 className="text-label-lg font-semibold">{isQuestion ? 'Question' : 'Approval required'}</h2>
        <code className="font-mono text-label-sm text-on-surface-variant break-all">{call.name}</code>
        {call.agentId ? <span className="text-label-sm text-outline">from {roleLabel(call.agentId)}</span> : null}
      </div>
      {isQuestion ? (
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault()
          if (answer.trim()) void perform(async () => { if (await bridge.answerCall(answer.trim())) setAnswer('') })
        }}>
          <p className="text-body-md whitespace-pre-wrap break-words">{String(call.resolved?.question ?? 'The worker has a question.')}</p>
          {call.resolved?.context ? <p className="text-body-sm text-on-surface-variant whitespace-pre-wrap break-words">{String(call.resolved.context)}</p> : null}
          <label className="visually-hidden" htmlFor="approval-answer">Answer</label>
          <input id="approval-answer" className={`${inputClass} w-full`} placeholder="Answer…" value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={busy} />
          <div className="flex gap-2"><Button variant="primary" type="submit" disabled={busy || !answer.trim()}>Send</Button><Button variant="danger" disabled={busy} onClick={() => void perform(() => bridge.denyCall('Declined.'))}>Decline</Button></div>
        </form>
      ) : (
        <>
          {isWrite ? (
            approval.preview ? <div className="space-y-2 min-w-0">
              <p className="font-mono text-body-sm break-all">{approval.preview.path}</p>
              <DiffView diff={approval.preview} />
              <details className="text-body-sm"><summary className="cursor-pointer">Full proposed file ({approval.preview.bytes} bytes)</summary><pre aria-label="Proposed file contents" className="mt-2 max-h-80 overflow-auto whitespace-pre p-3 rounded-lg bg-surface-container-lowest border border-outline-variant/40 font-mono" tabIndex={0}>{approval.preview.content}</pre></details>
            </div> : <p className="text-body-sm text-on-surface-variant" role="status">Loading proposed changes before approval…</p>
          ) : <pre aria-label="Resolved tool arguments" className="p-3 rounded-lg bg-surface-container-lowest border border-outline-variant/40 font-mono text-body-sm whitespace-pre-wrap break-all max-h-80 overflow-auto" tabIndex={0}>{JSON.stringify(call.resolved ?? call.input, null, 2)}</pre>}
          {approval.warnings.length ? <p className="text-body-sm text-error">Credential-shaped values: {approval.warnings.map((warning) => warning.field).join(', ')}</p> : null}
          <details className="text-label-sm text-outline"><summary className="cursor-pointer">Approval identity and scope</summary><p className="mt-2">Rule: {approval.rule ?? 'approval required'}</p><p className="font-mono break-all">{call.fingerprint ?? 'No fingerprint reported.'}</p><p>“For run” allows {call.name} for the rest of this run. Deny rules still apply; the grant can be revoked below.</p></details>
          {showDeny ? (
            <form className="flex gap-2 flex-wrap" onSubmit={(event) => {
              event.preventDefault()
              void perform(async () => { if (await bridge.denyCall(reason.trim() || 'Denied.')) { setReason(''); setShowDeny(false) } })
            }}>
              <label className="visually-hidden" htmlFor="deny-reason">Why not</label>
              <input id="deny-reason" className={`${inputClass} flex-1 min-w-0`} autoFocus placeholder="Why not? The worker reads this." value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setShowDeny(false) } }} />
              <Button variant="danger" type="submit" disabled={busy}>Send</Button><Button disabled={busy} onClick={() => setShowDeny(false)}>Cancel</Button>
            </form>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="primary" disabled={busy || !canApprove} onClick={() => void perform(() => approve('once'))}>Approve <kbd>a</kbd></Button>
              <Button disabled={busy || !canApprove} onClick={() => void perform(() => approve('run'))}>For run <kbd>r</kbd></Button>
              <button ref={denyButton} type="button" disabled={busy} className="ml-auto px-3 py-2 rounded-lg text-label-md text-error border border-outline-variant/40 hover:bg-error-container/30 hover:border-error/40 disabled:opacity-40" onClick={() => setShowDeny(true)}>Deny <kbd>d</kbd></button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
