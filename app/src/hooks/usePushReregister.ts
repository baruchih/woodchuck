import { useEffect } from 'react';
import { api } from '../api/client';

/**
 * Re-registers existing push subscription with the server on app startup.
 *
 * This handles the case where the server was restarted and lost its in-memory
 * push subscription store, but the browser still has a valid subscription.
 *
 * Should be called once at the app root level (e.g., in App.tsx).
 */
export function usePushReregister(): void {
  useEffect(() => {
    async function reregister() {
      // Check if push is supported
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        return;
      }

      try {
        // Check if server has push configured
        const { publicKey } = await api.getVapidPublicKey();
        if (!publicKey) {
          return;
        }

        // Get existing subscription from browser
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();

        if (!subscription) {
          return;
        }

        // Re-register with server
        const json = subscription.toJSON();
        if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
          await api.subscribePush({
            endpoint: json.endpoint,
            keys: {
              p256dh: json.keys.p256dh,
              auth: json.keys.auth,
            },
          });
        }
      } catch {
        // Silently fail - this is just a background re-registration
      }
    }

    reregister();
  }, []);
}
