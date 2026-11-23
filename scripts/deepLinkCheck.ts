/**
 * Deep-link parsing checks.
 *
 * Runs under Electron (the module imports `app`, so plain node cannot load it).
 * Covers the URL shapes the three platforms actually deliver, plus the inputs
 * that must be rejected so a stray protocol activation opens the app instead of
 * showing an error.
 */
import { app } from 'electron';
import { parseAuthDeepLink } from '../electron/account';

const cases: Array<[string, string | null, string]> = [
  ['thinkflyflow://auth?code=abc123', 'abc123', 'windows/linux form'],
  ['thinkflyflow:///auth?code=abc123', 'abc123', 'macOS path form'],
  ['thinkflyflow://auth?code=%20spaced%20', 'spaced', 'encoded and trimmed'],
  ['thinkflyflow://auth', null, 'missing code'],
  ['thinkflyflow://other?code=x', null, 'wrong host'],
  ['https://thinkflyflow.laureljar.com/?code=x', null, 'wrong scheme'],
  ['not a url', null, 'garbage'],
];

let pass = 0;
for (const [input, want, label] of cases) {
  const got = parseAuthDeepLink(input);
  const ok = got === want;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label} | got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
console.log('');
console.log(`RESULT: ${pass}/${cases.length} passed`);
app.exit(pass === cases.length ? 0 : 1);
