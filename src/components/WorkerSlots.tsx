import type { Bridge } from '../hooks/useBridge'
import type { Provider } from '../api/types'

const roleInfo: Record<string, { name: string; emoji: string; subtitle: string; color: string }> = {
  research: { name: 'Research', emoji: '🔍', subtitle: 'Scout & analyze', color: 'var(--accent)' },
  builder: { name: 'Builder', emoji: '🔨', subtitle: 'Code & implement', color: 'var(--busy)' },
}

/**
 * Worker Slots — pick which AI plays which role, and how many workers there are.
 * Shown on project creation and in the plan panel before drafting.
 */
export function WorkerSlots({ bridge, workers, onWorkersChange }: {
  bridge: Bridge
  workers: Array<{ role: string; provider: string }>
  onWorkersChange: (workers: Array<{ role: string; provider: string }>) => void
}) {
  const configured = bridge.providers.filter((p: Provider) => p.configured)
  const maxWorkers = 8

  const addWorker = () => {
    if (workers.length >= maxWorkers) return
    const role = workers.length % 2 === 0 ? 'research' : 'builder'
    const provider = configured[0] ? `${configured[0].label} · ${configured[0].model}` : ''
    onWorkersChange([...workers, { role, provider }])
  }

  const removeWorker = (index: number) => {
    if (workers.length <= 1) return
    onWorkersChange(workers.filter((_, i) => i !== index))
  }

  const updateWorker = (index: number, patch: { role?: string; provider?: string }) => {
    onWorkersChange(workers.map((w, i) => i === index ? { ...w, ...patch } : w))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
        <div style={{ fontFamily: 'var(--sans)', fontSize: 18, fontWeight: 700, letterSpacing: '-0.3px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 3, height: 20, background: 'var(--accent)', borderRadius: 2, boxShadow: '0 0 8px rgba(0,212,255,0.5)' }} />
          Workers
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => removeWorker(workers.length - 1)}
            disabled={workers.length <= 1}
            style={{
              width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8,
              color: 'var(--text)', cursor: workers.length > 1 ? 'pointer' : 'not-allowed',
              fontSize: 20, opacity: workers.length > 1 ? 1 : 0.3,
            }}
          >−</button>
          <div style={{ fontFamily: 'var(--sans)', fontSize: 32, fontWeight: 700, color: 'var(--accent)', minWidth: 40, textAlign: 'center', fontVariantNumeric: 'tabular-nums', textShadow: '0 0 20px rgba(0,212,255,0.3)' }}>
            {workers.length}
          </div>
          <button
            onClick={addWorker}
            disabled={workers.length >= maxWorkers}
            style={{
              width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8,
              color: 'var(--text)', cursor: workers.length < maxWorkers ? 'pointer' : 'not-allowed',
              fontSize: 20, opacity: workers.length < maxWorkers ? 1 : 0.3,
            }}
          >+</button>
        </div>
      </div>

      {/* Worker slots */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {workers.map((worker, index) => {
          const info = roleInfo[worker.role] ?? roleInfo.research
          const provider = configured.find((p) => `${p.label} · ${p.model}` === worker.provider)
          return (
            <div key={index} style={{
              background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8,
              padding: '16px 20px', position: 'relative', overflow: 'hidden', borderLeft: `3px solid ${info.color}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
                  background: worker.role === 'research' ? 'rgba(0,212,255,0.15)' : 'rgba(255,170,0,0.15)',
                  border: `1px solid ${info.color}`,
                }}>{info.emoji}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: 'var(--sans)', fontSize: 15, fontWeight: 600, letterSpacing: '-0.2px' }}>{info.name}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{info.subtitle}</div>
                </div>
                {workers.length > 1 && (
                  <button onClick={() => removeWorker(index)} style={{
                    width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'transparent', border: '1px solid transparent', borderRadius: 6,
                    color: 'var(--muted)', cursor: 'pointer', fontSize: 14,
                  }}>✕</button>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--muted)', marginBottom: 6 }}>Role</div>
                  <select
                    value={worker.role}
                    onChange={(e) => updateWorker(index, { role: e.target.value })}
                    style={{
                      width: '100%', padding: '8px 12px', background: 'var(--surface-2)',
                      border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)',
                      fontFamily: 'var(--mono)', fontSize: 12, cursor: 'pointer',
                    }}
                  >
                    <option value="research">Research</option>
                    <option value="builder">Builder</option>
                  </select>
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '1.5px', color: 'var(--muted)', marginBottom: 6 }}>AI Model</div>
                  <select
                    value={worker.provider}
                    onChange={(e) => updateWorker(index, { provider: e.target.value })}
                    style={{
                      width: '100%', padding: '8px 12px', background: 'var(--surface-2)',
                      border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)',
                      fontFamily: 'var(--mono)', fontSize: 12, cursor: 'pointer',
                    }}
                  >
                    <option value="">Select AI</option>
                    {configured.map((p) => (
                      <option key={p.id} value={`${p.label} · ${p.model}`}>{p.label} · {p.model}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-soft)', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: provider ? 'var(--ok)' : 'var(--warn)', boxShadow: provider ? '0 0 4px rgba(0,204,136,0.5)' : 'none' }} />
                  {provider ? 'Ready' : 'No AI selected'}
                </div>
                <div>~{worker.role === 'research' ? '$0.02' : '$0.05'}/call</div>
                <div>Access: Skills + Plugins</div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Add button */}
      <button
        onClick={addWorker}
        disabled={workers.length >= maxWorkers}
        style={{
          width: '100%', padding: 14, background: 'transparent', border: '2px dashed var(--line)',
          borderRadius: 8, color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12,
          cursor: workers.length < maxWorkers ? 'pointer' : 'not-allowed',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          opacity: workers.length < maxWorkers ? 1 : 0.3,
        }}
      >
        <span style={{ fontSize: 16 }}>+</span> Add worker
      </button>

      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', textAlign: 'center' }}>
        Workers run in parallel. Dependencies run in order. Head AI oversees all.
      </div>
    </div>
  )
}
