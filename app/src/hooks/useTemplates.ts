import { useState, useCallback } from 'react';
import { api } from '../api/client';
import type { Template } from '../types';

interface UseTemplatesReturn {
  templates: Template[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createTemplate: (params: { name: string; folder: string; prompt: string }) => Promise<Template>;
  deleteTemplate: (id: string) => Promise<void>;
  clearError: () => void;
}

export function useTemplates(): UseTemplatesReturn {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getTemplates();
      setTemplates(data.templates);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load templates';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const createTemplate = useCallback(async (params: { name: string; folder: string; prompt: string }): Promise<Template> => {
    const data = await api.createTemplate(params);
    await refresh();
    return data.template;
  }, [refresh]);

  const deleteTemplate = useCallback(async (id: string): Promise<void> => {
    await api.deleteTemplate(id);
    await refresh();
  }, [refresh]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    templates,
    loading,
    error,
    refresh,
    createTemplate,
    deleteTemplate,
    clearError,
  };
}
