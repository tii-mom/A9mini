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
import { fetchUserPortfolio, fetchPromoBalance, fetchPredictionUser, fetchPresaleOrders, fetchMyStakeReferrals, getEffectiveUserId, rawToA9 } from '../data.js';
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

function activePassStageLabel(item, isLive) {
  if (isLive) {
    const st = String(item?.roundState || '').toUpperCase();
    if (st === 'STAKING_OPEN') return L('24H 锁仓中', '24H lock open');
    if (st === 'OBSERVING') return L('12H 冲价中', '12H push live');
    if (st.startsWith('SETTLING_') || st === 'STAKING_CLOSED') return L('等待结算', 'Awaiting settlement');
    return store.state.round?.stage === 'participation'
      ? L('24H 锁仓中', '24H lock open')
      : L('12H 冲价中', '12H push live');
  }
  return item?.status === 'participation'
    ? L('24H 锁仓中', '24H lock open')
    : L('12H 冲价中', '12H push live');
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
          <a class="sw-menu-row sw-amount-row" href="#/claim">
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
      ? (item.ticketAddress ? `#/claim?ticket=${encodeURIComponent(item.ticketAddress)}` : '#/claim')
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

export function renderClaimPage(root, _navigate, _param, query = {}) {
  const { user } = store.state;
  const claimable = config.isDemo ? user.a9Claimable : null;

  if (!config.isDemo && store.fundsEnabled) {
    renderLiveTicketClaimPage(root, query.ticket);
    return;
  }

  if (!config.isDemo || !store.fundsEnabled) {
    const addr = user.address;
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero col-gap">
          <div>
            <div class="num-xs text-muted">${L('当前可领总额', 'Total Claimable Now')}</div>
            <div id="readonly-claim-amount" class="sw-asset-main" style="margin-top:4px;">${claimable === null ? (addr ? '…' : '—') : formatA9Amount(claimable)}</div>
          </div>
          <div class="sw-menu-group">
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('普通领奖预附', 'Standard Claim Attachment')}</span>
                <span class="sw-menu-sub">${L('扣除链上费用和必要留存后退回可退余量', 'Refundable excess returns after fees and reserves')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-amount">0.22 GRAM</span></div>
            </div>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('3 折急提 / 提前解押预附', 'Instant Cashout / Early Exit')}</span>
                <span class="sw-menu-sub">${L('覆盖发币与销毁所需链上费用', 'Covers payout and burn network costs')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-amount">0.34 GRAM</span></div>
            </div>
          </div>
        </section>

        <section class="card" id="live-readonly-claim-notice" style="border-color:var(--gold-border);">
          <div class="row-start" style="font-weight:700;margin-bottom:4px;">${icon('shieldAlert', 15, 'text-gold')} ${L('真实只读模式 · 暂未开放领取签名', 'Live Read-Only · Claiming Disabled')}</div>
          <div class="num-xs text-sec" style="line-height:1.5;">${L('当前可查看各轮 StakeTicket 可领与待解锁明细；开启实盘后将直接在此发起链上签名领取。', 'Inspect per-round StakeTicket claimable and locked balances here; on-chain signing activates when live mode opens.')}</div>
        </section>

        <div id="readonly-ticket-section" ${addr ? '' : 'hidden'}>
          <div class="sw-section-label">${query.ticket ? L('已定位凭证', 'Selected Pass') : L('链上凭证列表', 'On-Chain Passes')}</div>
          <div class="sw-menu-group" id="readonly-ticket-list"></div>
        </div>

        ${!addr ? `
          <div class="sw-menu-group">
            <button type="button" class="sw-menu-row" id="btn-ro-claim-connect">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('连接钱包读取链上凭证', 'Connect Wallet to Load Passes')}</span>
                <span class="sw-menu-sub">${L('非托管只读查询，不请求交易签名', 'Read-only check, no signature requested')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </button>
          </div>
        ` : ''}

        <button class="btn btn-secondary" id="btn-claim-readonly" type="button">${icon('lock', 15)} ${L('当前只读 · 暂未开放领取签名', 'Read-Only · Claim Signing Disabled')}</button>
        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/rewards">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('查看 14 天逐秒解锁详情', 'View 14D Unlock Details')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="#/risk/audit">
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('v17.0 链上验真', 'v17.0 On-Chain Audit')}</span>
              <span class="sw-menu-sub">${L('查看合约地址与 7 天 AbortRound 逃生舱', 'Inspect contracts & 7d AbortRound escape hatch')}</span>
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

    const connBtn = root.querySelector('#btn-ro-claim-connect');
    if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderClaimPage(root, _navigate, _param, query));

    const list = root.querySelector('#readonly-ticket-list');
    const sec = root.querySelector('#readonly-ticket-section');
    if (addr && list) {
      const loadTickets = async () => {
        list.innerHTML = `<div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('正在读取链上凭证…', 'Loading on-chain passes…')}</span></div></div>`;
        try {
          const data = await fetchUserPortfolio(addr);
          if (!list.isConnected || addr !== store.state.user.address) return;
          const totalVal = data?.claimableRaw !== null && data?.claimableRaw !== undefined ? rawToA9(data.claimableRaw) : null;
          const amtEl = root.querySelector('#readonly-claim-amount');
          if (amtEl) amtEl.textContent = formatA9Amount(totalVal);
          const allTickets = Array.isArray(data?.tickets) ? data.tickets : [];
          const tickets = query.ticket ? allTickets.filter((t) => t.ticketAddress === query.ticket) : allTickets;
          if (sec) sec.hidden = false;
          if (!tickets.length) {
            list.innerHTML = `<div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${data?.ticketsAvailable ? L('暂无对应凭证', 'No matching passes') : L('凭证数据待核验', 'Pass data unavailable')}</span></div></div>`;
            return;
          }
          list.innerHTML = tickets.map((t) => {
            const prinVal = t.claimablePrincipalRaw !== null && t.claimablePrincipalRaw !== undefined ? rawToA9(t.claimablePrincipalRaw) : null;
            const rewVal = t.claimableRewardRaw !== null && t.claimableRewardRaw !== undefined ? rawToA9(t.claimableRewardRaw) : null;
            const lockVal = t.lockedRemainingRaw !== null && t.lockedRemainingRaw !== undefined ? rawToA9(t.lockedRemainingRaw) : null;
            const totVal = t.claimableTotalRaw !== null && t.claimableTotalRaw !== undefined ? rawToA9(t.claimableTotalRaw) : null;
            const isTarget = Boolean(query.ticket && t.ticketAddress === query.ticket);
            return `
              <div class="sw-menu-row is-static" ${isTarget ? 'style="background:var(--nt-gold-soft);"' : ''}>
                <div class="sw-menu-left">
                  <span class="sw-menu-title">${L(`第 ${escapeHtml(String(t.roundId ?? '—'))} 轮 StakeTicket`, `Round #${escapeHtml(String(t.roundId ?? '—'))} Pass`)}</span>
                  <span class="sw-menu-sub">${L('可领本金', 'Principal')} ${formatA9Amount(prinVal)} · ${L('可领奖金', 'Reward')} ${formatA9Amount(rewVal)}</span>
                  <span class="sw-menu-sub">${L('未来待解锁', 'Future unlock')} ${formatA9Amount(lockVal)}</span>
                </div>
                <div class="sw-menu-right">
                  <span class="sw-menu-amount ${Number(totVal) > 0 ? 'is-green' : (totVal == null ? 'is-muted' : '')}">${formatA9Amount(totVal)}</span>
                </div>
              </div>
            `;
          }).join('');
        } catch {
          if (!list.isConnected || addr !== store.state.user.address) return;
          if (sec) sec.hidden = false;
          list.innerHTML = `
            <div class="sw-menu-error" role="alert">
              <span>${L('读取失败', 'Read failed')}</span>
              <button type="button" class="sw-retry-link" id="btn-ro-ticket-retry">${L('重试', 'Retry')}</button>
            </div>
          `;
          const retryBtn = list.querySelector('#btn-ro-ticket-retry');
          if (retryBtn) retryBtn.onclick = loadTickets;
        }
      };
      void loadTickets();
    }
    const roBtn = root.querySelector('#btn-claim-readonly');
    if (roBtn) {
      roBtn.onclick = () => {
        A9Haptic.warning();
        showToast(L('真实模式当前为只读验收阶段，暂未开放凭证领取签名', 'Live mode is read-only; claim signing is disabled'), 'amber');
      };
    }
    return;
  }

  let claimedAmount = 0;
  const paint = () => {
    const availNow = Number(store.state.user.a9Available || 0);
    const lockedNow = Number(store.state.user.a9Locked || 0);
    const curClaimable = Number(store.state.user.a9Claimable || 0);
    const settledCert = (store.state.certificates || []).find((c) => c.status === 'settled');
    if (claimedAmount > 0) {
      const txHash = peekDemoModule()?.demoTxHash('EQC') || 'EQC_DEMO_TX';
      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <div class="card card-hero success-cert-stage anim-cert-drop" style="text-align:center;padding:24px 16px;">
            <span class="success-stamp-seal anim-seal-slam" aria-hidden="true"><b>${L('已入账', 'CLAIMED')}</b><span>A9 VAULT</span></span>
            <div style="display:flex;justify-content:center;margin:0 auto 8px;">${renderChestSvg('gold', { size: 68, state: 'opened' })}</div>
            <div style="font-size:18px;font-weight:900;">${L('轮次奖励已到账', 'Round Rewards Claimed')}</div>
            <div class="num-hero text-green" id="claimed-final-num" style="margin:6px 0;">+${formatNum(claimedAmount)} <span class="num-md text-green">A9</span></div>
            <div class="num-xs text-sec clickable" role="button" tabindex="0" id="copy-claim-tx">${escapeHtml(txHash)} ${icon('copy', 12)}</div>
            <div class="num-xs text-muted" style="margin-top:6px;">${L('演示回执 · 非链上交易', 'Demo receipt · not an on-chain tx')}</div>
          </div>

          <div class="sw-menu-group">
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('当前可用 A9', 'Available A9')}</span></div>
              <div class="sw-menu-right"><span class="sw-menu-amount is-green" id="claimed-avail-num">${formatNum(availNow)} A9</span></div>
            </div>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('14 天待解锁余额', '14D Locked Remaining')}</span></div>
              <div class="sw-menu-right"><span class="sw-menu-amount">${formatNum(lockedNow)} A9</span></div>
            </div>
          </div>

          <button class="btn btn-primary" data-nav="/ledger">${icon('receipt', 15)} ${L('查看收支账本', 'View Ledger')}</button>
          <button class="btn btn-secondary" data-nav="/profile">${icon('arrowLeft', 15)} ${L('返回我的', 'Back to Me')}</button>
        </div>
      `;
      animateSlotCounter(root.querySelector('#claimed-avail-num'), availNow, { duration: 480, suffix: ' A9' });
      root.querySelector('#copy-claim-tx').onclick = () => copyText(txHash, L('已复制哈希', 'Copied Hash'));
      return;
    }

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero col-gap">
          <div class="row-between">
            <span class="num-xs text-muted">${L('当前可领总额', 'Total Claimable Now')}</span>
            <span class="num-xs text-sec mono" id="claim-avail-pill">${L('可用', 'Avail')}: ${formatNum(availNow)} A9</span>
          </div>
          <div class="sw-asset-main" id="claim-counter">${formatNum(curClaimable)} <span class="sw-asset-main-unit">A9</span></div>
          <div class="sw-menu-group">
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${settledCert ? L(`第 ${settledCert.round} 轮已结算凭证`, `Round #${settledCert.round} Settled Pass`) : L('本批可领（含 20% 即时奖金）', 'Claimable Batch (20% Instant)')}</span>
                <span class="sw-menu-sub">${L('14 天待解锁余量', '14D unlock remaining')}: ${formatNum(lockedNow)} A9</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-amount ${curClaimable > 0 ? 'is-green' : ''}">${formatNum(curClaimable)} A9</span></div>
            </div>
            <div class="sw-menu-row is-static">
              <div class="sw-menu-left">
                <span class="sw-menu-title">${L('实盘链上 Gas 说明', 'On-Chain Gas Spec')}</span>
                <span class="sw-menu-sub">${L('普通领奖预附 0.22 GRAM · 3 折急提或提前解押预附 0.34 GRAM', 'Standard 0.22 GRAM · Instant Cashout / Early Exit 0.34 GRAM')}</span>
              </div>
              <div class="sw-menu-right"><span class="sw-menu-amount is-muted">0.22 GRAM</span></div>
            </div>
          </div>
        </section>

        ${curClaimable > 0 ? `
          <section class="claim-chest-stage" id="claim-chest-stage">
            <span class="diorama-kicker">A9 PRIZE CHEST</span>
            <div class="claim-chest-wrap" id="claim-chest-wrap">
              ${renderVaultChestSvg()}
            </div>
            <div class="claim-chest-hint" id="claim-chest-hint">${L('右滑领取当前可领奖励', 'Slide right to claim rewards')}</div>
          </section>
          <div id="claim-slider-mount"></div>
        ` : `
          <div class="card empty-state">
            <div style="display:flex;justify-content:center;">${renderChestSvg('gold', { size: 60 })}</div>
            <div class="num-sm text-sec">${L('当前无可领余额', 'Nothing to claim right now')}</div>
            <button class="btn btn-secondary btn-sm" style="margin-top:6px;" data-nav="/profile">${L('返回我的', 'Back to Me')}</button>
          </div>
        `}

        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/rewards">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('查看 14 天逐秒解锁详情', 'View 14D Unlock Details')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="#/risk/audit">
            <div class="sw-menu-left">
              <span class="sw-menu-title">${L('v17.0 链上验真', 'v17.0 On-Chain Audit')}</span>
              <span class="sw-menu-sub">${L('查看合约地址与 7 天 AbortRound 逃生舱', 'Inspect contracts & 7d AbortRound escape hatch')}</span>
            </div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
        </div>
      </div>
    `;
    if (curClaimable > 0) {
      const stageEl = root.querySelector('#claim-chest-stage');
      const wrapEl = root.querySelector('#claim-chest-wrap');
      const hintEl = root.querySelector('#claim-chest-hint');
      const availPill = root.querySelector('#claim-avail-pill');

      mountSlider(root.querySelector('#claim-slider-mount'), {
        label: L(`右滑领取 · ${formatNum(curClaimable)} A9`, `Slide to Claim · ${formatNum(curClaimable)} A9`),
        silentConfirmAudio: true,
        onProgress: (p) => {
          if (stageEl) stageEl.style.setProperty('--chest-open', p.toFixed(3));
          if (hintEl) {
            if (p >= 0.8) hintEl.textContent = L('松手立即入账到可用余额', 'Release to credit available balance');
            else if (p > 0.12) hintEl.textContent = L(`箱盖掀开中 ${Math.round(p * 100)}%…`, `Opening ${Math.round(p * 100)}%…`);
            else hintEl.textContent = L('右滑领取当前可领奖励', 'Slide right to claim rewards');
          }
        },
        onConfirm: async () => {
          A9Audio.chestOpen();
          if (stageEl) stageEl.classList.add('is-opened');
          if (wrapEl) {
            wrapEl.classList.add('anim-chest-celebrate');
            burstParticles(wrapEl);
            launchCoinArc(wrapEl, availPill, 6);
          }
          claimedAmount = store.claimRewards();
          const nextAvail = Number(store.state.user.a9Available || 0);
          setTimeout(() => {
            if (availPill && availPill.isConnected) {
              availPill.textContent = `${L('可用', 'Avail')}: ${formatNum(nextAvail)} A9`;
              availPill.classList.add('anim-counter-boing');
            }
          }, 380);
          showToast(L(`已入账 ${formatNum(claimedAmount)} A9`, `Claimed +${formatNum(claimedAmount)} A9`));
          setTimeout(() => {
            if (root.isConnected) paint();
          }, 760);
        }
      });
    }
  };
  paint();
}

/**
 * Live 实盘 StakeTicket 链上领奖页（仅在 config.liveFundsEnabled === true 时激活）。
 */
function renderLiveTicketClaimPage(root, selectedTicket) {
  let portfolio = null;
  let loadError = null;
  let claimingAddr = null;

  const paint = () => {
    const { user } = store.state;
    const tickets = Array.isArray(portfolio?.tickets) ? [...portfolio.tickets] : [];
    if (selectedTicket) tickets.sort((a, b) => Number(b.ticketAddress === selectedTicket) - Number(a.ticketAddress === selectedTicket));
    const range = portfolio?.ticketRange || null;

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero">
          <div class="row-between" style="margin-bottom:6px;">
            <span class="card-title">${icon('shieldCheck', 15, 'text-green')} ${L('链上 StakeTicket 领奖中心', 'On-Chain StakeTicket Claims')}</span>
            <span class="chip chip-green">${L('实盘已开放', 'LIVE OPEN')}</span>
          </div>
          <div class="num-xs text-sec" style="line-height:1.5;">
            ${range && range.fromRound && range.toRound
              ? L(`当前已扫描第 ${range.fromRound} 至第 ${range.toRound} 轮链上锁仓凭证；普通领奖预附 0.22 GRAM，钱包发起费另计。`, `Scanned rounds ${range.fromRound}–${range.toRound}. Each claim attaches 0.22 GRAM. Wallet sending fees apply separately.`)
              : L('普通领奖预附 0.22 GRAM，钱包发起费另计。', 'Each StakeTicket claim attaches 0.22 GRAM. Wallet sending fees apply separately.')}
          </div>
          ${loadError ? `<div class="num-xs text-red" style="margin-top:8px;">${escapeHtml(loadError)}</div>` : ''}
        </div>

        ${!user.connected
          ? `<div class="card empty-state"><div class="num-sm text-sec">${L('请先连接非托管 TON 钱包读取链上锁仓凭证', 'Connect TON wallet to load on-chain StakeTickets')}</div><button class="btn btn-primary btn-sm" id="btn-live-claim-connect" style="margin-top:10px;">${L('连接钱包', 'Connect Wallet')}</button></div>`
          : !portfolio
            ? `<div class="card empty-state"><div class="num-sm text-muted">${L('正在读取链上 StakeTicket…', 'Loading on-chain StakeTickets…')}</div></div>`
            : tickets.length === 0
              ? `<div class="card empty-state"><div class="num-sm text-sec">${L('当前轮次范围内暂无可领 StakeTicket', 'No StakeTickets found in scanned rounds')}</div></div>`
              : `<div class="col-gap">
                  ${tickets.map((t) => {
                    const amtA9 = rawToA9(t.amountRaw) ?? 0;
                    const earlyAmtA9 = rawToA9(t.earlyAmountRaw) ?? 0;
                    const lateAmtA9 = rawToA9(t.lateAmountRaw) ?? 0;
                    const hasSplitPrincipal = earlyAmtA9 > 0 || lateAmtA9 > 0;
                    const lockedClaimedA9 = rawToA9(t.lockedClaimedRaw ?? t.rewardClaimedRaw) ?? 0;
                    const immLabel = t.immediateClaimed ? L('已领', 'Claimed') : L('待领', 'Unclaimed');
                    const isPending = Boolean(t.pending);
                    const hasPreview = typeof t.canClaim === 'boolean';
                    const canClaim = hasPreview ? t.canClaim : !isPending;
                    const canEarlyExit = Boolean(t.canEarlyExit);
                    const canInstantCashout = Boolean(t.canInstantCashout);
                    const claimablePrincipalA9 = rawToA9(t.claimablePrincipalRaw) ?? 0;
                    const burnedPrincipalA9 = rawToA9(t.burnedPrincipalRaw) ?? 0;
                    const claimableRewardA9 = rawToA9(t.claimableRewardRaw) ?? 0;
                    const claimableTotalA9 = rawToA9(t.claimableTotalRaw) ?? 0;
                    const lockedRemA9 = rawToA9(t.lockedRemainingRaw) ?? 0;
                    const earlyExitRefA9 = rawToA9(t.earlyExitRefundRaw) ?? 0;
                    const earlyExitBurnA9 = rawToA9(t.earlyExitBurnRaw) ?? 0;
                    const cashoutTotalA9 = rawToA9(t.instantCashoutTotalRaw) ?? 0;
                    const cashoutBurnA9 = rawToA9(t.instantCashoutBurnRaw) ?? 0;
                    const rState = String(t.roundState || '').toUpperCase();
                    const isBusy = claimingAddr === t.ticketAddress;
                    const isGlobalClaimLocked = pendingTxManager.isLocked('claim');
                    const disabled = !canClaim || isPending || isBusy || isGlobalClaimLocked;
                    const earlyExitDisabled = !canEarlyExit || isPending || isBusy || isGlobalClaimLocked;
                    const cashoutDisabled = !canInstantCashout || isPending || isBusy || isGlobalClaimLocked;

                    let statusChip = `<span class="chip chip-cyan">${L('持有中', 'Active')}</span>`;
                    if (isPending) statusChip = `<span class="chip chip-gold">${L('链上处理中', 'Pending')}</span>`;
                    else if (t.exited) statusChip = `<span class="chip chip-muted">${L('已提前解押 (-15%)', 'Early Exited (-15%)')}</span>`;
                    else if (rState === 'FAILED_PERMANENT' || rState === 'FAILED') {
                      statusChip = canClaim
                        ? `<span class="chip chip-green">${L('未达标 · 可领止损退本', 'Failed · Stop-Loss Refund')}</span>`
                        : `<span class="chip chip-muted">${L('已领回止损退本', 'Stop-Loss Refunded')}</span>`;
                    }
                    else if (rState === 'STAKING_OPEN') statusChip = `<span class="chip chip-gold">${L('24H 锁仓中 · 可提前解押', '24H Lock · Early Exit Open')}</span>`;
                    else if (rState === 'OBSERVING') statusChip = `<span class="chip chip-gold">${L('12H 冲价中 · 封盘禁出', '12H Push · Locked')}</span>`;
                    else if (rState === 'ABORTED' || rState === 'TECHNICAL_ABORTED') statusChip = canClaim ? `<span class="chip chip-green">${L('异常中止 · 100% 退本', 'Aborted · 100% Refund')}</span>` : `<span class="chip chip-muted">${L('已全额退本', 'Refunded')}</span>`;
                    else if (canClaim) statusChip = `<span class="chip chip-green">${L('可领本金/奖金', 'Claimable')}</span>`;
                    else if (t.forfeited) statusChip = `<span class="chip chip-muted">${L('已 3 折急提结清', 'Instant Cashed Out')}</span>`;
                    else if (t.principalDone) statusChip = `<span class="chip chip-muted">${lockedRemA9 > 0 ? L('14 天逐秒解锁中', '14D Unlocking') : L('已全额领完', 'Fully Claimed')}</span>`;

                    let btnLabel = L('发起链上领奖（附 0.22 GRAM Gas）', 'Claim On-Chain (0.22 GRAM Gas)');
                    if (isPending) btnLabel = L('凭证正在链上确认中（防重锁）', 'Claim Pending On-Chain');
                    else if (isGlobalClaimLocked) btnLabel = L('交易确认中（防重锁）', 'Confirming…');
                    else if (isBusy) btnLabel = L('等待钱包签名…', 'Awaiting Signature…');
                    else if (!canClaim) {
                      if (rState === 'STAKING_OPEN') btnLabel = L('24H 锁仓期内待冲价结算', 'In 24H Lock Window');
                      else if (rState === 'OBSERVING') btnLabel = L('12H 冲价封盘中（禁进禁出）', '12H Push Locked');
                      else btnLabel = L('当前无可领金额（避免浪费 Gas）', 'Nothing Claimable Right Now');
                    } else if (rState === 'FAILED_PERMANENT' || rState === 'FAILED') {
                      btnLabel = L(`领回止损退本 ${formatNum(claimablePrincipalA9, 2)} A9（永不爆仓）`, `Claim Stop-Loss Refund ${formatNum(claimablePrincipalA9, 2)} A9`);
                    } else if (hasPreview && claimableTotalA9 > 0) {
                      btnLabel = L(`逐秒全领 ${formatNum(claimableTotalA9, 2)} A9（附 0.22 GRAM）`, `Claim ${formatNum(claimableTotalA9, 2)} A9 (0.22 GRAM)`);
                    }

                    return `
                      <div class="card">
                        <div class="row-between" style="margin-bottom:6px;">
                          <strong>${L(`第 ${escapeHtml(String(t.roundId ?? '—'))} 轮 StakeTicket`, `Round #${escapeHtml(String(t.roundId ?? '—'))} StakeTicket`)}</strong>
                          ${statusChip}
                        </div>
                        <div class="row-between num-xs text-sec">
                          <span>${L('凭证本金', 'Principal')}</span>
                          <b class="mono">${formatNum(amtA9, 2)} A9</b>
                        </div>
                        ${hasSplitPrincipal ? `
                        <div class="row-between num-xs text-muted" style="margin-top:3px;">
                          <span>${L('头矿 6H（5% 止损）/ 普通（10% 止损）', 'First 6H (5% SL) / Std (10% SL)')}</span>
                          <span class="mono">${formatNum(earlyAmtA9, 2)} / ${formatNum(lateAmtA9, 2)} A9</span>
                        </div>` : ''}
                        ${hasPreview ? `
                        <div class="row-between num-xs text-sec" style="margin-top:4px;">
                          <span>${(rState === 'FAILED_PERMANENT' || rState === 'FAILED') ? L('可领止损退本 / 已销毁止损', 'Stop-Loss Refund / Burned') : L('当前可领（本金 + 奖金）', 'Claimable Now')}</span>
                          <b class="mono ${claimableTotalA9 > 0 ? 'text-green' : 'text-muted'}">${(rState === 'FAILED_PERMANENT' || rState === 'FAILED') ? `${formatNum(claimablePrincipalA9, 2)} A9 / -${formatNum(burnedPrincipalA9, 2)} A9` : `${formatNum(claimableTotalA9, 2)} A9 (${formatNum(claimablePrincipalA9, 2)} + ${formatNum(claimableRewardA9, 2)})`}</b>
                        </div>
                        ${lockedRemA9 > 0 ? `
                        <div class="row-between num-xs text-sec" style="margin-top:4px;">
                          <span>${(t.unlockedPctBps !== null && t.unlockedPctBps !== undefined && Number.isFinite(Number(t.unlockedPctBps))) ? L(`14 天逐秒待解锁（已解锁 ${(Number(t.unlockedPctBps) / 100).toFixed(2)}%）`, `14D Unlock Remaining (${(Number(t.unlockedPctBps) / 100).toFixed(2)}% unlocked)`) : L('14 天逐秒待解锁奖金', '14D Unlock Remaining')}</span>
                          <b class="mono text-gold">${formatNum(lockedRemA9, 2)} A9</b>
                        </div>` : ''}` : `
                        <div class="row-between num-xs text-sec" style="margin-top:4px;">
                          <span>${L('即时奖金 / 已领解锁', 'Instant / Unlocked Claimed')}</span>
                          <b class="mono text-green">${immLabel} · ${formatNum(lockedClaimedA9, 2)} A9</b>
                        </div>`}
                        <div class="num-xs text-muted mono" style="margin:6px 0 10px;word-break:break-all;">${escapeHtml(t.ticketAddress)}</div>
                        ${canClaim || (!canEarlyExit) ? `
                        <button class="btn ${disabled ? 'btn-secondary' : 'btn-primary'} btn-sm" data-claim-ticket="${escapeHtml(t.ticketAddress)}" type="button" style="width:100%;" ${disabled ? 'disabled' : ''}>
                          ${icon(disabled ? (isPending || isGlobalClaimLocked ? 'clock' : 'lock') : 'wallet', 13)} ${btnLabel}
                        </button>` : ''}
                        ${canInstantCashout ? `
                        <button class="btn btn-secondary btn-sm" data-instant-cashout-ticket="${escapeHtml(t.ticketAddress)}" type="button" style="width:100%;margin-top:6px;border-color:var(--gold-border);color:var(--gold);" ${cashoutDisabled ? 'disabled' : ''}>
                          ${icon('bolt', 13)} ${L(`3 折急提：立刻拿 ${formatNum(cashoutTotalA9, 2)} A9（另烧 ${formatNum(cashoutBurnA9, 2)} A9 · 0.34 GRAM）`, `Instant Cashout: ${formatNum(cashoutTotalA9, 2)} A9 Now (Burn ${formatNum(cashoutBurnA9, 2)} A9)`)}
                        </button>` : ''}
                        ${canEarlyExit ? `
                        <button class="btn btn-secondary btn-sm" data-early-exit-ticket="${escapeHtml(t.ticketAddress)}" type="button" style="width:100%;margin-top:6px;border-color:var(--red-border, #F3B3B8);color:var(--red);" ${earlyExitDisabled ? 'disabled' : ''}>
                          ${icon('flame', 13)} ${L(`提前解押：退 ${formatNum(earlyExitRefA9, 2)} A9 / 扣 15%（${formatNum(earlyExitBurnA9, 2)} A9）销毁`, `Early Exit: Refund ${formatNum(earlyExitRefA9, 2)} A9 (-15% Burn)`)}
                        </button>` : ''}
                      </div>
                    `;
                  }).join('')}
                </div>`}

        <div class="grid-2">
          <button class="btn btn-secondary" id="btn-live-claim-refresh" type="button">${icon('refresh', 14)} ${L('刷新凭证', 'Refresh')}</button>
          <button class="btn btn-secondary" data-nav="/profile" type="button">${icon('arrowLeft', 14)} ${L('返回我的', 'Back to Me')}</button>
        </div>
      </div>
    `;

    const connBtn = root.querySelector('#btn-live-claim-connect');
    if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => loadTickets());
    const refBtn = root.querySelector('#btn-live-claim-refresh');
    if (refBtn) refBtn.onclick = () => loadTickets();

    root.querySelectorAll('[data-claim-ticket]').forEach((btn) => {
      btn.onclick = async () => {
        const ticketAddr = btn.dataset.claimTicket;
        if (!ticketAddr || claimingAddr || pendingTxManager.isLocked('claim')) return;
        A9Haptic.light();
        const ticket = tickets.find((item) => item.ticketAddress === ticketAddr);
        if (typeof ticket?.canClaim === 'boolean' && !ticket.canClaim) {
          showToast(L('当前凭证暂无可领金额，已阻止签名以防白耗 0.22 GRAM Gas', 'Nothing claimable on this ticket; signature blocked to save gas'), 'amber');
          return;
        }
        try {
          tonConnect.assertWalletReadyForLiveTx();
        } catch (guardErr) {
          showToast(guardErr?.message || L('请检查钱包连接与网络状态', 'Check wallet connection and network'), 'error');
          return;
        }
        const ticketPrincipalA9 = rawToA9(ticket?.claimablePrincipalRaw ?? ticket?.amountRaw) ?? 0;
        const ticketRewardA9 = rawToA9(ticket?.claimableRewardRaw) ?? 0;
        const ticketTotalA9 = typeof ticket?.canClaim === 'boolean'
          ? (rawToA9(ticket?.claimableTotalRaw) ?? 0)
          : ticketPrincipalA9;
        const ok = await tonConnect.confirmBeforeSign({
          title: L('确认链上领奖（签名前核验）', 'Confirm On-Chain Claim'),
          contractLabel: L('目标凭证 StakeTicket', 'Target StakeTicket'),
          targetAddress: ticketAddr,
          principalText: `${L(`第 ${ticket?.roundId ?? '—'} 轮`, `Round #${ticket?.roundId ?? '—'}`)} · ${formatNum(ticketTotalA9, 2)} A9${typeof ticket?.canClaim === 'boolean' ? ` (${L('本金', 'Prin')} ${formatNum(ticketPrincipalA9, 2)} + ${L('奖', 'Rew')} ${formatNum(ticketRewardA9, 2)})` : ''}`,
          gasText: `0.22 GRAM (${L('预附 · 钱包发起费另计', 'attached · wallet sending fee separate')})`,
          totalText: '0.22 GRAM (Gas)',
          note: L('发送 TicketClaim 到 StakeTicket 合约，核销后由 RoundController 发放本金与已解锁 A9。', 'Sends TicketClaim to StakeTicket; RoundController disburses principal + unlocked A9.'),
          insufficientReason: ticket?.pending
            ? L('该凭证当前处于链上确认中，请等待完成', 'This StakeTicket already has a pending claim')
            : (typeof ticket?.canClaim === 'boolean' && !ticket.canClaim ? L('当前无可领金额', 'Nothing claimable right now') : ''),
          confirmText: L('确认并签名领奖', 'Confirm & Sign Claim'),
        });
        if (!ok) return;

        const prevSnap = ticket
          ? {
              principalDone: Boolean(ticket.principalDone),
              immediateClaimed: Boolean(ticket.immediateClaimed),
              lockedClaimedRaw: String(ticket.lockedClaimedRaw ?? ticket.rewardClaimedRaw ?? '0'),
            }
          : null;
        const safeRawBigInt = (val) => (typeof val === 'string' && /^\d+$/.test(val.trim()) ? BigInt(val.trim()) : null);
        const prevBalanceRaw = safeRawBigInt(portfolio?.a9BalanceRaw);

        claimingAddr = ticketAddr;
        paint();
        try {
          await tonConnect.sendV15TicketClaim(ticketAddr);
          A9Haptic.success();
          A9Audio.confirm();
          showToast(L('已提交 StakeTicket 领奖交易，正在核验链上到账…', 'StakeTicket claim sent, awaiting on-chain finality…'));
          const pendingTx = pendingTxManager.start({
            kind: 'claim',
            title: `第 ${ticket?.roundId ?? '—'} 轮 StakeTicket 领奖`,
            titleEn: `Round #${ticket?.roundId ?? '—'} StakeTicket Claim`,
            amountText: '0.22 GRAM Gas',
            explorerAddress: ticketAddr,
            targetRoute: '/claim',
            maxAttempts: 12,
          });
          pendingTxManager.pollUntilConfirmed({
            txId: pendingTx?.id,
            intervalMs: 4000,
            maxAttempts: 12,
            checkFn: async () => {
              const addr = store.state.user.address;
              if (!addr) return false;
              const next = await fetchUserPortfolio(addr);
              if (!next) return false;
              const nextTicket = next.tickets?.find((item) => item.ticketAddress === ticketAddr);
              const ticketUpdated = Boolean(
                prevSnap && nextTicket && !nextTicket.pending && (
                  Boolean(nextTicket.principalDone) !== prevSnap.principalDone ||
                  Boolean(nextTicket.immediateClaimed) !== prevSnap.immediateClaimed ||
                  String(nextTicket.lockedClaimedRaw ?? nextTicket.rewardClaimedRaw ?? '0') !== prevSnap.lockedClaimedRaw
                ),
              );
              const nextBalRaw = safeRawBigInt(next.a9BalanceRaw);
              const balIncreased = prevBalanceRaw !== null && nextBalRaw !== null && nextBalRaw > prevBalanceRaw;
              if (ticketUpdated || balIncreased) {
                portfolio = next;
                return {
                  confirmed: true,
                  detail: 'StakeTicket 领奖已到账，余额与凭证状态已更新。',
                  detailEn: 'StakeTicket claim confirmed; wallet balance and ticket updated.',
                };
              }
              return false;
            },
            onConfirmed: () => {
              showToast(L('链上领奖已确认到账！', 'On-chain claim confirmed!'));
              if (root.isConnected) paint();
            },
            onTimeout: () => {
              showToast(L('区块确认耗时较长，可点击顶部状态条前往 Tonviewer 核验', 'Confirmation taking longer; check Tonviewer via top bar'), 'amber');
              if (root.isConnected) paint();
            },
          });
          await loadTickets();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('发起领奖签名失败，请重试', 'Claim signature failed'), 'error');
        } finally {
          claimingAddr = null;
          if (root.isConnected) paint();
        }
      };
    });

    // v17: 3 折急提（已解锁 100% 实发，仅未解锁余额按 30% 秒提 + 70% 直接销毁；预附 0.34 GRAM）
    root.querySelectorAll('[data-instant-cashout-ticket]').forEach((btn) => {
      btn.onclick = async () => {
        const ticketAddr = btn.dataset.instantCashoutTicket;
        if (!ticketAddr || claimingAddr || pendingTxManager.isLocked('claim')) return;
        A9Haptic.warning();
        const ticket = tickets.find((item) => item.ticketAddress === ticketAddr);
        if (!ticket?.canInstantCashout) return;
        try {
          tonConnect.assertWalletReadyForLiveTx();
        } catch (guardErr) {
          showToast(guardErr?.message || L('请检查钱包连接与网络状态', 'Check wallet connection and network'), 'error');
          return;
        }
        const totalCashA9 = rawToA9(ticket.instantCashoutTotalRaw) ?? 0;
        const burnA9 = rawToA9(ticket.instantCashoutBurnRaw) ?? 0;
        const ok = await tonConnect.confirmBeforeSign({
          title: L('确认 3 折急提（未解锁部分 7 折永久销毁）', 'Confirm Instant Cashout (70% Unvested Burned)'),
          contractLabel: L('目标凭证 StakeTicket', 'Target StakeTicket'),
          targetAddress: ticketAddr,
          principalText: `${L(`第 ${ticket.roundId ?? '—'} 轮`, `Round #${ticket.roundId ?? '—'}`)} · ${L('立刻实拿', 'Receive Now')} ${formatNum(totalCashA9, 2)} A9 · ${L('永久销毁', 'Burn')} ${formatNum(burnA9, 2)} A9`,
          gasText: `0.34 GRAM (${L('预附 · 钱包发起费另计', 'attached · wallet sending fee separate')})`,
          totalText: '0.34 GRAM (Gas)',
          note: L('已自然解锁的奖金按 100% 实发，仅尚未解锁的未来余额按 30% 秒提、70% 永久打入黑洞销毁且不可撤回。', 'Already-unlocked rewards pay 100%; only remaining unvested rewards split 30% instant / 70% permanent burn.'),
          confirmText: L('确认并签名 3 折急提', 'Confirm & Sign Instant Cashout'),
        });
        if (!ok) return;
        const safeRawBigInt = (val) => (typeof val === 'string' && /^\d+$/.test(val.trim()) ? BigInt(val.trim()) : null);
        const prevBalanceRaw = safeRawBigInt(portfolio?.a9BalanceRaw);
        claimingAddr = ticketAddr;
        paint();
        try {
          await tonConnect.sendV15TicketClaim(ticketAddr, BigInt(Date.now()), { instantDiscount: true });
          A9Haptic.success();
          A9Audio.confirm();
          showToast(L('已提交 3 折急提交易，正在核验链上到账…', 'Instant Cashout sent, awaiting on-chain finality…'));
          const pendingTx = pendingTxManager.start({
            kind: 'claim',
            title: `第 ${ticket?.roundId ?? '—'} 轮 3 折急提`,
            titleEn: `Round #${ticket?.roundId ?? '—'} Instant Cashout`,
            amountText: '0.34 GRAM Gas',
            explorerAddress: ticketAddr,
            targetRoute: '/claim',
            maxAttempts: 12,
          });
          pendingTxManager.pollUntilConfirmed({
            txId: pendingTx?.id,
            intervalMs: 4000,
            maxAttempts: 12,
            checkFn: async () => {
              const addr = store.state.user.address;
              if (!addr) return false;
              const next = await fetchUserPortfolio(addr);
              if (!next) return false;
              const nextTicket = next.tickets?.find((item) => item.ticketAddress === ticketAddr);
              const nextBalRaw = safeRawBigInt(next.a9BalanceRaw);
              const balIncreased = prevBalanceRaw !== null && nextBalRaw !== null && nextBalRaw > prevBalanceRaw;
              // 仅当字段为明确字符串 '0'（非 null/undefined 缺值）或 forfeited=true 时判结清，避免索引器缺值误报确认
              const ticketSettled = Boolean(
                nextTicket && !nextTicket.pending && (
                  Boolean(nextTicket.forfeited) ||
                  (typeof nextTicket.lockedRemainingRaw === 'string' && nextTicket.lockedRemainingRaw.trim() === '0')
                ),
              );
              if (ticketSettled || balIncreased) {
                portfolio = next;
                return {
                  confirmed: true,
                  detail: '3 折急提已上链确认，余额与凭证状态已更新。',
                  detailEn: 'Instant Cashout confirmed on-chain; balance and ticket updated.',
                };
              }
              return false;
            },
            onConfirmed: () => {
              showToast(L('3 折急提已确认到账！', 'Instant Cashout confirmed on-chain!'));
              if (root.isConnected) paint();
            },
            onTimeout: () => {
              showToast(L('区块确认耗时较长，可点击顶部状态条前往 Tonviewer 核验', 'Confirmation taking longer; check Tonviewer via top bar'), 'amber');
              if (root.isConnected) paint();
            },
          });
          await loadTickets();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('发起 3 折急提签名失败，请重试', 'Instant Cashout signature failed'), 'error');
        } finally {
          claimingAddr = null;
          if (root.isConnected) paint();
        }
      };
    });

    // v17: 24H 锁仓期提前解押（退 85% 本金 / 扣 15% 永久销毁；进入 12H 冲价期封盘禁止）
    root.querySelectorAll('[data-early-exit-ticket]').forEach((btn) => {
      btn.onclick = async () => {
        const ticketAddr = btn.dataset.earlyExitTicket;
        if (!ticketAddr || claimingAddr || pendingTxManager.isLocked('claim')) return;
        A9Haptic.warning();
        const ticket = tickets.find((item) => item.ticketAddress === ticketAddr);
        if (!ticket?.canEarlyExit) return;
        try {
          tonConnect.assertWalletReadyForLiveTx();
        } catch (guardErr) {
          showToast(guardErr?.message || L('请检查钱包连接与网络状态', 'Check wallet connection and network'), 'error');
          return;
        }
        const refA9 = rawToA9(ticket.earlyExitRefundRaw) ?? 0;
        const burnA9 = rawToA9(ticket.earlyExitBurnRaw) ?? 0;
        const ok = await tonConnect.confirmBeforeSign({
          title: L('确认提前解押（退 85% 本金 / 扣 15% 销毁）', 'Confirm Early Exit (85% Refund / -15% Burn)'),
          contractLabel: L('目标凭证 StakeTicket', 'Target StakeTicket'),
          targetAddress: ticketAddr,
          principalText: `${L(`第 ${ticket.roundId ?? '—'} 轮`, `Round #${ticket.roundId ?? '—'}`)} · ${L('退回本金', 'Refund')} ${formatNum(refA9, 2)} A9 · ${L('扣除销毁', 'Burn')} ${formatNum(burnA9, 2)} A9`,
          gasText: `0.34 GRAM (${L('预附 · 钱包发起费另计', 'attached · wallet sending fee separate')})`,
          totalText: '0.34 GRAM (Gas)',
          note: L('仅限 24H 锁仓期内可执行提前解押，扣除 15% 本金永久销毁，进入 12H 冲价期后将自动锁定禁止撤本。', 'Early Exit is only available during the 24H lock window (15% burned); locked once 12H push begins.'),
          confirmText: L('确认并签名提前解押', 'Confirm & Sign Early Exit'),
        });
        if (!ok) return;
        const safeRawBigInt = (val) => (typeof val === 'string' && /^\d+$/.test(val.trim()) ? BigInt(val.trim()) : null);
        const prevBalanceRaw = safeRawBigInt(portfolio?.a9BalanceRaw);
        claimingAddr = ticketAddr;
        paint();
        try {
          await tonConnect.sendV17TicketEarlyExit(ticketAddr);
          A9Haptic.success();
          A9Audio.confirm();
          showToast(L('已提交提前解押交易，正在核验链上到账…', 'Early Exit sent, awaiting on-chain finality…'));
          const pendingTx = pendingTxManager.start({
            kind: 'claim',
            title: `第 ${ticket?.roundId ?? '—'} 轮提前解押`,
            titleEn: `Round #${ticket?.roundId ?? '—'} Early Exit`,
            amountText: '0.34 GRAM Gas',
            explorerAddress: ticketAddr,
            targetRoute: '/claim',
            maxAttempts: 12,
          });
          pendingTxManager.pollUntilConfirmed({
            txId: pendingTx?.id,
            intervalMs: 4000,
            maxAttempts: 12,
            checkFn: async () => {
              const addr = store.state.user.address;
              if (!addr) return false;
              const next = await fetchUserPortfolio(addr);
              if (!next) return false;
              const nextTicket = next.tickets?.find((item) => item.ticketAddress === ticketAddr);
              const nextBalRaw = safeRawBigInt(next.a9BalanceRaw);
              const balIncreased = prevBalanceRaw !== null && nextBalRaw !== null && nextBalRaw > prevBalanceRaw;
              const ticketExited = Boolean(
                nextTicket && !nextTicket.pending && (
                  Boolean(nextTicket.exited) ||
                  (typeof nextTicket.amountRaw === 'string' && nextTicket.amountRaw.trim() === '0')
                ),
              );
              if (ticketExited || balIncreased) {
                portfolio = next;
                return {
                  confirmed: true,
                  detail: '提前解押已上链确认，85% 本金已退回钱包。',
                  detailEn: 'Early Exit confirmed on-chain; 85% principal refunded.',
                };
              }
              return false;
            },
            onConfirmed: () => {
              showToast(L('提前解押已确认到账！', 'Early Exit confirmed on-chain!'));
              if (root.isConnected) paint();
            },
            onTimeout: () => {
              showToast(L('区块确认耗时较长，可点击顶部状态条前往 Tonviewer 核验', 'Confirmation taking longer; check Tonviewer via top bar'), 'amber');
              if (root.isConnected) paint();
            },
          });
          await loadTickets();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('发起提前解押签名失败，请重试', 'Early Exit signature failed'), 'error');
        } finally {
          claimingAddr = null;
          if (root.isConnected) paint();
        }
      };
    });
  };

  const loadTickets = async () => {
    const addr = store.state.user.address;
    if (!addr) { paint(); return; }
    try {
      portfolio = await fetchUserPortfolio(addr);
      loadError = null;
    } catch (e) {
      loadError = e?.message || L('读取链上凭证失败，请重试', 'Failed to read StakeTickets');
    }
    if (root.isConnected) paint();
  };

  paint();
  loadTickets();
}

let proofRenderSeq = 0;

function liveTicketStatusText(t) {
  const rState = String(t?.roundState || '').toUpperCase();
  if (t?.pending) return L('链上确认中', 'Pending');
  if (t?.exited) return L('已提前解押', 'Early Exited');
  if (t?.forfeited) return L('已 3 折急提', 'Instant Cashed Out');
  if (rState === 'STAKING_OPEN') return L('24H 锁仓中', '24H Lock Open');
  if (rState === 'OBSERVING') return L('12H 冲价中', '12H Push');
  if (rState === 'FAILED_PERMANENT' || rState === 'FAILED') return t?.principalDone ? L('已领止损退本', 'Refunded') : L('可领止损退本', 'Stop-Loss Refund');
  if (t?.canClaim) return L('可领取', 'Claimable');
  if (t?.principalDone) return Number(rawToA9(t?.lockedRemainingRaw) || 0) > 0 ? L('14 天解锁中', '14D Unlocking') : L('已全额领完', 'Fully Claimed');
  return L('持有中', 'Active');
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
                  const href = t.ticketAddress ? `#/claim?ticket=${encodeURIComponent(t.ticketAddress)}` : '#/claim';
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
            <a class="sw-menu-row" href="#/claim">
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
                    <span class="mono">${escapeHtml(cert.txHash || 'PENDING')}</span>
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
        <a class="sw-menu-row" href="#/claim">
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

export function renderRecordsPage(root) {
  if (!config.isDemo) {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero empty-state">
          <span class="nt-art-badge tone-red" aria-hidden="true">${renderNintendoGateIcon('ticket', 32)}</span>
          <div style="font-size:16px;font-weight:900;margin-top:4px;">${L('链上闯关记录', 'On-Chain Quest Records')}</div>
          <p class="num-xs text-sec" style="margin:0;max-width:260px;">${L('请在闯关凭证页查看各轮 StakeTicket 链上状态，或在收支账本查看商城订单与返佣记录。', 'Inspect per-round StakeTickets in Passes or view orders and referrals in Ledger.')}</p>
        </section>
        <div class="sw-menu-group">
          <a class="sw-menu-row" href="#/proof">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('查看链上闯关凭证', 'View On-Chain Passes')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="#/ledger">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('查看收支账本', 'View Ledger')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
          <a class="sw-menu-row" href="#/profile">
            <div class="sw-menu-left"><span class="sw-menu-title">${L('返回我的', 'Back to Me')}</span></div>
            <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
          </a>
        </div>
      </div>
    `;
    return;
  }

  let activeFilter = 'all';
  const history = store.state.certificates;
  const totalStaked = history.reduce((s, c) => s + (c.stakeTon || 0), 0);

  const paint = () => {
    const list = activeFilter === 'all' ? history : history.filter(h => h.status === activeFilter);
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
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
    root.querySelectorAll('[data-rf]').forEach(b => { b.onclick = () => { A9Haptic.light(); activeFilter = b.dataset.rf; paint(); }; });
  };
  paint();
}
