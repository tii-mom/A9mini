// A9 Protocol v15 — Zero-contract Presale hot-wallet auto-payout & refund runner.
// Polls finalized inbound TON transfers with "buy:<orderId>" memo to the presale hot wallet,
// dispatches standard TEP-74 A9 transfers (sendExcessesTo = hotWallet) for valid fills,
// or dispatches TON refunds for closed/over-quota orders.
// Defaults to dry-run unless execute=true AND OPS_EXECUTE=1.

export class PresalePayoutRunner {
  constructor({
    engine,
    tonCenter,
    a9Broadcaster = null,
    tonRefundBroadcaster = null,
    promoEngine = null,
    socialStore = null,
    execute = false,
    logger = console,
  }) {
    if (!engine) throw new Error('PresaleHotWalletEngine is required');
    if (!tonCenter) throw new Error('TonCenterClient is required');
    this.engine = engine;
    this.tonCenter = tonCenter;
    this.a9Broadcaster = a9Broadcaster; // async (instruction) => { txHash }
    this.tonRefundBroadcaster = tonRefundBroadcaster; // async (instruction) => { txHash }
    this.promoEngine = promoEngine;
    this.socialStore = socialStore;
    this.execute = Boolean(execute);
    this.logger = logger;
    this.running = false;
  }

  /** Execute one idempotent poll-verify-payout cycle. */
  async tick(nowSec = Math.floor(Date.now() / 1000)) {
    if (this.running) return { skipped: true, paid: 0, refunded: 0, dryRun: 0, ignored: 0, errors: [] };
    this.running = true;
    const summary = { skipped: false, paid: 0, refunded: 0, dryRun: 0, ignored: 0, errors: [] };
    try {
      const txs = await this.tonCenter.fetchInboundTransfers(this.engine.hotWalletAddress);
      for (const tx of txs) {
        if (!tx.memo || !tx.memo.startsWith('buy:')) {
          summary.ignored += 1;
          continue;
        }
        try {
          const res = this.engine.processInboundTonTx(tx, nowSec, {
            promoEngine: this.promoEngine,
            socialStore: this.socialStore,
          });
          if (res.action === 'IGNORE_DUST') {
            summary.ignored += 1;
            continue;
          }
          if (!this.execute) {
            summary.dryRun += 1;
            this.logger.log?.(`[presale-runner][DRY-RUN] ${res.action} for ${tx.from} (memo=${tx.memo})`);
            continue;
          }
          if (res.action === 'SEND_A9') {
            if (typeof this.a9Broadcaster !== 'function') {
              throw new Error('a9Broadcaster callback is required when execute=true');
            }
            const sent = await this.a9Broadcaster(res.instruction);
            if (res.order) {
              const rawOrder = this.engine.orders.get(res.order.orderId);
              if (rawOrder) {
                rawOrder.payoutTxHash = sent.txHash;
                rawOrder.updatedAt = nowSec;
              }
            }
            summary.paid += 1;
            this.logger.log?.(`[presale-runner] Paid A9 order=${res.order?.orderId} tx=${sent.txHash}`);
          } else if (res.action === 'REFUND_TON') {
            if (typeof this.tonRefundBroadcaster === 'function') {
              const sent = await this.tonRefundBroadcaster(res.instruction);
              if (res.order) {
                const rawOrder = this.engine.orders.get(res.order.orderId);
                if (rawOrder) {
                  rawOrder.payoutTxHash = sent.txHash;
                  rawOrder.updatedAt = nowSec;
                }
              }
              summary.refunded += 1;
              this.logger.log?.(`[presale-runner] Refunded TON to ${res.instruction.recipient} tx=${sent.txHash}`);
            } else {
              summary.dryRun += 1;
              this.logger.log?.(`[presale-runner][MANUAL-REFUND] ${res.instruction.tonNano} nanoTON -> ${res.instruction.recipient} (${res.reason})`);
            }
          }
        } catch (e) {
          if (e?.code === 'REPLAY_TX') {
            summary.ignored += 1;
          } else {
            summary.errors.push({ txHash: tx.txHash, code: e?.code || 'ERR', message: e?.message || String(e) });
          }
        }
      }
    } finally {
      this.running = false;
    }
    return summary;
  }
}
