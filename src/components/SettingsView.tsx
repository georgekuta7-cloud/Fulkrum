import { useEffect, useState } from 'react'
import type { Bridge } from '../hooks/useBridge'
import type { Provider } from '../api/types'
import { ProviderEditor } from '../ProviderEditor'
import { roleLabel } from '../lib/runGraph'

/**
 * Settings as the approved screen draws it: providers, casting, the sandbox
 * boundary, budgets, and learnings in one full view — not a drawer. The rule
 * is honesty: latency appears only after a real probe, keys are described
 * ("stored locally") never displayed, and no capability is claimed that the
 * bridge does not have.
 */

type Tab = 'providers' | 'casting' | 'sandbox' | 'budgets' | 'learnings'

const TABS: Array<{ id: Tab; icon: string; label: string }> = [
  { id: 'providers', icon: 'hub', label: 'Providers & Endpoints' },
  { id: 'casting', icon: 'badge', label: 'Roles & Casting' },
  { id: 'sandbox', icon: 'security', label: 'Container Sandbox' },
  { id: 'budgets', icon: 'monitoring', label: 'Budgets & Spend' },
  { id: 'learnings', icon: 'psychology', label: 'Learnings' },
]

const ROLES = ['head', 'research', 'builder', 'architect', 'editor', 'debug', 'reviewer']

const keyWords = (provider: Provider): string => {
  if (provider.keySource === 'stored') return 'stored locally, never displayed'
  if (provider.keySource === 'env') return `from ${provider.envKey ?? 'environment'}`
  if (provider.authStyle === 'none') return 'no key needed'
  return provider.envKey ? `add ${provider.envKey}` : 'not configured'
}

const bytes = (value: number | null | undefined) => (value === null || value === undefined ? '—' : value > 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : value > 1_000 ? `${(value / 1_000).toFixed(1)} kB` : `${value} B`)
/** Ages the server already measured are used as-is; timestamps print as-is. Reading the clock during render is what made displays disagree with themselves. */
const ago = (ms: number | null) => (ms === null ? 'never' : ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m ago` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h ago` : `${Math.round(ms / 86_400_000)}d ago`)
const at = (timestamp: number | null | undefined) => (timestamp ? new Date(timestamp).toLocaleString() : 'never')

function ProviderCard({ bridge, provider, probe, onProbed }: { bridge: Bridge; provider: Provider; probe: string | null; onProbed: (line: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<'idle' | 'probing'>('idle')
  const status = bridge.status?.providers.find((entry) => entry.id === provider.id)
  const on = provider.configured

  const runProbe = async () => {
    setTest('probing')
    try {
      const result = await bridge.testProvider(provider.id)
      const value = result.result
      const line = value?.reachable ? `ok · ${value.latencyMs}ms · ${value.models?.length ?? 0} models` : String(value?.error ?? value?.reason ?? 'unreachable')
      onProbed(line)
    } catch (caught) {
      onProbed(caught instanceof Error ? caught.message : 'probe failed')
    } finally {
      setTest('idle')
    }
  }

  return (
    <div className="bg-surface-container-low p-4 rounded-xl flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${on ? 'bg-surface-container-high text-primary' : 'bg-surface-container text-outline'}`}>
            <span className="material-symbols-outlined text-[20px]">terminal</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-headline-md text-on-surface truncate">{provider.label}</h3>
              {on ? (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-secondary/10 text-secondary text-label-sm">
                  <span className="w-1.5 h-1.5 rounded-full bg-secondary" /> configured
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded bg-surface-container text-outline text-label-sm">needs a key</span>
              )}
              {provider.allowPrivate ? <span className="px-2 py-0.5 rounded bg-surface-container text-secondary text-label-sm">local network</span> : null}
              {status?.breaker?.open ? <span className="px-2 py-0.5 rounded bg-error-container/30 text-error text-label-sm">skipped after failures</span> : null}
            </div>
            <div className="text-on-surface-variant text-body-sm mt-0.5 truncate">
              model <code className="font-mono text-on-surface">{provider.model}</code> · key: {keyWords(provider)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface text-body-md transition-colors flex items-center gap-1.5"
            onClick={() => void runProbe()}
            disabled={test === 'probing'}
          >
            <span className={`material-symbols-outlined text-sm text-secondary ${test === 'probing' ? 'animate-spin' : ''}`}>bolt</span>
            {test === 'probing' ? 'Probing…' : 'Test Endpoint'}
          </button>
          <button type="button" className="px-3 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface-variant text-body-md transition-colors" onClick={() => setEditing((open) => !open)}>{editing ? 'Close' : 'Edit'}</button>
          {provider.custom ? (
            <button type="button" className="w-8 h-8 rounded-lg flex items-center justify-center text-error hover:bg-error-container/30 transition-colors" title={`Remove ${provider.label}`} onClick={() => void bridge.removeProvider(provider.id)}>
              <span className="material-symbols-outlined text-sm">delete</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <div className="bg-surface-container p-2.5 rounded-lg flex flex-col gap-0.5">
          <span className="text-label-sm text-outline uppercase">Auth</span>
          <code className="font-mono text-body-sm text-secondary">{provider.authStyle === 'none' ? 'none' : provider.authHeader ?? provider.authStyle}</code>
        </div>
        <div className="bg-surface-container p-2.5 rounded-lg flex flex-col gap-0.5">
          <span className="text-label-sm text-outline uppercase">Sampling</span>
          <span className="font-mono text-body-sm text-primary">{provider.temperature === 'omit' ? 'provider default' : `temp ${provider.temperature}`}</span>
        </div>
        <div className="bg-surface-container p-2.5 rounded-lg flex flex-col gap-0.5">
          <span className="text-label-sm text-outline uppercase">Latency</span>
          <span className={`font-mono text-body-sm ${probe?.startsWith('ok') ? 'text-secondary' : probe ? 'text-error' : 'text-outline'}`}>{probe ?? 'not probed yet'}</span>
        </div>
      </div>

      {editing ? (
        <ProviderEditor
          provider={provider}
          isSaving={busy}
          error=""
          onCancel={() => setEditing(false)}
          onSave={async (settings) => {
            setBusy(true)
            try {
              await bridge.saveProvider(provider, settings)
              setEditing(false)
            } finally {
              setBusy(false)
            }
          }}
        />
      ) : null}
    </div>
  )
}

export function SettingsView({ bridge, onOpenDrawer }: { bridge: Bridge; onOpenDrawer: () => void }) {
  const [tab, setTab] = useState<Tab>('providers')
  const [probes, setProbes] = useState<Record<string, string>>({})
  const [newProvider, setNewProvider] = useState({ label: '', baseUrl: '', model: '', apiKey: '' })
  const [addError, setAddError] = useState('')
  const [busy, setBusy] = useState('')

  const { loadProviders, loadStatus, loadSettings, loadUsage, loadLearnings, verifyAudit, backupNow } = bridge
  useEffect(() => {
    void loadProviders()
    void loadStatus()
    void loadSettings()
    void loadUsage(30)
    if (bridge.projectId) void loadLearnings(bridge.projectId)
  }, [loadProviders, loadStatus, loadSettings, loadUsage, loadLearnings, bridge.projectId])

  const engine = bridge.status?.execution
  const configuredCount = bridge.providers.filter((p) => p.configured).length
  const runBudget = bridge.appSettings.find((s) => s.name === 'FULKRUM_RUN_BUDGET_USD')
  const dailyBudget = bridge.appSettings.find((s) => s.name === 'FULKRUM_DAILY_BUDGET_USD')
  const routing = (bridge.projectSettings?.routing ?? {}) as Record<string, string>
  const usage = bridge.usage

  return (
    <div className="w-full max-w-7xl mx-auto px-4 lg:px-8 py-6 flex flex-col gap-6">
      {/* Segmented tab rail */}
      <div className="w-full bg-surface-container-low p-1.5 rounded-xl flex items-center gap-1 overflow-x-auto">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-body-md whitespace-nowrap transition-all ${tab === entry.id ? 'bg-surface-container-high text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container'}`}
            onClick={() => setTab(entry.id)}
            aria-pressed={tab === entry.id}
          >
            <span className="material-symbols-outlined text-[16px]">{entry.icon}</span>
            {entry.label}
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" className="px-3 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface-variant text-body-md transition-colors whitespace-nowrap" onClick={onOpenDrawer}>Advanced…</button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-8 flex flex-col gap-4">
          {tab === 'providers' ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-surface-container-low p-4 rounded-xl">
                  <div className="flex items-center justify-between text-outline"><span className="text-label-sm uppercase tracking-wider">Configured</span><span className="material-symbols-outlined text-[18px]">neurology</span></div>
                  <div className="mt-2 flex items-baseline gap-2"><span className="text-headline-lg text-on-surface font-mono">{configuredCount}</span><span className="text-label-sm text-on-surface-variant">of {bridge.providers.length} providers</span></div>
                  <div className="text-label-sm text-outline mt-1">Keys stay on this machine; nothing is displayed here.</div>
                </div>
                <div className="bg-surface-container-low p-4 rounded-xl">
                  <div className="flex items-center justify-between text-outline"><span className="text-label-sm uppercase tracking-wider">Schema</span><span className="material-symbols-outlined text-[18px]">database</span></div>
                  <div className="mt-2 flex items-baseline gap-2"><span className="text-headline-lg text-on-surface font-mono">v{bridge.status?.schemaVersion ?? '—'}</span></div>
                  <div className="text-label-sm text-outline mt-1">{bytes(bridge.status?.storage.databaseBytes)} database · {bytes(bridge.status?.storage.walBytes)} WAL</div>
                </div>
                <div className="bg-surface-container-low p-4 rounded-xl">
                  <div className="flex items-center justify-between text-outline"><span className="text-label-sm uppercase tracking-wider">Breakers</span><span className="material-symbols-outlined text-[18px]"> bolt</span></div>
                  <div className="mt-2 flex items-baseline gap-2"><span className="text-headline-lg text-on-surface font-mono">{(bridge.status?.providers ?? []).filter((p) => p.breaker?.open).length}</span><span className="text-label-sm text-on-surface-variant">skipped</span></div>
                  <div className="text-label-sm text-outline mt-1">Providers cool down after repeated failures.</div>
                </div>
              </div>

              {bridge.providers.map((provider: Provider) => (
                <ProviderCard key={provider.id} bridge={bridge} provider={provider} probe={probes[provider.id] ?? null} onProbed={(line) => setProbes((current) => ({ ...current, [provider.id]: line }))} />
              ))}

              <div className="bg-surface-container-low p-4 rounded-xl flex flex-col gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center text-primary"><span className="material-symbols-outlined text-[18px]">add_circle</span></div>
                  <div>
                    <h4 className="text-headline-md text-on-surface">Register custom provider</h4>
                    <p className="text-body-sm text-on-surface-variant">Any OpenAI-compatible endpoint: vLLM, Ollama, OpenRouter, LM Studio…</p>
                  </div>
                </div>
                <form
                  className="grid grid-cols-1 md:grid-cols-2 gap-3"
                  onSubmit={async (event) => {
                    event.preventDefault()
                    setAddError('')
                    try {
                      await bridge.addProvider(newProvider)
                      setNewProvider({ label: '', baseUrl: '', model: '', apiKey: '' })
                    } catch (caught) {
                      setAddError(caught instanceof Error ? caught.message : 'Could not add the provider.')
                    }
                  }}
                >
                  <input className="bg-surface-container-lowest px-3 py-2 rounded-lg text-body-md text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary" placeholder="Label (e.g. Local vLLM)" value={newProvider.label} onChange={(e) => setNewProvider((c) => ({ ...c, label: e.target.value }))} aria-label="Provider label" />
                  <input className="bg-surface-container-lowest px-3 py-2 rounded-lg font-mono text-body-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary" placeholder="http://127.0.0.1:11434/v1" value={newProvider.baseUrl} onChange={(e) => setNewProvider((c) => ({ ...c, baseUrl: e.target.value }))} aria-label="Base URL" />
                  <input className="bg-surface-container-lowest px-3 py-2 rounded-lg font-mono text-body-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary" placeholder="Model (e.g. llama-3.3-70b)" value={newProvider.model} onChange={(e) => setNewProvider((c) => ({ ...c, model: e.target.value }))} aria-label="Model" />
                  <div className="flex gap-2">
                    <input type="password" autoComplete="off" className="flex-1 bg-surface-container-lowest px-3 py-2 rounded-lg font-mono text-body-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary" placeholder="API key (empty if none)" value={newProvider.apiKey} onChange={(e) => setNewProvider((c) => ({ ...c, apiKey: e.target.value }))} aria-label="API key" />
                    <button type="submit" className="px-4 py-2 rounded-lg bg-primary text-on-primary text-body-md font-medium hover:opacity-90 transition-opacity" disabled={!newProvider.label.trim() || !newProvider.baseUrl.trim()}>Save</button>
                  </div>
                </form>
                {addError ? <p className="text-error text-body-sm">{addError}</p> : null}
                <p className="text-label-sm text-outline">Private endpoints need <code className="font-mono">FULKRUM_ALLOW_PRIVATE_PROVIDER_URLS=1</code> — the boundary is deliberate, not a bug.</p>
              </div>
            </>
          ) : null}

          {tab === 'casting' ? (
            <div className="bg-surface-container-low p-4 rounded-xl flex flex-col gap-4">
              <div>
                <h4 className="text-headline-md text-on-surface">Who plays which role</h4>
                <p className="text-body-sm text-on-surface-variant">Roles are contracts; models are casting. Changing a route never touches an approved plan.</p>
              </div>
              {ROLES.map((role) => (
                <div key={role} className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-surface-container rounded-lg">
                  <span className="text-body-md text-on-surface">{roleLabel(role)}</span>
                  <select
                    className="bg-surface-container-lowest px-3 py-1.5 rounded-lg text-body-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary min-w-[200px]"
                    value={routing[role] ?? ''}
                    onChange={(e) => void bridge.saveRouting(role, e.target.value)}
                    aria-label={`Casting for ${roleLabel(role)}`}
                  >
                    <option value="">not cast</option>
                    {bridge.providers.filter((p) => p.configured).map((p) => (
                      <option key={p.id} value={p.label}>{p.label} · {p.model}</option>
                    ))}
                  </select>
                </div>
              ))}
              <p className="text-label-sm text-outline">Workers use their role's route at task start; verification runs on the reviewer route when one is cast.</p>
            </div>
          ) : null}

          {tab === 'sandbox' ? (
            <div className="bg-surface-container-low p-4 rounded-xl flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className={`w-8 h-8 rounded flex items-center justify-center ${engine?.available ? 'bg-surface-container-high text-secondary' : 'bg-surface-container text-error'}`}><span className="material-symbols-outlined text-[18px]">lock</span></div>
                  <div>
                    <h4 className="text-headline-md text-on-surface">Execution boundary</h4>
                    <div className={`text-label-sm flex items-center gap-1.5 ${engine?.available ? 'text-secondary' : 'text-error'}`}>
                      <span className="w-1.5 h-1.5 rounded-full bg-current" /> {engine?.available ? `${engine.label} ${engine.version ?? ''}` : 'no engine reachable'}
                    </div>
                  </div>
                </div>
                {engine?.running?.length ? <span className="px-2 py-0.5 rounded bg-surface-container text-label-sm text-on-surface">{engine.running.length} container(s) running</span> : null}
              </div>
              {engine?.available ? (
                <div className="bg-surface-container p-3 rounded-lg flex flex-col gap-1 font-mono text-body-sm">
                  <div className="flex justify-between"><span className="text-outline">Image</span><span className="text-on-surface truncate">{engine.image ?? '—'}</span></div>
                  <div className="flex justify-between"><span className="text-outline">Digest</span><span className={engine.imagePinned ? 'text-secondary' : 'text-error'}>{engine.imagePinned ? 'pinned' : 'by tag only — pin with FULKRUM_RUNNER_IMAGE'}</span></div>
                  <div className="flex justify-between"><span className="text-outline">Network</span><span className="text-secondary">none (airgapped)</span></div>
                  <div className="flex justify-between"><span className="text-outline">Rootfs</span><span className="text-secondary">read-only · workspace bind only</span></div>
                </div>
              ) : (
                <div className="bg-surface-container p-3 rounded-lg flex flex-col gap-1">
                  <p className="text-body-md text-on-surface">{engine?.reason}</p>
                  <p className="text-body-sm text-on-surface-variant">{engine?.hint}</p>
                  <p className="text-body-sm text-outline">Without an engine, command execution reports <code className="font-mono">commands: disabled</code> — reads and planning still work.</p>
                </div>
              )}
              <p className="text-label-sm text-outline">The boundary is enforced by the runner, not by the UI: these lines describe what the container already does.</p>
            </div>
          ) : null}

          {tab === 'budgets' ? (
            <div className="bg-surface-container-low p-4 rounded-xl flex flex-col gap-5">
              <div>
                <h4 className="text-headline-md text-on-surface">Spend ceilings</h4>
                <p className="text-body-sm text-on-surface-variant">Hard stops: a run over its ceiling transitions to budget_exceeded, and nothing reserves past the daily cap. 0 means no ceiling.</p>
              </div>
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
                      className="flex-1 bg-surface-container-lowest px-3 py-1.5 rounded-lg font-mono text-body-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
                      defaultValue={String(setting?.value ?? 0)}
                      onBlur={async (e) => {
                        const next = e.target.value.trim() === '' ? 0 : Number(e.target.value)
                        if (Number.isFinite(next) && next !== Number(setting?.value ?? 0)) await bridge.saveSetting(hint, next)
                      }}
                      aria-label={label}
                    />
                    {setting?.source === 'env' ? <span className="text-label-sm text-outline self-center">set in environment</span> : null}
                  </div>
                </div>
              ))}
              {usage ? (
                <div className="p-3 rounded-lg bg-surface-container flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-label-sm">
                    <span className="text-outline">Last {usage.days} day(s)</span>
                    <span className="font-mono text-secondary">${usage.totals.costUsd.toFixed(4)} · {usage.totals.calls} calls{usage.totals.unpricedCalls ? ` · ${usage.totals.unpricedCalls} unpriced (total is a lower bound)` : ''}</span>
                  </div>
                  {usage.byProvider.length ? (
                    <table className="w-full font-mono text-body-sm">
                      <tbody>
                        {usage.byProvider.map((entry) => (
                          <tr key={entry.key} className="flex justify-between px-1"><span className="text-outline truncate">{entry.key}</span><span className="text-on-surface">${entry.costUsd.toFixed(4)}</span></tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="text-label-sm text-outline">No priced calls yet.</p>}
                </div>
              ) : <p className="text-body-sm text-outline">Usage loads with this tab.</p>}
            </div>
          ) : null}

          {tab === 'learnings' ? (
            <div className="bg-surface-container-low p-4 rounded-xl flex flex-col gap-3">
              <div>
                <h4 className="text-headline-md text-on-surface">Learnings</h4>
                <p className="text-body-sm text-on-surface-variant">Facts from reviewed runs, injected into planning. Forgetting removes them everywhere.</p>
              </div>
              {bridge.learnings.length ? bridge.learnings.map((learning) => (
                <div key={learning.id} className="flex items-start justify-between gap-3 p-2.5 bg-surface-container rounded-lg">
                  <div className="min-w-0">
                    <p className="text-body-md text-on-surface">{learning.fact}</p>
                    <p className="text-label-sm text-outline">{at(learning.createdAt)}{learning.sourceRunId ? ` · from run ${learning.sourceRunId.slice(0, 8)}` : ''}</p>
                  </div>
                  <button type="button" className="px-2.5 py-1 rounded-lg text-error hover:bg-error-container/30 text-label-sm transition-colors whitespace-nowrap" onClick={() => void bridge.deleteLearning(learning.id)}>forget</button>
                </div>
              )) : <p className="text-body-sm text-outline">Nothing learned yet. Reviewed runs that produce evidence teach one to three facts each.</p>}
            </div>
          ) : null}
        </div>

        {/* Right rail: the ledger, always in view */}
        <div className="xl:col-span-4 flex flex-col gap-4">
          <div className="bg-surface-container-low p-4 rounded-xl flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded bg-surface-container-high flex items-center justify-center text-tertiary"><span className="material-symbols-outlined text-[18px]">verified</span></div>
                <h4 className="text-headline-md text-on-surface">Audit ledger</h4>
              </div>
              <span className={`inline-flex items-center gap-1 text-label-sm ${bridge.status?.lastVerify?.ok ? 'text-secondary' : 'text-error'}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-current" /> {bridge.status?.lastVerify ? (bridge.status.lastVerify.ok ? 'intact' : 'PROBLEM') : 'never verified'}
              </span>
            </div>
            <div className="bg-surface-container p-3 rounded-lg flex flex-col gap-1 font-mono text-body-sm">
              <div className="flex justify-between"><span className="text-outline">Anchor</span><span className="text-on-surface truncate">{bridge.status?.anchor.file ?? 'disabled'}</span></div>
              <div className="flex justify-between"><span className="text-outline">Anchored heads</span><span className="text-primary">{bridge.status?.anchor.count ?? 0}</span></div>
              <div className="flex justify-between"><span className="text-outline">Backups</span><span className="text-secondary">{bridge.status?.backups.count ?? 0} · newest {ago(bridge.status?.backups.newestAgeMs ?? null)}</span></div>
              <div className="flex justify-between"><span className="text-outline">Last verify</span><span className="text-on-surface">{at(bridge.status?.lastVerify?.createdAt)}</span></div>
            </div>
            {bridge.status?.lastVerify ? <p className="text-label-sm text-outline">{bridge.status.lastVerify.summary}</p> : null}
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-body-md transition-colors flex items-center justify-center gap-1.5" disabled={busy === 'verify'} onClick={async () => { setBusy('verify'); try { await verifyAudit() } finally { setBusy('') } }}>
                <span className="material-symbols-outlined text-sm text-outline">rule</span> {busy === 'verify' ? 'Verifying…' : 'Verify chain'}
              </button>
              <button type="button" className="py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-body-md transition-colors flex items-center justify-center gap-1.5" disabled={busy === 'backup'} onClick={async () => { setBusy('backup'); try { await backupNow() } finally { setBusy('') } }}>
                <span className="material-symbols-outlined text-sm text-outline">save_as</span> {busy === 'backup' ? 'Copying…' : 'Back up now'}
              </button>
            </div>
          </div>

          <div className="bg-surface-container-low p-4 rounded-xl flex flex-col gap-2 text-label-sm text-outline">
            <p className="flex items-center gap-1.5"><span className="material-symbols-outlined text-sm text-secondary">lan</span> Bridge on <code className="font-mono text-on-surface">127.0.0.1</code> — loopback only, no authentication; origin checks are CSRF protection.</p>
            <p className="flex items-center gap-1.5"><span className="material-symbols-outlined text-sm text-secondary">key_off</span> Keys never leave this machine; tool output is scanned for credential shapes and redacted.</p>
            <p className="flex items-center gap-1.5"><span className="material-symbols-outlined text-sm text-secondary">block</span> No command runs on the host: everything executes in the container, or not at all.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
