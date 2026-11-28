/**
 * 我的 / 资产 / 结算 / 凭证 / 账本 / 记录页（5e 极简重构）
 * - 我的主页：资产主卡 + 唯一领取主按钮 + 一张 4 项列表卡（记录 / 规则与透明 / 设置 / 语言与主题），首屏 ≤ 4 块、全页 ≤ 8 块
 * - /proof 凭证详情：清除跨界 12H 冲价雷达盘，改为 1 行指向 #/round 的轻链接，清除全部 StakeTicket 工程词
 * - 严格遵循 Demo / Live 模式隔离，绝不把 null 当 0，也不混用演示与真实只读数据
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast, copyText, openModal, closeModal, openChoiceSheet, openActionSheet } from '../components.js';
import { renderNintendoGateIcon } from '../paper-art.js';
import { renderProofFlexPoster, renderStoryPoster, downloadPosterPng } from '../poster.js';
import { openXShareSheet, triggerStoryShare } from '../share.js';
import { icon } from '../icons.js';
import { L, LANGUAGES } from '../i18n.js';
import { tonConnect } from '../tonconnect.js';
import { fetchUserPortfolio, fetchPromoBalance, fetchPredictionUser, fetchPresaleOrders, fetchMyStakeReferrals, getEffectiveUserId, formatRoundA9, parseA9InputToRaw, rawToA9, serverNowMs } from '../data.js';
import { deriveRoundUiState, deriveTicketRoundStatusLabel } from '../round-state.js';
import { renderMyRewardsPage } from './rewards.js';
import { buildTonviewerUrl } from '../tx-ux.js';

function renderMiniBarcode() {
  const bars = [2, 1, 3, 1, 2, 2, 1, 3, 1, 2];
  return `<span class="receipt-barcode" aria-hidden="true">${bars.map((w) => `<i style="width:${w}px;"></i>`).join('')}</span>`;
}

function parseA9Number(str) {
  const m = String(str || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

let profileRenderSeq = 0;

function formatA9Amount(val) {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) {
    return '—';
  }
  return `${Number(val).toLocaleString('en-US', { maximumFractionDigits: 9 })} A9`;
}

function walletAmountRaw(value) {
  return /^\d+$/.test(String(value)) ? BigInt(value) : null;
}

function demoWalletAmountRaw(value) {
  return value == null ? null : parseA9InputToRaw(Number(value).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 9 }));
}

function getActiveThemeMode() {
  if (store.state.settings.themeMode === 'dark') return 'dark';
  if (typeof document !== 'undefined' && document.documentElement?.dataset?.theme === 'dark') return 'dark';
  return 'light';
}

function renderProfileSwitchView({
  hasWallet = false,
  availableRaw = null,
  gramBalance = null,
  roundClaimableRaw = null,
  promoClaimableRaw = null,
  roundLockedRaw = null,
  predPendingRaw = null,
  certsCount = null,
  loading = false,
  claimError = false,
  predError = false,
  isLive = false,
} = {}) {
  const gramText = (gramBalance !== null && gramBalance !== undefined && Number.isFinite(Number(gramBalance)))
    ? `${Number(gramBalance).toLocaleString('en-US', { maximumFractionDigits: 9 })} GRAM`
    : '—';

  const isReadOnlyLive = isLive && !store.fundsEnabled;
  const assetBadge = !hasWallet
    ? `<span class="chip chip-amber">${L('未连接', 'Unlinked')}</span>`
    : loading
      ? `<span class="chip chip-muted">${L('读取中', 'Syncing')}</span>`
      : isReadOnlyLive
        ? `<span class="chip chip-muted">${L('只读', 'Read-Only')}</span>`
        : '';

  const assetMainHtml = !hasWallet
    ? `<div class="sw-asset-main text-muted" style="font-size:20px;">${L('未连接钱包', 'Wallet Not Connected')}</div>`
    : availableRaw !== null
      ? `<div class="sw-asset-main">${formatRoundA9(availableRaw).slice(0, -3)} <span class="sw-asset-main-unit">A9</span></div>`
      : `<div class="sw-asset-main">${loading ? '…' : '—'}</div>`;

  // 严格防假 0：仅当两项可领均已确认时合计；未连钱包或任一项缺失一律显示 — / …
  const totalClaimableRaw = hasWallet && !loading && !claimError && roundClaimableRaw !== null && promoClaimableRaw !== null
    ? roundClaimableRaw + promoClaimableRaw
    : null;

  const amountDisplay = (raw) => raw === null && loading ? '…' : formatRoundA9(raw);
  const claimableDisplay = hasWallet ? amountDisplay(totalClaimableRaw) : '—';
  const lockedDisplay = hasWallet ? amountDisplay(roundLockedRaw) : '—';
  const pendingDisplay = amountDisplay(predPendingRaw);

  const curLangObj = LANGUAGES.find((l) => l.code === store.state.settings.language) || LANGUAGES[0];
  const curThemeLabel = getActiveThemeMode() === 'dark' ? L('暗夜', 'Dark') : L('亮色', 'Light');
  const langShortLabel = curLangObj.code === 'zh-CN' ? '中文' : 'EN';
  const recordsBadge = (certsCount !== null && certsCount !== undefined && Number.isFinite(Number(certsCount)))
    ? L(`${formatNum(certsCount)} 张凭证`, `${formatNum(certsCount)} passes`)
    : '';

  const primaryCtaHtml = !hasWallet
    ? `<button type="button" class="btn btn-primary" id="profile-asset-connect">${icon('wallet', 15)} ${L('连接钱包', 'Connect Wallet')}</button>`
    : `<a class="btn btn-primary" id="profile-claim-cta" href="#/rewards">${icon('trophy', 15)} ${L('查看奖励', 'View rewards')} ›</a>`;

  return `
    <div class="col-gap anim-page-enter" id="profile-home-root">
      <section class="sw-asset-card" id="profile-asset-card">
        <span class="sw-asset-accent" aria-hidden="true"></span>
        <div class="sw-asset-body" style="gap:10px;">
          <div class="row-between" style="gap:8px;">
            <span class="sw-section-label profile-asset-label">${L('可用 A9 余额', 'Available A9')}</span>
            ${assetBadge}
          </div>
          ${assetMainHtml}
          <div class="num-xs text-muted mono profile-gas-balance">${L('钱包 Gas 余额', 'Wallet gas')} <b>${escapeHtml(gramText)}</b></div>
          <div class="check-list profile-asset-details">
            <div class="check-row">
              <span class="text-sec">${L('可领取奖励', 'Claimable Rewards')}</span>
              <b class="mono ${totalClaimableRaw > 0n ? 'text-green' : 'text-sec'}">${claimableDisplay}</b>
            </div>
            <div class="check-row">
              <span class="text-sec">${L('待激活奖励', 'Pending Activation')}</span>
              <span class="mono ${predPendingRaw > 0n ? 'text-gold' : 'text-sec'}">${pendingDisplay}</span>
            </div>
            <div class="check-row">
              <span class="text-sec">${L('解锁中（14 天）', 'Unlocking (14D)')}</span>
              <span class="mono">${lockedDisplay}</span>
            </div>
          </div>
          ${claimError || predError ? `
            <div class="row-between num-xs text-red" role="alert">
              <span>${L('部分资产数据读取失败', 'Some asset data failed to load')}</span>
              <button type="button" class="sw-retry-link" data-profile-retry="1">${L('重试', 'Retry')}</button>
            </div>
          ` : ''}
          ${primaryCtaHtml}
        </div>
      </section>

      <div class="sw-menu-group" id="profile-main-menu">
        <a class="sw-menu-row" href="#/records">
          <span class="sw-row-icon is-red" aria-hidden="true">${icon('receipt', 16)}</span>
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('记录', 'Records')}</span>
            <span class="sw-menu-sub">${L('闯关凭证、宝箱小票与收支账本', 'Quest passes, chest receipts & ledger')}</span>
          </div>
          <div class="sw-menu-right">
            ${recordsBadge ? `<span class="sw-menu-amount is-muted" style="white-space:nowrap;">${escapeHtml(recordsBadge)}</span>` : ''}
            <span class="sw-menu-arrow" aria-hidden="true">›</span>
          </div>
        </a>
        <a class="sw-menu-row" href="#/rules">
          <span class="sw-row-icon is-green" aria-hidden="true">${icon('book', 16)}</span>
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('规则与透明', 'Rules & Transparency')}</span>
            <span class="sw-menu-sub">${L('规则说明、费用明细与合约地址', 'Rules, fees & contract addresses')}</span>
          </div>
          <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
        </a>
        <a class="sw-menu-row" href="#/settings">
          <span class="sw-row-icon is-muted" aria-hidden="true">${icon('settings', 16)}</span>
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('设置', 'Settings')}</span>
            <span class="sw-menu-sub">${L('通知提醒、音效、震动与钱包管理', 'Alerts, audio, haptics & wallet')}</span>
          </div>
          <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
        </a>
        <button type="button" class="sw-menu-row" id="profile-lang-theme-row">
          <span class="sw-row-icon is-blue" aria-hidden="true">${icon('globe', 16)}</span>
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('语言与主题', 'Language & Theme')}</span>
          </div>
          <div class="sw-menu-right">
            <span class="sw-menu-amount" style="white-space:nowrap;">${escapeHtml(`${langShortLabel} · ${curThemeLabel}`)}</span>
            <span class="sw-menu-arrow" aria-hidden="true">›</span>
          </div>
        </button>
      </div>
    </div>
  `;
}

function bindProfileLangThemeAction(root, navigate) {
  const row = root.querySelector('#profile-lang-theme-row');
  if (!row) return;
  row.onclick = () => {
    const curTheme = getActiveThemeMode();
    const curLangObj = LANGUAGES.find((l) => l.code === store.state.settings.language) || LANGUAGES[0];
    openActionSheet({
      title: L('语言与主题', 'Language & Theme'),
      subtitle: L('即时生效并保存在本地偏好', 'Applies immediately to local preferences'),
      items: [
        {
          icon: curTheme === 'dark' ? 'moon' : 'sun',
          tone: 'is-amber',
          label: L('切换主题', 'Theme'),
          sub: L('雪白亮色 / 石墨暗夜', 'Crisp Light / Switch Dark'),
          badge: curTheme === 'dark' ? L('石墨暗夜', 'Dark') : L('雪白亮色', 'Light'),
          keepOpen: true,
          onSelect: () => openChoiceSheet({
            title: L('选择界面主题', 'Select Theme'),
            selected: getActiveThemeMode(),
            options: [
              { value: 'light', icon: 'sun', tone: 'is-amber', label: L('雪白亮色', 'Crisp Light'), sub: L('任天堂红白日间配色', 'Nintendo light theme') },
              { value: 'dark', icon: 'moon', tone: 'is-blue', label: L('石墨暗夜', 'Switch Dark'), sub: L('OLED 深石墨夜间配色', 'Switch OLED dark theme') },
            ],
            onSelect: (mode) => {
              if (mode === getActiveThemeMode()) return;
              store.update((s) => { s.settings.themeMode = mode; });
              if (typeof document !== 'undefined' && document.documentElement) {
                document.documentElement.dataset.theme = mode;
              }
              import('../app.js').then((m) => {
                m.applyTheme?.(mode);
                m.renderCurrentRoute?.();
              }).catch(() => renderProfileHome(root, navigate));
              showToast(mode === 'dark' ? L('已切换石墨暗夜主题', 'Switched to Switch Dark') : L('已切换雪白亮色主题', 'Switched to Crisp Light'));
            },
          }),
        },
        {
          icon: 'globe',
          tone: 'is-blue',
          label: L('切换语言', 'Language'),
          sub: L('实时切换中英文', 'Switch Chinese / English'),
          badge: curLangObj.label,
          keepOpen: true,
          onSelect: () => openChoiceSheet({
            title: L('选择界面语言', 'Select Language'),
            selected: store.state.settings.language,
            options: LANGUAGES.map((l) => ({ value: l.code, icon: 'globe', tone: 'is-blue', label: l.label, sub: l.sub })),
            onSelect: (code) => {
              store.update((s) => { s.settings.language = code; });
              showToast(`${L('已切换语言', 'Language')}: ${code}`);
              import('../app.js').then((m) => m.renderCurrentRoute?.()).catch(() => renderProfileHome(root, navigate));
            },
          }),
        },
      ],
    });
  };
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
      bindProfileLangThemeAction(root, navigate);
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

        const availableRaw = portData?.balanceAvailable !== false ? walletAmountRaw(portData?.a9BalanceRaw) : null;
        const tickets = Array.isArray(portData?.tickets) ? portData.tickets : [];

        paintLive({
          availableRaw,
          roundClaimableRaw: walletAmountRaw(portData?.claimableRaw),
          promoClaimableRaw: walletAmountRaw(promoData?.claimableRaw),
          roundLockedRaw: walletAmountRaw(portData?.lockedRaw),
          predPendingRaw: walletAmountRaw(predData?.pendingActivationRaw),
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

  root.innerHTML = renderProfileSwitchView({
    hasWallet: Boolean(user.connected),
    availableRaw: isEmpty ? 0n : demoWalletAmountRaw(user.a9Available),
    gramBalance: isEmpty ? 0 : user.tonBalance,
    roundClaimableRaw: isEmpty ? 0n : demoWalletAmountRaw(user.a9Claimable ?? 0),
    promoClaimableRaw: isEmpty ? 0n : demoWalletAmountRaw(user.promoClaimableA9 ?? 0),
    roundLockedRaw: isEmpty ? 0n : demoWalletAmountRaw(user.a9Locked ?? 0),
    predPendingRaw: isEmpty ? 0n : (walletAmountRaw(store.state.prediction?.pendingActivationRaw) ?? 0n),
    certsCount: isEmpty ? 0 : (certificates || []).length,
    loading: false,
    claimError: false,
    predError: false,
    isLive: false,
  });

  const connBtn = root.querySelector('#profile-asset-connect');
  if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderProfileHome(root, navigate));
  bindProfileLangThemeAction(root, navigate);
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
    root.innerHTML = `<section class="card col-gap"><strong>${L('找不到该凭证', 'Ticket not found')}</strong><a class="btn btn-secondary" href="#/records?type=round">${L('返回凭证列表', 'Back to tickets')}</a></section>`;
    return;
  }
  if (!config.isDemo) {
    const seq = ++proofRenderSeq;
    const addr = store.state.user.address || null;

    const paintLive = ({ loading = false, error = false, data = null } = {}) => {
      if (seq !== proofRenderSeq || !root.isConnected) return;
      const tickets = (data?.tickets || []).filter(ticket => !certId || ticket.ticketAddress === certId);
      if (certId && data?.ticketsAvailable && tickets.length === 0) {
        root.innerHTML = `<section class="card col-gap"><strong>${L('找不到该凭证', 'Ticket not found')}</strong><a class="btn btn-secondary" href="#/records?type=round">${L('返回凭证列表', 'Back to tickets')}</a></section>`;
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
                ? L(`已扫描第 ${range.fromRound} 至第 ${range.toRound} 轮链上闯关凭证，点击任意凭证查看领奖与解锁详情。`, `Scanned Rounds ${range.fromRound}–${range.toRound} Quest Passes. Tap any pass to view claim & unlock details.`)
                : L('连接 TON 钱包即可读取链上闯关凭证，点击直达我的奖励页查看详情。', 'Connect TON wallet to load on-chain Quest Passes and jump directly to My Rewards.')}
            </div>
          </section>

          ${!addr ? `
            <section class="card empty-state">
              <span class="nt-art-badge tone-red" aria-hidden="true">${renderNintendoGateIcon('ticket', 34)}</span>
              <div style="font-weight:900;font-size:15px;margin-top:4px;">${L('请先连接钱包', 'Connect Wallet First')}</div>
              <div class="num-xs text-sec" style="max-width:250px;">${L('连接非托管 TON 钱包后即可查看各轮闯关凭证与解锁状态。', 'Connect your non-custodial TON wallet to view Quest Passes.')}</div>
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
              <div class="num-xs text-sec" style="max-width:250px;">${L('完成任意一轮 A9 锁仓入场后，链上将自动铸造闯关凭证。', 'Lock A9 in any round to mint an on-chain Quest Pass.')}</div>
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
            <a class="sw-menu-row" id="proof-round-progress-link" href="#/round">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('查看当前轮次进度', 'View Current Quest Progress')}</span></div>
              <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
            </a>
            <a class="sw-menu-row" href="#/rewards">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('前往我的奖励', 'Go to My Rewards')}</span></div>
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

      <div class="sw-menu-group">
        <a class="sw-menu-row" id="proof-round-progress-link" href="#/round">
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('查看本轮 12H 冲价进度', 'View 12H Push Progress')}</span>
            <span class="sw-menu-sub">${L('前往闯关页查看 12 格达标板与当前阶段', 'Inspect 12-slot qualification board on Quest page')}</span>
          </div>
          <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
        </a>
        <a class="sw-menu-row" href="#/rewards">
          <div class="sw-menu-left">
            <span class="sw-menu-title">${L('前往我的奖励', 'Go to My Rewards')}</span>
            <span class="sw-menu-sub">${L('领取已解锁奖金或查看 14 天解锁', 'Claim rewards or inspect 14D unlock')}</span>
          </div>
          <div class="sw-menu-right"><span class="sw-menu-arrow" aria-hidden="true">›</span></div>
        </a>
        <a class="sw-menu-row" href="#/settings">
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
      const completedOrdersA9 = ordersErr ? null : orders.reduce((s, o) => s + (o.status === 'COMPLETED' ? (rawToA9(o.totalA9Raw ?? o.a9AmountRaw) || 0) : 0), 0);
      const refTotalA9 = refs && refs.totalCommissionRaw !== undefined && refs.totalCommissionRaw !== null ? rawToA9(refs.totalCommissionRaw) : null;

      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <section class="card card-hero col-gap">
            <div class="row-between">
              <span class="card-title">${icon('receipt', 15, 'text-green')} ${L('链上收支账本', 'On-Chain Ledger')}</span>
              ${tonviewerHref ? `<button type="button" class="text-link-btn" id="btn-ledger-tonviewer">Tonviewer ›</button>` : ''}
            </div>
            <div class="check-list">
              <div class="check-row">
                <div style="min-width:0;">
                  <div class="num-xs" style="font-weight:700;">${L('商城订单已入账', 'Mall Orders Credited')}</div>
                  <div class="num-xs text-muted">${addr ? (ordersErr ? L('读取失败', 'Read failed') : L(`共 ${orders.length} 笔订单`, `${orders.length} order(s)`)) : L('连接钱包后查看', 'Connect wallet to view')}</div>
                </div>
                <b class="mono ${Number(completedOrdersA9) > 0 ? 'text-green' : ''}" style="white-space:nowrap;">${addr ? (loading ? '…' : formatA9Amount(completedOrdersA9)) : '—'}</b>
              </div>
              <div class="check-row">
                <div style="min-width:0;">
                  <div class="num-xs" style="font-weight:700;">${L('好友通关 8% 返佣', '8% Pass Referral Credits')}</div>
                  <div class="num-xs text-muted">${hasTg ? (refsErr ? L('读取失败', 'Read failed') : L(`共 ${refItems.length} 笔返佣`, `${refItems.length} credit(s)`)) : L('在 Telegram 内打开查看', 'Open in Telegram to view')}</div>
                </div>
                <b class="mono ${Number(refTotalA9) > 0 ? 'text-green' : 'text-muted'}" style="white-space:nowrap;">${hasTg ? (loading ? '…' : formatA9Amount(refTotalA9)) : '—'}</b>
              </div>
            </div>
            ${!addr ? `<button class="btn btn-primary btn-sm" id="btn-ledger-connect" type="button">${icon('wallet', 14)} ${L('连接钱包同步账本', 'Connect Wallet to Sync')}</button>` : ''}
          </section>

          <div>
            <div class="row-between" style="margin-bottom:6px;padding:0 2px;">
              <span class="sw-section-label" style="margin:0;padding:0;">${L('商城购箱订单', 'Chest Mall Orders')}</span>
              <a class="text-link-btn" href="#/records?type=market">${L('全部小票', 'All Receipts')} ›</a>
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

let recordsRenderSeq = 0;

export function renderRecordsPage(root, navigate, _param = null, query = {}) {
  const rawType = String(query?.type || 'round').toLowerCase();
  const activeType = (rawType === 'ledger' || rawType === 'market') ? rawType : 'round';

  const renderTabsHeader = () => `
    <div class="seg-tabs" id="records-type-tabs" style="margin-bottom:10px;">
      <button class="seg-tab ${activeType === 'round' ? 'active' : ''}" data-rec-type="round" type="button">${L('冲关记录', 'Quest')}</button>
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
    const seq = ++recordsRenderSeq;
    const addr = store.state.user.address || null;
    const paintLiveRecords = ({ loading = false, error = false, tickets = [] } = {}) => {
      if (seq !== recordsRenderSeq || !root.isConnected) return;
      root.innerHTML = `
        <div class="col-gap anim-page-enter" id="live-records-round-view">
          ${renderTabsHeader()}
          ${!addr ? `
            <section class="card empty-state">
              <span class="nt-art-badge tone-red" aria-hidden="true">${renderNintendoGateIcon('ticket', 32)}</span>
              <div style="font-size:15px;font-weight:900;margin-top:4px;">${L('连接钱包查看冲关记录', 'Connect Wallet for Quest Records')}</div>
              <p class="num-xs text-sec" style="margin:0;max-width:260px;">${L('连接非托管 TON 钱包后即可直接查看你的各轮锁仓票据与结算状态。', 'Connect your TON wallet to load your round tickets and settlement history.')}</p>
              <button class="btn btn-primary btn-sm" id="btn-rec-live-connect" style="margin-top:10px;" type="button">${icon('wallet', 14)} ${L('连接钱包', 'Connect Wallet')}</button>
            </section>
          ` : loading ? `
            <div class="sw-menu-group">
              <div class="sw-menu-row is-static"><div class="sw-menu-left"><span class="sw-menu-title text-muted">${L('正在读取链上冲关票据…', 'Loading on-chain quest tickets…')}</span></div></div>
            </div>
          ` : error ? `
            <div class="sw-menu-group">
              <div class="sw-menu-error" role="alert">
                <span>${L('读取冲关记录失败', 'Failed to load quest records')}</span>
                <button type="button" class="sw-retry-link" id="btn-rec-live-retry">${L('重试', 'Retry')}</button>
              </div>
            </div>
          ` : tickets.length === 0 ? `
            <section class="card empty-state">
              <span class="nt-art-badge tone-red" aria-hidden="true">${renderNintendoGateIcon('ticket', 32)}</span>
              <div style="font-size:15px;font-weight:900;margin-top:4px;">${L('暂无冲关记录', 'No Quest Records Yet')}</div>
              <p class="num-xs text-sec" style="margin:0;max-width:260px;">${L('参与任意一轮 A9 锁仓后，票据记录会直接展示在这里。', 'Lock A9 in any round and your tickets will appear directly here.')}</p>
              <a class="btn btn-primary btn-sm" style="margin-top:10px;" href="#/round">${icon('bolt', 14)} ${L('前往冲关', 'Go to Quest')}</a>
            </section>
          ` : `
            <div class="sw-menu-group" id="live-records-ticket-list">
              ${tickets.map((t) => {
                const amtA9 = rawToA9(t.amountRaw);
                const statusTxt = liveTicketStatusText(t);
                const href = t.ticketAddress ? `#/rewards?ticket=${encodeURIComponent(t.ticketAddress)}` : '#/rewards';
                return `
                  <a class="sw-menu-row" href="${href}" data-record-ticket="${escapeHtml(t.ticketAddress || '')}">
                    <div class="sw-menu-left">
                      <span class="sw-menu-title">${L(`第 ${escapeHtml(String(t.roundId ?? '—'))} 关`, `Stage ${escapeHtml(String(t.roundId ?? '—'))}`)} · ${escapeHtml(statusTxt)}</span>
                      <span class="sw-menu-sub mono">${t.ticketAddress ? escapeHtml(t.ticketAddress.slice(0, 12) + '…') : '—'}</span>
                    </div>
                    <div class="sw-menu-right">
                      <span class="sw-menu-amount ${t.canClaim ? 'is-green' : ''}">${formatA9Amount(amtA9)}</span>
                      <span class="sw-menu-arrow" aria-hidden="true">›</span>
                    </div>
                  </a>
                `;
              }).join('')}
            </div>
          `}
          <div class="sw-menu-group">
            <a class="sw-menu-row" href="#/rewards">
              <div class="sw-menu-left"><span class="sw-menu-title">${L('前往金库', 'Go to Vault')}</span></div>
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
      const connBtn = root.querySelector('#btn-rec-live-connect');
      if (connBtn) connBtn.onclick = () => tonConnect.openConnectModal(() => renderRecordsPage(root, navigate, _param, query));
      const retryBtn = root.querySelector('#btn-rec-live-retry');
      if (retryBtn) retryBtn.onclick = () => renderRecordsPage(root, navigate, _param, query);
    };

    if (!addr) {
      paintLiveRecords({ loading: false });
      return;
    }
    paintLiveRecords({ loading: true });
    fetchUserPortfolio(addr)
      .then((pf) => {
        if (seq !== recordsRenderSeq || !root.isConnected || store.state.user.address !== addr) return;
        const ok = pf?.ticketsAvailable === true;
        paintLiveRecords({ loading: false, error: !ok, tickets: ok && Array.isArray(pf.tickets) ? pf.tickets : [] });
      })
      .catch(() => {
        if (seq !== recordsRenderSeq || !root.isConnected || store.state.user.address !== addr) return;
        paintLiveRecords({ loading: false, error: true });
      });
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
