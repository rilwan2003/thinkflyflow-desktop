/**
 * Phase 5 — IPC and security.
 *
 * The preload bridge is the entire attack surface between the UI and the
 * machine (the app's own words). These tests attack it rather than confirm it
 * works, because a guard that has never been attacked is not evidence.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, type TestEnv } from '../harness';

let env: TestEnv;
let siblingDir: string;

test.beforeAll(async () => {
  env = await launchApp();
  await env.inMain('syncStart');
  await env.inMain('syncAddRoot', env.watchDir);

  // A sibling directory whose name shares a prefix with the watched root.
  // /tmp/tff-qa-watch-XXXX-evil must NOT be treated as inside /tmp/tff-qa-watch-XXXX.
  siblingDir = `${env.watchDir}-evil`;
  mkdirSync(siblingDir, { recursive: true });
  writeFileSync(join(siblingDir, 'outside.txt'), 'not yours');
});

test.afterAll(async () => {
  await env.inMain('syncStop');
  await env.cleanup();
});

test('P-01: the bridge exposes named functions only, never ipcRenderer', async () => {
  const surface = await env.window.evaluate(() => Object.keys((window as any).tff).sort());
  console.log('[P-01] bridge surface:', surface.join(', '));

  expect(surface).not.toContain('ipcRenderer');
  expect(surface).not.toContain('require');
  expect(surface).not.toContain('process');
  expect(surface.length).toBeGreaterThan(15);
});

test('P-02: the renderer cannot reach an undeclared channel', async () => {
  const out = await env.window.evaluate(async () => {
    try {
      // There is no exposed invoke; this is the closest a compromised page can get.
      const anyTff = window as any;
      return { invoked: await anyTff.tff.definitelyNotAChannel?.() };
    } catch (err: any) {
      return { threw: true, message: String(err?.message ?? err) };
    }
  });
  console.log('[P-02] undeclared channel attempt:', JSON.stringify(out));
  expect(out.threw || out.invoked === undefined).toBe(true);
});

test('P-03: a path inside a watched root is allowed', async () => {
  const inside = join(env.watchDir, 'legit.txt');
  writeFileSync(inside, 'inside');
  const allowed = await env.inMain<boolean>('guardUnderRoot', inside);
  console.log(`[P-03] inside root allowed: ${allowed}`);
  expect(allowed, 'a genuine watched file must be allowed').toBe(true);
});

test('P-04: a sibling directory sharing the root prefix is rejected (F-003)', async () => {
  // F-003: the guard is a bare startsWith on the raw string, so a folder whose
  // name merely begins with the root's path passes.
  const outside = join(siblingDir, 'outside.txt');
  const allowed = await env.inMain<boolean>('guardUnderRoot', outside);
  console.log(`[P-04] sibling ${outside} allowed: ${allowed}`);
  console.log(`[P-04] watched root is ${env.watchDir}`);
  expect(allowed, 'F-003: a sibling path must NOT be treated as inside the root').toBe(false);
});

test('P-05: path traversal out of the root is rejected (F-003)', async () => {
  // F-003: no normalisation, so ../ escapes the prefix and still matches.
  const traversal = `${env.watchDir}/../../etc/passwd`;
  const allowed = await env.inMain<boolean>('guardUnderRoot', traversal);
  console.log(`[P-05] traversal ${traversal} allowed: ${allowed}`);
  expect(allowed, 'F-003: ../../ escape must be rejected').toBe(false);
});

test('P-06: openExternal allows https only', async () => {
  const cases: [string, boolean][] = [
    ['https://thinkflyflow.laureljar.com/docs', true],
    ['http://thinkflyflow.laureljar.com', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['ms-msdt:/id', false],
    ['smb://evil/share', false],
    ['', false],
  ];
  for (const [url, expected] of cases) {
    const allowed = await env.inMain<boolean>('guardOpenExternal', url);
    console.log(`[P-06] ${JSON.stringify(url)} -> ${allowed ? 'ALLOWED' : 'blocked'}`);
    expect(allowed, `openExternal ${url}`).toBe(expected);
  }
});

test('P-07: renderer has no Node globals beyond what the bridge exposes', async () => {
  const probe = await env.window.evaluate(() => ({
    require: typeof (window as any).require,
    process: typeof (window as any).process,
    module: typeof (window as any).module,
    global: typeof (window as any).global,
    Buffer: typeof (window as any).Buffer,
  }));
  console.log('[P-07] globals:', JSON.stringify(probe));
  expect(probe.require).toBe('undefined');
  expect(probe.process).toBe('undefined');
  expect(probe.Buffer).toBe('undefined');
  expect(probe.global).toBe('undefined');
});

test('P-08: webPreferences are isolation-on, node-off, sandbox-off', async () => {
  // Read the real values from the live window rather than trusting the source.
  const prefs = await env.inMain<Record<string, unknown>>('windowPrefs');
  console.log('[P-08] webPreferences:', JSON.stringify(prefs));
  expect(prefs.contextIsolation).toBe(true);
  expect(prefs.nodeIntegration).toBe(false);
  expect(prefs.sandbox, 'sandbox disabled is OBS-02, tracked separately').toBe(false);
});

test('P-09: search palette window has the same isolation settings', async () => {
  // The palette loads the same preload in a second window; a weaker config
  // there would undo the main window's protections.
  const prefs = await env.inMain<Record<string, unknown>>('searchWindowPrefs');
  console.log('[P-09] palette webPreferences:', JSON.stringify(prefs));
  expect(prefs.contextIsolation).toBe(true);
  expect(prefs.nodeIntegration).toBe(false);
});

test('P-10: localFiles never returns a path outside a watched root', async () => {
  const hits = await env.window.evaluate(async () => await (window as any).tff.localFiles('outside.txt'));
  const outside = hits.filter((h: any) => !h.localPath.startsWith((window as any).__root ?? ''));
  console.log(`[P-10] localFiles hits for outside.txt: ${hits.length}`);
  // The sibling file was never indexed, so it must not appear at all.
  expect(hits).toHaveLength(0);
  expect(outside).toHaveLength(0);
});
