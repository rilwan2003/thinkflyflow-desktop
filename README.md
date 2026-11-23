# ThinkFlyFlow Desktop

Keeps the files on your computer and your ThinkFlyFlow workspace in sync, so
your documents organise themselves instead of being uploaded by hand.

Sign in once, choose a folder, and anything that lands in it is filed in the AI
workspace within seconds. Press `Ctrl+Shift+F` anywhere to find a document by
what is inside it, not just by its filename.

- **Watches the folders where work actually arrives** (Downloads, Desktop, a client folder)
- **Never uploads a file twice**, using a content hash rather than a filename
- **Finds files by content or name**, from any application
- **Never deletes from your workspace** when you delete a local file

## What it deliberately does not do

Stated plainly so nobody is misled by a marketing line:

- **Not an offline mode.** The AI categorisation and search run on ThinkFlyFlow's
  servers. Files you have not synced stay local and are marked as such.
- **Not team collaboration.** That lives in the web app.
- **No enterprise features.** No SSO, no on-premise, no data residency options.

## Requirements

- ThinkFlyFlow account
- Windows 10 or later, macOS 12 or later, or Linux (AppImage)
- Node 22 or later, for development only

> **If Electron does not run after `npm install`:** on some machines the Electron
> postinstall silently fails to download its binary, leaving a stub. The symptom
> is `node_modules/electron/dist/` containing only `locales/`, or
> `electron --version` erroring. Fix it by fetching the zip directly:
>
> ```bash
> cd node_modules/electron && rm -rf dist && mkdir dist && cd dist
> # use the version from node_modules/electron/package.json
> curl -fL -o /tmp/electron.zip \
>   https://github.com/electron/electron/releases/download/v38.8.6/electron-v38.8.6-linux-x64.zip
> unzip -q /tmp/electron.zip && chmod +x electron
> ```

## Install

Download the installer for your platform from the releases page. Windows and
macOS builds are signed; if you are offered an unsigned build, verify the source
before installing.

## How syncing works

1. **You pick a folder.** Nothing is watched without an explicit choice.
2. **New and changed files are hashed** locally.
3. **The server is asked whether it already has that content.** If it does, the
   upload is skipped entirely and the file keeps its place in the workspace.
4. **Otherwise the file uploads** and is filed by the AI exactly as a web upload
   would be.
5. **A local delete removes only the local copy.** Deleting from the workspace is
   never inferred from a local delete.

Files that never leave this machine are indexed locally, so search still finds
them, and they are labelled `This Mac` in the palette.

## Privacy

- Your password is used once, at sign-in, to issue a workspace-scoped API key. It
  is never stored.
- The key is held in the operating system's credential store (Keychain on macOS,
  DPAPI on Windows). If the system has no secure store, the app refuses to save
  the key and asks you to sign in each launch, rather than writing it in plain
  text.
- The renderer process has no filesystem, no Node access, and a strict content
  security policy. It can only call the small explicit list of operations in
  `electron/preload.ts`.
- Your API key can be revoked at any time from the ThinkFlyFlow web app.

## Development

Requires Node 22 or later (Electron 38 bundles Node 22; `node:sqlite` is only
available from Electron 38 onward).

```bash
npm install
npm run typecheck     # renderer + main process
npm test              # engine and index unit tests
npm run build         # renderer bundle + main process
npm start             # run against the built files (no dev server)
npm run dev           # Vite dev server for the renderer only
npm run dev:app       # main process pointed at the running Vite server
```

For hot-reload development, run `npm run dev` in one terminal and
`npm run dev:app` in another. Loading from the dev server is opt-in via
`TFF_DEV_SERVER=1`, so a plain `npm start` always uses the built files and never
hangs waiting for a server that is not running.

### Verification

```bash
npm run verify
```

Runs, in order: unit tests, a headless smoke test of the real main process, a
smoke test of the search palette window, and the packaging gate. All four must
pass. The smoke tests need a display; on a headless machine they run under
`xvfb-run`, which `npm run smoke` already does.

There is also a live end-to-end check that talks to the test environment:

```bash
API_KEY=<workspace api key> node live_sync_test.js
```

### Packaging

```bash
npm run dist          # installers for the current platform
npx electron-builder --linux AppImage
```

Artifacts land in `release/`.

## Releasing

1. Bump `version` in `package.json`.
2. Commit, then tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. The Release workflow builds all three platforms and publishes them.

`vX.Y.Z` is stable and becomes the updater's `latest`. `vX.Y.Z-beta.N` is a
prerelease and never becomes `latest`, so beta users get beta updates and stable
users do not. Any other tag shape is rejected by the workflow, because the
updater derives its channel from the version string.

The workflow refuses to publish unsigned installers unless
`allow_unsigned` is explicitly set on a manual run.

### Signing

Windows signing uses SignPath, as VoicerAI does. macOS signing needs
`CSC_LINK`, `CSC_KEY_PASSWORD`, and the three `APPLE_*` notarisation secrets.
Without them the build still completes but produces unsigned installers, which
Windows SmartScreen and macOS Gatekeeper will warn about.

## Architecture

```
electron/
  main.ts          window + tray + IPC handlers, owns the engine and the key
  preload.ts       the entire renderer→main surface; a fixed function list
  ipc.ts           shared channel contract, so both sides agree at compile time
  syncIndex.ts     SQLite index of what has been synced (node:sqlite)
  syncEngine.ts    folder watching, hashing, deduplication, upload
  apiClient.ts     ThinkFlyFlow REST client
  credentials.ts   OS keychain storage for the API key
  searchWindow.ts  the global-hotkey palette window
  updater.ts       auto-update, feed pinned to this repository
src/               React renderer (sign-in, dashboard, search palette)
scripts/           smoke tests, packaging gate, live checks
```

Two design decisions worth knowing before changing anything:

- **The preload cannot `require('./relative')`.** Electron's preload context
  fails to resolve project modules, and the failure is silent. Channel names are
  therefore duplicated in `preload.ts`, and `scripts/packageCheck.js` fails the
  build if a relative require reappears.
- **`node:sqlite`, not `better-sqlite3`.** The native module does not compile
  against recent V8 and would need rebuilding for every Electron upgrade.

## Licence

Proprietary. All rights reserved. Not for redistribution or modification without
permission. This differs from VoicerAI, which is AGPL-3.0 because it is a fork of
an existing open-source project; this app is original work.
