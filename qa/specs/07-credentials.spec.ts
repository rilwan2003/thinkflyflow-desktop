/**
 * Phase 7 — secure-storage fallback (closes OBS-03).
 *
 * On a machine with no OS keyring, the app must refuse to persist the
 * workspace-wide `sk_` credential rather than quietly writing it in plaintext.
 * Writing it unencrypted would mean whoever holds that file can read and write
 * the entire workspace, which is worse than asking the user to sign in again.
 *
 * The app's own credentials module states this explicitly. This test proves the
 * shipped behaviour matches the stated intent.
 */
import { test, expect } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, type TestEnv } from '../harness';

let env: TestEnv;

test.beforeAll(async () => {
  env = await launchApp();
});

test.afterAll(async () => {
  await env.cleanup();
});

test('V-01: secure storage availability is reported honestly', async () => {
  const available = await env.inMain<boolean>('secureStorage');
  console.log(`[V-01] safeStorage.isEncryptionAvailable(): ${available}`);

  // Whatever the host says, the UI must be told the same thing.
  const fromUi = await env.window.evaluate(async () => await (window as any).tff.secureStorageAvailable());
  expect(fromUi).toBe(available);
});

test('V-02: the UI warns the user when sign-in cannot be saved', async () => {
  const available = await env.inMain<boolean>('secureStorage');

  const body = (await env.window.textContent('body')) ?? '';
  const hasWarning = /no secure credential storage|cannot be saved|sign in each time/i.test(body);

  console.log(`[V-02] secure storage available: ${available}; warning shown: ${hasWarning}`);

  if (!available) {
    // On a host without a keyring the user must be told, not left to discover it
    // when they are signed out unexpectedly on next launch.
    expect(hasWarning, 'the UI must explain that sign-in cannot be saved').toBe(true);
  } else {
    console.log('[V-02] keyring present, so no warning is expected on this host');
  }
});

test('V-03: no credential is written to disk when secure storage is unavailable', async () => {
  const available = await env.inMain<boolean>('secureStorage');
  if (available) {
    test.skip(true, 'host has a keyring; the refusal path cannot be exercised');
    return;
  }

  // The app must leave no credential file behind. A plaintext key on disk is the
  // exact failure mode the module's own comment calls "the worst possible".
  const files = readdirSync(env.userData);
  const suspicious = files.filter((f) => /credential|account|secret|token/i.test(f));

  console.log('[V-03] userData contents:', files.join(', ') || '(empty)');
  console.log('[V-03] credential-like files:', suspicious.join(', ') || '(none)');

  // account.json is the session record; it must not contain a raw sk_ key.
  for (const name of suspicious) {
    const full = join(env.userData, name);
    const { readFileSync } = require('node:fs');
    const text = readFileSync(full, 'utf8');
    expect(text, `${name} must not contain a plaintext sk_ key`).not.toMatch(/sk_[A-Za-z0-9]{16,}/);
    console.log(`[V-03] ${name}: no plaintext key found (${text.length} bytes)`);
  }
});

test('V-04: a missing credential file is treated as signed out, not as a crash', async () => {
  // The load path catches missing/corrupt/foreign-user files and returns null.
  // Prove the app is still usable (window alive, signed-out screen intact)
  // rather than having thrown on launch.
  const stillAlive = await env.window.evaluate(() => document.body.childElementCount > 0);
  expect(stillAlive, 'the app must render even with no stored credential').toBe(true);

  const hasSignIn = /sign in/i.test((await env.window.textContent('body')) ?? '');
  expect(hasSignIn).toBe(true);
});
