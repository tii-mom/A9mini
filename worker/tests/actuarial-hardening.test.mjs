#!/usr/bin/env node
// A9 Protocol v16.1 — Actuarial & Anti-Abuse Hardening Regression Suite (M-1 ~ M-5)
// Tests 1:1 parity across both in-memory engines and migrated SQLite D1 (0001..0012).
import assert from 'node:assert/strict';
import { createApiRouter } from '../src/api.mjs';
import { MemoryIdentityStore, D1IdentityStore, REBIND_DELAY_SEC } from '../src/auth.mjs';
import { ChestEngine, CHEST_MALL_CATALOG, FREE_CHEST_CHAIN, CAPTAIN_FOUNDING_BONUS_RAW, CAPTAIN_MIN_TEAM_MEMBERS } from '../src/chest-engine.mjs';
import { D1ChestEngine } from '../src/d1-chest-store.mjs';
import { PresaleHotWalletEngine, REFERRAL_BPS } from '../src/presale-hotwallet.mjs';
import { PromoHotWalletEngine } from '../src/promo-hotwallet.mjs';
import { D1PromoStore } from '../src/d1-promo-store.mjs';
import { SocialStore, TEAM_SWITCH_COOLDOWN_SEC } from '../src/social-store.mjs';
import { PredictionEngine, VOUCHER_TTL_MS, MAX_PRED_REWARD_PER_USER_RAW, PRED_POOL_PER_BET_RAW } from '../src/growth-engine.mjs';
import { D1SocialStore, D1PredictionEngine, D1PresaleStore } from '../src/d1-growth-store.mjs';
import { MemoryPromoBudgetLedger, D1PromoBudgetLedger, PROMO_BUDGET_BUCKETS } from '../src/promo-budget.mjs';
import { TEST_BOT_TOKEN, tgHeaders, createSqliteD1, MIGRATIONS, completePurchase, makeV4R2Wallet, signTonProof } from './helpers/test-env.mjs';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

const HOT = '0:' + '11'.repeat(32);
const A9 = 1_000_000_000n;
const W = (hexByte) => '0:' + hexByte.repeat(32);

const baseStateStore = {
  getTiming: () => ({ observationSeconds: 86400 }),
  getProtocolState: () => ({ dataAvailable: true, currentRoundId: 1, successCount: 0 }),
  listRounds: () => [{ roundId: 1, round: { status: 1, stakeOpenAt: 500, stakeCloseAt: 50000 }, candles: [] }],
  getRound: (id) => (Number(id) === 1 ? { roundId: 1, round: { status: 1, stakeOpenAt: 500, stakeCloseAt: 50000 }, candles: [] } : null),
};

async function buildStack(backend, { budgetOverrides = null, walletStateResolver = null, telegramGroupVerifier = null } = {}) {
  const activeWallets = new Set();
  const stateResolver = walletStateResolver || (async (addr) => ({ state: activeWallets.has(addr) ? 'active' : 'uninitialized' }));
  if (backend === 'memory') {
    const budgetLedger = new MemoryPromoBudgetLedger(budgetOverrides ? { caps: budgetOverrides } : undefined);
    const promoEngine = new PromoHotWalletEngine({ hotWalletAddress: HOT });
    const socialStore = new SocialStore();
    const predictionEngine = new PredictionEngine({ budgetLedger });
    const chestEngine = new ChestEngine({ budgetLedger });
    const identityStore = new MemoryIdentityStore({
      onWalletRebound: ({ fromWalletAddress, toWalletAddress, nowSec }) => promoEngine.mergeBalance(fromWalletAddress, toWalletAddress, nowSec),
    });
    const presaleEngine = new PresaleHotWalletEngine({
      hotWalletAddress: HOT, open: true, promoEngine, socialStore, identityStore, chestEngine, budgetLedger,
    });
    const router = createApiRouter({
      env: { A9_BOT_TOKEN: TEST_BOT_TOKEN, A9_ADMIN_TOKEN: 'adm-act', A9_CHEST_OPEN_ENABLED: '1', A9_TON_PROOF_DOMAINS: 'a9.example', A9_NETWORK: 'testnet' },
      stateStore: baseStateStore, promoEngine, presaleEngine, socialStore, predictionEngine, chestEngine, budgetLedger, identityStore,
      walletStateResolver: stateResolver,
      telegramGroupVerifier,
    });
    return { db: null, router, budgetLedger, promoEngine, presaleEngine, socialStore, predictionEngine, chestEngine, identityStore, activeWallets };
  }
  const db = createSqliteD1(MIGRATIONS);
  if (budgetOverrides) {
    for (const [bucket, cap] of Object.entries(budgetOverrides)) {
      await db.prepare('UPDATE promo_budget_ledger SET cap_raw = ?, spent_raw = ? WHERE bucket_key = ?').bind(String(cap), '0', bucket).run();
    }
  }
  const budgetLedger = new D1PromoBudgetLedger({ db });
  const promoEngine = new D1PromoStore({ db, hotWalletAddress: HOT });
  const socialStore = new D1SocialStore({ db });
  const predictionEngine = new D1PredictionEngine({ db, budgetLedger });
  const chestEngine = new D1ChestEngine({ db, budgetLedger });
  const identityStore = new D1IdentityStore({
    db,
    onWalletRebound: ({ fromWalletAddress, toWalletAddress, nowSec }) => promoEngine.mergeBalance(fromWalletAddress, toWalletAddress, nowSec),
  });
  const presaleEngine = new D1PresaleStore({
    db, hotWalletAddress: HOT, open: true, promoEngine, socialStore, identityStore, chestEngine, budgetLedger,
  });
  const router = createApiRouter({
    env: { A9_BOT_TOKEN: TEST_BOT_TOKEN, A9_ADMIN_TOKEN: 'adm-act', A9_CHEST_OPEN_ENABLED: '1', A9_TON_PROOF_DOMAINS: 'a9.example', A9_NETWORK: 'testnet' },
    stateStore: baseStateStore, promoEngine, presaleEngine, socialStore, predictionEngine, chestEngine, budgetLedger, identityStore,
    walletStateResolver: stateResolver,
    telegramGroupVerifier,
  });
  return { db, router, budgetLedger, promoEngine, presaleEngine, socialStore, predictionEngine, chestEngine, identityStore, activeWallets };
}

console.log('Running A9 v16.1 Actuarial & Anti-Abuse Hardening tests (Memory + D1 0001..0012)...');

await test('M-4 constants & warmup leaderboard alignment (6% referral, +2%~+5% boost, 6k/50k/120k/500k free chests, 300M budget cap)', async () => {
  assert.equal(REFERRAL_BPS, 6n);
  assert.equal(CHEST_MALL_CATALOG.chest_bronze.maxBoostBps, 200);
  assert.equal(CHEST_MALL_CATALOG.chest_silver.maxBoostBps, 300);
  assert.equal(CHEST_MALL_CATALOG.chest_gold.maxBoostBps, 400);
  assert.equal(CHEST_MALL_CATALOG.chest_platinum.maxBoostBps, 450);
  assert.equal(CHEST_MALL_CATALOG.chest_diamond.maxBoostBps, 500);
  assert.equal(FREE_CHEST_CHAIN.find((c) => c.tier === 'silver').rewardA9Raw, String(6_000n * A9));
  assert.equal(FREE_CHEST_CHAIN.find((c) => c.tier === 'silver').minVolumeNano, String(100n * A9));
  assert.equal(FREE_CHEST_CHAIN.find((c) => c.tier === 'gold').rewardA9Raw, String(50_000n * A9));
  assert.equal(FREE_CHEST_CHAIN.find((c) => c.tier === 'platinum').rewardA9Raw, String(120_000n * A9));
  assert.equal(FREE_CHEST_CHAIN.find((c) => c.tier === 'diamond').rewardA9Raw, String(500_000n * A9));

  const totalBudget = Object.values(PROMO_BUDGET_BUCKETS).reduce((s, v) => s + BigInt(v), 0n);
  assert.equal(totalBudget, 300_000_000n * A9);

  // GET /api/warmup/leaderboard must NOT fall back to legacy 8,000,000 A9 WARMUP_TIERS
  const { router, socialStore } = await buildStack('memory');
  await socialStore.registerWarmup({ roundId: 2, walletAddress: W('aa') }, 1000);
  const lbRes = await router({ method: 'GET', pathname: '/api/warmup/leaderboard', query: { roundId: '2' }, nowSec: 1005 });
  assert.equal(lbRes.status, 200);
  assert.deepEqual(lbRes.body.data, []);
});

for (const backend of ['memory', 'd1']) {
  await test(`[${backend}] M-1: regular team member cannot inherit team volume/TG count; captain counts only post-join orders; 7-day team switch cooldown`, async () => {
    const stack = await buildStack(backend, {
      telegramGroupVerifier: async () => ({ botInGroup: true, operatorIsAdmin: true, chatId: '-100777', groupHandle: '@squad777', tgMemberCount: 150 }),
    });
    const { router, identityStore, socialStore, presaleEngine, chestEngine } = stack;
    const W_CAP = W('a1');
    const W_MEM = W('a2');
    const W_WHALE = W('a3');
    const W_CAP2 = W('a4');

    await identityStore.bindWallet('101', W_CAP, 900);
    await identityStore.bindWallet('102', W_MEM, 900);
    await identityStore.bindWallet('103', W_WHALE, 900);
    await identityStore.bindWallet('104', W_CAP2, 900);

    // Whale completes 100 GRAM purchase BEFORE joining captain's team (at t=1000)
    await completePurchase(presaleEngine, W_WHALE, '100', 1000, { txHash: `pre-join-${backend}` });

    // Captain creates & binds TG group, MEM and WHALE join at t=2000
    await socialStore.createOrBindTeamGroup({ teamId: 'TM-M1', name: 'M1 Squad', captainWallet: W_CAP, tgGroupHandle: '@squad777' }, 1500);
    await socialStore.createOrBindTeamGroup({ teamId: 'TM-M1B', name: 'M1 Squad B', captainWallet: W_CAP2, tgGroupHandle: '@squad778' }, 1500);
    await socialStore.joinTeam({ teamId: 'TM-M1', walletAddress: W_MEM }, 2000);
    await socialStore.joinTeam({ teamId: 'TM-M1', walletAddress: W_WHALE }, 2000);

    // 7-day switch cooldown blocks MEM switching from TM-M1 to TM-M1B at t=2000 + 3 days
    await assert.rejects(
      async () => socialStore.joinTeam({ teamId: 'TM-M1B', walletAddress: W_MEM }, 2000 + 3 * 86400),
      { code: 'TEAM_SWITCH_COOLDOWN' },
    );

    // Unlock free Silver chest for both MEM and CAP (bypass Bronze 1-3 via direct assists/opens)
    for (const [uid, wallet] of [['102', W_MEM], ['101', W_CAP]]) {
      const st = await chestEngine.claimStarterBronzeChests({ userId: uid, walletAddress: wallet }, 2100);
      for (let i = 0; i < 3; i += 1) {
        const c = st.chests[i];
        await chestEngine.assistChest({ chestId: c.chestId, helperUserId: `h_${uid}_${i}_1`, helperWalletAddress: W(`b${i}`), walletActive: true }, 2101 + i);
        await chestEngine.assistChest({ chestId: c.chestId, helperUserId: `h_${uid}_${i}_2`, helperWalletAddress: W(`c${i}`), walletActive: true }, 2102 + i);
        await chestEngine.openChest({ chestId: c.chestId, userId: uid, walletAddress: wallet, predictionEngine: stack.predictionEngine }, 2110 + i);
      }
      const silver = (await chestEngine.listUserChests(uid)).freeChests.find((x) => x.tier === 'silver');
      for (let k = 0; k < 15; k += 1) {
        const hx = (0xd0 + k).toString(16).padStart(2, '0');
        await chestEngine.assistChest({ chestId: silver.chestId, helperUserId: `hs_${uid}_${k}`, helperWalletAddress: '0:' + hx.repeat(32), walletActive: true }, 2200 + k);
      }
    }

    const capSilver = (await chestEngine.listUserChests('101')).freeChests.find((x) => x.tier === 'silver');
    const memSilver = (await chestEngine.listUserChests('102')).freeChests.find((x) => x.tier === 'silver');

    // Captain tries to open Silver before WHALE has any post-join order -> MUST FAIL (pre-join 150 GRAM excluded!)
    const capFailPre = await router({
      method: 'POST', pathname: `/api/chests/${capSilver.chestId}/open`,
      headers: await tgHeaders(101, { nowSec: 2500 }), body: {}, nowSec: 2500,
    });
    assert.equal(capFailPre.status, 400);
    assert.equal(capFailPre.body.error.code, 'VOLUME_UNMET');

    // WHALE completes 100 GRAM purchase AFTER joining (at t=2600)
    await completePurchase(presaleEngine, W_WHALE, '100', 2600, { txHash: `post-join-${backend}` });

    // Regular member MEM STILL cannot inherit WHALE's team volume -> MUST FAIL
    const memFail = await router({
      method: 'POST', pathname: `/api/chests/${memSilver.chestId}/open`,
      headers: await tgHeaders(102, { nowSec: 2700 }), body: {}, nowSec: 2700,
    });
    assert.equal(memFail.status, 400);
    assert.equal(memFail.body.error.code, 'VOLUME_UNMET');

    // Captain CAN open Silver (6,000 A9) now that WHALE's post-join order is >= 100 GRAM!
    const capOk = await router({
      method: 'POST', pathname: `/api/chests/${capSilver.chestId}/open`,
      headers: await tgHeaders(101, { nowSec: 2700 }), body: {}, nowSec: 2700,
    });
    assert.equal(capOk.status, 200);
    assert.equal(capOk.body.data.rewardA9Raw, String(6_000n * A9));

    // After 7-day cooldown expires, MEM can switch to TM-M1B cleanly
    const switched = await socialStore.joinTeam({ teamId: 'TM-M1B', walletAddress: W_MEM }, 2000 + TEAM_SWITCH_COOLDOWN_SEC + 1);
    assert.equal(switched.teamId, 'TM-M1B');
  });

  await test(`[${backend}] M-2: captain 5,000 A9 bonus requires >=3 bound members and deduplicates across team_id / tg_chat_id / captain_user_id / captain_wallet`, async () => {
    let verifierResp = { botInGroup: true, operatorIsAdmin: true, chatId: '-100888', groupHandle: '@g888', tgMemberCount: 80 };
    const { router, identityStore, socialStore, predictionEngine } = await buildStack(backend, {
      telegramGroupVerifier: async () => verifierResp,
    });
    const W_CAP1 = W('e1');
    const W_CAP2 = W('e2');
    const W_M1 = W('e3');
    const W_M2 = W('e4');
    const W_M3 = W('e5');
    const W_M4 = W('e6');

    await identityStore.bindWallet('201', W_CAP1, 900);
    await identityStore.bindWallet('202', W_CAP2, 900);

    // 1) Only 1 member (captain) -> blocked by TEAM_MEMBERS_BELOW_MIN
    await router({ method: 'POST', pathname: '/api/team/bind-tg', headers: await tgHeaders(201, { nowSec: 1000 }), body: { teamId: 'TM-C1', name: 'C1', tgGroupHandle: '@g888' }, nowSec: 1000 });
    const v1 = await router({ method: 'POST', pathname: '/api/team/verify-tg', headers: await tgHeaders(201, { nowSec: 1005 }), body: { teamId: 'TM-C1' }, nowSec: 1005 });
    assert.equal(v1.status, 200);
    assert.equal(v1.body.data.captainBonus.granted, false);
    assert.equal(v1.body.data.captainBonus.reason, 'BELOW_MIN_TEAM_MEMBERS');
    assert.equal(CAPTAIN_MIN_TEAM_MEMBERS, 3);

    // 2) Add 2 members (total 3) -> granted 5,000 A9
    await socialStore.joinTeam({ teamId: 'TM-C1', walletAddress: W_M1 }, 1010);
    await socialStore.joinTeam({ teamId: 'TM-C1', walletAddress: W_M2 }, 1011);
    const v2 = await router({ method: 'POST', pathname: '/api/team/verify-tg', headers: await tgHeaders(201, { nowSec: 1015 }), body: { teamId: 'TM-C1' }, nowSec: 1015 });
    assert.equal(v2.body.data.captainBonus.granted, true);
    assert.equal(v2.body.data.captainBonus.amountRaw, CAPTAIN_FOUNDING_BONUS_RAW.toString());
    assert.equal((await predictionEngine.getUserSummary('201')).pendingActivationRaw, String(5_000n * A9));

    // 3) Bot kicked from TM-C1 -> TM-C1 becomes expired; CAP2 creates TM-C2 and binds the SAME tgChatId (-100888) -> blocked!
    verifierResp = { botInGroup: false, operatorIsAdmin: false, chatId: '-100888', groupHandle: '@g888', tgMemberCount: 80 };
    await router({ method: 'POST', pathname: '/api/team/verify-tg', headers: await tgHeaders(201, { nowSec: 1020 }), body: { teamId: 'TM-C1' }, nowSec: 1020 });
    verifierResp = { botInGroup: true, operatorIsAdmin: true, chatId: '-100888', groupHandle: '@g888', tgMemberCount: 80 };
    await router({ method: 'POST', pathname: '/api/team/bind-tg', headers: await tgHeaders(202, { nowSec: 1025 }), body: { teamId: 'TM-C2', name: 'C2', tgGroupHandle: '@g888' }, nowSec: 1025 });
    await socialStore.joinTeam({ teamId: 'TM-C2', walletAddress: W_M3 }, 1026);
    await socialStore.joinTeam({ teamId: 'TM-C2', walletAddress: W_M4 }, 1027);
    const vRebindGroup = await router({ method: 'POST', pathname: '/api/team/verify-tg', headers: await tgHeaders(202, { nowSec: 1030 }), body: { teamId: 'TM-C2' }, nowSec: 1030 });
    assert.equal(vRebindGroup.status, 200);
    assert.equal(vRebindGroup.body.data.captainBonus.granted, false);
    assert.equal((await predictionEngine.getUserSummary('202')).pendingActivationRaw, '0');

    // 4) Same captain 201 creates TM-C3 with a BRAND NEW group (-100999) -> blocked by captain_user_id/wallet dedup!
    verifierResp = { botInGroup: true, operatorIsAdmin: true, chatId: '-100999', groupHandle: '@g999', tgMemberCount: 90 };
    await router({ method: 'POST', pathname: '/api/team/bind-tg', headers: await tgHeaders(201, { nowSec: 1035 }), body: { teamId: 'TM-C3', name: 'C3', tgGroupHandle: '@g999' }, nowSec: 1035 });
    await socialStore.joinTeam({ teamId: 'TM-C3', walletAddress: W('e7') }, 1036);
    await socialStore.joinTeam({ teamId: 'TM-C3', walletAddress: W('e8') }, 1037);
    const vSameCap = await router({ method: 'POST', pathname: '/api/team/verify-tg', headers: await tgHeaders(201, { nowSec: 1040 }), body: { teamId: 'TM-C3' }, nowSec: 1040 });
    assert.equal(vSameCap.status, 200);
    assert.equal(vSameCap.body.data.captainBonus.granted, false);
    assert.equal((await predictionEngine.getUserSummary('201')).pendingActivationRaw, String(5_000n * A9));
  });

  await test(`[${backend}] M-3: active wallet gate on prediction bet, dynamic pool + 2,500 A9 per-user cap, and pending TTL anti-extension`, async () => {
    const { router, identityStore, predictionEngine, activeWallets } = await buildStack(backend);

    // 1) Unbound user -> 403 WALLET_NOT_VERIFIED
    const rUnbound = await router({ method: 'POST', pathname: '/api/prediction/bet', headers: await tgHeaders(300, { nowSec: 1000 }), body: { roundId: 1, side: 'PASS' }, nowSec: 1000 });
    assert.equal(rUnbound.status, 403);
    assert.equal(rUnbound.body.error.code, 'WALLET_NOT_VERIFIED');

    // 2) Bound but uninitialized wallet -> 400 WALLET_NOT_ACTIVE
    await identityStore.bindWallet('301', W('f1'), 900);
    const rUninit = await router({ method: 'POST', pathname: '/api/prediction/bet', headers: await tgHeaders(301, { nowSec: 1000 }), body: { roundId: 1, side: 'PASS' }, nowSec: 1000 });
    assert.equal(rUninit.status, 400);
    assert.equal(rUninit.body.error.code, 'WALLET_NOT_ACTIVE');

    // 3) 10 active wallets bet: 1 PASS winner, 9 BURN losers -> dynamic pool = 10 * 800 = 8,000 A9, capped at 2,500 A9 for the sole winner
    activeWallets.add(W('f1'));
    const rWin = await router({ method: 'POST', pathname: '/api/prediction/bet', headers: await tgHeaders(301, { nowSec: 1000 }), body: { roundId: 1, side: 'PASS' }, nowSec: 1000 });
    assert.equal(rWin.status, 200);
    for (let i = 2; i <= 10; i += 1) {
      const w = '0:' + (0x10 + i).toString(16).padStart(2, '0').repeat(32);
      activeWallets.add(w);
      await identityStore.bindWallet(String(300 + i), w, 900);
      const rLose = await router({ method: 'POST', pathname: '/api/prediction/bet', headers: await tgHeaders(300 + i, { nowSec: 1000 + i }), body: { roundId: 1, side: 'BURN' }, nowSec: 1000 + i });
      assert.equal(rLose.status, 200);
    }
    const settleRes = await router({
      method: 'POST', pathname: '/api/admin/prediction/settle',
      headers: { 'x-a9-admin-token': 'adm-act' },
      body: { roundId: 1, passed: true, actualQualified: 18 },
      nowSec: 2000,
    });
    assert.equal(settleRes.status, 200);
    assert.equal(PRED_POOL_PER_BET_RAW, 800n * A9);
    assert.equal(settleRes.body.data.distributedRaw, MAX_PRED_REWARD_PER_USER_RAW.toString());
    assert.equal((await predictionEngine.getUserSummary('301')).pendingActivationRaw, String(2_500n * A9));

    // 4) TTL anti-extension: credit at t0 -> credit again at t0+24h keeps t0+48h; credit after t0+49h purges expired balance
    const t0 = 1_700_000_000_000;
    await predictionEngine.creditPendingBonus('ttl_u', 500n * A9, t0);
    const s1 = await predictionEngine.getUserSummary('ttl_u');
    assert.equal(s1.pendingActivationRaw, String(500n * A9));
    assert.equal(s1.pendingExpiresAt, t0 + VOUCHER_TTL_MS);

    await predictionEngine.creditPendingBonus('ttl_u', 300n * A9, t0 + 24 * 3600 * 1000);
    const s2 = await predictionEngine.getUserSummary('ttl_u');
    assert.equal(s2.pendingActivationRaw, String(800n * A9));
    assert.equal(s2.pendingExpiresAt, t0 + VOUCHER_TTL_MS, 'new bonus must NOT extend existing unexpired TTL');

    const afterExpiry = t0 + VOUCHER_TTL_MS + 3600 * 1000;
    await predictionEngine.creditPendingBonus('ttl_u', 400n * A9, afterExpiry);
    const s3 = await predictionEngine.getUserSummary('ttl_u');
    assert.equal(s3.pendingActivationRaw, String(400n * A9), 'expired pending balance must be purged on new credit');
    assert.equal(s3.pendingExpiresAt, afterExpiry + VOUCHER_TTL_MS);
  });

  await test(`[${backend}] M-5: promo_budget_ledger BigInt+CAS circuit breaker writes zero partial state when exhausted`, async () => {
    const stack = await buildStack(backend, {
      budgetOverrides: {
        free_chest_captain: String(200n * A9), // < 300 A9 Bronze #1
        prediction: String(500n * A9),         // < 800 A9 single bet settlement
        presale_promo: String(100n * A9),      // < 6% of 5 GRAM (600.6 A9)
        warmup: String(100n * A9),
      },
    });
    const { router, identityStore, chestEngine, predictionEngine, presaleEngine, promoEngine, activeWallets } = stack;
    const W_U = W('71');
    const W_REF = W('72');
    activeWallets.add(W_U);
    await identityStore.bindWallet('501', W_U, 900);

    // 1) Chest open hits PROMO_BUDGET_EXHAUSTED (503) -> chest stays READY, pending stays 0
    const st = await chestEngine.claimStarterBronzeChests({ userId: '501', walletAddress: W_U }, 1000);
    const b1 = st.chests[0];
    await chestEngine.assistChest({ chestId: b1.chestId, helperUserId: '502', helperWalletAddress: W('73'), walletActive: true }, 1001);
    await chestEngine.assistChest({ chestId: b1.chestId, helperUserId: '503', helperWalletAddress: W('74'), walletActive: true }, 1002);
    const openFail = await router({
      method: 'POST', pathname: `/api/chests/${b1.chestId}/open`,
      headers: await tgHeaders(501, { nowSec: 1005 }), body: {}, nowSec: 1005,
    });
    assert.equal(openFail.status, 503);
    assert.equal(openFail.body.error.code, 'PROMO_BUDGET_EXHAUSTED');
    assert.equal((await chestEngine.getChest(b1.chestId)).status, 'READY');
    assert.equal((await predictionEngine.getUserSummary('501')).pendingActivationRaw, '0');

    // 2) Prediction settle hits PROMO_BUDGET_EXHAUSTED (503) -> round stays unsettled, pending stays 0
    await router({ method: 'POST', pathname: '/api/prediction/bet', headers: await tgHeaders(501, { nowSec: 1010 }), body: { roundId: 1, side: 'PASS' }, nowSec: 1010 });
    const settleFail = await router({
      method: 'POST', pathname: '/api/admin/prediction/settle',
      headers: { 'x-a9-admin-token': 'adm-act' },
      body: { roundId: 1, passed: true, actualQualified: 18 },
      nowSec: 1020,
    });
    assert.equal(settleFail.status, 503);
    assert.equal(settleFail.body.error.code, 'PROMO_BUDGET_EXHAUSTED');
    assert.equal((await predictionEngine.getRoundStats(1)).settled, false);
    assert.equal((await predictionEngine.getUserSummary('501')).pendingActivationRaw, '0');

    // 3) Presale 6% referral credit hits PROMO_BUDGET_EXHAUSTED -> credit rolls back to PENDING, referrer gets 0
    const ord = await presaleEngine.createOrderIntent(W_U, '5', 1030, { referrerId: W_REF });
    await presaleEngine.ingestInbound({ txHash: `bud-in-${backend}`, finality: 'finalized', to: HOT, from: W_U, valueNano: ord.payTonNano, memo: ord.memo }, 1031);
    await presaleEngine.queueConfirmedPayouts(1032);
    await presaleEngine.processPayouts(1033, { a9Broadcaster: async () => ({ txHash: `bud-out-${backend}` }), verifier: async () => ({ state: 'CONFIRMED' }) });
    const refOut = await presaleEngine.processReferralCredits(1035);
    assert.equal(refOut.budgetExhausted, 1);
    assert.equal((await promoEngine.getBalance(W_REF)).claimableRaw, '0');
    assert.equal((await presaleEngine.getReferralCredit(ord.orderId)).status, 'PENDING');
  });

  await test(`[${backend}] M-5: wallet unbind blocked with unclaimed balance; rebind promotion atomically merges old wallet balance into new wallet`, async () => {
    const { router, promoEngine } = await buildStack(backend);
    const wOld = await makeV4R2Wallet();
    const wNew = await makeV4R2Wallet();
    const proofCall = async (tgId, w, nowSec, purpose = 'bind') => {
      const h = await tgHeaders(tgId, { nowSec });
      const p = (await router({ method: 'POST', pathname: '/api/auth/ton-proof/payload', headers: h, nowSec })).body.data.payload;
      const proof = await signTonProof(w, { payload: p, timestamp: nowSec });
      return router({
        method: 'POST', pathname: '/api/auth/ton-proof/verify',
        headers: h, body: { address: w.address, network: '-3', publicKey: w.pubHex, proof, purpose }, nowSec,
      });
    };

    const t0 = 50_000;
    assert.equal((await proofCall(601, wOld, t0)).body.data.status, 'BOUND');
    await promoEngine.creditReward(wOld.address, 4_200n * A9, t0 + 1);
    await promoEngine.creditReward(wNew.address, 800n * A9, t0 + 2);

    // 1) Unbind with unclaimed balance -> 409 PROMO_BALANCE_UNCLAIMED
    const unbindBlocked = await proofCall(601, wOld, t0 + 10, 'unbind');
    assert.equal(unbindBlocked.status, 409);
    assert.equal(unbindBlocked.body.error.code, 'PROMO_BALANCE_UNCLAIMED');

    // 2) Rebind while active pending claim exists -> 409 PENDING_CLAIM_ACTIVE
    await promoEngine.createClaimIntent(wOld.address, t0 + 20);
    const rebindBlocked = await proofCall(601, wNew, t0 + 25, 'bind');
    assert.equal(rebindBlocked.status, 409);
    assert.equal(rebindBlocked.body.error.code, 'PENDING_CLAIM_ACTIVE');

    // 3) After pending claim expires (15m + 1s), rebind starts cleanly and after 24h delay merges 4,200 + 800 = 5,000 A9 into wNew
    const tRebind = t0 + 20 + 960;
    const rebindPending = await proofCall(601, wNew, tRebind, 'bind');
    assert.equal(rebindPending.status, 200);
    assert.equal(rebindPending.body.data.status, 'PENDING_REBIND');

    const tPromoted = tRebind + REBIND_DELAY_SEC + 1;
    const meRes = await router({ method: 'GET', pathname: '/api/me', headers: await tgHeaders(601, { nowSec: tPromoted }), nowSec: tPromoted });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.body.data.wallet.address, wNew.address);
    assert.equal((await promoEngine.getBalance(wOld.address)).claimableRaw, '0');
    assert.equal((await promoEngine.getBalance(wNew.address)).claimableRaw, String(5_000n * A9));
  });
}

console.log(`All ${passed} A9 v16.1 Actuarial & Anti-Abuse Hardening tests passed.`);
