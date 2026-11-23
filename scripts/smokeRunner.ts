/**
 * Smoke assertions, loaded only when TFF_SMOKE=1.
 *
 * Kept in its own module so the production main process never imports test
 * code, and so this can grow without making main.ts harder to read.
 */
import { app, BrowserWindow } from 'electron';

const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${cond ? '' : ' | ' + detail}`);
  if (!cond) failures.push(name);
}

async function run(): Promise<void> {
  const wins = BrowserWindow.getAllWindows();
  check('a window was created', wins.length > 0, `found ${wins.length}`);
  if (wins.length === 0) {
    app.exit(1);
    return;
  }

  const win = wins[0];
  const consoleErrors: string[] = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  const probe = await win.webContents.executeJavaScript(`(() => ({
    hasBridge: typeof window.tff === 'object' && window.tff !== null,
    keys: window.tff ? Object.keys(window.tff).sort() : [],
    text: (document.body.innerText || ''),
    hasRequire: typeof window.require !== 'undefined',
    hasProcess: typeof window.process !== 'undefined',
    hasCsp: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'),
  }))()`);

  check('preload bridge is exposed', probe.hasBridge);
  check('bridge exposes the full surface', probe.keys.length >= 17, probe.keys.join(','));
  check('renderer has no require', probe.hasRequire === false);
  check('renderer has no process', probe.hasProcess === false);
  check('CSP meta tag present', probe.hasCsp === true);
  check('renders the sign-in screen', /Sign in|ThinkFlyFlow/.test(probe.text), probe.text.slice(0, 80));
  check('no bridge failure screen', !/bridge is unavailable/.test(probe.text), probe.text.slice(0, 120));
  check('no console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors));

  const total = 8;
  console.log(`RESULT: ${total - failures.length}/${total} passed`);
  app.exit(failures.length === 0 ? 0 : 1);
}

void run();
