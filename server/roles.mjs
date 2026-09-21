/**
 * Agent roles. `readOnly` drives scheduling: read-only work may overlap, work
 * that can write is serialized, which matches the evidence that parallel writers
 * conflict while parallel readers do not. A role is a capability contract —
 * tools, prompt, budgets — and models are cast into roles, never the reverse:
 * two configured providers can cover every role below.
 */
export const agentRoles = {
  research: {
    agentId: 'research',
    name: 'Scout',
    label: 'Research worker',
    readOnly: true,
    tools: ['workspace.list', 'workspace.read', 'workspace.search', 'workspace.map', 'skills.find', 'task.query', 'http.request', 'run.ask'],
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
    tools: ['workspace.list', 'workspace.read', 'workspace.search', 'workspace.map', 'skills.find', 'task.query', 'workspace.write', 'shell.exec', 'run.ask'],
    instructions: 'Turn the direction and the research findings into a small proof-of-value. Read before you write, keep the change narrow, and state the checks that prove it works. Commands you run execute inside a sandboxed container with no network access, so build and test offline.',
  },
  architect: {
    agentId: 'architect',
    name: 'Architect',
    label: 'Design worker',
    readOnly: false,
    // Architects think on paper: they read everything and write markdown
    // (plans, specs, docs) and nothing else. The markdown-only boundary is
    // enforced by the permission matrix, not by the prompt — see
    // deny.architect-non-markdown — because a prompt is a suggestion and a
    // matrix row is a guarantee.
    tools: ['workspace.list', 'workspace.read', 'workspace.search', 'workspace.map', 'skills.find', 'task.query', 'workspace.write', 'run.ask'],
    instructions: 'Design before anyone builds: turn the direction into precise intents — file references, acceptance criteria, ordered steps. Write your thinking into markdown files (plans, specs, notes). You cannot write code and you cannot run commands; if the task needs either, say so in your summary instead of attempting it.',
  },
  editor: {
    agentId: 'editor',
    name: 'Editor',
    label: 'Narrow edit worker',
    readOnly: false,
    // The Aider split: intent arrives precise, so execution stays tiny. Three
    // steps and one write per turn — enough for read, edit, done, and never
    // enough to wander. No shell: builds and tests belong to Forge.
    maxSteps: 3,
    singleWritePerTurn: true,
    tools: ['workspace.list', 'workspace.read', 'workspace.search', 'workspace.map', 'skills.find', 'task.query', 'workspace.write', 'run.ask'],
    instructions: 'Make exactly the edit described, nothing around it. Read the file, write the change, summarize. One write per turn: if you need two edits, do the first, summarize, and let the next turn take the second.',
  },
  debug: {
    agentId: 'debug',
    name: 'Debugger',
    label: 'Fault-finding worker',
    readOnly: false,
    tools: ['workspace.list', 'workspace.read', 'workspace.search', 'workspace.map', 'skills.find', 'task.query', 'workspace.write', 'shell.exec', 'run.ask'],
    instructions: 'Work like a scientist, not a guesser: state one falsifiable hypothesis per step, then instrument (read the code), run (execute the failing case in the container), and revise. A hypothesis with no test is a guess — write it down as one. Your shell receipts are the evidence your verdicts will cite.',
  },
}

export function roleOrDefault(role) {
  return agentRoles[role] ?? agentRoles.builder
}
