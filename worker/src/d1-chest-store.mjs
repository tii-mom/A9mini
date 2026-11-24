// A9 Protocol v15 — Cloudflare D1 Persistence Adapter for Unified Chest Mall & Viral Social Assists.
// Mirrors ChestEngine (chest-engine.mjs) 1:1 with atomic D1 db.batch() transitions.
import { addressKey, addressAliases } from './ton-address.mjs';
import { randomHex } from './auth.mjs';
import { utcDayFromSec, VOUCHER_TTL_MS } from './growth-engine.mjs';
import {
  ChestError,
  CHEST_MALL_CATALOG,
  FREE_CHEST_CHAIN,
  SHOP_BOOST_TTL_SEC,
  MAX_DAILY_ASSISTS_PER_WALLET,
  CAPTAIN_FOUNDING_BONUS_RAW,
  CAPTAIN_MIN_TG_MEMBERS,
  CAPTAIN_MIN_TEAM_MEMBERS,
  findFreeChestSpec,
  nextFreeChestSpec,
  computeShopBoostForAssists,
  computeWarmupChestReward,
  rollPaidChestBonusRaw,
  classifyPaidCritTier,
  maskCritActor,
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
  constructor({ db, budgetLedger = null }) {
    if (!db) throw new Error('Cloudflare D1 binding (env.DB) is required');
    this.db = db;
    this.budgetLedger = budgetLedger;
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
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO user_chests (
           chest_id, owner_user_id, owner_wallet_key, source, tier, slot_index, order_id,
           base_a9_raw, boost_a9_raw, max_boost_a9_raw, required_assists, current_assists,
           status, expires_at, opened_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'SHOP_BOOST', ?, 1, ?, ?, '0', ?, 0, 0, 'READY', NULL, NULL, ?, ?)`,
      )
      .bind(
        chestId,
        uid,
        walletAddress ? addressKey(walletAddress) : null,
        pack.tier,
        String(orderId),
        pack.baseA9Raw,
        pack.maxBoostA9Raw,
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

  async ensureWarmupRoundChest({ userId, roundId, walletAddress = null, validInvites = 0, config = {} }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(userId || '').trim();
    const rId = Number(roundId);
    if (!uid || !Number.isInteger(rId) || rId < 1) throw new ChestError('BAD_REQUEST', 'valid userId and roundId required');
    const reward = computeWarmupChestReward(validInvites, config);
    const walletKey = walletAddress ? addressKey(walletAddress) : null;
    const cur = Math.max(0, Number(validInvites || 0));
    const initStatus = cur >= reward.minInvites ? 'READY' : 'ACTIVE';

    const ins = await this.db
      .prepare(
        `INSERT OR IGNORE INTO user_chests (
           chest_id, owner_user_id, owner_wallet_key, source, tier, slot_index, order_id,
           base_a9_raw, boost_a9_raw, max_boost_a9_raw, required_assists, current_assists,
           status, expires_at, opened_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'WARMUP_ROUND', 'warmup', ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .bind(
        `ch_${randomHex(6)}`,
        uid,
        walletKey,
        rId,
        reward.baseA9Raw.toString(),
        reward.boostA9Raw.toString(),
        reward.maxBoostA9Raw.toString(),
        reward.minInvites,
        cur,
        initStatus,
        nowSec,
        nowSec,
      )
      .run();
    const created = changes(ins) === 1;
    if (!created) {
      await this.syncWarmupChestProgress({ userId: uid, roundId: rId, validInvites: cur, walletAddress, config }, nowSec);
    }
    const chest = await this.getWarmupRoundChest(uid, rId);
    return { created, chest };
  }

  async syncWarmupChestProgress({ userId, roundId, validInvites = 0, walletAddress = null, config = {} }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(userId || '').trim();
    const rId = Number(roundId);
    if (!uid || !Number.isInteger(rId) || rId < 1) return null;
    const existing = await this.db
      .prepare("SELECT * FROM user_chests WHERE owner_user_id = ? AND source = 'WARMUP_ROUND' AND slot_index = ? LIMIT 1")
      .bind(uid, rId)
      .first();
    if (!existing) return null;
    const walletKey = walletAddress ? addressKey(walletAddress) : existing.owner_wallet_key;
    if (String(existing.status) === 'OPENED') {
      if (walletKey && !existing.owner_wallet_key) {
        await this.db
          .prepare('UPDATE user_chests SET owner_wallet_key = ?, updated_at = ? WHERE chest_id = ?')
          .bind(walletKey, nowSec, existing.chest_id)
          .run();
      }
      return this.getWarmupRoundChest(uid, rId);
    }
    const cur = Math.max(0, Number(validInvites || 0));
    const reward = computeWarmupChestReward(cur, {
      baseA9Raw: config.baseA9Raw ?? existing.base_a9_raw,
      stepA9Raw: config.stepA9Raw,
      minInvites: config.minInvites ?? existing.required_assists,
      maxInvites: config.maxInvites,
    });
    const nextStatus = cur >= Number(existing.required_assists) ? 'READY' : 'ACTIVE';
    await this.db
      .prepare(
        `UPDATE user_chests
         SET owner_wallet_key = COALESCE(owner_wallet_key, ?),
             current_assists = ?,
             boost_a9_raw = ?,
             status = ?,
             updated_at = ?
         WHERE chest_id = ? AND status != 'OPENED'`,
      )
      .bind(walletKey, cur, reward.boostA9Raw.toString(), nextStatus, nowSec, existing.chest_id)
      .run();
    return this.getWarmupRoundChest(uid, rId);
  }

  async getWarmupRoundChest(userId, roundId) {
    const uid = String(userId || '').trim();
    const rId = Number(roundId);
    const row = await this.db
      .prepare("SELECT * FROM user_chests WHERE owner_user_id = ? AND source = 'WARMUP_ROUND' AND slot_index = ? LIMIT 1")
      .bind(uid, rId)
      .first();
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

    const chest = await this.getChest(cId);
    if (!chest) throw new ChestError('CHEST_NOT_FOUND', '未找到对应宝箱');
    if (chest.source === 'WARMUP_ROUND') {
      throw new ChestError('ASSIST_NOT_ALLOWED', '预热宝箱仅可通过邀请好友预约并绑定活跃钱包解锁');
    }
    if (chest.source === 'SHOP_BOOST') {
      throw new ChestError('ASSIST_NOT_ALLOWED', '付费宝箱无需好友膨胀，购买后可直接开箱触发随机暴击奖励');
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
      // 单事务原子提交：在同一个 db.batch() 内同时校验宝箱状态、每日 3 次上限并推进 current_assists。
      // 若条件不满足，INSERT 与 UPDATE 均命中 0 行，绝不会留下孤儿助力流水或突破每日上限。
      const out = await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO chest_assists (chest_id, owner_user_id, helper_user_id, helper_wallet_key, assist_day, boost_delta_raw, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM user_chests
               WHERE chest_id = ? AND source = 'FREE_TIER' AND current_assists = ? AND current_assists < required_assists AND status IN ('ACTIVE', 'READY')
             )
             AND (SELECT COUNT(*) FROM chest_assists WHERE helper_wallet_key = ? AND assist_day = ?) < ?`,
          )
          .bind(
            cId, chest.ownerUserId, hUid, hKey, today, boostDelta.toString(), nowSec,
            cId, chest.currentAssists,
            hKey, today, MAX_DAILY_ASSISTS_PER_WALLET,
          ),
        this.db
          .prepare(
            `UPDATE user_chests
             SET current_assists = ?, boost_a9_raw = ?, status = ?, updated_at = ?
             WHERE chest_id = ? AND source = 'FREE_TIER' AND current_assists = ? AND current_assists < required_assists AND status IN ('ACTIVE', 'READY')
               AND EXISTS (SELECT 1 FROM chest_assists WHERE chest_id = ? AND helper_wallet_key = ?)`,
          )
          .bind(nextAssists, nextBoostStr, nextStatus, nowSec, cId, chest.currentAssists, cId, hKey),
      ]);
      if (changes(out?.[0]) !== 1 || changes(out?.[1]) !== 1) {
        const latestDay = await this.db
          .prepare('SELECT COUNT(*) AS cnt FROM chest_assists WHERE helper_wallet_key = ? AND assist_day = ?')
          .bind(hKey, today)
          .first();
        if (Number(latestDay?.cnt || 0) >= MAX_DAILY_ASSISTS_PER_WALLET) {
          throw new ChestError('DAILY_ASSIST_LIMIT', `同一钱包每日最多助力 ${MAX_DAILY_ASSISTS_PER_WALLET} 次`);
        }
        const latestChest = await this.getChest(cId);
        if (latestChest && latestChest.currentAssists >= latestChest.requiredAssists) {
          throw new ChestError('ASSIST_FULL', '该宝箱助力人数已满');
        }
        throw new ChestError('CONCURRENT_ASSIST', '宝箱助力状态刚更新，请重试');
      }
    } catch (e) {
      if (e instanceof ChestError) throw e;
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

  /**
   * 原子开箱与 BigInt 精确入账（防同秒并发重复发奖 + 防 SQLite 64 位整数溢出）：
   * 1) 使用每次开箱唯一 openToken 写入 chest_open_credits(chest_id PRIMARY KEY)，物理杜绝同秒并发二次入账；
   * 2) 余额累加完全在 JS BigInt 中以十进制字符串计算，绝不使用 SQLite CAST(... AS INTEGER)；
   * 3) 将余额 CAS 条件写进语句 1（chest_open_credits INSERT）的 WHERE 子句：若并发修改了余额，整批 0 行写入并自动重读重试，绝不丢更新也不卡在 OPENED。
   */
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
    const MAX_CAS_RETRIES = 6;
    let cachedShopRoll = null;

    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const chest = await this.getChest(cId);
      if (!chest) throw new ChestError('CHEST_NOT_FOUND', '未找到对应宝箱');
      if (chest.ownerUserId !== uid) throw new ChestError('FORBIDDEN', '只能开启自己的宝箱');
      if (chest.status === 'LOCKED') throw new ChestError('CHEST_LOCKED', '请先开启上一个宝箱后再激活当前宝箱');
      if (chest.status === 'OPENED') throw new ChestError('ALREADY_OPENED', '该宝箱已开启');

      let rewardRaw = 0n;
      let destination = 'PROMO_BALANCE';
      let nextSpec = null;
      let budgetBucket = 'free_chest_captain';
      let critTier = null;
      let isCrit = false;
      let budgetCapped = false;

      if (chest.source === 'SHOP_BOOST') {
        if (!walletAddress) {
          throw new ChestError('WALLET_REQUIRED', '开启付费宝箱领取随机暴击奖励需绑定钱包地址');
        }
        if (!cachedShopRoll) {
          cachedShopRoll = rollPaidChestBonusRaw(chest.maxBoostA9Raw, randomFn);
        }
        rewardRaw = cachedShopRoll.bonusRaw;
        critTier = cachedShopRoll.critTier;
        isCrit = cachedShopRoll.isCrit;
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

      const openToken = `op_${randomHex(8)}`;
      const rewardStr = rewardRaw.toString();

      let balGuardSql = '';
      let balGuardArgs = [];
      let creditStmt = null;
      let recipientKey = uid;

      if (destination === 'PROMO_BALANCE') {
        const rawAddr = String(walletAddress || '').trim();
        if (!rawAddr) {
          if (rewardRaw > 0n) {
            throw new ChestError('WALLET_REQUIRED', '领取该档位宝箱奖励需绑定钱包地址');
          }
          recipientKey = uid;
        } else {
          const canonicalWalletKey = addressKey(rawAddr);
          let curRow = null;
          if (rewardRaw > 0n) {
            curRow = await this.db
              .prepare('SELECT wallet_address, claimable_raw FROM promo_balances WHERE wallet_address = ? LIMIT 1')
              .bind(canonicalWalletKey)
              .first();
            if (!curRow) {
              const aliases = addressAliases(rawAddr).filter((a) => a !== canonicalWalletKey);
              if (aliases.length) {
                const ph = aliases.map(() => '?').join(', ');
                curRow = await this.db
                  .prepare(`SELECT wallet_address, claimable_raw FROM promo_balances WHERE wallet_address IN (${ph}) LIMIT 1`)
                  .bind(...aliases)
                  .first();
              }
            }
          }
          recipientKey = curRow ? String(curRow.wallet_address) : canonicalWalletKey;
          if (rewardRaw > 0n) {
            if (curRow) {
              const curStr = String(curRow.claimable_raw || '0');
              const nextStr = (BigInt(curStr) + rewardRaw).toString();
              balGuardSql = ' AND EXISTS (SELECT 1 FROM promo_balances WHERE wallet_address = ? AND claimable_raw = ?)';
              balGuardArgs = [recipientKey, curStr];
              creditStmt = this.db
                .prepare(
                  `UPDATE promo_balances
                   SET claimable_raw = ?, updated_at = ?
                   WHERE wallet_address = ? AND claimable_raw = ?
                     AND EXISTS (SELECT 1 FROM chest_open_credits WHERE chest_id = ? AND open_token = ?)`,
                )
                .bind(nextStr, nowSec, recipientKey, curStr, cId, openToken);
            } else {
              balGuardSql = ' AND NOT EXISTS (SELECT 1 FROM promo_balances WHERE wallet_address = ?)';
              balGuardArgs = [recipientKey];
              creditStmt = this.db
                .prepare(
                  `INSERT INTO promo_balances (wallet_address, claimable_raw, total_claimed_raw, updated_at)
                   SELECT ?, ?, '0', ?
                   WHERE EXISTS (SELECT 1 FROM chest_open_credits WHERE chest_id = ? AND open_token = ?)
                     AND NOT EXISTS (SELECT 1 FROM promo_balances WHERE wallet_address = ?)`,
                )
                .bind(recipientKey, rewardStr, nowSec, cId, openToken, recipientKey);
            }
          }
        }
      } else if (rewardRaw > 0n && destination === 'PENDING_VAULT') {
        const curRow = await this.db
          .prepare('SELECT pending_activation_raw, pending_expires_at FROM prediction_rewards WHERE user_id = ? LIMIT 1')
          .bind(recipientKey)
          .first();
        const nowMs = nowSec * 1000;
        const freshExpMs = nowMs + VOUCHER_TTL_MS;
        if (curRow) {
          const curStr = String(curRow.pending_activation_raw || '0');
          const curPending = BigInt(curStr);
          const curExp = curRow.pending_expires_at === null || curRow.pending_expires_at === undefined ? null : Number(curRow.pending_expires_at);
          const isExpired = curPending > 0n && curExp !== null && nowMs > curExp;
          const basePending = isExpired ? 0n : curPending;
          const nextStr = (basePending + rewardRaw).toString();
          const nextExpMs = (basePending > 0n && curExp !== null) ? curExp : freshExpMs;
          balGuardSql = ' AND EXISTS (SELECT 1 FROM prediction_rewards WHERE user_id = ? AND pending_activation_raw = ?)';
          balGuardArgs = [recipientKey, curStr];
          creditStmt = this.db
            .prepare(
              `UPDATE prediction_rewards
               SET pending_activation_raw = ?, pending_expires_at = ?, updated_at = ?
               WHERE user_id = ? AND pending_activation_raw = ?
                 AND EXISTS (SELECT 1 FROM chest_open_credits WHERE chest_id = ? AND open_token = ?)`,
            )
            .bind(nextStr, nextExpMs, nowSec, recipientKey, curStr, cId, openToken);
        } else {
          balGuardSql = ' AND NOT EXISTS (SELECT 1 FROM prediction_rewards WHERE user_id = ?)';
          balGuardArgs = [recipientKey];
          creditStmt = this.db
            .prepare(
              `INSERT INTO prediction_rewards (user_id, pending_activation_raw, activated_raw, pending_expires_at, total_settled, total_won, streak, updated_at)
               SELECT ?, ?, '0', ?, 0, 0, 0, ?
               WHERE EXISTS (SELECT 1 FROM chest_open_credits WHERE chest_id = ? AND open_token = ?)
                 AND NOT EXISTS (SELECT 1 FROM prediction_rewards WHERE user_id = ?)`,
            )
            .bind(recipientKey, rewardStr, freshExpMs, nowSec, cId, openToken, recipientKey);
        }
      }

      let budgetPrep = null;
      let finalRewardRaw = rewardRaw;
      let finalRewardStr = rewardStr;
      let finalCreditStmt = creditStmt;
      let finalBalGuardSql = balGuardSql;
      let finalBalGuardArgs = balGuardArgs;
      if (finalRewardRaw > 0n && budgetLedger && typeof budgetLedger.prepareAtomicReserve === 'function') {
        try {
          budgetPrep = await budgetLedger.prepareAtomicReserve(budgetBucket, finalRewardRaw, nowSec);
        } catch (e) {
          if (chest.source === 'SHOP_BOOST' && e?.code === 'PROMO_BUDGET_EXHAUSTED') {
            finalRewardRaw = 0n;
            finalRewardStr = '0';
            finalCreditStmt = null;
            finalBalGuardSql = '';
            finalBalGuardArgs = [];
            critTier = 'normal';
            isCrit = false;
            budgetCapped = true;
          } else {
            throw e;
          }
        }
      }
      const budgetGuardSql = budgetPrep ? budgetPrep.guardSql : '';
      const budgetGuardArgs = budgetPrep ? budgetPrep.guardArgs : [];
      const nextBoostRawStr = chest.source === 'SHOP_BOOST' ? finalRewardStr : String(chest.boostA9Raw || '0');

      const stmts = [
        this.db
          .prepare(
            `INSERT INTO chest_open_credits (chest_id, recipient_key, destination, amount_raw, open_token, created_at)
             SELECT ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM user_chests
               WHERE chest_id = ?
                 AND status IN ('ACTIVE', 'READY')
                 AND current_assists = ?
                 AND boost_a9_raw = ?
                 AND base_a9_raw = ?
             )
               AND NOT EXISTS (SELECT 1 FROM chest_open_credits WHERE chest_id = ?)${finalBalGuardSql}${budgetGuardSql}`,
          )
          .bind(
            cId, recipientKey, destination, finalRewardStr, openToken, nowSec,
            cId, chest.currentAssists, String(chest.boostA9Raw || '0'), String(chest.baseA9Raw || '0'),
            cId, ...finalBalGuardArgs, ...budgetGuardArgs,
          ),
        this.db
          .prepare(
            `UPDATE user_chests
             SET status = 'OPENED', boost_a9_raw = ?, opened_at = ?, updated_at = ?
             WHERE chest_id = ?
               AND status IN ('ACTIVE', 'READY')
               AND current_assists = ?
               AND boost_a9_raw = ?
               AND base_a9_raw = ?
               AND EXISTS (SELECT 1 FROM chest_open_credits WHERE chest_id = ? AND open_token = ?)`,
          )
          .bind(
            nextBoostRawStr, nowSec, nowSec,
            cId, chest.currentAssists, String(chest.boostA9Raw || '0'), String(chest.baseA9Raw || '0'),
            cId, openToken,
          ),
      ];

      if (nextSpec) {
        stmts.push(
          this.db
            .prepare(
              `UPDATE user_chests
               SET status = 'ACTIVE', updated_at = ?
               WHERE owner_user_id = ? AND source = 'FREE_TIER' AND tier = ? AND slot_index = ? AND status = 'LOCKED'
                 AND EXISTS (SELECT 1 FROM chest_open_credits WHERE chest_id = ? AND open_token = ?)`,
            )
            .bind(nowSec, uid, nextSpec.tier, nextSpec.slotIndex, cId, openToken),
        );
      }
      if (budgetPrep) {
        stmts.push(
          budgetPrep.buildUpdateStmt(
            ' AND EXISTS (SELECT 1 FROM chest_open_credits WHERE chest_id = ? AND open_token = ?)',
            [cId, openToken],
          ),
        );
      }
      if (finalCreditStmt) stmts.push(finalCreditStmt);

      const out = await this.db.batch(stmts);
      if (changes(out?.[0]) === 1) {
        if (finalRewardRaw > 0n) {
          if (destination === 'PENDING_VAULT' && predictionEngine && !predictionEngine.db && typeof predictionEngine.creditPendingBonus === 'function') {
            await predictionEngine.creditPendingBonus(uid, finalRewardRaw, nowSec * 1000);
          } else if (destination === 'PROMO_BALANCE' && promoEngine && !promoEngine.db && walletAddress && typeof promoEngine.creditReward === 'function') {
            await promoEngine.creditReward(walletAddress, finalRewardRaw, nowSec);
          }
        }
        let nextUnlocked = null;
        if (nextSpec) {
          const nextRow = await this.db
            .prepare("SELECT * FROM user_chests WHERE owner_user_id = ? AND source = 'FREE_TIER' AND tier = ? AND slot_index = ? LIMIT 1")
            .bind(uid, nextSpec.tier, nextSpec.slotIndex)
            .first();
          nextUnlocked = rowToChest(nextRow);
        }
        return {
          chest: await this.getChest(cId),
          rewardA9Raw: finalRewardStr,
          destination,
          nextUnlocked,
          critTier,
          isCrit,
          budgetCapped,
        };
      }

      const latest = await this.getChest(cId);
      if (!latest || latest.status === 'OPENED') {
        throw new ChestError('ALREADY_OPENED', '该宝箱已开启');
      }
    }

    throw new ChestError('CONCURRENT_OPEN', '宝箱助力进度或账户余额刚发生并发变动，请重试开箱');
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

    const res = filterTier
      ? await this.db
          .prepare("SELECT chest_id FROM user_chests WHERE owner_user_id = ? AND source = 'SHOP_BOOST' AND status IN ('ACTIVE', 'READY') AND tier = ? ORDER BY created_at ASC")
          .bind(uid, filterTier)
          .all()
      : await this.db
          .prepare("SELECT chest_id FROM user_chests WHERE owner_user_id = ? AND source = 'SHOP_BOOST' AND status IN ('ACTIVE', 'READY') ORDER BY created_at ASC")
          .bind(uid)
          .all();

    const rows = res?.results || [];
    let totalRewardRaw = 0n;
    let totalBaseRaw = 0n;
    let critCount = 0;
    let legendaryCount = 0;
    let budgetCappedCount = 0;
    const results = [];

    for (const row of rows) {
      const opened = await this.openChest(
        {
          chestId: String(row.chest_id),
          userId: uid,
          walletAddress,
          promoEngine,
          budgetLedger,
          randomFn,
        },
        nowSec,
      );
      totalRewardRaw += BigInt(opened.rewardA9Raw || '0');
      totalBaseRaw += BigInt(opened.chest?.baseA9Raw || '0');
      if (opened.isCrit) critCount += 1;
      if (opened.critTier === 'legendary') legendaryCount += 1;
      if (opened.budgetCapped) budgetCappedCount += 1;
      results.push(opened);
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
    const scanLimit = Math.min(150, Math.max(30, safeLimit * 6));
    const res = await this.db
      .prepare(
        `SELECT chest_id, owner_user_id, owner_wallet_key, tier, boost_a9_raw, max_boost_a9_raw, opened_at, updated_at
         FROM user_chests
         WHERE source = 'SHOP_BOOST' AND status = 'OPENED' AND boost_a9_raw != '0'
         ORDER BY opened_at DESC, updated_at DESC
         LIMIT ?`,
      )
      .bind(scanLimit)
      .all();
    const items = [];
    for (const r of res?.results || []) {
      const { critTier, isCrit, ratioBps } = classifyPaidCritTier(r.boost_a9_raw, r.max_boost_a9_raw);
      if (!isCrit) continue;
      const tier = String(r.tier || '');
      const spec = Object.values(CHEST_MALL_CATALOG).find((p) => p.tier === tier) || null;
      items.push({
        chestId: String(r.chest_id),
        actor: maskCritActor(r.owner_user_id, r.owner_wallet_key),
        tier,
        labelZh: spec?.zh || tier,
        labelEn: spec?.en || tier,
        boostA9Raw: String(r.boost_a9_raw || '0'),
        maxBoostA9Raw: String(r.max_boost_a9_raw || '0'),
        critTier,
        ratioBps,
        openedAt: Number(r.opened_at || r.updated_at || 0),
      });
      if (items.length >= safeLimit) break;
    }
    return items;
  }

  /**
   * 原子发放队长创世金库（5,000 A9 待激活）：
   * 在同一 db.batch() 事务内以唯一 grant_token 写入 captain_founding_bonuses 并以 BigInt CAS 累加 prediction_rewards；
   * 若待激活金库写入失败，整批回滚，不会留下孤立的 CREDITED_PENDING 记录，后续可安全重试且全局只发一次。
   */
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

    const amountStr = CAPTAIN_FOUNDING_BONUS_RAW.toString();
    const walletKey = addressKey(captainWallet || cUid);
    const MAX_CAS_RETRIES = 6;

    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const existing = chatId
        ? await this.db
            .prepare('SELECT team_id FROM captain_founding_bonuses WHERE team_id = ? OR captain_user_id = ? OR captain_wallet_key = ? OR tg_chat_id = ? LIMIT 1')
            .bind(tId, cUid, walletKey, chatId)
            .first()
        : await this.db
            .prepare('SELECT team_id FROM captain_founding_bonuses WHERE team_id = ? OR captain_user_id = ? OR captain_wallet_key = ? LIMIT 1')
            .bind(tId, cUid, walletKey)
            .first();
      if (existing) {
        return { granted: false, reason: 'ALREADY_GRANTED', amountRaw: '0' };
      }

      let budgetPrep = null;
      if (budgetLedger && typeof budgetLedger.prepareAtomicReserve === 'function') {
        budgetPrep = await budgetLedger.prepareAtomicReserve('free_chest_captain', CAPTAIN_FOUNDING_BONUS_RAW, nowSec);
      }
      const budgetGuardSql = budgetPrep ? budgetPrep.guardSql : '';
      const budgetGuardArgs = budgetPrep ? budgetPrep.guardArgs : [];

      const grantToken = `cg_${randomHex(8)}`;
      const nowMs = nowSec * 1000;
      const freshExpMs = nowMs + VOUCHER_TTL_MS;
      const curRow = await this.db
        .prepare('SELECT pending_activation_raw, pending_expires_at FROM prediction_rewards WHERE user_id = ? LIMIT 1')
        .bind(cUid)
        .first();

      let balGuardSql = '';
      let balGuardArgs = [];
      let creditStmt = null;

      if (curRow) {
        const curStr = String(curRow.pending_activation_raw || '0');
        const curPending = BigInt(curStr);
        const curExp = curRow.pending_expires_at === null || curRow.pending_expires_at === undefined ? null : Number(curRow.pending_expires_at);
        const isExpired = curPending > 0n && curExp !== null && nowMs > curExp;
        const basePending = isExpired ? 0n : curPending;
        const nextStr = (basePending + CAPTAIN_FOUNDING_BONUS_RAW).toString();
        const nextExpMs = (basePending > 0n && curExp !== null) ? curExp : freshExpMs;
        balGuardSql = ' AND EXISTS (SELECT 1 FROM prediction_rewards WHERE user_id = ? AND pending_activation_raw = ?)';
        balGuardArgs = [cUid, curStr];
        creditStmt = this.db
          .prepare(
            `UPDATE prediction_rewards
             SET pending_activation_raw = ?, pending_expires_at = ?, updated_at = ?
             WHERE user_id = ? AND pending_activation_raw = ?
               AND EXISTS (SELECT 1 FROM captain_founding_bonuses WHERE team_id = ? AND grant_token = ?)`,
          )
          .bind(nextStr, nextExpMs, nowSec, cUid, curStr, tId, grantToken);
      } else {
        balGuardSql = ' AND NOT EXISTS (SELECT 1 FROM prediction_rewards WHERE user_id = ?)';
        balGuardArgs = [cUid];
        creditStmt = this.db
          .prepare(
            `INSERT INTO prediction_rewards (user_id, pending_activation_raw, activated_raw, pending_expires_at, total_settled, total_won, streak, updated_at)
             SELECT ?, ?, '0', ?, 0, 0, 0, ?
             WHERE EXISTS (SELECT 1 FROM captain_founding_bonuses WHERE team_id = ? AND grant_token = ?)
               AND NOT EXISTS (SELECT 1 FROM prediction_rewards WHERE user_id = ?)`,
          )
          .bind(cUid, amountStr, freshExpMs, nowSec, tId, grantToken, cUid);
      }

      const dedupWhere = chatId
        ? 'NOT EXISTS (SELECT 1 FROM captain_founding_bonuses WHERE team_id = ? OR captain_user_id = ? OR captain_wallet_key = ? OR tg_chat_id = ?)'
        : 'NOT EXISTS (SELECT 1 FROM captain_founding_bonuses WHERE team_id = ? OR captain_user_id = ? OR captain_wallet_key = ?)';
      const dedupArgs = chatId ? [tId, cUid, walletKey, chatId] : [tId, cUid, walletKey];

      const batchStmts = [
        this.db
          .prepare(
            `INSERT INTO captain_founding_bonuses
               (team_id, captain_user_id, captain_wallet_key, tg_chat_id, tg_member_count, amount_raw, grant_token, status, created_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, 'CREDITED_PENDING', ?
             WHERE ${dedupWhere}${balGuardSql}${budgetGuardSql}`,
          )
          .bind(tId, cUid, walletKey, chatId, count, amountStr, grantToken, nowSec, ...dedupArgs, ...balGuardArgs, ...budgetGuardArgs),
        creditStmt,
      ];
      if (budgetPrep) {
        batchStmts.push(
          budgetPrep.buildUpdateStmt(
            ' AND EXISTS (SELECT 1 FROM captain_founding_bonuses WHERE team_id = ? AND grant_token = ?)',
            [tId, grantToken],
          ),
        );
      }

      let out;
      try {
        out = await this.db.batch(batchStmts);
      } catch (e) {
        if (/UNIQUE|constraint/i.test(String(e?.message || e))) {
          return { granted: false, reason: 'ALREADY_GRANTED', amountRaw: '0' };
        }
        throw e;
      }

      if (changes(out?.[0]) === 1) {
        if (predictionEngine && !predictionEngine.db && typeof predictionEngine.creditPendingBonus === 'function') {
          await predictionEngine.creditPendingBonus(cUid, CAPTAIN_FOUNDING_BONUS_RAW, nowSec * 1000);
        }
        return {
          granted: true,
          amountRaw: amountStr,
          bonus: {
            teamId: tId,
            captainUserId: cUid,
            tgChatId: chatId,
            tgMemberCount: count,
            amountRaw: amountStr,
            createdAt: nowSec,
          },
        };
      }

      const after = chatId
        ? await this.db
            .prepare('SELECT team_id FROM captain_founding_bonuses WHERE team_id = ? OR captain_user_id = ? OR captain_wallet_key = ? OR tg_chat_id = ? LIMIT 1')
            .bind(tId, cUid, walletKey, chatId)
            .first()
        : await this.db
            .prepare('SELECT team_id FROM captain_founding_bonuses WHERE team_id = ? OR captain_user_id = ? OR captain_wallet_key = ? LIMIT 1')
            .bind(tId, cUid, walletKey)
            .first();
      if (after) {
        return { granted: false, reason: 'ALREADY_GRANTED', amountRaw: '0' };
      }
    }

    throw new ChestError('CONCURRENT_GRANT', '待激活金库余额刚发生并发变动，请重试发放队长创世金库');
  }
}
