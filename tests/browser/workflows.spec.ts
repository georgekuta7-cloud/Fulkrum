import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

async function createProject(request: APIRequestContext, name: string) {
  const response = await request.post('/api/projects', { data: { name, settings: { routing: { head: 'Browser fixture', research: 'Browser fixture', builder: 'Browser fixture' } } } })
  expect(response.status()).toBe(201)
  return (await response.json()).project as { id: string; name: string }
}

async function createRun(request: APIRequestContext, projectId: string) {
  const response = await request.post('/api/runs', { data: { projectId } })
  expect(response.status()).toBe(201)
  return (await response.json()).run as { id: string; status: string }
}

async function chooseProject(page: Page, name: string) {
  await page.locator('header button[aria-haspopup]').click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

test('layout spacing keeps content clear of the fixed header and navigation in both themes', async ({ page, request }) => {
  const project = await createProject(request, 'Layout fixture')
  await createRun(request, project.id)
  await page.goto('/')
  await expect(page.getByLabel('Direct the Head AI')).toBeVisible()
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 960 })
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await page.getByRole('button', { name: 'Switch to light theme' }).click()
      const layout = await page.locator('main').evaluate((element) => {
        const style = getComputedStyle(element)
        const content = element.querySelector('.view-enter')!.getBoundingClientRect()
        return { left: parseFloat(style.paddingLeft), top: parseFloat(style.paddingTop), contentLeft: content.left, contentTop: content.top, overflow: document.documentElement.scrollWidth > innerWidth }
      })
      expect(layout.left).toBeGreaterThanOrEqual(64)
      expect(layout.top).toBeGreaterThanOrEqual(56)
      expect(layout.contentLeft).toBeGreaterThanOrEqual(64)
      expect(layout.contentTop).toBeGreaterThanOrEqual(56)
      expect(layout.overflow).toBe(false)
      if (theme === 'light') await page.getByRole('button', { name: 'Switch to dark theme' }).click()
    }
  }
})

test('a first plan can be drafted, inspected, approved, and found again in run history', async ({ page, request }) => {
  const project = await createProject(request, 'Planning fixture')
  const run = await createRun(request, project.id)
  await page.goto('/')
  await page.getByLabel('Direct the Head AI').fill('Inspect this workspace and report what you find.')
  await page.getByRole('button', { name: 'Send (Ctrl+Enter)' }).click()
  await page.getByRole('button', { name: 'Draft plan', exact: true }).click()
  await expect(page.getByText('Report the inspected files.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Approve & Run', exact: true }).click()
  await expect.poll(async () => (await (await request.get(`/api/runs/${run.id}`)).json()).run.status).toBe('review')
  await page.locator('header button[aria-haspopup]').click()
  await page.getByRole('button', { name: 'Run history', exact: true }).click()
  await page.getByRole('button', { name: `Open run ${run.id}`, exact: true }).click()
  await expect(page.getByText('Inspect the workspace', { exact: false }).first()).toBeVisible()
  await page.locator('header button[aria-haspopup]').click()
  await page.getByRole('button', { name: 'New run', exact: true }).click()
  await expect(page.getByLabel('Direct the Head AI')).toHaveValue('')
  const runs = (await (await request.get(`/api/runs?projectId=${project.id}`)).json()).runs
  expect(runs).toHaveLength(2)
})

test('a second project is creatable and opening an empty project does not silently create runs', async ({ page, request }) => {
  const project = await createProject(request, 'Empty project fixture')
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Start a new run', exact: true })).toBeVisible()
  expect((await (await request.get(`/api/runs?projectId=${project.id}`)).json()).runs).toHaveLength(0)
  await page.locator('header button[aria-haspopup]').click()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  await page.getByLabel('New project name').fill('Created from the project menu')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('header button[aria-haspopup]')).toContainText('Created from the project menu')
  await expect(page.getByRole('button', { name: 'Start a new run', exact: true })).toBeVisible()
})

test('late project responses cannot switch the active conversation or its actions', async ({ page, request }) => {
  const slow = await createProject(request, 'Slow project fixture')
  const slowRun = await createRun(request, slow.id)
  await request.post('/api/chat', { data: { projectId: slow.id, runId: slowRun.id, message: 'Only the slow project contains this message.', routing: { head: 'Browser fixture' } } })
  const fast = await createProject(request, 'Fast project fixture')
  const fastRun = await createRun(request, fast.id)
  await request.post('/api/chat', { data: { projectId: fast.id, runId: fastRun.id, message: 'Only the fast project contains this message.', routing: { head: 'Browser fixture' } } })
  await page.goto('/')
  await expect(page.getByText('Only the fast project contains this message.', { exact: true })).toBeVisible()
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  await page.route(`**/api/projects/${slow.id}`, async (route) => {
    const response = await route.fetch()
    entered()
    await held
    await route.fulfill({ response }).catch(() => {})
  })
  await chooseProject(page, slow.name)
  await started
  await chooseProject(page, fast.name)
  await expect(page.getByText('Only the fast project contains this message.', { exact: true })).toBeVisible()
  release()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.locator('header button[aria-haspopup]')).toContainText(fast.name)
  await expect(page.getByText('Only the slow project contains this message.', { exact: true })).toHaveCount(0)
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/chat') && r.method() === 'POST')
  await page.getByLabel('Direct the Head AI').fill('Keep this message in the selected project.')
  await page.getByRole('button', { name: 'Send (Ctrl+Enter)' }).click()
  expect((await sent).postDataJSON()).toMatchObject({ projectId: fast.id, runId: fastRun.id })
})

test('write approval displays the exact proposed content after loading the run', async ({ page, request }) => {
  const project = await createProject(request, 'Approval fixture')
  const run = await createRun(request, project.id)
  const content = 'export const requiresApproval = true;\nexport const reviewed = "full contents";\n'
  const parked = await request.post(`/api/runs/${run.id}/tools`, { data: { name: 'workspace.write', agentId: 'builder', input: { path: 'approval-fixture.ts', content } } })
  expect(parked.status()).toBe(409)
  await page.goto('/')
  const approval = page.getByRole('alert', { name: 'Approval required' })
  await expect(approval).toContainText('export const requiresApproval = true;')
  await expect(approval).toContainText('export const reviewed = "full contents";')
  await page.keyboard.press('Control+a')
  const calls = (await (await request.get(`/api/runs/${run.id}/tools`)).json()).toolCalls
  expect(calls[0].status).toBe('approval_required')
  await approval.getByRole('button', { name: /^Deny/ }).click()
  await page.getByLabel('Why not').fill('Please revise the proposed content.')
  await approval.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(approval).toHaveCount(0)
})

test('failed sends preserve the draft and assistant Markdown renders as structured content', async ({ page, request }) => {
  const project = await createProject(request, 'Message fixture')
  await createRun(request, project.id)
  await page.goto('/')
  await page.route('**/api/chat', (route) => route.fulfill({ status: 502, contentType: 'application/problem+json', body: JSON.stringify({ detail: 'Fixture provider is unavailable.' }) }))
  const prompt = page.getByLabel('Direct the Head AI')
  await prompt.fill('Keep this draft after the failure.')
  await page.getByRole('button', { name: 'Send (Ctrl+Enter)' }).click()
  await expect(page.getByRole('alert')).toContainText('Fixture provider is unavailable.')
  await expect(prompt).toHaveValue('Keep this draft after the failure.')
  await page.unroute('**/api/chat')
  await page.getByRole('button', { name: 'Send (Ctrl+Enter)' }).click()
  await expect(page.getByRole('heading', { name: 'Fixture reply' })).toBeVisible()
  await expect(page.locator('pre code')).toContainText('const ready = true;')
  await expect(prompt).toHaveValue('')
})

test('opening run history refreshes state changed outside the current view', async ({ page, request }) => {
  const project = await createProject(request, 'History refresh fixture')
  const run = await createRun(request, project.id)
  await page.goto('/')
  await expect(page.getByLabel('Direct the Head AI')).toBeVisible()
  const paused = await request.post(`/api/runs/${run.id}/control`, { data: { action: 'pause' } })
  expect(paused.status()).toBe(200)
  await expect(page.getByRole('button', { name: 'Resume run' })).toBeVisible()
  await page.locator('header button[aria-haspopup]').click()
  await page.getByRole('button', { name: 'Run history', exact: true }).click()
  await expect(page.getByRole('button', { name: `Open run ${run.id}`, exact: true })).toContainText('paused')
})

test('provider forms persist edits, retain rejected input, and remove keys only explicitly', async ({ page, request }) => {
  const created = await request.post('/api/providers', { data: { label: 'Provider form fixture', baseUrl: 'https://example.invalid/v1', model: 'model-one', apiKey: 'fixture-credential' } })
  expect(created.status()).toBe(201)
  const { provider } = await created.json()
  await createProject(request, 'Provider form project')
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const card = page.getByRole('region', { name: 'Provider Provider form fixture', exact: true })
  await card.getByRole('button', { name: 'Edit', exact: true }).click()
  await card.getByLabel('Model', { exact: true }).fill('model-two')
  await card.getByLabel('Base URL', { exact: true }).fill('https://edited.invalid/v2')
  await card.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  const current = (await (await request.get('/api/providers')).json()).providers.find((p: { id: string }) => p.id === provider.id)
  expect(current).toMatchObject({ model: 'model-two', baseUrl: 'https://edited.invalid/v2', hasKey: true })
  await card.getByRole('button', { name: 'Edit', exact: true }).click()
  await card.getByLabel('Model', { exact: true }).fill('model-three')
  await page.route(`**/api/providers/${provider.id}`, (route) => route.fulfill({ status: 400, contentType: 'application/problem+json', body: JSON.stringify({ detail: 'Fixture rejected this save.' }) }))
  await card.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(card.getByRole('alert')).toContainText('Fixture rejected this save.')
  await expect(card.getByLabel('Model', { exact: true })).toHaveValue('model-three')
  await page.unroute(`**/api/providers/${provider.id}`)
  await card.getByLabel('Remove stored key on save').check()
  await card.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  const removed = (await (await request.get('/api/providers')).json()).providers.find((p: { id: string }) => p.id === provider.id)
  expect(removed).toMatchObject({ model: 'model-three', hasKey: false })
})
