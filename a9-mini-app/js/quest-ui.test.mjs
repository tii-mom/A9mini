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
    if (c.expectStage === 'stake') {
      assert.match(root.innerHTML, /id="q-toggle-prediction"/);
      assert.match(root.innerHTML, /投票数据待同步/);
      assert.doesNotMatch(root.innerHTML, /达标 50%/);
    } else {
      assert.doesNotMatch(root.innerHTML, /data-q-pred=|id="q-toggle-prediction"/);
    }
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

test('live race chart preserves missing hourly samples and excludes paused provisional prices', async () => {
  setupBrowserStubs();
  const { racePriceChart } = await import('./quest/price-chart.js');
  const round = { rawState: 'OBSERVING', targetPrice: 0.002, candles: [
    { index: 1, status: 'closed', p: 0.001 },
    { index: 2, status: 'unknown', p: null },
    { index: 3, status: 'closed', p: 0.0015 },
    { index: 4, status: 'active', p: 0.0018, progressBps: 5000 },
  ] };
  const active = racePriceChart(round, false);
  assert.match(active, /本时段暂定均价/);
  assert.equal(active.match(/class="q-ch-line"/g)?.length, 1);
  const paused = racePriceChart({ ...round, rawState: 'ORACLE_PAUSED' }, false);
  assert.match(paused, /最近确认均价/);
  assert.match(paused, /判定暂停/);
  assert.doesNotMatch(paused, /0\.00180000|class="q-ch-line"/);
  assert.match(active, /采样周期: 1 小时 \/ 格 · 共 12 格/);
  assert.match(active, /最后有效行情:/);
});

test('race chart and pool preserve USD_E8 and A9 precision and mark missing hours', async () => {
  setupBrowserStubs('live', false);
  const { store } = await import('./store.js');
  const { racePriceChart } = await import('./quest/price-chart.js');
  const { describeCandleSlotDetail, renderStageView } = await import('./quest/stage-view.js');
  const round = {
    rawState: 'OBSERVING',
    targetPrice: 0.00000003,
    candles: [
      { index: 1, status: 'closed', p: 0.00000001, bull: false },
      { index: 2, status: 'unknown', p: null },
      { index: 3, status: 'closed', p: 0.00000005, bull: true },
      { index: 4, status: 'active', p: 0.00000002, progressBps: 5000 },
    ],
  };
  const chart = racePriceChart(round, false);
  assert.match(chart, /q-race-price-axis/);
  assert.match(chart, /\$0\.00000002/);
  assert.match(chart, /\$0\.00000003/);
  assert.equal(chart.match(/class="q-ch-line"/g)?.length, 1);
  assert.doesNotMatch(racePriceChart({ ...round, stale: true }, false), /q-price-active|q-race-key-provisional/);
  assert.equal(describeCandleSlotDetail(round.candles[1], round.targetPrice).tone, 'missing');

  store.update((state) => {
    Object.assign(state.round, round, {
      currentRound: 4,
      observationEndAt: Date.now() + 3_600_000,
      stale: true,
      rewardBudgetRaw: '700000000000000001',
      totalStakedRaw: '100000000001',
    });
  });
  const root = makeRoot();
  renderStageView(root, () => {});
  assert.match(root.innerHTML, /奖池预算 · A9<\/small>\s*<b class="q-num">700,000,000\.000000001<\/b>/);
  assert.match(root.innerHTML, /总锁仓 · A9<\/small>\s*<b class="q-num">100\.000000001<\/b>/);
  assert.match(root.innerHTML, /class="q-flag missing" data-q-flag-idx="4"/);
  root.isConnected = false;
  store.update((state) => { state.round.stale = false; });
});

test('vault & worker preview: 1,000 A9 fixed reward sample on Day 0/7/14, partial claim deduction, mixed First-6H/Standard stop-loss, and Aborted 100% refund', async () => {
  const { computeTicketClaimPreview } = await import('../../worker/src/v15-indexer.mjs');
  const A9 = 1_000_000_000n;
  const settledAt = 1_700_000_000;
  const vestingSeconds = 14 * 86400;
  const roundPassed = {
    status: 2,
    settledAt,
    vestingSeconds,
    immediateBps: 2000,
    totalStakeRaw: String(1000n * A9),
    rewardBudgetRaw: String(1000n * A9),
  };
  const ticketFresh = {
    amountRaw: String(1000n * A9),
    earlyAmountRaw: String(1000n * A9),
    lateAmountRaw: '0',
    principalDone: false,
    immediateClaimed: false,
    lockedClaimedRaw: '0',
    exited: false,
    forfeited: false,
    pending: false,
  };

  // Day 0: principal 1,000 + reward 440 (200 instant + 240 from 800 locked @ 30%), burn 560
  const d0 = computeTicketClaimPreview(ticketFresh, roundPassed, null, settledAt);
  assert.equal(d0.claimablePrincipalRaw, String(1000n * A9));
  assert.equal(d0.claimableRewardRaw, String(200n * A9));
  assert.equal(d0.lockedRemainingRaw, String(800n * A9));
  assert.equal(d0.instantCashoutBonusRaw, String(240n * A9));
  assert.equal(d0.instantCashoutBurnRaw, String(560n * A9));
  assert.equal(BigInt(d0.instantCashoutTotalRaw) - BigInt(d0.claimablePrincipalRaw), 440n * A9);

  // Day 7: principal 1,000 + reward 720 (200 instant + 400 vested + 120 from 400 unvested @ 30% -> 520 of 800 locked), burn 280
  const d7 = computeTicketClaimPreview(ticketFresh, roundPassed, null, settledAt + 7 * 86400);
  assert.equal(d7.claimableRewardRaw, String(600n * A9));
  assert.equal(d7.lockedRemainingRaw, String(400n * A9));
  assert.equal(d7.instantCashoutBonusRaw, String(120n * A9));
  assert.equal(d7.instantCashoutBurnRaw, String(280n * A9));
  assert.equal(BigInt(d7.instantCashoutTotalRaw) - BigInt(d7.claimablePrincipalRaw), 720n * A9);

  // Day 14: principal 1,000 + reward 1,000 (locked part 800), burn 0
  const d14 = computeTicketClaimPreview(ticketFresh, roundPassed, null, settledAt + 14 * 86400);
  assert.equal(d14.claimableRewardRaw, String(1000n * A9));
  assert.equal(d14.lockedRemainingRaw, '0');
  assert.equal(d14.instantCashoutBurnRaw, '0');
  assert.equal(BigInt(d14.instantCashoutTotalRaw) - BigInt(d14.claimablePrincipalRaw), 1000n * A9);

  // Partial already-claimed (principal + instant 200 + 400 vested claimed at Day 7) -> only 400 unvested remains (120 cashout / 280 burn)
  const d7Partial = computeTicketClaimPreview(
    { ...ticketFresh, principalDone: true, immediateClaimed: true, lockedClaimedRaw: String(400n * A9) },
    roundPassed,
    null,
    settledAt + 7 * 86400
  );
  assert.equal(d7Partial.claimablePrincipalRaw, '0');
  assert.equal(d7Partial.claimableRewardRaw, '0');
  assert.equal(d7Partial.lockedRemainingRaw, String(400n * A9));
  assert.equal(d7Partial.instantCashoutTotalRaw, String(120n * A9));
  assert.equal(d7Partial.instantCashoutBurnRaw, String(280n * A9));

  // Mixed First-6H (600 A9 @ 5% SL) + Standard (400 A9 @ 10% SL) failure -> refund 930 A9, burn 70 A9
  const failedMixed = computeTicketClaimPreview(
    { ...ticketFresh, amountRaw: String(1000n * A9), earlyAmountRaw: String(600n * A9), lateAmountRaw: String(400n * A9) },
    { status: 3, stakeCloseAt: settledAt - 43200 },
    null,
    settledAt
  );
  assert.equal(failedMixed.claimablePrincipalRaw, String(930n * A9));
  assert.equal(failedMixed.burnedPrincipalRaw, String(70n * A9));

  // Aborted round -> 100% principal refund, 0 burn
  const aborted = computeTicketClaimPreview(
    { ...ticketFresh, amountRaw: String(1000n * A9), earlyAmountRaw: String(600n * A9), lateAmountRaw: String(400n * A9) },
    { status: 4 },
    null,
    settledAt
  );
  assert.equal(aborted.claimablePrincipalRaw, String(1000n * A9));
  assert.equal(aborted.burnedPrincipalRaw, '0');
});

test('quest-ui: team-view distinguishes captain, member, and none roles with proper TG bind permissions', async () => {
  setupBrowserStubs('live', false);
  const { store } = await import('./store.js');
  const { renderTeamView } = await import('./quest/team-view.js');
  store.update((s) => { s.user.connected = true; s.user.address = 'EQ_TEST_SQUAD_WALLET'; });

  for (const [role, teamPayload, expectMarker] of [
    ['captain', { teamId: 'TM-1', name: 'Alpha Squad', role: 'captain', bindStatus: 'unbound' }, '绑定 / 核验电报群'],
    ['member', { teamId: 'TM-1', name: 'Alpha Squad', role: 'member', bindStatus: 'bound' }, '仅队长可绑定电报群'],
    ['none', null, '创建战队并绑群'],
  ]) {
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      async json() {
        if (String(url).includes('/api/team/')) return { ok: true, data: teamPayload, ts: Date.now() };
        return { ok: true, data: {}, ts: Date.now() };
      },
    });
    const root = makeRoot();
    renderTeamView(root, () => {});
    await new Promise((r) => setTimeout(r, 25));
    assert.ok(root.innerHTML.includes(`data-team-role="${role}"`), `expected role ${role}`);
    assert.ok(root.innerHTML.includes(expectMarker), `role ${role} should render "${expectMarker}"`);
  }
});

test('quest-ui: prototype parity checks (target gap, chest EV, team volume/TG thresholds) and 20x rapid tab-switch stability with zero timer leaks', async () => {
  setupBrowserStubs('live', false);
  const { store } = await import('./store.js');
  const { racePriceChart } = await import('./quest/price-chart.js');
  const { renderStageView } = await import('./quest/stage-view.js');
  const { renderVaultView } = await import('./quest/vault-view.js');
  const { renderInternalMarket } = await import('./quest/chest-view.js');
  const { renderTeamView } = await import('./quest/team-view.js');

  // 1. Target gap in price-chart
  const chartBelow = racePriceChart({
    rawState: 'OBSERVING',
    targetPrice: 0.002,
    candles: [{ index: 1, status: 'closed', p: 0.0018, bull: false }],
  }, false);
  assert.match(chartBelow, /距目标还差 10\.0%/);
  const chartAbove = racePriceChart({
    rawState: 'OBSERVING',
    targetPrice: 0.002,
    candles: [{ index: 1, status: 'closed', p: 0.0022, bull: true }],
  }, false);
  assert.match(chartAbove, /已高于目标 \+10\.0%/);

  // 2. Chest EV chip when critTiers sum to 100%
  store.update((s) => {
    s.round.chestMall = {
      openEnabled: false,
      skus: [{ skuId: 'gold', tier: 'gold', zh: '黄金宝箱', en: 'Gold Chest', priceGram: 29.99, deliveryFeeGram: 0.06, baseA9: 10000, maxBoostA9: 10000 }],
      critTiers: [
        { key: 'base', weight: 75, minRatio: 0.05, maxRatio: 0.12, labelZh: '常规加赠', labelEn: 'Standard' },
        { key: 'high', weight: 20, minRatio: 0.12, maxRatio: 0.30, labelZh: '高额加赠', labelEn: 'High' },
        { key: 'top', weight: 5, minRatio: 0.30, maxRatio: 1.00, labelZh: '顶格加赠', labelEn: 'Top' },
      ],
      freeTiers: [
        { chestId: 'f3', tier: 'gold', labelZh: '黄金战队箱', labelEn: 'Gold Squad Chest', baseA9Raw: '500000000000', requiredAssists: 10, minVolumeNano: '50000000000', minTgMembers: 50, status: 'LOCKED' },
      ],
    };
  });
  const chestRoot = makeRoot();
  renderInternalMarket(chestRoot, () => {});
  await new Promise((r) => setTimeout(r, 15));
  assert.match(chestRoot.innerHTML, /最大加赠额的.*13\.83%/);

  // 3. Team 5-tier ladder renders volume & TG member thresholds
  const teamRoot = makeRoot();
  renderTeamView(teamRoot, () => {});
  assert.match(teamRoot.innerHTML, /战队流水门槛/);
  assert.match(teamRoot.innerHTML, /50 GRAM/);
  assert.match(teamRoot.innerHTML, /认证电报群门槛/);
  assert.match(teamRoot.innerHTML, /50 人/);

  // 4. 20x rapid tab switching across all 4 tabs with interval tracking (zero leaked active timers)
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  const activeTimers = new Set();
  globalThis.setInterval = (fn, ms, ...args) => {
    const id = origSetInterval(fn, ms, ...args);
    activeTimers.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    activeTimers.delete(id);
    return origClearInterval(id);
  };
  try {
    const views = [renderStageView, renderVaultView, renderInternalMarket, renderTeamView];
    let prevRoot = null;
    for (let i = 0; i < 20; i++) {
      if (prevRoot) prevRoot.isConnected = false;
      const root = makeRoot();
      prevRoot = root;
      views[i % views.length](root, () => {});
    }
    if (prevRoot) prevRoot.isConnected = false;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(activeTimers.size, 0, 'rapid 20x tab switching must leave zero lingering intervals');
  } finally {
    for (const id of activeTimers) origClearInterval(id);
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }
});

test('docs/16 #1 & #2: unified BigInt calculation matches Worker on 200/101/100 sample, legacy ticket, >MAX_SAFE_INTEGER, 5x cap, and canEarlyExit=false', async () => {
  setupBrowserStubs('live', false);
  const { store } = await import('./store.js');
  const { calculateStakePreview, formatRoundA9 } = await import('./data.js');
  const { renderStageView } = await import('./quest/stage-view.js');
  const { computeTicketClaimPreview } = await import('../../worker/src/v15-indexer.mjs');
  const A9 = 1_000_000_000n;
  const nowSec = Math.floor(Date.now() / 1000);

  // Mandatory sample: budget=200, S=200, existing H=101 (First-6H), adding A=100 (Standard)
  const view = { rewardBudgetRaw: String(200n * A9), totalStakedRaw: String(200n * A9), stale: false, detailStale: false, detailLoading: false };
  const ticket101 = { ticketAddress: 'EQ_T101', roundId: 7, amountRaw: String(101n * A9), earlyAmountRaw: String(101n * A9), lateAmountRaw: '0', canEarlyExit: false, exited: false };
  const calc = calculateStakePreview({ view, existingTicket: ticket101, addAmountRaw: 100n * A9, inFirst6h: false });

  // Worker independent verification for existing 101 A9
  const wPass101 = computeTicketClaimPreview(ticket101, { status: 2, settledAt: nowSec, totalStakeRaw: String(200n * A9), rewardBudgetRaw: String(200n * A9) }, null, nowSec);
  const wFail101 = computeTicketClaimPreview(ticket101, { status: 3, stakeCloseAt: nowSec - 100 }, null, nowSec);
  assert.equal(calc.existing.winRewardRaw, wPass101.totalRewardRaw);
  assert.equal(formatRoundA9(calc.existing.winRewardRaw), '101 A9');
  assert.equal(calc.existing.failRefundRaw, wFail101.claimablePrincipalRaw);
  assert.equal(calc.existing.failBurnRaw, wFail101.burnedPrincipalRaw);
  assert.equal(formatRoundA9(calc.existing.failRefundRaw), '95.95 A9');
  assert.equal(formatRoundA9(calc.existing.failBurnRaw), '5.05 A9');

  // Combined 201 A9 (101 First-6H + 100 Standard) with S'=300
  const ticket201 = { amountRaw: String(201n * A9), earlyAmountRaw: String(101n * A9), lateAmountRaw: String(100n * A9) };
  const wPass201 = computeTicketClaimPreview(ticket201, { status: 2, settledAt: nowSec, totalStakeRaw: String(300n * A9), rewardBudgetRaw: String(200n * A9) }, null, nowSec);
  const wFail201 = computeTicketClaimPreview(ticket201, { status: 3, stakeCloseAt: nowSec - 100 }, null, nowSec);
  const wExit201 = computeTicketClaimPreview(ticket201, { status: 1, stakeCloseAt: nowSec + 3600 }, null, nowSec);
  assert.equal(calc.combined.winRewardRaw, wPass201.totalRewardRaw);
  assert.equal(formatRoundA9(calc.combined.winRewardRaw), '134 A9');
  assert.equal(formatRoundA9(calc.combined.netRewardDeltaRaw), '33 A9');
  assert.equal(calc.combined.failRefundRaw, wFail201.claimablePrincipalRaw);
  assert.equal(calc.combined.failBurnRaw, wFail201.burnedPrincipalRaw);
  assert.equal(formatRoundA9(calc.combined.failRefundRaw), '185.95 A9');
  assert.equal(formatRoundA9(calc.combined.failBurnRaw), '15.05 A9');
  assert.equal(calc.combined.earlyExitRefundRaw, wExit201.earlyExitRefundRaw);
  assert.equal(formatRoundA9(calc.combined.earlyExitRefundRaw), '170.85 A9');

  // Legacy ticket missing split fields -> treated as Standard 10% (matches Worker)
  const legacyTicket = { amountRaw: String(101n * A9) };
  const calcLegacy = calculateStakePreview({ view, existingTicket: legacyTicket, addAmountRaw: 0n, inFirst6h: false });
  const wFailLegacy = computeTicketClaimPreview(legacyTicket, { status: 3, stakeCloseAt: nowSec - 100 }, null, nowSec);
  assert.equal(calcLegacy.existing.splitSource, 'legacy_standard');
  assert.equal(calcLegacy.existing.failRefundRaw, wFailLegacy.claimablePrincipalRaw);
  assert.equal(formatRoundA9(calcLegacy.existing.failRefundRaw), '90.9 A9');
  assert.equal(formatRoundA9(calcLegacy.existing.failBurnRaw), '10.1 A9');

  // Exceeds JS MAX_SAFE_INTEGER + 5x cap
  const huge = 100_000_000n * A9;
  const cappedCalc = calculateStakePreview({
    view: { rewardBudgetRaw: String(10_000_000_000n * A9), totalStakedRaw: String(huge), stale: false, detailStale: false, detailLoading: false },
    existingTicket: { amountRaw: String(huge), earlyAmountRaw: String(huge), lateAmountRaw: '0' },
    addAmountRaw: 0n,
  });
  assert.equal(cappedCalc.denominators.capHitCurrent, true);
  assert.equal(cappedCalc.existing.winRewardRaw, String(5n * huge));

  // Actual rendered DOM on stage-view: my position shows 101 / 95.95 / 5.05 and respects canEarlyExit=false
  store.update((s) => {
    s.user.connected = true;
    s.user.address = 'EQ_USER_101';
    s.round.currentRound = 7;
    s.round.rawState = 'STAKING_OPEN';
    s.round.stakeOpenAt = nowSec - 25000;
    s.round.earlyCloseAt = nowSec - 3000;
    s.round.stakeCloseAt = nowSec + 50000;
    s.round.inFirst6h = false;
    s.round.rewardBudgetRaw = String(200n * A9);
    s.round.totalStakedRaw = String(200n * A9);
    s.round.stale = false;
    s.round.detailStale = false;
    s.round.detailLoading = false;
  });
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes('/api/user/')) return { ok: true, data: { ticketsAvailable: true, tickets: [ticket101] }, ts: Date.now() };
      return { ok: true, data: {}, ts: Date.now() };
    },
  });
  const stageRoot = makeRoot();
  renderStageView(stageRoot, () => {});
  await new Promise((r) => setTimeout(r, 25));
  assert.match(stageRoot.innerHTML, /\+101 A9/);
  assert.match(stageRoot.innerHTML, /95\.95 A9/);
  assert.match(stageRoot.innerHTML, /5\.05 A9/);
  assert.match(stageRoot.innerHTML, /头矿已结束 · 本次锁入未达标退 90%/);
  assert.doesNotMatch(stageRoot.innerHTML, /id="q-open-early-exit"/, 'server canEarlyExit=false must not be overridden');
});

test('docs/16 #3 & #6: chest-view covers full Worker PRESALE_STATUS enums, recovers PAYOUT_SENT->COMPLETED once, and shows explicit EV denominators across all 6 SKUs', async () => {
  setupBrowserStubs('live', false);
  const { store } = await import('./store.js');
  const { describePresaleOrderStatus, computeSkuExpectedStats, computeChestOddsSummary, renderInternalMarket } = await import('./quest/chest-view.js');
  const { CHEST_MALL_CATALOG, PAID_CHEST_CRIT_TIERS } = await import('../../worker/src/chest-engine.mjs');

  const statuses = ['PENDING_PAYMENT', 'PAYMENT_CONFIRMED', 'PAYOUT_PENDING', 'PAYOUT_SENT', 'PAYOUT_RETRY', 'COMPLETED', 'PAYMENT_EXCEPTION', 'NEEDS_REVIEW', 'REFUND_PENDING', 'REFUND_SENT', 'REFUNDED', 'EXPIRED', 'CANCELLED'];
  for (const st of statuses) {
    const d = describePresaleOrderStatus({ status: st });
    assert.notEqual(d.zh, '状态待核实', `status ${st} must have explicit Chinese label`);
  }

  const bronzeEv = computeSkuExpectedStats(CHEST_MALL_CATALOG.chest_bronze, PAID_CHEST_CRIT_TIERS);
  assert.equal(bronzeEv.valid, true);
  assert.equal(Number(bronzeEv.approxBonusA9.toFixed(1)), 152.5);
  assert.equal(Number(bronzeEv.pctOfMaxBoost.toFixed(2)), 15.25);
  assert.equal(Number(bronzeEv.pctOfBase.toFixed(2)), 10.17);
  for (const sku of Object.values(CHEST_MALL_CATALOG)) {
    const ev = computeSkuExpectedStats(sku, PAID_CHEST_CRIT_TIERS);
    assert.equal(ev.valid, true);
    assert.ok(ev.approxBonusA9 > 0);
  }
  const badOdds = computeChestOddsSummary([{ weight: 50, minRatio: 0, maxRatio: 0.2 }]);
  assert.equal(badOdds.valid, false);
  assert.equal(badOdds.invalidWeight, true);

  store.update((s) => {
    s.user.connected = true;
    s.user.address = 'EQ_CHEST_WALLET';
    s.round.chestMall = { openEnabled: false, skus: Object.values(CHEST_MALL_CATALOG), critTiers: PAID_CHEST_CRIT_TIERS };
  });
  const sampleOrders = [
    { orderId: 'o1', skuId: 'chest_bronze', status: 'PENDING_PAYMENT', baseA9Raw: '1500000000000', bonusA9Raw: '0', totalA9Raw: '1500000000000' },
    { orderId: 'o2', skuId: 'chest_bronze', status: 'PAYMENT_CONFIRMED', baseA9Raw: '1500000000000', bonusA9Raw: '0', totalA9Raw: '1500000000000' },
    { orderId: 'o3', skuId: 'chest_bronze', status: 'PAYOUT_SENT', baseA9Raw: '1500000000000', bonusA9Raw: '0', totalA9Raw: '1500000000000' },
    { orderId: 'o4', skuId: 'chest_bronze', status: 'PAYOUT_RETRY', baseA9Raw: '1500000000000', bonusA9Raw: '0', totalA9Raw: '1500000000000' },
    { orderId: 'o5', skuId: 'chest_bronze', status: 'REFUND_PENDING', refundTonNano: '1020000001', baseA9Raw: '1500000000000', bonusA9Raw: '0', totalA9Raw: '1500000000000' },
    { orderId: 'o6', skuId: 'chest_bronze', status: 'CANCELLED', baseA9Raw: '1500000000000', bonusA9Raw: '0', totalA9Raw: '1500000000000' },
  ];
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes('/api/presale/orders/')) return { ok: true, data: sampleOrders, ts: Date.now() };
      return { ok: true, data: { items: [] }, ts: Date.now() };
    },
  });
  const root = makeRoot();
  renderInternalMarket(root, () => {});
  await new Promise((r) => setTimeout(r, 25));
  root.isConnected = false;
  assert.doesNotMatch(root.innerHTML, /状态待核实/);
  assert.match(root.innerHTML, /id="q-chest-waiting-banner"/);
  assert.match(root.innerHTML, /平均加赠约 <b>152\.5<\/b> A9/);
  assert.match(root.innerHTML, /1\.020000001 GRAM/);
  assert.doesNotMatch(root.innerHTML, /保底约 \+10\.17%/, 'card face stays compact while buy sheet retains full denominator breakdown');
});

test('docs/16 #4: price timestamp stays fixed across two API reads at different times and shows 待同步 when absent', async () => {
  setupBrowserStubs('live', false);
  const { mapV15RoundDetail } = await import('../../worker/src/v15-indexer.mjs');
  const { mapRoundView } = await import('./data.js');
  const { racePriceChart } = await import('./quest/price-chart.js');

  const rawRound = { status: 1, stakeOpenAt: 1700000000, stakeCloseAt: 1700086400, targetPriceUsdE8: '200000', twap24hUsdE8: '180000', rewardBudgetRaw: '1000000000000', totalStakeRaw: '1000000000000' };
  const d1 = mapV15RoundDetail(1, rawRound, [], 1700010000);
  const d2 = mapV15RoundDetail(1, rawRound, [], 1700020000);
  assert.equal(d1.priceSampledAt, null);
  assert.equal(d2.priceSampledAt, null);
  const v1 = mapRoundView({ source: 'api', label: 'Live', fetchedAt: 1700010000000, config: {}, rounds: [], detail: d1 });
  const v2 = mapRoundView({ source: 'api', label: 'Live', fetchedAt: 1700020000000, config: {}, rounds: [], detail: d2 });
  assert.equal(v1.lastValidPriceAt, null);
  assert.equal(v2.lastValidPriceAt, null);
  assert.match(racePriceChart(v1, false), /data-price-time="1">待同步</);
  assert.match(racePriceChart(v2, false), /data-price-time="1">待同步</);

  const sampledRound = { ...rawRound, priceSampledAt: 1700005000 };
  const s1 = mapRoundView({ source: 'api', label: 'Live', fetchedAt: 1700010000000, config: {}, rounds: [], detail: mapV15RoundDetail(1, sampledRound, [], 1700010000) });
  const s2 = mapRoundView({ source: 'api', label: 'Live', fetchedAt: 1700020000000, config: {}, rounds: [], detail: mapV15RoundDetail(1, sampledRound, [], 1700020000) });
  assert.equal(s1.lastValidPriceAt, 1700005000000);
  assert.equal(s2.lastValidPriceAt, 1700005000000);
  assert.notEqual(s1.syncedAt, s2.syncedAt);
});

test('docs/16 #5 & Batch 3: vault tracks immediate+linear claimed (200+100=300) and switches curve ticket; share.js drops hardcoded 700M and respects stake stage', async () => {
  setupBrowserStubs('live', false);
  const { resolveTicketAccounting } = await import('./quest/vault-view.js');
  const { computeTicketClaimPreview } = await import('../../worker/src/v15-indexer.mjs');
  const { store } = await import('./store.js');
  const { buildShareAngles } = await import('./share.js');
  const A9 = 1_000_000_000n;
  const settledAt = 1_700_000_000;

  const ticketPartial = {
    amountRaw: String(1000n * A9),
    immediateClaimed: true,
    lockedClaimedRaw: String(100n * A9),
    principalDone: false,
    exited: false,
    forfeited: false,
    pending: false,
  };
  const preview = computeTicketClaimPreview(
    ticketPartial,
    { status: 2, settledAt, vestingSeconds: 14 * 86400, immediateBps: 2000, totalStakeRaw: String(1000n * A9), rewardBudgetRaw: String(1000n * A9) },
    null,
    settledAt + 7 * 86400
  );
  const acc = resolveTicketAccounting({ ...ticketPartial, ...preview });
  assert.equal(acc.immediateClaimedRaw, String(200n * A9));
  assert.equal(acc.lockedClaimedRaw, String(100n * A9));
  assert.equal(acc.totalRewardClaimedRaw, String(300n * A9));

  const nowSec = Math.floor(Date.now() / 1000);
  store.update((s) => {
    s.round.currentRound = 8;
    s.round.rawState = 'STAKING_OPEN';
    s.round.stakeOpenAt = nowSec - 600;
    s.round.earlyCloseAt = nowSec + 20000;
    s.round.stakeCloseAt = nowSec + 80000;
    s.round.inFirst6h = true;
    s.round.rewardBudgetA9 = 500000;
  });
  const angles = buildShareAngles('round', '8');
  for (const a of angles) {
    assert.doesNotMatch(a.text, /700,000,000/);
    assert.doesNotMatch(a.text, /冲价正在推进中/);
    assert.match(a.text, /500,000 A9/);
  }
});

// =========================================================================
// docs/18 定向退修 5 项回归测试
// =========================================================================

function setupInteractiveDomStubs(mode = 'live', liveFundsEnabled = false) {
  setupBrowserStubs(mode, liveFundsEnabled);
  const byId = new Map();
  const makeEl = (id = '', extra = {}) => {
    const el = {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      className: '',
      disabled: false,
      isConnected: true,
      dataset: {},
      style: { setProperty() {} },
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      focus() {},
      remove() {
        el.isConnected = false;
        if (el.id && byId.get(el.id) === el) byId.delete(el.id);
      },
      querySelector: (sel) => (sel.startsWith('#') ? (byId.get(sel.slice(1)) || null) : null),
      querySelectorAll: () => [],
      ...extra,
    };
    if (id) byId.set(id, el);
    return el;
  };
  const modalRoot = makeEl('modal-root');
  const theaterLog = [];
  globalThis.document.getElementById = (id) => byId.get(id) || null;
  globalThis.document.querySelector = (sel) => (sel.startsWith('#') ? (byId.get(sel.slice(1)) || null) : null);
  globalThis.document.querySelectorAll = () => [];
  globalThis.document.removeEventListener = () => {};
  globalThis.document.createElement = () => makeEl('');
  globalThis.document.body.appendChild = (el) => {
    el.isConnected = true;
    if (el.id) byId.set(el.id, el);
    if (el.id === 'q-chest-theater') {
      const closeBtn = makeEl('q-theater-close');
      el.querySelector = (sel) => (sel === '#q-theater-close' ? closeBtn : null);
      theaterLog.push({ html: el.innerHTML, el, closeBtn });
    }
    return el;
  };
  return { byId, makeEl, modalRoot, theaterLog };
}

test('docs/18 #1 [P0]: Vault & Worker separate settledQuota, actualReceived, and burnedLocked across Day-0 cashout, partial-then-cashout, and full maturity', async () => {
  setupBrowserStubs('live', false);
  const { computeTicketClaimPreview } = await import('../../worker/src/v15-indexer.mjs');
  const { resolveTicketAccounting, renderVaultView } = await import('./quest/vault-view.js');
  const { store } = await import('./store.js');
  const A9 = 1_000_000_000n;
  const settledAt = 1_700_000_000;
  const roundPassed = {
    status: 2,
    settledAt,
    vestingSeconds: 14 * 86400,
    immediateBps: 2000,
    totalStakeRaw: String(1000n * A9),
    rewardBudgetRaw: String(1000n * A9),
  };

  // Case 1A: Day-0 instant cashout (1,000 A9 total; contract marks immediateClaimed=true, lockedClaimed=800, forfeited=true) WITHOUT historical event
  const day0Raw = {
    ticketAddress: 'EQ_DAY0_UNKNOWN',
    roundId: 1,
    roundState: 'SUCCEEDED',
    amountRaw: String(1000n * A9),
    principalDone: true,
    immediateClaimed: true,
    lockedClaimedRaw: String(800n * A9),
    exited: false,
    forfeited: true,
    pending: false,
  };
  const wDay0Unknown = computeTicketClaimPreview(day0Raw, roundPassed, null, settledAt + 3600);
  assert.equal(wDay0Unknown.settledQuotaTotalRaw, String(1000n * A9));
  assert.equal(wDay0Unknown.actualRewardReceivedRaw, null);
  assert.equal(wDay0Unknown.totalRewardClaimedRaw, null);
  assert.equal(wDay0Unknown.burnedLockedRaw, null);
  assert.equal(wDay0Unknown.historicalCashoutUnknown, true);
  const vDay0Unknown = resolveTicketAccounting({ ...day0Raw, ...wDay0Unknown });
  assert.equal(vDay0Unknown.settledQuotaTotalRaw, String(1000n * A9));
  assert.equal(vDay0Unknown.actualRewardReceivedRaw, null);
  assert.equal(vDay0Unknown.burnedLockedRaw, null);
  assert.equal(vDay0Unknown.historicalCashoutUnknown, true);

  // Case 1B: Day-0 instant cashout WITH trusted historical event (burned 560 -> actual 440)
  const day0WithEvent = { ...day0Raw, ticketAddress: 'EQ_DAY0_EVENT', cashoutBurnedRaw: String(560n * A9) };
  const wDay0Event = computeTicketClaimPreview(day0WithEvent, roundPassed, null, settledAt + 3600);
  assert.equal(wDay0Event.settledQuotaTotalRaw, String(1000n * A9));
  assert.equal(wDay0Event.actualRewardReceivedRaw, String(440n * A9));
  assert.equal(wDay0Event.burnedLockedRaw, String(560n * A9));
  assert.equal(wDay0Event.historicalCashoutUnknown, false);
  const vDay0Event = resolveTicketAccounting({ ...day0WithEvent, ...wDay0Event });
  assert.equal(vDay0Event.actualRewardReceivedRaw, String(440n * A9));
  assert.equal(vDay0Event.burnedLockedRaw, String(560n * A9));

  // Case 2: Partial claim (200 imm + 100 lin) then cashout remaining 700 (burned 490 -> actual 510)
  const partialCashoutNoEv = { ...day0Raw, ticketAddress: 'EQ_PARTIAL_NOEV', lockedClaimedRaw: String(800n * A9) };
  const wPartialNoEv = computeTicketClaimPreview(partialCashoutNoEv, roundPassed, null, settledAt + 5 * 86400);
  assert.equal(wPartialNoEv.historicalCashoutUnknown, true);
  assert.equal(wPartialNoEv.actualRewardReceivedRaw, null);
  const partialCashoutEv = { ...partialCashoutNoEv, ticketAddress: 'EQ_PARTIAL_EV', cashoutBurnedRaw: String(490n * A9) };
  const wPartialEv = computeTicketClaimPreview(partialCashoutEv, roundPassed, null, settledAt + 5 * 86400);
  assert.equal(wPartialEv.settledQuotaTotalRaw, String(1000n * A9));
  assert.equal(wPartialEv.actualRewardReceivedRaw, String(510n * A9));
  assert.equal(wPartialEv.burnedLockedRaw, String(490n * A9));
  assert.equal(wPartialEv.historicalCashoutUnknown, false);

  // Case 3: Normal maturity claim (forfeited=false, 200 imm + 800 lin = 1,000 actual, 0 burned)
  const normalRaw = { ...day0Raw, ticketAddress: 'EQ_NORMAL_1000', roundId: 3, forfeited: false };
  const wNormal = computeTicketClaimPreview(normalRaw, roundPassed, null, settledAt + 14 * 86400);
  assert.equal(wNormal.settledQuotaTotalRaw, String(1000n * A9));
  assert.equal(wNormal.actualRewardReceivedRaw, String(1000n * A9));
  assert.equal(wNormal.burnedLockedRaw, '0');
  assert.equal(wNormal.historicalCashoutUnknown, false);

  // Rendered Vault DOM check: never displays "实际累计已领: 1,000 A9" on forfeited Day-0 ticket
  store.update((s) => { s.user.connected = true; s.user.address = 'EQ_VAULT_ACCT'; });
  const ticketsForDom = [
    { ...day0Raw, ...wDay0Unknown },
    { ...day0WithEvent, roundId: 2, ...wDay0Event },
    { ...normalRaw, ...wNormal },
  ];
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes('/api/user/')) return { ok: true, data: { ticketsAvailable: true, claimableRaw: '0', lockedRaw: '0', tickets: ticketsForDom }, ts: Date.now() };
      return { ok: true, data: { claimableRaw: '0' }, ts: Date.now() };
    },
  });
  const root = makeRoot();
  renderVaultView(root, () => {});
  await new Promise((r) => setTimeout(r, 25));
  root.isConnected = false;
  assert.match(root.innerHTML, /<dt>已结清额度<\/dt><dd>1,000 A9<\/dd>/);
  assert.match(root.innerHTML, /<dt>实际到账<\/dt><dd>待核验<\/dd>/);
  assert.match(root.innerHTML, /<dt>实际到账<\/dt><dd>440 A9<\/dd>/);
  assert.match(root.innerHTML, /<dt>已销毁<\/dt><dd>560 A9<\/dd>/);
  assert.match(root.innerHTML, /<dt>实际累计已领<\/dt><dd>1,000 A9<\/dd>/);
});

test('docs/18 #2 [P1]: Crossing First-6H cutoff while final confirm modal is open blocks stake, updates 10,000 A9 bill (9,500->9,000 / 500->1,000), and requires re-confirm in Demo & Live', async () => {
  const { byId, makeEl } = setupInteractiveDomStubs('live', true);
  const { store } = await import('./store.js');
  const { tonConnect } = await import('./tonconnect.js');
  const { pendingTxManager } = await import('./tx-ux.js');
  const { demoFundsStake } = await import('./demo-data.js');
  const { renderStageView } = await import('./quest/stage-view.js');
  const origConfirm = tonConnect.confirmBeforeSign;
  const origSendStake = tonConnect.sendV15StakeA9;
  const origFundsDesc = Object.getOwnPropertyDescriptor(store, 'fundsEnabled');

  try {
    Object.defineProperty(store, 'fundsEnabled', { get: () => true, configurable: true });
    const nowSec = Math.floor(Date.now() / 1000);

    // --- Part A: Live stage-view interactive cutoff crossing with 10,000 A9 ---
    store.update((s) => {
      s.user.connected = true;
      s.user.address = 'EQ_LIVE_CUTOFF';
      s.round.currentRound = 12;
      s.round.rawState = 'STAKING_OPEN';
      s.round.stakeOpenAt = nowSec - 21500;
      s.round.earlyCloseAt = nowSec + 120;
      s.round.stakeCloseAt = nowSec + 60000;
      s.round.inFirst6h = true;
      s.round.rewardBudgetRaw = String(100000n * 1_000_000_000n);
      s.round.totalStakedRaw = String(100000n * 1_000_000_000n);
      s.round.stakingEnabled = true;
      s.round.stale = false;
      s.round.detailStale = false;
      s.round.detailLoading = false;
      s.round.protocolConfig = { contracts: { roundController: 'EQ_RC_TEST' } };
    });
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      async json() {
        if (String(url).includes('/api/user/')) {
          return { ok: true, data: { ticketsAvailable: true, a9BalanceRaw: String(50000n * 1_000_000_000n), jettonWallet: 'EQ_JW_TEST', tickets: [] }, ts: Date.now() };
        }
        return { ok: true, data: {}, ts: Date.now() };
      },
    });

    const inp = makeEl('q-stake-input', { value: '10000' });
    const errEl = makeEl('q-stake-err');
    const submitBtn = makeEl('q-stake-submit');
    const winValEl = makeEl('q-oc-win-val');
    const winSubEl = makeEl('q-oc-win-sub');
    const loseValEl = makeEl('q-oc-lose-val');
    const loseSubEl = makeEl('q-oc-lose-sub');
    const summaryEl = makeEl('q-stake-summary');
    const phaseNoticeEl = makeEl('q-stake-phase-notice');
    const phaseTextEl = makeEl('q-stake-phase-text');
    makeEl('q-stake-phase-badge');
    const openBtn = makeEl('q-open-stake');

    let liveSendCalls = 0;
    tonConnect.sendV15StakeA9 = async () => { liveSendCalls += 1; };
    let liveConfirmCount = 0;
    tonConnect.confirmBeforeSign = async () => {
      liveConfirmCount += 1;
      if (liveConfirmCount === 1) store.state.round.earlyCloseAt = Math.floor(Date.now() / 1000) - 5;
      return true;
    };

    const liveRoot = makeRoot();
    liveRoot.querySelector = (sel) => (sel === '#q-open-stake' ? openBtn : null);
    renderStageView(liveRoot, () => {});
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(typeof openBtn.onclick, 'function');
    openBtn.onclick();
    inp.value = '10000';
    inp.oninput();
    assert.equal(loseValEl.textContent, '退 9,500 A9');
    assert.equal(loseSubEl.textContent, '止损销毁 500 A9');

    // First confirm crosses First-6H cutoff -> blocked (0 sends), bill updates to 9,000 / 1,000
    await submitBtn.onclick();
    assert.equal(liveSendCalls, 0, 'Must NOT send stake when First-6H crosses during final confirm');
    assert.equal(loseValEl.textContent, '退 9,000 A9');
    assert.equal(loseSubEl.textContent, '止损销毁 1,000 A9');
    assert.match(byId.get('modal-root').innerHTML, /id="q-stake-phase-badge">普通 10% 止损/);

    // Re-confirm after reviewing updated bill succeeds once
    await submitBtn.onclick();
    assert.equal(liveSendCalls, 1, 'Calls sendV15StakeA9 once after user re-confirms updated bill');
    pendingTxManager.clear?.();
    liveRoot.isConnected = false;

    // --- Part B: Demo ticket classification after First-6H cutoff ---
    const demoState = {
      user: { a9Available: 50000 },
      round: { currentRound: 12, inFirst6h: true, myWeight: 0, myStakeTon: 0, totalStakedTon: 100000 },
      certificates: [],
      ledger: [],
    };
    const cert = demoFundsStake(demoState, 10000, { inFirst6h: false });
    assert.ok(cert, 'Demo stake succeeds with explicit post-cutoff Standard flag');
    assert.equal(cert.isFirst6h, false, 'Post-cutoff Demo ticket must be Standard (isFirst6h: false)');
    assert.equal(cert.stakeTon, 10000);
    void byId; void errEl; void winValEl; void winSubEl; void summaryEl; void phaseNoticeEl; void phaseTextEl;
  } finally {
    tonConnect.confirmBeforeSign = origConfirm;
    tonConnect.sendV15StakeA9 = origSendStake;
    if (origFundsDesc) Object.defineProperty(store, 'fundsEnabled', origFundsDesc);
    else delete store.fundsEnabled;
  }
});

test('docs/18 #3 [P1]: Multi-order chest recovery continues tracking 2nd PAYOUT_SENT across sequential, reverse, refund, refresh dedup, wallet switch, and unmount', async () => {
  const { theaterLog } = setupInteractiveDomStubs('live', false);
  const waitForTheaters = async (count) => {
    const deadline = performance.now() + 1000;
    while (theaterLog.length < count && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  globalThis.window.__A9_TEST_POLL_MS__ = 15;
  const { store } = await import('./store.js');
  const { renderInternalMarket } = await import('./quest/chest-view.js');
  const { CHEST_MALL_CATALOG, PAID_CHEST_CRIT_TIERS } = await import('../../worker/src/chest-engine.mjs');
  const A9 = 1_000_000_000n;

  store.update((s) => {
    s.user.connected = true;
    s.user.address = 'EQ_MULTI_W1';
    s.round.chestMall = { openEnabled: false, skus: Object.values(CHEST_MALL_CATALOG), critTiers: PAID_CHEST_CRIT_TIERS };
  });

  // Scenario A: Sequential completion (ord_S1 completes first, ord_S2 stays PAYOUT_SENT then completes)
  let seqStep = 0;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes('/api/presale/orders/')) {
        seqStep += 1;
        if (seqStep === 1) {
          return { ok: true, data: [
            { orderId: 'ord_S1', skuId: 'chest_bronze', status: 'PAYOUT_SENT', baseA9Raw: String(1500n * A9), bonusA9Raw: '0', totalA9Raw: String(1500n * A9) },
            { orderId: 'ord_S2', skuId: 'chest_silver', status: 'PAYOUT_SENT', baseA9Raw: String(3000n * A9), bonusA9Raw: '0', totalA9Raw: String(3000n * A9) },
          ], ts: Date.now() };
        }
        if (seqStep === 2) {
          return { ok: true, data: [
            { orderId: 'ord_S1', skuId: 'chest_bronze', status: 'COMPLETED', baseA9Raw: String(1500n * A9), bonusA9Raw: String(150n * A9), totalA9Raw: String(1650n * A9) },
            { orderId: 'ord_S2', skuId: 'chest_silver', status: 'PAYOUT_SENT', baseA9Raw: String(3000n * A9), bonusA9Raw: '0', totalA9Raw: String(3000n * A9) },
          ], ts: Date.now() };
        }
        return { ok: true, data: [
          { orderId: 'ord_S1', skuId: 'chest_bronze', status: 'COMPLETED', baseA9Raw: String(1500n * A9), bonusA9Raw: String(150n * A9), totalA9Raw: String(1650n * A9) },
          { orderId: 'ord_S2', skuId: 'chest_silver', status: 'COMPLETED', baseA9Raw: String(3000n * A9), bonusA9Raw: String(420n * A9), totalA9Raw: String(3420n * A9) },
        ], ts: Date.now() };
      }
      return { ok: true, data: { items: [] }, ts: Date.now() };
    },
  });

  const rootA = makeRoot();
  renderInternalMarket(rootA, () => {});
  await waitForTheaters(1);
  assert.equal(theaterLog.length, 1, 'ord_S1 must reveal first');
  assert.match(theaterLog[0].html, /ord_S1/);
  assert.match(theaterLog[0].html, /1,650 A9/);
  // Close first theater so queued ord_S2 can reveal
  theaterLog[0].closeBtn.onclick();
  await waitForTheaters(2);
  assert.equal(theaterLog.length, 2, 'ord_S2 must continue polling and reveal second');
  assert.match(theaterLog[1].html, /ord_S2/);
  assert.match(theaterLog[1].html, /3,420 A9/);
  assert.doesNotMatch(rootA.innerHTML, /id="q-chest-waiting-banner"/, 'waiting banner clears after all orders finish');
  theaterLog[1].closeBtn.onclick();

  // Refresh re-entry: already-revealed ord_S1 & ord_S2 must NOT open theater again
  rootA.isConnected = false;
  const rootRefresh = makeRoot();
  renderInternalMarket(rootRefresh, () => {});
  await new Promise(r => setTimeout(r, 35));
  assert.equal(theaterLog.length, 2, 'refreshing must NOT re-open already revealed orders');
  rootRefresh.isConnected = false;

  // Scenario B: Reverse completion (ord_R2 completes before ord_R1)
  let revStep = 0;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes('/api/presale/orders/')) {
        revStep += 1;
        if (revStep === 1) {
          return { ok: true, data: [
            { orderId: 'ord_R1', skuId: 'chest_bronze', status: 'PAYOUT_SENT', baseA9Raw: String(1500n * A9), bonusA9Raw: '0', totalA9Raw: String(1500n * A9) },
            { orderId: 'ord_R2', skuId: 'chest_silver', status: 'PAYOUT_SENT', baseA9Raw: String(3000n * A9), bonusA9Raw: '0', totalA9Raw: String(3000n * A9) },
          ], ts: Date.now() };
        }
        if (revStep === 2) {
          return { ok: true, data: [
            { orderId: 'ord_R1', skuId: 'chest_bronze', status: 'PAYOUT_SENT', baseA9Raw: String(1500n * A9), bonusA9Raw: '0', totalA9Raw: String(1500n * A9) },
            { orderId: 'ord_R2', skuId: 'chest_silver', status: 'COMPLETED', baseA9Raw: String(3000n * A9), bonusA9Raw: String(300n * A9), totalA9Raw: String(3300n * A9) },
          ], ts: Date.now() };
        }
        return { ok: true, data: [
          { orderId: 'ord_R1', skuId: 'chest_bronze', status: 'COMPLETED', baseA9Raw: String(1500n * A9), bonusA9Raw: String(100n * A9), totalA9Raw: String(1600n * A9) },
          { orderId: 'ord_R2', skuId: 'chest_silver', status: 'COMPLETED', baseA9Raw: String(3000n * A9), bonusA9Raw: String(300n * A9), totalA9Raw: String(3300n * A9) },
        ], ts: Date.now() };
      }
      return { ok: true, data: { items: [] }, ts: Date.now() };
    },
  });
  const rootB = makeRoot();
  renderInternalMarket(rootB, () => {});
  await waitForTheaters(3);
  assert.equal(theaterLog.length, 3);
  assert.match(theaterLog[2].html, /ord_R2/);
  assert.match(theaterLog[2].html, /3,300 A9/);
  theaterLog[2].closeBtn.onclick();
  await waitForTheaters(4);
  assert.equal(theaterLog.length, 4);
  assert.match(theaterLog[3].html, /ord_R1/);
  assert.match(theaterLog[3].html, /1,600 A9/);
  theaterLog[3].closeBtn.onclick();
  rootB.isConnected = false;

  // Scenario C: One completed + one refunded
  let refStep = 0;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes('/api/presale/orders/')) {
        refStep += 1;
        if (refStep === 1) {
          return { ok: true, data: [
            { orderId: 'ord_M1', skuId: 'chest_bronze', status: 'PAYOUT_SENT', baseA9Raw: String(1500n * A9), bonusA9Raw: '0', totalA9Raw: String(1500n * A9) },
            { orderId: 'ord_M2', skuId: 'chest_silver', status: 'PAYOUT_SENT', baseA9Raw: String(3000n * A9), bonusA9Raw: '0', totalA9Raw: String(3000n * A9) },
          ], ts: Date.now() };
        }
        return { ok: true, data: [
          { orderId: 'ord_M1', skuId: 'chest_bronze', status: 'COMPLETED', baseA9Raw: String(1500n * A9), bonusA9Raw: String(50n * A9), totalA9Raw: String(1550n * A9) },
          { orderId: 'ord_M2', skuId: 'chest_silver', status: 'REFUNDED', refundTonNano: '2970000000', baseA9Raw: String(3000n * A9), bonusA9Raw: '0', totalA9Raw: String(3000n * A9) },
        ], ts: Date.now() };
      }
      return { ok: true, data: { items: [] }, ts: Date.now() };
    },
  });
  const rootC = makeRoot();
  renderInternalMarket(rootC, () => {});
  await waitForTheaters(5);
  assert.equal(theaterLog.length, 5, 'only completed ord_M1 reveals, refunded ord_M2 must NOT open theater');
  assert.match(theaterLog[4].html, /ord_M1/);
  assert.doesNotMatch(rootC.innerHTML, /id="q-chest-waiting-banner"/);
  theaterLog[4].closeBtn.onclick();
  rootC.isConnected = false;

  // Scenario D: Wallet switch & unmount stops poller with zero cross-wallet reveals
  let switchCalls = 0;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes('/api/presale/orders/')) {
        switchCalls += 1;
        return { ok: true, data: [
          { orderId: 'ord_SW1', skuId: 'chest_bronze', status: switchCalls === 1 ? 'PAYOUT_SENT' : 'COMPLETED', baseA9Raw: String(1500n * A9), bonusA9Raw: '0', totalA9Raw: String(1500n * A9) },
        ], ts: Date.now() };
      }
      return { ok: true, data: { items: [] }, ts: Date.now() };
    },
  });
  const rootD = makeRoot();
  renderInternalMarket(rootD, () => {});
  await new Promise((r) => setTimeout(r, 10));
  store.state.user.address = 'EQ_MULTI_W2';
  await new Promise(r => setTimeout(r, 45));
  assert.equal(theaterLog.length, 5, 'wallet switch must block cross-wallet reveal');
  rootD.isConnected = false;
  delete globalThis.window.__A9_TEST_POLL_MS__;
});

test('docs/18 #4 [P1]: Early exit re-verifies ticket & round after confirmBeforeSign; mutated round or ticket blocks wallet send (0 calls)', async () => {
  const { makeEl } = setupInteractiveDomStubs('live', true);
  const { store } = await import('./store.js');
  const { tonConnect } = await import('./tonconnect.js');
  const { pendingTxManager } = await import('./tx-ux.js');
  const { renderStageView } = await import('./quest/stage-view.js');
  const origConfirm = tonConnect.confirmBeforeSign;
  const origSendExit = tonConnect.sendV17TicketEarlyExit;
  const origFundsDesc = Object.getOwnPropertyDescriptor(store, 'fundsEnabled');
  const A9 = 1_000_000_000n;

  try {
    Object.defineProperty(store, 'fundsEnabled', { get: () => true, configurable: true });
    const nowSec = Math.floor(Date.now() / 1000);
    const ticketValid = {
      ticketAddress: 'EQ_TICKET_EXIT_9',
      roundId: 9,
      amountRaw: String(1000n * A9),
      earlyAmountRaw: String(1000n * A9),
      lateAmountRaw: '0',
      canEarlyExit: true,
      pending: false,
      exited: false,
    };
    let sendCalls = 0;
    tonConnect.sendV17TicketEarlyExit = async () => { sendCalls += 1; };

    const openExitBtn = makeEl('q-open-early-exit');
    const confirmExitBtn = makeEl('q-exit-confirm');

    // Case A: Round changes while confirmation modal is open -> 0 wallet send calls
    store.update((s) => {
      s.user.connected = true;
      s.user.address = 'EQ_EXIT_USER';
      s.round.currentRound = 9;
      s.round.rawState = 'STAKING_OPEN';
      s.round.stakeOpenAt = nowSec - 1000;
      s.round.earlyCloseAt = nowSec + 10000;
      s.round.stakeCloseAt = nowSec + 50000;
      s.round.inFirst6h = true;
      s.round.rewardBudgetRaw = String(10000n * A9);
      s.round.totalStakedRaw = String(10000n * A9);
    });
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      async json() {
        if (String(url).includes('/api/user/')) return { ok: true, data: { ticketsAvailable: true, tickets: [ticketValid] }, ts: Date.now() };
        return { ok: true, data: {}, ts: Date.now() };
      },
    });
    tonConnect.confirmBeforeSign = async () => {
      store.state.round.currentRound = 10;
      return true;
    };
    const rootA = makeRoot();
    rootA.querySelector = (sel) => (sel === '#q-open-early-exit' ? openExitBtn : null);
    renderStageView(rootA, () => {});
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(typeof openExitBtn.onclick, 'function');
    openExitBtn.onclick();
    await confirmExitBtn.onclick();
    assert.equal(sendCalls, 0, 'round change during confirm must block sendV17TicketEarlyExit (0 calls)');
    rootA.isConnected = false;

    // Case B: Re-fetched ticket becomes canEarlyExit: false & pending: true -> 0 wallet send calls
    store.update((s) => { s.round.currentRound = 9; });
    let pfCalls = 0;
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      async json() {
        if (String(url).includes('/api/user/')) {
          pfCalls += 1;
          const tk = pfCalls === 1 ? ticketValid : { ...ticketValid, canEarlyExit: false, pending: true };
          return { ok: true, data: { ticketsAvailable: true, tickets: [tk] }, ts: Date.now() };
        }
        return { ok: true, data: {}, ts: Date.now() };
      },
    });
    tonConnect.confirmBeforeSign = async () => true;
    const rootB = makeRoot();
    rootB.querySelector = (sel) => (sel === '#q-open-early-exit' ? openExitBtn : null);
    renderStageView(rootB, () => {});
    await new Promise((r) => setTimeout(r, 25));
    openExitBtn.onclick();
    await confirmExitBtn.onclick();
    assert.equal(sendCalls, 0, 'stale/pending ticket on re-fetch must block sendV17TicketEarlyExit (0 calls)');
    assert.ok(pfCalls >= 2, 'must re-fetch ticket before calling wallet send');
    rootB.isConnected = false;

    // Same ticket, updated full-position amount: require a new bill and confirmation.
    store.state.user.address = 'EQ_EXIT_RESIZED';
    let currentTicket = ticketValid;
    globalThis.fetch = async (url) => ({
      ok: true, status: 200,
      async json() {
        const data = String(url).includes('/api/user/') ? { ticketsAvailable: true, tickets: [currentTicket] } : {};
        return { ok: true, data, ts: Date.now() };
      },
    });
    const changedRoot = makeRoot();
    changedRoot.querySelector = (sel) => sel === '#q-open-early-exit' ? openExitBtn : null;
    renderStageView(changedRoot, () => {});
    await new Promise(r => setTimeout(r, 25));
    openExitBtn.onclick();
    let initialBill;
    tonConnect.confirmBeforeSign = async spec => {
      initialBill = spec.principalText;
      currentTicket = { ...ticketValid, amountRaw: String(2000n * A9), earlyAmountRaw: String(2000n * A9) };
      return true;
    };
    await confirmExitBtn.onclick();
    assert.equal(sendCalls, 0);
    assert.match(initialBill, /850 A9/);
    let revisedBill;
    tonConnect.confirmBeforeSign = async spec => { revisedBill = spec.principalText; return false; };
    await confirmExitBtn.onclick();
    assert.match(revisedBill, /1,700 A9.*300 A9/);
    changedRoot.isConnected = false;

    // Case C: Global in-flight lock engaged during confirm -> 0 wallet send calls
    pfCalls = 0;
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      async json() {
        if (String(url).includes('/api/user/')) return { ok: true, data: { ticketsAvailable: true, tickets: [ticketValid] }, ts: Date.now() };
        return { ok: true, data: {}, ts: Date.now() };
      },
    });
    tonConnect.confirmBeforeSign = async () => {
      pendingTxManager.start({ kind: 'stake', title: 'lock', titleEn: 'lock', amountText: '100 A9', targetRoute: '/round' });
      return true;
    };
    const rootC = makeRoot();
    rootC.querySelector = (sel) => (sel === '#q-open-early-exit' ? openExitBtn : null);
    renderStageView(rootC, () => {});
    await new Promise((r) => setTimeout(r, 25));
    openExitBtn.onclick();
    await confirmExitBtn.onclick();
    assert.equal(sendCalls, 0, 'global in-flight lock must block sendV17TicketEarlyExit (0 calls)');
    pendingTxManager.clear?.();
    rootC.isConnected = false;
  } finally {
    tonConnect.confirmBeforeSign = origConfirm;
    tonConnect.sendV17TicketEarlyExit = origSendExit;
    if (origFundsDesc) Object.defineProperty(store, 'fundsEnabled', origFundsDesc);
    else delete store.fundsEnabled;
  }
});

test('docs/18 #5 [P1]: Chest share copy uses live round stage and real settlement receipt across all zh/en angles, never 冲价正热 during stake or 1,000 A9 fallback', async () => {
  setupBrowserStubs('live', false);
  const { store } = await import('./store.js');
  const { buildShareAngles } = await import('./share.js');
  const nowSec = Math.floor(Date.now() / 1000);

  for (const lang of ['zh-CN', 'en-US']) {
    store.update((s) => {
      s.settings.language = lang;
      s.round.currentRound = 15;
      s.round.rawState = 'STAKING_OPEN';
      s.round.stakeOpenAt = nowSec - 600;
      s.round.earlyCloseAt = nowSec + 18000;
      s.round.stakeCloseAt = nowSec + 80000;
      s.round.inFirst6h = true;
    });

    for (const context of [
      { orderId: 'mine', order: { orderId: 'other', status: 'COMPLETED', totalA9Raw: '12000000000' } },
      { orderId: 'mine', order: { orderId: 'mine', status: 'PAYOUT_SENT', totalA9Raw: '12000000000' } },
      { receipt: { chest: { chestId: 'other', status: 'OPENED' }, rewardA9Raw: '12000000000', destination: 'WALLET' } },
    ]) {
      const [gift, update] = buildShareAngles('chest', 'c1', context);
      assert.doesNotMatch(gift.text + update.text, /12 A9|已到账|已开箱|已结算|已记入|paid|credited|unboxed|settled/i);
    }
    // Free-form text alone cannot establish a payout.
    for (const source of ['SHOP_BOOST', 'FREE_TIER']) {
      const noAmt = buildShareAngles('chest', 'c1', { source, rewardText: '1,000 A9' });
      assert.equal(noAmt.length, 3);
      assert.doesNotMatch(noAmt[0].text + noAmt[1].text, /已到账|已开箱|已结算|已记入|paid|credited|unboxed|settled/i);
      for (const angle of noAmt) {
        assert.doesNotMatch(angle.text, /1,000 A9/, `${lang}/${source} must not fall back to 1,000 A9`);
        assert.doesNotMatch(angle.text, /冲价正热|12H 冲价线|12H Push is heating up/, `${lang}/${source} in stake stage must never say 冲价正热`);
      }

      // A matching opening receipt supplies the amount and destination.
      const withAmt = buildShareAngles('chest', 'c2', { source, receipt: { chest: { chestId: 'c2', status: 'OPENED' }, rewardA9Raw: '2345000000000', destination: 'PROMO_BALANCE' } });
      assert.match(withAmt[0].text, /2,345 A9/, `${lang}/${source} gift/report angle must include exact settlement receipt`);
      if (source === 'SHOP_BOOST') {
        assert.match(withAmt[1].text, /2,345 A9/, `${lang}/${source} banter angle must include exact settlement receipt`);
      }
      for (const angle of withAmt) {
        assert.doesNotMatch(angle.text, /冲价正热|12H 冲价线|12H Push is heating up/);
      }
      if (lang === 'zh-CN') assert.match(withAmt[1].text, /头矿 6 小时 5% 止损锁仓开放中/);
      else assert.match(withAmt[1].text, /First 6H 5% stop-loss lock open/);
    }

    // During charge stage -> banter angle reflects 12H push & gift/banter reflect exact settlement
    store.update((s) => {
      s.round.rawState = 'OBSERVING';
      s.round.observationEndAt = nowSec + 7200;
      s.round.qualifiedCandles = 5;
    });
    const chargeAngles = buildShareAngles('chest', 'c3', { source: 'SHOP_BOOST', orderId: 'order3', order: { orderId: 'order3', status: 'COMPLETED', totalA9Raw: '4888000000000' } });
    assert.match(chargeAngles[0].text, /4,888 A9/);
    assert.match(chargeAngles[1].text, /4,888 A9/);
    if (lang === 'zh-CN') assert.match(chargeAngles[1].text, /12 小时冲价推进中/);
    else assert.match(chargeAngles[1].text, /12H push live/);
  }
});

// =========================================================================
// 三项核心可观察结果回归测试（余额复核 / 新购与旧在途双订单 / 开箱离页清理）
// =========================================================================

test('audit fix #4: Live stake re-verifies fresh a9BalanceRaw before signing; insufficient or missing balance blocks wallet send (0 calls)', async () => {
  const { makeEl } = setupInteractiveDomStubs('live', true);
  const { store } = await import('./store.js');
  const { tonConnect } = await import('./tonconnect.js');
  const { renderStageView } = await import('./quest/stage-view.js');
  const origConfirm = tonConnect.confirmBeforeSign;
  const origSendStake = tonConnect.sendV15StakeA9;
  const origFundsDesc = Object.getOwnPropertyDescriptor(store, 'fundsEnabled');
  const A9 = 1_000_000_000n;

  try {
    Object.defineProperty(store, 'fundsEnabled', { get: () => true, configurable: true });
    const nowSec = Math.floor(Date.now() / 1000);
    store.update((s) => {
      s.user.connected = true;
      s.user.address = 'EQ_BAL_RECHECK';
      s.round.currentRound = 14;
      s.round.rawState = 'STAKING_OPEN';
      s.round.stakeOpenAt = nowSec - 1000;
      s.round.earlyCloseAt = nowSec + 10000;
      s.round.stakeCloseAt = nowSec + 50000;
      s.round.inFirst6h = true;
      s.round.rewardBudgetRaw = String(100000n * A9);
      s.round.totalStakedRaw = String(100000n * A9);
      s.round.stakingEnabled = true;
      s.round.stale = false;
      s.round.detailStale = false;
      s.round.detailLoading = false;
      s.round.protocolConfig = { contracts: { roundController: 'EQ_RC_BAL' } };
    });

    let confirmCalls = 0;
    let sendCalls = 0;
    tonConnect.confirmBeforeSign = async () => { confirmCalls += 1; return true; };
    tonConnect.sendV15StakeA9 = async () => { sendCalls += 1; };

    const openBtn = makeEl('q-open-stake');
    const inp = makeEl('q-stake-input', { value: '10000' });
    const availEl = makeEl('q-stake-avail');
    const errEl = makeEl('q-stake-err');
    const submitBtn = makeEl('q-stake-submit');

    // Case A: Initial balance 50,000 A9, drops to 500 A9 on fresh portfolio fetch at submit -> 0 wallet calls
    let pfCall = 0;
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      async json() {
        if (String(url).includes('/api/user/')) {
          pfCall += 1;
          const bal = pfCall === 1 ? String(50000n * A9) : String(500n * A9);
          return { ok: true, data: { ticketsAvailable: true, a9BalanceRaw: bal, jettonWallet: 'EQ_JW_BAL', tickets: [] }, ts: Date.now() };
        }
        return { ok: true, data: {}, ts: Date.now() };
      },
    });
    const rootA = makeRoot();
    rootA.querySelector = (sel) => (sel === '#q-open-stake' ? openBtn : null);
    renderStageView(rootA, () => {});
    await new Promise((r) => setTimeout(r, 25));
    openBtn.onclick();
    inp.value = '10000';
    inp.oninput();
    await submitBtn.onclick();
    assert.equal(confirmCalls, 0, 'insufficient fresh balance must block before confirmBeforeSign');
    assert.equal(sendCalls, 0, 'insufficient fresh balance must block sendV15StakeA9 (0 calls)');
    assert.equal(availEl.textContent, '500 A9', 'available balance UI must update to latest 500 A9');
    rootA.isConnected = false;

    // Case B: Fresh portfolio returns null/missing a9BalanceRaw -> 0 wallet calls
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      async json() {
        if (String(url).includes('/api/user/')) {
          return { ok: true, data: { ticketsAvailable: true, a9BalanceRaw: null, jettonWallet: 'EQ_JW_BAL', tickets: [] }, ts: Date.now() };
        }
        return { ok: true, data: {}, ts: Date.now() };
      },
    });
    const rootB = makeRoot();
    rootB.querySelector = (sel) => (sel === '#q-open-stake' ? openBtn : null);
    renderStageView(rootB, () => {});
    await new Promise((r) => setTimeout(r, 25));
    openBtn.onclick();
    inp.value = '1000';
    inp.oninput();
    await submitBtn.onclick();
    assert.equal(confirmCalls, 0, 'missing fresh balance must block before confirmBeforeSign');
    assert.equal(sendCalls, 0, 'missing fresh balance must block sendV15StakeA9 (0 calls)');
    assert.equal(availEl.textContent, '—');
    rootB.isConnected = false;
    void errEl;
  } finally {
    tonConnect.confirmBeforeSign = origConfirm;
    tonConnect.sendV15StakeA9 = origSendStake;
    if (origFundsDesc) Object.defineProperty(store, 'fundsEnabled', origFundsDesc);
    else delete store.fundsEnabled;
  }
});

test('audit fix #1: Newly purchased chest completion keeps polling existing in-flight order for the same wallet so both reveal once', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `
    import assert from 'node:assert/strict';
    const storage = new Map([['a9_ui_prefs_v1', JSON.stringify({ settings: { language: 'zh-CN', themeMode: 'light' } })]]);
    globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
    globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const byId = new Map();
    const makeEl = (id = '', extra = {}) => {
      const el = { id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, isConnected: true, dataset: {}, style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, focus() {}, remove() { el.isConnected = false; if (el.id && byId.get(el.id) === el) byId.delete(el.id); }, querySelector: (s) => (s.startsWith('#') ? byId.get(s.slice(1)) || null : null), querySelectorAll: () => [], ...extra };
      if (id) byId.set(id, el);
      return el;
    };
    const theaterLog = [];
    globalThis.window = { __A9_CONFIG__: { mode: 'live', network: 'testnet', apiBase: 'https://api.example.invalid', liveFundsEnabled: true }, __A9_TEST_POLL_MS__: 15, location: { href: 'https://app.example.invalid/?mode=live', origin: 'https://app.example.invalid', search: '?mode=live', hash: '#/market' }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, scrollTo() {} };
    globalThis.document = { documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' }, body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild(el) { el.isConnected = true; if (el.id) byId.set(el.id, el); if (el.id === 'q-chest-theater') { const closeBtn = makeEl('q-theater-close'); el.querySelector = (s) => (s === '#q-theater-close' ? closeBtn : null); theaterLog.push({ html: el.innerHTML, el, closeBtn }); } return el; } }, addEventListener() {}, removeEventListener() {}, getElementById: (id) => byId.get(id) || null, querySelector: (s) => (s.startsWith('#') ? byId.get(s.slice(1)) || null : null), querySelectorAll: () => [], createElement: () => makeEl('') };
    makeEl('modal-root');

    const { store } = await import('./a9-mini-app/js/store.js');
    const { tonConnect } = await import('./a9-mini-app/js/tonconnect.js');
    const { pendingTxManager } = await import('./a9-mini-app/js/tx-ux.js');
    const { renderInternalMarket } = await import('./a9-mini-app/js/quest/chest-view.js');
    const { CHEST_MALL_CATALOG, PAID_CHEST_CRIT_TIERS } = await import('./worker/src/chest-engine.mjs');
    const A9 = 1_000_000_000n;

    store.update((s) => {
      s.user.connected = true;
      s.user.address = 'EQ_NEW_AND_OLD_W1';
      s.round.protocolConfig = { presaleHotWallet: { open: true } };
      s.round.chestMall = { openEnabled: true, skus: Object.values(CHEST_MALL_CATALOG), critTiers: PAID_CHEST_CRIT_TIERS };
    });

    let newOrderSubmitted = false;
    let postSubmitPolls = 0;
    tonConnect.confirmBeforeSign = async () => true;
    tonConnect.sendV15PresaleTx = async () => { newOrderSubmitted = true; return { boc: 'ok' }; };

    globalThis.fetch = async (url, init = {}) => ({
      ok: true, status: 200,
      async json() {
        const u = String(url);
        const method = String(init?.method || 'GET').toUpperCase();
        if (method === 'POST' && (u.includes('/api/presale/') || u.includes('/api/chests/'))) {
          return { ok: true, data: { orderId: 'ord_NEW', skuId: 'chest_bronze', payTo: 'EQ_HOT_WALLET', memo: 'memo_new', totalPayNano: '1050000000' }, ts: Date.now() };
        }
        if (u.includes('/api/presale/orders/')) {
          if (!newOrderSubmitted) {
            return { ok: true, data: [{ orderId: 'ord_OLD', skuId: 'chest_silver', status: 'PAYOUT_SENT', baseA9Raw: String(3000n * A9), bonusA9Raw: '0', totalA9Raw: String(3000n * A9) }], ts: Date.now() };
          }
          postSubmitPolls += 1;
          if (postSubmitPolls === 1) {
            return { ok: true, data: [
              { orderId: 'ord_NEW', skuId: 'chest_bronze', status: 'COMPLETED', baseA9Raw: String(1500n * A9), bonusA9Raw: String(100n * A9), totalA9Raw: String(1600n * A9) },
              { orderId: 'ord_OLD', skuId: 'chest_silver', status: 'PAYOUT_SENT', baseA9Raw: String(3000n * A9), bonusA9Raw: '0', totalA9Raw: String(3000n * A9) },
            ], ts: Date.now() };
          }
          return { ok: true, data: [
            { orderId: 'ord_NEW', skuId: 'chest_bronze', status: 'COMPLETED', baseA9Raw: String(1500n * A9), bonusA9Raw: String(100n * A9), totalA9Raw: String(1600n * A9) },
            { orderId: 'ord_OLD', skuId: 'chest_silver', status: 'COMPLETED', baseA9Raw: String(3000n * A9), bonusA9Raw: String(250n * A9), totalA9Raw: String(3250n * A9) },
          ], ts: Date.now() };
        }
        return { ok: true, data: { items: [] }, ts: Date.now() };
      },
    });

    const skuBtn = makeEl('sku-bronze', { dataset: { pickSku: 'chest_bronze' } });
    const confirmBuyBtn = makeEl('q-confirm-buy-chest');
    const root = { isConnected: true, innerHTML: '', querySelector: () => null, querySelectorAll: (s) => (s === '[data-pick-sku]' ? [skuBtn] : []) };
    renderInternalMarket(root, () => {});
    await new Promise((r) => setTimeout(r, 25));
    skuBtn.onclick();
    await confirmBuyBtn.onclick();
    await new Promise((r) => setTimeout(r, 45));
    assert.equal(theaterLog.length, 1, 'ord_NEW must reveal first');
    assert.match(theaterLog[0].html, /ord_NEW/);
    assert.match(theaterLog[0].html, /1,600 A9/);
    theaterLog[0].closeBtn.onclick();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(theaterLog.length, 2, 'ord_OLD must keep polling after ord_NEW completes and reveal once');
    assert.match(theaterLog[1].html, /ord_OLD/);
    assert.match(theaterLog[1].html, /3,250 A9/);
    theaterLog[1].closeBtn.onclick();
    pendingTxManager.clear?.();
    root.isConnected = false;
  `;
  const args = process.execPath.endsWith('bun') ? ['-e', script] : ['--input-type=module', '-e', script];
  execFileSync(process.execPath, args, { cwd: join(APP_DIR, '..'), stdio: 'pipe' });
});

test('audit fix #6: Leaving page via hashchange dismisses chest theater overlay immediately and clears remaining reveal queue', async () => {
  const { byId, theaterLog } = setupInteractiveDomStubs('live', false);
  const listeners = new Map();
  globalThis.window.addEventListener = (evt, fn) => {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
  };
  globalThis.window.removeEventListener = (evt, fn) => {
    listeners.get(evt)?.delete(fn);
  };
  globalThis.window.__A9_TEST_POLL_MS__ = 15;

  const { store } = await import('./store.js');
  const { renderInternalMarket } = await import('./quest/chest-view.js');
  const { CHEST_MALL_CATALOG, PAID_CHEST_CRIT_TIERS } = await import('../../worker/src/chest-engine.mjs');
  const A9 = 1_000_000_000n;

  store.update((s) => {
    s.settings.language = 'zh-CN';
    s.user.connected = true;
    s.user.address = 'EQ_LEAVE_THEATER';
    s.round.chestMall = { openEnabled: false, skus: Object.values(CHEST_MALL_CATALOG), critTiers: PAID_CHEST_CRIT_TIERS };
  });

  let step = 0;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes('/api/presale/orders/')) {
        step += 1;
        if (step === 1) {
          return { ok: true, data: [
            { orderId: 'ord_L1', skuId: 'chest_bronze', status: 'PAYOUT_SENT', baseA9Raw: String(1500n * A9), bonusA9Raw: '0', totalA9Raw: String(1500n * A9) },
            { orderId: 'ord_L2', skuId: 'chest_silver', status: 'PAYOUT_SENT', baseA9Raw: String(3000n * A9), bonusA9Raw: '0', totalA9Raw: String(3000n * A9) },
          ], ts: Date.now() };
        }
        return { ok: true, data: [
          { orderId: 'ord_L1', skuId: 'chest_bronze', status: 'COMPLETED', baseA9Raw: String(1500n * A9), bonusA9Raw: String(50n * A9), totalA9Raw: String(1550n * A9) },
          { orderId: 'ord_L2', skuId: 'chest_silver', status: 'COMPLETED', baseA9Raw: String(3000n * A9), bonusA9Raw: String(100n * A9), totalA9Raw: String(3100n * A9) },
        ], ts: Date.now() };
      }
      return { ok: true, data: { items: [] }, ts: Date.now() };
    },
  });

  const root = makeRoot();
  renderInternalMarket(root, () => {});
  await new Promise((r) => setTimeout(r, 40));

  // ord_L1 theater is open and ord_L2 is queued behind it
  assert.equal(theaterLog.length, 1);
  assert.ok(byId.get('q-chest-theater')?.isConnected, 'theater overlay should be visible before route leave');
  assert.match(theaterLog[0].html, /还有 1 个/);

  // Simulate user navigating to Team tab (hashchange + unmount)
  root.isConnected = false;
  for (const fn of [...(listeners.get('hashchange') || [])]) fn();
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(byId.get('q-chest-theater'), undefined, 'theater overlay must be removed on route leave');
  assert.equal(theaterLog.length, 1, 'queued ord_L2 must NOT pop up after leaving chest page');
  delete globalThis.window.__A9_TEST_POLL_MS__;
});

// =========================================================================
// 第二批体验优化回归测试（锁仓快捷金额 / 12 面旗时段明细 / 金库账目拆行与筛选）
// =========================================================================

test('ux batch 2 #1: Stake quick chips disable tiers above balance, highlight active tier, and Max fills exact fractional BigInt precision', async () => {
  const { makeEl } = setupInteractiveDomStubs('live', true);
  const { store } = await import('./store.js');
  const { renderStageView, rawToPlainDecimal } = await import('./quest/stage-view.js');
  const origFundsDesc = Object.getOwnPropertyDescriptor(store, 'fundsEnabled');

  try {
    assert.equal(rawToPlainDecimal(1234_567890000n), '1234.56789');
    assert.equal(rawToPlainDecimal(5000_000000000n), '5000');

    Object.defineProperty(store, 'fundsEnabled', { get: () => true, configurable: true });
    const nowSec = Math.floor(Date.now() / 1000);
    store.update((s) => {
      s.settings.language = 'zh-CN';
      s.user.connected = true;
      s.user.address = 'EQ_CHIPS_USER';
      s.round.currentRound = 16;
      s.round.rawState = 'STAKING_OPEN';
      s.round.stakeOpenAt = nowSec - 600;
      s.round.earlyCloseAt = nowSec + 18000;
      s.round.stakeCloseAt = nowSec + 80000;
      s.round.inFirst6h = true;
      s.round.rewardBudgetRaw = String(100000n * 1_000_000_000n);
      s.round.totalStakedRaw = String(100000n * 1_000_000_000n);
    });
    // Available balance: 1,234.56789 A9 -> 100 & 1,000 enabled; 10,000 & 50,000 disabled; Max fills exact 1234.56789
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      async json() {
        if (String(url).includes('/api/user/')) {
          return { ok: true, data: { ticketsAvailable: true, a9BalanceRaw: '1234567890000', jettonWallet: 'EQ_JW_CHIP', tickets: [] }, ts: Date.now() };
        }
        return { ok: true, data: {}, ts: Date.now() };
      },
    });

    const openBtn = makeEl('q-open-stake');
    const inp = makeEl('q-stake-input', { value: '100' });
    const submitBtn = makeEl('q-stake-submit');
    const chipBtns = [
      makeEl('c100', { dataset: { qChip: '100' } }),
      makeEl('c1k', { dataset: { qChip: '1000' } }),
      makeEl('c10k', { dataset: { qChip: '10000' } }),
      makeEl('c50k', { dataset: { qChip: '50000' } }),
      makeEl('cmax', { dataset: { qChip: '1234.56789', qChipMax: '1' } }),
    ];
    for (const c of chipBtns) {
      c._classes = new Set();
      c.classList = { toggle: (name, on) => (on ? c._classes.add(name) : c._classes.delete(name)) };
    }
    globalThis.document.querySelectorAll = (sel) => (sel === '[data-q-chip]' ? chipBtns : []);

    const root = makeRoot();
    root.querySelector = (sel) => (sel === '#q-open-stake' ? openBtn : null);
    renderStageView(root, () => {});
    await new Promise((r) => setTimeout(r, 25));

    openBtn.onclick();
    assert.equal(chipBtns[0].disabled, false, '100 A9 chip enabled');
    assert.equal(chipBtns[1].disabled, false, '1,000 A9 chip enabled');
    assert.equal(chipBtns[2].disabled, true, '10,000 A9 chip disabled when balance is 1,234.56789');
    assert.equal(chipBtns[3].disabled, true, '50,000 A9 chip disabled when balance is 1,234.56789');
    assert.equal(chipBtns[4].disabled, false, 'Max chip enabled');

    chipBtns[4].onclick();
    assert.equal(inp.value, '1234.56789', 'Max chip must fill exact fractional precision');
    assert.equal(chipBtns[4]._classes.has('is-active'), true, 'Max chip highlighted');
    assert.equal(chipBtns[0]._classes.has('is-active'), false);
    root.isConnected = false;
    void submitBtn;
  } finally {
    if (origFundsDesc) Object.defineProperty(store, 'fundsEnabled', origFundsDesc);
    else delete store.fundsEnabled;
  }
});

test('ux batch 2 #2: Clicking any of the 12 flags toggles single-row slot detail (avg price, target price, 达标/未达标/采集中/待同步)', async () => {
  setupInteractiveDomStubs('live', false);
  const { store } = await import('./store.js');
  const { renderStageView, describeCandleSlotDetail } = await import('./quest/stage-view.js');

  store.update((s) => { s.settings.language = 'zh-CN'; });
  assert.equal(describeCandleSlotDetail({ index: 1, status: 'closed', bull: true, p: 0.0022 }, 0.002).statusText, '达标');
  assert.equal(describeCandleSlotDetail({ index: 2, status: 'closed', bull: false, p: 0.0018 }, 0.002).statusText, '未达标');
  assert.equal(describeCandleSlotDetail({ index: 3, status: 'active', bull: true, p: 0.0021 }, 0.002).statusText, '采集中');
  assert.equal(describeCandleSlotDetail({ index: 4, status: 'pending', bull: null, p: null }, 0.002).statusText, '待同步');

  const nowSec = Math.floor(Date.now() / 1000);
  store.update((s) => {
    s.round.currentRound = 17;
    s.round.rawState = 'OBSERVING';
    s.round.observationEndAt = nowSec + 7200;
    s.round.targetPrice = 0.002;
    s.round.qualifiedCandles = 1;
    s.round.candles = Array.from({ length: 12 }, (_, i) => {
      if (i === 0) return { index: 1, status: 'closed', bull: true, p: 0.0022 };
      if (i === 1) return { index: 2, status: 'closed', bull: false, p: 0.0018 };
      if (i === 2) return { index: 3, status: 'active', bull: true, p: 0.0021 };
      return { index: i + 1, status: 'pending', bull: null, p: null };
    });
  });

  const flagBtns = [{ dataset: { qFlagIdx: '3' } }, { dataset: { qFlagIdx: '4' } }];
  const root = makeRoot();
  root.querySelectorAll = (sel) => (sel === '[data-q-flag-idx]' ? flagBtns : []);
  renderStageView(root, () => {});
  assert.doesNotMatch(root.innerHTML, /id="q-flag-detail"/, 'no detail bar before clicking a flag');

  // Click active slot 3 -> shows 采集中 + avg price + target price
  flagBtns[0].onclick();
  assert.match(root.innerHTML, /id="q-flag-detail"/);
  assert.match(root.innerHTML, /第 3 小时/);
  assert.match(root.innerHTML, /\$0\.002100/);
  assert.match(root.innerHTML, /\$0\.002000/);
  assert.match(root.innerHTML, /采集中/);

  // Click pending slot 4 -> shows 待同步
  flagBtns[1].onclick();
  assert.match(root.innerHTML, /第 4 小时/);
  assert.match(root.innerHTML, /待同步/);

  // Click slot 4 again -> collapses detail bar
  flagBtns[1].onclick();
  assert.doesNotMatch(root.innerHTML, /id="q-flag-detail"/);
  root.isConnected = false;
});

test('ux batch 2 #3: Vault splits ticket accounting into structured .q-tk-ledger cells and shows filter bar only when > 1 ticket', async () => {
  setupInteractiveDomStubs('live', false);
  const { store } = await import('./store.js');
  const { renderVaultView } = await import('./quest/vault-view.js');
  const A9 = 1_000_000_000n;

  store.update((s) => {
    s.settings.language = 'zh-CN';
    s.user.connected = true;
    s.user.address = 'EQ_VAULT_LEDGER';
  });

  const activeTicket = {
    ticketAddress: 'EQ_TK_ACTIVE',
    roundId: 10,
    roundState: 'SUCCEEDED',
    amountRaw: String(1000n * A9),
    claimablePrincipalRaw: String(1000n * A9),
    claimableRewardRaw: String(200n * A9),
    claimableTotalRaw: String(1200n * A9),
    lockedRemainingRaw: String(800n * A9),
    canClaim: true,
    canInstantCashout: true,
    forfeited: false,
    pending: false,
  };
  const clearedTicket = {
    ticketAddress: 'EQ_TK_CLEARED',
    roundId: 9,
    roundState: 'SUCCEEDED',
    amountRaw: String(1000n * A9),
    principalDone: true,
    immediateClaimed: true,
    lockedClaimedRaw: String(800n * A9),
    settledQuotaTotalRaw: String(1000n * A9),
    actualRewardReceivedRaw: String(440n * A9),
    burnedLockedRaw: String(560n * A9),
    historicalCashoutUnknown: false,
    claimableTotalRaw: '0',
    lockedRemainingRaw: '0',
    canClaim: false,
    canInstantCashout: false,
    forfeited: true,
    pending: false,
  };

  // Single ticket -> filter bar hidden, structured ledger rendered
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes('/api/user/')) return { ok: true, data: { ticketsAvailable: true, claimableRaw: String(1200n * A9), lockedRaw: String(800n * A9), tickets: [activeTicket] }, ts: Date.now() };
      return { ok: true, data: { claimableRaw: '0' }, ts: Date.now() };
    },
  });
  const rootSingle = makeRoot();
  renderVaultView(rootSingle, () => {});
  await new Promise((r) => setTimeout(r, 25));
  assert.doesNotMatch(rootSingle.innerHTML, /id="q-ticket-filters"/, 'single ticket hides filter bar');
  assert.match(rootSingle.innerHTML, /class="q-tk-ledger"/);
  rootSingle.isConnected = false;

  // Multiple tickets -> filter bar shown & switches between actionable and cleared
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes('/api/user/')) return { ok: true, data: { ticketsAvailable: true, claimableRaw: String(1200n * A9), lockedRaw: String(800n * A9), tickets: [activeTicket, clearedTicket] }, ts: Date.now() };
      return { ok: true, data: { claimableRaw: '0' }, ts: Date.now() };
    },
  });
  const filterBtns = [
    { dataset: { qTkFilter: 'all' } },
    { dataset: { qTkFilter: 'actionable' } },
    { dataset: { qTkFilter: 'cleared' } },
  ];
  const rootMulti = makeRoot();
  rootMulti.querySelectorAll = (sel) => (sel === '[data-q-tk-filter]' ? filterBtns : []);
  renderVaultView(rootMulti, () => {});
  await new Promise((r) => setTimeout(r, 25));
  assert.match(rootMulti.innerHTML, /id="q-ticket-filters"/);
  assert.match(rootMulti.innerHTML, /data-ticket-addr="EQ_TK_ACTIVE"/);
  assert.match(rootMulti.innerHTML, /data-ticket-addr="EQ_TK_CLEARED"/);
  assert.match(rootMulti.innerHTML, /class="q-tk-ledger-i is-green"><dt>实际到账<\/dt><dd>440 A9<\/dd>/);
  assert.match(rootMulti.innerHTML, /class="q-tk-ledger-i is-red"><dt>已销毁<\/dt><dd>560 A9<\/dd>/);

  filterBtns[1].onclick();
  assert.match(rootMulti.innerHTML, /data-ticket-addr="EQ_TK_ACTIVE"/);
  assert.doesNotMatch(rootMulti.innerHTML, /data-ticket-addr="EQ_TK_CLEARED"/);

  filterBtns[2].onclick();
  assert.doesNotMatch(rootMulti.innerHTML, /data-ticket-addr="EQ_TK_ACTIVE"/);
  assert.match(rootMulti.innerHTML, /data-ticket-addr="EQ_TK_CLEARED"/);
  rootMulti.isConnected = false;
});

// =========================================================================
// 第三批体验优化回归测试（宝箱卡面减负 + 金库今天/第7天/第14天急提试算器）
// =========================================================================

test('ux batch 3 #1: Chest card face keeps compact avg bonus while buy sheet retains full ratio denominators', async () => {
  const { byId, makeEl } = setupInteractiveDomStubs('live', false);
  const { store } = await import('./store.js');
  const { renderInternalMarket } = await import('./quest/chest-view.js');
  const { CHEST_MALL_CATALOG, PAID_CHEST_CRIT_TIERS } = await import('../../worker/src/chest-engine.mjs');

  store.update((s) => {
    s.settings.language = 'zh-CN';
    s.user.connected = true;
    s.user.address = 'EQ_CHEST_COMPACT';
    s.round.chestMall = { openEnabled: false, skus: Object.values(CHEST_MALL_CATALOG), critTiers: PAID_CHEST_CRIT_TIERS };
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return { ok: true, data: [], ts: Date.now() }; } });

  const skuBtn = makeEl('sku-bronze', { dataset: { pickSku: 'chest_bronze' } });
  const root = makeRoot();
  root.querySelectorAll = (sel) => (sel === '[data-pick-sku]' ? [skuBtn] : []);
  renderInternalMarket(root, () => {});
  await new Promise((r) => setTimeout(r, 25));

  // Card face is compact (no parenthetical base ratio)
  assert.match(root.innerHTML, /平均加赠约 <b>152\.5<\/b> A9/);
  assert.doesNotMatch(root.innerHTML, /保底约 \+10\.17%/);

  // Opening buy sheet shows full denominator breakdown (15.25% of max bonus + 10.17% of base)
  skuBtn.onclick();
  const modalHtml = byId.get('modal-root')?.innerHTML || '';
  assert.match(modalHtml, /15\.25%/);
  assert.match(modalHtml, /10\.17%/);
  root.isConnected = false;
});

test('ux batch 3 #2: Vault cashout simulator computes exact Today / Day 7 / Day 14 forecasts deducting already-claimed rewards', async () => {
  setupInteractiveDomStubs('live', false);
  const { store } = await import('./store.js');
  const { simulateTicketCashoutAtDay, renderVaultView } = await import('./quest/vault-view.js');
  const { computeTicketClaimPreview } = await import('../../worker/src/v15-indexer.mjs');
  const A9 = 1_000_000_000n;
  const settledAt = 1_700_000_000;
  const vestingSeconds = 14 * 86400;
  const roundPassed = {
    status: 2,
    settledAt,
    vestingSeconds,
    immediateBps: 2000,
    totalStakeRaw: String(1000n * A9),
    rewardBudgetRaw: String(1000n * A9),
  };

  // Sample A: Fresh 1,000 A9 ticket at Day 0 (principal 1,000 + reward 1,000)
  // Today: payout 1,440, burn 560; Day 7: payout 1,720, burn 280 (+280 saved); Day 14: payout 2,000, burn 0 (+560 saved)
  const freshBase = {
    ticketAddress: 'EQ_SIM_FRESH',
    roundId: 21,
    roundState: 'SUCCEEDED',
    amountRaw: String(1000n * A9),
    principalDone: false,
    immediateClaimed: false,
    lockedClaimedRaw: '0',
    exited: false,
    forfeited: false,
    pending: false,
  };
  const freshPreview = computeTicketClaimPreview(freshBase, roundPassed, null, settledAt);
  const freshTicket = { ...freshBase, ...freshPreview };

  const s0 = simulateTicketCashoutAtDay(freshTicket, 'today', settledAt);
  const s7 = simulateTicketCashoutAtDay(freshTicket, 7, settledAt);
  const s14 = simulateTicketCashoutAtDay(freshTicket, 14, settledAt);
  assert.equal(s0.isFuture, false);
  assert.equal(s0.payoutRaw, String(1440n * A9));
  assert.equal(s0.burnRaw, String(560n * A9));
  assert.equal(s7.isFuture, true);
  assert.equal(s7.disabled, false);
  assert.equal(s7.payoutRaw, String(1720n * A9));
  assert.equal(s7.burnRaw, String(280n * A9));
  assert.equal(s7.extraSavedRaw, String(280n * A9));
  assert.equal(s14.isFuture, true);
  assert.equal(s14.disabled, false);
  assert.equal(s14.payoutRaw, String(2000n * A9));
  assert.equal(s14.burnRaw, '0');
  assert.equal(s14.extraSavedRaw, String(560n * A9));

  // Sample B: Partially claimed at Day 7 (principal + 200 imm + 400 lin already claimed -> only 400 unvested left)
  // Day 7 preset must be disabled (already at Day 7); Today = 120 payout / 280 burn; Day 14 = 400 payout / 0 burn (+280 saved)
  const partialBase = {
    ...freshBase,
    ticketAddress: 'EQ_SIM_PARTIAL',
    principalDone: true,
    immediateClaimed: true,
    lockedClaimedRaw: String(400n * A9),
  };
  const partialNow = settledAt + 7 * 86400;
  const partialTicket = { ...partialBase, ...computeTicketClaimPreview(partialBase, roundPassed, null, partialNow) };
  const pToday = simulateTicketCashoutAtDay(partialTicket, 'today', partialNow);
  const p7 = simulateTicketCashoutAtDay(partialTicket, 7, partialNow);
  const p14 = simulateTicketCashoutAtDay(partialTicket, 14, partialNow);
  assert.equal(pToday.payoutRaw, String(120n * A9));
  assert.equal(pToday.burnRaw, String(280n * A9));
  assert.equal(p7.disabled, true, 'Day 7 preset must be disabled once ticket is at/past Day 7');
  assert.equal(p14.disabled, false);
  assert.equal(p14.payoutRaw, String(400n * A9));
  assert.equal(p14.burnRaw, '0');
  assert.equal(p14.extraSavedRaw, String(280n * A9));

  // DOM test: switching between Today and Day 14 in renderVaultView clearly separates Today vs Forecast
  store.update((s) => {
    s.settings.language = 'zh-CN';
    s.user.connected = true;
    s.user.address = 'EQ_SIM_DOM';
  });
  const liveNowSec = Math.floor(Date.now() / 1000);
  const liveRound = { ...roundPassed, settledAt: liveNowSec };
  const liveTicket = { ...freshBase, ...computeTicketClaimPreview(freshBase, liveRound, null, liveNowSec) };
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes('/api/user/')) return { ok: true, data: { ticketsAvailable: true, claimableRaw: liveTicket.claimableTotalRaw, lockedRaw: liveTicket.lockedRemainingRaw, tickets: [liveTicket] }, ts: Date.now() };
      return { ok: true, data: { claimableRaw: '0' }, ts: Date.now() };
    },
  });
  const presetBtns = [
    { dataset: { qCurvePreset: 'today' }, disabled: false },
    { dataset: { qCurvePreset: '7' }, disabled: false },
    { dataset: { qCurvePreset: '14' }, disabled: false },
  ];
  const root = makeRoot();
  root.querySelectorAll = (sel) => (sel === '[data-q-curve-preset]' ? presetBtns : []);
  renderVaultView(root, () => {});
  await new Promise((r) => setTimeout(r, 25));

  assert.match(root.innerHTML, /id="q-curve-presets"/);
  assert.match(root.innerHTML, /今天急提实得（扣已领）/);
  assert.match(root.innerHTML, /1,440 A9/);

  presetBtns[2].onclick();
  assert.match(root.innerHTML, /第 14 天试算 · 预计急提实得（扣已领）/);
  assert.match(root.innerHTML, /2,000 A9/);
  assert.match(root.innerHTML, /较今天急提多保住（未来试算）/);
  assert.match(root.innerHTML, /\+560 A9/);
  root.isConnected = false;
});

// =========================================================================
// 第四批回归测试（金库瘦身重构 + 跨模块 5 项修复）
// =========================================================================

test('ux batch 4 #1: Vault puts tickets first, merges pending+promo card, embeds 3-col overview strip, and collapses curve when no vesting tickets', async () => {
  setupInteractiveDomStubs('live', false);
  const { store } = await import('./store.js');
  const { renderVaultView } = await import('./quest/vault-view.js');

  store.update((s) => {
    s.settings.language = 'zh-CN';
    s.user.connected = true;
    s.user.address = 'EQ_VAULT_CLEAN';
  });
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes('/api/user/')) return { ok: true, data: { ticketsAvailable: true, claimableRaw: '0', lockedRaw: '0', tickets: [] }, ts: Date.now() };
      return { ok: true, data: { claimableRaw: '0' }, ts: Date.now() };
    },
  });

  const toggleBtn = {};
  const root = makeRoot();
  root.querySelector = (sel) => (sel === '#q-toggle-curve' ? toggleBtn : null);
  renderVaultView(root, () => {});
  await new Promise((r) => setTimeout(r, 25));

  const html = root.innerHTML;
  const idxTickets = html.indexOf('id="q-tickets-card"');
  const idxPromo = html.indexOf('id="q-promo-vault-card"');
  const idxCurve = html.indexOf('id="q-instant-curve-card"');
  assert.ok(idxTickets > 0 && idxPromo > idxTickets && idxCurve > idxPromo, 'Vault order must be Tickets -> Promo -> Curve');
  assert.match(html, /id="q-vault-overview-strip"/, 'Hero includes compact 3-col asset strip');
  assert.doesNotMatch(html, /class="q-ring-wrap"/, 'redundant large ring card removed');
  assert.match(html, /data-curve-expanded="0"/, 'curve auto-collapses when no vesting tickets');

  // Clicking expand button opens the curve
  toggleBtn.onclick();
  assert.match(root.innerHTML, /data-curve-expanded="1"/);
  assert.match(root.innerHTML, /class="q-chart"/);
  root.isConnected = false;
});

test('ux batch 4 #2: Price chart unifies 6-decimal precision and Team promo 6-bucket table collapses cleanly inside details', async () => {
  setupInteractiveDomStubs('live', false);
  const { racePriceChart } = await import('./quest/price-chart.js');
  const { renderTeamView } = await import('./quest/team-view.js');

  const chartHtml = racePriceChart({
    rawState: 'OBSERVING',
    targetPrice: 0.002,
    candles: [{ index: 1, status: 'closed', p: 0.0018, bull: false }],
  }, false);
  assert.match(chartHtml, /\$0\.001800/);
  assert.match(chartHtml, /\$0\.002000/);
  assert.doesNotMatch(chartHtml, /\$0\.00180000/);

  const teamRoot = makeRoot();
  renderTeamView(teamRoot, () => {});
  assert.match(teamRoot.innerHTML, /id="q-promo-buckets-details"/);
  assert.match(teamRoot.innerHTML, /550,000,000 A9/);
  teamRoot.isConnected = false;
});

// =========================================================================
// 独立验收退回 2 项定向修复回归测试（Demo 金库单源试算 + Demo 锁仓 9 位精度）
// =========================================================================

test('acceptance fix #1: Demo Vault Stage 2 ticket builds from demo-data.js single source with consistent Today / Day 7 / Day 14 forecasts on rendered page', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `
    import assert from 'node:assert/strict';
    const storage = new Map([['a9_ui_prefs_v1', JSON.stringify({ settings: { language: 'zh-CN', themeMode: 'light' } })]]);
    globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
    globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.window = {
      __A9_CONFIG__: { mode: 'demo', network: 'testnet', apiBase: 'https://api.example.invalid', liveFundsEnabled: false },
      location: { href: 'https://app.example.invalid/?mode=demo#/rewards', origin: 'https://app.example.invalid', search: '?mode=demo', hash: '#/rewards' },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, scrollTo() {},
    };
    globalThis.document = {
      documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' },
      body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
      addEventListener() {}, removeEventListener() {},
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ className: '', style: {}, setAttribute() {}, remove() {}, querySelector: () => null }),
    };

    const { store } = await import('./a9-mini-app/js/store.js');
    const demoMod = await import('./a9-mini-app/js/demo-data.js');
    const { renderVaultView, simulateTicketCashoutAtDay } = await import('./a9-mini-app/js/quest/vault-view.js');

    await store.ensureDemoReady();
    const fixedNow = 1_760_000_000;
    const tickets = demoMod.demoBuildVaultTickets(store.state, fixedNow);
    assert.equal(tickets.length, 1);
    const tk = tickets[0];
    assert.equal(tk.roundId, 2);
    assert.equal(tk.amountRaw, '3000000000000');
    assert.equal(tk.claimableRewardRaw, '3000000000000');
    assert.equal(tk.lockedRemainingRaw, '12000000000000');
    assert.equal(tk.vestingPrincipalRaw, '12000000000000');
    assert.equal(tk.instantCashoutTotalRaw, '6600000000000');
    assert.equal(tk.instantCashoutBurnRaw, '8400000000000');

    const simToday = simulateTicketCashoutAtDay(tk, 'today', fixedNow);
    const sim7 = simulateTicketCashoutAtDay(tk, 7, fixedNow);
    const sim14 = simulateTicketCashoutAtDay(tk, 14, fixedNow);
    assert.equal(simToday.payoutRaw, '6600000000000');
    assert.equal(simToday.burnRaw, '8400000000000');
    assert.equal(sim7.payoutRaw, '10800000000000');
    assert.equal(sim7.burnRaw, '4200000000000');
    assert.equal(sim7.extraSavedRaw, '4200000000000');
    assert.equal(sim14.payoutRaw, '15000000000000');
    assert.equal(sim14.burnRaw, '0');
    assert.equal(sim14.extraSavedRaw, '8400000000000');

    const presetBtns = [
      { dataset: { qCurvePreset: 'today' }, disabled: false },
      { dataset: { qCurvePreset: '7' }, disabled: false },
      { dataset: { qCurvePreset: '14' }, disabled: false },
    ];
    const root = {
      isConnected: true,
      innerHTML: '',
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === '[data-q-curve-preset]' ? presetBtns : []),
    };
    renderVaultView(root, () => {});
    await new Promise((r) => setTimeout(r, 20));

    // Today rendered bill
    assert.match(root.innerHTML, /今天急提实得（扣已领）/);
    assert.match(root.innerHTML, /6,600 A9/);
    assert.match(root.innerHTML, /8,400 A9/);
    assert.doesNotMatch(root.innerHTML, /18,750 A9/);

    // Day 7 rendered bill
    presetBtns[1].onclick();
    assert.match(root.innerHTML, /第 7 天试算 · 预计急提实得（扣已领）/);
    assert.match(root.innerHTML, /10,800 A9/);
    assert.match(root.innerHTML, /4,200 A9/);
    assert.match(root.innerHTML, /\\+4,200 A9/);

    // Day 14 rendered bill
    presetBtns[2].onclick();
    assert.match(root.innerHTML, /第 14 天试算 · 预计急提实得（扣已领）/);
    assert.match(root.innerHTML, /15,000 A9/);
    assert.match(root.innerHTML, /0 A9/);
    assert.match(root.innerHTML, /\\+8,400 A9/);
    assert.doesNotMatch(root.innerHTML, /18,750 A9/);
    assert.doesNotMatch(root.innerHTML, /12,150 A9/);

    // After claiming Today's 3,000 A9 immediate reward, all presets deduct claimed amount consistently
    const claimed = demoMod.demoFundsClaim(store.state, tk.ticketAddress, fixedNow);
    assert.equal(claimed, 3000);
    const afterTk = demoMod.demoBuildVaultTickets(store.state, fixedNow)[0];
    assert.equal(afterTk.claimableRewardRaw, '0');
    assert.equal(afterTk.instantCashoutTotalRaw, '3600000000000');
    assert.equal(afterTk.instantCashoutBurnRaw, '8400000000000');
    const after14 = simulateTicketCashoutAtDay(afterTk, 14, fixedNow);
    assert.equal(after14.payoutRaw, '12000000000000');
    assert.equal(after14.burnRaw, '0');
    assert.equal(after14.extraSavedRaw, '8400000000000');

    root.isConnected = false;
  `;
  const args = process.execPath.endsWith('bun') ? ['-e', script] : ['--input-type=module', '-e', script];
  execFileSync(process.execPath, args, { cwd: join(APP_DIR, '..'), stdio: 'pipe' });
});

test('acceptance fix #2: Demo consecutive two-stake maintains exact 9-decimal BigInt balance (1,000 -> 100.123456789 -> 899.876543211 -> Max -> 0) and legacy ticket compatibility', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `
    import assert from 'node:assert/strict';
    const storage = new Map([['a9_ui_prefs_v1', JSON.stringify({ settings: { language: 'zh-CN', themeMode: 'light' } })]]);
    globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
    globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const byId = new Map();
    const makeEl = (id = '', extra = {}) => {
      const classes = new Set();
      const el = {
        id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, isConnected: true,
        dataset: {}, style: { setProperty() {} },
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
        setAttribute() {}, focus() {},
        remove() { el.isConnected = false; if (el.id && byId.get(el.id) === el) byId.delete(el.id); },
        querySelector: (s) => (s.startsWith('#') ? byId.get(s.slice(1)) || null : null),
        querySelectorAll: () => [],
        ...extra,
      };
      if (id) byId.set(id, el);
      return el;
    };
    const chipBtns = [
      makeEl('c100', { dataset: { qChip: '100' } }),
      makeEl('c1k', { dataset: { qChip: '1000' } }),
      makeEl('cmax', { dataset: { qChip: '1000', qChipMax: '1' } }),
    ];
    globalThis.window = {
      __A9_CONFIG__: { mode: 'demo', network: 'testnet', apiBase: 'https://api.example.invalid', liveFundsEnabled: false },
      location: { href: 'https://app.example.invalid/?mode=demo#/round', origin: 'https://app.example.invalid', search: '?mode=demo', hash: '#/round' },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, scrollTo() {},
    };
    globalThis.document = {
      documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' },
      body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
      addEventListener() {}, removeEventListener() {},
      getElementById: (id) => byId.get(id) || null,
      querySelector: (s) => (s.startsWith('#') ? byId.get(s.slice(1)) || null : null),
      querySelectorAll: (s) => (s === '[data-q-chip]' ? chipBtns : []),
      createElement: () => makeEl(''),
    };
    makeEl('modal-root');

    const { store } = await import('./a9-mini-app/js/store.js');
    const { tonConnect } = await import('./a9-mini-app/js/tonconnect.js');
    const { formatRoundA9 } = await import('./a9-mini-app/js/data.js');
    const demoMod = await import('./a9-mini-app/js/demo-data.js');
    const { renderStageView } = await import('./a9-mini-app/js/quest/stage-view.js');

    await store.ensureDemoReady();
    // Simulate setting balance to 1,000 A9 (even if only a9Available is mutated directly)
    store.state.user.a9Available = 1000;
    store.state.certificates = store.state.certificates.filter((c) => c.round !== store.state.round.currentRound);
    tonConnect.confirmBeforeSign = async () => true;

    const openBtn = makeEl('q-open-stake');
    const inp = makeEl('q-stake-input', { value: '100' });
    const errEl = makeEl('q-stake-err');
    const submitBtn = makeEl('q-stake-submit');
    const winValEl = makeEl('q-oc-win-val');
    const winSubEl = makeEl('q-oc-win-sub');
    const loseValEl = makeEl('q-oc-lose-val');
    const loseSubEl = makeEl('q-oc-lose-sub');
    const summaryEl = makeEl('q-stake-summary');

    const root = {
      isConnected: true,
      innerHTML: '',
      querySelector: (s) => (s === '#q-open-stake' ? openBtn : null),
      querySelectorAll: () => [],
    };
    renderStageView(root, () => {});
    await new Promise((r) => setTimeout(r, 20));

    // Stake #1: lock 100.123456789 A9 from 1,000 A9 balance
    openBtn.onclick();
    inp.value = '100.123456789';
    inp.oninput();
    assert.equal(submitBtn.disabled, false);
    await submitBtn.onclick();

    assert.equal(store.state.user.a9AvailableRaw, '899876543211');
    assert.equal(formatRoundA9(store.state.user.a9AvailableRaw), '899.876543211 A9');
    assert.match(root.innerHTML, /100\\.123456789 A9/);

    // Stake #2: reopen stake sheet -> displays exact 899.876543211 A9, Max fills exact 899.876543211
    openBtn.onclick();
    assert.match(byId.get('modal-root').innerHTML, /899\\.876543211 A9/);
    assert.equal(chipBtns[2].dataset.qChip, '899.876543211');
    chipBtns[2].onclick();
    assert.equal(inp.value, '899.876543211');
    assert.equal(submitBtn.disabled, false);
    await submitBtn.onclick();

    assert.equal(store.state.user.a9AvailableRaw, '0');
    assert.equal(store.state.user.a9Available, 0);
    const activeCerts = store.state.certificates.filter((c) => c.round === store.state.round.currentRound && c.status === 'observation');
    assert.equal(activeCerts.length, 2);
    const totalRaw = activeCerts.reduce((sum, c) => sum + demoMod.demoCertAmountRaw(c), 0n);
    assert.equal(totalRaw, 1000_000_000_000n);
    assert.match(root.innerHTML, /id="q-my-pos-card"[\\s\\S]*?1,000 A9/);

    // Legacy Demo certificate compatibility (only stakeTon, no amountRaw)
    store.state.certificates.push({ id: 'LEGACY-CERT', round: store.state.round.currentRound, stakeTon: 250.5, status: 'observation' });
    const withLegacyRaw = store.state.certificates
      .filter((c) => c.round === store.state.round.currentRound && c.status === 'observation')
      .reduce((sum, c) => sum + demoMod.demoCertAmountRaw(c), 0n);
    assert.equal(withLegacyRaw, 1250_500_000_000n);

    root.isConnected = false;
    void errEl; void winValEl; void winSubEl; void loseValEl; void loseSubEl; void summaryEl;
  `;
  const args = process.execPath.endsWith('bun') ? ['-e', script] : ['--input-type=module', '-e', script];
  execFileSync(process.execPath, args, { cwd: join(APP_DIR, '..'), stdio: 'pipe' });
});

test('p2 fix: Demo Vault hero card, ticket claimable, and confirm sheet use unified ticket & time rule after waiting 3s (both fixed Day-0 and dynamic vesting)', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `
    import assert from 'node:assert/strict';
    const storage = new Map([['a9_ui_prefs_v1', JSON.stringify({ settings: { language: 'zh-CN', themeMode: 'light' } })]]);
    globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
    globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.window = {
      __A9_CONFIG__: { mode: 'demo', network: 'testnet', apiBase: 'https://api.example.invalid', liveFundsEnabled: false },
      location: { href: 'https://app.example.invalid/?mode=demo#/rewards', origin: 'https://app.example.invalid', search: '?mode=demo', hash: '#/rewards' },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, scrollTo() {},
    };
    globalThis.document = {
      documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' },
      body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
      addEventListener() {}, removeEventListener() {},
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ className: '', style: {}, setAttribute() {}, remove() {}, querySelector: () => null }),
    };

    const { store } = await import('./a9-mini-app/js/store.js');
    const { tonConnect } = await import('./a9-mini-app/js/tonconnect.js');
    const { renderVaultView } = await import('./a9-mini-app/js/quest/vault-view.js');

    await store.ensureDemoReady();

    // --- Part A: Default Day-0 fixed-time sample (wait 3s -> hero stays 3,000.0000 A9, ticket 3,000 A9, confirm sheet 3,000 A9) ---
    let scheduledTicks = [];
    const origSetInterval = globalThis.setInterval;
    const origClearInterval = globalThis.clearInterval;
    const origDateNow = Date.now;
    let fakeNowMs = 1_760_000_000_000;
    Date.now = () => fakeNowMs;
    globalThis.setInterval = (fn) => { scheduledTicks.push(fn); return scheduledTicks.length; };
    globalThis.clearInterval = () => { scheduledTicks = []; };

    let confirmSpec = null;
    tonConnect.confirmBeforeSign = async (spec) => { confirmSpec = spec; return false; };

    const heroIntEl = { textContent: '3,000' };
    const heroDecEl = { textContent: '.0000' };
    const heroClaimBtn = {};
    const tkClaimEl = { textContent: '3,000 A9' };
    const tkLockEl = { textContent: '12,000 A9' };
    const rootFixed = {
      isConnected: true,
      innerHTML: '',
      querySelector: (sel) => {
        if (sel === '#q-vault-int') return heroIntEl;
        if (sel === '#q-vault-dec') return heroDecEl;
        if (sel === '#q-vault-claim-hero') return heroClaimBtn;
        if (sel === '[data-q-tk-claimable="A9-STAKE-R02-641205"]') return tkClaimEl;
        if (sel === '[data-q-tk-unvested="A9-STAKE-R02-641205"]') return tkLockEl;
        return null;
      },
      querySelectorAll: () => [],
    };

    try {
      renderVaultView(rootFixed, () => {});
      await new Promise((r) => setTimeout(r, 20));

      assert.match(rootFixed.innerHTML, /<b id="q-vault-int">3,000<\\/b>/);
      assert.match(rootFixed.innerHTML, /<span id="q-vault-dec">\\.0000<\\/span>/);
      assert.match(rootFixed.innerHTML, /data-q-tk-claimable="A9-STAKE-R02-641205">3,000 A9<\\/b>/);
      assert.equal(scheduledTicks.length, 0, 'Fixed Day-0 Demo sample must not start a drifting hero ticker');

      // Wait 3 seconds and click Claim
      fakeNowMs += 3000;
      assert.equal(heroIntEl.textContent + heroDecEl.textContent, '3,000.0000');
      assert.equal(typeof heroClaimBtn.onclick, 'function');
      await heroClaimBtn.onclick();
      await new Promise((r) => setTimeout(r, 20));

      assert.ok(confirmSpec, 'Confirm sheet must open on Claim');
      assert.equal(confirmSpec.principalText, '3,000 A9');
      assert.match(confirmSpec.note, /可领本金 0 A9，奖金 3,000 A9/);
      rootFixed.isConnected = false;

      // --- Part B: Dynamic-vesting Demo ticket (vestingStartAt set -> after 3s, hero, ticket, and confirm sheet all match at T+3s) ---
      const startSec = Math.floor(fakeNowMs / 1000);
      store.state.certificates[0].vestingStartAt = startSec;
      confirmSpec = null;
      scheduledTicks = [];

      const rootDyn = {
        isConnected: true,
        innerHTML: '',
        querySelector: rootFixed.querySelector,
        querySelectorAll: () => [],
      };
      renderVaultView(rootDyn, () => {});
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(scheduledTicks.length, 1, 'Dynamic Demo ticket starts synchronized ticker');

      // Advance 3 seconds and run ticker
      fakeNowMs += 3000;
      scheduledTicks[0]();

      // Exact BigInt at +3s: 3000e9 + floor(12000e9 * 3 / 1209600) = 3000029761904 -> 3,000.029761904 A9
      assert.equal(heroIntEl.textContent + heroDecEl.textContent, '3,000.029761904');
      assert.equal(tkClaimEl.textContent, '3,000.029761904 A9');

      await heroClaimBtn.onclick();
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(confirmSpec);
      assert.equal(confirmSpec.principalText, '3,000.029761904 A9');
      assert.match(confirmSpec.note, /奖金 3,000\\.029761904 A9/);
      rootDyn.isConnected = false;
    } finally {
      Date.now = origDateNow;
      globalThis.setInterval = origSetInterval;
      globalThis.clearInterval = origClearInterval;
    }
  `;
  const args = process.execPath.endsWith('bun') ? ['-e', script] : ['--input-type=module', '-e', script];
  execFileSync(process.execPath, args, { cwd: join(APP_DIR, '..'), stdio: 'pipe' });
});

// =========================================================================
// RC1 九项修复任务单（v2）综合回归测试（01 ~ 09）
// =========================================================================

test('rc1-01 & rc1-04: unified teamId format, Page A -> Page B invite roundtrip (team+ref, normal ref, long param, legacy), Demo 0-fetch join, testnet bot handle guard, and TG share target', async () => {
  const { byId, makeEl } = setupInteractiveDomStubs('live', false);
  const TG_HOST = ['https:/', 't.me'].join('/');
  const { store } = await import('./store.js');
  const {
    isValidTeamId,
    normalizeTeamId,
    getBotHandle,
    isBotHandleConfigured,
    buildTeamInviteStartParam,
    buildTmaDeepLink,
    buildStartAppLink,
  } = await import('./share.js');
  const { A9TMA } = await import('./tma.js');
  const { renderTeamView } = await import('./quest/team-view.js');

  // 1. Unified teamId format
  assert.equal(normalizeTeamId('  #TM-ALPHA01 '), 'TM-ALPHA01');
  assert.equal(isValidTeamId('tm-alpha01'), true);
  assert.equal(isValidTeamId('TM-ALPHA01'), true);
  assert.equal(isValidTeamId('G-9988'), true);
  assert.equal(isValidTeamId('TEAM-PRO'), true);
  assert.equal(isValidTeamId('bad_team_id!'), false);

  // 2. Testnet bot handle guard: missing or mainnet A9_TonBot must return '' and disable link
  store.update((s) => { s.round.protocolConfig = { network: 'testnet', botHandle: 'A9_TonBot' }; });
  globalThis.window.__A9_CONFIG__ = { mode: 'live', network: 'testnet', apiBase: 'https://api.example.invalid', liveFundsEnabled: false, botHandle: 'A9_TonBot' };
  assert.equal(getBotHandle(), '');
  assert.equal(isBotHandleConfigured(), false);
  assert.equal(buildTmaDeepLink('invite_TM-ALPHA_REF1'), '');

  // Configured testnet bot handle works and produces clean TMA links without mode=
  store.update((s) => { s.round.protocolConfig = { network: 'testnet', botHandle: 'A9_TestnetBot' }; });
  globalThis.window.__A9_CONFIG__.botHandle = 'A9_TestnetBot';
  assert.equal(getBotHandle(), 'A9_TestnetBot');
  assert.equal(isBotHandleConfigured(), true);
  const storyLink = buildStartAppLink('round', '12', 'REF88');
  assert.ok(storyLink.startsWith(`${TG_HOST}/A9_TestnetBot?startapp=`));
  assert.ok(!storyLink.includes('mode='));

  // 3. Page A -> Page B invite roundtrip across 4 formats (team+ref, normal ref, long param <=64, legacy invite_<teamId>)
  const cases = [
    { startParam: buildTeamInviteStartParam('TM-ALPHA', 'REF88'), expectTeam: 'TM-ALPHA', expectRef: 'REF88' },
    { startParam: buildTeamInviteStartParam('', 'REF88'), expectTeam: null, expectRef: 'REF88' },
    { startParam: buildTeamInviteStartParam('TEAM-' + 'X'.repeat(32), '12345678901234567890'), expectTeam: 'TEAM-' + 'X'.repeat(32), expectRef: '12345678901234567890' },
    { startParam: 'invite_TM-LEGACY9', expectTeam: 'TM-LEGACY9', expectRef: null },
  ];
  for (const c of cases) {
    assert.ok(c.startParam.length <= 64, `startParam must stay within Telegram 64-char limit: ${c.startParam}`);
    const link = buildTmaDeepLink(c.startParam);
    const parsedParam = new URL(link).searchParams.get('startapp');
    globalThis.window.Telegram = { WebApp: { initDataUnsafe: { start_param: parsedParam } } };
    const parsed = A9TMA.parseStartParam();
    assert.ok(parsed.route.startsWith('/team'), `expected /team route, got ${parsed.route}`);
    if (c.expectTeam) assert.equal(parsed.teamId, c.expectTeam);
    assert.equal(parsed.ref || null, c.expectRef);
  }
  delete globalThis.window.Telegram;
  assert.equal(buildTeamInviteStartParam('TEAM-' + 'X'.repeat(32), 'R'.repeat(48)), '');

  // 4. Page B receiver renders #q-team-invite-card & #q-share-invite calls A9TMA.shareInvite (NOT openXShareSheet)
  store.update((s) => { s.user.connected = true; s.user.address = 'EQ_INVITE_B'; });
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    async json() {
      if (String(url).includes('/api/team/')) return { ok: true, data: null, ts: Date.now() };
      return { ok: true, data: {}, ts: Date.now() };
    },
  });
  let tgShareCalls = 0;
  const origShareInvite = A9TMA.shareInvite;
  A9TMA.shareInvite = () => { tgShareCalls += 1; };
  const shareBtn = makeEl('q-share-invite');
  const root = makeRoot();
  root.querySelector = (sel) => (sel === '#q-share-invite' ? shareBtn : null);
  try {
    renderTeamView(root, () => {}, null, { invite: 'TM-ALPHA' });
    await new Promise((r) => setTimeout(r, 25));
    assert.match(root.innerHTML, /id="q-team-invite-card"/);
    assert.match(root.innerHTML, /TM-ALPHA/);
    assert.equal(typeof shareBtn.onclick, 'function');
    shareBtn.onclick();
    assert.equal(tgShareCalls, 1, 'Telegram share button must call A9TMA.shareInvite');
    assert.equal(byId.get('modal-root')?.innerHTML || '', '', 'Telegram share button must NOT open X share sheet');
  } finally {
    A9TMA.shareInvite = origShareInvite;
    root.isConnected = false;
  }

  // 5. Demo joinTeam() performs 0 network requests
  const { execFileSync } = await import('node:child_process');
  const demoScript = `
    import assert from 'node:assert/strict';
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.window = { __A9_CONFIG__: { mode: 'demo', network: 'testnet', apiBase: 'https://api.example.invalid' }, location: { href: 'https://app.example.invalid/?mode=demo', origin: 'https://app.example.invalid', search: '?mode=demo', hash: '#/team' } };
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls += 1; throw new Error('must not fetch in demo'); };
    const { joinTeam } = await import('./a9-mini-app/js/data.js');
    const res = await joinTeam({ teamId: 'TM-ALPHA', walletAddress: 'EQ_DEMO_U' });
    assert.equal(res.teamId, 'TM-ALPHA');
    assert.equal(fetchCalls, 0);
  `;
  const args = process.execPath.endsWith('bun') ? ['-e', demoScript] : ['--input-type=module', '-e', demoScript];
  execFileSync(process.execPath, args, { cwd: join(APP_DIR, '..'), stdio: 'pipe' });
});

test('rc1-02: Instant cashout bill rejects missing burn fields, blocks matured tickets, keeps identical quote across Layer 1 & Layer 2, and cancel/stale = 0 sends', async () => {
  const { byId, makeEl } = setupInteractiveDomStubs('live', true);
  const { store } = await import('./store.js');
  const { tonConnect } = await import('./tonconnect.js');
  const { buildInstantCashoutQuote, renderVaultView } = await import('./quest/vault-view.js');
  const origConfirm = tonConnect.confirmBeforeSign;
  const origSendCashout = tonConnect.sendV15TicketClaim;
  const origFundsDesc = Object.getOwnPropertyDescriptor(store, 'fundsEnabled');
  const A9 = 1_000_000_000n;

  try {
    // Pure quote checks
    const missingRes = buildInstantCashoutQuote({
      ticketAddress: 'EQ_MISSING_BURN',
      lockedRemainingRaw: String(800n * A9),
      instantCashoutTotalRaw: String(1440n * A9),
      instantCashoutBurnRaw: null,
      claimablePrincipalRaw: String(1000n * A9),
      claimableRewardRaw: String(200n * A9),
      canInstantCashout: true,
    });
    assert.equal(missingRes.valid, false, 'missing burn field must be rejected, never treated as 0 burn');
    assert.equal(missingRes.reason, 'MISSING_FIELDS');

    const maturedRes = buildInstantCashoutQuote({
      ticketAddress: 'EQ_MATURED',
      claimablePrincipalRaw: String(1000n * A9),
      claimableRewardRaw: String(1000n * A9),
      claimableTotalRaw: String(2000n * A9),
      lockedRemainingRaw: '0',
      instantCashoutTotalRaw: String(2000n * A9),
      instantCashoutBurnRaw: '0',
      canClaim: true,
      canInstantCashout: false,
    });
    assert.equal(maturedRes.valid, false);
    assert.equal(maturedRes.reason, 'MATURED_USE_NORMAL_CLAIM');

    const activeTicket = {
      ticketAddress: 'EQ_RC1_CASHOUT',
      roundId: 18,
      roundState: 'SUCCEEDED',
      amountRaw: String(1000n * A9),
      claimablePrincipalRaw: String(1000n * A9),
      claimableRewardRaw: String(200n * A9),
      claimableTotalRaw: String(1200n * A9),
      lockedRemainingRaw: String(800n * A9),
      instantCashoutTotalRaw: String(1440n * A9),
      instantCashoutBurnRaw: String(560n * A9),
      canClaim: true,
      canInstantCashout: true,
      forfeited: false,
      pending: false,
    };
    const quote = buildInstantCashoutQuote(activeTicket);
    assert.equal(quote.valid, true);
    assert.equal(quote.instantTotalRaw, String(1440n * A9));
    assert.equal(quote.claimPrincipalRaw, String(1000n * A9));
    const { cashoutQuoteStillApplies } = await import('./quest/vault-view.js');
    const advanced = {
      ...activeTicket,
      claimableRewardRaw: String(201n * A9),
      claimableTotalRaw: String(1201n * A9),
      lockedRemainingRaw: String(799n * A9),
      instantCashoutTotalRaw: String(1440700000000n),
      instantCashoutBurnRaw: String(559300000000n),
    };
    assert.equal(cashoutQuoteStillApplies(activeTicket, quote, advanced, buildInstantCashoutQuote(advanced)), true);
    const claimed = { ...advanced, lockedClaimedRaw: String(A9) };
    assert.equal(cashoutQuoteStillApplies(activeTicket, quote, claimed, buildInstantCashoutQuote(claimed)), false);
    const invalidPayout = { ...advanced, instantCashoutTotalRaw: String(1440n * A9 - 1n) };
    assert.equal(cashoutQuoteStillApplies(activeTicket, quote, invalidPayout, buildInstantCashoutQuote(invalidPayout)), false);

    assert.equal(quote.instantBurnRaw, String(560n * A9));
    assert.equal(quote.waitExtraRaw, String(560n * A9));

    // Interactive Layer 1 -> Layer 2 consistency & cancel = 0 sends
    Object.defineProperty(store, 'fundsEnabled', { get: () => true, configurable: true });
    store.update((s) => { s.user.connected = true; s.user.address = 'EQ_RC1_CASHOUT_W'; });
    let pfCalls = 0;
    let mutateOnRecheck = false;
    let vestOnRecheck = false;
    globalThis.fetch = async (url) => ({
      ok: true, status: 200,
      async json() {
        if (String(url).includes('/api/user/')) {
          pfCalls += 1;
          let tk = activeTicket;
          if (mutateOnRecheck) tk = { ...activeTicket, forfeited: true, canInstantCashout: false };
          if (vestOnRecheck) tk = advanced;
          return { ok: true, data: { ticketsAvailable: true, claimableRaw: activeTicket.claimableTotalRaw, lockedRaw: activeTicket.lockedRemainingRaw, tickets: [tk] }, ts: Date.now() };
        }
        return { ok: true, data: { claimableRaw: '0' }, ts: Date.now() };
      },
    });

    let sendCalls = 0;
    let layer2Spec = null;
    tonConnect.sendV15TicketClaim = async () => { sendCalls += 1; };
    tonConnect.confirmBeforeSign = async (spec) => { layer2Spec = spec; return false; };

    const cashoutBtn = makeEl('btn-cashout', { dataset: { qTkInstant: 'EQ_RC1_CASHOUT' } });
    const confirmL1Btn = makeEl('q-confirm-instant-burn');
    const root = makeRoot();
    root.querySelectorAll = (sel) => (sel === '[data-q-tk-instant]' ? [cashoutBtn] : []);
    renderVaultView(root, () => {});
    await new Promise((r) => setTimeout(r, 25));

    // Open Layer 1 sheet -> check bill and CTA
    await cashoutBtn.onclick();
    await new Promise((r) => setTimeout(r, 15));
    const l1Html = byId.get('modal-root')?.innerHTML || '';
    assert.match(l1Html, /id="q-instant-cashout-sheet"/);
    assert.match(l1Html, /确认销毁 560 A9/);
    assert.match(l1Html, /1,440 A9/);

    // Layer 2 cancel -> 0 sends & same quote numbers
    await confirmL1Btn.onclick();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sendCalls, 0, 'cancel at Layer 2 must result in 0 sends');
    assert.match(layer2Spec.principalText, /1,440 A9/);
    assert.match(layer2Spec.note, /560 A9/);

    // Layer 2 confirm but ticket mutated before send -> aborted with 0 sends
    tonConnect.confirmBeforeSign = async () => { mutateOnRecheck = true; return true; };
    await cashoutBtn.onclick();
    await new Promise((r) => setTimeout(r, 15));
    await confirmL1Btn.onclick();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(sendCalls, 0, 'mutated/forfeited ticket on pre-send recheck must abort with 0 sends');
    mutateOnRecheck = false;
    tonConnect.sendV15TicketClaim = async () => {
      sendCalls += 1;
      throw new Error('Wallet stub ends the test before a transaction is submitted');
    };
    tonConnect.confirmBeforeSign = async () => { vestOnRecheck = true; return true; };
    await cashoutBtn.onclick();
    await new Promise(r => setTimeout(r, 15));
    await confirmL1Btn.onclick();
    await new Promise(r => setTimeout(r, 15));
    assert.equal(sendCalls, 1, 'normal vesting on pre-send recheck allows one wallet request');

    assert.ok(pfCalls >= 3);
    root.isConnected = false;
  } finally {
    tonConnect.confirmBeforeSign = origConfirm;
    tonConnect.sendV15TicketClaim = origSendCashout;
    if (origFundsDesc) Object.defineProperty(store, 'fundsEnabled', origFundsDesc);
    else delete store.fundsEnabled;
  }
});

test('rc1-03: Chest resume-pay blocks ambiguous/reopened/cross-device PENDING_PAYMENT (check-only, 0 wallet calls) and only allows explicit same-session wallet rejection', async () => {
  setupBrowserStubs('live', true);
  const { isExplicitWalletRejection, evaluatePresaleOrderResume } = await import('./quest/chest-view.js');

  assert.equal(isExplicitWalletRejection(new Error('USER_REJECTED')), false);
  assert.equal(isExplicitWalletRejection({ code: 'USER_REJECTED' }), true);
  assert.equal(isExplicitWalletRejection(new Error('Connection lost after broadcast; wallet response says user cancelled')), false);
  assert.equal(isExplicitWalletRejection(new Error('Network timeout')), false);

  const nowMs = 1_760_000_000_000;
  const baseOrder = {
    orderId: 'ord_resume_1',
    wallet: 'EQ_BUYER_1',
    status: 'PENDING_PAYMENT',
    payTo: 'EQ_HOT_WALLET',
    memo: 'buy:ord_resume_1',
    payTonNano: '1050000000',
    expiresAt: Math.floor(nowMs / 1000) + 600,
  };

  // Ambiguous / reopened / cross-device (confirmedUnsent: false) -> MUST be check-only
  const ambig = evaluatePresaleOrderResume({
    order: baseOrder,
    wallet: 'EQ_BUYER_1',
    fundsEnabled: true,
    presaleOpen: true,
    isLocked: false,
    confirmedUnsent: false,
    nowMs,
  });
  assert.equal(ambig.allowed, false);
  assert.equal(ambig.reason, 'AMBIGUOUS_CHECK_ONLY');

  // Same-session explicit wallet rejection (confirmedUnsent: true) -> allowed
  const okResume = evaluatePresaleOrderResume({
    order: baseOrder,
    wallet: 'EQ_BUYER_1',
    fundsEnabled: true,
    presaleOpen: true,
    isLocked: false,
    confirmedUnsent: true,
    nowMs,
  });
  assert.equal(okResume.allowed, true);
  assert.equal(okResume.reason, 'CONFIRMED_UNSENT');

  // Read-only mode -> blocked (0 signatures)
  const ro = evaluatePresaleOrderResume({
    order: baseOrder,
    wallet: 'EQ_BUYER_1',
    fundsEnabled: false,
    presaleOpen: true,
    isLocked: false,
    confirmedUnsent: true,
    nowMs,
  });
  assert.equal(ro.allowed, false);
  assert.equal(ro.reason, 'GATE_CLOSED');

  // Expired order -> blocked
  const exp = evaluatePresaleOrderResume({
    order: { ...baseOrder, expiresAt: Math.floor(nowMs / 1000) - 10 },
    wallet: 'EQ_BUYER_1',
    fundsEnabled: true,
    presaleOpen: true,
    isLocked: false,
    confirmedUnsent: true,
    nowMs,
  });
  assert.equal(exp.allowed, false);
  assert.equal(exp.reason, 'EXPIRED');
  for (const overrides of [
    { expiresAt: undefined },
    { wallet: undefined },
    { payTonNano: undefined, tonNano: '990000000' },
    { inboundTxHash: 'already-paid' },
    { memo: 'buy:other-order' },
  ]) {
    const incomplete = evaluatePresaleOrderResume({
      order: { ...baseOrder, ...overrides },
      wallet: baseOrder.wallet, confirmedUnsent: true, fundsEnabled: true, presaleOpen: true, nowMs,
    });
    assert.equal(incomplete.allowed, false, JSON.stringify(overrides));
  }
});

test('rc1-05 & rc1-06: System oracle rules, 12H Push Log title, and 4-Tab User Guide names are aligned with v17.1', () => {
  const sysSrc = readFileSync(join(JS_DIR, 'pages/system.js'), 'utf8');
  assert.doesNotMatch(sysSrc, /Pyth|RedStone|320,000 A9|@A9_TonBot|返回闯关|进入闯关/);
  assert.match(sysSrc, /多源 1H TWAP/);
  assert.match(sysSrc, /550,000,000 A9/);

  const stagesSrcNoComments = readFileSync(join(JS_DIR, 'pages/round_stages.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(stagesSrcNoComments, /12H 印章簿|12H Stamp Log/);
  assert.match(stagesSrcNoComments, /12H 冲价记录/);
  assert.match(stagesSrcNoComments, /12H Push Log/);

  const guideSrc = readFileSync(join(JS_DIR, 'pages/user-guide.js'), 'utf8');
  assert.doesNotMatch(guideSrc, /进入「闯关」|前往「我的奖励」/);
  assert.match(guideSrc, /冲关/);
  assert.match(guideSrc, /金库/);
  assert.match(guideSrc, /宝箱/);
  assert.match(guideSrc, /战队/);
});

test('rc1-07: Vault promo card renders readable error + retry button and blocks requestPromoClaimIntent (0 calls) when global in-flight lock is active', async () => {
  const { makeEl } = setupInteractiveDomStubs('live', true);
  const { store } = await import('./store.js');
  const { pendingTxManager } = await import('./tx-ux.js');
  const { renderVaultView } = await import('./quest/vault-view.js');
  const origFundsDesc = Object.getOwnPropertyDescriptor(store, 'fundsEnabled');

  try {
    Object.defineProperty(store, 'fundsEnabled', { get: () => true, configurable: true });
    store.update((s) => { s.user.connected = true; s.user.address = 'EQ_PROMO_TEST'; });

    // Case A: Promo balance API error renders #q-promo-error-banner + #q-promo-retry
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/promo/balance/')) {
        return { ok: false, status: 503, async json() { return { ok: false, error: 'PROMO_UPSTREAM_TIMEOUT' }; } };
      }
      return { ok: true, status: 200, async json() { return { ok: true, data: { ticketsAvailable: true, tickets: [] }, ts: Date.now() }; } };
    };
    const rootErr = makeRoot();
    renderVaultView(rootErr, () => {});
    await new Promise((r) => setTimeout(r, 25));
    assert.match(rootErr.innerHTML, /id="q-promo-error-banner"/);
    assert.match(rootErr.innerHTML, /id="q-promo-retry"/);
    rootErr.isConnected = false;

    // Case B: In-flight lock active -> clicking claim promo makes 0 calls to /api/promo/claim-intent
    let intentCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/promo/claim-intent')) {
        intentCalls += 1;
        return { ok: true, status: 200, async json() { return { ok: true, data: {} }; } };
      }
      if (String(url).includes('/api/promo/balance/')) {
        return { ok: true, status: 200, async json() { return { ok: true, data: { claimableRaw: '500000000000', pendingRaw: '0' }, ts: Date.now() }; } };
      }
      return { ok: true, status: 200, async json() { return { ok: true, data: { ticketsAvailable: true, tickets: [] }, ts: Date.now() }; } };
    };
    pendingTxManager.start({ kind: 'stake', title: 'lock', titleEn: 'lock', amountText: '100 A9', targetRoute: '/round' });
    const claimPromoBtn = makeEl('q-claim-promo-btn');
    const rootLock = makeRoot();
    rootLock.querySelector = (sel) => (sel === '#q-claim-promo-btn' ? claimPromoBtn : null);
    renderVaultView(rootLock, () => {});
    await new Promise((r) => setTimeout(r, 25));
    assert.match(rootLock.innerHTML, /id="q-claim-promo-reason"/);
    if (typeof claimPromoBtn.onclick === 'function') await claimPromoBtn.onclick();
    assert.equal(intentCalls, 0, 'in-flight lock must block requestPromoClaimIntent (0 calls)');
    pendingTxManager.clear?.();
    rootLock.isConnected = false;
  } finally {
    if (origFundsDesc) Object.defineProperty(store, 'fundsEnabled', origFundsDesc);
    else delete store.fundsEnabled;
  }
});

test('rc1-08: openTxRiskConfirmModal distinguishes user_cancel vs route/replacement dismissed while preserving boolean return, and Max chip always renders', async () => {
  const { byId, makeEl } = setupInteractiveDomStubs('live', true);
  const listeners = new Map();
  globalThis.window.addEventListener = (evt, fn) => {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
  };
  globalThis.window.removeEventListener = (evt, fn) => { listeners.get(evt)?.delete(fn); };
  const { openTxRiskConfirmModal } = await import('./tx-ux.js');

  // 1. Explicit cancel button -> returns false & onDismiss('user_cancel')
  let reason1 = null;
  const cancelBtn = makeEl('tx-confirm-cancel');
  const closeBtn = makeEl('tx-confirm-close');
  const okBtn = makeEl('tx-confirm-ok');
  const p1 = openTxRiskConfirmModal({ title: 'T', amount: '1 A9', onDismiss: (r) => { reason1 = r; } });
  cancelBtn.onclick();
  assert.equal(await p1, false);
  assert.equal(reason1, 'user_cancel');

  // 2. Route change / idle event -> returns false & onDismiss('dismissed')
  let reason2 = null;
  const p2 = openTxRiskConfirmModal({ title: 'T2', amount: '2 A9', onDismiss: (r) => { reason2 = r; } });
  for (const fn of [...(listeners.get('a9:interaction-idle') || [])]) fn();
  assert.equal(await p2, false);
  assert.equal(reason2, 'dismissed');

  // 3. stage-view always renders data-q-chip-max="1" even when balance is initially null
  const stageSrc = readFileSync(join(JS_DIR, 'quest/stage-view.js'), 'utf8');
  assert.match(stageSrc, /data-q-chip-max="1"/);
  void byId; void closeBtn; void okBtn;
});

test('rc1-09: Deep links preserve bet_/round_/burn_ type and roundId, historical round renders banner without auto-opening betting, and Live #/records renders ticket list', async () => {
  setupInteractiveDomStubs('live', false);
  const { A9TMA } = await import('./tma.js');
  const { store } = await import('./store.js');
  const { renderStageView } = await import('./quest/stage-view.js');
  const { renderRecordsPage } = await import('./pages/profile.js');

  // 1. Parse bet_ / round_ / burn_ preserving deepLinkType & targetRoundId
  for (const [param, expectType, expectRound] of [
    ['bet_12_REF1', 'bet', '12'],
    ['round_7_REF2', 'round', '7'],
    ['burn_3_REF3', 'burn', '3'],
  ]) {
    globalThis.window.Telegram = { WebApp: { initDataUnsafe: { start_param: param } } };
    const parsed = A9TMA.parseStartParam();
    assert.equal(parsed.route, `/round?dl=${expectType}&round=${expectRound}`);
    assert.equal(parsed.type, expectType);
    assert.equal(parsed.roundId, expectRound);
  }
  delete globalThis.window.Telegram;

  // 2. Historical round deep link shows #q-deeplink-banner[data-deeplink-historical="1"] without opening prediction betting
  const nowSec = Math.floor(Date.now() / 1000);
  store.update((s) => {
    s.round.currentRound = 12;
    s.round.rawState = 'STAKING_OPEN';
    s.round.stakeOpenAt = nowSec - 600;
    s.round.earlyCloseAt = nowSec + 18000;
    s.round.stakeCloseAt = nowSec + 80000;
    s.round.inFirst6h = true;
  });
  const stageRoot = makeRoot();
  renderStageView(stageRoot, () => {}, '5', { dl: 'bet', round: '5' });
  assert.match(stageRoot.innerHTML, /id="q-deeplink-banner"/);
  assert.match(stageRoot.innerHTML, /data-deeplink-historical="1"/);
  stageRoot.isConnected = false;

  // 3. Live #/records renders #live-records-ticket-list directly from fetchUserPortfolio
  store.update((s) => { s.user.connected = true; s.user.address = 'EQ_REC_USER'; });
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    async json() {
      if (String(url).includes('/api/user/')) {
        return {
          ok: true,
          data: {
            ticketsAvailable: true,
            tickets: [{ ticketAddress: 'EQ_TK_REC_1', roundId: 9, roundState: 'SUCCEEDED', amountRaw: '500000000000', claimableTotalRaw: '600000000000', lockedRemainingRaw: '0' }],
          },
          ts: Date.now(),
        };
      }
      return { ok: true, data: {}, ts: Date.now() };
    },
  });
  const recRoot = makeRoot();
  renderRecordsPage(recRoot, () => {}, null, { tab: 'round' });
  await new Promise((r) => setTimeout(r, 30));
  assert.match(recRoot.innerHTML, /id="live-records-ticket-list"/);
  assert.match(recRoot.innerHTML, /第 9 关/);
  recRoot.isConnected = false;
});
