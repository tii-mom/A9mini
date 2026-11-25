import { renderNintendoGateIcon } from '../paper-art.js';
import { store } from '../store.js';
import { config } from '../config.js';
import { uiMemory } from '../app.js';
import { escapeHtml, formatNum, formatTimer, renderCorridorRadar, renderViralStrip, renderLiveSparkline } from '../components.js';
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { estimateRewardA9, rawToA9, getEffectiveUserId } from '../data.js';

function stagePillTrigger(stage, roundNum) {
  const labels = {
    warmup: L(`第 ${roundNum} 轮 · 开局倒计时`, `Round ${roundNum} · Pre-Round`),
    participation: L(`第 ${roundNum} 轮 · 火热入场`, `Round ${roundNum} · Entry Open`),
    observation: L(`第 ${roundNum} 轮 · 12H 冲价中`, `Round ${roundNum} · 12H Push`),
    settlement_success: L(`第 ${roundNum} 轮 · 通关派奖`, `Round ${roundNum} · Passed`),
    settlement_burn: L(`第 ${roundNum} 轮 · 未通关 · 自动止损`, `Round ${roundNum} · Auto Stop-Loss`),
    halted: L(`第 ${roundNum} 轮 · 异常中止 · 退回本金`, `Round ${roundNum} · Aborted · Refund`)
  };
  const text = labels[stage] || labels.participation;
  if (!config.isDemo) return `<span class="pill-trigger neutral">${text}</span>`;
  return `<button class="pill-trigger" id="btn-stage-sheet" type="button">${text} ${icon('chevronDown', 12)}</button>`;
}

function toFiniteNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function priceOrDash(v) {
  const n = toFiniteNum(v);
  return (n === null || n <= 0) ? '—' : `$${n.toFixed(4)}`;
}

/**
 * v17.0 心理安全垫卡片：头矿 6H (5% 止损) vs 普通 (10% 止损) + 24H 锁仓期提前解押 (退 85% / 烧 15%) + 每轮 100,000 A9 等权空投
 */
export function renderSafetyCushionCard(round) {
  const inFirst6h = Boolean(round?.inFirst6h);
  const isLocking = round?.stage === 'participation';
  return `
    <section class="card safety-cushion-card" id="a9-safety-cushion">
      <div class="row-between" style="margin-bottom:8px;">
        <span class="card-title">${icon('shieldCheck', 15, 'text-green')} ${L('v17.0 永不爆仓 · 三重安全垫', 'v17.0 No Liquidation · 3 Safety Cushions')}</span>
        <span class="chip ${inFirst6h && isLocking ? 'chip-red' : 'chip-green'}">${inFirst6h && isLocking ? L('头矿 6H · 5% 止损', 'First 6H · 5% SL') : L('100,000 A9 空投', '100,000 A9 Airdrop')}</span>
      </div>
      <div class="metric-strip cols-3" style="margin:0 0 8px;padding:8px 0;border-bottom:1px solid var(--card-border);">
        <div class="metric-cell">
          <span class="num-xs text-muted">${L('头矿 6H 止损', 'First 6H SL')}</span>
          <span class="num-sm text-green mono" style="font-weight:900;white-space:nowrap;font-size:12px;">5% (${L('退95%', '95%')})</span>
        </div>
        <div class="metric-cell">
          <span class="num-xs text-muted">${L('6H–24H 止损', '6H–24H SL')}</span>
          <span class="num-sm mono" style="font-weight:900;white-space:nowrap;font-size:12px;">10% (${L('退90%', '90%')})</span>
        </div>
        <div class="metric-cell">
          <span class="num-xs text-muted">${L('锁仓提前解押', '24H Early Exit')}</span>
          <span class="num-sm text-gold mono" style="font-weight:900;white-space:nowrap;font-size:12px;">${L('退85% (-15%)', '85% (-15%)')}</span>
        </div>
      </div>
      <div class="num-xs text-sec" style="line-height:1.5;">
        ${L('最低锁仓 100 A9 即自动获得本轮 100,000 A9 等权空投抽奖资格；24H 锁仓期内随时可提前解押，进入 12H 冲价后封盘禁进禁出。', 'Locking 100+ A9 automatically enters the 100,000 A9 per-round equal airdrop. Early Exit is open throughout the 24H lock window and locked during the 12H push.')}
      </div>
    </section>
  `;
}

/**
 * v17.0「本轮我的仓位卡」：若用户在本轮有 StakeTicket 持仓，拆行展示头矿 6H / 普通本金与直达提前解押 / 领奖 / 3 折急提入口
 */
export function renderMyRoundPositionCard(round, ticket) {
  if (!ticket) return '';
  const totalA9 = (ticket.amountRaw !== undefined && ticket.amountRaw !== null) ? (rawToA9(ticket.amountRaw) ?? 0) : (toFiniteNum(ticket.stakeTon) ?? 0);
  if (totalA9 <= 0) return '';
  const earlyA9 = (ticket.earlyAmountRaw !== undefined && ticket.earlyAmountRaw !== null) ? (rawToA9(ticket.earlyAmountRaw) ?? 0) : (ticket.isFirst6h ? totalA9 : 0);
  const lateA9 = (ticket.lateAmountRaw !== undefined && ticket.lateAmountRaw !== null) ? (rawToA9(ticket.lateAmountRaw) ?? 0) : Math.max(0, totalA9 - earlyA9);
  const stage = round?.stage || '';
  const isLocking = stage === 'participation' || Boolean(ticket.canEarlyExit);
  const isObserving = stage === 'observation';
  const isSuccess = stage === 'settlement_success' || Boolean(ticket.canInstantCashout);
  const isFail = stage === 'settlement_burn';

  let statusChip = `<span class="chip chip-cyan">${L('持仓中', 'Active')}</span>`;
  if (ticket.exited) statusChip = `<span class="chip chip-muted">${L('已提前解押 (-15%)', 'Early Exited (-15%)')}</span>`;
  else if (isLocking) statusChip = `<span class="chip chip-gold">${L('24H 锁仓中 · 可提前解押', '24H Lock · Early Exit Open')}</span>`;
  else if (isObserving) statusChip = `<span class="chip chip-blue">${L('12H 冲价中 · 封盘锁定', '12H Push · Locked')}</span>`;
  else if (isSuccess) statusChip = `<span class="chip chip-green">${L('已通关 · 可领 / 3 折急提', 'Passed · Claim / Cashout')}</span>`;
  else if (isFail) statusChip = `<span class="chip chip-red">${L('未通关 · 可领止损退本', 'Auto Stop-Loss Refund')}</span>`;

  const roundNum = ticket.roundId ?? ticket.round ?? round?.currentRound ?? '—';
  const claimableA9 = ticket.claimableTotalRaw !== undefined ? (rawToA9(ticket.claimableTotalRaw) ?? null) : null;

  return `
    <section class="card my-round-pos-card" id="a9-my-round-position" style="border-color:var(--green-border);">
      <div class="row-between" style="margin-bottom:8px;">
        <span class="card-title">${icon('wallet', 15, 'text-green')} ${L(`本轮我的仓位 · 第 ${escapeHtml(String(roundNum))} 轮`, `My Position · Round #${escapeHtml(String(roundNum))}`)}</span>
        ${statusChip}
      </div>
      <div class="check-list" style="margin-bottom:10px;">
        <div class="check-row">
          <span class="text-sec">${L('本轮总锁仓本金', 'Total Locked Principal')}</span>
          <b class="mono text-green">${formatNum(totalA9, totalA9 % 1 === 0 ? 0 : 2)} A9</b>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('头矿 6H 本金（5% 止损）', 'First 6H Principal (5% SL)')}</span>
          <span class="mono">${formatNum(earlyA9, earlyA9 % 1 === 0 ? 0 : 2)} A9</span>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('6H–24H 普通本金（10% 止损）', 'Standard Principal (10% SL)')}</span>
          <span class="mono">${formatNum(lateA9, lateA9 % 1 === 0 ? 0 : 2)} A9</span>
        </div>
        ${claimableA9 !== null ? `
        <div class="check-row">
          <span class="text-sec">${L('当前可领总额', 'Claimable Now')}</span>
          <b class="mono text-gold">${formatNum(claimableA9, 2)} A9</b>
        </div>` : ''}
      </div>
      ${isLocking && !ticket.exited ? `
        <div class="grid-2" style="gap:8px;">
          <a class="btn btn-primary btn-sm" href="#/challenge/confirm" style="width:100%;min-height:40px;">${icon('bolt', 13)} ${L('追加锁仓', 'Add Lock')}</a>
          <a class="btn btn-secondary btn-sm" href="#/claim" style="width:100%;min-height:40px;border-color:var(--red-border, #F3B3B8);color:var(--red);">${icon('flame', 13)} ${L('提前解押 (退 85%)', 'Early Exit (85%)')}</a>
        </div>
      ` : (isSuccess || isFail) ? `
        <div class="grid-2" style="gap:8px;">
          <a class="btn btn-primary btn-sm" href="#/claim" style="width:100%;min-height:40px;">${icon('wallet', 13)} ${isFail ? L('领回止损退本', 'Claim Stop-Loss') : L('领本金 + 20% 秒提', 'Claim 20% Instant')}</a>
          <a class="btn btn-secondary btn-sm" href="#/claim" style="width:100%;min-height:40px;">${icon('bolt', 13)} ${isFail ? L('查看凭证明细', 'View Ticket') : L('3 折急提通道', 'Instant Cashout')}</a>
        </div>
      ` : `
        <div class="grid-2" style="gap:8px;">
          <a class="btn btn-secondary btn-sm" href="#/claim" style="width:100%;min-height:38px;">${icon('shieldCheck', 13)} ${L('查看链上凭证', 'View Ticket')}</a>
          <a class="btn btn-secondary btn-sm" href="#/observation/records" style="width:100%;min-height:38px;">${icon('clock', 13)} ${L('12H 冲价明细', '12H Slots')}</a>
        </div>
      `}
    </section>
  `;
}

/**
 * 第一刀 ①：待提现奖金金库高亮条（真实二步进度 + 48h 作废倒计时 + 直连宝箱商城 0.99 GRAM 起）
 */
export function renderPlazaCompactBanner(pred, round) {
  const p = pred || {};
  const pendingA9 = rawToA9(p.pendingActivationRaw) || 0;
  const showVault = pendingA9 > 0 && (config.isDemo || p.loaded);
  if (showVault) {
    const rawExp = Number(p.pendingExpiresAt);
    const expAtMs = (Number.isFinite(rawExp) && rawExp > 0) ? (rawExp < 1e12 ? rawExp * 1000 : rawExp) : 0;
    const expRemSec = expAtMs > Date.now() ? Math.floor((expAtMs - Date.now()) / 1000) : null;
    const firstOrderTotalA9 = Math.round(1500 + pendingA9);
    return `
      <a class="plaza-compact-strip is-vault" id="a9-pending-vault-banner" href="#/internal/market">
        <span class="plaza-compact-left">
          <span class="chip chip-gold" style="min-height:20px;font-size:10px;padding:0 6px;">${L('首单加赠', 'BONUS')}</span>
          <span class="plaza-compact-text">${L(`0.99 GRAM 得 ${formatNum(firstOrderTotalA9, 0)} A9（含 ${formatNum(Math.round(pendingA9), 0)} 赠金）`, `0.99 GRAM → ${formatNum(firstOrderTotalA9, 0)} A9 (+${formatNum(Math.round(pendingA9), 0)} bonus)`)}</span>
        </span>
        <span class="plaza-compact-right mono">${expRemSec !== null ? formatTimer(expRemSec) : '48H'} ›</span>
      </a>
    `;
  }

  if (round && round.stage === 'participation') {
    const openAt = toUnixSec(round.stakeOpenAt);
    const closeAt = toUnixSec(round.stakeCloseAt);
    const explicitEarlyEnd = toUnixSec(round.earlyCloseAt);
    const nowSec = Math.floor(Date.now() / 1000);
    let remSec = null;
    const earlyEnd = explicitEarlyEnd > 0
      ? explicitEarlyEnd
      : (openAt > 0 && closeAt > openAt ? openAt + Number(round.earlyWindowSeconds || 21600) : 0);
    if (earlyEnd > 0 && nowSec < earlyEnd) {
      remSec = earlyEnd - nowSec;
    }
    if ((remSec === null || remSec <= 0) && config.isDemo && Number(round.earlyBirdSec) > 0) {
      remSec = Math.floor(Number(round.earlyBirdSec));
    }
    if (remSec !== null && remSec > 0) {
      return `
        <a class="plaza-compact-strip is-early" id="a9-early-bird-banner" data-early-rem="${remSec}" href="#/challenge/confirm">
          <span class="plaza-compact-left">
            <span class="chip chip-red" style="min-height:20px;font-size:10px;padding:0 6px;">-5%</span>
            <span class="plaza-compact-text">${L('头矿 6H · 5% 轻止损窗口开放中（全员 1:1 分奖）', 'First 6H · 5% Stop-Loss Live (1:1 Fair Split)')}</span>
          </span>
          <span class="plaza-compact-right mono" id="early-window-cd">${formatTimer(remSec)} ›</span>
        </a>
      `;
    }
  }
  return '';
}

export function renderPendingVaultBanner(pred, round) {
  const p = pred || {};
  const pendingA9 = rawToA9(p.pendingActivationRaw) || 0;
  if (pendingA9 <= 0) return '';
  if (!config.isDemo && !p.loaded) return '';

  const rawExp = Number(p.pendingExpiresAt);
  const expAtMs = (Number.isFinite(rawExp) && rawExp > 0) ? (rawExp < 1e12 ? rawExp * 1000 : rawExp) : 0;
  const expRemSec = expAtMs > Date.now() ? Math.floor((expAtMs - Date.now()) / 1000) : null;
  const refPrice = (round?.priceValid !== false) ? Number(round?.livePrice || round?.twap24h || 0) : 0;
  const usdEst = refPrice > 0 ? pendingA9 * refPrice : null;
  const firstOrderTotalA9 = Math.round(1500 + pendingA9);
  const bonusPct = Math.round((pendingA9 / 1500) * 100);

  return `
    <section class="card vault-unlock-banner" id="a9-pending-vault-banner">
      <div class="row-between" style="margin-bottom:6px;">
        <span class="chip chip-gold">${icon('unlock', 12)} ${L('首单加赠金库 · 待激活', 'Bonus Vault · Ready to Activate')}</span>
        <span class="num-xs mono text-red" style="font-weight:800;">
          ${expRemSec !== null ? `<span data-pred-exp-cd="vault">${L('作废倒计时', 'Expires')} ${formatTimer(expRemSec)}</span>` : L('48H 未激活自动作废', 'Expires in 48H')}
        </span>
      </div>
      <div class="row-between" style="align-items:baseline;margin-bottom:8px;">
        <div class="num-lg text-green mono" style="font-weight:900;">+${formatNum(Math.round(pendingA9), 0)} A9</div>
        ${usdEst !== null ? `<span class="num-xs text-sec mono">${L('参考估值约', 'Est.')} $${formatNum(usdEst, 2)}</span>` : ''}
      </div>
      <div class="vault-two-step" role="status" aria-label="${L('解锁进度', 'Unlock progress')}">
        <span class="vault-step done">1/2 ${L('赠金已入库', 'Bonus Credited')}</span>
        <span class="vault-step-line" aria-hidden="true"></span>
        <span class="vault-step next">2/2 ${L('首单加赠或 0 元激活', 'Activate with Order / 0-Cost')}</span>
      </div>
      <p class="num-xs text-sec" style="margin:6px 0 10px;line-height:1.45;">
        ${L(`0.99 GRAM 购箱共得 ${formatNum(firstOrderTotalA9, 0)} A9（含 +${bonusPct}% 赠金），或锁仓 / 邀 1 友自动激活。`, `0.99 GRAM chest yields ${formatNum(firstOrderTotalA9, 0)} A9 (+${bonusPct}% bonus), or auto-activates via lock / 1 invite.`)}
      </p>
      <div class="grid-2" style="gap:8px;">
        <button class="btn btn-primary btn-sm" data-nav="/internal/market" type="button" style="width:100%;min-height:40px;white-space:nowrap;">${icon('swap', 14)} ${L('首单加赠领箱', 'Claim with Bonus')}</button>
        <button class="btn btn-secondary btn-sm" data-nav="/team/invite" type="button" style="width:100%;min-height:40px;white-space:nowrap;">${icon('send', 14)} ${L('邀 1 友 0 元解锁', '0-Cost Invite')}</button>
      </div>
    </section>
  `;
}

/**
 * 将 Unix 秒或毫秒时间戳统一归一化为秒
 */
function toUnixSec(v) {
  const n = toFiniteNum(v);
  if (n === null || n <= 0) return 0;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

/**
 * 第一刀 ②：头矿 6H · 5% 止损窗口倒计时条（锁仓前 6 小时，基于 stakeOpenAt / stakeCloseAt）
 */
export function renderEarlyBirdBanner(round) {
  if (!round || round.stage !== 'participation') return '';
  const openAt = toUnixSec(round.stakeOpenAt);
  const closeAt = toUnixSec(round.stakeCloseAt);
  const explicitEarlyEnd = toUnixSec(round.earlyCloseAt);
  const nowSec = Math.floor(Date.now() / 1000);
  let remSec = null;
  const earlyEnd = explicitEarlyEnd > 0
    ? explicitEarlyEnd
    : (openAt > 0 && closeAt > openAt ? openAt + Number(round.earlyWindowSeconds || 21600) : 0);
  if (earlyEnd > 0 && nowSec < earlyEnd) {
    remSec = earlyEnd - nowSec;
  }
  if ((remSec === null || remSec <= 0) && config.isDemo && Number(round.earlyBirdSec) > 0) {
    remSec = Math.floor(Number(round.earlyBirdSec));
  }
  if (remSec === null || remSec <= 0) return '';

  return `
    <section class="early-bird-banner" id="a9-early-bird-banner" data-early-rem="${remSec}">
      <div class="row-between" style="gap:8px;">
        <span class="row-start" style="gap:6px;font-weight:900;font-size:12.5px;">
          <span class="chip chip-red" style="height:20px;font-size:10px;padding:0 7px;">${L('头矿 6H', 'FIRST 6H')}</span>
          <span>${L('头矿 6H · 5% 轻止损窗口', 'First 6H · 5% Stop-Loss Window')}</span>
        </span>
        <span class="mono early-bird-cd" id="early-window-cd">${formatTimer(remSec)}</span>
      </div>
      <div class="num-xs text-sec" style="margin-top:4px;">
        ${L('前 6 小时进池未通关仅扣 5% 止损（退 95%）；6 小时后为 10% 止损（退 90%），全员 1:1 公平分奖。', 'Lock in First 6H for 5% Stop-Loss (95% refund on fail); 10% Stop-Loss (90% refund) after 6H. 1:1 fair reward split.')}
      </div>
    </section>
  `;
}

/**
 * v17.0：通关奖励采用「20% 秒提 + 80% 分 14 天逐秒解锁（支持随时 3 折急提，7 折销毁），永久累计不倒扣」，
 * 不再存在跨轮连坐销毁切片，此卡片默认隐藏。
 */
export function renderVeteranShieldCard() {
  return '';
}

/**
 * 12H 预言擂台嵌入式卡片（0 GRAM 参战 + 新人首轮保底 + 防薅激活闭环）
 */
export function renderPredictionCard(round, pred, user) {
  if (!config.isDemo && (!pred?.loaded || pred.roundId !== round.currentRound)) {
    return `<div class="card" id="a9-prediction-card"><div class="card-title">${L('12H 预言擂台', '12H Prediction Arena')}</div><p class="num-xs text-muted" style="margin:6px 0 0;">${L('正在读取预言数据…', 'Reading prediction data…')}</p></div>`;
  }
  const p = pred || {};
  const roundNum = round?.currentRound || 1;
  const myStakeNum = toFiniteNum(round?.myStakeTon);
  const hasStaked = (myStakeNum !== null && myStakeNum > 0) || store.state.certificates.some(c => Number(c.round) === Number(roundNum));
  const isExpanded = p.expanded !== null && p.expanded !== undefined ? Boolean(p.expanded) : !hasStaked;
  const passPct = toFiniteNum(p.passPct) ?? 50;
  const burnPct = toFiniteNum(p.burnPct) ?? 50;
  const total = toFiniteNum(p.total) ?? 0;
  const bet = p.currentBet || null;
  const settled = Boolean(p.settled || round?.stage === 'settlement_success' || round?.stage === 'settlement_burn');
  const winningSide = p.winningSide || (round?.stage === 'settlement_success' ? 'PASS' : round?.stage === 'settlement_burn' ? 'BURN' : null);
  const pendingA9 = rawToA9(p.pendingActivationRaw) || 0;
  const effectiveUid = getEffectiveUserId(user);
  const needsIdentity = !effectiveUid;

  const refPrice = (round?.priceValid !== false) ? (toFiniteNum(round?.livePrice ?? round?.twap24h) ?? 0) : 0;
  const usdEst = (pendingA9 > 0 && refPrice > 0) ? pendingA9 * refPrice : null;
  const expAt = toFiniteNum(p.pendingExpiresAt);
  const expRemSec = (expAt !== null && expAt > Date.now()) ? Math.floor((expAt - Date.now()) / 1000) : null;

  const inviteCnt = Math.max(0, toFiniteNum(p.inviteBoostCount) ?? 0);
  const inviteBonus = Math.min(0.5, inviteCnt * 0.1);
  const hasExactSlot = bet && bet.guessSlots !== null && bet.guessSlots !== undefined;
  const curWeight = Math.min(2.0, 1.0 + (hasExactSlot ? 0.5 : 0) + inviteBonus);
  const streak = toFiniteNum(p.streak) ?? 0;
  const winRate = toFiniteNum(p.winRate);
  const rankMeta = streak >= 2
    ? `${L(`${streak} 连胜`, `${streak}W`)}${winRate !== null ? ` · ${L(`胜率 ${winRate}%`, `${winRate}% WR`)}` : ''}`
    : (winRate !== null ? L(`胜率 ${winRate}%`, `${winRate}% WR`) : '');

  const weightHintHtml = `
    <div class="row-between num-xs" style="margin-top:8px;padding:7px 10px;border-radius:10px;background:var(--paper-tray);">
      <span class="text-sec">${L('分配权重', 'Weight')} <b id="pred-cur-weight" class="mono text-green">${curWeight.toFixed(1)}x</b>${rankMeta ? ` <span class="text-muted">· ${rankMeta}</span>` : ''}</span>
      <span class="text-muted">${L('邀友 +0.1x · 顶 2.0x', '+0.1x/inv · 2.0x cap')}</span>
    </div>
  `;

  const qualNow = toFiniteNum(round?.qualifiedCandles);
  const cdSecNow = toFiniteNum(round?.countdownSec);
  const isSprint4h = round?.stage === 'observation' && cdSecNow !== null && cdSecNow > 0 && cdSecNow <= 14400;
  const isRedAlert = (isSprint4h && qualNow !== null && qualNow >= 6 && qualNow <= 7) || round?.stage === 'settlement_burn';
  const headerTag = isRedAlert
    ? `<span class="chip chip-red">${round?.stage === 'settlement_burn' ? L('止损警报 FAIL', 'STOP-LOSS ALERT') : L('最后 4H 红警', '4H RED ALERT')}</span>`
    : isSprint4h
      ? `<span class="chip chip-red">${L('最后 4H 冲刺', 'Last 4H')}</span>`
      : settled
        ? `<span class="chip chip-muted">${L('已结算', 'Settled')}</span>`
        : bet
          ? `<span class="chip ${bet.side === 'BURN' ? 'chip-red' : 'chip-green'}">${bet.side === 'BURN' ? L('已押未通关', 'FAIL') : L('已押通关', 'PASS')}</span>`
          : `<span class="chip chip-green">${L('0 GRAM 免费猜', '0 GRAM Free')}</span>`;

  const pendingBlock = pendingA9 > 0 ? `
    <div class="sub-tile" style="border-color:var(--green-border);margin-top:12px;">
      <div class="row-between" style="margin-bottom:4px;">
        <span class="num-xs text-green" style="font-weight:800;">${L('奖金金库待解锁余额', 'Pending Vault Balance')}</span>
        <span class="num-md text-green mono">${formatNum(pendingA9)} A9${usdEst !== null ? ` <span class="num-xs text-sec">(${L('约', '~')} $${formatNum(usdEst, 2)})</span>` : ''}</span>
      </div>
      <div class="num-xs text-muted" style="margin-bottom:6px;">${expRemSec !== null ? `<span id="pred-exp-cd" class="mono text-red">${L('距过期', 'Expires')} ${formatTimer(expRemSec)}</span>` : L('48 小时内未激活将自动作废回流奖池', 'Expires in 48H if unactivated')}</div>
      <div class="num-xs text-sec" style="line-height:1.5;margin-bottom:10px;">${L('购任意宝箱（0.99 GRAM 起）、链上锁仓或邀 1 友购箱即可自动激活，合并 0.06 GRAM 领取。', 'Buy any chest (0.99+ GRAM), lock A9, or invite 1 paid friend to auto-activate (0.06 GRAM claim gas).')}</div>
      <div class="col-gap" style="gap:8px;">
        <button class="btn btn-primary btn-sm" id="btn-pred-activate" type="button" style="width:100%;min-height:40px;">${icon('bolt', 14)} ${L('立即激活奖励', 'Activate Reward')}</button>
        <div class="grid-2">
          <button class="btn btn-secondary btn-sm" data-nav="/internal/market" type="button" style="width:100%;">${icon('swap', 13)} ${L('去宝箱商城 (0.99 GRAM 起)', 'Chest Mall (0.99+)')}</button>
          <button class="btn btn-secondary btn-sm" data-nav="/challenge/confirm" type="button" style="width:100%;">${icon('shieldCheck', 13)} ${L('链上锁仓', 'Lock A9')}</button>
        </div>
      </div>
    </div>
  ` : '';

  let bodyHtml = '';
  if (settled) {
    const won = bet && winningSide && bet.side === winningSide;
    const isRookieBonus = bet && bet.status === 'LOST_FIRST_BONUS';
    const outcomeText = winningSide === 'BURN' ? L('本轮结果：未通关 · 自动止损', 'Outcome: Auto Stop-Loss') : L('本轮结果：达标通关 (PASS)', 'Outcome: PASS');
    bodyHtml = `
      <div class="sub-tile" style="margin-top:12px;">
        <div class="row-between">
          <span class="num-sm" style="font-weight:700;">${outcomeText}</span>
          ${bet ? `<span class="chip ${won ? 'chip-green' : isRookieBonus ? 'chip-gold' : 'chip-red'}">${won ? L('预言命中', 'Won') : isRookieBonus ? L('首轮保底 +500 A9', 'Rookie +500 A9') : L('未命中', 'Missed')}</span>` : `<span class="chip chip-muted">${L('未参战', 'No Entry')}</span>`}
        </div>
        ${bet ? `<div class="num-xs text-sec" style="margin-top:6px;">${L('我的立场', 'My Call')}: <b>${bet.side === 'BURN' ? L('未通关 FAIL', 'FAIL') : 'PASS'}</b>${bet.guessSlots !== null && bet.guessSlots !== undefined ? ` · ${L(`精准 ${bet.guessSlots} 段`, `${bet.guessSlots} slots`)}` : ''}${isRookieBonus ? ` · ${L('新人首轮保底已入待解锁金库', 'First-round rookie floor credited to vault')}` : ''}</div>` : ''}
      </div>
    `;
  } else if (bet) {
    bodyHtml = `
      <div class="sub-tile" style="margin-top:12px;border-color:${bet.side === 'BURN' ? 'var(--red-border)' : 'var(--emerald-border)'};">
        <div class="row-between">
          <div class="num-sm" style="font-weight:700;">
            <span class="${bet.side === 'BURN' ? 'text-red' : 'text-green'}">${bet.side === 'BURN' ? L('已押未通关 FAIL', 'FAIL') : L('已押通关 PASS', 'PASS')}</span>
            ${bet.guessSlots !== null && bet.guessSlots !== undefined ? `<span class="text-sec"> · ${L(`精准 ${bet.guessSlots}/12`, `${bet.guessSlots}/12`)}</span>` : ''}
          </div>
          <span class="num-xs text-muted">${icon('lock', 11)} ${L('每轮限 1 次', 'Locked')}</span>
        </div>
        ${weightHintHtml}
        <div class="grid-2" style="margin-top:10px;">
          <button class="btn btn-primary btn-sm" id="btn-pred-tg-share" type="button" style="width:100%;min-height:40px;">${icon('send', 13)} ${L('分享至战队群', 'Share Squad')}</button>
          <button class="btn btn-secondary btn-sm" id="btn-pred-x-share" type="button" style="width:100%;min-height:40px;">${icon('xBrand', 13)} ${L('发 X 晒立场', 'Post on X')}</button>
        </div>
      </div>
    `;
  } else if (needsIdentity) {
    bodyHtml = `
      <div class="sub-tile" style="margin-top:12px;border-color:var(--gold-border);">
        <div class="num-xs text-sec" style="line-height:1.5;margin-bottom:10px;">${L('请在 Telegram 内打开或先连接 TON 钱包，即可 0 GRAM 免费参与 12H 预言擂台（新人首轮参与保底 500 A9 待解锁体验金）。', 'Open in Telegram or connect a TON wallet to join the 0 GRAM 12H Prediction Arena (500 A9 first-round rookie floor).')}</div>
        <button class="btn btn-primary btn-sm" id="btn-pred-connect" type="button" style="width:100%;min-height:40px;">${icon('wallet', 14)} ${L('连接钱包参与', 'Connect Wallet')}</button>
      </div>
    `;
  } else {
    bodyHtml = `
      <div class="grid-2" style="margin-top:12px;">
        <button class="pred-side-btn pass" data-pred-side="PASS" type="button">${icon('checkCircle', 15)} ${L('猜通关 PASS', 'Guess PASS')}</button>
        <button class="pred-side-btn burn" data-pred-side="BURN" type="button">${icon('flame', 15)} ${L('猜未通关 FAIL', 'Guess FAIL')}</button>
      </div>
      <div class="row-between" style="margin-top:10px;">
        <div>
          <div class="num-xs" style="font-weight:700;">${L('精准格数（选填 0–12）', 'Exact Slots (0-12)')}</div>
          <div class="num-xs text-muted">${L('猜中达标时段数享 +0.5x 权重 · 首轮保底 500 A9', 'Exact match +0.5x · 500 A9 first-round floor')}</div>
        </div>
        <input id="pred-guess-slots" class="pred-slot-input" type="number" min="0" max="12" placeholder="0-12" aria-label="${L('精准达标格数', 'Exact qualified slots')}" />
      </div>
      ${weightHintHtml}
      <button class="btn btn-primary" id="btn-pred-submit" type="button" style="margin-top:12px;min-height:46px;">${icon('bolt', 15)} ${L('0 GRAM 锁定本轮预言', 'Lock 0 GRAM Prediction')}</button>
    `;
  }

  return `
    <div class="card${isRedAlert ? ' alert-red-mode' : ''}" id="a9-prediction-card">
      <div class="pred-card-head" id="pred-toggle-head" role="button" tabindex="0" aria-expanded="${isExpanded}">
        <div class="row-start" style="gap:8px;">
          <span class="card-title">${icon('radar', 15, 'text-cyan')} ${L('12H 预言擂台', '12H Prediction Arena')}</span>
          ${headerTag}
        </div>
        <div class="row-start num-xs text-muted">
          ${!isExpanded ? `<span class="mono">${passPct}% / ${burnPct}%</span>` : ''}
          ${icon(isExpanded ? 'chevronDown' : 'chevronRight', 14)}
        </div>
      </div>
      <div class="pred-expand-wrap ${isExpanded ? 'open' : ''}">
        <div class="pred-expand-inner">
          <div style="margin-top:12px;">
            <div class="row-between num-xs" style="margin-bottom:6px;">
              <span style="color:var(--emerald);font-weight:800;">${L('通关多军 PASS', 'PASS')} ${passPct}%</span>
              <span class="text-muted mono">${L(`共 ${formatNum(total)} 人对决`, `${formatNum(total)} entries`)}</span>
              <span class="text-red" style="font-weight:800;">${L('未通关空军 FAIL', 'FAIL')} ${burnPct}%</span>
            </div>
            <div class="pred-split-bar pred-versus-bar">
              <div class="pred-split-pass" style="width:${passPct}%;"></div>
              <div class="pred-split-burn" style="width:${burnPct}%;"></div>
            </div>
            ${bodyHtml}
            ${pendingBlock}
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderWarmupStage(round, user) {
  return `
    <div class="card card-hero">
      <div class="row-between" style="margin-bottom:12px;">
        ${stagePillTrigger('warmup', round.currentRound)}
        <span class="row-start num-sm text-sec">${icon('clock', 13)} <span id="early-cd" class="mono">${round.earlyBirdSec === null ? '—' : formatTimer(round.earlyBirdSec)}</span></span>
      </div>
      <div class="num-xs text-muted">${L('单人预热宝箱上限（免本金）', 'Per-User Pre-Round Chest Cap')}</div>
      <div class="num-hero" style="margin-top:4px;">300–900 <span class="num-md text-green">A9</span></div>
      <div class="metric-strip cols-3">
        <div class="metric-cell"><span class="num-xs text-muted">${L('推广总熔断池', 'Promo Cap')}</span><span class="num-sm">550,000,000 A9</span></div>
        <div class="metric-cell"><span class="num-xs text-muted">${L('我的有效直邀', 'Valid Invites')}</span><span class="num-sm text-gold">${user.warmupInvites}</span></div>
        <div class="metric-cell"><span class="num-xs text-muted">${L('开箱门槛', 'Unlock Goal')}</span><span class="num-sm">2–5</span></div>
      </div>
      <button class="btn btn-primary" data-nav="/warmup">${icon('flame', 16)} ${user.warmupRegistered ? L('已报名 · 预热先锋榜', 'Joined · Warm-Up Board') : L('免费报名开局预热', 'Join Pre-Round Free')}</button>
    </div>

    <div class="grid-4">
      <button class="cmd-tile" data-nav="/warmup/rank"><span class="icon-badge amber">${icon('trophy', 16)}</span><span>${L('先锋榜', 'Board')}</span></button>
      <button class="cmd-tile" data-nav="/internal/market"><span class="icon-badge sky">${icon('swap', 16)}</span><span>${L('宝箱商城', 'Chest Mall')}</span></button>
      <button class="cmd-tile" data-nav="/rules"><span class="icon-badge">${icon('book', 16)}</span><span>${L('指南', 'Guide')}</span></button>
      <button class="cmd-tile" data-nav="/team/invite"><span class="icon-badge orange">${icon('qr', 16)}</span><span>${L('海报', 'Poster')}</span></button>
    </div>

    ${renderViralStrip()}
  `;
}

export function renderParticipation(round) {
  const qAmt = round.quickStakeA9 || 5000;
  const est = estimateRewardA9(qAmt);
  const history = Array.isArray(round.priceHistory) && round.priceHistory.length > 1
    ? round.priceHistory : [];

  return `
    ${renderPendingVaultBanner(store.state.prediction, round)}
    ${renderEarlyBirdBanner(round)}
    <div class="card card-hero">
      <div class="row-between" style="margin-bottom:12px;">
        ${stagePillTrigger('participation', round.currentRound)}
        <span class="row-start num-sm text-sec">${icon('clock', 13)} <span id="round-cd" class="mono">${round.countdownSec === null ? '—' : formatTimer(round.countdownSec)}</span></span>
      </div>

      <div class="row-between" style="align-items:flex-end;">
        <div>
          <div class="num-xs text-muted">${L('本轮用户奖励池', 'Round Reward Pool')}</div>
          <div class="num-hero" style="margin-top:4px;">${round.rewardBudgetA9 === null || round.rewardBudgetA9 === undefined ? L('待核验', 'Pending') : formatNum(round.rewardBudgetA9)} <span class="num-md text-green">A9</span></div>
        </div>
        ${history.length > 1 ? renderLiveSparkline(history) : ''}
      </div>

      <div class="metric-strip">
        <div class="metric-cell">
          <span class="num-xs text-muted">${L('目标底价', 'Target')}</span>
          <span class="num-md">${priceOrDash(round.targetPrice)}</span>
        </div>
        <div class="metric-cell">
          <span class="num-xs text-muted">${L('1H 均价', '1H TWAP')}</span>
          <span class="num-md text-green">${priceOrDash(round.twap24h)}</span>
        </div>
      </div>

      <div class="hero-amt-pills">
        ${[1000, 5000, 10000].map(v => `
          <button class="hero-amt-pill ${qAmt === v ? 'active' : ''}" data-hero-amt="${v}" type="button">${formatNum(v)} A9</button>
        `).join('')}
      </div>

      <button class="btn btn-primary" id="hero-stake-cta" data-nav="/challenge/confirm">${icon('bolt', 16)} ${L(`立即锁仓 ${formatNum(qAmt)} A9`, `Lock ${formatNum(qAmt)} A9`)}</button>
      <div class="num-xs text-muted" style="margin-top:8px;">
        ${est === null
          ? L('预计奖励：等待服务端参与数据', 'Estimate: awaiting participation data')
          : `${L('预计奖励约', 'Est.')} <b id="hero-est-a9" style="color:var(--text-primary);">~${formatNum(Math.round(est))} A9</b> · ${L('按当前参与量估算，非承诺', 'estimated from pool, not guaranteed')}`}
      </div>
    </div>

    <div class="step-rail">
      <div class="step-item current" ${config.isDemo ? 'data-step-stage="participation"' : ''}><span class="step-num">1</span><span>${L('24H 锁仓', '24H Lock')}</span></div>
      <div class="step-item" ${config.isDemo ? 'data-step-stage="observation"' : ''}><span class="step-num">2</span><span>${L('12H 冲价', '12H Push')}</span></div>
      <div class="step-item" ${config.isDemo ? 'data-step-stage="settlement_success"' : ''}><span class="step-num">3</span><span>${L('20% 秒提', '20% Instant')}</span></div>
    </div>

    ${renderSafetyCushionCard(round)}
    ${renderVeteranShieldCard(round, store.state.user)}
  `;
}

/**
 * 挑战页 12H 冲价总览：重心 100% 放在「达标进度 + 剩余时间 → 12H 冲价盘 → 选中时段依据」
 */
export function renderObservation(round) {
  const qualVal = toFiniteNum(round.qualifiedCandles);
  const hasQualified = qualVal !== null && Number.isInteger(qualVal);
  const passed = hasQualified ? qualVal : null;
  const required = toFiniteNum(round.minQualifiedCandles) || 8;
  const needMoreVal = toFiniteNum(round.needMore);
  const need = !hasQualified ? null : (needMoreVal !== null ? needMoreVal : Math.max(0, required - passed));
  const pct = hasQualified && required ? Math.round(Math.min(100, (passed / required) * 100)) : 0;
  const est = (toFiniteNum(round.myWeight) ?? 0) > 0 ? estimateRewardA9(round.myStakeTon) : null;
  const cdSecObs = toFiniteNum(round.countdownSec);
  const isSprint4h = cdSecObs !== null && cdSecObs > 0 && cdSecObs <= 14400;
  const isRedAlert = isSprint4h && hasQualified && passed >= 6 && passed <= 7;
  const isMatchPoint = isSprint4h || (hasQualified && passed >= Math.max(1, required - 2) && passed < required);

  return `
    ${renderPendingVaultBanner(store.state.prediction, round)}
    <section class="observatory-stage${isMatchPoint ? ' is-matchpoint' : ''}${isRedAlert ? ' alert-red-mode' : ''}">
      <div class="observatory-hud">
        ${stagePillTrigger('observation', round.currentRound)}
        <span class="obs-cd-tag">${icon('clock', 12)} <b id="round-cd">${round.countdownSec == null ? '—' : formatTimer(round.countdownSec)}</b></span>
      </div>
      <div class="observatory-status">
        <div class="obs-hero-ratio">
          <span id="obs-passed-num" data-val="${passed ?? ''}"><span class="ratio-cur">${passed ?? '—'}</span><span class="ratio-sep">/</span><span class="ratio-req">${required}</span></span>
          <span>${L('个达标时段', 'qualified slots')}</span>
          ${isRedAlert
            ? `<span class="chip chip-red" style="min-height:19px;font-size:10px;padding:0 7px;margin-left:auto;">${L('最后 4H 红警', '4H Red Alert')}</span>`
            : isMatchPoint
              ? `<span class="chip chip-gold" style="min-height:19px;font-size:10px;padding:0 7px;margin-left:auto;">${L('赛点时刻', 'Match Point')}</span>`
              : ''}
        </div>
        <div class="progress-track"><div class="progress-fill" id="obs-progress-fill" style="width:${pct}%"></div></div>
        <div class="row-between obs-sub-row">
          <span id="obs-need-text">${need === null ? L('冲价数据待核验', 'Push data pending') : need === 0 ? L('已达门槛，等待结算', 'Threshold met · awaiting settle') : L(`还差 ${need} 个达标时段`, `${need} more needed`)}</span>
          ${est !== null ? `<span class="mono text-sec">${L('预估', 'Est.')} ~${formatNum(est)} A9</span>` : ''}
        </div>
      </div>
    </section>

    ${renderVeteranShieldCard(round, store.state.user)}

    ${renderCorridorRadar(round.candles || [], round.targetPrice, round.activeCandleSec || 0, round.livePrice, {
      qualified: passed ?? 0,
      minQualified: required,
      seen: round.candlesSeen || 0,
      stale: round.stale,
      sprint4h: isSprint4h
    })}
  `;
}

/**
 * 任天堂「12H 印章簿」（#/observation/records）
 * 改为大号手盖圆章速选板 + 固定高度判定依据卡 + 记忆选中时段
 */
export function renderObservationRecords(root) {
  const round = store.state.round;
  const candles = round.candles || [];
  const totalSlots = Number(round.protocolConfig?.candleCount ?? round.candleCount) || 12;
  const states = {
    pass: L('已确认达标', 'Confirmed · met'),
    miss: L('已确认未达标', 'Confirmed · missed'),
    active: L('冲价中 · 待确认', 'Pushing · pending'),
    pending: L('尚未开始', 'Upcoming'),
    unknown: L('数据待核验', 'Awaiting verification')
  };
  const symbols = { pass: '✓', miss: '×', active: '◉', pending: '·', unknown: '?' };
  const slots = Array.from({ length: totalSlots }, (_, i) => {
    const candle = candles.find(c => c.index === i + 1);
    const state = candle?.confirmed
      ? (candle.bull ? 'pass' : 'miss')
      : ['active', 'pending'].includes(candle?.status) ? candle.status : 'unknown';
    return { number: i + 1, state, price: candle?.p };
  });

  const confirmedCount = slots.filter(s => s.state === 'pass' || s.state === 'miss').length;
  const required = round.minQualifiedCandles || 8;
  const roundKey = String(round.currentRound ?? 'cur');
  const remembered = uiMemory.selectedSlotByRound[roundKey];
  const active = slots.find(slot => slot.state === 'active');
  let selected = Number.isInteger(remembered) && remembered >= 1 && remembered <= totalSlots
    ? remembered
    : (active?.number || 1);

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <section class="stamp-logbook wv-tower" data-round="${round.currentRound ?? ''}">
        <header class="row-between" style="margin-bottom:10px;">
          <div>
            <small>${L('第', 'Round')} ${round.currentRound ?? '—'}${L(' 轮', '')} · 12H Push</small>
            <h1 style="margin:2px 0 0;font-size:18px;font-weight:900;">${L('12H 印章簿', '12H Stamp Log')}</h1>
          </div>
          <span class="chip chip-muted mono">${L('门槛', 'Goal')} ${round.qualifiedCandles ?? '—'}/${required}</span>
        </header>

        <div class="radar-dual-counts" style="margin-top:0;">
          <div class="radar-count-box">
            <small>${L('已确认时段', 'Confirmed')}</small>
            <b>${confirmedCount} / ${totalSlots}</b>
          </div>
          <div class="radar-count-box pass">
            <small>${L('已达标时段', 'Qualified')}</small>
            <b>${round.qualifiedCandles ?? '—'} / ${required}</b>
          </div>
        </div>

        <div class="stamp-board wv-windows" role="group" aria-label="${L('选择冲价时段', 'Select 12H Push slot')}">
          ${slots.map(({ number, state }) => `
            <button type="button" class="stamp-pad" data-slot="${number}" data-state="${state}" aria-label="${L('第', 'Slot')} ${number} · ${states[state]}">
              <em aria-hidden="true">${symbols[state]}</em>
              <span>${String(number).padStart(2, '0')}</span>
            </button>
          `).join('')}
        </div>

        <div class="star-key" style="margin-top:8px;">
          <span><i class="key-pass"></i>${L('达标 ✓', 'Met ✓')}</span>
          <span><i class="key-miss"></i>${L('未达 ×', 'Miss ×')}</span>
          <span><i class="key-active"></i>${L('冲价中 ◉', 'Pushing ◉')}</span>
          <span><i class="key-pending"></i>${L('未开始', 'Upcoming')}</span>
        </div>

        ${round.stage === 'observation' && round.qualifiedCandles >= required
          ? `<p class="num-xs text-green" style="margin-top:8px;font-weight:800;">${L('已达本轮门槛，等待结算', 'Threshold met · awaiting settlement')}</p>`
          : ''}
      </section>

      <section class="star-reading stamp-detail-card" aria-live="polite"></section>

      <a class="btn btn-secondary" href="#/round">${icon('arrowLeft', 15)} ${L('返回轮次闯关', 'Back to Quest')}</a>
    </div>
  `;

  const logbook = root.querySelector('.stamp-logbook');
  const reading = root.querySelector('.star-reading');
  const fmtPrice = (v) => (v > 0 ? '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 12 }) : '—');

  function explainSlot(slot) {
    if (slot.state === 'pass') return L('本段 1H 均价 ≥ 目标底价，已盖章计入达标。', 'Slot 1H TWAP met or exceeded target; counted as qualified.');
    if (slot.state === 'miss') return L('本段 1H 均价低于目标底价，未计入达标。', 'Slot 1H TWAP fell below target; not counted.');
    if (slot.state === 'active') return L('当前时段仍在采集中，整点收盘后确认盖章。', 'Slot is live; sealed automatically on the hour.');
    if (slot.state === 'pending') return L('该时段尚未到达，进入后自动开始观测。', 'This slot has not started yet.');
    return L('该时段暂无核验记录，请等待接口同步。', 'No verified data yet for this slot.');
  }

  function select(number) {
    selected = number;
    logbook.dataset.slot = String(number);
    uiMemory.selectedSlotByRound[roundKey] = number;
    const slot = slots[number - 1];
    logbook.querySelectorAll('[data-slot]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.slot) === number)));
    const badgeCls = slot.state === 'pass' ? 'chip-green' : slot.state === 'miss' ? 'chip-red' : slot.state === 'active' ? 'chip-blue' : 'chip-muted';
    reading.innerHTML = `
      <header>
        <span style="display:inline-flex;flex-shrink:0;" aria-hidden="true">${renderNintendoGateIcon('ticket', 30)}</span>
        <div>
          <small>${L('单段判定依据', 'Slot Judgment Basis')}</small>
          <h2>${L('第', 'Slot ')} ${number}${L(' 时段', '')}</h2>
        </div>
        <b class="chip ${badgeCls}">${states[slot.state]}</b>
      </header>
      <dl>
        ${[
          [L('本段均价', 'Slot TWAP'), slot.price],
          [L('目标底价', 'Target'), round.targetPrice],
          [L('轮次均价', 'Round TWAP'), round.twap24h]
        ].map(([label, v]) => `<div><dt>${label}</dt><dd>${fmtPrice(v)}</dd></div>`).join('')}
      </dl>
      <p class="stamp-explain">${explainSlot(slot)}</p>
    `;
  }

  logbook.addEventListener('click', (event) => {
    const button = event.target.closest('[data-slot]');
    if (!button) return;
    A9Haptic.light();
    const num = Number(button.dataset.slot);
    const st = slots[num - 1]?.state;
    if (st === 'pass') A9Audio.scaleChime(num);
    else if (st === 'miss') A9Audio.stamp();
    else A9Audio.pageTurn();
    button.classList.remove('anim-slot-flip');
    void button.offsetWidth;
    button.classList.add('anim-slot-flip');
    setTimeout(() => button.classList.remove('anim-slot-flip'), 340);
    select(num);
  });

  select(selected);
}

export function renderSettlementSuccess(round, user) {
  const qual = toFiniteNum(round.qualifiedCandles);
  const req = toFiniteNum(round.minQualifiedCandles) || 8;
  return `
    <div class="card card-hero">
      <div class="row-between" style="margin-bottom:10px;">
        ${stagePillTrigger('settlement_success', round.currentRound)}
        <span class="chip chip-green">${icon('checkCircle', 11)} ${qual ?? '—'}/${req}</span>
      </div>
      <div class="num-xs text-muted">${L('实际可领奖励（已结算）', 'Actual claimable (settled)')}</div>
      <div class="num-hero" style="margin-top:4px;">${formatNum(user.a9Claimable)} <span class="num-md text-green">A9</span></div>
      <div class="metric-strip">
        <div class="metric-cell"><span class="num-xs text-muted">${L('达标时段', 'Qualified slots')}</span><span class="num-md">${qual ?? '—'}/${req}</span></div>
        <div class="metric-cell"><span class="num-xs text-muted">${L('待解锁奖励', 'Locked')}</span><span class="num-md text-sec">${formatNum(user.a9Locked)} A9</span></div>
      </div>
      <button class="btn btn-primary" data-nav="/claim">${icon('bolt', 16)} ${L('前往领奖 / 3 折急提', 'Claim / Instant Cashout')}</button>
    </div>
  `;
}

export function renderSettlementFailed(round) {
  const qual = toFiniteNum(round.qualifiedCandles);
  const hasQ = qual !== null && Number.isInteger(qual);
  const reqQ = toFiniteNum(round.minQualifiedCandles) || 8;
  const failPct = hasQ ? Math.round((qual / reqQ) * 100) : 0;
  return `
    ${renderPendingVaultBanner(store.state.prediction, round)}
    <div class="card card-glow-red alert-red-mode" id="burn-monument-card">
      <div class="row-between" style="margin-bottom:10px;">
        ${stagePillTrigger('settlement_burn', round?.currentRound || 1)}
        <span class="chip chip-red">${L('未通关 · 自动止损', 'Auto Stop-Loss')} ${hasQ ? qual : '—'}/${reqQ}</span>
      </div>
      <div class="progress-track" style="margin-bottom:10px;"><div class="progress-fill red no-anim" style="width:${failPct}%"></div></div>
      <div>
        <div class="list-row"><span class="text-sec">${L('本轮参与本金处理', 'Principal')}</span><span class="num-xs text-red">${L('永不爆仓 · 自动止损（头矿 6H 退 95% / 普通退 90%）', 'No Liquidation · Auto Stop-Loss (95% First 6H / 90% Std)')}</span></div>
        <div class="list-row"><span class="text-sec">${L('战队额度', 'Squad quota')}</span><span class="num-xs text-gold">${L('120,000,000 A9 销毁 / 结转', '120,000,000 A9 burned / carried')}</span></div>
      </div>
      <div class="sub-tile" style="margin-top:10px;">
        <div class="num-xs text-sec" style="line-height:1.5;">${L('分享本轮自动止损与半池通缩战报，下轮宝箱商城享优先通道。', 'Share this Auto Stop-Loss & half-pool burn proof for next-round Chest Mall access.')}</div>
      </div>
      <a class="btn btn-primary" href="#/claim" style="margin-top:12px;">${icon('wallet', 15)} ${L('领回 95% / 90% 止损退本', 'Claim 95% / 90% Stop-Loss Refund')}</a>
      <button class="btn btn-secondary" data-x-share="burn" type="button" style="margin-top:8px;">${icon('xBrand', 15)} ${L('分享本轮自动止损战报', 'Share Stop-Loss Proof')}</button>
    </div>
  `;
}

/**
 * v17.0 每轮等权空投抽奖公示卡片（Demo 展示演示数据，Live 严格展示服务端结果）
 */
export function renderAirdropDrawsCard({ loading = false, error = null, items = [], bucketRemainingRaw = null } = {}) {
  const remA9 = bucketRemainingRaw !== null && bucketRemainingRaw !== undefined ? rawToA9(bucketRemainingRaw) : null;
  const list = Array.isArray(items) ? items : [];
  const bodyHtml = loading
    ? `<div class="num-xs text-muted" style="padding:6px 0;">${L('正在读取每轮空投公示…', 'Loading round airdrop draws…')}</div>`
    : error
      ? `<div class="row-between" style="gap:8px;"><span class="num-xs text-red">${escapeHtml(error)}</span><button class="btn btn-secondary btn-sm" id="btn-retry-airdrop-draws" type="button">${L('重试', 'Retry')}</button></div>`
      : list.length === 0
        ? `<div class="num-xs text-muted" style="padding:4px 0;">${L('暂无已开奖的每轮空投记录，轮次结算后将自动公示中奖地址与可验证 Seed。', 'No round airdrop draws yet. Winners and verifiable seeds are published upon settlement.')}</div>`
        : `<div class="col-gap" style="gap:6px;">${list.map((d) => {
            const prizeA9 = rawToA9(d.prizeRaw) ?? 0;
            const seedStr = String(d.seedHash || '');
            const seedShort = seedStr.length > 18 ? `${seedStr.slice(0, 10)}…${seedStr.slice(-6)}` : seedStr;
            const isCredited = String(d.status || '').toUpperCase() === 'CREDITED';
            return `
              <div class="list-row" style="padding:8px 10px;">
                <div style="min-width:0;">
                  <div class="num-sm" style="font-weight:800;">${L(`第 ${d.roundId} 轮`, `Round #${d.roundId}`)} · <span class="mono">${escapeHtml(d.winnerWallet || '—')}</span></div>
                  <div class="num-xs text-muted mono" style="margin-top:2px;">Seed: ${escapeHtml(seedShort || '—')}</div>
                </div>
                <div style="text-align:right;flex-shrink:0;">
                  <div class="num-sm text-green mono" style="font-weight:900;">+${formatNum(Math.round(prizeA9), 0)} A9</div>
                  <span class="chip ${isCredited ? 'chip-green' : 'chip-gold'}" style="min-height:18px;font-size:9.5px;margin-top:2px;">${isCredited ? L('已入推广金库', 'Credited') : L('待入账', 'Pending')}</span>
                </div>
              </div>
            `;
          }).join('')}</div>`;

  return `
    <section class="card" id="a9-airdrop-draws-card">
      <div class="row-between" style="margin-bottom:8px;">
        <span class="card-title">${icon('trophy', 15, 'text-gold')} ${L('每轮等权空投公示', 'Per-Round Equal Airdrop')}</span>
        <span class="chip chip-muted mono">${remA9 !== null ? L(`池余 ${formatNum(Math.round(remA9), 0)} A9`, `${formatNum(Math.round(remA9), 0)} A9 Left`) : L('50,000,000 A9 池', '50,000,000 A9 Pool')}</span>
      </div>
      ${bodyHtml}
    </section>
  `;
}

export function renderTechnicalHalt(round) {
  return `
    <div class="card card-hero" style="border-color:var(--gold-border);">
      <div class="row-between" style="margin-bottom:12px;">
        ${stagePillTrigger('halted', round?.currentRound || 1)}
        <span class="chip chip-green">${icon('shieldCheck', 11)} ${L('本金安全', 'Principal safe')}</span>
      </div>
      <div style="font-size:18px;font-weight:800;margin-bottom:6px;">${L('本轮触发异常中止 · 退回本金', 'Aborted · Principal Refunded')}</div>
      <div class="text-sec" style="font-size:12px;margin-bottom:14px;">${L('预言机或网络异常触发合约安全中止，参与本金按规则原路退回。', 'Oracle/network anomaly triggered a contract abort; principal is refunded.')}</div>
      <button class="btn btn-primary" data-nav="/risk/audit">${icon('shieldCheck', 16)} ${L('查看链上退款存证', 'View Refund Proof')}</button>
    </div>
  `;
}
