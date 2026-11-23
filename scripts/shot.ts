import { app, BrowserWindow } from 'electron';
import * as fs from 'node:fs';

async function run(): Promise<void> {
  await new Promise((r) => setTimeout(r, 2500));
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { app.exit(1); return; }
  const img = await win.webContents.capturePage();
  fs.writeFileSync('/tmp/tff-signin.png', img.toPNG());

  // Verify the design tokens actually applied to real elements, rather than
  // trusting that the screenshot looks right.
  const styles = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.card');
    const btn = document.querySelector('button[type=submit]');
    const body = getComputedStyle(document.body);
    const cs = card ? getComputedStyle(card) : null;
    const bs = btn ? getComputedStyle(btn) : null;
    return {
      pageBg: body.backgroundColor,
      font: body.fontFamily.split(',')[0],
      cardRadius: cs ? cs.borderRadius : null,
      cardBg: cs ? cs.backgroundColor : null,
      cardShadow: cs ? cs.boxShadow : null,
      btnRadius: bs ? bs.borderRadius : null,
      cardWidth: card ? Math.round(card.getBoundingClientRect().width) : null,
      inputs: document.querySelectorAll('input').length,
      buttons: document.querySelectorAll('button').length,
    };
  })()`);
  console.log('STYLES ' + JSON.stringify(styles));
  app.exit(0);
}
void run();
