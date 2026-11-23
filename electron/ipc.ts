/**
 * The contract between the main process and the renderer.
 *
 * Shared as types only so both sides import one definition. Keeping this in a
 * single file is deliberate: an IPC channel that exists on one side and not the
 * other fails at runtime, not compile time, and that is a miserable class of
 * bug to chase in a packaged desktop app.
 */

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'paused';

export interface StatusSnapshot {
  status: SyncStatus;
  detail?: string;
  signedIn: boolean;
  workspaceName: string | null;
  /** Held by the main process; the renderer never supplies it. */
  workspaceId: string | null;
  counts: {
    pending: number;
    synced: number;
    uploading: number;
    failed: number;
    skipped: number;
  };
  roots: WatchedRoot[];
  progress: { done: number; total: number } | null;
}

export interface WatchedRoot {
  id: string;
  path: string;
  projectId: string;
  enabled: boolean;
}

export interface WorkspaceOption {
  id: string;
  name: string;
}

export interface ProjectOption {
  id: string;
  name: string;
}

/**
 * Sign-in no longer carries credentials. The app opens the ThinkFlyFlow sign-in
 * page in the browser and receives a single-use code back over a deep link, so
 * there is no email, password or server address anywhere in this contract.
 */
export interface SignInResult {
  ok: boolean;
  error?: string;
  workspaceName?: string;
}

export interface SearchHit {
  id: string;
  name: string;
  kind: 'file' | 'folder' | 'project';
  /** Why this matched, when the API can say. */
  matchedOn?: string;
  /** Context line (folder path, project name, size). */
  context?: string;
  snippet?: string;
  fileType?: string;
}

export interface LocalFileHit {
  localPath: string;
  size: number;
  state: string;
  exists: boolean;
}

export interface RecentActivity {
  localPath: string;
  remoteId: string;
  at: number;
}

/** Channels the renderer may call. Nothing else is exposed by preload. */
export const IPC = {
  signIn: 'tff:sign-in',
  signOut: 'tff:sign-out',
  cancelSignIn: 'tff:cancel-sign-in',
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

/** Shape exposed on window.tff by the preload script. */
export interface TffBridge {
  signIn(): Promise<SignInResult>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<void>;
  listProjects(): Promise<ProjectOption[]>;
  getStatus(): Promise<StatusSnapshot>;
  onStatus(cb: (snapshot: StatusSnapshot) => void): () => void;
  addRoot(path: string, projectId: string): Promise<WatchedRoot[]>;
  removeRoot(rootId: string): Promise<WatchedRoot[]>;
  pickFolder(): Promise<string | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  openFile(localPath: string): Promise<void>;
  revealFile(localPath: string): Promise<void>;
  search(query: string): Promise<SearchHit[]>;
  /** Files this machine has synced, for the local half of a search. */
  localFiles(query: string): Promise<LocalFileHit[]>;
  hideSearchWindow(): Promise<void>;
  onSearchWindowShown(cb: () => void): () => void;
  recentActivity(limit?: number): Promise<RecentActivity[]>;
  openExternal(url: string): Promise<void>;
}
