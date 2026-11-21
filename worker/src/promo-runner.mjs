// A9 Protocol v15 — Zero-contract promotion hot-wallet auto-payout runner.
// Polls finalized 0.06 TON inbound transfers with "claim:<id>" memo and dispatches
// standard TEP-74 A9 transfers with sendExcessesTo = hotWalletAddress (0 project gas cost).
// Defaults to dry-run unless execute=true AND OPS_EXECUTE=1.

export class PromoPayoutRunner {
  constructor({
    engine,
    tonCenter,
    broadcaster,
    execute = false,
    logger = console,
  }) {
    if (!engine) throw new Error('PromoHotWalletEngine is required');
    if (!tonCenter) throw new Error('TonCenterClient is required');
    this.engine = engine;
    this.tonCenter = tonCenter;
    this.broadcaster = broadcaster; // async (payoutInstruction) => { txHash }
    this.execute = Boolean(execute);
    this.logger = logger;
    this.running = false;
  }

  /** Execute one idempotent poll-verify-payout cycle. */
  async tick(nowSec = Math.floor(Date.now() / 1000)) {
    if (this.running) return { skipped: true, processed: 0, ignored: 0, errors: [] };
    this.running = true;
    const summary = { skipped: false, processed: 0, dryRun: 0, ignored: 0, errors: [] };
    try {
      const txs = await this.tonCenter.fetchInboundTransfers(this.engine.hotWalletAddress);
      for (const tx of txs) {
        if (!tx.memo || !tx.memo.startsWith('claim:')) {
          summary.ignored += 1;
          continue;
        }
        try {
          const { claim, payoutInstruction } = this.engine.verifyInboundFeeTx(tx, nowSec);
          if (!this.execute) {
            summary.dryRun += 1;
            this.logger.log?.(`[promo-runner][DRY-RUN] Verified ${claim.claimId} -> would send ${payoutInstruction.jettonAmountRaw} raw A9 to ${payoutInstruction.recipient}`);
            continue;
          }
          if (typeof this.broadcaster !== 'function') {
            throw new Error('broadcaster callback is required when execute=true');
          }
          const sent = await this.broadcaster(payoutInstruction);
          this.engine.markPayoutCompleted(claim.claimId, sent.txHash, nowSec);
          summary.processed += 1;
          this.logger.log?.(`[promo-runner] Paid ${claim.claimId} tx=${sent.txHash} (excesses -> ${payoutInstruction.sendExcessesTo})`);
        } catch (e) {
          if (e?.code === 'REPLAY_TX' || e?.code === 'INVALID_STATE' || e?.code === 'UNKNOWN_MEMO') {
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
