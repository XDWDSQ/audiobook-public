/* audiobook-common.js
 * 有声书播放器共用脚本(纯逻辑,不依赖样式)
 * 暴露在 window.ABCommon 上,所有页面可直接使用
 *
 * API:
 *   ABCommon.fmtTime(seconds)         -> "1:23" / "1:02:03"
 *   ABCommon.findActiveSeg(segs, t)   -> 段落索引(0-based) / -1
 *   ABCommon.parseHashChapter(hash)   -> 章节号(1-based) / null
 *   ABCommon.applyHashRoute(chapters, onMatch)
 *   ABCommon.updateHash(index)        -> "#chapter=N"
 *   ABCommon.updateMediaSession(audio, chapter, opts)
 *   ABCommon.saveThrottled(key, val, intervalMs, store)
 *   ABCommon.readJSON(key, fallback)
 *   ABCommon.showToast(message, host?)
 *   ABCommon.announce(message, host?)
 */
(function (global) {
  'use strict';

  /* ---------- 时间格式化 ---------- */
  function fmtTime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h) return h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
    return m + ':' + String(r).padStart(2, '0');
  }

  /* ---------- 二分查找当前段落 ---------- */
  function findActiveSeg(segs, currentTime) {
    if (!segs || !segs.length) return -1;
    let lo = 0, hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (segs[mid].s <= currentTime) {
        if (mid === segs.length - 1 || segs[mid + 1].s > currentTime) return mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return -1;
  }

  /* ---------- URL hash 路由 ---------- */
  function parseHashChapter(hash) {
    const m = String(hash || '').match(/#chapter=(\d+)/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isInteger(n) && n >= 1 ? n : null;
  }
  function applyHashRoute(chapters, onMatch) {
    if (!Array.isArray(chapters) || typeof onMatch !== 'function') return;
    const n = parseHashChapter(location.hash);
    if (n == null) return;
    const idx = Math.min(Math.max(n - 1, 0), chapters.length - 1);
    onMatch(idx);
  }
  function updateHash(index) {
    if (!Number.isInteger(index) || index < 0) return;
    try { history.replaceState(null, '', '#chapter=' + (index + 1)); } catch (_) {}
  }

  /* ---------- Media Session API ---------- */
  function updateMediaSession(audio, chapter, opts) {
    if (!('mediaSession' in navigator)) return;
    if (!audio || !chapter) return;
    opts = opts || {};
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chapter.title || '',
        artist: opts.artist || '有声书馆',
        album: opts.album || '有声书馆'
      });
      const safe = (fn) => { try { fn(); } catch (_) {} };
      const seek = (delta) => {
        if (!audio.duration) return;
        audio.currentTime = Math.max(0, Math.min(audio.duration, (audio.currentTime || 0) + delta));
      };
      safe(() => navigator.mediaSession.setActionHandler('play', () => audio.play()));
      safe(() => navigator.mediaSession.setActionHandler('pause', () => audio.pause()));
      safe(() => navigator.mediaSession.setActionHandler('seekbackward', () => seek(-15)));
      safe(() => navigator.mediaSession.setActionHandler('seekforward', () => seek(15)));
      if (typeof opts.onPrev === 'function') {
        safe(() => navigator.mediaSession.setActionHandler('previoustrack', () => opts.onPrev()));
      }
      if (typeof opts.onNext === 'function') {
        safe(() => navigator.mediaSession.setActionHandler('nexttrack', () => opts.onNext()));
      }
    } catch (_) {}
  }

  /* ---------- 节流 localStorage ---------- */
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      const v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (_) { return fallback; }
  }
  function saveThrottled(key, value, intervalMs, store) {
    store = store || readJSON.__store || (readJSON.__store = {});
    const now = Date.now();
    const last = store[key] || 0;
    if (now - last < intervalMs) return false;
    store[key] = now;
    try { localStorage.setItem(key, value); return true; }
    catch (_) { return false; }
  }

  /* ---------- Toast ---------- */
  let toastTimer = 0;
  function ensureToast() {
    let el = document.getElementById('ab-toast-host');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ab-toast-host';
    el.className = 'ab-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    return el;
  }
  function showToast(message, host) {
    const el = host || ensureToast();
    if (!el) return;
    el.textContent = String(message);
    el.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.classList.remove('show'), 2200);
  }

  /* ---------- Aria-live status (screen reader) ---------- */
  function ensureSrStatus() {
    let el = document.getElementById('ab-sr-status');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ab-sr-status';
    el.className = 'ab-sr-status';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    document.body.appendChild(el);
    return el;
  }
  function announce(message) {
    const el = ensureSrStatus();
    if (!el) return;
    // 先清空再写,让屏幕阅读器重新播报
    el.textContent = '';
    window.setTimeout(() => { el.textContent = String(message || ''); }, 30);
  }

  /* ---------- 暴露 API ---------- */
  global.ABCommon = {
    fmtTime: fmtTime,
    findActiveSeg: findActiveSeg,
    parseHashChapter: parseHashChapter,
    applyHashRoute: applyHashRoute,
    updateHash: updateHash,
    updateMediaSession: updateMediaSession,
    readJSON: readJSON,
    saveThrottled: saveThrottled,
    showToast: showToast,
    announce: announce
  };
})(window);