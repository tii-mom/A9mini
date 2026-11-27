import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const JS_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(JS_DIR, '..');
const JS_URL = pathToFileURL(JS_DIR).href;

function parseCssVars(cssBlock) {
  const vars = {};
  for (const m of cssBlock.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

function relativeLuminance(hex) {
  const clean = hex.replace('#', '');
  assert.match(clean, /^[0-9a-f]{6}$/i, `expected 6-digit hex color, got: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(clean.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg, bg) {
  const la = relativeLuminance(fg);
  const lb = relativeLuminance(bg);
  return Number(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)).toFixed(2));
}

test('5f 视觉规范：tokens.css 圆角 3 档/字号 5 档、--red=#E60012 与 --err-red 分离、浅色与暗夜全部核心对比度 >= 4.5:1', () => {
  const tokensCss = readFileSync(join(APP_DIR, 'css', 'tokens.css'), 'utf8');
  const darkIdx = tokensCss.indexOf('[data-theme="dark"]');
  assert.ok(darkIdx > 0, 'tokens.css must define [data-theme="dark"]');
  const lightVars = parseCssVars(tokensCss.slice(0, darkIdx));
  const darkVars = { ...lightVars, ...parseCssVars(tokensCss.slice(darkIdx)) };

  // 圆角 3 档与字号 5 档
  assert.equal(lightVars['--radius-lg'], '16px');
  assert.equal(lightVars['--radius-md'], '12px');
  assert.equal(lightVars['--radius-pill'], '999px');
  assert.equal(lightVars['--fs-xs'], '11px');
  assert.equal(lightVars['--fs-sm'], '12px');
  assert.equal(lightVars['--fs-md'], '14px');
  assert.equal(lightVars['--fs-lg'], '18px');
  assert.equal(lightVars['--fs-xl'], '24px');

  // --red 改为品牌正红 #E60012，并与语义报错红 --err-red 区分
  assert.equal(lightVars['--red'].toUpperCase(), '#E60012');
  assert.equal(darkVars['--red'].toUpperCase(), '#E60012');
  assert.notEqual(lightVars['--err-red'].toUpperCase(), '#E60012');
  assert.notEqual(darkVars['--err-red'].toUpperCase(), '#E60012');

  const checks = [
    ['light: ink on card-bg', lightVars['--ink'], lightVars['--card-bg']],
    ['light: ink-soft on card-bg', lightVars['--ink-soft'], lightVars['--card-bg']],
    ['light: ink-muted on card-bg', lightVars['--ink-muted'], lightVars['--card-bg']],
    ['light: ink-muted on paper-bg', lightVars['--ink-muted'], lightVars['--paper-bg']],
    ['light: ink-muted on paper-tray', lightVars['--ink-muted'], lightVars['--paper-tray']],
    ['light: nt-green on card-bg', lightVars['--nt-green'], lightVars['--card-bg']],
    ['light: nt-green on nt-green-soft', lightVars['--nt-green'], lightVars['--nt-green-soft']],
    ['light: nt-green on paper-tray', lightVars['--nt-green'], lightVars['--paper-tray']],
    ['light: white on nt-green-stamp-bg', '#FFFFFF', lightVars['--nt-green-stamp-bg']],
    ['light: white on nt-red btn-primary', '#FFFFFF', lightVars['--nt-red']],
    ['light: nt-red-ink on card-bg', lightVars['--nt-red-ink'], lightVars['--card-bg']],
    ['light: nt-red-ink on nt-red-soft', lightVars['--nt-red-ink'], lightVars['--nt-red-soft']],
    ['light: err-red on card-bg', lightVars['--err-red'], lightVars['--card-bg']],
    ['light: err-red on nt-rose-soft', lightVars['--err-red'], lightVars['--nt-rose-soft']],
    ['light: nt-blue on card-bg', lightVars['--nt-blue'], lightVars['--card-bg']],
    ['light: nt-gold-ink on nt-gold-soft', lightVars['--nt-gold-ink'], lightVars['--nt-gold-soft']],
    ['dark: ink on card-bg', darkVars['--ink'], darkVars['--card-bg']],
    ['dark: ink-soft on card-bg', darkVars['--ink-soft'], darkVars['--card-bg']],
    ['dark: ink-muted on card-bg', darkVars['--ink-muted'], darkVars['--card-bg']],
    ['dark: white on nt-red btn-primary', '#FFFFFF', darkVars['--nt-red']],
    ['dark: nt-red-ink on card-bg', darkVars['--nt-red-ink'], darkVars['--card-bg']],
    ['dark: nt-red-ink on nt-red-soft', darkVars['--nt-red-ink'], darkVars['--nt-red-soft']],
    ['dark: err-red on card-bg', darkVars['--err-red'], darkVars['--card-bg']],
    ['dark: err-red on nt-rose-soft', darkVars['--err-red'], darkVars['--nt-rose-soft']],
    ['dark: white on nt-green-stamp-bg (pass stamp)', '#FFFFFF', darkVars['--nt-green-stamp-bg']],
    ['dark: nt-green on card-bg', darkVars['--nt-green'], darkVars['--card-bg']],
    ['dark: nt-blue on card-bg', darkVars['--nt-blue'], darkVars['--card-bg']],
    ['dark: nt-gold-ink on nt-gold-soft', darkVars['--nt-gold-ink'], darkVars['--nt-gold-soft']],
  ];

  for (const [label, fg, bg] of checks) {
    const ratio = contrastRatio(fg, bg);
    assert.ok(ratio >= 4.5, `${label} (${fg} on ${bg}) contrast ${ratio}:1 must be >= 4.5:1`);
  }

  // 跨路由隔离与死 CSS 清理检查
  const wvCss = readFileSync(join(APP_DIR, 'css', 'wealthverse.css'), 'utf8');
  assert.doesNotMatch(wvCss, /^\s*\.plaza-overview\b/m, 'wealthverse.css must scope legacy .plaza-overview rules');
  assert.doesNotMatch(wvCss, /^\s*\.mall-info-strip\b/m, 'wealthverse.css must not globally override .mall-info-strip');
  assert.doesNotMatch(wvCss, /\.plaza-onboard-step/, 'removed dead .plaza-onboard-step CSS should stay deleted');
  assert.doesNotMatch(wvCss, /\.mall-crit-ticker/, 'removed dead .mall-crit-ticker CSS should stay deleted');

  const compCss = readFileSync(join(APP_DIR, 'css', 'components.css'), 'utf8');
  assert.doesNotMatch(compCss, /\.sw-battle-strip\b/, 'removed dead .sw-battle-strip CSS should stay deleted');
  assert.doesNotMatch(compCss, /\.plaza-confirmed-row\b/, 'removed dead .plaza-confirmed-row CSS should stay deleted');

  const gameCss = readFileSync(join(APP_DIR, 'css', 'game.css'), 'utf8');
  assert.doesNotMatch(gameCss, /\.mall-crit-ticker\b/, 'removed dead .mall-crit-ticker CSS should stay deleted');

  // 禁止现役 CSS 使用前景色 color: var(--nt-red)（必须使用 --nt-red-ink 保证暗夜与浅红胶囊 >= 4.5:1）
  for (const [name, css] of [['components.css', compCss], ['game.css', gameCss], ['wealthverse.css', wvCss]]) {
    assert.doesNotMatch(
      css,
      /(?:^|[^-])color:\s*var\(--nt-red(?:,|\))/m,
      `${name} must use var(--nt-red-ink) instead of var(--nt-red) for foreground color`
    );
  }

  // 最小字号 >= 11px 守卫（覆盖主样式表与现役页面）
  const smallFontRe = /font-size:\s*(?:[0-9]|10)(?:\.[0-9]+)?px/i;
  for (const rel of [
    'css/components.css',
    'css/game.css',
    'index.html',
    'js/app.js',
    'js/pages/plaza.js',
    'js/pages/round_stages.js',
  ]) {
    const src = readFileSync(join(APP_DIR, rel), 'utf8');
    assert.doesNotMatch(src, smallFontRe, `${rel} must not use font-size < 11px`);
  }

  // components.css 主组件圆角收敛为 3 档（16 / 12 / 999px），不再保留 24/21/20/18/15/14/13/11/10/9px 零散圆角
  assert.doesNotMatch(
    compCss,
    /border-radius:\s*(?:24|21|20|18|15|14|13|11|10|9)px\s*;/,
    'components.css must converge component border-radius to 3 tiers (16px / 12px / 999px)'
  );
});

test('5f 宝箱商城降噪：隐藏免费膨胀箱Tab、?tab=free兼容回落6档主视图、去跑马灯与底部导流卡、首屏单主按钮、收口app.js旧跳转', () => {
  const runMall = (mode, queryObj) => {
    const script = `
      const storageMap = new Map([['a9_ui_prefs_v1', JSON.stringify({ settings: { language: 'zh-CN', themeMode: 'light' } })]]);
      const makeEl = (withChildStub = true) => ({
        id: '',
        dataset: {},
        style: {},
        isConnected: true,
        _html: '',
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = String(v); },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        setAttribute() {},
        getAttribute() { return null; },
        removeAttribute() {},
        addEventListener() {},
        removeEventListener() {},
        appendChild() {},
        append() {},
        remove() {},
        querySelector() { return withChildStub ? makeEl(true) : null; },
        querySelectorAll() { return []; },
      });
      globalThis.localStorage = {
        getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
        setItem: (k, v) => storageMap.set(k, String(v)),
        removeItem: (k) => storageMap.delete(k),
      };
      globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
      Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
      globalThis.window = {
        __A9_CONFIG__: { mode: ${JSON.stringify(mode)}, network: 'testnet', apiBase: 'https://api.example.invalid', liveFundsEnabled: false },
        location: { href: 'https://app.example.invalid/?mode=' + ${JSON.stringify(mode)}, origin: 'https://app.example.invalid', pathname: '/', search: '?mode=' + ${JSON.stringify(mode)}, hash: '#/market' },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {},
        scrollTo() {},
      };
      globalThis.document = {
        documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' },
        body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
        addEventListener() {},
        createElement: () => makeEl(true),
        getElementById: () => makeEl(true),
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      globalThis.requestAnimationFrame = () => 0;
      globalThis.setInterval = () => 0;
      globalThis.clearInterval = () => {};
      globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return { ok: true, data: {}, ts: Date.now() }; } });

      const { store } = await import(${JSON.stringify(JS_URL)} + '/store.js');
      if (${JSON.stringify(mode)} === 'live') {
        store.update((s) => {
          s.round.presale = { open: false };
          s.round.chestMall = {
            openEnabled: false,
            deliveryFeeGram: '0.06',
            skus: [
              { skuId: 'chest_bronze', tier: 'bronze', priceGram: '0.99', deliveryFeeGram: '0.06', totalPayGram: '1.05', baseA9: 1500, maxBoostA9: 1000, maxBoostBps: 6670, zh: '青铜宝箱', en: 'Bronze Chest' },
              { skuId: 'chest_silver', tier: 'silver', priceGram: '5', deliveryFeeGram: '0.06', totalPayGram: '5.06', baseA9: 8000, maxBoostA9: 4000, maxBoostBps: 5000, zh: '白银宝箱', en: 'Silver Chest' },
              { skuId: 'chest_gold', tier: 'gold', priceGram: '20', deliveryFeeGram: '0.06', totalPayGram: '20.06', baseA9: 34000, maxBoostA9: 16000, maxBoostBps: 4700, zh: '黄金宝箱', en: 'Gold Chest' },
              { skuId: 'chest_platinum', tier: 'platinum', priceGram: '50', deliveryFeeGram: '0.06', totalPayGram: '50.06', baseA9: 90000, maxBoostA9: 40000, maxBoostBps: 4400, zh: '铂金宝箱', en: 'Platinum Chest' },
              { skuId: 'chest_diamond', tier: 'diamond', priceGram: '150', deliveryFeeGram: '0.06', totalPayGram: '150.06', baseA9: 280000, maxBoostA9: 120000, maxBoostBps: 4300, zh: '钻石宝箱', en: 'Diamond Chest' },
              { skuId: 'chest_legendary', tier: 'legendary', priceGram: '500', deliveryFeeGram: '0.06', totalPayGram: '500.06', baseA9: 960000, maxBoostA9: 340000, maxBoostBps: 3500, zh: '传说宝箱', en: 'Legendary Chest' },
            ],
          };
        });
      } else {
        const { loadDemoModule } = await import(${JSON.stringify(JS_URL)} + '/demo-loader.js');
        await loadDemoModule();
      }
      const { renderInternalMarket } = await import(${JSON.stringify(JS_URL)} + '/pages/warmup_market.js');
      const root = makeEl(true);
      renderInternalMarket(root, () => {}, null, ${JSON.stringify(queryObj)});
      await new Promise((r) => setTimeout(r, 30));
      console.log(JSON.stringify({ html: root.innerHTML }));
    `;
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    return JSON.parse(raw.trim().split('\n').at(-1)).html;
  };

  for (const [label, html] of [
    ['live default', runMall('live', {})],
    ['live ?tab=free fallback', runMall('live', { tab: 'free' })],
    ['demo default', runMall('demo', {})],
    ['demo ?tab=free fallback', runMall('demo', { tab: 'free' })],
  ]) {
    assert.ok(!html.includes('chest-mall-tabs') && !html.includes('免费膨胀箱'), `${label} must hide Free Chests tab`);
    assert.ok(!html.includes('mall-crit-ticker'), `${label} must remove top crit marquee ticker`);
    assert.ok(!html.includes('进战场锁仓冲价') && !html.includes('邀友购箱享 6% 返佣'), `${label} must remove bottom duplicate battle CTA card`);
    assert.ok(html.includes('id="mall-base-receipt-strip"'), `${label} must combine base guarantee & receipts in one strip`);
    assert.equal((html.match(/data-pick-sku=/g) || []).length, 6, `${label} must keep all 6 chest tiers`);
    assert.ok(html.includes('class="mall-verify-link" href="#/rules#audit"'), `${label} must use nowrap verify link to #/rules#audit`);
    const primaryCount = (html.match(/class="[^"]*\bbtn-primary\b[^"]*"/g) || []).length;
    assert.ok(primaryCount <= 1, `${label} must have <= 1 btn-primary (got ${primaryCount})`);
    if (label.startsWith('live')) {
      assert.equal(primaryCount, 0, `${label} in read-only live mode must keep purchase CTA disabled (not btn-primary)`);
    } else {
      assert.equal(primaryCount, 1, `${label} in demo mode must have exactly 1 btn-primary`);
    }
  }

  // app.js 同行礼弹窗收口：不再跳转 tab=free
  const appSrc = readFileSync(join(JS_DIR, 'app.js'), 'utf8');
  assert.ok(!appSrc.includes('tab=free'), 'app.js must not navigate to hidden ?tab=free');
});
