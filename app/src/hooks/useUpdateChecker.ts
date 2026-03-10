import { useState, useEffect, useRef, useCallback } from 'react';

const CHECK_INTERVAL = 30_000; // 30s

/**
 * Polls /api/health and detects when build_id changes (server restarted).
 * Returns update state and a function to apply the update.
 */
export function useUpdateChecker(): { updateAvailable: boolean; applyUpdate: () => void } {
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

  // Force the service worker to update and reload the page
  const applyUpdate = useCallback(async () => {
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration?.waiting) {
        // Tell the waiting SW to activate
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        // Wait a moment for activation, then reload
        setTimeout(() => window.location.reload(), 300);
        return;
      }
      // No waiting SW — try unregistering and reloading to get fresh assets
      if (registration) {
        await registration.unregister();
      }
    } catch {
      // Fall through to reload
    }
    window.location.reload();
  }, []);

  return { updateAvailable, applyUpdate };
}
