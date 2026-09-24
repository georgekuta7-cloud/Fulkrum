import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 20_000,
  expect: { timeout: 5000 },
  use: {
    baseURL: 'http://127.0.0.1:4174',
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A locally installed browser can be reused; otherwise Playwright's own
    // Chromium is used (what CI installs).
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
      : {}),
  },
  webServer: {
    command: 'node tests/browser/fixture.mjs',
    url: 'http://127.0.0.1:4174/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
