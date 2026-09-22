/**
 * Dynamic tool access: phase-aware tool exposure.
 *
 * Not all tools for all phases. A planning turn needs read + map; an editing
 * turn needs read + write; a verification turn needs read only. Restricting
 * the tool surface per phase reduces context noise and security surface.
 */

/** Phases a task moves through. */
export const phases = ['planning', 'editing', 'verifying', 'reviewing']

/**
 * Tool allowlist per phase. Tools not in the list are hidden from the model.
 */
const phaseTools = {
  planning: ['workspace.list', 'workspace.read', 'workspace.search', 'workspace.map', 'skills.find', 'task.query'],
  editing: ['workspace.list', 'workspace.read', 'workspace.search', 'workspace.write', 'shell.exec', 'skills.find', 'task.query', 'run.ask', 'http.request'],
  verifying: ['workspace.list', 'workspace.read', 'workspace.search', 'workspace.map', 'skills.find', 'task.query'],
  reviewing: ['workspace.list', 'workspace.read', 'workspace.search', 'workspace.map', 'skills.find', 'task.query', 'run.ask'],
}

/**
 * Detect the current phase from the task's role and step count.
 *
 * @param {{ role: string, stepCount: number, maxSteps: number, hasOpenQuestion?: boolean }} input
 * @returns {string} one of phases
 */
export function detectPhase({ role, stepCount = 0, maxSteps = 8, hasOpenQuestion = false }) {
  if (hasOpenQuestion) return 'reviewing'
  if (role === 'architect' || role === 'head') return 'planning'
  if (role === 'research') return 'verifying'
  // A builder/editor/debug starts in editing, shifts to verifying near the end.
  const remaining = maxSteps - stepCount
  if (remaining <= 1) return 'verifying'
  return 'editing'
}

/**
 * Filter a tool list to only those available in the given phase.
 *
 * @param {Array<{ name: string }>} tools
 * @param {string} phase
 * @returns {Array<{ name: string }>}
 */
export function toolsForPhase(tools, phase) {
  const allowed = new Set(phaseTools[phase] ?? phaseTools.editing)
  return tools.filter((tool) => allowed.has(tool.name))
}

/**
 * Describe the dynamic tool surface for a turn, so the orchestrator can log
 * what was exposed and the model knows what it can call.
 *
 * @param {{ role: string, stepCount: number, maxSteps: number, hasOpenQuestion?: boolean, allTools: Array<{ name: string }> }} input
 * @returns {{ phase: string, tools: Array<{ name: string }>, hidden: string[] }}
 */
export function dynamicToolSurface({ role, stepCount, maxSteps, hasOpenQuestion = false, allTools }) {
  const phase = detectPhase({ role, stepCount, maxSteps, hasOpenQuestion })
  const tools = toolsForPhase(allTools, phase)
  const exposed = new Set(tools.map((t) => t.name))
  const hidden = allTools.filter((t) => !exposed.has(t.name)).map((t) => t.name)
  return { phase, tools, hidden }
}
