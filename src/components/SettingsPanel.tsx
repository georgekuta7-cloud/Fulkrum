import { useEffect, useState } from 'react'
import { Activity, Brain, Coins, Cpu, Database, KeyRound, Moon, ShieldCheck, SlidersHorizontal, Sun, TriangleAlert, X, Zap } from 'lucide-react'
import type { Bridge } from '../hooks/useBridge'
import type { AppSetting, Provider } from '../api/types'
import { ProviderEditor } from '../ProviderEditor'

const groupTitles: Record<string, string> = {
  bridge: 'Bridge',
  storage: 'Storage behavior',
  limits: 'Limits',
  providers: 'Provider behavior',
  budgets: 'Budgets',
  arsenal: 'Skills & marketplace',
  security: 'Security',
  execution: 'Execution boundary',
}

/** One tunable: an input shaped by its kind, a save that applies live unless badged. */
function SettingRow({ setting, onSave, onReset }: {
  setting: AppSetting
  onSave: (name: string, value: unknown) => Promise<unknown>
  onReset: (name: string) => Promise<unknown>
}) {
  const asText = (value: unknown) => (Array.isArray(value) ? value.join(', ') : String(value ?? ''))
  const [draft, setDraft] = useState(asText(setting.value))
  const [checked, setChecked] = useState(Boolean(setting.value))
  const [saving, setSaving] = useState(false)
  const locked = setting.source === 'env'
  const dirty = setting.kind === 'bool' ? checked !== Boolean(setting.value) : draft !== asText(setting.value)

  const save = async () => {
    setSaving(true)
    try {
      await onSave(setting.name, setting.kind === 'bool' ? checked : draft)
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className="setting-row">
      <div className="setting-name">
        <strong title={setting.description}>{setting.name}</strong>
        <span className="muted tiny">
          {locked ? 'set in environment' : setting.source === 'db' ? 'saved here' : 'default'}
          {setting.restartRequired ? ' · needs restart' : ''}
        </span>
      </div>
      <p className="muted tiny">{setting.description}</p>
      {setting.problem ? <p className="warning tiny">{setting.problem}</p> : null}
      <div className="deny-row">
        {setting.kind === 'bool' ? (
          <label className="provider-editor-check">
            <input type="checkbox" checked={checked} disabled={locked} onChange={(event) => setChecked(event.target.checked)} />
            <span>{checked ? 'on' : 'off'}</span>
          </label>
        ) : setting.kind === 'enum' ? (
          <select value={draft} disabled={locked} onChange={(event) => setDraft(event.target.value)}>
            {(setting.choices ?? []).map((choice) => (
              <option key={choice} value={choice}>{choice === '' ? 'Default' : choice}</option>
            ))}
          </select>
        ) : (
          <input
            value={draft}
            disabled={locked}
            inputMode={setting.kind === 'int' || setting.kind === 'port' || setting.kind === 'money' ? 'decimal' : undefined}
            placeholder={setting.kind === 'list' ? 'comma, separated, values' : `default: ${asText(setting.default)}`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void save() }}
          />
        )}
        <button type="button" className="tiny-button" disabled={!dirty || locked || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {setting.source === 'db' ? (
          <button type="button" className="tiny-button" title="Forget the saved value" onClick={() => void onReset(setting.name)}>Reset</button>
        ) : null}
      </div>
    </li>
  )
}

/**
 * The drawer: whether the thing is healthy, what it will let a worker do, and what it
 * spends. Playbooks, schedules, goals, and blueprints live under Automations now;
 * skills and plugins under Store and Arsenal — the drawer keeps health,
 * permissions, memory, and money, nothing else.
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
  const { status, providers, grants, learnings, projects, projectId, usage, configReport, verifyAudit, backupNow, testProvider, saveProvider, addProvider, removeProvider, createGrant, revokeGrant, deleteLearning, loadUsage } = bridge
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
                  <button type="button" className="icon" title={`Test ${provider.label}`} onClick={async () => {
                    setTests((current) => ({ ...current, [provider.id]: 'testing' }))
                    try {
                      const result = await testProvider(provider.id)
                      const value = result.result
                      setTests((current) => ({ ...current, [provider.id]: value.reachable ? `ok · ${value.latencyMs}ms · ${value.models?.length ?? 0} models` : String(value.error ?? value.reason ?? 'failed') }))
                    } catch (caught) {
                      // A failed probe must land as text, not as a button stuck
                      // on "testing": the request itself can throw (a 502 from
                      // an unreachable endpoint), not just report unreachable.
                      setTests((current) => ({ ...current, [provider.id]: String(caught instanceof Error ? caught.message : 'failed') }))
                    }
                  }}>
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

        <Section icon={<SlidersHorizontal size={14} />} title="Settings" note="everything tunable, no terminal needed">
          {bridge.appSettings.length === 0 ? <p className="muted">Loading settings…</p> : (
            Object.entries(
              bridge.appSettings.reduce<Record<string, AppSetting[]>>((groups, setting) => {
                ;(groups[setting.group] ??= []).push(setting)
                return groups
              }, {}),
            ).map(([group, settings]) => (
              <div key={group}>
                <p className="muted tiny"><strong>{groupTitles[group] ?? group}</strong></p>
                <ul className="grant-list">
                  {settings.map((setting) => (
                    <SettingRow
                      key={`${setting.name}:${JSON.stringify(setting.value)}`}
                      setting={setting}
                      onSave={async (name, value) => {
                        const saved = await bridge.saveSetting(name, value)
                        await Promise.all([bridge.loadProviders(), bridge.loadStatus()])
                        return saved
                      }}
                      onReset={async (name) => {
                        const reset = await bridge.resetSetting(name)
                        await Promise.all([bridge.loadProviders(), bridge.loadStatus()])
                        return reset
                      }}
                    />
                  ))}
                </ul>
              </div>
            ))
          )}
          <p className="muted tiny">Values set in the environment always win and are locked here. Anything else applies the moment it saves, except entries badged “needs restart”.</p>
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

        <Section icon={<Brain size={14} />} title="Learnings" note={projects.find((project) => project.id === projectId)?.name ?? 'no project open'}>
          {learnings.length ? (
            <ul className="grant-list">
              {learnings.map((learning) => (
                <li key={learning.id}>
                  <div className="grant-name">
                    <strong>{learning.fact}</strong>
                    <span className="muted tiny">{at(learning.createdAt)}{learning.sourceRunId ? ` · from run ${learning.sourceRunId.slice(0, 8)}` : ''}</span>
                  </div>
                  <button type="button" className="tiny-button" onClick={() => void deleteLearning(learning.id)}>forget</button>
                </li>
              ))}
            </ul>
          ) : <p className="muted">Nothing learned yet. Reviewed runs that produce evidence teach one to three facts each; the planner reads the recent ones.</p>}
          <p className="muted tiny">Memory you can edit: forgetting removes the fact, and future plans stop seeing it.</p>
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
