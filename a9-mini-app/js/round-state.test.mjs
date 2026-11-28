#!/usr/bin/env node
/**
 * 5b 统一状态派生引擎单元测试（js/round-state.js）
 * 覆盖：
 * 1. 全部 9 种 stage 及时间边界（含倒计时 <= 0 / 缺失均返回 null，绝不出 00:00:00）
 * 2. 字段缺失 / 断网 -> unknown + 重试刷新
 * 3. 已过结束时间但服务端尚未结算 -> settling（冲价超时） / sealed（锁仓超时）
 * 4. 达标数 < 8 但前端带旧的 passed 标记 -> 严禁派生为 passed 且文案不含「通关」
 * 5. 全部 8 级「下一步」优先级及冲突组合（如未连钱包 + 有可领 -> 优先连接钱包；已连 + 有可领 + stake -> 优先去领取）
 * 6. 仅 passed 允许出现「通关」字样
 */
import test from 'node:test';
import assert from 'node:assert/strict';

if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    location: { href: 'https://app.a9.lat/?mode=live', origin: 'https://app.a9.lat', protocol: 'https:', hostname: 'app.a9.lat', port: '', pathname: '/', search: '?mode=live', hash: '#/challenge' },
    __A9_CONFIG__: { mode: 'live', lockMode: true, network: 'mainnet', apiBase: 'https://api.a9.lat', liveFundsEnabled: false },
    matchMedia: () => ({ matches: false }),
  };
}
if (typeof globalThis.localStorage === 'undefined') {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
if (typeof globalThis.sessionStorage === 'undefined') {
  const m = new Map();
  globalThis.sessionStorage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' } };
}

const { deriveRoundUiState, deriveTicketRoundStatusLabel, ROUND_UI_STAGES } = await import('./round-state.js');
const { store } = await import('./store.js');

const NOW = 1_800_000_000_000; // 1800000000s
const NOW_SEC = Math.floor(NOW / 1000);

test('5b: covers all 9 canonical stages and enforces 通关 copy exclusively on passed', () => {
  store.state.settings.language = 'zh-CN';
  const connectedUser = { connected: true, warmupRegistered: false };

  const fixtures = [
    { expect: 'warmup',   detail: { rawState: 'UNOPENED', stakeOpenAt: NOW_SEC + 3600 }, expectCountdownGt0: true },
    { expect: 'stake',    detail: { rawState: 'STAKING_OPEN', stakeCloseAt: NOW_SEC + 7200, inFirst6h: true }, expectCountdownGt0: true },
    { expect: 'sealed',   detail: { rawState: 'STAKING_CLOSED' }, expectCountdownGt0: false },
    { expect: 'charge',   detail: { rawState: 'OBSERVING', observationEndAt: NOW_SEC + 1800, qualifiedCandles: 5, minQualifiedCandles: 8 }, expectCountdownGt0: true },
    { expect: 'settling', detail: { rawState: 'SETTLING_SUCCESS', qualifiedCandles: 9, minQualifiedCandles: 8 }, expectCountdownGt0: false },
    { expect: 'passed',   detail: { rawState: 'SUCCEEDED', secondsRemaining: 0, qualifiedCandles: 10, minQualifiedCandles: 8 }, expectCountdownGt0: false },
    { expect: 'failed',   detail: { rawState: 'FAILED_PERMANENT', secondsRemaining: 0, qualifiedCandles: 6, minQualifiedCandles: 8 }, expectCountdownGt0: false },
    { expect: 'aborted',  detail: { rawState: 'TECHNICAL_ABORTED', secondsRemaining: 0 }, expectCountdownGt0: false },
    { expect: 'unknown',  detail: null, expectCountdownGt0: false },
  ];

  const seen = new Set();
  for (const fx of fixtures) {
    const res = deriveRoundUiState({ detail: fx.detail, user: connectedUser, rewards: null, serverNowMs: NOW });
    assert.equal(res.stage, fx.expect, `expected stage ${fx.expect}, got ${res.stage}`);
    seen.add(res.stage);
    if (fx.expectCountdownGt0) {
      assert.ok(typeof res.countdownMs === 'number' && res.countdownMs > 0, `${fx.expect} should have positive countdownMs`);
    } else {
      assert.equal(res.countdownMs, null, `${fx.expect} must return null countdownMs (never 0)`);
      assert.ok(res.countdownLabel.length > 0 && !res.countdownLabel.includes('00:00:00'));
    }
    const allCopy = `${res.badgeLabel} ${res.title} ${res.subtitle} ${res.primaryAction.label}`;
    if (res.stage === 'passed') {
      assert.ok(allCopy.includes('通关'), 'passed state should describe 通关');
    } else {
      assert.equal(allCopy.includes('通关'), false, `non-passed stage "${res.stage}" must never mention 通关: ${allCopy}`);
    }
  }
  assert.deepEqual([...seen].sort(), [...ROUND_UI_STAGES].sort());
});

test('5b: boundary time handling (past end time without settlement, zero/negative countdown, missing fields)', () => {
  store.state.settings.language = 'zh-CN';
  const user = { connected: true };

  // 冲价已过结束时间但服务端尚未结算 -> settling, countdownMs=null
  const overdueCharge = deriveRoundUiState({
    detail: { rawState: 'OBSERVING', observationStart: NOW_SEC - 44000, observationSeconds: 43200, qualifiedCandles: 8, minQualifiedCandles: 8 },
    user,
    serverNowMs: NOW,
  });
  assert.equal(overdueCharge.stage, 'settling');
  assert.equal(overdueCharge.countdownMs, null);
  assert.equal(overdueCharge.countdownLabel, '结算中');
  assert.equal(overdueCharge.primaryAction.kind, 'view_status');
  assert.equal(overdueCharge.primaryAction.emphasis, 'secondary');

  // 锁仓已过结束时间但服务端尚未切态 -> sealed, countdownMs=null
  const overdueStake = deriveRoundUiState({
    detail: { rawState: 'STAKING_OPEN', stakeCloseAt: NOW_SEC - 10 },
    user,
    serverNowMs: NOW,
  });
  assert.equal(overdueStake.stage, 'sealed');
  assert.equal(overdueStake.countdownMs, null);
  assert.equal(overdueStake.primaryAction.kind, 'watch_progress');

  // 服务端 secondsRemaining = 0 且无未来时间戳 -> 不得返回 0
  const zeroRemain = deriveRoundUiState({
    detail: { rawState: 'UNOPENED', secondsRemaining: 0 },
    user,
    serverNowMs: NOW,
  });
  assert.equal(zeroRemain.stage, 'warmup');
  assert.equal(zeroRemain.countdownMs, null);
  assert.equal(zeroRemain.countdownLabel, '待公布');

  // 关键字段缺失或断网标记 -> unknown + 重试刷新
  const missingFields = deriveRoundUiState({ detail: { roundId: 6 }, user, serverNowMs: NOW });
  assert.equal(missingFields.stage, 'unknown');
  assert.equal(missingFields.primaryAction.kind, 'retry');
  assert.equal(missingFields.primaryAction.emphasis, 'secondary');

  const offline = deriveRoundUiState({ detail: { rawState: 'STAKING_OPEN', offline: true }, user, serverNowMs: NOW });
  assert.equal(offline.stage, 'unknown');
  assert.equal(offline.primaryAction.kind, 'retry');
});

test('5b: rejects stale passed flag when qualifiedCandles < minQualifiedCandles', () => {
  store.state.settings.language = 'zh-CN';
  // 前端残留旧 stage='settlement_success' 但达标数仅 7/8
  const staleFrontendPassed = deriveRoundUiState({
    detail: { stage: 'settlement_success', qualifiedCandles: 7, minQualifiedCandles: 8 },
    user: { connected: true },
    serverNowMs: NOW,
  });
  assert.notEqual(staleFrontendPassed.stage, 'passed');
  assert.equal(`${staleFrontendPassed.badgeLabel}${staleFrontendPassed.title}${staleFrontendPassed.subtitle}`.includes('通关'), false);

  // 甚至 rawState='SUCCEEDED' 若数据矛盾（qualified=6 < 8）也防御性降级，绝不误显「通关」
  const contradictory = deriveRoundUiState({
    detail: { rawState: 'SUCCEEDED', qualifiedCandles: 6, minQualifiedCandles: 8 },
    user: { connected: true },
    serverNowMs: NOW,
  });
  assert.notEqual(contradictory.stage, 'passed');
  assert.equal(`${contradictory.badgeLabel}${contradictory.title}`.includes('通关'), false);
});

test('5b: enforces strict 8-level primaryAction priority and conflict combinations', () => {
  store.state.settings.language = 'zh-CN';

  // 优先级 1 胜过 2/3：stage=unknown 且未连钱包且有可领 -> 重试刷新 (secondary)
  const p1 = deriveRoundUiState({
    detail: null,
    user: { connected: false },
    rewards: { claimableA9: 500 },
    serverNowMs: NOW,
  });
  assert.deepEqual(p1.primaryAction, { kind: 'retry', label: '重试刷新', href: null, emphasis: 'secondary' });

  // 优先级 2 胜过 3/4/5：未连钱包 + 有可领 + 锁仓期 -> 连接钱包 (primary)
  const p2 = deriveRoundUiState({
    detail: { rawState: 'STAKING_OPEN', stakeCloseAt: NOW_SEC + 600 },
    user: { connected: false },
    rewards: { claimableA9: 500 },
    serverNowMs: NOW,
  });
  assert.deepEqual(p2.primaryAction, { kind: 'connect', label: '连接钱包', href: null, emphasis: 'primary' });

  // 优先级 3 胜过 4/5/6/7/8：已连钱包 + 有可领（含推广返佣 / 止损退本 / aborted 退本）-> 去领取 (primary)
  const p3Stake = deriveRoundUiState({
    detail: { rawState: 'STAKING_OPEN', stakeCloseAt: NOW_SEC + 600 },
    user: { connected: true },
    rewards: { promoClaimableRaw: '100000000000' },
    serverNowMs: NOW,
  });
  assert.deepEqual(p3Stake.primaryAction, { kind: 'claim', label: '去领取', href: '#/rewards', emphasis: 'primary' });

  const p3Aborted = deriveRoundUiState({
    detail: { rawState: 'TECHNICAL_ABORTED' },
    user: { connected: true },
    rewards: { refundableA9: 1000 },
    serverNowMs: NOW,
  });
  assert.equal(p3Aborted.primaryAction.kind, 'claim');

  // 优先级 4：warmup 未预约 -> 预约；已预约 -> 邀请好友
  const p4a = deriveRoundUiState({
    detail: { rawState: 'UNOPENED' },
    user: { connected: true, warmupRegistered: false },
    rewards: { claimableA9: 0 },
    serverNowMs: NOW,
  });
  assert.deepEqual(p4a.primaryAction, { kind: 'warmup_reserve', label: '预约', href: '#/round?stage=warmup', emphasis: 'primary' });

  const p4b = deriveRoundUiState({
    detail: { rawState: 'UNOPENED' },
    user: { connected: true, warmupRegistered: true },
    rewards: { claimableA9: 0 },
    serverNowMs: NOW,
  });
  assert.deepEqual(p4b.primaryAction, { kind: 'warmup_invite', label: '邀请好友', href: '#/round?stage=warmup', emphasis: 'primary' });

  // 优先级 5：stake -> 去锁仓 (primary)
  const p5 = deriveRoundUiState({
    detail: { rawState: 'STAKING_OPEN', stakeCloseAt: NOW_SEC + 3600 },
    user: { connected: true },
    rewards: null,
    serverNowMs: NOW,
  });
  assert.deepEqual(p5.primaryAction, { kind: 'stake', label: '去锁仓', href: '#/challenge/confirm', emphasis: 'primary' });

  // 优先级 6：sealed / charge -> 看进度 (secondary)
  const p6 = deriveRoundUiState({
    detail: { rawState: 'OBSERVING', observationEndAt: NOW_SEC + 3600, qualifiedCandles: 4 },
    user: { connected: true },
    rewards: null,
    serverNowMs: NOW,
  });
  assert.deepEqual(p6.primaryAction, { kind: 'watch_progress', label: '看进度', href: '#/round', emphasis: 'secondary' });

  // 优先级 7：settling -> 查看状态 (secondary)
  const p7 = deriveRoundUiState({
    detail: { rawState: 'SETTLING_FAILURE' },
    user: { connected: true },
    rewards: null,
    serverNowMs: NOW,
  });
  assert.deepEqual(p7.primaryAction, { kind: 'view_status', label: '查看状态', href: '#/round', emphasis: 'secondary' });

  // 优先级 8：passed / failed / aborted 且无可领 -> 查看结果 (secondary)
  for (const st of ['SUCCEEDED', 'FAILED_PERMANENT', 'TECHNICAL_ABORTED']) {
    const p8 = deriveRoundUiState({
      detail: { rawState: st, qualifiedCandles: st === 'SUCCEEDED' ? 9 : 4 },
      user: { connected: true },
      rewards: { claimableA9: 0 },
      serverNowMs: NOW,
    });
    assert.deepEqual(p8.primaryAction, { kind: 'view_result', label: '查看结果', href: '#/round', emphasis: 'secondary' });
  }

  // 验证仓位状态辅助函数
  assert.equal(deriveTicketRoundStatusLabel({ roundState: 'OBSERVING' }, null, NOW), '12 小时冲价中');
  assert.equal(deriveTicketRoundStatusLabel({ roundState: 'STAKING_OPEN' }, null, NOW), '24 小时锁仓中');
  assert.equal(deriveTicketRoundStatusLabel({ roundState: 'STAKING_CLOSED' }, null, NOW), '已封盘 · 等待冲价');
});

test('5b: 脏 nextState=AWAITING_SETTLE 不覆盖已结算终态；charge 缺结束时间显示待确认而非结算中', async () => {
  const { demoPredictionRound } = await import(new URL('./demo-data.js', import.meta.url).href);

  const succeededWithDirtyNext = deriveRoundUiState({
    detail: { rawState: 'SUCCEEDED', nextState: 'AWAITING_SETTLE', qualifiedCandles: 10, minQualifiedCandles: 8 },
    user: { connected: true },
    serverNowMs: NOW,
  });
  assert.equal(succeededWithDirtyNext.stage, 'passed');

  const chargeMissingEnd = deriveRoundUiState({
    detail: { rawState: 'OBSERVING', qualifiedCandles: 3, minQualifiedCandles: 8 },
    user: { connected: true },
    serverNowMs: NOW,
  });
  assert.equal(chargeMissingEnd.stage, 'charge');
  assert.equal(chargeMissingEnd.countdownMs, null);
  assert.equal(chargeMissingEnd.countdownLabel, '待确认');

  // Demo 预言卡兼容规范 stage 名（passed / failed）与旧名
  assert.equal(demoPredictionRound(6, 'passed').settled, true);
  assert.equal(demoPredictionRound(6, 'passed').winningSide, 'PASS');
  assert.equal(demoPredictionRound(6, 'failed').settled, true);
  assert.equal(demoPredictionRound(6, 'failed').winningSide, 'BURN');

  // 仅通过 rewards.tickets 即可触发优先级 3「去领取」，pending 中凭证不误触发
  const byTicketFlag = deriveRoundUiState({
    detail: { rawState: 'SUCCEEDED', qualifiedCandles: 9, minQualifiedCandles: 8 },
    user: { connected: true },
    rewards: { tickets: [{ canClaim: true }] },
    serverNowMs: NOW,
  });
  assert.equal(byTicketFlag.primaryAction.kind, 'claim');

  const byTicketRaw = deriveRoundUiState({
    detail: { rawState: 'FAILED_PERMANENT', qualifiedCandles: 4, minQualifiedCandles: 8 },
    user: { connected: true },
    rewards: { tickets: [{ claimableTotalRaw: '900000000000' }] },
    serverNowMs: NOW,
  });
  assert.equal(byTicketRaw.primaryAction.kind, 'claim');

  const pendingTicketOnly = deriveRoundUiState({
    detail: { rawState: 'SUCCEEDED', qualifiedCandles: 9, minQualifiedCandles: 8 },
    user: { connected: true },
    rewards: { tickets: [{ pending: true, canClaim: true, claimableTotalRaw: '900000000000' }] },
    serverNowMs: NOW,
  });
  assert.equal(pendingTicketOnly.primaryAction.kind, 'view_result');

  // deriveTicketRoundStatusLabel 同时兼容凭证对象与裸状态字符串
  assert.equal(deriveTicketRoundStatusLabel({ roundState: 'SUCCEEDED' }, null, NOW), '本轮通关');
  assert.equal(deriveTicketRoundStatusLabel('SUCCEEDED', null, NOW), '本轮通关');
});
