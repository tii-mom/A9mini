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

import { renderCity, gallery, rewards } from './pages/wealthverse.js';


export const ROUTES = [
  { path: '/challenge',           title: () => L('A9 广场', 'A9 Plaza'),           shell: 'tab',   tab: 'challenge',   ticker: false, render: renderCity },
  { path: '/round',               title: () => L('轮次闯关', 'Round Quest'),       shell: 'tab',   tab: 'round',       ticker: true,  render: renderChallengeHome },
  { path: '/gallery',             title: () => L('A9 进化图鉴', 'A9 Evolution Deck'), shell: 'stack', tab: 'challenge', render: gallery },
  { path: '/rewards',             title: () => L('奖金金库', 'Prize Vault'),       shell: 'stack', tab: 'profile',     render: rewards },
  { path: '/challenge/confirm',   title: () => t('rt_confirm'),                    shell: 'stack', tab: 'round',       ticker: false, render: renderParticipateConfirm },
  { path: '/challenge/success',   title: () => t('rt_success'),                    shell: 'stack', tab: 'round',       ticker: false, render: renderParticipateSuccess },
  { path: '/observation/records', title: () => L('24H 印章簿', '24H Stamp Log'),   shell: 'stack', tab: 'round',       ticker: false, render: renderObservationRecords },
  { path: '/warmup',              title: () => t('rt_warmup'),                     shell: 'stack', tab: 'challenge',   ticker: false, render: renderWarmupHome },
  { path: '/warmup/rank',         title: () => t('rt_warmup_rank'),                shell: 'stack', tab: 'challenge',   ticker: false, render: renderWarmupRank },
  { path: '/internal/market',     title: () => L('宝箱商城', 'Chest Mall'),        shell: 'stack', tab: 'challenge',   ticker: false, render: renderInternalMarket },
  { path: '/market',              title: () => L('宝箱商城', 'Chest Mall'),        shell: 'stack', tab: 'challenge',   ticker: false, render: renderInternalMarket },
  { path: '/internal/records',    title: () => t('rt_market_rec'),                 shell: 'stack', tab: 'challenge',   ticker: false, render: renderInternalRecords },
  { path: '/team',                title: () => L('A9 战队', 'A9 Squad'),           shell: 'tab',   tab: 'team',        ticker: false, render: renderTeamHome },
  { path: '/team/profile',        title: () => t('rt_team_profile'),               shell: 'stack', tab: 'team',        ticker: false, render: renderTeamProfile },
  { path: '/team/bind-tg',        title: () => t('rt_bind_tg'),                    shell: 'stack', tab: 'team',        ticker: false, render: renderBindTgGroup },
  { path: '/team/invite',         title: () => t('rt_invite'),                     shell: 'stack', tab: 'team',        ticker: false, render: renderInviteShare },
  { path: '/leaderboard',         title: () => t('tab_leaderboard'),               shell: 'stack', tab: 'team',        ticker: false, render: renderLeaderboard },
  { path: '/profile',             title: () => L('我的档案', 'My Profile'),        shell: 'tab',   tab: 'profile',     ticker: false, render: renderProfileHome },
  { path: '/claim',               title: () => t('rt_claim'),                      shell: 'stack', tab: 'profile',     ticker: false, render: renderClaimPage },
  { path: '/proof',               title: () => t('rt_proof'),                      shell: 'stack', tab: 'profile',     ticker: false, render: renderProofDetail },
  { path: '/renew',               title: () => t('rt_renew'),                      shell: 'stack', tab: 'profile',     ticker: false, render: renderRenewPage },
  { path: '/ledger',              title: () => t('rt_ledger'),                     shell: 'stack', tab: 'profile',     ticker: false, render: renderLedgerPage },
  { path: '/records',             title: () => t('rt_records'),                    shell: 'stack', tab: 'profile',     ticker: false, render: renderRecordsPage },
  { path: '/settings',            title: () => t('rt_settings'),                   shell: 'stack', tab: 'profile',     ticker: false, render: renderSettingsPage },
  { path: '/risk/matrix',         title: () => t('rt_risk_matrix'),                shell: 'stack', tab: 'profile',     ticker: false, render: renderRiskMatrix },
  { path: '/risk/audit',          title: () => t('rt_risk_audit'),                 shell: 'stack', tab: 'profile',     ticker: false, render: renderRiskAudit },
  { path: '/rules',               title: () => t('rt_rules'),                      shell: 'stack', tab: 'profile',     ticker: false, render: renderRulesPage }
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
  return { route: { path: '/404', title: () => '404', shell: 'stack', tab: 'challenge', ticker: false, render: renderNotFoundPage }, param: null, query };
}
