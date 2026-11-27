import assert from 'node:assert/strict';
import test from 'node:test';
import { TonCenterClient } from '../src/toncenter.mjs';
import { PresaleHotWalletEngine } from '../src/presale-hotwallet.mjs';
import { D1PresaleStore } from '../src/d1-growth-store.mjs';
import { D1PromoStore } from '../src/d1-promo-store.mjs';
import { PromoPayoutRunner } from '../src/promo-runner.mjs';
import { createSqliteD1, MIGRATIONS } from './helpers/test-env.mjs';

const HOT = '0:' + '11'.repeat(32);
const USER = '0:' + '22'.repeat(32);
const NOW = 1_700_000_000;
const quiet = { log() {}, error() {} };
const payout = (kind) => ({ kind, recipient: USER, amount: '100', queryId: '42', createdAt: NOW, updatedAt: NOW });
const client = (body) => new TonCenterClient({
  apiBase: 'https://fixture.invalid/api/v2', minIntervalMs: 0, maxRetries: 0,
  fetchImpl: async () => ({ ok: true, json: async () => body }),
});

test('HTTP 200 errors, absent/wrong lists, oversized and malformed pages never become NOT_FOUND', async () => {
  for (const kind of ['A9', 'REFUND']) {
    const field = kind === 'A9' ? 'jetton_transfers' : 'messages';
    for (const body of [null, {}, { ok: false, [field]: [] }, { error: 'index unavailable', [field]: [] }, { errors: { code: 'UNAVAILABLE' }, [field]: [] },
      { success: false, result: [] }, { [field]: null, result: [] }, { [field]: {} },
      { [field]: [null] }, { [field]: [[], {}] }, { [field]: [{}, {}] }]) {
      const result = await client(body).verifyOutboundPayout(HOT, payout(kind), { nowSec: NOW + 600, limit: 1 });
      assert.equal(result.state, 'PENDING', `${kind}: ${JSON.stringify(body)}`);
    }
    assert.equal((await client({ [field]: [{}] }).verifyOutboundPayout(HOT, payout(kind), { nowSec: NOW + 600 })).state, 'PENDING');
    assert.equal((await client({ [field]: [] }).verifyOutboundPayout(HOT, payout(kind), { nowSec: NOW + 600 })).state, 'NOT_FOUND');
  }
});

test('incomplete/repeated scans and mismatched query-id records cannot authorize retry', async () => {
  const record = { query_id: '42', destination: USER, amount: '100', transaction_hash: 'tx', transaction_aborted: true };
  const c = client({ jetton_transfers: [record] });
  assert.equal((await c.verifyOutboundPayout(HOT, payout('A9'), { limit: 1, maxPages: 1, nowSec: NOW + 600 })).state, 'PENDING');
  assert.equal((await c.verifyOutboundPayout(HOT, payout('A9'), { limit: 1, maxPages: 2, nowSec: NOW + 600 })).reason, 'V3_REPEATED_PAGE');
  assert.equal((await c.verifyOutboundPayout(HOT, payout('A9'), { maxPages: 0, nowSec: NOW + 600 })).reason, 'INVALID_PAGINATION');
  assert.equal((await c.verifyOutboundPayout(HOT, payout('A9'), { nowSec: NOW + 600 })).state, 'FAILED');
  const mismatch = client({ jetton_transfers: [{ ...record, amount: '101' }] });
  assert.equal((await mismatch.verifyOutboundPayout(HOT, payout('A9'), { nowSec: NOW + 600 })).state, 'PENDING');
  const malformed = client({ jetton_transfers: [{ ...record, amount: 'invalid' }] });
  assert.equal((await malformed.verifyOutboundPayout(HOT, payout('A9'), { nowSec: NOW + 600 })).state, 'PENDING');
  const refund = { destination: USER, value: '100', bounced: true, in_msg_tx_hash: 'refund-tx', comment: 'refund:42' };
  assert.equal((await client({ messages: [refund] }).verifyOutboundPayout(HOT, payout('REFUND'), { nowSec: NOW + 600 })).state, 'FAILED');
  assert.equal((await client({ messages: [refund] }).verifyOutboundPayout(HOT, payout('REFUND'), { limit: 1, nowSec: NOW + 600 })).state, 'PENDING');
  assert.equal((await client({ messages: [{ ...refund, trace_incomplete: true }] }).verifyOutboundPayout(HOT, payout('REFUND'), { nowSec: NOW + 600 })).state, 'PENDING');
});

for (const backend of ['memory', 'sqlite']) {
 for (const kind of ['A9', 'REFUND']) {
  test(`${backend} ${kind}: uncertain broadcast is never resent for malformed, unknown, or NOT_FOUND verification`, async () => {
    const engine = backend === 'memory'
      ? new PresaleHotWalletEngine({ hotWalletAddress: HOT, open: true })
      : new D1PresaleStore({ db: createSqliteD1(MIGRATIONS), hotWalletAddress: HOT, open: true });
    const order = await engine.createOrderIntent(USER, null, NOW, { skuId: 'chest_bronze' });
    const clock = kind === 'REFUND' ? NOW + 1900 : NOW;
    await engine.ingestInbound({ txHash: 'inbound', finality: 'finalized', from: USER, to: HOT, valueNano: order.payTonNano, memo: order.memo }, clock + 1);
    await engine.queueConfirmedPayouts(clock + 2);
    let broadcasts = 0;
    const broadcaster = async () => { broadcasts += 1; throw new Error('broadcast may have landed; response lost'); };
    const broadcasters = { a9Broadcaster: broadcaster, refundBroadcaster: broadcaster };
    await engine.processPayouts(clock + 3, broadcasters);
    const [initial] = await engine.repo.listOpenPayouts();
    assert.equal(initial.ambiguous, true);
    const unknowns = [undefined, {}, { state: 'UNRECOGNIZED' }, { state: 'NOT_FOUND' },
      await client({ error: 'bad response' }).verifyOutboundPayout(HOT, payout('A9'), { nowSec: NOW + 600 })];
    for (let i = 0; i < unknowns.length; i += 1) {
      await engine.processPayouts(clock + 600 + i, { ...broadcasters, verifier: async () => unknowns[i] });
      const row = await engine.repo.getPayout(initial.payoutId);
      assert.equal(row.status, 'RETRY');
      assert.equal(row.ambiguous, true);
      assert.equal(row.queryId, initial.queryId);
      assert.equal(row.attempts, 1);
      assert.equal(broadcasts, 1);
    }
    await engine.processPayouts(clock + 4000, { ...broadcasters, verifier: async () => ({ state: 'NOT_FOUND' }) });
    assert.equal((await engine.repo.getPayout(initial.payoutId)).status, 'NEEDS_REVIEW');
    assert.equal(broadcasts, 1);
  });
 }
}

test('SQLite promo restart: ambiguous payout remains reserved, then confirms without a second broadcast', async () => {
  const db = createSqliteD1(MIGRATIONS);
  let engine = new D1PromoStore({ db, hotWalletAddress: HOT });
  await engine.creditReward(USER, '100000000000', NOW);
  const claim = await engine.createClaimIntent(USER, NOW + 1);
  await engine.verifyInboundFeeTx({ txHash: 'fee', finality: 'finalized', from: USER, to: HOT, valueNano: '60000000', memo: claim.memo }, NOW + 2);
  let broadcasts = 0;
  const broadcaster = async () => { broadcasts += 1; throw new Error('response lost after send'); };
  const tc = { fetchInboundTransfers: async () => [] };
  await new PromoPayoutRunner({ engine, tonCenter: tc, broadcaster, execute: true, logger: quiet }).tick(NOW + 3);
  let [row] = await engine.listOpenPromoPayouts();
  const originalQuery = row.queryId;
  engine = new D1PromoStore({ db, hotWalletAddress: HOT });
  for (const v of [undefined, {}, { state: 'NOT_FOUND' }, { state: 'UNKNOWN', txHash: 'untrusted' }]) {
    const runner = new PromoPayoutRunner({ engine, tonCenter: tc, broadcaster, payoutVerifier: async () => v, execute: true, logger: quiet });
    await runner.tick(NOW + 600);
    [row] = await engine.listOpenPromoPayouts();
    assert.equal(row.status, 'RETRY');
    assert.equal(row.ambiguous, true);
    assert.equal(row.attempts, 1);
    assert.equal(row.queryId, originalQuery);
    assert.equal(broadcasts, 1);
  }
  await new PromoPayoutRunner({ engine, tonCenter: tc, broadcaster, payoutVerifier: async () => ({ state: 'CONFIRMED', txHash: 'late-indexed-tx' }), execute: true, logger: quiet }).tick(NOW + 700);
  assert.equal((await engine.listOpenPromoPayouts()).length, 0);
  assert.equal((await engine.getBalance(USER)).claimableRaw, '0');
  assert.equal(broadcasts, 1);
});

test('TonCenterClient v3/v2 accepts valid uninit no_state non-bounceable credit while still rejecting real aborts/bounces', () => {
  const c = new TonCenterClient({ apiBase: 'https://fixture.invalid/api/v2', minIntervalMs: 0, maxRetries: 0 });
  const baseV3Tx = {
    lt: '112267086000003',
    hash: 'uninitCreditHash=',
    now: NOW,
    mc_block_seqno: 100470000,
    account: HOT,
    description: {
      type: 'ord',
      aborted: true,
      destroyed: false,
      credit_ph: { credit: '1050000000' },
      compute_ph: { skipped: true, reason: 'no_state' },
    },
    in_msg: {
      source: USER,
      destination: HOT,
      value: '1050000000',
      bounced: false,
      bounce: false,
      message_content: { decoded: { '@type': 'text_comment', comment: 'buy:abc123' } },
    },
  };
  const ok = c._normalizeV3InboundTx(baseV3Tx, HOT);
  assert.ok(ok, 'valid uninit no_state non-bounceable full credit must be accepted');
  assert.equal(ok.memo, 'buy:abc123');
  assert.equal(ok.valueNano, '1050000000');

  // 任何安全条件不满足时继续 fail-closed 拒绝
  assert.equal(c._normalizeV3InboundTx({ ...baseV3Tx, in_msg: { ...baseV3Tx.in_msg, bounce: true } }, HOT), null);
  assert.equal(c._normalizeV3InboundTx({ ...baseV3Tx, in_msg: { ...baseV3Tx.in_msg, bounced: true } }, HOT), null);
  assert.equal(c._normalizeV3InboundTx({ ...baseV3Tx, description: { ...baseV3Tx.description, bounce: { type: 'ok' } } }, HOT), null);
  assert.equal(c._normalizeV3InboundTx({ ...baseV3Tx, description: { ...baseV3Tx.description, credit_ph: { credit: '1049999999' } } }, HOT), null);
  assert.equal(c._normalizeV3InboundTx({ ...baseV3Tx, description: { ...baseV3Tx.description, compute_ph: { skipped: false, exit_code: 33 } } }, HOT), null);
  assert.equal(c._normalizeV3InboundTx({ ...baseV3Tx, description: { ...baseV3Tx.description, destroyed: true } }, HOT), null);
});
