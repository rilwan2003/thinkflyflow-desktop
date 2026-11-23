/**
 * Watched-folder sync engine.
 *
 * Design rules that matter more than the code:
 *
 *  1. A file being written must never be uploaded half-finished. chokidar
 *     reports 'add' before the writer closes the handle, so every event waits
 *     for the size to stop changing before we read it.
 *  2. Nothing is uploaded twice. A local hash index plus the server's own
 *     content lookup both guard against it.
 *  3. A local delete is NOT a cloud delete. That is the single most
 *     destructive shortcut this app could take, so it is not available.
 *  4. Failures back off rather than spin. A locked file on Windows would
 *     otherwise retry forever and burn the CPU.
 */
import chokidar, { FSWatcher } from 'chokidar';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ApiClient, ApiError } from './apiClient';
import { isExcluded, MAX_ATTEMPTS, SyncIndex, type RootConfig } from './syncIndex';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'paused';

export interface SyncEvents {
  onStatus?: (status: SyncStatus, detail?: string) => void;
  onProgress?: (done: number, total: number) => void;
  onFileSynced?: (localPath: string, remoteId: string) => void;
  onFileFailed?: (localPath: string, error: string) => void;
}

const SETTLE_MS = 600;
const MAX_FILE_BYTES_DEFAULT = 200 * 1024 * 1024;

export class SyncEngine {
  private watchers = new Map<string, FSWatcher>();
  private queue: string[] = [];
  private queued = new Set<string>();
  private running = false;
  private paused = false;
  private status: SyncStatus = 'idle';
  private timers = new Map<string, NodeJS.Timeout>();
  private fileLimit: number;

  constructor(
    private readonly index: SyncIndex,
    private readonly api: ApiClient,
    private readonly events: SyncEvents = {},
    opts: { maxFileBytes?: number } = {},
  ) {
    this.fileLimit = opts.maxFileBytes ?? MAX_FILE_BYTES_DEFAULT;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  private setStatus(s: SyncStatus, detail?: string): void {
    if (this.status === s && !detail) return;
    this.status = s;
    this.events.onStatus?.(s, detail);
  }

  /** Start watching every enabled root, and resume anything left unsynced. */
  async start(): Promise<void> {
    const roots = this.index.getRoots().filter((r) => r.enabled);
    for (const root of roots) {
      await this.watchRoot(root);
    }
    this.setStatus('idle');
    // Resume an interrupted run before accepting new events, so a restart
    // does not silently drop yesterday's backlog.
    const pending = this.index.getUnsyncedFiles();
    for (const f of pending) {
      if (fs.existsSync(f.path)) this.enqueue(f.path);
    }
  }

  async watchRoot(root: RootConfig): Promise<void> {
    if (this.watchers.has(root.id)) return;

    const watcher = chokidar.watch(root.path, {
      ignoreInitial: false,
      persistent: true,
      followSymlinks: false, // a symlink loop would hang the watcher
      depth: 20,
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 120 },
      ignored: (p: string) => isExcluded(p),
    });

    watcher.on('add', (p) => this.onFsEvent(root, p));
    watcher.on('change', (p) => this.onFsEvent(root, p));
    watcher.on('error', (err) => {
      this.setStatus('error', String(err));
    });

    this.watchers.set(root.id, watcher);
  }

  async unwatchRoot(rootId: string): Promise<void> {
    const w = this.watchers.get(rootId);
    if (w) {
      await w.close();
      this.watchers.delete(rootId);
    }
  }

  private onFsEvent(root: RootConfig, filePath: string): void {
    if (this.paused) return;
    // Debounce rapid repeats (an editor save can fire several events).
    const existing = this.timers.get(filePath);
    if (existing) clearTimeout(existing);
    this.timers.set(
      filePath,
      setTimeout(() => {
        this.timers.delete(filePath);
        this.enqueue(filePath);
      }, SETTLE_MS),
    );
  }

  private enqueue(filePath: string): void {
    if (this.queued.has(filePath)) return;
    this.queued.add(filePath);
    this.queue.push(filePath);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running || this.paused) return;
    this.running = true;
    this.setStatus('syncing');

    while (this.queue.length > 0) {
      const filePath = this.queue.shift()!;
      this.queued.delete(filePath);
      try {
        await this.syncOne(filePath);
      } catch (err) {
        // One bad file must never stop the queue.
        this.events.onFileFailed?.(filePath, String(err));
      }
    }

    this.running = false;
    this.setStatus('idle');
  }

  /** Exposed for tests; not part of the public surface. */
  async syncOne(filePath: string): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      // Vanished between event and handling. Drop it quietly; pruneMissing
      // cleans the index separately.
      return;
    }
    if (!stat.isFile()) return;
    if (stat.size === 0) return; // an empty placeholder is not worth a round trip

    const root = this.rootFor(filePath);
    if (!root) return;

    // Oversized files are recorded as skipped, not silently ignored. If we just
    // returned, every restart would stat and re-hash the same giant file forever.
    if (stat.size > this.fileLimit) {
      this.index.upsertFile({
        path: filePath,
        rootId: root.id,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        hash: null,
        remoteId: null,
        state: 'skipped',
        attempts: 0,
        lastError: `larger than ${this.fileLimit} bytes`,
        updatedAt: Date.now(),
      });
      return;
    }

    if (this.index.isUnchanged(filePath, stat.size, stat.mtimeMs)) return;

    // Already hashed and merely touched? Skip the read.
    const prior = this.index.getFile(filePath);
    const hash = prior && prior.size === stat.size && prior.hash ? prior.hash : await hashFile(filePath);

    this.index.upsertFile({
      path: filePath,
      rootId: root.id,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      hash,
      remoteId: prior?.remoteId ?? null,
      state: 'pending',
      attempts: prior?.attempts ?? 0,
      lastError: null,
      updatedAt: Date.now(),
    });

    // Server-side check: if this exact content is already there, we are done.
    // Costs one small request and saves the whole upload.
    try {
      const lookup = await this.api.lookupHashes(root.projectId, [hash]);
      const hit = lookup.matches[hash]?.[0];
      if (hit) {
        this.index.markSynced(filePath, hit.id);
        this.events.onFileSynced?.(filePath, hit.id);
        return;
      }
    } catch (err) {
      if (err instanceof ApiError && err.isPermanent) {
        this.index.markState(filePath, 'failed', err.message);
        return;
      }
      // A network blip on lookup should not block the upload attempt.
    }

    this.index.markState(filePath, 'uploading');
    const data = await fsp.readFile(filePath);

    try {
      const result = await this.api.uploadFile(
        root.projectId,
        filePath,
        path.basename(filePath),
        data,
        guessMime(filePath),
      );
      this.index.markSynced(filePath, result.id);
      this.events.onFileSynced?.(filePath, result.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.index.markState(filePath, 'failed', message);
      const entry = this.index.getFile(filePath);
      if (entry && entry.attempts >= MAX_ATTEMPTS) {
        this.events.onFileFailed?.(filePath, `gave up after ${MAX_ATTEMPTS} attempts: ${message}`);
      }
    }
  }

  private rootFor(filePath: string): RootConfig | undefined {
    const roots = this.index.getRoots();
    // Longest prefix wins, so a nested root overrides its parent.
    return roots
      .filter((r) => r.enabled && filePath.startsWith(r.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
  }

  pause(): void {
    this.paused = true;
    this.setStatus('paused');
  }

  resume(): void {
    this.paused = false;
    this.setStatus('idle');
    void this.drain();
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const [, w] of this.watchers) await w.close();
    this.watchers.clear();
  }
}

export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
};

export function guessMime(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
