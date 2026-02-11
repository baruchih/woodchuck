import { useCallback, useRef } from 'react';

interface UseNotificationsReturn {
  /** Request notification permission — MUST be called from a user gesture (onClick) */
  requestPermission: () => Promise<NotificationPermission>;
  /** Fire a browser notification for a session status change (30s cooldown per session) */
  notifySession: (sessionId: string, sessionName: string, status: 'needs_input' | 'error') => void;
  /** Current permission state */
  getPermission: () => NotificationPermission;
}

const COOLDOWN_MS = 30_000;

export function useNotifications(): UseNotificationsReturn {
  const lastNotifiedRef = useRef<Map<string, number>>(new Map());

  const getPermission = useCallback((): NotificationPermission => {
    if (!('Notification' in window)) return 'denied';
    return Notification.permission;
  }, []);

  const requestPermission = useCallback(async (): Promise<NotificationPermission> => {
    if (!('Notification' in window)) return 'denied';
    return Notification.requestPermission();
  }, []);

  const notifySession = useCallback(
    (sessionId: string, sessionName: string, status: 'needs_input' | 'error') => {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      if (document.visibilityState === 'visible') return;

      const now = Date.now();
      const lastTime = lastNotifiedRef.current.get(sessionId) ?? 0;
      if (now - lastTime < COOLDOWN_MS) return;
      lastNotifiedRef.current.set(sessionId, now);

      const title =
        status === 'needs_input'
          ? `${sessionName} needs input`
          : `${sessionName} encountered an error`;
      const body =
        status === 'needs_input'
          ? 'Claude is waiting for your response.'
          : 'Something went wrong in this session.';

      new Notification(title, { body, tag: `woodchuck-${sessionId}` });
    },
    [],
  );

  return { requestPermission, notifySession, getPermission };
}
