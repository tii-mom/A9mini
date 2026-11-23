// A9 Protocol v15 — Chest Mall & Viral Social Assist Full-Stack Tests (Memory + SQLite D1).
import assert from 'node:assert/strict';
import { ChestEngine, CHEST_MALL_CATALOG, CAPTAIN_FOUNDING_BONUS_RAW } from '../src/chest-engine.mjs';
import { D1ChestEngine } from '../src/d1-chest-store.mjs';
import { PresaleHotWalletEngine, PASSIVE_FREE_MIN_NANO } from '../src/presale-hotwallet.mjs';
import { PromoHotWalletEngine } from '../src/promo-hotwallet.mjs';
import { PredictionEngine } from '../src/growth-engine.mjs';
import { SocialStore, parseStartAppParam } from '../src/social-store.mjs';
import { TelegramBroadcaster } from '../src/tg-broadcaster.mjs';
import { createApiRouter } from '../src/api.mjs';
import { MemoryIdentityStore } from '../src/auth.mjs';
import { makeInitData, createSqliteD1 } from './helpers/test-env.mjs';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

const BOT_TOKEN = '123456:TEST_BOT_TOKEN_CHEST';
const HOT_WALLET = '0:1111111111111111111111111111111111111111111111111111111111111111';
const W_OWNER = '0:2222222222222222222222222222222222222222222222222222222222222222';
const W_H1 = '0:3333333333333333333333333333333333333333333333333333333333333333';
const W_H2 = '0:4444444444444444444444444444444444444444444444444444444444444444';
const W_H3 = '0:5555555555555555555555555555555555555555555555555555555555555555';

console.log('Running A9 v15 Chest Mall & Viral Assist tests...');

await test('5 Chest Mall SKUs exact fixed-rate pricing & 0.99 GRAM passive free refund boundary', async () => {
  assert.equal(PASSIVE_FREE_MIN_NANO, 990_000_000n);
  assert.equal(CHEST_MALL_CATALOG.chest_bronze.baseA9, '1981.98');
  assert.equal(CHEST_MALL_CATALOG.chest_silver.baseA9, '9989.98');
  assert.equal(CHEST_MALL_CATALOG.chest_gold.baseA9, '19999.98');
  assert.equal(CHEST_MALL_CATALOG.chest_platinum.baseA9, '40019.98');
  assert.equal(CHEST_MALL_CATALOG.chest_diamond.baseA9, '200179.98');

  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT_WALLET, open: true });
  const ord = await presale.createOrderIntent(W_OWNER, null, 1000, { skuId: 'chest_bronze', openMode: 'BOOST', tgUserId: '1001' });
  assert.equal(ord.skuId, 'chest_bronze');
  assert.equal(ord.openMode, 'BOOST');
  assert.equal(ord.tonNano, '990000000');
  assert.equal(ord.a9AmountRaw, '1981980000000');

  // Expired 0.99 GRAM Bronze Chest order paid late -> full passive free refund (0 fee)
  const latePlan = await presale.planInbound(
    { txHash: 'tx_late_099', finality: 'finalized', to: HOT_WALLET, from: W_OWNER, valueNano: '990000000', memo: ord.memo },
    ord.expiresAt + 10,
  );
  assert.equal(latePlan.action, 'REFUND');
  assert.equal(latePlan.refundNano, 990_000_000n);
  assert.equal(latePlan.feeDeducted, false);
});

await test('Serial Bronze #1/#2/#3 chests, active-wallet anti-sybil, helper auto-starter & next-slot unlock', async () => {
  const chest = new ChestEngine();
  const pred = new PredictionEngine();
  const starter = await chest.claimStarterBronzeChests({ userId: '1001', walletAddress: W_OWNER }, 1000);
  assert.equal(starter.created, true);
  assert.equal(starter.chests[0].status, 'ACTIVE');
  assert.equal(starter.chests[1].status, 'LOCKED');
  assert.equal(starter.chests[2].status, 'LOCKED');
  const b1 = starter.chests[0];

  // Inactive empty wallet must be rejected
  await assert.rejects(
    () => chest.assistChest({ chestId: b1.chestId, helperUserId: '2001', helperWalletAddress: W_H1, walletActive: false }, 1010),
    (e) => e.code === 'WALLET_NOT_ACTIVE',
  );
  // Self-assist must be rejected
  await assert.rejects(
    () => chest.assistChest({ chestId: b1.chestId, helperUserId: '1001', helperWalletAddress: W_OWNER, walletActive: true }, 1011),
    (e) => e.code === 'SELF_ASSIST_FORBIDDEN',
  );

  // Two active helpers unlock Bronze #1 and auto-receive their own starter Bronze #1
  const a1 = await chest.assistChest({ chestId: b1.chestId, helperUserId: '2001', helperWalletAddress: W_H1, walletActive: true }, 1012);
  assert.equal(a1.helperGrantedStarter, true);
  assert.equal(a1.helperBronzeChest.tier, 'bronze');
  assert.equal(a1.chest.currentAssists, 1);

  // Same wallet cannot assist same chest twice
  await assert.rejects(
    () => chest.assistChest({ chestId: b1.chestId, helperUserId: '2001', helperWalletAddress: W_H1, walletActive: true }, 1013),
    (e) => e.code === 'ALREADY_ASSISTED',
  );

  const a2 = await chest.assistChest({ chestId: b1.chestId, helperUserId: '2002', helperWalletAddress: W_H2, walletActive: true }, 1014);
  assert.equal(a2.chest.status, 'READY');

  // Open Bronze #1 -> credits 300 A9 to pending vault & unlocks Bronze #2
  const opened = await chest.openChest({ chestId: b1.chestId, userId: '1001', walletAddress: W_OWNER, predictionEngine: pred }, 1020);
  assert.equal(opened.rewardA9Raw, '300000000000');
  assert.equal(opened.destination, 'PENDING_VAULT');
  assert.equal(opened.nextUnlocked.tier, 'bronze');
  assert.equal(opened.nextUnlocked.slotIndex, 2);
  assert.equal(opened.nextUnlocked.status, 'ACTIVE');
  assert.equal(pred.getUserSummary('1001').pendingActivationRaw, '300000000000');
});

await test('Shop Boost Chest: confirmed order creates 24h boost chest, assists inflate A9, stoppable anytime & DM commission alert', async () => {
  const chest = new ChestEngine();
  const promo = new PromoHotWalletEngine({ hotWalletAddress: HOT_WALLET });
  const identityStore = new MemoryIdentityStore();
  await identityStore.bindVerifiedWallet('9001', W_H3, 1000);
  const dmSent = [];
  const broadcaster = new TelegramBroadcaster({
    enabled: true,
    botToken: BOT_TOKEN,
    identityStore,
    delayMs: 0,
    fetchImpl: async (url, opts) => {
      dmSent.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: dmSent.length } }) };
    },
  });
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT_WALLET, open: true, promoEngine: promo, chestEngine: chest, broadcaster });

  const ord = await presale.createOrderIntent(W_OWNER, null, 1000, { skuId: 'chest_gold', openMode: 'BOOST', tgUserId: '1001', referrerId: W_H3 });
  await presale.ingestInbound({ txHash: 'tx_gold_in', finality: 'finalized', to: HOT_WALLET, from: W_OWNER, valueNano: '9990000000', memo: ord.memo }, 1010);
  await presale.queueConfirmedPayouts(1015);
  await presale.processPayouts(1020, {
    a9Broadcaster: async () => ({ txHash: 'tx_gold_out' }),
    verifier: async () => ({ state: 'CONFIRMED', txHash: 'tx_gold_out' }),
  });

  // Boost chest created automatically with +1% initial boost
  const mine = await chest.listUserChests('1001');
  assert.equal(mine.shopChests.length, 1);
  const sc = mine.shopChests[0];
  assert.equal(sc.tier, 'gold');
  assert.ok(BigInt(sc.boostA9Raw) > 0n);

  // 1 helper inflates boost, owner can stop & open anytime to claim boost to promo balance
  const ast = await chest.assistChest({ chestId: sc.chestId, helperUserId: '2001', helperWalletAddress: W_H1, walletActive: true }, 1030);
  assert.ok(BigInt(ast.boostDeltaRaw) > 0n);
  const res = await chest.openChest({ chestId: sc.chestId, userId: '1001', walletAddress: W_OWNER, promoEngine: promo }, 1040);
  assert.equal(res.destination, 'PROMO_BALANCE');
  assert.equal((await promo.getBalance(W_OWNER)).claimableRaw, res.rewardA9Raw);

  // Referral credit triggers DM commission alert to captain/referrer
  await presale.processReferralCredits(1050);
  assert.equal(dmSent.length, 1);
  assert.equal(dmSent[0].body.chat_id, '9001');
  assert.match(dmSent[0].body.text, /返佣到账提醒/);
});

await test('Direct paid invitee unlocks referrer vault (0 GRAM self-spend) & Captain >=50 TG members gets 5,000 A9 founding bonus', async () => {
  const social = new SocialStore();
  const pred = new PredictionEngine();
  const promo = new PromoHotWalletEngine({ hotWalletAddress: HOT_WALLET });
  const chest = new ChestEngine();
  const identityStore = new MemoryIdentityStore();
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT_WALLET, open: true, promoEngine: promo, socialStore: social, chestEngine: chest });

  await identityStore.bindVerifiedWallet('1001', W_OWNER, 1000);
  await identityStore.bindVerifiedWallet('2001', W_H1, 1000);
  // 模拟真实场景：好友 2001 先通过 TG 深链归因（仅绑定 TG ID，未带钱包别名），后连接钱包购箱
  social.bindReferral('2001', '1001', 1005);
  pred.creditPendingBonus('1001', 500_000_000_000n, 1005 * 1000);

  // Direct invitee 2001 completes a 0.99 GRAM Bronze Chest purchase -> 1001 unlocks vault for free!
  const ord = await presale.createOrderIntent(W_H1, null, 1010, { skuId: 'chest_bronze', openMode: 'INSTANT', tgUserId: '2001', referrerId: '1001' });
  await presale.ingestInbound({ txHash: 'tx_inv_099', finality: 'finalized', to: HOT_WALLET, from: W_H1, valueNano: '990000000', memo: ord.memo }, 1015);
  await presale.queueConfirmedPayouts(1020);
  await presale.processPayouts(1025, {
    a9Broadcaster: async () => ({ txHash: 'tx_inv_out' }),
    verifier: async () => ({ state: 'CONFIRMED', txHash: 'tx_inv_out' }),
  });

  const router = createApiRouter({
    env: { A9_BOT_TOKEN: BOT_TOKEN },
    stateStore: { getProtocolState: () => ({ currentRoundId: 1 }), listRounds: () => [], getRound: () => null, getTiming: () => ({}) },
    promoEngine: promo,
    presaleEngine: presale,
    socialStore: social,
    predictionEngine: pred,
    chestEngine: chest,
    identityStore,
    walletStateResolver: async () => ({ status: 'active' }),
    telegramGroupVerifier: async () => ({ botInGroup: true, operatorIsAdmin: true, chatId: '-100999', groupHandle: '@a9squad', tgMemberCount: 88 }),
  });

  const hdrOwner = { 'x-telegram-init-data': makeInitData(BOT_TOKEN, { id: 1001 }, 1030) };
  const actRes = await router({ method: 'POST', pathname: '/api/prediction/activate', headers: hdrOwner, body: {}, nowSec: 1030 });
  assert.equal(actRes.status, 200);
  assert.equal(actRes.body.data.activatedRaw, '500000000000');

  // Captain verifies TG group with 88 members -> receives 5,000 A9 founding bonus once
  await router({ method: 'POST', pathname: '/api/team/bind-tg', headers: hdrOwner, body: { teamId: 'TM-88', name: 'Alpha', tgGroupHandle: '@a9squad' }, nowSec: 1035 });
  const verRes = await router({ method: 'POST', pathname: '/api/team/verify-tg', headers: hdrOwner, body: { teamId: 'TM-88' }, nowSec: 1040 });
  assert.equal(verRes.status, 200);
  assert.equal(verRes.body.data.tgMemberCount, 88);
  assert.equal(verRes.body.data.captainBonus.granted, true);
  assert.equal(verRes.body.data.captainBonus.amountRaw, CAPTAIN_FOUNDING_BONUS_RAW.toString());

  // Chest deep-link parser & OG card route
  assert.deepEqual(parseStartAppParam('chest_ch_abc123_1001'), { raw: 'chest_ch_abc123_1001', kind: 'chest', teamId: null, targetId: 'ch_abc123', referrerId: '1001' });
  const ogRes = await router({ method: 'GET', pathname: '/c/chest/ch_test1', nowSec: 1045 });
  assert.equal(ogRes.status, 200);
  assert.match(ogRes.rawBody, /startapp=chest_ch_test1/);
});

await test('D1ChestEngine (real SQLite) enforces atomic serial unlock, pair uniqueness & founding bonus idempotency', async () => {
  const db = createSqliteD1();
  const d1Chest = new D1ChestEngine({ db });
  const starter = await d1Chest.claimStarterBronzeChests({ userId: '3001', walletAddress: W_OWNER }, 2000);
  assert.equal(starter.created, true);
  assert.equal(starter.chests.length, 7);

  const b1 = starter.chests[0];
  await d1Chest.assistChest({ chestId: b1.chestId, helperUserId: '3002', helperWalletAddress: W_H1, walletActive: true }, 2010);
  await d1Chest.assistChest({ chestId: b1.chestId, helperUserId: '3003', helperWalletAddress: W_H2, walletActive: true }, 2015);
  const opened = await d1Chest.openChest({ chestId: b1.chestId, userId: '3001', walletAddress: W_OWNER }, 2020);
  assert.equal(opened.nextUnlocked.slotIndex, 2);
  assert.equal(opened.nextUnlocked.status, 'ACTIVE');

  // Same helper wallet cannot assist owner's Bronze #2 (lifetime owner-helper pair limit)
  await assert.rejects(
    () => d1Chest.assistChest({ chestId: opened.nextUnlocked.chestId, helperUserId: '3002', helperWalletAddress: W_H1, walletActive: true }, 2025),
    (e) => e.code === 'OWNER_PAIR_LIMIT',
  );

  // Captain founding bonus idempotent in D1
  const g1 = await d1Chest.grantCaptainFoundingBonus({ teamId: 'TM-D1', captainUserId: '3001', captainWallet: W_OWNER, tgMemberCount: 120 }, 2030);
  const g2 = await d1Chest.grantCaptainFoundingBonus({ teamId: 'TM-D1', captainUserId: '3001', captainWallet: W_OWNER, tgMemberCount: 120 }, 2035);
  assert.equal(g1.granted, true);
  assert.equal(g2.granted, false);
  assert.equal(g2.reason, 'ALREADY_GRANTED');
});

console.log(`All ${passed} A9 v15 Chest Mall & Viral Assist tests passed.`);
