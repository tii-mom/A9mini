/**
 * A9 Hash Router & Route Registry (v3 IA — 命名统一与路由收敛)
 *
 * 规范可见一级 / 二级路由严格收敛至 ≤ 12 个；
 * 历史深链与旧路径统一通过 ROUTE_ALIASES 在导航/渲染层平滑收敛，保留 query 与锚点，
 * 不破坏 parseStartParam() 与 matchRoute('#/round?panel=prediction') 既有契约。
 */

import { t, L } from './i18n.js';

const CSS_GAME = './css/game.css?v=17.1-rc1';
const CSS_WEALTHVERSE = './css/wealthverse.css?v=17.1-rc1';
const CSS_ANIM = './css/animations.css?v=17.1-rc1';
const CSS_FULL = [CSS_GAME, CSS_WEALTHVERSE, CSS_ANIM];

/** 仅包含旧路由别名（规范路径本身绝不出现于此表，防止重定向自循环）。 */
export const ROUTE_ALIASES = Object.freeze({
  '/challenge':           Object.freeze({ target: '/round' }),
  '/claim':               Object.freeze({ target: '/rewards' }),
  '/renew':               Object.freeze({ target: '/settings' }),
  '/ledger':              Object.freeze({ target: '/records', defaultQuery: Object.freeze({ type: 'ledger' }) }),
  '/internal/records':    Object.freeze({ target: '/records', defaultQuery: Object.freeze({ type: 'market' }) }),
  '/risk/matrix':         Object.freeze({ target: '/rules', anchor: 'matrix' }),
  '/risk/audit':          Object.freeze({ target: '/rules', anchor: 'audit' }),
  '/warmup':              Object.freeze({ target: '/round', defaultQuery: Object.freeze({ stage: 'warmup' }) }),
  '/warmup/rank':         Object.freeze({ target: '/round', defaultQuery: Object.freeze({ stage: 'warmup' }) }),
  '/observation/records': Object.freeze({ target: '/round', defaultQuery: Object.freeze({ stage: 'charge' }) }),
  '/leaderboard':         Object.freeze({ target: '/team' }),
  '/gallery':             Object.freeze({ target: '/profile' }),
  '/internal/market':     Object.freeze({ target: '/market' }),
  '/team/profile':        Object.freeze({ target: '/team' }),
});

/** 规范路由表：12 个可见一级/二级路由 + 2 个详情/结果二级页（isDetail: true，不计入上限）。 */
export const ROUTES = [
  // 4 主 Tab（业主定案：冲关 / 金库 / 宝箱 / 战队）
  { path: '/round',             title: () => L('冲关', 'Quest'),                        shell: 'tab',   tab: 'round',     ticker: false, styles: CSS_FULL, load: () => import('./quest/stage-view.js').then(m => m.renderStageView) },
  { path: '/rewards',           title: () => L('金库', 'Vault'),                        shell: 'tab',   tab: 'rewards',   ticker: false, styles: CSS_FULL, load: () => import('./quest/vault-view.js').then(m => m.renderVaultView) },
  { path: '/market',            title: () => L('宝箱', 'Chest'),                        shell: 'tab',   tab: 'market',    ticker: false, styles: CSS_FULL, load: () => import('./quest/chest-view.js').then(m => m.renderInternalMarket) },
  { path: '/team',              title: () => L('战队', 'Squad'),                        shell: 'tab',   tab: 'team',      ticker: false, styles: CSS_FULL, load: () => import('./quest/team-view.js').then(m => m.renderTeamView) },

  // 可见二级规范路由（原「我的」全部功能由顶栏入口可达且 100% 兼容历史深链）
  { path: '/profile',           title: () => L('我的', 'Me'),                           shell: 'stack', tab: 'round',     ticker: false, styles: CSS_FULL, load: () => import('./pages/profile.js').then(m => m.renderProfileHome) },
  { path: '/records',           title: () => L('记录', 'Records'),                      shell: 'stack', tab: 'round',     ticker: false, styles: CSS_FULL, load: () => import('./pages/profile.js').then(m => m.renderRecordsPage) },
  { path: '/rules',             title: () => L('规则与透明', 'Rules & Transparency'),    shell: 'stack', tab: 'round',     ticker: false, styles: CSS_FULL, load: () => import('./pages/user-guide.js').then(m => m.renderUserGuide) },
  { path: '/settings',          title: () => L('设置', 'Settings'),                     shell: 'stack', tab: 'round',     ticker: false, styles: CSS_FULL, load: () => import('./pages/system.js').then(m => m.renderSettingsPage) },
  { path: '/team/invite',       title: () => t('rt_invite'),                            shell: 'stack', tab: 'team',      ticker: false, styles: CSS_FULL, load: () => import('./pages/team.js').then(m => m.renderInviteShare) },
  { path: '/team/bind-tg',      title: () => t('rt_bind_tg'),                           shell: 'stack', tab: 'team',      ticker: false, styles: CSS_FULL, load: () => import('./pages/team.js').then(m => m.renderBindTgGroup) },
  { path: '/challenge/confirm', title: () => t('rt_confirm'),                           shell: 'stack', tab: 'round',     ticker: false, styles: CSS_FULL, load: () => import('./pages/round_hub.js').then(m => m.renderParticipateConfirm) },

  // 详情 / 结果二级页（不计入可见一级/二级路由上限）
  { path: '/proof',             title: () => L('闯关凭证', 'Quest Pass'),                shell: 'stack', tab: 'round',     ticker: false, styles: CSS_FULL, isDetail: true, load: () => import('./pages/profile.js').then(m => m.renderProofDetail) },
  { path: '/challenge/success', title: () => t('rt_success'),                           shell: 'stack', tab: 'round',     ticker: false, styles: CSS_FULL, isDetail: true, load: () => import('./pages/round_hub.js').then(m => m.renderParticipateSuccess) },
];

export const VISIBLE_ROUTES = Object.freeze(ROUTES.filter(r => !r.isDetail));

const loadedRouteHandlers = new Map();
const loadingRouteHandlers = new Map();

export function getCachedRouteHandler(route) {
  if (!route?.path) return null;
  return loadedRouteHandlers.get(route.path) || null;
}

export function loadRouteHandler(route) {
  if (!route || typeof route.load !== 'function') {
    return Promise.reject(new Error('Invalid route loader'));
  }
  const key = route.path;
  const cached = loadedRouteHandlers.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = loadingRouteHandlers.get(key);
  if (pending) return pending;
  const promise = Promise.resolve()
    .then(() => route.load())
    .then((handler) => {
      loadedRouteHandlers.set(key, handler);
      loadingRouteHandlers.delete(key);
      return handler;
    })
    .catch((err) => {
      loadingRouteHandlers.delete(key);
      throw err;
    });
  loadingRouteHandlers.set(key, promise);
  return promise;
}

function splitHashParts(rawPath) {
  const incoming = String(rawPath || '/round').replace(/^#/, '') || '/round';
  const telegramLaunch = incoming.startsWith('tgWebApp')
    && new URLSearchParams(incoming).has('tgWebAppData');
  if (telegramLaunch) {
    return { telegramLaunch: true, clean: '/round', queryStr: '', query: {}, anchor: '' };
  }
  const anchorIdx = incoming.indexOf('#');
  const beforeAnchor = anchorIdx >= 0 ? incoming.slice(0, anchorIdx) : incoming;
  const anchor = anchorIdx >= 0 ? incoming.slice(anchorIdx + 1) : '';
  const qIdx = beforeAnchor.indexOf('?');
  const clean = qIdx >= 0 ? (beforeAnchor.slice(0, qIdx) || '/round') : (beforeAnchor || '/round');
  const queryStr = qIdx >= 0 ? beforeAnchor.slice(qIdx + 1) : '';
  const query = queryStr ? Object.fromEntries(new URLSearchParams(queryStr).entries()) : {};
  return { telegramLaunch: false, clean, queryStr, query, anchor };
}

function findAliasSpec(cleanPath) {
  if (Object.prototype.hasOwnProperty.call(ROUTE_ALIASES, cleanPath)) {
    return ROUTE_ALIASES[cleanPath];
  }
  // 兼容带参数的旧图鉴深链：/gallery/:id → /profile
  if (cleanPath.startsWith('/gallery/')) {
    return ROUTE_ALIASES['/gallery'];
  }
  return null;
}

/**
 * 解析旧路由别名：仅命中 ROUTE_ALIASES 时返回规范重定向目标（保留 query 与锚点）；
 * 规范路径和 Telegram 启动片段返回 null，保证绝无重定向自循环。
 */
export function resolveRouteAlias(rawPath) {
  const { telegramLaunch, clean, queryStr, anchor } = splitHashParts(rawPath);
  if (telegramLaunch) return null;
  const spec = findAliasSpec(clean);
  if (!spec) return null;

  const mergedParams = new URLSearchParams();
  if (spec.defaultQuery) {
    for (const [k, v] of Object.entries(spec.defaultQuery)) {
      mergedParams.set(k, String(v));
    }
  }
  if (queryStr) {
    for (const [k, v] of new URLSearchParams(queryStr).entries()) {
      mergedParams.set(k, v);
    }
  }
  const finalAnchor = anchor || spec.anchor || '';
  const qs = mergedParams.toString();
  const targetPath = `${spec.target}${qs ? `?${qs}` : ''}${finalAnchor ? `#${finalAnchor}` : ''}`;
  return {
    from: clean,
    target: spec.target,
    to: `#${targetPath}`,
    fullPath: targetPath,
    anchor: finalAnchor,
  };
}

export function matchRoute(rawPath) {
  // Telegram places its launch envelope in the fragment before an app route exists.
  // Treat that envelope as the quest home, without rewriting it: the Telegram SDK still
  // needs the original launch data, and unknown application routes must stay 404.
  const parts0 = splitHashParts(rawPath);
  let clean = parts0.clean;
  let query = { ...parts0.query };
  let anchor = parts0.anchor;

  const aliasSpec = parts0.telegramLaunch ? null : findAliasSpec(clean);
  if (aliasSpec) {
    clean = aliasSpec.target;
    if (aliasSpec.defaultQuery) {
      query = { ...aliasSpec.defaultQuery, ...query };
    }
    if (!anchor && aliasSpec.anchor) {
      anchor = aliasSpec.anchor;
    }
  }

  const exact = ROUTES.find(r => r.path === clean);
  if (exact) return { route: exact, param: null, query, anchor };
  const parts = clean.split('/').filter(Boolean);
  if (parts.length >= 2) {
    const prefix = '/' + parts.slice(0, -1).join('/');
    const param = parts[parts.length - 1];
    const hit = ROUTES.find(r => r.path === prefix);
    if (hit) return { route: hit, param, query, anchor };
  }
  if (clean === '/') return { route: ROUTES[0], param: null, query, anchor };
  return {
    route: { path: '/404', title: () => '404', shell: 'stack', tab: 'round', ticker: false, styles: CSS_FULL, load: () => import('./pages/system.js').then(m => m.renderNotFoundPage) },
    param: null,
    query,
    anchor,
  };
}
