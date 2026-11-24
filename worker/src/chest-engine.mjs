// A9 Protocol v15 — Unified Chest Mall & Viral Social Assist Engine (Zero Contract Changes).
//
// Two unified chest flows backed by one ledger & one social assist link (/c/chest/:chestId):
//   1) FREE_TIER  : Serial Bronze (#1/#2/#3: 300/300/400 A9) -> Silver (10k) -> Gold (100k)
//                   -> Platinum (200k) -> Diamond (1,000k).
//                   Tiers 3-5 enforce doubled difficulty (100/300/1,000 TG members, 160/400/2,000 assists,
//                   1,000/2,400/12,000 GRAM cumulative team/direct exchange volume).
//   2) SHOP_BOOST : Paid Chest Mall SKUs (0.99 / 4.99 / 9.99 / 19.99 / 99.99 GRAM).
//                   Principal is ALWAYS fixed 1 GRAM = 2,002 A9 (never held hostage).
//                   Choosing openMode='BOOST' opens a 24h boost window (+1% initial, up to +6%..+12%
//                   from the independent promo reward pool), stoppable & openable at any time.
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
export const CAPTAIN_FOUNDING_BONUS_RAW = 5_000n * A9_RAW; // 5,000 A9
export const CAPTAIN_MIN_TG_MEMBERS = 50;
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
    baseA9: '1981.98',
    baseA9Raw: '1981980000000',
    requiredAssists: 2,
    initBoostBps: 100, // +1%
    maxBoostBps: 600,  // +6%
    maxBoostA9Raw: '118918800000', // 118.9188 A9
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
    baseA9: '9989.98',
    baseA9Raw: '9989980000000',
    requiredAssists: 3,
    initBoostBps: 100, // +1%
    maxBoostBps: 800,  // +8%
    maxBoostA9Raw: '799198400000', // 799.1984 A9
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
    baseA9: '19999.98',
    baseA9Raw: '19999980000000',
    requiredAssists: 4,
    initBoostBps: 100, // +1%
    maxBoostBps: 1000, // +10%
    maxBoostA9Raw: '1999998000000', // 1,999.998 A9
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
    baseA9: '40019.98',
    baseA9Raw: '40019980000000',
    requiredAssists: 5,
    initBoostBps: 100, // +1%
    maxBoostBps: 1100, // +11%
    maxBoostA9Raw: '4402197800000', // 4,402.1978 A9
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
    baseA9: '200179.98',
    baseA9Raw: '200179980000000',
    requiredAssists: 6,
    initBoostBps: 100, // +1%
    maxBoostBps: 1200, // +12%
    maxBoostA9Raw: '24021597600000', // 24,021.5976 A9
  },
});

export const CHEST_MALL_NANO_TO_SKU = Object.freeze({
  '990000000': 'chest_bronze',
  '4990000000': 'chest_silver',
  '9990000000': 'chest_gold',
  '19990000000': 'chest_platinum',
  '99990000000': 'chest_diamond',
});

export const FREE_CHEST_CHAIN = Object.freeze([
  {
    key: 'bronze:1',
    tier: 'bronze',
    slotIndex: 1,
    zh: '青铜宝箱 #1',
    en: 'Bronze Chest #1',
    rewardA9Raw: String(300n * A9_RAW),
    requiredAssists: 2,
    minVolumeNano: '0',
    minTgMembers: 0,
    goesToPendingVault: true,
  },
  {
    key: 'bronze:2',
    tier: 'bronze',
    slotIndex: 2,
    zh: '青铜宝箱 #2',
    en: 'Bronze Chest #2',
    rewardA9Raw: String(300n * A9_RAW),
    requiredAssists: 2,
    minVolumeNano: '0',
    minTgMembers: 0,
    goesToPendingVault: true,
  },
  {
    key: 'bronze:3',
    tier: 'bronze',
    slotIndex: 3,
    zh: '青铜宝箱 #3',
    en: 'Bronze Chest #3',
    rewardA9Raw: String(400n * A9_RAW),
    requiredAssists: 2,
    minVolumeNano: '0',
    minTgMembers: 0,
    goesToPendingVault: true,
  },
  {
    key: 'silver:1',
    tier: 'silver',
    slotIndex: 1,
    zh: '白银宝箱',
    en: 'Silver Chest',
    rewardA9Raw: String(10_000n * A9_RAW),
    requiredAssists: 15,
    minVolumeNano: String(50n * TON_NANO),
    minTgMembers: 0,
    goesToPendingVault: false,
  },
  {
    key: 'gold:1',
    tier: 'gold',
    slotIndex: 1,
    zh: '黄金宝箱',
    en: 'Gold Chest',
    rewardA9Raw: String(100_000n * A9_RAW),
    requiredAssists: 160,
    minVolumeNano: String(1_000n * TON_NANO),
    minTgMembers: 100,
    goesToPendingVault: false,
  },
  {
    key: 'platinum:1',
    tier: 'platinum',
    slotIndex: 1,
    zh: '白金宝箱',
    en: 'Platinum Chest',
    rewardA9Raw: String(200_000n * A9_RAW),
    requiredAssists: 400,
    minVolumeNano: String(2_400n * TON_NANO),
    minTgMembers: 300,
    goesToPendingVault: false,
  },
  {
    key: 'diamond:1',
    tier: 'diamond',
    slotIndex: 1,
    zh: '钻石宝箱',
    en: 'Diamond Chest',
    rewardA9Raw: String(1_000_000n * A9_RAW),
    requiredAssists: 2000,
    minVolumeNano: String(12_000n * TON_NANO),
    minTgMembers: 1000,
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

export const CHEST_HOLDING_TIERS = Object.freeze(['bronze', 'silver', 'gold', 'platinum', 'diamond']);

/**
 * 统一统计用户累计持有的 5 种宝箱数量（用于图鉴「宝箱持有」系列解锁）：
 * - FREE_TIER（免费助力链）：仅已开启（OPENED）计入
 * - SHOP_BOOST（商城膨胀箱）：非 CANCELLED 计入，按 orderId 去重
 * - completedShopOrders（含 INSTANT 直接开箱与 BOOST 已成交商城订单）：按 orderId 去重补齐
 */
export function summarizeUserChestHoldings({ freeChests = [], shopChests = [], completedShopOrders = [] } = {}) {
  const counts = { bronze: 0, silver: 0, gold: 0, platinum: 0, diamond: 0 };
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
    labelZh: isWarmup ? `第 ${slot} 轮早鸟预热宝箱` : (spec?.zh || c.tier),
    labelEn: isWarmup ? `R${slot} Early Bird Warm-up Chest` : (spec?.en || c.tier),
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
  constructor() {
    this.chests = new Map(); // chestId -> record
    this.assists = [];       // { chestId, ownerUserId, helperUserId, helperWalletKey, assistDay, boostDeltaRaw, createdAt }
    this.captainBonuses = new Map(); // teamId -> record
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
        status: i === 0 ? 'ACTIVE' : 'LOCKED',
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
    const initBoost = computeShopBoostForAssists(pack, 0);
    const rec = {
      chestId: `ch_${randomHex(6)}`,
      ownerUserId: uid,
      ownerWalletKey: walletAddress ? addressKey(walletAddress) : null,
      source: 'SHOP_BOOST',
      tier: pack.tier,
      slotIndex: 1,
      orderId: String(orderId),
      baseA9Raw: pack.baseA9Raw,
      boostA9Raw: initBoost.toString(),
      maxBoostA9Raw: pack.maxBoostA9Raw,
      requiredAssists: pack.requiredAssists,
      currentAssists: 0,
      status: 'ACTIVE',
      expiresAt: nowSec + SHOP_BOOST_TTL_SEC,
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

    // 病毒自复制闭环：助力者若尚未领取过青铜宝箱，顺手自动激活其青铜宝箱 #1！
    const starter = await this.claimStarterBronzeChests({ userId: hUid, walletAddress: hWallet }, nowSec);

    return {
      chest: formatChestRecord(chest),
      boostDeltaRaw: boostDelta.toString(),
      helperGrantedStarter: starter.created,
      helperBronzeChest: starter.chests[0] || null,
    };
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

    if (chest.source === 'SHOP_BOOST') {
      // 商城膨胀宝箱：24H 内随时可收手开箱，本金已归属买家，开箱仅结算推广池膨胀增量 A9
      rewardRaw = BigInt(chest.boostA9Raw || '0');
      chest.status = 'OPENED';
      chest.openedAt = nowSec;
      chest.updatedAt = nowSec;
      if (rewardRaw > 0n && promoEngine && walletAddress && typeof promoEngine.creditReward === 'function') {
        await promoEngine.creditReward(walletAddress, rewardRaw, nowSec);
      }
    } else if (chest.source === 'WARMUP_ROUND') {
      if (chest.currentAssists < chest.requiredAssists) {
        throw new ChestError('ASSISTS_UNMET', `还需 ${chest.requiredAssists - chest.currentAssists} 位已绑活跃钱包的预热好友方可开启`);
      }
      rewardRaw = BigInt(chest.baseA9Raw || '0') + BigInt(chest.boostA9Raw || '0');
      chest.status = 'OPENED';
      chest.openedAt = nowSec;
      chest.updatedAt = nowSec;
      destination = 'PENDING_VAULT';
      if (rewardRaw > 0n && predictionEngine && typeof predictionEngine.creditPendingBonus === 'function') {
        await predictionEngine.creditPendingBonus(uid, rewardRaw, nowSec * 1000);
      }
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
      chest.status = 'OPENED';
      chest.openedAt = nowSec;
      chest.updatedAt = nowSec;

      if (spec.goesToPendingVault && predictionEngine && typeof predictionEngine.creditPendingBonus === 'function') {
        destination = 'PENDING_VAULT';
        await predictionEngine.creditPendingBonus(uid, rewardRaw, nowSec * 1000);
      } else if (rewardRaw > 0n && promoEngine && walletAddress && typeof promoEngine.creditReward === 'function') {
        destination = 'PROMO_BALANCE';
        await promoEngine.creditReward(walletAddress, rewardRaw, nowSec);
      }

      // 串行激活下一个免费宝箱槽位（青铜 #1 -> #2 -> #3 -> 白银 -> 黄金 -> 白金 -> 钻石）
      const nextSpec = nextFreeChestSpec(chest.tier, chest.slotIndex);
      if (nextSpec) {
        for (const other of this.chests.values()) {
          if (
            other.ownerUserId === uid &&
            other.source === 'FREE_TIER' &&
            other.tier === nextSpec.tier &&
            other.slotIndex === nextSpec.slotIndex &&
            other.status === 'LOCKED'
          ) {
            other.status = 'ACTIVE';
            other.updatedAt = nowSec;
            nextUnlocked = formatChestRecord(other);
            break;
          }
        }
      }
    }

    return {
      chest: formatChestRecord(chest),
      rewardA9Raw: rewardRaw.toString(),
      destination,
      nextUnlocked,
    };
  }

  async grantCaptainFoundingBonus(
    { teamId, captainUserId, captainWallet, tgMemberCount, predictionEngine = null },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    const tId = String(teamId || '').trim();
    const cUid = String(captainUserId || '').trim();
    const count = Number(tgMemberCount || 0);
    if (!tId || !cUid || count < CAPTAIN_MIN_TG_MEMBERS) {
      return { granted: false, reason: 'BELOW_MIN_MEMBERS', amountRaw: '0' };
    }
    if (this.captainBonuses.has(tId)) {
      return { granted: false, reason: 'ALREADY_GRANTED', amountRaw: '0' };
    }
    const rec = {
      teamId: tId,
      captainUserId: cUid,
      captainWalletKey: addressKey(captainWallet || cUid),
      tgMemberCount: count,
      amountRaw: CAPTAIN_FOUNDING_BONUS_RAW.toString(),
      status: 'CREDITED_PENDING',
      createdAt: nowSec,
    };
    this.captainBonuses.set(tId, rec);
    if (predictionEngine && typeof predictionEngine.creditPendingBonus === 'function') {
      await predictionEngine.creditPendingBonus(cUid, CAPTAIN_FOUNDING_BONUS_RAW, nowSec * 1000);
    }
    return { granted: true, amountRaw: rec.amountRaw, bonus: rec };
  }
}
