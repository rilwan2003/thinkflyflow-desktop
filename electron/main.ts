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
  clearCredential,
  isSecureStorageAvailable,
  loadCredential,
  saveCredential,
} from './credentials';
import { IPC, type ProjectOption, type SearchHit, type SignInRequest, type SignInResult, type StatusSnapshot, type WorkspaceOption, type WatchedRoot } from './ipc';
import { SyncEngine, type SyncStatus } from './syncEngine';
import { SyncIndex } from './syncIndex';
import { hideSearchWindow, toggleSearchWindow } from './searchWindow';
import { initAutoUpdate } from './updater';

// Dev-server mode is opt-in, not the default for any unpackaged run.
// `npm start` runs unpackaged but should load the built files; only `npm run
// dev:app` wants the Vite server. Keying this off `!app.isPackaged` alone made
// every local start try to reach a server that was not running.
const useDevServer = process.env.TFF_DEV_SERVER === '1' && !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

let index: SyncIndex | null = null;
let engine: SyncEngine | null = null;
let api: ApiClient | null = null;
let workspaceName: string | null = null;
let lastProgress: { done: number; total: number } | null = null;
let lastDetail: string | undefined;

// A second instance would double-watch every folder and fight over the same
// SQLite file, so hand off to the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
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
  ipcMain.handle(IPC.listWorkspaces, async (_e, baseUrl: string, email: string, password: string): Promise<WorkspaceOption[]> => {
    const { workspaces } = await fetchWorkspacesForSignIn(baseUrl, email, password);
    return workspaces.map((w) => ({ id: String(w.id), name: w.name }));
  });

  ipcMain.handle(IPC.signIn, async (_e, req: SignInRequest): Promise<SignInResult> => {
    try {
      const raw = await createApiKey(req.baseUrl, req.email, req.password, req.workspaceId);
      const client = new ApiClient({ baseUrl: req.baseUrl, apiKey: raw });
      const workspaces = await client.listWorkspaces();
      const match = workspaces.find((w) => String(w.id) === req.workspaceId);
      workspaceName = match?.name ?? null;

      saveCredential({
        apiKey: raw,
        baseUrl: req.baseUrl,
        workspaceId: req.workspaceId,
        workspaceName: workspaceName ?? '',
      });

      api = client;
      await startEngine();
      return { ok: true, workspaceName: workspaceName ?? undefined };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC.signOut, async () => {
    await stopEngine();
    clearCredential();
    api = null;
    workspaceName = null;
    lastProgress = null;
    broadcast();
  });

  ipcMain.handle(IPC.listProjects, async (_e, workspaceId: string): Promise<ProjectOption[]> => {
    if (!api) return [];
    const projects = await api.listProjects(workspaceId);
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
    if (typeof url === 'string' && url.startsWith('https://')) await shell.openExternal(url);
  });
}

function isUnderWatchedRoot(p: string): boolean {
  if (typeof p !== 'string' || !p) return false;
  try {
    return ensureIndex().getRoots().some((r) => r.enabled && p.startsWith(r.path));
  } catch {
    return false;
  }
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();

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

  // Restore a previous session without asking for the password again.
  const cred = loadCredential();
  if (cred) {
    try {
      api = new ApiClient({ baseUrl: cred.baseUrl, apiKey: cred.apiKey });
      workspaceName = cred.workspaceName || null;
      await startEngine();
    } catch (err) {
      // A revoked or expired key must not wedge startup.
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
