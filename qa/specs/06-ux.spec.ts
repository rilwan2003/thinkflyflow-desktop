/**
 * Phase 6 — UX, accessibility and resilience.
 *
 * These tests assert the behaviour a keyboard user, a screen-reader user and a
 * small-screen user actually get. Where the app falls short the test asserts
 * the CORRECT behaviour and reports the defect, rather than being softened to
 * match what the app happens to do.
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

/** WCAG 2.1 relative luminance for a composited rgb triple (0-255). */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Parse "rgb(a, b, c)" / "rgba(...)" into a triple, ignoring alpha. */
function parseRgb(value: string): [number, number, number] | null {
  const m = value.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return [parts[0], parts[1], parts[2]];
}

/**
 * oklch() -> sRGB. The app's whole palette is oklch, so a test that can only
 * read rgb() would silently measure nothing. Converts via OKLab -> linear sRGB
 * -> gamma-encoded sRGB, then scales to 0-255.
 */
function parseOklch(value: string): [number, number, number] | null {
  const m = value.match(/oklch\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].trim().split(/[\s/]+/);
  const L = parseFloat(parts[0]);
  const C = parseFloat(parts[1]);
  const H = parseFloat(parts[2]);
  if ([L, C, H].some((n) => Number.isNaN(n))) return null;

  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const mm = m_ ** 3;
  const s = s_ ** 3;

  const lr = +4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s;

  const enc = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };

  return [enc(lr), enc(lg), enc(lb)];
}

/** Read either colour notation the app might use. */
function parseColor(value: string): [number, number, number] | null {
  return parseRgb(value) ?? parseOklch(value);
}

test('U-01: every interactive control is reachable by keyboard', async () => {
  const { window } = env;

  // Enumerate the controls the renderer actually exposes.
  const controls = await window.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll('button, input, select, a[href], [tabindex]'),
    ) as HTMLElement[];
    return els
      .filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? '').trim().slice(0, 40),
        tabIndex: el.tabIndex,
      }));
  });

  console.log('[U-01] interactive controls:', JSON.stringify(controls));
  expect(controls.length, 'the signed-out screen should offer at least one control').toBeGreaterThan(0);

  // Nothing may be removed from the tab order while still visible.
  const unreachable = controls.filter((c) => c.tabIndex < 0);
  expect(unreachable, `controls unreachable by Tab: ${JSON.stringify(unreachable)}`).toHaveLength(0);

  // Prove focus actually moves with the keyboard.
  await window.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await window.keyboard.press('Tab');
  const afterTab = await window.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el ? { tag: el.tagName.toLowerCase(), text: (el.textContent ?? '').trim().slice(0, 40) } : null;
  });
  console.log('[U-01] first Tab lands on:', JSON.stringify(afterTab));
  expect(afterTab, 'Tab must move focus into the app').not.toBeNull();
  expect(afterTab!.tag).not.toBe('body');
});

test('U-02: focused controls show a visible focus indicator', async () => {
  const { window } = env;

  /** Collect focus-indicator state for every visible control on the page. */
  const auditFocus = async () =>
    window.evaluate(() => {
      const out: { tag: string; text: string; outline: string; boxShadow: string; visible: boolean }[] = [];
      const els = Array.from(document.querySelectorAll('button, input, select')) as HTMLElement[];

      for (const el of els) {
        if ((el as HTMLButtonElement).disabled) continue;
        if (el.offsetParent === null) continue;
        el.focus();
        const cs = getComputedStyle(el);
        const outlineWidth = parseFloat(cs.outlineWidth || '0');
        const hasOutline = cs.outlineStyle !== 'none' && outlineWidth > 0;
        const hasShadow = Boolean(cs.boxShadow && cs.boxShadow !== 'none');
        out.push({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? '').trim().slice(0, 30) || el.getAttribute('placeholder') || '',
          outline: `${cs.outlineStyle} ${cs.outlineWidth}`,
          boxShadow: cs.boxShadow,
          visible: Boolean(hasOutline || hasShadow),
        });
      }
      return out;
    });

  // The signed-out screen first.
  const signedOut = await auditFocus();
  for (const r of signedOut) console.log(`[U-02] (signed out) ${r.tag} "${r.text}": ${r.visible} (outline=${r.outline})`);

  // Then the dashboard, which is where the app's own CSS applies. Get there by
  // mounting the window's React view directly rather than performing a real
  // sign-in, since only the DOM matters for this check.
  await window.evaluate(async () => {
    // Ask the main process for a signed-in status snapshot, then let the app
    // re-render by triggering its status event.
    await (window as any).tff.qa('forceSignedInView');
  });
  await window.waitForTimeout(600);

  const dashboard = await auditFocus();
  for (const r of dashboard) console.log(`[U-02] (dashboard) ${r.tag} "${r.text}": ${r.visible} (outline=${r.outline})`);

  const all = [...signedOut, ...dashboard];
  const invisible = all.filter((r) => !r.visible);
  if (invisible.length > 0) {
    console.warn(
      `[U-02] DEFECT F-004: ${invisible.length} control(s) have no visible focus indicator: ` +
        invisible.map((i) => `${i.tag} "${i.text}"`).join(', '),
    );
  }

  expect(all.length, 'controls must be audited on at least one screen').toBeGreaterThan(0);
  expect(invisible, `F-004: controls without a focus indicator: ${JSON.stringify(invisible)}`).toHaveLength(0);
});

test('U-03: every interactive control has an accessible name', async () => {
  // Must audit the dashboard, not just the signed-out card: the dashboard holds
  // the controls a screen-reader user spends their time in.
  await env.window.evaluate(async () => {
    await (window as any).tff.qa('forceSignedInView');
  });
  await env.window.waitForTimeout(600);

  const cdp = await env.window.context().newCDPSession(env.window);
  await cdp.send('Accessibility.enable');
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as any;

  const interactiveRoles = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'checkbox',
    'combobox',
    'listbox',
    'menuitem',
    'tab',
    'switch',
    'radio',
  ]);

  const controls = nodes
    .filter((n: any) => !n.ignored && interactiveRoles.has(n.role?.value))
    .map((n: any) => ({
      role: n.role?.value,
      name: n.name?.value ?? '',
    }));

  console.log(`[U-03] interactive AX nodes on the dashboard: ${controls.length}`);
  for (const c of controls) console.log(`[U-03]   ${c.role}: "${c.name}"`);

  const unnamed = controls.filter((c: any) => !c.name || !String(c.name).trim());
  if (unnamed.length > 0) {
    console.warn(`[U-03] DEFECT F-005: ${unnamed.length} control(s) have no accessible name: ${JSON.stringify(unnamed)}`);
  }

  await cdp.detach();
  expect(controls.length, 'the dashboard should expose several interactive controls').toBeGreaterThan(3);
  expect(unnamed, `F-005: unnamed controls: ${JSON.stringify(unnamed)}`).toHaveLength(0);
});

test('U-04: primary text and status pill meet WCAG AA contrast', async () => {
  const { window } = env;

  const samples = await window.evaluate(() => {
    const root = getComputedStyle(document.documentElement);

    // Resolve a CSS variable into a computed colour by using a probe element.
    const probe = document.createElement('div');
    document.body.appendChild(probe);

    const resolve = (cssVar: string): string => {
      probe.style.color = `var(${cssVar})`;
      return getComputedStyle(probe).color;
    };

    const results: { label: string; fg: string; bg: string }[] = [];

    // Body text.
    results.push({
      label: 'body text',
      fg: getComputedStyle(document.body).color,
      bg: getComputedStyle(document.body).backgroundColor || resolve('--background'),
    });

    // Muted secondary text, which is the riskiest for contrast.
    results.push({
      label: 'muted text',
      fg: resolve('--muted-foreground'),
      bg: resolve('--card'),
    });

    // The status pill in its base state.
    const pill = document.querySelector('.pill') as HTMLElement | null;
    if (pill) {
      const cs = getComputedStyle(pill);
      results.push({ label: 'status pill', fg: cs.color, bg: cs.backgroundColor });
    }

    probe.remove();
    return results;
  });

  let failures = 0;
  let measured = 0;
  for (const s of samples) {
    const fg = parseColor(s.fg);
    const bg = parseColor(s.bg);
    if (!fg || !bg) {
      console.log(`[U-04] ${s.label}: could not parse (fg=${s.fg}, bg=${s.bg})`);
      failures++;
      continue;
    }
    measured++;
    const ratio = contrastRatio(fg, bg);
    const pass = ratio >= 4.5;
    if (!pass) failures++;
    console.log(`[U-04] ${s.label}: ${ratio.toFixed(2)}:1 ${pass ? 'PASS' : 'FAIL (< 4.5:1)'}`);
  }

  // A test that measures nothing must not report a pass.
  expect(measured, 'every colour sample must be measurable').toBeGreaterThanOrEqual(2);
  expect(failures, 'all sampled text must meet at least 4.5:1').toBe(0);
});

test('U-05: no horizontal overflow at 800x600 or maximised', async () => {
  const { window } = env;

  for (const [w, h] of [
    [800, 600],
    [1920, 1080],
  ]) {
    await env.app.evaluate(async ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.setSize(size[0], size[1]);
    }, [w, h]);
    await window.waitForTimeout(400);

    const metrics = await window.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      innerWidth: window.innerWidth,
    }));

    console.log(`[U-05] ${w}x${h}:`, JSON.stringify(metrics));
    // A couple of pixels of rounding is tolerable; real overflow is not.
    expect(
      metrics.scrollWidth,
      `horizontal overflow at ${w}x${h}: scrollWidth ${metrics.scrollWidth} > clientWidth ${metrics.clientWidth}`,
    ).toBeLessThanOrEqual(metrics.clientWidth + 2);
  }
});

test('U-06: a failed sign-in surfaces a readable error, not a raw exception', async () => {
  // Drive the real path: start sign-in, then deliver a deep link whose code the
  // backend rejects. That exercises completeSignIn's error branch, which is the
  // one a user actually hits when a sign-in link is stale or forged.
  env.backend.rejectAuth = true;
  try {
    const outcome = await env.window.evaluate(async () => {
      const tff = (window as any).tff;
      // Start the flow but do not await it to completion here: the rejection
      // arrives through the deep link below.
      const pending = tff.signIn().catch((err: any) => ({ threw: true, error: String(err?.message ?? err) }));
      // Give the main process a moment to register the pending attempt.
      await new Promise((r) => setTimeout(r, 500));
      return await Promise.race([
        pending,
        (async () => {
          // Deliver a rejected code the way the OS would.
          await tff.qa('deliverDeepLink', 'thinkflyflow://auth?code=***');
          return await pending;
        })(),
      ]);
    });

    console.log('[U-06] sign-in outcome with a rejected code:', JSON.stringify(outcome));

    const text = JSON.stringify(outcome);
    // Must not leak internals or degenerate strings to the user.
    expect(text).not.toMatch(/at\s+\w+\s+\(.*:\d+:\d+\)/);
    expect(text).not.toContain('[object Object]');
    expect(text.toLowerCase()).not.toContain('undefined');

    // And it must say something a person can act on.
    const message = String(((outcome as any).error ?? '') || '').trim();
    if (message) {
      console.log('[U-06] user-facing message:', message);
      expect(message.length, 'an error message must not be empty').toBeGreaterThan(3);
    }
  } finally {
    env.backend.rejectAuth = false;
  }
});

test('U-07: the signed-out screen states what the app needs from the user', async () => {
  const body = (await env.window.textContent('body')) ?? '';
  console.log('[U-07] signed-out copy:', body.trim().slice(0, 240).replace(/\s+/g, ' '));

  // A person who has never seen this app should know it needs a sign-in.
  expect(body.toLowerCase()).toMatch(/sign in|sign-in|continue/);
});
