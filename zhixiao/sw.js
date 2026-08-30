/* sw.js — 知晓有声书 Service Worker (v14)
 *
 * v14 性能改进：serveRange 改 Blob 零拷贝切片（seek 不再整章复制进 JS 内存）；
 * touchAudioMeta 5 分钟节流（seek 密集时不再每请求开一次 IndexedDB）。
 *
 * 统一缓存策略：
 *   page-cache   — HTML 页面：network-first，离线回退缓存
 *                  章节数据 data.json：stale-while-revalidate（安装时预缓存，
 *                  运行时先回缓存再后台更新，首屏不再等网络）
 *   static-cache — CSS / JS / 图片：stale-while-revalidate
 *   font-cache   — 字体文件：cache-first，长期缓存
 *   audio-cache  — 音频文件：整文件单飞下载 + 首播流式转发（边下边播），
 *                  后台重建响应头入缓存；容量上限（650MB）+ LRU 淘汰；
 *                  播放器侧 URL 带 ?v=hash，文件变化时自动失效
 *
 * 命名空间前缀：audiobook-hub-
 * 本书标识：zhixiao
 * 完整缓存名：{type}-audiobook-hub-zhixiao-v{version}
 *
 * 消息 API：
 *   SKIP_WAITING              — 立即激活新 SW
 *   PREFETCH_AUDIO  {urls,runId} — 串行预下载音频，完成后广播 PREFETCH_DONE
 *   PREFETCH_STOP             — 中止当前预取轮次
 *   QUERY_CACHED_AUDIO        — 查询已缓存音频列表
 *   CLEAR_AUDIO_CACHE         — 清空音频缓存
 *   GET_CACHE_INFO            — 获取缓存统计信息
 */

const SW_ID = 'zhixiao';
const VERSION = 15;
const CACHE_PREFIX = 'audiobook-hub-';

const PAGE_CACHE   = `page-${CACHE_PREFIX}${SW_ID}-v${VERSION}`;
const STATIC_CACHE = `static-${CACHE_PREFIX}${SW_ID}-v${VERSION}`;
const FONT_CACHE   = `font-${CACHE_PREFIX}${SW_ID}-v${VERSION}`;
const AUDIO_CACHE  = `audio-${CACHE_PREFIX}${SW_ID}-v${VERSION}`;

const ALL_CACHES = [PAGE_CACHE, STATIC_CACHE, FONT_CACHE, AUDIO_CACHE];

// 音频缓存容量上限（字节）：650MB
const AUDIO_CACHE_LIMIT = 650 * 1024 * 1024;

// 安装时预缓存的外壳资源（按运行策略分仓，避免与页面 fetch 重复写入）
const SHELL_ASSETS = {
  page: ['./', './index.html', './data.json'],
  static: ['../_shared/audiobook-common.js', '../_shared/audiobook-common.css', '../_shared/audiobook-shell.css']
};

/* ---------- 工具函数 ---------- */

function isAudioRequest(pathname) {
  return /\.(mp3|m4a|ogg|wav|aac|flac)$/i.test(pathname);
}

function isFontRequest(pathname) {
  return /\.(woff2?|ttf|otf|eot)$/i.test(pathname);
}

function isPageRequest(pathname) {
  // HTML 页面、目录路径（data.json 单独走 SWR，不在此列）
  return /(\.html$|\/$|\/sitemap\.xml$)/i.test(pathname);
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

// touch 节流：同一 URL 5 分钟窗口内只写一次 lastAccess（seek/预取密集时避免
// 每请求开库+事务；LRU 淘汰按分钟级精度排序，足够）
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;
const lastTouchTs = new Map();

function touchAudioMeta(url) {
  const now = Date.now();
  const prev = lastTouchTs.get(url);
  if (prev && now - prev < TOUCH_THROTTLE_MS) return Promise.resolve();
  lastTouchTs.set(url, now);
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

// 从缓存响应构造 206 切片（浏览器 Range 请求；缓存匹配会忽略 Range 头，
// 若直接返回整包 200，媒体元素会判定资源不可寻址，进度条无法拖动）
function serveRange(cached, request) {
  const range = request.headers.get('range');
  if (!range) return null;
  const m = String(range).trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const size = Number(cached.headers.get('content-length')) || 0;
  if (!size) return null;
  const ct = cached.headers.get('content-type') || 'audio/mpeg';
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start == null) { // 后缀范围（bytes=-N）：取最后 N 字节
    const suffix = end == null ? 0 : end;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (end == null) {
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (start > end || start >= size) {
    return Promise.resolve(new Response('', {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + size }
    }));
  }
  // Blob.slice 是零拷贝引用切片，避免 arrayBuffer 把整章复制进 JS 内存
  return cached.blob().then((blob) => new Response(blob.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': ct,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  }));
}

// 策略 1: cache-first（字体）
function cacheFirst(cacheName, request) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((resp) => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          cache.put(request, copy).catch(() => {});
        }
        return resp;
      }).catch(() => new Response('', { status: 503, statusText: 'Offline' }));
    })
  );
}

/* ---------- 音频：整文件单飞 + 边下边播 ----------
 * v12 的痛点：Range 未命中时先拉整包、arrayBuffer 落缓存后才响应媒体元素，
 * 移动端首播要等整章下完（6MB / 几百 KB/s ≈ 10s+，期间一直 0:00），观感就是「播不了」。
 * v13：
 *   - 整文件下载单飞（audioLoads 去重）：媒体元素与预取共享同一次下载，不抢双倍带宽；
 *   - 首次请求（bytes=0- 或无 Range）直接把网络流转发给媒体元素，首字节即时到达，
 *     同时 tee 一份在后台重建响应头写入缓存（保证缓存命中仍可 seek）；
 *   - 中段 Range（拖进度条）等整包入缓存后本地精确切片，Content-Range 不说谎；
 *   - 已缓存命中走 serveRange 本地切片（同 v12）。 */

const audioLoads = new Map(); // url -> { ready, mediaResponse, mediaClaimed }

function startAudioLoad(url) {
  const existing = audioLoads.get(url);
  if (existing) return existing;
  const load = { ready: null, mediaResponse: null, mediaClaimed: false };
  load.ready = (async () => {
    try {
      const resp = await fetch(url);
      if (!resp || resp.status !== 200 || !resp.body) return;
      const ct = resp.headers.get('content-type') || 'audio/mpeg';
      const size = Number(resp.headers.get('content-length')) || 0;
      const cache = await caches.open(AUDIO_CACHE);
      if (!size) {
        /* 上游缺 Content-Length（罕见）：流式路径无法构造响应头，退回整包缓冲 */
        const buf = await resp.arrayBuffer();
        const headers = {
          'Content-Type': ct,
          'Content-Length': String(buf.byteLength),
          'Accept-Ranges': 'bytes'
        };
        if (load.mediaClaimed) {
          load.mediaResponse = new Response(buf, { status: 200, statusText: 'OK', headers });
        }
        await cache.put(new Request(url), new Response(buf, { status: 200, statusText: 'OK', headers })).catch(() => {});
        if (buf.byteLength) updateAudioMeta(url, buf.byteLength);
        evictAudioIfNeeded();
        return;
      }
      const [media, store] = resp.body.tee();
      const headers = {
        'Content-Type': ct,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes'
      };
      load.mediaResponse = new Response(media, { status: 200, statusText: 'OK', headers });
      await cache.put(new Request(url), new Response(store, { status: 200, statusText: 'OK', headers }));
      updateAudioMeta(url, size);
      evictAudioIfNeeded();
    } catch (_) {
      /* 单章失败由下次请求/预取重试 */
    } finally {
      audioLoads.delete(url);
      /* 纯预取场景下没人认领媒体分支，及时取消释放 tee 缓冲 */
      if (!load.mediaClaimed && load.mediaResponse) {
        try { load.mediaResponse.body.cancel(); } catch (_) {}
      }
    }
  })();
  audioLoads.set(url, load);
  return load;
}

function waitCacheSlice(load, cache, url, request) {
  return load.ready.then(() => cache.match(url)).then((full) => {
    if (!full) return new Response('', { status: 504, statusText: 'Upstream failed' });
    const ranged = serveRange(full, request);
    return ranged || full;
  });
}

/* 音频请求统一入口（cache-first：命中即切片，未命中走单飞下载） */
function respondAudio(request) {
  const url = request.url;
  return caches.open(AUDIO_CACHE).then((cache) =>
    cache.match(url).then((cached) => {
      if (cached) {
        touchAudioMeta(url);
        const ranged = serveRange(cached, request);
        return ranged || cached;
      }
      const range = request.headers.get('range');
      const m = range && String(range).trim().match(/^bytes=(\d*)-(\d*)$/);
      const fromZero = !m || (m[1] !== '' && parseInt(m[1], 10) === 0);
      const load = startAudioLoad(url);
      if (fromZero && !load.mediaClaimed) {
        /* 首播：不等整包，直接流式转发（mediaResponse 只能交给一个媒体元素） */
        load.mediaClaimed = true;
        return load.ready.then(() =>
          load.mediaResponse || new Response('', { status: 504, statusText: 'Upstream failed' })
        );
      }
      /* 中段 Range 或第二次并发请求：等整包入缓存后本地切片 */
      return waitCacheSlice(load, cache, url, request);
    })
  );
}

// 策略 2: network-first（页面）
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

// 策略 3: stale-while-revalidate（静态资源、data.json）
// 离线且无缓存时返回 503 占位响应，避免 respondWith(undefined) 抛错。
function staleWhileRevalidate(cacheName, request) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => {
      const networkPromise = fetch(request).then((resp) => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          cache.put(request, copy).catch(() => {});
        }
        return resp;
      }).catch(() => cached || null);
      return cached || networkPromise || new Response('', { status: 503, statusText: 'Offline' });
    })
  );
}

/* ---------- 生命周期事件 ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(PAGE_CACHE).then((cache) => cache.addAll(SHELL_ASSETS.page).catch(() => {})),
      caches.open(STATIC_CACHE).then((cache) => cache.addAll(SHELL_ASSETS.static).catch(() => {}))
    ]).then(() => self.skipWaiting())
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

let prefetchStopFlag = false;

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  const data = event.data || {};

  // 中止当前预取轮次（页面点击"暂停"时发出）
  if (data.type === 'PREFETCH_STOP') {
    prefetchStopFlag = true;
    return;
  }

  // 串行预下载音频（120ms 间隔留给网络栈与渲染；PREFETCH_STOP 可中止；
  // 下载走 startAudioLoad 单飞：媒体元素若正在听同一章则复用同一次下载，不抢带宽）
  if (data.type === 'PREFETCH_AUDIO') {
    const urls = data.urls || [];
    const runId = data.runId || 0;
    prefetchStopFlag = false;
    event.waitUntil(
      caches.open(AUDIO_CACHE).then((cache) => (async () => {
        for (const url of urls) {
          if (prefetchStopFlag) break;
          try {
            const hit = await cache.match(url).catch(() => null);
            if (hit) continue; // 已缓存，跳过
            const load = startAudioLoad(url);
            await load.ready;
          } catch (_) {
            /* 单章失败不阻塞队列；断网时由 online 事件重发 */
          }
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        // 缓存完成后执行淘汰
        await evictAudioIfNeeded();
        // 通知所有客户端（带回 runId，页面据此忽略过期轮次）
        self.clients.matchAll().then((clients) => {
          clients.forEach((c) => c.postMessage({ type: 'PREFETCH_DONE', urls, runId }));
        });
      })())
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

  // 1. 音频：cache-first + LRU + 边下边播（URL 带 ?v=hash，文件更新后自动换新条目）
  if (isAudioRequest(path)) {
    event.respondWith(respondAudio(req).catch(() => new Response('', { status: 503, statusText: 'Offline' })));
    return;
  }

  // 2. 字体：cache-first 长期缓存
  if (isFontRequest(path)) {
    event.respondWith(cacheFirst(FONT_CACHE, req));
    return;
  }

  // 3. 章节数据 data.json：stale-while-revalidate
  if (/data\.json$/.test(path)) {
    event.respondWith(staleWhileRevalidate(PAGE_CACHE, req));
    return;
  }

  // 4. 页面：network-first
  if (isPageRequest(path)) {
    event.respondWith(networkFirst(PAGE_CACHE, req));
    return;
  }

  // 5. 静态资源（CSS/JS/图片）：stale-while-revalidate
  if (isStaticRequest(path)) {
    event.respondWith(staleWhileRevalidate(STATIC_CACHE, req));
    return;
  }

  // 6. 其他请求：stale-while-revalidate 兜底
  event.respondWith(staleWhileRevalidate(STATIC_CACHE, req));
});
