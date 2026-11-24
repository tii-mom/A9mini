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
    unlock: {
      immediateBps: 2000,
      lockedSlices: 4,
      unlockedSlices: 1,
      burnedSlices: 0,
      lockedTotalRaw: '102720000000000'
    },
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
    openEnded: true,
    roundCount: null,
    poolState: { successCount: 2 },
    candleCount: 24,
    minQualifiedCandles: 16,
    candleSeconds: 3600,
    roundRewardRaw: '700000000000000000',
    minStakeRaw: '1000000000000',
    network: 'demo',
    dataSource: 'demo',
    tonUsdE8: '300000000',
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

/** 演示模式邀友奖励模拟领取（不发真实网络订单，不触发钱包签名）。 */
export function demoFundsClaimPromo(state) {
  const amountA9 = 96500;
  const txHash = demoTxHash('EQP');
  if (state?.ledger) {
    state.ledger.unshift({
      id: `PR-${Date.now().toString().slice(-4)}`,
      type: '演示邀友奖励领取 (0.06 GRAM 模拟)',
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
  if (!amt || amt < 1000 || amt > state.user.a9Available) return null;
  const certId = `A9-STAKE-R0${state.round.currentRound}-${Math.floor(100000 + Math.random() * 899999)}`;
  const mult = state.round.myEarlyTier || 2;
  const cert = {
    id: certId,
    round: state.round.currentRound,
    stakeTon: amt,
    multiplier: mult,
    weight: amt * mult,
    estRewardA9: Math.round(amt * mult * 7.5),
    status: 'observation',
    autoRenew: state.user.autoRenew,
    txHash: demoTxHash(),
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' (UTC+8)'
  };
  state.user.a9Available = Number((state.user.a9Available - amt).toFixed(2));
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
  const receivedA9 = Math.round(amt * state.market.rateA9PerTon);
  state.user.tonBalance = Number((state.user.tonBalance - amt).toFixed(2));
  state.user.a9Available += receivedA9;
  state.market.usedQuotaTon += amt;
  const orderId = `IM-${Date.now().toString().slice(-4)}`;
  state.market.records.unshift({
    id: orderId,
    ton: amt,
    a9: receivedA9,
    status: '演示成交',
    hash: demoTxHash('EQD'),
    time: '刚刚'
  });
  return { receivedA9, orderId };
}

export const DEMO_SOCIAL_FEEDS = [
  'UQ...8892 刚参与 500 GRAM · 2.0x',
  'EQ...3312 刚领取 128,400 A9',
  'UQ...77ea 加入 暖棉纸冒险团',
  'EQ...9F21 兑换 200,200 A9'
];

/** 仅在 config.isDemo === true 时用于初始化可体验的演示持仓、凭证与收益记录（绝不落盘、绝不进入真实模式） */
function createInitialCandles() {
  // 演示模式初始雷达（真实模式由 data.js 的服务端快照覆盖）
  const pattern = [
    { h: 24, bull: true,  p: 0.1868 },
    { h: 28, bull: true,  p: 0.1892 },
    { h: 18, bull: false, p: 0.1821 },
    { h: 26, bull: true,  p: 0.1880 },
    { h: 22, bull: true,  p: 0.1874 },
    { h: 30, bull: true,  p: 0.1912 },
    { h: 20, bull: false, p: 0.1835 },
    { h: 25, bull: true,  p: 0.1888 },
    { h: 21, bull: true,  p: 0.1869 },
    { h: 29, bull: true,  p: 0.1904 },
    { h: 17, bull: false, p: 0.1819 },
    { h: 26, bull: true,  p: 0.1891 },
    { h: 24, bull: true,  p: 0.1886 },
    { h: 27, bull: true,  p: 0.1901 },
    { h: 23, bull: true,  p: 0.1895 },
    { h: 26, bull: true,  p: 0.1910, active: true }
  ];
  const candles = [];
  for (let i = 1; i <= 24; i++) {
    if (i <= 16) {
      candles.push({ index: i, status: i === 16 ? 'active' : 'closed', confirmed: i < 16, ...pattern[i - 1] });
    } else {
      candles.push({ index: i, status: 'pending', confirmed: false, h: 12, bull: true, p: null });
    }
  }
  return candles;
}

export function applyDemoInitialState(state) {
  state.round.currentRound = 3;
  state.round.stage = 'observation';
  state.round.qualifiedCandles = 8;
  state.round.candlesConfirmed = 12;
  state.round.needMore = 8;
  state.round.candles = createInitialCandles();
  state.round.quickStakeTon = 100;
  state.round.tonUsd = 3.00;
  state.round.poolA9 = 700000000;
  state.round.teamPoolA9 = 120000000;
  state.market.rateA9PerTon = 2002;
  state.market.minOrderTon = 5;
  state.market.maxOrderTon = 200;
  state.market.hardCapTon = 1000;
  state.market.unlockedQuotaTon = 750;
  state.market.usedQuotaTon = 150;
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
      stakeTon: 5000,
      multiplier: 2.0,
      weight: 10000,
      estRewardA9: 75000,
      status: 'observation',
      autoRenew: true,
      txHash: 'EQB9A4C72F...81E4',
      timestamp: '2026-11-20 10:15:00 (UTC+8)'
    },
    {
      id: 'A9-STAKE-R02-641205',
      round: 2,
      stakeTon: 3000,
      multiplier: 1.4,
      weight: 4200,
      estRewardA9: 45000,
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
      type: '直邀奖励 (12%)',
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
    name: '暖棉纸冒险团',
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
    tgGroupHandle: '@A9_Paper_Squad',
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

  const nowSec = Math.floor(Date.now() / 1000);
  state.round.stakeOpenAt = nowSec - 7200;
  state.round.stakeCloseAt = nowSec + 36 * 3600 - 7200;
  state.round.earlyBirdSec = 10 * 3600 + 18 * 60 + 42;
  state.round.unlock = {
    immediateBps: 2000,
    lockedSlices: 4,
    unlockedSlices: 1,
    burnedSlices: 0,
    lockedTotalRaw: '102720000000000'
  };
  if (state.prediction) {
    state.prediction.pendingActivationRaw = '12500000000000';
    state.prediction.pendingExpiresAt = Date.now() + 26 * 3600 * 1000;
    state.prediction.passPct = 61;
    state.prediction.burnPct = 39;
    state.prediction.total = 3000;
  }
}

/* ---------------- 演示模式：24H 预言擂台内存状态（DEMO ONLY） ---------------- */

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
  demoProgUsers.clear();
}

/* ---------------- 演示模式：手账集章成长循环内存状态（DEMO ONLY） ---------------- */

const demoProgUsers = new Map();
const DEMO_DAILY_KEYS = ['daily_checkin', 'daily_prediction', 'daily_observe', 'daily_share'];
const DEMO_TASK_EXP = {
  daily_checkin: 30,
  daily_prediction: 50,
  daily_observe: 30,
  daily_share: 40,
  daily_full_bonus: 80,
  ach_first_stamp: 50,
  ach_streak_3: 120,
  ach_pred_pioneer: 100,
  ach_stamp_10: 200
};

function ensureDemoProgUser(userId) {
  const key = String(userId || 'demo_user_01');
  if (!demoProgUsers.has(key)) {
    demoProgUsers.set(key, {
      userId: key,
      exp: 160,
      checkinStreak: 2,
      lastCheckinDay: new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10),
      totalStamps: 5,
      todayClaims: new Set(['daily_observe']),
      achievementsClaimed: new Set(['ach_first_stamp'])
    });
  }
  return demoProgUsers.get(key);
}

export function demoProgressionUser(userId, roundId = 3) {
  const u = ensureDemoProgUser(userId);
  const pred = demoPredictionUser(userId, roundId);
  const hasPred = Boolean(pred?.currentBet);
  const expPerLevel = 200;
  const level = Math.floor(u.exp / expPerLevel) + 1;
  const currentLevelExp = u.exp % expPerLevel;
  const dailyDoneCount = DEMO_DAILY_KEYS.filter(k => u.todayClaims.has(k)).length;
  const allDailyStampsDone = dailyDoneCount === DEMO_DAILY_KEYS.length;
  const unlockable = [];
  if (u.totalStamps >= 1 && !u.achievementsClaimed.has('ach_first_stamp')) unlockable.push('ach_first_stamp');
  if (u.checkinStreak >= 3 && !u.achievementsClaimed.has('ach_streak_3')) unlockable.push('ach_streak_3');
  if ((hasPred || u.todayClaims.has('daily_prediction')) && !u.achievementsClaimed.has('ach_pred_pioneer')) unlockable.push('ach_pred_pioneer');
  if (u.totalStamps >= 10 && !u.achievementsClaimed.has('ach_stamp_10')) unlockable.push('ach_stamp_10');

  return {
    userId: u.userId,
    assetNature: 'NON_FINANCIAL_GAME_PROGRESSION',
    tradable: false,
    convertibleToA9: false,
    todayUtc: new Date().toISOString().slice(0, 10),
    exp: u.exp,
    level,
    expPerLevel,
    currentLevelExp,
    nextLevelExp: expPerLevel,
    progressPct: Math.min(100, Math.round((currentLevelExp / expPerLevel) * 100)),
    checkinStreak: u.checkinStreak,
    lastCheckinDay: u.lastCheckinDay,
    totalStamps: u.totalStamps,
    dailyDoneCount,
    dailyTotalCount: DEMO_DAILY_KEYS.length,
    allDailyStampsDone,
    dailyFullBonusClaimed: u.todayClaims.has('daily_full_bonus'),
    todayClaims: Array.from(u.todayClaims),
    achievementsClaimed: Array.from(u.achievementsClaimed),
    unlockableAchievements: unlockable
  };
}

export function demoProgressionClaim({ userId, taskKey, roundId = 3 }) {
  const u = ensureDemoProgUser(userId);
  const tKey = String(taskKey || '').trim();
  const expDelta = DEMO_TASK_EXP[tKey];
  if (!expDelta) throw new Error(`未知手账印章任务: ${tKey}`);
  const isAch = tKey.startsWith('ach_');
  if (isAch && u.achievementsClaimed.has(tKey)) {
    throw new Error('该成就印章已领取，不可重复领取');
  }
  if (!isAch && u.todayClaims.has(tKey)) {
    throw new Error('今日该印章已盖章，不可重复领取');
  }
  const pred = demoPredictionUser(userId, roundId);
  const hasPred = Boolean(pred?.currentBet);
  if (tKey === 'daily_prediction' && !hasPred) {
    throw new Error('请先参与本轮 0 GRAM 24H 预言擂台后再盖章');
  }
  if (tKey === 'daily_full_bonus') {
    const allDone = DEMO_DAILY_KEYS.every(k => u.todayClaims.has(k));
    if (!allDone) throw new Error('集齐今日全部 4 枚日常印章后方可领取满章加赠');
  }
  if (tKey === 'ach_streak_3' && u.checkinStreak < 3) {
    throw new Error('连续打卡满 3 天后解锁');
  }
  if (tKey === 'ach_pred_pioneer' && !hasPred && !u.todayClaims.has('daily_prediction')) {
    throw new Error('需完成至少 1 次 24H 预言擂台后解锁');
  }

  if (isAch) {
    u.achievementsClaimed.add(tKey);
  } else {
    u.todayClaims.add(tKey);
    if (DEMO_DAILY_KEYS.includes(tKey)) u.totalStamps += 1;
    if (tKey === 'daily_checkin') {
      const todayStr = new Date().toISOString().slice(0, 10);
      if (u.lastCheckinDay !== todayStr) {
        u.checkinStreak += 1;
        u.lastCheckinDay = todayStr;
      }
    }
  }
  u.exp += expDelta;
  return {
    claimedTask: tKey,
    expAwarded: expDelta,
    progression: demoProgressionUser(userId, roundId)
  };
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

export const ROUND_META = {
  R3: { zh: '第 3 轮 · 观察中', en: 'Round #3 · Live', target: '$0.1850', est: '$0.1895', bars: '12/16', pct: 75 },
  R2: { zh: '第 2 轮 · 已清算', en: 'Round #2 · Paid', target: '$0.1420', est: '$0.1618', bars: '19/16', pct: 100 },
  R1: { zh: '第 1 轮 · 创世轮', en: 'Round #1 · Genesis', target: '$0.1100', est: '$0.1325', bars: '21/16', pct: 100 }
};

export const DEMO_RANKS = {
  personal: [
    { rank: '01', name: 'UQ...9F21', ton: '52,000 GRAM', a9: '13,104,000 A9' },
    { rank: '02', name: 'EQ...4A18', ton: '38,000 GRAM', a9: '9,576,000 A9' },
    { rank: '03', name: 'UQ...B702', ton: '25,000 GRAM', a9: '6,300,000 A9' },
    { rank: '04', name: 'EQ...81E3', ton: '18,500 GRAM', a9: '4,662,000 A9' },
    { rank: '08', name: 'UQ...489f (Me)', ton: '5,000 GRAM', a9: '1,260,000 A9', me: true }
  ],
  team: [
    { rank: '01', name: '暖棉纸冒险团', ton: '580,000 GRAM', a9: '120,000,000 A9', me: true },
    { rank: '02', name: '折纸星航战队', ton: '462,000 GRAM', a9: '94,200,000 A9' },
    { rank: '03', name: '金箔典藏战队', ton: '295,000 GRAM', a9: '61,500,000 A9' }
  ],
  invite: [
    { rank: '01', name: 'UQ...9F21', ton: '42 Invites', a9: '320,000 A9' },
    { rank: '02', name: 'EQ...4A18', ton: '36 Invites', a9: '284,000 A9' },
    { rank: '03', name: 'UQ...489f (Me)', ton: '18 Invites', a9: '96,500 A9', me: true }
  ]
};


export const personalRanks = [
    { r: '01', addr: 'UQ...9F21', invites: 42, reward: '400,000 A9' },
    { r: '02', addr: 'EQ...4A18', invites: 36, reward: '400,000 A9' },
    { r: '03', addr: 'UQ...B702', invites: 29, reward: '400,000 A9' },
    { r: '08', addr: 'UQ...489f (我)', invites: 18, reward: '400,000 A9', me: true },
    { r: '50', addr: 'EQ...19d4', invites: 6, reward: '64,000 A9', cutoff: true }
  ];
export const teamRanks = [
    { r: '01', addr: '暖棉纸冒险团', invites: 186, reward: 'Lv.4 · +15%', me: true },
    { r: '02', addr: '折纸星航战队', invites: 142, reward: 'Lv.4 · +15%' },
    { r: '03', addr: '金箔典藏战队', invites: 94, reward: 'Lv.3 · +10%' }
  ];

export function tickDemoPrice(r) {
  const base = r.twap24h || 0.0045;
  const delta = (Math.random() - 0.48) * 0.00002;
  const nextPrice = Math.max(0.004, Number((base + delta).toFixed(6)));
  r.livePrice = nextPrice;
  if (!Array.isArray(r.priceHistory) || r.priceHistory.length === 0) r.priceHistory = [nextPrice];
  r.priceHistory.push(nextPrice);
  if (r.priceHistory.length > 10) r.priceHistory.shift();
  return nextPrice;
}

/* ---------------- 演示模式：宝箱商城与免费裂变宝箱（DEMO ONLY） ---------------- */

export const DEMO_CHEST_SKUS = [
  { skuId: 'chest_bronze',   tier: 'bronze',   zh: '青铜宝箱', en: 'Bronze Chest',   priceGram: '0.99',  baseA9: 1981.98,   maxBoostPct: 6,  maxBoostA9: 118.92,   requiredAssists: 2 },
  { skuId: 'chest_silver',   tier: 'silver',   zh: '白银宝箱', en: 'Silver Chest',   priceGram: '4.99',  baseA9: 9989.98,   maxBoostPct: 8,  maxBoostA9: 799.20,   requiredAssists: 3 },
  { skuId: 'chest_gold',     tier: 'gold',     zh: '黄金宝箱', en: 'Gold Chest',     priceGram: '9.99',  baseA9: 19999.98,  maxBoostPct: 10, maxBoostA9: 2000.00,  requiredAssists: 4 },
  { skuId: 'chest_platinum', tier: 'platinum', zh: '白金宝箱', en: 'Platinum Chest', priceGram: '19.99', baseA9: 40019.98,  maxBoostPct: 11, maxBoostA9: 4402.20,  requiredAssists: 5 },
  { skuId: 'chest_diamond',  tier: 'diamond',  zh: '钻石宝箱', en: 'Diamond Chest',  priceGram: '99.99', baseA9: 200179.98, maxBoostPct: 12, maxBoostA9: 24021.60, requiredAssists: 6 }
];

const demoChestStore = {
  initialized: false,
  freeChests: [],
  shopChests: []
};

function ensureDemoChests() {
  if (demoChestStore.initialized) return demoChestStore;
  const nowSec = Math.floor(Date.now() / 1000);
  demoChestStore.freeChests = [
    { chestId: 'ch_demo_b1', source: 'FREE_TIER', tier: 'bronze',   slotIndex: 1, labelZh: '青铜宝箱 #1', labelEn: 'Bronze Chest #1', baseA9Raw: '300000000000',     boostA9Raw: '0', maxBoostA9Raw: '0', requiredAssists: 2,    currentAssists: 1, minVolumeNano: '0',                 minTgMembers: 0,    status: 'ACTIVE', createdAt: nowSec - 600 },
    { chestId: 'ch_demo_b2', source: 'FREE_TIER', tier: 'bronze',   slotIndex: 2, labelZh: '青铜宝箱 #2', labelEn: 'Bronze Chest #2', baseA9Raw: '300000000000',     boostA9Raw: '0', maxBoostA9Raw: '0', requiredAssists: 2,    currentAssists: 0, minVolumeNano: '0',                 minTgMembers: 0,    status: 'LOCKED', createdAt: nowSec - 599 },
    { chestId: 'ch_demo_b3', source: 'FREE_TIER', tier: 'bronze',   slotIndex: 3, labelZh: '青铜宝箱 #3', labelEn: 'Bronze Chest #3', baseA9Raw: '400000000000',     boostA9Raw: '0', maxBoostA9Raw: '0', requiredAssists: 2,    currentAssists: 0, minVolumeNano: '0',                 minTgMembers: 0,    status: 'LOCKED', createdAt: nowSec - 598 },
    { chestId: 'ch_demo_s1', source: 'FREE_TIER', tier: 'silver',   slotIndex: 1, labelZh: '白银宝箱',    labelEn: 'Silver Chest',    baseA9Raw: '10000000000000',   boostA9Raw: '0', maxBoostA9Raw: '0', requiredAssists: 15,   currentAssists: 0, minVolumeNano: '50000000000',       minTgMembers: 0,    status: 'LOCKED', createdAt: nowSec - 597 },
    { chestId: 'ch_demo_g1', source: 'FREE_TIER', tier: 'gold',     slotIndex: 1, labelZh: '黄金宝箱',    labelEn: 'Gold Chest',      baseA9Raw: '100000000000000',  boostA9Raw: '0', maxBoostA9Raw: '0', requiredAssists: 160,  currentAssists: 0, minVolumeNano: '1000000000000',     minTgMembers: 100,  status: 'LOCKED', createdAt: nowSec - 596 },
    { chestId: 'ch_demo_p1', source: 'FREE_TIER', tier: 'platinum', slotIndex: 1, labelZh: '白金宝箱',    labelEn: 'Platinum Chest',  baseA9Raw: '200000000000000',  boostA9Raw: '0', maxBoostA9Raw: '0', requiredAssists: 400,  currentAssists: 0, minVolumeNano: '2400000000000',     minTgMembers: 300,  status: 'LOCKED', createdAt: nowSec - 595 },
    { chestId: 'ch_demo_d1', source: 'FREE_TIER', tier: 'diamond',  slotIndex: 1, labelZh: '钻石宝箱',    labelEn: 'Diamond Chest',   baseA9Raw: '1000000000000000', boostA9Raw: '0', maxBoostA9Raw: '0', requiredAssists: 2000, currentAssists: 0, minVolumeNano: '12000000000000',    minTgMembers: 1000, status: 'LOCKED', createdAt: nowSec - 594 }
  ];
  demoChestStore.shopChests = [
    {
      chestId: 'ch_demo_shop1',
      source: 'SHOP_BOOST',
      tier: 'gold',
      slotIndex: 1,
      labelZh: '黄金宝箱',
      labelEn: 'Gold Chest',
      orderId: 'IM-DEMO-1',
      baseA9Raw: '19999980000000',
      boostA9Raw: '650000000000',
      maxBoostA9Raw: '1999998000000',
      requiredAssists: 4,
      currentAssists: 1,
      status: 'ACTIVE',
      expiresAt: nowSec + 18 * 3600,
      createdAt: nowSec - 6 * 3600
    }
  ];
  demoChestStore.initialized = true;
  return demoChestStore;
}

export function demoChestsMe() {
  const s = ensureDemoChests();
  return {
    catalog: DEMO_CHEST_SKUS,
    freeChests: s.freeChests.map((c) => ({ ...c })),
    shopChests: s.shopChests.map((c) => ({ ...c }))
  };
}

export function demoClaimStarterChests() {
  const s = ensureDemoChests();
  return { created: false, chests: s.freeChests.map((c) => ({ ...c })) };
}

export function demoBuyChest(state, skuId, openMode = 'BOOST') {
  const pack = DEMO_CHEST_SKUS.find((p) => p.skuId === skuId);
  if (!pack) return { error: '未知宝箱档位' };
  const price = Number(pack.priceGram);
  if (state.user.tonBalance < price) return { error: 'GRAM 余额不足' };
  state.user.tonBalance = Number((state.user.tonBalance - price).toFixed(2));
  state.user.a9Available = Number((state.user.a9Available + pack.baseA9).toFixed(2));
  const orderId = `CM-${Date.now().toString().slice(-4)}`;
  const mode = openMode === 'INSTANT' ? 'INSTANT' : 'BOOST';
  state.market.records.unshift({
    id: orderId,
    ton: price,
    a9: pack.baseA9,
    status: mode === 'BOOST' ? '演示已发本金·膨胀中' : '演示直接开箱',
    hash: demoTxHash('EQC'),
    time: '刚刚'
  });
  let boostChest = null;
  if (mode === 'BOOST') {
    const s = ensureDemoChests();
    const nowSec = Math.floor(Date.now() / 1000);
    const baseRaw = BigInt(Math.round(pack.baseA9 * 1e9));
    const maxRaw = BigInt(Math.round(pack.maxBoostA9 * 1e9));
    const initRaw = baseRaw / 100n;
    boostChest = {
      chestId: `ch_demo_${Date.now().toString(36)}`,
      source: 'SHOP_BOOST',
      tier: pack.tier,
      slotIndex: 1,
      labelZh: pack.zh,
      labelEn: pack.en,
      orderId,
      baseA9Raw: baseRaw.toString(),
      boostA9Raw: initRaw.toString(),
      maxBoostA9Raw: maxRaw.toString(),
      requiredAssists: pack.requiredAssists,
      currentAssists: 0,
      status: 'ACTIVE',
      expiresAt: nowSec + 24 * 3600,
      createdAt: nowSec
    };
    s.shopChests.unshift(boostChest);
  }
  return { orderId, pack, openMode: mode, receivedA9: pack.baseA9, boostChest };
}

export function demoGetChest(chestId) {
  const s = ensureDemoChests();
  const found = [...s.freeChests, ...s.shopChests].find((c) => c.chestId === chestId);
  if (found) return { ...found };
  return {
    chestId: String(chestId || 'ch_demo_b1'),
    source: 'FREE_TIER',
    tier: 'bronze',
    slotIndex: 1,
    labelZh: '好友的青铜宝箱 #1',
    labelEn: "Friend's Bronze Chest #1",
    baseA9Raw: '300000000000',
    boostA9Raw: '0',
    maxBoostA9Raw: '0',
    requiredAssists: 2,
    currentAssists: 1,
    status: 'ACTIVE'
  };
}

export function demoAssistChest(chestId) {
  const s = ensureDemoChests();
  const found = [...s.freeChests, ...s.shopChests].find((c) => c.chestId === chestId);
  if (!found) {
    return {
      chest: { ...demoGetChest(chestId), currentAssists: 2, status: 'READY' },
      boostDeltaRaw: '0',
      helperGrantedStarter: true,
      helperBronzeChest: s.freeChests[0]
    };
  }
  if (found.status === 'OPENED') throw new Error('该宝箱已开启');
  if (found.currentAssists >= found.requiredAssists) throw new Error('该宝箱助力人数已满');
  found.currentAssists += 1;
  let delta = 0n;
  if (found.source === 'SHOP_BOOST') {
    const base = BigInt(found.baseA9Raw);
    const maxB = BigInt(found.maxBoostA9Raw);
    const initB = base / 100n;
    const prev = BigInt(found.boostA9Raw);
    const next = found.currentAssists >= found.requiredAssists
      ? maxB
      : initB + ((maxB - initB) * BigInt(found.currentAssists)) / BigInt(found.requiredAssists);
    delta = next > prev ? next - prev : 0n;
    found.boostA9Raw = next.toString();
  }
  if (found.currentAssists >= found.requiredAssists) found.status = 'READY';
  return {
    chest: { ...found },
    boostDeltaRaw: delta.toString(),
    helperGrantedStarter: true,
    helperBronzeChest: s.freeChests[0]
  };
}

export function demoOpenChest(state, chestId) {
  const s = ensureDemoChests();
  const idx = s.freeChests.findIndex((c) => c.chestId === chestId);
  if (idx >= 0) {
    const c = s.freeChests[idx];
    if (c.status === 'LOCKED') throw new Error('请先开启上一个宝箱后再激活当前宝箱');
    if (c.status === 'OPENED') throw new Error('该宝箱已开启');
    if (c.currentAssists < c.requiredAssists) throw new Error(`还需 ${c.requiredAssists - c.currentAssists} 位好友助力`);
    c.status = 'OPENED';
    const rewardA9 = Number(BigInt(c.baseA9Raw) / 1_000_000_000n);
    if (c.tier === 'bronze') {
      const cur = BigInt(state.prediction?.pendingActivationRaw || '0');
      state.prediction.pendingActivationRaw = (cur + BigInt(c.baseA9Raw)).toString();
    } else {
      state.user.a9Available += rewardA9;
    }
    let nextUnlocked = null;
    if (idx + 1 < s.freeChests.length && s.freeChests[idx + 1].status === 'LOCKED') {
      s.freeChests[idx + 1].status = 'ACTIVE';
      nextUnlocked = { ...s.freeChests[idx + 1] };
    }
    return { chest: { ...c }, rewardA9Raw: c.baseA9Raw, destination: c.tier === 'bronze' ? 'PENDING_VAULT' : 'PROMO_BALANCE', nextUnlocked };
  }
  const sc = s.shopChests.find((c) => c.chestId === chestId);
  if (!sc) throw new Error('未找到宝箱');
  if (sc.status === 'OPENED') throw new Error('该宝箱已开箱');
  sc.status = 'OPENED';
  const boostA9 = Number(BigInt(sc.boostA9Raw)) / 1e9;
  state.user.a9Available = Number((state.user.a9Available + boostA9).toFixed(2));
  return { chest: { ...sc }, rewardA9Raw: sc.boostA9Raw, destination: 'PROMO_BALANCE', nextUnlocked: null };
}
