import { peekDemoModule } from '../demo-loader.js';
import {
  fetchWarmupCurrent,
  fetchPredictionUser,
  fetchWarmupRank,
  fetchMyChests,
  claimStarterChests,
  openChestById,
  openAllChests,
  fetchChestCritFeed,
  requestChestPurchaseIntent,
  fetchPresaleQuota,
  fetchPresaleOrders,
  registerWarmup,
  cancelWarmup,
  getEffectiveUserId,
  rawToA9,
  loadSnapshot,
  mapRoundView,
  PROTOCOL_SPECS,
} from '../data.js';
/**
 * Warm-up v2 & Chest Mall Pages
 * - Warm-up v2: Zero-friction TG reservation, real-time participant count & progress bar,
 *   optional A9 intent tier, Bot opening reminder, and per-round WARMUP_ROUND viral chest
 *   (2 valid active-wallet friends = 300 A9 base, up to 5 = 900 A9 max -> PENDING_VAULT).
 * - Paid Chest Mall: 6 fixed integer SKUs (0.99 / 4.99 / 9.99 / 19.99 / 99.99 / 500 GRAM).
 * - Free Chests: 5-tier ladder — Bronze Starter (200 A9, 0-assist instant) -> Silver -> Gold -> Platinum -> Diamond.
 * - Live mode stays strictly read-only on purchase/chest-open actions unless store.fundsEnabled.
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { tonConnect, canonicalWalletKey } from '../tonconnect.js';
import { pendingTxManager } from '../tx-ux.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, formatTimer, showToast, copyText, openModal, closeModal, openChoiceSheet } from '../components.js';
import { burstParticles } from '../components-heavy.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { renderChestSvg, resolveChestTier, CHEST_TIER_META } from '../chest-art.js';
import { openChestUnboxingTheater } from '../chest-theater.js';
import { openXShareSheet, buildOgShareUrl, buildTmaDeepLink, getShareRef } from '../share.js';

const TIER_PRIORITY = ['legendary', 'diamond', 'platinum', 'gold', 'silver', 'bronze'];

function openChestCelebrationModal(opts = {}) {
  openChestUnboxingTheater(opts);
}

const WARMUP_INTENT_OPTIONS = [
  { key: '100',        zh: '100 A9',     en: '100 A9' },
  { key: '1000',       zh: '1,000 A9',   en: '1,000 A9' },
  { key: '5000',       zh: '5,000 A9',   en: '5,000 A9' },
  { key: '20000_plus', zh: '20,000+ A9', en: '20,000+ A9' },
  { key: 'watching',   zh: '先观望',     en: 'Watching' },
];

function parsePositiveRawBigInt(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!/^\d+$/.test(s)) return null;
  try {
    const bi = BigInt(s);
    return bi > 0n ? bi : null;
  } catch {
    return null;
  }
}

/**
 * 根据服务端 /api/warmup/current 的 config 动态生成预热奖励阶梯，并严格校验单调递增。
 * 任意配置缺失、非正整数、min > max、或相邻档位非严格递增均返回 { valid: false, tiers: [] }，
 * 界面统一呈现「配置待确认」，绝不回落至写死阶梯。
 */
export function buildWarmupLadder(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    return { valid: false, tiers: [], minInvites: null, maxInvites: null, baseA9: null, maxA9: null };
  }

  let rawTiers = [];
  if (Array.isArray(cfg.tiers) && cfg.tiers.length > 0) {
    for (const item of cfg.tiers) {
      const inv = Number(item?.invites);
      const amtRaw = parsePositiveRawBigInt(item?.amountRaw ?? item?.a9Raw);
      const amtA9 = amtRaw !== null ? rawToA9(amtRaw.toString()) : (Number.isFinite(Number(item?.a9)) && Number(item.a9) > 0 ? Number(item.a9) : null);
      if (!Number.isInteger(inv) || inv < 1 || amtA9 === null || amtA9 <= 0) {
        return { valid: false, tiers: [], minInvites: null, maxInvites: null, baseA9: null, maxA9: null };
      }
      rawTiers.push({ invites: inv, amountRaw: amtRaw ?? BigInt(Math.round(amtA9 * 1e9)), amountA9: amtA9 });
    }
  } else {
    const minInv = Number(cfg.chestMinInvites);
    const maxInv = Number(cfg.chestMaxInvites);
    const baseRaw = parsePositiveRawBigInt(cfg.chestBaseA9Raw);
    const stepRaw = parsePositiveRawBigInt(cfg.chestStepA9Raw);
    if (!Number.isInteger(minInv) || !Number.isInteger(maxInv) || minInv < 1 || maxInv < minInv || maxInv > 20 || baseRaw === null) {
      return { valid: false, tiers: [], minInvites: null, maxInvites: null, baseA9: null, maxA9: null };
    }
    if (maxInv > minInv && stepRaw === null) {
      return { valid: false, tiers: [], minInvites: null, maxInvites: null, baseA9: null, maxA9: null };
    }
    for (let inv = minInv; inv <= maxInv; inv += 1) {
      const amountRaw = baseRaw + BigInt(inv - minInv) * (stepRaw ?? 0n);
      const amountA9 = rawToA9(amountRaw.toString());
      if (amountA9 === null || amountA9 <= 0) {
        return { valid: false, tiers: [], minInvites: null, maxInvites: null, baseA9: null, maxA9: null };
      }
      rawTiers.push({ invites: inv, amountRaw, amountA9 });
    }
  }

  // 严格校验人数与奖励金额双重单调递增
  for (let i = 1; i < rawTiers.length; i += 1) {
    if (rawTiers[i].invites <= rawTiers[i - 1].invites || rawTiers[i].amountRaw <= rawTiers[i - 1].amountRaw) {
      return { valid: false, tiers: [], minInvites: null, maxInvites: null, baseA9: null, maxA9: null };
    }
  }

  const first = rawTiers[0];
  const last = rawTiers[rawTiers.length - 1];
  return {
    valid: true,
    tiers: rawTiers,
    minInvites: first.invites,
    maxInvites: last.invites,
    baseA9: first.amountA9,
    maxA9: last.amountA9,
  };
}

/**
 * 可独立嵌入的预热主体组件（避开 round_stages.js 既有的 renderWarmupStage 字符串函数）。
 * 供 5d 闯关第 0 阶段直接挂载，也供 /round?stage=warmup（及旧别名 /warmup）调用。
 */
export function mountWarmupSection(root, ctx = {}) {
  if (!root) return;
  const query = ctx.query || {};
  const queryRoundId = Number(ctx.roundId ?? query?.round);
  const requestedRoundId = Number.isInteger(queryRoundId) && queryRoundId >= 1 ? queryRoundId : null;
  let loadSeq = 0;
  const state = {
    loading: true,
    error: null,
    data: null,
    busy: false,
    selectedTier: null,
    remindEnabled: false,
  };

  const isChestOpenEnabled = () => {
    if (config.isDemo) return true;
    const mallCfg = store.state.round?.protocolConfig?.chestMall ?? store.state.round?.chestMall;
    return Boolean(store.fundsEnabled && mallCfg?.openEnabled === true);
  };

  const formatPlannedOpen = (rawVal) => {
    const n = Number(rawVal);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n < 1e12 ? n * 1000 : n;
    try {
      const d = new Date(ms);
      if (Number.isNaN(d.getTime())) return null;
      return d.toLocaleString(L('zh-CN', 'en-US'), {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return null;
    }
  };

  const load = async () => {
    const seq = ++loadSeq;
    state.loading = true;
    state.error = null;
    if (root.isConnected) paint();
    try {
      const data = await fetchWarmupCurrent(requestedRoundId);
      if (seq !== loadSeq || !root.isConnected) return;
      state.data = data;
      state.loading = false;
      const myRes = data?.myReservation;
      state.selectedTier = myRes && myRes.status === 'ACTIVE' ? (myRes.intentTier ?? null) : null;
      state.remindEnabled = Boolean(myRes && myRes.status === 'ACTIVE' && myRes.remindEnabled);
      store.update((s) => {
        s.user.warmupRegistered = Boolean(data?.isReserved || (myRes && myRes.status === 'ACTIVE'));
        s.user.warmupInvites = Number(myRes?.validInvites || 0);
      });
    } catch (e) {
      if (seq !== loadSeq || !root.isConnected) return;
      state.loading = false;
      state.error = e?.message || L('预热数据暂不可读取，请重试', 'Warm-up data unavailable');
    }
    if (root.isConnected) paint();
  };

  const paint = () => {
    const d = state.data;
    const onchainRound = Number(d?.currentOnchainRoundId ?? store.state.round?.currentRound);
    const targetRoundId =
      (Number.isInteger(Number(d?.roundId)) && Number(d?.roundId) >= 1 ? Number(d.roundId) : null) ||
      requestedRoundId ||
      (Number.isInteger(onchainRound) && onchainRound >= 1 ? onchainRound + 1 : null);
    const roundTitleZh = targetRoundId ? `第 ${targetRoundId} 轮开局预热` : '下轮开局预热';
    const roundTitleEn = targetRoundId ? `Round ${targetRoundId} Warm-Up` : 'Next Round Warm-Up';

    const hasStats = Boolean(d && d.stats && typeof d.stats === 'object');
    const totalRegistered = (hasStats && d.stats.totalRegistered !== null && d.stats.totalRegistered !== undefined && Number.isFinite(Number(d.stats.totalRegistered)))
      ? Number(d.stats.totalRegistered)
      : null;
    const targetUsers = (d?.config && d.config.targetUsers !== null && d.config.targetUsers !== undefined && Number.isFinite(Number(d.config.targetUsers)) && Number(d.config.targetUsers) > 0)
      ? Number(d.config.targetUsers)
      : null;
    const progressPct = (totalRegistered !== null && targetUsers !== null)
      ? Math.max(0, Math.min(100, Math.round((totalRegistered / targetUsers) * 100)))
      : (hasStats && d.stats.progressPct !== null && d.stats.progressPct !== undefined && Number.isFinite(Number(d.stats.progressPct))
        ? Math.max(0, Math.min(100, Number(d.stats.progressPct)))
        : 0);

    const loadFailed = Boolean(!d && state.error);
    const isRoundOpen = d ? Boolean(d.open) : false;
    const myRes = d?.myReservation && d.myReservation.status === 'ACTIVE' ? d.myReservation : null;
    const chest = d?.myWarmupChest || null;
    const isReserved = Boolean(myRes);
    const hasTgAuth = config.isDemo || Boolean(A9TMA.getRawInitData());

    const linkRoundTag = targetRoundId ?? 'next';
    const fallbackDeepLink = config.isDemo
      ? `${window.location.origin}${window.location.pathname}?startapp=warmup_${linkRoundTag}_demo01`
      : buildTmaDeepLink(`warmup_${linkRoundTag}_${getShareRef()}`);
    const inviteUrl = d?.inviteDeepLink || fallbackDeepLink;

    const ladder = buildWarmupLadder(d?.config);
    const validInvites = d ? Number(myRes?.validInvites ?? chest?.currentAssists ?? 0) : null;
    const minInvites = ladder.valid ? ladder.minInvites : null;
    const maxFriends = ladder.valid ? ladder.maxInvites : null;
    const totalChestA9 = chest ? rawToA9(chest.totalA9Raw ?? chest.baseA9Raw) : null;
    const chestPct = (validInvites !== null && maxFriends !== null && maxFriends > 0)
      ? Math.min(100, Math.round((Math.min(validInvites, maxFriends) / maxFriends) * 100))
      : 0;
    const chestOpened = chest?.status === 'OPENED';
    const chestReady = Boolean(
      isReserved &&
      chest &&
      !chestOpened &&
      (chest.status === 'READY' || (validInvites !== null && minInvites !== null && validInvites >= minInvites))
    );
    const openGateEnabled = isChestOpenEnabled();

    const plannedOpenStr = formatPlannedOpen(d?.config?.plannedOpenAt ?? d?.config?.plannedOpenAtMs);
    const openTimeUnknown = plannedOpenStr === null;

    // 严格遵守每状态唯一 1 个主按钮：未预约→预约；已预约→邀请好友；达标→开箱（只读/总闸关闭时显示原因文字，不放置灰占位按钮；加载失败绝不渲染预约主按钮）
    let primaryAreaHtml = '';
    if (state.loading && !d) {
      primaryAreaHtml = `<div class="num-xs text-muted">${L('正在加载预热状态…', 'Loading warm-up status…')}</div>`;
    } else if (loadFailed) {
      primaryAreaHtml = '';
    } else if (!isRoundOpen) {
      primaryAreaHtml = `<div class="num-xs text-sec" id="warmup-closed-reason">${L('本轮预热预约已结束，请等待下轮开放。', 'Warm-up reservation is closed for this round.')}</div>`;
    } else if (!isReserved) {
      primaryAreaHtml = `
        <button class="btn btn-primary" id="btn-register-warmup" type="button" ${state.busy ? 'disabled' : ''}>
          ${icon('bolt', 16)} ${state.busy ? L('提交中…', 'Reserving…') : L('预约', 'Reserve')}
        </button>
      `;
    } else if (chestOpened) {
      primaryAreaHtml = `<div class="num-xs text-green" style="font-weight:700;">${L('本轮预热宝箱已开启，奖励已计入「待激活」余额。', 'Warm-up chest opened; reward added to Pending Activation.')}</div>`;
    } else if (chestReady) {
      if (openGateEnabled) {
        primaryAreaHtml = `
          <button class="btn btn-primary" id="btn-open-warmup-chest" type="button" ${state.busy ? 'disabled' : ''}>
            ${icon('unlock', 16)} ${state.busy ? L('开箱中…', 'Opening…') : L('开箱', 'Open Chest')}
          </button>
        `;
      } else {
        // 只读或总闸关闭时显示原因文字，绝不放置灰占位按钮
        primaryAreaHtml = `
          <div class="sub-tile num-xs text-sec" id="warmup-open-gate-note" style="line-height:1.5;">
            ${L('已达开箱条件，当前为只读模式或免费开箱总闸尚未开放；你的达标进度已保留，开放后即可开箱。', 'Eligible to open, but claiming is currently read-only or chest opening is paused. Your progress is saved.')}
          </div>
        `;
      }
    } else {
      primaryAreaHtml = `
        <button class="btn btn-primary" id="btn-share-warmup" type="button">
          ${icon('send', 15)} ${L('邀请好友', 'Invite Friends')}
        </button>
      `;
    }

    const ladderHtml = state.loading && !d
      ? `<div class="num-xs text-muted">${L('加载阶梯配置中…', 'Loading reward tiers…')}</div>`
      : loadFailed
        ? `<div class="num-xs text-muted">${L('暂无法读取阶梯数据', 'Reward tiers unavailable')}</div>`
        : !ladder.valid
          ? `<div class="num-xs text-red" id="warmup-ladder-pending" style="font-weight:700;">${L('配置待确认', 'Configuration pending')}</div>`
          : `
            <div class="warmup-ladder-grid" id="warmup-ladder-grid">
              ${ladder.tiers.map((tier) => {
                const reached = validInvites !== null && validInvites >= tier.invites;
                return `
                  <div class="warmup-ladder-pill ${reached ? 'is-reached' : ''}">
                    <span class="num-xs text-muted">${tier.invites} ${L('人', 'inv')}</span>
                    <strong class="mono num-xs" style="white-space:nowrap;">${formatNum(tier.amountA9)} A9</strong>
                  </div>
                `;
              }).join('')}
            </div>
          `;

    const uniqueProgressText = state.loading && !d
      ? L('加载中…', 'Loading…')
      : loadFailed
        ? '—'
        : (validInvites !== null && maxFriends !== null)
          ? L(`有效好友 ${validInvites} / ${maxFriends}`, `Valid friends ${validInvites} / ${maxFriends}`)
          : (validInvites !== null ? L(`有效好友 ${validInvites} / —`, `Valid friends ${validInvites} / —`) : '—');

    const statusBadgeText = state.loading && !d
      ? L('加载中…', 'Loading…')
      : loadFailed
        ? L('暂不可用', 'Unavailable')
        : !isRoundOpen
          ? L('已关闭', 'Closed')
          : isReserved
            ? L('已预约', 'Reserved')
            : L('未预约', 'Not Reserved');

    root.innerHTML = `
      <div class="col-gap anim-page-enter" id="warmup-section-root">
        <section class="card card-hero col-gap">
          <div class="row-between">
            <span class="chip chip-gold">${L(roundTitleZh, roundTitleEn)}</span>
            <span class="chip ${isReserved && isRoundOpen ? 'chip-green' : 'chip-muted'}">${escapeHtml(statusBadgeText)}</span>
          </div>

          <div class="row-between" style="align-items:baseline;gap:8px;">
            <div>
              <div class="num-xs text-muted">${L('全网已预约人数', 'Total Reserved')}</div>
              <div class="num-hero mono" style="margin-top:2px;white-space:nowrap;">${totalRegistered === null ? (state.loading ? L('加载中…', 'Loading…') : '—') : `${formatNum(totalRegistered)} <span class="num-md text-sec">${L('人', 'players')}</span>`}</div>
            </div>
            <div style="text-align:right;">
              <div class="num-xs text-muted">${L('预计开轮时间', 'Opening Time')}</div>
              ${openTimeUnknown
                ? `<button type="button" class="sw-retry-link" id="btn-warmup-alert-inline" style="margin-top:4px;font-weight:700;">${state.remindEnabled ? L('待公布 · 已开启提醒', 'TBA · Alert ON') : L('待公布 · 开启提醒', 'TBA · Enable Alert')}</button>`
                : `<strong class="num-xs mono" style="display:block;margin-top:4px;white-space:nowrap;">${escapeHtml(plannedOpenStr)}</strong>`}
            </div>
          </div>

          <div>
            <div class="row-between num-xs text-sec" style="margin-bottom:5px;">
              <strong id="warmup-unique-progress">${escapeHtml(uniqueProgressText)}</strong>
              <span class="mono">${ladder.valid ? L(`最高 ${formatNum(ladder.maxA9)} A9`, `Up to ${formatNum(ladder.maxA9)} A9`) : '—'}</span>
            </div>
            <div class="progress-track" style="height:7px;">
              <div class="progress-fill" style="width:${chestPct}%;"></div>
            </div>
          </div>

          ${ladderHtml}

          <div class="rewards-activation-note">
            <div class="num-xs text-sec" style="line-height:1.5;">
              <strong>${L('待激活说明：', 'Pending Activation: ')}</strong>${L(
                '预热开箱奖励进入「待激活」余额；完成购任意宝箱、链上锁仓或邀 1 位好友购箱后自动激活并进入「我的奖励」可领余额（48 小时未激活回流奖池）。',
                'Warm-up chest rewards credit to Pending Activation; auto-activates upon buying any chest, locking A9, or inviting 1 friend who buys a chest (moves to My Rewards; expires after 48h).'
              )}
            </div>
          </div>

          ${state.error ? `
            <div class="sw-menu-error" role="alert">
              <span>${escapeHtml(state.error)}</span>
              <button type="button" class="sw-retry-link" id="btn-warmup-retry">${L('重试', 'Retry')}</button>
            </div>
          ` : ''}

          ${primaryAreaHtml}

          ${isReserved ? `
            <div class="row-between" style="gap:8px;padding-top:2px;">
              <button class="sw-retry-link" id="btn-copy-invite" type="button">${icon('copy', 12)} ${L('复制预热链接', 'Copy Link')}</button>
              <button class="sw-retry-link" id="btn-cancel-warmup" type="button" style="color:var(--text-muted);" ${state.busy ? 'disabled' : ''}>${L('取消预约', 'Cancel')}</button>
            </div>
          ` : ''}
        </section>

        <section class="card col-gap" style="gap:8px;">
          <details class="rewards-secondary-fold" id="warmup-intent-fold">
            <summary>${L('意向档位与开轮提醒（可选）', 'Intent Tier & Opening Alert (Optional)')}</summary>
            <div class="col-gap" style="gap:10px;margin-top:10px;">
              <div class="num-xs text-muted">${L('选填预计锁仓体量（不锁资金，随时可改）：', 'Optional planned A9 lock size (non-binding):')}</div>
              <div class="hero-amt-pills" style="flex-wrap:wrap;gap:6px;">
                ${WARMUP_INTENT_OPTIONS.map((opt) => {
                  const active = state.selectedTier === opt.key;
                  return `<button type="button" class="hero-amt-pill ${active ? 'active' : ''}" data-intent-tier="${opt.key}" ${!isRoundOpen || state.busy ? 'disabled' : ''}>${L(opt.zh, opt.en)}</button>`;
                }).join('')}
              </div>
              <div class="row-between" style="padding-top:6px;border-top:1px solid var(--card-border);">
                <div>
                  <div class="num-xs" style="font-weight:700;color:var(--ink);">${L('开轮 Bot 私信通知', 'Bot Opening Alert')}</div>
                  <div class="num-xs text-muted">${L(`第 ${targetRoundId} 轮开盘时推送头矿 6H 入口`, `Notifies when Round ${targetRoundId} opens`)}</div>
                </div>
                <button type="button" class="chip ${state.remindEnabled ? 'chip-green' : 'chip-muted'}" id="btn-toggle-remind" style="cursor:pointer;border:none;" ${!isRoundOpen || state.busy ? 'disabled' : ''}>
                  ${state.remindEnabled ? L('已开启', 'ON') : L('已关闭', 'OFF')}
                </button>
              </div>
            </div>
          </details>

          <details class="rewards-secondary-fold" id="warmup-rules-fold">
            <summary>${L('预热规则说明', 'Warm-Up Rules')}</summary>
            <div class="num-xs text-sec" style="line-height:1.6;margin-top:8px;">
              ${L(
                '1. 零门槛预约，不锁任何本金；预约后获得本轮专属预热宝箱。<br/>2. 仅统计通过你的链接预约且绑定活跃 TON 钱包的有效好友。<br/>3. 阶梯与上限以当轮服务端配置为准，达到最低门槛即可解锁对应奖励；目标进度：',
                '1. Free reservation with zero lockup; grants your round warm-up chest.<br/>2. Only friends who reserve via your link and bind an active TON wallet count as valid.<br/>3. Tiers follow current round server config. Target progress: '
              )}
              <span class="mono">${totalRegistered !== null && targetUsers !== null ? `${formatNum(totalRegistered)} / ${formatNum(targetUsers)} (${progressPct}%)` : '—'}</span>
            </div>
          </details>
        </section>

        ${!hasTgAuth ? `<div class="num-xs text-muted" style="text-align:center;">${L('请在 Telegram 小程序内打开以完成预约与接收开轮提醒。', 'Open inside Telegram Mini App to reserve and receive opening alerts.')}</div>` : ''}
      </div>
    `;

    const retryBtn = root.querySelector('#btn-warmup-retry');
    if (retryBtn) retryBtn.onclick = () => load();

    const submitReserve = async (overrides = {}) => {
      if (!config.isDemo && !A9TMA.getRawInitData()) {
        showToast(L('请在 Telegram 小程序内打开后再预约', 'Open inside Telegram Mini App to reserve'), 'amber');
        return false;
      }
      state.busy = true;
      paint();
      try {
        const hasIntentOverride = Object.prototype.hasOwnProperty.call(overrides, 'intentTier');
        const hasRemindOverride = Object.prototype.hasOwnProperty.call(overrides, 'remindEnabled');
        await registerWarmup({
          roundId: targetRoundId,
          walletAddress: store.state.user.address || null,
          userId: getEffectiveUserId(store.state.user),
          referrerId: store.state.referral.referrerId || null,
          intentTier: hasIntentOverride ? overrides.intentTier : state.selectedTier,
          remindEnabled: hasRemindOverride ? overrides.remindEnabled : state.remindEnabled,
        });
        A9Haptic.success();
        if (!isReserved) burstParticles(root);
        showToast(
          overrides._silent
            ? L('已更新预约偏好', 'Reservation preferences saved')
            : L(`预约成功！已发放第 ${targetRoundId} 轮预热宝箱`, `Reserved! Round ${targetRoundId} Warm-Up Chest granted`)
        );
        state.busy = false;
        await load();
        return true;
      } catch (e) {
        A9Haptic.error();
        showToast(e?.message || L('预热预约失败，请重试', 'Reservation failed'), 'error');
        state.busy = false;
        if (root.isConnected) paint();
        return false;
      }
    };

    const regBtn = root.querySelector('#btn-register-warmup');
    if (regBtn) regBtn.onclick = () => submitReserve();

    const doShare = () => {
      const maxStr = ladder.valid ? `${formatNum(ladder.maxA9)} A9` : L('预热宝箱奖励', 'warm-up chest rewards');
      const shareText = L(
        `我已预约 A9 第 ${targetRoundId} 轮开局预热！点链接零门槛预约立领专属预热宝箱，绑活跃 TON 钱包一起解锁最高 ${maxStr}：`,
        `I reserved A9 Round ${targetRoundId} Warm-Up! Tap to reserve with 0 cost, get your Warm-Up Chest, and unlock up to ${maxStr}:`
      );
      A9TMA.shareInvite(inviteUrl, shareText);
      showToast(L('已调起 Telegram 好友分享', 'Opened Telegram share'));
    };

    const shareBtn = root.querySelector('#btn-share-warmup');
    if (shareBtn) shareBtn.onclick = doShare;

    const copyTop = root.querySelector('#btn-copy-invite');
    if (copyTop) copyTop.onclick = () => copyText(inviteUrl, L('已复制专属预热链接', 'Copied warm-up link'));

    const toggleRemindHandler = async () => {
      A9Haptic.tick();
      const prev = state.remindEnabled;
      const next = !prev;
      state.remindEnabled = next;
      if (isReserved) {
        const okSave = await submitReserve({ remindEnabled: next, _silent: true });
        if (!okSave && root.isConnected) {
          state.remindEnabled = prev;
          paint();
        }
      } else {
        showToast(next ? L('已开启开轮提醒，预约后生效', 'Opening alert enabled (applies on reserve)') : L('已关闭开轮提醒', 'Opening alert disabled'));
        paint();
      }
    };

    const inlineAlertBtn = root.querySelector('#btn-warmup-alert-inline');
    if (inlineAlertBtn) inlineAlertBtn.onclick = toggleRemindHandler;
    const toggleRemind = root.querySelector('#btn-toggle-remind');
    if (toggleRemind) toggleRemind.onclick = toggleRemindHandler;

    root.querySelectorAll('[data-intent-tier]').forEach((btn) => {
      btn.onclick = async () => {
        A9Haptic.tick();
        const prev = state.selectedTier;
        const tier = btn.dataset.intentTier;
        const next = prev === tier ? null : tier;
        state.selectedTier = next;
        if (isReserved) {
          const okSave = await submitReserve({ intentTier: next, _silent: true });
          if (!okSave && root.isConnected) {
            state.selectedTier = prev;
            paint();
          }
        } else {
          paint();
        }
      };
    });

    const openWarmupChestBtn = root.querySelector('#btn-open-warmup-chest');
    if (openWarmupChestBtn && chest) {
      openWarmupChestBtn.onclick = async () => {
        if (!isChestOpenEnabled()) {
          A9Haptic.warning();
          showToast(L('当前为只读模式或开箱暂未开放', 'Read-only mode or chest opening disabled'), 'amber');
          return;
        }
        state.busy = true;
        paint();
        try {
          const res = await openChestById(chest.chestId, store.state, store.state.user.address);
          const gotA9 = rawToA9(res?.rewardA9Raw) || totalChestA9 || 0;
          openChestCelebrationModal({
            tier: 'gold',
            title: L(`第 ${targetRoundId} 轮预热宝箱`, `Round ${targetRoundId} Warm-Up Chest`),
            totalA9: gotA9,
            openedCount: 1,
          });
          state.busy = false;
          await load();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('暂未满足开箱条件，请稍后重试', 'Not eligible to open yet'), 'amber');
          state.busy = false;
          if (root.isConnected) paint();
        }
      };
    }

    const cancelBtn = root.querySelector('#btn-cancel-warmup');
    if (cancelBtn) {
      cancelBtn.onclick = async () => {
        state.busy = true;
        paint();
        try {
          await cancelWarmup({
            roundId: targetRoundId,
            walletAddress: store.state.user.address || null,
            userId: getEffectiveUserId(store.state.user),
          });
          A9Haptic.warning();
          state.selectedTier = null;
          store.update((s) => { s.user.warmupRegistered = false; });
          showToast(L('已取消本轮预热预约', 'Warm-up reservation cancelled'), 'amber');
          state.busy = false;
          await load();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('取消预约失败，请重试', 'Cancellation failed'), 'error');
          state.busy = false;
          if (root.isConnected) paint();
        }
      };
    }
  };

  void load();
}

export function renderWarmupHome(root, navigate, param = null, query = {}) {
  return mountWarmupSection(root, { navigate, param, query, embedded: false });
}

export function renderWarmupRank(root) {
  if (!config.isDemo) {
    let rankSeq = 0;
    const load = async () => {
      const seq = ++rankSeq;
      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <div class="sw-menu-group">
            <div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('正在读取预热裂变榜…', 'Loading warm-up board…')}</span></div></div>
          </div>
        </div>
      `;
      try {
        let targetRoundId = Number(store.state.round.currentRound) ? Number(store.state.round.currentRound) + 1 : 1;
        try {
          const cur = await fetchWarmupCurrent();
          if (cur?.roundId) targetRoundId = Number(cur.roundId);
        } catch (_) {}
        const rows = await fetchWarmupRank(targetRoundId);
        if (seq !== rankSeq || !root.isConnected) return;
        const list = Array.isArray(rows) ? rows : [];
        root.innerHTML = `
          <div class="col-gap anim-page-enter">
            <section class="card card-hero">
              <div class="row-between">
                <div class="card-title">${icon('trophy', 15, 'text-gold')} ${L(`第 ${targetRoundId} 轮预热裂变榜`, `Round ${targetRoundId} Warm-Up Board`)}</div>
                <span class="chip chip-muted mono">${list.length}</span>
              </div>
            </section>
            <div class="sw-menu-group">
              ${list.length === 0
                ? `<div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('暂无预热邀请排名，快去预约并邀请好友冲榜！', 'No warm-up rankings yet.')}</span></div></div>`
                : list.map((entry) => {
                    const uid = entry.tgUserId ?? entry.userId;
                    const who = entry.label || entry.walletAddress || (uid ? `TG#${String(uid).slice(-4)}` : L('玩家', 'Player'));
                    const rawPart = Number(entry.rawInvites) > Number(entry.validInvites)
                      ? ` (${L('共邀', 'total')} ${entry.rawInvites})`
                      : '';
                    return `
                      <div class="sw-rank-row">
                        <span class="sw-rank-pos">#${escapeHtml(String(entry.rank))}</span>
                        <span class="sw-rank-id">${escapeHtml(String(who))}</span>
                        <span class="sw-rank-val">${escapeHtml(String(entry.validInvites))} ${L('有效', 'valid')}${escapeHtml(rawPart)}</span>
                      </div>
                    `;
                  }).join('')}
            </div>
            <div class="sw-menu-group">
              <a class="sw-menu-row" href="#/warmup">
                <div class="sw-menu-left"><span class="sw-menu-title">${L('返回下轮预热', 'Back to Warm-Up')}</span></div>
                <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
              </a>
            </div>
          </div>
        `;
      } catch {
        if (seq !== rankSeq || !root.isConnected) return;
        root.innerHTML = `
          <div class="col-gap anim-page-enter">
            <div class="sw-menu-group">
              <div class="sw-menu-error" role="alert">
                <span>${L('榜单读取失败', 'Rankings unavailable')}</span>
                <button type="button" class="sw-retry-link" id="btn-warmup-rank-retry">${L('重试', 'Retry')}</button>
              </div>
            </div>
            <div class="sw-menu-group">
              <a class="sw-menu-row" href="#/warmup">
                <div class="sw-menu-left"><span class="sw-menu-title">${L('返回下轮预热', 'Back to Warm-Up')}</span></div>
                <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
              </a>
            </div>
          </div>
        `;
        const retry = root.querySelector('#btn-warmup-rank-retry');
        if (retry) retry.onclick = load;
      }
    };
    load();
    return;
  }
  let tab = 'personal';
  const paint = () => {
    const demo = peekDemoModule();
    const rows = tab === 'personal' ? (demo?.personalRanks || []) : (demo?.teamRanks || []);
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero">
          <div class="num-xs text-gold" style="font-weight:700;">${L('前 50 名守门员门槛 · 每 5 分钟刷新', 'Top 50 Cutoff · Refreshes 5m')}</div>
          <div style="font-size:15px;font-weight:900;margin-top:4px;">≥ 6 ${L('名有效直邀（冻结后 T+24H 公示）', 'Valid Invites (Final at T+24H)')}</div>
        </section>

        <div class="seg-tabs">
          <button class="seg-tab ${tab === 'personal' ? 'active' : ''}" data-wt="personal" type="button">${L('个人先锋榜 (前50)', 'Top 50 Users')}</button>
          <button class="seg-tab ${tab === 'team' ? 'active' : ''}" data-wt="team" type="button">${L('战队先锋榜', 'Top Squads')}</button>
        </div>

        <div class="sw-menu-group">
          ${rows.map(item => `
            <div class="sw-rank-row" ${item.me ? 'style="background:var(--nt-gold-soft);"' : ''}>
              <span class="sw-rank-pos ${item.me ? 'text-green' : item.cutoff ? 'text-gold' : ''}">#${escapeHtml(String(item.r))}</span>
              <div class="sw-rank-id">
                <div style="font-weight:${item.me ? '900' : '700'};color:var(--ink);">${escapeHtml(item.addr)}</div>
                <div class="num-xs text-muted">${escapeHtml(String(item.invites))} ${L('位有效直邀', 'valid invites')}</div>
              </div>
              <span class="sw-rank-val text-green">${escapeHtml(item.reward)}</span>
            </div>
          `).join('')}
        </div>

        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/warmup">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('返回下轮预热', 'Back to Warm-Up')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
        </div>
      </div>
    `;
    root.querySelectorAll('[data-wt]').forEach(b => {
      b.onclick = () => { A9Haptic.light(); tab = b.dataset.wt; paint(); };
    });
  };
  paint();
}

export function renderInternalMarket(root, navigate, _param = null, query = {}) {
  const { market } = store.state;
  // 5a: ?tab=free 兼容回落至宝箱商城默认视图（不报 404）
  let activeTab = 'mall';
  let selectedSkuId = 'chest_bronze';
  const openMode = 'INSTANT';
  let chestData = { freeChests: [], shopChests: [], loaded: false };
  let critFeed = [];
  let critIndex = 0;
  let critTimer = null;
  let liveQuota = null;
  let liveOrdersCount = null;
  let activationA9 = null;
  let buyBusy = false;
  let openAllBusy = false;

  const isPresaleServerOpen = () => Boolean(store.state.round?.protocolConfig?.presaleHotWallet?.open);
  const isChestOpenServerEnabled = () => store.state.round?.chestMall?.openEnabled !== false;
  const canPurchaseNow = () => config.isDemo || (store.fundsEnabled && isPresaleServerOpen());
  const canOpenChestNow = () => config.isDemo || (store.fundsEnabled && isChestOpenServerEnabled());

  const formatGramFromNano = (nanoStr) => {
    try {
      const n = BigInt(String(nanoStr || '0'));
      const whole = n / 1_000_000_000n;
      const frac = String(n % 1_000_000_000n).padStart(9, '0').slice(0, 2).replace(/0+$/, '');
      return `${whole.toLocaleString('en-US')}${frac ? '.' + frac : ''} GRAM`;
    } catch { return '—'; }
  };

  const formatVolumeReq = (nanoStr) => {
    try {
      const g = Number(BigInt(String(nanoStr || '0')) / 1_000_000_000n);
      return g > 0 ? `${formatNum(g)} GRAM` : null;
    } catch { return null; }
  };

  const shareChestToTg = (chest) => {
    const ogUrl = buildOgShareUrl('chest', chest.chestId);
    const need = Math.max(0, Number(chest.requiredAssists || 2) - Number(chest.currentAssists || 0));
    const isBoost = chest.source === 'SHOP_BOOST';
    const label = L(chest.labelZh, chest.labelEn);
    const text = isBoost
      ? L(
          `刚在 A9 宝箱商城开启【${label}】！6 档纯区间随机开箱，保底 + 随机加赠合并直发钱包，来试试手气或免费秒开新手青铜箱（200 A9）：`,
          `Just opened [${label}] in A9 Chest Mall! 6-tier random unboxing with base + random bonus sent directly to wallet. Try your luck or open your free Starter Bronze Chest (200 A9):`
        )
      : L(
          `A9 双向同行礼：帮我点一下一起解锁【${label}】（还差 ${need} 次助力），你绑定活跃钱包立刻获得新手青铜箱（200 A9 免助力秒开）！若你购箱还可 1 人抵 3 次助力：`,
          `A9 Two-Way Gift: help unlock [${label}] (${need} assist(s) left) and instantly get your own 200 A9 Starter Bronze Chest (0 assists needed)! Paid friends count as 3 assists:`
        );
    A9TMA.shareInvite(ogUrl, text);
    showToast(L('已调起 Telegram 双向同行礼分享', 'Opened Telegram two-way gift share'));
  };

  const shareChestToX = (chest) => {
    const rewardA9 = rawToA9(chest.baseA9Raw) || 0;
    openXShareSheet({
      type: 'chest',
      id: chest.chestId,
      context: {
        label: L(chest.labelZh, chest.labelEn),
        source: chest.source,
        currentAssists: chest.currentAssists,
        requiredAssists: chest.requiredAssists,
        rewardText: `${formatNum(Math.round(rewardA9), 0)} A9`
      }
    });
  };

  const formatCritTickerInner = (item, idx, total) => {
    const isTop = item.critTier === 'jackpot' || item.critTier === 'legendary';
    const badge = L('手气爆棚', 'TOP ROLL');
    const totalA9 = rawToA9(item.totalA9Raw) || 0;
    const bonusA9 = rawToA9(item.boostA9Raw) || 0;
    const chestName = L(item.labelZh || item.tier, item.labelEn || item.tier);
    const amountText = totalA9 > 0
      ? `${L('开出', 'got')} <b class="mono text-green">${formatNum(Math.round(totalA9), 0)} A9</b>`
      : `${L('加赠', 'bonus')} <b class="mono text-green">+${formatNum(Math.round(bonusA9), 0)} A9</b>`;
    return `
      <span class="mall-crit-badge ${isTop ? 'is-legend' : 'is-epic'}">${badge}</span>
      <span class="mall-crit-text"><b>${escapeHtml(item.actor || 'A9')}</b> ${escapeHtml(chestName)} ${amountText}</span>
      ${total > 1 ? `<span class="mall-crit-idx mono">${idx + 1}/${total}</span>` : ''}
    `;
  };

  const ensureCritTickerLoop = () => {
    if (critTimer) {
      clearInterval(critTimer);
      critTimer = null;
    }
    if (critFeed.length <= 1) return;
    critTimer = setInterval(() => {
      if (!root.isConnected) {
        clearInterval(critTimer);
        critTimer = null;
        return;
      }
      const el = root.querySelector('#mall-crit-ticker');
      if (!el || !critFeed.length) return;
      critIndex = (critIndex + 1) % critFeed.length;
      el.innerHTML = formatCritTickerInner(critFeed[critIndex], critIndex, critFeed.length);
    }, 3600);
  };

  const loadChests = async () => {
    const [myRes, feedRes] = await Promise.allSettled([
      fetchMyChests(),
      fetchChestCritFeed(12),
    ]);
    if (myRes.status === 'fulfilled' && myRes.value) {
      chestData = {
        freeChests: Array.isArray(myRes.value.freeChests) ? myRes.value.freeChests : [],
        shopChests: Array.isArray(myRes.value.shopChests) ? myRes.value.shopChests : [],
        loaded: true
      };
    } else {
      chestData.loaded = true;
    }
    if (feedRes.status === 'fulfilled' && Array.isArray(feedRes.value)) {
      critFeed = feedRes.value;
      if (critIndex >= critFeed.length) critIndex = 0;
    }
    if (!config.isDemo && store.state.user.connected && store.state.user.address) {
      const addr = store.state.user.address;
      const [qRes, oRes] = await Promise.allSettled([
        fetchPresaleQuota(addr),
        fetchPresaleOrders(addr),
      ]);
      if (qRes.status === 'fulfilled' && qRes.value) liveQuota = qRes.value;
      if (oRes.status === 'fulfilled' && Array.isArray(oRes.value)) liveOrdersCount = oRes.value.length;
    }
    if (root.isConnected) {
      render();
      ensureCritTickerLoop();
    }
  };

  const resolveChestSkus = () => {
    if (config.isDemo) return peekDemoModule()?.DEMO_CHEST_SKUS || [];
    const serverSkus = store.state.round?.chestMall?.skus;
    if (Array.isArray(serverSkus) && serverSkus.length) {
      return serverSkus.map((s) => {
        const priceNum = Number(s.priceGram || 0);
        const feeStr = String(s.deliveryFeeGram || store.state.round?.chestMall?.deliveryFeeGram || '0.06');
        const totalStr = String(s.totalPayGram || (priceNum + Number(feeStr)).toFixed(2));
        const baseInt = Math.round(Number(s.baseA9 || 0));
        const maxBoostInt = Math.round(Number(s.maxBoostA9 || (Number(s.maxBoostA9Raw || 0) / 1e9)));
        const maxInt = Math.round(Number(s.maxA9 || (baseInt + maxBoostInt)));
        return {
          skuId: s.skuId,
          tier: s.tier,
          zh: s.zh,
          en: s.en,
          priceGram: String(s.priceGram),
          deliveryFeeGram: feeStr,
          totalPayGram: totalStr,
          baseA9: baseInt,
          maxA9: maxInt,
          maxBoostPct: Math.round((Number(s.maxBoostBps || 0) / 100) * 10) / 10,
          maxBoostA9: maxBoostInt,
          requiredAssists: Number(s.requiredAssists || 0)
        };
      });
    }
    return [];
  };

  const render = () => {
    const skus = resolveChestSkus();
    const sel = skus.length ? (skus.find((s) => s.skuId === selectedSkuId) || skus[0]) : null;
    const selTier = sel ? resolveChestTier(sel) : 'bronze';
    const totalIfBoost = sel ? Math.round(sel.maxA9 || (sel.baseA9 + sel.maxBoostA9)) : 0;
    const displayTotalA9 = sel ? totalIfBoost : 0;
    const activeShopChests = (chestData.shopChests || []).filter((c) => c.status !== 'OPENED');
    const freeList = chestData.freeChests || [];

    // 免费宝箱：计算 5 阶进度轨状态 + 当前唯一聚焦主角卡
    const tierOrder = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
    const focusChest = freeList.find((c) => c.status === 'READY' || (c.status !== 'LOCKED' && c.status !== 'OPENED'))
      || freeList.find((c) => c.status !== 'OPENED')
      || freeList[0]
      || null;
    const focusTier = focusChest ? resolveChestTier(focusChest) : 'bronze';
    const readyFreeCount = freeList.filter((c) => c.status === 'READY' || (c.status !== 'LOCKED' && c.status !== 'OPENED' && Number(c.currentAssists || 0) >= Number(c.requiredAssists || 0))).length;

    const renderFreeFocusCard = (c) => {
      if (!c) return '';
      const tier = resolveChestTier(c);
      const rewardA9 = rawToA9(c.baseA9Raw) || 0;
      const volReq = formatVolumeReq(c.minVolumeNano);
      const reqAssists = Number(c.requiredAssists || 0);
      const curAssists = Number(c.currentAssists || 0);
      const isInstant = reqAssists === 0;
      const isLocked = c.status === 'LOCKED';
      const isOpened = c.status === 'OPENED';
      const isReady = c.status === 'READY' || (!isLocked && !isOpened && curAssists >= reqAssists);
      const isPendingVault = c.rewardDestination === 'PENDING_VAULT' || c.tier === 'bronze' || c.tier === 'silver';
      const badgeCls = isOpened ? 'chip-muted' : isReady ? 'chip-green' : isLocked ? 'chip-muted' : 'chip-gold';
      const badgeTxt = isOpened ? L('已开启', 'Opened') : isReady ? (isInstant ? L('免助力秒开', 'Instant Open') : L('可开箱', 'Ready')) : isLocked ? L('待解锁', 'Locked') : L('助力中', 'Active');
      const totalSegs = isInstant ? 1 : Math.max(1, Math.min(8, reqAssists || 2));
      const filledSegs = isInstant
        ? 1
        : (reqAssists > 0 ? Math.min(totalSegs, Math.round((curAssists / reqAssists) * totalSegs)) : 0);

      return `
        <section class="free-focus-card">
          <div class="free-focus-top">
            <div class="free-focus-icon chest-stage-visual tier-${tier}">
              ${renderChestSvg(tier, { size: 64, state: isOpened ? 'opened' : isLocked ? 'locked' : 'normal' })}
            </div>
            <div class="chest-stage-meta">
              <div class="chest-stage-head">
                <h3 class="chest-stage-name">${escapeHtml(L(c.labelZh, c.labelEn))}</h3>
                <span class="chip ${badgeCls}">${badgeTxt}</span>
              </div>
              <div class="chest-stage-total">+${formatNum(Math.round(rewardA9), 0)} A9</div>
              <div class="chest-stage-stats">
                <span>${isInstant ? L('新手礼遇 · 0 助力', 'Starter Gift · 0 Assists') : `${L('活跃助力', 'Assists')} <b class="mono">${formatNum(curAssists)}/${formatNum(reqAssists)}</b>`}</span>
                <span>· ${isPendingVault ? L('入待激活金库', 'Pending Vault') : L('可提现余额', 'Claimable')}</span>
              </div>
            </div>
          </div>

          <div class="free-seg-bar" style="grid-template-columns:repeat(${totalSegs}, minmax(0, 1fr));" aria-hidden="true">
            ${Array.from({ length: totalSegs }, (_, i) => `<i class="${i < filledSegs ? 'filled' : ''}"></i>`).join('')}
          </div>

          ${(volReq || c.minTgMembers > 0) ? `
            <div class="num-xs text-muted">
              ${L('门槛', 'Gate')}: ${volReq ? L(`本人+直邀累计购箱 ≥ ${volReq}`, `Self + Invitees Vol >= ${volReq}`) : ''}${volReq && c.minTgMembers > 0 ? ' · ' : ''}${c.minTgMembers > 0 ? L(`TG群 ≥ ${formatNum(c.minTgMembers)}人`, `TG >= ${formatNum(c.minTgMembers)}`) : ''}
            </div>
          ` : ''}
          ${!isInstant && !isLocked && !isOpened ? `
            <div class="num-xs text-green" style="font-weight:700;">${L('好友首次购箱 1 人抵 3 次助力 · 双方得礼', 'Paid friend = 3 assists · Two-way gift')}</div>
          ` : ''}

          ${!isLocked && !isOpened ? (
            isReady ? `
              <button class="btn ${canOpenChestNow() ? 'btn-primary' : 'btn-secondary'}" data-open-chest="${escapeHtml(c.chestId)}" type="button" ${!canOpenChestNow() ? 'disabled' : ''}>
                ${icon(canOpenChestNow() ? 'unlock' : 'lock', 15)} ${canOpenChestNow() ? L(`立即开箱领 ${formatNum(Math.round(rewardA9), 0)} A9`, `Open Chest (+${formatNum(Math.round(rewardA9), 0)} A9)`) : L('真实只读模式 · 暂未开放开箱', 'Read-Only Mode')}
              </button>
            ` : `
              <div class="free-action-row">
                <button class="btn btn-primary btn-sm" data-share-tg="${escapeHtml(c.chestId)}" type="button" style="width:100%;min-height:42px;">${icon('send', 14)} ${L('TG 邀同行礼', 'Co-Op on TG')}</button>
                <button class="btn btn-secondary btn-sm" data-share-x="${escapeHtml(c.chestId)}" type="button" style="width:100%;min-height:42px;">${icon('xBrand', 13)} X</button>
              </div>
            `
          ) : ''}
        </section>
      `;
    };

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="seg-tabs" id="chest-mall-tabs">
          <button class="seg-tab ${activeTab === 'mall' ? 'active' : ''}" data-cm-tab="mall" type="button">${L('宝箱商城', 'Chest Mall')}</button>
          <button class="seg-tab ${activeTab === 'free' ? 'active' : ''}" data-cm-tab="free" type="button">${L('免费膨胀箱', 'Free Chests')}${readyFreeCount > 0 ? ` (${readyFreeCount})` : ''}</button>
        </div>

        ${activeTab === 'mall' ? `
          ${query.from === 'activation' && (config.isDemo ? rawToA9(store.state.prediction.pendingActivationRaw) : activationA9) > 0 ? `
            <div class="sw-menu-group">
              <div class="sw-menu-row is-static" style="background:var(--nt-gold-soft);">
                <div class="sw-menu-left">
                  <span class="sw-menu-title">${L('待激活奖励', 'Pending Activation')}</span>
                  <span class="sw-menu-sub">${L('购箱后，符合条件的奖励将并入推广余额；宝箱内的 A9 单独直发钱包。', 'Eligible rewards move to your referral balance after purchase; chest A9 goes directly to your wallet.')}</span>
                </div>
                <div class="sw-menu-right">
                  <span class="sw-menu-amount is-amber">${formatNum(activationA9)} A9</span>
                </div>
              </div>
            </div>
          ` : ''}
          ${critFeed.length > 0 ? `<button type="button" class="mall-crit-ticker" id="mall-crit-ticker" aria-live="polite">${formatCritTickerInner(critFeed[critIndex % critFeed.length], critIndex % critFeed.length, critFeed.length)}</button>` : ''}
          <div class="mall-info-strip">
            <span class="mall-rate-tag is-green">${icon('shieldCheck', 12, 'text-green')} ${L('100% 保底本金 · 买完合并直发钱包', '100% Base Safe · Direct Wallet Payout')}</span>
            <div class="mall-quick-pills">
              ${activeShopChests.length > 0 ? `<button type="button" class="mall-quick-btn is-hot" id="btn-jump-active-chests">${L('持有宝箱', 'Held')} ${activeShopChests.length}</button>` : ''}
              <button type="button" class="mall-quick-btn" data-nav="/internal/records">${icon('receipt', 12)} ${L('小票', 'Receipts')}${config.isDemo && market.records.length ? ` (${market.records.length})` : (liveOrdersCount ? ` (${liveOrdersCount})` : '')}</button>
            </div>
          </div>

          ${!config.isDemo && liveQuota ? `
            <div class="mall-info-strip" style="padding:7px 12px;">
              <span class="num-xs text-sec">${liveQuota.unlimitedQuota ? L('个人购箱额度', 'Personal Quota') : L('剩余购箱额度', 'Remaining Quota')}</span>
              <b class="mono num-xs text-green">${liveQuota.unlimitedQuota ? L('不限购', 'Unlimited') : formatGramFromNano(liveQuota.availQuotaNano ?? liveQuota.remainingNano)}</b>
            </div>
          ` : ''}

          ${!sel ? `
            <section class="card" id="live-chest-skus-unavailable" style="border-color:var(--gold-border);">
              <div class="row-start" style="font-weight:800;margin-bottom:4px;">${icon('shieldAlert', 14, 'text-gold')} ${L('宝箱档位配置暂不可用', 'Chest Tiers Unavailable')}</div>
              <div class="num-xs text-sec" style="margin-bottom:10px;">${L('未获取到服务端档位配置，请重试加载。', 'Server tier data unavailable. Please retry.')}</div>
              <button class="btn btn-secondary btn-sm" id="btn-retry-chest-skus" type="button">${icon('refresh', 13)} ${L('重新加载', 'Retry')}</button>
            </section>
          ` : `
            <section class="chest-stage-card">
              <div class="chest-stage-visual tier-${selTier}">
                ${renderChestSvg(selTier, { size: 80 })}
              </div>
              <div class="chest-stage-meta">
                <div class="chest-stage-head">
                  <h2 class="chest-stage-name">${escapeHtml(L(sel.zh, sel.en))}</h2>
                  <span class="chip chip-green">${L('合并直发钱包', 'Direct Payout')}</span>
                </div>
                <div class="chest-stage-total">${formatNum(sel.baseA9, 0)}–${formatNum(displayTotalA9, 0)} A9</div>
                <div class="chest-stage-stats">
                  <span>${L('保底', 'Base')} <b class="mono">${formatNum(sel.baseA9, 0)}</b></span>
                  <span class="text-green">· ${L('最高加赠', 'Max Bonus')} <b class="mono">+${formatNum(sel.maxBoostA9, 0)}</b></span>
                </div>
              </div>
            </section>

            <div class="chest-shelf-grid" role="radiogroup" aria-label="${L('选择宝箱档位', 'Select chest tier')}">
              ${skus.map((sku) => {
                const tier = resolveChestTier(sku);
                const meta = CHEST_TIER_META[tier];
                const active = sku.skuId === sel.skuId;
                return `
                  <button type="button" class="chest-shelf-item ${active ? 'is-selected' : ''}" data-pick-sku="${escapeHtml(sku.skuId)}" aria-checked="${active}" role="radio">
                    ${meta?.hot ? `<span class="chest-hot-tag">${L('热门', 'HOT')}</span>` : ''}
                    ${renderChestSvg(tier, { size: 46 })}
                    <span class="chest-shelf-name">${L(meta.shortZh, meta.shortEn)}</span>
                    <span class="chest-shelf-price">${sku.priceGram} GRAM</span>
                    <span class="chest-shelf-boost">0–+${sku.maxBoostPct}%</span>
                  </button>
                `;
              }).join('')}
            </div>

            <section class="mall-checkout-panel">
              <button class="btn ${canPurchaseNow() && !pendingTxManager.isLocked('presale') ? 'btn-primary' : 'btn-secondary'}" id="btn-buy-chest" type="button" ${!canPurchaseNow() || buyBusy || pendingTxManager.isLocked('presale') ? 'disabled' : ''}>
                ${!store.fundsEnabled
                  ? `${icon('lock', 15)} ${L('真实模式只读 · 暂未开放购箱', 'Live Read-Only · Purchase Disabled')}`
                  : !config.isDemo && !isPresaleServerOpen()
                    ? `${icon('lock', 15)} ${L('宝箱商城尚未开售', 'Chest Mall Not Open Yet')}`
                    : config.isDemo
                      ? `${icon('bolt', 16)} ${L(`演示购箱 · ${sel.totalPayGram || (Number(sel.priceGram) + 0.06).toFixed(2)} GRAM（含 Gas）`, `Demo Buy · ${sel.totalPayGram || (Number(sel.priceGram) + 0.06).toFixed(2)} GRAM`)}`
                      : `${icon(pendingTxManager.isLocked('presale') ? 'clock' : 'bolt', 16)} ${pendingTxManager.isLocked('presale')
                          ? L('订单确认中…', 'Confirming…')
                          : buyBusy
                            ? L('等待钱包签名…', 'Awaiting Wallet…')
                            : L(`立即购箱 · ${sel.totalPayGram || (Number(sel.priceGram) + 0.06).toFixed(2)} GRAM（含 Gas）`, `Buy Chest · ${sel.totalPayGram || (Number(sel.priceGram) + 0.06).toFixed(2)} GRAM`)}`}
              </button>

              <details class="plaza-slots-drawer" style="margin-top:8px;">
                <summary class="plaza-slots-summary">
                  <span>${L(`明细：${sel.priceGram} + ${sel.deliveryFeeGram || '0.06'} GRAM 配送费 · 随机区间`, `Breakdown: ${sel.priceGram} + ${sel.deliveryFeeGram || '0.06'} GRAM delivery fee · Random range`)}</span>
                  <span class="num-xs text-muted">▾</span>
                </summary>
                <div class="sub-tile" style="padding:8px 10px;margin-top:6px;">
                  <div class="row-between num-xs">
                    <span class="text-sec">${L('宝箱货款（保底 + 随机合并直发）', 'Chest Base + Random Bonus')}</span>
                    <span class="mono">${sel.priceGram} GRAM</span>
                  </div>
                  <div class="row-between num-xs" style="margin-top:4px;">
                    <span class="text-sec">${L('固定配送费', 'Fixed Delivery Fee')}</span>
                    <span class="mono">+${sel.deliveryFeeGram || '0.06'} GRAM</span>
                  </div>
                  <div class="num-xs text-muted" style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--card-border);">
                    ${L(`纯随机加赠（最高 +${formatNum(sel.maxBoostA9, 0)} A9，与保底合并直发）：常规 75% · 高额 20% · 手气爆棚 5%`, `Random bonus (up to +${formatNum(sel.maxBoostA9, 0)} A9, paid with base): Standard 75% · High 20% · Top Roll 5%`)}
                  </div>
                </div>
              </details>

              <div class="mall-footnote">${L('请通过页面下单，切勿直接转账（异常退款扣 0.03 GRAM）', 'Pay via order flow only; never transfer directly')} · <a href="#/risk/audit" style="color:var(--nt-green);font-weight:700;text-decoration:none;">${L('v17.0 验真', 'Verify v17.0')} ›</a></div>
            </section>
          `}

          <div class="sw-menu-group">
            <a class="sw-menu-row" href="#/round">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('购箱到手后 → 进战场锁仓冲价', 'After Unboxing → Lock in Round')}</span>
                <span class="sw-menu-sub">${L('100 A9 起参战 · 头矿 6H 仅 5% 止损，通关分 700,000,000 A9 奖池', 'Lock from 100 A9 · First 6H 5% SL · split 700,000,000 A9 pool')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
            <a class="sw-menu-row" href="#/team/invite">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('邀友购箱享 6% 返佣 · 战队动员', 'Invite for 6% Mall Credit · Rally')}</span>
                <span class="sw-menu-sub">${L('复制专属邀请链，好友购箱实时返佣 6% + 通关 8%', 'Share link for 6% mall referral + 8% friend pass credits')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
          </div>

          ${activeShopChests.length > 0 ? (() => {
            const groupedMap = new Map();
            for (const c of activeShopChests) {
              const tier = resolveChestTier(c);
              if (!groupedMap.has(tier)) {
                const meta = CHEST_TIER_META[tier];
                groupedMap.set(tier, {
                  tier,
                  nameZh: meta ? `${meta.shortZh}宝箱` : (c.labelZh || tier),
                  nameEn: meta ? `${meta.shortEn} Chest` : (c.labelEn || tier),
                  chests: [],
                });
              }
              groupedMap.get(tier).chests.push(c);
            }
            const groupedList = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'legendary']
              .filter((k) => groupedMap.has(k))
              .map((k) => {
                const g = groupedMap.get(k);
                const repChest = g.chests.find((x) => Number(x.currentAssists || 0) < Number(x.requiredAssists || 2)) || g.chests[0];
                return { ...g, count: g.chests.length, repChest };
              });
            return `
            <section class="card chest-inv-card" id="active-boost-chests">
              <div class="chest-inv-head">
                <div class="row-start" style="gap:6px;">
                  <div class="card-title">${icon('flame', 15, 'text-gold')} ${L('持有宝箱', 'Held Chests')}</div>
                  <span class="chip chip-gold mono">${activeShopChests.length}</span>
                </div>
                <button class="btn ${canOpenChestNow() ? 'btn-primary' : 'btn-secondary'} btn-sm" id="btn-open-all-chests" type="button" style="width:auto;min-height:34px;padding:0 12px;" ${!canOpenChestNow() || openAllBusy ? 'disabled' : ''}>
                  ${icon(canOpenChestNow() ? 'unlock' : 'lock', 13)} ${openAllBusy ? L('开启中…', 'Opening…') : canOpenChestNow() ? L(`一键开启全部 (${activeShopChests.length})`, `Open All (${activeShopChests.length})`) : L('只读模式', 'Read-Only')}
                </button>
              </div>
              <div class="chest-inv-list">
                ${groupedList.map((g) => `
                  <div class="chest-inv-row">
                    <div class="chest-inv-left">
                      <div class="chest-inv-icon chest-stage-visual tier-${g.tier}">
                        ${renderChestSvg(g.tier, { size: 34 })}
                      </div>
                      <div class="chest-inv-name-row">
                        <span class="chest-inv-name">${escapeHtml(L(g.nameZh, g.nameEn))}</span>
                        <span class="chest-inv-qty">× ${g.count}</span>
                      </div>
                    </div>
                    <div class="chest-inv-actions">
                      <button class="btn btn-primary btn-sm" data-open-tier="${g.tier}" type="button" ${!canOpenChestNow() || openAllBusy ? 'disabled' : ''}>${icon(canOpenChestNow() ? 'unlock' : 'lock', 12)} ${g.count > 1 ? L('全开', 'Open All') : L('开启', 'Open')}</button>
                    </div>
                  </div>
                `).join('')}
              </div>
            </section>
          `;
          })() : ''}
        ` : `
          <section class="free-stage-card">
            <div class="row-between">
              <strong style="font-size:13.5px;font-weight:900;">${L('5 阶免费宝箱闯关', '5-Tier Free Quest')}</strong>
              <span class="chip chip-muted">${L('按序解锁 · 助力满即开', 'Serial Unlock')}</span>
            </div>
            <div class="free-stage-track">
              ${tierOrder.map((tKey) => {
                const meta = CHEST_TIER_META[tKey];
                const matching = freeList.filter((c) => resolveChestTier(c) === tKey);
                const allOpened = matching.length > 0 && matching.every((c) => c.status === 'OPENED');
                const isCur = focusChest && focusTier === tKey && !allOpened;
                const st = allOpened ? 'opened' : isCur ? 'normal' : 'locked';
                return `
                  <div class="free-stage-node ${allOpened ? 'is-done' : isCur ? 'is-current' : ''}">
                    ${renderChestSvg(tKey, { size: 32, state: st })}
                    <span>${L(meta.shortZh, meta.shortEn)}</span>
                  </div>
                `;
              }).join('')}
            </div>
            ${chestData.loaded && freeList.length === 0 ? (
              (!config.isDemo && !A9TMA.getRawInitData())
                ? `<div class="num-xs text-sec">${L('请在 Telegram 小程序内打开以领取新手青铜箱。', 'Open in Telegram Mini App to claim Starter Bronze.')}</div>`
                : `<button class="btn btn-primary" id="btn-claim-starter" type="button">${icon('bolt', 15)} ${L('0 成本领新手青铜箱（200 A9 秒开）', 'Claim Starter Bronze (200 A9 Instant)')}</button>`
            ) : ''}
          </section>

          ${focusChest ? renderFreeFocusCard(focusChest) : ''}

          ${freeList.length > 1 ? `
            <div class="free-queue-list">
              ${freeList.filter((c) => !focusChest || c.chestId !== focusChest.chestId).map((c) => {
                const tier = resolveChestTier(c);
                const rewardA9 = rawToA9(c.baseA9Raw) || 0;
                const isLocked = c.status === 'LOCKED';
                const isOpened = c.status === 'OPENED';
                const volReq = formatVolumeReq(c.minVolumeNano);
                const sub = isOpened
                  ? L('已开启入库', 'Opened')
                  : `${L('助力', 'Assists')} ${formatNum(c.currentAssists)}/${formatNum(c.requiredAssists)}${volReq ? ` · ${L('自购+直邀', 'Self+Inv')}≥${volReq}` : ''}`;
                return `
                  <div class="free-queue-row ${isLocked ? 'is-locked' : ''}">
                    <div class="free-queue-left">
                      ${renderChestSvg(tier, { size: 38, state: isOpened ? 'opened' : isLocked ? 'locked' : 'normal' })}
                      <div class="free-queue-copy">
                        <strong>${escapeHtml(L(c.labelZh, c.labelEn))} · <span class="mono text-green">${formatNum(Math.round(rewardA9), 0)} A9</span></strong>
                        <small>${sub}</small>
                      </div>
                    </div>
                    <span class="chip ${isOpened ? 'chip-green' : 'chip-muted'}">${isOpened ? L('已领', 'Done') : L('待解锁', 'Locked')}</span>
                  </div>
                `;
              }).join('')}
            </div>
          ` : ''}
          <div class="sw-menu-group">
            <a class="sw-menu-row" href="#/round">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('免费箱领到 A9 后 → 进战场锁仓冲价', 'After Free Chest → Lock in Round')}</span>
                <span class="sw-menu-sub">${L('100 A9 起锁仓参战 · 头矿 6H 仅 5% 止损', 'Lock from 100 A9 · First 6H 5% Stop-Loss')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
            <a class="sw-menu-row" href="#/team?action=rally">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('去战队动员 · 拉好友加速助力', 'Rally Squad · Boost Assists')}</span>
                <span class="sw-menu-sub">${L('一键喊单拉好友同行，还能赚 6% + 8% 返佣', 'Share 1-tap battle call & earn 6% + 8% referrals')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
          </div>
        `}
      </div>
    `;

    const tickerEl = root.querySelector('#mall-crit-ticker');
    if (tickerEl && critFeed.length > 0) {
      tickerEl.onclick = () => {
        A9Haptic.tick();
        critIndex = (critIndex + 1) % critFeed.length;
        tickerEl.innerHTML = formatCritTickerInner(critFeed[critIndex], critIndex, critFeed.length);
      };
    }

    const jumpBtn = root.querySelector('#btn-jump-active-chests');
    if (jumpBtn) {
      jumpBtn.onclick = () => {
        A9Haptic.light();
        root.querySelector('#active-boost-chests')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    }

    root.querySelectorAll('[data-cm-tab]').forEach((b) => {
      b.onclick = () => {
        A9Haptic.light();
        activeTab = b.dataset.cmTab;
        render();
      };
    });

    root.querySelectorAll('[data-pick-sku]').forEach((b) => {
      b.onclick = () => {
        A9Haptic.tick();
        selectedSkuId = b.dataset.pickSku;
        render();
      };
    });

    const retrySkusBtn = root.querySelector('#btn-retry-chest-skus');
    if (retrySkusBtn) {
      retrySkusBtn.onclick = async () => {
        retrySkusBtn.disabled = true;
        try {
          const snap = await loadSnapshot();
          if (snap) store.applyLiveRound(mapRoundView(snap));
        } catch (_) {}
        await loadChests();
      };
    }

    const buyBtn = root.querySelector('#btn-buy-chest');
    if (buyBtn) {
      buyBtn.onclick = async () => {
        if (!store.fundsEnabled) {
          A9Haptic.warning();
          showToast(L('当前真实模式处于只读验收阶段，购箱下单暂未开放', 'Live mode is read-only; purchase disabled'), 'amber');
          return;
        }
        if (config.isDemo) {
          const demo = peekDemoModule();
          const res = demo ? demo.demoBuyChest(store.state, selectedSkuId, 'INSTANT', getEffectiveUserId(store.state.user)) : { error: L('演示数据尚未就绪，请重试', 'Demo data not ready, please retry') };
          if (res.error) {
            A9Haptic.error();
            showToast(res.error, 'error');
            return;
          }
          A9Haptic.success();
          burstParticles(buyBtn);
          openChestCelebrationModal({
            tier: resolveChestTier(res.pack || selectedSkuId),
            title: L(res.pack?.zh || '宝箱', res.pack?.en || 'Chest'),
            baseA9: res.baseA9,
            bonusA9: res.bonusA9,
            totalA9: res.totalA9,
            openedCount: 1,
            critCount: (res.isCrit || res.critTier === 'bonus' || res.critTier === 'high' || res.critTier === 'lucky' || res.critTier === 'jackpot' || res.critTier === 'legendary') ? 1 : 0,
            legendaryCount: (res.critTier === 'jackpot' || res.critTier === 'legendary') ? 1 : 0,
          });
          loadChests();
          return;
        }
        if (!isPresaleServerOpen()) {
          A9Haptic.warning();
          showToast(L('宝箱商城通道尚未开售，请稍后再试', 'Chest Mall is not open yet'), 'amber');
          return;
        }
        const walletAddr = store.state.user.address;
        if (!store.state.user.connected || !walletAddr) {
          showToast(L('请先连接并验证 TON 钱包后再购箱', 'Connect and verify TON wallet before purchasing'), 'amber');
          tonConnect.openConnectModal(() => loadChests());
          return;
        }
        if (buyBusy || pendingTxManager.isLocked('presale')) {
          showToast(L('已有购箱订单正在链上确认中', 'Chest purchase already confirming'), 'amber');
          return;
        }
        try {
          tonConnect.assertWalletReadyForLiveTx();
        } catch (guardErr) {
          showToast(guardErr?.message || L('请检查钱包连接与网络状态', 'Check wallet connection and network'), 'error');
          return;
        }
        A9Haptic.light();
        buyBusy = true;
        render();
        try {
          const order = await requestChestPurchaseIntent({
            walletAddress: walletAddr,
            skuId: selectedSkuId,
            openMode,
            referrerId: store.state.referral.referrerId,
          });
          const expectedPresaleHot = store.state.round?.protocolConfig?.presaleHotWallet?.address || '';
          if (expectedPresaleHot && canonicalWalletKey(order.payTo) !== canonicalWalletKey(expectedPresaleHot)) {
            throw new Error(L('兑换热钱包地址与协议配置不一致，已拦截签名', 'Presale hot wallet mismatch with protocol config; signature blocked'));
          }
          const actualPayNano = BigInt(String(order.payTonNano || order.tonNano || '0'));
          const basePriceNano = BigInt(String(order.tonNano || '0'));
          const actualFeeNano = actualPayNano > basePriceNano ? actualPayNano - basePriceNano : 0n;
          const priceGram = formatGramFromNano(basePriceNano.toString()).replace(/\s*GRAM$/, '');
          const deliveryGram = formatGramFromNano(actualFeeNano.toString()).replace(/\s*GRAM$/, '');
          const totalPayGram = formatGramFromNano(actualPayNano.toString()).replace(/\s*GRAM$/, '');
          const orderA9 = rawToA9(order.a9AmountRaw) ?? sel?.baseA9 ?? 0;
          let insufficientReason = '';
          try {
            const availNanoStr = liveQuota?.availQuotaNano ?? liveQuota?.remainingNano;
            if (!liveQuota?.unlimitedQuota && availNanoStr !== undefined && availNanoStr !== null && order?.tonNano) {
              if (BigInt(String(order.tonNano)) > BigInt(String(availNanoStr))) {
                insufficientReason = L('当前剩余购箱额度不足，请降低档位或检查订单', 'Insufficient remaining purchase quota');
              }
            }
          } catch (_) {}

          const ok = await tonConnect.confirmBeforeSign({
            title: L('确认宝箱购箱付款（签名前核验）', 'Confirm Chest Purchase Payment'),
            contractLabel: L('兑换热钱包 PresaleHotWallet', 'PresaleHotWallet'),
            targetAddress: order.payTo,
            principalText: `${priceGram} GRAM → ${formatNum(Math.round(orderA9), 0)} A9`,
            gasText: `+${deliveryGram} GRAM (${L('固定配送费', 'fixed delivery fee')})`,
            totalText: `${totalPayGram} GRAM`,
            memo: order.memo,
            note: L('钱包发起费另计。请通过订单付款。符合条件的订单退款扣 0.03 GRAM。', 'Wallet sending fees apply separately. Pay through the order. Eligible refunds deduct 0.03 GRAM.'),
            insufficientReason,
            confirmText: L('确认并唤起钱包付款', 'Confirm & Pay in Wallet'),
          });
          if (!ok) return;

          await tonConnect.sendV15PresaleTx(order);
          A9Haptic.success();
          showToast(L(`已提交购箱交易（订单 ${order.orderId}），正在等待链上确认与 A9 发放…`, `Order ${order.orderId} signed, waiting for on-chain confirmation…`));
          const pendingTx = pendingTxManager.start({
            kind: 'presale',
            title: `购买 ${sel?.zh || 'A9 宝箱'}`,
            titleEn: `Buy ${sel?.en || 'A9 Chest'}`,
            amountText: `${totalPayGram} GRAM`,
            explorerAddress: order.payTo,
            refId: order.orderId,
            targetRoute: '/internal/records',
            maxAttempts: 12,
          });
          const TERMINAL_STATUSES = new Set(['COMPLETED', 'REFUNDED', 'NEEDS_REVIEW', 'PAYMENT_EXCEPTION', 'EXPIRED', 'CANCELLED']);
          pendingTxManager.pollUntilConfirmed({
            txId: pendingTx?.id,
            intervalMs: 4000,
            maxAttempts: 12,
            checkFn: async () => {
              const orders = await fetchPresaleOrders(walletAddr);
              if (!Array.isArray(orders)) return false;
              liveOrdersCount = orders.length;
              const found = orders.find((o) => o.orderId === order.orderId);
              if (!found || !TERMINAL_STATUSES.has(found.status)) return false;
              if (found.status === 'COMPLETED') {
                const finTotalA9 = rawToA9(found.totalA9Raw ?? found.a9AmountRaw) ?? orderA9;
                return {
                  confirmed: true,
                  order: found,
                  detail: `订单 ${order.orderId} 已合并直发 ${formatNum(Math.round(finTotalA9), 0)} A9。`,
                  detailEn: `Order ${order.orderId} credited ${formatNum(Math.round(finTotalA9), 0)} A9 directly.`,
                };
              }
              return { terminal: true, order: found };
            },
            onConfirmed: (pollRes) => {
              const finOrd = pollRes?.order || null;
              const finBase = rawToA9(finOrd?.baseA9Raw ?? finOrd?.a9AmountRaw) ?? orderA9;
              const finBonus = rawToA9(finOrd?.bonusA9Raw) ?? 0;
              const finTotal = rawToA9(finOrd?.totalA9Raw) ?? (finBase + finBonus);
              let finCritTier = finOrd?.critTier || '';
              if (!finCritTier && finBonus > 0 && Number(sel?.maxBoostA9) > 0) {
                const ratio = finBonus / Number(sel.maxBoostA9);
                finCritTier = ratio >= 0.45 ? 'jackpot' : (ratio >= 0.15 ? 'lucky' : 'normal');
              }
              const isFinTop = finCritTier === 'jackpot' || finCritTier === 'legendary';
              const isFinHigh = isFinTop || finCritTier === 'high' || finCritTier === 'lucky' || finCritTier === 'bonus';
              openChestCelebrationModal({
                tier: resolveChestTier(sel || selectedSkuId),
                title: L(sel?.zh || '宝箱', sel?.en || 'Chest'),
                baseA9: finBase,
                bonusA9: finBonus,
                totalA9: finTotal,
                openedCount: 1,
                critCount: isFinHigh ? 1 : 0,
                legendaryCount: isFinTop ? 1 : 0,
              });
              loadChests();
            },
            onTimeout: () => {
              showToast(L(`订单 ${order.orderId} 区块确认较慢，可点顶部状态条前往 Tonviewer 核验`, `Order ${order.orderId} taking longer; verify on Tonviewer`), 'amber');
            },
          }).then((res) => {
            if (res?.terminal && res.result?.order) {
              const st = res.result.order.status;
              if (st === 'REFUNDED') {
                showToast(L(`订单 ${order.orderId} 已触发原路退款，请在购箱小票查看明细`, `Order ${order.orderId} refunded; check receipts`), 'amber');
              } else if (st === 'EXPIRED' || st === 'CANCELLED') {
                showToast(L(`订单 ${order.orderId} 已过期/取消，若已付款将自动原路退款`, `Order ${order.orderId} expired/cancelled; any payment will be refunded`), 'amber');
              } else {
                showToast(L(`订单 ${order.orderId} 已进入人工复核，请在购箱小票关注处理进度`, `Order ${order.orderId} queued for review`), 'amber');
              }
              loadChests();
            }
          });
          await loadChests();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('购箱下单或钱包签名失败，请重试', 'Purchase or wallet signing failed'), 'error');
        } finally {
          buyBusy = false;
          if (root.isConnected) render();
        }
      };
    }

    const starterBtn = root.querySelector('#btn-claim-starter');
    if (starterBtn) {
      starterBtn.onclick = async () => {
        starterBtn.disabled = true;
        try {
          await claimStarterChests();
          A9Haptic.success();
          showToast(L('已领取新手青铜箱（200 A9），免助力可直接秒开！', 'Starter Bronze Chest (200 A9) claimed—open instantly!'));
          await loadChests();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('领取失败，请重试', 'Claim failed'), 'error');
          starterBtn.disabled = false;
        }
      };
    }

    const allChests = [...(chestData.freeChests || []), ...(chestData.shopChests || [])];
    root.querySelectorAll('[data-share-tg]').forEach((b) => {
      b.onclick = () => {
        const found = allChests.find((c) => c.chestId === b.dataset.shareTg);
        if (found) shareChestToTg(found);
      };
    });
    root.querySelectorAll('[data-share-x]').forEach((b) => {
      b.onclick = () => {
        const found = allChests.find((c) => c.chestId === b.dataset.shareX);
        if (found) shareChestToX(found);
      };
    });
    const openBatchChests = async (tierKey = null, fallbackTitle = '') => {
      if (!store.fundsEnabled) {
        A9Haptic.warning();
        showToast(L('当前真实模式处于只读验收阶段，宝箱开箱入账暂未开放', 'Live mode is read-only; chest opening is disabled'), 'amber');
        return;
      }
      const targets = tierKey
        ? activeShopChests.filter((c) => resolveChestTier(c) === tierKey)
        : activeShopChests;
      if (!targets.length || openAllBusy) return;
      openAllBusy = true;
      render();
      let batchRes = null;
      let lastErr = null;
      try {
        batchRes = await openAllChests({
          tier: tierKey,
          stateForDemo: store.state,
          walletAddress: store.state.user.address,
        });
      } catch (e) {
        lastErr = e;
      }
      openAllBusy = false;
      await loadChests();
      if (batchRes && Number(batchRes.openedCount || 0) > 0) {
        let bestTier = tierKey || 'bronze';
        if (!tierKey) {
          for (const c of targets) {
            const t = resolveChestTier(c);
            if (TIER_PRIORITY.indexOf(t) < TIER_PRIORITY.indexOf(bestTier)) bestTier = t;
          }
        }
        const batchBaseA9 = rawToA9(batchRes.totalBaseA9Raw) || 0;
        const batchBonusA9 = rawToA9(batchRes.totalRewardA9Raw) || 0;
        openChestCelebrationModal({
          tier: bestTier,
          title: fallbackTitle || L(targets[0].labelZh, targets[0].labelEn),
          baseA9: batchBaseA9,
          bonusA9: batchBonusA9,
          totalA9: batchBaseA9 + batchBonusA9,
          openedCount: Number(batchRes.openedCount || 0),
          critCount: Number(batchRes.critCount || 0),
          legendaryCount: Number(batchRes.legendaryCount || 0),
          budgetCapped: Number(batchRes.budgetCappedCount || 0) > 0,
        });
      } else if (lastErr) {
        A9Haptic.error();
        showToast(lastErr?.message || L('暂未满足开箱条件', 'Open requirements not yet met'), 'amber');
      }
    };

    const openAllBtn = root.querySelector('#btn-open-all-chests');
    if (openAllBtn) {
      openAllBtn.onclick = () => openBatchChests(null);
    }

    root.querySelectorAll('[data-open-tier]').forEach((b) => {
      b.onclick = () => {
        const tierKey = b.dataset.openTier;
        const meta = CHEST_TIER_META[tierKey];
        openBatchChests(tierKey, meta ? L(`${meta.shortZh}宝箱`, `${meta.shortEn} Chest`) : '');
      };
    });

    root.querySelectorAll('[data-open-chest]').forEach((b) => {
      b.onclick = async () => {
        if (!store.fundsEnabled) {
          A9Haptic.warning();
          showToast(L('当前真实模式处于只读验收阶段，宝箱开箱入账暂未开放', 'Live mode is read-only; chest opening is disabled'), 'amber');
          return;
        }
        const cid = b.dataset.openChest;
        const target = allChests.find((c) => c.chestId === cid);
        b.disabled = true;
        try {
          const res = await openChestById(cid, store.state, store.state.user.address);
          const gotA9 = rawToA9(res?.rewardA9Raw) || 0;
          openChestCelebrationModal({
            tier: resolveChestTier(target || 'gold'),
            title: target ? L(target.labelZh, target.labelEn) : L('宝箱', 'Chest'),
            totalA9: gotA9,
            openedCount: 1,
            nextUnlocked: res?.nextUnlocked || null,
          });
          await loadChests();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('暂未满足开箱条件', 'Open requirements not yet met'), 'amber');
          b.disabled = false;
        }
      };
    });
  };

  if (query.from === 'activation') {
    const uid = getEffectiveUserId(store.state.user);
    if (config.isDemo) activationA9 = rawToA9(store.state.prediction.pendingActivationRaw);
    else if (uid) fetchPredictionUser(uid, store.state.round.currentRound).then(data => {
      if (root.isConnected && uid === getEffectiveUserId(store.state.user)) {
        activationA9 = rawToA9(data?.pendingActivationRaw);
        render();
      }
    }).catch(() => {});
  }
  render();
  loadChests();
}

export function renderInternalRecords(root) {
  // 根据支付 GRAM 金额或 skuId 推断对应 6 阶宝箱图标
  const inferTierByGram = (gramVal, skuHint = '') => {
    if (skuHint) return resolveChestTier(skuHint);
    const g = Number(gramVal) || 0;
    if (g >= 400) return 'legendary';
    if (g >= 50) return 'diamond';
    if (g >= 15) return 'platinum';
    if (g >= 8) return 'gold';
    if (g >= 3) return 'silver';
    return 'bronze';
  };

  // 确定性几何防伪条码（根据订单号/哈希生成不同宽度的条纹，零随机闪烁）
  const renderBarcode = (seedStr = 'A9') => {
    const s = String(seedStr || 'A9');
    const widths = Array.from({ length: 10 }, (_, i) => {
      const code = s.charCodeAt(i % s.length) + i * 7;
      return (code % 3) === 0 ? 3 : (code % 2) === 0 ? 2 : 1;
    });
    return `<span class="receipt-barcode" aria-hidden="true">${widths.map((w) => `<i style="width:${w}px;"></i>`).join('')}</span>`;
  };

  const renderReceiptTicket = ({ a9Val, gramVal, statusText, chipCls, tone, serial, copyVal, timeText, tier }) => `
    <article class="nt-receipt-ticket tone-${tone}">
      <div class="receipt-upper">
        <div class="receipt-upper-left">
          <div class="receipt-chest-badge chest-stage-visual tier-${tier}">
            ${renderChestSvg(tier, { size: 36 })}
          </div>
          <div class="receipt-amounts">
            <div class="receipt-a9-val text-green">+${formatNum(Math.round(a9Val), 0)} A9</div>
            <div class="receipt-gram-sub">-${formatNum(gramVal, 2)} GRAM · ${L(CHEST_TIER_META[tier].shortZh, CHEST_TIER_META[tier].shortEn)}</div>
          </div>
        </div>
        <span class="chip ${chipCls}">${escapeHtml(statusText)}</span>
      </div>

      <div class="receipt-perf" aria-hidden="true"><span class="receipt-perf-line"></span></div>

      <div class="receipt-stub">
        <div class="receipt-stub-meta">
          <button type="button" class="receipt-hash-btn" data-copy-receipt="${escapeHtml(copyVal)}">
            <span>#${escapeHtml(serial)}</span>
            ${icon('copy', 11)}
          </button>
          <span class="receipt-time">${escapeHtml(timeText)}</span>
        </div>
        ${renderBarcode(serial)}
      </div>
    </article>
  `;

  let activeFilter = 'all';

  const bindCopyButtons = () => {
    root.querySelectorAll('[data-copy-receipt]').forEach((btn) => {
      btn.onclick = () => {
        A9Haptic.light();
        copyText(btn.dataset.copyReceipt, L('已复制订单凭证号', 'Receipt ID copied'));
      };
    });
  };

  if (!config.isDemo) {
    const addr = store.state.user.address;
    let liveOrdersCache = null;

    const statusMap = {
      PENDING:           ['chip-gold',  'gold',  'pending',   L('待付款', 'Pending')],
      PENDING_PAYMENT:   ['chip-gold',  'gold',  'pending',   L('待付款', 'Pending')],
      PAYMENT_CONFIRMED: ['chip-gold',  'gold',  'pending',   L('已收款', 'Paid')],
      PAYOUT_PENDING:    ['chip-gold',  'gold',  'pending',   L('待发币', 'Queued')],
      PAYOUT_SENT:       ['chip-gold',  'gold',  'pending',   L('核验中', 'Verifying')],
      PAYOUT_RETRY:      ['chip-gold',  'gold',  'pending',   L('重试中', 'Retrying')],
      COMPLETED:         ['chip-green', 'green', 'completed', L('已完成', 'Completed')],
      REFUND_PENDING:    ['chip-gold',  'gold',  'refund',    L('退款中', 'Refunding')],
      REFUND_SENT:       ['chip-gold',  'gold',  'refund',    L('退款核验', 'Verifying')],
      REFUNDED:          ['chip-muted', 'muted', 'refund',    L('已退款', 'Refunded')],
      PAYMENT_EXCEPTION: ['chip-red',   'rose',  'refund',    L('入账异常', 'Exception')],
      NEEDS_REVIEW:      ['chip-red',   'rose',  'refund',    L('人工复核', 'Review')],
      EXPIRED:           ['chip-muted', 'muted', 'refund',    L('已过期', 'Expired')],
      CANCELLED:         ['chip-muted', 'muted', 'refund',    L('已取消', 'Cancelled')],
    };

    const paintLiveOrders = (orders, note = '') => {
      const listAll = Array.isArray(orders) ? orders : [];
      const filtered = activeFilter === 'all'
        ? listAll
        : listAll.filter((o) => (statusMap[o.status]?.[2] || 'pending') === activeFilter);
      const totalA9 = listAll.reduce((sum, o) => sum + (o.status === 'COMPLETED' ? (rawToA9(o.totalA9Raw ?? o.a9AmountRaw) || 0) : 0), 0);

      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <section class="receipt-summary-card">
            <div class="receipt-summary-cell">
              <small>${L('小票总数', 'Total Receipts')}</small>
              <strong>${orders === null ? '—' : formatNum(listAll.length)}</strong>
            </div>
            <div class="receipt-summary-cell">
              <small>${L('已完成入账 A9', 'Completed A9')}</small>
              <strong class="text-green">${orders === null ? '—' : formatNum(Math.round(totalA9), 0)}</strong>
            </div>
          </section>

          <div class="row-between" style="gap:8px;">
            <span class="sw-section-label" style="margin:0;">${L('订单状态筛选', 'Order Status')}</span>
            <button type="button" class="sw-filter-trigger" id="btn-rcpt-filter-sheet">
              <span class="row-start" style="gap:6px;">${icon('filter', 14)} ${escapeHtml(([['all', L('全部', 'All')], ['completed', L('已完成', 'Done')], ['pending', L('处理中', 'Pending')], ['refund', L('退款/异常', 'Refund')]].find(([k]) => k === activeFilter) || ['', L('全部', 'All')])[1])}</span>
              ${icon('chevronDown', 13)}
            </button>
          </div>

          ${note ? `<div class="num-xs text-muted" style="padding:0 2px;">${escapeHtml(note)}</div>` : ''}

          ${filtered.length === 0 ? `
            <div class="card empty-state">
              ${renderChestSvg('gold', { size: 56 })}
              <div class="num-sm text-sec" style="font-weight:800;">${addr ? L('暂无该状态购箱小票', 'No receipts in this state') : L('连接钱包后查看真实小票', 'Connect wallet for live receipts')}</div>
              <button class="btn btn-primary btn-sm" style="margin-top:4px;" data-nav="/internal/market" type="button">${L('前往宝箱商城', 'Go to Chest Mall')}</button>
            </div>
          ` : `
            <div class="col-gap">
              ${filtered.map((o) => {
                const [chipCls, tone, , statusText] = statusMap[o.status] || ['chip-muted', 'muted', 'pending', o.status || '—'];
                const a9Val = rawToA9(o.totalA9Raw ?? o.a9AmountRaw) || 0;
                const principalGramVal = Number(BigInt(String(o.tonNano || '0'))) / 1e9;
                const payGramVal = Number(BigInt(String(o.payTonNano || o.tonNano || '0'))) / 1e9;
                const ts = o.createdAt ? new Date(Number(o.createdAt) * 1000).toLocaleString() : '—';
                const serial = o.orderId || 'A9-ORD';
                return renderReceiptTicket({
                  a9Val,
                  gramVal: payGramVal,
                  statusText,
                  chipCls,
                  tone,
                  serial,
                  copyVal: serial,
                  timeText: ts,
                  tier: inferTierByGram(principalGramVal, o.skuId),
                });
              }).join('')}
            </div>
          `}

          ${totalA9 >= 100 ? `
            <div class="sw-menu-group">
              <a class="sw-menu-row" href="#/challenge/confirm?amt=${Math.floor(totalA9)}">
                <div class="sw-menu-left">
                  <span class="sw-menu-title">${L('带着已入账 A9 进战场锁仓', 'Lock Credited A9 in Current Round')}</span>
                  <span class="sw-menu-sub">${L('100 A9 起参战 · 头矿 6H 仅 5% 止损，通关分 700,000,000 A9 奖池', 'From 100 A9 · First 6H 5% SL · split 700,000,000 A9 pool')}</span>
                </div>
                <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
              </a>
            </div>
          ` : ''}
          ${filtered.length > 0 ? `<button class="btn btn-secondary" data-nav="/internal/market" type="button">${icon('arrowLeft', 15)} ${L('返回宝箱商城', 'Back to Chest Mall')}</button>` : ''}
        </div>
      `;

      const liveFilterBtn = root.querySelector('#btn-rcpt-filter-sheet');
      if (liveFilterBtn) {
        liveFilterBtn.onclick = () => openChoiceSheet({
          title: L('筛选订单小票', 'Filter Order Receipts'),
          selected: activeFilter,
          options: [
            { value: 'all', icon: 'receipt', tone: 'is-blue', label: L('全部小票', 'All Receipts') },
            { value: 'completed', icon: 'checkCircle', tone: 'is-green', label: L('已完成', 'Completed') },
            { value: 'pending', icon: 'clock', tone: 'is-amber', label: L('处理中', 'Pending') },
            { value: 'refund', icon: 'shieldAlert', tone: 'is-red', label: L('退款 / 异常', 'Refund / Exception') },
          ],
          onSelect: (val) => { activeFilter = val; paintLiveOrders(liveOrdersCache, note); },
        });
      }
      bindCopyButtons();
    };

    if (!addr) {
      liveOrdersCache = [];
      paintLiveOrders([], L('连接并验证 TON 钱包后自动同步服务端小票', 'Connect & verify wallet to sync receipts'));
      return;
    }
    paintLiveOrders(null, L('正在读取真实订单小票…', 'Loading live receipts…'));
    fetchPresaleOrders(addr)
      .then((orders) => {
        liveOrdersCache = Array.isArray(orders) ? orders : [];
        if (root.isConnected) paintLiveOrders(liveOrdersCache);
      })
      .catch((e) => {
        liveOrdersCache = [];
        if (root.isConnected) paintLiveOrders([], e?.message || L('小票读取失败，请重试', 'Failed to load receipts'));
      });
    return;
  }

  // Demo 模式：精美任天堂实体购箱小票视图
  const { records } = store.state.market;
  const paintDemo = () => {
    const classify = (r) => {
      const code = String(r?.statusCode || '').toUpperCase();
      if (code === 'COMPLETED') return 'completed';
      if (code === 'REFUNDED') return 'refund';
      if (code === 'PENDING') return 'pending';
      const st = String(r?.status || '');
      if (st === '已成交' || st === '演示成交' || st === '演示直接开箱' || st.startsWith('演示已发本金')) return 'completed';
      if (st === '已退款' || st === '退款中') return 'refund';
      return 'pending';
    };
    const filtered = activeFilter === 'all' ? records : records.filter((r) => classify(r) === activeFilter);
    const totalA9 = records.reduce((sum, r) => sum + (Number(r.a9) || 0), 0);

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="receipt-summary-card">
          <div class="receipt-summary-cell">
            <small>${L('小票总数', 'Total Receipts')}</small>
            <strong>${formatNum(records.length)}</strong>
          </div>
          <div class="receipt-summary-cell">
            <small>${L('累计入账 A9', 'Total A9')}</small>
            <strong class="text-green">${formatNum(Math.round(totalA9), 0)}</strong>
          </div>
        </section>

        <div class="row-between" style="gap:8px;">
          <span class="sw-section-label" style="margin:0;">${L('订单状态筛选', 'Order Status')}</span>
          <button type="button" class="sw-filter-trigger" id="btn-demo-rcpt-filter-sheet">
            <span class="row-start" style="gap:6px;">${icon('filter', 14)} ${escapeHtml(([['all', L('全部', 'All')], ['completed', L('已成交', 'Done')], ['refund', L('退款', 'Refund')]].find(([k]) => k === activeFilter) || ['', L('全部', 'All')])[1])}</span>
            ${icon('chevronDown', 13)}
          </button>
        </div>

        ${filtered.length === 0 ? `
          <div class="card empty-state">
            ${renderChestSvg('gold', { size: 56 })}
            <div class="num-sm text-sec" style="font-weight:800;">${L('暂无购箱小票', 'No receipts yet')}</div>
            <button class="btn btn-primary btn-sm" style="margin-top:4px;" data-nav="/internal/market" type="button">${L('前往宝箱商城', 'Go to Chest Mall')}</button>
          </div>
        ` : `
          <div class="col-gap">
            ${filtered.map((r) => {
              const kind = classify(r);
              const isDone = kind === 'completed';
              const isRefund = kind === 'refund';
              const chipCls = isDone ? 'chip-green' : isRefund ? 'chip-muted' : 'chip-gold';
              const tone = isDone ? 'green' : isRefund ? 'muted' : 'gold';
              const statusText = L(
                r.status || (isDone ? '已成交' : isRefund ? '已退款' : '处理中'),
                r.statusEn || (isDone ? 'Demo Filled' : isRefund ? 'Refunded' : 'Pending'),
              );
              return renderReceiptTicket({
                a9Val: Number(r.a9) || 0,
                gramVal: Number(r.ton) || 0,
                statusText,
                chipCls,
                tone,
                serial: r.hash || 'A9-DEMO',
                copyVal: r.hash || 'A9-DEMO',
                timeText: r.time || '—',
                tier: inferTierByGram(r.ton, r.skuId),
              });
            }).join('')}
          </div>
        `}

        ${totalA9 >= 100 ? `
          <div class="sw-menu-group">
            <a class="sw-menu-row" href="#/challenge/confirm?amt=${Math.floor(totalA9)}">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('带着已入账 A9 进战场锁仓', 'Lock Credited A9 in Current Round')}</span>
                <span class="sw-menu-sub">${L('100 A9 起参战 · 头矿 6H 仅 5% 止损，通关分 700,000,000 A9 奖池', 'From 100 A9 · First 6H 5% SL · split 700,000,000 A9 pool')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
          </div>
        ` : ''}
        ${filtered.length > 0 ? `<button class="btn btn-secondary" data-nav="/internal/market" type="button">${icon('arrowLeft', 15)} ${L('返回宝箱商城', 'Back to Chest Mall')}</button>` : ''}
      </div>
    `;

    const demoFilterBtn = root.querySelector('#btn-demo-rcpt-filter-sheet');
    if (demoFilterBtn) {
      demoFilterBtn.onclick = () => openChoiceSheet({
        title: L('筛选订单小票', 'Filter Order Receipts'),
        selected: activeFilter,
        options: [
          { value: 'all', icon: 'receipt', tone: 'is-blue', label: L('全部小票', 'All Receipts') },
          { value: 'completed', icon: 'checkCircle', tone: 'is-green', label: L('已成交', 'Completed') },
          { value: 'refund', icon: 'shieldAlert', tone: 'is-muted', label: L('退款', 'Refunded') },
        ],
        onSelect: (val) => { activeFilter = val; paintDemo(); },
      });
    }
    bindCopyButtons();
  };

  paintDemo();
}
