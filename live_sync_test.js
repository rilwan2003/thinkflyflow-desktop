/**
 * Prove the real sync engine against the real TEST API.
 * Uses a throwaway account, watches a temp folder, writes a file, and asserts
 * the file lands in the workspace and is not uploaded twice.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SyncIndex } = require('./dist-electron/electron/syncIndex');
const { SyncEngine } = require('./dist-electron/electron/syncEngine');
const { ApiClient } = require('./dist-electron/electron/apiClient');

const BASE = 'http://127.0.0.1:8001';
const PROJECT = process.env.PROJECT_ID || '7e453aa7-e7b6-48a1-920d-be8620d291cb';
const KEY = process.env.API_KEY;

(async () => {
  if (!KEY) { console.error('no API_KEY'); process.exit(1); }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tff-live-'));
  const watched = path.join(dir, 'watched');
  fs.mkdirSync(watched);

  const index = new SyncIndex(path.join(dir, 'i.db'));
  index.addRoot({ id: 'r1', path: watched, projectId: PROJECT, enabled: true });

  const api = new ApiClient({ baseUrl: BASE, apiKey: KEY });
  const synced = [];
  const engine = new SyncEngine(index, api, {
    onFileSynced: (p, id) => synced.push({ p, id }),
  });

  // A distinctive payload so the hash is certainly not already on the server.
  const body = 'live sync test ' + Date.now();
  const file = path.join(watched, 'live-note.txt');
  fs.writeFileSync(file, body);

  await engine.syncOne(file);
  const first = index.getFile(file);
  console.log('first sync state:', first && first.state, 'remote:', first && first.remoteId);

  const countAfterFirst = synced.length;

  // Second pass must be a no-op.
  await engine.syncOne(file);
  console.log('uploads after re-sync:', synced.length, '(expected', countAfterFirst + ')');

  // Delete the remote file so the test leaves nothing behind.
  if (first && first.remoteId) {
    const res = await fetch(`${BASE}/api/v2/files/${first.remoteId}/`, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + KEY, Accept: 'application/json' },
    });
    console.log('cleanup:', res.status);
  }

  await engine.stop();
  index.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const ok = first && first.state === 'synced' && first.remoteId && synced.length === countAfterFirst;
  console.log('RESULT:', ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
