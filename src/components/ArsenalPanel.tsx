import { useEffect, useState } from 'react'
import { Boxes, Trash2 } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'
import type { ArsenalItem } from '../api/types'

/**
 * My library: what the AIs can actually use. Skills inject as reference at
 * task start (trigger-matched, max two); plugins serve tools through the
 * broker under the permission matrix. A version means the bytes match a
 * catalog pin; "local-only" means hand-placed, trusted by hand, not by hash.
 * Uninstall removes the files and revokes the scoped grants with them.
 */

function ArsenalRow({ bridge, item }: { bridge: Bridge; item: ArsenalItem }) {
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    setBusy(true)
    try {
      await bridge.uninstallMarketplaceEntry(item.id)
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="market-card">
      <div className="market-card-head">
        <strong>{item.id}</strong>
        {item.version ? (
          <span className="muted tiny">v{item.version}</span>
        ) : (
          <span className="trust community" title="Placed by hand, not pinned to any catalog entry">local-only</span>
        )}
        {item.tool ? <span className="muted tiny mono">{item.tool}</span> : null}
        {item.updateAvailable ? <span className="status-chip busy">Update available</span> : null}
      </div>
      <p className="muted">{item.description || 'No description.'}</p>
      <div className="deny-row">
        <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
          <Trash2 size={13} /> {busy ? 'Removing…' : 'Uninstall'}
        </button>
      </div>
    </li>
  )
}

export function ArsenalPanel({ bridge }: { bridge: Bridge }) {
  useEffect(() => {
    void bridge.loadArsenalState()
    void bridge.loadMarketplaceState()
  }, [bridge])

  const empty = bridge.arsenal.skills.length === 0 && bridge.arsenal.plugins.length === 0

  return (
    <section className="panel market">
      <div className="market-toolbar">
        <h2><Boxes size={15} /> Arsenal</h2>
        <span className="muted tiny">{bridge.arsenal.skills.length} skill(s) · {bridge.arsenal.plugins.length} plugin(s) installed</span>
      </div>
      {empty ? (
        <div className="panel-empty">
          <h2>Nothing installed yet</h2>
          <p className="muted">The Marketplace stages skills for review; installing one lands it here, where workers can use it.</p>
        </div>
      ) : (
        <>
          {bridge.arsenal.skills.length ? (
            <>
              <h3>Skills — reference at task start</h3>
              <ul className="market-grid">
                {bridge.arsenal.skills.map((item) => (
                  <ArsenalRow key={item.id} bridge={bridge} item={item} />
                ))}
              </ul>
            </>
          ) : null}
          {bridge.arsenal.plugins.length ? (
            <>
              <h3>Plugins — tools under the permission matrix</h3>
              <ul className="market-grid">
                {bridge.arsenal.plugins.map((item) => (
                  <ArsenalRow key={item.id} bridge={bridge} item={item} />
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  )
}
