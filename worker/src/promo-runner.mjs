// A9 Protocol v15/v16 — Off-chain Promo Hot-Wallet Polling & Recoverable Payout Runner.
//
// Safe by default: `execute` defaults to false (strictly read-only DRY-RUN, zero DB/balance writes).
// When backed by D1PromoStore (persistent promo_payouts + chain_scan_cursors), drives a full
// crash-recoverable state machine:
//   (1) cursor-paginated inbound fee scan -> verifyInboundFeeTx (atomic rollback-safe deduction + promo_payouts insert)
//   (2) backfill any legacy FEE_CONFIRMED claims into promo_payouts
//   (3) multi-instance atomic claim lock (PENDING/RETRY -> BROADCASTING) -> broadcast -> SENT
//   (4) downstream verifier check (by queryId) -> CONFIRMED + COMPLETED (never blind-resends uncertain broadcasts).

const STALE_BROADCAST_SEC = 120;
const UNCONFIRMED_REVIEW_SEC = 3600;
const MAX_PROMO_ATTEMPTS = 5;

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
          if (e?.code === 'REPLAY_TX' || e?.code === 'INVALID_STATE' || e?.code === 'UNKNOWN_MEMO') {
            summary.ignored += 1;
          } else {
            inboundFailed = true;
            summary.errors.push({ txHash: tx.txHash, code: e?.code || 'ERR', message: e?.message || String(e) });
          }
        }
      }

      if (!this.execute) return summary;
      if (!inboundFailed && nextCursor && typeof this.engine.saveScanCursor === 'function') {
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
              if (v?.state === 'PENDING') {
                const resolvedHash = v.txHash || p.txHash || null;
                if (resolvedHash) {
                  await this.engine.markPromoPayoutSent(p.payoutId, p.claimId, resolvedHash, nowSec);
                  summary.waiting += 1;
                } else if (age > UNCONFIRMED_REVIEW_SEC) {
                  await this.engine.markPromoPayoutNeedsReview(p.payoutId, 'uncertain promo broadcast unconfirmed past review threshold', nowSec);
                  summary.review += 1;
                } else {
                  summary.waiting += 1;
                }
                continue;
              }
              // NOT_FOUND / FAILED -> 安全重置为可重试
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
              const claimed = await this.engine.claimPromoPayout(p.payoutId, ['PENDING', 'RETRY'], {
                status: 'BROADCASTING',
                attempts: Number(p.attempts || 0) + 1,
                updatedAt: nowSec,
              });
              if (!claimed) continue;
              try {
                const instr = this.engine.buildPromoInstruction(p);
                const sent = await this.broadcaster(instr);
                if (!sent?.txHash) throw Object.assign(new Error('broadcaster returned no txHash'), { notSent: false });
                await this.engine.markPromoPayoutSent(p.payoutId, p.claimId, sent.txHash, nowSec);
                p.status = 'SENT';
                p.txHash = sent.txHash;
                p.updatedAt = nowSec;
                summary.broadcast += 1;
              } catch (e) {
                const msg = String(e?.message || e).slice(0, 300);
                await this.engine.markPromoPayoutRetry(p.payoutId, { ambiguous: e?.notSent !== true, lastError: msg }, nowSec);
                summary.retry += 1;
                this.logger.log?.(`[promo-runner] payout ${p.payoutId} broadcast failed: ${msg}`);
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
