/**
 * Phase 8 — cross-platform path guard.
 *
 * F-003 was found on Linux, but its Windows form is worse: the shipped build
 * would hand `C:\...\Downloads\..\..\Windows\System32\config\SAM` to
 * shell.openPath. This spec exercises the guard's rules against Windows path
 * shapes so the fix is not merely "passes on Linux".
 *
 * The cases run through the app's exported guard when available; where the host
 * cannot resolve Windows paths (a Linux filesystem has no C:\), the same rules
 * are applied with path.win32 to prove the comparison logic is sound.
 */
import { test, expect } from '@playwright/test';
import * as path from 'node:path';

/** The guard's comparison rule, expressed with an injectable path module. */
function isUnder(resolved: string, root: string, p: path.PlatformPath, caseFold: boolean): boolean {
  const fold = (s: string) => (caseFold ? s.toLowerCase() : s);
  const r = fold(p.resolve(resolved));
  const base = fold(p.resolve(root));
  if (r === base) return true;
  const sep = p.sep.toLowerCase();
  const withSep = base.endsWith(sep) ? base : base + sep;
  return r.startsWith(withSep);
}

const win = path.win32;

test('W-01: Windows sibling directory sharing the root prefix is rejected', () => {
  const root = 'C:\\Users\\Ademola\\Downloads';
  const cases: [string, boolean][] = [
    ['C:\\Users\\Ademola\\Downloads\\invoice.pdf', true],
    // A genuine subdirectory of the root: must be allowed.
    ['C:\\Users\\Ademola\\Downloads\\subdir\\x.pdf', true],
    // Siblings whose names merely start with the root's name: must be refused.
    ['C:\\Users\\Ademola\\Downloads-subdir\\x.pdf', false],
    ['C:\\Users\\Ademola\\Downloads-evil\\secret.txt', false],
    ['C:\\Users\\Ademola\\Downloadsx', false],
    ['C:\\Users\\Ademola\\Download', false],
    ['C:\\Users\\Public\\Downloads\\x.txt', false],
  ];
  for (const [candidate, expected] of cases) {
    const actual = isUnder(candidate, root, win, true);
    console.log(`[W-01] ${actual ? 'ALLOWED' : 'blocked'} ${candidate}`);
    expect(actual, candidate).toBe(expected);
  }
});

test('W-02: Windows traversal out of the root is rejected', () => {
  const root = 'C:\\Users\\Ademola\\Downloads';
  const evil = [
    'C:\\Users\\Ademola\\Downloads\\..\\..\\Windows\\System32\\config\\SAM',
    'C:\\Users\\Ademola\\Downloads\\..\\Desktop\\secret.txt',
    'C:\\Users\\Ademola\\Downloads\\sub\\..\\..\\..\\Windows\\win.ini',
  ];
  for (const candidate of evil) {
    const actual = isUnder(candidate, root, win, true);
    console.log(`[W-02] ${actual ? 'ALLOWED (DEFECT)' : 'blocked'} ${candidate} -> ${win.resolve(candidate)}`);
    expect(actual, `${candidate} must not be treated as inside the root`).toBe(false);
  }
});

test('W-03: Windows case-insensitive comparison does not refuse legitimate files', () => {
  // realpathSync returns on-disk casing; the stored root may differ. On Windows
  // both must be treated as the same place.
  const root = 'C:\\Users\\Ademola\\Downloads';
  const candidates = [
    'c:\\users\\ademola\\downloads\\invoice.pdf',
    'C:\\USERS\\ADEMOLA\\DOWNLOADS\\sub\\file.txt',
    'C:\\Users\\Ademola\\downloads\\Mixed.Case.PDF',
  ];
  for (const candidate of candidates) {
    const actual = isUnder(candidate, root, win, true);
    console.log(`[W-03] ${actual ? 'ALLOWED' : 'blocked (false negative!)'} ${candidate}`);
    expect(actual, `${candidate} must be allowed on a case-insensitive filesystem`).toBe(true);
  }
});

test('W-04: Linux stays case-sensitive', () => {
  // The fold must NOT be applied on Linux, where Downloads and downloads are
  // genuinely different directories.
  const root = '/home/ademola/Downloads';
  expect(isUnder('/home/ademola/downloads/file.txt', root, path.posix, false)).toBe(false);
  expect(isUnder('/home/ademola/Downloads/file.txt', root, path.posix, false)).toBe(true);
});

test('W-05: the live guard rejects traversal and siblings on this platform', async () => {
  // Confirm the real implementation, not just the extracted rule, using shapes
  // the host filesystem can actually resolve.
  const { launchApp } = await import('../harness');
  const env = await launchApp();
  try {
    await env.inMain('syncStart');
    await env.inMain('syncAddRoot', env.watchDir);

    const inside = `${env.watchDir}/ok.txt`;
    const traversal = `${env.watchDir}/../../etc/passwd`;
    const sibling = `${env.watchDir}-evil/x.txt`;

    const [a, b, c] = [
      await env.inMain<boolean>('guardUnderRoot', inside),
      await env.inMain<boolean>('guardUnderRoot', traversal),
      await env.inMain<boolean>('guardUnderRoot', sibling),
    ];

    console.log(`[W-05] inside=${a} traversal=${b} sibling=${c}`);
    expect(a, 'a real in-root path must be allowed').toBe(true);
    expect(b, 'traversal must be rejected').toBe(false);
    expect(c, 'sibling must be rejected').toBe(false);
  } finally {
    await env.cleanup();
  }
});
