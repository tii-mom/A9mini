#!/usr/bin/env node
// A9 Protocol v15 — Worker & Promo Hot-Wallet Engine Unit Tests (zero external deps).
import assert from 'node:assert/strict';
import { deriveRoundStage, mapV15RoundDetail } from '../src/v15-indexer.mjs';
import { PromoHotWalletEngine, CLAIM_STATUS } from '../src/promo-hotwallet.mjs';
import { createApiRouter } from '../src/api.mjs';
import { MemoryIdentityStore } from '../src/auth.mjs';
import { TEST_BOT_TOKEN, tgHeaders, createSqliteD1, FRESH_SCHEMA, completePurchase } from './helpers/test-env.mjs';

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
    txHash: 'tx-unfinalized', finality: 'confirmed', to: HOT, valueNano: '60000000', memo: intent.memo,
  }, 10_010));

  // Reject underpaid fee (< 0.06 TON)
  assert.throws(() => engine.verifyInboundFeeTx({
    txHash: 'tx-low', finality: 'finalized', to: HOT, valueNano: '50000000', memo: intent.memo,
  }, 10_010));

  // Valid finalized 0.06 TON fee -> generates TEP-74 transfer with sendExcessesTo = HOT
  const res = engine.verifyInboundFeeTx({
    txHash: 'tx-ok-1', finality: 'finalized', to: HOT, valueNano: '60000000', memo: intent.memo,
  }, 10_020);
  assert.equal(res.claim.status, CLAIM_STATUS.FEE_CONFIRMED);
  assert.equal(res.payoutInstruction.recipient, USER);
  assert.equal(res.payoutInstruction.jettonAmountRaw, String(50_000n * A9));
  assert.equal(res.payoutInstruction.sendExcessesTo, HOT);
  assert.equal(engine.getBalance(USER).claimableRaw, '0');

  // Strict anti-replay on same txHash
  assert.throws(() => engine.verifyInboundFeeTx({
    txHash: 'tx-ok-1', finality: 'finalized', to: HOT, valueNano: '60000000', memo: intent.memo,
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
  assert.equal(cfg.body.data.protocolVersion, 'v15');
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
    jettonMasterAddress: 'EQ_MASTER_DEMO',
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
  assert.equal(res.txHash, '0xdeadbeef1234');
});

await test('PresaleHotWalletEngine handles valid fill, passive free refund, no-order anomaly (no auto fee), and dust ignore', async () => {
  const { PresaleHotWalletEngine, PRESALE_STATUS } = await import('../src/presale-hotwallet.mjs');
  const HOT = 'EQ_PRESALE_HOT';
  const ALICE = 'EQ_ALICE';
  const engine = new PresaleHotWalletEngine({ hotWalletAddress: HOT, rateA9PerTon: 2000n, minOrderTon: 5n, maxOrderTon: 200n, defaultQuotaTon: 100n, open: true });

  const order = await engine.createOrderIntent(ALICE, 10, 1000);
  assert.equal(order.status, PRESALE_STATUS.PENDING_PAYMENT);
  assert.equal(order.tonNano, '10000000000');

  // Valid 10 GRAM finalized -> PAYMENT_CONFIRMED -> queued 20,000 A9 payout with excesses back to HOT
  const fill = await engine.ingestInbound({ txHash: 'p1', finality: 'finalized', to: HOT, from: ALICE, valueNano: '10000000000', memo: order.memo }, 1010);
  assert.equal(fill.action, 'CONFIRM');
  assert.equal((await engine.getOrder(order.orderId)).status, PRESALE_STATUS.PAYMENT_CONFIRMED);
  assert.equal(await engine.queueConfirmedPayouts(1011), 1);
  assert.equal((await engine.getOrder(order.orderId)).status, PRESALE_STATUS.PAYOUT_PENDING);
  const [payout] = await engine.repo.listOpenPayouts();
  const inst = engine.buildInstruction(payout);
  assert.equal(inst.jettonAmountRaw, '20000000000000');
  assert.equal(inst.sendExcessesTo, HOT);

  // Dust <= 0.1 GRAM ignored
  const dust = await engine.ingestInbound({ txHash: 'p2', finality: 'finalized', to: HOT, from: ALICE, valueNano: '100000000', memo: '' }, 1020);
  assert.equal(dust.action, 'IGNORE_DUST');

  // No matching order -> recorded as an ANOMALY for review: no auto payout, no automatic fee.
  const fault = await engine.ingestInbound({ txHash: 'p3', finality: 'finalized', to: HOT, from: ALICE, valueNano: '95000000000', memo: '' }, 1030);
  assert.equal(fault.action, 'ANOMALY');
  assert.equal(fault.reason, 'no_matching_order');
  assert.equal((await engine.repo.listOpenPayouts()).length, 1); // only the A9 payout above
  const [anomaly] = await engine.listAnomalies();
  assert.equal(anomaly.refundTo, ALICE);
  assert.equal(anomaly.valueNano, '95000000000');
  // P0-D: 未配置已公示扣费规则时，USER 责任方也按零手续费全额退款，绝不阻止本金退还。
  const resolved = await engine.resolveAnomaly('p3', { decision: 'REFUND', faultParty: 'USER', operator: 'ops1' }, 1032);
  assert.equal(resolved.refundNano, '95000000000');
  assert.equal(resolved.feeNano, '0');

  // Passive refund (closed + >= 1 GRAM) -> 100% free full refund
  const order2 = await engine.createOrderIntent(ALICE, 5, 1035);
  engine.open = false;
  const passive = await engine.ingestInbound({ txHash: 'p4', finality: 'finalized', to: HOT, from: ALICE, valueNano: '5000000000', memo: order2.memo }, 1040);
  assert.equal(passive.action, 'REFUND');
  assert.equal(passive.refundNano, 5000000000n);
  assert.equal(passive.feeDeducted, false);
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

  pred.placeBet({ roundId: 1, userId: 'tg_alice', side: 'PASS', guessSlots: 18 }, 100);
  pred.placeBet({ roundId: 1, userId: 'tg_bob', side: 'PASS', guessSlots: 16 }, 101);
  pred.placeBet({ roundId: 1, userId: 'tg_carol', side: 'BURN' }, 102);

  const stats = pred.getRoundStats(1);
  assert.equal(stats.passCount, 2);
  assert.equal(stats.burnCount, 1);

  const settled = pred.settleRoundBets(1, true, 18);
  assert.equal(settled.winnersCount, 2);
  assert.equal(pred.getUserSummary('tg_alice', 1).pendingActivationRaw, '15000000000000');
  assert.equal(pred.getUserSummary('tg_bob', 1).pendingActivationRaw, '10000000000000');

  const act = pred.activateToPromo('tg_alice', 'EQ_ALICE_WALLET', promo, { qualified: true });
  assert.equal(act.activatedRaw, '15000000000000');
  assert.equal(promo.getBalance('EQ_ALICE_WALLET').claimableRaw, '15000000000000');
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
  assert.ok(svg.rawBody.includes('BURN MONUMENT'));
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
  const order = await engine.createOrderIntent(USER, 1, 2000);

  const fakeTc = {
    fetchInboundTransfers: async () => [
      { txHash: 'buy-tx-1', finality: 'finalized', to: HOT, from: USER, valueNano: '1000000000', memo: order.memo },
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
  assert.equal(sent[0].jettonAmountRaw, '2002000000000');
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

  // Presale 10 GRAM -> 20,000 A9 -> 12% = 2,400 A9, booked only after the payout is confirmed.
  const order = await presale.createOrderIntent(BUYER, 10, 200, { referrerId: social.getReferrer(BUYER) });
  await presale.ingestInbound({ txHash: 'ref-buy-1', finality: 'finalized', to: HOT, from: BUYER, valueNano: '10000000000', memo: order.memo }, 210);
  await presale.queueConfirmedPayouts(211);
  await presale.processReferralCredits(211);
  assert.equal(promo.getBalance(REF).claimableRaw, '0');
  await presale.processPayouts(212, { a9Broadcaster: async () => ({ txHash: 'ref-pay-1' }), verifier: async () => ({ state: 'CONFIRMED' }) });
  await presale.processReferralCredits(213);
  assert.equal(promo.getBalance(REF).claimableRaw, '2400000000000');
  await presale.processReferralCredits(214);
  assert.equal(promo.getBalance(REF).claimableRaw, '2400000000000');
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
  pred.settleRoundBets(1, true, 18, '10000000000000', 1_000_000);

  // 1) No completed exchange order & no stake ticket -> 400 ACTIVATION_REQUIREMENT_UNMET
  const denied = await route({ method: 'POST', pathname: '/api/prediction/activate', body: {}, headers: await tgHeaders(3001, { nowSec: 1100 }), nowSec: 1100 });
  assert.equal(denied.status, 400);
  assert.equal(denied.body.error.code, 'ACTIVATION_REQUIREMENT_UNMET');

  // 2) Complete 1 order (payout confirmed) -> activation succeeds & credits promoEngine
  await completePurchase(presale, WALLET, 5, 1100);
  const okRes = await route({ method: 'POST', pathname: '/api/prediction/activate', body: {}, headers: await tgHeaders(3001, { nowSec: 1110 }), nowSec: 1110 });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.data.activatedRaw, '10000000000000');
  assert.equal(promo.getBalance(WALLET).claimableRaw, '10000000000000');

  // 3) Expired voucher -> 400 VOUCHER_EXPIRED and pending balance cleared
  await completePurchase(presale, WALLET2, 5, 1200);
  pred.placeBet({ roundId: 2, userId: '3002', side: 'BURN' }, 2000);
  pred.settleRoundBets(2, false, 9, '5000000000000', 2_000_000);
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

  // 1001: PASS + exact slot 18 (+0.5x) + 6 invited friends (capped at 5 => +0.5x) => 2.0x (weight 20)
  pred.placeBet({ roundId: 1, userId: '1001', side: 'PASS', guessSlots: 18 }, 100);
  for (let i = 1; i <= 6; i += 1) {
    pred.placeBet({ roundId: 1, userId: `110${i}`, side: 'BURN', referrerId: '1001' }, 100 + i);
  }
  // 1002: PASS without exact guess or invites => 1.0x (weight 10)
  pred.placeBet({ roundId: 1, userId: '1002', side: 'PASS', guessSlots: 16 }, 120);

  const settleMs = 1_700_000_000_000;
  pred.settleRoundBets(1, true, 18, '30000000000000', settleMs);

  // Weight split: 20 vs 10 out of 30 => 1001 gets 20,000 A9, 1002 gets 10,000 A9
  const proSummary = await route({ method: 'GET', pathname: '/api/prediction/user/1001', query: { roundId: '1' }, headers: await tgHeaders(1001, { nowSec: 1000 }), nowSec: 1000 });
  assert.equal(proSummary.status, 200);
  assert.equal(proSummary.body.data.pendingActivationRaw, '20000000000000');
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
  pred.placeBet({ roundId: 5, userId: 'u_adm', side: 'PASS', guessSlots: 18 }, 100);
  const stateStore = {
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ({ currentRoundId: 5, successCount: 2 }),
    listRounds: () => [],
    getRound: () => null,
  };
  const route = createApiRouter({ env: { A9_ADMIN_TOKEN: 'secret-token-v15' }, stateStore, predictionEngine: pred });

  const noAuth = await route({ method: 'POST', pathname: '/api/admin/prediction/settle', body: { roundId: 5, passed: true, actualQualified: 18 } });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.body.error.code, 'UNAUTHORIZED');

  const wrongAuth = await route({
    method: 'POST', pathname: '/api/admin/prediction/settle',
    headers: { 'x-a9-admin-token': 'wrong' },
    body: { roundId: 5, passed: true, actualQualified: 18 },
  });
  assert.equal(wrongAuth.status, 401);

  const okAuth = await route({
    method: 'POST', pathname: '/api/admin/prediction/settle',
    headers: { Authorization: 'Bearer secret-token-v15' },
    body: { roundId: 5, passed: true, actualQualified: 18 },
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
  const betRes = await route({ method: 'POST', pathname: '/api/prediction/bet', body: { roundId: 1, side: 'PASS', guessSlots: 18, referrerId: REF }, headers: await H(1000), nowSec: 1000 });
  assert.equal(betRes.status, 200);
  assert.equal(betRes.body.data.userId, '2001');
  assert.equal(await social.getReferrer('2001'), REF);

  // 2) Settle via admin endpoint
  const settleRes = await route({ method: 'POST', pathname: '/api/admin/prediction/settle', headers: { 'x-a9-admin-token': 'd1-adm' }, body: { roundId: 1, passed: true, actualQualified: 18 }, nowSec: 2000 });
  assert.equal(settleRes.status, 200);
  assert.equal(settleRes.body.data.winnersCount, 1);

  // 3) Activate before a completed purchase -> blocked
  const blocked = await route({ method: 'POST', pathname: '/api/prediction/activate', body: {}, headers: await H(2010), nowSec: 2010 });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'ACTIVATION_REQUIREMENT_UNMET');

  // 4) Exchange order via API (wallet from binding) -> paid -> confirmed -> 12% (1,200 A9) to REF exactly once
  const ordRes = await route({ method: 'POST', pathname: '/api/presale/intent', body: { gramAmount: '5', referrerId: REF }, headers: await H(2020), nowSec: 2020 });
  assert.equal(ordRes.status, 200);
  const ord = ordRes.body.data;
  await presale.ingestInbound({ txHash: 'tx-in-d1', finality: 'finalized', to: HOT, from: USER_W, valueNano: ord.tonNano, memo: ord.memo }, 2025);
  await presale.queueConfirmedPayouts(2026);
  await presale.processPayouts(2027, { a9Broadcaster: async () => ({ txHash: 'tx-out-d1' }), verifier: async () => ({ state: 'CONFIRMED' }) });
  await presale.processReferralCredits(2030);
  await presale.processReferralCredits(2031);
  assert.equal((await presale.getOrder(ord.orderId)).status, 'COMPLETED');
  assert.equal((await promo.getBalance(REF)).claimableRaw, '1200000000000');

  // 5) Activate after COMPLETED -> succeeds & credits 20,000 A9 to the bound wallet
  const actRes = await route({ method: 'POST', pathname: '/api/prediction/activate', body: {}, headers: await H(2040), nowSec: 2040 });
  assert.equal(actRes.status, 200);
  assert.equal(actRes.body.data.activatedRaw, '20000000000000');
  assert.equal((await promo.getBalance(USER_W)).claimableRaw, '20000000000000');
});

await test('PredictionEngine first-loss rookie bonus: first wrong bet earns 500 A9 (48h TTL) without touching winner pool', async () => {
  const { PredictionEngine, VOUCHER_TTL_MS } = await import('../src/growth-engine.mjs');
  const pred = new PredictionEngine({ defaultPoolA9Raw: '10000000000000' }); // 10,000 A9 winner pool
  pred.placeBet({ roundId: 1, userId: 'winner_1', side: 'PASS' }, 100);
  pred.placeBet({ roundId: 1, userId: 'rookie_1', side: 'BURN' }, 101);

  const nowMs = 1_760_000_000_000;
  const res = pred.settleRoundBets(1, true, 18, '10000000000000', nowMs);
  assert.equal(res.winnersCount, 1);
  // 赢家拿满全部 10,000 A9，新人保底绝不侵占赢家主奖池
  assert.equal(res.distributedRaw, '10000000000000');
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

  const s1 = pred.settleRoundBets(1, true, 17, '10000000000000', 1_000_000);
  assert.equal(s1.firstLossBonusCount, 2);
  assert.equal(s1.firstLossBonusDistributedRaw, '1000000000000');
  assert.equal(pred.getUserSummary('r1', 1).pendingActivationRaw, '500000000000');
  assert.equal(pred.getUserSummary('r2', 1).pendingActivationRaw, '500000000000');
  assert.equal(pred.getUserSummary('r3', 1).pendingActivationRaw, '0');
  assert.equal(pred.getUserSummary('r3', 1).currentBet.status, 'LOST');

  // 第 2 轮：r1 再次押错（已非首次结算），不再发放保底；新用户 r4 首次押错照常获得 500 A9
  pred.placeBet({ roundId: 2, userId: 'r1', side: 'BURN' }, 200);
  pred.placeBet({ roundId: 2, userId: 'r4', side: 'BURN' }, 201);
  const s2 = pred.settleRoundBets(2, true, 18, '10000000000000', 2_000_000);
  assert.equal(s2.firstLossBonusCount, 1);
  assert.equal(pred.getUserSummary('r1', 2).pendingActivationRaw, '500000000000'); // 仅保留第 1 轮未变的 500 A9
  assert.equal(pred.getUserSummary('r1', 2).currentBet.status, 'LOST');
  assert.equal(pred.getUserSummary('r4', 2).pendingActivationRaw, '500000000000');

  // 设 0 热关闭
  const predOff = new PredictionEngine({ firstLossBonusRaw: '0' });
  predOff.placeBet({ roundId: 1, userId: 'off_u', side: 'BURN' }, 100);
  const sOff = predOff.settleRoundBets(1, true, 16, '10000000000000', 1_000_000);
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

  await pred.placeBet({ roundId: 1, userId: 'u_atomic', side: 'PASS' }, 1000);
  await pred.settleRoundBets(1, true, 18, '15000000000000000000', 1_100_000);

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
  await pred.placeBet({ roundId: 1, userId: 'u_rebind', side: 'PASS' }, 1000);
  await pred.settleRoundBets(1, true, 18, hugeAmt, 1_100_000);
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

console.log(`All ${passed} A9 v15 worker tests passed.`);
