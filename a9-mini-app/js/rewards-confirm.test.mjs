import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const JS_DIR = dirname(fileURLToPath(import.meta.url));
const JS_URL = pathToFileURL(JS_DIR).href;

function runRewardsScenario({ lang = 'zh', mode = 'demo', profileMode = 'active', liveFundsEnabled = false }, body) {
  const fullLang = lang === 'en' ? 'en-US' : 'zh-CN';
  const runner = `
    const storageMap = new Map([['a9_ui_prefs_v1', JSON.stringify({ settings: { language: ${JSON.stringify(fullLang)} }, user: { profileMode: ${JSON.stringify(profileMode)} } })]]);
    let lastModalHtml = '';
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
      focus() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    });
    const modalRoot = makeEl();
    Object.defineProperty(modalRoot, 'innerHTML', {
      get() { return lastModalHtml; },
      set(v) { lastModalHtml = String(v); },
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
      location: { href: 'https://app.example.invalid/?mode=' + ${JSON.stringify(mode)}, origin: 'https://app.example.invalid', search: '?mode=' + ${JSON.stringify(mode)}, hash: '#/rewards' },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
    };
    globalThis.document = {
      documentElement: { dataset: { theme: 'light' }, lang: ${JSON.stringify(fullLang)} },
      body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
      activeElement: null,
      addEventListener() {},
      removeEventListener() {},
      createElement: () => makeEl(),
      getElementById: (id) => (id === 'modal-root' ? modalRoot : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const JS_URL = ${JSON.stringify(JS_URL)};
    const getLastModalHtml = () => lastModalHtml;
    const makeRoot = () => makeEl();
    ${body}
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', runner], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').at(-1));
}

test('P3: 4 项领取确认层缺任意一项即显示「待确认」并禁用继续按钮', () => {
  const res = runRewardsScenario({ lang: 'zh' }, `
    const { buildClaimConfirmModel } = await import(JS_URL + '/pages/rewards.js');
    const complete = buildClaimConfirmModel({
      claimAmountText: '1,250 A9',
      attachGramText: '0.22 GRAM',
      actualNetworkFeeText: '约 0.04 GRAM',
      refundRuleText: '剩余 GRAM 自动退回钱包',
    });
    const missingAmount = buildClaimConfirmModel({
      claimAmountText: null,
      attachGramText: '0.22 GRAM',
      actualNetworkFeeText: '约 0.04 GRAM',
      refundRuleText: '剩余 GRAM 自动退回钱包',
    });
    const missingAttach = buildClaimConfirmModel({
      claimAmountText: '1,250 A9',
      attachGramText: '',
      actualNetworkFeeText: '约 0.04 GRAM',
      refundRuleText: '剩余 GRAM 自动退回钱包',
    });
    const missingFee = buildClaimConfirmModel({
      claimAmountText: '1,250 A9',
      attachGramText: '0.22 GRAM',
      actualNetworkFeeText: '待确认',
      refundRuleText: '剩余 GRAM 自动退回钱包',
    });
    const missingRefund = buildClaimConfirmModel({
      claimAmountText: '1,250 A9',
      attachGramText: '0.22 GRAM',
      actualNetworkFeeText: '约 0.04 GRAM',
      refundRuleText: undefined,
    });
    console.log(JSON.stringify({ complete, missingAmount, missingAttach, missingFee, missingRefund }));
  `);

  assert.equal(res.complete.canContinue, true);
  assert.deepEqual(res.complete.missingKeys, []);

  assert.equal(res.missingAmount.canContinue, false);
  assert.deepEqual(res.missingAmount.missingKeys, ['claimAmount']);
  assert.equal(res.missingAmount.rows[0].value, '待确认');

  assert.equal(res.missingAttach.canContinue, false);
  assert.deepEqual(res.missingAttach.missingKeys, ['attachGram']);
  assert.equal(res.missingAttach.rows[1].value, '待确认');

  assert.equal(res.missingFee.canContinue, false);
  assert.deepEqual(res.missingFee.missingKeys, ['actualNetworkFee']);
  assert.equal(res.missingFee.rows[2].value, '待确认');

  assert.equal(res.missingRefund.canContinue, false);
  assert.deepEqual(res.missingRefund.missingKeys, ['refundRule']);
  assert.equal(res.missingRefund.rows[3].value, '待确认');
});

test('P3: 我的奖励首屏无 0.22/0.34/0.06 GRAM 费用行、无工程旧术语、可领整行主值、含推广与零奖励引导', () => {
  const res = runRewardsScenario({ lang: 'zh', mode: 'demo', profileMode: 'active' }, `
    const { store } = await import(JS_URL + '/store.js');
    await store.ensureDemoReady();
    store.update((s) => {
      s.user.profileMode = 'active';
      s.user.a9Claimable = 1234567;
      s.user.promoClaimableA9 = 8800;
      s.user.a9Locked = 450000;
      s.prediction.pendingActivationRaw = '500000000000';
      s.certificates = [
        { id: 'demo-cert-6', round: 6, status: 'passed', stakeTon: 50000 },
      ];
    });
    const { renderMyRewardsPage } = await import(JS_URL + '/pages/rewards.js');
    const rootActive = makeRoot();
    renderMyRewardsPage(rootActive);

    store.update((s) => { s.user.profileMode = 'empty'; });
    const rootEmpty = makeRoot();
    renderMyRewardsPage(rootEmpty);
    console.log(JSON.stringify({ activeHtml: rootActive.innerHTML, emptyHtml: rootEmpty.innerHTML }));
  `);

  // 1) 首屏零 GRAM 费用行（只在确认层弹）
  for (const fee of ['0.22 GRAM', '0.34 GRAM', '0.06 GRAM']) {
    assert.ok(!res.activeHtml.includes(fee), `First screen must not display ${fee}`);
  }
  // 2) 术语替换彻底干净
  for (const oldTerm of ['StakeTicket', 'AbortRound', 'v17.0 链上验真', '链上凭证列表']) {
    assert.ok(!res.activeHtml.includes(oldTerm), `Rewards view must not contain ${oldTerm}`);
  }
  assert.ok(res.activeHtml.includes('我的奖励记录'));
  assert.ok(res.activeHtml.includes('查看合约地址'));
  assert.ok(res.activeHtml.includes('轮次异常 7 天后可无损取回本金'));
  assert.ok(res.activeHtml.includes('网络手续费（多退）'));
  assert.ok(res.activeHtml.includes('30% 秒提 + 70% 销毁'));
  // 3) 整行可领大数字完整展示不缩写 + 推广奖励
  assert.ok(res.activeHtml.includes('1,243,367 A9'));
  assert.ok(res.activeHtml.includes('待激活'));
  assert.ok(res.activeHtml.includes('解锁中（14 天）'));
  assert.ok(res.activeHtml.includes('推广奖励（6% 商城 + 8% 通关）'));
  // 4) 单屏 btn-primary <= 1
  const activePrimaryCount = (res.activeHtml.match(/btn btn-primary/g) || []).length;
  assert.ok(activePrimaryCount <= 1, `Active rewards page must have <= 1 btn-primary, got ${activePrimaryCount}`);

  // 5) 零奖励引导包含「去闯关」「宝箱商城」且 btn-primary <= 1
  assert.ok(res.emptyHtml.includes('rewards-zero-guide'));
  assert.ok(res.emptyHtml.includes('去闯关') && res.emptyHtml.includes('href="#/round"'));
  assert.ok(res.emptyHtml.includes('宝箱商城') && res.emptyHtml.includes('href="#/market"'));
  const emptyPrimaryCount = (res.emptyHtml.match(/btn btn-primary/g) || []).length;
  assert.ok(emptyPrimaryCount <= 1, `Empty rewards page must have <= 1 btn-primary, got ${emptyPrimaryCount}`);
});

test('P3: 战队页不再提供推广领取入口，改为链向 #/rewards', () => {
  const teamSrc = readFileSync(join(JS_DIR, 'pages/team.js'), 'utf8');
  assert.ok(!teamSrc.includes('btn-claim-promo-hot'), 'team.js must no longer render promo claim button');
  assert.ok(teamSrc.includes('href="#/rewards"'), 'team.js must link referral summary to #/rewards');
});

test('P3: Live 链上不可用（ticketsAvailable=false / claimableRaw=null）绝不显示假 0 或误弹零奖励引导', () => {
  const res = runRewardsScenario({ lang: 'zh', mode: 'live', liveFundsEnabled: true }, `
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/user/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            data: {
              walletAddress: '0:' + '11'.repeat(32),
              tickets: [],
              ticketsAvailable: false,
              claimableRaw: null,
              lockedRaw: null,
            },
          }),
        };
      }
      if (u.includes('/api/promo/balance')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, data: { claimableRaw: '0', totalClaimedRaw: '0' } }),
        };
      }
      throw new Error('unexpected url: ' + u);
    };

    const { store } = await import(JS_URL + '/store.js');
    store.update((s) => {
      s.user.connected = true;
      s.user.address = '0:' + '11'.repeat(32);
    });
    const { renderMyRewardsPage } = await import(JS_URL + '/pages/rewards.js');
    const root = makeRoot();
    renderMyRewardsPage(root);
    await new Promise((r) => setTimeout(r, 40));
    console.log(JSON.stringify({ html: root.innerHTML }));
  `);

  assert.ok(res.html.includes('id="rewards-claimable-hero">暂不可用</div>'), 'claimable hero must show 暂不可用, never 0 A9');
  assert.ok(!res.html.includes('id="rewards-claimable-hero">0 A9'), 'claimable hero must never fake 0 A9');
  assert.ok(!res.html.includes('rewards-zero-guide'), 'must not show zero-reward guide when on-chain data is unavailable');
  assert.ok(res.html.includes('sw-menu-error'), 'must render retry error banner');
  assert.ok(res.html.includes('链上奖励数据暂不可用'), 'must explain ticketsAvailable=false error');
  assert.ok(!res.html.includes('当前暂无轮次奖励记录'), 'must not claim empty records on fetch failure');
  // 未提供 uid 时「待激活」保持 — 而不是假 0
  assert.ok(!res.html.includes('<span class="num-xs text-muted">待激活</span>\n              <strong class="mono rewards-stat-val">0 A9</strong>'));
});

