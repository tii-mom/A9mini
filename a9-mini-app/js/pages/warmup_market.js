import { personalRanks, teamRanks, DEMO_CHEST_SKUS, demoBuyChest } from '../demo-data.js';
import {
  fetchWarmupRank,
  fetchMyChests,
  claimStarterChests,
  openChestById,
  requestChestPurchaseIntent,
  fetchPresaleQuota,
  fetchPresaleOrders,
  registerWarmup,
  cancelWarmup,
  getEffectiveUserId,
  rawToA9,
} from '../data.js';
/**
 * Warm-up & Chest Mall Pages — 2-Tab Unified Chest Mall (Paid Boost + Free 5-Tier Viral Chain)
 * - Paid Chest Mall: 5 fixed SKUs (0.99 / 4.99 / 9.99 / 19.99 / 99.99 GRAM) at 1 GRAM = 2,002 A9
 *   with Instant vs 24H Social Boost toggle (stoppable anytime, principal never held hostage).
 * - Free Chests: Bronze #1/#2/#3 serial (300/300/400 A9) -> Silver (10k) -> Gold (100k) -> Platinum (200k) -> Diamond (1,000k).
 * - Live mode stays strictly read-only on purchase/write actions.
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { tonConnect } from '../tonconnect.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { escapeHtml, formatNum, formatTimer, showToast, copyText, burstParticles, openModal, closeModal } from '../components.js';
import { icon } from '../icons.js';
import { L } from '../i18n.js';
import { SHOP_SCALLOP_AWNING } from '../paper-art.js';
import { openXShareSheet, buildOgShareUrl, buildTmaDeepLink, getShareRef } from '../share.js';

export function renderWarmupHome(root, navigate) {
  const { user, round } = store.state;
  const reg = user.warmupRegistered;
  const safeAddr = (user.shortAddress || 'A9USER').replace(/[^a-zA-Z0-9]/g, '');
  const inviteUrl = config.isDemo
    ? `${window.location.origin}${window.location.pathname}?startapp=invite_${safeAddr}`
    : buildTmaDeepLink(`invite_${getShareRef()}`);

  const distSteps = [
    { key: 'pending_freeze', label: L('待冻结 (T)', 'Freeze (T)') },
    { key: 'confirming',     label: L('名单确认 (T+24H)', 'Verify (T+24H)') },
    { key: 'distributing',   label: L('自动发放中', 'Sending') },
    { key: 'done',           label: L('已发放 (T+48H)', 'Sent (T+48H)') }
  ];

  const roundLabel = round.currentRound
    ? L(`第 ${round.currentRound} 轮开局预热 (12H)`, `R${round.currentRound} Pre-Round (12H)`)
    : L('开局预热待核验', 'Pre-Round Pending');
  const cdText = round.earlyBirdSec === null || round.earlyBirdSec === undefined
    ? '—'
    : formatTimer(round.earlyBirdSec);

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card card-hero">
        <div class="row-between" style="margin-bottom:10px;">
          <span class="chip chip-gold">${roundLabel}</span>
          <span class="row-start num-sm text-sec">${icon('clock', 13)} <span id="early-cd" class="mono">${cdText}</span></span>
        </div>
        <div class="num-xs text-muted">${L('本轮开局预热池', 'Pre-Round Pool')}</div>
        <div class="num-hero" style="margin-top:4px;">${config.isDemo ? '8,000,000 <span class="num-md text-green">A9</span>' : L('待核验', 'Awaiting verification')}</div>

        ${config.isDemo ? `
        <div class="metric-strip cols-3">
          <div class="metric-cell"><span class="num-xs text-muted">${L('有效直邀', 'Invites')}</span><span class="num-md">${reg ? user.warmupInvites : 0}</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('预热排名', 'Rank')}</span><span class="num-md text-gold">${reg ? 'No.08' : '--'}</span></div>
          <div class="metric-cell"><span class="num-xs text-muted">${L('预计奖励', 'Est. A9')}</span><span class="num-md text-green">${!reg ? '0' : '400,000'}</span></div>
        </div>
        ` : ''}

        ${!reg
          ? `<button class="btn btn-primary" id="btn-register-warmup">${icon('bolt', 16)} ${L('立即报名开局预热 (需 ≥1 有效直邀)', 'Join Pre-Round (≥1 Invite)')}</button>`
          : `<button class="btn btn-primary" id="btn-share-warmup">${icon('send', 15)} ${L('分享冲榜 · 冲击前 10 名', 'Share to Reach Top 10')}</button>`
        }
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">${icon('clock', 15, 'text-gold')} ${L('热钱包自动发放进度', 'Auto-Distribution Timeline')}</div>
          <span class="chip chip-green">${L('无需手动领取', 'Auto-Drop')}</span>
        </div>
        <div class="grid-2">
          ${distSteps.map((st, idx) => `
            <div class="list-row" style="${idx === 0 ? 'border-color:var(--gold-border);' : ''}">
              <span class="num-xs ${idx === 0 ? 'text-gold' : 'text-muted'}">${idx + 1}. ${st.label}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">${icon('trophy', 15, 'text-gold')} ${L('前 50 名阶梯奖励', 'Top 50 Tiers')}</div>
        </div>
        ${config.isDemo ? `
        <div class="col-gap">
          <div class="list-row"><b>${L('第 1–10 名', 'Top 1–10')}</b><span class="num-sm text-green">400,000 A9 / ${L('人', 'ea')}</span></div>
          <div class="list-row"><b>${L('第 11–25 名', 'Top 11–25')}</b><span class="num-sm text-gold">160,000 A9 / ${L('人', 'ea')}</span></div>
          <div class="list-row"><b>${L('第 26–50 名', 'Top 26–50')}</b><span class="num-sm text-sec">64,000 A9 / ${L('人', 'ea')}</span></div>
        </div>
        ` : `<div class="num-xs text-muted">${L('预热奖池与阶梯发放标准等待服务端公布后展示。', 'Warm-up reward tiers await server publication.')}</div>`}
      </div>

      <div class="grid-2">
        <button class="btn btn-secondary" data-nav="/warmup/rank">${icon('trophy', 15)} ${L('早鸟先锋榜', 'Early Bird Board')}</button>
        <button class="btn btn-secondary" id="btn-copy-invite">${icon('copy', 15)} ${L('复制邀请链', 'Copy Link')}</button>
      </div>

      ${reg ? `<button class="btn btn-sm" id="btn-cancel-warmup" style="width:100%;background:transparent;color:var(--text-muted);font-weight:500;">${L('取消本轮开局预热报名', 'Cancel Pre-Round Registration')}</button>` : ''}
    </div>
  `;

  const regBtn = root.querySelector('#btn-register-warmup');
  if (regBtn) {
    regBtn.onclick = async () => {
      if (!config.isDemo) {
        const uid = getEffectiveUserId(user);
        if (!uid) {
          showToast(L('请在 Telegram 内打开或先连接 TON 钱包', 'Open in Telegram or connect TON wallet first'), 'amber');
          tonConnect.openConnectModal(() => renderWarmupHome(root, navigate));
          return;
        }
        regBtn.disabled = true;
        try {
          await registerWarmup({ roundId: round.currentRound || 1, walletAddress: user.address, userId: uid, referrerId: store.state.referral.referrerId });
          A9Haptic.success();
          burstParticles(regBtn);
          store.update(s => { s.user.warmupRegistered = true; });
          showToast(L('开局预热报名成功', 'Pre-Round registered'));
          renderWarmupHome(root, navigate);
        } catch (e) {
          showToast(e?.message || L('预热报名失败，请重试', 'Registration failed'), 'error');
          regBtn.disabled = false;
        }
        return;
      }
      A9Haptic.success();
      store.update(s => { s.user.warmupRegistered = true; });
      burstParticles(regBtn);
      showToast(L('报名成功 · 当前排位 No.08', 'Joined · Rank #08'));
      renderWarmupHome(root, navigate);
    };
  }
  const shareBtn = root.querySelector('#btn-share-warmup');
  if (shareBtn) {
    shareBtn.onclick = () => {
      A9TMA.shareInvite(inviteUrl, config.isDemo ? 'A9 8,000,000 A9 Pre-Round Pool' : L('A9 协议开局预热入口', 'A9 Protocol Pre-Round'));
      showToast(L('已调起分享', 'Share opened'));
    };
  }
  const cancelBtn = root.querySelector('#btn-cancel-warmup');
  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      if (!config.isDemo) {
        const uid = getEffectiveUserId(user);
        if (!uid) {
          showToast(L('请在 Telegram 内打开或先连接 TON 钱包', 'Open in Telegram or connect TON wallet first'), 'amber');
          tonConnect.openConnectModal(() => renderWarmupHome(root, navigate));
          return;
        }
        cancelBtn.disabled = true;
        try {
          await cancelWarmup({ roundId: round.currentRound || 1, walletAddress: user.address, userId: uid });
          A9Haptic.warning();
          store.update(s => { s.user.warmupRegistered = false; });
          showToast(L('已取消本轮预热报名', 'Registration cancelled'), 'amber');
          renderWarmupHome(root, navigate);
        } catch (e) {
          showToast(e?.message || L('取消预热报名失败，请重试', 'Cancellation failed'), 'error');
          cancelBtn.disabled = false;
        }
        return;
      }
      A9Haptic.warning();
      store.update(s => { s.user.warmupRegistered = false; });
      showToast(L('已取消本轮预热报名', 'Registration cancelled'), 'amber');
      renderWarmupHome(root, navigate);
    };
  }
  root.querySelector('#btn-copy-invite').onclick = () => copyText(inviteUrl, L('已复制链接', 'Copied'));
}

export function renderWarmupRank(root) {
  if (!config.isDemo) {
    const panel=document.createElement('div');
    panel.className='card col-gap';
    root.replaceChildren(panel);
    const load=async()=>{
      if (!store.state.round.currentRound) {
        panel.textContent=L('暂无预热排名','No warm-up rankings yet');
        return;
      }
      panel.textContent=L('正在读取早鸟先锋榜','Loading early bird rankings');
      try {
        const rows=await fetchWarmupRank(store.state.round.currentRound);
        panel.textContent=L('预热邀请榜','Warm-up invites');
        for(const entry of rows) {
          const row=document.createElement('div');row.className='list-row';
          row.textContent='#'+entry.rank+' · '+entry.walletAddress+' · '+entry.validInvites+' '+L('邀请','invites');panel.append(row);
        }
        if (!rows.length) panel.textContent=L('暂无预热排名','No warm-up rankings yet');
      } catch {
        panel.textContent=L('榜单暂不可读取','Rankings unavailable');
        const retry=document.createElement('button');retry.className='btn btn-secondary';retry.textContent=L('重试','Retry');retry.onclick=load;panel.append(retry);
      }
    };load();return;
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
  let openMode = 'BOOST';
  let chestData = { freeChests: [], shopChests: [], loaded: false };
  let liveQuota = null;
  let liveOrdersCount = null;
  let buyBusy = false;

  const isPresaleServerOpen = () => Boolean(store.state.round?.protocolConfig?.presaleHotWallet?.open);
  const canPurchaseNow = () => config.isDemo || (store.fundsEnabled && isPresaleServerOpen());
  const canOpenChestNow = () => config.isDemo || store.fundsEnabled;

  const formatGramFromNano = (nanoStr) => {
    try {
      const n = BigInt(String(nanoStr || '0'));
      const whole = n / 1_000_000_000n;
      const frac = String(n % 1_000_000_000n).padStart(9, '0').slice(0, 2).replace(/0+$/, '');
      return `${whole.toLocaleString('en-US')}${frac ? '.' + frac : ''} GRAM`;
    } catch { return '—'; }
  };

  const pollOrderAfterTx = async (walletAddress, orderId) => {
    const TERMINAL_STATUSES = new Set(['COMPLETED', 'REFUNDED', 'NEEDS_REVIEW', 'PAYMENT_EXCEPTION']);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((r) => setTimeout(r, 2500));
      if (!root.isConnected) return null;
      try {
        const orders = await fetchPresaleOrders(walletAddress);
        if (Array.isArray(orders)) {
          liveOrdersCount = orders.length;
          const found = orders.find((o) => o.orderId === orderId);
          if (found && TERMINAL_STATUSES.has(found.status)) {
            return found;
          }
        }
      } catch (_) {}
    }
    return null;
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
          `兄弟们帮个忙！我在 A9 宝箱商城买了【${label}】，正在 24H 膨胀中（还差 ${need} 人助力拉满），点一下连接钱包帮我膨胀，你顺手也能 0 成本领 1 个青铜宝箱 #1：`,
          `Help boost my A9 [${label}] (${need} assist(s) left)! Connect your active TON wallet to boost and auto-claim your free Bronze Chest #1:`
        )
      : L(
          `TON 上 0 成本宝箱福利：帮我点一下开启【${label}】（还差 ${need} 人助力），你点完直接顺手白领 1 个青铜宝箱 #1！`,
          `Free TON chest drop: help me open [${label}] (${need} left) and auto-claim your own Bronze Chest #1:`
        );
    A9TMA.shareInvite(ogUrl, text);
    showToast(L('已调起 Telegram 好友助力分享', 'Opened Telegram assist share'));
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
        rewardText: `${formatNum(rewardA9)} A9`
      }
    });
  };

  const loadChests = async () => {
    try {
      const res = await fetchMyChests();
      chestData = {
        freeChests: Array.isArray(res?.freeChests) ? res.freeChests : [],
        shopChests: Array.isArray(res?.shopChests) ? res.shopChests : [],
        loaded: true
      };
    } catch (_) {
      chestData.loaded = true;
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
    if (root.isConnected) render();
  };

  const resolveChestSkus = () => {
    if (config.isDemo) return DEMO_CHEST_SKUS;
    const serverSkus = store.state.round?.chestMall?.skus;
    if (Array.isArray(serverSkus) && serverSkus.length) {
      return serverSkus.map((s) => ({
        skuId: s.skuId,
        tier: s.tier,
        zh: s.zh,
        en: s.en,
        priceGram: String(s.priceGram),
        baseA9: Number(s.baseA9),
        maxBoostPct: Math.round(Number(s.maxBoostBps || 0) / 100),
        maxBoostA9: Number(((Number(s.maxBoostA9Raw || 0)) / 1e9).toFixed(2)),
        requiredAssists: Number(s.requiredAssists || 2)
      }));
    }
    return [];
  };

  const render = () => {
    const skus = resolveChestSkus();
    const sel = skus.length ? (skus.find((s) => s.skuId === selectedSkuId) || skus[0]) : null;
    const totalIfBoost = sel ? Number((sel.baseA9 + sel.maxBoostA9).toFixed(2)) : 0;
    const activeShopChests = (chestData.shopChests || []).filter((c) => c.status !== 'OPENED');

    root.innerHTML = `
      <div class="col-gap anim-page-enter">
        <div class="seg-tabs" id="chest-mall-tabs">
          <button class="seg-tab ${activeTab === 'mall' ? 'active' : ''}" data-cm-tab="mall" type="button">${L('宝箱商城（购箱膨胀）', 'Chest Mall')}</button>
          <button class="seg-tab ${activeTab === 'free' ? 'active' : ''}" data-cm-tab="free" type="button">${L('免费宝箱（助力领 A9）', 'Free Chests')}</button>
        </div>

        ${activeTab === 'mall' ? `
          <section class="card card-hero exchange-counter">
            ${SHOP_SCALLOP_AWNING}
            <div class="shop-counter-body">
              <header class="counter-keeper">
                <div class="counter-keeper-left">
                  <img src="./assets/boxheads/wealth/avatars/wlt-08.png" alt="">
                  <div>
                    <h2>${L('A9 宝箱商城 · 固定本金 + 助力暴涨', 'A9 Chest Mall · Fixed Base + Boost')}</h2>
                    <div class="num-xs text-muted mono">1 GRAM = 2,002 A9 · ${L('0.99 GRAM 起售 · 本金绝不扣押', 'From 0.99 GRAM · Base always yours')}</div>
                  </div>
                </div>
                <span class="chip ${config.isDemo ? 'chip-green' : canPurchaseNow() ? 'chip-green' : 'chip-gold'}">${config.isDemo ? L('演示开放', 'DEMO OPEN') : canPurchaseNow() ? L('已开放', 'OPEN') : L('只读模式', 'READ-ONLY')}</span>
              </header>
              ${!config.isDemo && liveQuota ? `
                <div class="sub-tile" style="margin-bottom:10px;">
                  <div class="row-between num-xs">
                    <span class="text-sec">${L('当前钱包剩余购箱额度', 'Wallet Remaining Quota')}</span>
                    <b class="mono text-green">${formatGramFromNano(liveQuota.availQuotaNano ?? liveQuota.remainingNano)}</b>
                  </div>
                </div>
              ` : ''}

              ${!sel ? `
                <div class="sub-tile" id="live-chest-skus-unavailable" style="margin-bottom:12px;border-color:var(--gold-border);">
                  <div class="row-start" style="font-weight:700;margin-bottom:4px;">${icon('shieldAlert', 14, 'text-gold')} ${L('宝箱商城档位配置暂不可用', 'Chest Mall Tiers Unavailable')}</div>
                  <div class="num-xs text-sec" style="line-height:1.5;margin-bottom:8px;">${L('真实模式未获取到服务端宝箱档位配置，严格禁止展示演示价格。请检查网络连接后点击重试。', 'Live mode did not receive server chest tier data; demo prices are never displayed. Check network and retry.')}</div>
                  <button class="btn btn-secondary btn-sm" id="btn-retry-chest-skus" type="button">${icon('refresh', 13)} ${L('重新加载商城配置', 'Retry Loading Tiers')}</button>
                </div>
              ` : `
              <div class="col-gap" style="gap:8px;margin-bottom:12px;">
                ${skus.map((sku) => {
                  const active = sku.skuId === sel.skuId;
                  return `
                    <button type="button" class="list-row clickable" data-pick-sku="${sku.skuId}" style="width:100%;text-align:left;padding:10px 12px;border-radius:12px;border:1.5px solid ${active ? 'var(--green)' : 'var(--border)'};background:${active ? 'var(--paper-tray)' : 'transparent'};">
                      <div>
                        <div style="font-weight:800;font-size:14px;">${L(sku.zh, sku.en)} <span class="chip chip-gold" style="margin-left:4px;">${sku.priceGram} GRAM</span></div>
                        <div class="num-xs text-sec" style="margin-top:3px;">${L('基础', 'Base')} <b class="mono">${formatNum(sku.baseA9, 2)} A9</b> · ${L('助力最高', 'Boost up to')} <b class="mono text-green">+${sku.maxBoostPct}% (+${formatNum(sku.maxBoostA9, 2)} A9)</b></div>
                      </div>
                      <span class="chip ${active ? 'chip-green' : 'chip-muted'}">${active ? L('已选', 'Picked') : `${sku.requiredAssists}${L('人满', ' max')}`}</span>
                    </button>
                  `;
                }).join('')}
              </div>

              <div class="seg-tabs" style="margin-bottom:10px;">
                <button class="seg-tab ${openMode === 'BOOST' ? 'active' : ''}" data-open-mode="BOOST" type="button">${L(`助力膨胀开启（最高 +${sel.maxBoostPct}%）`, `Social Boost (+${sel.maxBoostPct}% max)`)}</button>
                <button class="seg-tab ${openMode === 'INSTANT' ? 'active' : ''}" data-open-mode="INSTANT" type="button">${L('直接开启（固定本金）', 'Open Instantly')}</button>
              </div>

              <div class="sub-tile" style="margin-bottom:12px;">
                <div class="row-between num-xs">
                  <span class="text-sec">${L('固定必得基础 A9（1 GRAM = 2,002 A9）', 'Fixed base A9 (1 GRAM = 2,002 A9)')}</span>
                  <b class="mono">${formatNum(sel.baseA9, 2)} A9</b>
                </div>
                <div class="row-between num-xs" style="margin-top:5px;">
                  <span class="text-sec">${openMode === 'BOOST' ? L(`24H 助力膨胀增量（初始 +1%，${sel.requiredAssists} 人满 +${sel.maxBoostPct}%）`, `24H Boost (+1% start, +${sel.maxBoostPct}% at ${sel.requiredAssists} assists)`) : L('当前模式：不助力直接落袋', 'Instant mode: no boost window')}</span>
                  <b class="mono ${openMode === 'BOOST' ? 'text-green' : 'text-muted'}">${openMode === 'BOOST' ? `最高 +${formatNum(sel.maxBoostA9, 2)} A9` : '0 A9'}</b>
                </div>
                <div class="row-between num-sm" style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--border);">
                  <span style="font-weight:700;">${L('预计总获得', 'Est. Total')}</span>
                  <b class="mono text-green">${formatNum(openMode === 'BOOST' ? totalIfBoost : sel.baseA9, 2)} A9</b>
                </div>
              </div>
              `}

              <div class="num-xs text-muted" style="margin-bottom:10px;line-height:1.5;">
                ${L('膨胀模式 24H 内随时可收手开箱；售罄自动触发 ≥0.99 GRAM 零手续费被动退款。', 'Stop & open anytime within 24H. Sold-out passive refunds >= 0.99 GRAM are 0-fee.')}
              </div>

              <button class="btn ${sel && canPurchaseNow() ? 'btn-primary' : 'btn-secondary'}" id="btn-buy-chest" type="button" ${!sel || !canPurchaseNow() || buyBusy ? 'disabled' : ''}>
                ${!store.fundsEnabled
                  ? `${icon('lock', 15)} ${L('真实模式只读 · 宝箱购箱暂未开放', 'Live Read-Only · Purchase Disabled')}`
                  : !sel
                    ? `${icon('shieldAlert', 15)} ${L('档位配置未就绪 · 请先重试加载', 'Tiers Unavailable · Retry First')}`
                    : !config.isDemo && !isPresaleServerOpen()
                      ? `${icon('lock', 15)} ${L('宝箱商城通道尚未开售', 'Chest Mall Not Yet Open')}`
                      : config.isDemo
                        ? `${icon('bolt', 16)} ${L(`演示购买 ${L(sel.zh, sel.en)}（${sel.priceGram} GRAM）`, `Demo Buy ${sel.en} (${sel.priceGram} GRAM)`)}`
                        : `${icon('bolt', 16)} ${buyBusy ? L('等待钱包确认…', 'Awaiting Wallet…') : L(`立即购买 ${L(sel.zh, sel.en)}（${sel.priceGram} GRAM）`, `Buy ${sel.en} (${sel.priceGram} GRAM)`)}`}
              </button>
            </div>
          </section>

          ${activeShopChests.length > 0 ? `
            <section class="card">
              <div class="card-header">
                <div class="card-title">${icon('flame', 15, 'text-gold')} ${L('我的 24H 膨胀中宝箱', 'My Active 24H Boost Chests')}</div>
                <span class="chip chip-green">${activeShopChests.length}</span>
              </div>
              <div class="col-gap" style="gap:10px;">
                ${activeShopChests.map((c) => {
                  const boostA9 = rawToA9(c.boostA9Raw) || 0;
                  const maxBoostA9 = rawToA9(c.maxBoostA9Raw) || 0;
                  const pct = c.requiredAssists > 0 ? Math.min(100, Math.round((c.currentAssists / c.requiredAssists) * 100)) : 100;
                  return `
                    <div class="sub-tile">
                      <div class="row-between">
                        <strong>${escapeHtml(L(c.labelZh, c.labelEn))}</strong>
                        <span class="chip chip-gold mono">${c.currentAssists}/${c.requiredAssists} ${L('助力', 'assists')}</span>
                      </div>
                      <div class="num-xs text-green mono" style="margin:6px 0 4px;font-weight:800;">
                        ${L('当前已膨胀', 'Boosted')}: +${formatNum(boostA9, 2)} A9 / ${L('上限', 'Max')} +${formatNum(maxBoostA9, 2)} A9
                      </div>
                      <div class="progress-track" style="height:6px;margin-bottom:10px;"><div class="progress-fill" style="width:${pct}%"></div></div>
                      <div class="grid-3" style="gap:6px;">
                        <button class="btn btn-primary btn-sm" data-share-tg="${c.chestId}" type="button" style="width:100%;">${icon('send', 12)} ${L('群里拉助力', 'Share TG')}</button>
                        <button class="btn btn-secondary btn-sm" data-share-x="${c.chestId}" type="button" style="width:100%;">${icon('xBrand', 12)} ${L('发 X 助力', 'Share X')}</button>
                        <button class="btn btn-secondary btn-sm" data-open-chest="${c.chestId}" type="button" style="width:100%;" ${!canOpenChestNow() ? 'disabled' : ''}>${icon(canOpenChestNow() ? 'unlock' : 'lock', 12)} ${canOpenChestNow() ? L('立即开箱', 'Open Now') : L('只读暂未开放', 'Read-Only')}</button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </section>
          ` : ''}

          <div class="card" style="padding:14px 18px;">
            <div class="list-row clickable" data-nav="/internal/records" style="padding:0;">
              <div class="row-start">
                <span class="icon-badge sky" style="width:36px;height:36px;border-radius:11px;">${icon('receipt', 15)}</span>
                <div>
                  <div style="font-weight:600;font-size:14px;">${L('购箱小票与退款明细', 'Chest Receipts & Refunds')}</div>
                  <div class="num-xs text-muted">${config.isDemo ? L(`共 ${market.records.length} 笔订单`, `${market.records.length} orders`) : (liveOrdersCount === null ? L('连接钱包后查看真实订单', 'Connect wallet for live orders') : L(`共 ${formatNum(liveOrdersCount)} 笔订单`, `${formatNum(liveOrdersCount)} orders`))}</div>
                </div>
              </div>
              <span class="text-muted">${icon('chevronRight', 16)}</span>
            </div>
          </div>
        ` : `
          <section class="card card-hero">
            <div class="row-between" style="margin-bottom:6px;">
              <span class="chip chip-gold">${L('0 GRAM 裂变宝箱 · 串行解锁', '0 GRAM Viral Chests · Serial Unlock')}</span>
              <span class="chip chip-muted">${L('活跃钱包助力', 'Active Wallet Only')}</span>
            </div>
            <h2 style="margin:4px 0 6px;font-size:18px;font-weight:900;">${L('青铜 3 连开 → 白银 → 黄金 → 白金 → 钻石', 'Bronze x3 -> Silver -> Gold -> Platinum -> Diamond')}</h2>
            <p class="num-xs text-sec" style="margin:0;line-height:1.5;">
              ${L('只有打开上一个宝箱后才能激活下一个宝箱。好友通过 Telegram / X 连接链上活跃 TON 钱包助力开启，助力者顺手自动领取青铜宝箱 #1。', 'Open each chest to activate the next. Friends assist via active TON wallet and auto-claim their own Bronze Chest #1.')}
            </p>
            ${chestData.loaded && chestData.freeChests.length === 0 ? (
              (!config.isDemo && !A9TMA.getRawInitData())
                ? `<div class="sub-tile" style="margin-top:10px;"><div class="num-xs text-sec">${L('请在 Telegram 小程序内打开以同步并领取你的免费青铜宝箱 #1。', 'Open inside Telegram Mini App to sync and claim your free Bronze Chest #1.')}</div></div>`
                : `<button class="btn btn-primary" id="btn-claim-starter" type="button" style="margin-top:12px;">${icon('bolt', 15)} ${L('0 成本领取青铜宝箱 #1（300 A9）', 'Claim Free Bronze Chest #1 (300 A9)')}</button>`
            ) : ''}
          </section>

          <div class="col-gap" style="gap:10px;">
            ${(chestData.freeChests || []).map((c) => {
              const rewardA9 = rawToA9(c.baseA9Raw) || 0;
              const pct = c.requiredAssists > 0 ? Math.min(100, Math.round((c.currentAssists / c.requiredAssists) * 100)) : 0;
              const volReq = formatVolumeReq(c.minVolumeNano);
              const isLocked = c.status === 'LOCKED';
              const isOpened = c.status === 'OPENED';
              const isReady = c.status === 'READY' || (!isLocked && !isOpened && c.currentAssists >= c.requiredAssists);
              const badgeCls = isOpened ? 'chip-muted' : isReady ? 'chip-green' : isLocked ? 'chip-muted' : 'chip-gold';
              const badgeTxt = isOpened ? L('已开启', 'Opened') : isReady ? L('可开箱', 'Ready') : isLocked ? L('待解锁', 'Locked') : L('助力中', 'Active');
              return `
                <section class="card" style="opacity:${isLocked ? '0.72' : '1'};">
                  <div class="row-between" style="margin-bottom:6px;">
                    <div>
                      <strong style="font-size:15px;">${escapeHtml(L(c.labelZh, c.labelEn))}</strong>
                      <span class="num-sm text-green mono" style="font-weight:900;margin-left:6px;">${formatNum(rewardA9)} A9</span>
                    </div>
                    <span class="chip ${badgeCls}">${badgeTxt}</span>
                  </div>
                  <div class="row-between num-xs text-sec" style="margin-bottom:5px;">
                    <span>${L('活跃钱包助力', 'Active Wallet Assists')}: <b class="mono">${formatNum(c.currentAssists)} / ${formatNum(c.requiredAssists)}</b></span>
                    <span>${c.tier === 'bronze' ? L('入待激活金库', 'Pending Vault') : L('入可提现推广余额', 'Claimable Promo')}</span>
                  </div>
                  <div class="progress-track" style="height:6px;margin-bottom:8px;"><div class="progress-fill" style="width:${pct}%"></div></div>
                  ${(volReq || c.minTgMembers > 0) ? `
                    <div class="num-xs text-muted" style="margin-bottom:8px;">
                      ${L('附加门槛', 'Extra gates')}: ${volReq ? L(`直邀/战队真实购箱额 ≥ ${volReq}`, `Team volume >= ${volReq}`) : ''}${volReq && c.minTgMembers > 0 ? ' · ' : ''}${c.minTgMembers > 0 ? L(`已核验 TG 群 ≥ ${formatNum(c.minTgMembers)} 人`, `Verified TG group >= ${formatNum(c.minTgMembers)}`) : ''}
                    </div>
                  ` : ''}
                  ${!isLocked && !isOpened ? `
                    <div class="grid-3" style="gap:6px;">
                      <button class="btn btn-primary btn-sm" data-share-tg="${c.chestId}" type="button" style="width:100%;">${icon('send', 12)} ${L('TG 拉助力', 'TG Share')}</button>
                      <button class="btn btn-secondary btn-sm" data-share-x="${c.chestId}" type="button" style="width:100%;">${icon('xBrand', 12)} ${L('X 发卡片', 'X Share')}</button>
                      <button class="btn ${isReady && canOpenChestNow() ? 'btn-primary' : 'btn-secondary'} btn-sm" data-open-chest="${c.chestId}" type="button" style="width:100%;" ${!canOpenChestNow() ? 'disabled' : ''}>${icon(canOpenChestNow() ? 'unlock' : 'lock', 12)} ${canOpenChestNow() ? L('开箱', 'Open') : L('只读', 'Read-Only')}</button>
                    </div>
                  ` : ''}
                </section>
              `;
            }).join('')}
          </div>
        `}
      </div>
    `;

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

    root.querySelectorAll('[data-open-mode]').forEach((b) => {
      b.onclick = () => {
        A9Haptic.tick();
        openMode = b.dataset.openMode;
        render();
      };
    });

    const retrySkusBtn = root.querySelector('#btn-retry-chest-skus');
    if (retrySkusBtn) {
      retrySkusBtn.onclick = async () => {
        retrySkusBtn.disabled = true;
        try {
          if (typeof store.refreshLive === 'function') await store.refreshLive();
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
          const res = demoBuyChest(store.state, selectedSkuId, openMode);
          if (res.error) {
            A9Haptic.error();
            showToast(res.error, 'error');
            return;
          }
          A9Haptic.success();
          burstParticles(buyBtn);
          showToast(openMode === 'BOOST'
            ? L(`购箱成功 · 本金 ${formatNum(res.receivedA9, 2)} A9 已到账，24H 膨胀已开启！`, `Purchased! ${formatNum(res.receivedA9, 2)} A9 credited + 24H boost started!`)
            : L(`直接开箱成功 · +${formatNum(res.receivedA9, 2)} A9`, `Opened! +${formatNum(res.receivedA9, 2)} A9`));
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
        buyBusy = true;
        render();
        try {
          const order = await requestChestPurchaseIntent({
            walletAddress: walletAddr,
            skuId: selectedSkuId,
            openMode,
            referrerId: store.state.referral.referrerId,
          });
          await tonConnect.sendV15PresaleTx(order);
          A9Haptic.success();
          showToast(L(`已提交购箱交易（订单 ${order.orderId}），正在等待链上确认与 A9 发放…`, `Order ${order.orderId} signed, waiting for on-chain confirmation…`));
          const settled = await pollOrderAfterTx(walletAddr, order.orderId);
          if (settled?.status === 'COMPLETED') {
            burstParticles(root);
            showToast(L(`订单 ${order.orderId} 已完成，基础 A9 已发放！`, `Order ${order.orderId} completed! Base A9 credited.`));
          } else if (settled?.status === 'REFUNDED') {
            showToast(L(`订单 ${order.orderId} 已触发原路退款，请在购箱小票查看明细`, `Order ${order.orderId} refunded; check receipts for details`), 'amber');
          } else if (settled?.status === 'PAYMENT_EXCEPTION' || settled?.status === 'NEEDS_REVIEW') {
            showToast(L(`订单 ${order.orderId} 已进入人工复核，请在购箱小票关注处理进度`, `Order ${order.orderId} queued for review; check receipts`), 'amber');
          }
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
          showToast(L('已激活青铜宝箱 #1，快去邀请 2 位好友助力开箱！', 'Bronze Chest #1 activated! Invite 2 friends to open.'));
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
    root.querySelectorAll('[data-open-chest]').forEach((b) => {
      b.onclick = async () => {
        if (!store.fundsEnabled) {
          A9Haptic.warning();
          showToast(L('当前真实模式处于只读验收阶段，宝箱开箱入账暂未开放', 'Live mode is read-only; chest opening is disabled'), 'amber');
          return;
        }
        const cid = b.dataset.openChest;
        b.disabled = true;
        try {
          const res = await openChestById(cid, store.state, store.state.user.address);
          const gotA9 = rawToA9(res?.rewardA9Raw) || 0;
          A9Haptic.success();
          burstParticles(b);
          const nextMsg = res?.nextUnlocked ? L(`，已解锁下一档「${res.nextUnlocked.labelZh}」`, `, unlocked ${res.nextUnlocked.labelEn}`) : '';
          showToast(L(`开箱成功！+${formatNum(gotA9, 2)} A9${nextMsg}`, `Opened! +${formatNum(gotA9, 2)} A9${nextMsg}`));
          await loadChests();
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('暂未满足开箱条件', 'Open requirements not yet met'), 'amber');
          b.disabled = false;
        }
      };
    });
  };

  render();
  loadChests();
}

export function renderInternalRecords(root) {
  if (!config.isDemo) {
    const addr = store.state.user.address;
    const paintLiveOrders = (orders, note = '') => {
      const statusMap = {
        PENDING: ['chip-gold', L('待付款', 'Pending')],
        PENDING_PAYMENT: ['chip-gold', L('待付款', 'Pending')],
        PAYMENT_CONFIRMED: ['chip-gold', L('已收款 · 待发币', 'Paid · Queued')],
        PAYOUT_PENDING: ['chip-gold', L('待发币', 'Payout Queued')],
        PAYOUT_SENT: ['chip-gold', L('发币核验中', 'Verifying Payout')],
        PAYOUT_RETRY: ['chip-gold', L('发币重试中', 'Retrying Payout')],
        COMPLETED: ['chip-green', L('已完成', 'Completed')],
        REFUND_PENDING: ['chip-gold', L('退款排队中', 'Refund Queued')],
        REFUND_SENT: ['chip-gold', L('退款核验中', 'Verifying Refund')],
        REFUNDED: ['chip-muted', L('已退款', 'Refunded')],
        PAYMENT_EXCEPTION: ['chip-red', L('入账异常 · 待复核', 'Payment Exception')],
        NEEDS_REVIEW: ['chip-red', L('人工复核', 'Review')],
        EXPIRED: ['chip-muted', L('已过期', 'Expired')],
        CANCELLED: ['chip-muted', L('已取消', 'Cancelled')],
      };
      root.innerHTML = `
        <div class="col-gap anim-page-enter">
          <div class="card">
            <div class="card-header">
              <div class="card-title">${icon('receipt', 15)} ${L('购箱小票与退款明细', 'Chest Receipts & Refunds')}</div>
              <span class="chip chip-muted">${orders ? orders.length : '—'}</span>
            </div>
            ${note ? `<div class="num-xs text-muted" style="margin-bottom:8px;">${escapeHtml(note)}</div>` : ''}
            ${!orders || orders.length === 0 ? `
              <div class="empty-state"><div class="num-sm text-muted">${addr ? L('暂无真实订单记录', 'No live orders yet') : L('请先连接钱包后查看真实订单', 'Connect wallet to view live orders')}</div></div>
            ` : `
              <div class="col-gap">
                ${orders.map((o) => {
                  const [cls, txt] = statusMap[o.status] || ['chip-muted', o.status || '—'];
                  const a9 = rawToA9(o.a9AmountRaw) || 0;
                  const gram = Number(BigInt(String(o.tonNano || '0'))) / 1e9;
                  const ts = o.createdAt ? new Date(Number(o.createdAt) * 1000).toLocaleString() : '—';
                  return `
                    <div class="list-row">
                      <div>
                        <div class="num-sm mono">${formatNum(a9, 2)} A9 <span class="num-xs text-muted">(-${formatNum(gram, 2)} GRAM)</span></div>
                        <div class="num-xs text-muted mono">${escapeHtml(o.orderId || '')} · ${escapeHtml(ts)}</div>
                      </div>
                      <span class="chip ${cls}">${txt}</span>
                    </div>
                  `;
                }).join('')}
              </div>
            `}
          </div>
          <button class="btn btn-secondary" data-nav="/internal/market">${icon('arrowLeft', 15)} ${L('返回宝箱商城', 'Back to Chest Mall')}</button>
        </div>
      `;
    };
    if (!addr) {
      paintLiveOrders([], L('连接并验证 TON 钱包后自动同步服务端小票', 'Connect and verify wallet to load receipts'));
      return;
    }
    paintLiveOrders(null, L('正在读取真实订单明细…', 'Loading live orders…'));
    fetchPresaleOrders(addr)
      .then((orders) => { if (root.isConnected) paintLiveOrders(Array.isArray(orders) ? orders : []); })
      .catch((e) => { if (root.isConnected) paintLiveOrders([], e?.message || L('订单读取失败，请重试', 'Failed to load orders')); });
    return;
  }
  const { records } = store.state.market;
  const badgeCls = (st) => st === '已成交' ? 'chip-green' : st === '退款中' ? 'chip-gold' : st === '已退款' ? 'chip-muted' : 'chip-gold';

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <div class="card">
        <div class="card-header">
          <div class="card-title">${icon('receipt', 15)} ${L('兑换小票', 'Exchange Receipts')}</div>
          <span class="chip chip-muted">${records.length}</span>
        </div>
        ${records.length === 0 ? `
          <div class="empty-state"><div class="num-sm text-muted">${L('暂无兑换小票', 'No receipts yet')}</div></div>
        ` : `
          <div class="col-gap">
            ${records.map(r => `
              <div class="list-row">
                <div>
                  <div class="num-sm">${formatNum(r.a9)} A9 <span class="num-xs text-muted">(-${r.ton} GRAM)</span></div>
                  <div class="num-xs text-muted">${r.time} · ${r.hash}</div>
                </div>
                <span class="chip ${badgeCls(r.status)}">${r.status}</span>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    </div>
  `;
}
