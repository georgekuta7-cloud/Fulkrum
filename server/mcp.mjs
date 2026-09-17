import { createInterface } from 'node:readline'
import { buildRunReport } from './runReport.mjs'
import { toolSchemas } from './tools.mjs'

/**
 * Fulkrum as an MCP server, over newline-delimited JSON-RPC on stdio.
 *
 * Read-only by construction: only the tools that can never mutate anything
 * are exposed, and every call walks the same resolve-and-authorize path the
 * agents use — a read that the policy would refuse is refused here too,
 * returned as a tool error rather than executed. Writes, commands, and HTTP
 * stay behind the approval dock, where a human can see them.
 *
 *   npm run mcp
 */

const exposed = [
  { mcp: 'workspace_list', broker: 'workspace.list' },
  { mcp: 'workspace_read', broker: 'workspace.read' },
  { mcp: 'workspace_search', broker: 'workspace.search' },
]

const reportInputSchema = {
  type: 'object',
  properties: {
    runId: { type: 'string', description: 'The run to write up.' },
  },
  required: ['runId'],
  additionalProperties: false,
}

const textResult = (text, isError = false) => ({
  content: [{ type: 'text', text: String(text) }],
  ...(isError ? { isError: true } : {}),
})

export function createMcpServer({ toolBroker, store }) {
  const byName = new Map(exposed.map((entry) => [entry.mcp, entry.broker]))

  const callBrokerTool = async (brokerName, args) => {
    const tool = toolBroker.get(brokerName)
    const resolution = toolBroker.resolve(brokerName, args ?? {})
    if (!resolution?.ok) return textResult(`Cannot resolve ${brokerName}: ${resolution?.error ?? 'unknown error'}`, true)
    const authorization = toolBroker.authorize({ mode: 'selective', tool, resolution })
    if (!authorization.allowed) return textResult(`Refused (${authorization.ruleId}): ${authorization.reason}`, true)
    try {
      const output = toolBroker.redact(await toolBroker.execute(brokerName, args ?? {}, resolution, {}))
      return textResult(JSON.stringify(output, null, 2))
    } catch (error) {
      return textResult(error instanceof Error ? error.message : 'Tool execution failed.', true)
    }
  }

  const callReport = (args) => {
    const runId = args?.runId
    if (typeof runId !== 'string' || !runId) return textResult('runId is required.', true)
    const report = buildRunReport({ store, runId })
    if (!report) return textResult('Run not found.', true)
    const text = JSON.stringify(report, null, 2)
    const maximum = 500_000
    return textResult(text.length > maximum ? `${text.slice(0, maximum)}\n[report clipped]` : text)
  }

  const handleRequest = async (message) => {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request: JSON-RPC 2.0 with a method is required.' } }
    }
    const { id = null, method, params = {} } = message
    const respond = (result) => (id === null || id === undefined ? null : { jsonrpc: '2.0', id, result })
    const fail = (code, text) => (id === null || id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message: text } })

    if (method === 'initialize') {
      return respond({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fulkrum', version: '0.2.0' } })
    }
    if (method === 'ping') return respond({})
    if (method === 'notifications/initialized') return null
    if (method === 'tools/list') {
      return respond({
        tools: [
          ...exposed.map(({ mcp, broker }) => ({ name: mcp, description: toolSchemas[broker].description, inputSchema: toolSchemas[broker].parameters })),
          { name: 'run_report', description: 'Write up a run: plan, tasks, artifacts, spend, and audit state.', inputSchema: reportInputSchema },
        ],
      })
    }
    if (method === 'tools/call') {
      const name = params?.name
      if (name === 'run_report') return respond(await callReport(params?.arguments))
      const brokerName = byName.get(name)
      if (!brokerName) return fail(-32602, `Unknown tool: ${name ?? '(missing)'}. Only read-only tools are exposed.`)
      return respond(await callBrokerTool(brokerName, params?.arguments))
    }
    return fail(-32601, `Unknown method: ${method ?? '(missing)'}`)
  }

  return { handleRequest }
}

// Windows spells the path with backslashes, so normalize before comparing:
// without this the server exits silently instead of serving.
const isMain = process.argv[1] === new URL(import.meta.url).pathname || String(process.argv[1] ?? '').replaceAll('\\', '/').endsWith('server/mcp.mjs')
if (isMain) {
  const { FulkrumToolBroker } = await import('./toolBroker.mjs')
  const { FulkrumStore } = await import('./store.mjs')
  const toolBroker = new FulkrumToolBroker({})
  const store = new FulkrumStore()
  const server = createMcpServer({ toolBroker, store })
  const lines = createInterface({ input: process.stdin, terminal: false })
  for await (const line of lines) {
    if (!line.trim()) continue
    let message = null
    try {
      message = JSON.parse(line)
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Unparseable JSON.' } })}\n`)
      continue
    }
    try {
      const response = await server.handleRequest(message)
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
    } catch (error) {
      const id = message && typeof message === 'object' ? message.id ?? null : null
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error.' } })}\n`)
    }
  }
}
