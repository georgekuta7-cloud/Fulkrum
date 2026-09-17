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
    tools: ['workspace.list', 'workspace.read', 'workspace.search', 'http.request', 'run.ask'],
    instructions: 'Investigate the workspace and the direction. Report findings, risks, and the evidence behind them. Do not propose code changes you have not verified against the files.',
  },
  builder: {
    agentId: 'builder',
    name: 'Forge',
    label: 'Build worker',
    readOnly: false,
    // The container is the boundary for command execution, which is what makes a
    // general command tool defensible here. Research stays without one: it has no
    // need to run anything, and a narrower surface is a narrower surface.
    tools: ['workspace.list', 'workspace.read', 'workspace.search', 'workspace.write', 'shell.exec', 'run.ask'],
    instructions: 'Turn the direction and the research findings into a small proof-of-value. Read before you write, keep the change narrow, and state the checks that prove it works. Commands you run execute inside a sandboxed container with no network access, so build and test offline.',
  },
}

export const roleNames = Object.keys(agentRoles)

export function roleOrDefault(role) {
  return agentRoles[role] ?? agentRoles.builder
}
