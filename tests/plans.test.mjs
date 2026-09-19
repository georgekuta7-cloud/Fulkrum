import assert from 'node:assert/strict'
import test from 'node:test'
import { extractPlanJson, planContentHash, planLayers, splitLayerForConcurrency, validatePlan } from '../server/plans.mjs'
import { compactTaskMessages } from '../server/orchestrator.mjs'
import { agentRoles } from '../server/roles.mjs'

const validPlan = {
  objective: 'Prove the onboarding flow works.',
  tasks: [
    { role: 'research', title: 'Map the flow', instructions: 'Read the onboarding code.' },
    { role: 'builder', title: 'Patch the flow', instructions: 'Fix the gap.', acceptanceCheck: 'The flow completes.', dependsOn: [0] },
  ],
}

test('a well-formed plan is accepted and normalized', () => {
  const result = validatePlan(validPlan)
  assert.equal(result.ok, true)
  assert.equal(result.plan.tasks.length, 2)
  assert.deepEqual(result.plan.tasks[1].dependsOn, [0])
  assert.equal(result.plan.tasks[0].acceptanceCheck, '')
})

test('malformed plans are rejected with reasons', () => {
  assert.equal(validatePlan(null).ok, false)
  assert.equal(validatePlan({ objective: '', tasks: [] }).ok, false)

  const badRole = validatePlan({ objective: 'x', tasks: [{ role: 'wizard', title: 't', instructions: 'i' }] })
  assert.equal(badRole.ok, false)
  assert.match(badRole.problems.join(' '), /unknown role/)

  const forwardDependency = validatePlan({ objective: 'x', tasks: [
    { role: 'research', title: 'a', instructions: 'i', dependsOn: [1] },
    { role: 'builder', title: 'b', instructions: 'i' },
  ] })
  assert.equal(forwardDependency.ok, false)
  assert.match(forwardDependency.problems.join(' '), /later task/)

  const selfDependency = validatePlan({ objective: 'x', tasks: [{ role: 'research', title: 'a', instructions: 'i', dependsOn: [0] }] })
  assert.equal(selfDependency.ok, false)

  const missingTitle = validatePlan({ objective: 'x', tasks: [{ role: 'research', title: '', instructions: 'i' }] })
  assert.equal(missingTitle.ok, false)
  assert.match(missingTitle.problems.join(' '), /needs a title/)
})

test('the plan hash changes when any task changes', () => {
  const base = validatePlan(validPlan).plan
  const hash = planContentHash(base)
  assert.equal(hash, planContentHash(validatePlan(validPlan).plan), 'the same plan must hash the same')

  const edited = validatePlan({ ...validPlan, tasks: [{ ...validPlan.tasks[0], instructions: 'Read something else.' }, validPlan.tasks[1]] }).plan
  assert.notEqual(planContentHash(edited), hash)

  const reordered = validatePlan({ ...validPlan, tasks: [validPlan.tasks[1], { ...validPlan.tasks[0] }] }).plan
  assert.notEqual(planContentHash(reordered), hash)
})

test('tasks are grouped into dependency layers', () => {
  const tasks = [
    { role: 'research', title: 'a', dependsOn: [] },
    { role: 'research', title: 'b', dependsOn: [] },
    { role: 'builder', title: 'c', dependsOn: [0, 1] },
    { role: 'builder', title: 'd', dependsOn: [2] },
  ]
  const layers = planLayers(tasks)
  assert.equal(layers.length, 3)
  assert.deepEqual(layers[0].map((task) => task.title), ['a', 'b'])
  assert.deepEqual(layers[1].map((task) => task.title), ['c'])
  assert.deepEqual(layers[2].map((task) => task.title), ['d'])
})

test('a layer splits into parallel readers and serialized writers', () => {
  const layer = [
    { role: 'research', title: 'read one' },
    { role: 'research', title: 'read two' },
    { role: 'builder', title: 'write' },
  ]
  const { readers, writers } = splitLayerForConcurrency(layer, agentRoles)
  assert.equal(readers.length, 2)
  assert.equal(writers.length, 1)
})

test('plan JSON is extracted from prose and fences', () => {
  assert.deepEqual(extractPlanJson('{"objective":"x","tasks":[]}'), { objective: 'x', tasks: [] })
  assert.deepEqual(extractPlanJson('Here you go:\n```json\n{"objective":"x","tasks":[]}\n```\nDone.'), { objective: 'x', tasks: [] })
  assert.equal(extractPlanJson('no json here'), null)
  assert.equal(extractPlanJson('{"broken": '), null)
  assert.equal(extractPlanJson(null), null)
})

test('old tool results compact into citations past the token budget', () => {
  const messages = [
    { role: 'user', content: 'Your task: do it' },
    { role: 'assistant', content: 'reading', toolCalls: [] },
    { role: 'tool', results: [{ id: 'a', name: 'workspace.read', content: 'x'.repeat(4000) }] },
  ]
  const { compacted } = compactTaskMessages(messages, 100)
  assert.equal(compacted, 1)
  assert.match(messages[2].results[0].content, /^\[compacted: \d+ bytes omitted, sha256 [0-9a-f]{16}/)
  assert.equal(messages[0].content, 'Your task: do it', 'the assignment is never compacted')

  const quiet = compactTaskMessages([{ role: 'user', content: 'hi' }], 100)
  assert.equal(quiet.compacted, 0, 'small contexts pass through untouched')
})
