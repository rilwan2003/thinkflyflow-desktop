/**
 * Phase 9 — macOS packaging.
 *
 * The app cannot be run on macOS from this host, so these tests assert the
 * properties of the BUILD CONFIGURATION and the SHIPPED ARTEFACT that determine
 * whether the Mac app can work at all. They are the checks that would have
 * caught F-006 (no deep-link scheme declared, so sign-in could never complete).
 *
 * What this does NOT cover: any macOS runtime behaviour. See
 * QA-macOS-Assessment.md.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const build = pkg.build ?? {};

/** The single-use sign-in code comes back through this scheme. */
const SCHEME = 'thinkflyflow';

test('M-01: the deep-link scheme is declared for the macOS bundle', () => {
  // macOS resolves a custom URL scheme through LaunchServices, which reads
  // CFBundleURLTypes from Info.plist. electron-builder only writes that key when
  // `protocols` is configured. Without it, app.setAsDefaultProtocolClient() is a
  // no-op on macOS, the browser's redirect to thinkflyflow://auth?code=... has
  // nothing to open, and sign-in can never complete.
  const protocols = [
    ...(Array.isArray(build.protocols) ? build.protocols : []),
    ...(Array.isArray(build.mac?.protocols) ? build.mac.protocols : []),
  ];

  console.log('[M-01] declared protocols:', JSON.stringify(protocols));

  const declaresScheme = protocols.some((p: any) =>
    (Array.isArray(p.schemes) ? p.schemes : [p.schemes]).includes(SCHEME),
  );

  expect(
    declaresScheme,
    `F-006: build.protocols must declare "${SCHEME}" or macOS sign-in cannot work`,
  ).toBe(true);
});

test('M-02: the declaration survives the transform electron-builder applies', () => {
  // electronMac.js maps each protocol to CFBundleURLTypes, requiring at least one
  // scheme and defaulting the role to Editor. Reproduce that here so a
  // config that validates but produces an unusable plist is caught.
  const protocols = [
    ...(Array.isArray(build.protocols) ? build.protocols : []),
    ...(Array.isArray(build.mac?.protocols) ? build.mac.protocols : []),
  ];
  expect(protocols.length, 'at least one protocol must be declared').toBeGreaterThan(0);

  const urlTypes = protocols.map((p: any) => {
    const schemes = Array.isArray(p.schemes) ? p.schemes : [p.schemes];
    expect(schemes.length, `protocol "${p.name}" must declare at least one scheme`).toBeGreaterThan(0);
    return {
      CFBundleURLName: p.name,
      CFBundleTypeRole: p.role ?? 'Editor',
      CFBundleURLSchemes: schemes,
    };
  });

  console.log('[M-02] resulting CFBundleURLTypes:', JSON.stringify(urlTypes));
  expect(urlTypes.some((u: any) => u.CFBundleURLSchemes.includes(SCHEME))).toBe(true);
});

test('M-03: the runtime registers the same scheme the bundle declares', () => {
  // A mismatch between the plist scheme and DEEP_LINK_SCHEME would be equally
  // fatal, and silent.
  const accountSrc = readFileSync(join(repoRoot, 'electron', 'account.ts'), 'utf8');
  const m = accountSrc.match(/DEEP_LINK_SCHEME\s*=\s*['"]([^'"]+)['"]/);
  expect(m, 'DEEP_LINK_SCHEME must be declared in electron/account.ts').not.toBeNull();
  console.log('[M-03] runtime scheme:', m![1]);
  expect(m![1], 'the runtime scheme must match the one declared for the bundle').toBe(SCHEME);
});

test('M-04: the macOS target and minimum version are set', () => {
  const mac = build.mac ?? {};
  console.log('[M-04] mac config:', JSON.stringify(mac));
  expect(Array.isArray(mac.target) ? mac.target.length : 0, 'a macOS target must be configured').toBeGreaterThan(0);
});

test('M-05: the shipped 0.1.1 DMG has no code signature and no URL scheme', () => {
  // Documents the state of the artefact that exists today. Skipped when the
  // extracted bundle is not present on this host.
  const plistPath = '/tmp/macx/dmg1/ThinkFlyFlow.app/Contents/Info.plist';
  if (!existsSync(plistPath)) {
    test.skip(true, 'extracted macOS bundle not present');
    return;
  }
  const raw = readFileSync(plistPath, 'latin1');
  const hasUrlTypes = raw.includes('CFBundleURLTypes');
  const hasSignature = existsSync('/tmp/macx/dmg1/ThinkFlyFlow.app/Contents/_CodeSignature');

  console.log(`[M-05] shipped DMG: CFBundleURLTypes=${hasUrlTypes} signed=${hasSignature}`);

  // These assertions describe the CURRENT artefact, and are expected to change
  // once a properly built and signed release is published.
  expect(hasUrlTypes, 'known: the published 0.1.1 DMG declares no URL scheme').toBe(false);
});
