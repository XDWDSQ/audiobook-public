/* sw.js — 有声书馆 Service Worker
 * 策略：
 *   - HTML 页面：network-first，保证结构最新（仅在断网时回退缓存）
 *   - 章节数据（data.json / chapters.js）：network-first，保证内容最新
 *   - CSS/JS/图标：stale-while-revalidate，离线可用
 *   - 音频（.mp3）：cache-first（优先从缓存读取，无缓存时走网络）
 *     缓存由播放器页面的 prefetch 逻辑主动填充
 */
const VERSION = 'audiobook-hub-v8';
const SHELL_CACHE = 'shell-' + VERSION;
const AUDIO_CACHE = 'audio-' + VERSION;

const SHELL_ASSETS = [
  './',
  './index.html',
  './zhixiao/index.html',
  './zhixiao/data.json',
  './zhixiao/sw.js',
  './nanian/index.html',
  './nanian/chapters.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) =>
        (k.startsWith('shell-audiobook-hub-') || k.startsWith('audio-audiobook-hub-')) &&
        k !== SHELL_CACHE && k !== AUDIO_CACHE
      ).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // 接收预缓存请求：下载音频并存入 AUDIO_CACHE
  if (event.data && event.data.type === 'PREFETCH_AUDIO') {
    const urls = event.data.urls || [];
    event.waitUntil(
      caches.open(AUDIO_CACHE).then((cache) =>
        Promise.allSettled(urls.map((url) =>
          cache.match(url).then((hit) => {
            if (hit) return Promise.resolve(); // 已缓存，跳过
            return fetch(url, { mode: 'cors' }).then((resp) => {
              if (resp && resp.status === 200) {
                return cache.put(url, resp);
              }
            }).catch(() => {});
          })
        ))
      ).then(() => {
        // 通知所有客户端缓存完成
        self.clients.matchAll().then((clients) => {
          clients.forEach((c) => c.postMessage({ type: 'PREFETCH_DONE', urls }));
        });
      })
    );
  }
  // 查询已缓存的音频列表
  if (event.data && event.data.type === 'QUERY_CACHED_AUDIO') {
    event.waitUntil(
      caches.open(AUDIO_CACHE).then((cache) =>
        cache.keys().then((reqs) => {
          const cached = reqs.map((r) => r.url);
          self.clients.matchAll().then((clients) => {
            clients.forEach((c) => c.postMessage({ type: 'CACHED_AUDIO_LIST', urls: cached }));
          });
        })
      )
    );
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 音频：cache-first（优先缓存，无缓存走网络）
  if (/\.(mp3|m4a|ogg|wav)$/i.test(url.pathname)) {
    event.respondWith(
      caches.open(AUDIO_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((resp) => {
            if (resp && resp.status === 200) {
              const copy = resp.clone();
              cache.put(req, copy).catch(() => {});
            }
            return resp;
          }).catch(() => new Response('', { status: 503, statusText: 'Offline' }));
        })
      )
    );
    return;
  }

  // HTML + 章节数据：network-first
  if (/(\.html$|\/$|data\.json$|chapters\.js$)/i.test(url.pathname)) {
    event.respondWith(
      fetch(req).then((resp) => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match(req).then((c) => c || Response.error()))
    );
    return;
  }

  // 其余外壳资源：stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((resp) => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
