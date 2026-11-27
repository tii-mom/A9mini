/**
 * A9 统一轮次 UI 状态派生引擎（Single Source of Truth）
 *
 * 严格遵循服务端字段与服务端时间（serverNowMs）派生 9 种规范阶段与 8 级「下一步」动作优先级：
 * - stage: warmup | stake | sealed | charge | settling | passed | failed | aborted | unknown
 * - 倒计时 <= 0 或缺失时 countdownMs 严格为 null，界面显示「结算中 / 待公布 / 已结束 / 待确认」，绝不显示 00:00:00
 * - 仅当最终派生 stage === 'passed' 时，文案才允许出现「通关」字样
 */

import { L } from './i18n.js';

export const ROUND_UI_STAGES = Object.freeze([
  'warmup',
  'stake',
  'sealed',
  'charge',
  'settling',
  'passed',
  'failed',
  'aborted',
  'unknown',
]);

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toTimestampMs(value) {
  const n = toFiniteNumber(value);
  if (n === null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function toPositiveBigIntOrNum(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'bigint') return value > 0n ? 1 : 0;
  const str = String(value).trim();
  if (/^\d+$/.test(str)) {
    try {
      return BigInt(str) > 0n ? 1 : 0;
    } catch (_) {
      return 0;
    }
  }
  const n = Number(str);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 汇总所有可领取来源（通关奖金 / 未通关止损退本 / aborted 无损退本 / 推广奖励）。 */
export function hasAnyClaimableReward(rewards = null, user = null) {
  const r = rewards || {};
  const u = user || {};
  const candidates = [
    r.totalClaimableA9,
    r.totalClaimableRaw,
    r.claimableA9,
    r.claimableRaw,
    r.roundClaimableA9,
    r.roundClaimableRaw,
    r.refundableA9,
    r.refundableRaw,
    r.promoClaimableA9,
    r.promoClaimableRaw,
    u.a9Claimable,
    u.promoClaimableA9,
  ];
  if (candidates.some((v) => toPositiveBigIntOrNum(v) > 0)) return true;
  if (Array.isArray(r.tickets)) {
    return r.tickets.some((t) => {
      if (!t || t.pending) return false;
      if (t.canClaim === true) return true;
      return (
        toPositiveBigIntOrNum(t.claimableTotalRaw) > 0 ||
        toPositiveBigIntOrNum(t.claimablePrincipalRaw) > 0 ||
        toPositiveBigIntOrNum(t.claimableRewardRaw) > 0
      );
    });
  }
  return false;
}

/**
 * 从原始 API detail 或 mapRoundView 视图对象中严格派生规范 stage 与倒计时。
 * 绝不盲信前端旧 stage 标记（例如达标数 < minQualified 时禁止派生 passed）。
 */
function deriveStageAndCountdown(detail, nowMs) {
  if (!detail || typeof detail !== 'object' || detail.offline === true) {
    return { stage: 'unknown', countdownMs: null, countdownLabel: L('待确认', 'Pending') };
  }

  const rawState = String(detail.rawState ?? detail.state ?? '').trim().toUpperCase();
  const legacyStage = String(detail.stage ?? '').trim().toLowerCase();
  const nextState = String(detail.nextState ?? '').trim().toUpperCase();

  const minQualified = Math.max(1, toFiniteNumber(detail.minQualifiedCandles) ?? 8);
  const qualified = toFiniteNumber(detail.qualifiedCandles);
  const hasExplicitQualified = qualified !== null && Number.isInteger(qualified) && qualified >= 0;

  const stakeOpenMs = toTimestampMs(detail.stakeOpenAt);
  const stakeCloseMs = toTimestampMs(detail.stakeCloseAt);
  const obsStartMs = toTimestampMs(detail.observationStart) ?? stakeCloseMs;
  const obsDurSec = toFiniteNumber(detail.observationSeconds ?? detail.protocolConfig?.observationSeconds);
  const obsEndMs = toTimestampMs(detail.observationEndAt)
    ?? (obsStartMs && obsDurSec && obsDurSec > 0 ? obsStartMs + obsDurSec * 1000 : null);

  const rawRemainSec = toFiniteNumber(detail.secondsRemaining ?? detail.countdownSec);
  const remainFromServerMs = rawRemainSec !== null ? rawRemainSec * 1000 : null;

  const computePositiveMs = (endMs) => {
    if (endMs !== null) {
      const diff = endMs - nowMs;
      return diff > 0 ? diff : null;
    }
    if (remainFromServerMs !== null && remainFromServerMs > 0) {
      return remainFromServerMs;
    }
    return null;
  };

  // 1) 优先依据服务端规范枚举 rawState/state
  if (rawState) {
    if (rawState === 'UNOPENED') {
      const ms = computePositiveMs(stakeOpenMs);
      return {
        stage: 'warmup',
        countdownMs: ms,
        countdownLabel: ms === null ? L('待公布', 'TBA') : '',
      };
    }

    if (rawState === 'STAKING_OPEN') {
      const expiredByClock = stakeCloseMs !== null && nowMs >= stakeCloseMs;
      const expiredByRemain = stakeCloseMs === null && remainFromServerMs !== null && remainFromServerMs <= 0;
      if (expiredByClock || expiredByRemain) {
        return { stage: 'sealed', countdownMs: null, countdownLabel: L('已封盘', 'Sealed') };
      }
      const ms = computePositiveMs(stakeCloseMs);
      return {
        stage: 'stake',
        countdownMs: ms,
        countdownLabel: ms === null ? L('待公布', 'TBA') : '',
      };
    }

    if (rawState === 'STAKING_CLOSED') {
      const ms = computePositiveMs(obsStartMs !== stakeCloseMs ? obsStartMs : null);
      return {
        stage: 'sealed',
        countdownMs: ms,
        countdownLabel: ms === null ? L('待冲价', 'Awaiting Push') : '',
      };
    }

    if (rawState === 'SETTLING_SUCCESS' || rawState === 'SETTLING_FAILURE') {
      return { stage: 'settling', countdownMs: null, countdownLabel: L('结算中', 'Settling') };
    }

    if (rawState === 'OBSERVING' || rawState === 'ORACLE_PAUSED') {
      const expiredByClock = obsEndMs !== null && nowMs >= obsEndMs;
      const expiredByRemain = obsEndMs === null && remainFromServerMs !== null && remainFromServerMs <= 0;
      if (nextState === 'AWAITING_SETTLE' || expiredByClock || expiredByRemain) {
        return { stage: 'settling', countdownMs: null, countdownLabel: L('结算中', 'Settling') };
      }
      const ms = computePositiveMs(obsEndMs);
      return {
        stage: 'charge',
        countdownMs: ms,
        countdownLabel: ms === null ? L('待确认', 'Pending') : '',
      };
    }

    if (rawState === 'SUCCEEDED') {
      // 防御性交叉校验：若明确给出达标数且 < 门槛（如 7 < 8），严禁误标 passed / 「通关」
      if (hasExplicitQualified && qualified < minQualified) {
        return { stage: 'settling', countdownMs: null, countdownLabel: L('待确认', 'Pending') };
      }
      return { stage: 'passed', countdownMs: null, countdownLabel: L('已结束', 'Ended') };
    }

    if (rawState === 'FAILED_PERMANENT' || rawState === 'FAILED') {
      return { stage: 'failed', countdownMs: null, countdownLabel: L('已结束', 'Ended') };
    }

    if (rawState === 'TECHNICAL_ABORTED' || rawState === 'ABORTED') {
      return { stage: 'aborted', countdownMs: null, countdownLabel: L('已中止', 'Aborted') };
    }

    if (nextState === 'AWAITING_SETTLE') {
      return { stage: 'settling', countdownMs: null, countdownLabel: L('结算中', 'Settling') };
    }

    return { stage: 'unknown', countdownMs: null, countdownLabel: L('待确认', 'Pending') };
  }

  // 2) 仅当无 rawState（如演示场景切换）时兼容映射，并同样执行达标数与时间边界防篡改校验
  if (legacyStage === 'warmup') {
    const ms = computePositiveMs(stakeOpenMs);
    return { stage: 'warmup', countdownMs: ms, countdownLabel: ms === null ? L('待公布', 'TBA') : '' };
  }
  if (legacyStage === 'participation' || legacyStage === 'stake') {
    if ((stakeCloseMs !== null && nowMs >= stakeCloseMs) || (stakeCloseMs === null && remainFromServerMs !== null && remainFromServerMs <= 0)) {
      return { stage: 'sealed', countdownMs: null, countdownLabel: L('已封盘', 'Sealed') };
    }
    const ms = computePositiveMs(stakeCloseMs);
    return { stage: 'stake', countdownMs: ms, countdownLabel: ms === null ? L('待公布', 'TBA') : '' };
  }
  if (legacyStage === 'sealed') {
    return { stage: 'sealed', countdownMs: null, countdownLabel: L('待冲价', 'Awaiting Push') };
  }
  if (legacyStage === 'observation' || legacyStage === 'charge') {
    if (nextState === 'AWAITING_SETTLE' || (obsEndMs !== null && nowMs >= obsEndMs) || (obsEndMs === null && remainFromServerMs !== null && remainFromServerMs <= 0)) {
      return { stage: 'settling', countdownMs: null, countdownLabel: L('结算中', 'Settling') };
    }
    const ms = computePositiveMs(obsEndMs);
    return { stage: 'charge', countdownMs: ms, countdownLabel: ms === null ? L('待确认', 'Pending') : '' };
  }
  if (legacyStage === 'settling') {
    return { stage: 'settling', countdownMs: null, countdownLabel: L('结算中', 'Settling') };
  }
  if (legacyStage === 'settlement_success' || legacyStage === 'passed') {
    // 关键守卫：前端带旧的 passed 标记但达标数 < minQualified，绝不允许派生为 passed
    if (hasExplicitQualified && qualified < minQualified) {
      return { stage: 'settling', countdownMs: null, countdownLabel: L('待确认', 'Pending') };
    }
    return { stage: 'passed', countdownMs: null, countdownLabel: L('已结束', 'Ended') };
  }
  if (legacyStage === 'settlement_burn' || legacyStage === 'failed') {
    return { stage: 'failed', countdownMs: null, countdownLabel: L('已结束', 'Ended') };
  }
  if (legacyStage === 'halted' || legacyStage === 'aborted') {
    return { stage: 'aborted', countdownMs: null, countdownLabel: L('已中止', 'Aborted') };
  }

  return { stage: 'unknown', countdownMs: null, countdownLabel: L('待确认', 'Pending') };
}

/** 按严格 8 级优先级派生唯一「下一步」按钮。 */
function derivePrimaryAction({ stage, user, rewards }) {
  // 1) stage=unknown（断网或关键字段缺失）→ 重试刷新（secondary）
  if (stage === 'unknown') {
    return {
      kind: 'retry',
      label: L('重试刷新', 'Retry'),
      href: null,
      emphasis: 'secondary',
    };
  }
  // 2) 未连接钱包 → 连接钱包（primary）
  if (!user?.connected) {
    return {
      kind: 'connect',
      label: L('连接钱包', 'Connect Wallet'),
      href: null,
      emphasis: 'primary',
    };
  }
  // 3) 有可领取（通关奖金 / 未通关止损退本 / aborted 无损退本 / 推广奖励）→ 去领取（primary）
  if (hasAnyClaimableReward(rewards, user)) {
    return {
      kind: 'claim',
      label: L('去领取', 'Claim Rewards'),
      href: '#/rewards',
      emphasis: 'primary',
    };
  }
  // 4) warmup：未预约 → 预约（primary）；已预约 → 邀请好友（primary）
  if (stage === 'warmup') {
    if (user?.warmupRegistered) {
      return {
        kind: 'warmup_invite',
        label: L('邀请好友', 'Invite Friends'),
        href: '#/round?stage=warmup',
        emphasis: 'primary',
      };
    }
    return {
      kind: 'warmup_reserve',
      label: L('预约', 'Reserve'),
      href: '#/round?stage=warmup',
      emphasis: 'primary',
    };
  }
  // 5) stake → 去锁仓（primary）
  if (stage === 'stake') {
    return {
      kind: 'stake',
      label: L('去锁仓', 'Lock A9'),
      href: '#/challenge/confirm',
      emphasis: 'primary',
    };
  }
  // 6) sealed / charge → 看进度（secondary）
  if (stage === 'sealed' || stage === 'charge') {
    return {
      kind: 'watch_progress',
      label: L('看进度', 'View Progress'),
      href: '#/round',
      emphasis: 'secondary',
    };
  }
  // 7) settling → 查看状态（secondary）
  if (stage === 'settling') {
    return {
      kind: 'view_status',
      label: L('查看状态', 'View Status'),
      href: '#/round',
      emphasis: 'secondary',
    };
  }
  // 8) passed / failed / aborted 且没有可领取 → 查看结果（secondary）
  return {
    kind: 'view_result',
    label: L('查看结果', 'View Result'),
    href: '#/round',
    emphasis: 'secondary',
  };
}

/** 派生单条凭证/仓位对应的简短状态文案（用于「我的」页面仓位条等，消除页面自写阶段判断）。 */
export function deriveTicketRoundStatusLabel(ticket, fallbackRoundDetail = null, serverNowMs = Date.now()) {
  const rawInput = typeof ticket === 'string' ? ticket : ticket?.roundState;
  const rawState = rawInput ? String(rawInput).trim().toUpperCase() : '';
  const ui = rawState
    ? deriveRoundUiState({ detail: { rawState, secondsRemaining: 1 }, user: { connected: true }, rewards: null, serverNowMs })
    : deriveRoundUiState({ detail: fallbackRoundDetail, user: { connected: true }, rewards: null, serverNowMs });
  const map = {
    warmup: L('下轮预热中', 'Warm-up'),
    stake: L('24H 锁仓中', '24H lock open'),
    sealed: L('已封盘 · 等待冲价', 'Sealed · awaiting push'),
    charge: L('12H 冲价中', '12H push live'),
    settling: L('结算中', 'Settling'),
    passed: L('本轮通关', 'Round passed'),
    failed: L('未达标 · 自动止损', 'Missed · auto stop-loss'),
    aborted: L('异常中止 · 可退本', 'Aborted · refundable'),
    unknown: L('状态待确认', 'Status pending'),
  };
  return map[ui.stage] || map.unknown;
}

/**
 * 统一轮次 UI 状态派生函数（供广场 / 闯关 / 我的三处共用）。
 * @param {object} params
 * @param {object|null} params.detail 服务端轮次详情或 mapRoundView 视图对象
 * @param {object|null} params.user 用户连接与预热状态
 * @param {object|null} params.rewards 用户各渠道可领取汇总
 * @param {number} [params.serverNowMs] 服务端对齐时间戳（ms）
 */
export function deriveRoundUiState({ detail = null, user = null, rewards = null, serverNowMs = Date.now() } = {}) {
  const nowMs = toFiniteNumber(serverNowMs) ?? Date.now();
  const { stage, countdownMs, countdownLabel } = deriveStageAndCountdown(detail, nowMs);
  const rawState = String(detail?.rawState ?? detail?.state ?? '').trim().toUpperCase();
  const inFirst6h = Boolean(detail?.inFirst6h);
  const minQualified = Math.max(1, toFiniteNumber(detail?.minQualifiedCandles) ?? 8);
  const qualified = toFiniteNumber(detail?.qualifiedCandles);
  const hasQ = qualified !== null && Number.isInteger(qualified) && qualified >= 0;

  let chipTone = 'chip-muted';
  let badgeLabel = L('待确认', 'Pending');
  let title = L('轮次状态待同步', 'Round status pending');
  let subtitle = L('请刷新获取最新服务端状态', 'Refresh to fetch latest round status');

  switch (stage) {
    case 'warmup':
      chipTone = 'chip-gold';
      badgeLabel = L('预热中', 'Warm-Up');
      title = L('下轮开局预热已开放', 'Next round warm-up open');
      subtitle = L('现在预约并邀请好友，开轮后享头矿 6H 轻止损', 'Reserve now and invite friends ahead of First 6H');
      break;
    case 'stake':
      chipTone = 'chip-green';
      badgeLabel = inFirst6h ? L('头矿 6H', 'First 6H') : L('24H 锁仓', '24H Lock');
      title = inFirst6h
        ? L('头矿 6H 开放 · 5% 轻止损', 'First 6H open · 5% stop-loss')
        : L('24H 锁仓开放中 · 100 A9 起', '24H lock open · from 100 A9');
      subtitle = inFirst6h
        ? L('锁仓期内可提前解押，达标共享本轮奖池', 'Early exit available during lock window; share pool on pass')
        : L('普通时段 10% 自动止损，永不爆仓', 'Standard 10% auto stop-loss, zero liquidation');
      break;
    case 'sealed':
      chipTone = 'chip-gold';
      badgeLabel = L('已封盘', 'Sealed');
      title = L('已封盘 · 等待 12H 冲价开始', 'Entry sealed · awaiting 12H push');
      subtitle = L('当前禁止新进与解押，即将进入 12H 价格判定', 'Entries and exits locked ahead of 12H price push');
      break;
    case 'charge': {
      const paused = rawState === 'ORACLE_PAUSED';
      chipTone = paused ? 'chip-amber' : 'chip-blue';
      badgeLabel = paused ? L('判定暂停', 'Paused') : L('12H 冲价', '12H Push');
      if (paused) {
        title = L('价格判定暂时挂起 · 等待恢复', 'Price check paused · awaiting resume');
        subtitle = L('预言机恢复后自动继续采集 1H 判定均价', 'Hourly average checks resume automatically');
      } else if (!hasQ) {
        title = L('12H 冲价进行中 · 等待时段确认', '12H price push live · awaiting slots');
        subtitle = L(`12 个 1H 时段满足任意 ${minQualified} 格即可分奖`, `Any ${minQualified} of 12 hourly slots qualifies`);
      } else if (qualified >= minQualified) {
        title = L(`已满足 ${qualified}/${minQualified} 格门槛 · 等待结算`, `${qualified}/${minQualified} slots met · awaiting settlement`);
        subtitle = L('达到任意 8/12 达标条件，等待链上最终结算', 'Threshold met; awaiting final on-chain settlement');
      } else {
        const need = minQualified - qualified;
        title = L(`还差 ${need} 个达标时段即可分奖`, `${need} more qualifying slots to share pool`);
        subtitle = L(`当前已达标 ${qualified}/${minQualified} 格，持续冲价中`, `${qualified}/${minQualified} slots met so far`);
      }
      break;
    }
    case 'settling':
      chipTone = 'chip-gold';
      badgeLabel = L('结算中', 'Settling');
      title = L('本轮结果结算确认中', 'Finalizing round settlement');
      subtitle = L('链上正在确认最终判定结果，请稍候刷新', 'On-chain settlement is in progress; check back shortly');
      break;
    case 'passed':
      // 仅 passed 状态允许出现「通关」字样
      chipTone = 'chip-green';
      badgeLabel = L('本轮通关', 'Passed');
      title = L('本轮通关 · 查看派奖与解锁', 'Round passed · view payout & unlock');
      subtitle = L('退 100% 本金 + 20% 秒提，余下 80% 14 天逐秒解锁', '100% principal + 20% instant payout, 80% unlocks over 14 days');
      break;
    case 'failed':
      chipTone = 'chip-red';
      badgeLabel = L('未达标', 'Missed');
      title = L('本轮未达标 · 自动止损退本', 'Target missed · auto stop-loss refund');
      subtitle = L('头矿 6H 退 95% 本金，普通时段退 90% 本金', '95% principal refunded for First 6H, 90% for standard lock');
      break;
    case 'aborted':
      chipTone = 'chip-amber';
      badgeLabel = L('异常中止', 'Aborted');
      title = L('本轮异常中止 · 可无损取回本金', 'Round aborted · 100% principal refundable');
      subtitle = L('已触发无损退本保护，请前往我的奖励领回 100% 本金', 'Full principal protection active; claim 100% in My Rewards');
      break;
    default:
      chipTone = 'chip-muted';
      badgeLabel = L('待确认', 'Pending');
      title = L('当前轮次状态暂不可用', 'Current round status unavailable');
      subtitle = L('网络或链上同步异常，请点击重试刷新', 'Network or sync unavailable; tap retry to refresh');
      break;
  }

  const primaryAction = derivePrimaryAction({ stage, user, rewards });
  const isTerminal = stage === 'passed' || stage === 'failed' || stage === 'aborted';

  return {
    stage,
    chipTone,
    badgeLabel,
    title,
    subtitle,
    countdownMs,
    countdownLabel,
    primaryAction,
    isTerminal,
    inFirst6h,
  };
}
