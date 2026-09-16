import { useState } from 'react'
import type { FormEvent } from 'react'
import { Check, Trash2 } from 'lucide-react'

/**
 * Credentials and call settings for one provider.
 *
 * Gateways disagree about how a key is presented — `Authorization: Bearer`,
 * `x-api-key`, Azure's `api-key`, a header of their own, or nothing at all for a
 * server on your own machine — so the style is configuration rather than a
 * property baked into the protocol.
 */
export type ProviderSettingsTarget = {
  id: string
  label: string
  envKey: string
  hasKey: boolean
  keySource: string | null
  authStyle: string
  authHeader: string | null
  headers: Record<string, string>
  allowPrivate: boolean
  temperature: string
}

const authStyles = [
  { value: 'auto', label: 'Automatic for this protocol' },
  { value: 'bearer', label: 'Authorization: Bearer' },
  { value: 'x-api-key', label: 'x-api-key header' },
  { value: 'api-key', label: 'api-key header (Azure)' },
  { value: 'header', label: 'A header I name' },
  { value: 'none', label: 'No authentication' },
]

function headersToText(headers: Record<string, string>) {
  return Object.entries(headers ?? {}).map(([name, value]) => `${name}: ${value}`).join('\n')
}

function textToHeaders(text: string) {
  const headers: Record<string, string> = {}
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf(':')
    if (separator < 1) throw new Error(`"${trimmed}" is not a "Name: value" header.`)
    headers[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim()
  }
  return headers
}

export function ProviderEditor({ provider, onSave, onCancel, isSaving, error }: {
  provider: ProviderSettingsTarget
  onSave: (settings: Record<string, unknown>) => void
  onCancel: () => void
  isSaving: boolean
  error: string
}) {
  const stored = provider.temperature !== 'auto' && provider.temperature !== 'omit'
  const [apiKey, setApiKey] = useState('')
  const [authStyle, setAuthStyle] = useState(provider.authStyle || 'auto')
  const [authHeader, setAuthHeader] = useState(provider.authHeader ?? '')
  const [temperatureMode, setTemperatureMode] = useState(stored ? 'custom' : provider.temperature || 'auto')
  const [temperatureValue, setTemperatureValue] = useState(stored ? provider.temperature : '0.3')
  const [allowPrivate, setAllowPrivate] = useState(provider.allowPrivate)
  const [headersText, setHeadersText] = useState(headersToText(provider.headers))
  const [localError, setLocalError] = useState('')

  const keyPlaceholder = provider.keySource === 'stored'
    ? 'Stored locally — type to replace'
    : provider.keySource === 'env'
      ? `Coming from ${provider.envKey || 'the environment'}`
      : 'Paste a key (leave empty for none)'

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLocalError('')
    try {
      const settings: Record<string, unknown> = {
        authStyle,
        authHeader: authHeader.trim() || null,
        allowPrivate,
        headers: textToHeaders(headersText),
        temperature: temperatureMode === 'custom' ? temperatureValue : temperatureMode,
      }
      if (apiKey.trim()) settings.apiKey = apiKey.trim()
      onSave(settings)
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : 'Those settings are not valid.')
    }
  }

  return (
    <form className="settings-provider-form provider-editor" onSubmit={submit}>
      <label className="provider-editor-wide">
        <span>API key</span>
        <input type="password" value={apiKey} autoComplete="off" placeholder={keyPlaceholder} onChange={(event) => setApiKey(event.target.value)} />
      </label>

      <label>
        <span>Auth style</span>
        <select value={authStyle} onChange={(event) => setAuthStyle(event.target.value)}>
          {authStyles.map((style) => <option key={style.value} value={style.value}>{style.label}</option>)}
        </select>
      </label>

      {authStyle === 'header' ? (
        <label>
          <span>Header name</span>
          <input value={authHeader} placeholder="X-Api-Token" onChange={(event) => setAuthHeader(event.target.value)} />
        </label>
      ) : null}

      <label>
        <span>Temperature</span>
        <select value={temperatureMode} onChange={(event) => setTemperatureMode(event.target.value)}>
          <option value="auto">Automatic</option>
          <option value="omit">Omit it</option>
          <option value="custom">A fixed value</option>
        </select>
      </label>

      {temperatureMode === 'custom' ? (
        <label>
          <span>Temperature value</span>
          <input value={temperatureValue} inputMode="decimal" onChange={(event) => setTemperatureValue(event.target.value)} />
        </label>
      ) : null}

      <label className="provider-editor-wide">
        <span>Extra headers, one per line</span>
        <textarea rows={2} value={headersText} placeholder="HTTP-Referer: https://example.com" onChange={(event) => setHeadersText(event.target.value)} />
      </label>

      <label className="provider-editor-check provider-editor-wide">
        <input type="checkbox" checked={allowPrivate} onChange={(event) => setAllowPrivate(event.target.checked)} />
        <span>This endpoint is on this machine or my local network</span>
      </label>

      {localError || error ? <p className="provider-form-error provider-editor-wide">{localError || error}</p> : null}

      <div className="provider-editor-actions provider-editor-wide">
        <button className="primary-button" type="submit" disabled={isSaving}>{isSaving ? 'Saving...' : <><Check size={15} />Save</>}</button>
        <button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
        {provider.keySource === 'stored' ? (
          <button className="icon-button danger" type="button" disabled={isSaving} title="Remove the stored key" onClick={() => onSave({ apiKey: null })}>
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
    </form>
  )
}
