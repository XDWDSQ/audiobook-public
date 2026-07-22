/* 知晓有声书 Service Worker — 外壳与音频分离缓存，支持断网续播 */
const VERSION = 'zhixiao-audiobook-v2';
const SHELL_CACHE = VERSION + '-shell';
const AUDIO_CACHE = VERSION;

const SHELL = [
  './',
  './index.html',
  './data.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names
        .filter((name) => name.startsWith('zhixiao-audiobook-') && name !== SHELL_CACHE && name !== AUDIO_CACHE)
        .map((name) => caches.delete(name))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isAudioRequest(url.pathname)) {
    event.respondWith(
      caches.open(AUDIO_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone()).catch(() => {});
            return response;
          }).catch(() => new Response('', { status: 503, statusText: 'Offline' }));
        })
      )
    );
    return;
  }

  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok) {
        caches.open(SHELL_CACHE).then((cache) => cache.put(request, response.clone())).catch(() => {});
      }
      return response;
    }).catch(() => caches.match(request).then((cached) => {
      if (cached) return cached;
      if (request.mode === 'navigate') return caches.match('./index.html');
      return new Response('离线不可用', { status: 503, statusText: 'Offline' });
    }))
  );
});

function isAudioRequest(pathname) {
  return /\/chapters\/ch\d+\.mp3$/i.test(pathname);
}
