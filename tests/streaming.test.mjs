import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { createProviderStream } from '../server/modelCall.mjs'
import { createSseParser, formatSseFrame } from '../server/sse.mjs'
import { withServer } from './helpers.mjs'

const openAiFrames = [
  'data: {"choices":[{"delta":{"content":"Look"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"ing "}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"now."}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":21,"completion_tokens":3}}\n\n',
  'data: [DONE]\n\n',
]

const openAiToolFrames = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"workspace.read","arguments":""}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n',
  'data: [DONE]\n\n',
]

const anthropicFrames = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"workspace.read"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Reading it."}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
]

const googleFrames = [
  'data: {"candidates":[{"content":{"parts":[{"text":"Look"}]}}]}\n\n',
  'data: {"candidates":[{"content":{"parts":[{"text":"ing now."}]}}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":4}}\n\n',
]

test('the frame parser survives split, batched, and CRLF frames', () => {
  const parser = createSseParser()
  // One frame split across three chunks.
  assert.deepEqual(parser.push('id: 4\neve'), [])
  assert.deepEqual(parser.push('nt: fulkrum\ndata: {"a"'), [])
  const frames = parser.push(':1}\n\n')
  assert.deepEqual(frames, [{ event: 'fulkrum', data: '{"a":1}', id: '4' }])

  // Two frames in one chunk, and a CRLF frame.
  const batched = parser.push('data: one\n\ndata: two\n\n').map((frame) => frame.data)
  assert.deepEqual(batched, ['one', 'two'])
  assert.deepEqual(parser.push('data: three\r\n\r\n').map((frame) => frame.data), ['three'])

  // A comment-only frame keeps the connection warm and carries no data.
  assert.deepEqual(parser.push(': heartbeat\n\n'), [{ event: 'message', data: '', id: null }])
  // A multi-line data field is joined with newlines, per the event-stream grammar.
  assert.deepEqual(parser.push('data: a\ndata: b\n\n')[0].data, 'a\nb')
  assert.equal(parser.flush(), '')
})

test('the frames this server writes are the frames this parser reads', () => {
  const parser = createSseParser()
  const written = formatSseFrame({ id: 7, event: 'fulkrum', data: JSON.stringify({ hello: 'world' }) }) + formatSseFrame({ event: 'delta', data: '{"delta":"hi"}' })
  const frames = parser.push(written)
  assert.equal(frames[0].id, '7')
  assert.deepEqual(JSON.parse(frames[0].data), { hello: 'world' })
  assert.equal(frames[1].event, 'delta')
})

test('an OpenAI stream becomes the same shape as a buffered reply', () => {
  const stream = createProviderStream('openai-compatible')
  let text = ''
  for (const frame of openAiFrames) text += stream.push(frame)
  const result = stream.finish()
  assert.equal(text, 'Looking now.')
  assert.equal(result.text, 'Looking now.')
  assert.deepEqual(result.toolCalls, [])
  assert.equal(result.usage.inputTokens, 21)
  assert.equal(result.usage.outputTokens, 3)

  // Tool arguments arrive as fragments and have to be reassembled.
  const tools = createProviderStream('openai-compatible')
  for (const frame of openAiToolFrames) tools.push(frame)
  const withTool = tools.finish()
  assert.equal(withTool.toolCalls.length, 1)
  assert.equal(withTool.toolCalls[0].name, 'workspace.read')
  assert.deepEqual(withTool.toolCalls[0].arguments, { path: 'a.txt' })
})

test('an Anthropic stream assembles typed events and tool input', () => {
  const stream = createProviderStream('anthropic')
  let text = ''
  for (const frame of anthropicFrames) text += stream.push(frame)
  const result = stream.finish()
  assert.equal(text, 'Reading it.')
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].id, 'toolu_1')
  assert.deepEqual(result.toolCalls[0].arguments, { path: 'a.txt' })
  assert.equal(result.usage.inputTokens, 12)
  assert.equal(result.usage.outputTokens, 7, 'the closing usage event is merged, not replaced')
})

test('a Google stream yields parts and usage', () => {
  const stream = createProviderStream('google')
  let text = ''
  for (const frame of googleFrames) text += stream.push(frame)
  const result = stream.finish()
  assert.equal(text, 'Looking now.')
  assert.equal(result.usage.inputTokens, 9)
  assert.equal(result.usage.outputTokens, 4)
})

test('a streamed call delivers pieces as they arrive, then the whole reply', async () => {
  const chunks = ['Hel', 'lo ', 'there']
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    let index = 0
    const send = () => {
      if (index < chunks.length) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index] } }] })}\n\n`)
        index += 1
        setTimeout(send, 15)
        return
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    }
    send()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0

  try {
    const { createModelCaller } = await import('../server/modelCall.mjs')
    const { createProviderRegistry } = await import('../server/providerRegistry.mjs')
    const { FulkrumStore } = await import('../server/store.mjs')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')

    const directory = await mkdtemp(path.join(tmpdir(), 'fulkrum-stream-'))
    const store = new FulkrumStore(path.join(directory, 'db.sqlite'))
    try {
      const registry = createProviderRegistry(store)
      registry.addCustom({ label: 'Streaming', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stream-1', apiKey: 'sk-stream', allowPrivate: true })
      const caller = createModelCaller({ providerRegistry: registry })
      const provider = registry.resolve('Streaming')

      const deltas = []
      const arrivalTimes = []
      const result = await caller.callModel(provider, 'stream-1', [{ role: 'user', content: 'hi' }], {
        onDelta: (delta) => {
          deltas.push(delta)
          arrivalTimes.push(Date.now())
        },
      })

      assert.deepEqual(deltas, chunks, 'each piece is handed over as it arrives')
      assert.equal(result.text, 'Hello there')
      assert.equal(result.usage.inputTokens, 5, 'usage from the closing chunk is kept')
      assert.equal(arrivalTimes[arrivalTimes.length - 1] - arrivalTimes[0] >= 20, true, 'pieces arrive over time rather than all at once')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a stream that fails before its first token is retried, and one that fails after is not', async () => {
  let calls = 0
  const server = http.createServer((_request, response) => {
    calls += 1
    if (calls === 1) {
      // Fails before sending anything: a retry is invisible to the viewer.
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'try again' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'second attempt' } }] })}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0

  const previous = process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS
  process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS = '3'
  try {
    const { createModelCaller } = await import('../server/modelCall.mjs')
    const { createProviderRegistry } = await import('../server/providerRegistry.mjs')
    const { FulkrumStore } = await import('../server/store.mjs')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')

    const directory = await mkdtemp(path.join(tmpdir(), 'fulkrum-stream-retry-'))
    const store = new FulkrumStore(path.join(directory, 'db.sqlite'))
    try {
      const registry = createProviderRegistry(store)
      registry.addCustom({ label: 'Flaky stream', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stream-2', apiKey: 'sk-stream', allowPrivate: true })
      const caller = createModelCaller({ providerRegistry: registry })
      const deltas = []
      const result = await caller.callModel(registry.resolve('Flaky stream'), 'stream-2', [{ role: 'user', content: 'hi' }], { onDelta: (delta) => deltas.push(delta) })
      assert.equal(calls, 2, 'the failure before the first token was retried')
      assert.equal(result.text, 'second attempt')
      assert.deepEqual(deltas, ['second attempt'])
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  } finally {
    if (previous === undefined) delete process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS
    else process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS = previous
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a tool name that arrives twice is one name, not two', () => {
  // Some gateways resend the whole name in the chunk after the one that introduced
  // it. Concatenating blindly would produce "workspace.readworkspace.read", which is
  // a tool nobody has.
  const stream = createProviderStream('openai-compatible')
  stream.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"workspace.read","arguments":"{\\"path\\":"}}]}}]}\n\n')
  stream.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"workspace.read","arguments":"\\"a.txt\\"}"}}]}}]}\n\n')
  const result = stream.finish()
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].name, 'workspace.read')
  assert.deepEqual(result.toolCalls[0].arguments, { path: 'a.txt' })

  // And a name genuinely split across chunks is still reassembled.
  const split = createProviderStream('openai-compatible')
  split.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"workspace."}}]}}]}\n\n')
  split.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{}"}}]}}]}\n\n')
  assert.equal(split.finish().toolCalls[0].name, 'workspace.read')
})

test('a streamed wire name arrives verbatim; the declared map resolves it, not the parser', () => {
  const stream = createProviderStream('openai-compatible')
  stream.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"workspace_read","arguments":"{}"}}]}}]}\n\n')
  // finish() does not interpret: strict resolution happens in callModel.
  assert.equal(stream.finish().toolCalls[0].name, 'workspace_read')
})

test('a stream cut off part way is an error, not a short answer', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'half an answer' } }] })}\n\n`)
    // Then the connection dies without a terminator: what a dropped upstream, a
    // proxy timeout, or a killed provider looks like from here.
    setTimeout(() => response.destroy(), 20)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0

  const previous = process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS
  process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS = '1'
  try {
    const { createModelCaller } = await import('../server/modelCall.mjs')
    const { createProviderRegistry } = await import('../server/providerRegistry.mjs')
    const { FulkrumStore } = await import('../server/store.mjs')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')

    const directory = await mkdtemp(path.join(tmpdir(), 'fulkrum-stream-cut-'))
    const store = new FulkrumStore(path.join(directory, 'db.sqlite'))
    try {
      const registry = createProviderRegistry(store)
      registry.addCustom({ label: 'Cut off', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'cut-1', apiKey: 'sk-cut', allowPrivate: true })
      const caller = createModelCaller({ providerRegistry: registry })
      const deltas = []
      await assert.rejects(
        () => caller.callModel(registry.resolve('Cut off'), 'cut-1', [{ role: 'user', content: 'hi' }], { onDelta: (delta) => deltas.push(delta) }),
        (error) => /aborted|socket|closed|premature|ECONNRESET/i.test(error instanceof Error ? error.message : String(error)),
        'a truncated stream must fail rather than look like a complete short reply',
      )
      assert.deepEqual(deltas, ['half an answer'], 'what arrived before the cut was still delivered')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  } finally {
    if (previous === undefined) delete process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS
    else process.env.FULKRUM_PROVIDER_MAX_ATTEMPTS = previous
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the run stream carries partial text as its own frame', async () => {
  await withServer(async ({ baseUrl, store, request }) => {
    const project = await request('POST', '/api/projects', { name: 'stream fixture' })
    const run = await request('POST', '/api/runs', { projectId: project.payload.project.id })
    const runId = run.payload.run.id

    // One piece before the connection, one after: a client that connects mid-reply
    // should get what has already arrived plus everything from then on.
    const sink = store.partialSink(runId, { role: 'head' })
    sink.push('already here. ')

    const controller = new AbortController()
    const response = await fetch(`${baseUrl}/api/runs/${runId}/stream`, { signal: controller.signal })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const deadline = Date.now() + 4_000
    try {
      while (Date.now() < deadline && !text.includes('and more')) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
        if (text.includes('already here.')) sink.push('and more')
      }
    } finally {
      sink.done()
      controller.abort()
    }

    assert.match(text, /event: partial/, 'the text already produced is sent on connect')
    assert.match(text, /already here\./, 'and it is the text that had arrived')
    assert.match(text, /event: delta/, 'later pieces arrive as deltas')
    assert.match(text, /and more/)
    assert.equal(store.getPartial(runId), null, 'the partial is cleared when the call finishes')
  })
})
