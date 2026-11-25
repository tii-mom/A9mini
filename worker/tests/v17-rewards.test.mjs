// A9 Protocol v17.0 — Dual-Backend (Memory + D1 0001..0015) Unit Tests for:
// 1) 8% Pass-Round Stake Referral Credits (idempotency, budget reserve/release rollback, exhaustion PENDING, auth isolation)
// 2) Per-Round Equal Airdrop Draws (deterministic SHA-256 winner, round_id uniqueness, masking, budget protection)
// 3) Warm-Up v2 '100' A9 intent tier compatibility
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiRouter } from '../src/api.mjs';
import { PromoHotWalletEngine } from '../src/promo-hotwallet.mjs';
import { D1PromoStore } from '../src/d1-promo-store.mjs';
import { MemoryPromoBudgetLedger, D1PromoBudgetLedger } from '../src/promo-budget.mjs';
import { V17RewardEngine, D1V17RewardEngine } from '../src/v17-rewards.mjs';
import { SocialStore } from '../src/social-store.mjs';
import { D1SocialStore } from '../src/d1-growth-store.mjs';
import { MemoryIdentityStore, D1IdentityStore } from '../src/auth.mjs';
import { createSqliteD1, MIGRATIONS, TEST_BOT_TOKEN, tgHeaders } from './helpers/test-env.mjs';

const ADMIN_TOKEN = 'test-admin-secret-v17';
const HOT_WALLET = '0:' + 'aa'.repeat(32);
const WALLET_REFERRER = '0:' + '11'.repeat(32);
const WALLET_REFEREE_A = '0:' + '22'.repeat(32);
const WALLET_REFEREE_B = '0:' + '33'.repeat(32);
const WALLET_OTHER = '0:' + '44'.repeat(32);

function makeStateStore() {
  return {
    getTiming: () => ({ observationSeconds: 43200, vestingSeconds: 1209600, earlyWindowSeconds: 21600 }),
    getProtocolState: () => ({ dataAvailable: true, currentRoundId: 2, poolRemainingRaw: '7000000000000000000' }),
    listRounds: () => [],
    getRound: () => null,
  };
}

function buildBackend(kind) {
  const env = { A9_BOT_TOKEN: TEST_BOT_TOKEN, A9_ADMIN_TOKEN: ADMIN_TOKEN, A9_NETWORK: 'testnet' };
  if (kind === 'd1') {
    const db = createSqliteD1(MIGRATIONS);
    const budgetLedger = new D1PromoBudgetLedger({ db });
    const promoEngine = new D1PromoStore({ db, hotWalletAddress: HOT_WALLET });
    const v17RewardEngine = new D1V17RewardEngine({ db });
    const socialStore = new D1SocialStore({ db });
    const identityStore = new D1IdentityStore({ db });
    const router = createApiRouter({
      env,
      stateStore: makeStateStore(),
      promoEngine,
      socialStore,
      budgetLedger,
      v17RewardEngine,
      identityStore,
    });
    return { env, db, budgetLedger, promoEngine, v17RewardEngine, socialStore, identityStore, router };
  }
  const budgetLedger = new MemoryPromoBudgetLedger();
  const promoEngine = new PromoHotWalletEngine({ hotWalletAddress: HOT_WALLET });
  const v17RewardEngine = new V17RewardEngine();
  const socialStore = new SocialStore();
  const identityStore = new MemoryIdentityStore();
  const router = createApiRouter({
    env,
    stateStore: makeStateStore(),
    promoEngine,
    socialStore,
    budgetLedger,
    v17RewardEngine,
    identityStore,
  });
  return { env, db: null, budgetLedger, promoEngine, v17RewardEngine, socialStore, identityStore, router };
}

for (const kind of ['memory', 'd1']) {
  test(`[${kind}] 8% stake referral settle: idempotency, self-referral guard, auth isolation, and masking`, async () => {
    const { router, promoEngine, budgetLedger, identityStore } = buildBackend(kind);
    const nowSec = 2000;

    // Bind TG user 1001 -> WALLET_REFERRER, user 1002 -> WALLET_OTHER
    await identityStore.bindVerifiedWallet('1001', WALLET_REFERRER, nowSec);
    await identityStore.bindVerifiedWallet('1002', WALLET_OTHER, nowSec);

    // 1) Admin auth required
    const unauthAdmin = await router({
      method: 'POST',
      pathname: '/api/admin/v17/stake-referral/settle',
      body: { roundId: 2, referrerWallet: WALLET_REFERRER, refereeWallet: WALLET_REFEREE_A, refereeRewardRaw: '100000000000000' },
      nowSec,
    });
    assert.equal(unauthAdmin.status, 401);

    // 2) Self-referral rejected
    const selfRes = await router({
      method: 'POST',
      pathname: '/api/admin/v17/stake-referral/settle',
      headers: { 'x-a9-admin-token': ADMIN_TOKEN },
      body: { roundId: 2, referrerWallet: WALLET_REFERRER, refereeWallet: WALLET_REFERRER, refereeRewardRaw: '100000000000000' },
      nowSec,
    });
    assert.equal(selfRes.status, 400);
    assert.equal(selfRes.body.error.code, 'SELF_REFERRAL');

    // 3) Valid 8% settle (100,000 A9 reward -> 8,000 A9 commission)
    const first = await router({
      method: 'POST',
      pathname: '/api/admin/v17/stake-referral/settle',
      headers: { 'x-a9-admin-token': ADMIN_TOKEN },
      body: { roundId: 2, referrerWallet: WALLET_REFERRER, refereeWallet: WALLET_REFEREE_A, refereeRewardRaw: '100000000000000' },
      nowSec,
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.status, 'CREDITED');
    assert.equal(first.body.data.commissionRaw, '8000000000000');
    assert.equal(first.body.data.duplicate, false);

    // 4) Duplicate settle for same roundId + refereeWallet is idempotent (no double credit or budget deduction)
    const dup = await router({
      method: 'POST',
      pathname: '/api/admin/v17/stake-referral/settle',
      headers: { 'x-a9-admin-token': ADMIN_TOKEN },
      body: { roundId: 2, referrerWallet: WALLET_REFERRER, refereeWallet: WALLET_REFEREE_A, refereeRewardRaw: '100000000000000' },
      nowSec: nowSec + 5,
    });
    assert.equal(dup.status, 200);
    assert.equal(dup.body.data.duplicate, true);

    const bal = await promoEngine.getBalance(WALLET_REFERRER);
    assert.equal(bal.claimableRaw, '8000000000000');
    const bucket = await budgetLedger.getBucket('stake_referral');
    assert.equal(bucket.spentRaw, '8000000000000');

    // 5) Anonymous query to /api/v17/stake-referral/me is blocked (401)
    const anonMe = await router({ method: 'GET', pathname: '/api/v17/stake-referral/me', nowSec });
    assert.equal(anonMe.status, 401);

    // 6) Referrer queries own credits (refereeWallet masked); other user sees 0 items
    const h1 = await tgHeaders(1001, { nowSec });
    const me1 = await router({ method: 'GET', pathname: '/api/v17/stake-referral/me', headers: h1, nowSec });
    assert.equal(me1.status, 200);
    assert.equal(me1.body.data.bound, true);
    assert.equal(me1.body.data.totalCommissionRaw, '8000000000000');
    assert.equal(me1.body.data.creditedRaw, '8000000000000');
    assert.equal(me1.body.data.items.length, 1);
    assert.ok(me1.body.data.items[0].refereeWallet.includes('...'));
    assert.notEqual(me1.body.data.items[0].refereeWallet, WALLET_REFEREE_A);

    const h2 = await tgHeaders(1002, { nowSec });
    const me2 = await router({ method: 'GET', pathname: '/api/v17/stake-referral/me', headers: h2, nowSec });
    assert.equal(me2.status, 200);
    assert.equal(me2.body.data.count, 0);
    assert.equal(me2.body.data.items.length, 0);
  });

  test(`[${kind}] 8% stake referral budget exhaustion keeps PENDING and promo failure releases reserved budget`, async () => {
    const { v17RewardEngine, promoEngine, budgetLedger } = buildBackend(kind);
    const nowSec = 3000;

    // 1) Simulate promoEngine failure -> status rolls back to PENDING and reserved budget is released
    const failingPromo = {
      async creditReward() {
        throw new Error('simulated promo store failure');
      },
    };
    await assert.rejects(
      () =>
        v17RewardEngine.settleStakeReferral(
          {
            roundId: 3,
            referrerWallet: WALLET_REFERRER,
            refereeWallet: WALLET_REFEREE_A,
            refereeRewardRaw: '100000000000000',
            promoEngine: failingPromo,
            budgetLedger,
          },
          nowSec,
        ),
      /simulated promo store failure/,
    );
    const bucketAfterFail = await budgetLedger.getBucket('stake_referral');
    assert.equal(bucketAfterFail.spentRaw, '0', 'failed credit must release reserved budget');

    // Retry with healthy promoEngine succeeds from PENDING -> CREDITED
    const recovered = await v17RewardEngine.settleStakeReferral(
      {
        roundId: 3,
        referrerWallet: WALLET_REFERRER,
        refereeWallet: WALLET_REFEREE_A,
        refereeRewardRaw: '100000000000000',
        promoEngine,
        budgetLedger,
      },
      nowSec + 10,
    );
    assert.equal(recovered.status, 'CREDITED');
    assert.equal((await budgetLedger.getBucket('stake_referral')).spentRaw, '8000000000000');

    // 2) Cap budget below next commission -> stays PENDING without losing ledger row
    await budgetLedger.setBucketCap('stake_referral', '9000000000000', nowSec + 20);
    const exhausted = await v17RewardEngine.settleStakeReferral(
      {
        roundId: 3,
        referrerWallet: WALLET_REFERRER,
        refereeWallet: WALLET_REFEREE_B,
        refereeRewardRaw: '100000000000000',
        promoEngine,
        budgetLedger,
      },
      nowSec + 21,
    );
    assert.equal(exhausted.status, 'PENDING');
    assert.equal(exhausted.budgetExhausted, true);

    const summary = await v17RewardEngine.getUserStakeReferrals(WALLET_REFERRER);
    assert.equal(summary.creditedRaw, '8000000000000');
    assert.equal(summary.pendingRaw, '8000000000000');
    assert.equal(summary.totalCommissionRaw, '16000000000000');
  });

  test(`[${kind}] per-round equal airdrop draw: uniqueness, public masking, failure release, and budget cap`, async () => {
    const { router, promoEngine, budgetLedger, v17RewardEngine } = buildBackend(kind);
    const nowSec = 4000;
    const participants = [WALLET_REFERRER, WALLET_REFEREE_A, WALLET_REFEREE_B];

    // 1) Admin auth required
    const unauth = await router({
      method: 'POST',
      pathname: '/api/admin/v17/airdrop/draw',
      body: { roundId: 1, participants, seedHash: '0xabc123', prizeRaw: '50000000000000' },
      nowSec,
    });
    assert.equal(unauth.status, 401);

    // 2) Draw Round #1
    const draw1 = await router({
      method: 'POST',
      pathname: '/api/admin/v17/airdrop/draw',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { roundId: 1, participants, seedHash: '0xabc123', prizeRaw: '50000000000000' },
      nowSec,
    });
    assert.equal(draw1.status, 200);
    assert.equal(draw1.body.data.status, 'CREDITED');
    assert.equal(draw1.body.data.duplicate, false);
    assert.ok(participants.includes(draw1.body.data.winnerWallet));

    // 3) Re-drawing Round #1 is idempotent (same winner, no double credit)
    const draw1Dup = await router({
      method: 'POST',
      pathname: '/api/admin/v17/airdrop/draw',
      headers: { 'x-a9-admin-token': ADMIN_TOKEN },
      body: { roundId: 1, participants, seedHash: '0xDIFFERENT_SEED', prizeRaw: '50000000000000' },
      nowSec: nowSec + 5,
    });
    assert.equal(draw1Dup.status, 200);
    assert.equal(draw1Dup.body.data.duplicate, true);
    assert.equal(draw1Dup.body.data.winnerWallet, draw1.body.data.winnerWallet);

    const winnerBal = await promoEngine.getBalance(draw1.body.data.winnerWallet);
    assert.equal(winnerBal.claimableRaw, '50000000000000');

    // 4) Public GET /api/v17/airdrop/draws returns masked winner & bucketRemainingRaw
    const pub = await router({ method: 'GET', pathname: '/api/v17/airdrop/draws', query: { limit: '10' }, nowSec });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.data.items.length, 1);
    assert.ok(pub.body.data.items[0].winnerWallet.includes('...'));
    assert.notEqual(pub.body.data.items[0].winnerWallet, draw1.body.data.winnerWallet);
    assert.equal(pub.body.data.items[0].seedHash, '0xabc123');
    assert.equal(
      BigInt(pub.body.data.bucketRemainingRaw),
      50_000_000n * 1_000_000_000n - 50_000_000_000_000n,
    );

    // 5) Budget exhaustion keeps PENDING
    await budgetLedger.setBucketCap('round_airdrop', '60000000000000', nowSec + 10);
    const draw2 = await v17RewardEngine.drawRoundAirdrop(
      { roundId: 2, participants, seedHash: '0xdef456', prizeRaw: '50000000000000', promoEngine, budgetLedger },
      nowSec + 11,
    );
    assert.equal(draw2.status, 'PENDING');
    assert.equal(draw2.budgetExhausted, true);

    // 缺失 promoEngine 时必须拒绝执行而非把预算扣掉
    await assert.rejects(
      v17RewardEngine.drawRoundAirdrop(
        { roundId: 3, participants, seedHash: '0xghi789', prizeRaw: '5000000000000', promoEngine: null, budgetLedger },
        nowSec + 12,
      ),
      { code: 'PROMO_ENGINE_REQUIRED' },
    );

    // PENDING 状态下调低 prizeRaw 重试必须允许更新金额并成功发放
    const draw2Retry = await v17RewardEngine.drawRoundAirdrop(
      { roundId: 2, participants, seedHash: '0xdef456', prizeRaw: '5000000000000', promoEngine, budgetLedger },
      nowSec + 13,
    );
    assert.equal(draw2Retry.status, 'CREDITED');
    assert.equal(draw2Retry.prizeRaw, '5000000000000');
  });

  test(`[${kind}] warmup intentTier accepts '100' A9 tier and accounts it in admin summary`, async () => {
    const { router, socialStore } = buildBackend(kind);
    const nowSec = 5000;
    const h = await tgHeaders(2001, { nowSec });

    const reg = await router({
      method: 'POST',
      pathname: '/api/warmup/register',
      headers: h,
      body: { roundId: 4, intentTier: '100', remindEnabled: true },
      nowSec,
    });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.data.reservation.intentTier, '100');

    const summary = await socialStore.getWarmupAdminSummary(4);
    assert.equal(summary.intentBreakdown['100'], 1);
    assert.equal(summary.estimatedIntentA9Min, 100);
  });
}
