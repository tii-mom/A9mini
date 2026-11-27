import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const JS_DIR = dirname(fileURLToPath(import.meta.url));
const JS_URL = pathToFileURL(JS_DIR).href;

function runWarmupScenario({ lang = 'zh', mode = 'live', liveFundsEnabled = false, openEnabled = false }, body) {
  const fullLang = lang === 'en' ? 'en-US' : 'zh-CN';
  const runner = `
    const storageMap = new Map([['a9_ui_prefs_v1', JSON.stringify({ settings: { language: ${JSON.stringify(fullLang)} } })]]);
    const makeEl = () => ({
      id: '',
      dataset: {},
      style: {},
      disabled: false,
      isConnected: true,
      _html: '',
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    });
    globalThis.localStorage = {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
    };
    globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    Object.defineProperty(globalThis, 'navigator', { value: { language: ${JSON.stringify(fullLang)} }, configurable: true });
    globalThis.window = {
      __A9_CONFIG__: { mode: ${JSON.stringify(mode)}, network: 'testnet', apiBase: 'https://api.example.invalid', liveFundsEnabled: ${JSON.stringify(liveFundsEnabled)} },
      location: { href: 'https://app.example.invalid/?mode=' + ${JSON.stringify(mode)}, origin: 'https://app.example.invalid', pathname: '/', search: '?mode=' + ${JSON.stringify(mode)}, hash: '#/round?stage=warmup' },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
    };
    globalThis.document = {
      documentElement: { dataset: { theme: 'light' }, lang: ${JSON.stringify(fullLang)} },
      body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
      activeElement: null,
      addEventListener() {},
      createElement: () => makeEl(),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const { store } = await import(${JSON.stringify(JS_URL)} + '/store.js');
    store.update((s) => {
      s.round.protocolConfig = { chestMall: { openEnabled: ${JSON.stringify(openEnabled)} } };
    });
    const JS_URL = ${JSON.stringify(JS_URL)};
    const makeRoot = () => makeEl();
    ${body}
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', runner], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').at(-1));
}

test('P4: buildWarmupLadder 动态生成候选第 7 轮（1–5 人 = 300–700 A9）及默认配置，并拒绝非单调或缺失配置', () => {
  const res = runWarmupScenario({ lang: 'zh' }, `
    const { buildWarmupLadder } = await import(JS_URL + '/pages/warmup_market.js');
    const r7 = buildWarmupLadder({
      chestMinInvites: 1,
      chestMaxInvites: 5,
      chestBaseA9Raw: '300000000000',
      chestStepA9Raw: '100000000000',
    });
    const def = buildWarmupLadder({
      chestMinInvites: 2,
      chestMaxInvites: 5,
      chestBaseA9Raw: '300000000000',
      chestStepA9Raw: '200000000000',
    });
    const zeroStep = buildWarmupLadder({
      chestMinInvites: 1,
      chestMaxInvites: 5,
      chestBaseA9Raw: '300000000000',
      chestStepA9Raw: '0',
    });
    const nonMonotonicTiers = buildWarmupLadder({
      tiers: [
        { invites: 1, amountRaw: '300000000000' },
        { invites: 2, amountRaw: '500000000000' },
        { invites: 3, amountRaw: '400000000000' },
      ],
    });
    const reversedRange = buildWarmupLadder({
      chestMinInvites: 5,
      chestMaxInvites: 2,
      chestBaseA9Raw: '300000000000',
      chestStepA9Raw: '100000000000',
    });
    const missing = buildWarmupLadder(null);
    console.log(JSON.stringify({
      r7Valid: r7.valid,
      r7Tiers: r7.tiers.map((t) => [t.invites, t.amountA9]),
      defValid: def.valid,
      defTiers: def.tiers.map((t) => [t.invites, t.amountA9]),
      zeroStepValid: zeroStep.valid,
      nonMonotonicValid: nonMonotonicTiers.valid,
      reversedValid: reversedRange.valid,
      missingValid: missing.valid,
    }));
  `);

  assert.equal(res.r7Valid, true);
  assert.deepEqual(res.r7Tiers, [[1, 300], [2, 400], [3, 500], [4, 600], [5, 700]]);
  assert.equal(res.defValid, true);
  assert.deepEqual(res.defTiers, [[2, 300], [3, 500], [4, 700], [5, 900]]);
  assert.equal(res.zeroStepValid, false);
  assert.equal(res.nonMonotonicValid, false);
  assert.equal(res.reversedValid, false);
  assert.equal(res.missingValid, false);
});

test('P4: mountWarmupSection 不与 renderWarmupStage 撞名；候选第 7 轮动态渲染、异常配置显示「配置待确认」、各状态唯一主按钮且只读不放灰按钮', () => {
  const wmSrc = readFileSync(join(JS_DIR, 'pages/warmup_market.js'), 'utf8');
  assert.ok(wmSrc.includes('export function mountWarmupSection('), 'must export mountWarmupSection');
  assert.ok(!wmSrc.includes('export function renderWarmupStage('), 'must not collide with round_stages.js renderWarmupStage');
  // 确认旧写死 2/3/4/5 阶梯已清除
  assert.ok(!wmSrc.includes("2 ${L('人', 'inv')} = 300 A9"), 'hardcoded 2-5 ladder must be removed');

  const res = runWarmupScenario({ lang: 'zh', mode: 'live', liveFundsEnabled: false, openEnabled: false }, `
    const payloads = {
      r7Unreserved: {
        roundId: 7,
        open: true,
        config: { roundId: 7, plannedOpenAt: null, targetUsers: 100, chestMinInvites: 1, chestMaxInvites: 5, chestBaseA9Raw: '300000000000', chestStepA9Raw: '100000000000' },
        stats: { totalRegistered: 3, walletBoundCount: 3 },
        myReservation: null,
        myWarmupChest: null,
      },
      r7ReadyReadonly: {
        roundId: 7,
        open: true,
        config: { roundId: 7, plannedOpenAt: null, targetUsers: 100, chestMinInvites: 1, chestMaxInvites: 5, chestBaseA9Raw: '300000000000', chestStepA9Raw: '100000000000' },
        stats: { totalRegistered: 12, walletBoundCount: 10 },
        myReservation: { status: 'ACTIVE', validInvites: 3, remindEnabled: true },
        myWarmupChest: { chestId: 'ch_1', status: 'READY', currentAssists: 3, requiredAssists: 1, totalA9Raw: '500000000000' },
      },
      badConfig: {
        roundId: 7,
        open: true,
        config: { roundId: 7, plannedOpenAt: null, targetUsers: 100, chestMinInvites: 1, chestMaxInvites: 5, chestBaseA9Raw: '300000000000', chestStepA9Raw: '0' },
        stats: { totalRegistered: 3 },
        myReservation: { status: 'ACTIVE', validInvites: 0, remindEnabled: false },
        myWarmupChest: { chestId: 'ch_2', status: 'LOCKED', currentAssists: 0, requiredAssists: 1 },
      },
    };
    let currentKey = 'r7Unreserved';
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: payloads[currentKey] }) });

    const { mountWarmupSection } = await import(JS_URL + '/pages/warmup_market.js');
    const mountAndWait = async (key) => {
      currentKey = key;
      const root = makeRoot();
      mountWarmupSection(root, { query: {} });
      await new Promise((r) => setTimeout(r, 30));
      return root.innerHTML;
    };

    const htmlUnreserved = await mountAndWait('r7Unreserved');
    const htmlReadyRo = await mountAndWait('r7ReadyReadonly');
    const htmlBad = await mountAndWait('badConfig');
    console.log(JSON.stringify({ htmlUnreserved, htmlReadyRo, htmlBad }));
  `);

  // 1) 第 7 轮 1–5 人 = 300 / 400 / 500 / 600 / 700 A9
  for (const [inv, amt] of [[1, '300'], [2, '400'], [3, '500'], [4, '600'], [5, '700']]) {
    assert.ok(res.htmlUnreserved.includes(`${inv} 人`), `missing tier ${inv}`);
    assert.ok(res.htmlUnreserved.includes(`${amt} A9`), `missing tier reward ${amt} A9`);
  }
  assert.ok(res.htmlUnreserved.includes('有效好友 0 / 5'));
  assert.ok(!res.htmlUnreserved.includes('0/0'), 'must not render duplicate 0/0 counter');
  assert.ok(res.htmlUnreserved.includes('待公布 · 开启提醒'));
  assert.ok(res.htmlUnreserved.includes('<details class="rewards-secondary-fold" id="warmup-intent-fold">'));
  assert.ok(res.htmlUnreserved.includes('<details class="rewards-secondary-fold" id="warmup-rules-fold">'));
  assert.equal((res.htmlUnreserved.match(/btn btn-primary/g) || []).length, 1);

  // 2) 达标但只读/总闸关：显示原因文字，不放灰按钮
  assert.ok(res.htmlReadyRo.includes('id="warmup-open-gate-note"'));
  assert.ok(!res.htmlReadyRo.includes('id="btn-open-warmup-chest"'), 'must not render disabled grey placeholder button when gate is off');
  assert.equal((res.htmlReadyRo.match(/btn btn-primary/g) || []).length, 0);

  // 3) 非单调阶梯：显示「配置待确认」（且不重复堆砌 3 遍）；已预约未达标主按钮为「邀请好友」且仅 1 个
  assert.ok(res.htmlBad.includes('id="warmup-ladder-pending"') && res.htmlBad.includes('配置待确认'));
  assert.equal((res.htmlBad.match(/配置待确认/g) || []).length, 1, '配置待确认 should appear once cleanly');
  assert.ok(res.htmlBad.includes('id="btn-share-warmup"') && res.htmlBad.includes('邀请好友'));
  assert.equal((res.htmlBad.match(/btn btn-primary/g) || []).length, 1);
});

test('P4: 端到端走 fetchWarmupCurrent 验证防假零、防 2-5 静默回落、失败态禁预约与达标开箱主按钮', () => {
  // 1) chestMinInvites=0 / 缺失 stats.totalRegistered / 请求失败态
  const resErr = runWarmupScenario({ lang: 'zh', mode: 'live', liveFundsEnabled: false, openEnabled: false }, `
    let mode = 'badMinAndMissingStats';
    globalThis.fetch = async () => {
      if (mode === 'networkErr') throw new Error('503 unavailable');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            roundId: 7,
            open: true,
            config: { roundId: 7, plannedOpenAt: null, targetUsers: 100, chestMinInvites: 0, chestMaxInvites: 5, chestBaseA9Raw: '300000000000', chestStepA9Raw: '100000000000' },
            stats: {},
            myReservation: null,
            myWarmupChest: null,
          },
        }),
      };
    };

    const { mountWarmupSection } = await import(JS_URL + '/pages/warmup_market.js');
    const r1 = makeRoot();
    mountWarmupSection(r1, { query: {} });
    await new Promise((r) => setTimeout(r, 30));

    mode = 'networkErr';
    const r2 = makeRoot();
    mountWarmupSection(r2, { query: {} });
    await new Promise((r) => setTimeout(r, 30));

    console.log(JSON.stringify({ badMinHtml: r1.innerHTML, failHtml: r2.innerHTML }));
  `);

  assert.ok(resErr.badMinHtml.includes('id="warmup-ladder-pending"') && resErr.badMinHtml.includes('配置待确认'), 'chestMinInvites=0 must NOT silently fall back to 2-5 ladder');
  assert.ok(!resErr.badMinHtml.includes('0 <span class="num-md text-sec">人</span>'), 'missing stats.totalRegistered must render — rather than 0 人');
  assert.ok(!resErr.failHtml.includes('id="btn-register-warmup"'), 'failed fetch must NOT render Reserve primary button');
  assert.ok(!resErr.failHtml.includes('第 1 轮开局预热'), 'failed fetch with unknown round must NOT fabricate Round 1');
  assert.ok(resErr.failHtml.includes('下轮开局预热') && resErr.failHtml.includes('sw-menu-error'));

  // 2) 达标 + 实盘与开箱总闸同时打开 → 唯一主按钮「开箱」
  const resOpen = runWarmupScenario({ lang: 'zh', mode: 'live', liveFundsEnabled: true, openEnabled: true }, `
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: {
          roundId: 7,
          open: true,
          config: { roundId: 7, plannedOpenAt: null, targetUsers: 100, chestMinInvites: 1, chestMaxInvites: 5, chestBaseA9Raw: '300000000000', chestStepA9Raw: '100000000000' },
          stats: { totalRegistered: 12 },
          myReservation: { status: 'ACTIVE', validInvites: 2, remindEnabled: true },
          myWarmupChest: { chestId: 'ch_ok', status: 'READY', currentAssists: 2, requiredAssists: 1, baseA9Raw: '300000000000', boostA9Raw: '100000000000' },
        },
      }),
    });
    const { mountWarmupSection } = await import(JS_URL + '/pages/warmup_market.js');
    const r = makeRoot();
    mountWarmupSection(r, { query: {} });
    await new Promise((r) => setTimeout(r, 30));
    console.log(JSON.stringify({ html: r.innerHTML }));
  `);
  assert.ok(resOpen.html.includes('id="btn-open-warmup-chest"') && resOpen.html.includes('开箱'));
  assert.equal((resOpen.html.match(/btn btn-primary/g) || []).length, 1);
});

