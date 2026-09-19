/**
 * The HTTP surface, described once.
 *
 * Served as OpenAPI 3.1 at `GET /api/openapi.json`, so a client can be generated
 * or checked rather than read out of the source. It is written by hand and kept
 * honest by a test that calls every documented route: a route that disappears, or
 * a documented route that never existed, fails the suite.
 */

const errorResponse = {
  description: 'An RFC 9457 problem detail. `detail` carries the message and `error` repeats it for older clients.',
  content: {
    'application/problem+json': {
      schema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'integer' },
          detail: { type: 'string' },
          error: { type: 'string', deprecated: true },
        },
        required: ['status', 'detail'],
      },
    },
  },
}

const json = (description, schema = { type: 'object' }) => ({ description, content: { 'application/json': { schema } } })
const identifier = (name, description) => ({ name, in: 'path', required: true, description, schema: { type: 'string' } })

/** @type {Array<{ method: string, path: string, summary: string, description?: string, tags: string[], request?: any, response?: any, errors?: number[] }>} */
export const endpoints = [
  { method: 'GET', path: '/api/health', summary: 'Liveness, schema version, and the execution boundary', tags: ['system'] },
  { method: 'GET', path: '/api/config', summary: 'Every setting with its effective value, and any that could not be used', tags: ['system'] },
  { method: 'GET', path: '/api/openapi.json', summary: 'This document', tags: ['system'] },
  { method: 'GET', path: '/api/settings', summary: 'Every setting with its value, source, and restart flag', tags: ['system'] },
  { method: 'PATCH', path: '/api/settings', summary: 'Change a setting ({ name, value }); null resets it', tags: ['system'], errors: [400] },
  { method: 'GET', path: '/api/tools', summary: 'Tool definitions, role allowlists, and the permission matrix', tags: ['system'] },

  { method: 'GET', path: '/api/providers', summary: 'Providers with whether they are configured (never a key)', tags: ['providers'] },
  { method: 'POST', path: '/api/providers', summary: 'Add a custom OpenAI-compatible provider', tags: ['providers'], errors: [400] },
  { method: 'PATCH', path: '/api/providers/{providerId}', summary: 'Update credentials and call settings for any provider', tags: ['providers'], errors: [400, 404] },
  { method: 'DELETE', path: '/api/providers/{providerId}', summary: 'Remove a custom provider', tags: ['providers'], errors: [400] },
  { method: 'POST', path: '/api/providers/{providerId}/test', summary: 'Probe a provider: status, latency, and its model list', tags: ['providers'], errors: [404] },

  { method: 'POST', path: '/api/chat', summary: 'One Head AI turn. `demo: true` means no provider key was configured', tags: ['chat'], errors: [400, 404, 502] },
  { method: 'GET', path: '/api/runs/{runId}/stream', summary: 'Run events as they happen; resumes from Last-Event-ID', tags: ['runs'], errors: [404] },

  { method: 'GET', path: '/api/projects', summary: 'All projects', tags: ['projects'] },
  { method: 'POST', path: '/api/projects', summary: 'Create a project', tags: ['projects'], errors: [400] },
  { method: 'GET', path: '/api/projects/default', summary: 'The default project, created if absent', tags: ['projects'] },
  { method: 'GET', path: '/api/projects/{projectId}', summary: 'A project and its runs', tags: ['projects'], errors: [404] },
  { method: 'PATCH', path: '/api/projects/{projectId}', summary: 'Rename a project or store its settings, such as role routing', tags: ['projects'], errors: [400, 404] },
  { method: 'DELETE', path: '/api/projects/{projectId}', summary: 'Delete a project and everything it owns', tags: ['projects'], errors: [404, 409] },

  { method: 'POST', path: '/api/runs', summary: 'Create a run in a project', tags: ['runs'], errors: [400] },
  { method: 'GET', path: '/api/runs', summary: 'Run history with what each one cost; ?projectId=, ?active=1, ?status=', tags: ['runs'] },
  { method: 'GET', path: '/api/search', summary: 'Messages and events matching a phrase: ?q=, ?projectId=', tags: ['runs'], errors: [400] },
  { method: 'GET', path: '/api/workspace/tree', summary: 'The workspace as the tools see it: ?path=, ?depth=', tags: ['runs'], errors: [400] },
  { method: 'GET', path: '/api/workspace/history', summary: 'Every tool call that touched one file: ?path=', tags: ['runs'], errors: [400] },
  { method: 'GET', path: '/api/status', summary: 'Version, storage, backups, anchors, engine, provider health', tags: ['system'] },
  { method: 'POST', path: '/api/maintenance/verify', summary: 'Walk every audit chain, and record the result', tags: ['system'] },
  { method: 'POST', path: '/api/maintenance/backup', summary: 'Take a copy of the database, and record it', tags: ['system'] },
  { method: 'POST', path: '/api/runs/{runId}/fork', summary: 'Re-run a plan as a new run, awaiting approval again', tags: ['runs'], errors: [404, 409] },
  { method: 'GET', path: '/api/runs/{runId}', summary: 'Everything about a run: messages, tasks, tool calls, events, audit', tags: ['runs'], errors: [404] },
  { method: 'GET', path: '/api/runs/{runId}/events', summary: 'Every recorded event, in order', tags: ['runs'], errors: [404] },
  { method: 'GET', path: '/api/runs/{runId}/audit', summary: 'Chain verification for this run, including truncation', tags: ['runs'], errors: [404] },
  { method: 'GET', path: '/api/runs/{runId}/trace', summary: 'Spans, priced calls, and the spend total', tags: ['runs'], errors: [404] },
  { method: 'GET', path: '/api/runs/{runId}/report', summary: 'A reviewable report of the run, as Markdown or JSON', tags: ['runs'], errors: [404] },
  { method: 'GET', path: '/api/runs/{runId}/plan', summary: 'The current plan for a run', tags: ['runs'], errors: [404] },
  { method: 'POST', path: '/api/runs/{runId}/plan', summary: 'Draft or redraft a plan ({ regenerate: true } to replace)', tags: ['runs'], errors: [404, 409] },
  { method: 'PATCH', path: '/api/runs/{runId}/plan', summary: 'Edit a plan: validated, re-hashed, and back to a draft', tags: ['runs'], errors: [400, 404, 409] },
  { method: 'GET', path: '/api/runs/{runId}/estimate', summary: 'What the plan is likely to cost, as a range with its basis', tags: ['runs'], errors: [404] },
  { method: 'GET', path: '/api/runs/{runId}/bundle', summary: 'A zip of the report, events, artifacts, and every file the run touched', tags: ['runs'], errors: [404] },
  { method: 'GET', path: '/api/runs/{runId}/tools/{toolCallId}/preview', summary: 'Why a call stopped, what looks risky, and what a write would change', tags: ['runs'], errors: [404, 409] },
  { method: 'GET', path: '/api/usage', summary: 'Spend over time, by model, provider, and role: ?days=, ?projectId=', tags: ['system'] },
  { method: 'GET', path: '/api/grants', summary: 'Standing grants, with when each was created or revoked', tags: ['system'] },
  { method: 'POST', path: '/api/grants', summary: 'Create a standing grant for a path or a host', tags: ['system'], errors: [400] },
  { method: 'DELETE', path: '/api/grants/{grantId}', summary: 'Revoke a standing grant', tags: ['system'], errors: [404] },
  { method: 'POST', path: '/api/runs/{runId}/control', summary: 'approve-plan, pause, resume, cancel, or set-budget', tags: ['runs'], errors: [400, 404, 409] },
  { method: 'GET', path: '/api/runs/{runId}/tools', summary: 'Every tool call this run has made', tags: ['runs'], errors: [404] },
  { method: 'POST', path: '/api/runs/{runId}/tools', summary: 'Request a tool call; returns 409 when it needs approval', tags: ['runs'], errors: [400, 403, 404, 409] },
  { method: 'POST', path: '/api/runs/{runId}/tools/{toolCallId}/approve', summary: 'Approve a parked call, bound to its fingerprint; pass editedInput to approve edited arguments as a new call', tags: ['runs'], errors: [400, 403, 409] },
  { method: 'POST', path: '/api/runs/{runId}/tools/{toolCallId}/deny', summary: 'Deny a parked call, and tell the worker why', tags: ['runs'], errors: [409] },
  { method: 'POST', path: '/api/runs/{runId}/tools/{toolCallId}/answer', summary: 'Answer a parked run.ask question; the answer becomes its tool result', tags: ['runs'], errors: [400, 409, 413] },
  { method: 'POST', path: '/api/maintenance/export-trace', summary: 'Export one run trace to the OTLP endpoint, when configured', tags: ['system'], errors: [404] },
  { method: 'GET', path: '/api/runs/{runId}/grants', summary: 'Approvals that cover the rest of this run', tags: ['runs'], errors: [404] },
  { method: 'DELETE', path: '/api/runs/{runId}/grants/{toolName}', summary: 'Revoke a run-wide approval', tags: ['runs'], errors: [404] },
  { method: 'GET', path: '/api/runs/{runId}/artifacts', summary: 'Files this run wrote, with their diffs', tags: ['runs'], errors: [404] },
]

/** The OpenAPI document for the surface above. */
export function openApiDocument({ version = '0.2.0-dev' } = {}) {
  const paths = {}
  for (const endpoint of endpoints) {
    const path = paths[endpoint.path] ?? (paths[endpoint.path] = {})
    const parameters = [...endpoint.path.matchAll(/\{(\w+)\}/g)].map((match) => identifier(match[1], `The ${match[1]} to act on.`))
    path[endpoint.method.toLowerCase()] = {
      summary: endpoint.summary,
      description: endpoint.description,
      tags: endpoint.tags,
      ...(parameters.length ? { parameters } : {}),
      ...(endpoint.request ? { requestBody: endpoint.request } : {}),
      responses: {
        ...(endpoint.response ? { 200: endpoint.response } : { 200: json('The requested resource.') }),
        ...Object.fromEntries((endpoint.errors ?? []).map((status) => [String(status), errorResponse])),
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Fulkrum local API',
      version,
      summary: 'A single-user, local-first multi-agent workspace.',
      description: [
        'Binds to 127.0.0.1 only, and has no authentication: it is protected by loopback binding and an origin check, which is CSRF protection rather than access control.',
        'Errors are RFC 9457 problem details (`application/problem+json`), with `error` kept as a deprecated alias.',
        'Run creation, chat, and tool execution are the parts that cost money and change files; everything else is a read.',
      ].join('\n\n'),
    },
    servers: [{ url: 'http://127.0.0.1:8787', description: 'The default port; FULKRUM_API_PORT changes it.' }],
    tags: [
      { name: 'system', description: 'Health, configuration, and what the tool surface is.' },
      { name: 'providers', description: 'Model endpoints. Keys are stored locally and never returned.' },
      { name: 'chat', description: 'The Head AI conversation.' },
      { name: 'projects', description: 'Workspaces that own runs.' },
      { name: 'runs', description: 'A run: its plan, its tasks, its tool calls, and its audit trail.' },
    ],
    paths,
  }
}
