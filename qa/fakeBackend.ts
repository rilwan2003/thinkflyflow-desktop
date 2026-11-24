/**
 * Fake ThinkFlyFlow backend.
 *
 * Purpose: make sync, search and error-path tests deterministic and keep them
 * off any real API. Every test gets its own instance on a random port, so no
 * test can see another's state.
 *
 * Deliberately not a mock library: a real HTTP server means the app's real
 * fetch-based client is exercised, including headers, status codes and JSON
 * shapes.
 */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

export interface FakeFile {
  id: string;
  name: string;
  contentHash: string;
  size: number;
  uploadedAt: number;
  projectId: string;
}

export interface FakeBackend {
  url: string;
  apiBase: string;
  files: Map<string, FakeFile>;
  /**
   * Content the server already holds that was never uploaded by this client.
   * Simulates "someone else already put this here", which is the case the
   * duplicate-suppression guarantee exists for.
   */
  knownHashes: Map<string, FakeFile>;
  requests: { method: string; path: string; at: number }[];
  /** When true every request fails with 503, for offline/retry tests. */
  offline: boolean;
  /** When true the auth endpoints reject, for expired-session tests. */
  rejectAuth: boolean;
  close: () => Promise<void>;
  reset: () => void;
}

function json(res: any, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startFakeBackend(): Promise<FakeBackend> {
  const files = new Map<string, FakeFile>();
  const knownHashes = new Map<string, FakeFile>();
  const requests: { method: string; path: string; at: number }[] = [];
  let pendingUploadHash: string | null = null;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    requests.push({ method: req.method ?? 'GET', path, at: Date.now() });

    const backend = state;
    if (backend.offline) return json(res, 503, { success: false, error: 'offline' });

    // --- auth -------------------------------------------------------------
    if (path.endsWith('/auth/desktop/exchange')) {
      if (backend.rejectAuth) return json(res, 401, { success: false, error: 'invalid token' });
      await readBody(req);
      return json(res, 200, {
        success: true,
        data: {
          api_key: 'fake-api-key-' + randomUUID(),
          user: { id: 30, username: 'reachadeon', email: 'reachadeon@gmail.com' },
          workspace_id: 'fake-ws-1',
          workspace_name: 'QA Desktop',
        },
      });
    }
    if (path.endsWith('/auth/me/')) {
      if (backend.rejectAuth) return json(res, 401, { detail: 'token expired' });
      return json(res, 200, {
        success: true,
        user: { id: 30, username: 'reachadeon', email: 'reachadeon@gmail.com' },
      });
    }
    if (path.endsWith('/auth/2fa/status/')) {
      return json(res, 200, {
        success: true,
        data: {
          enabled: false, recovery_codes_remaining: 0, has_secret: false,
          workspace_requires_mfa: false, signup_age_days: 0,
          mfa_grace_days: 7, mfa_required: false,
          mfa_required_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        },
      });
    }

    // --- workspace / project listing --------------------------------------
    if (path.endsWith('/workspaces/')) {
      return json(res, 200, {
        success: true,
        data: [{
          id: 'fake-ws-1',
          name: 'QA Desktop',
          owner: { id: 30, username: 'reachadeon', email: 'reachadeon@gmail.com' },
          profile: {},
        }],
      });
    }
    if (path.includes('/projects')) {
      return json(res, 200, {
        success: true,
        data: [{ id: 'fake-proj-1', name: 'QA Project', workspace_id: 'fake-ws-1' }],
      });
    }

    // --- content-hash lookup -------------------------------------------------
    // Real path: POST /api/v2/files/lookup/ with {project_id, hashes}. The app
    // asks before uploading, so a match must short-circuit the upload entirely.
    if (path.endsWith('/files/lookup/')) {
      const raw = await readBody(req);
      let body: any = {};
      try { body = JSON.parse(raw.toString() || '{}'); } catch { body = {}; }
      const wanted: string[] = Array.isArray(body.hashes) ? body.hashes : [];
      const matches: Record<string, any[]> = {};
      const missing: string[] = [];
      // In test mode a 503 first pass is how "server had it already" is simulated.
      for (const h of wanted) {
        const hit = backend.knownHashes.get(h);
        if (hit) matches[h] = [hit];
        else missing.push(h);
      }
      // Also match anything actually uploaded to this instance.
      for (const h of missing.slice()) {
        const stored = [...files.values()].find((f) => f.contentHash === h);
        if (stored) {
          matches[h] = [stored];
          missing.splice(missing.indexOf(h), 1);
        }
      }
      // Remember the first hash the client asked about, so the follow-up upload
      // is recorded under the content hash the client computed locally.
      if (missing.length > 0) pendingUploadHash = missing[0];
      return json(res, 200, { success: true, data: { matches, missing } });
    }

    // --- upload ---------------------------------------------------------------
    // Real path: POST /api/v2/files/upload/ as multipart FormData.
    //
    // The client does not send a content hash with the upload: it asked about
    // the hash BEFORE uploading and the server is expected to remember it. So
    // the multipart body cannot be hashed to recover it (boundaries and
    // headers differ every time). We take the hash from the pending lookup
    // instead, which is exactly the real server's contract.
    if (path.endsWith('/files/upload/')) {
      const raw = await readBody(req);
      const hash = pendingUploadHash ?? createHash('sha256').update(raw).digest('hex');
      pendingUploadHash = null;
      const id = randomUUID();
      const rec: FakeFile = {
        id,
        name: 'upload.bin',
        contentHash: hash,
        size: raw.length,
        uploadedAt: Date.now(),
        projectId: 'fake-proj-1',
      };
      files.set(id, rec);
      return json(res, 201, {
        success: true,
        data: { id, original_name: rec.name, size: raw.length, status: 'ready' },
      });
    }

    // --- search -----------------------------------------------------------
    if (path.includes('/search')) {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const results = [...files.values()].filter((f) => f.name.toLowerCase().includes(q));
      return json(res, 200, { success: true, data: results });
    }

    // --- default ----------------------------------------------------------
    return json(res, 404, { success: false, error: 'not found' });
  });

  const state: FakeBackend = {
    url: '',
    apiBase: '',
    files,
    knownHashes,
    requests,
    offline: false,
    rejectAuth: false,
    close: async () => {},
    reset: () => {
      files.clear();
      knownHashes.clear();
      requests.length = 0;
      state.offline = false;
      state.rejectAuth = false;
    },
  };

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as any;
  state.url = `http://127.0.0.1:${addr.port}`;
  state.apiBase = `${state.url}/api/v2`;
  state.close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));

  return state;
}
