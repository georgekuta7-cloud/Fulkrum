import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { resolveOutboundTarget } from './networkPolicy.mjs'

/**
 * The same request, read as it arrives instead of buffered.
 *
 * Used for provider replies that stream: the caller iterates the body and sees
 * each chunk when it lands. Address validation, pinning, SNI, and the byte cap are
 * identical to `pinnedRequest` — a stream is not a reason to relax any of them —
 * and the cap is enforced by stopping the read rather than by buffering past it.
 *
 * @param {string} rawUrl
 * @param {{ method?: string, headers?: Record<string, string>, body?: string | null, allowPrivate?: boolean, allowedHosts?: string[] | string, maxBytes?: number, timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function pinnedStream(rawUrl, options = {}) {
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

  const opened = await new Promise((resolve, reject) => {
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const request = transport.request(
      url,
      {
        method,
        headers,
        lookup: pinnedLookup(addresses),
        ...(net.isIP(url.hostname) ? {} : { servername: url.hostname }),
        signal: abort,
      },
      (response) => {
        if (settled) return
        settled = true
        resolve({ response, request })
      },
    )
    request.on('error', fail)
    if (body !== null && body !== undefined) request.write(body)
    request.end()
  })

  const { response, request } = opened
  let received = 0
  let truncated = false

  return {
    status: response.statusCode ?? 0,
    ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
    headers: response.headers,
    url: url.href,
    get truncated() {
      return truncated
    },
    get bytes() {
      return received
    },
    close() {
      try {
        response.destroy()
      } catch {
        // Already finished.
      }
      try {
        request.destroy()
      } catch {
        // Already finished.
      }
    },
    async *[Symbol.asyncIterator]() {
      let stopped = false
      response.on('error', () => {
        stopped = true
      })
      for await (const chunk of response) {
        if (truncated || stopped) return
        const remaining = maxBytes - received
        if (chunk.length >= remaining) {
          if (remaining > 0) {
            received += remaining
            yield chunk.subarray(0, remaining)
          }
          truncated = true
          response.destroy()
          return
        }
        received += chunk.length
        yield chunk
      }
    },
  }
}

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
