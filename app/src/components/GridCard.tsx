import { useMemo } from 'react';
import type { Session } from '../types';
import { StatusBadge } from './StatusBadge';
import { ansiToHtml } from '../utils/ansi';
import { getFolderName } from '../utils/path';

interface GridCardProps {
  session: Session;
  output: string;
  onClick: () => void;
  onDelete?: (sessionId: string) => void;
  onShowInfo?: (session: Session) => void;
  selected?: boolean;
}

/** Max lines to show in the mini terminal preview */
const PREVIEW_LINES = 12;

/**
 * Extract the last N non-empty lines from terminal output for preview.
 * Strips trailing whitespace-only lines.
 */
function getPreviewLines(output: string, maxLines: number): string {
  if (!output) return '';
  const lines = output.split('\n');
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.slice(-maxLines).join('\n');
}

export function GridCard({
  session,
  output,
  onClick,
  onDelete,
  onShowInfo,
  selected = false,
}: GridCardProps) {
  const previewHtml = useMemo(() => {
    const preview = getPreviewLines(output, PREVIEW_LINES);
    return preview ? ansiToHtml(preview) : '';
  }, [output]);

  return (
    <button
      onClick={onClick}
      className={`w-full bg-surface border rounded-sm text-left card-interactive flex flex-col overflow-hidden ${
        selected
          ? 'border-primary ring-1 ring-primary'
          : 'border-border hover:border-text-muted'
      }`}
      aria-label={`Session ${session.name} - ${session.status}`}
      data-session-id={session.id}
    >
      {/* Header: name + status + actions */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <StatusBadge status={session.status} size="sm" workingSince={session.working_since} />
          <span className="text-text font-medium text-xs truncate">{session.name}</span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {onShowInfo && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onShowInfo(session);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  e.preventDefault();
                  onShowInfo(session);
                }
              }}
              className="p-1 rounded-sm text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
              aria-label={`Info for ${session.name}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </span>
          )}
          {onDelete && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(session.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  e.preventDefault();
                  onDelete(session.id);
                }
              }}
              className="p-1 rounded-sm text-text-muted hover:text-status-error hover:bg-status-error/10 transition-colors"
              aria-label={`Delete ${session.name}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </span>
          )}
        </div>
      </div>

      {/* Mini terminal preview */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <pre
          className="px-2 py-1.5 text-[10px] leading-[14px] text-text font-mono whitespace-pre-wrap break-all h-full overflow-hidden bg-background"
          dangerouslySetInnerHTML={{ __html: previewHtml || '<span class="text-text-muted">No output</span>' }}
        />
      </div>

      {/* Footer: folder + branch */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-t border-border text-text-muted text-[10px] min-w-0">
        <span className="truncate">{getFolderName(session.folder)}</span>
        {session.git_branch && (
          <>
            <span className="shrink-0">&middot;</span>
            <svg className="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span className="truncate">{session.git_branch}</span>
          </>
        )}
      </div>
    </button>
  );
}

// Export for testing
export { getPreviewLines };
