/**
 * Phase 1 — smoke and build verification.
 *
 * These prove the app launches reproducibly under the harness with a fresh
 * profile. Everything later depends on them.
 */
import { test, expect } from '@playwright/test';
import { launchApp, type TestEnv } from '../harness';

let env: TestEnv;

test.beforeAll(async () => {
  env = await launchApp();
});

test.afterAll(async () => {
  await env.cleanup();
});

test('S-01: window opens and renders the app shell', async () => {
  const { window } = env;
  await expect(window).toHaveTitle(/ThinkFlyFlow/i);
  // The renderer must mount something, not sit on a blank document.
  const body = await window.textContent('body');
  expect((body ?? '').trim().length).toBeGreaterThan(0);
  await window.screenshot({ path: 'qa/test-results/S-01-launch.png' });
});

test('S-02: build is unpackaged, so staging/fake endpoints are reachable', async () => {
  const packaged = await env.app.evaluate(async ({ app }) => app.isPackaged);
  expect(packaged).toBe(false);

  const version = await env.app.evaluate(async ({ app }) => app.getVersion());
  expect(version).toBeTruthy();
  // Provenance is a known finding (AppImage says 0.1.3, package.json says 0.1.2).
  console.log(`[S-02] app version reported by source build: ${version}`);
});

test('S-03: renderer has no Node access (preload surface only)', async () => {
  const probe = await env.window.evaluate(() => ({
    hasRequire: typeof (window as any).require !== 'undefined',
    hasProcess: typeof (window as any).process !== 'undefined',
    hasTff: typeof (window as any).tff !== 'undefined',
    tffKeys: Object.keys((window as any).tff ?? {}).sort(),
  }));

  expect(probe.hasRequire, 'require must not leak into the renderer').toBe(false);
  expect(probe.hasProcess, 'process must not leak into the renderer').toBe(false);
  expect(probe.hasTff, 'the preload bridge must be present').toBe(true);

  // The bridge must expose named functions only, never ipcRenderer itself.
  expect(probe.tffKeys).not.toContain('ipcRenderer');
  expect(probe.tffKeys.length).toBeGreaterThan(10);
  console.log('[S-03] bridge surface:', probe.tffKeys.join(', '));
});

test('S-04: no unexplained renderer console errors on a clean launch', async () => {
  // Give the app a moment to finish its first render and any startup requests.
  await env.window.waitForTimeout(2000);
  expect(env.consoleErrors, `console errors: ${env.consoleErrors.join(' | ')}`).toEqual([]);
});
