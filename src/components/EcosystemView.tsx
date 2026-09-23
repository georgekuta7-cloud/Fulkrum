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
      if (!`${e.id} ${e.description ?? ''} ${e.author ?? ''}`.toLowerCase().includes(q)) return false
    }
    return true
  })

  const install = async (id: string) => {
    setBusy(id)
    try { await bridge.installMarketplaceEntry(id) } finally { setBusy('') }
  }

  return (
    <div className="w-full px-6 py-6 space-y-6">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-label-lg text-on-surface-variant">
              <span>Ecosystem</span><span className="text-secondary">/</span>
              <span className="text-primary font-medium">Blueprints & Tooling</span>
            </div>
            <h1 className="text-headline-lg font-semibold tracking-tight text-on-surface mt-1">Ecosystem & Blueprints</h1>
            <p className="text-body-sm text-on-surface-variant mt-0.5">Skills, plugins, and team topologies. Hash-pinned, locally stored.</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative w-full md:w-80">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-on-surface-variant pointer-events-none">search</span>
              <input className="w-full pl-9 pr-4 py-2 bg-surface-container text-body-sm text-on-surface placeholder:text-on-surface-variant/50 rounded focus:outline-none focus:bg-surface-container-high transition-colors" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <button className="h-8 px-3 rounded bg-surface-container text-label-lg font-medium text-on-surface hover:bg-surface-container-high transition-colors flex items-center gap-1.5" onClick={() => void bridge.refreshMarketplace()}>
              <span className="material-symbols-outlined text-base text-primary">refresh</span> Refresh
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(['all', 'skill', 'plugin', 'blueprint'] as const).map((f) => (
            <button key={f} className={`px-3.5 py-1.5 rounded-full text-label-lg font-medium transition-colors flex items-center gap-1.5 ${filter === f ? 'bg-primary-container text-on-primary-container shadow-sm' : 'bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'}`} onClick={() => setFilter(f)}>
              <span>{f === 'all' ? 'All Items' : f === 'skill' ? 'Skill Packs' : f === 'plugin' ? 'Sandbox Plugins' : 'Blueprints'}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${filter === f ? 'bg-primary/20 text-on-primary-container' : 'bg-surface-container-highest text-secondary'}`}>{f === 'all' ? entries.length : entries.filter((e: any) => e.kind === f).length}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.length === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center py-16 text-center">
            <div className="material-symbols-outlined text-6xl text-primary mb-4">deployed_code</div>
            <h2 className="text-headline-md font-semibold text-on-surface mb-2">Nothing here</h2>
            <p className="text-body-md text-on-surface-variant">Import a skill or refresh the marketplace.</p>
          </div>
        ) : filtered.map((entry: any) => {
          const installed = installedIds.has(entry.id)
          return (
            <div className="bg-surface-container rounded-xl p-4 flex flex-col justify-between space-y-4 hover:bg-surface-container-high/60 transition-colors" key={entry.id}>
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded flex items-center justify-center ${entry.kind === 'skill' ? 'bg-tertiary-container/30 text-tertiary' : 'bg-primary-container/30 text-primary'}`}>
                      <span className="material-symbols-outlined">{entry.kind === 'skill' ? 'layers' : entry.kind === 'plugin' ? 'hub' : 'security'}</span>
                    </div>
                    <div>
                      <span className={`text-[10px] font-mono uppercase tracking-wider font-semibold ${entry.kind === 'skill' ? 'text-tertiary' : 'text-primary'}`}>
                        {entry.kind === 'skill' ? 'Skill Pack' : entry.kind === 'plugin' ? 'Sandbox Plugin' : 'Team Blueprint'}
                      </span>
                      <h3 className="text-body-md font-semibold text-on-surface leading-tight">{entry.id}</h3>
                    </div>
                  </div>
                  {entry.trust === 'verified' ? (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-tertiary-container/30 text-on-tertiary-container text-[10px] font-mono font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-tertiary" /> Verified
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono text-secondary px-2 py-0.5 rounded bg-surface-container-lowest">v{entry.version}</span>
                  )}
                </div>
                <p className="text-body-sm text-on-surface-variant leading-relaxed">{entry.description}</p>
                {entry.findings?.length > 0 && (
                  <p className="text-[11px] text-error">⚠ {entry.findings.map((f: any) => f.signal).join('; ')}</p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {entry.author && <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant">by {entry.author}</span>}
                  {entry.license && <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-surface-container-high text-on-surface-variant">{entry.license}</span>}
                </div>
              </div>
              <div className="pt-3 flex items-center justify-between gap-2">
                <span className="text-[11px] font-mono text-secondary">{entry.signals?.downloads ?? 0} downloads</span>
                {installed ? (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-tertiary-container/30 text-on-tertiary-container text-[10px] font-mono font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-tertiary" /> Installed
                  </span>
                ) : (
                  <button className="px-3 py-1.5 rounded bg-surface-container-highest text-label-lg text-on-surface hover:bg-surface-container transition-colors flex items-center gap-1.5 disabled:opacity-40" disabled={busy === entry.id} onClick={() => void install(entry.id)}>
                    <span className="material-symbols-outlined text-sm text-primary">download</span>
                    <span>{busy === entry.id ? 'Installing…' : 'Install'}</span>
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="p-4 bg-surface-container-low rounded-lg flex flex-col md:flex-row items-center justify-between gap-4 text-body-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-surface-container-highest flex items-center justify-center text-tertiary flex-shrink-0">
            <span className="material-symbols-outlined">format_image_left</span>
          </div>
          <div>
            <div className="font-medium text-on-surface">Local-First Storage</div>
            <div className="text-[11px] text-on-surface-variant">All manifests saved locally. No third-party telemetry.</div>
          </div>
        </div>
      </div>
    </div>
  )
}
