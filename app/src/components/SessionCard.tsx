import { useState, useRef, useEffect } from 'react';
import type { Session } from '../types';
import { StatusBadge } from './StatusBadge';
import { truncatePath } from '../utils/path';

interface SessionCardProps {
  session: Session;
  onClick: () => void;
  onDelete?: (sessionId: string) => void;
  onNewInFolder?: (folder: string) => void;
  onRename?: (sessionId: string, newName: string) => void;
  onShowInfo?: (session: Session) => void;
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) {
    return 'just now';
  } else if (diffMins < 60) {
    return `${diffMins}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else {
    return `${diffDays}d ago`;
  }
}

export function SessionCard({ session, onClick, onDelete, onNewInFolder, onRename, onShowInfo }: SessionCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(session.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Reset edit value when session name changes externally
  useEffect(() => {
    setEditValue(session.name);
  }, [session.name]);

  const handleNameClick = (e: React.MouseEvent) => {
    if (onRename) {
      e.stopPropagation();
      setIsEditing(true);
    }
  };

  const handleSave = () => {
    const trimmedValue = editValue.trim();
    if (trimmedValue && trimmedValue !== session.name && onRename) {
      onRename(session.id, trimmedValue);
    } else {
      setEditValue(session.name);
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditValue(session.name);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Stop propagation for all keys to prevent button activation (especially Space)
    e.stopPropagation();

    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  return (
    <button
      onClick={onClick}
      className="w-full bg-surface border border-border rounded-sm p-4 text-left card-interactive touch-target hover:border-text-muted"
    >
      {/* Row 1: Name + Actions */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="w-full bg-background border border-primary rounded-sm px-2 py-1 text-text font-medium text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          ) : (
            <h3
              className={`text-text font-medium truncate ${onRename ? 'cursor-text hover:text-primary' : ''}`}
              onClick={handleNameClick}
            >
              {session.name}
            </h3>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onNewInFolder && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onNewInFolder(session.folder);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  e.preventDefault();
                  onNewInFolder(session.folder);
                }
              }}
              className="p-1.5 rounded-sm text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
              aria-label="New session in this folder"
              title="New session in this folder"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
          )}
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
              className="p-1.5 rounded-sm text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
              aria-label={`Session info for ${session.name}`}
              title="Session info"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
              >
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
              className="p-1.5 rounded-sm text-text-muted hover:text-status-error hover:bg-status-error/10 transition-colors"
              aria-label={`Delete session ${session.name}`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </span>
          )}
        </div>
      </div>

      {/* Row 2: Status + Time */}
      <div className="flex items-center gap-2 mt-2">
        <StatusBadge
          status={session.status}
          size="sm"
          workingSince={session.working_since}
        />
        <span className="text-text-muted text-xs">
          {formatRelativeTime(session.updated_at)}
        </span>
      </div>

      {/* Row 3: Folder + Git branch */}
      <div className="flex items-center gap-1 mt-1 min-w-0 text-text-muted text-xs">
        <span className="truncate">{truncatePath(session.folder)}</span>
        {session.git_branch && (
          <>
            <span className="shrink-0">&middot;</span>
            <svg
              className="w-3 h-3 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
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
