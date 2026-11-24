// A9 Protocol v16 — Warm-Up v2 Reservations, Viral Round Chests, Admin Funnel & Opening Reminders Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiRouter } from '../src/api.mjs';
import { SocialStore, parseStartAppParam } from '../src/social-store.mjs';
import { ChestEngine } from '../src/chest-engine.mjs';
import { PredictionEngine } from '../src/growth-engine.mjs';
import { D1SocialStore, D1PredictionEngine } from '../src/d1-growth-store.mjs';
import { D1ChestEngine } from '../src/d1-chest-store.mjs';
import { D1IdentityStore, MemoryIdentityStore } from '../src/auth.mjs';
import { TelegramBroadcaster, MemoryBroadcastLog, D1BroadcastLog } from '../src/tg-broadcaster.mjs';
import {
  createSqliteD1,
  FRESH_SCHEMA,
  MIGRATIONS,
  TEST_BOT_TOKEN,
  tgHeaders,
  makeV4R2Wallet,
  signTonProof,
} from './helpers/test-env.mjs';

const ADMIN_TOKEN = 'test-warmup-admin-secret';
const NOW = 1_760_000_000;

function makeStateStore(currentRoundId = 0, rounds = []) {
  return {
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ({ dataAvailable: true, currentRoundId, successCount: 0, poolRemainingRaw: '7000000000000000000' }),
    listRounds: () => rounds,
    getRound: (id) => rounds.find((r) => r.roundId === Number(id)) || null,
  };
}

function makeStack(mode = 'memory', { currentRoundId = 0, rounds = [], activeWallets = new Set() } = {}) {
  const db = mode === 'd1-fresh'
    ? createSqliteD1(FRESH_SCHEMA)
    : mode === 'd1-migrated'
      ? createSqliteD1(MIGRATIONS)
      : null;

  const identityStore = db ? new D1IdentityStore({ db }) : new MemoryIdentityStore();
  const socialStore = db ? new D1SocialStore({ db }) : new SocialStore();
  const chestEngine = db ? new D1ChestEngine({ db }) : new ChestEngine();
  const predictionEngine = db ? new D1PredictionEngine({ db }) : new PredictionEngine();
  const stateStore = makeStateStore(currentRoundId, rounds);
  const env = {
    A9_BOT_TOKEN: TEST_BOT_TOKEN,
    A9_TG_BOT_HANDLE: 'A9TestBot',
    A9_ADMIN_TOKEN: ADMIN_TOKEN,
    A9_TON_PROOF_DOMAINS: 'a9.example',
    A9_NETWORK: 'testnet',
    A9_CHEST_OPEN_ENABLED: '1',
    A9_BROADCAST_ENABLED: '1',
  };
  const router = createApiRouter({
    env,
    stateStore,
    socialStore,
    chestEngine,
    predictionEngine,
    identityStore,
    walletStateResolver: async (addr) => ({ state: activeWallets.has(addr) ? 'active' : 'uninitialized' }),
  });
  return { db, env, router, socialStore, chestEngine, predictionEngine, identityStore };
}

test('parseStartAppParam supports warmup, warmup_<roundId>, and warmup_<roundId>_<ref>', () => {
  assert.deepEqual(parseStartAppParam('warmup'), { raw: 'warmup', kind: 'warmup', teamId: null, targetId: null, referrerId: null });
  assert.deepEqual(parseStartAppParam('warmup_3'), { raw: 'warmup_3', kind: 'warmup', teamId: null, targetId: '3', referrerId: null });
  assert.deepEqual(parseStartAppParam('warmup_3_10001'), { raw: 'warmup_3_10001', kind: 'warmup', teamId: null, targetId: '3', referrerId: '10001' });
});

for (const mode of ['memory', 'd1-fresh', 'd1-migrated']) {
  test(`[${mode}] full warmup v2 flow: zero-friction reserve -> round chest -> viral invites -> wallet backfill -> open to pending vault -> admin summary`, async () => {
    const activeWallets = new Set();
    const wA = await makeV4R2Wallet();
    const wB = await makeV4R2Wallet();
    const wC = await makeV4R2Wallet();
    const wD = await makeV4R2Wallet();
    activeWallets.add(wA.address);
    activeWallets.add(wB.address);
    activeWallets.add(wC.address);
    // wD stays uninitialized (inactive) to verify anti-sybil filter!

    // Current on-chain round is 2, so upcoming warmup target automatically resolves to round 3
    const { router, socialStore, predictionEngine } = makeStack(mode, {
      currentRoundId: 2,
      rounds: [{ roundId: 2, round: { status: 2, stakeCount: 12 }, candles: [] }],
      activeWallets,
    });

    // 1. Admin configures round 3 schedule & target
    const cfgRes = await router({
      method: 'POST',
      pathname: '/api/admin/warmup/round',
      headers: { 'x-a9-admin-token': ADMIN_TOKEN },
      body: { roundId: 3, targetUsers: 200, plannedOpenAt: NOW + 7200 },
      nowSec: NOW,
    });
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.body.data.targetUsers, 200);

    // 2. Anonymous GET /api/warmup/current resolves to round 3 with 0 registered
    const pub0 = await router({ method: 'GET', pathname: '/api/warmup/current', nowSec: NOW });
    assert.equal(pub0.status, 200);
    assert.equal(pub0.body.data.roundId, 3);
    assert.equal(pub0.body.data.stats.totalRegistered, 0);
    assert.equal(pub0.body.data.myReservation, null);

    // 3. User A (TG 1001) reserves WITHOUT binding a wallet first!
    const hA = await tgHeaders(1001, { nowSec: NOW });
    const regA = await router({
      method: 'POST',
      pathname: '/api/warmup/register',
      headers: hA,
      body: { intentTier: '5000', remindEnabled: true },
      nowSec: NOW,
    });
    assert.equal(regA.status, 200);
    assert.equal(regA.body.data.roundId, 3);
    assert.equal(regA.body.data.reservation.intentTier, '5000');
    assert.equal(regA.body.data.warmupChest.source, 'WARMUP_ROUND');
    assert.equal(regA.body.data.warmupChest.slotIndex, 3);
    assert.equal(regA.body.data.warmupChest.baseA9Raw, '300000000000');
    assert.equal(regA.body.data.warmupChest.status, 'ACTIVE');
    assert.equal(regA.body.data.starterGranted, true);
    assert.match(regA.body.data.inviteDeepLink, /startapp=warmup_3_1001$/);

    // 4. User B (TG 1002) joins via A's link without wallet first -> rawInvites=1, validInvites=0
    const hB = await tgHeaders(1002, { nowSec: NOW + 1 });
    const regB = await router({
      method: 'POST',
      pathname: '/api/warmup/register',
      headers: hB,
      body: { referrerId: '1001', intentTier: '20000_plus' },
      nowSec: NOW + 1,
    });
    assert.equal(regB.status, 200);
    assert.equal(regB.body.data.warmupChest.source, 'WARMUP_ROUND');
    let curA = await router({ method: 'GET', pathname: '/api/warmup/current', headers: hA, nowSec: NOW + 2 });
    assert.equal(curA.body.data.myReservation.rawInvites, 1);
    assert.equal(curA.body.data.myReservation.validInvites, 0);
    assert.equal(curA.body.data.myWarmupChest.currentAssists, 0);

    // 5. User B binds active TON wallet via ton_proof -> automatically backfills A's validInvites to 1!
    const pB = await router({ method: 'POST', pathname: '/api/auth/ton-proof/payload', headers: hB, nowSec: NOW + 3 });
    const proofB = await signTonProof(wB, { payload: pB.body.data.payload, timestamp: NOW + 3 });
    const verB = await router({
      method: 'POST',
      pathname: '/api/auth/ton-proof/verify',
      headers: hB,
      body: { address: wB.address, network: '-3', publicKey: wB.pubHex, proof: proofB },
      nowSec: NOW + 3,
    });
    assert.equal(verB.status, 200);

    curA = await router({ method: 'GET', pathname: '/api/warmup/current', headers: hA, nowSec: NOW + 4 });
    assert.equal(curA.body.data.myReservation.validInvites, 1);
    assert.equal(curA.body.data.myWarmupChest.currentAssists, 1);
    assert.equal(curA.body.data.myWarmupChest.status, 'ACTIVE');

    // Cannot open chest yet (needs 2 valid invites)
    const earlyOpen = await router({
      method: 'POST',
      pathname: `/api/chests/${curA.body.data.myWarmupChest.chestId}/open`,
      headers: hA,
      nowSec: NOW + 5,
    });
    assert.equal(earlyOpen.status, 400);
    assert.equal(earlyOpen.body.error.code, 'ASSISTS_UNMET');

    // 6. User D (TG 1004) binds INACTIVE wallet & joins via A -> rawInvites=2, validInvites still 1
    const hD = await tgHeaders(1004, { nowSec: NOW + 6 });
    const pD = await router({ method: 'POST', pathname: '/api/auth/ton-proof/payload', headers: hD, nowSec: NOW + 6 });
    const proofD = await signTonProof(wD, { payload: pD.body.data.payload, timestamp: NOW + 6 });
    await router({
      method: 'POST',
      pathname: '/api/auth/ton-proof/verify',
      headers: hD,
      body: { address: wD.address, network: '-3', publicKey: wD.pubHex, proof: proofD },
      nowSec: NOW + 6,
    });
    await router({
      method: 'POST',
      pathname: '/api/warmup/register',
      headers: hD,
      body: { referrerId: '1001', intentTier: 'watching' },
      nowSec: NOW + 7,
    });
    curA = await router({ method: 'GET', pathname: '/api/warmup/current', headers: hA, nowSec: NOW + 8 });
    assert.equal(curA.body.data.myReservation.rawInvites, 2);
    assert.equal(curA.body.data.myReservation.validInvites, 1);

    // 7. User C (TG 1003) binds ACTIVE wallet & joins via A -> validInvites=2, A's chest becomes READY (300 A9)
    const hC = await tgHeaders(1003, { nowSec: NOW + 9 });
    const pC = await router({ method: 'POST', pathname: '/api/auth/ton-proof/payload', headers: hC, nowSec: NOW + 9 });
    const proofC = await signTonProof(wC, { payload: pC.body.data.payload, timestamp: NOW + 9 });
    await router({
      method: 'POST',
      pathname: '/api/auth/ton-proof/verify',
      headers: hC,
      body: { address: wC.address, network: '-3', publicKey: wC.pubHex, proof: proofC },
      nowSec: NOW + 9,
    });
    await router({
      method: 'POST',
      pathname: '/api/warmup/register',
      headers: hC,
      body: { referrerId: '1001', intentTier: '1000' },
      nowSec: NOW + 10,
    });
    curA = await router({ method: 'GET', pathname: '/api/warmup/current', headers: hA, nowSec: NOW + 11 });
    assert.equal(curA.body.data.myReservation.validInvites, 2);
    assert.equal(curA.body.data.myWarmupChest.status, 'READY');

    // 8. User A opens WARMUP_ROUND chest -> 300 A9 credited atomically to PENDING_VAULT
    const openA = await router({
      method: 'POST',
      pathname: `/api/chests/${curA.body.data.myWarmupChest.chestId}/open`,
      headers: hA,
      nowSec: NOW + 12,
    });
    assert.equal(openA.status, 200);
    assert.equal(openA.body.data.destination, 'PENDING_VAULT');
    assert.equal(openA.body.data.rewardA9Raw, '300000000000');

    const predA = await predictionEngine.getUserSummary('1001', 3);
    assert.equal(predA.pendingActivationRaw, '300000000000');

    // Double-open is blocked
    const dupOpen = await router({
      method: 'POST',
      pathname: `/api/chests/${curA.body.data.myWarmupChest.chestId}/open`,
      headers: hA,
      nowSec: NOW + 13,
    });
    assert.equal(dupOpen.status, 400);
    assert.equal(dupOpen.body.error.code, 'ALREADY_OPENED');

    // 9. Admin summary shows exact funnel breakdown
    const unauth = await router({ method: 'GET', pathname: '/api/admin/warmup/summary', query: { roundId: '3' }, nowSec: NOW + 14 });
    assert.equal(unauth.status, 401);

    const summary = await router({
      method: 'GET',
      pathname: '/api/admin/warmup/summary',
      headers: { 'x-a9-admin-token': ADMIN_TOKEN },
      query: { roundId: '3' },
      nowSec: NOW + 14,
    });
    assert.equal(summary.status, 200);
    const s = summary.body.data;
    assert.equal(s.roundId, 3);
    assert.equal(s.totalActive, 4);
    assert.equal(s.walletBoundCount, 3); // B, C, D
    assert.equal(s.activeWalletCount, 2); // B, C
    assert.equal(s.intentBreakdown['1000'], 1);
    assert.equal(s.intentBreakdown['5000'], 1);
    assert.equal(s.intentBreakdown['20000_plus'], 1);
    assert.equal(s.intentBreakdown.watching, 1);
    assert.equal(s.estimatedIntentA9Min, 26000);
    assert.equal(s.topInviters[0].tgUserId, '1001');
    assert.equal(s.topInviters[0].validInvites, 2);
    assert.equal(s.topInviters[0].rawInvites, 3);

    // 10. Opening reminder broadcast sends once per reserved user and marks reminded_at
    const sentChats = [];
    const broadcaster = new TelegramBroadcaster({
      enabled: true,
      botToken: TEST_BOT_TOKEN,
      botHandle: 'A9TestBot',
      socialStore,
      dedupLog: mode === 'memory' ? new MemoryBroadcastLog() : new D1BroadcastLog({ db: createSqliteD1(FRESH_SCHEMA) }),
      delayMs: 0,
      fetchImpl: async (_url, init) => {
        const payload = JSON.parse(init.body);
        sentChats.push(payload.chat_id);
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      },
    });
    const rem1 = await broadcaster.sendWarmupOpeningReminders({ roundId: 3, round: { targetPriceUsdE8: '1500000' }, nowSec: NOW + 20 });
    assert.equal(rem1.sentCount, 4);
    assert.equal(sentChats.length, 4);
    const rem2 = await broadcaster.sendWarmupOpeningReminders({ roundId: 3, round: { targetPriceUsdE8: '1500000' }, nowSec: NOW + 25 });
    assert.equal(rem2.skipped, true);
    assert.equal(rem2.reason, 'NO_PENDING_REMINDERS');
  });

  test(`[${mode}] anti-sybil & edge cases: assistChest blocked on WARMUP_ROUND, 3..6 invite cap (900 A9), cancel rollback, wallet lock, PAUSED/CLOSED, open gate & 403 skip`, async () => {
    const activeWallets = new Set();
    const wallets = [];
    for (let i = 0; i < 7; i += 1) {
      const w = await makeV4R2Wallet();
      activeWallets.add(w.address);
      wallets.push(w);
    }

    const { router, socialStore, env } = makeStack(mode, { currentRoundId: 2, activeWallets });

    const bindWallet = async (tgId, w, ts) => {
      const h = await tgHeaders(tgId, { nowSec: ts });
      const p = await router({ method: 'POST', pathname: '/api/auth/ton-proof/payload', headers: h, nowSec: ts });
      const proof = await signTonProof(w, { payload: p.body.data.payload, timestamp: ts });
      const v = await router({
        method: 'POST',
        pathname: '/api/auth/ton-proof/verify',
        headers: h,
        body: { address: w.address, network: '-3', publicKey: w.pubHex, proof },
        nowSec: ts,
      });
      assert.equal(v.status, 200);
      return h;
    };

    // Host A (2001) reserves round 3
    const hA = await bindWallet(2001, wallets[0], NOW);
    const regA = await router({ method: 'POST', pathname: '/api/warmup/register', headers: hA, body: { roundId: 3 }, nowSec: NOW });
    assert.equal(regA.status, 200);
    const chestId = regA.body.data.warmupChest.chestId;

    // 1. assistChest must reject WARMUP_ROUND chests
    const hHelper = await bindWallet(2002, wallets[1], NOW + 1);
    const badAssist = await router({
      method: 'POST',
      pathname: `/api/chests/${chestId}/assist`,
      headers: hHelper,
      body: { walletAddress: wallets[1].address },
      nowSec: NOW + 1,
    });
    assert.equal(badAssist.status, 400);
    assert.equal(badAssist.body.error.code, 'ASSIST_NOT_ALLOWED');

    // 2. Invite 6 active-wallet friends -> reward scales 300 -> 500 -> 700 -> 900 -> 900 (cap)
    const friendHeaders = [hHelper];
    for (let i = 1; i <= 6; i += 1) {
      const hF = i === 1 ? hHelper : await bindWallet(2001 + i, wallets[i], NOW + 2 + i);
      if (i > 1) friendHeaders.push(hF);
      const rF = await router({
        method: 'POST',
        pathname: '/api/warmup/register',
        headers: hF,
        body: { roundId: 3, referrerId: '2001' },
        nowSec: NOW + 10 + i,
      });
      assert.equal(rF.status, 200);
      const curA = await router({ method: 'GET', pathname: '/api/warmup/current', headers: hA, query: { roundId: '3' }, nowSec: NOW + 10 + i });
      const c = curA.body.data.myWarmupChest;
      const totalRaw = (BigInt(c.baseA9Raw) + BigInt(c.boostA9Raw)).toString();
      if (i === 2) assert.equal(totalRaw, '300000000000');
      if (i === 3) assert.equal(totalRaw, '500000000000');
      if (i === 4) assert.equal(totalRaw, '700000000000');
      if (i === 5) assert.equal(totalRaw, '900000000000');
      if (i === 6) assert.equal(totalRaw, '900000000000');
    }

    // 3. Cancel friend #6 -> rolls back count to 5; re-registering does not double count
    const cancelF6 = await router({ method: 'POST', pathname: '/api/warmup/cancel', headers: friendHeaders[5], body: { roundId: 3 }, nowSec: NOW + 30 });
    assert.equal(cancelF6.status, 200);
    let curA = await router({ method: 'GET', pathname: '/api/warmup/current', headers: hA, query: { roundId: '3' }, nowSec: NOW + 31 });
    assert.equal(curA.body.data.myReservation.validInvites, 5);
    await router({ method: 'POST', pathname: '/api/warmup/register', headers: friendHeaders[5], body: { roundId: 3, referrerId: '2001' }, nowSec: NOW + 32 });
    curA = await router({ method: 'GET', pathname: '/api/warmup/current', headers: hA, query: { roundId: '3' }, nowSec: NOW + 33 });
    assert.equal(curA.body.data.myReservation.validInvites, 6);

    // 4. Dual-layer anti-sybil:
    //    (a) While wallet[6] is still bound to TG 2007, another TG user (2099) cannot bind it (409 WALLET_ALREADY_BOUND)
    //    (b) Even after TG 2007 cancels Round 3 AND unbinds wallet[6], TG 2099 binding wallet[6] is STILL blocked from Round 3 (400 WALLET_ALREADY_RESERVED), while Round 4 succeeds!
    await router({ method: 'POST', pathname: '/api/warmup/cancel', headers: friendHeaders[5], body: { roundId: 3 }, nowSec: NOW + 34 });
    const hSybil = await tgHeaders(2099, { nowSec: NOW + 35 });
    const pSybil1 = await router({ method: 'POST', pathname: '/api/auth/ton-proof/payload', headers: hSybil, nowSec: NOW + 35 });
    const proofSybil1 = await signTonProof(wallets[6], { payload: pSybil1.body.data.payload, timestamp: NOW + 35 });
    const dupBind = await router({
      method: 'POST',
      pathname: '/api/auth/ton-proof/verify',
      headers: hSybil,
      body: { address: wallets[6].address, network: '-3', publicKey: wallets[6].pubHex, proof: proofSybil1 },
      nowSec: NOW + 35,
    });
    assert.equal(dupBind.status, 409);

    // TG 2007 explicitly unbinds wallets[6], then TG 2099 binds wallets[6] cleanly
    const pUnbind = await router({ method: 'POST', pathname: '/api/auth/ton-proof/payload', headers: friendHeaders[5], nowSec: NOW + 35 });
    const proofUnbind = await signTonProof(wallets[6], { payload: pUnbind.body.data.payload, timestamp: NOW + 35 });
    const unbindRes = await router({
      method: 'POST',
      pathname: '/api/auth/ton-proof/verify',
      headers: friendHeaders[5],
      body: { address: wallets[6].address, network: '-3', publicKey: wallets[6].pubHex, proof: proofUnbind, purpose: 'unbind' },
      nowSec: NOW + 35,
    });
    assert.equal(unbindRes.status, 200);
    await bindWallet(2099, wallets[6], NOW + 35);

    const sybilRes = await router({
      method: 'POST',
      pathname: '/api/warmup/register',
      headers: hSybil,
      body: { roundId: 3, referrerId: '2001' },
      nowSec: NOW + 35,
    });
    assert.equal(sybilRes.status, 400);
    assert.equal(sybilRes.body.error.code, 'WALLET_ALREADY_RESERVED');

    // Cross-round reuse in round 4 succeeds
    const r4Res = await router({ method: 'POST', pathname: '/api/warmup/register', headers: hSybil, body: { roundId: 4 }, nowSec: NOW + 36 });
    assert.equal(r4Res.status, 200);

    // 5. A9_CHEST_OPEN_ENABLED !== '1' blocks WARMUP_ROUND open
    env.A9_CHEST_OPEN_ENABLED = '0';
    const blockedOpen = await router({ method: 'POST', pathname: `/api/chests/${chestId}/open`, headers: hA, nowSec: NOW + 37 });
    assert.equal(blockedOpen.status, 403);
    assert.equal(blockedOpen.body.error.code, 'CHEST_OPEN_DISABLED');
    env.A9_CHEST_OPEN_ENABLED = '1';

    // 6. CLOSED round rejects new reservations
    await router({
      method: 'POST',
      pathname: '/api/admin/warmup/round',
      headers: { 'x-a9-admin-token': ADMIN_TOKEN },
      body: { roundId: 3, status: 'CLOSED' },
      nowSec: NOW + 38,
    });
    const hLate = await tgHeaders(2100, { nowSec: NOW + 39 });
    const lateRes = await router({ method: 'POST', pathname: '/api/warmup/register', headers: hLate, body: { roundId: 3 }, nowSec: NOW + 39 });
    assert.equal(lateRes.status, 400);
    assert.equal(lateRes.body.error.code, 'WARMUP_CLOSED');

    // 7. Reminder permanent 403 error marks user skipped so next batch is not head-of-line blocked
    const broadcaster = new TelegramBroadcaster({
      enabled: true,
      botToken: TEST_BOT_TOKEN,
      botHandle: 'A9TestBot',
      socialStore,
      dedupLog: new MemoryBroadcastLog(),
      delayMs: 0,
      fetchImpl: async (_url, init) => {
        const p = JSON.parse(init.body);
        if (p.chat_id === '2001') {
          return { ok: false, status: 403, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      },
    });
    const rem = await broadcaster.sendWarmupOpeningReminders({ roundId: 3, limit: 2, nowSec: NOW + 40 });
    assert.equal(rem.failedPermanentCount, 1);
    assert.equal(rem.sentCount, 1);
    assert.equal(rem.hasMore, true);
  });
}
