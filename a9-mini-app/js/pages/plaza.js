import { store } from '../store.js';
import { config } from '../config.js';
import { L } from '../i18n.js';
import { escapeHtml, formatNum, formatTimer } from '../components.js';
import { icon } from '../icons.js';
import { getEffectiveUserId, fetchPredictionUser, fetchUserPortfolio, rawToA9 } from '../data.js';

let prevPlazaSlotStates = {};

function roundStatusChip(r) {
  if (r.rawState === 'STAKING_CLOSED') return ['chip-gold', L('已封盘', 'Closed')];
  if (r.rawState === 'ORACLE_PAUSED') return ['chip-amber', L('判定暂停', 'Paused')];
  if (r.rawState?.startsWith('SETTLING_') || r.nextState === 'AWAITING_SETTLE') return ['chip-gold', L('等待结算', 'Settling')];
  if (r.stage === 'observation') return ['chip-blue', L('12H 冲价', '12H Push')];
  if (r.stage === 'participation') return ['chip-green', r.inFirst6h ? L('头矿 6H', 'First 6H') : L('24H 锁仓', '24H Lock')];
  if (r.stage === 'settlement_success') return ['chip-green', L('本轮通关', 'Passed')];
  if (r.stage === 'settlement_burn') return ['chip-red', L('未通关', 'Missed')];
  if (r.stage === 'halted') return ['chip-amber', L('异常中止', 'Aborted')];
  if (r.stage === 'warmup') return ['chip-gold', L('下轮预热', 'Warm-Up')];
  return ['chip-muted', L('待同步', 'Syncing')];
}

function roundSummary(r) {
  const needed = r.minQualifiedCandles ?? 8;
  const passed = r.qualifiedCandles;
  if (r.rawState === 'STAKING_CLOSED') return L('已封盘 · 等待冲价开始', 'Entry closed · awaiting price push');
  if (r.rawState === 'ORACLE_PAUSED') return L('价格判定暂停 · 等待恢复', 'Price observation paused');
  if (r.rawState?.startsWith('SETTLING_')) return L('12 个时段已采集 · 等待结算结果', 'Slots complete · awaiting settlement');
  if (r.stage === 'observation') {
    if (r.nextState === 'AWAITING_SETTLE') return L('等待链上结算结果', 'Awaiting on-chain settlement');
    if (passed == null) return L('达标时段待核验', 'Awaiting confirmed slots');
    if (passed >= needed) return L('已达任意 ≥ 8 格门槛 · 等待结算', '8+ qualifying slots met · awaiting settlement');
    return L(`还差 ${needed - passed} 个达标时段通关`, `${needed - passed} more qualifying slots needed`);
  }
  return ({
    participation: r.inFirst6h ? L('头矿 6H · 5% 轻止损窗口', 'First 6H · 5% stop-loss window') : L('普通锁仓 · 10% 自动止损', 'Standard lock · 10% stop-loss'),
    settlement_success: L('本轮通关 · 查看派奖与解锁', 'Round passed · view payout & unlock'),
    settlement_burn: L('未通关 · 自动止损退本', 'Round missed · automatic stop-loss'),
    halted: L('异常中止 · 100% 退回本金', 'Aborted · 100% principal refund'),
    warmup: L('下轮预热开放预约', 'Next round warm-up open'),
  })[r.stage] || L('等待轮次数据同步', 'Awaiting round data');
}

function renderPlazaStampStrip(candles = [], roundId = 'cur') {
  const slots = Array.from({ length: 12 }, (_, idx) => {
    const n = idx + 1;
    const c = candles.find((item) => item.index === n) || candles[idx] || null;
    const state = c?.confirmed || c?.status === 'closed'
      ? (c.bull ? 'pass' : 'miss')
      : c?.status === 'active'
        ? 'active'
        : 'pending';
    const key = `${roundId}:${n}`;
    const justConfirmed = prevPlazaSlotStates[key] === 'active' && (state === 'pass' || state === 'miss');
    prevPlazaSlotStates[key] = state;

    const mark = state === 'pass'
      ? '<span class="sw-stamp-mark" aria-hidden="true">✓</span>'
      : state === 'miss'
        ? '<span class="sw-stamp-mark" aria-hidden="true">×</span>'
        : state === 'active'
          ? '<span class="sw-stamp-dot" aria-hidden="true"></span>'
          : '';
    return `<i class="sw-stamp-cell is-${state}${justConfirmed ? ' anim-stamp-press' : ''}" data-plaza-slot="${n}" data-slot-status="${state}" aria-hidden="true">${mark}</i>`;
  });
  return `<div class="sw-stamp-row" aria-label="${L('12 个冲价时段印章（任意至少 8 格达标）', '12 price-push stamps (any 8+ qualify)')}">${slots.join('')}</div>`;
}

function showActivity(root, { pendingRaw = null, portfolio = null, hasError = false, onRetry = null } = {}) {
  const panel = root.querySelector('#plaza-activity');
  if (!panel) return;
  const amount = rawToA9(pendingRaw);
  const claimable = rawToA9(portfolio?.claimableRaw);
  const demoTicket = config.isDemo && store.state.user.profileMode !== 'empty'
    ? (store.state.certificates || []).find((c) => c.status === 'observation' || c.status === 'participation')
    : null;
  const liveActiveTicket = !config.isDemo
    ? (portfolio?.tickets || []).find((t) => t && !t.exited && !t.principalDone && !t.forfeited)
    : null;

  let rowHtml = '';
  if (amount > 0) {
    rowHtml = `
      <a class="sw-menu-row sw-amount-row" href="#/internal/market?from=activation">
        <span class="sw-row-icon is-amber" aria-hidden="true">${icon('unlock', 16)}</span>
        <div class="sw-menu-left">
          <span class="sw-menu-title">${L('待激活奖励', 'Pending Activation')}</span>
          <span class="sw-menu-sub">${L('直达宝箱商城激活', 'Activate in Chest Mall')}</span>
        </div>
        <div class="sw-menu-right">
          <span class="sw-menu-amount is-amber">${formatNum(amount, amount % 1 === 0 ? 0 : 2)} A9</span>
          <span class="sw-menu-arrow" aria-hidden="true">›</span>
        </div>
      </a>
    `;
  } else if (claimable > 0) {
    rowHtml = `
      <a class="sw-menu-row sw-amount-row" href="#/claim">
        <span class="sw-row-icon is-green" aria-hidden="true">${icon('trophy', 16)}</span>
        <div class="sw-menu-left">
          <span class="sw-menu-title">${L('可领取轮次奖励', 'Claimable Round Rewards')}</span>
          <span class="sw-menu-sub">${L('前往领奖详情核验', 'Open claim details')}</span>
        </div>
        <div class="sw-menu-right">
          <span class="sw-menu-amount is-green">${formatNum(claimable, claimable % 1 === 0 ? 0 : 2)} A9</span>
          <span class="sw-menu-arrow" aria-hidden="true">›</span>
        </div>
      </a>
    `;
  } else if (demoTicket || liveActiveTicket) {
    const href = demoTicket
      ? `#/proof/${encodeURIComponent(demoTicket.id)}`
      : (liveActiveTicket.ticketAddress ? `#/claim?ticket=${encodeURIComponent(liveActiveTicket.ticketAddress)}` : '#/claim');
    const roundNum = demoTicket ? demoTicket.round : liveActiveTicket.roundId;
    rowHtml = `
      <a class="sw-menu-row" href="${href}">
        <span class="sw-row-icon is-blue" aria-hidden="true">${icon('shieldCheck', 16)}</span>
        <div class="sw-menu-left">
          <span class="sw-menu-title">${L(`第 ${escapeHtml(String(roundNum ?? '—'))} 轮锁仓进行中`, `Round ${escapeHtml(String(roundNum ?? '—'))} Lock Active`)}</span>
          <span class="sw-menu-sub">${L('查看我的闯关凭证', 'View my pass')}</span>
        </div>
        <div class="sw-menu-right">
          <span class="sw-menu-arrow" aria-hidden="true">›</span>
        </div>
      </a>
    `;
  }

  if (!rowHtml && !hasError) {
    panel.innerHTML = '';
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  panel.innerHTML = `
    <div class="sw-section-label">${L('我的动态', 'My Activity')}</div>
    <div class="sw-menu-group">
      ${rowHtml}
      ${hasError ? `
        <div class="sw-menu-error" role="alert">
          <span>${L('动态读取失败', 'Activity read failed')}</span>
          <button type="button" class="sw-retry-link" id="plaza-activity-retry">${L('重试', 'Retry')}</button>
        </div>
      ` : ''}
    </div>
  `;
  const retryBtn = panel.querySelector('#plaza-activity-retry');
  if (retryBtn && onRetry) {
    retryBtn.onclick = () => {
      retryBtn.disabled = true;
      onRetry();
    };
  }
}

export function renderCity(root) {
  const r = store.state.round;
  const observing = r.stage === 'observation';
  const candles = r.candles || [];
  const confirmed = candles.filter((c) => c.confirmed || c.status === 'closed');
  const lastConfirmedAvg = confirmed.at(-1)?.p ?? null;
  const price = (value) => (Number(value) > 0 ? '$' + Number(value).toFixed(4) : '—');
  const validLive = r.priceValid !== false && Number(r.livePrice ?? r.twap24h) > 0 ? Number(r.livePrice ?? r.twap24h) : null;
  const validTarget = Number(r.targetPrice) > 0 ? Number(r.targetPrice) : null;
  const deltaPct = (validLive !== null && validTarget !== null) ? (((validLive - validTarget) / validTarget) * 100) : null;
  const isAbove = deltaPct !== null && deltaPct >= 0;
  const deltaText = deltaPct === null
    ? L('价格待同步', 'Syncing price')
    : isAbove
      ? L(`高于目标 +${deltaPct.toFixed(1)}%`, `Above +${deltaPct.toFixed(1)}%`)
      : L(`距目标 ${deltaPct.toFixed(1)}%`, `Gap ${deltaPct.toFixed(1)}%`);

  const [statusChipCls, statusChipText] = roundStatusChip(r);
  const isUrgent = typeof r.countdownSec === 'number' && r.countdownSec > 0 && r.countdownSec <= 3600;
  const minQualified = r.minQualifiedCandles ?? 8;

  const gates = [
    ['/internal/market', 'chest', 'is-red', L('宝箱商城', 'Chest Mall'), L('6 档 · 直发钱包', '6 tiers · direct')],
    ['/internal/market?tab=free', 'chestOpen', 'is-green', L('免费宝箱', 'Free Chests'), config.isDemo ? L('青铜箱可开', 'Bronze ready') : L('查看开启条件', 'Check eligibility')],
    ['/round?panel=prediction', 'radar', 'is-amber', L('12H 预言', '12H Arena'), L('0 GRAM 参战', '0 GRAM entry')],
    ['/warmup', 'flame', 'is-blue', L('下轮预热', 'Next Warm-Up'), L('预约抢头矿', 'Reserve First 6H')],
  ];

  root.innerHTML = `<div class="col-gap anim-page-enter">
    <section class="card card-hero col-gap plaza-overview">
      <div class="row-between">
        <div class="row-start" style="gap:6px;flex-wrap:wrap;">
          <strong class="num-sm">${r.currentRound == null ? L('本轮现场', 'Round Overview') : L(`第 ${r.currentRound} 轮`, `Round ${r.currentRound}`)}</strong>
          <span class="chip ${statusChipCls}" style="min-height:20px;font-size:10.5px;padding:0 7px;">${statusChipText}</span>
        </div>
        <span id="round-cd" class="mono num-sm ${isUrgent ? 'text-red' : 'text-sec'}" style="white-space:nowrap;flex-shrink:0;">${r.countdownSec == null ? '—' : formatTimer(r.countdownSec)}</span>
      </div>

      <h2>${roundSummary(r)}</h2>

      <div class="plaza-price-panel">
        <div class="row-between" style="flex-wrap:wrap;gap:6px 8px;">
          <div class="row-start" style="gap:6px;flex-wrap:wrap;min-width:0;">
            <span class="sw-pulse-dot ${deltaPct === null ? '' : (isAbove ? 'is-up' : 'is-down')}" aria-hidden="true"></span>
            <span class="num-xs text-muted">${L('当前参考价', 'Ref Price')}</span>
            <strong class="mono num-md" id="plaza-live-price" style="white-space:nowrap;">${price(validLive)}</strong>
            <span class="num-xs text-muted mono" style="white-space:nowrap;">/ ${L('目标', 'Goal')} ${price(validTarget)}</span>
          </div>
          <span class="chip ${deltaPct === null ? 'chip-muted' : (isAbove ? 'chip-green' : 'chip-red')} mono" id="plaza-target-delta" style="min-height:20px;font-size:10.5px;padding:0 7px;white-space:nowrap;">${deltaText}</span>
        </div>
        ${observing ? `
          <div class="plaza-confirmed-row">
            <span class="num-xs text-muted">${L('最近确认 1H 判定均价', 'Last Confirmed 1H TWAP')}</span>
            <strong class="mono num-xs" style="color:var(--ink);">${price(lastConfirmedAvg)}</strong>
          </div>
        ` : ''}
      </div>

      ${observing ? `
        <div class="plaza-stamp-block">
          ${renderPlazaStampStrip(candles, r.currentRound ?? 'cur')}
          <div class="row-between num-xs text-sec" style="flex-wrap:wrap;gap:4px 8px;">
            <span class="mono">${L('已确认', 'Confirmed')} <b>${r.candlesSeen ?? '—'}/12</b> · ${L('已达标', 'Qualified')} <b class="${Number(r.qualifiedCandles) >= minQualified ? 'text-green' : ''}">${r.qualifiedCandles ?? '—'}/${minQualified}</b></span>
            <span class="text-muted">${L(`任意 ≥ ${minQualified} 格达标`, `Any ${minQualified}+ qualify`)}</span>
          </div>
        </div>
      ` : ''}

      <div class="plaza-pool-row">
        <span class="num-xs text-muted">${L('本轮奖池', 'Round Pool')}</span>
        <strong class="mono num-md plaza-pool-amount">${r.rewardBudgetA9 == null ? '—' : formatNum(r.rewardBudgetA9)} A9</strong>
      </div>

      <a class="btn btn-primary" href="#/round">${observing ? L('进入冲价战场', 'Enter Push Arena') : L('进入本轮战场', 'Enter Round Arena')} ›</a>
    </section>

    <nav class="sw-gate-grid" aria-label="${L('快捷入口', 'Quick Menu')}">
      ${gates.map(([path, glyph, tone, title, hint]) => `
        <a class="sw-gate-tile" href="#${path}">
          <span class="sw-gate-icon ${tone}">${icon(glyph, 20)}</span>
          <span class="sw-gate-title">${title}</span>
          <span class="sw-gate-sub">${hint}</span>
        </a>
      `).join('')}
    </nav>

    <section id="plaza-activity" hidden></section>

    <div class="sw-menu-group">
      <a class="sw-menu-row" href="#/team?action=rally">
        <span class="sw-row-icon is-red" aria-hidden="true">${icon('squadEmblem', 17)}</span>
        <div class="sw-menu-left">
          <span class="sw-menu-title">${L('去战队喊单', 'Squad Rally')}</span>
          <span class="sw-menu-sub">${L('前往战队动员中心 · 分享战报与查看返佣', 'Open Squad Rally · share calls & view credits')}</span>
        </div>
        <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
      </a>
    </div>
  </div>`;

  if (config.isDemo) {
    const demoPending = store.state.user.profileMode === 'empty' ? '0' : store.state.prediction?.pendingActivationRaw;
    showActivity(root, { pendingRaw: demoPending });
    return;
  }

  const uid = getEffectiveUserId(store.state.user);
  const addr = store.state.user.address;
  if (!uid && !addr) return;

  const refresh = async () => {
    const [prediction, portfolio] = await Promise.allSettled([
      uid ? fetchPredictionUser(uid, r.currentRound) : Promise.resolve(null),
      addr ? fetchUserPortfolio(addr) : Promise.resolve(null),
    ]);
    if (!root.isConnected || addr !== store.state.user.address || uid !== getEffectiveUserId(store.state.user)) return;
    showActivity(root, {
      pendingRaw: prediction.status === 'fulfilled' ? prediction.value?.pendingActivationRaw : null,
      portfolio: portfolio.status === 'fulfilled' ? portfolio.value : null,
      hasError: prediction.status === 'rejected' || portfolio.status === 'rejected',
      onRetry: refresh,
    });
  };
  void refresh();
}
