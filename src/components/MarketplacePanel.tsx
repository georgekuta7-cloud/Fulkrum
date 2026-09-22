import { useEffect, useMemo, useState } from 'react'
import { Download, PackageSearch, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'
import type { MarketplaceEntry } from '../api/types'

/**
 * The store: everything installable, verified and community side by side,
 * with the trust difference visible instead of fine-printed. Verified entries
 * carry the registry's signature; community entries carry provenance, a scan,
 * and a pin. Both install through the same human approval — the Install
 * button is the approval, and the hash is what was reviewed.
 */

function TrustBadge({ entry }: { entry: MarketplaceEntry }) {
  if (entry.trust === 'verified') {
    return <span className="trust verified" title="Signed by the registry index"><ShieldCheck size={12} /> Verified</span>
  }
  return <span className="trust community" title={`Staged from ${entry.provenance?.source ?? 'an import'} · hash-pinned, not registry-signed`}>Community</span>
}

function EntryCard({ bridge, entry, installed }: { bridge: Bridge; entry: MarketplaceEntry; installed: boolean }) {
  const [busy, setBusy] = useState(false)
  const findings = entry.findings ?? []
  const medium = findings.filter((finding) => finding.severity === 'medium')

  const install = async () => {
    setBusy(true)
    try {
      await bridge.installMarketplaceEntry(entry.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="market-card">
      <div className="market-card-head">
        <strong>{entry.id}</strong>
        <TrustBadge entry={entry} />
        <span className="muted tiny">v{entry.version}</span>
        {entry.signals && (entry.signals.downloads > 0 || entry.signals.stars > 0) ? (
          <span className="muted tiny">↓{entry.signals.downloads} ★{entry.signals.stars}</span>
        ) : null}
      </div>
      <p className="muted">{entry.description}</p>
      <div className="market-meta muted tiny">
        {entry.author ? <span>by {entry.author}</span> : null}
        {entry.license ? <span>{entry.license}</span> : null}
        {entry.compatibility ? <span title={entry.compatibility}>needs: {entry.compatibility}</span> : null}
        {entry.allowedTools ? <span title={entry.allowedTools}>tools: {entry.allowedTools}</span> : null}
      </div>
      {medium.length ? (
        <p className="warning tiny"><ShieldAlert size={12} /> Worth a look: {medium.map((finding) => finding.signal).join('; ')}</p>
      ) : null}
      <div className="deny-row">
        {installed ? (
          <span className="status-chip ok">Installed — see Arsenal</span>
        ) : (
          <button type="button" className="primary" disabled={busy} onClick={() => void install()}>
            <Download size={13} /> {busy ? 'Installing…' : 'Install'}
          </button>
        )}
      </div>
    </li>
  )
}

export function MarketplacePanel({ bridge }: { bridge: Bridge }) {
  const [query, setQuery] = useState('')
  const [trust, setTrust] = useState<'all' | 'verified' | 'community'>('all')
  const [importUrl, setImportUrl] = useState('')
  const [registryUrl, setRegistryUrl] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void bridge.loadMarketplaceState()
    void bridge.loadArsenalState()
  }, [bridge])

  const installedIds = useMemo(
    () => new Set([...bridge.arsenal.skills, ...bridge.arsenal.plugins].map((item) => item.id)),
    [bridge.arsenal],
  )

  const entries = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return bridge.marketplace.entries.filter((entry) => {
      if (trust !== 'all' && entry.trust !== trust) return false
      if (!words.length) return true
      const haystack = `${entry.id} ${entry.description} ${entry.author ?? ''}`.toLowerCase()
      return words.every((word) => haystack.includes(word))
    })
  }, [bridge.marketplace.entries, query, trust])

  const doImport = async () => {
    if (!importUrl.trim()) return
    setBusy(true)
    try {
      await bridge.importMarketplaceSkill({ url: importUrl.trim() })
      setImportUrl('')
    } finally {
      setBusy(false)
    }
  }

  const doBrowse = async () => {
    if (!registryUrl.trim()) return
    setBusy(true)
    try {
      await bridge.browseRegistry(registryUrl.trim())
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel market">
      <div className="market-toolbar">
        <h2><PackageSearch size={15} /> Marketplace</h2>
        <input value={query} placeholder="Search skills…" onChange={(event) => setQuery(event.target.value)} aria-label="Search marketplace" />
        <div className="view-toggle" role="tablist" aria-label="Trust filter">
          {(['all', 'verified', 'community'] as const).map((option) => (
            <button key={option} type="button" role="tab" aria-selected={trust === option} className={trust === option ? 'on' : ''} onClick={() => setTrust(option)}>
              {option === 'all' ? 'All' : option === 'verified' ? 'Verified' : 'Community'}
            </button>
          ))}
        </div>
        <button type="button" className="icon" title="Re-fetch the signed index" aria-label="Refresh marketplace" onClick={() => void bridge.refreshMarketplace()}>
          <RefreshCw size={14} />
        </button>
      </div>

      {bridge.marketplace.stale ? (
        <p className="warning">The signed index has never been fetched — community imports below still work.</p>
      ) : null}

      {entries.length ? (
        <ul className="market-grid">
          {entries.map((entry) => (
            <EntryCard key={entry.id} bridge={bridge} entry={entry} installed={installedIds.has(entry.id)} />
          ))}
        </ul>
      ) : (
        <div className="panel-empty">
          <h2>Nothing here matches</h2>
          <p className="muted">Import a skill below, or browse a public registry — imports land here for review before anything installs.</p>
        </div>
      )}

      <div className="market-import">
        <h3>Bring a skill in</h3>
        <div className="deny-row">
          <input value={importUrl} placeholder="https://…/SKILL.md (raw file URL)" onChange={(event) => setImportUrl(event.target.value)} aria-label="Skill URL to import" />
          <button type="button" className="primary" disabled={busy || !importUrl.trim()} onClick={() => void doImport()}>Stage for review</button>
        </div>
        <div className="deny-row">
          <input value={registryUrl} placeholder="https://… registry listing (ClawHub-compatible JSON)" onChange={(event) => setRegistryUrl(event.target.value)} aria-label="Registry URL to browse" />
          <button type="button" disabled={busy || !registryUrl.trim()} onClick={() => void doBrowse()}>Browse</button>
          {bridge.registry ? <button type="button" className="icon" onClick={() => bridge.clearRegistry()} title="Clear registry results" aria-label="Clear registry results">✕</button> : null}
        </div>
        {bridge.registry ? (
          <ul className="market-grid">
            {bridge.registry.candidates.map((candidate) => (
              <li key={candidate.id} className="market-card">
                <div className="market-card-head">
                  <strong>{candidate.id}</strong>
                  <span className="muted tiny">v{candidate.version}</span>
                  {candidate.signals && (candidate.signals.downloads > 0 || candidate.signals.stars > 0) ? (
                    <span className="muted tiny">↓{candidate.signals.downloads} ★{candidate.signals.stars}</span>
                  ) : null}
                </div>
                <p className="muted">{candidate.description || 'No description listed.'}</p>
                {candidate.url ? (
                  <div className="deny-row">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => {
                        setImportUrl(candidate.url ?? '')
                        setBusy(true)
                        void bridge.importMarketplaceSkill({ url: candidate.url ?? '' }).finally(() => setBusy(false))
                      }}
                    >
                      <Download size={13} /> Stage for review
                    </button>
                  </div>
                ) : (
                  <p className="muted tiny">Listed without downloadable bytes — find its SKILL.md and stage the URL above.</p>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  )
}
