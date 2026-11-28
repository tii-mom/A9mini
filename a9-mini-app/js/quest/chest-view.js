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
import { A9Haptic, A9TMA, isReducedMotion } from '../tma.js';
import { A9Audio } from '../audio.js';
import { escapeHtml, formatNum, showToast, closeModal } from '../components.js';
import { L } from '../i18n.js';
import { tonConnect, canonicalWalletKey, LIVE_READONLY_REASON } from '../tonconnect.js';
import { pendingTxManager } from '../tx-ux.js';
import {
  PROTOCOL_SPECS,
  serverNowMs,
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
  fmtRawGramOrDash,
  openQuestSheet,
} from './quest-ui.js';

let chestViewSeq = 0;
const shownCompletedOrders = new Set();
/** 仅内存保存本会话内「明确未发送」的待支付订单（跨会话/重开/换设备天然为空，严禁落盘） */
const confirmedUnsentOrders = new Map();

export function isExplicitWalletRejection(err) {
  return err?.code === 'USER_REJECTED';
}

export function evaluatePresaleOrderResume({
  order,
  wallet,
  network = config.network,
  confirmedUnsent = false,
  fundsEnabled = false,
  presaleOpen = false,
  isLocked = false,
  nowMs = Date.now(),
} = {}) {
  if (!order) return { allowed: false, reason: 'NO_ORDER' };
  const status = normalizePresaleOrderStatus(order);
  if (status !== 'PENDING_PAYMENT' || order.inboundTxHash || order.payoutTxHash || order.refundTxHash) return { allowed: false, reason: 'NOT_PENDING' };
  if (!fundsEnabled || !presaleOpen) return { allowed: false, reason: 'GATE_CLOSED' };
  if (isLocked) return { allowed: false, reason: 'TX_LOCKED' };
  if (!confirmedUnsent) return { allowed: false, reason: 'AMBIGUOUS_CHECK_ONLY' };
  const orderWallet = order.walletAddress || order.wallet || '';
  if (!orderWallet || !wallet || canonicalWalletKey(orderWallet) !== canonicalWalletKey(wallet)) {
    return { allowed: false, reason: 'WALLET_MISMATCH' };
  }
  if (order.network && network && String(order.network).toLowerCase() !== String(network).toLowerCase()) {
    return { allowed: false, reason: 'NETWORK_MISMATCH' };
  }
  const expSec = Number(order.expiresAt);
  if (!Number.isSafeInteger(expSec) || expSec <= 0) return { allowed: false, reason: 'INCOMPLETE_ORDER' };
  if (expSec * 1000 <= nowMs + 30_000) {
    return { allowed: false, reason: 'EXPIRED' };
  }
  const payNano = String(order.payTonNano ?? '').trim();
  const orderId = order.orderId || order.id;
  if (!order.payTo || !orderId || order.memo !== `buy:${orderId}` || !/^\d+$/.test(payNano) || BigInt(payNano) <= 0n) {
    return { allowed: false, reason: 'INCOMPLETE_ORDER' };
  }
  return { allowed: true, reason: 'CONFIRMED_UNSENT' };
}

function formatCatalogGram(value, minimumFractionDigits = 0) {
  const n = finiteOrNull(value);
  if (n === null || n <= 0) return null;
  return n.toLocaleString('en-US', { minimumFractionDigits, maximumFractionDigits: 9 });
}

function getOrderTxExplorerUrl(txHash) {
  const h = String(txHash || '').trim();
  if (!h) return '';
  const isTest = config.network === 'testnet' || String(store.state.round?.protocolConfig?.network || '').toLowerCase() === 'testnet';
  return `${isTest ? 'https://testnet.tonviewer.com/transaction/' : 'https://tonviewer.com/transaction/'}${encodeURIComponent(h)}`;
}

/** 对齐 worker/src/presale-hotwallet.mjs 的 normalizeOrderStatus */
export function normalizePresaleOrderStatus(order) {
  const raw = String(order?.statusCode || order?.status || '').trim().toUpperCase();
  if (!raw) return 'UNKNOWN';
  switch (raw) {
    case 'PENDING_TON':
    case 'AWAITING_PAYMENT':
      return 'PENDING_PAYMENT';
    case 'PAID_A9':
      return order?.payoutTxHash ? 'PAYOUT_SENT' : 'NEEDS_REVIEW';
    case 'REFUNDED_FREE':
    case 'REFUNDED_MINUS_FEE':
      return 'REFUNDED';
    case 'PAYMENT_CONFIRMING':
    case 'CONFIRMING':
      return 'PAYMENT_CONFIRMED';
    case 'PAID':
    case 'PAYING':
      return 'PAYOUT_PENDING';
    case 'BROADCASTED':
      return 'PAYOUT_SENT';
    default:
      return raw;
  }
}

/** 统一订单状态分类、横幅与中英文标签（覆盖 Worker PRESALE_STATUS 全枚举） */
export function describePresaleOrderStatus(order) {
  const status = normalizePresaleOrderStatus(order);
  const table = {
    PENDING_PAYMENT: { group: 'unpaid', inFlight: false, zh: '待支付', en: 'Awaiting Payment', bannerZh: '你有待支付宝箱订单，完成链上转账后将自动进入发币队列。', bannerEn: 'You have an unpaid chest order; transfer GRAM to enter the payout queue.' },
    PAYMENT_CONFIRMED: { group: 'payout', inFlight: true, zh: '支付已确认 · 排队发币', en: 'Payment Confirmed · Queuing A9', bannerZh: '支付已确认，正在排队合并直发保底 + 随机加赠，到账后自动开箱。', bannerEn: 'Payment confirmed; queuing direct A9 payout. Chest theater will open once settled.' },
    PAYOUT_PENDING: { group: 'payout', inFlight: true, zh: '发币排队中', en: 'Payout Queued', bannerZh: '订单已进入热钱包发币队列，到账后自动开箱。', bannerEn: 'Payout queued for hot-wallet dispatch; theater opens automatically on settlement.' },
    PAYOUT_SENT: { group: 'payout', inFlight: true, zh: '发币已发送 · 等待确认', en: 'Payout Sent · Confirming', bannerZh: '热钱包已发送 A9，正在核验链上最终确认，到账后自动开箱。', bannerEn: 'A9 payout sent; awaiting on-chain finality before opening chest.' },
    PAYOUT_RETRY: { group: 'payout', inFlight: true, zh: '发币重试中', en: 'Payout Retrying', bannerZh: '热钱包发币正在自动重试确认中，请耐心等待（绝不重复扣款）。', bannerEn: 'Hot-wallet payout is retrying automatically; awaiting confirmation.' },
    COMPLETED: { group: 'completed', inFlight: false, zh: '已到账', en: 'Completed' },
    PAYMENT_EXCEPTION: { group: 'review', inFlight: false, zh: '支付异常 · 待人工核查', en: 'Payment Exception · Review' },
    NEEDS_REVIEW: { group: 'review', inFlight: false, zh: '待人工核查', en: 'Needs Manual Review' },
    REFUND_PENDING: { group: 'refund', inFlight: false, zh: '退款处理中', en: 'Refund Pending' },
    REFUND_SENT: { group: 'refund', inFlight: false, zh: '退款已发送', en: 'Refund Sent' },
    REFUNDED: { group: 'refund', inFlight: false, zh: '已退款', en: 'Refunded' },
    EXPIRED: { group: 'terminal', inFlight: false, zh: '已过期', en: 'Expired' },
    CANCELLED: { group: 'terminal', inFlight: false, zh: '已取消', en: 'Cancelled' },
    DUST_IGNORED: { group: 'terminal', inFlight: false, zh: '小额粉尘已忽略', en: 'Dust Ignored' },
    FAILED: { group: 'terminal', inFlight: false, zh: '失败', en: 'Failed' },
  };
  const meta = table[status] || { group: 'unknown', inFlight: false, zh: '状态待核实', en: status || 'Pending' };
  return { status, ...meta, label: L(meta.zh, meta.en) };
}

/** 校验并计算宝箱随机加赠数学期望（严格校验权重和 = 100%） */
export function computeChestOddsSummary(critTiers = []) {
  const rows = (Array.isArray(critTiers) ? critTiers : []).filter((o) => {
    const values = [o?.weight, o?.minRatio, o?.maxRatio];
    return values.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
      o.weight >= 0 && o.weight <= 100 && o.minRatio >= 0 && o.maxRatio <= 1 && o.minRatio <= o.maxRatio;
  });
  if (!rows.length) return { rows: [], valid: false, invalidWeight: false, meanMaxRatio: null };
  const weightSum = rows.reduce((s, o) => s + o.weight, 0);
  if (Math.abs(weightSum - 100) >= 0.01) {
    return { rows, valid: false, invalidWeight: true, meanMaxRatio: null };
  }
  const meanMaxRatio = rows.reduce((s, o) => s + (o.weight / 100) * ((o.minRatio + o.maxRatio) / 2), 0);
  return { rows, valid: true, invalidWeight: false, meanMaxRatio };
}

export function computeSkuExpectedStats(sku, critTiers = []) {
  const odds = computeChestOddsSummary(critTiers);
  const baseA9 = finiteOrNull(sku?.baseA9) ?? 0;
  const maxBoostA9 = finiteOrNull(sku?.maxBoostA9) ?? 0;
  if (!odds.valid || odds.meanMaxRatio === null || maxBoostA9 <= 0) {
    return { valid: false, approxBonusA9: null, approxTotalA9: null, pctOfMaxBoost: null, pctOfBase: null };
  }
  const approxBonusA9 = maxBoostA9 * odds.meanMaxRatio;
  const approxTotalA9 = baseA9 + approxBonusA9;
  const pctOfMaxBoost = odds.meanMaxRatio * 100;
  const pctOfBase = baseA9 > 0 ? (approxBonusA9 / baseA9) * 100 : null;
  return { valid: true, approxBonusA9, approxTotalA9, pctOfMaxBoost, pctOfBase };
}

function fmtApproxA9(val) {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) return '—';
  const n = Number(val);
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? formatNum(rounded, 0) : formatNum(rounded, 1);
}

export function settledChestAmounts(order) {
  if (normalizePresaleOrderStatus(order) !== 'COMPLETED') return null;
  const { baseA9Raw, bonusA9Raw, totalA9Raw } = order;
  if (![baseA9Raw, bonusA9Raw, totalA9Raw].every(v => typeof v === 'string' && /^\d+$/.test(v))) return null;
  if (BigInt(baseA9Raw) <= 0n || BigInt(baseA9Raw) + BigInt(bonusA9Raw) !== BigInt(totalA9Raw)) return null;
  return { baseA9Raw, bonusA9Raw, totalA9Raw };
}

let activeTheaterDismiss = null;

/** 打开全屏开箱剧场（仅在 Demo 模拟完成或 Live 服务端 COMPLETED 拿到真实结算后调用）。 */
export function openQuestChestTheater({ tier = 'gold', title = '', baseA9 = 0, bonusA9 = 0, settlement = null, label = '', note = '', remainingCount = 0, onClose = null, onDismissAll = null } = {}) {
  if (typeof document === 'undefined') return;
  if (typeof activeTheaterDismiss === 'function') {
    activeTheaterDismiss({ silent: true });
  }
  const old = document.getElementById('q-chest-theater');
  if (old) old.remove();

  const pal = CHEST_TIER_PALETTE[String(tier || 'gold').toLowerCase()] || CHEST_TIER_PALETTE.gold;
  const total = Math.max(0, Math.round(Number(baseA9 || 0) + Number(bonusA9 || 0)));
  const amountText = settlement ? formatRoundA9(settlement.totalA9Raw) : `${formatNum(total, 0)} A9`;
  const baseText = settlement ? formatRoundA9(settlement.baseA9Raw) : formatNum(baseA9, 0);
  const bonusText = settlement ? formatRoundA9(settlement.bonusA9Raw) : formatNum(bonusA9, 0);
  const hasBonus = settlement ? BigInt(settlement.bonusA9Raw) > 0n : bonusA9 > 0;
  const rem = Number.isInteger(remainingCount) && remainingCount > 0 ? remainingCount : 0;
  const el = document.createElement('div');
  const previousFocus = document.activeElement;
  const coins = Array.from({ length: 22 }, (_, i) => {
    const angle = (i + 0.5) * Math.PI / 22;
    const distance = 88 + (i * 23 % 63);
    return `<i style="--dx:${Math.round(Math.cos(angle) * distance)}px;--dy:${-Math.round(45 + Math.sin(angle) * distance)}px;--delay:${i % 4 * 35}ms"></i>`;
  }).join('');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', L('开箱结果', 'Chest result'));
  el.id = 'q-chest-theater';
  el.className = 'q-theater shaking';
  el.style.setProperty('--glow', pal.glow);
  el.innerHTML = `
    <div class="q-th-title">${escapeHtml(title || L('宝箱已到账', 'CHEST SETTLED'))}${rem > 0 ? ` <span class="q-chip q-chip-yellow" style="margin-left:6px;vertical-align:middle;">${L(`还有 ${rem} 个`, `${rem} more`)}</span>` : ''}</div>
    <div class="q-th-chest">${chestArtSvg(tier, 170)}<div class="q-coins" aria-hidden="true">${coins}</div></div>
    <div class="q-th-result">
      <span class="q-chip q-chip-yellow">${escapeHtml(label || L('已结算到账', 'Settled'))}</span>
      <div class="q-th-amount">${amountText}</div>
      <div class="q-th-split">${hasBonus
        ? L(`保底 ${baseText} + 随机加赠 ${bonusText}`, `Base ${baseText} + Bonus ${bonusText}`)
        : L('固定奖励', 'Fixed reward')}</div>
      <div class="q-th-note">${escapeHtml(note || L('保底与随机加赠已合并为一笔直发你的钱包。', 'Base + bonus settled straight to your wallet.'))}</div>
      <button class="q-btn q-btn-white q-btn-block" id="q-theater-close" type="button">${qIcon('check', 18, 3)} ${rem > 0 ? L(`收下 · 还有 ${rem} 个`, `Collect · ${rem} more`) : L('收下', 'Collect')}</button>
    </div>
  `;
  document.body.appendChild(el);
  A9Audio.confirm();
  const reduced = Boolean(isReducedMotion() || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  let revealTimer = null;
  let closed = false;
  const closeTheater = ({ silent = false, routeLeave = false } = {}) => {
    if (closed) return;
    closed = true;
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    document.removeEventListener('keydown', onKeydown);
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', onRouteLeave);
    if (activeTheaterDismiss === closeTheater) activeTheaterDismiss = null;
    if (el.isConnected) el.remove();
    if (!routeLeave) previousFocus?.focus?.({ preventScroll: true });
    if (routeLeave) {
      if (typeof onDismissAll === 'function') onDismissAll();
    } else if (!silent && typeof onClose === 'function') {
      onClose();
    }
  };
  const onRouteLeave = () => closeTheater({ routeLeave: true });
  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeTheater();
      return;
    }
    if (e.key === 'Tab') {
      const btn = el.querySelector('#q-theater-close');
      if (btn) {
        e.preventDefault();
        btn.focus?.({ preventScroll: true });
      }
    }
  };
  activeTheaterDismiss = closeTheater;
  document.addEventListener('keydown', onKeydown);
  if (typeof window !== 'undefined') window.addEventListener('hashchange', onRouteLeave);
  const reveal = () => {
    revealTimer = null;
    if (closed || !el.isConnected) return;
    el.classList.remove('shaking');
    el.classList.add('revealed');
    el.querySelector('#q-theater-close')?.focus?.({ preventScroll: true });
    A9Haptic.success();
  };
  if (reduced) reveal();
  else revealTimer = setTimeout(reveal, 700);
  const closeBtn = el.querySelector('#q-theater-close');
  if (closeBtn) closeBtn.onclick = () => closeTheater();
}

export function showFreeChestReward(receipt) {
  if (!/^\d+$/.test(receipt?.rewardA9Raw)) {
    showToast(L('开箱结果待同步，请刷新宝箱记录', 'Reward pending. Refresh chest history.'), 'amber');
    return;
  }
  const dest = String(receipt.destination || '').toUpperCase();
  const pending = dest === 'PENDING_VAULT';
  const directWallet = dest === 'WALLET' || dest === 'DIRECT_WALLET';
  openQuestChestTheater({
    tier: receipt.chest?.tier || 'bronze',
    title: L('任务宝箱', 'TASK CHEST'),
    baseA9: rawToA9(receipt.rewardA9Raw),
    label: directWallet
      ? L('已直发钱包', 'Sent to wallet')
      : pending
        ? L('待激活金库', 'Pending activation')
        : L('已入推广余额', 'Promo balance'),
    note: directWallet
      ? L('奖励已直发至你的钱包。', 'Reward sent directly to your wallet.')
      : pending
        ? L('奖励已记入待激活金库，完成激活条件后可在金库领取。', 'Reward recorded in your pending vault; activate then claim in Vault.')
        : L('奖励已记入站内推广余额，可在金库通过 0.06 GRAM 一键领币。', 'Reward added to your promo balance; claim via 0.06 GRAM in Vault.'),
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
  if (typeof activeTheaterDismiss === 'function') activeTheaterDismiss({ routeLeave: true });
  const isLive = !config.isDemo;

  const activePendingPresale = pendingTxManager.getActive();
  let auxSeq = 0;
  let recoveryTimer = null;
  let recoveryWallet = null;
  const trackedOrderIds = new Set();
  const orderKey = (o) => String(o?.orderId || o?.id || o?.memo || '');
  if (activePendingPresale?.kind === 'presale') {
    const initId = String(activePendingPresale.refId || activePendingPresale.id || '');
    if (initId) trackedOrderIds.add(initId);
  }
  const stopRecoveryPoller = () => {
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
    recoveryWallet = null;
  };
  const state = {
    skus: [],
    critTiers: [],
    feed: [],
    orders: [],
    myChests: null,
    buying: false,
    openingFree: false,
    waitingOrderId: activePendingPresale?.kind === 'presale' ? (activePendingPresale.refId || activePendingPresale.id) : null,
    waitingOrder: null,
    waitingOrders: [],
  };

  const revealQueue = [];
  let theaterOpen = false;
  const flushRevealQueue = () => {
    if (theaterOpen || !revealQueue.length) return;
    if (seq !== chestViewSeq || !root.isConnected) {
      revealQueue.length = 0;
      return;
    }
    const next = revealQueue.shift();
    if (!next || store.state.user.address !== next.wallet) {
      flushRevealQueue();
      return;
    }
    theaterOpen = true;
    openQuestChestTheater({
      ...next.opts,
      remainingCount: revealQueue.length,
      onClose: () => {
        theaterOpen = false;
        flushRevealQueue();
      },
      onDismissAll: () => {
        theaterOpen = false;
        revealQueue.length = 0;
      },
    });
  };

  const revealCompletedOrderOnce = (wallet, order, settlement, { deferFlush = false } = {}) => {
    const oid = orderKey(order);
    if (!oid || !settlement) return false;
    const dedupKey = `${wallet || 'anon'}:${oid}`;
    if (shownCompletedOrders.has(dedupKey)) return false;
    shownCompletedOrders.add(dedupKey);
    const matchedSku = state.skus.find((s) => s.skuId === order.skuId);
    const tier = String(matchedSku?.tier || order.tier || 'gold').toLowerCase();
    const title = L(matchedSku?.zh || '宝箱', matchedSku?.en || 'Chest');
    revealQueue.push({
      wallet,
      opts: {
        tier,
        title: `${title.toUpperCase()} · #${oid.slice(-6)}`,
        settlement,
        label: BigInt(settlement.bonusA9Raw) > 0n ? L('已到账 · 随机加赠生效', 'Settled · Bonus Credited') : L('已到账 · 保底直发', 'Settled · Base Payout'),
        note: L(`订单 ${oid} 已确认直发至你的钱包。`, `Order ${oid} settled straight to your wallet.`),
      },
    });
    if (!deferFlush) flushRevealQueue();
    return true;
  };

  const processOrdersUpdate = (wallet, list) => {
    if (seq !== chestViewSeq || !root.isConnected || store.state.user.address !== wallet) {
      stopRecoveryPoller();
      return false;
    }
    state.orders = list;
    const completedToReveal = [];
    const terminalNotices = [];
    const inFlightList = [];
    for (const o of list) {
      const oid = orderKey(o);
      const desc = describePresaleOrderStatus(o);
      if (desc.inFlight) {
        inFlightList.push(o);
        if (oid) trackedOrderIds.add(oid);
      } else if (oid && trackedOrderIds.has(oid)) {
        trackedOrderIds.delete(oid);
        const settlement = settledChestAmounts(o);
        if (settlement) {
          completedToReveal.push({ order: o, settlement });
        } else if (desc.group === 'refund' || desc.group === 'review' || desc.group === 'terminal') {
          terminalNotices.push({ oid, desc });
        }
      }
    }
    state.waitingOrders = inFlightList;
    state.waitingOrder = inFlightList[0] || null;
    state.waitingOrderId = inFlightList[0] ? orderKey(inFlightList[0]) : null;
    paint();
    for (const item of completedToReveal) {
      revealCompletedOrderOnce(wallet, item.order, item.settlement, { deferFlush: true });
    }
    if (completedToReveal.length > 0) flushRevealQueue();
    for (const notice of terminalNotices) {
      showToast(L(`订单 ${notice.oid} 状态更新：${notice.desc.zh}`, `Order ${notice.oid}: ${notice.desc.en}`), 'amber');
    }
    if (inFlightList.length > 0) {
      scheduleOrderRecovery(wallet);
      return true;
    }
    stopRecoveryPoller();
    return false;
  };

  const scheduleOrderRecovery = (wallet) => {
    const pollMs = Number(typeof window !== 'undefined' && window.__A9_TEST_POLL_MS__) || 3500;
    if (!isLive || !wallet) return;
    if (recoveryTimer && recoveryWallet === wallet) return;
    stopRecoveryPoller();
    recoveryWallet = wallet;
    let attempts = 0;
    const tick = async () => {
      recoveryTimer = null;
      if (seq !== chestViewSeq || !root.isConnected || store.state.user.address !== wallet) {
        stopRecoveryPoller();
        return;
      }
      attempts += 1;
      let keepGoing = false;
      try {
        const list = await fetchPresaleOrders(wallet);
        if (seq !== chestViewSeq || !root.isConnected || store.state.user.address !== wallet) {
          stopRecoveryPoller();
          return;
        }
        if (Array.isArray(list)) {
          keepGoing = processOrdersUpdate(wallet, list);
          return;
        }
      } catch (_) {
        keepGoing = state.waitingOrders.length > 0;
      }
      if (keepGoing && attempts < 24 && seq === chestViewSeq && root.isConnected && store.state.user.address === wallet) {
        recoveryTimer = setTimeout(tick, pollMs);
      } else {
        stopRecoveryPoller();
      }
    };
    recoveryTimer = setTimeout(tick, pollMs);
  };

  const resolveCatalog = async () => {
    if (isLive) {
      const mall = store.state.round?.chestMall || store.state.round?.protocolConfig?.chestMall || null;
      state.skus = Array.isArray(mall?.skus) ? mall.skus : [];
      state.critTiers = Array.isArray(mall?.critTiers) ? mall.critTiers : [];
    } else {
      const demo = await loadDemoModule();
      state.skus = Array.isArray(demo?.DEMO_CHEST_SKUS) ? demo.DEMO_CHEST_SKUS : [];
      state.critTiers = demo.DEMO_PAID_CHEST_CRIT_TIERS;
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
    const baseA9 = finiteOrNull(sku.baseA9);
    const maxBoost = finiteOrNull(sku.maxBoostA9);
    const maxTotal = baseA9 !== null && maxBoost !== null ? baseA9 + maxBoost : null;
    const receiptRange = maxTotal === null ? '—' : `${fmtIntOrDash(baseA9)} – ${fmtIntOrDash(maxTotal)} A9`;
    const evStats = maxTotal === null ? null : computeSkuExpectedStats(sku, state.critTiers);
    const priceGram = finiteOrNull(sku.priceGram);
    const feeGram = finiteOrNull(sku.deliveryFeeGram ?? PROTOCOL_SPECS.deliveryFeeGram);
    const totalGram = sku.totalPayGram ?? (priceGram === null || feeGram === null ? null : priceGram + feeGram);
    const priceText = formatCatalogGram(priceGram);
    const feeText = formatCatalogGram(feeGram);
    const totalText = formatCatalogGram(totalGram, 2);
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
          <div class="q-stat"><small>${L('保底', 'Guaranteed')}</small><b class="q-num">${fmtIntOrDash(baseA9)}</b>${baseA9 === null ? '' : '<span>A9</span>'}</div>
          <div class="q-stat"><small>${L('最高可得', 'Maximum')}</small><b class="q-num">${fmtIntOrDash(maxTotal)}</b>${maxTotal === null ? '' : `<span>A9 · +${fmtIntOrDash(maxBoost)}</span>`}</div>
        </div>
        ${evStats?.valid ? `
          <div class="q-kv"><span>${L('平均加赠', 'Avg bonus')}</span><b class="q-num">${L(`约 ${fmtApproxA9(evStats.approxBonusA9)} A9`, `~${fmtApproxA9(evStats.approxBonusA9)} A9`)}</b></div>
          <div class="q-kv"><span>${L('加赠占比', 'Bonus share')}</span><b class="q-num" style="font-size:11px;">${L(`最大加赠的 ${evStats.pctOfMaxBoost.toFixed(2)}%${evStats.pctOfBase !== null ? ` · 约占保底 ${evStats.pctOfBase.toFixed(2)}%` : ''}`, `${evStats.pctOfMaxBoost.toFixed(2)}% of max bonus${evStats.pctOfBase !== null ? ` · ~${evStats.pctOfBase.toFixed(2)}% of base` : ''}`)}</b></div>
          <div class="q-kv"><span>${L('平均到手', 'Avg total')}</span><b class="q-num">${L(`约 ${fmtApproxA9(evStats.approxTotalA9)} A9`, `~${fmtApproxA9(evStats.approxTotalA9)} A9`)}</b></div>
        ` : ''}
        <div class="q-kv"><span>${L('宝箱价格', 'Chest Price')}</span><b class="q-num">${priceText ? `${priceText} GRAM` : '—'}</b></div>
        <div class="q-kv"><span>${L('配送费', 'Delivery Gas')}</span><b class="q-num">${feeText ? `${feeText} GRAM` : '—'}</b></div>
        <div class="q-kv"><span>${L('合计支付', 'Total Payment')}</span><b class="red q-num">${totalText ? `${totalText} GRAM` : '—'}</b></div>
        <div class="q-foot-note">
          ${L('保底与加赠合并直发。异常或逾期退款扣 0.03 GRAM 网络费。', 'Base and bonus arrive together. Failed or expired orders refund minus 0.03 GRAM gas.')}
        </div>
        ${blockMsg ? `<div class="q-notice yellow" style="margin-top:10px;">${qIcon('info', 16)}<span>${escapeHtml(blockMsg)}</span></div>` : ''}
      `,
      {
        footHtml: `<button class="q-btn q-btn-red q-btn-block" id="q-confirm-buy-chest" type="button" ${blockMsg || state.buying || pendingTxManager.isLocked('presale') ? 'disabled' : ''}>
          ${qIcon('chest', 18)} ${blockMsg ? L('暂不可下单', 'Unavailable') : totalText ? L(`支付 ${totalText} GRAM`, `Pay ${totalText} GRAM`) : L('下单', 'Place order')}
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
              principalText: receiptRange,
              gasText: feeText ? `${feeText} GRAM` : '—',
              totalText: totalText ? `${totalText} GRAM` : '—',
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
          const unsentKey = `${canonicalWalletKey(u.address)}:${orderKey(order)}`;
          const orderPayment = fmtRawGramOrDash(order.payTonNano || order.tonNano);
          const orderDeliveryFee = fmtRawGramOrDash(order.deliveryFeeNano);
          let explicitlyCancelled = false;
          const ok = await tonConnect.confirmBeforeSign({
            onDismiss: reason => { explicitlyCancelled = reason === 'user_cancel'; },
            title: L(`确认支付 ${title}`, `Confirm Payment · ${title}`),
            contractLabel: 'Chest Mall Hot Wallet',
            targetAddress: order.payTo,
            principalText: receiptRange,
            gasText: orderDeliveryFee === '—' && feeText ? `${feeText} GRAM` : orderDeliveryFee,
            totalText: orderPayment,
            memo: order.memo || '',
            note: L('支付确认后需等待热钱包自动发币并结算真实加赠金额，到账后自动播放开箱剧场。', 'After signing, wait for on-chain payment confirmation and hot-wallet payout before opening theater plays.'),
          });
          if (!ok) {
            if (explicitlyCancelled && orderKey(order)) confirmedUnsentOrders.set(unsentKey, { network: config.network, at: Date.now() });
            return;
          }
          if (u.address !== store.state.user.address || pendingTxManager.isLocked('presale')) return;

          confirmedUnsentOrders.delete(unsentKey);
          try {
            await tonConnect.sendV15PresaleTx(order);
          } catch (sendErr) {
            if (isExplicitWalletRejection(sendErr) && orderKey(order)) {
              confirmedUnsentOrders.set(unsentKey, { network: config.network, at: Date.now() });
            }
            throw sendErr;
          }
          closeModal();
          A9Haptic.success();
          const newOrderId = orderKey(order);
          if (newOrderId) trackedOrderIds.add(newOrderId);
          state.waitingOrderId = newOrderId;
          paint();

          const tx = pendingTxManager.start({
            kind: 'presale',
            title: `${title} 支付与发币确认`,
            titleEn: `${title} Payout Confirming`,
            amountText: orderPayment,
            explorerAddress: order.payTo,
            refId: newOrderId,
            targetRoute: '/market',
            maxAttempts: 18,
          });

          showToast(L('已提交支付，正在等待链上确认与热钱包发币…', 'Payment sent, awaiting on-chain confirmation and A9 payout…'));

          // Live 严格时序：轮询 fetchPresaleOrders / fetchMyChests，统一经 processOrdersUpdate 更新同钱包完整订单列表，不误停其他在途订单
          pendingTxManager.pollUntilConfirmed({
            txId: tx?.id,
            intervalMs: Number(typeof window !== 'undefined' && window.__A9_TEST_POLL_MS__) || 4000,
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
                  order: matched || order,
                  ordersList: list,
                  settlement,
                  detail: '热钱包已完成直发，正在开启宝箱。',
                  detailEn: 'Hot-wallet payout settled; opening chest.',
                };
              }
              if (matched) {
                const desc = describePresaleOrderStatus(matched);
                if (!desc.inFlight && desc.group !== 'unpaid' && desc.group !== 'completed') {
                  if (seq === chestViewSeq && root.isConnected && store.state.user.address === u.address) {
                    processOrdersUpdate(u.address, list);
                  }
                  return { terminal: true };
                }
              }
              return false;
            },
            onConfirmed: (res) => {
              if (seq !== chestViewSeq || !root.isConnected || store.state.user.address !== u.address) return;
              const fullList = Array.isArray(res?.ordersList) ? res.ordersList : state.orders;
              processOrdersUpdate(u.address, fullList);
              revealCompletedOrderOnce(u.address, res?.order || order, res.settlement);
            },
            onTimeout: () => {
              if (seq === chestViewSeq && root.isConnected && store.state.user.address === u.address) {
                processOrdersUpdate(u.address, state.orders);
              }
              showToast(L('发币确认耗时较长，请稍后在下方订单记录查看最终状态', 'Payout confirmation taking longer; check your order list below'), 'amber');
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

  const openOrderDetailSheet = (initialOrder) => {
    if (!initialOrder) return;
    const targetId = orderKey(initialOrder);
    let curOrder = initialOrder;
    let refreshing = false;
    let resuming = false;

    const renderDetail = () => {
      const wallet = store.state.user.address || '';
      const gates = resolveChestMallGates(store.state.round, store.fundsEnabled);
      const desc = describePresaleOrderStatus(curOrder);
      const skuHit = state.skus.find((s) => s.skuId === curOrder.skuId);
      const title = L(skuHit?.zh || '宝箱订单', skuHit?.en || 'Chest Order');
      const demoGram = !isLive ? formatCatalogGram(curOrder.ton, 2) : null;
      const payGramText = demoGram ? `${demoGram} GRAM` : fmtRawGramOrDash(curOrder.payTonNano || curOrder.tonNano);
      const a9Display = isLive
        ? formatRoundA9(curOrder.totalA9Raw ?? curOrder.baseA9Raw ?? curOrder.a9AmountRaw)
        : fmtExactA9(curOrder.totalA9 ?? curOrder.a9);
      const expSec = Number(curOrder.expiresAt);
      const expText = Number.isFinite(expSec) && expSec > 0 ? new Date(expSec * 1000).toLocaleString() : '—';
      const txHash = curOrder.payoutTxHash || curOrder.refundTxHash || curOrder.txHash || curOrder.hash || '';
      const txUrl = isLive && txHash ? getOrderTxExplorerUrl(txHash) : '';
      const unsentKey = wallet && targetId ? `${canonicalWalletKey(wallet)}:${targetId}` : '';
      const unsentRecord = unsentKey ? confirmedUnsentOrders.get(unsentKey) : null;
      const resumeEval = isLive ? evaluatePresaleOrderResume({
        order: curOrder,
        wallet,
        network: config.network,
        confirmedUnsent: Boolean(unsentRecord && unsentRecord.network === config.network),
        fundsEnabled: store.fundsEnabled,
        presaleOpen: gates.presaleOpen,
        isLocked: pendingTxManager.isLocked('presale'),
        nowMs: serverNowMs(),
      }) : { allowed: false, reason: 'DEMO' };
      const isPendingPay = desc.status === 'PENDING_PAYMENT';

      openQuestSheet(
        L(`订单详情 · ${title}`, `Order Detail · ${title}`),
        `
          <div id="q-chest-order-detail-sheet" data-order-id="${escapeHtml(targetId)}" data-order-status="${escapeHtml(desc.status)}">
            <div class="q-kv"><span>${L('订单编号', 'Order ID')}</span><b class="q-num" style="word-break:break-all;">${escapeHtml(targetId || '—')}</b></div>
            <div class="q-kv"><span>${L('当前状态', 'Status')}</span><b>${escapeHtml(desc.label)}</b></div>
            <div class="q-kv"><span>${L('应付金额（含配送费）', 'Pay Amount (incl. gas)')}</span><b class="q-num">${escapeHtml(payGramText)}</b></div>
            ${desc.group === 'refund' ? `<div class="q-kv"><span>${L('退款金额', 'Refund Amount')}</span><b class="q-num">${escapeHtml(fmtRawGramOrDash(curOrder.refundTonNano))}</b></div>` : ''}
            <div class="q-kv"><span>${L('对应 A9 数量', 'A9 Amount')}</span><b class="q-num">${escapeHtml(a9Display)}</b></div>
            ${curOrder.memo ? `<div class="q-kv"><span>Memo</span><b class="q-num" style="word-break:break-all;">${escapeHtml(curOrder.memo)}</b></div>` : ''}
            ${isPendingPay ? `<div class="q-kv"><span>${L('到期时间', 'Expires At')}</span><b class="q-num">${escapeHtml(expText)}</b></div>` : ''}
            ${txHash ? `
              <div class="q-kv">
                <span>${desc.group === 'refund' ? L('退款交易哈希', 'Refund Tx Hash') : L('链上交易哈希', 'Tx Hash')}</span>
                <b class="q-num" style="word-break:break-all;">${escapeHtml(String(txHash).slice(0, 18))}…</b>
              </div>
            ` : ''}
            ${isPendingPay && !resumeEval.allowed ? `
              <div class="q-notice yellow" id="q-order-check-only-note" style="margin-top:10px;">
                ${qIcon('shield', 16)}
                <span>${L('为防止重复扣款，本订单当前仅支持刷新查单，不会再次唤起钱包，也请勿手动补转；若未实际付款，订单到期后将自动失效。', 'To prevent double payment, this order is check-only: wallet will not be reopened and do not transfer manually. Unpaid orders expire automatically.')}</span>
              </div>
            ` : ''}
            ${isPendingPay && resumeEval.allowed ? `
              <div class="q-notice blue" id="q-order-resume-ready-note" style="margin-top:10px;">
                ${qIcon('info', 16)}
                <span>${L('本会话已确认未发送支付，点击下方「刷新后继续支付」将先核验最新订单状态再唤起钱包；若不再购买，等待到期自动失效即可。', 'Confirmed not sent in this session. Tapping Resume will refresh order status before opening wallet; otherwise let it expire automatically.')}</span>
              </div>
            ` : ''}
            ${!isPendingPay && desc.group === 'refund' ? `
              <div class="q-notice blue" style="margin-top:10px;">
                ${qIcon('info', 16)}
                <span>${L('退款交易记录统一读取服务端回执，可在区块浏览器核验到账。', 'Refund receipt read from server records; verify on block explorer.')}</span>
              </div>
            ` : ''}
          </div>
        `,
        {
          footHtml: `
            <div class="q-btn-row">
              ${isLive ? `<button type="button" class="q-btn q-btn-ghost q-btn-sm q-grow" id="q-order-refresh-btn" ${refreshing || resuming ? 'disabled' : ''}>${qIcon('refresh', 15)} ${refreshing ? L('查单中…', 'Refreshing…') : L('刷新支付状态', 'Refresh Status')}</button>` : ''}
              ${txUrl ? `<button type="button" class="q-btn q-btn-ghost q-btn-sm" id="q-order-explorer-btn">${L('查看回执', 'Explorer')}</button>` : ''}
              ${resumeEval.allowed ? `<button type="button" class="q-btn q-btn-red q-btn-sm q-grow" id="q-order-resume-pay-btn" ${refreshing || resuming ? 'disabled' : ''}>${resuming ? L('核验中…', 'Verifying…') : L('刷新后继续支付', 'Refresh & Pay')}</button>` : ''}
            </div>
          `,
        }
      );

      const expBtn = document.getElementById('q-order-explorer-btn');
      if (expBtn && txUrl) expBtn.onclick = () => A9TMA.openExternalLink(txUrl);

      const refreshBtn = document.getElementById('q-order-refresh-btn');
      if (refreshBtn && isLive) {
        refreshBtn.onclick = async () => {
          if (refreshing || !wallet) return;
          refreshing = true;
          renderDetail();
          try {
            const list = await fetchPresaleOrders(wallet);
            if (Array.isArray(list)) {
              processOrdersUpdate(wallet, list);
              const fresh = list.find((o) => orderKey(o) === targetId);
              if (fresh) curOrder = fresh;
            }
            showToast(L('已刷新最新订单状态', 'Order status refreshed'));
          } catch (e) {
            showToast(e?.message || L('刷新订单状态失败，请重试', 'Failed to refresh order status'), 'error');
          } finally {
            refreshing = false;
            if (document.getElementById('q-chest-order-detail-sheet')) renderDetail();
          }
        };
      }

      const resumeBtn = document.getElementById('q-order-resume-pay-btn');
      if (resumeBtn && isLive) {
        resumeBtn.onclick = async () => {
          if (resuming || refreshing || !wallet) return;
          resuming = true;
          renderDetail();
          const refreshPayableOrder = async (expected) => {
            const list = await fetchPresaleOrders(wallet, { fresh: true });
            if (seq !== chestViewSeq || !root.isConnected || wallet !== store.state.user.address) return null;
            const latest = Array.isArray(list) ? list.find(o => orderKey(o) === targetId) : null;
            if (Array.isArray(list)) processOrdersUpdate(wallet, list);
            if (latest) curOrder = latest;
            const gate = evaluatePresaleOrderResume({
              order: latest,
              wallet,
              confirmedUnsent: confirmedUnsentOrders.get(unsentKey)?.network === config.network,
              fundsEnabled: store.fundsEnabled,
              presaleOpen: resolveChestMallGates(store.state.round, store.fundsEnabled).presaleOpen,
              isLocked: pendingTxManager.isLocked('presale'),
              nowMs: serverNowMs(),
            });
            if (!gate.allowed || latest.payTo !== expected.payTo || latest.memo !== expected.memo ||
                latest.payTonNano !== expected.payTonNano || latest.expiresAt !== expected.expiresAt) {
              showToast(L('订单状态或支付参数已变化，请查单确认', 'Order state or payment details changed. Check the order.'), 'amber');
              return null;
            }
            return latest;
          };
          try {
            const fresh = await refreshPayableOrder(initialOrder);
            if (!fresh) return;
            const ok = await tonConnect.confirmBeforeSign({
              title: L(`继续支付 · ${title}`, `Resume Payment · ${title}`),
              contractLabel: 'Chest Mall Hot Wallet',
              targetAddress: fresh.payTo,
              principalText: formatRoundA9(fresh.totalA9Raw ?? fresh.baseA9Raw ?? fresh.a9AmountRaw),
              gasText: `${PROTOCOL_SPECS.deliveryFeeGram.toFixed(2)} GRAM`,
              totalText: fmtRawGramOrDash(fresh.payTonNano),
              memo: fresh.memo || '',
              note: L('已复核原订单状态仍为待支付且收款地址/Memo/金额一致。', 'Verified order is still pending with matching recipient, memo, and amount.'),
            });
            if (!ok) return;
            const latest = await refreshPayableOrder(fresh);
            if (!latest || !confirmedUnsentOrders.delete(unsentKey)) return;
            try {
              await tonConnect.sendV15PresaleTx(latest);
            } catch (sendErr) {
              if (isExplicitWalletRejection(sendErr)) {
                confirmedUnsentOrders.set(unsentKey, { network: config.network, at: Date.now() });
              }
              throw sendErr;
            }
            closeModal();
            A9Haptic.success();
            trackedOrderIds.add(targetId);
            state.waitingOrderId = targetId;
            paint();
            showToast(L('已重新发起支付，正在等待链上确认…', 'Payment sent; awaiting on-chain confirmation…'));
            scheduleOrderRecovery(wallet);
          } catch (e) {
            showToast(e?.message || L('续付失败，请刷新查单确认状态', 'Resume payment failed; refresh order status'), 'error');
          } finally {
            resuming = false;
            if (document.getElementById('q-chest-order-detail-sheet')) renderDetail();
          }
        };
      }
    };

    renderDetail();
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
          <span class="q-small q-num">${escapeHtml(formatRoundA9(starterChest.baseA9Raw))}</span>
        </div>
        <button class="q-btn q-btn-red q-btn-sm" id="q-open-free-chest" type="button" ${gates.canOpenFree ? '' : 'disabled'}>
          ${gates.canOpenFree ? L('免费开启', 'Open Free') : L('暂未开放', 'Closed')}
        </button>
      </div>
    ` : `
      <div style="margin-top:10px;">
        <a class="q-chip" href="#/team" id="q-chest-free-progress-link" style="text-decoration:none;">${L('查看 5 阶免费任务宝箱进度 ›', 'View 5-Tier Free Task Chests ›')}</a>
      </div>
    `;

    const catalogHtml = skus.length === 0 ? `
      <section class="q-card" id="live-chest-skus-unavailable">
        <div class="q-card-h">
          <h3>${qIcon('info', 18)} ${L('宝箱目录暂不可用', 'Chest Catalog Unavailable')}</h3>
          <span class="q-chip q-chip-red">${L('待同步', 'Pending')}</span>
        </div>
        <div class="q-small q-muted" style="line-height:1.55;margin-bottom:10px;">
          ${L('宝箱目录暂未同步，请重试。', 'Chest catalog not synced yet. Tap retry to refresh.')}
        </div>
        <button class="q-btn q-btn-ghost q-btn-sm" id="q-chest-retry" type="button">${qIcon('refresh', 15)} ${L('重试同步', 'Retry Sync')}</button>
      </section>
    ` : `
      <section aria-label="${L('宝箱档位', 'Chest tiers')}">
        <div class="q-chest-legend" aria-hidden="true">
          <span>${L('保底', 'Guaranteed')}</span><span>${L('随机加赠', 'Random bonus')}</span>
        </div>
        <div class="q-chest-grid">
        ${skus.map((sku) => {
          const tier = String(sku.tier || 'bronze').toLowerCase();
          const pal = CHEST_TIER_PALETTE[tier] || CHEST_TIER_PALETTE.gold;
          const baseA9 = finiteOrNull(sku.baseA9);
          const maxBoost = finiteOrNull(sku.maxBoostA9);
          const maxTotal = baseA9 !== null && maxBoost !== null ? baseA9 + maxBoost : null;
          const priceGram = formatCatalogGram(sku.priceGram);
          const baseW = maxTotal > 0 && baseA9 >= 0 && maxBoost >= 0 ? Math.round(baseA9 / maxTotal * 100) : null;
          const title = L(sku.zh || sku.name || tier, sku.en || sku.name || tier);
          const featured = tier === 'legendary';
          const skuEv = baseW !== null ? computeSkuExpectedStats(sku, state.critTiers) : null;
          return `
            <button type="button" class="q-chest-card${featured ? ' featured' : ''}" data-pick-sku="${escapeHtml(sku.skuId)}" style="--tcol:${featured ? pal.trim : pal.body};--tsoft:${pal.soft};">
              <span class="q-art">${chestArtSvg(tier, 68)}</span>
              <span class="q-nm">${escapeHtml(title)}</span>
              <span class="q-pr q-num">${priceGram ? `${priceGram} <small>GRAM</small>` : '—'}</span>
              <span class="q-rg q-num">${baseW === null ? '—' : `<span class="q-sr-only">${L('保底到最高', 'Guaranteed to maximum')}</span>${fmtIntOrDash(baseA9)} – ${fmtIntOrDash(maxTotal)} A9`}</span>
              ${baseW === null ? '' : `<span class="q-range" aria-hidden="true"><i style="width:${baseW}%"></i><em style="left:${baseW}%"></em></span>`}
              ${skuEv?.valid ? `<span class="q-per q-num">${L(`平均加赠约 <b>${fmtApproxA9(skuEv.approxBonusA9)}</b> A9`, `Avg bonus ~<b>${fmtApproxA9(skuEv.approxBonusA9)}</b> A9`)}</span>` : ''}
            </button>
          `;
        }).join('')}
        </div>
      </section>
    `;

    const oddsSummary = computeChestOddsSummary(state.critTiers);
    const oddsRows = oddsSummary.rows;
    const waitingDesc = state.waitingOrder ? describePresaleOrderStatus(state.waitingOrder) : null;
    const unpaidOrder = !state.waitingOrderId && isLive
      ? orders.find((o) => describePresaleOrderStatus(o).status === 'PENDING_PAYMENT') || null
      : null;

    root.innerHTML = `
      <div class="q-view" id="quest-chest-view">
        <section class="q-mall-hero">
          <div class="q-art">${chestArtSvg('gold', 92)}</div>
          <h2>${L('宝箱商城', 'Chest Mall')}</h2>
          <p>${L('保底与加赠合并直发 · 配送费 0.06 GRAM', 'Base and bonus paid together · 0.06 GRAM delivery')}</p>
          ${freeBannerHtml}
        </section>

        ${state.waitingOrderId ? `
          <div class="q-notice blue" id="q-chest-waiting-banner" data-waiting-status="${escapeHtml(waitingDesc?.status || 'PAYOUT_PENDING')}" data-waiting-count="${state.waitingOrders.length || 1}">
            ${qIcon('clock', 17)}
            <span class="q-grow">${state.waitingOrders.length > 1
              ? L(`${state.waitingOrders.length} 笔订单处理中（${waitingDesc?.zh || '发币确认中'}），每笔到账后自动开箱。`, `${state.waitingOrders.length} orders in progress (${waitingDesc?.en || 'Confirming'}); each opens on settlement.`)
              : escapeHtml(waitingDesc?.bannerZh ? L(waitingDesc.bannerZh, waitingDesc.bannerEn) : L('等待支付确认和发币，到账后自动开箱。', 'Confirming on-chain payment and hot-wallet payout… Opening theater will launch once settled.'))}</span>
            <button type="button" class="q-btn q-btn-ghost q-btn-sm" id="q-chest-jump-orders" style="flex:0 0 auto;">${L('查看明细', 'Details')}</button>
          </div>
        ` : unpaidOrder ? `
          <div class="q-notice yellow" id="q-chest-unpaid-banner">
            ${qIcon('info', 16)}
            <span class="q-grow">${L('有一笔宝箱订单待支付。', 'A chest order is awaiting payment.')}</span>
            <button type="button" class="q-btn q-btn-ghost q-btn-sm" id="q-chest-open-unpaid" style="flex:0 0 auto;">${L('查单', 'View order')}</button>
          </div>
        ` : ''}

        ${isLive && (!store.fundsEnabled || !gates.presaleOpen) ? `
          <div class="q-notice yellow" id="q-chest-gate-note">
            ${qIcon('info', 16)}
            <span>${!store.fundsEnabled
              ? escapeHtml(LIVE_READONLY_REASON)
              : L('付费购箱暂未开放。', 'Paid Chest Mall channel is closed; catalog browsing and history remain available.')}</span>
          </div>
        ` : ''}

        ${catalogHtml}

        <section class="q-card" id="mall-base-receipt-strip">
          <div class="q-card-h">
            <h3>${qIcon('dice', 18)} ${L('随机加赠概率公示', 'Random Bonus Odds')}</h3>
            <a class="q-chip mall-verify-link" href="#/rules#audit" style="text-decoration:none;">${L('链上核验', 'Verify')} ›</a>
          </div>
          ${oddsSummary.valid ? `<p class="q-chest-odds-note">${L(`平均加赠约为最大加赠额的 <b class="q-num">${(oddsSummary.meanMaxRatio * 100).toFixed(2)}%</b>。实发按整枚 A9 向下取整。`, `Mean bonus is ~<b class="q-num">${(oddsSummary.meanMaxRatio * 100).toFixed(2)}%</b> of the maximum. Payouts round down to whole A9.`)}</p>` : ''}
          ${!oddsRows.length ? L('概率待公布', 'Odds pending') : `
            ${oddsSummary.invalidWeight ? `<div class="q-notice yellow">${qIcon('info', 16)}<span>${L('概率权重待核验。', 'Odds weights pending verification.')}</span></div>` : ''}
            <table class="q-chest-odds" aria-label="${L('随机加赠概率', 'Random bonus odds')}">
              <thead><tr><th scope="col">${L('档位', 'Tier')}</th><th scope="col">${L('概率', 'Chance')}</th><th scope="col">${L('占最大加赠', 'Share of max bonus')}</th></tr></thead>
              <tbody>${oddsRows.map((o) => {
                const lo = Math.round(o.minRatio * 10000) / 100;
                const hi = Math.round(o.maxRatio * 10000) / 100;
                return `<tr>
                  <th scope="row">${escapeHtml(L(o.labelZh || '区间', o.labelEn || 'Tier'))}</th>
                  <td class="q-num"><b>${o.weight}%</b><span class="q-bar red" aria-hidden="true"><i style="width:${o.weight}%"></i></span></td>
                  <td class="q-num">${lo}%–${hi}%</td>
                </tr>`;
              }).join('')}</tbody>
            </table>
          `}
        </section>

        <section class="q-card">
          <div class="q-card-h">
            <h3>${qIcon('eye', 18)} ${L('高额加赠记录', 'Top Bonus Feed')}</h3>
            <span class="q-chip q-chip-red">${isLive ? L('实况', 'Live') : L('演示', 'Demo')}</span>
          </div>
          ${state.feed.length === 0 ? `
            <div class="q-small q-muted">${L('暂无公开记录。', 'No public records yet.')}</div>
          ` : `
            <div class="q-feed">
              ${state.feed.slice(0, 6).map((f) => {
                const who = f.actor || f.maskedWallet || f.who || '—';
                const skuName = L(f.labelZh || f.skuZh || f.name || '宝箱', f.labelEn || f.skuEn || f.name || 'Chest');
                const amount = formatRoundA9(f.boostA9Raw);
                return `
                <div class="q-feed-i">
                  ${chestArtSvg(f.tier || 'gold', 34)}
                  <div>
                    <span class="q-who">${escapeHtml(who)}</span>
                    <small>${escapeHtml(skuName)}</small>
                  </div>
                  <span class="q-amt q-num">${amount === '—' ? '—' : `+${escapeHtml(amount)}`}</span>
                </div>`;
              }).join('')}
            </div>
          `}
        </section>

        <section class="q-card" id="q-chest-orders-card">
          <div class="q-card-h">
            <h3>${qIcon('book', 18)} ${L('购箱订单', 'Chest Orders')}</h3>
            <span class="q-chip q-num">${formatNum(orders.length)}</span>
          </div>
          ${orders.length === 0 ? `
            <div class="q-small q-muted">${L('暂无订单。', 'No orders yet.')}</div>
          ` : `
            <div class="q-feed">
              ${[...orders.filter((o) => describePresaleOrderStatus(o).inFlight), ...orders.filter((o) => !describePresaleOrderStatus(o).inFlight)].slice(0, 10).map((o) => {
                const desc = describePresaleOrderStatus(o);
                const skuHit = skus.find(s => s.skuId === o.skuId);
                const tierName = skuHit?.tier || o.tier || 'gold';
                const oid = String(o.orderId || o.id || '');
                const amtDisplay = isLive
                  ? (desc.group === 'refund'
                    ? fmtRawGramOrDash(o.refundTonNano)
                    : formatRoundA9(o.totalA9Raw ?? o.baseA9Raw ?? o.a9AmountRaw))
                  : fmtExactA9(o.totalA9);
                return `
                <div class="q-feed-i" role="button" tabindex="0" style="cursor:pointer;" data-order-id="${escapeHtml(oid)}" data-order-status="${escapeHtml(desc.status)}">
                  ${chestArtSvg(tierName, 34)}
                  <div>
                    <span class="q-who">${escapeHtml(L(skuHit?.zh || '宝箱', skuHit?.en || 'Chest'))}</span>
                    <small>${escapeHtml(desc.label)}</small>
                  </div>
                  <span class="q-amt q-num">${escapeHtml(amtDisplay)} ›</span>
                </div>`;
              }).join('')}
            </div>
          `}
        </section>
      </div>
    `;

    const openUnpaidBtn = root.querySelector('#q-chest-open-unpaid');
    if (openUnpaidBtn && unpaidOrder) {
      openUnpaidBtn.onclick = () => openOrderDetailSheet(unpaidOrder);
    }

    root.querySelectorAll('#q-chest-orders-card [data-order-id]').forEach((row) => {
      const openRow = () => {
        const hit = orders.find((o) => String(o.orderId || o.id || '') === row.dataset.orderId);
        if (hit) openOrderDetailSheet(hit);
      };
      row.onclick = openRow;
      row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(); } };
    });

    const jumpOrdersBtn = root.querySelector('#q-chest-jump-orders');
    if (jumpOrdersBtn) {
      jumpOrdersBtn.onclick = () => {
        const card = root.querySelector('#q-chest-orders-card');
        card?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      };
    }

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
        if (state.openingFree) return;
        state.openingFree = true;
        freeBtn.disabled = true;
        try {
          const res = await openChestById(starterChest.chestId || starterChest.id, store.state, store.state.user.address);
          showFreeChestReward(res);
          void loadAux();
        } catch (e) {
          showToast(e?.message || L('开启免费宝箱失败', 'Failed to open free chest'), 'error');
        } finally {
          state.openingFree = false;
          if (freeBtn.isConnected) freeBtn.disabled = !gates.canOpenFree;
        }
      };
    }
  };

  const loadAux = async () => {
    const reqAuxSeq = ++auxSeq;
    await resolveCatalog();
    if (seq !== chestViewSeq || reqAuxSeq !== auxSeq || !root.isConnected) return;
    paint();

    const addr = store.state.user.connected ? store.state.user.address : null;
    const [feedRes, ordersRes, chestsRes] = await Promise.allSettled([
      fetchChestCritFeed(8),
      (isLive && addr) ? fetchPresaleOrders(addr) : Promise.resolve([]),
      fetchMyChests(),
    ]);
    const curAddr = store.state.user.connected ? store.state.user.address : null;
    if (seq !== chestViewSeq || reqAuxSeq !== auxSeq || !root.isConnected) return;
    if (isLive && addr !== curAddr) return;
    if (feedRes.status === 'fulfilled' && Array.isArray(feedRes.value)) state.feed = feedRes.value;
    if (ordersRes.status === 'fulfilled' && Array.isArray(ordersRes.value)) {
      if (isLive && addr) {
        processOrdersUpdate(addr, ordersRes.value);
        if (chestsRes.status === 'fulfilled' && chestsRes.value) {
          state.myChests = chestsRes.value;
          paint();
        }
        return;
      }
      state.orders = ordersRes.value;
    }
    if (chestsRes.status === 'fulfilled' && chestsRes.value) state.myChests = chestsRes.value;
    paint();
  };

  void loadAux();
}

export { renderChestView as renderInternalMarket };
