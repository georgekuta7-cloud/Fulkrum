import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { withServer } from '../tests/helpers.mjs'

/**
 * Capture the current interface as PNG references, so a design pass has a
 * real "before" to compare against — not memory or guesswork.
 *
 * Boots the real API bridge with the built UI, a temporary store and
 * workspace, and only model calls stubbed; drives one realistic session
 * (chat reply, drafted plan, a parked write approval); screenshots the
 * chat in both themes, the control room, settings, and run history.
 *
 * Usage:
 *   npm run build
 *   node scripts/design-screenshots.mjs
 * Output: design-preview/current/*.png
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'design-preview', 'current')

// Ambient developer credentials must not shape the screenshots.
for (const key of Object.keys(process.env)) {
  if (/^(FULKRUM_|XAI_|OPENAI_|ANTHROPIC_|GOOGLE_|DEEPSEEK_|GLM_|ZAI_|KIMI_|MOONSHOT_)/.test(key)) delete process.env[key]
}

const chatReply = [
  '# Session report', '',
  'The fixture workspace contains **3 modules** with one unverified import.',
  '',
  '- `server/app.mjs` — the HTTP surface',
  '- `server/store.mjs` — persistence',
  '- `src/App.tsx` — the shell',
  '',
  '```ts',
  'const plan: Plan = await draft({ objective });',
  '```',
  '',
  'Review the execution plan before approving the run.',
].join('\n')

const planJson = JSON.stringify({
  objective: 'Audit the workspace and prove the findings',
  tasks: [
    { role: 'research', title: 'Inspect the modules', instructions: 'Read the three modules and report their structure.', acceptanceCheck: 'Each module is summarized with its exports.', dependsOn: [] },
    { role: 'builder', title: 'Write regression coverage', instructions: 'Add tests for the unverified import path.', acceptanceCheck: 'The new tests fail before the fix and pass after.', dependsOn: [0] },
  ],
})

const model = async ({ options }) => ({
  text: String(options?.instructions ?? '').includes('You plan work') ? planJson : 'Inspection complete.',
  toolCalls: [],
  usage: null,
})

const shot = (page, name, fullPage = false) => page.screenshot({ path: path.join(outDir, name), fullPage })

await withServer(async ({ request, baseUrl }) => {
  await mkdir(outDir, { recursive: true })

  const provider = (await request('POST', '/api/providers', { label: 'Fixture provider', baseUrl: 'https://example.invalid/v1', model: 'fixture-model', apiKey: 'fixture-key' })).payload.provider
  const routing = { head: provider.label, research: provider.label, builder: provider.label }
  const project = (await request('POST', '/api/projects', { name: 'Fixture workspace', settings: { routing } })).payload.project
  const run = (await request('POST', '/api/runs', { projectId: project.id })).payload.run
  await request('POST', '/api/chat', { projectId: project.id, runId: run.id, routing, message: 'Audit this workspace and prepare an execution plan.', history: [] })
  await request('POST', `/api/runs/${run.id}/plan`, {})
  const parked = await request('POST', `/api/runs/${run.id}/tools`, {
    name: 'workspace.write', agentId: 'builder',
    input: { path: 'notes/audit.md', content: '# Audit\n\n- [x] read modules\n- [ ] verify imports\n' },
  })
  if (parked.status !== 409) throw new Error(`expected the write to park, got ${parked.status}`)

  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${baseUrl}/`)
  await page.getByLabel('Direct the Head AI').waitFor()
  await page.getByText('Inspect the modules').waitFor()
  await page.getByRole('alert', { name: 'Approval required' }).waitFor()
  await page.locator('pre code').first().waitFor()
  await page.waitForTimeout(400)

  await shot(page, '01-chat-dark.png', true)
  await page.getByRole('button', { name: 'Switch to light theme' }).click()
  await page.waitForTimeout(300)
  await shot(page, '02-chat-light.png', true)
  await page.getByRole('button', { name: 'Switch to dark theme' }).click()

  await page.getByRole('button', { name: 'Control Room' }).click()
  await page.getByRole('group', { name: 'Run dispatch map' }).waitFor()
  await shot(page, '03-control-room.png')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('region', { name: 'Register custom provider' }).waitFor()
  await shot(page, '04-settings.png', true)

  await page.locator('header button[aria-haspopup]').click()
  await page.getByRole('button', { name: 'Run history' }).click()
  await page.getByRole('button', { name: `Open run ${run.id}` }).waitFor()
  await shot(page, '05-run-history.png')

  await browser.close()
  console.log(`Saved current-UI references to ${outDir}`)
}, {
  serveUi: true,
  distDir: path.join(root, 'dist'),
  version: 'design-screenshots',
  model,
  callProvider: async () => ({ text: chatReply, usage: null }),
})
