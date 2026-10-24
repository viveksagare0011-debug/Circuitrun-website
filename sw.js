// CircuitRun admin: shows a notification when the server sends a push, opens the admin panel on tap.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('🆕 CircuitRun: order waiting', {
    body: 'Open the admin panel and tap Accept order.',
    icon: 'brand/icon-192.png',
    badge: 'brand/icon-64.png',
    tag: 'cr-order',                 // new pushes replace the old card but still alert
    renotify: true,
    requireInteraction: true,        // stays on screen until you act
    vibrate: [400, 150, 400, 150, 800],
    data: { url: 'admin.html' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || 'admin.html', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url.startsWith(url) && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
