import { useState, useCallback } from 'react';
import { api } from '../api/client';
import type { CreateFolderParams } from '../types';

interface UseFoldersReturn {
  folders: string[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createFolder: (params: CreateFolderParams) => Promise<string>;
  clearError: () => void;
}

export function useFolders(): UseFoldersReturn {
  const [folders, setFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getFolders();
      setFolders(data.folders);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load folders';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createFolder = useCallback(async (params: CreateFolderParams): Promise<string> => {
    const data = await api.createFolder(params);
    await refresh();
    return data.path;
  }, [refresh]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    folders,
    loading,
    error,
    refresh,
    createFolder,
    clearError,
  };
}
