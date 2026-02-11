import { useState, useCallback } from 'react';
import { api } from '../api/client';
import type { Project } from '../types';

interface UseProjectsReturn {
  projects: Project[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createProject: (name: string) => Promise<Project>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  clearError: () => void;
}

export function useProjects(): UseProjectsReturn {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getProjects();
      setProjects(data.projects);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load projects';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createProject = useCallback(async (name: string): Promise<Project> => {
    const data = await api.createProject(name);
    // Refresh the projects list after creating
    await refresh();
    return data.project;
  }, [refresh]);

  const renameProject = useCallback(async (id: string, name: string): Promise<void> => {
    await api.renameProject(id, name);
    // Refresh the projects list after renaming
    await refresh();
  }, [refresh]);

  const deleteProject = useCallback(async (id: string): Promise<void> => {
    await api.deleteProject(id);
    // Refresh the projects list after deleting
    await refresh();
  }, [refresh]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    projects,
    loading,
    error,
    refresh,
    createProject,
    renameProject,
    deleteProject,
    clearError,
  };
}
