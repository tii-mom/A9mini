// A9 Protocol v15 — Cloudflare D1 persistence adapter for 0-contract promo hot-wallet claims.
// Matches worker/schema.sql (promo_balances, promo_claims).
import { randomBytes } from 'node:crypto';
import {
  CLAIM_STATUS,
  DEFAULT_USER_FEE_NANO,
  DEFAULT_CLAIM_TTL_SEC,
  PromoError,
} from './promo-hotwallet.mjs';

export class D1PromoStore {
  constructor({
    db,
    hotWalletAddress,
    userFeeNano = DEFAULT_USER_FEE_NANO,
    claimTtlSec = DEFAULT_CLAIM_TTL_SEC,
  }) {
    if (!db) throw new PromoError('DB_MISSING', 'Cloudflare D1 binding (env.DB) is required');
    if (!hotWalletAddress) throw new PromoError('CONFIG_MISSING', 'hotWalletAddress is required');
    this.db = db;
    this.hotWalletAddress = hotWalletAddress;
    this.userFeeNano = BigInt(userFeeNano);
    this.claimTtlSec = Number(claimTtlSec);
  }

  async getBalance(walletAddress) {
    const row = await this.db
      .prepare('SELECT claimable_raw, total_claimed_raw FROM promo_balances WHERE wallet_address = ?')
      .bind(walletAddress)
      .first();
    return {
      walletAddress,
      claimableRaw: row ? String(row.claimable_raw) : '0',
      totalClaimedRaw: row ? String(row.total_claimed_raw) : '0',
    };
  }

  /**
   * Credit promotion / referral / activated-prediction A9 rewards to D1 promo_balances.
   * Uses JS BigInt addition (stored as TEXT) to preserve full precision beyond 2^53.
   */
  async creditReward(walletAddress, amountRaw, nowSec = Math.floor(Date.now() / 1000)) {
    const wallet = String(walletAddress || '').trim();
    const add = BigInt(amountRaw);
    if (!wallet) throw new PromoError('BAD_WALLET', 'walletAddress is required');
    if (add <= 0n) throw new PromoError('BAD_AMOUNT', 'credit amount must be positive');

    const cur = await this.getBalance(wallet);
    const nextClaimable = BigInt(cur.claimableRaw) + add;

    await this.db
      .prepare(
        `INSERT INTO promo_balances (wallet_address, claimable_raw, total_claimed_raw, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(wallet_address) DO UPDATE SET
           claimable_raw = excluded.claimable_raw,
           updated_at = excluded.updated_at`,
      )
      .bind(wallet, nextClaimable.toString(), cur.totalClaimedRaw, nowSec)
      .run();

    return {
      walletAddress: wallet,
      claimableRaw: nextClaimable.toString(),
      totalClaimedRaw: cur.totalClaimedRaw,
    };
  }

  async getClaim(claimId) {
    const row = await this.db
      .prepare('SELECT * FROM promo_claims WHERE claim_id = ?')
      .bind(claimId)
      .first();
    return row ? this._formatRow(row) : null;
  }

  async createClaimIntent(walletAddress, nowSec = Math.floor(Date.now() / 1000)) {
    const bal = await this.getBalance(walletAddress);
    if (BigInt(bal.claimableRaw) <= 0n) {
      throw new PromoError('NOTHING_TO_CLAIM', 'no claimable promotion reward');
    }

    const existing = await this.db
      .prepare('SELECT * FROM promo_claims WHERE wallet_address = ? AND status = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1')
      .bind(walletAddress, CLAIM_STATUS.PENDING_FEE, nowSec)
      .first();
    if (existing) return this._formatRow(existing);

    const claimId = randomBytes(6).toString('hex');
    const memo = `claim:${claimId}`;
    const expiresAt = nowSec + this.claimTtlSec;
    await this.db
      .prepare(
        `INSERT INTO promo_claims
         (claim_id, wallet_address, amount_raw, fee_required_nano, memo, status, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        claimId,
        walletAddress,
        bal.claimableRaw,
        this.userFeeNano.toString(),
        memo,
        CLAIM_STATUS.PENDING_FEE,
        nowSec,
        expiresAt,
        nowSec,
      )
      .run();

    return {
      claimId,
      walletAddress,
      amountRaw: bal.claimableRaw,
      feeRequiredNano: this.userFeeNano.toString(),
      payTo: this.hotWalletAddress,
      memo,
      status: CLAIM_STATUS.PENDING_FEE,
      feeTxHash: null,
      payoutTxHash: null,
      createdAt: nowSec,
      expiresAt,
      updatedAt: nowSec,
    };
  }

  _formatRow(r) {
    return {
      claimId: r.claim_id,
      walletAddress: r.wallet_address,
      amountRaw: String(r.amount_raw),
      feeRequiredNano: String(r.fee_required_nano),
      payTo: this.hotWalletAddress,
      memo: r.memo,
      status: r.status,
      feeTxHash: r.fee_tx_hash || null,
      payoutTxHash: r.payout_tx_hash || null,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
      updatedAt: Number(r.updated_at),
    };
  }
}
