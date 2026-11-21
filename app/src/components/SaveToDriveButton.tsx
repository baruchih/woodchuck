import { useState, useEffect, useCallback } from 'react';
import type { MouseEvent, KeyboardEvent } from 'react';
import { api } from '../api/client';
import type { DriveStatus } from '../types';

// One status request shared by every button, refreshed at most once a minute
let statusCache: { at: number; promise: Promise<DriveStatus | null> } | null = null;
const STATUS_TTL_MS = 60_000;

function loadDriveStatus(): Promise<DriveStatus | null> {
  if (!statusCache || Date.now() - statusCache.at > STATUS_TTL_MS) {
    statusCache = { at: Date.now(), promise: api.getDriveStatus().catch(() => null) };
  }
  return statusCache.promise;
}

/** Whether Save to Drive is set up on the server (false until known) */
function useDriveAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadDriveStatus().then((s) => { if (alive) setAvailable(!!s?.available); });
    return () => { alive = false; };
  }, []);
  return available;
}

interface SaveToDriveButtonProps {
  sessionId: string;
  /** File or folder path, relative to the session's project folder */
  path: string;
  name: string;
  /** 'icon' for file-tree rows, 'labeled' for viewer headers */
  variant?: 'icon' | 'labeled';
  /** Render as a span, for use inside another button (folder rows) */
  asSpan?: boolean;
  className?: string;
}

type Phase = 'idle' | 'saving' | 'saved' | 'error';

const DriveIcon = ({ className }: { className: string }) => (
  // Cloud with an up arrow
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M17.5 19H7a5 5 0 1 1 1.1-9.88A6 6 0 0 1 19.5 11a4 4 0 0 1-2 8" />
    <polyline points="9 14 12 11 15 14" />
    <line x1="12" y1="11" x2="12" y2="19" />
  </svg>
);

/**
 * Uploads a session file or folder to Google Drive (server side, via rclone).
 * Hidden until the server reports Drive is set up.
 */
export function SaveToDriveButton({ sessionId, path, name, variant = 'icon', asSpan = false, className = '' }: SaveToDriveButtonProps) {
  const available = useDriveAvailable();
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);

  // "Saved" / "Failed" notes fade back to the normal button
  useEffect(() => {
    if (phase !== 'saved' && phase !== 'error') return;
    const t = setTimeout(() => setPhase('idle'), phase === 'saved' ? 5000 : 8000);
    return () => clearTimeout(t);
  }, [phase]);

  const handleActivate = useCallback(async (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (phase === 'saving') return;
    setPhase('saving');
    setMessage(null);
    try {
      const res = await api.saveToDrive(sessionId, path);
      setMessage(`Saved to ${res.saved_to}`);
      setPhase('saved');
    } catch (err) {
      setMessage((err as Error).message);
      setPhase('error');
    }
  }, [phase, sessionId, path]);

  if (!available) return null;

  const notice = phase === 'saving' ? 'Saving…' : phase === 'saved' ? 'Saved to Drive' : phase === 'error' ? 'Drive failed' : null;
  const title = message ?? `Save ${name} to Google Drive`;
  const iconClass = variant === 'icon' ? 'w-3.5 h-3.5' : 'w-3 h-3';
  const highlight = phase === 'saved' ? 'text-status-success' : phase === 'error' ? 'text-status-error' : '';

  const content = (
    <>
      {phase === 'saving' ? (
        <svg className={`${iconClass} animate-spin`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <DriveIcon className={iconClass} />
      )}
      {notice ? (
        <span className="whitespace-nowrap">{notice}</span>
      ) : variant === 'labeled' && (
        // Viewer headers are tight on phones: icon only there
        <span className="hidden sm:inline">Drive</span>
      )}
    </>
  );

  const classes = variant === 'icon'
    ? `shrink-0 flex items-center gap-1 p-0.5 rounded text-[10px] text-text-muted hover:text-primary transition-opacity ${highlight} ${className}`
    : `flex items-center gap-1 px-2 py-1 rounded border border-border text-[11px] font-medium text-text-muted hover:text-primary hover:border-primary transition-colors ${highlight} ${className}`;

  if (asSpan) {
    return (
      <span
        role="button"
        tabIndex={0}
        className={classes}
        aria-label={`Save ${name} to Drive`}
        title={title}
        onClick={handleActivate}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') void handleActivate(e); }}
      >
        {content}
      </span>
    );
  }
  return (
    <button type="button" className={classes} aria-label={`Save ${name} to Drive`} title={title} onClick={handleActivate}>
      {content}
    </button>
  );
}
