import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const JS_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(JS_DIR, '..');
const JS_URL = pathToFileURL(JS_DIR).href;

/** 提取 HTML 片段中除底栏和动态主按钮外的稳定业务入口 href 集合。 */
function extractStableEntries(html) {
  const withoutNextAction = html.replace(/<a[^>]*id="plaza-next-action"[^>]*>.*?<\/a>/g, '');
  const hrefs = [...withoutNextAction.matchAll(/href="(#\/[^"]+)"/g)].map((m) => m[1]);
  return [...new Set(hrefs)].sort();
}

test('5c: index.html 静态首屏入口集合与 plaza.js 渲染入口集合 100% 一致，且清除首页杂乱入口与印章灰盒', () => {
  const indexHtml = readFileSync(join(APP_DIR, 'index.html'), 'utf8');
  // 提取 index.html 顶栏 + 主体（排除底部 tabbar）
  const headerAndMain = indexHtml.slice(indexHtml.indexOf('<header'), indexHtml.indexOf('<nav id="app-tabbar"'));
  const staticEntries = extractStableEntries(headerAndMain);

  const runner = `
    const storageMap = new Map([['a9_ui_prefs_v1', JSON.stringify({ settings: { language: 'zh-CN', hidePlazaHowToPlay: false } })]]);
    let clickHandlers = {};
    const makeEl = () => ({
      id: '',
      dataset: {},
      style: {},
      isConnected: true,
      _html: '',
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); },
      classList: { add() {}, remove() {}, toggle() {} },
      remove() {},
      querySelector(sel) {
        if (sel === '#btn-close-plaza-howto') {
          const b = { set onclick(fn) { clickHandlers.closeHowTo = fn; } };
          return b;
        }
        return null;
      },
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
      __A9_CONFIG__: { mode: 'live', network: 'testnet', apiBase: 'https://api.example.invalid', liveFundsEnabled: false },
      location: { href: 'https://app.example.invalid/?mode=live', origin: 'https://app.example.invalid', search: '?mode=live', hash: '#/challenge' },
      addEventListener() {},
      dispatchEvent() {},
    };
    globalThis.document = {
      documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' },
      body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
      addEventListener() {},
      createElement: () => makeEl(),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const { store } = await import(${JSON.stringify(JS_URL)} + '/store.js');
    store.update((s) => {
      s.round.currentRound = 6;
      s.round.rawState = 'OBSERVING';
      s.round.observationEndAt = Math.floor(Date.now() / 1000) + 3600;
      s.round.rewardBudgetA9 = 700000000;
      s.round.detailLoading = false;
    });
    const { renderCity } = await import(${JSON.stringify(JS_URL)} + '/pages/plaza.js');
    const root = makeEl();
    renderCity(root, () => {});
    const renderedHtml = root.innerHTML;

    // 测试关闭三步玩法卡仅写入 a9_ui_prefs_v1.settings.hidePlazaHowToPlay
    clickHandlers.closeHowTo?.();
    const prefsAfterClose = JSON.parse(storageMap.get('a9_ui_prefs_v1') || '{}');
    const storageKeys = [...storageMap.keys()];
    console.log(JSON.stringify({ renderedHtml, prefsAfterClose, storageKeys }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', runner], { encoding: 'utf8' }).trim().split('\n').at(-1));

  // app.js 顶栏提供 #/rules 与 #/profile，且 index.html 静态四主 Tab 严格为 冲关/金库/宝箱/战队
  const appSrc = readFileSync(join(JS_DIR, 'app.js'), 'utf8');
  assert.ok(appSrc.includes("onSelect: () => navigate('/rules')"), 'app.js header must expose #/rules on Quest stage');
  assert.ok(appSrc.includes('href="#/profile"'), 'app.js header must expose #/profile entry');
  const bootShellChunk = appSrc.slice(appSrc.indexOf('function renderStaticStatusStripHtml'), appSrc.indexOf('function staleBanner'));
  assert.ok(!bootShellChunk.includes('tab=free'), 'app.js boot/error shell must not render removed Free Chest tile');
  assert.ok(!bootShellChunk.includes('sw-gate-grid'), 'app.js boot/error shell must not use legacy 4-tile grid');
  const renderedEntries = extractStableEntries(`<a href="#/rules">规则</a>${out.renderedHtml}`);

  assert.deepEqual(staticEntries, ['#/market', '#/profile', '#/rewards', '#/rules']);
  assert.deepEqual(renderedEntries, ['#/market', '#/rewards', '#/rules']);
  assert.ok(indexHtml.includes('href="#/round"') && indexHtml.includes('冲关'), 'index.html dock must expose 冲关');
  assert.ok(indexHtml.includes('href="#/rewards"') && indexHtml.includes('金库'), 'index.html dock must expose 金库');
  assert.ok(indexHtml.includes('href="#/market"') && indexHtml.includes('宝箱'), 'index.html dock must expose 宝箱');
  assert.ok(indexHtml.includes('href="#/team"') && indexHtml.includes('战队'), 'index.html dock must expose 战队');
  assert.ok(out.renderedHtml.includes('style="white-space:nowrap;">700,000,000 A9</span>'), 'pool amount and A9 unit must stay nowrap');

  // 确认删除了免费宝箱、12H 预言、下轮预热、战队喊单、判定均价灰盒与 12 格印章
  for (const forbidden of ['tab=free', 'panel=prediction', '#/warmup', 'action=rally', 'sw-stamp-row', 'plaza-confirmed-row', '最近确认 1H 判定均价']) {
    assert.ok(!indexHtml.includes(forbidden), `index.html must not contain removed plaza item: ${forbidden}`);
    assert.ok(!out.renderedHtml.includes(forbidden), `plaza.js output must not contain removed item: ${forbidden}`);
  }

  // 确认包含 4 段时间轴、状态条、三步玩法、宝箱商城直发钱包、且 btn-primary <= 1
  assert.ok(out.renderedHtml.includes('plaza-mini-timeline'));
  assert.ok(out.renderedHtml.includes('plaza-status-strip'));
  assert.ok(out.renderedHtml.includes('plaza-howto-card'));
  assert.ok(out.renderedHtml.includes('直发钱包'));
  assert.equal((out.renderedHtml.match(/btn btn-primary/g) || []).length, 1);

  // 关闭状态仅存在唯一白名单键 a9_ui_prefs_v1.settings 中
  assert.deepEqual(out.storageKeys, ['a9_ui_prefs_v1']);
  assert.equal(out.prefsAfterClose?.settings?.hidePlazaHowToPlay, true);
});

test('5c: Live 状态条在 curRoundId 为 null 或 amountRaw 缺失时严格显示 — 绝不伪造 0 A9', () => {
  const runner = `
    const storageMap = new Map([['a9_ui_prefs_v1', JSON.stringify({ settings: { language: 'zh-CN' } })]]);
    let mode = 'nullRound';
    const makeEl = () => {
      const el = {
        id: '',
        dataset: {},
        style: {},
        isConnected: true,
        textContent: '',
        _html: '',
        _lockedEl: null,
        _claimEl: null,
        get innerHTML() { return this._html; },
        set innerHTML(v) {
          this._html = String(v);
          this._lockedEl = { textContent: '', classList: { toggle() {} } };
          this._claimEl = { textContent: '', classList: { toggle() {} } };
        },
        classList: { add() {}, remove() {}, toggle() {} },
        querySelector(sel) {
          if (sel === '#plaza-status-locked') return this._lockedEl;
          if (sel === '#plaza-status-claimable') return this._claimEl;
          return null;
        },
        querySelectorAll() { return []; },
      };
      return el;
    };
    globalThis.localStorage = { getItem: (k) => storageMap.get(k) ?? null, setItem: (k, v) => storageMap.set(k, String(v)), removeItem: (k) => storageMap.delete(k) };
    globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
    globalThis.window = {
      __A9_CONFIG__: { mode: 'live', network: 'testnet', apiBase: 'https://api.example.invalid', liveFundsEnabled: false },
      location: { href: 'https://app.example.invalid/?mode=live', origin: 'https://app.example.invalid', search: '?mode=live', hash: '#/challenge' },
      addEventListener() {},
      dispatchEvent() {},
    };
    globalThis.document = {
      documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' },
      body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
      addEventListener() {},
      createElement: () => makeEl(),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/user/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            data: mode === 'nullRound'
              ? { ticketsAvailable: true, tickets: [], claimableRaw: '0' }
              : { ticketsAvailable: true, tickets: [{ roundId: 6, amountRaw: null, exited: false }], claimableRaw: '0' },
          }),
        };
      }
      if (u.includes('/api/promo/balance')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { claimableRaw: '0' } }) };
      }
      throw new Error('unexpected url: ' + u);
    };

    const { store } = await import(${JSON.stringify(JS_URL)} + '/store.js');
    const { renderCity } = await import(${JSON.stringify(JS_URL)} + '/pages/plaza.js');
    store.update((s) => {
      s.user.connected = true;
      s.user.address = '0:' + '11'.repeat(32);
      s.user.shortAddress = 'kQAR...ERER';
      s.round.currentRound = null;
      s.round.rawState = null;
    });
    const r1 = makeEl();
    renderCity(r1, () => {});
    await new Promise((r) => setTimeout(r, 40));

    mode = 'missingAmountRaw';
    store.update((s) => { s.round.currentRound = 6; s.round.rawState = 'OBSERVING'; });
    const r2 = makeEl();
    renderCity(r2, () => {});
    await new Promise((r) => setTimeout(r, 40));

    console.log(JSON.stringify({ nullRoundLocked: r1._lockedEl.textContent, missingRawLocked: r2._lockedEl.textContent }));
  `;
  const res = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', runner], { encoding: 'utf8' }).trim().split('\n').at(-1));
  assert.equal(res.nullRoundLocked, '—', 'when currentRound is null, round locked must be — (never 0 A9)');
  assert.equal(res.missingRawLocked, '—', 'when ticket amountRaw is null, round locked must be — (never 0 A9)');
});

