// A9 v17 任务 B 专项测试：返佣与空投链上终局核验、防篡改、原子批次预算一致性与主网 503 门禁保留。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiRouter } from '../src/api.mjs';
import { D1PromoBudgetLedger } from '../src/promo-budget.mjs';
import { D1PromoStore } from '../src/d1-promo-store.mjs';
import { D1V17RewardEngine } from '../src/v17-rewards.mjs';
import {
  buildVerifiedRoundFinalitySnapshot,
  settleVerifiedStakeReferralsBatch,
  drawVerifiedRoundAirdrop,
  RC_STATUS_ACTIVE,
  RC_STATUS_SUCCEEDED,
} from '../src/v17-finality-verifier.mjs';
import { createSqliteD1, MIGRATIONS } from './helpers/test-env.mjs';

const MIGRATIONS_WITH_0016 = [
  ...MIGRATIONS,
  '../../migrations/0016_v17_finality_snapshots.sql',
];

const RC_ADDR = '0:' + 'aa'.repeat(32);
const HOT_WALLET = '0:' + 'bb'.repeat(32);
const REFERRER_1 = '0:' + '11'.repeat(32);
const REFERRER_2 = '0:' + '22'.repeat(32);
const USER_A = '0:' + '33'.repeat(32);
const USER_B = '0:' + '44'.repeat(32);
const USER_EXITED = '0:' + '55'.repeat(32);

const CANDLE_HASH = '0x' + 'ab'.repeat(32);
const SETTLE_TX_HASH = '0x' + 'cd'.repeat(32);

function makeValidChainReader(overrides = {}) {
  const round = {
    status: RC_STATUS_SUCCEEDED,
    stakeOpenAt: 1700000000,
    stakeCloseAt: 1700086400,
    settledAt: 1700130000,
    totalStakeRaw: '300000000000000', // 300,000 A9
    rewardBudgetRaw: '600000000000000', // 600,000 A9（每人 2x）
    qualifiedCandles: 9,
    candleHash: CANDLE_HASH,
    ...(overrides.round || {}),
  };
  const events = {
    complete: true,
    settlementEvent: {
      txHash: SETTLE_TX_HASH,
      roundId: 1,
      status: round.status,
      qualifiedCandles: round.qualifiedCandles,
      candleHash: round.candleHash,
      totalStakeRaw: round.totalStakeRaw,
      rewardBudgetRaw: round.rewardBudgetRaw,
    },
    depositEvents: [
      { roundId: 1, owner: USER_A, amountRaw: '100000000000000' },
      { roundId: 1, owner: USER_B, amountRaw: '200000000000000' },
      { roundId: 1, owner: USER_EXITED, amountRaw: '50000000000000' },
      // 重复入金事件应被自动去重并以 StakeTicket 最终状态为准
      { roundId: 1, owner: USER_A, amountRaw: '100000000000000' },
    ],
    earlyExitEvents: [
      { roundId: 1, owner: USER_EXITED, refundRaw: '42500000000000', burnedRaw: '7500000000000' },
    ],
    ...(overrides.events || {}),
  };
  const tickets = {
    [USER_A]: { roundId: 1, owner: USER_A, amountRaw: '100000000000000', exited: false },
    [USER_B]: { roundId: 1, owner: USER_B, amountRaw: '200000000000000', exited: false },
    [USER_EXITED]: { roundId: 1, owner: USER_EXITED, amountRaw: '0', exited: true },
    ...(overrides.tickets || {}),
  };
  return {
    getRound: async () => round,
    getRoundEvents: async () => events,
    getTicketState: async (_rc, owner) => tickets[owner] || null,
  };
}

test('B-01 链上终局快照严格重建参与者、排除提前解押、校验守恒并派生可复算空投种子', async () => {
  const snap = await buildVerifiedRoundFinalitySnapshot({
    network: 'testnet',
    roundController: RC_ADDR,
    roundId: 1,
    chainReader: makeValidChainReader(),
  });

  assert.equal(snap.roundId, 1);
  assert.equal(snap.statusCode, RC_STATUS_SUCCEEDED);
  assert.equal(snap.participantCount, 2); // USER_EXITED 已排除
  assert.deepEqual(snap.participants.map((p) => p.walletKey), [USER_A, USER_B]);
  // USER_A: 100k/300k * 600k = 200k A9；USER_B: 200k/300k * 600k = 400k A9
  assert.equal(snap.participants[0].computedRewardRaw, '200000000000000');
  assert.equal(snap.participants[1].computedRewardRaw, '400000000000000');
  assert.match(snap.airdropSeedHash, /^0x[0-9a-f]{64}$/);
  assert.match(snap.evidenceHash, /^0x[0-9a-f]{64}$/);
});

test('B-02 缺少终局、事件分页不完整、守恒不符、事件与getter冲突一律 fail-closed', async () => {
  // 未终局（ACTIVE）
  await assert.rejects(
    () => buildVerifiedRoundFinalitySnapshot({
      network: 'testnet',
      roundController: RC_ADDR,
      roundId: 1,
      chainReader: makeValidChainReader({ round: { status: RC_STATUS_ACTIVE } }),
    }),
    /ROUND_NOT_FINAL|not in final status/,
  );

  // 历史分页不完整（complete=false）
  await assert.rejects(
    () => buildVerifiedRoundFinalitySnapshot({
      network: 'testnet',
      roundController: RC_ADDR,
      roundId: 1,
      chainReader: makeValidChainReader({ events: { complete: false } }),
    }),
    /incomplete/,
  );

  // 参与者锁仓总和与链上 totalStakeRaw 不符（缺漏某参与者）
  await assert.rejects(
    () => buildVerifiedRoundFinalitySnapshot({
      network: 'testnet',
      roundController: RC_ADDR,
      roundId: 1,
      chainReader: makeValidChainReader({
        tickets: { [USER_B]: { roundId: 1, owner: USER_B, amountRaw: '199999999999999', exited: false } },
      }),
    }),
    /stake sum.*!= on-chain/,
  );

  // EvRoundSettled 缺少或篡改
  await assert.rejects(
    () => buildVerifiedRoundFinalitySnapshot({
      network: 'testnet',
      roundController: RC_ADDR,
      roundId: 1,
      chainReader: makeValidChainReader({ events: { settlementEvent: null } }),
    }),
    /EvRoundSettled missing/,
  );
});

test('B-03 返佣与空投：同轮重放零增量、冲突证据拒绝、并发不双发、超预算整批原子失败', async () => {
  const db = createSqliteD1(MIGRATIONS_WITH_0016);
  const budgetLedger = new D1PromoBudgetLedger({ db });
  const promoStore = new D1PromoStore({ db, hotWalletAddress: HOT_WALLET });
  const snap = await buildVerifiedRoundFinalitySnapshot({
    network: 'testnet',
    roundController: RC_ADDR,
    roundId: 1,
    chainReader: makeValidChainReader(),
  });

  const referrerMap = new Map([
    [USER_A, REFERRER_1],
    [USER_B, REFERRER_2],
  ]);

  // 1) 首次整批原子结算返佣：USER_A 200k*8%=16k A9, USER_B 400k*8%=32k A9, 合计 48k A9
  const first = await settleVerifiedStakeReferralsBatch({
    db,
    budgetLedger,
    expectedNetwork: 'testnet',
    expectedRoundController: RC_ADDR,
    snapshot: snap,
    resolveReferrerWallet: (w) => referrerMap.get(w) || null,
    nowSec: 1700130100,
  });
  assert.equal(first.creditedCount, 2);
  assert.equal(first.totalCommissionRaw, '48000000000000');

  const bal1 = await promoStore.getBalance(REFERRER_1);
  const bal2 = await promoStore.getBalance(REFERRER_2);
  assert.equal(bal1.claimableRaw, '16000000000000');
  assert.equal(bal2.claimableRaw, '32000000000000');

  // 2) 同一轮相同证据重启/重复执行：零增量
  const replay = await settleVerifiedStakeReferralsBatch({
    db,
    budgetLedger,
    expectedNetwork: 'testnet',
    expectedRoundController: RC_ADDR,
    snapshot: snap,
    resolveReferrerWallet: (w) => referrerMap.get(w) || null,
    nowSec: 1700130200,
  });
  assert.equal(replay.creditedCount, 0);
  assert.equal(replay.duplicate, true);
  assert.equal((await promoStore.getBalance(REFERRER_1)).claimableRaw, '16000000000000');

  // 3) 冲突证据（篡改结算哈希生成不同 evidenceHash）必须拒绝
  const conflictingSnap = await buildVerifiedRoundFinalitySnapshot({
    network: 'testnet',
    roundController: RC_ADDR,
    roundId: 1,
    chainReader: makeValidChainReader({
      events: {
        settlementEvent: {
          txHash: '0x' + 'ee'.repeat(32),
          roundId: 1,
          status: RC_STATUS_SUCCEEDED,
          qualifiedCandles: 9,
          candleHash: CANDLE_HASH,
          totalStakeRaw: '300000000000000',
          rewardBudgetRaw: '600000000000000',
        },
      },
    }),
  });
  await assert.rejects(
    () => settleVerifiedStakeReferralsBatch({
      db,
      budgetLedger,
      expectedNetwork: 'testnet',
      expectedRoundController: RC_ADDR,
      snapshot: conflictingSnap,
      resolveReferrerWallet: (w) => referrerMap.get(w) || null,
    }),
    /already locked with evidence/,
  );

  // 4) 并发执行空投抽奖：同一轮仅发放一次、零双发
  const [draw1, draw2] = await Promise.all([
    drawVerifiedRoundAirdrop({ db, budgetLedger, expectedNetwork: 'testnet', expectedRoundController: RC_ADDR, snapshot: snap, nowSec: 1700130300 }),
    drawVerifiedRoundAirdrop({ db, budgetLedger, expectedNetwork: 'testnet', expectedRoundController: RC_ADDR, snapshot: snap, nowSec: 1700130300 }),
  ]);
  assert.equal(draw1.winnerWallet, draw2.winnerWallet);
  assert.equal(draw1.seedHash, snap.airdropSeedHash);
  assert.equal(Number(draw1.duplicate) + Number(draw2.duplicate), 1);
  const bucketAfterDraw = await budgetLedger.getBucket('round_airdrop');
  assert.equal(bucketAfterDraw.spentRaw, '100000000000000'); // 严格只扣一次 100,000 A9

  // 5) 超预算整批原子失败测试（新开干净库，把 stake_referral 预算调低至只够第 1 笔但不够整批 2 笔）
  const dbLow = createSqliteD1(MIGRATIONS_WITH_0016);
  const lowLedger = new D1PromoBudgetLedger({ db: dbLow });
  const lowPromo = new D1PromoStore({ db: dbLow, hotWalletAddress: HOT_WALLET });
  // 整批需要 48,000 A9，故意设为仅剩 20,000 A9（足够第 1 笔 16,000 A9，但不够整批）
  await dbLow
    .prepare("UPDATE promo_budget_ledger SET cap_raw = '20000000000000', spent_raw = '0' WHERE bucket_key = 'stake_referral'")
    .run();

  await assert.rejects(
    () => settleVerifiedStakeReferralsBatch({
      db: dbLow,
      budgetLedger: lowLedger,
      expectedNetwork: 'testnet',
      expectedRoundController: RC_ADDR,
      snapshot: snap,
      resolveReferrerWallet: (w) => referrerMap.get(w) || null,
      nowSec: 1700130400,
    }),
    (err) => err?.code === 'PROMO_BUDGET_EXHAUSTED',
  );
  // 断言零部分记账：stake_referral_credits 0 行、预算 spent_raw 仍为 0、两位推荐人余额仍为 0
  const creditRows = await dbLow.prepare('SELECT COUNT(*) AS c FROM stake_referral_credits').first();
  assert.equal(Number(creditRows.c), 0);
  assert.equal((await lowLedger.getBucket('stake_referral')).spentRaw, '0');
  assert.equal((await lowPromo.getBalance(REFERRER_1)).claimableRaw, '0');
  assert.equal((await lowPromo.getBalance(REFERRER_2)).claimableRaw, '0');
});

test('B-04 主网 V17_CHAIN_SETTLEMENT_UNAVAILABLE 503 保护门禁保持有效（未删除或绕过）', async () => {
  const db = createSqliteD1(MIGRATIONS_WITH_0016);
  const router = createApiRouter({
    env: { A9_NETWORK: 'mainnet', A9_ADMIN_TOKEN: 'secret-token' },
    stateStore: { getTiming: () => ({}), getProtocolState: () => ({}), listRounds: () => [], getRound: () => null },
    promoEngine: new D1PromoStore({ db, hotWalletAddress: HOT_WALLET }),
    budgetLedger: new D1PromoBudgetLedger({ db }),
    v17RewardEngine: new D1V17RewardEngine({ db }),
  });

  const r1 = await router({
    method: 'POST',
    pathname: '/api/admin/v17/stake-referral/settle',
    headers: { 'x-a9-admin-token': 'secret-token' },
    body: { roundId: 1, referrerWallet: REFERRER_1, refereeWallet: USER_A, refereeRewardRaw: '100000000000000' },
  });
  assert.equal(r1.status, 503);
  assert.equal(r1.body.error.code, 'V17_CHAIN_SETTLEMENT_UNAVAILABLE');

  const r2 = await router({
    method: 'POST',
    pathname: '/api/admin/v17/airdrop/draw',
    headers: { 'x-a9-admin-token': 'secret-token' },
    body: { roundId: 1, participants: [USER_A], seedHash: 'fake' },
  });
  assert.equal(r2.status, 503);
  assert.equal(r2.body.error.code, 'V17_CHAIN_SETTLEMENT_UNAVAILABLE');
});

test('B-05 复现修复：终局奖励入口必须拒绝伪造/篡改快照、缺失预算与跨库预算', async () => {
  const db = createSqliteD1(MIGRATIONS_WITH_0016);
  const otherDb = createSqliteD1(MIGRATIONS_WITH_0016);
  const budgetLedger = new D1PromoBudgetLedger({ db });
  const crossDbLedger = new D1PromoBudgetLedger({ db: otherDb });
  const snap = await buildVerifiedRoundFinalitySnapshot({
    network: 'testnet',
    roundController: RC_ADDR,
    roundId: 1,
    chainReader: makeValidChainReader(),
  });
  const referrerMap = new Map([[USER_A, REFERRER_1], [USER_B, REFERRER_2]]);

  // 1) 篡改参与者奖金或伪造 evidenceHash 必须被入口直接拒绝
  const tamperedSnap = structuredClone(snap);
  tamperedSnap.participants[0].computedRewardRaw = '999999999999999999';
  await assert.rejects(
    () => settleVerifiedStakeReferralsBatch({
      db,
      budgetLedger,
      expectedNetwork: 'testnet',
      expectedRoundController: RC_ADDR,
      snapshot: tamperedSnap,
      resolveReferrerWallet: (w) => referrerMap.get(w) || null,
    }),
    (err) => err?.code === 'UNTRUSTED_SNAPSHOT_ORIGIN' || err?.code === 'SNAPSHOT_TAMPERED',
  );
  await assert.rejects(
    () => drawVerifiedRoundAirdrop({ db, budgetLedger, expectedNetwork: 'testnet', expectedRoundController: RC_ADDR, snapshot: tamperedSnap }),
    (err) => err?.code === 'UNTRUSTED_SNAPSHOT_ORIGIN' || err?.code === 'SNAPSHOT_TAMPERED',
  );

  // 2) 缺失 budgetLedger 必须拒绝（禁止静默跳过预算扣减）
  await assert.rejects(
    () => settleVerifiedStakeReferralsBatch({
      db,
      budgetLedger: null,
      expectedNetwork: 'testnet',
      expectedRoundController: RC_ADDR,
      snapshot: snap,
      resolveReferrerWallet: (w) => referrerMap.get(w) || null,
    }),
    (err) => err?.code === 'BUDGET_LEDGER_REQUIRED',
  );
  await assert.rejects(
    () => drawVerifiedRoundAirdrop({ db, budgetLedger: null, expectedNetwork: 'testnet', expectedRoundController: RC_ADDR, snapshot: snap }),
    (err) => err?.code === 'BUDGET_LEDGER_REQUIRED',
  );

  // 3) 跨库 budgetLedger（budgetLedger.db !== db）必须拒绝
  await assert.rejects(
    () => settleVerifiedStakeReferralsBatch({
      db,
      budgetLedger: crossDbLedger,
      expectedNetwork: 'testnet',
      expectedRoundController: RC_ADDR,
      snapshot: snap,
      resolveReferrerWallet: (w) => referrerMap.get(w) || null,
    }),
    (err) => err?.code === 'CROSS_DB_BUDGET_FORBIDDEN',
  );
  await assert.rejects(
    () => drawVerifiedRoundAirdrop({ db, budgetLedger: crossDbLedger, expectedNetwork: 'testnet', expectedRoundController: RC_ADDR, snapshot: snap }),
    (err) => err?.code === 'CROSS_DB_BUDGET_FORBIDDEN',
  );

  // 4) 预期网络/主控不匹配必须拒绝（防跨网/跨合约快照注入）
  await assert.rejects(
    () => settleVerifiedStakeReferralsBatch({
      db,
      budgetLedger,
      expectedNetwork: 'mainnet',
      expectedRoundController: RC_ADDR,
      snapshot: snap,
      resolveReferrerWallet: (w) => referrerMap.get(w) || null,
    }),
    (err) => err?.code === 'CHAIN_ORIGIN_MISMATCH',
  );
});

test('B-06 复现修复：正确支持提前解押后重新锁仓、对齐真实 get_ticket_data() 与真链事件分页适配器', async () => {
  // USER_EXITED 先提前解押，但在锁仓期内重新锁仓 50,000 A9（StakeTicket.tolk 合法复位 exited=false）
  const reStakeReader = makeValidChainReader({
    round: {
      totalStakeRaw: '350000000000000',
      rewardBudgetRaw: '700000000000000',
    },
    events: {
      complete: true,
      settlementEvent: {
        txHash: SETTLE_TX_HASH,
        roundId: 1,
        status: RC_STATUS_SUCCEEDED,
        qualifiedCandles: 9,
        candleHash: CANDLE_HASH,
        totalStakeRaw: '350000000000000',
        rewardBudgetRaw: '700000000000000',
      },
      depositEvents: [
        { roundId: 1, owner: USER_A, amountRaw: '100000000000000' },
        { roundId: 1, owner: USER_B, amountRaw: '200000000000000' },
        { roundId: 1, owner: USER_EXITED, amountRaw: '50000000000000' },
      ],
      earlyExitEvents: [
        { roundId: 1, owner: USER_EXITED, refundRaw: '42500000000000', burnedRaw: '7500000000000' },
      ],
    },
    tickets: {
      [USER_A]: { roundId: 1, owner: USER_A, amountRaw: '100000000000000', exited: false },
      [USER_B]: { roundId: 1, owner: USER_B, amountRaw: '200000000000000', exited: false },
      [USER_EXITED]: { roundId: 1, owner: USER_EXITED, amountRaw: '50000000000000', exited: false },
    },
  });

  const snap = await buildVerifiedRoundFinalitySnapshot({
    network: 'testnet',
    roundController: RC_ADDR,
    roundId: 1,
    chainReader: reStakeReader,
  });
  assert.equal(snap.participantCount, 3);
  assert.equal(snap.participants.find((p) => p.walletKey === USER_EXITED)?.stakeRaw, '50000000000000');

  // 断言真实链读取与事件分页适配器已导出并可解码真实 BoC 外部日志
  const mod = await import('../src/v17-finality-verifier.mjs');
  assert.equal(typeof mod.createTonCenterV17ChainReader, 'function');
  assert.equal(typeof mod.decodeRoundControllerEventBoc, 'function');
});

test('B-07 真实链适配器契约：BoC 事件逐 bit 解码、多页分页扫描与分页截断 fail-closed', async () => {
  const { cellFromBits, serializeBoc } = await import('../src/ton-cell.mjs');
  const {
    createTonCenterV17ChainReader,
    decodeRoundControllerEventBoc,
    EV_DEPOSIT_ACCEPTED_OP,
    EV_ROUND_SETTLED_OP,
  } = await import('../src/v17-finality-verifier.mjs');

  // 辅助：按 types.tolk 位布局构造真实外部日志 BoC
  function addrBits(rawAddr) {
    const [wcStr, hex] = rawAddr.split(':');
    const wc = Number(wcStr) & 0xff;
    return [
      [2n, 2],
      [0n, 1],
      [BigInt(wc), 8],
      [BigInt(`0x${hex}`), 256],
    ];
  }
  async function packBits(fields) {
    let bits = '';
    for (const [val, len] of fields) {
      bits += BigInt(val).toString(2).padStart(len, '0');
    }
    const boc = await serializeBoc(cellFromBits(bits));
    return typeof boc === 'string' ? boc : Buffer.from(boc).toString('base64');
  }

  const depositBocA = await packBits([
    [EV_DEPOSIT_ACCEPTED_OP, 32],
    [1, 32],
    ...addrBits(USER_A),
    [100000000000000n, 128],
    [1, 1],
  ]);
  const settledBoc = await packBits([
    [EV_ROUND_SETTLED_OP, 32],
    [1, 32],
    [RC_STATUS_SUCCEEDED, 8],
    [9, 8],
    [BigInt(CANDLE_HASH), 256],
    [100000000000000n, 128],
    [200000000000000n, 128],
    [0n, 128],
    [0n, 128],
    [0n, 128],
  ]);

  const decDep = decodeRoundControllerEventBoc(depositBocA);
  assert.equal(decDep.type, 'EvDepositAccepted');
  assert.equal(decDep.owner, USER_A);
  assert.equal(decDep.amountRaw, '100000000000000');

  const decSettle = decodeRoundControllerEventBoc(settledBoc);
  assert.equal(decSettle.type, 'EvRoundSettled');
  assert.equal(decSettle.candleHash, CANDLE_HASH);

  // 多页分页模拟：第 1 页返回结算交易，第 2 页返回入金交易且数量 < pageLimit（到达历史起点）
  let v3Calls = 0;
  const mockTonCenter = {
    fetchRound: async () => ({
      status: RC_STATUS_SUCCEEDED,
      stakeOpenAt: 1700000000,
      stakeCloseAt: 1700086400,
      settledAt: 1700130000,
      totalStakeRaw: '100000000000000',
      rewardBudgetRaw: '200000000000000',
      qualifiedCandles: 9,
      candleHash: CANDLE_HASH,
    }),
    fetchUserTicket: async (_rc, owner) => ({
      ticketAddress: '0:' + '99'.repeat(32),
      owner,
      roundId: 1,
      amountRaw: '100000000000000',
      exited: false,
    }),
    _requestV3: async (path) => {
      v3Calls += 1;
      if (!path.includes('end_lt=')) {
        return {
          transactions: [
            {
              hash: SETTLE_TX_HASH,
              lt: '2000',
              now: 1700130000,
              description: { aborted: false },
              out_msgs: [{ destination: null, message_content: { body: settledBoc } }],
            },
          ],
        };
      }
      return {
        transactions: [
          {
            hash: '0x' + '11'.repeat(32),
            lt: '1500',
            now: 1700000100,
            description: { aborted: false },
            out_msgs: [{ destination: null, message_content: { body: depositBocA } }],
          },
          {
            hash: '0x' + '00'.repeat(32),
            lt: '1000',
            now: 1699999000, // < stakeOpenAt，证明已完整扫描覆盖
            description: { aborted: false },
            out_msgs: [],
          },
        ],
      };
    },
  };

  const reader = createTonCenterV17ChainReader({ tonCenter: mockTonCenter, pageLimit: 1, maxPages: 5 });
  const snap = await buildVerifiedRoundFinalitySnapshot({
    network: 'testnet',
    roundController: RC_ADDR,
    roundId: 1,
    chainReader: reader,
  });
  assert.equal(v3Calls, 2);
  assert.equal(snap.participantCount, 1);
  assert.equal(snap.participants[0].walletKey, USER_A);

  // 分页截断（maxPages=1 无法扫到 stakeOpenAt 之前）必须返回 complete=false 并 fail-closed
  const truncatedReader = createTonCenterV17ChainReader({ tonCenter: mockTonCenter, pageLimit: 1, maxPages: 1 });
  await assert.rejects(
    () => buildVerifiedRoundFinalitySnapshot({
      network: 'testnet',
      roundController: RC_ADDR,
      roundId: 1,
      chainReader: truncatedReader,
    }),
    (err) => err?.code === 'INCOMPLETE_CHAIN_HISTORY',
  );
});

test('B-08 反例复现：外部伪造数据并重算全部哈希的自洽快照必须被拒绝（区分哈希完整性与可信链来源）', async () => {
  const db = createSqliteD1(MIGRATIONS_WITH_0016);
  const budgetLedger = new D1PromoBudgetLedger({ db });
  const referrerMap = new Map([[USER_A, REFERRER_1]]);

  // 外部攻击者完全伪造一套数据，并按照公开算法重新计算 airdropSeedHash 和 evidenceHash，做到 100% 哈希自洽
  async function sha256HexLocal(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return `0x${Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  function canon(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }

  const fakeSeed = await sha256HexLocal(`a9-v17-airdrop-seed:testnet:${RC_ADDR}:99:${SETTLE_TX_HASH}:${CANDLE_HASH}`);
  const fakeCore = {
    version: 'a9-v17-chain-finality-v1',
    network: 'testnet',
    roundController: RC_ADDR,
    roundId: 99,
    statusCode: RC_STATUS_SUCCEEDED,
    settledAt: 1700130000,
    settlementTxHash: SETTLE_TX_HASH,
    candleHash: CANDLE_HASH,
    totalStakeRaw: '100000000000000',
    rewardBudgetRaw: '500000000000000',
    participantCount: 1,
    participants: [
      { walletKey: USER_A, walletAddress: USER_A, stakeRaw: '100000000000000', computedRewardRaw: '500000000000000' },
    ],
    airdropSeedHash: fakeSeed,
  };
  const selfConsistentForgedSnapshot = {
    ...fakeCore,
    evidenceHash: await sha256HexLocal(canon(fakeCore)),
  };

  // 即使哈希全部自洽，非服务端可信链读取生成的外部快照必须被拒绝
  await assert.rejects(
    () => settleVerifiedStakeReferralsBatch({
      db,
      budgetLedger,
      expectedNetwork: 'testnet',
      expectedRoundController: RC_ADDR,
      snapshot: selfConsistentForgedSnapshot,
      resolveReferrerWallet: (w) => referrerMap.get(w) || null,
    }),
    (err) => err?.code === 'UNTRUSTED_SNAPSHOT_ORIGIN',
  );
  await assert.rejects(
    () => drawVerifiedRoundAirdrop({
      db,
      budgetLedger,
      expectedNetwork: 'testnet',
      expectedRoundController: RC_ADDR,
      snapshot: selfConsistentForgedSnapshot,
    }),
    (err) => err?.code === 'UNTRUSTED_SNAPSHOT_ORIGIN',
  );
});
