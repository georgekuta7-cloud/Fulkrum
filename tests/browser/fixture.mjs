import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withServer } from '../helpers.mjs'

// The real HTTP surface and store, with only model calls replaced. The helper
// owns a disposable database/workspace; no key, user data, or Docker is needed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const text = '# Fixture reply\n\n- Inspect the workspace.\n- Review the execution plan.\n\n```ts\nconst ready = true;\n```'
const model = async ({ options }) => ({
  text: String(options?.instructions ?? '').includes('You plan work')
    ? JSON.stringify({ objective: 'Inspect the workspace', tasks: [{ role: 'research', title: 'Inspect the implementation', instructions: 'Summarize the workspace.', acceptanceCheck: 'Report the inspected files.', dependsOn: [] }] })
    : 'The fixture completed its read-only review.',
  toolCalls: [],
  usage: null,
})

// Ambient developer credentials and automation settings never enter the fixture.
for (const key of Object.keys(process.env)) {
  if (/^(FULKRUM_|XAI_|OPENAI_|ANTHROPIC_|GOOGLE_|DEEPSEEK_|GLM_|ZAI_|KIMI_|MOONSHOT_)/.test(key)) delete process.env[key]
}

await withServer(async ({ store, providerRegistry, app, baseUrl }) => {
  providerRegistry.addCustom({ label: 'Browser fixture', baseUrl: 'https://example.invalid/v1', model: 'fixture-model', apiKey: 'fixture-not-a-real-key' })
  store.createProject({ name: 'Browser fixture', settings: { routing: { head: 'Browser fixture', research: 'Browser fixture', builder: 'Browser fixture' } } })
  console.log(`Browser fixture: ${baseUrl}`)
  await new Promise((resolve) => {
    const stop = () => { app.beginDraining('fixture shutdown'); resolve(undefined) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}, { serveUi: true, distDir: path.join(root, 'dist'), listenPort: 4174, version: 'browser-fixture', model, callProvider: async () => ({ text, usage: null }) })
