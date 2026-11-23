// A9 Protocol v15 — Zero-contract promotion reward hot-wallet engine.
// Flow:
//   1) User requests claim -> creates unique memo "claim:<id>" + 0.06 TON fee invoice
//   2) User sends 0.06 TON with memo to promo hot wallet
//   3) Listener verifies finalized inbound tx (amount >= 0.06 TON, exact memo, anti-replay)
//   4) Hot wallet sends standard TEP-74 A9 transfer with sendExcessesTo = hotWalletAddress
//      -> net hot-wallet gas cost <= 0 (self-funded by user's 0.06 TON).

import { randomBytes } from 'node:crypto';
import { addressKey } from './ton-address.mjs';

export const DEFAULT_USER_FEE_NANO = 60_000_000n;     // 0.06 GRAM
export const DEFAULT_TRANSFER_GAS_NANO = 50_000_000n; // 0.05 GRAM attached to TEP-74 transfer
export const DEFAULT_CLAIM_TTL_SEC = 900;             // 15 min invoice validity

export const CLAIM_STATUS = Object.freeze({
  PENDING_FEE: 'PENDING_FEE',
  FEE_CONFIRMED: 'FEE_CONFIRMED',
  PAYOUT_SENT: 'PAYOUT_SENT',
  COMPLETED: 'COMPLETED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
});

export class PromoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function deriveClaimQueryId(claimId, attempt = 1) {
  const seed = Number(attempt) > 1 ? `${String(claimId || '')}:try:${Number(attempt)}` : String(claimId || '');
  let h = 14695981039346656037n;
  for (const ch of seed) {
    h ^= BigInt(ch.charCodeAt(0));
    h = (h * 1099511628211n) & 0xFFFFFFFFFFFFFFFFn;
  }
  return (h === 0n ? 1n : h).toString();
}

export class PromoHotWalletEngine {
  constructor({
    hotWalletAddress,
    userFeeNano = DEFAULT_USER_FEE_NANO,
    transferGasNano = DEFAULT_TRANSFER_GAS_NANO,
    claimTtlSec = DEFAULT_CLAIM_TTL_SEC,
  } = {}) {
    if (!hotWalletAddress) throw new PromoError('CONFIG_MISSING', 'hotWalletAddress is required');
    this.hotWalletAddress = hotWalletAddress;
    this.userFeeNano = BigInt(userFeeNano);
    this.transferGasNano = BigInt(transferGasNano);
    this.claimTtlSec = Number(claimTtlSec);

    // In-memory store keyed by canonical addressKey(walletAddress)
    this.balances = new Map();       // walletKey -> { claimableRaw: bigint, totalClaimedRaw: bigint }
    this.claims = new Map();         // claimId -> claim record
    this.memoIndex = new Map();      // memo -> claimId
    this.usedFeeTxHashes = new Set(); // strict anti-replay for inbound GRAM fee txs
  }

  creditReward(walletAddress, addRaw) {
    const delta = BigInt(addRaw);
    if (delta <= 0n) throw new PromoError('BAD_AMOUNT', 'credit amount must be positive');
    const key = addressKey(walletAddress);
    const cur = this.balances.get(key) || { claimableRaw: 0n, totalClaimedRaw: 0n };
    cur.claimableRaw += delta;
    this.balances.set(key, cur);
    return { walletAddress, claimableRaw: cur.claimableRaw.toString() };
  }

  getBalance(walletAddress) {
    const cur = this.balances.get(addressKey(walletAddress)) || { claimableRaw: 0n, totalClaimedRaw: 0n };
    return {
      walletAddress,
      claimableRaw: cur.claimableRaw.toString(),
      totalClaimedRaw: cur.totalClaimedRaw.toString(),
    };
  }

  createClaimIntent(walletAddress, nowSec = Math.floor(Date.now() / 1000)) {
    const key = addressKey(walletAddress);
    const bal = this.balances.get(key);
    if (!bal || bal.claimableRaw <= 0n) {
      throw new PromoError('NOTHING_TO_CLAIM', 'no claimable promotion reward');
    }
    // Reuse an existing non-expired PENDING_FEE claim for this wallet to prevent duplicate invoices
    for (const c of this.claims.values()) {
      if (addressKey(c.walletAddress) === key && c.status === CLAIM_STATUS.PENDING_FEE) {
        if (nowSec < c.expiresAt) return this.formatClaim(c);
        c.status = CLAIM_STATUS.EXPIRED;
        c.updatedAt = nowSec;
      }
    }

    const claimId = randomBytes(6).toString('hex');
    const memo = `claim:${claimId}`;
    const record = {
      claimId,
      walletAddress,
      amountRaw: bal.claimableRaw,
      feeRequiredNano: this.userFeeNano,
      memo,
      status: CLAIM_STATUS.PENDING_FEE,
      feeTxHash: null,
      payoutTxHash: null,
      createdAt: nowSec,
      expiresAt: nowSec + this.claimTtlSec,
      updatedAt: nowSec,
    };
    this.claims.set(claimId, record);
    this.memoIndex.set(memo, claimId);
    return this.formatClaim(record);
  }

  /**
   * Read-only dry-run verification: validates a finalized 0.06 GRAM fee inbound tx and builds
   * a payoutInstruction WITHOUT modifying balances, claims, or usedFeeTxHashes.
   */
  planInboundFeeTx(tx, nowSec = Math.floor(Date.now() / 1000)) {
    if (!tx || !tx.txHash) throw new PromoError('BAD_TX', 'missing txHash');
    if (tx.finality !== 'finalized') throw new PromoError('NOT_FINALIZED', 'fee tx must be finalized');
    if (this.usedFeeTxHashes.has(tx.txHash)) throw new PromoError('REPLAY_TX', 'fee tx already processed');
    if (addressKey(tx.to) !== addressKey(this.hotWalletAddress)) throw new PromoError('WRONG_DEST', 'destination is not promo hot wallet');

    const memo = String(tx.memo || '').trim();
    const claimId = this.memoIndex.get(memo);
    if (!claimId) throw new PromoError('UNKNOWN_MEMO', `no claim matches memo: ${memo}`);

    const claim = this.claims.get(claimId);
    if (claim.status !== CLAIM_STATUS.PENDING_FEE) {
      throw new PromoError('INVALID_STATE', `claim ${claimId} is ${claim.status}`);
    }
    const paidAt = Number(tx.utime) > 0 ? Number(tx.utime) : nowSec;
    if (paidAt > claim.expiresAt) {
      throw new PromoError('CLAIM_EXPIRED', `claim ${claimId} expired`);
    }
    const receivedNano = BigInt(tx.valueNano || 0);
    if (receivedNano < claim.feeRequiredNano) {
      throw new PromoError('INSUFFICIENT_FEE', `received ${receivedNano} < required ${claim.feeRequiredNano}`);
    }
    const bal = this.balances.get(addressKey(claim.walletAddress));
    if (!bal || bal.claimableRaw < claim.amountRaw) {
      throw new PromoError('INSUFFICIENT_BALANCE', 'claimable balance changed');
    }
    return {
      claim: this.formatClaim(claim),
      payoutInstruction: {
        op: '0x0f8a7ea5',
        queryId: deriveClaimQueryId(claim.claimId),
        fromHotWallet: this.hotWalletAddress,
        recipient: claim.walletAddress,
        jettonAmountRaw: claim.amountRaw.toString(),
        attachedTonNano: this.transferGasNano.toString(),
        sendExcessesTo: this.hotWalletAddress,
        forwardTonNano: '0',
      },
    };
  }

  /**
   * Process a finalized inbound GRAM transfer to the promo hot wallet.
   * Returns a ready-to-broadcast TEP-74 payout instruction when valid.
   */
  verifyInboundFeeTx(tx, nowSec = Math.floor(Date.now() / 1000)) {
    if (!tx || !tx.txHash) throw new PromoError('BAD_TX', 'missing txHash');
    if (tx.finality !== 'finalized') throw new PromoError('NOT_FINALIZED', 'fee tx must be finalized');
    if (this.usedFeeTxHashes.has(tx.txHash)) throw new PromoError('REPLAY_TX', 'fee tx already processed');
    if (addressKey(tx.to) !== addressKey(this.hotWalletAddress)) throw new PromoError('WRONG_DEST', 'destination is not promo hot wallet');

    const memo = String(tx.memo || '').trim();
    const claimId = this.memoIndex.get(memo);
    if (!claimId) throw new PromoError('UNKNOWN_MEMO', `no claim matches memo: ${memo}`);

    const claim = this.claims.get(claimId);
    if (claim.status !== CLAIM_STATUS.PENDING_FEE) {
      throw new PromoError('INVALID_STATE', `claim ${claimId} is ${claim.status}`);
    }
    const paidAt = Number(tx.utime) > 0 ? Number(tx.utime) : nowSec;
    if (paidAt > claim.expiresAt) {
      claim.status = CLAIM_STATUS.EXPIRED;
      claim.updatedAt = nowSec;
      throw new PromoError('CLAIM_EXPIRED', `claim ${claimId} expired`);
    }
    const receivedNano = BigInt(tx.valueNano || 0);
    if (receivedNano < claim.feeRequiredNano) {
      throw new PromoError('INSUFFICIENT_FEE', `received ${receivedNano} < required ${claim.feeRequiredNano}`);
    }

    // Lock balance atomically before dispatching A9 transfer
    const bal = this.balances.get(addressKey(claim.walletAddress));
    if (!bal || bal.claimableRaw < claim.amountRaw) {
      claim.status = CLAIM_STATUS.FAILED;
      claim.updatedAt = nowSec;
      throw new PromoError('INSUFFICIENT_BALANCE', 'claimable balance changed');
    }
    bal.claimableRaw -= claim.amountRaw;
    bal.totalClaimedRaw += claim.amountRaw;

    this.usedFeeTxHashes.add(tx.txHash);
    claim.feeTxHash = tx.txHash;
    claim.status = CLAIM_STATUS.FEE_CONFIRMED;
    claim.updatedAt = nowSec;

    return {
      claim: this.formatClaim(claim),
      payoutInstruction: {
        op: '0x0f8a7ea5', // Standard TEP-74 AskToTransfer
        queryId: deriveClaimQueryId(claim.claimId),
        fromHotWallet: this.hotWalletAddress,
        recipient: claim.walletAddress,
        jettonAmountRaw: claim.amountRaw.toString(),
        attachedTonNano: this.transferGasNano.toString(),
        // CRITICAL: excesses return to the hot wallet so net project gas cost <= 0
        sendExcessesTo: this.hotWalletAddress,
        forwardTonNano: '0',
      },
    };
  }

  markPayoutCompleted(claimId, payoutTxHash, nowSec = Math.floor(Date.now() / 1000)) {
    const claim = this.claims.get(claimId);
    if (!claim) throw new PromoError('NOT_FOUND', `claim ${claimId} not found`);
    if (claim.status !== CLAIM_STATUS.FEE_CONFIRMED && claim.status !== CLAIM_STATUS.PAYOUT_SENT) {
      throw new PromoError('INVALID_STATE', `cannot complete claim in state ${claim.status}`);
    }
    claim.payoutTxHash = payoutTxHash;
    claim.status = CLAIM_STATUS.COMPLETED;
    claim.updatedAt = nowSec;
    return this.formatClaim(claim);
  }

  getClaim(claimId) {
    const c = this.claims.get(claimId);
    return c ? this.formatClaim(c) : null;
  }

  formatClaim(c) {
    return {
      claimId: c.claimId,
      walletAddress: c.walletAddress,
      amountRaw: c.amountRaw.toString(),
      feeRequiredNano: c.feeRequiredNano.toString(),
      payTo: this.hotWalletAddress,
      memo: c.memo,
      status: c.status,
      feeTxHash: c.feeTxHash,
      payoutTxHash: c.payoutTxHash,
      createdAt: c.createdAt,
      expiresAt: c.expiresAt,
      updatedAt: c.updatedAt,
    };
  }
}
