import { useEffect, useState } from 'react';
import { bridge } from './bridge';
import type { ProjectOption, SearchHit, StatusSnapshot } from '../electron/ipc';

export function Dashboard({ status }: { status: StatusSnapshot }) {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState('');
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bridge()
      .listProjects('')
      .then((list) => {
        setProjects(list);
        if (list.length > 0) setProjectId(String(list[0].id));
      })
      .catch(() => setProjects([]));
  }, []);

  async function addFolder() {
    setError(null);
    const folder = await bridge().pickFolder();
    if (!folder) return;
    if (!projectId) {
      setError('Choose a project first.');
      return;
    }
    setAdding(true);
    try {
      await bridge().addRoot(folder, projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setHits(await bridge().search(query.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setHits([]);
    } finally {
      setSearching(false);
    }
  }

  const paused = status.status === 'paused';

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <strong>ThinkFlyFlow</strong>
          <span className="muted"> · {status.workspaceName ?? 'workspace'}</span>
        </div>
        <div className="topbar-actions">
          <span className={`pill ${status.status}`}>{label(status.status)}</span>
          <button onClick={() => (paused ? bridge().resume() : bridge().pause())}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button className="link" onClick={() => void bridge().signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <section className="stats">
        <Stat label="Synced" value={status.counts.synced} />
        <Stat label="Pending" value={status.counts.pending} />
        <Stat label="Failed" value={status.counts.failed} tone={status.counts.failed > 0 ? 'bad' : undefined} />
        <Stat label="Skipped" value={status.counts.skipped} />
      </section>

      <section className="panel">
        <h2>Watched folders</h2>
        <p className="muted small">
          Files in these folders upload automatically and are sorted by the AI.
          Deleting a file here never deletes it from your workspace.
        </p>

        <div className="row">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.length === 0 && <option value="">Loading projects...</option>}
            {projects.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </select>
          <button onClick={() => void addFolder()} disabled={adding || !projectId}>
            {adding ? 'Adding...' : 'Add folder'}
          </button>
        </div>

        {status.roots.length === 0 ? (
          <p className="empty">No folders are being watched yet.</p>
        ) : (
          <ul className="roots">
            {status.roots.map((r) => (
              <li key={r.id}>
                <span className="path" title={r.path}>
                  {r.path}
                </span>
                <button className="link" onClick={() => void bridge().removeRoot(r.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Find a file</h2>
        <form className="row" onSubmit={runSearch}>
          <input
            type="search"
            placeholder="Ask for a file, for example: Q3 invoices"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" disabled={searching || !query.trim()}>
            {searching ? 'Searching...' : 'Search'}
          </button>
        </form>

        {hits !== null &&
          (hits.length === 0 ? (
            <p className="empty">Nothing matched that.</p>
          ) : (
            <ul className="hits">
              {hits.map((h) => (
                <li key={`${h.kind}-${h.id}`}>
                  <span>
                    {h.name}
                    {h.context ? <span className="muted small"> · {h.context}</span> : null}
                  </span>
                  <span className="badge cloud">{h.kind}</span>
                </li>
              ))}
            </ul>
          ))}
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'bad' }) {
  return (
    <div className={`stat ${tone === 'bad' ? 'stat-bad' : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function label(s: StatusSnapshot['status']): string {
  switch (s) {
    case 'syncing':
      return 'Syncing';
    case 'paused':
      return 'Paused';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
}
