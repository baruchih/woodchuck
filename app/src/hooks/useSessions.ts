import { useState, useCallback } from 'react';
import { api } from '../api/client';
import type { Session, CreateSessionParams, SessionWithOutput } from '../types';

interface UseSessionsReturn {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  getSession: (id: string) => Promise<SessionWithOutput>;
  createSession: (params: CreateSessionParams) => Promise<Session>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  moveToProject: (id: string, projectId: string | null) => Promise<void>;
  updateTags: (id: string, tags: string[]) => Promise<void>;
  sendInput: (id: string, text: string) => Promise<void>;
  uploadImage: (id: string, file: File) => Promise<string>;
  uploadFiles: (id: string, files: FileList) => Promise<string[]>;
  clearError: () => void;
}

export function useSessions(): UseSessionsReturn {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getSessions();
      setSessions(data.sessions);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load sessions';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const getSession = useCallback(async (id: string): Promise<SessionWithOutput> => {
    const data = await api.getSession(id);
    return data;
  }, []);

  const createSession = useCallback(async (params: CreateSessionParams): Promise<Session> => {
    const data = await api.createSession(params);
    // Refresh the sessions list after creating
    await refresh();
    return data.session;
  }, [refresh]);

  const deleteSession = useCallback(async (id: string): Promise<void> => {
    await api.deleteSession(id);
    // Refresh the sessions list after deleting
    await refresh();
  }, [refresh]);

  const renameSession = useCallback(async (id: string, name: string): Promise<void> => {
    await api.renameSession(id, name);
    // Refresh the sessions list after renaming
    await refresh();
  }, [refresh]);

  const moveToProject = useCallback(async (id: string, projectId: string | null): Promise<void> => {
    await api.updateSession(id, { project_id: projectId });
    // Refresh the sessions list after moving
    await refresh();
  }, [refresh]);

  const updateTags = useCallback(async (id: string, tags: string[]): Promise<void> => {
    await api.updateSession(id, { tags });
    // Refresh the sessions list after updating tags
    await refresh();
  }, [refresh]);

  const sendInput = useCallback(async (id: string, text: string): Promise<void> => {
    await api.sendInput(id, text);
  }, []);

  const uploadImage = useCallback(async (id: string, file: File): Promise<string> => {
    const result = await api.uploadImage(id, file);
    return result.path;
  }, []);

  const uploadFiles = useCallback(async (id: string, files: FileList): Promise<string[]> => {
    const result = await api.uploadFiles(id, files);
    return result.paths;
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    sessions,
    loading,
    error,
    refresh,
    getSession,
    createSession,
    deleteSession,
    renameSession,
    moveToProject,
    updateTags,
    sendInput,
    uploadImage,
    uploadFiles,
    clearError,
  };
}
