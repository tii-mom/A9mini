#!/usr/bin/env node
// Regression tests for:
//   1. D1IdentityStore wallet rebind consistency (pendingWalletKey fix, conflict, concurrency,
//      balance-migration failure, binding-update failure, duplicate requests, retry).
//   2. Chest Mall strict 6-tier SKU order creation + historical legacy non-SKU order lifecycle.
// Run: bun worker/tests/rebind-and-sku-hardening.test.mjs
import assert from 'node:assert/strict';
import { createApiRouter } from '../src/api.mjs';
import { D1IdentityStore, MemoryIdentityStore, REBIND_DELAY_SEC } from '../src/auth.mjs';
import { D1PromoStore } from '../src/d1-promo-store.mjs';
import { PromoHotWalletEngine } from '../src/promo-hotwallet.mjs';
import { D1PresaleStore, D1SocialStore } from '../src/d1-growth-store.mjs';
import { PresaleHotWalletEngine, PRESALE_STATUS } from '../src/presale-hotwallet.mjs';
import { CHEST_MALL_CATALOG } from '../src/chest-engine.mjs';
import { TEST_BOT_TOKEN, tgHeaders, createSqliteD1, FRESH_SCHEMA } from './helpers/test-env.mjs';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

const HOT = 'EQ_HARDEN_HOT';
const ENV = {
  A9_BOT_TOKEN: TEST_BOT_TOKEN,
  A9_TON_PROOF_DOMAINS: 'a9.example',
  A9_NETWORK: 'testnet',
  A9_ADMIN_TOKEN: 'adm-harden',
};
const stateStore = {
  getTiming: () => ({ observationSeconds: 86400 }),
  getProtocolState: () => ({ currentRoundId: 1, successCount: 0 }),
  listRounds: () => [],
  getRound: () => null,
};

console.log('Running wallet rebind consistency & strict 6-SKU hardening tests...');

// ===========================================================================
// PART 1: Wallet Rebind Consistency (D1 atomic + D1 fallback + Memory)
// ===========================================================================

await test('T1-1 [d1-sqlite atomic]: target wallet bound by another user during 72h delay -> pending cancelled, zero cross-account balance leak', async () => {
  const db = createSqliteD1(FRESH_SCHEMA);
  const promo = new D1PromoStore({ db, hotWalletAddress: HOT });
  const idStore = new D1IdentityStore({ db, promoEngine: promo });
  const t0 = 100_000;

  // User A binds W_A, earns 5,000 A9 promo balance, requests rebind to W_TARGET
  await idStore.bindVerifiedWallet('1001', 'EQ_W_A', t0);
  await promo.creditReward('EQ_W_A', '5000000000000', t0);
  const sw = await idStore.bindVerifiedWallet('1001', 'EQ_W_TARGET', t0 + 10);
  assert.equal(sw.status, 'PENDING_REBIND');

  // During the 72h delay, User B legitimately binds W_TARGET and earns 1,000 A9
  await idStore.bindVerifiedWallet('1002', 'EQ_W_TARGET', t0 + 100);
  await promo.creditReward('EQ_W_TARGET', '1000000000000', t0 + 100);

  // After 72h delay expires, User A calls getBinding() -> MUST detect conflict via pendingWalletKey,
  // cancel User A's pending rebind, keep User A on W_A, and NEVER merge W_A's balance into W_TARGET!
  const after = await idStore.getBinding('1001', t0 + 10 + REBIND_DELAY_SEC);
  assert.equal(after.walletAddress, 'EQ_W_A');
  assert.equal(after.pending, null);
  assert.equal(after.reboundFrom, undefined);

  assert.equal((await promo.getBalance('EQ_W_A')).claimableRaw, '5000000000000');
  assert.equal((await promo.getBalance('EQ_W_TARGET')).claimableRaw, '1000000000000');
  assert.equal((await idStore.getBinding('1002', t0 + 10 + REBIND_DELAY_SEC)).walletAddress, 'EQ_W_TARGET');
});

await test('T1-2 [d1-sqlite atomic]: concurrent race where User B binds W_TARGET right before db.batch() -> batch rolls back, pending cancelled, zero leak', async () => {
  const rawDb = createSqliteD1(FRESH_SCHEMA);
  let injectRaceOnce = false;
  const racingDb = {
    prepare: (sql) => rawDb.prepare(sql),
    exec: (sql) => rawDb.exec(sql),
    async batch(stmts) {
      if (injectRaceOnce) {
        injectRaceOnce = false;
        // Simulate User B slipping in and binding EQ_W_TARGET right before User A's atomic batch executes
        await rawDb
          .prepare('INSERT INTO wallet_bindings (tg_user_id, wallet_address, wallet_key, bound_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .bind('2002', 'EQ_W_TARGET', 'EQ_W_TARGET', 200_500, 200_500)
          .run();
      }
      return rawDb.batch(stmts);
    },
  };

  const promo = new D1PromoStore({ db: racingDb, hotWalletAddress: HOT });
  const idStore = new D1IdentityStore({ db: racingDb, promoEngine: promo });
  const t0 = 200_000;

  await idStore.bindVerifiedWallet('2001', 'EQ_W_A', t0);
  await promo.creditReward('EQ_W_A', '8000000000000', t0);
  await idStore.bindVerifiedWallet('2001', 'EQ_W_TARGET', t0 + 10);

  injectRaceOnce = true;
  const res = await idStore.getBinding('2001', t0 + 10 + REBIND_DELAY_SEC);
  assert.equal(res.walletAddress, 'EQ_W_A');
  assert.equal(res.pending, null);
  assert.equal((await promo.getBalance('EQ_W_A')).claimableRaw, '8000000000000');
  assert.equal((await promo.getBalance('EQ_W_TARGET')).claimableRaw, '0');
  assert.equal((await idStore.getCurrentWalletAddress('2002')), 'EQ_W_TARGET');
});

await test('T1-3 [d1-sqlite atomic]: concurrent getBinding() promotion for same user -> promotes once, migrates balance once, zero duplicate credit', async () => {
  const db = createSqliteD1(FRESH_SCHEMA);
  const promo = new D1PromoStore({ db, hotWalletAddress: HOT });
  const idStore = new D1IdentityStore({ db, promoEngine: promo });
  const t0 = 300_000;

  await idStore.bindVerifiedWallet('3001', 'EQ_CONC_OLD', t0);
  await promo.creditReward('EQ_CONC_OLD', '6500000000000', t0);
  await promo.creditReward('EQ_CONC_NEW', '1500000000000', t0); // pre-existing balance on target wallet
  await idStore.bindVerifiedWallet('3001', 'EQ_CONC_NEW', t0 + 10);

  const tPromote = t0 + 10 + REBIND_DELAY_SEC;
  const results = await Promise.all(Array.from({ length: 6 }, () => idStore.getBinding('3001', tPromote)));
  for (const r of results) {
    assert.equal(r.walletAddress, 'EQ_CONC_NEW');
    assert.equal(r.pending, null);
  }
  // Exactly one caller should have actually promoted (reboundFrom set)
  assert.equal(results.filter((r) => r.reboundFrom === 'EQ_CONC_OLD').length, 1);

  // Balance migrated exactly once: 6,500 + 1,500 = 8,000 A9; old wallet = 0
  assert.equal((await promo.getBalance('EQ_CONC_OLD')).claimableRaw, '0');
  assert.equal((await promo.getBalance('EQ_CONC_NEW')).claimableRaw, '8000000000000');

  // Subsequent duplicate getBinding calls are pure reads
  const again = await idStore.getBinding('3001', tPromote + 60);
  assert.equal(again.walletAddress, 'EQ_CONC_NEW');
  assert.equal(again.reboundFrom, undefined);
  assert.equal((await promo.getBalance('EQ_CONC_NEW')).claimableRaw, '8000000000000');
});

await test('T1-4 [d1-sqlite atomic]: balance migration failure inside db.batch() -> full rollback (binding & balance untouched), retry succeeds cleanly', async () => {
  const rawDb = createSqliteD1(FRESH_SCHEMA);
  let failPromoOnce = false;
  const flakyDb = {
    prepare: (sql) => rawDb.prepare(sql),
    exec: (sql) => rawDb.exec(sql),
    async batch(stmts) {
      if (failPromoOnce && stmts.length >= 2) {
        failPromoOnce = false;
        // Keep statement 0 (wallet_bindings UPDATE), sabotage statement 1 (promo_balances migration)
        return rawDb.batch([stmts[0], rawDb.prepare('UPDATE __nonexistent_promo_crash SET x = 1')]);
      }
      return rawDb.batch(stmts);
    },
  };

  const promo = new D1PromoStore({ db: flakyDb, hotWalletAddress: HOT });
  const idStore = new D1IdentityStore({ db: flakyDb, promoEngine: promo });
  const t0 = 400_000;

  await idStore.bindVerifiedWallet('4001', 'EQ_FAIL_OLD', t0);
  await promo.creditReward('EQ_FAIL_OLD', '9000000000000', t0);
  await idStore.bindVerifiedWallet('4001', 'EQ_FAIL_NEW', t0 + 10);

  const tPromote = t0 + 10 + REBIND_DELAY_SEC;
  failPromoOnce = true;
  await assert.rejects(idStore.getBinding('4001', tPromote), /__nonexistent_promo_crash|no such table/i);

  // Verify full rollback: wallet_bindings is still EQ_FAIL_OLD with pending EQ_FAIL_NEW, balance intact
  const rawRow = await rawDb.prepare('SELECT wallet_address, pending_wallet_address FROM wallet_bindings WHERE tg_user_id = ?').bind('4001').first();
  assert.equal(rawRow.wallet_address, 'EQ_FAIL_OLD');
  assert.equal(rawRow.pending_wallet_address, 'EQ_FAIL_NEW');
  assert.equal((await promo.getBalance('EQ_FAIL_OLD')).claimableRaw, '9000000000000');
  assert.equal((await promo.getBalance('EQ_FAIL_NEW')).claimableRaw, '0');

  // Retry succeeds cleanly and migrates balance exactly once
  const retryRes = await idStore.getBinding('4001', tPromote + 5);
  assert.equal(retryRes.walletAddress, 'EQ_FAIL_NEW');
  assert.equal(retryRes.pending, null);
  assert.equal(retryRes.reboundFrom, 'EQ_FAIL_OLD');
  assert.equal((await promo.getBalance('EQ_FAIL_OLD')).claimableRaw, '0');
  assert.equal((await promo.getBalance('EQ_FAIL_NEW')).claimableRaw, '9000000000000');
});

await test('T1-5 [d1-sqlite atomic]: binding update failure inside db.batch() -> promo_balances untouched, retry succeeds cleanly', async () => {
  const rawDb = createSqliteD1(FRESH_SCHEMA);
  let failBindingOnce = false;
  const flakyDb = {
    prepare: (sql) => rawDb.prepare(sql),
    exec: (sql) => rawDb.exec(sql),
    async batch(stmts) {
      if (failBindingOnce && stmts.length >= 2) {
        failBindingOnce = false;
        return rawDb.batch([rawDb.prepare('UPDATE __nonexistent_binding_crash SET x = 1'), ...stmts.slice(1)]);
      }
      return rawDb.batch(stmts);
    },
  };

  const promo = new D1PromoStore({ db: flakyDb, hotWalletAddress: HOT });
  const idStore = new D1IdentityStore({ db: flakyDb, promoEngine: promo });
  const t0 = 450_000;

  await idStore.bindVerifiedWallet('4501', 'EQ_BFAIL_OLD', t0);
  await promo.creditReward('EQ_BFAIL_OLD', '3200000000000', t0);
  await idStore.bindVerifiedWallet('4501', 'EQ_BFAIL_NEW', t0 + 10);

  const tPromote = t0 + 10 + REBIND_DELAY_SEC;
  failBindingOnce = true;
  await assert.rejects(idStore.getBinding('4501', tPromote), /__nonexistent_binding_crash|no such table/i);

  assert.equal((await promo.getBalance('EQ_BFAIL_OLD')).claimableRaw, '3200000000000');
  assert.equal((await promo.getBalance('EQ_BFAIL_NEW')).claimableRaw, '0');

  const ok = await idStore.getBinding('4501', tPromote + 5);
  assert.equal(ok.walletAddress, 'EQ_BFAIL_NEW');
  assert.equal((await promo.getBalance('EQ_BFAIL_OLD')).claimableRaw, '0');
  assert.equal((await promo.getBalance('EQ_BFAIL_NEW')).claimableRaw, '3200000000000');
});

await test('T1-6 [d1-sqlite atomic]: active pending promo claim defers promotion without losing pending rebind; once expired, retry promotes & migrates', async () => {
  const db = createSqliteD1(FRESH_SCHEMA);
  const promo = new D1PromoStore({ db, hotWalletAddress: HOT });
  const idStore = new D1IdentityStore({ db, promoEngine: promo });
  const t0 = 500_000;

  await idStore.bindVerifiedWallet('5001', 'EQ_CLAIM_OLD', t0);
  await promo.creditReward('EQ_CLAIM_OLD', '5000000000000', t0);
  await idStore.bindVerifiedWallet('5001', 'EQ_CLAIM_NEW', t0 + 10);

  const tPromote = t0 + 10 + REBIND_DELAY_SEC;
  // Create an active claim intent right before promotion window
  const claim = await promo.createClaimIntent('EQ_CLAIM_OLD', tPromote - 60);
  assert.equal(claim.status, 'PENDING_FEE');

  // Promotion is deferred cleanly while claim is active
  const deferred = await idStore.getBinding('5001', tPromote);
  assert.equal(deferred.walletAddress, 'EQ_CLAIM_OLD');
  assert.equal(deferred.pending?.walletAddress, 'EQ_CLAIM_NEW');
  assert.equal((await promo.getBalance('EQ_CLAIM_OLD')).claimableRaw, '5000000000000');

  // After claim expires (15m TTL), retry promotes and migrates balance cleanly
  const afterExpiry = await idStore.getBinding('5001', claim.expiresAt + 10);
  assert.equal(afterExpiry.walletAddress, 'EQ_CLAIM_NEW');
  assert.equal(afterExpiry.pending, null);
  assert.equal((await promo.getBalance('EQ_CLAIM_OLD')).claimableRaw, '0');
  assert.equal((await promo.getBalance('EQ_CLAIM_NEW')).claimableRaw, '5000000000000');
});

await test('T1-7 [d1-sqlite fallback onWalletRebound]: callback failure restores pre-promotion binding snapshot; retry succeeds once', async () => {
  const db = createSqliteD1(FRESH_SCHEMA);
  let failCbOnce = true;
  let migratedCalls = 0;
  const idStore = new D1IdentityStore({
    db,
    onWalletRebound: async () => {
      if (failCbOnce) {
        failCbOnce = false;
        throw new Error('DOWNSTREAM_PROMO_UNAVAILABLE');
      }
      migratedCalls += 1;
    },
  });
  const t0 = 600_000;

  await idStore.bindVerifiedWallet('6001', 'EQ_FB_OLD', t0);
  await idStore.bindVerifiedWallet('6001', 'EQ_FB_NEW', t0 + 10);

  const tPromote = t0 + 10 + REBIND_DELAY_SEC;
  await assert.rejects(idStore.getBinding('6001', tPromote), /DOWNSTREAM_PROMO_UNAVAILABLE/);

  // Binding was compensated back to EQ_FB_OLD with pending EQ_FB_NEW intact
  const rawRow = await db.prepare('SELECT wallet_address, pending_wallet_address FROM wallet_bindings WHERE tg_user_id = ?').bind('6001').first();
  assert.equal(rawRow.wallet_address, 'EQ_FB_OLD');
  assert.equal(rawRow.pending_wallet_address, 'EQ_FB_NEW');
  assert.equal(migratedCalls, 0);

  // Concurrent retry -> executes callback exactly once
  const results = await Promise.all([
    idStore.getBinding('6001', tPromote + 1),
    idStore.getBinding('6001', tPromote + 1),
    idStore.getBinding('6001', tPromote + 1),
  ]);
  assert.equal(migratedCalls, 1);
  for (const r of results) {
    assert.equal(r.walletAddress, 'EQ_FB_NEW');
    assert.equal(r.pending, null);
  }
});

await test('T1-8 [memory store]: pre-callback conflict cancels pending rebind cleanly; post-failure conflict raises REBIND_COMMIT_CONFLICT', async () => {
  // 1) Clean conflict before callback ever runs -> pending cancelled, callback never invoked
  let cleanCb = 0;
  const memClean = new MemoryIdentityStore({ onWalletRebound: async () => { cleanCb += 1; } });
  const t0 = 700_000;
  await memClean.bindVerifiedWallet('7001', 'EQ_M_OLD', t0);
  await memClean.bindVerifiedWallet('7001', 'EQ_M_NEW', t0 + 10);
  await memClean.bindVerifiedWallet('7002', 'EQ_M_NEW', t0 + 20);
  const afterClean = await memClean.getBinding('7001', t0 + 10 + REBIND_DELAY_SEC);
  assert.equal(afterClean.walletAddress, 'EQ_M_OLD');
  assert.equal(afterClean.pending, null);
  assert.equal(cleanCb, 0);

  // 2) After callback threw (uncertain external side effects), if another user somehow owns target -> REBIND_COMMIT_CONFLICT
  let shouldThrow = true;
  const memFail = new MemoryIdentityStore({
    onWalletRebound: async () => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('MEM_CB_FAIL');
      }
    },
  });
  await memFail.bindVerifiedWallet('7011', 'EQ_MF_OLD', t0);
  await memFail.bindVerifiedWallet('7011', 'EQ_MF_NEW', t0 + 10);
  await assert.rejects(memFail.getBinding('7011', t0 + 10 + REBIND_DELAY_SEC), /MEM_CB_FAIL/);
  assert.equal(await memFail.getCurrentWalletAddress('7011'), 'EQ_MF_OLD');
  await memFail.bindVerifiedWallet('7012', 'EQ_MF_NEW', t0 + 20);
  await assert.rejects(memFail.getBinding('7011', t0 + 10 + REBIND_DELAY_SEC + 5), { code: 'REBIND_COMMIT_CONFLICT' });
  assert.equal(await memFail.getCurrentWalletAddress('7011'), 'EQ_MF_OLD');
  assert.equal(await memFail.getCurrentWalletAddress('7012'), 'EQ_MF_NEW');
});

// ---------------------------------------------------------------------------
// Real Concurrency Regressions for Fallback Callback Path (Memory + D1)
// ---------------------------------------------------------------------------
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

for (const backend of ['memory', 'd1-sqlite']) {
  const makeStore = (opts = {}) => {
    if (backend === 'memory') return { store: new MemoryIdentityStore(opts), db: null };
    const db = createSqliteD1(FRESH_SCHEMA);
    return { store: new D1IdentityStore({ db, ...opts }), db };
  };

  await test(`T1-9 [${backend}]: while onWalletRebound is awaiting, another user tries to bind old OR target wallet, then callback fails -> blocked, zero double-binding`, async () => {
    const gate = deferred();
    const entered = deferred();
    const { store } = makeStore({
      onWalletRebound: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    const t0 = 710_000;
    await store.bindVerifiedWallet('A', 'EQ_RACE_OLD', t0);
    await store.bindVerifiedWallet('A', 'EQ_RACE_NEW', t0 + 10);

    const tPromote = t0 + 10 + REBIND_DELAY_SEC;
    const pPromote = store.getBinding('A', tPromote);
    await entered.promise;

    // During in-flight callback, User B MUST NOT be able to bind old wallet OR target wallet
    await assert.rejects(store.bindVerifiedWallet('B', 'EQ_RACE_OLD', tPromote + 1), { code: 'WALLET_BOUND_ELSEWHERE' });
    await assert.rejects(store.bindVerifiedWallet('B', 'EQ_RACE_NEW', tPromote + 1), { code: 'WALLET_BOUND_ELSEWHERE' });

    // Now callback fails
    gate.reject(new Error('CALLBACK_BOOM'));
    await assert.rejects(pPromote, /CALLBACK_BOOM/);

    // User A still exclusively owns EQ_RACE_OLD with pending EQ_RACE_NEW; User B has NO binding; zero double-binding
    assert.equal(await store.getCurrentWalletAddress('A'), 'EQ_RACE_OLD');
    assert.equal(await store.getCurrentWalletAddress('B'), null);
    assert.equal(await store.getTelegramUserIdByWallet('EQ_RACE_OLD'), 'A');
    assert.equal(await store.getTelegramUserIdByWallet('EQ_RACE_NEW'), null);
  });

  await test(`T1-10 [${backend}]: while onWalletRebound is awaiting (and after failure), same user cannot cancel, start new rebind, or unbind`, async () => {
    const gate = deferred();
    const entered = deferred();
    let failFirst = true;
    const { store } = makeStore({
      onWalletRebound: async () => {
        if (failFirst) {
          failFirst = false;
          entered.resolve();
          await gate.promise;
        }
      },
    });
    const t0 = 720_000;
    await store.bindVerifiedWallet('A', 'EQ_MUT_OLD', t0);
    await store.bindVerifiedWallet('A', 'EQ_MUT_NEW', t0 + 10);

    const tPromote = t0 + 10 + REBIND_DELAY_SEC;
    const pPromote = store.getBinding('A', tPromote);
    await entered.promise;

    // During in-flight callback: cancel / new rebind / unbind ALL rejected with 409 REBIND_IN_PROGRESS
    await assert.rejects(store.cancelPendingRebind('A'), { code: 'REBIND_IN_PROGRESS' });
    await assert.rejects(store.bindVerifiedWallet('A', 'EQ_MUT_THIRD', tPromote + 1), { code: 'REBIND_IN_PROGRESS' });
    await assert.rejects(store.unbindWallet('A'), { code: 'REBIND_IN_PROGRESS' });

    // Callback fails -> post-failure uncertain state still blocks cancel / new rebind / unbind with REBIND_RECOVERY_REQUIRED
    gate.reject(new Error('PARTIAL_OR_UNKNOWN_FAIL'));
    await assert.rejects(pPromote, /PARTIAL_OR_UNKNOWN_FAIL/);
    await assert.rejects(store.cancelPendingRebind('A'), { code: 'REBIND_RECOVERY_REQUIRED' });
    await assert.rejects(store.bindVerifiedWallet('A', 'EQ_MUT_THIRD', tPromote + 2), { code: 'REBIND_RECOVERY_REQUIRED' });
    await assert.rejects(store.unbindWallet('A'), { code: 'REBIND_RECOVERY_REQUIRED' });

    // Recovery retry succeeds -> binding commits cleanly and subsequent rebind works again
    const recovered = await store.getBinding('A', tPromote + 3);
    assert.equal(recovered.walletAddress, 'EQ_MUT_NEW');
    assert.equal(recovered.pending, null);
    const nextRebind = await store.bindVerifiedWallet('A', 'EQ_MUT_THIRD', tPromote + 4);
    assert.equal(nextRebind.status, 'PENDING_REBIND');
  });

  await test(`T1-11 [${backend}]: callback partially completes (moves balance) then throws -> recoverable retry finishes with zero duplicate migration`, async () => {
    const promo = new PromoHotWalletEngine({ hotWalletAddress: HOT });
    promo.creditReward('EQ_PART_OLD', '7500000000000');
    promo.creditReward('EQ_PART_NEW', '500000000000');
    let attempts = 0;
    const { store } = makeStore({
      onWalletRebound: async ({ fromWalletAddress, toWalletAddress, nowSec }) => {
        attempts += 1;
        // Idempotent balance migration succeeds on attempt 1, then a post-migration hook throws
        await promo.mergeBalance(fromWalletAddress, toWalletAddress, nowSec);
        if (attempts === 1) {
          throw new Error('POST_MIGRATION_NOTIFY_FAILED');
        }
      },
    });
    const t0 = 730_000;
    await store.bindVerifiedWallet('A', 'EQ_PART_OLD', t0);
    await store.bindVerifiedWallet('A', 'EQ_PART_NEW', t0 + 10);

    const tPromote = t0 + 10 + REBIND_DELAY_SEC;
    await assert.rejects(store.getBinding('A', tPromote), /POST_MIGRATION_NOTIFY_FAILED/);
    // Balance moved during attempt 1, binding stayed on recoverable pending state
    assert.equal(promo.getBalance('EQ_PART_OLD').claimableRaw, '0');
    assert.equal(promo.getBalance('EQ_PART_NEW').claimableRaw, '8000000000000');
    assert.equal(await store.getCurrentWalletAddress('A'), 'EQ_PART_OLD');

    // Retry re-runs idempotent mergeBalance (0 delta) and commits binding -> binding & balance unified, zero duplicate
    const ok = await store.getBinding('A', tPromote + 5);
    assert.equal(ok.walletAddress, 'EQ_PART_NEW');
    assert.equal(ok.pending, null);
    assert.equal(attempts, 2);
    assert.equal(promo.getBalance('EQ_PART_OLD').claimableRaw, '0');
    assert.equal(promo.getBalance('EQ_PART_NEW').claimableRaw, '8000000000000');
  });

  await test(`T1-13 [${backend}]: concurrent reads during in-flight callback never observe a temporary target binding for money operations`, async () => {
    const gate = deferred();
    const entered = deferred();
    const { store } = makeStore({
      onWalletRebound: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    const t0 = 740_000;
    await store.bindVerifiedWallet('A', 'EQ_TMP_OLD', t0);
    await store.bindVerifiedWallet('A', 'EQ_TMP_NEW', t0 + 10);

    const tPromote = t0 + 10 + REBIND_DELAY_SEC;
    const p1 = store.getBinding('A', tPromote);
    await entered.promise;

    // Pure read helpers must NEVER expose uncommitted EQ_TMP_NEW
    assert.equal(await store.getCurrentWalletAddress('A'), 'EQ_TMP_OLD');
    assert.equal(await store.getTelegramUserIdByWallet('EQ_TMP_NEW'), null);

    // Concurrent getBinding() (e.g. from /api/promo/intent or /api/presale/intent) must await in-flight
    // promotion and reject if migration fails — never returning a temporary target wallet!
    let p2Resolved = false;
    const p2 = store.getBinding('A', tPromote).then((v) => { p2Resolved = true; return v; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(p2Resolved, false);

    gate.reject(new Error('MIGRATION_FAILED'));
    await assert.rejects(p1, /MIGRATION_FAILED/);
    await assert.rejects(p2, /MIGRATION_FAILED/);
    assert.equal(p2Resolved, false);
  });
}

await test('T1-12 [d1-sqlite cross-isolate]: UNIQUE constraint or concurrent DB mutation during callback commit raises REBIND_COMMIT_CONFLICT without double-binding or overwriting', async () => {
  // Subcase A: cross-isolate raw INSERT claims target wallet while callback is awaiting -> commit hits UNIQUE
  const db1 = createSqliteD1(FRESH_SCHEMA);
  const gate1 = deferred();
  const entered1 = deferred();
  const store1 = new D1IdentityStore({
    db: db1,
    onWalletRebound: async () => {
      entered1.resolve();
      await gate1.promise;
    },
  });
  const t0 = 750_000;
  await store1.bindVerifiedWallet('A', 'EQ_XISO_OLD', t0);
  await store1.bindVerifiedWallet('A', 'EQ_XISO_NEW', t0 + 10);
  const tPromote = t0 + 10 + REBIND_DELAY_SEC;
  const p1 = store1.getBinding('A', tPromote);
  await entered1.promise;

  // Simulate another Worker isolate inserting User B -> EQ_XISO_NEW directly into D1
  await db1
    .prepare('INSERT INTO wallet_bindings (tg_user_id, wallet_address, wallet_key, bound_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind('B', 'EQ_XISO_NEW', 'EQ_XISO_NEW', tPromote + 1, tPromote + 1)
    .run();

  gate1.resolve();
  await assert.rejects(p1, { code: 'REBIND_COMMIT_CONFLICT' });
  // Zero double-binding: A stays on EQ_XISO_OLD, B stays on EQ_XISO_NEW
  assert.equal(await store1.getCurrentWalletAddress('A'), 'EQ_XISO_OLD');
  assert.equal(await store1.getCurrentWalletAddress('B'), 'EQ_XISO_NEW');

  // Subcase B: cross-isolate raw UPDATE changes User A pending target to EQ_XISO_THIRD -> commit refuses to overwrite
  const db2 = createSqliteD1(FRESH_SCHEMA);
  const gate2 = deferred();
  const entered2 = deferred();
  const store2 = new D1IdentityStore({
    db: db2,
    onWalletRebound: async () => {
      entered2.resolve();
      await gate2.promise;
    },
  });
  await store2.bindVerifiedWallet('A', 'EQ_XISO2_OLD', t0);
  await store2.bindVerifiedWallet('A', 'EQ_XISO2_NEW', t0 + 10);
  const p2 = store2.getBinding('A', tPromote);
  await entered2.promise;

  await db2
    .prepare('UPDATE wallet_bindings SET pending_wallet_address = ?, pending_wallet_key = ?, pending_effective_at = ? WHERE tg_user_id = ?')
    .bind('EQ_XISO2_THIRD', 'EQ_XISO2_THIRD', tPromote + 3600, 'A')
    .run();

  gate2.resolve();
  await assert.rejects(p2, { code: 'REBIND_COMMIT_CONFLICT' });
  // Newer rebind request (EQ_XISO2_THIRD) was NOT overwritten
  const row2 = await db2.prepare('SELECT wallet_address, pending_wallet_address FROM wallet_bindings WHERE tg_user_id = ?').bind('A').first();
  assert.equal(row2.wallet_address, 'EQ_XISO2_OLD');
  assert.equal(row2.pending_wallet_address, 'EQ_XISO2_THIRD');
});

await test('T1-14 [d1-sqlite strict atomic guard]: cross-DB promoEngine or strictAtomicRebind with callback explicitly rejects (NON_ATOMIC_REBIND_UNSUPPORTED)', async () => {
  const dbA = createSqliteD1(FRESH_SCHEMA);
  const dbB = createSqliteD1(FRESH_SCHEMA);
  const crossPromo = new D1PromoStore({ db: dbB, hotWalletAddress: HOT });
  const t0 = 760_000;
  const tPromote = t0 + 10 + REBIND_DELAY_SEC;

  // 1) Cross-DB promoEngine refuses silent downgrade
  const crossStore = new D1IdentityStore({ db: dbA, promoEngine: crossPromo });
  await crossStore.bindVerifiedWallet('A', 'EQ_STRICT_OLD', t0);
  await crossStore.bindVerifiedWallet('A', 'EQ_STRICT_NEW', t0 + 10);
  await assert.rejects(crossStore.getBinding('A', tPromote), { code: 'NON_ATOMIC_REBIND_UNSUPPORTED' });

  // 2) strictAtomicRebind: true with onWalletRebound explicitly rejects
  const strictStore = new D1IdentityStore({
    db: dbA,
    strictAtomicRebind: true,
    onWalletRebound: async () => {},
  });
  await assert.rejects(strictStore.getBinding('A', tPromote), { code: 'NON_ATOMIC_REBIND_UNSUPPORTED' });
});

// ===========================================================================
// PART 2: Strict 6-Tier SKU Order Creation & Historical Legacy Order Lifecycle
// ===========================================================================

await test('T2-1 [API /api/presale/intent]: accepts ONLY the 6 valid SKUs; blocks missing/unknown/legacy fixed-rate amounts; defaults openMode to INSTANT with BOOST compat', async () => {
  const db = createSqliteD1(FRESH_SCHEMA);
  const identityStore = new D1IdentityStore({ db });
  const promoEngine = new D1PromoStore({ db, hotWalletAddress: HOT });
  const presaleEngine = new D1PresaleStore({ db, hotWalletAddress: HOT, open: true, defaultQuotaTon: 5000n });
  const socialStore = new D1SocialStore({ db });
  const route = createApiRouter({ env: ENV, stateStore, identityStore, promoEngine, presaleEngine, socialStore });

  const nowSec = 1_770_000_000;
  await identityStore.bindWallet('8001', 'EQ_SKU_BUYER', nowSec);
  const headers = await tgHeaders(8001, { nowSec });

  // 1. Missing both skuId and amount -> 400 SKU_REQUIRED
  const emptyRes = await route({ method: 'POST', pathname: '/api/presale/intent', headers, body: {}, nowSec });
  assert.equal(emptyRes.status, 400);
  assert.equal(emptyRes.body.error.code, 'SKU_REQUIRED');

  // 2. Unknown skuId -> 400 UNKNOWN_SKU
  for (const badSku of ['pack_basic', 'chest_mythic', 'invalid_tier']) {
    const r = await route({ method: 'POST', pathname: '/api/presale/intent', headers, body: { skuId: badSku }, nowSec });
    assert.equal(r.status, 400, badSku);
    assert.equal(r.body.error.code, 'UNKNOWN_SKU', badSku);
  }

  // 3. Arbitrary / legacy fixed-rate amounts (5, 10, 5.99, 1.99, 50, 100, 200, 500.01) -> 400 UNKNOWN_SKU
  for (const badAmt of ['0.5', '1.99', '5', '5.99', '10', '20', '50', '100', '200', '500.01']) {
    const r = await route({ method: 'POST', pathname: '/api/presale/intent', headers, body: { gramAmount: badAmt }, nowSec });
    assert.equal(r.status, 400, `gramAmount=${badAmt}`);
    assert.equal(r.body.error.code, 'UNKNOWN_SKU', `gramAmount=${badAmt}`);
  }

  // 4. Mismatched skuId + gramAmount -> 400 BAD_AMOUNT
  const mismatch = await route({
    method: 'POST',
    pathname: '/api/presale/intent',
    headers,
    body: { skuId: 'chest_silver', gramAmount: '9.99' },
    nowSec,
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, 'BAD_AMOUNT');

  // 5. All 6 valid SKUs succeed by skuId with exact catalog price & baseA9Raw, defaulting openMode to INSTANT
  for (const sku of Object.values(CHEST_MALL_CATALOG)) {
    const r = await route({
      method: 'POST',
      pathname: '/api/presale/intent',
      headers,
      body: { skuId: sku.skuId },
      nowSec,
    });
    assert.equal(r.status, 200, sku.skuId);
    assert.equal(r.body.data.skuId, sku.skuId);
    assert.equal(r.body.data.tonNano, String(sku.priceNano));
    assert.equal(r.body.data.deliveryFeeNano, '60000000');
    assert.equal(r.body.data.payTonNano, String(sku.totalPayNano));
    assert.equal(r.body.data.a9AmountRaw, String(sku.baseA9Raw));
    assert.equal(r.body.data.openMode, 'INSTANT');
  }

  // 6. Exact catalog gramAmount without skuId still maps to the matching SKU, and explicit BOOST remains compatible
  const boostRes = await route({
    method: 'POST',
    pathname: '/api/presale/intent',
    headers,
    body: { gramAmount: '4.99', openMode: 'BOOST' },
    nowSec,
  });
  assert.equal(boostRes.status, 200);
  assert.equal(boostRes.body.data.skuId, 'chest_silver');
  assert.equal(boostRes.body.data.openMode, 'BOOST');
  assert.equal(boostRes.body.data.a9AmountRaw, '8000000000000');
});

await test('T2-2 [d1-sqlite historical orders]: pre-existing legacy non-SKU orders retain full verify, payout, referral, and refund capabilities', async () => {
  const db = createSqliteD1(FRESH_SCHEMA);
  const promo = new D1PromoStore({ db, hotWalletAddress: HOT });
  const presale = new D1PresaleStore({ db, hotWalletAddress: HOT, promoEngine: promo, open: true });
  const t0 = 1_770_100_000;

  // Seed 3 historical legacy non-SKU orders (10 GRAM @ 2,002 A9/GRAM = 20,020 A9, sku_id = NULL)
  const seedLegacy = async (orderId, wallet, referrerId, expiresAt) => {
    await db
      .prepare(
        `INSERT INTO presale_orders
         (order_id, wallet_address, wallet_key, referrer_id, ton_nano, a9_amount_raw, memo, status, expires_at, inbound_tx_hash, payout_tx_hash, refund_ton_nano, sku_id, open_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, '10000000000', '20020000000000', ?, 'PENDING_PAYMENT', ?, NULL, NULL, '0', NULL, 'INSTANT', ?, ?)`,
      )
      .bind(orderId, wallet, wallet, referrerId, `buy:${orderId}`, expiresAt, t0, t0)
      .run();
  };

  await seedLegacy('leg-pay-1', 'EQ_LEG_BUYER_1', 'EQ_LEG_REF_1', t0 + 1800);
  await seedLegacy('leg-late-2', 'EQ_LEG_BUYER_2', null, t0 + 1800);
  await seedLegacy('leg-anom-3', 'EQ_LEG_BUYER_3', null, t0 + 1800);

  // 1) Normal historical order: verify inbound -> queue payout -> broadcast -> confirm -> 6% referral credit
  const plan1 = await presale.planInbound({
    txHash: 'in-leg-1',
    finality: 'finalized',
    to: HOT,
    from: 'EQ_LEG_BUYER_1',
    valueNano: '10060000000',
    memo: 'buy:leg-pay-1',
  }, t0 + 60);
  assert.equal(plan1.action, 'CONFIRM');

  const ing1 = await presale.ingestInbound({
    txHash: 'in-leg-1',
    finality: 'finalized',
    to: HOT,
    from: 'EQ_LEG_BUYER_1',
    valueNano: '10060000000',
    memo: 'buy:leg-pay-1',
  }, t0 + 60);
  assert.equal(ing1.action, 'CONFIRM');
  assert.equal(await presale.queueConfirmedPayouts(t0 + 61), 1);

  let paidA9 = null;
  await presale.processPayouts(t0 + 62, {
    a9Broadcaster: async (inst) => {
      paidA9 = inst.jettonAmountRaw;
      return { txHash: 'out-a9-leg-1' };
    },
    verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }),
  });
  assert.equal(paidA9, '20020000000000');
  const done1 = await presale.getOrder('leg-pay-1');
  assert.equal(done1.status, PRESALE_STATUS.COMPLETED);
  assert.equal(done1.payoutTxHash, 'out-a9-leg-1');

  await presale.processReferralCredits(t0 + 65);
  // 6% of 20,020 A9 = 1,201.2 A9 = 1201200000000 raw
  assert.equal((await promo.getBalance('EQ_LEG_REF_1')).claimableRaw, '1201200000000');

  // 2) Expired historical order paid late -> automatic refund minus 0.03 GRAM gas
  const late2 = await presale.ingestInbound({
    txHash: 'in-leg-2-late',
    finality: 'finalized',
    to: HOT,
    from: 'EQ_LEG_BUYER_2',
    valueNano: '10060000000',
    memo: 'buy:leg-late-2',
  }, t0 + 1900);
  assert.equal(late2.action, 'REFUND');
  assert.equal(late2.refundNano, 10_030_000_000n);
  await presale.processPayouts(t0 + 1905, {
    refundBroadcaster: async () => ({ txHash: 'rf-leg-2' }),
    verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }),
  });
  assert.equal((await presale.getOrder('leg-late-2')).status, PRESALE_STATUS.REFUNDED);

  // 3) Underpaid historical order -> anomaly -> manual admin refund -> REFUNDED
  const anom3 = await presale.ingestInbound({
    txHash: 'in-leg-3-short',
    finality: 'finalized',
    to: HOT,
    from: 'EQ_LEG_BUYER_3',
    valueNano: '8000000000',
    memo: 'buy:leg-anom-3',
  }, t0 + 100);
  assert.equal(anom3.action, 'ANOMALY');
  assert.equal((await presale.getOrder('leg-anom-3')).status, PRESALE_STATUS.PAYMENT_EXCEPTION);
  const res3 = await presale.resolveAnomaly('in-leg-3-short', {
    decision: 'REFUND',
    faultParty: 'USER',
    operator: 'ops-audit',
    note: 'legacy short payment refund',
  }, t0 + 110);
  assert.equal(res3.refundNano, '7970000000');
  await presale.processPayouts(t0 + 120, {
    refundBroadcaster: async () => ({ txHash: 'rf-leg-3' }),
    verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }),
  });
  assert.equal((await presale.getOrder('leg-anom-3')).status, PRESALE_STATUS.REFUNDED);
});

console.log(`All ${passed} rebind consistency & strict 6-SKU hardening tests passed.`);
