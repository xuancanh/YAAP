/* yaam service worker — push notifications only.
 *
 * Deliberately no fetch handler: the app is always served fresh by the
 * server, and a caching worker is the classic way to ship stale code to a
 * PWA. Payloads are the JSON PushService writes: { title, body, tag, url }. */

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'YAAM', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'YAAM';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
    renotify: Boolean(data.tag),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Reuse an open app tab: hash navigation keeps its state; otherwise open one.
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) { try { await client.navigate(target); } catch { /* cross-origin or unsupported */ } }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
