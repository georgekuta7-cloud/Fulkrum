import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { buildOtlpPayload, maybeExportTrace } from '../server/otel.mjs'
import { withStore } from './helpers.mjs'

async function withCollector(callback) {
  const bodies = []
  const server = http.createServer((request, response) => {
    let text = ''
    request.on('data', (chunk) => { text += chunk })
    request.on('end', () => {
      bodies.push({ url: request.url, contentType: request.headers['content-type'], text })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  try {
    return await callback(`http://127.0.0.1:${port}/v1/traces`, bodies)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('spans translate to OTLP with hex ids, nano times, and GenAI attributes', async () => {
  await withStore((store) => {
    const project = store.createProject({ name: 'otel' })
    const run = store.createRun({ projectId: project.id })
    const span = store.startSpan({ runId: run.id, kind: 'llm', name: 'chat grok-4', attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'grok-4' } })
    store.endSpan(span.id, { status: 'ok' })

    const payload = buildOtlpPayload({ store, runId: run.id })
    const spans = payload.resourceSpans[0].scopeSpans[0].spans
    assert.equal(spans.length, 1)
    assert.match(spans[0].traceId, /^[0-9a-f]{32}$/, 'a trace id is 16 bytes of hex')
    assert.match(spans[0].spanId, /^[0-9a-f]{16}$/, 'a span id is 8 bytes of hex')
    assert.equal(spans[0].kind, 3, 'an llm span is a client span')
    assert.match(spans[0].startTimeUnixNano, /^\d{16,}$/, 'milliseconds become nanoseconds')
    const names = Object.fromEntries(spans[0].attributes.map((attribute) => [attribute.key, attribute.value]))
    assert.equal(names['gen_ai.operation.name'].stringValue, 'chat', 'provider attributes travel through')
    assert.equal(payload.resourceSpans[0].resource.attributes[0].value.stringValue, 'fulkrum')
  })
})

test('a finished run exports when configured, and stays silent otherwise', async () => {
  const previous = process.env.FULKRUM_OTLP_ENDPOINT
  try {
    await withStore(async (store) => {
      const project = store.createProject({ name: 'otel export' })
      const run = store.createRun({ projectId: project.id })
      const span = store.startSpan({ runId: run.id, kind: 'run', name: 'invoke_workflow fulkrum_run', attributes: {} })
      store.endSpan(span.id, { status: 'ok' })

      delete process.env.FULKRUM_OTLP_ENDPOINT
      assert.equal(await maybeExportTrace({ store, runId: run.id }), null, 'unconfigured exports nothing')

      await withCollector(async (endpoint, bodies) => {
        process.env.FULKRUM_OTLP_ENDPOINT = endpoint
        const result = await maybeExportTrace({ store, runId: run.id })
        assert.equal(result.status, 200)
        assert.equal(bodies.length, 1)
        assert.match(bodies[0].contentType, /application\/json/)
        const payload = JSON.parse(bodies[0].text)
        assert.equal(payload.resourceSpans[0].scopeSpans[0].spans.length, 1)
        const record = store.lastMaintenance('otel-export')
        assert.equal(record.ok, true, 'the export is recorded like any maintenance')
      })
    })
  } finally {
    if (previous === undefined) delete process.env.FULKRUM_OTLP_ENDPOINT
    else process.env.FULKRUM_OTLP_ENDPOINT = previous
  }
})
