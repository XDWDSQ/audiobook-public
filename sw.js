/* sw.js — 有声书馆 Service Worker
 * 策略：
 *   - HTML 页面：network-first，保证结构最新（仅在断网时回退缓存）
 *   - 章节数据（data.json / chapters.js）：network-first，保证内容最新
 *   - CSS/JS/图标：stale-while-revalidate，离线可用
 *   - 音频（.mp3）：不缓存，交给浏览器/HTTP 缓存直连
 */
const VERSION = 'audiobook-hub-v6';
const SHELL_CACHE = 'shell-' + VERSION;

// 预缓存的应用外壳资源（相对 SW 作用域，即站点根）
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './_shared/audiobook-common.css',
  './_shared/audiobook-common.js',
  './_shared/performance-optimized.css',
  './zhixiao/index.html',
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
      keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// 新 SW 接管后通知所有页面刷新
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 仅处理同源请求
  if (url.origin !== self.location.origin) return;

  // 音频：直连网络，不走 SW 缓存（避免大文件撑爆缓存）
  if (/\.(mp3|m4a|ogg|wav)$/i.test(url.pathname)) return;

  // HTML 页面 + 章节数据：network-first，保证内容最新
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

  // 其余外壳资源（CSS/JS/图标）：stale-while-revalidate
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
