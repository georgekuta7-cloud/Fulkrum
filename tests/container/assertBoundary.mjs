import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
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

await check('runs as the configured non-root user', async () => {
  const result = await runtime.run(['id', '-u'])
  assert.equal(result.stdout.trim(), '1000')
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
  const result = await runtime.run(['sh', '-c', 'cp "$HOME/t" /tmp/t 2>/dev/null; chmod +x /tmp/t 2>/dev/null; (/tmp/t || echo noexec)'])
  assert.match(result.stdout, /noexec/)
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
