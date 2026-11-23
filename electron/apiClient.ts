/**
 * ThinkFlyFlow API client.
 *
 * Auth is the `sk_` API credential (workspace-scoped, server stores only a
 * SHA-256 hash). It is never written to disk by this module: the caller
 * supplies it from the OS keychain on each launch.
 */

export interface LookupResult {
  /** Lowercase hash to the files that already hold that content. */
  matches: Record<string, { id: string; original_name: string; size: number; status: string }[]>;
  /** Hashes the server does not have, so the client must upload them. */
  missing: string[];
}

export interface UploadResult {
  id: string;
  original_name: string;
  size: number;
  status: string;
  file_type?: string;
  message?: string;
}

export interface WorkspaceSummary {
  id: string | number;
  name: string;
}

export interface ProjectSummary {
  id: string | number;
  name: string;
}

export interface SearchFileHit {
  id: string;
  name: string;
  file_type?: string;
  project_id?: string;
  project_name?: string;
  folder_path?: string;
  size_display?: string;
  matched_on?: string;
  snippet?: string;
}

export interface SearchProjectHit {
  id: string;
  name: string;
  workspace_name?: string;
  file_count?: number;
}

export interface SearchFolderHit {
  id: string;
  name: string;
  path?: string;
  project_id?: string;
  project_name?: string;
}

export interface SearchResponse {
  projects: SearchProjectHit[];
  folders: SearchFolderHit[];
  files: SearchFileHit[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Retrying these is pointless: the request itself is wrong or refused. */
  get isPermanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Injected so tests do not need a live network. */
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      ...extra,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init.headers as Record<string, string> | undefined),
    });

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!res.ok) {
      const raw = body && typeof body === 'object' && 'error' in body ? (body as { error: unknown }).error : null;
      const message = raw != null && raw !== '' ? String(raw) : `Request failed with status ${res.status}`;
      throw new ApiError(message, res.status, body);
    }
    return body as T;
  }

  async me(): Promise<{ success: boolean; user: unknown }> {
    return this.request('/api/v2/auth/me/');
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const res = await this.request<{ success: boolean; data?: WorkspaceSummary[] }>('/api/v2/workspaces/');
    return res.data ?? [];
  }

  /**
   * Create a project. Used once, to give a brand new workspace somewhere to sync
   * into: the desktop app is a companion, so it cannot require the user to have
   * visited the website first and made one by hand.
   */
  async createProject(workspaceId: string | number, name: string): Promise<ProjectSummary> {
    const res = await this.request<{ success: boolean; data: ProjectSummary }>(
      `/api/v2/workspaces/${workspaceId}/projects/`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `workspace` is required IN THE BODY; the view reads it from the
        // serializer rather than inferring it from the URL path.
        body: JSON.stringify({ name, workspace: workspaceId }),
      },
    );
    if (!res?.data) throw new Error('Project creation returned no data');
    return res.data;
  }

  async listProjects(workspaceId: string | number): Promise<ProjectSummary[]> {
    const res = await this.request<{ success: boolean; data?: ProjectSummary[] }>(
      `/api/v2/workspaces/${workspaceId}/projects/`,
    );
    return res.data ?? [];
  }

  /**
   * Ask which of these hashes the project already holds.
   * Batched at 500 because the server caps a single request there.
   */
  async lookupHashes(projectId: string | number, hashes: string[]): Promise<LookupResult> {
    const matches: LookupResult['matches'] = {};
    const missing: string[] = [];

    for (let i = 0; i < hashes.length; i += 500) {
      const chunk = hashes.slice(i, i + 500);
      const res = await this.request<{ success: boolean; data: LookupResult }>('/api/v2/files/lookup/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, hashes: chunk }),
      });
      Object.assign(matches, res.data.matches);
      missing.push(...res.data.missing);
    }

    return { matches, missing };
  }

  async uploadFile(
    projectId: string | number,
    filePath: string,
    fileName: string,
    data: Buffer,
    mimeType = 'application/octet-stream',
  ): Promise<UploadResult> {
    void filePath; // path is intentionally not sent: the server never needs the local layout
    const form = new FormData();
    form.append('project_id', String(projectId));
    // Buffer -> Blob is the portable way to hand binary data to fetch in Node.
    form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), fileName);

    const res = await this.request<{ success: boolean; data: UploadResult }>('/api/v2/files/upload/', {
      method: 'POST',
      body: form,
    });
    return res.data;
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v2/files/${fileId}/download/`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new ApiError(`Download failed with status ${res.status}`, res.status);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Global search across the account.
   *
   * Hits `/search/` rather than `/search/semantic/`: the global endpoint
   * matches on name, extracted text, AI summary and tags, and returns
   * projects/folders/files with the metadata needed to open each hit. The
   * semantic endpoint returns bare chunks with no way to open a file.
   */
  async search(query: string): Promise<SearchResponse> {
    const res = await this.request<{ success: boolean; data?: SearchResponse }>(
      `/api/v2/search/?q=${encodeURIComponent(query)}`,
    );
    return res.data ?? { projects: [], folders: [], files: [] };
  }
}

/**
 * List workspaces during sign-in, before an `sk_` key exists.
 *
 * The desktop client needs the workspace id to issue a workspace-scoped key,
 * but it cannot list workspaces without credentials. This does the login and the
 * listing in one step and never persists the password or the JWT: only the
 * resulting `sk_` key is kept.
 */
export async function fetchWorkspacesForSignIn(
  baseUrl: string,
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ access: string; workspaces: WorkspaceSummary[] }> {
  const base = baseUrl.replace(/\/+$/, '');
  const loginRes = await fetchImpl(`${base}/api/v2/auth/login/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    throw new ApiError('Sign in failed. Check your email and password.', loginRes.status);
  }
  const login = (await loginRes.json()) as { access?: string };
  if (!login.access) {
    throw new ApiError('Sign in returned no access token.', 500, login);
  }

  const wsRes = await fetchImpl(`${base}/api/v2/workspaces/`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${login.access}` },
  });
  if (!wsRes.ok) {
    throw new ApiError('Could not list workspaces.', wsRes.status);
  }
  const body = (await wsRes.json()) as { data?: WorkspaceSummary[] };
  return { access: login.access, workspaces: body.data ?? [] };
}

/**
 * Create a workspace-scoped `sk_` key from an email/password login.
 * Used once, during sign-in, then the key (not the password) is stored.
 */
export async function createApiKey(
  baseUrl: string,
  email: string,
  password: string,
  workspaceId: string | number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const base = baseUrl.replace(/\/+$/, '');
  const loginRes = await fetchImpl(`${base}/api/v2/auth/login/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    throw new ApiError('Sign in failed. Check your email and password.', loginRes.status);
  }
  const login = (await loginRes.json()) as { access?: string };
  if (!login.access) {
    throw new ApiError('Sign in returned no access token.', 500, login);
  }

  const keyRes = await fetchImpl(`${base}/api/v2/api-keys/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${login.access}`,
    },
    body: JSON.stringify({
      name: 'ThinkFlyFlow Desktop',
      workspace_id: workspaceId,
      // Explicit, not omitted. An empty scope list grants nothing: scopes are
      // enforced per view via RequireScope, so a key without rest_api_write
      // can read but never upload.
      scopes: ['rest_api', 'rest_api_write'],
    }),
  });
  if (!keyRes.ok) {
    const body = await keyRes.text();
    throw new ApiError('Could not create a desktop key.', keyRes.status, body);
  }

  const created = (await keyRes.json()) as {
    data?: { key?: string; token?: string; raw_key?: string };
    key?: string;
  };
  // The raw value is only ever returned once, so accept whichever field the
  // API used rather than guessing a single shape.
  const raw = created.data?.key ?? created.data?.raw_key ?? created.data?.token ?? created.key;
  if (!raw) {
    throw new ApiError('Key created but the raw value was not returned.', 500, created);
  }
  return raw;
}
