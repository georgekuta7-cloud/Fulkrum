import { createHash } from 'node:crypto'
import { canonicalJson } from './canonicalJson.mjs'

export const planRoles = ['research', 'builder']
export const maxPlanTasks = 8

/**
 * The plan format the Head AI has to produce, and the same shape the demo
 * fallback builds. One schema, so the stored artifact is identical whether a
 * model or a template produced it.
 */
export const planSchema = {
  type: 'object',
  properties: {
    objective: { type: 'string', description: 'One sentence describing the outcome this plan delivers.' },
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: maxPlanTasks,
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: planRoles, description: 'research reads and reports; builder produces artifacts.' },
          title: { type: 'string' },
          instructions: { type: 'string', description: 'What this worker must do, in one or two sentences.' },
          acceptanceCheck: { type: 'string', description: 'How a reviewer can tell this task succeeded.' },
          dependsOn: { type: 'array', items: { type: 'integer' }, description: 'Zero-based indices of tasks that must finish first.' },
        },
        required: ['role', 'title', 'instructions'],
        additionalProperties: false,
      },
    },
  },
  required: ['objective', 'tasks'],
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

    normalizedTasks.push({
      role,
      title,
      instructions,
      acceptanceCheck: typeof task?.acceptanceCheck === 'string' ? task.acceptanceCheck.trim() : '',
      dependsOn: [...new Set(dependsOn)].sort((a, b) => a - b),
    })
  })

  return { ok: problems.length === 0, problems, plan: { objective, tasks: normalizedTasks } }
}

/** The hash an approval is bound to. */
export function planContentHash(plan) {
  return createHash('sha256').update(canonicalJson({ objective: plan.objective, tasks: plan.tasks }), 'utf8').digest('hex')
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

export function planPrompt({ direction, workspaceRoot, maxTasks = maxPlanTasks }) {
  return `Turn this direction into a plan for a small agent team.

Direction:
${direction}

Produce at most ${maxTasks} tasks. Use the "research" role for read-only investigation and the "builder" role for work that produces artifacts. Keep the plan narrow: the first release should prove one outcome. Set dependsOn to the zero-based indices of tasks that must finish first.

Rules:
- research tasks must not depend on each other; they can run in parallel.
- builder tasks run one at a time, so give them explicit order through dependsOn.
- Every task needs an acceptanceCheck that a reviewer could verify.

The workspace root is ${workspaceRoot}.

Reply with JSON only, in exactly this shape:
{"objective": "one sentence", "tasks": [{"role": "research", "title": "short title", "instructions": "what to do", "acceptanceCheck": "how we know it worked", "dependsOn": []}]}`
}
