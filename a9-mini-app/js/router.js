/**
 * A9 Hash Router & Route Registry (DOC_3 Architecture + i18n Titles + /rules)
 */

import { t, L } from './i18n.js';



export const ROUTES = [
  { path: '/challenge',           title: () => L('A9 广场', 'A9 Plaza'),           shell: 'tab',   tab: 'challenge',   ticker: false, load: () => import('./pages/plaza.js').then(m => m.renderCity) },
  { path: '/round',               title: () => L('轮次闯关', 'Round Quest'),       shell: 'tab',   tab: 'round',       ticker: true,  load: () => import('./pages/round_hub.js').then(m => m.renderChallengeHome) },
  { path: '/gallery',             title: () => L('A9 角色档案', 'A9 Character Archive'), shell: 'stack', tab: 'profile', load: () => import('./pages/wealthverse.js').then(m => m.gallery) },
  { path: '/rewards',             title: () => L('奖金金库', 'Prize Vault'),       shell: 'stack', tab: 'profile',     load: () => import('./pages/wealthverse.js').then(m => m.rewards) },
  { path: '/challenge/confirm',   title: () => t('rt_confirm'),                    shell: 'stack', tab: 'round',       ticker: false, load: () => import('./pages/round_hub.js').then(m => m.renderParticipateConfirm) },
  { path: '/challenge/success',   title: () => t('rt_success'),                    shell: 'stack', tab: 'round',       ticker: false, load: () => import('./pages/round_hub.js').then(m => m.renderParticipateSuccess) },
  { path: '/observation/records', title: () => L('12H 印章簿', '12H Stamp Log'),   shell: 'stack', tab: 'round',       ticker: false, load: () => import('./pages/round_stages.js').then(m => m.renderObservationRecords) },
  { path: '/warmup',              title: () => t('rt_warmup'),                     shell: 'stack', tab: 'challenge',   ticker: false, load: () => import('./pages/warmup_market.js').then(m => m.renderWarmupHome) },
  { path: '/warmup/rank',         title: () => t('rt_warmup_rank'),                shell: 'stack', tab: 'challenge',   ticker: false, load: () => import('./pages/warmup_market.js').then(m => m.renderWarmupRank) },
  { path: '/internal/market',     title: () => L('宝箱商城', 'Chest Mall'),        shell: 'stack', tab: 'challenge',   ticker: false, load: () => import('./pages/warmup_market.js').then(m => m.renderInternalMarket) },
  { path: '/market',              title: () => L('宝箱商城', 'Chest Mall'),        shell: 'stack', tab: 'challenge',   ticker: false, load: () => import('./pages/warmup_market.js').then(m => m.renderInternalMarket) },
  { path: '/internal/records',    title: () => t('rt_market_rec'),                 shell: 'stack', tab: 'challenge',   ticker: false, load: () => import('./pages/warmup_market.js').then(m => m.renderInternalRecords) },
  { path: '/team',                title: () => L('A9 战队', 'A9 Squad'),           shell: 'tab',   tab: 'team',        ticker: false, load: () => import('./pages/team.js').then(m => m.renderTeamHome) },
  { path: '/team/profile',        title: () => t('rt_team_profile'),               shell: 'stack', tab: 'team',        ticker: false, load: () => import('./pages/team.js').then(m => m.renderTeamProfile) },
  { path: '/team/bind-tg',        title: () => t('rt_bind_tg'),                    shell: 'stack', tab: 'team',        ticker: false, load: () => import('./pages/team.js').then(m => m.renderBindTgGroup) },
  { path: '/team/invite',         title: () => t('rt_invite'),                     shell: 'stack', tab: 'team',        ticker: false, load: () => import('./pages/team.js').then(m => m.renderInviteShare) },
  { path: '/leaderboard',         title: () => t('tab_leaderboard'),               shell: 'stack', tab: 'team',        ticker: false, load: () => import('./pages/leaderboard.js').then(m => m.renderLeaderboard) },
  { path: '/profile',             title: () => L('我的档案', 'My Profile'),        shell: 'tab',   tab: 'profile',     ticker: false, load: () => import('./pages/profile.js').then(m => m.renderProfileHome) },
  { path: '/claim',               title: () => t('rt_claim'),                      shell: 'stack', tab: 'profile',     ticker: false, load: () => import('./pages/profile.js').then(m => m.renderClaimPage) },
  { path: '/proof',               title: () => t('rt_proof'),                      shell: 'stack', tab: 'profile',     ticker: false, load: () => import('./pages/profile.js').then(m => m.renderProofDetail) },
  { path: '/renew',               title: () => t('rt_settings'),                      shell: 'stack', tab: 'profile',     ticker: false, load: () => import('./pages/system.js').then(m => m.renderSettingsPage) },
  { path: '/ledger',              title: () => t('rt_ledger'),                     shell: 'stack', tab: 'profile',     ticker: false, load: () => import('./pages/profile.js').then(m => m.renderLedgerPage) },
  { path: '/records',             title: () => t('rt_records'),                    shell: 'stack', tab: 'profile',     ticker: false, load: () => import('./pages/profile.js').then(m => m.renderRecordsPage) },
  { path: '/settings',            title: () => t('rt_settings'),                   shell: 'stack', tab: 'profile',     ticker: false, load: () => import('./pages/system.js').then(m => m.renderSettingsPage) },
  { path: '/risk/matrix',         title: () => t('rt_risk_matrix'),                shell: 'stack', tab: 'profile',     ticker: false, load: () => import('./pages/system.js').then(m => m.renderRiskMatrix) },
  { path: '/risk/audit',          title: () => t('rt_risk_audit'),                 shell: 'stack', tab: 'profile',     ticker: false, load: () => import('./pages/system.js').then(m => m.renderRiskAudit) },
  { path: '/rules',               title: () => L('用户指南', 'User Guide'),                      shell: 'stack', tab: 'profile',     ticker: false, load: () => import('./pages/user-guide.js').then(m => m.renderUserGuide) }
];

export function matchRoute(rawPath) {
  const rawClean = (rawPath || '/challenge').replace(/^#/, '') || '/challenge';
  const qIdx = rawClean.indexOf('?');
  const clean = qIdx >= 0 ? (rawClean.slice(0, qIdx) || '/challenge') : rawClean;
  const query = qIdx >= 0 ? Object.fromEntries(new URLSearchParams(rawClean.slice(qIdx + 1)).entries()) : {};
  const exact = ROUTES.find(r => r.path === clean);
  if (exact) return { route: exact, param: null, query };
  const parts = clean.split('/').filter(Boolean);
  if (parts.length >= 2) {
    const prefix = '/' + parts.slice(0, -1).join('/');
    const param = parts[parts.length - 1];
    const hit = ROUTES.find(r => r.path === prefix);
    if (hit) return { route: hit, param, query };
  }
  if (clean === '/') return { route: ROUTES[0], param: null, query };
  return { route: { path: '/404', title: () => '404', shell: 'stack', tab: 'challenge', ticker: false, load: () => import('./pages/system.js').then(m => m.renderNotFoundPage) }, param: null, query };
}
