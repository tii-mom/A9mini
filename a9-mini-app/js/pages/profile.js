import { portfolioPanel, identityStage, bindIdentityStage } from './wealthverse.js';
/**
 * 我的 / 资产 / 结算 / 凭证 / 账本 / 连闯页
 * 顺序：身份铭牌 → 可领取与资产遥测 → 四宫格功能台 → 凭证收藏册。
 * 严格遵循 Demo / Live 模式隔离，不混用演示数据与真实只读数据。
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { uiMemory } from '../app.js';
import { demoTxHash } from '../demo-data.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast, copyText, mountSlider, renderCorridorRadar, bindCorridorRadarEvents, animateSlotCounter, launchCoinArc, burstParticles, openChoiceSheet, openModal, closeModal } from '../components.js';
import { renderVaultChestSvg, renderNintendoGateIcon } from '../paper-art.js';
import { renderChestSvg } from '../chest-art.js';
import { renderProofFlexPoster, renderStoryPoster, downloadPosterPng } from '../poster.js';
import { openXShareSheet, triggerStoryShare } from '../share.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { tonConnect } from '../tonconnect.js';
import { fetchUserPortfolio, fetchPromoBalance, fetchPredictionUser, fetchNotificationPrefs, updateNotificationPrefs, fetchMyStakeReferrals, getEffectiveUserId, rawToA9 } from '../data.js';
import { pendingTxManager } from '../tx-ux.js';

function renderMiniBarcode() {
  const bars = [2, 1, 3, 1, 2, 2, 1, 3, 1, 2];
  return `<span class="receipt-barcode" aria-hidden="true">${bars.map((w) => `<i style="width:${w}px;"></i>`).join('')}</span>`;
}

function parseA9Number(str) {
  const m = String(str || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

let profileRenderSeq = 0;

/** 统一「金库 / 领奖中心」聚合卡片（消灭双卡重影，兼容 Demo active/empty 与 Live 统一并发读取） */
function renderUnifiedVaultHtml({
  availA9 = null,
  roundClaimableA9 = null,
  roundLockedA9 = null,
  promoClaimableA9 = null,
  predActivatedA9 = null,
  predPendingA9 = null,
  activeTicketsCount = null,
  stakedPrincipalA9 = null,
  certsCount = null,
  isLive = false,
  hasWallet = false,
  loading = false,
  fundsEnabled = false,
  showQuickSlider = false,
  loadError = false,
} = {}) {
  const fmtA9 = (val, fallback = L('待核验', 'Pending')) =>
    (val === null || val === undefined || !Number.isFinite(Number(val)))
      ? fallback
      : `${formatNum(Number(val), Number(val) % 1 === 0 ? 0 : 2)} A9`;

  const claimParts = [roundClaimableA9, promoClaimableA9].filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)));
  const hasAnySum = claimParts.length > 0;
  const totalReadyA9 = hasAnySum ? claimParts.reduce((s, n) => s + Number(n), 0) : null;
  const hasPendingVault = predPendingA9 !== null && predPendingA9 !== undefined && Number(predPendingA9) > 0;

  const roundValDisplay = roundClaimableA9 !== null && roundClaimableA9 !== undefined
    ? fmtA9(roundClaimableA9)
    : (activeTicketsCount !== null && activeTicketsCount > 0
      ? L(`${activeTicketsCount} 张凭证可查`, `${activeTicketsCount} ticket(s)`)
      : fmtA9(null));

  const lockedValDisplay = roundLockedA9 !== null && roundLockedA9 !== undefined
    ? fmtA9(roundLockedA9)
    : (stakedPrincipalA9 !== null && stakedPrincipalA9 > 0
      ? `${L('锁仓中', 'Locked')} ${fmtA9(stakedPrincipalA9)}`
      : fmtA9(null));

  return `
    <section class="card card-hero unified-vault-card" id="profile-unified-vault">
      <div class="row-between" style="margin-bottom:8px;">
        <div class="card-title">${icon('wallet', 15, 'text-gold')} ${L('统一金库 / 领奖中心', 'Unified Vault & Claim Center')}</div>
        <span class="chip ${isLive ? (fundsEnabled ? 'chip-green' : 'chip-muted') : 'chip-gold'}">${isLive ? (fundsEnabled ? L('链上可领', 'LIVE') : L('只读模式', 'READ-ONLY')) : 'DEMO'}</span>
      </div>

      <div class="unified-vault-total">
        <span class="num-xs text-muted">${L('可领总额（轮次 + 推广）', 'Total Claimable (Round + Promo)')}</span>
        <div class="num-lg text-green mono" style="font-weight:900;margin-top:3px;">${loading && !hasAnySum ? L('同步中…', 'Syncing…') : (showQuickSlider && roundClaimableA9 > 0 ? `<span id="a9-claim-num">${formatNum(totalReadyA9 ?? 0)}</span> A9` : fmtA9(totalReadyA9))}</div>
      </div>

      <a class="btn btn-primary btn-sm" href="#/claim" style="width:100%;min-height:42px;margin:8px 0 6px;">${icon('bolt', 14)} ${L('前往领奖 / 3 折急提 / 提前解押', 'Claim / Instant Cashout / Early Exit')} ›</a>

      ${showQuickSlider && fundsEnabled && roundClaimableA9 > 0 ? `<div id="profile-quick-slider" style="margin:8px 0;"></div>` : ''}

      <div class="profile-asset-telemetry" style="margin:8px 0 10px;">
        <div class="profile-telemetry-cell">
          <small>${L('可用 A9', 'Available')}</small>
          <strong class="mono">${availA9 !== null && availA9 !== undefined ? formatNum(availA9, availA9 % 1 === 0 ? 0 : 2) : (loading ? '…' : '—')}</strong>
        </div>
        <div class="profile-telemetry-cell">
          <small>${isLive ? L('锁仓本金', 'Locked') : L('待解锁', 'Locked')}</small>
          <strong class="mono">${isLive ? (stakedPrincipalA9 !== null ? formatNum(stakedPrincipalA9, stakedPrincipalA9 % 1 === 0 ? 0 : 2) : (loading ? '…' : '—')) : formatNum(roundLockedA9 ?? 0)}</strong>
        </div>
        <div class="profile-telemetry-cell">
          <small>${L('凭证数', 'Passes')}</small>
          <strong class="text-cyan mono">${certsCount !== null && certsCount !== undefined ? `${certsCount} ${L('张', '')}` : (activeTicketsCount !== null ? `${activeTicketsCount} ${L('张', '')}` : (loading ? '…' : '—'))}</strong>
        </div>
      </div>

      <div class="unified-vault-list">
        <a class="unified-vault-row" href="#/claim">
          <div>
            <div class="num-sm" style="font-weight:800;">${L('链上轮次领奖', 'On-Chain Round Prizes')}</div>
            <div class="num-xs text-muted">${L('StakeTicket 链上直领 · 0.22 GRAM Gas', 'StakeTicket claim · 0.22 GRAM gas')}</div>
          </div>
          <div class="unified-vault-val">
            <b class="mono text-green">${roundValDisplay}</b>
            <span>${L('领奖', 'Claim')} ›</span>
          </div>
        </a>

        <a class="unified-vault-row" href="#/team/invite">
          <div>
            <div class="num-sm" style="font-weight:800;">${L('站内赏金余额 · 一键 0.06 GRAM 全提', 'Off-Chain Bounty · 1-Tap 0.06 GRAM Withdraw')}</div>
            <div class="num-xs text-muted">${L('好友通关 8% 返佣 + 商城直推 6% + 每轮空投合并一笔提现', '8% pass referral + 6% mall + round airdrop in one tx')}</div>
          </div>
          <div class="unified-vault-val">
            <b class="mono text-gold">${fmtA9(promoClaimableA9)}</b>
            <span>${L('全提', 'Withdraw')} ›</span>
          </div>
        </a>

        <button type="button" class="unified-vault-row unified-vault-btn" id="btn-vault-go-pred">
          <div>
            <div class="num-sm" style="font-weight:800;">${L('12H 预言金库', '12H Prediction Vault')}</div>
            <div class="num-xs text-muted">${hasPendingVault ? L('48H 内购箱 / 锁仓 / 邀 1 友自动激活并入赏金余额', 'Auto-activates in 48H via chest / lock / 1 invite') : L('0 GRAM 参战 · 激活后自动并入站内赏金余额', '0 GRAM arena · auto-merges to bounty balance')}</div>
          </div>
          <div class="unified-vault-val">
            <b class="mono">${fmtA9(predActivatedA9)} / <span class="text-gold">${fmtA9(predPendingA9)}</span></b>
            <span>${hasPendingVault ? L('待激活', 'Pending') : L('查看', 'View')} ›</span>
          </div>
        </button>

        <a class="unified-vault-row" href="#/rewards">
          <div>
            <div class="num-sm" style="font-weight:800;">${L('14 天逐秒待解锁', '14D Per-Second Unlock')}</div>
            <div class="num-xs text-muted">${L('20% 秒提 + 14 天逐秒解锁（支持 3 折急提，7 折销毁）', '20% Instant + 14D Per-Second Unlock (Instant Cashout 30% Now / 70% Burn)')}</div>
          </div>
          <div class="unified-vault-val">
            <b class="mono">${lockedValDisplay}</b>
            <span>${L('节奏', 'Schedule')} ›</span>
          </div>
        </a>
      </div>
      ${isLive && !hasWallet ? `<div class="row-between" style="margin-top:8px;gap:8px;"><span class="num-xs text-muted">${L('连接钱包同步链上凭证与余额', 'Connect wallet to sync balances')}</span><button class="btn btn-secondary btn-sm" id="profile-live-connect" type="button">${L('连接钱包', 'Connect')}</button></div>` : ''}
      ${isLive && hasWallet && loadError ? `<div class="row-between" style="margin-top:8px;gap:8px;"><span class="num-xs text-red">${L('部分链上数据同步超时', 'Some on-chain data failed to sync')}</span><button class="btn btn-secondary btn-sm" id="profile-live-retry" type="button">${L('重试', 'Retry')}</button></div>` : ''}
    </section>
  `;
}

function renderStakeReferralCardHtml({ loading = false, error = null, data = null } = {}) {
  const totalA9 = data ? (rawToA9(data.totalCommissionRaw) ?? 0) : null;
  const creditedA9 = data ? (rawToA9(data.creditedRaw) ?? 0) : null;
  const pendingA9 = data ? (rawToA9(data.pendingRaw) ?? 0) : null;
  const items = Array.isArray(data?.items) ? data.items : [];
  const unbound = data && data.bound === false;

  let body = '';
  if (loading) {
    body = `<div class="num-xs text-muted">${L('正在读取好友通关 8% 返佣明细…', 'Loading 8% pass referral credits…')}</div>`;
  } else if (error) {
    body = `<div class="row-between" style="gap:8px;"><span class="num-xs text-red">${escapeHtml(error)}</span><button class="btn btn-secondary btn-sm" id="btn-retry-profile-ref" type="button">${L('重试', 'Retry')}</button></div>`;
  } else if (!data || unbound) {
    body = `<div class="num-xs text-muted">${L('在 Telegram 内打开并绑定钱包后，好友通关的 8% 返佣将自动计入站内赏金，可合并 0.06 GRAM 一键提现。', 'Open in Telegram and bind your wallet to earn 8% pass referral credits, claimable together via 0.06 GRAM gas.')}</div>`;
  } else {
    body = `
      <div class="metric-strip cols-3" style="margin:6px 0 8px;">
        <div class="metric-cell"><span class="num-xs text-muted">${L('累计 8% 返佣', 'Total 8%')}</span><span class="num-sm text-green mono" style="font-weight:800;">${formatNum(totalA9, 2)} A9</span></div>
        <div class="metric-cell"><span class="num-xs text-muted">${L('已入赏金池', 'Credited')}</span><span class="num-sm mono" style="font-weight:800;">${formatNum(creditedA9, 2)} A9</span></div>
        <div class="metric-cell"><span class="num-xs text-muted">${L('待入账', 'Pending')}</span><span class="num-sm text-gold mono" style="font-weight:800;">${formatNum(pendingA9, 2)} A9</span></div>
      </div>
      ${items.length === 0
        ? `<div class="num-xs text-muted">${L('暂无好友通关返佣记录，分享邀请链接即可享好友通关奖金 8% 返佣。', 'No 8% pass referral credits yet. Share your invite link to earn 8% when friends pass a round.')}</div>`
        : `<div class="col-gap" style="gap:6px;">${items.slice(0, 5).map((it) => {
            const commA9 = rawToA9(it.commissionRaw) ?? 0;
            const isCred = String(it.status || '').toUpperCase() === 'CREDITED';
            return `
              <div class="list-row" style="padding:7px 10px;">
                <div>
                  <div class="num-sm" style="font-weight:800;">${L(`第 ${it.roundId} 轮`, `Round #${it.roundId}`)} · <span class="mono">${escapeHtml(it.refereeWallet || '—')}</span></div>
                  <div class="num-xs text-muted">${L('好友通关 8% 返佣', '8% Pass Referral')}</div>
                </div>
                <div style="text-align:right;">
                  <div class="num-sm text-green mono" style="font-weight:900;">+${formatNum(commA9, 2)} A9</div>
                  <span class="chip ${isCred ? 'chip-green' : 'chip-gold'}" style="min-height:18px;font-size:9.5px;">${isCred ? L('已入赏金', 'Credited') : L('待入账', 'Pending')}</span>
                </div>
              </div>
            `;
          }).join('')}</div>`}
    `;
  }

  return `
    <section class="card" id="profile-stake-referral-card">
      <div class="row-between" style="margin-bottom:6px;">
        <div class="card-title">${icon('team', 15, 'text-gold')} ${L('好友通关 8% 返佣明细', '8% Pass Referral Credits')}</div>
        <a class="text-link-btn" href="#/team/invite">${L('合并 0.06 GRAM 领', 'Claim (0.06 GRAM)')} ›</a>
      </div>
      ${body}
    </section>
  `;
}

export function renderProfileHome(root, navigate) {
  if (!config.isDemo) {
    const seq = ++profileRenderSeq;
    const u = store.state.user;
    const addrLabel = u.shortAddress || (u.address ? (u.address.length > 12 ? `${u.address.slice(0, 4)}...${u.address.slice(-4)}` : u.address) : null);
    const walletAddr = addrLabel || L('未连接钱包', 'Not connected');
    const gramText = u.tonBalance !== null && u.tonBalance !== undefined ? `${formatNum(u.tonBalance, 2)} GRAM` : '— GRAM';

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        ${identityStage({ walletAddr, gramText })}
        <div id="profile-unified-vault-mount"></div>
        <div id="profile-stake-referral-mount">${renderStakeReferralCardHtml({ loading: Boolean(A9TMA.getRawInitData()) })}</div>
        <div class="profile-dock-grid" aria-label="${L('快捷功能', 'Quick Actions')}">
          <button class="profile-dock-tile" data-nav="/proof" type="button">
            <span class="profile-dock-icon tone-red">${icon('shieldCheck', 18)}</span>
            <span class="profile-dock-label">${L('凭证', 'Pass')}</span>
            <span class="profile-dock-sub" id="live-dock-passes">—</span>
          </button>
          <button class="profile-dock-tile" data-nav="/ledger" type="button">
            <span class="profile-dock-icon tone-green">${icon('receipt', 18)}</span>
            <span class="profile-dock-label">${L('账本', 'Ledger')}</span>
            <span class="profile-dock-sub">${L('明细', 'Log')}</span>
          </button>
          <button class="profile-dock-tile" data-nav="/renew" type="button">
            <span class="profile-dock-icon tone-blue">${icon('clock', 18)}</span>
            <span class="profile-dock-label">${L('提醒', 'Alert')}</span>
            <span class="profile-dock-sub" style="color:${u.autoRenew ? 'var(--nt-green)' : 'var(--ink-muted)'};">${u.autoRenew ? L('已开', 'ON') : L('已关', 'OFF')}</span>
          </button>
          <button class="profile-dock-tile" data-nav="/settings" type="button">
            <span class="profile-dock-icon tone-slate">${icon('settings', 18)}</span>
            <span class="profile-dock-label">${L('设置', 'Settings')}</span>
            <span class="profile-dock-sub">${L('偏好', 'Prefs')}</span>
          </button>
        </div>
      </div>
    `;

    const vaultMount = root.querySelector('#profile-unified-vault-mount');
    const paintLiveVault = (opts) => {
      if (seq !== profileRenderSeq || !vaultMount || !vaultMount.isConnected) return;
      vaultMount.innerHTML = renderUnifiedVaultHtml({
        ...opts,
        isLive: true,
        hasWallet: Boolean(store.state.user.address),
        fundsEnabled: store.fundsEnabled,
      });
      const predBtn = vaultMount.querySelector('#btn-vault-go-pred');
      if (predBtn) {
        predBtn.onclick = () => {
          A9Haptic.light();
          store.state.referral.pendingScrollTarget = 'prediction';
          navigate('/round');
        };
      }
      const connBtn = vaultMount.querySelector('#profile-live-connect');
      if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderProfileHome(root, navigate));
      const retryBtn = vaultMount.querySelector('#profile-live-retry');
      if (retryBtn) retryBtn.onclick = () => renderProfileHome(root, navigate);
    };

    const addr = store.state.user.address;
    const uid = getEffectiveUserId(store.state.user);
    const roundId = store.state.round?.currentRound || null;
    paintLiveVault({ loading: Boolean(addr || uid) });

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
        const anyErr = (addr && portRes.status === 'rejected') || (addr && promoRes.status === 'rejected');

        const availA9 = (portData && portData.balanceAvailable !== false && portData.a9BalanceRaw !== null && portData.a9BalanceRaw !== undefined)
          ? rawToA9(portData.a9BalanceRaw)
          : null;
        const tickets = Array.isArray(portData?.tickets) ? portData.tickets : [];
        const activeTickets = tickets.filter((t) => !t?.principalDone && /^\d+$/.test(String(t?.amountRaw || '')));
        const stakedPrincipalA9 = activeTickets.length
          ? activeTickets.reduce((sum, t) => sum + (rawToA9(t.amountRaw) || 0), 0)
          : (portData ? 0 : null);
        const roundClaimableA9 = (portData && portData.claimableRaw !== undefined && portData.claimableRaw !== null)
          ? rawToA9(portData.claimableRaw)
          : null;
        const roundLockedA9 = (portData && portData.lockedRaw !== undefined && portData.lockedRaw !== null)
          ? rawToA9(portData.lockedRaw)
          : null;
        const promoClaimableA9 = promoData && promoData.claimableRaw !== undefined ? rawToA9(promoData.claimableRaw) : null;
        const predActivatedA9 = predData && predData.activatedRaw !== undefined ? rawToA9(predData.activatedRaw) : null;
        const predPendingA9 = predData && predData.pendingActivationRaw !== undefined ? rawToA9(predData.pendingActivationRaw) : null;

        const dockPasses = root.querySelector('#live-dock-passes');
        if (dockPasses) dockPasses.textContent = portData ? `${tickets.length} ${L('张', 'SBT')}` : '—';

        paintLiveVault({
          availA9,
          roundClaimableA9,
          roundLockedA9,
          promoClaimableA9,
          predActivatedA9,
          predPendingA9,
          activeTicketsCount: portData ? tickets.length : null,
          stakedPrincipalA9,
          certsCount: portData ? tickets.length : null,
          loading: false,
          loadError: anyErr,
        });
      });
    }

    const loadProfileStakeRefs = () => {
      const refMount = root.querySelector('#profile-stake-referral-mount');
      if (!refMount) return;
      if (!A9TMA.getRawInitData()) {
        refMount.innerHTML = renderStakeReferralCardHtml({ loading: false, data: null });
        return;
      }
      refMount.innerHTML = renderStakeReferralCardHtml({ loading: true });
      fetchMyStakeReferrals(20)
        .then((res) => {
          if (seq !== profileRenderSeq || !refMount.isConnected) return;
          refMount.innerHTML = renderStakeReferralCardHtml({ loading: false, data: res });
        })
        .catch((e) => {
          if (seq !== profileRenderSeq || !refMount.isConnected) return;
          refMount.innerHTML = renderStakeReferralCardHtml({ loading: false, error: e?.message || L('返佣明细读取失败', 'Failed to load referral credits') });
          const retryBtn = refMount.querySelector('#btn-retry-profile-ref');
          if (retryBtn) retryBtn.onclick = () => loadProfileStakeRefs();
        });
    };
    loadProfileStakeRefs();
    return;
  }

  const { user, certificates } = store.state;
  const isEmpty = user.profileMode === 'empty';
  const unknown = !user.connected && !config.isDemo;
  const modePill = `<button class="pill-trigger neutral" id="btn-profile-mode" type="button">${isEmpty ? L('空态', 'Empty') : L('持仓', 'Vault')} ${icon('chevronDown', 12)}</button>`;
  const walletAddr = user.shortAddress || (user.address ? (user.address.length > 12 ? `${user.address.slice(0, 4)}...${user.address.slice(-4)}` : user.address) : L('未连接钱包', 'Not connected'));
  const gramText = user.tonBalance === null || user.tonBalance === undefined ? '— GRAM' : `${formatNum(user.tonBalance, 2)} GRAM`;

  if (isEmpty && !unknown) {
    const emptyVaultHtml = renderUnifiedVaultHtml({
      availA9: 0,
      roundClaimableA9: 0,
      roundLockedA9: 0,
      promoClaimableA9: 0,
      predActivatedA9: 0,
      predPendingA9: 0,
      certsCount: 0,
      isLive: false,
      hasWallet: Boolean(user.connected),
      loading: false,
      fundsEnabled: store.fundsEnabled,
      showQuickSlider: false,
    });

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        ${identityStage({ modePill, walletAddr, gramText })}
        ${emptyVaultHtml}
        <div class="card">
          <div class="empty-state" style="padding:10px 8px 6px;">
            <span class="nt-art-badge tone-blue" style="width:52px;height:52px;" aria-hidden="true">${renderNintendoGateIcon('vault', 32)}</span>
            <div style="font-size:15px;font-weight:900;margin-top:4px;">${L('还没有锁仓持仓', 'No Active Lock Position Yet')}</div>
            <div class="text-sec" style="font-size:12px;max-width:260px;">${L('最低 100 A9 无门槛锁仓，头矿 6H · 5% 止损，永不爆仓。', 'Lock from 100 A9 — First 6H · 5% Stop-Loss, No Liquidation.')}</div>
            <div class="grid-2" style="width:100%;margin-top:10px;gap:8px;">
              <button class="btn btn-primary btn-sm" data-nav="/challenge/confirm" type="button">${icon('bolt', 14)} ${L('立即锁仓', 'Lock Now')}</button>
              <button class="btn btn-secondary btn-sm" data-nav="/internal/market" type="button">${icon('swap', 14)} ${L('宝箱商城', 'Chest Mall')}</button>
            </div>
          </div>
        </div>
        <div class="profile-dock-grid">
          <button class="profile-dock-tile" data-nav="/proof" type="button">
            <span class="profile-dock-icon tone-red">${icon('shieldCheck', 18)}</span>
            <span class="profile-dock-label">${L('凭证', 'Pass')}</span>
            <span class="profile-dock-sub">0</span>
          </button>
          <button class="profile-dock-tile" data-nav="/ledger" type="button">
            <span class="profile-dock-icon tone-green">${icon('receipt', 18)}</span>
            <span class="profile-dock-label">${L('账本', 'Ledger')}</span>
            <span class="profile-dock-sub">${L('明细', 'Log')}</span>
          </button>
          <button class="profile-dock-tile" data-nav="/renew" type="button">
            <span class="profile-dock-icon tone-blue">${icon('clock', 18)}</span>
            <span class="profile-dock-label">${L('提醒', 'Alert')}</span>
            <span class="profile-dock-sub">${user.autoRenew ? 'ON' : 'OFF'}</span>
          </button>
          <button class="profile-dock-tile" data-nav="/settings" type="button">
            <span class="profile-dock-icon tone-slate">${icon('settings', 18)}</span>
            <span class="profile-dock-label">${L('设置', 'Settings')}</span>
            <span class="profile-dock-sub">${L('系统', 'Sys')}</span>
          </button>
        </div>
      </div>
    `;
    const vaultPredBtn = root.querySelector('#btn-vault-go-pred');
    if (vaultPredBtn) {
      vaultPredBtn.onclick = () => {
        A9Haptic.light();
        store.state.referral.pendingScrollTarget = 'prediction';
        navigate('/round');
      };
    }
  } else {
    const claimable = unknown ? null : (user.a9Claimable || 0);
    const hasClaim = claimable !== null && claimable > 0;
    const availA9 = Number(user.a9Available || 0);
    const lockedA9 = Number(user.a9Locked || 0);
    const activeFilter = ['all', 'observation', 'settled'].includes(uiMemory.ticketFilter) ? uiMemory.ticketFilter : 'all';

    const promoDemoA9 = Number(store.state.user.promoClaimableA9 ?? store.state.team?.captainHistoryA9 ?? 0) || 0;
    const predActDemoA9 = rawToA9(store.state.prediction?.activatedRaw) || 0;
    const predPendDemoA9 = rawToA9(store.state.prediction?.pendingActivationRaw) || 0;
    const unifiedVaultDemoHtml = renderUnifiedVaultHtml({
      availA9,
      roundClaimableA9: claimable ?? 0,
      roundLockedA9: lockedA9,
      promoClaimableA9: promoDemoA9,
      predActivatedA9: predActDemoA9,
      predPendingA9: predPendDemoA9,
      certsCount: certificates.length,
      isLive: false,
      hasWallet: Boolean(user.connected),
      loading: false,
      fundsEnabled: store.fundsEnabled,
      showQuickSlider: hasClaim,
    });

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        ${identityStage({ modePill, walletAddr, gramText })}

        ${unifiedVaultDemoHtml}
        <div id="profile-stake-referral-mount">${renderStakeReferralCardHtml({ loading: true })}</div>

        <div class="profile-dock-grid" aria-label="${L('快捷功能', 'Quick Actions')}">
          <button class="profile-dock-tile" data-nav="/proof" type="button">
            <span class="profile-dock-icon tone-red">${icon('shieldCheck', 18)}</span>
            <span class="profile-dock-label">${L('凭证', 'Pass')}</span>
            <span class="profile-dock-sub">${certificates.length} ${L('张', 'SBT')}</span>
          </button>
          <button class="profile-dock-tile" data-nav="/ledger" type="button">
            <span class="profile-dock-icon tone-green">${icon('receipt', 18)}</span>
            <span class="profile-dock-label">${L('账本', 'Ledger')}</span>
            <span class="profile-dock-sub">${store.state.ledger.length} ${L('笔', 'tx')}</span>
          </button>
          <button class="profile-dock-tile" data-nav="/renew" type="button">
            <span class="profile-dock-icon tone-blue">${icon('clock', 18)}</span>
            <span class="profile-dock-label">${L('提醒', 'Alert')}</span>
            <span class="profile-dock-sub" style="color:${user.autoRenew ? 'var(--nt-green)' : 'var(--ink-muted)'};">${user.autoRenew ? L('已开', 'ON') : L('已关', 'OFF')}</span>
          </button>
          <button class="profile-dock-tile" data-nav="/settings" type="button">
            <span class="profile-dock-icon tone-slate">${icon('settings', 18)}</span>
            <span class="profile-dock-label">${L('设置', 'Settings')}</span>
            <span class="profile-dock-sub">${L('偏好', 'Prefs')}</span>
          </button>
        </div>

        <div class="card">
          <div class="card-header">
            <div class="card-title">${icon('shieldCheck', 16, 'text-green')} ${L('凭证收藏册', 'Ticket Collection')}</div>
            <span class="chip chip-muted mono">${certificates.length}</span>
          </div>
          <nav class="ticket-tabs" id="ticket-filter-tabs" aria-label="${L('筛选凭证', 'Filter tickets')}">${[['all', L('全部', 'All')], ['observation', L('12H 冲价中', '12H Push')], ['settled', L('已结算', 'Settled')]].map(([value, label]) => `<button type="button" data-ticket-filter="${value}" aria-pressed="${value === activeFilter}">${label}</button>`).join('')}</nav>
          <p class="ticket-empty" hidden>${L('该状态下暂无闯关凭证', 'No quest passes in this state')}</p>
          ${certificates.length === 0
            ? `<div class="empty-state" style="padding:14px;"><div class="num-xs text-muted">${L('暂无进行中的闯关凭证', 'No active quest passes')}</div><button class="btn btn-primary btn-sm" style="margin-top:8px;" data-nav="/round">${L('前往轮次闯关', 'Go to Quest')}</button></div>`
            : certificates.map(c => `
              <div class="list-row clickable collectible-ticket" role="button" tabindex="0" data-ticket-state="${escapeHtml(c.status)}" data-nav="${c.id ? `/proof/${escapeHtml(c.id)}` : '/proof'}" ${activeFilter !== 'all' && c.status !== activeFilter ? 'hidden' : ''}>
                <span class="collectible-ticket-badge" aria-hidden="true">${renderNintendoGateIcon('ticket', 24)}</span>
                <div>
                  <div class="num-sm" style="font-weight:900;">#${escapeHtml(c.id)}</div>
                  <div class="num-xs text-muted">${L('第', 'R')}${c.round}${L('轮', '')} · ${formatNum(c.stakeTon)} A9 · ${L('全员 1:1', '1:1 Equal')}</div>
                </div>
                <div style="text-align:right;">
                  <div class="num-sm text-green" style="font-weight:900;">+${formatNum(c.estRewardA9)} A9</div>
                  <span class="chip ${c.status === 'settled' ? 'chip-green' : 'chip-blue'}" style="min-height:18px;font-size:9.5px;margin-top:3px;">${c.status === 'settled' ? L('已结算', 'Settled') : L('12H 冲价中', '12H Push')}</span>
                </div>
              </div>
            `).join('')}
        </div>
      </div>
    `;

    const applyTicketFilter = (filter) => {
      uiMemory.ticketFilter = filter;
      let visible = 0;
      root.querySelectorAll('[data-ticket-state]').forEach(ticket => {
        ticket.hidden = filter !== 'all' && ticket.dataset.ticketState !== filter;
        if (!ticket.hidden) visible++;
      });
      root.querySelectorAll('[data-ticket-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ticketFilter === filter)));
      const emptyEl = root.querySelector('.ticket-empty');
      if (emptyEl) emptyEl.hidden = visible > 0 || certificates.length === 0;
    };
    applyTicketFilter(activeFilter);

    root.querySelector('#ticket-filter-tabs')?.addEventListener('click', e => {
      const button = e.target.closest('[data-ticket-filter]');
      if (!button) return;
      A9Haptic.light();
      A9Audio.tick();
      applyTicketFilter(button.dataset.ticketFilter);
    });
    if (hasClaim) {
      animateSlotCounter(root.querySelector('#a9-claim-num'), (claimable || 0) + promoDemoA9, { duration: 420 });
    }
    const sliderEl = root.querySelector('#profile-quick-slider');
    if (sliderEl) {
      mountSlider(sliderEl, {
        label: L(`右滑领取 ${formatNum(claimable)} A9`, `Slide to Claim ${formatNum(claimable)} A9`),
        onConfirm: () => {
          const amt = store.claimRewards();
          showToast(L(`已提取 ${formatNum(amt)} A9`, `Claimed ${formatNum(amt)} A9`));
          renderProfileHome(root, navigate);
        }
      });
    }
    const vaultPredBtn = root.querySelector('#btn-vault-go-pred');
    if (vaultPredBtn) {
      vaultPredBtn.onclick = () => {
        A9Haptic.light();
        store.state.referral.pendingScrollTarget = 'prediction';
        navigate('/round');
      };
    }
  }

  bindIdentityStage(root, () => renderProfileHome(root, navigate));
  const demoRefMount = root.querySelector('#profile-stake-referral-mount');
  if (demoRefMount) {
    fetchMyStakeReferrals(20)
      .then((res) => { if (demoRefMount.isConnected) demoRefMount.innerHTML = renderStakeReferralCardHtml({ loading: false, data: res }); })
      .catch(() => {});
  }

  const modeBtn = root.querySelector('#btn-profile-mode');
  if (modeBtn) {
    modeBtn.onclick = () => openChoiceSheet({
      title: L('切换资产视图状态', 'Switch Vault State'),
      selected: user.profileMode,
      options: [
        { value: 'active', label: L('持仓与待领态', 'Active Vault'), sub: L('展示余额、待领与凭证', 'Balance, claimable & proofs') },
        { value: 'empty',  label: L('新用户空状态', 'Empty State'),  sub: L('展示零门槛新手引导', 'Onboarding state') }
      ],
      onSelect: (val) => {
        store.update(s => { s.user.profileMode = val; });
        renderProfileHome(root, navigate);
      }
    });
  }
}

export function renderClaimPage(root) {
  const { user } = store.state;
  const claimable = config.isDemo ? user.a9Claimable : null;

  if (!config.isDemo && store.fundsEnabled) {
    renderLiveTicketClaimPage(root);
    return;
  }

  if (!config.isDemo || !store.fundsEnabled) {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero">
          <div class="row-between" style="margin-bottom:8px;">
            <span class="num-xs text-muted">${L('当前可领取', 'Claimable Now')}</span>
            <span class="chip chip-muted">${L('只读模式', 'READ-ONLY')}</span>
          </div>
          <div class="num-hero" style="margin-top:4px;">${claimable === null ? L('未获取', 'Unavailable') : formatNum(claimable)} <span class="num-md text-green">A9</span></div>
        </div>
        <div class="card" id="live-readonly-claim-notice" style="border-color:var(--gold-border);">
          <div class="row-start" style="font-weight:600;margin-bottom:4px;">${icon('shieldAlert', 15, 'text-gold')} ${L('真实只读模式 · 暂未开放领取签名', 'Live Read-Only · Claiming Disabled')}</div>
          <div class="num-xs text-sec" style="line-height:1.5;">${L('真实只读模式 · 暂未开放链上领取签名。', 'Live read-only · claim signing disabled.')}</div>
        </div>
        <button class="btn btn-secondary" id="btn-claim-readonly" type="button">${icon('lock', 15)} ${L('真实模式只读 · 暂未开放领取', 'Read-Only Mode · Claim Disabled')}</button>
        <button class="btn btn-secondary" data-nav="/profile">${icon('arrowLeft', 15)} ${L('返回我的', 'Back to Me')}</button>
      </div>
    `;
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
    if (claimedAmount > 0) {
      const txHash = demoTxHash('EQC');
      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <div class="card card-hero success-cert-stage anim-cert-drop" style="text-align:center;padding:24px 16px;">
            <span class="success-stamp-seal anim-seal-slam" aria-hidden="true"><b>${L('已入账', 'CLAIMED')}</b><span>A9 VAULT</span></span>
            <div style="display:flex;justify-content:center;margin:0 auto 8px;">${renderChestSvg('gold', { size: 68, state: 'opened' })}</div>
            <div style="font-size:18px;font-weight:900;">${L('奖金宝箱已开启', 'Prize Chest Opened')}</div>
            <div class="num-hero text-green" id="claimed-final-num" style="margin:6px 0;">+${formatNum(claimedAmount)} <span class="num-md text-green">A9</span></div>
            <div class="num-xs text-sec clickable" role="button" tabindex="0" id="copy-claim-tx">${escapeHtml(txHash)} ${icon('copy', 12)}</div>
            <div class="num-xs text-muted" style="margin-top:6px;">${L('演示哈希 · 非链上交易', 'Demo hash · not an on-chain tx')}</div>
          </div>

          <div class="card">
            <div class="card-title" style="margin-bottom:6px;">${icon('wallet', 15, 'text-gold')} ${L('账户余额已更新', 'Account Balance Updated')}</div>
            <div class="metric-strip cols-2" style="margin:6px 0 0;padding:8px 0 0;border-bottom:0;">
              <div class="metric-cell">
                <span class="num-xs text-muted">${L('当前可用 A9', 'Available A9')}</span>
                <span class="num-md text-green mono" id="claimed-avail-num">${formatNum(availNow)} A9</span>
              </div>
              <div class="metric-cell">
                <span class="num-xs text-muted">${L('待解锁余额', 'Remaining Locked')}</span>
                <span class="num-md mono">${formatNum(lockedNow)} A9</span>
              </div>
            </div>
          </div>

          <button class="btn btn-primary" data-nav="/ledger">${icon('receipt', 15)} ${L('查看收益明细', 'View Ledger')}</button>
          <button class="btn btn-secondary" data-nav="/profile">${icon('arrowLeft', 15)} ${L('返回我的', 'Back to Me')}</button>
        </div>
      `;
      animateSlotCounter(root.querySelector('#claimed-avail-num'), availNow, { duration: 480, suffix: ' A9' });
      root.querySelector('#copy-claim-tx').onclick = () => copyText(txHash, L('已复制哈希', 'Copied Hash'));
      return;
    }

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero">
          <div class="row-between" style="margin-bottom:8px;">
            <span class="num-xs text-muted">${L('即刻可领 (20%)', 'Claimable Now (20%)')}</span>
            <span class="chip chip-muted mono" id="claim-avail-pill">${L('账户可用', 'Avail')}: ${formatNum(availNow)} A9</span>
          </div>
          <div class="num-hero" id="claim-counter">${formatNum(claimable || 0)} A9</div>
        </div>

        ${claimable > 0 ? `
          <section class="claim-chest-stage" id="claim-chest-stage">
            <span class="diorama-kicker">A9 PRIZE CHEST</span>
            <div class="claim-chest-wrap" id="claim-chest-wrap">
              ${renderVaultChestSvg()}
            </div>
            <div class="claim-chest-hint" id="claim-chest-hint">${L('右滑开启宝箱领奖', 'Slide right to open chest')}</div>
            <div class="claim-breakdown-strip">
              <div><small>${L('本批释放', 'Immediate')}</small><strong class="text-green">20%</strong></div>
              <div><small>${L('待解锁余量', 'Locked')}</small><strong>${formatNum(lockedNow)}</strong></div>
              <div><small>${L('演示网络费', 'Demo Fee')}</small><strong>0 GRAM</strong></div>
            </div>
          </section>
          <div id="claim-slider-mount"></div>
        ` : `
          <div class="card empty-state">
            <div style="display:flex;justify-content:center;">${renderChestSvg('gold', { size: 60 })}</div>
            <div class="num-sm text-sec">${L('当前无可领余额，宝箱已清空', 'Nothing to claim right now')}</div>
            <button class="btn btn-secondary btn-sm" style="margin-top:6px;" data-nav="/profile">${L('返回我的', 'Back to Me')}</button>
          </div>
        `}
      </div>
    `;
    if (claimable > 0) {
      const stageEl = root.querySelector('#claim-chest-stage');
      const wrapEl = root.querySelector('#claim-chest-wrap');
      const hintEl = root.querySelector('#claim-chest-hint');
      const availPill = root.querySelector('#claim-avail-pill');

      animateSlotCounter(root.querySelector('#claim-counter'), claimable, { duration: 550, suffix: ' A9' });
      mountSlider(root.querySelector('#claim-slider-mount'), {
        label: L(`右滑开启宝箱 · 领 ${formatNum(claimable)} A9`, `Slide to Open Chest · ${formatNum(claimable)} A9`),
        silentConfirmAudio: true,
        onProgress: (p) => {
          if (stageEl) stageEl.style.setProperty('--chest-open', p.toFixed(3));
          if (hintEl) {
            if (p >= 0.8) hintEl.textContent = L('金光已满！松手瞬间收入囊中', 'Golden glow full! Release to claim');
            else if (p > 0.12) hintEl.textContent = L(`箱盖掀开中 ${Math.round(p * 100)}%…`, `Lifting chest lid ${Math.round(p * 100)}%…`);
            else hintEl.textContent = L('右滑开启宝箱领奖', 'Slide right to open chest');
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
              availPill.textContent = `${L('账户可用', 'Avail')}: ${formatNum(nextAvail)} A9`;
              availPill.classList.add('anim-counter-boing');
            }
          }, 380);
          showToast(L(`宝箱已开启 · 入账 ${formatNum(claimedAmount)} A9`, `Chest opened · +${formatNum(claimedAmount)} A9`));
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
function renderLiveTicketClaimPage(root) {
  let portfolio = null;
  let loadError = null;
  let claimingAddr = null;

  const paint = () => {
    const { user } = store.state;
    const tickets = Array.isArray(portfolio?.tickets) ? portfolio.tickets : [];
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
              ? L(`当前已扫描第 ${range.fromRound} 至第 ${range.toRound} 轮链上锁仓凭证；每笔领奖需附带 0.22 GRAM 链上 Gas（余量原路退回）。`, `Scanned rounds ${range.fromRound}–${range.toRound}. Each claim attaches 0.22 GRAM gas (excess refunded).`)
              : L('每笔 StakeTicket 领奖需附带 0.22 GRAM 链上 Gas（余量原路退回）。', 'Each StakeTicket claim attaches 0.22 GRAM gas (excess refunded).')}
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
          gasText: `0.22 GRAM (${L('余量原路退回', 'excess refunded')})`,
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

    // v17: 3 折急提（已解锁 100% 实发，仅未解锁余额按 30% 秒提 + 70% 直接销毁；0.34 GRAM 余量全退）
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
          gasText: `0.34 GRAM (${L('含发币+销毁双动作 Gas，余量全退', 'dual-action gas, excess refunded')})`,
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
          gasText: `0.34 GRAM (${L('余量原路退回', 'excess refunded')})`,
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

export function renderProofDetail(root, navigate, certId) {
  const cert = store.state.certificates.find(c => c.id === certId) || store.state.certificates[0];
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
  const estLabel = isSettled ? L('实际奖励', 'Confirmed') : L('预计奖励', 'Est. Reward');

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="cert-flip-scene" id="cert-flip-scene" role="button" tabindex="0" aria-label="${L('轻点翻转查看链上核验背面', 'Tap to flip for on-chain verification')}">
        <div class="cert-flip-card" id="cert-flip-card">
          <div class="cert-pass cert-detail-card cert-face front ${isSettled ? 'is-settled' : ''}">
            <div class="cert-top-bar">
              <span class="row-start" style="gap:7px;">
                <span class="cert-grip-bars" aria-hidden="true"><i></i><i></i><i></i></span>
                <span class="cert-serial">SBT PASS · R${String(cert.round).padStart(2, '0')}</span>
              </span>
              <span class="cert-status-pill">${icon('shieldCheck', 11)} ${config.isDemo ? L('演示凭证', 'DEMO') : L('链上验真', 'VERIFIED')}</span>
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
                  <strong>${formatNum(cert.stakeTon)}<span class="cert-unit">A9</span></strong>
                </div>
                <div class="cert-metric-tile is-gold">
                  <small>${L('单轮封顶', 'Round Cap')}</small>
                  <strong class="text-gold">5×</strong>
                </div>
                <div class="cert-metric-tile is-green">
                  <small>${estLabel}</small>
                  <strong class="text-green">+${formatNum(cert.estRewardA9)}<span class="cert-unit">A9</span></strong>
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

      <div class="card">
        <div class="row-between" style="gap:8px;">
          <div class="settings-row-left">
            <span class="icon-badge sky">${icon('clock', 16)}</span>
            <div>
              <div class="settings-row-title">${L('头矿 6H 开盘 Bot 私信提醒', 'First 6H Opening Bot Alert')}</div>
              <div class="settings-row-sub">${L('非托管架构不代扣本金 · 领完后可一键复投下一轮', 'Non-custodial · 1-tap re-lock after claim')}</div>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" data-nav="/renew" type="button" style="white-space:nowrap;">${L('去设置', 'Set Alert')} ›</button>
        </div>
      </div>
    </div>
  `;

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

let liveRenewNotifCache = { fetched: false, settlementPush: null, error: null, saving: false };
let renewRenderSeq = 0;

export function renderRenewPage(root) {
  const { user, round } = store.state;
  const nextRoundNum = round.currentRound ? round.currentRound + 1 : null;
  const nextRoundZh = nextRoundNum ? `第 ${nextRoundNum} 轮` : '下一轮';
  const nextRoundEn = nextRoundNum ? `Round ${nextRoundNum}` : 'Next Round';
  const isDemo = config.isDemo;
  const hasInitData = !isDemo && Boolean(A9TMA.getRawInitData());
  const seq = ++renewRenderSeq;
  const isOn = isDemo
    ? Boolean(user.autoRenew)
    : Boolean(hasInitData && liveRenewNotifCache.fetched && liveRenewNotifCache.settlementPush === true);
  const availFloor = user.a9Available !== null && user.a9Available !== undefined ? Math.floor(Number(user.a9Available) || 0) : 0;
  const restakeHref = availFloor >= 100 ? `#/challenge/confirm?amt=${availFloor}` : '#/challenge/confirm';
  const subText = isDemo
    ? L(`${nextRoundZh}开盘第一时间推送 Bot 通知，锁头矿 5% 轻止损`, `Get instant Bot DM when ${nextRoundEn} opens for 5% Stop-Loss`)
    : (!hasInitData
        ? L('请在 Telegram 小程序内打开以管理 Bot 开盘与结算提醒', 'Open in Telegram Mini App to manage Bot opening & settlement alerts')
        : (liveRenewNotifCache.saving
            ? L('正在同步服务端提醒设置…', 'Saving alert preference…')
            : (liveRenewNotifCache.error
                ? L('提醒状态同步失败，点击开关重试', 'Failed to sync alert preference, tap to retry')
                : (!liveRenewNotifCache.fetched
                    ? L('正在同步服务端提醒状态…', 'Syncing alert preference…')
                    : (isOn
                        ? L(`已开启 Telegram Bot 私信提醒（${nextRoundZh}开盘 / 结算自动推送）`, `Telegram Bot DM alerts ON (${nextRoundEn} open & settle)`)
                        : L('已关闭 Telegram Bot 私信提醒', 'Telegram Bot DM alerts OFF'))))));

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <section class="renew-hero-card ${isOn ? 'is-on' : ''}" id="renew-hero-card">
        <div class="row-between">
          <div class="settings-row-left">
            <span class="nt-art-badge ${isOn ? 'tone-green' : 'tone-blue'}" style="width:46px;height:46px;border-radius:14px;">
              ${icon('clock', 22, isOn ? 'text-green' : 'text-cyan')}
            </span>
            <div>
              <div class="row-start" style="gap:6px;">
                <strong style="font-size:16px;font-weight:900;">${L('头矿 6H 开盘 Bot 私信提醒', 'First 6H Bot Opening Alert')}</strong>
                <span class="chip ${isOn ? 'chip-green' : 'chip-muted'}" id="renew-status-chip" style="min-height:20px;font-size:10px;">${isOn ? L('已开启', 'ACTIVE') : (!isDemo && !hasInitData ? L('仅 TG 内可用', 'TG ONLY') : L('已关闭', 'OFF'))}</span>
              </div>
              <div class="num-xs text-sec" id="renew-status-sub" style="margin-top:2px;">${subText}</div>
            </div>
          </div>
          ${isDemo
            ? `<div class="a9-switch ${isOn ? 'on' : ''}" id="global-renew-sw" role="switch" aria-checked="${isOn}" tabindex="0"></div>`
            : (!hasInitData
                ? `<div class="a9-switch disabled" id="global-renew-sw" role="switch" aria-checked="false" aria-disabled="true"></div>`
                : `<div class="a9-switch ${isOn ? 'on' : ''}${liveRenewNotifCache.saving ? ' disabled' : ''}" id="global-renew-sw" role="switch" aria-checked="${isOn}" aria-disabled="${liveRenewNotifCache.saving ? 'true' : 'false'}" tabindex="0"></div>`)}
        </div>

        <div class="renew-preview-grid">
          <div class="renew-preview-cell">
            <small>${L('目标轮次', 'Target')}</small>
            <strong>${nextRoundNum ? `R${String(nextRoundNum).padStart(2, '0')}` : L('下轮', 'Next')}</strong>
          </div>
          <div class="renew-preview-cell">
            <small>${L('资金模式', 'Custody')}</small>
            <strong>${L('纯非托管', 'Non-Custodial')}</strong>
          </div>
          <div class="renew-preview-cell">
            <small>${L('头矿特权', 'First 6H')}</small>
            <strong class="text-gold">${L('5% 轻止损', '5% Stop-Loss')}</strong>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <div class="card-title">${icon('bolt', 15, 'text-gold')} ${L('领奖后本金一键复投下一轮', '1-Tap Principal Re-Lock')}</div>
        </div>
        <p class="num-xs text-sec" style="margin:0 0 10px;line-height:1.5;">${L('A9 采用纯非托管链上架构，合约绝不代扣你的钱包本金。开盘提醒送达后，点下方按钮即可携带可用本金直通下一轮锁仓确认页。', 'A9 is strictly non-custodial and never auto-deducts your wallet. After claiming or receiving an alert, tap below to jump straight into next-round lock confirmation.')}</p>
        <div class="grid-2" style="gap:8px;">
          <a class="btn btn-primary btn-sm" href="${restakeHref}" style="width:100%;min-height:42px;">${icon('bolt', 14)} ${L('本金一键复投下一轮', '1-Tap Re-Lock')}</a>
          <button class="btn btn-secondary btn-sm" data-nav="/warmup" type="button" style="width:100%;min-height:42px;">${icon('clock', 14)} ${L('去预热预约', 'Warm-Up Reserve')}</button>
        </div>
      </section>

      <div class="grid-2">
        <button class="btn btn-secondary" data-nav="/round" type="button">${icon('radar', 14)} ${L('查看本轮进度', 'View Round')}</button>
        <button class="btn btn-secondary" data-nav="/profile" type="button">${icon('arrowLeft', 14)} ${L('返回我的', 'Back to Me')}</button>
      </div>
    </div>
  `;

  const sw = root.querySelector('#global-renew-sw');
  if (!sw) return;

  if (isDemo) {
    const toggle = () => {
      A9Haptic.tick();
      A9Audio.tick();
      store.update(s => { s.user.autoRenew = !s.user.autoRenew; });
      showToast(store.state.user.autoRenew ? L('已开启头矿 6H 开盘提醒', 'First 6H opening alert enabled') : L('已关闭开盘提醒', 'Opening alert disabled'));
      renderRenewPage(root);
    };
    sw.onclick = toggle;
    sw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
    return;
  }

  if (!hasInitData) {
    sw.onclick = () => {
      A9Haptic.warning();
      showToast(L('请在 Telegram 小程序内打开以管理 Bot 提醒', 'Open inside Telegram Mini App to manage Bot alerts'), 'amber');
    };
    return;
  }

  const applyLiveUi = () => {
    if (seq !== renewRenderSeq || root.isConnected === false || !sw || sw.isConnected === false) return;
    const curOn = Boolean(liveRenewNotifCache.fetched && liveRenewNotifCache.settlementPush === true);
    const hero = root.querySelector('#renew-hero-card');
    const chip = root.querySelector('#renew-status-chip');
    const sub = root.querySelector('#renew-status-sub');
    if (hero) hero.classList.toggle('is-on', curOn);
    sw.classList.toggle('on', curOn);
    sw.classList.toggle('disabled', Boolean(liveRenewNotifCache.saving));
    sw.setAttribute('aria-checked', String(curOn));
    sw.setAttribute('aria-disabled', String(Boolean(liveRenewNotifCache.saving)));
    if (chip) {
      chip.className = `chip ${curOn ? 'chip-green' : 'chip-muted'}`;
      chip.textContent = curOn ? L('已开启', 'ACTIVE') : L('已关闭', 'OFF');
    }
    if (sub) {
      if (liveRenewNotifCache.saving) {
        sub.textContent = L('正在同步服务端提醒设置…', 'Saving alert preference…');
      } else if (liveRenewNotifCache.error && liveRenewNotifCache.settlementPush === null) {
        sub.textContent = L('提醒状态同步失败，点击开关重试', 'Failed to sync alert preference, tap to retry');
      } else if (!liveRenewNotifCache.fetched) {
        sub.textContent = L('正在同步服务端提醒状态…', 'Syncing alert preference…');
      } else {
        sub.textContent = curOn
          ? L(`已开启 Telegram Bot 私信提醒（${nextRoundZh}开盘 / 结算自动推送）`, `Telegram Bot DM alerts ON (${nextRoundEn} open & settle)`)
          : L('已关闭 Telegram Bot 私信提醒', 'Telegram Bot DM alerts OFF');
      }
    }
  };

  const syncLivePrefs = () => {
    fetchNotificationPrefs()
      .then((res) => {
        const on = Boolean(res?.settlementPush);
        liveRenewNotifCache = { fetched: true, settlementPush: on, error: null, saving: false };
        store.update(s => {
          s.user.autoRenew = on;
          s.settings.settlementPush = on;
        });
        applyLiveUi();
      })
      .catch(() => {
        liveRenewNotifCache = { fetched: true, settlementPush: null, error: 'SYNC_FAILED', saving: false };
        applyLiveUi();
      });
  };

  if (!liveRenewNotifCache.fetched && !liveRenewNotifCache.saving) {
    syncLivePrefs();
  }

  const toggleLive = async () => {
    if (liveRenewNotifCache.saving) return;
    if (!liveRenewNotifCache.fetched || (liveRenewNotifCache.error && liveRenewNotifCache.settlementPush === null)) {
      liveRenewNotifCache = { fetched: false, settlementPush: null, error: null, saving: false };
      applyLiveUi();
      syncLivePrefs();
      return;
    }
    A9Haptic.tick();
    A9Audio.tick();
    const prev = Boolean(liveRenewNotifCache.settlementPush);
    const next = !prev;
    liveRenewNotifCache = { fetched: true, settlementPush: next, error: null, saving: true };
    applyLiveUi();
    try {
      const res = await updateNotificationPrefs({ settlementPush: next });
      const saved = Boolean(res?.settlementPush);
      liveRenewNotifCache = { fetched: true, settlementPush: saved, error: null, saving: false };
      store.update(s => {
        s.user.autoRenew = saved;
        s.settings.settlementPush = saved;
      });
      applyLiveUi();
      showToast(saved
        ? L('已开启 Telegram Bot 开盘与结算提醒', 'Telegram Bot opening & settlement alerts enabled')
        : L('已关闭 Telegram Bot 提醒', 'Telegram Bot alerts disabled'));
    } catch (e) {
      liveRenewNotifCache = { fetched: true, settlementPush: prev, error: 'SAVE_FAILED', saving: false };
      applyLiveUi();
      showToast(e?.message || L('提醒设置保存失败，请重试', 'Failed to save alert preference'), 'error');
    }
  };
  sw.onclick = toggleLive;
  sw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLive(); } };
}

export function renderLedgerPage(root) {
  if (!config.isDemo) {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero empty-state">
          <span class="nt-art-badge tone-green" aria-hidden="true">${icon('receipt', 24, 'text-green')}</span>
          <div style="font-size:16px;font-weight:900;margin-top:4px;">${L('收益账本等待链上核验', 'Ledger Awaits Verification')}</div>
          <p class="num-xs text-sec" style="margin:0;max-width:260px;">${L('真实模式下不展示演示流水；请返回「我的」连接钱包核验链上余额与锁仓凭证。', 'Live mode never displays demo entries. Return to Me to verify wallet balances and passes.')}</p>
          <a class="btn btn-primary btn-sm" style="margin-top:10px;" href="#/profile">${icon('wallet', 14)} ${L('查看钱包资产', 'View Wallet Assets')}</a>
        </section>
      </div>
    `;
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

  const catMeta = (cat) => {
    if (cat === 'promo') return { cls: 'amber', glyph: 'team' };
    if (cat === 'warmup') return { cls: 'sky', glyph: 'bolt' };
    return { cls: 'emerald', glyph: 'trophy' };
  };

  const paint = () => {
    if (viewMode === 'records') {
      const history = store.state.certificates;
      const totalStaked = history.reduce((s, c) => s + (c.stakeTon || 0), 0);
      const settledCnt = history.filter(c => c.status === 'settled').length;
      const obsCnt = history.length - settledCnt;

      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <div class="seg-tabs">
            <button class="seg-tab" data-lmode="ledger" type="button">${L('收益账本', 'Ledger')}</button>
            <button class="seg-tab active" data-lmode="records" type="button">${L('闯关战绩', 'History')}</button>
          </div>

          <section class="ledger-hero-card is-records">
            <div class="ledger-ticket-head is-red">
              <span class="row-start" style="gap:6px;"><span class="cert-grip-bars" aria-hidden="true"><i></i><i></i><i></i></span><span class="cert-serial">QUEST HISTORY</span></span>
              <span class="cert-status-pill mono">${history.length} ${L('轮', 'ROUNDS')}</span>
            </div>
            <div class="ledger-hero-body">
              <span class="num-xs text-muted">${L('累计锁仓本金', 'Total Locked Principal')}</span>
              <div class="num-hero" style="margin-top:2px;">${formatNum(totalStaked)} <span class="num-md text-green">A9</span></div>
              <div class="cert-perf" aria-hidden="true"><span class="cert-perf-line"></span></div>
              <div class="ledger-kpi-strip">
                <div class="ledger-kpi-box">
                  <small>${L('已结算', 'Settled')}</small>
                  <strong class="text-green">${settledCnt}</strong>
                </div>
                <div class="ledger-kpi-box">
                  <small>${L('12H 冲价中', '12H Push')}</small>
                  <strong class="text-cyan">${obsCnt}</strong>
                </div>
                <div class="ledger-kpi-box">
                  <small>${L('单轮封顶', 'Round Cap')}</small>
                  <strong class="text-gold">5×</strong>
                </div>
              </div>
            </div>
          </section>

          <div class="col-gap" style="gap:9px;">
            ${history.length === 0
              ? `<div class="card empty-state"><div class="num-xs text-muted">${L('暂无闯关战绩', 'No history')}</div></div>`
              : history.map(h => `
                <article class="record-pass-card ${h.status === 'settled' ? 'is-settled' : ''}" data-nav="${h.id ? `/proof/${escapeHtml(h.id)}` : '/proof'}">
                  <div class="row-between">
                    <div class="row-start" style="gap:7px;">
                      <span class="chip chip-muted mono">R${String(h.round).padStart(2, '0')}</span>
                      <strong style="font-size:14px;">#${h.id}</strong>
                    </div>
                    <span class="chip ${h.status === 'settled' ? 'chip-green' : 'chip-blue'}">${h.status === 'settled' ? L('已结算', 'Settled') : L('12H 冲价中', '12H Push')}</span>
                  </div>
                  <div class="record-pass-metrics">
                    <div>
                      <div class="num-xs text-muted">${L('锁仓本金', 'Locked Principal')}</div>
                      <div class="num-sm mono" style="font-weight:900;">${formatNum(h.stakeTon)} A9</div>
                    </div>
                    <div style="text-align:right;">
                      <div class="num-xs text-muted">${h.status === 'settled' ? L('已确认奖励', 'Confirmed') : L('预计奖励', 'Est. Reward')}</div>
                      <div class="num-sm mono text-green" style="font-weight:900;">+${formatNum(h.estRewardA9)} A9</div>
                    </div>
                  </div>
                </article>
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
          <button class="seg-tab active" data-lmode="ledger" type="button">${L('收益账本', 'Ledger')}</button>
          <button class="seg-tab" data-lmode="records" type="button">${L('闯关战绩', 'History')}</button>
        </div>

        <section class="ledger-hero-card">
          <div class="ledger-ticket-head is-green">
            <span class="row-start" style="gap:6px;"><span class="cert-grip-bars" aria-hidden="true"><i></i><i></i><i></i></span><span class="cert-serial">REWARD LEDGER</span></span>
            <span class="cert-status-pill mono">${rowsAll.length} ${L('笔', 'TX')}</span>
          </div>
          <div class="ledger-hero-body">
            <span class="num-xs text-muted">${L('累计记录收益', 'Cumulative Ledger Total')}</span>
            <div class="num-hero text-green" style="margin-top:2px;">+${formatNum(totalEarned)} <span class="num-md text-green">A9</span></div>
            <div class="cert-perf" aria-hidden="true"><span class="cert-perf-line"></span></div>
            <div class="ledger-kpi-strip">
              <div class="ledger-kpi-box">
                <small>${L('用户奖励', 'User')}</small>
                <strong>${userCnt} ${L('笔', '')}</strong>
              </div>
              <div class="ledger-kpi-box">
                <small>${L('邀友奖励', 'Invite')}</small>
                <strong class="text-gold">${promoCnt} ${L('笔', '')}</strong>
              </div>
              <div class="ledger-kpi-box">
                <small>${L('开局预热', 'Pre-Round')}</small>
                <strong class="text-cyan">${warmupCnt} ${L('笔', '')}</strong>
              </div>
            </div>
          </div>
        </section>

        <div class="filter-row">${categories.map(([v, label]) => `<button class="filter-pill ${activeFilter === v ? 'active' : ''}" data-lf="${v}" type="button">${label}</button>`).join('')}</div>

        ${list.length === 0
          ? `<div class="card empty-state"><div class="num-xs text-muted">${L('该分类下暂无收益记录', 'No reward records in this category')}</div></div>`
          : `<div class="ledger-entry-list">
              ${list.map(l => {
                const meta = catMeta(l.cat);
                return `
                  <div class="ledger-entry-row">
                    <div class="ledger-entry-left">
                      <span class="icon-badge ${meta.cls}">${icon(meta.glyph, 16)}</span>
                      <div style="min-width:0;">
                        <div class="ledger-entry-title">${escapeHtml(l.type)}</div>
                        <div class="ledger-entry-meta mono">${escapeHtml(l.time || '—')}</div>
                      </div>
                    </div>
                    <div class="ledger-entry-right">
                      <div class="num-sm text-green" style="font-weight:900;">${escapeHtml(l.amount || '0 A9')}</div>
                      ${l.status ? `<span class="chip chip-muted" style="min-height:18px;font-size:9.5px;padding:0 7px;">${escapeHtml(l.status)}</span>` : ''}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>`}
      </div>
    `;
    root.querySelectorAll('[data-lmode]').forEach(b => { b.onclick = () => { A9Haptic.light(); A9Audio.tick(); viewMode = b.dataset.lmode; paint(); }; });
    root.querySelectorAll('[data-lf]').forEach(b => { b.onclick = () => { A9Haptic.light(); A9Audio.tick(); activeFilter = b.dataset.lf; paint(); }; });
  };
  paint();
}

export function renderRecordsPage(root) {
  if (!config.isDemo) {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero empty-state">
          <span class="nt-art-badge tone-red" aria-hidden="true">${renderNintendoGateIcon('ticket', 32)}</span>
          <div style="font-size:16px;font-weight:900;margin-top:4px;">${L('闯关战绩等待链上核验', 'History Awaits Verification')}</div>
          <p class="num-xs text-sec" style="margin:0;max-width:260px;">${L('真实模式下请连接钱包在「我的」核验链上锁仓凭证。', 'Connect your wallet in Me to verify on-chain passes.')}</p>
          <a class="btn btn-primary btn-sm" style="margin-top:10px;" href="#/profile">${icon('wallet', 14)} ${L('查看钱包资产', 'View Wallet Assets')}</a>
        </section>
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
        <section class="ledger-hero-card is-records">
          <div class="ledger-ticket-head is-red">
            <span class="row-start" style="gap:6px;"><span class="cert-grip-bars" aria-hidden="true"><i></i><i></i><i></i></span><span class="cert-serial">QUEST HISTORY</span></span>
            <span class="cert-status-pill mono">${history.length} ${L('轮', 'ROUNDS')}</span>
          </div>
          <div class="ledger-hero-body">
            <span class="num-xs text-muted">${L('累计锁仓本金', 'Total Locked')}</span>
            <div class="num-hero" style="margin-top:2px;">${formatNum(totalStaked)} <span class="num-md text-green">A9</span></div>
          </div>
        </section>

        <div class="filter-row">
          <button class="filter-pill ${activeFilter === 'all' ? 'active' : ''}" data-rf="all" type="button">${L('全部', 'All')}</button>
          <button class="filter-pill ${activeFilter === 'observation' ? 'active' : ''}" data-rf="observation" type="button">${L('进行中', 'Live')}</button>
          <button class="filter-pill ${activeFilter === 'settled' ? 'active' : ''}" data-rf="settled" type="button">${L('已结算', 'Settled')}</button>
        </div>

        <div class="col-gap" style="gap:9px;">
          ${list.length === 0
            ? `<div class="card empty-state"><div class="num-xs text-muted">${L('暂无记录', 'No records')}</div></div>`
            : list.map((h, i) => `
              <article class="record-pass-card ${h.status === 'settled' ? 'is-settled' : ''}" data-drawer="${i}">
                <div class="row-between">
                  <div class="row-start" style="gap:7px;">
                    <span class="chip chip-muted mono">R${String(h.round).padStart(2, '0')}</span>
                    <strong style="font-size:14px;">${formatNum(h.stakeTon)} A9</strong>
                  </div>
                  <span class="chip ${h.status === 'settled' ? 'chip-green' : 'chip-blue'}">${h.status === 'settled' ? L('已结算', 'Settled') : L('12H 冲价中', '12H Push')}</span>
                </div>
                <div class="row-between" style="margin-top:8px;">
                  <span class="num-xs text-muted">${L('凭证', 'Pass')} #${escapeHtml(h.id)}</span>
                  <span class="num-sm text-green mono" style="font-weight:900;">+${formatNum(h.estRewardA9)} A9 ${icon('chevronDown', 11)}</span>
                </div>
                <div class="drawer-body hidden" id="drawer-${i}" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--card-border);">
                  <div class="row-between num-xs"><span class="text-muted">TX Hash</span><span class="mono text-gold">${escapeHtml(h.txHash || '—')}</span></div>
                </div>
              </article>
            `).join('')}
        </div>
      </div>
    `;
    root.querySelectorAll('[data-rf]').forEach(b => { b.onclick = () => { A9Haptic.light(); activeFilter = b.dataset.rf; paint(); }; });
    root.querySelectorAll('[data-drawer]').forEach(card => {
      card.onclick = () => { A9Haptic.light(); root.querySelector(`#drawer-${card.dataset.drawer}`).classList.toggle('hidden'); };
    });
  };
  paint();
}
