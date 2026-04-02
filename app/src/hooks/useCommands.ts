import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type { Command } from '../types';

interface UseCommandsResult {
  commands: Command[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useCommands(sessionId?: string): UseCommandsResult {
  const [commands, setCommands] = useState<Command[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getCommands(sessionId);
      setCommands(data.commands);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load commands';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Fetch commands on mount and when sessionId changes
  useEffect(() => {
    refresh();
    // Re-fetch periodically to pick up new skills after session restart
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { commands, loading, error, refresh };
}
