import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Capped deliberately. `astro preview` is a single static file server, and
  // Playwright's local default (half the cores) saturates it on an 8-core box:
  // every spec then fails on page.goto timeout, which reads like a site
  // regression rather than a load problem. Two workers run the suite in ~50s.
  workers: process.env.CI ? 1 : 2,
  reporter: 'html',

  use: {
    baseURL: process.env.TEST_URL || 'http://localhost:14325',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: process.env.TEST_URL ? undefined : {
    // Dedicated test port: the dev server owns 14321, and reuseExistingServer
    // would otherwise latch onto it and time out against dev-mode rendering.
    command: 'bun x astro preview --port 14325',
    url: 'http://localhost:14325/',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
