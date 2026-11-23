import { portfolioPanel, identityStage, bindIdentityStage } from './wealthverse.js';
/**
 * 我的 / 资产 / 结算页
 * 顺序：可领取金额与操作 → 参与中 / 待解锁奖励与下一步 → 凭证 / 海报 / 设置。
 * 金额未知显示明确状态；真实的零值显示为 0，不再用演示数字替代。
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { uiMemory } from '../app.js';
import { demoTxHash } from '../demo-data.js';
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast, copyText, mountSlider, renderCorridorRadar, bindCorridorRadarEvents, animateSlotCounter, launchCoinArc, burstParticles, openChoiceSheet, openModal, closeModal } from '../components.js';
import { renderOrigamiChestSvg } from '../paper-art.js';
import { renderProofFlexPoster, renderStoryPoster, downloadPosterPng } from '../poster.js';
import { openXShareSheet, triggerStoryShare } from '../share.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { tonConnect } from '../tonconnect.js';
import { fetchUserPortfolio, rawToA9 } from '../data.js';

const amountOrDash = (v, suffix = '') => (v === null || v === undefined ? L('未获取', 'Unavailable') : `${formatNum(v)}${suffix}`);

export function renderProfileHome(root, navigate) {
  if (!config.isDemo) {
    const u = store.state.user;
    const addrLabel = u.shortAddress || (u.address ? (u.address.length > 12 ? `${u.address.slice(0, 4)}...${u.address.slice(-4)}` : u.address) : null);
    const walletTag = addrLabel || L('未连接钱包', 'Wallet not connected');
    root.innerHTML = `<div class="col-gap anim-page-enter">${identityStage({ walletTag })}</div>`;
    portfolioPanel(root.firstElementChild);
    return;
  }
  const { user, certificates } = store.state;
  const isEmpty = user.profileMode === 'empty';
  const unknown = !user.connected && !config.isDemo;
  const modePill = `<button class="pill-trigger neutral" id="btn-profile-mode" type="button">${isEmpty ? L('空态', 'Empty') : L('持仓', 'Vault')} ${icon('chevronDown', 12)}</button>`;
  const walletTag = user.tonBalance === null
    ? (user.shortAddress || L('未连接钱包', 'Wallet not connected'))
    : `${formatNum(user.tonBalance, 2)} GRAM · ${user.shortAddress || 'DEMO'}`;

  if (isEmpty && !unknown) {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        ${identityStage({ modePill, walletTag })}
        <div class="card card-hero">
          <div class="empty-state" style="padding:12px 8px 6px;">
            <img src="./assets/paper-craft/vault.png" alt="" style="width:64px;height:64px;filter:var(--paper-cut-shadow);">
            <div style="font-size:17px;font-weight:800;margin-top:4px;">${L('还没有持仓与收益', 'No Active Position Yet')}</div>
            <div class="text-sec" style="font-size:12px;max-width:260px;">${L('最低 10 GRAM 即可参与，达标后按权重瓜分本轮奖励。', 'Join from 10 GRAM; rewards are shared by weight if the round passes.')}</div>
            <button class="btn btn-primary" style="margin-top:10px;" data-nav="/challenge/confirm">${icon('bolt', 16)} ${L('立即参与', 'Stake Now')}</button>
            <button class="btn btn-secondary" data-nav="/internal/market">${icon('swap', 15)} ${L('A9 兑换屋兑换', 'A9 Exchange')}</button>
          </div>
        </div>
        <div class="grid-2">
          <button class="cmd-tile" data-nav="/team/invite"><span class="icon-badge amber">${icon('qr', 15)}</span><span>${L('邀友赢奖', 'Invite & Earn')}</span></button>
          <button class="cmd-tile" data-nav="/settings"><span class="icon-badge">${icon('settings', 15)}</span><span>${L('偏好设置', 'Settings')}</span></button>
        </div>
      </div>
    `;
  } else {
    const claimable = unknown ? null : (user.a9Claimable || 0);
    const hasClaim = claimable !== null && claimable > 0;
    const activeFilter = ['all', 'observation', 'settled'].includes(uiMemory.ticketFilter) ? uiMemory.ticketFilter : 'all';

    const todoCardHtml = unknown ? `
      <div class="card row-between" style="border-color:var(--gold-border);">
        <div>
          <div class="row-start" style="font-weight:800;">${icon('shieldAlert', 15, 'text-gold')} ${L('未连接钱包 · 数据待核验', 'Wallet not connected')}</div>
          <div class="num-xs text-muted" style="margin-top:3px;">${L('连接后核验可领取奖励、质押中与待解锁资产', 'Connect to verify claimable, staked and locked assets')}</div>
        </div>
        <button class="btn btn-primary btn-sm" id="profile-connect">${L('连接', 'Connect')}</button>
      </div>
    ` : hasClaim ? `
      <div class="card card-hero vault-claim">
        <div class="row-between" style="margin-bottom:6px;">
          <span class="chip chip-gold">${L('待处理 · 可领取', 'Action · Claimable')}</span>
          <a class="text-link-btn" href="#/rewards">${L('解锁档位', 'Vesting')} ›</a>
        </div>
        <div class="num-hero"><span id="a9-claim-num">${formatNum(claimable)}</span> <span class="num-md text-green">A9</span></div>
        <div class="num-xs text-muted" style="margin:4px 0 10px;">
          ${config.isDemo ? L('演示领取 · 实际已结算金额', 'Demo claim · settled amount') : L('真实模式只读 · 签名领取暂未开放', 'Live read-only · claim signing disabled')}
        </div>
        ${store.fundsEnabled
          ? `<div id="profile-quick-slider"></div>`
          : `<div class="sub-tile row-between"><span class="num-xs text-sec">${L('真实模式只读 · 暂未开放领取签名', 'Live read-only · claiming disabled')}</span><button class="btn btn-secondary btn-sm" data-nav="/claim">${L('明细', 'View')}</button></div>`}
        <div class="row-between num-xs text-sec" style="margin-top:10px;padding-top:8px;border-top:1px dashed var(--card-border);">
          <span>${L('待解锁份额', 'Locked Vesting')}</span>
          <b class="mono" style="color:var(--ink);">${formatNum(user.a9Locked)} A9</b>
        </div>
      </div>
    ` : `
      <div class="card">
        <div class="card-header" style="margin-bottom:4px;">
          <div class="card-title">${icon('wallet', 15, 'text-gold')} ${L('资产概览', 'Asset Summary')}</div>
          <a class="text-link-btn" href="#/rewards">${L('解锁档位', 'Vesting')} ›</a>
        </div>
        <div class="list-row"><span class="text-sec">${L('当前可领取', 'Claimable now')}</span><b class="mono">0 A9</b></div>
        <div class="list-row"><span class="text-sec">${L('待解锁份额', 'Locked vesting')}</span><b class="mono">${formatNum(user.a9Locked)} A9</b></div>
      </div>
    `;

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        ${identityStage({ modePill, walletTag })}

        ${todoCardHtml}

        <div class="card">
          <div class="card-header"><div class="card-title">${icon('shieldCheck', 16, 'text-green')} ${L('凭证收藏册', 'Ticket Collection')}</div><span class="chip chip-muted">${certificates.length}</span></div>
          <nav class="ticket-tabs" id="ticket-filter-tabs" aria-label="${L('筛选凭证', 'Filter tickets')}">${[['all', L('全部', 'All')], ['observation', L('观察中', 'Observing')], ['settled', L('已结算', 'Settled')]].map(([value, label]) => `<button type="button" data-ticket-filter="${value}" aria-pressed="${value === activeFilter}">${label}</button>`).join('')}</nav>
          <p class="ticket-empty" hidden>${L('该状态下暂无闯关凭证', 'No quest passes in this state')}</p>
          ${certificates.length === 0
            ? `<div class="empty-state" style="padding:14px;"><div class="num-xs text-muted">${L('暂无进行中的闯关凭证', 'No active quest passes')}</div><button class="btn btn-primary btn-sm" style="margin-top:8px;" data-nav="/round">${L('前往轮次闯关', 'Go to Quest')}</button></div>`
            : certificates.map(c => `
              <div class="list-row clickable collectible-ticket" data-ticket-state="${c.status}" data-nav="/proof/${c.id}" ${activeFilter !== 'all' && c.status !== activeFilter ? 'hidden' : ''}><img src="./assets/paper-craft/ticket.png" alt="">
                <div>
                  <div class="num-sm">#${c.id}</div>
                  <div class="num-xs text-muted">${L('第', 'R')}${c.round}${L('轮', '')} · ${formatNum(c.stakeTon)} GRAM</div>
                </div>
                <div style="text-align:right;">
                  <div class="num-xs text-muted">${c.status === 'settled' ? L('已确认奖励', 'Confirmed') : L('预计奖励', 'Est. reward')}</div>
                  <div class="num-sm text-green">${formatNum(c.estRewardA9)} A9</div>
                  <span class="chip ${c.status === 'settled' ? 'chip-green' : 'chip-blue'}" style="height:17px;font-size:9px;">${c.status === 'settled' ? L('已结算', 'Settled') : L('观察中', 'Observing')}</span>
                </div>
              </div>
            `).join('')}
        </div>

        <div class="grid-4">
          <button class="cmd-tile" data-nav="/proof"><span class="icon-badge orange">${icon('shieldCheck', 16)}</span><span>${L('凭证', 'Pass')}</span></button>
          <button class="cmd-tile" data-nav="/ledger"><span class="icon-badge emerald">${icon('receipt', 16)}</span><span>${L('账本', 'Ledger')}</span></button>
          <button class="cmd-tile" data-nav="/renew"><span class="icon-badge sky">${icon('refresh', 16)}</span><span>${L('连闯', 'Auto')}</span></button>
          <button class="cmd-tile" data-nav="/settings"><span class="icon-badge">${icon('settings', 16)}</span><span>${L('设置', 'Settings')}</span></button>
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
      animateSlotCounter(root.querySelector('#a9-claim-num'), claimable, { duration: 420 });
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
    const connectBtn = root.querySelector('#profile-connect');
    if (connectBtn) connectBtn.onclick = () => tonConnect.openConnectModal(() => renderProfileHome(root, navigate));
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
          <div class="num-xs text-sec" style="line-height:1.5;">${L('当前真实模式处于只读验收阶段，凭证领取与钱包签名暂未开放，请等待主网验收完成后开放。', 'Live mode is currently read-only; StakeTicket claim signing will open after mainnet acceptance.')}</div>
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
            <img src="./assets/paper-craft/vault.png" alt="" style="width:68px;height:68px;margin:0 auto 8px;filter:var(--paper-cut-shadow);">
            <div style="font-size:18px;font-weight:900;">${L('折纸宝箱已开启 · 演示入账完成', 'Paper Chest Opened · Demo Claimed')}</div>
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
            <span class="diorama-kicker">ORIGAMI REWARD CHEST</span>
            <div class="claim-chest-wrap" id="claim-chest-wrap">
              ${renderOrigamiChestSvg()}
            </div>
            <div class="claim-chest-hint" id="claim-chest-hint">${L('向右拖动滑块，掀开折纸宝箱收入账户', 'Slide right to lift the paper chest lid')}</div>
            <div class="claim-breakdown-strip">
              <div><small>${L('本批释放', 'Immediate')}</small><strong class="text-green">20%</strong></div>
              <div><small>${L('待解锁余量', 'Locked')}</small><strong>${formatNum(lockedNow)}</strong></div>
              <div><small>${L('演示网络费', 'Demo Fee')}</small><strong>0 GRAM</strong></div>
            </div>
          </section>
          <div id="claim-slider-mount"></div>
        ` : `
          <div class="card empty-state">
            <img src="./assets/paper-craft/vault.png" alt="" style="width:60px;height:60px;filter:var(--paper-cut-shadow);">
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
            else hintEl.textContent = L('向右拖动滑块，掀开折纸宝箱收入账户', 'Slide right to lift the paper chest lid');
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
 * 从 /api/user/:wallet 读取近 24 轮全部 StakeTicket，支持逐张领奖与 pending 防重锁展示。
 */
function renderLiveTicketClaimPage(root) {
  let portfolio = null;
  let loadError = null;
  let claimingAddr = null;
  let claimingRefund = false;

  const parseRawBigInt = (v) => {
    if (v === null || v === undefined || v === '') return 0n;
    try { return BigInt(String(v)); } catch { return 0n; }
  };

  const paint = () => {
    const { user, round } = store.state;
    const tickets = Array.isArray(portfolio?.tickets) ? portfolio.tickets : [];
    const range = portfolio?.ticketRange || null;
    const failedRefundBig = parseRawBigInt(portfolio?.failedRefundRaw);
    const failedRefundA9 = failedRefundBig > 0n ? (rawToA9(portfolio.failedRefundRaw) ?? 0) : 0;
    const roundControllerAddr = round?.protocolConfig?.contracts?.roundController || '';

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

        ${user.connected && failedRefundBig > 0n ? `
          <div class="card" id="live-failed-refund-card" style="border-color:var(--gold-border);">
            <div class="row-between" style="margin-bottom:6px;">
              <strong>${icon('shieldAlert', 14, 'text-gold')} ${L('v16 托管退款待提取', 'v16 Escrowed Refund Available')}</strong>
              <span class="chip chip-gold">${L('可自助拉取', 'CLAIMABLE')}</span>
            </div>
            <div class="row-between num-xs text-sec">
              <span>${L('托管待退本金', 'Escrowed Amount')}</span>
              <b class="mono text-green">${formatNum(failedRefundA9, 2)} A9</b>
            </div>
            <div class="num-xs text-muted" style="margin:6px 0 10px;line-height:1.5;">
              ${L('检测到极端低 Gas 或退回异常导致的合约托管退款，可一键发起 ClaimFailedRefund（附 0.15 GRAM Gas，余量原路退回）。', 'Escrowed low-gas or bounced refund detected on RoundController. Pull it via ClaimFailedRefund (0.15 GRAM gas, excess refunded).')}
            </div>
            <button class="btn btn-primary btn-sm" id="btn-claim-failed-refund" type="button" style="width:100%;" ${claimingRefund || !roundControllerAddr ? 'disabled' : ''}>
              ${icon('wallet', 13)} ${claimingRefund
                ? L('等待钱包签名…', 'Awaiting Signature…')
                : !roundControllerAddr
                  ? L('缺少主合约地址，请刷新配置', 'RoundController Address Missing')
                  : L('一键提取托管退款（附 0.15 GRAM Gas）', 'Claim Escrowed Refund (0.15 GRAM Gas)')}
            </button>
          </div>
        ` : ''}

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
                        <button class="btn ${isPending ? 'btn-secondary' : 'btn-primary'} btn-sm" data-claim-ticket="${escapeHtml(t.ticketAddress)}" type="button" style="width:100%;" ${isPending || isBusy ? 'disabled' : ''}>
                          ${icon(isPending ? 'clock' : 'wallet', 13)} ${isPending
                            ? L('凭证正在链上确认中（防重锁）', 'Claim Pending On-Chain')
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

    const failedRefundBtn = root.querySelector('#btn-claim-failed-refund');
    if (failedRefundBtn) {
      failedRefundBtn.onclick = async () => {
        if (!roundControllerAddr || claimingRefund) return;
        claimingRefund = true;
        paint();
        try {
          await tonConnect.sendV16ClaimFailedRefund(roundControllerAddr);
          A9Haptic.success();
          A9Audio.confirm();
          showToast(L('已提交 v16 托管退款提取交易，请等待链上确认到账', 'v16 escrowed refund claim tx sent, awaiting confirmation'));
          await loadTickets();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('发起托管退款签名失败，请重试', 'Escrowed refund signature failed'), 'error');
        } finally {
          claimingRefund = false;
          if (root.isConnected) paint();
        }
      };
    }

    root.querySelectorAll('[data-claim-ticket]').forEach((btn) => {
      btn.onclick = async () => {
        const ticketAddr = btn.dataset.claimTicket;
        if (!ticketAddr || claimingAddr) return;
        claimingAddr = ticketAddr;
        paint();
        try {
          await tonConnect.sendV15TicketClaim(ticketAddr);
          A9Haptic.success();
          A9Audio.confirm();
          showToast(L('已提交 StakeTicket 领奖交易，请等待链上确认到账', 'StakeTicket claim tx sent, awaiting on-chain confirmation'));
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
        <div class="card empty-state">
          <div class="icon-badge orange" style="width:48px;height:48px;border-radius:14px;">${icon('shieldCheck', 22)}</div>
          <div style="font-weight:700;font-size:15px;margin-top:4px;">${L('暂无闯关凭证', 'No Quest Pass Yet')}</div>
          <div class="num-xs text-muted" style="max-width:240px;">${L('完成任意一轮 GRAM 入场后，将自动铸造链上 SBT 闯关凭证。', 'Complete any round entry to mint your on-chain SBT quest pass.')}</div>
          <button class="btn btn-primary btn-sm" style="margin-top:10px;" data-nav="/challenge/confirm">${icon('bolt', 14)} ${L('立即入场获取凭证', 'Enter to Mint')}</button>
        </div>
        <button class="btn btn-secondary" data-nav="/profile">${icon('arrowLeft', 15)} ${L('返回我的', 'Back to Me')}</button>
      </div>
    `;
    return;
  }
  const round = store.state.round;
  const estLabel = cert.status === 'settled' ? L('实际 A9', 'Actual A9') : L('估算 A9', 'Est. A9');

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="cert-flip-scene" id="cert-flip-scene" role="button" tabindex="0" aria-label="${L('轻点翻转查看链上核验背面', 'Tap to flip for on-chain verification')}">
        <div class="cert-flip-card" id="cert-flip-card">
          <div class="cert-pass cert-detail-card cert-face front">
            <span class="cert-corner tl"></span><span class="cert-corner tr"></span>
            <span class="cert-corner bl"></span><span class="cert-corner br"></span>
            <div class="row-between" style="margin-bottom:12px;">
              <span class="cert-serial">SBT PASS · R0${cert.round}</span>
              <span class="chip ${config.isDemo ? 'chip-amber' : 'chip-green'}">${icon('shieldCheck', 11)} ${config.isDemo ? L('演示凭证', 'DEMO') : L('链上已验真', 'VERIFIED')}</span>
            </div>
            <div class="num-lg">#${cert.id}</div>
            <div class="row-between num-xs text-muted" style="margin-top:4px;">
              <span>${cert.txHash}</span>
              <span>${L('轻点翻转核验', 'Tap to flip')} ${icon('refresh', 11)}</span>
            </div>
            <div class="metric-strip cols-3" style="margin-bottom:0;border-bottom:none;padding-bottom:0;">
              <div class="metric-cell"><span class="num-xs text-muted">${L('本金', 'Stake')}</span><span class="num-md">${formatNum(cert.stakeTon)} GRAM</span></div>
              <div class="metric-cell"><span class="num-xs text-muted">${L('权重', 'Boost')}</span><span class="num-md text-gold">${(Number(cert.multiplier) || 1).toFixed(1)}x</span></div>
              <div class="metric-cell"><span class="num-xs text-muted">${estLabel}</span><span class="num-md text-green">${formatNum(cert.estRewardA9)}</span></div>
            </div>
          </div>
          <div class="cert-pass cert-face back">
            <span class="cert-corner tl"></span><span class="cert-corner tr"></span>
            <span class="cert-corner bl"></span><span class="cert-corner br"></span>
            <div class="row-between">
              <span class="cert-serial">TVM L1 VERIFICATION</span>
              <span class="num-xs text-muted">${L('轻点翻回正面', 'Flip back')} ${icon('refresh', 11)}</span>
            </div>
            <div class="col-gap" style="gap:6px;margin:10px 0;">
              <div class="row-between num-xs"><span class="text-muted">${L('凭证编号', 'Pass ID')}</span><span class="mono">#${cert.id}</span></div>
              <div class="row-between num-xs"><span class="text-muted">${L('链上哈希', 'TX Hash')}</span><span class="mono text-green">${cert.txHash || 'PENDING'}</span></div>
              <div class="row-between num-xs"><span class="text-muted">${L('持有地址', 'Holder')}</span><span class="mono">${store.state.user.shortAddress || '—'}</span></div>
              <div class="row-between num-xs"><span class="text-muted">${L('铸造时间', 'Minted')}</span><span class="mono">${cert.timestamp || '—'}</span></div>
            </div>
            <div class="num-xs text-muted">${L('TVM 非托管链上存证 · 不可篡改', 'Non-custodial TVM on-chain proof')}</div>
          </div>
        </div>
      </div>

      <div class="grid-2">
        <button class="btn btn-primary" id="btn-flex-cert" style="min-height:46px;font-size:14px;">${icon('qr', 15)} ${L('生成凭证海报', 'Proof Poster')}</button>
        <button class="btn btn-secondary" id="btn-x-proof" style="min-height:46px;font-size:14px;">${icon('xBrand', 14)} ${L('发 X 炫耀凭证', 'Share Proof on X')}</button>
      </div>
      <button class="btn btn-secondary" id="copy-cert-hash" style="min-height:42px;font-size:13.5px;">${icon('copy', 14)} ${L('复制存证哈希', 'Copy Proof Hash')}</button>

      ${renderCorridorRadar(round.candles || [], round.targetPrice, round.activeCandleSec || 0, round.livePrice, { qualified: round.qualifiedCandles || 0, minQualified: round.minQualifiedCandles || 16, seen: round.candlesSeen || 0 })}

      <div class="card row-between">
        <span class="row-start" style="font-weight:600;">${icon('refresh', 15, 'text-gold')} ${L('自动连闯', 'Auto-Continue')}</span>
        <div class="a9-switch ${cert.autoRenew ? 'on' : ''}" id="cert-renew-switch"></div>
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
  root.querySelector('#cert-renew-switch').onclick = () => {
    A9Haptic.tick();
    store.update(s => { const target = s.certificates.find(c => c.id === cert.id); if (target) target.autoRenew = !target.autoRenew; });
    root.querySelector('#cert-renew-switch').classList.toggle('on');
    showToast(L('已更新续期设置', 'Rollover updated'));
  };
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
  const { user, round } = store.state;
  const nextRoundZh = round.currentRound ? `第 ${round.currentRound + 1} 轮` : '下一轮';
  const nextRoundEn = round.currentRound ? `round ${round.currentRound + 1}` : 'the next round';
  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-hero">
        <div class="row-between" style="margin-bottom:8px;">
          <div class="card-title">${icon('refresh', 16, 'text-gold')} ${L('自动连闯', 'Auto-Continue')}</div>
          <div class="a9-switch ${user.autoRenew ? 'on' : ''}" id="global-renew-sw"></div>
        </div>
        <div class="text-sec" style="font-size:12px;">${L(`达标结算后自动将当前质押转入${nextRoundZh}，按参与时段锁定早鸟权重。`, `Auto-rolls stake into ${nextRoundEn} after a passing settlement.`)}</div>
      </div>
    </div>
  `;
  root.querySelector('#global-renew-sw').onclick = () => {
    A9Haptic.tick();
    store.update(s => { s.user.autoRenew = !s.user.autoRenew; });
    renderRenewPage(root);
  };
}

export function renderLedgerPage(root) {
  if (!config.isDemo) {
    root.innerHTML=`<section class="card"><p>${L('领取历史等待核验','Claim history awaits verification')}</p><a href="#/profile">${L('查看钱包资产','View wallet assets')}</a></section>`;
    return;
  }
  let viewMode = 'ledger';
  let activeFilter = 'all';
  const rowsAll = store.state.ledger.length ? store.state.ledger : [
    { type: L('暂无收益记录', 'No reward records'), time: '—', amount: '0 A9', status: L('空', 'Empty'), cat: 'all' }
  ];
  const categories = [
    ['all', L('全部', 'All')], ['user', L('用户奖励', 'User')], ['promo', L('邀友奖励', 'Invite')], ['warmup', L('开局预热', 'Pre-Round')]
  ];
  const paint = () => {
    if (viewMode === 'records') {
      const history = store.state.certificates;
      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <div class="seg-tabs">
            <button class="seg-tab" data-lmode="ledger" type="button">${L('收益账本', 'Ledger')}</button>
            <button class="seg-tab active" data-lmode="records" type="button">${L('闯关战绩', 'History')}</button>
          </div>
          <div class="card card-hero">
            <div class="num-xs text-muted">${L('累计质押本金', 'Total Staked')}</div>
            <div class="num-hero">${formatNum(history.reduce((s, c) => s + (c.stakeTon || 0), 0), 2)} <span class="num-md text-green">GRAM</span></div>
          </div>
          <div class="col-gap">
            ${history.length === 0 ? `<div class="card empty-state"><div class="num-xs text-muted">${L('暂无闯关战绩', 'No history')}</div></div>` : history.map(h => `
              <div class="card clickable" data-nav="/proof/${h.id}">
                <div class="row-between">
                  <div><div style="font-weight:700;">${L('第', 'R')} ${h.round} ${L('轮', '')} · <span class="text-sec">${formatNum(h.stakeTon)} GRAM</span></div><div class="num-xs text-muted">${h.status === 'settled' ? L('已结算', 'Settled') : L('观察中', 'Observing')}</div></div>
                  <div style="text-align:right;"><div class="num-sm text-green">${formatNum(h.estRewardA9)} A9</div><div class="num-xs text-muted">${L('凭证', 'Pass')} ${icon('chevronRight', 11)}</div></div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
      root.querySelectorAll('[data-lmode]').forEach(b => { b.onclick = () => { A9Haptic.light(); viewMode = b.dataset.lmode; paint(); }; });
      return;
    }

    const list = activeFilter === 'all' ? rowsAll : rowsAll.filter(r => r.cat === activeFilter);
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="seg-tabs">
          <button class="seg-tab active" data-lmode="ledger" type="button">${L('收益账本', 'Ledger')}</button>
          <button class="seg-tab" data-lmode="records" type="button">${L('闯关战绩', 'History')}</button>
        </div>
        <div class="filter-row">${categories.map(([v, label]) => `<button class="filter-pill ${activeFilter === v ? 'active' : ''}" data-lf="${v}">${label}</button>`).join('')}</div>
        <div class="card"><div class="col-gap">
          ${list.map(l => `
            <div class="list-row">
              <div><div style="font-weight:600;font-size:12px;">${l.type}</div><div class="num-xs text-muted">${l.time || '—'} · ${l.status || ''}</div></div>
              <div class="num-sm text-green">${l.amount || '0 A9'}</div>
            </div>
          `).join('')}
        </div></div>
      </div>
    `;
    root.querySelectorAll('[data-lmode]').forEach(b => { b.onclick = () => { A9Haptic.light(); viewMode = b.dataset.lmode; paint(); }; });
    root.querySelectorAll('[data-lf]').forEach(b => { b.onclick = () => { A9Haptic.light(); activeFilter = b.dataset.lf; paint(); }; });
  };
  paint();
}

export function renderRecordsPage(root) {
  if (!config.isDemo) {
    root.innerHTML=`<section class="card"><p>${L('领取历史等待核验','Claim history awaits verification')}</p><a href="#/profile">${L('查看钱包资产','View wallet assets')}</a></section>`;
    return;
  }
  let activeFilter = 'all';
  const history = store.state.certificates;
  const paint = () => {
    const list = activeFilter === 'all' ? history : history.filter(h => h.status === activeFilter);
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero">
          <div class="num-xs text-muted">${L('累计质押本金', 'Total Staked')}</div>
          <div class="num-hero">${formatNum(history.reduce((s, c) => s + (c.stakeTon || 0), 0), 2)} <span class="num-md text-green">GRAM</span></div>
        </div>
        <div class="filter-row">
          <button class="filter-pill ${activeFilter === 'all' ? 'active' : ''}" data-rf="all">${L('全部', 'All')}</button>
          <button class="filter-pill ${activeFilter === 'observation' ? 'active' : ''}" data-rf="observation">${L('进行中', 'Live')}</button>
          <button class="filter-pill ${activeFilter === 'settled' ? 'active' : ''}" data-rf="settled">${L('已结算', 'Settled')}</button>
        </div>
        <div class="col-gap">
          ${list.length === 0 ? `<div class="card empty-state"><div class="num-xs text-muted">${L('暂无记录', 'No records')}</div></div>` : list.map((h, i) => `
            <div class="card clickable" data-drawer="${i}">
              <div class="row-between">
                <div><div style="font-weight:700;">${L('第', 'R')} ${h.round} ${L('轮', '')} · <span class="text-sec">${formatNum(h.stakeTon)} GRAM</span></div><div class="num-xs text-muted">${h.status === 'settled' ? L('已结算', 'Settled') : L('观察中', 'Observing')}</div></div>
                <div style="text-align:right;"><div class="num-sm text-green">${formatNum(h.estRewardA9)} A9</div><div class="num-xs text-muted">${L('存证', 'Proof')} ${icon('chevronDown', 11)}</div></div>
              </div>
              <div class="drawer-body hidden" id="drawer-${i}" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border-subtle);">
                <div class="row-between num-xs"><span class="text-muted">TX Hash</span><span class="text-gold">${h.txHash}</span></div>
              </div>
            </div>
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
