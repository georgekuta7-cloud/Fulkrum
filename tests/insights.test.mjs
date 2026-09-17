import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { crc32, createZip } from '../server/zip.mjs'
import { buildTaskHandoffDigest, extractFencedBlock, extractStructuredCompletion, summarizeVerdict, validateDecisionBlock, validateStructuredCompletion, validateVerdictBlock } from '../server/artifacts.mjs'
import { withServer, withTempDirectory } from './helpers.mjs'

test('a zip is readable by an unzip tool, not just by this code', async () => {
  const zip = createZip([
    { name: 'a.txt', data: 'hello\n' },
    { name: 'nested/b.txt', data: 'x'.repeat(5000) },
    { name: 'empty.txt', data: '' },
  ])
  assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304', 'a local file header starts the archive')
  assert.equal(zip.subarray(-22, -18).toString('hex'), '504b0506', 'and an end-of-central-directory record ends it')

  // The CRC of a known string, per the format's own definition.
  assert.equal(crc32(Buffer.from('hello\n', 'utf8')), 0x363a3020)

  // PowerShell can read it on Windows; Info-ZIP or Python elsewhere. A tool that
  // does not exist here is skipped rather than failing the suite.
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const directory = await mkdtemp(path.join(tmpdir(), 'fulkrum-zip-'))
  try {
    const archive = path.join(directory, 'test.zip')
    await writeFile(archive, zip)
    const attempt = process.platform === 'win32'
      ? promisify(execFile)('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${path.join(directory, 'out')}' -Force`])
      : promisify(execFile)('unzip', ['-o', archive, '-d', path.join(directory, 'out')])
    try {
      await attempt
      assert.equal(await readFile(path.join(directory, 'out', 'a.txt'), 'utf8'), 'hello\n')
      assert.equal((await readFile(path.join(directory, 'out', 'nested', 'b.txt'), 'utf8')).length, 5000, 'the compressed entry round-trips')
      assert.equal(await readFile(path.join(directory, 'out', 'empty.txt'), 'utf8'), '')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a plan can be edited, and the edit invalidates the old approval', async () => {
  await withTempDirectory(async (directory) => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'edit fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      const drafted = await request('POST', `/api/runs/${runId}/plan`, {})
      assert.equal(drafted.status, 200)

      const edited = await request('PATCH', `/api/runs/${runId}/plan`, {
        objective: 'A sharper objective.',
        tasks: [
          { role: 'research', title: 'Look', instructions: 'Look properly.', dependsOn: [] },
          { role: 'builder', title: 'Write', instructions: 'Write it down.', dependsOn: [0] },
        ],
      })
      assert.equal(edited.status, 200, JSON.stringify(edited.payload))
      assert.equal(edited.payload.plan.objective, 'A sharper objective.')
      assert.equal(edited.payload.plan.version, drafted.payload.plan.version + 1, 'an edit is a new version')
      assert.notEqual(edited.payload.plan.contentHash, drafted.payload.plan.contentHash, 'and a new hash')
      assert.equal(edited.payload.replacedVersion, drafted.payload.plan.version)

      // The old hash no longer approves anything.
      const stale = await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: drafted.payload.plan.id, planHash: drafted.payload.plan.contentHash, routing: {} })
      assert.equal(stale.status, 409)

      const approved = await request('POST', `/api/runs/${runId}/control`, { action: 'approve-plan', planId: edited.payload.plan.id, planHash: edited.payload.plan.contentHash, routing: {} })
      assert.equal(approved.status, 200, JSON.stringify(approved.payload))

      // An edit while the plan is in use is refused rather than racing the workers.
      const during = await request('PATCH', `/api/runs/${runId}/plan`, { tasks: [{ role: 'research', title: 'Later', instructions: 'x', dependsOn: [] }] })
      assert.equal(during.status === 409 || during.status === 200, true, 'a plan being executed either refuses the edit or is not in that state yet')
      if (during.status === 409) assert.match(String(during.payload.error), /cannot be edited/)

      // Validation is the same as the model's own output gets.
      const invalid = await request('PATCH', `/api/runs/${runId}/plan`, { tasks: [{ role: 'wizard', title: '', instructions: '', dependsOn: [5] }] })
      assert.equal(invalid.status === 409 || invalid.status === 400, true)
      assert.equal(store.listEvents(runId).some((event) => event.type === 'plan.edited'), true, 'the edit is in the audit log')
      assert.equal(store.verifyEventChain(runId).ok, true)
    }, { workspaceRoot: directory })
  })
})

test('cost is reported per task, over time, and estimated before a run', async () => {
  await withTempDirectory(async (directory) => {
    await withServer(async ({ request, store }) => {
      const project = await request('POST', '/api/projects', { name: 'cost fixture' })
      const projectId = project.payload.project.id
      const run = await request('POST', '/api/runs', { projectId, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      const task = store.createTask({ runId, agentId: 'research', title: 'Look around', instructions: 'Report.' })

      store.recordModelCall({ runId, taskId: task.id, role: 'research', provider: 'grok', model: 'grok-4', usage: { inputTokens: 100, outputTokens: 50 }, cost: { costUsd: 0.02, priced: true, version: 'test' } })
      store.recordModelCall({ runId, role: 'head', provider: 'grok', model: 'grok-4', usage: { inputTokens: 10, outputTokens: 5 }, cost: { costUsd: 0.01, priced: true, version: 'test' } })

      const trace = await request('GET', `/api/runs/${runId}/trace`)
      const byTask = trace.payload.byTask
      const worker = byTask.find((entry) => entry.taskId === task.id)
      assert.equal(worker.costUsd, 0.02)
      assert.equal(worker.title, 'Look around')
      assert.equal(worker.calls, 1)
      const supervisor = byTask.find((entry) => entry.taskId === null)
      assert.equal(supervisor.title, 'supervisor', 'the supervisor’s own calls are labelled, not attributed to a worker')
      assert.equal(supervisor.costUsd, 0.01)

      const usage = await request('GET', '/api/usage?days=7')
      assert.equal(usage.status, 200)
      assert.equal(usage.payload.totals.costUsd, 0.03)
      assert.equal(usage.payload.byModel.some((entry) => entry.key === 'grok-4' && entry.costUsd === 0.03), true)
      assert.equal(usage.payload.byRole.some((entry) => entry.key === 'research'), true)
      assert.equal(usage.payload.byDay.length >= 1, true)

      const scoped = await request('GET', `/api/usage?projectId=${encodeURIComponent('project-nope')}`)
      assert.equal(scoped.payload.totals.costUsd, 0, 'a project filter applies')

      const estimate = await request('GET', `/api/runs/${runId}/estimate`)
      assert.equal(estimate.status, 200)
      assert.equal(estimate.payload.basis.startsWith('from 2 priced call(s)'), true, `the basis is stated: ${estimate.payload.basis}`)
      assert.equal(estimate.payload.perCall.low <= estimate.payload.perCall.high, true)
      assert.equal(estimate.payload.estimateUsd.low <= estimate.payload.estimateUsd.high, true)
      assert.equal(estimate.payload.expectedCalls > 0, true)
    }, { workspaceRoot: directory })
  })
})

test('an estimate with no history says so instead of guessing', async () => {
  await withServer(async ({ request }) => {
    const project = await request('POST', '/api/projects', { name: 'cold start' })
    const run = await request('POST', '/api/runs', { projectId: project.payload.project.id })
    const estimate = await request('GET', `/api/runs/${run.payload.run.id}/estimate`)
    assert.equal(estimate.payload.estimateUsd, null)
    assert.match(estimate.payload.basis, /no priced calls/)
  })
})

test('a pending write carries its diff, its rule, and any credential warning', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, 'config.json'), '{\n  "port": 1\n}\n', 'utf8')
    await withServer(async ({ request }) => {
      const project = await request('POST', '/api/projects', { name: 'preview fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'selective' })
      const runId = run.payload.run.id

      const pending = await request('POST', `/api/runs/${runId}/tools`, {
        name: 'workspace.write',
        agentId: 'builder',
        input: { path: 'config.json', content: '{\n  "port": 2,\n  "api_key": "sk-abcdefghijklmnopqrstuvwxyz"\n}\n' },
      })
      assert.equal(pending.status, 409, JSON.stringify(pending.payload))
      assert.equal(pending.payload.rule, 'ask.default', 'the rule that stopped it is on the call')
      assert.equal(pending.payload.toolCall.ruleId, 'ask.default')

      const preview = pending.payload.preview
      assert.equal(preview.path, 'config.json')
      assert.equal(preview.created, false)
      assert.equal(preview.added >= 2, true, 'the diff shows what would be added')
      assert.equal(preview.removed >= 1, true)
      assert.equal(preview.hunks.length >= 1, true)

      // The arguments contain something that looks like a key, and that is said out
      // loud rather than silently accepted.
      assert.equal(pending.payload.warnings.length >= 1, true)
      assert.equal(pending.payload.warnings[0].field, 'content')
      assert.equal(pending.payload.warnings[0].kinds.includes('openai-key'), true)

      // The same preview is available on its own, for a client that reloaded.
      const reloaded = await request('GET', `/api/runs/${runId}/tools/${pending.payload.toolCall.id}/preview`)
      assert.equal(reloaded.status, 200)
      assert.equal(reloaded.payload.preview.added, preview.added)
      assert.equal(reloaded.payload.warnings.length, pending.payload.warnings.length)

      // A creation previews as a creation.
      const created = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'brand-new.md', content: '# hello\n' } })
      assert.equal(created.payload.preview.created, true)
      assert.equal(created.payload.preview.previousBytes, null)

      // And a read has no preview, because there is nothing to preview.
      const read = await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.read', agentId: 'research', input: { path: 'config.json' } })
      assert.equal(read.status, 200)
      assert.equal(read.payload.preview, undefined)
    }, { workspaceRoot: directory })
  })
})

test('a run bundle holds the report, the events, the artifacts and the files', async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, 'bundle.txt'), 'before the run\n', 'utf8')
    await withServer(async ({ request, baseUrl }) => {
      const project = await request('POST', '/api/projects', { name: 'bundle fixture' })
      const run = await request('POST', '/api/runs', { projectId: project.payload.project.id, permissionMode: 'autopilot' })
      const runId = run.payload.run.id
      await request('POST', `/api/runs/${runId}/tools`, { name: 'workspace.write', agentId: 'builder', input: { path: 'bundle.txt', content: 'after the run\n' } })

      const response = await fetch(`${baseUrl}/api/runs/${runId}/bundle`)
      assert.equal(response.status, 200)
      assert.match(String(response.headers.get('content-type')), /application\/zip/)
      assert.match(String(response.headers.get('content-disposition')), /attachment; filename="fulkrum-.*\.zip"/)

      const archive = Buffer.from(await response.arrayBuffer())
      assert.equal(archive.subarray(0, 4).toString('hex'), '504b0304', 'it is a zip')

      // Entry names live uncompressed in the headers, so the archive can be
      // checked without unpacking it here.
      const listing = archive.toString('latin1')
      for (const entry of [`${runId}/report.md`, `${runId}/report.json`, `${runId}/events.json`, `${runId}/artifacts.json`, `${runId}/files/after/bundle.txt`, `${runId}/files/before/bundle.txt`]) {
        assert.equal(listing.includes(entry), true, `${entry} should be in the bundle`)
      }
      assert.equal(listing.includes('before the run'), true, 'the replaced bytes travel with it')
      assert.equal(listing.includes('after the run'), true, 'and so do the new ones')

      assert.equal((await request('GET', '/api/runs/run-nope/bundle')).status, 404)
    }, { workspaceRoot: directory })
  })
})

test('evidence blocks are found, validated, and rejected with reasons', () => {
  assert.deepEqual(extractStructuredCompletion('plain prose, no block'), { found: false })

  const block = 'Summary text.\n```evidence\n{"summary": "Did the thing.", "findings": [{"claim": "The config exists.", "path": "config.json", "startLine": 2}]}\n```'
  const extracted = extractStructuredCompletion(block)
  assert.equal(extracted.found, true)
  const validated = validateStructuredCompletion(extracted.value)
  assert.equal(validated.ok, true, JSON.stringify(validated.problems))
  assert.equal(validated.completion.summary, 'Did the thing.')
  assert.deepEqual(validated.completion.findings[0], { kind: 'finding', summary: 'The config exists.', path: 'config.json', startLine: 2, endLine: null, sha256: null })

  const broken = extractStructuredCompletion('```evidence\n{not json}\n```')
  assert.equal(broken.found, true)
  assert.equal(broken.invalidJson, true)

  const missing = validateStructuredCompletion({ findings: [] })
  assert.equal(missing.ok, false)
  assert.match(missing.problems.join(' '), /summary/)

  const badArtifact = validateStructuredCompletion({ summary: 'x', artifacts: [{ sha256: 'abc' }] })
  assert.equal(badArtifact.ok, false)
  assert.match(badArtifact.problems.join(' '), /artifacts\[0\]\.path/)
})

test('a handoff digest carries pointers, not transcripts, and stays bounded', () => {
  const digest = buildTaskHandoffDigest({
    summary: 'A very long summary. '.repeat(500),
    evidence: [{ id: 'ev-0123456789abcdef', kind: 'finding', summary: 'The config sets port 2.', path: 'config.json', startLine: 2, endLine: null, sha256: null }],
    artifacts: [{ path: 'proof.txt', bytes: 14, created: true, diff: { truncated: false, added: 1, removed: 0 } }],
    maxChars: 600,
  })
  assert.equal(digest.length <= 600 + 100, true, `digest must stay bounded (was ${digest.length})`)
  assert.match(digest, /\(#ev-01234567/, 'evidence travels by id')
  assert.match(digest, /proof\.txt/, 'artifacts travel as pointers')

  const clipped = buildTaskHandoffDigest({
    summary: 'A very long summary. '.repeat(500),
    evidence: [{ id: 'ev-0123456789abcdef', kind: 'finding', summary: 'The config sets port 2.', path: 'config.json', startLine: 2, endLine: null, sha256: null }],
    artifacts: [],
    maxChars: 120,
  })
  assert.match(clipped, /digest clipped/, 'truncation says so instead of silently dropping')
})

test('verdict blocks name one result per criterion, and the overall follows them', () => {
  const extracted = extractFencedBlock('Some prose.\n```verdict\n{"results": [{"criterion": "proof.txt exists.", "status": "PASS", "evidence": ["ev-1"]}]}\n```', 'verdict')
  assert.equal(extracted.found, true)
  const validated = validateVerdictBlock(extracted.value)
  assert.equal(validated.ok, true, JSON.stringify(validated.problems))
  assert.equal(summarizeVerdict(validated.verdict.results), 'PASS')

  assert.equal(validateVerdictBlock({}).ok, false, 'results are required')
  assert.equal(validateVerdictBlock({ results: [] }).ok, false, 'an empty verdict judges nothing')
  assert.equal(validateVerdictBlock({ results: [{ criterion: 'x', status: 'MAYBE' }] }).ok, false, 'statuses are closed')

  assert.equal(summarizeVerdict([{ status: 'PASS' }, { status: 'FAIL' }]), 'FAIL', 'one failure fails')
  assert.equal(summarizeVerdict([{ status: 'PASS' }, { status: 'UNKNOWN' }]), 'UNKNOWN', 'one unknown clouds')
  assert.equal(summarizeVerdict([]), 'UNKNOWN', 'nothing checked is not a pass')
})

test('checkpoint decisions are closed, and proceed is refused while work failed', () => {
  assert.deepEqual(validateDecisionBlock({ decision: 'repair', reason: 'fixable' }, { failures: 1 }).decision?.decision, 'repair')
  assert.deepEqual(validateDecisionBlock({ decision: 'stop', reason: 'hopeless' }, { failures: 2 }).decision?.decision, 'stop')
  assert.equal(validateDecisionBlock({ decision: 'proceed', reason: 'fine' }, { failures: 1 }).ok, false, 'proceed cannot wave through failure')
  assert.equal(validateDecisionBlock({ decision: 'proceed' }, { failures: 0 }).ok, true, 'proceed is honest when nothing failed')
  assert.equal(validateDecisionBlock({ decision: 'nap' }, { failures: 0 }).ok, false, 'decisions are closed')
  assert.equal(validateDecisionBlock(null).ok, false)
})
