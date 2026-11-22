// A9 Protocol v15 — Presale ("A9 固定兑换所") hot-wallet payout & refund runner.
//
// One tick = (1) read finalized inbound transfers, (2) persist each decision idempotently,
// (3) move PAYMENT_CONFIRMED orders to PAYOUT_PENDING, (4) drive persisted payouts
// (broadcast / verify / retry), (5) book referral rewards for COMPLETED orders.
//
// Dry-run (default): only step (1) + a pure plan. NOTHING is written to the order store,
// no broadcaster is called and no referral reward is booked. Real execution requires
// execute=true AND an a9Broadcaster (server.mjs additionally requires OPS_EXECUTE=1).

export class PresalePayoutRunner {
  constructor({
    engine,
    tonCenter,
    a9Broadcaster = null,
    tonRefundBroadcaster = null,
    payoutVerifier = null,
    promoEngine = null,
    execute = false,
    logger = console,
  }) {
    if (!engine) throw new Error('PresaleEngine is required');
    if (!tonCenter) throw new Error('TonCenterClient is required');
    this.engine = engine;
    this.tonCenter = tonCenter;
    this.a9Broadcaster = a9Broadcaster; // async (instruction) => { txHash }
    this.tonRefundBroadcaster = tonRefundBroadcaster; // async (instruction) => { txHash }
    this.payoutVerifier = payoutVerifier; // async (payout) => { state, txHash? }
    this.promoEngine = promoEngine;
    this.execute = Boolean(execute);
    this.logger = logger;
    this.running = false;
  }

  async tick(nowSec = Math.floor(Date.now() / 1000)) {
    const summary = {
      skipped: false, dryRun: 0, confirmed: 0, refundQueued: 0, ignored: 0, rejected: 0,
      queued: 0, paid: 0, refunded: 0, completed: 0, retry: 0, review: 0, credited: 0, plans: [], errors: [],
    };
    if (this.running) return { ...summary, skipped: true };
    this.running = true;
    try {
      if (this.execute && typeof this.a9Broadcaster !== 'function') {
        throw new Error('a9Broadcaster callback is required when execute=true');
      }
      const txs = await this.tonCenter.fetchInboundTransfers(this.engine.hotWalletAddress);
      for (const tx of txs) {
        if (!tx?.memo || !String(tx.memo).startsWith('buy:')) {
          // Other memos (e.g. promo "claim:") belong to other flows sharing the wallet.
          summary.ignored += 1;
          continue;
        }
        try {
          if (!this.execute) {
            const plan = await this.engine.planInbound(tx, nowSec);
            if (plan.action === 'REPLAY') { summary.ignored += 1; continue; }
            summary.dryRun += 1;
            summary.plans.push({ txHash: tx.txHash, action: plan.action, reason: plan.reason });
            this.logger.log?.(`[presale-runner][DRY-RUN] ${plan.action} (${plan.reason}) tx=${tx.txHash}`);
            continue;
          }
          const res = await this.engine.ingestInbound(tx, nowSec);
          if (res.action === 'REPLAY' || res.action === 'IGNORE_DUST') summary.ignored += 1;
          else if (res.action === 'REJECT') summary.rejected += 1;
          else if (res.action === 'CONFIRM') summary.confirmed += 1;
          else if (res.action === 'REFUND') summary.refundQueued += 1;
        } catch (e) {
          summary.errors.push({ txHash: tx?.txHash, code: e?.code || 'ERR', message: e?.message || String(e) });
        }
      }
      if (!this.execute) return summary;

      summary.queued = await this.engine.queueConfirmedPayouts(nowSec);
      const before = await this._countCompleted();
      const ps = await this.engine.processPayouts(nowSec, {
        a9Broadcaster: this.a9Broadcaster,
        refundBroadcaster: this.tonRefundBroadcaster,
        verifier: this.payoutVerifier,
        logger: this.logger,
      });
      summary.paid = ps.broadcast;
      summary.retry = ps.retry;
      summary.review = ps.review;
      summary.completed = Math.max(0, (await this._countCompleted()) - before);
      summary.errors.push(...ps.errors);
      const cs = await this.engine.processReferralCredits(nowSec, { promoEngine: this.promoEngine || this.engine.promoEngine });
      summary.credited = cs.credited;
      summary.review += cs.review;
    } catch (e) {
      summary.errors.push({ code: e?.code || 'ERR', message: e?.message || String(e) });
    } finally {
      this.running = false;
    }
    return summary;
  }

  async _countCompleted() {
    const rows = await this.engine.repo.listOrdersByStatus('COMPLETED');
    return rows.length;
  }
}
