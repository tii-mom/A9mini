#!/usr/bin/env node
// A9 Protocol v15 — Worker & Promo Hot-Wallet Engine Unit Tests (zero external deps).
import assert from 'node:assert/strict';
import { deriveRoundStage, mapV15RoundDetail } from '../src/v15-indexer.mjs';
import { PromoHotWalletEngine, CLAIM_STATUS } from '../src/promo-hotwallet.mjs';
import { createApiRouter } from '../src/api.mjs';

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

await test('API router serves /api/health, /api/config, /api/rounds/:id, and /api/promo/intent', async () => {
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

  const route = createApiRouter({ env: { A9_NETWORK: 'testnet', A9_PROMO_HOT_WALLET_ADDRESS: HOT }, stateStore, promoEngine });

  const h = await route({ method: 'GET', pathname: '/api/health' });
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);

  const cfg = await route({ method: 'GET', pathname: '/api/config' });
  assert.equal(cfg.body.data.protocolVersion, 'v15');
  assert.equal(cfg.body.data.openEnded, true);
  assert.equal(cfg.body.data.promoHotWallet.userFeeTon, '0.06');

  const r1 = await route({ method: 'GET', pathname: '/api/rounds/1', nowSec: 2000 });
  assert.equal(r1.body.data.state, 'STAKING_OPEN');

  const intent = await route({ method: 'POST', pathname: '/api/promo/intent', body: { walletAddress: USER }, nowSec: 2000 });
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

await test('PresaleHotWalletEngine handles valid fill, passive free refund, user-fault -0.05 TON refund, and dust ignore', async () => {
  const { PresaleHotWalletEngine, PRESALE_STATUS } = await import('../src/presale-hotwallet.mjs');
  const HOT = 'EQ_PRESALE_HOT';
  const ALICE = 'EQ_ALICE';
  const engine = new PresaleHotWalletEngine({ hotWalletAddress: HOT, rateA9PerTon: 2000n, minOrderTon: 5n, maxOrderTon: 200n, defaultQuotaTon: 100n });

  const order = engine.createOrderIntent(ALICE, 10, 1000);
  assert.equal(order.status, PRESALE_STATUS.PENDING_TON);
  assert.equal(order.tonNano, '10000000000');

  // Valid 10 TON finalized -> sends 20,000 A9 with excesses back to HOT
  const fill = engine.processInboundTonTx({ txHash: 'p1', finality: 'finalized', to: HOT, from: ALICE, valueNano: '10000000000', memo: order.memo }, 1010);
  assert.equal(fill.action, 'SEND_A9');
  assert.equal(fill.instruction.jettonAmountRaw, '20000000000000');
  assert.equal(fill.instruction.sendExcessesTo, HOT);

  // Dust <= 0.1 TON ignored
  const dust = engine.processInboundTonTx({ txHash: 'p2', finality: 'finalized', to: HOT, from: ALICE, valueNano: '100000000', memo: '' }, 1020);
  assert.equal(dust.action, 'IGNORE_DUST');

  // User-fault (over quota: 95 TON > remaining 90 TON) -> refund minus 0.05 TON
  const fault = engine.processInboundTonTx({ txHash: 'p3', finality: 'finalized', to: HOT, from: ALICE, valueNano: '95000000000', memo: '' }, 1030);
  assert.equal(fault.action, 'REFUND_TON');
  assert.equal(fault.instruction.tonNano, '94950000000');

  // Passive refund (closed + >= 1 TON) -> 100% free full refund
  engine.open = false;
  const passive = engine.processInboundTonTx({ txHash: 'p4', finality: 'finalized', to: HOT, from: ALICE, valueNano: '5000000000', memo: '' }, 1040);
  assert.equal(passive.action, 'REFUND_TON');
  assert.equal(passive.instruction.tonNano, '5000000000');
  assert.equal(passive.instruction.feeDeducted, false);
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
  assert.equal(team.bindStatus, 'bound');
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

await test('PresalePayoutRunner polls buy:<id> finalized TON, broadcasts A9 payout, and ignores replays', async () => {
  const { PresaleHotWalletEngine, PRESALE_STATUS } = await import('../src/presale-hotwallet.mjs');
  const { PresalePayoutRunner } = await import('../src/presale-runner.mjs');
  const HOT = 'EQ_PRESALE_HOT_RUNNER';
  const USER = 'EQ_BUYER_DAVE';
  const engine = new PresaleHotWalletEngine({ hotWalletAddress: HOT, rateA9PerTon: 2002n, minOrderTon: 1n });
  const order = engine.createOrderIntent(USER, 1, 2000);

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
    logger: { log: () => {} },
  });

  const s1 = await runner.tick(2010);
  assert.equal(s1.paid, 1);
  assert.equal(s1.ignored, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipient, USER);
  assert.equal(sent[0].jettonAmountRaw, '2002000000000');
  assert.equal(sent[0].sendExcessesTo, HOT);
  const updated = engine.listOrders(USER)[0];
  assert.equal(updated.status, PRESALE_STATUS.PAID_A9);
  assert.equal(updated.payoutTxHash, 'a9-presale-tx-1');

  const s2 = await runner.tick(2020);
  assert.equal(s2.paid, 0);
  assert.equal(s2.ignored, 2);
});

await test('First-touch referral binding blocks self/mutual invites and credits 12% presale commission to promoEngine', async () => {
  const { SocialStore } = await import('../src/social-store.mjs');
  const { PresaleHotWalletEngine } = await import('../src/presale-hotwallet.mjs');
  const HOT = 'EQ_PRESALE_HOT_REF';
  const REF = 'EQ_REFERRER_A';
  const BUYER = 'EQ_BUYER_B';
  const OTHER = 'EQ_REFERRER_C';

  const social = new SocialStore();
  const promo = new PromoHotWalletEngine({ hotWalletAddress: HOT });
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT, rateA9PerTon: 2000n, minOrderTon: 5n, promoEngine: promo, socialStore: social });

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

  // Presale 10 TON -> 20,000 A9 -> 12% = 2,400 A9 auto-credited to REF promo balance
  const order = presale.createOrderIntent(BUYER, 10, 200, { referrerId: OTHER });
  const fill = presale.processInboundTonTx({
    txHash: 'ref-buy-1', finality: 'finalized', to: HOT, from: BUYER, valueNano: '10000000000', memo: order.memo,
  }, 210);
  assert.equal(fill.action, 'SEND_A9');
  assert.deepEqual(fill.referralCredited, { referrerWallet: REF, amountRaw: '2400000000000' });
  assert.equal(promo.getBalance(REF).claimableRaw, '2400000000000');
});

await test('POST /api/prediction/activate enforces anti-sybil capital check and voucher expiry', async () => {
  const { PredictionEngine } = await import('../src/growth-engine.mjs');
  const { PresaleHotWalletEngine } = await import('../src/presale-hotwallet.mjs');
  const HOT = 'EQ_HOT_ACT';
  const WALLET = 'EQ_USER_ACT';
  const pred = new PredictionEngine({ defaultPoolA9Raw: '10000000000000' });
  const promo = new PromoHotWalletEngine({ hotWalletAddress: HOT });
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT, rateA9PerTon: 2000n, minOrderTon: 5n });
  const stateStore = {
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ({ currentRoundId: 1, successCount: 0 }),
    listRounds: () => [],
    getRound: () => null,
  };
  const route = createApiRouter({ stateStore, promoEngine: promo, presaleEngine: presale, predictionEngine: pred });

  pred.placeBet({ roundId: 1, userId: 'u_act', side: 'PASS' }, 1000);
  pred.settleRoundBets(1, true, 18, '10000000000000', 1_000_000);

  // 1) No presale & no stake ticket -> 400 ACTIVATION_REQUIREMENT_UNMET
  const denied = await route({
    method: 'POST', pathname: '/api/prediction/activate', body: { userId: 'u_act', walletAddress: WALLET }, nowSec: 1100,
  });
  assert.equal(denied.status, 400);
  assert.equal(denied.body.error.code, 'ACTIVATION_REQUIREMENT_UNMET');

  // 2) Complete 1 PAID_A9 presale order -> activation succeeds & credits promoEngine
  const ord = presale.createOrderIntent(WALLET, 5, 1100);
  presale.processInboundTonTx({ txHash: 'act-buy-1', finality: 'finalized', to: HOT, from: WALLET, valueNano: '5000000000', memo: ord.memo }, 1105);
  const okRes = await route({
    method: 'POST', pathname: '/api/prediction/activate', body: { userId: 'u_act', walletAddress: WALLET }, nowSec: 1110,
  });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.data.activatedRaw, '10000000000000');
  assert.equal(promo.getBalance(WALLET).claimableRaw, '10000000000000');

  // 3) Expired voucher -> 400 VOUCHER_EXPIRED and pending balance cleared
  pred.placeBet({ roundId: 2, userId: 'u_exp', side: 'BURN' }, 2000);
  pred.settleRoundBets(2, false, 9, '5000000000000', 2_000_000);
  const expired = await route({
    method: 'POST', pathname: '/api/prediction/activate', body: { userId: 'u_exp', walletAddress: WALLET }, nowSec: 2000 + 3 * 86400,
  });
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error.code, 'VOUCHER_EXPIRED');
  assert.equal(pred.getUserSummary('u_exp', 2).pendingActivationRaw, '0');
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
  const route = createApiRouter({ stateStore, predictionEngine: pred });

  // u_pro: PASS + exact slot 18 (+0.5x) + 6 invited friends (capped at 5 => +0.5x) => 2.0x (weight 20)
  pred.placeBet({ roundId: 1, userId: 'u_pro', side: 'PASS', guessSlots: 18 }, 100);
  for (let i = 1; i <= 6; i += 1) {
    pred.placeBet({ roundId: 1, userId: `u_f${i}`, side: 'BURN', referrerId: 'u_pro' }, 100 + i);
  }
  // u_base: PASS without exact guess or invites => 1.0x (weight 10)
  pred.placeBet({ roundId: 1, userId: 'u_base', side: 'PASS', guessSlots: 16 }, 120);

  const settleMs = 1_700_000_000_000;
  pred.settleRoundBets(1, true, 18, '30000000000000', settleMs);

  // Weight split: 20 vs 10 out of 30 => u_pro gets 20,000 A9, u_base gets 10,000 A9
  const proSummary = await route({ method: 'GET', pathname: '/api/prediction/user/u_pro', query: { roundId: '1' } });
  assert.equal(proSummary.status, 200);
  assert.equal(proSummary.body.data.pendingActivationRaw, '20000000000000');
  assert.equal(proSummary.body.data.streak, 1);
  assert.equal(proSummary.body.data.winRate, 100);
  assert.equal(proSummary.body.data.inviteBoostCount, 5);
  assert.equal(proSummary.body.data.pendingExpiresAt, settleMs + 2 * 86400 * 1000);

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

await test('D1PromoStore.creditReward preserves BigInt precision across multiple credits', async () => {
  const { D1PromoStore } = await import('../src/d1-promo-store.mjs');
  const db = createMockD1();
  const store = new D1PromoStore({ db, hotWalletAddress: 'EQ_D1_HOT' });

  // Values exceeding Number.MAX_SAFE_INTEGER (9.007e15) to verify BigInt precision
  await store.creditReward('EQ_BIGINT_USER', '15000000000000000000', 1000);
  await store.creditReward('EQ_BIGINT_USER', '2400000000000', 1001);
  const bal = await store.getBalance('EQ_BIGINT_USER');
  assert.equal(bal.claimableRaw, '15000002400000000000');

  const intent = await store.createClaimIntent('EQ_BIGINT_USER', 1002);
  assert.equal(intent.amountRaw, '15000002400000000000');
  assert.equal(intent.payTo, 'EQ_D1_HOT');
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

await test('D1 full-stack persistence loop: bindReferral -> placeBet -> admin settle -> PAID_A9 presale + 12% credit -> activateToPromo', async () => {
  const { D1PromoStore } = await import('../src/d1-promo-store.mjs');
  const { D1SocialStore, D1PredictionEngine, D1PresaleStore } = await import('../src/d1-growth-store.mjs');
  const db = createMockD1();
  const HOT = 'EQ_D1_HOT_FULL';
  const REF = 'EQ_D1_REF';
  const USER_W = 'EQ_D1_BUYER';

  const promo = new D1PromoStore({ db, hotWalletAddress: HOT });
  const social = new D1SocialStore({ db });
  const pred = new D1PredictionEngine({ db, defaultPoolA9Raw: '20000000000000' });
  const presale = new D1PresaleStore({ db, hotWalletAddress: HOT, rateA9PerTon: 2000n, minOrderTon: 5n, promoEngine: promo, socialStore: social });

  const stateStore = {
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ({ currentRoundId: 1, successCount: 0 }),
    listRounds: () => [],
    getRound: () => null,
  };
  const route = createApiRouter({
    env: { A9_ADMIN_TOKEN: 'd1-adm' },
    stateStore,
    promoEngine: promo,
    presaleEngine: presale,
    socialStore: social,
    predictionEngine: pred,
  });

  // 1) Place bet with referrerId (binds first-touch referral in D1)
  const betRes = await route({
    method: 'POST', pathname: '/api/prediction/bet',
    body: { roundId: 1, userId: 'tg_d1_u', side: 'PASS', guessSlots: 18, referrerId: REF },
    nowSec: 1000,
  });
  assert.equal(betRes.status, 200);
  assert.equal(await social.getReferrer('tg_d1_u'), REF);

  // 2) Settle via admin endpoint
  const settleRes = await route({
    method: 'POST', pathname: '/api/admin/prediction/settle',
    headers: { 'x-a9-admin-token': 'd1-adm' },
    body: { roundId: 1, passed: true, actualQualified: 18 },
    nowSec: 2000,
  });
  assert.equal(settleRes.status, 200);
  assert.equal(settleRes.body.data.winnersCount, 1);

  // 3) Activate before presale -> blocked by ACTIVATION_REQUIREMENT_UNMET
  const blocked = await route({
    method: 'POST', pathname: '/api/prediction/activate',
    body: { userId: 'tg_d1_u', walletAddress: USER_W },
    nowSec: 2010,
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'ACTIVATION_REQUIREMENT_UNMET');

  // 4) Create presale order with referrerId -> mark PAID_A9 -> auto-credits 12% (1,200 A9) to REF in D1PromoStore
  const ordRes = await route({
    method: 'POST', pathname: '/api/presale/intent',
    body: { walletAddress: USER_W, tonAmount: 5, referrerId: REF },
    nowSec: 2020,
  });
  assert.equal(ordRes.status, 200);
  const paid = await presale.markOrderPaid(ordRes.body.data.orderId, 'tx-in-d1', 'tx-out-d1', 2030);
  assert.deepEqual(paid.referralCredited, { referrerWallet: REF, amountRaw: '1200000000000' });
  assert.equal((await promo.getBalance(REF)).claimableRaw, '1200000000000');

  // 5) Activate after PAID_A9 -> succeeds & credits 20,000 A9 to USER_W in D1PromoStore
  const actRes = await route({
    method: 'POST', pathname: '/api/prediction/activate',
    body: { userId: 'tg_d1_u', walletAddress: USER_W },
    nowSec: 2040,
  });
  assert.equal(actRes.status, 200);
  assert.equal(actRes.body.data.activatedRaw, '20000000000000');
  assert.equal((await promo.getBalance(USER_W)).claimableRaw, '20000000000000');
});

console.log(`All ${passed} A9 v15 worker tests passed.`);
