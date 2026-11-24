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
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast, copyText, mountSlider, renderCorridorRadar, bindCorridorRadarEvents, animateSlotCounter, launchCoinArc, burstParticles, openChoiceSheet, openModal, closeModal } from '../components.js';
import { renderVaultChestSvg, renderNintendoGateIcon } from '../paper-art.js';
import { renderChestSvg } from '../chest-art.js';
import { renderProofFlexPoster, renderStoryPoster, downloadPosterPng } from '../poster.js';
import { openXShareSheet, triggerStoryShare } from '../share.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { tonConnect } from '../tonconnect.js';
import { fetchUserPortfolio, fetchPromoBalance, fetchPredictionUser, getEffectiveUserId, rawToA9 } from '../data.js';
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
      ? `${L('质押中', 'Staked')} ${fmtA9(stakedPrincipalA9)}`
      : fmtA9(null));

  return `
    <section class="card card-hero unified-vault-card" id="profile-unified-vault">
      <div class="row-between" style="margin-bottom:8px;">
        <div class="card-title">${icon('wallet', 15, 'text-gold')} ${L('统一金库 / 领奖中心', 'Unified Vault & Claim Center')}</div>
        <span class="chip ${isLive ? (fundsEnabled ? 'chip-green' : 'chip-muted') : 'chip-gold'}">${isLive ? (fundsEnabled ? L('链上可领', 'LIVE') : L('只读模式', 'READ-ONLY')) : 'DEMO'}</span>
      </div>

      <div class="unified-vault-total">
        <span class="num-xs text-muted">${L('当前聚合可领总额（轮次已解锁 + 推广余额，含已激活预言）', 'Total Ready to Claim (Round + Promo Balance, incl. activated prediction)')}</span>
        <div class="num-lg text-green mono" style="font-weight:900;margin-top:3px;">${loading && !hasAnySum ? L('同步中…', 'Syncing…') : (showQuickSlider && roundClaimableA9 > 0 ? `<span id="a9-claim-num">${formatNum(totalReadyA9 ?? 0)}</span> A9` : fmtA9(totalReadyA9))}</div>
      </div>

      ${showQuickSlider && fundsEnabled && roundClaimableA9 > 0 ? `<div id="profile-quick-slider" style="margin:8px 0;"></div>` : ''}

      <div class="profile-asset-telemetry" style="margin:8px 0 10px;">
        <div class="profile-telemetry-cell">
          <small>${L('可用 A9', 'Available')}</small>
          <strong class="mono">${availA9 !== null && availA9 !== undefined ? formatNum(availA9, availA9 % 1 === 0 ? 0 : 2) : (loading ? '…' : '—')}</strong>
        </div>
        <div class="profile-telemetry-cell">
          <small>${isLive ? L('质押本金', 'Staked') : L('待解锁', 'Locked')}</small>
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
            <div class="num-sm" style="font-weight:800;">${L('轮次已解锁奖励', 'Unlocked Round Prizes')}</div>
            <div class="num-xs text-muted">${L('StakeTicket 链上领奖 · 附 0.22 GRAM Gas', 'StakeTicket claim · 0.22 GRAM gas')}</div>
          </div>
          <div class="unified-vault-val">
            <b class="mono text-green">${roundValDisplay}</b>
            <span>${L('去领取', 'Claim')} ›</span>
          </div>
        </a>

        <a class="unified-vault-row" href="#/team/invite">
          <div>
            <div class="num-sm" style="font-weight:800;">${L('推广返佣余额（6%）', 'Referral & Promo Balance (6%)')}</div>
            <div class="num-xs text-muted">${L('热钱包自动发 A9 · 付 0.06 GRAM Gas', 'Hot wallet A9 payout · 0.06 GRAM gas')}</div>
          </div>
          <div class="unified-vault-val">
            <b class="mono text-gold">${fmtA9(promoClaimableA9)}</b>
            <span>${L('去领取', 'Claim')} ›</span>
          </div>
        </a>

        <button type="button" class="unified-vault-row unified-vault-btn" id="btn-vault-go-pred">
          <div>
            <div class="num-sm" style="font-weight:800;">${L('24H 预言金库（已激活 / 待激活）', '24H Prediction Vault (Active / Pending)')}</div>
            <div class="num-xs text-muted">${hasPendingVault ? L('待激活金库 48H 内购箱/质押/邀 1 友购箱解锁', 'Pending vault unlocks within 48H via chest/stake/1 paid invite') : L('0 GRAM 参战预言 · 激活后合并推广余额领取', '0 GRAM arena · merges into promo balance once activated')}</div>
          </div>
          <div class="unified-vault-val">
            <b class="mono">${fmtA9(predActivatedA9)} / <span class="text-gold">${fmtA9(predPendingA9)}</span></b>
            <span>${hasPendingVault ? L('去激活', 'Activate') : L('去查看', 'View')} ›</span>
          </div>
        </button>

        <a class="unified-vault-row" href="#/rewards">
          <div>
            <div class="num-sm" style="font-weight:800;">${L('连胜锁仓待解锁份额', 'Vested Locked Shares')}</div>
            <div class="num-xs text-muted">${L('1–5 胜 20% / 6–10 胜 40% / 11 胜起 100%', '1–5w 20% / 6–10w 40% / 11+w 100%')}</div>
          </div>
          <div class="unified-vault-val">
            <b class="mono">${lockedValDisplay}</b>
            <span>${L('看档位', 'Tiers')} ›</span>
          </div>
        </a>
      </div>

      <div class="grid-3" style="gap:6px;margin-top:10px;">
        <a class="btn btn-primary btn-sm" href="#/claim" style="width:100%;min-height:38px;">${L('金库领奖', 'Claim')}</a>
        <a class="btn btn-secondary btn-sm" href="#/team/invite" style="width:100%;min-height:38px;">${L('推广领奖', 'Promo')}</a>
        <a class="btn btn-secondary btn-sm" href="#/rewards" style="width:100%;min-height:38px;">${L('解锁档位', 'Vesting')}</a>
      </div>
      ${isLive && !hasWallet ? `<div class="row-between" style="margin-top:8px;gap:8px;"><span class="num-xs text-muted">${L('连接并验证 TON 钱包后自动同步链上凭证与余额。', 'Connect & verify your TON wallet to sync live balances.')}</span><button class="btn btn-secondary btn-sm" id="profile-live-connect" type="button">${L('连接钱包', 'Connect')}</button></div>` : ''}
      ${isLive && hasWallet && loadError ? `<div class="row-between" style="margin-top:8px;gap:8px;"><span class="num-xs text-red">${L('部分链上数据同步超时', 'Some on-chain data failed to sync')}</span><button class="btn btn-secondary btn-sm" id="profile-live-retry" type="button">${L('重试', 'Retry')}</button></div>` : ''}
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
            <span class="profile-dock-icon tone-blue">${icon('refresh', 18)}</span>
            <span class="profile-dock-label">${L('连闯', 'Auto')}</span>
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
            <div style="font-size:15px;font-weight:900;margin-top:4px;">${L('还没有质押持仓', 'No Active Position Yet')}</div>
            <div class="text-sec" style="font-size:12px;max-width:260px;">${L('最低 1,000 A9 参与，达标瓜分当轮奖池。', 'Stake 1,000+ A9 to split the round pool.')}</div>
            <div class="grid-2" style="width:100%;margin-top:10px;gap:8px;">
              <button class="btn btn-primary btn-sm" data-nav="/challenge/confirm" type="button">${icon('bolt', 14)} ${L('立即参与', 'Stake Now')}</button>
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
            <span class="profile-dock-icon tone-blue">${icon('refresh', 18)}</span>
            <span class="profile-dock-label">${L('连闯', 'Auto')}</span>
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
            <span class="profile-dock-icon tone-blue">${icon('refresh', 18)}</span>
            <span class="profile-dock-label">${L('连闯', 'Auto')}</span>
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
          <nav class="ticket-tabs" id="ticket-filter-tabs" aria-label="${L('筛选凭证', 'Filter tickets')}">${[['all', L('全部', 'All')], ['observation', L('观察中', 'Observing')], ['settled', L('已结算', 'Settled')]].map(([value, label]) => `<button type="button" data-ticket-filter="${value}" aria-pressed="${value === activeFilter}">${label}</button>`).join('')}</nav>
          <p class="ticket-empty" hidden>${L('该状态下暂无闯关凭证', 'No quest passes in this state')}</p>
          ${certificates.length === 0
            ? `<div class="empty-state" style="padding:14px;"><div class="num-xs text-muted">${L('暂无进行中的闯关凭证', 'No active quest passes')}</div><button class="btn btn-primary btn-sm" style="margin-top:8px;" data-nav="/round">${L('前往轮次闯关', 'Go to Quest')}</button></div>`
            : certificates.map(c => `
              <div class="list-row clickable collectible-ticket" data-ticket-state="${escapeHtml(c.status)}" data-nav="/proof/${escapeHtml(c.id)}" ${activeFilter !== 'all' && c.status !== activeFilter ? 'hidden' : ''}>
                <span class="collectible-ticket-badge" aria-hidden="true">${renderNintendoGateIcon('ticket', 24)}</span>
                <div>
                  <div class="num-sm" style="font-weight:900;">#${escapeHtml(c.id)}</div>
                  <div class="num-xs text-muted">${L('第', 'R')}${c.round}${L('轮', '')} · ${formatNum(c.stakeTon)} A9 · ${(Number(c.multiplier) || 1).toFixed(1)}×</div>
                </div>
                <div style="text-align:right;">
                  <div class="num-sm text-green" style="font-weight:900;">+${formatNum(c.estRewardA9)} A9</div>
                  <span class="chip ${c.status === 'settled' ? 'chip-green' : 'chip-blue'}" style="min-height:18px;font-size:9.5px;margin-top:3px;">${c.status === 'settled' ? L('已结算', 'Settled') : L('观察中', 'Observing')}</span>
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
            <div class="num-xs text-sec clickable" id="copy-claim-tx">${txHash} ${icon('copy', 12)}</div>
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
              ? L(`当前已扫描第 ${range.fromRound} 至第 ${range.toRound} 轮链上质押凭证；每笔领奖需附带 0.22 GRAM 链上 Gas（余量原路退回）。`, `Scanned rounds ${range.fromRound}–${range.toRound}. Each claim attaches 0.22 GRAM gas (excess refunded).`)
              : L('每笔 StakeTicket 领奖需附带 0.22 GRAM 链上 Gas（余量原路退回）。', 'Each StakeTicket claim attaches 0.22 GRAM gas (excess refunded).')}
          </div>
          ${loadError ? `<div class="num-xs text-red" style="margin-top:8px;">${escapeHtml(loadError)}</div>` : ''}
        </div>

        ${!user.connected
          ? `<div class="card empty-state"><div class="num-sm text-sec">${L('请先连接非托管 TON 钱包读取链上质押凭证', 'Connect TON wallet to load on-chain StakeTickets')}</div><button class="btn btn-primary btn-sm" id="btn-live-claim-connect" style="margin-top:10px;">${L('连接钱包', 'Connect Wallet')}</button></div>`
          : !portfolio
            ? `<div class="card empty-state"><div class="num-sm text-muted">${L('正在读取链上 StakeTicket…', 'Loading on-chain StakeTickets…')}</div></div>`
            : tickets.length === 0
              ? `<div class="card empty-state"><div class="num-sm text-sec">${L('当前轮次范围内暂无可领 StakeTicket', 'No StakeTickets found in scanned rounds')}</div></div>`
              : `<div class="col-gap">
                  ${tickets.map((t) => {
                    const amtA9 = rawToA9(t.amountRaw) ?? 0;
                    const lockedClaimedA9 = rawToA9(t.lockedClaimedRaw ?? t.rewardClaimedRaw) ?? 0;
                    const immLabel = t.immediateClaimed ? L('已领', 'Claimed') : L('待领', 'Unclaimed');
                    const isPending = Boolean(t.pending);
                    const isBusy = claimingAddr === t.ticketAddress;
                    const isGlobalClaimLocked = pendingTxManager.isLocked('claim');
                    const statusChip = isPending
                      ? `<span class="chip chip-gold">${L('链上处理中', 'Pending')}</span>`
                      : t.principalDone
                        ? `<span class="chip chip-green">${L('本金已结 · 可检视后续解锁', 'Principal Done')}</span>`
                        : `<span class="chip chip-cyan">${L('持有中', 'Active')}</span>`;
                    return `
                      <div class="card">
                        <div class="row-between" style="margin-bottom:6px;">
                          <strong>${L(`第 ${t.roundId} 轮 StakeTicket`, `Round #${t.roundId} StakeTicket`)}</strong>
                          ${statusChip}
                        </div>
                        <div class="row-between num-xs text-sec">
                          <span>${L('凭证本金', 'Principal')}</span>
                          <b class="mono">${formatNum(amtA9, 2)} A9</b>
                        </div>
                        <div class="row-between num-xs text-sec" style="margin-top:4px;">
                          <span>${L('即时奖励 / 已领锁仓', 'Immediate / Locked Claimed')}</span>
                          <b class="mono text-green">${immLabel} · ${formatNum(lockedClaimedA9, 2)} A9</b>
                        </div>
                        <div class="num-xs text-muted mono" style="margin:6px 0 10px;word-break:break-all;">${escapeHtml(t.ticketAddress)}</div>
                        <button class="btn ${isPending || isGlobalClaimLocked ? 'btn-secondary' : 'btn-primary'} btn-sm" data-claim-ticket="${escapeHtml(t.ticketAddress)}" type="button" style="width:100%;" ${isPending || isBusy || isGlobalClaimLocked ? 'disabled' : ''}>
                          ${icon(isPending || isGlobalClaimLocked ? 'clock' : 'wallet', 13)} ${isPending
                            ? L('凭证正在链上确认中（防重锁）', 'Claim Pending On-Chain')
                            : isGlobalClaimLocked
                              ? L('领奖确认中（防重锁）', 'Claim Confirming…')
                              : isBusy
                                ? L('等待钱包签名…', 'Awaiting Signature…')
                                : L('发起链上领奖（附 0.22 GRAM Gas）', 'Claim On-Chain (0.22 GRAM Gas)')}
                        </button>
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
        const ticketPrincipalA9 = rawToA9(ticket?.amountRaw) ?? 0;
        const ok = await tonConnect.confirmBeforeSign({
          title: L('确认链上领奖（签名前核验）', 'Confirm On-Chain Claim'),
          contractLabel: L('目标凭证 StakeTicket', 'Target StakeTicket'),
          targetAddress: ticketAddr,
          principalText: `${L(`第 ${ticket?.roundId ?? '—'} 轮`, `Round #${ticket?.roundId ?? '—'}`)} · ${formatNum(ticketPrincipalA9, 2)} A9`,
          gasText: `0.22 GRAM (${L('余量原路退回', 'excess refunded')})`,
          totalText: '0.22 GRAM (Gas)',
          note: L('发送 TicketClaim 到 StakeTicket 合约，核销后由 RoundController 发放本金与已解锁 A9。', 'Sends TicketClaim to StakeTicket; RoundController disburses principal + unlocked A9.'),
          insufficientReason: ticket?.pending ? L('该凭证当前处于链上确认中，请等待完成', 'This StakeTicket already has a pending claim') : '',
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
        const prevBalanceRaw = portfolio?.a9BalanceRaw !== null && portfolio?.a9BalanceRaw !== undefined ? BigInt(portfolio.a9BalanceRaw) : null;

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
              const balIncreased = prevBalanceRaw !== null && next.a9BalanceRaw !== null && BigInt(next.a9BalanceRaw) > prevBalanceRaw;
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
          <div class="num-xs text-muted" style="max-width:250px;">${L('完成任意一轮 A9 质押入场后，将自动铸造链上 SBT 闯关凭证。', 'Complete any round A9 stake entry to mint your on-chain SBT quest pass.')}</div>
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
              <span class="cert-serial">SBT PASS · R${String(cert.round).padStart(2, '0')}</span>
              <span class="cert-status-pill">${icon('shieldCheck', 11)} ${config.isDemo ? L('演示凭证', 'DEMO') : L('链上验真', 'VERIFIED')}</span>
            </div>
            <div class="cert-body">
              <div class="cert-id-row">
                <div>
                  <div class="cert-id-title">#${escapeHtml(cert.id)}</div>
                  <div class="num-xs text-muted mono" style="margin-top:2px;">${escapeHtml(cert.txHash || 'PENDING')}</div>
                </div>
                <span class="cert-flip-pill">${icon('refresh', 11)} ${L('翻转验真', 'Flip')}</span>
              </div>

              <div class="cert-perf" aria-hidden="true"><span class="cert-perf-line"></span></div>

              <div class="cert-metrics-grid">
                <div class="cert-metric-tile">
                  <small>${L('质押本金', 'Stake')}</small>
                  <strong>${formatNum(cert.stakeTon)}</strong>
                </div>
                <div class="cert-metric-tile">
                  <small>${L('早鸟权重', 'Boost')}</small>
                  <strong class="text-gold">${(Number(cert.multiplier) || 1).toFixed(1)}×</strong>
                </div>
                <div class="cert-metric-tile">
                  <small>${estLabel}</small>
                  <strong class="text-green">${formatNum(cert.estRewardA9)}</strong>
                </div>
              </div>
            </div>
            <div class="cert-foot">
              <span class="num-xs text-muted mono">A9 v16 · ${isSettled ? L('已结算', 'SETTLED') : L('24H 观察中', 'OBSERVING')}</span>
              ${renderMiniBarcode()}
            </div>
          </div>

          <div class="cert-pass cert-face back">
            <div class="cert-top-bar">
              <span class="cert-serial">TVM L1 VERIFICATION</span>
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
        <button class="btn btn-primary" id="btn-flex-cert" style="min-height:46px;font-size:14px;">${icon('qr', 15)} ${L('生成凭证海报', 'Proof Poster')}</button>
        <button class="btn btn-secondary" id="btn-x-proof" style="min-height:46px;font-size:14px;">${icon('xBrand', 14)} ${L('发 X 炫耀凭证', 'Share on X')}</button>
      </div>
      <button class="btn btn-secondary" id="copy-cert-hash" style="min-height:42px;font-size:13px;">${icon('copy', 14)} ${L('复制存证哈希', 'Copy Proof Hash')}</button>

      ${renderCorridorRadar(round.candles || [], round.targetPrice, round.activeCandleSec || 0, round.livePrice, { qualified: round.qualifiedCandles || 0, minQualified: round.minQualifiedCandles || 16, seen: round.candlesSeen || 0 })}

      <div class="card">
        <div class="row-between">
          <div class="settings-row-left">
            <span class="icon-badge sky">${icon('refresh', 16)}</span>
            <div>
              <div class="settings-row-title">${L('本凭证自动连闯', 'Pass Auto-Continue')}</div>
              <div class="settings-row-sub">${L('达标后自动将本金顺延至下一轮', 'Roll principal into next round on win')}</div>
            </div>
          </div>
          <div class="a9-switch ${cert.autoRenew ? 'on' : ''}" id="cert-renew-switch" role="switch" aria-checked="${Boolean(cert.autoRenew)}" tabindex="0"></div>
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
          <button class="btn btn-primary" id="flex-dl-btn" style="min-height:46px;font-size:14px;">${icon('download', 15)} ${L('保存高清 PNG', 'Save PNG')}</button>
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

  const renewSw = root.querySelector('#cert-renew-switch');
  if (renewSw) {
    const toggleCertRenew = () => {
      A9Haptic.tick();
      store.update(s => { const target = s.certificates.find(c => c.id === cert.id); if (target) target.autoRenew = !target.autoRenew; });
      const on = renewSw.classList.toggle('on');
      renewSw.setAttribute('aria-checked', String(on));
      showToast(L('已更新续期设置', 'Rollover updated'));
    };
    renewSw.onclick = toggleCertRenew;
    renewSw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCertRenew(); } };
  }

  bindCorridorRadarEvents(root);
  root.querySelectorAll('[data-x-share="round"]').forEach(btn => {
    btn.onclick = () => openXShareSheet({
      type: 'round',
      id: round.currentRound || 1,
      context: { roundId: round.currentRound, qualified: round.qualifiedCandles, required: round.minQualifiedCandles }
    });
  });
  root.querySelector('#copy-cert-hash').onclick = () => copyText(cert.txHash, L('已复制哈希', 'Copied'));
}

export function renderRenewPage(root) {
  const { user, round, certificates } = store.state;
  const nextRoundNum = round.currentRound ? round.currentRound + 1 : null;
  const nextRoundZh = nextRoundNum ? `第 ${nextRoundNum} 轮` : '下一轮';
  const nextRoundEn = nextRoundNum ? `Round ${nextRoundNum}` : 'Next Round';
  const isOn = Boolean(user.autoRenew);

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <section class="renew-hero-card ${isOn ? 'is-on' : ''}">
        <div class="row-between">
          <div class="settings-row-left">
            <span class="nt-art-badge ${isOn ? 'tone-green' : 'tone-blue'}" style="width:46px;height:46px;border-radius:14px;">
              ${icon('refresh', 22, isOn ? 'text-green' : 'text-cyan')}
            </span>
            <div>
              <div class="row-start" style="gap:6px;">
                <strong style="font-size:16px;font-weight:900;">${L('自动连闯', 'Auto-Continue')}</strong>
                <span class="chip ${isOn ? 'chip-green' : 'chip-muted'}" style="min-height:20px;font-size:10px;">${isOn ? L('已开启', 'ACTIVE') : L('已关闭', 'OFF')}</span>
              </div>
              <div class="num-xs text-sec" style="margin-top:2px;">${L(`达标结算后自动顺延本金至${nextRoundZh}`, `Auto-roll principal into ${nextRoundEn} on win`)}</div>
            </div>
          </div>
          <div class="a9-switch ${isOn ? 'on' : ''}" id="global-renew-sw" role="switch" aria-checked="${isOn}" tabindex="0"></div>
        </div>

        <div class="renew-preview-grid">
          <div class="renew-preview-cell">
            <small>${L('目标轮次', 'Target')}</small>
            <strong>${nextRoundNum ? `R${String(nextRoundNum).padStart(2, '0')}` : L('下轮', 'Next')}</strong>
          </div>
          <div class="renew-preview-cell">
            <small>${L('顺延范围', 'Scope')}</small>
            <strong>${L('仅本金', 'Principal')}</strong>
          </div>
          <div class="renew-preview-cell">
            <small>${L('早鸟权重', 'Weight')}</small>
            <strong class="text-gold">2.0× ${L('优先', 'First')}</strong>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <div class="card-title">${icon('bolt', 15, 'text-gold')} ${L('自动连闯如何生效', 'How Auto-Continue Works')}</div>
        </div>
        <div class="renew-step-list">
          <div class="renew-step-item">
            <span class="renew-step-num">01</span>
            <div class="renew-step-copy">
              <strong>${L('仅在达标胜出时触发', 'Triggers Only on Passing Rounds')}</strong>
              <p>${L('当轮 24H 达标 ≥ 16 段后，系统自动将已结本金无感迁移至下一轮。', 'When a round passes (≥ 16/24 slots), settled principal rolls seamlessly into the next round.')}</p>
            </div>
          </div>
          <div class="renew-step-item">
            <span class="renew-step-num">02</span>
            <div class="renew-step-copy">
              <strong>${L('自动抢占首段 2.0× 早鸟权重', 'Locks 2.0× Early-Bird Weight')}</strong>
              <p>${L('开窗即入场，自动锁定最高早鸟权重份额，无需半夜蹲守手动质押。', 'Enters immediately at open to capture the top 2.0× weight tier without manual timing.')}</p>
            </div>
          </div>
          <div class="renew-step-item">
            <span class="renew-step-num">03</span>
            <div class="renew-step-copy">
              <strong>${L('奖励照常发放 · 随时可关', 'Rewards Separate · Toggle Anytime')}</strong>
              <p>${L('当轮赢取的 A9 奖励照常进入金库可领；新轮开盘前 30 分钟内锁定当次开关。', 'Earned A9 rewards go to your vault as usual; toggle locks 30 mins before next round open.')}</p>
            </div>
          </div>
        </div>
      </section>

      ${config.isDemo && certificates.length > 0 ? `
        <section class="card">
          <div class="card-header">
            <div class="card-title">${icon('shieldCheck', 15, 'text-green')} ${L('当前凭证续期状态', 'Active Pass Rollover')}</div>
            <span class="chip chip-muted mono">${certificates.length}</span>
          </div>
          <div class="col-gap" style="gap:8px;">
            ${certificates.map((c) => `
              <div class="list-row clickable" data-nav="/proof/${c.id}">
                <div>
                  <div class="num-sm" style="font-weight:800;">#${c.id} · ${L('第', 'R')}${c.round}${L('轮', '')}</div>
                  <div class="num-xs text-muted">${formatNum(c.stakeTon)} A9</div>
                </div>
                <span class="chip ${c.autoRenew ? 'chip-green' : 'chip-muted'}">${c.autoRenew ? L('已启用连闯', 'Auto ON') : L('手动结算', 'Manual')}</span>
              </div>
            `).join('')}
          </div>
        </section>
      ` : ''}

      <div class="grid-2">
        <button class="btn btn-secondary" data-nav="/round" type="button">${icon('radar', 14)} ${L('查看闯关进度', 'View Quest')}</button>
        <button class="btn btn-secondary" data-nav="/profile" type="button">${icon('arrowLeft', 14)} ${L('返回我的', 'Back to Me')}</button>
      </div>
    </div>
  `;

  const sw = root.querySelector('#global-renew-sw');
  if (sw) {
    const toggle = () => {
      A9Haptic.tick();
      A9Audio.tick();
      store.update(s => { s.user.autoRenew = !s.user.autoRenew; });
      showToast(store.state.user.autoRenew ? L('已开启自动连闯', 'Auto-Continue enabled') : L('已关闭自动连闯', 'Auto-Continue disabled'));
      renderRenewPage(root);
    };
    sw.onclick = toggle;
    sw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  }
}

export function renderLedgerPage(root) {
  if (!config.isDemo) {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <section class="card card-hero empty-state">
          <span class="nt-art-badge tone-green" aria-hidden="true">${icon('receipt', 24, 'text-green')}</span>
          <div style="font-size:16px;font-weight:900;margin-top:4px;">${L('收益账本等待链上核验', 'Ledger Awaits Verification')}</div>
          <p class="num-xs text-sec" style="margin:0;max-width:260px;">${L('真实模式下不展示演示流水；请返回「我的」连接钱包核验链上余额与质押凭证。', 'Live mode never displays demo entries. Return to Me to verify wallet balances and passes.')}</p>
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
            <div class="row-between" style="margin-bottom:4px;">
              <span class="num-xs text-muted">${L('累计质押本金', 'Total Staked Principal')}</span>
              <span class="chip chip-muted mono">${history.length} ${L('轮', 'rounds')}</span>
            </div>
            <div class="num-hero">${formatNum(totalStaked)} <span class="num-md text-green">A9</span></div>
            <div class="ledger-kpi-strip">
              <div class="ledger-kpi-box">
                <small>${L('已结算', 'Settled')}</small>
                <strong class="text-green">${settledCnt}</strong>
              </div>
              <div class="ledger-kpi-box">
                <small>${L('观察中', 'Observing')}</small>
                <strong class="text-cyan">${obsCnt}</strong>
              </div>
              <div class="ledger-kpi-box">
                <small>${L('最高权重', 'Max Boost')}</small>
                <strong class="text-gold">${history.length ? Math.max(...history.map(h => Number(h.multiplier) || 1)).toFixed(1) + '×' : '—'}</strong>
              </div>
            </div>
          </section>

          <div class="col-gap" style="gap:9px;">
            ${history.length === 0
              ? `<div class="card empty-state"><div class="num-xs text-muted">${L('暂无闯关战绩', 'No history')}</div></div>`
              : history.map(h => `
                <article class="record-pass-card ${h.status === 'settled' ? 'is-settled' : ''}" data-nav="/proof/${h.id}">
                  <div class="row-between">
                    <div class="row-start" style="gap:7px;">
                      <span class="chip chip-muted mono">R${String(h.round).padStart(2, '0')}</span>
                      <strong style="font-size:14px;">#${h.id}</strong>
                    </div>
                    <span class="chip ${h.status === 'settled' ? 'chip-green' : 'chip-blue'}">${h.status === 'settled' ? L('已结算', 'Settled') : L('观察中', 'Observing')}</span>
                  </div>
                  <div class="record-pass-metrics">
                    <div>
                      <div class="num-xs text-muted">${L('质押本金', 'Principal')}</div>
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
          <div class="row-between" style="margin-bottom:4px;">
            <span class="num-xs text-muted">${L('累计记录收益', 'Cumulative Ledger Total')}</span>
            <span class="chip chip-green mono">${rowsAll.length} ${L('笔', 'entries')}</span>
          </div>
          <div class="num-hero text-green">+${formatNum(totalEarned)} <span class="num-md text-green">A9</span></div>
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
          <p class="num-xs text-sec" style="margin:0;max-width:260px;">${L('真实模式下请连接钱包在「我的」核验链上质押凭证。', 'Connect your wallet in Me to verify on-chain passes.')}</p>
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
          <div class="row-between" style="margin-bottom:4px;">
            <span class="num-xs text-muted">${L('累计质押本金', 'Total Staked')}</span>
            <span class="chip chip-muted mono">${history.length} ${L('轮', 'rounds')}</span>
          </div>
          <div class="num-hero">${formatNum(totalStaked)} <span class="num-md text-green">A9</span></div>
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
                  <span class="chip ${h.status === 'settled' ? 'chip-green' : 'chip-blue'}">${h.status === 'settled' ? L('已结算', 'Settled') : L('观察中', 'Observing')}</span>
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
