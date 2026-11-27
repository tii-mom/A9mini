#!/usr/bin/env node
// A9 Protocol v15 — Worker & Promo Hot-Wallet Engine Unit Tests (zero external deps).
import assert from 'node:assert/strict';
import { deriveRoundStage, mapV15RoundDetail } from '../src/v15-indexer.mjs';
import { PromoHotWalletEngine, CLAIM_STATUS } from '../src/promo-hotwallet.mjs';
import { D1PromoStore } from '../src/d1-promo-store.mjs';
import { PromoPayoutRunner } from '../src/promo-runner.mjs';
import { PredictionEngine } from '../src/growth-engine.mjs';
import { D1PresaleStore, D1SocialStore } from '../src/d1-growth-store.mjs';
import { SocialStore } from '../src/social-store.mjs';
import { TonCenterClient } from '../src/toncenter.mjs';
import { createApiRouter } from '../src/api.mjs';
import { MemoryIdentityStore } from '../src/auth.mjs';
import { TEST_BOT_TOKEN, tgHeaders, createSqliteD1, FRESH_SCHEMA, MIGRATIONS, dumpDb, completePurchase } from './helpers/test-env.mjs';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

console.log('Running A9 v15 worker unit tests...');

await test('v15 round stage derives STAKING_OPEN -> OBSERVING -> SUCCEEDED without CloseStaking/Settling', () => {
  const rd = { status: 1, stakeOpenAt: 1000, stakeCloseAt: 2000 };
  assert.equal(deriveRoundStage(rd, 1500, 600).state, 'STAKING_OPEN');
  assert.equal(deriveRoundStage(rd, 2100, 600).state, 'OBSERVING');
  assert.equal(deriveRoundStage(rd, 2700, 600).nextState, 'AWAITING_SETTLE');
  assert.equal(deriveRoundStage({ status: 2, stakeOpenAt: 1000, stakeCloseAt: 2000 }, 3000, 600).state, 'SUCCEEDED');
});

await test('promo hot-wallet full flow: 0.06 TON fee -> finalized verify -> TEP-74 payout with excesses back to hot wallet', () => {
  const HOT = 'EQ_PROMO_HOT_WALLET_DEMO';
  const USER = 'EQ_USER_ALICE_DEMO';
  const A9 = 1_000_000_000n;
  const engine = new PromoHotWalletEngine({ hotWalletAddress: HOT });
  engine.creditReward(USER, 50_000n * A9);

  const intent = engine.createClaimIntent(USER, 10_000);
  assert.equal(intent.status, CLAIM_STATUS.PENDING_FEE);
  assert.equal(intent.feeRequiredNano, '60000000');
  assert.equal(intent.payTo, HOT);
  assert.ok(intent.memo.startsWith('claim:'));

  // Reject unfinalized tx
  assert.throws(() => engine.verifyInboundFeeTx({
    txHash: 'tx-unfinalized', finality: 'confirmed', to: HOT, from: USER, valueNano: '60000000', memo: intent.memo,
  }, 10_010));

  // Reject wrong payer (non-matching sender wallet)
  assert.throws(() => engine.verifyInboundFeeTx({
    txHash: 'tx-wrong-payer', finality: 'finalized', to: HOT, from: 'EQ_STRANGER_WALLET', valueNano: '60000000', memo: intent.memo,
  }, 10_010), { code: 'WRONG_PAYER' });

  // Reject underpaid fee (< 0.06 TON)
  assert.throws(() => engine.verifyInboundFeeTx({
    txHash: 'tx-low', finality: 'finalized', to: HOT, from: USER, valueNano: '50000000', memo: intent.memo,
  }, 10_010));

  // Valid finalized 0.06 TON fee -> generates TEP-74 transfer with sendExcessesTo = HOT
  const res = engine.verifyInboundFeeTx({
    txHash: 'tx-ok-1', finality: 'finalized', to: HOT, from: USER, valueNano: '60000000', memo: intent.memo,
  }, 10_020);
  assert.equal(res.claim.status, CLAIM_STATUS.FEE_CONFIRMED);
  assert.equal(res.payoutInstruction.recipient, USER);
  assert.equal(res.payoutInstruction.jettonAmountRaw, String(50_000n * A9));
  assert.equal(res.payoutInstruction.sendExcessesTo, HOT);
  assert.equal(engine.getBalance(USER).claimableRaw, '0');

  // Strict anti-replay on same txHash
  assert.throws(() => engine.verifyInboundFeeTx({
    txHash: 'tx-ok-1', finality: 'finalized', to: HOT, from: USER, valueNano: '60000000', memo: intent.memo,
  }, 10_030));

  const done = engine.markPayoutCompleted(intent.claimId, 'tx-payout-1', 10_040);
  assert.equal(done.status, CLAIM_STATUS.COMPLETED);
  assert.equal(done.payoutTxHash, 'tx-payout-1');
});

await test('API router serves /api/health, /api/config, /api/rounds/:id, and authenticated /api/promo/intent', async () => {
  const HOT = 'EQ_PROMO_HOT_WALLET_DEMO';
  const USER = 'EQ_USER_BOB_DEMO';
  const promoEngine = new PromoHotWalletEngine({ hotWalletAddress: HOT });
  promoEngine.creditReward(USER, '12000000000000');

  const stateStore = {
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ({ currentRoundId: 1, successCount: 0, poolRemainingRaw: '6300000000000000000', carryRaw: '0' }),
    listRounds: () => [{ roundId: 1, round: { status: 1, targetPriceUsdE8: '232000', twap24hUsdE8: '116000', stakeOpenAt: 1000, stakeCloseAt: 5000, rewardBudgetRaw: '700000000000000000' }, candles: [] }],
    getRound: (id) => (id === 1 ? { roundId: 1, round: { status: 1, targetPriceUsdE8: '232000', twap24hUsdE8: '116000', stakeOpenAt: 1000, stakeCloseAt: 5000, rewardBudgetRaw: '700000000000000000' }, candles: [] } : null),
  };
  const identityStore = new MemoryIdentityStore();
  await identityStore.bindWallet('501', USER, 1000);
  const route = createApiRouter({ env: { A9_NETWORK: 'testnet', A9_PROMO_HOT_WALLET_ADDRESS: HOT, A9_BOT_TOKEN: TEST_BOT_TOKEN }, stateStore, promoEngine, identityStore });

  const h = await route({ method: 'GET', pathname: '/api/health' });
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);

  const cfg = await route({ method: 'GET', pathname: '/api/config' });
  assert.equal(cfg.body.data.protocolVersion, 'v17');
  assert.equal(cfg.body.data.openEnded, true);
  assert.equal(cfg.body.data.promoHotWallet.userFeeTon, '0.06');

  const r1 = await route({ method: 'GET', pathname: '/api/rounds/1', nowSec: 2000 });
  assert.equal(r1.body.data.state, 'STAKING_OPEN');

  // Without verified Telegram identity the private promo intent is refused (was: open to anyone).
  const anon = await route({ method: 'POST', pathname: '/api/promo/intent', body: { walletAddress: USER }, nowSec: 2000 });
  assert.equal(anon.status, 401);

  const intent = await route({ method: 'POST', pathname: '/api/promo/intent', body: {}, headers: await tgHeaders(501, { nowSec: 2000 }), nowSec: 2000 });
  assert.equal(intent.status, 200);
  assert.equal(intent.body.data.payTo, HOT);
  assert.equal(intent.body.data.feeRequiredNano, '60000000');
});

await test('TonCenterClient parses v15 get_protocol_state, get_round, and finalized inbound txs', async () => {
  const { TonCenterClient } = await import('../src/toncenter.mjs');
  const mockFetch = async (url, opts) => {
    if (url.endsWith('/runGetMethod')) {
      const req = JSON.parse(opts.body);
      if (req.method === 'get_protocol_state') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: {
              exit_code: 0,
              stack: [
                ['num', '0x2'], ['num', '0x1'], ['num', '0x100'], ['num', '0x10'],
                ['num', '0x200'], ['num', '0x20'], ['num', '0x3e8'], ['num', '0x0'], ['num', '0x1'],
              ],
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            exit_code: 0,
            stack: Array.from({ length: 17 }, (_, i) => ['num', `0x${(i + 1).toString(16)}`]),
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        result: [{
          transaction_id: { hash: 'tc-hash-1' },
          utime: 5000,
          in_msg: { source: 'EQ_USER_1', value: '60000000', message: 'claim:abc123' },
        }],
      }),
    };
  };

  const tc = new TonCenterClient({ apiBase: 'http://mock-toncenter.local', fetchImpl: mockFetch });
  const ps = await tc.fetchProtocolState('EQ_RC');
  assert.equal(ps.currentRoundId, 2);
  assert.equal(ps.successCount, 1);
  assert.equal(ps.poolRemainingRaw, '256');

  const rd = await tc.fetchRound('EQ_RC', 2);
  assert.equal(rd.status, 1);
  assert.equal(rd.stakeCount, 17);

  const txs = await tc.fetchInboundTransfers('EQ_HOT');
  assert.equal(txs.length, 1);
  assert.equal(txs[0].memo, 'claim:abc123');
  assert.equal(txs[0].valueNano, '60000000');
});

await test('PromoPayoutRunner polls 0.06 TON inbound fee, pays A9 with excesses to hot wallet, and ignores replays', async () => {
  const { PromoPayoutRunner } = await import('../src/promo-runner.mjs');
  const HOT = 'EQ_PROMO_HOT';
  const USER = 'EQ_USER_CAROL';
  const engine = new PromoHotWalletEngine({ hotWalletAddress: HOT });
  engine.creditReward(USER, '25000000000000');
  const intent = engine.createClaimIntent(USER, 1000);

  const fakeTonCenter = {
    fetchInboundTransfers: async () => [
      { txHash: 'fee-tx-1', finality: 'finalized', to: HOT, from: USER, valueNano: '60000000', memo: intent.memo },
      { txHash: 'stray-tx', finality: 'finalized', to: HOT, from: USER, valueNano: '10000000', memo: 'hello' },
    ],
  };

  const sentPayouts = [];
  const runner = new PromoPayoutRunner({
    engine,
    tonCenter: fakeTonCenter,
    execute: true,
    broadcaster: async (inst) => {
      sentPayouts.push(inst);
      return { txHash: 'payout-tx-1' };
    },
    logger: { log: () => {} },
  });

  const s1 = await runner.tick(1010);
  assert.equal(s1.processed, 1);
  assert.equal(s1.ignored, 1);
  assert.equal(sentPayouts.length, 1);
  assert.equal(sentPayouts[0].recipient, USER);
  assert.equal(sentPayouts[0].sendExcessesTo, HOT);
  assert.equal(engine.getClaim(intent.claimId).status, CLAIM_STATUS.COMPLETED);

  const s2 = await runner.tick(1020);
  assert.equal(s2.processed, 0);
  assert.equal(s2.ignored, 2);
});

await test('createActonPromoBroadcaster passes --net and parses PROMO_PAYOUT_TX cleanly', async () => {
  const { createActonPromoBroadcaster } = await import('../src/acton-broadcaster.mjs');
  let captured = null;
  const broadcast = createActonPromoBroadcaster({
    network: 'testnet',
    hotWalletName: 'promoHotWallet',
    expectedHotWalletAddress: 'kQ_EXPECTED_HOT',
    jettonMasterAddress: 'EQ_MASTER_DEMO',
    baseEnv: { TONCENTER_API_KEY: 'key_t_999' },
    spawnImpl: (cmd, args, opts) => {
      captured = { cmd, args, env: opts.env };
      return { status: 0, stdout: 'PROMO_PAYOUT_TX=0xdeadbeef1234\n', stderr: '' };
    },
  });
  const res = await broadcast({
    recipient: 'EQ_USER_1',
    jettonAmountRaw: '5000000000000',
    attachedTonNano: '50000000',
  });
  assert.equal(captured.cmd, 'acton');
  assert.deepEqual(captured.args, ['script', '--net', 'testnet', '../ops/tolk/promo_payout_v15.tolk']);
  assert.equal(captured.env.A9_PAYOUT_RECIPIENT, 'EQ_USER_1');
  assert.equal(captured.env.A9_EXPECTED_HOT_WALLET_ADDRESS, 'kQ_EXPECTED_HOT');
  assert.equal(captured.env.TONCENTER_TESTNET_API_KEY, 'key_t_999');
  assert.equal(res.txHash, `0x${'deadbeef1234'.padStart(64, '0')}`);

  const preFailBc = createActonPromoBroadcaster({
    network: 'testnet',
    hotWalletName: 'promoHotWallet',
    jettonMasterAddress: 'EQ_MASTER_DEMO',
    spawnImpl: () => ({ status: 1, stdout: '', stderr: 'Assert failed: insufficient hot wallet balance' }),
  });
  await assert.rejects(
    () => preFailBc({ recipient: 'EQ_USER_1', jettonAmountRaw: '1000', attachedTonNano: '50000000' }),
    (e) => e.notSent === true,
  );
});

await test('PresaleHotWalletEngine handles valid fill, passive free refund, no-order anomaly (no auto fee), and dust ignore', async () => {
  const { PresaleHotWalletEngine, PRESALE_STATUS } = await import('../src/presale-hotwallet.mjs');
  const HOT = 'EQ_PRESALE_HOT';
  const ALICE = 'EQ_ALICE';
  const engine = new PresaleHotWalletEngine({ hotWalletAddress: HOT, rateA9PerTon: 2000n, minOrderTon: 5n, maxOrderTon: 200n, defaultQuotaTon: 100n, open: true });

  const order = await engine.createOrderIntent(ALICE, null, 1000, { skuId: 'chest_gold' });
  assert.equal(order.status, PRESALE_STATUS.PENDING_PAYMENT);
  assert.equal(order.tonNano, '9990000000');
  assert.equal(order.deliveryFeeNano, '60000000');
  assert.equal(order.payTonNano, '10050000000');

  // Valid 10.05 GRAM (9.99 GRAM chest_gold + 0.06 GRAM delivery gas) finalized -> PAYMENT_CONFIRMED -> queued 17,500 A9 (+bonus) payout with excesses back to HOT
  const fill = await engine.ingestInbound({ txHash: 'p1', finality: 'finalized', to: HOT, from: ALICE, valueNano: order.payTonNano, memo: order.memo }, 1010);
  assert.equal(fill.action, 'CONFIRM');
  assert.equal((await engine.getOrder(order.orderId)).status, PRESALE_STATUS.PAYMENT_CONFIRMED);
  assert.equal(await engine.queueConfirmedPayouts(1011), 1);
  assert.equal((await engine.getOrder(order.orderId)).status, PRESALE_STATUS.PAYOUT_PENDING);
  const [payout] = await engine.repo.listOpenPayouts();
  const inst = engine.buildInstruction(payout);
  assert.ok(BigInt(inst.jettonAmountRaw) >= 17500000000000n && BigInt(inst.jettonAmountRaw) <= 25000000000000n);
  assert.equal(inst.sendExcessesTo, HOT);

  // Dust <= 0.1 GRAM ignored
  const dust = await engine.ingestInbound({ txHash: 'p2', finality: 'finalized', to: HOT, from: ALICE, valueNano: '100000000', memo: '' }, 1020);
  assert.equal(dust.action, 'IGNORE_DUST');

  // No matching order -> recorded as an ANOMALY for review: no auto payout; refund deducts 0.03 GRAM on-chain refund gas.
  const fault = await engine.ingestInbound({ txHash: 'p3', finality: 'finalized', to: HOT, from: ALICE, valueNano: '95000000000', memo: '' }, 1030);
  assert.equal(fault.action, 'ANOMALY');
  assert.equal(fault.reason, 'no_matching_order');
  assert.equal((await engine.repo.listOpenPayouts()).length, 1); // only the A9 payout above
  const [anomaly] = await engine.listAnomalies();
  assert.equal(anomaly.refundTo, ALICE);
  assert.equal(anomaly.valueNano, '95000000000');
  const resolved = await engine.resolveAnomaly('p3', { decision: 'REFUND', faultParty: 'USER', operator: 'ops1' }, 1032);
  assert.equal(resolved.refundNano, '94970000000');
  assert.equal(resolved.feeNano, '30000000');

  // Passive refund (closed) -> deducts 0.03 GRAM on-chain refund gas so hot wallet bears 0 gas
  const order2 = await engine.createOrderIntent(ALICE, null, 1035, { skuId: 'chest_silver' });
  engine.open = false;
  const passive = await engine.ingestInbound({ txHash: 'p4', finality: 'finalized', to: HOT, from: ALICE, valueNano: order2.payTonNano, memo: order2.memo }, 1040);
  assert.equal(passive.action, 'REFUND');
  assert.equal(passive.refundNano, 5020000000n);
  assert.equal(passive.feeDeducted, true);
  assert.equal((await engine.getOrder(order2.orderId)).status, PRESALE_STATUS.REFUND_PENDING);
});

await test('SocialStore handles warmup registration, invite leaderboard, and captain TG-group binding', async () => {
  const { SocialStore } = await import('../src/social-store.mjs');
  const social = new SocialStore();
  social.registerWarmup({ roundId: 1, walletAddress: 'EQ_CAP' }, 100);
  social.registerWarmup({ roundId: 1, walletAddress: 'EQ_M1', referrerWallet: 'EQ_CAP' }, 101);
  social.registerWarmup({ roundId: 1, walletAddress: 'EQ_M2', referrerWallet: 'EQ_CAP' }, 102);

  const board = social.getWarmupLeaderboard(1);
  assert.equal(board[0].walletAddress, 'EQ_CAP');
  assert.equal(board[0].validInvites, 2);
  assert.equal(board[0].estRewardA9, 400000);

  const team = social.createOrBindTeamGroup({ teamId: 'TM-01', name: 'Alpha', captainWallet: 'EQ_CAP', tgGroupHandle: '@a9_alpha' }, 200);
  // A typed @handle is NOT proof of a real group: status stays 'verifying' until server-side check (phase 6).
  assert.equal(team.bindStatus, 'verifying');
  social.joinTeam({ teamId: 'TM-01', walletAddress: 'EQ_M1' }, 201);
  assert.equal(social.getTeamByWallet('EQ_M1').memberCount, 2);
});

await test('PredictionEngine settles PASS/BURN with 1.5x exact-slot boost and activates into promoEngine', async () => {
  const { PredictionEngine } = await import('../src/growth-engine.mjs');
  const pred = new PredictionEngine({ defaultPoolA9Raw: '25000000000000' });
  const promo = new PromoHotWalletEngine({ hotWalletAddress: 'EQ_HOT' });

  pred.placeBet({ roundId: 1, userId: 'tg_alice', side: 'PASS', guessSlots: 10 }, 100);
  pred.placeBet({ roundId: 1, userId: 'tg_bob', side: 'PASS', guessSlots: 8 }, 101);
  pred.placeBet({ roundId: 1, userId: 'tg_carol', side: 'BURN' }, 102);

  const stats = pred.getRoundStats(1);
  assert.equal(stats.passCount, 2);
  assert.equal(stats.burnCount, 1);

  const settled = await pred.settleRoundBets(1, true, 10);
  assert.equal(settled.winnersCount, 2);
  // M-3 动态奖池：3 注 × 800 A9 = 2,400 A9；权重 15:10 -> 1,440 A9 / 960 A9
  assert.equal(pred.getUserSummary('tg_alice', 1).pendingActivationRaw, '1440000000000');
  assert.equal(pred.getUserSummary('tg_bob', 1).pendingActivationRaw, '960000000000');

  const act = pred.activateToPromo('tg_alice', 'EQ_ALICE_WALLET', promo, { qualified: true });
  assert.equal(act.activatedRaw, '1440000000000');
  assert.equal(promo.getBalance('EQ_ALICE_WALLET').claimableRaw, '1440000000000');
});

await test('Dynamic OG card routes /c/round/1 and /c/img/burn/2.svg render valid HTML & SVG', async () => {
  const { PredictionEngine } = await import('../src/growth-engine.mjs');
  const stateStore = {
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ({ currentRoundId: 2, successCount: 1 }),
    listRounds: () => [],
    getRound: (id) => ({ roundId: id, round: { status: 3, targetPriceUsdE8: '232000', twap24hUsdE8: '116000', qualifiedCandles: 10, stakeOpenAt: 100, stakeCloseAt: 200 }, candles: [] }),
  };
  const route = createApiRouter({ env: { A9_PUBLIC_ORIGIN: 'http://a9-local.test', A9_TG_BOT_HANDLE: 'A9Bot' }, stateStore, predictionEngine: new PredictionEngine() });

  const page = await route({ method: 'GET', pathname: '/c/burn/2', query: { ref: 'u42' } });
  assert.equal(page.status, 200);
  assert.ok(page.rawBody.includes('twitter:card'));
  assert.ok(page.rawBody.includes('startapp=burn_2_u42'));

  const svg = await route({ method: 'GET', pathname: '/c/img/burn/2.svg' });
  assert.equal(svg.status, 200);
  assert.ok(svg.rawBody.includes('<svg'));
  assert.ok(svg.rawBody.includes('AUTO STOP-LOSS · 95%/90% REFUND'));
  assert.ok(svg.rawBody.includes('8 / 12 HOURLY SLOTS TO PASS'));
});

await test('TonCenterClient encodes/decodes TON address BOC and reads user JettonWallet + StakeTicket', async () => {
  const { TonCenterClient, encodeAddressSliceBoc, decodeAddressFromCellBoc } = await import('../src/toncenter.mjs');
  const rawAddr = '0:1111111111111111111111111111111111111111111111111111111111111111';
  const boc = encodeAddressSliceBoc(rawAddr);
  const decoded = decodeAddressFromCellBoc(boc);
  assert.ok(decoded && decoded.startsWith('EQ'));
  // Round-trip stability: friendly -> BOC -> friendly
  assert.equal(decodeAddressFromCellBoc(encodeAddressSliceBoc(decoded)), decoded);

  const mockFetch = async (_url, opts) => {
    const req = JSON.parse(opts.body);
    if (req.method === 'get_wallet_address') {
      return { ok: true, json: async () => ({ ok: true, result: { exit_code: 0, stack: [['cell', { bytes: boc }]] } }) };
    }
    if (req.method === 'get_wallet_data') {
      return { ok: true, json: async () => ({ ok: true, result: { exit_code: 0, stack: [['num', '0x174876e800']] } }) }; // 100 A9
    }
    if (req.method === 'get_ticket_address') {
      return { ok: true, json: async () => ({ ok: true, result: { exit_code: 0, stack: [['cell', { bytes: boc }]] } }) };
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          exit_code: 0,
          stack: [
            ['cell', { bytes: boc }], ['cell', { bytes: boc }],
            ['num', '0x1'], ['num', '0x9184e72a000'], ['num', '0x12309ce54000'],
            ['num', '-0x1'], ['num', '-0x1'], ['num', '0x0'], ['num', '0x0'],
          ],
        },
      }),
    };
  };

  const tc = new TonCenterClient({ apiBase: 'http://mock-toncenter.local', fetchImpl: mockFetch, minIntervalMs: 0 });
  const pf = await tc.fetchUserPortfolio(rawAddr, {
    jettonMasterAddress: decoded,
    roundControllerAddress: decoded,
    roundIds: [1],
  });
  assert.equal(pf.jettonWallet, decoded);
  assert.equal(pf.a9BalanceRaw, '100000000000');
  assert.equal(pf.tickets.length, 1);
  assert.equal(pf.tickets[0].roundId, 1);
  assert.equal(pf.tickets[0].principalDone, true);
  assert.equal(pf.tickets[0].immediateClaimed, true);
});

await test('PresalePayoutRunner polls buy:<id> finalized GRAM, broadcasts A9 payout, confirms, and ignores replays', async () => {
  const { PresaleHotWalletEngine, PRESALE_STATUS } = await import('../src/presale-hotwallet.mjs');
  const { PresalePayoutRunner } = await import('../src/presale-runner.mjs');
  const HOT = 'EQ_PRESALE_HOT_RUNNER';
  const USER = 'EQ_BUYER_DAVE';
  const engine = new PresaleHotWalletEngine({ hotWalletAddress: HOT, rateA9PerTon: 2002n, minOrderTon: 1n, open: true });
  const order = await engine.createOrderIntent(USER, null, 2000, { skuId: 'chest_bronze' });

  const fakeTc = {
    fetchInboundTransfers: async () => [
      { txHash: 'buy-tx-1', finality: 'finalized', to: HOT, from: USER, valueNano: order.payTonNano, memo: order.memo },
      { txHash: 'other-tx', finality: 'finalized', to: HOT, from: USER, valueNano: '60000000', memo: 'claim:xyz' },
    ],
  };

  const sent = [];
  const runner = new PresalePayoutRunner({
    engine,
    tonCenter: fakeTc,
    execute: true,
    a9Broadcaster: async (inst) => {
      sent.push(inst);
      return { txHash: 'a9-presale-tx-1' };
    },
    payoutVerifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }),
    logger: { log: () => {} },
  });

  const s1 = await runner.tick(2010);
  assert.equal(s1.paid, 1);
  assert.equal(s1.ignored, 1);
  assert.equal(s1.completed, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipient, USER);
  assert.ok(BigInt(sent[0].jettonAmountRaw) >= 1500000000000n && BigInt(sent[0].jettonAmountRaw) <= 2500000000000n);
  assert.equal(sent[0].sendExcessesTo, HOT);
  const updated = (await engine.listOrders(USER))[0];
  assert.equal(updated.status, PRESALE_STATUS.COMPLETED);
  assert.equal(updated.payoutTxHash, 'a9-presale-tx-1');

  const s2 = await runner.tick(2020);
  assert.equal(s2.paid, 0);
  assert.equal(s2.ignored, 2);
  assert.equal(sent.length, 1);
});

await test('First-touch referral binding blocks self/mutual invites and credits 12% presale commission only after confirmed payout', async () => {
  const { SocialStore } = await import('../src/social-store.mjs');
  const { PresaleHotWalletEngine } = await import('../src/presale-hotwallet.mjs');
  const HOT = 'EQ_PRESALE_HOT_REF';
  const REF = 'EQ_REFERRER_A';
  const BUYER = 'EQ_BUYER_B';
  const OTHER = 'EQ_REFERRER_C';

  const social = new SocialStore();
  const promo = new PromoHotWalletEngine({ hotWalletAddress: HOT });
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT, rateA9PerTon: 2000n, minOrderTon: 5n, open: true, promoEngine: promo, socialStore: social });

  // Self-referral rejected
  assert.equal(social.bindReferral(BUYER, BUYER, 100), null);
  // First-touch bound A -> B
  assert.equal(social.bindReferral(BUYER, REF, 101).referrerId, REF);
  // Cannot overwrite first-touch with C
  assert.equal(social.bindReferral(BUYER, OTHER, 102).referrerId, REF);
  assert.equal(social.getReferrer(BUYER), REF);
  // Mutual cycle B -> A rejected
  assert.equal(social.bindReferral(REF, BUYER, 103), null);
  assert.equal(social.getReferrer(REF), null);

  // Presale chest_gold (9.99 GRAM -> 17,500 base A9) -> M-4 6% = 1,050 A9, booked only after the payout is confirmed.
  const order = await presale.createOrderIntent(BUYER, null, 200, { skuId: 'chest_gold', referrerId: social.getReferrer(BUYER) });
  await presale.ingestInbound({ txHash: 'ref-buy-1', finality: 'finalized', to: HOT, from: BUYER, valueNano: order.payTonNano, memo: order.memo }, 210);
  await presale.queueConfirmedPayouts(211);
  await presale.processReferralCredits(211);
  assert.equal(promo.getBalance(REF).claimableRaw, '0');
  await presale.processPayouts(212, { a9Broadcaster: async () => ({ txHash: 'ref-pay-1' }), verifier: async () => ({ state: 'CONFIRMED' }) });
  await presale.processReferralCredits(213);
  assert.equal(promo.getBalance(REF).claimableRaw, '1050000000000');
  await presale.processReferralCredits(214);
  assert.equal(promo.getBalance(REF).claimableRaw, '1050000000000');
});

await test('POST /api/prediction/activate enforces anti-sybil capital check and voucher expiry', async () => {
  const { PredictionEngine } = await import('../src/growth-engine.mjs');
  const { PresaleHotWalletEngine } = await import('../src/presale-hotwallet.mjs');
  const HOT = 'EQ_HOT_ACT';
  const WALLET = 'EQ_USER_ACT';
  const WALLET2 = 'EQ_USER_ACT_2';
  const pred = new PredictionEngine({ defaultPoolA9Raw: '10000000000000' });
  const promo = new PromoHotWalletEngine({ hotWalletAddress: HOT });
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT, rateA9PerTon: 2000n, minOrderTon: 5n, open: true });
  const stateStore = {
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ({ currentRoundId: 1, successCount: 0 }),
    listRounds: () => [],
    getRound: () => null,
  };
  const identityStore = new MemoryIdentityStore();
  await identityStore.bindWallet('3001', WALLET, 1000);
  await identityStore.bindWallet('3002', WALLET2, 1000);
  const route = createApiRouter({ env: { A9_BOT_TOKEN: TEST_BOT_TOKEN }, stateStore, promoEngine: promo, presaleEngine: presale, predictionEngine: pred, identityStore });

  pred.placeBet({ roundId: 1, userId: '3001', side: 'PASS' }, 1000);
  await pred.settleRoundBets(1, true, 18, '10000000000000', 1_000_000);

  // 1) No completed exchange order & no stake ticket -> 400 ACTIVATION_REQUIREMENT_UNMET
  const denied = await route({ method: 'POST', pathname: '/api/prediction/activate', body: {}, headers: await tgHeaders(3001, { nowSec: 1100 }), nowSec: 1100 });
  assert.equal(denied.status, 400);
  assert.equal(denied.body.error.code, 'ACTIVATION_REQUIREMENT_UNMET');

  // 2) Complete 1 order (payout confirmed) -> activation succeeds & credits promoEngine (M-3: 1 bet = 800 A9)
  await completePurchase(presale, WALLET, '4.99', 1100);
  const okRes = await route({ method: 'POST', pathname: '/api/prediction/activate', body: {}, headers: await tgHeaders(3001, { nowSec: 1110 }), nowSec: 1110 });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.data.activatedRaw, '800000000000');
  assert.equal(promo.getBalance(WALLET).claimableRaw, '800000000000');

  // 3) Expired voucher -> 400 VOUCHER_EXPIRED and pending balance cleared
  await completePurchase(presale, WALLET2, '4.99', 1200);
  pred.placeBet({ roundId: 2, userId: '3002', side: 'BURN' }, 2000);
  await pred.settleRoundBets(2, false, 9, '5000000000000', 2_000_000);
  const late = 2000 + 3 * 86400;
  const expired = await route({ method: 'POST', pathname: '/api/prediction/activate', body: {}, headers: await tgHeaders(3002, { nowSec: late }), nowSec: late });
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error.code, 'VOUCHER_EXPIRED');
  assert.equal(pred.getUserSummary('3002', 2).pendingActivationRaw, '0');
});

await test('PredictionEngine applies up to 2.0x invite+exact boost and returns streak, winRate, pendingExpiresAt, winningSide', async () => {
  const { PredictionEngine } = await import('../src/growth-engine.mjs');
  const pred = new PredictionEngine({ defaultPoolA9Raw: '30000000000000' });
  const stateStore = {
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ({ currentRoundId: 1, successCount: 0 }),
    listRounds: () => [],
    getRound: () => null,
  };
  const route = createApiRouter({ env: { A9_BOT_TOKEN: TEST_BOT_TOKEN }, stateStore, predictionEngine: pred });

  // 1001: PASS + exact slot 10 (+0.5x) + 6 invited friends (capped at 5 => +0.5x) => 2.0x (weight 20)
  pred.placeBet({ roundId: 1, userId: '1001', side: 'PASS', guessSlots: 10 }, 100);
  for (let i = 1; i <= 6; i += 1) {
    pred.placeBet({ roundId: 1, userId: `110${i}`, side: 'BURN', referrerId: '1001' }, 100 + i);
  }
  // 1002: PASS without exact guess or invites => 1.0x (weight 10)
  pred.placeBet({ roundId: 1, userId: '1002', side: 'PASS', guessSlots: 8 }, 120);

  const settleMs = 1_700_000_000_000;
  await pred.settleRoundBets(1, true, 10, '30000000000000', settleMs);

  // M-3: 8 bets => 6,400 A9 pool; weight 20/30 = 4,266.66 A9 capped at per-user max 2,500 A9
  const proSummary = await route({ method: 'GET', pathname: '/api/prediction/user/1001', query: { roundId: '1' }, headers: await tgHeaders(1001, { nowSec: 1000 }), nowSec: 1000 });
  assert.equal(proSummary.status, 200);
  assert.equal(proSummary.body.data.pendingActivationRaw, '2500000000000');
  assert.equal(proSummary.body.data.streak, 1);
  assert.equal(proSummary.body.data.winRate, 100);
  assert.equal(proSummary.body.data.inviteBoostCount, 5);
  assert.equal(proSummary.body.data.pendingExpiresAt, settleMs + 2 * 86400 * 1000);

  // Another signed-in user cannot read 1001's private record.
  const other = await route({ method: 'GET', pathname: '/api/prediction/user/1001', query: { roundId: '1' }, headers: await tgHeaders(1002, { nowSec: 1000 }), nowSec: 1000 });
  assert.equal(other.status, 403);

  const roundRes = await route({ method: 'GET', pathname: '/api/prediction/round/1' });
  assert.equal(roundRes.body.data.winningSide, 'PASS');
  assert.equal(roundRes.body.data.settled, true);
});

await test('GET /c/img/burn/2.png returns valid PNG (1200x630 & 9x16 1080x1920) and /c/burn/2 points og:image to .png', async () => {
  const { PredictionEngine } = await import('../src/growth-engine.mjs');
  const stateStore = {
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ({ currentRoundId: 2, successCount: 1 }),
    listRounds: () => [],
    getRound: (id) => ({ roundId: id, round: { status: 3, targetPriceUsdE8: '232000', twap24hUsdE8: '116000', qualifiedCandles: 10, stakeOpenAt: 100, stakeCloseAt: 200 }, candles: [] }),
  };
  const route = createApiRouter({ env: { A9_PUBLIC_ORIGIN: 'http://a9-local.test', A9_TG_BOT_HANDLE: 'A9Bot' }, stateStore, predictionEngine: new PredictionEngine() });

  const page = await route({ method: 'GET', pathname: '/c/burn/2', query: { ref: 'u42' } });
  assert.equal(page.status, 200);
  assert.ok(page.rawBody.includes('property="og:image" content="http://a9-local.test/c/img/burn/2.png"'));
  assert.ok(page.rawBody.includes('name="twitter:image" content="http://a9-local.test/c/img/burn/2.png"'));
  assert.ok(page.rawBody.includes('property="og:image:width" content="1200"'));

  const png16x9 = await route({ method: 'GET', pathname: '/c/img/burn/2.png' });
  assert.equal(png16x9.status, 200);
  assert.equal(png16x9.contentType, 'image/png');
  assert.ok(png16x9.rawBody instanceof Uint8Array);
  // PNG 8-byte signature: 89 50 4E 47 0D 0A 1A 0A
  assert.deepEqual(Array.from(png16x9.rawBody.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv1 = new DataView(png16x9.rawBody.buffer, png16x9.rawBody.byteOffset, png16x9.rawBody.byteLength);
  assert.equal(dv1.getUint32(16), 1200);
  assert.equal(dv1.getUint32(20), 630);

  const png9x16 = await route({ method: 'GET', pathname: '/c/img/burn/2.png', query: { ratio: '9x16' } });
  assert.equal(png9x16.status, 200);
  const dv2 = new DataView(png9x16.rawBody.buffer, png9x16.rawBody.byteOffset, png9x16.rawBody.byteLength);
  assert.equal(dv2.getUint32(16), 1080);
  assert.equal(dv2.getUint32(20), 1920);
});

// Minimal zero-dependency Mock Cloudflare D1 for unit-testing D1PromoStore & D1GrowthStore
function createMockD1() {
  const promoBalances = new Map();
  const promoClaims = new Map();
  const referrals = new Map();
  const predictionRounds = new Map();
  const predictionBets = new Map();
  const predictionRewards = new Map();
  const presaleOrders = new Map();

  return {
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim();
      let args = [];
      const stmt = {
        bind(...params) { args = params; return stmt; },
        async first() {
          if (q.startsWith('SELECT claimable_raw, total_claimed_raw FROM promo_balances')) {
            return promoBalances.get(args[0]) || null;
          }
          if (q.startsWith('SELECT * FROM promo_claims WHERE wallet_address = ?')) {
            return Array.from(promoClaims.values()).find((r) => r.wallet_address === args[0] && r.status === args[1] && r.expires_at > args[2]) || null;
          }
          if (q.startsWith('SELECT referrer_id FROM referrals WHERE subject_key = ?')) {
            return referrals.get(args[0]) || null;
          }
          if (q.startsWith('SELECT subject_key, referrer_id, bound_at FROM referrals WHERE subject_key = ?')) {
            return referrals.get(args[0]) || null;
          }
          if (q.startsWith('SELECT winning_side FROM prediction_rounds WHERE round_id = ?')) {
            return predictionRounds.get(Number(args[0])) || null;
          }
          if (q.startsWith('SELECT user_id FROM prediction_bets WHERE round_id = ? AND user_id = ?')) {
            return predictionBets.get(`${args[0]}:${args[1]}`) || null;
          }
          if (q.startsWith('SELECT * FROM prediction_bets WHERE round_id = ? AND user_id = ?')) {
            return predictionBets.get(`${args[0]}:${args[1]}`) || null;
          }
          if (q.startsWith('SELECT COUNT(DISTINCT user_id) AS cnt FROM prediction_bets')) {
            const set = new Set();
            for (const b of predictionBets.values()) {
              if (b.round_id === Number(args[0]) && b.referrer_id === args[1]) set.add(b.user_id);
            }
            return { cnt: set.size };
          }
          if (q.startsWith('SELECT * FROM prediction_rewards WHERE user_id = ?')) {
            return predictionRewards.get(args[0]) || null;
          }
          if (q.startsWith('SELECT * FROM presale_orders WHERE order_id = ?')) {
            return presaleOrders.get(args[0]) || null;
          }
          return null;
        },
        async all() {
          if (q.startsWith('SELECT * FROM prediction_bets WHERE round_id = ?') || q.startsWith('SELECT side FROM prediction_bets WHERE round_id = ?')) {
            return { results: Array.from(predictionBets.values()).filter((b) => b.round_id === Number(args[0])) };
          }
          if (q.startsWith("SELECT wallet_address, ton_nano, a9_amount_raw FROM presale_orders WHERE status = 'PAID_A9'")) {
            return { results: Array.from(presaleOrders.values()).filter((o) => o.status === 'PAID_A9') };
          }
          if (q.startsWith('SELECT * FROM presale_orders WHERE wallet_address = ?')) {
            return { results: Array.from(presaleOrders.values()).filter((o) => o.wallet_address === args[0]).sort((a, b) => b.created_at - a.created_at) };
          }
          return { results: [] };
        },
        async run() {
          if (q.startsWith('INSERT INTO promo_balances')) {
            promoBalances.set(args[0], { wallet_address: args[0], claimable_raw: args[1], total_claimed_raw: args[2], updated_at: args[3] });
          } else if (q.startsWith('INSERT INTO promo_claims')) {
            promoClaims.set(args[0], {
              claim_id: args[0], wallet_address: args[1], amount_raw: args[2], fee_required_nano: args[3],
              memo: args[4], status: args[5], created_at: args[6], expires_at: args[7], updated_at: args[8],
            });
          } else if (q.startsWith('INSERT INTO referrals')) {
            referrals.set(args[0], { subject_key: args[0], referrer_id: args[1], bound_at: args[2] });
          } else if (q.startsWith('INSERT INTO prediction_bets')) {
            predictionBets.set(`${args[0]}:${args[1]}`, {
              round_id: Number(args[0]), user_id: args[1], side: args[2], guess_slots: args[3],
              referrer_id: args[4], status: 'OPEN', reward_raw: '0', created_at: args[5],
            });
          } else if (q.startsWith("UPDATE prediction_bets SET status = 'WON_PENDING_ACTIVATION'")) {
            const b = predictionBets.get(`${args[1]}:${args[2]}`);
            if (b) { b.status = 'WON_PENDING_ACTIVATION'; b.reward_raw = args[0]; }
          } else if (q.startsWith("UPDATE prediction_bets SET status = 'LOST'")) {
            const b = predictionBets.get(`${args[0]}:${args[1]}`);
            if (b) { b.status = 'LOST'; b.reward_raw = '0'; }
          } else if (q.startsWith('INSERT INTO prediction_rewards')) {
            predictionRewards.set(args[0], {
              user_id: args[0], pending_activation_raw: args[1], activated_raw: args[2],
              pending_expires_at: args[3], total_settled: args[4], total_won: args[5], streak: args[6], updated_at: args[7],
            });
          } else if (q.startsWith('INSERT INTO prediction_rounds')) {
            predictionRounds.set(Number(args[0]), { round_id: Number(args[0]), winning_side: args[1], actual_qualified: args[2], settled_at: args[3] });
          } else if (q.startsWith('INSERT INTO presale_orders')) {
            presaleOrders.set(args[0], {
              order_id: args[0], wallet_address: args[1], referrer_id: args[2], ton_nano: args[3],
              a9_amount_raw: args[4], memo: args[5], status: args[6], refund_ton_nano: '0', created_at: args[7], updated_at: args[8],
            });
          } else if (q.startsWith('UPDATE presale_orders')) {
            const o = presaleOrders.get(args[4]);
            if (o) { o.status = args[0]; o.inbound_tx_hash = args[1]; o.payout_tx_hash = args[2]; o.updated_at = args[3]; }
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

await test('D1PromoStore.creditReward preserves BigInt precision across multiple credits and supports verifyInboundFeeTx + markPayoutCompleted', async () => {
  const { D1PromoStore } = await import('../src/d1-promo-store.mjs');
  const db = createSqliteD1(FRESH_SCHEMA);
  const store = new D1PromoStore({ db, hotWalletAddress: 'EQ_D1_HOT' });

  // Values exceeding Number.MAX_SAFE_INTEGER (9.007e15) to verify BigInt precision
  await store.creditReward('EQ_BIGINT_USER', '15000000000000000000', 1000);
  await store.creditReward('EQ_BIGINT_USER', '2400000000000', 1001);
  const bal = await store.getBalance('EQ_BIGINT_USER');
  assert.equal(bal.claimableRaw, '15000002400000000000');

  const intent = await store.createClaimIntent('EQ_BIGINT_USER', 1002);
  assert.equal(intent.amountRaw, '15000002400000000000');
  assert.equal(intent.payTo, 'EQ_D1_HOT');

  // Verify 0.06 GRAM inbound fee -> atomic balance deduction -> markPayoutCompleted
  const verified = await store.verifyInboundFeeTx(
    { txHash: 'd1-fee-tx-1', finality: 'finalized', to: 'EQ_D1_HOT', from: 'EQ_BIGINT_USER', valueNano: '60000000', memo: intent.memo },
    1010,
  );
  assert.equal(verified.claim.status, CLAIM_STATUS.FEE_CONFIRMED);
  assert.equal(verified.payoutInstruction.jettonAmountRaw, '15000002400000000000');
  assert.equal((await store.getBalance('EQ_BIGINT_USER')).claimableRaw, '0');

  const done = await store.markPayoutCompleted(intent.claimId, 'd1-payout-tx-1', 1020);
  assert.equal(done.status, CLAIM_STATUS.COMPLETED);
  assert.equal(done.payoutTxHash, 'd1-payout-tx-1');
});

await test('POST /api/admin/prediction/settle rejects unauthorized calls (401) and settles with valid admin token', async () => {
  const { PredictionEngine } = await import('../src/growth-engine.mjs');
  const pred = new PredictionEngine({ defaultPoolA9Raw: '10000000000000' });
  pred.placeBet({ roundId: 5, userId: 'u_adm', side: 'PASS', guessSlots: 10 }, 100);
  const stateStore = {
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ({ currentRoundId: 5, successCount: 2 }),
    listRounds: () => [],
    getRound: () => null,
  };
  const route = createApiRouter({ env: { A9_ADMIN_TOKEN: 'secret-token-v15' }, stateStore, predictionEngine: pred });

  const noAuth = await route({ method: 'POST', pathname: '/api/admin/prediction/settle', body: { roundId: 5, passed: true, actualQualified: 10 } });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.body.error.code, 'UNAUTHORIZED');

  const wrongAuth = await route({
    method: 'POST', pathname: '/api/admin/prediction/settle',
    headers: { 'x-a9-admin-token': 'wrong' },
    body: { roundId: 5, passed: true, actualQualified: 10 },
  });
  assert.equal(wrongAuth.status, 401);

  const okAuth = await route({
    method: 'POST', pathname: '/api/admin/prediction/settle',
    headers: { Authorization: 'Bearer secret-token-v15' },
    body: { roundId: 5, passed: true, actualQualified: 10 },
    nowSec: 500,
  });
  assert.equal(okAuth.status, 200);
  assert.equal(okAuth.body.data.winSide, 'PASS');
  assert.equal(okAuth.body.data.winnersCount, 1);
});

await test('D1 full-stack persistence loop (real SQLite): bindReferral -> placeBet -> admin settle -> COMPLETED exchange + 12% credit -> activateToPromo', async () => {
  const { D1PromoStore } = await import('../src/d1-promo-store.mjs');
  const { D1SocialStore, D1PredictionEngine, D1PresaleStore } = await import('../src/d1-growth-store.mjs');
  const { D1IdentityStore } = await import('../src/auth.mjs');
  const db = createSqliteD1(FRESH_SCHEMA);
  const HOT = 'EQ_D1_HOT_FULL';
  const REF = 'EQ_D1_REF';
  const USER_W = 'EQ_D1_BUYER';

  const promo = new D1PromoStore({ db, hotWalletAddress: HOT });
  const social = new D1SocialStore({ db });
  const pred = new D1PredictionEngine({ db, defaultPoolA9Raw: '20000000000000' });
  const presale = new D1PresaleStore({ db, hotWalletAddress: HOT, rateA9PerTon: 2000n, minOrderTon: 5n, open: true, promoEngine: promo, socialStore: social });
  const identityStore = new D1IdentityStore({ db });
  await identityStore.bindWallet('2001', USER_W, 900);

  const stateStore = {
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ({ currentRoundId: 1, successCount: 0 }),
    listRounds: () => [],
    getRound: () => null,
  };
  const route = createApiRouter({
    env: { A9_ADMIN_TOKEN: 'd1-adm', A9_BOT_TOKEN: TEST_BOT_TOKEN },
    stateStore, promoEngine: promo, presaleEngine: presale, socialStore: social, predictionEngine: pred, identityStore,
  });
  const H = (t) => tgHeaders(2001, { nowSec: t });

  // 1) Place bet with referrerId (binds first-touch referral for the VERIFIED Telegram user)
  const betRes = await route({ method: 'POST', pathname: '/api/prediction/bet', body: { roundId: 1, side: 'PASS', guessSlots: 10, referrerId: REF }, headers: await H(1000), nowSec: 1000 });
  assert.equal(betRes.status, 200);
  assert.equal(betRes.body.data.userId, '2001');
  assert.equal(await social.getReferrer('2001'), REF);

  // 2) Settle via admin endpoint
  const settleRes = await route({ method: 'POST', pathname: '/api/admin/prediction/settle', headers: { 'x-a9-admin-token': 'd1-adm' }, body: { roundId: 1, passed: true, actualQualified: 10 }, nowSec: 2000 });
  assert.equal(settleRes.status, 200);
  assert.equal(settleRes.body.data.winnersCount, 1);

  // 3) Activate before a completed purchase -> blocked
  const blocked = await route({ method: 'POST', pathname: '/api/prediction/activate', body: {}, headers: await H(2010), nowSec: 2010 });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'ACTIVATION_REQUIREMENT_UNMET');

  // 4) Exchange order via API (wallet from binding) -> paid -> confirmed -> M-4 6% of 8,000 A9 (480 A9) to REF exactly once
  const ordRes = await route({ method: 'POST', pathname: '/api/presale/intent', body: { skuId: 'chest_silver', referrerId: REF }, headers: await H(2020), nowSec: 2020 });
  assert.equal(ordRes.status, 200);
  const ord = ordRes.body.data;
  await presale.ingestInbound({ txHash: 'tx-in-d1', finality: 'finalized', to: HOT, from: USER_W, valueNano: ord.payTonNano, memo: ord.memo }, 2025);
  await presale.queueConfirmedPayouts(2026);
  await presale.processPayouts(2027, { a9Broadcaster: async () => ({ txHash: 'tx-out-d1' }), verifier: async () => ({ state: 'CONFIRMED' }) });
  await presale.processReferralCredits(2030);
  await presale.processReferralCredits(2031);
  assert.equal((await presale.getOrder(ord.orderId)).status, 'COMPLETED');
  assert.equal((await promo.getBalance(REF)).claimableRaw, '480000000000');

  // 5) Activate after COMPLETED -> succeeds & credits 800 A9 (M-3 dynamic pool for 1 bet) to the bound wallet
  const actRes = await route({ method: 'POST', pathname: '/api/prediction/activate', body: {}, headers: await H(2040), nowSec: 2040 });
  assert.equal(actRes.status, 200);
  assert.equal(actRes.body.data.activatedRaw, '800000000000');
  assert.equal((await promo.getBalance(USER_W)).claimableRaw, '800000000000');
});

await test('PredictionEngine first-loss rookie bonus: first wrong bet earns 500 A9 (48h TTL) without touching winner pool', async () => {
  const { PredictionEngine, VOUCHER_TTL_MS } = await import('../src/growth-engine.mjs');
  const pred = new PredictionEngine({ defaultPoolA9Raw: '10000000000000' });
  pred.placeBet({ roundId: 1, userId: 'winner_1', side: 'PASS' }, 100);
  pred.placeBet({ roundId: 1, userId: 'rookie_1', side: 'BURN' }, 101);

  const nowMs = 1_760_000_000_000;
  const res = await pred.settleRoundBets(1, true, 18, '10000000000000', nowMs);
  assert.equal(res.winnersCount, 1);
  // M-3: 2 注 × 800 A9 = 1,600 A9 动态奖池，新人保底绝不侵占赢家主奖池
  assert.equal(res.distributedRaw, '1600000000000');
  assert.equal(res.firstLossBonusCount, 1);
  assert.equal(res.firstLossBonusDistributedRaw, '500000000000');

  const rookie = pred.getUserSummary('rookie_1', 1);
  assert.equal(rookie.pendingActivationRaw, '500000000000');
  assert.equal(rookie.pendingExpiresAt, nowMs + VOUCHER_TTL_MS);
  assert.equal(rookie.currentBet.status, 'LOST_FIRST_BONUS');
  assert.equal(rookie.currentBet.rewardRaw, '500000000000');
});

await test('PredictionEngine first-loss rookie bonus: second loss gets 0, round budget cap truncates, and 0 disables', async () => {
  const { PredictionEngine } = await import('../src/growth-engine.mjs');
  // 单轮硬上限 1,000 A9，每人 500 A9 -> 最多补贴 2 名新人，第 3 名被硬上限截断
  const pred = new PredictionEngine({
    defaultPoolA9Raw: '10000000000000',
    firstLossBonusRaw: '500000000000',
    firstLossCapRaw: '1000000000000',
  });
  pred.placeBet({ roundId: 1, userId: 'r1', side: 'BURN' }, 100);
  pred.placeBet({ roundId: 1, userId: 'r2', side: 'BURN' }, 101);
  pred.placeBet({ roundId: 1, userId: 'r3', side: 'BURN' }, 102);

  const s1 = await pred.settleRoundBets(1, true, 17, '10000000000000', 1_000_000);
  assert.equal(s1.firstLossBonusCount, 2);
  assert.equal(s1.firstLossBonusDistributedRaw, '1000000000000');
  assert.equal(pred.getUserSummary('r1', 1).pendingActivationRaw, '500000000000');
  assert.equal(pred.getUserSummary('r2', 1).pendingActivationRaw, '500000000000');
  assert.equal(pred.getUserSummary('r3', 1).pendingActivationRaw, '0');
  assert.equal(pred.getUserSummary('r3', 1).currentBet.status, 'LOST');

  // 第 2 轮：r1 再次押错（已非首次结算），不再发放保底；新用户 r4 首次押错照常获得 500 A9
  pred.placeBet({ roundId: 2, userId: 'r1', side: 'BURN' }, 200);
  pred.placeBet({ roundId: 2, userId: 'r4', side: 'BURN' }, 201);
  const s2 = await pred.settleRoundBets(2, true, 18, '10000000000000', 2_000_000);
  assert.equal(s2.firstLossBonusCount, 1);
  assert.equal(pred.getUserSummary('r1', 2).pendingActivationRaw, '500000000000'); // 仅保留第 1 轮未变的 500 A9
  assert.equal(pred.getUserSummary('r1', 2).currentBet.status, 'LOST');
  assert.equal(pred.getUserSummary('r4', 2).pendingActivationRaw, '500000000000');

  // 设 0 热关闭
  const predOff = new PredictionEngine({ firstLossBonusRaw: '0' });
  predOff.placeBet({ roundId: 1, userId: 'off_u', side: 'BURN' }, 100);
  const sOff = await predOff.settleRoundBets(1, true, 16, '10000000000000', 1_000_000);
  assert.equal(sOff.firstLossBonusCount, 0);
  assert.equal(predOff.getUserSummary('off_u', 1).pendingActivationRaw, '0');
});

await test('Batch 1: D1PredictionEngine.activateToPromo is atomic, idempotent on retry, rolls back on mid-batch fault, and handles aliases + BigInt', async () => {
  const { D1PromoStore } = await import('../src/d1-promo-store.mjs');
  const { D1PredictionEngine } = await import('../src/d1-growth-store.mjs');
  const { formatTonAddress } = await import('../src/ton-address.mjs');
  const db = createSqliteD1(FRESH_SCHEMA);
  const HOT = 'EQ_D1_ATOMIC_HOT';
  const hash = new Uint8Array(32).fill(0x22);
  const wBounce = formatTonAddress(0, hash, { bounceable: true, testOnly: false });
  const wNonBounce = formatTonAddress(0, hash, { bounceable: false, testOnly: false });
  const wRaw = `0:${'22'.repeat(32)}`;

  const promo = new D1PromoStore({ db, hotWalletAddress: HOT });
  const pred = new D1PredictionEngine({ db, defaultPoolA9Raw: '15000000000000000000' }); // > Number.MAX_SAFE_INTEGER

  await pred.creditPendingBonus('u_atomic', '15000000000000000000', 1_100_000);

  // 0) Missing or cross-ledger promoEngine -> fail BEFORE any write; all 3 tables untouched
  const memPromo = new PromoHotWalletEngine({ hotWalletAddress: HOT });
  const otherPromo = new D1PromoStore({ db: createSqliteD1(FRESH_SCHEMA), hotWalletAddress: HOT });
  await assert.rejects(() => pred.activateToPromo('u_atomic', wBounce, null, { qualified: true, nowMs: 1_150_000, activationId: 'req-no-promo' }), { code: 'PROMO_LEDGER_UNAVAILABLE' });
  await assert.rejects(() => pred.activateToPromo('u_atomic', wBounce, memPromo, { qualified: true, nowMs: 1_150_000, activationId: 'req-cross-mem' }), { code: 'PROMO_LEDGER_UNAVAILABLE' });
  await assert.rejects(() => pred.activateToPromo('u_atomic', wBounce, otherPromo, { qualified: true, nowMs: 1_150_000, activationId: 'req-cross-d1' }), { code: 'PROMO_LEDGER_UNAVAILABLE' });
  assert.equal((await pred.getUserSummary('u_atomic', 1)).pendingActivationRaw, '15000000000000000000');
  assert.equal((await db.prepare('SELECT COUNT(*) AS c FROM prediction_activations').first()).c, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS c FROM promo_balances').first()).c, 0);

  // Pre-credit 1,000 A9 via non-bounceable alias
  await promo.creditReward(wNonBounce, '1000000000000', 900);

  // 1) Last-write failure AFTER first two writes execute -> all 3 tables roll back
  const origBatch = db.batch.bind(db);
  let failOnce = true;
  db.batch = async (stmts) => {
    if (failOnce && stmts.length === 3) {
      failOnce = false;
      return origBatch([stmts[0], stmts[1], db.prepare('UPDATE __nonexistent_b1_crash SET x = 1')]);
    }
    return origBatch(stmts);
  };
  await assert.rejects(
    () => pred.activateToPromo('u_atomic', wBounce, promo, { qualified: true, nowMs: 1_200_000, activationId: 'req-atomic-1' }),
    /__nonexistent_b1_crash|no such table/i,
  );
  assert.equal((await pred.getUserSummary('u_atomic', 1)).pendingActivationRaw, '15000000000000000000');
  assert.equal((await pred.getUserSummary('u_atomic', 1)).activatedRaw, '0');
  assert.equal((await db.prepare('SELECT COUNT(*) AS c FROM prediction_activations WHERE activation_id = ?').bind('req-atomic-1').first()).c, 0);
  assert.equal((await promo.getBalance(wRaw)).claimableRaw, '1000000000000');

  // 2) Simulate concurrent credit from another source right before batch -> NOT NULL snapshot guard rolls back & retries cleanly
  let injectRace = true;
  db.batch = async (stmts) => {
    if (injectRace) {
      injectRace = false;
      await promo.creditReward(wRaw, '500000000000', 1201); // concurrent +500 A9 referral
    }
    return origBatch(stmts);
  };
  const act1 = await pred.activateToPromo('u_atomic', wBounce, promo, { qualified: true, nowMs: 1_200_000, activationId: 'req-atomic-1' });
  db.batch = origBatch;

  assert.equal(act1.activatedRaw, '15000000000000000000');
  assert.equal(act1.activationId, 'req-atomic-1');
  assert.equal(act1.idempotent, false);
  // Accounting invariant: 1,000 (initial) + 500 (concurrent referral) + 15,000,000,000 (activated)
  assert.equal((await pred.getUserSummary('u_atomic', 1)).pendingActivationRaw, '0');
  assert.equal((await promo.getBalance(wNonBounce)).claimableRaw, '15000001500000000000');

  // 3) Same request retry after lost response -> returns original ledger row with zero extra credit
  const actRetry = await pred.activateToPromo('u_atomic', wBounce, promo, { qualified: true, nowMs: 1_205_000, activationId: 'req-atomic-1' });
  assert.equal(actRetry.idempotent, true);
  assert.equal(actRetry.activatedRaw, '15000000000000000000');
  assert.equal(actRetry.activationId, 'req-atomic-1');
  assert.equal((await promo.getBalance(wBounce)).claimableRaw, '15000001500000000000');
});

await test('Batch 2: v16 candidate config, round #256 mapping, and uint128 activeLockedRounds precision', async () => {
  const { buildV15ConfigPayload } = await import('../src/v15-indexer.mjs');
  const { TonCenterClient } = await import('../src/toncenter.mjs');
  // Pack 4 uint32 round IDs (254, 255, 256, 257) into uint128 (> Number.MAX_SAFE_INTEGER)
  const packed128 = 254n | (255n << 32n) | (256n << 64n) | (257n << 96n);
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      result: {
        exit_code: 0,
        stack: [
          ['num', '0x100'], ['num', '0xc'], ['num', '0x1000'], ['num', '0x200'],
          ['num', '0x300'], ['num', '0x40'], ['num', '0x500'], ['num', '0x0'],
          ['num', `0x${packed128.toString(16)}`],
        ],
      },
    }),
  });
  const tc = new TonCenterClient({ apiBase: 'http://mock-v16.local', fetchImpl: mockFetch, minIntervalMs: 0 });
  const ps = await tc.fetchProtocolState('EQ_RC_V16');
  assert.equal(ps.currentRoundId, 256);
  assert.equal(ps.activeLockedRoundsRaw, packed128.toString());

  const cfgV16 = buildV15ConfigPayload({ A9_PROTOCOL_VERSION: 'v16', A9_NETWORK: 'testnet', A9_TG_BOT_HANDLE: 'A9ProtocolBot' }, ps);
  assert.equal(cfgV16.protocolVersion, 'v16');
  assert.equal(cfgV16.stakeProtocolVersion, 'v16');
  assert.equal(cfgV16.maxRoundId, 4294967295);
  assert.equal(cfgV16.poolState.currentRoundId, 256);
  assert.equal(cfgV16.poolState.activeLockedRoundsRaw, packed128.toString());

  const r256 = mapV15RoundDetail(256, { status: 1, targetPriceUsdE8: '232000', twap24hUsdE8: '116000', stakeOpenAt: 1000, stakeCloseAt: 5000, rewardBudgetRaw: '700000000000000000' }, [], 2000);
  assert.equal(r256.roundId, 256);
  assert.equal(r256.state, 'STAKING_OPEN');

  const { default: cfWorker } = await import('../src/cf-worker.mjs');
  const incompleteRes = await cfWorker.fetch(
    new Request('https://a9.example/api/health'),
    { A9_ENVIRONMENT: 'candidate', A9_PROTOCOL_VERSION: 'v16', A9_NETWORK: 'testnet' },
  );
  assert.equal(incompleteRes.status, 503);
  const incompleteBody = await incompleteRes.json();
  assert.equal(incompleteBody.error.code, 'CANDIDATE_CONFIG_INCOMPLETE');
  assert.ok(incompleteBody.error.missing.includes('DB'));
  assert.ok(incompleteBody.error.missing.includes('A9_ROUND_CONTROLLER_ADDRESS'));
});

await test('Batch 1: reconcilePredictionLedger handles wallet rebind without false positive, flags shortfall & legacy mixed-promo, and keeps >64-bit BigInt precision', async () => {
  const { D1PromoStore } = await import('../src/d1-promo-store.mjs');
  const { D1PredictionEngine, reconcilePredictionLedger } = await import('../src/d1-growth-store.mjs');
  const { D1IdentityStore } = await import('../src/auth.mjs');
  const { formatTonAddress } = await import('../src/ton-address.mjs');
  const db = createSqliteD1(FRESH_SCHEMA);
  const promo = new D1PromoStore({ db, hotWalletAddress: 'EQ_RECON_HOT' });
  const pred = new D1PredictionEngine({ db });
  const idStore = new D1IdentityStore({ db });

  const mkWallet = (fill) => formatTonAddress(0, new Uint8Array(32).fill(fill), { bounceable: true, testOnly: false });
  const oldW = mkWallet(0x11);
  const newW = mkWallet(0x22);
  const shortW = mkWallet(0x33);
  const legacyW = mkWallet(0x44);

  // 1) User activates > 64-bit signed int (20,000,000,000,000,000,000 > 9.22e18) to oldW, then rebinds to newW (0 promo) -> MUST be OK
  const hugeAmt = '20000000000000000000';
  await idStore.bindWallet('u_rebind', oldW, 1000);
  await pred.creditPendingBonus('u_rebind', hugeAmt, 1_100_000);
  await pred.activateToPromo('u_rebind', oldW, promo, { qualified: true, nowMs: 1_200_000, activationId: 'rec-rebind-1' });
  await db.prepare('UPDATE wallet_bindings SET wallet_address = ?, wallet_key = ?, updated_at = 1300 WHERE tg_user_id = ?')
    .bind(newW, `0:${'22'.repeat(32)}`, 'u_rebind').run();

  // 2) True shortfall on original wallet_key -> DISCREPANCY_MISSING_PROMO_CREDIT
  await idStore.bindWallet('u_short', shortW, 1000);
  await db.prepare(`INSERT INTO prediction_rewards (user_id, pending_activation_raw, activated_raw, total_settled, total_won, streak, updated_at)
    VALUES ('u_short', '0', '5000000000000', 1, 1, 1, 1000)`).run();
  await db.prepare(`INSERT INTO prediction_activations (activation_id, user_id, wallet_key, wallet_address, amount_raw, created_at)
    VALUES ('rec-short-1', 'u_short', ?, ?, '5000000000000', 1000)`).bind(`0:${'33'.repeat(32)}`, shortW).run();
  await promo.creditReward(shortW, '1000000000000', 1000); // only 1,000 A9 instead of 5,000 A9

  // 3) Legacy pre-0008 activation with mixed referral credit on promo_balances -> MANUAL_REVIEW_INSUFFICIENT_EVIDENCE
  await idStore.bindWallet('u_legacy', legacyW, 1000);
  await db.prepare(`INSERT INTO prediction_rewards (user_id, pending_activation_raw, activated_raw, total_settled, total_won, streak, updated_at)
    VALUES ('u_legacy', '0', '3000000000000', 1, 1, 1, 1000)`).run();
  await promo.creditReward(legacyW, '8000000000000', 1000); // mixed referral credit masks whether 3,000 A9 landed

  // 4) Ledger sum exceeds activated_raw (activated=1, ledger=2e19, promo=2e19) -> DISCREPANCY_LEDGER_EXCEEDS_ACTIVATED
  const excessW = mkWallet(0x55);
  await idStore.bindWallet('u_excess', excessW, 1000);
  await db.prepare(`INSERT INTO prediction_rewards (user_id, pending_activation_raw, activated_raw, total_settled, total_won, streak, updated_at)
    VALUES ('u_excess', '0', '1', 1, 1, 1, 1000)`).run();
  await db.prepare(`INSERT INTO prediction_activations (activation_id, user_id, wallet_key, wallet_address, amount_raw, created_at)
    VALUES ('rec-excess-1', 'u_excess', ?, ?, ?, 1000)`).bind(`0:${'55'.repeat(32)}`, excessW, hugeAmt).run();
  await promo.creditReward(excessW, hugeAmt, 1000);

  // 5) activated_raw = 0 (or missing prediction_rewards row) while ledger row exists -> DISCREPANCY_LEDGER_EXCEEDS_ACTIVATED
  const orphanW = mkWallet(0x66);
  await db.prepare(`INSERT INTO prediction_activations (activation_id, user_id, wallet_key, wallet_address, amount_raw, created_at)
    VALUES ('rec-zero-1', 'u_zero_act', ?, ?, '700000000000', 1000)`).bind(`0:${'66'.repeat(32)}`, orphanW).run();
  await promo.creditReward(orphanW, '700000000000', 1000);

  const report = await reconcilePredictionLedger(db);
  assert.equal(report.okUsers, 1); // ONLY u_rebind passed with zero false positive
  assert.equal(report.findings.length, 4);
  const fShort = report.findings.find((f) => f.status === 'DISCREPANCY_MISSING_PROMO_CREDIT');
  assert.ok(fShort);
  assert.equal(fShort.activatedRaw, '5000000000000');
  const fLegacy = report.findings.find((f) => f.status === 'MANUAL_REVIEW_INSUFFICIENT_EVIDENCE');
  assert.ok(fLegacy);
  assert.equal(fLegacy.reason, 'legacy_pre_0008_unbacked_or_mixed_promo');
  assert.equal(fLegacy.legacyUnbackedRaw, '3000000000000');
  const fExcess = report.findings.find((f) => f.reason === 'ledger_sum_exceeds_activated_raw');
  assert.ok(fExcess);
  assert.equal(fExcess.status, 'DISCREPANCY_LEDGER_EXCEEDS_ACTIVATED');
  assert.equal(fExcess.excessRaw, '19999999999999999999');
  const fZero = report.findings.find((f) => f.reason === 'ledger_exists_with_zero_activated');
  assert.ok(fZero);
  assert.equal(fZero.status, 'DISCREPANCY_LEDGER_EXCEEDS_ACTIVATED');
  assert.equal(fZero.activatedRaw, '0');
  assert.equal(fZero.ledgerSumRaw, '700000000000');
});

await test('W1-1: POST /api/prediction/bet enforces on-chain round status and stakeCloseAt cutoff', async () => {
  const pred = new PredictionEngine();
  const makeStateStore = ({ dataAvailable = true, currentRoundId = 1, round = null } = {}) => ({
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ({ dataAvailable, currentRoundId, successCount: 0 }),
    listRounds: () => (round ? [{ roundId: currentRoundId, round, candles: [] }] : []),
    getRound: (id) => (round && Number(id) === currentRoundId ? { roundId: currentRoundId, round, candles: [] } : null),
  });
  const idsW1 = new MemoryIdentityStore();
  await idsW1.bindWallet('9101', 'EQ_W1_BETTER', 1000);
  const mkRouter = (ss) => createApiRouter({ env: { A9_BOT_TOKEN: TEST_BOT_TOKEN }, stateStore: ss, predictionEngine: pred, identityStore: idsW1 });
  const h = await tgHeaders(9101, { nowSec: 1500 });

  // 1) Chain state unavailable -> 503
  const rUnavail = await mkRouter(makeStateStore({ dataAvailable: false, currentRoundId: null }))({
    method: 'POST', pathname: '/api/prediction/bet', headers: h, body: { roundId: 1, side: 'PASS' }, nowSec: 1500,
  });
  assert.equal(rUnavail.status, 503);
  assert.equal(rUnavail.body.error.code, 'CHAIN_STATE_UNAVAILABLE');

  // 2) Wrong roundId (!== currentRoundId) -> 400 ROUND_NOT_OPEN
  const activeRound = { status: 1, stakeOpenAt: 1000, stakeCloseAt: 2000 };
  const rWrong = await mkRouter(makeStateStore({ currentRoundId: 2, round: activeRound }))({
    method: 'POST', pathname: '/api/prediction/bet', headers: h, body: { roundId: 1, side: 'PASS' }, nowSec: 1500,
  });
  assert.equal(rWrong.status, 400);
  assert.equal(rWrong.body.error.code, 'ROUND_NOT_OPEN');

  // 3) Past stakeCloseAt (observing phase) -> 400 BETTING_CLOSED
  const rClosed = await mkRouter(makeStateStore({ currentRoundId: 1, round: activeRound }))({
    method: 'POST', pathname: '/api/prediction/bet', headers: h, body: { roundId: 1, side: 'PASS' }, nowSec: 2000,
  });
  assert.equal(rClosed.status, 400);
  assert.equal(rClosed.body.error.code, 'BETTING_CLOSED');

  // 4) Settled round (status = 2) -> 400 ROUND_NOT_OPEN
  const rSettled = await mkRouter(makeStateStore({ currentRoundId: 1, round: { status: 2, stakeOpenAt: 1000, stakeCloseAt: 2000 } }))({
    method: 'POST', pathname: '/api/prediction/bet', headers: h, body: { roundId: 1, side: 'PASS' }, nowSec: 1500,
  });
  assert.equal(rSettled.status, 400);
  assert.equal(rSettled.body.error.code, 'ROUND_NOT_OPEN');

  // 5) Within active staking window -> 200
  const rOk = await mkRouter(makeStateStore({ currentRoundId: 1, round: activeRound }))({
    method: 'POST', pathname: '/api/prediction/bet', headers: h, body: { roundId: 1, side: 'PASS' }, nowSec: 1500,
  });
  assert.equal(rOk.status, 200);
  assert.equal(rOk.body.data.roundId, 1);
});

await test('W1-2: PromoPayoutRunner dry-run is strictly read-only (zero balance deduction or DB write)', async () => {
  const db = createSqliteD1(MIGRATIONS);
  const HOT = 'kQDNHik_ofaZns7ki5yuMYHMHODiRSs_lcTG9R5p2iyJwt4X';
  const USER = 'kQA_PROMO_DRYRUN_USER';
  const d1Promo = new D1PromoStore({ db, hotWalletAddress: HOT });
  await d1Promo.creditReward(USER, '5000000000000', 1000);
  const intent = await d1Promo.createClaimIntent(USER, 1001);
  const beforeDump = await dumpDb(db);

  const mockTc = {
    fetchInboundTransfers: async () => [{
      txHash: 'tx-dryrun-001',
      finality: 'finalized',
      to: HOT,
      from: USER,
      valueNano: '60000000',
      memo: intent.memo,
      utime: 1002,
    }],
  };
  let broadcastCalls = 0;
  const runner = new PromoPayoutRunner({
    engine: d1Promo,
    tonCenter: mockTc,
    broadcaster: async () => { broadcastCalls += 1; return { txHash: '0xshould_not_run' }; },
    execute: false,
    logger: { log() {} },
  });
  const summary = await runner.tick(1003);
  assert.equal(summary.dryRun, 1);
  assert.equal(summary.processed, 0);
  assert.equal(summary.errors.length, 0);
  assert.equal(broadcastCalls, 0);
  assert.equal(await dumpDb(db), beforeDump);
  assert.equal((await d1Promo.getBalance(USER)).claimableRaw, '5000000000000');
  assert.equal((await d1Promo.getClaim(intent.claimId)).status, CLAIM_STATUS.PENDING_FEE);
});

await test('W1-3: D1PromoStore.verifyInboundFeeTx rolls back ENTIRE db.batch() on concurrent claim/balance mutation', async () => {
  const db = createSqliteD1(MIGRATIONS);
  const HOT = 'kQDNHik_ofaZns7ki5yuMYHMHODiRSs_lcTG9R5p2iyJwt4X';
  const USER = 'kQA_PROMO_RACE_USER';
  const d1Promo = new D1PromoStore({ db, hotWalletAddress: HOT });
  await d1Promo.creditReward(USER, '5000000000000', 1000);
  const intent = await d1Promo.createClaimIntent(USER, 1001);

  // Inject concurrent mutation right before db.batch() executes:
  // Scenario A: another worker marks the claim EXPIRED after initial SELECT but before batch().
  const origBatch = db.batch.bind(db);
  let intercepted = false;
  db.batch = async (stmts) => {
    if (!intercepted) {
      intercepted = true;
      await db.prepare('UPDATE promo_claims SET status = ? WHERE claim_id = ?').bind(CLAIM_STATUS.EXPIRED, intent.claimId).run();
    }
    return origBatch(stmts);
  };
  await assert.rejects(
    () => d1Promo.verifyInboundFeeTx({
      txHash: 'tx-race-expired',
      finality: 'finalized',
      to: HOT,
      from: USER,
      valueNano: '60000000',
      memo: intent.memo,
    }, 1002),
    { code: 'CONFLICT' },
  );
  // Balance must be 100% preserved (zero evaporation) and claim remains EXPIRED!
  assert.equal((await d1Promo.getBalance(USER)).claimableRaw, '5000000000000');
  assert.equal((await d1Promo.getBalance(USER)).totalClaimedRaw, '0');
  assert.equal((await d1Promo.getClaim(intent.claimId)).status, CLAIM_STATUS.EXPIRED);

  // Scenario B: new claim where promo_balances concurrently receives another credit before batch().
  db.batch = origBatch;
  const intent2 = await d1Promo.createClaimIntent(USER, 1005);
  let interceptedB = false;
  db.batch = async (stmts) => {
    if (!interceptedB) {
      interceptedB = true;
      await db.prepare('UPDATE promo_balances SET claimable_raw = ? WHERE wallet_address = ?').bind('6000000000000', USER).run();
    }
    return origBatch(stmts);
  };
  await assert.rejects(
    () => d1Promo.verifyInboundFeeTx({
      txHash: 'tx-race-balance',
      finality: 'finalized',
      to: HOT,
      from: USER,
      valueNano: '60000000',
      memo: intent2.memo,
    }, 1006),
    { code: 'CONFLICT' },
  );
  db.batch = origBatch;
  assert.equal((await d1Promo.getBalance(USER)).claimableRaw, '6000000000000');
  assert.equal((await d1Promo.getBalance(USER)).totalClaimedRaw, '0');
  assert.equal((await d1Promo.getClaim(intent2.claimId)).status, CLAIM_STATUS.PENDING_FEE);
  assert.equal((await d1Promo.getClaim(intent2.claimId)).feeTxHash, null);
});

await test('W1-4: D1PresaleRepo.insertOrderIfCapacity handles >INT64_MAX (10B A9 raw = 1e19) with exact BigInt precision', async () => {
  const db = createSqliteD1(MIGRATIONS);
  const HOT = 'kQDNHik_ofaZns7ki5yuMYHMHODiRSs_lcTG9R5p2iyJwt4X';
  const CAP_10B = 10_000_000_000n * 1_000_000_000n; // 10,000,000,000,000,000,000 > INT64_MAX (9.223e18)
  const presale = new D1PresaleStore({
    db,
    hotWalletAddress: HOT,
    rateA9PerTon: 100_000_000n,
    minOrderTon: 1n,
    maxOrderTon: 100n,
    defaultQuotaTon: 100n,
    totalCapA9Raw: CAP_10B,
    open: true,
  });
  const mkBigOrder = (id, w, tonNano, a9Raw, t) => ({
    orderId: id, walletAddress: w, walletKey: w, referrerId: null, tonNano, a9AmountRaw: a9Raw,
    memo: `buy:${id}`, status: 'PENDING_PAYMENT', inboundTxHash: null, payoutTxHash: null,
    refundTonNano: '0', createdAt: t, expiresAt: t + 1800, updatedAt: t,
  });
  // First order: 6B A9 raw (6e18)
  const r1 = await presale.repo.insertOrderIfCapacity(
    mkBigOrder('huge_1', 'EQ_HUGE_1', '60000000000', (6_000_000_000n * 1_000_000_000n).toString(), 1000),
    { nowSec: 1000, userQuotaNano: 100_000_000_000n, capA9Raw: CAP_10B },
  );
  assert.equal(r1, true);
  // Second order: 4B A9 raw -> total exactly 10B A9 raw (1e19 > INT64_MAX) -> MUST SUCCEED
  const r2 = await presale.repo.insertOrderIfCapacity(
    mkBigOrder('huge_2', 'EQ_HUGE_2', '40000000000', (4_000_000_000n * 1_000_000_000n).toString(), 1001),
    { nowSec: 1001, userQuotaNano: 100_000_000_000n, capA9Raw: CAP_10B },
  );
  assert.equal(r2, true);
  // Third order: even 1 A9 raw would exceed 10B cap -> MUST REJECT (false)
  const r3 = await presale.repo.insertOrderIfCapacity(
    mkBigOrder('huge_3', 'EQ_HUGE_3', '1000000000', '1', 1002),
    { nowSec: 1002, userQuotaNano: 100_000_000_000n, capA9Raw: CAP_10B },
  );
  assert.equal(r3, false);
});

await test('W1-5: Warmup blocks cancel->register invite farming and team switch updates old team member_count', async () => {
  for (const [label, social] of [
    ['memory', new SocialStore()],
    ['d1', new D1SocialStore({ db: createSqliteD1(MIGRATIONS) })],
  ]) {
    await social.registerWarmup({ roundId: 1, walletAddress: 'EQ_REF_LEADER' }, 1000);
    await social.registerWarmup({ roundId: 1, walletAddress: 'EQ_FARMER', referrerId: 'EQ_REF_LEADER' }, 1001);
    await social.cancelWarmup({ roundId: 1, walletAddress: 'EQ_FARMER' }, 1002);
    await social.registerWarmup({ roundId: 1, walletAddress: 'EQ_FARMER', referrerId: 'EQ_REF_LEADER' }, 1003);
    await social.cancelWarmup({ roundId: 1, walletAddress: 'EQ_FARMER' }, 1004);
    await social.registerWarmup({ roundId: 1, walletAddress: 'EQ_FARMER', referrerId: 'EQ_REF_LEADER' }, 1005);
    const lb = await social.getWarmupLeaderboard(1, 10);
    const leader = lb.find((r) => r.walletAddress === 'EQ_REF_LEADER');
    assert.equal(leader?.validInvites, 1, `${label}: cancel->register must NOT inflate validInvites`);

    await social.createOrBindTeamGroup({ teamId: 'TM-A', name: 'Team A', captainWallet: 'EQ_CAP_A' }, 1000);
    await social.createOrBindTeamGroup({ teamId: 'TM-B', name: 'Team B', captainWallet: 'EQ_CAP_B' }, 1000);
    await social.joinTeam({ teamId: 'TM-A', walletAddress: 'EQ_MOVER' }, 1001);
    assert.equal((await social.getTeamByWallet('EQ_CAP_A')).memberCount, 2, label);
    // M-1: 跨战队切换需过 7 天冷静期
    await social.joinTeam({ teamId: 'TM-B', walletAddress: 'EQ_MOVER' }, 1001 + 7 * 86400 + 1);
    assert.equal((await social.getTeamByWallet('EQ_CAP_A')).memberCount, 1, `${label}: old team count must decrement on switch`);
    assert.equal((await social.getTeamByWallet('EQ_CAP_B')).memberCount, 2, label);
  }
});

await test('W1-6: cf-worker production fail-closed/CORS x-idempotency-key & TonCenter strict stack + conservative verifier', async () => {
  const { default: cfWorker } = await import('../src/cf-worker.mjs');
  // 1) OPTIONS allows x-idempotency-key; mainnet without allowlist omits wildcard '*'
  const optProd = await cfWorker.fetch(
    new Request('https://api.a9.lat/api/prediction/activate', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }),
    { A9_NETWORK: 'mainnet' },
  );
  assert.equal(optProd.status, 204);
  assert.ok(optProd.headers.get('access-control-allow-headers').includes('x-idempotency-key'));
  assert.equal(optProd.headers.get('access-control-allow-origin'), null);

  // 2) Production without DB binding fails closed with 503 PRODUCTION_CONFIG_INCOMPLETE
  const prodNoDb = await cfWorker.fetch(
    new Request('https://api.a9.lat/api/config'),
    { A9_NETWORK: 'mainnet', A9_PUBLIC_ORIGIN: 'https://a9.lat' },
  );
  assert.equal(prodNoDb.status, 503);
  const prodBody = await prodNoDb.json();
  assert.equal(prodBody.error.code, 'PRODUCTION_CONFIG_INCOMPLETE');

  // 3) TonCenterClient strict stack check rejects truncated get_round / get_protocol_state instead of returning fake 0
  const badTc = new TonCenterClient({
    apiBase: 'https://mock.toncenter',
    apiKey: 'k',
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: { exit_code: 0, stack: [['num', '0x1']] } }) }),
  });
  await assert.rejects(() => badTc.fetchProtocolState('EQ_RC'), /truncated stack/);
  await assert.rejects(() => badTc.fetchRound('EQ_RC', 1), /truncated stack/);

  // 4) verifyOutboundPayout never false-positives on outer out_msgs alone
  const v = await badTc.verifyOutboundPayout('EQ_HOT', { txHash: '0xabc' });
  assert.equal(v.state, 'PENDING');
});

await test('W2-1: createSqliteFileD1 persists across reconnect and createD1HttpClient handles batch/first/all/run', async () => {
  const { createSqliteFileD1, createD1HttpClient } = await import('../src/d1-http-client.mjs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { unlinkSync, readFileSync } = await import('node:fs');
  const dbPath = join(tmpdir(), `a9-w2-sqlite-${process.pid}-${Date.now()}.sqlite`);

  try {
    const db1 = createSqliteFileD1(dbPath);
    db1.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    await db1
      .prepare('INSERT INTO chain_scan_cursors (wallet_address, last_lt, last_hash, updated_at) VALUES (?, ?, ?, ?)')
      .bind('0:' + 'aa'.repeat(32), '9001', 'h9001', 1700000000)
      .run();
    db1.close();

    // Reopen file to verify WAL persistence across crash/restart
    const db2 = createSqliteFileD1(dbPath);
    const row = await db2.prepare('SELECT * FROM chain_scan_cursors WHERE wallet_address = ?').bind('0:' + 'aa'.repeat(32)).first();
    assert.equal(row?.last_lt, '9001');
    assert.equal(row?.last_hash, 'h9001');
    db2.close();

    // Verify D1 REST HTTP client batch & query protocol
    const requests = [];
    const httpD1 = createD1HttpClient({
      accountId: 'acc_test',
      databaseId: 'db_test',
      apiToken: 'tok_test',
      fetchImpl: async (url, init) => {
        const payload = JSON.parse(init.body);
        requests.push({ url: String(url), payload });
        const result = Array.isArray(payload?.batch)
          ? payload.batch.map((_, i) => ({ success: true, results: [{ idx: i }], meta: { changes: 1 } }))
          : [{ success: true, results: [{ ok: 1 }], meta: { changes: 1 } }];
        return { ok: true, status: 200, json: async () => ({ success: true, result }) };
      },
    });
    const probe = await httpD1.prepare('SELECT 1 AS ok').first();
    assert.equal(probe.ok, 1);
    const bRes = await httpD1.batch([
      httpD1.prepare('UPDATE promo_balances SET updated_at = ? WHERE wallet_address = ?').bind(100, 'w1'),
      httpD1.prepare('UPDATE promo_balances SET updated_at = ? WHERE wallet_address = ?').bind(101, 'w2'),
    ]);
    assert.equal(bRes.length, 2);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].url.includes('/accounts/acc_test/d1/database/db_test/query'));
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(dbPath + suffix); } catch {}
    }
  }
});

await test('W2-2: fetchInboundTransfersSince paginates >30 txs in ascending lt order and PresalePayoutRunner advances cursor safely', async () => {
  const { PresalePayoutRunner } = await import('../src/presale-runner.mjs');
  const HOT = 'kQDNHik_ofaZns7ki5yuMYHMHODiRSs_lcTG9R5p2iyJwt4X';
  const BUYER = '0:' + '22'.repeat(32);

  // Build 45 inbound txs (lt 1001..1045), served newest-first across 3 pages of size 20
  const allTxs = Array.from({ length: 45 }, (_, idx) => {
    const lt = 1045 - idx;
    return {
      transaction_id: { lt: String(lt), hash: `tx_${lt}` },
      utime: 1700000000 + lt,
      in_msg: {
        source: BUYER,
        destination: HOT,
        value: '990000000',
        message: `buy:ord_${lt}`,
      },
      out_msgs: [],
    };
  });

  const tc = new TonCenterClient({
    apiBase: 'https://mock.toncenter/api/v2',
    apiKey: 'k',
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      const limit = Number(u.searchParams.get('limit') || 20);
      const ltParam = u.searchParams.get('lt');
      const startIdx = ltParam ? allTxs.findIndex((t) => t.transaction_id.lt === ltParam) : 0;
      const page = startIdx >= 0 ? allTxs.slice(startIdx, startIdx + limit) : [];
      return { ok: true, json: async () => ({ ok: true, result: page }) };
    },
  });

  // 1) Initial full paginated scan gets all 45 txs in ascending lt order
  const firstScan = await tc.fetchInboundTransfersSince(HOT, { pageSize: 20, maxPages: 10 });
  assert.equal(firstScan.transfers.length, 45);
  assert.equal(firstScan.transfers[0].lt, '1001');
  assert.equal(firstScan.transfers[44].lt, '1045');
  assert.deepEqual(firstScan.nextCursor, { lt: '1045', hash: 'tx_1045' });
  assert.equal(firstScan.reachedCursor, true);

  // 2) Incremental scan from cursor lt=1040 returns strictly lt 1041..1045 (5 new txs)
  const incScan = await tc.fetchInboundTransfersSince(HOT, {
    cursorLt: '1040',
    cursorHash: 'tx_1040',
    pageSize: 20,
    maxPages: 10,
  });
  assert.deepEqual(incScan.transfers.map((t) => t.lt), ['1041', '1042', '1043', '1044', '1045']);

  // 3) PresalePayoutRunner saves cursor in D1 on live tick and NEVER writes cursor on dry-run
  const db = createSqliteD1(MIGRATIONS);
  const presale = new D1PresaleStore({ db, hotWalletAddress: HOT, open: true });
  const dryRunner = new PresalePayoutRunner({ tonCenter: tc, engine: presale, execute: false, logger: { log() {}, error() {} } });
  await dryRunner.tick(1700002000);
  assert.equal(await presale.repo.getScanCursor(HOT), null, 'dry-run must NOT persist scan cursor');

  const liveRunner = new PresalePayoutRunner({
    tonCenter: tc,
    engine: presale,
    execute: true,
    a9Broadcaster: async () => ({ txHash: '0xmock' }),
    tonRefundBroadcaster: async () => ({ txHash: '0xmock_refund' }),
    logger: { log() {}, error() {} },
  });
  await liveRunner.tick(1700002001);
  const savedCursor = await presale.repo.getScanCursor(HOT);
  assert.equal(savedCursor?.lt, '1045');
  assert.equal(savedCursor?.hash, 'tx_1045');
});

await test('W2-3: TonCenter v3 verifyOutboundPayout checks downstream A9/REFUND finality and crash recovery never marks null txHash as SENT', async () => {
  const { PresaleHotWalletEngine, PAYOUT_STATUS } = await import('../src/presale-hotwallet.mjs');
  const HOT = '0:' + '11'.repeat(32);
  const BUYER = '0:' + '22'.repeat(32);
  const MASTER = '0:' + '33'.repeat(32);

  // 1) A9 jetton transfer v3 verification (even without txHash, found by queryId)
  const tcA9 = new TonCenterClient({
    apiBase: 'https://toncenter.com/api/v2',
    apiKey: 'k',
    fetchImpl: async (url) => {
      const u = String(url);
      assert.ok(u.includes('/api/v3/jetton/transfers'));
      return {
        ok: true,
        json: async () => ({
          jetton_transfers: [
            {
              query_id: '777',
              destination: BUYER,
              amount: '1000000000000',
              transaction_hash: 'v3_a9_hash_1',
              transaction_aborted: false,
              trace_incomplete: false,
            },
          ],
        }),
      };
    },
  });
  const okA9 = await tcA9.verifyOutboundPayout(HOT, {
    kind: 'A9',
    recipient: BUYER,
    amount: '1000000000000',
    queryId: '777',
    txHash: null,
    jettonMasterAddress: MASTER,
  });
  assert.equal(okA9.state, 'CONFIRMED');
  assert.equal(okA9.txHash, 'v3_a9_hash_1');

  // 2) REFUND v3 verification queries direction=in, rejects bounced/undelivered messages, confirms clean delivery & returns NOT_FOUND after timeout
  let bouncedFlag = true;
  let inMsgTxHash = 'v3_dest_tx_1';
  let seenRefundUrl = '';
  const tcRefund = new TonCenterClient({
    apiBase: 'https://toncenter.com/api/v2',
    apiKey: 'k',
    fetchImpl: async (url) => {
      seenRefundUrl = String(url);
      assert.ok(seenRefundUrl.includes('/api/v3/messages'));
      assert.ok(seenRefundUrl.includes('direction=in'), 'REFUND verification MUST query direction=in');
      return {
        ok: true,
        json: async () => ({
          messages: [
            {
              source: HOT,
              destination: BUYER,
              value: '990000000',
              bounced: bouncedFlag,
              hash: 'v3_refund_hash_1',
              in_msg_tx_hash: inMsgTxHash,
              message_content: { decoded: { type: 'text_comment', comment: 'refund:888' } },
            },
          ],
        }),
      };
    },
  });
  const bouncedRes = await tcRefund.verifyOutboundPayout(HOT, {
    kind: 'REFUND',
    recipient: BUYER,
    amount: '990000000',
    queryId: '888',
  });
  assert.equal(bouncedRes.state, 'FAILED');

  bouncedFlag = false;
  inMsgTxHash = null;
  const undeliveredRefund = await tcRefund.verifyOutboundPayout(HOT, {
    kind: 'REFUND',
    recipient: BUYER,
    amount: '990000000',
    queryId: '888',
  });
  assert.equal(undeliveredRefund.state, 'PENDING', 'REFUND without in_msg_tx_hash must NOT falsely confirm');

  inMsgTxHash = 'v3_dest_tx_1';
  const okRefund = await tcRefund.verifyOutboundPayout(HOT, {
    kind: 'REFUND',
    recipient: BUYER,
    amount: '990000000',
    queryId: '888',
  });
  assert.equal(okRefund.state, 'CONFIRMED');
  assert.equal(okRefund.txHash, 'v3_dest_tx_1');

  const tcMissingRefund = new TonCenterClient({
    apiBase: 'https://toncenter.com/api/v2',
    apiKey: 'k',
    fetchImpl: async () => ({ ok: true, json: async () => ({ messages: [] }) }),
  });
  const notFoundRefund = await tcMissingRefund.verifyOutboundPayout(
    HOT,
    {
      kind: 'REFUND',
      recipient: BUYER,
      amount: '990000000',
      queryId: '888',
      createdAt: 1_700_000_000,
    },
    { nowSec: 1_700_000_500 },
  );
  assert.equal(notFoundRefund.state, 'NOT_FOUND');

  // 3) Crash recovery with ambiguous payout (txHash === null) and verifier returning PENDING MUST NOT mark SENT
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT, open: true });
  const ord = await presale.createOrderIntent(BUYER, null, 1000, { skuId: 'chest_silver' });
  await presale.ingestInbound(
    { txHash: 'in_crash_1', finality: 'finalized', to: HOT, from: BUYER, valueNano: ord.payTonNano, memo: ord.memo },
    1005,
  );
  await presale.queueConfirmedPayouts(1006);
  // Simulate crash during broadcast -> ambiguous with null txHash
  await presale.processPayouts(1010, {
    a9Broadcaster: async () => { throw new Error('ETIMEDOUT socket hang up'); },
  });
  const afterCrash = (await presale.repo.listOpenPayouts())[0];
  assert.equal(afterCrash.status, PAYOUT_STATUS.RETRY);
  assert.equal(afterCrash.ambiguous, true);
  assert.equal(afterCrash.txHash, null);

  // Verifier returns PENDING after STALE_BROADCAST_SEC (within 15m grace window) -> must stay RETRY (NOT SENT!)
  await presale.processPayouts(1010 + 180, {
    verifier: async () => ({ state: 'PENDING' }),
  });
  const stillWaiting = (await presale.repo.listOpenPayouts())[0];
  assert.equal(stillWaiting.status, PAYOUT_STATUS.RETRY);
  assert.equal(stillWaiting.txHash, null);

  // Verifier still PENDING after UNCONFIRMED_REVIEW_SEC (3600s) grace window -> escalates to NEEDS_REVIEW (NOT SENT!)
  await presale.processPayouts(1010 + 3605, {
    verifier: async () => ({ state: 'PENDING' }),
  });
  const escalated = await presale.repo.getPayout(afterCrash.payoutId);
  assert.equal(escalated.status, PAYOUT_STATUS.NEEDS_REVIEW);
});

await test('W2-4: D1PromoStore + PromoPayoutRunner recoverable state machine & payout-daemon wallet isolation/heartbeat', async () => {
  const { validateDaemonConfig, createPayoutDaemon } = await import('../src/payout-daemon.mjs');
  const { createActonGramRefundBroadcaster } = await import('../src/acton-broadcaster.mjs');
  const PROMO_HOT = '0:' + '44'.repeat(32);
  const PRESALE_HOT = '0:' + '55'.repeat(32);
  const USER = '0:' + '66'.repeat(32);
  const MASTER = '0:' + '77'.repeat(32);

  // 1) Hot wallet isolation fail-closed checks
  assert.throws(
    () => validateDaemonConfig({
      A9_NETWORK: 'testnet',
      A9_SQLITE_PATH: '/tmp/x.sqlite',
      TONCENTER_API_BASE: 'https://mock',
      A9_PROMO_HOT_WALLET_ADDRESS: PROMO_HOT,
      A9_PRESALE_HOT_WALLET_ADDRESS: PROMO_HOT,
    }),
    /Hot wallet isolation violated/,
  );
  assert.throws(
    () => validateDaemonConfig({
      A9_NETWORK: 'testnet',
      A9_SQLITE_PATH: '/tmp/x.sqlite',
      TONCENTER_API_BASE: 'https://mock',
      A9_JETTON_MASTER_ADDRESS: MASTER,
      A9_PROMO_HOT_WALLET_ADDRESS: PROMO_HOT,
      A9_PRESALE_HOT_WALLET_ADDRESS: PRESALE_HOT,
      A9_PROMO_HOT_WALLET_NAME: 'sharedWallet',
      A9_PRESALE_HOT_WALLET_NAME: 'sharedWallet',
      OPS_EXECUTE: '1',
      OPS_CONFIRM: 'YES',
    }, { executeFlag: true }),
    /Hot wallet isolation violated/,
  );

  // 2) createActonGramRefundBroadcaster parses GRAM_REFUND_TX cleanly (zero-padded to 64 hex) and fails without hash
  const refundB = createActonGramRefundBroadcaster({
    network: 'testnet',
    hotWalletName: 'presaleHot',
    spawnImpl: () => ({ status: 0, stdout: 'GRAM_REFUND_TX=0xdeadbeef01\n', stderr: '' }),
  });
  const rOut = await refundB({ recipient: USER, tonNano: '990000000', queryId: '900' });
  assert.equal(rOut.txHash, `0x${'deadbeef01'.padStart(64, '0')}`);

  // 3) Full D1PromoStore + PromoPayoutRunner recoverable payout + crash/retry + daemon heartbeat
  const db = createSqliteD1(MIGRATIONS);
  const promo = new D1PromoStore({ db, hotWalletAddress: PROMO_HOT });
  await promo.creditReward(USER, 12_000n * 1_000_000_000n, 1000);
  const intent = await promo.createClaimIntent(USER, 1001);

  let broadcastCount = 0;
  const mockTc = {
    async fetchInboundTransfersSince(addr) {
      if (addr === PROMO_HOT) {
        return {
          transfers: [{
            txHash: 'fee_tx_w2',
            lt: '5001',
            finality: 'finalized',
            to: PROMO_HOT,
            from: USER,
            valueNano: '60000000',
            memo: intent.memo,
          }],
          nextCursor: { lt: '5001', hash: 'fee_tx_w2' },
          reachedCursor: true,
          truncated: false,
        };
      }
      return { transfers: [], nextCursor: null, reachedCursor: true, truncated: false };
    },
    async verifyOutboundPayout() {
      return { state: 'CONFIRMED', txHash: '0xpromo_a9_tx_1' };
    },
  };

  const daemon = createPayoutDaemon({
    db,
    env: {
      A9_NETWORK: 'testnet',
      A9_SQLITE_PATH: ':memory:',
      TONCENTER_API_BASE: 'https://mock',
      A9_JETTON_MASTER_ADDRESS: MASTER,
      A9_PROMO_HOT_WALLET_ADDRESS: PROMO_HOT,
      A9_PRESALE_HOT_WALLET_ADDRESS: PRESALE_HOT,
      A9_PROMO_HOT_WALLET_NAME: 'promoHot',
      A9_PRESALE_HOT_WALLET_NAME: 'presaleHot',
      OPS_EXECUTE: '1',
      OPS_CONFIRM: 'YES',
      A9_RUNNER_ID: 'daemon-test-1',
    },
    executeFlag: true,
    tonCenter: mockTc,
    promoBroadcaster: async () => {
      broadcastCount += 1;
      return { txHash: '0xpromo_a9_tx_1' };
    },
    presaleA9Broadcaster: async () => ({ txHash: '0xunused' }),
    presaleRefundBroadcaster: async () => ({ txHash: '0xunused_ref' }),
    payoutVerifier: async () => ({ state: 'CONFIRMED', txHash: '0xpromo_a9_tx_1' }),
    logger: { log() {}, error() {} },
  });

  // Tick 1: verifies 0.06 GRAM fee, enqueues promo_payouts, broadcasts once -> SENT, records heartbeat
  await daemon.runOnce(1010);
  assert.equal(broadcastCount, 1);
  // Tick 2: verifies downstream CONFIRMED -> marks claim COMPLETED without re-broadcasting!
  await daemon.runOnce(1020);
  assert.equal(broadcastCount, 1);
  const doneClaim = await promo.getClaim(intent.claimId);
  assert.equal(doneClaim.status, CLAIM_STATUS.COMPLETED);
  assert.equal(doneClaim.payoutTxHash, '0xpromo_a9_tx_1');

  const hbRow = await db.prepare('SELECT * FROM runner_heartbeats WHERE runner_id = ?').bind('daemon-test-1').first();
  assert.equal(hbRow?.role, 'payout_daemon');
  assert.equal(Number(hbRow?.last_seen_at), 1020);
});

await test('W2-5: D1PredictionEngine.settleRoundBets is batched & CAS-safe against concurrent activateToPromo (no double-spend)', async () => {
  const { D1PredictionEngine } = await import('../src/d1-growth-store.mjs');
  const db = createSqliteD1(MIGRATIONS);
  const promo = new D1PromoStore({ db, hotWalletAddress: '0:' + '11'.repeat(32) });
  const pred = new D1PredictionEngine({ db, defaultPoolA9Raw: 60_000n * 1_000_000_000n });
  const WALLET_RACE = '0:' + '88'.repeat(32);

  // Give u_race an existing 1,000 A9 pending reward from an earlier round
  await pred.creditPendingBonus('u_race', 1_000n * 1_000_000_000n, 1_000_000);
  // Place 60 bets in round 2 (exceeds batchSize=25 -> exercises multi-batch chunking)
  await pred.placeBet({ roundId: 2, userId: 'u_race', side: 'PASS' }, 1001);
  for (let i = 1; i < 60; i += 1) {
    await pred.placeBet({ roundId: 2, userId: `u_${String(i).padStart(2, '0')}`, side: 'PASS' }, 1001 + i);
  }

  // Inject concurrent activateToPromo right before the first 25-user (50-stmt) settle batch executes!
  const origBatch = db.batch.bind(db);
  let racedOnce = false;
  db.batch = async (stmts) => {
    if (!racedOnce && stmts.length === 50) {
      racedOnce = true;
      db.batch = origBatch; // allow activateToPromo's own batch to commit cleanly first
      const act = await pred.activateToPromo('u_race', WALLET_RACE, promo, {
        qualified: true,
        nowMs: 1_005_000,
        activationId: 'race_act_1',
      });
      assert.equal(act.activatedRaw, (1_000n * 1_000_000_000n).toString());
    }
    return origBatch(stmts);
  };

  const settled = await pred.settleRoundBets(2, true, 18, 60_000n * 1_000_000_000n, 1_010_000, { batchSize: 25 });
  assert.equal(settled.winnersCount, 60);
  assert.equal(racedOnce, true, 'race condition hook must have executed');

  // u_race activated 1,000 A9 earlier; round 2 won 800 A9 (M-3: 60 bets * 800 A9 / 60).
  // MUST have activatedRaw = 1,000 A9 and pendingActivationRaw = 800 A9 (NOT resurrected to 1,800 A9!)
  const summary = await pred.getUserSummary('u_race', 2);
  assert.equal(summary.activatedRaw, (1_000n * 1_000_000_000n).toString());
  assert.equal(summary.pendingActivationRaw, (800n * 1_000_000_000n).toString());
  assert.equal((await promo.getBalance(WALLET_RACE)).claimableRaw, (1_000n * 1_000_000_000n).toString());
});

await test('W2-6: /api/user/:wallet scans historical tickets beyond 6 rounds, /api/health probes D1, and stale runner heartbeat blocks intents', async () => {
  const { default: cfWorker } = await import('../src/cf-worker.mjs');
  const db = createSqliteD1(MIGRATIONS);
  const HOT = '0:' + '44'.repeat(32);
  const WALLET = '0:' + '99'.repeat(32);

  // 1) /api/user/:wallet at currentRoundId=8 scans rounds 1..8 by default AND supports explicit ?fromRound=1&toRound=2
  const seenRanges = [];
  const router = createApiRouter({
    env: {
      A9_BOT_TOKEN: TEST_BOT_TOKEN,
      A9_PRESALE_OPEN: '1',
      A9_REQUIRE_RUNNER_HEARTBEAT: '1',
      A9_RUNNER_HEARTBEAT_MAX_STALE_SEC: '120',
    },
    stateStore: {
      getTiming: () => ({ observationSeconds: 86400 }),
      getProtocolState: () => ({ dataAvailable: true, currentRoundId: 8, successCount: 5 }),
      listRounds: () => [],
      getRound: () => null,
    },
    presaleEngine: new D1PresaleStore({ db, hotWalletAddress: HOT, open: true }),
    promoEngine: new D1PromoStore({ db, hotWalletAddress: HOT }),
    identityStore: (() => {
      const ids = new MemoryIdentityStore();
      ids.bindVerifiedWallet('10001', WALLET, 1000);
      return ids;
    })(),
    userReader: async (_wallet, opts) => {
      seenRanges.push(opts);
      return {
        jettonWallet: 'EQ_JW',
        a9BalanceRaw: '5000000000000',
        balanceAvailable: true,
        tickets: [{ roundId: 1, ticketAddress: 'EQ_T1', amountRaw: '1000000000000', rewardClaimedRaw: '0', principalDone: false, pending: false }],
        ticketsAvailable: true,
        onchainAvailable: true,
      };
    },
    runnerHeartbeatReader: async () => {
      const r = await db.prepare('SELECT runner_id, role, network, last_seen_at, meta_json FROM runner_heartbeats').all();
      return r.results || [];
    },
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const uDefault = await router({ method: 'GET', pathname: `/api/user/${encodeURIComponent(WALLET)}`, nowSec });
  assert.equal(uDefault.status, 200);
  assert.deepEqual(seenRanges[0].roundIds, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(uDefault.body.data.tickets[0].roundId, 1);
  assert.deepEqual(uDefault.body.data.ticketRange, { fromRound: 1, toRound: 8, currentRoundId: 8 });

  const uPaged = await router({
    method: 'GET',
    pathname: `/api/user/${encodeURIComponent(WALLET)}`,
    query: { fromRound: '1', toRound: '2' },
    nowSec,
  });
  assert.equal(uPaged.status, 200);
  assert.deepEqual(seenRanges[1].roundIds, [1, 2]);

  // 2) Stale/missing heartbeat blocks POST /api/presale/intent with 503 PAYOUT_RUNNER_OFFLINE
  const headers = await tgHeaders('10001', { authDate: nowSec });
  const blocked = await router({
    method: 'POST',
    pathname: '/api/presale/intent',
    headers,
    body: { skuId: 'chest_bronze', openMode: 'BOOST' },
    nowSec,
  });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error.code, 'PAYOUT_RUNNER_OFFLINE');

  // Insert fresh heartbeat -> intent succeeds
  await db
    .prepare('INSERT INTO runner_heartbeats (runner_id, role, network, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)')
    .bind('d1', 'payout_daemon', 'testnet', nowSec - 10, JSON.stringify({ status: 'ok' }))
    .run();
  const allowed = await router({
    method: 'POST',
    pathname: '/api/presale/intent',
    headers,
    body: { skuId: 'chest_bronze', openMode: 'BOOST' },
    nowSec,
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.ok, true);

  // 3) cf-worker /api/health returns live D1 probe & runnerHeartbeats
  const hRes = await cfWorker.fetch(new Request('https://api.a9.lat/api/health'), { DB: db, A9_NETWORK: 'testnet' });
  assert.equal(hRes.status, 200);
  const hBody = await hRes.json();
  assert.equal(hBody.data.status, 'ok');
  assert.equal(hBody.data.checks.db.ok, true);
  assert.equal(hBody.data.checks.runnerHeartbeats.length, 1);
  assert.equal(hBody.data.checks.runnerHeartbeats[0].runnerId, 'd1');
});

await test('W2-7: TonCenter v3 start_lt+mc_block_seqno scan, v2 500->v3 fallback, start_utime verifier, baseEnv & daemon fault isolation', async () => {
  const { createPayoutDaemon } = await import('../src/payout-daemon.mjs');
  const { createActonPromoBroadcaster, createActonGramRefundBroadcaster } = await import('../src/acton-broadcaster.mjs');
  const HOT = '0:' + 'aa'.repeat(32);
  const PROMO = '0:' + 'bb'.repeat(32);
  const BUYER = '0:' + 'cc'.repeat(32);
  const MASTER = '0:' + 'dd'.repeat(32);

  // 1) Real toncenter.com domain defaults to v3 start_lt + sort=asc & stops cursor at mc_block_seqno=0
  const v3Urls = [];
  const tcV3 = new TonCenterClient({
    apiBase: 'https://testnet.toncenter.com/api/v2',
    apiKey: 'k',
    fetchImpl: async (url) => {
      const u = String(url);
      v3Urls.push(u);
      assert.ok(u.includes('/api/v3/transactions'));
      assert.ok(u.includes('start_lt=100'));
      assert.ok(u.includes('sort=asc'));
      return {
        ok: true,
        json: async () => ({
          transactions: [
            { lt: '100', hash: 'h100', mc_block_seqno: 9001, in_msg: { source: BUYER, value: '990000000', message_content: { decoded: { comment: 'buy:old' } } } },
            { lt: '101', hash: 'h101', mc_block_seqno: 9002, in_msg: { source: BUYER, value: '990000000', message_content: { decoded: { comment: 'buy:ok' } } } },
            { lt: '102', hash: 'h102', mc_block_seqno: 0, in_msg: { source: BUYER, value: '990000000', message_content: { decoded: { comment: 'buy:unconfirmed' } } } },
          ],
        }),
      };
    },
  });
  const scanRes = await tcV3.fetchInboundTransfersSince(HOT, { cursorLt: '100', cursorHash: 'h100' });
  assert.equal(scanRes.transfers.length, 1);
  assert.equal(scanRes.transfers[0].memo, 'buy:ok');
  assert.deepEqual(scanRes.nextCursor, { lt: '101', hash: 'h101' });

  // 2) Non-toncenter v2 HTTP 500 falls back automatically to v3 /transactions
  let v2Tried = 0;
  let v3FallbackTried = 0;
  const tcFallback = new TonCenterClient({
    apiBase: 'https://custom-rpc.example/api/v2',
    apiKey: 'k',
    maxRetries: 1,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('/getTransactions')) {
        v2Tried += 1;
        return { ok: false, status: 500, json: async () => ({ ok: false, error: 'LITE_SERVER_UNKNOWN' }) };
      }
      if (u.includes('/api/v3/transactions')) {
        v3FallbackTried += 1;
        return {
          ok: true,
          json: async () => ({
            transactions: [
              { lt: '205', hash: 'h205', mc_block_seqno: 9900, in_msg: { source: BUYER, value: '990000000', message_content: { decoded: { comment: 'buy:fb' } } } },
            ],
          }),
        };
      }
      throw new Error(`unexpected url ${u}`);
    },
  });
  const fbRes = await tcFallback.fetchInboundTransfersSince(HOT, { cursorLt: '200', cursorHash: 'h200' });
  assert.ok(v2Tried >= 1);
  assert.equal(v3FallbackTried, 1);
  assert.equal(fbRes.transfers.length, 1);
  assert.equal(fbRes.transfers[0].memo, 'buy:fb');

  // 3) verifyOutboundPayout attaches start_utime + sort=desc, and holds REFUND PENDING when in_msg_tx_hash is null
  let seenRefundUrl = '';
  const tcVerify = new TonCenterClient({
    apiBase: 'https://testnet.toncenter.com/api/v2',
    apiKey: 'k',
    fetchImpl: async (url) => {
      seenRefundUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          messages: [
            {
              destination: BUYER,
              value: '990000000',
              bounced: false,
              in_msg_tx_hash: null,
              out_msg_tx_hash: 'out_only_1',
              message_content: { decoded: { comment: 'refund:42' } },
            },
          ],
        }),
      };
    },
  });
  const pendingRefund = await tcVerify.verifyOutboundPayout(HOT, {
    kind: 'REFUND',
    recipient: BUYER,
    amount: '990000000',
    queryId: '42',
    createdAt: 1795432000,
  });
  assert.ok(seenRefundUrl.includes('start_utime=1795431700'));
  assert.ok(seenRefundUrl.includes('sort=desc'));
  assert.equal(pendingRefund.state, 'PENDING');
  assert.equal(pendingRefund.reason, 'IN_MSG_NOT_DELIVERED');

  // 4) Broadcasters propagate baseEnv (including OPS_CONFIRM & OPS_CONFIRM_MAINNET)
  const capturedEnvs = [];
  const fakeSpawn = (_cmd, _args, opts) => {
    capturedEnvs.push(opts.env);
    return { status: 0, stdout: 'PROMO_PAYOUT_TX=0xdeadbeef\nGRAM_REFUND_TX=0xcafebabe\n', stderr: '' };
  };
  const promoBc = createActonPromoBroadcaster({
    network: 'mainnet',
    hotWalletName: 'promoHot',
    jettonMasterAddress: MASTER,
    baseEnv: { OPS_CONFIRM: 'YES', OPS_CONFIRM_MAINNET: 'YES', CUSTOM_SENTINEL: 'ok' },
    spawnImpl: fakeSpawn,
  });
  await promoBc({ recipient: BUYER, jettonAmountRaw: '1000', queryId: '7' });
  const refundBc = createActonGramRefundBroadcaster({
    network: 'mainnet',
    hotWalletName: 'presaleHot',
    baseEnv: { OPS_CONFIRM: 'YES', OPS_CONFIRM_MAINNET: 'YES', CUSTOM_SENTINEL: 'ok' },
    spawnImpl: fakeSpawn,
  });
  await refundBc({ recipient: BUYER, tonNano: '990000000', queryId: '8' });
  assert.equal(capturedEnvs[0].OPS_CONFIRM, 'YES');
  assert.equal(capturedEnvs[0].OPS_CONFIRM_MAINNET, 'YES');
  assert.equal(capturedEnvs[0].CUSTOM_SENTINEL, 'ok');
  assert.equal(capturedEnvs[1].OPS_CONFIRM, 'YES');
  assert.equal(capturedEnvs[1].OPS_CONFIRM_MAINNET, 'YES');

  // 5) payout-daemon isolates presaleRunner error so promoRunner still ticks and heartbeat logs status='degraded'
  const db = createSqliteD1(MIGRATIONS);
  let promoTicked = 0;
  const daemon = createPayoutDaemon({
    db,
    env: {
      A9_NETWORK: 'testnet',
      A9_SQLITE_PATH: '/tmp/unused.sqlite',
      TONCENTER_API_BASE: 'https://testnet.toncenter.com/api/v2',
      A9_PROMO_HOT_WALLET_ADDRESS: PROMO,
      A9_PRESALE_HOT_WALLET_ADDRESS: HOT,
      A9_RUNNER_ID: 'iso-daemon',
    },
    executeFlag: false,
    tonCenter: {
      fetchInboundTransfersSince: async (addr) => {
        if (addr === HOT) throw new Error('simulated presale rpc outage');
        promoTicked += 1;
        return { transfers: [], nextCursor: null, reachedCursor: true, truncated: false };
      },
    },
    logger: { log() {}, error() {} },
  });
  // Force uncaught throw from presaleRunner.tick directly to exercise daemon-level isolation
  daemon.presaleRunner.tick = async () => { throw new Error('boom presale'); };
  const tickOut = await daemon.runOnce(1795432500);
  assert.equal(promoTicked, 1);
  assert.equal(tickOut.errors.length, 1);
  assert.ok(tickOut.errors[0].includes('boom presale'));
  const hb = await db.prepare('SELECT meta_json FROM runner_heartbeats WHERE runner_id = ?').bind('iso-daemon').first();
  const meta = JSON.parse(hb.meta_json);
  assert.equal(meta.status, 'degraded');
  assert.ok(meta.lastError.includes('boom presale'));
});

await test('W2-8: Security audit regressions (queryId rotation, cursor freeze, v3 paging/hash/ms-ts, promo non-blocking errors, heartbeat gate, wallet isolation, CAS expiry)', async () => {
  const { PresaleHotWalletEngine, PAYOUT_STATUS } = await import('../src/presale-hotwallet.mjs');
  const { PresalePayoutRunner } = await import('../src/presale-runner.mjs');
  const { PromoPayoutRunner } = await import('../src/promo-runner.mjs');
  const { D1PredictionEngine } = await import('../src/d1-growth-store.mjs');
  const { createPayoutDaemon } = await import('../src/payout-daemon.mjs');
  const { validateDeployEnv } = await import('../src/cf-worker.mjs');
  const { addressKey } = await import('../src/ton-address.mjs');

  const HOT = '0:' + '12'.repeat(32);
  const PROMO = '0:' + '34'.repeat(32);
  const BUYER = '0:' + '56'.repeat(32);
  const MASTER = '0:' + '78'.repeat(32);

  // 1) P0-1: Presale & Promo retry rotates queryId, clears old txHash, and NEVER re-broadcasts in the same tick on FAILED
  const db1 = createSqliteD1(MIGRATIONS);
  const presale1 = new D1PresaleStore({ db: db1, hotWalletAddress: HOT, open: true });
  const ord = await presale1.createOrderIntent(BUYER, null, 2000, { skuId: 'chest_silver' });
  await presale1.ingestInbound(
    { txHash: 'in_rot_1', finality: 'finalized', to: HOT, from: BUYER, valueNano: ord.payTonNano, memo: ord.memo },
    2005,
  );
  await presale1.queueConfirmedPayouts(2006);
  const seenPresaleQids = [];
  // Tick 1: broadcast -> SENT; same-tick FAILED after fresh broadcast MUST NOT re-broadcast
  await presale1.processPayouts(2010, {
    a9Broadcaster: async (inst) => {
      seenPresaleQids.push(inst.queryId);
      return { txHash: `0xtx_${seenPresaleQids.length}` };
    },
    verifier: async () => ({ state: 'FAILED', reason: 'NOT_INDEXED_YET' }),
  });
  assert.equal(seenPresaleQids.length, 1);
  // Tick 2: SENT + verifier FAILED -> transitions to RETRY
  await presale1.processPayouts(2020, {
    a9Broadcaster: async (inst) => {
      seenPresaleQids.push(inst.queryId);
      return { txHash: `0xtx_${seenPresaleQids.length}` };
    },
    verifier: async () => ({ state: 'FAILED', reason: 'BOUNCED' }),
  });
  assert.equal(seenPresaleQids.length, 1);
  // Tick 3: RETRY -> rotates to a brand-new queryId, clears old txHash, and re-broadcasts
  await presale1.processPayouts(2030, {
    a9Broadcaster: async (inst) => {
      seenPresaleQids.push(inst.queryId);
      return { txHash: `0xtx_${seenPresaleQids.length}` };
    },
    verifier: async () => ({ state: 'PENDING' }),
  });
  assert.equal(seenPresaleQids.length, 2);
  assert.notEqual(seenPresaleQids[0], seenPresaleQids[1], 'presale retry MUST rotate queryId');

  // Same for PromoPayoutRunner + D1PromoStore
  const promo1 = new D1PromoStore({ db: db1, hotWalletAddress: PROMO });
  await promo1.creditReward(BUYER, 12_000n * 1_000_000_000n, 2000);
  const cl = await promo1.createClaimIntent(BUYER, 2001);
  await promo1.verifyInboundFeeTx({ txHash: 'fee_rot_1', finality: 'finalized', to: PROMO, from: BUYER, valueNano: '60000000', memo: cl.memo, utime: 2005 }, 2006);
  const seenPromoQids = [];
  let promoVerifyMode = 'FAILED';
  const promoRotRunner = new PromoPayoutRunner({
    engine: promo1,
    tonCenter: { fetchInboundTransfersSince: async () => ({ transfers: [], nextCursor: null, reachedCursor: true, truncated: false }) },
    broadcaster: async (inst) => {
      seenPromoQids.push(inst.queryId);
      return { txHash: `0xptx_${seenPromoQids.length}` };
    },
    payoutVerifier: async () => ({ state: promoVerifyMode, reason: promoVerifyMode }),
    execute: true,
    logger: { log() {}, error() {} },
  });
  // Tick 1: broadcast -> SENT; same-tick FAILED MUST NOT re-broadcast
  await promoRotRunner.tick(2010);
  assert.equal(seenPromoQids.length, 1);
  // Tick 2: SENT + FAILED -> RETRY
  await promoRotRunner.tick(2020);
  assert.equal(seenPromoQids.length, 1);
  // Tick 3: RETRY -> rotates queryId and re-broadcasts
  promoVerifyMode = 'PENDING';
  await promoRotRunner.tick(2030);
  assert.equal(seenPromoQids.length, 2);
  assert.notEqual(seenPromoQids[0], seenPromoQids[1], 'promo retry MUST rotate queryId');

  // 2) P0-2: v2 cursor stops strictly before unconfirmed tx & returns nextCursor: null when truncated; presale-runner freezes cursor on not_finalized
  const tcV2 = new TonCenterClient({
    apiBase: 'https://custom-v2.example/api/v2',
    apiKey: 'k',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: [
          { transaction_id: { lt: '303', hash: 'h303' }, utime: 3003, finality: 'unconfirmed', in_msg: { source: BUYER, value: '990000000', message: 'buy:u3' } },
          { transaction_id: { lt: '302', hash: 'h302' }, utime: 3002, finality: 'finalized', in_msg: { source: BUYER, value: '990000000', message: 'buy:f2' } },
          { transaction_id: { lt: '301', hash: 'h301' }, utime: 3001, finality: 'finalized', in_msg: { source: BUYER, value: '990000000', message: 'buy:f1' } },
        ],
      }),
    }),
  });
  const v2Scan = await tcV2.fetchInboundTransfersSince(HOT, { cursorLt: '300', cursorHash: 'h300', maxPages: 1 });
  assert.equal(v2Scan.reachedCursor, true);
  assert.deepEqual(v2Scan.nextCursor, { lt: '302', hash: 'h302' });

  const dbCur = createSqliteD1(MIGRATIONS);
  const prEngine = new D1PresaleStore({ db: dbCur, hotWalletAddress: HOT, open: true });
  const prRunner = new PresalePayoutRunner({
    engine: prEngine,
    tonCenter: {
      fetchInboundTransfersSince: async () => ({
        transfers: [{ txHash: 'nf_1', lt: '401', finality: 'unconfirmed', to: HOT, from: BUYER, valueNano: '990000000', memo: 'buy:pending' }],
        nextCursor: { lt: '401', hash: 'nf_1' },
        reachedCursor: true,
        truncated: false,
      }),
    },
    a9Broadcaster: async () => ({ txHash: '0xunused' }),
    execute: true,
    logger: { log() {}, error() {} },
  });
  await prRunner.tick(4000);
  assert.equal(await prEngine.repo.getScanCursor(HOT), null, 'presale-runner must NOT advance cursor when any inbound tx is not_finalized');

  // 3) P0-3: verifyOutboundPayout normalizes ms createdAt, paginates A9 (>50 rows), prefers CONFIRMED over FAILED, and normalizes 0xhex/base64 txHash
  let a9PageCalls = 0;
  const seenUrls = [];
  const rawHashHex = 'aa'.repeat(32);
  const rawHashB64 = Buffer.from(rawHashHex, 'hex').toString('base64');
  const tcP03 = new TonCenterClient({
    apiBase: 'https://testnet.toncenter.com/api/v2',
    apiKey: 'k',
    fetchImpl: async (url) => {
      const u = String(url);
      seenUrls.push(u);
      if (u.includes('/api/v3/jetton/transfers')) {
        a9PageCalls += 1;
        if (a9PageCalls === 1) {
          const filler = Array.from({ length: 50 }, (_, i) => ({
            query_id: String(1000 + i),
            destination: BUYER,
            amount: '1',
            transaction_hash: `fill_${i}`,
            transaction_aborted: false,
          }));
          return { ok: true, json: async () => ({ jetton_transfers: filler }) };
        }
        return {
          ok: true,
          json: async () => ({
            jetton_transfers: [
              { query_id: '5555', destination: BUYER, amount: '5000', transaction_hash: rawHashB64, transaction_aborted: false },
            ],
          }),
        };
      }
      if (u.includes('/api/v3/messages')) {
        return {
          ok: true,
          json: async () => ({
            messages: [
              { destination: BUYER, value: '990000000', bounced: true, in_msg_tx_hash: 'bad_1', out_msg_tx_hash: 'bad_out', message_content: { decoded: { comment: 'refund:777' } } },
              { destination: BUYER, value: '990000000', bounced: false, in_msg_tx_hash: 'ok_in', out_msg_tx_hash: rawHashB64, message_content: { decoded: { comment: 'refund:777' } } },
            ],
          }),
        };
      }
      throw new Error(`unexpected ${u}`);
    },
  });
  const a9Paged = await tcP03.verifyOutboundPayout(HOT, {
    kind: 'A9',
    recipient: BUYER,
    amount: '5000',
    queryId: '5555',
    createdAt: 1795432000000, // ms timestamp must normalize to seconds!
    jettonMasterAddress: MASTER,
  });
  assert.equal(a9Paged.state, 'CONFIRMED');
  assert.equal(a9PageCalls, 2);
  assert.ok(seenUrls[0].includes('start_utime=1795431700'), 'ms createdAt must normalize to seconds');
  assert.ok(seenUrls[0].includes('sort=asc'), 'A9 verification must paginate sort=asc');

  const refundConfirmed = await tcP03.verifyOutboundPayout(HOT, {
    kind: 'REFUND',
    recipient: BUYER,
    amount: '990000000',
    queryId: '777',
    txHash: `0x${rawHashHex}`, // 0xhex must match base64 out_msg_tx_hash
    createdAt: 1795432000,
  });
  assert.equal(refundConfirmed.state, 'CONFIRMED');

  // 4) P1-1: promo-runner advances cursor past deterministic INSUFFICIENT_FEE and evaluates expiry using tx.utime
  const dbP11 = createSqliteD1(MIGRATIONS);
  const promoP11 = new D1PromoStore({ db: dbP11, hotWalletAddress: PROMO });
  await promoP11.creditReward(BUYER, 12_000n * 1_000_000_000n, 5000);
  const clP11 = await promoP11.createClaimIntent(BUYER, 5001);
  // Paid on-chain at utime=5050 (well within expiry), scanned later at nowSec=clP11.expiresAt + 120 -> MUST STILL SUCCEED!
  const promoRunner = new PromoPayoutRunner({
    engine: promoP11,
    tonCenter: {
      fetchInboundTransfersSince: async () => ({
        transfers: [
          { txHash: 'bad_dust', lt: '601', utime: 5040, finality: 'finalized', to: PROMO, from: BUYER, valueNano: '1000', memo: clP11.memo },
          { txHash: 'good_fee', lt: '602', utime: 5050, finality: 'finalized', to: PROMO, from: BUYER, valueNano: '60000000', memo: clP11.memo },
        ],
        nextCursor: { lt: '602', hash: 'good_fee' },
        reachedCursor: true,
        truncated: false,
      }),
    },
    broadcaster: async () => ({ txHash: '0xpromo_p11_tx' }),
    payoutVerifier: async () => ({ state: 'PENDING' }),
    execute: true,
    logger: { log() {}, error() {} },
  });
  await promoRunner.tick(clP11.expiresAt + 120);
  const savedPromoCur = await promoP11.getScanCursor(PROMO);
  assert.equal(savedPromoCur?.lt, '602', 'deterministic INSUFFICIENT_FEE must not wedge promo cursor');
  assert.equal(savedPromoCur?.hash, 'good_fee');
  const paidClaim = await promoP11.getClaim(clP11.claimId);
  assert.equal(paidClaim.status, 'PAYOUT_SENT', 'tx.utime within claim window must pass expiry and broadcast even if scanned late');

  // 5) P1-2: Heartbeat gate rejects degraded, dry-run (executeLive:false), and wrong-network heartbeats; daemon skips heartbeat when all runners skipped
  const dbHb = createSqliteD1(MIGRATIONS);
  const nowHb = Math.floor(Date.now() / 1000);
  const idsHb = new MemoryIdentityStore();
  idsHb.bindVerifiedWallet('20002', BUYER, nowHb);
  const routerHb = createApiRouter({
    env: {
      A9_NETWORK: 'mainnet',
      A9_BOT_TOKEN: TEST_BOT_TOKEN,
      A9_PRESALE_OPEN: '1',
      A9_REQUIRE_RUNNER_HEARTBEAT: '1',
      A9_RUNNER_HEARTBEAT_MAX_STALE_SEC: '120',
    },
    stateStore: { getTiming: () => ({}), getProtocolState: () => ({ dataAvailable: true, currentRoundId: 1 }), listRounds: () => [], getRound: () => null },
    presaleEngine: new D1PresaleStore({ db: dbHb, hotWalletAddress: HOT, open: true }),
    identityStore: idsHb,
    runnerHeartbeatReader: async () => (await dbHb.prepare('SELECT runner_id, role, network, last_seen_at, meta_json FROM runner_heartbeats').all()).results || [],
  });
  const hdrsHb = await tgHeaders('20002', { authDate: nowHb });
  // Insert 3 invalid heartbeats: degraded, dry-run, wrong-network
  await dbHb.prepare('INSERT INTO runner_heartbeats (runner_id, role, network, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)')
    .bind('bad_deg', 'payout_daemon', 'mainnet', nowHb - 5, JSON.stringify({ status: 'degraded', executeLive: true })).run();
  await dbHb.prepare('INSERT INTO runner_heartbeats (runner_id, role, network, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)')
    .bind('bad_dry', 'payout_daemon', 'mainnet', nowHb - 5, JSON.stringify({ status: 'ok', executeLive: false })).run();
  await dbHb.prepare('INSERT INTO runner_heartbeats (runner_id, role, network, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)')
    .bind('bad_net', 'payout_daemon', 'testnet', nowHb - 5, JSON.stringify({ status: 'ok', executeLive: true })).run();

  const rejHb = await routerHb({ method: 'POST', pathname: '/api/presale/intent', headers: hdrsHb, body: { skuId: 'chest_bronze', openMode: 'BOOST' }, nowSec: nowHb });
  assert.equal(rejHb.status, 503);
  assert.equal(rejHb.body.error.code, 'PAYOUT_RUNNER_OFFLINE');

  // Insert one healthy mainnet live heartbeat -> passes
  await dbHb.prepare('INSERT INTO runner_heartbeats (runner_id, role, network, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)')
    .bind('good_live', 'payout_daemon', 'mainnet', nowHb - 5, JSON.stringify({ status: 'ok', executeLive: true })).run();
  const okHb = await routerHb({ method: 'POST', pathname: '/api/presale/intent', headers: hdrsHb, body: { skuId: 'chest_bronze', openMode: 'BOOST' }, nowSec: nowHb });
  assert.equal(okHb.status, 200);

  // Daemon allSkipped must NOT write heartbeat
  const dbSkip = createSqliteD1(MIGRATIONS);
  const dSkip = createPayoutDaemon({
    db: dbSkip,
    env: {
      A9_NETWORK: 'testnet',
      A9_SQLITE_PATH: ':memory:',
      TONCENTER_API_BASE: 'https://testnet.toncenter.com/api/v2',
      A9_PROMO_HOT_WALLET_ADDRESS: PROMO,
      A9_PRESALE_HOT_WALLET_ADDRESS: HOT,
      A9_RUNNER_ID: 'skip-daemon',
    },
    executeFlag: false,
    logger: { log() {}, error() {} },
  });
  dSkip.presaleRunner.tick = async () => ({ skipped: true, reason: 'disabled' });
  dSkip.promoRunner.tick = async () => ({ skipped: true, reason: 'disabled' });
  await dSkip.runOnce(9000);
  const skipHb = await dbSkip.prepare('SELECT * FROM runner_heartbeats WHERE runner_id = ?').bind('skip-daemon').first();
  assert.equal(skipHb, null, 'daemon MUST NOT record heartbeat when all runners are skipped');

  // 6) P1-3: cf-worker validateDeployEnv rejects identical promo/presale hot wallets across raw & friendly formats
  const isoRes = validateDeployEnv({
    A9_PROMO_HOT_WALLET_ADDRESS: 'kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT18',
    A9_PRESALE_HOT_WALLET_ADDRESS: addressKey('kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT18'),
  });
  assert.equal(isoRes.ok, false);
  assert.equal(isoRes.code, 'HOT_WALLET_ISOLATION_VIOLATION');

  // 7) P1-4: D1PredictionEngine.activateToPromo CAS expiry cleanup never wipes concurrently credited new rewards
  const dbExp = createSqliteD1(MIGRATIONS);
  const promoExp = new D1PromoStore({ db: dbExp, hotWalletAddress: PROMO });
  const predExp = new D1PredictionEngine({ db: dbExp });
  await predExp.creditPendingBonus('u_exp', 500n * 1_000_000_000n, 1_000_000);
  // Set pending_expires_at in the past so activateToPromo enters expiry branch
  await dbExp.prepare('UPDATE prediction_rewards SET pending_expires_at = ? WHERE user_id = ?').bind(1_100_000, 'u_exp').run();
  // Intercept the expiry UPDATE to simulate concurrent settleRoundBets adding 2,000 A9 and extending pending_expires_at right before expiry cleanup runs
  const origPrep = dbExp.prepare.bind(dbExp);
  let injectedNew = false;
  dbExp.prepare = (sql) => {
    if (!injectedNew && sql.includes("SET pending_activation_raw = '0', pending_expires_at = NULL") && sql.includes('AND pending_activation_raw = ?')) {
      injectedNew = true;
      // Synchronously bump row before this CAS statement runs
      origPrep('UPDATE prediction_rewards SET pending_activation_raw = ?, pending_expires_at = ? WHERE user_id = ?')
        .bind((2_000n * 1_000_000_000n).toString(), 9_999_999, 'u_exp')
        .run();
    }
    return origPrep(sql);
  };
  await assert.rejects(
    () => predExp.activateToPromo('u_exp', BUYER, promoExp, { qualified: true, nowMs: 1_200_000, activationId: 'exp_race_1' }),
    /VOUCHER_EXPIRED|已过期/,
  );
  assert.equal(injectedNew, true);
  const afterRace = await predExp.getUserSummary('u_exp');
  assert.equal(afterRace.pendingActivationRaw, (2_000n * 1_000_000_000n).toString(), 'CAS expiry cleanup MUST NOT wipe newly credited reward');
});

await test('W2-9: Final audit fixes (v3 cold/asc cursor advancement without deadlock, mainnet v16 production gate, corrupt heartbeat fail-closed, retry updatedAt anchor)', async () => {
  const { PresalePayoutRunner } = await import('../src/presale-runner.mjs');
  const { PromoPayoutRunner } = await import('../src/promo-runner.mjs');
  const { default: cfWorker, validateDeployEnv } = await import('../src/cf-worker.mjs');

  const HOT = '0:' + '21'.repeat(32);
  const PROMO = '0:' + '43'.repeat(32);
  const BUYER = '0:' + '65'.repeat(32);
  const MASTER = '0:' + '87'.repeat(32);
  const RC = '0:' + '98'.repeat(32);

  // 1) P0: v3 cold-start with >=30 historical txs sets canAdvanceCursor=true so runners persist initial cursor
  const coldRows = Array.from({ length: 30 }, (_, i) => ({
    lt: String(1000 - i),
    hash: `cold_${1000 - i}`,
    mc_block_seqno: 5000,
    utime: 1795432000 - i,
    in_msg: { source: BUYER, value: '1000000', message_content: { decoded: { comment: '' } } },
  }));
  const tcCold = new TonCenterClient({
    apiBase: 'https://testnet.toncenter.com/api/v2',
    apiKey: 'k',
    fetchImpl: async () => ({ ok: true, json: async () => ({ transactions: coldRows }) }),
  });
  const coldRes = await tcCold.fetchInboundTransfersSince(HOT, {});
  assert.equal(coldRes.truncated, true);
  assert.equal(coldRes.canAdvanceCursor, true);
  assert.deepEqual(coldRes.nextCursor, { lt: '1000', hash: 'cold_1000' });

  const dbCold = createSqliteD1(MIGRATIONS);
  const prCold = new D1PresaleStore({ db: dbCold, hotWalletAddress: HOT, open: true });
  const prColdRunner = new PresalePayoutRunner({
    engine: prCold,
    tonCenter: tcCold,
    a9Broadcaster: async () => ({ txHash: '0xunused' }),
    execute: true,
    logger: { log() {}, error() {} },
  });
  await prColdRunner.tick(1795432500);
  assert.equal((await prCold.repo.getScanCursor(HOT))?.lt, '1000', 'cold-start >=30 txs must persist initial cursor');

  // 2) P0: v3 incremental sort=asc hitting maxPages (truncated=true) MUST STILL advance cursor to catch up in batches
  let ascPages = 0;
  const tcAscTrunc = new TonCenterClient({
    apiBase: 'https://testnet.toncenter.com/api/v2',
    apiKey: 'k',
    fetchImpl: async (url) => {
      ascPages += 1;
      const u = new URL(String(url));
      const baseLt = Number(u.searchParams.get('start_lt') || 1000);
      const batch = Array.from({ length: 2 }, (_, i) => ({
        lt: String(baseLt + i + 1),
        hash: `asc_${baseLt + i + 1}`,
        mc_block_seqno: 5100,
        utime: 1795432600 + i,
        in_msg: { source: BUYER, value: '1000000', message_content: { decoded: { comment: '' } } },
      }));
      return { ok: true, json: async () => ({ transactions: batch }) };
    },
  });
  const ascRes = await tcAscTrunc.fetchInboundTransfersSince(HOT, {
    cursorLt: '1000',
    cursorHash: 'cold_1000',
    pageSize: 2,
    maxPages: 2,
  });
  assert.equal(ascPages, 2);
  assert.equal(ascRes.truncated, true);
  assert.equal(ascRes.canAdvanceCursor, true, 'v3 ascending scan has no gaps and must advance cursor even when truncated');
  assert.deepEqual(ascRes.nextCursor, { lt: '1005', hash: 'asc_1005' });

  // PromoPayoutRunner advances cursor on v3 truncated asc batch (no deadlock)
  const promoAsc = new D1PromoStore({ db: dbCold, hotWalletAddress: PROMO });
  await promoAsc.saveScanCursor(PROMO, { lt: '1000', hash: 'cold_1000' }, 1795432500);
  const promoAscRunner = new PromoPayoutRunner({
    engine: promoAsc,
    tonCenter: { fetchInboundTransfersSince: async () => ascRes },
    broadcaster: async () => ({ txHash: '0xunused' }),
    execute: true,
    logger: { log() {}, error() {} },
  });
  await promoAscRunner.tick(1795432700);
  assert.equal((await promoAsc.getScanCursor(PROMO))?.lt, '1005', 'promo-runner must advance cursor on gapless v3 asc batch');

  // 3) P1-5: mainnet + v16 + A9_PRESALE_OPEN=1 MUST hit production validation and enforce A9_BOT_TOKEN
  const prodV16Check = validateDeployEnv({
    DB: dbCold,
    A9_NETWORK: 'mainnet',
    A9_ENVIRONMENT: 'production',
    A9_PROTOCOL_VERSION: 'v16',
    A9_PRESALE_OPEN: '1',
    A9_JETTON_MASTER_ADDRESS: MASTER,
    A9_ROUND_CONTROLLER_ADDRESS: RC,
    A9_PROMO_HOT_WALLET_ADDRESS: PROMO,
    A9_PRESALE_HOT_WALLET_ADDRESS: HOT,
    A9_PUBLIC_ORIGIN: 'https://app.a9.lat',
    A9_TON_PROOF_DOMAINS: 'app.a9.lat',
    A9_ALLOWED_ORIGINS: 'https://app.a9.lat',
    // A9_BOT_TOKEN intentionally omitted
  });
  assert.equal(prodV16Check.ok, false);
  assert.equal(prodV16Check.code, 'PRODUCTION_CONFIG_INCOMPLETE');
  assert.ok(prodV16Check.missing.includes('A9_BOT_TOKEN'), 'mainnet v16 with presale open must require A9_BOT_TOKEN');

  // 4) P2-2: corrupt runner_heartbeats.meta_json parses as { status: 'invalid' } (fail-closed in cf-worker /api/health & gate)
  const dbCorrupt = createSqliteD1(MIGRATIONS);
  const nowS = Math.floor(Date.now() / 1000);
  await dbCorrupt.prepare('INSERT INTO runner_heartbeats (runner_id, role, network, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?)')
    .bind('corrupt_1', 'payout_daemon', 'testnet', nowS - 5, '{corrupt_json').run();
  const hRes = await cfWorker.fetch(new Request('https://api.a9.lat/api/health'), { DB: dbCorrupt, A9_NETWORK: 'testnet' });
  const hBody = await hRes.json();
  assert.equal(hBody.data.checks.runnerHeartbeats[0].meta?.status, 'invalid');

  // 5) P2-1: verifyOutboundPayout uses updatedAt anchor for retry attempts > 1
  let retryUrl = '';
  const tcRetry = new TonCenterClient({
    apiBase: 'https://testnet.toncenter.com/api/v2',
    apiKey: 'k',
    fetchImpl: async (url) => {
      retryUrl = String(url);
      return { ok: true, json: async () => ({ jetton_transfers: [] }) };
    },
  });
  await tcRetry.verifyOutboundPayout(HOT, {
    kind: 'A9',
    recipient: BUYER,
    amount: '1000',
    queryId: '9999',
    attempts: 2,
    createdAt: 1795400000,
    updatedAt: 1795450000,
    jettonMasterAddress: MASTER,
  });
  assert.ok(retryUrl.includes('start_utime=1795449700'), 'retry attempt > 1 should anchor start_utime to updatedAt - 300');
});

await test('v17 default protocol validation, D1PromoStore WRONG_PAYER check, and NEEDS_REVIEW chain-verified recovery', async () => {
  const { buildV15ConfigPayload } = await import('../src/v15-indexer.mjs');
  const { validateDaemonConfig } = await import('../src/payout-daemon.mjs');
  assert.equal(buildV15ConfigPayload({}, null).protocolVersion, 'v17');
  assert.throws(() => buildV15ConfigPayload({ A9_PROTOCOL_VERSION: 'v14' }, null), /Unsupported A9_PROTOCOL_VERSION/);
  const baseDaemonEnv = {
    A9_NETWORK: 'testnet',
    A9_SQLITE_PATH: ':memory:',
    TONCENTER_API_BASE: 'https://testnet.toncenter.com/api/v2',
    A9_PROMO_HOT_WALLET_ADDRESS: 'kQDNHik_ofaZns7ki5yuMYHMHODiRSs_lcTG9R5p2iyJwt4X',
  };
  assert.equal(validateDaemonConfig(baseDaemonEnv).protocolVersion, 'v17');
  assert.throws(() => validateDaemonConfig({ ...baseDaemonEnv, A9_PROTOCOL_VERSION: 'bad' }), /Unsupported A9_PROTOCOL_VERSION/);

  const db = createSqliteD1(MIGRATIONS);
  const HOT = 'kQDNHik_ofaZns7ki5yuMYHMHODiRSs_lcTG9R5p2iyJwt4X';
  const USER = 'kQAZFnSDKMIwiflOo8YWiNweqnxTRuwejtg7qmic4pjf1rIP';
  const STRANGER = 'kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT18';
  const store = new D1PromoStore({ db, hotWalletAddress: HOT });
  await store.creditReward(USER, '10000000000000', 1000);
  const intent = await store.createClaimIntent(USER, 1001);

  await assert.rejects(
    () => store.verifyInboundFeeTx({ txHash: 'wrong-payer-tx', finality: 'finalized', to: HOT, from: STRANGER, valueNano: '60000000', memo: intent.memo }, 1005),
    { code: 'WRONG_PAYER' },
  );

  await store.verifyInboundFeeTx({ txHash: 'ok-payer-tx', finality: 'finalized', to: HOT, from: USER, valueNano: '60000000', memo: intent.memo }, 1006);
  const [p] = await store.listOpenPromoPayouts();
  await store.markPromoPayoutNeedsReview(p.payoutId, 'manual test escalation', 1010);

  // 1) Uncertain/PENDING on-chain state MUST refuse re-queue (prevents double payout)
  await assert.rejects(
    () => store.resolvePromoPayoutReview(p.payoutId, { payoutVerifier: async () => ({ state: 'PENDING' }), nowSec: 1020 }),
    { code: 'PAYOUT_STILL_UNCERTAIN' },
  );
  // 2) NOT_FOUND on-chain safely re-queues with a fresh rotated queryId
  const req = await store.resolvePromoPayoutReview(p.payoutId, { payoutVerifier: async () => ({ state: 'NOT_FOUND' }), nowSec: 1030 });
  assert.equal(req.action, 'REQUEUED');
  assert.notEqual(req.queryId, p.queryId);

  // 3) If escalated again and later confirmed on-chain, resolves directly to COMPLETED without re-sending
  await store.markPromoPayoutNeedsReview(p.payoutId, 'escalated again', 1040);
  const settled = await store.resolvePromoPayoutReview(p.payoutId, {
    payoutVerifier: async () => ({ state: 'CONFIRMED', txHash: '0xchain_confirmed' }),
    nowSec: 1050,
  });
  assert.equal(settled.action, 'COMPLETED_FROM_CHAIN');
  assert.equal(settled.claim.status, CLAIM_STATUS.COMPLETED);
  assert.equal(settled.claim.payoutTxHash, '0xchain_confirmed');
});

await test('Audit hardening: /api/user/:wallet max 10 rounds (default 8), /api/health v16.0.0, monotonic throttle, D1 cache LIMIT 12 & full write rate limits', async () => {
  const { checkEdgeRateLimit, readCachedRoundsFromD1 } = await import('../src/cf-worker.mjs');
  const { TonCenterClient, encodeAddressSliceBoc } = await import('../src/toncenter.mjs');
  const router = createApiRouter({
    env: { A9_BOT_TOKEN: TEST_BOT_TOKEN },
    stateStore: {
      getTiming: () => ({ observationSeconds: 86400 }),
      getProtocolState: () => ({ currentRoundId: 20 }),
      listRounds: () => [],
      getRound: () => null,
    },
  });
  const h = await router({ method: 'GET', pathname: '/api/health', nowSec: 1000 });
  assert.equal(h.status, 200);
  assert.equal(h.body.data.version, '17.0.0');

  const defRange = await router({
    method: 'GET',
    pathname: '/api/user/EQ_RANGE_DEFAULT',
    nowSec: 1000,
  });
  assert.equal(defRange.status, 200);
  assert.deepEqual(defRange.body.data.ticketRange, { fromRound: 13, toRound: 20, currentRoundId: 20 });

  const tooWide = await router({
    method: 'GET',
    pathname: '/api/user/EQ_RANGE_TEST',
    query: { fromRound: '1', toRound: '11' },
    nowSec: 1000,
  });
  assert.equal(tooWide.status, 400);
  assert.match(tooWide.body.error.message, /exceed 10 rounds/);

  const okWide = await router({
    method: 'GET',
    pathname: '/api/user/EQ_RANGE_TEST',
    query: { fromRound: '1', toRound: '10' },
    nowSec: 1000,
  });
  assert.equal(okWide.status, 200);
  assert.equal(okWide.body.data.ticketRange.fromRound, 1);
  assert.equal(okWide.body.data.ticketRange.toRound, 10);

  // checkEdgeRateLimit rejects once quota exceeded for all covered write/read endpoints
  const ip = `198.51.100.${Math.floor(Math.random() * 200 + 10)}`;
  for (const [method, path, limit] of [
    ['GET', '/api/user/EQ_ABC', 30],
    ['POST', '/api/presale/intent', 20],
    ['POST', '/api/promo/intent', 20],
    ['POST', '/api/chests/ch_123/assist', 30],
    ['POST', '/api/team/bind-tg', 20],
    ['POST', '/api/team/verify-tg', 20],
    ['POST', '/api/team/join', 30],
    ['POST', '/api/progression/claim', 30],
    ['POST', '/api/warmup/cancel', 30],
    ['POST', '/api/referral/attribution', 30],
    ['POST', '/api/prediction/activate', 20],
  ]) {
    for (let i = 0; i < limit; i += 1) {
      assert.equal(checkEdgeRateLimit(method, path, ip, 5000).allowed, true);
    }
    assert.equal(checkEdgeRateLimit(method, path, ip, 5000).allowed, false, `${method} ${path} must rate-limit`);
  }

  // fetchUserPortfolio executes bounded concurrency and preserves ascending round order
  const ownerRaw = '0:' + '11'.repeat(32);
  const rcRaw = '0:' + '22'.repeat(32);
  const ownerBoc = encodeAddressSliceBoc(ownerRaw);
  const tc = new TonCenterClient({ apiBase: 'https://mock.local/v2', minIntervalMs: 0, maxRetries: 0 });
  tc.fetchUserTicket = async (_rc, _owner, rId) => {
    await new Promise((r) => setTimeout(r, (10 - rId) * 2));
    return {
      roundId: rId,
      ticketAddress: ownerBoc,
      amountRaw: String(rId * 1000),
      rewardClaimedRaw: '0',
      principalDone: false,
      pending: false,
    };
  };
  const pf = await tc.fetchUserPortfolio(ownerRaw, { roundControllerAddress: rcRaw, roundIds: [1, 2, 3, 4, 5, 6] });
  assert.equal(pf.ticketsAvailable, true);
  assert.deepEqual(pf.tickets.map((t) => t.roundId), [1, 2, 3, 4, 5, 6]);

  // Monotonic slot reservation serializes concurrent TonCenter HTTP requests instead of bursting 4 simultaneously
  const fetchTimestamps = [];
  const throttledTc = new TonCenterClient({
    apiBase: 'https://mock.local/v2',
    minIntervalMs: 35,
    maxRetries: 0,
    fetchImpl: async () => {
      fetchTimestamps.push(Date.now());
      return { ok: true, status: 200, json: async () => ({ ok: true, result: 'ok' }) };
    },
  });
  await Promise.all([1, 2, 3, 4].map((i) => throttledTc._requestUrl(`https://mock.local/v2/test?i=${i}`, `test-${i}`)));
  assert.equal(fetchTimestamps.length, 4);
  fetchTimestamps.sort((a, b) => a - b);
  for (let i = 1; i < fetchTimestamps.length; i += 1) {
    assert.ok(fetchTimestamps[i] - fetchTimestamps[i - 1] >= 25, `request gap too small: ${fetchTimestamps[i] - fetchTimestamps[i - 1]}ms`);
  }
  assert.ok(fetchTimestamps[3] - fetchTimestamps[0] >= 90, `total span too short: ${fetchTimestamps[3] - fetchTimestamps[0]}ms`);

  // readCachedRoundsFromD1 returns at most latest 12 rounds (9..20 ascending) and excludes round_candles from rounds 1..8
  const db = createSqliteD1(MIGRATIONS);
  const nowSec = 1_800_000_000;
  for (let r = 1; r <= 20; r += 1) {
    await db
      .prepare(
        `INSERT INTO rounds_cache (round_id, status, target_price_usd_e8, twap_24h_usd_e8, stake_open_at, stake_close_at, updated_at)
         VALUES (?, 'SUCCEEDED', '232000', '116000', ?, ?, ?)`,
      )
      .bind(r, nowSec - 1000, nowSec - 100, nowSec)
      .run();
    await db
      .prepare(
        `INSERT INTO round_candles (round_id, candle_index, period_start, period_end, twap_price_usd_e8, qualified)
         VALUES (?, 0, ?, ?, '240000', 1)`,
      )
      .bind(r, nowSec - 900, nowSec - 800)
      .run();
  }
  const cachedRounds = await readCachedRoundsFromD1(db, nowSec);
  assert.equal(cachedRounds.length, 12);
  assert.deepEqual(cachedRounds.map((x) => x.roundId), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.ok(cachedRounds.every((x) => x.candles.length === 1 && x.candles[0].twapPriceUsdE8 === '240000'));
});

await test('Batch B: claim preview, payout-daemon budget/rebind, Masterchain & pending-rebind guards, bot-in-group verify, edge security & health redaction', async () => {
  const { computeTicketClaimPreview } = await import('../src/v15-indexer.mjs');
  const { verifyTonProof } = await import('../src/auth.mjs');
  const { createTelegramBotGroupVerifier } = await import('../src/social-store.mjs');
  const { validateDaemonConfig, createPayoutDaemon } = await import('../src/payout-daemon.mjs');
  const { default: cfWorker, validateDeployEnv, routeNeedsChainState, buildNormalizedOgCacheUrl } = await import('../src/cf-worker.mjs');
  const { formatTonAddress } = await import('../src/ton-address.mjs');
  const { D1PromoStore } = await import('../src/d1-promo-store.mjs');
  const { D1PromoBudgetLedger } = await import('../src/promo-budget.mjs');
  const { D1PresaleStore } = await import('../src/d1-growth-store.mjs');

  const W1 = '0:' + 'a1'.repeat(32);
  const W2 = '0:' + 'b2'.repeat(32);
  const HOT = '0:' + 'c3'.repeat(32);
  const PROMO = '0:' + 'd4'.repeat(32);
  const MASTER = '0:' + 'e5'.repeat(32);
  const RC = '0:' + 'f6'.repeat(32);
  const TEST_ONLY_ADDR = formatTonAddress(0, new Uint8Array(32).fill(0x22), { bounceable: true, testOnly: true });

  // 1) computeTicketClaimPreview mirrors RoundController.tolk v17.0 (24H lock early-exit, failed 95%/90% stop-loss, 14D linear vesting + 30% instant cashout)
  const rActive = { status: 1, stakeOpenAt: 1000, stakeCloseAt: 2000, totalStakeRaw: '1000000000000', earlyStakeRaw: '400000000000', rewardBudgetRaw: '5000000000000', immediateBps: 2000, vestingSeconds: 14 * 86400 };
  const tBase = { roundId: 1, amountRaw: '1000000000000', earlyAmountRaw: '400000000000', lateAmountRaw: '600000000000', lockedClaimedRaw: '0', principalDone: false, immediateClaimed: false, exited: false, forfeited: false, pending: false };
  // 24H 锁仓期内可提前解押（退 85% / 烧 15%）；进入 12H 冲价期封盘禁出
  const pActiveLock = computeTicketClaimPreview(tBase, rActive, null, 1500);
  assert.equal(pActiveLock.canClaim, false);
  assert.equal(pActiveLock.canEarlyExit, true);
  assert.equal(pActiveLock.earlyExitRefundRaw, '850000000000');
  assert.equal(pActiveLock.earlyExitBurnRaw, '150000000000');
  const pActivePush = computeTicketClaimPreview(tBase, rActive, null, 2000);
  assert.equal(pActivePush.canEarlyExit, false);

  // 未通关永不爆仓：头矿 400*95%=380 + 普通 600*90%=540 => 退 920 A9，烧 80 A9
  const rFailed = { ...rActive, status: 3, settledAt: 3000 };
  const pFailed = computeTicketClaimPreview(tBase, rFailed, null, 3100);
  assert.equal(pFailed.canClaim, true);
  assert.equal(pFailed.roundState, 'FAILED_PERMANENT');
  assert.equal(pFailed.claimablePrincipalRaw, '920000000000');
  assert.equal(pFailed.burnedPrincipalRaw, '80000000000');

  // 通关 5x = 5,000 A9（1,000 秒提 + 4,000 分 14 天解锁）；第 7 天已解锁 2,000，未解锁 2,000 支持 3 折急提（实拿 600 / 烧 1,400）
  const rSucc = { ...rActive, status: 2, settledAt: 3000, immediateBps: 2000, vestingSeconds: 14 * 86400 };
  const pSuccDay7 = computeTicketClaimPreview(tBase, rSucc, null, 3000 + 7 * 86400);
  assert.equal(pSuccDay7.canClaim, true);
  assert.equal(pSuccDay7.claimablePrincipalRaw, '1000000000000');
  assert.equal(pSuccDay7.claimableRewardRaw, '3000000000000');
  assert.equal(pSuccDay7.claimableTotalRaw, '4000000000000');
  assert.equal(pSuccDay7.lockedRemainingRaw, '2000000000000');
  assert.equal(pSuccDay7.canInstantCashout, true);
  assert.equal(pSuccDay7.instantCashoutBonusRaw, '600000000000');
  assert.equal(pSuccDay7.instantCashoutBurnRaw, '1400000000000');
  assert.equal(pSuccDay7.instantCashoutTotalRaw, '4600000000000');
  assert.equal(pSuccDay7.unlockedPctBps, 6000);

  // Day 14+ 满期后：100% 解锁，canInstantCashout=false，0 销毁
  const pSuccDay20 = computeTicketClaimPreview(
    { ...tBase, principalDone: true, immediateClaimed: true, lockedClaimedRaw: '2000000000000' },
    rSucc,
    null,
    3000 + 20 * 86400,
  );
  assert.equal(pSuccDay20.claimableRewardRaw, '2000000000000');
  assert.equal(pSuccDay20.lockedRemainingRaw, '0');
  assert.equal(pSuccDay20.canInstantCashout, false);
  assert.equal(pSuccDay20.instantCashoutBurnRaw, '0');
  assert.equal(pSuccDay20.unlockedPctBps, 10000);

  const rAborted = { ...rActive, status: 4, settledAt: 3000 };
  const pAborted = computeTicketClaimPreview(tBase, rAborted, null, 3100);
  assert.equal(pAborted.canClaim, true);
  assert.equal(pAborted.claimablePrincipalRaw, '1000000000000');
  assert.equal(pAborted.claimableRewardRaw, '0');

  // 2) verifyTonProof rejects Masterchain (-1:...) addresses
  await assert.rejects(
    () => verifyTonProof({
      address: '-1:' + '11'.repeat(32),
      network: '-239',
      proof: { timestamp: 1000, domain: { lengthBytes: 10, value: 'app.a9.lat' }, payload: 'p', signature: 'AA==' },
      expectedNetwork: '-239',
      allowedDomains: ['app.a9.lat'],
      nowSec: 1000,
    }),
    /Basechain/i,
  );

  // 3) Pending rebind blocks new /api/promo/intent & canPromoteRebind holds promotion while a promo claim is in flight
  const db = createSqliteD1(MIGRATIONS);
  const promo = new D1PromoStore({ db, hotWalletAddress: PROMO });
  await promo.creditReward(W1, '100000000000', 'test', 1000);
  const idStore = new MemoryIdentityStore();
  await idStore.bindVerifiedWallet('7001', W1, 1000);
  const router = createApiRouter({
    env: { A9_BOT_TOKEN: TEST_BOT_TOKEN, A9_NETWORK: 'testnet', A9_ADMIN_TOKEN: 'adm_secret_1' },
    stateStore: {
      getTiming: () => ({ observationSeconds: 86400 }),
      getProtocolState: () => ({ dataAvailable: true, currentRoundId: 1, successCount: 1, poolRemainingRaw: '100000000000000', poolExhaustedAt: 0 }),
      listRounds: () => [{ roundId: 1, round: rSucc, candles: [] }],
      getRound: (id) => (Number(id) === 1 ? { roundId: 1, round: rSucc, candles: [] } : null),
    },
    promoEngine: promo,
    identityStore: idStore,
    userReader: async () => ({
      jettonWallet: '0:' + '77'.repeat(32),
      a9BalanceRaw: '2000000000000',
      balanceAvailable: true,
      tickets: [tBase],
      ticketsAvailable: true,
      onchainAvailable: true,
    }),
    healthChecker: async () => ({
      ok: true,
      db: { bound: true, ok: true, error: 'internal-secret-err' },
      cacheAgeSec: 2,
      runnerHeartbeats: [{ runnerId: 'r1', role: 'payout_daemon', network: 'testnet', lastSeenAt: 1000, meta: { status: 'ok', lastError: 'secret-stack' } }],
    }),
  });

  // /api/user/:wallet returns enriched ticket preview & root claimableRaw/lockedRaw (at Day 7 of 14-day vesting)
  const uRes = await router({ method: 'GET', pathname: `/api/user/${encodeURIComponent(W1)}`, nowSec: 3000 + 7 * 86400 });
  assert.equal(uRes.status, 200);
  assert.equal(uRes.body.data.claimableRaw, '4000000000000');
  assert.equal(uRes.body.data.lockedRaw, '2000000000000');
  assert.equal(uRes.body.data.tickets[0].canClaim, true);

  // /api/health redacts sensitive internal errors for public callers, reveals full checks for admin
  const pubH = await router({ method: 'GET', pathname: '/api/health', nowSec: 3100 });
  assert.equal(pubH.body.data.checks.db.error, undefined);
  assert.equal(pubH.body.data.checks.runnerHeartbeats[0].meta.lastError, undefined);
  assert.equal(pubH.body.data.checks.runnerHeartbeats[0].meta.status, 'ok');
  const admH = await router({ method: 'GET', pathname: '/api/health', headers: { 'x-a9-admin-token': 'adm_secret_1' }, nowSec: 3100 });
  assert.equal(admH.body.data.checks.db.error, 'internal-secret-err');
  assert.equal(admH.body.data.checks.runnerHeartbeats[0].meta.lastError, 'secret-stack');

  // Pending rebind blocks POST /api/promo/intent with 409 PENDING_REBIND_ACTIVE
  await idStore.bindVerifiedWallet('7001', W2, 1005, { rebindDelaySec: 86400 });
  const tgHdr = await tgHeaders('7001', { authDate: 1010 });
  const blockedPromo = await router({ method: 'POST', pathname: '/api/promo/intent', headers: tgHdr, body: {}, nowSec: 1010 });
  assert.equal(blockedPromo.status, 409);
  assert.equal(blockedPromo.body.error.code, 'PENDING_REBIND_ACTIVE');

  // Active in-flight claim pauses rebind promotion even after effectiveAt
  await idStore.bindVerifiedWallet('7001', W2, 1005, { rebindDelaySec: 60 });
  await promo.createClaimIntent(W1, 1011);
  const pausedBind = await idStore.getBinding('7001', 1005 + 60 + 10);
  assert.equal(pausedBind.walletKey, W1, 'rebind promotion MUST pause while old wallet has active in-flight claim');

  // 4) createTelegramBotGroupVerifier rejects public supergroup where Bot itself is not a member
  const verifier = createTelegramBotGroupVerifier('999:token', async (url) => {
    const u = String(url);
    if (u.includes('/getChat?')) return { ok: true, json: async () => ({ ok: true, result: { id: -100777, type: 'supergroup' } }) };
    if (u.endsWith('/getMe')) return { ok: true, json: async () => ({ ok: true, result: { id: 999 } }) };
    if (u.includes('/getChatMember?') && u.includes('user_id=999')) {
      return { ok: true, json: async () => ({ ok: true, result: { status: 'left' } }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: { status: 'creator' } }) };
  });
  const vRes = await verifier({ tgGroupHandle: '@public_group_no_bot', telegramUserId: '7001' });
  assert.equal(vRes.botInGroup, false);
  assert.equal(vRes.reason, 'BOT_NOT_IN_GROUP');

  // 5) payout-daemon mainnet validation & budgetLedger wiring
  assert.throws(
    () => validateDaemonConfig({
      A9_NETWORK: 'mainnet',
      A9_SQLITE_PATH: '/tmp/mock.sqlite',
      TONCENTER_API_BASE: 'https://testnet.toncenter.com/api/v2',
      A9_JETTON_MASTER_ADDRESS: MASTER,
      A9_PRESALE_HOT_WALLET_ADDRESS: HOT,
      A9_PROMO_HOT_WALLET_ADDRESS: PROMO,
    }),
    /testnet\.toncenter\.com/i,
  );
  assert.throws(
    () => validateDaemonConfig({
      A9_NETWORK: 'mainnet',
      A9_SQLITE_PATH: '/tmp/mock.sqlite',
      TONCENTER_API_BASE: 'https://toncenter.com/api/v2',
      A9_JETTON_MASTER_ADDRESS: MASTER,
      A9_PRESALE_HOT_WALLET_ADDRESS: TEST_ONLY_ADDR,
      A9_PROMO_HOT_WALLET_ADDRESS: PROMO,
    }),
    /testnet-only/i,
  );

  const daemon = createPayoutDaemon({
    env: {
      A9_NETWORK: 'testnet',
      A9_SQLITE_PATH: '/tmp/mock.sqlite',
      TONCENTER_API_BASE: 'https://testnet.toncenter.com/api/v2',
      A9_JETTON_MASTER_ADDRESS: MASTER,
      A9_PRESALE_HOT_WALLET_ADDRESS: HOT,
      A9_PROMO_HOT_WALLET_ADDRESS: PROMO,
    },
    ledger: db,
    logger: { log() {}, error() {} },
  });
  assert.ok(daemon.presaleEngine.budgetLedger instanceof D1PromoBudgetLedger);
  assert.equal(daemon.presaleEngine.chestEngine.budgetLedger, daemon.presaleEngine.budgetLedger);

  // 6) cf-worker routeNeedsChainState, OG cache URL normalization, CORS unknown-Origin rejection & mainnet validation
  assert.equal(routeNeedsChainState('/api/warmup/current'), true);
  assert.equal(routeNeedsChainState('/api/admin/warmup/round'), true);
  const whReq = new Request('https://api.a9.lat/api/telegram/webhook', {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'wh_sec_1' },
  });
  assert.equal(routeNeedsChainState('/api/telegram/webhook', whReq, { message: { text: '/start' } }, { A9_TG_WEBHOOK_SECRET: 'wh_sec_1' }), false);
  assert.equal(routeNeedsChainState('/api/telegram/webhook', whReq, { message: { text: '/status' } }, { A9_TG_WEBHOOK_SECRET: 'wh_sec_1' }), true);
  assert.equal(
    buildNormalizedOgCacheUrl(new URL('https://api.a9.lat/c/img/round/1.png?rand=999&ratio=9x16&utm=abc')),
    'https://api.a9.lat/c/img/round/1.png?ratio=9x16',
  );
  const badOriginResp = await cfWorker.fetch(
    new Request('https://api.a9.lat/api/health', { headers: { origin: 'https://evil.example' } }),
    { DB: db, A9_ALLOWED_ORIGINS: 'https://app.a9.lat', A9_PUBLIC_ORIGIN: 'https://app.a9.lat' },
  );
  assert.equal(badOriginResp.headers.get('access-control-allow-origin'), null);
  assert.equal(badOriginResp.headers.get('x-content-type-options'), 'nosniff');

  const badMainnetEnv = validateDeployEnv({
    DB: db,
    A9_NETWORK: 'mainnet',
    A9_ENVIRONMENT: 'production',
    A9_PROTOCOL_VERSION: 'v16',
    A9_JETTON_MASTER_ADDRESS: MASTER,
    A9_ROUND_CONTROLLER_ADDRESS: RC,
    A9_PROMO_HOT_WALLET_ADDRESS: PROMO,
    A9_PRESALE_HOT_WALLET_ADDRESS: TEST_ONLY_ADDR,
    A9_PUBLIC_ORIGIN: 'https://app.a9.lat',
    A9_TON_PROOF_DOMAINS: 'app.a9.lat',
    A9_ALLOWED_ORIGINS: 'https://app.a9.lat',
    TONCENTER_API_BASE: 'https://testnet.toncenter.com/api/v2',
  });
  assert.equal(badMainnetEnv.ok, false);
  assert.equal(badMainnetEnv.code, 'PRODUCTION_CONFIG_INVALID');

  // 7) Audit follow-up: P2-2 production defaults to v16 required vars even when A9_PROTOCOL_VERSION is omitted
  const prodDefaultV16 = validateDeployEnv({
    DB: db,
    A9_ENVIRONMENT: 'production',
    // A9_PROTOCOL_VERSION intentionally omitted
  });
  assert.equal(prodDefaultV16.ok, false);
  assert.equal(prodDefaultV16.code, 'PRODUCTION_CONFIG_INCOMPLETE');
  assert.ok(prodDefaultV16.missing.includes('A9_ROUND_CONTROLLER_ADDRESS'));

  // 8) Audit follow-up: P2-3 GET /api/user/:wallet rejects malformed addresses before invoking TonCenter userReader
  let readerCalled = 0;
  const strictUserRouter = createApiRouter({
    env: { TONCENTER_API_BASE: 'https://toncenter.com/api/v2', A9_NETWORK: 'mainnet' },
    stateStore: {
      getTiming: () => ({ observationSeconds: 86400 }),
      getProtocolState: () => ({ dataAvailable: true, currentRoundId: 1 }),
      listRounds: () => [],
      getRound: () => null,
    },
    userReader: async () => {
      readerCalled += 1;
      return { jettonWallet: null, a9BalanceRaw: null, balanceAvailable: false, tickets: [], ticketsAvailable: false, onchainAvailable: false };
    },
  });
  const badWalletRes = await strictUserRouter({ method: 'GET', pathname: '/api/user/NOT_A_VALID_WALLET', nowSec: 3100 });
  assert.equal(badWalletRes.status, 400);
  assert.equal(readerCalled, 0, 'malformed wallet MUST NOT call external TonCenter userReader');

  // 9) Audit follow-up: P1-5 POST /api/admin/rounds/:id/candles idempotently persists to D1 round_candles
  const unauthCandle = await cfWorker.fetch(
    new Request('https://api.a9.lat/api/admin/rounds/1/candles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candles: [{ candleIndex: 0, periodStart: 1000, periodEnd: 4600, twapPriceUsdE8: '250000', qualified: true }] }),
    }),
    { DB: db, A9_ADMIN_TOKEN: 'adm_candle_sec' },
  );
  assert.equal(unauthCandle.status, 401);

  const badCandle = await cfWorker.fetch(
    new Request('https://api.a9.lat/api/admin/rounds/1/candles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-a9-admin-token': 'adm_candle_sec' },
      body: JSON.stringify({
        candles: [
          { candleIndex: 0, periodStart: 1000, periodEnd: 4600, twapPriceUsdE8: '250000', qualified: true },
          { candleIndex: 0, periodStart: 4600, periodEnd: 8200, twapPriceUsdE8: '260000', qualified: true },
        ],
      }),
    }),
    { DB: db, A9_ADMIN_TOKEN: 'adm_candle_sec' },
  );
  assert.equal(badCandle.status, 400);

  const okCandle1 = await cfWorker.fetch(
    new Request('https://api.a9.lat/api/admin/rounds/1/candles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-a9-admin-token': 'adm_candle_sec' },
      body: JSON.stringify({
        candles: [
          { candleIndex: 0, periodStart: 1000, periodEnd: 4600, twapPriceUsdE8: '250000', qualified: true },
          { candleIndex: 1, periodStart: 4600, periodEnd: 8200, twapPriceUsdE8: '190000', qualified: false },
        ],
      }),
    }),
    { DB: db, A9_ADMIN_TOKEN: 'adm_candle_sec' },
  );
  assert.equal(okCandle1.status, 200);
  const okCandle1Body = await okCandle1.json();
  assert.equal(okCandle1Body.data.upsertedCount, 2);

  // Idempotent upsert updates existing candleIndex=1 without duplicating rows
  const okCandle2 = await cfWorker.fetch(
    new Request('https://api.a9.lat/api/admin/rounds/1/candles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-a9-admin-token': 'adm_candle_sec' },
      body: JSON.stringify({
        candles: [
          { candleIndex: 1, periodStart: 4600, periodEnd: 8200, twapPriceUsdE8: '270000', qualified: true },
        ],
      }),
    }),
    { DB: db, A9_ADMIN_TOKEN: 'adm_candle_sec' },
  );
  assert.equal(okCandle2.status, 200);
  const storedCandles = await db.prepare('SELECT candle_index, twap_price_usd_e8, qualified FROM round_candles WHERE round_id = 1 ORDER BY candle_index ASC').all();
  assert.equal(storedCandles.results.length, 2);
  assert.equal(storedCandles.results[1].twap_price_usd_e8, '270000');
  assert.equal(Number(storedCandles.results[1].qualified), 1);
});

await test('W2-11: deterministic broadcast failure degrades daemon heartbeat, and hot-wallet A9/GRAM low-watermark blocks new intents (503 HOT_WALLET_LOW_INVENTORY)', async () => {
  const { createPayoutDaemon } = await import('../src/payout-daemon.mjs');
  const { D1IdentityStore } = await import('../src/auth.mjs');
  const { D1PromoStore } = await import('../src/d1-promo-store.mjs');
  const { D1PresaleStore } = await import('../src/d1-growth-store.mjs');
  const db = createSqliteD1(MIGRATIONS);
  const PROMO_HOT = '0:' + 'a1'.repeat(32);
  const PRESALE_HOT = '0:' + 'b2'.repeat(32);
  const MASTER = '0:' + 'c3'.repeat(32);
  const USER = '0:' + 'd4'.repeat(32);

  let presaleA9Raw = '10000000000000'; // 10,000 A9 (enough for Bronze max 2,500 A9, NOT enough for Legendary max 1,833,334 A9)
  let promoA9Raw = '100000000000'; // 100 A9 (< 200 A9 floor!)
  let promoGramNano = '5000000000'; // 5 GRAM
  let presaleGramNano = '5000000000'; // 5 GRAM

  const promoStore = new D1PromoStore({ db, hotWalletAddress: PROMO_HOT });
  await promoStore.creditReward(USER, '500000000000', 1000); // 500 A9 claimable
  const claim = await promoStore.createClaimIntent(USER, 1001);
  await promoStore.verifyInboundFeeTx(
    { txHash: 'fee_low_1', finality: 'finalized', to: PROMO_HOT, from: USER, valueNano: '60000000', memo: claim.memo, utime: 1002 },
    1003,
  );

  const mockTc = {
    async fetchInboundTransfersSince() {
      return { transfers: [], nextCursor: null, reachedCursor: true, truncated: false };
    },
    async verifyOutboundPayout() {
      return { state: 'PENDING' };
    },
    async fetchAccountBalanceNano(addr) {
      return BigInt(addr === PRESALE_HOT ? presaleGramNano : promoGramNano);
    },
    async fetchUserJettonWallet(_master, addr) {
      return {
        jettonWallet: '0:' + 'e5'.repeat(32),
        a9BalanceRaw: addr === PRESALE_HOT ? presaleA9Raw : promoA9Raw,
        balanceAvailable: true,
      };
    },
  };

  const daemon = createPayoutDaemon({
    db,
    env: {
      A9_NETWORK: 'testnet',
      A9_SQLITE_PATH: ':memory:',
      TONCENTER_API_BASE: 'https://mock',
      A9_JETTON_MASTER_ADDRESS: MASTER,
      A9_PROMO_HOT_WALLET_ADDRESS: PROMO_HOT,
      A9_PRESALE_HOT_WALLET_ADDRESS: PRESALE_HOT,
      A9_PROMO_HOT_WALLET_NAME: 'promoHot',
      A9_PRESALE_HOT_WALLET_NAME: 'presaleHot',
      OPS_EXECUTE: '1',
      OPS_CONFIRM: 'YES',
      A9_RUNNER_ID: 'daemon-inv-1',
    },
    executeFlag: true,
    tonCenter: mockTc,
    promoBroadcaster: async () => {
      throw new Error('acton script failed: insufficient hot wallet A9 inventory (100000000000 < 500000000000)');
    },
    presaleA9Broadcaster: async () => ({ txHash: '0xok' }),
    presaleRefundBroadcaster: async () => ({ txHash: '0xref' }),
    logger: { log() {}, error() {} },
  });

  // 1) Deterministic broadcaster inventory error + low promo watermark -> heartbeat status === 'degraded'
  const out1 = await daemon.runOnce(1010);
  assert.equal(out1.promo.errors.length, 1);
  const hb1 = JSON.parse((await db.prepare('SELECT meta_json FROM runner_heartbeats WHERE runner_id = ?').bind('daemon-inv-1').first()).meta_json);
  assert.equal(hb1.status, 'degraded');
  assert.equal(hb1.inventory.promo.ok, false);
  assert.equal(hb1.inventory.presale.ok, true);

  const ids = new D1IdentityStore({ db });
  await ids.bindVerifiedWallet('30001', USER, 1000);
  const router = createApiRouter({
    env: {
      A9_NETWORK: 'testnet',
      A9_BOT_TOKEN: TEST_BOT_TOKEN,
      A9_PRESALE_OPEN: '1',
      A9_REQUIRE_RUNNER_HEARTBEAT: '1',
    },
    stateStore: { getTiming: () => ({}), getProtocolState: () => ({ dataAvailable: true, currentRoundId: 1 }), listRounds: () => [], getRound: () => null },
    presaleEngine: new D1PresaleStore({ db, hotWalletAddress: PRESALE_HOT, open: true }),
    promoEngine: promoStore,
    identityStore: ids,
    runnerHeartbeatReader: async () => (await db.prepare('SELECT runner_id, role, network, last_seen_at, meta_json FROM runner_heartbeats').all()).results || [],
  });
  const hdrs = await tgHeaders('30001', { authDate: 1015 });

  // Degraded promo inventory blocks POST /api/promo/intent with 503 HOT_WALLET_LOW_INVENTORY
  await promoStore.creditReward(USER, '300000000000', 1012);
  const rejPromo = await router({ method: 'POST', pathname: '/api/promo/intent', headers: hdrs, body: {}, nowSec: 1015 });
  assert.equal(rejPromo.status, 503);
  assert.equal(rejPromo.body.error.code, 'HOT_WALLET_LOW_INVENTORY');

  // 2) Top up promo to 5,000 A9 so daemon becomes status='ok', while presale stays at 10,000 A9:
  // Bronze chest (max 2,500 A9 <= 10,000 A9) succeeds, Legendary chest (max 1,833,334 A9 > 10,000 A9) blocks with 503 HOT_WALLET_LOW_INVENTORY!
  promoA9Raw = '5000000000000';
  daemon.promoRunner.broadcaster = async () => ({ txHash: '0xpromo_recovered' });
  await daemon.runOnce(1020);
  const hb2 = JSON.parse((await db.prepare('SELECT meta_json FROM runner_heartbeats WHERE runner_id = ?').bind('daemon-inv-1').first()).meta_json);
  assert.equal(hb2.status, 'ok');

  const rejLegendary = await router({
    method: 'POST',
    pathname: '/api/presale/intent',
    headers: hdrs,
    body: { skuId: 'chest_legendary', openMode: 'BOOST' },
    nowSec: 1022,
  });
  assert.equal(rejLegendary.status, 503);
  assert.equal(rejLegendary.body.error.code, 'HOT_WALLET_LOW_INVENTORY');

  const okBronze = await router({
    method: 'POST',
    pathname: '/api/presale/intent',
    headers: hdrs,
    body: { skuId: 'chest_bronze', openMode: 'BOOST' },
    nowSec: 1022,
  });
  assert.equal(okBronze.status, 200);
});

console.log(`All ${passed} A9 v15 worker tests passed.`);
