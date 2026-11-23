import { useEffect, useState } from 'react';
import { bridge } from './bridge';
import type { StatusSnapshot } from '../electron/ipc';
import { SignIn } from './SignIn';
import { Dashboard } from './Dashboard';

export function App() {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const tff = bridge();
      void tff.getStatus().then(setStatus).catch((e) => setError(String(e)));
      unsubscribe = tff.onStatus(setStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    return () => unsubscribe?.();
  }, []);

  if (error) {
    return (
      <div className="centered">
        <div className="card">
          <h1>ThinkFlyFlow</h1>
          <p className="error">{error}</p>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="centered">
        <p className="muted">Starting...</p>
      </div>
    );
  }

  return status.signedIn ? (
    <Dashboard status={status} />
  ) : (
    <SignIn onSignedIn={(s) => setStatus(s)} />
  );
}
