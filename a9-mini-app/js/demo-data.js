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

/** 演示模式推广奖励模拟领取（不发真实网络订单，不触发钱包签名）。 */
export function demoFundsClaimPromo(state) {
  const amountA9 = 96500;
  const txHash = demoTxHash('EQP');
  if (state?.ledger) {
    state.ledger.unshift({
      id: `PR-${Date.now().toString().slice(-4)}`,
      type: '演示推广奖励领取 (0.06 GRAM 模拟)',
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

export const DEMO_STICKER_PACKS = [
  {
    skuId: 'pack_basic',
    zh: '基础贴纸包',
    en: 'Basic Sticker Pack',
    asset: 'crystal-basic',
    priceGram: 1.99,
    a9Amount: 3983.98,
    expBonus: 100,
    critFlair: false,
    items: ['frame_cotton', 'badge_seal_red'],
    descZh: '含 3,983.98 A9 + 素棉立牌底座 + 初心火漆贴纸',
    descEn: '3,983.98 A9 + Cotton Base + Wax Seal Sticker'
  },
  {
    skuId: 'pack_plus',
    zh: '进阶贴纸盒',
    en: 'Plus Sticker Box',
    asset: 'crystal-starlight',
    priceGram: 5.99,
    a9Amount: 11991.98,
    expBonus: 350,
    critFlair: false,
    items: ['frame_origami', 'badge_star_compass'],
    descZh: '含 11,991.98 A9 + 晴空烫金底座 + 星航折纸贴纸',
    descEn: '11,991.98 A9 + Sky Origami Base + Star Sticker'
  },
  {
    skuId: 'pack_deluxe',
    zh: '豪华贴纸礼盒',
    en: 'Deluxe Sticker Box',
    asset: 'crystal-legendary',
    priceGram: 13.99,
    a9Amount: 28007.98,
    expBonus: 1000,
    critFlair: true,
    items: ['frame_royal_foil', 'badge_royal_crown', 'title_foil_collector'],
    descZh: '含 28,007.98 A9 + 皇家金箔底座 + 皇冠金章 + 典藏称号',
    descEn: '28,007.98 A9 + Gold-Foil Base + Crown Crest + Title'
  }
];

export const DEMO_COSMETIC_ITEMS = {
  frame_cotton: { itemId: 'frame_cotton', category: 'frame', rarity: 'basic', sourceSku: 'pack_basic', zh: '素棉立牌底座', en: 'Cotton Standee Base' },
  badge_seal_red: { itemId: 'badge_seal_red', category: 'badge', rarity: 'basic', sourceSku: 'pack_basic', zh: '初心火漆贴纸', en: 'Red Wax Seal Sticker' },
  frame_origami: { itemId: 'frame_origami', category: 'frame', rarity: 'plus', sourceSku: 'pack_plus', zh: '晴空烫金底座', en: 'Sky Origami Base' },
  badge_star_compass: { itemId: 'badge_star_compass', category: 'badge', rarity: 'plus', sourceSku: 'pack_plus', zh: '星航折纸贴纸', en: 'Star Origami Sticker' },
  frame_royal_foil: { itemId: 'frame_royal_foil', category: 'frame', rarity: 'deluxe', sourceSku: 'pack_deluxe', zh: '皇家金箔底座', en: 'Royal Gold-Foil Base' },
  badge_royal_crown: { itemId: 'badge_royal_crown', category: 'badge', rarity: 'deluxe', sourceSku: 'pack_deluxe', zh: '传世皇冠金章', en: 'Royal Crown Crest' },
  title_foil_collector: { itemId: 'title_foil_collector', category: 'title', rarity: 'deluxe', sourceSku: 'pack_deluxe', zh: '金箔典藏家称号', en: 'Gold-Foil Collector' }
};

export function demoFundsBuy(state, tonAmount, skuId = null) {
  const pack = skuId ? DEMO_STICKER_PACKS.find(p => p.skuId === skuId) : DEMO_STICKER_PACKS.find(p => Math.abs(p.priceGram - Number(tonAmount)) < 0.001);
  const amt = pack ? pack.priceGram : Number(tonAmount);
  const availQuota = state.market.unlockedQuotaTon - state.market.usedQuotaTon;
  if (!pack && (amt < state.market.minOrderTon || amt > state.market.maxOrderTon)) return { error: '单笔金额须在 5 - 200 GRAM 之间或选择三档贴纸包' };
  if (amt > availQuota) return { error: `超出当前可用额度 (${availQuota} GRAM)` };
  if (amt > state.user.tonBalance) return { error: 'GRAM 余额不足' };
  const receivedA9 = Number((amt * state.market.rateA9PerTon).toFixed(2));
  state.user.tonBalance = Number((state.user.tonBalance - amt).toFixed(2));
  state.user.a9Available = Number((state.user.a9Available + receivedA9).toFixed(2));
  state.market.usedQuotaTon = Number((state.market.usedQuotaTon + amt).toFixed(2));
  const orderId = `IM-${Date.now().toString().slice(-4)}`;
  state.market.records.unshift({
    id: orderId,
    skuId: pack ? pack.skuId : null,
    packNameZh: pack ? pack.zh : null,
    packNameEn: pack ? pack.en : null,
    ton: amt,
    a9: receivedA9,
    status: '演示成交',
    hash: demoTxHash('EQD'),
    time: '刚刚'
  });
  let deliveredPack = null;
  if (pack) {
    deliveredPack = demoInventoryDeliver(state, pack.skuId, orderId);
  }
  return { receivedA9, pack, deliveredPack, orderId };
}

export function demoInventoryDeliver(state, skuId, orderRef = 'sandbox') {
  const pack = DEMO_STICKER_PACKS.find(p => p.skuId === skuId);
  if (!pack || !state?.inventory) return null;
  const inv = state.inventory;
  const deliveryId = `${orderRef}:${skuId}`;
  const existing = inv.deliveries.find(d => d.deliveryId === deliveryId);
  if (existing) return existing;

  const unlockedItems = [];
  for (const itemId of pack.items) {
    const meta = DEMO_COSMETIC_ITEMS[itemId];
    if (!meta) continue;
    if (!inv.items.some(x => x.itemId === itemId)) {
      inv.items.push({ ...meta, acquiredAt: Date.now(), sourceRef: deliveryId });
    }
    unlockedItems.push(meta);
    if (meta.category === 'frame') inv.loadout.equippedFrame = itemId;
    if (meta.category === 'badge') inv.loadout.equippedBadge = itemId;
    if (meta.category === 'title') inv.loadout.equippedTitle = itemId;
  }
  if (state.progression) {
    state.progression.exp = (Number(state.progression.exp) || 0) + pack.expBonus;
    state.progression.level = Math.floor(state.progression.exp / 200) + 1;
    state.progression.currentLevelExp = state.progression.exp % 200;
    state.progression.progressPct = Math.min(100, Math.round((state.progression.currentLevelExp / 200) * 100));
  }
  const rec = {
    deliveryId,
    skuId: pack.skuId,
    critFlair: pack.critFlair,
    a9Amount: pack.a9Amount,
    expAwarded: pack.expBonus,
    items: unlockedItems,
    deliveredAt: Date.now()
  };
  inv.deliveries.unshift(rec);
  return rec;
}

export function demoInventoryEquip(state, category, itemId = null) {
  if (!state?.inventory) return null;
  const inv = state.inventory;
  const clean = itemId ? String(itemId).trim() : null;
  if (clean && !inv.items.some(x => x.itemId === clean && x.category === category)) {
    return { error: '尚未拥有该纸艺装扮' };
  }
  if (category === 'frame') inv.loadout.equippedFrame = clean;
  if (category === 'badge') inv.loadout.equippedBadge = clean;
  if (category === 'title') inv.loadout.equippedTitle = clean;
  return inv;
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
    tgGroupHandle: '@A9_Paper_Guild',
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

  state.inventory = {
    items: [
      { ...DEMO_COSMETIC_ITEMS.frame_cotton, acquiredAt: Date.now() - 3600000, sourceRef: 'demo:init' },
      { ...DEMO_COSMETIC_ITEMS.badge_seal_red, acquiredAt: Date.now() - 3600000, sourceRef: 'demo:init' }
    ],
    loadout: {
      equippedFrame: 'frame_cotton',
      equippedBadge: 'badge_seal_red',
      equippedTitle: null
    },
    deliveries: [],
    filter: 'all',
    loaded: true
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
    throw new Error('请先参与本轮 0 GRAM 24H 达标竞猜后再盖章');
  }
  if (tKey === 'daily_full_bonus') {
    const allDone = DEMO_DAILY_KEYS.every(k => u.todayClaims.has(k));
    if (!allDone) throw new Error('集齐今日全部 4 枚日常印章后方可领取满章加赠');
  }
  if (tKey === 'ach_streak_3' && u.checkinStreak < 3) {
    throw new Error('连续打卡满 3 天后解锁');
  }
  if (tKey === 'ach_pred_pioneer' && !hasPred && !u.todayClaims.has('daily_prediction')) {
    throw new Error('需完成至少 1 次 24H 达标竞猜后解锁');
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
    { rank: '02', name: '折纸星航商会', ton: '462,000 GRAM', a9: '94,200,000 A9' },
    { rank: '03', name: '金箔典藏商会', ton: '295,000 GRAM', a9: '61,500,000 A9' }
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
    { r: '02', addr: '折纸星航商会', invites: 142, reward: 'Lv.4 · +15%' },
    { r: '03', addr: '金箔典藏商会', invites: 94, reward: 'Lv.3 · +10%' }
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
