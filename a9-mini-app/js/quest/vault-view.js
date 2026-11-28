/**
 * Tab 2 · 金库（#/rewards 及别名 #/claim）— A9 Quest 视图层
 *
 * 硬性约束：
 * - 顶部蓝色主卡汇总所有未结清票据可领取总额与每秒解锁增速（本地平滑插值仅作视觉跳动）；
 * - 发起链上「领取」或「3 折急提」严格按单张票据逐张签名（tonConnect.sendV15TicketClaim(ticketAddress, queryId, { instantDiscount })），
 *   严禁自行拼装多票据批量消息；
 * - 打开确认弹层与发起签名前，必须以服务端 fetchUserPortfolio 返回的真实字段核对展示；
 * - 急提价值曲线明确区分「本金 100% 不打折」、「80% 线性锁定奖金（30% → 100%）」与「整笔总奖金（44% → 100%）」口径；
 * - 支持未通关止损退本、aborted 100% 退本，以及推广余额 0.06 GRAM 一键领币。
 */

import { loadDemoModule, peekDemoModule } from '../demo-loader.js';
import { store } from '../store.js';
import { config } from '../config.js';
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast, closeModal } from '../components.js';
import { L } from '../i18n.js';
import { tonConnect, canonicalWalletKey, LIVE_READONLY_REASON } from '../tonconnect.js';
import { pendingTxManager } from '../tx-ux.js';
import { deriveRoundUiState } from '../round-state.js';
import {
  PROTOCOL_SPECS,
  serverNowMs,
  rawToA9,
  formatRoundA9,
  formatEstimatedA9,
  fetchUserPortfolio,
  fetchPromoBalance,
  fetchPredictionUser,
  activatePredictionReward,
  getEffectiveUserId,
  requestPromoClaimIntent,
  fetchPromoClaim,
} from '../data.js';
import {
  qIcon,
  finiteOrNull,
  fmtExactA9,
  fmtRawGramOrDash,
  openQuestSheet,
} from './quest-ui.js';

let vaultViewSeq = 0;

function vaultTickerParts(raw) {
  const amount = formatEstimatedA9(raw);
  if (amount === '—') return null;
  const [whole, fraction] = amount.slice(0, -3).split('.');
  return { whole, fraction: fraction ? '.' + fraction : '' };
}

/** 解析单张票据精确 BigInt 账目：严格区分已结清额度、实际到账与急提销毁 */
export function resolveTicketAccounting(ticket) {
  const isDigits = (v) => typeof v === 'string' && /^\d+$/.test(v);
  const rawOrZero = (v) => (/^\d+$/.test(String(v ?? '')) ? BigInt(String(v)) : 0n);
  const principalRaw = rawOrZero(ticket?.amountRaw);
  const claimPrincipalRaw = rawOrZero(ticket?.claimablePrincipalRaw);
  const claimRewardRaw = rawOrZero(ticket?.claimableRewardRaw);
  const claimTotalRaw = rawOrZero(ticket?.claimableTotalRaw);
  const lockedRemainingRaw = rawOrZero(ticket?.lockedRemainingRaw);
  const instantTotalRaw = rawOrZero(ticket?.instantCashoutTotalRaw);
  const instantBonusRaw = rawOrZero(ticket?.instantCashoutBonusRaw);
  const instantBurnRaw = rawOrZero(ticket?.instantCashoutBurnRaw);
  const burnedPrincipalRaw = rawOrZero(ticket?.burnedPrincipalRaw);
  const settledLockedQuotaRaw = rawOrZero(ticket?.settledLockedQuotaRaw ?? ticket?.lockedClaimedRaw ?? ticket?.rewardClaimedRaw);

  let immediateClaimedRaw = 0n;
  if (isDigits(ticket?.immediateClaimedRaw)) {
    immediateClaimedRaw = BigInt(ticket.immediateClaimedRaw);
  } else if (ticket?.immediateClaimed === true) {
    if (isDigits(ticket?.immediateRewardRaw)) {
      immediateClaimedRaw = BigInt(ticket.immediateRewardRaw);
    } else if (isDigits(ticket?.totalRewardRaw) && isDigits(ticket?.vestingPrincipalRaw)) {
      const tot = BigInt(ticket.totalRewardRaw);
      const vest = BigInt(ticket.vestingPrincipalRaw);
      immediateClaimedRaw = tot > vest ? (tot - vest) : 0n;
    } else if (isDigits(ticket?.vestingPrincipalRaw)) {
      immediateClaimedRaw = BigInt(ticket.vestingPrincipalRaw) / 4n;
    }
  }

  const settledQuotaTotalRaw = isDigits(ticket?.settledQuotaTotalRaw)
    ? BigInt(ticket.settledQuotaTotalRaw)
    : (immediateClaimedRaw + settledLockedQuotaRaw);

  const forfeited = Boolean(ticket?.forfeited);
  let historicalCashoutUnknown = Boolean(ticket?.historicalCashoutUnknown);
  let actualLockedReceivedRaw = settledLockedQuotaRaw.toString();
  let actualRewardReceivedRaw = settledQuotaTotalRaw.toString();
  let actualBurnedLockedRaw = '0';

  if (forfeited) {
    const trustedBurn = isDigits(ticket?.cashoutBurnedRaw)
      ? ticket.cashoutBurnedRaw
      : (isDigits(ticket?.actualBurnedLockedRaw)
          ? ticket.actualBurnedLockedRaw
          : (isDigits(ticket?.burnedLockedRaw) && BigInt(ticket.burnedLockedRaw) > 0n ? ticket.burnedLockedRaw : null));
    const trustedPaid = isDigits(ticket?.actualRewardReceivedRaw)
      ? ticket.actualRewardReceivedRaw
      : (isDigits(ticket?.cashoutPaidRaw)
          ? ticket.cashoutPaidRaw
          : (isDigits(ticket?.totalRewardClaimedRaw) && ticket?.historicalCashoutUnknown === false ? ticket.totalRewardClaimedRaw : null));
    if (trustedBurn !== null) {
      const burnedBi = BigInt(trustedBurn);
      const lockedRecvBi = settledLockedQuotaRaw > burnedBi ? (settledLockedQuotaRaw - burnedBi) : 0n;
      const totalRecvBi = trustedPaid !== null ? BigInt(trustedPaid) : (immediateClaimedRaw + lockedRecvBi);
      actualLockedReceivedRaw = lockedRecvBi.toString();
      actualRewardReceivedRaw = totalRecvBi.toString();
      actualBurnedLockedRaw = burnedBi.toString();
      historicalCashoutUnknown = false;
    } else if (trustedPaid !== null) {
      const totalRecvBi = BigInt(trustedPaid);
      const lockedRecvBi = totalRecvBi > immediateClaimedRaw ? (totalRecvBi - immediateClaimedRaw) : 0n;
      const burnedBi = settledLockedQuotaRaw > lockedRecvBi ? (settledLockedQuotaRaw - lockedRecvBi) : 0n;
      actualLockedReceivedRaw = lockedRecvBi.toString();
      actualRewardReceivedRaw = totalRecvBi.toString();
      actualBurnedLockedRaw = burnedBi.toString();
      historicalCashoutUnknown = false;
    } else {
      historicalCashoutUnknown = true;
      actualLockedReceivedRaw = null;
      actualRewardReceivedRaw = null;
      actualBurnedLockedRaw = null;
    }
  }

  return {
    forfeited,
    historicalCashoutUnknown,
    principalRaw: principalRaw.toString(),
    claimPrincipalRaw: claimPrincipalRaw.toString(),
    claimRewardRaw: claimRewardRaw.toString(),
    claimTotalRaw: claimTotalRaw.toString(),
    lockedRemainingRaw: lockedRemainingRaw.toString(),
    immediateClaimedRaw: immediateClaimedRaw.toString(),
    lockedClaimedRaw: settledLockedQuotaRaw.toString(),
    settledLockedQuotaRaw: settledLockedQuotaRaw.toString(),
    settledQuotaTotalRaw: settledQuotaTotalRaw.toString(),
    actualLockedReceivedRaw,
    actualRewardReceivedRaw,
    totalRewardClaimedRaw: actualRewardReceivedRaw,
    instantTotalRaw: instantTotalRaw.toString(),
    instantBonusRaw: instantBonusRaw.toString(),
    instantBurnRaw: instantBurnRaw.toString(),
    burnedPrincipalRaw: burnedPrincipalRaw.toString(),
    burnedLockedRaw: actualBurnedLockedRaw,
  };
}

// Advance each ticket using its own settlement date and integer contract units.
export function vestingDeltaRaw(ticket, nowSec) {
  const { vestingStartAt, vestingSeconds, vestingPrincipalRaw, lockedRemainingRaw } = ticket;
  if (!Number.isSafeInteger(vestingStartAt) || vestingStartAt <= 0 ||
      !Number.isSafeInteger(vestingSeconds) || vestingSeconds <= 0 ||
      !/^\d+$/.test(vestingPrincipalRaw) || !/^\d+$/.test(lockedRemainingRaw)) return 0n;
  const total = BigInt(vestingPrincipalRaw);
  const remaining = BigInt(lockedRemainingRaw);
  if (remaining > total || remaining === 0n) return 0n;
  const elapsed = Math.max(0, Math.min(vestingSeconds, Math.floor(nowSec) - vestingStartAt));
  const delta = total * BigInt(elapsed) / BigInt(vestingSeconds) - (total - remaining);
  return delta > 0n ? delta : 0n;
}

/** 按所选票据精确试算「今天 / 第 7 天 / 第 14 天」急提结果（扣除已领取部分，严格区分今日实得与未来试算） */
export function simulateTicketCashoutAtDay(ticket, dayPreset = 'today', nowSec = Math.floor(serverNowMs() / 1000)) {
  if (!ticket || ticket.forfeited) return null;
  const acc = resolveTicketAccounting(ticket);
  const rawOrZero = (v) => (/^\d+$/.test(String(v ?? '')) ? BigInt(String(v)) : 0n);
  const vestingSec = Number.isSafeInteger(ticket.vestingSeconds) && ticket.vestingSeconds > 0
    ? ticket.vestingSeconds
    : PROTOCOL_SPECS.linearVestingDays * 86400;
  const vestingStartAt = Number.isSafeInteger(ticket.vestingStartAt) && ticket.vestingStartAt > 0
    ? ticket.vestingStartAt
    : null;
  const vestingPrincipal = rawOrZero(ticket.vestingPrincipalRaw);
  const lockedRemaining = rawOrZero(acc.lockedRemainingRaw);
  const todayPayout = rawOrZero(acc.instantTotalRaw);
  const todayBurn = rawOrZero(acc.instantBurnRaw);
  const claimPrincipal = rawOrZero(acc.claimPrincipalRaw);
  const claimReward = rawOrZero(acc.claimRewardRaw);
  const lockedClaimed = rawOrZero(acc.lockedClaimedRaw);

  let currentElapsed = 0;
  if (vestingStartAt !== null) {
    currentElapsed = Math.max(0, Math.min(vestingSec, Math.floor(nowSec) - vestingStartAt));
  } else if (vestingPrincipal > 0n) {
    const vestedNow = vestingPrincipal > lockedRemaining ? (vestingPrincipal - lockedRemaining) : 0n;
    currentElapsed = Math.floor(Number((vestedNow * BigInt(vestingSec)) / vestingPrincipal));
  }
  const currentDay = (currentElapsed / vestingSec) * 14;

  if (dayPreset === 'today') {
    return {
      preset: 'today',
      isFuture: false,
      disabled: false,
      day: currentDay,
      payoutRaw: todayPayout.toString(),
      burnRaw: todayBurn.toString(),
      extraSavedRaw: '0',
    };
  }

  const targetDay = Number(dayPreset) === 7 ? 7 : 14;
  const targetElapsed = Math.round((vestingSec * targetDay) / 14);
  if (currentElapsed >= targetElapsed || vestingPrincipal <= 0n || lockedRemaining <= 0n) {
    return {
      preset: targetDay,
      isFuture: true,
      disabled: true,
      day: targetDay,
      payoutRaw: todayPayout.toString(),
      burnRaw: todayBurn.toString(),
      extraSavedRaw: '0',
    };
  }

  // 未领的 20% 即时奖励 = 当前可领奖金中扣除「当前已线性解锁但未领」的部分
  const vestedNow = vestingPrincipal > lockedRemaining ? (vestingPrincipal - lockedRemaining) : 0n;
  const claimableLinearNow = vestedNow > lockedClaimed ? (vestedNow - lockedClaimed) : 0n;
  const unclaimedImm = claimReward > claimableLinearNow ? (claimReward - claimableLinearNow) : 0n;

  const targetVested = (vestingPrincipal * BigInt(targetElapsed)) / BigInt(vestingSec);
  const unvestedAtTarget = vestingPrincipal > targetVested ? (vestingPrincipal - targetVested) : 0n;
  const claimableLinearAtTarget = targetVested > lockedClaimed ? (targetVested - lockedClaimed) : 0n;
  const instantBonusAtTarget = (unvestedAtTarget * 3000n) / 10000n;
  const burnAtTarget = unvestedAtTarget - instantBonusAtTarget;
  const payoutAtTarget = claimPrincipal + unclaimedImm + claimableLinearAtTarget + instantBonusAtTarget;
  const extraSaved = payoutAtTarget > todayPayout ? (payoutAtTarget - todayPayout) : 0n;

  return {
    preset: targetDay,
    isFuture: true,
    disabled: false,
    day: targetDay,
    payoutRaw: payoutAtTarget.toString(),
    burnRaw: burnAtTarget.toString(),
    extraSavedRaw: extraSaved.toString(),
  };
}

function buildInstantCurveSvg(currentDay = null, previewDay = null) {
  const x = day => 34 + 294 * day / 14;
  const y = pct => 104 - (pct - 20);
  const levels = [30, 65, 100].map(pct => `
    <line x1="34" x2="328" y1="${y(pct)}" y2="${y(pct)}" stroke="var(--q-line)"/>
    <text class="q-ch-lbl" x="29" y="${y(pct) + 4}" text-anchor="end">${pct}%</text>`).join('');
  const days = [0, 7, 14].map(day => `
    <text class="q-ch-lbl" x="${x(day)}" y="118" text-anchor="${day === 14 ? 'end' : 'middle'}">${L(`第 ${day} 天`, `Day ${day}`)}</text>`).join('');
  const validDay = typeof currentDay === 'number' && Number.isFinite(currentDay) && currentDay >= 0 && currentDay <= 14 ? currentDay : null;
  const lockedToday = validDay !== null ? 30 + (70 * validDay / 14) : null;
  const totalToday = validDay !== null ? 44 + (56 * validDay / 14) : null;
  const marker = validDay !== null ? `
    <line x1="${x(validDay).toFixed(1)}" x2="${x(validDay).toFixed(1)}" y1="24" y2="104" stroke="var(--q-red)" stroke-width="1.5" stroke-dasharray="3 3"/>
    <circle cx="${x(validDay).toFixed(1)}" cy="${y(lockedToday).toFixed(1)}" r="4.5" fill="var(--q-yellow-ink)" stroke="var(--q-surface)" stroke-width="1.5"/>
    <circle cx="${x(validDay).toFixed(1)}" cy="${y(totalToday).toFixed(1)}" r="4.5" fill="var(--q-blue)" stroke="var(--q-surface)" stroke-width="1.5"/>` : '';
  const validPreview = typeof previewDay === 'number' && Number.isFinite(previewDay) && previewDay >= 0 && previewDay <= 14 ? previewDay : null;
  const previewMarker = validPreview !== null ? `
    <line x1="${x(validPreview).toFixed(1)}" x2="${x(validPreview).toFixed(1)}" y1="24" y2="104" stroke="var(--q-blue-ink)" stroke-width="2" stroke-dasharray="2 2"/>
    <circle cx="${x(validPreview).toFixed(1)}" cy="${y(44 + 56 * validPreview / 14).toFixed(1)}" r="5" fill="var(--q-surface)" stroke="var(--q-blue-ink)" stroke-width="2"/>` : '';
  const markers = [0, 7, 14].map(day => `
    <line x1="${x(day)}" x2="${x(day)}" y1="24" y2="104" stroke="var(--q-line)"/>
    <circle cx="${x(day)}" cy="${y(30 + 70 * day / 14)}" r="3" fill="var(--q-yellow-ink)"/>
    <circle cx="${x(day)}" cy="${y(44 + 56 * day / 14)}" r="3" fill="var(--q-blue)"/>`).join('');
  const label = L('第 0、7、14 天急提的累计可得比例。锁定奖金为 30%、65%、100%。整笔奖金为 44%、72%、100%。', 'Cumulative cashout share on days 0, 7 and 14. Locked reward: 30%, 65%, 100%. Total reward: 44%, 72%, 100%.');
  const selection = validPreview !== null ? L(`试算选中第 ${validPreview} 天。`, ` Forecast selected: day ${validPreview}.`) : '';
  return `<svg role="img" viewBox="0 0 340 124" aria-label="${escapeHtml(label + selection)}">
    ${levels}${days}
    <path d="M34 ${y(30)} L328 ${y(100)} V104 H34Z" fill="var(--q-yellow)" opacity=".14"/>
    <path d="M34 ${y(30)} L328 ${y(100)}" stroke="var(--q-yellow-ink)" stroke-width="3"/>
    <path d="M34 ${y(44)} L328 ${y(100)}" stroke="var(--q-blue)" stroke-width="3" stroke-dasharray="5 4"/>
    ${markers}
    ${marker}
    ${previewMarker}
    </svg>`;
}

/** 构建单票据 3 折急提报价快照（字段缺失绝不按零销毁处理，成熟票据引导普通领取） */
export function buildInstantCashoutQuote(ticket) {
  if (!ticket || !ticket.ticketAddress) return { valid: false, reason: 'MISSING_TICKET' };
  if (ticket.pending === true || ticket.forfeited === true || ticket.exited === true) return { valid: false, reason: 'UNACTIONABLE' };
  const isDigits = (v) => typeof v === 'string' && /^\d+$/.test(v);
  const lockedRaw = ticket.lockedRemainingRaw;
  const claimTotalRaw = ticket.claimableTotalRaw;
  if (isDigits(lockedRaw) && BigInt(lockedRaw) === 0n) {
    if (ticket.canClaim && isDigits(claimTotalRaw) && BigInt(claimTotalRaw) > 0n) {
      return { valid: false, reason: 'MATURED_USE_NORMAL_CLAIM' };
    }
    return { valid: false, reason: 'UNACTIONABLE' };
  }
  if (!ticket.canInstantCashout) {
    if (ticket.canClaim && isDigits(claimTotalRaw) && BigInt(claimTotalRaw) > 0n) {
      return { valid: false, reason: 'MATURED_USE_NORMAL_CLAIM' };
    }
    return { valid: false, reason: 'UNACTIONABLE' };
  }
  const reqFields = [
    ticket.instantCashoutTotalRaw,
    ticket.instantCashoutBurnRaw,
    ticket.lockedRemainingRaw,
    ticket.claimablePrincipalRaw,
    ticket.claimableRewardRaw,
  ];
  if (!reqFields.every(isDigits)) {
    return { valid: false, reason: 'MISSING_FIELDS' };
  }
  const lockedBi = BigInt(ticket.lockedRemainingRaw);
  const totalBi = BigInt(ticket.instantCashoutTotalRaw);
  const burnBi = BigInt(ticket.instantCashoutBurnRaw);
  if (lockedBi <= 0n || totalBi <= 0n || burnBi <= 0n) {
    return { valid: false, reason: 'MISSING_FIELDS' };
  }
  const principalRaw = ticket.claimablePrincipalRaw;
  const claimRewardRaw = ticket.claimableRewardRaw;
  const waitExtraRaw = burnBi.toString();
  const quoteKey = `${ticket.ticketAddress}|${ticket.instantCashoutTotalRaw}|${ticket.instantCashoutBurnRaw}|${ticket.lockedRemainingRaw}|${principalRaw}|${claimRewardRaw}`;
  return {
    valid: true,
    reason: 'OK',
    ticketAddress: ticket.ticketAddress,
    roundId: ticket.roundId ?? '—',
    instantTotalRaw: ticket.instantCashoutTotalRaw,
    claimPrincipalRaw: principalRaw,
    claimRewardRaw,
    lockedRemainingRaw: ticket.lockedRemainingRaw,
    instantBurnRaw: ticket.instantCashoutBurnRaw,
    waitExtraRaw,
    quoteKey,
  };
}

// Time alone moves rewards from locked to claimable, without changing the ticket's total entitlement.
export function cashoutQuoteStillApplies(ticket, quote, latestTicket, latestQuote) {
  if (!latestQuote?.valid || !latestTicket) return false;
  const stableFields = [
    'ticketAddress', 'roundId', 'roundState', 'amountRaw', 'dynamicVesting', 'vestingSeconds',
    'vestingPrincipalRaw', 'principalDone', 'immediateClaimed', 'lockedClaimedRaw',
  ];
  if (stableFields.some(key => ticket[key] !== latestTicket[key])) return false;
  if (ticket.dynamicVesting !== false && ticket.vestingStartAt !== latestTicket.vestingStartAt) return false;
  if (latestQuote.quoteKey === quote.quoteKey) return true;
  const released = BigInt(quote.lockedRemainingRaw) - BigInt(latestQuote.lockedRemainingRaw);
  const remaining = BigInt(latestQuote.lockedRemainingRaw);
  const reducedPayout = remaining * 3000n / 10000n;
  return released > 0n && latestQuote.claimPrincipalRaw === quote.claimPrincipalRaw &&
    BigInt(latestQuote.claimRewardRaw) - BigInt(quote.claimRewardRaw) === released &&
    BigInt(latestQuote.instantBurnRaw) <= BigInt(quote.instantBurnRaw) &&
    BigInt(latestQuote.instantTotalRaw) >= BigInt(quote.instantTotalRaw) &&
    BigInt(latestQuote.instantBurnRaw) === remaining - reducedPayout &&
    BigInt(latestQuote.instantTotalRaw) + BigInt(latestQuote.instantBurnRaw) ===
      BigInt(quote.instantTotalRaw) + BigInt(quote.instantBurnRaw);
}

/** 渲染 Tab 2 · 金库主视图 */
export function renderVaultView(root, _navigate, _param = null, query = {}) {
  const seq = ++vaultViewSeq;
  const isLive = !config.isDemo;
  const selectedTicket = query?.ticket || null;

  const state = {
    loading: isLive && Boolean(store.state.user.connected && store.state.user.address),
    portfolio: null,
    portfolioError: null,
    promo: null,
    promoError: null,
    promoNeedsVerification: false,
    busyTicket: null,
    promoBusy: false,
    activationBusy: false,
    pendingReward: null,
    selectedTicketAddr: selectedTicket,
    curvePreset: 'today',
    curveExpanded: false,
    ticketFilter: 'all',
    lastWallet: store.state.user.connected ? store.state.user.address : null,
    fetchedAtMs: serverNowMs(),
  };

  let tickerTimer = null;
  let loadSeq = 0;

  const getTicketsAndTotals = () => {
    const u = store.state.user;
    if (!isLive) {
      const isEmpty = u.profileMode === 'empty';
      const demoMod = peekDemoModule();
      const nowSec = Math.floor(serverNowMs() / 1000);
      const tickets = (!isEmpty && demoMod?.demoBuildVaultTickets)
        ? demoMod.demoBuildVaultTickets(store.state, nowSec)
        : [];
      const promoClaimable = isEmpty ? 0 : (finiteOrNull(u.promoClaimableA9) ?? 0);
      let claimableBi = 0n;
      let lockedBi = 0n;
      let perSec = 0;
      let totalLinear = 0n;
      let vestedLinear = 0n;
      for (const ticket of tickets) {
        if (/^\d+$/.test(String(ticket.claimableTotalRaw ?? ''))) claimableBi += BigInt(ticket.claimableTotalRaw);
        if (/^\d+$/.test(String(ticket.lockedRemainingRaw ?? ''))) lockedBi += BigInt(ticket.lockedRemainingRaw);
        if (ticket.forfeited || !/^\d+$/.test(String(ticket.vestingPrincipalRaw ?? '')) ||
            !/^\d+$/.test(String(ticket.lockedRemainingRaw ?? '')) || !(ticket.vestingSeconds > 0)) continue;
        const total = BigInt(ticket.vestingPrincipalRaw);
        const remaining = BigInt(ticket.lockedRemainingRaw);
        if (remaining > total) continue;
        totalLinear += total;
        vestedLinear += total - remaining;
        if (ticket.dynamicVesting === true && remaining > 0n) perSec += rawToA9(total.toString()) / ticket.vestingSeconds;
      }
      return {
        hasWallet: true,
        tickets,
        claimableRaw: isEmpty ? '0' : claimableBi.toString(),
        lockedRaw: isEmpty ? '0' : lockedBi.toString(),
        promoClaimableRaw: null,
        promoClaimable,
        perSec: isEmpty ? 0 : perSec,
        avgProgress: totalLinear > 0n ? Number(vestedLinear * 10000n / totalLinear) / 10000 : null,
      };
    }

    const hasWallet = Boolean(u.connected && u.address);
    const ready = Boolean(!state.portfolioError && state.portfolio?.ticketsAvailable === true);
    const tickets = ready && Array.isArray(state.portfolio?.tickets) ? [...state.portfolio.tickets] : [];
    if (selectedTicket) {
      tickets.sort((a, b) => Number(b.ticketAddress === selectedTicket) - Number(a.ticketAddress === selectedTicket));
    }
    const claimableRaw = ready ? state.portfolio.claimableRaw : null;
    const lockedRaw = ready ? state.portfolio.lockedRaw : null;
    const promoClaimableRaw = state.promo && !state.promoError ? state.promo.claimableRaw ?? state.promo.availableRaw : null;

    let perSec = 0;
    let totalLinear = 0n;
    let vestedLinear = 0n;
    for (const ticket of tickets) {
      if (ticket.forfeited || !/^\d+$/.test(ticket.vestingPrincipalRaw) ||
          !/^\d+$/.test(ticket.lockedRemainingRaw) || !(ticket.vestingSeconds > 0)) continue;
      const total = BigInt(ticket.vestingPrincipalRaw);
      const remaining = BigInt(ticket.lockedRemainingRaw);
      if (remaining > total) continue;
      totalLinear += total;
      vestedLinear += total - remaining;
      if (remaining > 0n) perSec += rawToA9(total.toString()) / ticket.vestingSeconds;
    }

    return {
      hasWallet,
      tickets,
      claimableRaw,
      lockedRaw,
      promoClaimableRaw,
      promoClaimable: rawToA9(promoClaimableRaw),
      perSec,
      avgProgress: totalLinear > 0n ? Number(vestedLinear * 10000n / totalLinear) / 10000 : null,
    };
  };

  const readFreshTicket = async (wallet, selected) => {
    const range = { fromRound: selected.roundId, toRound: selected.roundId, fresh: true };
    const portfolio = await fetchUserPortfolio(wallet, range);
    return portfolio?.ticketsAvailable === true
      ? portfolio.tickets?.find((t) => t.ticketAddress === selected.ticketAddress) || null
      : null;
  };

  const readFreshDemoTicket = async (selected, nowSec) => {
    const demoMod = peekDemoModule() || await loadDemoModule();
    return demoMod?.demoBuildVaultTickets?.(store.state, nowSec)
      ?.find((t) => t.ticketAddress === selected.ticketAddress) || null;
  };

  const executeTicket = async (selected, instantDiscount = false, lockedQuote = null) => {
    if (!selected?.ticketAddress || state.busyTicket || pendingTxManager.isLocked() || !store.fundsEnabled) return;
    const wallet = store.state.user.address;
    const actionNowSec = lockedQuote?.quotedAtSec ?? Math.floor(serverNowMs() / 1000);
    state.busyTicket = selected.ticketAddress;
    paint();
    try {
      let ticket = selected;
      let quote = lockedQuote;
      if (instantDiscount) {
        if (!quote) {
          ticket = isLive ? await readFreshTicket(wallet, selected) : await readFreshDemoTicket(selected, actionNowSec);
          quote = buildInstantCashoutQuote(ticket);
        }
        if (wallet !== store.state.user.address || !ticket || !quote?.valid) {
          if (quote?.reason === 'MATURED_USE_NORMAL_CLAIM') {
            showToast(L('该票据已满期解锁，请直接使用普通领取，无需急提销毁', 'Ticket is fully vested; use normal Claim with zero burn'), 'amber');
            void loadAll();
            return;
          }
          throw new Error(L('急提报价字段缺失或票据状态已更新，已中止并请刷新重试', 'Cashout quote incomplete or ticket changed. Refresh and retry.'));
        }
      } else {
        ticket = isLive ? await readFreshTicket(wallet, selected) : await readFreshDemoTicket(selected, actionNowSec);
        if (wallet !== store.state.user.address || !ticket || ticket.pending || !ticket.canClaim) {
          throw new Error(L('票据状态已更新，请刷新后重试', 'Ticket changed. Refresh and try again.'));
        }
      }
      const payout = formatRoundA9(instantDiscount ? quote.instantTotalRaw : ticket.claimableTotalRaw);
      const gas = instantDiscount ? PROTOCOL_SPECS.dualClaimGasGram : PROTOCOL_SPECS.claimGasGram;
      const action = instantDiscount ? L('3 折急提', 'Instant cashout') : L('领取', 'Claim');
      const accepted = await tonConnect.confirmBeforeSign({
        title: L(`第 ${ticket.roundId} 关 · ${action}`, `Stage ${ticket.roundId} · ${action}`),
        contractLabel: 'Round Ticket',
        targetAddress: ticket.ticketAddress,
        principalText: payout,
        gasText: `${gas.toFixed(2)} GRAM`,
        totalText: `${gas.toFixed(2)} GRAM`,
        note: instantDiscount
          ? L(
              `本次报价 ${payout}（其中本金 ${formatRoundA9(quote.claimPrincipalRaw)}）；预计销毁 ${formatRoundA9(quote.instantBurnRaw)}。继续解锁只会增加实得、减少销毁，金额以结算为准。`,
              `Quoted payout ${payout} (principal ${formatRoundA9(quote.claimPrincipalRaw)}); estimated burn ${formatRoundA9(quote.instantBurnRaw)}. Further vesting increases payout and reduces burn. Final amounts are calculated at settlement.`
            )
          : L(`可领本金 ${formatRoundA9(ticket.claimablePrincipalRaw)}，奖金 ${formatRoundA9(ticket.claimableRewardRaw)}。`, `Principal ${formatRoundA9(ticket.claimablePrincipalRaw)}, reward ${formatRoundA9(ticket.claimableRewardRaw)}.`),
      });
      if (!accepted || wallet !== store.state.user.address || pendingTxManager.isLocked() || !store.fundsEnabled) return;
      if (instantDiscount) {
        const latestTicket = isLive
          ? await readFreshTicket(wallet, ticket)
          : await readFreshDemoTicket(ticket, Math.floor(serverNowMs() / 1000));
        const latestQuote = buildInstantCashoutQuote(latestTicket);
        if (seq !== vaultViewSeq || !root.isConnected || wallet !== store.state.user.address ||
            pendingTxManager.isLocked() || !store.fundsEnabled ||
            !cashoutQuoteStillApplies(ticket, quote, latestTicket, latestQuote)) {
          const msg = latestQuote.reason === 'MATURED_USE_NORMAL_CLAIM'
            ? L('该票据已满期解锁，请直接普通领取', 'Ticket matured. Use normal Claim.')
            : L('票据状态或急提报价已失效，请刷新后确认', 'Ticket or cashout quote changed. Refresh and confirm.');
          showToast(msg, 'amber');
          void loadAll();
          return;
        }
        if (isLive) ticket = latestTicket;
      }
      if (!isLive) {
        const demoMod = await loadDemoModule();
        const paid = instantDiscount
          ? demoMod.demoInstantClaim(store.state, ticket.ticketAddress, actionNowSec)
          : demoMod.demoFundsClaim(store.state, ticket.ticketAddress, actionNowSec);
        if (paid != null && paid > 0) {
          store.notify();
          showToast(L(`演示到账 ${fmtExactA9(paid)}`, `Demo credited ${fmtExactA9(paid)}`));
        }
        return;
      }
      await tonConnect.sendV15TicketClaim(ticket.ticketAddress, BigInt(Date.now()), { instantDiscount });
      const tx = pendingTxManager.start({ kind: instantDiscount ? 'claim_instant' : 'claim',
        title: `第 ${ticket.roundId} 关 · ${action}`, titleEn: `Stage ${ticket.roundId} claim`,
        amountText: payout, explorerAddress: ticket.ticketAddress, targetRoute: '/rewards' });
      void pendingTxManager.pollUntilConfirmed({
        txId: tx.id,
        checkFn: async () => {
          const next = await readFreshTicket(wallet, ticket);
          if (!next || next.pending) return false;
          if (instantDiscount) return next.forfeited === true;
          return (!ticket.principalDone && next.principalDone) || (!ticket.immediateClaimed && next.immediateClaimed) ||
            BigInt(next.lockedClaimedRaw ?? 0) > BigInt(ticket.lockedClaimedRaw ?? 0);
        },
        onConfirmed: () => { if (root.isConnected) void loadAll(); },
      });
      showToast(L('交易已提交，等待链上确认', 'Transaction submitted. Awaiting confirmation.'));
    } catch (error) {
      showToast(error.message || L('读取或签名失败，请重试', 'Read or signing failed. Please retry.'), 'error');
    } finally {
      state.busyTicket = null;
      paint();
    }
  };

  /** 第一层急提损益账单弹层：固定同一张票据、同一份报价快照，与第二层签名前确认严格一致 */
  const openInstantCashoutSheet = async (selected) => {
    if (!selected?.ticketAddress || state.busyTicket || pendingTxManager.isLocked() || !store.fundsEnabled) return;
    const wallet = store.state.user.address;
    const quotedAtSec = Math.floor(serverNowMs() / 1000);
    let freshTicket = selected;
    if (isLive) {
      state.busyTicket = selected.ticketAddress;
      paint();
      try {
        freshTicket = await readFreshTicket(wallet, selected);
      } catch (e) {
        showToast(e?.message || L('读取票据最新报价失败，请重试', 'Failed to read latest ticket quote'), 'error');
        state.busyTicket = null;
        paint();
        return;
      } finally {
        state.busyTicket = null;
        paint();
      }
    } else {
      freshTicket = (await readFreshDemoTicket(selected, quotedAtSec)) || selected;
    }
    if (seq !== vaultViewSeq || !root.isConnected || wallet !== store.state.user.address) return;
    const quote = buildInstantCashoutQuote(freshTicket);
    if (quote.reason === 'MATURED_USE_NORMAL_CLAIM') {
      openQuestSheet(
        L(`第 ${freshTicket?.roundId ?? '—'} 关 · 已满期解锁`, `Stage ${freshTicket?.roundId ?? '—'} · Fully Vested`),
        `
          <div class="q-notice blue" style="margin-bottom:10px;">
            ${qIcon('shield', 16)}
            <span>${L('该票据 14 天锁定奖金已全部解锁，直接普通领取即可 100% 到账、零销毁。', 'This ticket is fully vested. Use normal Claim for 100% payout with zero burn.')}</span>
          </div>
        `,
        {
          footHtml: `<button type="button" class="q-btn q-btn-blue q-btn-block" id="q-matured-normal-claim">${L('改用普通领取（零销毁）', 'Claim Normally (0 Burn)')}</button>`,
        }
      );
      const normalBtn = document.getElementById('q-matured-normal-claim');
      if (normalBtn) {
        normalBtn.onclick = () => {
          closeModal();
          void executeTicket(freshTicket, false);
        };
      }
      return;
    }
    if (!quote.valid) {
      showToast(L('急提报价字段不完整或票据状态已变更，请刷新后重试', 'Cashout quote unavailable or ticket updated; please refresh'), 'error');
      void loadAll();
      return;
    }

    const burnStr = formatRoundA9(quote.instantBurnRaw);
    const totalStr = formatRoundA9(quote.instantTotalRaw);
    const principalStr = formatRoundA9(quote.claimPrincipalRaw);
    const waitExtraStr = formatRoundA9(quote.waitExtraRaw);
    const gasStr = `${PROTOCOL_SPECS.dualClaimGasGram.toFixed(2)} GRAM`;

    openQuestSheet(
      L(`第 ${quote.roundId} 关 · 3 折急提损益账单`, `Stage ${quote.roundId} · Instant Cashout Bill`),
      `
        <div id="q-instant-cashout-sheet" data-quote-key="${escapeHtml(quote.quoteKey)}">
          <div class="q-notice red" style="margin-bottom:10px;">
            ${qIcon('bolt', 16)}
            <span>${L('70% 销毁仅作用于尚未解锁的奖金，链上执行后不可撤销；本金 100% 不打折。', '70% burn applies only to unvested rewards and is irreversible on-chain; principal stays 100% intact.')}</span>
          </div>
          <div class="q-kv"><span>${L('预计实得总额', 'Estimated Payout')}</span><b class="q-num green" id="q-cashout-payout">${escapeHtml(totalStr)}</b></div>
          <div class="q-kv"><span>${L('其中本金（100% 不打折）', 'Principal (100% Intact)')}</span><b class="q-num" id="q-cashout-principal">${escapeHtml(principalStr)}</b></div>
          <div class="q-kv"><span>${L('永久销毁（未解锁奖金 70%）', 'Permanently Burned (70% Unvested)')}</span><b class="q-num red" id="q-cashout-burn">${escapeHtml(burnStr)}</b></div>
          <div class="q-kv"><span>${L('等到满 14 天还能多领', 'Wait Until Day 14 for Extra')}</span><b class="q-num green" id="q-cashout-wait-extra">+${escapeHtml(waitExtraStr)}</b></div>
          <div class="q-kv"><span>${L('预付网络费', 'Network Gas')}</span><b class="q-num">${escapeHtml(gasStr)}</b></div>
        </div>
      `,
      {
        footHtml: `
          <div class="q-btn-row">
            <button type="button" class="q-btn q-btn-ghost q-btn-sm" id="q-cancel-instant-burn">${L('取消', 'Cancel')}</button>
            <button type="button" class="q-btn q-btn-red q-btn-sm q-grow" id="q-confirm-instant-burn">${L(`确认销毁 ${burnStr}`, `Confirm Burn ${burnStr}`)}</button>
          </div>
        `,
      }
    );

    const cancelBtn = document.getElementById('q-cancel-instant-burn');
    if (cancelBtn) cancelBtn.onclick = () => closeModal();
    const confirmBtn = document.getElementById('q-confirm-instant-burn');
    if (confirmBtn) {
      confirmBtn.onclick = () => {
        closeModal();
        void executeTicket(freshTicket, true, { ...quote, quotedAtSec });
      };
    }
  };

  /** 多票据时打开单票据选择器（绝不拼装多票据批量消息） */
  const openTicketPicker = (tickets, mode) => {
    const isInstant = mode === 'instant';
    openQuestSheet(
      isInstant ? L('选择单张票据发起 3 折急提', 'Select One Ticket for Instant Cashout') : L('选择单张票据发起领取', 'Select One Ticket to Claim'),
      `
        <div class="q-notice blue" style="margin-bottom:10px;">
          ${qIcon('shield', 16)}
          <span>${L('为保障合约签名安全，每次交易严格按单张票据逐张签名。', 'For contract safety, each signature executes one ticket at a time.')}</span>
        </div>
        ${tickets.map((t) => {
          const amount = formatRoundA9(isInstant ? t.instantCashoutTotalRaw : t.claimableTotalRaw);
          return `
            <div class="q-tk" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
              <div>
                <b>${L(`第 ${t.roundId ?? '—'} 关`, `Stage ${t.roundId ?? '—'}`)}</b>
                <div class="q-small q-muted">${isInstant ? L('预计秒到', 'Est. Instant') : L('当前可领', 'Claimable')} <b style="color:var(--q-ink);">${escapeHtml(amount)}</b></div>
              </div>
              <button type="button" class="q-btn q-btn-red q-btn-sm" data-pick-ticket="${escapeHtml(t.ticketAddress)}">${isInstant ? L('急提此张', 'Cashout') : L('领取此张', 'Claim')}</button>
            </div>
          `;
        }).join('')}
      `
    );
    document.querySelectorAll('[data-pick-ticket]').forEach((btn) => {
      btn.onclick = () => {
        if (state.busyTicket || pendingTxManager.isLocked()) return;
        const hit = tickets.find((item) => item.ticketAddress === btn.dataset.pickTicket);
        closeModal();
        if (hit) {
          if (isInstant) void openInstantCashoutSheet(hit);
          else void executeTicket(hit);
        }
      };
    });
  };

  const paint = () => {
    if (seq !== vaultViewSeq || !root.isConnected) return;
    if (tickerTimer) {
      clearInterval(tickerTimer);
      tickerTimer = null;
    }

    const d = getTicketsAndTotals();
    const claimableTickets = d.tickets.filter((t) => Boolean(t.canClaim) && !t.pending && (rawToA9(t.claimableTotalRaw) ?? 0) > 0);
    const instantTickets = d.tickets.filter((t) => Boolean(t.canInstantCashout) && !t.pending && (rawToA9(t.lockedRemainingRaw) ?? 0) > 0);
    const reward = state.pendingReward;
    const user = store.state.user;
    const hasPendingReward = reward && reward.wallet === (user.connected ? user.address : null) && reward.uid === getEffectiveUserId(user) &&
      /^\d+$/.test(reward.raw) && BigInt(reward.raw) > 0n;
    const isReadOnlyLive = isLive && !store.fundsEnabled;
    const isBusyAny = Boolean(state.busyTicket) || pendingTxManager.isLocked();

    const claimableParts = vaultTickerParts(d.claimableRaw);
    const promoAmount = isLive ? formatEstimatedA9(d.promoClaimableRaw) : fmtExactA9(d.promoClaimable);
    const vestingProgress = d.avgProgress === null ? null : d.avgProgress * 100;
    const rateText = d.perSec < 1e-9 ? '< 0.000000001' : `+${formatNum(d.perSec, d.perSec < 0.0001 ? 9 : 4)}`;
    const vestingTickets = d.tickets.filter((t) => !t.forfeited && (rawToA9(t.lockedRemainingRaw) ?? 0) > 0);
    const curveTicket = (state.selectedTicketAddr && d.tickets.find((t) => t.ticketAddress === state.selectedTicketAddr))
      || vestingTickets[0]
      || d.tickets[0]
      || null;
    const curveAcc = curveTicket ? resolveTicketAccounting(curveTicket) : null;
    let currentCurveDay = null;
    if (curveTicket && !curveTicket.forfeited) {
      if (Number.isSafeInteger(curveTicket.vestingStartAt) && curveTicket.vestingStartAt > 0 && Number.isSafeInteger(curveTicket.vestingSeconds) && curveTicket.vestingSeconds > 0) {
        const elapsed = Math.max(0, Math.min(curveTicket.vestingSeconds, Math.floor(serverNowMs() / 1000) - curveTicket.vestingStartAt));
        currentCurveDay = (elapsed / curveTicket.vestingSeconds) * 14;
      } else if (/^\d+$/.test(curveTicket.vestingPrincipalRaw) && /^\d+$/.test(curveTicket.lockedRemainingRaw)) {
        const total = BigInt(curveTicket.vestingPrincipalRaw);
        const remaining = BigInt(curveTicket.lockedRemainingRaw);
        if (total > 0n && remaining <= total) currentCurveDay = Number((total - remaining) * 14000n / total) / 1000;
      }
    }

    const showCurveBody = state.curveExpanded;

    root.innerHTML = `
      <div class="q-view" id="quest-vault-view">
        <section class="q-hero q-hero--blue">
          <span class="q-wm" style="font-size:92px;">${qIcon('vault', 100, 1.4)}</span>
          <div class="q-hero-top">
            <span class="q-cart-tag">${L('个人金库', 'VAULT')}</span>
            ${d.perSec > 0 ? `<span class="q-phase-pill"><i class="q-live-dot"></i>${L('逐秒解锁中', 'Vesting')}</span>` : ''}
          </div>
          <div class="q-hero-label">${L('轮次可领', 'Claimable from rounds')}</div>
          ${claimableParts ? `
            <div class="q-ticker">
              <b id="q-vault-int">${escapeHtml(claimableParts.whole)}</b><span id="q-vault-dec">${escapeHtml(claimableParts.fraction)}</span><em>A9</em>
            </div>
          ` : `<div class="q-ticker q-ticker-empty">${state.loading ? L('加载中…', 'Loading…') : '—'}</div>`}
          ${claimableParts && d.perSec > 0 ? `<div class="q-v-rate"><span id="q-vault-rate">${escapeHtml(rateText)}</span> A9 / ${L('秒', 's')}</div>` : ''}
          <div class="q-v-strip" id="q-vault-overview-strip">
            <div><small>${L('待解锁', 'Unvested')}</small><b>${escapeHtml(formatEstimatedA9(d.lockedRaw))}</b></div>
            <div><small>${L('已解锁进度', 'Vested')}</small><b>${vestingProgress === null ? '—' : `${vestingProgress.toFixed(1)}%`}</b>${vestingProgress === null ? '' : `<div class="q-v-progress" aria-hidden="true"><i style="width:${vestingProgress}%"></i></div>`}</div>
            <div><small>${L('推广余额', 'Promo balance')}</small><b>${escapeHtml(promoAmount)}</b></div>
          </div>
          <div class="q-hero-ctas">
            ${!d.hasWallet ? `
              <button class="q-btn q-btn-white is-blue q-btn-block" id="q-vault-connect" type="button">${qIcon('wallet', 18)} ${L('连接钱包查看金库', 'Connect Wallet')}</button>
            ` : `
              <button class="q-btn q-btn-white is-blue q-grow" id="q-vault-claim-hero" type="button" ${isReadOnlyLive || isBusyAny || claimableTickets.length === 0 ? 'disabled' : ''}>
                ${qIcon('unlock', 18)} ${isReadOnlyLive ? L('只读 · 暂不可领', 'Read-Only') : isBusyAny ? L('核验中…', 'Verifying…') : L('领取', 'Claim')}
              </button>
              <button class="q-btn q-btn-glass" id="q-vault-instant-hero" type="button" ${isReadOnlyLive || isBusyAny || instantTickets.length === 0 ? 'disabled' : ''}>
                ${qIcon('bolt', 17)} ${L('3 折急提', 'Instant 30%')}
              </button>
            `}
          </div>
        </section>

        ${state.portfolioError ? `
          <div class="q-notice red">
            ${qIcon('info', 16)}
            <span class="q-grow">${escapeHtml(state.portfolioError)}</span>
            <button type="button" class="q-btn q-btn-ghost q-btn-sm" id="q-vault-retry">${L('重试', 'Retry')}</button>
          </div>
        ` : ''}

        <section class="q-card" id="q-tickets-card">
          <div class="q-card-h">
            <h3>${qIcon('book', 18)} ${L('轮次票据', 'Round Tickets')}</h3>
            ${d.hasWallet && !state.loading && !state.portfolioError ? `<span class="q-chip">${d.tickets.length} ${L('张', 'Tickets')}</span>` : ''}
          </div>
          ${(() => {
            if (!d.hasWallet) {
              return `<div class="q-small q-muted">${L('连接钱包后查看票据。', 'Connect your wallet to view tickets.')}</div>`;
            }
            if (state.loading || state.portfolioError) {
              return `<div class="q-small q-muted">${state.loading
                ? L('读取票据中…', 'Loading tickets…')
                : L('票据状态暂不可用，重试后查看。', 'Ticket status is unavailable. Retry to view tickets.')}</div>`;
            }
            if (d.tickets.length === 0) {
              return `<div class="q-small q-muted">${L('暂无票据。参与锁仓后可查看。', 'Tickets appear after locking A9.')}</div>`;
            }
            const enriched = d.tickets.map((t) => {
              const st = deriveRoundUiState({ detail: { rawState: t.roundState }, user: { connected: true }, serverNowMs: serverNowMs() }).stage;
              const acc = resolveTicketAccounting(t);
              const canClaim = Boolean(t.canClaim) && !t.pending && BigInt(acc.claimTotalRaw) > 0n;
              const canInstant = Boolean(t.canInstantCashout) && !t.pending && BigInt(acc.lockedRemainingRaw) > 0n;
              const isCleared = Boolean(!canClaim && !canInstant && (t.exited || t.forfeited || (t.principalDone && BigInt(acc.lockedRemainingRaw) <= 0n)));
              return { t, st, acc, canClaim, canInstant, isCleared };
            });
            const actionableCount = enriched.filter((x) => !x.isCleared).length;
            const clearedCount = enriched.filter((x) => x.isCleared).length;
            const activeFilter = d.tickets.length > 1 ? state.ticketFilter : 'all';
            const visible = activeFilter === 'actionable'
              ? enriched.filter((x) => !x.isCleared)
              : activeFilter === 'cleared'
                ? enriched.filter((x) => x.isCleared)
                : enriched;
            const filterHtml = d.tickets.length > 1 ? `
              <div class="q-tk-filters" id="q-ticket-filters" role="group" aria-label="${L('票据筛选', 'Filter tickets')}">
                <button type="button" data-q-tk-filter="all" class="${activeFilter === 'all' ? 'is-active' : ''}" aria-pressed="${activeFilter === 'all' ? 'true' : 'false'}">${L(`全部 (${enriched.length})`, `All (${enriched.length})`)}</button>
                <button type="button" data-q-tk-filter="actionable" class="${activeFilter === 'actionable' ? 'is-active' : ''}" aria-pressed="${activeFilter === 'actionable' ? 'true' : 'false'}">${L(`可操作 (${actionableCount})`, `Active (${actionableCount})`)}</button>
                <button type="button" data-q-tk-filter="cleared" class="${activeFilter === 'cleared' ? 'is-active' : ''}" aria-pressed="${activeFilter === 'cleared' ? 'true' : 'false'}">${L(`已结清 (${clearedCount})`, `Cleared (${clearedCount})`)}</button>
              </div>
            ` : '';
            if (visible.length === 0) {
              return `${filterHtml}<div class="q-small q-muted">${L('当前筛选下暂无票据。', 'No tickets match this filter.')}</div>`;
            }
            return `${filterHtml}${visible.map(({ t, st, acc, canClaim, canInstant, isCleared }) => {
              const isBusy = state.busyTicket === t.ticketAddress;
              const isSelected = curveTicket?.ticketAddress === t.ticketAddress;
              const statusChip = isCleared
                ? `<span class="q-chip">${L('已结清', 'Cleared')}</span>`
                : st === 'passed'
                  ? `<span class="q-chip q-chip-green">${L('已通关', 'Passed')}</span>`
                  : st === 'failed'
                    ? `<span class="q-chip">${L('未达标 · 止损退本', 'Missed · Stop-Loss')}</span>`
                    : st === 'aborted'
                      ? `<span class="q-chip q-chip-yellow">${L('异常中止 · 100% 退本', 'Aborted · 100% Refund')}</span>`
                      : `<span class="q-chip q-chip-blue">${L('进行中', 'Active')}</span>`;
              const claimLabel = st === 'failed'
                ? L('可领取止损退本', 'Claim Stop-Loss')
                : st === 'aborted'
                  ? L('可领取 100% 本金', 'Refund 100%')
                  : L('领取', 'Claim');
              const ledgerItems = acc.forfeited
                ? [
                    { label: L('已结清额度', 'Settled Quota'), value: formatRoundA9(acc.settledQuotaTotalRaw), cls: 'is-wide' },
                    { label: L('实际到账', 'Actual Received'), value: acc.actualRewardReceivedRaw !== null ? formatRoundA9(acc.actualRewardReceivedRaw) : L('待核验', 'Unverified'), cls: acc.actualRewardReceivedRaw !== null ? 'is-green' : '' },
                    { label: L('已销毁', 'Burned'), value: acc.burnedLockedRaw !== null ? formatRoundA9(acc.burnedLockedRaw) : L('待核验', 'Unverified'), cls: acc.burnedLockedRaw !== null ? 'is-red' : '' },
                  ]
                : [
                    { label: L('秒提已领', 'Immediate claimed'), value: formatRoundA9(acc.immediateClaimedRaw), cls: '' },
                    { label: L('逐秒解锁已领', 'Vested claimed'), value: formatRoundA9(acc.actualLockedReceivedRaw), cls: '' },
                    { label: L('实际累计已领', 'Actual Claimed'), value: formatRoundA9(acc.actualRewardReceivedRaw), cls: 'is-wide' },
                  ];
              if (BigInt(acc.claimPrincipalRaw) > 0n) ledgerItems.push({ label: L('可领本金', 'Claimable Principal'), value: formatRoundA9(acc.claimPrincipalRaw), cls: '' });
              if (BigInt(acc.claimRewardRaw) > 0n) ledgerItems.push({ label: L('可领奖金', 'Claimable Reward'), value: formatRoundA9(acc.claimRewardRaw), cls: '' });
              if (canInstant) {
                ledgerItems.push({ label: L('急提后到账', 'After Cashout'), value: formatRoundA9(acc.instantTotalRaw), cls: 'is-green' });
                ledgerItems.push({ label: L('急提销毁', 'Cashout Burn'), value: formatRoundA9(acc.instantBurnRaw), cls: 'is-red' });
              }
              if (st === 'failed' && BigInt(acc.burnedPrincipalRaw) > 0n) {
                ledgerItems.push({ label: L('止损销毁', 'Stop-Loss Burn'), value: formatRoundA9(acc.burnedPrincipalRaw), cls: 'is-red' });
              }
              const gasText = `${L('预付网络费', 'Network gas')} ${PROTOCOL_SPECS.claimGasGram.toFixed(2)}${canInstant ? ` / ${PROTOCOL_SPECS.dualClaimGasGram.toFixed(2)}` : ''} GRAM`;

              return `
                <div class="q-tk ${isSelected ? 'is-selected' : ''}" data-ticket-addr="${escapeHtml(t.ticketAddress)}">
                  <div class="q-tk-h">
                    <b>${L(`第 ${t.roundId ?? '—'} 关`, `Stage ${t.roundId ?? '—'}`)}</b>
                    ${statusChip}
                  </div>
                  <div class="q-tk-g">
                    <div>${L('本金', 'Principal')}<b class="q-num">${escapeHtml(formatRoundA9(acc.principalRaw))}</b></div>
                    <div>${L('现在可领', 'Claimable')}<b class="q-num" data-q-tk-claimable="${escapeHtml(t.ticketAddress)}">${escapeHtml(formatEstimatedA9(acc.claimTotalRaw))}</b></div>
                    <div>${L('尚未解锁', 'Unvested')}<b class="q-num" data-q-tk-unvested="${escapeHtml(t.ticketAddress)}">${escapeHtml(formatEstimatedA9(acc.lockedRemainingRaw))}</b></div>
                  </div>
                  <dl class="q-tk-ledger">${ledgerItems.map((it) => `<div class="q-tk-ledger-i ${it.cls}"><dt>${escapeHtml(it.label)}</dt><dd>${escapeHtml(it.value)}</dd></div>`).join('')}</dl>
                  ${canClaim || canInstant ? `<div class="q-tk-gas">${escapeHtml(gasText)}</div>` : ''}
                  <div class="q-tk-actions">
                    <button type="button" class="q-btn q-btn-red q-btn-sm q-grow" data-q-tk-claim="${escapeHtml(t.ticketAddress)}" ${isReadOnlyLive || !canClaim || isBusy ? 'disabled' : ''}>
                      ${isBusy ? L('签名中…', 'Signing…') : isCleared ? L('已结清', 'Cleared') : claimLabel}
                    </button>
                    ${canInstant ? `
                      <button type="button" class="q-btn q-btn-ghost q-btn-sm" data-q-tk-instant="${escapeHtml(t.ticketAddress)}" ${isReadOnlyLive || isBusy ? 'disabled' : ''}>
                        ${L('3 折急提', 'Instant 30%')}
                      </button>
                    ` : ''}
                  </div>
                </div>
              `;
            }).join('')}`;
          })()}
        </section>

        <section class="q-card" id="q-promo-vault-card">
          <div class="q-card-h">
            <h3>${qIcon('gift', 18)} ${L('推广与待激活余额', 'Promo & Pending Rewards')}</h3>
            <span class="q-chip q-chip-green q-num">${escapeHtml(promoAmount)}</span>
          </div>
          ${state.promoError ? `
            <div class="q-notice red" id="q-promo-error-banner" style="margin-bottom:10px;">
              ${qIcon('info', 16)}
              <span class="q-grow">${escapeHtml(state.promoError)}</span>
              ${state.promoNeedsVerification
                ? `<button type="button" class="q-btn q-btn-ghost q-btn-sm" id="q-promo-verify">${L('验证钱包', 'Verify Wallet')}</button>`
                : `<button type="button" class="q-btn q-btn-ghost q-btn-sm" id="q-promo-retry">${L('重试', 'Retry')}</button>`}
            </div>
          ` : ''}
          ${hasPendingReward ? `
            <div class="q-pending-bar" id="q-pending-reward">
              <div>
                <b class="q-num" style="font-size:13px;">${L('待激活', 'Pending')} ${escapeHtml(formatRoundA9(reward.raw))}</b>
                <small>${L('购箱、持票或直邀好友购箱即可激活至推广余额', 'Activate via chest purchase, round ticket, or direct invitee purchase')}</small>
              </div>
              <button class="q-btn q-btn-blue q-btn-sm" type="button" id="q-activate-reward" ${isReadOnlyLive || state.activationBusy ? 'disabled' : ''}>
                ${isReadOnlyLive ? L('只读', 'Read-only') : state.activationBusy ? L('激活中…', 'Activating…') : !d.hasWallet ? L('连接钱包', 'Connect') : L('激活', 'Activate')}
              </button>
            </div>
          ` : ''}
          ${(() => {
            const promoTxLocked = pendingTxManager.isLocked();
            const promoDisabled = isReadOnlyLive || !d.hasWallet || state.promoBusy || promoTxLocked || Boolean(state.promoError) || !(finiteOrNull(d.promoClaimable) > 0);
            const promoDisableReason = isReadOnlyLive
              ? L('当前只读验收态，推广领币暂未开放', 'Read-only mode; promo claims disabled')
              : !d.hasWallet
                ? L('请先连接钱包后领取', 'Connect wallet first to claim')
                : promoTxLocked
                  ? L('当前有在途交易确认中，完成后可发起推广领币', 'Another transaction is in progress; wait for confirmation before claiming')
                  : state.promoError
                    ? L('推广余额读取失败，请先点击上方重试', 'Promo balance failed to load; retry above')
                    : !(finiteOrNull(d.promoClaimable) > 0)
                      ? L('当前无可领推广余额', 'No claimable promo balance')
                      : '';
            return `
              <button class="q-btn q-btn-blue q-btn-block q-btn-sm" id="q-claim-promo-btn" type="button" ${promoDisabled ? 'disabled' : ''}>
                ${qIcon('wallet', 16)} ${state.promoBusy ? L('准备支付单中…', 'Preparing Claim…') : L('0.06 GRAM 一键领币', 'Claim via 0.06 GRAM')}
              </button>
              ${promoDisabled && promoDisableReason ? `<div class="q-small q-muted" id="q-claim-promo-reason" style="margin-top:6px;">${escapeHtml(promoDisableReason)}</div>` : ''}
            `;
          })()}
        </section>

        <section class="q-card" id="q-instant-curve-card" data-curve-ticket="${escapeHtml(curveTicket?.ticketAddress || '')}" data-curve-round="${escapeHtml(String(curveTicket?.roundId ?? ''))}" data-curve-expanded="${showCurveBody ? '1' : '0'}">
          <div class="q-card-h">
            <h3>${qIcon('bolt', 18)} ${curveTicket ? L(`急提价值曲线 · 第 ${curveTicket.roundId ?? '—'} 关`, `Cashout Curve · Stage ${curveTicket.roundId ?? '—'}`) : L('急提价值曲线', 'Instant Cashout Curve')}</h3>
            <button type="button" class="q-chip" id="q-toggle-curve" aria-expanded="${showCurveBody}">${showCurveBody ? L('收起', 'Hide') : L('展开试算 ›', 'Expand ›')}</button>
          </div>
          ${showCurveBody ? `
            ${d.tickets.length > 1 ? `
              <div class="q-row" style="flex-wrap:wrap;gap:6px;margin-bottom:8px;">
                ${d.tickets.map((tk) => `<button type="button" class="q-chip ${curveTicket?.ticketAddress === tk.ticketAddress ? 'q-chip-blue' : ''}" data-q-select-curve="${escapeHtml(tk.ticketAddress)}" style="border:0;cursor:pointer;">${L(`第 ${tk.roundId ?? '—'} 关`, `Stage ${tk.roundId ?? '—'}`)}</button>`).join('')}
              </div>
            ` : ''}
            ${(() => {
              const canSim = Boolean(curveTicket && curveAcc && !curveAcc.forfeited && BigInt(curveAcc.lockedRemainingRaw) > 0n);
              const nowSec = Math.floor(serverNowMs() / 1000);
              const sim7 = canSim ? simulateTicketCashoutAtDay(curveTicket, 7, nowSec) : null;
              const sim14 = canSim ? simulateTicketCashoutAtDay(curveTicket, 14, nowSec) : null;
              const activePreset = (state.curvePreset === 7 && sim7 && !sim7.disabled)
                ? 7
                : (state.curvePreset === 14 && sim14 && !sim14.disabled)
                  ? 14
                  : 'today';
              const activeSim = canSim ? simulateTicketCashoutAtDay(curveTicket, activePreset, nowSec) : null;
              const previewDay = activeSim?.isFuture ? activeSim.day : null;
              return `
                <div class="q-chart">${buildInstantCurveSvg(currentCurveDay, previewDay)}</div>
                <div class="q-curve-key">
                  <span>${L('锁定奖金（80%）', 'Locked reward (80%)')}<b>30% / 65% / 100%</b></span>
                  <span>${L('整笔奖金（含 20% 秒提）', 'Total reward (incl. 20%)')}<b>44% / 72% / 100%</b></span>
                </div>
                ${canSim ? `
                  <div class="q-tk-filters" id="q-curve-presets" style="margin-top:8px;margin-bottom:6px;" role="group" aria-label="${L('急提试算切点', 'Cashout simulator day')}">
                    <button type="button" data-q-curve-preset="today" class="${activePreset === 'today' ? 'is-active' : ''}" aria-pressed="${activePreset === 'today' ? 'true' : 'false'}">${L('今天（实际）', 'Today (Actual)')}</button>
                    <button type="button" data-q-curve-preset="7" class="${activePreset === 7 ? 'is-active' : ''}" aria-pressed="${activePreset === 7 ? 'true' : 'false'}" ${sim7?.disabled ? 'disabled' : ''}>${L('第 7 天试算', 'Day 7 Est.')}</button>
                    <button type="button" data-q-curve-preset="14" class="${activePreset === 14 ? 'is-active' : ''}" aria-pressed="${activePreset === 14 ? 'true' : 'false'}" ${sim14?.disabled ? 'disabled' : ''}>${L('第 14 天试算', 'Day 14 Est.')}</button>
                  </div>
                ` : ''}
                ${curveTicket && curveAcc ? `
                  <div style="margin-top:8px;" id="q-curve-summary" data-curve-preset="${escapeHtml(String(activePreset))}">
                    ${curveAcc.forfeited ? `
                      <div class="q-kv"><span>${L(`第 ${curveTicket.roundId ?? '—'} 关 · 已结清额度`, `Stage ${curveTicket.roundId ?? '—'} · Settled Quota`)}</span><b class="q-num">${escapeHtml(formatRoundA9(curveAcc.settledQuotaTotalRaw))}</b></div>
                      <div class="q-kv"><span>${L('实际到账奖金', 'Actual Received')}</span><b class="q-num green">${curveAcc.actualRewardReceivedRaw !== null ? escapeHtml(formatRoundA9(curveAcc.actualRewardReceivedRaw)) : L('未知（链上急提实发未单存）', 'Unknown (not stored separately)')}</b></div>
                      <div class="q-kv"><span>${L('急提已销毁', 'Cashout Burned')}</span><b class="q-num red">${curveAcc.burnedLockedRaw !== null ? escapeHtml(formatRoundA9(curveAcc.burnedLockedRaw)) : L('未知（需核验链上急提事件）', 'Unknown (verify cashout event)')}</b></div>
                    ` : activeSim?.isFuture ? `
                      <div class="q-kv"><span>${L(`第 ${activeSim.day} 天试算 · 预计急提实得（扣已领）`, `Day ${activeSim.day} Est. · Cashout Payout (Net)`)}</span><b class="q-num green">${escapeHtml(formatEstimatedA9(activeSim.payoutRaw))}</b></div>
                      <div class="q-kv"><span>${L(`第 ${activeSim.day} 天试算 · 预计销毁`, `Day ${activeSim.day} Est. · Burned`)}</span><b class="q-num red">${escapeHtml(formatEstimatedA9(activeSim.burnRaw))}</b></div>
                      <div class="q-kv"><span>${L('较今天急提多保住（未来试算）', 'Saved vs Today (Forecast)')}</span><b class="q-num green">${escapeHtml(formatEstimatedA9(activeSim.extraSavedRaw, { gain: true }))}</b></div>
                    ` : `
                      <div class="q-kv"><span>${L(`第 ${curveTicket.roundId ?? '—'} 关 · 实际累计已领`, `Stage ${curveTicket.roundId ?? '—'} · Actual Claimed`)}</span><b class="q-num">${escapeHtml(formatRoundA9(curveAcc.actualRewardReceivedRaw))}（${L('即时', 'Imm')} ${escapeHtml(formatRoundA9(curveAcc.immediateClaimedRaw))} + ${L('线性', 'Lin')} ${escapeHtml(formatRoundA9(curveAcc.actualLockedReceivedRaw))}）</b></div>
                      <div class="q-kv"><span>${L('今天急提实得（扣已领）', 'Today Cashout Payout')}</span><b class="q-num green">${escapeHtml(formatEstimatedA9(curveAcc.instantTotalRaw))}</b></div>
                      <div class="q-kv"><span>${L('今天急提销毁（未解锁 70%）', 'Today Cashout Burn')}</span><b class="q-num red">${escapeHtml(formatEstimatedA9(curveAcc.instantBurnRaw))}</b></div>
                    `}
                  </div>
                ` : ''}
              `;
            })()}
            <details class="q-details">
              <summary>${L('急提规则与双口径说明 ›', 'Cashout rules & denominators ›')}</summary>
              <div class="q-foot-note" style="margin-top:6px;">${L('通关本金 100% 退回。试算扣除已领金额，尚未解锁的奖金按 30% 秒提、70% 销毁。', 'Passing returns 100% of principal. Estimates deduct past claims. Unvested rewards pay 30% and burn 70%.')}</div>
            </details>
          ` : ''}
        </section>
      </div>
    `;

    // 视觉逐秒插值：仅对真实按时间推进的票据按整秒 BigInt 同步更新（固定时间演示样例保持静止一致）
    if (claimableParts && d.perSec > 0) {
      tickerTimer = setInterval(() => {
        if (seq !== vaultViewSeq || !root.isConnected) {
          clearInterval(tickerTimer);
          tickerTimer = null;
          return;
        }
        const now = Math.floor(serverNowMs() / 1000);
        const updateTicker = (raw) => {
          const parts = vaultTickerParts(raw);
          if (!parts) return;
          const intEl = root.querySelector('#q-vault-int');
          const decEl = root.querySelector('#q-vault-dec');
          if (intEl) intEl.textContent = parts.whole;
          if (decEl) decEl.textContent = parts.fraction;
        };
        if (isLive) {
          const raw = d.tickets.reduce((sum, t) => sum + vestingDeltaRaw(t, now), BigInt(d.claimableRaw));
          updateTicker(raw);
          return;
        }
        const demoMod = peekDemoModule();
        if (!demoMod?.demoBuildVaultTickets) return;
        const liveTickets = demoMod.demoBuildVaultTickets(store.state, now);
        let totalRaw = 0n;
        for (const tk of liveTickets) {
          if (/^\d+$/.test(String(tk.claimableTotalRaw ?? ''))) totalRaw += BigInt(tk.claimableTotalRaw);
          const tkClaimEl = root.querySelector(`[data-q-tk-claimable="${tk.ticketAddress}"]`);
          const tkLockEl = root.querySelector(`[data-q-tk-unvested="${tk.ticketAddress}"]`);
          if (tkClaimEl) tkClaimEl.textContent = formatEstimatedA9(tk.claimableTotalRaw);
          if (tkLockEl) tkLockEl.textContent = formatEstimatedA9(tk.lockedRemainingRaw);
        }
        updateTicker(totalRaw);
      }, 1000);
    }

    const connBtn = root.querySelector('#q-vault-connect');
    if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderVaultView(root, _navigate, _param, query));

    const retryBtn = root.querySelector('#q-vault-retry');
    if (retryBtn) retryBtn.onclick = () => loadAll();
    const promoRetryBtn = root.querySelector('#q-promo-retry');
    if (promoRetryBtn) promoRetryBtn.onclick = () => loadAll();
    const promoVerifyBtn = root.querySelector('#q-promo-verify');
    if (promoVerifyBtn) promoVerifyBtn.onclick = () => tonConnect.openConnectModal(() => loadAll());

    const heroClaimBtn = root.querySelector('#q-vault-claim-hero');
    if (heroClaimBtn) {
      heroClaimBtn.onclick = () => {
        if (state.busyTicket || pendingTxManager.isLocked()) return;
        if (claimableTickets.length === 1) void executeTicket(claimableTickets[0]);
        else if (claimableTickets.length > 1) openTicketPicker(claimableTickets, 'claim');
      };
    }

    const heroInstantBtn = root.querySelector('#q-vault-instant-hero');
    if (heroInstantBtn) {
      heroInstantBtn.onclick = () => {
        if (state.busyTicket || pendingTxManager.isLocked()) return;
        if (instantTickets.length === 1) void openInstantCashoutSheet(instantTickets[0]);
        else if (instantTickets.length > 1) openTicketPicker(instantTickets, 'instant');
      };
    }

    const toggleCurveBtn = root.querySelector('#q-toggle-curve');
    if (toggleCurveBtn) {
      toggleCurveBtn.onclick = () => {
        state.curveExpanded = !state.curveExpanded;
        paint();
      };
    }

    root.querySelectorAll('[data-q-select-curve]').forEach((btn) => {
      btn.onclick = () => {
        state.selectedTicketAddr = btn.dataset.qSelectCurve;
        state.curvePreset = 'today';
        paint();
      };
    });

    root.querySelectorAll('[data-q-curve-preset]').forEach((btn) => {
      btn.onclick = () => {
        if (btn.disabled) return;
        const val = btn.dataset.qCurvePreset;
        state.curvePreset = val === '7' ? 7 : val === '14' ? 14 : 'today';
        paint();
        root.querySelector(`[data-q-curve-preset="${val}"]`)?.focus?.({ preventScroll: true });
      };
    });

    root.querySelectorAll('[data-q-tk-filter]').forEach((btn) => {
      btn.onclick = () => {
        state.ticketFilter = btn.dataset.qTkFilter || 'all';
        paint();
        root.querySelector(`[data-q-tk-filter="${state.ticketFilter}"]`)?.focus?.({ preventScroll: true });
      };
    });

    root.querySelectorAll('[data-q-tk-claim]').forEach((btn) => {
      btn.onclick = () => {
        const hit = d.tickets.find((t) => t.ticketAddress === btn.dataset.qTkClaim);
        if (hit) void executeTicket(hit);
      };
    });

    root.querySelectorAll('[data-q-tk-instant]').forEach((btn) => {
      btn.onclick = () => {
        const hit = d.tickets.find((t) => t.ticketAddress === btn.dataset.qTkInstant);
        if (hit) void openInstantCashoutSheet(hit);
      };
    });

    const activateBtn = root.querySelector('#q-activate-reward');
    if (activateBtn) activateBtn.onclick = async () => {
      if (!store.fundsEnabled || state.activationBusy || !hasPendingReward ||
          reward.wallet !== (store.state.user.connected ? store.state.user.address : null) || reward.uid !== getEffectiveUserId(store.state.user)) return;
      if (!reward.wallet) {
        tonConnect.openConnectModal(() => loadAll());
        return;
      }
      state.activationBusy = true;
      paint();
      try {
        await activatePredictionReward(reward.uid, reward.wallet);
        state.pendingReward = null;
        if (seq === vaultViewSeq && root.isConnected && reward.wallet === store.state.user.address) {
          showToast(L('奖励已计入推广余额', 'Rewards added to your promo balance'));
          await loadAll();
        }
      } catch (err) {
        showToast(err?.message || L('激活失败，请重试', 'Activation failed. Try again.'), 'error');
      } finally {
        state.activationBusy = false;
        paint();
      }
    };

    const promoBtn = root.querySelector('#q-claim-promo-btn');
    if (promoBtn) {
      promoBtn.onclick = async () => {
        if (!store.fundsEnabled) {
          showToast(LIVE_READONLY_REASON, 'amber');
          return;
        }
        if (state.promoBusy || pendingTxManager.isLocked()) {
          showToast(L('当前有在途交易确认中，请完成后再试', 'Another transaction is in progress; please wait'), 'amber');
          return;
        }
        if (!isLive) {
          const res = store.claimPromoDemo();
          if (res?.error) showToast(res.error, 'amber');
          else showToast(L(`[演示模式] 已领取推广奖励 ${formatNum(res.amountA9)} A9`, `[Demo] Claimed ${formatNum(res.amountA9)} A9`));
          paint();
          return;
        }
        const wallet = store.state.user.address;
        if (!wallet) return;
        state.promoBusy = true;
        paint();
        try {
          const intent = await requestPromoClaimIntent(wallet);
          const expectedHot = store.state.round?.protocolConfig?.promoHotWallet?.address || '';
          if (expectedHot && canonicalWalletKey(intent?.payTo) !== canonicalWalletKey(expectedHot)) {
            throw new Error(L('领奖目标热钱包地址与协议配置不一致，已拦截签名', 'Promo hot wallet mismatch; blocked'));
          }
          const feeGram = fmtRawGramOrDash(intent?.feeRequiredNano);
          const feeText = feeGram === '—' || feeGram === '0 GRAM' ? `${PROTOCOL_SPECS.deliveryFeeGram.toFixed(2)} GRAM` : feeGram;
          const payoutA9 = formatRoundA9(intent?.amountRaw ?? state.promo?.claimableRaw);
          const ok = await tonConnect.confirmBeforeSign({
            title: L('确认领取站内推广余额', 'Confirm Promo Balance Claim'),
            contractLabel: 'Promo Hot Wallet',
            targetAddress: intent.payTo,
            principalText: payoutA9,
            gasText: feeText,
            totalText: feeText,
            memo: intent.memo || '',
          });
          if (!ok || wallet !== store.state.user.address || pendingTxManager.isLocked()) return;
          await tonConnect.sendV15PromoFee(intent);
          A9Haptic.success();
          const tx = pendingTxManager.start({
            kind: 'promo',
            title: '推广奖励发放',
            titleEn: 'Promo A9 Payout',
            amountText: payoutA9,
            explorerAddress: intent.payTo,
            refId: intent.claimId,
            targetRoute: '/rewards',
          });
          pendingTxManager.pollUntilConfirmed({
            txId: tx?.id,
            checkFn: async () => {
              const c = await fetchPromoClaim(intent.claimId);
              if (c?.status === 'COMPLETED') return { confirmed: true, detail: '推广奖励已到账。', detailEn: 'Promo A9 credited.' };
              if (c?.status === 'FAILED' || c?.status === 'EXPIRED') return { terminal: true };
              return false;
            },
            onConfirmed: () => {
              showToast(L('推广奖励已到账钱包！', 'Promo rewards credited!'));
              void loadAll();
            },
          });
          showToast(L('已发起 0.06 GRAM 领币转账，正在核验自动发币…', 'Fee sent, awaiting automatic A9 payout…'));
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('推广领币失败', 'Promo claim failed'), 'error');
        } finally {
          state.promoBusy = false;
          paint();
        }
      };
    }
  };

  const loadAll = async () => {
    const reqLoadSeq = ++loadSeq;
    const addr = store.state.user.connected ? store.state.user.address : null;
    if (addr !== state.lastWallet) {
      state.lastWallet = addr;
      state.portfolio = null;
      state.promo = null;
      state.pendingReward = null;
      state.ticketFilter = 'all';
      state.curvePreset = 'today';
      state.selectedTicketAddr = selectedTicket;
      state.curveExpanded = false;
    }
    const uid = getEffectiveUserId(store.state.user);
    const loadReward = uid && (isLive || (addr && store.state.user.profileMode !== 'empty'));
    state.loading = isLive && Boolean(addr);
    state.portfolioError = null;
    state.promoError = null;
    state.promoNeedsVerification = false;
    paint();

    if (!isLive && !peekDemoModule()) {
      try { await loadDemoModule(); } catch (_) {}
    }
    const [pfRes, prRes, rewardRes] = await Promise.allSettled([
      isLive && addr ? fetchUserPortfolio(addr) : null,
      isLive && addr ? fetchPromoBalance(addr) : null,
      loadReward ? fetchPredictionUser(uid, store.state.round.currentRound) : null,
    ]);
    if (seq !== vaultViewSeq || reqLoadSeq !== loadSeq || !root.isConnected || addr !== (store.state.user.connected ? store.state.user.address : null) || uid !== getEffectiveUserId(store.state.user)) return;

    state.pendingReward = rewardRes.status === 'fulfilled' && rewardRes.value ? { uid, wallet: addr, raw: rewardRes.value.pendingActivationRaw } : null;
    state.fetchedAtMs = serverNowMs();
    if (pfRes.status === 'fulfilled') {
      state.portfolio = pfRes.value;
      if (isLive && addr && pfRes.value?.ticketsAvailable !== true) {
        state.portfolioError = L('链上票据数据暂不可用，请重试', 'On-chain ticket data unavailable');
      }
    } else {
      state.portfolioError = L('票据读取失败，请重试', 'Failed to load tickets. Please retry.');
    }
    if (prRes.status === 'fulfilled') state.promo = prRes.value;
    else if (prRes.reason?.code === 'WALLET_NOT_VERIFIED') {
      state.promoNeedsVerification = true;
      state.promoError = L('请在钱包面板验证钱包归属，再查看推广余额', 'Verify ownership in the wallet panel to view your promo balance');
    } else state.promoError = L('推广余额读取失败，请重试', 'Failed to load promo balance. Please retry.');

    state.loading = false;
    paint();
  };

  paint();
  void loadAll();
}
