// A9 Protocol v15 — Cloudflare D1 Persistence Adapters for Social, Prediction & Presale.
// Matches worker/schema.sql tables and mirrors the in-memory engine interfaces 1:1.
import { randomBytes } from 'node:crypto';
import { rewardForWarmupRank } from './social-store.mjs';
import { GrowthError, VOUCHER_TTL_MS } from './growth-engine.mjs';
import {
  PRESALE_STATUS,
  PresaleError,
  TON_NANO,
  A9_RAW,
  REFERRAL_BPS,
} from './presale-hotwallet.mjs';

// ---------------------------------------------------------------------------
// 1. D1SocialStore (referrals, warmup_registrations, team_groups, team_members)
// ---------------------------------------------------------------------------
export class D1SocialStore {
  constructor({ db }) {
    if (!db) throw new Error('Cloudflare D1 binding (env.DB) is required');
    this.db = db;
  }

  async getReferrer(subjectKey) {
    const subj = String(subjectKey || '').trim();
    if (!subj) return null;
    const row = await this.db
      .prepare('SELECT referrer_id FROM referrals WHERE subject_key = ?')
      .bind(subj)
      .first();
    return row ? String(row.referrer_id) : null;
  }

  async bindReferral(subjectKey, referrerId, nowSec = Math.floor(Date.now() / 1000)) {
    const subj = String(subjectKey || '').trim();
    const ref = String(referrerId || '').trim();
    if (!subj || !ref || subj === ref) return null;

    const existing = await this.db
      .prepare('SELECT subject_key, referrer_id, bound_at FROM referrals WHERE subject_key = ?')
      .bind(subj)
      .first();
    if (existing) {
      return {
        subjectKey: existing.subject_key,
        referrerId: existing.referrer_id,
        boundAt: Number(existing.bound_at),
      };
    }

    // Anti-cycle walk up to depth 8
    let cursor = ref;
    for (let depth = 0; depth < 8 && cursor; depth += 1) {
      const parent = await this.getReferrer(cursor);
      if (!parent) break;
      if (parent === subj) return null;
      cursor = parent;
    }

    await this.db
      .prepare('INSERT INTO referrals (subject_key, referrer_id, bound_at) VALUES (?, ?, ?)')
      .bind(subj, ref, nowSec)
      .run();
    return { subjectKey: subj, referrerId: ref, boundAt: nowSec };
  }

  async registerWarmup(
    { roundId = 1, walletAddress, referrerWallet = null, referrerId = null },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    if (!walletAddress) throw new Error('walletAddress required');
    const rId = Number(roundId);
    const rawRef = String(referrerId || referrerWallet || '').trim() || null;
    if (rawRef) await this.bindReferral(walletAddress, rawRef, nowSec);
    const effectiveRef = await this.getReferrer(walletAddress);

    const existing = await this.db
      .prepare('SELECT * FROM warmup_registrations WHERE round_id = ? AND wallet_address = ?')
      .bind(rId, walletAddress)
      .first();
    if (existing && existing.status === 'ACTIVE') {
      return this._formatWarmup(existing);
    }

    const validInvites = existing ? Number(existing.valid_invites) : 0;
    const createdAt = existing ? Number(existing.created_at) : nowSec;
    const refToStore = effectiveRef && effectiveRef !== walletAddress ? effectiveRef : null;

    await this.db
      .prepare(
        `INSERT INTO warmup_registrations
         (round_id, wallet_address, referrer_wallet, valid_invites, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
         ON CONFLICT(round_id, wallet_address) DO UPDATE SET
           referrer_wallet = excluded.referrer_wallet,
           status = 'ACTIVE',
           updated_at = excluded.updated_at`,
      )
      .bind(rId, walletAddress, refToStore, validInvites, createdAt, nowSec)
      .run();

    if (refToStore) {
      await this.db
        .prepare(
          `UPDATE warmup_registrations
           SET valid_invites = valid_invites + 1, updated_at = ?
           WHERE round_id = ? AND wallet_address = ? AND status = 'ACTIVE'`,
        )
        .bind(nowSec, rId, refToStore)
        .run();
    }

    return {
      roundId: rId,
      walletAddress,
      referrerWallet: refToStore,
      validInvites,
      status: 'ACTIVE',
      createdAt,
      updatedAt: nowSec,
    };
  }

  async cancelWarmup({ roundId = 1, walletAddress }, nowSec = Math.floor(Date.now() / 1000)) {
    const rId = Number(roundId);
    const existing = await this.db
      .prepare('SELECT * FROM warmup_registrations WHERE round_id = ? AND wallet_address = ?')
      .bind(rId, walletAddress)
      .first();
    if (!existing) return null;
    await this.db
      .prepare("UPDATE warmup_registrations SET status = 'CANCELLED', updated_at = ? WHERE round_id = ? AND wallet_address = ?")
      .bind(nowSec, rId, walletAddress)
      .run();
    return { ...this._formatWarmup(existing), status: 'CANCELLED', updatedAt: nowSec };
  }

  async getWarmupLeaderboard(roundId = 1, limit = 50) {
    const res = await this.db
      .prepare(
        `SELECT wallet_address, valid_invites FROM warmup_registrations
         WHERE round_id = ? AND status = 'ACTIVE'
         ORDER BY valid_invites DESC, created_at ASC LIMIT ?`,
      )
      .bind(Number(roundId), Number(limit))
      .all();
    return (res?.results || []).map((r, i) => ({
      rank: i + 1,
      walletAddress: r.wallet_address,
      validInvites: Number(r.valid_invites),
      estRewardA9: rewardForWarmupRank(i + 1),
    }));
  }

  async createOrBindTeamGroup({ teamId, name, captainWallet, tgGroupHandle, tgChatId = null }, nowSec = Math.floor(Date.now() / 1000)) {
    if (!teamId || !captainWallet) throw new Error('teamId and captainWallet required');
    const cur = await this.db.prepare('SELECT * FROM team_groups WHERE team_id = ?').bind(teamId).first();
    if (cur && cur.captain_wallet !== captainWallet) {
      throw new Error('only captain can bind TG group');
    }
    const nextName = name || cur?.name || teamId;
    const nextHandle = tgGroupHandle || cur?.tg_group_handle || null;
    const nextChatId = tgGroupHandle ? tgChatId : (cur?.tg_chat_id || null);
    const nextStatus = tgGroupHandle ? 'bound' : (cur?.bind_status || 'unbound');
    const createdAt = cur ? Number(cur.created_at) : nowSec;
    const memberCount = cur ? Number(cur.member_count) : 1;

    await this.db
      .prepare(
        `INSERT INTO team_groups
         (team_id, name, captain_wallet, tg_group_handle, tg_chat_id, bind_status, member_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id) DO UPDATE SET
           name = excluded.name,
           tg_group_handle = excluded.tg_group_handle,
           tg_chat_id = excluded.tg_chat_id,
           bind_status = excluded.bind_status,
           updated_at = excluded.updated_at`,
      )
      .bind(teamId, nextName, captainWallet, nextHandle, nextChatId, nextStatus, memberCount, createdAt, nowSec)
      .run();

    await this.db
      .prepare('INSERT OR IGNORE INTO team_members (wallet_address, team_id, joined_at) VALUES (?, ?, ?)')
      .bind(captainWallet, teamId, nowSec)
      .run();

    return {
      teamId,
      name: nextName,
      captainWallet,
      tgGroupHandle: nextHandle,
      tgChatId: nextChatId,
      bindStatus: nextStatus,
      memberCount,
      createdAt,
      updatedAt: nowSec,
    };
  }

  async joinTeam({ teamId, walletAddress, referrerId = null }, nowSec = Math.floor(Date.now() / 1000)) {
    const team = await this.db.prepare('SELECT * FROM team_groups WHERE team_id = ?').bind(teamId).first();
    if (!team) throw new Error(`team ${teamId} not found`);
    if (referrerId) await this.bindReferral(walletAddress, referrerId, nowSec);

    await this.db
      .prepare('INSERT OR REPLACE INTO team_members (wallet_address, team_id, joined_at) VALUES (?, ?, ?)')
      .bind(walletAddress, teamId, nowSec)
      .run();
    const cntRow = await this.db
      .prepare('SELECT COUNT(*) AS cnt FROM team_members WHERE team_id = ?')
      .bind(teamId)
      .first();
    const memberCount = Number(cntRow?.cnt || 1);
    await this.db
      .prepare('UPDATE team_groups SET member_count = ?, updated_at = ? WHERE team_id = ?')
      .bind(memberCount, nowSec, teamId)
      .run();

    return {
      teamId: team.team_id,
      name: team.name,
      captainWallet: team.captain_wallet,
      tgGroupHandle: team.tg_group_handle || null,
      tgChatId: team.tg_chat_id || null,
      bindStatus: team.bind_status,
      memberCount,
      createdAt: Number(team.created_at),
      updatedAt: nowSec,
    };
  }

  async getTeamByWallet(walletAddress) {
    const mem = await this.db
      .prepare('SELECT team_id FROM team_members WHERE wallet_address = ?')
      .bind(walletAddress)
      .first();
    if (!mem) return null;
    const t = await this.db.prepare('SELECT * FROM team_groups WHERE team_id = ?').bind(mem.team_id).first();
    if (!t) return null;
    return {
      teamId: t.team_id,
      name: t.name,
      captainWallet: t.captain_wallet,
      tgGroupHandle: t.tg_group_handle || null,
      tgChatId: t.tg_chat_id || null,
      bindStatus: t.bind_status,
      memberCount: Number(t.member_count),
      createdAt: Number(t.created_at),
      updatedAt: Number(t.updated_at),
    };
  }

  _formatWarmup(r) {
    return {
      roundId: Number(r.round_id),
      walletAddress: r.wallet_address,
      referrerWallet: r.referrer_wallet || null,
      validInvites: Number(r.valid_invites),
      status: r.status,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
}

// ---------------------------------------------------------------------------
// 2. D1PredictionEngine (prediction_rounds, prediction_bets, prediction_rewards)
// ---------------------------------------------------------------------------
export class D1PredictionEngine {
  constructor({ db, defaultPoolA9Raw = '1000000000000000' }) {
    if (!db) throw new Error('Cloudflare D1 binding (env.DB) is required');
    this.db = db;
    this.defaultPoolA9Raw = BigInt(defaultPoolA9Raw);
  }

  async placeBet({ roundId, userId, side, guessSlots = null, referrerId = null }, nowSec = Math.floor(Date.now() / 1000)) {
    const rId = Number(roundId);
    const uid = String(userId || '').trim();
    const normSide = String(side || '').toUpperCase();
    if (!uid || !Number.isInteger(rId) || rId < 1) throw new GrowthError('BAD_REQUEST', 'valid roundId and userId required');
    if (normSide !== 'PASS' && normSide !== 'BURN') throw new GrowthError('BAD_REQUEST', 'side must be PASS or BURN');

    const settled = await this.db
      .prepare('SELECT winning_side FROM prediction_rounds WHERE round_id = ?')
      .bind(rId)
      .first();
    if (settled) throw new GrowthError('ROUND_SETTLED', `round ${rId} prediction already settled`);

    const existing = await this.db
      .prepare('SELECT user_id FROM prediction_bets WHERE round_id = ? AND user_id = ?')
      .bind(rId, uid)
      .first();
    if (existing) throw new GrowthError('ALREADY_BET', 'user already placed a prediction for this round');

    const slots = guessSlots === null || guessSlots === undefined ? null : Number(guessSlots);
    if (slots !== null && (!Number.isInteger(slots) || slots < 0 || slots > 24)) {
      throw new GrowthError('BAD_REQUEST', 'guessSlots must be 0..24');
    }

    const cleanRef = referrerId && String(referrerId).trim() !== uid ? String(referrerId).trim() : null;
    await this.db
      .prepare(
        `INSERT INTO prediction_bets (round_id, user_id, side, guess_slots, referrer_id, status, reward_raw, created_at)
         VALUES (?, ?, ?, ?, ?, 'OPEN', '0', ?)`,
      )
      .bind(rId, uid, normSide, slots, cleanRef, nowSec)
      .run();

    return {
      roundId: rId,
      userId: uid,
      side: normSide,
      guessSlots: slots,
      referrerId: cleanRef,
      status: 'OPEN',
      rewardRaw: '0',
      createdAt: nowSec,
    };
  }

  async getInviteBoostCount(roundId, userId) {
    if (!roundId || !userId) return 0;
    const row = await this.db
      .prepare('SELECT COUNT(DISTINCT user_id) AS cnt FROM prediction_bets WHERE round_id = ? AND referrer_id = ?')
      .bind(Number(roundId), String(userId).trim())
      .first();
    return Math.min(5, Number(row?.cnt || 0));
  }

  async getRoundStats(roundId) {
    const rId = Number(roundId);
    const rows = await this.db
      .prepare('SELECT side FROM prediction_bets WHERE round_id = ?')
      .bind(rId)
      .all();
    let passCount = 0;
    let burnCount = 0;
    for (const r of rows?.results || []) {
      if (r.side === 'PASS') passCount += 1;
      else burnCount += 1;
    }
    const total = passCount + burnCount;
    const pr = await this.db
      .prepare('SELECT winning_side FROM prediction_rounds WHERE round_id = ?')
      .bind(rId)
      .first();
    const winningSide = pr ? String(pr.winning_side) : null;
    return {
      roundId: rId,
      passCount,
      burnCount,
      total,
      passPct: total > 0 ? Math.round((passCount / total) * 100) : 50,
      burnPct: total > 0 ? Math.round((burnCount / total) * 100) : 50,
      settled: winningSide !== null,
      winningSide,
    };
  }

  async settleRoundBets(roundId, passed, actualQualified, poolA9Raw = this.defaultPoolA9Raw, nowMs = Date.now()) {
    const rId = Number(roundId);
    const already = await this.db
      .prepare('SELECT winning_side FROM prediction_rounds WHERE round_id = ?')
      .bind(rId)
      .first();
    if (already) throw new GrowthError('ROUND_SETTLED', `round ${rId} already settled`);

    const winSide = passed ? 'PASS' : 'BURN';
    const pool = BigInt(poolA9Raw);
    const nowSec = Math.floor(nowMs / 1000);

    const betsRes = await this.db
      .prepare('SELECT * FROM prediction_bets WHERE round_id = ?')
      .bind(rId)
      .all();
    const bets = betsRes?.results || [];

    const winners = [];
    let totalWeight = 0n;

    for (const b of bets) {
      const st = await this._getUserStatsRow(b.user_id);
      const nextSettled = st.totalSettled + 1;
      if (b.side === winSide) {
        const exactBoost = b.guess_slots !== null && Number(b.guess_slots) === Number(actualQualified) ? 5n : 0n;
        const inviteBoost = BigInt(await this.getInviteBoostCount(rId, b.user_id));
        const rawW = 10n + exactBoost + inviteBoost;
        const weight = rawW > 20n ? 20n : rawW;
        winners.push({ bet: b, weight, st: { ...st, totalSettled: nextSettled, totalWon: st.totalWon + 1, streak: st.streak + 1 } });
        totalWeight += weight;
      } else {
        await this.db
          .prepare("UPDATE prediction_bets SET status = 'LOST', reward_raw = '0' WHERE round_id = ? AND user_id = ?")
          .bind(rId, b.user_id)
          .run();
        await this._upsertUserStats(b.user_id, { ...st, totalSettled: nextSettled, streak: 0 }, nowSec);
      }
    }

    let distributed = 0n;
    const expiresAt = nowMs + VOUCHER_TTL_MS;
    for (const { bet, weight, st } of winners) {
      const amt = totalWeight > 0n ? (pool * weight) / totalWeight : 0n;
      distributed += amt;
      await this.db
        .prepare("UPDATE prediction_bets SET status = 'WON_PENDING_ACTIVATION', reward_raw = ? WHERE round_id = ? AND user_id = ?")
        .bind(amt.toString(), rId, bet.user_id)
        .run();
      await this._upsertUserStats(
        bet.user_id,
        {
          ...st,
          pendingActivationRaw: st.pendingActivationRaw + amt,
          pendingExpiresAt: expiresAt,
        },
        nowSec,
      );
    }

    await this.db
      .prepare('INSERT INTO prediction_rounds (round_id, winning_side, actual_qualified, settled_at) VALUES (?, ?, ?, ?)')
      .bind(rId, winSide, Number(actualQualified), nowSec)
      .run();

    return { roundId: rId, winSide, winnersCount: winners.length, distributedRaw: distributed.toString() };
  }

  async activateToPromo(userId, walletAddress, promoEngine, { qualified = false, nowMs = Date.now() } = {}) {
    const uid = String(userId || '').trim();
    if (qualified !== true) {
      throw new GrowthError(
        'ACTIVATION_REQUIREMENT_UNMET',
        '请先完成至少 1 笔内盘买币（5 GRAM 起）或链上质押后再激活',
      );
    }

    const st = await this._getUserStatsRow(uid);
    if (st.pendingActivationRaw <= 0n) {
      return { userId: uid, walletAddress, activatedRaw: '0' };
    }

    const nowSec = Math.floor(nowMs / 1000);
    if (st.pendingExpiresAt !== null && nowMs > st.pendingExpiresAt) {
      await this._upsertUserStats(uid, { ...st, pendingActivationRaw: 0n, pendingExpiresAt: null }, nowSec);
      throw new GrowthError('VOUCHER_EXPIRED', '待激活预言奖励已过期');
    }

    const amt = st.pendingActivationRaw;
    await this._upsertUserStats(
      uid,
      {
        ...st,
        pendingActivationRaw: 0n,
        activatedRaw: st.activatedRaw + amt,
        pendingExpiresAt: null,
      },
      nowSec,
    );

    if (promoEngine && typeof promoEngine.creditReward === 'function') {
      await promoEngine.creditReward(walletAddress, amt, nowSec);
    }
    return { userId: uid, walletAddress, activatedRaw: amt.toString() };
  }

  async getUserSummary(userId, roundId = null) {
    const uid = String(userId || '').trim();
    const st = await this._getUserStatsRow(uid);
    let currentBet = null;
    if (roundId) {
      const row = await this.db
        .prepare('SELECT * FROM prediction_bets WHERE round_id = ? AND user_id = ?')
        .bind(Number(roundId), uid)
        .first();
      if (row) {
        currentBet = {
          roundId: Number(row.round_id),
          userId: row.user_id,
          side: row.side,
          guessSlots: row.guess_slots === null || row.guess_slots === undefined ? null : Number(row.guess_slots),
          referrerId: row.referrer_id || null,
          status: row.status,
          rewardRaw: String(row.reward_raw),
          createdAt: Number(row.created_at),
        };
      }
    }
    const inviteBoostCount = roundId ? await this.getInviteBoostCount(roundId, uid) : 0;
    const winRate = st.totalSettled > 0 ? Math.round((st.totalWon / st.totalSettled) * 100) : null;
    return {
      userId: uid,
      pendingActivationRaw: st.pendingActivationRaw.toString(),
      activatedRaw: st.activatedRaw.toString(),
      currentBet,
      streak: st.streak,
      winRate,
      inviteBoostCount,
      pendingExpiresAt: st.pendingExpiresAt,
    };
  }

  async _getUserStatsRow(uid) {
    const row = await this.db
      .prepare('SELECT * FROM prediction_rewards WHERE user_id = ?')
      .bind(uid)
      .first();
    if (!row) {
      return {
        pendingActivationRaw: 0n,
        activatedRaw: 0n,
        pendingExpiresAt: null,
        totalSettled: 0,
        totalWon: 0,
        streak: 0,
      };
    }
    return {
      pendingActivationRaw: BigInt(row.pending_activation_raw || '0'),
      activatedRaw: BigInt(row.activated_raw || '0'),
      pendingExpiresAt: row.pending_expires_at === null || row.pending_expires_at === undefined ? null : Number(row.pending_expires_at),
      totalSettled: Number(row.total_settled || 0),
      totalWon: Number(row.total_won || 0),
      streak: Number(row.streak || 0),
    };
  }

  async _upsertUserStats(uid, st, nowSec) {
    await this.db
      .prepare(
        `INSERT INTO prediction_rewards
         (user_id, pending_activation_raw, activated_raw, pending_expires_at, total_settled, total_won, streak, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           pending_activation_raw = excluded.pending_activation_raw,
           activated_raw = excluded.activated_raw,
           pending_expires_at = excluded.pending_expires_at,
           total_settled = excluded.total_settled,
           total_won = excluded.total_won,
           streak = excluded.streak,
           updated_at = excluded.updated_at`,
      )
      .bind(
        uid,
        st.pendingActivationRaw.toString(),
        st.activatedRaw.toString(),
        st.pendingExpiresAt,
        st.totalSettled,
        st.totalWon,
        st.streak,
        nowSec,
      )
      .run();
  }
}

// ---------------------------------------------------------------------------
// 3. D1PresaleStore (presale_orders)
// ---------------------------------------------------------------------------
export class D1PresaleStore {
  constructor({
    db,
    hotWalletAddress,
    rateA9PerTon = 2002n,
    minOrderTon = 5n,
    maxOrderTon = 200n,
    defaultQuotaTon = 200n,
    totalCapA9Raw = 200_000_000n * A9_RAW,
    open = true,
    promoEngine = null,
    socialStore = null,
  }) {
    if (!db) throw new PresaleError('DB_MISSING', 'Cloudflare D1 binding (env.DB) is required');
    if (!hotWalletAddress) throw new PresaleError('CONFIG_MISSING', 'presale hotWalletAddress required');
    this.db = db;
    this.hotWalletAddress = hotWalletAddress;
    this.rateA9PerTon = BigInt(rateA9PerTon);
    this.minOrderNano = BigInt(minOrderTon) * TON_NANO;
    this.maxOrderNano = BigInt(maxOrderTon) * TON_NANO;
    this.defaultQuotaNano = BigInt(defaultQuotaTon) * TON_NANO;
    this.totalCapA9Raw = BigInt(totalCapA9Raw);
    this.open = Boolean(open);
    this.promoEngine = promoEngine;
    this.socialStore = socialStore;
  }

  async _getUsage(walletAddress) {
    const paidAll = await this.db
      .prepare("SELECT wallet_address, ton_nano, a9_amount_raw FROM presale_orders WHERE status = 'PAID_A9'")
      .all();
    let soldA9Raw = 0n;
    let userUsedNano = 0n;
    for (const r of paidAll?.results || []) {
      soldA9Raw += BigInt(r.a9_amount_raw || '0');
      if (r.wallet_address === walletAddress) {
        userUsedNano += BigInt(r.ton_nano || '0');
      }
    }
    return { soldA9Raw, userUsedNano };
  }

  async getQuota(walletAddress) {
    const { soldA9Raw, userUsedNano } = await this._getUsage(walletAddress);
    const availNano = this.defaultQuotaNano > userUsedNano ? this.defaultQuotaNano - userUsedNano : 0n;
    const remPool = this.totalCapA9Raw > soldA9Raw ? this.totalCapA9Raw - soldA9Raw : 0n;
    return {
      walletAddress,
      rateA9PerTon: Number(this.rateA9PerTon),
      open: this.open,
      soldOut: soldA9Raw >= this.totalCapA9Raw,
      remainingPoolA9Raw: remPool.toString(),
      unlockedQuotaTon: Number(this.defaultQuotaNano / TON_NANO),
      usedQuotaTon: Number(userUsedNano / TON_NANO),
      availQuotaTon: Number(availNano / TON_NANO),
      minOrderTon: Number(this.minOrderNano / TON_NANO),
      maxOrderTon: Number(this.maxOrderNano / TON_NANO),
      payTo: this.hotWalletAddress,
    };
  }

  async createOrderIntent(walletAddress, tonAmount, nowSec = Math.floor(Date.now() / 1000), { referrerId = null } = {}) {
    if (!walletAddress) throw new PresaleError('BAD_WALLET', 'walletAddress required');
    if (!this.open) throw new PresaleError('PRESALE_CLOSED', 'presale is closed');

    const tonNano = BigInt(Math.round(Number(tonAmount) * 1e9));
    if (tonNano < this.minOrderNano || tonNano > this.maxOrderNano) {
      throw new PresaleError('BAD_AMOUNT', 'order must be within min/max TON limits');
    }

    const { soldA9Raw, userUsedNano } = await this._getUsage(walletAddress);
    if (soldA9Raw >= this.totalCapA9Raw) throw new PresaleError('SOLD_OUT', 'presale sold out');
    if (userUsedNano + tonNano > this.defaultQuotaNano) {
      throw new PresaleError('OVER_QUOTA', 'exceeds personal unlocked quota');
    }

    const a9AmountRaw = (tonNano * this.rateA9PerTon * A9_RAW) / TON_NANO;
    if (soldA9Raw + a9AmountRaw > this.totalCapA9Raw) {
      throw new PresaleError('EXCEEDS_POOL', 'exceeds remaining presale supply');
    }

    const cleanRef = referrerId && String(referrerId).trim() !== walletAddress
      ? String(referrerId).trim()
      : null;

    const orderId = randomBytes(6).toString('hex');
    const memo = `buy:${orderId}`;

    await this.db
      .prepare(
        `INSERT INTO presale_orders
         (order_id, wallet_address, referrer_id, ton_nano, a9_amount_raw, memo, status, refund_ton_nano, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, ?)`,
      )
      .bind(orderId, walletAddress, cleanRef, tonNano.toString(), a9AmountRaw.toString(), memo, PRESALE_STATUS.PENDING_TON, nowSec, nowSec)
      .run();

    return {
      orderId,
      walletAddress,
      referrerId: cleanRef,
      tonNano: tonNano.toString(),
      a9AmountRaw: a9AmountRaw.toString(),
      payTo: this.hotWalletAddress,
      memo,
      status: PRESALE_STATUS.PENDING_TON,
      inboundTxHash: null,
      payoutTxHash: null,
      refundTonNano: '0',
      createdAt: nowSec,
      updatedAt: nowSec,
    };
  }

  async markOrderPaid(orderId, inboundTxHash, payoutTxHash = null, nowSec = Math.floor(Date.now() / 1000)) {
    const row = await this.db
      .prepare('SELECT * FROM presale_orders WHERE order_id = ?')
      .bind(orderId)
      .first();
    if (!row) throw new PresaleError('NOT_FOUND', `order ${orderId} not found`);

    await this.db
      .prepare(
        `UPDATE presale_orders
         SET status = ?, inbound_tx_hash = ?, payout_tx_hash = ?, updated_at = ?
         WHERE order_id = ?`,
      )
      .bind(PRESALE_STATUS.PAID_A9, inboundTxHash, payoutTxHash, nowSec, orderId)
      .run();

    const boundRef = (this.socialStore ? await this.socialStore.getReferrer(row.wallet_address) : null) || row.referrer_id || null;
    let referralCredited = null;
    if (boundRef && boundRef !== row.wallet_address) {
      const referralRewardRaw = (BigInt(row.a9_amount_raw) * REFERRAL_BPS) / 100n;
      if (referralRewardRaw > 0n) {
        if (this.promoEngine && typeof this.promoEngine.creditReward === 'function') {
          await this.promoEngine.creditReward(boundRef, referralRewardRaw, nowSec);
        }
        referralCredited = { referrerWallet: boundRef, amountRaw: referralRewardRaw.toString() };
      }
    }
    return { orderId, status: PRESALE_STATUS.PAID_A9, referralCredited };
  }

  async listOrders(walletAddress) {
    const res = await this.db
      .prepare('SELECT * FROM presale_orders WHERE wallet_address = ? ORDER BY created_at DESC')
      .bind(walletAddress)
      .all();
    return (res?.results || []).map((o) => ({
      orderId: o.order_id,
      walletAddress: o.wallet_address,
      referrerId: o.referrer_id || null,
      tonNano: String(o.ton_nano),
      a9AmountRaw: String(o.a9_amount_raw),
      payTo: this.hotWalletAddress,
      memo: o.memo,
      status: o.status,
      inboundTxHash: o.inbound_tx_hash || null,
      payoutTxHash: o.payout_tx_hash || null,
      refundTonNano: String(o.refund_ton_nano || '0'),
      createdAt: Number(o.created_at),
      updatedAt: Number(o.updated_at),
    }));
  }
}
