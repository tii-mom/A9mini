import { personalRanks, teamRanks, DEMO_CHEST_SKUS, demoBuyChest } from '../demo-data.js';
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
import { escapeHtml, formatNum, formatTimer, showToast, copyText, burstParticles, openModal, closeModal } from '../components.js';
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

export function renderWarmupHome(root, navigate, _param = null, query = {}) {
  const queryRoundId = Number(query?.round);
  const requestedRoundId = Number.isInteger(queryRoundId) && queryRoundId >= 1 ? queryRoundId : null;
  let loadSeq = 0;
  let state = {
    loading: true,
    error: null,
    data: null,
    busy: false,
    selectedTier: null,
    remindEnabled: true,
  };

  const canOpenChestNow = () => config.isDemo || store.fundsEnabled;

  const formatPlannedOpen = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return L('由协议公告通知', 'TBA by announcement');
    try {
      return new Date(n).toLocaleString(L('zh-CN', 'en-US'), {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return L('待公布', 'TBA');
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
      state.remindEnabled = myRes ? Boolean(myRes.remindEnabled) : true;
      store.update((s) => {
        s.user.warmupRegistered = Boolean(data?.isReserved);
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
    const targetRoundId =
      Number(d?.roundId) ||
      requestedRoundId ||
      ((Number(d?.currentOnchainRoundId ?? store.state.round?.currentRound) || 0) + 1);
    const totalRegistered = Number(d?.stats?.totalRegistered ?? 0);
    const walletBoundCount = Number(d?.stats?.walletBoundCount ?? 0);
    const targetUsers = Number(d?.config?.targetUsers ?? 0);
    const progressPct = Math.max(0, Math.min(100, Number(d?.stats?.progressPct ?? 0)));
    const isRoundOpen = d ? Boolean(d.open) : true;
    const myRes = d?.myReservation && d.myReservation.status === 'ACTIVE' ? d.myReservation : null;
    const chest = d?.myWarmupChest || null;
    const isReserved = Boolean(myRes);
    const hasTgAuth = config.isDemo || Boolean(A9TMA.getRawInitData());

    const fallbackDeepLink = config.isDemo
      ? `${window.location.origin}${window.location.pathname}?startapp=warmup_${targetRoundId}_demo01`
      : buildTmaDeepLink(`warmup_${targetRoundId}_${getShareRef()}`);
    const inviteUrl = d?.inviteDeepLink || fallbackDeepLink;

    const validInvites = Number(myRes?.validInvites ?? chest?.currentAssists ?? 0);
    const rawInvites = Number(myRes?.rawInvites ?? 0);
    const baseReq = Number(chest?.requiredAssists ?? d?.config?.chestMinInvites ?? 2);
    const maxFriends = Number(d?.config?.chestMaxInvites ?? 5);
    const totalChestA9 = chest ? (rawToA9(chest.totalA9Raw ?? chest.baseA9Raw) || 0) : 0;
    const baseUnlockA9 = rawToA9(d?.config?.chestBaseA9Raw || '300000000000') || 300;
    const maxChestA9 = rawToA9(
      (BigInt(String(d?.config?.chestBaseA9Raw || '300000000000')) +
        BigInt(Math.max(0, maxFriends - baseReq)) * BigInt(String(d?.config?.chestStepA9Raw || '200000000000'))).toString()
    ) || 900;
    const chestPct = maxFriends > 0 ? Math.min(100, Math.round((Math.min(validInvites, maxFriends) / maxFriends) * 100)) : 0;
    const chestOpened = chest?.status === 'OPENED';
    const chestReady = Boolean(chest && !chestOpened && (chest.status === 'READY' || validInvites >= baseReq));

    const openTimeText = formatPlannedOpen(d?.config?.plannedOpenAtMs);

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero">
          <div class="row-between" style="margin-bottom:8px;">
            <span class="chip chip-gold">${L(`第 ${targetRoundId} 轮开局预热`, `Round ${targetRoundId} Warm-Up`)}</span>
            <span class="chip ${!isRoundOpen ? 'chip-muted' : isReserved ? 'chip-green' : 'chip-muted'}">${!isRoundOpen ? L('本轮预约已关闭', 'Closed') : isReserved ? L('已预约', 'Reserved') : L('零门槛预约', '0-Cost Reserve')}</span>
          </div>

          <div class="num-xs text-muted">${L('当前全网已预约参与人数', 'Total Reserved Players')}</div>
          <div class="row-between" style="align-items:baseline;margin-top:4px;gap:8px;">
            <div class="num-hero mono">${state.loading && !d ? '—' : formatNum(totalRegistered)} <span class="num-md text-sec">${L('人', 'players')}</span></div>
            <span class="num-xs text-sec mono">${targetUsers > 0 ? `${L('目标', 'Goal')} ${formatNum(targetUsers)} (${progressPct}%)` : '—'}</span>
          </div>

          <div class="progress-track" style="height:8px;margin:10px 0 8px;">
            <div class="progress-fill" style="width:${progressPct}%;"></div>
          </div>

          <div class="metric-strip cols-3" style="margin-bottom:12px;">
            <div class="metric-cell">
              <span class="num-xs text-muted">${L('活跃钱包已绑', 'Wallet Bound')}</span>
              <span class="num-md mono">${state.loading && !d ? '—' : formatNum(walletBoundCount)}</span>
            </div>
            <div class="metric-cell">
              <span class="num-xs text-muted">${L('我的预热邀请', 'My Invites')}</span>
              <span class="num-md mono text-green">${isReserved ? `${validInvites}/${rawInvites}` : '0'}</span>
            </div>
            <div class="metric-cell">
              <span class="num-xs text-muted">${L('预计开轮时间', 'Est. Open')}</span>
              <span class="num-xs mono" style="font-weight:700;">${escapeHtml(openTimeText)}</span>
            </div>
          </div>

          ${state.error ? `
            <div class="sub-tile" style="margin-bottom:10px;border-color:var(--gold-border);">
              <div class="row-between">
                <span class="num-xs text-red">${escapeHtml(state.error)}</span>
                <button class="btn btn-secondary btn-sm" id="btn-warmup-retry" type="button">${L('重试', 'Retry')}</button>
              </div>
            </div>
          ` : ''}

          ${!isRoundOpen ? `
            <button class="btn btn-secondary" type="button" disabled>${icon('lock', 15)} ${L('本轮预热预约已暂停或结束', 'Warm-Up Closed')}</button>
          ` : !isReserved ? `
            <button class="btn btn-primary" id="btn-register-warmup" type="button" ${state.busy ? 'disabled' : ''}>
              ${icon('bolt', 16)} ${state.busy ? L('提交中…', 'Reserving…') : L(`一键预约第 ${targetRoundId} 轮 · 领专属预热宝箱`, `Reserve Round ${targetRoundId} & Get Chest`)}
            </button>
          ` : `
            <div class="grid-2" style="gap:8px;">
              <button class="btn btn-primary" id="btn-share-warmup" type="button">${icon('send', 15)} ${L('邀友预热解锁宝箱', 'Invite to Unlock')}</button>
              <button class="btn btn-secondary" id="btn-copy-invite" type="button">${icon('copy', 15)} ${L('复制预热链接', 'Copy Link')}</button>
            </div>
          `}
        </section>

        <section class="card">
          <div class="card-header">
            <div class="card-title">${icon('trophy', 15, 'text-gold')} ${L(`第 ${targetRoundId} 轮预热裂变宝箱`, `Round ${targetRoundId} Warm-Up Chest`)}</div>
            <span class="chip ${chestOpened ? 'chip-muted' : chestReady ? 'chip-green' : 'chip-gold'}">
              ${chestOpened ? L('已开箱入库', 'Opened') : chestReady ? L('可开箱', 'Ready') : isReserved ? L('解锁中', 'In Progress') : L('预约即领', 'Free on Reserve')}
            </span>
          </div>
          <p class="num-xs text-sec" style="margin:0 0 10px;line-height:1.5;">
            ${L(`邀好友预约并绑钱包，最高解锁 ${formatNum(maxChestA9)} A9（入待激活金库）。`, `Invite wallet-bound friends to unlock up to ${formatNum(maxChestA9)} A9.`)}
          </p>

          <div class="sub-tile" style="margin-bottom:10px;">
            <div class="row-between num-xs" style="margin-bottom:6px;">
              <span>${L('有效活跃钱包好友', 'Valid Wallet Friends')}: <b class="mono">${validInvites} / ${maxFriends}</b> <span class="text-muted">(${L(`已预约 ${rawInvites} 人`, `${rawInvites} reserved`)})</span></span>
              <b class="mono text-green">${chestReady || chestOpened ? `${formatNum(totalChestA9)} A9` : L(`满 ${baseReq} 人解锁 ${formatNum(baseUnlockA9)} A9`, `${formatNum(baseUnlockA9)} A9 at ${baseReq}`)}</b>
            </div>
            <div class="progress-track" style="height:7px;margin-bottom:6px;">
              <div class="progress-fill" style="width:${chestPct}%;"></div>
            </div>
            <div class="row-between num-xs text-muted">
              <span>2 ${L('人', 'inv')} = 300 A9</span>
              <span>3 ${L('人', 'inv')} = 500 A9</span>
              <span>4 ${L('人', 'inv')} = 700 A9</span>
              <span class="text-gold" style="font-weight:700;">5 ${L('人', 'inv')} = ${formatNum(maxChestA9)} A9</span>
            </div>
          </div>

          ${isReserved && chest ? `
            <div class="grid-2" style="gap:8px;">
              <button class="btn btn-secondary btn-sm" id="btn-warmup-share-chest" type="button">${icon('send', 13)} ${L('分享拉好友绑钱包', 'Share Invite')}</button>
              <button class="btn ${chestReady && canOpenChestNow() ? 'btn-primary' : 'btn-secondary'} btn-sm" id="btn-open-warmup-chest" type="button" ${chestOpened || !chestReady || !canOpenChestNow() || state.busy ? 'disabled' : ''}>
                ${icon(chestOpened ? 'checkCircle' : canOpenChestNow() ? 'unlock' : 'lock', 13)}
                ${chestOpened ? L('已开箱入待激活金库', 'Opened to Vault') : !canOpenChestNow() ? L('只读模式暂未开放开箱', 'Read-Only Mode') : chestReady ? L(`开启宝箱 (+${formatNum(totalChestA9)} A9)`, `Open (+${formatNum(totalChestA9)} A9)`) : L(`还差 ${Math.max(0, baseReq - validInvites)} 位有效好友`, `${Math.max(0, baseReq - validInvites)} more needed`)}
              </button>
            </div>
          ` : `
            <div class="num-xs text-muted">${L('预约即发本轮宝箱；好友绑定活跃 TON 钱包后自动计入进度。', 'Reserve to get your chest; wallet-bound friends count automatically.')}</div>
          `}
        </section>

        <section class="card">
          <div class="card-header">
            <div class="card-title">${icon('clock', 15, 'text-gold')} ${L('意向档位与开轮提醒（可选）', 'Intent Tier & Opening Alert (Optional)')}</div>
            <span class="chip chip-muted">${L('不锁资金', 'Non-binding')}</span>
          </div>
          <div class="num-xs text-muted" style="margin-bottom:8px;">${L('选填你本轮预计锁仓的 A9 体量（链上最低 100 A9，随时可改，不扣款）：', 'Optionally select your planned A9 lock size (min on-chain lock 100 A9, non-binding):')}</div>
          <div class="grid-2" style="gap:8px;margin-bottom:10px;">
            ${WARMUP_INTENT_OPTIONS.map((opt) => {
              const active = state.selectedTier === opt.key;
              return `<button type="button" class="btn btn-sm ${active ? 'btn-primary' : 'btn-secondary'}" data-intent-tier="${opt.key}" ${!isRoundOpen || state.busy ? 'disabled' : ''}>${L(opt.zh, opt.en)}</button>`;
            }).join('')}
          </div>
          <div class="list-row" style="padding:8px 10px;">
            <div>
              <div class="num-sm" style="font-weight:700;">${L('开轮 Bot 私信通知', 'Bot DM Opening Alert')}</div>
              <div class="num-xs text-muted">${L('第 ' + targetRoundId + ' 轮开盘时第一时间推送头矿 6H · 5% 轻止损入口', 'Get notified when Round ' + targetRoundId + ' opens (First 6H · 5% Stop-Loss)')}</div>
            </div>
            <button type="button" class="chip ${state.remindEnabled ? 'chip-green' : 'chip-muted'}" id="btn-toggle-remind" style="cursor:pointer;border:none;" ${!isRoundOpen || state.busy ? 'disabled' : ''}>
              ${state.remindEnabled ? L('已开启', 'ON') : L('已关闭', 'OFF')}
            </button>
          </div>
        </section>

        <div class="grid-2">
          <button class="btn btn-secondary" data-nav="/warmup/rank" type="button">${icon('trophy', 15)} ${L('预热裂变榜', 'Warm-Up Board')}</button>
          <button class="btn btn-secondary" id="btn-copy-invite-bottom" type="button">${icon('copy', 15)} ${L('复制专属链接', 'Copy Link')}</button>
        </div>

        ${isReserved ? `<button class="btn btn-sm" id="btn-cancel-warmup" type="button" style="width:100%;background:transparent;color:var(--text-muted);font-weight:500;" ${state.busy ? 'disabled' : ''}>${L('取消本轮预热预约', 'Cancel Warm-Up Reservation')}</button>` : ''}
        ${!hasTgAuth ? `<div class="num-xs text-muted" style="text-align:center;">${L('请在 Telegram 小程序内打开以完成零门槛预约与接收 Bot 开轮提醒。', 'Open inside Telegram Mini App to reserve and receive Bot alerts.')}</div>` : ''}
      </div>
    `;

    const retryBtn = root.querySelector('#btn-warmup-retry');
    if (retryBtn) retryBtn.onclick = () => load();

    const submitReserve = async (overrides = {}) => {
      if (!config.isDemo && !A9TMA.getRawInitData()) {
        showToast(L('请在 Telegram 小程序内打开后再一键预约', 'Open inside Telegram Mini App to reserve'), 'amber');
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
      const shareText = L(
        `我已预约 A9 第 ${targetRoundId} 轮开局预热！点链接零门槛预约立领专属预热宝箱，绑活跃 TON 钱包一起解锁最高 ${formatNum(maxChestA9)} A9：`,
        `I reserved A9 Round ${targetRoundId} Warm-Up! Tap to reserve with 0 cost, get your Warm-Up Chest, and unlock up to ${formatNum(maxChestA9)} A9:`
      );
      A9TMA.shareInvite(inviteUrl, shareText);
      showToast(L('已调起 Telegram 好友分享', 'Opened Telegram share'));
    };

    const shareBtn = root.querySelector('#btn-share-warmup');
    if (shareBtn) shareBtn.onclick = doShare;
    const shareChestBtn = root.querySelector('#btn-warmup-share-chest');
    if (shareChestBtn) shareChestBtn.onclick = doShare;

    const copyHandler = () => copyText(inviteUrl, L('已复制专属预热链接', 'Copied warm-up link'));
    const copyTop = root.querySelector('#btn-copy-invite');
    if (copyTop) copyTop.onclick = copyHandler;
    const copyBottom = root.querySelector('#btn-copy-invite-bottom');
    if (copyBottom) copyBottom.onclick = copyHandler;

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

    const toggleRemind = root.querySelector('#btn-toggle-remind');
    if (toggleRemind) {
      toggleRemind.onclick = async () => {
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
          paint();
        }
      };
    }

    const openWarmupChestBtn = root.querySelector('#btn-open-warmup-chest');
    if (openWarmupChestBtn && chest) {
      openWarmupChestBtn.onclick = async () => {
        if (!canOpenChestNow()) {
          A9Haptic.warning();
          showToast(L('当前真实模式处于只读验收阶段，宝箱开箱入账暂未开放', 'Live mode is read-only; chest opening disabled'), 'amber');
          return;
        }
        state.busy = true;
        paint();
        try {
          const res = await openChestById(chest.chestId, store.state, store.state.user.address);
          const gotA9 = rawToA9(res?.rewardA9Raw) || totalChestA9;
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
          showToast(e?.message || L(`暂未满足开箱条件（需 ≥${baseReq} 位绑定活跃钱包的预约好友）`, `Need ≥${baseReq} wallet-bound friends to open`), 'amber');
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

  load();
}

export function renderWarmupRank(root) {
  if (!config.isDemo) {
    const panel = document.createElement('div');
    panel.className = 'card col-gap';
    root.replaceChildren(panel);
    let rankSeq = 0;
    const load = async () => {
      const seq = ++rankSeq;
      panel.textContent = L('正在读取预热裂变榜…', 'Loading warm-up leaderboard…');
      try {
        let targetRoundId = Number(store.state.round.currentRound) ? Number(store.state.round.currentRound) + 1 : 1;
        try {
          const cur = await fetchWarmupCurrent();
          if (cur?.roundId) targetRoundId = Number(cur.roundId);
        } catch (_) {}
        const rows = await fetchWarmupRank(targetRoundId);
        if (seq !== rankSeq || !panel.isConnected) return;
        panel.replaceChildren();
        const header = document.createElement('div');
        header.className = 'card-header';
        header.innerHTML = `<div class="card-title">${icon('trophy', 15, 'text-gold')} ${L(`第 ${targetRoundId} 轮预热裂变榜`, `Round ${targetRoundId} Warm-Up Board`)}</div><span class="chip chip-muted">${Array.isArray(rows) ? rows.length : 0}</span>`;
        panel.append(header);
        if (!Array.isArray(rows) || !rows.length) {
          const empty = document.createElement('div');
          empty.className = 'num-xs text-muted';
          empty.textContent = L('暂无预热邀请排名，快去预约并邀请好友冲榜！', 'No warm-up rankings yet.');
          panel.append(empty);
          return;
        }
        for (const entry of rows) {
          const row = document.createElement('div');
          row.className = 'list-row';
          const uid = entry.tgUserId ?? entry.userId;
          const who = entry.label || entry.walletAddress || (uid ? `TG#${String(uid).slice(-4)}` : L('玩家', 'Player'));
          const rawPart = Number(entry.rawInvites) > Number(entry.validInvites)
            ? ` (${L('共邀', 'total')} ${entry.rawInvites})`
            : '';
          row.textContent = `#${entry.rank} · ${who} · ${entry.validInvites} ${L('位有效邀请', 'valid invites')}${rawPart}`;
          panel.append(row);
        }
      } catch {
        if (seq !== rankSeq || !panel.isConnected) return;
        panel.textContent = L('榜单暂不可读取', 'Rankings unavailable');
        const retry = document.createElement('button');
        retry.className = 'btn btn-secondary';
        retry.textContent = L('重试', 'Retry');
        retry.onclick = load;
        panel.append(retry);
      }
    };
    load();
    return;
  }
  let tab = 'personal';
  const paint = () => {
    const rows = tab === 'personal' ? personalRanks : teamRanks;
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card" style="border-color:var(--gold-border);">
          <div class="row-between">
            <div>
              <div class="num-xs text-gold">${L('前 50 名守门员门槛 · 每 5 分钟刷新', 'Top 50 Cutoff · Refreshes 5m')}</div>
              <div style="font-size:14px;font-weight:700;margin-top:3px;">≥ 6 ${L('名有效直邀 (冻结后 T+24H 公示)', 'Valid Invites (Final at T+24H)')}</div>
            </div>
            <span class="chip chip-green">DEMO</span>
          </div>
        </div>

        <div class="seg-tabs">
          <button class="seg-tab ${tab === 'personal' ? 'active' : ''}" data-wt="personal">${L('个人先锋榜 (前50)', 'Top 50 Users')}</button>
          <button class="seg-tab ${tab === 'team' ? 'active' : ''}" data-wt="team">${L('战队先锋榜', 'Top Squads')}</button>
        </div>

        <div class="card">
          <div class="col-gap">
            ${rows.map(item => `
              <div class="list-row ${item.me ? 'is-me' : ''}">
                <div class="row-start">
                  <span class="chip ${item.me ? 'chip-green' : item.cutoff ? 'chip-gold' : 'chip-muted'}">#${item.r}</span>
                  <span class="num-sm" style="font-weight:${item.me ? '700' : '500'};">${item.addr}</span>
                </div>
                <div style="text-align:right;">
                  <div class="num-sm text-green" style="font-weight:600;">${item.reward}</div>
                  <div class="num-xs text-muted">${item.invites} ${L('人', 'inv')}</div>
                </div>
              </div>
            `).join('')}
          </div>
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
  let activeTab = query?.tab === 'free' ? 'free' : 'mall';
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
    if (config.isDemo) return DEMO_CHEST_SKUS;
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
          ${query.from === 'activation' && (config.isDemo ? rawToA9(store.state.prediction.pendingActivationRaw) : activationA9) > 0 ? `<section class="card"><div class="card-title">${L('待激活奖励', 'Pending activation')} · ${formatNum(activationA9)} A9</div><p>${L('购箱后，符合条件的奖励将并入推广余额。宝箱内的 A9 单独直发钱包。', 'Eligible rewards move to your referral balance after purchase. Chest contents go directly to your wallet.')}</p></section>` : ''}
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
                  <span>${L(`明细：${sel.priceGram} + ${sel.deliveryFeeGram || '0.06'} Gas · 随机区间`, `Breakdown: ${sel.priceGram} + ${sel.deliveryFeeGram || '0.06'} gas · Random range`)}</span>
                  <span class="num-xs text-muted">▾</span>
                </summary>
                <div class="sub-tile" style="padding:8px 10px;margin-top:6px;">
                  <div class="row-between num-xs">
                    <span class="text-sec">${L('宝箱货款（保底 + 随机合并直发）', 'Chest Base + Random Bonus')}</span>
                    <span class="mono">${sel.priceGram} GRAM</span>
                  </div>
                  <div class="row-between num-xs" style="margin-top:4px;">
                    <span class="text-sec">${L('链上发币 Gas（仅收一次）', 'Single Delivery Gas')}</span>
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
          const res = demoBuyChest(store.state, selectedSkuId, 'INSTANT', getEffectiveUserId(store.state.user));
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
            gasText: `+${deliveryGram} GRAM (${L('A9 链上发币 Gas', 'delivery gas')})`,
            totalText: `${totalPayGram} GRAM`,
            memo: order.memo,
            note: L('请核对订单 Memo 并通过钱包签名支付；切勿向热钱包直接转账（异常/过期退款扣除 0.03 GRAM Gas）。', 'Keep order memo intact; never transfer directly (invalid/late refunds deduct 0.03 GRAM gas).'),
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

          <div class="filter-row">
            ${[
              ['all', L('全部', 'All')],
              ['completed', L('已完成', 'Done')],
              ['pending', L('处理中', 'Pending')],
              ['refund', L('退款/异常', 'Refund')],
            ].map(([k, lbl]) => `<button type="button" class="filter-pill ${activeFilter === k ? 'active' : ''}" data-rcpt-filter="${k}">${lbl}</button>`).join('')}
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

          <button class="btn btn-secondary" data-nav="/internal/market" type="button">${icon('arrowLeft', 15)} ${L('返回宝箱商城', 'Back to Chest Mall')}</button>
        </div>
      `;

      root.querySelectorAll('[data-rcpt-filter]').forEach((b) => {
        b.onclick = () => {
          A9Haptic.light();
          activeFilter = b.dataset.rcptFilter;
          paintLiveOrders(liveOrdersCache, note);
        };
      });
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

        <div class="filter-row">
          ${[
            ['all', L('全部', 'All')],
            ['completed', L('已成交', 'Done')],
            ['refund', L('退款', 'Refund')],
          ].map(([k, lbl]) => `<button type="button" class="filter-pill ${activeFilter === k ? 'active' : ''}" data-rcpt-filter="${k}">${lbl}</button>`).join('')}
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

        <button class="btn btn-secondary" data-nav="/internal/market" type="button">${icon('arrowLeft', 15)} ${L('返回宝箱商城', 'Back to Chest Mall')}</button>
      </div>
    `;

    root.querySelectorAll('[data-rcpt-filter]').forEach((b) => {
      b.onclick = () => {
        A9Haptic.light();
        activeFilter = b.dataset.rcptFilter;
        paintDemo();
      };
    });
    bindCopyButtons();
  };

  paintDemo();
}
