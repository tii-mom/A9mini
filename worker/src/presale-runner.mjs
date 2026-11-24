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
      skipped: false, dryRun: 0, confirmed: 0, refundQueued: 0, anomalies: 0,
      otherFlow: 0, dust: 0, ignored: 0, rejected: 0,
      queued: 0, paid: 0, refunded: 0, completed: 0, retry: 0, review: 0, credited: 0, plans: [], errors: [],
    };
    if (this.running) return { ...summary, skipped: true };
    this.running = true;
    try {
      if (this.execute && typeof this.a9Broadcaster !== 'function') {
        throw new Error('a9Broadcaster callback is required when execute=true');
      }
      let txs = [];
      let nextCursor = null;
      let cursorComplete = true;
      const canUseCursor = typeof this.tonCenter.fetchInboundTransfersSince === 'function'
        && typeof this.engine.repo?.getScanCursor === 'function';
      if (canUseCursor) {
        const cur = await this.engine.repo.getScanCursor(this.engine.hotWalletAddress);
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
      // 所有到达热钱包的入账均交由引擎统一分类与持久化（不再提前按 buy: 前缀静默丢弃），
      // 以确保无备注、错备注、错金额、错地址、推广流程与粉尘入账均按规则留痕防重放。
      let inboundFailed = false;
      let hasUnfinalized = false;
      for (const tx of txs) {
        try {
          if (!this.execute) {
            const plan = await this.engine.planInbound(tx, nowSec);
            if (plan.action === 'REPLAY') { summary.ignored += 1; continue; }
            if (plan.action === 'OTHER_FLOW') { summary.otherFlow += 1; summary.ignored += 1; continue; }
            summary.dryRun += 1;
            summary.plans.push({ txHash: tx.txHash, action: plan.action, reason: plan.reason });
            this.logger.log?.(`[presale-runner][DRY-RUN] ${plan.action} (${plan.reason}) tx=${tx.txHash}`);
            continue;
          }
          const res = await this.engine.ingestInbound(tx, nowSec);
          if (res.action === 'REPLAY') summary.ignored += 1;
          else if (res.action === 'IGNORE_DUST') { summary.dust += 1; summary.ignored += 1; }
          else if (res.action === 'OTHER_FLOW') { summary.otherFlow += 1; summary.ignored += 1; }
          else if (res.action === 'REJECT') {
            summary.rejected += 1;
            if (res.reason === 'not_finalized') hasUnfinalized = true;
          }
          else if (res.action === 'ANOMALY') summary.anomalies += 1;
          else if (res.action === 'CONFIRM') summary.confirmed += 1;
          else if (res.action === 'REFUND') summary.refundQueued += 1;
        } catch (e) {
          inboundFailed = true;
          summary.errors.push({ txHash: tx?.txHash, code: e?.code || 'ERR', message: e?.message || String(e) });
        }
      }
      if (!this.execute) return summary;
      // 仅在扫描未截断、无未终局交易且全部入账均已无错持久化分类后才推进扫描游标，严防漏单
      if (!inboundFailed && !hasUnfinalized && cursorComplete && nextCursor && typeof this.engine.repo?.saveScanCursor === 'function') {
        await this.engine.repo.saveScanCursor(this.engine.hotWalletAddress, nextCursor, nowSec);
      }

      summary.queued = await this.engine.queueConfirmedPayouts(nowSec);
      const before = await this._countCompleted();
      const beforeRefunded = await this._countRefunded();
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
      summary.refunded = Math.max(0, (await this._countRefunded()) - beforeRefunded);
      summary.errors.push(...ps.errors);
      const cs = await this.engine.processReferralCredits(nowSec, {
        promoEngine: this.promoEngine || this.engine.promoEngine,
        budgetLedger: this.engine.budgetLedger || null,
        creditingStaleSec: 120,
      });
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
    if (typeof this.engine.repo?.countOrdersByStatus === 'function') {
      return this.engine.repo.countOrdersByStatus('COMPLETED');
    }
    const rows = await this.engine.repo.listOrdersByStatus('COMPLETED');
    return rows.length;
  }

  async _countRefunded() {
    if (typeof this.engine.repo?.countOrdersByStatus === 'function') {
      return this.engine.repo.countOrdersByStatus('REFUNDED');
    }
    const rows = await this.engine.repo.listOrdersByStatus('REFUNDED');
    return rows.length;
  }
}
