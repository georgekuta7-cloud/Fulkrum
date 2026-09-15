import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRequest, parseResponse, retryDelayMs } from '../server/modelCall.mjs'
import { agentRoles } from '../server/roles.mjs'
import { isToolAllowedForRole, toolSchemas, toolsForRole, validateToolArguments } from '../server/tools.mjs'

const conversation = [
  { role: 'user', content: 'Find the config file.' },
  { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'call-1', name: 'workspace.read', arguments: { path: 'a.txt' } }] },
  { role: 'tool', results: [{ id: 'call-1', name: 'workspace.read', content: '{"path":"a.txt","content":"hello"}', isError: false }] },
]

test('each role only sees its own tools', () => {
  const research = toolsForRole(agentRoles.research).map((tool) => tool.name)
  const builder = toolsForRole(agentRoles.builder).map((tool) => tool.name)

  assert.equal(research.includes('workspace.write'), false, 'a read-only role must not be offered write')
  assert.equal(research.includes('shell.exec'), false, 'research has no need to run commands')
  assert.equal(builder.includes('workspace.write'), true)
  assert.equal(builder.includes('shell.exec'), true, 'the build worker may run commands inside the container')
  assert.equal(isToolAllowedForRole(agentRoles.research, 'workspace.read'), true)
  assert.equal(isToolAllowedForRole(agentRoles.research, 'workspace.write'), false)
  assert.equal(isToolAllowedForRole(agentRoles.research, 'shell.exec'), false)
  assert.equal(agentRoles.research.readOnly, true)
  assert.equal(agentRoles.builder.readOnly, false, 'writes must be serialized by the scheduler')

  // Every advertised tool has a schema a model can actually call.
  for (const role of Object.values(agentRoles)) {
    for (const name of role.tools) {
      assert.ok(toolSchemas[name], `${name} is advertised without a schema`)
      assert.equal(typeof toolSchemas[name].parameters.type, 'string')
    }
  }
})

test('tool arguments are validated before they reach the broker', () => {
  assert.equal(validateToolArguments('workspace.read', { path: 'a.txt' }).ok, true)
  assert.equal(validateToolArguments('workspace.read', {}).ok, false, 'a required property must be enforced')
  assert.equal(validateToolArguments('workspace.read', { path: 42 }).ok, false)
  assert.equal(validateToolArguments('workspace.read', { path: 'a.txt', extra: 1 }).ok, false, 'unknown properties are refused')
  // The command surface is open now that execution is containerized, so the
  // schema checks shape rather than an allowlist of programs.
  assert.equal(validateToolArguments('shell.exec', { command: 'node', args: ['--version'] }).ok, true)
  assert.equal(validateToolArguments('shell.exec', { command: 'git', args: ['status'] }).ok, true)
  assert.equal(validateToolArguments('shell.exec', { args: ['status'] }).ok, false, 'a command is required')
  assert.equal(validateToolArguments('shell.exec', { command: 'ls', args: 'not-an-array' }).ok, false)
  assert.equal(validateToolArguments('nonexistent.tool', {}).ok, false)
  assert.equal(validateToolArguments('workspace.read', null).ok, false)
})

test('openai-compatible requests carry tools and replay tool results', () => {
  const { url, body } = buildRequest('openai-compatible', {
    baseUrl: 'https://api.example.com/v1/',
    model: 'gpt-x',
    messages: conversation,
    tools: toolsForRole(agentRoles.research),
    instructions: 'system text',
  })

  assert.equal(url, 'https://api.example.com/v1/chat/completions')
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.tools[0].type, 'function')
  assert.equal(body.tools.some((tool) => tool.function.name === 'workspace.write'), false, 'tools must be scoped to the role')
  assert.equal(body.tool_choice, 'auto')

  const assistant = body.messages.find((message) => message.role === 'assistant')
  assert.equal(assistant.tool_calls[0].function.name, 'workspace.read')
  assert.equal(typeof assistant.tool_calls[0].function.arguments, 'string', 'OpenAI expects arguments as a JSON string')
  const toolMessage = body.messages.at(-1)
  assert.equal(toolMessage.role, 'tool')
  assert.equal(toolMessage.tool_call_id, 'call-1')
})

test('anthropic requests use content blocks and tool_result turns', () => {
  const { url, body } = buildRequest('anthropic', {
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-x',
    messages: conversation,
    tools: toolsForRole(agentRoles.builder),
    instructions: 'system text',
  })

  assert.equal(url, 'https://api.anthropic.com/v1/messages')
  assert.equal(body.system, 'system text')
  assert.equal(typeof body.max_tokens, 'number')
  assert.equal(body.tools[0].input_schema.type, 'object')

  const assistant = body.messages.find((message) => message.role === 'assistant')
  assert.equal(assistant.content[0].type, 'text')
  assert.equal(assistant.content[1].type, 'tool_use')
  assert.equal(assistant.content[1].input.path, 'a.txt')

  const toolTurn = body.messages.at(-1)
  assert.equal(toolTurn.role, 'user', 'Anthropic delivers tool results in a user turn')
  assert.equal(toolTurn.content[0].type, 'tool_result')
  assert.equal(toolTurn.content[0].tool_use_id, 'call-1')
})

test('google requests use function declarations and function responses', () => {
  const { url, body } = buildRequest('google', {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-x',
    messages: conversation,
    tools: toolsForRole(agentRoles.research),
    instructions: 'system text',
  })

  assert.match(url, /\/models\/gemini-x:generateContent$/)
  assert.equal(body.systemInstruction.parts[0].text, 'system text')
  assert.equal(body.tools[0].functionDeclarations[0].name, 'workspace.list')

  const modelTurn = body.contents.find((entry) => entry.role === 'model')
  assert.equal(modelTurn.parts.at(-1).functionCall.name, 'workspace.read')
  const toolTurn = body.contents.at(-1)
  assert.equal(toolTurn.role, 'user')
  assert.equal(toolTurn.parts[0].functionResponse.name, 'workspace.read')
})

test('responses are normalized into text, tool calls, and usage', () => {
  const openai = parseResponse('openai-compatible', {
    choices: [{ message: { content: 'thinking', tool_calls: [{ id: 'x1', function: { name: 'workspace.read', arguments: '{"path":"a.txt"}' } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } },
  })
  assert.equal(openai.text, 'thinking')
  assert.deepEqual(openai.toolCalls, [{ id: 'x1', name: 'workspace.read', arguments: { path: 'a.txt' }, invalidJson: false }])
  assert.deepEqual(openai.usage, { inputTokens: 10, billableInputTokens: 6, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 0, reasoningTokens: 2 })

  const brokenJson = parseResponse('openai-compatible', { choices: [{ message: { tool_calls: [{ id: 'x2', function: { name: 'workspace.read', arguments: 'not json' } }] } }] })
  assert.equal(brokenJson.toolCalls[0].invalidJson, true)

  const anthropic = parseResponse('anthropic', {
    content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'workspace.search', input: { query: 'x' } }],
    usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
  })
  assert.equal(anthropic.text, 'hi')
  assert.equal(anthropic.toolCalls[0].name, 'workspace.search')
  assert.equal(anthropic.usage.cacheWriteTokens, 2)

  const google = parseResponse('google', {
    candidates: [{ content: { parts: [{ text: 'ok' }, { functionCall: { name: 'workspace.list', args: { path: '.' } } }] } }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8, cachedContentTokenCount: 1, thoughtsTokenCount: 3 },
  })
  assert.equal(google.toolCalls[0].arguments.path, '.')
  assert.equal(google.usage.reasoningTokens, 3)
  assert.equal(google.toolCalls[0].id.startsWith('google-call-'), true)
})

test('retry delays honour Retry-After and stay bounded', () => {
  assert.equal(retryDelayMs(0, '2'), 2000)
  assert.ok(retryDelayMs(5) <= 8_000, 'backoff must be capped')
  assert.ok(retryDelayMs(0) >= 250, 'jitter must not collapse the delay to zero')
})
