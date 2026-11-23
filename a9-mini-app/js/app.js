import { paintScene } from './game-scenes.js';
import { tickDemoPrice } from './demo-data.js';
/**
 * A9 Telegram Mini App Bootstrapper — Slim Header, Race-Safe Dual-Theme & Quiet Telemetry
 */

import { store } from './store.js';
import { config } from './config.js';
import { loadSnapshot, mapRoundView, submitStartAppAttribution, fetchChestById, assistChestById, rawToA9, fetchMe, serverNowMs } from './data.js';
import { A9TMA, A9Haptic } from './tma.js';
import { A9Audio, bindKineticSurfaces, cleanupKineticSurfaces } from './audio.js';
import { matchRoute } from './router.js';
import { escapeHtml, formatNum, formatTimer, showToast, cleanupActiveInteractions, buildSparklineSvgPath, syncRadarInPlace, syncSlidingSegTabs, openModal, closeModal } from './components.js';
import { icon } from './icons.js';
import { t, L, initAutoLanguage } from './i18n.js';
import { tonConnect } from './tonconnect.js';

const headerEl = document.getElementById('app-header');
const tickerEl = document.getElementById('ticker-bar');
const mainEl = document.getElementById('app-main');
const tabbarEl = document.getElementById('app-tabbar');
const simDrawerEl = document.getElementById('sim-drawer');

mainEl.addEventListener('error', event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.matches('.wv-person')) return;
  const label = document.createElement('span');
  label.className = 'wv-missing';
  label.textContent = image.alt + ' · ' + L('立绘暂缺', 'Art unavailable');
  image.replaceWith(label);
}, true);

const TABS = [
  { key: 'challenge', path: '/challenge',       ic: 'navCity',  labelKey: 'tab_challenge' },
  { key: 'round',     path: '/round',           ic: 'navRound', labelKey: 'tab_round' },
  { key: 'team',      path: '/team',            ic: 'navTeam',  labelKey: 'tab_team' },
  { key: 'profile',   path: '/profile',         ic: 'navVault', labelKey: 'tab_backpack' }
];

let dataReady = false;
let lastLoadError = null;
let isSyncing = false;
let lastDataKey = '';
let activeViewTransition = null;
const scrollMemory = new Map();

/** 纯内存页面交互状态记忆（绝不写入 localStorage） */
export const uiMemory = {
  selectedSlotByRound: {},
  ticketFilter: 'all',
  leaderboardTab: 'personal',
  leaderboardRound: 'R3'
};

export function getTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(mode) {
  const next = mode === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  store.update(s => { s.settings.themeMode = next; });
  try { localStorage.removeItem('a9_theme_mode'); } catch (_) {}
  A9TMA.syncTheme(next);
  tonConnect.syncTheme(next);
}

/** 圆形径向主题切换（设置页调用） */
export function toggleTheme(e) {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  const runSwitch = () => {
    applyTheme(next);
    renderCurrentRoute();
  };

  A9Haptic.light();
  A9Audio.confirm();

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (document.startViewTransition && !reduced) {
    if (activeViewTransition) {
      try { activeViewTransition.skipTransition?.(); } catch (_) {}
      activeViewTransition = null;
    }
    const x = e?.clientX ?? window.innerWidth * 0.5;
    const y = e?.clientY ?? 120;
    const maxR = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = document.startViewTransition(runSwitch);
    activeViewTransition = transition;
    transition.ready.then(() => {
      if (activeViewTransition !== transition) return;
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${maxR}px at ${x}px ${y}px)`] },
        { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' }
      );
    }).catch(() => {});
    transition.finished.finally(() => {
      if (activeViewTransition === transition) activeViewTransition = null;
    });
  } else {
    runSwitch();
  }
  return next;
}

export function navigate(path) {
  if (window.location.hash !== `#${path}`) {
    window.location.hash = `#${path}`;
  } else {
    renderCurrentRoute();
  }
}

function goBack() {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    navigate('/challenge');
  }
}

/** 极简降噪顶栏：左侧品牌/返回标题 + 右侧钱包状态（演示模式留 1 枚控制台图标）；主题与音效收进「设置」 */
function renderHeader(route) {
  const { user } = store.state;
  const isStack = route.shell === 'stack';
  const inTelegram = A9TMA.isTelegram();
  const titleText = typeof route.title === 'function' ? route.title() : route.title;

  A9TMA.setBackButton(isStack, goBack);

  headerEl.innerHTML = `
    <div class="header-left">
      ${isStack && !inTelegram ? `<button class="icon-btn" id="hdr-back" aria-label="Back">${icon('arrowLeft', 16)}</button>` : ''}
      ${!isStack
        ? `<div class="header-brand"><span class="brand-mark"><svg class="brand-spiral" viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M16 24C13.5 34.5 18.5 47 31 50.5C44.5 54 55 44 55 31C55 18 44.5 10 33 11.5C22.5 13 18 22.5 20.5 31.5C22.8 39.5 31.5 43.5 38.5 39.5C44.5 36 45 27.5 39.5 23.5C35.2 20.5 29.8 22.8 29.5 27.5" stroke="#FFFFFF" stroke-width="8.5" stroke-linecap="round"/></svg><span>A9</span></span>${config.isDemo ? `<span class="header-demo-dot">DEMO</span>` : ''}</div>`
        : `<div class="header-title"><span class="header-title-text">${titleText}</span></div>`
      }
    </div>
    <div class="header-right">
      ${config.isDemo ? `<button class="icon-btn has-demo-pip" id="btn-open-sim" aria-label="${L('演示控制台', 'Demo console')}" title="${L('演示控制台 (DEMO)', 'Demo console (DEMO)')}">${icon('sliders', 14)}</button>` : ''}
      <button class="wallet-pill ${user.connected ? '' : 'disconnected'}" id="btn-wallet-pill">
        <span class="live-dot ${user.connected ? '' : 'amber'}"></span>
        <span>${user.connected ? (user.shortAddress || (user.address ? (user.address.length > 12 ? `${user.address.slice(0, 4)}...${user.address.slice(-4)}` : user.address) : t('connect_wallet'))) : t('connect_wallet')}</span>
      </button>
    </div>
  `;

  const backBtn = headerEl.querySelector('#hdr-back');
  if (backBtn) backBtn.onclick = goBack;

  headerEl.querySelector('#btn-wallet-pill').onclick = () => {
    tonConnect.openConnectModal(renderCurrentRoute);
  };

  const simBtn = headerEl.querySelector('#btn-open-sim');
  if (simBtn) simBtn.onclick = openSimDrawer;
}

function renderTicker(show) {
  const r = store.state.round;
  if (!show || r.source !== 'api' || !r.livePrice) {
    tickerEl.classList.add('hidden');
    return;
  }
  tickerEl.classList.remove('hidden');
  tickerEl.innerHTML = `
    <div><b>A9</b> <span class="text-green">$${r.livePrice.toFixed(4)}</span></div>
    <div><span class="text-muted">TWAP</span> <span class="text-cyan">$${r.twap24h !== null ? r.twap24h.toFixed(4) : '—'}</span></div>
  `;
}

function renderTabBar(route) {
  if (route.shell === 'stack') {
    tabbarEl.classList.add('hidden');
    mainEl.classList.add('no-tabbar');
    return;
  }
  tabbarEl.classList.remove('hidden');
  mainEl.classList.remove('no-tabbar');
  const activeIdx = Math.max(0, TABS.findIndex(item => item.key === route.tab));

  if (!tabbarEl.querySelector('.dock-pill')) {
    tabbarEl.innerHTML = `<div class="dock-pill" id="dock-pill"></div>` + TABS.map(item => `
      <button class="tab-item" data-tab-key="${item.key}" data-nav="${item.path}">
        ${icon(item.ic, 22)}
        <span class="tab-lbl">${t(item.labelKey)}</span>
        ${item.key === 'profile' ? '<span class="tab-badge hidden" id="profile-tab-badge"></span>' : ''}
      </button>
    `).join('');
  }

  const pill = tabbarEl.querySelector('#dock-pill');
  if (pill) pill.style.transform = `translateX(${activeIdx * 100}%)`;

  const { user, prediction } = store.state;
  const hasPendingClaim = (Number(user.a9Claimable) || 0) > 0 || (Number(prediction?.pendingActivationRaw) || 0) > 0;
  const profileBadge = tabbarEl.querySelector('#profile-tab-badge');
  if (profileBadge) profileBadge.classList.toggle('hidden', !hasPendingClaim);

  tabbarEl.querySelectorAll('.tab-item').forEach((btn, idx) => {
    const item = TABS[idx];
    btn.classList.toggle('active', item.key === route.tab);
    btn.setAttribute('aria-current', item.key === route.tab ? 'page' : 'false');
    const lbl = btn.querySelector('.tab-lbl');
    if (lbl) lbl.textContent = t(item.labelKey);
  });
}

function renderLoading() {
  mainEl.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-hero">
        <div class="row-between"><span class="chip chip-muted">${L('读取中', 'LOADING')}</span>${icon('radar', 18, 'text-green')}</div>
        <div style="font-size:16px;font-weight:700;margin-top:10px;">${L('正在读取当前轮次…', 'Reading current round…')}</div>
        <div class="num-xs text-muted" style="margin-top:4px;">${L('正在准备轮次视图', 'Preparing the round view')}</div>
        <div class="progress-track" style="margin-top:14px;"><div class="progress-fill no-anim" style="width:42%"></div></div>
      </div>
    </div>
  `;
}

function renderDataError(error) {
  const code = escapeHtml(error?.code || 'NETWORK');
  mainEl.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-glow-red">
        <div class="row-between" style="margin-bottom:10px;">
          <div class="card-title">${icon('shieldAlert', 16, 'text-red')} ${L('数据源不可用', 'Data source unavailable')}</div>
          <span class="chip chip-red">${code}</span>
        </div>
        <div class="text-sec" style="font-size:12px;line-height:1.6;">${escapeHtml(error?.message || L('无法读取轮次数据', 'Cannot load round data'))}</div>
        <div class="num-xs text-muted" style="margin-top:8px;word-break:break-all;">${escapeHtml(config.apiBase || L('当前站点只读接口', 'Same-origin read-only API'))}</div>
      </div>
      <button class="btn btn-primary" id="data-retry">${icon('refresh', 16)} ${L('重试读取', 'Retry')}</button>
      <div class="card row-between">
        <span class="num-xs text-muted">${L('需要体验完整交互？切换到演示模式', 'Want full interaction? Use demo mode')}</span>
        <a class="num-xs text-green" href="?mode=demo">${L('演示模式', 'Demo')} ›</a>
      </div>
    </div>
  `;
  const btn = mainEl.querySelector('#data-retry');
  if (btn) btn.onclick = () => syncData({ forceRender: true });
}

function staleBanner() {
  const r = store.state.round;
  if (!r.stale) return '';
  return `
    <div class="card row-between" style="border-color:var(--gold-border);margin-bottom:2px;">
      <span class="row-start num-xs text-sec">${icon('clock', 13, 'text-gold')} ${L('数据可能已过期，正在重试', 'Data may be stale, retrying')}</span>
      <button class="btn btn-secondary btn-sm" id="stale-retry">${L('刷新', 'Refresh')}</button>
    </div>
  `;
}

let lastRenderedPath;
let lastFullHash = '';
export function renderCurrentRoute() {
  if (lastFullHash) scrollMemory.set(lastFullHash, window.scrollY || 0);
  cleanupActiveInteractions();
  cleanupKineticSurfaces();
  const currentHash = window.location.hash || '#/challenge';
  const { route, param, query } = matchRoute(currentHash);
  document.body.dataset.gameRoute = route.path;
  paintScene(document.getElementById('realm-banner'), dataReady ? route.path : null);
  renderHeader(route);
  renderTicker(route.ticker);
  renderTabBar(route);

  if (!dataReady) {
    if (lastLoadError) renderDataError(lastLoadError);
    else renderLoading();
    return;
  }
  const prevPath = lastRenderedPath;
  route.render(mainEl, navigate, param, query);
  if (prevPath && route.path !== prevPath) {
    if (route.shell === 'stack') A9Audio.pageTurn();
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      mainEl.animate?.([{opacity:0.7, transform:'translateY(5px)'},{opacity:1, transform:'none'}],{duration:180,easing:'ease-out'});
    }
  }
  lastRenderedPath = route.path;
  lastFullHash = currentHash;
  bindKineticSurfaces(mainEl);
  requestAnimationFrame(() => syncSlidingSegTabs(mainEl));

  const banner = staleBanner();
  if (banner) {
    mainEl.insertAdjacentHTML('afterbegin', banner);
    const btn = mainEl.querySelector('#stale-retry');
    if (btn) btn.onclick = () => syncData({ forceRender: true });
  }
  const restoredY = route.shell === 'tab' && prevPath && prevPath !== route.path ? (scrollMemory.get(currentHash) || 0) : 0;
  window.scrollTo({ top: restoredY, behavior: 'instant' });
}

async function syncData({ forceRender = false } = {}) {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const snapshot = await loadSnapshot();
    const view = mapRoundView(snapshot);
    const key = [view.rawState, view.currentRound, view.qualifiedCandles, view.candlesSeen, view.source, view.stale, view.result, view.targetPrice, view.twap24h, view.priceValid, view.successCount, JSON.stringify(view.unlock), JSON.stringify(view.candles)].join('|');
    const changed = key !== lastDataKey;

    store.update(s => { Object.assign(s.round, view); });
    dataReady = true;
    lastLoadError = null;
    lastDataKey = key;

    // If staying on observation/proof radar with only slot/count progression, update in-place without full DOM rebuild
    if (!forceRender && !changed && document.getElementById('a9-radar-grid')) {
      syncRadarInPlace(store.state.round);
      return;
    }

    if (forceRender || changed) renderCurrentRoute();
    else renderHeader(matchRoute(window.location.hash).route);
  } catch (error) {
    if (!dataReady) {
      lastLoadError = error;
      dataReady = false;
      renderDataError(error);
    } else {
      store.update(s => { s.round.stale = true; });
      renderCurrentRoute();
    }
  } finally {
    isSyncing = false;
  }
}

/** Demo-only helper to simulate single slot confirmation / duplicate / batch backfill */
function simulateRadarEvent(type) {
  const r = store.state.round;
  if (!Array.isArray(r.candles) || r.candles.length < 24) return;
  if (type === 'duplicate') {
    syncRadarInPlace(r);
    showToast(L('已重放相同数据（无多余动效）', 'Duplicate payload synced (no anim)'));
    return;
  }
  if (type === 'batch') {
    r.candles.forEach(c => {
      if (c.index <= 18) {
        c.status = 'closed';
        c.bull = c.index % 4 !== 0;
        c.p = c.bull ? 0.0068 : 0.0049;
      } else if (c.index === 19) {
        c.status = 'active';
        c.bull = true;
        c.p = 0.0066;
      } else {
        c.status = 'pending';
        c.p = null;
      }
    });
    r.qualifiedCandles = r.candles.filter(c => c.status === 'closed' && c.bull).length;
    r.candlesSeen = 18;
    r.needMore = Math.max(0, (r.minQualifiedCandles || 16) - r.qualifiedCandles);
    syncRadarInPlace(r, { batch: true });
    showToast(L('已批量补齐至第 18 段（直接同步）', 'Batch backfilled to slot #18'));
    return;
  }
  const activeIdx = r.candles.findIndex(c => c.status === 'active');
  if (activeIdx === -1) return;
  const passed = type === 'pass';
  r.candles[activeIdx].status = 'closed';
  r.candles[activeIdx].bull = passed;
  r.candles[activeIdx].p = passed ? 0.0069 : 0.0048;
  if (activeIdx + 1 < r.candles.length) {
    r.candles[activeIdx + 1].status = 'active';
    r.candles[activeIdx + 1].bull = true;
    r.candles[activeIdx + 1].p = 0.0065;
  }
  r.qualifiedCandles = r.candles.filter(c => c.status === 'closed' && c.bull).length;
  r.candlesSeen = r.candles.filter(c => c.status === 'closed').length;
  r.needMore = Math.max(0, (r.minQualifiedCandles || 16) - r.qualifiedCandles);
  syncRadarInPlace(r);
}

function openSimDrawer() {
  const { round, team } = store.state;
  simDrawerEl.classList.remove('hidden');
  simDrawerEl.innerHTML = `
    <div class="modal-sheet">
      <div class="sheet-handle"></div>
      <div class="row-between">
        <div class="card-title">${icon('sliders', 16, 'text-green')} ${L('演示场景切换', 'Demo Scene Switch')}</div>
        <button class="icon-btn" id="sim-close" aria-label="Close">${icon('x', 15)}</button>
      </div>
      <div class="caps text-muted">${L('仅演示模式生效 · 数据不会进入真实模式', 'DEMO ONLY · never persisted in live mode')}</div>

      <div class="caps text-muted">${L('轮次阶段', 'Round Stage')}</div>
      <div class="grid-2">
        <button class="quick-btn ${round.stage === 'warmup' ? 'active' : ''}" data-sim-stage="warmup">${L('1. 开局倒计时', '1. Pre-Round')}</button>
        <button class="quick-btn ${round.stage === 'participation' ? 'active' : ''}" data-sim-stage="participation">${L('2. 火热入场', '2. Entry Open')}</button>
        <button class="quick-btn ${round.stage === 'observation' ? 'active' : ''}" data-sim-stage="observation">${L('3. 24H 闯关中', '3. 24H Quest')}</button>
        <button class="quick-btn ${round.stage === 'settlement_success' ? 'active' : ''}" data-sim-stage="settlement_success">${L('4. 通关派奖', '4. Passed')}</button>
        <button class="quick-btn ${round.stage === 'settlement_burn' ? 'active' : ''}" data-sim-stage="settlement_burn">${L('5. 未通关 · 销毁 BURN', '5. Failed · BURN')}</button>
        <button class="quick-btn ${round.stage === 'halted' ? 'active' : ''}" data-sim-stage="halted">${L('6. 异常中止 · 退回本金', '6. Aborted · Refund')}</button>
      </div>

      <div class="caps text-muted">${L('24H 时段状态演练（观察页）', '24H Slot Simulation (Observe)')}</div>
      <div class="grid-2">
        <button class="quick-btn" data-sim-radar="pass">${L('当前段确认 · 达标', 'Confirm Slot · Met')}</button>
        <button class="quick-btn" data-sim-radar="miss">${L('当前段确认 · 未达标', 'Confirm Slot · Miss')}</button>
        <button class="quick-btn" data-sim-radar="duplicate">${L('重复推送相同数据', 'Duplicate Payload')}</button>
        <button class="quick-btn" data-sim-radar="batch">${L('批量补齐历史时段', 'Batch Backfill')}</button>
      </div>

      <div class="caps text-muted">${L('战队角色', 'Squad Role')}</div>
      <div class="grid-3">
        <button class="quick-btn ${team.role === 'captain' ? 'active' : ''}" data-sim-role="captain">${L('队长', 'Captain')}</button>
        <button class="quick-btn ${team.role === 'member' ? 'active' : ''}" data-sim-role="member">${L('成员', 'Member')}</button>
        <button class="quick-btn ${team.role === 'none' ? 'active' : ''}" data-sim-role="none">${L('大厅', 'Lobby')}</button>
      </div>

      <div class="caps text-muted">${L('快捷直达', 'Jump To')}</div>
      <div class="grid-2">
        <button class="quick-btn" data-sim-nav="/warmup">${icon('flame', 13)} ${L('开局预热', 'Pre-Round')}</button>
        <button class="quick-btn" data-sim-nav="/internal/market">${icon('swap', 13)} ${L('A9 兑换屋', 'A9 Exchange')}</button>
        <button class="quick-btn" data-sim-nav="/team/invite">${icon('qr', 13)} ${L('邀友赢奖', 'Invite & Earn')}</button>
        <button class="quick-btn" data-sim-nav="/claim">${icon('bolt', 13)} ${L('金库领奖', 'Claim Prizes')}</button>
        <button class="quick-btn" data-sim-nav="/settings">${icon('settings', 13)} ${L('偏好设置', 'Settings')}</button>
        <button class="quick-btn" data-sim-nav="/rules">${icon('book', 13)} ${L('闯关指南', 'How to Play')}</button>
      </div>
    </div>
  `;

  simDrawerEl.onclick = (e) => { if (e.target === simDrawerEl) simDrawerEl.classList.add('hidden'); };
  simDrawerEl.querySelector('#sim-close').onclick = () => simDrawerEl.classList.add('hidden');

  simDrawerEl.querySelectorAll('[data-sim-stage]').forEach(b => {
    b.onclick = () => {
      store.update(s => {
        s.round.stage = b.dataset.simStage;
        if (b.dataset.simStage === 'participation' && !(Number(s.round.earlyBirdSec) > 0)) {
          s.round.earlyBirdSec = 10 * 3600 + 18 * 60 + 42;
        }
      });
      simDrawerEl.classList.add('hidden');
      navigate('/round');
    };
  });
  simDrawerEl.querySelectorAll('[data-sim-radar]').forEach(b => {
    b.onclick = () => {
      simDrawerEl.classList.add('hidden');
      if (store.state.round.stage !== 'observation' || window.location.hash !== '#/round') {
        store.update(s => { s.round.stage = 'observation'; });
        navigate('/round');
      }
      setTimeout(() => simulateRadarEvent(b.dataset.simRadar), 40);
    };
  });
  simDrawerEl.querySelectorAll('[data-sim-role]').forEach(b => {
    b.onclick = () => {
      store.update(s => { s.team.role = b.dataset.simRole; });
      simDrawerEl.classList.add('hidden');
      navigate('/team');
    };
  });
  simDrawerEl.querySelectorAll('[data-sim-nav]').forEach(b => {
    b.onclick = () => {
      simDrawerEl.classList.add('hidden');
      navigate(b.dataset.simNav);
    };
  });
}

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-nav]');
  if (target) {
    if (target.classList.contains('tab-item')) {
      A9Haptic.light();
      A9Audio.tab();
    }
    navigate(target.dataset.nav);
  }
  if (e.target.closest('.seg-tab')) {
    requestAnimationFrame(() => syncSlidingSegTabs(document));
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const target = e.target?.closest?.('[data-nav]:not(button):not(a)');
  if (target) {
    e.preventDefault();
    navigate(target.dataset.nav);
  }
});

function startDisplayLoop() {
  setInterval(() => {
    if (document.hidden) return;
    const r = store.state.round;
    if (typeof r.countdownSec === 'number' && r.countdownSec > 0) r.countdownSec -= 1;
    if (typeof r.earlyBirdSec === 'number' && r.earlyBirdSec > 0) r.earlyBirdSec -= 1;
    if (typeof r.activeCandleSec === 'number' && r.activeCandleSec > 0) r.activeCandleSec -= 1;

    const roundCd = document.getElementById('round-cd');
    if (roundCd) roundCd.textContent = r.countdownSec === null ? '—' : formatTimer(r.countdownSec);
    const earlyCd = document.getElementById('early-cd');
    if (earlyCd) earlyCd.textContent = r.earlyBirdSec === null ? '—' : formatTimer(r.earlyBirdSec);
    const earlyWinEl = document.getElementById('early-window-cd');
    if (earlyWinEl) {
      const normSec = (v) => {
        const n = Number(v || 0);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
      };
      const openAt = normSec(r.stakeOpenAt);
      const closeAt = normSec(r.stakeCloseAt);
      let left = null;
      if (openAt > 0 && closeAt > openAt) {
        const earlyEnd = openAt + Math.floor((closeAt - openAt) / 3);
        const diff = earlyEnd - Math.floor(serverNowMs() / 1000);
        if (diff > 0) left = diff;
      }
      if (left === null && config.isDemo && typeof r.earlyBirdSec === 'number') {
        left = Math.max(0, Math.floor(r.earlyBirdSec));
      }
      earlyWinEl.textContent = formatTimer(left ?? 0);
    }
    const candleCd = document.getElementById('active-candle-cd');
    if (candleCd) {
      const hasActive = Array.isArray(r.candles) && r.candles.some(c => c.status === 'active');
      candleCd.textContent = hasActive ? `${L('剩余', 'Left')} ${formatTimer(r.activeCandleSec || 0).slice(3)}` : '—';
    }
    const rawExpAt = Number(store.state.prediction?.pendingExpiresAt);
    if (Number.isFinite(rawExpAt) && rawExpAt > 0) {
      const expAtMs = rawExpAt < 1e12 ? rawExpAt * 1000 : rawExpAt;
      const rem = Math.max(0, Math.floor((expAtMs - serverNowMs()) / 1000));
      document.querySelectorAll('#pred-exp-cd, [data-pred-exp-cd]').forEach((el) => {
        const isVault = el.getAttribute('data-pred-exp-cd') === 'vault';
        const prefix = isVault ? L('作废倒计时', 'Expires') : L('距过期', 'Expires in');
        el.textContent = rem > 0 ? `${prefix} ${formatTimer(rem)}` : L('已过期', 'Expired');
      });
    }
  }, 1000);

  if (!config.isDemo) return;

  setInterval(() => {
    if (document.hidden) return;
    const r = store.state.round;
    const nextPrice = tickDemoPrice(r);

    const sLine = document.getElementById('spark-line');
    const sArea = document.getElementById('spark-area');
    const sDot = document.getElementById('spark-dot');
    if (sLine && sArea && sDot) {
      const sp = buildSparklineSvgPath(r.priceHistory);
      sLine.setAttribute('d', sp.line);
      sArea.setAttribute('d', sp.area);
      sDot.setAttribute('cx', sp.last.x);
      sDot.setAttribute('cy', sp.last.y);
    }

    const twapP = document.getElementById('live-twap-val');
    if (twapP) twapP.textContent = `$${nextPrice.toFixed(4)}`;
  }, 2600);
}

// Scroll-aware header elevation
window.addEventListener('scroll', () => {
  headerEl.classList.toggle('scrolled', window.scrollY > 6);
}, { passive: true });

// Bootstrap — 方案 A 默认白昼暖棉纸立体书（尊重用户已保存于 a9_ui_prefs_v1 的暗夜纸本偏好）
initAutoLanguage();
applyTheme(store.state.settings?.themeMode || 'light');
A9TMA.init();
tonConnect.init();

if (config.apiOverrideRejected && config.apiOverrideError) {
  showToast(config.apiOverrideError, 'amber');
}

const startParsed = A9TMA.parseStartParam();
if (startParsed?.ref) {
  store.setReferrerId(startParsed.ref);
}
if (startParsed?.scrollTarget) {
  store.state.referral.pendingScrollTarget = startParsed.scrollTarget;
}
// 仅对含归因语义（invite / 带 ref / 业务实体分享）的 startapp 提交归因，避免把纯导航词 claim/warmup/market 发给后端触发 400
if (!config.isDemo && startParsed?.raw && (startParsed.isAttribution || startParsed.ref) && A9TMA.getRawInitData()) {
  submitStartAppAttribution({ startParam: startParsed.raw, referrerId: startParsed.ref || null })
    .then((res) => {
      if (res?.referrerId) store.setReferrerId(res.referrerId);
    })
    .catch(() => {});
}
// Live + Telegram 环境启动同步 /api/me，恢复 tgBound、username、服务端已绑定钱包与 72h 换绑状态
if (!config.isDemo && A9TMA.getRawInitData()) {
  fetchMe()
    .then((me) => {
      if (!me) return;
      store.update((s) => {
        s.user.tgBound = Boolean(me.telegramUserId || me.user?.id || me.telegram?.id);
        const uname = me.user?.username || me.telegram?.username || '';
        if (uname) s.user.username = uname.startsWith('@') ? uname : `@${uname}`;
        s.user.pendingSwitch = me.wallet?.pendingSwitch || null;
        s.user.serverBoundWallet = me.wallet?.address || null;
      });
    })
    .catch(() => {});
}

/** 单屏宝箱社交助力弹窗（startapp=chest_<chestId> 落地闭环） */
async function openChestAssistModal(chestId) {
  if (!chestId) return;
  let chest = null;
  let loadFailed = false;
  try {
    chest = await fetchChestById(chestId);
  } catch (_) {
    chest = null;
    loadFailed = true;
  }
  const hasDetail = Boolean(chest);
  const label = hasDetail ? L(chest.labelZh, chest.labelEn) : L('好友的 A9 宝箱', "Friend's A9 Chest");
  const cur = hasDetail ? Number(chest.currentAssists || 0) : null;
  const req = hasDetail ? Number(chest.requiredAssists || 2) : null;
  const isBoost = chest?.source === 'SHOP_BOOST';
  const rewardA9 = hasDetail ? rawToA9(isBoost ? chest.maxBoostA9Raw : chest.baseA9Raw) : null;
  const connected = Boolean(store.state.user?.connected);

  openModal(`
    <div class="sheet-handle"></div>
    <div class="row-between" style="margin-bottom:8px;">
      <div class="card-title">${icon('bolt', 15, 'text-gold')} ${L('好友宝箱助力邀请', 'Friend Chest Assist')}</div>
      <button class="icon-btn" id="chest-assist-close" aria-label="Close">${icon('x', 15)}</button>
    </div>
    <div class="sub-tile" style="margin-bottom:12px;">
      <div class="row-between">
        <strong>${escapeHtml(label)}</strong>
        <span class="chip chip-gold mono">${hasDetail ? `${cur}/${req} ${L('助力', 'assists')}` : L('待核验', 'Pending')}</span>
      </div>
      <div class="num-xs text-sec" style="margin-top:6px;line-height:1.5;">
        ${!hasDetail
          ? L('宝箱详情待核验（暂未拉取到服务端状态），可点击下方重试读取或先连接 TON 钱包。', 'Chest details pending verification. Tap retry below or connect your TON wallet.')
          : isBoost
            ? L(`帮好友助力膨胀（最高额外 +${formatNum(rewardA9, 2)} A9），你顺手 0 成本自动领 1 个青铜宝箱 #1（300 A9）！`, `Help boost this chest (up to +${formatNum(rewardA9, 2)} A9) and auto-claim your free Bronze Chest #1 (300 A9)!`)
            : L(`帮好友点一下开启【${label}】（${formatNum(rewardA9)} A9），你顺手 0 成本自动领 1 个青铜宝箱 #1（300 A9）！`, `Help open [${label}] (${formatNum(rewardA9)} A9) and auto-claim your own Bronze Chest #1 (300 A9)!`)}
      </div>
    </div>
    ${loadFailed ? `<button class="btn btn-secondary" id="btn-retry-chest-detail" type="button" style="margin-bottom:10px;">${L('重试读取宝箱详情', 'Retry Loading Details')}</button>` : ''}
    <div class="num-xs text-muted" style="margin-bottom:12px;">
      ${L('防刷规则：仅需连接链上已激活 TON 钱包（0 扣款），助力后自动激活你的青铜宝箱 #1。', 'Anti-sybil: requires an active TON wallet (0 transfer). Auto-unlocks your Bronze Chest #1.')}
    </div>
    <button class="btn btn-primary" id="btn-do-chest-assist" type="button">
      ${icon(connected ? 'checkCircle' : 'wallet', 15)} ${connected ? L('一键助力并领取我的青铜宝箱 #1', 'Assist & Claim My Bronze Chest #1') : L('连接 TON 钱包并助力', 'Connect TON Wallet to Assist')}
    </button>
  `);

  document.getElementById('chest-assist-close').onclick = closeModal;
  const retryBtn = document.getElementById('btn-retry-chest-detail');
  if (retryBtn) retryBtn.onclick = () => openChestAssistModal(chestId);
  const btn = document.getElementById('btn-do-chest-assist');
  btn.onclick = async () => {
    if (!store.state.user?.connected) {
      tonConnect.openConnectModal(() => openChestAssistModal(chestId));
      return;
    }
    btn.disabled = true;
    try {
      const res = await assistChestById(chestId, store.state.user.address);
      A9Haptic.success();
      closeModal();
      showToast(res?.helperGrantedStarter
        ? L('助力成功！已为你激活免费青铜宝箱 #1，快去拉 2 人开箱！', 'Assisted! Your free Bronze Chest #1 is now active!')
        : L('助力成功！', 'Assist recorded!'));
      navigate('/internal/market?tab=free');
    } catch (e) {
      A9Haptic.error();
      showToast(e?.message || L('助力失败，请确认已连接链上活跃钱包', 'Assist failed; active wallet required'), 'amber');
      btn.disabled = false;
    }
  };
}

renderCurrentRoute();

if (startParsed?.route) {
  window.location.hash = `#${startParsed.route}`;
} else if (!window.location.hash) {
  window.location.hash = '#/challenge';
}

window.addEventListener('hashchange', renderCurrentRoute);
syncData({ forceRender: true }).then(() => {
  if (startParsed?.type === 'chest' && startParsed?.chestId) {
    openChestAssistModal(startParsed.chestId);
  }
});
if (!config.isDemo) setInterval(() => syncData(), config.pollMs);
startDisplayLoop();
