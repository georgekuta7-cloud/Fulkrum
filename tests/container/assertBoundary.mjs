import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { promisify } from 'node:util'
import { createExecutionRuntime } from '../../server/execution.mjs'

/**
 * The container is the security boundary, so its properties are asserted against
 * a real engine rather than read from the code that claims them. This runs in CI
 * (and locally with an engine available) — it is not part of `npm test`, which
 * must pass on a machine with no Docker.
 *
 *   docker build --tag fulkrum-runner:local server/runner
 *   node tests/container/assertBoundary.mjs
 */
const execFileAsync = promisify(execFile)
const checks = []
const check = async (name, run) => {
  await run()
  checks.push(name)
  console.log(`  ok  ${name}`)
}

const runtime = createExecutionRuntime({ workspaceRoot: process.cwd(), defaultTimeoutMs: 30_000 })
const status = await runtime.status()
if (!status.available) {
  console.error(`No container engine available: ${status.reason}`)
  console.error(status.hint)
  process.exit(1)
}
console.log(`Asserting the boundary against ${status.label} ${status.version}, image ${status.image}${status.imageDigest ? ` (${status.imageDigest})` : ''}\n`)

await check('runs as a non-root user that owns the workspace', async () => {
  const uid = (await runtime.run(['id', '-u'])).stdout.trim()
  assert.notEqual(uid, '0', 'the agent must not run as root')
  if (process.platform !== 'win32') {
    // A bind mount keeps the host's ownership, so any other uid cannot write —
    // which is what a hardcoded id got wrong on a CI checkout.
    assert.equal(Number(uid), statSync(process.cwd()).uid, 'the uid must own the mounted workspace, or writes fail')
  }
})

await check('the root filesystem is read-only', async () => {
  const result = await runtime.run(['sh', '-c', 'touch /root-file 2>&1 || echo refused'])
  assert.match(result.stdout, /refused/)
})

await check('the workspace is writable', async () => {
  const result = await runtime.run(['sh', '-c', 'touch .fulkrum-boundary-probe && echo wrote && rm .fulkrum-boundary-probe'])
  assert.match(result.stdout, /wrote/)
})

await check('HOME is writable and executable', async () => {
  // This is what npm, pip, and cargo need, and what a read-only root with a
  // noexec /tmp used to break.
  const result = await runtime.run(['sh', '-c', 'printf "#!/bin/sh\\necho ran\\n" > "$HOME/t" && chmod +x "$HOME/t" && "$HOME/t"'])
  assert.match(result.stdout, /ran/)
})

await check('/tmp cannot execute anything', async () => {
  // Each command gets a fresh container, so this writes its own script: the
  // requirement is that a file placed in /tmp cannot run, which makes the shell's
  // refusal the pass condition and a successful run the failure.
  const outcome = await runtime
    .run(['sh', '-c', 'printf "#!/bin/sh\\necho ran\\n" > /tmp/t && chmod +x /tmp/t && exec /tmp/t'])
    .then(() => 'the script ran')
    .catch((error) => error.message)
  assert.match(outcome, /Permission denied|not permitted|noexec/i, `expected the script not to run: ${outcome}`)
})

await check('there is no network', async () => {
  const result = await runtime.run(['sh', '-c', 'getent hosts example.com || echo no-dns'])
  assert.match(result.stdout, /no-dns/)
})

await check('repository hooks cannot fire', async () => {
  const result = await runtime.run(['git', 'config', '--get', 'core.hooksPath'])
  assert.equal(result.stdout.trim(), '/opt/fulkrum/empty-hooks')
  const fsmonitor = await runtime.run(['git', 'config', '--get', 'core.fsmonitor'])
  assert.equal(fsmonitor.stdout.trim(), 'false')
})

await check('a command that overruns its timeout is stopped', async () => {
  await assert.rejects(() => runtime.run(['sleep', '60'], { timeoutMs: 2_000 }), /exceeded 2000ms/)
})

await check('no container survives the timeout', async () => {
  const cli = process.env.FULKRUM_CONTAINER_CLI || 'docker'
  const { stdout } = await execFileAsync(cli, ['ps', '-a', '--filter', 'name=fulkrum-', '--format', '{{.Names}}'])
  assert.equal(stdout.trim(), '', `leftover containers: ${stdout.trim()}`)
})

console.log(`\n${checks.length} boundary checks passed.`)
