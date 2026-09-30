import { defineConfig, devices } from '@playwright/test';

// Parallel checkouts use distinct ports so no run reuses another tree's server.
const port = Number(process.env.PIXELJS_TEST_PORT ?? 4174);

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.PIXELJS_USE_BUNDLED_CHROMIUM === '1' ? {} : { channel: 'chrome' }),
      },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    // Browser contracts run under the production Content-Security-Policy.
    command: 'node tools/serve.mjs',
    env: { PIXELJS_SERVE_CSP: 'production', PORT: String(port) },
    url: `http://127.0.0.1:${port}/tests/browser/harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
