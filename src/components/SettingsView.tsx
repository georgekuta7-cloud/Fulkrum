import { useEffect, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import { roleLabel } from '../lib/runGraph'
import { Button, Chip, Panel, inputClass, selectClass } from './primitives'
import { ProviderCard } from './ProviderCard'
import { Icon, type IconName } from './Icon'

/**
 * Settings as a full view, reachable without a run — keys before runs is the
 * whole point. Providers with real probes, casting from configured providers,
 * the sandbox as the runner reports it, budgets that write through live, and
 * the audit ledger always in view. Keys are described, never displayed; every
 * number on screen was measured, not invented.
 */

type Tab = 'providers' | 'casting' | 'sandbox' | 'budgets' | 'learnings' | 'more'

const TABS: Array<{ id: Tab; icon: IconName; label: string }> = [
  { id: 'providers', icon: 'hub', label: 'Providers' },
  { id: 'casting', icon: 'badge', label: 'Casting' },
  { id: 'sandbox', icon: 'security', label: 'Sandbox' },
  { id: 'budgets', icon: 'monitoring', label: 'Budgets' },
  { id: 'learnings', icon: 'psychology', label: 'Learnings' },
  { id: 'more', icon: 'settings', label: 'More' },
]

const ROLES = ['head', 'research', 'builder', 'architect', 'editor', 'debug', 'reviewer']

const bytes = (value: number | null | undefined) => (value === null || value === undefined ? '—' : value > 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : value > 1_000 ? `${(value / 1_000).toFixed(1)} kB` : `${value} B`)
const at = (timestamp: number | null | undefined) => (timestamp ? new Date(timestamp).toLocaleString() : 'never')

export function SettingsView({ bridge }: { bridge: Bridge }) {
  const [tab, setTab] = useState<Tab>('providers')
  const [probes, setProbes] = useState<Record<string, string>>({})
  const [newProvider, setNewProvider] = useState({ label: '', baseUrl: '', model: '', apiKey: '', authStyle: 'auto', allowPrivate: false })
  const [addError, setAddError] = useState('')
  const [busy, setBusy] = useState('')
  const [grantDraft, setGrantDraft] = useState({ toolName: 'workspace.write', scopeKind: 'path' as 'path' | 'host', scopeValue: '' })

  const { loadProviders, loadStatus, loadSettings, loadUsage, loadLearnings, loadGrants, verifyAudit, backupNow, setError } = bridge
  useEffect(() => {
    void loadProviders().catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not load providers.'))
    void loadStatus()
    void loadSettings()
    void loadUsage(30)
    void loadGrants()
    if (bridge.projectId) void loadLearnings(bridge.projectId)
  }, [loadProviders, loadStatus, loadSettings, loadUsage, loadLearnings, loadGrants, bridge.projectId, setError])

  const engine = bridge.status?.execution
  const configuredCount = bridge.providers.filter((p) => p.configured).length
  const runBudget = bridge.appSettings.find((s) => s.name === 'FULKRUM_RUN_BUDGET_USD')
  const dailyBudget = bridge.appSettings.find((s) => s.name === 'FULKRUM_DAILY_BUDGET_USD')
  const routing = (bridge.projectSettings?.routing ?? {}) as Record<string, string>

  return (
    <div className="w-full max-w-7xl mx-auto px-4 py-4 flex flex-col gap-4">
      <div className="w-full bg-surface-container-low p-1.5 rounded-lg border border-outline-variant/40 flex items-center gap-1 overflow-x-auto" role="group" aria-label="Settings sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={tab === entry.id}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-body-md whitespace-nowrap transition-all ${tab === entry.id ? 'bg-surface-container-high text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container'}`}
            onClick={() => setTab(entry.id)}
          >
            <Icon name={entry.icon} className="text-base" />
            {entry.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        <div className="xl:col-span-8 flex flex-col gap-4">
          {tab === 'providers' ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-surface-container-low p-4 rounded-lg border border-outline-variant/40">
                  <p className="text-label-sm text-outline uppercase">Configured</p>
                  <p className="mt-1 font-mono text-headline-lg text-on-surface">{configuredCount}<span className="text-body-md text-outline">/{bridge.providers.length}</span></p>
                  <p className="text-label-sm text-outline mt-1">Keys stay on this machine; nothing is displayed here.</p>
                </div>
                <div className="bg-surface-container-low p-4 rounded-lg border border-outline-variant/40">
                  <p className="text-label-sm text-outline uppercase">Schema</p>
                  <p className="mt-1 font-mono text-headline-lg text-on-surface">v{bridge.status?.schemaVersion ?? '—'}</p>
                  <p className="text-label-sm text-outline mt-1">{bytes(bridge.status?.storage.databaseBytes)} db · {bytes(bridge.status?.storage.walBytes)} WAL</p>
                </div>
                <div className="bg-surface-container-low p-4 rounded-lg border border-outline-variant/40">
                  <p className="text-label-sm text-outline uppercase">Breakers</p>
                  <p className="mt-1 font-mono text-headline-lg text-on-surface">{(bridge.status?.providers ?? []).filter((p) => p.breaker?.open).length}<span className="text-body-md text-outline"> skipped</span></p>
                  <p className="text-label-sm text-outline mt-1">Providers cool down after repeated failures.</p>
                </div>
              </div>
              {bridge.providers.map((provider) => (
                <ProviderCard key={provider.id} bridge={bridge} provider={provider} probe={probes[provider.id] ?? null} onProbed={(line) => setProbes((c) => ({ ...c, [provider.id]: line }))} />
              ))}
              <Panel title="Register custom provider">
                <p className="text-body-sm text-on-surface-variant">Any OpenAI-compatible endpoint: vLLM, Ollama, OpenRouter, LM Studio…</p>
                <form
                  className="grid grid-cols-1 md:grid-cols-2 gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    if (busy === 'add-provider') return
                    setAddError('')
                    setBusy('add-provider')
                    try {
                      await bridge.addProvider(newProvider)
                      setNewProvider({ label: '', baseUrl: '', model: '', apiKey: '', authStyle: 'auto', allowPrivate: false })
                    } catch (caught) {
                      setAddError(caught instanceof Error ? caught.message : 'Could not add the provider.')
                    } finally {
                      setBusy('')
                    }
                  }}
                >
                  <label className="visually-hidden" htmlFor="np-label">Label</label>
                  <input id="np-label" className={inputClass} placeholder="Label (e.g. Local vLLM)" value={newProvider.label} onChange={(e) => setNewProvider((c) => ({ ...c, label: e.target.value }))} />
                  <label className="visually-hidden" htmlFor="np-url">Base URL</label>
                    <input id="np-url" type="url" required className={`${inputClass} font-mono`} placeholder="http://127.0.0.1:11434/v1" value={newProvider.baseUrl} onChange={(e) => setNewProvider((c) => ({ ...c, baseUrl: e.target.value }))} />
                  <label className="visually-hidden" htmlFor="np-model">Model</label>
                    <input id="np-model" required className={`${inputClass} font-mono`} placeholder="Model" value={newProvider.model} onChange={(e) => setNewProvider((c) => ({ ...c, model: e.target.value }))} />
                  <div className="flex gap-2">
                    <label className="visually-hidden" htmlFor="np-key">API key</label>
                    <input id="np-key" type="password" autoComplete="off" className={`${inputClass} font-mono flex-1`} placeholder="API key (empty if none)" value={newProvider.apiKey} onChange={(e) => setNewProvider((c) => ({ ...c, apiKey: e.target.value }))} />
                      <Button variant="primary" type="submit" disabled={busy === 'add-provider' || !newProvider.label.trim() || !newProvider.baseUrl.trim() || !newProvider.model.trim()}>Save</Button>
                    </div>
                    <label className="flex flex-col gap-1 text-label-md">Authentication<select className={selectClass} value={newProvider.authStyle} onChange={(e) => setNewProvider((c) => ({ ...c, authStyle: e.target.value }))}><option value="auto">Provider default</option><option value="none">No authentication</option><option value="bearer">Bearer token</option><option value="x-api-key">x-api-key</option><option value="api-key">api-key</option></select></label>
                    <label className="flex items-center gap-2 text-body-sm"><input type="checkbox" checked={newProvider.allowPrivate} onChange={(e) => setNewProvider((c) => ({ ...c, allowPrivate: e.target.checked }))} />Allow private-network URLs</label>
                </form>
                {addError ? <p className="text-error text-body-sm" role="alert">{addError}</p> : null}
                <p className="text-label-sm text-outline">For local servers, enable private-network access and choose “No authentication” if the endpoint does not require a key.</p>
              </Panel>
            </>
          ) : null}

          {tab === 'casting' ? (
            <Panel title="Who plays which role">
              <p className="text-body-sm text-on-surface-variant">Roles are contracts; models are casting. Changing a route never touches an approved plan.</p>
              {ROLES.map((role) => (
                <div key={role} className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-surface-container rounded-lg">
                  <span className="text-body-md text-on-surface">{roleLabel(role)}</span>
                  <label className="visually-hidden" htmlFor={`cast-${role}`}>Casting for {roleLabel(role)}</label>
                  <select
                    id={`cast-${role}`}
                    className={selectClass}
                    value={routing[role] ?? ''}
                    onChange={(e) => void bridge.saveRouting(role, e.target.value)}
                  >
                    <option value="">not cast</option>
                    {bridge.providers.filter((p) => p.configured).map((p) => (
                      <option key={p.id} value={p.label}>{p.label} · {p.model}</option>
                    ))}
                  </select>
                </div>
              ))}
              <p className="text-label-sm text-outline">Workers use their role's route at task start; verification runs on the reviewer route when one is cast.</p>
            </Panel>
          ) : null}

          {tab === 'sandbox' ? (
            <Panel title="Execution boundary">
              <div className="flex items-center gap-2.5">
                <Icon name="lock" className={`text-xl ${engine?.available ? 'text-secondary' : 'text-error'}`} />
                <div>
                  <p className="text-body-md text-on-surface font-medium">{engine?.available ? `${engine.label} ${engine.version ?? ''}` : 'No engine reachable'}</p>
                  <p className={`text-label-sm flex items-center gap-1.5 ${engine?.available ? 'text-secondary' : 'text-error'}`}>
                    <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" /> {engine?.available ? 'Active jail boundary' : 'commands: disabled'}
                  </p>
                </div>
                {engine?.running?.length ? <span className="ml-auto px-2 py-0.5 rounded bg-surface-container text-label-sm text-on-surface">{engine.running.length} container(s) running</span> : null}
              </div>
              {engine?.available ? (
                <div className="bg-surface-container p-3 rounded-lg flex flex-col gap-1 font-mono text-body-sm">
                  <div className="flex justify-between gap-2"><span className="text-outline">Image</span><span className="text-on-surface truncate">{engine.image ?? '—'}</span></div>
                  <div className="flex justify-between gap-2"><span className="text-outline">Digest</span><span className={engine.imagePinned ? 'text-secondary' : 'text-error'}>{engine.imagePinned ? 'pinned' : 'by tag only — pin with FULKRUM_RUNNER_IMAGE'}</span></div>
                  <div className="flex justify-between gap-2"><span className="text-outline">Network</span><span className="text-secondary">none (airgapped)</span></div>
                  <div className="flex justify-between gap-2"><span className="text-outline">Rootfs</span><span className="text-secondary">read-only · workspace bind only</span></div>
                </div>
              ) : (
                <div className="bg-surface-container p-3 rounded-lg flex flex-col gap-1">
                  <p className="text-body-md text-on-surface">{engine?.reason}</p>
                  <p className="text-body-sm text-on-surface-variant">{engine?.hint}</p>
                  <p className="text-body-sm text-outline">Without an engine, command execution reports <code className="font-mono">commands: disabled</code> — reads and planning still work.</p>
                </div>
              )}
              <p className="text-label-sm text-outline">The boundary is enforced by the runner, not by the UI: these lines describe what the container already does.</p>
            </Panel>
          ) : null}

          {tab === 'budgets' ? (
            <Panel title="Spend ceilings">
              <p className="text-body-sm text-on-surface-variant">Hard stops: a run over its ceiling transitions to budget_exceeded. 0 means no ceiling.</p>
              {[
                { setting: runBudget, label: 'Per-run ceiling', hint: 'FULKRUM_RUN_BUDGET_USD' },
                { setting: dailyBudget, label: 'Daily ceiling', hint: 'FULKRUM_DAILY_BUDGET_USD' },
              ].map(({ setting, label, hint }) => (
                <div key={hint} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-label-sm text-on-surface-variant uppercase tracking-wider" htmlFor={hint}>{label}</label>
                    <span className="font-mono text-body-md text-secondary">${String(setting?.value ?? 0)}</span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      id={hint}
                      inputMode="decimal"
                      className={`${inputClass} font-mono flex-1`}
                      defaultValue={String(setting?.value ?? 0)}
                      disabled={setting?.source === 'env'}
                      key={`${hint}:${JSON.stringify(setting?.value)}`}
                      onBlur={async (e) => {
                        const next = e.target.value.trim() === '' ? 0 : Number(e.target.value)
                        if (Number.isFinite(next) && next !== Number(setting?.value ?? 0)) await bridge.saveSetting(hint, next)
                      }}
                    />
                    {setting?.source === 'env' ? <span className="text-label-sm text-outline self-center">set in environment</span> : null}
                  </div>
                </div>
              ))}
              {bridge.usage ? (
                <div className="p-3 rounded-lg bg-surface-container flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-label-sm">
                    <span className="text-outline">Last {bridge.usage.days} day(s)</span>
                    <span className="font-mono text-secondary">${bridge.usage.totals.costUsd.toFixed(4)} · {bridge.usage.totals.calls} calls{bridge.usage.totals.unpricedCalls ? ` · ${bridge.usage.totals.unpricedCalls} unpriced (total is a lower bound)` : ''}</span>
                  </div>
                  {bridge.usage.byProvider.length ? bridge.usage.byProvider.map((entry: any) => (
                    <div key={entry.key} className="flex justify-between font-mono text-body-sm px-1">
                      <span className="text-outline truncate">{entry.key}</span>
                      <span className="text-on-surface">${entry.costUsd.toFixed(4)}</span>
                    </div>
                  )) : <p className="text-label-sm text-outline">No priced calls yet.</p>}
                </div>
              ) : <p className="text-body-sm text-outline">Usage loads with this tab.</p>}
            </Panel>
          ) : null}

          {tab === 'learnings' ? (
            <Panel title="Learnings">
              <p className="text-body-sm text-on-surface-variant">Facts from reviewed runs, injected into planning. Forgetting removes them everywhere.</p>
              {bridge.learnings.length ? bridge.learnings.map((learning: any) => (
                <div key={learning.id} className="flex items-start justify-between gap-3 p-2.5 bg-surface-container rounded-lg">
                  <div className="min-w-0">
                    <p className="text-body-md text-on-surface">{learning.fact}</p>
                    <p className="text-label-sm text-outline">{at(learning.createdAt)}{learning.sourceRunId ? ` · from run ${learning.sourceRunId.slice(0, 8)}` : ''}</p>
                  </div>
                  <Button variant="danger" className="!px-2.5 !py-1 text-label-sm flex-shrink-0" onClick={() => void bridge.deleteLearning(learning.id)}>forget</Button>
                </div>
              )) : <p className="text-body-sm text-outline">Nothing learned yet. Reviewed runs that produce evidence teach one to three facts each.</p>}
            </Panel>
          ) : null}

          {tab === 'more' ? (
            <>
              <Panel title="Standing grants" action={<span className="text-label-md text-outline">allowed repeatedly, within a scope</span>}>
                {bridge.grants.length ? bridge.grants.map((grant: any) => (
                  <div key={grant.id} className="flex items-center gap-2.5 py-1.5 border-b border-surface-container-highest">
                    <Chip tone="idle">{grant.scopeKind}</Chip>
                    <div className="flex-1 min-w-0">
                      <strong className="text-body-md text-on-surface block truncate">{grant.label}</strong>
                      <span className="text-label-sm text-outline">used {grant.useCount} time(s) · last {at(grant.lastUsedAt)}</span>
                    </div>
                    <Button className="!px-2.5 !py-1 text-label-sm flex-shrink-0" onClick={() => void bridge.revokeGrant(grant.id)}>revoke</Button>
                  </div>
                )) : <p className="text-body-sm text-outline">Nothing is allowed unattended. A call that needs approval can be approved once, for the run, or always within a scope.</p>}
                <form
                  className="flex gap-2 flex-wrap"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (!grantDraft.scopeValue.trim()) return
                    void bridge.createGrant(grantDraft.toolName, grantDraft.scopeKind, grantDraft.scopeValue.trim()).then(() => setGrantDraft((c) => ({ ...c, scopeValue: '' })))
                  }}
                >
                  <label className="visually-hidden" htmlFor="grant-tool">Tool</label>
                  <select id="grant-tool" className={selectClass} value={grantDraft.toolName} onChange={(e) => setGrantDraft((c) => ({ ...c, toolName: e.target.value }))}>
                    {['workspace.write', 'workspace.read', 'workspace.search', 'workspace.list', 'http.request'].map((tool) => <option key={tool} value={tool}>{tool}</option>)}
                  </select>
                  <label className="visually-hidden" htmlFor="grant-scope">Scope kind</label>
                  <select id="grant-scope" className={selectClass} value={grantDraft.scopeKind} onChange={(e) => setGrantDraft((c) => ({ ...c, scopeKind: e.target.value as 'path' | 'host' }))}>
                    <option value="path">a directory</option>
                    <option value="host">a host</option>
                  </select>
                  <label className="visually-hidden" htmlFor="grant-value">Scope value</label>
                  <input id="grant-value" className={`${inputClass} flex-1 min-w-[140px]`} placeholder={grantDraft.scopeKind === 'path' ? 'src/docs' : 'api.example.com'} value={grantDraft.scopeValue} onChange={(e) => setGrantDraft((c) => ({ ...c, scopeValue: e.target.value }))} />
                  <Button variant="primary" type="submit" disabled={!grantDraft.scopeValue.trim()}>Allow</Button>
                </form>
                <p className="text-label-sm text-outline">A command cannot be made standing: its arguments have no boundary. Deny rules still win over any grant.</p>
              </Panel>
              <Panel title="Storage">
                <div className="font-mono text-body-sm space-y-1">
                  <div className="flex justify-between gap-2"><span className="text-outline">Database</span><span className="text-on-surface">{bytes(bridge.status?.storage.databaseBytes)}{bridge.status?.storage.walBytes ? ` + ${bytes(bridge.status.storage.walBytes)} WAL` : ''}</span></div>
                  <div className="flex justify-between gap-2"><span className="text-outline">Backups</span><span className="text-on-surface">{bridge.status?.backups.count ?? 0}</span></div>
                  <div className="flex justify-between gap-2"><span className="text-outline">Retention</span><span className="text-on-surface">{bridge.status?.retention.toolOutputDays ?? '—'} day(s)</span></div>
                  <div className="flex justify-between gap-2"><span className="text-outline">Schema</span><span className="text-on-surface">v{bridge.status?.schemaVersion ?? '—'}</span></div>
                </div>
                <div className="flex gap-2">
                  <Button disabled={busy === 'verify'} onClick={async () => { setBusy('verify'); try { await verifyAudit() } finally { setBusy('') } }}>{busy === 'verify' ? 'Verifying…' : 'Verify audit log'}</Button>
                  <Button disabled={busy === 'backup'} onClick={async () => { setBusy('backup'); try { await backupNow() } finally { setBusy('') } }}>{busy === 'backup' ? 'Copying…' : 'Back up now'}</Button>
                </div>
                {bridge.status?.lastVerify ? <p className="text-label-sm text-outline">{bridge.status.lastVerify.summary}</p> : null}
              </Panel>
              <Panel title="All tunables" action={<span className="text-label-md text-outline">everything else, no terminal needed</span>}>
                {bridge.appSettings.length === 0 ? <p className="text-body-sm text-outline">No settings loaded.</p> : (
                  <div className="flex flex-col gap-1 font-mono text-body-sm">
                    {bridge.appSettings.map((setting: any) => (
                      <div key={setting.name} className="flex items-center justify-between gap-2 py-1 border-b border-surface-container-highest">
                        <span className="text-on-surface truncate" title={setting.description}>{setting.name}</span>
                        <span className="text-outline truncate max-w-[220px] text-right">{Array.isArray(setting.value) ? setting.value.join(', ') : String(setting.value ?? '')}{setting.source === 'env' ? ' (env)' : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-label-sm text-outline">Values set in the environment always win. Edit names and values from the Budgets tab or the server config; anything else applies the moment it saves, except entries badged “needs restart”.</p>
              </Panel>
            </>
          ) : null}
        </div>

        <div className="xl:col-span-4">
          <Panel title="Audit ledger" action={<Chip tone={bridge.status?.lastVerify?.ok ? 'ok' : bridge.status?.lastVerify ? 'bad' : 'idle'}>{bridge.status?.lastVerify ? (bridge.status.lastVerify.ok ? 'intact' : 'PROBLEM') : 'never verified'}</Chip>}>
            <div className="bg-surface-container p-3 rounded-lg flex flex-col gap-1 font-mono text-body-sm">
              <div className="flex justify-between gap-2"><span className="text-outline">Anchor</span><span className="text-on-surface truncate">{bridge.status?.anchor.file ?? 'disabled'}</span></div>
              <div className="flex justify-between gap-2"><span className="text-outline">Anchored heads</span><span className="text-primary">{bridge.status?.anchor.count ?? 0}</span></div>
              <div className="flex justify-between gap-2"><span className="text-outline">Backups</span><span className="text-secondary">{bridge.status?.backups.count ?? 0}</span></div>
              <div className="flex justify-between gap-2"><span className="text-outline">Last verify</span><span className="text-on-surface">{at(bridge.status?.lastVerify?.createdAt)}</span></div>
            </div>
            {bridge.status?.lastVerify ? <p className="text-label-sm text-outline">{bridge.status.lastVerify.summary}</p> : null}
            <div className="grid grid-cols-2 gap-2">
              <Button disabled={busy === 'verify'} onClick={async () => { setBusy('verify'); try { await verifyAudit() } finally { setBusy('') } }}>{busy === 'verify' ? 'Verifying…' : 'Verify chain'}</Button>
              <Button disabled={busy === 'backup'} onClick={async () => { setBusy('backup'); try { await backupNow() } finally { setBusy('') } }}>{busy === 'backup' ? 'Copying…' : 'Back up now'}</Button>
            </div>
          </Panel>
          <Panel title="Boundaries">
            <p className="text-label-md text-outline flex items-start gap-1.5"><Icon name="lan" className="text-sm text-secondary" /><span>Bridge on <code className="font-mono text-on-surface">127.0.0.1</code> — loopback only.</span></p>
            <p className="text-label-md text-outline flex items-start gap-1.5"><Icon name="key_off" className="text-sm text-secondary" /><span>Keys are stored locally and sent only to their configured provider; tool output is scanned for credential shapes.</span></p>
            <p className="text-label-md text-outline flex items-start gap-1.5"><Icon name="block" className="text-sm text-secondary" /><span>No command runs on the host: container, or not at all.</span></p>
          </Panel>
        </div>
      </div>
    </div>
  )
}
