// A9 Protocol v15/v16 — Off-chain Promo Hot-Wallet Polling & Recoverable Payout Runner.
//
// Safe by default: `execute` defaults to false (strictly read-only DRY-RUN, zero DB/balance writes).
// When backed by D1PromoStore (persistent promo_payouts + chain_scan_cursors), drives a full
// crash-recoverable state machine:
//   (1) cursor-paginated inbound fee scan -> verifyInboundFeeTx (atomic rollback-safe deduction + promo_payouts insert)
//   (2) backfill any legacy FEE_CONFIRMED claims into promo_payouts
//   (3) multi-instance atomic claim lock (PENDING/RETRY -> BROADCASTING) -> broadcast -> SENT
//   (4) downstream verifier check (by queryId) -> CONFIRMED + COMPLETED (never blind-resends uncertain broadcasts).

import { deriveClaimQueryId } from './promo-hotwallet.mjs';

const STALE_BROADCAST_SEC = 240;
const UNCONFIRMED_REVIEW_SEC = 3600;
const MAX_PROMO_ATTEMPTS = 5;
const DETERMINISTIC_PROMO_SKIP_CODES = new Set([
  'REPLAY_TX',
  'INVALID_STATE',
  'UNKNOWN_MEMO',
  'INSUFFICIENT_FEE',
  'CLAIM_EXPIRED',
  'INSUFFICIENT_BALANCE',
  'WRONG_DEST',
  'WRONG_PAYER',
]);

export class PromoPayoutRunner {
  constructor({
    engine,
    tonCenter,
    broadcaster = null,
    payoutVerifier = null,
    execute = false,
    logger = console,
  }) {
    if (!engine) throw new Error('PromoHotWalletEngine or D1PromoStore is required');
    if (!tonCenter) throw new Error('TonCenterClient is required');
    this.engine = engine;
    this.tonCenter = tonCenter;
    this.broadcaster = broadcaster; // async (payoutInstruction) => { txHash }
    this.payoutVerifier = payoutVerifier; // async (payout) => { state, txHash? }
    this.execute = Boolean(execute);
    this.logger = logger;
    this.running = false;
  }

  /** Execute one idempotent poll-verify-payout cycle. */
  async tick(nowSec = Math.floor(Date.now() / 1000)) {
    const summary = {
      skipped: false,
      processed: 0,
      broadcast: 0,
      confirmed: 0,
      retry: 0,
      review: 0,
      waiting: 0,
      dryRun: 0,
      ignored: 0,
      errors: [],
    };
    if (this.running) return { ...summary, skipped: true };
    this.running = true;
    try {
      let txs = [];
      let nextCursor = null;
      let cursorComplete = true;
      const canUseCursor = typeof this.tonCenter.fetchInboundTransfersSince === 'function'
        && typeof this.engine.getScanCursor === 'function';
      if (canUseCursor) {
        const cur = await this.engine.getScanCursor(this.engine.hotWalletAddress);
        const pageRes = await this.tonCenter.fetchInboundTransfersSince(this.engine.hotWalletAddress, {
          cursorLt: cur?.lt || null,
          cursorHash: cur?.hash || null,
        });
        txs = Array.isArray(pageRes?.transfers) ? pageRes.transfers : [];
        nextCursor = pageRes?.nextCursor || null;
        cursorComplete = pageRes?.canAdvanceCursor !== undefined
          ? Boolean(pageRes.canAdvanceCursor)
          : (pageRes?.reachedCursor !== false && !pageRes?.truncated);
      } else {
        txs = await this.tonCenter.fetchInboundTransfers(this.engine.hotWalletAddress);
      }

      const persistentPayouts = typeof this.engine.listOpenPromoPayouts === 'function';
      let inboundFailed = false;

      for (const tx of txs) {
        if (tx.bounced || tx.aborted || !tx.memo || !tx.memo.startsWith('claim:')) {
          summary.ignored += 1;
          continue;
        }
        try {
          if (!this.execute) {
            const planner = typeof this.engine.planInboundFeeTx === 'function'
              ? this.engine.planInboundFeeTx.bind(this.engine)
              : null;
            if (!planner) {
              throw new Error('promo engine missing read-only planInboundFeeTx for dry-run');
            }
            const { claim, payoutInstruction } = await planner(tx, nowSec);
            summary.dryRun += 1;
            this.logger.log?.(`[promo-runner][DRY-RUN] Verified ${claim.claimId} -> would send ${payoutInstruction.jettonAmountRaw} raw A9 to ${payoutInstruction.recipient}`);
            continue;
          }
          if (typeof this.broadcaster !== 'function') {
            throw new Error('broadcaster callback is required when execute=true');
          }
          const { claim, payoutInstruction } = await this.engine.verifyInboundFeeTx(tx, nowSec);
          if (!persistentPayouts) {
            // 内存版 PromoHotWalletEngine 兼容路径
            const sent = await this.broadcaster(payoutInstruction);
            await this.engine.markPayoutCompleted(claim.claimId, sent.txHash, nowSec);
            summary.broadcast += 1;
            summary.confirmed += 1;
            summary.processed += 1;
            this.logger.log?.(`[promo-runner] Paid ${claim.claimId} tx=${sent.txHash} (excesses -> ${payoutInstruction.sendExcessesTo})`);
          }
        } catch (e) {
          if (e?.code === 'NOT_FINALIZED') {
            inboundFailed = true;
            summary.waiting += 1;
          } else if (DETERMINISTIC_PROMO_SKIP_CODES.has(e?.code)) {
            summary.ignored += 1;
            if (e?.code !== 'REPLAY_TX' && e?.code !== 'UNKNOWN_MEMO') {
              this.logger.log?.(`[promo-runner] Skipped deterministic business error ${e.code} tx=${tx.txHash}: ${e.message}`);
            }
          } else {
            inboundFailed = true;
            summary.errors.push({ txHash: tx.txHash, code: e?.code || 'ERR', message: e?.message || String(e) });
          }
        }
      }

      if (!this.execute) return summary;
      if (!inboundFailed && cursorComplete && nextCursor && typeof this.engine.saveScanCursor === 'function') {
        await this.engine.saveScanCursor(this.engine.hotWalletAddress, nextCursor, nowSec);
      }

      // D1 持久化出账状态机驱动（支持广播失败重试、崩溃重启恢复、多实例互斥与链上终局确认）
      if (persistentPayouts) {
        if (typeof this.engine.queueConfirmedPromoPayouts === 'function') {
          await this.engine.queueConfirmedPromoPayouts(nowSec);
        }
        const openPayouts = await this.engine.listOpenPromoPayouts();
        for (const p of openPayouts) {
          try {
            const age = nowSec - Number(p.updatedAt || 0);
            if (p.status === 'RETRY' && p.ambiguous && age < STALE_BROADCAST_SEC) {
              summary.waiting += 1;
              continue;
            }
            if ((p.status === 'BROADCASTING' && age >= STALE_BROADCAST_SEC) || (p.status === 'RETRY' && p.ambiguous)) {
              if (typeof this.payoutVerifier !== 'function') {
                await this.engine.markPromoPayoutNeedsReview(p.payoutId, 'uncertain promo broadcast and no chain verifier configured', nowSec);
                summary.review += 1;
                continue;
              }
              const v = await this.payoutVerifier(p);
              if (v?.state === 'CONFIRMED') {
                await this.engine.completePromoPayout(p.payoutId, p.claimId, v.txHash || p.txHash, nowSec);
                summary.confirmed += 1;
                summary.processed += 1;
                continue;
              }
              if (v?.state !== 'FAILED') {
                const resolvedHash = v?.state === 'PENDING' ? (v.txHash || p.txHash || null) : null;
                if (resolvedHash) {
                  await this.engine.markPromoPayoutSent(p.payoutId, p.claimId, resolvedHash, nowSec);
                  summary.waiting += 1;
                } else if (age > UNCONFIRMED_REVIEW_SEC) {
                  await this.engine.markPromoPayoutNeedsReview(p.payoutId, 'uncertain promo broadcast requires reconciliation; absence from index is not proof of non-delivery', nowSec);
                  summary.review += 1;
                } else {
                  summary.waiting += 1;
                }
                continue;
              }
              // Only explicit terminal FAILED permits retry. NOT_FOUND and
              // unknown verifier results retain uncertainty until review.
              await this.engine.markPromoPayoutRetry(p.payoutId, { ambiguous: false, lastError: p.lastError || null }, nowSec);
              p.status = 'RETRY';
              p.ambiguous = false;
            }
            if (p.status === 'BROADCASTING') {
              summary.waiting += 1;
              continue;
            }
            if (p.status === 'PENDING' || p.status === 'RETRY') {
              if (Number(p.attempts || 0) >= MAX_PROMO_ATTEMPTS) {
                await this.engine.markPromoPayoutNeedsReview(p.payoutId, 'max promo payout attempts reached', nowSec);
                summary.review += 1;
                continue;
              }
              const nextAttempt = Number(p.attempts || 0) + 1;
              // P0-1 防双花：每次重试（attempt >= 2）重新派生唯一 64-bit queryId 并清空旧 txHash
              const nextQueryId = nextAttempt > 1 ? deriveClaimQueryId(p.claimId, nextAttempt) : p.queryId;
              const claimed = await this.engine.claimPromoPayout(p.payoutId, ['PENDING', 'RETRY'], {
                status: 'BROADCASTING',
                attempts: nextAttempt,
                ...(nextAttempt > 1 ? { queryId: nextQueryId, clearTxHash: true } : {}),
                updatedAt: nowSec,
              });
              if (!claimed) continue;
              p.attempts = nextAttempt;
              if (nextAttempt > 1) {
                p.queryId = nextQueryId;
                p.txHash = null;
              }
              let justBroadcast = false;
              try {
                const instr = this.engine.buildPromoInstruction(p);
                const sent = await this.broadcaster(instr);
                if (!sent?.txHash) throw Object.assign(new Error('broadcaster returned no txHash'), { notSent: false });
                await this.engine.markPromoPayoutSent(p.payoutId, p.claimId, sent.txHash, nowSec);
                p.status = 'SENT';
                p.txHash = sent.txHash;
                p.updatedAt = nowSec;
                justBroadcast = true;
                summary.broadcast += 1;
              } catch (e) {
                const msg = String(e?.message || e).slice(0, 300);
                const deterministic = e?.deterministic === true
                  || /insufficient hot wallet|insufficient.*inventory|insufficient.*balance|insufficient.*gas|not deployed yet|wallet address mismatch|ops_confirm|missing positive|missing a9_|exceeds single-cell|enoent/i.test(msg);
                await this.engine.markPromoPayoutRetry(p.payoutId, { ambiguous: e?.notSent !== true && !deterministic, lastError: msg }, nowSec);
                summary.retry += 1;
                if (deterministic) {
                  summary.errors.push({ payoutId: p.payoutId, code: e?.code || 'DETERMINISTIC_BROADCAST_FAILURE', message: msg });
                }
                this.logger.log?.(`[promo-runner] payout ${p.payoutId} broadcast failed: ${msg}`);
                continue;
              }
              // 同 tick 刚广播：允许立即命中 CONFIRMED，但严禁同 tick 误判 FAILED 引发重发
              if (justBroadcast) {
                if (typeof this.payoutVerifier === 'function') {
                  const v = await this.payoutVerifier(p);
                  if (v?.state === 'CONFIRMED') {
                    await this.engine.completePromoPayout(p.payoutId, p.claimId, v.txHash || p.txHash, nowSec);
                    summary.confirmed += 1;
                    summary.processed += 1;
                  } else {
                    summary.waiting += 1;
                  }
                } else {
                  summary.waiting += 1;
                }
                continue;
              }
            }
            if (p.status === 'SENT') {
              if (typeof this.payoutVerifier !== 'function') {
                // 未配置下游核验器时保持 SENT 等待人工或后续核验器确认，绝不自动误标 COMPLETED
                summary.waiting += 1;
                continue;
              }
              const v = await this.payoutVerifier(p);
              if (v?.state === 'CONFIRMED') {
                await this.engine.completePromoPayout(p.payoutId, p.claimId, v.txHash || p.txHash, nowSec);
                summary.confirmed += 1;
                summary.processed += 1;
              } else if (v?.state === 'FAILED') {
                await this.engine.markPromoPayoutRetry(p.payoutId, { ambiguous: false, lastError: 'on-chain promo jetton transfer failed' }, nowSec);
                summary.retry += 1;
              } else if (nowSec - Number(p.updatedAt || 0) > UNCONFIRMED_REVIEW_SEC) {
                await this.engine.markPromoPayoutNeedsReview(p.payoutId, 'promo payout sent but unconfirmed past threshold', nowSec);
                summary.review += 1;
              } else {
                summary.waiting += 1;
              }
            }
          } catch (e) {
            summary.errors.push({ payoutId: p.payoutId, code: e?.code || 'ERR', message: e?.message || String(e) });
          }
        }
      }
    } finally {
      this.running = false;
    }
    return summary;
  }
}
