/**
 * Electron main process.
 *
 * Responsibilities, in order of importance:
 *   1. Own the sync engine and the credential. The renderer never sees the key.
 *   2. Keep a tray icon so sync status is visible without a window.
 *   3. Bridge a small, explicit IPC surface. No remote module, no node
 *      integration in the renderer, contextIsolation on.
 */
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ApiClient, createApiKey, fetchWorkspacesForSignIn } from './apiClient';
import {
  AccountStore,
  cancelPendingSignIn,
  completeSignIn,
  findDeepLink,
  getApiBase,
  getWebOrigin,
  handleDeepLink,
  isSecureStorageAvailable,
  openSignIn,
  parseAuthDeepLink,
  registerProtocol,
  resolveAccountEnvironment,
  sessionPath,
  signInUrl,
  exchangeCode,
  verifySession,
} from './account';
import { IPC, type ProjectOption, type SearchHit, type SignInResult, type StatusSnapshot, type WatchedRoot } from './ipc';
import { SyncEngine, type SyncStatus } from './syncEngine';
import { SyncIndex } from './syncIndex';
import { hideSearchWindow, isSearchWindowVisible, isSearchWindowOpen, toggleSearchWindow } from './searchWindow';
import { initAutoUpdate } from './updater';

// Dev-server mode is opt-in, not the default for any unpackaged run.
// `npm start` runs unpackaged but should load the built files; only `npm run
// dev:app` wants the Vite server. Keying this off `!app.isPackaged` alone made
// every local start try to reach a server that was not running.
const useDevServer = process.env.TFF_DEV_SERVER === '1' && !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let accountStore: AccountStore | null = null;

function store(): AccountStore {
  if (!accountStore) accountStore = new AccountStore(sessionPath());
  return accountStore;
}

function accountApiBase(): string {
  return getApiBase();
}

let index: SyncIndex | null = null;
let engine: SyncEngine | null = null;
let api: ApiClient | null = null;
let workspaceName: string | null = null;
let workspaceId: string | null = null;
let lastProgress: { done: number; total: number } | null = null;
let lastDetail: string | undefined;

// A second instance would double-watch every folder and fight over the same
// SQLite file, so hand off to the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows and Linux hand a deep link to the ALREADY RUNNING instance through
  // argv on this event, so the sign-in callback must be read here too, not only
  // at launch.
  app.on('second-instance', (_event, argv) => {
    const link = findDeepLink(argv);
    if (link) void handleDeepLink(link);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function dbPath(): string {
  return path.join(app.getPath('userData'), 'sync-index.db');
}

function ensureIndex(): SyncIndex {
  if (!index) index = new SyncIndex(dbPath());
  return index;
}

function snapshot(): StatusSnapshot {
  const idx = ensureIndex();
  return {
    status: engine?.getStatus() ?? 'idle',
    detail: lastDetail,
    signedIn: api !== null,
    workspaceName,
    workspaceId,
    counts: idx.counts(),
    roots: idx.getRoots().map(({ id, path: p, projectId, enabled }): WatchedRoot => ({
      id,
      path: p,
      projectId,
      enabled,
    })),
    progress: lastProgress,
  };
}

function broadcast(): void {
  const snap = snapshot();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.statusChanged, snap);
  }
  updateTray(snap);
}

function updateTray(snap: StatusSnapshot): void {
  if (!tray) return;
  const base = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const iconPath = path.join(__dirname, '..', '..', 'assets', base);
  // Icon assets may not exist in a dev checkout; fall back to an empty image so
  // the tray still appears rather than the whole process throwing.
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray.setImage(icon);

  const label =
    snap.status === 'syncing'
      ? 'Syncing...'
      : snap.status === 'paused'
        ? 'Sync paused'
        : snap.status === 'error'
          ? 'Sync error'
          : 'ThinkFlyFlow';
  tray.setToolTip(`ThinkFlyFlow: ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `${snap.counts.synced} files synced`, enabled: false },
      ...(snap.counts.failed > 0 ? [{ label: `${snap.counts.failed} failed`, enabled: false }] : []),
      { type: 'separator' },
      { label: 'Search files...', accelerator: 'Ctrl+Shift+F', click: () => toggleSearchWindow() },
      { label: 'Open ThinkFlyFlow', click: () => showWindow() },
      {
        label: snap.status === 'paused' ? 'Resume sync' : 'Pause sync',
        click: () => {
          if (!engine) return;
          if (engine.getStatus() === 'paused') engine.resume();
          else engine.pause();
          broadcast();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function showWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow();
}

async function startEngine(): Promise<void> {
  if (!api) return;
  const idx = ensureIndex();
  engine = new SyncEngine(
    idx,
    api,
    {
      onStatus: (status: SyncStatus, detail?: string) => {
        lastDetail = detail;
        broadcast();
      },
      onProgress: (done, total) => {
        lastProgress = { done, total };
        broadcast();
      },
      onFileSynced: () => broadcast(),
      onFileFailed: () => broadcast(),
    },
  );
  await engine.start();
  broadcast();
}

async function stopEngine(): Promise<void> {
  if (engine) {
    await engine.stop();
    engine = null;
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 640,
    minHeight: 520,
    show: false,
    title: 'ThinkFlyFlow',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // External links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (useDevServer) {
    void mainWindow.loadURL('http://localhost:5173');
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  // Sign-in happens in the browser and comes back over a deep link. There is no
  // email/password pair and no server field: the deployment is pinned in code.
  ipcMain.handle(IPC.signIn, async (): Promise<SignInResult> => {
    try {
      const outcome = await openSignIn();
      workspaceName = outcome.workspaceName;
      workspaceId = outcome.workspaceId;

      store().save({
        apiKey: outcome.apiKey,
        profile: outcome.profile,
        workspaceId: outcome.workspaceId,
        workspaceName: outcome.workspaceName,
        signedInAt: Date.now(),
      });

      api = new ApiClient({ baseUrl: accountApiBase(), apiKey: outcome.apiKey });
      await startEngine();
      return { ok: true, workspaceName: outcome.workspaceName };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Cancel a sign-in the user abandoned, so the UI is not left waiting.
  ipcMain.handle(IPC.cancelSignIn, async () => {
    cancelPendingSignIn();
  });

  ipcMain.handle(IPC.signOut, async () => {
    await stopEngine();
    store().clear();
    api = null;
    workspaceName = null;
    workspaceId = null;
    lastProgress = null;
    broadcast();
  });

  ipcMain.handle(IPC.listProjects, async (): Promise<ProjectOption[]> => {
    if (!api) return [];
    // Use the id held by the session, never one supplied by the renderer.
    if (!workspaceId) {
      throw new Error('No workspace is available for this session. Sign in again.');
    }
    let projects = await api.listProjects(workspaceId);

    // Half of all workspaces have no project yet, and the app cannot sync into
    // nothing. Rather than dead-ending with an empty list, create the default
    // one the web app would have created. This only ever happens once per
    // workspace, and it is what makes the first run of the app work.
    if (projects.length === 0) {
      try {
        const created = await api.createProject(workspaceId, 'My Files');
        projects = [created];
        lastDetail = 'Created a "My Files" project so syncing can start.';
        broadcast();
      } catch (err) {
        throw new Error(
          'This workspace has no projects and one could not be created. ' +
            (err instanceof Error ? err.message : 'Create a project on the ThinkFlyFlow website, then try again.'),
        );
      }
    }

    return projects.map((p) => ({ id: String(p.id), name: p.name }));
  });

  ipcMain.handle(IPC.getStatus, async () => snapshot());

  ipcMain.handle(IPC.pickFolder, async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose a folder to sync',
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle(IPC.addRoot, async (_e, folderPath: string, projectId: string) => {
    const idx = ensureIndex();
    const id = Buffer.from(folderPath).toString('base64url').slice(0, 24);
    idx.addRoot({ id, path: folderPath, projectId, enabled: true });
    if (engine) await engine.watchRoot({ id, path: folderPath, projectId, enabled: true });
    broadcast();
    return snapshot().roots;
  });

  ipcMain.handle(IPC.removeRoot, async (_e, rootId: string) => {
    if (engine) await engine.unwatchRoot(rootId);
    ensureIndex().removeRoot(rootId);
    broadcast();
    return snapshot().roots;
  });

  ipcMain.handle(IPC.pauseSync, async () => {
    engine?.pause();
    broadcast();
  });

  ipcMain.handle(IPC.resumeSync, async () => {
    engine?.resume();
    broadcast();
  });

  ipcMain.handle(IPC.openFile, async (_e, localPath: string) => {
    // Only ever open a path the user has watched; never an arbitrary string
    // arriving from the renderer.
    if (!isUnderWatchedRoot(localPath)) return;
    await shell.openPath(localPath);
  });

  ipcMain.handle(IPC.revealFile, async (_e, localPath: string) => {
    if (!isUnderWatchedRoot(localPath) || !fs.existsSync(localPath)) return;
    shell.showItemInFolder(localPath);
  });

  ipcMain.handle(IPC.search, async (_e, query: string) => {
    if (!api || !query.trim()) return [];
    const res = await api.search(query.trim());
    const hits: SearchHit[] = [];

    for (const f of res.files ?? []) {
      hits.push({
        id: f.id,
        name: f.name,
        kind: 'file',
        matchedOn: f.matched_on,
        context: [f.project_name, f.folder_path, f.size_display].filter(Boolean).join(' · '),
        snippet: f.snippet,
        fileType: f.file_type,
      });
    }
    for (const f of res.folders ?? []) {
      hits.push({
        id: f.id,
        name: f.name,
        kind: 'folder',
        context: [f.project_name, f.path].filter(Boolean).join(' · '),
      });
    }
    for (const p of res.projects ?? []) {
      hits.push({
        id: p.id,
        name: p.name,
        kind: 'project',
        context: [p.workspace_name, p.file_count != null ? `${p.file_count} files` : null]
          .filter(Boolean)
          .join(' · '),
      });
    }
    return hits;
  });

  // Files this machine has synced, matched on the local path. Deliberately a
  // filter over the local index rather than a filesystem walk: it is instant,
  // it cannot hang on a huge disk, and it only ever returns files the user
  // chose to watch.
  ipcMain.handle(IPC.localFiles, async (_e, query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return ensureIndex()
      .allFiles()
      .filter((f) => f.path.toLowerCase().includes(q))
      .slice(0, 20)
      .map((f) => ({
        localPath: f.path,
        size: f.size,
        state: f.state,
        exists: fs.existsSync(f.path),
      }));
  });

  ipcMain.handle(IPC.hideSearchWindow, async () => {
    hideSearchWindow();
  });

  ipcMain.handle(IPC.recentActivity, async (_e, limit = 20) => {
    const idx = ensureIndex();
    return idx
      .getUnsyncedFiles()
      .slice(0, limit)
      .map((f) => ({ localPath: f.path, remoteId: f.remoteId ?? '', at: f.updatedAt }));
  });

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (isAllowedExternalUrl(url)) await shell.openExternal(url);
  });
}

/**
 * Only https:// may be handed to the OS. Blocks file://, javascript:, ms-msdt:
 * and every other scheme that can escalate into local code execution.
 */
function isAllowedExternalUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}



/**
 * Resolve a path to its real location, tolerating a final component that does
 * not exist yet.
 *
 * realpathSync throws for a missing file, and the guard must not refuse a
 * legitimate in-root path merely because the file was deleted between the
 * search result being rendered and the user clicking it. So when the full path
 * cannot be resolved, resolve its parent and re-join the name. A traversal
 * vanishes at this point either way, because the parent is resolved first.
 */
function realResolve(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    const parent = path.dirname(abs);
    const name = path.basename(abs);
    if (parent === abs) throw new Error('cannot resolve');
    // Resolving the parent collapses any ../ that reached this level.
    return path.join(fs.realpathSync.native(parent), name);
  }
}

function isUnderWatchedRoot(p: string): boolean {
  if (typeof p !== 'string' || !p) return false;

  // Windows and macOS filesystems are case-insensitive, and realpathSync
  // returns the ON-DISK casing while the stored root may have been entered with
  // different case. A case-sensitive compare would therefore refuse to open a
  // perfectly legitimate file. Linux is case-sensitive, so folding is only
  // applied where the platform does it.
  const fold = (s: string): string => (process.platform === 'linux' ? s : s.toLowerCase());

  try {
    // A bare startsWith is a prefix match, not a containment check. It let two
    // things through that must never be opened or revealed:
    //   /watched-evil/x             (sibling whose name shares the prefix)
    //   /watched/../../etc/passwd   (traversal out of the root)
    //   C:\Downloads-evil\x         the same on Windows
    //   C:\Downloads\..\..\Windows\System32\config\SAM   which is far worse
    // Resolve both sides, then compare with a trailing separator so only genuine
    // descendants match. Resolving also folds symlinks and junctions, so a link
    // inside the root cannot point the handler outside it.
    const resolved = fold(realResolve(p));

    return ensureIndex()
      .getRoots()
      .filter((r) => r.enabled)
      .some((r) => {
        let root: string;
        try {
          root = fold(realResolve(r.path));
        } catch {
          // The root itself no longer resolves (deleted, or an unmounted drive).
          // Fall back to the lexical path so a valid descendant is not refused
          // merely because the root is missing. The separator rule still applies.
          root = fold(path.resolve(r.path));
        }
        if (resolved === root) return true;
        const sep = path.sep.toLowerCase();
        const withSep = root.endsWith(sep) ? root : root + sep;
        return resolved.startsWith(withSep);
      });
  } catch {
    // A path that cannot be resolved at all is not trusted.
    return false;
  }
}

// Pinned deployment + deep-link scheme must both be set up before the app is
// ready: the protocol client registration only takes effect from launch.
resolveAccountEnvironment();
registerProtocol();

/**
 * QA bridge. The Playwright harness evaluates code inside the main process but
 * has no module loader there, so internal functions cannot be reached directly.
 * This exposes a narrow, read-mostly view of them for tests.
 *
 * Gated on TFF_QA_BRIDGE=1 AND an unpackaged build: a released binary is not
 * affected, and nothing here can reach the filesystem or the stored credential.
 */
if (process.env.TFF_QA_BRIDGE === '1' && !app.isPackaged) {
  ipcMain.handle('tff-qa:evaluate', async (_e, op: string, arg?: unknown) => {
    switch (op) {
      case 'signInUrl':
        return signInUrl();
      case 'parseDeepLink':
        return parseAuthDeepLink(String(arg ?? ''));
      case 'apiBase':
        return getApiBase();
      case 'webOrigin':
        return getWebOrigin();
      case 'secureStorage':
        return isSecureStorageAvailable();
      case 'exchangeCode':
        try {
          return { ok: true, value: await exchangeCode(String(arg ?? '')) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      case 'status':
        return snapshot();

      // --- sync engine -----------------------------------------------------
      // Drives the real SyncEngine and SyncIndex against the fake backend, so
      // tests exercise production code rather than a stand-in.
      case 'syncStart': {
        const idx = ensureIndex();
        const base = (process.env.TFF_TEST_API_BASE ?? '').replace(/\/api\/v\d+$/, '');
        const client = new ApiClient({
          baseUrl: base || getApiBase(),
          apiKey: 'qa-key',
        });
        api = client;
        await startEngine();
        return { ok: true };
      }
      case 'syncAddRoot': {
        const p = String(arg ?? '');
        const idx = ensureIndex();
        const id = Buffer.from(p).toString('base64url').slice(0, 24);
        idx.addRoot({ id, path: p, projectId: 'fake-proj-1', enabled: true });
        if (engine) await engine.watchRoot({ id, path: p, projectId: 'fake-proj-1', enabled: true });
        return { ok: true, id };
      }
      case 'syncRemoveRoot': {
        if (engine) await engine.unwatchRoot(String(arg ?? ''));
        ensureIndex().removeRoot(String(arg ?? ''));
        return { ok: true };
      }
      case 'syncPause':
        engine?.pause();
        return { ok: true };
      case 'syncResume':
        engine?.resume();
        return { ok: true };
      case 'syncStop':
        await stopEngine();
        return { ok: true };
      case 'syncCounts':
        return ensureIndex().counts();
      case 'syncFile': {
        const f = ensureIndex().getFile(String(arg ?? ''));
        return f ? { ...f } : null;
      }
      case 'syncStatus':
        return engine?.getStatus() ?? 'idle';

      // --- search ----------------------------------------------------------
      case 'searchLocal':
        return ensureIndex()
          .allFiles()
          .filter((f) => f.path.toLowerCase().includes(String(arg ?? '').toLowerCase()))
          .slice(0, 20)
          .map((f) => ({ localPath: f.path, size: f.size, state: f.state, exists: fs.existsSync(f.path) }));
      case 'searchRemote': {
        if (!api) return { skipped: 'not signed in to a backend' };
        try {
          return { ok: true, hits: await api.search(String(arg ?? '')) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case 'searchWindowHide':
        hideSearchWindow();
        return { visible: isSearchWindowVisible() };
      case 'searchWindowVisible':
        return isSearchWindowVisible();

      // --- IPC guards (Phase 5) --------------------------------------------
      // These return whether the guard ALLOWED the operation, without actually
      // launching anything, so the guard can be tested without opening files.
      case 'guardUnderRoot':
        return isUnderWatchedRoot(String(arg ?? ''));
      case 'guardOpenExternal':
        return isAllowedExternalUrl(String(arg ?? ''));
      case 'shortcutRegistered':
        return globalShortcut.isRegistered('CommandOrControl+Shift+F');
      case 'deliverDeepLink':
        // Simulates the OS handing a sign-in link to a running instance.
        await handleDeepLink(String(arg ?? ''));
        return { ok: true };
      case 'forceSignedInView': {
        // Drives the renderer into its signed-in view without a real account, so
        // the dashboard's own CSS and controls can be audited.
        if (!mainWindow) return { ok: false };
        mainWindow.webContents.send('tff:status-changed', {
          status: 'idle',
          signedIn: true,
          workspaceName: 'QA Workspace',
          workspaceId: 'qa-ws',
          counts: { pending: 0, synced: 3, uploading: 0, failed: 0, skipped: 0 },
          roots: [{ id: 'qa-root', path: '/tmp/qa-root', projectId: 'qa-proj', enabled: true }],
        });
        return { ok: true };
      }
      case 'windowPrefs': {
        const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
        return w ? { ...(w.webContents as any).getLastWebPreferences?.() } : {};
      }
      case 'searchWindowPrefs': {
        if (!isSearchWindowVisible() && !isSearchWindowOpen()) toggleSearchWindow();
        const w = BrowserWindow.getAllWindows().find((x) => x !== mainWindow && !x.isDestroyed());
        return w ? { ...(w.webContents as any).getLastWebPreferences?.() } : {};
      }
      case 'searchWindowToggle':
        toggleSearchWindow();
        return { visible: isSearchWindowVisible() };
      default:
        throw new Error(`unknown qa op: ${op}`);
    }
  });
}

// macOS delivers a deep link through this event; Windows and Linux pass it in
// argv to a second instance, handled below.
app.on('open-url', (event, url) => {
  if (parseAuthDeepLink(url)) {
    event.preventDefault();
    void handleDeepLink(url);
  }
});

app.whenReady().then(async () => {
  registerIpc();
  createWindow();

  // A launch triggered by the sign-in deep link (cold start).
  const launchLink = findDeepLink(process.argv);
  if (launchLink) setTimeout(() => void handleDeepLink(launchLink), 800);

  // Global hotkey for the search palette. Ctrl/Cmd+Shift+F is unlikely to
  // collide with the file manager or browser find shortcuts.
  const accelerator = process.platform === 'darwin' ? 'Cmd+Shift+F' : 'Ctrl+Shift+F';
  const registered = globalShortcut.register(accelerator, () => toggleSearchWindow());
  if (!registered) {
    // Another app owns the combination. Sync still works; only the hotkey is
    // lost, so surface it rather than failing silently.
    lastDetail = `Search hotkey ${accelerator} is unavailable; open search from the tray.`;
  }

  // Smoke mode runs the same startup path, then hands off to the assertions.
  if (process.env.TFF_SMOKE === '1') {
    tray = new Tray(nativeImage.createEmpty());
    broadcast();
    await new Promise((r) => setTimeout(r, 2500));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require(process.env.TFF_SHOT === '1' ? '../scripts/shot' : '../scripts/smokeRunner');
    return;
  }

  // Restore a previous session. verifySession probes the key and clears it only
  // when the server actually refuses it, so an offline launch does not sign the
  // user out over a failed network call.
  const restored = await verifySession(store());
  if (restored) {
    try {
      api = new ApiClient({ baseUrl: getApiBase(), apiKey: restored.apiKey });
      workspaceName = restored.workspaceName || null;
      workspaceId = restored.workspaceId || null;
      await startEngine();
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
      api = null;
    }
  }
  broadcast();

  // Check for updates in the background. Never blocks startup.
  if (process.env.TFF_SMOKE !== '1') {
    initAutoUpdate((message) => {
      lastDetail = message;
      broadcast();
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Stay resident in the tray so sync continues. Quitting is explicit.
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('before-quit', async () => {
  await stopEngine();
  index?.close();
});

// Surface whether the key can be stored, so the UI can warn honestly.
ipcMain.handle('tff:secure-storage-available', async () => isSecureStorageAvailable());
