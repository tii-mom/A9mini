// A9 Protocol v15 — Chest Mall & Viral Social Assist Full-Stack Tests (Memory + Migrated SQLite D1).
import assert from 'node:assert/strict';
import { ChestEngine, CHEST_MALL_CATALOG, CAPTAIN_FOUNDING_BONUS_RAW } from '../src/chest-engine.mjs';
import { D1ChestEngine } from '../src/d1-chest-store.mjs';
import { D1PresaleStore, D1SocialStore, D1PredictionEngine } from '../src/d1-growth-store.mjs';
import { D1PromoStore } from '../src/d1-promo-store.mjs';
import { PresaleHotWalletEngine, PASSIVE_FREE_MIN_NANO } from '../src/presale-hotwallet.mjs';
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

await test('Real TonCenterClient.fetchWalletAccountState format: active passes, uninitialized rejects, RPC failure returns 503', async () => {
  const chest = new ChestEngine();
  const pred = new PredictionEngine();
  const identityStore = new MemoryIdentityStore();
  await identityStore.bindVerifiedWallet('1001', W_OWNER, 1000);
  await identityStore.bindVerifiedWallet('2001', W_H1, 1000);
  await identityStore.bindVerifiedWallet('2002', W_H2, 1000);
  await identityStore.bindVerifiedWallet('2003', W_H3, 1000);

  const starter = await chest.claimStarterBronzeChests({ userId: '1001', walletAddress: W_OWNER }, 1000);
  const b1 = starter.chests[0];

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
  await presale.ingestInbound({ txHash: 'tx_gold_in', finality: 'finalized', to: HOT_WALLET, from: W_OWNER, valueNano: '9990000000', memo: ord.memo }, 1010);
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

  // Assist inflates boost, owner opens and receives promo balance
  const ast = await chest.assistChest({ chestId: sc.chestId, helperUserId: '2001', helperWalletAddress: W_H1, walletActive: true }, 1030);
  assert.ok(BigInt(ast.boostDeltaRaw) > 0n);
  const res = await chest.openChest({ chestId: sc.chestId, userId: '1001', walletAddress: W_OWNER, promoEngine: promo }, 1040);
  assert.equal(res.destination, 'PROMO_BALANCE');
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
  await presale.ingestInbound({ txHash: 'tx_inv_099', finality: 'finalized', to: HOT_WALLET, from: W_H1, valueNano: '990000000', memo: ord.memo }, 1015);
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

  // Captain verifies TG group with 88 members -> 5,000 A9 founding bonus
  await router({ method: 'POST', pathname: '/api/team/bind-tg', headers: hdrOwner, body: { teamId: 'TM-88', name: 'Alpha', tgGroupHandle: '@a9squad' }, nowSec: 1035 });
  const verRes = await router({ method: 'POST', pathname: '/api/team/verify-tg', headers: hdrOwner, body: { teamId: 'TM-88' }, nowSec: 1040 });
  assert.equal(verRes.status, 200);
  assert.equal(verRes.body.data.tgMemberCount, 88);
  assert.equal(verRes.body.data.captainBonus.granted, true);
  assert.equal(verRes.body.data.captainBonus.amountRaw, CAPTAIN_FOUNDING_BONUS_RAW.toString());

  // Independent Chest Open switch: EVEN when presaleEngine.open=true (购箱已开), without A9_CHEST_OPEN_ENABLED='1', /api/chests/:id/open returns 403 and writes 0 to reward tables
  const starter = await chest.claimStarterBronzeChests({ userId: '1001', walletAddress: W_OWNER }, 1041);
  const b1 = starter.chests[0];
  await chest.assistChest({ chestId: b1.chestId, helperUserId: '2001', helperWalletAddress: W_H1, walletActive: true }, 1042);
  await chest.assistChest({ chestId: b1.chestId, helperUserId: '2002', helperWalletAddress: W_H2, walletActive: true }, 1043);
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

  // 2) Atomic openChest rollback proof: inject a SQLite trigger that fails prediction_rewards INSERT
  const starter = await d1Chest.claimStarterBronzeChests({ userId: '3001', walletAddress: W_OWNER }, 2010);
  const b1 = starter.chests[0];
  await d1Chest.assistChest({ chestId: b1.chestId, helperUserId: '3002', helperWalletAddress: W_H1, walletActive: true }, 2011);
  await d1Chest.assistChest({ chestId: b1.chestId, helperUserId: '3003', helperWalletAddress: W_H2, walletActive: true }, 2012);

  db.exec(`CREATE TRIGGER fail_pred_reward BEFORE INSERT ON prediction_rewards BEGIN SELECT RAISE(ABORT, 'injected_reward_write_failure'); END;`);
  await assert.rejects(
    () => d1Chest.openChest({ chestId: b1.chestId, userId: '3001', walletAddress: W_OWNER, predictionEngine: d1Pred }, 2015),
    /injected_reward_write_failure/,
  );
  // Chest MUST NOT be stuck OPENED after failed reward write!
  assert.equal((await d1Chest.getChest(b1.chestId)).status, 'READY');
  assert.equal((await d1Pred.getUserSummary('3001')).pendingActivationRaw, '0');

  // Drop fault trigger -> retry succeeds atomically, credits 300 A9 & unlocks Bronze #2
  db.exec('DROP TRIGGER fail_pred_reward;');
  const opened = await d1Chest.openChest({ chestId: b1.chestId, userId: '3001', walletAddress: W_OWNER, predictionEngine: d1Pred }, 2020);
  assert.equal(opened.chest.status, 'OPENED');
  assert.equal(opened.nextUnlocked.slotIndex, 2);
  assert.equal(opened.nextUnlocked.status, 'ACTIVE');
  assert.equal((await d1Pred.getUserSummary('3001')).pendingActivationRaw, '300000000000');

  // 2b) Same-second concurrent openChest + BigInt (>2^63) precision proof:
  // Pre-seed promo_balances with 20000000000000000000 (2e19, overflows SQLite 64-bit signed INTEGER).
  // Create Bronze SHOP_BOOST chest (+1% = 19819800000 raw = 19.8198 A9) and race 2 opens in the EXACT same second.
  await db.prepare("INSERT INTO promo_balances (wallet_address, claimable_raw, total_claimed_raw, updated_at) VALUES (?, '20000000000000000000', '0', 2021)").bind(W_OWNER).run();
  const shopBronze = await d1Chest.createShopBoostChest({ userId: '3001', walletAddress: W_OWNER, skuId: 'chest_bronze', orderId: 'ord_bigint_race' }, 2021);
  assert.equal(shopBronze.boostA9Raw, '19819800000');
  const sameSecRace = await Promise.allSettled([
    d1Chest.openChest({ chestId: shopBronze.chestId, userId: '3001', walletAddress: W_OWNER, promoEngine: d1Promo }, 2022),
    d1Chest.openChest({ chestId: shopBronze.chestId, userId: '3001', walletAddress: W_OWNER, promoEngine: d1Promo }, 2022),
  ]);
  assert.equal(sameSecRace.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(sameSecRace.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(sameSecRace.find((r) => r.status === 'rejected').reason.code, 'ALREADY_OPENED');
  // Exact decimal string: 20000000000000000000 + 19819800000 = 20000000019819800000 (NOT double-credited, NOT float!)
  assert.equal((await d1Promo.getBalance(W_OWNER)).claimableRaw, '20000000019819800000');

  // 3) Concurrent assist on the final slot of Bronze #2: 2 distinct helpers race -> 1 succeeds, 0 orphan rows
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

  // 4) Concurrent daily 3-assist cap: 1 helper races across 4 distinct owners on same UTC day -> exactly 3 succeed, 4th gets DAILY_ASSIST_LIMIT
  const helperWallet = '0:8888888888888888888888888888888888888888888888888888888888888888';
  const owners = ['4001', '4002', '4003', '4004'];
  const ownerChests = [];
  for (const ou of owners) {
    const st = await d1Chest.claimStarterBronzeChests({ userId: ou, walletAddress: `0:${ou.padEnd(64, 'a')}` }, 3000);
    ownerChests.push(st.chests[0]);
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

  // 5) Open-vs-assist race: if an assist lands after openChest reads the chest but before db.batch() commits,
  //    openChest MUST NOT settle at stale 19.8198 A9 — it must re-read and credit the updated 69.3693 A9!
  const raceOwnerWallet = '0:9999999999999999999999999999999999999999999999999999999999999999';
  const raceHelperWallet = '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const shopRace = await d1Chest.createShopBoostChest(
    { userId: '6002', walletAddress: raceOwnerWallet, skuId: 'chest_bronze', orderId: 'ord_assist_open_race' },
    3015,
  );
  assert.equal(shopRace.boostA9Raw, '19819800000');
  let injectedAssistOnce = false;
  const raceDb = {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    async batch(stmts) {
      if (!injectedAssistOnce) {
        injectedAssistOnce = true;
        await d1Chest.assistChest(
          { chestId: shopRace.chestId, helperUserId: '6003', helperWalletAddress: raceHelperWallet, walletActive: true },
          3016,
        );
      }
      return db.batch(stmts);
    },
  };
  const d1ChestRace = new D1ChestEngine({ db: raceDb });
  const raceOpened = await d1ChestRace.openChest(
    { chestId: shopRace.chestId, userId: '6002', walletAddress: raceOwnerWallet, promoEngine: d1Promo },
    3017,
  );
  assert.equal(injectedAssistOnce, true);
  assert.equal(raceOpened.chest.status, 'OPENED');
  assert.equal(raceOpened.chest.currentAssists, 1);
  assert.equal(raceOpened.chest.boostA9Raw, '69369300000');
  assert.equal(raceOpened.rewardA9Raw, '69369300000');
  assert.equal((await d1Promo.getBalance(raceOwnerWallet)).claimableRaw, '69369300000');

  // 6) Captain founding bonus atomic rollback on prediction_rewards write failure -> retry succeeds once with 5,000 A9
  db.exec(`CREATE TRIGGER fail_captain_vault BEFORE INSERT ON prediction_rewards BEGIN SELECT RAISE(ABORT, 'injected_captain_vault_fail'); END;`);
  await assert.rejects(
    () => d1Chest.grantCaptainFoundingBonus({ teamId: 'TM-ATOMIC', captainUserId: '6001', captainWallet: W_H4, tgMemberCount: 120, predictionEngine: d1Pred }, 3020),
    /injected_captain_vault_fail/,
  );
  const failedGrantRow = await db.prepare('SELECT * FROM captain_founding_bonuses WHERE team_id = ?').bind('TM-ATOMIC').first();
  assert.equal(failedGrantRow, null);
  assert.equal((await d1Pred.getUserSummary('6001')).pendingActivationRaw, '0');

  db.exec('DROP TRIGGER fail_captain_vault;');
  const g1 = await d1Chest.grantCaptainFoundingBonus({ teamId: 'TM-ATOMIC', captainUserId: '6001', captainWallet: W_H4, tgMemberCount: 120, predictionEngine: d1Pred }, 3022);
  assert.equal(g1.granted, true);
  assert.equal(g1.amountRaw, CAPTAIN_FOUNDING_BONUS_RAW.toString());
  assert.equal((await d1Pred.getUserSummary('6001')).pendingActivationRaw, '5000000000000');

  const g2 = await d1Chest.grantCaptainFoundingBonus({ teamId: 'TM-ATOMIC', captainUserId: '6001', captainWallet: W_H4, tgMemberCount: 120, predictionEngine: d1Pred }, 3025);
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
    if (String(url).includes('/getChat?')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: -1001, type: 'supergroup', username: 'a9test' } }) };
    }
    if (String(url).includes('/getChatMember?')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { status: 'creator' } }) };
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
    assert.equal(calls.length, 5);
  } finally {
    globalThis.fetch = origFetch;
  }
});

console.log(`All ${passed} A9 v15 Chest Mall & Viral Assist tests passed.`);
