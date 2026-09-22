import { Check, X, HelpCircle } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'

export function EvidencePanel({ bridge }: { bridge: Bridge }) {
  const { claims, artifacts, byTask, spend, run } = bridge
  const proven = claims?.filter((c: any) => c.verdict === 'PASS').length ?? 0
  const total = claims?.length ?? 0
  const verdict = run?.status === 'review' ? (proven === total ? 'PASS' : proven === 0 ? 'FAIL' : 'PARTIAL') : null

  return (
    <aside className="evidence-panel">
      <div className="evidence-header">
        <span className="micro-label">Evidence</span>
      </div>

      {/* Claims */}
      <div className="evidence-section">
        <span className="micro-label">Claims</span>
        {(claims ?? []).length === 0 ? (
          <div className="evidence-empty">No claims yet.</div>
        ) : (
          <>
            {(claims ?? []).map((claim: any) => (
              <div key={claim.id} className="evidence-claim">
                <span className={`evidence-claim-icon ${claim.verdict === 'PASS' ? 'ok' : claim.verdict === 'FAIL' ? 'bad' : ''}`}>
                  {claim.verdict === 'PASS' ? <Check size={12} /> : claim.verdict === 'FAIL' ? <X size={12} /> : <HelpCircle size={12} />}
                </span>
                <span className="evidence-claim-text">{claim.summary}</span>
              </div>
            ))}
            <div className="evidence-claims-count">{proven}/{total} proven</div>
          </>
        )}
      </div>

      {/* Files touched */}
      <div className="evidence-section">
        <span className="micro-label">Files Touched</span>
        {(artifacts ?? []).length === 0 ? (
          <div className="evidence-empty">Nothing written yet.</div>
        ) : (
          (artifacts ?? []).map((a: any) => (
            <div key={a.id} className="evidence-file">
              <span className="evidence-file-path">{a.path}</span>
              <span className="evidence-file-stats">
                <span className="ok">+{a.added ?? 0}</span>
                <span className="bad">-{a.removed ?? 0}</span>
              </span>
            </div>
          ))
        )}
      </div>

      {/* Spend */}
      <div className="evidence-section">
        <span className="micro-label">Spend · ${(spend?.costUsd ?? 0).toFixed(2)}</span>
        {(byTask ?? []).length === 0 ? (
          <div className="evidence-empty">No calls yet.</div>
        ) : (
          (byTask ?? []).map((t: any) => (
            <div key={t.taskId ?? 'super'} className="evidence-spend">
              <span className="evidence-spend-role">{t.title || 'supervisor'} · {t.agentId}</span>
              <span className="evidence-spend-amount">${(t.costUsd ?? 0).toFixed(4)}</span>
            </div>
          ))
        )}
      </div>

      {/* Verdict */}
      {verdict && (
        <div className="evidence-section">
          <span className="micro-label">Verdict</span>
          <div className={`evidence-verdict evidence-verdict-${verdict.toLowerCase()}`}>
            {verdict === 'PASS' ? '✅ PASS' : verdict === 'FAIL' ? '❌ FAIL' : '⚠ PARTIAL'}
          </div>
        </div>
      )}
    </aside>
  )
}
