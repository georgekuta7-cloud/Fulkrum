import { describe, expect, it } from 'vitest'
import { ApiError, api } from './client'
import { stubFetch } from '../test/setup'

/** Run a call that must fail, and hand back the error for inspection. */
async function expectApiError(operation: Promise<unknown>): Promise<ApiError> {
  try {
    await operation
  } catch (caught) {
    if (caught instanceof ApiError) return caught
    throw caught
  }
  throw new Error('expected the call to fail')
}

describe('the API client', () => {
  it('returns the parsed body for a successful request', async () => {
    const calls = stubFetch({ 'GET /api/health': { ok: true, schemaVersion: 12 } })
    const health = await api.get<{ ok: boolean; schemaVersion: number }>('/api/health')
    expect(health.schemaVersion).toBe(12)
    expect(calls[0]).toMatchObject({ url: '/api/health', method: 'GET' })
  })

  it('sends a JSON body with the right method and content type', async () => {
    const calls = stubFetch({ 'POST /api/runs': { run: { id: 'run-1' } } })
    await api.post('/api/runs', { projectId: 'p1', permissionMode: 'selective' })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toEqual({ projectId: 'p1', permissionMode: 'selective' })
  })

  it('turns a problem detail into an error the interface can explain', async () => {
    stubFetch({
      'POST /api/runs/run-1/tools': {
        __status: 409,
        body: {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'write actions require approval in selective mode.',
          error: 'write actions require approval in selective mode.',
          rule: 'ask.default',
          approvalRequired: true,
          warnings: [{ field: 'content', kinds: ['openai-key'] }],
          preview: { path: 'src/app.ts', added: 3, removed: 1, created: false },
          toolCall: { id: 'tool-1', status: 'approval_required' },
        },
      },
    })

    const error = await expectApiError(api.post('/api/runs/run-1/tools', { name: 'workspace.write' }))
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(409)
    expect(error.message).toMatch(/require approval/)
    expect(error.rule).toBe('ask.default')
    expect(error.approvalRequired).toBe(true)
    expect(error.toolCall.id).toBe('tool-1')
    expect(error.preview.added).toBe(3)
    expect(error.warnings[0].kinds).toEqual(['openai-key'])
  })

  it('still reports something useful when the body is not JSON', async () => {
    stubFetch({ 'GET /api/providers': new Response('<html>gateway error</html>', { status: 502, headers: { 'content-type': 'text/html' } }) })
    const error = await expectApiError(api.get('/api/providers'))
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(502)
    expect(error.message).toMatch(/gateway error/)
  })

  it('treats an empty body as an empty object rather than failing to parse', async () => {
    stubFetch({ 'DELETE /api/grants/g1': new Response('', { status: 200 }) })
    await expect(api.delete('/api/grants/g1')).resolves.toEqual({})
  })
})
