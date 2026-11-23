import { useEffect, useState } from 'react';
import { DEFAULT_BASE_URL, bridge, secureStorageAvailable } from './bridge';
import type { StatusSnapshot, WorkspaceOption } from '../electron/ipc';

/**
 * Sign-in.
 *
 * Two steps on purpose: the workspace must be chosen before a key can be
 * issued, because keys are workspace-scoped. Signing in without a workspace
 * would either need a global key (too broad) or guess (wrong).
 */
export function SignIn({ onSignedIn }: { onSignedIn: (s: StatusSnapshot) => void }) {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canStore, setCanStore] = useState(true);

  useEffect(() => {
    void secureStorageAvailable().then(setCanStore);
  }, []);

  async function loadWorkspaces(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const list = await bridge().listWorkspaces(baseUrl, email.trim(), password);
      if (list.length === 0) {
        setError('No workspaces found on that account.');
        return;
      }
      setWorkspaces(list);
      setWorkspaceId(String(list[0].id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function finish(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await bridge().signIn({
        baseUrl,
        email: email.trim(),
        password,
        workspaceId,
      });
      if (!res.ok) {
        setError(res.error ?? 'Sign in failed.');
        return;
      }
      // Clear the password from component state as soon as it is no longer needed.
      setPassword('');
      onSignedIn(await bridge().getStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <form className="card" onSubmit={workspaces ? finish : loadWorkspaces}>
        <h1>ThinkFlyFlow</h1>
        <p className="muted">
          Sign in to sync the files on this computer with your workspace.
        </p>

        {!workspaces ? (
          <>
            <label>
              Server
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
                spellCheck={false}
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
                autoFocus
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </label>
          </>
        ) : (
          <label>
            Workspace
            <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={String(w.id)}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {error && <p className="error">{error}</p>}

        {!canStore && (
          <p className="warn">
            This system has no secure credential storage, so your key cannot be saved.
            You will need to sign in each time you launch the app.
          </p>
        )}

        <button type="submit" disabled={busy}>
          {busy ? 'Working...' : workspaces ? 'Start syncing' : 'Continue'}
        </button>

        {workspaces && (
          <button
            type="button"
            className="link"
            onClick={() => {
              setWorkspaces(null);
              setWorkspaceId('');
            }}
          >
            Use a different account
          </button>
        )}

        <p className="fine">
          Your password is used once to issue a key for this workspace and is never stored.
        </p>
      </form>
    </div>
  );
}
