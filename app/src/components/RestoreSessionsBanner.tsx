import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type { OrphanedSession } from '../types';

interface RestoreSessionsBannerProps {
  /** Called after sessions were restored, to reload the session list */
  onRestored: () => void;
}

/**
 * After a crash (tmux server or Mac restart), offers to restore every session
 * that was running, each continuing its last conversation — like a browser's
 * "Restore pages".
 */
export function RestoreSessionsBanner({ onRestored }: RestoreSessionsBannerProps) {
  const [orphans, setOrphans] = useState<OrphanedSession[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);

  const load = useCallback(() => {
    api.getOrphanedSessions().then((data) => setOrphans(data.sessions)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // The server may come back after the page: check again when the app returns to view
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const restore = useCallback(async (targets: OrphanedSession[]) => {
    setBusy(true);
    const errors: string[] = [];
    // One at a time, so a dozen agents don't all start at once
    for (let i = 0; i < targets.length; i++) {
      const s = targets[i];
      setProgress(targets.length > 1 ? `Restoring ${i + 1} of ${targets.length}: ${s.name}` : `Restoring ${s.name}`);
      try {
        await api.recoverSession(s.id);
        setOrphans((prev) => prev.filter((o) => o.id !== s.id));
      } catch (err) {
        errors.push(`${s.name}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }
    setFailed(errors);
    setProgress(null);
    setBusy(false);
    onRestored();
  }, [onRestored]);

  const discard = useCallback(async (targets: OrphanedSession[]) => {
    setBusy(true);
    for (const s of targets) {
      try {
        await api.discardOrphanedSession(s.id);
        setOrphans((prev) => prev.filter((o) => o.id !== s.id));
      } catch {
        // Leave it listed so it can be retried
      }
    }
    setBusy(false);
  }, []);

  if (orphans.length === 0 && failed.length === 0) return null;

  const count = orphans.length;
  return (
    <div className="mx-4 mt-4 rounded border border-primary/50 bg-primary/10 px-3 py-2.5 text-sm" role="region" aria-label="Restore sessions">
      {count > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex-1 min-w-[12rem] text-text">
              {count === 1 ? '1 session was' : `${count} sessions were`} closed unexpectedly.
            </p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => restore(orphans)}
                disabled={busy}
                className="px-2.5 py-1 rounded bg-primary text-background text-xs font-bold uppercase tracking-wide disabled:opacity-50 btn-active"
              >
                Restore all
              </button>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                disabled={busy}
                className="px-2.5 py-1 rounded border border-border text-xs text-text-muted hover:text-text disabled:opacity-50"
                aria-expanded={expanded}
              >
                {expanded ? 'Hide' : 'Choose'}
              </button>
            </div>
          </div>
          {progress && <p className="mt-1.5 text-xs text-text-muted">{progress}…</p>}
          {expanded && (
            <ul className="mt-2 space-y-1">
              {orphans.map((s) => (
                <li key={s.id} className="flex items-center gap-2 rounded bg-background/60 px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-text truncate">{s.name}</p>
                    <p className="text-[10px] text-text-muted truncate">{s.last_input || s.folder}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => restore([s])}
                    disabled={busy}
                    className="px-2 py-0.5 rounded border border-primary/60 text-[11px] text-primary disabled:opacity-50"
                    aria-label={`Restore ${s.name}`}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => discard([s])}
                    disabled={busy}
                    className="px-2 py-0.5 rounded border border-border text-[11px] text-text-muted hover:text-status-error disabled:opacity-50"
                    aria-label={`Discard ${s.name}`}
                  >
                    Discard
                  </button>
                </li>
              ))}
              <li className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={() => discard(orphans)}
                  disabled={busy}
                  className="text-[11px] text-text-muted hover:text-status-error disabled:opacity-50"
                >
                  Discard all
                </button>
              </li>
            </ul>
          )}
        </>
      )}
      {failed.length > 0 && (
        <div className="mt-1.5 text-xs text-status-error">
          <p>Couldn't restore:</p>
          <ul className="list-disc pl-4">
            {failed.map((f) => <li key={f}>{f}</li>)}
          </ul>
          <button type="button" onClick={() => setFailed([])} className="mt-1 text-text-muted underline">Dismiss</button>
        </div>
      )}
    </div>
  );
}
