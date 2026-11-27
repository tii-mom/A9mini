import { paintScene } from './game-scenes.js';
import { peekDemoModule } from './demo-loader.js';
/**
 * A9 Telegram Mini App Bootstrapper — Slim Header, Race-Safe Dual-Theme & Quiet Telemetry
 */

import { store } from './store.js';
import { config } from './config.js';
import { loadSnapshot, mapRoundView, submitStartAppAttribution, fetchChestById, assistChestById, rawToA9, fetchMe, serverNowMs } from './data.js';
import { A9TMA, A9Haptic, isReducedMotion } from './tma.js';
import { A9Audio, bindKineticSurfaces, cleanupKineticSurfaces } from './audio.js';
import { matchRoute, resolveRouteAlias, getCachedRouteHandler, loadRouteHandler } from './router.js';
import { areStylesheetsLoaded, ensureStylesheets } from './css-loader.js';
import { escapeHtml, formatNum, formatTimer, showToast, cleanupActiveInteractions, peekHeavyComponents, loadHeavyComponents, syncSlidingSegTabs, openModal, closeModal, openChoiceSheet, openActionSheet } from './components.js';
import { icon } from './icons.js';
import { t, L, LANGUAGES, initAutoLanguage, syncDocumentLang } from './i18n.js';
import { tonConnect } from './tonconnect.js';
import { shouldDeferRouteRender, pendingTxManager, renderPendingTxBannerHtml } from './tx-ux.js';
import { deriveRoundUiState } from './round-state.js';

const headerEl = document.getElementById('app-header');
const tickerEl = document.getElementById('ticker-bar');
const mainEl = document.getElementById('app-main');
const tabbarEl = document.getElementById('app-tabbar');
const simDrawerEl = document.getElementById('sim-drawer');

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
let pendingDeferredRender = false;
let activeViewTransition = null;
const scrollMemory = new Map();
const navStack = [];

function syncPendingTxBanner() {
  if (!mainEl) return;
  const existing = mainEl.querySelector('#a9-pending-tx-bar');
  const tx = pendingTxManager.getActive();
  const network = store.state.round?.protocolConfig?.network || config.network || 'mainnet';
  if (!tx) {
    if (existing) existing.remove();
    return;
  }
  const html = renderPendingTxBannerHtml(tx, network);
  if (existing) {
    existing.outerHTML = html;
  } else {
    mainEl.insertAdjacentHTML('afterbegin', html);
  }
  const dismissBtn = mainEl.querySelector('#btn-dismiss-pending-tx');
  if (dismissBtn) {
    dismissBtn.onclick = () => {
      A9Haptic.light();
      pendingTxManager.clear();
    };
  }
}

function flushDeferredRender() {
  if (!pendingDeferredRender || shouldDeferRouteRender(document)) return;
  pendingDeferredRender = false;
  renderCurrentRoute();
}

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

export function applyHapticsPref(enabled) {
  const next = enabled !== false;
  A9Haptic.setEnabled(next);
  store.update(s => { s.settings.hapticsEnabled = next; });
  return next;
}

function syncRunningMotionState() {
  if (isReducedMotion()) {
    cleanupKineticSurfaces();
    if (activeViewTransition) {
      try { activeViewTransition.skipTransition?.(); } catch (_) {}
      activeViewTransition = null;
    }
    try {
      document.querySelectorAll?.('.spark-particle, .flying-coin').forEach((el) => el.remove());
    } catch (_) {}
  } else if (mainEl) {
    bindKineticSurfaces(mainEl);
  }
}

export function applyMotionPref(reduced) {
  const next = Boolean(reduced);
  if (next) document.documentElement.dataset.reducedMotion = 'true';
  else delete document.documentElement.dataset.reducedMotion;
  store.update(s => { s.settings.reducedMotion = next; });
  syncRunningMotionState();
  return next;
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

  const reduced = isReducedMotion();
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

export function navigate(path, { replace = false } = {}) {
  const targetHash = `#${path}`;
  if (window.location.hash !== targetHash) {
    if (replace && window.history?.replaceState) {
      window.history.replaceState(null, '', targetHash);
      renderCurrentRoute();
    } else {
      window.location.hash = targetHash;
    }
  } else {
    renderCurrentRoute();
  }
}

function goBack() {
  const currentHash = window.location.hash || '#/challenge';
  const { route: curRoute } = matchRoute(currentHash);
  A9Haptic.light();
  // 弹出当前页面，回到栈内上一不同基础路径；若无历史栈（如深链/刷新直达）则直返归属主 Tab
  while (navStack.length > 0) {
    const top = navStack[navStack.length - 1];
    if (top.basePath === curRoute.path) {
      navStack.pop();
    } else {
      break;
    }
  }
  const prev = navStack.pop();
  if (prev && prev.fullPath) {
    navigate(prev.fullPath, { replace: true });
    return;
  }
  const fallbackTab = curRoute.tab ? `/${curRoute.tab}` : '/challenge';
  navigate(fallbackTab, { replace: true });
}

let lastHeaderSig = '';

/** 极简降噪顶栏：左侧品牌/返回标题 + 右侧钱包状态（演示模式留 1 枚控制台图标）；主题与音效收进「设置」 */
function renderHeader(route) {
  const { user, settings } = store.state;
  const isStack = route.shell === 'stack';
  const titleText = typeof route.title === 'function' ? route.title() : route.title;
  const walletLabel = user.connected
    ? (user.shortAddress || (user.address ? (user.address.length > 12 ? `${user.address.slice(0, 4)}...${user.address.slice(-4)}` : user.address) : t('connect_wallet')))
    : t('connect_wallet');

  syncDocumentLang(isStack ? titleText : '');
  A9TMA.setBackButton(isStack, goBack);

  const activeNet = store.state.round?.protocolConfig?.network || config.network || '';
  const modeBadge = config.isDemo
    ? 'DEMO'
    : (activeNet === 'testnet'
        ? (!store.fundsEnabled ? L('测试网 · 只读', 'TESTNET · RO') : L('测试网', 'TESTNET'))
        : (!store.fundsEnabled ? L('只读', 'READ-ONLY') : ''));
  const isPlaza = route.path === '/challenge';
  const nextSig = `${isStack ? '1' : '0'}|${isPlaza ? '1' : '0'}|${titleText}|${user.connected ? '1' : '0'}|${walletLabel}|${settings?.language || ''}|${activeNet}|${modeBadge}`;
  if (nextSig === lastHeaderSig && headerEl.innerHTML && !headerEl.hasAttribute?.('data-static-shell')) {
    return;
  }
  headerEl.removeAttribute?.('data-static-shell');
  lastHeaderSig = nextSig;

  headerEl.innerHTML = `
    <div class="header-left">
      ${isStack ? `<button class="icon-btn" id="hdr-back" type="button" aria-label="${L('返回', 'Back')}">${icon('arrowLeft', 16)}</button>` : ''}
      ${!isStack
        ? `<div class="header-brand"><span class="brand-mark" aria-label="A9"><img class="brand-logo" src="./assets/brand/apple-touch-icon.png" alt="A9" width="32" height="32" /></span>${modeBadge ? `<span class="header-demo-dot">${modeBadge}</span>` : ''}</div>`
        : `<div class="header-title"><span class="header-title-text">${titleText}</span></div>`
      }
    </div>
    <div class="header-right">
      ${isPlaza ? `<a class="header-rules-link" id="hdr-rules-link" href="#/rules">${L('规则', 'Rules')} ›</a>` : ''}
      ${config.isDemo ? `<button class="icon-btn has-demo-pip" id="btn-open-sim" type="button" aria-label="${L('演示控制台', 'Demo console')}" title="${L('演示控制台 (DEMO)', 'Demo console (DEMO)')}">${icon('sliders', 14)}</button>` : ''}
      <button class="icon-btn" id="btn-header-more" type="button" aria-label="${L('更多快捷操作', 'More quick actions')}" title="${L('更多', 'More')}">${icon('more', 16)}</button>
      <button class="wallet-pill ${user.connected ? '' : 'disconnected'}" id="btn-wallet-pill" type="button">
        <span class="live-dot ${user.connected ? '' : 'amber'}"></span>
        <span>${escapeHtml(walletLabel)}</span>
      </button>
    </div>
  `;

  const backBtn = headerEl.querySelector('#hdr-back');
  if (backBtn) backBtn.onclick = goBack;

  headerEl.querySelector('#btn-wallet-pill').onclick = () => {
    tonConnect.openConnectModal(renderCurrentRoute);
  };

  const moreBtn = headerEl.querySelector('#btn-header-more');
  if (moreBtn) moreBtn.onclick = openMoreQuickSheet;

  const simBtn = headerEl.querySelector('#btn-open-sim');
  if (simBtn) simBtn.onclick = openSimDrawer;
}

/** 顶栏「更多」底部快捷面板（精简 3 项：主题 / 语言 / 规则与透明，Demo 重置放危险区） */
function openMoreQuickSheet() {
  const curTheme = getTheme();
  const curLangObj = LANGUAGES.find((l) => l.code === store.state.settings.language) || LANGUAGES[0];
  const items = [
    {
      icon: curTheme === 'dark' ? 'moon' : 'sun',
      tone: 'is-amber',
      label: L('主题', 'Theme'),
      sub: L('雪白亮色 / 石墨暗夜', 'Crisp Light / Switch Dark'),
      badge: curTheme === 'dark' ? L('石墨暗夜', 'Dark') : L('雪白亮色', 'Light'),
      keepOpen: true,
      onSelect: () => openChoiceSheet({
        title: L('选择界面主题', 'Select Theme'),
        selected: getTheme(),
        options: [
          { value: 'light', icon: 'sun', tone: 'is-amber', label: L('雪白亮色', 'Crisp Light'), sub: L('任天堂红白日间配色', 'Nintendo light theme') },
          { value: 'dark', icon: 'moon', tone: 'is-blue', label: L('石墨暗夜', 'Switch Dark'), sub: L('OLED 深石墨夜间配色', 'Switch OLED dark theme') },
        ],
        onSelect: (mode) => {
          if (mode !== getTheme()) {
            applyTheme(mode);
            renderCurrentRoute();
            showToast(mode === 'dark' ? L('已切换石墨暗夜主题', 'Switched to Switch Dark') : L('已切换雪白亮色主题', 'Switched to Crisp Light'));
          }
        },
      }),
    },
    {
      icon: 'globe',
      tone: 'is-blue',
      label: L('语言', 'Language'),
      sub: L('实时切换中英文', 'Switch Chinese / English'),
      badge: curLangObj.label,
      keepOpen: true,
      onSelect: () => openChoiceSheet({
        title: L('选择界面语言', 'Select Language'),
        selected: store.state.settings.language,
        options: LANGUAGES.map((l) => ({ value: l.code, icon: 'globe', tone: 'is-blue', label: l.label, sub: l.sub })),
        onSelect: (code) => {
          store.update((s) => { s.settings.language = code; });
          showToast(`${L('已切换语言', 'Language')}: ${code}`);
          renderCurrentRoute();
        },
      }),
    },
    {
      icon: 'book',
      tone: 'is-red',
      label: L('规则与透明', 'Rules & Transparency'),
      sub: L('玩法、费用、合约地址与 22 条异常说明', 'Rules, fees, contracts & error codes'),
      onSelect: () => navigate('/rules'),
    },
  ];
  const dangerItems = config.isDemo
    ? [{
        icon: 'refresh',
        tone: 'is-red',
        label: L('重置本地演示数据', 'Reset Demo Data'),
        sub: L('仅恢复当前沙盒初始状态', 'Restore sandbox defaults only'),
        onSelect: () => {
          A9Haptic.warning();
          store.reset();
          showToast(L('已恢复初始演示数据', 'Demo reset'));
          renderCurrentRoute();
        },
      }]
    : [];
  openActionSheet({
    title: L('快捷菜单', 'Quick Menu'),
    subtitle: L('常用设置与协议入口', 'Preferences & protocol links'),
    items,
    dangerItems,
  });
}

function renderTicker(show) {
  const r = store.state.round;
  const hasLivePrice = r.livePrice !== null && r.livePrice !== undefined && Number.isFinite(Number(r.livePrice)) && Number(r.livePrice) > 0;
  if (!show || r.source !== 'api' || !hasLivePrice) {
    tickerEl.classList.add('hidden');
    return;
  }
  const hasTwap = r.twap24h !== null && r.twap24h !== undefined && Number.isFinite(Number(r.twap24h)) && Number(r.twap24h) > 0;
  tickerEl.classList.remove('hidden');
  tickerEl.innerHTML = `
    <div><b>A9</b> <span class="text-green">$${Number(r.livePrice).toFixed(4)}</span></div>
    <div><span class="text-muted">TWAP</span> <span class="text-cyan">${hasTwap ? `$${Number(r.twap24h).toFixed(4)}` : '—'}</span></div>
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

  if (tabbarEl.hasAttribute?.('data-static-shell') || !tabbarEl.querySelector('.dock-pill')) {
    tabbarEl.removeAttribute?.('data-static-shell');
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

/** 允许在首屏轮次快照尚未就绪或失败时直接打开的静态 / 独立接口路由。 */
const ROUTES_ALLOW_WITHOUT_SNAPSHOT = new Set([
  '/market',
  '/internal/market',
  '/warmup',
  '/warmup/rank',
  '/rules',
  '/settings',
  '/records',
  '/risk/matrix',
  '/risk/audit',
  '/gallery',
]);

function formatLastUpdatedHHMM(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    const d = new Date(n);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch (_) {
    return null;
  }
}

function renderStaticStatusStripHtml() {
  const u = store.state.user;
  const walletText = u.connected && u.address
    ? (u.shortAddress || (u.address.length > 12 ? `${u.address.slice(0, 4)}…${u.address.slice(-4)}` : u.address))
    : L('未连接', 'Disconnected');
  return `
    <section class="plaza-status-strip" aria-label="${L('我的状态', 'My Status')}">
      <div class="plaza-status-cell">
        <span class="plaza-status-lbl">${L('钱包', 'Wallet')}</span>
        <strong class="plaza-status-val mono">${escapeHtml(walletText)}</strong>
      </div>
      <div class="plaza-status-cell">
        <span class="plaza-status-lbl">${L('本轮已锁仓', 'Round Locked')}</span>
        <strong class="plaza-status-val mono">—</strong>
      </div>
      <a class="plaza-status-cell plaza-status-trigger" href="#/rewards">
        <span class="plaza-status-lbl">${L('可领取', 'Claimable')}</span>
        <strong class="plaza-status-val mono">—</strong>
      </a>
    </section>
  `;
}

function renderStaticIntroCardHtml() {
  if (store.state.settings?.hidePlazaHowToPlay) return '';
  return `
    <section class="card plaza-howto-card">
      <div class="row-between" style="gap:8px;margin-bottom:4px;">
        <strong class="num-xs" style="color:var(--ink);font-weight:800;">${L('三步玩法', '3-Step Flow')}</strong>
      </div>
      <div class="num-xs text-sec" style="line-height:1.5;">
        ${L('1. 24H 锁仓 A9 → 2. 12H 冲价满 8/12 段 → 3. 达标分奖，未达标自动止损退本。', '1. Lock A9 (24H) → 2. Push 8/12 slots (12H) → 3. Split pool on pass, or auto stop-loss refund.')}
      </div>
    </section>
  `;
}

function renderStaticQuickGatesHtml() {
  return `
    <section class="plaza-activity-zone" aria-label="${L('精选活动', 'Featured Activity')}">
      <a class="card plaza-mall-card" href="#/market">
        <span class="sw-gate-icon is-red" aria-hidden="true">${icon('chest', 22)}</span>
        <div class="plaza-mall-body">
          <div class="row-start" style="gap:6px;flex-wrap:wrap;">
            <strong class="num-sm" style="color:var(--ink);">${L('宝箱商城', 'Chest Mall')}</strong>
            <span class="chip chip-green" style="min-height:18px;font-size:10px;padding:0 6px;">${L('直发钱包', 'Direct Payout')}</span>
          </div>
          <span class="num-xs text-sec">${L('6 档宝箱保底 + 随机加赠，一笔直发钱包', '6 chest tiers with guaranteed base + bonus straight to wallet')}</span>
        </div>
        <span class="sw-menu-arrow" aria-hidden="true">›</span>
      </a>
    </section>
  `;
}

function renderLoading() {
  mainEl.innerHTML = `
    <div class="col-gap anim-page-enter">
      ${renderStaticStatusStripHtml()}
      <section class="card card-hero plaza-round-card nt-boot-skeleton" role="status" aria-busy="true" aria-label="${L('正在加载当前轮次', 'Loading current round')}">
        <div class="row-between" style="gap:8px;">
          <div class="row-start" style="gap:6px;">
            <strong class="num-sm">${L('当前轮次', 'Current Round')}</strong>
            <span class="chip chip-muted" style="min-height:20px;font-size:10.5px;padding:0 7px;">${L('加载中…', 'Loading…')}</span>
          </div>
          <span class="mono num-sm text-sec">${L('加载中…', 'Loading…')}</span>
        </div>
        <div class="plaza-mini-timeline" role="list" aria-label="${L('轮次四阶段进度', 'Round 4-stage timeline')}">
          <span class="plaza-mini-step" role="listitem"><i></i><b>${L('预热', 'Warm-Up')}</b></span>
          <span class="plaza-mini-step" role="listitem"><i></i><b>${L('锁仓', 'Lock')}</b></span>
          <span class="plaza-mini-step" role="listitem"><i></i><b>${L('冲价', 'Push')}</b></span>
          <span class="plaza-mini-step" role="listitem"><i></i><b>${L('结算', 'Settle')}</b></span>
        </div>
        <p class="plaza-one-line-status">${L('正在同步最新轮次状态…', 'Syncing latest round status…')}</p>
        <div class="nt-skel-card" style="height:42px;"></div>
      </section>
      ${renderStaticIntroCardHtml()}
      ${renderStaticQuickGatesHtml()}
    </div>
  `;
}

function renderDataError(error) {
  mainEl.innerHTML = `
    <div class="col-gap anim-page-enter">
      ${renderStaticStatusStripHtml()}
      <div class="card card-glow-red data-error-card" role="alert">
        <div class="row-between data-error-header">
          <div class="card-title">${icon('shieldAlert', 16, 'text-red')} ${L('轮次数据暂不可用', 'Round data unavailable')}</div>
          <span class="chip chip-red">${L('暂不可用', 'Unavailable')}</span>
        </div>
        <div class="text-sec" style="font-size:12px;line-height:1.6;overflow-wrap:anywhere;">${escapeHtml(error?.message || L('网络连接异常，暂时无法获取最新轮次数据。你可以重试或先逛宝箱商城。', 'Network unavailable. Retry loading round data or explore Chest Mall below.'))}</div>
        <button class="btn btn-primary" id="data-retry" type="button" style="margin-top:12px;">${icon('refresh', 16)} ${L('重试', 'Retry')}</button>
      </div>
      ${renderStaticIntroCardHtml()}
      ${renderStaticQuickGatesHtml()}
      ${config.lockMode ? '' : `
      <div class="card row-between">
        <span class="num-xs text-muted">${L('需要体验完整交互？切换到演示模式', 'Want full interaction? Use demo mode')}</span>
        <a class="num-xs text-green" href="?mode=demo">${L('演示模式', 'Demo')} ›</a>
      </div>
      `}
    </div>
  `;
  const btn = mainEl.querySelector('#data-retry');
  if (btn) {
    btn.onclick = () => {
      lastLoadError = null;
      if (!dataReady) {
        renderLoading();
        bootApp();
      } else {
        syncData({ forceRender: true });
      }
    };
  }
}

function staleBanner() {
  const r = store.state.round;
  if (!r.stale) return '';
  const hhmm = formatLastUpdatedHHMM(r.fetchedAt);
  const label = hhmm
    ? L(`上次更新 ${hhmm}`, `Last updated ${hhmm}`)
    : L('上次更新 待确认', 'Last updated pending');
  return `
    <div class="card row-between" id="a9-stale-banner" role="status" style="border-color:var(--gold-border);margin-bottom:2px;gap:8px;">
      <span class="row-start num-xs text-sec" style="min-width:0;">${icon('clock', 13, 'text-gold')} ${escapeHtml(label)}</span>
      <button class="btn btn-secondary btn-sm" id="stale-retry" type="button" style="flex-shrink:0;">${L('重试', 'Retry')}</button>
    </div>
  `;
}

let lastRenderedPath;
let lastFullHash = '';
let routeRenderSeq = 0;
export async function renderCurrentRoute() {
  const seq = ++routeRenderSeq;
  pendingDeferredRender = false;
  if (lastFullHash) scrollMemory.set(lastFullHash, window.scrollY || 0);
  // 切换路由时收拢残留弹层与模拟抽屉，防止跨页残留遮罩
  const modalRoot = document.getElementById('modal-root');
  if (modalRoot && typeof modalRoot.classList?.contains === 'function' && !modalRoot.classList.contains('hidden')) closeModal();
  if (simDrawerEl && typeof simDrawerEl.classList?.contains === 'function' && !simDrawerEl.classList.contains('hidden')) simDrawerEl.classList.add('hidden');
  cleanupActiveInteractions();
  cleanupKineticSurfaces();
  let currentHash = window.location.hash || '#/challenge';
  // 仅在解析完成后、加载页面之前对旧路由别名进行规范化（保留 query 与锚点，规范路径不触发重定向，避免自循环）
  const resolvedAlias = resolveRouteAlias(currentHash);
  if (resolvedAlias && resolvedAlias.to !== currentHash) {
    currentHash = resolvedAlias.to;
    try {
      if (window.history?.replaceState) {
        window.history.replaceState(null, '', resolvedAlias.to);
      }
    } catch (_) {}
  }
  const fullPath = currentHash.replace(/^#/, '') || '/challenge';
  const { route, param, query: rawQuery, anchor } = matchRoute(currentHash);
  const query = anchor ? { ...rawQuery, _anchor: anchor } : rawQuery;
  if (route.shell === 'tab') {
    navStack.length = 0;
    navStack.push({ basePath: route.path, fullPath });
  } else {
    const top = navStack[navStack.length - 1];
    if (top && top.basePath === route.path) {
      top.fullPath = fullPath;
    } else {
      navStack.push({ basePath: route.path, fullPath });
      if (navStack.length > 24) navStack.shift();
    }
  }
  document.body.dataset.gameRoute = route.path;
  paintScene(document.getElementById('realm-banner'), dataReady ? route.path : null);
  renderHeader(route);
  renderTicker(route.ticker);
  renderTabBar(route);

  if (!dataReady && !ROUTES_ALLOW_WITHOUT_SNAPSHOT.has(route.path)) {
    if (lastLoadError) renderDataError(lastLoadError);
    else renderLoading();
    return;
  }
  const prevPath = lastRenderedPath;
  // 每次路由切换均创建全新子挂载容器，确保旧页面的 root.isConnected 立即变为 false，
  // 彻底根治弱网快切 Tab 异步回调覆写新页面 DOM 与页面内 setInterval 定时器泄漏。
  let renderTarget = mainEl;
  if (typeof document.createElement === 'function' && typeof mainEl.replaceChildren === 'function') {
    const viewHost = document.createElement('div');
    viewHost.className = 'route-view-host';
    mainEl.replaceChildren(viewHost);
    renderTarget = viewHost;
  } else if (typeof document.createElement === 'function' && typeof mainEl.appendChild === 'function') {
    const viewHost = document.createElement('div');
    viewHost.className = 'route-view-host';
    mainEl.innerHTML = '';
    mainEl.appendChild(viewHost);
    renderTarget = viewHost;
  }
  try {
    const cachedRender = getCachedRouteHandler(route);
    const stylesReady = areStylesheetsLoaded(route.styles);
    if (cachedRender && stylesReady) {
      cachedRender(renderTarget, navigate, param, query);
    } else {
      renderTarget.setAttribute?.('aria-busy', 'true');
      renderTarget.innerHTML = route.shell === 'tab'
        ? `<div class="nt-boot-skeleton" role="status" aria-label="${L('正在加载页面', 'Loading page')}"><div class="nt-skel-card nt-skel-hero"></div><div class="nt-skel-grid"><i></i><i></i><i></i><i></i></div><div class="nt-skel-card"></div></div>`
        : `<div class="nt-boot-skeleton" role="status" aria-label="${L('正在加载页面', 'Loading page')}"><div class="nt-skel-card nt-skel-hero"></div><div class="nt-skel-card"></div></div>`;
      const stylesPromise = ensureStylesheets(route.styles);
      // 防止路由脚本先失败时样式 Promise 产生未处理的 rejection
      stylesPromise.catch(() => {});
      const render = await loadRouteHandler(route);
      await stylesPromise;
      if (seq !== routeRenderSeq) return;
      renderTarget.removeAttribute?.('aria-busy');
      renderTarget.innerHTML = '';
      render(renderTarget, navigate, param, query);
    }
  } catch (error) {
    if (seq === routeRenderSeq) renderDataError(error);
    return;
  }
  if (prevPath && route.path !== prevPath) {
    if (route.shell === 'stack') A9Audio.pageTurn();
    if (!isReducedMotion()) {
      renderTarget.animate?.([{opacity:0.7, transform:'translateY(5px)'},{opacity:1, transform:'none'}],{duration:180,easing:'ease-out'});
    }
  }
  lastRenderedPath = route.path;
  lastFullHash = currentHash;
  bindKineticSurfaces(renderTarget);
  requestAnimationFrame(() => syncSlidingSegTabs(renderTarget));

  const banner = staleBanner();
  if (banner) {
    mainEl.insertAdjacentHTML('afterbegin', banner);
    const btn = mainEl.querySelector('#stale-retry');
    if (btn) btn.onclick = () => syncData({ forceRender: true });
  }
  syncPendingTxBanner();
  const hasHashAnchor = Boolean(String(currentHash || '').split('#')[2]);
  if (!hasHashAnchor) {
    const restoredY = route.shell === 'tab' && prevPath && prevPath !== route.path ? (scrollMemory.get(currentHash) || 0) : 0;
    window.scrollTo({ top: restoredY, behavior: 'instant' });
  }

  // 触发页面首屏就绪事件（性能测量用）：关键 DOM + 样式 + 数据状态实际可用
  if (typeof window !== 'undefined' && !window.__A9_APP_READY_TS && dataReady) {
    requestAnimationFrame(() => {
      if (!window.__A9_APP_READY_TS && seq === routeRenderSeq && renderTarget.isConnected && !mainEl.querySelector('.nt-boot-skeleton')) {
        window.__A9_APP_READY_TS = performance.now() + performance.timeOrigin;
        window.dispatchEvent(new Event('a9:app-ready'));
      }
    });
  }
}

function applySnapshotToStore(snapshot, { forceRender = false } = {}) {
  const view = mapRoundView(snapshot);
  const key = [
    view.rawState,
    view.currentRound,
    view.qualifiedCandles,
    view.candlesSeen,
    view.source,
    view.stale,
    view.detailLoading,
    view.detailStale,
    view.result,
    view.targetPrice,
    view.twap24h,
    view.priceValid,
    view.successCount,
    JSON.stringify(view.unlock),
    JSON.stringify(view.candles)
  ].join('|');
  const changed = key !== lastDataKey;

  store.update(s => { Object.assign(s.round, view); });
  dataReady = true;
  lastLoadError = null;
  lastDataKey = key;

  // 触发数据加载完成事件（性能测量用）
  if (typeof window !== 'undefined' && !window.__A9_DATA_READY_TS) {
    window.__A9_DATA_READY_TS = performance.now() + performance.timeOrigin;
    window.dispatchEvent(new Event('a9:data-ready'));
  }

  // If staying on observation/proof radar with only slot/count progression, update in-place without full DOM rebuild
  if (!forceRender && !changed && document.getElementById('a9-radar-grid')) {
    const heavy = peekHeavyComponents();
    if (heavy?.syncRadarInPlace) {
      heavy.syncRadarInPlace(store.state.round);
    } else {
      const expectedSeq = routeRenderSeq;
      loadHeavyComponents().then((m) => {
        if (expectedSeq === routeRenderSeq && document.getElementById('a9-radar-grid')) {
          m?.syncRadarInPlace?.(store.state.round);
        }
      });
    }
    return;
  }

  if (forceRender || changed) {
    if (!forceRender && shouldDeferRouteRender(document)) {
      pendingDeferredRender = true;
      const activeRoute = matchRoute(window.location.hash || '#/challenge').route;
      renderHeader(activeRoute);
      renderTicker(activeRoute.ticker);
      renderTabBar(activeRoute);
    } else {
      renderCurrentRoute();
    }
  } else {
    renderHeader(matchRoute(window.location.hash).route);
  }
}

async function syncData({ forceRender = false } = {}) {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const snapshot = await loadSnapshot({
      onPartial: (partialSnapshot) => {
        // config + rounds 先到先渲染，避免用户死等当前轮 detail 才看到首屏数据
        applySnapshotToStore(partialSnapshot, { forceRender: !dataReady || forceRender });
      }
    });
    applySnapshotToStore(snapshot, { forceRender });
  } catch (error) {
    if (!dataReady) {
      lastLoadError = error;
      dataReady = false;
      const activeRoute = matchRoute(window.location.hash || '#/challenge').route;
      if (!ROUTES_ALLOW_WITHOUT_SNAPSHOT.has(activeRoute.path)) {
        renderDataError(error);
      }
    } else {
      store.update(s => { s.round.stale = true; });
      if (shouldDeferRouteRender(document)) {
        pendingDeferredRender = true;
        const activeRoute = matchRoute(window.location.hash || '#/challenge').route;
        renderHeader(activeRoute);
        renderTicker(activeRoute.ticker);
      } else {
        renderCurrentRoute();
      }
    }
  } finally {
    isSyncing = false;
  }
}

/** Demo-only helper to simulate single slot confirmation / duplicate / batch backfill */
function simulateRadarEvent(type) {
  const r = store.state.round;
  if (!Array.isArray(r.candles) || r.candles.length < 1) return;
  const runSync = (opts) => {
    const heavy = peekHeavyComponents();
    if (heavy?.syncRadarInPlace) {
      heavy.syncRadarInPlace(r, opts);
      return;
    }
    const expectedSeq = routeRenderSeq;
    loadHeavyComponents().then((m) => {
      if (expectedSeq === routeRenderSeq && document.getElementById('a9-radar-grid')) {
        m?.syncRadarInPlace?.(r, opts);
      }
    });
  };
  if (type === 'duplicate') {
    runSync();
    showToast(L('已重放相同数据（无多余动效）', 'Duplicate payload synced (no anim)'));
    return;
  }
  if (type === 'batch') {
    const total = r.candles.length || 12;
    const target = Math.max(1, Math.min(total - 2, 10));
    r.candles.forEach(c => {
      if (c.index <= target) {
        c.status = 'closed';
        c.bull = c.index % 4 !== 0;
        c.p = c.bull ? 0.0068 : 0.0049;
      } else if (c.index === target + 1) {
        c.status = 'active';
        c.bull = true;
        c.p = 0.0066;
      } else {
        c.status = 'pending';
        c.p = null;
      }
    });
    r.qualifiedCandles = r.candles.filter(c => c.status === 'closed' && c.bull).length;
    r.candlesSeen = target;
    r.needMore = Math.max(0, (r.minQualifiedCandles || 8) - r.qualifiedCandles);
    runSync({ batch: true });
    showToast(L(`已批量补齐至第 ${target} 段（直接同步）`, `Batch backfilled to slot #${target}`));
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
  r.needMore = Math.max(0, (r.minQualifiedCandles || 8) - r.qualifiedCandles);
  runSync();
}

function openSimDrawer() {
  const closeSimDrawer = () => {
    simDrawerEl.classList.add('hidden');
    flushDeferredRender();
  };
  simDrawerEl.classList.remove('hidden');
  if (!store.demoReady) {
    const failed = Boolean(lastLoadError);
    simDrawerEl.innerHTML = `
      <div class="modal-sheet">
        <div class="sheet-handle"></div>
        <div class="row-between">
          <div class="card-title">${icon('sliders', 16, failed ? 'text-red' : 'text-gold')} ${L('演示控制台暂不可用', 'Demo Console Unavailable')}</div>
          <button class="icon-btn" id="sim-close" aria-label="Close">${icon('x', 15)}</button>
        </div>
        <div class="text-sec" style="font-size:12px;line-height:1.6;">
          ${failed
            ? escapeHtml(lastLoadError?.message || L('演示数据模块加载失败，阶段、身份与资金模拟操作已锁定，请重试加载。', 'Demo data failed to load. Stage, role, and fund controls are locked; please retry.'))
            : L('演示数据正在加载中，加载完成后自动开放阶段、身份与资金模拟操作。', 'Demo data is loading. Stage, role, and fund controls will unlock once ready.')}
        </div>
        ${failed ? `<button class="btn btn-primary" id="sim-retry-demo" type="button">${icon('refresh', 15)} ${L('重试加载演示数据', 'Retry Loading Demo Data')}</button>` : ''}
      </div>
    `;
    simDrawerEl.onclick = (e) => { if (e.target === simDrawerEl) closeSimDrawer(); };
    simDrawerEl.querySelector('#sim-close').onclick = closeSimDrawer;
    const retryBtn = simDrawerEl.querySelector('#sim-retry-demo');
    if (retryBtn) {
      retryBtn.onclick = () => {
        lastLoadError = null;
        openSimDrawer();
        bootApp();
      };
    }
    return;
  }
  const { round, team, user } = store.state;
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
        <button class="quick-btn ${round.stage === 'participation' ? 'active' : ''}" data-sim-stage="participation">${L('2. 24H 锁仓开放', '2. 24H Lock')}</button>
        <button class="quick-btn ${round.stage === 'observation' ? 'active' : ''}" data-sim-stage="observation">${L('3. 12H 冲价中', '3. 12H Push')}</button>
        <button class="quick-btn ${round.stage === 'settlement_success' ? 'active' : ''}" data-sim-stage="settlement_success">${L('4. 通关派奖', '4. Passed')}</button>
        <button class="quick-btn ${round.stage === 'settlement_burn' ? 'active' : ''}" data-sim-stage="settlement_burn">${L('5. 未通关 · 自动止损', '5. Auto Stop-Loss')}</button>
        <button class="quick-btn ${round.stage === 'halted' ? 'active' : ''}" data-sim-stage="halted">${L('6. 异常中止 · 退回本金', '6. Aborted · Refund')}</button>
      </div>

      <div class="caps text-muted">${L('12H 冲价时段状态演练', '12H Push Slot Simulation')}</div>
      <div class="grid-2">
        <button class="quick-btn" data-sim-radar="pass">${L('当前段确认 · 达标', 'Confirm Slot · Met')}</button>
        <button class="quick-btn" data-sim-radar="miss">${L('当前段确认 · 未达标', 'Confirm Slot · Miss')}</button>
        <button class="quick-btn" data-sim-radar="duplicate">${L('重复推送相同数据', 'Duplicate Payload')}</button>
        <button class="quick-btn" data-sim-radar="batch">${L('批量补齐历史时段', 'Batch Backfill')}</button>
      </div>

      <div class="caps text-muted">${L('我的视图', 'Me View')}</div>
      <div class="grid-2">
        <button class="quick-btn ${user.profileMode !== 'empty' ? 'active' : ''}" data-sim-profile-mode="active">${L('持仓', 'Active Vault')}</button>
        <button class="quick-btn ${user.profileMode === 'empty' ? 'active' : ''}" data-sim-profile-mode="empty">${L('空态', 'Empty State')}</button>
      </div>

      <div class="caps text-muted">${L('战队角色', 'Squad Role')}</div>
      <div class="grid-3">
        <button class="quick-btn ${team.role === 'captain' ? 'active' : ''}" data-sim-role="captain">${L('队长', 'Captain')}</button>
        <button class="quick-btn ${team.role === 'member' ? 'active' : ''}" data-sim-role="member">${L('成员', 'Member')}</button>
        <button class="quick-btn ${team.role === 'none' ? 'active' : ''}" data-sim-role="none">${L('大厅', 'Lobby')}</button>
      </div>

      <div class="caps text-muted">${L('快捷直达', 'Jump To')}</div>
      <div class="grid-2">
        <button class="quick-btn" data-sim-nav="/round?stage=warmup">${icon('flame', 13)} ${L('开局预热', 'Pre-Round')}</button>
        <button class="quick-btn" data-sim-nav="/market">${icon('swap', 13)} ${L('宝箱商城', 'Chest Mall')}</button>
        <button class="quick-btn" data-sim-nav="/team/invite">${icon('qr', 13)} ${L('邀友赢奖', 'Invite & Earn')}</button>
        <button class="quick-btn" data-sim-nav="/rewards">${icon('bolt', 13)} ${L('我的奖励', 'My Rewards')}</button>
        <button class="quick-btn" data-sim-nav="/settings">${icon('settings', 13)} ${L('设置', 'Settings')}</button>
        <button class="quick-btn" data-sim-nav="/rules">${icon('book', 13)} ${L('规则与透明', 'Rules & Transparency')}</button>
      </div>
    </div>
  `;

  simDrawerEl.onclick = (e) => { if (e.target === simDrawerEl) closeSimDrawer(); };
  simDrawerEl.querySelector('#sim-close').onclick = closeSimDrawer;

  simDrawerEl.querySelectorAll('[data-sim-stage]').forEach(b => {
    b.onclick = () => {
      const demoMod = peekDemoModule();
      if (demoMod) {
        store.update(s => {
          demoMod.setDemoRoundStage(s.round, b.dataset.simStage);
        });
      }
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
  simDrawerEl.querySelectorAll('[data-sim-profile-mode]').forEach(b => {
    b.onclick = () => {
      store.update(s => { s.user.profileMode = b.dataset.simProfileMode; });
      simDrawerEl.classList.add('hidden');
      renderCurrentRoute();
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
  if (e.defaultPrevented) return;
  if (e.key === 'Escape' && simDrawerEl && !simDrawerEl.classList.contains('hidden')) {
    simDrawerEl.classList.add('hidden');
    flushDeferredRender();
    return;
  }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const navTarget = e.target?.closest?.('[data-nav]:not(button):not(a)');
  if (navTarget) {
    e.preventDefault();
    navigate(navTarget.dataset.nav);
    return;
  }
  const btnTarget = e.target?.closest?.('[role="button"][tabindex="0"]');
  if (!btnTarget || btnTarget.tagName === 'BUTTON' || btnTarget.tagName === 'A' || btnTarget.tagName === 'INPUT' || btnTarget.tagName === 'TEXTAREA') return;
  e.preventDefault();
  btnTarget.click();
});

function syncLivePriceDomInPlace(r) {
  const validLive = r.priceValid !== false && Number(r.livePrice ?? r.twap24h) > 0 ? Number(r.livePrice ?? r.twap24h) : null;
  const validTarget = Number(r.targetPrice) > 0 ? Number(r.targetPrice) : null;
  const liveText = validLive !== null ? `$${validLive.toFixed(4)}` : '—';
  const deltaPct = (validLive !== null && validTarget !== null) ? (((validLive - validTarget) / validTarget) * 100) : null;
  const isAbove = deltaPct !== null && deltaPct >= 0;
  const deltaText = deltaPct === null
    ? L('价格待同步', 'Syncing price')
    : isAbove
      ? L(`已站上目标价 +${deltaPct.toFixed(1)}%`, `Above target +${deltaPct.toFixed(1)}%`)
      : L(`距目标价差 ${deltaPct.toFixed(1)}%`, `Below target ${deltaPct.toFixed(1)}%`);

  const liveEl = document.getElementById('round-live-price');
  if (liveEl) liveEl.textContent = liveText;
  const deltaEl = document.getElementById('round-target-delta');
  if (deltaEl) {
    deltaEl.textContent = deltaText;
    deltaEl.className = `chip ${deltaPct === null ? 'chip-muted' : (isAbove ? 'chip-green' : 'chip-red')} mono`;
  }
  const pulseEl = document.getElementById('round-live-pulse');
  if (pulseEl) {
    pulseEl.className = `sw-pulse-dot ${deltaPct === null ? '' : (isAbove ? 'is-up' : 'is-down')}`;
  }
  const rulerFill = document.getElementById('round-price-ruler-fill');
  if (rulerFill && validLive !== null && validTarget !== null) {
    const minB = validTarget * 0.75;
    const maxB = validTarget * 1.15;
    const pct = Math.max(8, Math.min(100, Math.round((((validLive - minB) / (maxB - minB)) * 100) * 10) / 10));
    rulerFill.style.width = `${pct}%`;
    rulerFill.classList.toggle('is-up', isAbove);
  }
  const actionHint = document.getElementById('round-price-action-hint');
  const liveUiStage = deriveRoundUiState({ detail: r, user: store.state.user, serverNowMs: serverNowMs() }).stage;
  if (actionHint && deltaPct !== null && liveUiStage === 'charge') {
    actionHint.textContent = isAbove
      ? L('当前参考价高于目标，待时段结束后按 1H 判定均价确认', 'Current reference price is above target; confirmed by 1H average at slot close')
      : L('当前参考价低于目标，待时段结束后按 1H 判定均价确认', 'Current reference price is below target; confirmed by 1H average at slot close');
    actionHint.className = `num-xs ${isAbove ? 'text-green' : 'text-red'}`;
  }
  const plazaLive = document.getElementById('plaza-live-price');
  if (plazaLive) plazaLive.textContent = liveText;
  const plazaDelta = document.getElementById('plaza-target-delta');
  if (plazaDelta) {
    plazaDelta.textContent = deltaPct === null
      ? L('价格待同步', 'Syncing price')
      : isAbove
        ? L(`高于目标 +${deltaPct.toFixed(1)}%`, `Above +${deltaPct.toFixed(1)}%`)
        : L(`距目标 ${deltaPct.toFixed(1)}%`, `Gap ${deltaPct.toFixed(1)}%`);
    plazaDelta.className = `chip ${deltaPct === null ? 'chip-muted' : (isAbove ? 'chip-green' : 'chip-red')} mono`;
  }
  const teamLive = document.getElementById('team-battle-price');
  if (teamLive) teamLive.textContent = liveText;
  const teamDelta = document.getElementById('team-battle-delta');
  if (teamDelta) {
    teamDelta.textContent = deltaPct === null ? '—' : `${isAbove ? '+' : ''}${deltaPct.toFixed(1)}%`;
    teamDelta.className = `chip ${deltaPct === null ? 'chip-muted' : (isAbove ? 'chip-green' : 'chip-red')} mono`;
  }
}

function startDisplayLoop() {
  setInterval(() => {
    if (document.hidden) return;
    const r = store.state.round;
    if (typeof r.countdownSec === 'number' && r.countdownSec > 0) r.countdownSec -= 1;
    if (typeof r.earlyBirdSec === 'number' && r.earlyBirdSec > 0) r.earlyBirdSec -= 1;
    r.activeCandleSec = r.activeCandleEndAt ? Math.max(0, Math.ceil((r.activeCandleEndAt - serverNowMs()) / 1000)) : null;

    const uiState = deriveRoundUiState({ detail: r, user: store.state.user, serverNowMs: serverNowMs() });
    const posCdSec = uiState.countdownMs !== null ? Math.ceil(uiState.countdownMs / 1000) : null;
    const cdText = posCdSec !== null && posCdSec > 0
      ? formatTimer(posCdSec)
      : (r.detailLoading ? L('加载中…', 'Loading…') : uiState.countdownLabel);
    const isUrgent = posCdSec !== null && posCdSec > 0 && posCdSec <= 3600;
    const roundCd = document.getElementById('round-cd');
    if (roundCd) {
      roundCd.textContent = cdText;
      if (roundCd.parentElement?.classList?.contains('sw-price-cd')) {
        roundCd.parentElement.classList.toggle('is-urgent', isUrgent);
      }
    }
    const teamCd = document.getElementById('team-battle-cd');
    if (teamCd) teamCd.textContent = cdText;
    const earlyCd = document.getElementById('early-cd');
    if (earlyCd) earlyCd.textContent = r.earlyBirdSec === null || r.earlyBirdSec === undefined ? L('待确认', 'Pending') : formatTimer(r.earlyBirdSec);
    const earlyWinEl = document.getElementById('early-window-cd');
    if (earlyWinEl) {
      const normSec = (v) => {
        const n = Number(v || 0);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
      };
      const openAt = normSec(r.stakeOpenAt);
      const closeAt = normSec(r.stakeCloseAt);
      const explicitEarlyEnd = normSec(r.earlyCloseAt);
      let left = null;
      const earlyEnd = explicitEarlyEnd > 0
        ? explicitEarlyEnd
        : (openAt > 0 && closeAt > openAt ? openAt + Number(r.earlyWindowSeconds || 21600) : 0);
      if (earlyEnd > 0) {
        const diff = earlyEnd - Math.floor(serverNowMs() / 1000);
        if (diff > 0) left = diff;
      }
      if (left === null && config.isDemo && typeof r.earlyBirdSec === 'number') {
        left = Math.max(0, Math.floor(r.earlyBirdSec));
      }
      earlyWinEl.textContent = left === null ? L('待确认', 'Pending') : formatTimer(left);
    }
    const candleCd = document.getElementById('active-candle-cd');
    if (candleCd) {
      const hasActive = Array.isArray(r.candles) && r.candles.some(c => c.status === 'active');
      candleCd.textContent = hasActive && r.activeCandleSec > 0 ? `${L('剩余', 'Left')} ${formatTimer(r.activeCandleSec).slice(r.activeCandleSec >= 3600 ? 0 : 3)}` : L('待确认', 'Awaiting confirmation');
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
    const demoMod = peekDemoModule();
    if (!demoMod) return;
    const r = store.state.round;
    const nextPrice = demoMod.tickDemoPrice(r);

    const sLine = document.getElementById('spark-line');
    const sArea = document.getElementById('spark-area');
    const sDot = document.getElementById('spark-dot');
    const heavy = peekHeavyComponents();
    if (sLine && sArea && sDot && heavy?.buildSparklineSvgPath) {
      const sp = heavy.buildSparklineSvgPath(r.priceHistory);
      sLine.setAttribute('d', sp.line);
      sArea.setAttribute('d', sp.area);
      sDot.setAttribute('cx', sp.last.x);
      sDot.setAttribute('cy', sp.last.y);
    }

    const twapP = document.getElementById('live-twap-val');
    if (twapP) twapP.textContent = `$${nextPrice.toFixed(4)}`;
    syncLivePriceDomInPlace(r);
  }, 2600);
}

// Scroll-aware header elevation
window.addEventListener('scroll', () => {
  headerEl.classList.toggle('scrolled', window.scrollY > 6);
}, { passive: true });

// Bootstrap — 默认任天堂雪白亮色主题（尊重用户已保存于 a9_ui_prefs_v1 的 Switch 暗夜偏好）
initAutoLanguage();
applyTheme(store.state.settings?.themeMode || 'light');
applyHapticsPref(store.state.settings?.hapticsEnabled !== false);
applyMotionPref(Boolean(store.state.settings?.reducedMotion));
try {
  const motionMql = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (motionMql) {
    if (typeof motionMql.addEventListener === 'function') motionMql.addEventListener('change', syncRunningMotionState);
    else if (typeof motionMql.addListener === 'function') motionMql.addListener(syncRunningMotionState);
  }
} catch (_) {}
A9TMA.init();
tonConnect.restoreOnStartup(renderCurrentRoute);

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

/** 单屏宝箱双人同行礼弹窗（startapp=chest_<chestId> 落地闭环，规则与门槛不变） */
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
      <div class="card-title">${icon('bolt', 15, 'text-gold')} ${isBoost ? L('A9 付费随机宝箱', 'A9 Paid Random Chest') : L('双人同行礼 · 开启 A9 宝箱', 'Co-Op Chest Gift · A9')}</div>
      <button class="icon-btn" id="chest-assist-close" aria-label="Close">${icon('x', 15)}</button>
    </div>
    <div class="sub-tile" style="margin-bottom:12px;">
      <div class="row-between">
        <strong>${escapeHtml(label)}</strong>
        <span class="chip ${isBoost ? 'chip-green' : 'chip-gold'} mono">${!hasDetail ? L('待核验', 'Pending') : isBoost ? L('合并直发钱包', 'Direct Payout') : `${cur}/${req} ${L('同行', 'co-op')}`}</span>
      </div>
      <div class="num-xs text-sec" style="margin-top:6px;line-height:1.5;">
        ${!hasDetail
          ? L('宝箱详情待核验（暂未拉取到服务端状态），可点击下方重试读取或先连接 TON 钱包。', 'Chest details pending verification. Tap retry below or connect your TON wallet.')
          : isBoost
            ? L('付费宝箱已升级为 6 档纯随机开箱，保底 + 随机加赠合并直发钱包，无需好友助力！你也可以免费秒开专属青铜新手箱（200 A9）或前往宝箱商城体验。', 'Paid chests now send base + random bonus directly to your wallet with zero assists needed! Open your free 200 A9 Bronze Starter Chest or visit Chest Mall.')
            : L(`双向开箱礼：帮好友助力开启【${escapeHtml(label)}】（${formatNum(Math.round(rewardA9), 0)} A9），确认同行后立刻为你发放可秒开的专属青铜新手箱（200 A9）！`, `Co-op gift: assist [${escapeHtml(label)}] (${formatNum(Math.round(rewardA9), 0)} A9) and instantly unlock your own 200 A9 Bronze Starter Chest!`)}
      </div>
    </div>
    ${loadFailed ? `<button class="btn btn-secondary" id="btn-retry-chest-detail" type="button" style="margin-bottom:10px;">${L('重试读取宝箱详情', 'Retry Loading Details')}</button>` : ''}
    ${isBoost ? `
      <div class="grid-2" style="gap:8px;">
        <button class="btn btn-primary btn-sm" id="btn-chest-go-mall" type="button" style="width:100%;min-height:42px;">${icon('bolt', 14)} ${L('前往宝箱商城', 'Chest Mall')}</button>
        <button class="btn btn-secondary btn-sm" id="btn-chest-go-free" type="button" style="width:100%;min-height:42px;">${icon('trophy', 14)} ${L('免费秒开青铜箱', 'Free Chest')}</button>
      </div>
    ` : `
      <div class="num-xs text-muted" style="margin-bottom:12px;">
        ${L('链上防刷校验：仅需连接链上已激活 TON 钱包（0 扣款），确认同行后立即获得可秒开的 200 A9 青铜新手箱。', 'On-chain anti-sybil check: active TON wallet required (0 transfer). Instantly unlocks your 200 A9 Bronze Starter Chest.')}
      </div>
      <button class="btn btn-primary" id="btn-do-chest-assist" type="button">
        ${icon(connected ? 'checkCircle' : 'wallet', 15)} ${connected ? L('确认同行 · 秒开我的 200 A9 青铜箱', 'Confirm Co-Op & Open 200 A9 Chest') : L('连接 TON 钱包 · 领双向开箱礼', 'Connect TON Wallet for Co-Op Gift')}
      </button>
    `}
  `);

  document.getElementById('chest-assist-close').onclick = closeModal;
  const retryBtn = document.getElementById('btn-retry-chest-detail');
  if (retryBtn) retryBtn.onclick = () => openChestAssistModal(chestId);
  const goMallBtn = document.getElementById('btn-chest-go-mall');
  if (goMallBtn) goMallBtn.onclick = () => { A9Haptic.light(); closeModal(); navigate('/internal/market'); };
  const goFreeBtn = document.getElementById('btn-chest-go-free');
  if (goFreeBtn) goFreeBtn.onclick = () => { A9Haptic.light(); closeModal(); navigate('/internal/market?tab=free'); };
  const btn = document.getElementById('btn-do-chest-assist');
  if (btn) btn.onclick = async () => {
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
        ? L('双向礼已生效！你的 200 A9 青铜新手箱已就绪，点击即可秒开！', 'Co-op gift active! Your 200 A9 Bronze Starter Chest is ready to open now!')
        : L('同行确认成功！', 'Co-op confirmed!'));
      navigate('/internal/market?tab=free');
    } catch (e) {
      A9Haptic.error();
      showToast(e?.message || L('同行确认失败，请确认已连接链上活跃钱包', 'Co-op failed; active wallet required'), 'amber');
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

let lastRuntimeErrAt = 0;
function handleRuntimeError(msg) {
  const now = Date.now();
  if (now - lastRuntimeErrAt < 6000) return;
  lastRuntimeErrAt = now;
  showToast(msg || L('页面遇到临时异常，可稍后重试', 'Temporary error occurred, please retry'), 'amber');
}
window.addEventListener('error', () => handleRuntimeError());
window.addEventListener('unhandledrejection', () => handleRuntimeError());

window.addEventListener('hashchange', renderCurrentRoute);
window.addEventListener('a9:force-sync', () => syncData({ forceRender: true }));
pendingTxManager.subscribe(() => syncPendingTxBanner());
window.addEventListener('a9:interaction-idle', flushDeferredRender);
document.addEventListener('focusout', () => setTimeout(flushDeferredRender, 0));
let displayLoopStarted = false;
let bootInFlight = false;
async function bootApp() {
  if (bootInFlight) return;
  bootInFlight = true;
  try {
    if (config.isDemo) {
      await store.ensureDemoReady();
    }
    await syncData({ forceRender: true });
    if (startParsed?.type === 'chest' && startParsed?.chestId) {
      openChestAssistModal(startParsed.chestId);
    }
    if (!displayLoopStarted) {
      displayLoopStarted = true;
      startDisplayLoop();
    }
    if (simDrawerEl && !simDrawerEl.classList.contains('hidden')) {
      openSimDrawer();
    }
  } catch (error) {
    lastLoadError = error;
    dataReady = false;
    const activeRoute = matchRoute(window.location.hash || '#/challenge').route;
    if (!ROUTES_ALLOW_WITHOUT_SNAPSHOT.has(activeRoute.path)) {
      renderDataError(error);
    }
    if (simDrawerEl && !simDrawerEl.classList.contains('hidden')) {
      openSimDrawer();
    }
  } finally {
    bootInFlight = false;
  }
}

bootApp();
if (!config.isDemo) {
  setInterval(() => {
    if (!document.hidden) syncData();
  }, config.pollMs);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncData();
  });
}
