import { useState } from 'react'
import type { Provider } from '../api/types'
import type { Bridge } from '../hooks/useBridge'
import { Button, Chip, inputClass, selectClass } from './primitives'
import { Icon } from './Icon'

const AUTH_STYLES = ['auto', 'bearer', 'x-api-key', 'api-key', 'header', 'none']
const editorValues = (provider: Provider) => ({ label: provider.label, baseUrl: provider.baseUrl, model: provider.model, apiKey: '', authStyle: provider.authStyle ?? 'auto', authHeader: provider.authHeader ?? '', allowPrivate: provider.allowPrivate ?? false, temperature: provider.temperature ?? 'auto', headers: JSON.stringify(provider.headers ?? {}, null, 2) })

export function ProviderCard({ bridge, provider, probe, onProbed }: { bridge: Bridge; provider: Provider; probe: string | null; onProbed: (line: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [draft, setDraft] = useState(() => editorValues(provider))
  const status = bridge.status?.providers.find((entry) => entry.id === provider.id)
  const key = provider.keySource === 'stored' ? 'stored locally' : provider.keySource === 'env' ? `from ${provider.envKey}` : provider.authStyle === 'none' ? 'no key needed' : 'not configured'

  return (
    <section aria-label={`Provider ${provider.label}`} className="bg-surface-container-low p-4 rounded-xl flex flex-col gap-3 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <Icon name="terminal" className="text-primary text-xl mt-1" />
          <div className="min-w-0"><div className="flex items-center gap-2 flex-wrap"><h3 className="text-headline-md break-words">{provider.label}</h3><Chip tone={provider.configured ? 'ok' : 'idle'}>{provider.configured ? 'configured' : 'needs a key'}</Chip>{provider.allowPrivate ? <Chip tone="busy">local network</Chip> : null}{status?.breaker?.open ? <Chip tone="bad">skipped after failures</Chip> : null}</div><p className="text-body-sm text-on-surface-variant break-words">model <code className="font-mono">{provider.model}</code> · key: {key}</p></div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button disabled={probing} onClick={async () => {
            setProbing(true)
            try {
              const { result } = await bridge.testProvider(provider.id)
              onProbed(result?.reachable ? `ok · ${result.latencyMs}ms · ${result.models?.length ?? 0} models` : String(result?.error ?? 'unreachable'))
            } catch (caught) { onProbed(caught instanceof Error ? caught.message : 'Probe failed.') } finally { setProbing(false) }
          }}>{probing ? 'Probing…' : 'Test Endpoint'}</Button>
          <Button disabled={busy} onClick={() => { setDraft(editorValues(provider)); setClearKey(false); setError(''); setEditing((current) => !current) }}>{editing ? 'Close' : 'Edit'}</Button>
          {provider.custom ? <button type="button" className="w-8 h-8 flex items-center justify-center text-error" title={`Remove ${provider.label}`} aria-label={`Remove ${provider.label}`} disabled={busy} onClick={async () => {
            setBusy(true)
            try { await bridge.removeProvider(provider.id) } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not remove the provider.') } finally { setBusy(false) }
          }}><Icon name="delete" className="text-lg" /></button> : null}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="bg-surface-container p-2.5 rounded-lg"><p className="text-label-sm text-outline uppercase">Auth</p><code className="font-mono text-body-sm text-secondary break-all">{provider.authHeader || provider.authStyle || 'auto'}</code></div>
        <div className="bg-surface-container p-2.5 rounded-lg"><p className="text-label-sm text-outline uppercase">Sampling</p><span className="font-mono text-body-sm text-primary">{provider.temperature === 'omit' ? 'provider default' : `temp ${provider.temperature ?? 'auto'}`}</span></div>
        <div className="bg-surface-container p-2.5 rounded-lg min-w-0"><p className="text-label-sm text-outline uppercase">Latency</p><span className={`font-mono text-body-sm break-words ${probe?.startsWith('ok') ? 'text-secondary' : probe ? 'text-error' : 'text-outline'}`}>{probe ?? 'not probed yet'}</span></div>
      </div>
      {error ? <p role="alert" className="text-error text-body-sm break-words">{error}</p> : null}
      {editing ? <form className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 rounded-lg border border-outline-variant/40 min-w-0" onSubmit={async (event) => {
        event.preventDefault()
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const headers = JSON.parse(draft.headers || '{}')
          if (!headers || Array.isArray(headers) || typeof headers !== 'object') throw new Error('Extra headers must be a JSON object.')
          const { apiKey, ...settings } = draft
          const saved = await bridge.saveProvider(provider, { ...settings, headers, ...(clearKey ? { apiKey: null } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
          setDraft(editorValues(saved))
          setClearKey(false)
          setEditing(false)
          onProbed('')
        } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save the provider.') } finally { setBusy(false) }
      }}>
        <label className="flex flex-col gap-1 text-label-md">Label<input className={inputClass} required maxLength={60} value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} /></label>
        <label className="flex flex-col gap-1 text-label-md">Base URL<input className={inputClass} type="url" required value={draft.baseUrl} onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))} /></label>
        <label className="flex flex-col gap-1 text-label-md">Model<input className={inputClass} required value={draft.model} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))} /></label>
        <label className="flex flex-col gap-1 text-label-md">API key<input type="password" autoComplete="off" className={inputClass} placeholder="Empty keeps the stored key" disabled={clearKey} value={draft.apiKey} onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))} /></label>
        <label className="flex flex-col gap-1 text-label-md">Auth style<select className={selectClass} value={draft.authStyle} onChange={(event) => setDraft((current) => ({ ...current, authStyle: event.target.value }))}>{AUTH_STYLES.map((style) => <option key={style} value={style}>{style}</option>)}</select></label>
        {draft.authStyle === 'header' ? <label className="flex flex-col gap-1 text-label-md">Auth header name<input className={inputClass} required pattern="[A-Za-z0-9_-]{1,64}" value={draft.authHeader} onChange={(event) => setDraft((current) => ({ ...current, authHeader: event.target.value }))} /></label> : null}
        <label className="flex flex-col gap-1 text-label-md">Sampling policy<input className={inputClass} list={`sampling-${provider.id}`} value={draft.temperature} onChange={(event) => setDraft((current) => ({ ...current, temperature: event.target.value }))} /><datalist id={`sampling-${provider.id}`}><option value="auto" /><option value="omit" /></datalist><span className="text-label-sm text-outline">auto, omit, or a temperature from 0 to 2.</span></label>
        <label className="flex flex-col gap-1 text-label-md md:col-span-2">Extra headers (JSON)<textarea className={`${inputClass} font-mono`} rows={3} value={draft.headers} onChange={(event) => setDraft((current) => ({ ...current, headers: event.target.value }))} /></label>
        <label className="flex items-center gap-2 text-body-sm"><input type="checkbox" checked={draft.allowPrivate} onChange={(event) => setDraft((current) => ({ ...current, allowPrivate: event.target.checked }))} />Allow private-network URLs for this provider</label>
        {provider.keySource === 'stored' ? <label className="flex items-center gap-2 text-body-sm text-error"><input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} />Remove stored key on save</label> : null}
        <div className="md:col-span-2 flex gap-2"><Button variant="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button><Button disabled={busy} onClick={() => setEditing(false)}>Cancel</Button></div>
      </form> : null}
    </section>
  )
}
