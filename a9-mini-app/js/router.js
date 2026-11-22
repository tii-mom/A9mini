/**
 * A9 Hash Router & Route Registry (DOC_3 Architecture + i18n Titles + /rules)
 */

import { renderChallengeHome, renderParticipateConfirm, renderParticipateSuccess } from './pages/round_hub.js';
import { renderObservationRecords } from './pages/round_stages.js';
import { renderWarmupHome, renderWarmupRank, renderInternalMarket, renderInternalRecords } from './pages/warmup_market.js';
import { renderTeamHome, renderTeamProfile, renderBindTgGroup, renderInviteShare } from './pages/team.js';
import { renderLeaderboard } from './pages/leaderboard.js';
import { renderProfileHome, renderClaimPage, renderProofDetail, renderRenewPage, renderLedgerPage, renderRecordsPage } from './pages/profile.js';
import { renderSettingsPage, renderRiskMatrix, renderRiskAudit, renderRulesPage, renderNotFoundPage } from './pages/system.js';
import { t, L } from './i18n.js';

import { city, gallery, rewards } from './pages/wealthverse.js';


export const ROUTES = [
  { path: '/challenge',           title: () => L('财富主城','Wealth City'),    shell: 'tab',   tab: 'challenge',   ticker: false, render: root => { root.innerHTML = city(); } },
  { path: '/round', title: () => L('轮次挑战','Round Challenge'), shell: 'stack', tab: 'challenge', render: renderChallengeHome },
  { path: '/gallery', title: () => L('身份图鉴','Identity Gallery'), shell: 'stack', tab: 'challenge', render: gallery },
  { path: '/rewards', title: () => L('奖励宝库','Reward Vault'), shell: 'stack', tab: 'profile', render: rewards },
  { path: '/challenge/confirm',   title: () => t('rt_confirm'),     shell: 'stack', tab: 'challenge',   ticker: false, render: renderParticipateConfirm },
  { path: '/challenge/success',   title: () => t('rt_success'),     shell: 'stack', tab: 'challenge',   ticker: false, render: renderParticipateSuccess },
  { path: '/observation/records', title: () => L('24H 时段记录', '24H Slot Records'), shell: 'stack', tab: 'challenge', ticker: false, render: renderObservationRecords },
  { path: '/warmup',              title: () => t('rt_warmup'),      shell: 'stack', tab: 'challenge',   ticker: false, render: renderWarmupHome },
  { path: '/warmup/rank',         title: () => t('rt_warmup_rank'), shell: 'stack', tab: 'challenge',   ticker: false, render: renderWarmupRank },
  { path: '/internal/market',     title: () => 'A9 // MARKET',      shell: 'tab',   tab: 'market',      ticker: false, render: renderInternalMarket },
  { path: '/internal/records',    title: () => t('rt_market_rec'),  shell: 'stack', tab: 'market',      ticker: false, render: renderInternalRecords },
  { path: '/team',                title: () => 'A9 // SYNDICATE',   shell: 'tab',   tab: 'team',        ticker: false, render: renderTeamHome },
  { path: '/team/profile',        title: () => t('rt_team_profile'),shell: 'stack', tab: 'team',        ticker: false, render: renderTeamProfile },
  { path: '/team/bind-tg',        title: () => t('rt_bind_tg'),     shell: 'stack', tab: 'team',        ticker: false, render: renderBindTgGroup },
  { path: '/team/invite',         title: () => t('rt_invite'),      shell: 'stack', tab: 'team',        ticker: false, render: renderInviteShare },
  { path: '/leaderboard',         title: () => t('tab_leaderboard'),shell: 'stack', tab: 'team',        ticker: false, render: renderLeaderboard },
  { path: '/profile',             title: () => 'A9 // VAULT',       shell: 'tab',   tab: 'profile',     ticker: false, render: renderProfileHome },
  { path: '/claim',               title: () => t('rt_claim'),       shell: 'stack', tab: 'profile',     ticker: false, render: renderClaimPage },
  { path: '/proof',               title: () => t('rt_proof'),       shell: 'stack', tab: 'profile',     ticker: false, render: renderProofDetail },
  { path: '/renew',               title: () => t('rt_renew'),       shell: 'stack', tab: 'profile',     ticker: false, render: renderRenewPage },
  { path: '/ledger',              title: () => t('rt_ledger'),      shell: 'stack', tab: 'profile',     ticker: false, render: renderLedgerPage },
  { path: '/records',             title: () => t('rt_records'),     shell: 'stack', tab: 'profile',     ticker: false, render: renderRecordsPage },
  { path: '/settings',            title: () => t('rt_settings'),    shell: 'stack', tab: 'profile',     ticker: false, render: renderSettingsPage },
  { path: '/risk/matrix',         title: () => t('rt_risk_matrix'), shell: 'stack', tab: 'profile',     ticker: false, render: renderRiskMatrix },
  { path: '/risk/audit',          title: () => t('rt_risk_audit'),  shell: 'stack', tab: 'profile',     ticker: false, render: renderRiskAudit },
  { path: '/rules',               title: () => t('rt_rules'),       shell: 'stack', tab: 'profile',     ticker: false, render: renderRulesPage }
];

export function matchRoute(rawPath) {
  const clean = (rawPath || '/challenge').replace(/^#/, '') || '/challenge';
  const exact = ROUTES.find(r => r.path === clean);
  if (exact) return { route: exact, param: null };
  const parts = clean.split('/').filter(Boolean);
  if (parts.length >= 2) {
    const prefix = '/' + parts.slice(0, -1).join('/');
    const param = parts[parts.length - 1];
    const hit = ROUTES.find(r => r.path === prefix);
    if (hit) return { route: hit, param };
  }
  if (clean === '/') return { route: ROUTES[0], param: null };
  return { route: { path: '/404', title: () => '404', shell: 'stack', tab: 'challenge', ticker: false, render: renderNotFoundPage }, param: null };
}
