import { peekDemoModule } from '../demo-loader.js';
/**
 * 战队与推广页（5e 精简重构）
 * - 首屏 ≤ 4 块、全页 ≤ 8 块；无行情条（.sw-battle-strip）、无废按钮（群广播未开放）、无卡片套卡片
 * - 概况卡（含队长创世金库 5,000 A9 进度）+ 唯一邀请主按钮（弹出合并海报与战报的分享面板）
 * - 返佣一行汇总（直链 #/rewards 我的奖励）+ 我的排名一行（成员榜默认折叠，无自循环链接）
 */

import { store } from '../store.js';
import { config } from '../config.js';
import {
  PROTOCOL_SPECS,
  joinTeam,
  bindTeamGroupTg,
  verifyTeamGroupTg,
  getEffectiveUserId,
  fetchUserPortfolio,
  fetchPromoBalance,
  fetchMyStakeReferrals,
  formatRoundA9,
  rawToA9,
} from '../data.js';
import { tonConnect, canonicalWalletKey } from '../tonconnect.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { escapeHtml, formatNum, showToast, copyText, openChoiceSheet, openActionSheet, openModal, closeModal } from '../components.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { renderReferralPoster, renderProofFlexPoster, renderStoryPoster, renderScenarioPoster, downloadPosterPng } from '../poster.js';
import {
  triggerStoryShare,
  buildTmaDeepLink,
  buildTeamInviteStartParam,
  buildBotAddGroupUrl,
  getBotHandle,
  isBotHandleConfigured,
  getShareRef,
  normalizeTeamId,
  isValidTeamId,
  openXShareSheet,
} from '../share.js';
import { buildBattleRallyCopy } from './round_stages.js';
import { fmtUsdOrDash } from '../quest/quest-ui.js';

function fmtA9OrDash(val, { loading = false } = {}) {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) {
    return loading ? '…' : '—';
  }
  return `${Number(val).toLocaleString('en-US', { maximumFractionDigits: 9 })} A9`;
}

function renderTeamStakeReferralCardHtml({ loading = false, error = null, data = null, inInvitePage = false } = {}) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const unbound = data && data.bound === false;

  let body = '';
  if (loading) {
    body = `<div class="num-xs text-muted">${L('返佣同步中…', 'Syncing rebates…')}</div>`;
  } else if (error) {
    body = `<div class="row-between" style="gap:8px;"><span class="num-xs text-red">${escapeHtml(error)}</span><button class="sw-retry-link" id="btn-retry-team-ref" type="button">${L('重试', 'Retry')}</button></div>`;
  } else if (!data || unbound) {
    body = `<div class="num-xs text-muted">${L('在 Telegram 内绑定钱包后查看返佣。', 'Link a wallet in Telegram to view rebates.')}</div>`;
  } else {
    body = `
      <div class="check-list" style="margin:6px 0 8px;">
        <div class="check-row">
          <span class="text-sec">${L('累计返佣', 'Total Credits')}</span>
          <b class="mono text-green">${formatRoundA9(data.totalCommissionRaw)}</b>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('已入账', 'Credited')}</span>
          <b class="mono">${formatRoundA9(data.creditedRaw)}</b>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('待入账', 'Pending')}</span>
          <b class="mono">${formatRoundA9(data.pendingRaw)}</b>
        </div>
      </div>
      ${items.length === 0
        ? `<div class="num-xs text-muted">${L('暂无记录', 'No rebates yet')}</div>`
        : `<div class="check-list">${items.slice(0, 5).map((it) => {
            const commissionText = formatRoundA9(it.commissionRaw);
            const isCred = String(it.status || '').toUpperCase() === 'CREDITED';
            return `
              <div class="check-row">
                <div style="min-width:0;">
                  <div class="num-xs" style="font-weight:700;">${L(`第 ${escapeHtml(String(it.roundId ?? '—'))} 轮`, `Round #${escapeHtml(String(it.roundId ?? '—'))}`)} · <span class="mono">${escapeHtml(it.refereeWallet || '—')}</span></div>
                  <div class="num-xs text-muted">${isCred ? L('已到账', 'Credited') : L('待入账', 'Pending')}</div>
                </div>
                <b class="mono text-green">${commissionText === '—' ? '—' : `+${commissionText}`}</b>
              </div>
            `;
          }).join('')}</div>`}
    `;
  }

  const actionLinkHtml = inInvitePage
    ? ''
    : `<a class="text-link-btn" href="#/team/invite">${L('明细', 'Details')} ›</a>`;

  return `
    <section class="card" id="team-stake-referral-card">
      <div class="row-between" style="margin-bottom:6px;gap:8px;">
        <span class="card-title">${icon('team', 15, 'text-gold')} ${L('好友通关 8% 返佣明细', '8% Pass Referral Details')}</span>
        ${actionLinkHtml}
      </div>
      ${body}
    </section>
  `;
}

function mountTeamStakeReferrals(root, { inInvitePage = false } = {}) {
  const mount = root.querySelector('#team-stake-referral-mount');
  if (!mount) return;
  if (!config.isDemo && !A9TMA.getRawInitData()) {
    mount.innerHTML = renderTeamStakeReferralCardHtml({ loading: false, data: null, inInvitePage });
    return;
  }
  mount.innerHTML = renderTeamStakeReferralCardHtml({ loading: true, inInvitePage });
  fetchMyStakeReferrals(20)
    .then((res) => {
      if (!mount.isConnected) return;
      mount.innerHTML = renderTeamStakeReferralCardHtml({ loading: false, data: res, inInvitePage });
    })
    .catch((e) => {
      if (!mount.isConnected) return;
      mount.innerHTML = renderTeamStakeReferralCardHtml({ loading: false, error: e?.message || L('读取失败', 'Read failed'), inInvitePage });
      const retryBtn = mount.querySelector('#btn-retry-team-ref');
      if (retryBtn) retryBtn.onclick = () => mountTeamStakeReferrals(root, { inInvitePage });
    });
}

function computeCaptainTodo({ tgMembers, memberCount, verified, rewardPaid }) {
  const hasTg = Number.isFinite(tgMembers) && tgMembers >= 50;
  const hasMembers = Number.isFinite(memberCount) && memberCount >= 3;
  const conditionMet = hasTg && hasMembers;

  if (!hasTg && !hasMembers) {
    return {
      conditionMet,
      needsTgAction: true,
      text: L('先绑定 ≥ 50 人 TG 群并招募至 3 名战队成员', 'Bind a 50+ member TG group and reach 3 squad members'),
      tgActionLabel: L('去绑定 TG 群', 'Bind TG Group'),
      done: false,
    };
  }
  if (!hasTg) {
    const need = Number.isFinite(tgMembers) ? Math.max(1, 50 - tgMembers) : 50;
    return {
      conditionMet,
      needsTgAction: true,
      text: L(`战队成员已满足，TG 群还差 ${need} 人（需 ≥ 50 人）`, `Squad size met · TG group needs ${need} more members`),
      tgActionLabel: L('管理 TG 群', 'Manage TG Group'),
      done: false,
    };
  }
  if (!hasMembers) {
    const need = Number.isFinite(memberCount) ? Math.max(1, 3 - memberCount) : 3;
    return {
      conditionMet,
      needsTgAction: false,
      text: L(`群规模已满足，战队还差 ${need} 名成员`, `Group size met · squad needs ${need} more member(s)`),
      tgActionLabel: L('管理 TG 群', 'Manage TG Group'),
      done: false,
    };
  }
  if (!verified) {
    return {
      conditionMet,
      needsTgAction: true,
      text: L('群规模与成员数已满足，立即发起群核验解锁 5,000 A9 创世金库', 'Requirements met · verify TG group to unlock 5,000 A9 vault'),
      tgActionLabel: L('发起群核验', 'Verify TG Group'),
      done: false,
    };
  }
  if (!rewardPaid) {
    return {
      conditionMet,
      needsTgAction: false,
      text: rewardPaid === null ? L('核验已通过，创世金库到账待核验', 'Verified · captain vault credit unconfirmed') : L('核验已通过，5,000 A9 创世金库待发放', 'Verified · 5,000 A9 captain vault pending payout'),
      tgActionLabel: L('管理 TG 群', 'Manage TG Group'),
      done: false,
    };
  }
  return {
    conditionMet,
    needsTgAction: false,
    text: L('5,000 A9 创世金库已到账，继续邀请好友扩充战队', '5,000 A9 captain vault credited · keep recruiting'),
    tgActionLabel: L('管理 TG 群', 'Manage TG Group'),
    done: true,
  };
}

/** 返佣一行汇总块（直链我的奖励 #/rewards，附海报/明细轻入口） */
function renderCommissionSummaryBlock(promoClaimableA9, { loading = false } = {}) {
  return `
    <div class="sw-menu-group" id="team-commission-summary">
      <a class="sw-menu-row" href="#/rewards">
        <span class="sw-row-icon is-amber" aria-hidden="true">${icon('trophy', 16)}</span>
        <div class="sw-menu-left">
          <span class="sw-menu-title">${L('返佣汇总', 'Referral Summary')}</span>
          <span class="sw-menu-sub">${L('商城 6% · 通关 8% · 前往我的奖励领取', '6% Mall · 8% Pass · Claim in My Rewards')}</span>
        </div>
        <div class="sw-menu-right">
          <span class="sw-menu-amount ${Number(promoClaimableA9) > 0 ? 'is-green' : (promoClaimableA9 == null ? 'is-muted' : '')}" style="white-space:nowrap;">${fmtA9OrDash(promoClaimableA9, { loading })}</span>
          <span class="sw-menu-arrow" aria-hidden="true">›</span>
        </div>
      </a>
      <a class="sw-menu-row" href="#/team/invite">
        <span class="sw-row-icon is-red" aria-hidden="true">${icon('qr', 16)}</span>
        <div class="sw-menu-left">
          <span class="sw-menu-title">${L('邀请海报与返佣明细', 'Invite Posters & Referral Log')}</span>
          <span class="sw-menu-sub">${L('保存高清海报、复制话术与查看 8% 通关记录', 'Download posters, copy pitch & view 8% records')}</span>
        </div>
        <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
      </a>
    </div>
  `;
}

/** 我的排名一行 + 默认折叠成员贡献排行（无 #/leaderboard 自循环、无卡片套卡片） */
function renderMyRankRowCard({ myRank = null, members = [], loading = false } = {}) {
  const list = Array.isArray(members) ? members : [];
  const rankDisplay = myRank !== null && myRank !== undefined && String(myRank).trim() !== ''
    ? String(myRank)
    : (loading ? '…' : '—');
  return `
    <section class="card col-gap" style="gap:8px;" id="team-ranking-card">
      <div class="row-between">
        <span class="card-title">${icon('trophy', 15, 'text-gold')} ${L('我的排名', 'My Rank')}</span>
        <strong class="mono num-sm" style="white-space:nowrap;">${escapeHtml(rankDisplay)}</strong>
      </div>
      <details class="rewards-secondary-fold" id="team-members-fold">
        <summary>${L('成员贡献排行', 'Member Rankings')}${list.length ? ` (${list.length})` : ''}</summary>
        <div class="check-list" style="margin-top:8px;">
          ${list.length === 0
            ? `<div class="num-xs text-muted" style="padding:4px 0;">${L('暂无成员贡献排行记录。', 'No member rankings yet.')}</div>`
            : list.map((m, i) => {
                const pos = m.rank || `#${String(i + 1).padStart(2, '0')}`;
                const val = m.ton ?? m.contribution ?? null;
                return `
                  <div class="check-row">
                    <span class="row-start" style="gap:8px;min-width:0;">
                      <span class="mono num-xs text-muted" style="font-weight:800;">${escapeHtml(String(pos))}</span>
                      <span class="mono num-xs" style="overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.addr || m.wallet || '—')}</span>
                    </span>
                    <b class="mono num-xs" style="white-space:nowrap;">${val !== null && val !== undefined && Number.isFinite(Number(val)) ? `${formatNum(val)} A9` : '—'}</b>
                  </div>
                `;
              }).join('')}
        </div>
      </details>
    </section>
  `;
}

function renderCaptainHomeHtml({
  squadName,
  tgMembers,
  memberCount,
  verified,
  rewardPaid,
  promoClaimableA9,
  topMembers = [],
  myRank = null,
  rolePill = '',
  loading = false,
}) {
  const todo = computeCaptainTodo({ tgMembers, memberCount, verified, rewardPaid });
  const tgVal = Number.isFinite(tgMembers) ? `${tgMembers} / 50` : '— / 50';
  const memVal = Number.isFinite(memberCount) ? `${memberCount} / 3` : '— / 3';
  const vaultStageText = rewardPaid
    ? L('已到账', 'Credited')
    : verified
      ? (rewardPaid === null ? L('待核验', 'Unconfirmed') : L('待发放', 'Pending'))
      : todo.conditionMet
        ? L('待群核验', 'Verify Group')
        : L('未达标', 'In Progress');

  return `
    <section class="card card-hero col-gap" id="team-overview-card">
      <div class="row-between" style="flex-wrap:wrap;gap:8px;">
        <div class="sw-squad-head">
          <span class="sw-squad-emblem" aria-hidden="true">${icon('squadEmblem', 24)}</span>
          <div class="sw-squad-meta">
            <h2 class="sw-squad-name">${escapeHtml(config.isDemo && squadName === 'A9 冒险战队' ? L('A9 冒险战队', 'A9 Quest Squad') : (squadName || L('我的战队', 'My Squad')))}</h2>
            <div class="num-xs text-muted">${L('队长 · 5,000 A9 创世金库进度', 'Captain · 5,000 A9 Captain Vault')}</div>
          </div>
        </div>
        ${rolePill}
      </div>

      <div class="check-list">
        <div class="check-row">
          <span class="text-sec">${L('TG 群人数（需 ≥ 50）', 'TG Group (≥ 50)')}</span>
          <a class="sw-retry-link mono" href="#/team/bind-tg" style="white-space:nowrap;">${escapeHtml(tgVal)} ›</a>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('战队成员（需 ≥ 3）', 'Squad Members (≥ 3)')}</span>
          <b class="mono ${Number.isFinite(memberCount) && memberCount >= 3 ? 'text-green' : ''}" style="white-space:nowrap;">${escapeHtml(memVal)}</b>
        </div>
        <div class="check-row">
          <span class="text-sec">${L('创世金库 5,000 A9', '5,000 A9 Vault')}</span>
          <b class="${rewardPaid ? 'text-green' : 'text-gold'}" style="white-space:nowrap;">${escapeHtml(vaultStageText)}</b>
        </div>
      </div>

      <div class="num-xs text-sec" style="line-height:1.5;">${escapeHtml(todo.text)}</div>

      <button class="btn btn-primary" id="btn-team-invite-share" type="button">${icon('send', 15)} ${L('邀请好友（海报 / 战报）', 'Invite Friends (Poster / Report)')}</button>
      ${todo.needsTgAction
        ? `<a class="btn btn-secondary btn-sm" href="#/team/bind-tg" style="width:100%;min-height:40px;">${icon('send', 13)} ${escapeHtml(todo.tgActionLabel)} ›</a>`
        : ''}
    </section>

    ${renderCommissionSummaryBlock(promoClaimableA9, { loading })}
    ${renderMyRankRowCard({ myRank, members: topMembers, loading })}
  `;
}

function renderMemberHomeHtml({
  squadName,
  validInvites,
  promoClaimableA9,
  topMembers = [],
  myRank = null,
  rolePill = '',
  loading = false,
  isDemo = false,
}) {
  return `
    <section class="card card-hero col-gap" id="team-overview-card">
      <div class="row-between" style="flex-wrap:wrap;gap:8px;">
        <div class="sw-squad-head">
          <span class="sw-squad-emblem" aria-hidden="true">${icon('squadEmblem', 24)}</span>
          <div class="sw-squad-meta">
            <h2 class="sw-squad-name">${escapeHtml(config.isDemo && squadName === 'A9 冒险战队' ? L('A9 冒险战队', 'A9 Quest Squad') : (squadName || L('我的战队', 'My Squad')))}</h2>
            <div class="num-xs text-muted">${L('战队成员', 'Squad Member')}</div>
          </div>
        </div>
        ${rolePill}
      </div>

      <div class="check-list">
        <div class="check-row">
          <span class="text-sec">${L('我的有效邀请', 'My Valid Invites')}</span>
          <b class="mono" style="white-space:nowrap;">${validInvites === null || validInvites === undefined ? (loading ? '…' : '—') : formatNum(validInvites)}</b>
        </div>
      </div>

      <button class="btn btn-primary" id="btn-team-invite-share" type="button">${icon('send', 15)} ${L('邀请好友（海报 / 战报）', 'Invite Friends (Poster / Report)')}</button>
      ${isDemo ? `<button class="btn btn-secondary btn-sm" id="btn-squad-more" type="button" style="width:100%;min-height:40px;">${icon('more', 15)} ${L('更多战队操作', 'More Squad Actions')}</button>` : ''}
    </section>

    ${renderCommissionSummaryBlock(promoClaimableA9, { loading })}
    ${renderMyRankRowCard({ myRank, members: topMembers, loading })}
  `;
}

function renderUnjoinedHomeHtml({
  inviteContext = null,
  rolePill = '',
  isLive = false,
  hasWallet = false,
  squads = [],
  promoClaimableA9 = null,
  loading = false,
}) {
  const needsConnect = isLive && !hasWallet;
  const overviewCard = inviteContext ? `
    <section class="card card-hero col-gap" id="team-overview-card">
      <div class="row-between" style="flex-wrap:wrap;gap:8px;">
        <div class="sw-squad-head">
          <span class="sw-squad-emblem" aria-hidden="true">${icon('squadEmblem', 24)}</span>
          <div class="sw-squad-meta">
            <h2 class="sw-squad-name">${escapeHtml(inviteContext.name || inviteContext.teamId || L('受邀战队', 'Invited Squad'))}</h2>
            <div class="num-xs text-muted">${L('来自好友邀请', 'From friend invite')}${inviteContext.referrer ? ` · ${escapeHtml(inviteContext.referrer)}` : ''}</div>
          </div>
        </div>
        ${rolePill}
      </div>
      <div class="num-xs text-sec">${L('确认后加入该战队，免费入队、无锁仓门槛。', 'Confirm to join this squad for free with no lock requirement.')}</div>
      ${needsConnect
        ? `<button class="btn btn-primary" id="team-live-connect" type="button">${icon('wallet', 15)} ${L('连接钱包加入战队', 'Connect Wallet to Join')}</button>`
        : (inviteContext.teamId
          ? `<button class="btn btn-primary" type="button" data-join-team="${escapeHtml(inviteContext.teamId)}">${L('确认加入战队', 'Confirm & Join')}</button>`
          : `<button class="btn btn-primary" id="btn-team-invite-share" type="button">${icon('send', 15)} ${L('邀请好友（海报 / 战报）', 'Invite Friends (Poster / Report)')}</button>`)}
    </section>
  ` : `
    <section class="card card-hero col-gap" id="team-overview-card">
      <div class="row-between" style="flex-wrap:wrap;gap:8px;">
        <div class="sw-squad-head">
          <span class="sw-squad-emblem" aria-hidden="true">${icon('squadEmblem', 24)}</span>
          <div class="sw-squad-meta">
            <h2 class="sw-squad-name">${L('加入战队', 'Join a Squad')}</h2>
            <div class="num-xs text-muted">${L('免费入队 · 队长享 5,000 A9 创世金库', 'Free to join · 5,000 A9 captain vault')}</div>
          </div>
        </div>
        ${rolePill}
      </div>
      <div class="num-xs text-sec" style="line-height:1.5;">${L('加入战队后可邀请好友共享 6% 商城直推与 8% 通关返佣，并查看成员贡献排行。', 'Join a squad to earn 6% mall + 8% pass referrals and track member rankings.')}</div>
      ${needsConnect
        ? `<button class="btn btn-primary" id="team-live-connect" type="button">${icon('wallet', 15)} ${L('连接钱包加入战队', 'Connect Wallet to Join')}</button>`
        : `<button class="btn btn-primary" id="btn-team-invite-share" type="button">${icon('send', 15)} ${L('邀请好友（海报 / 战报）', 'Invite Friends (Poster / Report)')}</button>`}
    </section>
  `;

  if (isLive) {
    return `
      ${overviewCard}
      <form class="card col-gap" id="live-join-team-form">
        <div class="card-title">${icon('team', 15, 'text-gold')} ${L('输入战队编号加入', 'Join by Squad ID')}</div>
        <label class="num-xs text-sec">${L('战队编号', 'Squad ID')}
          <input name="guild" class="input-box" style="width:100%;margin-top:4px;padding:8px 10px;" required maxlength="64" placeholder="TM-0001" value="${escapeHtml(inviteContext?.teamId || '')}">
        </label>
        <button class="btn btn-secondary" type="submit">${L('申请加入', 'Join Squad')}</button>
        <output class="num-xs text-red"></output>
      </form>
      ${renderCommissionSummaryBlock(promoClaimableA9, { loading })}
      ${renderMyRankRowCard({ myRank: null, members: [], loading })}
    `;
  }

  return `
    ${overviewCard}
    <section class="card col-gap" id="team-recommended-card">
      <div class="card-title">${icon('team', 15, 'text-red')} ${L('推荐战队', 'Recommended Squads')}</div>
      <div class="check-list">
        ${squads.map((s) => `
          <div class="check-row" style="padding:8px 0;">
            <div style="min-width:0;">
              <div class="num-sm" style="font-weight:800;">${escapeHtml(s.name)}</div>
              <div class="num-xs text-muted">${escapeHtml(s.lv)} · ${escapeHtml(s.members)} ${L('人', 'members')}</div>
            </div>
            <button class="btn btn-secondary btn-sm" type="button" data-join-team="${escapeHtml(s.id)}">${L('加入', 'Join')}</button>
          </div>
        `).join('')}
      </div>
    </section>
    ${renderCommissionSummaryBlock(promoClaimableA9, { loading })}
    ${renderMyRankRowCard({ myRank: null, members: [], loading })}
  `;
}

let teamRenderSeq = 0;
let activeRallyTpl = 'push';

function formatBindTeamError(err, fallback) {
  const msg = String(err?.message || err || '');
  if (/NOT_CAPTAIN|403/i.test(msg)) {
    return L('仅队长本人可操作，或该战队编号已被其他队长占用（如需建队请换一个新编号）', 'Captain only, or this Squad ID is already taken (pick a new ID to create a squad)');
  }
  if (/TEAM_SWITCH_COOLDOWN/i.test(msg)) {
    return L('换队冷却期内（7 天内不可切换或新建战队）', 'Squad switch cooldown active (7 days)');
  }
  if (/GROUP_ALREADY_BOUND/i.test(msg)) {
    return L('该电报群已绑定其他战队', 'This Telegram group is already bound to another squad');
  }
  return msg || fallback;
}

function getTeamInviteLink(teamId) {
  const shareRef = getShareRef();
  const startParam = buildTeamInviteStartParam(teamId, shareRef);
  return startParam ? buildTmaDeepLink(startParam) : '';
}

/** 合并「海报 + 战报」的战队邀请分享面板（取代页面内嵌大喊单卡） */
function openTeamInviteShareModal({ teamId = null, navigate = null, initialTab = 'report' } = {}) {
  let activeTab = initialTab === 'poster' ? 'poster' : 'report';
  let posterTpl = 'push';
  const inviteLink = getTeamInviteLink(teamId);

  const renderSheet = () => {
    const copyStr = buildBattleRallyCopy(store.state.round, inviteLink, activeRallyTpl);
    openModal(`
      <div class="sheet-handle"></div>
      <div class="row-between" style="padding:2px 0 8px;">
        <div class="card-title">${icon('send', 16, 'text-red')} ${L('邀请好友 · 战报与海报', 'Invite · Report & Poster')}</div>
        <button class="icon-btn" id="team-share-close" type="button" aria-label="${L('关闭', 'Close')}">${icon('x', 15)}</button>
      </div>
      <div class="seg-tabs" role="tablist" style="margin-bottom:10px;">
        <button type="button" class="seg-tab ${activeTab === 'report' ? 'active' : ''}" data-share-tab="report">${L('战报话术', 'Battle Report')}</button>
        <button type="button" class="seg-tab ${activeTab === 'poster' ? 'active' : ''}" data-share-tab="poster">${L('招募海报', 'Invite Poster')}</button>
      </div>
      ${activeTab === 'report' ? `
        <div class="seg-tabs" role="tablist" style="margin-bottom:8px;">
          <button type="button" class="seg-tab ${activeRallyTpl === 'push' ? 'active' : ''}" data-share-tpl="push">${L('冲线战报', 'Push')}</button>
          <button type="button" class="seg-tab ${activeRallyTpl === 'first6h' ? 'active' : ''}" data-share-tpl="first6h">${L('头矿 6H', 'First 6H')}</button>
          <button type="button" class="seg-tab ${activeRallyTpl === 'free' ? 'active' : ''}" data-share-tpl="free">${L('新人拉新', 'Starter')}</button>
        </div>
        <div class="share-copy-box" id="team-share-copy-preview" style="margin-bottom:10px;">${escapeHtml(copyStr)}</div>
        <div class="col-gap" style="gap:8px;">
          <button type="button" class="btn btn-primary" id="btn-modal-rally-copy">${icon('copy', 14)} ${L('复制战报与邀请链接', 'Copy Report & Link')}</button>
          <div class="grid-2" style="gap:8px;">
            <button type="button" class="btn btn-secondary btn-sm" id="btn-modal-rally-tg" style="width:100%;min-height:40px;">${icon('send', 13)} Telegram</button>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-modal-rally-x" style="width:100%;min-height:40px;">${icon('xBrand', 12)} X</button>
          </div>
        </div>
      ` : `
        <div class="seg-tabs" role="tablist" style="margin-bottom:8px;">
          <button type="button" class="seg-tab ${posterTpl === 'push' ? 'active' : ''}" data-poster-tpl="push">${L('冲价卡', 'Push')}</button>
          <button type="button" class="seg-tab ${posterTpl === 'chest' ? 'active' : ''}" data-poster-tpl="chest">${L('开箱卡', 'Chest')}</button>
          <button type="button" class="seg-tab ${posterTpl === 'win' ? 'active' : ''}" data-poster-tpl="win">${L('通关卡', 'Pass')}</button>
        </div>
        <canvas id="team-share-poster-canvas" class="poster-canvas" style="margin-bottom:10px;"></canvas>
        <div class="col-gap" style="gap:8px;">
          <button type="button" class="btn btn-primary" id="btn-modal-poster-dl">${icon('download', 14)} ${L('保存高清海报 PNG', 'Save Poster PNG')}</button>
          <button type="button" class="btn btn-secondary btn-sm" id="btn-modal-poster-tg" style="width:100%;min-height:40px;">${icon('send', 13)} ${L('转发至 Telegram', 'Share via Telegram')}</button>
        </div>
      `}
      <button type="button" class="sw-retry-link" id="btn-modal-open-invite-page" style="margin-top:10px;display:block;width:100%;text-align:center;">${L('打开完整海报与返佣明细页', 'Open Full Poster & Referral Page')} ›</button>
    `);

    const closeBtn = document.getElementById('team-share-close');
    if (closeBtn) closeBtn.onclick = closeModal;
    document.querySelectorAll('[data-share-tab]').forEach((b) => {
      b.onclick = () => {
        A9Haptic.light();
        activeTab = b.dataset.shareTab === 'poster' ? 'poster' : 'report';
        renderSheet();
      };
    });
    document.querySelectorAll('[data-share-tpl]').forEach((b) => {
      b.onclick = () => {
        A9Haptic.light();
        activeRallyTpl = b.dataset.shareTpl || 'push';
        renderSheet();
      };
    });
    document.querySelectorAll('[data-poster-tpl]').forEach((b) => {
      b.onclick = () => {
        A9Haptic.light();
        posterTpl = b.dataset.posterTpl || 'push';
        renderSheet();
      };
    });

    const copyBtn = document.getElementById('btn-modal-rally-copy');
    if (copyBtn) copyBtn.onclick = () => { A9Haptic.light(); copyText(copyStr, L('已复制战报与邀请链接', 'Copied report & link')); };
    const tgBtn = document.getElementById('btn-modal-rally-tg');
    if (tgBtn) tgBtn.onclick = () => { A9Haptic.light(); A9TMA.shareInvite(inviteLink, copyStr); showToast(L('已调起 Telegram 分享', 'Opened Telegram share')); };
    const xBtn = document.getElementById('btn-modal-rally-x');
    if (xBtn) {
      xBtn.onclick = () => {
        A9Haptic.light();
        const r = store.state.round || {};
        openXShareSheet({
          type: 'round',
          id: r.currentRound || 1,
          context: { roundId: r.currentRound, qualified: r.qualifiedCandles, required: r.minQualifiedCandles },
        });
      };
    }

    if (activeTab === 'poster') {
      const cv = document.getElementById('team-share-poster-canvas');
      if (cv) renderScenarioPoster(cv, posterTpl);
      const dlBtn = document.getElementById('btn-modal-poster-dl');
      if (dlBtn) {
        dlBtn.onclick = () => {
          A9Haptic.success();
          const fname = posterTpl === 'chest' ? 'A9-Unboxing-Card.png' : posterTpl === 'win' ? 'A9-Round-Pass-Card.png' : 'A9-Price-Push-Card.png';
          downloadPosterPng(cv, fname);
          showToast(L('高清海报已保存', 'Poster saved'));
        };
      }
      const pTgBtn = document.getElementById('btn-modal-poster-tg');
      if (pTgBtn) pTgBtn.onclick = () => { A9Haptic.light(); A9TMA.shareInvite(inviteLink, copyStr); showToast(L('已调起 Telegram 分享', 'Opened Telegram share')); };
    }

    const fullBtn = document.getElementById('btn-modal-open-invite-page');
    if (fullBtn) {
      fullBtn.onclick = () => {
        closeModal();
        if (typeof navigate === 'function') navigate('/team/invite');
        else window.location.hash = '#/team/invite';
      };
    }
  };

  renderSheet();
}

function renderSquadInvitation(root, navigate, teamId) {
  const demoSquads = config.isDemo ? (peekDemoModule()?.DEMO_SQUADS || []) : [];
  const squad = config.isDemo ? demoSquads.find(item => item.id === teamId) : null;
  const title = squad ? L(squad.zh, squad.en) : L('受邀战队', 'Invited Squad');
  const existingTeam = config.isDemo && store.state.team.role !== 'none' && store.state.team.id === teamId;
  root.innerHTML = `<section class="card card-hero col-gap">
    <div class="card-title">${L('战队邀请', 'Squad invitation')}</div>
    <h2>${escapeHtml(title)} <span class="mono">#${escapeHtml(teamId)}</span></h2>
    ${squad ? `<p>${L('战队成员', 'Members')} ${squad.memberCount} / ${squad.capacity}</p>` : ''}
    <button class="btn btn-primary" id="btn-accept-squad" type="button">${existingTeam ? L('查看我的战队', 'Open my squad') : L('确认加入', 'Confirm join')}</button>
    <p class="num-xs text-red" role="status" id="squad-invite-status"></p>
    <a class="btn btn-secondary" href="#/team">${L('返回战队', 'Back to squads')}</a>
  </section>`;
  const button = root.querySelector('#btn-accept-squad');
  button.onclick = async () => {
    if (existingTeam) { navigate('/team', { replace: true }); return; }
    const walletAddress = store.state.user.address;
    if (!config.isDemo && !walletAddress) {
      tonConnect.openConnectModal(() => {
        if (root.isConnected) renderSquadInvitation(root, navigate, teamId);
      });
      return;
    }
    button.disabled = true;
    try {
      if (config.isDemo) {
        store.update(state => { state.team.role = 'member'; state.team.id = teamId; });
      } else {
        await joinTeam({
          teamId, walletAddress, userId: getEffectiveUserId(store.state.user),
          referrerId: store.state.referral.referrerId,
        });
      }
      if (root.isConnected) navigate('/team', { replace: true });
    } catch (error) {
      if (!root.isConnected) return;
      root.querySelector('#squad-invite-status').textContent = error?.message || L('加入失败，请重试', 'Could not join. Try again.');
      button.disabled = false;
    }
  };
}

export function renderTeamHome(root, navigate, _param = null, query = {}) {
  if (typeof query.invite === 'string' && /^[A-Za-z0-9-]{1,48}$/.test(query.invite)) {
    renderSquadInvitation(root, navigate, query.invite);
    return;
  }
  if (!config.isDemo) {
    const seq = ++teamRenderSeq;
    const addr = store.state.user.address || null;
    const refId = store.state.referral?.referrerId || null;
    const inviteContext = refId ? { referrer: refId, teamId: refId.startsWith('TM-') ? refId : null } : null;

    const paintLive = ({ portfolio = null, promoClaimableA9 = null, loading = false, error = false } = {}) => {
      if (seq !== teamRenderSeq || !root.isConnected) return;
      const teamData = portfolio?.team || null;
      const isCaptain = Boolean(
        teamData && (
          teamData.role === 'captain' ||
          (addr && teamData.captainWallet && canonicalWalletKey(teamData.captainWallet) === canonicalWalletKey(addr))
        )
      );
      const myRank = teamData?.myRank != null ? `#${teamData.myRank}` : null;
      let bodyHtml = '';
      if (!teamData) {
        bodyHtml = renderUnjoinedHomeHtml({
          inviteContext,
          isLive: true,
          hasWallet: Boolean(addr),
          promoClaimableA9,
          loading,
        });
      } else if (isCaptain) {
        const tgCount = teamData.tgMemberCount ?? null;
        const memCount = teamData.memberCount ?? null;
        const verified = teamData.bindStatus === 'bound';
        const rewardPaid = teamData.captainVaultPaid ?? teamData.foundingBonusPaid ?? null;
        bodyHtml = renderCaptainHomeHtml({
          squadName: teamData.name,
          tgMembers: tgCount,
          memberCount: memCount,
          verified,
          rewardPaid,
          promoClaimableA9,
          topMembers: Array.isArray(teamData.topMembers) ? teamData.topMembers : [],
          myRank,
          loading,
        });
      } else {
        bodyHtml = renderMemberHomeHtml({
          squadName: teamData.name,
          validInvites: teamData.myValidInvites ?? null,
          promoClaimableA9,
          topMembers: Array.isArray(teamData.topMembers) ? teamData.topMembers : [],
          myRank,
          loading,
          isDemo: false,
        });
      }

      root.innerHTML = `
        <div class="col-gap anim-page-enter" id="team-home-root">
          ${bodyHtml}
          ${error ? `
            <div class="sw-menu-group">
              <div class="sw-menu-error" role="alert">
                <span>${L('部分战队数据读取失败', 'Some squad data failed to load')}</span>
                <button type="button" class="sw-retry-link" id="team-live-retry">${L('重试', 'Retry')}</button>
              </div>
            </div>
          ` : ''}
        </div>
      `;

      const connBtn = root.querySelector('#team-live-connect');
      if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderTeamHome(root, navigate));
      const retryBtn = root.querySelector('#team-live-retry');
      if (retryBtn) retryBtn.onclick = () => renderTeamHome(root, navigate);
      const inviteBtn = root.querySelector('#btn-team-invite-share');
      if (inviteBtn) inviteBtn.onclick = () => openTeamInviteShareModal({ teamId: teamData?.teamId || null, navigate });

      const form = root.querySelector('#live-join-team-form');
      if (form) {
        form.onsubmit = async (event) => {
          event.preventDefault();
          const wallet = store.state.user.address;
          if (!wallet) {
            tonConnect.openConnectModal(() => renderTeamHome(root, navigate));
            return;
          }
          const button = form.querySelector('button');
          button.disabled = true;
          try {
            await joinTeam({
              teamId: form.elements.guild.value.trim(),
              walletAddress: wallet,
              userId: getEffectiveUserId(store.state.user),
              referrerId: store.state.referral.referrerId,
            });
            renderTeamHome(root, navigate);
          } catch {
            form.querySelector('output').textContent = L('加入失败，请核对战队编号后重试', 'Join failed. Check the squad ID and retry.');
            button.disabled = false;
          }
        };
      }
      if (query?.action === 'rally') {
        openTeamInviteShareModal({ teamId: teamData?.teamId || null, navigate, initialTab: 'report' });
      }
    };

    paintLive({ loading: Boolean(addr) });

    if (addr) {
      Promise.allSettled([
        fetchUserPortfolio(addr),
        fetchPromoBalance(addr),
      ]).then(([portRes, promoRes]) => {
        if (seq !== teamRenderSeq || !root.isConnected || store.state.user.address !== addr) return;
        const portfolio = portRes.status === 'fulfilled' ? portRes.value : null;
        const promoData = promoRes.status === 'fulfilled' ? promoRes.value : null;
        const promoClaimableA9 = (promoData && promoData.claimableRaw !== undefined && promoData.claimableRaw !== null)
          ? rawToA9(promoData.claimableRaw)
          : null;
        paintLive({
          portfolio,
          promoClaimableA9,
          loading: false,
          error: portRes.status === 'rejected' || promoRes.status === 'rejected',
        });
      });
    }
    return;
  }

  const { team } = store.state;
  const role = team.role || 'captain';
  const roleLabels = {
    captain: L('队长', 'Captain'),
    member: L('队员', 'Member'),
    none: L('未加入', 'Lobby'),
  };
  const rolePill = `<button class="pill-trigger neutral" id="btn-role-sheet" type="button">${roleLabels[role] || roleLabels.none} ${icon('chevronDown', 12)}</button>`;
  const promoDemoA9 = Number(store.state.user.promoClaimableA9 ?? 0);

  let html = '';
  if (role === 'captain') {
    const tgMembers = Number.isFinite(Number(team.tgGroupMembers)) ? Number(team.tgGroupMembers) : 0;
    const memberCount = team.membersActive;
    html = renderCaptainHomeHtml({
      squadName: team.name,
      tgMembers,
      memberCount,
      verified: Boolean(team.tgGroupBound),
      rewardPaid: Boolean(team.tgGroupBound && tgMembers >= 50 && memberCount >= 3),
      promoClaimableA9: promoDemoA9,
      topMembers: team.topMembers || [],
      myRank: '#01',
      rolePill,
      loading: false,
    });
  } else if (role === 'member') {
    const demoSquads = peekDemoModule()?.DEMO_SQUADS || [];
    const squad = demoSquads.find(item => item.id === team.id);
    html = renderMemberHomeHtml({
      squadName: squad ? L(squad.zh, squad.en) : team.id,
      validInvites: team.directInvites ?? 16,
      promoClaimableA9: promoDemoA9,
      topMembers: team.topMembers || [],
      myRank: '#03',
      rolePill,
      loading: false,
      isDemo: true,
    });
  } else {
    const demoSquads = peekDemoModule()?.DEMO_SQUADS || [];
    const squads = demoSquads.map(squad => ({
      id: squad.id, name: L(squad.zh, squad.en), lv: 'Lv.' + squad.level,
      members: squad.memberCount + '/' + squad.capacity,
    }));
    const refId = store.state.referral?.referrerId || null;
    const inviteContext = refId ? { referrer: refId } : null;
    html = renderUnjoinedHomeHtml({
      inviteContext,
      rolePill,
      isLive: false,
      hasWallet: true,
      squads,
      promoClaimableA9: promoDemoA9,
    });
  }

  root.innerHTML = `<div class="col-gap anim-page-enter" id="team-home-root">${html}</div>`;

  const inviteBtn = root.querySelector('#btn-team-invite-share');
  if (inviteBtn) inviteBtn.onclick = () => openTeamInviteShareModal({ teamId: role !== 'none' ? team.id : null, navigate });
  if (query?.action === 'rally') {
    openTeamInviteShareModal({ teamId: role !== 'none' ? team.id : null, navigate, initialTab: 'report' });
  }

  const roleBtn = root.querySelector('#btn-role-sheet');
  if (roleBtn) {
    roleBtn.onclick = () => openChoiceSheet({
      title: L('切换战队身份 (演示)', 'Switch Squad Role (Demo)'),
      selected: role,
      options: [
        { value: 'captain', label: L('队长视图', 'Captain'), sub: L('创世金库进度与邀请', 'Captain vault & invites') },
        { value: 'member', label: L('队员视图', 'Member'), sub: L('有效邀请、返佣与排名', 'Valid invites, referrals & rank') },
        { value: 'none', label: L('未加入视图', 'Not Joined'), sub: L('查看邀请或选择战队加入', 'View invite or join a squad') },
      ],
      onSelect: (val) => {
        store.update((s) => { s.team.role = val; });
        renderTeamHome(root, navigate);
      },
    });
  }

  const squadMoreBtn = root.querySelector('#btn-squad-more');
  if (squadMoreBtn) {
    squadMoreBtn.onclick = () => openActionSheet({
      title: L('战队操作', 'Squad Actions'),
      subtitle: L('次级导航与退出操作已分区隔离', 'Navigation and leave action separated'),
      items: [
        {
          icon: 'qr',
          tone: 'is-red',
          label: L('邀请海报与返佣明细', 'Invite Posters & Referral Log'),
          sub: L('商城直推 6% · 通关返佣 8%', '6% mall · 8% pass credits'),
          onSelect: () => navigate('/team/invite'),
        },
        {
          icon: 'swap',
          tone: 'is-blue',
          label: L('切换战队', 'Switch Squad'),
          sub: L('返回未加入视图浏览其他战队', 'Return to lobby to pick another squad'),
          onSelect: () => {
            store.update((s) => { s.team.role = 'none'; });
            showToast(L('已回到未加入视图，可选择新战队', 'Browse squads to switch'));
            renderTeamHome(root, navigate);
          },
        },
      ],
      dangerItems: [
        {
          icon: 'x',
          tone: 'is-red',
          label: L('退出当前战队', 'Leave Current Squad'),
          sub: L('演示模式操作，退出后可重新加入', 'Demo action; you can rejoin anytime'),
          onSelect: () => {
            A9Haptic.warning();
            store.update((s) => { s.team.role = 'none'; });
            showToast(L('已退出当前战队', 'Left squad'), 'amber');
            renderTeamHome(root, navigate);
          },
        },
      ],
    });
  }

  root.querySelectorAll('[data-join-team]').forEach((b) => {
    b.onclick = () => {
      const tid = b.dataset.joinTeam;
      A9Haptic.success();
      store.update((s) => { s.team.role = 'member'; s.team.id = tid; });
      showToast(L(`已加入战队 #${tid}`, `Joined #${tid}`));
      renderTeamHome(root, navigate);
    };
  });
}

let teamProfileSeq = 0;

export function renderTeamProfile(root, navigate, id) {
  if (!config.isDemo) {
    const seq = ++teamProfileSeq;
    const addr = store.state.user.address || null;
    const safeId = id ? escapeHtml(id) : null;

    const paintLive = ({ loading = false, error = false, teamData = null } = {}) => {
      if (seq !== teamProfileSeq || !root.isConnected) return;
      const isCaptain = Boolean(
        teamData && (
          teamData.role === 'captain' ||
          (addr && teamData.captainWallet && canonicalWalletKey(teamData.captainWallet) === canonicalWalletKey(addr))
        )
      );
      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <section class="card card-hero col-gap">
            <div class="sw-squad-head">
              <span class="sw-squad-emblem" aria-hidden="true">${icon('squadEmblem', 24)}</span>
              <div class="sw-squad-meta">
                <h2 class="sw-squad-name">${escapeHtml(teamData?.name || (safeId ? `#${safeId}` : L('战队名片', 'Squad Card')))}</h2>
                <div class="num-xs text-muted">${teamData ? (isCaptain ? L('队长', 'Captain') : L('队员', 'Member')) : (addr ? (loading ? L('读取中…', 'Loading…') : L('尚未加入战队', 'Not in a squad')) : L('未连接钱包', 'Wallet not connected'))}</div>
              </div>
            </div>
            <div class="check-list">
              <div class="check-row">
                <span class="text-sec">${L('战队成员数', 'Squad Members')}</span>
                <b class="mono" style="white-space:nowrap;">${teamData?.memberCount != null ? formatNum(teamData.memberCount) : '—'}</b>
              </div>
              <div class="check-row">
                <span class="text-sec">${L('商城直推返佣', 'Mall Direct Referral')}</span>
                <b class="mono text-green" style="white-space:nowrap;">6%</b>
              </div>
              <div class="check-row">
                <span class="text-sec">${L('好友通关返佣', 'Pass Referral Credit')}</span>
                <b class="mono text-green" style="white-space:nowrap;">8%</b>
              </div>
            </div>
            ${error ? `
              <div class="sw-menu-error" role="alert">
                <span>${L('读取失败', 'Read failed')}</span>
                <button type="button" class="sw-retry-link" id="btn-tprof-retry">${L('重试', 'Retry')}</button>
              </div>
            ` : ''}
            ${!addr
              ? `<button class="btn btn-primary" id="btn-tprof-connect" type="button">${icon('wallet', 15)} ${L('连接钱包查看战队', 'Connect Wallet')}</button>`
              : `<a class="btn btn-primary" href="#/team">${icon('team', 15)} ${teamData ? L('进入我的战队', 'Open My Squad') : L('前往加入战队', 'Join a Squad')} ›</a>`}
          </section>

          <div class="sw-menu-group">
            <a class="sw-menu-row" href="#/team/invite">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('推广奖励与招募海报', 'Referral Rewards & Posters')}</span></div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
            <a class="sw-menu-row" href="#/team">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('返回战队', 'Back to Squad')}</span></div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
          </div>
        </div>
      `;
      const connBtn = root.querySelector('#btn-tprof-connect');
      if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderTeamProfile(root, navigate, id));
      const retryBtn = root.querySelector('#btn-tprof-retry');
      if (retryBtn) retryBtn.onclick = () => renderTeamProfile(root, navigate, id);
    };

    if (!addr) {
      paintLive({ loading: false });
      return;
    }
    paintLive({ loading: true });
    fetchUserPortfolio(addr)
      .then((res) => {
        if (seq !== teamProfileSeq || !root.isConnected || store.state.user.address !== addr) return;
        paintLive({ loading: false, teamData: id && id !== res?.team?.teamId ? null : res?.team || null });
      })
      .catch(() => {
        if (seq !== teamProfileSeq || !root.isConnected || store.state.user.address !== addr) return;
        paintLive({ loading: false, error: true });
      });
    return;
  }

  const selectedId = id || store.state.team.id;
  const demoSquads = peekDemoModule()?.DEMO_SQUADS || [];
  const squad = demoSquads.find(item => item.id === selectedId);
  const safeId = escapeHtml(selectedId);
  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <section class="card card-hero col-gap">
        <div class="sw-squad-head">
          <span class="sw-squad-emblem" aria-hidden="true">${icon('squadEmblem', 24)}</span>
          <div class="sw-squad-meta">
            <h2 class="sw-squad-name">${squad ? L(squad.zh, squad.en) : L('战队名片', 'Squad Card')}</h2>
            <div class="num-xs text-muted mono">#${safeId}${squad ? ` · Lv.${squad.level}` : ''}</div>
          </div>
        </div>
        <div class="check-list">
          <div class="check-row">
            <span class="text-sec">${L('战队成员', 'Members')}</span>
            <b class="mono" style="white-space:nowrap;">${squad?.memberCount ?? '—'}</b>
          </div>
          <div class="check-row">
            <span class="text-sec">${L('累计锁仓', 'Total Locked')}</span>
            <b class="mono" style="white-space:nowrap;">${squad?.lockedA9 != null ? formatNum(squad.lockedA9) + ' A9' : '—'}</b>
          </div>
          <div class="check-row">
            <span class="text-sec">${L('商城直推 / 通关返佣', 'Mall / Pass Referral')}</span>
            <b class="mono text-green" style="white-space:nowrap;">6% / 8%</b>
          </div>
        </div>
        <a class="btn btn-primary" href="#/team?invite=${encodeURIComponent(selectedId)}">${L('查看加入选项', 'View join options')}</a>
      </section>
      <div class="sw-menu-group">
        <a class="sw-menu-row" href="#/team">
          <div class="sw-menu-left"><span class="sw-menu-title">${L('返回战队', 'Back to Squad')}</span></div>
          <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
        </a>
      </div>
    </div>
  `;
}

export function renderBindTgGroup(root) {
  const { team } = store.state;
  const botHandle = getBotHandle();
  const botConfigured = isBotHandleConfigured();
  const addGroupUrl = buildBotAddGroupUrl();
  if (!config.isDemo) {
    let liveStatus = 'unbound';
    let lastMsg = botConfigured
      ? L(
          `尚未建队时，填写一个全新的战队编号（如 TM-MYTEAM，支持 TM-/TEAM-/G-/T- 开头）和群 @用户名即可自动创建战队并进入核验中；请将 @${botHandle} 拉入群并设为管理员后发起服务端核验。`,
          `To create a new squad, enter a new Squad ID (e.g. TM-MYTEAM; TM-/TEAM-/G-/T- prefix) and your TG @group handle. Add @${botHandle} as group admin, then run server verification.`
        )
      : L(
          '当前测试网未配置官方 Bot 句柄，暂不可完成建队绑群与服务端核验。',
          'Testnet Bot handle is not configured; squad creation and TG group verification are currently unavailable.'
        );
    const statusChip = {
      unbound: ['chip-muted', L('未绑定', 'Unbound')],
      verifying: ['chip-gold', L('核验中', 'Verifying')],
      bound: ['chip-green', L('已通过核验', 'Verified Bound')],
      expired: ['chip-red', L('权限已失效', 'Expired')],
    };
    const paintLive = () => {
      const [cls, txt] = statusChip[liveStatus] || statusChip.unbound;
      const isVerified = liveStatus === 'bound';
      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <section class="card card-hero col-gap">
            <div class="row-between">
              <span class="card-title">${icon('send', 15, 'text-gold')} ${L('创建战队 / Telegram 群核验', 'Create Squad & TG Group Verify')}</span>
              <span class="chip ${cls}" id="live-tg-bind-status">${txt}</span>
            </div>
            <div class="sw-status-steps" aria-label="${L('队长奖励三步状态', 'Captain 3-step status')}">
              <div class="sw-status-step ${isVerified ? 'is-done' : 'is-active'}">
                <small>${L('达到条件', 'Eligible')}</small>
                <strong>${L('≥50人·≥3成员', '≥50 TG · ≥3')}</strong>
              </div>
              <div class="sw-status-step ${isVerified ? 'is-done' : (liveStatus === 'verifying' ? 'is-active' : '')}">
                <small>${L('通过核验', 'Verified')}</small>
                <strong>${isVerified ? L('已通过', 'Passed') : L('待核验', 'Pending')}</strong>
              </div>
              <div class="sw-status-step ${isVerified ? 'is-active' : ''}">
                <small>${L('奖励到账', 'Credited')}</small>
                <strong>5,000 A9</strong>
              </div>
            </div>
            <div class="num-xs text-sec" id="live-tg-bind-msg" style="line-height:1.5;">${escapeHtml(lastMsg)}</div>
            ${botConfigured ? `
              <div class="grid-2" style="margin-top:2px;">
                <button type="button" class="btn btn-secondary btn-sm" id="btn-live-copy-bot">${icon('copy', 13)} ${L(`复制 @${botHandle}`, `Copy @${botHandle}`)}</button>
                <button type="button" class="btn btn-secondary btn-sm" id="btn-live-add-bot">${icon('send', 13)} ${L('拉 Bot 进群', 'Add Bot to Group')}</button>
              </div>
            ` : ''}
            <form id="live-tg-bind-form" class="col-gap">
              <label class="num-xs text-sec">${L('战队编号（填新编号即自动建队，格式：TM-XXXX）', 'Squad ID (enter a new ID to create, e.g. TM-XXXX)')}
                <input name="teamId" class="input-box" style="width:100%;margin-top:4px;padding:8px 10px;" placeholder="TM-0001" required maxlength="48" value="${escapeHtml(team.id || '')}" ${botConfigured ? '' : 'disabled'}>
              </label>
              <label class="num-xs text-sec">${L('Telegram 群组 @用户名', 'Telegram Group @handle')}
                <input name="tgGroupHandle" class="input-box" style="width:100%;margin-top:4px;padding:8px 10px;" placeholder="@your_guild_group" required maxlength="64" value="${escapeHtml(team.tgGroupHandle || '')}" ${botConfigured ? '' : 'disabled'}>
              </label>
              <div class="grid-2" style="margin-top:4px;">
                <button type="submit" class="btn btn-secondary" id="btn-live-submit-tg" ${botConfigured ? '' : 'disabled'}>${L('1. 提交进入核验中', '1. Submit Handle')}</button>
                <button type="button" class="btn btn-primary" id="btn-live-verify-tg" ${botConfigured ? '' : 'disabled'}>${L('2. 发起服务端核验', '2. Verify Now')}</button>
              </div>
            </form>
          </section>
          <div class="sw-menu-group">
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('1. 填写新编号建队 · 已有编号仅队长可改', '1. New ID Creates Squad · Existing ID is Captain-Only')}</span>
                <span class="sw-menu-sub">${L('需已验签绑定钱包；已被占用的编号会拒绝非队长提交（403）', 'Verified wallet required; taken IDs reject non-captains (403)')}</span>
              </div>
            </div>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L(`2. ${botConfigured ? `@${botHandle}` : '官方 Bot'} 入群且队长为管理员`, `2. ${botConfigured ? `@${botHandle}` : 'Official Bot'} + Captain Admin`)}</span>
                <span class="sw-menu-sub">${L('群 ≥50 人且战队 ≥3 成员核验通过后发放 5,000 A9（限 1 次）', '50+ TG members & ≥3 squad members earn 5,000 A9 once')}</span>
              </div>
            </div>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('3. 群唯一性与 7 天换队冷却', '3. Unique Group & 7-Day Switch Cooldown')}</span>
                <span class="sw-menu-sub">${L('同一真实群 ID 仅可绑定 1 个战队；换队冷却期内不可切换或新建战队', 'One tgChatId per squad; switching/creating blocked during 7-day cooldown')}</span>
              </div>
            </div>
            <a class="sw-menu-row" href="#/team">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('返回战队', 'Back to Squad')}</span></div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
          </div>
        </div>
      `;
      const copyBotBtn = root.querySelector('#btn-live-copy-bot');
      if (copyBotBtn && botHandle) copyBotBtn.onclick = () => copyText(`@${botHandle}`, L(`已复制 @${botHandle}`, `Copied @${botHandle}`));
      const addBotBtn = root.querySelector('#btn-live-add-bot');
      if (addBotBtn && addGroupUrl) addBotBtn.onclick = () => A9TMA.openExternalLink(addGroupUrl);
      const form = root.querySelector('#live-tg-bind-form');
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        if (!botConfigured) return;
        const tid = normalizeTeamId(form.elements.teamId.value);
        const handle = form.elements.tgGroupHandle.value.trim();
        if (!isValidTeamId(tid)) {
          lastMsg = L('战队编号格式无效，请使用 TM- / TEAM- / G- / T- 开头（如 TM-0001）', 'Invalid Squad ID format; use TM- / TEAM- / G- / T- prefix (e.g. TM-0001)');
          showToast(lastMsg, 'amber');
          paintLive();
          return;
        }
        if (!handle) return;
        const submitBtn = root.querySelector('#btn-live-submit-tg');
        submitBtn.disabled = true;
        try {
          const res = await bindTeamGroupTg({ teamId: tid, tgGroupHandle: handle });
          liveStatus = res?.bindStatus || 'verifying';
          lastMsg = L(`已提交群组信息，当前状态为「核验中」。请确保 @${botHandle} 已入群并设为管理员后点击右侧「发起服务端核验」。`, `Submitted. Status is verifying. Add @${botHandle} as admin and click Verify Now.`);
          showToast(L('已进入核验中（verifying）', 'Status: verifying'));
        } catch (e) {
          lastMsg = formatBindTeamError(e, L('提交失败，请确认已在 Telegram 内打开并已验证绑定队长钱包', 'Submission failed. Verify Telegram session & captain wallet.'));
          showToast(lastMsg, 'error');
        }
        paintLive();
      };
      root.querySelector('#btn-live-verify-tg').onclick = async () => {
        if (!botConfigured) return;
        const tid = normalizeTeamId(form.elements.teamId.value);
        if (!isValidTeamId(tid)) {
          showToast(L('请先填写有效的战队编号（如 TM-0001）', 'Enter a valid Squad ID first (e.g. TM-0001)'), 'amber');
          return;
        }
        const verifyBtn = root.querySelector('#btn-live-verify-tg');
        verifyBtn.disabled = true;
        try {
          const res = await verifyTeamGroupTg({ teamId: tid });
          liveStatus = res?.bindStatus || 'bound';
          lastMsg = L('服务端核验通过：Bot 在群内且队长群管理员权限有效。', 'Server verification passed: bot in group & captain admin role confirmed.');
          showToast(L('Telegram 群绑定核验通过', 'Group verification passed'));
        } catch (e) {
          if (liveStatus === 'bound') liveStatus = 'expired';
          lastMsg = formatBindTeamError(e, L('服务端核验未通过，请检查机器人入群与管理员权限', 'Verification failed. Check bot presence and admin permissions.'));
          showToast(lastMsg, 'error');
        }
        paintLive();
      };
    };
    paintLive();
    return;
  }
  let bindState = team.tgGroupBound ? 'bound' : 'unbound';
  const botLabel = botHandle ? `@${botHandle}` : L('官方 Bot', 'official Bot');
  const stateMeta = {
    bound:     { chip: 'chip-green', label: L('已绑定', 'Bound'),    desc: L('Bot 权限正常，整点收盘自动播报。', 'Bot active. Hourly pushes enabled.'), btn: L('重新校验', 'Re-verify') },
    unbound:   { chip: 'chip-muted', label: L('未绑定', 'Unbound'),  desc: L(`将 ${botLabel} 设为群管理员即可绑定。`, `Add ${botLabel} as admin to bind.`), btn: L('一键绑定 TG 群', 'Bind TG Group') },
    verifying: { chip: 'chip-gold',  label: L('验证中', 'Checking'), desc: L('正在校验管理员权限...', 'Verifying admin permissions...'), btn: L('刷新状态', 'Refresh') },
    expired:   { chip: 'chip-red',   label: L('已失效', 'Expired'),  desc: L('Bot 管理员权限已失效，请重新授权。', 'Admin rights revoked. Re-authorize.'), btn: L('恢复授权', 'Restore Access') }
  };

  const paint = () => {
    const meta = stateMeta[bindState];
    const condMet = Number(team.tgGroupMembers || 0) >= 50 && Number(team.membersActive || 0) >= 3;
    const isVerified = bindState === 'bound';
    const isPaid = condMet && isVerified;
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="seg-tabs">
          <button class="seg-tab ${bindState === 'bound' ? 'active' : ''}" data-bs="bound">${L('已绑定', 'Bound')}</button>
          <button class="seg-tab ${bindState === 'unbound' ? 'active' : ''}" data-bs="unbound">${L('未绑定', 'None')}</button>
          <button class="seg-tab ${bindState === 'verifying' ? 'active' : ''}" data-bs="verifying">${L('验证中', 'Check')}</button>
          <button class="seg-tab ${bindState === 'expired' ? 'active' : ''}" data-bs="expired">${L('失效', 'Lost')}</button>
        </div>
        <section class="card card-hero col-gap ${bindState === 'expired' ? 'card-glow-red' : ''}">
          <div class="row-between">
            <span class="card-title">${icon('send', 15, 'text-gold')} ${bindState === 'unbound' ? L('未关联群组', 'No Group') : escapeHtml(team.tgGroupHandle || '')}</span>
            <span class="chip ${meta.chip}">${meta.label}</span>
          </div>
          <div class="sw-status-steps">
            <div class="sw-status-step ${condMet ? 'is-done' : 'is-active'}">
              <small>${L('达到条件', 'Eligible')}</small>
              <strong>${condMet ? L('已达标', 'Met') : L('未达标', 'Pending')}</strong>
            </div>
            <div class="sw-status-step ${isVerified ? 'is-done' : (condMet ? 'is-active' : '')}">
              <small>${L('通过核验', 'Verified')}</small>
              <strong>${isVerified ? L('已通过', 'Passed') : L('待核验', 'Pending')}</strong>
            </div>
            <div class="sw-status-step ${isPaid ? 'is-done' : (isVerified ? 'is-active' : '')}">
              <small>${L('奖励到账', 'Credited')}</small>
              <strong>${isPaid ? L('已到账', 'Paid') : L('5,000 A9', '5,000 A9')}</strong>
            </div>
          </div>
          <div class="text-sec" style="font-size:12px;">${meta.desc}</div>
          <button class="btn btn-primary" id="btn-toggle-bind">${icon('refresh', 15)} ${meta.btn}</button>
        </section>
        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/team">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('返回战队', 'Back to Squad')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
        </div>
      </div>
    `;
    root.querySelectorAll('[data-bs]').forEach(b => { b.onclick = () => { A9Haptic.light(); bindState = b.dataset.bs; paint(); }; });
    root.querySelector('#btn-toggle-bind').onclick = () => {
      A9Haptic.success();
      bindState = 'bound';
      store.update(s => { s.team.tgGroupBound = true; });
      showToast(L('[演示] 模拟绑定状态，未连接真实 Telegram 群', '[Demo] Simulated state, no real Telegram group'));
      paint();
    };
  };
  paint();
}

export function renderInviteShare(root) {
  const { user, team } = store.state;
  let inviteLink = getTeamInviteLink(config.isDemo && team.role !== 'none' ? team.id : null);
  let template = 'push';
  let livePromo = null;
  let livePromoErr = null;
  let promoLoading = !config.isDemo && Boolean(user.address);

  const buildScenarioPitch = (tpl) => {
    const r = store.state.round || {};
    const roundLabel = r.currentRound ? L(`第 ${formatNum(r.currentRound)} 轮`, `Round ${formatNum(r.currentRound)}`) : L('涨价解锁', 'Price-Unlock');
    const targetText = fmtUsdOrDash(r.targetPrice);
    const targetLine = targetText === '—' ? '' : L(` 目标价 ${targetText}。`, ` Target ${targetText}.`);
    const amountText = formatRoundA9(r.rewardBudgetRaw);
    const poolLine = amountText === '—' ? '' : L(` 本轮奖池 ${amountText}。`, ` Round reward pool ${amountText}.`);
    const linkLine = inviteLink ? `\n${inviteLink}` : '';
    const { minStakeA9, passRequired, passTotal, referralPct, immediateUnlockPct, linearVestingDays } = PROTOCOL_SPECS;
    if (tpl === 'chest') {
      return L(
        `A9 宝箱商城 · 保底与随机加赠合并直发钱包。好友购箱返佣 ${referralPct}%。${linkLine}`,
        `A9 Chest Mall · Base and random bonus arrive together in your wallet. Earn ${referralPct}% on referred purchases.${linkLine}`
      );
    }
    if (tpl === 'win') {
      return L(
        `A9 ${roundLabel} · 通关后 ${immediateUnlockPct}% 奖金秒提，其余 ${linearVestingDays} 天逐秒解锁。${poolLine}${linkLine}`,
        `A9 ${roundLabel} · A pass unlocks ${immediateUnlockPct}% of rewards immediately. The rest unlocks over ${linearVestingDays} days.${poolLine}${linkLine}`
      );
    }
    return L(
      `A9 ${roundLabel} · ${minStakeA9} A9 起锁仓，${passRequired}/${passTotal} 段达标通关。${targetLine}${poolLine}${linkLine}`,
      `A9 ${roundLabel} · Lock from ${minStakeA9} A9. Pass with ${passRequired}/${passTotal} qualifying hourly slots.${targetLine}${poolLine}${linkLine}`
    );
  };

  if (!config.isDemo && user.address) {
    const addr = user.address;
    fetchUserPortfolio(addr).then(data => {
      if (!root.isConnected || addr !== store.state.user.address || !data?.team?.teamId) return;
      inviteLink = getTeamInviteLink(data.team.teamId);
      paint();
    }).catch(() => {});
  }

  const loadLivePromo = async () => {
    if (config.isDemo) return;
    const wallet = store.state.user.address;
    if (!wallet) return;
    promoLoading = true;
    try {
      livePromo = await fetchPromoBalance(wallet);
      livePromoErr = null;
    } catch (e) {
      livePromoErr = e?.message || L('暂无法读取推广余额', 'Promo balance unavailable');
    }
    promoLoading = false;
    if (root.isConnected) paint();
  };

  const paint = () => {
    const displayClaimable = config.isDemo ? fmtA9OrDash(store.state.user.promoClaimableA9) : formatRoundA9(livePromo?.claimableRaw);
    const displayClaimed = config.isDemo ? fmtA9OrDash(store.state.user.promoClaimedA9) : formatRoundA9(livePromo?.totalClaimedRaw);

    root.innerHTML = `
      <div class="col-gap anim-page-enter" id="team-invite-page">
        <section class="card card-hero col-gap">
          <span class="num-xs text-muted">${L('推广可领余额', 'Claimable referral balance')}</span>
          <div class="sw-asset-main">${displayClaimable === '—' ? (promoLoading ? '…' : '—') : `${displayClaimable.slice(0, -3)} <span class="sw-asset-main-unit">A9</span>`}</div>
          <div class="num-xs text-muted team-invite-paid">${L('累计已领', 'Total claimed')} <b class="mono">${displayClaimed}</b></div>
          ${!config.isDemo && livePromoErr ? `<div class="sw-menu-error" role="alert"><span>${escapeHtml(livePromoErr)}</span><button type="button" class="sw-retry-link" id="btn-promo-retry">${L('重试', 'Retry')}</button></div>` : ''}
          <a class="sw-menu-row" href="#/rewards" style="padding:10px 0 0;border-top:1px solid var(--card-border);">
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('去金库领取', 'Claim in Vault')}</span>
            </div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
        </section>

        <div>
          <div class="sw-section-label">${L('返佣来源', 'Rebate sources')}</div>
          <div class="sw-menu-group">
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('好友购箱', 'Chest purchases')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-amount is-green">${PROTOCOL_SPECS.referralPct}%</span></div>
            </div>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('好友通关奖金', 'Pass rewards')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-amount is-green">${PROTOCOL_SPECS.stakeReferralPct}%</span></div>
            </div>
          </div>
        </div>

        <div id="team-stake-referral-mount">${renderTeamStakeReferralCardHtml({ loading: true, inInvitePage: true })}</div>

        <div class="seg-tabs">
          <button class="seg-tab ${template === 'push' ? 'active' : ''}" data-tpl="push">${L('冲关', 'Round')}</button>
          <button class="seg-tab ${template === 'chest' ? 'active' : ''}" data-tpl="chest">${L('宝箱', 'Chests')}</button>
          <button class="seg-tab ${template === 'win' ? 'active' : ''}" data-tpl="win">${L('通关', 'Pass')}</button>
        </div>

        <div class="card">
          <canvas id="a9-poster-canvas" class="poster-canvas ${template === 'story' ? 'story-aspect' : ''}"></canvas>
          <div class="grid-2" style="margin-top:12px;">
            <button class="btn btn-primary" id="btn-dl-poster" style="min-height:46px;font-size:14px;">${icon('download', 15)} ${L('保存高清 PNG', 'Save PNG')}</button>
            <button class="btn btn-secondary" id="btn-tg-share" style="min-height:46px;font-size:14px;">${icon('send', 15)} ${L('转发 Telegram', 'Share TG')}</button>
          </div>
          <button class="btn btn-secondary" id="btn-tg-story-share" type="button" style="margin-top:10px;min-height:44px;font-size:14px;">${icon('story', 15)} ${L('一键发 TG Story', 'Post to TG Story')}</button>
        </div>

        <div class="card">
          <div class="row-between" style="margin-bottom:8px;">
            <span class="card-title">${icon('copy', 14, 'text-gold')} ${L('分享文案', 'Share text')}</span>
            <button class="pill-trigger" id="btn-copy-pitch" type="button">${L('复制全文', 'Copy')}</button>
          </div>
          <div class="share-copy-box">${escapeHtml(buildScenarioPitch(template))}</div>
        </div>

        ${config.isDemo ? `<div class="card">
          <div class="card-header">
            <span class="card-title">${icon('team', 15)} ${L('被邀请人列表 (18) · 演示样例', 'Invitees (18) · Demo sample')}</span>
            <span class="num-xs text-muted">${L('有效 16 人', '16 Valid')}</span>
          </div>
          <div class="col-gap">
            <div class="list-row"><div><div class="num-sm">UQ...8892</div><div class="num-xs text-muted">5,000 A9 · ${L('头矿 6H', 'First 6H')}</div></div><span class="chip chip-green">${L('已达标', 'Passed')}</span></div>
            <div class="list-row"><div><div class="num-sm">EQ...3312</div><div class="num-xs text-muted">2,000 A9 · ${L('头矿 6H', 'First 6H')}</div></div><span class="chip chip-gold">${L('12H 冲价中', '12H Push')}</span></div>
            <div class="list-row"><div><div class="num-sm">UQ...77ea</div><div class="num-xs text-muted">0 A9</div></div><span class="chip chip-muted">${L('待参与', 'Pending')}</span></div>
          </div>
        </div>` : `<div class="card">
          <div class="card-header"><span class="card-title">${icon('team', 15)} ${L('被邀请人列表', 'Invitees')}</span></div>
          <div class="num-xs text-muted">${L('暂无数据：真实邀请记录需服务端确认后显示。', 'No data yet: invite records appear after server confirmation.')}</div>
        </div>`}
      </div>
    `;

    const promoRetryBtn = root.querySelector('#btn-promo-retry');
    if (promoRetryBtn) promoRetryBtn.onclick = () => loadLivePromo();
    mountTeamStakeReferrals(root, { inInvitePage: true });

    const canvas = root.querySelector('#a9-poster-canvas');
    if (template === 'story') renderStoryPoster(canvas, { roundId: store.state.round.currentRound });
    else if (template === 'push' || template === 'chest' || template === 'win') renderScenarioPoster(canvas, template);
    else if (template === 'flex') renderProofFlexPoster(canvas, store.state.certificates[0]);
    else renderReferralPoster(canvas);

    root.querySelectorAll('[data-tpl]').forEach(b => {
      b.onclick = () => { A9Haptic.light(); template = b.dataset.tpl; paint(); };
    });

    const activePitch = buildScenarioPitch(template);
    root.querySelector('#btn-dl-poster').onclick = () => {
      A9Haptic.success();
      const name = template === 'story' ? 'A9-Story-9x16.png' : template === 'chest' ? 'A9-Unboxing-Card.png' : template === 'win' ? 'A9-Round-Pass-Card.png' : 'A9-Price-Push-Card.png';
      downloadPosterPng(canvas, name);
      showToast(L('高清海报已保存', 'Poster saved'));
    };
    const storyBtn = root.querySelector('#btn-tg-story-share');
    if (storyBtn) {
      storyBtn.onclick = () => {
        if (template !== 'story') {
          template = 'story';
          paint();
          const nextCanvas = root.querySelector('#a9-poster-canvas');
          triggerStoryShare({ canvas: nextCanvas, type: 'round', id: store.state.round.currentRound, filename: 'A9-Story-9x16.png' });
          return;
        }
        triggerStoryShare({ canvas, type: 'round', id: store.state.round.currentRound, filename: 'A9-Story-9x16.png' });
      };
    }
    root.querySelector('#btn-copy-pitch').onclick = () => copyText(activePitch, L('已复制群推话术', 'Copied pitch'));
    root.querySelector('#btn-tg-share').onclick = () => {
      A9Haptic.light();
      A9TMA.shareInvite(inviteLink, activePitch);
      showToast(L('已调起 Telegram 分享', 'Share opened'));
    };
  };

  paint();
  loadLivePromo();
}
