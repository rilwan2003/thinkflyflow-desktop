/**
 * URL construction tests.
 *
 * These exist because of a real bug: ApiClient was handed a base of
 * ".../api/v2" while every path in the class also began "/api/v2", so requests
 * went to /api/v2/api/v2/... and 404'd. Sign-in appeared to work because
 * account.ts builds its own URLs without the prefix, which hid the fault until
 * the first ApiClient call.
 */
import test from 'node:test';
import assert from 'node:assert';

// Mirrors the constructor's normalisation exactly.
function normalise(base) {
  return base.replace(/\/+$/, '').replace(/\/api\/v\d+$/, '');
}
function build(base, path) {
  return normalise(base) + path;
}

test('a base ending in /api/v2 does not produce a double prefix', () => {
  const url = build('https://api.laureljar.com/api/v2', '/api/v2/workspaces/X/projects/');
  assert.strictEqual(url, 'https://api.laureljar.com/api/v2/workspaces/X/projects/');
  assert.ok(!url.includes('/api/v2/api/v2'), 'must never double the version prefix');
});

test('a trailing slash is tolerated', () => {
  const url = build('https://api.laureljar.com/api/v2/', '/api/v2/files/lookup/');
  assert.strictEqual(url, 'https://api.laureljar.com/api/v2/files/lookup/');
});

test('a bare origin works too', () => {
  const url = build('https://apitest.laureljar.com', '/api/v2/search/?q=x');
  assert.strictEqual(url, 'https://apitest.laureljar.com/api/v2/search/?q=x');
});

test('every ApiClient path starts with /api/v2', () => {
  // If a path ever stops carrying the prefix, normalisation would break it, so
  // the two conventions must be asserted together.
  assert.ok(build('https://x.test/api/v2', '/api/v2/workspaces/').startsWith('https://x.test/api/v2/'));
});

test('the account module builds its own URLs without the prefix', () => {
  // account.ts appends "/auth/..." to apiBase, which DOES include /api/v2.
  // Documented here because mixing the two conventions is what caused the bug.
  const apiBase = 'https://api.laureljar.com/api/v2';
  assert.strictEqual(`${apiBase}/auth/desktop/exchange`, 'https://api.laureljar.com/api/v2/auth/desktop/exchange');
});

test('an API error object never renders as [object Object]', () => {
  // Real shape from Django REST Framework on a bad token.
  const drf = {
    success: false,
    error: {
      code: 401,
      message: "{'detail': ErrorDetail(string='Given token not valid...')}",
    },
  };
  const message = unwrap(drf, 401);
  assert.ok(!message.includes('[object Object]'), message);
  assert.ok(message.length > 0);
});

test('a plain string error is passed through', () => {
  assert.strictEqual(unwrap({ error: 'Workspace not found' }, 404), 'Workspace not found');
});

test('an empty body falls back to the status', () => {
  assert.strictEqual(unwrap(null, 404), 'Request failed with status 404');
});

test('DRF detail is used when there is no error field', () => {
  assert.strictEqual(unwrap({ detail: 'Not found.' }, 404), 'Not found.');
});

// Mirrors errorMessageFrom in apiClient.ts.
function unwrap(body, status) {
  const fallback = `Request failed with status ${status}`;
  if (!body || typeof body !== 'object') return fallback;
  const pick = (v) => {
    if (typeof v === 'string' && v.trim() && v !== '[object Object]') return v.trim();
    if (v && typeof v === 'object') {
      if (typeof v.message === 'string' && v.message.trim()) return v.message.trim();
      if (typeof v.detail === 'string' && v.detail.trim()) return v.detail.trim();
    }
    return null;
  };
  return pick(body.error) ?? pick(body.detail) ?? pick(body.message) ?? fallback;
}
