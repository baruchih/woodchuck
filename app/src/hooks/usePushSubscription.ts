import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type { PushPermissionState, PushSubscriptionJSON } from '../types';

export interface UsePushSubscriptionReturn {
  isSupported: boolean;
  permissionState: PushPermissionState;
  /** null = still checking, true = subscribed, false = not subscribed */
  isSubscribed: boolean | null;
  isLoading: boolean;
  error: string | null;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
}

/**
 * Convert a base64 string to Uint8Array for applicationServerKey
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Check if push notifications are supported in this browser
 */
function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

/**
 * Get the current notification permission state
 */
function getPermissionState(): PushPermissionState {
  if (!isPushSupported()) return 'unsupported';
  if (!('Notification' in window)) return 'unsupported';
  const permission = Notification.permission;
  if (permission === 'default') return 'prompt';
  return permission as PushPermissionState;
}

export function usePushSubscription(): UsePushSubscriptionReturn {
  const [isSupported] = useState(isPushSupported);
  const [permissionState, setPermissionState] = useState<PushPermissionState>(getPermissionState);
  // Start with null to indicate "checking" state
  const [isSubscribed, setIsSubscribed] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);

  // Fetch VAPID public key and check subscription status on mount
  useEffect(() => {
    if (!isSupported) {
      setIsSubscribed(false);
      return;
    }

    async function init() {
      try {
        // Fetch VAPID key from backend
        const { publicKey } = await api.getVapidPublicKey();
        setVapidPublicKey(publicKey);

        if (!publicKey) {
          // Push not configured on server
          setIsSubscribed(false);
          return;
        }

        // Check if browser has an existing subscription
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();

        if (subscription) {
          // Check if subscription was created with a different VAPID key
          // by comparing the applicationServerKey
          const existingKey = subscription.options.applicationServerKey;
          const currentKey = urlBase64ToUint8Array(publicKey);

          let keyMatches = false;
          if (existingKey) {
            const existingArray = new Uint8Array(existingKey);
            keyMatches = existingArray.length === currentKey.length &&
              existingArray.every((val, i) => val === currentKey[i]);
          }

          if (!keyMatches) {
            // VAPID key changed - need to unsubscribe and resubscribe
            await subscription.unsubscribe();
            setIsSubscribed(false);
            return;
          }

          // Re-register with server (in case server restarted and lost in-memory subscriptions)
          const json = subscription.toJSON();
          if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
            try {
              await api.subscribePush({
                endpoint: json.endpoint,
                keys: {
                  p256dh: json.keys.p256dh,
                  auth: json.keys.auth,
                },
              });
            } catch {
              // Server might reject (e.g., invalid endpoint) - unsubscribe and let user resubscribe
              await subscription.unsubscribe();
              setIsSubscribed(false);
              return;
            }
          }
          setIsSubscribed(true);
        } else {
          setIsSubscribed(false);
        }
      } catch (err) {
        // VAPID key not configured or other error - push not available
        console.error('Push init error:', err);
        setVapidPublicKey(null);
        setIsSubscribed(false);
      }
    }

    init();
  }, [isSupported]);

  const subscribe = useCallback(async () => {
    if (!isSupported) {
      setError('Push notifications are not supported in this browser');
      return;
    }

    if (!vapidPublicKey) {
      setError('Push notifications are not configured on the server');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Request notification permission if needed
      const permission = await Notification.requestPermission();
      setPermissionState(permission === 'default' ? 'prompt' : permission as PushPermissionState);

      if (permission !== 'granted') {
        setError('Notification permission denied');
        setIsLoading(false);
        return;
      }

      // Get service worker registration
      const registration = await navigator.serviceWorker.ready;

      // Subscribe to push
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      // Extract subscription data
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error('Invalid subscription data');
      }

      const subscriptionData: PushSubscriptionJSON = {
        endpoint: json.endpoint,
        keys: {
          p256dh: json.keys.p256dh,
          auth: json.keys.auth,
        },
      };

      // Send subscription to backend
      await api.subscribePush(subscriptionData);
      setIsSubscribed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to subscribe to push notifications');
    } finally {
      setIsLoading(false);
    }
  }, [isSupported, vapidPublicKey]);

  const unsubscribe = useCallback(async () => {
    if (!isSupported) return;

    setIsLoading(true);
    setError(null);

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        // Unsubscribe from backend
        await api.unsubscribePush(subscription.endpoint);
        // Unsubscribe from push manager
        await subscription.unsubscribe();
      }

      setIsSubscribed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unsubscribe from push notifications');
    } finally {
      setIsLoading(false);
    }
  }, [isSupported]);

  return {
    isSupported,
    permissionState,
    isSubscribed,
    isLoading,
    error,
    subscribe,
    unsubscribe,
  };
}
