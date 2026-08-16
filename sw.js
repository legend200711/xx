/**
 * Shadow Fire Live — Service Worker  (sw.js)
 *
 * Caching strategy:
 *   Navigation (HTML page loads)  → Network-first → cached copy → offline.html
 *   Same-origin assets (CSS/JS)   → Cache-first, network fallback
 *   Firebase / external APIs      → Network-only (never cache auth or Firestore)
 *   Cross-origin CDN media        → Stale-while-revalidate, 24 h TTL, 100-entry LRU
 *   Live-streaming files           → Network-only (always fresh)
 *
 * Update flow:
 *   New SW installs → skipWaiting() immediately → clients.claim().
 *   The app page listens for `controllerchange` and reloads transparently.
 *   User data (Firebase Auth, Firestore) is never touched — only HTTP caches.
 */

'use strict';

/* ─── Version — bump this string to force a full cache refresh ─── */
const CACHE_VERSION = 'sfl-v1';
const CACHE_NAME    = `sfl-shell-${CACHE_VERSION}`;
const MEDIA_CACHE   = `sfl-media-${CACHE_VERSION}`;

/* ─── Base path (works at root / or any sub-path during dev) ─── */
const SW_URL  = new URL(self.location.href);
const BASE    = SW_URL.pathname.replace(/sw\.js$/, '');
const OFFLINE = `${BASE}offline.html`;

/* ─── App-shell files to pre-cache on install ─── */
const SHELL_FILES = [
  /* Entry points */
  'sfl-splash.html',
  'sfl-home.html',
  'sfl-login.html',
  'sfl-profile.html',
  'sfl-search.html',
  'sfl-upload.html',
  'sfl-player.html',
  'sfl-notifications.html',
  'sfl-settings.html',
  'offline.html',
  'index.html',

  /* Styles */
  'sfl-theme.css',
  'style.css',
  'live.css',
  'mobile.css',
  'profile-theme.css',
  'profile-music.css',

  /* Scripts */
  'script.js',
  'snx-net.js',
  'pwa-install.js',

  /* PWA assets */
  'manifest.json',
  'icon-192.png',
  'icon-192-maskable.png',
  'icon-512.png',
  'icon-512-maskable.png',
  'apple-touch-icon.png',
  'favicon.ico',
  'favicon-32x32.png',
  'favicon-16x16.png',
];

/* ─── Paths that must NEVER be served from cache ─── */
const NETWORK_ONLY_PATHS = [
  'live.html',
  'live.js',
  'live-hub.html',
  'live-room.html',
];

/* ─── External hosts that must NEVER be cached ─── */
const NETWORK_ONLY_HOSTS = [
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'www.gstatic.com',
  'firebaseio.com',
  'googleapis.com',
  'workers.dev',
  'cloudflare.com',
  'cdn.shadownexus.social',
  'photos.shadownexus.social',
  'r2.dev',
  'cloudflarestorage.com',
];

const PRECACHE_URLS       = SHELL_FILES.map(f => `${BASE}${f}`);
const MEDIA_CACHE_MAX     = 100;
const MEDIA_CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 h

/* ════════════════════════════════════════════════
   INSTALL — pre-cache the app shell
   ════════════════════════════════════════════════ */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache =>
        Promise.allSettled(
          PRECACHE_URLS.map(url =>
            cache.add(url).catch(err =>
              console.warn(`[SFL SW] Pre-cache skipped: ${url}`, err.message)
            )
          )
        )
      )
      /* Take over immediately — don't wait for old tabs to close */
      .then(() => self.skipWaiting())
  );
});

/* ════════════════════════════════════════════════
   ACTIVATE — delete old caches, claim clients
   ════════════════════════════════════════════════ */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names =>
        Promise.all(
          names
            .filter(n => n !== CACHE_NAME && n !== MEDIA_CACHE)
            .map(n => {
              console.log(`[SFL SW] Deleting old cache: ${n}`);
              return caches.delete(n);
            })
        )
      )
      /* Immediately control all open pages */
      .then(() => self.clients.claim())
      /* Notify every client that an update has been applied */
      .then(() =>
        self.clients.matchAll({ type: 'window' }).then(clients =>
          clients.forEach(c => c.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION }))
        )
      )
  );
});

/* ════════════════════════════════════════════════
   FETCH — request routing
   ════════════════════════════════════════════════ */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* Only intercept GET */
  if (request.method !== 'GET') return;

  /* Firebase / external API hosts — always network */
  if (NETWORK_ONLY_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(fetch(request));
    return;
  }

  /* Live-streaming pages — always network-fresh */
  if (
    url.origin === self.location.origin &&
    NETWORK_ONLY_PATHS.some(p => url.pathname.endsWith(p))
  ) {
    event.respondWith(fetch(request));
    return;
  }

  /* Navigation requests (page loads) — network-first → cache → offline */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then(c => c.put(request, response.clone()));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then(cached => cached || caches.match(OFFLINE))
        )
    );
    return;
  }

  /* Same-origin assets — cache-first, network fallback */
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then(c => c.put(request, response.clone()));
          }
          return response;
        }).catch(() => new Response('', { status: 404, statusText: 'Not Found' }));
      })
    );
    return;
  }

  /* Cross-origin CDN media (images, avatars) — stale-while-revalidate */
  const isMedia = /\.(jpe?g|png|gif|webp|svg|avif)(\?|$)/i.test(url.pathname);
  if (isMedia) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then(async cache => {
        const cached = await cache.match(request);
        if (cached) {
          const age = (() => {
            const d = cached.headers.get('date');
            return d ? Date.now() - new Date(d).getTime() : Infinity;
          })();
          if (age < MEDIA_CACHE_MAX_AGE) return cached;
          /* Stale — serve cached but refresh in background */
          fetch(request).then(fresh => {
            if (fresh && fresh.status === 200) {
              _trimCache(cache, MEDIA_CACHE_MAX).then(() => cache.put(request, fresh.clone()));
            }
          }).catch(() => {});
          return cached;
        }
        /* Not cached — fetch, store, return */
        try {
          const response = await fetch(request);
          if (response && response.status === 200) {
            await _trimCache(cache, MEDIA_CACHE_MAX);
            cache.put(request, response.clone());
          }
          return response;
        } catch (_) {
          return cached || new Response('', { status: 503 });
        }
      })
    );
    return;
  }

  /* Cross-origin non-media (CDN fonts, scripts) — network-first, cache fallback */
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.status === 200) {
          caches.open(CACHE_NAME).then(c => c.put(request, response.clone()));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

/* ════════════════════════════════════════════════
   MESSAGE — commands from page scripts
   ════════════════════════════════════════════════ */
self.addEventListener('message', event => {
  const { data } = event;
  if (!data) return;

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (data.type === 'CLEAR_CACHE') {
    Promise.all([caches.delete(CACHE_NAME), caches.delete(MEDIA_CACHE)])
      .then(() => event.source?.postMessage({ type: 'CACHE_CLEARED' }));
  }

  if (data.type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
  }

  /* Network quality state from snx-net.js */
  if (data.type === 'SNX_NET_STATE' && data.dataSaver) {
    caches.open(MEDIA_CACHE).then(cache =>
      cache.keys().then(keys => {
        if (keys.length > 30) {
          keys.slice(0, keys.length - 30).forEach(k => cache.delete(k));
        }
      })
    ).catch(() => {});
  }
});

/* ─── LRU trim helper ─── */
async function _trimCache(cache, max) {
  const keys = await cache.keys();
  if (keys.length >= max) {
    const remove = keys.slice(0, keys.length - max + 1);
    await Promise.all(remove.map(k => cache.delete(k)));
  }
}
