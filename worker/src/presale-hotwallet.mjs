// A9 Protocol v15 — Zero-contract Presale (Internal Market) hot-wallet engine.
// Rules aligned with A9 spec:
//   * User sends TON (5..200 TON, within personal unlocked quota) with memo "buy:<orderId>"
//   * Finalized inbound TON verified -> hot wallet sends A9 at configured rate (sendExcessesTo = hotWallet)
//   * On PAID_A9 fill, if buyer has a bound referrer -> auto-credit 12% A9 referral reward to promoEngine
//   * Passive refund (sold_out / closed / not_started) & >= 1 TON -> full refund (0 fee)
//   * User-fault refund (over quota / bad amount) -> deduct 0.05 TON processing fee
//   * Dust (<= 0.1 TON) -> ignored (non-refundable)

import { randomBytes } from 'node:crypto';

export const PRESALE_STATUS = Object.freeze({
  PENDING_TON: 'PENDING_TON',
  PAID_A9: 'PAID_A9',
  REFUNDED_FREE: 'REFUNDED_FREE',
  REFUNDED_MINUS_FEE: 'REFUNDED_MINUS_FEE',
  DUST_IGNORED: 'DUST_IGNORED',
});

export const TON_NANO = 1_000_000_000n;
export const A9_RAW = 1_000_000_000n;
export const DUST_LIMIT_NANO = 100_000_000n;        // 0.1 TON
export const PASSIVE_FREE_MIN_NANO = 1_000_000_000n; // 1.0 TON
export const USER_FAULT_FEE_NANO = 50_000_000n;     // 0.05 TON
export const REFERRAL_BPS = 12n;                     // 12% referral reward

export class PresaleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class PresaleHotWalletEngine {
  constructor({
    hotWalletAddress,
    rateA9PerTon = 2002n,
    minOrderTon = 5n,
    maxOrderTon = 200n,
    defaultQuotaTon = 200n,
    totalCapA9Raw = 200_000_000n * A9_RAW,
    open = true,
    promoEngine = null,
    socialStore = null,
  } = {}) {
    if (!hotWalletAddress) throw new PresaleError('CONFIG_MISSING', 'presale hotWalletAddress required');
    this.hotWalletAddress = hotWalletAddress;
    this.rateA9PerTon = BigInt(rateA9PerTon);
    this.minOrderNano = BigInt(minOrderTon) * TON_NANO;
    this.maxOrderNano = BigInt(maxOrderTon) * TON_NANO;
    this.defaultQuotaNano = BigInt(defaultQuotaTon) * TON_NANO;
    this.totalCapA9Raw = BigInt(totalCapA9Raw);
    this.soldA9Raw = 0n;
    this.open = Boolean(open);
    this.promoEngine = promoEngine;
    this.socialStore = socialStore;

    this.orders = new Map();        // orderId -> order
    this.memoIndex = new Map();     // memo -> orderId
    this.usedTxHashes = new Set();  // anti-replay
    this.userUsedNano = new Map();  // wallet -> bigint
    this.userQuotaNano = new Map(); // wallet -> bigint (override)
  }

  setUserQuotaTon(walletAddress, quotaTon) {
    this.userQuotaNano.set(walletAddress, BigInt(quotaTon) * TON_NANO);
  }

  getQuota(walletAddress) {
    const unlockedNano = this.userQuotaNano.get(walletAddress) ?? this.defaultQuotaNano;
    const usedNano = this.userUsedNano.get(walletAddress) ?? 0n;
    const availNano = unlockedNano > usedNano ? unlockedNano - usedNano : 0n;
    return {
      walletAddress,
      rateA9PerTon: Number(this.rateA9PerTon),
      open: this.open,
      soldOut: this.soldA9Raw >= this.totalCapA9Raw,
      remainingPoolA9Raw: (this.totalCapA9Raw - this.soldA9Raw).toString(),
      unlockedQuotaTon: Number(unlockedNano / TON_NANO),
      usedQuotaTon: Number(usedNano / TON_NANO),
      availQuotaTon: Number(availNano / TON_NANO),
      minOrderTon: Number(this.minOrderNano / TON_NANO),
      maxOrderTon: Number(this.maxOrderNano / TON_NANO),
      payTo: this.hotWalletAddress,
    };
  }

  createOrderIntent(walletAddress, tonAmount, nowSec = Math.floor(Date.now() / 1000), { referrerId = null } = {}) {
    if (!walletAddress) throw new PresaleError('BAD_WALLET', 'walletAddress required');
    if (!this.open) throw new PresaleError('PRESALE_CLOSED', 'presale is closed');
    if (this.soldA9Raw >= this.totalCapA9Raw) throw new PresaleError('SOLD_OUT', 'presale sold out');

    const tonNano = BigInt(Math.round(Number(tonAmount) * 1e9));
    if (tonNano < this.minOrderNano || tonNano > this.maxOrderNano) {
      throw new PresaleError('BAD_AMOUNT', 'order must be within min/max TON limits');
    }
    const unlocked = this.userQuotaNano.get(walletAddress) ?? this.defaultQuotaNano;
    const used = this.userUsedNano.get(walletAddress) ?? 0n;
    if (used + tonNano > unlocked) {
      throw new PresaleError('OVER_QUOTA', 'exceeds personal unlocked quota');
    }

    const a9AmountRaw = (tonNano * this.rateA9PerTon * A9_RAW) / TON_NANO;
    if (this.soldA9Raw + a9AmountRaw > this.totalCapA9Raw) {
      throw new PresaleError('EXCEEDS_POOL', 'exceeds remaining presale supply');
    }

    const cleanRef = referrerId && String(referrerId).trim() !== walletAddress
      ? String(referrerId).trim()
      : null;

    const orderId = randomBytes(6).toString('hex');
    const memo = `buy:${orderId}`;
    const order = {
      orderId,
      walletAddress,
      referrerId: cleanRef,
      tonNano,
      a9AmountRaw,
      memo,
      status: PRESALE_STATUS.PENDING_TON,
      inboundTxHash: null,
      payoutTxHash: null,
      refundTonNano: 0n,
      createdAt: nowSec,
      updatedAt: nowSec,
    };
    this.orders.set(orderId, order);
    this.memoIndex.set(memo, orderId);
    return this.formatOrder(order);
  }

  /**
   * Process a finalized inbound TON transfer to the presale hot wallet.
   * Returns { action: 'SEND_A9' | 'REFUND_TON' | 'IGNORE_DUST', order, instruction, referralCredited }.
   */
  processInboundTonTx(tx, nowSec = Math.floor(Date.now() / 1000), { promoEngine = this.promoEngine, socialStore = this.socialStore } = {}) {
    if (!tx?.txHash) throw new PresaleError('BAD_TX', 'missing txHash');
    if (tx.finality !== 'finalized') throw new PresaleError('NOT_FINALIZED', 'tx must be finalized');
    if (this.usedTxHashes.has(tx.txHash)) throw new PresaleError('REPLAY_TX', 'tx already processed');
    if (tx.to !== this.hotWalletAddress) throw new PresaleError('WRONG_DEST', 'not presale hot wallet');

    const receivedNano = BigInt(tx.valueNano || 0);
    const sender = tx.from;
    this.usedTxHashes.add(tx.txHash);

    // Dust <= 0.1 TON is non-refundable
    if (receivedNano <= DUST_LIMIT_NANO) {
      return { action: 'IGNORE_DUST', order: null, instruction: null, referralCredited: null };
    }

    const memo = String(tx.memo || '').trim();
    const orderId = this.memoIndex.get(memo);
    const order = orderId ? this.orders.get(orderId) : null;
    const a9AmountRaw = (receivedNano * this.rateA9PerTon * A9_RAW) / TON_NANO;

    // Passive refund: closed or sold out (>= 1 TON free full refund)
    if (!this.open || this.soldA9Raw + a9AmountRaw > this.totalCapA9Raw) {
      const refundNano = receivedNano >= PASSIVE_FREE_MIN_NANO
        ? receivedNano
        : (receivedNano > USER_FAULT_FEE_NANO ? receivedNano - USER_FAULT_FEE_NANO : 0n);
      if (order) {
        order.status = PRESALE_STATUS.REFUNDED_FREE;
        order.inboundTxHash = tx.txHash;
        order.refundTonNano = refundNano;
        order.updatedAt = nowSec;
      }
      return {
        action: 'REFUND_TON',
        reason: !this.open ? 'closed' : 'sold_out',
        order: order ? this.formatOrder(order) : null,
        instruction: { recipient: sender, tonNano: refundNano.toString(), feeDeducted: receivedNano < PASSIVE_FREE_MIN_NANO },
        referralCredited: null,
      };
    }

    // User-fault check: bad amount or over personal quota -> refund minus 0.05 TON
    const unlocked = this.userQuotaNano.get(sender) ?? this.defaultQuotaNano;
    const used = this.userUsedNano.get(sender) ?? 0n;
    const invalidOrder = receivedNano < this.minOrderNano || receivedNano > this.maxOrderNano || (used + receivedNano > unlocked);
    if (invalidOrder) {
      const refundNano = receivedNano > USER_FAULT_FEE_NANO ? receivedNano - USER_FAULT_FEE_NANO : 0n;
      if (order) {
        order.status = PRESALE_STATUS.REFUNDED_MINUS_FEE;
        order.inboundTxHash = tx.txHash;
        order.refundTonNano = refundNano;
        order.updatedAt = nowSec;
      }
      return {
        action: 'REFUND_TON',
        reason: 'user_fault',
        order: order ? this.formatOrder(order) : null,
        instruction: { recipient: sender, tonNano: refundNano.toString(), feeDeducted: true },
        referralCredited: null,
      };
    }

    // Valid fill -> allocate quota & issue TEP-74 A9 payout
    this.soldA9Raw += a9AmountRaw;
    this.userUsedNano.set(sender, used + receivedNano);

    const record = order || {
      orderId: randomBytes(6).toString('hex'),
      walletAddress: sender,
      referrerId: null,
      tonNano: receivedNano,
      a9AmountRaw,
      memo: memo || 'direct',
      createdAt: nowSec,
    };
    record.tonNano = receivedNano;
    record.a9AmountRaw = a9AmountRaw;
    record.status = PRESALE_STATUS.PAID_A9;
    record.inboundTxHash = tx.txHash;
    record.updatedAt = nowSec;
    this.orders.set(record.orderId, record);

    // Auto-credit 12% referral commission to bound referrer's promo balance
    const boundRef = (socialStore ? socialStore.getReferrer(sender) : null) || record.referrerId || null;
    let referralCredited = null;
    if (boundRef && boundRef !== sender) {
      const referralRewardRaw = (a9AmountRaw * REFERRAL_BPS) / 100n;
      if (referralRewardRaw > 0n) {
        if (promoEngine && typeof promoEngine.creditReward === 'function') {
          promoEngine.creditReward(boundRef, referralRewardRaw);
        }
        referralCredited = { referrerWallet: boundRef, amountRaw: referralRewardRaw.toString() };
      }
    }

    return {
      action: 'SEND_A9',
      order: this.formatOrder(record),
      instruction: {
        op: '0x0f8a7ea5',
        fromHotWallet: this.hotWalletAddress,
        recipient: sender,
        jettonAmountRaw: a9AmountRaw.toString(),
        attachedTonNano: '50000000',
        sendExcessesTo: this.hotWalletAddress,
      },
      referralCredited,
    };
  }

  listOrders(walletAddress) {
    return Array.from(this.orders.values())
      .filter((o) => o.walletAddress === walletAddress)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((o) => this.formatOrder(o));
  }

  formatOrder(o) {
    return {
      orderId: o.orderId,
      walletAddress: o.walletAddress,
      referrerId: o.referrerId || null,
      tonNano: o.tonNano.toString(),
      a9AmountRaw: o.a9AmountRaw.toString(),
      payTo: this.hotWalletAddress,
      memo: o.memo,
      status: o.status,
      inboundTxHash: o.inboundTxHash || null,
      payoutTxHash: o.payoutTxHash || null,
      refundTonNano: (o.refundTonNano || 0n).toString(),
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    };
  }
}
