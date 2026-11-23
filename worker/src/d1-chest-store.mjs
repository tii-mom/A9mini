// A9 Protocol v15 — Cloudflare D1 Persistence Adapter for Unified Chest Mall & Viral Social Assists.
// Mirrors ChestEngine (chest-engine.mjs) 1:1 with atomic D1 db.batch() transitions.
import { addressKey } from './ton-address.mjs';
import { randomHex } from './auth.mjs';
import { utcDayFromSec } from './growth-engine.mjs';
import {
  ChestError,
  CHEST_MALL_CATALOG,
  FREE_CHEST_CHAIN,
  SHOP_BOOST_TTL_SEC,
  MAX_DAILY_ASSISTS_PER_WALLET,
  CAPTAIN_FOUNDING_BONUS_RAW,
  CAPTAIN_MIN_TG_MEMBERS,
  findFreeChestSpec,
  nextFreeChestSpec,
  computeShopBoostForAssists,
  formatChestRecord,
} from './chest-engine.mjs';

const changes = (r) => Number(r?.meta?.changes ?? r?.changes ?? 0);

function rowToChest(r) {
  if (!r) return null;
  return formatChestRecord({
    chestId: String(r.chest_id),
    ownerUserId: String(r.owner_user_id),
    ownerWalletKey: r.owner_wallet_key || null,
    source: String(r.source),
    tier: String(r.tier),
    slotIndex: Number(r.slot_index || 1),
    orderId: r.order_id || null,
    baseA9Raw: String(r.base_a9_raw || '0'),
    boostA9Raw: String(r.boost_a9_raw || '0'),
    maxBoostA9Raw: String(r.max_boost_a9_raw || '0'),
    requiredAssists: Number(r.required_assists || 0),
    currentAssists: Number(r.current_assists || 0),
    status: String(r.status),
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
    openedAt: r.opened_at === null || r.opened_at === undefined ? null : Number(r.opened_at),
    createdAt: Number(r.created_at || 0),
    updatedAt: Number(r.updated_at || 0),
  });
}

export class D1ChestEngine {
  constructor({ db }) {
    if (!db) throw new Error('Cloudflare D1 binding (env.DB) is required');
    this.db = db;
  }

  async claimStarterBronzeChests({ userId, walletAddress = null }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(userId || '').trim();
    if (!uid) throw new ChestError('BAD_REQUEST', 'userId required');
    const walletKey = walletAddress ? addressKey(walletAddress) : null;

    const existing = await this.db
      .prepare("SELECT * FROM user_chests WHERE owner_user_id = ? AND source = 'FREE_TIER' ORDER BY created_at ASC")
      .bind(uid)
      .all();
    if ((existing?.results || []).length > 0) {
      return { created: false, chests: existing.results.map(rowToChest) };
    }

    const stmts = FREE_CHEST_CHAIN.map((spec, idx) =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO user_chests (
             chest_id, owner_user_id, owner_wallet_key, source, tier, slot_index, order_id,
             base_a9_raw, boost_a9_raw, max_boost_a9_raw, required_assists, current_assists,
             status, expires_at, opened_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'FREE_TIER', ?, ?, NULL, ?, '0', '0', ?, 0, ?, NULL, NULL, ?, ?)`,
        )
        .bind(
          `ch_${randomHex(6)}`,
          uid,
          walletKey,
          spec.tier,
          spec.slotIndex,
          spec.rewardA9Raw,
          spec.requiredAssists,
          idx === 0 ? 'ACTIVE' : 'LOCKED',
          nowSec + idx,
          nowSec,
        ),
    );
    const out = await this.db.batch(stmts);
    const createdAny = out.some((r) => changes(r) === 1);
    const rows = await this.db
      .prepare("SELECT * FROM user_chests WHERE owner_user_id = ? AND source = 'FREE_TIER' ORDER BY created_at ASC")
      .bind(uid)
      .all();
    return { created: createdAny, chests: (rows?.results || []).map(rowToChest) };
  }

  async createShopBoostChest({ userId, walletAddress = null, skuId, orderId }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(userId || '').trim();
    const pack = CHEST_MALL_CATALOG[String(skuId || '').trim()];
    if (!uid || !pack || !orderId) throw new ChestError('BAD_REQUEST', 'valid userId, skuId, orderId required');

    const existing = await this.db
      .prepare('SELECT * FROM user_chests WHERE order_id = ? LIMIT 1')
      .bind(String(orderId))
      .first();
    if (existing) return rowToChest(existing);

    const chestId = `ch_${randomHex(6)}`;
    const initBoost = computeShopBoostForAssists(pack, 0);
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO user_chests (
           chest_id, owner_user_id, owner_wallet_key, source, tier, slot_index, order_id,
           base_a9_raw, boost_a9_raw, max_boost_a9_raw, required_assists, current_assists,
           status, expires_at, opened_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'SHOP_BOOST', ?, 1, ?, ?, ?, ?, ?, 0, 'ACTIVE', ?, NULL, ?, ?)`,
      )
      .bind(
        chestId,
        uid,
        walletAddress ? addressKey(walletAddress) : null,
        pack.tier,
        String(orderId),
        pack.baseA9Raw,
        initBoost.toString(),
        pack.maxBoostA9Raw,
        pack.requiredAssists,
        nowSec + SHOP_BOOST_TTL_SEC,
        nowSec,
        nowSec,
      )
      .run();

    const saved = await this.db.prepare('SELECT * FROM user_chests WHERE order_id = ? LIMIT 1').bind(String(orderId)).first();
    return rowToChest(saved);
  }

  async getChest(chestId) {
    const row = await this.db.prepare('SELECT * FROM user_chests WHERE chest_id = ? LIMIT 1').bind(String(chestId || '').trim()).first();
    return rowToChest(row);
  }

  async listUserChests(userId) {
    const uid = String(userId || '').trim();
    const res = await this.db
      .prepare('SELECT * FROM user_chests WHERE owner_user_id = ? ORDER BY created_at ASC')
      .bind(uid)
      .all();
    const all = (res?.results || []).map(rowToChest);
    return {
      freeChests: all.filter((c) => c.source === 'FREE_TIER'),
      shopChests: all.filter((c) => c.source === 'SHOP_BOOST').reverse(),
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

    const chest = await this.getChest(cId);
    if (!chest) throw new ChestError('CHEST_NOT_FOUND', '未找到对应宝箱');
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

    const dupChest = await this.db
      .prepare('SELECT 1 AS hit FROM chest_assists WHERE chest_id = ? AND (helper_wallet_key = ? OR helper_user_id = ?) LIMIT 1')
      .bind(cId, hKey, hUid)
      .first();
    if (dupChest?.hit) throw new ChestError('ALREADY_ASSISTED', '你已经助力过该宝箱');

    const dupPair = await this.db
      .prepare('SELECT 1 AS hit FROM chest_assists WHERE owner_user_id = ? AND helper_wallet_key = ? LIMIT 1')
      .bind(chest.ownerUserId, hKey)
      .first();
    if (dupPair?.hit) throw new ChestError('OWNER_PAIR_LIMIT', '同一钱包终身仅可为同一宝箱主助力 1 次');

    const today = utcDayFromSec(nowSec);
    const dayRow = await this.db
      .prepare('SELECT COUNT(*) AS cnt FROM chest_assists WHERE helper_wallet_key = ? AND assist_day = ?')
      .bind(hKey, today)
      .first();
    if (Number(dayRow?.cnt || 0) >= MAX_DAILY_ASSISTS_PER_WALLET) {
      throw new ChestError('DAILY_ASSIST_LIMIT', `同一钱包每日最多助力 ${MAX_DAILY_ASSISTS_PER_WALLET} 次`);
    }

    const nextAssists = chest.currentAssists + 1;
    let nextBoostStr = chest.boostA9Raw;
    let boostDelta = 0n;
    if (chest.source === 'SHOP_BOOST') {
      const pack = Object.values(CHEST_MALL_CATALOG).find((p) => p.tier === chest.tier);
      const prevBoost = BigInt(chest.boostA9Raw || '0');
      const nextBoost = pack ? computeShopBoostForAssists(pack, nextAssists) : prevBoost;
      boostDelta = nextBoost > prevBoost ? nextBoost - prevBoost : 0n;
      nextBoostStr = nextBoost.toString();
    }
    const nextStatus = nextAssists >= chest.requiredAssists ? 'READY' : chest.status;

    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO chest_assists (chest_id, owner_user_id, helper_user_id, helper_wallet_key, assist_day, boost_delta_raw, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(cId, chest.ownerUserId, hUid, hKey, today, boostDelta.toString(), nowSec),
        this.db
          .prepare(
            `UPDATE user_chests
             SET current_assists = ?, boost_a9_raw = ?, status = ?, updated_at = ?
             WHERE chest_id = ? AND current_assists = ? AND status IN ('ACTIVE', 'READY')`,
          )
          .bind(nextAssists, nextBoostStr, nextStatus, nowSec, cId, chest.currentAssists),
      ]);
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e?.message || e))) {
        throw new ChestError('ALREADY_ASSISTED', '你已经助力过该宝箱或已达助力限制');
      }
      throw e;
    }

    const updated = await this.getChest(cId);
    const starter = await this.claimStarterBronzeChests({ userId: hUid, walletAddress: hWallet }, nowSec);

    return {
      chest: updated,
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
    const chest = await this.getChest(cId);
    if (!chest) throw new ChestError('CHEST_NOT_FOUND', '未找到对应宝箱');
    if (chest.ownerUserId !== uid) throw new ChestError('FORBIDDEN', '只能开启自己的宝箱');
    if (chest.status === 'LOCKED') throw new ChestError('CHEST_LOCKED', '请先开启上一个宝箱后再激活当前宝箱');
    if (chest.status === 'OPENED') throw new ChestError('ALREADY_OPENED', '该宝箱已开启');

    let rewardRaw = 0n;
    let destination = 'PROMO_BALANCE';
    let nextUnlocked = null;

    if (chest.source === 'SHOP_BOOST') {
      rewardRaw = BigInt(chest.boostA9Raw || '0');
      const res = await this.db
        .prepare("UPDATE user_chests SET status = 'OPENED', opened_at = ?, updated_at = ? WHERE chest_id = ? AND status IN ('ACTIVE', 'READY')")
        .bind(nowSec, nowSec, cId)
        .run();
      if (changes(res) !== 1) throw new ChestError('ALREADY_OPENED', '该宝箱已开启');
      if (rewardRaw > 0n && promoEngine && walletAddress && typeof promoEngine.creditReward === 'function') {
        await promoEngine.creditReward(walletAddress, rewardRaw, nowSec);
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
      const stmts = [
        this.db
          .prepare("UPDATE user_chests SET status = 'OPENED', opened_at = ?, updated_at = ? WHERE chest_id = ? AND status IN ('ACTIVE', 'READY')")
          .bind(nowSec, nowSec, cId),
      ];
      const nextSpec = nextFreeChestSpec(chest.tier, chest.slotIndex);
      if (nextSpec) {
        stmts.push(
          this.db
            .prepare(
              `UPDATE user_chests
               SET status = 'ACTIVE', updated_at = ?
               WHERE owner_user_id = ? AND source = 'FREE_TIER' AND tier = ? AND slot_index = ? AND status = 'LOCKED'`,
            )
            .bind(nowSec, uid, nextSpec.tier, nextSpec.slotIndex),
        );
      }
      const out = await this.db.batch(stmts);
      if (changes(out?.[0]) !== 1) throw new ChestError('ALREADY_OPENED', '该宝箱已开启');

      if (spec.goesToPendingVault && predictionEngine && typeof predictionEngine.creditPendingBonus === 'function') {
        destination = 'PENDING_VAULT';
        await predictionEngine.creditPendingBonus(uid, rewardRaw, nowSec * 1000);
      } else if (rewardRaw > 0n && promoEngine && walletAddress && typeof promoEngine.creditReward === 'function') {
        destination = 'PROMO_BALANCE';
        await promoEngine.creditReward(walletAddress, rewardRaw, nowSec);
      }

      if (nextSpec) {
        const nextRow = await this.db
          .prepare("SELECT * FROM user_chests WHERE owner_user_id = ? AND source = 'FREE_TIER' AND tier = ? AND slot_index = ? LIMIT 1")
          .bind(uid, nextSpec.tier, nextSpec.slotIndex)
          .first();
        nextUnlocked = rowToChest(nextRow);
      }
    }

    return {
      chest: await this.getChest(cId),
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
    const res = await this.db
      .prepare(
        `INSERT OR IGNORE INTO captain_founding_bonuses
         (team_id, captain_user_id, captain_wallet_key, tg_member_count, amount_raw, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'CREDITED_PENDING', ?)`,
      )
      .bind(tId, cUid, addressKey(captainWallet || cUid), count, CAPTAIN_FOUNDING_BONUS_RAW.toString(), nowSec)
      .run();
    if (changes(res) !== 1) {
      return { granted: false, reason: 'ALREADY_GRANTED', amountRaw: '0' };
    }
    if (predictionEngine && typeof predictionEngine.creditPendingBonus === 'function') {
      await predictionEngine.creditPendingBonus(cUid, CAPTAIN_FOUNDING_BONUS_RAW, nowSec * 1000);
    }
    return {
      granted: true,
      amountRaw: CAPTAIN_FOUNDING_BONUS_RAW.toString(),
      bonus: {
        teamId: tId,
        captainUserId: cUid,
        tgMemberCount: count,
        amountRaw: CAPTAIN_FOUNDING_BONUS_RAW.toString(),
        createdAt: nowSec,
      },
    };
  }
}
