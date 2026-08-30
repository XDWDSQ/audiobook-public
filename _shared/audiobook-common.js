/* audiobook-common.js
 * 有声书播放器共用脚本(纯逻辑,不依赖样式)
 * 暴露在 window.ABCommon 上,所有页面可直接使用
 *
 * API:
 *   ABCommon.fmtTime(seconds)               -> "1:23" / "1:02:03"
 *   ABCommon.SPEED_STEPS                    -> 倍速 8 档 [0.5..2.5]
 *   ABCommon.normalizeChapters(data)        -> data.json → v2 章节数组（v1 兜底映射）
 *   ABCommon.audioSrc(chapter)              -> 带 ?v=hash 的音频 URL
 *   ABCommon.audioUrls(chapters)            -> 全部章节绝对音频 URL（预取用）
 *   ABCommon.findActiveSeg(segs, t)         -> 段落索引(0-based) / -1
 *   ABCommon.parseHashChapter(hash)         -> 章节号(1-based) / null
 *   ABCommon.applyHashRoute(chapters, fn)   -> 匹配 hash 中的章节并回调
 *   ABCommon.updateHash(index)              -> 更新 URL hash 为 #chapter=N
 *   ABCommon.updateMediaSession(audio, ch, opts)
 *   ABCommon.updateMediaSessionPosition(audio) -> 同步锁屏进度（timeupdate 调）
 *   ABCommon.readJSON(key, fallback)        -> 从 localStorage 读取 JSON
 *   ABCommon.saveThrottled(key, val, ms, store)  -> 节流写入 localStorage
 *   ABCommon.showToast(msg, host?, variant?)  -> 显示 Toast (variant: success/error)
 *   ABCommon.announce(message)              -> 屏幕阅读器播报
 *   ABCommon.trapFocus(container, trigger?) -> 焦点陷阱 (模态框用)
 *   ABCommon.releaseFocus()                 -> 释放焦点陷阱
 *   ABCommon.crossFade(el, renderFn)        -> 章节切换淡入淡出过渡
 *   ABCommon.emptyHTML(text, actionLabel?, actionId?) -> 空状态 HTML 字符串
 *   ABCommon.errorHTML(msg, retryId?)       -> 错误状态 HTML 字符串
 *
 *   === 播放进度持久化 ===
 *   ABCommon.saveProgress(bookId, data)     -> 保存播放进度（节流）
 *   ABCommon.loadProgress(bookId)           -> 读取播放进度（含旧键一次性迁移）
 *   ABCommon.clearProgress(bookId)          -> 清除播放进度
 *   ABCommon.showResumePrompt(progress, opts) -> 显示"继续播放"提示
 *
 *   === 缓冲进度 ===
 *   ABCommon.initBufferProgress(audio, bufferEl) -> 初始化缓冲进度显示
 *
 *   === 虚拟滚动 ===
 *   ABCommon.createVirtualList(container, items, options) -> 创建虚拟滚动列表
 *
 *   === 键盘快捷键 ===
 *   ABCommon.initKeyboardShortcuts(audio, options) -> 初始化键盘快捷键
 *   ABCommon.showShortcutsHelp(shortcuts?)   -> 显示快捷键帮助面板
 *
 *   === 睡眠定时器（淡出效果）===
 *   ABCommon.createSleepTimer(audio, opts)   -> 创建带淡出的睡眠定时器
 *      cycle 数组支持 'chapter'（播完本章暂停）
 *
 *   === PWA 安装 ===
 *   ABCommon.initPWAInstall(buttonEl, opts)  -> 初始化 PWA 安装按钮
 *
 *   === SW 注册 / 消息 ===
 *   ABCommon.registerServiceWorker(swPath, opts) -> 注册 SW，更新后自动接管
 *   ABCommon.sendToServiceWorker(message)    -> 给激活中的 SW 发消息
 *
 *   === 主题 / 阅读字号（book id 参数化）===
 *   ABCommon.initTheme(opts)                 -> 初始化主题切换
 *   ABCommon.initReadingSize(opts)           -> 初始化阅读字号切换
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

  /* ---------- 倍速档位（页面按钮与键盘快捷键共用） ---------- */
  const SPEED_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];

  /* ---------- 段文本净化（历史数据兜底） ---------- */
  /**
   * 剥离旧管线遗留的段文本污染：BOM 与 Markdown 标题标记（"# 书名 ## 第1章"）。
   * data.json 已由 scripts/migrate_data_v2.py --clean-markers 落盘清洗；
   * 此处兜底 SW 里可能仍缓存的旧数据，保证阅读区不再显示标记符号。
   * @param {string} t - 原始段文本
   * @returns {string} 净化后的文本
   */
  function cleanSegText(t) {
    if (typeof t !== 'string') return t;
    if (t.indexOf('#') === -1 && t.indexOf('\uFEFF') === -1) return t;
    return t.replace(/\uFEFF/g, '').replace(/#{1,6}\s*/g, '');
  }

  /* ---------- 章节数据归一化（v2 单一格式，v1 字段兜底映射） ---------- */
  /**
   * 将 data.json 原始数据归一化为播放器内部使用的章节数组（v2 字段）。
   * 兼容 v1 扁平数组与 v2 { version, book, chapters }；章节对象若只有
   * v1 字段（num/file/dur/segs）也会映射为 v2 字段，避免旧缓存数据崩溃。
   * @param {*} data - fetch 到的原始数据
   * @returns {Array<Object>} 章节数组（id/title/duration/audio/hash/segments）
   */
  function normalizeChapters(data) {
    if (data && typeof data === 'object' && Array.isArray(data.chapters)) {
      data = data.chapters;
    }
    if (!Array.isArray(data)) return [];
    return data.map(function (ch) {
      if (!ch || typeof ch !== 'object') return ch;
      var segs = Array.isArray(ch.segments) ? ch.segments : (Array.isArray(ch.segs) ? ch.segs : []);
      if (segs.length) {
        segs = segs.map(function (s) {
          if (s && typeof s === 'object' && typeof s.t === 'string') {
            var cleaned = cleanSegText(s.t);
            if (cleaned !== s.t) return Object.assign({}, s, { t: cleaned });
          }
          return s;
        });
      }
      return {
        id: ch.id != null ? ch.id : (ch.num != null ? 'ch' + String(ch.num).padStart(3, '0') : ''),
        title: ch.title || '',
        duration: ch.duration != null ? ch.duration : (ch.dur != null ? ch.dur : 0),
        audio: ch.audio || ch.file || '',
        hash: ch.hash || '',
        segments: segs
      };
    });
  }

  /**
   * 生成带缓存版本参数的音频 URL（?v=hash 绕过 SW cache-first 永不失效）。
   * @param {Object} chapter - 章节对象
   * @returns {string} 相对 URL（如 chapters/ch001.mp3?v=abc…）
   */
  function audioSrc(chapter) {
    if (!chapter) return '';
    const base = chapter.audio || chapter.file || '';
    return chapter.hash ? base + '?v=' + chapter.hash : base;
  }

  /**
   * 生成全部章节的绝对音频 URL（预取走 SW 消息通道时使用）。
   * @param {Array<Object>} chapters - 章节数组
   * @returns {Array<string>} 绝对 URL 列表
   */
  function audioUrls(chapters) {
    const base = location.href.replace(/[^/]*$/, '');
    return chapters.map(function (ch) { return new URL(audioSrc(ch), base).href; });
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
      const seekTo = (time) => {
        if (!audio.duration || !Number.isFinite(time)) return;
        audio.currentTime = Math.max(0, Math.min(audio.duration, time));
      };
      safe(() => navigator.mediaSession.setActionHandler('play', () => { const p = audio.play(); if (p && p.catch) p.catch(function () {}); }));
      safe(() => navigator.mediaSession.setActionHandler('pause', () => audio.pause()));
      safe(() => navigator.mediaSession.setActionHandler('seekbackward', () => seek(-15)));
      safe(() => navigator.mediaSession.setActionHandler('seekforward', () => seek(15)));
      safe(() => navigator.mediaSession.setActionHandler('seekto', (d) => { if (d && d.seekTime != null) seekTo(d.seekTime); }));
      if (typeof opts.onPrev === 'function') safe(() => navigator.mediaSession.setActionHandler('previoustrack', opts.onPrev));
      if (typeof opts.onNext === 'function') safe(() => navigator.mediaSession.setActionHandler('nexttrack', opts.onNext));
      updateMediaSessionPosition(audio);
    } catch (_) {}
  }

  /**
   * 同步锁屏/系统媒体的播放位置与速率（timeupdate 中调用）。
   * @param {HTMLAudioElement} audio - 音频元素
   */
  function updateMediaSessionPosition(audio) {
    if (!audio || !('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
    try {
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
      const pos = Number.isFinite(audio.currentTime) ? Math.max(0, Math.min(audio.currentTime, dur || Infinity)) : 0;
      navigator.mediaSession.setPositionState({
        duration: dur,
        playbackRate: audio.playbackRate || 1,
        position: pos
      });
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
    try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
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
    el.textContent = '';
    window.setTimeout(() => { el.textContent = String(message || ''); }, 30);
  }

  /* ---------- 焦点陷阱 ---------- */
  let _trapContainer = null;
  let _trapTrigger = null;
  let _trapHandler = null;

  /**
   * 在指定容器内锁定焦点循环（用于模态框/侧边栏）
   * @param {HTMLElement} container - 要锁定焦点的容器
   * @param {HTMLElement} [trigger] - 关闭后焦点返回的元素，默认为当前活动元素
   */
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

  /* ---------- 章节切换过渡 ---------- */
  /**
   * 内容切换淡入淡出过渡。先淡出 → 渲染内容 → 淡入。
   * @param {HTMLElement} el - 要过渡的元素
   * @param {Function} renderFn - 内容渲染函数，在淡出后执行
   */
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
      // 兜底：若 animationend 未触发，400ms 后强制清除
      window.setTimeout(() => el.classList.remove('ab-switch-enter'), 400);
    }, 190);
  }

  /* ---------- 空状态 / 错误状态 HTML 生成 ---------- */
  // 动态文本（错误信息/搜索词等）拼入 innerHTML 前必须转义，等价于 textContent 硬规则
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function emptyHTML(text, actionLabel, actionId) {
    let html = '<div class="ab-empty"><span class="ab-empty__icon" aria-hidden="true">\uD83D\uDD0D</span><span class="ab-empty__text">' + escapeHTML(text) + '</span>';
    if (actionLabel) html += '<button class="ab-empty__action" id="' + (actionId || '') + '" type="button">' + escapeHTML(actionLabel) + '</button>';
    html += '</div>';
    return html;
  }
  function errorHTML(msg, retryId) {
    return '<div class="ab-error" role="alert"><span class="ab-error__icon" aria-hidden="true">\u26A0\uFE0F</span><span class="ab-error__msg">' + escapeHTML(msg) + '</span><button class="ab-error__retry" id="' + (retryId || '') + '" type="button">\u91CD\u8BD5</button></div>';
  }

  /* ================================================================
   * 播放进度持久化
   * ================================================================ */

  const PROGRESS_KEY_PREFIX = 'audiobook-progress-';
  const PROGRESS_THROTTLE_MS = 5000; // 每 5 秒保存一次
  const _progressStore = {}; // 节流存储

  // 旧版双键进度格式（单一进度源迁移前各页面自行维护），迁移后删除
  const LEGACY_PROGRESS_KEYS = {
    zhixiao: { chapter: 'zhixiao_chapter', time: 'zhixiao_time', times: null },
    nanian: { chapter: 'nagao_chapter', time: null, times: 'nagao_times' }
  };

  /**
   * 保存播放进度（节流）
   * @param {string} bookId - 书籍 ID
   * @param {Object} data - 进度数据 { chapterId, currentTime, volume, playbackRate, timestamp }
   */
  function saveProgress(bookId, data) {
    if (!bookId) return false;
    const key = PROGRESS_KEY_PREFIX + bookId;
    const payload = JSON.stringify(Object.assign({ timestamp: Date.now() }, data || {}));
    return saveThrottled(key, payload, PROGRESS_THROTTLE_MS, _progressStore);
  }

  /**
   * 读取播放进度；统一键缺失时尝试一次性迁移旧双键格式并删除旧键。
   * @param {string} bookId - 书籍 ID
   * @returns {Object|null} 进度数据或 null
   */
  function loadProgress(bookId) {
    if (!bookId) return null;
    const key = PROGRESS_KEY_PREFIX + bookId;
    const existing = readJSON(key, null);
    if (existing) return existing;

    // 一次性旧键迁移（zhixiao: chapter+time；nanian: chapter+times 映射）
    const legacy = LEGACY_PROGRESS_KEYS[bookId];
    if (!legacy) return null;
    try {
      const chRaw = localStorage.getItem(legacy.chapter);
      if (chRaw == null) return null;
      const chapterId = parseInt(chRaw, 10);
      if (!Number.isInteger(chapterId) || chapterId < 0) return null;
      let currentTime = 0;
      if (legacy.time) {
        currentTime = parseFloat(localStorage.getItem(legacy.time) || '0') || 0;
      } else if (legacy.times) {
        const times = readJSON(legacy.times, {});
        currentTime = Number(times[chapterId] || 0) || 0;
      }
      const progress = { chapterId: chapterId, currentTime: currentTime, timestamp: Date.now() };
      try { localStorage.setItem(key, JSON.stringify(progress)); } catch (_) {}
      localStorage.removeItem(legacy.chapter);
      if (legacy.time) localStorage.removeItem(legacy.time);
      if (legacy.times) localStorage.removeItem(legacy.times);
      return progress;
    } catch (_) { return null; }
  }

  /**
   * 清除播放进度
   * @param {string} bookId - 书籍 ID
   */
  function clearProgress(bookId) {
    if (!bookId) return;
    const key = PROGRESS_KEY_PREFIX + bookId;
    try { localStorage.removeItem(key); } catch (_) {}
    delete _progressStore[key];
  }

  /**
   * 显示"继续播放"提示
   * @param {Object} progress - 进度数据
   * @param {Object} opts - 配置选项
   * @param {string} opts.chapterTitle - 章节标题
   * @param {Function} opts.onConfirm - 确认回调
   * @param {Function} [opts.onCancel] - 取消回调
   * @param {number} [opts.autoDismiss=8000] - 自动消失时间（ms），0 为不自动消失
   */
  function showResumePrompt(progress, opts) {
    opts = opts || {};
    if (!progress || typeof opts.onConfirm !== 'function') return;

    // 移除已有的提示
    const existing = document.getElementById('ab-resume-prompt');
    if (existing) existing.remove();

    const prompt = document.createElement('div');
    prompt.id = 'ab-resume-prompt';
    prompt.className = 'ab-resume-prompt';
    prompt.setAttribute('role', 'dialog');
    prompt.setAttribute('aria-labelledby', 'ab-resume-title');
    prompt.setAttribute('aria-describedby', 'ab-resume-desc');

    const chTitle = opts.chapterTitle || ('第 ' + (Number(progress.chapterId) + 1) + ' 章');
    const timeStr = fmtTime(progress.currentTime || 0);

    prompt.innerHTML =
      '<div class="ab-resume-prompt__content">' +
        '<div class="ab-resume-prompt__icon" aria-hidden="true">▶</div>' +
        '<div class="ab-resume-prompt__body">' +
          '<div class="ab-resume-prompt__title" id="ab-resume-title">继续播放</div>' +
          '<div class="ab-resume-prompt__desc" id="ab-resume-desc"></div>' +
        '</div>' +
        '<div class="ab-resume-prompt__actions">' +
          '<button class="ab-resume-prompt__btn ab-resume-prompt__btn--primary" id="ab-resume-confirm" type="button">继续</button>' +
          '<button class="ab-resume-prompt__btn" id="ab-resume-cancel" type="button">从头开始</button>' +
        '</div>' +
      '</div>';
    // 章节标题属内容文本：textContent 渲染（硬规则，禁拼入 innerHTML）
    prompt.querySelector('#ab-resume-desc').textContent = chTitle + ' · ' + timeStr;

    document.body.appendChild(prompt);

    // 动画入场
    requestAnimationFrame(() => {
      requestAnimationFrame(() => prompt.classList.add('show'));
    });

    const confirmBtn = prompt.querySelector('#ab-resume-confirm');
    const cancelBtn = prompt.querySelector('#ab-resume-cancel');

    let dismissTimer = null;
    let closed = false;

    function close() {
      if (closed) return;
      closed = true;
      if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
      releaseFocus();
      prompt.classList.remove('show');
      setTimeout(() => { if (prompt.parentNode) prompt.parentNode.removeChild(prompt); }, 300);
    }

    confirmBtn.addEventListener('click', () => {
      close();
      opts.onConfirm(progress);
    });
    cancelBtn.addEventListener('click', () => {
      close();
      if (typeof opts.onCancel === 'function') opts.onCancel();
    });
    // Esc 关闭（视为取消，不触发回调）
    prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        if (typeof opts.onCancel === 'function') opts.onCancel();
      }
    });

    // 自动消失
    const autoDismiss = typeof opts.autoDismiss === 'number' ? opts.autoDismiss : 8000;
    if (autoDismiss > 0) {
      dismissTimer = setTimeout(close, autoDismiss);
    }

    // 焦点管理
    trapFocus(prompt, document.activeElement);

    // 屏幕阅读器播报
    announce('检测到上次播放进度：' + chTitle + '，' + timeStr + '，按回车继续播放');

    return { close: close };
  }

  /* ================================================================
   * 缓冲进度显示
   * ================================================================ */

  /**
   * 初始化缓冲进度显示
   * @param {HTMLAudioElement} audio - 音频元素
   * @param {HTMLElement} bufferEl - 缓冲进度条元素
   * @returns {Object} { destroy } 销毁函数
   */
  function initBufferProgress(audio, bufferEl) {
    if (!audio || !bufferEl) return { destroy: function () {} };

    function updateBuffer() {
      if (!audio.duration || !audio.buffered || !audio.buffered.length) {
        bufferEl.style.width = '0%';
        return;
      }
      // 取最后一个缓冲范围的结束位置（通常就是当前已缓冲的最远点）
      const bufferedEnd = audio.buffered.end(audio.buffered.length - 1);
      const ratio = Math.min(1, bufferedEnd / audio.duration);
      bufferEl.style.width = (ratio * 100) + '%';
    }

    audio.addEventListener('progress', updateBuffer);
    audio.addEventListener('loadedmetadata', updateBuffer);
    audio.addEventListener('canplay', updateBuffer);

    return {
      destroy: function () {
        audio.removeEventListener('progress', updateBuffer);
        audio.removeEventListener('loadedmetadata', updateBuffer);
        audio.removeEventListener('canplay', updateBuffer);
      }
    };
  }

  /* ================================================================
   * 虚拟滚动
   * ================================================================ */

  /**
   * 创建虚拟滚动列表
   * @param {HTMLElement} container - 滚动容器
   * @param {Array} items - 数据项数组
   * @param {Object} options - 配置选项
   * @param {number} [options.itemHeight=44] - 每项高度（px）
   * @param {number} [options.buffer=5] - 上下缓冲区项数
   * @param {Function} options.renderItem - 渲染函数 (item, index) => HTMLElement
   * @param {Function} [options.onItemClick] - 点击回调 (item, index)
   * @param {number} [options.activeIndex=-1] - 当前激活项索引
   * @param {boolean} [options.autoEnable=true] - 章节数 > 阈值时自动启用
   * @param {number} [options.threshold=50] - 启用虚拟滚动的最小项数
   * @returns {Object} 虚拟列表实例
   */
  function createVirtualList(container, items, options) {
    options = options || {};
    const itemHeight = options.itemHeight || 44;
    const bufferCount = options.buffer != null ? options.buffer : 5;
    const renderItem = options.renderItem;
    const threshold = options.threshold != null ? options.threshold : 50;
    const autoEnable = options.autoEnable !== false;

    // 项数不足时，退化为普通列表
    const shouldVirtualize = autoEnable && items.length > threshold;

    if (!shouldVirtualize) {
      // 普通渲染
      const frag = document.createDocumentFragment();
      items.forEach((item, i) => {
        const el = renderItem ? renderItem(item, i) : document.createElement('div');
        if (el && options.onItemClick) {
          el.addEventListener('click', () => options.onItemClick(item, i));
        }
        if (el) frag.appendChild(el);
      });
      container.innerHTML = '';
      container.appendChild(frag);
      return {
        updateActive: function () {},
        scrollToIndex: function (idx) {
          const el = container.children[idx];
          if (el) el.scrollIntoView({ block: 'nearest' });
        },
        refresh: function () {},
        destroy: function () { container.innerHTML = ''; }
      };
    }

    // 虚拟滚动实现
    let scrollTop = 0;
    let activeIndex = options.activeIndex != null ? options.activeIndex : -1;
    let currentItems = items.slice();
    let rafId = null;

    // 设置容器为可滚动
    container.style.position = 'relative';
    container.style.overflowY = 'auto';

    // 创建滚动撑开元素（设置总高度）
    const spacer = document.createElement('div');
    spacer.className = 'ab-virtual-spacer';
    spacer.style.height = (items.length * itemHeight) + 'px';
    spacer.style.position = 'relative';
    spacer.style.pointerEvents = 'none';

    // 创建可见内容容器
    const content = document.createElement('div');
    content.className = 'ab-virtual-content';
    content.style.position = 'absolute';
    content.style.top = '0';
    content.style.left = '0';
    content.style.right = '0';
    content.style.willChange = 'transform';
    content.style.pointerEvents = 'auto';

    container.innerHTML = '';
    container.appendChild(spacer);
    spacer.appendChild(content);

    function getVisibleRange() {
      const viewportHeight = container.clientHeight;
      const startIdx = Math.max(0, Math.floor(scrollTop / itemHeight) - bufferCount);
      const endIdx = Math.min(
        currentItems.length - 1,
        Math.ceil((scrollTop + viewportHeight) / itemHeight) + bufferCount
      );
      return { startIdx: startIdx, endIdx: endIdx };
    }

    function render() {
      const { startIdx, endIdx } = getVisibleRange();
      const frag = document.createDocumentFragment();

      for (let i = startIdx; i <= endIdx; i++) {
        const item = currentItems[i];
        if (!item) continue;
        const el = renderItem ? renderItem(item, i) : document.createElement('div');
        if (!el) continue;
        el.style.position = 'absolute';
        el.style.top = (i * itemHeight) + 'px';
        el.style.left = '0';
        el.style.right = '0';
        el.style.height = itemHeight + 'px';
        el.dataset.index = i;
        if (options.onItemClick) {
          el.addEventListener('click', () => options.onItemClick(item, i));
          // 键盘激活（Enter/Space），与非虚拟目录行为一致；
          // preventDefault 阻止 Space 冒泡到全局快捷键触发播放/暂停
          el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
              e.preventDefault();
              options.onItemClick(item, i);
            }
          });
        }
        frag.appendChild(el);
      }

      content.innerHTML = '';
      content.appendChild(frag);
    }

    function onScroll() {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        scrollTop = container.scrollTop;
        render();
      });
    }

    container.addEventListener('scroll', onScroll, { passive: true });

    // 初始渲染
    render();

    return {
      /**
       * 更新激活项高亮（外部调用，根据当前索引更新样式）
       * 注意：实际高亮由 renderItem 函数内部处理，这里只提供滚动到激活项的能力
       */
      updateActive: function (idx) {
        activeIndex = idx;
      },
      /**
       * 滚动到指定索引
       */
      scrollToIndex: function (idx) {
        if (idx < 0 || idx >= currentItems.length) return;
        const targetTop = idx * itemHeight;
        const viewportHeight = container.clientHeight;
        // 如果不在可视区域内则滚动
        if (targetTop < scrollTop || targetTop + itemHeight > scrollTop + viewportHeight) {
          container.scrollTop = Math.max(0, targetTop - viewportHeight / 2 + itemHeight / 2);
        }
      },
      /**
       * 刷新列表（数据变化后调用）
       * @param {Array} [newItems] - 新的数据项，不传则使用原数据
       */
      refresh: function (newItems) {
        if (Array.isArray(newItems)) currentItems = newItems;
        spacer.style.height = (currentItems.length * itemHeight) + 'px';
        render();
      },
      /**
       * 销毁虚拟列表
       */
      destroy: function () {
        container.removeEventListener('scroll', onScroll);
        if (rafId) cancelAnimationFrame(rafId);
        container.innerHTML = '';
      }
    };
  }

  /* ================================================================
   * 键盘快捷键
   * ================================================================ */

  // 默认快捷键配置
  const DEFAULT_SHORTCUTS = [
    { key: 'Space', label: '播放 / 暂停', description: '播放或暂停当前音频' },
    { key: '← / →', label: '后退 / 前进 5 秒', description: '快退或快进 5 秒' },
    { key: 'J / K', label: '后退 / 前进 10 秒', description: '快退或快进 10 秒' },
    { key: '↑ / ↓', label: '音量加 / 减', description: '调节音量（每次 10%）' },
    { key: 'M', label: '静音切换', description: '切换静音状态' },
    { key: 'N / P', label: '下一章 / 上一章', description: '切换到下一章节或上一章节' },
    { key: '[ / ]', label: '播放速率减 / 加', description: '调节播放速度（0.5x - 2.5x）' },
    { key: 'T', label: '定时关闭', description: '循环切换 15/30/45/60 分钟 / 播完本章 / 关闭' },
    { key: '?', label: '显示快捷键帮助', description: '打开此帮助面板' }
  ];

  let _shortcutsHelpVisible = false;
  let _shortcutsHelpEl = null;
  let _keyboardHandlerBound = false;

  /**
   * 初始化键盘快捷键
   * @param {HTMLAudioElement} audio - 音频元素
   * @param {Object} options - 配置选项
   * @param {Function} [options.onPrevChapter] - 上一章回调
   * @param {Function} [options.onNextChapter] - 下一章回调
   * @param {Function} [options.onTogglePlay] - 播放/暂停回调
   * @param {Function} [options.onSpeedChange] - 速率变化回调 (delta)
   * @param {Function} [options.onSleepTimer] - 睡眠定时器回调
   * @param {number} [options.seekSmall=5] - 小步长（秒）
   * @param {number} [options.seekLarge=10] - 大步长（秒）
   * @param {Array} [options.extraShortcuts] - 额外快捷键显示项
   * @returns {Object} { destroy } 销毁函数
   */
  function initKeyboardShortcuts(audio, options) {
    if (!audio) return { destroy: function () {} };
    options = options || {};
    const seekSmall = options.seekSmall != null ? options.seekSmall : 5;
    const seekLarge = options.seekLarge != null ? options.seekLarge : 10;
    const skipKeys = options.skipKeys || []; // 需要跳过的按键数组
    const allShortcuts = DEFAULT_SHORTCUTS.concat(options.extraShortcuts || []);

    // 检查是否应该跳过某个按键
    function shouldSkip(key) {
      for (let i = 0; i < skipKeys.length; i++) {
        if (skipKeys[i].toLowerCase() === key.toLowerCase()) return true;
      }
      return false;
    }

    // 速率档位（与 SPEED_STEPS 一致，页面按钮共用）
    const speedSteps = SPEED_STEPS;

    function getSpeedIndex(rate) {
      let best = 2; // 默认 1.0
      let diff = Math.abs(speedSteps[best] - rate);
      for (let i = 0; i < speedSteps.length; i++) {
        const d = Math.abs(speedSteps[i] - rate);
        if (d < diff) { diff = d; best = i; }
      }
      return best;
    }

    function adjustSpeed(delta) {
      const idx = getSpeedIndex(audio.playbackRate || 1);
      const newIdx = Math.max(0, Math.min(speedSteps.length - 1, idx + delta));
      audio.playbackRate = speedSteps[newIdx];
      if (typeof options.onSpeedChange === 'function') {
        options.onSpeedChange(speedSteps[newIdx]);
      }
      showToast('播放速度：' + speedSteps[newIdx].toFixed(2).replace(/\.?0+$/, '') + 'x');
      announce('播放速度 ' + speedSteps[newIdx].toFixed(2).replace(/\.?0+$/, '') + ' 倍');
    }

    function adjustVolume(delta) {
      const newVol = Math.max(0, Math.min(1, (audio.volume || 1) + delta));
      audio.volume = newVol;
      if (newVol > 0) audio.muted = false;
      const pct = Math.round(newVol * 100);
      showToast('音量：' + pct + '%');
      announce('音量 ' + pct + ' 百分');
    }

    function seekBy(seconds) {
      if (!audio.duration) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
    }

    function togglePlay() {
      if (typeof options.onTogglePlay === 'function') {
        options.onTogglePlay();
      } else {
        if (audio.paused) audio.play().catch(function () {});
        else audio.pause();
      }
    }

    function toggleMute() {
      audio.muted = !audio.muted;
      showToast(audio.muted ? '已静音' : '已取消静音');
      announce(audio.muted ? '已静音' : '已取消静音');
    }

    function nextChapter() {
      if (typeof options.onNextChapter === 'function') options.onNextChapter();
    }
    function prevChapter() {
      if (typeof options.onPrevChapter === 'function') options.onPrevChapter();
    }

    function cycleSleepTimer() {
      if (typeof options.onSleepTimer === 'function') options.onSleepTimer();
    }

    function onKeyDown(e) {
      // 帮助面板打开时，只有 Esc 和 ? 有效
      if (_shortcutsHelpVisible) {
        if (e.key === 'Escape' || e.key === '?') {
          e.preventDefault();
          hideShortcutsHelp();
        }
        return;
      }

      // 输入框内不触发
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // 焦点在按钮上时，空格/回车属按钮原生激活，避免与全局快捷键双触发
      if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
      // 焦点在进度条（role=slider）上时方向键由滑条自身处理，全局跳过避免双倍跳转
      if (e.target.getAttribute && e.target.getAttribute('role') === 'slider' &&
          e.key.indexOf('Arrow') === 0) return;
      if (e.target.isContentEditable) return;

      // 修饰键组合跳过
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // 自定义跳过的按键
      if (shouldSkip(e.key)) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekBy(-seekSmall);
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekBy(seekSmall);
          break;
        case 'ArrowUp':
          e.preventDefault();
          adjustVolume(0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          adjustVolume(-0.1);
          break;
        case 'j': case 'J':
          e.preventDefault();
          seekBy(-seekLarge);
          break;
        case 'k': case 'K':
          e.preventDefault();
          seekBy(seekLarge);
          break;
        case 'm': case 'M':
          e.preventDefault();
          toggleMute();
          break;
        case 'n': case 'N':
          e.preventDefault();
          nextChapter();
          break;
        case 'p': case 'P':
          e.preventDefault();
          prevChapter();
          break;
        case '[':
          e.preventDefault();
          adjustSpeed(-1);
          break;
        case ']':
          e.preventDefault();
          adjustSpeed(1);
          break;
        case 't': case 'T':
          e.preventDefault();
          cycleSleepTimer();
          break;
        case '?':
          e.preventDefault();
          showShortcutsHelp(allShortcuts);
          break;
      }
    }

    document.addEventListener('keydown', onKeyDown);
    _keyboardHandlerBound = true;

    return {
      destroy: function () {
        document.removeEventListener('keydown', onKeyDown);
        _keyboardHandlerBound = false;
      }
    };
  }

  /**
   * 显示快捷键帮助面板
   * @param {Array} [shortcuts] - 快捷键列表，不传使用默认
   */
  function showShortcutsHelp(shortcuts) {
    if (_shortcutsHelpVisible) return;
    shortcuts = shortcuts || DEFAULT_SHORTCUTS;

    // 移除已有
    if (_shortcutsHelpEl) _shortcutsHelpEl.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ab-shortcuts-help';
    overlay.className = 'ab-shortcuts-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'ab-shortcuts-title');

    let itemsHTML = '';
    shortcuts.forEach(function (s) {
      itemsHTML +=
        '<div class="ab-shortcuts-item">' +
          '<div class="ab-shortcuts-keys"><kbd>' + s.key + '</kbd></div>' +
          '<div class="ab-shortcuts-info">' +
            '<div class="ab-shortcuts-label">' + s.label + '</div>' +
            (s.description ? '<div class="ab-shortcuts-desc">' + s.description + '</div>' : '') +
          '</div>' +
        '</div>';
    });

    overlay.innerHTML =
      '<div class="ab-shortcuts-modal" role="document">' +
        '<div class="ab-shortcuts-head">' +
          '<h2 class="ab-shortcuts-title" id="ab-shortcuts-title">键盘快捷键</h2>' +
          '<button class="ab-shortcuts-close" type="button" aria-label="关闭帮助">&times;</button>' +
        '</div>' +
        '<div class="ab-shortcuts-body">' + itemsHTML + '</div>' +
        '<div class="ab-shortcuts-foot">按 <kbd>Esc</kbd> 或 <kbd>?</kbd> 关闭</div>' +
      '</div>';

    document.body.appendChild(overlay);
    _shortcutsHelpEl = overlay;
    _shortcutsHelpVisible = true;

    // 入场动画
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { overlay.classList.add('show'); });
    });

    // 焦点陷阱
    trapFocus(overlay, document.activeElement);

    // 关闭按钮
    overlay.querySelector('.ab-shortcuts-close').addEventListener('click', hideShortcutsHelp);

    // 点击遮罩关闭
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) hideShortcutsHelp();
    });

    announce('快捷键帮助面板已打开');
  }

  function hideShortcutsHelp() {
    if (!_shortcutsHelpVisible || !_shortcutsHelpEl) return;
    _shortcutsHelpEl.classList.remove('show');
    releaseFocus();
    setTimeout(function () {
      if (_shortcutsHelpEl && _shortcutsHelpEl.parentNode) {
        _shortcutsHelpEl.parentNode.removeChild(_shortcutsHelpEl);
      }
      _shortcutsHelpEl = null;
      _shortcutsHelpVisible = false;
    }, 250);
    announce('快捷键帮助面板已关闭');
  }

  /* ================================================================
   * 睡眠定时器（带淡出效果）
   * ================================================================ */

  /**
   * 创建带淡出效果的睡眠定时器
   * @param {HTMLAudioElement} audio - 音频元素
   * @param {Object} options - 配置选项
   * @param {number} [options.fadeDuration=10000] - 淡出时长（ms）
   * @param {Function} [options.onTick] - 每秒回调 (remainingMs)
   * @param {Function} [options.onEnd] - 结束回调
   * @param {Function} [options.onFadeStart] - 淡出开始回调
   * @returns {Object} 定时器实例
   */
  function createSleepTimer(audio, options) {
    if (!audio) return null;
    options = options || {};
    const fadeDuration = options.fadeDuration || 10000; // 10 秒淡出

    let timerId = null;
    let deadline = 0;
    let originalVolume = 1;
    let fading = false;
    let fadeStartVolume = 1;
    let fadeStartTime = 0;
    let fadeRafId = null;
    let mode = 'off'; // 'off' | 'countdown' | 'chapter'
    let durationMs = 0;

    function clear() {
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
      if (fadeRafId) {
        cancelAnimationFrame(fadeRafId);
        fadeRafId = null;
      }
      // 恢复音量
      if (fading) {
        audio.volume = originalVolume;
        fading = false;
      }
      mode = 'off';
      deadline = 0;
      durationMs = 0;
    }

    function fadeLoop() {
      if (!fading) return;
      const elapsed = Date.now() - fadeStartTime;
      const progress = Math.min(1, elapsed / fadeDuration);
      // 线性淡出
      audio.volume = Math.max(0, fadeStartVolume * (1 - progress));

      if (progress >= 1) {
        // 淡出完成
        audio.pause();
        audio.volume = originalVolume; // 恢复音量设置
        fading = false;
        clear();
        if (typeof options.onEnd === 'function') options.onEnd();
        showToast('定时结束，已暂停播放');
        announce('定时结束，已暂停播放');
        return;
      }
      fadeRafId = requestAnimationFrame(fadeLoop);
    }

    function startFade() {
      if (fading) return;
      fading = true;
      originalVolume = audio.volume;
      fadeStartVolume = audio.muted ? 0 : audio.volume;
      fadeStartTime = Date.now();
      if (typeof options.onFadeStart === 'function') options.onFadeStart();
      showToast('即将暂停，音量渐弱中...');
      fadeRafId = requestAnimationFrame(fadeLoop);
    }

    function tick() {
      const remaining = Math.max(0, deadline - Date.now());
      if (typeof options.onTick === 'function') options.onTick(remaining);

      // 到达淡出开始时间
      if (remaining <= fadeDuration && !fading && remaining > 0) {
        startFade();
      }

      if (remaining <= 0) {
        clear();
      }
    }

    /**
     * 启动倒计时模式
     * @param {number} minutes - 分钟数
     */
    function startCountdown(minutes) {
      clear();
      mode = 'countdown';
      durationMs = minutes * 60 * 1000;
      deadline = Date.now() + durationMs;
      timerId = setInterval(tick, 1000);
      tick(); // 立即执行一次
      showToast(minutes + ' 分钟后自动暂停');
      announce('定时 ' + minutes + ' 分钟后暂停');
    }

    /**
     * 启动章节结束模式（本章结束后暂停）
     */
    function startChapterEnd() {
      clear();
      mode = 'chapter';
      showToast('本章播放结束后自动暂停');
      announce('本章结束后暂停');
    }

    /**
     * 取消定时器
     * @param {boolean} [silent] - 是否静默取消（不显示 toast）
     */
    function cancel(silent) {
      const wasFading = fading;
      clear();
      if (!silent) {
        showToast('已取消定时关闭');
        announce('已取消定时关闭');
      }
      if (wasFading) {
        // 取消淡出，恢复音量
        audio.volume = originalVolume;
      }
    }

    /**
     * 章节结束时调用（用于 chapter 模式）
     */
    function onChapterEnded() {
      if (mode === 'chapter') {
        startFade();
        // 淡出结束后会自动暂停
      }
    }

    /**
     * 循环切换定时时长；数组可含 'chapter'（播完本章暂停）。
     * @param {Array<number|string>} cycle - 循环数组，默认 [15, 30, 45, 60, 0]
     * @returns {number|string} 当前设置（0 表示关闭，'chapter' 表示本章结束暂停）
     */
    function cycle(cycleArr) {
      cycleArr = cycleArr || [15, 30, 45, 60, 0];
      let currentMinutes = 0;
      if (mode === 'countdown') {
        currentMinutes = Math.round(durationMs / 60000);
      }
      const idx = cycleArr.indexOf(currentMinutes);
      const next = cycleArr[(idx + 1) % cycleArr.length];
      if (next === 0) {
        cancel();
      } else if (next === 'chapter') {
        startChapterEnd();
      } else {
        startCountdown(next);
      }
      return next;
    }

    return {
      startCountdown: startCountdown,
      startChapterEnd: startChapterEnd,
      cancel: cancel,
      onChapterEnded: onChapterEnded,
      cycle: cycle,
      getMode: function () { return mode; },
      getRemaining: function () {
        if (mode !== 'countdown') return 0;
        return Math.max(0, deadline - Date.now());
      },
      isFading: function () { return fading; }
    };
  }

  /* ================================================================
   * PWA 安装支持
   * ================================================================ */

  let _deferredPrompt = null;
  let _pwaInstalled = false;

  // 监听 beforeinstallprompt 事件
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      _deferredPrompt = e;
      // 通知按钮可以显示
      document.dispatchEvent(new CustomEvent('ab-pwa-installable', { detail: { available: true } }));
    });

    window.addEventListener('appinstalled', function () {
      _pwaInstalled = true;
      _deferredPrompt = null;
      document.dispatchEvent(new CustomEvent('ab-pwa-installed', { detail: { installed: true } }));
    });
  }

  /**
   * 初始化 PWA 安装按钮
   * @param {HTMLElement} buttonEl - 安装按钮元素
   * @param {Object} [options] - 配置选项
   * @param {Function} [options.onInstalled] - 安装成功回调
   * @param {Function} [options.onAvailable] - 可安装时回调
   * @returns {Object} { destroy } 销毁函数
   */
  function initPWAInstall(buttonEl, options) {
    if (!buttonEl) return { destroy: function () {} };
    options = options || {};

    function updateButton() {
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                          window.navigator.standalone === true;
      if (isStandalone || _pwaInstalled) {
        buttonEl.style.display = 'none';
        return;
      }
      if (_deferredPrompt) {
        buttonEl.style.display = '';
      } else {
        // 某些浏览器不支持 PWA 安装，隐藏按钮
        buttonEl.style.display = 'none';
      }
    }

    function onInstallClick() {
      if (!_deferredPrompt) return;
      _deferredPrompt.prompt();
      _deferredPrompt.userChoice.then(function (choiceResult) {
        if (choiceResult.outcome === 'accepted') {
          if (typeof options.onInstalled === 'function') options.onInstalled();
          showToast('应用安装中...');
        }
        _deferredPrompt = null;
        updateButton();
      });
    }

    function onAvailable(e) {
      if (e && e.detail && e.detail.available) {
        updateButton();
        if (typeof options.onAvailable === 'function') options.onAvailable();
      }
    }

    function onInstalled(e) {
      updateButton();
      if (typeof options.onInstalled === 'function') options.onInstalled();
      showToast('应用安装成功！');
    }

    buttonEl.addEventListener('click', onInstallClick);
    document.addEventListener('ab-pwa-installable', onAvailable);
    document.addEventListener('ab-pwa-installed', onInstalled);

    // 初始检查
    updateButton();

    return {
      destroy: function () {
        buttonEl.removeEventListener('click', onInstallClick);
        document.removeEventListener('ab-pwa-installable', onAvailable);
        document.removeEventListener('ab-pwa-installed', onInstalled);
      }
    };
  }

  /* ================================================================
   * Service Worker 注册与消息辅助
   * ================================================================ */

  /**
   * 注册 Service Worker；检测到新版本时立即 skipWaiting 接管，
   * 避免旧 SW（无新消息 API）导致 PREFETCH_AUDIO 等消息丢失。
   * 若注册时已有旧 SW 在控制本页，新版本接管（controllerchange）后自动刷新一次，
   * 保证页面 HTML 与 SW 同代——否则旧 SW 用户要手动刷两次才能拿到新版本。
   * @param {string} swPath - SW 脚本路径（相对当前页面）
   * @param {Object} [options] - 配置
   * @param {Function} [options.onReady] - 注册完成回调 (registration)
   * @returns {Promise<ServiceWorkerRegistration|null>}
   */
  function registerServiceWorker(swPath, options) {
    options = options || {};
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    const hadController = !!navigator.serviceWorker.controller;
    let refreshed = false;
    if (hadController) {
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (refreshed) return;
        refreshed = true;
        window.location.reload();
      });
    }
    return navigator.serviceWorker.register(swPath).then(function (reg) {
      const skipWaiting = function () {
        if (reg.waiting) { reg.waiting.postMessage('SKIP_WAITING'); return; }
        if (reg.installing) {
          reg.installing.addEventListener('statechange', function onState(e) {
            if (e.target.state === 'installed') {
              e.target.postMessage('SKIP_WAITING');
              e.target.removeEventListener('statechange', onState);
            }
          });
        }
      };
      reg.addEventListener('updatefound', skipWaiting);
      skipWaiting();
      if (typeof options.onReady === 'function') options.onReady(reg);
      return reg;
    }).catch(function () { return null; });
  }

  /**
   * 向当前激活的 SW 发送消息（PREFETCH_AUDIO / PREFETCH_STOP / QUERY_CACHED_AUDIO 等）。
   * @param {Object} message - 消息对象（含 type）
   * @returns {Promise<boolean>} 是否成功投递
   */
  function sendToServiceWorker(message) {
    if (!('serviceWorker' in navigator)) return Promise.resolve(false);
    return navigator.serviceWorker.ready.then(function (reg) {
      const target = reg.active || reg.waiting || reg.installing;
      if (!target) return false;
      target.postMessage(message);
      return true;
    }).catch(function () { return false; });
  }

  /* ================================================================
   * 主题 / 阅读字号（book id 参数化）
   * ================================================================ */

  /**
   * 初始化明暗主题切换（全站统一存储键 ``audiobook-theme``，与着陆页/404 共享，
   * 暗色状态跨页保持；旧的按书键只作一次性迁移）。
   * 页面头部内联脚本负责首屏防闪，这里只同步按钮、迁移旧键并处理点击。
   * @param {Object} opts - 配置
   * @param {string} [opts.key] - 旧版按书存储键（如 'zhixiao_theme'），迁移后可删
   * @param {HTMLElement} opts.button - 切换按钮
   * @param {Function} [opts.iconFor] - (isDark) => 图标文本
   * @param {Function} [opts.onToggle] - 切换后的额外回调（如旋转动画）
   */
  function initTheme(opts) {
    if (!opts || !opts.button) return;
    const key = 'audiobook-theme';
    const legacyKey = opts.key || null;
    const button = opts.button;
    const iconFor = opts.iconFor || function (dark) { return dark ? '🌙' : '☀'; };
    const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';

    /* 一次性迁移：旧按书键 → 统一键（与着陆页/404 共享同一暗色状态） */
    try {
      let t = localStorage.getItem(key);
      if (t == null && legacyKey) {
        t = localStorage.getItem(legacyKey);
        if (t === 'dark' || t === 'light') localStorage.setItem(key, t);
      }
    } catch (_) {}

    /* iconFor 返回空串表示图标由页面 CSS 控制（如日/月 SVG），此时不能写
     * textContent——那会清空按钮内的子元素。 */
    const applyIcon = function (dark) {
      const icon = iconFor(dark);
      if (icon) button.textContent = icon;
    };
    applyIcon(isDark());
    button.addEventListener('click', function () {
      const next = !isDark();
      if (next) document.documentElement.setAttribute('data-theme', 'dark');
      else document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem(key, next ? 'dark' : 'light'); } catch (_) {}
      applyIcon(next);
      if (typeof opts.onToggle === 'function') opts.onToggle(next);
      announce(next ? '已切换到深色主题' : '已切换到浅色主题');
    });
  }

  const READING_SIZES = [1, 1.15, 1.3];

  /**
   * 初始化阅读字号切换（存储键按书参数化）。
   * @param {Object} opts - 配置
   * @param {string} opts.key - localStorage 键（如 'zhixiao_reading_size'）
   * @param {HTMLElement} opts.button - 字号按钮
   * @param {Function} opts.apply - (size, idx) => 应用字号到页面
   * @returns {Object} { cycle(delta), getIndex() }
   */
  function initReadingSize(opts) {
    if (!opts || !opts.button) return null;
    const key = opts.key || 'reading_size';
    const button = opts.button;
    let idx = 0;
    try {
      const saved = Number(localStorage.getItem(key));
      const i = READING_SIZES.indexOf(saved);
      if (i >= 0) idx = i;
    } catch (_) {}

    function apply() {
      const size = READING_SIZES[idx];
      if (typeof opts.apply === 'function') opts.apply(size, idx);
      button.classList.toggle('active', idx !== 0);
      button.textContent = idx === 0 ? 'Aa' : (idx === READING_SIZES.length - 1 ? 'Aa++' : 'Aa+');
      button.setAttribute('aria-label', '阅读字号：' + Math.round(size * 100) + '%');
    }

    function cycle(delta) {
      idx = (idx + (delta || 1) + READING_SIZES.length) % READING_SIZES.length;
      try { localStorage.setItem(key, String(READING_SIZES[idx])); } catch (_) {}
      apply();
      announce('字号已调为 ' + Math.round(READING_SIZES[idx] * 100) + '%');
      return READING_SIZES[idx];
    }

    button.addEventListener('click', function () { cycle(1); });
    apply();
    return { cycle: cycle, getIndex: function () { return idx; } };
  }

  /* ---------- 暴露 API ---------- */
  global.ABCommon = {
    fmtTime: fmtTime,
    SPEED_STEPS: SPEED_STEPS,
    normalizeChapters: normalizeChapters,
    audioSrc: audioSrc,
    audioUrls: audioUrls,
    findActiveSeg: findActiveSeg,
    parseHashChapter: parseHashChapter,
    applyHashRoute: applyHashRoute,
    updateHash: updateHash,
    updateMediaSession: updateMediaSession,
    updateMediaSessionPosition: updateMediaSessionPosition,
    readJSON: readJSON,
    saveThrottled: saveThrottled,
    showToast: showToast,
    announce: announce,
    trapFocus: trapFocus,
    releaseFocus: releaseFocus,
    crossFade: crossFade,
    emptyHTML: emptyHTML,
    errorHTML: errorHTML,
    // 播放进度持久化
    saveProgress: saveProgress,
    loadProgress: loadProgress,
    clearProgress: clearProgress,
    showResumePrompt: showResumePrompt,
    // 缓冲进度
    initBufferProgress: initBufferProgress,
    // 虚拟滚动
    createVirtualList: createVirtualList,
    // 键盘快捷键
    initKeyboardShortcuts: initKeyboardShortcuts,
    showShortcutsHelp: showShortcutsHelp,
    // 睡眠定时器
    createSleepTimer: createSleepTimer,
    // PWA 安装
    initPWAInstall: initPWAInstall,
    // SW 注册与消息
    registerServiceWorker: registerServiceWorker,
    sendToServiceWorker: sendToServiceWorker,
    // 主题 / 阅读字号
    initTheme: initTheme,
    initReadingSize: initReadingSize
  };
})(window);
