import type { FormEvent } from "react"
import { Bot, Check, Plus, Trash2, X, Zap } from "lucide-react"
import type { PermissionMode } from "./types"

/**
 * Workspace settings: which providers are connected, how each role is routed, and
 * how much autonomy this run has.
 *
 * The props are named exactly as they are in App so the markup moved here
 * unchanged; a later pass can group them into a provider/routing hook.
 */
export type SettingsDrawerProps = {
  providerStatus: any[]
  providerTests: Record<string, { state: string; latencyMs?: number; error?: string }>
  testProvider: (provider: any) => void
  removeProvider: (provider: any) => void
  customProvider: { label: string; baseUrl: string; model: string; envKey: string }
  setCustomProvider: (updater: (current: SettingsDrawerProps["customProvider"]) => SettingsDrawerProps["customProvider"]) => void
  addCustomProvider: (event: FormEvent<HTMLFormElement>) => void
  isAddingProvider: boolean
  customProviderError: string
  agents: Array<{ id: string; name: string; role: string; tone: string; avatar: string }>
  routing: Record<string, string>
  setRouting: (updater: (current: Record<string, string>) => Record<string, string>) => void
  modelOptions: Record<string, string[]>
  permissionMode: PermissionMode
  changePermissionMode: (mode: PermissionMode) => void
  setSettingsOpen: (open: boolean) => void
}

export function SettingsDrawer({ providerStatus, providerTests, testProvider, removeProvider, customProvider, setCustomProvider, addCustomProvider, isAddingProvider, customProviderError, agents, routing, setRouting, modelOptions, permissionMode, changePermissionMode, setSettingsOpen }: SettingsDrawerProps) {
  return (
<div className="routing-layer settings-layer"><button className="drawer-backdrop" type="button" aria-label="Close workspace settings" onClick={() => setSettingsOpen(false)}></button><aside className="routing-drawer settings-drawer"><header className="drawer-header"><div><p className="eyebrow">Workspace settings</p><h2>Make the team yours</h2></div><button className="icon-button" type="button" title="Close workspace settings" onClick={() => setSettingsOpen(false)}><X size={18} /></button></header><p className="drawer-copy">Connect the models you already use, assign one to each role, and choose how much autonomy this run has.</p><section className="settings-section"><div className="settings-section-heading"><div><p className="drawer-section-label">Provider APIs</p><small>Built-ins stay available. Custom endpoints can be removed at any time.</small></div><span className="provider-count"><Bot size={14} />{providerStatus.filter((provider) => provider.configured).length} connected</span></div><div className="settings-provider-list">{providerStatus.map((provider) => { const test = providerTests[provider.id]; return <div className="settings-provider-row" key={provider.id}><span className="settings-provider-main"><span className={`provider-state-dot ${provider.configured ? 'connected' : ''}`}></span><span><strong>{provider.label}</strong><small>{provider.model} · {provider.envKey}</small></span></span><span className="settings-provider-actions"><span className={`provider-state ${provider.configured ? 'connected' : ''}`}>{provider.configured ? 'Connected' : 'Add key'}</span><button className="icon-button" type="button" title={`Test ${provider.label} connectivity`} disabled={test?.state === 'testing'} onClick={() => void testProvider(provider)}><Zap size={15} /></button>{test && test.state !== 'testing' ? <span className={`provider-test ${test.state}`}>{test.state === 'ok' ? `ok · ${test.latencyMs ?? 0}ms` : test.error}</span> : null}{provider.custom ? <button className="icon-button danger" type="button" title={`Remove ${provider.label}`} onClick={() => void removeProvider(provider)}><Trash2 size={15} /></button> : <span className="provider-built-in">Built-in</span>}</span></div> })}</div></section><section className="settings-section"><p className="drawer-section-label">Add custom OpenAI-compatible API</p><form className="settings-provider-form" onSubmit={addCustomProvider}><label><span>Name</span><input value={customProvider.label} onChange={(event) => setCustomProvider((current) => ({ ...current, label: event.target.value }))} placeholder="Local gateway" /></label><label><span>Base URL</span><input value={customProvider.baseUrl} onChange={(event) => setCustomProvider((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" /></label><label><span>Model</span><input value={customProvider.model} onChange={(event) => setCustomProvider((current) => ({ ...current, model: event.target.value }))} placeholder="model-name" /></label><label><span>Environment key</span><input value={customProvider.envKey} onChange={(event) => setCustomProvider((current) => ({ ...current, envKey: event.target.value }))} placeholder="CUSTOM_API_KEY" /></label><button className="primary-button" type="submit" disabled={isAddingProvider}>{isAddingProvider ? 'Adding...' : <><Plus size={15} />Add API</>}</button></form>{customProviderError ? <p className="provider-form-error">{customProviderError}</p> : null}</section><section className="settings-section"><p className="drawer-section-label">Role routing</p><div className="settings-routing-list">{agents.map((agent) => <label className="route-field" key={agent.id}><span className={`route-avatar ${agent.tone}`}>{agent.avatar}</span><span className="route-label"><strong>{agent.name}</strong><small>{agent.role}</small></span><select value={routing[agent.id]} onChange={(event) => setRouting((current) => ({ ...current, [agent.id]: event.target.value }))}>{modelOptions[agent.id].map((option) => <option key={option}>{option}</option>)}</select></label>)}</div></section><section className="settings-section"><div className="settings-permission"><span><strong>Permission mode</strong><small>{permissionMode === 'guided' ? 'Ask before consequential actions' : permissionMode === 'selective' ? 'Pause on risky actions' : 'Run inside approved boundaries'}</small></span><select aria-label="Permission mode" value={permissionMode} onChange={(event) => void changePermissionMode(event.target.value as PermissionMode)}><option value="guided">Guided</option><option value="selective">Selective</option><option value="autopilot">Autopilot</option></select></div></section><footer className="drawer-footer"><button className="primary-button" type="button" onClick={() => setSettingsOpen(false)}><Check size={16} />Done</button></footer></aside></div>
  )
}
