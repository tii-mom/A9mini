// A9 Protocol v15 — Chest Mall & Viral Social Assist Full-Stack Tests (Memory + Migrated SQLite D1).
import assert from 'node:assert/strict';
import { ChestEngine, CHEST_MALL_CATALOG, PAID_CHEST_CRIT_TIERS, CAPTAIN_FOUNDING_BONUS_RAW, rollPaidChestBonusRaw } from '../src/chest-engine.mjs';
import { BudgetError } from '../src/promo-budget.mjs';
import { D1ChestEngine } from '../src/d1-chest-store.mjs';
import { D1PresaleStore, D1SocialStore, D1PredictionEngine } from '../src/d1-growth-store.mjs';
import { D1PromoStore } from '../src/d1-promo-store.mjs';
import { PresaleHotWalletEngine, PASSIVE_FREE_MIN_NANO, DELIVERY_GAS_FEE_NANO, REFUND_GAS_FEE_NANO } from '../src/presale-hotwallet.mjs';
import { PromoHotWalletEngine } from '../src/promo-hotwallet.mjs';
import { PredictionEngine } from '../src/growth-engine.mjs';
import { SocialStore, parseStartAppParam, createTelegramBotGroupVerifier } from '../src/social-store.mjs';
import { TelegramBroadcaster } from '../src/tg-broadcaster.mjs';
import { TonCenterClient } from '../src/toncenter.mjs';
import { createApiRouter } from '../src/api.mjs';
import { MemoryIdentityStore } from '../src/auth.mjs';
import { tgHeaders, createSqliteD1, MIGRATIONS, TEST_BOT_TOKEN } from './helpers/test-env.mjs';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

const BOT_TOKEN = TEST_BOT_TOKEN;
const HOT_WALLET = '0:1111111111111111111111111111111111111111111111111111111111111111';
const W_OWNER = '0:2222222222222222222222222222222222222222222222222222222222222222';
const W_H1 = '0:3333333333333333333333333333333333333333333333333333333333333333';
const W_H2 = '0:4444444444444444444444444444444444444444444444444444444444444444';
const W_H3 = '0:5555555555555555555555555555555555555555555555555555555555555555';
const W_H4 = '0:6666666666666666666666666666666666666666666666666666666666666666';

const emptyStateStore = {
  getProtocolState: () => ({ currentRoundId: 1 }),
  listRounds: () => [],
  getRound: () => null,
  getTiming: () => ({}),
};

console.log('Running A9 v15 Chest Mall & Viral Assist tests...');

await test('6 Chest Mall SKUs exact integer pricing (incl. 500 GRAM Legendary), unlimited per-wallet quota, +0.06 GRAM delivery gas & 0.03 GRAM refund gas rule', async () => {
  assert.equal(PASSIVE_FREE_MIN_NANO, 990_000_000n);
  assert.equal(DELIVERY_GAS_FEE_NANO, 60_000_000n);
  assert.equal(REFUND_GAS_FEE_NANO, 30_000_000n);
  assert.equal(CHEST_MALL_CATALOG.chest_bronze.baseA9, '1500');
  assert.equal(CHEST_MALL_CATALOG.chest_bronze.maxA9, '2000');
  assert.equal(CHEST_MALL_CATALOG.chest_silver.baseA9, '8000');
  assert.equal(CHEST_MALL_CATALOG.chest_silver.maxA9, '11000');
  assert.equal(CHEST_MALL_CATALOG.chest_gold.baseA9, '18000');
  assert.equal(CHEST_MALL_CATALOG.chest_gold.maxA9, '22000');
  assert.equal(CHEST_MALL_CATALOG.chest_platinum.baseA9, '38000');
  assert.equal(CHEST_MALL_CATALOG.chest_platinum.maxA9, '45000');
  assert.equal(CHEST_MALL_CATALOG.chest_diamond.baseA9, '200000');
  assert.equal(CHEST_MALL_CATALOG.chest_diamond.maxA9, '220000');
  assert.equal(CHEST_MALL_CATALOG.chest_legendary.baseA9, '900000');
  assert.equal(CHEST_MALL_CATALOG.chest_legendary.maxA9, '1200000');
  assert.equal(CHEST_MALL_CATALOG.chest_legendary.priceGram, '500');
  assert.equal(CHEST_MALL_CATALOG.chest_bronze.requiredAssists, 0);
  assert.equal(CHEST_MALL_CATALOG.chest_legendary.maxSupply, null);
  assert.equal(PAID_CHEST_CRIT_TIERS.reduce((s, t) => s + t.weight, 0), 100);

  // Whole-integer crit rolls (zero decimals across all 6 SKUs)
  for (const sku of Object.values(CHEST_MALL_CATALOG)) {
    for (const r of [0.1, 0.5, 0.85, 0.96, 0.995]) {
      const rolled = rollPaidChestBonusRaw(sku.maxBoostA9Raw, () => r);
      assert.equal(rolled.bonusRaw % 1_000_000_000n, 0n, `${sku.skuId} crit must be whole integer A9`);
    }
  }

  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT_WALLET, open: true });
  const q0 = await presale.getQuota(W_OWNER, 1000);
  assert.equal(q0.unlimitedQuota, true);
  assert.equal(q0.unlockedQuotaNano, null);
  assert.equal(q0.availQuotaNano, null);

  const ord = await presale.createOrderIntent(W_OWNER, null, 1000, { skuId: 'chest_bronze', openMode: 'BOOST', tgUserId: '1001' });
  assert.equal(ord.skuId, 'chest_bronze');
  assert.equal(ord.openMode, 'BOOST');
  assert.equal(ord.tonNano, '990000000');
  assert.equal(ord.deliveryFeeNano, '60000000');
  assert.equal(ord.payTonNano, '1050000000');
  assert.equal(ord.a9AmountRaw, '1500000000000');

  // Unlimited per-wallet cap: same wallet can buy 2x 500 GRAM Legendary Chests (= 1,000 GRAM) without OVER_QUOTA
  const leg1 = await presale.createOrderIntent(W_OWNER, null, 1001, { skuId: 'chest_legendary', openMode: 'BOOST', tgUserId: '1001' });
  const leg2 = await presale.createOrderIntent(W_OWNER, null, 1002, { skuId: 'chest_legendary', openMode: 'BOOST', tgUserId: '1001' });
  assert.equal(leg1.tonNano, '500000000000');
  assert.equal(leg1.payTonNano, '500060000000');
  assert.equal(leg1.a9AmountRaw, '900000000000000');
  assert.equal(leg2.a9AmountRaw, '900000000000000');

  // Expired 0.99 GRAM Bronze Chest order paid late (1.05 GRAM) -> passive refund minus 0.03 GRAM on-chain refund gas
  const latePlan = await presale.planInbound(
    { txHash: 'tx_late_099', finality: 'finalized', to: HOT_WALLET, from: W_OWNER, valueNano: ord.payTonNano, memo: ord.memo },
    ord.expiresAt + 10,
  );
  assert.equal(latePlan.action, 'REFUND');
  assert.equal(latePlan.refundNano, 1_020_000_000n);
  assert.equal(latePlan.feeDeducted, true);
});

await test('Real TonCenterClient.fetchWalletAccountState format: active passes, uninitialized rejects, RPC failure returns 503', async () => {
  const chest = new ChestEngine();
  const pred = new PredictionEngine();
  const identityStore = new MemoryIdentityStore();
  await identityStore.bindVerifiedWallet('1001', W_OWNER, 1000);
  await identityStore.bindVerifiedWallet('2001', W_H1, 1000);
  await identityStore.bindVerifiedWallet('2002', W_H2, 1000);
  await identityStore.bindVerifiedWallet('2003', W_H3, 1000);

  // Claim starter Bronze (0-assist instant READY), open it to unlock Silver (2 assists required) for assist testing
  const starter = await chest.claimStarterBronzeChests({ userId: '1001', walletAddress: W_OWNER }, 1000);
  const b0 = starter.chests[0];
  assert.equal(b0.status, 'READY');
  const openedStarter = await chest.openChest({ chestId: b0.chestId, userId: '1001', walletAddress: W_OWNER, predictionEngine: pred }, 1001);
  const b1 = openedStarter.nextUnlocked;
  assert.equal(b1.tier, 'silver');
  assert.equal(b1.status, 'ACTIVE');

  // Mock TonCenter HTTP responses matching real /getAddressInformation contract
  const tc = new TonCenterClient({
    apiBase: 'https://toncenter.test/api/v2',
    apiKey: 'test-key',
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: async (url) => {
      const addr = new URL(url).searchParams.get('address');
      if (addr === W_H1) {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { state: 'active', code: 'te6cckEBAQEA' } }) };
      }
      if (addr === W_H2) {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { state: 'uninitialized', code: '' } }) };
      }
      return { ok: false, status: 500, json: async () => ({ ok: false, error: 'upstream down' }) };
    },
  });

  const router = createApiRouter({
    env: { A9_BOT_TOKEN: BOT_TOKEN, A9_CHEST_OPEN_ENABLED: '1' },
    stateStore: emptyStateStore,
    predictionEngine: pred,
    chestEngine: chest,
    identityStore,
    walletStateResolver: (addr) => tc.fetchWalletAccountState(addr),
  });

  // 1) active wallet passes
  const resActive = await router({
    method: 'POST',
    pathname: `/api/chests/${b1.chestId}/assist`,
    headers: await tgHeaders(2001, { nowSec: 1010 }),
    body: {},
    nowSec: 1010,
  });
  assert.equal(resActive.status, 200);
  assert.equal(resActive.body.data.chest.currentAssists, 1);
  assert.equal(resActive.body.data.helperGrantedStarter, true);

  // 2) uninitialized wallet rejected with 400 WALLET_NOT_ACTIVE
  const resUninit = await router({
    method: 'POST',
    pathname: `/api/chests/${b1.chestId}/assist`,
    headers: await tgHeaders(2002, { nowSec: 1011 }),
    body: {},
    nowSec: 1011,
  });
  assert.equal(resUninit.status, 400);
  assert.equal(resUninit.body.error.code, 'WALLET_NOT_ACTIVE');

  // 3) RPC failure rejected with 503 WALLET_STATE_UNAVAILABLE
  const resRpcFail = await router({
    method: 'POST',
    pathname: `/api/chests/${b1.chestId}/assist`,
    headers: await tgHeaders(2003, { nowSec: 1012 }),
    body: {},
    nowSec: 1012,
  });
  assert.equal(resRpcFail.status, 503);
  assert.equal(resRpcFail.body.error.code, 'WALLET_STATE_UNAVAILABLE');
});

await test('Shop Boost Chest: transient creation failure is idempotently backfilled on /api/chests/me & DM commission alert fires', async () => {
  const chest = new ChestEngine();
  const promo = new PromoHotWalletEngine({ hotWalletAddress: HOT_WALLET });
  const identityStore = new MemoryIdentityStore();
  await identityStore.bindVerifiedWallet('1001', W_OWNER, 1000);
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

  // Simulate transient failure on first createShopBoostChest during _markConfirmed
  let failOnce = true;
  const origCreate = chest.createShopBoostChest.bind(chest);
  chest.createShopBoostChest = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('transient D1 timeout');
    }
    return origCreate(...args);
  };

  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT_WALLET, open: true, promoEngine: promo, chestEngine: chest, broadcaster });
  const ord = await presale.createOrderIntent(W_OWNER, null, 1000, { skuId: 'chest_gold', openMode: 'BOOST', tgUserId: '1001', referrerId: W_H3 });
  await presale.ingestInbound({ txHash: 'tx_gold_in', finality: 'finalized', to: HOT_WALLET, from: W_OWNER, valueNano: ord.payTonNano, memo: ord.memo }, 1010);
  await presale.queueConfirmedPayouts(1015);
  await presale.processPayouts(1020, {
    a9Broadcaster: async () => ({ txHash: 'tx_gold_out' }),
    verifier: async () => ({ state: 'CONFIRMED', txHash: 'tx_gold_out' }),
  });

  // Because first attempt threw, no shop chest exists yet — calling /api/chests/me must idempotently backfill it!
  assert.equal((await chest.listUserChests('1001')).shopChests.length, 0);
  const router = createApiRouter({
    env: { A9_BOT_TOKEN: BOT_TOKEN },
    stateStore: emptyStateStore,
    promoEngine: promo,
    presaleEngine: presale,
    chestEngine: chest,
    identityStore,
  });
  const meRes = await router({ method: 'GET', pathname: '/api/chests/me', headers: await tgHeaders(1001, { nowSec: 1025 }), nowSec: 1025 });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.data.shopChests.length, 1);
  const sc = meRes.body.data.shopChests[0];
  assert.equal(sc.tier, 'gold');
  assert.equal(sc.orderId, ord.orderId);

  // Second /api/chests/me call stays idempotent (still 1 chest)
  const meRes2 = await router({ method: 'GET', pathname: '/api/chests/me', headers: await tgHeaders(1001, { nowSec: 1026 }), nowSec: 1026 });
  assert.equal(meRes2.body.data.shopChests.length, 1);

  // Paid chest rejects social assist; owner opens directly and receives CSPRNG random crit bonus
  await assert.rejects(
    () => chest.assistChest({ chestId: sc.chestId, helperUserId: '2001', helperWalletAddress: W_H1, walletActive: true }, 1030),
    { code: 'ASSIST_NOT_ALLOWED' },
  );
  const res = await chest.openChest({ chestId: sc.chestId, userId: '1001', walletAddress: W_OWNER, promoEngine: promo, randomFn: () => 0.995 }, 1040);
  assert.equal(res.destination, 'PROMO_BALANCE');
  assert.equal(res.critTier, 'legendary');
  assert.equal(res.isCrit, true);
  assert.ok(BigInt(res.rewardA9Raw) > 0n && BigInt(res.rewardA9Raw) <= BigInt(sc.maxBoostA9Raw));
  assert.equal((await promo.getBalance(W_OWNER)).claimableRaw, res.rewardA9Raw);

  // Referral credit triggers DM commission alert
  await presale.processReferralCredits(1050);
  assert.equal(dmSent.length, 1);
  assert.equal(dmSent[0].body.chat_id, '9001');
  assert.match(dmSent[0].body.text, /返佣到账提醒/);
});

await test('Direct paid invitee (TG-only ref) unlocks vault, Captain >=50 gets 5,000 A9 & Live mode blocks /api/chests/:id/open', async () => {
  const social = new SocialStore();
  const pred = new PredictionEngine();
  const promo = new PromoHotWalletEngine({ hotWalletAddress: HOT_WALLET });
  const chest = new ChestEngine();
  const identityStore = new MemoryIdentityStore();
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT_WALLET, open: true, promoEngine: promo, socialStore: social, chestEngine: chest });

  await identityStore.bindVerifiedWallet('1001', W_OWNER, 1000);
  await identityStore.bindVerifiedWallet('2001', W_H1, 1000);
  // Real flow: invitee 2001 bound TG-only referral before connecting wallet
  social.bindReferral('2001', '1001', 1005);
  pred.creditPendingBonus('1001', 500_000_000_000n, 1005 * 1000);

  const ord = await presale.createOrderIntent(W_H1, null, 1010, { skuId: 'chest_bronze', openMode: 'INSTANT', tgUserId: '2001', referrerId: '1001' });
  await presale.ingestInbound({ txHash: 'tx_inv_099', finality: 'finalized', to: HOT_WALLET, from: W_H1, valueNano: ord.payTonNano, memo: ord.memo }, 1015);
  await presale.queueConfirmedPayouts(1020);
  await presale.processPayouts(1025, {
    a9Broadcaster: async () => ({ txHash: 'tx_inv_out' }),
    verifier: async () => ({ state: 'CONFIRMED', txHash: 'tx_inv_out' }),
  });

  const router = createApiRouter({
    env: { A9_BOT_TOKEN: BOT_TOKEN },
    stateStore: emptyStateStore,
    promoEngine: promo,
    presaleEngine: presale,
    socialStore: social,
    predictionEngine: pred,
    chestEngine: chest,
    identityStore,
    walletStateResolver: async () => ({ state: 'active', codeBoc: 'te6c' }),
    telegramGroupVerifier: async () => ({ botInGroup: true, operatorIsAdmin: true, chatId: '-100999', groupHandle: '@a9squad', tgMemberCount: 88 }),
  });

  const hdrOwner = await tgHeaders(1001, { nowSec: 1030 });
  const actRes = await router({ method: 'POST', pathname: '/api/prediction/activate', headers: hdrOwner, body: {}, nowSec: 1030 });
  assert.equal(actRes.status, 200);
  assert.equal(actRes.body.data.activatedRaw, '500000000000');

  // Captain verifies TG group with 88 members + >=3 bound squad members (M-2) -> 5,000 A9 founding bonus
  await router({ method: 'POST', pathname: '/api/team/bind-tg', headers: hdrOwner, body: { teamId: 'TM-88', name: 'Alpha', tgGroupHandle: '@a9squad' }, nowSec: 1035 });
  await social.joinTeam({ teamId: 'TM-88', walletAddress: W_H1 }, 1036);
  await social.joinTeam({ teamId: 'TM-88', walletAddress: W_H2 }, 1037);
  const verRes = await router({ method: 'POST', pathname: '/api/team/verify-tg', headers: hdrOwner, body: { teamId: 'TM-88' }, nowSec: 1040 });
  assert.equal(verRes.status, 200);
  assert.equal(verRes.body.data.tgMemberCount, 88);
  assert.equal(verRes.body.data.captainBonus.granted, true);
  assert.equal(verRes.body.data.captainBonus.amountRaw, CAPTAIN_FOUNDING_BONUS_RAW.toString());

  // Independent Chest Open switch: EVEN when presaleEngine.open=true (购箱已开), without A9_CHEST_OPEN_ENABLED='1', /api/chests/:id/open returns 403 and writes 0 to reward tables
  const starter = await chest.claimStarterBronzeChests({ userId: '1001', walletAddress: W_OWNER }, 1041);
  const b1 = starter.chests[0];
  assert.equal(b1.status, 'READY');
  const pendingBeforeBlock = pred.getUserSummary('1001').pendingActivationRaw;
  const promoBeforeBlock = promo.getBalance(W_OWNER).claimableRaw;
  const blockedOpen = await router({ method: 'POST', pathname: `/api/chests/${b1.chestId}/open`, headers: hdrOwner, body: {}, nowSec: 1044 });
  assert.equal(blockedOpen.status, 403);
  assert.equal(blockedOpen.body.error.code, 'CHEST_OPEN_DISABLED');
  assert.equal((await chest.getChest(b1.chestId)).status, 'READY');
  assert.equal(pred.getUserSummary('1001').pendingActivationRaw, pendingBeforeBlock);
  assert.equal(promo.getBalance(W_OWNER).claimableRaw, promoBeforeBlock);

  // Chest deep-link parser & OG card route
  assert.deepEqual(parseStartAppParam('chest_ch_abc123_1001'), { raw: 'chest_ch_abc123_1001', kind: 'chest', teamId: null, targetId: 'ch_abc123', referrerId: '1001' });
  const ogRes = await router({ method: 'GET', pathname: '/c/chest/ch_test1', nowSec: 1045 });
  assert.equal(ogRes.status, 200);
  assert.match(ogRes.rawBody, /startapp=chest_ch_test1/);
});

await test('Migrated SQLite D1 (0001..0009): orders, bound group, atomic open-with-rollback & concurrent assists + daily cap', async () => {
  const db = createSqliteD1(MIGRATIONS);
  const d1Chest = new D1ChestEngine({ db });
  const d1Promo = new D1PromoStore({ db, hotWalletAddress: HOT_WALLET });
  const d1Pred = new D1PredictionEngine({ db });
  const d1Social = new D1SocialStore({ db });
  const d1Presale = new D1PresaleStore({ db, hotWalletAddress: HOT_WALLET, open: true, promoEngine: d1Promo, socialStore: d1Social, chestEngine: d1Chest });

  // 1) Verify migrated presale_orders (sku_id/open_mode) & team_groups (tg_member_count)
  const ord = await d1Presale.createOrderIntent(W_OWNER, null, 2000, { skuId: 'chest_bronze', openMode: 'BOOST', tgUserId: '3001' });
  assert.equal(ord.skuId, 'chest_bronze');
  assert.equal(ord.openMode, 'BOOST');

  await d1Social.createOrBindTeamGroup({ teamId: 'TM-MIG', name: 'Migrated', captainWallet: W_OWNER, tgGroupHandle: '@mig' }, 2001);
  const verifiedTeam = await d1Social.verifyTeamGroupBinding(
    {
      teamId: 'TM-MIG',
      captainWallet: W_OWNER,
      telegramUserId: '3001',
      telegramVerifier: async () => ({ botInGroup: true, operatorIsAdmin: true, chatId: '-100555', groupHandle: '@mig', tgMemberCount: 120 }),
    },
    2002,
  );
  assert.equal(verifiedTeam.tgMemberCount, 120);

  // 2) Atomic openChest rollback proof on Starter Bronze (0-assist READY): inject a SQLite trigger that fails prediction_rewards INSERT
  const starter = await d1Chest.claimStarterBronzeChests({ userId: '3001', walletAddress: W_OWNER }, 2010);
  const b1 = starter.chests[0];
  assert.equal(b1.status, 'READY');

  db.exec(`CREATE TRIGGER fail_pred_reward BEFORE INSERT ON prediction_rewards BEGIN SELECT RAISE(ABORT, 'injected_reward_write_failure'); END;`);
  await assert.rejects(
    () => d1Chest.openChest({ chestId: b1.chestId, userId: '3001', walletAddress: W_OWNER, predictionEngine: d1Pred }, 2015),
    /injected_reward_write_failure/,
  );
  // Chest MUST NOT be stuck OPENED after failed reward write!
  assert.equal((await d1Chest.getChest(b1.chestId)).status, 'READY');
  assert.equal((await d1Pred.getUserSummary('3001')).pendingActivationRaw, '0');

  // Drop fault trigger -> retry succeeds atomically, credits 200 A9 & unlocks Silver (1,000 A9, 2 assists)
  db.exec('DROP TRIGGER fail_pred_reward;');
  const opened = await d1Chest.openChest({ chestId: b1.chestId, userId: '3001', walletAddress: W_OWNER, predictionEngine: d1Pred }, 2020);
  assert.equal(opened.chest.status, 'OPENED');
  assert.equal(opened.nextUnlocked.tier, 'silver');
  assert.equal(opened.nextUnlocked.status, 'ACTIVE');
  assert.equal((await d1Pred.getUserSummary('3001')).pendingActivationRaw, '200000000000');

  // 2b) Same-second concurrent openChest + BigInt (>2^63) precision proof:
  // Pre-seed promo_balances with 20000000000000000000 (2e19, overflows SQLite 64-bit signed INTEGER).
  await db.prepare("INSERT INTO promo_balances (wallet_address, claimable_raw, total_claimed_raw, updated_at) VALUES (?, '20000000000000000000', '0', 2021)").bind(W_OWNER).run();
  const shopBronze = await d1Chest.createShopBoostChest({ userId: '3001', walletAddress: W_OWNER, skuId: 'chest_bronze', orderId: 'ord_bigint_race' }, 2021);
  assert.equal(shopBronze.boostA9Raw, '0');
  assert.equal(shopBronze.status, 'READY');
  assert.equal(shopBronze.requiredAssists, 0);
  const expectedRoll = rollPaidChestBonusRaw(shopBronze.maxBoostA9Raw, () => 0.5);
  const sameSecRace = await Promise.allSettled([
    d1Chest.openChest({ chestId: shopBronze.chestId, userId: '3001', walletAddress: W_OWNER, promoEngine: d1Promo, randomFn: () => 0.5 }, 2022),
    d1Chest.openChest({ chestId: shopBronze.chestId, userId: '3001', walletAddress: W_OWNER, promoEngine: d1Promo, randomFn: () => 0.5 }, 2022),
  ]);
  assert.equal(sameSecRace.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(sameSecRace.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(sameSecRace.find((r) => r.status === 'rejected').reason.code, 'ALREADY_OPENED');
  // Exact BigInt decimal string (NOT double-credited, NOT float!)
  assert.equal((await d1Promo.getBalance(W_OWNER)).claimableRaw, (20000000000000000000n + expectedRoll.bonusRaw).toString());

  // 3) Concurrent assist on the final slot of Silver: 2 distinct helpers race -> 1 succeeds, 0 orphan rows
  const b2 = opened.nextUnlocked;
  await d1Chest.assistChest({ chestId: b2.chestId, helperUserId: '3004', helperWalletAddress: W_H3, walletActive: true }, 2025);
  const raceRes = await Promise.allSettled([
    d1Chest.assistChest({ chestId: b2.chestId, helperUserId: '3005', helperWalletAddress: W_H4, walletActive: true }, 2026),
    d1Chest.assistChest({ chestId: b2.chestId, helperUserId: '3006', helperWalletAddress: '0:7777777777777777777777777777777777777777777777777777777777777777', walletActive: true }, 2026),
  ]);
  assert.equal(raceRes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(raceRes.filter((r) => r.status === 'rejected').length, 1);
  const b2Now = await d1Chest.getChest(b2.chestId);
  const b2Rows = await db.prepare('SELECT COUNT(*) AS cnt FROM chest_assists WHERE chest_id = ?').bind(b2.chestId).first();
  assert.equal(b2Now.currentAssists, 2);
  assert.equal(Number(b2Rows.cnt), 2);

  // 4) Concurrent daily 3-assist cap: 1 helper races across 4 distinct owners' Silver chests on same UTC day -> exactly 3 succeed, 4th gets DAILY_ASSIST_LIMIT
  const helperWallet = '0:8888888888888888888888888888888888888888888888888888888888888888';
  const owners = ['4001', '4002', '4003', '4004'];
  const ownerChests = [];
  for (const ou of owners) {
    const ow = `0:${ou.padEnd(64, 'a')}`;
    const st = await d1Chest.claimStarterBronzeChests({ userId: ou, walletAddress: ow }, 3000);
    const op = await d1Chest.openChest({ chestId: st.chests[0].chestId, userId: ou, walletAddress: ow, predictionEngine: d1Pred }, 3001);
    ownerChests.push(op.nextUnlocked);
  }
  const capRes = await Promise.allSettled(
    ownerChests.map((c) =>
      d1Chest.assistChest({ chestId: c.chestId, helperUserId: '5001', helperWalletAddress: helperWallet, walletActive: true }, 3010),
    ),
  );
  assert.equal(capRes.filter((r) => r.status === 'fulfilled').length, 3);
  const capRejects = capRes.filter((r) => r.status === 'rejected');
  assert.equal(capRejects.length, 1);
  assert.equal(capRejects[0].reason.code, 'DAILY_ASSIST_LIMIT');
  const dayCnt = await db.prepare('SELECT COUNT(*) AS cnt FROM chest_assists WHERE helper_wallet_key = ?').bind(helperWallet).first();
  assert.equal(Number(dayCnt.cnt), 3);

  // 5) D1 openAllChests batch open + tier filter + 300M budget exhausted soft-landing
  const batchWallet = '0:9999999999999999999999999999999999999999999999999999999999999999';
  await d1Chest.createShopBoostChest({ userId: '6002', walletAddress: batchWallet, skuId: 'chest_bronze', orderId: 'ord_batch_b1' }, 3015);
  await d1Chest.createShopBoostChest({ userId: '6002', walletAddress: batchWallet, skuId: 'chest_bronze', orderId: 'ord_batch_b2' }, 3016);
  await d1Chest.createShopBoostChest({ userId: '6002', walletAddress: batchWallet, skuId: 'chest_gold', orderId: 'ord_batch_g1' }, 3017);
  const bronzeBatch = await d1Chest.openAllChests({ userId: '6002', walletAddress: batchWallet, tier: 'bronze', promoEngine: d1Promo, randomFn: () => 0.995 }, 3018);
  assert.equal(bronzeBatch.openedCount, 2);
  assert.equal(bronzeBatch.critCount, 2);
  assert.equal(bronzeBatch.legendaryCount, 2);
  assert.equal((await d1Promo.getBalance(batchWallet)).claimableRaw, bronzeBatch.totalRewardA9Raw);

  // Remaining gold chest opens with 300M budget exhausted -> soft-lands to 0 bonus without trapping the chest
  const exhaustedBudget = {
    async prepareAtomicReserve() { throw new BudgetError('PROMO_BUDGET_EXHAUSTED', '300M promo cap reached'); },
  };
  const goldSoft = await d1Chest.openAllChests({ userId: '6002', walletAddress: batchWallet, promoEngine: d1Promo, budgetLedger: exhaustedBudget, randomFn: () => 0.995 }, 3019);
  assert.equal(goldSoft.openedCount, 1);
  assert.equal(goldSoft.totalRewardA9Raw, '0');
  assert.equal(goldSoft.budgetCappedCount, 1);
  assert.equal((await d1Promo.getBalance(batchWallet)).claimableRaw, bronzeBatch.totalRewardA9Raw);

  // 6) Captain founding bonus atomic rollback on prediction_rewards write failure -> retry succeeds once with 5,000 A9
  db.exec(`CREATE TRIGGER fail_captain_vault BEFORE INSERT ON prediction_rewards BEGIN SELECT RAISE(ABORT, 'injected_captain_vault_fail'); END;`);
  await assert.rejects(
    () => d1Chest.grantCaptainFoundingBonus({ teamId: 'TM-ATOMIC', tgChatId: '-100atomic', captainUserId: '6001', captainWallet: W_H4, tgMemberCount: 120, teamMemberCount: 3, predictionEngine: d1Pred }, 3020),
    /injected_captain_vault_fail/,
  );
  const failedGrantRow = await db.prepare('SELECT * FROM captain_founding_bonuses WHERE team_id = ?').bind('TM-ATOMIC').first();
  assert.equal(failedGrantRow, null);
  assert.equal((await d1Pred.getUserSummary('6001')).pendingActivationRaw, '0');

  db.exec('DROP TRIGGER fail_captain_vault;');
  const g1 = await d1Chest.grantCaptainFoundingBonus({ teamId: 'TM-ATOMIC', tgChatId: '-100atomic', captainUserId: '6001', captainWallet: W_H4, tgMemberCount: 120, teamMemberCount: 3, predictionEngine: d1Pred }, 3022);
  assert.equal(g1.granted, true);
  assert.equal(g1.amountRaw, CAPTAIN_FOUNDING_BONUS_RAW.toString());
  assert.equal((await d1Pred.getUserSummary('6001')).pendingActivationRaw, '5000000000000');

  const g2 = await d1Chest.grantCaptainFoundingBonus({ teamId: 'TM-ATOMIC', tgChatId: '-100atomic', captainUserId: '6001', captainWallet: W_H4, tgMemberCount: 120, teamMemberCount: 3, predictionEngine: d1Pred }, 3025);
  assert.equal(g2.granted, false);
  assert.equal(g2.reason, 'ALREADY_GRANTED');
  assert.equal((await d1Pred.getUserSummary('6001')).pendingActivationRaw, '5000000000000');
});

await test('Legacy 0001..0004 SQLite DB (without 0009 sku_id/open_mode): plain order succeeds and OVER_QUOTA still triggers', async () => {
  const oldDb = createSqliteD1(MIGRATIONS.slice(0, 4));
  const legacyPresale = new D1PresaleStore({ db: oldDb, hotWalletAddress: HOT_WALLET, defaultQuotaTon: 20n, open: true });
  const okOrd = await legacyPresale.createOrderIntent(W_OWNER, '15', 4000);
  assert.equal(okOrd.tonNano, '15000000000');
  assert.equal('skuId' in okOrd, false);
  await assert.rejects(legacyPresale.createOrderIntent(W_OWNER, '10', 4001), { code: 'OVER_QUOTA' });
});

await test('Cloudflare workerd strict globalThis.fetch receiver guard (TonCenterClient / TelegramBroadcaster / group verifier)', async () => {
  const origFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async function strictWorkerdFetch(url) {
    if (this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
    calls.push(String(url));
    if (String(url).includes('/getAddressInformation')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { state: 'active', code: 'te6cckEBAQEA' } }) };
    }
    if (String(url).includes('/getMe')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 999000, is_bot: true, username: 'A9_TonBot' } }) };
    }
    if (String(url).includes('/getChat?')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: -1001, type: 'supergroup', username: 'a9test' } }) };
    }
    if (String(url).includes('/getChatMember?')) {
      const isBotCheck = String(url).includes('user_id=999000');
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { status: isBotCheck ? 'administrator' : 'creator' } }) };
    }
    if (String(url).includes('/getChatMemberCount?')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: 108 }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try {
    const tc = new TonCenterClient({ apiBase: 'https://toncenter.test/api/v2', apiKey: 'k', minIntervalMs: 0, maxRetries: 0 });
    const st = await tc.fetchWalletAccountState(W_H1);
    assert.equal(st.state, 'active');

    const verifier = createTelegramBotGroupVerifier(BOT_TOKEN);
    const vg = await verifier({ tgGroupHandle: '@a9test', telegramUserId: '1001' });
    assert.equal(vg.botInGroup, true);
    assert.equal(vg.operatorIsAdmin, true);
    assert.equal(vg.tgMemberCount, 108);

    const bc = new TelegramBroadcaster({ enabled: true, botToken: BOT_TOKEN, delayMs: 0 });
    await bc._sendTelegram({ chatId: '1001', text: 'workerd receiver ok' });
    assert.equal(calls.length, 7);
  } finally {
    globalThis.fetch = origFetch;
  }
});

await test('Chest OG PNG (16x9 & 9x16) and SVG render real chest progress without DATA PENDING or ROUND PENDING', async () => {
  const chest = new ChestEngine();
  const pred = new PredictionEngine();
  const starter = await chest.claimStarterBronzeChests({ userId: '7001', walletAddress: W_OWNER }, 5000);
  const openedStarter = await chest.openChest({ chestId: starter.chests[0].chestId, userId: '7001', walletAddress: W_OWNER, predictionEngine: pred }, 5001);
  const b1 = openedStarter.nextUnlocked;
  await chest.assistChest({ chestId: b1.chestId, helperUserId: '7002', helperWalletAddress: W_H1, walletActive: true }, 5005);

  const router = createApiRouter({
    env: { A9_BOT_TOKEN: BOT_TOKEN, A9_PUBLIC_ORIGIN: 'https://app.a9.test' },
    stateStore: emptyStateStore,
    chestEngine: chest,
  });

  // 1) Existing Silver chest SVG: must show label, assist count, reward A9, and proportional green bars (1/2 => 12 green bars)
  const svgRes = await router({ method: 'GET', pathname: `/c/img/chest/${b1.chestId}.svg`, nowSec: 5010 });
  assert.equal(svgRes.status, 200);
  assert.match(svgRes.rawBody, /A9 CHEST · Silver Co-Op Chest/);
  assert.match(svgRes.rawBody, /1\/2 ASSISTS · 1,000 A9 Reward/);
  assert.doesNotMatch(svgRes.rawBody, /DATA PENDING|ROUND PENDING|16 \/ 24 HOURLY/);
  assert.equal((svgRes.rawBody.match(/fill="#2DA069"/g) || []).length, 12);

  // 2) Existing chest PNG (landscape 1200x630 & story 1080x1920): valid PNG header + distinct raster output from missing chest
  const pngLand = await router({ method: 'GET', pathname: `/c/img/chest/${b1.chestId}.png`, nowSec: 5010 });
  const pngStory = await router({ method: 'GET', pathname: `/c/img/chest/${b1.chestId}.png`, query: { ratio: '9x16' }, nowSec: 5010 });
  const pngMissing = await router({ method: 'GET', pathname: '/c/img/chest/nonexistent_id.png', nowSec: 5010 });
  for (const res of [pngLand, pngStory, pngMissing]) {
    assert.equal(res.status, 200);
    assert.equal(res.contentType, 'image/png');
    assert.deepEqual(Array.from(res.rawBody.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  assert.notEqual(Buffer.from(pngLand.rawBody).toString('base64'), Buffer.from(pngMissing.rawBody).toString('base64'));

  // 3) Missing chest SVG still renders friendly fallback without ROUND PENDING / DATA PENDING
  const svgMissing = await router({ method: 'GET', pathname: '/c/img/chest/nonexistent_id.svg', nowSec: 5010 });
  assert.equal(svgMissing.status, 200);
  assert.match(svgMissing.rawBody, /A9 CHEST · BOOST &amp; OPEN/);
  assert.doesNotMatch(svgMissing.rawBody, /DATA PENDING|ROUND PENDING/);

  // 4) Pure integer reward chest (SHOP_BOOST Bronze: 1,500 A9 base, zero decimals) renders cleanly in SVG & PNG
  const shopChest = await chest.createShopBoostChest({ userId: '7001', walletAddress: W_OWNER, skuId: 'chest_bronze', orderId: 'ord_og_int' }, 5020);
  const svgInt = await router({ method: 'GET', pathname: `/c/img/chest/${shopChest.chestId}.svg`, nowSec: 5021 });
  assert.equal(svgInt.status, 200);
  assert.match(svgInt.rawBody, /1,500 A9 Reward/);
  assert.doesNotMatch(svgInt.rawBody, /1,500\.0/);
});

await test('Security & ledger audit fixes: openChest address normalization, GET /api/chests/:id redaction, and OG image origin routing', async () => {
  const { parseTonAddress, formatTonAddress } = await import('../src/ton-address.mjs');
  const rawWallet = '0:' + 'ab'.repeat(32);
  const parsed = parseTonAddress(rawWallet);
  const uqWallet = formatTonAddress(parsed.workchain, parsed.hash, { bounceable: false, testOnly: false });

  const db = createSqliteD1(MIGRATIONS);
  const d1Chest = new D1ChestEngine({ db });
  const d1Promo = new D1PromoStore({ db, hotWalletAddress: HOT_WALLET });
  const c = await d1Chest.createShopBoostChest({ userId: '8001', walletAddress: uqWallet, skuId: 'chest_bronze', orderId: 'ord_norm_1' }, 6000);
  const opened = await d1Chest.openChest({ chestId: c.chestId, userId: '8001', walletAddress: uqWallet, promoEngine: d1Promo, randomFn: () => 0.5 }, 6010);

  // promo_balances row must be normalized to canonical wc:hex and match getBalance(rawWallet) without splitting
  const bal = await d1Promo.getBalance(rawWallet);
  assert.equal(bal.claimableRaw, opened.rewardA9Raw);
  const rawRows = await db.prepare('SELECT wallet_address, claimable_raw FROM promo_balances').all();
  assert.equal(rawRows.results.length, 1);
  assert.equal(rawRows.results[0].wallet_address, rawWallet);

  // GET /api/chests/:chestId redacts ownerUserId / ownerWalletKey / orderId while retaining public fields
  const c2 = await d1Chest.createShopBoostChest({ userId: '8002', walletAddress: uqWallet, skuId: 'chest_gold', orderId: 'ord_secret_2' }, 6020);
  const router = createApiRouter({
    env: {
      A9_BOT_TOKEN: BOT_TOKEN,
      A9_PUBLIC_ORIGIN: 'https://app.a9.lat',
      A9_TG_BOT_HANDLE: 'A9_TonBot',
    },
    stateStore: emptyStateStore,
    chestEngine: d1Chest,
    promoEngine: d1Promo,
  });
  const pubChestRes = await router({ method: 'GET', pathname: `/api/chests/${c2.chestId}`, nowSec: 6025 });
  assert.equal(pubChestRes.status, 200);
  assert.equal(pubChestRes.body.data.chestId, c2.chestId);
  assert.equal('ownerUserId' in pubChestRes.body.data, false);
  assert.equal('ownerWalletKey' in pubChestRes.body.data, false);
  assert.equal('orderId' in pubChestRes.body.data, false);

  // OG card page uses request origin (api.a9.lat) instead of frontend origin (app.a9.lat) for og:image
  const ogRes = await router({
    method: 'GET',
    pathname: `/c/chest/${c2.chestId}`,
    origin: 'https://api.a9.lat',
    nowSec: 6025,
  });
  assert.equal(ogRes.status, 200);
  assert.match(ogRes.rawBody, new RegExp(`https://api\\.a9\\.lat/c/img/chest/${c2.chestId}\\.png`));
  assert.match(ogRes.rawBody, /https:\/\/t\.me\/A9_TonBot\?startapp=chest_/);
});

await test('GET /api/chests/me chestHoldings merges OPENED free chests + deduplicated BOOST + INSTANT completed orders', async () => {
  const chest = new ChestEngine();
  const promo = new PromoHotWalletEngine({ hotWalletAddress: HOT_WALLET });
  const pred = new PredictionEngine();
  const identityStore = new MemoryIdentityStore();
  await identityStore.bindVerifiedWallet('9101', W_OWNER, 7000);
  const presale = new PresaleHotWalletEngine({ hotWalletAddress: HOT_WALLET, open: true, promoEngine: promo, chestEngine: chest });

  // 1) Open FREE_TIER Starter Bronze (0-assist instant; Silver becomes ACTIVE and must NOT count)
  const starter = await chest.claimStarterBronzeChests({ userId: '9101', walletAddress: W_OWNER }, 7001);
  const b1 = starter.chests[0];
  await chest.openChest({ chestId: b1.chestId, userId: '9101', walletAddress: W_OWNER, predictionEngine: pred }, 7004);

  // 2) COMPLETED BOOST Gold order (appears in both shopChests and presale orders -> must deduplicate by orderId)
  const boostOrd = await presale.createOrderIntent(W_OWNER, null, 7010, { skuId: 'chest_gold', openMode: 'BOOST', tgUserId: '9101' });
  await presale.ingestInbound({ txHash: 'tx_hold_gold_in', finality: 'finalized', to: HOT_WALLET, from: W_OWNER, valueNano: boostOrd.payTonNano, memo: boostOrd.memo }, 7011);
  await presale.queueConfirmedPayouts(7012);
  await presale.processPayouts(7013, {
    a9Broadcaster: async () => ({ txHash: 'tx_hold_gold_out' }),
    verifier: async () => ({ state: 'CONFIRMED', txHash: 'tx_hold_gold_out' }),
  });

  // 3) COMPLETED INSTANT Silver order (only in presale orders, not in shopChests -> must be included)
  const instOrd = await presale.createOrderIntent(W_OWNER, null, 7020, { skuId: 'chest_silver', openMode: 'INSTANT', tgUserId: '9101' });
  await presale.ingestInbound({ txHash: 'tx_hold_silver_in', finality: 'finalized', to: HOT_WALLET, from: W_OWNER, valueNano: instOrd.payTonNano, memo: instOrd.memo }, 7021);
  await presale.queueConfirmedPayouts(7022);
  await presale.processPayouts(7023, {
    a9Broadcaster: async () => ({ txHash: 'tx_hold_silver_out' }),
    verifier: async () => ({ state: 'CONFIRMED', txHash: 'tx_hold_silver_out' }),
  });

  const router = createApiRouter({
    env: { A9_BOT_TOKEN: BOT_TOKEN },
    stateStore: emptyStateStore,
    promoEngine: promo,
    presaleEngine: presale,
    chestEngine: chest,
    identityStore,
  });
  const meRes = await router({ method: 'GET', pathname: '/api/chests/me', headers: await tgHeaders(9101, { nowSec: 7030 }), nowSec: 7030 });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.data.shopChests.length, 1);
  assert.deepEqual(meRes.body.data.chestHoldings, {
    bronze: 1,
    silver: 1,
    gold: 1,
    platinum: 0,
    diamond: 0,
    legendary: 0,
    distinctTypes: 3,
    total: 3,
  });
});

await test('POST /api/chests/open-all: 403 gate when disabled, full/tier batch open with CSPRNG crit & 300M soft-landing', async () => {
  const chest = new ChestEngine();
  const promo = new PromoHotWalletEngine({ hotWalletAddress: HOT_WALLET });
  const identityStore = new MemoryIdentityStore();
  await identityStore.bindVerifiedWallet('9501', W_OWNER, 8000);
  await chest.createShopBoostChest({ userId: '9501', walletAddress: W_OWNER, skuId: 'chest_silver', orderId: 'ord_oa_1' }, 8001);
  await chest.createShopBoostChest({ userId: '9501', walletAddress: W_OWNER, skuId: 'chest_diamond', orderId: 'ord_oa_2' }, 8002);

  const hdr = await tgHeaders(9501, { nowSec: 8005 });
  const routerDisabled = createApiRouter({
    env: { A9_BOT_TOKEN: BOT_TOKEN },
    stateStore: emptyStateStore,
    promoEngine: promo,
    chestEngine: chest,
    identityStore,
  });
  const blocked = await routerDisabled({ method: 'POST', pathname: '/api/chests/open-all', headers: hdr, body: {}, nowSec: 8005 });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'CHEST_OPEN_DISABLED');

  const routerEnabled = createApiRouter({
    env: { A9_BOT_TOKEN: BOT_TOKEN, A9_CHEST_OPEN_ENABLED: '1' },
    stateStore: emptyStateStore,
    promoEngine: promo,
    chestEngine: chest,
    identityStore,
  });
  const silverRes = await routerEnabled({ method: 'POST', pathname: '/api/chests/open-all', headers: hdr, body: { tier: 'silver' }, nowSec: 8006 });
  assert.equal(silverRes.status, 200);
  assert.equal(silverRes.body.data.openedCount, 1);
  assert.equal(silverRes.body.data.tier, 'silver');
  assert.ok(BigInt(silverRes.body.data.totalRewardA9Raw) <= BigInt(CHEST_MALL_CATALOG.chest_silver.maxBoostA9Raw));

  const restRes = await routerEnabled({ method: 'POST', pathname: '/api/chests/open-all', headers: hdr, body: {}, nowSec: 8007 });
  assert.equal(restRes.status, 200);
  assert.equal(restRes.body.data.openedCount, 1);
  assert.equal((await promo.getBalance(W_OWNER)).claimableRaw, (BigInt(silverRes.body.data.totalRewardA9Raw) + BigInt(restRes.body.data.totalRewardA9Raw)).toString());

  // Config endpoint exposes critTiers
  const cfgRes = await routerEnabled({ method: 'GET', pathname: '/api/config', nowSec: 8008 });
  assert.equal(cfgRes.status, 200);
  assert.equal(cfgRes.body.data.chestMall.critTiers.length, 4);
});

await test('GET /api/chests/crit-feed (Memory + D1): returns only anonymized epic/legendary paid crits sorted newest first', async () => {
  const db = createSqliteD1(MIGRATIONS);
  const d1Chest = new D1ChestEngine({ db });
  const d1Promo = new D1PromoStore({ db, hotWalletAddress: HOT_WALLET });
  const memChest = new ChestEngine();
  const memPromo = new PromoHotWalletEngine({ hotWalletAddress: HOT_WALLET });

  for (const [engine, promo] of [[memChest, memPromo], [d1Chest, d1Promo]]) {
    const cNormal = await engine.createShopBoostChest({ userId: '9601', walletAddress: W_OWNER, skuId: 'chest_bronze', orderId: 'ord_cf_norm' }, 9000);
    const cEpic = await engine.createShopBoostChest({ userId: '9602', walletAddress: W_H1, skuId: 'chest_gold', orderId: 'ord_cf_epic' }, 9001);
    const cLegend = await engine.createShopBoostChest({ userId: '9603', walletAddress: W_H2, skuId: 'chest_diamond', orderId: 'ord_cf_leg' }, 9002);

    // 0.1 -> normal (excluded), 0.95 -> epic (included), 0.995 -> legendary (included)
    await engine.openChest({ chestId: cNormal.chestId, userId: '9601', walletAddress: W_OWNER, promoEngine: promo, randomFn: () => 0.1 }, 9010);
    await engine.openChest({ chestId: cEpic.chestId, userId: '9602', walletAddress: W_H1, promoEngine: promo, randomFn: () => 0.95 }, 9020);
    await engine.openChest({ chestId: cLegend.chestId, userId: '9603', walletAddress: W_H2, promoEngine: promo, randomFn: () => 0.995 }, 9030);

    const router = createApiRouter({
      env: { A9_BOT_TOKEN: BOT_TOKEN },
      stateStore: emptyStateStore,
      chestEngine: engine,
      promoEngine: promo,
    });
    const res = await router({ method: 'GET', pathname: '/api/chests/crit-feed', query: { limit: '10' }, nowSec: 9035 });
    assert.equal(res.status, 200);
    const items = res.body.data.items;
    assert.equal(items.length, 2);
    assert.equal(items[0].critTier, 'legendary');
    assert.equal(items[0].tier, 'diamond');
    assert.equal(items[1].critTier, 'epic');
    assert.equal(items[1].tier, 'gold');
    assert.doesNotMatch(items[0].actor, /9603/);
    assert.equal('ownerUserId' in items[0], false);
  }
});

await test('48H pending vault 6H-before-expiry Bot DM reminder (Memory + D1): exact window filter & strict dedup', async () => {
  const db = createSqliteD1(MIGRATIONS);
  const d1Pred = new D1PredictionEngine({ db });
  const memPred = new PredictionEngine();

  const baseNowSec = 1_800_000_000;
  const baseNowMs = baseNowSec * 1000;

  // Credit 3 users at different times so at checkSec:
  // - user 9701 expires in 3h (IN 6h window -> MUST notify)
  // - user 9702 expires in 12h (OUTSIDE 6h window -> MUST NOT notify)
  // - user 9703 already expired 1h ago (EXPIRED -> MUST NOT notify)
  const checkSec = baseNowSec + 45 * 3600; // 45h after base -> base+48h is 3h away
  for (const pred of [memPred, d1Pred]) {
    await pred.creditPendingBonus('9701', 500_000_000_000n, baseNowMs);
    await pred.creditPendingBonus('9702', 800_000_000_000n, baseNowMs + 9 * 3600 * 1000);
    await pred.creditPendingBonus('9703', 300_000_000_000n, baseNowMs - 4 * 3600 * 1000);

    const sent = [];
    const broadcaster = new TelegramBroadcaster({
      enabled: true,
      botToken: BOT_TOKEN,
      delayMs: 0,
      fetchImpl: async (_url, opts) => {
        sent.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
      },
    });

    const r1 = await broadcaster.sendPendingVaultExpiryReminders({ predictionEngine: pred, nowSec: checkSec });
    assert.equal(r1.skipped, false);
    assert.equal(r1.sentCount, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chat_id, '9701');
    assert.match(sent[0].text, /500 A9/);
    assert.match(sent[0].text, /3 小时后过期/);

    // Second run within same expiry cycle must deduplicate and send 0 messages
    const r2 = await broadcaster.sendPendingVaultExpiryReminders({ predictionEngine: pred, nowSec: checkSec + 600 });
    assert.equal(r2.sentCount, 0);
    assert.equal(r2.skippedDuplicateCount, 1);
    assert.equal(sent.length, 1);
  }
});

await test('Paid referral 1=3 assists acceleration (Memory + D1) & self + direct invitees cumulative purchase volume unlocking Gold free chest', async () => {
  for (const backend of ['memory', 'd1']) {
    const db = backend === 'd1' ? createSqliteD1(MIGRATIONS) : null;
    const chest = backend === 'd1' ? new D1ChestEngine({ db }) : new ChestEngine();
    const promo = backend === 'd1' ? new D1PromoStore({ db, hotWalletAddress: HOT_WALLET }) : new PromoHotWalletEngine({ hotWalletAddress: HOT_WALLET });
    const pred = backend === 'd1' ? new D1PredictionEngine({ db }) : new PredictionEngine();
    const social = backend === 'd1' ? new D1SocialStore({ db }) : new SocialStore();
    const identityStore = new MemoryIdentityStore();
    await identityStore.bindVerifiedWallet('9801', W_OWNER, 9500);
    await identityStore.bindVerifiedWallet('9802', W_H1, 9500);
    await identityStore.bindVerifiedWallet('9803', W_H2, 9500);
    await social.bindReferral('9802', '9801', 9501);
    await social.bindReferral('9803', '9801', 9501);

    const dmSent = [];
    const broadcaster = new TelegramBroadcaster({
      enabled: true,
      botToken: BOT_TOKEN,
      identityStore,
      delayMs: 0,
      fetchImpl: async (_url, opts) => {
        dmSent.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: dmSent.length } }) };
      },
    });

    const presale = backend === 'd1'
      ? new D1PresaleStore({ db, hotWalletAddress: HOT_WALLET, open: true, promoEngine: promo, socialStore: social, identityStore, chestEngine: chest, broadcaster })
      : new PresaleHotWalletEngine({ hotWalletAddress: HOT_WALLET, open: true, promoEngine: promo, socialStore: social, identityStore, chestEngine: chest, broadcaster });

    // Owner opens Starter Bronze (0-assist) -> Silver (2 assists) -> opens Silver -> Gold (10 assists, >= 30 GRAM self+invitees)
    const st = await chest.claimStarterBronzeChests({ userId: '9801', walletAddress: W_OWNER }, 9502);
    await chest.openChest({ chestId: st.chests[0].chestId, userId: '9801', walletAddress: W_OWNER, predictionEngine: pred }, 9503);
    const silver = (await chest.listUserChests('9801')).freeChests.find((c) => c.tier === 'silver');
    await chest.assistChest({ chestId: silver.chestId, helperUserId: '9802', helperWalletAddress: W_H1, walletActive: true }, 9504);
    await chest.assistChest({ chestId: silver.chestId, helperUserId: '9803', helperWalletAddress: W_H2, walletActive: true }, 9505);
    await chest.openChest({ chestId: silver.chestId, userId: '9801', walletAddress: W_OWNER, predictionEngine: pred }, 9506);
    const goldBefore = (await chest.listUserChests('9801')).freeChests.find((c) => c.tier === 'gold');
    assert.equal(goldBefore.status, 'ACTIVE');
    assert.equal(goldBefore.currentAssists, 0);

    // Direct invitee 9802 completes 19.99 GRAM Platinum chest -> triggers +3 assists on owner's Gold chest & DM alert
    const ord1 = await presale.createOrderIntent(W_H1, null, 9510, { skuId: 'chest_platinum', openMode: 'BOOST', tgUserId: '9802', referrerId: '9801' });
    await presale.ingestInbound({ txHash: `tx_acc1_${backend}`, finality: 'finalized', to: HOT_WALLET, from: W_H1, valueNano: ord1.payTonNano, memo: ord1.memo }, 9511);
    await presale.queueConfirmedPayouts(9512);
    await presale.processPayouts(9513, { a9Broadcaster: async () => ({ txHash: `out_acc1_${backend}` }), verifier: async () => ({ state: 'CONFIRMED', txHash: `out_acc1_${backend}` }) });

    const goldAfter1 = await chest.getChest(goldBefore.chestId);
    assert.equal(goldAfter1.currentAssists, 3);
    assert.ok(dmSent.some((m) => m.chat_id === '9801' && /付费好友加速提醒/.test(m.text)));

    // Idempotency: re-calling creditPaidReferralAssist with same orderId adds 0
    const dupBoost = await chest.creditPaidReferralAssist({ referrerUserId: '9801', buyerUserId: '9802', orderId: ord1.orderId }, 9514);
    assert.equal(dupBoost.credited, false);
    assert.equal((await chest.getChest(goldBefore.chestId)).currentAssists, 3);

    // Owner buys 10.98 GRAM (gold chest 9.99 + bronze 0.99); combined self (10.98) + direct invitee (19.99) = 30.97 >= 30 GRAM!
    for (const [idx, sku] of [['a', 'chest_gold'], ['b', 'chest_bronze']]) {
      const o = await presale.createOrderIntent(W_OWNER, null, 9520 + (idx === 'b' ? 5 : 0), { skuId: sku, openMode: 'INSTANT', tgUserId: '9801' });
      await presale.ingestInbound({ txHash: `tx_self_${idx}_${backend}`, finality: 'finalized', to: HOT_WALLET, from: W_OWNER, valueNano: o.payTonNano, memo: o.memo }, 9521);
      await presale.queueConfirmedPayouts(9522);
      await presale.processPayouts(9523, { a9Broadcaster: async () => ({ txHash: `out_self_${idx}_${backend}` }), verifier: async () => ({ state: 'CONFIRMED', txHash: `out_self_${idx}_${backend}` }) });
    }

    // Fill remaining 7 assists on Gold (3 + 7 = 10 -> READY)
    for (let k = 0; k < 7; k += 1) {
      const hx = (0xa0 + k).toString(16).padStart(2, '0');
      await chest.assistChest({ chestId: goldBefore.chestId, helperUserId: `h_gold_${k}`, helperWalletAddress: '0:' + hx.repeat(32), walletActive: true }, 9530 + k);
    }
    assert.equal((await chest.getChest(goldBefore.chestId)).status, 'READY');

    const router = createApiRouter({
      env: { A9_BOT_TOKEN: BOT_TOKEN, A9_CHEST_OPEN_ENABLED: '1' },
      stateStore: emptyStateStore,
      promoEngine: promo,
      presaleEngine: presale,
      socialStore: social,
      predictionEngine: pred,
      chestEngine: chest,
      identityStore,
    });
    const openGoldRes = await router({
      method: 'POST',
      pathname: `/api/chests/${goldBefore.chestId}/open`,
      headers: await tgHeaders(9801, { nowSec: 9540 }),
      body: {},
      nowSec: 9540,
    });
    assert.equal(openGoldRes.status, 200, `${backend} gold open failed: ${JSON.stringify(openGoldRes.body)}`);
    assert.equal(openGoldRes.body.data.rewardA9Raw, '8000000000000');
  }
});

console.log(`All ${passed} A9 v15 Chest Mall & Viral Assist tests passed.`);
