import { useEffect, useState } from 'react'
import { Activity, Coins, Cpu, Database, KeyRound, Moon, ShieldCheck, Sun, TriangleAlert, X, Zap } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'
import type { Provider } from '../api/types'
import { ProviderEditor } from '../ProviderEditor'

/**
 * The drawer: whether the thing is healthy, what it will let a worker do, and what it
 * spends.
 *
 * Everything here answers a question the rest of the interface raises — why a call was
 * denied, why a provider is not used, whether the audit log still verifies, what has
 * been allowed to run unattended — so it is one place rather than four.
 */

const bytes = (value: number | null | undefined) => (value === null || value === undefined ? '—' : value > 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : value > 1_000 ? `${(value / 1_000).toFixed(1)} kB` : `${value} B`)

/**
 * Ages come from what the server already measured, and timestamps are shown as they
 * are: reading the clock during a render is what makes a display disagree with itself
 * between two renders of the same data.
 */
const ageLabel = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return 'never'
  const seconds = Math.max(Math.round(ms / 1000), 0)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

const at = (timestamp: number | null) => (timestamp ? new Date(timestamp).toLocaleString() : 'never')

function Section({ icon, title, note, children }: { icon: React.ReactNode; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="drawer-section">
      <div className="drawer-section-head">
        {icon}
        <strong>{title}</strong>
        {note ? <span className="muted tiny">{note}</span> : null}
      </div>
      {children}
    </section>
  )
}

export function SettingsPanel({ bridge, theme, setTheme, onClose }: { bridge: Bridge; theme: 'dark' | 'light'; setTheme: (theme: 'dark' | 'light') => void; onClose: () => void }) {
  const { status, providers, grants, usage, configReport, verifyAudit, backupNow, testProvider, saveProvider, addProvider, removeProvider, createGrant, revokeGrant, loadUsage } = bridge
  const [editing, setEditing] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [newProvider, setNewProvider] = useState({ label: '', baseUrl: '', model: '', apiKey: '' })
  const [grantDraft, setGrantDraft] = useState({ toolName: 'workspace.write', scopeKind: 'path' as 'path' | 'host', scopeValue: '' })
  const [tests, setTests] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')

  // The spend summary is only worth fetching when someone is looking at it.
  useEffect(() => { void loadUsage(30) }, [loadUsage])

  const engine = status?.execution

  return (
    <div className="drawer-layer">
      <button className="drawer-backdrop" type="button" aria-label="Close settings" onClick={onClose} />
      <aside className="drawer">
        <header className="drawer-head">
          <div>
            <p className="eyebrow">Workspace</p>
            <h2>State, permissions, spend</h2>
          </div>
          <button type="button" className="icon" onClick={onClose} title="Close"><X size={16} /></button>
        </header>

        {configReport?.problems.length ? (
          <div className="warning">
            <TriangleAlert size={13} />
            <div>
              <strong>{configReport.problems.length} setting(s) could not be used as given:</strong>
              <ul>{configReport.problems.map((problem) => <li key={problem.name}>{problem.name}: {problem.message} (using {JSON.stringify(problem.using)})</li>)}</ul>
            </div>
          </div>
        ) : null}

        <Section icon={<Database size={14} />} title="Storage" note={`schema v${status?.schemaVersion ?? '—'}`}>
          <ul className="kv">
            <li><span>Database</span><strong>{bytes(status?.storage.databaseBytes)}{status?.storage.walBytes ? ` + ${bytes(status.storage.walBytes)} WAL` : ''}</strong></li>
            <li><span>Backups</span><strong>{status?.backups.count ?? 0} · newest {ageLabel(status?.backups.newestAgeMs)}</strong></li>
            <li><span>Anchors</span><strong>{status?.anchor.count ?? 0} in {status?.anchor.file ?? 'disabled'}</strong></li>
            <li><span>Retention</span><strong>{status?.retention.toolOutputDays ?? '—'} day(s) for output, input and turns</strong></li>
            <li><span>Last verify</span><strong className={status?.lastVerify && !status.lastVerify.ok ? 'bad' : ''}>{status?.lastVerify ? `${status.lastVerify.ok ? 'intact' : 'PROBLEM'} · ${at(status.lastVerify.createdAt)}` : 'never'}</strong></li>
          </ul>
          <div className="drawer-actions">
            <button type="button" onClick={async () => { setBusy('verify'); await verifyAudit(); setBusy('') }} disabled={busy === 'verify'}>
              <ShieldCheck size={13} /> {busy === 'verify' ? 'Verifying…' : 'Verify audit log'}
            </button>
            <button type="button" onClick={async () => { setBusy('backup'); await backupNow(); setBusy('') }} disabled={busy === 'backup'}>
              <Database size={13} /> {busy === 'backup' ? 'Copying…' : 'Back up now'}
            </button>
          </div>
          {status?.lastVerify ? <p className="muted tiny">{status.lastVerify.summary}</p> : null}
        </Section>

        <Section icon={<Cpu size={14} />} title="Execution" note={engine?.available ? `${engine.label} ${engine.version}` : 'disabled'}>
          {engine?.available ? (
            <ul className="kv">
              <li><span>Image</span><strong>{engine.image}</strong></li>
              <li><span>Digest</span><strong>{engine.imagePinned ? 'pinned' : 'by tag only'}</strong></li>
              <li><span>Running now</span><strong>{engine.running?.length ?? 0}</strong></li>
            </ul>
          ) : (
            <p className="muted">{engine?.reason}<br />{engine?.hint}</p>
          )}
        </Section>

        <Section icon={<Zap size={14} />} title="Providers" note={`${providers.filter((provider) => provider.configured).length} connected`}>
          <ul className="provider-list">
            {providers.map((provider: Provider) => (
              <li key={provider.id}>
                <div className="provider-row">
                  <span className={`dot ${provider.configured ? 'on' : ''}`} />
                  <div className="provider-name">
                    <strong>{provider.label}</strong>
                    <span className="muted tiny">
                      {provider.model} · {provider.keySource === 'stored' ? 'key stored locally' : provider.keySource === 'env' ? `key from ${provider.envKey}` : provider.authStyle === 'none' ? 'no key needed' : `add ${provider.envKey || 'a key'}`}
                      {provider.allowPrivate ? ' · local network' : ''}
                      {provider.temperature === 'omit' ? ' · no temperature' : ''}
                      {status?.providers.find((entry) => entry.id === provider.id)?.breaker?.open ? ' · skipped after failures' : ''}
                    </span>
                  </div>
                  <button type="button" className="icon" title={`Test ${provider.label}`} onClick={async () => { setTests((current) => ({ ...current, [provider.id]: 'testing' })); const result = await testProvider(provider.id); const value = result.result; setTests((current) => ({ ...current, [provider.id]: value.reachable ? `ok · ${value.latencyMs}ms · ${value.models?.length ?? 0} models` : String(value.error ?? value.reason ?? 'failed') })) }}>
                    <Zap size={13} />
                  </button>
                  <button type="button" className="tiny-button" onClick={() => setEditing(editing === provider.id ? null : provider.id)}>{editing === provider.id ? 'close' : 'edit'}</button>
                  {provider.custom ? <button type="button" className="icon danger" title={`Remove ${provider.label}`} onClick={() => void removeProvider(provider.id)}><X size={12} /></button> : null}
                </div>
                {tests[provider.id] && tests[provider.id] !== 'testing' ? <p className="muted tiny">{tests[provider.id]}</p> : null}
                {editing === provider.id ? (
                  <ProviderEditor
                    provider={provider}
                    isSaving={saving}
                    error={settingsError}
                    onCancel={() => setEditing(null)}
                    onSave={async (settings) => {
                      setSaving(true)
                      setSettingsError('')
                      try {
                        await saveProvider(provider, settings)
                        setEditing(null)
                      } catch (caught) {
                        setSettingsError(caught instanceof Error ? caught.message : 'Could not save.')
                      } finally {
                        setSaving(false)
                      }
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          <form
            className="inline-form stacked"
            onSubmit={async (event) => {
              event.preventDefault()
              setSettingsError('')
              try {
                await addProvider(newProvider)
                setNewProvider({ label: '', baseUrl: '', model: '', apiKey: '' })
              } catch (caught) {
                setSettingsError(caught instanceof Error ? caught.message : 'Could not add the provider.')
              }
            }}
          >
            <input value={newProvider.label} placeholder="Name" onChange={(event) => setNewProvider((current) => ({ ...current, label: event.target.value }))} />
            <input value={newProvider.baseUrl} placeholder="Base URL" onChange={(event) => setNewProvider((current) => ({ ...current, baseUrl: event.target.value }))} />
            <input value={newProvider.model} placeholder="Model" onChange={(event) => setNewProvider((current) => ({ ...current, model: event.target.value }))} />
            <input type="password" autoComplete="off" value={newProvider.apiKey} placeholder="API key (empty if none)" onChange={(event) => setNewProvider((current) => ({ ...current, apiKey: event.target.value }))} />
            <button type="submit" className="primary">Add provider</button>
          </form>
        </Section>

        <Section icon={<KeyRound size={14} />} title="Standing grants" note="allowed repeatedly, within a scope">
          {grants.length ? (
            <ul className="grant-list">
              {grants.map((grant) => (
                <li key={grant.id}>
                  <span className="kind-chip">{grant.scopeKind}</span>
                  <div className="grant-name">
                    <strong>{grant.label}</strong>
                    <span className="muted tiny">used {grant.useCount} time(s) · last {at(grant.lastUsedAt)}</span>
                  </div>
                  <button type="button" className="tiny-button" onClick={() => void revokeGrant(grant.id)}>revoke</button>
                </li>
              ))}
            </ul>
          ) : <p className="muted">Nothing is allowed unattended. A call that needs approval can be approved once, for the run, or always within a scope.</p>}
          <form
            className="inline-form stacked"
            onSubmit={async (event) => {
              event.preventDefault()
              try {
                await createGrant(grantDraft.toolName, grantDraft.scopeKind, grantDraft.scopeValue)
                setGrantDraft((current) => ({ ...current, scopeValue: '' }))
                setSettingsError('')
              } catch (caught) {
                setSettingsError(caught instanceof Error ? caught.message : 'Could not create the grant.')
              }
            }}
          >
            <select value={grantDraft.toolName} onChange={(event) => setGrantDraft((current) => ({ ...current, toolName: event.target.value }))}>
              {['workspace.write', 'workspace.read', 'workspace.search', 'workspace.list', 'http.request'].map((tool) => <option key={tool} value={tool}>{tool}</option>)}
            </select>
            <select value={grantDraft.scopeKind} onChange={(event) => setGrantDraft((current) => ({ ...current, scopeKind: event.target.value as 'path' | 'host' }))}>
              <option value="path">a directory</option>
              <option value="host">a host</option>
            </select>
            <input value={grantDraft.scopeValue} placeholder={grantDraft.scopeKind === 'path' ? 'src/docs' : 'api.example.com'} onChange={(event) => setGrantDraft((current) => ({ ...current, scopeValue: event.target.value }))} />
            <button type="submit">Allow</button>
          </form>
          <p className="muted tiny">A command cannot be made standing: its arguments have no boundary. Deny rules still win over any grant.</p>
        </Section>

        <Section icon={<Coins size={14} />} title="Spend" note={usage ? `last ${usage.days} day(s)` : ''}>
          {usage ? (
            <>
              <ul className="kv">
                <li><span>Total</span><strong>${usage.totals.costUsd.toFixed(4)}</strong></li>
                <li><span>Calls</span><strong>{usage.totals.calls}{usage.totals.unpricedCalls ? ` (${usage.totals.unpricedCalls} unpriced)` : ''}</strong></li>
              </ul>
              {usage.byModel.length ? (
                <table className="mini-table">
                  <thead><tr><th>model</th><th>calls</th><th>cost</th></tr></thead>
                  <tbody>{usage.byModel.map((entry) => <tr key={entry.key}><td>{entry.key}</td><td>{entry.calls}</td><td>${entry.costUsd.toFixed(4)}{entry.unpricedCalls ? '+' : ''}</td></tr>)}</tbody>
                </table>
              ) : <p className="muted tiny">No priced calls yet.</p>}
            </>
          ) : <p className="muted tiny">Ask for it in the panel below.</p>}
        </Section>

        <Section icon={<Activity size={14} />} title="Appearance">
          <div className="drawer-actions">
            <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />} {theme === 'dark' ? 'Light' : 'Dark'} theme
            </button>
            <span className="muted tiny">Keyboard: <kbd>a</kbd> approve · <kbd>d</kbd> deny · <kbd>r</kbd> for the run · <kbd>ctrl</kbd>+<kbd>↵</kbd> send · <kbd>esc</kbd> close</span>
          </div>
        </Section>
      </aside>
    </div>
  )
}
