import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Playwright config for EqualLoud E2E.
 *
 * Key detail: MV3 extensions only load under a *persistent* context launched
 * with `channel: 'chromium'` (the new headless mode that runs real Chrome).
 * The old headless shell does NOT support extensions. See e2e/fixtures.ts for
 * the launchPersistentContext call that wires `--load-extension`.
 *
 * https://playwright.dev/docs/chrome-extensions
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // extensions share one persistent context; no parallelism
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    // Capture evidence on failure so we can report what the popup/badge looked like.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'chromium-extension',
      use: {
        // The new headless mode = real Chrome, the only headless channel that
        // supports loading MV3 extensions.
        channel: 'chromium',
        headless: true,
        ...devices['Desktop Chrome'],
      },
    },
  ],
})
