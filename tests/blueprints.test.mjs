import assert from 'node:assert/strict'
import test from 'node:test'
import { applyBlueprint, listBlueprints, previewBlueprint, readBlueprint, validateBlueprint } from '../server/blueprints.mjs'
import { withServer, withStore, withWorkspace } from './helpers.mjs'

test('builtins ship, validate, and read back by name', () => {
  const names = listBlueprints().map((entry) => entry.name).sort()
  assert.deepEqual(names, ['Debug Hunt', 'Scout-Heavy', 'TDD Autopilot'])
  for (const entry of listBlueprints()) {
    assert.equal(entry.source, 'builtin')
  }
  const found = readBlueprint('TDD Autopilot')
  assert.ok(found, 'builtins read back by name')
  assert.equal(validateBlueprint(found.blueprint).ok, true, 'builtins are valid')
  assert.equal(readBlueprint('No Such Blueprint'), null)
})

test('validation refuses unknown roles, levels, modes, and grant shapes', () => {
  assert.equal(validateBlueprint(null).ok, false)
  assert.equal(validateBlueprint({ roles: { wizard: {} } }).ok, false)
  assert.equal(validateBlueprint({ roles: { builder: { reasoning: 'ludicrous' } } }).ok, false)
  assert.equal(validateBlueprint({ defaults: { permissionMode: 'yolo' } }).ok, false)
  assert.equal(validateBlueprint({ defaults: { budgetUsd: -5 } }).ok, false)
  assert.equal(validateBlueprint({ grants: [{ tool: 'workspace.write', scopeKind: 'path', scopeValue: '/abs' }] }).ok, false)
  // Shell refusal needs the broker (tool kinds live there), so it happens at
  // apply time, not validation: a shape check cannot know what a tool is.
  const good = validateBlueprint({
    name: 'Mine',
    roles: { builder: { route: 'Grok', reasoning: 'medium' } },
    defaults: { permissionMode: 'autopilot', budgetUsd: 5 },
    grants: [{ tool: 'workspace.write', scopeKind: 'path', scopeValue: 'docs' }],
  })
  assert.equal(good.ok, true, JSON.stringify(good))
})

test('preview diffs without writing, apply writes exactly the diff', async () => {
  await withStore(async (store) => {
    const project = store.createProject({ name: 'blueprint unit' })
    const candidate = {
      name: 'Unit',
      roles: { builder: { route: 'Grok', reasoning: 'medium' } },
      defaults: { permissionMode: 'autopilot', budgetUsd: 5 },
      grants: [{ tool: 'workspace.write', scopeKind: 'path', scopeValue: 'docs' }],
    }
    const { ok, blueprint } = validateBlueprint(candidate)
    assert.equal(ok, true)

    const before = previewBlueprint({ store, projectId: project.id, blueprint })
    assert.deepEqual(before.routing, [{ role: 'builder', from: null, to: 'Grok' }])
    assert.deepEqual(before.reasoning, [{ role: 'builder', from: null, to: 'medium' }])
    assert.deepEqual(before.defaults.map((entry) => entry.key).sort(), ['budgetUsd', 'permissionMode'])
    assert.equal(before.grants.length, 1)

    const toolBroker = { get: (name) => (name === 'workspace.write' ? { kind: 'write' } : null) }
    const applied = applyBlueprint({ store, toolBroker, projectId: project.id, blueprint })
    assert.deepEqual(applied.routing, ['builder'])
    const settings = store.getProject(project.id).project.settings
    assert.deepEqual(settings.routing, { builder: 'Grok' })
    assert.deepEqual(settings.reasoning, { builder: 'medium' })
    assert.deepEqual(settings.defaults, { permissionMode: 'autopilot', budgetUsd: 5 })
    assert.equal(store.listStandingGrants().length, 1)

    const after = previewBlueprint({ store, projectId: project.id, blueprint })
    assert.deepEqual(after.routing, [])
    assert.deepEqual(after.reasoning, [])
    assert.deepEqual(after.defaults, [])
    assert.deepEqual(after.grants, [], 'the existing grant is not proposed again')

    const shellShaped = validateBlueprint({ name: 'Shell', grants: [{ tool: 'shell.exec', scopeKind: 'path', scopeValue: 'docs' }] })
    assert.equal(shellShaped.ok, true, 'shape validation cannot know what a tool is')
    const shellBroker = { get: (name) => (name === 'shell.exec' ? { kind: 'shell' } : null) }
    assert.throws(() => applyBlueprint({ store, toolBroker: shellBroker, projectId: project.id, blueprint: shellShaped.blueprint }), /no scope/)
  })
})

test('blueprints apply over HTTP, and new runs honor their defaults', async () => {
  await withWorkspace(async (directory) => {
    await withServer(async ({ request, store }) => {
      const listed = await request('GET', '/api/blueprints')
      assert.ok(listed.payload.blueprints.some((entry) => entry.name === 'TDD Autopilot'))

      const project = await request('POST', '/api/projects', { name: 'blueprint http' })
      const projectId = project.payload.project.id

      assert.equal((await request('POST', `/api/projects/${projectId}/blueprints/preview`, { name: 'Nope' })).status, 404)
      assert.equal((await request('POST', `/api/projects/${projectId}/blueprints/preview`, { blueprint: { roles: { wizard: {} } } })).status, 400)

      const preview = await request('POST', `/api/projects/${projectId}/blueprints/preview`, { name: 'TDD Autopilot' })
      assert.equal(preview.status, 200, JSON.stringify(preview.payload))
      assert.ok(preview.payload.diff.reasoning.length > 0)
      assert.ok(preview.payload.diff.defaults.length > 0)

      const applied = await request('POST', `/api/projects/${projectId}/blueprints/apply`, { name: 'TDD Autopilot' })
      assert.equal(applied.status, 200, JSON.stringify(applied.payload))
      const settings = store.getProject(projectId).project.settings
      assert.equal(settings.reasoning.builder, 'medium')
      assert.equal(settings.defaults.permissionMode, 'autopilot')
      assert.equal(settings.defaults.budgetUsd, 5)

      // Defaults apply where the caller said nothing...
      const run = await request('POST', '/api/runs', { projectId })
      assert.equal(run.payload.run.permissionMode, 'autopilot')
      assert.equal(run.payload.run.budgetUsd, 5)
      // ...and explicit choices still win.
      const explicit = await request('POST', '/api/runs', { projectId, permissionMode: 'selective' })
      assert.equal(explicit.payload.run.permissionMode, 'selective')

      const other = await request('POST', '/api/projects', { name: 'other' })
      assert.equal((await request('POST', `/api/projects/${other.payload.project.id}/blueprints/apply`, { name: 'TDD Autopilot' })).status, 200)
      assert.equal((await request('POST', '/api/projects/project-nope/blueprints/apply', { name: 'TDD Autopilot' })).status, 404)
    }, { workspaceRoot: directory })
  })
})
