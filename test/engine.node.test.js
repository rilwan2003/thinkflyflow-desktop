/**
 * Node-native tests for the main-process modules.
 *
 * Deliberately run with `node --test` rather than vitest: these modules touch
 * node:sqlite, which bundler-based runners cannot resolve. Testing the compiled
 * output also proves the build pipeline produces working JavaScript.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SyncIndex, isExcluded, MAX_ATTEMPTS } = require('../dist-electron/electron/syncIndex');
const { SyncEngine, guessMime } = require('../dist-electron/electron/syncEngine');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tff-node-'));
}

test('SyncIndex: round-trip, unchanged detection, attempts', async (t) => {
  const dir = mkTmp();
  const index = new SyncIndex(path.join(dir, 'i.db'));
  t.after(() => {
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  index.upsertFile({
    path: '/a/b.txt', rootId: 'r1', size: 10, mtimeMs: 1000,
    hash: 'abc', remoteId: null, state: 'pending', attempts: 0,
    lastError: null, updatedAt: Date.now(),
  });
  assert.strictEqual(index.getFile('/a/b.txt').size, 10);

  index.markSynced('/a/b.txt', 'remote-1');
  assert.strictEqual(index.isUnchanged('/a/b.txt', 10, 1000), true);
  assert.strictEqual(index.isUnchanged('/a/b.txt', 11, 1000), false);

  index.markState('/a/b.txt', 'failed', 'boom');
  index.markState('/a/b.txt', 'failed', 'boom');
  assert.strictEqual(index.getFile('/a/b.txt').attempts, 2);
});

test('SyncIndex: exclusion is sticky and exhausted entries do not resume', async (t) => {
  const dir = mkTmp();
  const index = new SyncIndex(path.join(dir, 'i.db'));
  t.after(() => {
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  index.upsertFile({
    path: '/a/skip.tmp', rootId: 'r1', size: 5, mtimeMs: 1, hash: null,
    remoteId: null, state: 'skipped', attempts: 0, lastError: 'excluded',
    updatedAt: Date.now(),
  });
  assert.strictEqual(index.isUnchanged('/a/skip.tmp', 999, 999), true);

  index.upsertFile({
    path: '/a/dead.txt', rootId: 'r1', size: 1, mtimeMs: 1, hash: 'd',
    remoteId: null, state: 'failed', attempts: MAX_ATTEMPTS, lastError: 'x',
    updatedAt: Date.now(),
  });
  assert.strictEqual(index.getUnsyncedFiles().length, 0);
});

test('isExcluded covers dependency and OS noise', () => {
  assert.strictEqual(isExcluded('/p/node_modules/x/i.js'), true);
  assert.strictEqual(isExcluded('/p/.git/config'), true);
  assert.strictEqual(isExcluded('/d/.DS_Store'), true);
  assert.strictEqual(isExcluded('/d/f.crdownload'), true);
  assert.strictEqual(isExcluded('/d/report.pdf'), false);
});

test('guessMime maps the formats the product supports', () => {
  assert.strictEqual(guessMime('/x/a.PDF'), 'application/pdf');
  assert.strictEqual(guessMime('/x/a.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.strictEqual(guessMime('/x/a.unknown'), 'application/octet-stream');
});

test('SyncEngine: uploads a real file and records it as synced', async (t) => {
  const dir = mkTmp();
  const watched = path.join(dir, 'watched');
  fs.mkdirSync(watched, { recursive: true });

  const index = new SyncIndex(path.join(dir, 'i.db'));
  index.addRoot({ id: 'r1', path: watched, projectId: 'p1', enabled: true });

  const uploads = [];
  const fakeApi = {
    async lookupHashes() {
      return { matches: {}, missing: [] };
    },
    async uploadFile(projectId, filePath, fileName, data) {
      uploads.push({ projectId, fileName, bytes: data.length });
      return { id: 'remote-' + fileName, original_name: fileName, size: data.length, status: 'uploading' };
    },
  };

  const engine = new SyncEngine(index, fakeApi, {});
  t.after(async () => {
    await engine.stop();
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const file = path.join(watched, 'invoice.pdf');
  fs.writeFileSync(file, Buffer.from('%PDF-1.4 fake invoice body'));

  // Drive the sync path directly rather than relying on watcher timing.
  await engine.syncOne(file);

  assert.strictEqual(uploads.length, 1, 'file should be uploaded once');
  assert.strictEqual(uploads[0].projectId, 'p1');
  assert.strictEqual(uploads[0].fileName, 'invoice.pdf');
  assert.strictEqual(index.getFile(file).state, 'synced');
  assert.strictEqual(index.getFile(file).remoteId, 'remote-invoice.pdf');
});

test('SyncEngine: server already has the content, so no upload happens', async (t) => {
  const dir = mkTmp();
  const watched = path.join(dir, 'watched');
  fs.mkdirSync(watched, { recursive: true });

  const index = new SyncIndex(path.join(dir, 'i.db'));
  index.addRoot({ id: 'r1', path: watched, projectId: 'p1', enabled: true });

  let uploadCount = 0;
  const fakeApi = {
    async lookupHashes(projectId, hashes) {
      const matches = {};
      for (const h of hashes) matches[h] = [{ id: 'already-there', original_name: 'x', size: 1, status: 'ready' }];
      return { matches, missing: [] };
    },
    async uploadFile() {
      uploadCount += 1;
      return { id: 'should-not-happen', original_name: 'x', size: 1, status: 'ready' };
    },
  };

  const engine = new SyncEngine(index, fakeApi, {});
  t.after(async () => {
    await engine.stop();
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const file = path.join(watched, 'dup.txt');
  fs.writeFileSync(file, 'same content as before');
  await engine.syncOne(file);

  assert.strictEqual(uploadCount, 0, 'duplicate content must not be uploaded');
  assert.strictEqual(index.getFile(file).state, 'synced');
  assert.strictEqual(index.getFile(file).remoteId, 'already-there');
});

test('SyncEngine: a retried sync does not upload an unchanged file twice', async (t) => {
  const dir = mkTmp();
  const watched = path.join(dir, 'watched');
  fs.mkdirSync(watched, { recursive: true });

  const index = new SyncIndex(path.join(dir, 'i.db'));
  index.addRoot({ id: 'r1', path: watched, projectId: 'p1', enabled: true });

  const uploads = [];
  const fakeApi = {
    async lookupHashes() { return { matches: {}, missing: [] }; },
    async uploadFile(_p, _fp, fileName) {
      uploads.push(fileName);
      return { id: 'r-' + fileName, original_name: fileName, size: 1, status: 'uploading' };
    },
  };

  const engine = new SyncEngine(index, fakeApi, {});
  t.after(async () => {
    await engine.stop();
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const file = path.join(watched, 'once.txt');
  fs.writeFileSync(file, 'body');
  await engine.syncOne(file);
  await engine.syncOne(file);
  await engine.syncOne(file);

  assert.strictEqual(uploads.length, 1, 'unchanged file must upload only once');
});

test('SyncEngine: empty files and oversized files are skipped without uploading', async (t) => {
  const dir = mkTmp();
  const watched = path.join(dir, 'watched');
  fs.mkdirSync(watched, { recursive: true });

  const index = new SyncIndex(path.join(dir, 'i.db'));
  index.addRoot({ id: 'r1', path: watched, projectId: 'p1', enabled: true });

  let uploads = 0;
  const fakeApi = {
    async lookupHashes() { return { matches: {}, missing: [] }; },
    async uploadFile() { uploads += 1; return { id: 'x', original_name: 'x', size: 0, status: 'ready' }; },
  };

  const engine = new SyncEngine(index, fakeApi, {}, { maxFileBytes: 10 });
  t.after(async () => {
    await engine.stop();
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const empty = path.join(watched, 'empty.txt');
  fs.writeFileSync(empty, '');
  await engine.syncOne(empty);

  const big = path.join(watched, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(50));
  await engine.syncOne(big);

  assert.strictEqual(uploads, 0, 'neither empty nor oversized file should upload');
  assert.strictEqual(index.getFile(big).state, 'skipped');
});

test('SyncEngine: a failing upload is recorded, not thrown', async (t) => {
  const dir = mkTmp();
  const watched = path.join(dir, 'watched');
  fs.mkdirSync(watched, { recursive: true });

  const index = new SyncIndex(path.join(dir, 'i.db'));
  index.addRoot({ id: 'r1', path: watched, projectId: 'p1', enabled: true });

  const fakeApi = {
    async lookupHashes() { return { matches: {}, missing: [] }; },
    async uploadFile() { throw new Error('network down'); },
  };

  const engine = new SyncEngine(index, fakeApi, {});
  t.after(async () => {
    await engine.stop();
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const file = path.join(watched, 'fail.txt');
  fs.writeFileSync(file, 'body');
  await engine.syncOne(file);

  const entry = index.getFile(file);
  assert.strictEqual(entry.state, 'failed');
  assert.match(entry.lastError, /network down/);
});

test('SyncEngine: pause stops processing and resume continues', async (t) => {
  const dir = mkTmp();
  const index = new SyncIndex(path.join(dir, 'i.db'));
  const engine = new SyncEngine(index, { async lookupHashes() { return { matches: {}, missing: [] }; }, async uploadFile() { return { id: 'x', original_name: 'x', size: 1, status: 'ready' }; } }, {});
  t.after(async () => {
    await engine.stop();
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  engine.pause();
  assert.strictEqual(engine.getStatus(), 'paused');
  engine.resume();
  assert.strictEqual(engine.getStatus(), 'idle');
});
