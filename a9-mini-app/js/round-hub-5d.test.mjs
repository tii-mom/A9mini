import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const JS_DIR = dirname(fileURLToPath(import.meta.url));
const JS_URL = pathToFileURL(JS_DIR).href;

function runInSandbox(code) {
  const bootstrap = `
    const storageMap = new Map([['a9_ui_prefs_v1', JSON.stringify({ settings: { language: 'zh-CN', themeMode: 'light' } })]]);
    const makeEl = (withChildStub = false) => {
      const el = {
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
        replaceWith() {},
        remove() {},
        querySelector() { return withChildStub ? makeEl(true) : null; },
        querySelectorAll() { return []; },
      };
      return el;
    };
    globalThis.localStorage = {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
    };
    globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
    globalThis.window = {
      __A9_CONFIG__: { mode: 'live', network: 'testnet', apiBase: 'https://api.example.invalid', liveFundsEnabled: false },
      location: { href: 'https://app.example.invalid/?mode=live', origin: 'https://app.example.invalid', search: '?mode=live', hash: '#/round' },
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
    ${code}
  `;
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', bootstrap], { encoding: 'utf8' });
  return JSON.parse(raw.trim().split('\n').at(-1));
}

test('5d: 闯关时间轴与服务端阶段一致、支持 ?stage=warmup / ?stage=charge 定位且忽略 ?panel=prediction，不渲染预言/空投/喊单卡', () => {
  const out = runInSandbox(`
    const { store } = await import(${JSON.stringify(JS_URL)} + '/store.js');
    const { renderChallengeHome } = await import(${JSON.stringify(JS_URL)} + '/pages/round_hub.js');
    const nowSec = Math.floor(Date.now() / 1000);
    store.update((s) => {
      s.round.currentRound = 6;
      s.round.rawState = 'OBSERVING';
      s.round.observationEndAt = nowSec + 7200;
      s.round.targetPrice = 0.0046;
      s.round.livePrice = 0.0048;
      s.round.priceValid = true;
      s.round.qualifiedCandles = 5;
      s.round.minQualifiedCandles = 8;
      s.round.candlesSeen = 7;
      s.round.rewardBudgetA9 = 700000000;
      s.round.candles = Array.from({ length: 12 }, (_, i) => ({
        index: i + 1,
        status: i < 7 ? 'closed' : i === 7 ? 'active' : 'pending',
        confirmed: i < 7,
        bull: i < 5 ? true : i < 7 ? false : null,
        p: i < 7 ? 0.0047 : null,
      }));
      s.round.rounds = [
        { roundId: 5, state: 'FAILED_PERMANENT', qualifiedCandles: 3, minQualifiedCandles: 8 },
        { roundId: 6, state: 'OBSERVING', qualifiedCandles: 5, minQualifiedCandles: 8 },
      ];
    });

    const rootCharge = makeEl();
    renderChallengeHome(rootCharge, () => {}, null, { panel: 'prediction' });
    const htmlCharge = rootCharge.innerHTML;

    const rootWarmup = makeEl();
    renderChallengeHome(rootWarmup, () => {}, null, { stage: 'warmup' });
    const htmlWarmup = rootWarmup.innerHTML;

    const rootChargeQuery = makeEl();
    store.update((s) => {
      s.round.rawState = 'SUCCEEDED';
      s.round.qualifiedCandles = 9;
    });
    renderChallengeHome(rootChargeQuery, () => {}, null, { stage: 'charge' });
    const htmlChargeFromSettle = rootChargeQuery.innerHTML;

    console.log(JSON.stringify({ htmlCharge, htmlWarmup, htmlChargeFromSettle }));
  `);

  // 1. 冲价主视图：4 段时间轴高亮 charge 且带绿点、右上角分享图标、内嵌 12 格达标板、仓位挂点、底部 3 个默认折叠区
  assert.ok(out.htmlCharge.includes('id="round-timeline-bar"'));
  assert.match(out.htmlCharge, /aria-selected="true"[^>]*is-selected is-live"[^>]*data-round-timeline="charge"/);
  assert.ok(out.htmlCharge.includes('id="btn-round-share-icon"'));
  assert.ok(out.htmlCharge.includes('id="round-inline-stamp-board"'));
  assert.ok(out.htmlCharge.includes('id="a9-my-round-position-mount"'));
  // 我的本轮仓位严格紧贴主卡，排在内嵌 12 格达标板之前
  assert.ok(out.htmlCharge.indexOf('id="a9-my-round-position-mount"') < out.htmlCharge.indexOf('id="round-inline-stamp-board"'));
  assert.ok(out.htmlCharge.includes('id="round-rules-fold"'));
  assert.ok(out.htmlCharge.includes('id="round-intent-fold"'));
  assert.ok(out.htmlCharge.includes('id="round-history-fold"'));
  // 往期轮次最新在前（第 6 轮在第 5 轮之前）
  assert.ok(out.htmlCharge.indexOf('第 6 轮') < out.htmlCharge.indexOf('第 5 轮'));
  // 不渲染预言、空投、中间喊单卡、旧观察页按钮
  for (const forbidden of ['a9-prediction-card', 'a9-airdrop-draws-card', 'round-rally-card', '#/observation/records', 'a9-round-interact-deck']) {
    assert.ok(!out.htmlCharge.includes(forbidden), `5d quest page must not render ${forbidden}`);
  }
  assert.ok((out.htmlCharge.match(/btn btn-primary/g) || []).length <= 1);

  // 2. ?stage=warmup 深链：高亮预热，挂载 #round-warmup-mount，无旧 renderWarmupStage 四宫格，且避免重复规则折叠
  assert.match(out.htmlWarmup, /aria-selected="true"[^>]*data-round-timeline="warmup"/);
  assert.ok(out.htmlWarmup.includes('id="round-warmup-mount"'));
  assert.ok(!out.htmlWarmup.includes('grid-4'), 'warmup stage must not render legacy renderWarmupStage 4-tile grid');
  assert.ok(!out.htmlWarmup.includes('id="round-rules-fold"'), 'warmup view delegates rules/intent fold to mountWarmupSection');

  // 3. 结算期访问 ?stage=charge（原印章簿深链）：高亮冲价并直接展示内嵌 12 格达标板 + 回到当前阶段按钮
  assert.match(out.htmlChargeFromSettle, /aria-selected="true"[^>]*data-round-timeline="charge"/);
  assert.ok(out.htmlChargeFromSettle.includes('id="round-stage-guide-card"'));
  assert.ok(out.htmlChargeFromSettle.includes('id="round-inline-stamp-board"'));
  assert.ok(out.htmlChargeFromSettle.includes('回到当前阶段'));
});

test('5d: 结算期（通关/未达标/中止）零重复领奖按钮、无卡片套卡片，且锁仓余额不足 < 100 A9 时显示宝箱商城次按钮（未知余额不误判）', () => {
  const out = runInSandbox(`
    const { store } = await import(${JSON.stringify(JS_URL)} + '/store.js');
    const {
      renderSettlementSuccess,
      renderSettlementFailed,
      renderTechnicalHalt,
      renderMyRoundPositionCard,
      renderParticipation,
      renderInlineStampBoard,
    } = await import(${JSON.stringify(JS_URL)} + '/pages/round_stages.js');

    const sampleTicket = {
      roundId: 6,
      ticketAddress: 'EQTicketSampleAddress123',
      amountRaw: '5000000000000',
      earlyAmountRaw: '5000000000000',
      lateAmountRaw: '0',
      claimablePrincipalRaw: '5000000000000',
      claimableRewardRaw: '1200000000000',
      lockedRemainingRaw: '4800000000000',
      claimableTotalRaw: '6200000000000',
    };

    const roundPass = { currentRound: 6, rawState: 'SUCCEEDED', qualifiedCandles: 9, minQualifiedCandles: 8 };
    const passHero = renderSettlementSuccess(roundPass, store.state.user, sampleTicket);
    const passPos = renderMyRoundPositionCard(roundPass, sampleTicket);

    const roundFail = { currentRound: 6, rawState: 'FAILED_PERMANENT', qualifiedCandles: 4, minQualifiedCandles: 8 };
    const failHero = renderSettlementFailed(roundFail, sampleTicket);
    const failPos = renderMyRoundPositionCard(roundFail, sampleTicket);

    const roundAbort = { currentRound: 6, rawState: 'TECHNICAL_ABORTED' };
    const abortHero = renderTechnicalHalt(roundAbort, sampleTicket);
    const abortPos = renderMyRoundPositionCard(roundAbort, sampleTicket);

    // 锁仓期：余额 50 A9 (<100) vs 余额未知 (null)
    const nowSec = Math.floor(Date.now() / 1000);
    const roundStake = {
      currentRound: 7,
      rawState: 'STAKING_OPEN',
      stakeOpenAt: nowSec - 1800,
      stakeCloseAt: nowSec + 72000,
      inFirst6h: true,
      targetPrice: 0.005,
      livePrice: 0.004,
      priceValid: true,
      rewardBudgetA9: 700000000,
    };
    store.update((s) => { s.user.connected = true; s.user.a9Available = 50; });
    const stakeLowBal = renderParticipation(roundStake);
    store.update((s) => { s.user.connected = true; s.user.a9Available = null; s.user.a9Balance = null; });
    const stakeUnknownBal = renderParticipation(roundStake);

    // 未知时段数据防假 0/12（含 candles: [] 但 qualifiedCandles=5 / candlesSeen=7 的矛盾摘要）
    const emptyBoard = renderInlineStampBoard({ currentRound: 7, candles: [], qualifiedCandles: null, candlesSeen: null });
    const partialSummaryBoard = renderInlineStampBoard({ currentRound: 7, candles: [], qualifiedCandles: 5, candlesSeen: 7, candlesConfirmed: 0 });

    console.log(JSON.stringify({
      passCombined: passHero + passPos,
      failCombined: failHero + failPos,
      abortCombined: abortHero + abortPos,
      stakeLowBal,
      stakeUnknownBal,
      emptyBoard,
      partialSummaryBoard,
    }));
  `);

  for (const [label, html] of [
    ['passed', out.passCombined],
    ['failed', out.failCombined],
    ['aborted', out.abortCombined],
  ]) {
    assert.ok(!html.includes('#/claim'), `${label} must not contain legacy #/claim href`);
    const rewardsLinks = html.match(/href="#\/rewards/g) || [];
    assert.equal(rewardsLinks.length, 1, `${label} must have exactly 1 rewards CTA (no duplicate claim/rewards buttons)`);
    assert.equal((html.match(/btn btn-primary/g) || []).length, 1, `${label} must have exactly 1 btn-primary`);
    assert.ok(html.includes('#/proof/EQTicketSampleAddress123'), `${label} position card should link to pass proof`);
    assert.ok(!html.includes('sw-menu-group'), `${label} settlement breakdown must not nest bordered sw-menu-group inside hero card`);
  }

  assert.ok(out.stakeLowBal.includes('id="hero-buy-chest-cta"'), 'stake view with known balance < 100 A9 must offer Chest Mall secondary CTA');
  assert.ok(out.stakeLowBal.includes('href="#/market"'));
  assert.ok((out.stakeLowBal.match(/btn btn-primary/g) || []).length <= 1);
  assert.ok(!out.stakeUnknownBal.includes('id="hero-buy-chest-cta"'), 'stake view with unknown (null) balance must NOT misjudge as < 100 A9');

  assert.ok(out.emptyBoard.includes('—/12'), 'inline stamp board must display —/12 instead of 0/12 when candle data is missing');
  assert.ok(!out.emptyBoard.includes('· 0/12'));
  assert.ok(out.partialSummaryBoard.includes('—/12'), 'inline stamp board must display —/12 when candles array is empty even if qualifiedCandles/candlesSeen are populated');
  assert.ok(!out.partialSummaryBoard.includes('· 0/12'));
});

test('5d: Live 锁仓期通过 /api/user/:wallet 异步回填余额 < 100 A9 显示去宝箱商城次按钮，balanceAvailable=false 时绝不误显', () => {
  const out = runInSandbox(`
    const buySlotLow = makeEl(false);
    buySlotLow.hidden = true;
    const posMountLow = makeEl(false);
    const rootLow = makeEl(false);
    rootLow.querySelector = (sel) => {
      if (sel === '#hero-buy-chest-slot') return buySlotLow;
      if (sel === '#a9-my-round-position-mount') return posMountLow;
      return null;
    };

    const buySlotUnavailable = makeEl(false);
    buySlotUnavailable.hidden = true;
    const posMountUnavail = makeEl(false);
    const rootUnavailable = makeEl(false);
    rootUnavailable.querySelector = (sel) => {
      if (sel === '#hero-buy-chest-slot') return buySlotUnavailable;
      if (sel === '#a9-my-round-position-mount') return posMountUnavail;
      return null;
    };

    let mockPortfolio = { balanceAvailable: true, a9BalanceRaw: '0', tickets: [] };
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/user/')) {
        return { ok: true, status: 200, async json() { return { ok: true, data: mockPortfolio, ts: Date.now() }; } };
      }
      return { ok: true, status: 200, async json() { return { ok: true, data: {}, ts: Date.now() }; } };
    };

    const { store } = await import(${JSON.stringify(JS_URL)} + '/store.js');
    const { renderChallengeHome } = await import(${JSON.stringify(JS_URL)} + '/pages/round_hub.js');
    const nowSec = Math.floor(Date.now() / 1000);
    store.update((s) => {
      s.user.connected = true;
      s.user.address = 'EQLiveWalletUnder100';
      s.user.a9Available = null;
      s.round.currentRound = 7;
      s.round.rawState = 'STAKING_OPEN';
      s.round.stakeOpenAt = nowSec - 600;
      s.round.stakeCloseAt = nowSec + 72000;
      s.round.inFirst6h = true;
      s.round.rewardBudgetA9 = 700000000;
    });

    renderChallengeHome(rootLow, () => {}, null, {});
    await new Promise((r) => setTimeout(r, 30));

    mockPortfolio = { balanceAvailable: false, a9BalanceRaw: null, tickets: [] };
    renderChallengeHome(rootUnavailable, () => {}, null, {});
    await new Promise((r) => setTimeout(r, 30));

    console.log(JSON.stringify({
      lowHidden: buySlotLow.hidden,
      lowHtml: buySlotLow.innerHTML,
      unavailHidden: buySlotUnavailable.hidden,
      unavailHtml: buySlotUnavailable.innerHTML,
    }));
  `);

  assert.equal(out.lowHidden, false, 'Live portfolio balanceAvailable=true & 0 A9 must reveal #hero-buy-chest-slot');
  assert.ok(out.lowHtml.includes('id="hero-buy-chest-cta"'));
  assert.ok(out.lowHtml.includes('href="#/market"'));
  assert.equal(out.unavailHidden, true, 'Live portfolio balanceAvailable=false must keep #hero-buy-chest-slot hidden');
  assert.equal(out.unavailHtml, '');
});
