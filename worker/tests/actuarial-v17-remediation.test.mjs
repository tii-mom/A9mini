#!/usr/bin/env node
// A9 Protocol v17 — Actuarial Remediation & Audit Regression Suite
// Covers:
//   1) Dual hot-wallet independent inventory & concurrent order reservation (Mandatory Reconciliation #1)
//   2) Critical presale_promo (48,000,000 A9) boundary: reserved 6% referral credits without double-deducting (Mandatory Reconciliation #2)
//   3) Mixed-source 48H pending vouchers (Bronze 200 / Warmup 300 / Prediction 800 = 1,300 A9) exact bucket reclaim (Mandatory Reconciliation #3)
//   4) Activate/expire/new-grant concurrency, batched resumable reclaim, async payout protection, dry-run zero-write
//   5) Fresh schema.sql vs 0001..0017 upgrade, idempotent legacy order & voucher backfill, fail-closed missing 0017
//   6) Unified prediction config, admin override cap validation, mainnet 503 guards
//   7) Signing daemon D1 HTTP adapter (createD1HttpClient) timeout -> re-read -> idempotent retry
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiRouter } from '../src/api.mjs';
import { D1IdentityStore } from '../src/auth.mjs';
import { D1ChestEngine } from '../src/d1-chest-store.mjs';
import { D1PromoStore } from '../src/d1-promo-store.mjs';
import {
  D1SocialStore,
  D1PredictionEngine,
  D1PresaleStore,
  reconcileLegacyPresaleOrders,
  backfillLegacyPendingVouchers,
} from '../src/d1-growth-store.mjs';
import { D1PromoBudgetLedger, PROMO_BUDGET_BUCKETS } from '../src/promo-budget.mjs';
import { PresalePayoutRunner } from '../src/presale-runner.mjs';
import { createPayoutDaemon } from '../src/payout-daemon.mjs';
import { TonCenterClient } from '../src/toncenter.mjs';
import { VOUCHER_TTL_MS } from '../src/growth-engine.mjs';
import { resolvePredictionConfig, validateAdminPredictionPoolOverride, DEFAULT_PREDICTION_POOL_A9_RAW } from '../src/prediction-config.mjs';
import { createD1HttpClient } from '../src/d1-http-client.mjs';
import { D1V17RewardEngine } from '../src/v17-rewards.mjs';
import { TEST_BOT_TOKEN, tgHeaders, createSqliteD1, createMiniflareD1, MIGRATIONS, PRE_0017_MIGRATIONS } from './helpers/test-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(__dirname, '..');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

const A9 = 1_000_000_000n;
const PRESALE_HOT = '0:' + '11'.repeat(32);
const PROMO_HOT = '0:' + '22'.repeat(32);
const JETTON_MASTER = '0:' + '33'.repeat(32);
const W = (hex) => '0:' + hex.repeat(32);

function makeSnap(nowSec, { presaleA9Raw, promoA9Raw, network = 'testnet', jettonMaster = JETTON_MASTER, presaleWallet = PRESALE_HOT, promoWallet = PROMO_HOT, fetchedAt = nowSec } = {}) {
  return {
    presale: {
      ok: true,
      network,
      jettonMaster,
      walletAddress: presaleWallet,
      fetchedAt,
      a9Raw: String(presaleA9Raw),
      gramNano: '5000000000',
    },
    promo: {
      ok: true,
      network,
      jettonMaster,
      walletAddress: promoWallet,
      fetchedAt,
      a9Raw: String(promoA9Raw),
      gramNano: '5000000000',
    },
  };
}

function buildD1Stack({ migrations = MIGRATIONS, budgetOverrides = null, requireInventorySnapshot = false, randomFn = null, envExtra = {}, dbOverride = null } = {}) {
  const db = dbOverride ?? createSqliteD1(migrations);
  if (budgetOverrides) {
    for (const [bucket, cap] of Object.entries(budgetOverrides)) {
      db.prepare('UPDATE promo_budget_ledger SET cap_raw = ?, spent_raw = ? WHERE bucket_key = ?')
        .bind(String(cap), '0', bucket)
        .run();
    }
  }
  const budgetLedger = new D1PromoBudgetLedger({ db });
  const promoEngine = new D1PromoStore({ db, hotWalletAddress: PROMO_HOT });
  const socialStore = new D1SocialStore({ db });
  const predictionEngine = new D1PredictionEngine({ db, budgetLedger });
  const chestEngine = new D1ChestEngine({ db, budgetLedger });
  const identityStore = new D1IdentityStore({ db, promoEngine });
  const presaleEngine = new D1PresaleStore({
    db,
    hotWalletAddress: PRESALE_HOT,
    promoHotWalletAddress: PROMO_HOT,
    network: 'testnet',
    jettonMasterAddress: JETTON_MASTER,
    requireInventorySnapshot,
    open: true,
    promoEngine,
    predictionEngine,
    socialStore,
    identityStore,
    chestEngine,
    budgetLedger,
    randomFn,
  });
  const v17RewardEngine = new D1V17RewardEngine({ db });
  const round1 = { status: 2, stakeOpenAt: 500, stakeCloseAt: 50000, qualifiedCandles: 10 };
  const stateStore = {
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ({ dataAvailable: true, currentRoundId: 1, successCount: 1 }),
    listRounds: () => [{ roundId: 1, round: round1, candles: [] }],
    getRound: (id) => (Number(id) === 1 ? { roundId: 1, round: round1, candles: [] } : null),
  };
  const router = createApiRouter({
    env: {
      A9_BOT_TOKEN: TEST_BOT_TOKEN,
      A9_ADMIN_TOKEN: 'adm-v17',
      A9_CHEST_OPEN_ENABLED: '1',
      A9_NETWORK: 'testnet',
      A9_ENVIRONMENT: 'candidate',
      ...envExtra,
    },
    stateStore,
    promoEngine,
    presaleEngine,
    socialStore,
    predictionEngine,
    chestEngine,
    budgetLedger,
    v17RewardEngine,
    identityStore,
    walletStateResolver: async () => ({ state: 'active' }),
  });
  return { db, router, round1, budgetLedger, promoEngine, presaleEngine, socialStore, predictionEngine, chestEngine, identityStore, v17RewardEngine };
}

console.log('Running A9 v17 Actuarial Remediation & Audit Regression Suite...');

// ---------------------------------------------------------------------------
// 1. Mandatory Reconciliation #1: Concurrent Orders & Dual Hot-Wallet Inventory
// ---------------------------------------------------------------------------
await test('Reconciliation #1: concurrent orders only allow inventory-covered count; promo & presale wallets isolated; stale/mismatched snapshots fail closed', async () => {
  const { db, presaleEngine, promoEngine, budgetLedger } = buildD1Stack({ requireInventorySnapshot: true });
  const nowSec = 10_000;
  const W_REF = W('aa');

  // chest_bronze: base 1,500 A9 + maxBoost 1,000 A9 = 2,500 A9 from presale wallet; 6% ref = 90 A9 from promo wallet.
  // Presale wallet has 5,000 A9 (covers exactly 2 orders); promo wallet has 500 A9.
  const snap2 = makeSnap(nowSec, { presaleA9Raw: 5_000n * A9, promoA9Raw: 500n * A9 });

  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5].map((i) =>
      presaleEngine.createOrderIntent(W(`b${i}`), null, nowSec, {
        skuId: 'chest_bronze',
        referrerId: W_REF,
        inventorySnapshot: snap2,
      }),
    ),
  );
  const okOrders = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const failErrs = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
  assert.equal(okOrders.length, 2, 'exactly 2 concurrent orders covered by 5,000 A9 presale inventory');
  assert.equal(failErrs.length, 3);
  for (const e of failErrs) assert.equal(e.code, 'HOT_WALLET_LOW_INVENTORY');

  // Verify zero orphan orders and exact presale_promo spent = 2 * (1,000 + 90) = 2,180 A9
  const cntRow = await db.prepare('SELECT COUNT(*) AS c FROM presale_orders').first();
  const resCntRow = await db.prepare('SELECT COUNT(*) AS c FROM presale_order_reservations').first();
  assert.equal(Number(cntRow.c), 2);
  assert.equal(Number(resCntRow.c), 2);
  assert.equal((await budgetLedger.getBucket('presale_promo')).spentRaw, String(2_180n * A9));

  // Separate promo hot-wallet check: presale wallet has 100,000 A9, promo wallet has 270 A9 total
  // (already 180 A9 reserved by the 2 orders above -> only 90 A9 left for 1 more referred order).
  const snapPromoTight = makeSnap(nowSec + 1, { presaleA9Raw: 100_000n * A9, promoA9Raw: 270n * A9 });
  const refRace = await Promise.allSettled([
    presaleEngine.createOrderIntent(W('c1'), null, nowSec + 1, { skuId: 'chest_bronze', referrerId: W_REF, inventorySnapshot: snapPromoTight }),
    presaleEngine.createOrderIntent(W('c2'), null, nowSec + 1, { skuId: 'chest_bronze', referrerId: W_REF, inventorySnapshot: snapPromoTight }),
  ]);
  assert.equal(refRace.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(refRace.filter((r) => r.status === 'rejected')[0].reason.code, 'PROMO_WALLET_LOW_INVENTORY');

  // Unreferred order does NOT need promo wallet -> still succeeds!
  const unrefOrd = await presaleEngine.createOrderIntent(W('c3'), null, nowSec + 1, {
    skuId: 'chest_bronze',
    inventorySnapshot: snapPromoTight,
  });
  assert.equal(unrefOrd.status, 'PENDING_PAYMENT');

  // Snapshot validation: missing, stale, wrong network, wrong jettonMaster, wrong wallet -> all rejected before payment
  await assert.rejects(
    () => presaleEngine.createOrderIntent(W('c4'), null, nowSec + 2, { skuId: 'chest_bronze' }),
    { code: 'INVENTORY_SNAPSHOT_UNAVAILABLE' },
  );
  await assert.rejects(
    () => presaleEngine.createOrderIntent(W('c4'), null, nowSec + 500, { skuId: 'chest_bronze', inventorySnapshot: snapPromoTight }),
    { code: 'INVENTORY_SNAPSHOT_STALE' },
  );
  await assert.rejects(
    () => presaleEngine.createOrderIntent(W('c4'), null, nowSec + 2, {
      skuId: 'chest_bronze',
      inventorySnapshot: makeSnap(nowSec + 2, { presaleA9Raw: 100_000n * A9, promoA9Raw: 100_000n * A9, network: 'mainnet' }),
    }),
    { code: 'INVENTORY_SNAPSHOT_MISMATCH' },
  );
  await assert.rejects(
    () => presaleEngine.createOrderIntent(W('c4'), null, nowSec + 2, {
      skuId: 'chest_bronze',
      inventorySnapshot: makeSnap(nowSec + 2, { presaleA9Raw: 100_000n * A9, promoA9Raw: 100_000n * A9, jettonMaster: W('99') }),
    }),
    { code: 'INVENTORY_SNAPSHOT_MISMATCH' },
  );

  // Deduplicated promo liability verification:
  // Credit 100 A9 to W('d1') and open a PENDING_FEE claim -> must count ONCE (100 A9), NOT 200 A9!
  await promoEngine.creditReward(W('d1'), 100n * A9, nowSec + 10);
  const claim = await promoEngine.createClaimIntent(W('d1'), nowSec + 11);
  assert.equal(claim.status, 'PENDING_FEE');
  // Promo outstanding now = 270 A9 (3 reserved referrals) + 100 A9 (claimable_raw, NOT double-counted by PENDING_FEE) = 370 A9.
  // With promo snapshot = 460 A9 (370 + 90), 1 referred bronze order MUST succeed!
  const dedupOk = await presaleEngine.createOrderIntent(W('d2'), null, nowSec + 12, {
    skuId: 'chest_bronze',
    referrerId: W_REF,
    inventorySnapshot: makeSnap(nowSec + 12, { presaleA9Raw: 100_000n * A9, promoA9Raw: 460n * A9 }),
  });
  assert.equal(dedupOk.status, 'PENDING_PAYMENT');

  // Existing order verification/fulfillment STILL works even when new-order snapshots are stale/unavailable!
  const paidOrd = okOrders[0];
  const ing = await presaleEngine.ingestInbound(
    { txHash: 'tx-existing-ok', finality: 'finalized', to: PRESALE_HOT, from: paidOrd.walletAddress, valueNano: paidOrd.payTonNano, memo: paidOrd.memo },
    nowSec + 600,
  );
  assert.equal(ing.action, 'CONFIRM');
  assert.equal(await presaleEngine.queueConfirmedPayouts(nowSec + 605), 1);
});

// ---------------------------------------------------------------------------
// 2. Mandatory Reconciliation #2: Critical presale_promo Budget & Reserved 6% Referral
// ---------------------------------------------------------------------------
await test('Reconciliation #2: critical presale_promo budget reserves maxBonus+6% referral atomically, releases unused bonus on roll, and credits 6% referral without double-deducting', async () => {
  // Deterministic roll -> 0.75 hits a non-zero crit tier strictly below maxBoost (4,000 A9)
  const { presaleEngine, promoEngine, budgetLedger } = buildD1Stack({
    budgetOverrides: { presale_promo: String(4_500n * A9) }, // chest_silver needs 4,000 maxBoost + 480 ref = 4,480 A9 (leaves 20 A9)
    randomFn: () => 0.75,
  });
  const W_BUY = W('41');
  const W_REF = W('42');

  const ord1 = await presaleEngine.createOrderIntent(W_BUY, null, 20_000, { skuId: 'chest_silver', referrerId: W_REF });
  assert.equal(ord1.reservedBonusRaw, String(4_000n * A9));
  assert.equal(ord1.reservedReferralRaw, String(480n * A9));
  assert.equal((await budgetLedger.getBucket('presale_promo')).spentRaw, String(4_480n * A9));

  // Second order rejected BEFORE payment because only 20 A9 remains in presale_promo
  await assert.rejects(
    () => presaleEngine.createOrderIntent(W('43'), null, 20_001, { skuId: 'chest_bronze' }),
    { code: 'PROMO_BUDGET_EXHAUSTED' },
  );
  assert.equal((await presaleEngine.listOrders(W('43'))).length, 0);

  // Order 1 pays; duplicate payment callback is idempotent REPLAY
  const in1 = await presaleEngine.ingestInbound(
    { txHash: 'tx-crit-1', finality: 'finalized', to: PRESALE_HOT, from: W_BUY, valueNano: ord1.payTonNano, memo: ord1.memo },
    20_005,
  );
  assert.equal(in1.action, 'CONFIRM');
  const inDup = await presaleEngine.ingestInbound(
    { txHash: 'tx-crit-1', finality: 'finalized', to: PRESALE_HOT, from: W_BUY, valueNano: ord1.payTonNano, memo: ord1.memo },
    20_006,
  );
  assert.equal(inDup.action, 'REPLAY');

  // Queue payout rolls non-zero bonus and releases unused difference in ONE transaction -> spent = rolledBonus + 480 A9
  assert.equal(await presaleEngine.queueConfirmedPayouts(20_010), 1);
  // Restart / retry queueConfirmedPayouts is a no-op and reuses persisted roll
  assert.equal(await presaleEngine.queueConfirmedPayouts(20_011), 0);
  const ordAfterRoll = await presaleEngine.getOrder(ord1.orderId);
  assert.equal(ordAfterRoll.bonusRolled, true);
  const rolledBonus = BigInt(ordAfterRoll.bonusA9Raw);
  assert.ok(rolledBonus > 0n && rolledBonus < 4_000n * A9, `expected partial non-zero bonus, got ${rolledBonus}`);
  const expectedSpentAfterRoll = rolledBonus + 480n * A9;
  assert.equal((await budgetLedger.getBucket('presale_promo')).spentRaw, expectedSpentAfterRoll.toString());
  const resAfterRoll = await presaleEngine.getOrderReservation(ord1.orderId);
  assert.equal(resAfterRoll.settledBonusRaw + resAfterRoll.releasedBonusRaw, 4_000n * A9, 'settled + released bonus must equal reserved maxBonus');

  // Complete A9 payout -> referral credit becomes PENDING -> processReferralCredits credits 480 A9 WITHOUT double-deducting presale_promo!
  await presaleEngine.processPayouts(20_020, {
    a9Broadcaster: async () => ({ txHash: 'out-crit-1' }),
    verifier: async () => ({ state: 'CONFIRMED' }),
  });
  // Even if another order consumes all remaining budget before processReferralCredits runs, promised 480 A9 referral STILL credits!
  const spentBeforeRef = (await budgetLedger.getBucket('presale_promo')).spentRaw;
  assert.equal(spentBeforeRef, expectedSpentAfterRoll.toString());
  await budgetLedger.reserve('presale_promo', 4_500n * A9 - expectedSpentAfterRoll, 20_021); // Exhaust 100% of remaining budget!
  assert.equal((await budgetLedger.getBucket('presale_promo')).spentRaw, String(4_500n * A9));

  const refOut = await presaleEngine.processReferralCredits(20_025);
  assert.equal(refOut.credited, 1);
  assert.equal(refOut.budgetExhausted, 0);
  assert.equal((await promoEngine.getBalance(W_REF)).claimableRaw, String(480n * A9));
  assert.equal((await budgetLedger.getBucket('presale_promo')).spentRaw, String(4_500n * A9), 'promised referral MUST NOT double-deduct presale_promo');
  const finalRes = await presaleEngine.getOrderReservation(ord1.orderId);
  assert.equal(finalRes.status, 'COMPLETED');
  assert.equal(finalRes.bonusStatus, 'SETTLED');
  assert.equal(finalRes.referralStatus, 'CREDITED');
});

// ---------------------------------------------------------------------------
// 3. Mandatory Reconciliation #3: Bronze 200 / Warmup 300 / Prediction 800 = 1,300 A9
// ---------------------------------------------------------------------------
await test('Reconciliation #3: Bronze 200 + Warmup 300 + Prediction 800 = 1,300 A9 inherit 48H window, exact boundary activatable, expiry reclaims exact buckets', async () => {
  const { chestEngine, predictionEngine, promoEngine, budgetLedger, identityStore } = buildD1Stack();
  const W_U1 = W('51');
  const W_U2 = W('52');
  await identityStore.bindWallet('u_mix', W_U1, 100);
  await identityStore.bindWallet('u_edge', W_U2, 100);

  const t0Sec = 100_000;
  const t0Ms = t0Sec * 1000;

  // 1) Bronze 200 A9 (free_chest_captain) at t0
  const st = await chestEngine.claimStarterBronzeChests({ userId: 'u_mix', walletAddress: W_U1 }, t0Sec);
  await chestEngine.openChest({ chestId: st.chests[0].chestId, userId: 'u_mix', walletAddress: W_U1, predictionEngine, budgetLedger }, t0Sec);

  // 2) Warmup 300 A9 (warmup) at t0 + 6h
  const wc = await chestEngine.ensureWarmupRoundChest(
    { userId: 'u_mix', roundId: 1, walletAddress: W_U1, validInvites: 1, config: { baseA9Raw: String(300n * A9), stepA9Raw: '0', minInvites: 1, maxInvites: 5 } },
    t0Sec + 6 * 3600,
  );
  await chestEngine.openChest({ chestId: wc.chest.chestId, userId: 'u_mix', walletAddress: W_U1, predictionEngine, budgetLedger }, t0Sec + 6 * 3600);

  // 3) Prediction 800 A9 (prediction) at t0 + 12h
  await predictionEngine.placeBet({ roundId: 1, userId: 'u_mix', side: 'PASS' }, t0Sec + 11 * 3600);
  await predictionEngine.settleRoundBets(1, true, 10, DEFAULT_PREDICTION_POOL_A9_RAW, (t0Sec + 12 * 3600) * 1000, { budgetLedger });

  const sumBefore = await predictionEngine.getUserSummary('u_mix');
  assert.equal(sumBefore.pendingActivationRaw, String(1_300n * A9));
  assert.equal(sumBefore.pendingExpiresAt, t0Ms + VOUCHER_TTL_MS, 'subsequent rewards inherit original 48h window');
  assert.equal((await budgetLedger.getBucket('free_chest_captain')).spentRaw, String(200n * A9));
  assert.equal((await budgetLedger.getBucket('warmup')).spentRaw, String(300n * A9));
  assert.equal((await budgetLedger.getBucket('prediction')).spentRaw, String(800n * A9));

  // Verify exact expiry boundary (nowMs === pendingExpiresAt) is STILL activatable on u_edge
  const st2 = await chestEngine.claimStarterBronzeChests({ userId: 'u_edge', walletAddress: W_U2 }, t0Sec);
  await chestEngine.openChest({ chestId: st2.chests[0].chestId, userId: 'u_edge', walletAddress: W_U2, predictionEngine, budgetLedger }, t0Sec);
  const actEdge = await predictionEngine.activateToPromo('u_edge', W_U2, promoEngine, {
    qualified: true,
    nowMs: t0Ms + VOUCHER_TTL_MS, // exact boundary
    activationId: 'act-exact-boundary',
    budgetLedger,
  });
  assert.equal(actEdge.activatedRaw, String(200n * A9));
  assert.equal((await promoEngine.getBalance(W_U2)).claimableRaw, String(200n * A9));

  // Reclaim at t0Ms + VOUCHER_TTL_MS + 1 (1ms past expiry) -> u_mix's 3 buckets return exact 200 / 300 / 800 A9!
  const rec = await predictionEngine.reclaimExpiredVouchers(t0Ms + VOUCHER_TTL_MS + 1, { budgetLedger });
  assert.equal(rec.reclaimedVouchers, 3);
  assert.equal(rec.reclaimedRaw, String(1_300n * A9));
  assert.equal(rec.byBucket.free_chest_captain, String(200n * A9));
  assert.equal(rec.byBucket.warmup, String(300n * A9));
  assert.equal(rec.byBucket.prediction, String(800n * A9));

  assert.equal((await predictionEngine.getUserSummary('u_mix')).pendingActivationRaw, '0');
  // free_chest_captain retains ONLY u_edge's activated 200 A9; warmup & prediction back to 0!
  assert.equal((await budgetLedger.getBucket('free_chest_captain')).spentRaw, String(200n * A9));
  assert.equal((await budgetLedger.getBucket('warmup')).spentRaw, '0');
  assert.equal((await budgetLedger.getBucket('prediction')).spentRaw, '0');

  // Rerunning reclaim is a strict no-op (never double-releases)
  const recAgain = await predictionEngine.reclaimExpiredVouchers(t0Ms + VOUCHER_TTL_MS + 1000, { budgetLedger });
  assert.equal(recAgain.reclaimedVouchers, 0);
  assert.equal((await budgetLedger.getBucket('free_chest_captain')).spentRaw, String(200n * A9));
});

// ---------------------------------------------------------------------------
// 4. Concurrency (Activate vs Expire, Grant vs Expire, Batched Resume) & Async Payout Protection & Dry-Run
// ---------------------------------------------------------------------------
await test('Activate vs expire concurrency, new-grant after expiry, batched resumable reclaim, async payout lock, and dry-run zero-write', async () => {
  const { db, chestEngine, predictionEngine, promoEngine, presaleEngine, budgetLedger } = buildD1Stack();
  const t0Sec = 200_000;
  const t0Ms = t0Sec * 1000;

  // 4a) Concurrent activate vs expire at boundary+1ms -> voucher never both activates and reclaims
  const st = await chestEngine.claimStarterBronzeChests({ userId: 'u_race', walletAddress: W('61') }, t0Sec);
  await chestEngine.openChest({ chestId: st.chests[0].chestId, userId: 'u_race', walletAddress: W('61'), predictionEngine, budgetLedger }, t0Sec);
  const [actR, recR] = await Promise.allSettled([
    predictionEngine.activateToPromo('u_race', W('61'), promoEngine, { qualified: true, nowMs: t0Ms + VOUCHER_TTL_MS + 1, activationId: 'race-act', budgetLedger }),
    predictionEngine.reclaimExpiredVouchers(t0Ms + VOUCHER_TTL_MS + 1, { budgetLedger, userId: 'u_race' }),
  ]);
  assert.equal(actR.status, 'rejected');
  assert.equal(actR.reason.code, 'VOUCHER_EXPIRED');
  assert.equal(recR.status, 'fulfilled');
  assert.equal((await promoEngine.getBalance(W('61'))).claimableRaw, '0');
  assert.equal((await budgetLedger.getBucket('free_chest_captain')).spentRaw, '0');

  // 4b) New grant arriving after expiry reclaims expired voucher back to budget BEFORE opening new 48h window
  await budgetLedger.reserve('warmup', 300n * A9, t0Sec);
  await predictionEngine.creditPendingBonus('u_grant_exp', 300n * A9, t0Ms, {
    sourceBucket: 'warmup', sourceKind: 'WARMUP_CHEST', sourceRef: 'w1', voucherId: 'v_old_w1', budgetLedger,
  });
  await budgetLedger.reserve('prediction', 500n * A9, t0Sec + 200_000);
  await predictionEngine.creditPendingBonus('u_grant_exp', 500n * A9, t0Ms + VOUCHER_TTL_MS + 5000, {
    sourceBucket: 'prediction', sourceKind: 'PREDICTION_FIRST_LOSS', sourceRef: 'r2', voucherId: 'v_new_p1', budgetLedger,
  });
  assert.equal((await predictionEngine.getUserSummary('u_grant_exp')).pendingActivationRaw, String(500n * A9));
  assert.equal((await budgetLedger.getBucket('warmup')).spentRaw, '0', 'expired warmup voucher reclaimed on new grant');
  assert.equal((await budgetLedger.getBucket('prediction')).spentRaw, String(500n * A9));

  // 4c) Batched resumable reclaim (limit: 1 across 3 expired users)
  for (const uid of ['u_b1', 'u_b2', 'u_b3']) {
    await budgetLedger.reserve('warmup', 100n * A9, t0Sec);
    await predictionEngine.creditPendingBonus(uid, 100n * A9, t0Ms, {
      sourceBucket: 'warmup', sourceKind: 'WARMUP_CHEST', sourceRef: uid, voucherId: `vb_${uid}`, budgetLedger,
    });
  }
  const b1 = await predictionEngine.reclaimExpiredVouchers(t0Ms + VOUCHER_TTL_MS + 10, { budgetLedger, limit: 1 });
  const b2 = await predictionEngine.reclaimExpiredVouchers(t0Ms + VOUCHER_TTL_MS + 10, { budgetLedger, limit: 1 });
  const b3 = await predictionEngine.reclaimExpiredVouchers(t0Ms + VOUCHER_TTL_MS + 10, { budgetLedger, limit: 1 });
  const b4 = await predictionEngine.reclaimExpiredVouchers(t0Ms + VOUCHER_TTL_MS + 10, { budgetLedger, limit: 1 });
  assert.equal(b1.reclaimedVouchers + b2.reclaimedVouchers + b3.reclaimedVouchers, 3);
  assert.equal(b4.reclaimedVouchers, 0);
  assert.equal((await budgetLedger.getBucket('warmup')).spentRaw, '0');

  // 4d) Async in-flight A9 payout protection (PENDING/BROADCASTING/SENT/RETRY/NEEDS_REVIEW) & dry-run zero-write
  const ordExp = await presaleEngine.createOrderIntent(W('62'), null, t0Sec, { skuId: 'chest_bronze' });
  const ordPaid = await presaleEngine.createOrderIntent(W('63'), null, t0Sec, { skuId: 'chest_bronze', referrerId: W('64') });
  await presaleEngine.ingestInbound(
    { txHash: 'tx-inflight', finality: 'finalized', to: PRESALE_HOT, from: W('63'), valueNano: ordPaid.payTonNano, memo: ordPaid.memo },
    t0Sec + 5,
  );
  await presaleEngine.queueConfirmedPayouts(t0Sec + 10);
  // Put ordPaid's A9 payout in BROADCASTING and even force order status to CANCELLED to verify SQL guard blocks release!
  await db.prepare("UPDATE presale_payouts SET status = 'BROADCASTING' WHERE order_id = ?").bind(ordPaid.orderId).run();
  await db.prepare("UPDATE presale_orders SET status = 'CANCELLED' WHERE order_id = ?").bind(ordPaid.orderId).run();

  // Dry-run PresaleRunner MUST perform ZERO writes (does not expire ordExp or touch budget)
  const spentBeforeDry = (await budgetLedger.getBucket('presale_promo')).spentRaw;
  const runnerDry = new PresalePayoutRunner({
    engine: presaleEngine,
    tonCenter: { fetchInboundTransactions: async () => ({ txs: [], nextCursor: null }) },
    execute: false,
    logger: { log() {} },
  });
  await runnerDry.tick(t0Sec + 3600);
  assert.equal((await presaleEngine.getOrder(ordExp.orderId)).status, 'PENDING_PAYMENT', 'dry-run must not mutate expired order');
  assert.equal((await budgetLedger.getBucket('presale_promo')).spentRaw, spentBeforeDry, 'dry-run must not release budget');

  // Live release frees ONLY ordExp (expired unpaid), NEVER ordPaid (in-flight BROADCASTING A9 payout)!
  const rel = await presaleEngine.releaseExpiredOrRefundedReservations(t0Sec + 3600, { budgetLedger });
  assert.equal(rel.expiredReleased, 1);
  assert.equal(rel.refundedReleased, 0);
  assert.equal((await presaleEngine.getOrder(ordExp.orderId)).status, 'EXPIRED');
  assert.equal((await presaleEngine.getOrderReservation(ordPaid.orderId)).status, 'ACTIVE', 'in-flight A9 payout must keep reservation locked');
});

// ---------------------------------------------------------------------------
// 5. Fresh schema.sql vs 0001..0016 -> 0017 Upgrade, Idempotent Legacy Backfill, Fail-Closed Missing 0017
// ---------------------------------------------------------------------------
await test('Fresh schema.sql parity, missing 0017 fail-closed (HTTP 503), and 0001..0016 -> 0017 legacy order & voucher backfill idempotency', async () => {
  // 5a) Fresh schema.sql boots cleanly and supports new tables
  const schemaSql = fs.readFileSync(path.join(WORKER_DIR, 'schema.sql'), 'utf8');
  const freshDb = createSqliteD1([]);
  freshDb.exec(schemaSql);
  for (const tbl of ['presale_order_reservations', 'pending_reward_vouchers', 'actuarial_reconciliation_items']) {
    const r = await freshDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").bind(tbl).first();
    assert.equal(r?.name, tbl, `schema.sql must contain ${tbl}`);
  }

  // 5b) Missing 0017 DB fails closed (HTTP 503 MIGRATION_0017_REQUIRED) on mall order, chest open, and prediction settle
  const pre = buildD1Stack({ migrations: PRE_0017_MIGRATIONS });
  await pre.identityStore.bindWallet('801', W('81'), 100);
  const preOrderRes = await pre.router({
    method: 'POST', pathname: '/api/presale/intent',
    headers: await tgHeaders(801, { nowSec: 1000 }),
    body: { skuId: 'chest_bronze' },
    nowSec: 1000,
  });
  assert.equal(preOrderRes.status, 503);
  assert.equal(preOrderRes.body.error.code, 'MIGRATION_0017_REQUIRED');

  const stPre = await pre.chestEngine.claimStarterBronzeChests({ userId: '801', walletAddress: W('81') }, 1000);
  const preChestRes = await pre.router({
    method: 'POST', pathname: `/api/chests/${stPre.chests[0].chestId}/open`,
    headers: await tgHeaders(801, { nowSec: 1005 }),
    body: {},
    nowSec: 1005,
  });
  assert.equal(preChestRes.status, 503);
  assert.equal(preChestRes.body.error.code, 'MIGRATION_0017_REQUIRED');
  assert.equal((await pre.budgetLedger.getBucket('free_chest_captain')).spentRaw, '0', 'failed chest open must not leak budget');

  // 5c) Seed pre-0017 legacy orders & pending balances, then apply 0017 and run idempotent backfill twice
  const tNow = 50_000;
  // Legacy paid order with referrer (determinable)
  await pre.db
    .prepare(
      `INSERT INTO presale_orders (order_id, wallet_address, wallet_key, tg_user_id, referrer_id, sku_id, open_mode, ton_nano, a9_amount_raw, bonus_a9_raw, bonus_rolled, memo, status, inbound_tx_hash, refund_ton_nano, expires_at, created_at, updated_at)
       VALUES ('leg_ord_1', ?, ?, '801', ?, 'chest_bronze', 'INSTANT', '990000000', '1500000000000', '0', 0, 'buy:leg_ord_1', 'PAYMENT_CONFIRMED', 'tx_leg_1', '0', ?, ?, ?)`,
    )
    .bind(W('81'), W('81'), W('82'), tNow + 1800, tNow - 60, tNow - 30)
    .run();
  // Legacy unknown-SKU order (ambiguous -> reconciliation table)
  await pre.db
    .prepare(
      `INSERT INTO presale_orders (order_id, wallet_address, wallet_key, tg_user_id, referrer_id, sku_id, open_mode, ton_nano, a9_amount_raw, bonus_a9_raw, bonus_rolled, memo, status, inbound_tx_hash, refund_ton_nano, expires_at, created_at, updated_at)
       VALUES ('leg_ord_unk', ?, ?, '801', NULL, NULL, 'INSTANT', '123456789', '1000000000000', '0', 0, 'buy:leg_ord_unk', 'PAYMENT_CONFIRMED', 'tx_leg_2', '0', ?, ?, ?)`,
    )
    .bind(W('81'), W('81'), tNow + 1800, tNow - 60, tNow - 30)
    .run();

  // Legacy 1:1 provable pending balance (u_prov: 200 A9 from opened bronze chest)
  const expMs = (tNow + 3600) * 1000;
  const openedSec = tNow - 100;
  await pre.db
    .prepare(
      `INSERT INTO user_chests (chest_id, owner_user_id, owner_wallet_key, source, tier, slot_index, order_id, base_a9_raw, boost_a9_raw, max_boost_a9_raw, required_assists, current_assists, status, opened_at, created_at, updated_at)
       VALUES ('ch_leg_prov', 'u_prov', ?, 'FREE_TIER', 'bronze', 1, NULL, '200000000000', '0', '0', 0, 0, 'OPENED', ?, ?, ?)`,
    )
    .bind(W('83'), openedSec, openedSec - 10, openedSec)
    .run();
  await pre.db
    .prepare(
      `INSERT INTO prediction_rewards (user_id, pending_activation_raw, activated_raw, pending_expires_at, total_settled, total_won, streak, updated_at)
       VALUES ('u_prov', '200000000000', '0', ?, 0, 0, 0, ?)`,
    )
    .bind(expMs, openedSec)
    .run();
  // Legacy unattributable pending balance (u_mystery: 777 A9 with no source rows)
  await pre.db
    .prepare(
      `INSERT INTO prediction_rewards (user_id, pending_activation_raw, activated_raw, pending_expires_at, total_settled, total_won, streak, updated_at)
       VALUES ('u_mystery', '777000000000', '0', ?, 0, 0, 0, ?)`,
    )
    .bind(expMs, openedSec)
    .run();

  // Apply 0017 migration onto the upgraded 0001..0016 DB!
  const mig0017 = fs.readFileSync(path.join(WORKER_DIR, 'migrations', '0017_actuarial_reservations_and_vouchers.sql'), 'utf8');
  pre.db.exec(mig0017);

  const ordRec1 = await reconcileLegacyPresaleOrders(pre.db, tNow, { budgetLedger: pre.budgetLedger });
  assert.equal(ordRec1.backfilled, 1);
  assert.equal(ordRec1.reservedBudgetCount, 1, 'determinable legacy order must reserve its presale_promo exposure');
  assert.equal(ordRec1.reconciliationLogged, 1); // 1 unknown SKU logged for reconciliation
  const ordRec2 = await reconcileLegacyPresaleOrders(pre.db, tNow, { budgetLedger: pre.budgetLedger });
  assert.equal(ordRec2.backfilled, 0);
  assert.equal(ordRec2.reconciliationLogged, 0, 'reconcileLegacyPresaleOrders rerun must be idempotent');

  const vRec1 = await backfillLegacyPendingVouchers(pre.db, tNow);
  assert.equal(vRec1.backfilledUsers, 1);
  assert.equal(vRec1.backfilledVouchers, 1);
  assert.equal(vRec1.reconciliationLogged, 1);
  // Budget must NOT be re-deducted by backfill
  assert.equal((await pre.budgetLedger.getBucket('free_chest_captain')).spentRaw, '0');
  const vRec2 = await backfillLegacyPendingVouchers(pre.db, tNow);
  assert.equal(vRec2.backfilledUsers, 0);
  assert.equal(vRec2.alreadyCovered, 1);
  assert.equal(vRec2.reconciliationLogged, 0, 'backfillLegacyPendingVouchers rerun must be idempotent');

  // u_mystery has NO guessed voucher rows, stays logged in actuarial_reconciliation_items
  const mysteryVouchers = await pre.predictionEngine.listPendingVouchers('u_mystery');
  assert.equal(mysteryVouchers.length, 0);
});

// ---------------------------------------------------------------------------
// 6. Unified Prediction Config, Admin Override Cap Validation & Mainnet 503 Guards
// ---------------------------------------------------------------------------
await test('Unified prediction config (default 1,000,000 A9, invalid rejected), admin override capped at env single-round limit, mainnet 503 preserved', async () => {
  // Default when absent
  const def = resolvePredictionConfig({});
  assert.equal(def.defaultPoolA9Raw, 1_000_000n * A9);
  assert.equal(def.defaultPoolA9RawStr, '1000000000000000');
  assert.equal(def.firstLossBonusRaw, 500n * A9);
  assert.equal(def.firstLossCapRaw, 200_000n * A9);

  // Explicit 0 disables first-loss
  const zeroFl = resolvePredictionConfig({ A9_PRED_FIRST_LOSS_BONUS_RAW: '0', A9_PRED_FIRST_LOSS_CAP_RAW: '0' });
  assert.equal(zeroFl.firstLossBonusRaw, 0n);
  assert.equal(zeroFl.firstLossCapRaw, 0n);

  // Invalid env values rejected
  for (const bad of ['0', '-100', '1.5', '1e15', 'abc', String(BigInt(PROMO_BUDGET_BUCKETS.prediction) + 1n)]) {
    assert.throws(() => resolvePredictionConfig({ A9_PREDICTION_POOL_A9_RAW: bad }), { code: 'BAD_PREDICTION_CONFIG' });
  }

  // Admin override validation via router: rejects 100,000,000 A9 lifecycle cap as single-round override!
  const { router } = buildD1Stack();
  for (const badPool of ['0', '-1', '100.5', 1000, '1000000000000001', PROMO_BUDGET_BUCKETS.prediction]) {
    const r = await router({
      method: 'POST', pathname: '/api/admin/prediction/settle',
      headers: { 'x-a9-admin-token': 'adm-v17' },
      body: { roundId: 1, passed: true, actualQualified: 10, poolA9Raw: badPool },
      nowSec: 5000,
    });
    assert.equal(r.status, 400, `expected 400 for bad admin poolA9Raw=${String(badPool)}`);
  }
  // Valid override <= defaultPoolA9Raw succeeds
  assert.equal(validateAdminPredictionPoolOverride('500000000000000', DEFAULT_PREDICTION_POOL_A9_RAW), '500000000000000');

  // Mainnet 503 protection on stake-referral & airdrop write routes remains closed
  const mainnetStack = buildD1Stack({ envExtra: { A9_NETWORK: 'mainnet', A9_ENVIRONMENT: 'production' } });
  const sr503 = await mainnetStack.router({
    method: 'POST', pathname: '/api/admin/v17/stake-referral/settle',
    headers: { 'x-a9-admin-token': 'adm-v17' },
    body: { roundId: 1, referrerWallet: W('91'), refereeWallet: W('92'), refereeRewardRaw: '1000000000' },
    nowSec: 5000,
  });
  assert.equal(sr503.status, 503);
  assert.equal(sr503.body.error.code, 'V17_CHAIN_SETTLEMENT_UNAVAILABLE');

  const ad503 = await mainnetStack.router({
    method: 'POST', pathname: '/api/admin/v17/airdrop/draw',
    headers: { 'x-a9-admin-token': 'adm-v17' },
    body: { roundId: 1, participants: [W('91')], seedHash: '00'.repeat(32) },
    nowSec: 5000,
  });
  assert.equal(ad503.status, 503);
  assert.equal(ad503.body.error.code, 'V17_CHAIN_SETTLEMENT_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// 7. Signing Daemon D1 HTTP Adapter (createD1HttpClient): Timeout -> Re-Read -> Retry Same Operation ID
// ---------------------------------------------------------------------------
await test('D1 HTTP adapter (simulated server + timeout): timeout after server commit -> re-read state -> retry same activationId idempotently', async () => {
  const backingDb = createSqliteD1(MIGRATIONS);
  let injectTimeoutNextWrite = false;
  let httpCalls = 0;

  // Simulated Cloudflare D1 REST API backed by local SQLite
  const mockFetch = async (_url, init) => {
    httpCalls += 1;
    const body = JSON.parse(init.body);
    const items = Array.isArray(body.batch) ? body.batch : [body];
    const isBatchWrite = Array.isArray(body.batch) && items.some((it) => !/^\s*(SELECT|PRAGMA)/i.test(it.sql));
    const stmts = items.map((it) => backingDb.prepare(it.sql).bind(...(it.params || [])));
    const results = items.length === 1
      ? [/^\s*(SELECT|PRAGMA|WITH)/i.test(items[0].sql) ? await stmts[0].all() : await stmts[0].run()]
      : await backingDb.batch(stmts);

    // Simulate response timeout AFTER the server already committed the atomic batch!
    if (isBatchWrite && injectTimeoutNextWrite) {
      injectTimeoutNextWrite = false;
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          result: results.map((r) => ({ success: true, results: r.results || [], meta: r.meta || { changes: 0 } })),
        };
      },
    };
  };

  const httpDb = createD1HttpClient({
    accountId: 'acc-sim',
    databaseId: 'db-sim',
    apiToken: 'tok-sim',
    fetchImpl: mockFetch,
    timeoutMs: 1000,
  });

  const budgetLedger = new D1PromoBudgetLedger({ db: httpDb });
  const promoEngine = new D1PromoStore({ db: httpDb, hotWalletAddress: PROMO_HOT });
  const predictionEngine = new D1PredictionEngine({ db: httpDb, budgetLedger });

  const nowMs = 300_000 * 1000;
  await budgetLedger.reserve('warmup', 300n * A9, 300_000);
  await predictionEngine.creditPendingBonus('u_http', 300n * A9, nowMs, {
    sourceBucket: 'warmup', sourceKind: 'WARMUP_CHEST', sourceRef: 'w_http', voucherId: 'v_http_1', budgetLedger,
  });

  // Trigger simulated timeout on the activateToPromo batch commit (server commits, client sees TimeoutError)
  injectTimeoutNextWrite = true;
  await assert.rejects(
    () => predictionEngine.activateToPromo('u_http', W('77'), promoEngine, {
      qualified: true,
      nowMs: nowMs + 1000,
      activationId: 'op-http-idem-1',
      budgetLedger,
    }),
    { name: 'TimeoutError' },
  );

  // Re-read state after timeout: pending is already 0, promo balance is 300 A9
  const rereadSummary = await predictionEngine.getUserSummary('u_http');
  assert.equal(rereadSummary.pendingActivationRaw, '0');
  assert.equal((await promoEngine.getBalance(W('77'))).claimableRaw, String(300n * A9));

  // Retry with the SAME operation ID (`op-http-idem-1`) -> returns idempotent: true, ZERO double-credit!
  const retryRes = await predictionEngine.activateToPromo('u_http', W('77'), promoEngine, {
    qualified: true,
    nowMs: nowMs + 2000,
    activationId: 'op-http-idem-1',
    budgetLedger,
  });
  assert.equal(retryRes.idempotent, true);
  assert.equal(retryRes.activatedRaw, String(300n * A9));
  assert.equal((await promoEngine.getBalance(W('77'))).claimableRaw, String(300n * A9), 'retry with same op ID must never double-credit');
  assert.ok(httpCalls > 5);
});

// ---------------------------------------------------------------------------
// 8. Rejection Blocker P0 #1: Exact Expiry Second & Lagged RPC Balance Oversell
// ---------------------------------------------------------------------------
await test('Blocker P0 #1: exact expiry second cannot oversell 2,500 A9 inventory; lagged RPC with only fetchedAt refreshed cannot oversell', async () => {
  const { db, presaleEngine } = buildD1Stack({ requireInventorySnapshot: true, randomFn: () => 0.99 });
  const t0 = 500_000;
  const snap2500 = (ts, extra = {}) => makeSnap(ts, { presaleA9Raw: 2_500n * A9, promoA9Raw: 10_000n * A9, ...extra });

  // 1a) Create Order 1 using full 2,500 A9 presale inventory (chest_bronze: 1,500 base + 1,000 maxBoost)
  const ord1 = await presaleEngine.createOrderIntent(W('e1'), null, t0, { skuId: 'chest_bronze', inventorySnapshot: snap2500(t0) });
  const exactExpSec = ord1.expiresAt;

  // At exact expiry second (nowSec === expiresAt), Order 1 is STILL confirmable by commitInbound ->
  // Order 2 MUST be rejected with HOT_WALLET_LOW_INVENTORY so 2,500 A9 inventory NEVER queues 5,000 A9 payouts!
  await assert.rejects(
    () => presaleEngine.createOrderIntent(W('e2'), null, exactExpSec, { skuId: 'chest_bronze', inventorySnapshot: snap2500(exactExpSec) }),
    { code: 'HOT_WALLET_LOW_INVENTORY' },
  );

  // Confirm Order 1 at exactExpSec and complete its A9 payout at exactExpSec + 10
  const in1 = await presaleEngine.ingestInbound(
    { txHash: 'tx-edge-1', finality: 'finalized', to: PRESALE_HOT, from: W('e1'), valueNano: ord1.payTonNano, memo: ord1.memo },
    exactExpSec,
  );
  assert.equal(in1.action, 'CONFIRM');
  assert.equal(await presaleEngine.queueConfirmedPayouts(exactExpSec + 2), 1);
  await presaleEngine.processPayouts(exactExpSec + 10, {
    a9Broadcaster: async () => ({ txHash: 'out-edge-1' }),
    verifier: async () => ({ state: 'CONFIRMED', txHash: 'out-edge-1' }),
  });
  assert.equal((await presaleEngine.getOrder(ord1.orderId)).status, 'COMPLETED');

  // 1b) Lagged RPC returns the OLD 2,500 A9 balance with only fetchedAt bumped (NO on-chain confirmedThroughAt / includedConfirmedTxHashes proof)
  // -> MUST still count the CONFIRMED payout and reject Order 2!
  const laggedTs = exactExpSec + 25;
  await assert.rejects(
    () => presaleEngine.createOrderIntent(W('e2'), null, laggedTs, { skuId: 'chest_bronze', inventorySnapshot: snap2500(laggedTs) }),
    { code: 'HOT_WALLET_LOW_INVENTORY' },
  );

  // Even if confirmedThroughAt is provided but <= payout.updated_at, MUST still reject!
  const staleBlockSnap = makeSnap(laggedTs, { presaleA9Raw: 2_500n * A9, promoA9Raw: 10_000n * A9 });
  staleBlockSnap.presale.confirmedThroughAt = exactExpSec + 10;
  await assert.rejects(
    () => presaleEngine.createOrderIntent(W('e2'), null, laggedTs, { skuId: 'chest_bronze', inventorySnapshot: staleBlockSnap }),
    { code: 'HOT_WALLET_LOW_INVENTORY' },
  );

  // A newer time and loose transaction identifiers carry no chain-position proof.
  const unproven = makeSnap(laggedTs, { presaleA9Raw: 2_500n * A9, promoA9Raw: 10_000n * A9 });
  unproven.presale.confirmedThroughAt = laggedTs;
  unproven.presale.includedConfirmedTxHashes = ['out-edge-1'];
  await assert.rejects(
    () => presaleEngine.createOrderIntent(W('e2'), null, laggedTs, { skuId: 'chest_bronze', inventorySnapshot: unproven }),
    { code: 'HOT_WALLET_LOW_INVENTORY' },
  );
  const payoutCnt = Number((await db.prepare("SELECT COUNT(*) AS c FROM presale_payouts WHERE kind = 'A9'").first()).c);
  assert.equal(payoutCnt, 1);
});

// ---------------------------------------------------------------------------
// 9. Rejection Blocker P0 #2: Prediction Settle Single-Transaction Budget & Voucher Atomicity
// ---------------------------------------------------------------------------
await test('Blocker P0 #2: prediction settle timeout after commit keeps 800 A9 voucher = 800 A9 budget; pre-commit interrupt leaves 0/0 and reruns cleanly', async () => {
  // 2a) Server commits db.batch then response times out -> MUST keep 800 A9 voucher AND 800 A9 budget (NOT 800/0)
  const backingA = createSqliteD1(MIGRATIONS);
  let timeoutAfterCommit = false;
  const timeoutDb = {
    prepare: (sql) => backingA.prepare(sql),
    async batch(stmts) {
      const out = await backingA.batch(stmts);
      if (timeoutAfterCommit) {
        timeoutAfterCommit = false;
        const err = new Error('Simulated D1 timeout after server commit');
        err.name = 'TimeoutError';
        throw err;
      }
      return out;
    },
  };
  const ledgerA = new D1PromoBudgetLedger({ db: timeoutDb });
  const predA = new D1PredictionEngine({ db: timeoutDb, budgetLedger: ledgerA });
  await predA.placeBet({ roundId: 10, userId: 'u_timeout', side: 'PASS' }, 1000);

  // Arm timeout on the settlement batch (after ensureStmts)
  let batchIdx = 0;
  const origBatchA = timeoutDb.batch;
  timeoutDb.batch = async (stmts) => {
    batchIdx += 1;
    if (batchIdx === 2) timeoutAfterCommit = true;
    return origBatchA(stmts);
  };
  await assert.rejects(
    () => predA.settleRoundBets(10, true, 10, DEFAULT_PREDICTION_POOL_A9_RAW, 2000 * 1000, { budgetLedger: ledgerA }),
    { name: 'TimeoutError' },
  );
  const vouchersAfterTimeout = await predA.listPendingVouchers('u_timeout', { status: 'PENDING' });
  assert.equal(vouchersAfterTimeout.length, 1);
  assert.equal(vouchersAfterTimeout[0].amountRaw, String(800n * A9));
  assert.equal((await ledgerA.getBucket('prediction')).spentRaw, String(800n * A9), 'timeout after commit MUST preserve 800 A9 budget deduction');

  // Rerun settleRoundBets finishes prediction_rounds with zero double-deduction
  await predA.settleRoundBets(10, true, 10, DEFAULT_PREDICTION_POOL_A9_RAW, 2005 * 1000, { budgetLedger: ledgerA });
  assert.equal((await ledgerA.getBucket('prediction')).spentRaw, String(800n * A9));
  assert.equal((await predA.listPendingVouchers('u_timeout', { status: 'PENDING' })).length, 1);

  // 2b) Interrupt BEFORE settlement db.batch commits -> 0 A9 budget, 0 vouchers; rerun succeeds even with exact 800 A9 cap!
  const backingB = createSqliteD1(MIGRATIONS);
  backingB.prepare('UPDATE promo_budget_ledger SET cap_raw = ?, spent_raw = ? WHERE bucket_key = ?')
    .bind(String(800n * A9), '0', 'prediction')
    .run();
  let batchIdxB = 0;
  const interruptDb = {
    prepare: (sql) => backingB.prepare(sql),
    async batch(stmts) {
      batchIdxB += 1;
      if (batchIdxB === 2) throw new Error('SIMULATED_CRASH_BEFORE_SETTLE_BATCH');
      return backingB.batch(stmts);
    },
  };
  const ledgerB = new D1PromoBudgetLedger({ db: interruptDb });
  const predB = new D1PredictionEngine({ db: interruptDb, budgetLedger: ledgerB });
  await predB.placeBet({ roundId: 11, userId: 'u_interrupt', side: 'PASS' }, 1000);

  await assert.rejects(
    () => predB.settleRoundBets(11, true, 10, DEFAULT_PREDICTION_POOL_A9_RAW, 2000 * 1000, { budgetLedger: ledgerB }),
    /SIMULATED_CRASH_BEFORE_SETTLE_BATCH/,
  );
  assert.equal((await ledgerB.getBucket('prediction')).spentRaw, '0', 'pre-commit interrupt MUST leave 0 A9 budget spent');
  assert.equal((await predB.listPendingVouchers('u_interrupt')).length, 0);

  // Rerun succeeds cleanly against exact 800 A9 cap (NO false PROMO_BUDGET_EXHAUSTED!)
  await predB.settleRoundBets(11, true, 10, DEFAULT_PREDICTION_POOL_A9_RAW, 2005 * 1000, { budgetLedger: ledgerB });
  assert.equal((await ledgerB.getBucket('prediction')).spentRaw, String(800n * A9));
  assert.equal((await predB.listPendingVouchers('u_interrupt', { status: 'PENDING' })).length, 1);
});

// ---------------------------------------------------------------------------
// 10. Rejection Blocker P1 #3: Truncated Inbound Scan Must Not Release Reservations; Late Payment Auto-Refunds
// ---------------------------------------------------------------------------
await test('Blocker P1 #3: truncated inbound scan skips expiry release; late payment enters automatic refund queue (not ANOMALY)', async () => {
  const { db, presaleEngine, budgetLedger } = buildD1Stack();
  const t0 = 600_000;
  const ord = await presaleEngine.createOrderIntent(W('f1'), null, t0, { skuId: 'chest_bronze' });
  assert.equal((await budgetLedger.getBucket('presale_promo')).spentRaw, String(1_000n * A9));

  // Tick 1: inbound scan is TRUNCATED (reachedCursor: false, truncated: true) after order expiry
  const tLate = ord.expiresAt + 120;
  const runnerTrunc = new PresalePayoutRunner({
    engine: presaleEngine,
    tonCenter: {
      fetchInboundTransfersSince: async () => ({
        transfers: [],
        nextCursor: { lt: '100', hash: 'h100' },
        reachedCursor: false,
        truncated: true,
        canAdvanceCursor: false,
      }),
    },
    a9Broadcaster: async () => ({ txHash: 'unused' }),
    execute: true,
    logger: { log() {} },
  });
  const s1 = await runnerTrunc.tick(tLate);
  assert.equal(s1.reservationsReleased, undefined, 'truncated scan MUST NOT run releaseExpiredOrRefundedReservations');
  assert.equal((await presaleEngine.getOrder(ord.orderId)).status, 'PENDING_PAYMENT', 'order must remain PENDING_PAYMENT while scan is truncated');
  assert.equal((await budgetLedger.getBucket('presale_promo')).spentRaw, String(1_000n * A9), '1,000 A9 reservation must remain locked while scan is truncated');

  // Tick 2: complete scan delivers the late payment -> MUST queue automatic REFUND (NOT ANOMALY with 0 refunds!)
  const runnerComplete = new PresalePayoutRunner({
    engine: presaleEngine,
    tonCenter: {
      fetchInboundTransfersSince: async () => ({
        transfers: [{
          txHash: 'tx-late-after-trunc',
          finality: 'finalized',
          to: PRESALE_HOT,
          from: W('f1'),
          valueNano: ord.payTonNano,
          memo: ord.memo,
        }],
        nextCursor: { lt: '101', hash: 'h101' },
        reachedCursor: true,
        truncated: false,
        canAdvanceCursor: true,
      }),
    },
    a9Broadcaster: async () => ({ txHash: 'unused' }),
    execute: true,
    logger: { log() {} },
  });
  const s2 = await runnerComplete.tick(tLate + 10);
  assert.equal(s2.refundQueued, 1, 'late payment must enter automatic refund queue');
  assert.equal(s2.anomalies, 0, 'late payment must not be misclassified as ANOMALY');
  const refundPayouts = (await db.prepare("SELECT * FROM presale_payouts WHERE kind = 'REFUND'").all())?.results || [];
  assert.equal(refundPayouts.length, 1);

  // Also verify: even if an order WAS legitimately marked EXPIRED after a complete empty scan, a later exact-sender/exact-amount payment STILL auto-refunds!
  const ord2 = await presaleEngine.createOrderIntent(W('f2'), null, t0, { skuId: 'chest_bronze' });
  const rel = await presaleEngine.releaseExpiredOrRefundedReservations(ord2.expiresAt + 60, { budgetLedger });
  assert.equal(rel.expiredReleased, 1);
  assert.equal((await presaleEngine.getOrder(ord2.orderId)).status, 'EXPIRED');
  const lateAfterExp = await presaleEngine.ingestInbound({
    txHash: 'tx-late-after-expired',
    finality: 'finalized',
    to: PRESALE_HOT,
    from: W('f2'),
    valueNano: ord2.payTonNano,
    memo: ord2.memo,
  }, ord2.expiresAt + 120);
  assert.equal(lateAfterExp.action, 'REFUND');
  assert.equal(lateAfterExp.reason, 'expired');
  assert.equal((await presaleEngine.getOrder(ord2.orderId)).status, 'REFUND_PENDING');
});

// ---------------------------------------------------------------------------
// 11. Rejection Blocker P1 #4: New Orders Must Not Crowd Out Pre-0017 Paid Legacy Orders
// ---------------------------------------------------------------------------
await test('Blocker P1 #4: after 0016 -> 0017 backfill, new orders cannot crowd out pre-0017 paid legacy order; legacy order queues full payout cleanly', async () => {
  const pre = buildD1Stack({
    migrations: PRE_0017_MIGRATIONS,
    budgetOverrides: { presale_promo: String(1_500n * A9) }, // Only 1,500 A9 total budget: covers 1 legacy bronze (1,000 A9), NOT a second new bronze (1,000 A9)!
    randomFn: () => 0.75,
  });
  const tNow = 700_000;

  // Seed pre-0017 paid legacy bronze order (1,500 base + up to 1,000 bonus)
  await pre.db
    .prepare(
      `INSERT INTO presale_orders (order_id, wallet_address, wallet_key, tg_user_id, referrer_id, sku_id, open_mode, ton_nano, a9_amount_raw, bonus_a9_raw, bonus_rolled, memo, status, inbound_tx_hash, refund_ton_nano, expires_at, created_at, updated_at)
       VALUES ('leg_paid_protect', ?, ?, '901', NULL, 'chest_bronze', 'INSTANT', '990000000', '1500000000000', '0', 0, 'buy:leg_paid_protect', 'PAYMENT_CONFIRMED', 'tx_leg_protect', '0', ?, ?, ?)`,
    )
    .bind(W('91'), W('91'), tNow + 1800, tNow - 30, tNow - 10)
    .run();

  // Upgrade 0016 -> 0017 and run reconcileLegacyPresaleOrders
  const mig0017 = fs.readFileSync(path.join(WORKER_DIR, 'migrations', '0017_actuarial_reservations_and_vouchers.sql'), 'utf8');
  pre.db.exec(mig0017);
  const rec = await reconcileLegacyPresaleOrders(pre.db, tNow, { budgetLedger: pre.budgetLedger });
  assert.equal(rec.backfilled, 1);
  assert.equal(rec.reservedBudgetCount, 1);
  assert.equal((await pre.budgetLedger.getBucket('presale_promo')).spentRaw, String(1_000n * A9));

  // New bronze order needs 1,000 A9 bonus -> only 500 A9 remains -> MUST be rejected BEFORE payment!
  await assert.rejects(
    () => pre.presaleEngine.createOrderIntent(W('92'), null, tNow + 1, { skuId: 'chest_bronze' }),
    { code: 'PROMO_BUDGET_EXHAUSTED' },
  );

  // Pre-0017 paid legacy order queues its full A9 payout cleanly (NEVER NEEDS_REVIEW, payout instruction === 1)!
  const queued = await pre.presaleEngine.queueConfirmedPayouts(tNow + 2);
  assert.equal(queued, 1);
  const legOrder = await pre.presaleEngine.getOrder('leg_paid_protect');
  assert.equal(legOrder.status, 'PAYOUT_PENDING');
  assert.equal(legOrder.bonusRolled, true);
  const legPayouts = (await pre.db.prepare("SELECT * FROM presale_payouts WHERE order_id = 'leg_paid_protect' AND kind = 'A9'").all())?.results || [];
  assert.equal(legPayouts.length, 1);
  assert.ok(BigInt(legPayouts[0].amount) > 1_500n * A9, 'legacy paid order must receive base + rolled bonus payout');
});

// ---------------------------------------------------------------------------
// 12. Rejection Blocker P0 #5: Daemon Snapshot Proves Confirmed Payout Deduction -> Next Order Approved; Lagged RPC Still Rejected
// ---------------------------------------------------------------------------
async function exerciseDaemonInventory(dbOverride = null) {
  const { db, presaleEngine } = buildD1Stack({
    requireInventorySnapshot: true, randomFn: () => 0.999999, dbOverride,
  });
  const t0 = 800_000;
  let mockPresaleA9 = 5_000n * A9;
  const mockPromoA9 = 10_000n * A9;
  let presaleLt = '100';
  const debitLts = new Map();
  let pendingInboundTxs = [];

  const mockTc = {
    async fetchInboundTransfersSince(addr) {
      if (addr === PRESALE_HOT) {
        const out = pendingInboundTxs;
        pendingInboundTxs = [];
        return { transfers: out, nextCursor: { lt: '10', hash: 'h10' }, reachedCursor: true, truncated: false, canAdvanceCursor: true };
      }
      return { transfers: [], nextCursor: null, reachedCursor: true, truncated: false, canAdvanceCursor: true };
    },
    async fetchAccountBalanceNano() {
      return 5_000_000_000n; // 5 GRAM
    },
    async fetchHotWalletInventoryState(_master, owner) {
      const bal = owner === PRESALE_HOT ? mockPresaleA9 : mockPromoA9;
      return {
        jettonWallet: owner === PRESALE_HOT ? W('61') : W('62'),
        walletLt: owner === PRESALE_HOT ? presaleLt : '100',
        a9BalanceRaw: bal.toString(),
        balanceAvailable: true,
      };
    },
    async fetchHotWalletPayoutDebitLt(wallet, _owner, hash) {
      assert.equal(wallet, W('61'));
      return debitLts.get(hash) ?? null;
    },
  };

  const daemon = createPayoutDaemon({
    db,
    env: {
      A9_NETWORK: 'testnet',
      A9_SQLITE_PATH: ':memory:',
      TONCENTER_API_BASE: 'https://testnet.toncenter.com/api/v2',
      A9_JETTON_MASTER_ADDRESS: JETTON_MASTER,
      A9_PRESALE_HOT_WALLET_ADDRESS: PRESALE_HOT,
      A9_PROMO_HOT_WALLET_ADDRESS: PROMO_HOT,
      A9_PRESALE_HOT_WALLET_NAME: 'presale-w',
      A9_PROMO_HOT_WALLET_NAME: 'promo-w',
      A9_PRESALE_OPEN: '1',
      A9_CHECK_HOT_WALLET_INVENTORY: '1',
      A9_RUNNER_ID: 'daemon-proof-test',
      OPS_EXECUTE: '1',
      OPS_CONFIRM: 'YES',
    },
    executeFlag: true,
    tonCenter: mockTc,
    presaleA9Broadcaster: async (inst) => ({ txHash: `out-${inst.orderId}` }),
    promoBroadcaster: async (inst) => ({ txHash: `promo-${inst.claimId}` }),
    payoutVerifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash || `out-${p.orderId}` }),
    logger: { log() {}, error() {} },
  });
  daemon.presaleEngine.randomFn = () => 0.999999;

  const readHeartbeatInventory = async () => {
    const row = await db.prepare('SELECT meta_json FROM runner_heartbeats WHERE runner_id = ?').bind('daemon-proof-test').first();
    return JSON.parse(String(row.meta_json)).inventory;
  };

  // Tick 1: initial 5,000 A9 snapshot
  await daemon.runOnce(t0);
  const inv1 = await readHeartbeatInventory();
  assert.equal(inv1.presale.ok, true);
  assert.equal(inv1.presale.a9Raw, String(5_000n * A9));

  // Order 1 (chest_bronze, max 2,500 A9) created with daemon snapshot
  const ord1 = await presaleEngine.createOrderIntent(W('d1'), null, t0 + 1, { skuId: 'chest_bronze', inventorySnapshot: inv1 });
  pendingInboundTxs.push({
    txHash: 'tx-daemon-ord1',
    finality: 'finalized',
    to: PRESALE_HOT,
    from: W('d1'),
    valueNano: ord1.payTonNano,
    memo: ord1.memo,
  });

  // Simulate on-chain balance dropping 5,000 -> 2,500 A9 as Order 1 confirms in Tick 2
  mockPresaleA9 = 2_500n * A9;
  presaleLt = '110';
  await daemon.runOnce(t0 + 10);
  // An equal-sized unrelated transfer cannot verify the payout.
  const unrelated = await readHeartbeatInventory();
  assert.equal(unrelated.presale.a9AvailableRaw, '0');
  await assert.rejects(
    () => presaleEngine.createOrderIntent(W('d2'), null, t0 + 10, { skuId: 'chest_bronze', inventorySnapshot: unrelated }),
    { code: 'HOT_WALLET_LOW_INVENTORY' },
  );
  debitLts.set(`out-${ord1.orderId}`, '120');
  // A known debit after the sampled account position is still outstanding.
  await daemon.runOnce(t0 + 11);
  assert.equal((await readHeartbeatInventory()).presale.a9AvailableRaw, '0');
  presaleLt = '120';
  await daemon.runOnce(t0 + 12);
  assert.equal((await presaleEngine.getOrder(ord1.orderId)).status, 'COMPLETED');
  const inv2 = await readHeartbeatInventory();
  assert.equal(inv2.presale.ok, true);
  assert.equal(inv2.presale.a9Raw, String(2_500n * A9));
  assert.equal(inv2.presale.a9AvailableRaw, String(2_500n * A9));

  // Order 2 (chest_bronze, 2,500 A9) MUST succeed immediately using daemon's real heartbeat snapshot!
  const ord2 = await presaleEngine.createOrderIntent(W('d2'), null, t0 + 13, { skuId: 'chest_bronze', inventorySnapshot: inv2 });
  assert.equal(ord2.status, 'PENDING_PAYMENT');

  // Now Order 2 pays and confirms 2,500 A9, but RPC is LAGGED and still returns 2,500 A9!
  pendingInboundTxs.push({
    txHash: 'tx-daemon-ord2',
    finality: 'finalized',
    to: PRESALE_HOT,
    from: W('d2'),
    valueNano: ord2.payTonNano,
    memo: ord2.memo,
  });
  await daemon.runOnce(t0 + 20);
  const ord2Done = await presaleEngine.getOrder(ord2.orderId);
  assert.equal(ord2Done.status, 'COMPLETED');
  const inv3Lagged = await readHeartbeatInventory();
  assert.equal(inv3Lagged.presale.a9Raw, String(2_500n * A9));
  assert.equal(
    inv3Lagged.presale.a9AvailableRaw,
    String(2_500n * A9 - BigInt(ord2Done.totalA9Raw)),
    'lagged RPC must still count unproven CONFIRMED payout',
  );
  assert.equal(inv3Lagged.presale.ok, false);

  // Order 3 MUST be rejected on the lagged balance snapshot!
  await assert.rejects(
    () => presaleEngine.createOrderIntent(W('d3'), null, t0 + 21, { skuId: 'chest_bronze', inventorySnapshot: inv3Lagged }),
    { code: 'HOT_WALLET_LOW_INVENTORY' },
  );

  // RPC returning the first state must neither reuse old proof nor sell again.
  mockPresaleA9 = 5_000n * A9;
  presaleLt = '100';
  await daemon.runOnce(t0 + 22);
  const regressed = await readHeartbeatInventory();
  assert.equal(regressed.presale.ok, false);
  assert.equal(regressed.presale.walletLt, '120');
  await assert.rejects(
    () => presaleEngine.createOrderIntent(W('d3'), null, t0 + 23, { skuId: 'chest_bronze', inventorySnapshot: regressed }),
    { code: 'HOT_WALLET_LOW_INVENTORY' },
  );

}

await test('Daemon admits the next order only after its balance includes the exact debit', async () => {
  await exerciseDaemonInventory();
  const mf = await createMiniflareD1(MIGRATIONS);
  if (!mf) {
    console.log('  SKIP  daemon inventory regression on Miniflare D1 (runtime unavailable)');
    return;
  }
  try {
    await exerciseDaemonInventory(mf.db);
  } finally {
    await mf.dispose();
  }
});

await test('TonCenter inventory accepts only the matching wallet head and exact successful debit', async () => {
  const jettonWallet = W('61');
  const txHash = 'a'.repeat(64);
  let indexedLt = '100';
  let txAccount = jettonWallet;
  let aborted = false;
  const client = new TonCenterClient({
    apiBase: 'https://fixture.invalid/api/v2', minIntervalMs: 0, maxRetries: 0,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/jetton/wallets')) {
        assert.equal(url.searchParams.get('owner_address'), PRESALE_HOT);
        assert.equal(url.searchParams.get('jetton_address'), JETTON_MASTER);
        return Response.json({ jetton_wallets: [{
          address: jettonWallet, owner: PRESALE_HOT, jetton: JETTON_MASTER, balance: '2500000000000', last_transaction_lt: indexedLt,
        }] });
      }
      if (url.pathname.endsWith('/getAddressInformation')) {
        assert.equal(url.searchParams.get('address'), jettonWallet);
        return Response.json({ ok: true, result: { state: 'active', last_transaction_id: { lt: '100' } } });
      }
      assert.equal(url.searchParams.get('hash'), txHash);
      assert.equal(url.searchParams.get('account'), jettonWallet);
      return Response.json({ transactions: [{
        account: txAccount, hash: txHash, lt: '99', mc_block_seqno: 5,
        in_msg: { source: PRESALE_HOT, opcode: '0x0f8a7ea5', bounced: false },
        out_msgs: [{ opcode: '0x178d4519' }],
        description: { aborted, action: { success: true } },
      }] });
    },
  });
  assert.equal((await client.fetchHotWalletInventoryState(JETTON_MASTER, PRESALE_HOT)).walletLt, '100');
  indexedLt = '99';
  await assert.rejects(client.fetchHotWalletInventoryState(JETTON_MASTER, PRESALE_HOT), /not at the current account head/);
  assert.equal(await client.fetchHotWalletPayoutDebitLt(jettonWallet, PRESALE_HOT, txHash), '99');
  txAccount = W('62');
  assert.equal(await client.fetchHotWalletPayoutDebitLt(jettonWallet, PRESALE_HOT, txHash), null);
  txAccount = jettonWallet;
  aborted = true;
  assert.equal(await client.fetchHotWalletPayoutDebitLt(jettonWallet, PRESALE_HOT, txHash), null);
});

// ---------------------------------------------------------------------------
// 13. Rejection Blocker P1 #6: Legacy CREDITING / NEEDS_REVIEW Referral Credits Must Not Double-Deduct Budget
// ---------------------------------------------------------------------------
await test('Blocker P1 #6: legacy CREDITING & NEEDS_REVIEW referral credits do not double-deduct presale_promo budget on 0016 -> 0017 backfill', async () => {
  const pre = buildD1Stack({ migrations: PRE_0017_MIGRATIONS });
  const tNow = 900_000;
  const W_BUY1 = W('a1');
  const W_BUY2 = W('a2');
  const W_REF1 = W('b1');
  const W_REF2 = W('b2');

  // Prior state: presale_promo spent_raw = 140 A9 (includes 90 A9 already deducted for CREDITING order)
  // and W_REF1 already received 90 A9 in promo_balances before crash left credit in CREDITING!
  await pre.db.prepare("UPDATE promo_budget_ledger SET spent_raw = ? WHERE bucket_key = 'presale_promo'").bind(String(140n * A9)).run();
  await pre.promoEngine.creditReward(W_REF1, 90n * A9, tNow - 100);
  // A balance from a different reward source is no evidence that this referral was paid.
  await pre.promoEngine.creditReward(W_REF2, 90n * A9, tNow - 95);

  // Seed 2 COMPLETED legacy bronze orders (1,500 A9 base -> 6% = 90 A9 ref each), one CREDITING and one NEEDS_REVIEW
  await pre.db
    .prepare(
      `INSERT INTO presale_orders (order_id, wallet_address, wallet_key, tg_user_id, referrer_id, sku_id, open_mode, ton_nano, a9_amount_raw, bonus_a9_raw, bonus_rolled, memo, status, inbound_tx_hash, payout_tx_hash, refund_ton_nano, expires_at, created_at, updated_at)
       VALUES ('leg_cred_1', ?, ?, '911', ?, 'chest_bronze', 'INSTANT', '990000000', '1500000000000', '50000000000', 1, 'buy:leg_cred_1', 'COMPLETED', 'in_cred_1', 'out_cred_1', '0', ?, ?, ?),
              ('leg_rev_2', ?, ?, '912', ?, 'chest_bronze', 'INSTANT', '990000000', '1500000000000', '0', 1, 'buy:leg_rev_2', 'COMPLETED', 'in_rev_2', 'out_rev_2', '0', ?, ?, ?)`,
    )
    .bind(W_BUY1, W_BUY1, W_REF1, tNow + 1000, tNow - 120, tNow - 100, W_BUY2, W_BUY2, W_REF2, tNow + 1000, tNow - 110, tNow - 90)
    .run();
  await pre.db
    .prepare(
      `INSERT INTO presale_referral_credits (order_id, referrer, amount_raw, status, created_at, updated_at)
       VALUES ('leg_cred_1', ?, ?, 'CREDITING', ?, ?),
              ('leg_rev_2', ?, ?, 'NEEDS_REVIEW', ?, ?)`,
    )
    .bind(W_REF1, String(90n * A9), tNow - 100, tNow - 100, W_REF2, String(90n * A9), tNow - 90, tNow - 90)
    .run();

  // Upgrade 0016 -> 0017 and run reconcileLegacyPresaleOrders
  const mig0017 = fs.readFileSync(path.join(WORKER_DIR, 'migrations', '0017_actuarial_reservations_and_vouchers.sql'), 'utf8');
  pre.db.exec(mig0017);
  const rec1 = await reconcileLegacyPresaleOrders(pre.db, tNow, { budgetLedger: pre.budgetLedger });
  assert.equal(rec1.backfilled, 2);
  assert.equal(rec1.reservedBudgetCount, 0, 'CREDITING / NEEDS_REVIEW referrals must NOT auto-deduct budget');
  assert.equal(rec1.reconciliationLogged, 2);

  // Budget MUST remain 140 A9 (NOT 230 A9 or 320 A9!) and user balance unchanged
  assert.equal((await pre.budgetLedger.getBucket('presale_promo')).spentRaw, String(140n * A9));
  assert.equal((await pre.promoEngine.getBalance(W_REF1)).claimableRaw, String(90n * A9));
  assert.equal((await pre.promoEngine.getBalance(W_REF2)).claimableRaw, String(90n * A9));

  // Reservations preserve obligation in NEEDS_REVIEW, and reconciliation items record evidence
  const res1 = await pre.presaleEngine.getOrderReservation('leg_cred_1');
  assert.equal(res1.referralStatus, 'RESERVED');
  assert.equal(res1.status, 'NEEDS_REVIEW');
  assert.equal(res1.legacyBackfilled, true);
  const reconItems = (await pre.db.prepare("SELECT * FROM actuarial_reconciliation_items WHERE category = 'LEGACY_REFERRAL_CREDITING_REVIEW' ORDER BY entity_key ASC").all())?.results || [];
  assert.equal(reconItems.length, 2);
  for (const item of reconItems) {
    assert.equal(item.evidenced_raw, '0');
    assert.equal(item.unexplained_raw, String(90n * A9));
  }

  await pre.budgetLedger.setBucketCap('presale_promo', 1_140n * A9, tNow);
  await assert.rejects(
    () => pre.presaleEngine.createOrderIntent(W('cc'), null, tNow + 1, { skuId: 'chest_bronze' }),
    { code: 'PROMO_BUDGET_EXHAUSTED' },
  );
  assert.equal((await pre.presaleEngine.listOrders(W('cc'))).length, 0);
  assert.equal((await pre.budgetLedger.getBucket('presale_promo')).spentRaw, String(140n * A9));

  // Rerun is strictly idempotent
  const rec2 = await reconcileLegacyPresaleOrders(pre.db, tNow + 5, { budgetLedger: pre.budgetLedger });
  assert.equal(rec2.backfilled, 0);
  assert.equal(rec2.reconciliationLogged, 0);
  assert.equal((await pre.budgetLedger.getBucket('presale_promo')).spentRaw, String(140n * A9));
});

// ---------------------------------------------------------------------------
// 14. Public /api/config & getQuota remove legacy 2002 / PROTOCOL_FIXED_QUOTE;
//     schema.sql includes 0016 & 0018 parity; missing 0018 fails closed.
// ---------------------------------------------------------------------------
await test('Public /api/config & getQuota remove legacy 2002/PROTOCOL_FIXED_QUOTE, schema.sql matches 0001..0018, and missing 0018 fails closed', async () => {
  for (const open of [false, true]) {
    const stack = buildD1Stack();
    stack.presaleEngine.open = open;
    const cfgRes = await stack.router({ method: 'GET', pathname: '/api/config', nowSec: 1000 });
    assert.equal(cfgRes.status, 200);
    const hw = cfgRes.body.data.presaleHotWallet;
    assert.equal(hw.open, open);
    assert.equal(hw.pricingModel, 'CHEST_MALL_SKUS');
    assert.equal('rateA9PerTon' in hw, false, 'public /api/config must not expose rateA9PerTon');
    assert.equal('rateA9PerGram' in hw, false, 'public /api/config must not expose rateA9PerGram');
    assert.equal('rateKind' in hw, false, 'public /api/config must not expose PROTOCOL_FIXED_QUOTE');
    assert.equal(JSON.stringify(cfgRes.body.data).includes('PROTOCOL_FIXED_QUOTE'), false);
    assert.equal(cfgRes.body.data.chestMall.skus.length, 6);

    const quota = await stack.presaleEngine.getQuota(W('aa'), 1000);
    assert.equal(quota.pricingModel, 'CHEST_MALL_SKUS');
    assert.equal('rateA9PerTon' in quota, false, 'getQuota must not expose legacy rateA9PerTon');
  }

  // Verify schema.sql parity for 0016 (v17_round_finality_snapshots + index) and 0018 (hot_wallet_payout_debits)
  const schemaSql = fs.readFileSync(path.join(WORKER_DIR, 'schema.sql'), 'utf8');
  const freshDb = createSqliteD1([]);
  freshDb.exec(schemaSql);
  for (const tbl of ['v17_round_finality_snapshots', 'presale_order_reservations', 'pending_reward_vouchers', 'actuarial_reconciliation_items', 'hot_wallet_payout_debits']) {
    const row = await freshDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").bind(tbl).first();
    assert.equal(row?.name, tbl, `schema.sql must contain table ${tbl}`);
  }
  const idx0016 = await freshDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_v17_finality_snapshots_net_rc'").first();
  assert.equal(idx0016?.name, 'idx_v17_finality_snapshots_net_rc');

  // Verify missing 0018 table fails closed when querying hot_wallet_payout_debits
  const pre0018Migs = MIGRATIONS.filter((m) => !m.includes('0018_'));
  const pre0018Db = createSqliteD1(pre0018Migs);
  await assert.rejects(
    async () => pre0018Db.prepare('SELECT debit_lt FROM hot_wallet_payout_debits LIMIT 1').first(),
    /no such table: hot_wallet_payout_debits/i,
  );
});

console.log(`All ${passed} A9 v17 Actuarial Remediation tests passed.`);
