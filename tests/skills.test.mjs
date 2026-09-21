import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { formatSkillsForPrompt, loadSkills, matchSkills, parseSkillFile, skillsDir } from '../server/skills.mjs'
import { withServer, withWorkspace } from './helpers.mjs'

test('a pack parses frontmatter leniently, and body survives without any', () => {
  const full = parseSkillFile('db', '---\nname: Database Moves\ndescription: Migrate safely.\ntriggers: migrate, migration, postgres\nroles: builder\n---\nExpand, then contract.\n')
  assert.equal(full.name, 'Database Moves')
  assert.equal(full.description, 'Migrate safely.')
  assert.deepEqual(full.triggers, ['migrate', 'migration', 'postgres'])
  assert.deepEqual(full.roles, ['builder'])
  assert.equal(full.content, 'Expand, then contract.')

  const bare = parseSkillFile('notes', 'Just some team notes.\n')
  assert.equal(bare.name, 'notes', 'the folder names the pack')
  assert.deepEqual(bare.triggers, [])
  assert.deepEqual(bare.roles, [], 'no roles means every role')
  assert.equal(bare.content, 'Just some team notes.\n', 'a body without frontmatter passes through untouched')

  const broken = parseSkillFile('oops', '---\nname: Unclosed\nbody without an ending fence')
  assert.equal(broken.name, 'oops', 'a broken fence falls back to the folder name')
})

test('packs load from the skills folder, and a missing folder loads nothing', async () => {
  await withWorkspace(async (directory) => {
    assert.deepEqual(await loadSkills(directory), [], 'no skills folder, no skills')
    await withSkillPack(directory, 'db-moves', '---\nname: Database Moves\ntriggers: migrate\n---\nExpand.\n')
    await withSkillPack(directory, 'empty', '')
    const loaded = await loadSkills(directory)
    assert.equal(loaded.length, 1, 'the empty pack is skipped, not fatal')
    assert.equal(loaded[0].name, 'Database Moves')
  })
})

test('the skills directory is configured, workspace-local, or off', () => {
  const previous = process.env.FULKRUM_SKILLS_DIR
  try {
    delete process.env.FULKRUM_SKILLS_DIR
    assert.equal(skillsDir('/ws'), path.join('/ws', 'skills'))
    process.env.FULKRUM_SKILLS_DIR = '/elsewhere/packs'
    assert.equal(skillsDir('/ws'), '/elsewhere/packs')
    process.env.FULKRUM_SKILLS_DIR = 'off'
    assert.equal(skillsDir('/ws'), null)
  } finally {
    if (previous === undefined) delete process.env.FULKRUM_SKILLS_DIR
    else process.env.FULKRUM_SKILLS_DIR = previous
  }
})

test('matching is by trigger hits within the allowed roles, best first, at most two', () => {
  const skills = [
    { name: 'db', triggers: ['migrate', 'postgres'], roles: [] },
    { name: 'builder-only', triggers: ['migrate'], roles: ['builder'] },
    { name: 'quiet', triggers: [], roles: [] },
    { name: 'third', triggers: ['migrate'], roles: [] },
    { name: 'fourth', triggers: ['migrate'], roles: [] },
  ]
  const matched = matchSkills(skills, { role: 'research', text: 'Migrate the postgres schema.' })
  assert.deepEqual(matched.map((skill) => skill.name), ['db', 'third'], 'best hits first, capped at two, role-gated')
  assert.ok(!matched.some((skill) => skill.name === 'quiet'), 'a pack with no triggers never injects on its own')
  assert.ok(!matched.some((skill) => skill.name === 'builder-only'), 'role restrictions hold')
})

test('injected skills are wrapped as reference, with the role winning conflicts', () => {
  assert.equal(formatSkillsForPrompt([]), '')
  const formatted = formatSkillsForPrompt([{ name: 'db', content: 'Expand, then contract.' }])
  assert.match(formatted, /<skill name="db">/)
  assert.match(formatted, /your role instructions win on conflict/)
})

async function withSkillPack(directory, folder, markdown) {
  await mkdir(path.join(directory, 'skills', folder), { recursive: true })
  await writeFile(path.join(directory, 'skills', folder, 'SKILL.md'), markdown, 'utf8')
}

test('a matching pack reaches the worker inside its assignment', async () => {
  const previousKey = process.env.XAI_API_KEY
  process.env.XAI_API_KEY = 'sk-test-key-for-skills'
  const planJson = JSON.stringify({
    objective: 'Migrate the database.',
    tasks: [{ role: 'research', title: 'Plan the migration', instructions: 'Report the steps.', dependsOn: [] }],
  })
  // The assignment is the first user message of each worker turn: capturing it
  // proves what the worker saw, which the persisted turns cannot (the initial
  // context is rebuilt, not stored, so resumes do not double it).
  const assignments = []
  const model = async ({ messages, options }) => {
    const instructions = String(options?.instructions ?? '')
    if (instructions.includes('You plan work')) return { text: planJson, toolCalls: [], usage: null }
    if (instructions.includes('verifying a worker task') || instructions.includes('reviewing worker outputs')) {
      return { text: '```verdict\n{"results": [{"criterion": "done", "status": "PASS", "evidence": []}]}\n```', toolCalls: [], usage: null }
    }
    if (instructions.includes('You are Scout')) assignments.push(messages[0]?.content ?? '')
    return { text: 'Migration mapped.', toolCalls: [], usage: null }
  }
  try {
    await withWorkspace(async (directory) => {
      await withSkillPack(directory, 'db-moves', '---\nname: Database Moves\ntriggers: migrate, migration\n---\nExpand, then contract.\n')
      await withSkillPack(directory, 'builders-only', '---\nname: Builders Only\ntriggers: migrate\nroles: builder\n---\nNot for scouts.\n')
      await withServer(async ({ request, store }) => {
        const project = await request('POST', '/api/projects', { name: 'skills fixture' })
        const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
        const runId = run.payload.run.id
        await request('POST', '/api/chat', { runId, message: 'Migrate the database.', history: [] })
        const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
        await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })

        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && !['review', 'failed'].includes(store.getRun(runId).status)) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(store.getRun(runId).status, 'review')
        assert.ok(assignments.length > 0, 'the worker was assigned')

        const assignment = assignments.join('\n')
        assert.match(assignment, /<skill name="Database Moves">/, 'the matching pack is in the assignment')
        assert.match(assignment, /Expand, then contract\./)
        assert.match(assignment, /your role instructions win on conflict/, 'packs arrive as reference, not orders')
        assert.equal(assignment.includes('Builders Only'), false, 'the role-gated pack stays out')
      }, { model, workspaceRoot: directory })
    })
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousKey
  }
})
