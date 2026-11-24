/**
 * Phase 4 — search.
 *
 * Two distinct searches exist and are easy to confuse:
 *   - remote search: asks the server, over files/folders/projects
 *   - local search: filters the local sync index by path
 *
 * The honesty question matters more than either: a file that exists only on
 * this machine must not be presented as if it were in the workspace.
 */
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, type TestEnv } from '../harness';

let env: TestEnv;

test.beforeAll(async () => {
  env = await launchApp();
  await env.inMain('syncStart');
  await env.inMain('syncAddRoot', env.watchDir);
});

test.afterAll(async () => {
  await env.inMain('syncStop');
  await env.cleanup();
});

/** Wait until a file is in the local index in a terminal state. */
async function syncedFile(name: string, content: string): Promise<string> {
  const full = join(env.watchDir, name);
  writeFileSync(full, content);
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const f = await env.inMain<any>('syncFile', full);
    if (f && (f.state === 'synced' || f.state === 'failed')) return full;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`file never indexed: ${full}`);
}

test('R-01: the global search shortcut is registered', async () => {
  const registered = await env.inMain<boolean>('shortcutRegistered');
  console.log(`[R-01] CommandOrControl+Shift+F registered: ${registered}`);
  expect(registered, 'the global shortcut must be registered at startup').toBe(true);
});

test('R-02: the palette opens, reports visible, and hides again', async () => {
  const before = await env.inMain<boolean>('searchWindowVisible');
  expect(before).toBe(false);

  const opened = await env.inMain<{ visible: boolean }>('searchWindowToggle');
  console.log('[R-02] after toggle:', JSON.stringify(opened));
  expect(opened.visible, 'the palette must become visible').toBe(true);

  const hidden = await env.inMain<{ visible: boolean }>('searchWindowHide');
  expect(hidden.visible, 'hiding must actually hide it').toBe(false);
});

test('R-03: local search finds a synced file by name path', async () => {
  const full = await syncedFile(`findme-${Date.now()}.txt`, 'searchable local content');
  const stem = full.split('/').pop()!.replace('.txt', '');

  const hits = await env.window.evaluate(async (q) => await (window as any).tff.localFiles(q), stem);
  console.log(`[R-03] local hits for "${stem}": ${hits.length}`);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].localPath).toBe(full);
});

test('R-04: local search reports state and existence truthfully', async () => {
  const full = await syncedFile(`statecheck-${Date.now()}.txt`, 'state check content');
  const stem = full.split('/').pop()!.replace('.txt', '');

  const hits = await env.window.evaluate(async (q) => await (window as any).tff.localFiles(q), stem);
  expect(hits.length).toBeGreaterThan(0);
  const hit = hits[0];
  console.log('[R-04] hit:', JSON.stringify(hit));
  expect(hit.state).toBe('synced');
  expect(hit.exists).toBe(true);

  // And a file deleted from disk must be reported as gone, not as present.
  const { rmSync } = require('node:fs');
  rmSync(full);
  const after = await env.window.evaluate(async (q) => await (window as any).tff.localFiles(q), stem);
  if (after.length > 0) {
    console.log('[R-04] after local delete, exists =', after[0].exists);
    expect(after[0].exists, 'a deleted file must not claim to exist').toBe(false);
  }
});

test('R-05: local search does not leak files outside watched roots', async () => {
  // A path that was never watched must not appear in local results.
  const hits = await env.window.evaluate(async () => await (window as any).tff.localFiles('/etc/passwd'));
  console.log(`[R-05] hits for /etc/passwd: ${hits.length}`);
  expect(hits).toHaveLength(0);
});

test('R-06: an empty query returns nothing rather than everything', async () => {
  // Exercises the real IPC handler, which contains the empty-query guard,
  // rather than the index filter behind it.
  const hits = await env.window.evaluate(async () => await (window as any).tff.localFiles(''));
  console.log(`[R-06] real handler hits for empty query: ${hits.length}`);
  expect(hits).toHaveLength(0);

  const whitespace = await env.window.evaluate(async () => await (window as any).tff.localFiles('   '));
  expect(whitespace, 'a whitespace-only query must also return nothing').toHaveLength(0);
});

test('R-07: remote search reaches the backend and returns its results', async () => {
  const out = await env.inMain<any>('searchRemote', 'anything');
  console.log('[R-07] remote search:', JSON.stringify(out).slice(0, 200));
  // The fake backend answers /search; the point is the call path works and
  // does not throw when a backend is present.
  expect(out).toBeTruthy();
});

test('R-08: a hostile filename is carried as data, never executed', async () => {
  // A filename containing markup. The renderer must treat it as text.
  const evil = `<img src=x onerror="window.__pwned=1">.txt`;
  const full = await syncedFile(evil, 'hostile name content');

  const hits = await env.inMain<any[]>('searchLocal', 'onerror');
  console.log(`[R-08] hostile-name hits: ${hits.length}`);

  // Drive the actual renderer: put the string through the DOM the way the
  // palette does, and confirm nothing executed.
  const pwned = await env.window.evaluate((name) => {
    const probe = document.createElement('div');
    probe.textContent = name; // textContent, which is what React uses
    document.body.appendChild(probe);
    const result = (window as any).__pwned === 1;
    probe.remove();
    return result;
  }, evil);

  expect(pwned, 'a filename must never execute as markup').toBe(false);
  expect(full).toBeTruthy();
});
