/**
 * ThinkFlyFlow account gate and sign-in.
 *
 * Replaces the earlier email + password form. The reasoning is in account.ts:
 * the deployment is pinned in code (no "Server" field in a consumer UI), the
 * website handles 2FA and password resets, and the app never receives a password.
 *
 * Flow:
 *   1. The renderer asks to sign in.
 *   2. The main process opens the ThinkFlyFlow sign-in page in the real browser.
 *   3. After sign-in, the site mints a single-use code and opens
 *      `thinkflyflow://auth?code=...`.
 *   4. Electron receives that deep link, exchanges it for a session, then mints a
 *      workspace-scoped `sk_` key for the sync engine.
 *   5. The key is stored encrypted; the renderer only ever sees the profile.
 */
import { app, BrowserWindow, safeStorage, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEEP_LINK_SCHEME = 'thinkflyflow';

const PRODUCTION_ORIGINS = { web: 'https://thinkflyflow.laureljar.com', api: 'https://api.laureljar.com' } as const;
const STAGING_ORIGINS = { web: 'https://thinkflyflow-test.laureljar.com', api: 'https://apitest.laureljar.com' } as const;

export interface AccountProfile {
  id?: number | string;
  email?: string;
  name?: string;
  username?: string;
  [key: string]: unknown;
}

export interface StoredSession {
  apiKey: string;
  profile: AccountProfile;
  workspaceId: string;
  workspaceName: string;
  signedInAt: number;
}

let webOrigin: string = PRODUCTION_ORIGINS.web;
let apiBase: string = `${PRODUCTION_ORIGINS.api}/api/v2`;

/**
 * A packaged build is always pinned to production. An unpackaged run can target
 * test only when BOTH variables are set, so one stray environment variable
 * cannot redirect a released build at the test backend.
 */
export function resolveAccountEnvironment(): void {
  const requested = process.env.TFF_ACCOUNT_ENV?.trim().toLowerCase() === 'staging';
  const allowed = process.env.TFF_ACCOUNT_ENV_ALLOW === '1';
  const packaged = typeof app?.isPackaged === 'boolean' ? app.isPackaged : true;

  // QA seam. A local fake backend has to be addressable, and the two shipped
  // environments above are the only ones a real user can ever reach. This is
  // gated on an explicit variable AND an unpackaged build, so a released
  // binary still cannot be redirected anywhere: the packaged branch below
  // always wins for packaged builds.
  const override = process.env.TFF_TEST_API_BASE?.trim();
  if (override && !packaged) {
    apiBase = override.replace(/\/+$/, '');
    webOrigin = process.env.TFF_TEST_WEB_ORIGIN?.trim() || webOrigin;
    return;
  }

  const origins = requested && allowed && !packaged ? STAGING_ORIGINS : PRODUCTION_ORIGINS;
  webOrigin = origins.web;
  apiBase = `${origins.api}/api/v2`;
}

export function getWebOrigin(): string {
  return webOrigin;
}

export function getApiBase(): string {
  return apiBase;
}

/** Register the deep-link scheme. Must run before `app.whenReady`. */
export function registerProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }
}

/** The page the browser opens. One page serves every ThinkFlyFlow desktop app. */
export function signInUrl(): string {
  const redirect = `${DEEP_LINK_SCHEME}://auth`;
  return `${webOrigin}/desktop-auth?app=${DEEP_LINK_SCHEME}&redirect=${encodeURIComponent(redirect)}`;
}

export async function openSignInPage(): Promise<void> {
  await shell.openExternal(signInUrl());
}

/**
 * Extract the code from `thinkflyflow://auth?code=...`.
 * Windows and Linux deliver host=auth; macOS may deliver a path instead, so both
 * are accepted. Anything else returns null and is treated as a normal launch.
 */
export function parseAuthDeepLink(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
    const host = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0];
    if (host !== 'auth') return null;
    const code = url.searchParams.get('code');
    return code && code.trim() ? code.trim() : null;
  } catch {
    return null;
  }
}

export function findDeepLink(argv: string[]): string | null {
  return argv.find((a) => typeof a === 'string' && a.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}

export class AccountStore {
  constructor(private readonly filePath: string) {}

  save(session: StoredSession): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'Secure credential storage is unavailable on this system, so your sign-in cannot be saved. ' +
          'You will need to sign in each time the app starts.',
      );
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const secret = safeStorage.encryptString(session.apiKey).toString('base64');
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({
        version: 1,
        secret,
        profile: session.profile,
        workspaceId: session.workspaceId,
        workspaceName: session.workspaceName,
        signedInAt: session.signedInAt,
      }),
      { mode: 0o600 },
    );
  }

  loadSync(): StoredSession | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as {
        secret?: string;
        profile?: AccountProfile;
        workspaceId?: string;
        workspaceName?: string;
        signedInAt?: number;
      };
      if (!parsed.secret) return null;
      const apiKey = safeStorage.decryptString(Buffer.from(parsed.secret, 'base64'));
      if (!apiKey) return null;
      return {
        apiKey,
        profile: parsed.profile ?? {},
        workspaceId: parsed.workspaceId ?? '',
        workspaceName: parsed.workspaceName ?? '',
        signedInAt: parsed.signedInAt ?? 0,
      };
    } catch {
      return null;
    }
  }

  clear(): void {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      /* already gone */
    }
  }
}

export function sessionPath(): string {
  return path.join(app.getPath('userData'), 'account.json');
}

interface JsonEnvelope<T> {
  success?: boolean;
  data?: T;
  user?: T;
  error?: string;
}

interface ExchangePayload {
  access?: string;
  refresh?: string;
  token?: string;
  user?: AccountProfile;
}

async function jsonRequest<T>(
  pathname: string,
  init: RequestInit = {},
  accessToken?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${apiBase}${pathname}`, { ...init, headers });
  const text = await res.text();
  let body: JsonEnvelope<T> | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as JsonEnvelope<T>;
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return (body?.data ?? body?.user ?? ({} as T)) as T;
}

/**
 * Exchange the single-use code for a session.
 * The endpoint returns a JWT pair; the desktop app immediately mints a
 * workspace-scoped `sk_` key so the sync engine has a stable long-lived
 * credential instead of a token that expires in hours.
 */
export async function exchangeCode(
  code: string,
): Promise<{ access: string; refresh?: string; profile: AccountProfile }> {
  const res = await fetch(`${apiBase}/auth/desktop/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code }),
  });
  const text = await res.text();
  let body: JsonEnvelope<ExchangePayload> | null = null;
  try {
    body = text ? (JSON.parse(text) as JsonEnvelope<ExchangePayload>) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new Error(body?.error || 'That sign-in link has expired. Start the sign-in again from the app.');
  }
  const access = body?.data?.access ?? body?.data?.token;
  if (!access) throw new Error('ThinkFlyFlow did not return a session. Try signing in again.');
  return { access, refresh: body?.data?.refresh, profile: body?.data?.user ?? {} };
}

interface WorkspaceSummary {
  id: string | number;
  name: string;
}

/**
 * Finish a sign-in: exchange the code, pick the workspace, mint the key.
 *
 * The workspace is chosen automatically when there is only one, which is the
 * common case and avoids a pointless decision in the UI. With several, the first
 * is used and the dashboard lets the user switch.
 */
export async function completeSignIn(
  code: string,
): Promise<{ apiKey: string; profile: AccountProfile; workspaceId: string; workspaceName: string }> {
  const session = await exchangeCode(code);

  const workspaces = await jsonRequest<WorkspaceSummary[]>('/workspaces/', {}, session.access);
  const list = Array.isArray(workspaces) ? workspaces : [];
  if (list.length === 0) {
    throw new Error('That account has no workspace yet. Create one on the ThinkFlyFlow website, then sign in again.');
  }
  const chosen = list[0];

  const created = await jsonRequest<{ key?: string; raw_key?: string; token?: string }>(
    '/api-keys/',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ThinkFlyFlow Desktop',
        workspace_id: chosen.id,
        // Explicit: an empty scope list grants nothing, because scopes are
        // enforced per view. Uploads need rest_api_write.
        scopes: ['rest_api', 'rest_api_write'],
      }),
    },
    session.access,
  );

  const apiKey = created.key ?? created.raw_key ?? created.token;
  if (!apiKey) throw new Error('ThinkFlyFlow did not return a desktop key. Try signing in again.');

  return {
    apiKey,
    profile: session.profile,
    workspaceId: String(chosen.id),
    workspaceName: chosen.name,
  };
}

export interface SignInOutcome {
  apiKey: string;
  profile: AccountProfile;
  workspaceId: string;
  workspaceName: string;
}

/**
 * Run a full sign-in and resolve when done.
 *
 * The deep link arrives on a different event than the one that started this, so
 * the promise is parked in a module-level resolver that the protocol handler
 * calls. A timeout stops the UI waiting forever if the user closes the browser.
 */
let pendingSignIn: {
  resolve: (value: SignInOutcome) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
} | null = null;

export function openSignIn(): Promise<SignInOutcome> {
  if (pendingSignIn) {
    clearTimeout(pendingSignIn.timer);
    pendingSignIn.reject(new Error('Superseded by a new sign-in attempt.'));
    pendingSignIn = null;
  }

  return new Promise<SignInOutcome>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        pendingSignIn = null;
        reject(new Error('Sign-in timed out. Open the app and try again.'));
      },
      5 * 60 * 1000,
    );
    pendingSignIn = { resolve, reject, timer };
    void openSignInPage().catch((err) => {
      clearTimeout(timer);
      pendingSignIn = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/** Called by the protocol/deep-link handler with an incoming URL. */
export async function handleDeepLink(rawUrl: string): Promise<void> {
  const code = parseAuthDeepLink(rawUrl);
  if (!code) return;
  const waiting = pendingSignIn;
  if (!waiting) return; // a stale activation: nothing is waiting for it
  try {
    const outcome = await completeSignIn(code);
    clearTimeout(waiting.timer);
    pendingSignIn = null;
    waiting.resolve(outcome);
  } catch (err) {
    clearTimeout(waiting.timer);
    pendingSignIn = null;
    waiting.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Probe a stored key and refresh the profile.
 *
 * Only clears the session when the server actually refuses the key. A network
 * failure keeps the session, so an offline launch does not sign the user out.
 */
export async function verifySession(store: AccountStore): Promise<StoredSession | null> {
  const session = store.loadSync();
  if (!session) return null;
  try {
    const res = await fetch(`${apiBase}/auth/me/`, {
      headers: { Authorization: `Bearer ${session.apiKey}`, Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      store.clear();
      return null;
    }
    if (!res.ok) return session;
    const body = (await res.json()) as { user?: AccountProfile; data?: AccountProfile };
    return { ...session, profile: body.user ?? body.data ?? session.profile };
  } catch {
    return session;
  }
}

export function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function cancelPendingSignIn(): void {
  if (pendingSignIn) {
    clearTimeout(pendingSignIn.timer);
    pendingSignIn = null;
  }
}
