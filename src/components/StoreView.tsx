import { useEffect, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { Button, Chip, EmptyState, Panel, inputClass } from './primitives'

/**
 * The store and the arsenal, side by side the way a package manager shows
 * them: everything installable on the left, everything installed on the
 * right. Verified entries carry the registry's signature; community entries
 * carry provenance, a scan, and a pin. Both install through the same human
 * approval — the Install button is the approval, and the hash is what was
 * reviewed. Staged bytes never leave the server.
 */

export function StoreView({ bridge }: { bridge: Bridge }) {
  const [query, setQuery] = useState('')
  const [trust, setTrust] = useState<'all' | 'verified' | 'community'>('all')
  const [importUrl, setImportUrl] = useState('')
  const [registryUrl, setRegistryUrl] = useState('')
  const [busy, setBusy] = useState(false)

  const { loadMarketplaceState, loadArsenalState } = bridge
  useEffect(() => {
    void loadMarketplaceState()
    void loadArsenalState()
  }, [loadMarketplaceState, loadArsenalState])

  const installedIds = new Set([...(bridge.arsenal?.skills ?? []), ...(bridge.arsenal?.plugins ?? [])].map((i: any) => i.id))
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const entries = (bridge.marketplace?.entries ?? []).filter((entry: any) => {
    if (trust !== 'all' && entry.trust !== trust) return false
    if (!words.length) return true
    return words.every((word) => `${entry.id} ${entry.description} ${entry.author ?? ''}`.toLowerCase().includes(word))
  })

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
    <div className="w-full max-w-7xl mx-auto px-4 py-4 grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
      <div className="xl:col-span-8 flex flex-col gap-4">
        <Panel
          title="Marketplace"
          action={
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg bg-surface-container-low p-0.5" role="group" aria-label="Trust filter">
                {(['all', 'verified', 'community'] as const).map((option) => (
                  <button key={option} type="button" aria-pressed={trust === option} className={`px-2.5 py-1 rounded-md text-label-md capitalize transition-colors ${trust === option ? 'bg-surface-container-highest text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`} onClick={() => setTrust(option)}>
                    {option}
                  </button>
                ))}
              </div>
              <Button onClick={() => void bridge.refreshMarketplace()}>Refresh</Button>
            </div>
          }
        >
          <label className="visually-hidden" htmlFor="store-search">Search marketplace</label>
          <input id="store-search" className={inputClass} placeholder="Search skills&" value={query} onChange={(e) => setQuery(e.target.value)} />
          {bridge.marketplace?.stale ? <p className="text-label-md text-error">The signed index has never been fetched — community imports below still work.</p> : null}
          {entries.length ? (
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {entries.map((entry: any) => {
                const installed = installedIds.has(entry.id)
                const medium = (entry.findings ?? []).filter((f: any) => f.severity === 'medium')
                return (
                  <li key={entry.id} className="flex flex-col gap-1.5 p-3 rounded-xl border border-outline-variant/40 bg-surface-container">
                    <div className="flex items-center gap-2 flex-wrap">
                      <strong className="text-body-md text-on-surface">{entry.id}</strong>
                      {entry.trust === 'verified' ? <Chip tone="ok">Verified</Chip> : <Chip tone="busy">Community</Chip>}
                      <span className="font-mono text-label-sm text-outline">v{entry.version}</span>
                      {entry.signals && (entry.signals.downloads > 0 || entry.signals.stars > 0) ? <span className="font-mono text-label-sm text-outline">↓{entry.signals.downloads} ★{entry.signals.stars}</span> : null}
                    </div>
                    <p className="text-body-sm text-on-surface-variant">{entry.description}</p>
                    <div className="flex gap-2 flex-wrap font-mono text-label-sm text-outline">
                      {entry.author ? <span>by {entry.author}</span> : null}
                      {entry.license ? <span>{entry.license}</span> : null}
                      {entry.compatibility ? <span title={entry.compatibility}>needs: {entry.compatibility}</span> : null}
                    </div>
                    {medium.length ? <p className="text-label-md text-error">Worth a look: {medium.map((f: any) => f.signal).join('; ')}</p> : null}
                    <div>
                      {installed ? (
                        <Chip tone="ok">Installed — see Arsenal</Chip>
                      ) : (
                        <Button variant="primary" disabled={busy} onClick={() => void bridge.installMarketplaceEntry(entry.id)}>{busy ? 'Installing…' : 'Install'}</Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <EmptyState icon="store" title="Nothing here matches" body="Import a skill below, or browse a public registry — imports land here for review before anything installs." />
          )}
        </Panel>

        <Panel title="Bring a skill in">
          <div className="flex gap-2 flex-wrap">
            <label className="visually-hidden" htmlFor="import-url">Skill URL</label>
            <input id="import-url" className={`${inputClass} flex-1 min-w-[200px]`} placeholder="https://&/SKILL.md (raw file URL)" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} />
            <Button variant="primary" disabled={busy || !importUrl.trim()} onClick={() => void doImport()}>Stage for review</Button>
          </div>
          <div className="flex gap-2 flex-wrap">
            <label className="visually-hidden" htmlFor="registry-url">Registry URL</label>
            <input id="registry-url" className={`${inputClass} flex-1 min-w-[200px]`} placeholder="Registry listing URL (ClawHub-compatible JSON)" value={registryUrl} onChange={(e) => setRegistryUrl(e.target.value)} />
            <Button disabled={busy || !registryUrl.trim()} onClick={() => void doBrowse()}>Browse</Button>
            {bridge.registry ? <Button onClick={() => bridge.clearRegistry()}>Clear</Button> : null}
          </div>
          {bridge.registry ? (
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {bridge.registry.candidates.map((candidate: any) => (
                <li key={candidate.id} className="flex flex-col gap-1.5 p-3 rounded-xl border border-outline-variant/40 bg-surface-container">
                  <div className="flex items-center gap-2">
                    <strong className="text-body-md text-on-surface">{candidate.id}</strong>
                    <span className="font-mono text-label-sm text-outline">v{candidate.version}</span>
                  </div>
                  <p className="text-body-sm text-on-surface-variant">{candidate.description || 'No description listed.'}</p>
                  {candidate.url ? (
                    <div>
                      <Button
                        variant="primary"
                        disabled={busy}
                        onClick={() => {
                          setBusy(true)
                          void bridge.importMarketplaceSkill({ url: candidate.url ?? '' }).finally(() => setBusy(false))
                        }}
                      >
                        Stage for review
                      </Button>
                    </div>
                  ) : <p className="text-label-md text-outline">Listed without downloadable bytes — find its SKILL.md and stage the URL above.</p>}
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      </div>

      <div className="xl:col-span-4">
        <Panel title="Arsenal" action={<span className="font-mono text-label-sm text-outline">{(bridge.arsenal?.skills ?? []).length + (bridge.arsenal?.plugins ?? []).length} installed</span>}>
          <p className="text-body-sm text-on-surface-variant">What the workers can use. Skills inject as reference at task start; plugins serve tools under the permission matrix.</p>
          {[...(bridge.arsenal?.skills ?? []), ...(bridge.arsenal?.plugins ?? [])].map((item: any) => (
            <div key={`${item.kind}:${item.id}`} className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-surface-container">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <strong className="text-body-md text-on-surface truncate">{item.id}</strong>
                  {item.version ? <span className="font-mono text-label-sm text-outline">v{item.version}</span> : <Chip tone="idle">local-only</Chip>}
                  {item.updateAvailable ? <Chip tone="busy">update</Chip> : null}
                </div>
                <p className="text-label-md text-outline truncate">{item.tool ?? item.kind}{item.description ? ` · ${item.description}` : ''}</p>
              </div>
              <Button variant="danger" className="!px-2.5 !py-1 text-label-sm flex-shrink-0" onClick={() => void bridge.uninstallMarketplaceEntry(item.id)}>Remove</Button>
            </div>
          ))}
          {!(bridge.arsenal?.skills ?? []).length && !(bridge.arsenal?.plugins ?? []).length ? (
            <p className="text-body-sm text-outline">Nothing installed yet. Installing a staged skill lands it here.</p>
          ) : null}
        </Panel>
      </div>
    </div>
  )
}
