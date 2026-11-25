import { store } from '../store.js';
import { config } from '../config.js';
import { L } from '../i18n.js';
import { escapeHtml, formatNum, formatTimer } from '../components.js';
import { icon } from '../icons.js';
import { getEffectiveUserId, fetchPredictionUser, fetchUserPortfolio, rawToA9 } from '../data.js';

function roundSummary(r) {
  const needed = r.minQualifiedCandles ?? 8;
  const passed = r.qualifiedCandles;
  if (r.rawState === 'STAKING_CLOSED') return L('已封盘 · 等待冲价开始', 'Entry closed · awaiting price push');
  if (r.rawState === 'ORACLE_PAUSED') return L('价格判定暂停', 'Price observation paused');
  if (r.rawState?.startsWith('SETTLING_')) return L('等待结算结果', 'Awaiting settlement');
  if (r.stage === 'observation') {
    if (r.nextState === 'AWAITING_SETTLE') return L('等待结算结果', 'Awaiting settlement');
    if (passed == null) return L('达标时段待核验', 'Awaiting confirmed slots');
    if (passed >= needed) return L('已达通关门槛，等待结算', 'Goal reached · awaiting settlement');
    return L(`还差 ${needed - passed} 个达标时段通关`, `${needed - passed} more qualifying slots needed`);
  }
  return ({
    participation: r.inFirst6h ? L('头矿 6H · 5% 止损', 'First 6H · 5% stop-loss') : L('普通锁仓 · 10% 止损', 'Standard lock · 10% stop-loss'),
    settlement_success: L('本轮通关 · 查看派奖', 'Round passed · view payout'),
    settlement_burn: L('未通关 · 自动止损', 'Round missed · automatic stop-loss'),
    halted: L('异常中止 · 退回本金', 'Aborted · principal refund'),
    warmup: L('下轮预热中', 'Next round warm-up'),
  })[r.stage] || L('等待轮次数据', 'Awaiting round data');
}

function showActivity(root, pendingRaw, portfolio) {
  const panel = root.querySelector('#plaza-activity');
  const amount = rawToA9(pendingRaw);
  const demoTicket = config.isDemo && store.state.certificates?.[0];
  let path, label;
  if (amount > 0) {
    path = '#/internal/market?from=activation';
    label = L(`${formatNum(amount)} A9 待激活 · 前往商城`, `${formatNum(amount)} A9 pending activation · Chest Mall`);
  } else if (rawToA9(portfolio?.claimableRaw) > 0) {
    path = '#/claim';
    label = L('查看本轮可领金额', 'View claimable rewards');
  } else if (demoTicket || portfolio?.tickets?.length) {
    path = demoTicket ? '#/proof/' + encodeURIComponent(demoTicket.id) : '#/claim';
    label = L('查看我的凭证', 'View my tickets');
  }
  panel.innerHTML = path ? `<h2 class="card-title">${L('我的动态', 'My activity')}</h2><a href="${path}">${escapeHtml(label)} ›</a>` : '';
  panel.hidden = !path;
}

export function renderCity(root) {
  const r = store.state.round;
  const observing = r.stage === 'observation';
  const candles = r.candles || [];
  const confirmed = candles.filter(c => c.confirmed);
  const price = value => Number(value) > 0 ? '$' + Number(value).toFixed(4) : '—';
  const gates = [
    ['/internal/market', 'navVault', L('宝箱商城', 'Chest Mall'), L('6 档 · 直发钱包', '6 tiers · wallet delivery')],
    ['/internal/market?tab=free', 'trophy', L('免费宝箱', 'Free chests'), L('查看开启条件', 'Check eligibility')],
    ['/round?panel=prediction', 'bolt', L('12H 预言', '12H prediction'), L('查看擂台', 'View arena')],
    ['/warmup', 'clock', L('下轮预热', 'Warm-up'), L('查看预约', 'View reservations')],
  ];
  root.innerHTML = `<div class="col-gap anim-page-enter">
    <section class="card card-hero col-gap plaza-overview">
      <div class="row-between"><strong>${r.currentRound == null ? L('本轮现场', 'Round overview') : L(`第 ${r.currentRound} 轮`, `Round ${r.currentRound}`)} ${observing ? L('· 12H 冲价', '· 12H push') : ''}</strong>
        <span id="round-cd" class="mono">${r.countdownSec == null ? '—' : formatTimer(r.countdownSec)}</span></div>
      <h2>${roundSummary(r)}</h2>
      ${observing ? `<div class="plaza-mini-strip">${candles.map(c => `<i aria-hidden="true" class="plaza-mini-cell ${c.confirmed ? c.bull ? 'pass' : 'miss' : c.status === 'active' ? 'active' : 'pending'}">${c.confirmed ? c.bull ? '✓' : '×' : c.status === 'active' ? '◉' : '·'}</i>`).join('')}</div>
      <div>${L('已确认', 'Confirmed')} ${r.candlesSeen ?? '—'} / 12 · ${L('达标', 'Qualified')} ${r.qualifiedCandles ?? '—'} / ${r.minQualifiedCandles ?? 8}</div>
      <small>${L('目标价', 'Target')} ${price(r.targetPrice)} · ${L('最近确认均价', 'Last confirmed average')} ${price(confirmed.at(-1)?.p)}</small>` : ''}
      <div>${L('本轮奖池', 'Round pool')} <strong class="mono">${r.rewardBudgetA9 == null ? '—' : formatNum(r.rewardBudgetA9)} A9</strong></div>
      <a class="btn btn-primary" href="#/round">${observing ? L('查看冲价盘', 'View push board') : L('查看本轮详情', 'View round details')} ›</a>
    </section>
    <nav class="grid-2 plaza-gates">${gates.map(([path, glyph, title, hint]) => `<a class="card col-gap" href="#${path}">${icon(glyph, 20)}<strong>${title}</strong><small>${hint}</small></a>`).join('')}</nav>
    <section id="plaza-activity" class="card col-gap" hidden></section>
  </div>`;
  if (config.isDemo) {
    showActivity(root, store.state.prediction.pendingActivationRaw);
    return;
  }
  const uid = getEffectiveUserId(store.state.user);
  const addr = store.state.user.address;
  if (!uid && !addr) return;
  const refresh = async () => {
    const [prediction, portfolio] = await Promise.allSettled([
      uid ? fetchPredictionUser(uid, r.currentRound) : null,
      addr ? fetchUserPortfolio(addr) : null,
    ]);
    if (!root.isConnected || addr !== store.state.user.address || uid !== getEffectiveUserId(store.state.user)) return;
    showActivity(root, prediction.value?.pendingActivationRaw, portfolio.value);
    if (prediction.status === 'rejected' || portfolio.status === 'rejected') {
      const panel = root.querySelector('#plaza-activity');
      panel.hidden = false;
      const retry = document.createElement('button');
      retry.className = 'btn btn-secondary btn-sm';
      retry.textContent = L('部分动态未能读取 · 重试', 'Some activity unavailable · Retry');
      retry.onclick = () => { retry.disabled = true; refresh(); };
      panel.append(retry);
    }
  };
  void refresh();
}
