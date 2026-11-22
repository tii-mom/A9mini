import { portfolioPanel, identityStage, bindIdentityStage } from './wealthverse.js';
/**
 * 我的 / 资产 / 结算页
 * 顺序：可领取金额与操作 → 参与中 / 待解锁奖励与下一步 → 凭证 / 海报 / 设置。
 * 金额未知显示明确状态；真实的零值显示为 0，不再用演示数字替代。
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { demoTxHash } from '../demo-data.js';
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { formatNum, showToast, copyText, mountSlider, renderCorridorRadar, bindCorridorRadarEvents, animateSlotCounter, openChoiceSheet, openModal, closeModal } from '../components.js';
import { renderProofFlexPoster, renderStoryPoster, downloadPosterPng } from '../poster.js';
import { openXShareSheet, triggerStoryShare } from '../share.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { tonConnect } from '../tonconnect.js';

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
            <img src="./assets/paper-craft/vault.svg" alt="" style="width:64px;height:64px;filter:var(--paper-cut-shadow);">
            <div style="font-size:17px;font-weight:800;margin-top:4px;">${L('还没有持仓与收益', 'No Active Position Yet')}</div>
            <div class="text-sec" style="font-size:12px;max-width:260px;">${L('最低 10 GRAM 即可参与，达标后按权重瓜分本轮奖励。', 'Join from 10 GRAM; rewards are shared by weight if the round passes.')}</div>
            <button class="btn btn-primary" style="margin-top:10px;" data-nav="/challenge/confirm">${icon('bolt', 16)} ${L('立即参与', 'Stake Now')}</button>
            <button class="btn btn-secondary" data-nav="/internal/market">${icon('swap', 15)} ${L('主城商行兑换 A9', 'Market Swap')}</button>
          </div>
        </div>
        <div class="grid-2">
          <button class="cmd-tile" data-nav="/team/invite"><span class="icon-badge amber">${icon('qr', 15)}</span><span>${L('邀请海报', 'Poster')}</span></button>
          <button class="cmd-tile" data-nav="/settings"><span class="icon-badge">${icon('settings', 15)}</span><span>${L('主城设置', 'Settings')}</span></button>
        </div>
      </div>
    `;
  } else {
    const claimable = unknown ? null : (user.a9Claimable || 0);
    const hasClaim = claimable !== null && claimable > 0;

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        ${identityStage({ modePill, walletTag })}

        ${unknown ? `
          <div class="card row-between" style="border-color:var(--gold-border);">
            <div>
              <div class="row-start" style="font-weight:600;">${icon('shieldAlert', 15, 'text-gold')} ${L('未连接钱包，金额不可读取', 'Wallet not connected')}</div>
              <div class="num-xs text-muted" style="margin-top:3px;">${L('连接后显示可领取、参与中与待解锁奖励', 'Connect to view claimable, active and locked rewards')}</div>
            </div>
            <button class="btn btn-primary btn-sm" id="profile-connect">${L('连接', 'Connect')}</button>
          </div>
        ` : `
          <div class="card card-hero vault-claim">
            <div class="row-between" style="margin-bottom:6px;">
              <span class="num-xs text-muted">${L('当前可领取奖励', 'Claimable Rewards')}</span>
              <a class="text-link-btn" href="#/rewards">${L('解锁规则', 'Vesting')} ›</a>
            </div>
            <div class="num-hero"><span id="a9-claim-num">${formatNum(claimable)}</span> <span class="num-md text-green">A9</span></div>
            <div class="metric-strip cols-2" style="margin:10px 0 12px;">
              <div class="metric-cell">
                <span class="num-xs text-muted">${L('待解锁奖励', 'Locked Vesting')}</span>
                <span class="num-md">${unknown ? '—' : formatNum(user.a9Locked)} A9</span>
              </div>
              <div class="metric-cell">
                <span class="num-xs text-muted">${L('解锁触发条件', 'Unlock Rule')}</span>
                <span class="num-xs text-sec">${L('后续达标轮线性释放', 'Unlocks on passing rounds')}</span>
              </div>
            </div>
            ${hasClaim ? `
              ${store.fundsEnabled ? `<div id="profile-quick-slider"></div>` : `<div class="sub-tile row-between" style="border-color:var(--gold-border);"><span class="num-xs text-sec">${L('真实只读模式：当前仅支持查看，暂未开放凭证领取签名', 'Live read-only: claiming disabled')}</span><button class="btn btn-secondary btn-sm" data-nav="/claim">${L('查看', 'View')}</button></div>`}
            ` : `
              <button class="btn btn-secondary" data-nav="/records">${icon('clock', 15)} ${L('查看奖励明细', 'View Ledger')}</button>
            `}
          </div>
        `}

        <div class="card">
          <div class="card-header"><div class="card-title">${icon('shieldCheck', 16, 'text-green')} ${L('凭证收藏册','Ticket collection')}</div><span class="chip chip-muted">${certificates.length}</span></div>
          <nav class="ticket-tabs" aria-label="${L('筛选凭证','Filter tickets')}">${[['all',L('全部','All')],['observation',L('观察中','Observing')],['settled',L('已结算','Settled')]].map(([value,label])=>`<button type="button" data-ticket-filter="${value}" aria-pressed="${value==='all'}">${label}</button>`).join('')}</nav>
          <p class="ticket-empty" hidden>${L('此状态暂无凭证','No tickets in this state')}</p>
          ${certificates.length === 0
            ? `<div class="empty-state" style="padding:14px;"><div class="num-xs text-muted">${L('暂无参与中的质押', 'No active stake')}</div><button class="btn btn-primary btn-sm" style="margin-top:8px;" data-nav="/challenge">${L('去参与', 'Join')}</button></div>`
            : certificates.map(c => `
              <div class="list-row clickable collectible-ticket" data-ticket-state="${c.status}" data-nav="/proof/${c.id}"><img src="./assets/paper-craft/ticket.svg" alt="">
                <div><div class="num-sm">#${c.id}</div><div class="num-xs text-muted">${L('第', 'R')} ${c.round} ${L('轮', '')} · ${formatNum(c.stakeTon)} GRAM</div></div>
                <div style="text-align:right;"><div class="num-xs text-muted">${L('预计奖励','Est. reward')}</div><div class="num-sm text-green">${formatNum(c.estRewardA9)} A9</div><span class="chip ${c.status === 'settled' ? 'chip-green' : 'chip-gold'}" style="height:17px;font-size:9px;">${c.status === 'settled' ? L('已结算', 'Settled') : L('观察中', 'Observing')}</span></div>
              </div>
            `).join('')}
        </div>

        <div class="grid-4">
          <button class="cmd-tile" data-nav="/proof"><span class="icon-badge orange">${icon('shieldCheck', 16)}</span><span>${L('凭证', 'Proof')}</span></button>
          <button class="cmd-tile" data-nav="/ledger"><span class="icon-badge emerald">${icon('receipt', 16)}</span><span>${L('明细', 'Ledger')}</span></button>
          <button class="cmd-tile" data-nav="/renew"><span class="icon-badge sky">${icon('refresh', 16)}</span><span>${L('续期', 'Renew')}</span></button>
          <button class="cmd-tile" data-nav="/settings"><span class="icon-badge">${icon('settings', 16)}</span><span>${L('设置', 'Config')}</span></button>
        </div>
      </div>
    `;

    root.querySelector('.ticket-tabs')?.addEventListener('click', e=>{
      const button=e.target.closest('[data-ticket-filter]');
      if (!button) return;
      A9Haptic.light();
      A9Audio.tick();
      const filter=button.dataset.ticketFilter;
      let visible=0;
      root.querySelectorAll('[data-ticket-state]').forEach(ticket=>{
        ticket.hidden=filter!=='all' && ticket.dataset.ticketState!==filter;
        if(!ticket.hidden) visible++;
      });
      root.querySelectorAll('[data-ticket-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
      root.querySelector('.ticket-empty').hidden=visible>0 || certificates.length===0;
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
        <button class="btn btn-secondary" data-nav="/profile">${icon('arrowLeft', 15)} ${L('返回我的', 'Back to Vault')}</button>
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
    if (claimedAmount > 0) {
      const txHash = demoTxHash('EQC');
      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <div class="card card-hero" style="text-align:center;padding:26px 14px;">
            <div class="icon-badge neon" style="width:52px;height:52px;margin:0 auto 12px;border-radius:14px;">${icon('checkCircle', 28)}</div>
            <div style="font-size:18px;font-weight:700;">${L('演示领取完成', 'Demo claim complete')}</div>
            <div class="num-hero" style="margin:6px 0;">+${formatNum(claimedAmount)} <span class="num-md text-green">A9</span></div>
            <div class="num-xs text-sec clickable" id="copy-claim-tx">${txHash} ${icon('copy', 12)}</div>
            <div class="num-xs text-muted" style="margin-top:6px;">${L('演示哈希 · 非链上交易', 'Demo hash · not an on-chain tx')}</div>
          </div>
          <button class="btn btn-primary" data-nav="/ledger">${icon('receipt', 15)} ${L('查看收益明细', 'View Ledger')}</button>
          <button class="btn btn-secondary" data-nav="/profile">${icon('arrowLeft', 15)} ${L('返回资产', 'Back to Vault')}</button>
        </div>
      `;
      root.querySelector('#copy-claim-tx').onclick = () => copyText(txHash, L('已复制哈希', 'Copied Hash'));
      return;
    }

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card card-hero">
          <div class="row-between" style="margin-bottom:8px;">
            <span class="num-xs text-muted">${L('即刻可领 (20%)', 'Claimable Now (20%)')}</span>
            <span class="chip chip-green">${L('演示', 'DEMO')}</span>
          </div>
          <div class="num-hero" id="claim-counter">${formatNum(claimable || 0)} A9</div>
        </div>
        ${claimable > 0
          ? `<div id="claim-slider-mount"></div>`
          : `<div class="card empty-state"><div class="num-sm text-sec">${L('当前无可领余额', 'Nothing to claim right now')}</div></div>`
        }
      </div>
    `;
    if (claimable > 0) {
      animateSlotCounter(root.querySelector('#claim-counter'), claimable, { duration: 550, suffix: ' A9' });
      mountSlider(root.querySelector('#claim-slider-mount'), {
        label: L(`右滑提取 ${formatNum(claimable)} A9`, `Slide to Claim ${formatNum(claimable)} A9`),
        onConfirm: async () => {
          claimedAmount = store.claimRewards();
          showToast(L(`已提取 ${formatNum(claimedAmount)} A9`, `Claimed ${formatNum(claimedAmount)} A9`));
          paint();
        }
      });
    }
  };
  paint();
}

export function renderProofDetail(root, navigate, certId) {
  const cert = store.state.certificates.find(c => c.id === certId) || store.state.certificates[0];
  if (!cert) {
    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="card empty-state">
          <div class="icon-badge orange" style="width:48px;height:48px;border-radius:14px;">${icon('shieldCheck', 22)}</div>
          <div style="font-weight:700;font-size:15px;margin-top:4px;">${L('暂无质押凭证', 'No Certificate Yet')}</div>
          <div class="num-xs text-muted" style="max-width:240px;">${L('完成任意一轮 GRAM 参与后，将自动铸造链上 SBT 质押凭证。', 'Complete any round stake to mint your on-chain SBT certificate.')}</div>
          <button class="btn btn-primary btn-sm" style="margin-top:10px;" data-nav="/challenge/confirm">${icon('bolt', 14)} ${L('立即参与获取凭证', 'Stake to Mint')}</button>
        </div>
        <button class="btn btn-secondary" data-nav="/profile">${icon('arrowLeft', 15)} ${L('返回我的', 'Back')}</button>
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
        <span class="row-start" style="font-weight:600;">${icon('refresh', 15, 'text-gold')} ${L('到期自动续期', 'Auto-Rollover')}</span>
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
          <div class="card-title">${icon('refresh', 16, 'text-gold')} ${L('自动续期', 'Auto-Rollover')}</div>
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
    ['all', L('全部', 'All')], ['user', L('用户奖励', 'User')], ['promo', L('推广奖励', 'Promo')], ['warmup', L('预热奖励', 'Warm-Up')]
  ];
  const paint = () => {
    if (viewMode === 'records') {
      const history = store.state.certificates;
      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <div class="seg-tabs">
            <button class="seg-tab" data-lmode="ledger" type="button">${L('奖励明细', 'Ledger')}</button>
            <button class="seg-tab active" data-lmode="records" type="button">${L('参与战绩', 'History')}</button>
          </div>
          <div class="card card-hero">
            <div class="num-xs text-muted">${L('累计质押本金', 'Total Staked')}</div>
            <div class="num-hero">${formatNum(history.reduce((s, c) => s + (c.stakeTon || 0), 0), 2)} <span class="num-md text-green">GRAM</span></div>
          </div>
          <div class="col-gap">
            ${history.length === 0 ? `<div class="card empty-state"><div class="num-xs text-muted">${L('暂无参与记录', 'No records')}</div></div>` : history.map(h => `
              <div class="card clickable" data-nav="/proof/${h.id}">
                <div class="row-between">
                  <div><div style="font-weight:700;">${L('第', 'R')} ${h.round} ${L('轮', '')} · <span class="text-sec">${formatNum(h.stakeTon)} GRAM</span></div><div class="num-xs text-muted">${h.status === 'settled' ? L('已结算', 'Settled') : L('观察中', 'Observing')}</div></div>
                  <div style="text-align:right;"><div class="num-sm text-green">${formatNum(h.estRewardA9)} A9</div><div class="num-xs text-muted">${L('凭证', 'Proof')} ${icon('chevronRight', 11)}</div></div>
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
          <button class="seg-tab active" data-lmode="ledger" type="button">${L('奖励明细', 'Ledger')}</button>
          <button class="seg-tab" data-lmode="records" type="button">${L('参与战绩', 'History')}</button>
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
