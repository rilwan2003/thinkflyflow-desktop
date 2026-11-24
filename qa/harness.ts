/**
 * Playwright harness for the ThinkFlyFlow desktop app.
 *
 * Every test gets:
 *   - a fresh userData directory (no session, no SQLite leftovers)
 *   - a fresh watch folder
 *   - its own fake backend on a random port
 *
 * The app runs UNPACKAGED, which is the only mode that can be pointed at the
 * test backend (see electron/account.ts: a packaged build is always pinned to
 * production).
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFakeBackend, type FakeBackend } from './fakeBackend';

const repoRoot = resolve(__dirname, '..');

export interface TestEnv {
  app: ElectronApplication;
  window: Page;
  backend: FakeBackend;
  userData: string;
  watchDir: string;
  /** Stub the native folder picker to return `watchDir`. */
  stubFolderPicker: () => Promise<void>;
  /** Evaluate inside the Electron main process. */
  inMain: <T>(op: string, arg?: unknown) => Promise<T>;
  /** Console errors collected from the renderer, minus allowlisted ones. */
  consoleErrors: string[];
  cleanup: () => Promise<void>;
}

export interface LaunchOptions {
  /** Point the app at the fake backend instead of staging. Default true. */
  useFakeBackend?: boolean;
  /** Extra environment variables. */
  env?: Record<string, string>;
}

/** Console errors the app legitimately emits. Each must say why. */
const ALLOWED_CONSOLE_ERRORS = [
  // Chromium logs this for the empty tray image; it is not an app fault.
  'Failed to load resource: net::ERR_FILE_NOT_FOUND',
];

export async function launchApp(opts: LaunchOptions = {}): Promise<TestEnv> {
  const useFake = opts.useFakeBackend !== false;
  const backend = await startFakeBackend();

  const userData = mkdtempSync(join(tmpdir(), 'tff-qa-userdata-'));
  const watchDir = mkdtempSync(join(tmpdir(), 'tff-qa-watch-'));
  const consoleErrors: string[] = [];

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(opts.env ?? {}),
    NODE_ENV: 'production',
    // A packaged build is locked to production; unpackaged plus these two is the
    // only way to reach staging. The fake backend overrides the API base below.
    TFF_ACCOUNT_ENV: 'staging',
    TFF_ACCOUNT_ENV_ALLOW: '1',
    // Enables the narrow QA bridge (main-process ops) and the renderer channel.
    TFF_QA_BRIDGE: '1',
  };
  if (useFake) {
    // Test-only seam in electron/account.ts: honoured only when unpackaged.
    env.TFF_TEST_API_BASE = backend.apiBase;
    env.TFF_TEST_WEB_ORIGIN = backend.url;
  }
  // Never inherit a dev-server flag from the parent shell.
  delete env.TFF_DEV_SERVER;
  delete env.TFF_SMOKE;

  const executablePath = join(repoRoot, 'node_modules/electron/dist/electron');

  const app = await electron.launch({
    executablePath,
    // Root in a container: Chromium refuses to start with its sandbox on.
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', repoRoot],
    env,
  });

  // Force the API base at the fake server: resolveAccountEnvironment() reads
  // TFF_TEST_API_BASE at startup, before any request is made.
  const window = await app.firstWindow({ timeout: 60_000 });
  window.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (ALLOWED_CONSOLE_ERRORS.some((a) => text.includes(a))) return;
    consoleErrors.push(text);
  });

  await window.waitForLoadState('domcontentloaded');

  const inMain = async <T,>(op: string, arg?: unknown): Promise<T> =>
    (await window.evaluate(
      async ({ o, a }) => await (window as any).tff.qa(o, a),
      { o: op, a: arg },
    )) as T;

  const stubFolderPicker = async () => {
    await app.evaluate(async ({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, watchDir);
  };

  const cleanup = async () => {
    try { await app.close(); } catch { /* already gone */ }
    await backend.close().catch(() => {});
    for (const dir of [userData, watchDir]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };

  return { app, window, backend, userData, watchDir, stubFolderPicker, inMain, consoleErrors, cleanup };
}

/** Write a file into the watch folder and return its path. */
export function writeFixture(dir: string, name: string, content: string): string {
  const full = join(dir, name);
  mkdirSync(resolve(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}
