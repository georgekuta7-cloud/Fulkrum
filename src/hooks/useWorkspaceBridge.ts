import { useCallback, useMemo, useState } from 'react'
import { api } from '../api/client'
import type { AppSetting, ArsenalItem, ConfigReport, MarketplaceEntry, Provider, StandingGrant, Status, Usage } from '../api/types'

type MarketplaceState = { enabled: boolean; signed: boolean; entries: MarketplaceEntry[]; fetchedAt: number | null; stale: boolean }
type ArsenalState = { skills: ArsenalItem[]; plugins: ArsenalItem[] }
type RegistryState = { candidates: MarketplaceEntry[]; skipped: string[]; fetchedAt: number }
type Reporter = (caught: unknown, fallback: string) => string

/** Workspace resources have no selected-project lifetime. Keeping them here
 * avoids coupling provider/store/settings actions to every streamed run update. */
export function useWorkspaceBridge(report: Reporter, notify: (message: string | null) => void) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [grants, setGrants] = useState<StandingGrant[]>([])
  const [marketplace, setMarketplace] = useState<MarketplaceState>({ enabled: false, signed: false, entries: [], fetchedAt: null, stale: false })
  const [arsenal, setArsenal] = useState<ArsenalState>({ skills: [], plugins: [] })
  const [registry, setRegistry] = useState<RegistryState | null>(null)
  const [configReport, setConfigReport] = useState<ConfigReport | null>(null)
  const [appSettings, setAppSettings] = useState<AppSetting[]>([])
  const [usage, setUsage] = useState<Usage | null>(null)

  const loadProviders = useCallback(async () => {
    const payload = await api.get<{ providers: Provider[] }>('/api/providers')
    setProviders(payload.providers)
    return payload.providers
  }, [])
  const loadStatus = useCallback(async () => {
    const payload = await api.get<Status>('/api/status').catch(() => null)
    setStatus(payload)
    return payload
  }, [])
  const loadGrants = useCallback(async () => {
    const payload = await api.get<{ grants: StandingGrant[]; history: unknown[] }>('/api/grants').catch(() => null)
    if (payload) setGrants(payload.grants ?? [])
    return payload
  }, [])
  const loadMarketplaceState = useCallback(async () => {
    const payload = await api.get<MarketplaceState>('/api/marketplace').catch(() => null)
    if (payload) setMarketplace(payload)
    return payload
  }, [])
  const loadArsenalState = useCallback(async () => {
    const payload = await api.get<ArsenalState>('/api/arsenal').catch(() => null)
    if (payload) setArsenal(payload)
    return payload
  }, [])
  const loadConfig = useCallback(async () => {
    const payload = await api.get<ConfigReport>('/api/config').catch(() => null)
    setConfigReport(payload)
    return payload
  }, [])
  const loadSettings = useCallback(async () => {
    const payload = await api.get<{ settings: AppSetting[] }>('/api/settings').catch(() => null)
    if (payload) setAppSettings(payload.settings)
    return payload?.settings ?? []
  }, [])
  const loadUsage = useCallback(async (days = 30) => {
    const payload = await api.get<Usage>(`/api/usage?days=${days}`).catch(() => null)
    setUsage(payload)
    return payload
  }, [])
  const perform = useCallback(async <T>(fallback: string, operation: () => Promise<T>): Promise<T | null> => {
    try { return await operation() } catch (caught) { report(caught, fallback); return null }
  }, [report])

  const actions = useMemo(() => ({
    // Provider forms own inline error feedback, so failures propagate to them.
    async saveProvider(provider: Provider, settings: Record<string, unknown>) {
      const updated = await api.patch<{ provider: Provider }>(`/api/providers/${encodeURIComponent(provider.id)}`, settings)
      await loadProviders()
      return updated.provider
    },
    async addProvider(input: Record<string, unknown>) {
      await api.post('/api/providers', input)
      await loadProviders()
    },
    async removeProvider(id: string) {
      await api.delete(`/api/providers/${encodeURIComponent(id)}`)
      await loadProviders()
    },
    testProvider: (id: string) => api.post<{ result: { reachable: boolean; latencyMs?: number; models?: string[]; error?: string } }>(`/api/providers/${encodeURIComponent(id)}/test`),
    createGrant: (toolName: string, scopeKind: 'path' | 'host', scopeValue: string) => perform('The grant could not be saved.', async () => {
      await api.post('/api/grants', { toolName, scopeKind, scopeValue })
      await loadGrants()
      return true
    }),
    revokeGrant: (id: string) => perform('The grant could not be revoked.', async () => {
      await api.delete(`/api/grants/${encodeURIComponent(id)}`)
      await loadGrants()
      return true
    }),
    refreshMarketplace: () => perform('The marketplace could not be refreshed.', async () => {
      const fresh = await api.post<{ entries: unknown[]; fetchedAt: number }>('/api/marketplace/refresh', {})
      await loadMarketplaceState()
      notify(`Marketplace refreshed: ${fresh.entries.length} entries.`)
      return fresh
    }),
    installMarketplaceEntry: (id: string) => perform('That entry could not be installed.', async () => {
      const installed = await api.post<{ installed: { kind: string; id: string; version: string }; permissions: { tools: string[]; hosts: string[] } }>(`/api/marketplace/${encodeURIComponent(id)}`, {})
      await Promise.all([loadMarketplaceState(), loadArsenalState()])
      const permissions = [...installed.permissions.tools, ...installed.permissions.hosts].filter(Boolean).join(', ')
      notify(`Installed ${installed.installed.id} v${installed.installed.version}${permissions ? ` (${permissions})` : ''}.`)
      return installed
    }),
    uninstallMarketplaceEntry: (id: string) => perform('That entry could not be removed.', async () => {
      await api.delete(`/api/marketplace/${encodeURIComponent(id)}`)
      await Promise.all([loadMarketplaceState(), loadArsenalState()])
      notify(`Removed ${id} and revoked its scoped grants.`)
      return true
    }),
    browseRegistry: (registryUrl: string) => perform('That registry could not be read.', async () => {
      const catalog = await api.post<RegistryState>('/api/marketplace/browse', { registry: registryUrl })
      setRegistry(catalog)
      return catalog
    }),
    clearRegistry: () => setRegistry(null),
    importMarketplaceSkill: (input: { url?: string; localPath?: string }) => perform('That skill could not be staged.', async () => {
      const result = await api.post<{ staged: MarketplaceEntry }>('/api/marketplace/import', input)
      await loadMarketplaceState()
      const flagged = (result.staged.findings ?? []).filter((finding) => finding.severity === 'medium').length
      notify(`Staged ${result.staged.id} v${result.staged.version} for review${flagged ? ` (${flagged} thing${flagged === 1 ? '' : 's'} worth a look)` : ''}. Install it when ready.`)
      return result
    }),
    verifyAudit: () => perform('The audit could not be verified.', async () => {
      const result = await api.post<{ record: { ok: boolean } }>('/api/maintenance/verify')
      await loadStatus()
      notify(result.record.ok ? 'Audit chain intact.' : 'Audit verification found a problem — see the status panel.')
      return result
    }),
    saveSetting: (name: string, value: unknown) => perform('The setting could not be saved.', async () => {
      const updated = await api.patch<{ setting: AppSetting; settings: AppSetting[] }>('/api/settings', { name, value })
      setAppSettings(updated.settings)
      notify(updated.setting.restartRequired ? `${name} saved. It takes effect after a restart.` : `${name} saved and live.`)
      await loadConfig()
      return updated.setting
    }),
    resetSetting: (name: string) => perform('The setting could not be reset.', async () => {
      const updated = await api.patch<{ setting: AppSetting; settings: AppSetting[] }>('/api/settings', { name, value: null })
      setAppSettings(updated.settings)
      notify(`${name} reset to its default.`)
      await loadConfig()
      return updated.setting
    }),
    backupNow: () => perform('The database could not be backed up.', async () => {
      const result = await api.post<{ record: { ok: boolean } }>('/api/maintenance/backup')
      await loadStatus()
      notify('A copy of the database was written.')
      return result
    }),
  }), [loadArsenalState, loadConfig, loadGrants, loadMarketplaceState, loadProviders, loadStatus, notify, perform])

  return useMemo(() => ({
    providers, status, grants, marketplace, arsenal, registry, configReport, appSettings, usage,
    loadProviders, loadStatus, loadGrants, loadMarketplaceState, loadArsenalState, loadConfig, loadSettings, loadUsage,
    ...actions,
  }), [providers, status, grants, marketplace, arsenal, registry, configReport, appSettings, usage, loadProviders, loadStatus, loadGrants, loadMarketplaceState, loadArsenalState, loadConfig, loadSettings, loadUsage, actions])
}
