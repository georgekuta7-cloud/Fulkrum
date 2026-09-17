import { createHash } from 'node:crypto'

/**
 * Trace export over OTLP/HTTP+JSON.
 *
 * The spans Fulkrum already records use OpenTelemetry GenAI attribute names,
 * so exporting is a translation, not a new instrumentation: ids become hex,
 * milliseconds become nanoseconds, statuses become OTLP codes. JSON over HTTP
 * keeps the server dependency-free — no protobuf runtime for one endpoint —
 * and every collector that speaks OTLP/HTTP accepts it.
 */

const hexId = (value, length) => createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, length)
const nanos = (millis) => String(Math.max(Number(millis) || 0, 0) * 1_000_000)

const otlpValue = (value) => {
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  return null
}

const otlpStatus = (status) => (['error', 'failed', 'blocked'].includes(status) ? { code: 2 } : {})

/**
 * This run's spans as one OTLP resourceSpans payload.
 * @param {{ store: any, runId: string, serviceName?: string }} options
 */
export function buildOtlpPayload({ store, runId, serviceName = 'fulkrum' }) {
  const traceId = hexId(`trace:${runId}`, 32)
  const spans = store.listSpans(runId).map((span) => {
    const attributes = Object.entries(span.attributes ?? {})
      .map(([key, value]) => {
        const encoded = otlpValue(value)
        return encoded ? { key, value: encoded } : null
      })
      .filter(Boolean)
    return {
      traceId,
      spanId: hexId(`span:${span.id}`, 16),
      ...(span.parentSpanId ? { parentSpanId: hexId(`span:${span.parentSpanId}`, 16) } : {}),
      name: span.name,
      kind: span.kind === 'llm' ? 3 : 1,
      startTimeUnixNano: nanos(span.startedAt),
      endTimeUnixNano: nanos(span.endedAt ?? span.startedAt),
      attributes,
      status: otlpStatus(span.status),
    }
  })
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
      scopeSpans: [{ scope: { name: 'fulkrum' }, spans }],
    }],
  }
}

/**
 * @param {{ endpoint: string, payload: any, timeoutMs?: number }} options
 */
export async function postOtlpPayload({ endpoint, payload, timeoutMs = 10_000 }) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`OTLP export failed with status ${response.status}.`)
  return { status: response.status }
}

/**
 * Export a finished run's trace when configured, and record that it happened.
 *
 * Fire-and-forget by contract: export must never fail a run, so every failure
 * is logged and recorded rather than thrown. Unconfigured returns null, which
 * is why the orchestrator calls this unconditionally at run end.
 */
/**
 * @param {{ store: any, runId: string, log?: (message: string) => void }} options
 */
export async function maybeExportTrace({ store, runId, log = () => {} }) {
  const endpoint = String(process.env.FULKRUM_OTLP_ENDPOINT ?? '').trim()
  if (!endpoint) return null
  try {
    const payload = buildOtlpPayload({ store, runId })
    const spans = payload.resourceSpans[0].scopeSpans[0].spans.length
    const result = await postOtlpPayload({ endpoint, payload })
    store.recordMaintenance({ kind: 'otel-export', ok: true, summary: `exported ${spans} span(s) for run ${runId}`, payload: { runId, spans, endpoint } })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OTLP export failed.'
    log(`[fulkrum] ${message}`)
    try {
      store.recordMaintenance({ kind: 'otel-export', ok: false, summary: message.slice(0, 500), payload: { runId, endpoint } })
    } catch {
      // Recording the failure must not fail the run either.
    }
    return null
  }
}
