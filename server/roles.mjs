/**
 * Agent roles. `readOnly` drives scheduling: read-only work may overlap, work
 * that can write is serialized, which matches the evidence that parallel writers
 * conflict while parallel readers do not.
 */
export const agentRoles = {
  research: {
    agentId: 'research',
    name: 'Scout',
    label: 'Research worker',
    readOnly: true,
    tools: ['workspace.list', 'workspace.read', 'workspace.search', 'http.request'],
    instructions: 'Investigate the workspace and the direction. Report findings, risks, and the evidence behind them. Do not propose code changes you have not verified against the files.',
  },
  builder: {
    agentId: 'builder',
    name: 'Forge',
    label: 'Build worker',
    readOnly: false,
    tools: ['workspace.list', 'workspace.read', 'workspace.search', 'workspace.write'],
    instructions: 'Turn the direction and the research findings into a small proof-of-value. Read before you write, keep the change narrow, and state the checks that prove it works.',
  },
}

export const roleNames = Object.keys(agentRoles)

export function roleOrDefault(role) {
  return agentRoles[role] ?? agentRoles.builder
}
