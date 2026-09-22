import { useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import type { Provider } from '../api/types'

/**
 * Provider/model picker — the human chooses which AI to use.
 * Format sent to the server: "Label · model" or just "Label".
 */
export function ProviderSelect({ bridge, role = 'head', label = 'using' }: { bridge: Bridge; role?: string; label?: string }) {
  const [open, setOpen] = useState(false)
  const configured = bridge.providers.filter((p: Provider) => p.configured)
  const current = (bridge.projectSettings?.routing as Record<string, string> | undefined)?.[role] ?? ''

  const select = async (provider: Provider, model?: string) => {
    const route = model && model !== provider.model ? `${provider.label} · ${model}` : provider.label
    await bridge.saveRouting(role, route)
    setOpen(false)
  }

  if (!configured.length) {
    return <span className="muted tiny">no provider</span>
  }

  const display = current || `${configured[0].label} · ${configured[0].model}`

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="tiny-button"
        onClick={() => setOpen(!open)}
        title="Choose which AI model to use"
        style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {label} {display}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: 240,
          background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 4,
          boxShadow: 'var(--shadow)', zIndex: 50, maxHeight: 300, overflow: 'auto', padding: 4,
        }}>
          {configured.map((provider: Provider) => (
            <div key={provider.id}>
              <button
                type="button"
                onClick={() => void select(provider)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px',
                  background: 'transparent', border: 'none', borderRadius: 3,
                  color: 'var(--text)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'left',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ color: 'var(--ok)', fontSize: 10 }}>●</span>
                <span>{provider.label}</span>
                <span style={{ color: 'var(--muted)', fontSize: 10, marginLeft: 'auto' }}>{provider.model}</span>
              </button>
            </div>
          ))}
          <div style={{ height: 1, background: 'var(--line)', margin: '4px 0' }} />
          <div style={{ padding: '4px 10px', fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
            Model saved per-role. Change it anytime.
          </div>
        </div>
      )}
    </div>
  )
}
