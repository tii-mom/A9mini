// A9 Protocol v15/v16 — Unified Chest Mall & Viral Social Assist Engine (Zero Contract Changes).
//
// Two unified chest flows backed by one ledger & one social assist link (/c/chest/:chestId):
//   1) FREE_TIER  : Instant Bronze Starter (200 A9, 0 assists) -> Silver Co-Op (1,000 A9, 2 assists)
//                   -> Gold Squad (8,000 A9, 10 assists, >=30 GRAM self+invitees volume)
//                   -> Platinum Community (40,000 A9, 60 assists, >=300 GRAM, >=50 TG members)
//                   -> Diamond Captain (200,000 A9, 300 assists, >=2,000 GRAM, >=200 TG members).
//                   Paid friend acceleration: 1 completed paid chest order by a direct invitee = +3 assists.
//   2) SHOP_BOOST : 6 Paid Chest Mall SKUs (0.99 / 4.99 / 9.99 / 19.99 / 99.99 / 500 GRAM).
//                   Whole-integer A9 base principal + whole-integer random range bonus merged into direct wallet payout.
//
// Anti-sybil guardrails on assistChest():
//   - Authenticated Telegram user + bound TON wallet (ton_proof)
//   - On-chain wallet account state MUST be 'active' (filters empty batch-generated wallets)
//   - Self-assist blocked (helperUserId !== ownerUserId && helperWalletKey !== ownerWalletKey)
//   - Unique per (chestId, helperWalletKey), per (chestId, helperUserId), and lifetime per (ownerUserId, helperWalletKey)
//   - Daily cap: max 3 assists per helper wallet per UTC day
//   - Auto-grants starter Bronze #1 to helpers who have not claimed starter chests yet!

import { addressKey } from './ton-address.mjs';
import { randomHex } from './auth.mjs';
import { utcDayFromSec } from './growth-engine.mjs';

export const A9_RAW = 1_000_000_000n;
export const TON_NANO = 1_000_000_000n;
export const SHOP_BOOST_TTL_SEC = 24 * 3600;
export const MAX_DAILY_ASSISTS_PER_WALLET = 3;
export const PAID_REFERRAL_ASSIST_BONUS = 3;
export const CAPTAIN_FOUNDING_BONUS_RAW = 5_000n * A9_RAW; // 5,000 A9
export const CAPTAIN_MIN_TG_MEMBERS = 50;
export const CAPTAIN_MIN_TEAM_MEMBERS = 3;
export const WARMUP_CHEST_BASE_A9_RAW = 300n * A9_RAW; // 300 A9 at min valid invites
export const WARMUP_CHEST_STEP_A9_RAW = 200n * A9_RAW; // +200 A9 per extra valid invite
export const WARMUP_CHEST_MIN_INVITES = 2;
export const WARMUP_CHEST_MAX_INVITES = 5;
export const CHEST_DELIVERY_GAS_GRAM = '0.06';
export const CHEST_DELIVERY_GAS_NANO = '60000000';
export const CHEST_REFUND_GAS_GRAM = '0.03';
export const CHEST_REFUND_GAS_NANO = '30000000';

export class ChestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const PAID_CHEST_CRIT_TIERS = Object.freeze([
  { key: 'normal', labelZh: '基础区间', labelEn: 'Standard Range', weight: 75, minRatio: 0.0, maxRatio: 0.15, isCrit: false },
  { key: 'lucky', labelZh: '高区加赠', labelEn: 'High Range Bonus', weight: 20, minRatio: 0.15, maxRatio: 0.45, isCrit: false },
  { key: 'jackpot', labelZh: '手气爆棚', labelEn: 'Top Range Roll', weight: 5, minRatio: 0.45, maxRatio: 1.0, isCrit: true },
]);

function secureRandomUnit() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 0x100000000;
}

export function rollPaidChestBonusRaw(maxBoostA9Raw, randomFn = null) {
  const maxBonus = BigInt(String(maxBoostA9Raw || '0'));
  if (maxBonus <= 0n) {
    return { bonusRaw: 0n, critTier: 'normal', isCrit: false, ratioBps: 0 };
  }
  const draw = () => {
    const raw = typeof randomFn === 'function' ? Number(randomFn()) : secureRandomUnit();
    if (!Number.isFinite(raw)) return 0;
    return Math.max(0, Math.min(0.9999999999, raw));
  };
  const rollPct = draw() * 100;
  let acc = 0;
  let chosen = PAID_CHEST_CRIT_TIERS[0];
  for (const tier of PAID_CHEST_CRIT_TIERS) {
    acc += tier.weight;
    if (rollPct < acc) {
      chosen = tier;
      break;
    }
  }
  const ratio = chosen.minRatio + draw() * (chosen.maxRatio - chosen.minRatio);
  const ratioBps = Math.max(0, Math.min(10000, Math.round(ratio * 10000)));
  const maxWholeA9 = maxBonus / A9_RAW;
  const bonusRaw = maxWholeA9 > 0n
    ? ((maxWholeA9 * BigInt(ratioBps)) / 10000n) * A9_RAW
    : (maxBonus * BigInt(ratioBps)) / 10000n;
  return { bonusRaw, critTier: chosen.key, isCrit: chosen.isCrit, ratioBps };
}

export function classifyPaidCritTier(boostA9Raw, maxBoostA9Raw) {
  const boost = BigInt(String(boostA9Raw || '0'));
  const maxBonus = BigInt(String(maxBoostA9Raw || '0'));
  if (boost <= 0n || maxBonus <= 0n) {
    return { critTier: 'normal', isCrit: false, ratioBps: 0 };
  }
  const ratioBps = Number((boost * 10000n) / maxBonus);
  if (ratioBps >= 4500) return { critTier: 'jackpot', isCrit: true, ratioBps };
  if (ratioBps >= 1500) return { critTier: 'lucky', isCrit: false, ratioBps };
  return { critTier: 'normal', isCrit: false, ratioBps };
}

export function maskCritActor(userId, walletKey = null) {
  const w = String(walletKey || '').trim();
  if (w.length >= 10) {
    const tail = w.includes(':') ? w.split(':').pop() : w;
    if (tail && tail.length >= 8) return `${tail.slice(0, 4)}...${tail.slice(-4)}`;
  }
  const u = String(userId || '').trim();
  if (u.length >= 4) return `TG·**${u.slice(-4)}`;
  return 'A9·玩家';
}

export const CHEST_MALL_CATALOG = Object.freeze({
  chest_bronze: {
    skuId: 'chest_bronze',
    tier: 'bronze',
    zh: '青铜宝箱',
    en: 'Bronze Chest',
    priceGram: '0.99',
    priceNano: '990000000',
    deliveryFeeGram: '0.06',
    deliveryFeeNano: '60000000',
    totalPayGram: '1.05',
    totalPayNano: '1050000000',
    baseA9: '1500',
    baseA9Raw: '1500000000000',
    maxA9: '2500',
    requiredAssists: 0,
    initBoostBps: 0,
    maxBoostBps: 6667, // +1,000 A9 max random range bonus (1,500 - 2,500 A9)
    maxBoostA9: '1000',
    maxBoostA9Raw: '1000000000000',
    maxSupply: null,
  },
  chest_silver: {
    skuId: 'chest_silver',
    tier: 'silver',
    zh: '白银宝箱',
    en: 'Silver Chest',
    priceGram: '4.99',
    priceNano: '4990000000',
    deliveryFeeGram: '0.06',
    deliveryFeeNano: '60000000',
    totalPayGram: '5.05',
    totalPayNano: '5050000000',
    baseA9: '8000',
    baseA9Raw: '8000000000000',
    maxA9: '12000',
    requiredAssists: 0,
    initBoostBps: 0,
    maxBoostBps: 5000, // +4,000 A9 max random range bonus (8,000 - 12,000 A9)
    maxBoostA9: '4000',
    maxBoostA9Raw: '4000000000000',
    maxSupply: null,
  },
  chest_gold: {
    skuId: 'chest_gold',
    tier: 'gold',
    zh: '黄金宝箱',
    en: 'Gold Chest',
    priceGram: '9.99',
    priceNano: '9990000000',
    deliveryFeeGram: '0.06',
    deliveryFeeNano: '60000000',
    totalPayGram: '10.05',
    totalPayNano: '10050000000',
    baseA9: '17500',
    baseA9Raw: '17500000000000',
    maxA9: '25000',
    requiredAssists: 0,
    initBoostBps: 0,
    maxBoostBps: 4286, // +7,500 A9 max random range bonus (17,500 - 25,000 A9)
    maxBoostA9: '7500',
    maxBoostA9Raw: '7500000000000',
    maxSupply: null,
  },
  chest_platinum: {
    skuId: 'chest_platinum',
    tier: 'platinum',
    zh: '白金宝箱',
    en: 'Platinum Chest',
    priceGram: '19.99',
    priceNano: '19990000000',
    deliveryFeeGram: '0.06',
    deliveryFeeNano: '60000000',
    totalPayGram: '20.05',
    totalPayNano: '20050000000',
    baseA9: '37000',
    baseA9Raw: '37000000000000',
    maxA9: '50000',
    requiredAssists: 0,
    initBoostBps: 0,
    maxBoostBps: 3514, // +13,000 A9 max random range bonus (37,000 - 50,000 A9)
    maxBoostA9: '13000',
    maxBoostA9Raw: '13000000000000',
    maxSupply: null,
  },
  chest_diamond: {
    skuId: 'chest_diamond',
    tier: 'diamond',
    zh: '钻石宝箱',
    en: 'Diamond Chest',
    priceGram: '99.99',
    priceNano: '99990000000',
    deliveryFeeGram: '0.06',
    deliveryFeeNano: '60000000',
    totalPayGram: '100.05',
    totalPayNano: '100050000000',
    baseA9: '195000',
    baseA9Raw: '195000000000000',
    maxA9: '250000',
    requiredAssists: 0,
    initBoostBps: 0,
    maxBoostBps: 2821, // +55,000 A9 max random range bonus (195,000 - 250,000 A9)
    maxBoostA9: '55000',
    maxBoostA9Raw: '55000000000000',
    maxSupply: null,
  },
  chest_legendary: {
    skuId: 'chest_legendary',
    tier: 'legendary',
    zh: '传说宝箱',
    en: 'Legendary Chest',
    priceGram: '500',
    priceNano: '500000000000',
    deliveryFeeGram: '0.06',
    deliveryFeeNano: '60000000',
    totalPayGram: '500.06',
    totalPayNano: '500060000000',
    baseA9: '1025000',
    baseA9Raw: '1025000000000000',
    maxA9: '1300000',
    requiredAssists: 0,
    initBoostBps: 0,
    maxBoostBps: 2683, // +275,000 A9 max random range bonus (1,025,000 - 1,300,000 A9)
    maxBoostA9: '275000',
    maxBoostA9Raw: '275000000000000',
    maxSupply: null,
  },
});

export const CHEST_MALL_NANO_TO_SKU = Object.freeze({
  '990000000': 'chest_bronze',
  '4990000000': 'chest_silver',
  '9990000000': 'chest_gold',
  '19990000000': 'chest_platinum',
  '99990000000': 'chest_diamond',
  '500000000000': 'chest_legendary',
});

export const FREE_CHEST_CHAIN = Object.freeze([
  {
    key: 'bronze:1',
    tier: 'bronze',
    slotIndex: 1,
    zh: '青铜新手箱',
    en: 'Bronze Starter Chest',
    rewardA9Raw: String(200n * A9_RAW),
    requiredAssists: 0,
    minVolumeNano: '0',
    minTgMembers: 0,
    goesToPendingVault: true,
  },
  {
    key: 'silver:1',
    tier: 'silver',
    slotIndex: 1,
    zh: '白银双人箱',
    en: 'Silver Co-Op Chest',
    rewardA9Raw: String(1_000n * A9_RAW),
    requiredAssists: 2,
    minVolumeNano: '0',
    minTgMembers: 0,
    goesToPendingVault: true,
  },
  {
    key: 'gold:1',
    tier: 'gold',
    slotIndex: 1,
    zh: '黄金小队长箱',
    en: 'Gold Squad Chest',
    rewardA9Raw: String(8_000n * A9_RAW),
    requiredAssists: 10,
    minVolumeNano: String(30n * TON_NANO),
    minTgMembers: 0,
    goesToPendingVault: false,
  },
  {
    key: 'platinum:1',
    tier: 'platinum',
    slotIndex: 1,
    zh: '白金社区长箱',
    en: 'Platinum Community Chest',
    rewardA9Raw: String(40_000n * A9_RAW),
    requiredAssists: 60,
    minVolumeNano: String(300n * TON_NANO),
    minTgMembers: 50,
    goesToPendingVault: false,
  },
  {
    key: 'diamond:1',
    tier: 'diamond',
    slotIndex: 1,
    zh: '钻石大群主箱',
    en: 'Diamond Captain Chest',
    rewardA9Raw: String(200_000n * A9_RAW),
    requiredAssists: 300,
    minVolumeNano: String(2_000n * TON_NANO),
    minTgMembers: 200,
    goesToPendingVault: false,
  },
]);

export function findFreeChestSpec(tier, slotIndex = 1) {
  return FREE_CHEST_CHAIN.find((c) => c.tier === tier && c.slotIndex === Number(slotIndex)) || null;
}

export function nextFreeChestSpec(tier, slotIndex = 1) {
  const idx = FREE_CHEST_CHAIN.findIndex((c) => c.tier === tier && c.slotIndex === Number(slotIndex));
  return idx >= 0 && idx + 1 < FREE_CHEST_CHAIN.length ? FREE_CHEST_CHAIN[idx + 1] : null;
}

export const CHEST_HOLDING_TIERS = Object.freeze(['bronze', 'silver', 'gold', 'platinum', 'diamond', 'legendary']);

/**
 * 统一统计用户累计持有的 6 种宝箱数量（用于图鉴「宝箱持有」系列解锁）：
 * - FREE_TIER（免费助力链）：仅已开启（OPENED）计入
 * - SHOP_BOOST（商城膨胀箱）：非 CANCELLED 计入，按 orderId 去重
 * - completedShopOrders（含 INSTANT 直接开箱与 BOOST 已成交商城订单）：按 orderId 去重补齐
 */
export function summarizeUserChestHoldings({ freeChests = [], shopChests = [], completedShopOrders = [] } = {}) {
  const counts = { bronze: 0, silver: 0, gold: 0, platinum: 0, diamond: 0, legendary: 0 };
  const seenOrderIds = new Set();

  for (const c of Array.isArray(freeChests) ? freeChests : []) {
    const t = String(c?.tier || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, t) && c?.status === 'OPENED') {
      counts[t] += 1;
    }
  }

  for (const c of Array.isArray(shopChests) ? shopChests : []) {
    if (c?.status === 'CANCELLED') continue;
    const t = String(c?.tier || '').toLowerCase();
    if (c?.orderId) seenOrderIds.add(String(c.orderId));
    if (Object.prototype.hasOwnProperty.call(counts, t)) {
      counts[t] += 1;
    }
  }

  for (const o of Array.isArray(completedShopOrders) ? completedShopOrders : []) {
    if (o?.status !== 'COMPLETED') continue;
    const oid = o?.orderId ? String(o.orderId) : null;
    if (oid && seenOrderIds.has(oid)) continue;
    const skuId = o?.skuId || CHEST_MALL_NANO_TO_SKU[String(o?.tonNano ?? '')] || null;
    const tier = String(o?.tier || (skuId ? CHEST_MALL_CATALOG[skuId]?.tier : '') || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, tier)) {
      if (oid) seenOrderIds.add(oid);
      counts[tier] += 1;
    }
  }

  const distinctTypes = CHEST_HOLDING_TIERS.filter((k) => counts[k] > 0).length;
  const total = CHEST_HOLDING_TIERS.reduce((sum, k) => sum + counts[k], 0);
  return { ...counts, distinctTypes, total };
}

export function computeShopBoostForAssists(pack, assistsCount) {
  const base = BigInt(pack.baseA9Raw);
  const maxBoost = BigInt(pack.maxBoostA9Raw);
  const initBoost = (base * BigInt(pack.initBoostBps)) / 10000n;
  const req = Math.max(1, Number(pack.requiredAssists));
  const clamped = Math.max(0, Math.min(req, Number(assistsCount || 0)));
  if (clamped >= req) return maxBoost;
  const remaining = maxBoost > initBoost ? maxBoost - initBoost : 0n;
  return initBoost + (remaining * BigInt(clamped)) / BigInt(req);
}

export function computeWarmupChestReward(validInvites, cfg = {}) {
  const minInv = Math.max(1, Math.floor(Number(cfg.minInvites ?? WARMUP_CHEST_MIN_INVITES) || WARMUP_CHEST_MIN_INVITES));
  const maxInv = Math.max(minInv, Math.floor(Number(cfg.maxInvites ?? WARMUP_CHEST_MAX_INVITES) || WARMUP_CHEST_MAX_INVITES));
  const base = BigInt(String(cfg.baseA9Raw ?? WARMUP_CHEST_BASE_A9_RAW));
  const step = BigInt(String(cfg.stepA9Raw ?? WARMUP_CHEST_STEP_A9_RAW));
  const maxBoost = BigInt(maxInv - minInv) * step;
  const cur = Math.max(0, Math.floor(Number(validInvites || 0) || 0));
  if (cur <= minInv) {
    return { baseA9Raw: base, boostA9Raw: 0n, maxBoostA9Raw: maxBoost, totalA9Raw: cur >= minInv ? base : 0n, minInvites: minInv, maxInvites: maxInv };
  }
  const extra = Math.min(cur - minInv, maxInv - minInv);
  const boost = BigInt(extra) * step;
  return { baseA9Raw: base, boostA9Raw: boost, maxBoostA9Raw: maxBoost, totalA9Raw: base + boost, minInvites: minInv, maxInvites: maxInv };
}

export function formatChestRecord(c) {
  if (!c) return null;
  const isWarmup = c.source === 'WARMUP_ROUND';
  const slot = Number(c.slotIndex || 1);
  const spec = c.source === 'FREE_TIER'
    ? findFreeChestSpec(c.tier, c.slotIndex)
    : isWarmup
      ? null
      : Object.values(CHEST_MALL_CATALOG).find((p) => p.tier === c.tier) || null;
  return {
    chestId: c.chestId,
    ownerUserId: c.ownerUserId,
    ownerWalletKey: c.ownerWalletKey || null,
    source: c.source,
    tier: c.tier,
    slotIndex: slot,
    labelZh: isWarmup ? `第 ${slot} 轮预约预热宝箱` : (spec?.zh || c.tier),
    labelEn: isWarmup ? `R${slot} Warm-up Chest` : (spec?.en || c.tier),
    orderId: c.orderId || null,
    baseA9Raw: String(c.baseA9Raw || '0'),
    boostA9Raw: String(c.boostA9Raw || '0'),
    maxBoostA9Raw: String(c.maxBoostA9Raw || '0'),
    requiredAssists: Number(c.requiredAssists || 0),
    currentAssists: Number(c.currentAssists || 0),
    minVolumeNano: spec?.minVolumeNano || '0',
    minTgMembers: Number(spec?.minTgMembers || 0),
    status: c.status,
    expiresAt: c.expiresAt ? Number(c.expiresAt) : null,
    openedAt: c.openedAt ? Number(c.openedAt) : null,
    createdAt: Number(c.createdAt || 0),
    updatedAt: Number(c.updatedAt || 0),
  };
}

export class ChestEngine {
  constructor({ budgetLedger = null } = {}) {
    this.budgetLedger = budgetLedger;
    this.chests = new Map(); // chestId -> record
    this.assists = [];       // { chestId, ownerUserId, helperUserId, helperWalletKey, assistDay, boostDeltaRaw, createdAt }
    this.captainBonuses = new Map(); // teamId -> record
    this.captainBonusChatIds = new Set();
    this.captainBonusUsers = new Set();
    this.captainBonusWallets = new Set();
  }

  async claimStarterBronzeChests({ userId, walletAddress = null }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(userId || '').trim();
    if (!uid) throw new ChestError('BAD_REQUEST', 'userId required');
    const walletKey = walletAddress ? addressKey(walletAddress) : null;

    const existing = [...this.chests.values()].filter((c) => c.ownerUserId === uid && c.source === 'FREE_TIER');
    if (existing.length > 0) {
      return { created: false, chests: existing.sort((a, b) => a.createdAt - b.createdAt).map(formatChestRecord) };
    }

    const created = [];
    for (let i = 0; i < FREE_CHEST_CHAIN.length; i += 1) {
      const spec = FREE_CHEST_CHAIN[i];
      const rec = {
        chestId: `ch_${randomHex(6)}`,
        ownerUserId: uid,
        ownerWalletKey: walletKey,
        source: 'FREE_TIER',
        tier: spec.tier,
        slotIndex: spec.slotIndex,
        orderId: null,
        baseA9Raw: spec.rewardA9Raw,
        boostA9Raw: '0',
        maxBoostA9Raw: '0',
        requiredAssists: spec.requiredAssists,
        currentAssists: 0,
        status: i === 0 ? (spec.requiredAssists <= 0 ? 'READY' : 'ACTIVE') : 'LOCKED',
        expiresAt: null,
        openedAt: null,
        createdAt: nowSec + i,
        updatedAt: nowSec,
      };
      this.chests.set(rec.chestId, rec);
      created.push(rec);
    }
    return { created: true, chests: created.map(formatChestRecord) };
  }

  async createShopBoostChest({ userId, walletAddress = null, skuId, orderId }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(userId || '').trim();
    const pack = CHEST_MALL_CATALOG[String(skuId || '').trim()];
    if (!uid || !pack || !orderId) throw new ChestError('BAD_REQUEST', 'valid userId, skuId, orderId required');

    for (const c of this.chests.values()) {
      if (c.orderId === String(orderId)) return formatChestRecord(c);
    }
    const rec = {
      chestId: `ch_${randomHex(6)}`,
      ownerUserId: uid,
      ownerWalletKey: walletAddress ? addressKey(walletAddress) : null,
      source: 'SHOP_BOOST',
      tier: pack.tier,
      slotIndex: 1,
      orderId: String(orderId),
      baseA9Raw: pack.baseA9Raw,
      boostA9Raw: '0',
      maxBoostA9Raw: pack.maxBoostA9Raw,
      requiredAssists: 0,
      currentAssists: 0,
      status: 'READY',
      expiresAt: null,
      openedAt: null,
      createdAt: nowSec,
      updatedAt: nowSec,
    };
    this.chests.set(rec.chestId, rec);
    return formatChestRecord(rec);
  }

  async getChest(chestId) {
    return formatChestRecord(this.chests.get(String(chestId || '').trim()));
  }

  async ensureWarmupRoundChest({ userId, roundId, walletAddress = null, validInvites = 0, config = {} }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(userId || '').trim();
    const rId = Number(roundId);
    if (!uid || !Number.isInteger(rId) || rId < 1) throw new ChestError('BAD_REQUEST', 'valid userId and roundId required');
    const reward = computeWarmupChestReward(validInvites, config);
    for (const c of this.chests.values()) {
      if (c.ownerUserId === uid && c.source === 'WARMUP_ROUND' && Number(c.slotIndex) === rId) {
        if (walletAddress && !c.ownerWalletKey) c.ownerWalletKey = addressKey(walletAddress);
        if (c.status !== 'OPENED') {
          c.currentAssists = Math.max(0, Number(validInvites || 0));
          c.boostA9Raw = reward.boostA9Raw.toString();
          c.status = c.currentAssists >= c.requiredAssists ? 'READY' : 'ACTIVE';
          c.updatedAt = nowSec;
        }
        return { created: false, chest: formatChestRecord(c) };
      }
    }
    const cur = Math.max(0, Number(validInvites || 0));
    const rec = {
      chestId: `ch_${randomHex(6)}`,
      ownerUserId: uid,
      ownerWalletKey: walletAddress ? addressKey(walletAddress) : null,
      source: 'WARMUP_ROUND',
      tier: 'warmup',
      slotIndex: rId,
      orderId: null,
      baseA9Raw: reward.baseA9Raw.toString(),
      boostA9Raw: reward.boostA9Raw.toString(),
      maxBoostA9Raw: reward.maxBoostA9Raw.toString(),
      requiredAssists: reward.minInvites,
      currentAssists: cur,
      status: cur >= reward.minInvites ? 'READY' : 'ACTIVE',
      expiresAt: null,
      openedAt: null,
      createdAt: nowSec,
      updatedAt: nowSec,
    };
    this.chests.set(rec.chestId, rec);
    return { created: true, chest: formatChestRecord(rec) };
  }

  async syncWarmupChestProgress({ userId, roundId, validInvites = 0, walletAddress = null, config = {} }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(userId || '').trim();
    const rId = Number(roundId);
    if (!uid || !Number.isInteger(rId) || rId < 1) return null;
    for (const c of this.chests.values()) {
      if (c.ownerUserId === uid && c.source === 'WARMUP_ROUND' && Number(c.slotIndex) === rId) {
        if (walletAddress && !c.ownerWalletKey) c.ownerWalletKey = addressKey(walletAddress);
        if (c.status !== 'OPENED') {
          const reward = computeWarmupChestReward(validInvites, {
            baseA9Raw: config.baseA9Raw ?? c.baseA9Raw,
            stepA9Raw: config.stepA9Raw,
            minInvites: config.minInvites ?? c.requiredAssists,
            maxInvites: config.maxInvites,
          });
          c.currentAssists = Math.max(0, Number(validInvites || 0));
          c.boostA9Raw = reward.boostA9Raw.toString();
          c.status = c.currentAssists >= c.requiredAssists ? 'READY' : 'ACTIVE';
          c.updatedAt = nowSec;
        }
        return formatChestRecord(c);
      }
    }
    return null;
  }

  async getWarmupRoundChest(userId, roundId) {
    const uid = String(userId || '').trim();
    const rId = Number(roundId);
    for (const c of this.chests.values()) {
      if (c.ownerUserId === uid && c.source === 'WARMUP_ROUND' && Number(c.slotIndex) === rId) {
        return formatChestRecord(c);
      }
    }
    return null;
  }

  async listUserChests(userId) {
    const uid = String(userId || '').trim();
    const all = [...this.chests.values()]
      .filter((c) => c.ownerUserId === uid)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(formatChestRecord);
    return {
      freeChests: all.filter((c) => c.source === 'FREE_TIER'),
      shopChests: all.filter((c) => c.source === 'SHOP_BOOST').reverse(),
      warmupChests: all.filter((c) => c.source === 'WARMUP_ROUND').reverse(),
    };
  }

  async assistChest(
    { chestId, helperUserId, helperWalletAddress, walletActive = false },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    const cId = String(chestId || '').trim();
    const hUid = String(helperUserId || '').trim();
    const hWallet = String(helperWalletAddress || '').trim();
    if (!cId || !hUid || !hWallet) throw new ChestError('BAD_REQUEST', 'chestId, helperUserId and helperWalletAddress required');
    if (walletActive !== true) {
      throw new ChestError('WALLET_NOT_ACTIVE', '助力钱包须为链上已激活（active）TON 钱包，暂不支持未激活空钱包');
    }

    const chest = this.chests.get(cId);
    if (!chest) throw new ChestError('CHEST_NOT_FOUND', '未找到对应宝箱');
    if (chest.source === 'WARMUP_ROUND') {
      throw new ChestError('ASSIST_NOT_ALLOWED', '预热宝箱仅可通过邀请好友预约并绑定活跃钱包解锁');
    }
    if (chest.source === 'SHOP_BOOST') {
      throw new ChestError('ASSIST_NOT_ALLOWED', '付费宝箱无需好友助力，购买后随机区间加赠将随保底本金合并直发钱包');
    }
    if (chest.status === 'LOCKED') throw new ChestError('CHEST_LOCKED', '该宝箱尚未解锁，请先开启上一个宝箱');
    if (chest.status === 'OPENED' || chest.status === 'EXPIRED') {
      throw new ChestError('CHEST_CLOSED', '该宝箱已开启或已结束助力');
    }
    if (chest.source === 'SHOP_BOOST' && chest.expiresAt && nowSec > chest.expiresAt) {
      throw new ChestError('BOOST_WINDOW_EXPIRED', '该宝箱 24H 膨胀窗口已结束，请直接开箱领取');
    }
    if (chest.currentAssists >= chest.requiredAssists) {
      throw new ChestError('ASSIST_FULL', '该宝箱助力人数已满');
    }

    const hKey = addressKey(hWallet);
    if (hUid === chest.ownerUserId || (chest.ownerWalletKey && hKey === chest.ownerWalletKey)) {
      throw new ChestError('SELF_ASSIST_FORBIDDEN', '不能为自己的宝箱助力');
    }
    if (this.assists.some((a) => a.chestId === cId && (a.helperWalletKey === hKey || a.helperUserId === hUid))) {
      throw new ChestError('ALREADY_ASSISTED', '你已经助力过该宝箱');
    }
    if (this.assists.some((a) => a.ownerUserId === chest.ownerUserId && a.helperWalletKey === hKey)) {
      throw new ChestError('OWNER_PAIR_LIMIT', '同一钱包终身仅可为同一宝箱主助力 1 次');
    }

    const today = utcDayFromSec(nowSec);
    const dailyCount = this.assists.filter((a) => a.helperWalletKey === hKey && a.assistDay === today).length;
    if (dailyCount >= MAX_DAILY_ASSISTS_PER_WALLET) {
      throw new ChestError('DAILY_ASSIST_LIMIT', `同一钱包每日最多助力 ${MAX_DAILY_ASSISTS_PER_WALLET} 次`);
    }

    let boostDelta = 0n;
    chest.currentAssists += 1;
    if (chest.source === 'SHOP_BOOST') {
      const pack = Object.values(CHEST_MALL_CATALOG).find((p) => p.tier === chest.tier);
      const prevBoost = BigInt(chest.boostA9Raw || '0');
      const nextBoost = pack ? computeShopBoostForAssists(pack, chest.currentAssists) : prevBoost;
      boostDelta = nextBoost > prevBoost ? nextBoost - prevBoost : 0n;
      chest.boostA9Raw = nextBoost.toString();
    }
    if (chest.currentAssists >= chest.requiredAssists) {
      chest.status = 'READY';
    }
    chest.updatedAt = nowSec;

    this.assists.push({
      chestId: cId,
      ownerUserId: chest.ownerUserId,
      helperUserId: hUid,
      helperWalletKey: hKey,
      assistDay: today,
      boostDeltaRaw: boostDelta.toString(),
      createdAt: nowSec,
    });

    // 病毒自复制闭环：助力者若尚未领取过青铜新手箱，立即发放可秒开的青铜新手箱（200 A9，0 助力）！
    const starter = await this.claimStarterBronzeChests({ userId: hUid, walletAddress: hWallet }, nowSec);

    return {
      chest: formatChestRecord(chest),
      boostDeltaRaw: boostDelta.toString(),
      helperGrantedStarter: starter.created,
      helperBronzeChest: starter.chests[0] || null,
    };
  }

  /** 付费好友加速：直邀好友完成任意付费宝箱订单时，幂等为邀请人当前进行中的免费宝箱 +3 点助力进度。 */
  async creditPaidReferralAssist(
    { ownerUserId, orderId, helperUserId = null, bonusAssists = PAID_REFERRAL_ASSIST_BONUS },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    const uid = String(ownerUserId || '').trim();
    const oid = String(orderId || '').trim();
    const add = Math.max(1, Math.floor(Number(bonusAssists || PAID_REFERRAL_ASSIST_BONUS)));
    if (!uid || !oid) return { credited: false, reason: 'BAD_REQUEST' };
    const synthKey = `paid_ref:${oid}`;
    if (this.assists.some((a) => a.ownerUserId === uid && a.helperWalletKey === synthKey)) {
      return { credited: false, reason: 'ALREADY_CREDITED' };
    }
    const activeChest = [...this.chests.values()]
      .filter((c) => c.ownerUserId === uid && c.source === 'FREE_TIER' && c.status === 'ACTIVE' && c.currentAssists < c.requiredAssists)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!activeChest) return { credited: false, reason: 'NO_ACTIVE_FREE_CHEST' };
    const prev = Number(activeChest.currentAssists || 0);
    const next = Math.min(Number(activeChest.requiredAssists || 0), prev + add);
    const delta = next - prev;
    if (delta <= 0) return { credited: false, reason: 'ASSIST_FULL' };
    activeChest.currentAssists = next;
    if (activeChest.currentAssists >= activeChest.requiredAssists) activeChest.status = 'READY';
    activeChest.updatedAt = nowSec;
    this.assists.push({
      chestId: activeChest.chestId,
      ownerUserId: uid,
      helperUserId: helperUserId ? String(helperUserId) : synthKey,
      helperWalletKey: synthKey,
      assistDay: utcDayFromSec(nowSec),
      boostDeltaRaw: '0',
      createdAt: nowSec,
    });
    return { credited: true, addedAssists: delta, chest: formatChestRecord(activeChest) };
  }

  async openChest(
    {
      chestId,
      userId,
      walletAddress,
      teamVolumeNano = 0n,
      teamTgMemberCount = 0,
      promoEngine = null,
      predictionEngine = null,
      budgetLedger = this.budgetLedger,
      randomFn = null,
    },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    const cId = String(chestId || '').trim();
    const uid = String(userId || '').trim();
    const chest = this.chests.get(cId);
    if (!chest) throw new ChestError('CHEST_NOT_FOUND', '未找到对应宝箱');
    if (chest.ownerUserId !== uid) throw new ChestError('FORBIDDEN', '只能开启自己的宝箱');
    if (chest.status === 'LOCKED') throw new ChestError('CHEST_LOCKED', '请先开启上一个宝箱后再激活当前宝箱');
    if (chest.status === 'OPENED') throw new ChestError('ALREADY_OPENED', '该宝箱已开启');

    let rewardRaw = 0n;
    let destination = 'PROMO_BALANCE';
    let nextUnlocked = null;
    let budgetBucket = 'free_chest_captain';
    let nextSpec = null;
    let critTier = null;
    let isCrit = false;
    let budgetCapped = false;

    if (chest.source === 'SHOP_BOOST') {
      if (!walletAddress) {
        throw new ChestError('WALLET_REQUIRED', '开启付费宝箱领取随机区间加赠需绑定钱包地址');
      }
      const rolled = rollPaidChestBonusRaw(chest.maxBoostA9Raw, randomFn);
      rewardRaw = rolled.bonusRaw;
      critTier = rolled.critTier;
      isCrit = rolled.isCrit;
      budgetBucket = 'presale_promo';
    } else if (chest.source === 'WARMUP_ROUND') {
      if (chest.currentAssists < chest.requiredAssists) {
        throw new ChestError('ASSISTS_UNMET', `还需 ${chest.requiredAssists - chest.currentAssists} 位已绑活跃钱包的预热好友方可开启`);
      }
      rewardRaw = BigInt(chest.baseA9Raw || '0') + BigInt(chest.boostA9Raw || '0');
      destination = 'PENDING_VAULT';
      budgetBucket = 'warmup';
    } else {
      const spec = findFreeChestSpec(chest.tier, chest.slotIndex);
      if (!spec) throw new ChestError('BAD_STATE', '未知的免费宝箱档位');
      if (chest.currentAssists < chest.requiredAssists) {
        throw new ChestError('ASSISTS_UNMET', `还需 ${chest.requiredAssists - chest.currentAssists} 位真实活跃钱包助力后方可开启`);
      }
      if (BigInt(teamVolumeNano || 0n) < BigInt(spec.minVolumeNano)) {
        throw new ChestError('VOLUME_UNMET', '直邀/战队累计真实商城兑换额尚未达到该档位要求');
      }
      if (Number(teamTgMemberCount || 0) < Number(spec.minTgMembers)) {
        throw new ChestError('TG_GROUP_UNMET', `该档位需绑定真实核验 TG 群且群人数不少于 ${spec.minTgMembers} 人`);
      }
      rewardRaw = BigInt(chest.baseA9Raw || '0');
      destination = spec.goesToPendingVault ? 'PENDING_VAULT' : 'PROMO_BALANCE';
      budgetBucket = 'free_chest_captain';
      if (destination === 'PROMO_BALANCE' && rewardRaw > 0n && !walletAddress) {
        throw new ChestError('WALLET_REQUIRED', '领取该档位宝箱奖励需绑定钱包地址');
      }
      nextSpec = nextFreeChestSpec(chest.tier, chest.slotIndex);
    }

    if (rewardRaw > 0n && budgetLedger && typeof budgetLedger.reserve === 'function') {
      try {
        await budgetLedger.reserve(budgetBucket, rewardRaw, nowSec);
      } catch (e) {
        if (chest.source === 'SHOP_BOOST' && e?.code === 'PROMO_BUDGET_EXHAUSTED') {
          rewardRaw = 0n;
          critTier = 'normal';
          isCrit = false;
          budgetCapped = true;
        } else {
          throw e;
        }
      }
    }

    if (chest.source === 'SHOP_BOOST') {
      chest.boostA9Raw = rewardRaw.toString();
    }
    chest.status = 'OPENED';
    chest.openedAt = nowSec;
    chest.updatedAt = nowSec;

    if (destination === 'PENDING_VAULT') {
      if (rewardRaw > 0n && predictionEngine && typeof predictionEngine.creditPendingBonus === 'function') {
        await predictionEngine.creditPendingBonus(uid, rewardRaw, nowSec * 1000, {
          sourceBucket: budgetBucket,
          sourceKind: chest.source === 'WARMUP_ROUND' ? 'WARMUP_CHEST' : 'FREE_CHEST',
          sourceRef: chest.chestId,
          voucherId: `chest:${chest.chestId}`,
          budgetLedger,
        });
      }
    } else if (rewardRaw > 0n && promoEngine && walletAddress && typeof promoEngine.creditReward === 'function') {
      await promoEngine.creditReward(walletAddress, rewardRaw, nowSec);
    }

    if (nextSpec) {
      for (const other of this.chests.values()) {
        if (
          other.ownerUserId === uid &&
          other.source === 'FREE_TIER' &&
          other.tier === nextSpec.tier &&
          other.slotIndex === nextSpec.slotIndex &&
          other.status === 'LOCKED'
        ) {
          other.status = nextSpec.requiredAssists <= 0 ? 'READY' : 'ACTIVE';
          other.updatedAt = nowSec;
          nextUnlocked = formatChestRecord(other);
          break;
        }
      }
    }

    return {
      chest: formatChestRecord(chest),
      rewardA9Raw: rewardRaw.toString(),
      destination,
      nextUnlocked,
      critTier,
      isCrit,
      budgetCapped,
    };
  }

  async openAllChests(
    {
      userId,
      walletAddress,
      tier = null,
      promoEngine = null,
      budgetLedger = this.budgetLedger,
      randomFn = null,
    },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    const uid = String(userId || '').trim();
    const filterTier = tier ? String(tier).trim().toLowerCase() : null;
    if (!uid) throw new ChestError('BAD_REQUEST', 'userId required');
    if (!walletAddress) throw new ChestError('WALLET_REQUIRED', '一键开启付费宝箱需绑定钱包地址');

    const targets = [...this.chests.values()]
      .filter((c) => c.ownerUserId === uid && c.source === 'SHOP_BOOST' && (c.status === 'ACTIVE' || c.status === 'READY'))
      .filter((c) => (!filterTier ? true : String(c.tier || '').toLowerCase() === filterTier))
      .sort((a, b) => a.createdAt - b.createdAt);

    let totalRewardRaw = 0n;
    let totalBaseRaw = 0n;
    let critCount = 0;
    let legendaryCount = 0;
    let budgetCappedCount = 0;
    const results = [];

    for (const target of targets) {
      const res = await this.openChest(
        {
          chestId: target.chestId,
          userId: uid,
          walletAddress,
          promoEngine,
          budgetLedger,
          randomFn,
        },
        nowSec,
      );
      totalRewardRaw += BigInt(res.rewardA9Raw || '0');
      totalBaseRaw += BigInt(res.chest?.baseA9Raw || '0');
      if (res.isCrit) critCount += 1;
      if (res.critTier === 'jackpot' || res.critTier === 'legendary') legendaryCount += 1;
      if (res.budgetCapped) budgetCappedCount += 1;
      results.push(res);
    }

    return {
      openedCount: results.length,
      tier: filterTier,
      totalBaseA9Raw: totalBaseRaw.toString(),
      totalRewardA9Raw: totalRewardRaw.toString(),
      critCount,
      legendaryCount,
      budgetCappedCount,
      results,
    };
  }

  async listRecentCritFeed({ limit = 15 } = {}) {
    const safeLimit = Math.max(1, Math.min(30, Math.floor(Number(limit) || 15)));
    const items = [];
    const opened = [...this.chests.values()]
      .filter((c) => c.source === 'SHOP_BOOST' && c.status === 'OPENED' && BigInt(String(c.boostA9Raw || '0')) > 0n)
      .sort((a, b) => Number(b.openedAt || b.updatedAt || 0) - Number(a.openedAt || a.updatedAt || 0));
    for (const c of opened) {
      const { critTier, isCrit, ratioBps } = classifyPaidCritTier(c.boostA9Raw, c.maxBoostA9Raw);
      if (!isCrit) continue;
      const spec = Object.values(CHEST_MALL_CATALOG).find((p) => p.tier === c.tier) || null;
      items.push({
        chestId: c.chestId,
        actor: maskCritActor(c.ownerUserId, c.ownerWalletKey),
        tier: c.tier,
        labelZh: spec?.zh || c.tier,
        labelEn: spec?.en || c.tier,
        boostA9Raw: String(c.boostA9Raw),
        maxBoostA9Raw: String(c.maxBoostA9Raw || '0'),
        critTier,
        ratioBps,
        openedAt: Number(c.openedAt || c.updatedAt || 0),
      });
      if (items.length >= safeLimit) break;
    }
    return items;
  }

  async grantCaptainFoundingBonus(
    {
      teamId,
      captainUserId,
      captainWallet,
      tgChatId = null,
      tgMemberCount,
      teamMemberCount = null,
      predictionEngine = null,
      budgetLedger = this.budgetLedger,
    },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    const tId = String(teamId || '').trim();
    const cUid = String(captainUserId || '').trim();
    const chatId = tgChatId ? String(tgChatId).trim() : null;
    const count = Number(tgMemberCount || 0);
    if (!tId || !cUid || count < CAPTAIN_MIN_TG_MEMBERS) {
      return { granted: false, reason: 'BELOW_MIN_MEMBERS', amountRaw: '0' };
    }
    if (teamMemberCount !== null && teamMemberCount !== undefined && Number(teamMemberCount) < CAPTAIN_MIN_TEAM_MEMBERS) {
      return { granted: false, reason: 'BELOW_MIN_TEAM_MEMBERS', amountRaw: '0' };
    }
    const walletKey = addressKey(captainWallet || cUid);
    if (
      this.captainBonuses.has(tId) ||
      this.captainBonusUsers.has(cUid) ||
      this.captainBonusWallets.has(walletKey) ||
      (chatId && this.captainBonusChatIds.has(chatId))
    ) {
      return { granted: false, reason: 'ALREADY_GRANTED', amountRaw: '0' };
    }
    if (budgetLedger && typeof budgetLedger.reserve === 'function') {
      await budgetLedger.reserve('free_chest_captain', CAPTAIN_FOUNDING_BONUS_RAW, nowSec);
    }
    const rec = {
      teamId: tId,
      captainUserId: cUid,
      captainWalletKey: walletKey,
      tgChatId: chatId,
      tgMemberCount: count,
      amountRaw: CAPTAIN_FOUNDING_BONUS_RAW.toString(),
      status: 'CREDITED_PENDING',
      createdAt: nowSec,
    };
    this.captainBonuses.set(tId, rec);
    this.captainBonusUsers.add(cUid);
    this.captainBonusWallets.add(walletKey);
    if (chatId) this.captainBonusChatIds.add(chatId);
    if (predictionEngine && typeof predictionEngine.creditPendingBonus === 'function') {
      await predictionEngine.creditPendingBonus(cUid, CAPTAIN_FOUNDING_BONUS_RAW, nowSec * 1000, {
        sourceBucket: 'free_chest_captain',
        sourceKind: 'CAPTAIN_FOUNDING',
        sourceRef: tId,
        voucherId: `captain:${tId}`,
        budgetLedger,
      });
    }
    return { granted: true, amountRaw: rec.amountRaw, bonus: rec };
  }

  /** 只读查询队长 5,000 A9 创世金库真实发放状态（内存态单源真值）。 */
  async getCaptainFoundingBonusStatus({ teamId = null, captainWallet = null } = {}) {
    const tId = String(teamId || '').trim();
    const wKey = captainWallet ? addressKey(captainWallet) : null;
    let rec = tId ? this.captainBonuses.get(tId) || null : null;
    if (!rec && wKey) {
      for (const item of this.captainBonuses.values()) {
        if (item.captainWalletKey === wKey) {
          rec = item;
          break;
        }
      }
    }
    return {
      paid: Boolean(rec),
      amountRaw: rec ? String(rec.amountRaw || CAPTAIN_FOUNDING_BONUS_RAW.toString()) : '0',
      createdAt: rec ? Number(rec.createdAt || 0) || null : null,
    };
  }
}
