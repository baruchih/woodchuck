import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { PullToRefresh } from '../components/PullToRefresh';
import { Button } from '../components/Button';
import { NotificationBanner } from '../components/NotificationBanner';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LogoWatermark } from '../components/LogoWatermark';
import { SessionInfoSheet } from '../components/SessionInfoSheet';
import { ProjectSection } from '../components/ProjectSection';
import { CreateProjectDialog } from '../components/CreateProjectDialog';
import { GridCard } from '../components/GridCard';
import { useSessions } from '../hooks/useSessions';
import { useProjects } from '../hooks/useProjects';
import { useNotifications } from '../hooks/useNotifications';
import { usePushSubscription } from '../hooks/usePushSubscription';
import { useWS } from '../context/WebSocketContext';
import type { Session, SessionStatus } from '../types';

type ViewMode = 'list' | 'grid';

const VIEW_MODE_KEY = 'woodchuck-view-mode';

function loadViewMode(): ViewMode {
  try {
    const stored = localStorage.getItem(VIEW_MODE_KEY);
    if (stored === 'grid' || stored === 'list') return stored;
  } catch {
    // Ignore
  }
  return 'list';
}

function saveViewMode(mode: ViewMode) {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // Ignore
  }
}

/** Status priority for grid sorting (higher = more urgent) */
const STATUS_PRIORITY: Record<SessionStatus, number> = {
  needs_input: 4,
  error: 3,
  working: 2,
  resting: 1,
};

const ALERT_STATUSES: Set<SessionStatus> = new Set(['needs_input', 'error']);

// Monkey Island easter eggs
const EMPTY_STATE_QUOTES = [
  "I want to be a mighty pirate!",
  "Look behind you, a three-headed monkey!",
  "How appropriate. You fight like a cow.",
  "I'm selling these fine leather jackets.",
  "I'm Guybrush Threepwood, mighty pirate!",
];

const INSULT_SWORD_FIGHTING = [
  "You fight like a dairy farmer!",
  "I once owned a dog that was smarter than you.",
  "Every enemy I've met I've annihilated!",
  "I've spoken with apes more polite than you.",
  "Soon you'll be wearing my sword like a shish kebab!",
];

const LOADING_QUOTES = [
  "Please wait, I'm loading these fine leather jackets...",
  "Navigating the Caribbean...",
  "Searching for the Secret of Monkey Island...",
  "Avoiding the Ghost Pirate LeChuck...",
  "Holding breath underwater... (up to 10 minutes)",
];

function randomItem<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

// Storage keys for collapsed and hidden state
const COLLAPSED_PROJECTS_KEY = 'woodchuck-collapsed-projects';
const HIDDEN_PROJECTS_KEY = 'woodchuck-hidden-projects';

function loadCollapsedProjects(): Set<string> {
  try {
    const stored = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    if (stored) {
      return new Set(JSON.parse(stored));
    }
  } catch {
    // Ignore parse errors
  }
  return new Set();
}

function saveCollapsedProjects(collapsed: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Ignore storage errors
  }
}

function loadHiddenProjects(): Set<string> {
  try {
    const stored = localStorage.getItem(HIDDEN_PROJECTS_KEY);
    if (stored) {
      return new Set(JSON.parse(stored));
    }
  } catch {
    // Ignore parse errors
  }
  return new Set();
}


export function SessionsPage() {
  const navigate = useNavigate();
  const { sessions, loading, error, refresh, deleteSession, renameSession, moveToProject } = useSessions();
  const {
    projects,
    loading: projectsLoading,
    refresh: refreshProjects,
    createProject,
    renameProject,
    deleteProject,
  } = useProjects();
  const { subscribe, unsubscribe, onStatus, onOutput } = useWS();
  const { notifySession } = useNotifications();
  const { isSubscribed: isPushSubscribed, isLoading: isPushLoading, subscribe: subscribePush } = usePushSubscription();

  const [viewMode, setViewMode] = useState<ViewMode>(() => loadViewMode());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const prevStatusRef = useRef<Map<string, SessionStatus>>(new Map());
  // Live output per session for grid preview
  const [sessionOutputs, setSessionOutputs] = useState<Map<string, string>>(new Map());
  const [selectedGridIndex, setSelectedGridIndex] = useState(-1);
  const subscribedIdsRef = useRef<Set<string>>(new Set());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingDeleteProjectId, setPendingDeleteProjectId] = useState<string | null>(null);
  const [infoSession, setInfoSession] = useState<Session | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => loadCollapsedProjects());
  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(() => loadHiddenProjects());
  const [showCreateProject, setShowCreateProject] = useState(false);

  // Initial load
  useEffect(() => {
    refresh();
    refreshProjects();
  }, [refresh, refreshProjects]);

  // Derive a stable string of session IDs to avoid re-running on status-only changes
  const sessionIds = sessions.map((s) => s.id).join(',');

  // Subscribe to all session IDs for real-time status updates (diff-based)
  useEffect(() => {
    const currentIds = new Set(sessionIds.split(',').filter(Boolean));

    // Subscribe to new sessions
    for (const id of currentIds) {
      if (!subscribedIdsRef.current.has(id)) {
        subscribe(id);
      }
    }

    // Unsubscribe from removed sessions
    for (const id of subscribedIdsRef.current) {
      if (!currentIds.has(id)) {
        unsubscribe(id);
      }
    }

    subscribedIdsRef.current = currentIds;
  }, [sessionIds, subscribe, unsubscribe]);

  // Cleanup all subscriptions on unmount only
  useEffect(() => {
    return () => {
      for (const id of subscribedIdsRef.current) {
        unsubscribe(id);
      }
      subscribedIdsRef.current = new Set();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for status updates from WebSocket
  useEffect(() => {
    const unsub = onStatus((msg) => {
      // Fire browser notification when a session transitions TO needs_input/error
      const prev = prevStatusRef.current.get(msg.session_id);
      if (
        ALERT_STATUSES.has(msg.status) &&
        prev !== msg.status
      ) {
        // Use ref to avoid sessions in dependency array
        const session = sessionsRef.current.find((s) => s.id === msg.session_id);
        const name = session?.name ?? msg.session_id;
        notifySession(msg.session_id, name, msg.status as 'needs_input' | 'error');
      }
      prevStatusRef.current.set(msg.session_id, msg.status);

      // Un-dismiss if the session left an alert status and re-enters
      if (!ALERT_STATUSES.has(msg.status)) {
        setDismissedIds((prev) => {
          if (!prev.has(msg.session_id)) return prev;
          const next = new Set(prev);
          next.delete(msg.session_id);
          return next;
        });
      }

      refresh();
    });

    return unsub;
  }, [onStatus, refresh, notifySession]);

  // Sync prevStatusRef with sessions on load
  useEffect(() => {
    for (const s of sessions) {
      if (!prevStatusRef.current.has(s.id)) {
        prevStatusRef.current.set(s.id, s.status);
      }
    }
  }, [sessions]);

  // Capture live output for grid preview
  useEffect(() => {
    if (viewMode !== 'grid') return;
    const unsub = onOutput((msg) => {
      setSessionOutputs((prev) => {
        const next = new Map(prev);
        next.set(msg.session_id, msg.content);
        return next;
      });
    });
    return unsub;
  }, [viewMode, onOutput]);

  // Sort sessions by status priority for grid view
  const sortedSessions = useMemo(() => {
    if (viewMode !== 'grid') return sessions;
    return [...sessions].sort((a, b) => {
      const pa = STATUS_PRIORITY[a.status] ?? 0;
      const pb = STATUS_PRIORITY[b.status] ?? 0;
      if (pa !== pb) return pb - pa;
      // Secondary sort: most recently updated first
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [viewMode, sessions]);

  // Grid keyboard navigation
  useEffect(() => {
    if (viewMode !== 'grid' || sortedSessions.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if user is in an input/textarea
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // Determine grid columns from viewport width
      const width = window.innerWidth;
      let cols = 1;
      if (width >= 1280) cols = 4; // xl
      else if (width >= 1024) cols = 3; // lg
      else if (width >= 640) cols = 2; // sm

      const total = sortedSessions.length;

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          setSelectedGridIndex((prev) => Math.min(prev + 1, total - 1));
          break;
        case 'ArrowLeft':
          e.preventDefault();
          setSelectedGridIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelectedGridIndex((prev) => Math.min(prev + cols, total - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedGridIndex((prev) => Math.max(prev - cols, 0));
          break;
        case 'Enter': {
          if (selectedGridIndex >= 0 && selectedGridIndex < total) {
            const session = sortedSessions[selectedGridIndex];
            navigate(`/session/${encodeURIComponent(session.id)}`);
          }
          break;
        }
        case 'Escape':
          setSelectedGridIndex(-1);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [viewMode, sortedSessions, selectedGridIndex, navigate]);

  // Scroll selected grid card into view
  useEffect(() => {
    if (selectedGridIndex < 0 || viewMode !== 'grid') return;
    const session = sortedSessions[selectedGridIndex];
    if (!session) return;
    const el = document.querySelector(`[data-session-id="${CSS.escape(session.id)}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedGridIndex, viewMode, sortedSessions]);

  const handleToggleViewMode = useCallback(() => {
    setViewMode((prev) => {
      const next = prev === 'list' ? 'grid' : 'list';
      saveViewMode(next);
      setSelectedGridIndex(-1);
      return next;
    });
  }, []);

  const handleSessionClick = (session: Session) => {
    navigate(`/session/${encodeURIComponent(session.id)}`);
  };

  const handleNewSession = () => {
    navigate('/new');
  };

  const handleDismiss = useCallback((sessionId: string) => {
    setDismissedIds((prev) => new Set(prev).add(sessionId));
  }, []);

  const handleBannerTap = useCallback(
    (sessionId: string) => {
      navigate(`/session/${encodeURIComponent(sessionId)}`);
    },
    [navigate],
  );

  const handleBellClick = useCallback(async () => {
    await subscribePush();
  }, [subscribePush]);

  const handleDeleteRequest = useCallback((sessionId: string) => {
    setPendingDeleteId(sessionId);
  }, []);

  const handleNewInFolder = useCallback(
    (folder: string) => {
      navigate(`/new?folder=${encodeURIComponent(folder)}`);
    },
    [navigate],
  );

  const handleRename = useCallback(
    async (sessionId: string, newName: string) => {
      try {
        await renameSession(sessionId, newName);
      } catch {
        // Error handling - refresh will show current state
      }
    },
    [renameSession],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (pendingDeleteId) {
      try {
        await deleteSession(pendingDeleteId);
      } catch {
        // Session may already be gone; refresh will update the list
      } finally {
        setPendingDeleteId(null);
      }
    }
  }, [pendingDeleteId, deleteSession]);

  const handleDeleteCancel = useCallback(() => {
    setPendingDeleteId(null);
  }, []);

  const handleShowInfo = useCallback((session: Session) => {
    setInfoSession(session);
  }, []);

  const handleCloseInfo = useCallback(() => {
    setInfoSession(null);
  }, []);

  const handleDeleteFromSheet = useCallback((sessionId: string) => {
    setInfoSession(null);
    setPendingDeleteId(sessionId);
  }, []);

  // Project handlers
  const handleToggleProject = useCallback((projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      saveCollapsedProjects(next);
      return next;
    });
  }, []);

  const handleCreateProject = useCallback(async (name: string) => {
    try {
      await createProject(name);
      setShowCreateProject(false);
    } catch {
      // Error handling
    }
  }, [createProject]);

  const handleRenameProject = useCallback(async (projectId: string, newName: string) => {
    try {
      await renameProject(projectId, newName);
    } catch {
      // Error handling
    }
  }, [renameProject]);

  const handleDeleteProjectRequest = useCallback((projectId: string) => {
    setPendingDeleteProjectId(projectId);
  }, []);

  const handleDeleteProjectConfirm = useCallback(async () => {
    if (pendingDeleteProjectId) {
      try {
        await deleteProject(pendingDeleteProjectId);
        await refresh(); // Refresh sessions to update project_id = null
      } catch {
        // Error handling
      } finally {
        setPendingDeleteProjectId(null);
      }
    }
  }, [pendingDeleteProjectId, deleteProject, refresh]);

  const handleDeleteProjectCancel = useCallback(() => {
    setPendingDeleteProjectId(null);
  }, []);

  const handleMoveToProject = useCallback(async (sessionId: string, projectId: string | null) => {
    try {
      await moveToProject(sessionId, projectId);
    } catch {
      // Error handling
    }
  }, [moveToProject]);

  // Reload hidden projects when returning from settings
  useEffect(() => {
    const handleFocus = () => {
      setHiddenProjects(loadHiddenProjects());
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // Group sessions by project
  const sessionsByProject = useMemo(() => {
    const grouped = new Map<string | null, Session[]>();

    // Initialize with all projects (even empty ones)
    for (const project of projects) {
      grouped.set(project.id, []);
    }
    grouped.set(null, []); // Ungrouped

    // Assign sessions to projects
    for (const session of sessions) {
      const projectId = session.project_id ?? null;
      const list = grouped.get(projectId);
      if (list) {
        list.push(session);
      } else {
        // Project doesn't exist, treat as ungrouped
        grouped.get(null)!.push(session);
      }
    }

    return grouped;
  }, [sessions, projects]);

  // Filter to only visible projects
  const visibleProjects = useMemo(() => {
    return projects.filter((p) => !hiddenProjects.has(p.id));
  }, [projects, hiddenProjects]);

  const pendingDeleteSession = pendingDeleteId
    ? sessions.find((s) => s.id === pendingDeleteId)
    : null;

  const pendingDeleteProject = pendingDeleteProjectId
    ? projects.find((p) => p.id === pendingDeleteProjectId)
    : null;

  // Pick a random insult for the delete dialog (stable while dialog is open)
  const deleteInsult = useMemo(() => randomItem(INSULT_SWORD_FIGHTING), [pendingDeleteId]);

  // Bell icon: muted = not subscribed, green = subscribed, hidden = checking (null)
  const bellColor = isPushSubscribed
    ? 'text-status-success'
    : 'text-text-muted hover:text-primary';

  const rightAction = (
    <div className="flex items-center gap-2">
      {/* View toggle (list/grid) */}
      <button
        onClick={handleToggleViewMode}
        className="p-2 touch-target btn-active rounded-sm hover:bg-surface-alt text-text-muted hover:text-text"
        aria-label={viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view'}
        title={viewMode === 'list' ? 'Grid view' : 'List view'}
      >
        {viewMode === 'list' ? (
          /* Grid icon */
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
        ) : (
          /* List icon */
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        )}
      </button>
      {isPushSubscribed !== null && (
        <button
          onClick={handleBellClick}
          disabled={isPushLoading || isPushSubscribed === true}
          className={`p-2 touch-target btn-active rounded-sm hover:bg-surface-alt disabled:opacity-50 ${bellColor}`}
          aria-label={isPushSubscribed ? 'Push notifications enabled' : 'Enable push notifications'}
          title={isPushSubscribed ? 'Push notifications enabled' : 'Enable push notifications'}
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
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
        </button>
      )}
      <button
        onClick={() => navigate('/settings')}
        className="p-2 touch-target btn-active rounded-sm hover:bg-surface-alt text-text-muted hover:text-text"
        aria-label="Settings"
        title="Settings"
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
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setShowCreateProject(true)}
        title="New Project"
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
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          <line x1="12" y1="11" x2="12" y2="17" />
          <line x1="9" y1="14" x2="15" y2="14" />
        </svg>
      </Button>
      <Button variant="primary" size="sm" onClick={handleNewSession}>
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
      </Button>
    </div>
  );

  return (
    <Layout title="Woodchuck" rightAction={rightAction}>
      <LogoWatermark />
      <PullToRefresh onRefresh={refresh}>
        <div className="pb-safe relative min-h-full">
          {/* Notification banners */}
          <NotificationBanner
            sessions={sessions}
            dismissedIds={dismissedIds}
            onDismiss={handleDismiss}
            onTap={handleBannerTap}
          />

          <div className="p-4">
            {/* Error state */}
            {error && (
              <div className="bg-status-error/10 border border-status-error rounded-sm p-4 mb-4">
                <p className="text-status-error text-xs">{error}</p>
                <button
                  onClick={() => refresh()}
                  className="text-primary text-xs mt-2 uppercase tracking-wider hover:underline"
                >
                  Try again
                </button>
              </div>
            )}

            {/* Loading state (initial load only) */}
            {(loading || projectsLoading) && sessions.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12">
                <div className="spinner mb-4" />
                <p className="text-text text-xs">
                  {randomItem(LOADING_QUOTES)}
                </p>
              </div>
            )}

            {/* Empty state */}
            {!loading && !projectsLoading && !error && sessions.length === 0 && projects.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="text-text text-sm italic mb-6">
                  {randomItem(EMPTY_STATE_QUOTES)}
                </div>
                <Button onClick={handleNewSession}>New Session</Button>
              </div>
            )}

            {/* Sessions: list or grid view */}
            {(sessions.length > 0 || projects.length > 0) && viewMode === 'list' && (
              <div>
                {/* Visible project sections */}
                {visibleProjects.map((project) => {
                  const projectSessions = sessionsByProject.get(project.id) ?? [];
                  return (
                    <ProjectSection
                      key={project.id}
                      project={project}
                      sessions={projectSessions}
                      expanded={!collapsedProjects.has(project.id)}
                      onToggle={() => handleToggleProject(project.id)}
                      onSessionClick={handleSessionClick}
                      onSessionDelete={handleDeleteRequest}
                      onNewInFolder={handleNewInFolder}
                      onSessionRename={handleRename}
                      onSessionShowInfo={handleShowInfo}
                      onProjectRename={handleRenameProject}
                      onProjectDelete={handleDeleteProjectRequest}
                    />
                  );
                })}

                {/* Ungrouped section (always at bottom of visible projects) */}
                {(() => {
                  const ungroupedSessions = sessionsByProject.get(null) ?? [];
                  // Only show if there are ungrouped sessions or no visible projects
                  if (ungroupedSessions.length === 0 && visibleProjects.length > 0) {
                    return null;
                  }
                  return (
                    <ProjectSection
                      project={null}
                      sessions={ungroupedSessions}
                      expanded={!collapsedProjects.has('ungrouped')}
                      onToggle={() => handleToggleProject('ungrouped')}
                      onSessionClick={handleSessionClick}
                      onSessionDelete={handleDeleteRequest}
                      onNewInFolder={handleNewInFolder}
                      onSessionRename={handleRename}
                      onSessionShowInfo={handleShowInfo}
                    />
                  );
                })()}

              </div>
            )}

            {/* Grid view */}
            {sessions.length > 0 && viewMode === 'grid' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {sortedSessions.map((session, index) => (
                  <div key={session.id} className="h-[220px]">
                    <GridCard
                      session={session}
                      output={sessionOutputs.get(session.id) ?? ''}
                      onClick={() => handleSessionClick(session)}
                      onDelete={handleDeleteRequest}
                      onShowInfo={handleShowInfo}
                      selected={index === selectedGridIndex}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Easter egg link */}
            <div className="mt-8 pt-4 border-t border-border text-center">
              <button
                onClick={() => navigate('/insult-sword-fight')}
                className="text-xs text-text-muted hover:text-primary transition-colors"
              >
                Bored? Play Insult Sword Fighting {"///"}
              </button>
            </div>
          </div>
        </div>
      </PullToRefresh>

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="Delete Session"
        message={
          pendingDeleteSession
            ? `"${deleteInsult}" Kill and remove "${pendingDeleteSession.name}"?`
            : `"${deleteInsult}" Kill and remove this session?`
        }
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />

      <SessionInfoSheet
        session={infoSession}
        projects={projects}
        onClose={handleCloseInfo}
        onDelete={handleDeleteFromSheet}
        onRename={handleRename}
        onMoveToProject={handleMoveToProject}
      />

      <CreateProjectDialog
        open={showCreateProject}
        onConfirm={handleCreateProject}
        onCancel={() => setShowCreateProject(false)}
      />

      <ConfirmDialog
        open={pendingDeleteProjectId !== null}
        title="Delete Project"
        message={
          pendingDeleteProject
            ? `Delete "${pendingDeleteProject.name}"? Sessions in this project will become ungrouped.`
            : 'Delete this project? Sessions will become ungrouped.'
        }
        confirmLabel="Delete"
        onConfirm={handleDeleteProjectConfirm}
        onCancel={handleDeleteProjectCancel}
      />
    </Layout>
  );
}
