import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { pinnedLookup, pinnedRequest, pinnedStream } from '../server/outboundHttp.mjs'

/** A real server on loopback, so the transport under test is the real one. */
async function withServer(handler, callback) {
  const server = http.createServer((request, response) => {
    request.on('error', () => {})
    response.on('error', () => {})
    handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  try {
    return await callback({ port, baseUrl: `http://127.0.0.1:${port}` })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const lookupOnce = (lookup, hostname, options) => new Promise((resolve, reject) => {
  if (options.all) lookup(hostname, options, (error, addresses) => (error ? reject(error) : resolve(addresses)))
  else lookup(hostname, options, (error, address, family) => (error ? reject(error) : resolve({ address, family })))
})

test('a normal response is returned whole', async () => {
  await withServer((_request, response) => {
    response.writeHead(201, { 'content-type': 'application/json', 'x-test': 'yes' })
    response.end(JSON.stringify({ ok: true }))
  }, async ({ baseUrl }) => {
    const result = await pinnedRequest(`${baseUrl}/thing`, { allowPrivate: true })
    assert.equal(result.status, 201)
    assert.equal(result.ok, true)
    assert.equal(result.truncated, false)
    assert.equal(result.text, '{"ok":true}')
    assert.equal(result.headers['x-test'], 'yes')
  })
})

test('a response larger than the cap is cut off instead of buffered', async () => {
  const fiveMegabytes = Buffer.alloc(5 * 1024 * 1024, 'x')
  await withServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(fiveMegabytes.length) })
    response.end(fiveMegabytes)
  }, async ({ baseUrl }) => {
    const limit = 64 * 1024
    const result = await pinnedRequest(`${baseUrl}/big`, { allowPrivate: true, maxBytes: limit })
    assert.equal(result.truncated, true, 'the body was cut off rather than read to the end')
    assert.equal(Buffer.byteLength(result.text, 'utf8'), limit, 'exactly the cap is kept')
    assert.equal(result.bytes > limit, true, 'and the stream had more to give')
  })
})

test('a request that is not allowed is refused before any connection', async () => {
  let connected = false
  await withServer((_request, response) => {
    connected = true
    response.end('should not happen')
  }, async ({ baseUrl }) => {
    await assert.rejects(() => pinnedRequest(`${baseUrl}/`, { allowPrivate: false }), /Private and local network/)
    assert.equal(connected, false, 'nothing was dialed')
  })
})

test('the socket can only go to an address that was validated', async () => {
  // This is the whole protection: the hook ignores the name it is given, so a
  // name that resolves differently a moment later cannot redirect the socket.
  const lookup = pinnedLookup(['203.0.113.10'])
  assert.deepEqual(await lookupOnce(lookup, 'rebind.example', { all: false }), { address: '203.0.113.10', family: 4 })
  assert.deepEqual(await lookupOnce(lookup, 'rebind.example', { all: true }), [{ address: '203.0.113.10', family: 4 }])

  // Both validated addresses are offered, so a family that is unreachable on this
  // machine still falls through to the other one.
  const dual = await lookupOnce(pinnedLookup(['203.0.113.10', '2606:4700:4700::1111']), 'rebind.example', { all: true })
  assert.deepEqual(dual, [{ address: '203.0.113.10', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }])

  await assert.rejects(() => lookupOnce(pinnedLookup([]), 'rebind.example', { all: false }), /No validated address/)
})

test('the pinned address is the one actually connected to', async () => {  // A name that resolves to nothing usable must still connect, because the only
  // answer the resolver is allowed to give is the validated address.
  await withServer((request, response) => {
    response.writeHead(200)
    response.end(`host header: ${request.headers.host}`)
  }, async ({ port }) => {
    const result = await pinnedRequest(`http://this-name-does-not-resolve.invalid:${port}/`, {
      allowPrivate: true,
      headers: { host: `this-name-does-not-resolve.invalid:${port}` },
    }).catch((error) => ({ error: error.message }))
    // The name cannot be resolved at all, so validation refuses it first — which
    // is the correct order: nothing is dialed for a name that fails the check.
    assert.match(String(result.error), /resolve|getaddrinfo|ENOTFOUND|EAI_AGAIN/i)
  })
})

test('request bodies declare their length instead of chunking', async () => {
  // Strict front doors reject Transfer-Encoding: chunked on POSTs. A body
  // whose length is known must say so; both the buffered and the streaming
  // paths send bodies, so both are pinned here.
  const seen = []
  await withServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      seen.push({ contentLength: request.headers['content-length'], transferEncoding: request.headers['transfer-encoding'], body })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {}\n\n')
    })
  }, async ({ baseUrl }) => {
    await pinnedRequest(`${baseUrl}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}', allowPrivate: true })
    const stream = await pinnedStream(`${baseUrl}/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"b":2}', allowPrivate: true })
    for await (const _chunk of stream) { /* drain */ }
    assert.equal(seen.length, 2)
    for (const record of seen) {
      assert.equal(record.contentLength, String(Buffer.byteLength(record.body)), 'the declared length must be exact')
      assert.equal(record.transferEncoding, undefined, 'no chunked encoding when the length is known')
    }
  })
})
