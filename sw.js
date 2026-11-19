// Service worker ILLICO
// Changer ce numéro force la mise à jour du cache chez tous les utilisateurs.
const CACHE = 'illico-v5';

// Fichiers de l'app (même dossier que ce fichier)
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'supabase.js',
  'auth.js',
  'utils.js',
  'notify.js',
  'missions.js',
  'sheet.js',
  'review.js',
  'wallet.js',
  'data.js',
  'nav.js',
  'pwa.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
];

// Librairies externes qu'on garde pour que l'écran ne soit pas cassé hors-ligne
const CDN_HOSTS = ['cdn.tailwindcss.com', 'unpkg.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Toucher une notification ramène sur l'app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow('./');
    })
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Ne jamais toucher à Supabase ni à la connexion Google : toujours le réseau
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('google.com') || url.hostname.endsWith('googleapis.com')) return;

  // Fichiers de l'app : réseau d'abord (toujours à jour), cache si hors-ligne
  if (url.origin === self.location.origin) {
    event.respondWith(
      // no-cache : on ignore le cache HTTP de GitHub Pages (10 min) pour ne jamais mélanger d'anciens et de nouveaux fichiers
      fetch(req, { cache: 'no-cache' })
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('index.html')))
    );
    return;
  }

  // Librairies CDN : cache d'abord, mise à jour en arrière-plan
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then(hit => {
        const refresh = fetch(req)
          .then(res => {
            if (res && (res.ok || res.type === 'opaque')) {
              const copy = res.clone();
              caches.open(CACHE).then(c => c.put(req, copy));
            }
            return res;
          })
          .catch(() => hit);
        return hit || refresh;
      })
    );
  }
});
