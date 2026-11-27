import { peekDemoModule } from '../demo-loader.js';
/**
 * 战队与推广页 — 任天堂 Switch 视觉与交互统一升级
 * - 统一战队队徽，彻底区分「未加入 / 队员 / 队长」三种首屏
 * - 队长任务严格拆开「达到条件 / 通过核验 / 奖励到账」三独立状态
 * - 6% 商城直推与 8% 好友通关返佣分写进各自奖励明细，首页不拼混合比例
 */

import { store } from '../store.js';
import { config } from '../config.js';
import {
  joinTeam,
  bindTeamGroupTg,
  verifyTeamGroupTg,
  getEffectiveUserId,
  fetchUserPortfolio,
  fetchPromoBalance,
  fetchPromoClaim,
  requestPromoClaimIntent,
  fetchMyStakeReferrals,
  rawToA9,
} from '../data.js';
import { tonConnect, canonicalWalletKey } from '../tonconnect.js';

function formatExactGramFromNano(nano) {
  const v = BigInt(String(nano || '0'));
  const whole = v / 1_000_000_000n;
  const frac = String(v % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}
import { pendingTxManager } from '../tx-ux.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { escapeHtml, formatNum, formatTimer, showToast, copyText, openChoiceSheet, openActionSheet } from '../components.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { renderReferralPoster, renderProofFlexPoster, renderStoryPoster, renderScenarioPoster, downloadPosterPng } from '../poster.js';
import { triggerStoryShare, buildTmaDeepLink, getShareRef, openXShareSheet } from '../share.js';
import { computeRoundPriceMetrics, buildBattleRallyCopy } from './round_stages.js';
import { deriveRoundUiState } from '../round-state.js';
import { serverNowMs } from '../data.js';

function fmtA9OrDash(val, { loading = false } = {}) {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) {
    return loading ? '…' : '—';
  }
  const n = Number(val);
  return `${formatNum(n, n % 1 === 0 ? 0 : 2)} A9`;
}

function renderTeamStakeReferralCardHtml({ loading = false, error = null, data = null } = {}) {
  const totalA9 = data ? (rawToA9(data.totalCommissionRaw) ?? 0) : null;
  const creditedA9 = data ? (rawToA9(data.creditedRaw) ?? 0) : null;
  const pendingA9 = data ? (rawToA9(data.pendingRaw) ?? 0) : null;
  const items = Array.isArray(data?.items) ? data.items : [];
  const unbound = data && data.bound === false;

  let body = '';
  if (loading) {
    body = `<div class="num-xs text-muted">${L('正在读取好友通关 8% 返佣明细…', 'Loading 8% pass referral credits…')}</div>`;
  } else if (error) {
    body = `<div class="row-between" style="gap:8px;"><span class="num-xs text-red">${escapeHtml(error)}</span><button class="sw-retry-link" id="btn-retry-team-ref" type="button">${L('重试', 'Retry')}</button></div>`;
  } else if (!data || unbound) {
    body = `<div class="num-xs text-muted">${L('在 Telegram 内打开并绑定钱包后，好友通关的 8% 返佣将自动计入推广奖励。', 'Open in Telegram and bind wallet to track 8% pass referral credits.')}</div>`;
  } else {
    body = `
      <div class="metric-strip cols-3" style="margin:6px 0 8px;">
        <div class="metric-cell"><span class="num-xs text-muted">${L('累计返佣', 'Total')}</span><span class="num-sm text-green mono" style="font-weight:800;">${formatNum(totalA9, 2)} A9</span></div>
        <div class="metric-cell"><span class="num-xs text-muted">${L('已入账', 'Credited')}</span><span class="num-sm mono" style="font-weight:800;">${formatNum(creditedA9, 2)} A9</span></div>
        <div class="metric-cell"><span class="num-xs text-muted">${L('待入账', 'Pending')}</span><span class="num-sm text-gold mono" style="font-weight:800;">${formatNum(pendingA9, 2)} A9</span></div>
      </div>
      ${items.length === 0
        ? `<div class="num-xs text-muted">${L('暂无好友通关返佣记录，好友通关后按奖金 8% 独立计入。', 'No 8% pass referral credits yet. Earned separately when invited friends pass a round.')}</div>`
        : `<div class="sw-menu-group">${items.slice(0, 5).map((it) => {
            const commA9 = rawToA9(it.commissionRaw) ?? 0;
            const isCred = String(it.status || '').toUpperCase() === 'CREDITED';
            return `
              <div class="sw-menu-row is-static">
                <div class="sw-menu-left">
                  <span class="sw-menu-title">${L(`第 ${it.roundId} 轮`, `Round #${it.roundId}`)} · <span class="mono">${escapeHtml(it.refereeWallet || '—')}</span></span>
                  <span class="sw-menu-sub">${isCred ? L('已到账', 'Credited') : L('待入账', 'Pending')}</span>
                </div>
                <div class="sw-menu-right">
                  <span class="sw-menu-amount is-green">+${formatNum(commA9, 2)} A9</span>
                </div>
              </div>
            `;
          }).join('')}</div>`}
    `;
  }

  return `
    <section class="card" id="team-stake-referral-card">
      <div class="row-between" style="margin-bottom:6px;">
        <span class="card-title">${icon('team', 15, 'text-gold')} ${L('好友通关 8% 返佣明细', '8% Pass Referral Details')}</span>
        <a class="text-link-btn" href="#/team/invite">${L('明细', 'Details')} ›</a>
      </div>
      ${body}
    </section>
  `;
}

function mountTeamStakeReferrals(root) {
  const mount = root.querySelector('#team-stake-referral-mount');
  if (!mount) return;
  if (!config.isDemo && !A9TMA.getRawInitData()) {
    mount.innerHTML = renderTeamStakeReferralCardHtml({ loading: false, data: null });
    return;
  }
  mount.innerHTML = renderTeamStakeReferralCardHtml({ loading: true });
  fetchMyStakeReferrals(20)
    .then((res) => {
      if (!mount.isConnected) return;
      mount.innerHTML = renderTeamStakeReferralCardHtml({ loading: false, data: res });
    })
    .catch((e) => {
      if (!mount.isConnected) return;
      mount.innerHTML = renderTeamStakeReferralCardHtml({ loading: false, error: e?.message || L('读取失败', 'Read failed') });
      const retryBtn = mount.querySelector('#btn-retry-team-ref');
      if (retryBtn) retryBtn.onclick = () => mountTeamStakeReferrals(root);
    });
}

function renderMemberRankingBlock(members = []) {
  const list = Array.isArray(members) ? members : [];
  return `
    <div>
      <div class="row-between" style="margin-bottom:6px;padding:0 2px;">
        <span class="sw-section-label" style="margin:0;padding:0;">${L('成员排行', 'Member Rankings')}</span>
        <a class="text-link-btn" href="#/leaderboard">${L('完整榜单', 'Full Board')} ›</a>
      </div>
      <div class="sw-menu-group">
        ${list.length === 0
          ? `<div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('暂无成员贡献排行', 'No member rankings yet')}</span></div></div>`
          : list.map((m, i) => `
            <div class="sw-rank-row">
              <span class="sw-rank-pos">${escapeHtml(m.rank || `#${String(i + 1).padStart(2, '0')}`)}</span>
              <span class="sw-rank-id">${escapeHtml(m.addr || m.wallet || '—')}</span>
              <span class="sw-rank-val">${formatNum(m.ton ?? m.contribution ?? 0)} A9</span>
            </div>
          `).join('')}
      </div>
    </div>
  `;
}

function renderReferralDetailsLinks(promoClaimableA9, { loading = false } = {}) {
  return `
    <div>
      <div class="sw-section-label">${L('推广奖励', 'Referral Rewards')}</div>
      <div class="sw-menu-group">
        <a class="sw-menu-row" href="#/team/invite">
          <span class="sw-row-icon is-amber" aria-hidden="true">${icon('trophy', 16)}</span>
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('推广奖励余额', 'Referral Balance')}</span>
            <span class="sw-menu-sub">${L('查看 6% 商城直推与提现明细', 'View 6% mall referral & claim details')}</span>
          </div>
          <div class="sw-menu-right">
            <span class="sw-menu-amount ${Number(promoClaimableA9) > 0 ? 'is-green' : (promoClaimableA9 == null ? 'is-muted' : '')}">${fmtA9OrDash(promoClaimableA9, { loading })}</span>
            <span class="sw-menu-arrow" aria-hidden="true">›</span>
          </div>
        </a>
      </div>
    </div>
  `;
}

function computeCaptainTodo({ tgMembers, memberCount, verified, rewardPaid }) {
  const hasTg = Number.isFinite(tgMembers) && tgMembers >= 50;
  const hasMembers = Number.isFinite(memberCount) && memberCount >= 3;
  const conditionMet = hasTg && hasMembers;

  if (!hasTg && !hasMembers) {
    return {
      conditionMet,
      text: L('先绑定 ≥ 50 人 TG 群并招募至 3 名战队成员', 'Bind a 50+ member TG group and reach 3 squad members'),
      ctaLabel: L('去绑定 TG 群', 'Bind TG Group'),
      ctaHref: '#/team/bind-tg',
      done: false,
    };
  }
  if (!hasTg) {
    const need = Number.isFinite(tgMembers) ? Math.max(1, 50 - tgMembers) : 50;
    return {
      conditionMet,
      text: L(`战队成员已满足，TG 群还差 ${need} 人（需 ≥ 50 人）`, `Squad size met · TG group needs ${need} more members`),
      ctaLabel: L('管理 TG 群', 'Manage TG Group'),
      ctaHref: '#/team/bind-tg',
      done: false,
    };
  }
  if (!hasMembers) {
    const need = Number.isFinite(memberCount) ? Math.max(1, 3 - memberCount) : 3;
    return {
      conditionMet,
      text: L(`群规模已满足，战队还差 ${need} 名成员`, `Group size met · squad needs ${need} more member(s)`),
      ctaLabel: L('邀请好友入队', 'Invite Members'),
      ctaHref: '#/team/invite',
      done: false,
    };
  }
  if (!verified) {
    return {
      conditionMet,
      text: L('群规模与成员数已满足，立即发起群核验', 'Requirements met · run TG group verification'),
      ctaLabel: L('发起群核验', 'Verify TG Group'),
      ctaHref: '#/team/bind-tg',
      done: false,
    };
  }
  if (!rewardPaid) {
    return {
      conditionMet,
      text: rewardPaid === null ? L('核验已通过，创世金库到账待核验', 'Verified · captain vault credit unconfirmed') : L('核验已通过，创世金库待发放', 'Verified · captain vault pending payout'),
      ctaLabel: L('查看推广奖励', 'View Referral Rewards'),
      ctaHref: '#/team/invite',
      done: false,
    };
  }
  return {
    conditionMet,
    text: L('5,000 A9 创世金库已到账，继续招募战队成员', '5,000 A9 captain vault credited · keep recruiting'),
    ctaLabel: L('邀请好友入队', 'Invite Friends'),
    ctaHref: '#/team/invite',
    done: true,
  };
}

function renderCaptainHomeHtml({
  squadName,
  tgMembers,
  memberCount,
  verified,
  rewardPaid,
  promoClaimableA9,
  topMembers = [],
  rolePill = '',
  loading = false,
  broadcastEnabled = false,
}) {
  const todo = computeCaptainTodo({ tgMembers, memberCount, verified, rewardPaid });
  const tgVal = Number.isFinite(tgMembers) ? `${tgMembers} / 50` : '— / 50';
  const memVal = Number.isFinite(memberCount) ? `${memberCount} / 3` : '— / 3';

  return `
    <section class="card card-hero col-gap">
      <div class="row-between">
        <div class="sw-squad-head">
          <span class="sw-squad-emblem" aria-hidden="true">${icon('squadEmblem', 24)}</span>
          <div class="sw-squad-meta">
            <h2 class="sw-squad-name">${escapeHtml(config.isDemo && squadName === 'A9 冒险战队' ? L('A9 冒险战队', 'A9 Quest Squad') : (squadName || L('我的战队', 'My Squad')))}</h2>
            <div class="num-xs text-muted">${L('队长', 'Captain')}</div>
          </div>
        </div>
        ${rolePill}
      </div>

      <div class="sw-next-todo ${todo.done ? 'is-done' : ''}">
        <div class="num-xs text-muted" style="margin-bottom:2px;">${L('下一项待办', 'Next Action')}</div>
        <div>${todo.text}</div>
      </div>

      <a class="btn btn-primary" href="${todo.ctaHref}">${todo.ctaLabel} ›</a>

      <div class="sw-menu-group">
        <a class="sw-menu-row" href="#/team/bind-tg">
          <span class="sw-row-icon is-blue" aria-hidden="true">${icon('send', 16)}</span>
          <div class="sw-menu-left"><span class="sw-menu-title">${L('TG 群人数', 'TG Group Members')}</span></div>
          <div class="sw-menu-right">
            <span class="sw-menu-amount ${Number.isFinite(tgMembers) && tgMembers >= 50 ? 'is-green' : ''}">${tgVal}</span>
            <span class="sw-menu-arrow" aria-hidden="true">›</span>
          </div>
        </a>
        <a class="sw-menu-row" href="#/team/invite">
          <span class="sw-row-icon is-red" aria-hidden="true">${icon('team', 16)}</span>
          <div class="sw-menu-left"><span class="sw-menu-title">${L('战队成员', 'Squad Members')}</span></div>
          <div class="sw-menu-right">
            <span class="sw-menu-amount ${Number.isFinite(memberCount) && memberCount >= 3 ? 'is-green' : ''}">${memVal}</span>
            <span class="sw-menu-arrow" aria-hidden="true">›</span>
          </div>
        </a>
      </div>

      <div class="sw-status-steps" aria-label="${L('队长奖励核验状态', 'Captain vault status')}">
        <div class="sw-status-step ${todo.conditionMet ? 'is-done' : 'is-active'}">
          <small>${L('达到条件', 'Eligible')}</small>
          <strong>${todo.conditionMet ? L('已达标', 'Met') : L('未达标', 'Pending')}</strong>
        </div>
        <div class="sw-status-step ${verified ? 'is-done' : (todo.conditionMet ? 'is-active' : '')}">
          <small>${L('通过核验', 'Verified')}</small>
          <strong>${verified ? L('已通过', 'Passed') : L('待核验', 'Pending')}</strong>
        </div>
        <div class="sw-status-step ${rewardPaid ? 'is-done' : (verified ? 'is-active' : '')}">
          <small>${L('奖励到账', 'Credited')}</small>
          <strong>${rewardPaid ? L('已到账', 'Paid') : (rewardPaid === null ? L('待核验', 'Unconfirmed') : L('未到账', 'Pending'))}</strong>
        </div>
      </div>
    </section>

    <div class="grid-2">
      <a class="btn btn-secondary btn-sm" href="#/team/invite" style="width:100%;min-height:42px;">${icon('qr', 14)} ${L('招募入口', 'Recruit')}</a>
      <button class="btn btn-secondary btn-sm" type="button" style="width:100%;min-height:42px;" ${broadcastEnabled ? '' : 'disabled'}>${icon('bell', 14)} ${broadcastEnabled ? L('发送群广播', 'Broadcast') : L('群广播未开放', 'Broadcast Off')}</button>
    </div>

    ${renderReferralDetailsLinks(promoClaimableA9, { loading })}
    <div id="team-stake-referral-mount">${renderTeamStakeReferralCardHtml({ loading: true })}</div>
    ${renderMemberRankingBlock(topMembers)}
  `;
}

function renderMemberHomeHtml({
  squadName,
  validInvites,
  promoClaimableA9,
  topMembers = [],
  rolePill = '',
  loading = false,
  isDemo = false,
}) {
  return `
    <section class="card card-hero col-gap">
      <div class="row-between">
        <div class="sw-squad-head">
          <span class="sw-squad-emblem" aria-hidden="true">${icon('squadEmblem', 24)}</span>
          <div class="sw-squad-meta">
            <h2 class="sw-squad-name">${escapeHtml(config.isDemo && squadName === 'A9 冒险战队' ? L('A9 冒险战队', 'A9 Quest Squad') : (squadName || L('我的战队', 'My Squad')))}</h2>
            <div class="num-xs text-muted">${L('队员', 'Member')}</div>
          </div>
        </div>
        ${rolePill}
      </div>

      <div class="sw-menu-group">
        <div class="sw-menu-row is-static">
          <span class="sw-row-icon is-blue" aria-hidden="true">${icon('team', 16)}</span>
          <div class="sw-menu-left"><span class="sw-menu-title">${L('我的有效邀请', 'My Valid Invites')}</span></div>
          <div class="sw-menu-right"><span class="sw-menu-amount">${validInvites === null || validInvites === undefined ? (loading ? '…' : '—') : formatNum(validInvites)}</span></div>
        </div>
        <a class="sw-menu-row" href="#/team/invite">
          <span class="sw-row-icon is-amber" aria-hidden="true">${icon('trophy', 16)}</span>
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('我的推广奖励', 'My Referral Rewards')}</span>
            <span class="sw-menu-sub">${L('商城直推 6% 等奖励明细', '6% mall referral & details')}</span>
          </div>
          <div class="sw-menu-right">
            <span class="sw-menu-amount ${Number(promoClaimableA9) > 0 ? 'is-green' : (promoClaimableA9 == null ? 'is-muted' : '')}">${fmtA9OrDash(promoClaimableA9, { loading })}</span>
            <span class="sw-menu-arrow" aria-hidden="true">›</span>
          </div>
        </a>
      </div>

      <a class="btn btn-primary" href="#/team/invite">${icon('qr', 15)} ${L('邀请好友', 'Invite Friends')} ›</a>
    </section>

    <div id="team-stake-referral-mount">${renderTeamStakeReferralCardHtml({ loading: true })}</div>
    ${renderMemberRankingBlock(topMembers)}

    ${isDemo ? `
      <button class="btn btn-secondary" id="btn-squad-more" type="button">${icon('more', 16)} ${L('更多战队操作', 'More Squad Actions')}</button>
    ` : ''}
  `;
}

function renderUnjoinedHomeHtml({
  inviteContext = null,
  rolePill = '',
  isLive = false,
  hasWallet = false,
  squads = [],
}) {
  const inviteBanner = inviteContext ? `
    <section class="card card-hero col-gap">
      <div class="row-between">
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
      ${inviteContext.teamId
        ? `<button class="btn btn-primary" type="button" data-join-team="${escapeHtml(inviteContext.teamId)}">${L('查看邀请并加入', 'View Invite & Join')}</button>`
        : `<a class="btn btn-primary" href="#/team/invite">${L('查看邀请', 'View Invite')} ›</a>`}
    </section>
  ` : `
    <section class="card card-hero col-gap">
      <div class="row-between">
        <div class="sw-squad-head">
          <span class="sw-squad-emblem" aria-hidden="true">${icon('squadEmblem', 24)}</span>
          <div class="sw-squad-meta">
            <h2 class="sw-squad-name">${L('加入战队', 'Join a Squad')}</h2>
            <div class="num-xs text-muted">${L('免费入队 · 无锁仓门槛', 'Free to join · no lock required')}</div>
          </div>
        </div>
        ${rolePill}
      </div>
      <div class="num-xs text-sec" style="line-height:1.5;">${L('加入战队后可追踪好友邀请、查看成员贡献排行，并分别累计商城直推与好友通关返佣明细。', 'Join a squad to track invites, view member rankings, and earn separate mall & pass referral rewards.')}</div>
      ${isLive && !hasWallet ? `<button class="btn btn-primary" id="team-live-connect" type="button">${icon('wallet', 15)} ${L('连接钱包加入战队', 'Connect Wallet to Join')}</button>` : ''}
    </section>
  `;

  if (isLive) {
    return `
      ${inviteBanner}
      <form class="card col-gap" id="live-join-team-form">
        <div class="card-title">${icon('team', 15, 'text-gold')} ${L('输入战队编号加入', 'Join by Squad ID')}</div>
        <label class="num-xs text-sec">${L('战队编号', 'Squad ID')}
          <input name="guild" class="input-box" style="width:100%;margin-top:4px;padding:8px 10px;" required maxlength="64" placeholder="TM-0001" value="${escapeHtml(inviteContext?.teamId || '')}">
        </label>
        <button class="btn btn-primary" type="submit">${L('申请加入', 'Join Squad')}</button>
        <output class="num-xs text-red"></output>
      </form>
      ${renderReferralDetailsLinks(null, { loading: false })}
    `;
  }

  return `
    ${inviteBanner}
    <div>
      <div class="row-between" style="margin-bottom:6px;padding:0 2px;">
        <span class="sw-section-label" style="margin:0;padding:0;">${L('推荐战队', 'Recommended Squads')}</span>
        <a class="text-link-btn" href="#/leaderboard">${L('排行榜', 'Rankings')} ›</a>
      </div>
      <div class="sw-menu-group">
        ${squads.map((s) => `
          <div class="sw-menu-row is-static">
            <div class="sw-menu-left">
              <span class="sw-menu-title">${escapeHtml(s.name)}</span>
              <span class="sw-menu-sub">${escapeHtml(s.lv)} · ${escapeHtml(s.members)} ${L('人', 'members')}</span>
            </div>
            <div class="sw-menu-right">
              <button class="btn btn-primary btn-sm" type="button" data-join-team="${escapeHtml(s.id)}">${L('加入', 'Join')}</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

let teamRenderSeq = 0;
let activeRallyTpl = 'push';

function getTeamInviteLink(teamId) {
  const shareRef = getShareRef();
  const squadId = typeof teamId === 'string' && /^(?:G|T|TM|TEAM)-[A-Za-z0-9-]+$/i.test(teamId) ? teamId : '';
  const startParam = squadId ? `invite_${squadId}_${shareRef}` : `invite_${shareRef}`;
  return config.isDemo
    ? `${window.location.origin}${window.location.pathname}?mode=${config.mode}&startapp=${encodeURIComponent(startParam)}`
    : buildTmaDeepLink(startParam);
}

function renderSquadBattleStrip(round) {
  const r = round || {};
  const m = computeRoundPriceMetrics(r);
  const uiState = deriveRoundUiState({ detail: r, user: store.state.user, serverNowMs: serverNowMs() });
  const stageText = uiState.badgeLabel;
  const roundLabel = r.currentRound != null ? L(`第 ${r.currentRound} 轮`, `R${r.currentRound}`) : L('本轮', 'Round');
  if (uiState.isTerminal) {
    return `<a class="sw-battle-strip" href="#/round"><strong>${roundLabel} · ${stageText}</strong><span class="sw-battle-strip-right">${L('查看本轮结果', 'View round result')} ›</span></a>`;
  }
  const qualText = r.qualifiedCandles != null ? `${r.qualifiedCandles}/${r.minQualifiedCandles ?? 8}` : '—';
  const poolText = r.rewardBudgetA9 != null && Number.isFinite(Number(r.rewardBudgetA9)) ? `${formatNum(r.rewardBudgetA9)} A9` : '—';
  const cdText = uiState.countdownMs !== null ? formatTimer(Math.ceil(uiState.countdownMs / 1000)) : uiState.countdownLabel;
  const deltaChip = m.deltaPct === null
    ? `<span class="chip chip-muted mono" id="team-battle-delta" style="min-height:19px;font-size:10px;padding:0 6px;">—</span>`
    : `<span class="chip ${m.isAbove ? 'chip-green' : 'chip-red'} mono" id="team-battle-delta" style="min-height:19px;font-size:10px;padding:0 6px;">${m.isAbove ? '+' : ''}${m.deltaPct.toFixed(1)}%</span>`;

  return `
    <a class="sw-battle-strip" href="#/round" id="team-battle-strip">
      <div class="sw-battle-strip-left">
        <div class="sw-battle-strip-top">
          <span class="sw-pulse-dot ${m.deltaPct === null ? '' : (m.isAbove ? 'is-up' : 'is-down')}" aria-hidden="true"></span>
          <strong class="num-xs">${r.currentRound != null ? L(`第 ${r.currentRound} 轮`, `R${r.currentRound}`) : L('本轮', 'Round')} · ${stageText}</strong>
          <span class="mono num-xs" id="team-battle-price" style="font-weight:900;">${m.liveText}</span>
          ${deltaChip}
        </div>
        <div class="num-xs text-muted mono">
          ${L('目标', 'Target')} ${m.targetText} · ${L('达标', 'Met')} ${qualText} · ${L('奖池', 'Pool')} <span style="white-space:nowrap">${poolText}</span> · <span id="team-battle-cd">${cdText}</span>
        </div>
      </div>
      <span class="sw-battle-strip-right">${L('去盯盘', 'Arena')} ›</span>
    </a>
  `;
}

function renderRallyCommandCard(round, tpl, inviteLink) {
  const copyTextVal = buildBattleRallyCopy(round, inviteLink, tpl);
  return `
    <section class="card col-gap" id="team-rally-center">
      <div class="row-between">
        <span class="card-title">${icon('send', 15, 'text-red')} ${L('一键动员喊单中心', '1-Tap Rally Command')}</span>
        <a class="text-link-btn" href="#/team/invite">${L('招募海报', 'Posters')} ›</a>
      </div>
      <div class="seg-tabs" role="tablist" aria-label="${L('选择喊单模板', 'Select rally template')}">
        <button type="button" class="seg-tab ${tpl === 'push' ? 'active' : ''}" data-rally-tpl="push">${L('冲线喊单', 'Push Call')}</button>
        <button type="button" class="seg-tab ${tpl === 'first6h' ? 'active' : ''}" data-rally-tpl="first6h">${L('头矿 6H', 'First 6H')}</button>
        <button type="button" class="seg-tab ${tpl === 'free' ? 'active' : ''}" data-rally-tpl="free">${L('0 GRAM 拉新', 'Free Box')}</button>
      </div>
      <div class="share-copy-box" id="team-rally-preview">${escapeHtml(copyTextVal)}</div>
      <div class="grid-3" style="gap:7px;">
        <button type="button" class="btn btn-primary btn-sm" id="btn-rally-copy" style="width:100%;min-height:40px;">${icon('copy', 13)} ${L('复制战报', 'Copy')}</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-rally-tg" style="width:100%;min-height:40px;">${icon('send', 13)} Telegram</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-rally-x" style="width:100%;min-height:40px;">${icon('xBrand', 12)} X</button>
      </div>
      <div class="sw-menu-group">
        <div class="sw-menu-row is-static">
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('动员冲线收益闭环', 'Mobilization Rewards')}</span>
            <span class="sw-menu-sub">${L('共推本轮冲价解锁奖池 · 商城直推 6% · 好友通关 8%（独立计入）· 队长 5,000 A9', 'Push round unlock · 6% mall direct · 8% friend pass (separate) · 5,000 A9 captain vault')}</span>
          </div>
        </div>
      </div>
    </section>
  `;
}

function bindRallyCommandEvents(root, teamId) {
  const card = root.querySelector('#team-rally-center');
  if (!card) return;
  const inviteLink = getTeamInviteLink(teamId);
  const refreshPreview = () => {
    const preview = card.querySelector('#team-rally-preview');
    if (preview) preview.textContent = buildBattleRallyCopy(store.state.round, inviteLink, activeRallyTpl);
    card.querySelectorAll('[data-rally-tpl]').forEach((b) => {
      b.classList.toggle('active', b.dataset.rallyTpl === activeRallyTpl);
    });
  };
  card.querySelectorAll('[data-rally-tpl]').forEach((btn) => {
    btn.onclick = () => {
      A9Haptic.light();
      activeRallyTpl = btn.dataset.rallyTpl || 'push';
      refreshPreview();
    };
  });
  const copyBtn = card.querySelector('#btn-rally-copy');
  if (copyBtn) {
    copyBtn.onclick = () => {
      A9Haptic.light();
      copyText(buildBattleRallyCopy(store.state.round, inviteLink, activeRallyTpl), L('已复制战报喊单', 'Copied battle call'));
    };
  }
  const tgBtn = card.querySelector('#btn-rally-tg');
  if (tgBtn) {
    tgBtn.onclick = () => {
      A9Haptic.light();
      A9TMA.shareInvite(inviteLink, buildBattleRallyCopy(store.state.round, inviteLink, activeRallyTpl));
      showToast(L('已调起 Telegram 群分享', 'Opened Telegram share'));
    };
  }
  const xBtn = card.querySelector('#btn-rally-x');
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
      let bodyHtml = '';
      if (!teamData) {
        bodyHtml = renderUnjoinedHomeHtml({
          inviteContext,
          isLive: true,
          hasWallet: Boolean(addr),
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
          loading,
          broadcastEnabled: false,
        });
      } else {
        bodyHtml = renderMemberHomeHtml({
          squadName: teamData.name,
          validInvites: teamData.myValidInvites ?? null,
          promoClaimableA9,
          topMembers: Array.isArray(teamData.topMembers) ? teamData.topMembers : [],
          loading,
          isDemo: false,
        });
      }

      const rallyCardHtml = teamData ? renderRallyCommandCard(store.state.round, activeRallyTpl, getTeamInviteLink(teamData.teamId)) : '';
      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          ${renderSquadBattleStrip(store.state.round)}
          ${bodyHtml}
          ${rallyCardHtml}
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
      bindRallyCommandEvents(root, teamData?.teamId);
      mountTeamStakeReferrals(root);
      if (query?.action === 'rally') {
        requestAnimationFrame(() => root.querySelector('#team-rally-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
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
      rolePill,
      loading: false,
      broadcastEnabled: false,
    });
  } else if (role === 'member') {
    const demoSquads = peekDemoModule()?.DEMO_SQUADS || [];
    const squad = demoSquads.find(item => item.id === team.id);
    html = renderMemberHomeHtml({
      squadName: squad ? L(squad.zh, squad.en) : team.id,
      validInvites: team.directInvites ?? 16,
      promoClaimableA9: promoDemoA9,
      topMembers: team.topMembers || [],
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
    });
  }

  const demoRallyHtml = role !== 'none' ? renderRallyCommandCard(store.state.round, activeRallyTpl, getTeamInviteLink(team.id)) : '';
  root.innerHTML = `<div class="col-gap anim-page-enter">${renderSquadBattleStrip(store.state.round)}${html}${demoRallyHtml}</div>`;
  bindRallyCommandEvents(root, team.id);
  mountTeamStakeReferrals(root);
  if (query?.action === 'rally') {
    requestAnimationFrame(() => root.querySelector('#team-rally-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  const roleBtn = root.querySelector('#btn-role-sheet');
  if (roleBtn) {
    roleBtn.onclick = () => openChoiceSheet({
      title: L('切换战队身份 (演示)', 'Switch Squad Role (Demo)'),
      selected: role,
      options: [
        { value: 'captain', label: L('队长视图', 'Captain'), sub: L('待办置顶、群核验三态与成员排行', 'Next action, 3-state verification & ranks') },
        { value: 'member', label: L('队员视图', 'Member'), sub: L('有效邀请、推广奖励与贡献排行', 'Valid invites, referral rewards & ranks') },
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
          label: L('邀请好友与招募海报', 'Invite & Posters'),
          sub: L('商城直推 6% · 通关返佣 8%', '6% mall · 8% pass credits'),
          onSelect: () => navigate('/team/invite'),
        },
        {
          icon: 'trophy',
          tone: 'is-amber',
          label: L('查看完整排行榜', 'Full Leaderboard'),
          sub: L('个人榜、战队榜与邀请榜', 'Personal, squad & invite boards'),
          onSelect: () => navigate('/leaderboard'),
        },
        {
          icon: 'swap',
          tone: 'is-blue',
          label: L('切换战队', 'Switch Squad'),
          sub: L('返回战队大厅浏览其他战队', 'Return to lobby to pick another squad'),
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
            <div class="sw-menu-group">
              <div class="sw-menu-row is-static">
                <div class="sw-menu-left"><span class="sw-menu-title">${L('战队成员数', 'Squad Members')}</span></div>
                <div class="sw-menu-right"><span class="sw-menu-amount">${teamData?.memberCount != null ? formatNum(teamData.memberCount) : '—'}</span></div>
              </div>
              <div class="sw-menu-row is-static">
                <div class="sw-menu-left"><span class="sw-menu-title">${L('商城直推返佣', 'Mall Direct Referral')}</span></div>
                <div class="sw-menu-right"><span class="sw-menu-amount is-green">6%</span></div>
              </div>
              <div class="sw-menu-row is-static">
                <div class="sw-menu-left"><span class="sw-menu-title">${L('好友通关返佣', 'Pass Referral Credit')}</span></div>
                <div class="sw-menu-right"><span class="sw-menu-amount is-green">8%</span></div>
              </div>
              ${error ? `
                <div class="sw-menu-error" role="alert">
                  <span>${L('读取失败', 'Read failed')}</span>
                  <button type="button" class="sw-retry-link" id="btn-tprof-retry">${L('重试', 'Retry')}</button>
                </div>
              ` : ''}
            </div>
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
        <div class="sw-menu-group">
          <div class="sw-menu-row is-static">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('战队成员', 'Members')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-amount">${squad?.memberCount ?? '—'}</span></div>
          </div>
          <div class="sw-menu-row is-static">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('累计锁仓', 'Total Locked')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-amount">${squad?.lockedA9 != null ? formatNum(squad.lockedA9) + ' A9' : '—'}</span></div>
          </div>
          <div class="sw-menu-row is-static">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('商城直推 / 通关返佣', 'Mall / Pass Referral')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-amount is-green">6% / 8%</span></div>
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
  if (!config.isDemo) {
    let liveStatus = 'unbound';
    let lastMsg = L('填写战队编号与 Telegram 群 @用户名 后先进入核验中，再由服务端核验 Bot 入群状态、群管理员权限与群唯一性。', 'Submit Squad ID and Telegram @group handle to enter verifying state, then run server verification for bot presence, admin role, and group uniqueness.');
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
              <span class="card-title">${icon('send', 15, 'text-gold')} ${L('战队 Telegram 群核验', 'Squad TG Group Verification')}</span>
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
            <form id="live-tg-bind-form" class="col-gap">
              <label class="num-xs text-sec">${L('战队编号 (Squad ID)', 'Squad ID')}
                <input name="teamId" class="input-box" style="width:100%;margin-top:4px;padding:8px 10px;" placeholder="TM-0001" required maxlength="64" value="${escapeHtml(team.id || '')}">
              </label>
              <label class="num-xs text-sec">${L('Telegram 群组 @用户名', 'Telegram Group @handle')}
                <input name="tgGroupHandle" class="input-box" style="width:100%;margin-top:4px;padding:8px 10px;" placeholder="@your_guild_group" required maxlength="64" value="${escapeHtml(team.tgGroupHandle || '')}">
              </label>
              <div class="grid-2" style="margin-top:4px;">
                <button type="submit" class="btn btn-secondary" id="btn-live-submit-tg">${L('1. 提交进入核验中', '1. Submit Handle')}</button>
                <button type="button" class="btn btn-primary" id="btn-live-verify-tg">${L('2. 发起服务端核验', '2. Verify Now')}</button>
              </div>
            </form>
          </section>
          <div class="sw-menu-group">
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('1. 仅队长本人可提交与核验', '1. Captain-Only Verification')}</span>
                <span class="sw-menu-sub">${L('需已验签绑定队长钱包，普通成员将被拒绝（403）', 'Verified captain wallet required; members receive 403')}</span>
              </div>
            </div>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('2. 官方 Bot 入群且队长为管理员', '2. Official Bot + Captain Admin')}</span>
                <span class="sw-menu-sub">${L('群 ≥50 人且战队 ≥3 成员核验通过后发放 5,000 A9（限 1 次）', '50+ TG members & ≥3 squad members earn 5,000 A9 once')}</span>
              </div>
            </div>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('3. 群唯一性防伪校验', '3. Unique Group Binding')}</span>
                <span class="sw-menu-sub">${L('同一真实群 ID 仅可绑定 1 个战队；仅提交 @群名停留在核验中', 'One tgChatId per squad; submitting handle only sets verifying')}</span>
              </div>
            </div>
            <a class="sw-menu-row" href="#/team">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('返回战队', 'Back to Squad')}</span></div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
          </div>
        </div>
      `;
      const form = root.querySelector('#live-tg-bind-form');
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const tid = form.elements.teamId.value.trim();
        const handle = form.elements.tgGroupHandle.value.trim();
        if (!tid || !handle) return;
        const submitBtn = root.querySelector('#btn-live-submit-tg');
        submitBtn.disabled = true;
        try {
          const res = await bindTeamGroupTg({ teamId: tid, tgGroupHandle: handle });
          liveStatus = res?.bindStatus || 'verifying';
          lastMsg = L('已提交群组信息，当前状态为「核验中」。请确保官方 Bot 已入群后点击右侧「发起服务端核验」。', 'Submitted. Status is verifying. Add the official bot to the group and click Verify Now.');
          showToast(L('已进入核验中（verifying）', 'Status: verifying'));
        } catch (e) {
          lastMsg = e?.message || L('提交失败，请确认已在 Telegram 内打开并已验证绑定队长钱包', 'Submission failed. Verify Telegram session & captain wallet.');
          showToast(lastMsg, 'error');
        }
        paintLive();
      };
      root.querySelector('#btn-live-verify-tg').onclick = async () => {
        const tid = form.elements.teamId.value.trim();
        if (!tid) {
          showToast(L('请先填写战队编号', 'Enter Squad ID first'), 'amber');
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
          lastMsg = e?.message || L('服务端核验未通过，请检查机器人入群与管理员权限', 'Verification failed. Check bot presence and admin permissions.');
          showToast(lastMsg, 'error');
        }
        paintLive();
      };
    };
    paintLive();
    return;
  }
  let bindState = team.tgGroupBound ? 'bound' : 'unbound';
  const stateMeta = {
    bound:     { chip: 'chip-green', label: L('已绑定', 'Bound'),    desc: L('Bot 权限正常，整点收盘自动播报。', 'Bot active. Hourly pushes enabled.'), btn: L('重新校验', 'Re-verify') },
    unbound:   { chip: 'chip-muted', label: L('未绑定', 'Unbound'),  desc: L('将 @A9_TonBot 设为群管理员即可绑定。', 'Add @A9_TonBot as admin to bind.'), btn: L('一键绑定 TG 群', 'Bind TG Group') },
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
  let promoClaimBusy = false;
  let lastClaimStatus = null;

  const buildScenarioPitch = (tpl) => {
    const r = store.state.round || {};
    const roundLabel = r.currentRound ? L(`第 ${r.currentRound} 轮`, `Round #${r.currentRound}`) : L('本轮', 'Current Round');
    const targetStr = (r.targetPrice !== null && r.targetPrice !== undefined && Number.isFinite(Number(r.targetPrice)) && Number(r.targetPrice) > 0)
      ? `$${Number(r.targetPrice).toFixed(4)}`
      : null;
    const rawCur = r.priceValid !== false ? (r.livePrice ?? r.twap24h) : null;
    const curNum = (rawCur !== null && rawCur !== undefined && Number.isFinite(Number(rawCur)) && Number(rawCur) > 0) ? Number(rawCur) : null;
    const gapPct = (targetStr && curNum) ? (((Number(r.targetPrice) - curNum) / curNum) * 100) : null;
    const gapLineZh = targetStr && gapPct !== null
      ? (gapPct <= 0 ? `已站上目标价 ${targetStr}（+${Math.abs(gapPct).toFixed(1)}%）` : `目标价 ${targetStr}，距解锁还差 +${gapPct.toFixed(1)}%`)
      : (targetStr ? `目标价 ${targetStr}` : '链上实时目标价核验中');
    const gapLineEn = targetStr && gapPct !== null
      ? (gapPct <= 0 ? `above ${targetStr} target (+${Math.abs(gapPct).toFixed(1)}%)` : `target ${targetStr} (+${gapPct.toFixed(1)}% away)`)
      : (targetStr ? `target ${targetStr}` : 'on-chain target syncing');
    const poolStr = (r.rewardBudgetA9 !== null && r.rewardBudgetA9 !== undefined && Number.isFinite(Number(r.rewardBudgetA9)))
      ? `${formatNum(r.rewardBudgetA9)} A9`
      : L('700,000,000 A9', '700,000,000 A9');
    if (tpl === 'chest') {
      return L(
        `A9 宝箱商城升级「纯随机合并直发钱包」：0.99 GRAM 起保底 1,500 A9、最高开出 2,500 A9（传说箱最高 1,300,000 A9），只收一次 0.06 GRAM Gas，买完直接进头矿 6H（未通关仅 5% 止损）。直推好友购箱实时返佣 6%：${inviteLink}`,
        `A9 Chest Mall now pays base + random bonus straight to your wallet in one tx (0.06 GRAM gas once): from 0.99 GRAM (1,500–2,500 A9) up to 1,300,000 A9, plus 6% direct referral: ${inviteLink}`
      );
    }
    if (tpl === 'win') {
      return L(
        `A9 ${roundLabel} 涨价解锁机制：70% 奖池 + 12% 团队全锁价格，100 A9 起锁仓永不爆仓（头矿 6H 仅 5% 止损退 95%），12H 冲价达标 ≥ 8/12 段通关分 ${poolStr}，最高 5 倍币、20% 秒提 + 14 天逐秒解锁：${inviteLink}`,
        `A9 ${roundLabel} Price-Unlock: 70% pool + 12% team locked on price, lock from 100 A9 with no liquidation (First 6H 5% Stop-Loss / 95% refund), pass 8/12 slots to split ${poolStr} up to 5x: ${inviteLink}`
      );
    }
    return L(
      `【A9 ${roundLabel} 冲价喊单】${gapLineZh}！70% 奖池（${poolStr}）+ 12% 团队全锁价格，齐心冲上目标价稳住 8/12 小时全员分奖，没过自动退 95%/90% 永不爆仓。0.99 GRAM 开箱或 100 A9 锁仓一起冲：${inviteLink}`,
      `[A9 ${roundLabel} Price-Push] ${gapLineEn}! 70% pool (${poolStr}) + 12% team locked on price—hold 8/12 hourly slots to split rewards, 95%/90% refund if missed. Join from 0.99 GRAM chest or 100 A9 lock: ${inviteLink}`
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
    try {
      livePromo = await fetchPromoBalance(wallet);
      livePromoErr = null;
    } catch (e) {
      livePromoErr = e?.message || L('暂无法读取推广余额', 'Promo balance unavailable');
    }
    if (root.isConnected) paint();
  };

  const paint = () => {
    const claimableA9 = livePromo ? (rawToA9(livePromo.claimableRaw) ?? 0) : null;
    const totalClaimedA9 = livePromo ? (rawToA9(livePromo.totalClaimedRaw) ?? 0) : null;
    const canLiveClaim = !config.isDemo && store.fundsEnabled;
    const promoTxLocked = pendingTxManager.isLocked('promo');
    const promoDisabled = promoClaimBusy || promoTxLocked;

    const displayClaimable = config.isDemo ? Number(store.state.user.promoClaimableA9 ?? 0) : claimableA9;
    const displayClaimed = config.isDemo ? Number(store.state.user.promoClaimedA9 ?? 0) : totalClaimedA9;

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero col-gap">
          <div>
            <div class="num-xs text-muted">${L('推广可领余额', 'Claimable Referral Balance')}</div>
            <div class="sw-asset-main" style="margin-top:4px;">${displayClaimable === null || displayClaimable === undefined ? (store.state.user.address && !livePromoErr ? '…' : '—') : `${formatNum(displayClaimable, displayClaimable % 1 === 0 ? 0 : 2)} <span class="sw-asset-main-unit">A9</span>`}</div>
          </div>
          <div class="sw-menu-group">
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('累计已领', 'Total Claimed')}</span></div>
              <div class="sw-menu-right"><span class="sw-menu-amount">${fmtA9OrDash(displayClaimed)}</span></div>
            </div>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('固定领币费', 'Fixed Claim Fee')}</span>
                <span class="sw-menu-sub">${L('热钱包自动核验并转入当前钱包', 'Auto-verified hot wallet payout')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-amount">0.06 GRAM</span></div>
            </div>
          </div>
          ${!config.isDemo && livePromoErr ? `<div class="sw-menu-error" role="alert"><span>${escapeHtml(livePromoErr)}</span><button type="button" class="sw-retry-link" id="btn-promo-retry">${L('重试', 'Retry')}</button></div>` : ''}
          ${lastClaimStatus ? `<div class="num-xs text-green mono">${L('最近领奖单', 'Latest claim')}: ${escapeHtml(lastClaimStatus.claimId)} · ${escapeHtml(lastClaimStatus.status)}${lastClaimStatus.payoutTxHash ? ` · ${escapeHtml(lastClaimStatus.payoutTxHash.slice(0, 14))}…` : ''}</div>` : ''}
          <button class="btn ${config.isDemo || (canLiveClaim && !promoTxLocked) ? 'btn-primary' : 'btn-secondary'}" id="btn-claim-promo-hot" ${promoDisabled ? 'disabled' : ''}>${icon(store.fundsEnabled ? (promoTxLocked ? 'clock' : 'wallet') : 'lock', 14)} ${config.isDemo
            ? L('领取推广 A9（0.06 GRAM 说明）', 'Claim Referral A9 (0.06 GRAM Spec)')
            : canLiveClaim
              ? (promoTxLocked
                  ? L('推广发放确认中（防重锁）', 'Promo Payout Confirming…')
                  : promoClaimBusy
                    ? L('等待 0.06 GRAM 签名确认…', 'Waiting for 0.06 GRAM tx…')
                    : L('领取推广 A9（固定费 0.06 GRAM）', 'Claim Referral A9 (0.06 GRAM fee)'))
              : L('当前只读 · 推广领奖暂未开放', 'Read-Only · Referral Claim Disabled')}</button>
          ${!config.isDemo && !canLiveClaim ? `<div class="num-xs text-muted" id="live-readonly-promo-notice">${L('当前真实模式仅支持只读浏览与连接钱包，暂不创建 0.06 GRAM 付款单或发起签名。', 'Live mode is read-only; no 0.06 GRAM payment intent or signature will be created.')}</div>` : ''}
        </section>

        <div>
          <div class="sw-section-label">${L('两项独立返佣来源', 'Two Independent Referral Sources')}</div>
          <div class="sw-menu-group">
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('商城直推 6%', '6% Chest Mall Direct')}</span>
                <span class="sw-menu-sub">${L('好友在宝箱商城购箱后实时按 6% 计入推广余额', 'Credited at 6% when invited friends buy chests in Chest Mall')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-amount is-green">6%</span></div>
            </div>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('好友通关奖金 8%', '8% Friend Pass Reward')}</span>
                <span class="sw-menu-sub">${L('好友参与闯关通关后，按其奖金 8% 独立计入', 'Credited separately at 8% of invited friends’ winning round rewards')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-amount is-green">8%</span></div>
            </div>
          </div>
        </div>

        <div id="team-stake-referral-mount">${renderTeamStakeReferralCardHtml({ loading: true })}</div>

        <div class="seg-tabs">
          <button class="seg-tab ${template === 'push' ? 'active' : ''}" data-tpl="push">${L('冲价喊单卡', 'Push Call')}</button>
          <button class="seg-tab ${template === 'chest' ? 'active' : ''}" data-tpl="chest">${L('开箱喜报卡', 'Unboxing')}</button>
          <button class="seg-tab ${template === 'win' ? 'active' : ''}" data-tpl="win">${L('通关盈利卡', 'Pass Card')}</button>
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
            <span class="card-title">${icon('copy', 14, 'text-gold')} ${L('一键复制群推话术', '1-Tap Viral Pitch')}</span>
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
    mountTeamStakeReferrals(root);

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
    const promoBtn = root.querySelector('#btn-claim-promo-hot');
    if (promoBtn) {
      promoBtn.onclick = async () => {
        if (!store.fundsEnabled) {
          A9Haptic.warning();
          showToast(L('当前真实模式处于只读验收阶段，推广领奖付款单与 0.06 GRAM 签名暂未开放', 'Live mode is read-only; promo payout intent and 0.06 GRAM signing are disabled'), 'amber');
          return;
        }
        if (config.isDemo) {
          A9Haptic.success();
          const res = store.claimPromoDemo();
          if (res?.error) {
            showToast(res.error, 'amber');
            return;
          }
          showToast(L(`[演示模式] 已模拟领取 ${formatNum(res.amountA9)} A9 (${res.txHash})`, `[Demo] Simulated ${formatNum(res.amountA9)} A9 promo claim`));
          return;
        }
        const wallet = store.state.user.address;
        if (!store.state.user.connected || !wallet) {
          showToast(L('请先连接并验证 TON 钱包后再领取', 'Connect and verify TON wallet first'), 'amber');
          tonConnect.openConnectModal(() => loadLivePromo());
          return;
        }
        if (promoClaimBusy || pendingTxManager.isLocked('promo')) {
          showToast(L('已有推广领币交易正在发放确认中', 'Promo payout already confirming'), 'amber');
          return;
        }
        try {
          tonConnect.assertWalletReadyForLiveTx();
        } catch (guardErr) {
          showToast(guardErr?.message || L('请检查钱包连接与网络状态', 'Check wallet connection and network'), 'error');
          return;
        }
        A9Haptic.light();
        promoClaimBusy = true;
        paint();
        try {
          const intent = await requestPromoClaimIntent(wallet);
          const expectedPromoHot = store.state.round?.protocolConfig?.promoHotWallet?.address || '';
          if (expectedPromoHot && canonicalWalletKey(intent.payTo) !== canonicalWalletKey(expectedPromoHot)) {
            throw new Error(L('领奖目标热钱包地址与协议配置不一致，已拦截签名', 'Promo hot wallet mismatch with protocol config; signature blocked'));
          }
          const feeNano = BigInt(String(intent.feeRequiredNano || '60000000'));
          const feeGramText = formatExactGramFromNano(feeNano);
          const payoutA9 = rawToA9(intent.amountRaw ?? livePromo?.claimableRaw) ?? 0;
          const ok = await tonConnect.confirmBeforeSign({
            title: L('确认推广领币手续费（签名前核验）', 'Confirm Promo A9 Claim Fee'),
            contractLabel: L('推广热钱包 PromoHotWallet', 'PromoHotWallet'),
            targetAddress: intent.payTo,
            principalText: `${formatNum(payoutA9, 2)} A9 (${L('热钱包发放', 'Hot wallet payout')})`,
            gasText: `${feeGramText} GRAM (${L('固定领币费', 'fixed claim fee')})`,
            totalText: `${feeGramText} GRAM`,
            memo: intent.memo,
            note: L(`钱包发起费另计。固定领币费按单收取，发放成功后不按实际成本退差。`, `Wallet sending fees apply separately. The fixed claim fee is charged per order without a cost-based rebate after payout.`),
            confirmText: L(`确认并支付 ${feeGramText} GRAM 领币`, `Confirm & Pay ${feeGramText} GRAM`),
          });
          if (!ok) return;

          await tonConnect.sendV15PromoFee(intent);
          A9Haptic.success();
          showToast(L(`已支付 ${feeGramText} GRAM 手续费（单号 ${intent.claimId}），热钱包正在自动发放 A9…`, `${feeGramText} GRAM fee sent (claim ${intent.claimId}), awaiting automatic A9 payout…`));
          const pendingTx = pendingTxManager.start({
            kind: 'promo',
            title: '推广 A9 自动发放',
            titleEn: 'Promo A9 Payout',
            amountText: `${formatNum(payoutA9, 2)} A9`,
            explorerAddress: intent.payTo,
            refId: intent.claimId,
            targetRoute: '/team/invite',
            maxAttempts: 12,
          });
          pendingTxManager.pollUntilConfirmed({
            txId: pendingTx?.id,
            intervalMs: 4000,
            maxAttempts: 12,
            checkFn: async () => {
              const c = await fetchPromoClaim(intent.claimId);
              if (c) {
                lastClaimStatus = c;
                if (root.isConnected) paint();
                if (c.status === 'COMPLETED') {
                  return {
                    confirmed: true,
                    detail: `推广 ${formatNum(payoutA9, 2)} A9 已自动发放至钱包。`,
                    detailEn: `Promo ${formatNum(payoutA9, 2)} A9 credited on-chain.`,
                  };
                }
                if (c.status === 'FAILED' || c.status === 'EXPIRED') {
                  return { terminal: true, claim: c };
                }
              }
              return false;
            },
            onConfirmed: () => {
              showToast(L('推广 A9 已发放至你的链上钱包！', 'Promo A9 sent to your wallet!'));
              loadLivePromo();
            },
            onTimeout: () => {
              showToast(L('热钱包发放确认较慢，可点击顶部状态条 Tonviewer 核验', 'Payout confirming slowly; check Tonviewer via top bar'), 'amber');
            },
          }).then((res) => {
            if (res?.terminal && res.result?.claim) {
              const st = res.result.claim.status;
              showToast(
                st === 'EXPIRED'
                  ? L(`领奖单 ${intent.claimId} 已过期，余额已保留，可重新发起领取`, `Claim ${intent.claimId} expired; balance kept`)
                  : L(`领奖单 ${intent.claimId} 发放异常，请核查钱包或在记录中重试`, `Claim ${intent.claimId} failed; please check details`),
                'error',
              );
              loadLivePromo();
            }
          });
          await loadLivePromo();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('发起推广领奖失败，请重试', 'Promo claim failed'), 'error');
        } finally {
          promoClaimBusy = false;
          if (root.isConnected) paint();
        }
      };
    }
  };

  paint();
  loadLivePromo();
}
