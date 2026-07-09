/* Agraffen App – Service Worker (Offline-Fähigkeit)
   Strategie:
   - HTML/App-Seite: network-first (online immer frisch -> Updates hängen nie),
     offline Rückfall auf zuletzt gecachte Version.
   - Statische Assets (Leaflet, Firebase-SDK, Icons): cache-first.
   - Firebase-Live-Traffic (Sync/Chat): NIE abgefangen -> braucht echtes Netz.
   - Karten-Kacheln: network, offline Rückfall auf bereits Gesehenes.
*/
const VERSION = '2.44';
const CACHE = 'agraffen-' + VERSION;
const CDN = ['unpkg.com', 'www.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(['./', './index.html']).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('agraffen-') && k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Live Firebase / API-Traffic: niemals abfangen (braucht echtes Netz)
  if (url.hostname.endsWith('firebasedatabase.app') ||
      url.hostname.endsWith('firebaseio.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('google-analytics') ||
      url.hostname.includes('firebaseinstallations')) {
    return;
  }

  // App-Seite: network-first, offline Rückfall auf gecachte Kopie
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Karten-Kacheln: network, offline Rückfall auf Gecachtes
  if (url.hostname.includes('tile.') || url.hostname.includes('openstreetmap') || url.hostname.includes('basemaps')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Statische Assets (Leaflet, Firebase-SDK, Icons): cache-first, dann network
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res && (url.origin === self.location.origin || CDN.includes(url.hostname))) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
    })
  );
});

// ======== Push-Benachrichtigungen ========
self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; }
  catch (_) { try { p = { body: e.data.text() }; } catch (e2) {} }
  // FCM verpackt eigene Felder je nach Nachrichtentyp unter data/notification
  const s = p.data || p.notification || p;
  const title = s.title || p.title || 'Agraffen';
  const body  = s.body  || p.body  || 'Neues in der App';
  const tag   = s.tag   || p.tag   || 'agraffen';
  e.waitUntil(self.registration.showNotification(title, {
    body: body,
    icon: 'icon-512.png',
    badge: 'icon-512.png',
    tag: tag,
    data: s
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
});
