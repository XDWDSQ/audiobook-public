/* sw.js — 有声书馆着陆页 Service Worker (v2)
 *
 * v2：install 预缓存改逐 URL（原 addAll 原子失败被静默吞掉，缓存可能整批落空）；
 *     staleWhileRevalidate 无缓存+离线兜底改在 Promise resolve 后判空
 *     （原 `cached || network || 503` 中 network 恒真值，503 为死代码）。
 *
 * 作用：让着陆页（首页）可离线访问，并为「安装为应用」提供必要的 SW 前提
 *       （浏览器要求页面受 SW 控制且满足 manifest 才会派发 beforeinstallprompt）。
 * 范围：仅缓存着陆页外壳（首页 HTML / manifest / 图标 / OG 封面）；
 *       三本书的播放器与音频由各书目录下的 sw.js 独立管理，本 SW 不介入。
 *
 * 策略：页面 network-first（在线永远拿最新，离线回退缓存）；
 *       静态资源 stale-while-revalidate。
 *
 * 命名空间前缀：audiobook-hub-；本书标识：landing
 * 完整缓存名：{type}-audiobook-hub-landing-v{version}
 */

const SW_ID = 'landing';
const VERSION = 2;
const CACHE_PREFIX = 'audiobook-hub-';

const PAGE_CACHE = `page-${CACHE_PREFIX}${SW_ID}-v${VERSION}`;
const STATIC_CACHE = `static-${CACHE_PREFIX}${SW_ID}-v${VERSION}`;

const SHELL = {
  page: ['./', './index.html'],
  static: ['./manifest.json', './icon-192.png', './icon-512.png', './og-cover.png'],
};

self.addEventListener('install', (event) => {
  // 逐 URL 预缓存：addAll 是原子操作，任一 404 会整批落空且难以定位；
  // 单条失败仅 console.warn 留痕，不阻断 install
  const addAll = (cacheName, urls) =>
    caches.open(cacheName).then((c) =>
      Promise.all(urls.map((u) =>
        c.add(u).catch((e) => console.warn('[landing-sw] 预缓存失败:', u, e && e.message))
      ))
    );
  event.waitUntil(
    Promise.all([addAll(PAGE_CACHE, SHELL.page), addAll(STATIC_CACHE, SHELL.static)])
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.includes(CACHE_PREFIX + SW_ID + '-') && ![PAGE_CACHE, STATIC_CACHE].includes(k))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isPage(pathname) {
  return /(\.html$|\/$)/i.test(pathname);
}

function networkFirst(cacheName, request) {
  return fetch(request)
    .then((resp) => {
      if (resp && resp.status === 200) {
        const copy = resp.clone();
        caches.open(cacheName).then((c) => c.put(request, copy)).catch(() => {});
      }
      return resp;
    })
    .catch(() =>
      caches.match(request).then((cached) => cached || caches.match('./index.html').then((home) => home || Response.error()))
    );
}

function staleWhileRevalidate(cacheName, request) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            cache.put(request, copy).catch(() => {});
          }
          return resp;
        })
        .catch(() => cached || null);
      // cached 为空时 network 是 Promise（恒真值），必须在其 resolve 后再判空，
      // 否则无缓存+离线的请求会以 TypeError 失败而非受控的 503
      return cached || network.then((r) => r || new Response('', { status: 503, statusText: 'Offline' }));
    })
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 只接管站点根目录的着陆页资源；子目录（/zhixiao/ 等）交给各自的 SW
  if (!/^\/(index\.html|manifest\.json|icon-.*\.png|og-cover\.png)?$/i.test(url.pathname)) return;

  if (isPage(url.pathname) || url.pathname === '/') {
    event.respondWith(networkFirst(PAGE_CACHE, req));
  } else {
    event.respondWith(staleWhileRevalidate(STATIC_CACHE, req));
  }
});
