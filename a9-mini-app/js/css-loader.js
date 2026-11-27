/**
 * A9 页面专属样式表按需加载器
 * - 并发去重：同一 href 共享 in-flight Promise
 * - 失败可重试：加载失败时移除残留 <link> 并清理在途记录，允许下次重试
 * - 缓存切回零闪烁：提供同步检查 areStylesheetsLoaded()，就绪后跳过骨架屏直接渲染
 */

const loadedHrefs = new Set();
const loadingPromises = new Map();

function normalizeHref(href) {
  return String(href || '').trim();
}

function hasBrowserHead() {
  return typeof document !== 'undefined'
    && Boolean(document.head)
    && typeof document.createElement === 'function'
    && typeof document.head.appendChild === 'function';
}

function findExistingLink(href) {
  if (!hasBrowserHead() || typeof document.querySelectorAll !== 'function') return null;
  const links = document.querySelectorAll('link[rel="stylesheet"]');
  for (const link of links) {
    const raw = link.getAttribute?.('href') || '';
    if (raw === href || link.href === href) return link;
  }
  return null;
}

/** 同步检查所需样式表是否均已加载就绪 */
export function areStylesheetsLoaded(hrefs = []) {
  if (!Array.isArray(hrefs) || hrefs.length === 0) return true;
  if (!hasBrowserHead()) return true;
  for (const raw of hrefs) {
    const href = normalizeHref(raw);
    if (!href) continue;
    if (loadedHrefs.has(href)) continue;
    const existing = findExistingLink(href);
    if (existing && existing.sheet) {
      loadedHrefs.add(href);
      continue;
    }
    return false;
  }
  return true;
}

/** 加载单个样式表（并发去重，失败自动清理以便重试） */
export function ensureStylesheet(rawHref) {
  const href = normalizeHref(rawHref);
  if (!href || !hasBrowserHead()) return Promise.resolve();
  if (loadedHrefs.has(href)) return Promise.resolve();

  const existing = findExistingLink(href);
  if (existing && existing.sheet) {
    loadedHrefs.add(href);
    return Promise.resolve();
  }

  const pending = loadingPromises.get(href);
  if (pending) return pending;

  const promise = new Promise((resolve, reject) => {
    const link = existing || document.createElement('link');
    const isNew = !existing;
    if (isNew) {
      link.rel = 'stylesheet';
      link.href = href;
    }

    const cleanup = () => {
      link.onload = null;
      link.onerror = null;
    };

    link.onload = () => {
      cleanup();
      loadedHrefs.add(href);
      loadingPromises.delete(href);
      resolve();
    };

    link.onerror = () => {
      cleanup();
      loadingPromises.delete(href);
      if (isNew && link.parentNode) {
        try { link.parentNode.removeChild(link); } catch (_) {}
      }
      const err = new Error(`样式表加载失败：${href}`);
      err.code = 'STYLE_LOAD_FAILED';
      reject(err);
    };

    if (isNew) {
      document.head.appendChild(link);
    }
  });

  loadingPromises.set(href, promise);
  return promise;
}

/** 并行确保一组样式表全部就绪 */
export function ensureStylesheets(hrefs = []) {
  if (!Array.isArray(hrefs) || hrefs.length === 0) return Promise.resolve();
  return Promise.all(hrefs.map((href) => ensureStylesheet(href))).then(() => undefined);
}

/** 测试专用钩子：重置样式加载器内存状态 */
export function __resetCssLoaderForTest() {
  loadedHrefs.clear();
  loadingPromises.clear();
}
