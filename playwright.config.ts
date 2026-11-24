import { defineConfig } from '@playwright/test';

/**
 * Electron tests run headed under Xvfb: Electron is not a browser and does not
 * support headless the way Chromium does. `xvfb-run` supplies the display.
 */
export default defineConfig({
  testDir: './qa/specs',
  // One at a time: Electron plus a video is already tight on this host's RAM,
  // and each test drives a real app instance with its own window.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'qa/test-results/results.json' }],
    ['html', { outputFolder: 'qa/test-results/html', open: 'never' }],
  ],
  outputDir: 'qa/test-results/artifacts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
