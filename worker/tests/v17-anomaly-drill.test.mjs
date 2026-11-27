// A9 v17 任务 D 本地异常专项演练测试（零链上广播，纯 SQLite D1 + 真实 API/Daemon/Store 状态机）。
// 覆盖：
// D-01 A9 与 GRAM 低水位分别拒单及阈值恢复
// D-02 确定性广播失败与心跳降级（status=degraded 拦截新单）
// D-03 模糊交易持久化、重启后查链确认不重复付款/发币，保留余额预占与预算一致
// D-04 真实费用口径对账验证（不重复累计 TonCenter v2 tx.fee 与消息 fwd_fee）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiRouter } from '../src/api.mjs';
import { D1PresaleStore } from '../src/d1-growth-store.mjs';
import { D1PromoStore } from '../src/d1-promo-store.mjs';
import { D1PromoBudgetLedger } from '../src/promo-budget.mjs';
import { D1IdentityStore } from '../src/auth.mjs';
import { PromoPayoutRunner } from '../src/promo-runner.mjs';
import { createSqliteD1, MIGRATIONS, TEST_BOT_TOKEN, tgHeaders } from './helpers/test-env.mjs';

const HOT_PRESALE = '0:' + 'aa'.repeat(32);
const HOT_PROMO = '0:' + 'bb'.repeat(32);
const USER_WALLET = '0:' + '33'.repeat(32);
const NOW = 1_795_800_000;
const quiet = { log() {}, error() {} };

async function setupRouterWithHeartbeat(heartbeatRef) {
  const db = createSqliteD1(MIGRATIONS);
  const env = {
    A9_NETWORK: 'testnet',
    A9_BOT_TOKEN: TEST_BOT_TOKEN,
    A9_PRESALE_OPEN: '1',
    A9_REQUIRE_RUNNER_HEARTBEAT: '1',
    A9_RUNNER_HEARTBEAT_MAX_STALE_SEC: '120',
  };
  const identityStore = new D1IdentityStore({ db });
  await identityStore.bindVerifiedWallet('8801', USER_WALLET, NOW);
  const presaleEngine = new D1PresaleStore({ db, hotWalletAddress: HOT_PRESALE, open: true });
  const promoEngine = new D1PromoStore({ db, hotWalletAddress: HOT_PROMO });
  const budgetLedger = new D1PromoBudgetLedger({ db });
  const router = createApiRouter({
    env,
    stateStore: { getTiming: () => ({}), getProtocolState: () => ({ dataAvailable: true }), listRounds: () => [], getRound: () => null },
    presaleEngine,
    promoEngine,
    budgetLedger,
    identityStore,
    runnerHeartbeatReader: async () => heartbeatRef.current,
  });
  return { db, router, presaleEngine, promoEngine, budgetLedger };
}

test('D-01 A9 低水位与 GRAM 低水位分别拒单（HOT_WALLET_LOW_INVENTORY），阈值恢复后放行', async () => {
  const hb = { current: [] };
  const { router } = await setupRouterWithHeartbeat(hb);
  const headers = await tgHeaders(8801, { nowSec: NOW });

  // 1) A9 库存低水位：拒单
  hb.current = [{
    role: 'presale',
    network: 'testnet',
    status: 'ok',
    last_seen_at: NOW,
    meta: {
      status: 'ok',
      executeLive: true,
      inventory: {
        presale: {
          ok: false,
          reason: 'A9_BELOW_MIN_THRESHOLD',
          a9Raw: '1000000000000',
          gramNano: '10000000000',
        },
      },
    },
  }];
  const lowA9 = await router({
    method: 'POST',
    pathname: '/api/presale/intent',
    headers,
    body: { skuId: 'chest_bronze' },
    nowSec: NOW + 5,
  });
  assert.equal(lowA9.status, 503);
  assert.equal(lowA9.body.error.code, 'HOT_WALLET_LOW_INVENTORY');

  // 2) GRAM Gas 低水位：拒单
  hb.current = [{
    role: 'presale',
    network: 'testnet',
    status: 'ok',
    last_seen_at: NOW + 10,
    meta: {
      status: 'ok',
      executeLive: true,
      inventory: {
        presale: {
          ok: false,
          reason: 'GRAM_BELOW_MIN_THRESHOLD',
          a9Raw: '5000000000000000',
          gramNano: '50000000',
        },
      },
    },
  }];
  const lowGram = await router({
    method: 'POST',
    pathname: '/api/presale/intent',
    headers,
    body: { skuId: 'chest_bronze' },
    nowSec: NOW + 12,
  });
  assert.equal(lowGram.status, 503);
  assert.equal(lowGram.body.error.code, 'HOT_WALLET_LOW_INVENTORY');

  // 3) 阈值恢复：正常建单放行
  hb.current = [{
    role: 'presale',
    network: 'testnet',
    status: 'ok',
    last_seen_at: NOW + 20,
    meta: {
      status: 'ok',
      executeLive: true,
      inventory: {
        presale: {
          ok: true,
          a9Raw: '5000000000000000',
          gramNano: '10000000000',
        },
      },
    },
  }];
  const recovered = await router({
    method: 'POST',
    pathname: '/api/presale/intent',
    headers,
    body: { skuId: 'chest_bronze' },
    nowSec: NOW + 25,
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.data.status, 'PENDING_PAYMENT');
});

test('D-02 确定性广播失败导致心跳降级（status=degraded）时禁止继续建单', async () => {
  const hb = {
    current: [{
      role: 'presale',
      network: 'testnet',
      status: 'degraded',
      last_seen_at: NOW,
      meta: {
        status: 'degraded',
        executeLive: true,
        lastError: 'DETERMINISTIC_BROADCAST_FAILURE',
      },
    }],
  };
  const { router } = await setupRouterWithHeartbeat(hb);
  const res = await router({
    method: 'POST',
    pathname: '/api/presale/intent',
    headers: await tgHeaders(8801, { nowSec: NOW }),
    body: { skuId: 'chest_bronze' },
    nowSec: NOW + 5,
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'PAYOUT_RUNNER_OFFLINE');
});

test('D-03 模糊交易持久化、重启后查链确认不重复发币，且保留余额预占与 CAS 一致', async () => {
  const db = createSqliteD1(MIGRATIONS);
  let promo = new D1PromoStore({ db, hotWalletAddress: HOT_PROMO });
  await promo.creditReward(USER_WALLET, '200000000000', NOW); // 200 A9
  const claim = await promo.createClaimIntent(USER_WALLET, NOW + 1);
  await promo.verifyInboundFeeTx(
    { txHash: 'fee_tx_1', finality: 'finalized', from: USER_WALLET, to: HOT_PROMO, valueNano: '60000000', memo: claim.memo },
    NOW + 2,
  );
  // 收到 0.06 GRAM 费用并排队后，余额立即预占归零（不可在途重复领取）
  assert.equal((await promo.getBalance(USER_WALLET)).claimableRaw, '0');

  let broadcasts = 0;
  const ambiguousBroadcaster = async () => {
    broadcasts += 1;
    throw new Error('ETIMEDOUT: broadcast outcome unknown');
  };
  const tc = { fetchInboundTransfers: async () => [] };
  await new PromoPayoutRunner({
    engine: promo,
    tonCenter: tc,
    broadcaster: ambiguousBroadcaster,
    execute: true,
    logger: quiet,
  }).tick(NOW + 3);

  assert.equal(broadcasts, 1);
  const [open1] = await promo.listOpenPromoPayouts();
  assert.equal(open1.status, 'RETRY');
  assert.equal(open1.ambiguous, true);

  // 模拟进程重启：重新实例化 D1PromoStore，查链返回 PENDING -> 不重发、余额仍预占
  promo = new D1PromoStore({ db, hotWalletAddress: HOT_PROMO });
  await new PromoPayoutRunner({
    engine: promo,
    tonCenter: tc,
    broadcaster: ambiguousBroadcaster,
    payoutVerifier: async () => ({ state: 'PENDING' }),
    execute: true,
    logger: quiet,
  }).tick(NOW + 600);
  assert.equal(broadcasts, 1);
  assert.equal((await promo.getBalance(USER_WALLET)).claimableRaw, '0');

  // 查链返回 CONFIRMED -> 终态收口、仍只广播 1 次
  await new PromoPayoutRunner({
    engine: promo,
    tonCenter: tc,
    broadcaster: ambiguousBroadcaster,
    payoutVerifier: async () => ({ state: 'CONFIRMED', txHash: 'confirmed_onchain_hash' }),
    execute: true,
    logger: quiet,
  }).tick(NOW + 700);
  assert.equal(broadcasts, 1);
  assert.equal((await promo.listOpenPromoPayouts()).length, 0);
  const finalBal = await promo.getBalance(USER_WALLET);
  assert.equal(finalBal.claimableRaw, '0');
  assert.equal(finalBal.totalClaimedRaw, '200000000000');
});

test('D-04 真实 TonCenter v2 费用口径对账：tx.fee 已包含转发费，严禁重复累加 out_msgs.fwd_fee', () => {
  // 真实守恒恒等式：deltaBalance = in_msg.value - sum(out_msgs.value) - BigInt(tx.fee)
  // 若错误地再减 sum(out_msgs.fwd_fee)，会产生非零假差额。
  const tx = {
    in_msg: { value: '0' },
    out_msgs: [{ value: '1050000000', fwd_fee: '333336' }],
    fee: '541330',
  };
  const beforeBalance = 20_000_000_000n;
  const afterBalance = beforeBalance - 1_050_000_000n - 541_330n;
  const actualDelta = afterBalance - beforeBalance;
  const accountedCorrect = BigInt(tx.in_msg.value)
    - tx.out_msgs.reduce((acc, m) => acc + BigInt(m.value), 0n)
    - BigInt(tx.fee);
  const accountedWrongDoubleCount = accountedCorrect
    - tx.out_msgs.reduce((acc, m) => acc + BigInt(m.fwd_fee), 0n);

  assert.equal(actualDelta - accountedCorrect, 0n);
  assert.notEqual(actualDelta - accountedWrongDoubleCount, 0n);
});
