/**
 * Packaging verification.
 *
 * Catches the two failures that only show up after the app is built:
 *
 *  1. The updater feed pointing somewhere else. VoicerAI shipped with the feed
 *     pointed at the upstream repository, so every update check 404'd and failed
 *     silently. Asserting the owner/repo here means a regression fails the build
 *     instead of reaching users.
 *  2. Assets referenced at runtime but missing from the package. The tray icon
 *     is loaded from extraResources; if it is not in the bundle the tray is
 *     blank and nothing throws.
 */
const fs = require('node:fs');
const path = require('node:path');

const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${cond ? '' : ' | ' + detail}`);
  if (!cond) failures.push(name);
}

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// 1. Feed points at this project.
const publish = pkg.build?.publish?.[0] || {};
check('publish owner is this project', publish.owner === 'rilwan2003', String(publish.owner));
check('publish repo is thinkflyflow-desktop', publish.repo === 'thinkflyflow-desktop', String(publish.repo));
check('appId set', !!pkg.build?.appId, String(pkg.build?.appId));

// 2. Assets the runtime needs.
const assets = ['icon.png', 'tray.png', 'trayTemplate.png'];
for (const a of assets) {
  const p = path.join(__dirname, '..', 'assets', a);
  check(`asset present: ${a}`, fs.existsSync(p), p);
}
check(
  'icons are packaged as extraResources',
  Array.isArray(pkg.build?.extraResources) && pkg.build.extraResources.length > 0,
);

// 2b. Platform icon paths must resolve relative to buildResources.
//     electron-builder joins buildResources with the icon value, so
//     "assets/icon.png" becomes assets/assets/icon.png. Linux and Windows
//     tolerated that silently; macOS failed the whole build with
//     "not a file". Catch it here instead of in a release run.
const buildResources = pkg.build?.directories?.buildResources;
if (buildResources) {
  for (const platform of ['mac', 'win', 'linux']) {
    const icon = pkg.build?.[platform]?.icon;
    if (!icon) continue;
    const resolved = path.join(__dirname, '..', buildResources, icon);
    check(
      `${platform} icon resolves under buildResources`,
      fs.existsSync(resolved),
      `${icon} -> ${resolved}`,
    );
  }
}

// 3. Build outputs exist and are non-trivial.
const dist = path.join(__dirname, '..', 'dist', 'index.html');
check('renderer built', fs.existsSync(dist), dist);
const mainJs = path.join(__dirname, '..', 'dist-electron', 'electron', 'main.js');
check('main process built', fs.existsSync(mainJs), mainJs);
const preloadJs = path.join(__dirname, '..', 'dist-electron', 'electron', 'preload.js');
check('preload built', fs.existsSync(preloadJs), preloadJs);

// 4. The preload must not require project modules: Electron's preload context
//    cannot resolve a relative require, and the failure is silent at runtime.
//    Comments are stripped first, because the file explains this very rule and
//    would otherwise flag itself.
const preload = fs
  .readFileSync(preloadJs, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const relativeRequires = [...preload.matchAll(/require\(["'](\.\/[^"']+)["']\)/g)].map((m) => m[1]);
check('preload has no relative requires', relativeRequires.length === 0, relativeRequires.join(','));

// 5. No secrets baked into the renderer bundle.
const bundleDir = path.join(__dirname, '..', 'dist', 'assets');
let leaked = [];
if (fs.existsSync(bundleDir)) {
  for (const f of fs.readdirSync(bundleDir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(bundleDir, f), 'utf8');
    for (const pat of [/sk_live_[A-Za-z0-9]/, /ghp_[A-Za-z0-9]{20}/, /BEGIN [A-Z ]*PRIVATE KEY/]) {
      if (pat.test(src)) leaked.push(`${f}:${pat}`);
    }
  }
}
check('no secrets in renderer bundle', leaked.length === 0, leaked.join(','));

console.log('');
const total = 16;
console.log(`RESULT: ${total - failures.length}/${total} passed`);
process.exit(failures.length === 0 ? 0 : 1);
