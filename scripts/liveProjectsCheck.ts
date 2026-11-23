/**
 * End-to-end proof that the BUILT app can list projects.
 *
 * Uses the real ApiClient (not a mock) against the test backend, with a real
 * key, and asserts the call succeeds. This is the check that would have caught
 * the /api/v2/api/v2 404.
 */
import { app } from 'electron';
import { ApiClient } from '../electron/apiClient';

const ORIGIN = 'https://apitest.laureljar.com';
const WS = '8e24e52c-72c7-4353-9ddb-e01f301760f8';

async function run(): Promise<void> {
  const key = process.env.TFF_TEST_KEY;
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${ok ? '' : ' | ' + detail}`);
    if (!ok) failures.push(name);
  };

  if (!key) {
    console.log('SKIP: TFF_TEST_KEY not set');
    app.exit(0);
    return;
  }

  // Deliberately pass the VERSIONED base, which is what main.ts supplies, to
  // prove normalisation works in the real client.
  const client = new ApiClient({ baseUrl: `${ORIGIN}/api/v2`, apiKey: key });

  try {
    const projects = await client.listProjects(WS);
    check('listProjects resolved', true);
    check('at least one project', projects.length > 0, `count=${projects.length}`);
    for (const p of projects) console.log('    -', p.name, p.id);
  } catch (err) {
    const e = err as { message?: unknown; status?: unknown; body?: unknown };
    check('listProjects resolved', false, JSON.stringify({ message: e?.message, status: e?.status, body: e?.body }).slice(0, 400));
  }

  try {
    const workspaces = await client.listWorkspaces();
    check('listWorkspaces resolved', workspaces.length > 0, `count=${workspaces.length}`);
  } catch (err) {
    const e = err as { message?: unknown; status?: unknown; body?: unknown };
    check('listWorkspaces resolved', false, JSON.stringify({ message: e?.message, status: e?.status, body: e?.body }).slice(0, 400));
  }

  console.log('');
  console.log(`RESULT: ${failures.length === 0 ? 'all passed' : failures.length + ' failed'}`);
  app.exit(failures.length === 0 ? 0 : 1);
}

app.whenReady().then(run);
