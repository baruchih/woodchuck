import { useState, useEffect, useRef } from 'react';

const CHECK_INTERVAL = 30_000; // 30s

/**
 * Polls /api/health and detects when build_id changes (server restarted).
 * Returns true when an update is available.
 */
export function useUpdateChecker(): boolean {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const initialBuildId = useRef<string | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/health');
        const data = await res.json();
        const buildId = data?.data?.build_id;
        if (!buildId) return;

        if (initialBuildId.current === null) {
          // First check — store the initial build ID
          initialBuildId.current = buildId;
        } else if (buildId !== initialBuildId.current) {
          setUpdateAvailable(true);
        }
      } catch {
        // Server might be restarting — ignore
      }
    };

    check();
    const interval = setInterval(check, CHECK_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  return updateAvailable;
}
