#!/usr/bin/env node
// Phase 1 — reproductions of defects found in acceptance review round 2 (code at ae5fd0c).
// Read-only: uses in-memory stores and throwaway SQLite databases, touches no real data.
// Run from the repo root:  node docs/gamification/phase-1-defect-repro.mjs   (Node >= 22.5)
// Each line prints CONFIRMED (defect present) or NOT REPRODUCED (expected after a fix).
// After fixes land, every line must print NOT REPRODUCED, and the cases must also exist as
// regular tests under worker/tests/.
import { readFileSync } from 'node:fs';
import { PresaleHotWalletEngine } from '../../worker/src/presale-hotwallet.mjs';
import { PresalePayoutRunner } from '../../worker/src/presale-runner.mjs';
import { D1PresaleStore } from '../../worker/src/d1-growth-store.mjs';
import { decodeAddressFromCellBoc, encodeAddressSliceBoc } from '../../worker/src/toncenter.mjs';
import { createSqliteD1, FRESH_SCHEMA, MIGRATIONS, completePurchase } from '../../worker/tests/helpers/test-env.mjs';

const HOT = 'EQ_HOT';
const settle = { a9Broadcaster: async () => ({ txHash: 'a9-out' }), refundBroadcaster: async () => ({ txHash: 'refund-out' }), verifier: async () => ({ state: 'CONFIRMED' }) };
const backends = [
  ['memory', () => new PresaleHotWalletEngine({ hotWalletAddress: HOT })],
  ['d1-sqlite', () => new D1PresaleStore({ db: createSqliteD1(FRESH_SCHEMA), hotWalletAddress: HOT })],
];
const report = (id, backend, defect, detail) => console.log(`${defect ? 'CONFIRMED     ' : 'NOT REPRODUCED'}  ${id} [${backend}] ${detail}`);

for (const [name, make] of backends) {
  // D1: B pays with A's memo; refunding B must not touch A's order.
  {
    const e = make();
    const a = await e.createOrderIntent('EQ_A', '10', 1000);
    await e.ingestInbound({ txHash: 'b-pay', finality: 'finalized', to: HOT, from: 'EQ_B', valueNano: a.tonNano, memo: a.memo }, 1001);
    await e.resolveAnomaly('b-pay', { decision: 'REFUND', faultParty: 'UNKNOWN', operator: 'ops' }, 1002);
    await e.processPayouts(1003, settle);
    await e.processPayouts(1004, settle);
    const st = (await e.getOrder(a.orderId)).status;
    report('D1', name, st !== 'PENDING_PAYMENT', `A's untouched order after B's refund = ${st}`);
  }
  // D2: duplicate payment after COMPLETED; refunding the duplicate must not change the completed order.
  {
    const e = make();
    const o = await completePurchase(e, 'EQ_A', '5', 1000, { txHash: 'first' });
    await e.ingestInbound({ txHash: 'dup', finality: 'finalized', to: HOT, from: 'EQ_A', valueNano: o.tonNano, memo: o.memo }, 1100);
    await e.resolveAnomaly('dup', { decision: 'REFUND', faultParty: 'UNKNOWN', operator: 'ops' }, 1101);
    await e.processPayouts(1102, settle);
    await e.processPayouts(1103, settle);
    const st = (await e.getOrder(o.orderId)).status;
    report('D2', name, st !== 'COMPLETED', `delivered order after duplicate refund = ${st}; activation eligibility = ${await e.hasCompletedPurchase('EQ_A')}`);
  }
  // D4: two different wrong payers on one order; both refunds must be resolvable.
  {
    const e = make();
    const o = await e.createOrderIntent('EQ_A', '10', 1000);
    await e.ingestInbound({ txHash: 's1', finality: 'finalized', to: HOT, from: 'EQ_B', valueNano: o.tonNano, memo: o.memo }, 1001);
    await e.ingestInbound({ txHash: 's2', finality: 'finalized', to: HOT, from: 'EQ_C', valueNano: o.tonNano, memo: o.memo }, 1002);
    const out = [];
    for (const t of ['s1', 's2']) {
      try { out.push((await e.resolveAnomaly(t, { decision: 'REFUND', faultParty: 'UNKNOWN', operator: 'ops' }, 1003)).status); } catch (x) { out.push(`ERR ${x.code}`); }
    }
    report('D4', name, out.some((s) => s.startsWith('ERR')), `two anomalies on one order -> ${out.join(', ')}`);
  }
}

// D3: real listener path. A transfer without a "buy:" memo must be recorded as an anomaly.
{
  const e = new PresaleHotWalletEngine({ hotWalletAddress: HOT });
  const runner = new PresalePayoutRunner({
    engine: e,
    tonCenter: { fetchInboundTransfers: async () => [{ txHash: 'nomemo', finality: 'finalized', to: HOT, from: 'EQ_C', valueNano: '7000000000', memo: '' }] },
    execute: true,
    a9Broadcaster: async () => ({ txHash: 'x' }),
    logger: { log() {} },
  });
  await runner.tick(2000);
  const n = (await e.listAnomalies(null)).length;
  report('D3', 'runner', n === 0, `7 GRAM transfer without memo -> anomalies recorded = ${n}`);
}

// D5: legacy order stored with a real friendly address must stay visible and count against quota.
{
  const friendly = decodeAddressFromCellBoc(encodeAddressSliceBoc(`0:${'ab'.repeat(32)}`));
  const db = createSqliteD1([MIGRATIONS[0]]);
  await db.prepare(`INSERT INTO presale_orders (order_id, wallet_address, referrer_id, ton_nano, a9_amount_raw, memo, status, inbound_tx_hash, payout_tx_hash, refund_ton_nano, created_at, updated_at)
    VALUES ('L1', ?, NULL, '195000000000', '1', 'buy:L1', 'PAID_A9', 'in', 'out', '0', 1, 1)`).bind(friendly).run();
  for (const m of MIGRATIONS.slice(1)) db.exec(readFileSync(new URL(m, new URL('../../worker/tests/helpers/test-env.mjs', import.meta.url)), 'utf8'));
  const e = new D1PresaleStore({ db, hotWalletAddress: HOT });
  const visible = (await e.listOrders(friendly)).length;
  const used = (await e.getQuota(friendly, 100)).usedQuotaTon;
  let code = 'ACCEPTED';
  try { await e.createOrderIntent(friendly, '10', 100); } catch (x) { code = x.code; }
  report('D5', 'd1-sqlite', visible === 0 || used === 0 || code !== 'OVER_QUOTA', `legacy order visible = ${visible}, quota used = ${used} GRAM, new over-quota order -> ${code}`);
}

// D6: the exchange must be closed server-side unless explicitly opened.
{
  const open = new PresaleHotWalletEngine({ hotWalletAddress: HOT }).open;
  const cf = readFileSync(new URL('../../worker/src/cf-worker.mjs', import.meta.url), 'utf8');
  const passes = /presaleOpts\s*=\s*\{[^}]*\bopen\s*:/s.test(cf);
  report('D6', 'config', open === true && !passes, `engine.open default = ${open}; cf-worker sets open explicitly = ${passes}`);
}
