import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { resolveOutboundTarget } from './networkPolicy.mjs'

/**
 * HTTP with the connection pinned to an address that was already checked.
 *
 * `fetch` resolves the hostname itself, so validating a name and then handing the
 * same name to `fetch` checks one address and dials another: a host that answers
 * publicly during validation and with 127.0.0.1 a moment later gets through. The
 * `lookup` hook is the single place that decides where the socket goes, so the
 * validated addresses are supplied there and nothing is resolved twice.
 *
 * The body is read with a byte cap rather than buffered whole: `await
 * response.text()` on a multi-gigabyte response runs the process out of memory
 * long before anything clips it.
 */

const defaultMaxBytes = () => Math.min(Math.max(Number(process.env.FULKRUM_MAX_HTTP_BODY_BYTES ?? 1_000_000), 1_024), 50_000_000)
const defaultTimeoutMs = () => Math.min(Math.max(Number(process.env.FULKRUM_HTTP_TIMEOUT_MS ?? 30_000), 1_000), 120_000)

/** A `net` lookup that can only return addresses this process already validated. */
export function pinnedLookup(addresses) {
  const list = addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }))
  // The name is deliberately ignored: this hook is where the decision is made, so
  // a name that resolves differently a moment later cannot change the target.
  return function lookup(_hostname, options, callback) {
    const settings = typeof options === 'function' ? {} : options ?? {}
    const done = typeof options === 'function' ? options : callback
    if (!list.length) {
      done(new Error('No validated address to connect to.'))
      return
    }
    if (settings.all) {
      done(null, list)
      return
    }
    done(null, list[0].address, list[0].family)
  }
}

/**
 * @param {string} rawUrl
 * @param {{ method?: string, headers?: Record<string, string>, body?: string | null, allowPrivate?: boolean, allowedHosts?: string[] | string, maxBytes?: number, timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function pinnedRequest(rawUrl, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    allowPrivate = false,
    allowedHosts = [],
    maxBytes = defaultMaxBytes(),
    timeoutMs = defaultTimeoutMs(),
    signal,
  } = options

  const { url, addresses } = await resolveOutboundTarget(rawUrl, { allowPrivate, allowedHosts })
  const transport = url.protocol === 'https:' ? https : http
  const timeout = AbortSignal.timeout(timeoutMs)
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout

  return await new Promise((resolve, reject) => {
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      callback(value)
    }

    const request = transport.request(
      url,
      {
        method,
        headers,
        lookup: pinnedLookup(addresses),
        // SNI keeps the name the user asked for, so the certificate is still
        // checked against it even though the socket goes to a pinned address.
        ...(net.isIP(url.hostname) ? {} : { servername: url.hostname }),
        signal: abort,
      },
      (response) => {
        const chunks = []
        let received = 0
        let truncated = false

        response.on('data', (chunk) => {
          if (truncated) return
          const remaining = maxBytes - received
          if (chunk.length >= remaining) {
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
            received += chunk.length
            truncated = true
            // Stop reading instead of buffering a body that will not be used.
            response.destroy()
            return
          }
          chunks.push(chunk)
          received += chunk.length
        })

        response.on('close', () => {
          const status = response.statusCode ?? 0
          settle(resolve, {
            status,
            ok: status >= 200 && status < 300,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            truncated,
            bytes: received,
            url: url.href,
          })
        })
        response.on('error', (error) => settle(reject, error))
      },
    )

    request.on('error', (error) => settle(reject, error))
    if (body !== null && body !== undefined) request.write(body)
    request.end()
  })
}
