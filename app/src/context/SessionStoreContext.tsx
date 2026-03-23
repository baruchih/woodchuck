import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { useWS } from './WebSocketContext';
import { api } from '../api/client';
import type { Session, SessionsMessage } from '../types';

interface SessionStoreContextValue {
  sessions: Session[];
  loading: boolean;
  getSessionById: (id: string) => Session | undefined;
  refreshSessions: () => void;
}

const SessionStoreContext = createContext<SessionStoreContextValue | null>(null);

export function useSessionStore(): SessionStoreContextValue {
  const ctx = useContext(SessionStoreContext);
  if (!ctx) {
    throw new Error('useSessionStore must be used inside SessionStoreProvider');
  }
  return ctx;
}

const STATUS_PRIORITY: Record<string, number> = {
  needs_input: 0,
  error: 1,
  working: 2,
  resting: 3,
};

function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 4;
    const pb = STATUS_PRIORITY[b.status] ?? 4;
    if (pa !== pb) return pa - pb;
    // Descending by updated_at
    return b.updated_at.localeCompare(a.updated_at);
  });
}

interface SessionStoreProviderProps {
  children: ReactNode;
}

export function SessionStoreProvider({ children }: SessionStoreProviderProps) {
  const ws = useWS();
  const sessionMapRef = useRef<Map<string, Session>>(new Map());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  const buildSortedList = useCallback(() => {
    const all = Array.from(sessionMapRef.current.values());
    const filtered = all.filter((s) => s.id !== 'woodchuck-maintainer');
    setSessions(sortSessions(filtered));
  }, []);

  const fetchSessions = useCallback(() => {
    setLoading(true);
    ws.wsRequest<SessionsMessage>({ type: 'get_sessions' })
      .then((msg) => {
        sessionMapRef.current.clear();
        for (const s of msg.sessions) {
          sessionMapRef.current.set(s.id, s);
        }
        buildSortedList();
      })
      .catch((err) => {
        console.error('Failed to fetch sessions via WS, falling back to HTTP:', err);
        // Fallback to HTTP API
        api.getSessions()
          .then((data) => {
            sessionMapRef.current.clear();
            for (const s of data.sessions) {
              sessionMapRef.current.set(s.id, s);
            }
            buildSortedList();
          })
          .catch((httpErr) => {
            console.error('HTTP fallback also failed:', httpErr);
          });
      })
      .finally(() => {
        setLoading(false);
      });
  }, [ws, buildSortedList]);

  // Fetch on mount and on reconnect
  const prevConnectedRef = useRef(false);
  useEffect(() => {
    if (ws.connected) {
      // Fetch on initial connect or reconnect
      if (!prevConnectedRef.current) {
        fetchSessions();
      }
    }
    prevConnectedRef.current = ws.connected;
  }, [ws.connected, fetchSessions]);

  // Listen for broadcast events
  useEffect(() => {
    const unsubCreated = ws.onSessionCreated((msg) => {
      sessionMapRef.current.set(msg.session.id, msg.session);
      buildSortedList();
    });

    const unsubDeleted = ws.onSessionDeleted((msg) => {
      sessionMapRef.current.delete(msg.session_id);
      buildSortedList();
    });

    const unsubUpdated = ws.onSessionUpdated((msg) => {
      const existing = sessionMapRef.current.get(msg.session_id);
      if (existing) {
        const updated = { ...existing };
        if (msg.name !== undefined) updated.name = msg.name;
        if (msg.project_id !== undefined) updated.project_id = msg.project_id;
        if (msg.tags !== undefined) updated.tags = msg.tags;
        sessionMapRef.current.set(msg.session_id, updated);
        buildSortedList();
      }
    });

    const unsubStatus = ws.onStatus((msg) => {
      const existing = sessionMapRef.current.get(msg.session_id);
      if (existing) {
        sessionMapRef.current.set(msg.session_id, { ...existing, status: msg.status });
        buildSortedList();
      }
    });

    return () => {
      unsubCreated();
      unsubDeleted();
      unsubUpdated();
      unsubStatus();
    };
  }, [ws, buildSortedList]);

  const getSessionById = useCallback((id: string): Session | undefined => {
    return sessionMapRef.current.get(id);
  }, []);

  const refreshSessions = useCallback(() => {
    fetchSessions();
  }, [fetchSessions]);

  const value: SessionStoreContextValue = {
    sessions,
    loading,
    getSessionById,
    refreshSessions,
  };

  return (
    <SessionStoreContext.Provider value={value}>
      {children}
    </SessionStoreContext.Provider>
  );
}
