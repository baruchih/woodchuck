/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';

declare let self: ServiceWorkerGlobalScope;

// Skip waiting when told to by the client (update banner reload)
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Activate immediately and claim all clients
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Precache assets injected by vite-plugin-pwa
precacheAndRoute(self.__WB_MANIFEST);

// Handle push events from the server
self.addEventListener('push', (event: PushEvent) => {
  const data = event.data?.json() ?? {
    title: 'Woodchuck',
    body: 'Session update',
    session_id: null,
  };

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      // Android status bar icon (must be monochrome - white silhouette on transparent)
      badge: '/icons/badge-mono.png',
      tag: data.session_id ? `woodchuck-${data.session_id}` : 'woodchuck',
      data: { session_id: data.session_id },
    })
  );
});

// Handle notification click - navigate to session or home
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const sessionId = event.notification.data?.session_id;
  const url = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientList) => {
      // Focus existing window if open
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Otherwise open new window
      return self.clients.openWindow(url);
    })
  );
});
