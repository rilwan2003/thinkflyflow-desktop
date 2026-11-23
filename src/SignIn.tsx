import { useEffect, useState } from 'react';
import { bridge, secureStorageAvailable } from './bridge';
import type { StatusSnapshot } from '../electron/ipc';
import logoUrl from './assets/logo.png';

/**
 * Sign-in.
 *
 * There is no form here on purpose. The app opens the ThinkFlyFlow sign-in page
 * in the real browser, which already handles 2FA, password resets and single
 * sign-on, and hands back a single-use code. The user therefore types their
 * password on the product's own login page, never into a dialog that only claims
 * to be ThinkFlyFlow.
 *
 * The old version asked for a server address, an email and a password here. The
 * server field was a developer setting leaking into the UI, and the form could
 * not support 2FA at all.
 */
export function SignIn({ onSignedIn }: { onSignedIn: (s: StatusSnapshot) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canStore, setCanStore] = useState(true);

  useEffect(() => {
    void secureStorageAvailable().then(setCanStore);
  }, []);

  async function start() {
    setError(null);
    setBusy(true);
    try {
      const res = await bridge().signIn();
      if (!res.ok) {
        setError(res.error ?? 'Sign in failed.');
        return;
      }
      onSignedIn(await bridge().getStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    await bridge().cancelSignIn();
    setBusy(false);
    setError(null);
  }

  return (
    <div className="centered">
      <div className="card">
        <div className="brand">
          <img src={logoUrl} alt="" />
          <div className="brand-text">
            <strong>ThinkFlyFlow</strong>
            <span>Desktop</span>
          </div>
        </div>

        <h1>Sign in to sync your files</h1>
        <p className="muted small">
          Your browser opens so you can sign in to ThinkFlyFlow. Once you are signed in,
          this app picks up where you left off and starts syncing the folders you choose.
        </p>

        {error && <p className="error">{error}</p>}

        {!canStore && (
          <p className="warn">
            This system has no secure credential storage, so your sign-in cannot be saved.
            You will need to sign in each time the app starts.
          </p>
        )}

        <button onClick={() => void start()} disabled={busy}>
          {busy ? 'Waiting for your browser…' : 'Sign in with ThinkFlyFlow'}
        </button>

        {busy && (
          <button type="button" className="link" onClick={() => void cancel()}>
            Cancel
          </button>
        )}

        <p className="fine">
          No password is entered here. The app receives a single-use code, never your
          credentials.
        </p>
      </div>
    </div>
  );
}
