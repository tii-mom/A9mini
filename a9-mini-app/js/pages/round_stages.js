import { renderNintendoGateIcon } from '../paper-art.js';
import { store } from '../store.js';
import { config } from '../config.js';
import { uiMemory } from '../app.js';
import { escapeHtml, formatNum, formatTimer } from '../components.js';
import { renderCorridorRadar, renderViralStrip, renderLiveSparkline } from '../components-heavy.js';
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { estimateRewardA9, rawToA9, getEffectiveUserId, serverNowMs } from '../data.js';
import { deriveRoundUiState } from '../round-state.js';

function stagePillTrigger(roundOrStage, roundNum) {
  const detail = (roundOrStage && typeof roundOrStage === 'object') ? roundOrStage : { stage: roundOrStage };
  const ui = deriveRoundUiState({ detail, user: store.state.user, serverNowMs: serverNowMs() });
  const text = L(`第 ${roundNum} 轮 · ${ui.badgeLabel}`, `Round ${roundNum} · ${ui.badgeLabel}`);
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
 * 统一计算本轮实时价格、目标价、差幅与水位标尺位置（严格隔离 Demo/Live，绝不把 null 当 0）
 */
export function computeRoundPriceMetrics(round) {
  const r = round || {};
  const priceAllowed = r.priceValid !== false;
  const rawLive = priceAllowed ? (r.livePrice ?? r.twap24h) : null;
  const livePrice = toFiniteNum(rawLive);
  const validLive = livePrice !== null && livePrice > 0 ? livePrice : null;
  const rawTarget = toFiniteNum(r.targetPrice);
  const validTarget = rawTarget !== null && rawTarget > 0 ? rawTarget : null;

  let deltaPct = null;
  let isAbove = false;
  let rulerPct = 0;
  if (validLive !== null && validTarget !== null) {
    deltaPct = ((validLive - validTarget) / validTarget) * 100;
    isAbove = deltaPct >= 0;
    const minBound = validTarget * 0.75;
    const maxBound = validTarget * 1.15;
    const rawPct = ((validLive - minBound) / (maxBound - minBound)) * 100;
    rulerPct = Math.max(8, Math.min(100, Math.round(rawPct * 10) / 10));
  }

  const deltaText = deltaPct === null
    ? L('价格待同步', 'Syncing price')
    : isAbove
      ? L(`已站上目标价 +${deltaPct.toFixed(1)}%`, `Above target +${deltaPct.toFixed(1)}%`)
      : L(`距目标价差 ${deltaPct.toFixed(1)}%`, `Below target ${deltaPct.toFixed(1)}%`);

  return {
    livePrice: validLive,
    targetPrice: validTarget,
    liveText: validLive !== null ? `$${validLive.toFixed(4)}` : '—',
    targetText: validTarget !== null ? `$${validTarget.toFixed(4)}` : '—',
    deltaPct,
    isAbove,
    deltaText,
    rulerPct,
  };
}

/**
 * 实时 A9 价格作战看板（24H 锁仓与 12H 冲价首屏必显）
 */
export function renderPriceArenaBoard(round, { mode = 'observation' } = {}) {
  const m = computeRoundPriceMetrics(round);
  const uiState = deriveRoundUiState({ detail: round, user: store.state.user, serverNowMs: serverNowMs() });
  const cdSec = uiState.countdownMs !== null ? Math.ceil(uiState.countdownMs / 1000) : null;
  const cdDisplay = cdSec !== null && cdSec > 0 ? formatTimer(cdSec) : uiState.countdownLabel;
  const isUrgent = cdSec !== null && cdSec > 0 && cdSec <= 3600;
  const dotCls = m.deltaPct === null ? '' : (m.isAbove ? 'is-up' : 'is-down');
  const chipCls = m.deltaPct === null ? 'chip-muted' : (m.isAbove ? 'chip-green' : 'chip-red');
  const poolText = (round?.rewardBudgetA9 !== null && round?.rewardBudgetA9 !== undefined && Number.isFinite(Number(round.rewardBudgetA9)))
    ? `${formatNum(round.rewardBudgetA9)} A9`
    : '—';
  const cdLabel = mode === 'participation'
    ? L('锁仓倒计时', 'Lock Closes')
    : L('本轮冲价剩余', 'Push Left');

  return `
    <div class="sw-price-arena" id="round-price-arena">
      <div class="sw-price-arena-top">
        <div class="sw-price-live-block">
          <span class="sw-price-token">
            <img src="./assets/token/a9-token.svg" alt="A9" width="28" height="28" decoding="async" />
          </span>
          <div style="min-width:0;">
            <div class="row-start" style="gap:5px;margin-bottom:2px;">
              <span class="sw-pulse-dot ${dotCls}" id="round-live-pulse" aria-hidden="true"></span>
              <span class="num-xs text-muted">${L('A9 当前参考价', 'A9 Ref Price')}</span>
            </div>
            <div class="sw-price-main" id="round-live-price">${m.liveText}</div>
          </div>
        </div>
        <div class="sw-price-target-block">
          <span class="num-xs text-muted">${L('目标通关价', 'Target Price')}</span>
          <span class="sw-price-target-val" id="round-target-price">${m.targetText}</span>
          <span class="sw-price-cd ${isUrgent ? 'is-urgent' : ''}">${cdLabel} <b id="round-cd">${cdDisplay}</b></span>
        </div>
      </div>

      <div class="row-between" style="flex-wrap:wrap;gap:6px;">
        <span class="chip ${chipCls} mono" id="round-target-delta">${m.deltaText}</span>
        <span class="num-xs text-sec mono">${L('通关解锁', 'Unlock')} <b style="color:var(--ink);">${poolText}</b></span>
      </div>

      <div class="sw-price-ruler-wrap">
        <div class="sw-price-ruler" aria-label="${L('实时价格距目标价水位条', 'Live price vs target gauge')}">
          <div class="sw-price-ruler-fill ${m.isAbove ? 'is-up' : ''}" id="round-price-ruler-fill" style="width:${m.rulerPct}%;"></div>
          <span class="sw-price-ruler-target" title="${L('目标通关价', 'Target Price')}" aria-hidden="true"></span>
        </div>
        <div class="sw-price-ruler-labels">
          <span>${L('开盘区间', 'Base')}</span>
          <span style="color:var(--ink);font-weight:800;">${L('目标线', 'Target')} ${m.targetText}</span>
          <span>${L('超额冲高', 'Breakout')}</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * 生成实时战况喊单话术（Demo/Live 通用，Live 绝不编造缺失价格或进度）
 */
export function buildBattleRallyCopy(round, inviteLink, tpl = 'push') {
  const r = round || {};
  const roundNum = r.currentRound != null ? L(`第 ${r.currentRound} 轮`, `Round #${r.currentRound}`) : L('本轮', 'Current Round');
  const m = computeRoundPriceMetrics(r);
  const qual = toFiniteNum(r.qualifiedCandles);
  const req = toFiniteNum(r.minQualifiedCandles) || 8;
  const need = qual !== null ? Math.max(0, req - qual) : null;
  const poolStr = (r.rewardBudgetA9 !== null && r.rewardBudgetA9 !== undefined && Number.isFinite(Number(r.rewardBudgetA9)))
    ? `${formatNum(r.rewardBudgetA9)} A9`
    : L('700,000,000 A9 奖池', '700,000,000 A9 pool');

  if (tpl === 'first6h') {
    return L(
      `【A9 ${roundNum} · 头矿 6H 召唤】最低 100 A9 锁仓参战，头矿 6H 未通关仅 5% 轻止损（退 95%），永不爆仓！通关全员 1:1 分 ${poolStr}（最高 5×），一起来冲：${inviteLink}`,
      `[A9 ${roundNum} · First 6H Call] Lock from 100 A9 with 5% Stop-Loss (95% refund if missed) and no liquidation! Pass 8/12 slots to split ${poolStr} up to 5x: ${inviteLink}`
    );
  }
  if (tpl === 'free') {
    return L(
      `【A9 新人 0 GRAM 上车】免费秒开新手青铜箱领 200 A9，再进 0 GRAM 12H 预言擂台猜涨跌！宝箱商城 0.99 GRAM 起保底 + 随机直发钱包：${inviteLink}`,
      `[A9 0 GRAM Free Start] Open your free 200 A9 Starter Bronze Chest and join the 0 GRAM 12H Prediction Arena! Chest Mall starts at 0.99 GRAM with direct wallet payout: ${inviteLink}`
    );
  }
  const priceLineZh = m.deltaPct !== null
    ? `A9 实时价 ${m.liveText}（${m.isAbove ? `已站上目标价 ${m.targetText} +${m.deltaPct.toFixed(1)}%` : `距目标价 ${m.targetText} 仅差 ${Math.abs(m.deltaPct).toFixed(1)}%`}）`
    : (m.targetPrice !== null ? `本轮目标价 ${m.targetText}（实时价链上同步中）` : '本轮链上实时行情同步中');
  const priceLineEn = m.deltaPct !== null
    ? `A9 live ${m.liveText} (${m.isAbove ? `above ${m.targetText} by +${m.deltaPct.toFixed(1)}%` : `${Math.abs(m.deltaPct).toFixed(1)}% from ${m.targetText} target`})`
    : (m.targetPrice !== null ? `Target ${m.targetText} (live price syncing)` : 'On-chain live price syncing');
  const slotLineZh = need !== null ? (need === 0 ? `已达 ${qual}/${req} 通关门槛，守住结算！` : `目前 ${qual}/${req} 格达标，还差 ${need} 个时段解锁 ${poolStr}！`) : `冲刺 8/12 达标时段解锁 ${poolStr}！`;
  const slotLineEn = need !== null ? (need === 0 ? `${qual}/${req} slots met — hold for settlement!` : `${qual}/${req} slots met, ${need} more to unlock ${poolStr}!`) : `Push 8/12 slots to unlock ${poolStr}!`;
  return L(
    `【A9 ${roundNum} 冲线喊单】${priceLineZh}，${slotLineZh} 一起来推高通关，我还能赚好友通关 8% 返佣：${inviteLink}`,
    `[A9 ${roundNum} Push Rally] ${priceLineEn} — ${slotLineEn} Join the push for 8% friend pass referral credits: ${inviteLink}`
  );
}

/**
 * 战场直连战队动员助推卡（闯关页核心联动卡）
 */
export function renderRoundRallyCard(round) {
  const m = computeRoundPriceMetrics(round);
  const hintText = m.deltaPct === null
    ? L('拉好友一起参与本轮涨价解锁，通关享 8% 好友奖金返佣 + 商城直推 6%。', 'Rally friends to push A9 past target and earn 8% friend pass credits + 6% mall referrals.')
    : m.isAbove
      ? L('已站上目标线！叫上战队一起稳住买盘守住盖章，同时赚好友通关 8% 返佣。', 'Above target! Rally your squad to hold the line and earn 8% friend pass credits.')
      : L('想让本轮 A9 冲过目标价、尽快解锁奖池并额外赚好友通关 8% 返佣？立刻去战队动员喊单！', 'Want A9 to cross target, unlock the pool faster, and earn 8% friend pass credits? Rally your squad now!');
  return `
    <section class="card sw-rally-card" id="round-rally-card">
      <div class="row-between" style="margin-bottom:6px;">
        <span class="card-title">${icon('team', 15, 'text-red')} ${L('战队动员助推 · 一起冲线', 'Squad Rally · Push Together')}</span>
        <span class="chip chip-green mono">6% + 8%</span>
      </div>
      <p class="num-xs text-sec" style="margin:0 0 10px;line-height:1.5;">${hintText}</p>
      <div class="grid-2" style="gap:8px;">
        <a class="btn btn-primary btn-sm" href="#/team?action=rally" style="width:100%;min-height:40px;">${icon('send', 13)} ${L('去战队动员喊单', 'Rally Squad')} ›</a>
        <button class="btn btn-secondary btn-sm" id="btn-round-copy-rally" type="button" style="width:100%;min-height:40px;">${icon('copy', 13)} ${L('一键复制战况喊单', 'Copy Battle Call')}</button>
      </div>
    </section>
  `;
}

/**
 * v17.0 心理安全垫卡片：头矿 6H (5% 止损) vs 普通 (10% 止损) + 24H 锁仓期提前解押 (退 85% / 烧 15%) + 每轮 100,000 A9 等权空投
 */
export function renderSafetyCushionCard(round) {
  const inFirst6h = Boolean(round?.inFirst6h);
  const isLocking = deriveRoundUiState({ detail: round, user: store.state.user, serverNowMs: serverNowMs() }).stage === 'stake';
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
  const derivedStage = deriveRoundUiState({ detail: round, user: store.state.user, serverNowMs: serverNowMs() }).stage;
  const isLocking = derivedStage === 'stake' || Boolean(ticket.canEarlyExit);
  const isSealedOrCharging = derivedStage === 'sealed' || derivedStage === 'charge';
  const isSettling = derivedStage === 'settling';
  const isSuccess = derivedStage === 'passed' || Boolean(ticket.canInstantCashout);
  const isFail = derivedStage === 'failed';
  const isAborted = derivedStage === 'aborted';

  let statusChip = `<span class="chip chip-cyan">${L('持仓中', 'Active')}</span>`;
  if (ticket.exited) statusChip = `<span class="chip chip-muted">${L('已提前解押 (-15%)', 'Early Exited (-15%)')}</span>`;
  else if (isLocking) statusChip = `<span class="chip chip-gold">${L('24H 锁仓中 · 可提前解押', '24H Lock · Early Exit Open')}</span>`;
  else if (isSealedOrCharging) statusChip = `<span class="chip chip-blue">${derivedStage === 'sealed' ? L('已封盘 · 待冲价', 'Sealed · Awaiting Push') : L('12H 冲价中 · 封盘锁定', '12H Push · Locked')}</span>`;
  else if (isSettling) statusChip = `<span class="chip chip-gold">${L('结算中 · 待确认', 'Settling · Pending')}</span>`;
  else if (isSuccess) statusChip = `<span class="chip chip-green">${L('已通关 · 可领 / 3 折急提', 'Passed · Claim / Cashout')}</span>`;
  else if (isFail) statusChip = `<span class="chip chip-red">${L('未达标 · 可领止损退本', 'Auto Stop-Loss Refund')}</span>`;
  else if (isAborted) statusChip = `<span class="chip chip-green">${L('异常中止 · 可领 100% 退本', 'Aborted · 100% Refund')}</span>`;

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

  if (round && deriveRoundUiState({ detail: round, user: store.state.user, serverNowMs: serverNowMs() }).stage === 'stake') {
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
        ${L(`0.99 GRAM 购箱共得 ${formatNum(firstOrderTotalA9, 0)} A9（含 +${bonusPct}% 赠金），或锁仓 / 邀 1 友购箱自动激活。`, `0.99 GRAM chest yields ${formatNum(firstOrderTotalA9, 0)} A9 (+${bonusPct}% bonus), or auto-activates via lock / one invited buyer.`)}
      </p>
      <div class="grid-2" style="gap:8px;">
        <button class="btn btn-primary btn-sm" data-nav="/internal/market" type="button" style="width:100%;min-height:40px;white-space:nowrap;">${icon('swap', 14)} ${L('首单加赠领箱', 'Claim with Bonus')}</button>
        <button class="btn btn-secondary btn-sm" data-nav="/team/invite" type="button" style="width:100%;min-height:40px;white-space:nowrap;">${icon('send', 14)} ${L('邀 1 友购箱激活', 'Invite a Buyer')}</button>
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
  if (!round || deriveRoundUiState({ detail: round, user: store.state.user, serverNowMs: serverNowMs() }).stage !== 'stake') return '';
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
  const derivedUi = deriveRoundUiState({ detail: round, user, serverNowMs: serverNowMs() });
  const derivedStage = derivedUi.stage;
  if (derivedStage === 'unknown' || derivedStage === 'warmup' || derivedStage === 'aborted') {
    return `<section class="card col-gap" id="a9-prediction-card"><strong>${L('12H 预言擂台', '12H Prediction Arena')}</strong><span>${derivedStage === 'aborted' ? L('本轮已中止', 'Round aborted') : L('本轮预言暂未开放', 'Predictions are closed for now')}</span></section>`;
  }
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
  const settled = Boolean(p.settled || derivedStage === 'passed' || derivedStage === 'failed');
  const winningSide = p.winningSide || (derivedStage === 'passed' ? 'PASS' : derivedStage === 'failed' ? 'BURN' : null);
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
  const cdSecNow = derivedUi.countdownMs !== null ? Math.ceil(derivedUi.countdownMs / 1000) : null;
  const isSprint4h = derivedStage === 'charge' && cdSecNow !== null && cdSecNow > 0 && cdSecNow <= 14400;
  const isRedAlert = (isSprint4h && qualNow !== null && qualNow >= 6 && qualNow <= 7) || derivedStage === 'failed';
  const headerTag = isRedAlert
    ? `<span class="chip chip-red">${derivedStage === 'failed' ? L('止损警报 FAIL', 'STOP-LOSS ALERT') : L('最后 4H 红警', '4H RED ALERT')}</span>`
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
        <span class="num-xs text-green" style="font-weight:800;">${L('待激活奖励余额', 'Pending Activation Balance')}</span>
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
      <div class="pred-expand-wrap ${isExpanded ? 'open' : ''}" ${isExpanded ? '' : 'hidden inert'}>
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
        ${stagePillTrigger(round, round.currentRound)}
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

function formatCloseTime(ts) {
  const sec = toUnixSec(ts);
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(L('zh-CN', 'en-US'), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC';
}

export function renderParticipation(round) {
  const qAmt = round.quickStakeA9 || 5000;
  const est = config.isDemo ? estimateRewardA9(qAmt) : null;
  const inFirst6h = Boolean(round.inFirst6h);
  const canStake = config.isDemo || store.fundsEnabled;
  const closeTimeStr = formatCloseTime(round.stakeCloseAt);
  const openAt = toUnixSec(round.stakeOpenAt);
  const closeAt = toUnixSec(round.stakeCloseAt);
  const explicitEarlyEnd = toUnixSec(round.earlyCloseAt);
  const nowSec = Math.floor(Date.now() / 1000);
  const earlyEnd = explicitEarlyEnd > 0
    ? explicitEarlyEnd
    : (openAt > 0 && closeAt > openAt ? openAt + Number(round.earlyWindowSeconds || 21600) : 0);
  let earlyRemSec = (earlyEnd > 0 && nowSec < earlyEnd) ? (earlyEnd - nowSec) : null;
  if ((earlyRemSec === null || earlyRemSec <= 0) && config.isDemo && inFirst6h && Number(round.earlyBirdSec) > 0) {
    earlyRemSec = Math.floor(Number(round.earlyBirdSec));
  }
  const slChipHtml = inFirst6h
    ? (earlyRemSec !== null && earlyRemSec > 0
      ? `<span class="chip chip-green mono">${L('头矿 6H · 5%', 'First 6H · 5%')} · <span id="early-window-cd">${formatTimer(earlyRemSec)}</span></span>`
      : `<span class="chip chip-green">${L('头矿 6H · 5% 止损', 'First 6H · 5% Stop-Loss')}</span>`)
    : `<span class="chip chip-gold">${L('普通 · 10% 止损', 'Std · 10% Stop-Loss')}</span>`;

  return `
    <section class="card card-hero col-gap">
      <div class="row-between" style="flex-wrap:wrap;gap:6px;">
        ${stagePillTrigger(round, round.currentRound ?? '—')}
        ${slChipHtml}
      </div>

      ${renderPriceArenaBoard(round, { mode: 'participation' })}

      <div class="row-between num-xs text-muted">
        <span>${L('24H 锁仓截止', '24H Lock Closes')} <b class="mono">${closeTimeStr}</b></span>
        <span>${L('满 8/12 段通关 · 5× 封顶', '8/12 to pass · 5× cap')}</span>
      </div>

      ${config.isDemo ? `
        <div class="hero-amt-pills" style="margin-bottom:2px;">
          ${[1000, 5000, 10000].map(v => `
            <button class="hero-amt-pill ${qAmt === v ? 'active' : ''}" data-hero-amt="${v}" type="button">${formatNum(v)} A9</button>
          `).join('')}
        </div>
      ` : ''}

      ${canStake
        ? `<a class="btn btn-primary" id="hero-stake-cta" href="#/challenge/confirm">${icon('bolt', 16)} ${config.isDemo ? L(`立即锁仓 ${formatNum(qAmt)} A9`, `Lock ${formatNum(qAmt)} A9`) : L('100 A9 起参与锁仓', 'Lock from 100 A9')}</a>`
        : `<button class="btn btn-secondary" type="button" disabled>${icon('lock', 15)} ${L('真实只读 · 暂未开放锁仓', 'Live read-only · locking disabled')}</button>`}
      ${est !== null ? `<div class="num-xs text-muted">${L('预计奖励约', 'Est.')} <b id="hero-est-a9" style="color:var(--ink);">~${formatNum(Math.round(est))} A9</b> · ${L('动态估算非承诺', 'dynamic estimate')}</div>` : ''}
    </section>
  `;
}

/**
 * 挑战页 12H 冲价 / 等待结算总览：实时价格作战看板 + 紧迫达标进度 + 6×2 印章盘 + 时段明细入口
 */
export function renderObservation(round) {
  const uiState = deriveRoundUiState({ detail: round, user: store.state.user, serverNowMs: serverNowMs() });
  const isAwaitingSettle = uiState.stage === 'settling';
  const qualVal = toFiniteNum(round.qualifiedCandles);
  const hasQualified = qualVal !== null && Number.isInteger(qualVal);
  const passed = hasQualified ? qualVal : null;
  const required = toFiniteNum(round.minQualifiedCandles) || 8;
  const needMoreVal = toFiniteNum(round.needMore);
  const need = !hasQualified ? null : (needMoreVal !== null ? needMoreVal : Math.max(0, required - passed));
  const pct = hasQualified && required ? Math.round(Math.min(100, (passed / required) * 100)) : 0;
  const m = computeRoundPriceMetrics(round);
  const poolStr = (round.rewardBudgetA9 !== null && round.rewardBudgetA9 !== undefined && Number.isFinite(Number(round.rewardBudgetA9)))
    ? `${formatNum(round.rewardBudgetA9)} A9`
    : L('本轮奖池', 'round pool');
  const priceActionHint = isAwaitingSettle
    ? L('12 个时段已采集完成 · 等待链上结算', 'All 12 slots finalized · awaiting settlement')
    : m.deltaPct === null
      ? L('实时价格同步中 · 整点达标自动盖章', 'Live price syncing · stamps automatically on close')
      : m.isAbove
        ? L('当前参考价高于目标，待时段结束后按 1H 判定均价确认', 'Current reference price is above target; confirmed by 1H average at slot close')
        : L('当前参考价低于目标，待时段结束后按 1H 判定均价确认', 'Current reference price is below target; confirmed by 1H average at slot close');

  return `
    <section class="card card-hero col-gap">
      <div class="row-between">
        ${stagePillTrigger(round, round.currentRound ?? '—')}
        ${isAwaitingSettle
          ? `<span class="chip chip-gold">${L('等待结算', 'Awaiting Settlement')}</span>`
          : `<span class="chip ${m.deltaPct !== null && !m.isAbove ? 'chip-red' : 'chip-green'} mono">${passed ?? '—'}/${required} ${L('达标', 'Met')}</span>`}
      </div>

      ${renderPriceArenaBoard(round, { mode: 'observation' })}

      <div class="col-gap" style="gap:6px;">
        <div class="row-between">
          <strong id="obs-need-text" style="font-size:14.5px;font-weight:900;">${isAwaitingSettle
            ? L('已采集 12/12 · 等待链上结算', '12/12 Finalized · Awaiting Settlement')
            : (need === null ? L('达标进度同步中', 'Syncing progress') : need === 0 ? L(`已满足达标门槛，等待解锁 ${poolStr}`, `Goal met · unlocking ${poolStr}`) : L(`还差 ${need} 个达标时段解锁 ${poolStr}`, `${need} more slots to unlock ${poolStr}`))}</strong>
          <span id="obs-passed-num" data-val="${passed ?? ''}" class="mono num-xs text-muted">${passed ?? '—'}/${required}</span>
        </div>
        <div class="progress-track"><div class="progress-fill" id="obs-progress-fill" style="width:${pct}%"></div></div>
        <div class="num-xs ${m.deltaPct !== null ? (m.isAbove ? 'text-green' : 'text-red') : 'text-sec'}" id="round-price-action-hint" style="font-weight:800;">${priceActionHint}</div>
      </div>
    </section>

    ${renderCorridorRadar(round.candles || [], round.targetPrice, round.activeCandleSec || 0, round.livePrice, {
      qualified: passed ?? 0,
      minQualified: required,
      seen: round.candlesSeen,
      stale: round.stale,
    })}

    <a class="btn btn-primary" href="#/observation/records">${icon('clock', 15)} ${L('查看时段明细', 'View Slot Details')} ›</a>
  `;
}

/**
 * 任天堂「12H 印章簿」（#/observation/records）
 * 复用统一 6×2 任天堂关卡印章 + 固定高度判定依据卡 + 记忆选中时段
 */
export function renderObservationRecords(root) {
  const round = store.state.round;
  const candles = round.candles || [];
  const totalSlots = Number(round.protocolConfig?.candleCount ?? round.candleCount) || 12;
  const states = {
    pass: L('已确认达标', 'Confirmed · met'),
    miss: L('已确认未达标', 'Confirmed · missed'),
    active: L('进行中 · 确认后盖章', 'Live · seals on close'),
    pending: L('未开始', 'Upcoming'),
    unknown: L('数据待核验', 'Awaiting verification')
  };
  const symbols = { pass: '✓', miss: '×', active: '◉', pending: '·', unknown: '?' };
  const slots = Array.from({ length: totalSlots }, (_, i) => {
    const candle = candles.find(c => c.index === i + 1);
    const state = candle?.confirmed || candle?.status === 'closed'
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
            <small>${L('第', 'Round')} ${round.currentRound ?? '—'}${L(' 轮', '')} · ${L('12H 冲价', '12H Push')}</small>
            <h1 style="margin:2px 0 0;font-size:18px;font-weight:900;">${L('12H 印章簿', '12H Stamp Log')}</h1>
          </div>
          <span class="chip chip-muted mono">${L('通关需', 'Goal')} ${required} ${L('格', 'slots')}</span>
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

        <div class="sw-stamp-grid" role="group" aria-label="${L('选择冲价时段', 'Select 12H Push slot')}">
          ${slots.map(({ number, state }) => {
            const cls = state === 'pass' ? 'is-pass' : state === 'miss' ? 'is-miss' : state === 'active' ? 'is-active' : 'is-pending';
            const inner = state === 'pass' || state === 'miss'
              ? `<span class="sw-stamp-mark" aria-hidden="true">${symbols[state]}</span><span class="sw-stamp-num">${String(number).padStart(2, '0')}</span>`
              : state === 'active'
                ? `<span class="sw-stamp-dot" aria-hidden="true"></span><span class="sw-stamp-live-tag">${L('进行中', 'Live')}</span>`
                : `<span class="sw-stamp-num">${String(number).padStart(2, '0')}</span>`;
            return `<button type="button" class="sw-stamp-cell ${cls}" data-slot="${number}" data-state="${state}" aria-label="${L('第', 'Slot')} ${number} · ${states[state]}">${inner}</button>`;
          }).join('')}
        </div>

        ${deriveRoundUiState({ detail: round, user: store.state.user, serverNowMs: serverNowMs() }).stage === 'charge' && round.qualifiedCandles >= required
          ? `<p class="num-xs text-green" style="margin-top:8px;font-weight:800;">${L('已满足达标时段数，等待结算确认', 'Target slots met · awaiting final settlement')}</p>`
          : ''}
      </section>

      <section class="star-reading stamp-detail-card" aria-live="polite"></section>

      <a class="btn btn-secondary" href="#/round">${icon('arrowLeft', 15)} ${L('返回闯关', 'Back to Quest')}</a>
    </div>
  `;

  const logbook = root.querySelector('.stamp-logbook');
  const reading = root.querySelector('.star-reading');
  const fmtPrice = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const digits = n >= 0.0001 ? 4 : 8;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };

  function explainSlot(slot) {
    if (slot.state === 'pass') return L('本段 1H 均价 ≥ 目标价，已盖章计入达标。', 'Slot 1H TWAP met or exceeded target; counted as qualified.');
    if (slot.state === 'miss') return L('本段 1H 均价低于目标价，未计入达标。', 'Slot 1H TWAP fell below target; not counted.');
    if (slot.state === 'active') return L('当前时段进行中，整点确认后盖章。', 'Slot is live; sealed automatically after confirmation.');
    if (slot.state === 'pending') return L('该时段尚未开始。', 'This slot has not started yet.');
    return L('该时段暂无核验记录，请等待接口同步。', 'No verified data yet for this slot.');
  }

  function select(number) {
    selected = number;
    logbook.dataset.slot = String(number);
    uiMemory.selectedSlotByRound[roundKey] = number;
    const slot = slots[number - 1];
    logbook.querySelectorAll('[data-slot]').forEach(b => {
      const activeSel = Number(b.dataset.slot) === number;
      b.setAttribute('aria-pressed', String(activeSel));
      b.classList.toggle('is-selected', activeSel);
    });
    const badgeCls = slot.state === 'pass' ? 'chip-green' : slot.state === 'miss' ? 'chip-red' : slot.state === 'active' ? 'chip-gold' : 'chip-muted';
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
          [L('目标价', 'Target'), round.targetPrice],
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
    select(num);
  });

  select(selected);
}

function fmtSettleA9(val) {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) return '—';
  const n = Number(val);
  return `${formatNum(n, n % 1 === 0 ? 0 : 2)} A9`;
}

export function renderSettlementBreakdownRows({ principalA9 = null, rewardA9 = null, lockedA9 = null } = {}) {
  return `
    <div class="sw-menu-group" id="round-settlement-personal">
      <div class="sw-menu-row is-static">
        <div class="sw-menu-left"><span class="sw-menu-title">${L('本人可退本金', 'Refundable Principal')}</span></div>
        <div class="sw-menu-right"><span class="sw-menu-amount">${fmtSettleA9(principalA9)}</span></div>
      </div>
      <div class="sw-menu-row is-static">
        <div class="sw-menu-left"><span class="sw-menu-title">${L('可领奖金', 'Claimable Reward')}</span></div>
        <div class="sw-menu-right"><span class="sw-menu-amount ${Number(rewardA9) > 0 ? 'is-green' : ''}">${fmtSettleA9(rewardA9)}</span></div>
      </div>
      <div class="sw-menu-row is-static">
        <div class="sw-menu-left"><span class="sw-menu-title">${L('待解锁金额', 'Pending Unlock')}</span></div>
        <div class="sw-menu-right"><span class="sw-menu-amount ${Number(lockedA9) > 0 ? 'is-amber' : ''}">${fmtSettleA9(lockedA9)}</span></div>
      </div>
    </div>
  `;
}

export function renderSettlementSuccess(round, user, ticket = null) {
  const qual = toFiniteNum(round.qualifiedCandles);
  const req = toFiniteNum(round.minQualifiedCandles) || 8;
  const principalA9 = ticket ? rawToA9(ticket.claimablePrincipalRaw ?? ticket.amountRaw) : (config.isDemo ? (round.myStakeTon || 5000) : null);
  const rewardA9 = ticket ? rawToA9(ticket.claimableRewardRaw) : (config.isDemo ? user.a9Claimable : null);
  const lockedA9 = ticket ? rawToA9(ticket.lockedRemainingRaw) : (config.isDemo ? user.a9Locked : null);
  const passHref = ticket?.ticketAddress ? `#/claim?ticket=${encodeURIComponent(ticket.ticketAddress)}` : '#/claim';
  return `
    <section class="card card-hero col-gap">
      <div class="row-between">
        ${stagePillTrigger(round, round.currentRound ?? '—')}
        <span class="chip chip-green">${icon('checkCircle', 11)} ${qual ?? '—'}/${req}</span>
      </div>
      ${renderSettlementBreakdownRows({ principalA9, rewardA9, lockedA9 })}
      <a class="btn btn-primary" href="${passHref}">${icon('bolt', 16)} ${L('查看凭证与领奖', 'View Pass & Claim')} ›</a>
    </section>
  `;
}

export function renderSettlementFailed(round, ticket = null) {
  const qual = toFiniteNum(round.qualifiedCandles);
  const hasQ = qual !== null && Number.isInteger(qual);
  const reqQ = toFiniteNum(round.minQualifiedCandles) || 8;
  const failPct = hasQ ? Math.round((qual / reqQ) * 100) : 0;
  const principalA9 = ticket ? rawToA9(ticket.claimablePrincipalRaw) : (config.isDemo ? Math.round((round.myStakeTon || 5000) * (round.inFirst6h ? 0.95 : 0.90)) : null);
  const passHref = ticket?.ticketAddress ? `#/claim?ticket=${encodeURIComponent(ticket.ticketAddress)}` : '#/claim';
  return `
    <section class="card card-glow-red col-gap" id="burn-monument-card">
      <div class="row-between">
        ${stagePillTrigger(round, round?.currentRound ?? '—')}
        <span class="chip chip-red">${L('未通关 · 自动止损', 'Auto Stop-Loss')} ${hasQ ? qual : '—'}/${reqQ}</span>
      </div>
      <div class="progress-track"><div class="progress-fill red no-anim" style="width:${failPct}%"></div></div>
      <div class="num-xs text-sec">${L('永不爆仓 · 自动止损（头矿 6H 退 95% / 普通退 90%），零爆仓风险。', 'No Liquidation · Auto Stop-Loss (95% First 6H / 90% Standard).')}</div>
      ${renderSettlementBreakdownRows({ principalA9, rewardA9: config.isDemo ? 0 : (ticket ? 0 : null), lockedA9: config.isDemo ? 0 : (ticket ? 0 : null) })}
      <a class="btn btn-primary" href="${passHref}">${icon('wallet', 15)} ${L('查看凭证与退本', 'View Pass & Refund')} ›</a>
    </section>
  `;
}

/**
 * v17.0 每轮等权空投抽奖公示卡片（Demo 展示演示数据，Live 严格展示服务端结果）
 */
export function renderAirdropDrawsCard({ loading = false, error = null, items = [], bucketRemainingRaw = null, hasQualifiedPosition = null } = {}) {
  const remA9 = bucketRemainingRaw !== null && bucketRemainingRaw !== undefined ? rawToA9(bucketRemainingRaw) : null;
  const list = Array.isArray(items) ? items : [];
  const qualHtml = hasQualifiedPosition === true
    ? `<div class="sub-tile row-start" style="margin-bottom:8px;padding:8px 10px;border-color:var(--green-border);gap:7px;">${icon('checkCircle', 14, 'text-green')}<span class="num-xs text-green" style="font-weight:800;">${L('本轮已锁仓 ≥ 100 A9 · 已自动获得 100,000 A9 等权空投抽奖资格', 'Locked ≥ 100 A9 this round · Auto-entered in 100,000 A9 equal airdrop')}</span></div>`
    : hasQualifiedPosition === false
      ? `<a class="sub-tile row-between" href="#/challenge/confirm" style="margin-bottom:8px;padding:8px 10px;border-color:var(--gold-border);text-decoration:none;"><span class="num-xs" style="font-weight:800;color:var(--ink);">${L('锁仓 ≥ 100 A9 即自动参与本轮 100,000 A9 等权空投', 'Lock ≥ 100 A9 to auto-enter 100,000 A9 equal airdrop')}</span><span class="sw-menu-arrow" aria-hidden="true">›</span></a>`
      : '';
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
      ${qualHtml}
      ${bodyHtml}
    </section>
  `;
}

export function renderTechnicalHalt(round, ticket = null) {
  const principalA9 = ticket ? rawToA9(ticket.claimablePrincipalRaw ?? ticket.amountRaw) : (config.isDemo ? (round.myStakeTon || 5000) : null);
  const passHref = ticket?.ticketAddress ? `#/claim?ticket=${encodeURIComponent(ticket.ticketAddress)}` : '#/claim';
  return `
    <section class="card card-hero col-gap" style="border-color:var(--gold-border);">
      <div class="row-between">
        ${stagePillTrigger(round, round?.currentRound ?? '—')}
        <span class="chip chip-green">${icon('shieldCheck', 11)} ${L('100% 退本', '100% Refund')}</span>
      </div>
      <div style="font-size:17px;font-weight:900;">${L('本轮异常中止 · 退回本金', 'Round Aborted · Principal Refunded')}</div>
      <div class="num-xs text-sec">${L('异常中止不扣任何止损，参与本金按规则 100% 原路退回。', 'No stop-loss deducted; principal is 100% refundable.')}</div>
      ${renderSettlementBreakdownRows({ principalA9, rewardA9: config.isDemo ? 0 : (ticket ? 0 : null), lockedA9: config.isDemo ? 0 : (ticket ? 0 : null) })}
      <a class="btn btn-primary" href="${passHref}">${icon('shieldCheck', 15)} ${L('查看凭证与退本', 'View Pass & Refund')} ›</a>
    </section>
  `;
}
