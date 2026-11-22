import { paintScene } from './game-scenes.js';
import { tickDemoPrice } from './demo-data.js';
/**
 * A9 Telegram Mini App Bootstrapper — Slim Header, Race-Safe Dual-Theme & Quiet Telemetry
 */

import { store } from './store.js';
import { config, BAM_SOURCE } from './config.js';
import { loadSnapshot, mapRoundView } from './data.js';
import { A9TMA, A9Haptic } from './tma.js';
import { A9Audio, bindKineticSurfaces, cleanupKineticSurfaces } from './audio.js';
import { matchRoute } from './router.js';
import { escapeHtml, formatTimer, showToast, cleanupActiveInteractions, buildSparklineSvgPath, syncRadarInPlace, syncSlidingSegTabs } from './components.js';
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

const THEME_KEY = 'a9_theme_mode';

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

function getTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(mode) {
  const next = mode === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
  A9TMA.syncTheme(next);
  tonConnect.syncTheme(next);
}

/** Race-safe circular radial theme transition (280–360ms); degrades cleanly on unsupported / reduced-motion */
function toggleTheme(e) {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  const runSwitch = () => {
    applyTheme(next);
    renderHeader(matchRoute(window.location.hash).route);
  };

  A9Haptic.light();
  A9Audio.confirm();

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (document.startViewTransition && !reduced) {
    if (activeViewTransition) {
      try { activeViewTransition.skipTransition?.(); } catch (_) {}
      activeViewTransition = null;
    }
    const x = e?.clientX ?? window.innerWidth * 0.72;
    const y = e?.clientY ?? 28;
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

/** Slim Header: A9 Brand + Theme Toggle + Wallet (+ Demo Console only in demo mode) */
function renderHeader(route) {
  const { user } = store.state;
  const isStack = route.shell === 'stack';
  const inTelegram = A9TMA.isTelegram();
  const titleText = typeof route.title === 'function' ? route.title() : route.title;
  const isDark = getTheme() === 'dark';

  A9TMA.setBackButton(isStack, goBack);

  headerEl.innerHTML = `
    <div class="header-left">
      ${isStack && !inTelegram ? `<button class="icon-btn" id="hdr-back" aria-label="Back">${icon('arrowLeft', 16)}</button>` : ''}
      ${!isStack
        ? `<div class="header-brand"><span class="brand-mark">A9</span>${config.isDemo ? `<span class="chip chip-muted" style="height:20px;font-size:10px;padding:0 7px;">DEMO</span>` : ''}</div>`
        : `<div class="header-title">${titleText} ${config.isDemo ? '<small>DEMO</small>' : ''}</div>`
      }
    </div>
    <div class="header-right">
      <button class="icon-btn ${A9Audio.isEnabled() ? 'sound-on' : ''}" id="btn-sound-toggle" aria-label="${A9Audio.isEnabled() ? L('关闭交互音效', 'Mute Sound') : L('开启任天堂音效', 'Enable Sound')}" title="${A9Audio.isEnabled() ? L('关闭交互音效', 'Mute Sound') : L('开启任天堂音效', 'Enable Sound')}">${icon(A9Audio.isEnabled() ? 'volumeOn' : 'volumeOff', 15)}</button>
      <button class="icon-btn" id="btn-theme-toggle" aria-label="${isDark ? L('切换白昼模式', 'Light Mode') : L('切换暗夜模式', 'Dark Mode')}" title="${isDark ? L('切换白昼模式', 'Light Mode') : L('切换暗夜模式', 'Dark Mode')}">${icon(isDark ? 'sun' : 'moon', 15)}</button>
      ${config.isDemo ? `<button class="icon-btn" id="btn-open-sim" aria-label="Demo Console" title="${L('演示控制台', 'Demo')} (${BAM_SOURCE.commit})">${icon('sliders', 14)}</button>` : ''}
      <button class="wallet-pill ${user.connected ? '' : 'disconnected'}" id="btn-wallet-pill">
        <span class="live-dot ${user.connected ? '' : 'amber'}"></span>
        <span>${user.connected ? (user.shortAddress || (user.address ? (user.address.length > 12 ? `${user.address.slice(0, 4)}...${user.address.slice(-4)}` : user.address) : t('connect_wallet'))) : t('connect_wallet')}</span>
      </button>
    </div>
  `;

  const backBtn = headerEl.querySelector('#hdr-back');
  if (backBtn) backBtn.onclick = goBack;

  const soundBtn = headerEl.querySelector('#btn-sound-toggle');
  if (soundBtn) {
    soundBtn.onclick = () => {
      A9Haptic.light();
      const on = A9Audio.toggle();
      renderHeader(matchRoute(window.location.hash).route);
      showToast(on ? L('任天堂纸艺音效已开启', 'Paper craft sound on') : L('交互音效已静音', 'Sound muted'));
    };
  }

  headerEl.querySelector('#btn-theme-toggle').onclick = toggleTheme;
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
export function renderCurrentRoute() {
  cleanupActiveInteractions();
  cleanupKineticSurfaces();
  const { route, param } = matchRoute(window.location.hash);
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
  route.render(mainEl, navigate, param);
  if (route.path !== lastRenderedPath && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    mainEl.animate?.([{opacity:0.7, transform:'translateY(5px)'},{opacity:1, transform:'none'}],{duration:180,easing:'ease-out'});
  }
  lastRenderedPath = route.path;
  bindKineticSurfaces(mainEl);
  requestAnimationFrame(() => syncSlidingSegTabs(mainEl));

  const banner = staleBanner();
  if (banner) {
    mainEl.insertAdjacentHTML('afterbegin', banner);
    const btn = mainEl.querySelector('#stale-retry');
    if (btn) btn.onclick = () => syncData({ forceRender: true });
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
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
        <button class="quick-btn ${round.stage === 'warmup' ? 'active' : ''}" data-sim-stage="warmup">${L('1. 预热阶段', '1. Warm-Up')}</button>
        <button class="quick-btn ${round.stage === 'participation' ? 'active' : ''}" data-sim-stage="participation">${L('2. 参与阶段', '2. Entry')}</button>
        <button class="quick-btn ${round.stage === 'observation' ? 'active' : ''}" data-sim-stage="observation">${L('3. 观察阶段', '3. Observe')}</button>
        <button class="quick-btn ${round.stage === 'settlement_success' ? 'active' : ''}" data-sim-stage="settlement_success">${L('4. 结算 · 达标', '4. Passed')}</button>
        <button class="quick-btn ${round.stage === 'settlement_burn' ? 'active' : ''}" data-sim-stage="settlement_burn">${L('5. 结算 · 未达标', '5. Missed')}</button>
        <button class="quick-btn ${round.stage === 'halted' ? 'active' : ''}" data-sim-stage="halted">${L('6. 技术中止', '6. Halted')}</button>
      </div>

      <div class="caps text-muted">${L('24H 时段状态演练（观察页）', '24H Slot Simulation (Observe)')}</div>
      <div class="grid-2">
        <button class="quick-btn" data-sim-radar="pass">${L('当前段确认 · 达标', 'Confirm Slot · Met')}</button>
        <button class="quick-btn" data-sim-radar="miss">${L('当前段确认 · 未达标', 'Confirm Slot · Miss')}</button>
        <button class="quick-btn" data-sim-radar="duplicate">${L('重复推送相同数据', 'Duplicate Payload')}</button>
        <button class="quick-btn" data-sim-radar="batch">${L('批量补齐历史时段', 'Batch Backfill')}</button>
      </div>

      <div class="caps text-muted">${L('团队角色', 'Squad Role')}</div>
      <div class="grid-3">
        <button class="quick-btn ${team.role === 'captain' ? 'active' : ''}" data-sim-role="captain">${L('队长', 'Captain')}</button>
        <button class="quick-btn ${team.role === 'member' ? 'active' : ''}" data-sim-role="member">${L('成员', 'Member')}</button>
        <button class="quick-btn ${team.role === 'none' ? 'active' : ''}" data-sim-role="none">${L('大厅', 'Lobby')}</button>
      </div>

      <div class="caps text-muted">${L('快捷直达', 'Jump To')}</div>
      <div class="grid-2">
        <button class="quick-btn" data-sim-nav="/warmup">${icon('flame', 13)} ${L('预热', 'Warm-Up')}</button>
        <button class="quick-btn" data-sim-nav="/internal/market">${icon('swap', 13)} ${L('内盘', 'Market')}</button>
        <button class="quick-btn" data-sim-nav="/team/invite">${icon('qr', 13)} ${L('海报', 'Poster')}</button>
        <button class="quick-btn" data-sim-nav="/claim">${icon('bolt', 13)} ${L('领取', 'Claim')}</button>
        <button class="quick-btn" data-sim-nav="/settings">${icon('settings', 13)} ${L('设置', 'Settings')}</button>
        <button class="quick-btn" data-sim-nav="/rules">${icon('book', 13)} ${L('规则', 'Rules')}</button>
      </div>
    </div>
  `;

  simDrawerEl.onclick = (e) => { if (e.target === simDrawerEl) simDrawerEl.classList.add('hidden'); };
  simDrawerEl.querySelector('#sim-close').onclick = () => simDrawerEl.classList.add('hidden');

  simDrawerEl.querySelectorAll('[data-sim-stage]').forEach(b => {
    b.onclick = () => {
      store.update(s => { s.round.stage = b.dataset.simStage; });
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
    const candleCd = document.getElementById('active-candle-cd');
    if (candleCd) {
      const hasActive = Array.isArray(r.candles) && r.candles.some(c => c.status === 'active');
      candleCd.textContent = hasActive ? `${L('剩余', 'Left')} ${formatTimer(r.activeCandleSec || 0).slice(3)}` : '—';
    }
    const predExpCd = document.getElementById('pred-exp-cd');
    const expAt = Number(store.state.prediction?.pendingExpiresAt);
    if (predExpCd && Number.isFinite(expAt) && expAt > 0) {
      const rem = Math.max(0, Math.floor((expAt - Date.now()) / 1000));
      predExpCd.textContent = rem > 0 ? `${L('距过期', 'Expires in')} ${formatTimer(rem)}` : L('已过期', 'Expired');
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

// Bootstrap — 方案 A 默认白昼暖棉纸立体书（尊重用户已保存的暗夜纸本偏好）
initAutoLanguage();
applyTheme(localStorage.getItem(THEME_KEY) || 'light');
A9TMA.init();
tonConnect.init();

const startParsed = A9TMA.parseStartParam();
if (startParsed?.ref) {
  store.setReferrerId(startParsed.ref);
}
if (startParsed?.scrollTarget) {
  store.state.referral.pendingScrollTarget = startParsed.scrollTarget;
}

renderCurrentRoute();

if (startParsed?.route) {
  window.location.hash = `#${startParsed.route}`;
} else if (!window.location.hash) {
  window.location.hash = '#/challenge';
}

window.addEventListener('hashchange', renderCurrentRoute);
syncData({ forceRender: true });
if (!config.isDemo) setInterval(() => syncData(), config.pollMs);
startDisplayLoop();
