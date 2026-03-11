import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { ShortcutsHelp } from '../components/ShortcutsHelp';
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
  const { sessions, loading, error, refresh, deleteSession, renameSession, moveToProject, updateTags } = useSessions();
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
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [activeTagFilters, setActiveTagFilters] = useState<Set<string>>(new Set());

  // Collect all unique tags across all sessions
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const s of sessions) {
      for (const t of s.tags ?? []) {
        tagSet.add(t);
      }
    }
    return [...tagSet].sort();
  }, [sessions]);

  // Filter sessions based on search query and active tag filters
  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sessions.filter((s) => {
      // Tag filter (AND: session must have ALL active tags)
      if (activeTagFilters.size > 0) {
        const sessionTags = new Set(s.tags ?? []);
        for (const tag of activeTagFilters) {
          if (!sessionTags.has(tag)) return false;
        }
      }
      // Search query filter
      if (q) {
        return (
          (s.name?.toLowerCase().includes(q)) ||
          (s.folder?.toLowerCase().includes(q)) ||
          (s.git_branch?.toLowerCase().includes(q)) ||
          (s.status?.toLowerCase().includes(q)) ||
          (s.tags ?? []).some((t) => t.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [sessions, searchQuery, activeTagFilters]);

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
    if (viewMode !== 'grid') return filteredSessions;
    return [...filteredSessions].sort((a, b) => {
      const pa = STATUS_PRIORITY[a.status] ?? 0;
      const pb = STATUS_PRIORITY[b.status] ?? 0;
      if (pa !== pb) return pb - pa;
      // Secondary sort: most recently updated first
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [viewMode, filteredSessions]);

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

  // Keyboard shortcuts
  const shortcuts = useMemo(() => ({
    '/': (e: KeyboardEvent) => {
      e.preventDefault();
      document.getElementById('search-input')?.focus();
    },
    'n': () => navigate('/new'),
    'g': () => handleToggleViewMode(),
    '?': () => setShowShortcuts((prev) => !prev),
  }), [navigate, handleToggleViewMode]);

  useKeyboardShortcuts(shortcuts);

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

  const handleUpdateTags = useCallback(async (sessionId: string, tags: string[]) => {
    try {
      await updateTags(sessionId, tags);
    } catch {
      // Error handling
    }
  }, [updateTags]);

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
    for (const session of filteredSessions) {
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
  }, [filteredSessions, projects]);

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
      {/* Multi-session view */}
      <button
        onClick={() => navigate('/multi')}
        className="p-2 touch-target btn-active rounded-sm hover:bg-surface-alt text-text-muted hover:text-text"
        aria-label="Multi-session view"
        title="Multi-session view"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
          <rect x="3" y="3" width="8" height="8" rx="1" />
          <rect x="13" y="3" width="8" height="8" rx="1" />
          <rect x="3" y="13" width="8" height="8" rx="1" />
          <rect x="13" y="13" width="8" height="8" rx="1" />
        </svg>
      </button>
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
            {/* Search input */}
            {(sessions.length > 0 || projects.length > 0) && (
              <div className="relative mb-4">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  id="search-input"
                  type="text"
                  placeholder="Search sessions..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-8 py-2 text-sm bg-background border border-border rounded-sm text-text placeholder:text-text-muted focus:outline-none focus:border-primary"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text p-1"
                    aria-label="Clear search"
                  >
                    <span className="text-sm leading-none">&times;</span>
                  </button>
                )}
              </div>
            )}

            {/* Tag filter chips */}
            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-4">
                {allTags.map((tag) => {
                  const isActive = activeTagFilters.has(tag);
                  return (
                    <button
                      key={tag}
                      onClick={() => {
                        setActiveTagFilters((prev) => {
                          const next = new Set(prev);
                          if (next.has(tag)) {
                            next.delete(tag);
                          } else {
                            next.add(tag);
                          }
                          return next;
                        });
                      }}
                      className={`px-2 py-0.5 text-xs rounded-sm border transition-colors ${
                        isActive
                          ? 'border-primary bg-primary/20 text-primary'
                          : 'border-primary/30 bg-primary/5 text-text-muted hover:text-primary hover:border-primary/50'
                      }`}
                    >
                      {tag}
                    </button>
                  );
                })}
                {activeTagFilters.size > 0 && (
                  <button
                    onClick={() => setActiveTagFilters(new Set())}
                    className="px-2 py-0.5 text-xs rounded-sm text-text-muted hover:text-text transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
            )}

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
                  if (searchQuery && projectSessions.length === 0) return null;
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
                  // Only show if there are ungrouped sessions or no visible projects (hide when searching with no matches)
                  if (ungroupedSessions.length === 0 && (visibleProjects.length > 0 || searchQuery)) {
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
            {filteredSessions.length > 0 && viewMode === 'grid' && (
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
        onUpdateTags={handleUpdateTags}
      />

      <CreateProjectDialog
        open={showCreateProject}
        onConfirm={handleCreateProject}
        onCancel={() => setShowCreateProject(false)}
      />

      <ShortcutsHelp
        open={showShortcuts}
        onClose={() => setShowShortcuts(false)}
        shortcuts={[
          { key: '/', description: 'Focus search bar' },
          { key: 'n', description: 'New session' },
          { key: 'g', description: 'Toggle grid/list view' },
          { key: '?', description: 'Show/hide this help' },
        ]}
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
