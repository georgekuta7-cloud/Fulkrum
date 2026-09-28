import { createHash } from 'node:crypto'
import { canonicalJson } from './canonicalJson.mjs'

export const planRoles = ['research', 'builder', 'architect', 'editor', 'debug']
export const maxPlanTasks = 8
export const CHECK_TYPES = ['command', 'file', 'human']

/**
 * Validate one acceptance check (P2.2). Typed checks are strict: an
 * unsupported type or a missing required field is a problem, never a guess.
 * A plain string is the legacy shape and normalizes to a human criterion.
 */
function normalizeCheck(task, index, problems) {
  const raw = task?.check
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`Task ${index + 1} has a check that is not an object.`)
      return null
    }
    const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
    if (!CHECK_TYPES.includes(type)) {
      problems.push(`Task ${index + 1} has an unsupported check type: ${type || '(missing)'}. Use command, file, or human.`)
      return null
    }
    if (type === 'command') {
      const command = typeof raw.command === 'string' ? raw.command.trim() : ''
      if (!command || command.length > 200) problems.push(`Task ${index + 1} needs a command of 1–200 characters.`)
      const args = Array.isArray(raw.args) ? raw.args.filter((entry) => typeof entry === 'string').slice(0, 50) : []
      if (args.some((entry) => entry.length > 500)) problems.push(`Task ${index + 1} has a command argument longer than 500 characters.`)
      const expectExit = raw.expectExit === undefined ? 0 : Number(raw.expectExit)
      if (!Number.isInteger(expectExit)) problems.push(`Task ${index + 1} has a non-integer expectExit.`)
      return { type, command, args, expectExit }
    }
    if (type === 'file') {
      const filePath = typeof raw.path === 'string' ? raw.path.trim().replaceAll('\\', '/') : ''
      if (!filePath || filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath) || filePath.split('/').includes('..')) {
        problems.push(`Task ${index + 1} needs a workspace-relative file path without "..".`)
      }
      const exists = raw.exists === undefined ? true : Boolean(raw.exists)
      const contains = typeof raw.contains === 'string' && raw.contains ? raw.contains.slice(0, 500) : null
      return { type, path: filePath, exists, contains }
    }
    const criterion = typeof raw.criterion === 'string' ? raw.criterion.trim() : ''
    if (!criterion) problems.push(`Task ${index + 1} needs a human-review criterion.`)
    // The derived label round-trips: a stored playbook re-validates to the
    // exact check it was saved with, or its hash would drift on instantiate.
    return { type: 'human', criterion: criterion.slice(0, 1000), ...(raw.derived === true ? { derived: true } : {}) }
  }
  const text = typeof task?.acceptanceCheck === 'string' ? task.acceptanceCheck.trim() : ''
  if (text) return { type: 'human', criterion: text.slice(0, 1000) }
  // No blank checks (P2.2). A task that states no check gets a human-review
  // criterion derived from its own instructions, explicitly labeled so the
  // approval surface can say "derived — review it"; nothing is invented
  // silently, and unsupported or malformed checks above are still refused.
  const instructions = typeof task?.instructions === 'string' ? task.instructions.trim() : ''
  if (!instructions) return null
  return { type: 'human', criterion: instructions.slice(0, 1000), derived: true }
}

/** The readable line a typed check shows as. */
export function checkText(check) {
  if (!check) return ''
  if (check.type === 'command') return `runs \`${[check.command, ...(check.args ?? [])].join(' ')}\` and expects exit ${check.expectExit ?? 0}`
  if (check.type === 'file') {
    const base = check.exists === false ? `${check.path} does not exist` : `${check.path} exists`
    return check.contains ? `${base} and contains "${check.contains}"` : base
  }
  return check.criterion ?? ''
}

export function validatePlan(candidate) {
  const problems = []
  if (!candidate || typeof candidate !== 'object') return { ok: false, problems: ['The plan must be an object.'] }

  const objective = typeof candidate.objective === 'string' ? candidate.objective.trim() : ''
  if (!objective) problems.push('The plan needs a non-empty objective.')

  const tasks = Array.isArray(candidate.tasks) ? candidate.tasks : []
  if (!tasks.length) problems.push('The plan needs at least one task.')
  if (tasks.length > maxPlanTasks) problems.push(`The plan can hold at most ${maxPlanTasks} tasks.`)

  const normalizedTasks = []
  tasks.forEach((task, index) => {
    const role = typeof task?.role === 'string' ? task.role.trim().toLowerCase() : ''
    const title = typeof task?.title === 'string' ? task.title.trim() : ''
    const instructions = typeof task?.instructions === 'string' ? task.instructions.trim() : ''
    if (!planRoles.includes(role)) problems.push(`Task ${index + 1} has an unknown role: ${role || '(missing)'}.`)
    if (!title) problems.push(`Task ${index + 1} needs a title.`)
    if (!instructions) problems.push(`Task ${index + 1} needs instructions.`)

    const dependsOn = Array.isArray(task?.dependsOn) ? task.dependsOn.map(Number).filter((value) => Number.isInteger(value)) : []
    for (const dependency of dependsOn) {
      if (dependency < 0 || dependency >= tasks.length) problems.push(`Task ${index + 1} depends on a task that does not exist: ${dependency}.`)
      if (dependency === index) problems.push(`Task ${index + 1} depends on itself.`)
      if (dependency > index) problems.push(`Task ${index + 1} depends on a later task (${dependency}); dependencies must point backwards.`)
    }

    const check = normalizeCheck(task, index, problems)
    normalizedTasks.push({
      role,
      title,
      instructions,
      check,
      acceptanceCheck: checkText(check) || (typeof task?.acceptanceCheck === 'string' ? task.acceptanceCheck.trim() : ''),
      dependsOn: [...new Set(dependsOn)].sort((a, b) => a - b),
    })
  })

  return { ok: problems.length === 0, problems, plan: { objective, tasks: normalizedTasks } }
}

/** The hash an approval is bound to. */
export function planContentHash(plan) {
  return createHash('sha256').update(canonicalJson({ objective: plan.objective, tasks: plan.tasks }), 'utf8').digest('hex')
}

const SCOPE_WORDS = ['all', 'entire', 'every', 'whole', 'migrate', 'refactor', 'rewrite', 'redesign', 'overhaul']
const scopeWordIn = (text) => SCOPE_WORDS.find((word) => new RegExp(`\\b${word}\\b`, 'i').test(text ?? '')) ?? null

/**
 * How much plan is in this plan, 1–10. A heuristic in the TaskMaster shape:
 * broad scope and deep chains score high, narrow work scores low. Advisory
 * only — it is rendered on the approval surface so the human can ask for a
 * sharper plan, and never gates anything: a score is information, not policy.
 */
export function scoreComplexity({ direction = '', plan }) {
  const factors = []
  let score = 3
  // Normalized for the layering, which expects validated plans; the scorer
  // must survive whatever it is handed, because it runs on draft output.
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks.map((task) => ({ ...task, dependsOn: Array.isArray(task?.dependsOn) ? task.dependsOn : [] })) : []

  if (tasks.length > 3) {
    score += Math.min(tasks.length - 3, 3)
    factors.push(`${tasks.length} tasks`)
  }
  const depth = Math.max(planLayers(tasks).length - 1, 0)
  if (depth >= 2) {
    score += 1
    factors.push(`dependency chain ${depth + 1} deep`)
  }
  if (tasks.some((task) => String(task?.instructions ?? '').length > 500)) {
    score += 1
    factors.push('long task instructions')
  }
  const scopeWord = scopeWordIn(plan?.objective) ?? scopeWordIn(direction)
  if (scopeWord) {
    score += 1
    factors.push(`broad scope: "${scopeWord}"`)
  }
  const roles = new Set(tasks.map((task) => task?.role).filter(Boolean))
  if (roles.size > 1 && tasks.some((task) => (task?.dependsOn ?? []).length > 0)) {
    score += 1
    factors.push('cross-role handoffs')
  }

  return { score: Math.min(Math.max(score, 1), 10), factors }
}

/** Group tasks into the order they can run: each layer depends only on earlier layers. */
export function planLayers(tasks) {
  const layers = []
  const placed = new Set()
  let remaining = tasks.map((task, index) => ({ task, index }))

  while (remaining.length) {
    const ready = remaining.filter(({ task }) => task.dependsOn.every((dependency) => placed.has(dependency)))
    if (!ready.length) {
      // A cycle would otherwise spin forever; keep the work rather than dropping it.
      layers.push(remaining.map(({ task }) => task))
      break
    }
    for (const { index } of ready) placed.add(index)
    layers.push(ready.map(({ task }) => task))
    // Remove exactly what was placed. Filtering by "dependencies satisfied" would
    // also drop tasks that became ready, silently skipping them.
    remaining = remaining.filter(({ index }) => !placed.has(index))
  }

  return layers
}

/** Split a layer so read-only work can overlap while writers stay serialized. */
export function splitLayerForConcurrency(tasks, roles) {
  const readers = tasks.filter((task) => roles[task.role]?.readOnly)
  const writers = tasks.filter((task) => !roles[task.role]?.readOnly)
  return { readers, writers }
}

/** Extract a JSON object from a model reply that may wrap it in prose or fences. */
export function extractPlanJson(text) {
  if (typeof text !== 'string') return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

export function planPrompt({ direction, workspaceRoot, maxTasks = maxPlanTasks, projectContext = '' }) {
  return `Turn this direction into a plan for a small agent team.

Direction:
${direction}
${projectContext ? `\nProject context (AGENTS.md — follow it):\n${projectContext}\n` : ``}
Produce at most ${maxTasks} tasks. Use the "research" role for read-only investigation and the "builder" role for work that produces artifacts. Keep the plan narrow: the first release should prove one outcome. Set dependsOn to the zero-based indices of tasks that must finish first.

Rules:
- research tasks must not depend on each other; they can run in parallel.
- builder tasks run one at a time, so give them explicit order through dependsOn.
- Every task needs a check, and it must be typed: a runnable command ({"type":"command","command":"npm","args":["test"],"expectExit":0}), a file assertion ({"type":"file","path":"out.txt"}), or a human-review criterion ({"type":"human","criterion":"how we know it worked"}). Prefer machine checks when the task produces a runnable result or a file; a human criterion is valid when no machine check exists.

The workspace root is ${workspaceRoot}.

Reply with JSON only, in exactly this shape:
{"objective": "one sentence", "tasks": [{"role": "research", "title": "short title", "instructions": "what to do", "check": {"type": "human", "criterion": "how we know it worked"}, "dependsOn": []}]}`
}
