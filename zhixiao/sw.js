/* sw.js — 知晓有声书 Service Worker (v10)
 *
 * 统一缓存策略：
 *   page-cache   — HTML 页面 / 章节数据：network-first，离线回退缓存
 *   static-cache — CSS / JS / 图片：stale-while-revalidate
 *   font-cache   — 字体文件：cache-first，长期缓存
 *   audio-cache  — 音频文件：cache-first，容量上限 + LRU 淘汰
 *
 * 命名空间前缀：audiobook-hub-
 * 本书标识：zhixiao
 * 完整缓存名：{type}-audiobook-hub-zhixiao-v{version}
 *
 * 消息 API：
 *   SKIP_WAITING              — 立即激活新 SW
 *   PREFETCH_AUDIO  {urls}    — 预下载音频
 *   QUERY_CACHED_AUDIO        — 查询已缓存音频列表
 *   CLEAR_AUDIO_CACHE         — 清空音频缓存
 *   GET_CACHE_INFO            — 获取缓存统计信息
 */

const SW_ID = 'zhixiao';
const VERSION = 10;
const CACHE_PREFIX = 'audiobook-hub-';

const PAGE_CACHE   = `page-${CACHE_PREFIX}${SW_ID}-v${VERSION}`;
const STATIC_CACHE = `static-${CACHE_PREFIX}${SW_ID}-v${VERSION}`;
const FONT_CACHE   = `font-${CACHE_PREFIX}${SW_ID}-v${VERSION}`;
const AUDIO_CACHE  = `audio-${CACHE_PREFIX}${SW_ID}-v${VERSION}`;

const ALL_CACHES = [PAGE_CACHE, STATIC_CACHE, FONT_CACHE, AUDIO_CACHE];

// 音频缓存容量上限（字节）：默认 500MB
const AUDIO_CACHE_LIMIT = 500 * 1024 * 1024;

// 安装时预缓存的外壳资源
const SHELL_ASSETS = [
  './',
  './index.html',
  './data.json',
  '../_shared/audiobook-common.js',
  '../_shared/audiobook-common.css'
];

/* ---------- 工具函数 ---------- */

function isAudioRequest(pathname) {
  return /\.(mp3|m4a|ogg|wav|aac|flac)$/i.test(pathname);
}

function isFontRequest(pathname) {
  return /\.(woff2?|ttf|otf|eot)$/i.test(pathname);
}

function isPageRequest(pathname) {
  // HTML 页面、目录路径、章节数据
  return /(\.html$|\/$|data\.json$|chapters\.js$|\/sitemap\.xml$)/i.test(pathname);
}

function isStaticRequest(pathname) {
  // CSS / JS / 图片 / 图标
  return /\.(css|js|mjs|png|jpg|jpeg|gif|webp|svg|ico|webmanifest)$/i.test(pathname);
}

/* ---------- 音频缓存 LRU 管理（基于 IndexedDB 追踪访问时间） ---------- */

const DB_NAME = 'audiobook-hub-cache-meta-zhixiao';
const DB_VERSION = 1;
const AUDIO_STORE = 'audio-entries';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        const store = db.createObjectStore(AUDIO_STORE, { keyPath: 'url' });
        store.createIndex('lastAccess', 'lastAccess', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function updateAudioMeta(url, size) {
  return openDB().then((db) => {
    return new Promise((resolve) => {
      const tx = db.transaction(AUDIO_STORE, 'readwrite');
      tx.objectStore(AUDIO_STORE).put({
        url: url,
        size: size || 0,
        lastAccess: Date.now()
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  }).catch(() => {});
}

function touchAudioMeta(url) {
  return openDB().then((db) => {
    return new Promise((resolve) => {
      const tx = db.transaction(AUDIO_STORE, 'readwrite');
      const store = tx.objectStore(AUDIO_STORE);
      const req = store.get(url);
      req.onsuccess = () => {
        const entry = req.result;
        if (entry) {
          entry.lastAccess = Date.now();
          store.put(entry);
        }
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  }).catch(() => {});
}

function evictAudioIfNeeded() {
  return openDB().then((db) => {
    return new Promise((resolve) => {
      const tx = db.transaction(AUDIO_STORE, 'readonly');
      const store = tx.objectStore(AUDIO_STORE);
      const idx = store.index('lastAccess');
      const entries = [];
      let total = 0;
      idx.openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          entries.push(cursor.value);
          total += cursor.value.size || 0;
          cursor.continue();
        }
      };
      tx.oncomplete = () => {
        db.close();
        if (total <= AUDIO_CACHE_LIMIT) { resolve(0); return; }
        // 按访问时间升序（最久未用在前），删除直到低于上限 90%
        let freed = 0;
        const toDelete = [];
        for (const entry of entries) {
          if (total - freed <= AUDIO_CACHE_LIMIT * 0.9) break;
          toDelete.push(entry.url);
          freed += entry.size || 0;
        }
        if (toDelete.length === 0) { resolve(0); return; }
        // 从 Cache 和 IndexedDB 删除
        Promise.all([
          caches.open(AUDIO_CACHE).then((cache) =>
            Promise.all(toDelete.map((url) => cache.delete(url)))
          ),
          openDB().then((db2) => {
            return new Promise((resolve2) => {
              const tx2 = db2.transaction(AUDIO_STORE, 'readwrite');
              toDelete.forEach((url) => tx2.objectStore(AUDIO_STORE).delete(url));
              tx2.oncomplete = () => { db2.close(); resolve2(); };
              tx2.onerror = () => { db2.close(); resolve2(); };
            });
          })
        ]).then(() => resolve(toDelete.length)).catch(() => resolve(0));
      };
      tx.onerror = () => { db.close(); resolve(0); };
    });
  }).catch(() => 0);
}

function clearAllAudioMeta() {
  return openDB().then((db) => {
    return new Promise((resolve) => {
      const tx = db.transaction(AUDIO_STORE, 'readwrite');
      tx.objectStore(AUDIO_STORE).clear();
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  }).catch(() => {});
}

function getAudioStats() {
  return openDB().then((db) => {
    return new Promise((resolve) => {
      const tx = db.transaction(AUDIO_STORE, 'readonly');
      const store = tx.objectStore(AUDIO_STORE);
      let count = 0;
      let total = 0;
      store.openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          count++;
          total += cursor.value.size || 0;
          cursor.continue();
        }
      };
      tx.oncomplete = () => { db.close(); resolve({ count, total }); };
      tx.onerror = () => { db.close(); resolve({ count: 0, total: 0 }); };
    });
  }).catch(() => ({ count: 0, total: 0 }));
}

/* ---------- 缓存策略实现 ---------- */

// 策略 1: cache-first（音频、字体）
function cacheFirst(cacheName, request, trackAudio) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => {
      if (cached) {
        if (trackAudio) touchAudioMeta(request.url);
        return cached;
      }
      return fetch(request).then((resp) => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          if (trackAudio) {
            // 估算大小并更新元数据
            resp.clone().arrayBuffer().then((buf) => {
              updateAudioMeta(request.url, buf.byteLength);
              evictAudioIfNeeded();
            }).catch(() => {});
          }
          cache.put(request, copy).catch(() => {});
        }
        return resp;
      }).catch(() => new Response('', { status: 503, statusText: 'Offline' }));
    })
  );
}

// 策略 2: network-first（页面、章节数据）
function networkFirst(cacheName, request) {
  return fetch(request).then((resp) => {
    if (resp && resp.status === 200) {
      const copy = resp.clone();
      caches.open(cacheName).then((c) => c.put(request, copy)).catch(() => {});
    }
    return resp;
  }).catch(() =>
    caches.match(request).then((cached) => {
      if (cached) return cached;
      // 导航请求离线回退到首页
      if (request.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    })
  );
}

// 策略 3: stale-while-revalidate（静态资源）
function staleWhileRevalidate(cacheName, request) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => {
      const networkPromise = fetch(request).then((resp) => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          cache.put(request, copy).catch(() => {});
        }
        return resp;
      }).catch(() => cached);
      return cached || networkPromise;
    })
  );
}

/* ---------- 生命周期事件 ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PAGE_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) =>
        // 清理所有同名空间下非当前版本的缓存
        k.includes(CACHE_PREFIX + SW_ID + '-') &&
        !ALL_CACHES.includes(k)
      ).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

/* ---------- 消息处理 ---------- */

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  const data = event.data || {};

  // 预下载音频
  if (data.type === 'PREFETCH_AUDIO') {
    const urls = data.urls || [];
    event.waitUntil(
      caches.open(AUDIO_CACHE).then((cache) =>
        Promise.allSettled(urls.map((url) =>
          cache.match(url).then((hit) => {
            if (hit) return Promise.resolve(); // 已缓存，跳过
            return fetch(url, { mode: 'cors' }).then((resp) => {
              if (resp && resp.status === 200) {
                const copy = resp.clone();
                resp.clone().arrayBuffer().then((buf) => {
                  updateAudioMeta(url, buf.byteLength);
                }).catch(() => {});
                return cache.put(url, copy);
              }
            }).catch(() => {});
          })
        ))
      ).then(() => {
        // 缓存完成后执行淘汰
        evictAudioIfNeeded();
        // 通知所有客户端
        self.clients.matchAll().then((clients) => {
          clients.forEach((c) => c.postMessage({ type: 'PREFETCH_DONE', urls }));
        });
      })
    );
    return;
  }

  // 查询已缓存音频列表
  if (data.type === 'QUERY_CACHED_AUDIO') {
    event.waitUntil(
      caches.open(AUDIO_CACHE).then((cache) =>
        cache.keys().then((reqs) => {
          const cached = reqs.map((r) => r.url);
          self.clients.matchAll().then((clients) => {
            clients.forEach((c) =>
              c.postMessage({ type: 'CACHED_AUDIO_LIST', urls: cached })
            );
          });
        })
      )
    );
    return;
  }

  // 清空音频缓存
  if (data.type === 'CLEAR_AUDIO_CACHE') {
    event.waitUntil(
      Promise.all([
        caches.delete(AUDIO_CACHE),
        clearAllAudioMeta()
      ]).then(() => {
        self.clients.matchAll().then((clients) => {
          clients.forEach((c) => c.postMessage({ type: 'AUDIO_CACHE_CLEARED' }));
        });
      })
    );
    return;
  }

  // 获取缓存统计信息
  if (data.type === 'GET_CACHE_INFO') {
    event.waitUntil(
      getAudioStats().then((stats) => {
        self.clients.matchAll().then((clients) => {
          clients.forEach((c) =>
            c.postMessage({
              type: 'CACHE_INFO',
              audioCount: stats.count,
              audioSize: stats.total,
              audioLimit: AUDIO_CACHE_LIMIT,
              swId: SW_ID,
              version: VERSION
            })
          );
        });
      })
    );
    return;
  }
});

/* ---------- Fetch 事件 ---------- */

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // 1. 音频：cache-first + LRU
  if (isAudioRequest(path)) {
    event.respondWith(cacheFirst(AUDIO_CACHE, req, true));
    return;
  }

  // 2. 字体：cache-first 长期缓存
  if (isFontRequest(path)) {
    event.respondWith(cacheFirst(FONT_CACHE, req, false));
    return;
  }

  // 3. 页面 + 章节数据：network-first
  if (isPageRequest(path)) {
    event.respondWith(networkFirst(PAGE_CACHE, req));
    return;
  }

  // 4. 静态资源（CSS/JS/图片）：stale-while-revalidate
  if (isStaticRequest(path)) {
    event.respondWith(staleWhileRevalidate(STATIC_CACHE, req));
    return;
  }

  // 5. 其他请求：stale-while-revalidate 兜底
  event.respondWith(staleWhileRevalidate(STATIC_CACHE, req));
});
