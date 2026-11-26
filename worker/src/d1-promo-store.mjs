// A9 Protocol v15 — Cloudflare D1 persistence adapter for 0-contract promo hot-wallet claims.
// Matches worker/schema.sql (promo_balances, promo_claims).
import { randomBytes } from 'node:crypto';
import {
  CLAIM_STATUS,
  DEFAULT_USER_FEE_NANO,
  DEFAULT_TRANSFER_GAS_NANO,
  DEFAULT_CLAIM_TTL_SEC,
  PromoError,
  deriveClaimQueryId,
} from './promo-hotwallet.mjs';
import { addressKey, addressAliases } from './ton-address.mjs';

const changes = (r) => Number(r?.meta?.changes ?? r?.changes ?? 0);
const isMissingTableErr = (e) => /no such table/i.test(String(e?.message || e));

export class D1PromoStore {
  constructor({
    db,
    hotWalletAddress,
    userFeeNano = DEFAULT_USER_FEE_NANO,
    transferGasNano = DEFAULT_TRANSFER_GAS_NANO,
    claimTtlSec = DEFAULT_CLAIM_TTL_SEC,
  }) {
    if (!db) throw new PromoError('DB_MISSING', 'Cloudflare D1 binding (env.DB) is required');
    if (!hotWalletAddress) throw new PromoError('CONFIG_MISSING', 'hotWalletAddress is required');
    this.db = db;
    this.hotWalletAddress = hotWalletAddress;
    this.userFeeNano = BigInt(userFeeNano);
    this.transferGasNano = BigInt(transferGasNano);
    this.claimTtlSec = Number(claimTtlSec);
  }

  async _findBalanceRow(walletAddress) {
    const key = addressKey(walletAddress);
    const row = await this.db
      .prepare('SELECT wallet_address, claimable_raw, total_claimed_raw FROM promo_balances WHERE wallet_address = ?')
      .bind(key)
      .first();
    if (row) return row;
    const aliases = addressAliases(walletAddress).filter((a) => a !== key);
    if (!aliases.length) return null;
    const ph = aliases.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT wallet_address, claimable_raw, total_claimed_raw FROM promo_balances WHERE wallet_address IN (${ph}) LIMIT 1`)
      .bind(...aliases)
      .first();
  }

  async getBalance(walletAddress) {
    const row = await this._findBalanceRow(walletAddress);
    return {
      walletAddress,
      claimableRaw: row ? String(row.claimable_raw) : '0',
      totalClaimedRaw: row ? String(row.total_claimed_raw) : '0',
    };
  }

  async hasPendingClaim(walletAddress, nowSec = Math.floor(Date.now() / 1000)) {
    const aliases = addressAliases(walletAddress);
    if (!aliases.length) return false;
    const ph = aliases.map(() => '?').join(', ');
    const row = await this.db
      .prepare(
        `SELECT claim_id FROM promo_claims
         WHERE wallet_address IN (${ph})
           AND (status IN (?, ?) OR (status = ? AND expires_at > ?))
         LIMIT 1`,
      )
      .bind(...aliases, CLAIM_STATUS.FEE_CONFIRMED, CLAIM_STATUS.PAYOUT_SENT, CLAIM_STATUS.PENDING_FEE, nowSec)
      .first();
    return Boolean(row);
  }

  /**
   * 为 D1IdentityStore.getBinding 提供单事务 db.batch() 原子余额合并语句与快照守卫：
   * - 将 wallet_bindings 晋升与 promo_balances 迁移合并进同一 SQLite/D1 事务；
   * - 任一守卫（余额快照变动、在途领币单、目标钱包冲突、约束错误）失败时整批回滚，
   *   彻底杜绝串账、丢余额与重复迁移。
   */
  async prepareAtomicMergeBalance(fromWallet, toWallet, nowSec = Math.floor(Date.now() / 1000)) {
    const fromKey = addressKey(fromWallet);
    const toKey = addressKey(toWallet);
    if (!fromKey || !toKey || fromKey === toKey) {
      return { noop: true, moveRaw: '0', guardSql: '', guardArgs: [], buildStmts: () => [] };
    }
    if (await this.hasPendingClaim(fromWallet, nowSec)) {
      throw new PromoError('PENDING_CLAIM_ACTIVE', '原钱包存在处理中的推广领币单，请完成后再合并余额');
    }
    const fromAliases = addressAliases(fromWallet);
    const claimPh = fromAliases.map(() => '?').join(', ');
    const noPendingClaimSql = fromAliases.length
      ? ` AND NOT EXISTS (SELECT 1 FROM promo_claims WHERE wallet_address IN (${claimPh}) AND (status IN (?, ?) OR (status = ? AND expires_at > ?)))`
      : '';
    const noPendingClaimArgs = fromAliases.length
      ? [...fromAliases, CLAIM_STATUS.FEE_CONFIRMED, CLAIM_STATUS.PAYOUT_SENT, CLAIM_STATUS.PENDING_FEE, nowSec]
      : [];

    const srcRow = await this._findBalanceRow(fromWallet);
    const move = BigInt(srcRow?.claimable_raw || '0');
    if (!srcRow || move <= 0n) {
      const srcAliases = Array.from(new Set([fromKey, ...fromAliases].filter(Boolean)));
      const srcPh = srcAliases.map(() => '?').join(', ');
      return {
        noop: true,
        moveRaw: '0',
        guardSql:
          `${noPendingClaimSql} AND NOT EXISTS (SELECT 1 FROM promo_balances WHERE wallet_address IN (${srcPh}) AND claimable_raw != '0')`,
        guardArgs: [...noPendingClaimArgs, ...srcAliases],
        buildStmts: () => [],
      };
    }

    const srcKey = String(srcRow.wallet_address);
    const srcCurStr = String(srcRow.claimable_raw);
    let dstRow = await this._findBalanceRow(toWallet);
    if (!dstRow) {
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO promo_balances (wallet_address, claimable_raw, total_claimed_raw, updated_at)
           VALUES (?, '0', '0', ?)`,
        )
        .bind(toKey, nowSec)
        .run();
      dstRow = await this._findBalanceRow(toWallet);
    }
    if (!dstRow) {
      throw new PromoError('CONFLICT', '目标钱包推广余额行初始化冲突，请重试');
    }
    const dstKey = String(dstRow.wallet_address);
    const dstCurStr = String(dstRow.claimable_raw || '0');
    const dstNextStr = (BigInt(dstCurStr) + move).toString();

    return {
      noop: false,
      moveRaw: move.toString(),
      srcKey,
      dstKey,
      srcCurStr,
      dstCurStr,
      dstNextStr,
      guardSql:
        `${noPendingClaimSql}` +
        ' AND EXISTS (SELECT 1 FROM promo_balances WHERE wallet_address = ? AND claimable_raw = ?)' +
        ' AND EXISTS (SELECT 1 FROM promo_balances WHERE wallet_address = ? AND claimable_raw = ?)',
      guardArgs: [...noPendingClaimArgs, srcKey, srcCurStr, dstKey, dstCurStr],
      buildStmts: (bindingGuardSql = '', bindingGuardArgs = []) => [
        this.db
          .prepare(
            `UPDATE promo_balances
             SET claimable_raw = CASE
                   WHEN claimable_raw = ?
                    AND EXISTS (SELECT 1 FROM promo_balances WHERE wallet_address = ? AND claimable_raw = ?)${bindingGuardSql}
                   THEN '0'
                   ELSE NULL
                 END,
                 updated_at = ?
             WHERE wallet_address = ?`,
          )
          .bind(srcCurStr, dstKey, dstCurStr, ...bindingGuardArgs, nowSec, srcKey),
        this.db
          .prepare(
            `UPDATE promo_balances
             SET claimable_raw = CASE
                   WHEN claimable_raw = ?
                    AND EXISTS (SELECT 1 FROM promo_balances WHERE wallet_address = ? AND claimable_raw = '0')${bindingGuardSql}
                   THEN ?
                   ELSE NULL
                 END,
                 updated_at = ?
             WHERE wallet_address = ?`,
          )
          .bind(dstCurStr, srcKey, ...bindingGuardArgs, dstNextStr, nowSec, dstKey),
      ],
    };
  }

  async mergeBalance(fromWallet, toWallet, nowSec = Math.floor(Date.now() / 1000)) {
    const fromKey = addressKey(fromWallet);
    const toKey = addressKey(toWallet);
    if (!fromKey || !toKey || fromKey === toKey) {
      return { mergedRaw: '0', fromWallet, toWallet };
    }
    if (await this.hasPendingClaim(fromWallet, nowSec)) {
      throw new PromoError('PENDING_CLAIM_ACTIVE', '原钱包存在处理中的推广领币单，请完成后再合并余额');
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const srcRow = await this._findBalanceRow(fromWallet);
      const move = BigInt(srcRow?.claimable_raw || '0');
      if (!srcRow || move <= 0n) {
        return { mergedRaw: '0', fromWallet, toWallet };
      }
      const srcKey = String(srcRow.wallet_address);
      const srcCurStr = String(srcRow.claimable_raw);
      let dstRow = await this._findBalanceRow(toWallet);
      if (!dstRow) {
        await this.db
          .prepare(
            `INSERT OR IGNORE INTO promo_balances (wallet_address, claimable_raw, total_claimed_raw, updated_at)
             VALUES (?, '0', '0', ?)`,
          )
          .bind(toKey, nowSec)
          .run();
        dstRow = await this._findBalanceRow(toWallet);
      }
      if (!dstRow) continue;
      const dstKey = String(dstRow.wallet_address);
      const dstCurStr = String(dstRow.claimable_raw || '0');
      const dstNextStr = (BigInt(dstCurStr) + move).toString();

      try {
        const out = await this.db.batch([
          this.db
            .prepare(
              `UPDATE promo_balances
               SET claimable_raw = CASE
                     WHEN claimable_raw = ?
                      AND EXISTS (SELECT 1 FROM promo_balances WHERE wallet_address = ? AND claimable_raw = ?)
                     THEN '0'
                     ELSE NULL
                   END,
                   updated_at = ?
               WHERE wallet_address = ?`,
            )
            .bind(srcCurStr, dstKey, dstCurStr, nowSec, srcKey),
          this.db
            .prepare(
              `UPDATE promo_balances
               SET claimable_raw = CASE
                     WHEN claimable_raw = ?
                      AND EXISTS (SELECT 1 FROM promo_balances WHERE wallet_address = ? AND claimable_raw = '0')
                     THEN ?
                     ELSE NULL
                   END,
                   updated_at = ?
               WHERE wallet_address = ?`,
            )
            .bind(dstCurStr, srcKey, dstNextStr, nowSec, dstKey),
        ]);
        if (changes(out?.[0]) === 1 && changes(out?.[1]) === 1) {
          return { mergedRaw: move.toString(), fromWallet, toWallet, targetClaimableRaw: dstNextStr };
        }
      } catch (e) {
        if (/NOT NULL|UNIQUE|constraint/i.test(String(e?.message || e))) continue;
        throw e;
      }
    }
    throw new PromoError('CONFLICT', '换绑钱包推广余额合并并发冲突，请重试');
  }

  /**
   * Credit promotion / referral / activated-prediction A9 rewards to D1 promo_balances.
   * Uses optimistic CAS loop on canonical addressKey to prevent concurrent lost updates.
   */
  async creditReward(walletAddress, amountRaw, nowSec = Math.floor(Date.now() / 1000)) {
    const wallet = String(walletAddress || '').trim();
    const add = BigInt(amountRaw);
    if (!wallet) throw new PromoError('BAD_WALLET', 'walletAddress is required');
    if (add <= 0n) throw new PromoError('BAD_AMOUNT', 'credit amount must be positive');

    const key = addressKey(wallet);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await this._findBalanceRow(wallet);
      if (!existing) {
        const ins = await this.db
          .prepare(
            `INSERT OR IGNORE INTO promo_balances (wallet_address, claimable_raw, total_claimed_raw, updated_at)
             VALUES (?, ?, '0', ?)`,
          )
          .bind(key, add.toString(), nowSec)
          .run();
        if (changes(ins) === 1) {
          return { walletAddress: wallet, claimableRaw: add.toString(), totalClaimedRaw: '0' };
        }
        continue;
      }
      const curRaw = String(existing.claimable_raw || '0');
      const nextClaimable = BigInt(curRaw) + add;
      const upd = await this.db
        .prepare(
          `UPDATE promo_balances
           SET claimable_raw = ?, updated_at = ?
           WHERE wallet_address = ? AND claimable_raw = ?`,
        )
        .bind(nextClaimable.toString(), nowSec, existing.wallet_address, curRaw)
        .run();
      if (changes(upd) === 1) {
        return {
          walletAddress: wallet,
          claimableRaw: nextClaimable.toString(),
          totalClaimedRaw: String(existing.total_claimed_raw || '0'),
        };
      }
    }
    throw new PromoError('CONFLICT', 'concurrent promo balance update conflict, please retry');
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

    const aliases = addressAliases(walletAddress);
    const ph = aliases.map(() => '?').join(', ');
    const existing = await this.db
      .prepare(`SELECT * FROM promo_claims WHERE wallet_address IN (${ph}) AND status = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1`)
      .bind(...aliases, CLAIM_STATUS.PENDING_FEE, nowSec)
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

  /**
   * Read-only dry-run verification: validates finalized 0.06 GRAM inbound fee tx WITHOUT mutating D1.
   */
  async planInboundFeeTx(tx, nowSec = Math.floor(Date.now() / 1000)) {
    if (!tx || !tx.txHash) throw new PromoError('BAD_TX', 'missing txHash');
    if (tx.finality !== 'finalized') throw new PromoError('NOT_FINALIZED', 'fee tx must be finalized');
    if (addressKey(tx.to) !== addressKey(this.hotWalletAddress)) {
      throw new PromoError('WRONG_DEST', 'destination is not promo hot wallet');
    }

    const replay = await this.db
      .prepare('SELECT claim_id FROM promo_claims WHERE fee_tx_hash = ? LIMIT 1')
      .bind(tx.txHash)
      .first();
    if (replay) throw new PromoError('REPLAY_TX', 'fee tx already processed');

    const memo = String(tx.memo || '').trim();
    const claimRow = await this.db
      .prepare('SELECT * FROM promo_claims WHERE memo = ? LIMIT 1')
      .bind(memo)
      .first();
    if (!claimRow) throw new PromoError('UNKNOWN_MEMO', `no claim matches memo: ${memo}`);
    if (claimRow.status !== CLAIM_STATUS.PENDING_FEE) {
      throw new PromoError('INVALID_STATE', `claim ${claimRow.claim_id} is ${claimRow.status}`);
    }
    if (!tx.from || addressKey(tx.from) !== addressKey(claimRow.wallet_address)) {
      throw new PromoError('WRONG_PAYER', 'fee sender does not match claim wallet');
    }
    const paidAt = Number(tx.utime) > 0 ? Number(tx.utime) : nowSec;
    if (paidAt > Number(claimRow.expires_at)) {
      throw new PromoError('CLAIM_EXPIRED', `claim ${claimRow.claim_id} expired`);
    }
    const receivedNano = BigInt(tx.valueNano || 0);
    const feeRequired = BigInt(claimRow.fee_required_nano || '0');
    if (receivedNano < feeRequired) {
      throw new PromoError('INSUFFICIENT_FEE', `received ${receivedNano} < required ${feeRequired}`);
    }
    const balRow = await this._findBalanceRow(claimRow.wallet_address);
    const amountRaw = BigInt(claimRow.amount_raw || '0');
    const curClaimable = BigInt(balRow?.claimable_raw || '0');
    if (!balRow || curClaimable < amountRaw) {
      throw new PromoError('INSUFFICIENT_BALANCE', 'claimable balance changed');
    }
    const formatted = this._formatRow(claimRow);
    return {
      claim: formatted,
      payoutInstruction: {
        op: '0x0f8a7ea5',
        queryId: deriveClaimQueryId(formatted.claimId),
        fromHotWallet: this.hotWalletAddress,
        recipient: formatted.walletAddress,
        jettonAmountRaw: formatted.amountRaw,
        attachedTonNano: this.transferGasNano.toString(),
        sendExcessesTo: this.hotWalletAddress,
        forwardTonNano: '0',
      },
    };
  }

  /**
   * Atomically verify finalized 0.06 GRAM fee inbound tx and deduct claimable balance in D1.
   * Uses NOT NULL constraint guards inside a single db.batch() transaction so any concurrent
   * balance change, claim state change, or duplicate fee_tx_hash forces a FULL ROLLBACK
   * (eliminating partial-commit balance evaporation).
   */
  async verifyInboundFeeTx(tx, nowSec = Math.floor(Date.now() / 1000)) {
    if (!tx || !tx.txHash) throw new PromoError('BAD_TX', 'missing txHash');
    if (tx.finality !== 'finalized') throw new PromoError('NOT_FINALIZED', 'fee tx must be finalized');
    if (addressKey(tx.to) !== addressKey(this.hotWalletAddress)) {
      throw new PromoError('WRONG_DEST', 'destination is not promo hot wallet');
    }

    const replay = await this.db
      .prepare('SELECT claim_id FROM promo_claims WHERE fee_tx_hash = ? LIMIT 1')
      .bind(tx.txHash)
      .first();
    if (replay) throw new PromoError('REPLAY_TX', 'fee tx already processed');

    const memo = String(tx.memo || '').trim();
    const claimRow = await this.db
      .prepare('SELECT * FROM promo_claims WHERE memo = ? LIMIT 1')
      .bind(memo)
      .first();
    if (!claimRow) throw new PromoError('UNKNOWN_MEMO', `no claim matches memo: ${memo}`);
    if (claimRow.status !== CLAIM_STATUS.PENDING_FEE) {
      throw new PromoError('INVALID_STATE', `claim ${claimRow.claim_id} is ${claimRow.status}`);
    }
    if (!tx.from || addressKey(tx.from) !== addressKey(claimRow.wallet_address)) {
      throw new PromoError('WRONG_PAYER', 'fee sender does not match claim wallet');
    }
    const paidAt = Number(tx.utime) > 0 ? Number(tx.utime) : nowSec;
    if (paidAt > Number(claimRow.expires_at)) {
      await this.db
        .prepare('UPDATE promo_claims SET status = ?, updated_at = ? WHERE claim_id = ? AND status = ?')
        .bind(CLAIM_STATUS.EXPIRED, nowSec, claimRow.claim_id, CLAIM_STATUS.PENDING_FEE)
        .run();
      throw new PromoError('CLAIM_EXPIRED', `claim ${claimRow.claim_id} expired`);
    }
    const receivedNano = BigInt(tx.valueNano || 0);
    const feeRequired = BigInt(claimRow.fee_required_nano || '0');
    if (receivedNano < feeRequired) {
      throw new PromoError('INSUFFICIENT_FEE', `received ${receivedNano} < required ${feeRequired}`);
    }

    const balRow = await this._findBalanceRow(claimRow.wallet_address);
    const amountRaw = BigInt(claimRow.amount_raw || '0');
    const curClaimable = BigInt(balRow?.claimable_raw || '0');
    if (!balRow || curClaimable < amountRaw) {
      await this.db
        .prepare('UPDATE promo_claims SET status = ?, updated_at = ? WHERE claim_id = ? AND status = ?')
        .bind(CLAIM_STATUS.FAILED, nowSec, claimRow.claim_id, CLAIM_STATUS.PENDING_FEE)
        .run();
      throw new PromoError('INSUFFICIENT_BALANCE', 'claimable balance changed');
    }

    const nextClaimable = curClaimable - amountRaw;
    const nextClaimed = BigInt(balRow.total_claimed_raw || '0') + amountRaw;
    let out;
    try {
      out = await this.db.batch([
        // 守卫 1：校验 claim 仍为 PENDING_FEE、fee_tx_hash 未被使用、且 promo_balances 快照未变动；
        // 任一条件不成立时向 NOT NULL 列 status 写 NULL，强制 SQLite/D1 回滚整笔 batch 事务。
        this.db
          .prepare(
            `UPDATE promo_claims
             SET status = CASE
                   WHEN status = ?
                    AND NOT EXISTS (SELECT 1 FROM promo_claims WHERE fee_tx_hash = ?)
                    AND EXISTS (
                      SELECT 1 FROM promo_balances
                      WHERE wallet_address = ? AND claimable_raw = ?
                    )
                   THEN ?
                   ELSE NULL
                 END,
                 fee_tx_hash = ?,
                 updated_at = ?
             WHERE claim_id = ?`,
          )
          .bind(
            CLAIM_STATUS.PENDING_FEE,
            tx.txHash,
            balRow.wallet_address,
            String(balRow.claimable_raw),
            CLAIM_STATUS.FEE_CONFIRMED,
            tx.txHash,
            nowSec,
            claimRow.claim_id,
          ),
        // 守卫 2：仅当守卫 1 确实已将目标 claim 原子置为 FEE_CONFIRMED 且余额快照仍一致时扣款；
        // 否则向 NOT NULL 列 claimable_raw 写 NULL 触发整批回滚。
        this.db
          .prepare(
            `UPDATE promo_balances
             SET claimable_raw = CASE
                   WHEN claimable_raw = ?
                    AND EXISTS (
                      SELECT 1 FROM promo_claims
                      WHERE claim_id = ? AND status = ? AND fee_tx_hash = ?
                    )
                   THEN ?
                   ELSE NULL
                 END,
                 total_claimed_raw = ?,
                 updated_at = ?
             WHERE wallet_address = ?`,
          )
          .bind(
            String(balRow.claimable_raw),
            claimRow.claim_id,
            CLAIM_STATUS.FEE_CONFIRMED,
            tx.txHash,
            nextClaimable.toString(),
            nextClaimed.toString(),
            nowSec,
            balRow.wallet_address,
          ),
      ]);
    } catch (e) {
      const msg = String(e?.message || e);
      if (/NOT NULL|UNIQUE|constraint/i.test(msg)) {
        throw new PromoError('CONFLICT', 'concurrent promo claim verification conflict (transaction rolled back)');
      }
      throw e;
    }
    if (changes(out?.[0]) !== 1 || changes(out?.[1]) !== 1) {
      throw new PromoError('CONFLICT', 'concurrent promo claim verification conflict');
    }

    const updated = await this.getClaim(claimRow.claim_id);
    const queryId = deriveClaimQueryId(updated.claimId);
    // 幂等写入 promo_payouts 持久化出账意图（兼容尚未执行 0010 迁移的旧库）
    try {
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO promo_payouts
             (payout_id, claim_id, wallet_address, wallet_key, amount_raw, query_id, status, attempts, ambiguous, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, 0, ?, ?)`,
        )
        .bind(
          `promo:${updated.claimId}`,
          updated.claimId,
          updated.walletAddress,
          addressKey(updated.walletAddress),
          updated.amountRaw,
          queryId,
          nowSec,
          nowSec,
        )
        .run();
    } catch (e) {
      if (!isMissingTableErr(e)) throw e;
      // 旧库无 promo_payouts 表时退化兼容
    }
    return {
      claim: updated,
      payoutInstruction: {
        op: '0x0f8a7ea5',
        queryId,
        fromHotWallet: this.hotWalletAddress,
        recipient: updated.walletAddress,
        jettonAmountRaw: updated.amountRaw,
        attachedTonNano: this.transferGasNano.toString(),
        sendExcessesTo: this.hotWalletAddress,
        forwardTonNano: '0',
      },
    };
  }

  /** 将所有历史停留在 FEE_CONFIRMED 但尚未生成 promo_payouts 的记录幂等补建出账意图。 */
  async queueConfirmedPromoPayouts(nowSec = Math.floor(Date.now() / 1000)) {
    let queued = 0;
    try {
      const res = await this.db
        .prepare(
          `SELECT c.* FROM promo_claims c
           LEFT JOIN promo_payouts p ON p.claim_id = c.claim_id
           WHERE c.status = ? AND p.claim_id IS NULL
           ORDER BY c.created_at ASC`,
        )
        .bind(CLAIM_STATUS.FEE_CONFIRMED)
        .all();
      for (const r of res?.results || []) {
        const qid = deriveClaimQueryId(r.claim_id);
        const ins = await this.db
          .prepare(
            `INSERT OR IGNORE INTO promo_payouts
               (payout_id, claim_id, wallet_address, wallet_key, amount_raw, query_id, status, attempts, ambiguous, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, 0, ?, ?)`,
          )
          .bind(`promo:${r.claim_id}`, r.claim_id, r.wallet_address, addressKey(r.wallet_address), String(r.amount_raw), qid, nowSec, nowSec)
          .run();
        if (changes(ins) === 1) queued += 1;
      }
    } catch (e) {
      if (isMissingTableErr(e)) return 0;
      throw e;
    }
    return queued;
  }

  async listOpenPromoPayouts() {
    try {
      const res = await this.db
        .prepare("SELECT * FROM promo_payouts WHERE status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT') ORDER BY created_at ASC")
        .all();
      return (res?.results || []).map((r) => ({
        payoutId: r.payout_id,
        claimId: r.claim_id,
        kind: 'A9',
        recipient: r.wallet_address,
        walletKey: r.wallet_key,
        amount: String(r.amount_raw),
        queryId: String(r.query_id),
        status: r.status,
        attempts: Number(r.attempts || 0),
        ambiguous: Number(r.ambiguous || 0) === 1,
        txHash: r.tx_hash || null,
        lastError: r.last_error || null,
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      }));
    } catch (e) {
      if (isMissingTableErr(e)) return [];
      throw e;
    }
  }

  async claimPromoPayout(payoutId, fromStatuses, { status = 'BROADCASTING', attempts, queryId = null, clearTxHash = false, updatedAt }) {
    const ph = fromStatuses.map(() => '?').join(', ');
    const sets = ['status = ?', 'attempts = ?', 'updated_at = ?'];
    const vals = [status, attempts, updatedAt];
    if (queryId !== null && queryId !== undefined) {
      sets.push('query_id = ?');
      vals.push(String(queryId));
    }
    if (clearTxHash) {
      sets.push('tx_hash = NULL');
    }
    const res = await this.db
      .prepare(`UPDATE promo_payouts SET ${sets.join(', ')} WHERE payout_id = ? AND status IN (${ph})`)
      .bind(...vals, payoutId, ...fromStatuses)
      .run();
    return changes(res) === 1;
  }

  async markPromoPayoutSent(payoutId, claimId, txHash, nowSec) {
    await this.db.batch([
      this.db
        .prepare("UPDATE promo_payouts SET status = 'SENT', ambiguous = 0, tx_hash = COALESCE(?, tx_hash), updated_at = ? WHERE payout_id = ? AND status IN ('BROADCASTING', 'RETRY', 'PENDING', 'SENT')")
        .bind(txHash, nowSec, payoutId),
      this.db
        .prepare('UPDATE promo_claims SET status = ?, payout_tx_hash = COALESCE(?, payout_tx_hash), updated_at = ? WHERE claim_id = ? AND status IN (?, ?)')
        .bind(CLAIM_STATUS.PAYOUT_SENT, txHash, nowSec, claimId, CLAIM_STATUS.FEE_CONFIRMED, CLAIM_STATUS.PAYOUT_SENT),
    ]);
  }

  async markPromoPayoutRetry(payoutId, { ambiguous = true, lastError = null }, nowSec) {
    await this.db
      .prepare("UPDATE promo_payouts SET status = 'RETRY', ambiguous = ?, last_error = ?, updated_at = ? WHERE payout_id = ? AND status IN ('BROADCASTING', 'SENT', 'RETRY', 'PENDING')")
      .bind(ambiguous ? 1 : 0, lastError, nowSec, payoutId)
      .run();
  }

  async markPromoPayoutNeedsReview(payoutId, reason, nowSec) {
    await this.db
      .prepare("UPDATE promo_payouts SET status = 'NEEDS_REVIEW', last_error = ?, updated_at = ? WHERE payout_id = ? AND status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT')")
      .bind(reason, nowSec, payoutId)
      .run();
  }

  async completePromoPayout(payoutId, claimId, txHash, nowSec) {
    await this.db.batch([
      this.db
        .prepare("UPDATE promo_payouts SET status = 'CONFIRMED', ambiguous = 0, tx_hash = COALESCE(?, tx_hash), updated_at = ? WHERE payout_id = ? AND status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT', 'NEEDS_REVIEW')")
        .bind(txHash, nowSec, payoutId),
      this.db
        .prepare('UPDATE promo_claims SET status = ?, payout_tx_hash = COALESCE(?, payout_tx_hash), updated_at = ? WHERE claim_id = ? AND status IN (?, ?)')
        .bind(CLAIM_STATUS.COMPLETED, txHash, nowSec, claimId, CLAIM_STATUS.FEE_CONFIRMED, CLAIM_STATUS.PAYOUT_SENT),
    ]);
    return this.getClaim(claimId);
  }

  /**
   * 人工复核恢复保护（防双发硬门禁）：
   * 强制先通过链上核验器确认原出账是否已到账；若链上已 CONFIRMED 则直接结单为 COMPLETED，
   * 若仍在 PENDING 则拒绝重排，仅当明确为 NOT_FOUND / FAILED 时才派生全新 queryId 重新入队。
   */
  async resolvePromoPayoutReview(payoutId, { payoutVerifier, nowSec = Math.floor(Date.now() / 1000) } = {}) {
    if (typeof payoutVerifier !== 'function') {
      throw new PromoError('VERIFIER_REQUIRED', 'chain payoutVerifier is required before resolving NEEDS_REVIEW');
    }
    const r = await this.db
      .prepare('SELECT * FROM promo_payouts WHERE payout_id = ? LIMIT 1')
      .bind(payoutId)
      .first();
    if (!r) throw new PromoError('NOT_FOUND', `promo payout not found: ${payoutId}`);
    if (r.status !== 'NEEDS_REVIEW') {
      throw new PromoError('INVALID_STATE', `payout ${payoutId} is ${r.status}, expected NEEDS_REVIEW`);
    }
    const payout = {
      payoutId: r.payout_id,
      claimId: r.claim_id,
      kind: 'A9',
      recipient: r.wallet_address,
      walletKey: r.wallet_key,
      amount: String(r.amount_raw),
      queryId: String(r.query_id),
      status: r.status,
      attempts: Number(r.attempts || 0),
      ambiguous: Number(r.ambiguous || 0) === 1,
      txHash: r.tx_hash || null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
    const v = await payoutVerifier(payout);
    if (v?.state === 'CONFIRMED') {
      const claim = await this.completePromoPayout(payout.payoutId, payout.claimId, v.txHash || payout.txHash, nowSec);
      return { action: 'COMPLETED_FROM_CHAIN', claim };
    }
    if (v?.state !== 'NOT_FOUND' && v?.state !== 'FAILED') {
      throw new PromoError('PAYOUT_STILL_UNCERTAIN', `cannot re-queue payout while chain state is ${v?.state || 'UNKNOWN'}`);
    }
    const freshQueryId = deriveClaimQueryId(payout.claimId, payout.attempts + 100 + (nowSec % 97));
    const res = await this.db
      .prepare("UPDATE promo_payouts SET status = 'PENDING', attempts = 0, ambiguous = 0, query_id = ?, tx_hash = NULL, updated_at = ? WHERE payout_id = ? AND status = 'NEEDS_REVIEW'")
      .bind(freshQueryId, nowSec, payoutId)
      .run();
    if (changes(res) !== 1) throw new PromoError('CONFLICT', 'concurrent NEEDS_REVIEW resolution conflict');
    return { action: 'REQUEUED', payoutId, queryId: freshQueryId };
  }

  async getScanCursor(walletAddress) {
    const key = addressKey(walletAddress);
    try {
      const row = await this.db
        .prepare('SELECT last_lt, last_hash, updated_at FROM chain_scan_cursors WHERE wallet_address = ? LIMIT 1')
        .bind(key)
        .first();
      return row ? { lt: String(row.last_lt), hash: String(row.last_hash), updatedAt: Number(row.updated_at || 0) } : null;
    } catch (e) {
      if (isMissingTableErr(e)) return null;
      throw e;
    }
  }

  async saveScanCursor(walletAddress, { lt, hash }, nowSec) {
    if (!lt || !hash) return;
    const key = addressKey(walletAddress);
    try {
      await this.db
        .prepare(
          `INSERT INTO chain_scan_cursors (wallet_address, last_lt, last_hash, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(wallet_address) DO UPDATE SET
             last_lt = excluded.last_lt,
             last_hash = excluded.last_hash,
             updated_at = excluded.updated_at`,
        )
        .bind(key, String(lt), String(hash), nowSec)
        .run();
    } catch (e) {
      if (!isMissingTableErr(e)) throw e;
    }
  }

  buildPromoInstruction(p) {
    return {
      payoutId: p.payoutId,
      claimId: p.claimId,
      op: '0x0f8a7ea5',
      queryId: p.queryId,
      fromHotWallet: this.hotWalletAddress,
      recipient: p.recipient,
      jettonAmountRaw: p.amount,
      attachedTonNano: this.transferGasNano.toString(),
      sendExcessesTo: this.hotWalletAddress,
      forwardTonNano: '0',
    };
  }

  async markPayoutCompleted(claimId, payoutTxHash, nowSec = Math.floor(Date.now() / 1000)) {
    const res = await this.db
      .prepare(
        `UPDATE promo_claims
         SET status = ?, payout_tx_hash = ?, updated_at = ?
         WHERE claim_id = ? AND status IN (?, ?)`,
      )
      .bind(CLAIM_STATUS.COMPLETED, payoutTxHash, nowSec, claimId, CLAIM_STATUS.FEE_CONFIRMED, CLAIM_STATUS.PAYOUT_SENT)
      .run();
    if (changes(res) !== 1) {
      const cur = await this.getClaim(claimId);
      if (!cur) throw new PromoError('NOT_FOUND', `claim ${claimId} not found`);
      throw new PromoError('INVALID_STATE', `cannot complete claim in state ${cur.status}`);
    }
    return this.getClaim(claimId);
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
