// A9 Protocol v15 — Zero-contract presale ("A9 固定兑换所") order engine.
//
// Business rules kept from v15 (unchanged): 1 GRAM = 2,002 A9 protocol quote (not a market
// price), 5..200 GRAM per order, per-wallet quota, pool cap, 12% referral reward, refund rules
// (passive >= 1 GRAM full refund, user-fault refund minus 0.05 GRAM, dust <= 0.1 GRAM ignored).
//
// P0-2 rewrite — recoverable, idempotent order state machine:
//   PENDING_PAYMENT -> PAYMENT_CONFIRMED -> PAYOUT_PENDING -> PAYOUT_SENT -> COMPLETED
//   failures: PAYOUT_RETRY (retryable) | NEEDS_REVIEW (manual) ; refunds: REFUND_PENDING ->
//   REFUND_SENT -> REFUNDED ; EXPIRED / CANCELLED.
//   * Every state change is persisted BEFORE the side effect it authorises (broadcast).
//   * Inbound tx hash, order id and payout id are unique; replays are no-ops.
//   * planInbound() is a pure read: dry-run never writes.
//   * Pool + per-wallet quota are reserved atomically when the order is created.
//   * Referral reward is booked only after the payout is confirmed, exactly once.
//   * Owner rule (acceptance round 1): an inbound transfer without a valid order, from the
//     wrong sender, for an order that is no longer payable, or with an amount different from
//     the order is NEVER auto-confirmed and NEVER auto-charged a fee. It is recorded as an
//     ANOMALY (payer, amount, refund destination) for an operator to resolve. A fee may only be
//     applied when the operator marks it USER fault AND a published fee rule is configured
//     (userFaultFeeNano); SYSTEM / UNKNOWN fault is always a full refund.
// Storage is behind a small repository interface: MemoryPresaleRepo here, D1PresaleRepo in
// d1-growth-store.mjs. Both are exercised by worker/tests.
import { addressKey, normalizeTonAddress } from './ton-address.mjs';
import { parseDecimalUnits, MoneyError } from './money.mjs';
import { randomHex } from './auth.mjs';
import { CHEST_MALL_CATALOG, CHEST_MALL_NANO_TO_SKU, rollPaidChestBonusRaw } from './chest-engine.mjs';

export const PRESALE_STATUS = Object.freeze({
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  PAYOUT_PENDING: 'PAYOUT_PENDING',
  PAYOUT_SENT: 'PAYOUT_SENT',
  COMPLETED: 'COMPLETED',
  PAYOUT_RETRY: 'PAYOUT_RETRY',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  PAYMENT_EXCEPTION: 'PAYMENT_EXCEPTION', // paid, but not auto-confirmable: awaiting manual review
  REFUND_PENDING: 'REFUND_PENDING',
  REFUND_SENT: 'REFUND_SENT',
  REFUNDED: 'REFUNDED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  // Legacy values that may exist in old rows (read-only, normalised on output).
  PENDING_TON: 'PENDING_TON',
  PAID_A9: 'PAID_A9',
  REFUNDED_FREE: 'REFUNDED_FREE',
  REFUNDED_MINUS_FEE: 'REFUNDED_MINUS_FEE',
  DUST_IGNORED: 'DUST_IGNORED',
});

/** Inbound transfers that cannot be auto-confirmed are recorded as anomalies (never auto-fee). */
export const ANOMALY_STATUS = Object.freeze({
  OPEN: 'OPEN',
  REFUND_QUEUED: 'REFUND_QUEUED',
  CLOSED_NO_REFUND: 'CLOSED_NO_REFUND',
});

/** Who caused the anomaly; decided by an operator, never inferred automatically. */
export const FAULT_PARTY = Object.freeze({ USER: 'USER', SYSTEM: 'SYSTEM', UNKNOWN: 'UNKNOWN' });

export const PAYOUT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  BROADCASTING: 'BROADCASTING',
  RETRY: 'RETRY',
  SENT: 'SENT',
  CONFIRMED: 'CONFIRMED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
});

/** Statuses that hold pool + quota reservation (PENDING_PAYMENT only while not expired). */
export const RESERVING_STATUSES = Object.freeze([
  'PAYMENT_CONFIRMED', 'PAYOUT_PENDING', 'PAYOUT_SENT', 'PAYOUT_RETRY', 'NEEDS_REVIEW', 'COMPLETED', 'PAID_A9',
]);

export const TON_NANO = 1_000_000_000n;
export const A9_RAW = 1_000_000_000n;
export const DUST_LIMIT_NANO = 100_000_000n;        // 0.1 GRAM
export const PASSIVE_FREE_MIN_NANO = 990_000_000n;  // 0.99 GRAM (legacy SKU minimum reference)
export const DELIVERY_GAS_FEE_NANO = 60_000_000n;   // 0.06 GRAM user-paid A9 on-chain delivery gas
export const REFUND_GAS_FEE_NANO = 30_000_000n;     // 0.03 GRAM user-paid on-chain refund gas (0 project gas)
export const USER_FAULT_FEE_NANO = 50_000_000n;     // 0.05 GRAM optional higher user-fault fee
export const REFERRAL_BPS = 6n;                      // 6% referral reward (percent, recalibrated in v16.1)
export const ORDER_TTL_SEC = 30 * 60;               // unpaid order holds its reservation for 30 min
export const MAX_PAYOUT_ATTEMPTS = 5;
export const STALE_BROADCAST_SEC = 240;
export const UNCONFIRMED_REVIEW_SEC = 3600;
export const JETTON_TRANSFER_GAS_NANO = '50000000';

export class PresaleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const DEFAULT_INVENTORY_MAX_STALE_SEC = 120;

/**
 * Validate fresh on-chain hot-wallet inventory snapshots before accepting new mall orders.
 * Enforces network, jettonMaster, walletAddress, freshness, and non-negative integer balance.
 */
export function validateInventorySnapshot(
  snapshot,
  {
    nowSec = Math.floor(Date.now() / 1000),
    maxStaleSec = DEFAULT_INVENTORY_MAX_STALE_SEC,
    expectedNetwork = null,
    expectedJettonMaster = null,
    expectedPresaleWallet = null,
    expectedPromoWallet = null,
    needPromo = false,
  } = {},
) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new PresaleError('INVENTORY_SNAPSHOT_UNAVAILABLE', 'fresh hot-wallet inventory snapshot is required to accept new orders');
  }
  const checkOne = (label, item, expectedWallet) => {
    if (!item || typeof item !== 'object') {
      throw new PresaleError('INVENTORY_SNAPSHOT_UNAVAILABLE', `${label} hot-wallet inventory snapshot missing`);
    }
    if (item.ok === false) {
      throw new PresaleError(
        label === 'promo' ? 'PROMO_WALLET_LOW_INVENTORY' : 'HOT_WALLET_LOW_INVENTORY',
        `${label} hot-wallet inventory unhealthy: ${item.reason || 'LOW_INVENTORY'}`,
      );
    }
    const fetchedAt = Number(item.fetchedAt ?? item.fetched_at ?? 0);
    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0 || nowSec - fetchedAt > maxStaleSec || fetchedAt > nowSec + 60) {
      throw new PresaleError(
        'INVENTORY_SNAPSHOT_STALE',
        `${label} hot-wallet inventory snapshot is stale or missing timestamp`,
      );
    }
    if (expectedNetwork) {
      const snapNet = String(item.network || '').trim().toLowerCase();
      if (!snapNet || snapNet !== String(expectedNetwork).trim().toLowerCase()) {
        throw new PresaleError(
          'INVENTORY_SNAPSHOT_MISMATCH',
          `${label} hot-wallet snapshot network (${snapNet || 'missing'}) does not match ${expectedNetwork}`,
        );
      }
    }
    if (expectedJettonMaster) {
      const snapMaster = String(item.jettonMaster || '').trim();
      if (!snapMaster || addressKey(snapMaster) !== addressKey(expectedJettonMaster)) {
        throw new PresaleError(
          'INVENTORY_SNAPSHOT_MISMATCH',
          `${label} hot-wallet snapshot jettonMaster does not match expected master`,
        );
      }
    }
    if (expectedWallet) {
      const snapWallet = String(item.walletAddress || '').trim();
      if (!snapWallet || addressKey(snapWallet) !== addressKey(expectedWallet)) {
        throw new PresaleError(
          'INVENTORY_SNAPSHOT_MISMATCH',
          `${label} hot-wallet snapshot walletAddress does not match expected hot wallet`,
        );
      }
    }
    const rawStr = String(item.a9Raw ?? item.a9BalanceRaw ?? '').trim();
    if (!/^\d+$/.test(rawStr)) {
      throw new PresaleError('INVENTORY_SNAPSHOT_UNAVAILABLE', `${label} hot-wallet snapshot missing valid a9Raw balance`);
    }
    const jettonWallet = addressKey(item.jettonWallet);
    const walletLt = /^0:[0-9a-f]{64}$/.test(jettonWallet || '')
      && /^[1-9]\d{0,19}$/.test(typeof item.walletLt === 'string' ? item.walletLt : '')
      ? item.walletLt
      : null;
    return {
      network: item.network ? String(item.network).trim().toLowerCase() : null,
      jettonMaster: item.jettonMaster ? String(item.jettonMaster).trim() : null,
      walletAddress: item.walletAddress ? String(item.walletAddress).trim() : null,
      fetchedAt,
      jettonWallet,
      walletLt,
      a9Raw: BigInt(rawStr),
    };
  };

  const presale = checkOne('presale', snapshot.presale, expectedPresaleWallet);
  const promo = needPromo
    ? checkOne('promo', snapshot.promo, expectedPromoWallet)
    : (snapshot.promo && snapshot.promo.ok !== false && /^\d+$/.test(String(snapshot.promo.a9Raw ?? ''))
        ? checkOne('promo', snapshot.promo, expectedPromoWallet)
        : null);
  return { presale, promo };
}

/** Map legacy row statuses to the new state machine for display / logic. */
export function normalizeOrderStatus(status, payoutTxHash = null) {
  switch (status) {
    case 'PENDING_TON': return PRESALE_STATUS.PENDING_PAYMENT;
    // Old engine wrote PAID_A9 before broadcasting: with a payout hash it was at most "sent".
    case 'PAID_A9': return payoutTxHash ? PRESALE_STATUS.PAYOUT_SENT : PRESALE_STATUS.NEEDS_REVIEW;
    case 'REFUNDED_FREE':
    case 'REFUNDED_MINUS_FEE': return PRESALE_STATUS.REFUNDED;
    default: return status;
  }
}

function toUnits(v, field) {
  try {
    return parseDecimalUnits(v, 9);
  } catch (e) {
    if (e instanceof MoneyError) throw new PresaleError('BAD_CONFIG', `${field}: ${e.message}`);
    throw e;
  }
}

function newQueryId() {
  const n = BigInt(`0x${randomHex(8)}`);
  return (n > 0n ? n : 1n).toString();
}

export class PresaleEngine {
  constructor({
    repo,
    hotWalletAddress,
    promoHotWalletAddress = null,
    network = null,
    jettonMasterAddress = null,
    inventoryMaxStaleSec = DEFAULT_INVENTORY_MAX_STALE_SEC,
    requireInventorySnapshot = false,
    rateA9PerTon = 2002n,
    minOrderTon = 5n,
    maxOrderTon = 500n,
    defaultQuotaTon = null,
    totalCapA9Raw = 200_000_000n * A9_RAW,
    open = false,
    promoEngine = null,
    predictionEngine = null,
    socialStore = null,
    identityStore = null,
    chestEngine = null,
    broadcaster = null,
    budgetLedger = null,
    randomFn = null,
    orderTtlSec = ORDER_TTL_SEC,
    deliveryFeeNano = DELIVERY_GAS_FEE_NANO,
    refundFeeNano = REFUND_GAS_FEE_NANO,
    userFaultFeeNano = null, // optional higher user-fault fee in GRAM nano (minimum refund gas fee always applies)
  } = {}) {
    if (!repo) throw new PresaleError('CONFIG_MISSING', 'presale repository required');
    if (!hotWalletAddress) throw new PresaleError('CONFIG_MISSING', 'presale hotWalletAddress required');
    this.repo = repo;
    this.hotWalletAddress = hotWalletAddress;
    this.promoHotWalletAddress = promoHotWalletAddress || promoEngine?.hotWalletAddress || null;
    this.network = network ? String(network).trim().toLowerCase() : null;
    this.jettonMasterAddress = jettonMasterAddress ? String(jettonMasterAddress).trim() : null;
    this.inventoryMaxStaleSec = Math.max(30, Number(inventoryMaxStaleSec || DEFAULT_INVENTORY_MAX_STALE_SEC));
    this.requireInventorySnapshot = Boolean(requireInventorySnapshot);
    this.rateA9PerTon = BigInt(rateA9PerTon);
    this.minOrderNano = toUnits(minOrderTon, 'minOrderTon');
    this.maxOrderNano = toUnits(maxOrderTon, 'maxOrderTon');
    this.defaultQuotaNano = (defaultQuotaTon === null || defaultQuotaTon === undefined || defaultQuotaTon === '' || defaultQuotaTon === 'unlimited' || Number(defaultQuotaTon) === 0)
      ? null
      : toUnits(defaultQuotaTon, 'defaultQuotaTon');
    this.totalCapA9Raw = BigInt(totalCapA9Raw);
    this.open = Boolean(open);
    this.promoEngine = promoEngine;
    this.predictionEngine = predictionEngine;
    this.socialStore = socialStore;
    this.identityStore = identityStore;
    this.chestEngine = chestEngine;
    this.broadcaster = broadcaster;
    this.budgetLedger = budgetLedger;
    this.randomFn = randomFn;
    this.orderTtlSec = orderTtlSec;
    this.deliveryFeeNano = BigInt(deliveryFeeNano ?? DELIVERY_GAS_FEE_NANO);
    this.refundFeeNano = BigInt(refundFeeNano ?? REFUND_GAS_FEE_NANO);
    this.userFaultFeeNano = userFaultFeeNano === null || userFaultFeeNano === undefined || userFaultFeeNano === '' ? null : BigInt(userFaultFeeNano);
    this.userQuotaNano = new Map(); // walletKey -> bigint (ops override, memory only)
  }

  /** Exact total GRAM nano user must transfer on-chain (net order principal + 0.06 GRAM A9 delivery gas). */
  expectedPayNano(order) {
    return BigInt(order.tonNano) + this.deliveryFeeNano;
  }

  /** Exact A9 raw for an amount of GRAM nano at the fixed protocol rate (no randomness, no bonus). */
  quoteA9Raw(tonNano) {
    return (BigInt(tonNano) * this.rateA9PerTon * A9_RAW) / TON_NANO;
  }

  setUserQuotaTon(walletAddress, quotaTon) {
    this.userQuotaNano.set(addressKey(walletAddress), toUnits(quotaTon, 'quotaTon'));
  }

  _quotaFor(walletKey) {
    return this.userQuotaNano.get(walletKey) ?? this.defaultQuotaNano;
  }

  async getQuota(walletAddress, nowSec = Math.floor(Date.now() / 1000)) {
    const key = addressKey(walletAddress);
    const { reservedA9Raw, userReservedNano } = await this.repo.sumReserved(nowSec, key);
    const unlocked = this._quotaFor(key);
    const unlimitedQuota = unlocked === null || unlocked === undefined;
    const avail = unlimitedQuota ? null : (unlocked > userReservedNano ? unlocked - userReservedNano : 0n);
    const remPool = this.totalCapA9Raw > reservedA9Raw ? this.totalCapA9Raw - reservedA9Raw : 0n;
    return {
      walletAddress,
      pricingModel: 'CHEST_MALL_SKUS',
      open: this.open,
      soldOut: remPool === 0n,
      unlimitedQuota,
      remainingPoolA9Raw: remPool.toString(),
      unlockedQuotaNano: unlimitedQuota ? null : unlocked.toString(),
      usedQuotaNano: userReservedNano.toString(),
      availQuotaNano: unlimitedQuota ? null : avail.toString(),
      minOrderNano: this.minOrderNano.toString(),
      maxOrderNano: this.maxOrderNano.toString(),
      deliveryFeeNano: this.deliveryFeeNano.toString(),
      refundFeeNano: this.refundFeeNano.toString(),
      // Legacy integer fields kept for existing UI (whole GRAM, truncated).
      unlockedQuotaTon: unlimitedQuota ? null : Number(unlocked / TON_NANO),
      usedQuotaTon: Number(userReservedNano / TON_NANO),
      availQuotaTon: unlimitedQuota ? null : Number(avail / TON_NANO),
      minOrderTon: Number(this.minOrderNano / TON_NANO),
      maxOrderTon: Number(this.maxOrderNano / TON_NANO),
      payTo: this.hotWalletAddress,
    };
  }

  /** Create an order and atomically reserve pool, wallet quota, max bonus + 6% referral budget, and hot-wallet inventory. */
  async createOrderIntent(
    walletAddress,
    tonAmount,
    nowSec = Math.floor(Date.now() / 1000),
    { referrerId = null, tgUserId = null, skuId = null, openMode = 'INSTANT', inventorySnapshot = null } = {},
  ) {
    if (!walletAddress) throw new PresaleError('BAD_WALLET', 'walletAddress required');
    if (!this.open) throw new PresaleError('PRESALE_CLOSED', 'presale is closed');

    const normMode = String(openMode || 'INSTANT').toUpperCase();
    if (normMode !== 'INSTANT' && normMode !== 'BOOST') {
      throw new PresaleError('BAD_OPEN_MODE', 'openMode must be INSTANT or BOOST');
    }

    let tonNano;
    let resolvedSkuId = skuId ? String(skuId).trim() : null;
    let resolvedPack = null;
    if (resolvedSkuId) {
      const pack = CHEST_MALL_CATALOG[resolvedSkuId];
      if (!pack) throw new PresaleError('UNKNOWN_SKU', `unknown chest SKU: ${resolvedSkuId}`);
      resolvedPack = pack;
      tonNano = BigInt(pack.priceNano);
      if (tonAmount !== undefined && tonAmount !== null && tonAmount !== '') {
        let parsed;
        try {
          parsed = parseDecimalUnits(tonAmount, 9);
        } catch (e) {
          throw new PresaleError('BAD_AMOUNT', e.message);
        }
        if (parsed !== tonNano) {
          throw new PresaleError('BAD_AMOUNT', 'tonAmount does not match chest SKU price');
        }
      }
    } else {
      if (tonAmount === undefined || tonAmount === null || tonAmount === '') {
        throw new PresaleError('SKU_REQUIRED', 'skuId is required; only the 6 valid Chest Mall SKUs are accepted');
      }
      try {
        tonNano = parseDecimalUnits(tonAmount, 9);
      } catch (e) {
        throw new PresaleError('BAD_AMOUNT', e.message);
      }
      const matchedSku = CHEST_MALL_NANO_TO_SKU[tonNano.toString()] || null;
      if (!matchedSku) {
        throw new PresaleError('UNKNOWN_SKU', 'only the 6 valid Chest Mall SKUs are accepted; legacy fixed-rate orders are disabled');
      }
      resolvedSkuId = matchedSku;
      resolvedPack = CHEST_MALL_CATALOG[matchedSku];
    }
    const walletKey = addressKey(walletAddress);
    const a9AmountRaw = BigInt(resolvedPack.baseA9Raw);
    const cleanRef = referrerId && addressKey(referrerId) !== walletKey && String(referrerId).trim() !== String(tgUserId || '')
      ? String(referrerId).trim()
      : null;
    const reservedBonusRaw = BigInt(resolvedPack.maxBoostA9Raw || '0');
    const reservedReferralRaw = cleanRef ? (a9AmountRaw * REFERRAL_BPS) / 100n : 0n;

    let validatedSnap = null;
    if (inventorySnapshot !== null && inventorySnapshot !== undefined) {
      validatedSnap = validateInventorySnapshot(inventorySnapshot, {
        nowSec,
        maxStaleSec: this.inventoryMaxStaleSec,
        expectedNetwork: this.network,
        expectedJettonMaster: this.jettonMasterAddress,
        expectedPresaleWallet: this.hotWalletAddress,
        expectedPromoWallet: this.promoHotWalletAddress,
        needPromo: reservedReferralRaw > 0n,
      });
    } else if (this.requireInventorySnapshot) {
      throw new PresaleError('INVENTORY_SNAPSHOT_UNAVAILABLE', 'fresh hot-wallet inventory snapshot is required to accept new orders');
    }

    const orderId = randomHex(6);
    const order = {
      orderId,
      walletAddress,
      walletKey,
      tgUserId: tgUserId ? String(tgUserId) : null,
      referrerId: cleanRef,
      skuId: resolvedSkuId,
      openMode: normMode,
      tonNano,
      a9AmountRaw,
      bonusA9Raw: 0n,
      bonusRolled: false,
      memo: `buy:${orderId}`,
      status: PRESALE_STATUS.PENDING_PAYMENT,
      inboundTxHash: null,
      payoutTxHash: null,
      refundTonNano: 0n,
      refundReason: null,
      lastError: null,
      expiresAt: nowSec + this.orderTtlSec,
      createdAt: nowSec,
      updatedAt: nowSec,
    };
    const reservation = {
      orderId,
      skuId: resolvedSkuId,
      baseA9Raw: a9AmountRaw,
      reservedBonusRaw,
      settledBonusRaw: 0n,
      releasedBonusRaw: 0n,
      reservedReferralRaw,
      referralBps: cleanRef ? Number(REFERRAL_BPS) : 0,
      maxBoostBps: Number(resolvedPack.maxBoostBps || 0),
      bonusStatus: reservedBonusRaw > 0n ? 'RESERVED' : 'SETTLED',
      referralStatus: reservedReferralRaw > 0n ? 'RESERVED' : 'NONE',
      status: 'ACTIVE',
      legacyBackfilled: false,
      snapshotNetwork: validatedSnap?.presale?.network || null,
      snapshotJettonMaster: validatedSnap?.presale?.jettonMaster || null,
      snapshotPresaleWallet: validatedSnap?.presale?.walletAddress || null,
      snapshotPromoWallet: validatedSnap?.promo?.walletAddress || null,
      snapshotAt: validatedSnap?.presale?.fetchedAt || null,
      createdAt: nowSec,
      updatedAt: nowSec,
    };

    const walletQuota = this._quotaFor(walletKey);
    if (typeof this.repo.createOrderAtomic === 'function') {
      const outcome = await this.repo.createOrderAtomic(order, reservation, {
        capA9Raw: this.totalCapA9Raw,
        userQuotaNano: walletQuota,
        nowSec,
        budgetLedger: this.budgetLedger,
        inventorySnapshot: validatedSnap,
        promoEngine: this.promoEngine,
      });
      if (!outcome?.ok) {
        if (outcome?.code === 'HOT_WALLET_LOW_INVENTORY') {
          throw new PresaleError('HOT_WALLET_LOW_INVENTORY', outcome.message || 'presale hot-wallet A9 inventory insufficient for concurrent orders');
        }
        if (outcome?.code === 'PROMO_WALLET_LOW_INVENTORY') {
          throw new PresaleError('PROMO_WALLET_LOW_INVENTORY', outcome.message || 'promo hot-wallet A9 inventory insufficient for referral obligation');
        }
        if (outcome?.code === 'OVER_QUOTA') {
          throw new PresaleError('OVER_QUOTA', 'exceeds personal unlocked quota');
        }
        if (outcome?.code === 'SOLD_OUT') {
          throw new PresaleError('SOLD_OUT', 'presale sold out');
        }
        if (outcome?.code === 'EXCEEDS_POOL') {
          throw new PresaleError('EXCEEDS_POOL', 'exceeds remaining presale supply');
        }
        const { reservedA9Raw, userReservedNano } = await this.repo.sumReserved(nowSec, walletKey);
        if (walletQuota !== null && walletQuota !== undefined && userReservedNano + tonNano > walletQuota) {
          throw new PresaleError('OVER_QUOTA', 'exceeds personal unlocked quota');
        }
        if (reservedA9Raw >= this.totalCapA9Raw) throw new PresaleError('SOLD_OUT', 'presale sold out');
        throw new PresaleError('EXCEEDS_POOL', 'exceeds remaining presale supply');
      }
      return this.formatOrder(order, reservation);
    }

    const inserted = await this.repo.insertOrderIfCapacity(order, {
      capA9Raw: this.totalCapA9Raw,
      userQuotaNano: walletQuota,
      nowSec,
    });
    if (!inserted) {
      const { reservedA9Raw, userReservedNano } = await this.repo.sumReserved(nowSec, walletKey);
      if (walletQuota !== null && walletQuota !== undefined && userReservedNano + tonNano > walletQuota) {
        throw new PresaleError('OVER_QUOTA', 'exceeds personal unlocked quota');
      }
      if (reservedA9Raw >= this.totalCapA9Raw) throw new PresaleError('SOLD_OUT', 'presale sold out');
      throw new PresaleError('EXCEEDS_POOL', 'exceeds remaining presale supply');
    }
    return this.formatOrder(order);
  }

  async getOrder(orderId) {
    const o = await this.repo.getOrder(orderId);
    return o ? this.formatOrder(o) : null;
  }

  async listOrders(walletAddress) {
    const rows = await this.repo.listOrdersByWallet(addressKey(walletAddress));
    return rows.map((o) => this.formatOrder(o));
  }

  /** True only when at least one order reached COMPLETED (payout confirmed). */
  async hasCompletedPurchase(walletAddress) {
    const rows = await this.repo.listOrdersByWallet(addressKey(walletAddress));
    return rows.some((o) => o.status === PRESALE_STATUS.COMPLETED);
  }

  /** True if any wallet in the provided list has at least one COMPLETED order. */
  async hasCompletedPurchaseForAny(wallets = []) {
    const seen = new Set();
    for (const w of wallets || []) {
      const clean = String(w || '').trim();
      if (!clean) continue;
      const k = addressKey(clean);
      if (seen.has(k)) continue;
      seen.add(k);
      if (await this.hasCompletedPurchase(clean)) return true;
    }
    return false;
  }

  /** Sum total COMPLETED GRAM nano volume across a deduplicated set of wallets (supports optional per-wallet minCreatedAt filter). */
  async sumCompletedVolumeNano(wallets = [], { minCreatedAtByWallet = null } = {}) {
    const seen = new Set();
    let total = 0n;
    for (const w of wallets || []) {
      const clean = String(w || '').trim();
      if (!clean) continue;
      const k = addressKey(clean);
      if (seen.has(k)) continue;
      seen.add(k);
      const minTs = minCreatedAtByWallet instanceof Map && minCreatedAtByWallet.has(k)
        ? Number(minCreatedAtByWallet.get(k) || 0)
        : 0;
      const rows = await this.repo.listOrdersByWallet(k);
      for (const o of rows) {
        if (o.status !== PRESALE_STATUS.COMPLETED) continue;
        if (minTs > 0 && Number(o.createdAt || 0) < minTs) continue;
        total += BigInt(o.tonNano || 0n);
      }
    }
    return total;
  }

  /**
   * 幂等补建已付款确认（COMPLETED）且选择 BOOST 模式的商城膨胀宝箱。
   * 当付款确认回调中创建膨胀箱发生瞬态故障时，可由查询入口或定时任务安全重跑补齐。
   */
  async ensureShopBoostChests(walletAddress = null, nowSec = Math.floor(Date.now() / 1000)) {
    if (!this.chestEngine || typeof this.chestEngine.createShopBoostChest !== 'function') return [];
    const orders = walletAddress
      ? (await this.repo.listOrdersByWallet(addressKey(walletAddress))).filter((o) => o.status === PRESALE_STATUS.COMPLETED)
      : await this.repo.listOrdersByStatus(PRESALE_STATUS.COMPLETED);
    const createdOrExisting = [];
    for (const order of orders) {
      if (order.openMode !== 'BOOST' || order.bonusRolled) continue;
      const matchedSku = order.skuId || CHEST_MALL_NANO_TO_SKU[String(order.tonNano ?? '')] || null;
      if (!matchedSku) continue;
      const ownerUid = order.tgUserId || order.walletKey || order.walletAddress;
      const chest = await this.chestEngine.createShopBoostChest(
        { userId: ownerUid, walletAddress: order.walletAddress, skuId: matchedSku, orderId: order.orderId },
        nowSec,
      );
      if (chest) createdOrExisting.push(chest);
    }
    return createdOrExisting;
  }

  async backfillLegacyWalletKeys() {
    if (typeof this.repo.backfillLegacyWalletKeys === 'function') {
      return this.repo.backfillLegacyWalletKeys();
    }
    return 0;
  }

  _refundAmount(receivedNano, passive) {
    // 零项目方 Gas 铁律：所有链上原路退款至少扣除链上退回 Gas 成本（默认 0.03 GRAM），确保热钱包 0 倒贴。
    const baseFee = this.refundFeeNano > 0n ? this.refundFeeNano : 0n;
    const fee = !passive && this.userFaultFeeNano !== null && this.userFaultFeeNano > baseFee
      ? this.userFaultFeeNano
      : baseFee;
    if (fee === 0n) return { refundNano: receivedNano, feeDeducted: false };
    return { refundNano: receivedNano > fee ? receivedNano - fee : 0n, feeDeducted: true };
  }

  /**
   * 识别是否属于原有推广领奖业务（claim:<id>）的合法付款，避免共用热钱包时误记为兑换异常。
   * 严格五重校验（P0-A）：
   *   1) 备注为 claim:<id> 且已挂载推广引擎并查得对应领取单；
   *   2) 收款钱包归属匹配：tx.to 必须等于该推广单收款热钱包（推广与兑换分热钱包时，打到兑换热钱包的转账绝不归为推广业务）；
   *   3) 付款人归属匹配：tx.from 按 addressKey 归一化后必须等于 claim.walletAddress；
   *   4) 金额精确匹配：receivedNano 必须严格等于 claim.feeRequiredNano（默认 0.06 GRAM），防止用合法领取单号掩盖 8 GRAM 等错额/大额入账；
   *   5) 领取单状态合法：未过期的 PENDING_FEE，或已被推广流程用同一笔 tx.txHash 消费（FEE_CONFIRMED/PAYOUT_SENT/COMPLETED），
   *      防止拿已过期或已完成的旧领取单号掩盖新的错付入账。
   * 任一条件不满足时返回 false，由兑换引擎继续按粉尘（<=0.1 GRAM）或异常入账（ANOMALY，进入人工退款队列）处理。
   */
  async _isPromoFlowTransfer(tx, memo, receivedNano, nowSec) {
    if (!memo.startsWith('claim:')) return false;
    const claimId = memo.slice(6).trim();
    if (!claimId) return false;
    if (!this.promoEngine || typeof this.promoEngine.getClaim !== 'function') return false;

    const claim = await this.promoEngine.getClaim(claimId);
    if (!claim) return false;

    const promoDest = claim.payTo || this.promoEngine.hotWalletAddress;
    if (!promoDest || addressKey(tx.to) !== addressKey(promoDest)) return false;

    if (!tx.from || !claim.walletAddress || addressKey(tx.from) !== addressKey(claim.walletAddress)) return false;

    let requiredNano;
    try {
      requiredNano = BigInt(String(claim.feeRequiredNano ?? ''));
    } catch {
      return false;
    }
    if (requiredNano <= 0n || receivedNano !== requiredNano) return false;

    if (claim.status === 'PENDING_FEE') {
      const exp = Number(claim.expiresAt || 0);
      if (exp > 0 && nowSec > exp) return false;
      return true;
    }
    const consumedStatuses = ['FEE_CONFIRMED', 'PAYOUT_SENT', 'COMPLETED'];
    if (consumedStatuses.includes(claim.status) && claim.feeTxHash && claim.feeTxHash === tx.txHash) {
      return true;
    }
    return false;
  }

  /**
   * Pure decision for one inbound transfer. Reads only — safe for dry-run.
   * action: REJECT | REPLAY | OTHER_FLOW | IGNORE_DUST | ANOMALY | REFUND | CONFIRM
   */
  async planInbound(tx, nowSec = Math.floor(Date.now() / 1000)) {
    if (!tx?.txHash) return { action: 'REJECT', reason: 'missing_tx_hash' };
    if (tx.finality !== 'finalized') return { action: 'REJECT', reason: 'not_finalized' };
    if (tx.aborted === true || tx.bounced === true) return { action: 'REJECT', reason: 'tx_not_successful' };
    if (addressKey(tx.to) !== addressKey(this.hotWalletAddress)) return { action: 'REJECT', reason: 'wrong_destination' };
    if (await this.repo.getInbound(tx.txHash)) return { action: 'REPLAY', reason: 'already_processed' };
    let receivedNano;
    try {
      receivedNano = BigInt(String(tx.valueNano ?? '0'));
      if (receivedNano < 0n) return { action: 'REJECT', reason: 'bad_value' };
    } catch {
      return { action: 'REJECT', reason: 'bad_value' };
    }

    const memo = String(tx.memo || '').trim();
    if (await this._isPromoFlowTransfer(tx, memo, receivedNano, nowSec)) {
      return { action: 'OTHER_FLOW', reason: 'promo_claim', txHash: tx.txHash, sender: tx.from || null, receivedNano, memo, orderId: null };
    }
    if (receivedNano <= DUST_LIMIT_NANO) {
      return { action: 'IGNORE_DUST', reason: 'dust', txHash: tx.txHash, sender: tx.from || null, receivedNano, memo, orderId: null };
    }

    const order = memo.startsWith('buy:') ? await this.repo.getOrderByMemo(memo) : null;
    const base = { txHash: tx.txHash, sender: tx.from, receivedNano, memo, orderId: order?.orderId || null };
    const refund = (reason, passive, touchesOrder) => ({
      ...base,
      action: 'REFUND',
      reason,
      touchesOrder,
      ...this._refundAmount(receivedNano, passive),
    });

    const anomaly = (reason, touchesOrder) => ({ ...base, action: 'ANOMALY', reason, touchesOrder, refundTo: tx.from || null });

    if (!order) return anomaly('no_matching_order', false);
    // 备注不能单独作为归属凭证：付款人必须匹配订单钱包且金额精确一致。
    if (addressKey(tx.from) !== order.walletKey) return anomaly('sender_mismatch', false);
    const normStatus = normalizeOrderStatus(order.status, order.payoutTxHash);
    if (normStatus === PRESALE_STATUS.EXPIRED && !order.inboundTxHash) {
      if (receivedNano !== this.expectedPayNano(order)) return anomaly('amount_mismatch', false);
      return refund('expired', true, true);
    }
    if (normStatus !== PRESALE_STATUS.PENDING_PAYMENT) {
      return anomaly('order_not_payable', false);
    }
    if (receivedNano !== this.expectedPayNano(order)) return anomaly('amount_mismatch', true);
    // 订单有效但已关闭或已过期：执行被动原路退款（扣除 0.03 GRAM 链上退回 Gas 成本，热钱包 0 倒贴）。
    if (!this.open) return refund('closed', true, true);
    if (nowSec > Number(order.expiresAt || 0) && Number(order.expiresAt || 0) > 0) return refund('expired', true, true);
    return { ...base, action: 'CONFIRM', reason: 'valid', a9AmountRaw: BigInt(order.a9AmountRaw) };
  }

  /** Plan + persist one inbound transfer. Returns the decision and whether it was applied. */
  async ingestInbound(tx, nowSec = Math.floor(Date.now() / 1000)) {
    const d = await this.planInbound(tx, nowSec);
    if (d.action === 'REJECT' || d.action === 'REPLAY') return { ...d, applied: false };
    const inbound = {
      txHash: tx.txHash,
      orderId: d.orderId || null,
      sender: tx.from || null,
      valueNano: String(d.receivedNano ?? tx.valueNano ?? '0'),
      memo: String(tx.memo || ''),
      decision: d.action,
      reason: d.reason,
      createdAt: nowSec,
    };
    let orderUpdate = null;
    let payout = null;
    if (d.action === 'ANOMALY') {
      inbound.anomaly = { status: ANOMALY_STATUS.OPEN, refundTo: d.refundTo };
      if (d.touchesOrder && d.orderId) {
        orderUpdate = {
          orderId: d.orderId,
          from: [PRESALE_STATUS.PENDING_PAYMENT, PRESALE_STATUS.PENDING_TON],
          patch: { status: PRESALE_STATUS.PAYMENT_EXCEPTION, inboundTxHash: tx.txHash, refundReason: d.reason, updatedAt: nowSec },
        };
      }
    } else if (d.action === 'CONFIRM') {
      orderUpdate = {
        orderId: d.orderId,
        from: [PRESALE_STATUS.PENDING_PAYMENT, PRESALE_STATUS.PENDING_TON],
        // 过期竞争守卫：避免 plan 与 commit 之间订单刚过期释放池子后仍被错误确认导致超卖。
        notExpiredAt: nowSec,
        patch: { status: PRESALE_STATUS.PAYMENT_CONFIRMED, inboundTxHash: tx.txHash, updatedAt: nowSec },
      };
    } else if (d.action === 'REFUND') {
      if (d.touchesOrder && d.orderId) {
        orderUpdate = {
          orderId: d.orderId,
          from: d.reason === 'expired'
            ? [PRESALE_STATUS.PENDING_PAYMENT, PRESALE_STATUS.PENDING_TON, PRESALE_STATUS.EXPIRED]
            : [PRESALE_STATUS.PENDING_PAYMENT, PRESALE_STATUS.PENDING_TON],
          patch: {
            status: d.refundNano > 0n ? PRESALE_STATUS.REFUND_PENDING : PRESALE_STATUS.REFUNDED,
            inboundTxHash: tx.txHash,
            refundTonNano: d.refundNano,
            refundReason: d.reason,
            updatedAt: nowSec,
          },
        };
      }
      if (d.refundNano > 0n) {
        payout = {
          payoutId: `refund:${tx.txHash}`,
          orderId: d.touchesOrder ? d.orderId : null,
          inboundTxHash: tx.txHash,
          kind: 'REFUND',
          recipient: tx.from,
          amount: d.refundNano.toString(),
          queryId: newQueryId(),
          status: PAYOUT_STATUS.PENDING,
          attempts: 0,
          ambiguous: false,
          txHash: null,
          lastError: null,
          createdAt: nowSec,
          updatedAt: nowSec,
        };
      }
    }
    const res = await this.repo.commitInbound({ inbound, orderUpdate, payout });
    if (res === 'REPLAY') return { ...d, action: 'REPLAY', applied: false };
    if (res === 'ORDER_RACE') return { ...d, action: 'ANOMALY', reason: 'order_state_race', applied: true, orderRace: true };
    return { ...d, applied: true };
  }

  async listAnomalies(status = ANOMALY_STATUS.OPEN) {
    return this.repo.listAnomalies(status);
  }

  /**
   * 人工处理异常入账：
   * - decision: 'REFUND'（退回原付款人）| 'CLOSE_NO_REFUND'（例如已线下退款，必须写备注）。
   * - 零项目方 Gas 手续费规则：链上原路退款至少扣除链上退回 Gas 成本（refundFeeNano，默认 0.03 GRAM），
   *   若额外配置了更高的 userFaultFeeNano，仅对 USER 责任方按较高值扣除，SYSTEM / UNKNOWN 恒仅扣基础退回 Gas。
   * - 所有权隔离（P0-B）：仅当该异常入账就是订单本人的错额付款且该订单确实绑定了该 txHash（PAYMENT_EXCEPTION）时，
   *   才关联该订单并驱动其状态；其他误付/重复付款的退款 orderId = null，绝不触碰原备注引用的任何订单。
   */
  async resolveAnomaly(txHash, { decision, faultParty, operator, note = '' } = {}, nowSec = Math.floor(Date.now() / 1000)) {
    const a = await this.repo.getInbound(txHash);
    if (!a || a.decision !== 'ANOMALY') throw new PresaleError('NOT_FOUND', 'anomaly not found');
    if (a.anomalyStatus !== ANOMALY_STATUS.OPEN) throw new PresaleError('ALREADY_RESOLVED', 'anomaly already resolved');
    if (!operator) throw new PresaleError('BAD_REQUEST', 'operator is required for the audit trail');
    if (!Object.values(FAULT_PARTY).includes(faultParty)) throw new PresaleError('BAD_REQUEST', 'faultParty must be USER, SYSTEM or UNKNOWN');
    const received = BigInt(a.valueNano);
    const resolution = { faultParty, operator: String(operator), note: String(note || '').slice(0, 500), resolvedAt: nowSec };
    if (decision === 'CLOSE_NO_REFUND') {
      if (!String(note || '').trim()) throw new PresaleError('BAD_REQUEST', 'a note is required when closing without refund');
      const ok = await this.repo.resolveAnomaly(txHash, { ...resolution, status: ANOMALY_STATUS.CLOSED_NO_REFUND, feeNano: 0n }, null, null);
      if (!ok) throw new PresaleError('ALREADY_RESOLVED', 'anomaly already resolved');
      return { txHash, status: ANOMALY_STATUS.CLOSED_NO_REFUND };
    }
    if (decision !== 'REFUND') throw new PresaleError('BAD_REQUEST', 'decision must be REFUND or CLOSE_NO_REFUND');

    const baseGasFee = this.refundFeeNano > 0n ? this.refundFeeNano : 0n;
    const feeNano =
      faultParty === FAULT_PARTY.USER && this.userFaultFeeNano !== null && this.userFaultFeeNano > baseGasFee
        ? this.userFaultFeeNano
        : baseGasFee;
    if (received <= feeNano) throw new PresaleError('BAD_AMOUNT', 'refund amount would be zero');
    const refundNano = received - feeNano;

    // 严格核验资金归属与订单绑定关系：绝不凭“存在 a.orderId”就自动修改无关或已完成的订单。
    let linkedOrderId = null;
    if (a.orderId && a.reason === 'amount_mismatch') {
      const o = await this.repo.getOrder(a.orderId);
      if (
        o &&
        o.inboundTxHash === txHash &&
        addressKey(a.sender) === o.walletKey &&
        o.status === PRESALE_STATUS.PAYMENT_EXCEPTION
      ) {
        linkedOrderId = o.orderId;
      }
    }

    const payout = {
      payoutId: `refund:${txHash}`,
      orderId: linkedOrderId,
      inboundTxHash: txHash,
      kind: 'REFUND',
      recipient: a.refundTo || a.sender,
      amount: refundNano.toString(),
      queryId: newQueryId(),
      status: PAYOUT_STATUS.PENDING,
      attempts: 0,
      ambiguous: false,
      txHash: null,
      lastError: null,
      createdAt: nowSec,
      updatedAt: nowSec,
    };
    const orderPatch = linkedOrderId
      ? {
          orderId: linkedOrderId,
          inboundTxHash: txHash,
          from: [PRESALE_STATUS.PAYMENT_EXCEPTION],
          patch: { status: PRESALE_STATUS.REFUND_PENDING, refundTonNano: refundNano, updatedAt: nowSec },
        }
      : null;
    const ok = await this.repo.resolveAnomaly(txHash, { ...resolution, status: ANOMALY_STATUS.REFUND_QUEUED, feeNano }, payout, orderPatch);
    if (!ok) throw new PresaleError('ALREADY_RESOLVED', 'anomaly already resolved');
    return { txHash, status: ANOMALY_STATUS.REFUND_QUEUED, refundNano: refundNano.toString(), feeNano: feeNano.toString(), recipient: payout.recipient };
  }

  /** PAYMENT_CONFIRMED -> PAYOUT_PENDING with a persisted payout instruction (idempotent). */
  async queueConfirmedPayouts(nowSec = Math.floor(Date.now() / 1000)) {
    let queued = 0;
    for (const o of await this.repo.listOrdersByStatus(PRESALE_STATUS.PAYMENT_CONFIRMED)) {
      // 合并直发账目隔离：o.a9AmountRaw 恒只存保底 baseA9Raw（用于 2 亿第 1 期硬顶与 6% 直推返佣），
      // 随机加赠 bonusA9Raw 按 orderId 幂等落库（发币重试绝不重掷），仅在 payout.amount 合并打款。
      const baseA9Raw = BigInt(o.a9AmountRaw);
      const matchedSku = o.skuId || CHEST_MALL_NANO_TO_SKU[String(o.tonNano ?? '')] || null;
      const pack = matchedSku ? CHEST_MALL_CATALOG[matchedSku] : null;
      const existingRes = typeof this.repo.getReservation === 'function'
        ? await this.repo.getReservation(o.orderId)
        : null;
      let bonusA9Raw = BigInt(o.bonusA9Raw || 0n);
      let bonusRolled = Boolean(o.bonusRolled);
      let reservedBudgetRaw = 0n;
      let useAtomicReservationSettle = false;
      let unusedBonusRaw = 0n;

      if (!bonusRolled && pack && BigInt(pack.maxBoostA9Raw || '0') > 0n) {
        const rolled = rollPaidChestBonusRaw(pack.maxBoostA9Raw, this.randomFn);
        bonusA9Raw = rolled.bonusRaw;
        if (existingRes && existingRes.bonusStatus === 'RESERVED' && !existingRes.legacyBackfilled) {
          // 接单时已将最高加赠预留计入 presale_promo.spent_raw：严禁付款后把加赠静默改为 0，出奖后原子释放未用差额。
          const reservedBonus = BigInt(existingRes.reservedBonusRaw || 0n);
          if (bonusA9Raw > reservedBonus) bonusA9Raw = reservedBonus;
          unusedBonusRaw = reservedBonus - bonusA9Raw;
          useAtomicReservationSettle = true;
        } else if (bonusA9Raw > 0n && this.budgetLedger && typeof this.budgetLedger.reserve === 'function') {
          // 迁移前存量订单（无接单预留或仅回填标记）：预算不足时禁止静默把加赠改 0，转人工复核保留用户权益。
          try {
            const rsv = await this.budgetLedger.reserve('presale_promo', bonusA9Raw, nowSec);
            if (!rsv?.legacySkipped) reservedBudgetRaw = bonusA9Raw;
          } catch (e) {
            if (e?.code === 'PROMO_BUDGET_EXHAUSTED') {
              await this.repo.patchOrder(
                o.orderId,
                { status: PRESALE_STATUS.NEEDS_REVIEW, lastError: 'LEGACY_ORDER_BONUS_BUDGET_EXHAUSTED', updatedAt: nowSec },
                [PRESALE_STATUS.PAYMENT_CONFIRMED],
              );
              continue;
            }
            throw e;
          }
        }
        bonusRolled = true;
      }
      const totalPayoutRaw = baseA9Raw + bonusA9Raw;
      const payout = {
        payoutId: `a9:${o.orderId}`,
        orderId: o.orderId,
        inboundTxHash: o.inboundTxHash,
        kind: 'A9',
        recipient: o.walletAddress,
        amount: totalPayoutRaw.toString(),
        queryId: newQueryId(),
        status: PAYOUT_STATUS.PENDING,
        attempts: 0,
        ambiguous: false,
        txHash: null,
        lastError: null,
        createdAt: nowSec,
        updatedAt: nowSec,
      };
      const orderPatch = {
        status: PRESALE_STATUS.PAYOUT_PENDING,
        bonusA9Raw,
        bonusRolled,
        updatedAt: nowSec,
      };
      let queuedOk = false;
      try {
        if (useAtomicReservationSettle && typeof this.repo.queuePayoutAtomic === 'function') {
          queuedOk = await this.repo.queuePayoutAtomic(
            o.orderId,
            PRESALE_STATUS.PAYMENT_CONFIRMED,
            orderPatch,
            payout,
            {
              settledBonusRaw: bonusA9Raw,
              unusedBonusRaw,
              budgetLedger: this.budgetLedger,
              nowSec,
            },
          );
        } else {
          queuedOk = await this.repo.queuePayout(o.orderId, PRESALE_STATUS.PAYMENT_CONFIRMED, orderPatch, payout);
          if (queuedOk && existingRes && existingRes.bonusStatus === 'RESERVED' && typeof this.repo.markReservationBonusSettled === 'function') {
            await this.repo.markReservationBonusSettled(o.orderId, bonusA9Raw, 0n, nowSec);
          }
        }
      } catch (e) {
        if (reservedBudgetRaw > 0n && this.budgetLedger && typeof this.budgetLedger.release === 'function') {
          await this.budgetLedger.release('presale_promo', reservedBudgetRaw, nowSec).catch(() => {});
        }
        throw e;
      }
      if (queuedOk) {
        queued += 1;
      } else if (reservedBudgetRaw > 0n && this.budgetLedger && typeof this.budgetLedger.release === 'function') {
        await this.budgetLedger.release('presale_promo', reservedBudgetRaw, nowSec).catch(() => {});
      }
    }
    return queued;
  }

  buildInstruction(p) {
    if (p.kind === 'A9') {
      return {
        payoutId: p.payoutId,
        orderId: p.orderId,
        op: '0x0f8a7ea5',
        queryId: p.queryId,
        fromHotWallet: this.hotWalletAddress,
        recipient: p.recipient,
        jettonAmountRaw: p.amount,
        attachedTonNano: JETTON_TRANSFER_GAS_NANO,
        sendExcessesTo: this.hotWalletAddress,
      };
    }
    return {
      payoutId: p.payoutId,
      orderId: p.orderId,
      queryId: p.queryId,
      recipient: p.recipient,
      tonNano: p.amount,
      memo: `refund:${p.queryId}`,
    };
  }

  async _markConfirmed(p, txHash, nowSec) {
    if (p.kind === 'A9') {
      const order = await this.repo.getOrder(p.orderId);
      let credit = null;
      if (order?.referrerId && addressKey(order.referrerId) !== order.walletKey) {
        const amountRaw = (BigInt(order.a9AmountRaw) * REFERRAL_BPS) / 100n;
        if (amountRaw > 0n) credit = { orderId: order.orderId, referrer: order.referrerId, amountRaw: amountRaw.toString(), status: 'PENDING', createdAt: nowSec, updatedAt: nowSec };
      }
      await this.repo.completeA9(p.payoutId, p.orderId, txHash, credit, nowSec);
      // 兼容旧版 BOOST 订单（未走合并直发的旧订单才补建 SHOP_BOOST 记录）
      const matchedSku = order?.skuId || CHEST_MALL_NANO_TO_SKU[String(order?.tonNano ?? '')] || null;
      if (order && order.openMode === 'BOOST' && !order.bonusRolled && matchedSku && this.chestEngine && typeof this.chestEngine.createShopBoostChest === 'function') {
        try {
          const ownerUid = order.tgUserId || order.walletKey || order.walletAddress;
          await this.chestEngine.createShopBoostChest({ userId: ownerUid, walletAddress: order.walletAddress, skuId: matchedSku, orderId: order.orderId }, nowSec);
        } catch (_) {
          // 宝箱记录补建异常绝不影响链上本金确认
        }
      }
      // 付费好友加速：直邀好友完成任意付费宝箱订单时，自动为邀请人当前免费宝箱 +3 点助力进度
      let resolvedRefTgUid = null;
      if (order?.referrerId && addressKey(order.referrerId) !== order.walletKey) {
        try {
          resolvedRefTgUid = /^\d{1,20}$/.test(String(order.referrerId).trim()) ? String(order.referrerId).trim() : null;
          if (!resolvedRefTgUid && this.identityStore && typeof this.identityStore.getTelegramUserIdByWallet === 'function') {
            resolvedRefTgUid = await this.identityStore.getTelegramUserIdByWallet(order.referrerId);
          }
          if (resolvedRefTgUid && this.chestEngine && typeof this.chestEngine.creditPaidReferralAssist === 'function') {
            const boostRes = await this.chestEngine.creditPaidReferralAssist(
              { ownerUserId: resolvedRefTgUid, orderId: order.orderId, helperUserId: order.tgUserId || order.walletKey },
              nowSec,
            );
            if (boostRes?.credited && this.broadcaster && typeof this.broadcaster.notifyChestAssistProgress === 'function') {
              await this.broadcaster.notifyChestAssistProgress({ chest: boostRes.chest, paidBoost: true, addedAssists: boostRes.addedAssists, nowSec }).catch(() => {});
            }
          }
        } catch (_) {
          // 免费箱付费加速异常绝不影响链上本金确认
        }
      }
      // 静默自动激活待激活金库（买家本人 + 直邀好友购箱解锁邀请人）
      if (order && this.predictionEngine && this.promoEngine && typeof this.predictionEngine.activateToPromo === 'function') {
        if (order.tgUserId && order.walletAddress) {
          try {
            await this.predictionEngine.activateToPromo(order.tgUserId, order.walletAddress, this.promoEngine, {
              qualified: true,
              nowMs: nowSec * 1000,
              activationId: `auto:order:${order.orderId}:buyer`,
            });
          } catch (_) {
            // 无待激活余额或已过期时静默跳过
          }
        }
        if (resolvedRefTgUid) {
          try {
            let refWallet = normalizeTonAddress(order.referrerId) ? order.referrerId : null;
            if (!refWallet && this.identityStore && typeof this.identityStore.getBinding === 'function') {
              const b = await this.identityStore.getBinding(resolvedRefTgUid, nowSec);
              refWallet = b?.walletAddress || null;
            }
            if (refWallet) {
              await this.predictionEngine.activateToPromo(resolvedRefTgUid, refWallet, this.promoEngine, {
                qualified: true,
                nowMs: nowSec * 1000,
                activationId: `auto:order:${order.orderId}:ref`,
              });
            }
          } catch (_) {
            // 邀请人静默自动激活异常绝不影响订单确认
          }
        }
      }
      // 极简 TG 战队群捷报：大额订单（含 99.99 GRAM 钻石宝箱）确认成交后异步触发
      if (order && this.broadcaster && typeof this.broadcaster.broadcastWhaleExchange === 'function') {
        try {
          await this.broadcaster.broadcastWhaleExchange({ order, nowSec });
        } catch (_) {
          // 推送异常绝不影响链上资产确认状态
        }
      }
      return;
    }
    // 退款确认必须原子提交 payout 与真正关联该入账的订单状态（无关异常退款 orderId 为 null，绝不触碰任何订单）。
    await this.repo.completeRefund(p.payoutId, p.orderId, p.inboundTxHash, txHash || p.txHash, nowSec);
  }

  async _needsReview(p, reason, nowSec) {
    await this.repo.markPayoutNeedsReview(p.payoutId, p.kind, p.orderId, p.inboundTxHash, reason, nowSec);
  }

  /**
   * Drive persisted payouts forward. Never re-broadcasts a payout whose previous attempt may
   * have reached the chain without first asking the verifier.
   * verifier(payout) -> { state: 'CONFIRMED'|'PENDING'|'NOT_FOUND'|'FAILED', txHash? }
   */
  async processPayouts(nowSec = Math.floor(Date.now() / 1000), { a9Broadcaster = null, refundBroadcaster = null, verifier = null, logger = null } = {}) {
    const s = { broadcast: 0, confirmed: 0, retry: 0, review: 0, waiting: 0, errors: [] };
    for (const p of await this.repo.listOpenPayouts()) {
      try {
        const age = nowSec - Number(p.updatedAt || 0);
        // 1) Uncertain state: crash mid-broadcast, or a failed attempt that may have landed.
        if (p.status === PAYOUT_STATUS.RETRY && p.ambiguous && age < STALE_BROADCAST_SEC) {
          s.waiting += 1; // give a possibly-landed transfer time to appear before asking the chain
          continue;
        }
        if ((p.status === PAYOUT_STATUS.BROADCASTING && age >= STALE_BROADCAST_SEC) || (p.status === PAYOUT_STATUS.RETRY && p.ambiguous)) {
          if (typeof verifier !== 'function') {
            await this._needsReview(p, 'uncertain broadcast and no chain verifier configured', nowSec);
            s.review += 1;
            continue;
          }
          const v = await verifier(p);
          if (v?.state === 'CONFIRMED') {
            await this._markConfirmed(p, v.txHash || p.txHash, nowSec);
            s.confirmed += 1;
            continue;
          }
          if (v?.state !== 'FAILED') {
            // 仅当拿到了真实链上 txHash 时才推进到 SENT；若崩溃回写前丢失 txHash 且仍未查到，
            // 绝不把无 hash 记录误标成 SENT（超期后转 NEEDS_REVIEW 人工核对）。
            const resolvedHash = v?.state === 'PENDING' ? (v.txHash || p.txHash || null) : null;
            if (resolvedHash) {
              await this.repo.markPayoutSent(p.payoutId, p.kind, p.orderId, p.inboundTxHash, resolvedHash, nowSec);
              s.waiting += 1;
            } else if (age > UNCONFIRMED_REVIEW_SEC) {
              await this._needsReview(p, 'uncertain broadcast requires reconciliation; absence from index is not proof of non-delivery', nowSec);
              s.review += 1;
            } else {
              s.waiting += 1;
            }
            continue;
          }
          // Only an explicit terminal failure permits an automatic retry.
          // NOT_FOUND (even after a full scan) cannot rule out indexer lag.
          await this.repo.markPayoutRetry(p.payoutId, p.kind, p.orderId, p.inboundTxHash, { ambiguous: false, lastError: p.lastError || null }, nowSec);
          p.status = PAYOUT_STATUS.RETRY;
          p.ambiguous = false;
        }
        if (p.status === PAYOUT_STATUS.BROADCASTING) {
          s.waiting += 1; // another worker is mid-broadcast
          continue;
        }

        // 2) Broadcast pending / retryable payouts.
        if (p.status === PAYOUT_STATUS.PENDING || p.status === PAYOUT_STATUS.RETRY) {
          const broadcaster = p.kind === 'A9' ? a9Broadcaster : refundBroadcaster;
          if (typeof broadcaster !== 'function') {
            s.waiting += 1; // manual refund / payout path; state stays visible
            continue;
          }
          if (Number(p.attempts || 0) >= MAX_PAYOUT_ATTEMPTS) {
            await this._needsReview(p, 'max payout attempts reached', nowSec);
            s.review += 1;
            continue;
          }
          const nextAttempt = Number(p.attempts || 0) + 1;
          // P0-1 防双花：每次重试（attempt >= 2）生成全新的 64-bit queryId 并清空旧 txHash，彻底与历史失败交易解耦
          const nextQueryId = nextAttempt > 1 ? newQueryId() : p.queryId;
          const claimPatch = {
            status: PAYOUT_STATUS.BROADCASTING,
            attempts: nextAttempt,
            updatedAt: nowSec,
            ...(nextAttempt > 1 ? { queryId: nextQueryId, txHash: null } : {}),
          };
          const claimed = await this.repo.claimPayout(p.payoutId, [PAYOUT_STATUS.PENDING, PAYOUT_STATUS.RETRY], claimPatch);
          if (!claimed) continue;
          p.attempts = nextAttempt;
          if (nextAttempt > 1) {
            p.queryId = nextQueryId;
            p.txHash = null;
          }
          let justBroadcast = false;
          try {
            const sent = await broadcaster(this.buildInstruction(p));
            if (!sent?.txHash) throw Object.assign(new Error('broadcaster returned no txHash'), { notSent: false });
            await this.repo.markPayoutSent(p.payoutId, p.kind, p.orderId, p.inboundTxHash, sent.txHash, nowSec);
            p.status = PAYOUT_STATUS.SENT;
            p.txHash = sent.txHash;
            p.updatedAt = nowSec;
            justBroadcast = true;
            s.broadcast += 1;
          } catch (e) {
            const msg = String(e?.message || e).slice(0, 300);
            const deterministic = e?.deterministic === true
              || /insufficient hot wallet|insufficient.*inventory|insufficient.*balance|insufficient.*gas|not deployed yet|wallet address mismatch|ops_confirm|missing positive|missing a9_|exceeds single-cell|enoent/i.test(msg);
            await this.repo.markPayoutRetry(p.payoutId, p.kind, p.orderId, p.inboundTxHash, { ambiguous: e?.notSent !== true && !deterministic, lastError: msg }, nowSec);
            s.retry += 1;
            if (deterministic) {
              s.errors.push({ payoutId: p.payoutId, code: e?.code || 'DETERMINISTIC_BROADCAST_FAILURE', message: msg });
            }
            logger?.log?.(`[presale] payout ${p.payoutId} broadcast failed: ${msg}`);
            continue;
          }
          // 刚广播完成时若立即核验：允许命中 CONFIRMED，但严禁在同一 tick 内因索引延迟被判 FAILED 触发重发
          if (justBroadcast && typeof verifier === 'function') {
            const v = await verifier(p);
            if (v?.state === 'CONFIRMED') {
              await this._markConfirmed(p, v.txHash || p.txHash, nowSec);
              s.confirmed += 1;
            } else {
              s.waiting += 1;
            }
            continue;
          }
        }

        // 3) Sent -> confirm on chain.
        if (p.status === PAYOUT_STATUS.SENT) {
          if (typeof verifier !== 'function') {
            s.waiting += 1;
            continue;
          }
          const v = await verifier(p);
          if (v?.state === 'CONFIRMED') {
            await this._markConfirmed(p, v.txHash || p.txHash, nowSec);
            s.confirmed += 1;
          } else if (v?.state === 'FAILED') {
            await this.repo.markPayoutRetry(p.payoutId, p.kind, p.orderId, p.inboundTxHash, { ambiguous: false, lastError: 'on-chain transfer failed' }, nowSec);
            s.retry += 1;
          } else if (nowSec - Number(p.updatedAt || 0) > UNCONFIRMED_REVIEW_SEC) {
            await this._needsReview(p, 'sent but unconfirmed for too long', nowSec);
            s.review += 1;
          } else {
            s.waiting += 1;
          }
        }
      } catch (e) {
        s.errors.push({ payoutId: p.payoutId, message: String(e?.message || e) });
      }
    }
    return s;
  }

  /** Book referral rewards for COMPLETED orders exactly once (stale CREDITING goes to NEEDS_REVIEW, never double-credits). */
  async processReferralCredits(
    nowSec = Math.floor(Date.now() / 1000),
    { promoEngine = this.promoEngine, identityStore = this.identityStore, budgetLedger = this.budgetLedger, creditingStaleSec = 0 } = {},
  ) {
    const s = { credited: 0, deferred: 0, review: 0, budgetExhausted: 0 };
    for (const c of await this.repo.listCredits('CREDITING')) {
      const age = nowSec - Number(c.updatedAt || 0);
      if (creditingStaleSec > 0 && age < creditingStaleSec) continue;
      await this.repo.patchCredit(c.orderId, { status: 'NEEDS_REVIEW', updatedAt: nowSec });
      s.review += 1;
    }
    if (!promoEngine || typeof promoEngine.creditReward !== 'function') return s;
    const strictTonAddr = Boolean(normalizeTonAddress(this.hotWalletAddress));
    const isUsableWallet = (addr) => Boolean(
      normalizeTonAddress(addr) || (!strictTonAddr && /^(?:EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{4,}$/.test(String(addr || '').trim())),
    );
    for (const c of await this.repo.listCredits('PENDING')) {
      let targetWallet = c.referrer;
      if (!isUsableWallet(targetWallet)) {
        if (/^\d{1,20}$/.test(String(targetWallet || '').trim())) {
          if (!identityStore || typeof identityStore.getBinding !== 'function') {
            // 纯数字 Telegram ID 缺少 identityStore 解析器时延迟记账，绝不误当作钱包地址入账
            s.deferred += 1;
            continue;
          }
          const binding = await identityStore.getBinding(String(targetWallet).trim(), nowSec);
          if (!binding?.walletAddress) {
            s.deferred += 1;
            continue;
          }
          targetWallet = binding.walletAddress;
        } else {
          // 非合法 TON 地址且非纯数字 TG ID：拦截进入人工复核，严禁消耗真实预算记入黑洞地址
          await this.repo.patchCredit(c.orderId, { status: 'NEEDS_REVIEW', updatedAt: nowSec });
          s.review += 1;
          continue;
        }
      }
      if (!(await this.repo.claimCredit(c.orderId, 'PENDING', 'CREDITING', nowSec))) continue;
      const resRow = typeof this.repo.getReservation === 'function' ? await this.repo.getReservation(c.orderId) : null;
      const preReserved = Boolean(
        resRow && resRow.referralStatus === 'RESERVED' && !resRow.legacyBackfilled && BigInt(resRow.reservedReferralRaw || 0n) >= BigInt(c.amountRaw || 0n),
      );
      let reservedBudget = false;
      if (!preReserved && budgetLedger && typeof budgetLedger.reserve === 'function') {
        try {
          const rsv = await budgetLedger.reserve('presale_promo', BigInt(c.amountRaw), nowSec);
          reservedBudget = !rsv?.legacySkipped;
        } catch (e) {
          await this.repo.patchCredit(c.orderId, { status: 'PENDING', updatedAt: nowSec });
          if (e?.code === 'PROMO_BUDGET_EXHAUSTED') {
            s.budgetExhausted += 1;
            continue;
          }
          s.review += 1;
          continue;
        }
      }
      try {
        await promoEngine.creditReward(targetWallet, BigInt(c.amountRaw), nowSec);
      } catch (e) {
        const deterministicFail = e?.code === 'CONFLICT' || e?.code === 'BAD_WALLET' || e?.code === 'BAD_AMOUNT';
        if (deterministicFail) {
          if (reservedBudget && budgetLedger && typeof budgetLedger.release === 'function') {
            await budgetLedger.release('presale_promo', BigInt(c.amountRaw), nowSec).catch(() => {});
          }
          await this.repo.patchCredit(c.orderId, { status: e?.code === 'CONFLICT' ? 'PENDING' : 'NEEDS_REVIEW', updatedAt: nowSec });
        }
        s.review += 1;
        continue;
      }
      await this.repo.patchCredit(c.orderId, { status: 'CREDITED', updatedAt: nowSec });
      if (resRow && resRow.referralStatus === 'RESERVED' && typeof this.repo.markReservationReferralCredited === 'function') {
        await this.repo.markReservationReferralCredited(c.orderId, nowSec);
      }
      s.credited += 1;
      if (this.broadcaster && typeof this.broadcaster.notifyReferralCommission === 'function') {
        try {
          const order = await this.repo.getOrder(c.orderId);
          await this.broadcaster.notifyReferralCommission({ order, credit: { ...c, targetWallet }, nowSec });
        } catch (_) {
          // 私聊报喜异常绝不影响返佣入账
        }
      }
    }
    return s;
  }

  /**
   * Release presale_promo reservations for expired unpaid orders (mutually exclusive with payment confirmation)
   * and refunded/cancelled orders that have NO active/in-flight/ambiguous A9 payout.
   */
  async releaseExpiredOrRefundedReservations(nowSec = Math.floor(Date.now() / 1000), { budgetLedger = this.budgetLedger, limit = 50 } = {}) {
    if (typeof this.repo.releaseExpiredOrRefundedReservations !== 'function') {
      return { expiredReleased: 0, refundedReleased: 0, releasedRaw: '0' };
    }
    return this.repo.releaseExpiredOrRefundedReservations(nowSec, { budgetLedger, limit });
  }

  async getOrderReservation(orderId) {
    if (typeof this.repo.getReservation !== 'function') return null;
    return this.repo.getReservation(orderId);
  }

  async getReferralCredit(orderId) {
    return this.repo.getCredit(orderId);
  }

  formatOrder(o, reservation = null) {
    const status = normalizeOrderStatus(o.status, o.payoutTxHash);
    const tonNanoBig = BigInt(o.tonNano);
    const tonNanoStr = tonNanoBig.toString();
    const deliveryFeeNanoStr = this.deliveryFeeNano.toString();
    const payTonNanoStr = (tonNanoBig + this.deliveryFeeNano).toString();
    const skuId = o.skuId || CHEST_MALL_NANO_TO_SKU[tonNanoStr] || null;
    const baseA9Big = BigInt(o.a9AmountRaw);
    const bonusA9Big = BigInt(o.bonusA9Raw || 0n);
    const out = {
      orderId: o.orderId,
      walletAddress: o.walletAddress,
      referrerId: o.referrerId || null,
      tonNano: tonNanoStr,
      deliveryFeeNano: deliveryFeeNanoStr,
      payTonNano: payTonNanoStr,
      a9AmountRaw: baseA9Big.toString(),
      baseA9Raw: baseA9Big.toString(),
      bonusA9Raw: bonusA9Big.toString(),
      totalA9Raw: (baseA9Big + bonusA9Big).toString(),
      bonusRolled: Boolean(o.bonusRolled),
      payTo: this.hotWalletAddress,
      memo: o.memo,
      status,
      legacyStatus: status !== o.status ? o.status : null,
      inboundTxHash: o.inboundTxHash || null,
      payoutTxHash: o.payoutTxHash || null,
      refundTonNano: BigInt(o.refundTonNano || 0n).toString(),
      refundReason: o.refundReason || null,
      expiresAt: Number(o.expiresAt || 0) || null,
      createdAt: Number(o.createdAt),
      updatedAt: Number(o.updatedAt),
    };
    if (reservation) {
      out.reservedBonusRaw = BigInt(reservation.reservedBonusRaw || 0n).toString();
      out.reservedReferralRaw = BigInt(reservation.reservedReferralRaw || 0n).toString();
    }
    if (skuId) {
      out.skuId = skuId;
      out.openMode = o.openMode || 'INSTANT';
    } else if (o.openMode === 'BOOST') {
      out.openMode = 'BOOST';
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// In-memory repository (local dev server + unit tests). Single-threaded, so each method is
// atomic as long as it does not await between read and write.
// ---------------------------------------------------------------------------
const clone = (o) => (o ? { ...o } : null);

export class MemoryPresaleRepo {
  constructor() {
    this.orders = new Map();
    this.reservations = new Map();
    this.memoIndex = new Map();
    this.inbound = new Map();
    this.payouts = new Map();
    this.credits = new Map();
    this.cursors = new Map();
  }

  _reserves(o, nowSec) {
    return RESERVING_STATUSES.includes(o.status) || (o.status === 'PENDING_PAYMENT' && Number(o.expiresAt) >= nowSec);
  }

  _sumReservedSync(nowSec, walletKey) {
    let reservedA9Raw = 0n;
    let userReservedNano = 0n;
    for (const o of this.orders.values()) {
      if (!this._reserves(o, nowSec)) continue;
      reservedA9Raw += BigInt(o.a9AmountRaw);
      if (o.walletKey === walletKey) userReservedNano += BigInt(o.tonNano);
    }
    return { reservedA9Raw, userReservedNano };
  }

  async sumReserved(nowSec, walletKey) {
    return this._sumReservedSync(nowSec, walletKey);
  }

  _presaleOutstandingA9Sync(nowSec) {
    let sum = 0n;
    const payoutOrderIds = new Set();
    for (const p of this.payouts.values()) {
      if (p.kind !== 'A9') continue;
      if (['PENDING', 'BROADCASTING', 'RETRY', 'SENT', 'NEEDS_REVIEW', 'CONFIRMED'].includes(p.status)) {
        sum += BigInt(p.amount || '0');
        if (p.orderId) payoutOrderIds.add(p.orderId);
      }
    }
    for (const o of this.orders.values()) {
      if (payoutOrderIds.has(o.orderId)) continue;
      if (o.status === 'PENDING_PAYMENT' && (Number(o.expiresAt || 0) === 0 || Number(o.expiresAt) >= nowSec)) {
        const r = this.reservations.get(o.orderId);
        sum += BigInt(o.a9AmountRaw) + BigInt(r?.reservedBonusRaw || 0n);
      } else if (o.status === 'PAYMENT_CONFIRMED' || o.status === 'NEEDS_REVIEW' || o.status === 'PAID_A9') {
        const r = this.reservations.get(o.orderId);
        const bonus = r?.bonusStatus === 'SETTLED' ? BigInt(r.settledBonusRaw || 0n) : BigInt(r?.reservedBonusRaw || o.bonusA9Raw || 0n);
        sum += BigInt(o.a9AmountRaw) + bonus;
      }
    }
    return sum;
  }

  _promoOutstandingA9Sync(promoEngine) {
    let sum = 0n;
    if (promoEngine?.balances instanceof Map) {
      for (const b of promoEngine.balances.values()) sum += BigInt(b.claimableRaw || 0n);
    }
    if (promoEngine?.payouts instanceof Map) {
      for (const p of promoEngine.payouts.values()) {
        if (['PENDING', 'BROADCASTING', 'RETRY', 'SENT', 'NEEDS_REVIEW', 'CONFIRMED'].includes(p.status)) {
          sum += BigInt(p.amountRaw || 0n);
        }
      }
    }
    if (promoEngine?.claims instanceof Map) {
      for (const c of promoEngine.claims.values()) {
        if (['FEE_CONFIRMED', 'PAYOUT_SENT'].includes(c.status)) {
          const hasPayout = promoEngine.payouts instanceof Map && [...promoEngine.payouts.values()].some((p) => p.claimId === c.claimId);
          if (!hasPayout) sum += BigInt(c.amountRaw || 0n);
        }
      }
    }
    const reservedOrderIds = new Set();
    for (const r of this.reservations.values()) {
      if (r.referralStatus === 'RESERVED') {
        sum += BigInt(r.reservedReferralRaw || 0n);
        reservedOrderIds.add(r.orderId);
      }
    }
    for (const c of this.credits.values()) {
      if (['PENDING', 'CREDITING', 'NEEDS_REVIEW'].includes(c.status) && !reservedOrderIds.has(c.orderId)) {
        sum += BigInt(c.amountRaw || 0n);
      }
    }
    return sum;
  }

  async createOrderAtomic(order, reservation, { capA9Raw, userQuotaNano, nowSec, budgetLedger = null, inventorySnapshot = null, promoEngine = null }) {
    const { reservedA9Raw, userReservedNano } = this._sumReservedSync(nowSec, order.walletKey);
    if (userQuotaNano !== null && userQuotaNano !== undefined && userReservedNano + BigInt(order.tonNano) > userQuotaNano) {
      return { ok: false, code: 'OVER_QUOTA' };
    }
    if (reservedA9Raw >= capA9Raw) return { ok: false, code: 'SOLD_OUT' };
    if (reservedA9Raw + BigInt(order.a9AmountRaw) > capA9Raw) return { ok: false, code: 'EXCEEDS_POOL' };

    const newPresaleNeed = BigInt(order.a9AmountRaw) + BigInt(reservation.reservedBonusRaw || 0n);
    if (inventorySnapshot?.presale) {
      const used = this._presaleOutstandingA9Sync(nowSec);
      if (used + newPresaleNeed > inventorySnapshot.presale.a9Raw) {
        return { ok: false, code: 'HOT_WALLET_LOW_INVENTORY' };
      }
    }
    const newRefNeed = BigInt(reservation.reservedReferralRaw || 0n);
    if (newRefNeed > 0n && inventorySnapshot?.promo) {
      const usedPromo = this._promoOutstandingA9Sync(promoEngine);
      if (usedPromo + newRefNeed > inventorySnapshot.promo.a9Raw) {
        return { ok: false, code: 'PROMO_WALLET_LOW_INVENTORY' };
      }
    }

    const budgetNeed = BigInt(reservation.reservedBonusRaw || 0n) + newRefNeed;
    // Mutate synchronously BEFORE any await so concurrent callers cannot double-use inventory/capacity.
    this.orders.set(order.orderId, { ...order });
    this.reservations.set(order.orderId, { ...reservation });
    this.memoIndex.set(order.memo, order.orderId);
    if (budgetNeed > 0n && budgetLedger && typeof budgetLedger.reserve === 'function') {
      try {
        await budgetLedger.reserve('presale_promo', budgetNeed, nowSec);
      } catch (e) {
        this.orders.delete(order.orderId);
        this.reservations.delete(order.orderId);
        this.memoIndex.delete(order.memo);
        throw e;
      }
    }
    return { ok: true };
  }

  async getReservation(orderId) { return clone(this.reservations.get(orderId)); }

  async queuePayoutAtomic(orderId, fromStatus, patch, payout, { settledBonusRaw = 0n, unusedBonusRaw = 0n, budgetLedger = null, nowSec = Math.floor(Date.now() / 1000) } = {}) {
    const o = this.orders.get(orderId);
    const r = this.reservations.get(orderId);
    if (!o || o.status !== fromStatus || !r || r.bonusStatus !== 'RESERVED' || this._hasConflictingPayout(payout)) return false;
    const prevOrder = { ...o };
    const prevRes = { ...r };
    // Mutate synchronously BEFORE any await so concurrent callers cannot both settle the same order.
    Object.assign(o, patch);
    this.payouts.set(payout.payoutId, { ...payout });
    Object.assign(r, {
      settledBonusRaw: BigInt(settledBonusRaw),
      releasedBonusRaw: BigInt(unusedBonusRaw),
      bonusStatus: 'SETTLED',
      status: ['NONE', 'CREDITED', 'RELEASED'].includes(r.referralStatus) ? 'COMPLETED' : 'ACTIVE',
      updatedAt: nowSec,
    });
    if (unusedBonusRaw > 0n && budgetLedger && typeof budgetLedger.release === 'function') {
      try {
        await budgetLedger.release('presale_promo', unusedBonusRaw, nowSec);
      } catch (e) {
        Object.assign(o, prevOrder);
        this.payouts.delete(payout.payoutId);
        Object.assign(r, prevRes);
        throw e;
      }
    }
    return true;
  }

  async markReservationBonusSettled(orderId, settledBonusRaw, releasedBonusRaw, nowSec) {
    const r = this.reservations.get(orderId);
    if (!r || r.bonusStatus !== 'RESERVED') return false;
    Object.assign(r, {
      settledBonusRaw: BigInt(settledBonusRaw),
      releasedBonusRaw: BigInt(releasedBonusRaw),
      bonusStatus: 'SETTLED',
      status: ['NONE', 'CREDITED', 'RELEASED'].includes(r.referralStatus) ? 'COMPLETED' : 'ACTIVE',
      updatedAt: nowSec,
    });
    return true;
  }

  async markReservationReferralCredited(orderId, nowSec) {
    const r = this.reservations.get(orderId);
    if (!r || r.referralStatus !== 'RESERVED') return false;
    Object.assign(r, {
      referralStatus: 'CREDITED',
      status: ['SETTLED', 'RELEASED'].includes(r.bonusStatus) ? 'COMPLETED' : 'ACTIVE',
      updatedAt: nowSec,
    });
    return true;
  }

  async releaseExpiredOrRefundedReservations(nowSec, { budgetLedger = null, limit = 50 } = {}) {
    let expiredReleased = 0;
    let refundedReleased = 0;
    let releasedTotal = 0n;
    const maxCount = Math.max(1, Number(limit || 50));
    for (const r of this.reservations.values()) {
      if (expiredReleased + refundedReleased >= maxCount) break;
      if (r.status !== 'ACTIVE') continue;
      const o = this.orders.get(r.orderId);
      if (!o) continue;
      const hasAnyA9Payout = [...this.payouts.values()].some(
        (p) => p.orderId === o.orderId && p.kind === 'A9' && ['PENDING', 'BROADCASTING', 'SENT', 'RETRY', 'CONFIRMED', 'NEEDS_REVIEW'].includes(p.status),
      );
      const hasAnyCredit = this.credits.has(o.orderId);
      if (hasAnyA9Payout || hasAnyCredit) continue;

      const isExpiredUnpaid = ['PENDING_PAYMENT', 'PENDING_TON'].includes(o.status)
        && !o.inboundTxHash
        && Number(o.expiresAt || 0) > 0
        && Number(o.expiresAt) < nowSec;
      const isRefundedOrCancelled = ['REFUNDED', 'REFUNDED_FREE', 'REFUNDED_MINUS_FEE', 'CANCELLED'].includes(o.status);
      if (!isExpiredUnpaid && !isRefundedOrCancelled) continue;

      let delta = 0n;
      if (!r.legacyBackfilled) {
        if (r.bonusStatus === 'RESERVED') delta += BigInt(r.reservedBonusRaw || 0n);
        if (r.referralStatus === 'RESERVED') delta += BigInt(r.reservedReferralRaw || 0n);
      }
      if (isExpiredUnpaid) {
        o.status = PRESALE_STATUS.EXPIRED;
        o.updatedAt = nowSec;
        expiredReleased += 1;
      } else {
        refundedReleased += 1;
      }
      if (r.bonusStatus === 'RESERVED') {
        r.bonusStatus = 'RELEASED';
        r.releasedBonusRaw = BigInt(r.reservedBonusRaw || 0n);
      }
      if (r.referralStatus === 'RESERVED') r.referralStatus = 'RELEASED';
      r.status = 'RELEASED';
      r.updatedAt = nowSec;
      if (delta > 0n && budgetLedger && typeof budgetLedger.release === 'function') {
        await budgetLedger.release('presale_promo', delta, nowSec);
        releasedTotal += delta;
      }
    }
    return { expiredReleased, refundedReleased, releasedRaw: releasedTotal.toString() };
  }

  async insertOrderIfCapacity(order, { capA9Raw, userQuotaNano, nowSec }) {
    // Check + insert with no await in between, so concurrent callers cannot both pass the check.
    const { reservedA9Raw, userReservedNano } = this._sumReservedSync(nowSec, order.walletKey);
    if (reservedA9Raw + BigInt(order.a9AmountRaw) > capA9Raw) return false;
    if (userQuotaNano !== null && userQuotaNano !== undefined && userReservedNano + BigInt(order.tonNano) > userQuotaNano) return false;
    this.orders.set(order.orderId, { ...order });
    this.memoIndex.set(order.memo, order.orderId);
    return true;
  }

  async getOrder(id) { return clone(this.orders.get(id)); }
  async getOrderByMemo(memo) { const id = this.memoIndex.get(memo); return id ? clone(this.orders.get(id)) : null; }
  async listOrdersByWallet(walletKey) {
    return [...this.orders.values()].filter((o) => o.walletKey === walletKey).sort((a, b) => b.createdAt - a.createdAt).map(clone);
  }
  async listOrdersByStatus(status) { return [...this.orders.values()].filter((o) => o.status === status).map(clone); }
  async getInbound(txHash) { return clone(this.inbound.get(txHash)); }

  _hasConflictingPayout(payout) {
    if (!payout) return false;
    if (this.payouts.has(payout.payoutId)) return true;
    for (const existing of this.payouts.values()) {
      if (payout.kind === 'A9' && payout.orderId && existing.kind === 'A9' && existing.orderId === payout.orderId) return true;
      if (payout.kind === 'REFUND' && payout.inboundTxHash && existing.kind === 'REFUND' && existing.inboundTxHash === payout.inboundTxHash) return true;
    }
    return false;
  }

  _patchOwnedOrderSync(kind, orderId, inboundTxHash, allowedFrom, patch) {
    if (!orderId) return false;
    const o = this.orders.get(orderId);
    if (!o || !allowedFrom.includes(o.status)) return false;
    if (kind === 'REFUND' && (!inboundTxHash || o.inboundTxHash !== inboundTxHash)) return false;
    Object.assign(o, patch);
    return true;
  }

  async commitInbound({ inbound, orderUpdate, payout }) {
    if (this.inbound.has(inbound.txHash)) return 'REPLAY';
    if (this._hasConflictingPayout(payout)) return 'REPLAY';
    let race = false;
    if (orderUpdate) {
      const o = this.orders.get(orderUpdate.orderId);
      const notExpired = !orderUpdate.notExpiredAt || !o?.expiresAt || Number(o.expiresAt) >= orderUpdate.notExpiredAt;
      if (o && orderUpdate.from.includes(o.status) && notExpired) Object.assign(o, orderUpdate.patch);
      else race = true;
    }
    const row = race
      ? { ...inbound, decision: 'ANOMALY', reason: 'order_state_race', anomalyStatus: ANOMALY_STATUS.OPEN, refundTo: inbound.sender || null }
      : { ...inbound, anomalyStatus: null, refundTo: null };
    if (!race && inbound.anomaly) {
      Object.assign(row, { anomalyStatus: inbound.anomaly.status, refundTo: inbound.anomaly.refundTo });
    }
    delete row.anomaly;
    this.inbound.set(inbound.txHash, row);
    // 发生订单状态竞态时绝不插入孤儿 payout，统一转入 ANOMALY 供审核退款。
    if (payout && !race) this.payouts.set(payout.payoutId, { ...payout });
    return race ? 'ORDER_RACE' : 'OK';
  }

  async listAnomalies(status) {
    return [...this.inbound.values()].filter((r) => r.decision === 'ANOMALY' && (!status || r.anomalyStatus === status)).map(clone);
  }

  async resolveAnomaly(txHash, resolution, payout, orderPatch) {
    const r = this.inbound.get(txHash);
    if (!r || r.decision !== 'ANOMALY' || r.anomalyStatus !== 'OPEN') return false;
    if (this._hasConflictingPayout(payout)) return false;
    Object.assign(r, {
      anomalyStatus: resolution.status,
      faultParty: resolution.faultParty,
      feeNano: resolution.feeNano.toString(),
      resolvedBy: resolution.operator,
      resolvedAt: resolution.resolvedAt,
      resolutionNote: resolution.note,
    });
    if (payout) this.payouts.set(payout.payoutId, { ...payout });
    if (orderPatch) {
      const o = this.orders.get(orderPatch.orderId);
      const boundOk = !orderPatch.inboundTxHash || o?.inboundTxHash === orderPatch.inboundTxHash;
      if (o && boundOk && orderPatch.from.includes(o.status)) Object.assign(o, orderPatch.patch);
    }
    return true;
  }

  async queuePayout(orderId, fromStatus, patch, payout) {
    const o = this.orders.get(orderId);
    if (!o || o.status !== fromStatus || this._hasConflictingPayout(payout)) return false;
    Object.assign(o, patch);
    this.payouts.set(payout.payoutId, { ...payout });
    return true;
  }

  async listOpenPayouts() {
    return [...this.payouts.values()]
      .filter((p) => ['PENDING', 'BROADCASTING', 'RETRY', 'SENT'].includes(p.status))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(clone);
  }

  async getPayout(id) { return clone(this.payouts.get(id)); }

  async claimPayout(id, fromStatuses, patch) {
    const p = this.payouts.get(id);
    if (!p || !fromStatuses.includes(p.status)) return false;
    Object.assign(p, patch);
    return true;
  }

  async patchPayout(id, patch) { const p = this.payouts.get(id); if (p) Object.assign(p, patch); }

  async patchOrder(id, patch, expect = null) {
    const o = this.orders.get(id);
    if (!o || (expect && !expect.includes(o.status))) return false;
    Object.assign(o, patch);
    return true;
  }

  async markPayoutSent(payoutId, kind, orderId, inboundTxHash, txHash, nowSec) {
    const p = this.payouts.get(payoutId);
    if (!p || !['PENDING', 'BROADCASTING', 'RETRY', 'SENT'].includes(p.status)) return false;
    const nextHash = txHash || p.txHash || null;
    Object.assign(p, { status: 'SENT', txHash: nextHash, ambiguous: false, lastError: null, updatedAt: nowSec });
    const o = orderId ? this.orders.get(orderId) : null;
    const orderHash = nextHash || o?.payoutTxHash || null;
    if (kind === 'A9') {
      this._patchOwnedOrderSync('A9', orderId, inboundTxHash, ['PAYOUT_PENDING', 'PAYOUT_RETRY', 'PAYOUT_SENT'], {
        status: 'PAYOUT_SENT', payoutTxHash: orderHash, lastError: null, updatedAt: nowSec,
      });
    } else {
      this._patchOwnedOrderSync('REFUND', orderId, inboundTxHash, ['REFUND_PENDING', 'REFUND_SENT'], {
        status: 'REFUND_SENT', payoutTxHash: orderHash, lastError: null, updatedAt: nowSec,
      });
    }
    return true;
  }

  async markPayoutRetry(payoutId, kind, orderId, inboundTxHash, { ambiguous = false, lastError = null } = {}, nowSec) {
    const p = this.payouts.get(payoutId);
    if (!p || !['PENDING', 'BROADCASTING', 'RETRY', 'SENT'].includes(p.status)) return false;
    Object.assign(p, { status: 'RETRY', ambiguous: Boolean(ambiguous), lastError, updatedAt: nowSec });
    if (kind === 'A9') {
      this._patchOwnedOrderSync('A9', orderId, inboundTxHash, ['PAYOUT_PENDING', 'PAYOUT_RETRY', 'PAYOUT_SENT'], {
        status: 'PAYOUT_RETRY', lastError, updatedAt: nowSec,
      });
    } else {
      this._patchOwnedOrderSync('REFUND', orderId, inboundTxHash, ['REFUND_PENDING', 'REFUND_SENT'], {
        status: 'REFUND_PENDING', lastError, updatedAt: nowSec,
      });
    }
    return true;
  }

  async markPayoutNeedsReview(payoutId, kind, orderId, inboundTxHash, reason, nowSec) {
    const p = this.payouts.get(payoutId);
    if (!p || !['PENDING', 'BROADCASTING', 'RETRY', 'SENT'].includes(p.status)) return false;
    Object.assign(p, { status: 'NEEDS_REVIEW', lastError: reason, updatedAt: nowSec });
    if (kind === 'A9') {
      this._patchOwnedOrderSync('A9', orderId, inboundTxHash, ['PAYOUT_PENDING', 'PAYOUT_RETRY', 'PAYOUT_SENT'], {
        status: 'NEEDS_REVIEW', lastError: reason, updatedAt: nowSec,
      });
    } else {
      this._patchOwnedOrderSync('REFUND', orderId, inboundTxHash, ['REFUND_PENDING', 'REFUND_SENT'], {
        status: 'NEEDS_REVIEW', lastError: reason, updatedAt: nowSec,
      });
    }
    return true;
  }

  async completeA9(payoutId, orderId, txHash, credit, nowSec) {
    const p = this.payouts.get(payoutId);
    if (!p || p.kind !== 'A9' || !['PENDING', 'BROADCASTING', 'RETRY', 'SENT'].includes(p.status)) return false;
    Object.assign(p, { status: 'CONFIRMED', txHash: txHash || p.txHash, updatedAt: nowSec });
    const o = this.orders.get(orderId);
    const completed = this._patchOwnedOrderSync('A9', orderId, p.inboundTxHash, ['PAYOUT_PENDING', 'PAYOUT_RETRY', 'PAYOUT_SENT'], {
      status: 'COMPLETED', payoutTxHash: txHash || o?.payoutTxHash || null, updatedAt: nowSec,
    });
    if (completed && credit && !this.credits.has(credit.orderId)) this.credits.set(credit.orderId, { ...credit });
    return true;
  }

  async completeRefund(payoutId, orderId, inboundTxHash, txHash, nowSec) {
    const p = this.payouts.get(payoutId);
    if (!p || p.kind !== 'REFUND' || !['PENDING', 'BROADCASTING', 'RETRY', 'SENT'].includes(p.status)) return false;
    Object.assign(p, { status: 'CONFIRMED', txHash: txHash || p.txHash, updatedAt: nowSec });
    const o = orderId ? this.orders.get(orderId) : null;
    this._patchOwnedOrderSync('REFUND', orderId, inboundTxHash, ['REFUND_PENDING', 'REFUND_SENT'], {
      status: 'REFUNDED', payoutTxHash: txHash || o?.payoutTxHash || null, updatedAt: nowSec,
    });
    return true;
  }

  async listCredits(status) { return [...this.credits.values()].filter((c) => c.status === status).map(clone); }
  async getCredit(orderId) { return clone(this.credits.get(orderId)); }
  async claimCredit(orderId, from, to, nowSec) {
    const c = this.credits.get(orderId);
    if (!c || c.status !== from) return false;
    Object.assign(c, { status: to, updatedAt: nowSec });
    return true;
  }
  async patchCredit(orderId, patch) { const c = this.credits.get(orderId); if (c) Object.assign(c, patch); }

  async countOrdersByStatus(status) {
    let n = 0;
    for (const o of this.orders.values()) if (o.status === status) n += 1;
    return n;
  }

  async getScanCursor(walletAddress) {
    const key = addressKey(walletAddress);
    const c = this.cursors.get(key);
    return c ? { ...c } : null;
  }

  async saveScanCursor(walletAddress, { lt, hash }, nowSec) {
    if (!lt || !hash) return;
    this.cursors.set(addressKey(walletAddress), { lt: String(lt), hash: String(hash), updatedAt: Number(nowSec) });
  }

  /** Deep snapshot for tests (dry-run must leave it unchanged). */
  snapshot() {
    const ser = (m) => JSON.stringify([...m.entries()], (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    return [this.orders, this.inbound, this.payouts, this.credits, this.cursors].map(ser).join('|');
  }
}

/** Backwards-compatible in-memory engine used by server.mjs and tests. */
export class PresaleHotWalletEngine extends PresaleEngine {
  constructor(opts = {}) {
    super({ ...opts, repo: opts.repo || new MemoryPresaleRepo() });
  }
}
