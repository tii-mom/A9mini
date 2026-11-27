/**
 * 首屏资源按需加载回归测试
 * 覆盖：
 * - audio.js：默认静音零加载、并发加载去重、失败可重试、加载中静音不误播、kinetic 防旧页绑定
 * - components.js：loadHeavyComponents 并发去重与失败重试、registerInteractionCleanup 卸载
 * - css-loader.js：并发去重、已加载同步判定、失败移除残留 link 并可重试
 * - router.js：广场首屏零专属样式、非广场路由声明页面样式
 */

import test from 'node:test';
import assert from 'node:assert/strict';

function createMockBrowserEnv() {
  const storage = new Map();
  const headChildren = [];
  const doc = {
    documentElement: { setAttribute() {}, removeAttribute() {}, style: {} },
    body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
    head: {
      appendChild(node) {
        node.parentNode = doc.head;
        headChildren.push(node);
        return node;
      },
      removeChild(node) {
        const idx = headChildren.indexOf(node);
        if (idx >= 0) headChildren.splice(idx, 1);
        node.parentNode = null;
        return node;
      },
    },
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        rel: '',
        href: '',
        sheet: null,
        parentNode: null,
        onload: null,
        onerror: null,
        getAttribute(name) { return name === 'href' ? this.href : null; },
      };
    },
    querySelectorAll(sel) {
      if (sel === 'link[rel="stylesheet"]') {
        return headChildren.filter((n) => n.tagName === 'LINK' && n.rel === 'stylesheet');
      }
      return [];
    },
    addEventListener() {},
  };

  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
  };
  globalThis.window = {
    location: { origin: 'http://127.0.0.1:8091', hostname: '127.0.0.1', search: '', hash: '#/challenge', href: 'http://127.0.0.1:8091/#/challenge' },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = doc;
  return { headChildren };
}

test('audio.js: muted by default loads nothing, dedupes concurrent loads, retries after failure, and suppresses play if muted mid-load', async () => {
  createMockBrowserEnv();
  const { A9Audio, __setAudioEngineLoaderForTest, loadAudioEngine } = await import('./audio.js');

  let loadCalls = 0;
  const played = [];

  // 1) 默认静音调用不触发加载
  __setAudioEngineLoaderForTest(async () => {
    loadCalls += 1;
    return { audioSynth: { tick: () => played.push('tick'), confirm: () => played.push('confirm') } };
  });
  assert.equal(A9Audio.isEnabled(), false);
  A9Audio.tick();
  A9Audio.tab();
  A9Audio.confirm();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(loadCalls, 0);
  assert.deepEqual(played, []);

  // 2) 首次加载失败不抛错，且允许后续重试
  __setAudioEngineLoaderForTest(async () => {
    loadCalls += 1;
    throw new Error('network down');
  });
  A9Audio.toggle(); // enabled -> true (triggers confirm -> fails silently)
  assert.equal(A9Audio.isEnabled(), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(loadCalls, 1);

  // 3) 并发调用去重，且仅播放最新一次
  let resolveLoader;
  __setAudioEngineLoaderForTest(() => {
    loadCalls += 1;
    return new Promise((resolve) => { resolveLoader = resolve; });
  });
  A9Audio.tick();
  A9Audio.confirm();
  const p1 = loadAudioEngine();
  const p2 = loadAudioEngine();
  assert.equal(p1, p2);
  assert.equal(loadCalls, 2);
  resolveLoader({
    audioSynth: {
      tick: () => played.push('tick'),
      confirm: () => played.push('confirm'),
    },
  });
  await p1;
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(played, ['confirm']);

  // 4) 加载期间切回静音不误播
  played.length = 0;
  let resolveSlow;
  __setAudioEngineLoaderForTest(() => new Promise((resolve) => { resolveSlow = resolve; }));
  A9Audio.tick();
  A9Audio.toggle(); // enabled -> false
  resolveSlow({ audioSynth: { tick: () => played.push('tick') } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(played, []);

  __setAudioEngineLoaderForTest(null);
});

test('components.js: loadHeavyComponents dedupes concurrent loads, retries after failure, and cleanupActiveInteractions runs registered cleanups', async () => {
  createMockBrowserEnv();
  const {
    loadHeavyComponents,
    peekHeavyComponents,
    registerInteractionCleanup,
    cleanupActiveInteractions,
    __setHeavyComponentsLoaderForTest,
  } = await import('./components.js');

  let calls = 0;
  __setHeavyComponentsLoaderForTest(async () => {
    calls += 1;
    throw new Error('temporary chunk error');
  });
  const failed = await loadHeavyComponents();
  assert.equal(failed, null);
  assert.equal(peekHeavyComponents(), null);
  assert.equal(calls, 1);

  let resolveMod;
  __setHeavyComponentsLoaderForTest(() => {
    calls += 1;
    return new Promise((r) => { resolveMod = r; });
  });
  const a = loadHeavyComponents();
  const b = loadHeavyComponents();
  assert.equal(a, b);
  assert.equal(calls, 2);
  const fakeMod = { syncRadarInPlace() {} };
  resolveMod(fakeMod);
  assert.equal(await a, fakeMod);
  assert.equal(peekHeavyComponents(), fakeMod);

  let cleaned = 0;
  registerInteractionCleanup(() => { cleaned += 1; });
  cleanupActiveInteractions();
  assert.equal(cleaned, 1);

  __setHeavyComponentsLoaderForTest(null);
});

test('css-loader.js: dedupes concurrent stylesheet loads, cleans up on error for retry, and reports sync readiness once loaded', async () => {
  const { headChildren } = createMockBrowserEnv();
  const {
    ensureStylesheet,
    ensureStylesheets,
    areStylesheetsLoaded,
    __resetCssLoaderForTest,
  } = await import('./css-loader.js');

  __resetCssLoaderForTest();
  const href = './css/game.css?v=17.1-rc1';
  assert.equal(areStylesheetsLoaded([href]), false);

  // 并发去重：只插一个 <link>
  const p1 = ensureStylesheet(href);
  const p2 = ensureStylesheet(href);
  assert.equal(p1, p2);
  assert.equal(headChildren.length, 1);

  // 模拟加载失败：移除残留 <link>，reject，且允许重试
  headChildren[0].onerror();
  await assert.rejects(p1, /样式表加载失败/);
  assert.equal(headChildren.length, 0);
  assert.equal(areStylesheetsLoaded([href]), false);

  // 重试成功
  const p3 = ensureStylesheets([href]);
  assert.equal(headChildren.length, 1);
  headChildren[0].sheet = {};
  headChildren[0].onload();
  await p3;
  assert.equal(areStylesheetsLoaded([href]), true);

  // 再次调用不再新增 <link>
  await ensureStylesheets([href]);
  assert.equal(headChildren.length, 1);
  __resetCssLoaderForTest();
});

test('router.js: plaza route requires zero deferred stylesheets while all non-plaza routes declare full cross-file stylesheets', async () => {
  createMockBrowserEnv();
  const { ROUTES, matchRoute } = await import('./router.js');
  const plaza = ROUTES.find((r) => r.path === '/challenge');
  assert.ok(plaza);
  assert.deepEqual(plaza.styles, []);

  for (const r of ROUTES.filter((item) => item.path !== '/challenge')) {
    const matched = matchRoute('#' + r.path);
    assert.ok(Array.isArray(matched.route.styles), `${r.path} should declare styles array`);
    assert.ok(matched.route.styles.some((s) => s.includes('game.css')), `${r.path} must include game.css`);
    assert.ok(matched.route.styles.some((s) => s.includes('wealthverse.css')), `${r.path} must include wealthverse.css`);
    assert.ok(matched.route.styles.some((s) => s.includes('animations.css')), `${r.path} must include animations.css`);
  }
});
