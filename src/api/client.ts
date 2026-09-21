/**
 * The API client: one place that knows how to talk to the bridge.
 *
 * Two things it exists for. Errors arrive as RFC 9457 problem details with
 * extensions the interface needs — the rule that denied a call, whether an approval
 * is required, what a write would change — and an `ApiError` carries all of that
 * rather than a string. And the base URL differs between running under Vite (where
 * `/api` is proxied) and running as one process (`npm start`, where the bridge
 * serves the interface itself), so nothing else should hard-code either.
 */

/** A non-2xx answer, with everything the interface needs to explain it. */
export class ApiError extends Error {
  status: number
  title: string
  rule: string | null
  approvalRequired: boolean
  payload: Record<string, unknown>

  constructor(status: number, payload: Record<string, unknown>, fallback: string) {
    const detail = typeof payload.detail === 'string' ? payload.detail : typeof payload.error === 'string' ? payload.error : fallback
    super(detail)
    this.name = 'ApiError'
    this.status = status
    this.title = typeof payload.title === 'string' ? payload.title : 'Request failed'
    this.rule = typeof payload.rule === 'string' ? payload.rule : null
    this.approvalRequired = payload.approvalRequired === true
    this.payload = payload
  }

  /** The tool call this answer is about, when there is one. */
  get toolCall(): any {
    return (this.payload as any).toolCall ?? null
  }

  /** The diff a pending write would make, when the server attached one. */
  get preview(): any {
    return (this.payload as any).preview ?? null
  }

  /** Arguments that looked like a credential, when the server flagged any. */
  get warnings(): Array<{ field: string; kinds: string[] }> {
    const warnings = (this.payload as any).warnings
    return Array.isArray(warnings) ? warnings : []
  }
}

type RequestOptions = { signal?: AbortSignal; body?: unknown; method?: string }

async function request<T>(path: string, { method = 'GET', body, signal }: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method,
    ...(signal ? { signal } : {}),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })

  // A 204, an SSE stream, or a zip has no JSON body; the caller asked for one
  // anyway only by mistake, so an empty object is the honest answer.
  const text = await response.text()
  let payload: Record<string, unknown> = {}
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { detail: text.slice(0, 500) }
    }
  }

  if (!response.ok) throw new ApiError(response.status, payload, `Request failed with ${response.status}`)
  return payload as T
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>(path, { ...options, method: 'DELETE', body }),
}

/** A download: the browser handles it, so this only builds the URL. */
export const downloadUrl = (path: string) => path

/**
 * An event stream for one run, resumed from a sequence cursor.
 *
 * Returns the source so the caller can close it. The browser reconnects on
 * its own but a *new* source does not resend anything — hence the explicit
 * ?after=: without it every run open replays the run's whole history.
 */
export function openRunStream(runId: string, handlers: { onEvent?: (event: any) => void; onDelta?: (frame: any) => void; onPartial?: (text: string) => void } = {}, after = 0) {
  const cursor = Number(after) > 0 ? `?after=${Number(after)}` : ''
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream${cursor}`)
  source.addEventListener('fulkrum', (message) => {
    try {
      handlers.onEvent?.(JSON.parse((message as MessageEvent).data))
    } catch {
      // A malformed frame is dropped rather than breaking the stream.
    }
  })
  source.addEventListener('delta', (message) => {
    try {
      handlers.onDelta?.(JSON.parse((message as MessageEvent).data))
    } catch {
      // Same: one bad frame does not end the connection.
    }
  })
  source.addEventListener('partial', (message) => {
    try {
      handlers.onPartial?.(JSON.parse((message as MessageEvent).data)?.text ?? '')
    } catch {
      // As above.
    }
  })
  return source
}
