import { useEffect, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'

export function EcosystemView({ bridge }: { bridge: Bridge }) {
  const [filter, setFilter] = useState<'all' | 'skill' | 'plugin' | 'blueprint'>('all')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')

  useEffect(() => { void bridge.loadMarketplaceState(); void bridge.loadArsenalState() }, [bridge])

  const entries = bridge.marketplace?.entries ?? []
  const installedIds = new Set([...(bridge.arsenal?.skills ?? []), ...(bridge.arsenal?.plugins ?? [])].map((i: any) => i.id))

  const filtered = entries.filter((e: any) => {
    if (filter !== 'all' && e.kind !== filter) return false
    if (query) {
      const q = query.toLowerCase()
      const hay = `${e.id} ${e.description ?? ''} ${e.author ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  const install = async (id: string) => {
    setBusy(id)
    try { await bridge.installMarketplaceEntry(id) } finally { setBusy('') }
  }

  return (
    <div className="m3-eco-wrap">
      <div className="m3-eco-header">
        <div className="m3-eco-header-row">
          <div>
            <div className="m3-eco-breadcrumb">
              <span>Ecosystem</span>
              <span className="sep">/</span>
              <span className="current">Blueprints & Tooling</span>
            </div>
            <h1 className="m3-eco-title">Ecosystem & Blueprints</h1>
            <p className="m3-eco-subtitle">Skills, plugins, and team topologies. Hash-pinned, locally stored.</p>
          </div>
          <div className="m3-eco-actions">
            <div className="m3-eco-search">
              <span className="material-symbols-outlined">search</span>
              <input placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <button className="m3-eco-btn" onClick={() => void bridge.refreshMarketplace()} type="button">
              <span className="material-symbols-outlined">refresh</span>
              <span>Refresh</span>
            </button>
          </div>
        </div>

        <div className="m3-eco-filters">
          <div className="m3-eco-filter-pills">
            {(['all', 'skill', 'plugin', 'blueprint'] as const).map((f) => (
              <button key={f} className={`m3-eco-pill ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)} type="button">
                {f === 'all' ? 'All Items' : f === 'skill' ? 'Skill Packs' : f === 'plugin' ? 'Sandbox Plugins' : 'Blueprints'}
                <span className="m3-eco-pill-count">{f === 'all' ? entries.length : entries.filter((e: any) => e.kind === f).length}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {bridge.marketplace?.stale && (
        <div style={{ padding: '8px 12px', background: 'var(--surface-container)', borderRadius: 8, fontSize: 13, color: 'var(--on-surface-variant)' }}>
          The signed index has never been fetched — community imports still work.
        </div>
      )}

      <div className="m3-card-grid">
        {filtered.length === 0 ? (
          <div className="m3-empty" style={{ gridColumn: '1 / -1' }}>
            <div className="m3-empty-icon">◈</div>
            <div className="m3-empty-title">Nothing here</div>
            <div className="m3-empty-sub">Import a skill or refresh the marketplace to get started.</div>
          </div>
        ) : filtered.map((entry: any) => {
          const installed = installedIds.has(entry.id)
          return (
            <div className="m3-eco-card" key={entry.id}>
              <div className="m3-eco-card-top">
                <div className="m3-eco-card-head">
                  <div className="m3-eco-card-head-left">
                    <div className={`m3-eco-card-icon ${entry.kind === 'skill' ? 'tertiary' : 'primary'}`}>
                      <span className="material-symbols-outlined">{entry.kind === 'skill' ? 'layers' : entry.kind === 'plugin' ? 'hub' : 'security'}</span>
                    </div>
                    <div>
                      <span className={`m3-eco-card-type ${entry.kind === 'skill' ? 'tertiary' : 'primary'}`}>
                        {entry.kind === 'skill' ? 'Skill Pack' : entry.kind === 'plugin' ? 'Sandbox Plugin' : 'Team Blueprint'}
                      </span>
                      <h3 className="m3-eco-card-name">{entry.id}</h3>
                    </div>
                  </div>
                  {entry.trust === 'verified' ? (
                    <span className="m3-badge-verified"><span className="m3-badge-verified-dot" /> Verified</span>
                  ) : (
                    <span className="m3-badge-version">v{entry.version}</span>
                  )}
                </div>
                <p className="m3-eco-card-desc">{entry.description}</p>
                {entry.findings?.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--error)', fontFamily: 'var(--font)' }}>
                    ⚠ {entry.findings.map((f: any) => f.signal).join('; ')}
                  </div>
                )}
                <div className="m3-eco-card-tags">
                  {entry.author && <span className="m3-eco-card-tag">by {entry.author}</span>}
                  {entry.license && <span className="m3-eco-card-tag">{entry.license}</span>}
                </div>
              </div>
              <div className="m3-eco-card-foot">
                <span className="m3-eco-card-foot-meta">{entry.signals?.downloads ?? 0} downloads</span>
                {installed ? (
                  <span className="m3-badge-active"><span className="m3-badge-active-dot" /> Installed</span>
                ) : (
                  <button className="m3-btn-card" disabled={busy === entry.id} onClick={() => void install(entry.id)} type="button">
                    <span className="material-symbols-outlined primary">download</span>
                    <span>{busy === entry.id ? 'Installing…' : 'Install'}</span>
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="m3-eco-footer">
        <div className="m3-eco-footer-left">
          <div className="m3-eco-footer-icon"><span className="material-symbols-outlined">format_image_left</span></div>
          <div>
            <div className="m3-eco-footer-title">Local-First Storage</div>
            <div className="m3-eco-footer-desc">All manifests saved locally. No third-party telemetry.</div>
          </div>
        </div>
      </div>
    </div>
  )
}
