import { useState, useRef, useEffect } from 'react';
import type { Session, Project } from '../types';
import { SessionCard } from './SessionCard';

interface ProjectSectionProps {
  project: Project | null; // null for ungrouped sessions
  sessions: Session[];
  expanded: boolean;
  onToggle: () => void;
  onSessionClick: (session: Session) => void;
  onSessionDelete?: (sessionId: string) => void;
  onNewInFolder?: (folder: string) => void;
  onSessionRename?: (sessionId: string, newName: string) => void;
  onSessionShowInfo?: (session: Session) => void;
  onProjectRename?: (projectId: string, newName: string) => void;
  onProjectDelete?: (projectId: string) => void;
  onProjectHide?: (projectId: string) => void;
}

export function ProjectSection({
  project,
  sessions,
  expanded,
  onToggle,
  onSessionClick,
  onSessionDelete,
  onNewInFolder,
  onSessionRename,
  onSessionShowInfo,
  onProjectRename,
  onProjectDelete,
  onProjectHide,
}: ProjectSectionProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(project?.name ?? '');
  const [showMenu, setShowMenu] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isUngrouped = project === null;
  const headerLabel = isUngrouped ? 'Ungrouped' : project.name;

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Reset edit value when project name changes
  useEffect(() => {
    if (project) {
      setEditValue(project.name);
    }
  }, [project?.name]);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    }
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMenu]);

  const handleSave = () => {
    const trimmedValue = editValue.trim();
    if (trimmedValue && project && trimmedValue !== project.name && onProjectRename) {
      onProjectRename(project.id, trimmedValue);
    } else if (project) {
      setEditValue(project.name);
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    if (project) {
      setEditValue(project.name);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  const handleMenuAction = (action: 'rename' | 'delete' | 'hide') => {
    setShowMenu(false);
    if (action === 'rename') {
      setIsEditing(true);
    } else if (action === 'delete' && project && onProjectDelete) {
      onProjectDelete(project.id);
    } else if (action === 'hide' && project && onProjectHide) {
      onProjectHide(project.id);
    }
  };

  return (
    <div className="mb-4">
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-2 py-2 text-left hover:bg-surface/50 rounded-sm transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {/* Chevron */}
          <svg
            className={`w-4 h-4 text-text-muted transition-transform duration-200 shrink-0 ${
              expanded ? 'rotate-90' : ''
            }`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>

          {/* Label */}
          {isEditing && project ? (
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="bg-background border border-primary rounded-sm px-2 py-0.5 text-text font-medium text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          ) : (
            <span className="text-text font-medium text-sm truncate">
              {headerLabel}
            </span>
          )}

          {/* Session count */}
          <span className="text-text-muted text-xs shrink-0">
            ({sessions.length})
          </span>
        </div>

        {/* Menu button for projects (not ungrouped) */}
        {!isUngrouped && !isEditing && (
          <div className="relative" ref={menuRef}>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(!showMenu);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  e.preventDefault();
                  setShowMenu(!showMenu);
                }
              }}
              className="p-1.5 rounded-sm text-text-muted hover:text-text hover:bg-surface transition-colors"
              aria-label="Project options"
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
                <circle cx="12" cy="12" r="1" />
                <circle cx="12" cy="5" r="1" />
                <circle cx="12" cy="19" r="1" />
              </svg>
            </span>

            {/* Dropdown menu */}
            {showMenu && (
              <div
                className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-sm shadow-lg py-1 z-10 min-w-[120px]"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => handleMenuAction('rename')}
                  className="w-full text-left px-3 py-2 text-sm text-text hover:bg-primary/10 transition-colors"
                >
                  Rename
                </button>
                {onProjectHide && (
                  <button
                    onClick={() => handleMenuAction('hide')}
                    className="w-full text-left px-3 py-2 text-sm text-text hover:bg-primary/10 transition-colors"
                  >
                    Hide
                  </button>
                )}
                <button
                  onClick={() => handleMenuAction('delete')}
                  className="w-full text-left px-3 py-2 text-sm text-status-error hover:bg-status-error/10 transition-colors"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        )}
      </button>

      {/* Sessions */}
      {expanded && (
        <div className="ml-6 space-y-2 mt-2">
          {sessions.length === 0 ? (
            <p className="text-text-muted text-sm py-2">No sessions</p>
          ) : (
            sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                onClick={() => onSessionClick(session)}
                onDelete={onSessionDelete}
                onNewInFolder={onNewInFolder}
                onRename={onSessionRename}
                onShowInfo={onSessionShowInfo}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
