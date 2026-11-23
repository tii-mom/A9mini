// A9 Protocol v15 — Cloudflare D1 Persistence Adapters for Social, Prediction & Presale.
// Matches worker/schema.sql tables and mirrors the in-memory engine interfaces 1:1.
import { rewardForWarmupRank, SocialError } from './social-store.mjs';
import {
  GrowthError,
  VOUCHER_TTL_MS,
  DEFAULT_FIRST_LOSS_BONUS_RAW,
  DEFAULT_FIRST_LOSS_CAP_RAW,
  DAILY_STAMP_KEYS,
  PROGRESSION_TASKS,
  utcDayFromSec,
  prevUtcDay,
  levelFromExp,
  computeEffectiveStreak,
  buildProgressionSummary,
} from './growth-engine.mjs';
import { PresaleEngine, PresaleError, RESERVING_STATUSES } from './presale-hotwallet.mjs';
import { addressKey, addressAliases } from './ton-address.mjs';
import { randomHex } from './auth.mjs';

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
    const candidates = Array.from(new Set([subj, addressKey(subj), ...addressAliases(subj)].filter(Boolean)));
    const ph = candidates.map(() => '?').join(', ');
    const row = await this.db
      .prepare(`SELECT referrer_id FROM referrals WHERE subject_key IN (${ph}) ORDER BY bound_at ASC LIMIT 1`)
      .bind(...candidates)
      .first();
    return row ? String(row.referrer_id) : null;
  }

  async listDirectReferees(referrerKeys = []) {
    const expanded = new Set();
    for (const k of referrerKeys || []) {
      const clean = String(k || '').trim();
      if (!clean) continue;
      expanded.add(clean);
      expanded.add(addressKey(clean));
      for (const a of addressAliases(clean)) expanded.add(a);
    }
    const keys = Array.from(expanded);
    if (!keys.length) return [];
    const ph = keys.map(() => '?').join(', ');
    const res = await this.db
      .prepare(`SELECT DISTINCT subject_key FROM referrals WHERE referrer_id IN (${ph})`)
      .bind(...keys)
      .all();
    return (res?.results || []).map((r) => String(r.subject_key));
  }

  async bindReferral(subjectKey, referrerId, nowSec = Math.floor(Date.now() / 1000), { aliases = [] } = {}) {
    const subj = String(subjectKey || '').trim();
    const ref = String(referrerId || '').trim();
    if (!subj || !ref) return null;

    const allSubjects = [subj, ...aliases.map((a) => String(a || '').trim()).filter(Boolean)];
    const refKey = addressKey(ref);
    for (const s of allSubjects) {
      if (s === ref || addressKey(s) === refKey) return null;
    }

    for (const s of allSubjects) {
      const existing = await this.db
        .prepare('SELECT subject_key, referrer_id, bound_at FROM referrals WHERE subject_key = ?')
        .bind(s)
        .first();
      if (existing) {
        if (s !== subj) {
          await this.db
            .prepare('INSERT OR IGNORE INTO referrals (subject_key, referrer_id, bound_at) VALUES (?, ?, ?)')
            .bind(subj, existing.referrer_id, Number(existing.bound_at))
            .run();
        }
        return {
          subjectKey: subj,
          referrerId: String(existing.referrer_id),
          boundAt: Number(existing.bound_at),
        };
      }
    }

    // Anti-cycle walk up to depth 8
    const subjectKeys = new Set(allSubjects.map((s) => addressKey(s)));
    let cursor = ref;
    for (let depth = 0; depth < 8 && cursor; depth += 1) {
      const parent = await this.getReferrer(cursor);
      if (!parent) break;
      if (allSubjects.includes(parent) || subjectKeys.has(addressKey(parent))) return null;
      cursor = parent;
    }

    for (const s of allSubjects) {
      await this.db
        .prepare('INSERT OR IGNORE INTO referrals (subject_key, referrer_id, bound_at) VALUES (?, ?, ?)')
        .bind(s, ref, nowSec)
        .run();
    }
    return { subjectKey: subj, referrerId: ref, boundAt: nowSec };
  }

  async registerWarmup(
    { roundId = 1, walletAddress, referrerWallet = null, referrerId = null, aliases = [] },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    if (!walletAddress) throw new Error('walletAddress required');
    const rId = Number(roundId);
    const rawRef = String(referrerId || referrerWallet || '').trim() || null;
    if (rawRef) await this.bindReferral(walletAddress, rawRef, nowSec, { aliases });
    let effectiveRef = await this.getReferrer(walletAddress);
    if (!effectiveRef && Array.isArray(aliases)) {
      for (const a of aliases) {
        effectiveRef = await this.getReferrer(a);
        if (effectiveRef) break;
      }
    }

    const existing = await this.db
      .prepare('SELECT * FROM warmup_registrations WHERE round_id = ? AND wallet_address = ?')
      .bind(rId, walletAddress)
      .first();
    if (existing && existing.status === 'ACTIVE') {
      return this._formatWarmup(existing);
    }

    const isFirstSignup = !existing;
    const validInvites = existing ? Number(existing.valid_invites) : 0;
    const createdAt = existing ? Number(existing.created_at) : nowSec;
    const refToStore = effectiveRef && addressKey(effectiveRef) !== addressKey(walletAddress) ? effectiveRef : null;

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

    // 仅首次报名时累加推荐人有效邀请，封堵反复 cancel -> register 刷榜漏洞
    if (isFirstSignup && refToStore) {
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
    if (!teamId || !captainWallet) throw new SocialError('BAD_REQUEST', 'teamId and captainWallet required');
    const cur = await this.db.prepare('SELECT * FROM team_groups WHERE team_id = ?').bind(teamId).first();
    if (cur && addressKey(cur.captain_wallet) !== addressKey(captainWallet)) {
      throw new SocialError('NOT_CAPTAIN', 'only captain can bind TG group');
    }
    const nextName = name || cur?.name || teamId;
    const nextHandle = tgGroupHandle || cur?.tg_group_handle || null;
    const nextChatId = tgGroupHandle ? tgChatId : (cur?.tg_chat_id || null);
    // Not verified against Telegram yet: a handle alone is never reported as bound.
    const nextStatus = tgGroupHandle ? 'verifying' : (cur?.bind_status || 'unbound');
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

  async verifyTeamGroupBinding(
    { teamId, captainWallet, telegramUserId, telegramVerifier },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    if (!teamId || !captainWallet) throw new SocialError('BAD_REQUEST', 'teamId and captainWallet required');
    const cur = await this.db.prepare('SELECT * FROM team_groups WHERE team_id = ?').bind(teamId).first();
    if (!cur) throw new SocialError('TEAM_NOT_FOUND', `team ${teamId} not found`);
    if (addressKey(cur.captain_wallet) !== addressKey(captainWallet)) {
      throw new SocialError('NOT_CAPTAIN', 'only captain can verify TG group binding');
    }
    if (!cur.tg_group_handle && !cur.tg_chat_id) {
      throw new SocialError('BAD_REQUEST', 'no Telegram group handle submitted for verification');
    }
    if (typeof telegramVerifier !== 'function') {
      return {
        teamId: cur.team_id,
        name: cur.name,
        captainWallet: cur.captain_wallet,
        tgGroupHandle: cur.tg_group_handle || null,
        tgChatId: cur.tg_chat_id || null,
        bindStatus: cur.bind_status,
        memberCount: Number(cur.member_count || 1),
        createdAt: Number(cur.created_at),
        updatedAt: Number(cur.updated_at),
      };
    }

    const check = await telegramVerifier({
      teamId,
      tgGroupHandle: cur.tg_group_handle,
      tgChatId: cur.tg_chat_id,
      telegramUserId,
    });

    if (!check?.botInGroup || !check?.chatId) {
      const nextStatus = cur.bind_status === 'bound' ? 'expired' : 'verifying';
      await this.db
        .prepare('UPDATE team_groups SET bind_status = ?, updated_at = ? WHERE team_id = ?')
        .bind(nextStatus, nowSec, teamId)
        .run();
      throw new SocialError('BOT_NOT_IN_GROUP', '机器人尚未加入该群组或无访问权限');
    }

    const canonicalChatId = String(check.chatId);
    const conflict = await this.db
      .prepare("SELECT team_id FROM team_groups WHERE tg_chat_id = ? AND bind_status = 'bound' AND team_id != ? LIMIT 1")
      .bind(canonicalChatId, teamId)
      .first();
    if (conflict) {
      throw new SocialError('GROUP_ALREADY_BOUND', '该 Telegram 群组已被其他战队绑定');
    }

    if (!check.operatorIsAdmin) {
      if (cur.bind_status === 'bound') {
        await this.db
          .prepare("UPDATE team_groups SET bind_status = 'expired', updated_at = ? WHERE team_id = ?")
          .bind(nowSec, teamId)
          .run();
      }
      throw new SocialError('NOT_GROUP_ADMIN', '操作者不是该 Telegram 群组的管理员');
    }

    const nextHandle = check.groupHandle ? String(check.groupHandle) : (cur.tg_group_handle || null);
    const nextTgMembers = Number.isFinite(Number(check.tgMemberCount)) ? Number(check.tgMemberCount) : Number(cur.tg_member_count || 0);
    await this.db
      .prepare("UPDATE team_groups SET tg_chat_id = ?, tg_group_handle = ?, bind_status = 'bound', tg_member_count = ?, updated_at = ? WHERE team_id = ?")
      .bind(canonicalChatId, nextHandle, nextTgMembers, nowSec, teamId)
      .run();

    return {
      teamId: cur.team_id,
      name: cur.name,
      captainWallet: cur.captain_wallet,
      tgGroupHandle: nextHandle,
      tgChatId: canonicalChatId,
      bindStatus: 'bound',
      memberCount: Number(cur.member_count || 1),
      tgMemberCount: nextTgMembers,
      createdAt: Number(cur.created_at),
      updatedAt: nowSec,
    };
  }

  async joinTeam({ teamId, walletAddress, referrerId = null, aliases = [] }, nowSec = Math.floor(Date.now() / 1000)) {
    const team = await this.db.prepare('SELECT * FROM team_groups WHERE team_id = ?').bind(teamId).first();
    if (!team) throw new Error(`team ${teamId} not found`);
    if (referrerId) await this.bindReferral(walletAddress, referrerId, nowSec, { aliases });

    const prevRow = await this.db
      .prepare('SELECT team_id FROM team_members WHERE wallet_address = ? LIMIT 1')
      .bind(walletAddress)
      .first();
    const prevTeamId = prevRow?.team_id ? String(prevRow.team_id) : null;

    await this.db
      .prepare('INSERT OR REPLACE INTO team_members (wallet_address, team_id, joined_at) VALUES (?, ?, ?)')
      .bind(walletAddress, teamId, nowSec)
      .run();

    // 若发生换队，同步重算旧队人数，避免旧队 member_count 虚高
    if (prevTeamId && prevTeamId !== teamId) {
      const prevCntRow = await this.db
        .prepare('SELECT COUNT(*) AS cnt FROM team_members WHERE team_id = ?')
        .bind(prevTeamId)
        .first();
      await this.db
        .prepare('UPDATE team_groups SET member_count = ?, updated_at = ? WHERE team_id = ?')
        .bind(Number(prevCntRow?.cnt || 0), nowSec, prevTeamId)
        .run();
    }

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
    const aliases = addressAliases(walletAddress);
    if (!aliases.length) return null;
    const ph = aliases.map(() => '?').join(', ');
    const mem = await this.db
      .prepare(`SELECT team_id FROM team_members WHERE wallet_address IN (${ph}) LIMIT 1`)
      .bind(...aliases)
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
      tgMemberCount: Number(t.tg_member_count || 0),
      createdAt: Number(t.created_at),
      updatedAt: Number(t.updated_at),
    };
  }

  async listTeamMemberWallets(teamId) {
    const res = await this.db
      .prepare('SELECT wallet_address FROM team_members WHERE team_id = ?')
      .bind(String(teamId))
      .all();
    return (res?.results || []).map((r) => String(r.wallet_address));
  }

  /** 返回全部已通过四重真实核验（bind_status = 'bound' 且具备真实 tg_chat_id）的战队群。 */
  async listBoundTeams() {
    const res = await this.db
      .prepare("SELECT * FROM team_groups WHERE bind_status = 'bound' AND tg_chat_id IS NOT NULL AND tg_chat_id != '' ORDER BY created_at ASC")
      .all();
    return (res?.results || []).map((t) => ({
      teamId: t.team_id,
      name: t.name,
      captainWallet: t.captain_wallet,
      tgGroupHandle: t.tg_group_handle || null,
      tgChatId: t.tg_chat_id || null,
      bindStatus: t.bind_status,
      memberCount: Number(t.member_count),
      tgMemberCount: Number(t.tg_member_count || 0),
      createdAt: Number(t.created_at),
      updatedAt: Number(t.updated_at),
    }));
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
function parseOptionalBigInt(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = BigInt(String(val).trim());
  return n < 0n ? 0n : n;
}

export class D1PredictionEngine {
  constructor({
    db,
    defaultPoolA9Raw = '1000000000000000',
    firstLossBonusRaw = DEFAULT_FIRST_LOSS_BONUS_RAW,
    firstLossCapRaw = DEFAULT_FIRST_LOSS_CAP_RAW,
  }) {
    if (!db) throw new Error('Cloudflare D1 binding (env.DB) is required');
    this.db = db;
    this.defaultPoolA9Raw = BigInt(defaultPoolA9Raw);
    this.firstLossBonusRaw = parseOptionalBigInt(firstLossBonusRaw, DEFAULT_FIRST_LOSS_BONUS_RAW);
    this.firstLossCapRaw = parseOptionalBigInt(firstLossCapRaw, DEFAULT_FIRST_LOSS_CAP_RAW);
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
      .prepare('SELECT * FROM prediction_bets WHERE round_id = ? ORDER BY created_at ASC, user_id ASC')
      .bind(rId)
      .all();
    const bets = betsRes?.results || [];

    const winners = [];
    let totalWeight = 0n;
    let firstLossRemaining = this.firstLossCapRaw;
    let firstLossBonusCount = 0;
    let firstLossBonusDistributed = 0n;
    const expiresAt = nowMs + VOUCHER_TTL_MS;
    const stmts = [];

    for (const b of bets) {
      const st = await this._getUserStatsRow(b.user_id);
      const isFirstSettled = st.totalSettled === 0;
      const nextSettled = st.totalSettled + 1;
      if (b.side === winSide) {
        const exactBoost = b.guess_slots !== null && Number(b.guess_slots) === Number(actualQualified) ? 5n : 0n;
        const inviteBoost = BigInt(await this.getInviteBoostCount(rId, b.user_id));
        const rawW = 10n + exactBoost + inviteBoost;
        const weight = rawW > 20n ? 20n : rawW;
        winners.push({ bet: b, weight, st: { ...st, totalSettled: nextSettled, totalWon: st.totalWon + 1, streak: st.streak + 1 } });
        totalWeight += weight;
      } else if (isFirstSettled && this.firstLossBonusRaw > 0n && firstLossRemaining >= this.firstLossBonusRaw) {
        firstLossRemaining -= this.firstLossBonusRaw;
        firstLossBonusCount += 1;
        firstLossBonusDistributed += this.firstLossBonusRaw;
        stmts.push(
          this.db
            .prepare("UPDATE prediction_bets SET status = 'LOST_FIRST_BONUS', reward_raw = ? WHERE round_id = ? AND user_id = ?")
            .bind(this.firstLossBonusRaw.toString(), rId, b.user_id),
          this._upsertUserStatsStmt(
            b.user_id,
            {
              ...st,
              totalSettled: nextSettled,
              streak: 0,
              pendingActivationRaw: st.pendingActivationRaw + this.firstLossBonusRaw,
              pendingExpiresAt: expiresAt,
            },
            nowSec,
          ),
        );
      } else {
        stmts.push(
          this.db
            .prepare("UPDATE prediction_bets SET status = 'LOST', reward_raw = '0' WHERE round_id = ? AND user_id = ?")
            .bind(rId, b.user_id),
          this._upsertUserStatsStmt(b.user_id, { ...st, totalSettled: nextSettled, streak: 0 }, nowSec),
        );
      }
    }

    let distributed = 0n;
    for (const { bet, weight, st } of winners) {
      const amt = totalWeight > 0n ? (pool * weight) / totalWeight : 0n;
      distributed += amt;
      stmts.push(
        this.db
          .prepare("UPDATE prediction_bets SET status = 'WON_PENDING_ACTIVATION', reward_raw = ? WHERE round_id = ? AND user_id = ?")
          .bind(amt.toString(), rId, bet.user_id),
        this._upsertUserStatsStmt(
          bet.user_id,
          {
            ...st,
            pendingActivationRaw: st.pendingActivationRaw + amt,
            pendingExpiresAt: expiresAt,
          },
          nowSec,
        ),
      );
    }

    stmts.push(
      this.db
        .prepare('INSERT INTO prediction_rounds (round_id, winning_side, actual_qualified, settled_at) VALUES (?, ?, ?, ?)')
        .bind(rId, winSide, Number(actualQualified), nowSec),
    );
    await this.db.batch(stmts);

    return {
      roundId: rId,
      winSide,
      winnersCount: winners.length,
      distributedRaw: distributed.toString(),
      firstLossBonusCount,
      firstLossBonusDistributedRaw: firstLossBonusDistributed.toString(),
    };
  }

  async _getActivationById(activationId) {
    if (!activationId) return null;
    const row = await this.db
      .prepare('SELECT * FROM prediction_activations WHERE activation_id = ? LIMIT 1')
      .bind(String(activationId))
      .first();
    if (!row) return null;
    return {
      activationId: String(row.activation_id),
      userId: String(row.user_id),
      walletKey: String(row.wallet_key),
      walletAddress: String(row.wallet_address),
      activatedRaw: String(row.amount_raw),
      createdAt: Number(row.created_at),
    };
  }

  async _findPromoBalanceRow(walletAddress) {
    const key = addressKey(walletAddress);
    const row = await this.db
      .prepare('SELECT wallet_address, claimable_raw, total_claimed_raw FROM promo_balances WHERE wallet_address = ?')
      .bind(key)
      .first();
    if (row) return row;
    const aliases = addressAliases(walletAddress).filter((a) => a !== key);
    if (!aliases.length) return null;
    const ph = aliases.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT wallet_address, claimable_raw, total_claimed_raw FROM promo_balances WHERE wallet_address IN (${ph}) LIMIT 1`)
      .bind(...aliases)
      .first();
  }

  async creditPendingBonus(userId, amountRaw, nowMs = Date.now()) {
    const uid = String(userId || '').trim();
    const amt = BigInt(amountRaw || 0n);
    if (!uid || amt <= 0n) return { userId: uid, pendingActivationRaw: '0' };
    const nowSec = Math.floor(nowMs / 1000);
    const st = await this._getUserStatsRow(uid);
    const nextPending = st.pendingActivationRaw + amt;
    const nextExp = nowMs + VOUCHER_TTL_MS;
    await this._upsertUserStats(uid, { ...st, pendingActivationRaw: nextPending, pendingExpiresAt: nextExp }, nowSec);
    return { userId: uid, pendingActivationRaw: nextPending.toString(), pendingExpiresAt: nextExp };
  }

  /**
   * Atomically deduct prediction_rewards.pending_activation_raw, credit promo_balances.claimable_raw,
   * and record a unique prediction_activations ledger row in a SINGLE D1 batch transaction.
   * - Requires promoEngine bound to the SAME D1 database; fails closed BEFORE any write if missing
   *   or pointing to a different ledger so pending_activation_raw can NEVER be deducted without credit.
   * - If either snapshot is stale (0-row conditional match) or any statement fails mid-batch, the
   *   entire D1 batch rolls back so pending_activation_raw is NEVER lost.
   * - Retrying with the same activationId after a lost response returns the original ledger record.
   */
  async activateToPromo(userId, walletAddress, promoEngine, { qualified = false, nowMs = Date.now(), activationId = null } = {}) {
    const uid = String(userId || '').trim();
    const wallet = String(walletAddress || '').trim();
    if (!uid || !wallet) throw new GrowthError('BAD_REQUEST', 'userId and walletAddress required');
    if (qualified !== true) {
      throw new GrowthError(
        'ACTIVATION_REQUIREMENT_UNMET',
        '请先完成至少 1 笔 A9 兑换屋兑换或链上质押后再激活',
      );
    }
    if (!promoEngine || promoEngine.db !== this.db) {
      throw new GrowthError(
        'PROMO_LEDGER_UNAVAILABLE',
        '推广账本未绑定到同一数据库，拒绝扣减待激活奖励',
      );
    }

    const actId = activationId ? String(activationId).trim().slice(0, 80) : `act:${uid}:${randomHex(8)}`;
    const nowSec = Math.floor(nowMs / 1000);
    const walletKey = addressKey(wallet);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      // 1) Idempotent retry check: if this activationId already committed, return the original ledger row.
      const existing = await this._getActivationById(actId);
      if (existing) {
        if (existing.userId !== uid) {
          throw new GrowthError('ACTIVATION_ID_CONFLICT', 'activationId belongs to another user');
        }
        return { ...existing, idempotent: true };
      }

      const st = await this._getUserStatsRow(uid);
      if (st.pendingActivationRaw <= 0n) {
        return { userId: uid, walletAddress: wallet, activatedRaw: '0', activationId: null, idempotent: false };
      }

      if (st.pendingExpiresAt !== null && nowMs > st.pendingExpiresAt) {
        await this._upsertUserStats(uid, { ...st, pendingActivationRaw: 0n, pendingExpiresAt: null }, nowSec);
        throw new GrowthError('VOUCHER_EXPIRED', '待激活预言奖励已过期');
      }

      const amt = st.pendingActivationRaw;
      const nextActivated = st.activatedRaw + amt;

      let balRow = await this._findPromoBalanceRow(wallet);
      if (!balRow) {
        await this.db
          .prepare(
            `INSERT OR IGNORE INTO promo_balances (wallet_address, claimable_raw, total_claimed_raw, updated_at)
             VALUES (?, '0', '0', ?)`,
          )
          .bind(walletKey, nowSec)
          .run();
        balRow = await this._findPromoBalanceRow(wallet);
      }
      if (!balRow) continue;
      const targetBalKey = String(balRow.wallet_address);
      const curClaimable = String(balRow.claimable_raw || '0');
      const nextClaimable = (BigInt(curClaimable) + amt).toString();

      const stmts = [
        this.db
          .prepare(
            `INSERT INTO prediction_activations (activation_id, user_id, wallet_key, wallet_address, amount_raw, created_at)
             VALUES (
               ?, ?, ?, ?,
               (SELECT pending_activation_raw FROM prediction_rewards
                 WHERE user_id = ? AND pending_activation_raw = ?
                   AND EXISTS (SELECT 1 FROM promo_balances WHERE wallet_address = ? AND claimable_raw = ?)),
               ?
             )`,
          )
          .bind(actId, uid, walletKey, wallet, uid, amt.toString(), targetBalKey, curClaimable, nowSec),
        this.db
          .prepare(
            `UPDATE prediction_rewards
             SET pending_activation_raw = '0', activated_raw = ?, pending_expires_at = NULL, updated_at = ?
             WHERE user_id = ? AND pending_activation_raw = ?`,
          )
          .bind(nextActivated.toString(), nowSec, uid, amt.toString()),
        this.db
          .prepare(
            `UPDATE promo_balances
             SET claimable_raw = ?, updated_at = ?
             WHERE wallet_address = ? AND claimable_raw = ?`,
          )
          .bind(nextClaimable, nowSec, targetBalKey, curClaimable),
      ];

      try {
        await this.db.batch(stmts);
        return { userId: uid, walletAddress: wallet, activatedRaw: amt.toString(), activationId: actId, idempotent: false };
      } catch (e) {
        const msg = String(e?.message || e);
        if (/NOT NULL|UNIQUE|constraint/i.test(msg)) {
          // Snapshot conflict or duplicate activationId: loop will return existing ledger or re-read fresh balance.
          continue;
        }
        throw e;
      }
    }
    throw new GrowthError('ACTIVATION_CONFLICT', 'concurrent activation conflict, please retry');
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

  _upsertUserStatsStmt(uid, st, nowSec) {
    return this.db
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
      );
  }

  async _upsertUserStats(uid, st, nowSec) {
    await this._upsertUserStatsStmt(uid, st, nowSec).run();
  }
}

// ---------------------------------------------------------------------------
// 2b. D1ProgressionEngine (user_progression, user_task_claims)
// ---------------------------------------------------------------------------
export class D1ProgressionEngine {
  constructor({ db }) {
    if (!db) throw new Error('Cloudflare D1 binding (env.DB) is required');
    this.db = db;
  }

  async _getUserRow(uid) {
    const row = await this.db
      .prepare('SELECT * FROM user_progression WHERE user_id = ?')
      .bind(uid)
      .first();
    if (!row) {
      return {
        userId: uid,
        exp: 0,
        level: 1,
        checkinStreak: 0,
        lastCheckinDay: null,
        totalStamps: 0,
        updatedAt: 0,
      };
    }
    return {
      userId: String(row.user_id),
      exp: Number(row.exp || 0),
      level: Number(row.level || 1),
      checkinStreak: Number(row.checkin_streak || 0),
      lastCheckinDay: row.last_checkin_day || null,
      totalStamps: Number(row.total_stamps || 0),
      updatedAt: Number(row.updated_at || 0),
    };
  }

  async getUserSummary(userId, nowSec = Math.floor(Date.now() / 1000), { hasPredictionBet = false } = {}) {
    const uid = String(userId || '').trim();
    if (!uid) throw new GrowthError('BAD_REQUEST', 'userId required');
    const todayStr = utcDayFromSec(nowSec);
    const u = await this._getUserRow(uid);

    const claimsRes = await this.db
      .prepare("SELECT task_key, period_key FROM user_task_claims WHERE user_id = ? AND (period_key = ? OR period_key = 'ONCE' OR task_key = 'daily_prediction')")
      .bind(uid, todayStr)
      .all();

    const todayClaims = [];
    const onceClaims = [];
    let hasEverPredicted = Boolean(hasPredictionBet);
    for (const c of claimsRes?.results || []) {
      if (c.period_key === todayStr) todayClaims.push(String(c.task_key));
      if (c.period_key === 'ONCE') onceClaims.push(String(c.task_key));
      if (c.task_key === 'daily_prediction') hasEverPredicted = true;
    }

    return buildProgressionSummary({
      userId: uid,
      exp: u.exp,
      checkinStreak: u.checkinStreak,
      lastCheckinDay: u.lastCheckinDay,
      totalStamps: u.totalStamps,
      todayStr,
      todayClaims,
      onceClaims,
      hasPredictionBet,
      hasEverPredicted,
    });
  }

  async claimTask({ userId, taskKey, hasPredictionBet = false }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(userId || '').trim();
    const tKey = String(taskKey || '').trim();
    if (!uid || !tKey) throw new GrowthError('BAD_REQUEST', 'userId and taskKey required');
    const task = PROGRESSION_TASKS[tKey];
    if (!task) throw new GrowthError('UNKNOWN_TASK', `unknown progression task: ${tKey}`);

    const todayStr = utcDayFromSec(nowSec);
    const periodKey = task.periodType === 'ONCE' ? 'ONCE' : todayStr;

    const existing = await this.db
      .prepare('SELECT 1 AS hit FROM user_task_claims WHERE user_id = ? AND task_key = ? AND period_key = ?')
      .bind(uid, tKey, periodKey)
      .first();
    if (existing) {
      throw new GrowthError('ALREADY_CLAIMED', '该手账印章已盖章领取，不可重复领取');
    }

    const u = await this._getUserRow(uid);
    const curStreak = computeEffectiveStreak(u.checkinStreak, u.lastCheckinDay, todayStr);

    if (tKey === 'daily_prediction' && !hasPredictionBet) {
      throw new GrowthError('TASK_PREREQUISITE_UNMET', '请先参与本轮 0 GRAM 24H 达标竞猜后再盖章');
    }
    if (tKey === 'daily_full_bonus') {
      const cntRow = await this.db
        .prepare(
          `SELECT COUNT(DISTINCT task_key) AS cnt FROM user_task_claims
           WHERE user_id = ? AND period_key = ? AND task_key IN ('daily_checkin', 'daily_prediction', 'daily_observe', 'daily_share')`,
        )
        .bind(uid, todayStr)
        .first();
      if (Number(cntRow?.cnt || 0) < DAILY_STAMP_KEYS.length) {
        throw new GrowthError('TASK_PREREQUISITE_UNMET', '集齐今日全部 4 枚日常印章后方可领取满章加赠');
      }
    }
    if (tKey === 'ach_first_stamp' && u.totalStamps < 1) {
      throw new GrowthError('TASK_PREREQUISITE_UNMET', '需至少完成 1 次手账盖章后解锁');
    }
    if (tKey === 'ach_streak_3' && curStreak < 3) {
      throw new GrowthError('TASK_PREREQUISITE_UNMET', '连续打卡满 3 天后解锁');
    }
    if (tKey === 'ach_pred_pioneer') {
      let hasEverPred = Boolean(hasPredictionBet);
      if (!hasEverPred) {
        const predClaim = await this.db
          .prepare("SELECT 1 AS hit FROM user_task_claims WHERE user_id = ? AND task_key = 'daily_prediction' LIMIT 1")
          .bind(uid)
          .first();
        hasEverPred = Boolean(predClaim);
      }
      if (!hasEverPred) {
        throw new GrowthError('TASK_PREREQUISITE_UNMET', '需完成至少 1 次 24H 达标竞猜后解锁');
      }
    }
    if (tKey === 'ach_stamp_10' && u.totalStamps < 10) {
      throw new GrowthError('TASK_PREREQUISITE_UNMET', '累计集齐 10 枚手账印章后解锁');
    }

    // 原子唯一插入防并发重复发奖：仅当 INSERT OR IGNORE 实际写入 1 行时才累加 EXP
    const ins = await this.db
      .prepare(
        `INSERT OR IGNORE INTO user_task_claims (user_id, task_key, period_key, exp_awarded, claimed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(uid, tKey, periodKey, task.exp, nowSec)
      .run();
    const changed = Number(ins?.meta?.changes ?? ins?.changes ?? 0);
    if (changed !== 1) {
      throw new GrowthError('ALREADY_CLAIMED', '该手账印章已盖章领取，不可重复领取');
    }

    let nextStreak = u.checkinStreak;
    let nextCheckinDay = u.lastCheckinDay;
    if (tKey === 'daily_checkin') {
      if (u.lastCheckinDay === todayStr) {
        nextStreak = Math.max(1, u.checkinStreak);
      } else if (u.lastCheckinDay === prevUtcDay(todayStr)) {
        nextStreak = u.checkinStreak + 1;
      } else {
        nextStreak = 1;
      }
      nextCheckinDay = todayStr;
    }

    const nextExp = u.exp + task.exp;
    const nextLevel = levelFromExp(nextExp);
    const stampDelta = task.kind === 'daily' ? 1 : 0;
    const nextStamps = u.totalStamps + stampDelta;

    await this.db
      .prepare(
        `INSERT INTO user_progression (user_id, exp, level, checkin_streak, last_checkin_day, total_stamps, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           exp = user_progression.exp + ?,
           level = (user_progression.exp + ?) / 200 + 1,
           checkin_streak = ?,
           last_checkin_day = ?,
           total_stamps = user_progression.total_stamps + ?,
           updated_at = ?`,
      )
      .bind(
        uid,
        nextExp,
        nextLevel,
        nextStreak,
        nextCheckinDay,
        nextStamps,
        nowSec,
        task.exp,
        task.exp,
        nextStreak,
        nextCheckinDay,
        stampDelta,
        nowSec,
      )
      .run();

    return {
      claimedTask: tKey,
      periodKey,
      expAwarded: task.exp,
      progression: await this.getUserSummary(uid, nowSec, { hasPredictionBet }),
    };
  }
}

// ---------------------------------------------------------------------------
// 3. D1 presale repository (presale_orders + presale_inbound_txs + presale_payouts +
//    presale_referral_credits). Same contract as MemoryPresaleRepo in presale-hotwallet.mjs.
//    Atomicity: capacity check + insert is ONE statement; multi-row transitions use db.batch()
//    (D1 runs a batch as a single transaction and rolls back on any failure).
// ---------------------------------------------------------------------------
const RESERVING_SQL = `(status IN (${RESERVING_STATUSES.map((s) => `'${s}'`).join(', ')}) OR (status = 'PENDING_PAYMENT' AND expires_at > ?))`;

const ORDER_COLS = {
  status: 'status',
  inboundTxHash: 'inbound_tx_hash',
  payoutTxHash: 'payout_tx_hash',
  refundTonNano: 'refund_ton_nano',
  refundReason: 'refund_reason',
  lastError: 'last_error',
  updatedAt: 'updated_at',
};
const PAYOUT_COLS = {
  status: 'status',
  txHash: 'tx_hash',
  attempts: 'attempts',
  ambiguous: 'ambiguous',
  lastError: 'last_error',
  updatedAt: 'updated_at',
};

function sqlValue(v) {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v === undefined ? null : v;
}

function buildSet(patch, cols) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!cols[k]) throw new Error(`unknown patch field ${k}`);
    sets.push(`${cols[k]} = ?`);
    vals.push(sqlValue(v));
  }
  return { sql: sets.join(', '), vals };
}

function rowToOrder(r) {
  if (!r) return null;
  return {
    orderId: r.order_id,
    walletAddress: r.wallet_address,
    walletKey: r.wallet_key || addressKey(r.wallet_address),
    tgUserId: r.tg_user_id || null,
    referrerId: r.referrer_id || null,
    skuId: r.sku_id || null,
    openMode: r.open_mode || 'INSTANT',
    tonNano: BigInt(r.ton_nano || '0'),
    a9AmountRaw: BigInt(r.a9_amount_raw || '0'),
    memo: r.memo,
    status: r.status,
    inboundTxHash: r.inbound_tx_hash || null,
    payoutTxHash: r.payout_tx_hash || null,
    refundTonNano: BigInt(r.refund_ton_nano || '0'),
    refundReason: r.refund_reason || null,
    lastError: r.last_error || null,
    expiresAt: Number(r.expires_at || 0),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToPayout(r) {
  if (!r) return null;
  return {
    payoutId: r.payout_id,
    orderId: r.order_id || null,
    inboundTxHash: r.inbound_tx_hash || null,
    kind: r.kind,
    recipient: r.recipient,
    amount: String(r.amount),
    queryId: String(r.query_id),
    status: r.status,
    attempts: Number(r.attempts || 0),
    ambiguous: Number(r.ambiguous || 0) === 1,
    txHash: r.tx_hash || null,
    lastError: r.last_error || null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToInbound(r) {
  if (!r) return null;
  return {
    txHash: r.tx_hash,
    orderId: r.order_id || null,
    sender: r.sender || null,
    valueNano: String(r.value_nano),
    memo: r.memo || '',
    decision: r.decision,
    reason: r.reason || null,
    anomalyStatus: r.anomaly_status || null,
    refundTo: r.refund_to || null,
    faultParty: r.fault_party || null,
    feeNano: r.fee_nano === null || r.fee_nano === undefined ? null : String(r.fee_nano),
    resolvedBy: r.resolved_by || null,
    resolvedAt: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
    resolutionNote: r.resolution_note || null,
    createdAt: Number(r.created_at),
  };
}

function rowToCredit(r) {
  if (!r) return null;
  return {
    orderId: r.order_id,
    referrer: r.referrer,
    amountRaw: String(r.amount_raw),
    status: r.status,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const isUnique = (e) => /UNIQUE|constraint/i.test(String(e?.message || e));
const changes = (r) => Number(r?.meta?.changes ?? r?.changes ?? 0);

export class D1PresaleRepo {
  constructor({ db }) {
    if (!db) throw new PresaleError('DB_MISSING', 'Cloudflare D1 binding (env.DB) is required');
    this.db = db;
  }

  async sumReserved(nowSec, walletKey) {
    const res = await this.db
      .prepare(`SELECT wallet_key, wallet_address, ton_nano, a9_amount_raw FROM presale_orders WHERE ${RESERVING_SQL}`)
      .bind(nowSec)
      .all();
    let reservedA9Raw = 0n;
    let userReservedNano = 0n;
    for (const r of res?.results || []) {
      reservedA9Raw += BigInt(r.a9_amount_raw || '0');
      const rowKey = r.wallet_key || addressKey(r.wallet_address);
      if (rowKey === walletKey) userReservedNano += BigInt(r.ton_nano || '0');
    }
    return { reservedA9Raw, userReservedNano };
  }

  async insertOrderIfCapacity(o, { capA9Raw, userQuotaNano, nowSec }) {
    // 将十进制大整数按 10^9 拆分高位（整币）与低位（纳币）在单语句中精确比较，
    // 彻底规避 SQLite 有符号 INT64（9.223×10^18 < 100 亿 A9 raw = 10^19）溢出与截断风险。
    const DEC9 = 1_000_000_000n;
    const split9 = (val) => {
      const n = BigInt(val);
      return { hi: (n / DEC9).toString(), lo: (n % DEC9).toString() };
    };
    const hiExpr = (col) => `CASE WHEN length(${col}) > 9 THEN CAST(substr(${col}, 1, length(${col}) - 9) AS INTEGER) ELSE 0 END`;
    const loExpr = (col) => `CAST(CASE WHEN length(${col}) > 9 THEN substr(${col}, length(${col}) - 8) ELSE ${col} END AS INTEGER)`;

    const addA9 = split9(o.a9AmountRaw);
    const capA9 = split9(capA9Raw);
    const addTon = split9(o.tonNano);
    const capTon = split9(userQuotaNano);

    // 同时覆盖新行（wallet_key）与尚未回填的历史友好地址行（EQ/UQ/kQ/0Q/raw 全部规范形式），保持单语句原子性。
    const aliases = addressAliases(o.walletAddress);
    const aliasPlaceholders = aliases.map(() => '?').join(', ');
    const whereClause = `WHERE EXISTS (
             SELECT 1 FROM (
               SELECT
                 (COALESCE(SUM(${hiExpr('a9_amount_raw')}), 0) + CAST(? AS INTEGER)
                   + (COALESCE(SUM(${loExpr('a9_amount_raw')}), 0) + CAST(? AS INTEGER)) / 1000000000) AS tot_hi,
                 ((COALESCE(SUM(${loExpr('a9_amount_raw')}), 0) + CAST(? AS INTEGER)) % 1000000000) AS tot_lo
               FROM presale_orders WHERE ${RESERVING_SQL}
             ) WHERE tot_hi < CAST(? AS INTEGER) OR (tot_hi = CAST(? AS INTEGER) AND tot_lo <= CAST(? AS INTEGER))
           )
           AND EXISTS (
             SELECT 1 FROM (
               SELECT
                 (COALESCE(SUM(${hiExpr('ton_nano')}), 0) + CAST(? AS INTEGER)
                   + (COALESCE(SUM(${loExpr('ton_nano')}), 0) + CAST(? AS INTEGER)) / 1000000000) AS tot_hi,
                 ((COALESCE(SUM(${loExpr('ton_nano')}), 0) + CAST(? AS INTEGER)) % 1000000000) AS tot_lo
               FROM presale_orders
               WHERE (wallet_key = ? OR (wallet_key IS NULL AND wallet_address IN (${aliasPlaceholders}))) AND ${RESERVING_SQL}
             ) WHERE tot_hi < CAST(? AS INTEGER) OR (tot_hi = CAST(? AS INTEGER) AND tot_lo <= CAST(? AS INTEGER))
           )`;
    const tailArgs = [
      addA9.hi, addA9.lo, addA9.lo, nowSec, capA9.hi, capA9.hi, capA9.lo,
      addTon.hi, addTon.lo, addTon.lo, o.walletKey, ...aliases, nowSec, capTon.hi, capTon.hi, capTon.lo,
    ];
    try {
      const res = await this.db
        .prepare(
          `INSERT INTO presale_orders
             (order_id, wallet_address, wallet_key, tg_user_id, referrer_id, sku_id, open_mode, ton_nano, a9_amount_raw, memo, status,
              refund_ton_nano, expires_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PAYMENT', '0', ?, ?, ?
           ${whereClause}`,
        )
        .bind(
          o.orderId, o.walletAddress, o.walletKey, o.tgUserId, o.referrerId, o.skuId || null, o.openMode || 'INSTANT', o.tonNano.toString(), o.a9AmountRaw.toString(), o.memo,
          o.expiresAt, o.createdAt, o.updatedAt,
          ...tailArgs,
        )
        .run();
      return changes(res) === 1;
    } catch (e) {
      // 兼容尚未执行 0009 迁移的旧库（SQLite INSERT 报 "has no column named sku_id"，D1/SELECT 报 "no such column: sku_id"）
      const errText = `${e?.message || ''} ${e?.cause?.message || ''}`;
      if (!o.skuId && (o.openMode || 'INSTANT') === 'INSTANT' && /(no such column|has no column named)[\s:]+["'`]?(sku_id|open_mode)["'`]?/i.test(errText)) {
        const res = await this.db
          .prepare(
            `INSERT INTO presale_orders
               (order_id, wallet_address, wallet_key, tg_user_id, referrer_id, ton_nano, a9_amount_raw, memo, status,
                refund_ton_nano, expires_at, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PAYMENT', '0', ?, ?, ?
             ${whereClause}`,
          )
          .bind(
            o.orderId, o.walletAddress, o.walletKey, o.tgUserId, o.referrerId, o.tonNano.toString(), o.a9AmountRaw.toString(), o.memo,
            o.expiresAt, o.createdAt, o.updatedAt,
            ...tailArgs,
          )
          .run();
        return changes(res) === 1;
      }
      throw e;
    }
  }

  async getOrder(id) {
    return rowToOrder(await this.db.prepare('SELECT * FROM presale_orders WHERE order_id = ?').bind(id).first());
  }

  async getOrderByMemo(memo) {
    return rowToOrder(await this.db.prepare('SELECT * FROM presale_orders WHERE memo = ?').bind(memo).first());
  }

  async listOrdersByWallet(walletKey) {
    const res = await this.db
      .prepare('SELECT * FROM presale_orders WHERE wallet_key = ? OR wallet_key IS NULL ORDER BY created_at DESC')
      .bind(walletKey)
      .all();
    return (res?.results || [])
      .filter((r) => (r.wallet_key ? r.wallet_key === walletKey : addressKey(r.wallet_address) === walletKey))
      .map(rowToOrder);
  }

  /** 一次性幂等回填历史订单的 wallet_key，迁移后运维可随时执行。 */
  async backfillLegacyWalletKeys() {
    const res = await this.db
      .prepare('SELECT order_id, wallet_address FROM presale_orders WHERE wallet_key IS NULL')
      .all();
    const rows = res?.results || [];
    if (!rows.length) return 0;
    const stmts = rows.map((r) =>
      this.db
        .prepare('UPDATE presale_orders SET wallet_key = ? WHERE order_id = ? AND wallet_key IS NULL')
        .bind(addressKey(r.wallet_address), r.order_id),
    );
    const out = await this.db.batch(stmts);
    return out.reduce((n, r) => n + changes(r), 0);
  }

  async listOrdersByStatus(status) {
    const res = await this.db.prepare('SELECT * FROM presale_orders WHERE status = ? ORDER BY created_at ASC').bind(status).all();
    return (res?.results || []).map(rowToOrder);
  }

  async getInbound(txHash) {
    return rowToInbound(await this.db.prepare('SELECT * FROM presale_inbound_txs WHERE tx_hash = ?').bind(txHash).first());
  }

  async listAnomalies(status) {
    const res = status
      ? await this.db.prepare("SELECT * FROM presale_inbound_txs WHERE decision = 'ANOMALY' AND anomaly_status = ? ORDER BY created_at ASC").bind(status).all()
      : await this.db.prepare("SELECT * FROM presale_inbound_txs WHERE decision = 'ANOMALY' ORDER BY created_at ASC").all();
    return (res?.results || []).map(rowToInbound);
  }

  /** One transaction: close the anomaly (only if still OPEN) + queue the refund + move the owned order. */
  async resolveAnomaly(txHash, resolution, payout, orderPatch) {
    const stmts = [
      this.db
        .prepare(
          `UPDATE presale_inbound_txs SET anomaly_status = ?, fault_party = ?, fee_nano = ?, resolved_by = ?, resolved_at = ?, resolution_note = ?
           WHERE tx_hash = ? AND decision = 'ANOMALY' AND anomaly_status = 'OPEN'`,
        )
        .bind(resolution.status, resolution.faultParty, resolution.feeNano.toString(), resolution.operator, resolution.resolvedAt, resolution.note, txHash),
    ];
    if (payout) {
      // 仅当本事务中的异常记录处于目标已决态且该入账交易尚未生成退款 payout 时插入，彻底避免同秒并发触发脏冲突。
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO presale_payouts
               (payout_id, order_id, inbound_tx_hash, kind, recipient, amount, query_id, status, attempts, ambiguous, tx_hash, last_error, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM presale_inbound_txs
               WHERE tx_hash = ? AND anomaly_status = ? AND resolved_by = ? AND resolved_at = ?
             ) AND NOT EXISTS (
               SELECT 1 FROM presale_payouts WHERE payout_id = ? OR (kind = 'REFUND' AND inbound_tx_hash = ?)
             )`,
          )
          .bind(
            payout.payoutId, payout.orderId, payout.inboundTxHash, payout.kind, payout.recipient, payout.amount, payout.queryId, payout.status, payout.createdAt, payout.updatedAt,
            txHash, resolution.status, resolution.operator, resolution.resolvedAt,
            payout.payoutId, payout.inboundTxHash,
          ),
      );
    }
    if (orderPatch) {
      const set = buildSet(orderPatch.patch, ORDER_COLS);
      const inboundCond = orderPatch.inboundTxHash ? ' AND inbound_tx_hash = ?' : '';
      const inboundArgs = orderPatch.inboundTxHash ? [orderPatch.inboundTxHash] : [];
      stmts.push(
        this.db
          .prepare(`UPDATE presale_orders SET ${set.sql} WHERE order_id = ?${inboundCond} AND status IN (${orderPatch.from.map(() => '?').join(', ')})`)
          .bind(...set.vals, orderPatch.orderId, ...inboundArgs, ...orderPatch.from),
      );
    }
    const out = await this.db.batch(stmts);
    return changes(out?.[0]) === 1;
  }

  _insertPayoutStmt(p) {
    return this.db
      .prepare(
        `INSERT INTO presale_payouts
           (payout_id, order_id, inbound_tx_hash, kind, recipient, amount, query_id, status, attempts, ambiguous, tx_hash, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .bind(p.payoutId, p.orderId, p.inboundTxHash, p.kind, p.recipient, p.amount, p.queryId, p.status, p.attempts, p.ambiguous ? 1 : 0, p.createdAt, p.updatedAt);
  }

  /**
   * 原子提交单笔链上入账（P0-I）：
   * - 全部状态转移在单次 db.batch() 事务内一次完成，彻底消除“事务写入后、二次 UPDATE 改异常前进程崩溃”的恢复窗口。
   * - 存在 orderUpdate 时：
   *   1) 先尝试带状态白名单、过期时间守卫与防重放守卫（NOT EXISTS inbound）的条件 UPDATE；
   *   2) 再用单条条件 INSERT INTO presale_inbound_txs，依据同事务内订单是否成功绑定本 tx_hash，
   *      原子决定落库为原计划 decision 或直接落库为 ANOMALY / order_state_race / OPEN；
   *   3) 若有 payout，仅在同事务订单绑定成功时条件插入，绝不产生孤儿 payout。
   */
  async commitInbound({ inbound, orderUpdate, payout }) {
    const stmts = [];
    if (orderUpdate) {
      const set = buildSet(orderUpdate.patch, ORDER_COLS);
      const expCond = orderUpdate.notExpiredAt ? ' AND (expires_at = 0 OR expires_at >= ?)' : '';
      const expArgs = orderUpdate.notExpiredAt ? [orderUpdate.notExpiredAt] : [];
      stmts.push(
        this.db
          .prepare(
            `UPDATE presale_orders
             SET ${set.sql}
             WHERE order_id = ?
               AND status IN (${orderUpdate.from.map(() => '?').join(', ')})${expCond}
               AND NOT EXISTS (SELECT 1 FROM presale_inbound_txs WHERE tx_hash = ?)`,
          )
          .bind(...set.vals, orderUpdate.orderId, ...orderUpdate.from, ...expArgs, inbound.txHash),
      );
      const plannedAnomalyStatus = inbound.anomaly ? inbound.anomaly.status : null;
      const plannedRefundTo = inbound.anomaly ? inbound.anomaly.refundTo : null;
      const raceRefundTo = inbound.sender || null;
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO presale_inbound_txs
               (tx_hash, order_id, sender, value_nano, memo, decision, reason, anomaly_status, refund_to, created_at)
             SELECT
               ?, ?, ?, ?, ?,
               CASE WHEN EXISTS (SELECT 1 FROM presale_orders WHERE order_id = ? AND inbound_tx_hash = ?) THEN ? ELSE 'ANOMALY' END,
               CASE WHEN EXISTS (SELECT 1 FROM presale_orders WHERE order_id = ? AND inbound_tx_hash = ?) THEN ? ELSE 'order_state_race' END,
               CASE WHEN EXISTS (SELECT 1 FROM presale_orders WHERE order_id = ? AND inbound_tx_hash = ?) THEN ? ELSE 'OPEN' END,
               CASE WHEN EXISTS (SELECT 1 FROM presale_orders WHERE order_id = ? AND inbound_tx_hash = ?) THEN ? ELSE ? END,
               ?`,
          )
          .bind(
            inbound.txHash, inbound.orderId, inbound.sender, inbound.valueNano, inbound.memo,
            orderUpdate.orderId, inbound.txHash, inbound.decision,
            orderUpdate.orderId, inbound.txHash, inbound.reason,
            orderUpdate.orderId, inbound.txHash, plannedAnomalyStatus,
            orderUpdate.orderId, inbound.txHash, plannedRefundTo, raceRefundTo,
            inbound.createdAt,
          ),
      );
    } else {
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO presale_inbound_txs (tx_hash, order_id, sender, value_nano, memo, decision, reason, anomaly_status, refund_to, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            inbound.txHash, inbound.orderId, inbound.sender, inbound.valueNano, inbound.memo, inbound.decision, inbound.reason,
            inbound.anomaly ? inbound.anomaly.status : null, inbound.anomaly ? inbound.anomaly.refundTo : null, inbound.createdAt,
          ),
      );
    }
    if (payout) {
      if (orderUpdate) {
        // 仅当同事务内订单确实绑定到当前入账时才插入 payout，绝不产生孤儿 payout。
        stmts.push(
          this.db
            .prepare(
              `INSERT INTO presale_payouts
                 (payout_id, order_id, inbound_tx_hash, kind, recipient, amount, query_id, status, attempts, ambiguous, tx_hash, last_error, created_at, updated_at)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?
               WHERE EXISTS (SELECT 1 FROM presale_orders WHERE order_id = ? AND inbound_tx_hash = ?)`,
            )
            .bind(
              payout.payoutId, payout.orderId, payout.inboundTxHash, payout.kind, payout.recipient, payout.amount, payout.queryId, payout.status, payout.attempts, payout.ambiguous ? 1 : 0, payout.createdAt, payout.updatedAt,
              orderUpdate.orderId, inbound.txHash,
            ),
        );
      } else {
        stmts.push(this._insertPayoutStmt(payout));
      }
    }
    let out;
    try {
      out = await this.db.batch(stmts);
    } catch (e) {
      if (isUnique(e)) return 'REPLAY';
      throw e;
    }
    if (orderUpdate && changes(out?.[0]) !== 1) return 'ORDER_RACE';
    return 'OK';
  }

  async queuePayout(orderId, fromStatus, patch, p) {
    const set = buildSet(patch, ORDER_COLS);
    const out = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO presale_payouts
             (payout_id, order_id, inbound_tx_hash, kind, recipient, amount, query_id, status, attempts, ambiguous, tx_hash, last_error, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?
           WHERE EXISTS (SELECT 1 FROM presale_orders WHERE order_id = ? AND status = ?)
           ON CONFLICT DO NOTHING`,
        )
        .bind(p.payoutId, p.orderId, p.inboundTxHash, p.kind, p.recipient, p.amount, p.queryId, p.status, p.attempts, 0, p.createdAt, p.updatedAt, orderId, fromStatus),
      this.db.prepare(`UPDATE presale_orders SET ${set.sql} WHERE order_id = ? AND status = ?`).bind(...set.vals, orderId, fromStatus),
    ]);
    return changes(out?.[1]) === 1;
  }

  async listOpenPayouts() {
    const res = await this.db
      .prepare("SELECT * FROM presale_payouts WHERE status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT') ORDER BY created_at ASC")
      .all();
    return (res?.results || []).map(rowToPayout);
  }

  async getPayout(id) {
    return rowToPayout(await this.db.prepare('SELECT * FROM presale_payouts WHERE payout_id = ?').bind(id).first());
  }

  async claimPayout(id, fromStatuses, patch) {
    const set = buildSet(patch, PAYOUT_COLS);
    const res = await this.db
      .prepare(`UPDATE presale_payouts SET ${set.sql} WHERE payout_id = ? AND status IN (${fromStatuses.map(() => '?').join(', ')})`)
      .bind(...set.vals, id, ...fromStatuses)
      .run();
    return changes(res) === 1;
  }

  async patchPayout(id, patch) {
    const set = buildSet(patch, PAYOUT_COLS);
    await this.db.prepare(`UPDATE presale_payouts SET ${set.sql} WHERE payout_id = ?`).bind(...set.vals, id).run();
  }

  async patchOrder(id, patch, expect = null) {
    const set = buildSet(patch, ORDER_COLS);
    const cond = expect ? ` AND status IN (${expect.map(() => '?').join(', ')})` : '';
    const res = await this.db
      .prepare(`UPDATE presale_orders SET ${set.sql} WHERE order_id = ?${cond}`)
      .bind(...set.vals, id, ...(expect || []))
      .run();
    return changes(res) === 1;
  }

  async markPayoutSent(payoutId, kind, orderId, inboundTxHash, txHash, nowSec) {
    const stmts = [
      this.db
        .prepare("UPDATE presale_payouts SET status = 'SENT', tx_hash = COALESCE(?, tx_hash), ambiguous = 0, last_error = NULL, updated_at = ? WHERE payout_id = ? AND status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT')")
        .bind(txHash || null, nowSec, payoutId),
    ];
    if (orderId) {
      if (kind === 'A9') {
        stmts.push(
          this.db
            .prepare("UPDATE presale_orders SET status = 'PAYOUT_SENT', payout_tx_hash = COALESCE(?, payout_tx_hash), last_error = NULL, updated_at = ? WHERE order_id = ? AND status IN ('PAYOUT_PENDING', 'PAYOUT_RETRY', 'PAYOUT_SENT')")
            .bind(txHash || null, nowSec, orderId),
        );
      } else if (inboundTxHash) {
        stmts.push(
          this.db
            .prepare("UPDATE presale_orders SET status = 'REFUND_SENT', payout_tx_hash = COALESCE(?, payout_tx_hash), last_error = NULL, updated_at = ? WHERE order_id = ? AND inbound_tx_hash = ? AND status IN ('REFUND_PENDING', 'REFUND_SENT')")
            .bind(txHash || null, nowSec, orderId, inboundTxHash),
        );
      }
    }
    const out = await this.db.batch(stmts);
    return changes(out?.[0]) === 1;
  }

  async markPayoutRetry(payoutId, kind, orderId, inboundTxHash, { ambiguous = false, lastError = null } = {}, nowSec) {
    const stmts = [
      this.db
        .prepare("UPDATE presale_payouts SET status = 'RETRY', ambiguous = ?, last_error = ?, updated_at = ? WHERE payout_id = ? AND status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT')")
        .bind(ambiguous ? 1 : 0, lastError, nowSec, payoutId),
    ];
    if (orderId) {
      if (kind === 'A9') {
        stmts.push(
          this.db
            .prepare("UPDATE presale_orders SET status = 'PAYOUT_RETRY', last_error = ?, updated_at = ? WHERE order_id = ? AND status IN ('PAYOUT_PENDING', 'PAYOUT_RETRY', 'PAYOUT_SENT')")
            .bind(lastError, nowSec, orderId),
        );
      } else if (inboundTxHash) {
        stmts.push(
          this.db
            .prepare("UPDATE presale_orders SET status = 'REFUND_PENDING', last_error = ?, updated_at = ? WHERE order_id = ? AND inbound_tx_hash = ? AND status IN ('REFUND_PENDING', 'REFUND_SENT')")
            .bind(lastError, nowSec, orderId, inboundTxHash),
        );
      }
    }
    const out = await this.db.batch(stmts);
    return changes(out?.[0]) === 1;
  }

  async markPayoutNeedsReview(payoutId, kind, orderId, inboundTxHash, reason, nowSec) {
    const stmts = [
      this.db
        .prepare("UPDATE presale_payouts SET status = 'NEEDS_REVIEW', last_error = ?, updated_at = ? WHERE payout_id = ? AND status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT')")
        .bind(reason, nowSec, payoutId),
    ];
    if (orderId) {
      if (kind === 'A9') {
        stmts.push(
          this.db
            .prepare("UPDATE presale_orders SET status = 'NEEDS_REVIEW', last_error = ?, updated_at = ? WHERE order_id = ? AND status IN ('PAYOUT_PENDING', 'PAYOUT_RETRY', 'PAYOUT_SENT')")
            .bind(reason, nowSec, orderId),
        );
      } else if (inboundTxHash) {
        stmts.push(
          this.db
            .prepare("UPDATE presale_orders SET status = 'NEEDS_REVIEW', last_error = ?, updated_at = ? WHERE order_id = ? AND inbound_tx_hash = ? AND status IN ('REFUND_PENDING', 'REFUND_SENT')")
            .bind(reason, nowSec, orderId, inboundTxHash),
        );
      }
    }
    const out = await this.db.batch(stmts);
    return changes(out?.[0]) === 1;
  }

  async completeA9(payoutId, orderId, txHash, credit, nowSec) {
    const stmts = [
      this.db
        .prepare("UPDATE presale_payouts SET status = 'CONFIRMED', tx_hash = COALESCE(?, tx_hash), updated_at = ? WHERE payout_id = ? AND kind = 'A9' AND status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT')")
        .bind(txHash || null, nowSec, payoutId),
      this.db
        .prepare("UPDATE presale_orders SET status = 'COMPLETED', payout_tx_hash = COALESCE(?, payout_tx_hash), updated_at = ? WHERE order_id = ? AND status IN ('PAYOUT_PENDING', 'PAYOUT_RETRY', 'PAYOUT_SENT')")
        .bind(txHash || null, nowSec, orderId),
    ];
    if (credit) {
      stmts.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO presale_referral_credits (order_id, referrer, amount_raw, status, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM presale_orders WHERE order_id = ? AND status = 'COMPLETED')`,
          )
          .bind(credit.orderId, credit.referrer, credit.amountRaw, credit.status, credit.createdAt, credit.updatedAt, orderId),
      );
    }
    const out = await this.db.batch(stmts);
    return changes(out?.[0]) === 1;
  }

  /**
   * 原子确认退款（P0-E）：同一事务中更新退款 payout 为 CONFIRMED，
   * 且仅当 orderId 与 inboundTxHash 绑定吻合且处于 REFUND_PENDING/REFUND_SENT 时才更新该订单为 REFUNDED。
   * 任一步失败整个 batch 回滚，重启后可安全重新核验而不重复广播。
   */
  async completeRefund(payoutId, orderId, inboundTxHash, txHash, nowSec) {
    const stmts = [
      this.db
        .prepare("UPDATE presale_payouts SET status = 'CONFIRMED', tx_hash = COALESCE(?, tx_hash), updated_at = ? WHERE payout_id = ? AND kind = 'REFUND' AND status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT')")
        .bind(txHash || null, nowSec, payoutId),
    ];
    if (orderId && inboundTxHash) {
      stmts.push(
        this.db
          .prepare("UPDATE presale_orders SET status = 'REFUNDED', payout_tx_hash = COALESCE(?, payout_tx_hash), updated_at = ? WHERE order_id = ? AND inbound_tx_hash = ? AND status IN ('REFUND_PENDING', 'REFUND_SENT')")
          .bind(txHash || null, nowSec, orderId, inboundTxHash),
      );
    }
    const out = await this.db.batch(stmts);
    return changes(out?.[0]) === 1;
  }

  async listCredits(status) {
    const res = await this.db.prepare('SELECT * FROM presale_referral_credits WHERE status = ?').bind(status).all();
    return (res?.results || []).map(rowToCredit);
  }

  async getCredit(orderId) {
    return rowToCredit(await this.db.prepare('SELECT * FROM presale_referral_credits WHERE order_id = ?').bind(orderId).first());
  }

  async claimCredit(orderId, from, to, nowSec) {
    const res = await this.db
      .prepare('UPDATE presale_referral_credits SET status = ?, updated_at = ? WHERE order_id = ? AND status = ?')
      .bind(to, nowSec, orderId, from)
      .run();
    return changes(res) === 1;
  }

  async patchCredit(orderId, patch) {
    await this.db
      .prepare('UPDATE presale_referral_credits SET status = ?, updated_at = ? WHERE order_id = ?')
      .bind(patch.status, patch.updatedAt, orderId)
      .run();
  }
}

/** D1-backed presale engine (production). Constructor options match PresaleHotWalletEngine + `db`. */
export class D1PresaleStore extends PresaleEngine {
  constructor({ db, ...opts }) {
    super({ ...opts, repo: new D1PresaleRepo({ db }) });
  }
}

async function queryAllRows(db, sql) {
  const res = await db.prepare(sql).all();
  return Array.isArray(res) ? res : (res?.results || []);
}

/**
 * Read-only BigInt historical ledger reconciliation for prediction activations -> promo_balances.
 * - Accepts either a Cloudflare D1 binding (`createSqliteD1` / Miniflare) or a read-only `node:sqlite` DatabaseSync.
 * - For ledger-backed activations (`prediction_activations`), verifies credit against the ORIGINAL `wallet_key`
 *   recorded on each activation row so subsequent wallet rebinding NEVER triggers a false positive.
 * - For legacy pre-0008 activations lacking `prediction_activations` rows, marks records as
 *   `MANUAL_REVIEW_INSUFFICIENT_EVIDENCE` (distinguishing missing bindings, rebound/shortfall, and mixed promo balances).
 * - Uses pure `BigInt` decimal strings throughout (safe well beyond 64-bit SQLite INTEGER limits).
 */
export async function reconcilePredictionLedger(db) {
  const rewards = await queryAllRows(
    db,
    'SELECT user_id, pending_activation_raw, activated_raw, updated_at FROM prediction_rewards',
  );
  const bindings = new Map(
    (await queryAllRows(db, 'SELECT tg_user_id, wallet_address, wallet_key FROM wallet_bindings')).map((r) => [
      String(r.tg_user_id),
      r,
    ]),
  );

  let activationRows = [];
  try {
    activationRows = await queryAllRows(
      db,
      'SELECT activation_id, user_id, wallet_key, wallet_address, amount_raw, created_at FROM prediction_activations',
    );
  } catch {
    activationRows = [];
  }

  const promoTotalByWallet = new Map();
  for (const r of await queryAllRows(db, 'SELECT wallet_address, claimable_raw, total_claimed_raw FROM promo_balances')) {
    const key = addressKey(r.wallet_address);
    const total = BigInt(r.claimable_raw || '0') + BigInt(r.total_claimed_raw || '0');
    promoTotalByWallet.set(key, (promoTotalByWallet.get(key) || 0n) + total);
  }

  const ledgerByUserWallet = new Map();
  const globalLedgerByWallet = new Map();
  for (const r of activationRows) {
    const uid = String(r.user_id);
    const origKey = addressKey(r.wallet_key || r.wallet_address);
    const amt = BigInt(r.amount_raw || '0');
    if (!ledgerByUserWallet.has(uid)) ledgerByUserWallet.set(uid, new Map());
    const uMap = ledgerByUserWallet.get(uid);
    uMap.set(origKey, (uMap.get(origKey) || 0n) + amt);
    globalLedgerByWallet.set(origKey, (globalLedgerByWallet.get(origKey) || 0n) + amt);
  }

  const rewardsByUser = new Map(rewards.map((r) => [String(r.user_id), r]));
  const allUserIds = new Set([...rewardsByUser.keys(), ...ledgerByUserWallet.keys()]);

  const findings = [];
  let okUsers = 0;

  for (const uid of allUserIds) {
    const pr = rewardsByUser.get(uid) || null;
    const activated = BigInt(pr?.activated_raw || '0');
    const uWallets = ledgerByUserWallet.get(uid) || new Map();

    let ledgerSum = 0n;
    const missingOriginalWallets = [];
    for (const [origKey, wAmt] of uWallets.entries()) {
      ledgerSum += wAmt;
      const promoTotal = promoTotalByWallet.get(origKey) || 0n;
      const globalExpected = globalLedgerByWallet.get(origKey) || wAmt;
      if (promoTotal < wAmt || promoTotal < globalExpected) {
        missingOriginalWallets.push({
          walletKeyTail: origKey.slice(-6),
          ledgerExpectedRaw: wAmt.toString(),
          globalWalletLedgerRaw: globalExpected.toString(),
          promoTotalRaw: promoTotal.toString(),
        });
      }
    }

    if (activated === 0n && ledgerSum === 0n) continue;

    if (ledgerSum > activated) {
      findings.push({
        userIdTail: uid.slice(-4),
        status: 'DISCREPANCY_LEDGER_EXCEEDS_ACTIVATED',
        reason: activated === 0n ? 'ledger_exists_with_zero_activated' : 'ledger_sum_exceeds_activated_raw',
        activatedRaw: activated.toString(),
        ledgerSumRaw: ledgerSum.toString(),
        excessRaw: (ledgerSum - activated).toString(),
        ...(missingOriginalWallets.length > 0 ? { shortfalls: missingOriginalWallets } : {}),
      });
      continue;
    }

    if (missingOriginalWallets.length > 0) {
      findings.push({
        userIdTail: uid.slice(-4),
        status: 'DISCREPANCY_MISSING_PROMO_CREDIT',
        reason: 'original_wallet_promo_shortfall',
        activatedRaw: activated.toString(),
        ledgerSumRaw: ledgerSum.toString(),
        shortfalls: missingOriginalWallets,
      });
      continue;
    }

    const legacyRemainder = activated - ledgerSum;
    if (legacyRemainder > 0n) {
      const bind = bindings.get(uid);
      if (!bind) {
        findings.push({
          userIdTail: uid.slice(-4),
          status: 'MANUAL_REVIEW_INSUFFICIENT_EVIDENCE',
          reason: 'legacy_pre_0008_missing_wallet_binding',
          activatedRaw: activated.toString(),
          ledgerSumRaw: ledgerSum.toString(),
          legacyUnbackedRaw: legacyRemainder.toString(),
          promoTotalCurrentWalletRaw: null,
        });
        continue;
      }
      const curKey = addressKey(bind.wallet_key || bind.wallet_address);
      const curPromoTotal = promoTotalByWallet.get(curKey) || 0n;
      const curLedgerOnSameWallet = uWallets.get(curKey) || 0n;
      const remainingPromoOnCur = curPromoTotal > curLedgerOnSameWallet ? curPromoTotal - curLedgerOnSameWallet : 0n;
      findings.push({
        userIdTail: uid.slice(-4),
        status: 'MANUAL_REVIEW_INSUFFICIENT_EVIDENCE',
        reason: remainingPromoOnCur < legacyRemainder
          ? 'legacy_pre_0008_shortfall_or_wallet_rebound'
          : 'legacy_pre_0008_unbacked_or_mixed_promo',
        activatedRaw: activated.toString(),
        ledgerSumRaw: ledgerSum.toString(),
        legacyUnbackedRaw: legacyRemainder.toString(),
        promoTotalCurrentWalletRaw: curPromoTotal.toString(),
      });
      continue;
    }

    okUsers += 1;
  }

  return {
    checkedUsers: allUserIds.size,
    okUsers,
    findings,
  };
}
