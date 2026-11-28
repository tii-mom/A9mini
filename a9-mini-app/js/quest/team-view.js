/**
 * Tab 4 · 战队（#/team）— A9 Quest 视图层
 *
 * - 复用 share.js（基于 protocolConfig.botHandle）生成邀请链接与 Telegram 原生分享；
 * - 保留队长绑定/核验 TG 群流程（bindTeamGroupTg / verifyTeamGroupTg）与 5,000 A9 创世金库状态；
 * - 对接 fetchMyChests（5 阶免费任务宝箱，受 chestMall.openEnabled 门控）、fetchPromoBalance、
 *   fetchMyStakeReferrals（好友通关 8% 返佣明细）、fetchRoundAirdropDraws（每关 100,000 A9 空投公示）；
 * - 推广额度图使用静态协议配额，任务进度使用服务端已知数据。
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { escapeHtml, formatNum, copyText, showToast, closeModal } from '../components.js';
import { L } from '../i18n.js';
import { tonConnect } from '../tonconnect.js';
import {
  buildTmaDeepLink,
  buildTeamInviteStartParam,
  buildBotAddGroupUrl,
  getBotHandle,
  isBotHandleConfigured,
  getShareRef,
  normalizeTeamId,
  isValidTeamId,
  LEGACY_TEAM_ID_PATTERN,
} from '../share.js';
import {
  PROTOCOL_SPECS,
  rawToA9,
  formatRoundA9,
  getEffectiveUserId,
  fetchMyChests,
  fetchPromoBalance,
  fetchWalletTeam,
  fetchMyStakeReferrals,
  fetchRoundAirdropDraws,
  openChestById,
  joinTeam,
  bindTeamGroupTg,
  verifyTeamGroupTg,
} from '../data.js';
import {
  qIcon,
  chestArtSvg,
  finiteOrNull,
  fmtExactA9,
  fmtIntOrDash,
  fmtRawGramOrDash,
  openQuestSheet,
} from './quest-ui.js';
import { showFreeChestReward } from './chest-view.js';

let teamViewSeq = 0;

/** 协议静态 6 独立额度桶硬顶配置表（总硬顶 550,000,000 A9，不伪造实时已用值） */
const STATIC_PROMO_BUCKETS = Object.freeze([
  { zh: '商城直推返佣 / 加赠', en: 'Chest Mall Referral & Bonus', capA9: 48_000_000 },
  { zh: '免费任务宝箱', en: 'Free Task Chests', capA9: 100_000_000 },
  { zh: '12 小时预言擂台', en: '12H Prediction Arena', capA9: 100_000_000 },
  { zh: '下轮预热宝箱', en: 'Warm-Up Chests', capA9: 52_000_000 },
  { zh: '好友通关返佣 8%', en: 'Friend Pass 8% Rebate', capA9: 200_000_000 },
  { zh: '每关等权空投（100,000 A9 / 关）', en: 'Per-Stage Equal Airdrop', capA9: 50_000_000 },
]);

function formatTeamActionError(err, fallback) {
  const msg = String(err?.message || err || '');
  if (/NOT_CAPTAIN|403/i.test(msg)) {
    return L('仅队长本人可操作，或该战队编号已被其他队长占用', 'Captain only, or this Squad ID is already owned by another captain');
  }
  if (/TEAM_SWITCH_COOLDOWN/i.test(msg)) {
    return L('换队冷却期内（7 天内不可切换战队）', 'Squad switch cooldown active (7 days)');
  }
  if (/GROUP_ALREADY_BOUND/i.test(msg)) {
    return L('该电报群已绑定其他战队', 'This Telegram group is already bound to another squad');
  }
  if (/not found/i.test(msg)) {
    return L('未找到该战队编号，请核对后重试', 'Squad ID not found. Check and try again.');
  }
  return msg || fallback;
}

function renderRequirement(label, thresholdLabel, current, target, currentText, targetText, unit = '') {
  if (target === null || target <= 0) return '';
  const suffix = unit ? ` ${unit}` : '';
  if (current === null) {
    return `<div class="q-req-tag"><span>${thresholdLabel}</span><b class="q-num">≥ ${targetText}${suffix}</b></div>`;
  }
  const progress = Math.max(0, Math.min(current, target));
  const comparison = `${currentText} / ${targetText}${suffix}`;
  return `<div class="q-req">
    <span>${label}</span>
    <em class="q-num">${comparison}</em>
    <span class="q-mini" role="progressbar" aria-label="${label}" aria-valuenow="${progress}" aria-valuemax="${target}" aria-valuetext="${comparison}"><i class="${current >= target ? 'ok' : ''}" style="width:${progress / target * 100}%"></i></span>
  </div>`;
}

function formatVolume(raw, amount) {
  const exact = fmtRawGramOrDash(raw);
  return exact === '—'
    ? amount?.toLocaleString('en-US', { maximumFractionDigits: 9 }) ?? '—'
    : exact.replace(/ GRAM$/, '');
}

/** 渲染 Tab 4 · 战队主视图 */
export function renderTeamView(root, _navigate, _param = null, query = {}) {
  const seq = ++teamViewSeq;
  const isLive = !config.isDemo;
  const rawInvite = typeof query?.invite === 'string' ? normalizeTeamId(query.invite) : '';
  const initialInviteId = rawInvite && (isValidTeamId(rawInvite) || LEGACY_TEAM_ID_PATTERN.test(rawInvite)) ? rawInvite : '';

  let loadSeq = 0;
  const state = {
    chestsData: null,
    promo: null,
    stakeRefs: null,
    airdrops: [],
    airdropError: false,
    loading: isLive,
    openingFreeId: null,
    team: null,
    teamError: false,
    inviteTeamId: initialInviteId,
    inviteDismissed: false,
    joiningInvite: false,
    inviteError: '',
    inlineJoining: false,
    inlineJoinError: '',
  };

  const openBindTgSheet = () => {
    const botHandle = getBotHandle();
    const botConfigured = isBotHandleConfigured();
    const addGroupUrl = buildBotAddGroupUrl();
    openQuestSheet(
      L('队长绑定 / 核验电报群', 'Captain TG Group Bind & Verify'),
      `
        <div class="q-notice ${botConfigured ? 'blue' : 'amber'}" style="margin-bottom:10px;">
          ${qIcon('shield', 16)}
          <span>${botConfigured
            ? L(`将 @${botHandle} 设为群管理员，再提交群名并发起核验。`, `Add @${botHandle} as a group admin, then submit the handle and verify.`)
            : L('当前环境未配置 Bot，暂无法核验。', 'Group verification requires a configured Bot.')}</span>
        </div>
        ${botConfigured ? `
          <div class="q-btn-row" style="margin-bottom:10px;">
            <button class="q-btn q-btn-ghost q-btn-sm q-grow" id="q-tg-copy-bot" type="button">${L(`复制 @${botHandle}`, `Copy @${botHandle}`)}</button>
            <button class="q-btn q-btn-blue q-btn-sm q-grow" id="q-tg-add-bot" type="button">${L('一键拉 Bot 进群', 'Add Bot to Group')}</button>
          </div>
        ` : ''}
        <div class="q-amt-box" style="margin-bottom:10px;">
          <input id="q-tg-handle-input" type="text" aria-label="${L('电报群用户名', 'Telegram group handle')}" placeholder="@YourSquadGroup" style="font-size:16px;font-weight:700;" ${botConfigured ? '' : 'disabled'} />
        </div>
        <div class="q-btn-row">
          <button class="q-btn q-btn-ghost q-grow q-btn-sm" id="q-tg-submit-bind" type="button" ${botConfigured ? '' : 'disabled'}>${L('提交群名', 'Submit Handle')}</button>
          <button class="q-btn q-btn-blue q-grow q-btn-sm" id="q-tg-verify-now" type="button" ${botConfigured ? '' : 'disabled'}>${L('发起群核验', 'Verify Group')}</button>
        </div>
      `
    );

    const copyBotBtn = document.getElementById('q-tg-copy-bot');
    if (copyBotBtn && botHandle) {
      copyBotBtn.onclick = () => copyText(`@${botHandle}`, L(`已复制 @${botHandle}`, `Copied @${botHandle}`));
    }
    const addBotBtn = document.getElementById('q-tg-add-bot');
    if (addBotBtn && addGroupUrl) {
      addBotBtn.onclick = () => A9TMA.openExternalLink(addGroupUrl);
    }

    const teamId = isLive ? state.team?.teamId : store.state.team?.id;
    const bindBtn = document.getElementById('q-tg-submit-bind');
    const verifyBtn = document.getElementById('q-tg-verify-now');
    const inp = document.getElementById('q-tg-handle-input');
    let sheetBusy = false;

    const setSheetBusy = (busy, mode = '') => {
      sheetBusy = busy;
      if (bindBtn) {
        bindBtn.disabled = busy || !botConfigured;
        bindBtn.textContent = busy && mode === 'bind' ? L('提交中…', 'Submitting…') : L('提交群名', 'Submit Handle');
      }
      if (verifyBtn) {
        verifyBtn.disabled = busy || !botConfigured;
        verifyBtn.textContent = busy && mode === 'verify' ? L('核验中…', 'Verifying…') : L('发起群核验', 'Verify Group');
      }
    };

    if (bindBtn) {
      bindBtn.onclick = async () => {
        if (sheetBusy || !botConfigured) return;
        const handle = String(inp?.value || '').trim();
        if (!handle) {
          showToast(L('请输入有效的电报群用户名', 'Enter a valid Telegram group handle'), 'amber');
          return;
        }
        setSheetBusy(true, 'bind');
        try {
          await bindTeamGroupTg({ teamId, tgGroupHandle: handle });
          showToast(L('已提交待核验，请完成 Bot 入群授权后点击核验', 'Submitted for verification'));
        } catch (e) {
          showToast(formatTeamActionError(e, L('提交群绑定失败', 'Bind request failed')), 'error');
        } finally {
          setSheetBusy(false);
        }
      };
    }

    if (verifyBtn) {
      verifyBtn.onclick = async () => {
        if (sheetBusy || !botConfigured) return;
        setSheetBusy(true, 'verify');
        try {
          await verifyTeamGroupTg({ teamId });
          A9Haptic.success();
          showToast(L('Telegram 群核验已通过！', 'Telegram group verified!'));
          closeModal();
          void loadAll();
        } catch (e) {
          showToast(formatTeamActionError(e, L('群核验未通过，请确认 Bot 已入群且为管理员', 'Verification failed; ensure Bot is group admin')), 'error');
        } finally {
          setSheetBusy(false);
        }
      };
    }
  };

  const paint = () => {
    if (seq !== teamViewSeq || !root.isConnected) return;
    const t = (isLive ? state.team : store.state.team) || {};
    const rawRole = String(t.role || (t.teamId || t.id ? 'member' : 'none')).toLowerCase();
    const role = rawRole === 'captain' ? 'captain' : rawRole === 'member' ? 'member' : 'none';
    const roleLabel = role === 'captain' ? L('队长', 'Captain') : role === 'member' ? L('成员', 'Member') : '';
    const groupBound = isLive ? t.bindStatus === 'bound' : Boolean(t.tgGroupBound);
    const activeTeamId = isLive ? String(t.teamId || '').trim() : (role !== 'none' ? String(t.id || '').trim() : '');
    const teamName = (role !== 'none' && (t.name || activeTeamId)) || (state.loading
      ? L('战队同步中…', 'Syncing squad…')
      : state.teamError
        ? L('战队读取失败', 'Squad unavailable')
        : role === 'none' ? L('尚未加入战队', 'No squad yet') : L('A9 冲关小队', 'A9 Quest Squad'));
    const refCode = getShareRef();
    const botConfigured = isBotHandleConfigured();
    const inviteStartParam = buildTeamInviteStartParam(activeTeamId, refCode);
    const inviteLink = botConfigured && inviteStartParam ? buildTmaDeepLink(inviteStartParam) : '';
    const shareCopy = activeTeamId
      ? L(
          `加入我的 A9 战队（#${activeTeamId}），一起冲关。`,
          `Join my A9 Squad (#${activeTeamId}) for Price-Unlock rounds.`
        )
      : L(
          '和我一起体验 A9 涨价解锁冲关。',
          'Join me for A9 Price-Unlock rounds.'
        );
    const referrerLabel = store.state.referral?.referrerId ? String(store.state.referral.referrerId) : '';
    const alreadyInInvited = Boolean(
      state.inviteTeamId && activeTeamId && activeTeamId.toUpperCase() === state.inviteTeamId.toUpperCase()
    );
    const promoDisplay = isLive
      ? formatRoundA9(state.promo?.claimableRaw ?? state.promo?.availableRaw)
      : fmtExactA9(store.state.user.promoClaimableA9);
    const refTotalDisplay = formatRoundA9(state.stakeRefs?.totalCommissionRaw);
    const refCount = finiteOrNull(state.stakeRefs?.count);

    const chestsData = state.chestsData || {};
    const freeChests = Array.isArray(chestsData.freeChests) ? chestsData.freeChests : [];
    const freeTierSource = chestsData.freeTiers ?? store.state.round?.chestMall?.freeTiers;
    const freeTiersCfg = Array.isArray(freeTierSource) ? freeTierSource : [];
    const openEnabled = config.isDemo || Boolean(store.state.round?.chestMall?.openEnabled === true && store.fundsEnabled);
    const captainPaid = Boolean(isLive ? t.captainVaultPaid : chestsData.captainVaultPaid || chestsData.foundingBonusPaid);
    const tierKey = (ch) => `${String(ch.tier || '').toLowerCase()}:${ch.slotIndex ?? 1}`;
    const configuredKeys = new Set(freeTiersCfg.map(tierKey));
    const chestsByTier = new Map(freeChests.map((ch) => [tierKey(ch), ch]));
    const displayTiers = [
      ...freeTiersCfg.map((spec) => ({ ...spec, ...chestsByTier.get(tierKey(spec)) })),
      ...freeChests.filter((ch) => !configuredKeys.has(tierKey(ch))),
    ];

    root.innerHTML = `
      <div class="q-view" id="quest-team-view" data-team-role="${escapeHtml(role)}">
        ${state.inviteTeamId && !state.inviteDismissed ? `
          <section class="q-card" id="q-team-invite-card" data-invite-team="${escapeHtml(state.inviteTeamId)}">
            <div class="q-card-h">
              <h3>${qIcon('team', 18)} ${L('收到战队邀请', 'Squad Invitation')}</h3>
              <span class="q-chip q-chip-blue">#${escapeHtml(state.inviteTeamId)}</span>
            </div>
            <div class="q-small q-muted" style="line-height:1.5;margin-bottom:10px;">
              ${alreadyInInvited ? L('你已加入这支战队。', 'You already belong to this squad.') : L('免费入队，无需锁仓。', 'Free to join without locking A9.')}
              ${!alreadyInInvited && referrerLabel ? ` ${L('邀请人', 'Invited by')} ${escapeHtml(referrerLabel)}` : ''}
            </div>
            ${state.inviteError ? `<div class="q-notice red" style="margin-bottom:10px;">${escapeHtml(state.inviteError)}</div>` : ''}
            <div class="q-btn-row">
              <button class="q-btn q-btn-blue q-btn-sm q-grow" id="q-confirm-invite-join" type="button" ${state.joiningInvite ? 'disabled' : ''}>
                ${state.joiningInvite
                  ? L('加入中…', 'Joining…')
                  : alreadyInInvited
                    ? L('已知晓', 'Got It')
                    : L('确认加入战队', 'Confirm Join Squad')}
              </button>
              <button class="q-btn q-btn-ghost q-btn-sm" id="q-dismiss-invite" type="button" ${state.joiningInvite ? 'disabled' : ''}>${L('暂不', 'Later')}</button>
            </div>
          </section>
        ` : ''}

        <section class="q-hero q-hero--blue q-team-hero">
          <span class="q-wm" style="font-size:96px;">${qIcon('team', 108, 1.3)}</span>
          ${roleLabel || captainPaid ? `<div class="q-hero-top">
            ${roleLabel ? `<span class="q-cart-tag">${roleLabel}</span>` : ''}
            ${captainPaid ? `<span class="q-phase-pill">${L('创世金库已发 5,000 A9', 'Founding Vault paid 5,000 A9')}</span>` : ''}
          </div>` : ''}
          <h2 class="q-hero-count">${escapeHtml(teamName)}</h2>
          <dl class="q-team-rebates">
            <div><dt>${L('好友购箱返佣', 'Chest rebate')}</dt><dd class="q-num">${PROTOCOL_SPECS.referralPct}%</dd></div>
            <div><dt>${L('好友通关返佣', 'Pass rebate')}</dt><dd class="q-num">${PROTOCOL_SPECS.stakeReferralPct}%</dd></div>
            <div><dt>${L('每次购箱助力', 'Assists per chest')}</dt><dd class="q-num">3</dd></div>
          </dl>
          <div class="q-btn-row q-team-invite-actions">
            <button class="q-btn q-btn-white is-blue q-btn-sm q-grow" id="q-share-invite" type="button" ${inviteLink ? '' : 'disabled'}>${qIcon('share', 15)} ${L('分享邀请', 'Share invite')}</button>
            <button class="q-btn q-btn-glass q-btn-sm q-grow" id="q-copy-invite" type="button" ${inviteLink ? '' : 'disabled'}>${qIcon('copy', 15)} ${L('复制链接', 'Copy link')}</button>
          </div>
          ${!inviteLink ? `<p class="q-team-invite-note">${(botConfigured ? L('当前战队和推荐信息无法生成完整邀请链接。', 'A complete squad referral link could not be generated.') : L('当前环境暂不可生成邀请链接。', 'Invite links are unavailable here.'))}</p>` : ''}
        </section>

        <section class="q-card" id="team-commission-summary">
          <div class="q-card-h">
            <h3>${qIcon('gift', 18)} ${L('推广返佣', 'Referral earnings')}</h3>
            <a class="q-chip q-chip-green" href="#/rewards" style="text-decoration:none;">${L('去金库领取', 'Claim in Vault')} ›</a>
          </div>
          <div class="q-grid2">
            <div class="q-stat">
              <small>${L('可领推广余额', 'Claimable balance')}</small>
              <b class="q-num">${escapeHtml(promoDisplay)}</b>
            </div>
            <div class="q-stat">
              <small>${L('累计通关返佣', 'Total pass rebates')}</small>
              <b class="q-num">${escapeHtml(refTotalDisplay)}</b>
              ${refCount === null ? '' : `<span>${L(`${fmtIntOrDash(refCount)} 笔记录`, `${fmtIntOrDash(refCount)} records`)}</span>`}
            </div>
          </div>
        </section>

        <section class="q-card" id="q-captain-tg-card">
          <div class="q-card-h">
            <h3>${qIcon('team', 18)} ${role === 'none' ? L('加入或创建战队', 'Join or create a squad') : L('战队与电报群', 'Squad & Telegram group')}</h3>
            ${role === 'none' ? '' : `<span class="q-chip ${groupBound ? 'q-chip-green' : ''}">${groupBound ? L('群已核验', 'Group verified') : isLive && !t.bindStatus ? L('待同步', 'Pending sync') : t.bindStatus === 'verifying' ? L('核验中', 'Verifying') : L('待绑定', 'Unbound')}</span>`}
          </div>
          ${role === 'none' ? '' : `
            <div class="q-grid2 q-team-group-stats">
              <div class="q-stat"><small>${L('战队成员', 'Squad members')}</small><b class="q-num">${fmtIntOrDash(t.memberCount)}</b></div>
              <div class="q-stat"><small>${L('认证群人数', 'Verified group size')}</small><b class="q-num">${groupBound ? fmtIntOrDash(t.tgMemberCount) : '—'}</b></div>
            </div>
          `}
          ${role === 'captain' && !captainPaid ? `<p class="q-team-group-note q-small q-muted">${L('群核验达 50 人且战队满 3 人，可获 5,000 A9 创世金库资格。', 'A verified group of 50 and a squad of 3 qualify for the 5,000 A9 Founding Vault.')}</p>` : ''}
          ${role === 'none' ? `
            <form id="q-join-team-form" style="margin-bottom:10px;">
              <div class="q-btn-row">
                <div class="q-amt-box q-grow" style="margin:0;">
                  <input id="q-join-team-input" name="teamId" type="text" aria-label="${L('战队编号', 'Squad ID')}" placeholder="TM-0001" maxlength="48" style="font-size:15px;font-weight:700;" ${state.inlineJoining ? 'disabled' : ''} />
                </div>
                <button class="q-btn q-btn-ghost q-btn-sm" id="q-join-team-submit" type="submit" ${state.inlineJoining ? 'disabled' : ''}>${state.inlineJoining ? L('加入中…', 'Joining…') : L('加入战队', 'Join')}</button>
              </div>
              ${state.inlineJoinError ? `<div class="q-small" style="color:var(--nt-red-ink);margin-top:6px;">${escapeHtml(state.inlineJoinError)}</div>` : ''}
            </form>
          ` : ''}
          <div class="q-btn-row">
            ${role === 'member'
              ? `<button class="q-btn q-btn-ghost q-btn-sm q-grow" id="q-open-bind-tg" type="button" disabled>${L('仅队长可绑定电报群', 'Captain Only')}</button>`
              : `<button class="q-btn q-btn-blue q-btn-sm q-grow" id="q-open-bind-tg" type="button">${role === 'captain' ? L('绑定 / 核验电报群', 'Bind / Verify TG Group') : L('创建战队并绑群', 'Create Squad & Bind TG')}</button>`}
            <a class="q-btn q-btn-ghost q-btn-sm" href="#/team/invite">${L('海报邀请', 'Poster')}</a>
          </div>
        </section>

        <section class="q-card" id="q-free-ladder-card">
          <div class="q-card-h">
            <h3>${qIcon('chest', 18)} ${L('战队任务宝箱', 'Squad task chests')}</h3>
            ${openEnabled ? '' : `<span class="q-chip">${L('暂未开放', 'Closed')}</span>`}
          </div>
          ${displayTiers.length === 0 ? `
            <div class="q-small q-muted">${state.loading ? L('任务同步中…', 'Syncing tasks…') : L('在 Telegram 小程序内查看任务。', 'Open the Telegram Mini App to view tasks.')}</div>
          ` : `
            <div class="q-ladder">
              ${displayTiers.map((ch) => {
                const tier = String(ch.tier || 'bronze').toLowerCase();
                const status = String(ch.status || 'LOCKED').toUpperCase();
                const isDone = status === 'OPENED' || status === 'CLAIMED';
                const chestId = ch.chestId || ch.id || '';
                const isReady = Boolean(chestId && (status === 'READY' || ch.canOpen === true));
                const rewardRaw = ch.baseA9Raw ?? ch.rewardA9Raw;
                const rewardText = rewardRaw == null ? fmtExactA9(ch.rewardA9) : formatRoundA9(rewardRaw);
                const curA = finiteOrNull(ch.currentAssists);
                const reqA = finiteOrNull(ch.requiredAssists);
                const minVolGram = rawToA9(ch.minVolumeNano) ?? finiteOrNull(ch.minVolumeGram);
                const curVolGram = rawToA9(ch.currentVolumeNano) ?? finiteOrNull(ch.currentVolumeGram);
                const minTg = finiteOrNull(ch.minTgMembers);
                const curTg = finiteOrNull(ch.currentTgMembers);
                const requirements = [
                  renderRequirement(L('助力', 'Assists'), L('助力门槛', 'Assists required'), curA, reqA, fmtIntOrDash(curA), fmtIntOrDash(reqA)),
                  renderRequirement(L('战队流水', 'Squad volume'), L('战队流水门槛', 'Volume required'), curVolGram, minVolGram, formatVolume(ch.currentVolumeNano, curVolGram), formatVolume(ch.minVolumeNano, minVolGram), 'GRAM'),
                  renderRequirement(L('认证电报群人数', 'Verified group size'), L('认证电报群门槛', 'Verified group required'), curTg, minTg, fmtIntOrDash(curTg), fmtIntOrDash(minTg), L('人', 'members')),
                ].join('');
                return `
                  <div class="q-rung ${isDone ? 'done' : isReady ? 'ready' : ''}">
                    <div class="q-team-rung-header">
                      ${chestArtSvg(tier, 46)}
                      <div>
                        <b>${escapeHtml(L(ch.labelZh || ch.zh || ch.name || tier, ch.labelEn || ch.en || ch.name || tier))}</b>
                        <span class="q-rw q-num">${escapeHtml(rewardText)}</span>
                      </div>
                      ${isDone
                        ? `<span class="q-chip q-chip-green">${L('已领', 'Claimed')}</span>`
                        : isReady
                          ? `<button type="button" class="q-btn q-btn-red q-btn-sm" data-q-open-free="${escapeHtml(chestId)}" ${openEnabled ? '' : 'disabled'}>${L('开启', 'Open')}</button>`
                          : `<span class="q-chip">${chestId && status !== 'LOCKED' ? L('进行中', 'In progress') : L('未解锁', 'Locked')}</span>`}
                    </div>
                    ${requirements ? `<div class="q-team-requirements">${requirements}</div>` : reqA === 0 ? `<p class="q-team-rung-note q-small q-muted">${L('免助力', 'No assists required')}</p>` : ''}
                  </div>
                `;
              }).join('')}
            </div>
          `}
        </section>

        <section class="q-card" id="q-airdrop-draws-card">
          <div class="q-card-h">
            <h3>${qIcon('dice', 18)} ${L('每关等权空投', 'Stage airdrops')}</h3>
            <span class="q-chip q-chip-blue q-num">100,000 A9</span>
          </div>
          <p class="q-team-group-note q-small q-muted">${L(`锁仓满 ${PROTOCOL_SPECS.minStakeA9} A9 即入池，结算后等权开奖。`, `Lock ${PROTOCOL_SPECS.minStakeA9} A9 to enter. Equal odds after settlement.`)}</p>
          ${state.airdrops.length === 0 ? `
            <div class="q-small q-muted">${state.loading ? L('开奖结果同步中…', 'Syncing draws…') : state.airdropError ? L('开奖结果读取失败', 'Draws unavailable') : L('暂无开奖记录', 'No draws yet')}</div>
          ` : `
            <div class="q-feed q-team-draws">
              ${state.airdrops.slice(0, 5).map((d) => `
                <div class="q-feed-i">
                  <span class="q-chip q-chip-blue">${L(`第 ${fmtIntOrDash(d.roundId)} 关`, `Stage ${fmtIntOrDash(d.roundId)}`)}</span>
                  <span class="q-amt q-num">${formatRoundA9(d.prizeRaw)}</span>
                  <span class="q-who q-num">${escapeHtml(d.winnerWallet || '—')}</span>
                  ${d.seedHash ? `<details class="q-details"><summary>${L('SHA-256 种子', 'SHA-256 seed')}</summary><code>${escapeHtml(d.seedHash)}</code></details>` : ''}
                </div>
              `).join('')}
            </div>
          `}
        </section>

        <section class="q-card" id="q-promo-cap-card">
          <div class="q-card-h">
            <h3>${qIcon('shield', 18)} ${L('推广奖励上限', 'Promo reward cap')}</h3>
          </div>
          <strong class="q-team-cap-total q-num">${formatNum(PROTOCOL_SPECS.promoCapA9)} A9</strong>
          <details class="q-details" id="q-promo-buckets-details">
            <summary>${L('6 独立额度桶', '6 independent caps')}</summary>
            <p class="q-small q-muted q-team-group-note">${L('各项占总预算的比例，用完即停。', 'Share of the total budget. Each cap applies independently.')}</p>
            <div class="q-team-cap-chart">
              ${STATIC_PROMO_BUCKETS.map((b) => {
                const share = b.capA9 / PROTOCOL_SPECS.promoCapA9 * 100;
                return `<div>
                  <div class="q-team-cap-label"><span>${escapeHtml(L(b.zh, b.en))}</span><b class="q-num">${formatNum(b.capA9)} A9</b></div>
                  <div class="q-team-cap-plot"><span aria-hidden="true"><i style="width:${share}%"></i></span><b class="q-num">${formatNum(share, 1)}%</b></div>
                </div>`;
              }).join('')}
            </div>
          </details>
        </section>
      </div>
    `;

    const executeJoin = async (targetTeamId, mode = 'invite') => {
      const normalized = normalizeTeamId(targetTeamId);
      if (!normalized) return;
      if (isLive && (!store.state.user.connected || !store.state.user.address)) {
        tonConnect.openConnectModal(() => {
          if (seq === teamViewSeq && root.isConnected) paint();
        });
        return;
      }
      if (mode === 'invite') {
        state.joiningInvite = true;
        state.inviteError = '';
      } else {
        state.inlineJoining = true;
        state.inlineJoinError = '';
      }
      paint();
      try {
        await joinTeam({
          teamId: normalized,
          walletAddress: store.state.user.address,
          userId: getEffectiveUserId(store.state.user),
          referrerId: store.state.referral?.referrerId || null,
        });
        A9Haptic.success();
        if (!isLive) {
          store.update((s) => {
            s.team.role = 'member';
            s.team.id = normalized;
            if (!s.team.name || s.team.role === 'none') s.team.name = normalized;
          });
        }
        showToast(L(`已加入战队 #${normalized}`, `Joined Squad #${normalized}`));
        if (mode === 'invite') {
          state.inviteDismissed = true;
          state.joiningInvite = false;
          if (typeof _navigate === 'function') _navigate('/team', { replace: true });
        } else {
          state.inlineJoining = false;
        }
        if (isLive) void loadAll();
        else paint();
      } catch (e) {
        const errMsg = formatTeamActionError(e, L('加入战队失败，请核对编号后重试', 'Failed to join squad. Check the ID and retry.'));
        if (mode === 'invite') {
          state.joiningInvite = false;
          state.inviteError = errMsg;
        } else {
          state.inlineJoining = false;
          state.inlineJoinError = errMsg;
        }
        showToast(errMsg, 'error');
        paint();
      }
    };

    const confirmInviteBtn = root.querySelector('#q-confirm-invite-join');
    if (confirmInviteBtn) {
      confirmInviteBtn.onclick = () => {
        if (state.joiningInvite) return;
        if (alreadyInInvited) {
          state.inviteDismissed = true;
          if (typeof _navigate === 'function') _navigate('/team', { replace: true });
          paint();
          return;
        }
        void executeJoin(state.inviteTeamId, 'invite');
      };
    }

    const dismissInviteBtn = root.querySelector('#q-dismiss-invite');
    if (dismissInviteBtn) {
      dismissInviteBtn.onclick = () => {
        state.inviteDismissed = true;
        if (typeof _navigate === 'function') _navigate('/team', { replace: true });
        paint();
      };
    }

    const inlineForm = root.querySelector('#q-join-team-form');
    if (inlineForm) {
      inlineForm.onsubmit = (ev) => {
        ev.preventDefault();
        if (state.inlineJoining) return;
        const inputVal = normalizeTeamId(inlineForm.elements.teamId?.value || '');
        if (!isValidTeamId(inputVal)) {
          state.inlineJoinError = L('请输入有效战队编号（格式：TM- / TEAM- / G- / T- 开头，如 TM-0001）', 'Enter a valid Squad ID (e.g. TM-0001, TEAM-ALPHA)');
          paint();
          return;
        }
        void executeJoin(inputVal, 'inline');
      };
    }

    const copyBtn = root.querySelector('#q-copy-invite');
    if (copyBtn) {
      copyBtn.onclick = () => {
        if (!botConfigured || !inviteLink) return;
        copyText(inviteLink, L('邀请链接已复制', 'Invite link copied'));
      };
    }

    const shareBtn = root.querySelector('#q-share-invite');
    if (shareBtn) {
      shareBtn.onclick = () => {
        if (!botConfigured || !inviteLink) return;
        A9Haptic.light();
        A9TMA.shareInvite(inviteLink, shareCopy);
        showToast(L('已调起 Telegram 分享', 'Opened Telegram share'));
      };
    }

    const bindTgBtn = root.querySelector('#q-open-bind-tg');
    if (bindTgBtn) bindTgBtn.onclick = () => {
      if (isLive && (!state.team?.teamId || state.team.role !== 'captain')) _navigate('/team/bind-tg');
      else openBindTgSheet();
    };

    root.querySelectorAll('[data-q-open-free]').forEach((btn) => {
      btn.onclick = async () => {
        const cid = btn.dataset.qOpenFree;
        if (!cid || state.openingFreeId) return;
        if (isLive && (!store.state.user.connected || !store.state.user.address)) {
          tonConnect.openConnectModal(() => void loadAll());
          return;
        }
        state.openingFreeId = cid;
        btn.disabled = true;
        try {
          const res = await openChestById(cid, store.state, store.state.user.address);
          showFreeChestReward(res);
          void loadAll();
        } catch (e) {
          showToast(e?.message || L('开启任务宝箱失败', 'Failed to open task chest'), 'error');
        } finally {
          state.openingFreeId = null;
          if (btn.isConnected) btn.disabled = !openEnabled;
        }
      };
    });
  };

  const loadAll = async () => {
    const reqLoadSeq = ++loadSeq;
    const addr = store.state.user.connected ? store.state.user.address : null;
    const [chRes, prRes, srRes, adRes, teamRes] = await Promise.allSettled([
      fetchMyChests(),
      (isLive && addr) ? fetchPromoBalance(addr) : Promise.resolve(null),
      fetchMyStakeReferrals(30),
      fetchRoundAirdropDraws({ limit: 8 }),
      (isLive && addr) ? fetchWalletTeam(addr) : Promise.resolve(null),
    ]);
    if (seq !== teamViewSeq || reqLoadSeq !== loadSeq || !root.isConnected) return;
    if (isLive && addr !== (store.state.user.connected ? store.state.user.address : null)) return;
    state.team = teamRes.status === 'fulfilled' ? teamRes.value : null;
    state.teamError = teamRes.status === 'rejected';
    if (chRes.status === 'fulfilled' && chRes.value) state.chestsData = chRes.value;
    if (prRes.status === 'fulfilled' && prRes.value) state.promo = prRes.value;
    if (srRes.status === 'fulfilled' && srRes.value) state.stakeRefs = srRes.value;
    state.airdropError = adRes.status === 'rejected';
    if (adRes.status === 'fulfilled' && adRes.value) {
      state.airdrops = Array.isArray(adRes.value?.items) ? adRes.value.items : (Array.isArray(adRes.value) ? adRes.value : []);
    }
    state.loading = false;
    paint();
  };

  paint();
  void loadAll();
}
