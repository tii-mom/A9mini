/**
 * A9 Demo Module Lazy Loader
 * - Live 模式（config.isDemo === false）：永不加载 js/demo-data.js，0 下载、0 解析。
 * - Demo 模式（config.isDemo === true）：按需动态加载，并发去重，失败自动清理以便重试。
 */

import { config } from './config.js';

let demoMod = null;
let loadingPromise = null;

export function isDemoReady() {
  return Boolean(config.isDemo && demoMod);
}

/**
 * 异步加载 demo-data.js（并发共享同一 Promise；失败后清空缓存以允许重试）。
 * Live 模式下直接返回 null。
 */
export function loadDemoModule(importer = null) {
  if (!config.isDemo) return Promise.resolve(null);
  if (demoMod) return Promise.resolve(demoMod);
  if (loadingPromise) return loadingPromise;
  const runImport = typeof importer === 'function' ? importer : () => import('./demo-data.js');
  loadingPromise = Promise.resolve()
    .then(() => runImport())
    .then((mod) => {
      demoMod = mod;
      loadingPromise = null;
      return mod;
    })
    .catch((err) => {
      loadingPromise = null;
      throw err;
    });
  return loadingPromise;
}

/**
 * 同步获取已加载的 demo-data.js 模块：
 * - Live 模式返回 null；
 * - Demo 模式未就绪时抛出 DEMO_NOT_READY（正常页面入口在 store.ensureDemoReady() 完成后才开放）。
 */
export function getDemoModule() {
  if (!config.isDemo) return null;
  if (!demoMod) {
    const err = new Error('Demo data module is not ready yet');
    err.code = 'DEMO_NOT_READY';
    throw err;
  }
  return demoMod;
}

/** 测试或重试辅助：允许安全读取已就绪模块而不抛错。 */
export function peekDemoModule() {
  return config.isDemo ? demoMod : null;
}
