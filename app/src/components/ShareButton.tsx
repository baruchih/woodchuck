import { useState, useCallback } from 'react';
import type { MouseEvent, KeyboardEvent } from 'react';
import { canShareFiles, fetchShareableFile } from '../utils/shareFile';

interface ShareButtonProps {
  /** Server URL that returns the file's bytes */
  url: string;
  /** File name as it should arrive in the receiving app */
  name: string;
  /** Treat unknown extensions as text/plain (code, markdown, logs) */
  isText?: boolean;
  /** 'icon' for file-tree rows, 'labeled' for viewer headers */
  variant?: 'icon' | 'labeled';
  /** Render as a span, for use inside another button (folder rows) */
  asSpan?: boolean;
  className?: string;
}

type Phase = 'idle' | 'loading' | 'ready' | 'error';

function downloadFile(file: File) {
  const href = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = href;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

const ShareIcon = ({ className }: { className: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
    <polyline points="16 6 12 2 8 6" />
    <line x1="12" y1="2" x2="12" y2="15" />
  </svg>
);

/**
 * Opens the device share sheet with a session file (Drive, Files, chat apps...).
 * Hidden where the browser can't share files.
 */
export function ShareButton({ url, name, isText = false, variant = 'icon', asSpan = false, className = '' }: ShareButtonProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [readyFile, setReadyFile] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const share = useCallback(async (file: File) => {
    try {
      await navigator.share({ files: [file] });
      setPhase('idle');
      setReadyFile(null);
    } catch (err) {
      const errName = (err as DOMException)?.name;
      if (errName === 'AbortError') {
        // Share sheet dismissed
        setPhase('idle');
        setReadyFile(null);
      } else if (errName === 'NotAllowedError') {
        // Fetching took too long and the browser no longer counts this as a tap
        // (Safari). Keep the file so the next tap shares it immediately.
        setReadyFile(file);
        setPhase('ready');
      } else {
        setPhase('error');
        setMessage(`Share failed: ${(err as Error).message}`);
      }
    }
  }, []);

  const handleActivate = useCallback(async (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (phase === 'loading') return;
    if (readyFile) {
      await share(readyFile);
      return;
    }
    setPhase('loading');
    setMessage(null);
    let file: File;
    try {
      file = await fetchShareableFile(url, name, isText);
    } catch (err) {
      setPhase('error');
      setMessage(`Couldn't load file: ${(err as Error).message}`);
      return;
    }
    if (!navigator.canShare({ files: [file] })) {
      // This browser won't share this file type; save it instead
      downloadFile(file);
      setPhase('idle');
      setMessage("This browser can't share this file type, so it was downloaded");
      return;
    }
    await share(file);
  }, [phase, readyFile, url, name, isText, share]);

  if (!canShareFiles()) return null;

  const label = phase === 'loading' ? 'Preparing…' : phase === 'ready' ? 'Tap to share' : 'Share';
  const title = message ?? (phase === 'ready' ? 'File ready, tap again to share' : `Share ${name}`);
  const iconClass = variant === 'icon' ? 'w-3.5 h-3.5' : 'w-3 h-3';
  const highlight = phase === 'ready' ? 'text-primary border-primary' : phase === 'error' ? 'text-status-error' : '';

  const content = (
    <>
      {phase === 'loading' ? (
        <svg className={`${iconClass} animate-spin`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : (
        <ShareIcon className={iconClass} />
      )}
      {phase === 'ready' ? (
        <span>{label}</span>
      ) : variant === 'labeled' && (
        // Viewer headers are tight on phones: icon only there
        <span className="hidden sm:inline">{label}</span>
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
        aria-label={`Share ${name}`}
        title={title}
        onClick={handleActivate}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') void handleActivate(e); }}
      >
        {content}
      </span>
    );
  }
  return (
    <button type="button" className={classes} aria-label={`Share ${name}`} title={title} onClick={handleActivate}>
      {content}
    </button>
  );
}
