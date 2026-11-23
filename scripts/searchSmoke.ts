/**
 * Verifies the search palette window: it loads, renders the input, and the
 * palette (not the main app) is what appears for the #search hash.
 */
import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';

const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${cond ? '' : ' | ' + detail}`);
  if (!cond) failures.push(name);
}

async function run(): Promise<void> {
  const win = new BrowserWindow({
    width: 680,
    height: 420,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'), { hash: 'search' });
  await new Promise((r) => setTimeout(r, 800));

  const probe = await win.webContents.executeJavaScript(`(() => ({
    hasPalette: !!document.querySelector('.palette'),
    hasInput: !!document.querySelector('.palette-input'),
    placeholder: document.querySelector('.palette-input')?.placeholder || '',
    hasFooter: !!document.querySelector('.palette-footer'),
    hasMainApp: !!document.querySelector('.app'),
    hasSignIn: !!document.querySelector('.card'),
    bodyClass: document.body.className,
  }))()`);

  check('palette rendered', probe.hasPalette);
  check('search input present', probe.hasInput);
  check('placeholder explains content search', /inside them/i.test(probe.placeholder), probe.placeholder);
  check('keyboard hints shown', probe.hasFooter);
  check('main app NOT rendered in palette window', probe.hasMainApp === false);
  check('sign-in NOT rendered in palette window', probe.hasSignIn === false);
  check('search-window body class applied', /is-search-window/.test(probe.bodyClass));

  console.log('');
  const total = 7;
  console.log(`RESULT: ${total - failures.length}/${total} passed`);
  app.exit(failures.length === 0 ? 0 : 1);
}

app.whenReady().then(run);
