/* performance-utils.js
 * 性能优化工具库
 * 提供常用的性能优化函数
 */

(function(global) {
  'use strict';

  /* ---------- 防抖函数 ---------- */
  function debounce(func, wait, immediate) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        timeout = null;
        if (!immediate) func.apply(this, args);
      };
      const callNow = immediate && !timeout;
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
      if (callNow) func.apply(this, args);
    };
  }

  /* ---------- 节流函数 ---------- */
  function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }

  /* ---------- RAF节流 ---------- */
  function rafThrottle(func) {
    let rafId = null;
    return function(...args) {
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          func.apply(this, args);
          rafId = null;
        });
      }
    };
  }

  /* ---------- 懒加载图片 ---------- */
  function lazyLoadImages(selector = 'img[data-src]') {
    if (!('IntersectionObserver' in window)) {
      // 降级处理：直接加载所有图片
      const images = document.querySelectorAll(selector);
      images.forEach(img => {
        if (img.dataset.src) {
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
        }
      });
      return;
    }

    const imageObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
            observer.unobserve(img);
          }
        }
      });
    }, {
      rootMargin: '50px 0px',
      threshold: 0.01
    });

    const images = document.querySelectorAll(selector);
    images.forEach(img => imageObserver.observe(img));
  }

  /* ---------- 预加载资源 ---------- */
  function preloadResource(url, as = 'script') {
    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = as;
      link.href = url;
      link.onload = resolve;
      link.onerror = reject;
      document.head.appendChild(link);
    });
  }

  /* ---------- 预连接到域名 ---------- */
  function preconnect(url) {
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = url;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }

  /* ---------- DNS预解析 ---------- */
  function dnsPrefetch(url) {
    const link = document.createElement('link');
    link.rel = 'dns-prefetch';
    link.href = url;
    document.head.appendChild(link);
  }

  /* ---------- 性能监控 ---------- */
  function observePerformance(callback) {
    if (!('PerformanceObserver' in window)) {
      console.warn('PerformanceObserver not supported');
      return;
    }

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          callback(entry);
        }
      });

      // 监控各种性能指标
      observer.observe({ 
        entryTypes: [
          'largest-contentful-paint',
          'first-input',
          'layout-shift',
          'paint',
          'navigation'
        ] 
      });

      return observer;
    } catch (e) {
      console.error('Performance observer error:', e);
      return null;
    }
  }

  /* ---------- 测量性能 ---------- */
  function measurePerformance(name, func) {
    return function(...args) {
      const start = performance.now();
      const result = func.apply(this, args);
      const end = performance.now();
      console.log(`${name} took ${end - start}ms`);
      return result;
    };
  }

  /* ---------- 空闲时执行 ---------- */
  function runWhenIdle(callback, timeout = 2000) {
    if ('requestIdleCallback' in window) {
      return requestIdleCallback(callback, { timeout });
    } else {
      return setTimeout(callback, 1);
    }
  }

  /* ---------- 取消空闲任务 ---------- */
  function cancelIdle(id) {
    if ('cancelIdleCallback' in window) {
      cancelIdleCallback(id);
    } else {
      clearTimeout(id);
    }
  }

  /* ---------- 批量DOM操作 ---------- */
  function batchDOMUpdates(callback) {
    requestAnimationFrame(() => {
      callback();
    });
  }

  /* ---------- 虚拟滚动 ---------- */
  class VirtualScroll {
    constructor(container, items, itemHeight, renderItem) {
      this.container = container;
      this.items = items;
      this.itemHeight = itemHeight;
      this.renderItem = renderItem;
      this.visibleStart = 0;
      this.visibleEnd = 0;
      this.init();
    }

    init() {
      this.container.style.position = 'relative';
      this.container.style.overflow = 'auto';
      
      this.content = document.createElement('div');
      this.content.style.position = 'absolute';
      this.content.style.top = '0';
      this.content.style.left = '0';
      this.content.style.right = '0';
      this.container.appendChild(this.content);

      this.container.addEventListener('scroll', rafThrottle(() => {
        this.render();
      }));

      this.render();
    }

    render() {
      const scrollTop = this.container.scrollTop;
      const containerHeight = this.container.clientHeight;
      
      this.visibleStart = Math.floor(scrollTop / this.itemHeight);
      this.visibleEnd = Math.ceil((scrollTop + containerHeight) / this.itemHeight);
      
      this.content.style.height = `${this.items.length * this.itemHeight}px`;
      this.content.innerHTML = '';
      
      for (let i = this.visibleStart; i <= this.visibleEnd && i < this.items.length; i++) {
        const item = this.renderItem(this.items[i], i);
        item.style.position = 'absolute';
        item.style.top = `${i * this.itemHeight}px`;
        item.style.height = `${this.itemHeight}px`;
        this.content.appendChild(item);
      }
    }
  }

  /* ---------- 资源提示 ---------- */
  function resourceHints(hints) {
    hints.forEach(hint => {
      const link = document.createElement('link');
      link.rel = hint.rel;
      link.href = hint.href;
      if (hint.as) link.as = hint.as;
      if (hint.type) link.type = hint.type;
      if (hint.crossorigin) link.crossOrigin = hint.crossorigin;
      document.head.appendChild(link);
    });
  }

  /* ---------- 暴露API ---------- */
  global.PerfUtils = {
    debounce,
    throttle,
    rafThrottle,
    lazyLoadImages,
    preloadResource,
    preconnect,
    dnsPrefetch,
    observePerformance,
    measurePerformance,
    runWhenIdle,
    cancelIdle,
    batchDOMUpdates,
    VirtualScroll,
    resourceHints
  };
})(window);
