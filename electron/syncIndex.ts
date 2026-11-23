/**
 * Local sync index.
 *
 * The whole point of this file is that a restart must not re-upload the
 * workspace. Every file we have seen is recorded with its size, mtime and
 * content hash, so after a crash or an upgrade we can tell "unchanged" from
 * "changed" without touching the network.
 *
 * Uses node:sqlite (built into Node 22+/Electron 33+). A native module like
 * better-sqlite3 would need recompiling against Electron's ABI on every
 * upgrade; the built-in driver removes that whole class of build failure.
 *
 * WAL mode is on so a crash mid-write cannot corrupt the index, and reads are
 * not blocked by the sync writer.
 */
import { DatabaseSync } from 'node:sqlite';

export type SyncState =
  | 'pending'   // discovered, not yet hashed
  | 'synced'    // present in the workspace
  | 'uploading' // in flight
  | 'failed'    // gave up after retries
  | 'skipped';  // excluded by rules

export interface FileEntry {
  /** Absolute local path. Primary key. */
  path: string;
  /** Which watched folder this belongs to. */
  rootId: string;
  size: number;
  mtimeMs: number;
  /** SHA-256 hex, lowercase. Null until hashed. */
  hash: string | null;
  /** Server-side file id once uploaded. */
  remoteId: string | null;
  state: SyncState;
  /** Consecutive failures, for backoff. */
  attempts: number;
  lastError: string | null;
  updatedAt: number;
}

export interface RootConfig {
  id: string;
  path: string;
  projectId: string;
  enabled: boolean;
}

export const MAX_ATTEMPTS = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  root_id     TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  hash        TEXT,
  remote_id   TEXT,
  state       TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_state ON files(state);
CREATE INDEX IF NOT EXISTS idx_files_root ON files(root_id);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);

CREATE TABLE IF NOT EXISTS roots (
  id           TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

export class SyncIndex {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  getFile(filePath: string): FileEntry | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as Row | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  /**
   * True when the file on disk is what we last synced.
   * Size and mtime are a cheap first check; mtime alone is not trusted
   * because editors and sync tools rewrite it inconsistently.
   */
  isUnchanged(filePath: string, size: number, mtimeMs: number): boolean {
    const row = this.db
      .prepare('SELECT size, mtime_ms, state, attempts FROM files WHERE path = ?')
      .get(filePath) as Row | undefined;
    if (!row) return false;
    const state = String(row.state);
    if (state === 'skipped') return true; // exclusion is sticky
    if (state === 'failed' && Number(row.attempts) >= MAX_ATTEMPTS) return true; // stop retrying
    return (
      Number(row.size) === size &&
      Math.abs(Number(row.mtime_ms) - mtimeMs) < 1000 && // tolerate sub-second drift
      state === 'synced'
    );
  }

  upsertFile(entry: FileEntry): void {
    this.db
      .prepare(
        `INSERT INTO files (path, root_id, size, mtime_ms, hash, remote_id, state, attempts, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           root_id = excluded.root_id, size = excluded.size, mtime_ms = excluded.mtime_ms,
           hash = excluded.hash, remote_id = COALESCE(excluded.remote_id, files.remote_id),
           state = excluded.state, attempts = excluded.attempts,
           last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(
        entry.path,
        entry.rootId,
        entry.size,
        entry.mtimeMs,
        entry.hash,
        entry.remoteId,
        entry.state,
        entry.attempts,
        entry.lastError,
        entry.updatedAt,
      );
  }

  markState(filePath: string, state: SyncState, error: string | null = null): void {
    const current = this.getFile(filePath);
    const attempts =
      state === 'failed'
        ? (current?.attempts ?? 0) + 1
        : state === 'synced'
          ? 0
          : (current?.attempts ?? 0);
    this.db
      .prepare('UPDATE files SET state = ?, last_error = ?, attempts = ?, updated_at = ? WHERE path = ?')
      .run(state, error, attempts, Date.now(), filePath);
  }

  markSynced(filePath: string, remoteId: string | null): void {
    this.db
      .prepare(
        `UPDATE files SET state = 'synced', remote_id = COALESCE(?, remote_id),
         attempts = 0, last_error = NULL, updated_at = ? WHERE path = ?`,
      )
      .run(remoteId, Date.now(), filePath);
  }

  /**
   * Every file that is not yet in the workspace. Used on startup to resume
   * an interrupted sync rather than starting from nothing.
   */
  getUnsyncedFiles(): FileEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM files
         WHERE state IN ('pending', 'failed', 'uploading')
           AND attempts < ?
         ORDER BY updated_at ASC`,
      )
      .all(MAX_ATTEMPTS) as Row[];
    return rows.map(rowToEntry);
  }

  /**
   * Drop records whose local file has disappeared, so the index does not grow
   * forever. Deliberately does NOT delete from the workspace: treating a local
   * delete as a cloud delete is the most destructive mistake this app could
   * make, and it is not the default.
   */
  pruneMissing(rootId: string, existingPaths: Set<string>): number {
    const rows = this.db.prepare('SELECT path FROM files WHERE root_id = ?').all(rootId) as Row[];
    const gone = rows.map((r) => String(r.path)).filter((p) => !existingPaths.has(p));
    if (gone.length === 0) return 0;
    const del = this.db.prepare('DELETE FROM files WHERE path = ?');
    this.db.exec('BEGIN');
    try {
      for (const p of gone) del.run(p);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return gone.length;
  }

  /**
   * Every tracked file. Used by the search palette, which filters in memory:
   * a query over a few thousand rows is instant, and it means local search
   * never depends on a live API call.
   */
  allFiles(): FileEntry[] {
    const rows = this.db.prepare('SELECT * FROM files ORDER BY updated_at DESC').all() as Row[];
    return rows.map(rowToEntry);
  }

  counts(): Record<SyncState, number> {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS n FROM files GROUP BY state')
      .all() as Row[];
    const out: Record<SyncState, number> = { pending: 0, synced: 0, uploading: 0, failed: 0, skipped: 0 };
    for (const r of rows) out[String(r.state) as SyncState] = Number(r.n);
    return out;
  }

  getRoots(): RootConfig[] {
    const rows = this.db.prepare('SELECT * FROM roots').all() as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      path: String(r.path),
      projectId: String(r.project_id),
      enabled: Number(r.enabled) === 1,
    }));
  }

  addRoot(root: RootConfig): void {
    this.db
      .prepare(
        `INSERT INTO roots (id, path, project_id, enabled, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, project_id = excluded.project_id, enabled = excluded.enabled`,
      )
      .run(root.id, root.path, root.projectId, root.enabled ? 1 : 0, Date.now());
  }

  removeRoot(rootId: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM files WHERE root_id = ?').run(rootId);
      this.db.prepare('DELETE FROM roots WHERE id = ?').run(rootId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }
}

function rowToEntry(r: Row): FileEntry {
  return {
    path: String(r.path),
    rootId: String(r.root_id),
    size: Number(r.size),
    mtimeMs: Number(r.mtime_ms),
    hash: r.hash == null ? null : String(r.hash),
    remoteId: r.remote_id == null ? null : String(r.remote_id),
    state: String(r.state) as SyncState,
    attempts: Number(r.attempts),
    lastError: r.last_error == null ? null : String(r.last_error),
    updatedAt: Number(r.updated_at),
  };
}

/** Default exclusions. Without these a first run uploads node_modules. */
export const DEFAULT_EXCLUDES: string[] = [
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.localized',
  '*.tmp',
  '*.crdownload',
  '*.part',
  '~$*',
  '.thinkflyflow',
];

export function isExcluded(filePath: string, extra: string[] = []): boolean {
  const segments = filePath.split(/[\\/]/);
  const base = segments[segments.length - 1] ?? '';
  const patterns = [...DEFAULT_EXCLUDES, ...extra];
  return patterns.some((p) => {
    if (p.startsWith('*')) return base.endsWith(p.slice(1));
    return segments.includes(p) || base === p;
  });
}
