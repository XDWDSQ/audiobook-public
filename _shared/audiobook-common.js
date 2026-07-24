/* audiobook-common.js
 * 有声书播放器共用脚本(纯逻辑,不依赖样式)
 * 暴露在 window.ABCommon 上,所有页面可直接使用
 */
(function (global) {
  'use strict';

  function fmtTime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h) return h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
    return m + ':' + String(r).padStart(2, '0');
  }

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

  function updateMediaSession(audio, chapter, opts) {
    if (!('mediaSession' in navigator) || !audio || !chapter) return;
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
      if (typeof opts.onPrev === 'function') safe(() => navigator.mediaSession.setActionHandler('previoustrack', opts.onPrev));
      if (typeof opts.onNext === 'function') safe(() => navigator.mediaSession.setActionHandler('nexttrack', opts.onNext));
    } catch (_) {}
  }

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
    try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
  }

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
  function showToast(message, host, variant) {
    const el = host || ensureToast();
    if (!el) return;
    el.textContent = String(message);
    el.classList.remove('ab-toast--success', 'ab-toast--error');
    if (variant) el.classList.add('ab-toast--' + variant);
    el.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.classList.remove('show'), 2200);
  }

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
    el.textContent = '';
    window.setTimeout(() => { el.textContent = String(message || ''); }, 30);
  }

  /* ===== 焦点陷阱 ===== */
  let _trapContainer = null;
  let _trapTrigger = null;
  let _trapHandler = null;

  function trapFocus(container, trigger) {
    if (!container) return;
    releaseFocus();
    _trapContainer = container;
    _trapTrigger = trigger || document.activeElement;
    _trapHandler = function (e) {
      if (e.key !== 'Tab') return;
      const focusable = _trapContainer.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', _trapHandler, true);
    // 聚焦容器内第一个可交互元素
    const first = container.querySelector('a[href], button:not([disabled]), input:not([disabled])');
    if (first) window.setTimeout(() => first.focus(), 60);
  }

  function releaseFocus() {
    if (_trapHandler) {
      document.removeEventListener('keydown', _trapHandler, true);
      _trapHandler = null;
    }
    if (_trapTrigger && _trapTrigger.focus) {
      _trapTrigger.focus();
    }
    _trapContainer = null;
    _trapTrigger = null;
  }

  /* ===== 章节切换过渡 ===== */
  function crossFade(el, renderFn) {
    if (!el || typeof renderFn !== 'function') { if (renderFn) renderFn(); return; }
    const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (RM) { renderFn(); return; }
    el.classList.add('ab-switching');
    // 等待退场过渡完成（180ms）再执行渲染
    window.setTimeout(() => {
      renderFn();
      el.classList.remove('ab-switching');
      el.classList.add('ab-switch-enter');
      const onEnd = () => { el.classList.remove('ab-switch-enter'); el.removeEventListener('animationend', onEnd); };
      el.addEventListener('animationend', onEnd);
      // 兆底：若 animationend 未触发，400ms 后强制清除
      window.setTimeout(() => el.classList.remove('ab-switch-enter'), 400);
    }, 190);
  }

  /* ===== 空状态 / 错误状态 HTML 生成 ===== */
  function emptyHTML(text, actionLabel, actionId) {
    let html = '<div class="ab-empty"><span class="ab-empty__icon" aria-hidden="true">\uD83D\uDD0D</span><span class="ab-empty__text">' + text + '</span>';
    if (actionLabel) html += '<button class="ab-empty__action" id="' + (actionId || '') + '" type="button">' + actionLabel + '</button>';
    html += '</div>';
    return html;
  }
  function errorHTML(msg, retryId) {
    return '<div class="ab-error" role="alert"><span class="ab-error__icon" aria-hidden="true">\u26A0\uFE0F</span><span class="ab-error__msg">' + msg + '</span><button class="ab-error__retry" id="' + (retryId || '') + '" type="button">\u91CD\u8BD5</button></div>';
  }

  global.ABCommon = {
    fmtTime,
    findActiveSeg,
    parseHashChapter,
    applyHashRoute,
    updateHash,
    updateMediaSession,
    readJSON,
    saveThrottled,
    showToast,
    announce,
    trapFocus,
    releaseFocus,
    crossFade,
    emptyHTML,
    errorHTML
  };
})(window);
