/**
 * Phase 2 — authentication.
 *
 * The sign-in flow is a browser hand-off: the app opens the product's own login
 * page and receives a single-use code back through a deep link. That means the
 * security-critical surface is the deep-link parser and the code exchange, not
 * a form. Both are tested directly through the QA bridge, which forwards to the
 * real implementations in the main process.
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

test('A-01: sign-in URL points at the configured web origin with the right redirect', async () => {
  const url = await env.inMain<string>('signInUrl');
  expect(url).toContain('/desktop-auth');
  expect(url).toContain('app=thinkflyflow');
  expect(url).toContain(encodeURIComponent('thinkflyflow://auth'));
  console.log('[A-01] sign-in URL:', url);
});

test('A-02: deep-link parser accepts valid links and rejects everything else', async () => {
  const cases: [string, string, string | null][] = [
    ['thinkflyflow://auth?code=good-code', 'valid: standard', 'good-code'],
    ['thinkflyflow://auth?code=  padded  ', 'valid: trims whitespace', 'padded'],
    ['thinkflyflow://auth/', 'invalid: missing code', null],
    ['thinkflyflow://auth?code=', 'invalid: empty code', null],
    ['thinkflyflow://auth?code=%20%20', 'invalid: whitespace-only', null],
    ['thinkflyflow://other?code=x', 'invalid: wrong host', null],
    ['https://evil.example/auth?code=x', 'invalid: wrong scheme', null],
    ['not-a-url', 'invalid: unparseable', null],
    ['javascript:alert(1)//thinkflyflow://auth?code=x', 'invalid: javascript scheme', null],
  ];

  for (const [input, label, expected] of cases) {
    const parsed = await env.inMain<string | null>('parseDeepLink', input);
    console.log(`[A-02] ${label} -> ${JSON.stringify(parsed)}  (input: ${input.slice(0, 50)})`);
    expect(parsed, `${label} — ${input}`).toBe(expected);
  }
});

test('A-03: sign-in fails cleanly when the code exchange is rejected', async () => {
  env.backend.rejectAuth = true;
  try {
    const out = await env.inMain<{ ok: boolean; error?: string; value?: unknown }>(
      'exchangeCode',
      'bogus-code',
    );
    expect(out.ok, 'a rejected exchange must not report success').toBe(false);
    expect(out.error).toBeTruthy();
    console.log('[A-03] exchange rejection message:', out.error);
  } finally {
    env.backend.rejectAuth = false;
  }
});

test('A-04: no API key or session token is reachable from the renderer', async () => {
  const probe = await env.window.evaluate(() => {
    const ls: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      ls[k] = (localStorage.getItem(k) ?? '').slice(0, 60);
    }
    return { keys: Object.keys(ls), ls, cookieLen: document.cookie.length };
  });

  const blob = JSON.stringify(probe.ls).toLowerCase();
  expect(blob).not.toContain('sk_');
  expect(blob).not.toContain('api_key');
  expect(blob).not.toContain('bearer');
  console.log('[A-04] renderer localStorage keys:', probe.keys.join(', ') || '(none)');
  console.log('[A-04] document.cookie length:', probe.cookieLen);
});

test('A-05: the app targets the fake backend, not production or staging', async () => {
  const apiBase = await env.inMain<string>('apiBase');
  console.log('[A-05] resolved API base:', apiBase);
  expect(apiBase, 'tests must never touch a real backend').toContain('127.0.0.1');
  expect(apiBase).not.toContain('api.laureljar.com');
  expect(apiBase).not.toContain('apitest.laureljar.com');
});

test('A-06: secure storage availability is reported truthfully to the UI', async () => {
  const fromUi = await env.window.evaluate(async () => await (window as any).tff.secureStorageAvailable());
  const fromMain = await env.inMain<boolean>('secureStorage');
  expect(fromUi).toBe(fromMain);
  console.log(`[A-06] secure storage available: ${fromUi}`);
});
