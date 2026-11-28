/**
 * A9 Quest 视图层回归测试（v2.0）
 * 覆盖：
 * 1. 冲关（stage-view.js）：9 态轮次完整渲染、8/12 冲价中严禁提前显示「已通关」、倒计时 <= 0 不显示 00:00:00、缺值 null 不伪造 0
 * 2. 金库（vault-view.js）：单票据领取/急提严格按单张签名、急提双口径（30%→100% 与 44%→100%，本金 100% 不打折）
 * 3. 宝箱（chest-view.js）：双独立开关（presaleHotWallet.open 与 chestMall.openEnabled）、Live 缺 SKU 绝不回退演示数据
 * 4. 战队（team-view.js）：P2 诚实策略（6 独立额度桶静态硬顶 550,000,000 A9，零假剩余进度条）
 * 5. 全局红线：quest 视图代码与 quest.css 零禁用词、零 Emoji、零静态导入 demo-data.js、零 font-size < 11px
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const JS_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(JS_DIR, '..');

function setupBrowserStubs(mode = 'live', liveFundsEnabled = false) {
  const storage = new Map([['a9_ui_prefs_v1', JSON.stringify({ settings: { language: 'zh-CN', themeMode: 'light' } })]]);
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.window = {
    __A9_CONFIG__: { mode, network: 'testnet', apiBase: 'https://api.example.invalid', liveFundsEnabled },
    location: { href: `https://app.example.invalid/?mode=${mode}`, origin: 'https://app.example.invalid', search: `?mode=${mode}`, hash: '#/round' },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    scrollTo() {},
  };
  globalThis.document = {
    documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' },
    body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
    addEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ className: '', style: {}, setAttribute() {}, remove() {}, querySelector: () => null }),
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return { ok: true, data: {}, ts: Date.now() }; } });
}

function makeRoot() {
  return {
    isConnected: true,
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

test('quest-ui: stage-view covers all 9 canonical stages, blocks premature 通关 at 8/12 charge, and guards null/zero countdown', async () => {
  setupBrowserStubs('live', false);
  const { store } = await import('./store.js');
  const { renderStageView, buildChargeFlagStatusText } = await import('./quest/stage-view.js');

  const nowSec = Math.floor(Date.now() / 1000);
  const cases = [
    { rawState: 'UNOPENED', expectStage: 'warmup', extra: { stakeOpenAt: nowSec + 3600 } },
    { rawState: 'STAKING_OPEN', expectStage: 'stake', extra: { stakeOpenAt: nowSec - 600, stakeCloseAt: nowSec + 80000, earlyCloseAt: nowSec + 21000, inFirst6h: true } },
    { rawState: 'STAKING_CLOSED', expectStage: 'sealed', extra: {} },
    { rawState: 'OBSERVING', expectStage: 'charge', extra: { observationEndAt: nowSec + 7200, qualifiedCandles: 8, minQualifiedCandles: 8 } },
    { rawState: 'SETTLING_SUCCESS', expectStage: 'settling', extra: {} },
    { rawState: 'SUCCEEDED', expectStage: 'passed', extra: { qualifiedCandles: 9, minQualifiedCandles: 8 } },
    { rawState: 'FAILED_PERMANENT', expectStage: 'failed', extra: { qualifiedCandles: 5, minQualifiedCandles: 8 } },
    { rawState: 'TECHNICAL_ABORTED', expectStage: 'aborted', extra: {} },
    { rawState: null, expectStage: 'unknown', extra: { stage: null, currentRound: null, targetPrice: null, livePrice: null, rewardBudgetA9: null, totalStakedRaw: null } },
  ];

  for (const c of cases) {
    store.update((s) => {
      s.round.currentRound = 6;
      s.round.rawState = c.rawState;
      s.round.stage = null;
      s.round.countdownSec = null;
      s.round.stakeOpenAt = null;
      s.round.stakeCloseAt = null;
      s.round.earlyCloseAt = null;
      s.round.observationEndAt = null;
      s.round.qualifiedCandles = null;
      s.round.minQualifiedCandles = 8;
      Object.assign(s.round, c.extra);
    });
    const root = makeRoot();
    renderStageView(root, () => {});
    assert.ok(root.innerHTML.includes(`data-stage="${c.expectStage}"`), `expected stage ${c.expectStage}`);
    assert.ok(!root.innerHTML.includes('00:00:00'), `stage ${c.expectStage} must never display 00:00:00`);
    if (c.expectStage === 'charge') {
      assert.ok(root.innerHTML.includes('已达 8/12 门槛 · 等待链上结算'), 'charge with 8/12 must show threshold met awaiting settlement');
      assert.ok(!root.innerHTML.includes('已通关'), 'charge stage must NEVER display 已通关');
    }
    if (c.expectStage === 'unknown') {
      assert.ok(!root.innerHTML.includes('$0.0000'), 'null prices must not render as $0.0000');
      assert.ok(root.innerHTML.includes('—'), 'missing values must render —');
    }
  }

  const st = buildChargeFlagStatusText('charge', { qualifiedCandles: 8, minQualifiedCandles: 8, candles: [] });
  assert.equal(st.text, '已达 8/12 门槛 · 等待链上结算');
});

test('quest-ui: vault-view clarifies dual instant-cashout denominators and enforces single-ticket signing', async () => {
  setupBrowserStubs('live', false);
  const { renderVaultView } = await import('./quest/vault-view.js');
  const root = makeRoot();
  renderVaultView(root, () => {});

  assert.ok(root.innerHTML.includes('本金 100%'), 'vault must explicitly state 100% principal is intact');
  assert.ok(root.innerHTML.includes('30%') && root.innerHTML.includes('44%'), 'instant cashout curve must clarify both 80% locked (30%->100%) and total reward (44%->100%) denominators');
  assert.ok(root.innerHTML.includes('0.06 GRAM'), 'vault must expose 0.06 GRAM promo claim entry');

  const vaultSrc = readFileSync(join(JS_DIR, 'quest/vault-view.js'), 'utf8');
  assert.ok(vaultSrc.includes('sendV15TicketClaim(ticket.ticketAddress'), 'vault must sign single ticketAddress per tx');
});

test('quest-ui: chest-view enforces dual independent switches and never falls back to demo SKUs in Live mode', async () => {
  setupBrowserStubs('live', false);
  const { store } = await import('./store.js');
  const { renderInternalMarket, resolveChestMallGates } = await import('./quest/chest-view.js');

  assert.deepEqual(
    resolveChestMallGates({ protocolConfig: { presaleHotWallet: { open: true } }, chestMall: { openEnabled: false } }, false),
    { presaleOpen: true, freeOpenEnabled: false, canBuyPaid: false, canOpenFree: false }
  );
  assert.deepEqual(
    resolveChestMallGates({ protocolConfig: { presaleHotWallet: { open: false } }, chestMall: { openEnabled: true } }, true),
    { presaleOpen: false, freeOpenEnabled: true, canBuyPaid: false, canOpenFree: true }
  );
  assert.deepEqual(
    resolveChestMallGates({ protocolConfig: { presaleHotWallet: { open: true } }, chestMall: { openEnabled: true } }, true),
    { presaleOpen: true, freeOpenEnabled: true, canBuyPaid: true, canOpenFree: true }
  );

  store.update((s) => { s.round.chestMall = null; s.round.protocolConfig = { presaleHotWallet: { open: false } }; });
  const root = makeRoot();
  renderInternalMarket(root, () => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(root.innerHTML.includes('id="live-chest-skus-unavailable"'), 'Live mode missing SKUs must render explicit unavailable card');
  assert.ok(!root.innerHTML.includes('0.99<small>GRAM</small>'), 'Live mode must never fall back to demo SKUs');
});

test('quest-ui: team-view P2 honest strategy renders static 550,000,000 A9 cap rules without fake usage bars, and all quest files obey forbidden-word & CSS guardrails', async () => {
  setupBrowserStubs('live', false);
  const { renderTeamView } = await import('./quest/team-view.js');
  const root = makeRoot();
  renderTeamView(root, () => {});
  assert.ok(root.innerHTML.includes('550,000,000 A9'), 'team view must display static 550,000,000 A9 promo cap');
  assert.ok(root.innerHTML.includes('6 独立额度桶'), 'team view must show 6 independent buckets rule');

  const files = [
    join(JS_DIR, 'quest/quest-ui.js'),
    join(JS_DIR, 'quest/stage-view.js'),
    join(JS_DIR, 'quest/vault-view.js'),
    join(JS_DIR, 'quest/chest-view.js'),
    join(JS_DIR, 'quest/team-view.js'),
    join(APP_DIR, 'css/quest.css'),
  ];
  const forbidden = [
    /十城/, /军饷/, /攻城令/, /主城/, /商会/, /背包/, /主城商行/, /A9 兑换屋/,
    /暴击/, /早鸟/, /Early Bird/, /链上质押/, /自动连闯/, /Auto-Continue/,
    /1 GRAM = 2,002 A9/, /24H 预言/, /观测盘/, /竞猜/, /16\/24/, /\b15x\b/i, /\bNo Liq\b/i, /\b200M\b/, /\b700M\b/,
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const rx of forbidden) {
      assert.doesNotMatch(src, rx, `${f} matched forbidden pattern ${rx}`);
    }
    if (f.endsWith('.js')) {
      assert.doesNotMatch(src, /^\s*import\s+[\s\S]*?from\s+['"][^'"]*demo-data\.js['"]/m, `${f} must not statically import demo-data.js`);
    }
    if (f.endsWith('.css')) {
      assert.doesNotMatch(src, /font-size:\s*(?:[0-9]|10)(?:\.[0-9]+)?px/i, `${f} must keep font-size >= 11px`);
      assert.doesNotMatch(src, /(?:^|[^-])color:\s*var\(--nt-red(?:,|\))/m, `${f} must use --nt-red-ink for red text`);
    }
  }
});

test('additional stake requires a readable ticket and the expected raw amount after signing', async () => {
  const { stakeTicketAmount } = await import('./data.js');
  const snapshot = tickets => ({ ticketsAvailable: true, tickets });
  const old = { roundId: 4, amountRaw: '90071992547409930000' };
  const expected = stakeTicketAmount(snapshot([old]), 4) + 100000000000n;
  assert.notEqual(stakeTicketAmount(snapshot([old]), 4), expected);
  assert.equal(stakeTicketAmount(snapshot([{ ...old, amountRaw: String(expected) }]), 4), expected);
  assert.equal(stakeTicketAmount(snapshot([]), 4), 0n);
  assert.equal(stakeTicketAmount({ ticketsAvailable: false, tickets: [] }, 4), null);
  assert.equal(stakeTicketAmount(snapshot([{ ...old, pending: true }]), 4), null);
});

test('paid chest settlement requires consistent raw amounts and accepts a real zero bonus', async () => {
  const { settledChestAmounts } = await import('./quest/chest-view.js');
  const raw = { baseA9Raw: '90071992547409931234', bonusA9Raw: '0', totalA9Raw: '90071992547409931234' };
  const order = { status: 'COMPLETED', ...raw };
  assert.deepEqual(settledChestAmounts(order), raw);
  assert.equal(settledChestAmounts({ ...order, status: 'PENDING' }), null);
  assert.equal(settledChestAmounts({ ...order, bonusA9Raw: null }), null);
  assert.equal(settledChestAmounts({ ...order, bonusA9Raw: '1' }), null);
});

test('vault advances in whole contract seconds and stops exactly at maturity', async () => {
  const { vestingDeltaRaw } = await import('./quest/vault-view.js');
  const t = { vestingStartAt: 1000, vestingSeconds: 14, vestingPrincipalRaw: '140000000000000000', lockedRemainingRaw: '70000000000000000' };
  assert.equal(vestingDeltaRaw(t, 1007.99), 0n);
  assert.equal(vestingDeltaRaw(t, 1008), 10000000000000000n);
  assert.equal(vestingDeltaRaw(t, 1040), BigInt(t.lockedRemainingRaw));
  assert.equal(vestingDeltaRaw({ ...t, vestingStartAt: null }, 1040), 0n);
});

test('demo early exit and cashout credit once and reconcile with balances', async () => {
  const { demoEarlyExit, demoInstantClaim } = await import('./demo-data.js');
  const state = {
    user: { a9Available: 0, a9Claimable: 30, a9Locked: 100 },
    certificates: [{ round: 2, status: 'observation', stakeTon: 100 }, { round: 2, status: 'observation', stakeTon: 200 }],
    round: { myWeight: 300, myStakeTon: 300, totalStakedTon: 1000 }, ledger: [],
  };
  assert.equal(demoEarlyExit(state, 2), 255);
  assert.equal(demoEarlyExit(state, 2), null);
  assert.equal(state.round.totalStakedTon, 700);
  assert.equal(demoInstantClaim(state), 60);
  assert.equal(demoInstantClaim(state), null);
  assert.equal(state.user.a9Available, 315);
  assert.equal(state.user.a9Locked, 0);
  assert.equal(state.ledger.length, 2);
});
