/**
 * The tool surface agents can see, described as JSON Schema so a model can call
 * it directly.
 *
 * Descriptions matter more than they look: this text is the model's only
 * documentation for what a tool does, so each one states the constraint that
 * matters (paths stay in the workspace, credentials are refused) rather than
 * only the happy path.
 */
export const toolSchemas = {
  'workspace.list': {
    kind: 'read',
    description: 'List files and directories inside the workspace. Use it to orient before reading.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the workspace root. Defaults to the root.' },
      },
      additionalProperties: false,
    },
  },
  'workspace.read': {
    kind: 'read',
    description: 'Read one UTF-8 text file inside the workspace. Credential files such as .env or private keys are refused.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  'workspace.search': {
    kind: 'read',
    description: 'Search the workspace for a literal string and return matching file paths with line numbers. Prefer this over reading many files.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal text to find, case-insensitive.' },
        path: { type: 'string', description: 'Directory to search, relative to the workspace root. Defaults to the root.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  'workspace.write': {
    kind: 'write',
    description: 'Create or overwrite one UTF-8 text file inside the workspace. Requires approval outside autopilot, and the exact content is what gets approved.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'Full file contents to write.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  'shell.exec': {
    kind: 'shell',
    description: 'Run a command inside the sandboxed workspace container. The container has no network, a read-only filesystem outside the workspace, and a non-root user. Arguments are passed as an array, so no shell interprets them.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Program to run, for example "git", "node", or "./scripts/build.sh".' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments, one per array entry. No quoting is needed or interpreted.' },
        cwd: { type: 'string', description: 'Working directory inside the workspace. Defaults to the workspace root.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  'http.request': {
    kind: 'http',
    description: 'Call an HTTP or HTTPS endpoint. Private and loopback addresses are blocked, and hosts outside the configured allowlist need approval.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http or https URL.' },
        method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method.' },
        headers: { type: 'object', description: 'Request headers.' },
        body: { description: 'JSON request body.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
}

export function toolDefinition(name) {
  const schema = toolSchemas[name]
  if (!schema) return null
  return { name, kind: schema.kind, description: schema.description, parameters: schema.parameters }
}

/** Only these tools exist for a role. Anything else is not even described to the model. */
export function toolsForRole(role) {
  return (role?.tools ?? []).map(toolDefinition).filter(Boolean)
}

export function isToolAllowedForRole(role, name) {
  return Boolean(role?.tools?.includes(name))
}

/**
 * Validate a tool call's arguments against its schema before it reaches the
 * broker. The broker still re-resolves and re-checks everything: this only turns
 * a malformed call into a clear message the model can act on.
 */
export function validateToolArguments(name, args) {
  const schema = toolSchemas[name]?.parameters
  if (!schema) return { ok: false, error: `Unknown tool: ${name}` }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'Arguments must be a JSON object.' }

  const problems = []
  for (const required of schema.required ?? []) {
    if (args[required] === undefined) problems.push(`Missing required property: ${required}`)
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key]
    if (!property) {
      problems.push(`Unexpected property: ${key}`)
      continue
    }
    if (property.type === 'string' && typeof value !== 'string') problems.push(`${key} must be a string`)
    if (property.type === 'array' && !Array.isArray(value)) problems.push(`${key} must be an array`)
    if (property.type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) problems.push(`${key} must be an object`)
    if (Array.isArray(property.enum) && value !== undefined && !property.enum.includes(value)) problems.push(`${key} must be one of: ${property.enum.join(', ')}`)
  }

  return problems.length ? { ok: false, error: `Invalid arguments for ${name}: ${problems.join('; ')}` } : { ok: true }
}
