import { useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from './bridge';
import type { LocalFileHit, SearchHit } from '../electron/ipc';

/**
 * The search palette.
 *
 * Two result sources, shown in one list because the user does not care where a
 * file lives:
 *   - the cloud workspace (name, content, summary, tags)
 *   - this machine's synced files (path match)
 *
 * Keyboard first: type, arrow, Enter. Escape dismisses. Mouse works but is not
 * required.
 */
type Row =
  | { kind: 'cloud'; hit: SearchHit }
  | { kind: 'local'; hit: LocalFileHit };

export function SearchPalette() {
  const [query, setQuery] = useState('');
  const [cloud, setCloud] = useState<SearchHit[]>([]);
  const [local, setLocal] = useState<LocalFileHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus and reset whenever the window is summoned.
  useEffect(() => {
    const unsubscribe = bridge().onSearchWindowShown(() => {
      setQuery('');
      setCloud([]);
      setLocal([]);
      setCursor(0);
      setError(null);
      inputRef.current?.focus();
    });
    inputRef.current?.focus();
    return unsubscribe;
  }, []);

  // Debounced search across both sources.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setCloud([]);
      setLocal([]);
      setCursor(0);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const [cloudHits, localHits] = await Promise.all([
          bridge().search(q),
          bridge().localFiles(q),
        ]);
        if (cancelled) return;
        setCloud(cloudHits);
        setLocal(localHits);
        setCursor(0);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  const rows: Row[] = useMemo(
    () => [
      ...local.map((hit) => ({ kind: 'local' as const, hit })),
      ...cloud.map((hit) => ({ kind: 'cloud' as const, hit })),
    ],
    [cloud, local],
  );

  async function activate(row: Row) {
    if (row.kind === 'local') {
      await bridge().openFile(row.hit.localPath);
      await bridge().hideSearchWindow();
      return;
    }
    // A cloud hit lives in the web app; open it there rather than inventing a
    // download target the user did not ask for.
    await bridge().openExternal('https://thinkflyflow.laureljar.com');
    await bridge().hideSearchWindow();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      void bridge().hideSearchWindow();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(rows.length - 1, 0)));
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    }
    if (e.key === 'Enter' && rows[cursor]) {
      e.preventDefault();
      void activate(rows[cursor]);
    }
  }

  return (
    <div className="palette" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className="palette-input"
        type="text"
        placeholder="Search your files, by name or by what is inside them"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
        autoFocus
      />

      <div className="palette-results">
        {error && <p className="error">{error}</p>}
        {!error && query.trim() === '' && (
          <p className="empty">Start typing to search this machine and your workspace.</p>
        )}
        {!error && query.trim() !== '' && !loading && rows.length === 0 && (
          <p className="empty">
            Nothing matched that. Files just added take a moment to appear while
            ThinkFlyFlow reads them.
          </p>
        )}
        {loading && <p className="empty">Searching...</p>}

        {rows.map((row, i) => (
          <div
            key={`${row.kind}-${row.kind === 'local' ? row.hit.localPath : row.hit.id}`}
            className={`palette-row ${i === cursor ? 'active' : ''}`}
            onMouseEnter={() => setCursor(i)}
            onClick={() => void activate(row)}
          >
            {row.kind === 'local' ? (
              <>
                <span className="badge local">This Mac</span>
                <span className="row-main">
                  <span className="row-name">{baseName(row.hit.localPath)}</span>
                  <span className="row-context">{row.hit.localPath}</span>
                </span>
                {!row.hit.exists && <span className="badge warn">missing</span>}
              </>
            ) : (
              <>
                <span className="badge cloud">{row.hit.kind}</span>
                <span className="row-main">
                  <span className="row-name">{row.hit.name}</span>
                  <span className="row-context">
                    {row.hit.matchedOn ? `matched on ${row.hit.matchedOn} · ` : ''}
                    {row.hit.context ?? ''}
                  </span>
                </span>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="palette-footer">
        <span>↑↓ move</span>
        <span>↵ open</span>
        <span>esc close</span>
      </div>
    </div>
  );
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
