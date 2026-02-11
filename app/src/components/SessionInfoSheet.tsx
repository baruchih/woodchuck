import { useEffect, useCallback, useState, useRef } from 'react';
import { Button } from './Button';
import { StatusBadge } from './StatusBadge';
import type { Session, Project } from '../types';

interface SessionInfoSheetProps {
  session: Session | null;
  projects?: Project[];
  onClose: () => void;
  onDelete: (sessionId: string) => void;
  onRename?: (sessionId: string, newName: string) => void;
  onMoveToProject?: (sessionId: string, projectId: string | null) => void;
}

function formatDateTime(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(startDateString: string): string {
  const start = new Date(startDateString);
  const now = new Date();
  const diffMs = now.getTime() - start.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);

  if (diffHours > 0) {
    const mins = diffMins % 60;
    return `${diffHours}h ${mins}m`;
  } else if (diffMins > 0) {
    const secs = diffSecs % 60;
    return `${diffMins}m ${secs}s`;
  } else {
    return `${diffSecs}s`;
  }
}

export function SessionInfoSheet({
  session,
  projects = [],
  onClose,
  onDelete,
  onRename,
  onMoveToProject,
}: SessionInfoSheetProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  // Reset edit state when session changes
  useEffect(() => {
    if (session) {
      setEditValue(session.name);
      setIsEditing(false);
      setShowProjectMenu(false);
    }
  }, [session]);

  // Close project menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (projectMenuRef.current && !projectMenuRef.current.contains(event.target as Node)) {
        setShowProjectMenu(false);
      }
    }
    if (showProjectMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showProjectMenu]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isEditing) {
          setIsEditing(false);
          setEditValue(session?.name ?? '');
        } else {
          onClose();
        }
      }
    },
    [onClose, isEditing, session?.name]
  );

  useEffect(() => {
    if (session) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [session, handleKeyDown]);

  const handleNameClick = () => {
    if (onRename) {
      setIsEditing(true);
    }
  };

  const handleSave = () => {
    const trimmedValue = editValue.trim();
    if (trimmedValue && trimmedValue !== session?.name && onRename && session) {
      onRename(session.id, trimmedValue);
    } else if (session) {
      setEditValue(session.name);
    }
    setIsEditing(false);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsEditing(false);
      setEditValue(session?.name ?? '');
    }
  };

  const handleDelete = () => {
    if (session) {
      onDelete(session.id);
      onClose();
    }
  };

  const handleProjectSelect = (projectId: string | null) => {
    if (session && onMoveToProject) {
      onMoveToProject(session.id, projectId);
    }
    setShowProjectMenu(false);
  };

  const currentProject = session?.project_id
    ? projects.find((p) => p.id === session.project_id)
    : null;

  if (!session) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
        onTouchMove={(e) => e.preventDefault()}
      />

      {/* Bottom sheet */}
      <div
        className="fixed bottom-0 left-0 right-0 z-50 bg-surface border-t border-border rounded-t-lg max-h-[85vh] overflow-y-auto pb-safe sheet-slide-up"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
      >
        {/* Handle bar */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 pb-3 border-b border-border">
          <h2 id="sheet-title" className="text-sm font-medium text-text uppercase tracking-wider">
            Session Info
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-sm text-text-muted hover:text-text hover:bg-surface-alt transition-colors"
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-5 h-5"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Current Request - prominent since it shows what Claude is working on */}
          {session.last_input && (
            <div className="bg-primary/10 border border-primary/20 rounded-sm p-3">
              <label className="text-xs text-primary uppercase tracking-wider font-medium">Current Request</label>
              <p className="mt-1 text-text text-sm line-clamp-3">{session.last_input}</p>
            </div>
          )}

          {/* Name (editable) */}
          <div>
            <label className="text-xs text-text-muted uppercase tracking-wider">Name</label>
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleSave}
                onKeyDown={handleInputKeyDown}
                className="mt-1 w-full bg-background border border-primary rounded-sm px-3 py-2 text-text text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <p
                className={`mt-1 text-text text-sm ${onRename ? 'cursor-text hover:text-primary' : ''}`}
                onClick={handleNameClick}
              >
                {session.name}
                {onRename && (
                  <span className="ml-2 text-text-muted text-xs">(tap to edit)</span>
                )}
              </p>
            )}
          </div>

          {/* Session ID */}
          <div>
            <label className="text-xs text-text-muted uppercase tracking-wider">Session ID</label>
            <p className="mt-1 text-text text-sm font-mono break-all">{session.id}</p>
          </div>

          {/* Folder */}
          <div>
            <label className="text-xs text-text-muted uppercase tracking-wider">Folder</label>
            <p className="mt-1 text-text text-sm font-mono break-all">{session.folder}</p>
          </div>

          {/* Git branch */}
          {session.git_branch && (
            <div>
              <label className="text-xs text-text-muted uppercase tracking-wider">Git Branch</label>
              <p className="mt-1 text-text text-sm flex items-center gap-2">
                <svg
                  className="w-4 h-4 text-text-muted"
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
                {session.git_branch}
              </p>
            </div>
          )}

          {/* Project */}
          {onMoveToProject && (
            <div>
              <label className="text-xs text-text-muted uppercase tracking-wider">Project</label>
              <div className="mt-1 relative" ref={projectMenuRef}>
                <button
                  onClick={() => setShowProjectMenu(!showProjectMenu)}
                  className="flex items-center gap-2 text-text text-sm hover:text-primary transition-colors"
                >
                  <svg
                    className="w-4 h-4 text-text-muted"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <span>{currentProject ? currentProject.name : 'None (Ungrouped)'}</span>
                  <svg
                    className="w-4 h-4 text-text-muted"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {/* Project dropdown */}
                {showProjectMenu && (
                  <div className="absolute left-0 top-full mt-1 bg-surface border border-border rounded-sm shadow-lg py-1 z-10 min-w-[200px] max-h-[200px] overflow-y-auto">
                    {/* Ungrouped option */}
                    <button
                      onClick={() => handleProjectSelect(null)}
                      className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                        !session.project_id
                          ? 'bg-primary/10 text-primary'
                          : 'text-text hover:bg-surface-alt'
                      }`}
                    >
                      None (Ungrouped)
                    </button>

                    {projects.length > 0 && (
                      <div className="border-t border-border my-1" />
                    )}

                    {/* Project options */}
                    {projects.map((project) => (
                      <button
                        key={project.id}
                        onClick={() => handleProjectSelect(project.id)}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                          session.project_id === project.id
                            ? 'bg-primary/10 text-primary'
                            : 'text-text hover:bg-surface-alt'
                        }`}
                      >
                        {project.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Status */}
          <div>
            <label className="text-xs text-text-muted uppercase tracking-wider">Status</label>
            <div className="mt-1">
              <StatusBadge status={session.status} size="sm" workingSince={session.working_since} />
            </div>
          </div>

          {/* Working since (duration) */}
          {session.working_since && (
            <div>
              <label className="text-xs text-text-muted uppercase tracking-wider">Working For</label>
              <p className="mt-1 text-text text-sm">{formatDuration(session.working_since)}</p>
            </div>
          )}

          {/* Created at */}
          <div>
            <label className="text-xs text-text-muted uppercase tracking-wider">Created</label>
            <p className="mt-1 text-text text-sm">{formatDateTime(session.created_at)}</p>
          </div>

          {/* Updated at */}
          <div>
            <label className="text-xs text-text-muted uppercase tracking-wider">Last Updated</label>
            <p className="mt-1 text-text text-sm">{formatDateTime(session.updated_at)}</p>
          </div>

          {/* Delete button */}
          <div className="pt-4 border-t border-border">
            <Button variant="danger" size="sm" onClick={handleDelete} className="w-full">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4 mr-2"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              Delete Session
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
