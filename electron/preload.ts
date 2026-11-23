/**
 * Preload bridge.
 *
 * This file is the entire attack surface between the UI and the machine. It
 * exposes named functions only: no `ipcRenderer`, no `require`, no arbitrary
 * channel strings. The renderer cannot ask for a channel that is not listed
 * here, which means a compromised page (say, a malicious link rendered into a
 * search result) cannot reach the filesystem or the API key.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { SignInRequest, StatusSnapshot } from './ipc';

/**
 * Channel names are duplicated here rather than imported.
 *
 * Electron loads the preload script in a restricted context where a relative
 * `require('./ipc')` fails ("module not found"), so importing the shared
 * constant module breaks the bridge at runtime even though it compiles. The
 * values below must stay in step with electron/ipc.ts; the bridge test asserts
 * the whole surface is present so a mismatch fails loudly rather than silently.
 */
const CH = {
  signIn: 'tff:sign-in',
  signOut: 'tff:sign-out',
  listWorkspaces: 'tff:list-workspaces',
  listProjects: 'tff:list-projects',
  getStatus: 'tff:get-status',
  statusChanged: 'tff:status-changed',
  addRoot: 'tff:add-root',
  removeRoot: 'tff:remove-root',
  pickFolder: 'tff:pick-folder',
  pauseSync: 'tff:pause-sync',
  resumeSync: 'tff:resume-sync',
  openFile: 'tff:open-file',
  revealFile: 'tff:reveal-file',
  search: 'tff:search',
  searchWindowShown: 'tff:search-window-shown',
  hideSearchWindow: 'tff:hide-search',
  localFiles: 'tff:local-files',
  recentActivity: 'tff:recent-activity',
  openExternal: 'tff:open-external',
} as const;

contextBridge.exposeInMainWorld('tff', {
  signIn: (req: SignInRequest) => ipcRenderer.invoke(CH.signIn, req),
  signOut: () => ipcRenderer.invoke(CH.signOut),
  listWorkspaces: (baseUrl: string, email: string, password: string) =>
    ipcRenderer.invoke(CH.listWorkspaces, baseUrl, email, password),
  listProjects: (workspaceId: string) => ipcRenderer.invoke(CH.listProjects, workspaceId),

  getStatus: () => ipcRenderer.invoke(CH.getStatus),

  onStatus: (cb: (snapshot: StatusSnapshot) => void) => {
    const handler = (_e: unknown, snapshot: StatusSnapshot) => cb(snapshot);
    ipcRenderer.on(CH.statusChanged, handler);
    // Return an unsubscribe so React effects can clean up properly.
    return () => {
      ipcRenderer.removeListener(CH.statusChanged, handler);
    };
  },

  addRoot: (folderPath: string, projectId: string) =>
    ipcRenderer.invoke(CH.addRoot, folderPath, projectId),
  removeRoot: (rootId: string) => ipcRenderer.invoke(CH.removeRoot, rootId),
  pickFolder: () => ipcRenderer.invoke(CH.pickFolder),

  pause: () => ipcRenderer.invoke(CH.pauseSync),
  resume: () => ipcRenderer.invoke(CH.resumeSync),

  openFile: (localPath: string) => ipcRenderer.invoke(CH.openFile, localPath),
  revealFile: (localPath: string) => ipcRenderer.invoke(CH.revealFile, localPath),

  search: (query: string) => ipcRenderer.invoke(CH.search, query),
  localFiles: (query: string) => ipcRenderer.invoke(CH.localFiles, query),
  hideSearchWindow: () => ipcRenderer.invoke(CH.hideSearchWindow),
  onSearchWindowShown: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on(CH.searchWindowShown, handler);
    return () => {
      ipcRenderer.removeListener(CH.searchWindowShown, handler);
    };
  },
  recentActivity: (limit?: number) => ipcRenderer.invoke(CH.recentActivity, limit),

  openExternal: (url: string) => ipcRenderer.invoke(CH.openExternal, url),

  secureStorageAvailable: () => ipcRenderer.invoke('tff:secure-storage-available'),
});
