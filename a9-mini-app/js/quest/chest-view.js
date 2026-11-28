/**
 * Tab 3 · 宝箱（#/market 及别名 #/internal/market）— A9 Quest 视图层
 *
 * 硬性约束：
 * - 付费购箱开关：同时满足 /api/config 的 presaleHotWallet.open === true 与前端实盘总闸（Demo 放行，Live 只读拦截并提示 LIVE_READONLY_REASON）；
 * - 免费开箱开关：独立读取 /api/config 的 chestMall.openEnabled === true；
 * - Live 模式严格读取 /api/config 下发的 chestMall.skus 与 chestMall.critTiers，缺失时渲染 #live-chest-skus-unavailable，绝不回退演示 SKU；
 * - Live 购箱签名后严禁假开箱：先展示「链上支付确认与热钱包发币中」在途等待态，轮询 fetchPresaleOrders / fetchMyChests 直到订单变为 COMPLETED 且拿到服务端真实结算保底与加赠金额后，才触发开箱剧场动画。
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { loadDemoModule } from '../demo-loader.js';
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast, closeModal } from '../components.js';
import { L } from '../i18n.js';
import { tonConnect, LIVE_READONLY_REASON } from '../tonconnect.js';
import { pendingTxManager } from '../tx-ux.js';
import {
  PROTOCOL_SPECS,
  rawToA9,
  formatRoundA9,
  requestChestPurchaseIntent,
  fetchPresaleOrders,
  fetchMyChests,
  fetchChestCritFeed,
  openChestById,
} from '../data.js';
import {
  qIcon,
  chestArtSvg,
  CHEST_TIER_PALETTE,
  finiteOrNull,
  fmtExactA9,
  fmtIntOrDash,
  openQuestSheet,
} from './quest-ui.js';

let chestViewSeq = 0;

export function settledChestAmounts(order) {
  if (order?.status !== 'COMPLETED') return null;
  const { baseA9Raw, bonusA9Raw, totalA9Raw } = order;
  if (![baseA9Raw, bonusA9Raw, totalA9Raw].every(v => typeof v === 'string' && /^\d+$/.test(v))) return null;
  if (BigInt(baseA9Raw) <= 0n || BigInt(baseA9Raw) + BigInt(bonusA9Raw) !== BigInt(totalA9Raw)) return null;
  return { baseA9Raw, bonusA9Raw, totalA9Raw };
}

/** 打开全屏开箱剧场（仅在 Demo 模拟完成或 Live 服务端 COMPLETED 拿到真实结算后调用）。 */
export function openQuestChestTheater({ tier = 'gold', title = '', baseA9 = 0, bonusA9 = 0, settlement = null, label = '', note = '' } = {}) {
  if (typeof document === 'undefined') return;
  const old = document.getElementById('q-chest-theater');
  if (old) old.remove();

  const pal = CHEST_TIER_PALETTE[String(tier || 'gold').toLowerCase()] || CHEST_TIER_PALETTE.gold;
  const total = Math.max(0, Math.round(Number(baseA9 || 0) + Number(bonusA9 || 0)));
  const amountText = settlement ? formatRoundA9(settlement.totalA9Raw) : `${formatNum(total, 0)} A9`;
  const baseText = settlement ? formatRoundA9(settlement.baseA9Raw) : formatNum(baseA9, 0);
  const bonusText = settlement ? formatRoundA9(settlement.bonusA9Raw) : formatNum(bonusA9, 0);
  const hasBonus = settlement ? BigInt(settlement.bonusA9Raw) > 0n : bonusA9 > 0;
  const el = document.createElement('div');
  el.id = 'q-chest-theater';
  el.className = 'q-theater shaking';
  el.style.setProperty('--glow', pal.glow);
  el.innerHTML = `
    <div class="q-th-title">${escapeHtml(title || L('宝箱已到账', 'CHEST SETTLED'))}</div>
    <div class="q-th-chest">${chestArtSvg(tier, 170)}</div>
    <div class="q-th-result">
      <span class="q-chip q-chip-yellow">${escapeHtml(label || L('已结算到账', 'Settled'))}</span>
      <div class="q-th-amount">${amountText}</div>
      <div class="q-th-split">${hasBonus
        ? L(`保底 ${baseText} + 随机加赠 ${bonusText}`, `Base ${baseText} + Bonus ${bonusText}`)
        : L('固定奖励', 'Fixed reward')}</div>
      <div class="q-th-note">${escapeHtml(note || L('保底与随机加赠已合并为一笔直发你的钱包。', 'Base + bonus settled straight to your wallet.'))}</div>
      <button class="q-btn q-btn-white q-btn-block" id="q-theater-close" type="button">${qIcon('check', 18, 3)} ${L('收下', 'Collect')}</button>
    </div>
  `;
  document.body.appendChild(el);
  A9Audio.confirm();
  setTimeout(() => {
    if (!el.isConnected) return;
    el.classList.remove('shaking');
    el.classList.add('revealed');
    A9Haptic.success();
  }, 700);
  const closeBtn = el.querySelector('#q-theater-close');
  if (closeBtn) closeBtn.onclick = () => el.remove();
}

export function showFreeChestReward(receipt) {
  if (!/^\d+$/.test(receipt?.rewardA9Raw)) {
    showToast(L('开箱结果待同步，请刷新宝箱记录', 'Reward pending. Refresh chest history.'), 'amber');
    return;
  }
  const pending = receipt.destination === 'PENDING_VAULT';
  openQuestChestTheater({
    tier: receipt.chest?.tier || 'bronze',
    title: L('任务宝箱', 'TASK CHEST'),
    baseA9: rawToA9(receipt.rewardA9Raw),
    label: pending ? L('奖励待激活', 'Pending activation') : L('任务奖励', 'Task reward'),
    note: pending ? L('奖励已记入待激活金库。', 'Reward recorded in your pending vault.')
      : L('请在推广余额中查看这笔奖励。', 'Check your promo balance for this reward.'),
  });
}

/** 判定付费购箱是否开放（双闸校验） */
export function resolveChestMallGates(roundState, fundsEnabled) {
  const cfg = roundState?.protocolConfig || {};
  const presaleOpen = Boolean(
    cfg.presaleHotWallet?.open === true || roundState?.presale?.open === true
  );
  const freeOpenEnabled = Boolean(
    roundState?.chestMall?.openEnabled === true || cfg.chestMall?.openEnabled === true
  );
  const canBuyPaid = config.isDemo ? true : Boolean(presaleOpen && fundsEnabled);
  const canOpenFree = config.isDemo ? true : Boolean(freeOpenEnabled && fundsEnabled);
  return { presaleOpen, freeOpenEnabled, canBuyPaid, canOpenFree };
}

/** 渲染 Tab 3 · 宝箱主视图（同时导出为 renderInternalMarket 兼容 router.js 与安全回归测试） */
export function renderChestView(root, _navigate, _param = null, _query = {}) {
  const seq = ++chestViewSeq;
  const isLive = !config.isDemo;

  const state = {
    skus: [],
    critTiers: [],
    feed: [],
    orders: [],
    myChests: null,
    buying: false,
    waitingOrderId: null,
  };

  const resolveCatalog = async () => {
    if (isLive) {
      const mall = store.state.round?.chestMall || store.state.round?.protocolConfig?.chestMall || null;
      state.skus = Array.isArray(mall?.skus) ? mall.skus : [];
      state.critTiers = Array.isArray(mall?.critTiers) ? mall.critTiers : [];
    } else {
      const demo = await loadDemoModule();
      state.skus = Array.isArray(demo?.DEMO_CHEST_SKUS) ? demo.DEMO_CHEST_SKUS : [];
      state.critTiers = [
        { key: 'base', weightPct: 75, minPct: 0, maxPct: 15, zh: '基础区间', en: 'Base Tier' },
        { key: 'high', weightPct: 20, minPct: 15, maxPct: 45, zh: '高区加赠', en: 'High Bonus' },
        { key: 'top', weightPct: 5, minPct: 45, maxPct: 100, zh: '手气爆棚', en: 'Top Roll' },
      ];
    }
  };

  const openBuySheet = (sku) => {
    const u = store.state.user;
    if (!u.connected) {
      tonConnect.openConnectModal(() => renderChestView(root, _navigate, _param, _query));
      return;
    }
    const gates = resolveChestMallGates(store.state.round, store.fundsEnabled);
    const tier = String(sku.tier || 'gold').toLowerCase();
    const pal = CHEST_TIER_PALETTE[tier] || CHEST_TIER_PALETTE.gold;
    const baseA9 = finiteOrNull(sku.baseA9) ?? 0;
    const maxBoost = finiteOrNull(sku.maxBoostA9) ?? 0;
    const maxTotal = baseA9 + maxBoost;
    const priceGram = Number(sku.priceGram || 0);
    const feeGram = Number(sku.deliveryFeeGram ?? PROTOCOL_SPECS.deliveryFeeGram);
    const totalGram = Number(sku.totalPayGram || (priceGram + feeGram));
    const title = L(sku.zh || sku.name || '宝箱', sku.en || sku.name || 'Chest');

    let blockMsg = '';
    if (isLive && !store.fundsEnabled) blockMsg = LIVE_READONLY_REASON;
    else if (isLive && !gates.presaleOpen) blockMsg = L('宝箱商城付费通道暂未开放，请等待官方开启通知。', 'Paid Chest Mall channel is currently closed.');

    openQuestSheet(
      title,
      `
        <div style="display:grid;place-items:center;padding:8px 0 12px;border-radius:16px;background:radial-gradient(circle at 50% 70%, ${pal.soft}, transparent 70%);">
          ${chestArtSvg(tier, 132)}
        </div>
        <div class="q-grid2" style="margin:12px 0;">
          <div class="q-stat"><small>${L('保底必得', 'Guaranteed Base')}</small><b class="q-num">${fmtIntOrDash(baseA9)}</b><span>A9 · 100%</span></div>
          <div class="q-stat"><small>${L('最高可得', 'Max Total')}</small><b class="q-num">${fmtIntOrDash(maxTotal)}</b><span>A9 · +${fmtIntOrDash(maxBoost)}</span></div>
        </div>
        <div class="q-kv"><span>${L('宝箱价格', 'Chest Price')}</span><b>${priceGram} GRAM</b></div>
        <div class="q-kv"><span>${L('配送 Gas', 'Delivery Gas')}</span><b>${feeGram} GRAM</b></div>
        <div class="q-kv"><span>${L('合计支付', 'Total Payment')}</span><b class="red">${totalGram.toFixed(2)} GRAM</b></div>
        <div class="q-foot-note">
          ${L('保底与随机加赠合并为一笔直发钱包；异常或逾期订单原路退回 GRAM（扣 0.03 GRAM Gas）。', 'Base + random bonus sent straight to wallet in one transfer; failed/expired orders auto-refund GRAM minus 0.03 GRAM gas.')}
        </div>
        ${blockMsg ? `<div class="q-notice yellow" style="margin-top:10px;">${qIcon('info', 16)}<span>${escapeHtml(blockMsg)}</span></div>` : ''}
      `,
      {
        footHtml: `<button class="q-btn q-btn-red q-btn-block" id="q-confirm-buy-chest" type="button" ${blockMsg || state.buying || pendingTxManager.isLocked('presale') ? 'disabled' : ''}>
          ${qIcon('chest', 18)} ${blockMsg ? L('暂不可下单', 'Unavailable') : L(`支付 ${totalGram.toFixed(2)} GRAM 开箱`, `Pay ${totalGram.toFixed(2)} GRAM`)}
        </button>`,
      }
    );

    const buyBtn = document.getElementById('q-confirm-buy-chest');
    if (buyBtn && !buyBtn.disabled) {
      buyBtn.onclick = async () => {
        if (state.buying) return;
        state.buying = true;
        buyBtn.disabled = true;
        try {
          if (!isLive) {
            const ok = await tonConnect.confirmBeforeSign({
              title: L(`确认购买 ${title}（演示）`, `Confirm ${title} (Demo)`),
              contractLabel: 'Chest Mall Hot Wallet',
              targetAddress: 'EQD_DEMO_CHEST_MALL',
              principalText: `${fmtIntOrDash(baseA9)} – ${fmtIntOrDash(maxTotal)} A9`,
              gasText: `${feeGram} GRAM`,
              totalText: `${totalGram.toFixed(2)} GRAM`,
            });
            if (!ok) return;
            const demo = await loadDemoModule();
            const receipt = demo.demoBuyChest(store.state, sku.skuId);
            if (receipt.error) throw new Error(receipt.error);
            store.notify();
            closeModal();
            openQuestChestTheater({
              tier,
              title: title.toUpperCase(),
              baseA9: receipt.baseA9,
              bonusA9: receipt.bonusA9,
              label: L('演示开箱', 'Demo Chest'),
              note: L('演示模式：已模拟保底 + 加赠直发到账。', 'Demo mode: simulated direct wallet payout.'),
            });
            return;
          }

          const order = await requestChestPurchaseIntent({
            walletAddress: u.address,
            skuId: sku.skuId,
            openMode: 'INSTANT',
            referrerId: store.state.referral.referrerId,
          });
          const ok = await tonConnect.confirmBeforeSign({
            title: L(`确认支付 ${title}`, `Confirm Payment · ${title}`),
            contractLabel: 'Chest Mall Hot Wallet',
            targetAddress: order.payTo,
            principalText: `${fmtIntOrDash(baseA9)} – ${fmtIntOrDash(maxTotal)} A9`,
            gasText: `${feeGram} GRAM`,
            totalText: `${totalGram.toFixed(2)} GRAM`,
            memo: order.memo || '',
            note: L('支付确认后需等待热钱包自动发币并结算真实加赠金额，到账后自动播放开箱剧场。', 'After signing, wait for on-chain payment confirmation and hot-wallet payout before opening theater plays.'),
          });
          if (!ok) return;

          await tonConnect.sendV15PresaleTx(order);
          closeModal();
          A9Haptic.success();
          state.waitingOrderId = order.orderId || order.id || order.memo;
          paint();

          const tx = pendingTxManager.start({
            kind: 'presale',
            title: `${title} 支付与发币确认`,
            titleEn: `${title} Payout Confirming`,
            amountText: `${totalGram.toFixed(2)} GRAM`,
            explorerAddress: order.payTo,
            refId: state.waitingOrderId,
            targetRoute: '/market',
            maxAttempts: 18,
          });

          showToast(L('已提交支付，正在等待链上确认与热钱包发币…', 'Payment sent, awaiting on-chain confirmation and A9 payout…'));

          // Live 严格时序：轮询 fetchPresaleOrders / fetchMyChests 直到订单 COMPLETED 且拿到服务端真实结算金额
          pendingTxManager.pollUntilConfirmed({
            txId: tx?.id,
            intervalMs: 4000,
            maxAttempts: 18,
            checkFn: async () => {
              const [ordersRes] = await Promise.allSettled([
                fetchPresaleOrders(u.address),
                fetchMyChests(),
              ]);
              const list = ordersRes.status === 'fulfilled' && Array.isArray(ordersRes.value) ? ordersRes.value : [];
              state.orders = list;
              const matched = list.find((o) =>
                (o.orderId && o.orderId === order.orderId) ||
                (o.id && o.id === order.id) ||
                (o.memo && order.memo && o.memo === order.memo)
              );
              const settlement = settledChestAmounts(matched);
              if (settlement) {
                return {
                  confirmed: true,
                  settlement,
                  detail: '热钱包已完成直发，正在开启宝箱。',
                  detailEn: 'Hot-wallet payout settled; opening chest.',
                };
              }
              if (matched && ['FAILED', 'EXPIRED', 'REFUNDED', 'NEEDS_REVIEW'].includes(String(matched.status || '').toUpperCase())) {
                state.waitingOrderId = null;
                showToast(L(`订单状态：${matched.status}，请查看购箱记录`, `Order ${matched.status}. See order history.`), 'amber');
                paint();
                return { terminal: true };
              }
              return false;
            },
            onConfirmed: (res) => {
              state.waitingOrderId = null;
              openQuestChestTheater({
                tier,
                title: title.toUpperCase(),
                settlement: res.settlement,
                label: BigInt(res.settlement.bonusA9Raw) > 0n ? L('已到账 · 随机加赠生效', 'Settled · Bonus Credited') : L('已到账 · 保底直发', 'Settled · Base Payout'),
                note: L('链上支付已确认，热钱包已将保底 + 加赠合并直发至你的钱包。', 'On-chain payment confirmed and payout delivered straight to your wallet.'),
              });
              paint();
            },
            onTimeout: () => {
              state.waitingOrderId = null;
              showToast(L('发币确认耗时较长，请稍后在下方订单记录查看最终状态', 'Payout confirmation taking longer; check your order list below'), 'amber');
              paint();
            },
          });
        } catch (e) {
          A9Haptic.error();
          showToast(e?.message || L('购箱下单失败，请重试', 'Chest order failed'), 'error');
        } finally {
          state.buying = false;
          if (buyBtn && buyBtn.isConnected) buyBtn.disabled = false;
        }
      };
    }
  };

  const paint = () => {
    if (seq !== chestViewSeq || !root.isConnected) return;
    const gates = resolveChestMallGates(store.state.round, store.fundsEnabled);
    const skus = state.skus;
    const orders = isLive ? state.orders : (store.state.market?.records || []).filter(o => o.skuId);

    const starterChest = Array.isArray(state.myChests?.freeChests)
      ? state.myChests.freeChests.find((c) => c.status === 'READY' || c.canOpen)
      : null;

    const freeBannerHtml = starterChest ? `
      <div class="q-row" style="margin-top:12px;padding:10px 12px;border-radius:14px;background:rgba(255,255,255,.6);">
        ${chestArtSvg(starterChest.tier || 'bronze', 44)}
        <div class="q-grow">
          <b style="display:block;font-size:13px;">${escapeHtml(L(starterChest.labelZh || '免费任务宝箱', starterChest.labelEn || 'Free Task Chest'))}</b>
          <span class="q-small">${fmtExactA9(rawToA9(starterChest.baseA9Raw))}</span>
        </div>
        <button class="q-btn q-btn-red q-btn-sm" id="q-open-free-chest" type="button" ${gates.canOpenFree ? '' : 'disabled'}>
          ${gates.canOpenFree ? L('免费开启', 'Open Free') : L('暂未开放', 'Closed')}
        </button>
      </div>
    ` : '';

    const catalogHtml = skus.length === 0 ? `
      <section class="q-card" id="live-chest-skus-unavailable">
        <div class="q-card-h">
          <h3>${qIcon('info', 18)} ${L('宝箱目录暂不可用', 'Chest Catalog Unavailable')}</h3>
          <span class="q-chip q-chip-red">${L('待同步', 'Pending')}</span>
        </div>
        <div class="q-small q-muted" style="line-height:1.55;margin-bottom:10px;">
          ${L('当前未获取到服务端下发的 6 档宝箱目录（/api/config chestMall.skus），请点击重试同步。', 'Server chest catalog (/api/config chestMall.skus) not loaded yet. Tap retry to sync.')}
        </div>
        <button class="q-btn q-btn-ghost q-btn-sm" id="q-chest-retry" type="button">${qIcon('refresh', 15)} ${L('重试同步', 'Retry Sync')}</button>
      </section>
    ` : `
      <div class="q-chest-grid">
        ${skus.map((sku) => {
          const tier = String(sku.tier || 'bronze').toLowerCase();
          const pal = CHEST_TIER_PALETTE[tier] || CHEST_TIER_PALETTE.gold;
          const baseA9 = finiteOrNull(sku.baseA9) ?? 0;
          const maxBoost = finiteOrNull(sku.maxBoostA9) ?? 0;
          const maxTotal = baseA9 + maxBoost;
          const priceGram = Number(sku.priceGram || 0);
          const baseW = maxTotal > 0 ? Math.round((baseA9 / maxTotal) * 100) : 70;
          const perGram = priceGram > 0 ? Math.floor(baseA9 / priceGram) : 0;
          const title = L(sku.zh || sku.name || tier, sku.en || sku.name || tier);
          const isWide = tier === 'legendary';
          return `
            <button type="button" class="q-chest-card ${isWide ? 'wide' : ''}" data-pick-sku="${escapeHtml(sku.skuId)}" style="--tcol:${isWide ? pal.trim : pal.body};--tsoft:${pal.soft};">
              ${isWide ? `<span class="q-ribbon">${L('单价最优', 'Best Rate')}</span>` : ''}
              <div class="q-art">${chestArtSvg(tier, isWide ? 104 : 82)}</div>
              <div class="q-grow" style="display:flex;flex-direction:column;gap:4px;min-width:0;">
                <div class="q-nm">${escapeHtml(title)}</div>
                <div class="q-pr q-num">${priceGram}<small>GRAM</small></div>
                <div class="q-rg">${fmtIntOrDash(baseA9)} – ${fmtIntOrDash(maxTotal)} A9</div>
                <div class="q-range"><i style="width:${baseW}%"></i><em style="left:${baseW}%"></em></div>
                <div class="q-per">${L('每 GRAM 保底', 'Base / GRAM')} <b>${fmtIntOrDash(perGram)}</b> A9</div>
              </div>
            </button>
          `;
        }).join('')}
      </div>
    `;

    const oddsRows = state.critTiers.length > 0 ? state.critTiers : [
      { key: 'base', weightPct: 75, minPct: 0, maxPct: 15, zh: '基础区间', en: 'Base Tier' },
      { key: 'high', weightPct: 20, minPct: 15, maxPct: 45, zh: '高区加赠', en: 'High Bonus' },
      { key: 'top', weightPct: 5, minPct: 45, maxPct: 100, zh: '手气爆棚', en: 'Top Roll' },
    ];

    root.innerHTML = `
      <div class="q-view" id="quest-chest-view">
        <section class="q-mall-hero">
          <div class="q-art">${chestArtSvg('gold', 92)}</div>
          <h2>${L('宝箱商城', 'Chest Mall')}</h2>
          <p>${L('保底 + 随机加赠，合并一笔直发钱包 · 每单配送 Gas 0.06 GRAM', 'Guaranteed base + random bonus straight to wallet · 0.06 GRAM delivery gas')}</p>
          ${freeBannerHtml}
        </section>

        ${state.waitingOrderId ? `
          <div class="q-notice blue" id="q-chest-waiting-banner">
            ${qIcon('clock', 17)}
            <span>${L('链上支付确认与热钱包发币中… 订单到账结算完成后将自动播放开箱剧场。', 'Confirming on-chain payment and hot-wallet payout… Opening theater will launch once settled.')}</span>
          </div>
        ` : ''}

        ${isLive && (!store.fundsEnabled || !gates.presaleOpen) ? `
          <div class="q-notice yellow" id="q-chest-gate-note">
            ${qIcon('info', 16)}
            <span>${!store.fundsEnabled
              ? escapeHtml(LIVE_READONLY_REASON)
              : L('付费宝箱通道当前关闭（presaleHotWallet.open = false），仅开放目录浏览与历史记录查询。', 'Paid Chest Mall channel is closed; catalog browsing and history remain available.')}</span>
          </div>
        ` : ''}

        ${catalogHtml}

        <section class="q-card" id="mall-base-receipt-strip">
          <div class="q-card-h">
            <h3>${qIcon('dice', 18)} ${L('随机加赠概率公示', 'Random Bonus Odds')}</h3>
            <a class="q-chip mall-verify-link" href="#/rules#audit" style="text-decoration:none;">${L('链上核验', 'Verify')} ›</a>
          </div>
          ${oddsRows.map((o) => {
            const w = finiteOrNull(o.weightPct ?? o.chancePct ?? o.probabilityPct) ?? 0;
            const lo = finiteOrNull(o.minPct) ?? 0;
            const hi = finiteOrNull(o.maxPct) ?? 100;
            const barCls = o.key === 'top' || w <= 10 ? 'red' : (w <= 25 ? 'blue' : '');
            return `
              <div class="q-odds-row">
                <span class="q-pc q-num">${w}%</span>
                <div>
                  <b>${escapeHtml(L(o.zh || o.label || '区间', o.en || o.label || 'Tier'))}</b>
                  <small>${L(`随机加赠 = 最大加赠 × ${lo}%–${hi}%`, `Bonus = Max Bonus × ${lo}%–${hi}%`)}</small>
                </div>
                <div class="q-bar ${barCls}" style="margin:0;"><i style="width:${Math.min(100, w)}%"></i></div>
              </div>
            `;
          }).join('')}
        </section>

        <section class="q-card">
          <div class="q-card-h">
            <h3>${qIcon('eye', 18)} ${L('手气爆棚实况', 'Top Roll Feed')}</h3>
            <span class="q-chip q-chip-red">LIVE</span>
          </div>
          ${state.feed.length === 0 ? `
            <div class="q-small q-muted">${L('暂无公开手气爆棚记录。', 'No public top-roll records yet.')}</div>
          ` : `
            <div class="q-feed">
              ${state.feed.slice(0, 6).map((f) => `
                <div class="q-feed-i">
                  ${chestArtSvg(f.tier || 'gold', 34)}
                  <div>
                    <span class="q-who">${escapeHtml(f.maskedWallet || f.who || '—')}</span>
                    <small>${escapeHtml(L(f.skuZh || f.name || '宝箱', f.skuEn || f.name || 'Chest'))}</small>
                  </div>
                  <span class="q-amt q-num">+${fmtIntOrDash(rawToA9(f.totalA9Raw) ?? f.totalA9 ?? f.total)}</span>
                </div>
              `).join('')}
            </div>
          `}
        </section>

        <section class="q-card">
          <div class="q-card-h">
            <h3>${qIcon('book', 18)} ${L('我的购箱记录', 'My Chest Orders')}</h3>
            <span class="q-chip">${orders.length}</span>
          </div>
          ${orders.length === 0 ? `
            <div class="q-small q-muted">${L('暂无购箱订单记录。', 'No chest orders yet.')}</div>
          ` : `
            <div class="q-feed">
              ${orders.slice(0, 6).map((o) => `
                <div class="q-feed-i">
                  ${chestArtSvg(o.tier || 'gold', 34)}
                  <div>
                    <span class="q-who">${escapeHtml(o.skuId || o.orderId || '—')}</span>
                    <small>${escapeHtml(String(o.statusCode || o.status || 'PENDING'))}</small>
                  </div>
                  <span class="q-amt q-num">${isLive ? formatRoundA9(o.totalA9Raw) : fmtExactA9(o.totalA9)}</span>
                </div>
              `).join('')}
            </div>
          `}
        </section>
      </div>
    `;

    const retryBtn = root.querySelector('#q-chest-retry');
    if (retryBtn) retryBtn.onclick = () => window.dispatchEvent(new Event('a9:force-sync'));

    root.querySelectorAll('[data-pick-sku]').forEach((btn) => {
      btn.onclick = () => {
        const hit = skus.find((s) => s.skuId === btn.dataset.pickSku);
        if (hit) openBuySheet(hit);
      };
    });

    const freeBtn = root.querySelector('#q-open-free-chest');
    if (freeBtn && starterChest) {
      freeBtn.onclick = async () => {
        try {
          const res = await openChestById(starterChest.chestId || starterChest.id, store.state, store.state.user.address);
          showFreeChestReward(res);
          void loadAux();
        } catch (e) {
          showToast(e?.message || L('开启免费宝箱失败', 'Failed to open free chest'), 'error');
        }
      };
    }
  };

  const loadAux = async () => {
    await resolveCatalog();
    if (seq !== chestViewSeq || !root.isConnected) return;
    paint();

    const addr = store.state.user.connected ? store.state.user.address : null;
    const [feedRes, ordersRes, chestsRes] = await Promise.allSettled([
      fetchChestCritFeed(8),
      (isLive && addr) ? fetchPresaleOrders(addr) : Promise.resolve([]),
      fetchMyChests(),
    ]);
    if (seq !== chestViewSeq || !root.isConnected) return;
    if (feedRes.status === 'fulfilled' && Array.isArray(feedRes.value)) state.feed = feedRes.value;
    if (ordersRes.status === 'fulfilled' && Array.isArray(ordersRes.value)) state.orders = ordersRes.value;
    if (chestsRes.status === 'fulfilled' && chestsRes.value) state.myChests = chestsRes.value;
    paint();
  };

  void loadAux();
}

export { renderChestView as renderInternalMarket };
