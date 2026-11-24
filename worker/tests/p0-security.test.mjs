#!/usr/bin/env node
// Phase 1 / P0 security & money-safety tests (task book §10.2: identity + A9 fixed exchange).
// Run: node worker/tests/p0-security.test.mjs   (Node >= 22.5 for node:sqlite)
import assert from 'node:assert/strict';
import { createApiRouter } from '../src/api.mjs';
import { MemoryIdentityStore, D1IdentityStore, signTelegramInitData, verifyTelegramInitData } from '../src/auth.mjs';
import { PresaleHotWalletEngine, PRESALE_STATUS, STALE_BROADCAST_SEC } from '../src/presale-hotwallet.mjs';
import { D1PresaleStore, D1SocialStore, D1PredictionEngine, D1ProgressionEngine } from '../src/d1-growth-store.mjs';
import { PresalePayoutRunner } from '../src/presale-runner.mjs';
import { PromoHotWalletEngine } from '../src/promo-hotwallet.mjs';
import { D1PromoStore } from '../src/d1-promo-store.mjs';
import { SocialStore, parseStartAppParam, createTelegramBotGroupVerifier } from '../src/social-store.mjs';
import { PredictionEngine, ProgressionEngine, VOUCHER_TTL_MS } from '../src/growth-engine.mjs';
import { TelegramBroadcaster, MemoryBroadcastLog, D1BroadcastLog, buildTeamDeepLink } from '../src/tg-broadcaster.mjs';
import { parseDecimalUnits, formatUnits } from '../src/money.mjs';
import { normalizeTonAddress, formatTonAddress, parseTonAddress } from '../src/ton-address.mjs';
import { TEST_BOT_TOKEN, tgHeaders, createSqliteD1, FRESH_SCHEMA, MIGRATIONS, completePurchase, dumpDb, createMiniflareD1, makeV4R2Wallet, signTonProof, PROOF_FIXTURES } from './helpers/test-env.mjs';
import { verifyTonProof, REBIND_DELAY_SEC, TON_PROOF_MAX_SKEW_SEC } from '../src/auth.mjs';
import { inspectWalletStateInit, cellFromBits, serializeBoc, WALLET_TG_TRAMPOLINE_HASH } from '../src/ton-cell.mjs';
import { TonCenterClient, encodeAddressSliceBoc, decodeAddressFromCellBoc } from '../src/toncenter.mjs';
import cfWorker from '../src/cf-worker.mjs';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

const HOT = 'EQ_P0_HOT';
const stateStore = {
  getTiming: () => ({ observationSeconds: 86400 }),
  getProtocolState: () => ({ currentRoundId: 1, successCount: 0 }),
  listRounds: () => [],
  getRound: () => null,
};
const ENV = { A9_BOT_TOKEN: TEST_BOT_TOKEN, A9_TON_PROOF_DOMAINS: 'a9.example', A9_NETWORK: 'testnet', A9_ADMIN_TOKEN: 'adm-p0' };

function buildRouter(extra = {}) {
  const identityStore = extra.identityStore || new MemoryIdentityStore();
  const promoEngine = extra.promoEngine || new PromoHotWalletEngine({ hotWalletAddress: HOT });
  const progressionEngine = extra.progressionEngine || new ProgressionEngine();
  const presaleEngine = extra.presaleEngine || new PresaleHotWalletEngine({ hotWalletAddress: HOT, open: true });
  const socialStore = extra.socialStore || new SocialStore();
  const predictionEngine = extra.predictionEngine || new PredictionEngine();
  const route = createApiRouter({ env: ENV, stateStore, identityStore, promoEngine, presaleEngine, socialStore, predictionEngine, progressionEngine, ...extra });
  return { route, identityStore, promoEngine, presaleEngine, socialStore, predictionEngine, progressionEngine };
}

/** Both storage backends must behave identically (explicit open:true for order-flow suites; default closed tested separately). */
const BACKENDS = [
  ['memory', async (opts = {}) => new PresaleHotWalletEngine({ hotWalletAddress: HOT, open: true, ...opts })],
  ['d1-sqlite', async (opts = {}) => {
    const db = opts.db || createSqliteD1(FRESH_SCHEMA);
    const e = new D1PresaleStore({ db, hotWalletAddress: HOT, open: true, ...opts });
    e._db = db;
    return e;
  }],
];
const MF_DISPOSE = [];
if (await createMiniflareD1().then((mf) => { if (mf) MF_DISPOSE.push(mf.dispose); return Boolean(mf); })) {
  BACKENDS.push(['d1-miniflare', async (opts = {}) => {
    const mf = await createMiniflareD1();
    MF_DISPOSE.push(mf.dispose);
    const e = new D1PresaleStore({ db: mf.db, hotWalletAddress: HOT, open: true, ...opts });
    e._db = mf.db;
    return e;
  }]);
} else {
  console.log('  SKIP  [d1-miniflare] backend: `miniflare` not installed (npm i -D miniflare to run against real D1/workerd)');
}
const dumpOf = async (e) => (e._db ? dumpDb(e._db) : e.repo.snapshot());
const inbound = (order, extra = {}) => ({ txHash: `in-${order.orderId}`, finality: 'finalized', to: HOT, from: order.walletAddress, valueNano: order.payTonNano, memo: order.memo, ...extra });

console.log('Running phase-1 P0 security tests...');

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
await test('initData signed with a different bot token is rejected (forged Telegram identity)', async () => {
  const { route } = buildRouter();
  const forged = await tgHeaders(777, { botToken: '999:ATTACKER', nowSec: 1000 });
  const r = await route({ method: 'GET', pathname: '/api/me', headers: forged, nowSec: 1000 });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'AUTH_INVALID');
});

await test('editing the user id inside correctly signed initData breaks the signature', async () => {
  const { route } = buildRouter();
  const h = await tgHeaders(1, { nowSec: 1000 });
  const tampered = { authorization: h.authorization.replace(encodeURIComponent('"id":1,'), encodeURIComponent('"id":2,')) };
  assert.notEqual(tampered.authorization, h.authorization);
  const r = await route({ method: 'GET', pathname: '/api/me', headers: tampered, nowSec: 1000 });
  assert.equal(r.status, 401);
  const okr = await route({ method: 'GET', pathname: '/api/me', headers: h, nowSec: 1000 });
  assert.equal(okr.status, 200);
  assert.equal(okr.body.data.telegramUserId, '1');
});

await test('expired / future auth_date and missing initData are rejected; missing bot token fails closed', async () => {
  const { route } = buildRouter();
  const old = await tgHeaders(5, { authDate: 1000, nowSec: 1000 });
  const r1 = await route({ method: 'GET', pathname: '/api/me', headers: old, nowSec: 1000 + 86400 + 1 });
  assert.equal(r1.body.error.code, 'AUTH_EXPIRED');
  const future = await tgHeaders(5, { authDate: 5000, nowSec: 1000 });
  assert.equal((await route({ method: 'GET', pathname: '/api/me', headers: future, nowSec: 1000 })).status, 401);
  assert.equal((await route({ method: 'GET', pathname: '/api/me', nowSec: 1000 })).body.error.code, 'AUTH_REQUIRED');
  const noToken = createApiRouter({ env: {}, stateStore });
  const r2 = await noToken({ method: 'GET', pathname: '/api/me', headers: await tgHeaders(5, { nowSec: 1000 }), nowSec: 1000 });
  assert.equal(r2.status, 503);
  // data-check-string must include every field but `hash` (incl. start_param), sorted by key.
  const init = await signTelegramInitData({ auth_date: '1000', start_param: 'round_1', user: { id: 9 } }, TEST_BOT_TOKEN);
  const v = await verifyTelegramInitData(init, TEST_BOT_TOKEN, { nowSec: 1000 });
  assert.equal(v.startParam, 'round_1');
});

await test('client-supplied userId never selects the account (prediction bet / record / activation)', async () => {
  const { route, predictionEngine } = buildRouter();
  const h = await tgHeaders(4001, { nowSec: 1000 });
  const spoof = await route({ method: 'POST', pathname: '/api/prediction/bet', body: { roundId: 1, userId: '4002', side: 'PASS' }, headers: h, nowSec: 1000 });
  assert.equal(spoof.status, 403);
  const real = await route({ method: 'POST', pathname: '/api/prediction/bet', body: { roundId: 1, side: 'PASS' }, headers: h, nowSec: 1000 });
  assert.equal(real.status, 200);
  assert.equal(real.body.data.userId, '4001');
  assert.equal(predictionEngine.getUserSummary('4002', 1).currentBet, null);
  const peek = await route({ method: 'GET', pathname: '/api/prediction/user/4002', headers: h, nowSec: 1000 });
  assert.equal(peek.status, 403);
  const anonBet = await route({ method: 'POST', pathname: '/api/prediction/bet', body: { roundId: 1, userId: '4003', side: 'PASS' }, nowSec: 1000 });
  assert.equal(anonBet.status, 401);
});

await test('unverified wallet cannot read or act on private assets; public on-chain view hides private parts', async () => {
  const { route, promoEngine } = buildRouter();
  promoEngine.creditReward('EQ_VICTIM', 5_000_000_000_000n);
  const h = await tgHeaders(5001, { nowSec: 1000 });
  for (const path of ['/api/presale/orders/EQ_VICTIM', '/api/presale/quota/EQ_VICTIM', '/api/promo/balance/EQ_VICTIM']) {
    const r = await route({ method: 'GET', pathname: path, headers: h, nowSec: 1000 });
    assert.equal(r.status, 403, path);
    assert.equal(r.body.error.code, 'WALLET_NOT_VERIFIED');
  }
  const anon = await route({ method: 'GET', pathname: '/api/promo/balance/EQ_VICTIM', nowSec: 1000 });
  assert.equal(anon.status, 401);
  const pub = await route({ method: 'GET', pathname: '/api/user/EQ_VICTIM', headers: h, nowSec: 1000 });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.data.privateDataVisible, false);
  assert.equal(pub.body.data.promo, null);
  const intent = await route({ method: 'POST', pathname: '/api/promo/intent', body: { walletAddress: 'EQ_VICTIM' }, headers: h, nowSec: 1000 });
  assert.equal(intent.status, 403);
});

await test('user A cannot read, claim or order with user B\'s wallet (body / path wallet ignored)', async () => {
  const { route, identityStore, promoEngine, presaleEngine } = buildRouter();
  await identityStore.bindWallet('6001', 'EQ_WALLET_A', 900);
  await identityStore.bindWallet('6002', 'EQ_WALLET_B', 900);
  promoEngine.creditReward('EQ_WALLET_B', 7_000_000_000_000n);
  const hA = await tgHeaders(6001, { nowSec: 1000 });
  assert.equal((await route({ method: 'GET', pathname: '/api/promo/balance/EQ_WALLET_B', headers: hA, nowSec: 1000 })).status, 403);
  assert.equal((await route({ method: 'GET', pathname: '/api/presale/orders/EQ_WALLET_B', headers: hA, nowSec: 1000 })).status, 403);
  assert.equal((await route({ method: 'POST', pathname: '/api/presale/intent', body: { walletAddress: 'EQ_WALLET_B', gramAmount: '5' }, headers: hA, nowSec: 1000 })).status, 403);
  assert.equal((await route({ method: 'POST', pathname: '/api/promo/intent', body: { walletAddress: 'EQ_WALLET_B' }, headers: hA, nowSec: 1000 })).status, 403);
  // B's claim id is not visible to A
  const hB = await tgHeaders(6002, { nowSec: 1000 });
  const claimB = await route({ method: 'POST', pathname: '/api/promo/intent', body: {}, headers: hB, nowSec: 1000 });
  assert.equal(claimB.status, 200);
  const peek = await route({ method: 'GET', pathname: `/api/promo/claim/${claimB.body.data.claimId}`, headers: hA, nowSec: 1000 });
  assert.equal(peek.status, 404);
  // A's own order goes to A's bound wallet even with no wallet in the body
  const own = await route({ method: 'POST', pathname: '/api/presale/intent', body: { gramAmount: '5' }, headers: hA, nowSec: 1000 });
  assert.equal(own.status, 200);
  assert.equal(own.body.data.walletAddress, 'EQ_WALLET_A');
  assert.equal((await presaleEngine.listOrders('EQ_WALLET_B')).length, 0);
});

await test('repeated referral submissions keep the first-touch referrer; self-referral ignored', async () => {
  const { route, socialStore } = buildRouter();
  const h = await tgHeaders(7001, { nowSec: 1000 });
  await route({ method: 'POST', pathname: '/api/prediction/bet', body: { roundId: 1, side: 'PASS', referrerId: '7100' }, headers: h, nowSec: 1000 });
  await route({ method: 'POST', pathname: '/api/prediction/bet', body: { roundId: 2, side: 'PASS', referrerId: '7200' }, headers: h, nowSec: 1001 });
  assert.equal(socialStore.getReferrer('7001'), '7100');
  const h2 = await tgHeaders(7002, { nowSec: 1000 });
  await route({ method: 'POST', pathname: '/api/prediction/bet', body: { roundId: 1, side: 'PASS', referrerId: '7002' }, headers: h2, nowSec: 1000 });
  assert.equal(socialStore.getReferrer('7002'), null);
});

await test('non-captain cannot bind a team group; a typed @handle is reported as verifying, never bound', async () => {
  const { route, identityStore } = buildRouter();
  await identityStore.bindWallet('8001', 'EQ_CAPTAIN', 900);
  await identityStore.bindWallet('8002', 'EQ_INTRUDER', 900);
  const cap = await route({ method: 'POST', pathname: '/api/team/bind-tg', body: { teamId: 'T1', name: 'Alpha', tgGroupHandle: '@alpha' }, headers: await tgHeaders(8001, { nowSec: 1000 }), nowSec: 1000 });
  assert.equal(cap.status, 200);
  assert.equal(cap.body.data.bindStatus, 'verifying');
  assert.equal(cap.body.data.captainWallet, 'EQ_CAPTAIN');
  const intr = await route({ method: 'POST', pathname: '/api/team/bind-tg', body: { teamId: 'T1', captainWallet: 'EQ_CAPTAIN', tgGroupHandle: '@evil' }, headers: await tgHeaders(8002, { nowSec: 1000 }), nowSec: 1000 });
  assert.notEqual(intr.status, 200);
  const intr2 = await route({ method: 'POST', pathname: '/api/team/bind-tg', body: { teamId: 'T1', tgGroupHandle: '@evil' }, headers: await tgHeaders(8002, { nowSec: 1000 }), nowSec: 1000 });
  assert.notEqual(intr2.status, 200);
});

// ---------------------------------------------------------------------------
// ton_proof (acceptance item 1): StateInit, address, public key source, network, format
// ---------------------------------------------------------------------------
await test('ton_proof: 4 REAL wallet replies (v3r1/v4r2 mainnet, v4r2/v5beta testnet) verify: StateInit hash == address, key from StateInit == reported key', async () => {
  for (const v of PROOF_FIXTURES.vectors) {
    const info = await inspectWalletStateInit(v.proof.state_init);
    assert.equal(info.addressHashHex, v.address.split(':')[1], v.name);
    assert.equal(info.publicKeyHex, v.publicKey, v.name);
    const r = await verifyTonProof({
      address: v.address, network: v.network, publicKey: v.publicKey, proof: v.proof,
      expectedNetwork: v.network, allowedDomains: [v.proof.domain.value], nowSec: v.proof.timestamp,
    });
    assert.equal(r.keySource, 'state_init', v.name);
    assert.ok(['v3r1', 'v4r2', 'v5beta'].includes(r.walletVersion), v.name);
  }
  // Official @ton/ton wallet code BoCs hash to the published code hashes used for detection.
  const { parseBoc } = await import('../src/ton-cell.mjs');
  for (const k of ['v3r2', 'v4r2', 'v5r1']) {
    const [c] = parseBoc(PROOF_FIXTURES.walletCodes[k]);
    assert.equal(await c.hashHex(), PROOF_FIXTURES.expectedCodeHashes[k], k);
  }
});

await test('ton_proof negatives on real vectors: wrong network, tampered signature/payload/timestamp, swapped StateInit, wrong reported key, chain key mismatch, foreign domain', async () => {
  const [v, v2] = PROOF_FIXTURES.vectors;
  const base = { address: v.address, network: v.network, publicKey: v.publicKey, proof: v.proof, expectedNetwork: v.network, allowedDomains: [v.proof.domain.value], nowSec: v.proof.timestamp };
  const code = async (over) => { try { await verifyTonProof({ ...base, ...over }); return 'OK'; } catch (e) { return e.code; } };
  assert.equal(await code({}), 'OK');
  assert.equal(await code({ expectedNetwork: '-3' }), 'PROOF_WRONG_NETWORK');
  assert.equal(await code({ network: undefined }), 'PROOF_WRONG_NETWORK');
  assert.equal(await code({ expectedNetwork: undefined }), 'AUTH_UNCONFIGURED');
  const sig = Buffer.from(v.proof.signature, 'base64'); sig[5] ^= 1;
  assert.equal(await code({ proof: { ...v.proof, signature: sig.toString('base64') } }), 'PROOF_INVALID');
  assert.equal(await code({ proof: { ...v.proof, payload: v.proof.payload + 'x' } }), 'PROOF_INVALID');
  assert.equal(await code({ proof: { ...v.proof, timestamp: v.proof.timestamp + 1 } }), 'PROOF_INVALID');
  assert.equal(await code({ proof: { ...v.proof, state_init: v2.proof.state_init } }), 'PROOF_INVALID');
  assert.equal(await code({ proof: { ...v.proof, state_init: undefined } }), 'PROOF_INVALID');
  assert.equal(await code({ publicKey: v2.publicKey.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) }), 'PROOF_INVALID');
  assert.equal(await code({ chainPublicKeyResolver: async () => 'ab'.repeat(32) }), 'PROOF_INVALID');
  assert.equal(await code({ chainPublicKeyResolver: async () => v.publicKey }), 'OK');
  assert.equal(await code({ allowedDomains: ['a9.example'] }), 'PROOF_INVALID');
  assert.equal(await code({ nowSec: v.proof.timestamp + TON_PROOF_MAX_SKEW_SEC + 1 }), 'PROOF_EXPIRED');
  assert.equal(await code({ nowSec: v.proof.timestamp - TON_PROOF_MAX_SKEW_SEC - 1 }), 'PROOF_EXPIRED');
  assert.equal(await code({ nowSec: v.proof.timestamp + TON_PROOF_MAX_SKEW_SEC - 1 }), 'OK');
  assert.equal(TON_PROOF_MAX_SKEW_SEC, 600);
});

async function proofFlow(route, h, w, now, extra = {}) {
  const payload = (await route({ method: 'POST', pathname: '/api/auth/ton-proof/payload', headers: h, nowSec: now })).body.data.payload;
  const proof = await signTonProof(w, { payload, timestamp: now, ...(extra.sign || {}) });
  return route({ method: 'POST', pathname: '/api/auth/ton-proof/verify', body: { address: w.address, network: '-3', publicKey: w.pubHex, proof, purpose: extra.purpose }, headers: h, nowSec: now });
}

await test('ton_proof API: single-use payload, bound to the requesting Telegram user, wallet bound once; payload replay / foreign payload / wrong key / double-binding refused', async () => {
  const walletA = await makeV4R2Wallet();
  const walletB = await makeV4R2Wallet();
  for (const backend of ['memory', 'd1-sqlite']) {
    const identityStore = backend === 'memory' ? new MemoryIdentityStore() : new D1IdentityStore({ db: createSqliteD1(FRESH_SCHEMA) });
    const { route } = buildRouter({ identityStore });
    const now = 10_000;
    const hA = await tgHeaders(9001, { nowSec: now });
    const hB = await tgHeaders(9002, { nowSec: now });
    const ok = await proofFlow(route, hA, walletA, now);
    assert.equal(ok.status, 200, backend + JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, 'BOUND');
    assert.equal((await route({ method: 'GET', pathname: '/api/me', headers: hA, nowSec: now })).body.data.wallet.address, walletA.address);

    // Replay of an already consumed payload
    const p1 = (await route({ method: 'POST', pathname: '/api/auth/ton-proof/payload', headers: hA, nowSec: now })).body.data.payload;
    const proof1 = await signTonProof(walletA, { payload: p1, timestamp: now });
    const body1 = { address: walletA.address, network: '-3', publicKey: walletA.pubHex, proof: proof1 };
    assert.equal((await route({ method: 'POST', pathname: '/api/auth/ton-proof/verify', body: body1, headers: hA, nowSec: now })).status, 200);
    assert.equal((await route({ method: 'POST', pathname: '/api/auth/ton-proof/verify', body: body1, headers: hA, nowSec: now })).body.error.code, 'PROOF_INVALID');

    // Payload issued to A cannot be used by B
    const p2 = (await route({ method: 'POST', pathname: '/api/auth/ton-proof/payload', headers: hA, nowSec: now })).body.data.payload;
    const foreign = await route({ method: 'POST', pathname: '/api/auth/ton-proof/verify', body: { address: walletB.address, network: '-3', proof: await signTonProof(walletB, { payload: p2, timestamp: now }) }, headers: hB, nowSec: now });
    assert.equal(foreign.body.error.code, 'PROOF_INVALID');

    // Claiming wallet B with wallet A's private key (B's StateInit carries B's key)
    const wrongKey = await proofFlow(route, hB, walletB, now, { sign: { key: walletA.kp.privateKey } });
    assert.equal(wrongKey.body.error.code, 'PROOF_INVALID');

    // Wrong network: wallet reports mainnet while server runs testnet
    const p3 = (await route({ method: 'POST', pathname: '/api/auth/ton-proof/payload', headers: hB, nowSec: now })).body.data.payload;
    const net = await route({ method: 'POST', pathname: '/api/auth/ton-proof/verify', body: { address: walletB.address, network: '-239', proof: await signTonProof(walletB, { payload: p3, timestamp: now }) }, headers: hB, nowSec: now });
    assert.equal(net.body.error.code, 'PROOF_WRONG_NETWORK');

    // Wallet A already bound to 9001 -> 9002 cannot take it, even with a valid signature
    assert.equal((await proofFlow(route, hB, walletA, now)).status, 409);
    // The removed proof-less unbind route no longer exists
    assert.equal((await route({ method: 'POST', pathname: '/api/auth/wallet/unbind', headers: hA, nowSec: now })).status, 404);
  }
});

await test('wallet switch is delayed and cancellable by the current wallet; unbind needs the current wallet; disconnect is not unbind', async () => {
  for (const backend of ['memory', 'd1-sqlite']) {
    const walletA = await makeV4R2Wallet();
    const walletB = await makeV4R2Wallet();
    const identityStore = backend === 'memory' ? new MemoryIdentityStore() : new D1IdentityStore({ db: createSqliteD1(FRESH_SCHEMA) });
    const { route } = buildRouter({ identityStore });
    const t0 = 20_000;
    const H = (t) => tgHeaders(9101, { nowSec: t });
    const me = async (t) => (await route({ method: 'GET', pathname: '/api/me', headers: await H(t), nowSec: t })).body.data.wallet;
    assert.equal((await proofFlow(route, await H(t0), walletA, t0)).body.data.status, 'BOUND');

    // Switch request with B -> pending; A stays the active wallet
    const sw = await proofFlow(route, await H(t0 + 10), walletB, t0 + 10);
    assert.equal(sw.body.data.status, 'PENDING_REBIND');
    assert.equal((await me(t0 + 20)).address, walletA.address);
    assert.equal((await me(t0 + 20)).pendingSwitch.address, walletB.address);

    // Unbind / cancel with a proof from B (not the current wallet) is refused
    assert.equal((await proofFlow(route, await H(t0 + 30), walletB, t0 + 30, { purpose: 'unbind' })).status, 403);
    // Current wallet A cancels the switch
    assert.equal((await proofFlow(route, await H(t0 + 40), walletA, t0 + 40, { purpose: 'cancel_rebind' })).body.data.status, 'REBIND_CANCELLED');
    assert.equal((await me(t0 + REBIND_DELAY_SEC + 100)).address, walletA.address);

    // Recovery path (A lost): request again and wait the delay -> B becomes active
    const t1 = t0 + 1000;
    assert.equal((await proofFlow(route, await H(t1), walletB, t1)).body.data.status, 'PENDING_REBIND');
    assert.equal((await me(t1 + REBIND_DELAY_SEC - 1)).address, walletA.address);
    const after = await me(t1 + REBIND_DELAY_SEC);
    assert.equal(after.address, walletB.address);
    assert.equal(after.pendingSwitch, null);

    // Unbind with the current wallet (B) works
    const t2 = t1 + REBIND_DELAY_SEC + 10;
    assert.equal((await proofFlow(route, await H(t2), walletB, t2, { purpose: 'unbind' })).body.data.status, 'UNBOUND');
    assert.equal(await me(t2 + 1), null);
  }
});

await test('initData replay: a replayed (stolen) initData is valid until expiry but cannot redirect funds or rebind instantly', async () => {
  const victimWallet = await makeV4R2Wallet();
  const attackerWallet = await makeV4R2Wallet();
  const pred = new PredictionEngine({ defaultPoolA9Raw: '10000000000000' });
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT, open: true });
  const { route, promoEngine } = buildRouter({ predictionEngine: pred, presaleEngine: presale });
  const t0 = 30_000;
  const stolen = await tgHeaders(9201, { nowSec: t0 }); // captured once, replayed below
  assert.equal((await proofFlow(route, stolen, victimWallet, t0)).body.data.status, 'BOUND');
  // Attacker replays the same initData within 24h and proves THEIR wallet -> only a pending switch
  assert.equal((await proofFlow(route, stolen, attackerWallet, t0 + 3600)).body.data.status, 'PENDING_REBIND');
  // Rewards still go to the victim's bound wallet
  await completePurchase(presale, victimWallet.address, 5, t0);
  pred.placeBet({ roundId: 1, userId: '9201', side: 'PASS' }, t0);
  pred.settleRoundBets(1, true, 18, '10000000000000', t0 * 1000);
  const act = await route({ method: 'POST', pathname: '/api/prediction/activate', body: { walletAddress: attackerWallet.address }, headers: stolen, nowSec: t0 + 3700 });
  assert.equal(act.status, 403); // claimed wallet != bound wallet
  const act2 = await route({ method: 'POST', pathname: '/api/prediction/activate', body: {}, headers: stolen, nowSec: t0 + 3700 });
  assert.equal(act2.status, 200);
  assert.equal(promoEngine.getBalance(victimWallet.address).claimableRaw, '10000000000000');
  assert.equal(promoEngine.getBalance(attackerWallet.address).claimableRaw, '0');
  // The replayed initData itself stops working after 24h
  const late = await route({ method: 'GET', pathname: '/api/me', headers: stolen, nowSec: t0 + 24 * 3600 + 1 });
  assert.equal(late.body.error.code, 'AUTH_EXPIRED');
});

// ---------------------------------------------------------------------------
// A9 fixed exchange (presale) — both storage backends
// ---------------------------------------------------------------------------
await test('exact decimal money: 1.99 / 5.99 / 13.99 GRAM x 2,002 = 3,983.98 / 11,991.98 / 28,007.98 A9', async () => {
  const e = new PresaleHotWalletEngine({ hotWalletAddress: HOT });
  const cases = [['1.99', '3983.98'], ['5.99', '11991.98'], ['13.99', '28007.98'], [5.99, '11991.98'], ['200', '400400']];
  for (const [gram, a9] of cases) assert.equal(formatUnits(e.quoteA9Raw(parseDecimalUnits(gram)), 9), a9, String(gram));
  assert.equal(parseDecimalUnits('5.990000000'), 5_990_000_000n);
  for (const bad of ['5.9900000001', '-5', '1e3', 'abc', '', NaN, Infinity]) {
    assert.throws(() => parseDecimalUnits(bad), undefined, String(bad));
  }
});

for (const [name, make] of BACKENDS) {
  await test(`[${name}] min/max boundaries; 1.99 GRAM rejected under current 5 GRAM minimum; amounts stored exactly`, async () => {
    const e = await make({});
    const W = 'EQ_BOUNDS';
    await assert.rejects(e.createOrderIntent(W, '1.99', 1000), { code: 'BAD_AMOUNT' });
    await assert.rejects(e.createOrderIntent(W, '4.999999999', 1000), { code: 'BAD_AMOUNT' });
    await assert.rejects(e.createOrderIntent(W, '200.000000001', 1000), { code: 'BAD_AMOUNT' });
    const o1 = await e.createOrderIntent(W, '5.99', 1000);
    assert.equal(o1.tonNano, '5990000000');
    assert.equal(o1.a9AmountRaw, '11991980000000');
    const o2 = await e.createOrderIntent('EQ_BOUNDS_2', '13.99', 1000);
    assert.equal(o2.a9AmountRaw, '28007980000000');
    const o3 = await e.createOrderIntent('EQ_BOUNDS_3', '200', 1000);
    assert.equal(o3.tonNano, '200000000000');
    await assert.rejects(e.createOrderIntent('EQ_BOUNDS_4', '5', 1000, {}).then(() => { e.open = false; return e.createOrderIntent('EQ_BOUNDS_4', '5', 1000); }), { code: 'PRESALE_CLOSED' });
  });

  await test(`[${name}] duplicate inbound tx is a no-op; memo alone (wrong sender / wrong amount) never confirms`, async () => {
    const e = await make({});
    const o = await e.createOrderIntent('EQ_BUYER_1', '10', 1000);
    const first = await e.ingestInbound(inbound(o), 1001);
    assert.equal(first.action, 'CONFIRM');
    const again = await e.ingestInbound(inbound(o), 1002);
    assert.equal(again.action, 'REPLAY');
    assert.equal(await e.queueConfirmedPayouts(1003), 1);
    assert.equal(await e.queueConfirmedPayouts(1004), 0);
    assert.equal((await e.repo.listOpenPayouts()).length, 1);

    const o2 = await e.createOrderIntent('EQ_BUYER_2', '10', 1000);
    const thief = await e.ingestInbound(inbound(o2, { txHash: 'thief', from: 'EQ_SOMEONE_ELSE' }), 1005);
    assert.equal(thief.action, 'ANOMALY');
    assert.equal(thief.reason, 'sender_mismatch');
    assert.equal((await e.getOrder(o2.orderId)).status, PRESALE_STATUS.PENDING_PAYMENT);
    const under = await e.ingestInbound(inbound(o2, { txHash: 'under', valueNano: '9000000000' }), 1006);
    assert.equal(under.action, 'ANOMALY');
    assert.equal(under.reason, 'amount_mismatch');
    assert.equal((await e.getOrder(o2.orderId)).status, PRESALE_STATUS.PAYMENT_EXCEPTION);
    assert.equal((await e.repo.listOpenPayouts()).length, 1); // no automatic refund, no automatic fee
    const anomalies = await e.listAnomalies();
    assert.deepEqual(anomalies.map((a) => [a.txHash, a.reason, a.refundTo, a.valueNano]).sort(), [
      ['thief', 'sender_mismatch', 'EQ_SOMEONE_ELSE', '10060000000'],
      ['under', 'amount_mismatch', 'EQ_BUYER_2', '9000000000'],
    ]);
    const wrongDest = await e.planInbound(inbound(o, { txHash: 'x', to: 'EQ_OTHER_WALLET' }), 1007);
    assert.equal(wrongDest.action, 'REJECT');
    const unfinal = await e.planInbound(inbound(o, { txHash: 'y', finality: 'confirmed' }), 1007);
    assert.equal(unfinal.action, 'REJECT');
  });

  await test(`[${name}] payment confirmed but broadcast fails: order stays retryable, then completes with exactly one payout`, async () => {
    const e = await make({});
    const o = await e.createOrderIntent('EQ_RETRY', '5', 1000);
    await e.ingestInbound(inbound(o), 1001);
    await e.queueConfirmedPayouts(1002);
    let calls = 0;
    const failing = async () => { calls += 1; throw Object.assign(new Error('liteserver unavailable'), { notSent: true }); };
    const s1 = await e.processPayouts(1003, { a9Broadcaster: failing });
    assert.equal(s1.retry, 1);
    assert.equal((await e.getOrder(o.orderId)).status, PRESALE_STATUS.PAYOUT_RETRY);
    assert.equal((await e.repo.listOpenPayouts())[0].attempts, 1);
    const ok = async () => { calls += 1; return { txHash: 'out-ok' }; };
    await e.processPayouts(1004, { a9Broadcaster: ok, verifier: async () => ({ state: 'CONFIRMED' }) });
    assert.equal(calls, 2);
    const done = await e.getOrder(o.orderId);
    assert.equal(done.status, PRESALE_STATUS.COMPLETED);
    assert.equal(done.payoutTxHash, 'out-ok');
    await e.processPayouts(1005, { a9Broadcaster: ok, verifier: async () => ({ state: 'CONFIRMED' }) });
    assert.equal(calls, 2);
  });

  await test(`[${name}] ambiguous broadcast failure is never blindly re-sent (verifier or manual review)`, async () => {
    const e = await make({});
    const o = await e.createOrderIntent('EQ_AMBIG', '5', 1000);
    await e.ingestInbound(inbound(o), 1001);
    await e.queueConfirmedPayouts(1002);
    let calls = 0;
    await e.processPayouts(1003, { a9Broadcaster: async () => { calls += 1; throw new Error('timeout after submit'); } });
    // No verifier configured -> after the stale window it goes to manual review, no second send.
    await e.processPayouts(1003 + STALE_BROADCAST_SEC, { a9Broadcaster: async () => { calls += 1; return { txHash: 'dup' }; } });
    assert.equal(calls, 1);
    assert.equal((await e.getOrder(o.orderId)).status, PRESALE_STATUS.NEEDS_REVIEW);

    const e2 = await make({});
    const o2 = await e2.createOrderIntent('EQ_AMBIG_2', '5', 1000);
    await e2.ingestInbound(inbound(o2), 1001);
    await e2.queueConfirmedPayouts(1002);
    await e2.processPayouts(1003, { a9Broadcaster: async () => { throw new Error('timeout after submit'); } });
    let sends = 0;
    await e2.processPayouts(1003 + STALE_BROADCAST_SEC, {
      a9Broadcaster: async () => { sends += 1; return { txHash: 'dup' }; },
      verifier: async () => ({ state: 'CONFIRMED', txHash: 'landed-first-time' }),
    });
    assert.equal(sends, 0);
    const d2 = await e2.getOrder(o2.orderId);
    assert.equal(d2.status, PRESALE_STATUS.COMPLETED);
    assert.equal(d2.payoutTxHash, 'landed-first-time');
  });

  await test(`[${name}] dry-run runner writes nothing and never calls a broadcaster`, async () => {
    const e = await make({});
    const o = await e.createOrderIntent('EQ_DRY', '5', 1000);
    const before = await dumpOf(e);
    let calls = 0;
    const runner = new PresalePayoutRunner({
      engine: e,
      tonCenter: { fetchInboundTransfers: async () => [inbound(o), { ...inbound(o), txHash: 'refund-me', memo: 'buy:unknown', valueNano: '7000000000' }] },
      execute: false,
      a9Broadcaster: async () => { calls += 1; return { txHash: 'nope' }; },
      logger: { log: () => {} },
    });
    const s = await runner.tick(1001);
    assert.equal(s.dryRun, 2);
    assert.deepEqual(s.plans.map((p) => p.action), ['CONFIRM', 'ANOMALY']);
    assert.equal(calls, 0);
    assert.equal(await dumpOf(e), before);
    assert.equal((await e.getOrder(o.orderId)).status, PRESALE_STATUS.PENDING_PAYMENT);
  });

  await test(`[${name}] concurrent orders cannot oversell wallet quota or pool cap`, async () => {
    const e = await make({ defaultQuotaTon: 200n });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => e.createOrderIntent('EQ_RUSH', '50', 1000)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 4);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'OVER_QUOTA'));

    const pool = await make({ totalCapA9Raw: 3n * 10n * 2002n * 1_000_000_000n });
    const res2 = await Promise.allSettled(['EQ_P1', 'EQ_P2', 'EQ_P3', 'EQ_P4', 'EQ_P5'].map((w) => pool.createOrderIntent(w, '10', 1000)));
    assert.equal(res2.filter((r) => r.status === 'fulfilled').length, 3);
    // Unpaid reservations expire and free capacity again.
    const later = 1000 + 31 * 60;
    await pool.createOrderIntent('EQ_P6', '10', later);
  });

  await test(`[${name}] expired order paid late -> passive refund minus 0.03 GRAM gas; refund broadcast failure retries then confirms`, async () => {
    const e = await make({});
    const o = await e.createOrderIntent('EQ_LATE', '5', 1000);
    const late = await e.ingestInbound(inbound(o), 1000 + 31 * 60);
    assert.equal(late.action, 'REFUND');
    assert.equal(late.reason, 'expired');
    assert.equal(late.refundNano, 5_030_000_000n);
    const t = 1000 + 32 * 60;
    let n = 0;
    const flaky = async (inst) => { n += 1; if (n === 1) throw Object.assign(new Error('rpc down'), { notSent: true }); assert.equal(inst.tonNano, '5030000000'); return { txHash: 'refund-tx' }; };
    await e.processPayouts(t, { refundBroadcaster: flaky });
    assert.equal((await e.getOrder(o.orderId)).status, PRESALE_STATUS.REFUND_PENDING);
    await e.processPayouts(t + 1, { refundBroadcaster: flaky });
    assert.equal((await e.getOrder(o.orderId)).status, PRESALE_STATUS.REFUND_SENT);
    await e.processPayouts(t + 2, { refundBroadcaster: flaky, verifier: async () => ({ state: 'CONFIRMED' }) });
    assert.equal((await e.getOrder(o.orderId)).status, PRESALE_STATUS.REFUNDED);
    assert.equal(n, 2);
  });

  await test(`[${name}] anomaly resolution (P0-D): 0.03 GRAM base refund gas deducted for USER/SYSTEM/UNKNOWN; higher userFaultFeeNano applies only to USER; resolves once`, async () => {
    const e = await make({});
    const o = await e.createOrderIntent('EQ_ANOM', '10', 1000);
    await e.ingestInbound(inbound(o, { txHash: 'short', valueNano: '9000000000' }), 1001);
    await e.ingestInbound({ txHash: 'stray', finality: 'finalized', to: HOT, from: 'EQ_STRANGER', valueNano: '3000000000', memo: 'hello' }, 1002);
    await e.ingestInbound({ txHash: 'user-nofee', finality: 'finalized', to: HOT, from: 'EQ_USER_FAULT', valueNano: '4000000000', memo: '' }, 1002);
    await e.ingestInbound({ txHash: 'unk-nofee', finality: 'finalized', to: HOT, from: 'EQ_UNK_FAULT', valueNano: '2000000000', memo: '' }, 1002);
    // 缺少操作人仍拒绝
    await assert.rejects(e.resolveAnomaly('short', { decision: 'REFUND', faultParty: 'SYSTEM' }, 1003), { code: 'BAD_REQUEST' });
    // 未配置额外 userFaultFeeNano 时，USER / SYSTEM / UNKNOWN 三种责任方均扣除 0.03 GRAM 链上退回 Gas 成本
    const uRes = await e.resolveAnomaly('user-nofee', { decision: 'REFUND', faultParty: 'USER', operator: 'ops', note: 'base refund gas' }, 1003);
    assert.equal(uRes.feeNano, '30000000');
    assert.equal(uRes.refundNano, '3970000000');
    const unkRes = await e.resolveAnomaly('unk-nofee', { decision: 'REFUND', faultParty: 'UNKNOWN', operator: 'ops', note: 'unknown' }, 1003);
    assert.equal(unkRes.feeNano, '30000000');
    assert.equal(unkRes.refundNano, '1970000000');

    const both = await Promise.allSettled([
      e.resolveAnomaly('short', { decision: 'REFUND', faultParty: 'SYSTEM', operator: 'ops', note: 'system' }, 1004),
      e.resolveAnomaly('short', { decision: 'REFUND', faultParty: 'SYSTEM', operator: 'ops2', note: 'dup' }, 1004),
    ]);
    assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(both.find((r) => r.status === 'fulfilled').value.refundNano, '8970000000');
    assert.equal((await e.getOrder(o.orderId)).status, PRESALE_STATUS.REFUND_PENDING);
    const shortRefund = await e.repo.getPayout('refund:short');
    assert.equal(shortRefund.recipient, 'EQ_ANOM');
    assert.equal(shortRefund.amount, '8970000000');

    // 配置更高 userFaultFeeNano (0.05 GRAM) 后：仅 USER 扣 0.05 GRAM，SYSTEM 与 UNKNOWN 仅扣 0.03 GRAM 链上退回 Gas
    const published = await make({ userFaultFeeNano: '50000000' });
    await published.ingestInbound({ txHash: 'stray2', finality: 'finalized', to: HOT, from: 'EQ_STRANGER', valueNano: '3000000000', memo: '' }, 1002);
    await published.ingestInbound({ txHash: 'stray-sys', finality: 'finalized', to: HOT, from: 'EQ_SYS', valueNano: '3000000000', memo: '' }, 1002);
    await published.ingestInbound({ txHash: 'stray-unk', finality: 'finalized', to: HOT, from: 'EQ_UNK', valueNano: '3000000000', memo: '' }, 1002);
    const r = await published.resolveAnomaly('stray2', { decision: 'REFUND', faultParty: 'USER', operator: 'ops', note: 'no memo' }, 1005);
    assert.equal(r.feeNano, '50000000');
    assert.equal(r.refundNano, '2950000000');
    assert.equal(r.recipient, 'EQ_STRANGER');
    const rSys = await published.resolveAnomaly('stray-sys', { decision: 'REFUND', faultParty: 'SYSTEM', operator: 'ops' }, 1005);
    assert.equal(rSys.feeNano, '30000000');
    assert.equal(rSys.refundNano, '2970000000');
    const rUnk = await published.resolveAnomaly('stray-unk', { decision: 'REFUND', faultParty: 'UNKNOWN', operator: 'ops' }, 1005);
    assert.equal(rUnk.feeNano, '30000000');
    assert.equal(rUnk.refundNano, '2970000000');
    await assert.rejects(published.resolveAnomaly('stray2', { decision: 'REFUND', faultParty: 'SYSTEM', operator: 'ops' }, 1006), { code: 'ALREADY_RESOLVED' });
    await assert.rejects(e.resolveAnomaly('stray', { decision: 'CLOSE_NO_REFUND', faultParty: 'UNKNOWN', operator: 'ops' }, 1007), { code: 'BAD_REQUEST' });
    assert.equal((await e.resolveAnomaly('stray', { decision: 'CLOSE_NO_REFUND', faultParty: 'UNKNOWN', operator: 'ops', note: 'refunded off-band tx X' }, 1007)).status, 'CLOSED_NO_REFUND');
  });

  await test(`[${name}] referral reward booked once; crash while crediting goes to review, never double-credits`, async () => {
    const promo = new PromoHotWalletEngine({ hotWalletAddress: HOT });
    const e = await make({ promoEngine: promo });
    const o = await e.createOrderIntent('EQ_REFBUY', '10', 1000, { referrerId: 'EQ_INVITER' });
    await e.ingestInbound(inbound(o), 1001);
    await e.queueConfirmedPayouts(1002);
    await e.processPayouts(1003, { a9Broadcaster: async () => ({ txHash: 'p' }) });
    await e.processReferralCredits(1004);
    assert.equal(promo.getBalance('EQ_INVITER').claimableRaw, '0'); // only PAYOUT_SENT so far
    await e.processPayouts(1005, { verifier: async () => ({ state: 'CONFIRMED' }) });
    await e.processReferralCredits(1006);
    await e.processReferralCredits(1007);
    assert.equal(promo.getBalance('EQ_INVITER').claimableRaw, String((10n * 2002n * 1_000_000_000n * 12n) / 100n));

    const crashing = { creditReward: () => { throw new Error('crash mid-credit'); } };
    const e2 = await make({ promoEngine: crashing });
    const o2 = await e2.createOrderIntent('EQ_REFBUY2', '10', 1000, { referrerId: 'EQ_INVITER2' });
    await completePurchase(e2, 'EQ_FILLER', '5', 999).catch(() => {});
    await e2.ingestInbound(inbound(o2), 1001);
    await e2.queueConfirmedPayouts(1002);
    await e2.processPayouts(1003, { a9Broadcaster: async () => ({ txHash: 'p2' }), verifier: async () => ({ state: 'CONFIRMED' }) });
    await e2.processReferralCredits(1004).catch(() => {});
    const promo2 = new PromoHotWalletEngine({ hotWalletAddress: HOT });
    await e2.processReferralCredits(1005, { promoEngine: promo2 });
    assert.equal(promo2.getBalance('EQ_INVITER2').claimableRaw, '0');
    assert.equal((await e2.getReferralCredit(o2.orderId)).status, 'NEEDS_REVIEW');
  });

  // -------------------------------------------------------------------------
  // P0-A (D3): PresalePayoutRunner.tick() 全入账分类与防重放（不静默丢弃、不误归推广交易、有效领取单不能掩盖错额/错人/异钱包/过期转账）
  // -------------------------------------------------------------------------
  await test(`[${name}] P0-A: PresalePayoutRunner.tick() classifies all inbound types and never lets a valid promo claim mask wrong-amount/wrong-sender/wrong-wallet/expired transfers`, async () => {
    const promo = new PromoHotWalletEngine({ hotWalletAddress: HOT });
    promo.creditReward('EQ_PROMO_USER', '5000000000000');
    const claim = promo.createClaimIntent('EQ_PROMO_USER', 1000);
    // 再构造一个已完成（已消费另一笔 txHash）和一个已过期的推广领取单，用于验证旧单号不能掩盖新入账
    promo.creditReward('EQ_PROMO_DONE', '5000000000000');
    const claimDone = promo.createClaimIntent('EQ_PROMO_DONE', 900);
    promo.verifyInboundFeeTx({ txHash: 'promo-already-consumed', finality: 'finalized', to: HOT, from: 'EQ_PROMO_DONE', valueNano: '60000000', memo: claimDone.memo }, 905);
    promo.creditReward('EQ_PROMO_EXP', '5000000000000');
    const claimExp = promo.createClaimIntent('EQ_PROMO_EXP', 10); // 10 + 900 = 910 < 1010 已过期

    const e = await make({ promoEngine: promo });
    const validOrder = await e.createOrderIntent('EQ_VALID', '10', 1000);
    const wrongAmtOrder = await e.createOrderIntent('EQ_BADAMT', '10', 1000);
    const wrongSenderOrder = await e.createOrderIntent('EQ_OWNER_A', '10', 1000);
    const doneOrder = await completePurchase(e, 'EQ_DONE', '5', 900, { txHash: 'done-first' });

    const txs = [
      { txHash: 'tx-valid', finality: 'finalized', to: HOT, from: 'EQ_VALID', valueNano: validOrder.payTonNano, memo: validOrder.memo },
      { txHash: 'tx-nomemo', finality: 'finalized', to: HOT, from: 'EQ_NO_MEMO', valueNano: '7000000000', memo: '' },
      { txHash: 'tx-badmemo', finality: 'finalized', to: HOT, from: 'EQ_BAD_MEMO', valueNano: '6000000000', memo: 'hello-world' },
      { txHash: 'tx-badorder', finality: 'finalized', to: HOT, from: 'EQ_BAD_ORD', valueNano: '5000000000', memo: 'buy:doesnotexist' },
      { txHash: 'tx-wrongsender', finality: 'finalized', to: HOT, from: 'EQ_THIEF_B', valueNano: wrongSenderOrder.tonNano, memo: wrongSenderOrder.memo },
      { txHash: 'tx-wrongamt', finality: 'finalized', to: HOT, from: 'EQ_BADAMT', valueNano: '8000000000', memo: wrongAmtOrder.memo },
      { txHash: 'tx-dup', finality: 'finalized', to: HOT, from: 'EQ_DONE', valueNano: doneOrder.tonNano, memo: doneOrder.memo },
      // 合法推广费（同钱包、本人、精确 0.06 GRAM、未过期 PENDING_FEE）-> OTHER_FLOW
      { txHash: 'tx-promo-valid', finality: 'finalized', to: HOT, from: 'EQ_PROMO_USER', valueNano: '60000000', memo: claim.memo },
      // 同一笔 txHash 已被推广侧先消费 -> OTHER_FLOW（避免先后扫描误报）
      { txHash: 'promo-already-consumed', finality: 'finalized', to: HOT, from: 'EQ_PROMO_DONE', valueNano: '60000000', memo: claimDone.memo },
      // 反例 1：合法领取单号 + 8 GRAM 错误大额付款 -> 必须进 ANOMALY，绝不能归为 OTHER_FLOW
      { txHash: 'tx-valid-claim-8gram', finality: 'finalized', to: HOT, from: 'EQ_PROMO_USER', valueNano: '8000000000', memo: claim.memo },
      // 反例 2：合法领取单号 + 错付款人转 8 GRAM -> 必须进 ANOMALY
      { txHash: 'tx-valid-claim-wrong-sender', finality: 'finalized', to: HOT, from: 'EQ_STRANGER_Z', valueNano: '8000000000', memo: claim.memo },
      // 反例 3：已消费的旧领取单号 + 新交易 8 GRAM -> 必须进 ANOMALY
      { txHash: 'tx-done-claim-new-8gram', finality: 'finalized', to: HOT, from: 'EQ_PROMO_DONE', valueNano: '8000000000', memo: claimDone.memo },
      // 反例 4：已过期的领取单号 + 8 GRAM -> 必须进 ANOMALY
      { txHash: 'tx-expired-claim-8gram', finality: 'finalized', to: HOT, from: 'EQ_PROMO_EXP', valueNano: '8000000000', memo: claimExp.memo },
      // 反例 5：不存在的领取单号 + 8 GRAM -> 必须进 ANOMALY
      { txHash: 'tx-fake-claim-large', finality: 'finalized', to: HOT, from: 'EQ_MISTAKE', valueNano: '8000000000', memo: 'claim:nonexistent' },
      { txHash: 'tx-dust', finality: 'finalized', to: HOT, from: 'EQ_DUST', valueNano: '100000000', memo: '' },
    ];
    let a9Sends = 0;
    const runner = new PresalePayoutRunner({
      engine: e,
      tonCenter: { fetchInboundTransfers: async () => txs },
      execute: true,
      a9Broadcaster: async () => { a9Sends += 1; return { txHash: `a9-out-${a9Sends}` }; },
      payoutVerifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }),
      logger: { log() {} },
    });

    const s1 = await runner.tick(1010);
    assert.equal(s1.confirmed, 1);
    assert.equal(s1.anomalies, 11);
    assert.equal(s1.otherFlow, 2);
    assert.equal(s1.dust, 1);
    assert.equal(s1.paid, 1);
    assert.equal(s1.completed, 1);
    assert.equal(a9Sends, 1);

    const promoRec = await e.repo.getInbound('tx-promo-valid');
    assert.equal(promoRec.decision, 'OTHER_FLOW');
    assert.equal(promoRec.reason, 'promo_claim');
    assert.equal(promoRec.anomalyStatus, null);
    assert.equal((await e.repo.getInbound('promo-already-consumed')).decision, 'OTHER_FLOW');
    const dustRec = await e.repo.getInbound('tx-dust');
    assert.equal(dustRec.decision, 'IGNORE_DUST');
    const anomalies = await e.listAnomalies('OPEN');
    assert.equal(anomalies.length, 11);
    for (const mustBeAnomaly of ['tx-valid-claim-8gram', 'tx-valid-claim-wrong-sender', 'tx-done-claim-new-8gram', 'tx-expired-claim-8gram', 'tx-fake-claim-large', 'tx-nomemo']) {
      assert.equal(anomalies.some((a) => a.txHash === mustBeAnomaly), true, `${mustBeAnomaly} must be in OPEN anomalies`);
    }
    assert.equal(anomalies.some((a) => a.txHash === 'tx-promo-valid'), false);
    // 确认合法领取单号误转 8 GRAM 可以正常走人工退款（扣除 0.03 GRAM 链上退回 Gas）
    const res8g = await e.resolveAnomaly('tx-valid-claim-8gram', { decision: 'REFUND', faultParty: 'USER', operator: 'ops' }, 1015);
    assert.equal(res8g.status, 'REFUND_QUEUED');
    assert.equal(res8g.refundNano, '7970000000');

    // 反例 6：推广钱包与兑换钱包已分离，有效领取单打到兑换热钱包（8 GRAM 与 0.06 GRAM）均绝不能归类为 OTHER_FLOW
    const separatePromo = new PromoHotWalletEngine({ hotWalletAddress: 'EQ_SEPARATE_PROMO_WALLET' });
    separatePromo.creditReward('EQ_SEP_USER', '5000000000000');
    const sepClaim = separatePromo.createClaimIntent('EQ_SEP_USER', 1000);
    const eSep = await make({ promoEngine: separatePromo });
    const sepLarge = await eSep.ingestInbound({ txHash: 'tx-sep-8gram', finality: 'finalized', to: HOT, from: 'EQ_SEP_USER', valueNano: '8000000000', memo: sepClaim.memo }, 1010);
    assert.equal(sepLarge.action, 'ANOMALY');
    assert.equal((await eSep.listAnomalies('OPEN')).some((a) => a.txHash === 'tx-sep-8gram'), true);
    const sepSmall = await eSep.ingestInbound({ txHash: 'tx-sep-006gram', finality: 'finalized', to: HOT, from: 'EQ_SEP_USER', valueNano: '60000000', memo: sepClaim.memo }, 1011);
    assert.equal(sepSmall.action, 'IGNORE_DUST');

    // 重复扫描全部交易 -> 零重复记录、零重复发币
    const s2 = await runner.tick(1020);
    assert.equal(s2.confirmed, 0);
    assert.equal(s2.anomalies, 0);
    assert.equal(s2.paid, 0);
    assert.equal(s2.ignored, txs.length);
    assert.equal(a9Sends, 1);
    assert.equal((await e.listAnomalies('OPEN')).length, 10);
  });

  // -------------------------------------------------------------------------
  // P0-B (D1 + D2) & P0-C (D4): 异常退款所有权隔离、已完成订单不可变、多笔异常退款并发/独立处理
  // -------------------------------------------------------------------------
  await test(`[${name}] P0-B & P0-C: B/C wrong-payer refunds never touch A's order or quota; duplicate refund never alters COMPLETED order`, async () => {
    const e = await make({ defaultQuotaTon: 20n });
    const aOrder = await e.createOrderIntent('EQ_USER_A', '10', 1000);
    assert.equal((await e.getQuota('EQ_USER_A', 1000)).usedQuotaNano, '10000000000');

    // B 和 C 两人分别错用 A 的订单号付款
    const bIn = await e.ingestInbound({ txHash: 'b-wrong', finality: 'finalized', to: HOT, from: 'EQ_USER_B', valueNano: aOrder.payTonNano, memo: aOrder.memo }, 1001);
    const cIn = await e.ingestInbound({ txHash: 'c-wrong', finality: 'finalized', to: HOT, from: 'EQ_USER_C', valueNano: aOrder.payTonNano, memo: aOrder.memo }, 1002);
    assert.equal(bIn.action, 'ANOMALY');
    assert.equal(cIn.action, 'ANOMALY');

    // 两笔误付均独立审核退款成功（扣 0.03 GRAM 链上退回 Gas），且 A 的订单和额度丝毫不受影响
    const rB = await e.resolveAnomaly('b-wrong', { decision: 'REFUND', faultParty: 'UNKNOWN', operator: 'ops' }, 1003);
    const rC = await e.resolveAnomaly('c-wrong', { decision: 'REFUND', faultParty: 'USER', operator: 'ops' }, 1004);
    assert.equal(rB.status, 'REFUND_QUEUED');
    assert.equal(rC.status, 'REFUND_QUEUED');
    assert.equal(rB.refundNano, '10030000000');
    assert.equal(rC.refundNano, '10030000000');
    assert.equal((await e.repo.getPayout('refund:b-wrong')).orderId, null);
    assert.equal((await e.repo.getPayout('refund:c-wrong')).orderId, null);

    // 同一笔入账二次 resolve 必须被拒绝
    await assert.rejects(e.resolveAnomaly('b-wrong', { decision: 'REFUND', faultParty: 'SYSTEM', operator: 'ops' }, 1004), { code: 'ALREADY_RESOLVED' });

    // 执行 B 和 C 的退款广播与链上确认（含模拟 B 首次广播失败进入重试）
    let refundAttempt = 0;
    await e.processPayouts(1005, {
      refundBroadcaster: async (inst) => {
        refundAttempt += 1;
        if (inst.payoutId === 'refund:b-wrong' && refundAttempt === 1) throw Object.assign(new Error('rpc hiccup'), { notSent: true });
        return { txHash: `rf-${inst.payoutId}` };
      },
      verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }),
    });
    await e.processPayouts(1006, {
      refundBroadcaster: async (inst) => ({ txHash: `rf-${inst.payoutId}` }),
      verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }),
    });
    assert.equal((await e.repo.getPayout('refund:b-wrong')).status, 'CONFIRMED');
    assert.equal((await e.repo.getPayout('refund:c-wrong')).status, 'CONFIRMED');

    // 验证 A 的订单仍为 PENDING_PAYMENT，额度仍精确占用 10 GRAM，随后 A 仍能正常付款成交
    assert.equal((await e.getOrder(aOrder.orderId)).status, PRESALE_STATUS.PENDING_PAYMENT);
    assert.equal((await e.getQuota('EQ_USER_A', 1007)).usedQuotaNano, '10000000000');
    const aPay = await e.ingestInbound({ txHash: 'a-real-pay', finality: 'finalized', to: HOT, from: 'EQ_USER_A', valueNano: aOrder.payTonNano, memo: aOrder.memo }, 1008);
    assert.equal(aPay.action, 'CONFIRM');
    await e.queueConfirmedPayouts(1009);
    await e.processPayouts(1010, { a9Broadcaster: async () => ({ txHash: 'a9-for-a' }), verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }) });
    assert.equal((await e.getOrder(aOrder.orderId)).status, PRESALE_STATUS.COMPLETED);
    assert.equal(await e.hasCompletedPurchase('EQ_USER_A'), true);

    // D2: A 的订单已经 COMPLETED，再次收到两笔重复付款（来自 A 和 B），退款或 NEEDS_REVIEW 均不改动 A 订单
    await e.ingestInbound({ txHash: 'dup-by-a', finality: 'finalized', to: HOT, from: 'EQ_USER_A', valueNano: aOrder.payTonNano, memo: aOrder.memo }, 1020);
    await e.ingestInbound({ txHash: 'dup-by-b', finality: 'finalized', to: HOT, from: 'EQ_USER_B', valueNano: aOrder.payTonNano, memo: aOrder.memo }, 1021);
    await e.resolveAnomaly('dup-by-a', { decision: 'REFUND', faultParty: 'UNKNOWN', operator: 'ops' }, 1022);
    await e.resolveAnomaly('dup-by-b', { decision: 'REFUND', faultParty: 'SYSTEM', operator: 'ops' }, 1023);
    await e.processPayouts(1024, {
      refundBroadcaster: async (inst) => {
        if (inst.payoutId === 'refund:dup-by-b') throw new Error('ambiguous timeout');
        return { txHash: 'rf-dup-a' };
      },
      verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }),
    });
    await e.processPayouts(1024 + STALE_BROADCAST_SEC, { verifier: null });
    assert.equal((await e.repo.getPayout('refund:dup-by-a')).status, 'CONFIRMED');
    assert.equal((await e.repo.getPayout('refund:dup-by-b')).status, 'NEEDS_REVIEW');
    assert.equal((await e.getOrder(aOrder.orderId)).status, PRESALE_STATUS.COMPLETED);
    assert.equal(await e.hasCompletedPurchase('EQ_USER_A'), true);
    assert.equal((await e.getQuota('EQ_USER_A', 1200)).usedQuotaNano, '10000000000');

    // 错额订单叠加第二笔误付：退第二笔不改订单，退错额本人这笔才将 PAYMENT_EXCEPTION -> REFUNDED
    const oExc = await e.createOrderIntent('EQ_EXC', '10', 1300);
    await e.ingestInbound({ txHash: 'exc-short', finality: 'finalized', to: HOT, from: 'EQ_EXC', valueNano: '9000000000', memo: oExc.memo }, 1301);
    assert.equal((await e.getOrder(oExc.orderId)).status, PRESALE_STATUS.PAYMENT_EXCEPTION);
    assert.equal((await e.getQuota('EQ_EXC', 1302)).usedQuotaNano, '0');
    await e.ingestInbound({ txHash: 'exc-stray', finality: 'finalized', to: HOT, from: 'EQ_OTHER', valueNano: '10000000000', memo: oExc.memo }, 1303);
    await e.resolveAnomaly('exc-stray', { decision: 'REFUND', faultParty: 'UNKNOWN', operator: 'ops' }, 1304);
    await e.processPayouts(1305, { refundBroadcaster: async () => ({ txHash: 'rf-exc-stray' }), verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }) });
    assert.equal((await e.getOrder(oExc.orderId)).status, PRESALE_STATUS.PAYMENT_EXCEPTION);
    await e.resolveAnomaly('exc-short', { decision: 'REFUND', faultParty: 'SYSTEM', operator: 'ops' }, 1306);
    assert.equal((await e.getOrder(oExc.orderId)).status, PRESALE_STATUS.REFUND_PENDING);
    await e.processPayouts(1307, { refundBroadcaster: async () => ({ txHash: 'rf-exc-short' }), verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }) });
    assert.equal((await e.getOrder(oExc.orderId)).status, PRESALE_STATUS.REFUNDED);
  });

  // -------------------------------------------------------------------------
  // P0-I: 过期与到账时间竞争守卫 + NEEDS_REVIEW 不可被自动恢复误处理 + 账本守恒不变量
  // -------------------------------------------------------------------------
  await test(`[${name}] P0-I: expiry-vs-arrival race cannot oversell pool; NEEDS_REVIEW is never auto-retried; ledger balances exactly`, async () => {
    const pool = await make({ totalCapA9Raw: 10n * 2002n * 1_000_000_000n });
    const oA = await pool.createOrderIntent('EQ_RACE_A', '10', 1000);
    const oB = await pool.createOrderIntent('EQ_RACE_B', '10', 2801);
    assert.ok(oB.orderId);
    const raceRes = await pool.repo.commitInbound({
      inbound: { txHash: 'late-race-a', orderId: oA.orderId, sender: 'EQ_RACE_A', valueNano: oA.tonNano, memo: oA.memo, decision: 'CONFIRM', reason: 'valid', createdAt: 2801 },
      orderUpdate: { orderId: oA.orderId, from: [PRESALE_STATUS.PENDING_PAYMENT], notExpiredAt: 2801, patch: { status: PRESALE_STATUS.PAYMENT_CONFIRMED, inboundTxHash: 'late-race-a', updatedAt: 2801 } },
      payout: null,
    });
    assert.equal(raceRes, 'ORDER_RACE');
    assert.equal((await pool.getOrder(oA.orderId)).status, PRESALE_STATUS.PENDING_PAYMENT);
    const raceAnom = await pool.repo.getInbound('late-race-a');
    assert.equal(raceAnom.decision, 'ANOMALY');
    assert.equal(raceAnom.anomalyStatus, 'OPEN');

    const e2 = await make({});
    const oRev = await e2.createOrderIntent('EQ_REV', '5', 1000);
    await e2.ingestInbound(inbound(oRev), 1001);
    await e2.queueConfirmedPayouts(1002);
    let sends = 0;
    await e2.processPayouts(1003, { a9Broadcaster: async () => { sends += 1; throw new Error('ambiguous'); } });
    await e2.processPayouts(1003 + STALE_BROADCAST_SEC, { verifier: null });
    assert.equal((await e2.getOrder(oRev.orderId)).status, PRESALE_STATUS.NEEDS_REVIEW);
    assert.equal(sends, 1);
    const runner = new PresalePayoutRunner({
      engine: e2,
      tonCenter: { fetchInboundTransfers: async () => [] },
      execute: true,
      a9Broadcaster: async () => { sends += 1; return { txHash: 'should-not-send' }; },
      payoutVerifier: async () => ({ state: 'CONFIRMED' }),
      logger: { log() {} },
    });
    await runner.tick(5000);
    await runner.tick(6000);
    assert.equal(sends, 1);
    assert.equal((await e2.getOrder(oRev.orderId)).status, PRESALE_STATUS.NEEDS_REVIEW);

    // 账本守恒不变量
    const e3 = await make({ userFaultFeeNano: '50000000' });
    const oOk = await completePurchase(e3, 'EQ_CON_1', '10', 1000, { txHash: 'c-ok' });
    await e3.ingestInbound({ txHash: 'c-dup', finality: 'finalized', to: HOT, from: 'EQ_CON_2', valueNano: '8000000000', memo: oOk.memo }, 1010);
    await e3.resolveAnomaly('c-dup', { decision: 'REFUND', faultParty: 'USER', operator: 'ops' }, 1011);
    await e3.processPayouts(1012, { refundBroadcaster: async () => ({ txHash: 'rf-c-dup' }), verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }) });
    await e3.ingestInbound({ txHash: 'c-offband', finality: 'finalized', to: HOT, from: 'EQ_CON_3', valueNano: '6000000000', memo: '' }, 1013);
    await e3.resolveAnomaly('c-offband', { decision: 'CLOSE_NO_REFUND', faultParty: 'UNKNOWN', operator: 'ops', note: 'off-band refunded' }, 1014);
    await e3.ingestInbound({ txHash: 'c-open', finality: 'finalized', to: HOT, from: 'EQ_CON_4', valueNano: '4000000000', memo: 'bad' }, 1015);
    await e3.ingestInbound({ txHash: 'c-dust', finality: 'finalized', to: HOT, from: 'EQ_CON_5', valueNano: '50000000', memo: '' }, 1016);

    const totalIn = 10_060_000_000n + 8_000_000_000n + 6_000_000_000n + 4_000_000_000n + 50_000_000n;
    const okOrd = await e3.getOrder(oOk.orderId);
    const completedGram = BigInt(okOrd.tonNano) + BigInt(okOrd.deliveryFeeNano);
    const refundedGram = BigInt((await e3.repo.getPayout('refund:c-dup')).amount);
    const feeGram = BigInt((await e3.repo.getInbound('c-dup')).feeNano);
    const closedNoRefundGram = BigInt((await e3.repo.getInbound('c-offband')).valueNano);
    const pendingAnomGram = BigInt((await e3.repo.getInbound('c-open')).valueNano);
    const dustGram = BigInt((await e3.repo.getInbound('c-dust')).valueNano);
    assert.equal(completedGram + refundedGram + feeGram + closedNoRefundGram + pendingAnomGram + dustGram, totalIn);
  });
}

await test('[d1-sqlite] restart after broadcast: new process resumes from DB, confirms without re-sending', async () => {
  const db = createSqliteD1(FRESH_SCHEMA);
  const e1 = new D1PresaleStore({ db, hotWalletAddress: HOT, open: true });
  const o = await e1.createOrderIntent('EQ_RESTART', '5', 1000);
  await e1.ingestInbound(inbound(o), 1001);
  await e1.queueConfirmedPayouts(1002);
  await e1.processPayouts(1003, { a9Broadcaster: async () => ({ txHash: 'sent-before-crash' }) });
  assert.equal((await e1.getOrder(o.orderId)).status, PRESALE_STATUS.PAYOUT_SENT);

  const e2 = new D1PresaleStore({ db, hotWalletAddress: HOT, open: true });
  let resend = 0;
  await e2.processPayouts(1010, { a9Broadcaster: async () => { resend += 1; return { txHash: 'x' }; }, verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }) });
  assert.equal(resend, 0);
  assert.equal((await e2.getOrder(o.orderId)).status, PRESALE_STATUS.COMPLETED);

  // Crash between "BROADCASTING" persisted and broadcast result recorded
  const o2 = await e2.createOrderIntent('EQ_RESTART_2', '5', 2000);
  await e2.ingestInbound(inbound(o2), 2001);
  await e2.queueConfirmedPayouts(2002);
  const [p] = await e2.repo.listOpenPayouts();
  assert.ok(await e2.repo.claimPayout(p.payoutId, ['PENDING'], { status: 'BROADCASTING', attempts: 1, updatedAt: 2003 }));
  const e3 = new D1PresaleStore({ db, hotWalletAddress: HOT, open: true });
  let sends = 0;
  const bc = async () => { sends += 1; return { txHash: 'resent' }; };
  await e3.processPayouts(2010, { a9Broadcaster: bc, verifier: async () => ({ state: 'NOT_FOUND' }) });
  assert.equal(sends, 0);
  await e3.processPayouts(2003 + STALE_BROADCAST_SEC, { a9Broadcaster: bc, verifier: async (q) => (q.txHash ? { state: 'CONFIRMED' } : { state: 'NOT_FOUND' }) });
  assert.equal(sends, 1);
  assert.equal((await e3.getOrder(o2.orderId)).status, PRESALE_STATUS.COMPLETED);
});

// ---------------------------------------------------------------------------
// P0-E: 退款确认原子性与各关键写入点崩溃恢复测试
// ---------------------------------------------------------------------------
await test('[d1-sqlite] P0-E: refund confirmation is atomic; crash at every write point recovers without double-send or orphaned state', async () => {
  const rawDb = createSqliteD1(FRESH_SCHEMA);
  let failRefundOrderCommitOnce = false;
  const flakyDb = {
    prepare: (sql) => rawDb.prepare(sql),
    exec: (sql) => rawDb.exec(sql),
    async batch(stmts) {
      if (failRefundOrderCommitOnce && stmts.some((s) => /UPDATE presale_orders SET status = 'REFUNDED'/.test(s._sql))) {
        failRefundOrderCommitOnce = false;
        const sabotaged = [stmts[0], rawDb.prepare('UPDATE __nonexistent_crash_table SET x = 1')];
        return rawDb.batch(sabotaged);
      }
      return rawDb.batch(stmts);
    },
  };

  const e1 = new D1PresaleStore({ db: flakyDb, hotWalletAddress: HOT, open: true });
  const untouched = await e1.createOrderIntent('EQ_INNOCENT', '10', 1000);

  const oLate = await e1.createOrderIntent('EQ_CRASH_REFUND', '5', 1000);
  await e1.ingestInbound(inbound(oLate), 1000 + 31 * 60);
  assert.equal((await e1.getOrder(oLate.orderId)).status, PRESALE_STATUS.REFUND_PENDING);

  // 崩溃点 1：BROADCASTING 落库后、广播前崩溃（钱尚未发出）
  const pId = `refund:in-${oLate.orderId}`;
  assert.ok(await e1.repo.claimPayout(pId, ['PENDING'], { status: 'BROADCASTING', attempts: 1, updatedAt: 3000 }));
  const eAfterCrash1 = new D1PresaleStore({ db: flakyDb, hotWalletAddress: HOT, open: true });
  let refundSends = 0;
  await eAfterCrash1.processPayouts(3010, { refundBroadcaster: async () => { refundSends += 1; return { txHash: 'x' }; }, verifier: async () => ({ state: 'NOT_FOUND' }) });
  assert.equal(refundSends, 0);
  assert.equal((await eAfterCrash1.getOrder(oLate.orderId)).status, PRESALE_STATUS.REFUND_PENDING);

  // 超时后 verifier=NOT_FOUND -> 广播 1 次并进入 SENT
  await eAfterCrash1.processPayouts(3000 + STALE_BROADCAST_SEC, {
    refundBroadcaster: async () => { refundSends += 1; return { txHash: 'rf-tx-1' }; },
    verifier: async (p) => (p.txHash ? { state: 'PENDING' } : { state: 'NOT_FOUND' }),
  });
  assert.equal(refundSends, 1);
  assert.equal((await eAfterCrash1.getOrder(oLate.orderId)).status, PRESALE_STATUS.REFUND_SENT);

  // 崩溃点 4：在确认退款提交 completeRefund 时第二条语句崩溃 -> 整批回滚，绝不产生孤儿态
  failRefundOrderCommitOnce = true;
  const sCrash = await eAfterCrash1.processPayouts(3500, {
    refundBroadcaster: async () => { refundSends += 1; return { txHash: 'dup' }; },
    verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }),
  });
  assert.equal(sCrash.errors.length, 1);
  assert.equal((await eAfterCrash1.repo.getPayout(pId)).status, 'SENT');
  assert.equal((await eAfterCrash1.getOrder(oLate.orderId)).status, PRESALE_STATUS.REFUND_SENT);
  assert.equal(refundSends, 1);

  // 重启恢复后再次核验 -> 原子提交 CONFIRMED + REFUNDED，不重发
  const eRecovered = new D1PresaleStore({ db: flakyDb, hotWalletAddress: HOT, open: true });
  await eRecovered.processPayouts(3510, {
    refundBroadcaster: async () => { refundSends += 1; return { txHash: 'dup2' }; },
    verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }),
  });
  assert.equal(refundSends, 1);
  assert.equal((await eRecovered.repo.getPayout(pId)).status, 'CONFIRMED');
  assert.equal((await eRecovered.getOrder(oLate.orderId)).status, PRESALE_STATUS.REFUNDED);

  // 崩溃点 2：已广播退款但回写 SENT 前崩溃 -> 重启超时查链返回 CONFIRMED -> 原子完成，不重发
  const oLate2 = await eRecovered.createOrderIntent('EQ_CRASH_REFUND_2', '5', 4000);
  await eRecovered.ingestInbound(inbound(oLate2), 4000 + 31 * 60);
  const pId2 = `refund:in-${oLate2.orderId}`;
  assert.ok(await eRecovered.repo.claimPayout(pId2, ['PENDING'], { status: 'BROADCASTING', attempts: 1, updatedAt: 6000 }));
  let sends2 = 0;
  const eRec2 = new D1PresaleStore({ db: flakyDb, hotWalletAddress: HOT, open: true });
  await eRec2.processPayouts(6000 + STALE_BROADCAST_SEC, {
    refundBroadcaster: async () => { sends2 += 1; return { txHash: 'dup3' }; },
    verifier: async () => ({ state: 'CONFIRMED', txHash: 'landed-before-crash' }),
  });
  assert.equal(sends2, 0);
  assert.equal((await eRec2.repo.getPayout(pId2)).status, 'CONFIRMED');
  assert.equal((await eRec2.getOrder(oLate2.orderId)).status, PRESALE_STATUS.REFUNDED);
  assert.equal((await eRec2.getOrder(untouched.orderId)).status, PRESALE_STATUS.PENDING_PAYMENT);
});

// ---------------------------------------------------------------------------
// D5 + P0-C 增量迁移验证：真实合法友好地址旧数据兼容 + 0004 保留历史 payout 行
// ---------------------------------------------------------------------------
await test('[d1-sqlite] migration 0001->0004 (D5 & P0-C): real friendly-address legacy orders stay visible, count quota (OVER_QUOTA), and preserve payout rows', async () => {
  const { readFileSync } = await import('node:fs');
  const rawAddr = `0:${'ab'.repeat(32)}`;
  const parsed = parseTonAddress(rawAddr);
  const eqFriendly = formatTonAddress(parsed.workchain, parsed.hash, { bounceable: true, testOnly: false });
  const uqFriendly = formatTonAddress(parsed.workchain, parsed.hash, { bounceable: false, testOnly: false });

  const db = createSqliteD1([MIGRATIONS[0]]);
  await db.prepare(`INSERT INTO presale_orders (order_id, wallet_address, referrer_id, ton_nano, a9_amount_raw, memo, status, inbound_tx_hash, payout_tx_hash, refund_ton_nano, created_at, updated_at)
    VALUES ('legacy-paid', ?, NULL, '195000000000', '390390000000000', 'buy:legacy-paid', 'PAID_A9', 'in-leg-1', 'out-leg-1', '0', 100, 100)`).bind(eqFriendly).run();
  await db.prepare(`INSERT INTO presale_orders (order_id, wallet_address, referrer_id, ton_nano, a9_amount_raw, memo, status, inbound_tx_hash, payout_tx_hash, refund_ton_nano, created_at, updated_at)
    VALUES ('legacy-nohash', 'EQ_LEGACY', NULL, '5000000000', '10010000000000', 'buy:legacy-nohash', 'PAID_A9', 'in-leg-2', NULL, '0', 101, 101)`).run();

  for (const m of MIGRATIONS.slice(1, 3)) db.exec(readFileSync(new URL(m, new URL('./helpers/test-env.mjs', import.meta.url)), 'utf8'));
  await db.prepare(`INSERT INTO presale_payouts (payout_id, order_id, inbound_tx_hash, kind, recipient, amount, query_id, status, attempts, ambiguous, tx_hash, last_error, created_at, updated_at)
    VALUES ('a9:legacy-paid', 'legacy-paid', 'in-leg-1', 'A9', ?, '390390000000000', '1', 'SENT', 1, 0, 'out-leg-1', NULL, 100, 100)`).bind(eqFriendly).run();
  db.exec(readFileSync(new URL(MIGRATIONS[3], new URL('./helpers/test-env.mjs', import.meta.url)), 'utf8'));

  const e = new D1PresaleStore({ db, hotWalletAddress: HOT, defaultQuotaTon: 200n, open: true });
  assert.equal((await e.repo.getPayout('a9:legacy-paid')).txHash, 'out-leg-1');

  for (const form of [eqFriendly, uqFriendly, rawAddr]) {
    const orders = await e.listOrders(form);
    assert.equal(orders.length, 1, form);
    assert.equal(orders[0].legacyStatus, 'PAID_A9');
    assert.equal(orders[0].status, PRESALE_STATUS.PAYOUT_SENT);
    assert.equal(await e.hasCompletedPurchase(form), false);
    assert.equal((await e.getQuota(form, 200)).usedQuotaTon, 195);
    await assert.rejects(e.createOrderIntent(form, '10', 200), { code: 'OVER_QUOTA' });
  }
  const [noHash] = await e.listOrders('EQ_LEGACY');
  assert.equal(noHash.status, PRESALE_STATUS.NEEDS_REVIEW);

  assert.equal(await e.backfillLegacyWalletKeys(), 2);
  assert.equal(await e.backfillLegacyWalletKeys(), 0);
  assert.equal((await e.listOrders(uqFriendly)).length, 1);

  const oNew = await e.createOrderIntent('EQ_MIG_A', '10', 300);
  await e.ingestInbound({ txHash: 'm-s1', finality: 'finalized', to: HOT, from: 'EQ_MIG_B', valueNano: oNew.tonNano, memo: oNew.memo }, 301);
  await e.ingestInbound({ txHash: 'm-s2', finality: 'finalized', to: HOT, from: 'EQ_MIG_C', valueNano: oNew.tonNano, memo: oNew.memo }, 302);
  assert.equal((await e.resolveAnomaly('m-s1', { decision: 'REFUND', faultParty: 'UNKNOWN', operator: 'ops' }, 303)).status, 'REFUND_QUEUED');
  assert.equal((await e.resolveAnomaly('m-s2', { decision: 'REFUND', faultParty: 'UNKNOWN', operator: 'ops' }, 304)).status, 'REFUND_QUEUED');
});

// ---------------------------------------------------------------------------
// P0-I: D1 commitInbound 订单竞争必须在单次 db.batch() 事务内原子落库，零崩溃恢复窗口
// ---------------------------------------------------------------------------
await test('[d1-sqlite] P0-I: commitInbound order-race commits ANOMALY in ONE db.batch() with zero post-batch write window and crash recovery', async () => {
  const rawDb = createSqliteD1(FRESH_SCHEMA);
  let batchCalls = 0;
  let postBatchWrites = 0;
  let crashAfterCommit = false;
  let inCommit = false;
  const wrapStmt = (rawStmt, sql) => ({
    _sql: sql,
    _raw: rawStmt,
    bind(...a) { return wrapStmt(rawStmt.bind(...a), sql); },
    first(...a) { return rawStmt.first(...a); },
    all(...a) { return rawStmt.all(...a); },
    run(...a) {
      if (inCommit && /UPDATE|INSERT|DELETE/i.test(sql)) postBatchWrites += 1;
      return rawStmt.run(...a);
    },
  });
  const monitoredDb = {
    prepare(sql) { return wrapStmt(rawDb.prepare(sql), sql); },
    async batch(stmts) {
      if (inCommit) batchCalls += 1;
      const out = await rawDb.batch(stmts.map((s) => s?._raw || s));
      if (crashAfterCommit) {
        crashAfterCommit = false;
        throw new Error('SIMULATED_CRASH_IMMEDIATELY_AFTER_BATCH_COMMIT');
      }
      return out;
    },
  };

  const e = new D1PresaleStore({ db: monitoredDb, hotWalletAddress: HOT, open: true });
  const o = await e.createOrderIntent('EQ_RACE_A', '10', 1000);
  // 模拟 planInbound 时订单有效，随后在 commitInbound 前订单刚过期释放
  const plan = await e.planInbound({ txHash: 'tx-race-atomic', finality: 'finalized', to: HOT, from: 'EQ_RACE_A', valueNano: o.payTonNano, memo: o.memo }, 1005);
  assert.equal(plan.action, 'CONFIRM');
  await rawDb.prepare('UPDATE presale_orders SET expires_at = 1001 WHERE order_id = ?').bind(o.orderId).run();

  // 场景 1：db.batch() 刚提交进程即崩溃退出 -> 数据库必须已直接是最终 ANOMALY/OPEN 状态，且没有任何 batch 后的二次写库
  inCommit = true;
  crashAfterCommit = true;
  await assert.rejects(
    e.repo.commitInbound({
      inbound: { txHash: 'tx-race-atomic', orderId: o.orderId, sender: 'EQ_RACE_A', valueNano: o.payTonNano, memo: o.memo, decision: plan.action, reason: plan.reason, createdAt: 1005 },
      orderUpdate: { orderId: o.orderId, from: [PRESALE_STATUS.PENDING_PAYMENT, PRESALE_STATUS.PENDING_TON], notExpiredAt: 1005, patch: { status: PRESALE_STATUS.PAYMENT_CONFIRMED, inboundTxHash: 'tx-race-atomic', updatedAt: 1005 } },
      payout: null,
    }),
    /SIMULATED_CRASH_IMMEDIATELY_AFTER_BATCH_COMMIT/,
  );
  inCommit = false;
  assert.equal(batchCalls, 1);
  assert.equal(postBatchWrites, 0);

  // 重启新建引擎实例：无需二次修补，异常队列已可靠记录该笔入账；重扫同一 txHash 返回 REPLAY；人工可退款（扣除 0.03 GRAM 链上退回 Gas）
  const restarted = new D1PresaleStore({ db: rawDb, hotWalletAddress: HOT, open: true });
  const row = await restarted.repo.getInbound('tx-race-atomic');
  assert.equal(row.decision, 'ANOMALY');
  assert.equal(row.reason, 'order_state_race');
  assert.equal(row.anomalyStatus, 'OPEN');
  assert.equal(row.refundTo, 'EQ_RACE_A');
  assert.equal((await restarted.getOrder(o.orderId)).status, PRESALE_STATUS.PENDING_PAYMENT);
  assert.equal((await restarted.listAnomalies('OPEN')).length, 1);
  const rescan = await restarted.ingestInbound({ txHash: 'tx-race-atomic', finality: 'finalized', to: HOT, from: 'EQ_RACE_A', valueNano: o.payTonNano, memo: o.memo }, 1010);
  assert.equal(rescan.action, 'REPLAY');
  const resolved = await restarted.resolveAnomaly('tx-race-atomic', { decision: 'REFUND', faultParty: 'SYSTEM', operator: 'ops' }, 1015);
  assert.equal(resolved.status, 'REFUND_QUEUED');
  assert.equal(resolved.refundNano, (BigInt(o.payTonNano) - 30_000_000n).toString());
  await restarted.processPayouts(1020, { refundBroadcaster: async () => ({ txHash: 'rf-race-1' }), verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }) });
  assert.equal((await restarted.repo.getPayout('refund:tx-race-atomic')).status, 'CONFIRMED');

  // 场景 2：batch 提交前中途失败整批回滚 -> 零残留记录 -> 重启重扫正常处理
  const o2 = await restarted.createOrderIntent('EQ_RACE_B', '5', 2000);
  let failBatchOnce = true;
  const rollbackDb = {
    prepare(sql) { return wrapStmt(rawDb.prepare(sql), sql); },
    async batch(stmts) {
      if (failBatchOnce) {
        failBatchOnce = false;
        return rawDb.batch([...stmts.map((s) => s?._raw || s), rawDb.prepare('UPDATE __nonexistent_inbound_crash SET x = 1')]);
      }
      return rawDb.batch(stmts.map((s) => s?._raw || s));
    },
  };
  const eFail = new D1PresaleStore({ db: rollbackDb, hotWalletAddress: HOT, open: true });
  await assert.rejects(
    eFail.ingestInbound({ txHash: 'tx-rollback-then-recover', finality: 'finalized', to: HOT, from: 'EQ_RACE_B', valueNano: o2.payTonNano, memo: o2.memo }, 2005),
  );
  assert.equal(await restarted.repo.getInbound('tx-rollback-then-recover'), null);
  assert.equal((await restarted.getOrder(o2.orderId)).status, PRESALE_STATUS.PENDING_PAYMENT);
  const recovered = await restarted.ingestInbound({ txHash: 'tx-rollback-then-recover', finality: 'finalized', to: HOT, from: 'EQ_RACE_B', valueNano: o2.payTonNano, memo: o2.memo }, 2006);
  assert.equal(recovered.action, 'CONFIRM');
  assert.equal((await restarted.getOrder(o2.orderId)).status, PRESALE_STATUS.PAYMENT_CONFIRMED);
});

// 若环境安装了 miniflare，则在真实 Cloudflare D1 (workerd) 上实测 0001->0004 增量迁移、D5 历史友好地址、P0-C 与 P0-E 事务回滚！
if (BACKENDS.some(([n]) => n === 'd1-miniflare')) {
  await test('[d1-miniflare] real Cloudflare D1: migration 0001->0004 (D5 & P0-C) + atomic completeRefund rollback (P0-E)', async () => {
    const { readFileSync } = await import('node:fs');
    const rawAddr = `0:${'cd'.repeat(32)}`;
    const parsed = parseTonAddress(rawAddr);
    const eqFriendly = formatTonAddress(parsed.workchain, parsed.hash, { bounceable: true, testOnly: false });
    const uqFriendly = formatTonAddress(parsed.workchain, parsed.hash, { bounceable: false, testOnly: false });

    const mf = await createMiniflareD1([MIGRATIONS[0]]);
    MF_DISPOSE.push(mf.dispose);
    const db = mf.db;
    const applyMigration = async (rel) => {
      const sql = readFileSync(new URL(rel, new URL('./helpers/test-env.mjs', import.meta.url)), 'utf8').replace(/--[^\n]*/g, '');
      const stmts = sql.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean);
      await db.batch(stmts.map((x) => db.prepare(x)));
    };

    await db.prepare(`INSERT INTO presale_orders (order_id, wallet_address, referrer_id, ton_nano, a9_amount_raw, memo, status, inbound_tx_hash, payout_tx_hash, refund_ton_nano, created_at, updated_at)
      VALUES ('mf-leg-1', ?, NULL, '195000000000', '390390000000000', 'buy:mf-leg-1', 'PAID_A9', 'in-mf-1', 'out-mf-1', '0', 100, 100)`).bind(eqFriendly).run();
    await applyMigration(MIGRATIONS[1]);
    await applyMigration(MIGRATIONS[2]);
    await db.prepare(`INSERT INTO presale_payouts (payout_id, order_id, inbound_tx_hash, kind, recipient, amount, query_id, status, attempts, ambiguous, tx_hash, last_error, created_at, updated_at)
      VALUES ('a9:mf-leg-1', 'mf-leg-1', 'in-mf-1', 'A9', ?, '390390000000000', '1', 'SENT', 1, 0, 'out-mf-1', NULL, 100, 100)`).bind(eqFriendly).run();
    await applyMigration(MIGRATIONS[3]);

    const e = new D1PresaleStore({ db, hotWalletAddress: HOT, defaultQuotaTon: 200n, open: true });
    assert.equal((await e.repo.getPayout('a9:mf-leg-1')).txHash, 'out-mf-1');
    assert.equal((await e.listOrders(uqFriendly)).length, 1);
    assert.equal((await e.getQuota(uqFriendly, 200)).usedQuotaTon, 195);
    await assert.rejects(e.createOrderIntent(uqFriendly, '10', 200), { code: 'OVER_QUOTA' });
    assert.equal(await e.backfillLegacyWalletKeys(), 1);

    // 真实 D1 上验证多笔错付同一订单均可独立退款
    const oA = await e.createOrderIntent('EQ_MF_A', '10', 300);
    await e.ingestInbound({ txHash: 'mf-b', finality: 'finalized', to: HOT, from: 'EQ_MF_B', valueNano: oA.payTonNano, memo: oA.memo }, 301);
    await e.ingestInbound({ txHash: 'mf-c', finality: 'finalized', to: HOT, from: 'EQ_MF_C', valueNano: oA.payTonNano, memo: oA.memo }, 302);
    assert.equal((await e.resolveAnomaly('mf-b', { decision: 'REFUND', faultParty: 'USER', operator: 'ops' }, 303)).refundNano, '10030000000');
    assert.equal((await e.resolveAnomaly('mf-c', { decision: 'REFUND', faultParty: 'UNKNOWN', operator: 'ops' }, 304)).refundNano, '10030000000');

    // 真实 D1 上验证 db.batch() 崩溃回滚原子性（P0-E）
    let crashOnce = true;
    const wrapStmt = (rawStmt, sql) => ({
      _sql: sql,
      _raw: rawStmt,
      bind(...a) { return wrapStmt(rawStmt.bind(...a), sql); },
      first(...a) { return rawStmt.first(...a); },
      all(...a) { return rawStmt.all(...a); },
      run(...a) { return rawStmt.run(...a); },
    });
    const wrappedDb = {
      prepare(sql) { return wrapStmt(db.prepare(sql), sql); },
      async batch(stmts) {
        if (crashOnce && stmts.some((s) => /UPDATE presale_orders SET status = 'REFUNDED'/.test(s?._sql || ''))) {
          crashOnce = false;
          return db.batch([stmts[0]._raw || stmts[0], db.prepare('UPDATE __mf_nonexistent_crash SET a = 1')]);
        }
        return db.batch(stmts.map((s) => s?._raw || s));
      },
    };
    const oLate = await e.createOrderIntent('EQ_MF_LATE', '5', 400);
    await e.ingestInbound(inbound(oLate), 400 + 31 * 60);
    await e.processPayouts(400 + 32 * 60, { refundBroadcaster: async (inst) => ({ txHash: `mf-rf-${inst.payoutId}` }) });
    const eCrash = new D1PresaleStore({ db: wrappedDb, hotWalletAddress: HOT, open: true });
    const sFail = await eCrash.processPayouts(400 + 33 * 60, {
      verifier: async (p) => (p.payoutId === `refund:in-${oLate.orderId}` ? { state: 'CONFIRMED', txHash: p.txHash } : { state: 'PENDING' }),
    });
    assert.equal(sFail.errors.length, 1);
    assert.equal((await e.repo.getPayout(`refund:in-${oLate.orderId}`)).status, 'SENT');
    assert.equal((await e.getOrder(oLate.orderId)).status, PRESALE_STATUS.REFUND_SENT);
    // 恢复后原子提交完成
    await e.processPayouts(400 + 34 * 60, {
      verifier: async (p) => (p.payoutId === `refund:in-${oLate.orderId}` ? { state: 'CONFIRMED', txHash: p.txHash } : { state: 'PENDING' }),
    });
    assert.equal((await e.repo.getPayout(`refund:in-${oLate.orderId}`)).status, 'CONFIRMED');
    assert.equal((await e.getOrder(oLate.orderId)).status, PRESALE_STATUS.REFUNDED);
    assert.equal((await e.getOrder(oA.orderId)).status, PRESALE_STATUS.PENDING_PAYMENT);

    // 真实 Cloudflare D1 上验证 commitInbound 单事务竞态无崩溃窗口（P0-I）
    const oRaceMf = await e.createOrderIntent('EQ_MF_RACE', '5', 500);
    await db.prepare('UPDATE presale_orders SET expires_at = 501 WHERE order_id = ?').bind(oRaceMf.orderId).run();
    let mfBatchCalls = 0;
    let mfPostWrites = 0;
    let mfCrashNow = true;
    const raceDb = {
      prepare(sql) {
        const w = wrapStmt(db.prepare(sql), sql);
        const origRun = w.run;
        w.run = (...a) => {
          if (/UPDATE|INSERT|DELETE/i.test(sql)) mfPostWrites += 1;
          return origRun(...a);
        };
        return w;
      },
      async batch(stmts) {
        mfBatchCalls += 1;
        const out = await db.batch(stmts.map((s) => s?._raw || s));
        if (mfCrashNow) {
          mfCrashNow = false;
          throw new Error('MF_CRASH_AFTER_BATCH');
        }
        return out;
      },
    };
    const eRaceMf = new D1PresaleStore({ db: raceDb, hotWalletAddress: HOT, open: true });
    await assert.rejects(
      eRaceMf.repo.commitInbound({
        inbound: { txHash: 'mf-race-tx', orderId: oRaceMf.orderId, sender: 'EQ_MF_RACE', valueNano: oRaceMf.payTonNano, memo: oRaceMf.memo, decision: 'CONFIRM', reason: 'valid', createdAt: 505 },
        orderUpdate: { orderId: oRaceMf.orderId, from: [PRESALE_STATUS.PENDING_PAYMENT, PRESALE_STATUS.PENDING_TON], notExpiredAt: 505, patch: { status: PRESALE_STATUS.PAYMENT_CONFIRMED, inboundTxHash: 'mf-race-tx', updatedAt: 505 } },
        payout: null,
      }),
      /MF_CRASH_AFTER_BATCH/,
    );
    assert.equal(mfBatchCalls, 1);
    assert.equal(mfPostWrites, 0);
    const mfRow = await e.repo.getInbound('mf-race-tx');
    assert.equal(mfRow.decision, 'ANOMALY');
    assert.equal(mfRow.reason, 'order_state_race');
    assert.equal(mfRow.anomalyStatus, 'OPEN');
    assert.equal(mfRow.refundTo, 'EQ_MF_RACE');
    assert.equal((await e.ingestInbound({ txHash: 'mf-race-tx', finality: 'finalized', to: HOT, from: 'EQ_MF_RACE', valueNano: oRaceMf.payTonNano, memo: oRaceMf.memo }, 510)).action, 'REPLAY');
    assert.equal((await e.resolveAnomaly('mf-race-tx', { decision: 'REFUND', faultParty: 'SYSTEM', operator: 'ops' }, 512)).refundNano, (BigInt(oRaceMf.payTonNano) - 30_000_000n).toString());
  });
}

// ---------------------------------------------------------------------------
// D6: 服务端兑换开关默认关闭且不回退复用推广热钱包
// ---------------------------------------------------------------------------
await test('D6: PresaleEngine defaults to closed; cf-worker refuses orders unless A9_PRESALE_OPEN=1 and never falls back to promo hot wallet', async () => {
  const memClosed = new PresaleHotWalletEngine({ hotWalletAddress: HOT });
  assert.equal(memClosed.open, false);
  await assert.rejects(memClosed.createOrderIntent('EQ_X', '5', 1000), { code: 'PRESALE_CLOSED' });

  const d1Closed = new D1PresaleStore({ db: createSqliteD1(FRESH_SCHEMA), hotWalletAddress: HOT });
  assert.equal(d1Closed.open, false);
  await assert.rejects(d1Closed.createOrderIntent('EQ_X', '5', 1000), { code: 'PRESALE_CLOSED' });

  const rNoPresale = await cfWorker.fetch(new Request('https://a9.example/api/config'), {
    A9_PROMO_HOT_WALLET_ADDRESS: 'EQ_PROMO_ONLY',
  });
  const cfg1 = await rNoPresale.json();
  assert.equal(cfg1.data.presaleHotWallet.enabled, false);
  assert.equal(cfg1.data.presaleHotWallet.open, false);

  const db = createSqliteD1(FRESH_SCHEMA);
  const idStore = new D1IdentityStore({ db });
  await idStore.bindWallet('9901', 'EQ_TRY_BUY', 1000);
  const envClosed = {
    DB: db,
    A9_BOT_TOKEN: TEST_BOT_TOKEN,
    A9_PRESALE_HOT_WALLET_ADDRESS: 'EQ_PRESALE_ONLY',
  };
  const cfg2 = await (await cfWorker.fetch(new Request('https://a9.example/api/config'), envClosed)).json();
  assert.equal(cfg2.data.presaleHotWallet.enabled, true);
  assert.equal(cfg2.data.presaleHotWallet.open, false);

  const nowSec = Math.floor(Date.now() / 1000);
  const hdrs = await tgHeaders(9901, { nowSec });
  const orderTry = await cfWorker.fetch(
    new Request('https://a9.example/api/presale/intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...hdrs },
      body: JSON.stringify({ gramAmount: '5' }),
    }),
    envClosed,
  );
  const orderBody = await orderTry.json();
  assert.equal(orderTry.status, 400);
  assert.equal(orderBody.error.code, 'PRESALE_CLOSED');
});

// ---------------------------------------------------------------------------
// P0-F: 收紧 ton_proof 公钥信任边界（未知合约拒绝 + WalletTg 完整校验）
// ---------------------------------------------------------------------------
await test('P0-F: unknown non-standard contract with chain get_public_key is REJECTED; WalletTg requires active state + trampoline code + get_public_key', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const pubHex = Array.from(pub, (b) => b.toString(16).padStart(2, '0')).join('');
  const unknownCode = cellFromBits('1010101010101010');
  const unknownData = cellFromBits('00000000');
  const unknownRoot = cellFromBits('00110', [unknownCode, unknownData]);
  const unknownWallet = { kp, pubHex, stateInit: await serializeBoc(unknownRoot), address: `0:${await unknownRoot.hashHex()}` };
  const unknownProof = await signTonProof(unknownWallet, { payload: 'p-unk', domain: 'a9.example', timestamp: 1000 });

  let chainGetterCalled = false;
  await assert.rejects(
    verifyTonProof({
      address: unknownWallet.address,
      network: '-3',
      publicKey: pubHex,
      proof: unknownProof,
      expectedNetwork: '-3',
      allowedDomains: ['a9.example'],
      chainPublicKeyResolver: async () => { chainGetterCalled = true; return pubHex; },
      walletStateResolver: async () => ({ state: 'active', codeBoc: await serializeBoc(unknownCode) }),
      nowSec: 1000,
    }),
    { code: 'PROOF_UNSUPPORTED_WALLET' },
  );
  assert.equal(chainGetterCalled, false);

  const trampolineHashBits = BigInt(`0x${WALLET_TG_TRAMPOLINE_HASH}`).toString(2).padStart(256, '0');
  const libTypeBits = '00000010';
  const tgCodeCell = cellFromBits(libTypeBits + trampolineHashBits, [], true);
  const tgCodeBoc = await serializeBoc(tgCodeCell);
  const tgDataCell = cellFromBits('00000000');
  const tgRoot = cellFromBits('00110', [tgCodeCell, tgDataCell]);
  const rotatedKp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rotatedPub = new Uint8Array(await crypto.subtle.exportKey('raw', rotatedKp.publicKey));
  const rotatedPubHex = Array.from(rotatedPub, (b) => b.toString(16).padStart(2, '0')).join('');
  const tgWallet = { kp: rotatedKp, pubHex: rotatedPubHex, stateInit: await serializeBoc(tgRoot), address: `0:${await tgRoot.hashHex()}` };
  const tgProof = await signTonProof(tgWallet, { payload: 'p-tg', domain: 'a9.example', timestamp: 1000 });

  await assert.rejects(
    verifyTonProof({
      address: tgWallet.address, network: '-3', publicKey: rotatedPubHex, proof: tgProof,
      expectedNetwork: '-3', allowedDomains: ['a9.example'],
      walletStateResolver: async () => ({ state: 'uninitialized', codeBoc: null }),
      chainPublicKeyResolver: async () => rotatedPubHex,
      nowSec: 1000,
    }),
    { code: 'PROOF_WALLET_NOT_ACTIVE' },
  );
  await assert.rejects(
    verifyTonProof({
      address: tgWallet.address, network: '-3', publicKey: rotatedPubHex, proof: tgProof,
      expectedNetwork: '-3', allowedDomains: ['a9.example'],
      walletStateResolver: async () => ({ state: 'active', codeBoc: await serializeBoc(unknownCode) }),
      chainPublicKeyResolver: async () => rotatedPubHex,
      nowSec: 1000,
    }),
    { code: 'PROOF_CODE_MISMATCH' },
  );
  await assert.rejects(
    verifyTonProof({
      address: tgWallet.address, network: '-3', publicKey: rotatedPubHex, proof: tgProof,
      expectedNetwork: '-3', allowedDomains: ['a9.example'],
      walletStateResolver: async () => ({ state: 'active', codeBoc: tgCodeBoc }),
      chainPublicKeyResolver: async () => null,
      nowSec: 1000,
    }),
    { code: 'WALLET_PUBKEY_UNAVAILABLE' },
  );
  const tgOk = await verifyTonProof({
    address: tgWallet.address, network: '-3', publicKey: rotatedPubHex, proof: tgProof,
    expectedNetwork: '-3', allowedDomains: ['a9.example'],
    walletStateResolver: async () => ({ state: 'active', codeBoc: tgCodeBoc }),
    chainPublicKeyResolver: async () => rotatedPubHex,
    nowSec: 1000,
  });
  assert.equal(tgOk.walletVersion, 'wallet_tg');
  assert.equal(tgOk.keySource, 'wallet_tg_chain');
  assert.equal(tgOk.publicKeyHex, rotatedPubHex);
});

// ---------------------------------------------------------------------------
// P0-G: 无链上数据源时绝不伪造轮次、价格、奖池或人数（API + OG HTML/SVG/PNG）
// ---------------------------------------------------------------------------
await test('P0-G: without chain data source, cf-worker config/rounds/OG cards return unavailable/pending with zero fabricated numbers', async () => {
  const cfgRes = await cfWorker.fetch(new Request('https://a9.example/api/config'), {});
  const cfg = await cfgRes.json();
  assert.equal(cfg.data.poolState.dataAvailable, false);
  assert.equal(cfg.data.poolState.poolRemainingRaw, null);
  assert.equal(cfg.data.poolState.currentRoundId, null);

  const roundsRes = await cfWorker.fetch(new Request('https://a9.example/api/rounds'), {});
  const rounds = await roundsRes.json();
  assert.deepEqual(rounds.data, []);

  const ogHtml = await (await cfWorker.fetch(new Request('https://a9.example/c/round/1'), { A9_PUBLIC_ORIGIN: 'https://a9.example' })).text();
  assert.equal(ogHtml.includes('700,000,000'), false);
  assert.ok(ogHtml.includes('pending verification'));

  const ogSvg = await (await cfWorker.fetch(new Request('https://a9.example/c/img/round/1.svg'), {})).text();
  assert.equal(ogSvg.includes('700,000,000'), false);
  assert.equal(ogSvg.includes('0/24'), false);
  assert.ok(ogSvg.includes('DATA PENDING'));

  const ogPngRes = await cfWorker.fetch(new Request('https://a9.example/c/img/round/1.png'), {});
  assert.equal(ogPngRes.status, 200);
  assert.equal(ogPngRes.headers.get('content-type'), 'image/png');
  const pngBytes = new Uint8Array(await ogPngRes.arrayBuffer());
  assert.deepEqual(Array.from(pngBytes.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

// ---------------------------------------------------------------------------
// P0-G (补强): 已配置链上数据源但 TonCenter 请求失败时绝不把余额显示为 0
// ---------------------------------------------------------------------------
await test('P0-G: configured TonCenter failure or active-contract getter error returns a9BalanceRaw=null & balanceAvailable=false (never fake 0); uninitialized JettonWallet returns true 0', async () => {
  const rawAddr = `0:${'22'.repeat(32)}`;
  const boc = encodeAddressSliceBoc(rawAddr);
  const decoded = decodeAddressFromCellBoc(boc);

  // 1) get_wallet_address 成功，但 get_wallet_data HTTP 500（例如用户实际有 10,000 A9 但节点临时失败）-> a9BalanceRaw = null
  const tcDataFail = new TonCenterClient({
    apiBase: 'http://mock-toncenter.local',
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async (_url, opts) => {
      const req = JSON.parse(opts.body);
      if (req.method === 'get_wallet_address') {
        return { ok: true, json: async () => ({ ok: true, result: { exit_code: 0, stack: [['cell', { bytes: boc }]] } }) };
      }
      return { ok: false, status: 500, json: async () => ({ ok: false }) };
    },
  });
  const pfDataFail = await tcDataFail.fetchUserPortfolio(rawAddr, { jettonMasterAddress: decoded, roundControllerAddress: decoded, roundIds: [1] });
  assert.equal(pfDataFail.a9BalanceRaw, null);
  assert.equal(pfDataFail.balanceAvailable, false);
  assert.equal(pfDataFail.ticketsAvailable, false);
  assert.equal(pfDataFail.onchainAvailable, false);

  // 2) get_wallet_address 本身网络抛错 -> a9BalanceRaw = null, balanceAvailable = false
  const tcNetFail = new TonCenterClient({
    apiBase: 'http://mock-toncenter.local',
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  const pfNetFail = await tcNetFail.fetchUserPortfolio(rawAddr, { jettonMasterAddress: decoded });
  assert.equal(pfNetFail.jettonWallet, null);
  assert.equal(pfNetFail.a9BalanceRaw, null);
  assert.equal(pfNetFail.balanceAvailable, false);
  assert.equal(pfNetFail.onchainAvailable, false);

  // 3) get_wallet_data TVM 异常，但 /getAddressInformation 显示该合约为 active（并非未部署）-> 仍必须返回 null
  const tcActiveErr = new TonCenterClient({
    apiBase: 'http://mock-toncenter.local',
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async (url, opts) => {
      if (url.includes('/getAddressInformation')) {
        return { ok: true, json: async () => ({ ok: true, result: { state: 'active', code: 'te6ccg==' } }) };
      }
      const req = JSON.parse(opts.body);
      if (req.method === 'get_wallet_address') {
        return { ok: true, json: async () => ({ ok: true, result: { exit_code: 0, stack: [['cell', { bytes: boc }]] } }) };
      }
      return { ok: true, json: async () => ({ ok: true, result: { exit_code: -13, stack: [] } }) };
    },
  });
  const pfActiveErr = await tcActiveErr.fetchUserPortfolio(rawAddr, { jettonMasterAddress: decoded });
  assert.equal(pfActiveErr.a9BalanceRaw, null);
  assert.equal(pfActiveErr.balanceAvailable, false);

  // 4) get_wallet_data TVM -13 且 /getAddressInformation 明确确认合约 uninitialized -> 真实 0 余额
  const tcUninit = new TonCenterClient({
    apiBase: 'http://mock-toncenter.local',
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async (url, opts) => {
      if (url.includes('/getAddressInformation')) {
        return { ok: true, json: async () => ({ ok: true, result: { state: 'uninitialized', code: '' } }) };
      }
      const req = JSON.parse(opts.body);
      if (req.method === 'get_wallet_address') {
        return { ok: true, json: async () => ({ ok: true, result: { exit_code: 0, stack: [['cell', { bytes: boc }]] } }) };
      }
      return { ok: true, json: async () => ({ ok: true, result: { exit_code: -13, stack: [] } }) };
    },
  });
  const pfUninit = await tcUninit.fetchUserPortfolio(rawAddr, { jettonMasterAddress: decoded });
  assert.equal(pfUninit.a9BalanceRaw, '0');
  assert.equal(pfUninit.balanceAvailable, true);
  assert.equal(pfUninit.onchainAvailable, true);

  // 5) API 端到端验证：GET /api/user/:wallet 在配置了 userReader 但链上请求失败时返回 a9BalanceRaw = null 且 balanceAvailable = false
  const { route } = buildRouter({ userReader: (w) => tcDataFail.fetchUserPortfolio(w, { jettonMasterAddress: decoded }) });
  const rApi = await route({ method: 'GET', pathname: `/api/user/${encodeURIComponent(rawAddr)}`, query: {}, body: null, headers: {} });
  assert.equal(rApi.status, 200);
  assert.equal(rApi.body.data.a9BalanceRaw, null);
  assert.equal(rApi.body.data.balanceAvailable, false);
  assert.equal(rApi.body.data.onchainAvailable, false);

  // 6) 若 userReader 自身直接抛异常，GET /api/user/:wallet 同样安全降级为 a9BalanceRaw = null, balanceAvailable = false
  const { route: routeThrow } = buildRouter({ userReader: async () => { throw new Error('UPSTREAM_TIMEOUT'); } });
  const rThrow = await routeThrow({ method: 'GET', pathname: `/api/user/${encodeURIComponent(rawAddr)}`, query: {}, body: null, headers: {} });
  assert.equal(rThrow.status, 200);
  assert.equal(rThrow.body.data.a9BalanceRaw, null);
  assert.equal(rThrow.body.data.balanceAvailable, false);
});

// ---------------------------------------------------------------------------
// 第一阶段遗留小修复（第二阶段任务书 §5）：TonCenter 严格结构验证反例
// ---------------------------------------------------------------------------
await test('TonCenter strict schema validation: empty/malformed stack, missing/wrong-type/negative balance, missing account state never become fake 0', async () => {
  const rawAddr = `0:${'33'.repeat(32)}`;
  const boc = encodeAddressSliceBoc(rawAddr);
  const decoded = decodeAddressFromCellBoc(boc);

  const mkClient = (walletDataResp, addrInfoResp = null, ticketDataResp = null) => new TonCenterClient({
    apiBase: 'http://mock-toncenter.local',
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async (url, opts) => {
      if (url.includes('/getAddressInformation')) {
        return { ok: true, json: async () => addrInfoResp };
      }
      const req = JSON.parse(opts.body);
      if (req.method === 'get_wallet_address' || req.method === 'get_ticket_address') {
        return { ok: true, json: async () => ({ ok: true, result: { exit_code: 0, stack: [['cell', { bytes: boc }]] } }) };
      }
      if (req.method === 'get_wallet_data') {
        return { ok: true, json: async () => walletDataResp };
      }
      if (req.method === 'get_ticket_data' && ticketDataResp) {
        return { ok: true, json: async () => ticketDataResp };
      }
      return { ok: false, status: 500, json: async () => ({ ok: false }) };
    },
  });

  // 1) 接口成功(exit_code=0)但结果栈为空 [] -> 绝不能解释为 0
  const pfEmptyStack = await mkClient({ ok: true, result: { exit_code: 0, stack: [] } }).fetchUserPortfolio(rawAddr, { jettonMasterAddress: decoded });
  assert.equal(pfEmptyStack.a9BalanceRaw, null);
  assert.equal(pfEmptyStack.balanceAvailable, false);
  assert.equal(pfEmptyStack.onchainAvailable, false);

  // 2) 接口成功但 stack 字段缺失（非数组）-> 绝不能解释为 0
  const pfNoStack = await mkClient({ ok: true, result: { exit_code: 0 } }).fetchUserPortfolio(rawAddr, { jettonMasterAddress: decoded });
  assert.equal(pfNoStack.a9BalanceRaw, null);
  assert.equal(pfNoStack.balanceAvailable, false);

  // 3) 接口成功但余额字段类型错误（cell、非数值字符串、空串、负数、null）-> 一律返回不可用
  for (const badItem of [
    ['cell', { bytes: boc }],
    ['num', 'not-a-number'],
    ['num', ''],
    ['num', '-0x1'],
    ['num', null],
    null,
    '0x10',
  ]) {
    const pfBad = await mkClient({ ok: true, result: { exit_code: 0, stack: [badItem] } }).fetchUserPortfolio(rawAddr, { jettonMasterAddress: decoded });
    assert.equal(pfBad.a9BalanceRaw, null, `bad balance item ${JSON.stringify(badItem)} must yield null`);
    assert.equal(pfBad.balanceAvailable, false);
  }

  // 4) get_wallet_data TVM 错误，且 /getAddressInformation 缺少 state 字段或 state 非法 -> 绝不能默认当 uninitialized 返回 0
  for (const badAddrInfo of [
    { ok: true, result: {} },
    { ok: true, result: { state: '' } },
    { ok: true, result: { state: null } },
    { ok: true, result: { state: 'unknown_status' } },
  ]) {
    const tcMissingState = mkClient({ ok: true, result: { exit_code: -13, stack: [] } }, badAddrInfo);
    await assert.rejects(tcMissingState.fetchWalletAccountState(decoded), /missing or invalid account state/);
    const pfMissingState = await tcMissingState.fetchUserPortfolio(rawAddr, { jettonMasterAddress: decoded });
    assert.equal(pfMissingState.a9BalanceRaw, null);
    assert.equal(pfMissingState.balanceAvailable, false);
    assert.equal(pfMissingState.onchainAvailable, false);
  }

  // 5) get_ticket_data 结果栈不完整（长度 < 9）或字段类型损坏 -> ticketsAvailable=false, onchainAvailable=false
  const pfBadTicket = await mkClient(
    { ok: true, result: { exit_code: 0, stack: [['num', '0x10']] } },
    null,
    { ok: true, result: { exit_code: 0, stack: [['cell', { bytes: boc }], ['cell', { bytes: boc }], ['num', '0x1']] } },
  ).fetchUserPortfolio(rawAddr, { jettonMasterAddress: decoded, roundControllerAddress: decoded, roundIds: [1] });
  assert.equal(pfBadTicket.a9BalanceRaw, '16');
  assert.equal(pfBadTicket.balanceAvailable, true);
  assert.equal(pfBadTicket.ticketsAvailable, false);
  assert.equal(pfBadTicket.onchainAvailable, false);
});

// ---------------------------------------------------------------------------
// P0-H: 商会访问边界（匿名拒绝、跨用户拒绝、成员不泄 tgChatId、会长本人可见）
// ---------------------------------------------------------------------------
await test('P0-H: GET /api/team/:wallet blocks anonymous & cross-user; hides tgChatId from non-captain members', async () => {
  const { route, identityStore } = buildRouter();
  await identityStore.bindWallet('8101', 'EQ_CAP_H', 900);
  await identityStore.bindWallet('8102', 'EQ_MEM_H', 900);
  await identityStore.bindWallet('8103', 'EQ_OUTSIDER_H', 900);

  const hCap = await tgHeaders(8101, { nowSec: 1000 });
  const hMem = await tgHeaders(8102, { nowSec: 1000 });
  const hOut = await tgHeaders(8103, { nowSec: 1000 });
  const hUnbound = await tgHeaders(8104, { nowSec: 1000 });

  await route({
    method: 'POST',
    pathname: '/api/team/bind-tg',
    body: { teamId: 'G-PRIV', name: 'Private Guild', tgGroupHandle: '@priv_guild', tgChatId: '-100999888777' },
    headers: hCap,
    nowSec: 1000,
  });
  const joinRes = await route({
    method: 'POST',
    pathname: '/api/team/join',
    body: { teamId: 'G-PRIV' },
    headers: hMem,
    nowSec: 1001,
  });
  assert.equal(joinRes.status, 200);
  assert.equal('tgChatId' in joinRes.body.data, false);

  assert.equal((await route({ method: 'GET', pathname: '/api/team/EQ_CAP_H', nowSec: 1002 })).status, 401);
  assert.equal((await route({ method: 'GET', pathname: '/api/team/EQ_CAP_H', headers: hUnbound, nowSec: 1002 })).status, 403);
  assert.equal((await route({ method: 'GET', pathname: '/api/team/EQ_CAP_H', headers: hOut, nowSec: 1002 })).status, 403);
  assert.equal((await route({ method: 'GET', pathname: '/api/team/EQ_CAP_H', headers: hMem, nowSec: 1002 })).status, 403);

  const memView = await route({ method: 'GET', pathname: '/api/team/EQ_MEM_H', headers: hMem, nowSec: 1002 });
  assert.equal(memView.status, 200);
  assert.equal(memView.body.data.teamId, 'G-PRIV');
  assert.equal(memView.body.data.role, 'member');
  assert.equal('tgChatId' in memView.body.data, false);

  const memUserView = await route({ method: 'GET', pathname: '/api/user/EQ_MEM_H', headers: hMem, nowSec: 1002 });
  assert.equal('tgChatId' in memUserView.body.data.team, false);

  const capView = await route({ method: 'GET', pathname: '/api/team/EQ_CAP_H', headers: hCap, nowSec: 1002 });
  assert.equal(capView.status, 200);
  assert.equal(capView.body.data.role, 'captain');
  assert.equal(capView.body.data.tgChatId, '-100999888777');
});

await test('ineligible user (payout only broadcast, not confirmed) cannot activate A9 prediction reward', async () => {
  const pred = new PredictionEngine({ defaultPoolA9Raw: '10000000000000' });
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT, open: true });
  const { route, identityStore } = buildRouter({ predictionEngine: pred, presaleEngine: presale });
  await identityStore.bindWallet('9501', 'EQ_HALFWAY', 900);
  pred.placeBet({ roundId: 1, userId: '9501', side: 'PASS' }, 1000);
  pred.settleRoundBets(1, true, 18, '10000000000000', 1_000_000);
  const o = await presale.createOrderIntent('EQ_HALFWAY', '5', 1000);
  await presale.ingestInbound(inbound(o), 1001);
  await presale.queueConfirmedPayouts(1002);
  await presale.processPayouts(1003, { a9Broadcaster: async () => ({ txHash: 'sent' }) });
  assert.equal((await presale.getOrder(o.orderId)).status, PRESALE_STATUS.PAYOUT_SENT);
  const r = await route({ method: 'POST', pathname: '/api/prediction/activate', body: {}, headers: await tgHeaders(9501, { nowSec: 1100 }), nowSec: 1100 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'ACTIVATION_REQUIREMENT_UNMET');
});

await test('D1 social store: typed group handle stays verifying (no fake "bound")', async () => {
  const social = new D1SocialStore({ db: createSqliteD1(FRESH_SCHEMA) });
  const t = await social.createOrBindTeamGroup({ teamId: 'T9', name: 'N', captainWallet: 'EQ_C', tgGroupHandle: '@x' }, 100);
  assert.equal(t.bindStatus, 'verifying');
});

await test('admin anomaly API requires the admin token and resolves with an audit trail', async () => {
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT, open: true });
  const { route } = buildRouter({ presaleEngine: presale });
  await presale.ingestInbound({ txHash: 'adm-1', finality: 'finalized', to: HOT, from: 'EQ_PAYER', valueNano: '7000000000', memo: 'buy:nope' }, 100);
  assert.equal((await route({ method: 'GET', pathname: '/api/admin/presale/anomalies', nowSec: 101 })).status, 401);
  const list = await route({ method: 'GET', pathname: '/api/admin/presale/anomalies', headers: { 'x-a9-admin-token': 'adm-p0' }, nowSec: 101 });
  assert.equal(list.body.data.length, 1);
  const res = await route({ method: 'POST', pathname: '/api/admin/presale/anomalies/adm-1/resolve', headers: { 'x-a9-admin-token': 'adm-p0' }, body: { decision: 'REFUND', faultParty: 'SYSTEM', operator: 'ops-alice', note: 'memo typo by our UI' }, nowSec: 102 });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.refundNano, '6970000000');
  const [row] = await presale.listAnomalies(null);
  assert.equal(row.resolvedBy, 'ops-alice');
  assert.equal(row.faultParty, 'SYSTEM');
});

// ---------------------------------------------------------------------------
// Phase 3: Handbook Stamp & Non-Financial Progression Loop (Memory + SQLite D1 + Miniflare D1)
// ---------------------------------------------------------------------------
await test('Phase 3: Handbook Stamp progression loop (new user, consecutive check-ins, UTC boundary, idempotency, cross-user auth & strict asset isolation)', async () => {
  const runSuite = async (label, makeEngines) => {
    const { predictionEngine, progressionEngine, presaleEngine } = await makeEngines();
    const { route, identityStore } = buildRouter({ predictionEngine, progressionEngine, presaleEngine });

    // Day 1: 2026-11-20 23:59:50 UTC
    const day1Sec = Math.floor(Date.UTC(2026, 10, 20, 23, 59, 50) / 1000);
    // Day 2: 2026-11-21 00:00:05 UTC (15 seconds later, crosses UTC midnight!)
    const day2Sec = Math.floor(Date.UTC(2026, 10, 21, 0, 0, 5) / 1000);
    // Day 3: 2026-11-22 12:00:00 UTC
    const day3Sec = Math.floor(Date.UTC(2026, 10, 22, 12, 0, 0) / 1000);
    // Day 5 (missed Day 4!): 2026-11-24 08:00:00 UTC
    const day5Sec = Math.floor(Date.UTC(2026, 10, 24, 8, 0, 0) / 1000);

    const hAlice1 = await tgHeaders(3301, { nowSec: day1Sec });
    const hBob1 = await tgHeaders(3302, { nowSec: day1Sec });

    // 1. 新用户初始状态
    const initRes = await route({ method: 'GET', pathname: '/api/progression/me', headers: hAlice1, nowSec: day1Sec });
    assert.equal(initRes.status, 200, label);
    assert.equal(initRes.body.data.exp, 0);
    assert.equal(initRes.body.data.level, 1);
    assert.equal(initRes.body.data.checkinStreak, 0);
    assert.equal(initRes.body.data.assetNature, 'NON_FINANCIAL_GAME_PROGRESSION');
    assert.equal(initRes.body.data.tradable, false);
    assert.equal(initRes.body.data.convertibleToA9, false);

    // 2. 越权防护：Bob 不能读取 Alice 的进度，也不能通过 body.userId 冒充 Alice 盖章
    const bobPeek = await route({ method: 'GET', pathname: '/api/progression/user/3301', headers: hBob1, nowSec: day1Sec });
    assert.equal(bobPeek.status, 403);
    const bobSpoof = await route({ method: 'POST', pathname: '/api/progression/claim', headers: hBob1, body: { userId: '3301', taskKey: 'daily_checkin' }, nowSec: day1Sec });
    assert.equal(bobSpoof.status, 403);

    // 3. 未参与 0 GRAM 竞猜前，不可盖 daily_prediction 章，也不可领 ach_first_stamp
    const prePredFail = await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice1, body: { taskKey: 'daily_prediction', roundId: 1 }, nowSec: day1Sec });
    assert.equal(prePredFail.status, 400);
    assert.equal(prePredFail.body.error.code, 'TASK_PREREQUISITE_UNMET');
    const preAchFail = await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice1, body: { taskKey: 'ach_first_stamp' }, nowSec: day1Sec });
    assert.equal(preAchFail.status, 400);
    assert.equal(preAchFail.body.error.code, 'TASK_PREREQUISITE_UNMET');

    // 4. Day 1 打卡盖章 (+30 EXP, streak=1)，同日重复提交必须幂等拒绝 (ALREADY_CLAIMED)
    const c1 = await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice1, body: { taskKey: 'daily_checkin' }, nowSec: day1Sec });
    assert.equal(c1.status, 200);
    assert.equal(c1.body.data.expAwarded, 30);
    assert.equal(c1.body.data.progression.exp, 30);
    assert.equal(c1.body.data.progression.checkinStreak, 1);
    assert.equal(c1.body.data.progression.totalStamps, 1);
    assert.ok(c1.body.data.progression.unlockableAchievements.includes('ach_first_stamp'));

    const c1Dup = await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice1, body: { taskKey: 'daily_checkin' }, nowSec: day1Sec });
    assert.equal(c1Dup.status, 400);
    assert.equal(c1Dup.body.error.code, 'ALREADY_CLAIMED');

    // 5. 参与 0 GRAM 24H 达标竞猜后，可盖 daily_prediction (+50 EXP)，再盖 daily_observe (+30 EXP) & daily_share (+40 EXP)，集齐 4 章后领取 daily_full_bonus (+80 EXP)
    const betRes = await route({ method: 'POST', pathname: '/api/prediction/bet', headers: hAlice1, body: { roundId: 1, side: 'PASS', guessSlots: 18 }, nowSec: day1Sec });
    assert.equal(betRes.status, 200);

    // 尚未集齐 4 章时不可领 daily_full_bonus
    assert.equal((await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice1, body: { taskKey: 'daily_full_bonus' }, nowSec: day1Sec })).body.error.code, 'TASK_PREREQUISITE_UNMET');

    assert.equal((await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice1, body: { taskKey: 'daily_prediction', roundId: 1 }, nowSec: day1Sec })).status, 200);
    assert.equal((await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice1, body: { taskKey: 'daily_observe' }, nowSec: day1Sec })).status, 200);
    assert.equal((await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice1, body: { taskKey: 'daily_share' }, nowSec: day1Sec })).status, 200);

    const fullBonus = await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice1, body: { taskKey: 'daily_full_bonus' }, nowSec: day1Sec });
    assert.equal(fullBonus.status, 200);
    // 30 + 50 + 30 + 40 + 80 = 230 EXP -> Level 2!
    assert.equal(fullBonus.body.data.progression.exp, 230);
    assert.equal(fullBonus.body.data.progression.level, 2);
    assert.equal(fullBonus.body.data.progression.dailyDoneCount, 4);
    assert.equal(fullBonus.body.data.progression.dailyFullBonusClaimed, true);

    // 6. 领取一次性成就 ach_first_stamp (+50 EXP) 与 ach_pred_pioneer (+100 EXP)，重复领取被拒绝
    assert.equal((await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice1, body: { taskKey: 'ach_first_stamp' }, nowSec: day1Sec })).status, 200);
    assert.equal((await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice1, body: { taskKey: 'ach_pred_pioneer', roundId: 1 }, nowSec: day1Sec })).status, 200);
    assert.equal((await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice1, body: { taskKey: 'ach_first_stamp' }, nowSec: day1Sec })).body.error.code, 'ALREADY_CLAIMED');

    // 7. 跨 UTC 午夜边界（Day 2）+ 连续第 3 天（Day 3）解锁 ach_streak_3 (+120 EXP)
    const hAlice2 = await tgHeaders(3301, { nowSec: day2Sec });
    const d2View = await route({ method: 'GET', pathname: '/api/progression/me', headers: hAlice2, nowSec: day2Sec });
    assert.equal(d2View.body.data.dailyDoneCount, 0); // 新的一天日常印章重置
    assert.equal(d2View.body.data.checkinStreak, 1);  // 昨日已签，连签保持 1
    assert.ok(d2View.body.data.achievementsClaimed.includes('ach_first_stamp')); // 一次性成就跨日保留

    const c2 = await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice2, body: { taskKey: 'daily_checkin' }, nowSec: day2Sec });
    assert.equal(c2.body.data.progression.checkinStreak, 2);

    const hAlice3 = await tgHeaders(3301, { nowSec: day3Sec });
    const c3 = await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice3, body: { taskKey: 'daily_checkin' }, nowSec: day3Sec });
    assert.equal(c3.body.data.progression.checkinStreak, 3);
    assert.ok(c3.body.data.progression.unlockableAchievements.includes('ach_streak_3'));

    const achStreak = await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice3, body: { taskKey: 'ach_streak_3' }, nowSec: day3Sec });
    assert.equal(achStreak.status, 200);
    assert.equal(achStreak.body.data.expAwarded, 120);

    // 8. 断签测试（跳过 Day 4，在 Day 5 打卡时连签重置为 1）
    const hAlice5 = await tgHeaders(3301, { nowSec: day5Sec });
    const d5Before = await route({ method: 'GET', pathname: '/api/progression/me', headers: hAlice5, nowSec: day5Sec });
    assert.equal(d5Before.body.data.checkinStreak, 0);
    const c5 = await route({ method: 'POST', pathname: '/api/progression/claim', headers: hAlice5, body: { taskKey: 'daily_checkin' }, nowSec: day5Sec });
    assert.equal(c5.body.data.progression.checkinStreak, 1);

    // 9. 严格隔离成长数据与真实资产：即便拥有高 EXP / 等级 / 满成就，未完成真实商行购买或链上质押仍不可激活 A9 竞猜奖励券
    await identityStore.bindWallet('3301', 'EQ_ALICE_NO_CAP', day1Sec);
    await predictionEngine.settleRoundBets(1, true, 18, '10000000000000', day1Sec * 1000);
    const actFail = await route({ method: 'POST', pathname: '/api/prediction/activate', headers: hAlice1, body: {}, nowSec: day1Sec + 10 });
    assert.equal(actFail.status, 400);
    assert.equal(actFail.body.error.code, 'ACTIVATION_REQUIREMENT_UNMET');
  };

  await runSuite('memory', async () => ({
    predictionEngine: new PredictionEngine({ defaultPoolA9Raw: '10000000000000' }),
    progressionEngine: new ProgressionEngine(),
    presaleEngine: new PresaleHotWalletEngine({ hotWalletAddress: HOT, open: true }),
  }));

  await runSuite('d1-sqlite', async () => {
    const db = createSqliteD1(MIGRATIONS);
    return {
      predictionEngine: new D1PredictionEngine({ db, defaultPoolA9Raw: '10000000000000' }),
      progressionEngine: new D1ProgressionEngine({ db }),
      presaleEngine: new D1PresaleStore({ db, hotWalletAddress: HOT, open: true }),
    };
  });

  const mf = await createMiniflareD1();
  if (mf) {
    MF_DISPOSE.push(mf.dispose);
    await runSuite('d1-miniflare', async () => ({
      predictionEngine: new D1PredictionEngine({ db: mf.db, defaultPoolA9Raw: '10000000000000' }),
      progressionEngine: new D1ProgressionEngine({ db: mf.db }),
      presaleEngine: new D1PresaleStore({ db: mf.db, hotWalletAddress: HOT, open: true }),
    }));
  }
});

// ---------------------------------------------------------------------------
// Step 0 & Knife 2: Pure Fixed-Rate Exchange (Zero Item Shop) + Rookie First-Loss 500 A9 Floor (Memory + SQLite D1 + Miniflare D1)
// ---------------------------------------------------------------------------
await test('Step 0 & Knife 2: Item shop/inventory fully removed (404), pure 1 GRAM=2,002 A9 (5..200 GRAM) enforced, rookie first-loss 500 A9 bonus + anti-sybil activation', async () => {
  const runSuite = async (label, makeEngines) => {
    const { predictionEngine, presaleEngine, promoEngine, socialStore, identityStore } = await makeEngines();
    const { route } = buildRouter({ predictionEngine, presaleEngine, promoEngine, socialStore, identityStore });

    const nowSec = 1_760_000_000;
    await identityStore.bindWallet('4401', 'EQ_ROOKIE_K2', nowSec);
    await identityStore.bindWallet('4402', 'EQ_WINNER_K2', nowSec);
    const hRookie = await tgHeaders(4401, { nowSec });
    const hWinner = await tgHeaders(4402, { nowSec });

    // 1. 确认所有商品道具与装扮匣接口均已彻底移除（404），/api/config 无 stickerPacks / cosmeticCatalog
    const cfg = await route({ method: 'GET', pathname: '/api/config', nowSec });
    assert.equal(cfg.status, 200, label);
    assert.equal('stickerPacks' in cfg.body.data.presaleHotWallet, false);
    assert.equal('cosmeticCatalog' in cfg.body.data, false);
    assert.equal((await route({ method: 'GET', pathname: '/api/inventory/me', headers: hRookie, nowSec })).status, 404);
    assert.equal((await route({ method: 'POST', pathname: '/api/inventory/sandbox-open', headers: hRookie, body: { skuId: 'pack_basic' }, nowSec })).status, 404);
    assert.equal((await route({ method: 'POST', pathname: '/api/inventory/equip', headers: hRookie, body: { category: 'frame', itemId: 'frame_cotton' }, nowSec })).status, 404);

    // 2. 确认纯内盘 5..200 GRAM 严格边界：1.99 GRAM 与仅传 skuId 均被拒绝
    assert.equal((await route({ method: 'POST', pathname: '/api/presale/intent', headers: hRookie, body: { skuId: 'pack_basic' }, nowSec })).status, 400);
    const reject199 = await route({ method: 'POST', pathname: '/api/presale/intent', headers: hRookie, body: { gramAmount: '1.99' }, nowSec });
    assert.equal(reject199.status, 400);
    assert.equal(reject199.body.error.code, 'BAD_AMOUNT');

    // 3. 新人首轮竞猜押错：自动获得 500 A9 保底待激活奖励（48h 有效），且不占赢家主奖池
    await route({ method: 'POST', pathname: '/api/prediction/bet', headers: hWinner, body: { roundId: 1, side: 'PASS' }, nowSec });
    await route({ method: 'POST', pathname: '/api/prediction/bet', headers: hRookie, body: { roundId: 1, side: 'BURN' }, nowSec });

    const settle1 = await route({
      method: 'POST',
      pathname: '/api/admin/prediction/settle',
      headers: { 'x-a9-admin-token': 'adm-p0' },
      body: { roundId: 1, passed: true, actualQualified: 18 },
      nowSec: nowSec + 100,
    });
    assert.equal(settle1.status, 200);
    assert.equal(settle1.body.data.distributedRaw, '10000000000000'); // 赢家拿满全部 10,000 A9
    assert.equal(settle1.body.data.firstLossBonusCount, 1);
    assert.equal(settle1.body.data.firstLossBonusDistributedRaw, '500000000000');

    const rookieView1 = await route({ method: 'GET', pathname: '/api/prediction/user/me', query: { roundId: '1' }, headers: hRookie, nowSec: nowSec + 105 });
    assert.equal(rookieView1.body.data.pendingActivationRaw, '500000000000');
    assert.equal(rookieView1.body.data.pendingExpiresAt, (nowSec + 100) * 1000 + VOUCHER_TTL_MS);
    assert.equal(rookieView1.body.data.currentBet.status, 'LOST_FIRST_BONUS');

    // 4. 激活防线不变：未完成真实 5+ GRAM 内盘兑换前不可激活
    const actBlocked = await route({ method: 'POST', pathname: '/api/prediction/activate', headers: hRookie, body: {}, nowSec: nowSec + 110 });
    assert.equal(actBlocked.status, 400);
    assert.equal(actBlocked.body.error.code, 'ACTIVATION_REQUIREMENT_UNMET');

    // 5. 第 2 轮新人再次押错不再给保底
    await route({ method: 'POST', pathname: '/api/prediction/bet', headers: hRookie, body: { roundId: 2, side: 'BURN' }, nowSec: nowSec + 120 });
    const settle2 = await route({
      method: 'POST',
      pathname: '/api/admin/prediction/settle',
      headers: { 'x-a9-admin-token': 'adm-p0' },
      body: { roundId: 2, passed: true, actualQualified: 19 },
      nowSec: nowSec + 130,
    });
    assert.equal(settle2.body.data.firstLossBonusCount, 0);
    const rookieView2 = await route({ method: 'GET', pathname: '/api/prediction/user/me', query: { roundId: '2' }, headers: hRookie, nowSec: nowSec + 135 });
    assert.equal(rookieView2.body.data.pendingActivationRaw, '500000000000');
    assert.equal(rookieView2.body.data.currentBet.status, 'LOST');

    // 6. 完成 1 笔纯内盘 5 GRAM（10,010 A9）兑换确认 -> 成功激活 500 A9 进入 promo_balances
    const ord = (await route({ method: 'POST', pathname: '/api/presale/intent', headers: hRookie, body: { gramAmount: '5' }, nowSec: nowSec + 140 })).body.data;
    assert.equal(ord.a9AmountRaw, '10010000000000');
    assert.equal('skuId' in ord, false);
    await presaleEngine.ingestInbound({ txHash: 'tx-k2-5g', finality: 'finalized', to: HOT, from: 'EQ_ROOKIE_K2', valueNano: ord.payTonNano, memo: ord.memo }, nowSec + 145);
    await presaleEngine.queueConfirmedPayouts(nowSec + 146);
    await presaleEngine.processPayouts(nowSec + 147, { a9Broadcaster: async () => ({ txHash: 'out-k2-5g' }), verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }) });
    const actOk = await route({ method: 'POST', pathname: '/api/prediction/activate', headers: hRookie, body: {}, nowSec: nowSec + 150 });
    assert.equal(actOk.status, 200);
    assert.equal(actOk.body.data.activatedRaw, '500000000000');
    assert.equal((await promoEngine.getBalance('EQ_ROOKIE_K2')).claimableRaw, '500000000000');
  };

  await runSuite('memory', async () => ({
    predictionEngine: new PredictionEngine({ defaultPoolA9Raw: '10000000000000' }),
    presaleEngine: new PresaleHotWalletEngine({ hotWalletAddress: HOT, open: true }),
    promoEngine: new PromoHotWalletEngine({ hotWalletAddress: HOT }),
    socialStore: new SocialStore(),
    identityStore: new MemoryIdentityStore(),
  }));

  await runSuite('d1-sqlite', async () => {
    const db = createSqliteD1(MIGRATIONS);
    return {
      predictionEngine: new D1PredictionEngine({ db, defaultPoolA9Raw: '10000000000000' }),
      presaleEngine: new D1PresaleStore({ db, hotWalletAddress: HOT, open: true }),
      promoEngine: new D1PromoStore({ db, hotWalletAddress: HOT }),
      socialStore: new D1SocialStore({ db }),
      identityStore: new D1IdentityStore({ db }),
    };
  });

  const mf = await createMiniflareD1(MIGRATIONS);
  if (mf) {
    MF_DISPOSE.push(mf.dispose);
    await runSuite('d1-miniflare', async () => ({
      predictionEngine: new D1PredictionEngine({ db: mf.db, defaultPoolA9Raw: '10000000000000' }),
      presaleEngine: new D1PresaleStore({ db: mf.db, hotWalletAddress: HOT, open: true }),
      promoEngine: new D1PromoStore({ db: mf.db, hotWalletAddress: HOT }),
      socialStore: new D1SocialStore({ db: mf.db }),
      identityStore: new D1IdentityStore({ db: mf.db }),
    }));
  }
});

// ---------------------------------------------------------------------------
// Phase 5: Guild Telegram Group Real Permission Verification & startapp Deep-link First-Touch Attribution
// ---------------------------------------------------------------------------
await test('Phase 5: Guild TG group real permission verification (captain, bot-in-group, admin check, hijack prevention, expiry) & startapp attribution', async () => {
  // 1. startapp 深链解析单元测试
  assert.deepEqual(parseStartAppParam('invite_7101'), { raw: 'invite_7101', kind: 'invite', teamId: null, targetId: null, referrerId: '7101' });
  assert.deepEqual(parseStartAppParam('invite_G-PAPER_7101'), { raw: 'invite_G-PAPER_7101', kind: 'invite', teamId: 'G-PAPER', targetId: 'G-PAPER', referrerId: '7101' });
  assert.deepEqual(parseStartAppParam('invite_TM-0001_489f'), { raw: 'invite_TM-0001_489f', kind: 'invite', teamId: 'TM-0001', targetId: 'TM-0001', referrerId: '489f' });
  assert.deepEqual(parseStartAppParam('round_1_7101'), { raw: 'round_1_7101', kind: 'round', teamId: null, targetId: '1', referrerId: '7101' });
  assert.equal(parseStartAppParam('bad param with spaces!'), null);

  const runSuite = async (label, makeSocialAndIdentity) => {
    const { socialStore, identityStore } = await makeSocialAndIdentity();
    let mockTgState = {
      botInGroup: true,
      operatorIsAdmin: true,
      chatId: '-100555666777',
      groupHandle: '@warm_paper_guild',
    };
    const telegramGroupVerifier = async ({ tgChatId, tgGroupHandle }) => ({
      botInGroup: mockTgState.botInGroup,
      operatorIsAdmin: mockTgState.operatorIsAdmin,
      chatId: mockTgState.botInGroup ? (mockTgState.chatId || tgChatId || '-100555666777') : null,
      groupHandle: mockTgState.groupHandle || tgGroupHandle || null,
      reason: !mockTgState.botInGroup ? 'BOT_NOT_IN_GROUP' : (mockTgState.operatorIsAdmin ? 'OK' : 'NOT_GROUP_ADMIN'),
    });

    const { route } = buildRouter({ socialStore, identityStore, telegramGroupVerifier });
    const nowSec = 1_760_100_000;
    await identityStore.bindWallet('5501', 'EQ_CAP_P5', nowSec);
    await identityStore.bindWallet('5502', 'EQ_MEM_P5', nowSec);
    await identityStore.bindWallet('5503', 'EQ_CAP2_P5', nowSec);

    const hCap = await tgHeaders(5501, { nowSec });
    const hMem = await tgHeaders(5502, { nowSec });
    const hCap2 = await tgHeaders(5503, { nowSec });

    // 2. startapp 邀请归因：跨钱包别名自邀拦截、首次有效归因锁定、互邀环路拦截
    // 5501 尝试用自己的 TG ID 或自己已绑定的钱包 EQ_CAP_P5 自邀 -> bound 为 null, referrerId 为 null
    const selfTry1 = await route({ method: 'POST', pathname: '/api/referral/attribution', headers: hCap, body: { startapp: 'invite_5501' }, nowSec });
    assert.equal(selfTry1.body.data.bound, null, label);
    assert.equal(selfTry1.body.data.referrerId, null);

    const selfTry2 = await route({ method: 'POST', pathname: '/api/referral/attribution', headers: hCap, body: { startapp: 'invite_EQ_CAP_P5' }, nowSec });
    assert.equal(selfTry2.body.data.bound, null);
    assert.equal(selfTry2.body.data.referrerId, null);

    // 5502 首次通过 startapp: 'invite_G-P5_5501' 归因到 5501 -> 成功并同步绑定到 5502 及其钱包别名
    const attrOk = await route({ method: 'POST', pathname: '/api/referral/attribution', headers: hMem, body: { startapp: 'invite_G-P5_5501' }, nowSec });
    assert.equal(attrOk.status, 200);
    assert.equal(attrOk.body.data.referrerId, '5501');
    assert.equal(attrOk.body.data.parsed.teamId, 'G-P5');

    // 5502 再次点击 5503 的邀请链接 -> 保持首次归因 5501 不变
    const attrSecond = await route({ method: 'POST', pathname: '/api/referral/attribution', headers: hMem, body: { startapp: 'invite_5503' }, nowSec });
    assert.equal(attrSecond.body.data.referrerId, '5501');

    // 5501 尝试反向归因给 5502 -> 防环路拦截，bound 为 null, referrerId 保持 null
    const mutualTry = await route({ method: 'POST', pathname: '/api/referral/attribution', headers: hCap, body: { startapp: 'invite_5502' }, nowSec });
    assert.equal(mutualTry.body.data.bound, null);
    assert.equal(mutualTry.body.data.referrerId, null);

    // 3. 商会 TG 群绑定与真实权限核验
    // 会长 5501 提交 @warm_paper_guild -> 初始状态必须为 verifying（绝不直接 bound）
    const bindInit = await route({
      method: 'POST',
      pathname: '/api/team/bind-tg',
      headers: hCap,
      body: { teamId: 'G-P5', name: '暖棉纸冒险团', tgGroupHandle: '@warm_paper_guild' },
      nowSec,
    });
    assert.equal(bindInit.status, 200);
    assert.equal(bindInit.body.data.bindStatus, 'verifying');

    // 普通成员 5502 尝试触发核验 -> 403 NOT_CAPTAIN
    await route({ method: 'POST', pathname: '/api/team/join', headers: hMem, body: { teamId: 'G-P5' }, nowSec });
    const memVerify = await route({ method: 'POST', pathname: '/api/team/verify-tg', headers: hMem, body: { teamId: 'G-P5' }, nowSec });
    assert.equal(memVerify.status, 403);
    assert.equal(memVerify.body.error.code, 'NOT_CAPTAIN');

    // 场景 A：Bot 尚未进群 -> 400 BOT_NOT_IN_GROUP，状态仍为 verifying
    mockTgState.botInGroup = false;
    const botMissingRes = await route({ method: 'POST', pathname: '/api/team/verify-tg', headers: hCap, body: { teamId: 'G-P5' }, nowSec });
    assert.equal(botMissingRes.status, 400);
    assert.equal(botMissingRes.body.error.code, 'BOT_NOT_IN_GROUP');

    // 场景 B：Bot 在群内，但会长在群内不是管理员 -> 400 NOT_GROUP_ADMIN
    mockTgState.botInGroup = true;
    mockTgState.operatorIsAdmin = false;
    const notAdminRes = await route({ method: 'POST', pathname: '/api/team/verify-tg', headers: hCap, body: { teamId: 'G-P5' }, nowSec });
    assert.equal(notAdminRes.status, 400);
    assert.equal(notAdminRes.body.error.code, 'NOT_GROUP_ADMIN');

    // 场景 C：Bot 在群内且会长是管理员 -> 核验通过，转为 bound
    mockTgState.operatorIsAdmin = true;
    const verifyOk = await route({ method: 'POST', pathname: '/api/team/verify-tg', headers: hCap, body: { teamId: 'G-P5' }, nowSec });
    assert.equal(verifyOk.status, 200);
    assert.equal(verifyOk.body.data.bindStatus, 'bound');
    assert.equal(verifyOk.body.data.tgChatId, '-100555666777');

    // 场景 D：另一商会 G-OTHER 尝试冒用同一个 Telegram 群 (-100555666777) -> 400 GROUP_ALREADY_BOUND
    await route({
      method: 'POST',
      pathname: '/api/team/bind-tg',
      headers: hCap2,
      body: { teamId: 'G-OTHER', name: '冒用测试商会', tgGroupHandle: '@warm_paper_guild' },
      nowSec,
    });
    const hijackTry = await route({ method: 'POST', pathname: '/api/team/verify-tg', headers: hCap2, body: { teamId: 'G-OTHER' }, nowSec });
    assert.equal(hijackTry.status, 400);
    assert.equal(hijackTry.body.error.code, 'GROUP_ALREADY_BOUND');

    // 场景 E：已绑定群后续 Bot 被移出群或会长失去管理员权限 -> 重新核验将已绑定状态自动降级为 expired
    mockTgState.botInGroup = false;
    const lostPermRes = await route({ method: 'POST', pathname: '/api/team/verify-tg', headers: hCap, body: { teamId: 'G-P5' }, nowSec: nowSec + 60 });
    assert.equal(lostPermRes.status, 400);
    const teamAfterLost = await route({ method: 'GET', pathname: '/api/team/EQ_CAP_P5', headers: hCap, nowSec: nowSec + 61 });
    assert.equal(teamAfterLost.body.data.bindStatus, 'expired');
  };

  await runSuite('memory', async () => ({
    socialStore: new SocialStore(),
    identityStore: new MemoryIdentityStore(),
  }));

  await runSuite('d1-sqlite', async () => {
    const db = createSqliteD1(MIGRATIONS);
    return {
      socialStore: new D1SocialStore({ db }),
      identityStore: new D1IdentityStore({ db }),
    };
  });

  const mf = await createMiniflareD1();
  if (mf) {
    MF_DISPOSE.push(mf.dispose);
    await runSuite('d1-miniflare', async () => ({
      socialStore: new D1SocialStore({ db: mf.db }),
      identityStore: new D1IdentityStore({ db: mf.db }),
    }));
  }
});

// ---------------------------------------------------------------------------
// Knife 3: Telegram Squad Broadcast Bot + D1 Deduplication (0007) + >= 50 GRAM Pure Exchange Whale Alert
// ---------------------------------------------------------------------------
await test('Knife 3: TG squad broadcaster (disabled by default, bound-only targets, short startapp <=64B, D1 dedup, 4 climax events, whale >=50 GRAM only, non-blocking on API failure)', async () => {
  // 1. 短 ID startapp 深链绝不超 Telegram 64 字节上限
  const linkShort = buildTeamDeepLink({ botHandle: 'A9Bot', teamId: 'TM-0001', captainTgUserId: '880123456' });
  assert.ok(linkShort.includes('startapp=invite_TM-0001_880123456'));
  const startParamVal = new URL(linkShort).searchParams.get('startapp');
  assert.ok(startParamVal.length <= 64);
  assert.deepEqual(parseStartAppParam(startParamVal), {
    raw: 'invite_TM-0001_880123456',
    kind: 'invite',
    teamId: 'TM-0001',
    targetId: 'TM-0001',
    referrerId: '880123456',
  });

  const runSuite = async (label, makeDeps) => {
    const sentCalls = [];
    let failTelegramApi = false;
    const mockFetch = async (url, opts) => {
      if (failTelegramApi) throw new Error('TG_NETWORK_TIMEOUT');
      const body = JSON.parse(opts.body);
      sentCalls.push({ url, body });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: sentCalls.length } }) };
    };

    const { socialStore, identityStore, dedupLog, makePresale } = await makeDeps();
    const nowSec = 1_760_300_000;
    await identityStore.bindWallet('7701', 'EQ_CAP_BOUND', nowSec);
    await identityStore.bindWallet('7702', 'EQ_MEM_WHALE', nowSec);
    await identityStore.bindWallet('7703', 'EQ_CAP_UNVERIFIED', nowSec);

    // 建 2 个战队：TM-BOUND（四重核验通过 bound）与 TM-VERIFYING（未核验 verifying）
    await socialStore.createOrBindTeamGroup({ teamId: 'TM-BOUND', name: '金箔战队', captainWallet: 'EQ_CAP_BOUND', tgGroupHandle: '@bound_guild' }, nowSec);
    await socialStore.verifyTeamGroupBinding({
      teamId: 'TM-BOUND',
      captainWallet: 'EQ_CAP_BOUND',
      telegramUserId: '7701',
      telegramVerifier: async () => ({ botInGroup: true, operatorIsAdmin: true, chatId: '-100888999', groupHandle: '@bound_guild' }),
    }, nowSec);
    await socialStore.joinTeam({ teamId: 'TM-BOUND', walletAddress: 'EQ_MEM_WHALE' }, nowSec);

    await socialStore.createOrBindTeamGroup({ teamId: 'TM-VERIFYING', name: '待核验战队', captainWallet: 'EQ_CAP_UNVERIFIED', tgGroupHandle: '@unverified_guild' }, nowSec);

    // 默认关闭开关（enabled: false）时绝不发送任何网络请求
    const disabledBot = new TelegramBroadcaster({
      enabled: false,
      botToken: TEST_BOT_TOKEN,
      socialStore,
      identityStore,
      dedupLog,
      fetchImpl: mockFetch,
      delayMs: 0,
    });
    const offRes = await disabledBot.broadcastRoundOpen({ roundId: 1, round: { status: 1, stakeCloseAt: nowSec + 3600 }, nowSec });
    assert.equal(offRes.skipped, true, label);
    assert.equal(sentCalls.length, 0);

    // 开启播报器
    const bot = new TelegramBroadcaster({
      enabled: true,
      botToken: TEST_BOT_TOKEN,
      botHandle: 'A9Bot',
      publicOrigin: 'https://a9.example',
      officialChannelId: '-100111222',
      whaleMinGram: 50,
      socialStore,
      identityStore,
      dedupLog,
      fetchImpl: mockFetch,
      delayMs: 0,
      logger: { error() {} },
    });

    // 事件 ①：新轮开启（2.0x 早鸟），仅发给 bound 群 (-100888999) + 官方频道 (-100111222)，绝不发给 verifying 群
    const open1 = await bot.processRoundSnapshot({
      roundId: 3,
      round: { status: 1, stakeCloseAt: nowSec + 43200, targetPriceUsdE8: '18500000', rewardBudgetRaw: '700000000000000000' },
      nowSec,
    });
    assert.equal(open1[0].sentCount, 2);
    assert.equal(sentCalls.length, 2);
    const guildMsg = sentCalls.find((c) => c.body.chat_id === '-100888999');
    assert.ok(guildMsg.body.reply_markup.inline_keyboard[0][0].url.includes('startapp=invite_TM-BOUND_7701'));

    // 多实例重复巡检同一轮次 -> D1 去重表直接拦截，sentCalls 不增加
    const bot2 = new TelegramBroadcaster({
      enabled: true,
      botToken: TEST_BOT_TOKEN,
      botHandle: 'A9Bot',
      publicOrigin: 'https://a9.example',
      officialChannelId: '-100111222',
      socialStore,
      identityStore,
      dedupLog,
      fetchImpl: mockFetch,
      delayMs: 0,
    });
    const openDup = await bot2.processRoundSnapshot({
      roundId: 3,
      round: { status: 1, stakeCloseAt: nowSec + 43200, targetPriceUsdE8: '18500000', rewardBudgetRaw: '700000000000000000' },
      nowSec: nowSec + 10,
    });
    assert.equal(openDup[0].skipped, true);
    assert.equal(openDup[0].reason, 'DUPLICATE');
    assert.equal(sentCalls.length, 2);

    // 事件 ③：最后 4 小时警报（时间驱动，无实时 K 线也可触发，每轮最多推 1 次）
    const sprintRes = await bot.processRoundSnapshot({
      roundId: 3,
      round: { status: 1, stakeCloseAt: nowSec - 75600, targetPriceUsdE8: '18500000' }, // 距 24H 结束还剩 3 小时 (10800s <= 14400s)
      candles: [],
      nowSec,
      observationSeconds: 86400,
    });
    assert.equal(sprintRes[0].eventKey, 'sprint:3');
    assert.equal(sprintRes[0].sentCount, 2);
    assert.equal(sentCalls.length, 4);

    // 事件 ④：结算战报（未通关销毁 BURN），附带 /c/img/burn/3.png 动态图
    const settleRes = await bot.processRoundSnapshot({
      roundId: 3,
      round: { status: 3, qualifiedCandles: 14, rewardBudgetRaw: '700000000000000000' },
      nowSec: nowSec + 12000,
    });
    assert.equal(settleRes[0].eventKey, 'settle:3');
    assert.equal(settleRes[0].sentCount, 2);
    assert.ok(sentCalls[sentCalls.length - 1].url.endsWith('/sendPhoto'));
    assert.equal(sentCalls[sentCalls.length - 1].body.photo, 'https://a9.example/c/img/burn/3.png');

    // 事件 ②：纯内盘大额兑换确认成交（< 50 GRAM 不推；>= 50 GRAM 仅推买家所属 bound 群；TG 故障绝不阻塞主链路）
    const presale = makePresale(bot);
    // 10 GRAM 小单 -> 不推送
    const oSmall = await presale.createOrderIntent('EQ_MEM_WHALE', '10', nowSec);
    await presale.ingestInbound({ txHash: 'tx-small-10', finality: 'finalized', to: HOT, from: 'EQ_MEM_WHALE', valueNano: oSmall.payTonNano, memo: oSmall.memo }, nowSec + 1);
    await presale.queueConfirmedPayouts(nowSec + 2);
    await presale.processPayouts(nowSec + 3, { a9Broadcaster: async () => ({ txHash: 'out-small-10' }), verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }) });
    const countBeforeWhale = sentCalls.length;

    // 50 GRAM 大单 -> 仅向买家所属战队群 (-100888999) 推 1 条捷报
    const oWhale = await presale.createOrderIntent('EQ_MEM_WHALE', '50', nowSec + 10);
    await presale.ingestInbound({ txHash: 'tx-whale-50', finality: 'finalized', to: HOT, from: 'EQ_MEM_WHALE', valueNano: oWhale.payTonNano, memo: oWhale.memo }, nowSec + 11);
    await presale.queueConfirmedPayouts(nowSec + 12);
    await presale.processPayouts(nowSec + 13, { a9Broadcaster: async () => ({ txHash: 'out-whale-50' }), verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }) });
    assert.equal(sentCalls.length, countBeforeWhale + 1);
    const whaleCall = sentCalls[sentCalls.length - 1];
    assert.equal(whaleCall.body.chat_id, '-100888999');
    assert.ok(whaleCall.body.text.includes('50 GRAM'));
    assert.ok(whaleCall.body.text.includes('100,100 A9'));

    // Telegram API 故障时绝不阻塞主链路的 COMPLETED 状态确认
    failTelegramApi = true;
    const oFailPush = await presale.createOrderIntent('EQ_MEM_WHALE', '60', nowSec + 20);
    await presale.ingestInbound({ txHash: 'tx-whale-60', finality: 'finalized', to: HOT, from: 'EQ_MEM_WHALE', valueNano: oFailPush.payTonNano, memo: oFailPush.memo }, nowSec + 21);
    await presale.queueConfirmedPayouts(nowSec + 22);
    await presale.processPayouts(nowSec + 23, { a9Broadcaster: async () => ({ txHash: 'out-whale-60' }), verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }) });
    assert.equal((await presale.getOrder(oFailPush.orderId)).status, PRESALE_STATUS.COMPLETED);
  };

  await runSuite('memory', async () => {
    const socialStore = new SocialStore();
    const identityStore = new MemoryIdentityStore();
    const dedupLog = new MemoryBroadcastLog();
    return {
      socialStore,
      identityStore,
      dedupLog,
      makePresale: (broadcaster) => new PresaleHotWalletEngine({ hotWalletAddress: HOT, open: true, socialStore, broadcaster }),
    };
  });

  await runSuite('d1-sqlite', async () => {
    const db = createSqliteD1(MIGRATIONS);
    const socialStore = new D1SocialStore({ db });
    const identityStore = new D1IdentityStore({ db });
    const dedupLog = new D1BroadcastLog({ db });
    return {
      socialStore,
      identityStore,
      dedupLog,
      makePresale: (broadcaster) => new D1PresaleStore({ db, hotWalletAddress: HOT, open: true, socialStore, broadcaster }),
    };
  });

  const mf = await createMiniflareD1(MIGRATIONS);
  if (mf) {
    MF_DISPOSE.push(mf.dispose);
    await runSuite('d1-miniflare', async () => {
      const socialStore = new D1SocialStore({ db: mf.db });
      const identityStore = new D1IdentityStore({ db: mf.db });
      const dedupLog = new D1BroadcastLog({ db: mf.db });
      return {
        socialStore,
        identityStore,
        dedupLog,
        makePresale: (broadcaster) => new D1PresaleStore({ db: mf.db, hotWalletAddress: HOT, open: true, socialStore, broadcaster }),
      };
    });
  }
});

// ---------------------------------------------------------------------------
// Batch 1 (D1 SQLite + Miniflare/workerd): Atomic activateToPromo rollback & same-DB ledger guard
// ---------------------------------------------------------------------------
await test('Batch 1 (SQLite + workerd D1): activateToPromo rejects missing/cross-ledger promo before write and rolls back all 3 tables on last-write failure', async () => {
  const runAtomicSuite = async (label, rawDb) => {
    const hash = new Uint8Array(32).fill(0x44);
    const wBounce = formatTonAddress(0, hash, { bounceable: true, testOnly: false });
    const wRaw = `0:${'44'.repeat(32)}`;
    const promo = new D1PromoStore({ db: rawDb, hotWalletAddress: HOT });
    const memPromo = new PromoHotWalletEngine({ hotWalletAddress: HOT });
    const pred = new D1PredictionEngine({ db: rawDb, defaultPoolA9Raw: '15000000000000000000' });

    await pred.placeBet({ roundId: 1, userId: 'u_b1', side: 'PASS' }, 1000);
    await pred.settleRoundBets(1, true, 18, '15000000000000000000', 1_100_000);

    // 1) Missing or cross-ledger promo -> fails BEFORE any write; all 3 tables untouched
    await assert.rejects(() => pred.activateToPromo('u_b1', wBounce, null, { qualified: true, nowMs: 1_150_000, activationId: 'b1-no-promo' }), { code: 'PROMO_LEDGER_UNAVAILABLE' }, label);
    await assert.rejects(() => pred.activateToPromo('u_b1', wBounce, memPromo, { qualified: true, nowMs: 1_150_000, activationId: 'b1-cross' }), { code: 'PROMO_LEDGER_UNAVAILABLE' }, label);
    assert.equal((await pred.getUserSummary('u_b1', 1)).pendingActivationRaw, '15000000000000000000', label);
    assert.equal(Number((await rawDb.prepare('SELECT COUNT(*) AS c FROM prediction_activations').first()).c), 0, label);
    assert.equal(Number((await rawDb.prepare('SELECT COUNT(*) AS c FROM promo_balances').first()).c), 0, label);

    // 2) Sabotage the 3rd statement (UPDATE promo_balances) AFTER stmts[0] and stmts[1] execute -> ALL 3 tables roll back
    await promo.creditReward(wRaw, '1000000000000', 900);
    let sabotageOnce = true;
    const flakyDb = {
      prepare: (sql) => rawDb.prepare(sql),
      async batch(stmts) {
        if (sabotageOnce && stmts.length === 3) {
          sabotageOnce = false;
          return rawDb.batch([stmts[0], stmts[1], rawDb.prepare('UPDATE __nonexistent_b1_crash SET x = 1')]);
        }
        return rawDb.batch(stmts);
      },
    };
    const flakyPred = new D1PredictionEngine({ db: flakyDb, defaultPoolA9Raw: '15000000000000000000' });
    const flakyPromo = new D1PromoStore({ db: flakyDb, hotWalletAddress: HOT });
    await assert.rejects(
      () => flakyPred.activateToPromo('u_b1', wBounce, flakyPromo, { qualified: true, nowMs: 1_200_000, activationId: 'b1-rollback-1' }),
      /__nonexistent_b1_crash|no such table/i,
      label,
    );
    assert.equal((await pred.getUserSummary('u_b1', 1)).pendingActivationRaw, '15000000000000000000', label);
    assert.equal((await pred.getUserSummary('u_b1', 1)).activatedRaw, '0', label);
    assert.equal(Number((await rawDb.prepare('SELECT COUNT(*) AS c FROM prediction_activations WHERE activation_id = ?').bind('b1-rollback-1').first()).c), 0, label);
    assert.equal((await promo.getBalance(wRaw)).claimableRaw, '1000000000000', label);

    // 3) Retry succeeds ONCE and duplicate retry returns idempotent: true with zero extra credit
    const ok1 = await pred.activateToPromo('u_b1', wBounce, promo, { qualified: true, nowMs: 1_205_000, activationId: 'b1-rollback-1' });
    assert.equal(ok1.activatedRaw, '15000000000000000000', label);
    assert.equal(ok1.idempotent, false, label);
    assert.equal((await pred.getUserSummary('u_b1', 1)).pendingActivationRaw, '0', label);
    assert.equal((await promo.getBalance(wBounce)).claimableRaw, '15000001000000000000', label);
    const ok2 = await pred.activateToPromo('u_b1', wBounce, promo, { qualified: true, nowMs: 1_206_000, activationId: 'b1-rollback-1' });
    assert.equal(ok2.idempotent, true, label);
    assert.equal((await promo.getBalance(wBounce)).claimableRaw, '15000001000000000000', label);
  };

  await runAtomicSuite('d1-sqlite', createSqliteD1(MIGRATIONS));
  const mf = await createMiniflareD1(MIGRATIONS);
  if (mf) {
    MF_DISPOSE.push(mf.dispose);
    await runAtomicSuite('d1-miniflare', mf.db);
  }
});

for (const d of MF_DISPOSE) await d();
console.log(`All ${passed} phase-1 P0 security tests passed.`);
