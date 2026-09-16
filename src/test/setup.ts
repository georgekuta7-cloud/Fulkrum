import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// Each test gets a clean document and a clean fetch: a stub that leaks between
// tests is how a suite starts passing for the wrong reason.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A fetch stub that answers by route, so a test states only what it cares about. */
export function stubFetch(routes: Record<string, unknown | ((init?: RequestInit) => unknown)>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = null
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null
    } catch {
      body = init?.body
    }
    calls.push({ url, method, body })

    const match = Object.keys(routes).find((key) => {
      const [keyMethod, keyPath] = key.includes(' ') ? key.split(' ') : ['GET', key]
      return keyMethod.toUpperCase() === method && url.includes(keyPath)
    })
    if (!match) return new Response(JSON.stringify({ detail: `no stub for ${method} ${url}` }), { status: 404, headers: { 'content-type': 'application/problem+json' } })

    const value = routes[match] as any
    const payload = typeof value === 'function' ? value(init) : value
    if (payload instanceof Response) return payload
    const status = payload?.__status ?? 200
    const bodyPayload = payload?.__status ? payload.body : payload
    return new Response(JSON.stringify(bodyPayload ?? {}), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } })
  })
  vi.stubGlobal('fetch', stub)
  return calls
}
