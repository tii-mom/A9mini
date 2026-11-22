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
// Storage is behind a small repository interface: MemoryPresaleRepo here, D1PresaleRepo in
// d1-growth-store.mjs. Both are exercised by worker/tests.
import { addressKey } from './ton-address.mjs';
import { parseDecimalUnits, MoneyError } from './money.mjs';
import { randomHex } from './auth.mjs';

export const PRESALE_STATUS = Object.freeze({
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  PAYOUT_PENDING: 'PAYOUT_PENDING',
  PAYOUT_SENT: 'PAYOUT_SENT',
  COMPLETED: 'COMPLETED',
  PAYOUT_RETRY: 'PAYOUT_RETRY',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
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
export const PASSIVE_FREE_MIN_NANO = 1_000_000_000n; // 1.0 GRAM
export const USER_FAULT_FEE_NANO = 50_000_000n;     // 0.05 GRAM
export const REFERRAL_BPS = 12n;                     // 12% referral reward (percent)
export const ORDER_TTL_SEC = 30 * 60;               // unpaid order holds its reservation for 30 min
export const MAX_PAYOUT_ATTEMPTS = 5;
export const STALE_BROADCAST_SEC = 120;
export const UNCONFIRMED_REVIEW_SEC = 3600;
export const JETTON_TRANSFER_GAS_NANO = '50000000';

export class PresaleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
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
  return BigInt(`0x${randomHex(8)}`).toString();
}

export class PresaleEngine {
  constructor({
    repo,
    hotWalletAddress,
    rateA9PerTon = 2002n,
    minOrderTon = 5n,
    maxOrderTon = 200n,
    defaultQuotaTon = 200n,
    totalCapA9Raw = 200_000_000n * A9_RAW,
    open = true,
    promoEngine = null,
    socialStore = null,
    orderTtlSec = ORDER_TTL_SEC,
  } = {}) {
    if (!repo) throw new PresaleError('CONFIG_MISSING', 'presale repository required');
    if (!hotWalletAddress) throw new PresaleError('CONFIG_MISSING', 'presale hotWalletAddress required');
    this.repo = repo;
    this.hotWalletAddress = hotWalletAddress;
    this.rateA9PerTon = BigInt(rateA9PerTon);
    this.minOrderNano = toUnits(minOrderTon, 'minOrderTon');
    this.maxOrderNano = toUnits(maxOrderTon, 'maxOrderTon');
    this.defaultQuotaNano = toUnits(defaultQuotaTon, 'defaultQuotaTon');
    this.totalCapA9Raw = BigInt(totalCapA9Raw);
    this.open = Boolean(open);
    this.promoEngine = promoEngine;
    this.socialStore = socialStore;
    this.orderTtlSec = orderTtlSec;
    this.userQuotaNano = new Map(); // walletKey -> bigint (ops override, memory only)
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
    const avail = unlocked > userReservedNano ? unlocked - userReservedNano : 0n;
    const remPool = this.totalCapA9Raw > reservedA9Raw ? this.totalCapA9Raw - reservedA9Raw : 0n;
    return {
      walletAddress,
      rateA9PerTon: Number(this.rateA9PerTon),
      open: this.open,
      soldOut: remPool === 0n,
      remainingPoolA9Raw: remPool.toString(),
      unlockedQuotaNano: unlocked.toString(),
      usedQuotaNano: userReservedNano.toString(),
      availQuotaNano: avail.toString(),
      minOrderNano: this.minOrderNano.toString(),
      maxOrderNano: this.maxOrderNano.toString(),
      // Legacy integer fields kept for existing UI (whole GRAM, truncated).
      unlockedQuotaTon: Number(unlocked / TON_NANO),
      usedQuotaTon: Number(userReservedNano / TON_NANO),
      availQuotaTon: Number(avail / TON_NANO),
      minOrderTon: Number(this.minOrderNano / TON_NANO),
      maxOrderTon: Number(this.maxOrderNano / TON_NANO),
      payTo: this.hotWalletAddress,
    };
  }

  /** Create an order and atomically reserve pool + wallet quota. Amount is parsed exactly. */
  async createOrderIntent(walletAddress, tonAmount, nowSec = Math.floor(Date.now() / 1000), { referrerId = null, tgUserId = null } = {}) {
    if (!walletAddress) throw new PresaleError('BAD_WALLET', 'walletAddress required');
    if (!this.open) throw new PresaleError('PRESALE_CLOSED', 'presale is closed');
    let tonNano;
    try {
      tonNano = parseDecimalUnits(tonAmount, 9);
    } catch (e) {
      throw new PresaleError('BAD_AMOUNT', e.message);
    }
    if (tonNano < this.minOrderNano || tonNano > this.maxOrderNano) {
      throw new PresaleError('BAD_AMOUNT', 'order must be within min/max GRAM limits');
    }
    const walletKey = addressKey(walletAddress);
    const a9AmountRaw = this.quoteA9Raw(tonNano);
    const cleanRef = referrerId && addressKey(referrerId) !== walletKey && String(referrerId).trim() !== String(tgUserId || '')
      ? String(referrerId).trim()
      : null;
    const orderId = randomHex(6);
    const order = {
      orderId,
      walletAddress,
      walletKey,
      tgUserId: tgUserId ? String(tgUserId) : null,
      referrerId: cleanRef,
      tonNano,
      a9AmountRaw,
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
    const inserted = await this.repo.insertOrderIfCapacity(order, {
      capA9Raw: this.totalCapA9Raw,
      userQuotaNano: this._quotaFor(walletKey),
      nowSec,
    });
    if (!inserted) {
      const { reservedA9Raw, userReservedNano } = await this.repo.sumReserved(nowSec, walletKey);
      if (userReservedNano + tonNano > this._quotaFor(walletKey)) {
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

  _refundAmount(receivedNano, passive) {
    if (passive && receivedNano >= PASSIVE_FREE_MIN_NANO) return { refundNano: receivedNano, feeDeducted: false };
    return { refundNano: receivedNano > USER_FAULT_FEE_NANO ? receivedNano - USER_FAULT_FEE_NANO : 0n, feeDeducted: true };
  }

  /**
   * Pure decision for one inbound transfer. Reads only — safe for dry-run.
   * action: REJECT | REPLAY | IGNORE_DUST | REFUND | CONFIRM
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
    } catch {
      return { action: 'REJECT', reason: 'bad_value' };
    }
    if (receivedNano <= DUST_LIMIT_NANO) return { action: 'IGNORE_DUST', reason: 'dust', receivedNano };

    const memo = String(tx.memo || '').trim();
    const order = memo.startsWith('buy:') ? await this.repo.getOrderByMemo(memo) : null;
    const base = { txHash: tx.txHash, sender: tx.from, receivedNano, memo, orderId: order?.orderId || null };
    const refund = (reason, passive, touchesOrder) => ({
      ...base,
      action: 'REFUND',
      reason,
      touchesOrder,
      ...this._refundAmount(receivedNano, passive),
    });

    if (!order) return refund('no_matching_order', false, false);
    // The memo alone is not proof: payer must be the order's wallet and pay the exact amount.
    if (addressKey(tx.from) !== order.walletKey) return refund('sender_mismatch', false, false);
    if (normalizeOrderStatus(order.status, order.payoutTxHash) !== PRESALE_STATUS.PENDING_PAYMENT) {
      return refund('order_not_payable', false, false);
    }
    if (!this.open) return refund('closed', true, true);
    if (nowSec > Number(order.expiresAt || 0) && Number(order.expiresAt || 0) > 0) return refund('expired', true, true);
    if (receivedNano !== BigInt(order.tonNano)) return refund('amount_mismatch', false, true);
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
    if (d.action === 'CONFIRM') {
      orderUpdate = {
        orderId: d.orderId,
        from: [PRESALE_STATUS.PENDING_PAYMENT, PRESALE_STATUS.PENDING_TON],
        patch: { status: PRESALE_STATUS.PAYMENT_CONFIRMED, inboundTxHash: tx.txHash, updatedAt: nowSec },
      };
    } else if (d.action === 'REFUND') {
      if (d.touchesOrder && d.orderId) {
        orderUpdate = {
          orderId: d.orderId,
          from: [PRESALE_STATUS.PENDING_PAYMENT, PRESALE_STATUS.PENDING_TON],
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
    if (res === 'ORDER_RACE') return { ...d, applied: true, orderRace: true };
    return { ...d, applied: true };
  }

  /** PAYMENT_CONFIRMED -> PAYOUT_PENDING with a persisted payout instruction (idempotent). */
  async queueConfirmedPayouts(nowSec = Math.floor(Date.now() / 1000)) {
    let queued = 0;
    for (const o of await this.repo.listOrdersByStatus(PRESALE_STATUS.PAYMENT_CONFIRMED)) {
      const payout = {
        payoutId: `a9:${o.orderId}`,
        orderId: o.orderId,
        inboundTxHash: o.inboundTxHash,
        kind: 'A9',
        recipient: o.walletAddress,
        amount: BigInt(o.a9AmountRaw).toString(),
        queryId: newQueryId(),
        status: PAYOUT_STATUS.PENDING,
        attempts: 0,
        ambiguous: false,
        txHash: null,
        lastError: null,
        createdAt: nowSec,
        updatedAt: nowSec,
      };
      if (await this.repo.queuePayout(o.orderId, PRESALE_STATUS.PAYMENT_CONFIRMED, { status: PRESALE_STATUS.PAYOUT_PENDING, updatedAt: nowSec }, payout)) {
        queued += 1;
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
    return { payoutId: p.payoutId, orderId: p.orderId, queryId: p.queryId, recipient: p.recipient, tonNano: p.amount };
  }

  async _orderPatchForPayout(p, patch, expect = null) {
    if (!p.orderId) return;
    await this.repo.patchOrder(p.orderId, patch, expect);
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
      return;
    }
    await this.repo.patchPayout(p.payoutId, { status: PAYOUT_STATUS.CONFIRMED, txHash: txHash || p.txHash, updatedAt: nowSec });
    await this._orderPatchForPayout(p, { status: PRESALE_STATUS.REFUNDED, updatedAt: nowSec });
  }

  async _needsReview(p, reason, nowSec) {
    await this.repo.patchPayout(p.payoutId, { status: PAYOUT_STATUS.NEEDS_REVIEW, lastError: reason, updatedAt: nowSec });
    await this._orderPatchForPayout(p, { status: PRESALE_STATUS.NEEDS_REVIEW, lastError: reason, updatedAt: nowSec });
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
            await this._markConfirmed(p, v.txHash, nowSec);
            s.confirmed += 1;
            continue;
          }
          if (v?.state === 'PENDING') {
            await this.repo.patchPayout(p.payoutId, { status: PAYOUT_STATUS.SENT, txHash: v.txHash || p.txHash, ambiguous: false, updatedAt: nowSec });
            await this._orderPatchForPayout(p, { status: p.kind === 'A9' ? PRESALE_STATUS.PAYOUT_SENT : PRESALE_STATUS.REFUND_SENT, updatedAt: nowSec });
            s.waiting += 1;
            continue;
          }
          // NOT_FOUND / FAILED -> safe to retry as a fresh attempt.
          await this.repo.patchPayout(p.payoutId, { status: PAYOUT_STATUS.RETRY, ambiguous: false, updatedAt: nowSec });
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
          const claimed = await this.repo.claimPayout(p.payoutId, [PAYOUT_STATUS.PENDING, PAYOUT_STATUS.RETRY], {
            status: PAYOUT_STATUS.BROADCASTING,
            attempts: Number(p.attempts || 0) + 1,
            updatedAt: nowSec,
          });
          if (!claimed) continue;
          try {
            const sent = await broadcaster(this.buildInstruction(p));
            if (!sent?.txHash) throw Object.assign(new Error('broadcaster returned no txHash'), { notSent: false });
            await this.repo.patchPayout(p.payoutId, { status: PAYOUT_STATUS.SENT, txHash: sent.txHash, ambiguous: false, lastError: null, updatedAt: nowSec });
            await this._orderPatchForPayout(p, p.kind === 'A9'
              ? { status: PRESALE_STATUS.PAYOUT_SENT, payoutTxHash: sent.txHash, lastError: null, updatedAt: nowSec }
              : { status: PRESALE_STATUS.REFUND_SENT, payoutTxHash: sent.txHash, lastError: null, updatedAt: nowSec });
            p.status = PAYOUT_STATUS.SENT;
            p.txHash = sent.txHash;
            p.updatedAt = nowSec;
            s.broadcast += 1;
          } catch (e) {
            const msg = String(e?.message || e).slice(0, 300);
            await this.repo.patchPayout(p.payoutId, { status: PAYOUT_STATUS.RETRY, ambiguous: e?.notSent !== true, lastError: msg, updatedAt: nowSec });
            await this._orderPatchForPayout(p, { status: p.kind === 'A9' ? PRESALE_STATUS.PAYOUT_RETRY : PRESALE_STATUS.REFUND_PENDING, lastError: msg, updatedAt: nowSec });
            s.retry += 1;
            logger?.log?.(`[presale] payout ${p.payoutId} broadcast failed: ${msg}`);
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
            await this.repo.patchPayout(p.payoutId, { status: PAYOUT_STATUS.RETRY, ambiguous: false, lastError: 'on-chain transfer failed', updatedAt: nowSec });
            await this._orderPatchForPayout(p, { status: p.kind === 'A9' ? PRESALE_STATUS.PAYOUT_RETRY : PRESALE_STATUS.REFUND_PENDING, updatedAt: nowSec });
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

  /** Book referral rewards for COMPLETED orders exactly once (CREDITING is never auto-retried). */
  async processReferralCredits(nowSec = Math.floor(Date.now() / 1000), { promoEngine = this.promoEngine } = {}) {
    const s = { credited: 0, review: 0 };
    for (const c of await this.repo.listCredits('CREDITING')) {
      await this.repo.patchCredit(c.orderId, { status: 'NEEDS_REVIEW', updatedAt: nowSec });
      s.review += 1;
    }
    if (!promoEngine || typeof promoEngine.creditReward !== 'function') return s;
    for (const c of await this.repo.listCredits('PENDING')) {
      if (!(await this.repo.claimCredit(c.orderId, 'PENDING', 'CREDITING', nowSec))) continue;
      await promoEngine.creditReward(c.referrer, BigInt(c.amountRaw), nowSec);
      await this.repo.patchCredit(c.orderId, { status: 'CREDITED', updatedAt: nowSec });
      s.credited += 1;
    }
    return s;
  }

  async getReferralCredit(orderId) {
    return this.repo.getCredit(orderId);
  }

  formatOrder(o) {
    const status = normalizeOrderStatus(o.status, o.payoutTxHash);
    return {
      orderId: o.orderId,
      walletAddress: o.walletAddress,
      referrerId: o.referrerId || null,
      tonNano: BigInt(o.tonNano).toString(),
      a9AmountRaw: BigInt(o.a9AmountRaw).toString(),
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
    this.memoIndex = new Map();
    this.inbound = new Map();
    this.payouts = new Map();
    this.credits = new Map();
  }

  _reserves(o, nowSec) {
    return RESERVING_STATUSES.includes(o.status) || (o.status === 'PENDING_PAYMENT' && Number(o.expiresAt) > nowSec);
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

  async insertOrderIfCapacity(order, { capA9Raw, userQuotaNano, nowSec }) {
    // Check + insert with no await in between, so concurrent callers cannot both pass the check.
    const { reservedA9Raw, userReservedNano } = this._sumReservedSync(nowSec, order.walletKey);
    if (reservedA9Raw + BigInt(order.a9AmountRaw) > capA9Raw) return false;
    if (userReservedNano + BigInt(order.tonNano) > userQuotaNano) return false;
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

  async commitInbound({ inbound, orderUpdate, payout }) {
    if (this.inbound.has(inbound.txHash)) return 'REPLAY';
    if (payout && this.payouts.has(payout.payoutId)) return 'REPLAY';
    let race = false;
    if (orderUpdate) {
      const o = this.orders.get(orderUpdate.orderId);
      if (o && orderUpdate.from.includes(o.status)) Object.assign(o, orderUpdate.patch);
      else race = true;
    }
    this.inbound.set(inbound.txHash, { ...inbound, decision: race ? 'NEEDS_REVIEW' : inbound.decision });
    if (payout) this.payouts.set(payout.payoutId, { ...payout });
    return race ? 'ORDER_RACE' : 'OK';
  }

  async queuePayout(orderId, fromStatus, patch, payout) {
    const o = this.orders.get(orderId);
    if (!o || o.status !== fromStatus || this.payouts.has(payout.payoutId)) return false;
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

  async completeA9(payoutId, orderId, txHash, credit, nowSec) {
    const p = this.payouts.get(payoutId);
    if (p) Object.assign(p, { status: 'CONFIRMED', txHash: txHash || p.txHash, updatedAt: nowSec });
    const o = this.orders.get(orderId);
    if (o) Object.assign(o, { status: 'COMPLETED', payoutTxHash: txHash || o.payoutTxHash, updatedAt: nowSec });
    if (credit && !this.credits.has(credit.orderId)) this.credits.set(credit.orderId, { ...credit });
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

  /** Deep snapshot for tests (dry-run must leave it unchanged). */
  snapshot() {
    const ser = (m) => JSON.stringify([...m.entries()], (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    return [this.orders, this.inbound, this.payouts, this.credits].map(ser).join('|');
  }
}

/** Backwards-compatible in-memory engine used by server.mjs and tests. */
export class PresaleHotWalletEngine extends PresaleEngine {
  constructor(opts = {}) {
    super({ ...opts, repo: opts.repo || new MemoryPresaleRepo() });
  }
}
