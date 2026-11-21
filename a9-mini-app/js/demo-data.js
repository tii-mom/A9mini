/**
 * 演示模式专用数据（DEMO ONLY）
 *
 * 本文件的所有内容只在 config.isDemo === true 时使用：
 *  - fixture：符合 BAM shared/types.ts 契约的「明确标识测试数据」，用于接口不可用时验收页面状态；
 *  - 模拟钱包/余额/随机行情/随机哈希/本地凭证/模拟领取：全部集中在这里，真实模式不得调用。
 *
 * 严禁把本文件的任何数值写入真实模式的 localStorage / 路由 / 缓存。
 */

/** 取自 BAM demo 真实接口样本（R3），改造成观察期场景：12 根已收盘 / 8 根达标，第 13 根进行中。 */
const FIXTURE_CANDLE_ROWS = [
  ['480704', true], ['475321', true], ['469892', true], ['438156', false],
  ['465345', true], ['444234', false], ['476806', true], ['480008', true],
  ['477641', true], ['460474', false], ['465902', true], ['454396', false]
];

export function demoFixture() {
  const now = Date.now();
  const candleMs = 3600 * 1000;
  const observationStart = now - 12 * candleMs;
  const detail = {
    roundId: 3,
    state: 'OBSERVING',
    priceMultiplier: 2,
    targetPriceUsdE8: '464000',
    targetLocked: true,
    rewardBudgetRaw: '700000000000000000',
    stakeOpenAt: observationStart - 3 * 24 * candleMs,
    stakeCloseAt: observationStart,
    observationStart,
    observationEnd: now + 12 * candleMs,
    candlesSeen: 12,
    qualifiedCandles: 8,
    totalAcceptedStakeRaw: '386200000000000000',
    totalWeightRaw: '386200000000000000',
    candleHash: null,
    stakerCount: 12,
    entryCount: 12,
    result: null,
    burnedRaw: null,
    teamReleasedRaw: null,
    corridorMinUsdE8: null,
    corridorMaxUsdE8: null,
    candles: FIXTURE_CANDLE_ROWS.map(([twap, qualified], i) => ({
      roundId: 3,
      candleIndex: i,
      periodStart: observationStart + i * candleMs,
      periodEnd: observationStart + (i + 1) * candleMs,
      twapPriceUsdE8: twap,
      qualified,
      coverageBps: 9900,
      validSourceCount: 5,
      dataDigest: `fixture-${i}`
    })),
    live: {
      candleIndex: 12,
      twapPriceUsdE8: '479544',
      progressBps: 4200,
      qualifiedTentative: true
    },
    priceUsdE8: '479544',
    priceValid: true,
    secondsRemaining: 12 * 3600,
    nextState: null,
    updatedAt: now
  };

  const protocolConfig = {
    token: { name: 'A9', symbol: 'A9', decimals: 9 },
    p0UsdE8: '116000',
    priceMultiplier: 2,
    roundCount: 10,
    candleCount: 24,
    minQualifiedCandles: 16,
    candleSeconds: 3600,
    roundRewardRaw: '700000000000000000',
    minStakeRaw: '1000000000000',
    network: 'demo',
    dataSource: 'demo',
    tonUsdE8: '300000000',
    finalTargetUsdE8: '50000000',
    maxRewardCapMultiplier: 15,
    earlyBirdWeightsBps: { first: 20000, second: 14000, last: 10000 },
    corridorMinBps: 15000,
    corridorMaxBps: 25000,
    contracts: { stakingEnabled: false }
  };

  return {
    source: 'fixture',
    label: '测试数据',
    fetchedAt: now,
    config: protocolConfig,
    rounds: [detail],
    detail,
    stale: false
  };
}

/* ---------------- 以下为模拟资金行为，仅 DEMO 模式可调用 ---------------- */

export function demoTxHash(prefix = 'EQB') {
  return `${prefix}${Math.random().toString(16).slice(2, 10).toUpperCase()}...${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
}

/** 仅在演示模式使用的模拟钱包交易回执（绝不触发真实钱包 SDK）。 */
export function demoWalletSendResult(action = 'demo_tx') {
  return {
    boc: `te6cckEBAQEA_DEMO_${Date.now().toString(16)}`,
    txHash: demoTxHash('EQD'),
    action,
    simulated: true
  };
}

/** 演示模式推广奖励模拟领取（不发真实网络订单，不触发钱包签名）。 */
export function demoFundsClaimPromo(state) {
  const amountA9 = 96500;
  const txHash = demoTxHash('EQP');
  if (state?.ledger) {
    state.ledger.unshift({
      id: `PR-${Date.now().toString().slice(-4)}`,
      type: '演示推广奖励领取 (0.06 TON 模拟)',
      source: '演示推广热钱包',
      amount: `+${amountA9.toLocaleString('en-US')} A9`,
      status: '演示完成',
      time: '刚刚',
      cat: 'promo'
    });
  }
  return { amountA9, txHash, simulated: true };
}

export function demoFundsStake(state, amount) {
  const amt = Number(amount);
  if (!amt || amt < 10 || amt > state.user.tonBalance) return null;
  const certId = `A9-STAKE-R0${state.round.currentRound}-${Math.floor(100000 + Math.random() * 899999)}`;
  const mult = state.round.myEarlyTier || 2;
  const cert = {
    id: certId,
    round: state.round.currentRound,
    stakeTon: amt,
    multiplier: mult,
    weight: amt * mult,
    estRewardA9: Math.round(amt * mult * 126),
    status: 'observation',
    autoRenew: state.user.autoRenew,
    txHash: demoTxHash(),
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' (UTC+8)'
  };
  state.user.tonBalance = Number((state.user.tonBalance - amt).toFixed(2));
  state.user.profileMode = 'active';
  state.round.myStakeTon += amt;
  state.round.myWeight += amt * mult;
  state.round.totalStakedTon += amt;
  state.certificates.unshift(cert);
  return cert;
}

export function demoFundsClaim(state) {
  const claimable = state.user.a9Claimable;
  if (claimable <= 0) return 0;
  state.user.a9Available += claimable;
  state.user.a9Claimable = 0;
  state.ledger.unshift({
    id: `LD-${Date.now().toString().slice(-4)}`,
    type: '演示提取 (TGE 20%)',
    source: `第 ${state.round.currentRound} 轮演示结算`,
    amount: `+${claimable.toLocaleString()} A9`,
    status: '演示上链',
    time: '刚刚'
  });
  return claimable;
}

export function demoFundsBuy(state, tonAmount) {
  const amt = Number(tonAmount);
  const availQuota = state.market.unlockedQuotaTon - state.market.usedQuotaTon;
  if (amt < state.market.minOrderTon || amt > state.market.maxOrderTon) return { error: '单笔金额须在 5 - 200 GRAM 之间' };
  if (amt > availQuota) return { error: `超出当前可用额度 (${availQuota} GRAM)` };
  if (amt > state.user.tonBalance) return { error: 'GRAM 余额不足' };
  const receivedA9 = amt * state.market.rateA9PerTon;
  state.user.tonBalance = Number((state.user.tonBalance - amt).toFixed(2));
  state.user.a9Available += receivedA9;
  state.market.usedQuotaTon += amt;
  state.market.records.unshift({
    id: `IM-${Date.now().toString().slice(-4)}`,
    ton: amt,
    a9: receivedA9,
    status: '演示成交',
    hash: demoTxHash('EQD'),
    time: '刚刚'
  });
  return { receivedA9 };
}

export const DEMO_SOCIAL_FEEDS = [
  'UQ...8892 刚质押 500 GRAM · 2.0x',
  'EQ...3312 刚领取 128,400 A9',
  'UQ...77ea 加入 Genesis Alpha Node',
  'EQ...9F21 购买 200,200 A9'
];

/** 仅在 config.isDemo === true 时用于初始化可体验的演示持仓、凭证与收益记录（绝不落盘、绝不进入真实模式） */
export function applyDemoInitialState(state) {
  state.user.connected = true;
  state.user.tgBound = true;
  state.user.shortAddress = 'UQ...489f';
  state.user.tonBalance = 1250.5;
  state.user.a9Available = 48200;
  state.user.a9Claimable = 25680;
  state.user.a9Locked = 102720;
  state.user.a9TotalEarned = 176600;
  state.user.warmupInvites = 18;

  state.certificates = [
    {
      id: 'A9-STAKE-R03-882419',
      round: 3,
      stakeTon: 500,
      multiplier: 2.0,
      weight: 1000,
      estRewardA9: 126000,
      status: 'observation',
      autoRenew: true,
      txHash: 'EQB9A4C72F...81E4',
      timestamp: '2026-11-20 10:15:00 (UTC+8)'
    },
    {
      id: 'A9-STAKE-R02-641205',
      round: 2,
      stakeTon: 300,
      multiplier: 1.4,
      weight: 420,
      estRewardA9: 128400,
      status: 'settled',
      autoRenew: false,
      txHash: 'EQD3F8B19A...4C02',
      timestamp: '2026-11-16 14:22:18 (UTC+8)'
    }
  ];

  state.ledger = [
    {
      id: 'LD-9021',
      type: '第 2 轮达标首笔释放 (20%)',
      source: '第 2 轮结算',
      amount: '+25,680 A9',
      status: '待领取',
      time: '昨日 20:00',
      cat: 'user'
    },
    {
      id: 'LD-8814',
      type: '直邀推广奖励 (12%)',
      source: '好友 UQ...8892 参与',
      amount: '+18,400 A9',
      status: '已到账',
      time: '11-18 16:40',
      cat: 'promo'
    }
  ];

  state.team = {
    role: 'captain',
    id: 'TM-0001',
    name: 'Genesis Alpha Node',
    level: 4,
    boostPct: 15,
    membersActive: 412,
    membersTotal: 500,
    directInvites: 18,
    teamStakedTon: 580000,
    teamStakedTarget: 700000,
    captainDividendTon: 142.85,
    captainHistoryTon: 618.4,
    captainHistoryA9: 184200,
    tgGroupBound: true,
    tgGroupHandle: '@A9_Genesis_Alpha',
    tgGroupMembers: 468,
    recruitMinTon: 50,
    topMembers: [
      { rank: '#01', addr: 'UQ...9F21', ton: 52000 },
      { rank: '#02', addr: 'EQ...4A18', ton: 38000 },
      { rank: '#03', addr: 'UQ...B702', ton: 25000 }
    ]
  };

  state.risk = {
    status: 'NOMINAL',
    latencyMs: 142,
    oracleDeviationPct: 0.12,
    blockHeight: 48291042,
    activeRpc: 'Toncenter Mainnet L1'
  };
}

/* ---------------- 演示模式：24H 生死预言局内存状态（DEMO ONLY） ---------------- */

const demoPredRounds = new Map();
const demoPredUsers = new Map();

function ensureDemoPredRound(roundId) {
  const key = Number(roundId) || 3;
  if (!demoPredRounds.has(key)) {
    demoPredRounds.set(key, {
      roundId: key,
      passCount: 1842,
      burnCount: 1158,
      settled: false,
      winningSide: null
    });
  }
  return demoPredRounds.get(key);
}

function ensureDemoPredUser(userId) {
  const key = String(userId || 'demo_user_01');
  if (!demoPredUsers.has(key)) {
    demoPredUsers.set(key, {
      userId: key,
      pendingActivationRaw: '12500000000000',
      activatedRaw: '0',
      streak: 3,
      winRate: 78,
      inviteBoostCount: 2,
      pendingExpiresAt: Date.now() + 26 * 3600 * 1000,
      betsByRound: {}
    });
  }
  return demoPredUsers.get(key);
}

export function resetDemoPrediction() {
  demoPredRounds.clear();
  demoPredUsers.clear();
}

export function demoPredictionRound(roundId, stage = 'observation') {
  const r = ensureDemoPredRound(roundId);
  const settled = stage === 'settlement_success' || stage === 'settlement_burn';
  const winningSide = stage === 'settlement_success' ? 'PASS' : stage === 'settlement_burn' ? 'BURN' : r.winningSide;
  const total = r.passCount + r.burnCount;
  const passPct = total > 0 ? Math.round((r.passCount / total) * 100) : 50;
  const burnPct = total > 0 ? 100 - passPct : 50;
  return {
    roundId: r.roundId,
    passCount: r.passCount,
    burnCount: r.burnCount,
    total,
    passPct,
    burnPct,
    settled,
    winningSide
  };
}

export function demoPredictionUser(userId, roundId) {
  const u = ensureDemoPredUser(userId);
  const rKey = Number(roundId) || 3;
  return {
    userId: u.userId,
    pendingActivationRaw: u.pendingActivationRaw,
    activatedRaw: u.activatedRaw,
    streak: u.streak,
    winRate: u.winRate,
    inviteBoostCount: u.inviteBoostCount,
    pendingExpiresAt: u.pendingActivationRaw !== '0' ? u.pendingExpiresAt : null,
    currentBet: u.betsByRound[rKey] || null
  };
}

export function demoPredictionBet({ roundId, userId, side, guessSlots, referrerId }) {
  const r = ensureDemoPredRound(roundId);
  const u = ensureDemoPredUser(userId);
  const rKey = r.roundId;
  if (u.betsByRound[rKey]) {
    throw new Error('本轮已完成预言下注，每轮限参与 1 次');
  }
  const cleanSide = side === 'BURN' ? 'BURN' : 'PASS';
  const cleanSlots = (guessSlots === null || guessSlots === undefined || guessSlots === '')
    ? null
    : Math.max(0, Math.min(24, Math.floor(Number(guessSlots))));
  if (cleanSide === 'PASS') r.passCount += 1;
  else r.burnCount += 1;

  const bet = {
    roundId: rKey,
    userId: u.userId,
    side: cleanSide,
    guessSlots: Number.isFinite(cleanSlots) ? cleanSlots : null,
    referrerId: referrerId || null,
    createdAt: Date.now()
  };
  u.betsByRound[rKey] = bet;
  return {
    bet,
    round: demoPredictionRound(rKey),
    user: demoPredictionUser(u.userId, rKey)
  };
}

export function demoPredictionActivate(userId, walletAddress) {
  const u = ensureDemoPredUser(userId);
  if (!walletAddress) throw new Error('请先连接 TON 钱包');
  const pending = BigInt(u.pendingActivationRaw || '0');
  if (pending <= 0n) throw new Error('当前暂无待激活的预言奖励');
  const nextActivated = BigInt(u.activatedRaw || '0') + pending;
  u.activatedRaw = nextActivated.toString();
  u.pendingActivationRaw = '0';
  return {
    userId: u.userId,
    walletAddress,
    activatedDeltaRaw: pending.toString(),
    pendingActivationRaw: '0',
    activatedRaw: u.activatedRaw
  };
}
