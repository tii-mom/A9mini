/**
 * 我的 / 资产 / 结算 / 凭证 / 账本 / 连闯页
 * 任天堂 Switch 菜单化统一升级：资产卡 → 可领取 → 进行中 → 我的记录 → 提醒与设置。
 * 严格遵循 Demo / Live 模式隔离，绝不把 null 当 0，也不混用演示与真实只读数据。
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { peekDemoModule } from '../demo-loader.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast, copyText, openModal, closeModal, openChoiceSheet } from '../components.js';
import { mountSlider, renderCorridorRadar, bindCorridorRadarEvents, animateSlotCounter, launchCoinArc, burstParticles } from '../components-heavy.js';
import { renderVaultChestSvg, renderNintendoGateIcon } from '../paper-art.js';
import { renderChestSvg } from '../chest-art.js';
import { renderProofFlexPoster, renderStoryPoster, downloadPosterPng } from '../poster.js';
import { openXShareSheet, triggerStoryShare } from '../share.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { tonConnect } from '../tonconnect.js';
import { fetchUserPortfolio, fetchPromoBalance, fetchPredictionUser, fetchPresaleOrders, fetchMyStakeReferrals, getEffectiveUserId, rawToA9, serverNowMs } from '../data.js';
import { deriveRoundUiState, deriveTicketRoundStatusLabel } from '../round-state.js';
import { renderMyRewardsPage } from './rewards.js';
import { pendingTxManager, buildTonviewerUrl } from '../tx-ux.js';

function renderMiniBarcode() {
  const bars = [2, 1, 3, 1, 2, 2, 1, 3, 1, 2];
  return `<span class="receipt-barcode" aria-hidden="true">${bars.map((w) => `<i style="width:${w}px;"></i>`).join('')}</span>`;
}

function parseA9Number(str) {
  const m = String(str || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

let profileRenderSeq = 0;

function formatA9Amount(val, { loading = false } = {}) {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) {
    return loading ? '…' : '—';
  }
  const n = Number(val);
  return `${formatNum(n, n % 1 === 0 ? 0 : 2)} A9`;
}

function activePassStageLabel(item) {
  return deriveTicketRoundStatusLabel(item, store.state.round, serverNowMs());
}

function renderProfileSwitchView({
  hasWallet = false,
  availA9 = null,
  gramBalance = null,
  roundClaimableA9 = null,
  promoClaimableA9 = null,
  roundLockedA9 = null,
  predPendingA9 = null,
  activePasses = [],
  certsCount = null,
  loading = false,
  claimError = false,
  predError = false,
  isLive = false,
  isDemoEmpty = false,
} = {}) {
  const gramText = (gramBalance !== null && gramBalance !== undefined && Number.isFinite(Number(gramBalance)))
    ? `${formatNum(Number(gramBalance), 2)} GRAM`
    : '— GRAM';

  const isReadOnlyLive = isLive && !store.fundsEnabled;
  const assetBadge = !hasWallet
    ? `<span class="chip chip-amber">${L('未连接', 'Unlinked')}</span>`
    : loading
      ? `<span class="chip chip-muted">${L('读取中', 'Syncing')}</span>`
      : isReadOnlyLive
        ? `<span class="chip chip-muted">${L('只读', 'Read-Only')}</span>`
        : '';

  const assetMainHtml = !hasWallet
    ? `<button type="button" class="sw-asset-connect-btn" id="profile-asset-connect">${L('连接钱包查看资产', 'Connect Wallet')} <span class="sw-menu-arrow" style="color:var(--nt-red);">›</span></button>`
    : (availA9 !== null && availA9 !== undefined && Number.isFinite(Number(availA9)))
      ? `<div class="sw-asset-main">${formatNum(Number(availA9), Number(availA9) % 1 === 0 ? 0 : 2)} <span class="sw-asset-main-unit">A9</span></div>`
      : `<div class="sw-asset-main">${loading ? '…' : '—'}</div>`;

  const bothExplicitZero = hasWallet && !loading && !claimError &&
    roundClaimableA9 !== null && roundClaimableA9 !== undefined && Number(roundClaimableA9) === 0 &&
    promoClaimableA9 !== null && promoClaimableA9 !== undefined && Number(promoClaimableA9) === 0;

  const roundAmtText = formatA9Amount(roundClaimableA9, { loading });
  const promoAmtText = formatA9Amount(promoClaimableA9, { loading });
  const lockedAmtText = formatA9Amount(roundLockedA9, { loading });
  const predAmtText = formatA9Amount(predPendingA9, { loading });

  const roundAmtCls = Number(roundClaimableA9) > 0 ? 'is-green' : (roundClaimableA9 == null ? 'is-muted' : '');
  const promoAmtCls = Number(promoClaimableA9) > 0 ? 'is-green' : (promoClaimableA9 == null ? 'is-muted' : '');
  const predAmtCls = Number(predPendingA9) > 0 ? 'is-amber' : (predPendingA9 == null ? 'is-muted' : '');
  const lockedAmtCls = roundLockedA9 == null ? 'is-muted' : '';
  const hasPredPending = Number(predPendingA9) > 0;

  const claimSectionHtml = `
    <div>
      <div class="sw-section-label">${L('可领取', 'Claimable')}</div>
      <div class="sw-menu-group" id="profile-claimable-group">
        ${bothExplicitZero ? `
          <div class="sw-menu-row is-static">
            <span class="sw-row-icon is-muted" aria-hidden="true">${icon('trophy', 17)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title text-muted">${L('暂无可领奖励', 'No claimable rewards')}</span>
              <span class="sw-menu-sub">${L('轮次通关或邀友返佣入账后将在此展示', 'Round payouts & referral credits appear here')}</span>
            </div>
          </div>
        ` : `
          <a class="sw-menu-row sw-amount-row" href="#/rewards">
            <span class="sw-row-icon is-green" aria-hidden="true">${icon('trophy', 17)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('轮次奖励', 'Round Rewards')}</span>
              <span class="sw-menu-sub">${L('本金退还与已解锁奖金', 'Principal & unlocked prizes')}</span>
            </div>
            <div class="sw-menu-right">
              <span class="sw-menu-amount ${roundAmtCls}">${roundAmtText}</span>
              <span class="sw-menu-arrow" aria-hidden="true">›</span>
            </div>
          </a>
          <a class="sw-menu-row sw-amount-row" href="#/team/invite">
            <span class="sw-row-icon is-amber" aria-hidden="true">${icon('squadEmblem', 17)}</span>
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('推广奖励', 'Referral Rewards')}</span>
              <span class="sw-menu-sub">${L('商城 6% · 通关 8% 返佣', '6% mall · 8% pass credits')}</span>
            </div>
            <div class="sw-menu-right">
              <span class="sw-menu-amount ${promoAmtCls}">${promoAmtText}</span>
              <span class="sw-menu-arrow" aria-hidden="true">›</span>
            </div>
          </a>
        `}
        ${claimError ? `
          <div class="sw-menu-error" role="alert">
            <span>${L('读取失败', 'Read failed')}</span>
            <button type="button" class="sw-retry-link" data-profile-retry="1">${L('重试', 'Retry')}</button>
          </div>
        ` : ''}
      </div>
    </div>
  `;

  const activePassRows = activePasses.map((item) => {
    const roundId = item.roundId ?? item.round ?? '—';
    const amt = isLive ? rawToA9(item.amountRaw) : Number(item.stakeTon);
    const amtText = formatA9Amount(amt, { loading: false });
    const href = isLive
      ? (item.ticketAddress ? `#/rewards?ticket=${encodeURIComponent(item.ticketAddress)}` : '#/rewards')
      : (item.id ? `#/proof/${encodeURIComponent(item.id)}` : '#/proof');
    const stageSub = activePassStageLabel(item, isLive);
    return `
      <a class="sw-menu-row sw-amount-row" href="${href}">
        <span class="sw-row-icon is-blue" aria-hidden="true">${icon('lock', 16)}</span>
        <div class="sw-menu-left">
          <span class="sw-menu-title">${L(`第 ${escapeHtml(String(roundId))} 轮本金`, `Round ${escapeHtml(String(roundId))} Principal`)}</span>
          <span class="sw-menu-sub">${stageSub}</span>
        </div>
        <div class="sw-menu-right">
          <span class="sw-menu-amount">${amtText}</span>
          <span class="sw-menu-arrow" aria-hidden="true">›</span>
        </div>
      </a>
    `;
  }).join('');

  const inProgressHtml = `
    <div>
      <div class="sw-section-label">${L('进行中', 'In Progress')}</div>
      <div class="sw-menu-group" id="profile-progress-group">
        ${activePassRows}
        <a class="sw-menu-row sw-amount-row" href="#/rewards">
          <span class="sw-row-icon is-green" aria-hidden="true">${icon('unlock', 16)}</span>
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('待解锁奖金', 'Pending Unlock')}</span>
            <span class="sw-menu-sub">${L('14 天逐秒解锁', '14D per-second unlock')}</span>
          </div>
          <div class="sw-menu-right">
            <span class="sw-menu-amount ${lockedAmtCls}">${lockedAmtText}</span>
            <span class="sw-menu-arrow" aria-hidden="true">›</span>
          </div>
        </a>
        <a class="sw-menu-row sw-amount-row" href="${hasPredPending ? '#/internal/market?from=activation' : '#/round?panel=prediction'}">
          <span class="sw-row-icon is-amber" aria-hidden="true">${icon('stamp', 16)}</span>
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('待激活预言奖', 'Pending Activation')}</span>
            <span class="sw-menu-sub">${hasPredPending ? L('去宝箱商城激活', 'Activate in Chest Mall') : L('0 GRAM 预言擂台奖励', '0 GRAM arena rewards')}</span>
          </div>
          <div class="sw-menu-right">
            <span class="sw-menu-amount ${predAmtCls}">${predAmtText}</span>
            <span class="sw-menu-arrow" aria-hidden="true">›</span>
          </div>
        </a>
        ${predError ? `
          <div class="sw-menu-error" role="alert">
            <span>${L('预言奖励读取失败', 'Prediction read failed')}</span>
            <button type="button" class="sw-retry-link" data-profile-retry="1">${L('重试', 'Retry')}</button>
          </div>
        ` : ''}
      </div>
    </div>
  `;

  const emptyGuideHtml = isDemoEmpty ? `
    <section class="card">
      <div class="empty-state" style="padding:10px 8px 6px;">
        <span class="nt-art-badge tone-red" aria-hidden="true">${icon('wallet', 22)}</span>
        <div style="font-size:15px;font-weight:900;margin-top:4px;">${L('还没有锁仓持仓', 'No Active Lock Position Yet')}</div>
        <div class="text-sec" style="font-size:12px;max-width:260px;">${L('最低 100 A9 无门槛锁仓，头矿 6H · 5% 止损，永不爆仓。', 'Lock from 100 A9 — First 6H · 5% Stop-Loss, No Liquidation.')}</div>
        <div class="grid-2" style="width:100%;margin-top:10px;gap:8px;">
          <a class="btn btn-primary btn-sm" href="#/challenge/confirm">${icon('bolt', 14)} ${L('立即锁仓', 'Lock Now')}</a>
          <a class="btn btn-secondary btn-sm" href="#/internal/market">${icon('chest', 14)} ${L('宝箱商城', 'Chest Mall')}</a>
        </div>
      </div>
    </section>
  ` : '';

  const passCountLabel = (certsCount !== null && certsCount !== undefined && Number.isFinite(Number(certsCount)))
    ? L(`闯关凭证 · ${certsCount}`, `Passes · ${certsCount}`)
    : L('闯关凭证', 'Passes');

  return `
    <div class="col-gap anim-page-enter">
      <section class="sw-asset-card" id="profile-asset-card">
        <span class="sw-asset-accent" aria-hidden="true"></span>
        <div class="sw-asset-body">
          <div class="row-between" style="gap:8px;">
            <span class="sw-section-label profile-asset-label">${L('可用 A9 余额', 'Available A9')}</span>
            ${assetBadge}
          </div>
          ${assetMainHtml}
          <div class="sw-asset-foot">
            <span class="sw-asset-sub">${escapeHtml(gramText)}</span>
            <span class="num-xs text-muted">${hasWallet ? L('按来源分项展示', 'Shown by source') : L('非托管只读查询', 'Non-custodial read')}</span>
          </div>
        </div>
      </section>

      ${claimSectionHtml}
      ${inProgressHtml}
      ${emptyGuideHtml}

      <div>
        <div class="sw-section-label">${L('我的记录', 'My Records')}</div>
        <nav class="sw-record-grid" aria-label="${L('我的记录', 'My Records')}">
          <a class="sw-record-tile" href="#/proof">
            <span class="sw-record-icon is-red">${icon('shieldCheck', 18)}</span>
            <span class="sw-record-label">${escapeHtml(passCountLabel)}</span>
          </a>
          <a class="sw-record-tile" href="#/internal/records">
            <span class="sw-record-icon is-amber">${icon('chest', 18)}</span>
            <span class="sw-record-label">${L('商城订单', 'Orders')}</span>
          </a>
          <a class="sw-record-tile" href="#/ledger">
            <span class="sw-record-icon is-green">${icon('receipt', 18)}</span>
            <span class="sw-record-label">${L('收支账本', 'Ledger')}</span>
          </a>
        </nav>
      </div>

      <div class="sw-menu-group">
        <a class="sw-menu-row" href="#/settings">
          <span class="sw-row-icon is-muted" aria-hidden="true">${icon('settings', 16)}</span>
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('提醒与设置', 'Alerts & Settings')}</span>
            <span class="sw-menu-sub">${L('主题、语言、通知与钱包管理', 'Theme, language, alerts & wallet')}</span>
          </div>
          <div class="sw-menu-right">
            <span class="sw-menu-arrow" aria-hidden="true">›</span>
          </div>
        </a>
      </div>
    </div>
  `;
}

export function renderProfileHome(root, navigate) {
  if (!config.isDemo) {
    const seq = ++profileRenderSeq;
    const u = store.state.user;
    const addr = u.address || null;
    const uid = getEffectiveUserId(u);
    const roundId = store.state.round?.currentRound || null;

    const paintLive = (state) => {
      if (seq !== profileRenderSeq || !root.isConnected) return;
      root.innerHTML = renderProfileSwitchView({
        ...state,
        hasWallet: Boolean(store.state.user.address),
        gramBalance: store.state.user.tonBalance,
        isLive: true,
      });
      const connBtn = root.querySelector('#profile-asset-connect');
      if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderProfileHome(root, navigate));
      root.querySelectorAll('[data-profile-retry]').forEach((btn) => {
        btn.onclick = () => {
          A9Haptic.light();
          renderProfileHome(root, navigate);
        };
      });
    };

    paintLive({ loading: Boolean(addr || uid) });

    if (addr || uid) {
      Promise.allSettled([
        addr ? fetchUserPortfolio(addr) : Promise.resolve(null),
        addr ? fetchPromoBalance(addr) : Promise.resolve(null),
        uid ? fetchPredictionUser(uid, roundId) : Promise.resolve(null),
      ]).then(([portRes, promoRes, predRes]) => {
        if (seq !== profileRenderSeq || !root.isConnected || store.state.user.address !== addr) return;
        const portData = portRes.status === 'fulfilled' ? portRes.value : null;
        const promoData = promoRes.status === 'fulfilled' ? promoRes.value : null;
        const predData = predRes.status === 'fulfilled' ? predRes.value : null;

        const portErr = Boolean(addr && (portRes.status === 'rejected' || portData?.ticketsAvailable === false));
        const promoErr = Boolean(addr && promoRes.status === 'rejected');
        const predErr = Boolean(uid && predRes.status === 'rejected');

        const availA9 = (portData && portData.balanceAvailable !== false && portData.a9BalanceRaw !== null && portData.a9BalanceRaw !== undefined)
          ? rawToA9(portData.a9BalanceRaw)
          : null;
        const tickets = Array.isArray(portData?.tickets) ? portData.tickets : [];
        const activePasses = tickets.filter((t) => t && !t.exited && !t.principalDone && !t.forfeited);
        const roundClaimableA9 = (portData && portData.claimableRaw !== undefined && portData.claimableRaw !== null)
          ? rawToA9(portData.claimableRaw)
          : null;
        const roundLockedA9 = (portData && portData.lockedRaw !== undefined && portData.lockedRaw !== null)
          ? rawToA9(portData.lockedRaw)
          : null;
        const promoClaimableA9 = (promoData && promoData.claimableRaw !== undefined && promoData.claimableRaw !== null)
          ? rawToA9(promoData.claimableRaw)
          : null;
        const predPendingA9 = (predData && predData.pendingActivationRaw !== undefined && predData.pendingActivationRaw !== null)
          ? rawToA9(predData.pendingActivationRaw)
          : null;

        paintLive({
          availA9,
          roundClaimableA9,
          promoClaimableA9,
          roundLockedA9,
          predPendingA9,
          activePasses,
          certsCount: portData?.ticketsAvailable ? tickets.length : null,
          loading: false,
          claimError: portErr || promoErr,
          predError: predErr,
        });
      });
    }
    return;
  }

  const { user, certificates } = store.state;
  const isEmpty = user.profileMode === 'empty';
  const activePasses = isEmpty
    ? []
    : (certificates || []).filter((c) => c && (c.status === 'observation' || c.status === 'participation'));

  root.innerHTML = renderProfileSwitchView({
    hasWallet: Boolean(user.connected),
    availA9: isEmpty ? 0 : (user.a9Available ?? null),
    gramBalance: isEmpty ? 0 : user.tonBalance,
    roundClaimableA9: isEmpty ? 0 : (user.a9Claimable ?? 0),
    promoClaimableA9: isEmpty ? 0 : (user.promoClaimableA9 ?? 0),
    roundLockedA9: isEmpty ? 0 : (user.a9Locked ?? 0),
    predPendingA9: isEmpty ? 0 : (rawToA9(store.state.prediction?.pendingActivationRaw) ?? 0),
    activePasses,
    certsCount: isEmpty ? 0 : (certificates || []).length,
    loading: false,
    claimError: false,
    predError: false,
    isLive: false,
    isDemoEmpty: isEmpty,
  });

  const connBtn = root.querySelector('#profile-asset-connect');
  if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderProfileHome(root, navigate));
}

/** 历史 #/claim 兼容导出：统一委托至最终形态「我的奖励」（js/pages/rewards.js）。 */
export function renderClaimPage(root, navigate, param, query = {}) {
  return renderMyRewardsPage(root, navigate, param, query);
}

let proofRenderSeq = 0;

function liveTicketStatusText(t) {
  const ticketStage = deriveRoundUiState({ detail: { rawState: t?.roundState }, user: { connected: true }, serverNowMs: serverNowMs() }).stage;
  if (t?.pending) return L('链上确认中', 'Pending');
  if (t?.exited) return L('已提前解押', 'Early Exited');
  if (t?.forfeited) return L('已 3 折急提', 'Instant Cashed Out');
  if (ticketStage === 'stake') return L('24H 锁仓中', '24H Lock Open');
  if (ticketStage === 'sealed') return L('已封盘 · 待冲价', 'Sealed · Awaiting Push');
  if (ticketStage === 'charge') return L('12H 冲价中', '12H Push');
  if (ticketStage === 'settling') return L('结算中', 'Settling');
  if (ticketStage === 'failed') return t?.principalDone ? L('已领止损退本', 'Refunded') : L('可领止损退本', 'Stop-Loss Refund');
  if (ticketStage === 'aborted') return t?.principalDone ? L('已全额退本', 'Refunded') : L('可领全额退本', '100% Refund');
  if (t?.canClaim) return L('可领取', 'Claimable');
  if (t?.principalDone) return Number(rawToA9(t?.lockedRemainingRaw) || 0) > 0 ? L('14 天解锁中', '14D Unlocking') : L('已全额领完', 'Fully Claimed');
  if (ticketStage === 'unknown') return L('持有中', 'Active');
  return deriveTicketRoundStatusLabel(t, null, serverNowMs());
}

export function renderProofDetail(root, navigate, certId) {
  if (config.isDemo && certId && !store.state.certificates.some(cert => cert.id === certId)) {
    root.innerHTML = `<section class="card col-gap"><strong>${L('找不到该凭证', 'Ticket not found')}</strong><a class="btn btn-secondary" href="#/proof">${L('返回凭证列表', 'Back to tickets')}</a></section>`;
    return;
  }
  if (!config.isDemo) {
    const seq = ++proofRenderSeq;
    const addr = store.state.user.address || null;

    const paintLive = ({ loading = false, error = false, data = null } = {}) => {
      if (seq !== proofRenderSeq || !root.isConnected) return;
      const tickets = (data?.tickets || []).filter(ticket => !certId || ticket.ticketAddress === certId);
      if (certId && data?.ticketsAvailable && tickets.length === 0) {
        root.innerHTML = `<section class="card col-gap"><strong>${L('找不到该凭证', 'Ticket not found')}</strong><a class="btn btn-secondary" href="#/proof">${L('返回凭证列表', 'Back to tickets')}</a></section>`;
        return;
      }
      const range = data?.ticketRange || null;
      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <section class="card card-hero">
            <div class="row-between" style="margin-bottom:6px;">
              <span class="card-title">${icon('shieldCheck', 15, 'text-green')} ${L('我的链上闯关凭证', 'My On-Chain Passes')}</span>
              ${tickets.length ? `<span class="chip chip-muted mono">${tickets.length}</span>` : ''}
            </div>
            <div class="num-xs text-sec" style="line-height:1.5;">
              ${range && range.fromRound && range.toRound
                ? L(`已扫描第 ${range.fromRound} 至第 ${range.toRound} 轮链上 StakeTicket 凭证，点击任意凭证查看领奖与解锁详情。`, `Scanned Rounds ${range.fromRound}–${range.toRound} StakeTickets. Tap any pass to view claim & unlock details.`)
                : L('连接 TON 钱包即可读取链上 StakeTicket 锁仓凭证，点击直达领奖与解锁页。', 'Connect TON wallet to load on-chain StakeTicket passes and jump directly to claim details.')}
            </div>
          </section>

          ${!addr ? `
            <section class="card empty-state">
              <span class="nt-art-badge tone-red" aria-hidden="true">${renderNintendoGateIcon('ticket', 34)}</span>
              <div style="font-weight:900;font-size:15px;margin-top:4px;">${L('请先连接钱包', 'Connect Wallet First')}</div>
              <div class="num-xs text-sec" style="max-width:250px;">${L('连接非托管 TON 钱包后即可查看各轮 StakeTicket 凭证与解锁状态。', 'Connect your non-custodial TON wallet to view StakeTicket passes.')}</div>
              <button class="btn btn-primary btn-sm" id="btn-proof-live-connect" style="margin-top:10px;" type="button">${L('连接钱包', 'Connect Wallet')}</button>
            </section>
          ` : loading ? `
            <div class="sw-menu-group">
              <div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('正在读取链上凭证…', 'Loading on-chain passes…')}</span></div></div>
            </div>
          ` : error ? `
            <div class="sw-menu-group">
              <div class="sw-menu-error" role="alert">
                <span>${L('读取失败', 'Read failed')}</span>
                <button type="button" class="sw-retry-link" id="btn-proof-live-retry">${L('重试', 'Retry')}</button>
              </div>
            </div>
          ` : tickets.length === 0 ? `
            <section class="card empty-state">
              <span class="nt-art-badge tone-red" aria-hidden="true">${renderNintendoGateIcon('ticket', 34)}</span>
              <div style="font-weight:900;font-size:15px;margin-top:4px;">${L('暂无闯关凭证', 'No Quest Passes Yet')}</div>
              <div class="num-xs text-sec" style="max-width:250px;">${L('完成任意一轮 A9 锁仓入场后，链上将自动铸造 StakeTicket 凭证。', 'Lock A9 in any round to mint an on-chain StakeTicket pass.')}</div>
              <a class="btn btn-primary btn-sm" style="margin-top:10px;" href="#/round">${icon('bolt', 14)} ${L('查看本轮闯关', 'View Current Round')}</a>
            </section>
          ` : `
            <div>
              <div class="sw-section-label">${L('全部凭证', 'All Passes')}</div>
              <div class="sw-menu-group">
                ${tickets.map((t) => {
                  const amtA9 = rawToA9(t.amountRaw);
                  const earlyA9 = rawToA9(t.earlyAmountRaw) ?? 0;
                  const lateA9 = rawToA9(t.lateAmountRaw) ?? 0;
                  const splitText = (earlyA9 > 0 && lateA9 > 0)
                    ? L(`头矿 ${formatNum(earlyA9, 0)} / 普通 ${formatNum(lateA9, 0)}`, `First 6H ${formatNum(earlyA9, 0)} / Std ${formatNum(lateA9, 0)}`)
                    : (earlyA9 > 0 ? L('头矿 6H · 5% 止损', 'First 6H · 5% SL') : L('普通 · 10% 止损', 'Standard · 10% SL'));
                  const statusTxt = liveTicketStatusText(t);
                  const href = t.ticketAddress ? `#/rewards?ticket=${encodeURIComponent(t.ticketAddress)}` : '#/rewards';
                  return `
                    <a class="sw-menu-row" href="${href}">
                      <div class="sw-menu-left">
                        <span class="sw-menu-title">${L(`第 ${escapeHtml(String(t.roundId ?? '—'))} 轮`, `Round #${escapeHtml(String(t.roundId ?? '—'))}`)} · ${escapeHtml(statusTxt)}</span>
                        <span class="sw-menu-sub">${escapeHtml(splitText)}</span>
                      </div>
                      <div class="sw-menu-right">
                        <span class="sw-menu-amount ${t.canClaim ? 'is-green' : ''}">${formatA9Amount(amtA9)}</span>
                        <span class="sw-menu-arrow" aria-hidden="true">›</span>
                      </div>
                    </a>
                  `;
                }).join('')}
              </div>
            </div>
          `}

          <div class="sw-menu-group">
            <a class="sw-menu-row" href="#/rewards">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('前往领奖中心', 'Go to Claims')}</span></div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
            <a class="sw-menu-row" href="#/profile">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('返回我的', 'Back to Me')}</span></div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
          </div>
        </div>
      `;
      const connBtn = root.querySelector('#btn-proof-live-connect');
      if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderProofDetail(root, navigate, certId));
      const retryBtn = root.querySelector('#btn-proof-live-retry');
      if (retryBtn) retryBtn.onclick = () => renderProofDetail(root, navigate, certId);
    };

    if (!addr) {
      paintLive({ loading: false });
      return;
    }
    paintLive({ loading: true });
    fetchUserPortfolio(addr)
      .then((data) => {
        if (seq !== proofRenderSeq || !root.isConnected || store.state.user.address !== addr) return;
        paintLive({ loading: false, data, error: data?.ticketsAvailable === false });
      })
      .catch(() => {
        if (seq !== proofRenderSeq || !root.isConnected || store.state.user.address !== addr) return;
        paintLive({ loading: false, error: true });
      });
    return;
  }

  const certs = Array.isArray(store.state.certificates) ? store.state.certificates : [];
  const cert = certId ? certs.find(c => c.id === certId) : certs[0];
  if (!cert) {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero empty-state">
          <span class="nt-art-badge tone-red" aria-hidden="true">${renderNintendoGateIcon('ticket', 34)}</span>
          <div style="font-weight:900;font-size:16px;margin-top:4px;">${L('暂无闯关凭证', 'No Quest Pass Yet')}</div>
          <div class="num-xs text-muted" style="max-width:250px;">${L('完成任意一轮 A9 锁仓入场后，将自动铸造链上 SBT 锁仓凭证。', 'Complete any round A9 lock entry to mint your on-chain SBT pass.')}</div>
          <button class="btn btn-primary btn-sm" style="margin-top:10px;" data-nav="/challenge/confirm">${icon('bolt', 14)} ${L('立即入场获取凭证', 'Enter to Mint')}</button>
        </div>
        <button class="btn btn-secondary" data-nav="/profile">${icon('arrowLeft', 15)} ${L('返回我的', 'Back to Me')}</button>
      </div>
    `;
    return;
  }

  const round = store.state.round;
  const isSettled = cert.status === 'settled';
  const estLabel = isSettled ? L('实际奖励', 'Confirmed reward') : L('奖励状态', 'Reward status');
  const txHash = cert.txHash || 'PENDING';

  const switcherHtml = certs.length > 1 ? `
    <div class="seg-tabs" role="tablist" aria-label="${L('切换凭证', 'Switch pass')}">
      ${certs.map((c) => {
        const active = c.id === cert.id;
        const tag = c.status === 'settled' ? `+${formatNum(c.estRewardA9)} A9` : L('待结算', 'Unsettled');
        return `<button type="button" class="seg-tab ${active ? 'active' : ''}" data-pick-cert="${escapeHtml(c.id)}">R${c.round} · ${escapeHtml(tag)}</button>`;
      }).join('')}
    </div>
  ` : '';

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      ${switcherHtml}
      <div class="cert-flip-scene" id="cert-flip-scene" role="button" tabindex="0" aria-label="${L('轻点翻转查看链上核验背面', 'Tap to flip for on-chain verification')}">
        <div class="cert-flip-card" id="cert-flip-card">
          <div class="cert-pass cert-detail-card cert-face front ${isSettled ? 'is-settled' : ''}">
            <div class="cert-top-bar">
              <span class="row-start" style="gap:7px;">
                <span class="cert-grip-bars" aria-hidden="true"><i></i><i></i><i></i></span>
                <span class="cert-serial">SBT PASS · R${String(cert.round).padStart(2, '0')}</span>
              </span>
              <span class="cert-status-pill">${icon('shieldCheck', 11)} ${L('链上验真', 'VERIFIED')}</span>
            </div>
            <div class="cert-body">
              <div class="cert-id-row">
                <div style="min-width:0;">
                  <div class="cert-id-title">#${escapeHtml(cert.id)}</div>
                  <button type="button" class="cert-hash-copy-btn" id="copy-cert-hash" title="${L('复制存证哈希', 'Copy Proof Hash')}">
                    <span class="mono">${escapeHtml(txHash)}</span>
                    ${icon('copy', 11)}
                  </button>
                </div>
                <span class="cert-flip-pill">${icon('refresh', 11)} ${L('翻转验真', 'Flip')}</span>
              </div>

              <div class="cert-perf" aria-hidden="true"><span class="cert-perf-line"></span></div>

              <div class="cert-metrics-grid">
                <div class="cert-metric-tile">
                  <small>${L('锁仓本金', 'Locked')}</small>
                  <strong>${formatNum(cert.stakeTon)} <span class="cert-unit">A9</span></strong>
                </div>
                <div class="cert-metric-tile is-gold">
                  <small>${L('单轮封顶', 'Round Cap')}</small>
                  <strong class="text-gold">5×</strong>
                </div>
                <div class="cert-metric-tile is-green">
                  <small>${estLabel}</small>
                  <strong class="text-green">${isSettled ? '+' + formatNum(cert.estRewardA9) + ' A9' : L('待结算', 'Unsettled')}</strong>
                </div>
              </div>
            </div>
            <div class="cert-foot">
              <span class="num-xs text-muted mono">A9 v17.0 · ${isSettled ? L('已结算', 'SETTLED') : L('12H 冲价中', '12H PUSH')}</span>
              ${renderMiniBarcode()}
            </div>
          </div>

          <div class="cert-pass cert-face back">
            <div class="cert-top-bar">
              <span class="row-start" style="gap:7px;">
                <span class="cert-grip-bars" aria-hidden="true"><i></i><i></i><i></i></span>
                <span class="cert-serial">TVM L1 VERIFICATION</span>
              </span>
              <span class="cert-status-pill">${icon('refresh', 11)} ${L('翻回正面', 'Front')}</span>
            </div>
            <div class="cert-body">
              <div class="cert-back-grid">
                <div class="cert-back-row"><span class="text-muted">${L('凭证编号', 'Pass ID')}</span><span class="mono">#${escapeHtml(cert.id)}</span></div>
                <div class="cert-back-row"><span class="text-muted">${L('链上哈希', 'TX Hash')}</span><span class="mono text-green">${escapeHtml(cert.txHash || 'PENDING')}</span></div>
                <div class="cert-back-row"><span class="text-muted">${L('持有地址', 'Holder')}</span><span class="mono">${escapeHtml(store.state.user.shortAddress || '—')}</span></div>
                <div class="cert-back-row"><span class="text-muted">${L('铸造时间', 'Minted')}</span><span class="mono">${escapeHtml(cert.timestamp || '—')}</span></div>
              </div>
              <div class="num-xs text-muted" style="margin-top:auto;">${L('TON 非托管链上存证 · 不可篡改', 'Non-custodial TON on-chain proof')}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="grid-2">
        <button class="btn btn-nt-green" id="btn-flex-cert" style="min-height:46px;font-size:14px;">${icon('qr', 15)} ${L('生成凭证海报', 'Proof Poster')}</button>
        <button class="btn btn-secondary" id="btn-x-proof" style="min-height:46px;font-size:14px;">${icon('xBrand', 14)} ${L('发 X 炫耀凭证', 'Share on X')}</button>
      </div>

      ${renderCorridorRadar(round.candles || [], round.targetPrice, round.activeCandleSec || 0, round.livePrice, { qualified: round.qualifiedCandles || 0, minQualified: round.minQualifiedCandles || 8, seen: round.candlesSeen || 0 })}

      <div class="sw-menu-group">
        <a class="sw-menu-row" href="#/rewards">
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('前往领奖中心', 'Go to Claims')}</span>
            <span class="sw-menu-sub">${L('领取已解锁奖金或查看 14 天解锁', 'Claim rewards or inspect 14D unlock')}</span>
          </div>
          <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
        </a>
        <a class="sw-menu-row" href="#/renew">
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('头矿 6H 开盘提醒', 'First 6H Opening Alert')}</span>
            <span class="sw-menu-sub">${L('非托管不代扣 · 开盘 Bot 私信通知', 'Non-custodial · Bot DM on open')}</span>
          </div>
          <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
        </a>
        <a class="sw-menu-row" href="#/profile">
          <div class="sw-menu-left"><span class="sw-menu-title">${L('返回我的', 'Back to Me')}</span></div>
          <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
        </a>
      </div>
    </div>
  `;

  root.querySelectorAll('[data-pick-cert]').forEach((btn) => {
    btn.onclick = () => {
      const nextId = btn.dataset.pickCert;
      if (!nextId || nextId === cert.id) return;
      A9Haptic.light();
      A9Audio.tick();
      navigate(`/proof/${encodeURIComponent(nextId)}`, { replace: true });
    };
  });

  const flipScene = root.querySelector('#cert-flip-scene');
  const flipCard = root.querySelector('#cert-flip-card');
  if (flipScene && flipCard) {
    const doFlip = () => { A9Haptic.light(); A9Audio.flip(); flipCard.classList.toggle('flipped'); };
    flipScene.onclick = doFlip;
    flipScene.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doFlip(); } };
  }

  root.querySelector('#btn-x-proof').onclick = () => {
    openXShareSheet({
      type: 'proof',
      id: cert.id,
      context: { roundId: cert.round, stakeTon: cert.stakeTon, multiplier: cert.multiplier }
    });
  };

  root.querySelector('#btn-flex-cert').onclick = () => {
    A9Haptic.light();
    let posterMode = 'flex';
    const openProofModal = () => {
      openModal(`
        <div class="sheet-handle"></div>
        <div class="row-between">
          <div class="card-title">${icon('qr', 15, 'text-gold')} ${L('链上凭证炫耀海报', 'Proof Poster')}</div>
          <button class="icon-btn" id="flex-close" aria-label="Close">${icon('x', 15)}</button>
        </div>
        <div class="seg-tabs">
          <button class="seg-tab ${posterMode === 'flex' ? 'active' : ''}" data-pmode="flex" type="button">${L('凭证战报卡', 'Proof Card')}</button>
          <button class="seg-tab ${posterMode === 'story' ? 'active' : ''}" data-pmode="story" type="button">${L('9:16 Story 战报', '9:16 Story')}</button>
        </div>
        <canvas id="flex-modal-canvas" class="poster-canvas ${posterMode === 'story' ? 'story-aspect' : ''}"></canvas>
        <div class="grid-2">
          <button class="btn btn-nt-green" id="flex-dl-btn" style="min-height:46px;font-size:14px;">${icon('download', 15)} ${L('保存高清 PNG', 'Save PNG')}</button>
          <button class="btn btn-secondary" id="flex-story-btn" style="min-height:46px;font-size:14px;">${icon('story', 15)} ${L('一键发 TG Story', 'Post TG Story')}</button>
        </div>
      `);
      const cv = document.getElementById('flex-modal-canvas');
      if (posterMode === 'story') {
        renderStoryPoster(cv, { roundId: cert.round, certId: cert.id, stakeTon: cert.stakeTon });
      } else {
        renderProofFlexPoster(cv, cert);
      }
      document.getElementById('flex-close').onclick = closeModal;
      document.querySelectorAll('[data-pmode]').forEach(b => {
        b.onclick = () => { A9Haptic.light(); posterMode = b.dataset.pmode; openProofModal(); };
      });
      document.getElementById('flex-dl-btn').onclick = () => {
        A9Haptic.success();
        downloadPosterPng(cv, posterMode === 'story' ? `A9-Story-${cert.id}.png` : `A9-Proof-${cert.id}.png`);
        showToast(L('凭证海报已保存', 'Proof poster saved'));
      };
      document.getElementById('flex-story-btn').onclick = () => {
        if (posterMode !== 'story') {
          posterMode = 'story';
          openProofModal();
          const nextCv = document.getElementById('flex-modal-canvas');
          triggerStoryShare({ canvas: nextCv, type: 'proof', id: cert.id, filename: `A9-Story-${cert.id}.png` });
          return;
        }
        triggerStoryShare({ canvas: cv, type: 'proof', id: cert.id, filename: `A9-Story-${cert.id}.png` });
      };
    };
    openProofModal();
  };



  bindCorridorRadarEvents(root);
  root.querySelectorAll('[data-x-share="round"]').forEach(btn => {
    btn.onclick = () => openXShareSheet({
      type: 'round',
      id: round.currentRound || 1,
      context: { roundId: round.currentRound, qualified: round.qualifiedCandles, required: round.minQualifiedCandles }
    });
  });
  const copyHashBtn = root.querySelector('#copy-cert-hash');
  if (copyHashBtn) {
    copyHashBtn.onclick = (e) => {
      e.stopPropagation();
      A9Haptic.light();
      copyText(cert.txHash, L('已复制存证哈希', 'Proof hash copied'));
    };
  }
}

let ledgerRenderSeq = 0;

export function renderLedgerPage(root) {
  if (!config.isDemo) {
    const seq = ++ledgerRenderSeq;
    const addr = store.state.user.address || null;
    const hasTg = Boolean(A9TMA.getRawInitData());
    const activeNet = store.state.round?.protocolConfig?.network || config.network || 'mainnet';
    const tonviewerHref = addr ? buildTonviewerUrl(addr, activeNet) : null;

    const paintLive = ({ loading = false, orders = [], ordersErr = false, refs = null, refsErr = false } = {}) => {
      if (seq !== ledgerRenderSeq || !root.isConnected) return;
      const refItems = Array.isArray(refs?.items) ? refs.items : [];
      const completedOrdersA9 = orders.reduce((s, o) => s + (o.status === 'COMPLETED' ? (rawToA9(o.totalA9Raw ?? o.a9AmountRaw) || 0) : 0), 0);
      const refTotalA9 = refs && refs.totalCommissionRaw !== undefined && refs.totalCommissionRaw !== null ? rawToA9(refs.totalCommissionRaw) : null;

      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <section class="card card-hero col-gap">
            <div class="row-between">
              <span class="card-title">${icon('receipt', 15, 'text-green')} ${L('链上收支账本', 'On-Chain Ledger')}</span>
              ${tonviewerHref ? `<button type="button" class="text-link-btn" id="btn-ledger-tonviewer">Tonviewer ›</button>` : ''}
            </div>
            <div class="sw-menu-group">
              <div class="sw-menu-row is-static">
                <div class="sw-menu-left">
                  <span class="sw-menu-title">${L('商城订单已入账', 'Mall Orders Credited')}</span>
                  <span class="sw-menu-sub">${addr ? L(`共 ${orders.length} 笔订单`, `${orders.length} order(s)`) : L('连接钱包后查看', 'Connect wallet to view')}</span>
                </div>
                <div class="sw-menu-right">
                  <span class="sw-menu-amount ${completedOrdersA9 > 0 ? 'is-green' : ''}">${addr ? (loading ? '…' : formatA9Amount(completedOrdersA9)) : '—'}</span>
                </div>
              </div>
              <div class="sw-menu-row is-static">
                <div class="sw-menu-left">
                  <span class="sw-menu-title">${L('好友通关 8% 返佣', '8% Pass Referral Credits')}</span>
                  <span class="sw-menu-sub">${hasTg ? L(`共 ${refItems.length} 笔返佣`, `${refItems.length} credit(s)`) : L('在 Telegram 内打开查看', 'Open in Telegram to view')}</span>
                </div>
                <div class="sw-menu-right">
                  <span class="sw-menu-amount ${Number(refTotalA9) > 0 ? 'is-green' : 'is-muted'}">${hasTg ? (loading ? '…' : formatA9Amount(refTotalA9)) : '—'}</span>
                </div>
              </div>
            </div>
            ${!addr ? `<button class="btn btn-primary btn-sm" id="btn-ledger-connect" type="button">${icon('wallet', 14)} ${L('连接钱包同步账本', 'Connect Wallet to Sync')}</button>` : ''}
          </section>

          <div>
            <div class="row-between" style="margin-bottom:6px;padding:0 2px;">
              <span class="sw-section-label" style="margin:0;padding:0;">${L('商城购箱订单', 'Chest Mall Orders')}</span>
              <a class="text-link-btn" href="#/internal/records">${L('全部小票', 'All Receipts')} ›</a>
            </div>
            <div class="sw-menu-group">
              ${!addr ? `
                <div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('未连接钱包', 'Wallet not connected')}</span></div></div>
              ` : loading ? `
                <div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('正在读取商城订单…', 'Loading mall orders…')}</span></div></div>
              ` : ordersErr ? `
                <div class="sw-menu-error" role="alert"><span>${L('读取失败', 'Read failed')}</span><button type="button" class="sw-retry-link" data-ledger-retry="1">${L('重试', 'Retry')}</button></div>
              ` : orders.length === 0 ? `
                <div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('暂无商城购箱记录', 'No Chest Mall orders yet')}</span></div></div>
              ` : orders.slice(0, 8).map((o) => {
                const a9Val = rawToA9(o.totalA9Raw ?? o.a9AmountRaw);
                const ts = o.createdAt ? new Date(Number(o.createdAt) * 1000).toLocaleString() : '—';
                return `
                  <a class="sw-menu-row" href="#/internal/records">
                    <div class="sw-menu-left">
                      <span class="sw-menu-title">${L('商城购箱', 'Chest Order')} · #${escapeHtml(String(o.orderId || '—'))}</span>
                      <span class="sw-menu-sub">${escapeHtml(String(o.status || '—'))} · ${escapeHtml(ts)}</span>
                    </div>
                    <div class="sw-menu-right">
                      <span class="sw-menu-amount ${o.status === 'COMPLETED' ? 'is-green' : ''}">${a9Val != null ? `+${formatA9Amount(a9Val)}` : '—'}</span>
                      <span class="sw-menu-arrow" aria-hidden="true">›</span>
                    </div>
                  </a>
                `;
              }).join('')}
            </div>
          </div>

          <div>
            <div class="row-between" style="margin-bottom:6px;padding:0 2px;">
              <span class="sw-section-label" style="margin:0;padding:0;">${L('好友通关 8% 返佣', '8% Pass Referral Credits')}</span>
              <a class="text-link-btn" href="#/team/invite">${L('推广明细', 'Referral')} ›</a>
            </div>
            <div class="sw-menu-group">
              ${!hasTg ? `
                <div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('请在 Telegram 内打开查看返佣记录', 'Open in Telegram to view referral credits')}</span></div></div>
              ` : loading ? `
                <div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('正在读取 8% 返佣记录…', 'Loading 8% referral credits…')}</span></div></div>
              ` : refsErr ? `
                <div class="sw-menu-error" role="alert"><span>${L('读取失败', 'Read failed')}</span><button type="button" class="sw-retry-link" data-ledger-retry="1">${L('重试', 'Retry')}</button></div>
              ` : refItems.length === 0 ? `
                <div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('暂无好友通关 8% 返佣记录', 'No 8% pass referral credits yet')}</span></div></div>
              ` : refItems.slice(0, 8).map((it) => {
                const commA9 = rawToA9(it.commissionRaw);
                const isCred = String(it.status || '').toUpperCase() === 'CREDITED';
                return `
                  <div class="sw-menu-row is-static">
                    <div class="sw-menu-left">
                      <span class="sw-menu-title">${L(`第 ${escapeHtml(String(it.roundId ?? '—'))} 轮返佣`, `Round #${escapeHtml(String(it.roundId ?? '—'))} Credit`)} · <span class="mono">${escapeHtml(it.refereeWallet || '—')}</span></span>
                      <span class="sw-menu-sub">${isCred ? L('已到账', 'Credited') : L('待入账', 'Pending')}</span>
                    </div>
                    <div class="sw-menu-right">
                      <span class="sw-menu-amount is-green">${commA9 != null ? `+${formatA9Amount(commA9)}` : '—'}</span>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>

          <div class="sw-menu-group">
            <a class="sw-menu-row" href="#/proof">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('查看链上闯关凭证', 'View On-Chain Passes')}</span></div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
            <a class="sw-menu-row" href="#/profile">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('返回我的', 'Back to Me')}</span></div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
          </div>
        </div>
      `;

      const connBtn = root.querySelector('#btn-ledger-connect');
      if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderLedgerPage(root));
      const tvBtn = root.querySelector('#btn-ledger-tonviewer');
      if (tvBtn && tonviewerHref) tvBtn.onclick = () => A9TMA.openExternalLink(tonviewerHref);
      root.querySelectorAll('[data-ledger-retry]').forEach((b) => { b.onclick = () => renderLedgerPage(root); });
    };

    if (!addr && !hasTg) {
      paintLive({ loading: false });
      return;
    }
    paintLive({ loading: true });
    Promise.allSettled([
      addr ? fetchPresaleOrders(addr) : Promise.resolve([]),
      hasTg ? fetchMyStakeReferrals(20) : Promise.resolve(null),
    ]).then(([ordRes, refRes]) => {
      if (seq !== ledgerRenderSeq || !root.isConnected || store.state.user.address !== addr) return;
      paintLive({
        loading: false,
        orders: ordRes.status === 'fulfilled' && Array.isArray(ordRes.value) ? ordRes.value : [],
        ordersErr: Boolean(addr && ordRes.status === 'rejected'),
        refs: refRes.status === 'fulfilled' ? refRes.value : null,
        refsErr: Boolean(hasTg && refRes.status === 'rejected'),
      });
    });
    return;
  }

  let viewMode = 'ledger';
  let activeFilter = 'all';
  const rowsAll = store.state.ledger.length ? store.state.ledger : [];
  const categories = [
    ['all', L('全部', 'All')],
    ['user', L('用户奖励', 'User')],
    ['promo', L('邀友奖励', 'Invite')],
    ['warmup', L('开局预热', 'Pre-Round')]
  ];

  const paint = () => {
    if (viewMode === 'records') {
      const history = store.state.certificates;
      const totalStaked = history.reduce((s, c) => s + (c.stakeTon || 0), 0);
      const settledCnt = history.filter(c => c.status === 'settled').length;
      const obsCnt = history.length - settledCnt;

      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <div class="seg-tabs">
            <button class="seg-tab" data-lmode="ledger" type="button">${L('收支账本', 'Ledger')}</button>
            <button class="seg-tab active" data-lmode="records" type="button">${L('闯关战绩', 'History')}</button>
          </div>

          <section class="card card-hero col-gap">
            <div>
              <div class="num-xs text-muted">${L('累计锁仓本金', 'Total Locked Principal')}</div>
              <div class="sw-asset-main" style="margin-top:4px;">${formatNum(totalStaked)} <span class="sw-asset-main-unit">A9</span></div>
            </div>
            <div class="metric-strip cols-3" style="margin:0;padding:8px 0 0;border-bottom:0;">
              <div class="metric-cell"><span class="num-xs text-muted">${L('已结算', 'Settled')}</span><span class="num-sm text-green mono">${settledCnt}</span></div>
              <div class="metric-cell"><span class="num-xs text-muted">${L('12H 冲价中', '12H Push')}</span><span class="num-sm text-cyan mono">${obsCnt}</span></div>
              <div class="metric-cell"><span class="num-xs text-muted">${L('单轮封顶', 'Round Cap')}</span><span class="num-sm text-gold mono">5×</span></div>
            </div>
          </section>

          <div class="sw-menu-group">
            ${history.length === 0
              ? `<div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('暂无闯关战绩', 'No history')}</span></div></div>`
              : history.map(h => `
                <a class="sw-menu-row" href="${h.id ? `#/proof/${encodeURIComponent(h.id)}` : '#/proof'}">
                  <div class="sw-menu-left">
                    <span class="sw-menu-title">${L(`第 ${h.round} 轮`, `Round #${h.round}`)} · #${escapeHtml(h.id)}</span>
                    <span class="sw-menu-sub">${L('锁仓', 'Locked')} ${formatNum(h.stakeTon)} A9 · ${h.status === 'settled' ? L('已结算', 'Settled') : L('12H 冲价中', '12H Push')}</span>
                  </div>
                  <div class="sw-menu-right">
                    <span class="sw-menu-amount ${h.status === 'settled' ? 'is-green' : 'is-amber'}">${h.status === 'settled' ? `+${formatNum(h.estRewardA9)} A9` : L('待结算', 'Unsettled')}</span>
                    <span class="sw-menu-arrow" aria-hidden="true">›</span>
                  </div>
                </a>
              `).join('')}
          </div>
        </div>
      `;
      root.querySelectorAll('[data-lmode]').forEach(b => { b.onclick = () => { A9Haptic.light(); A9Audio.tick(); viewMode = b.dataset.lmode; paint(); }; });
      return;
    }

    const list = activeFilter === 'all' ? rowsAll : rowsAll.filter(r => r.cat === activeFilter);
    const totalEarned = rowsAll.reduce((s, r) => s + parseA9Number(r.amount), 0);
    const userCnt = rowsAll.filter(r => r.cat === 'user').length;
    const promoCnt = rowsAll.filter(r => r.cat === 'promo').length;
    const warmupCnt = rowsAll.filter(r => r.cat === 'warmup').length;

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="seg-tabs">
          <button class="seg-tab active" data-lmode="ledger" type="button">${L('收支账本', 'Ledger')}</button>
          <button class="seg-tab" data-lmode="records" type="button">${L('闯关战绩', 'History')}</button>
        </div>

        <section class="card card-hero col-gap">
          <div>
            <div class="num-xs text-muted">${L('累计记录收益', 'Cumulative Ledger Total')}</div>
            <div class="sw-asset-main text-green" style="margin-top:4px;">+${formatNum(totalEarned)} <span class="sw-asset-main-unit">A9</span></div>
          </div>
          <div class="metric-strip cols-3" style="margin:0;padding:8px 0 0;border-bottom:0;">
            <div class="metric-cell"><span class="num-xs text-muted">${L('用户奖励', 'User')}</span><span class="num-sm mono">${userCnt}</span></div>
            <div class="metric-cell"><span class="num-xs text-muted">${L('邀友奖励', 'Invite')}</span><span class="num-sm text-gold mono">${promoCnt}</span></div>
            <div class="metric-cell"><span class="num-xs text-muted">${L('开局预热', 'Pre-Round')}</span><span class="num-sm text-cyan mono">${warmupCnt}</span></div>
          </div>
        </section>

        <div class="row-between" style="gap:8px;">
          <span class="sw-section-label" style="margin:0;">${L('记录筛选', 'Filter Records')}</span>
          <button type="button" class="sw-filter-trigger" id="btn-ledger-filter-sheet">
            <span class="row-start" style="gap:6px;">${icon('filter', 14)} ${escapeHtml(categories.find(([v]) => v === activeFilter)?.[1] || L('全部', 'All'))}</span>
            ${icon('chevronDown', 13)}
          </button>
        </div>

        <div class="sw-menu-group">
          ${list.length === 0
            ? `<div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('该分类下暂无收益记录', 'No reward records in this category')}</span></div></div>`
            : list.map(l => `
              <div class="sw-menu-row is-static">
                <div class="sw-menu-left">
                  <span class="sw-menu-title">${escapeHtml(l.type)}</span>
                  <span class="sw-menu-sub">${escapeHtml(l.time || '—')}${l.status ? ` · ${escapeHtml(l.status)}` : ''}</span>
                </div>
                <div class="sw-menu-right">
                  <span class="sw-menu-amount is-green">${escapeHtml(l.amount || '0 A9')}</span>
                </div>
              </div>
            `).join('')}
        </div>
      </div>
    `;
    root.querySelectorAll('[data-lmode]').forEach(b => { b.onclick = () => { A9Haptic.light(); A9Audio.tick(); viewMode = b.dataset.lmode; paint(); }; });
    const filterSheetBtn = root.querySelector('#btn-ledger-filter-sheet');
    if (filterSheetBtn) {
      filterSheetBtn.onclick = () => openChoiceSheet({
        title: L('筛选收支记录', 'Filter Ledger Records'),
        selected: activeFilter,
        options: categories.map(([v, label]) => ({ value: v, icon: 'filter', tone: v === activeFilter ? 'is-green' : 'is-blue', label })),
        onSelect: (val) => { activeFilter = val; paint(); },
      });
    }
  };
  paint();
}

export function renderRecordsPage(root, navigate, _param = null, query = {}) {
  const rawType = String(query?.type || 'round').toLowerCase();
  const activeType = (rawType === 'ledger' || rawType === 'market') ? rawType : 'round';

  const renderTabsHeader = () => `
    <div class="seg-tabs" id="records-type-tabs" style="margin-bottom:10px;">
      <button class="seg-tab ${activeType === 'round' ? 'active' : ''}" data-rec-type="round" type="button">${L('闯关记录', 'Quest')}</button>
      <button class="seg-tab ${activeType === 'ledger' ? 'active' : ''}" data-rec-type="ledger" type="button">${L('收支账本', 'Ledger')}</button>
      <button class="seg-tab ${activeType === 'market' ? 'active' : ''}" data-rec-type="market" type="button">${L('宝箱小票', 'Receipts')}</button>
    </div>
  `;

  const bindTabs = (container) => {
    container.querySelectorAll('[data-rec-type]').forEach((btn) => {
      btn.onclick = () => {
        const nextType = btn.dataset.recType || 'round';
        if (nextType === activeType) return;
        A9Haptic.light();
        const target = nextType === 'round' ? '/records' : `/records?type=${nextType}`;
        if (typeof navigate === 'function') navigate(target, { replace: true });
        else renderRecordsPage(root, navigate, _param, { type: nextType });
      };
    });
  };

  if (activeType === 'ledger') {
    root.innerHTML = `<div class="col-gap anim-page-enter">${renderTabsHeader()}<div id="records-sub-host"></div></div>`;
    bindTabs(root);
    const subHost = root.querySelector('#records-sub-host');
    if (subHost) renderLedgerPage(subHost);
    return;
  }

  if (activeType === 'market') {
    root.innerHTML = `<div class="col-gap anim-page-enter">${renderTabsHeader()}<div id="records-sub-host"><div class="card num-xs text-muted">${L('加载中…', 'Loading…')}</div></div></div>`;
    bindTabs(root);
    const subHost = root.querySelector('#records-sub-host');
    import('./warmup_market.js')
      .then((m) => {
        if (subHost && subHost.isConnected && typeof m.renderInternalRecords === 'function') {
          m.renderInternalRecords(subHost, navigate);
        }
      })
      .catch(() => {
        if (subHost && subHost.isConnected) {
          subHost.innerHTML = `<div class="card num-xs text-red">${L('宝箱记录加载失败，请重试', 'Failed to load receipts, please retry')}</div>`;
        }
      });
    return;
  }

  if (!config.isDemo) {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        ${renderTabsHeader()}
        <section class="card card-hero empty-state">
          <span class="nt-art-badge tone-red" aria-hidden="true">${renderNintendoGateIcon('ticket', 32)}</span>
          <div style="font-size:16px;font-weight:900;margin-top:4px;">${L('闯关记录', 'Quest Records')}</div>
          <p class="num-xs text-sec" style="margin:0;max-width:260px;">${L('可在闯关凭证查看各轮状态，或切换上方标签查看收支账本与宝箱小票。', 'Inspect round passes below, or switch tabs for Ledger and Chest Receipts.')}</p>
        </section>
        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/proof">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('查看闯关凭证', 'View Quest Passes')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="#/profile">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('返回我的', 'Back to Me')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
        </div>
      </div>
    `;
    bindTabs(root);
    return;
  }

  let activeFilter = 'all';
  const history = store.state.certificates;
  const totalStaked = history.reduce((s, c) => s + (c.stakeTon || 0), 0);

  const paint = () => {
    const list = activeFilter === 'all' ? history : history.filter(h => h.status === activeFilter);
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        ${renderTabsHeader()}
        <section class="card card-hero">
          <div class="num-xs text-muted">${L('累计锁仓本金', 'Total Locked')} · ${history.length} ${L('轮', 'Rounds')}</div>
          <div class="sw-asset-main" style="margin-top:4px;">${formatNum(totalStaked)} <span class="sw-asset-main-unit">A9</span></div>
        </section>

        <div class="filter-row">
          <button class="filter-pill ${activeFilter === 'all' ? 'active' : ''}" data-rf="all" type="button">${L('全部', 'All')}</button>
          <button class="filter-pill ${activeFilter === 'observation' ? 'active' : ''}" data-rf="observation" type="button">${L('进行中', 'Live')}</button>
          <button class="filter-pill ${activeFilter === 'settled' ? 'active' : ''}" data-rf="settled" type="button">${L('已结算', 'Settled')}</button>
        </div>

        <div class="sw-menu-group">
          ${list.length === 0
            ? `<div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('暂无记录', 'No records')}</span></div></div>`
            : list.map((h) => `
              <a class="sw-menu-row" href="${h.id ? `#/proof/${encodeURIComponent(h.id)}` : '#/proof'}">
                <div class="sw-menu-left">
                  <span class="sw-menu-title">${L(`第 ${h.round} 轮`, `Round #${h.round}`)} · ${formatNum(h.stakeTon)} A9</span>
                  <span class="sw-menu-sub">#${escapeHtml(h.id)} · ${h.status === 'settled' ? L('已结算', 'Settled') : L('12H 冲价中', '12H Push')}</span>
                </div>
                <div class="sw-menu-right">
                  <span class="sw-menu-amount ${h.status === 'settled' ? 'is-green' : 'is-amber'}">${h.status === 'settled' ? `+${formatNum(h.estRewardA9)} A9` : L('待结算', 'Unsettled')}</span>
                  <span class="sw-menu-arrow" aria-hidden="true">›</span>
                </div>
              </a>
            `).join('')}
        </div>
      </div>
    `;
    bindTabs(root);
    root.querySelectorAll('[data-rf]').forEach(b => { b.onclick = () => { A9Haptic.light(); activeFilter = b.dataset.rf; paint(); }; });
  };
  paint();
}
