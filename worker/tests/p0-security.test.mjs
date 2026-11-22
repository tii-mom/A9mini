#!/usr/bin/env node
// Phase 1 / P0 security & money-safety tests (task book §10.2: identity + A9 fixed exchange).
// Run: node worker/tests/p0-security.test.mjs   (Node >= 22.5 for node:sqlite)
import assert from 'node:assert/strict';
import { createApiRouter } from '../src/api.mjs';
import { MemoryIdentityStore, D1IdentityStore, signTelegramInitData, verifyTelegramInitData } from '../src/auth.mjs';
import { PresaleHotWalletEngine, PRESALE_STATUS, STALE_BROADCAST_SEC } from '../src/presale-hotwallet.mjs';
import { D1PresaleStore, D1SocialStore } from '../src/d1-growth-store.mjs';
import { PresalePayoutRunner } from '../src/presale-runner.mjs';
import { PromoHotWalletEngine } from '../src/promo-hotwallet.mjs';
import { SocialStore } from '../src/social-store.mjs';
import { PredictionEngine } from '../src/growth-engine.mjs';
import { parseDecimalUnits, formatUnits } from '../src/money.mjs';
import { normalizeTonAddress } from '../src/ton-address.mjs';
import { TEST_BOT_TOKEN, tgHeaders, createSqliteD1, FRESH_SCHEMA, MIGRATIONS, completePurchase, dumpDb, createMiniflareD1, makeV4R2Wallet, signTonProof, PROOF_FIXTURES } from './helpers/test-env.mjs';
import { verifyTonProof, REBIND_DELAY_SEC, TON_PROOF_MAX_SKEW_SEC } from '../src/auth.mjs';
import { inspectWalletStateInit } from '../src/ton-cell.mjs';

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
  const presaleEngine = extra.presaleEngine || new PresaleHotWalletEngine({ hotWalletAddress: HOT });
  const socialStore = extra.socialStore || new SocialStore();
  const predictionEngine = extra.predictionEngine || new PredictionEngine();
  const route = createApiRouter({ env: ENV, stateStore, identityStore, promoEngine, presaleEngine, socialStore, predictionEngine, ...extra });
  return { route, identityStore, promoEngine, presaleEngine, socialStore, predictionEngine };
}

/** Both storage backends must behave identically. */
const BACKENDS = [
  ['memory', async (opts) => new PresaleHotWalletEngine({ hotWalletAddress: HOT, ...opts })],
  ['d1-sqlite', async (opts) => {
    const db = opts.db || createSqliteD1(FRESH_SCHEMA);
    const e = new D1PresaleStore({ db, hotWalletAddress: HOT, ...opts });
    e._db = db;
    return e;
  }],
];
const MF_DISPOSE = [];
if (await createMiniflareD1().then((mf) => { if (mf) MF_DISPOSE.push(mf.dispose); return Boolean(mf); })) {
  BACKENDS.push(['d1-miniflare', async (opts) => {
    const mf = await createMiniflareD1();
    MF_DISPOSE.push(mf.dispose);
    const e = new D1PresaleStore({ db: mf.db, hotWalletAddress: HOT, ...opts });
    e._db = mf.db;
    return e;
  }]);
} else {
  console.log('  SKIP  [d1-miniflare] backend: `miniflare` not installed (npm i -D miniflare to run against real D1/workerd)');
}
const dumpOf = async (e) => (e._db ? dumpDb(e._db) : e.repo.snapshot());
const inbound = (order, extra = {}) => ({ txHash: `in-${order.orderId}`, finality: 'finalized', to: HOT, from: order.walletAddress, valueNano: order.tonNano, memo: order.memo, ...extra });

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
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT });
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
      ['thief', 'sender_mismatch', 'EQ_SOMEONE_ELSE', '10000000000'],
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

  await test(`[${name}] expired order paid late -> passive full refund; refund broadcast failure retries then confirms`, async () => {
    const e = await make({});
    const o = await e.createOrderIntent('EQ_LATE', '5', 1000);
    const late = await e.ingestInbound(inbound(o), 1000 + 31 * 60);
    assert.equal(late.action, 'REFUND');
    assert.equal(late.reason, 'expired');
    assert.equal(late.refundNano, 5_000_000_000n);
    const t = 1000 + 32 * 60;
    let n = 0;
    const flaky = async (inst) => { n += 1; if (n === 1) throw Object.assign(new Error('rpc down'), { notSent: true }); assert.equal(inst.tonNano, '5000000000'); return { txHash: 'refund-tx' }; };
    await e.processPayouts(t, { refundBroadcaster: flaky });
    assert.equal((await e.getOrder(o.orderId)).status, PRESALE_STATUS.REFUND_PENDING);
    await e.processPayouts(t + 1, { refundBroadcaster: flaky });
    assert.equal((await e.getOrder(o.orderId)).status, PRESALE_STATUS.REFUND_SENT);
    await e.processPayouts(t + 2, { refundBroadcaster: flaky, verifier: async () => ({ state: 'CONFIRMED' }) });
    assert.equal((await e.getOrder(o.orderId)).status, PRESALE_STATUS.REFUNDED);
    assert.equal(n, 2);
  });

  await test(`[${name}] anomaly resolution: SYSTEM/UNKNOWN fault = full refund to the payer; USER fee only with a published rule; resolves exactly once`, async () => {
    const e = await make({});
    const o = await e.createOrderIntent('EQ_ANOM', '10', 1000);
    await e.ingestInbound(inbound(o, { txHash: 'short', valueNano: '9000000000' }), 1001);
    await e.ingestInbound({ txHash: 'stray', finality: 'finalized', to: HOT, from: 'EQ_STRANGER', valueNano: '3000000000', memo: 'hello' }, 1002);
    await assert.rejects(e.resolveAnomaly('short', { decision: 'REFUND', faultParty: 'USER', operator: 'ops' }, 1003), { code: 'FEE_RULE_NOT_PUBLISHED' });
    await assert.rejects(e.resolveAnomaly('short', { decision: 'REFUND', faultParty: 'SYSTEM' }, 1003), { code: 'BAD_REQUEST' });
    const both = await Promise.allSettled([
      e.resolveAnomaly('short', { decision: 'REFUND', faultParty: 'SYSTEM', operator: 'ops', note: 'system' }, 1004),
      e.resolveAnomaly('short', { decision: 'REFUND', faultParty: 'SYSTEM', operator: 'ops2', note: 'dup' }, 1004),
    ]);
    assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(both.find((r) => r.status === 'fulfilled').value.refundNano, '9000000000');
    assert.equal((await e.getOrder(o.orderId)).status, PRESALE_STATUS.REFUND_PENDING);
    const refunds = (await e.repo.listOpenPayouts()).filter((p) => p.kind === 'REFUND');
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].recipient, 'EQ_ANOM');
    assert.equal(refunds[0].amount, '9000000000');

    const published = await make({ userFaultFeeNano: '50000000' });
    await published.ingestInbound({ txHash: 'stray2', finality: 'finalized', to: HOT, from: 'EQ_STRANGER', valueNano: '3000000000', memo: '' }, 1002);
    const r = await published.resolveAnomaly('stray2', { decision: 'REFUND', faultParty: 'USER', operator: 'ops', note: 'no memo' }, 1005);
    assert.equal(r.feeNano, '50000000');
    assert.equal(r.refundNano, '2950000000');
    assert.equal(r.recipient, 'EQ_STRANGER');
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
}

await test('[d1-sqlite] restart after broadcast: new process resumes from DB, confirms without re-sending', async () => {
  const db = createSqliteD1(FRESH_SCHEMA);
  const e1 = new D1PresaleStore({ db, hotWalletAddress: HOT });
  const o = await e1.createOrderIntent('EQ_RESTART', '5', 1000);
  await e1.ingestInbound(inbound(o), 1001);
  await e1.queueConfirmedPayouts(1002);
  await e1.processPayouts(1003, { a9Broadcaster: async () => ({ txHash: 'sent-before-crash' }) });
  assert.equal((await e1.getOrder(o.orderId)).status, PRESALE_STATUS.PAYOUT_SENT);

  const e2 = new D1PresaleStore({ db, hotWalletAddress: HOT }); // "restarted process"
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
  const e3 = new D1PresaleStore({ db, hotWalletAddress: HOT });
  let sends = 0;
  const bc = async () => { sends += 1; return { txHash: 'resent' }; };
  await e3.processPayouts(2010, { a9Broadcaster: bc, verifier: async () => ({ state: 'NOT_FOUND' }) });
  assert.equal(sends, 0); // still inside stale window: wait
  await e3.processPayouts(2003 + STALE_BROADCAST_SEC, { a9Broadcaster: bc, verifier: async (q) => (q.txHash ? { state: 'CONFIRMED' } : { state: 'NOT_FOUND' }) });
  assert.equal(sends, 1);
  assert.equal((await e3.getOrder(o2.orderId)).status, PRESALE_STATUS.COMPLETED);
});

await test('[d1-sqlite] migration from the v15 baseline keeps legacy rows; legacy PAID_A9 is not treated as confirmed', async () => {
  const db = createSqliteD1([MIGRATIONS[0]]);
  await db.prepare(`INSERT INTO presale_orders (order_id, wallet_address, referrer_id, ton_nano, a9_amount_raw, memo, status, inbound_tx_hash, payout_tx_hash, refund_ton_nano, created_at, updated_at)
    VALUES ('legacy1', 'EQ_LEGACY', NULL, '5000000000', '10010000000000', 'buy:legacy1', 'PAID_A9', 'in-legacy', NULL, '0', 100, 100)`).run();
  for (const m of MIGRATIONS.slice(1)) db.exec((await import('node:fs')).readFileSync(new URL(m, new URL('./helpers/test-env.mjs', import.meta.url)), 'utf8'));
  const e = new D1PresaleStore({ db, hotWalletAddress: HOT, defaultQuotaTon: 7n });
  const [legacy] = await e.listOrders('EQ_LEGACY');
  assert.equal(legacy.legacyStatus, 'PAID_A9');
  assert.equal(legacy.status, PRESALE_STATUS.NEEDS_REVIEW);
  assert.equal(await e.hasCompletedPurchase('EQ_LEGACY'), false);
  // Legacy paid volume still counts against the wallet quota (7 GRAM quota, 5 already used).
  await assert.rejects(e.createOrderIntent('EQ_LEGACY', '5', 200), { code: 'OVER_QUOTA' });
});

await test('ineligible user (payout only broadcast, not confirmed) cannot activate A9 prediction reward', async () => {
  const pred = new PredictionEngine({ defaultPoolA9Raw: '10000000000000' });
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT });
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
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT });
  const { route } = buildRouter({ presaleEngine: presale });
  await presale.ingestInbound({ txHash: 'adm-1', finality: 'finalized', to: HOT, from: 'EQ_PAYER', valueNano: '7000000000', memo: 'buy:nope' }, 100);
  assert.equal((await route({ method: 'GET', pathname: '/api/admin/presale/anomalies', nowSec: 101 })).status, 401);
  const list = await route({ method: 'GET', pathname: '/api/admin/presale/anomalies', headers: { 'x-a9-admin-token': 'adm-p0' }, nowSec: 101 });
  assert.equal(list.body.data.length, 1);
  const res = await route({ method: 'POST', pathname: '/api/admin/presale/anomalies/adm-1/resolve', headers: { 'x-a9-admin-token': 'adm-p0' }, body: { decision: 'REFUND', faultParty: 'SYSTEM', operator: 'ops-alice', note: 'memo typo by our UI' }, nowSec: 102 });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.refundNano, '7000000000');
  const [row] = await presale.listAnomalies(null);
  assert.equal(row.resolvedBy, 'ops-alice');
  assert.equal(row.faultParty, 'SYSTEM');
});

for (const d of MF_DISPOSE) await d();
console.log(`All ${passed} phase-1 P0 security tests passed.`);
