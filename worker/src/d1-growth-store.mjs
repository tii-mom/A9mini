// A9 Protocol v15 — Cloudflare D1 Persistence Adapters for Social, Prediction & Presale.
// Matches worker/schema.sql tables and mirrors the in-memory engine interfaces 1:1.
import {
  rewardForWarmupRank,
  SocialError,
  TEAM_SWITCH_COOLDOWN_SEC,
  DEFAULT_WARMUP_ROUND_CONFIG,
  WARMUP_INTENT_A9_ESTIMATE,
  normalizeWarmupIntentTier,
  maskWarmupUser,
} from './social-store.mjs';
import {
  GrowthError,
  VOUCHER_TTL_MS,
  DEFAULT_FIRST_LOSS_BONUS_RAW,
  DEFAULT_FIRST_LOSS_CAP_RAW,
  PRED_POOL_PER_BET_RAW,
  MAX_PRED_REWARD_PER_USER_RAW,
  computeNextPendingState,
  DAILY_STAMP_KEYS,
  PROGRESSION_TASKS,
  utcDayFromSec,
  prevUtcDay,
  levelFromExp,
  computeEffectiveStreak,
  buildProgressionSummary,
} from './growth-engine.mjs';
import { PresaleEngine, PresaleError, PRESALE_STATUS, REFERRAL_BPS, RESERVING_STATUSES } from './presale-hotwallet.mjs';
import { CHEST_MALL_CATALOG, CHEST_MALL_NANO_TO_SKU } from './chest-engine.mjs';
import { D1PromoBudgetLedger } from './promo-budget.mjs';
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
    // 校验队长是否已归属他队及 7 天换队冷却，防止通过新建战队绕过 joinTeam 冷却并造成旧队人数虚高
    const capAliases = addressAliases(captainWallet);
    const capPh = capAliases.map(() => '?').join(', ');
    const prevRow = capAliases.length
      ? await this.db
          .prepare(`SELECT wallet_address, team_id, joined_at FROM team_members WHERE wallet_address IN (${capPh}) LIMIT 1`)
          .bind(...capAliases)
          .first()
      : null;
    const prevTeamId = prevRow?.team_id ? String(prevRow.team_id) : null;
    const prevJoinedAt = prevRow?.joined_at ? Number(prevRow.joined_at) : 0;
    if (prevTeamId && prevTeamId !== teamId && prevJoinedAt > 0 && nowSec < prevJoinedAt + TEAM_SWITCH_COOLDOWN_SEC) {
      throw new SocialError('TEAM_SWITCH_COOLDOWN', '更换战队需间隔 7 天冷却期');
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

    const effectiveJoinedAt = prevTeamId === teamId && prevJoinedAt > 0 ? prevJoinedAt : nowSec;
    if (prevRow && prevRow.wallet_address !== captainWallet) {
      await this.db.prepare('DELETE FROM team_members WHERE wallet_address = ?').bind(prevRow.wallet_address).run();
    }
    await this.db
      .prepare('INSERT OR REPLACE INTO team_members (wallet_address, team_id, joined_at) VALUES (?, ?, ?)')
      .bind(captainWallet, teamId, effectiveJoinedAt)
      .run();

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

    const memberAliases = addressAliases(walletAddress);
    const aliasPh = memberAliases.map(() => '?').join(', ');
    const prevRow = memberAliases.length
      ? await this.db
          .prepare(`SELECT wallet_address, team_id, joined_at FROM team_members WHERE wallet_address IN (${aliasPh}) LIMIT 1`)
          .bind(...memberAliases)
          .first()
      : null;
    const prevTeamId = prevRow?.team_id ? String(prevRow.team_id) : null;
    const prevJoinedAt = prevRow?.joined_at ? Number(prevRow.joined_at) : 0;
    if (prevTeamId && prevTeamId !== teamId && prevJoinedAt > 0 && nowSec < prevJoinedAt + TEAM_SWITCH_COOLDOWN_SEC) {
      throw new SocialError('TEAM_SWITCH_COOLDOWN', '更换战队需间隔 7 天冷却期');
    }
    if (referrerId) await this.bindReferral(walletAddress, referrerId, nowSec, { aliases });

    const effectiveJoinedAt = prevTeamId === teamId && prevJoinedAt > 0 ? prevJoinedAt : nowSec;
    if (prevRow && prevRow.wallet_address !== walletAddress) {
      await this.db.prepare('DELETE FROM team_members WHERE wallet_address = ?').bind(prevRow.wallet_address).run();
    }
    await this.db
      .prepare('INSERT OR REPLACE INTO team_members (wallet_address, team_id, joined_at) VALUES (?, ?, ?)')
      .bind(walletAddress, teamId, effectiveJoinedAt)
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

  async listTeamMembersWithJoinTime(teamId) {
    const res = await this.db
      .prepare('SELECT wallet_address, joined_at FROM team_members WHERE team_id = ?')
      .bind(String(teamId))
      .all();
    return (res?.results || []).map((r) => ({
      walletAddress: String(r.wallet_address),
      joinedAt: Number(r.joined_at || 0),
    }));
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

  _formatReservationRow(r) {
    if (!r) return null;
    return {
      roundId: Number(r.round_id),
      tgUserId: String(r.tg_user_id),
      walletAddress: r.wallet_address || null,
      walletKey: r.wallet_key || null,
      walletActive: Number(r.wallet_active || 0) === 1,
      referrerTgId: r.referrer_tg_id || null,
      intentTier: r.intent_tier || null,
      remindEnabled: Number(r.remind_enabled ?? 1) === 1,
      remindedAt: r.reminded_at === null || r.reminded_at === undefined ? null : Number(r.reminded_at),
      rawInvites: Number(r.raw_invites || 0),
      validInvites: Number(r.valid_invites || 0),
      status: String(r.status),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  async getWarmupRoundConfig(roundId) {
    const rId = Number(roundId || 1);
    try {
      const r = await this.db.prepare('SELECT * FROM warmup_rounds WHERE round_id = ? LIMIT 1').bind(rId).first();
      if (!r) return { roundId: rId, ...DEFAULT_WARMUP_ROUND_CONFIG };
      return {
        roundId: Number(r.round_id),
        status: String(r.status || 'OPEN'),
        plannedOpenAt: r.planned_open_at === null || r.planned_open_at === undefined ? null : Number(r.planned_open_at),
        targetUsers: Number(r.target_users || DEFAULT_WARMUP_ROUND_CONFIG.targetUsers),
        chestBaseA9Raw: String(r.chest_base_a9_raw || DEFAULT_WARMUP_ROUND_CONFIG.chestBaseA9Raw),
        chestStepA9Raw: String(r.chest_step_a9_raw || DEFAULT_WARMUP_ROUND_CONFIG.chestStepA9Raw),
        chestMinInvites: Number(r.chest_min_invites || DEFAULT_WARMUP_ROUND_CONFIG.chestMinInvites),
        chestMaxInvites: Number(r.chest_max_invites || DEFAULT_WARMUP_ROUND_CONFIG.chestMaxInvites),
        createdAt: Number(r.created_at || 0),
        updatedAt: Number(r.updated_at || 0),
      };
    } catch (e) {
      if (/no such table/i.test(String(e?.message || e))) return { roundId: rId, ...DEFAULT_WARMUP_ROUND_CONFIG };
      throw e;
    }
  }

  async upsertWarmupRoundConfig(
    {
      roundId,
      status = undefined,
      plannedOpenAt = undefined,
      targetUsers = undefined,
      chestBaseA9Raw = undefined,
      chestStepA9Raw = undefined,
      chestMinInvites = undefined,
      chestMaxInvites = undefined,
    },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    const rId = Number(roundId);
    if (!Number.isInteger(rId) || rId < 1) throw new SocialError('BAD_REQUEST', 'roundId must be a positive integer');
    const cur = await this.getWarmupRoundConfig(rId);
    const nextStatus = status !== undefined ? String(status).trim().toUpperCase() : cur.status;
    if (!['OPEN', 'PAUSED', 'CLOSED'].includes(nextStatus)) throw new SocialError('BAD_REQUEST', 'invalid warmup round status');
    const nextTarget = targetUsers !== undefined ? Math.max(1, Number(targetUsers)) : cur.targetUsers;
    const nextMin = chestMinInvites !== undefined ? Math.max(1, Number(chestMinInvites)) : cur.chestMinInvites;
    const nextMax = chestMaxInvites !== undefined ? Math.max(nextMin, Number(chestMaxInvites)) : Math.max(nextMin, cur.chestMaxInvites);
    const nextPlanned = plannedOpenAt === undefined ? cur.plannedOpenAt : (plannedOpenAt === null ? null : Number(plannedOpenAt));
    const nextBase = chestBaseA9Raw !== undefined ? String(BigInt(String(chestBaseA9Raw))) : cur.chestBaseA9Raw;
    const nextStep = chestStepA9Raw !== undefined ? String(BigInt(String(chestStepA9Raw))) : cur.chestStepA9Raw;

    await this.db
      .prepare(
        `INSERT INTO warmup_rounds
         (round_id, status, planned_open_at, target_users, chest_base_a9_raw, chest_step_a9_raw, chest_min_invites, chest_max_invites, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(round_id) DO UPDATE SET
           status = excluded.status,
           planned_open_at = excluded.planned_open_at,
           target_users = excluded.target_users,
           chest_base_a9_raw = excluded.chest_base_a9_raw,
           chest_step_a9_raw = excluded.chest_step_a9_raw,
           chest_min_invites = excluded.chest_min_invites,
           chest_max_invites = excluded.chest_max_invites,
           updated_at = excluded.updated_at`,
      )
      .bind(rId, nextStatus, nextPlanned, nextTarget, nextBase, nextStep, nextMin, nextMax, cur.createdAt || nowSec, nowSec)
      .run();
    return this.getWarmupRoundConfig(rId);
  }

  async _findActiveReservationRowByRef(roundId, refId) {
    const rId = Number(roundId);
    const clean = String(refId || '').trim();
    if (!clean) return null;
    const direct = await this.db
      .prepare("SELECT * FROM warmup_reservations WHERE round_id = ? AND tg_user_id = ? AND status = 'ACTIVE' LIMIT 1")
      .bind(rId, clean)
      .first();
    if (direct) return direct;
    const refKey = addressKey(clean);
    if (!refKey) return null;
    return this.db
      .prepare("SELECT * FROM warmup_reservations WHERE round_id = ? AND wallet_key = ? AND status = 'ACTIVE' LIMIT 1")
      .bind(rId, refKey)
      .first();
  }

  async _recomputeReferrerInvites(roundId, refId, nowSec) {
    const rId = Number(roundId);
    const refRow = await this._findActiveReservationRowByRef(rId, refId);
    if (!refRow) return null;
    const refUid = String(refRow.tg_user_id);
    const refWallet = refRow.wallet_address ? String(refRow.wallet_address) : null;
    const refKey = refRow.wallet_key ? String(refRow.wallet_key) : null;
    const candidates = Array.from(new Set([refUid, refWallet, refKey].filter(Boolean)));
    const ph = candidates.map(() => '?').join(', ');
    const agg = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS raw_cnt,
           SUM(CASE WHEN wallet_key IS NOT NULL AND wallet_active = 1 THEN 1 ELSE 0 END) AS valid_cnt
         FROM warmup_reservations
         WHERE round_id = ? AND status = 'ACTIVE' AND tg_user_id != ? AND referrer_tg_id IN (${ph})`,
      )
      .bind(rId, refUid, ...candidates)
      .first();
    const rawInvites = Number(agg?.raw_cnt || 0);
    const validInvites = Number(agg?.valid_cnt || 0);
    await this.db
      .prepare('UPDATE warmup_reservations SET raw_invites = ?, valid_invites = ?, updated_at = ? WHERE round_id = ? AND tg_user_id = ?')
      .bind(rawInvites, validInvites, nowSec, rId, refUid)
      .run();
    return { tgUserId: refUid, rawInvites, validInvites };
  }

  async reserveWarmup(
    { roundId = 1, tgUserId, walletAddress = null, walletActive = false, referrerId = null, intentTier = undefined, remindEnabled = undefined },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    const rId = Number(roundId);
    const uid = String(tgUserId || '').trim();
    if (!uid || !Number.isInteger(rId) || rId < 1) throw new SocialError('BAD_REQUEST', 'valid roundId and tgUserId required');
    const cfg = await this.getWarmupRoundConfig(rId);
    if (cfg.status !== 'OPEN') throw new SocialError('WARMUP_CLOSED', '本轮预热预约当前未开放');

    const normIntent = normalizeWarmupIntentTier(intentTier);
    const cleanWallet = walletAddress ? String(walletAddress).trim() : null;
    const wKey = cleanWallet ? addressKey(cleanWallet) : null;
    if (wKey) {
      const conflict = await this.db
        .prepare('SELECT tg_user_id FROM warmup_reservations WHERE round_id = ? AND wallet_key = ? AND tg_user_id != ? LIMIT 1')
        .bind(rId, wKey, uid)
        .first();
      if (conflict) throw new SocialError('WALLET_ALREADY_RESERVED', '该 TON 钱包已在本轮完成预热预约');
    }

    const rawRef = String(referrerId || '').trim() || null;
    if (rawRef && rawRef !== uid) {
      await this.bindReferral(uid, rawRef, nowSec, { aliases: cleanWallet ? [cleanWallet] : [] });
    }
    const storedRef = (await this.getReferrer(uid)) || (cleanWallet ? await this.getReferrer(cleanWallet) : null) || rawRef;
    const effectiveRef = storedRef && storedRef !== uid && (!wKey || addressKey(storedRef) !== wKey) ? storedRef : null;

    const existing = await this.db
      .prepare('SELECT * FROM warmup_reservations WHERE round_id = ? AND tg_user_id = ? LIMIT 1')
      .bind(rId, uid)
      .first();
    const isNewSignup = !existing;

    const nextWallet = cleanWallet || existing?.wallet_address || null;
    const nextWalletKey = wKey || existing?.wallet_key || null;
    const nextWalletActive = (Number(existing?.wallet_active || 0) === 1 || (Boolean(cleanWallet) && Boolean(walletActive))) ? 1 : 0;
    const nextRef = existing?.referrer_tg_id || effectiveRef || null;
    const nextIntent = normIntent !== undefined ? normIntent : (existing?.intent_tier ?? null);
    const nextRemind = remindEnabled !== undefined ? (remindEnabled ? 1 : 0) : Number(existing?.remind_enabled ?? 1);

    try {
      await this.db
        .prepare(
          `INSERT INTO warmup_reservations
           (round_id, tg_user_id, wallet_address, wallet_key, wallet_active, referrer_tg_id, intent_tier, remind_enabled, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
           ON CONFLICT(round_id, tg_user_id) DO UPDATE SET
             wallet_address = excluded.wallet_address,
             wallet_key = excluded.wallet_key,
             wallet_active = excluded.wallet_active,
             referrer_tg_id = COALESCE(warmup_reservations.referrer_tg_id, excluded.referrer_tg_id),
             intent_tier = excluded.intent_tier,
             remind_enabled = excluded.remind_enabled,
             status = 'ACTIVE',
             updated_at = excluded.updated_at`,
        )
        .bind(rId, uid, nextWallet, nextWalletKey, nextWalletActive, nextRef, nextIntent, nextRemind, existing ? Number(existing.created_at) : nowSec, nowSec)
        .run();
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e?.message || e))) {
        throw new SocialError('WALLET_ALREADY_RESERVED', '该 TON 钱包已在本轮完成预热预约');
      }
      throw e;
    }

    // 权威 COUNT(*) 重算：同时更新本人（若为推荐人恢复 ACTIVE）及上级推荐人的有效计数，彻底杜绝并发双计与取消漂移
    await this._recomputeReferrerInvites(rId, uid, nowSec);
    let referrerUpdated = null;
    if (nextRef) {
      const updated = await this._recomputeReferrerInvites(rId, nextRef, nowSec);
      if (updated && updated.tgUserId !== uid) referrerUpdated = updated;
    }

    const saved = await this.db.prepare('SELECT * FROM warmup_reservations WHERE round_id = ? AND tg_user_id = ? LIMIT 1').bind(rId, uid).first();
    return { reservation: this._formatReservationRow(saved), referrerUpdated, isNewSignup };
  }

  async syncWarmupWalletForUser({ tgUserId, walletAddress, walletActive = false, roundIds = null }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(tgUserId || '').trim();
    const cleanWallet = String(walletAddress || '').trim();
    if (!uid || !cleanWallet) return [];
    const wKey = addressKey(cleanWallet);
    const allowed = Array.isArray(roundIds) ? new Set(roundIds.map(Number)) : null;
    let rows = [];
    try {
      const res = await this.db
        .prepare("SELECT * FROM warmup_reservations WHERE tg_user_id = ? AND status = 'ACTIVE'")
        .bind(uid)
        .all();
      rows = res?.results || [];
    } catch (e) {
      if (/no such table/i.test(String(e?.message || e))) return [];
      throw e;
    }
    const updates = [];
    for (const r of rows) {
      const rId = Number(r.round_id);
      if (allowed && !allowed.has(rId)) continue;
      const conflict = await this.db
        .prepare('SELECT 1 AS hit FROM warmup_reservations WHERE round_id = ? AND wallet_key = ? AND tg_user_id != ? LIMIT 1')
        .bind(rId, wKey, uid)
        .first();
      if (conflict?.hit) continue;
      const nextActive = (Number(r.wallet_active || 0) === 1 || walletActive) ? 1 : 0;
      try {
        await this.db
          .prepare('UPDATE warmup_reservations SET wallet_address = ?, wallet_key = ?, wallet_active = ?, updated_at = ? WHERE round_id = ? AND tg_user_id = ?')
          .bind(cleanWallet, wKey, nextActive, nowSec, rId, uid)
          .run();
      } catch (e) {
        if (/UNIQUE|constraint/i.test(String(e?.message || e))) continue;
        throw e;
      }
      let referrerUpdated = null;
      if (r.referrer_tg_id) {
        const updated = await this._recomputeReferrerInvites(rId, r.referrer_tg_id, nowSec);
        if (updated && updated.tgUserId !== uid) referrerUpdated = updated;
      }
      const fresh = await this.db.prepare('SELECT * FROM warmup_reservations WHERE round_id = ? AND tg_user_id = ? LIMIT 1').bind(rId, uid).first();
      updates.push({ roundId: rId, reservation: this._formatReservationRow(fresh), referrerUpdated });
    }
    return updates;
  }

  async cancelWarmupReservation({ roundId = 1, tgUserId }, nowSec = Math.floor(Date.now() / 1000)) {
    const rId = Number(roundId);
    const uid = String(tgUserId || '').trim();
    const existing = await this.db.prepare('SELECT * FROM warmup_reservations WHERE round_id = ? AND tg_user_id = ? LIMIT 1').bind(rId, uid).first();
    if (!existing) return null;
    await this.db
      .prepare("UPDATE warmup_reservations SET status = 'CANCELLED', updated_at = ? WHERE round_id = ? AND tg_user_id = ?")
      .bind(nowSec, rId, uid)
      .run();
    let referrerUpdated = null;
    if (existing.referrer_tg_id) {
      const updated = await this._recomputeReferrerInvites(rId, existing.referrer_tg_id, nowSec);
      if (updated && updated.tgUserId !== uid) referrerUpdated = updated;
    }
    return { ...this._formatReservationRow(existing), status: 'CANCELLED', updatedAt: nowSec, referrerUpdated };
  }

  async getWarmupReservation(roundId, tgUserId) {
    const row = await this.db
      .prepare('SELECT * FROM warmup_reservations WHERE round_id = ? AND tg_user_id = ? LIMIT 1')
      .bind(Number(roundId), String(tgUserId || '').trim())
      .first();
    return this._formatReservationRow(row);
  }

  async getWarmupRoundStats(roundId) {
    const rId = Number(roundId);
    const row = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_registered,
           SUM(CASE WHEN wallet_key IS NOT NULL THEN 1 ELSE 0 END) AS wallet_bound,
           SUM(CASE WHEN wallet_active = 1 THEN 1 ELSE 0 END) AS active_wallet,
           SUM(CASE WHEN remind_enabled = 1 THEN 1 ELSE 0 END) AS remind_enabled
         FROM warmup_reservations
         WHERE round_id = ? AND status = 'ACTIVE'`,
      )
      .bind(rId)
      .first();
    return {
      roundId: rId,
      totalRegistered: Number(row?.total_registered || 0),
      walletBoundCount: Number(row?.wallet_bound || 0),
      activeWalletCount: Number(row?.active_wallet || 0),
      remindEnabledCount: Number(row?.remind_enabled || 0),
    };
  }

  async getWarmupLeaderboardV2(roundId = 1, limit = 50) {
    const res = await this.db
      .prepare(
        `SELECT tg_user_id, wallet_address, wallet_key, valid_invites, raw_invites
         FROM warmup_reservations
         WHERE round_id = ? AND status = 'ACTIVE'
         ORDER BY valid_invites DESC, raw_invites DESC, created_at ASC LIMIT ?`,
      )
      .bind(Number(roundId), Number(limit))
      .all();
    return (res?.results || []).map((r, i) => ({
      rank: i + 1,
      label: maskWarmupUser(r.tg_user_id, r.wallet_address),
      walletAddress: maskWarmupUser(r.tg_user_id, r.wallet_address),
      validInvites: Number(r.valid_invites || 0),
      rawInvites: Number(r.raw_invites || 0),
      walletBound: Boolean(r.wallet_key),
    }));
  }

  async getWarmupAdminSummary(roundId, { readyWalletSet = null, actualOnchainStakers = null } = {}) {
    const rId = Number(roundId);
    const config = await this.getWarmupRoundConfig(rId);
    const res = await this.db
      .prepare('SELECT * FROM warmup_reservations WHERE round_id = ? ORDER BY valid_invites DESC, raw_invites DESC, created_at ASC')
      .bind(rId)
      .all();
    const rows = res?.results || [];
    const intentBreakdown = { '100': 0, '1000': 0, '5000': 0, '20000_plus': 0, watching: 0, unset: 0 };
    let totalActive = 0;
    let totalCancelled = 0;
    let walletBoundCount = 0;
    let activeWalletCount = 0;
    let remindEnabledCount = 0;
    let remindedCount = 0;
    let readyCapitalCount = 0;
    let estimatedIntentA9Min = 0;
    const topInviters = [];

    for (const r of rows) {
      if (String(r.status) !== 'ACTIVE') {
        totalCancelled += 1;
        continue;
      }
      totalActive += 1;
      if (r.wallet_key) walletBoundCount += 1;
      if (Number(r.wallet_active || 0) === 1) activeWalletCount += 1;
      if (Number(r.remind_enabled ?? 1) === 1) remindEnabledCount += 1;
      if (r.reminded_at) remindedCount += 1;
      if (readyWalletSet && r.wallet_key && readyWalletSet.has(String(r.wallet_key))) readyCapitalCount += 1;
      const tier = r.intent_tier ? String(r.intent_tier) : null;
      if (tier && Object.prototype.hasOwnProperty.call(intentBreakdown, tier)) {
        intentBreakdown[tier] += 1;
        estimatedIntentA9Min += WARMUP_INTENT_A9_ESTIMATE[tier] || 0;
      } else {
        intentBreakdown.unset += 1;
      }
      if ((Number(r.raw_invites || 0) > 0 || Number(r.valid_invites || 0) > 0) && topInviters.length < 20) {
        topInviters.push({
          rank: topInviters.length + 1,
          tgUserId: String(r.tg_user_id),
          walletAddress: r.wallet_address || null,
          validInvites: Number(r.valid_invites || 0),
          rawInvites: Number(r.raw_invites || 0),
          intentTier: tier,
        });
      }
    }
    const stakers = actualOnchainStakers === null || actualOnchainStakers === undefined ? null : Number(actualOnchainStakers);
    const conversionRatePct = stakers !== null && totalActive > 0 ? Number(((stakers / totalActive) * 100).toFixed(2)) : null;
    return {
      roundId: rId,
      config,
      totalActive,
      totalCancelled,
      walletBoundCount,
      activeWalletCount,
      readyCapitalCount,
      remindEnabledCount,
      remindedCount,
      intentBreakdown,
      estimatedIntentA9Min,
      topInviters,
      actualOnchainStakers: stakers,
      conversionRatePct,
    };
  }

  async listPendingWarmupReminders(roundId, limit = 25) {
    const res = await this.db
      .prepare(
        `SELECT * FROM warmup_reservations
         WHERE round_id = ? AND status = 'ACTIVE' AND remind_enabled = 1 AND reminded_at IS NULL
         ORDER BY created_at ASC LIMIT ?`,
      )
      .bind(Number(roundId), Number(limit))
      .all();
    return (res?.results || []).map((r) => this._formatReservationRow(r));
  }

  async markWarmupReminded(roundId, tgUserId, nowSec = Math.floor(Date.now() / 1000)) {
    const res = await this.db
      .prepare('UPDATE warmup_reservations SET reminded_at = ?, updated_at = ? WHERE round_id = ? AND tg_user_id = ? AND reminded_at IS NULL')
      .bind(nowSec, nowSec, Number(roundId), String(tgUserId || '').trim())
      .run();
    return Number(res?.meta?.changes ?? res?.changes ?? 0) === 1;
  }

  async getNotificationPrefs(tgUserId) {
    const uid = String(tgUserId || '').trim();
    if (!uid) throw new SocialError('BAD_REQUEST', 'tgUserId required');
    const row = await this.db
      .prepare('SELECT tg_user_id, settlement_push, updated_at FROM user_notification_prefs WHERE tg_user_id = ?')
      .bind(uid)
      .first();
    return {
      tgUserId: uid,
      settlementPush: row ? Number(row.settlement_push) === 1 : true,
      hourlyCandlePush: false,
      subscribedExplicitly: Boolean(row),
      updatedAt: row ? Number(row.updated_at) : null,
    };
  }

  async setNotificationPrefs(tgUserId, { settlementPush }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(tgUserId || '').trim();
    if (!uid) throw new SocialError('BAD_REQUEST', 'tgUserId required');
    const next = Boolean(settlementPush);
    await this.db
      .prepare(
        `INSERT INTO user_notification_prefs (tg_user_id, settlement_push, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(tg_user_id) DO UPDATE SET
           settlement_push = excluded.settlement_push,
           updated_at = excluded.updated_at`,
      )
      .bind(uid, next ? 1 : 0, Number(nowSec))
      .run();
    return {
      tgUserId: uid,
      settlementPush: next,
      hourlyCandlePush: false,
      subscribedExplicitly: true,
      updatedAt: Number(nowSec),
    };
  }

  async ensureDefaultNotificationPrefs(tgUserId, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(tgUserId || '').trim();
    if (!uid) throw new SocialError('BAD_REQUEST', 'tgUserId required');
    await this.db
      .prepare('INSERT OR IGNORE INTO user_notification_prefs (tg_user_id, settlement_push, updated_at) VALUES (?, 1, ?)')
      .bind(uid, Number(nowSec))
      .run();
    return this.getNotificationPrefs(uid);
  }

  async disableSettlementPush(tgUserId, nowSec = Math.floor(Date.now() / 1000)) {
    return this.setNotificationPrefs(tgUserId, { settlementPush: false }, nowSec);
  }

  async listSettlementPushSubscribers({ limit = 25 } = {}) {
    const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 25)));
    const res = await this.db
      .prepare(
        `SELECT tg_user_id FROM user_notification_prefs
         WHERE settlement_push = 1
         ORDER BY updated_at ASC, tg_user_id ASC
         LIMIT ?`,
      )
      .bind(lim)
      .all();
    return (res?.results || []).map((r) => String(r.tg_user_id));
  }

  async listPendingSettlementPushUsers(roundId, { limit = 25, maxUpdatedAt = null } = {}) {
    const rId = Math.floor(Number(roundId));
    if (!Number.isInteger(rId) || rId < 1) return [];
    const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 25)));
    const prefix = `settle_dm:${rId}:`;
    const cutoff = maxUpdatedAt !== null && maxUpdatedAt !== undefined && Number(maxUpdatedAt) > 0
      ? Number(maxUpdatedAt)
      : null;
    const sql = cutoff !== null
      ? `SELECT p.tg_user_id
         FROM user_notification_prefs p
         WHERE p.settlement_push = 1
           AND p.updated_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM tg_broadcast_events e
             WHERE e.event_key = ? || p.tg_user_id
           )
         ORDER BY p.updated_at ASC, p.tg_user_id ASC
         LIMIT ?`
      : `SELECT p.tg_user_id
         FROM user_notification_prefs p
         WHERE p.settlement_push = 1
           AND NOT EXISTS (
             SELECT 1 FROM tg_broadcast_events e
             WHERE e.event_key = ? || p.tg_user_id
           )
         ORDER BY p.updated_at ASC, p.tg_user_id ASC
         LIMIT ?`;
    const res = cutoff !== null
      ? await this.db.prepare(sql).bind(cutoff, prefix, lim).all()
      : await this.db.prepare(sql).bind(prefix, lim).all();
    return (res?.results || []).map((r) => String(r.tg_user_id));
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
    maxRewardPerUserRaw = MAX_PRED_REWARD_PER_USER_RAW,
    poolPerBetRaw = PRED_POOL_PER_BET_RAW,
    budgetLedger = null,
  }) {
    if (!db) throw new Error('Cloudflare D1 binding (env.DB) is required');
    this.db = db;
    this.defaultPoolA9Raw = BigInt(defaultPoolA9Raw);
    this.firstLossBonusRaw = parseOptionalBigInt(firstLossBonusRaw, DEFAULT_FIRST_LOSS_BONUS_RAW);
    this.firstLossCapRaw = parseOptionalBigInt(firstLossCapRaw, DEFAULT_FIRST_LOSS_CAP_RAW);
    this.maxRewardPerUserRaw = parseOptionalBigInt(maxRewardPerUserRaw, MAX_PRED_REWARD_PER_USER_RAW);
    this.poolPerBetRaw = parseOptionalBigInt(poolPerBetRaw, PRED_POOL_PER_BET_RAW);
    this.budgetLedger = budgetLedger;
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
    if (slots !== null && (!Number.isInteger(slots) || slots < 0 || slots > 12)) {
      throw new GrowthError('BAD_REQUEST', 'guessSlots must be 0..12');
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
      .prepare('SELECT side, COUNT(*) AS cnt FROM prediction_bets WHERE round_id = ? GROUP BY side')
      .bind(rId)
      .all();
    let passCount = 0;
    let burnCount = 0;
    for (const r of rows?.results || []) {
      if (r.side === 'PASS') passCount += Number(r.cnt || 0);
      else burnCount += Number(r.cnt || 0);
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

  async _ensureUserStatsRow(uid, nowSec) {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO prediction_rewards
         (user_id, pending_activation_raw, activated_raw, pending_expires_at, total_settled, total_won, streak, updated_at)
         VALUES (?, '0', '0', NULL, 0, 0, 0, ?)`,
      )
      .bind(uid, nowSec)
      .run();
  }

  /**
   * 单用户原子结算辅助：通过 NOT NULL 子查询守卫保证 prediction_bets 仍为 OPEN
   * 且 prediction_rewards 的 pending_activation_raw/total_settled 快照未发生并发变更；
   * 全程绝不触碰 activated_raw，彻底杜绝并发 activateToPromo 导致的已激活奖励复活双花。
   */
  async _assertVoucherTable0017() {
    try {
      await this.db.prepare('SELECT 1 FROM pending_reward_vouchers LIMIT 1').first();
    } catch (e) {
      if (isMissingTableErr(e)) {
        throw new GrowthError(
          'MIGRATION_0017_REQUIRED',
          'pending_reward_vouchers 表缺失，请先执行 0017_actuarial_reservations_and_vouchers.sql 迁移',
        );
      }
      throw e;
    }
  }

  _buildAtomicSettlePair(rId, item, curStats, nowMs, nowSec) {
    const nextState = computeNextPendingState(curStats.pendingActivationRaw, curStats.pendingExpiresAt, item.deltaPending, nowMs);
    const nextPending = nextState.nextPendingRaw.toString();
    const nextExpiresAt = nextState.nextExpiresAt;
    const nextSettled = curStats.totalSettled + 1;
    const nextWon = curStats.totalWon + (item.isWin ? 1 : 0);
    const nextStreak = item.isWin ? curStats.streak + 1 : 0;
    const stmts = [
      this.db
        .prepare(
          `UPDATE prediction_rewards
           SET pending_activation_raw = (
                 SELECT ?
                 FROM prediction_bets
                 WHERE round_id = ? AND user_id = ? AND status = 'OPEN'
                   AND EXISTS (
                     SELECT 1 FROM prediction_rewards
                     WHERE user_id = ? AND pending_activation_raw = ? AND total_settled = ?
                   )
               ),
               pending_expires_at = ?,
               total_settled = ?,
               total_won = ?,
               streak = ?,
               updated_at = ?
           WHERE user_id = ?`,
        )
        .bind(
          nextPending,
          rId,
          item.userId,
          item.userId,
          curStats.pendingActivationRaw.toString(),
          curStats.totalSettled,
          nextExpiresAt,
          nextSettled,
          nextWon,
          nextStreak,
          nowSec,
          item.userId,
        ),
      this.db
        .prepare("UPDATE prediction_bets SET status = ?, reward_raw = ? WHERE round_id = ? AND user_id = ? AND status = 'OPEN'")
        .bind(item.targetStatus, item.rewardRaw.toString(), rId, item.userId),
    ];
    if (item.deltaPending > 0n) {
      const voucherId = item.isWin ? `pred_win:${rId}:${item.userId}` : `pred_fl:${rId}:${item.userId}`;
      const sourceKind = item.isWin ? 'PREDICTION_WIN' : 'PREDICTION_FIRST_LOSS';
      stmts.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO pending_reward_vouchers
               (voucher_id, user_id, source_bucket, source_kind, source_ref, amount_raw, expires_at_ms, status, activation_id, legacy_backfilled, resolved_at, created_at, updated_at)
             SELECT ?, ?, 'prediction', ?, ?, ?, ?, 'PENDING', NULL, 0, NULL, ?, ?
             WHERE EXISTS (SELECT 1 FROM prediction_bets WHERE round_id = ? AND user_id = ? AND status = ?)`,
          )
          .bind(
            voucherId, item.userId, sourceKind, `round:${rId}`, item.deltaPending.toString(), nextExpiresAt, nowSec, nowSec,
            rId, item.userId, item.targetStatus,
          ),
      );
    }
    return stmts;
  }

  async _settleSingleUserWithCas(rId, item, nowMs, nowSec, { budgetLedger = null } = {}) {
    const useAtomicBudget = Boolean(item.deltaPending > 0n && budgetLedger && typeof budgetLedger.prepareAtomicReserve === 'function');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const betRow = await this.db
        .prepare('SELECT status FROM prediction_bets WHERE round_id = ? AND user_id = ?')
        .bind(rId, item.userId)
        .first();
      if (!betRow || String(betRow.status) !== 'OPEN') return false;

      await this._ensureUserStatsRow(item.userId, nowSec);
      let st = await this._getUserStatsRow(item.userId);
      if (st.pendingActivationRaw > 0n && st.pendingExpiresAt !== null && nowMs > st.pendingExpiresAt) {
        await this.reclaimExpiredVouchers(nowMs, { budgetLedger, userId: item.userId, limit: 1 });
        st = await this._getUserStatsRow(item.userId);
      }
      const pair = this._buildAtomicSettlePair(rId, item, st, nowMs, nowSec);
      if (useAtomicBudget) {
        const budgetPrep = await budgetLedger.prepareAtomicReserve('prediction', item.deltaPending, nowSec);
        if (budgetPrep) {
          pair.push(
            budgetPrep.buildStrictUpdateStmt(
              ' AND EXISTS (SELECT 1 FROM prediction_bets WHERE round_id = ? AND user_id = ? AND status = ?)',
              [rId, item.userId, item.targetStatus],
            ),
          );
        }
      }
      try {
        await this.db.batch(pair);
        return true;
      } catch (e) {
        const msg = String(e?.message || e);
        if (/NOT NULL|UNIQUE|constraint/i.test(msg)) continue;
        throw e;
      }
    }
    throw new GrowthError('SETTLE_CONFLICT', `concurrent settlement conflict for user ${item.userId}`);
  }

  async settleRoundBets(roundId, passed, actualQualified, poolA9Raw = this.defaultPoolA9Raw, nowMs = Date.now(), { batchSize = 25, budgetLedger = this.budgetLedger } = {}) {
    const rId = Number(roundId);
    const already = await this.db
      .prepare('SELECT winning_side FROM prediction_rounds WHERE round_id = ?')
      .bind(rId)
      .first();
    if (already) throw new GrowthError('ROUND_SETTLED', `round ${rId} already settled`);

    const winSide = passed ? 'PASS' : 'BURN';
    const rawPool = BigInt(poolA9Raw);
    const nowSec = Math.floor(nowMs / 1000);
    const chunkSize = Math.max(1, Math.min(50, Number(batchSize) || 25));

    const betsRes = await this.db
      .prepare('SELECT * FROM prediction_bets WHERE round_id = ? ORDER BY created_at ASC, user_id ASC')
      .bind(rId)
      .all();
    const bets = betsRes?.results || [];
    const dynamicCap = this.poolPerBetRaw > 0n ? BigInt(bets.length) * this.poolPerBetRaw : rawPool;
    const effectivePool = rawPool < dynamicCap ? rawPool : dynamicCap;

    const winners = [];
    const losers = [];
    let totalWeight = 0n;
    let firstLossRemaining = this.firstLossCapRaw;
    let firstLossBonusCount = 0;
    let firstLossBonusDistributed = 0n;

    // 一次聚合查询获取全轮邀请加成，消除每个 winner 的 N+1 查询
    const inviteRowsRes = await this.db
      .prepare(
        `SELECT referrer_id, COUNT(DISTINCT user_id) AS cnt
         FROM prediction_bets
         WHERE round_id = ? AND referrer_id IS NOT NULL
         GROUP BY referrer_id`,
      )
      .bind(rId)
      .all();
    const inviteBoostMap = new Map();
    for (const row of inviteRowsRes?.results || []) {
      inviteBoostMap.set(String(row.referrer_id), Math.min(5, Number(row.cnt || 0)));
    }

    for (const b of bets) {
      if (b.side === winSide) {
        const exactBoost = b.guess_slots !== null && Number(b.guess_slots) === Number(actualQualified) ? 5n : 0n;
        const inviteBoost = BigInt(inviteBoostMap.get(String(b.user_id)) || 0);
        const rawW = 10n + exactBoost + inviteBoost;
        const weight = rawW > 20n ? 20n : rawW;
        winners.push({ bet: b, weight });
        totalWeight += weight;
      } else {
        const alreadyBonus = String(b.status) === 'LOST_FIRST_BONUS';
        const st = await this._getUserStatsRow(b.user_id);
        const isFirstSettled = String(b.status) === 'OPEN' ? st.totalSettled === 0 : alreadyBonus;
        if (isFirstSettled && this.firstLossBonusRaw > 0n && firstLossRemaining >= this.firstLossBonusRaw) {
          firstLossRemaining -= this.firstLossBonusRaw;
          firstLossBonusCount += 1;
          firstLossBonusDistributed += this.firstLossBonusRaw;
          losers.push({
            userId: b.user_id,
            status: String(b.status),
            isWin: false,
            targetStatus: 'LOST_FIRST_BONUS',
            rewardRaw: this.firstLossBonusRaw,
            deltaPending: this.firstLossBonusRaw,
          });
        } else {
          losers.push({
            userId: b.user_id,
            status: String(b.status),
            isWin: false,
            targetStatus: 'LOST',
            rewardRaw: 0n,
            deltaPending: 0n,
          });
        }
      }
    }

    let distributed = 0n;
    let openBudgetNeed = 0n;
    const pendingItems = [];
    for (const item of losers) {
      if (item.status === 'OPEN') {
        pendingItems.push(item);
        openBudgetNeed += item.deltaPending;
      }
    }
    for (const { bet, weight } of winners) {
      let amt = totalWeight > 0n ? (effectivePool * weight) / totalWeight : 0n;
      if (this.maxRewardPerUserRaw > 0n && amt > this.maxRewardPerUserRaw) {
        amt = this.maxRewardPerUserRaw;
      }
      distributed += amt;
      if (String(bet.status) === 'OPEN') {
        openBudgetNeed += amt;
        pendingItems.push({
          userId: bet.user_id,
          status: String(bet.status),
          isWin: true,
          targetStatus: 'WON_PENDING_ACTIVATION',
          rewardRaw: amt,
          deltaPending: amt,
        });
      }
    }

    if (openBudgetNeed > 0n) {
      await this._assertVoucherTable0017();
    }

    const hasAtomicBudget = Boolean(budgetLedger && typeof budgetLedger.prepareAtomicReserve === 'function');
    // 全轮预算熔断预检（只读校验，不提前落库）：预算不足直接抛 PROMO_BUDGET_EXHAUSTED（零写入），
    // 彻底消除“先扣预算后中断留空占”与“提交后超时误释放预算”两类预算/凭证失衡。
    if (openBudgetNeed > 0n && hasAtomicBudget) {
      await budgetLedger.prepareAtomicReserve('prediction', openBudgetNeed, nowSec);
    }

    let reservedBudget = 0n;
    if (openBudgetNeed > 0n && !hasAtomicBudget && budgetLedger && typeof budgetLedger.reserve === 'function') {
      await budgetLedger.reserve('prediction', openBudgetNeed, nowSec);
      reservedBudget = openBudgetNeed;
    }

    // 第二阶段：分批（每批 <= 25 人）在同一 db.batch() 内原子提交预算扣减 + 凭证写入 + 账本结算；
    // 任何单条 CAS 冲突整批回滚并回退到单用户同事务 CAS，不在结算完成前写 prediction_rounds。
    let settledBudget = 0n;
    try {
      for (let i = 0; i < pendingItems.length; i += chunkSize) {
        const slice = pendingItems.slice(i, i + chunkSize);
        const ensureStmts = slice.map((item) =>
          this.db
            .prepare(
              `INSERT OR IGNORE INTO prediction_rewards
               (user_id, pending_activation_raw, activated_raw, pending_expires_at, total_settled, total_won, streak, updated_at)
               VALUES (?, '0', '0', NULL, 0, 0, 0, ?)`,
            )
            .bind(item.userId, nowSec),
        );
        if (ensureStmts.length) await this.db.batch(ensureStmts);

        const batchStmts = [];
        let sliceBudgetNeed = 0n;
        for (const item of slice) {
          let st = await this._getUserStatsRow(item.userId);
          if (st.pendingActivationRaw > 0n && st.pendingExpiresAt !== null && nowMs > st.pendingExpiresAt) {
            await this.reclaimExpiredVouchers(nowMs, { budgetLedger, userId: item.userId, limit: 1 });
            st = await this._getUserStatsRow(item.userId);
          }
          const pair = this._buildAtomicSettlePair(rId, item, st, nowMs, nowSec);
          batchStmts.push(...pair);
          sliceBudgetNeed += item.deltaPending;
        }
        if (sliceBudgetNeed > 0n && hasAtomicBudget) {
          const budgetPrep = await budgetLedger.prepareAtomicReserve('prediction', sliceBudgetNeed, nowSec);
          if (budgetPrep) {
            batchStmts.push(budgetPrep.buildStrictUpdateStmt());
          }
        }

        try {
          await this.db.batch(batchStmts);
          settledBudget += sliceBudgetNeed;
        } catch (e) {
          const msg = String(e?.message || e);
          if (!/NOT NULL|UNIQUE|constraint/i.test(msg)) throw e;
          for (const item of slice) {
            const changed = await this._settleSingleUserWithCas(rId, item, nowMs, nowSec, { budgetLedger: hasAtomicBudget ? budgetLedger : null });
            if (changed) settledBudget += item.deltaPending;
          }
        }
      }
    } catch (e) {
      if (!hasAtomicBudget) {
        const unspent = reservedBudget > settledBudget ? reservedBudget - settledBudget : 0n;
        if (unspent > 0n && budgetLedger && typeof budgetLedger.release === 'function') {
          await budgetLedger.release('prediction', unspent, nowSec).catch(() => {});
        }
      }
      throw e;
    }

    // 仅非原子回退路径才需退还多预留差额；原子路径已与凭证同事务精确扣减
    if (!hasAtomicBudget) {
      const excessBudget = reservedBudget > settledBudget ? reservedBudget - settledBudget : 0n;
      if (excessBudget > 0n && budgetLedger && typeof budgetLedger.release === 'function') {
        await budgetLedger.release('prediction', excessBudget, nowSec).catch(() => {});
      }
    }

    // 全部注单结清后才落库 prediction_rounds 终态标记，确保半途失败可安全续跑
    const remainOpenRow = await this.db
      .prepare("SELECT COUNT(*) AS cnt FROM prediction_bets WHERE round_id = ? AND status = 'OPEN'")
      .bind(rId)
      .first();
    if (Number(remainOpenRow?.cnt || 0) > 0) {
      throw new GrowthError('SETTLE_INCOMPLETE', `round ${rId} still has unsettled OPEN bets`);
    }
    await this.db
      .prepare('INSERT OR IGNORE INTO prediction_rounds (round_id, winning_side, actual_qualified, settled_at) VALUES (?, ?, ?, ?)')
      .bind(rId, winSide, Number(actualQualified), nowSec)
      .run();

    return {
      roundId: rId,
      winSide,
      winnersCount: winners.length,
      effectivePoolRaw: effectivePool.toString(),
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

  async creditPendingBonus(
    userId,
    amountRaw,
    nowMs = Date.now(),
    { sourceBucket = null, sourceKind = null, sourceRef = null, voucherId = null, budgetLedger = this.budgetLedger } = {},
  ) {
    const uid = String(userId || '').trim();
    const amt = BigInt(amountRaw || 0n);
    if (!uid || amt <= 0n) return { userId: uid, pendingActivationRaw: '0' };
    if (sourceBucket) await this._assertVoucherTable0017();
    const nowSec = Math.floor(nowMs / 1000);
    await this._ensureUserStatsRow(uid, nowSec);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let st = await this._getUserStatsRow(uid);
      if (st.pendingActivationRaw > 0n && st.pendingExpiresAt !== null && nowMs > st.pendingExpiresAt) {
        await this.reclaimExpiredVouchers(nowMs, { budgetLedger, userId: uid, limit: 1 });
        st = await this._getUserStatsRow(uid);
      }
      const curStr = st.pendingActivationRaw.toString();
      const next = computeNextPendingState(st.pendingActivationRaw, st.pendingExpiresAt, amt, nowMs);
      const nextPending = next.nextPendingRaw.toString();
      const stmts = [
        this.db
          .prepare(
            `UPDATE prediction_rewards
             SET pending_activation_raw = CASE WHEN pending_activation_raw = ? THEN ? ELSE NULL END,
                 pending_expires_at = ?, updated_at = ?
             WHERE user_id = ?`,
          )
          .bind(curStr, nextPending, next.nextExpiresAt, nowSec, uid),
      ];
      if (sourceBucket) {
        const vId = voucherId ? String(voucherId) : `v_${sourceKind || 'BONUS'}_${uid}_${nowMs}_${randomHex(4)}`;
        stmts.push(
          this.db
            .prepare(
              `INSERT OR IGNORE INTO pending_reward_vouchers
                 (voucher_id, user_id, source_bucket, source_kind, source_ref, amount_raw, expires_at_ms, status, activation_id, legacy_backfilled, resolved_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, 0, NULL, ?, ?)`,
            )
            .bind(vId, uid, String(sourceBucket), String(sourceKind || 'PENDING_BONUS'), String(sourceRef || vId), amt.toString(), next.nextExpiresAt, nowSec, nowSec),
        );
      }
      try {
        await this.db.batch(stmts);
        return { userId: uid, pendingActivationRaw: nextPending, pendingExpiresAt: next.nextExpiresAt };
      } catch (e) {
        if (/NOT NULL|UNIQUE|constraint/i.test(String(e?.message || e))) continue;
        throw e;
      }
    }
    throw new GrowthError('CREDIT_CONFLICT', 'concurrent pending bonus update conflict, please retry');
  }

  /**
   * Atomically deduct prediction_rewards.pending_activation_raw, mark PENDING vouchers ACTIVATED,
   * credit promo_balances.claimable_raw, and record a unique prediction_activations ledger row in ONE D1 batch.
   * - Exact expiry boundary (nowMs === pendingExpiresAt) remains activatable; only nowMs > pendingExpiresAt expires.
   * - On expiry, reclaims expired vouchers back to their original source buckets before throwing VOUCHER_EXPIRED.
   */
  async activateToPromo(userId, walletAddress, promoEngine, { qualified = false, nowMs = Date.now(), activationId = null, budgetLedger = this.budgetLedger } = {}) {
    const uid = String(userId || '').trim();
    const wallet = String(walletAddress || '').trim();
    if (!uid || !wallet) throw new GrowthError('BAD_REQUEST', 'userId and walletAddress required');
    if (qualified !== true) {
      throw new GrowthError(
        'ACTIVATION_REQUIREMENT_UNMET',
        '请先在宝箱商城购任意宝箱（0.99 GRAM 起）、链上锁仓，或直邀 1 位好友购箱后再激活',
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
    let hasVoucherTable = true;
    try {
      await this.db.prepare('SELECT 1 FROM pending_reward_vouchers LIMIT 1').first();
    } catch (e) {
      if (isMissingTableErr(e)) hasVoucherTable = false;
      else throw e;
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
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
        if (hasVoucherTable) {
          await this.reclaimExpiredVouchers(nowMs, { budgetLedger, userId: uid, limit: 1 });
        } else {
          await this.db
            .prepare(
              `UPDATE prediction_rewards
               SET pending_activation_raw = '0', pending_expires_at = NULL, updated_at = ?
               WHERE user_id = ? AND pending_activation_raw = ? AND pending_expires_at = ?`,
            )
            .bind(nowSec, uid, st.pendingActivationRaw.toString(), st.pendingExpiresAt)
            .run();
        }
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
                   AND (pending_expires_at IS NULL OR pending_expires_at >= ?)
                   AND EXISTS (SELECT 1 FROM promo_balances WHERE wallet_address = ? AND claimable_raw = ?)),
               ?
             )`,
          )
          .bind(actId, uid, walletKey, wallet, uid, amt.toString(), nowMs, targetBalKey, curClaimable, nowSec),
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
      if (hasVoucherTable) {
        stmts.push(
          this.db
            .prepare(
              `UPDATE pending_reward_vouchers
               SET status = 'ACTIVATED', activation_id = ?, resolved_at = ?, updated_at = ?
               WHERE user_id = ? AND status = 'PENDING' AND expires_at_ms >= ?`,
            )
            .bind(actId, nowSec, nowSec, uid, nowMs),
        );
      }

      try {
        await this.db.batch(stmts);
        return { userId: uid, walletAddress: wallet, activatedRaw: amt.toString(), activationId: actId, idempotent: false };
      } catch (e) {
        const msg = String(e?.message || e);
        if (/NOT NULL|UNIQUE|constraint/i.test(msg)) {
          continue;
        }
        throw e;
      }
    }
    throw new GrowthError('ACTIVATION_CONFLICT', 'concurrent activation conflict, please retry');
  }

  /**
   * Batched, resumable reclamation of expired 48H pending reward vouchers (expires_at_ms < nowMs).
   * Atomically updates pending_reward_vouchers, prediction_rewards, and promo_budget_ledger in ONE db.batch()
   * per user so concurrent activateToPromo or new grants NEVER double-credit or double-release.
   */
  async reclaimExpiredVouchers(nowMs = Date.now(), { budgetLedger = this.budgetLedger, userId = null, limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit || 50))));
    const nowSec = Math.floor(nowMs / 1000);
    let candidateUsers = [];
    try {
      if (userId) {
        candidateUsers = [String(userId).trim()];
      } else {
        const vRes = await this.db
          .prepare(
            `SELECT DISTINCT user_id FROM pending_reward_vouchers
             WHERE status = 'PENDING' AND expires_at_ms < ?
             ORDER BY expires_at_ms ASC LIMIT ?`,
          )
          .bind(nowMs, safeLimit)
          .all();
        const set = new Set((vRes?.results || []).map((r) => String(r.user_id)));
        if (set.size < safeLimit) {
          const pRes = await this.db
            .prepare(
              `SELECT user_id FROM prediction_rewards
               WHERE pending_activation_raw != '0' AND pending_expires_at IS NOT NULL AND pending_expires_at < ?
               ORDER BY pending_expires_at ASC LIMIT ?`,
            )
            .bind(nowMs, safeLimit - set.size)
            .all();
          for (const r of pRes?.results || []) set.add(String(r.user_id));
        }
        candidateUsers = [...set];
      }
    } catch (e) {
      if (isMissingTableErr(e)) {
        return { processedUsers: 0, reclaimedVouchers: 0, reclaimedRaw: '0', byBucket: {} };
      }
      throw e;
    }

    let processedUsers = 0;
    let reclaimedVouchers = 0;
    let reclaimedRaw = 0n;
    const byBucket = {};

    for (const uid of candidateUsers) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const st = await this._getUserStatsRow(uid);
        const vRowsRes = await this.db
          .prepare(
            `SELECT voucher_id, source_bucket, amount_raw, expires_at_ms
             FROM pending_reward_vouchers
             WHERE user_id = ? AND status = 'PENDING' AND expires_at_ms < ?
             ORDER BY created_at ASC`,
          )
          .bind(uid, nowMs)
          .all();
        const expiredVouchers = vRowsRes?.results || [];
        const vaultExpired = st.pendingActivationRaw > 0n && st.pendingExpiresAt !== null && nowMs > st.pendingExpiresAt;
        if (expiredVouchers.length === 0 && !vaultExpired) break;

        const bucketSums = new Map();
        let voucherSum = 0n;
        for (const v of expiredVouchers) {
          const amt = BigInt(String(v.amount_raw || '0'));
          voucherSum += amt;
          const b = String(v.source_bucket);
          bucketSums.set(b, (bucketSums.get(b) || 0n) + amt);
        }

        const nextPending = vaultExpired
          ? 0n
          : (st.pendingActivationRaw >= voucherSum ? st.pendingActivationRaw - voucherSum : 0n);
        const nextExpiresAt = (vaultExpired || nextPending === 0n) ? null : st.pendingExpiresAt;

        const stmts = [];
        if (st.pendingActivationRaw > 0n || vaultExpired) {
          stmts.push(
            this.db
              .prepare(
                `UPDATE prediction_rewards
                 SET pending_activation_raw = CASE
                       WHEN pending_activation_raw = ?
                        AND (pending_expires_at IS NULL OR pending_expires_at < ? OR ? = 0)
                       THEN ? ELSE NULL END,
                     pending_expires_at = ?,
                     updated_at = ?
                 WHERE user_id = ?`,
              )
              .bind(
                st.pendingActivationRaw.toString(),
                nowMs,
                vaultExpired ? 1 : 0,
                nextPending.toString(),
                nextExpiresAt,
                nowSec,
                uid,
              ),
          );
        }

        for (const v of expiredVouchers) {
          stmts.push(
            this.db
              .prepare(
                `UPDATE pending_reward_vouchers
                 SET status = CASE WHEN status = 'PENDING' AND expires_at_ms < ? THEN 'EXPIRED_RELEASED' ELSE NULL END,
                     resolved_at = ?,
                     updated_at = ?
                 WHERE voucher_id = ?`,
              )
              .bind(nowMs, nowSec, nowSec, String(v.voucher_id)),
          );
        }

        const sortedBuckets = [...bucketSums.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        for (const [bucket, sum] of sortedBuckets) {
          if (sum > 0n && budgetLedger && typeof budgetLedger.prepareAtomicRelease === 'function') {
            const relPrep = await budgetLedger.prepareAtomicRelease(bucket, sum, nowSec);
            if (relPrep) stmts.push(relPrep.buildStrictUpdateStmt());
          }
        }

        if (stmts.length === 0) break;
        try {
          await this.db.batch(stmts);
          processedUsers += 1;
          reclaimedVouchers += expiredVouchers.length;
          reclaimedRaw += voucherSum;
          for (const [bucket, sum] of sortedBuckets) {
            byBucket[bucket] = (BigInt(byBucket[bucket] || '0') + sum).toString();
          }
          break;
        } catch (e) {
          if (/NOT NULL|UNIQUE|constraint/i.test(String(e?.message || e))) continue;
          throw e;
        }
      }
    }

    return { processedUsers, reclaimedVouchers, reclaimedRaw: reclaimedRaw.toString(), byBucket };
  }

  async listPendingVouchers(userId = null, { status = null } = {}) {
    try {
      let sql = 'SELECT * FROM pending_reward_vouchers WHERE 1=1';
      const args = [];
      if (userId) {
        sql += ' AND user_id = ?';
        args.push(String(userId).trim());
      }
      if (status) {
        sql += ' AND status = ?';
        args.push(String(status).trim());
      }
      sql += ' ORDER BY created_at ASC';
      const res = await this.db.prepare(sql).bind(...args).all();
      return (res?.results || []).map((r) => ({
        voucherId: String(r.voucher_id),
        userId: String(r.user_id),
        sourceBucket: String(r.source_bucket),
        sourceKind: String(r.source_kind),
        sourceRef: String(r.source_ref),
        amountRaw: String(r.amount_raw),
        expiresAtMs: Number(r.expires_at_ms),
        status: String(r.status),
        activationId: r.activation_id || null,
        legacyBackfilled: Number(r.legacy_backfilled || 0) === 1,
        resolvedAt: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
        createdAt: Number(r.created_at || 0),
        updatedAt: Number(r.updated_at || 0),
      }));
    } catch (e) {
      if (isMissingTableErr(e)) return [];
      throw e;
    }
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

  async listExpiringPendingVaults({ nowMs = Date.now(), windowMs = 6 * 3600 * 1000, limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
    const deadlineMs = Number(nowMs) + Number(windowMs);
    const res = await this.db
      .prepare(
        `SELECT user_id, pending_activation_raw, pending_expires_at
         FROM prediction_rewards
         WHERE pending_activation_raw != '0'
           AND pending_expires_at IS NOT NULL
           AND pending_expires_at > ?
           AND pending_expires_at <= ?
         ORDER BY pending_expires_at ASC
         LIMIT ?`,
      )
      .bind(Number(nowMs), deadlineMs, safeLimit)
      .all();
    return (res?.results || [])
      .filter((r) => {
        try { return BigInt(r.pending_activation_raw || '0') > 0n; } catch { return false; }
      })
      .map((r) => ({
        userId: String(r.user_id),
        pendingActivationRaw: String(r.pending_activation_raw),
        pendingExpiresAt: Number(r.pending_expires_at),
      }));
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
      throw new GrowthError('TASK_PREREQUISITE_UNMET', '请先参与本轮 0 GRAM 12H 达标竞猜后再盖章');
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
        throw new GrowthError('TASK_PREREQUISITE_UNMET', '需完成至少 1 次 12H 达标竞猜后解锁');
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
const RESERVING_SQL = `(status IN (${RESERVING_STATUSES.map((s) => `'${s}'`).join(', ')}) OR (status = 'PENDING_PAYMENT' AND expires_at >= ?))`;

const ORDER_COLS = {
  status: 'status',
  inboundTxHash: 'inbound_tx_hash',
  payoutTxHash: 'payout_tx_hash',
  refundTonNano: 'refund_ton_nano',
  refundReason: 'refund_reason',
  lastError: 'last_error',
  bonusA9Raw: 'bonus_a9_raw',
  bonusRolled: 'bonus_rolled',
  updatedAt: 'updated_at',
};
const PAYOUT_COLS = {
  status: 'status',
  queryId: 'query_id',
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
    bonusA9Raw: BigInt(r.bonus_a9_raw || '0'),
    bonusRolled: Number(r.bonus_rolled || 0) === 1,
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

function rowToReservation(r) {
  if (!r) return null;
  return {
    orderId: String(r.order_id),
    skuId: r.sku_id || null,
    baseA9Raw: BigInt(r.base_a9_raw || '0'),
    reservedBonusRaw: BigInt(r.reserved_bonus_raw || '0'),
    settledBonusRaw: BigInt(r.settled_bonus_raw || '0'),
    releasedBonusRaw: BigInt(r.released_bonus_raw || '0'),
    reservedReferralRaw: BigInt(r.reserved_referral_raw || '0'),
    referralBps: Number(r.referral_bps || 0),
    maxBoostBps: Number(r.max_boost_bps || 0),
    bonusStatus: String(r.bonus_status || 'RESERVED'),
    referralStatus: String(r.referral_status || 'NONE'),
    status: String(r.status || 'ACTIVE'),
    legacyBackfilled: Number(r.legacy_backfilled || 0) === 1,
    snapshotNetwork: r.snapshot_network || null,
    snapshotJettonMaster: r.snapshot_jetton_master || null,
    snapshotPresaleWallet: r.snapshot_presale_wallet || null,
    snapshotPromoWallet: r.snapshot_promo_wallet || null,
    snapshotAt: r.snapshot_at === null || r.snapshot_at === undefined ? null : Number(r.snapshot_at),
    createdAt: Number(r.created_at || 0),
    updatedAt: Number(r.updated_at || 0),
  };
}

const isUnique = (e) => /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT_PRIMARYKEY/i.test(String(e?.message || e));
const isNotNullOrConstraint = (e) => /NOT NULL|SQLITE_CONSTRAINT/i.test(String(e?.message || e));
const isMissingTableErr = (e) => /no such table/i.test(String(e?.message || e));
const changes = (r) => Number(r?.meta?.changes ?? r?.changes ?? 0);

const DEC9 = 1_000_000_000n;
const split9 = (val) => {
  const n = BigInt(val);
  return { hi: (n / DEC9).toString(), lo: (n % DEC9).toString() };
};
const hiExpr = (col) => `CASE WHEN length(${col}) > 9 THEN CAST(substr(${col}, 1, length(${col}) - 9) AS INTEGER) ELSE 0 END`;
const loExpr = (col) => `CAST(CASE WHEN length(${col}) > 9 THEN substr(${col}, length(${col}) - 8) ELSE ${col} END AS INTEGER)`;

export class D1PresaleRepo {
  constructor({ db }) {
    if (!db) throw new PresaleError('DB_MISSING', 'Cloudflare D1 binding (env.DB) is required');
    this.db = db;
  }

  async sumReserved(nowSec, walletKey) {
    const DEC9 = 1_000_000_000n;
    const hiExpr = (col) => `CASE WHEN length(${col}) > 9 THEN CAST(substr(${col}, 1, length(${col}) - 9) AS INTEGER) ELSE 0 END`;
    const loExpr = (col) => `CAST(CASE WHEN length(${col}) > 9 THEN substr(${col}, length(${col}) - 8) ELSE ${col} END AS INTEGER)`;
    const totalRow = await this.db
      .prepare(
        `SELECT COALESCE(SUM(${hiExpr('a9_amount_raw')}), 0) AS hi_a9,
                COALESCE(SUM(${loExpr('a9_amount_raw')}), 0) AS lo_a9
         FROM presale_orders WHERE ${RESERVING_SQL}`,
      )
      .bind(nowSec)
      .first();
    const reservedA9Raw = BigInt(totalRow?.hi_a9 || 0) * DEC9 + BigInt(totalRow?.lo_a9 || 0);

    let userReservedNano = 0n;
    if (walletKey) {
      const userRow = await this.db
        .prepare(
          `SELECT COALESCE(SUM(${hiExpr('ton_nano')}), 0) AS hi_ton,
                  COALESCE(SUM(${loExpr('ton_nano')}), 0) AS lo_ton
           FROM presale_orders WHERE ${RESERVING_SQL} AND wallet_key = ?`,
        )
        .bind(nowSec, walletKey)
        .first();
      userReservedNano = BigInt(userRow?.hi_ton || 0) * DEC9 + BigInt(userRow?.lo_ton || 0);
      // 兼容旧数据 wallet_key 为 NULL 的遗留订单（0001..0004 兼容路径）
      const legacyNullRows = await this.db
        .prepare(`SELECT wallet_address, ton_nano FROM presale_orders WHERE ${RESERVING_SQL} AND wallet_key IS NULL`)
        .bind(nowSec)
        .all();
      for (const r of legacyNullRows?.results || []) {
        if (addressKey(r.wallet_address) === walletKey) {
          userReservedNano += BigInt(r.ton_nano || '0');
        }
      }
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
    const hasUserQuota = userQuotaNano !== null && userQuotaNano !== undefined;

    // 同时覆盖新行（wallet_key）与尚未回填的历史友好地址行（EQ/UQ/kQ/0Q/raw 全部规范形式），保持单语句原子性。
    const poolWhereClause = `WHERE EXISTS (
             SELECT 1 FROM (
               SELECT
                 (COALESCE(SUM(${hiExpr('a9_amount_raw')}), 0) + CAST(? AS INTEGER)
                   + (COALESCE(SUM(${loExpr('a9_amount_raw')}), 0) + CAST(? AS INTEGER)) / 1000000000) AS tot_hi,
                 ((COALESCE(SUM(${loExpr('a9_amount_raw')}), 0) + CAST(? AS INTEGER)) % 1000000000) AS tot_lo
               FROM presale_orders WHERE ${RESERVING_SQL}
             ) WHERE tot_hi < CAST(? AS INTEGER) OR (tot_hi = CAST(? AS INTEGER) AND tot_lo <= CAST(? AS INTEGER))
           )`;
    let whereClause = poolWhereClause;
    const tailArgs = [
      addA9.hi, addA9.lo, addA9.lo, nowSec, capA9.hi, capA9.hi, capA9.lo,
    ];
    if (hasUserQuota) {
      const addTon = split9(o.tonNano);
      const capTon = split9(userQuotaNano);
      const aliases = addressAliases(o.walletAddress);
      const aliasPlaceholders = aliases.map(() => '?').join(', ');
      whereClause = `${poolWhereClause}
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
      tailArgs.push(
        addTon.hi, addTon.lo, addTon.lo, o.walletKey, ...aliases, nowSec, capTon.hi, capTon.hi, capTon.lo,
      );
    }
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
      if ((o.openMode || 'INSTANT') === 'INSTANT' && /(no such column|has no column named)[\s:]+["'`]?(sku_id|open_mode)["'`]?/i.test(errText)) {
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

  async countOrdersByStatus(status) {
    const row = await this.db.prepare('SELECT COUNT(*) AS cnt FROM presale_orders WHERE status = ?').bind(status).first();
    return Number(row?.cnt || 0);
  }

  async getScanCursor(walletAddress) {
    const key = addressKey(walletAddress);
    try {
      const row = await this.db
        .prepare('SELECT last_lt, last_hash, updated_at FROM chain_scan_cursors WHERE wallet_address = ? LIMIT 1')
        .bind(key)
        .first();
      return row ? { lt: String(row.last_lt), hash: String(row.last_hash), updatedAt: Number(row.updated_at || 0) } : null;
    } catch (e) {
      if (isMissingTableErr(e)) return null;
      throw e;
    }
  }

  async saveScanCursor(walletAddress, { lt, hash }, nowSec) {
    if (!lt || !hash) return;
    const key = addressKey(walletAddress);
    try {
      await this.db
        .prepare(
          `INSERT INTO chain_scan_cursors (wallet_address, last_lt, last_hash, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(wallet_address) DO UPDATE SET
             last_lt = excluded.last_lt,
             last_hash = excluded.last_hash,
             updated_at = excluded.updated_at`,
        )
        .bind(key, String(lt), String(hash), nowSec)
        .run();
    } catch (e) {
      if (!isMissingTableErr(e)) throw e;
    }
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
    const runWithPatch = async (effectivePatch) => {
      const set = buildSet(effectivePatch, ORDER_COLS);
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
    };
    try {
      return await runWithPatch(patch);
    } catch (e) {
      const errText = `${e?.message || ''} ${e?.cause?.message || ''}`;
      if (/(no such column|has no column named)[\s:]+["'`]?(bonus_a9_raw|bonus_rolled)["'`]?/i.test(errText)) {
        // 严禁在旧库缺列时保留含 bonus 的 payout.amount 同时剥离 bonusRolled（否则后续会误建 SHOP_BOOST 双发）。
        // 若当前订单含合并直发加赠或 bonusRolled 标记，显式报错要求执行 0015 迁移（上游自动归还已扣预算）。
        const hasBonusOrRoll = Boolean(patch?.bonusRolled) || BigInt(patch?.bonusA9Raw || 0n) > 0n;
        if (hasBonusOrRoll) {
          throw new PresaleError(
            'MIGRATION_0015_REQUIRED',
            'presale_orders 缺少 bonus_a9_raw/bonus_rolled 列，请先执行 0015_v17_1_chest_direct_payout.sql 迁移',
          );
        }
        const { bonusA9Raw: _b, bonusRolled: _r, ...fallbackPatch } = patch || {};
        return await runWithPatch(fallbackPatch);
      }
      throw e;
    }
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

  async _assertOrderSchema() {
    const schema = await this.db.prepare(`
      SELECT
        EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'presale_order_reservations') AS has_reservations,
        EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hot_wallet_payout_debits') AS has_payout_debits
    `).first();
    if (!schema?.has_reservations) {
      throw new PresaleError(
        'MIGRATION_0017_REQUIRED',
        'presale_order_reservations 表缺失，请先执行 0017_actuarial_reservations_and_vouchers.sql 迁移',
      );
    }
    if (!schema.has_payout_debits) {
      throw new PresaleError(
        'MIGRATION_0018_REQUIRED',
        'hot_wallet_payout_debits 表缺失，请先执行 0018_hot_wallet_payout_debits.sql 迁移',
      );
    }
  }

  async getReservation(orderId) {
    try {
      const row = await this.db
        .prepare('SELECT * FROM presale_order_reservations WHERE order_id = ? LIMIT 1')
        .bind(orderId)
        .first();
      return rowToReservation(row);
    } catch (e) {
      if (isMissingTableErr(e)) return null;
      throw e;
    }
  }

  // Only exact sender-wallet debits at or before this balance's chain position are covered.
  _confirmedPayoutGuard(snap, payoutTable) {
    if (!snap?.walletLt) return { sql: "OR status = 'CONFIRMED'", args: [] };
    return {
      sql: `OR (status = 'CONFIRMED' AND NOT EXISTS (
        SELECT 1 FROM hot_wallet_payout_debits d
        WHERE d.network = ? AND d.jetton_master = ? AND d.jetton_wallet = ?
          AND d.tx_hash = ${payoutTable}.tx_hash
          AND (length(d.debit_lt) < length(?) OR (length(d.debit_lt) = length(?) AND d.debit_lt <= ?))
      ))`,
      args: [snap.network, addressKey(snap.jettonMaster), snap.jettonWallet, snap.walletLt, snap.walletLt, snap.walletLt],
    };
  }

  _legacyBudgetHoldSql() {
    return `SELECT COALESCE(SUM(${hiExpr('recorded_raw')}), 0) AS sum_hi,
                   COALESCE(SUM(${loExpr('recorded_raw')}), 0) AS sum_lo
            FROM actuarial_reconciliation_items
            WHERE category IN ('LEGACY_PRESALE_UNRESERVED', 'LEGACY_REFERRAL_CREDITING_REVIEW') AND status = 'OPEN'`;
  }

  async _sumOpenLegacyUnreservedPresaleBudget() {
    const row = await this.db.prepare(this._legacyBudgetHoldSql()).first();
    return BigInt(row.sum_hi) * DEC9 + BigInt(row.sum_lo);
  }

  async _presaleOutstandingA9(nowSec, presaleSnap) {
    const confirmedGuard = this._confirmedPayoutGuard(presaleSnap, 'presale_payouts');
    const row = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(hi_v), 0) AS sum_hi,
           COALESCE(SUM(lo_v), 0) AS sum_lo
         FROM (
           SELECT ${hiExpr('amount')} AS hi_v, ${loExpr('amount')} AS lo_v
           FROM presale_payouts
           WHERE kind = 'A9' AND (
             status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT', 'NEEDS_REVIEW')
             ${confirmedGuard.sql}
           )
           UNION ALL
           SELECT
             ${hiExpr('o.a9_amount_raw')} + ${hiExpr(`COALESCE(
               CASE WHEN r.bonus_status = 'SETTLED' THEN r.settled_bonus_raw
                    WHEN r.bonus_status = 'RESERVED' THEN r.reserved_bonus_raw
                    WHEN o.bonus_rolled = 1 THEN o.bonus_a9_raw
                    ELSE '0' END, '0')`)} AS hi_v,
             ${loExpr('o.a9_amount_raw')} + ${loExpr(`COALESCE(
               CASE WHEN r.bonus_status = 'SETTLED' THEN r.settled_bonus_raw
                    WHEN r.bonus_status = 'RESERVED' THEN r.reserved_bonus_raw
                    WHEN o.bonus_rolled = 1 THEN o.bonus_a9_raw
                    ELSE '0' END, '0')`)} AS lo_v
           FROM presale_orders o
           LEFT JOIN presale_order_reservations r ON r.order_id = o.order_id
           WHERE (
             (o.status IN ('PENDING_PAYMENT', 'PENDING_TON') AND (o.expires_at = 0 OR o.expires_at >= ?))
             OR o.status IN ('PAYMENT_CONFIRMED', 'NEEDS_REVIEW', 'PAID_A9')
           )
           AND NOT EXISTS (SELECT 1 FROM presale_payouts p WHERE p.order_id = o.order_id AND p.kind = 'A9')
         )`,
      )
      .bind(...confirmedGuard.args, nowSec)
      .first();
    return BigInt(row?.sum_hi || 0) * DEC9 + BigInt(row?.sum_lo || 0);
  }

  async _promoOutstandingA9(promoSnap) {
    const confirmedGuard = this._confirmedPayoutGuard(promoSnap, 'promo_payouts');
    const row = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(hi_v), 0) AS sum_hi,
           COALESCE(SUM(lo_v), 0) AS sum_lo
         FROM (
           SELECT ${hiExpr('claimable_raw')} AS hi_v, ${loExpr('claimable_raw')} AS lo_v
           FROM promo_balances WHERE claimable_raw != '0'
           UNION ALL
           SELECT ${hiExpr('amount_raw')} AS hi_v, ${loExpr('amount_raw')} AS lo_v
           FROM promo_payouts
           WHERE status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT', 'NEEDS_REVIEW')
              ${confirmedGuard.sql}
           UNION ALL
           SELECT ${hiExpr('c.amount_raw')} AS hi_v, ${loExpr('c.amount_raw')} AS lo_v
           FROM promo_claims c
           LEFT JOIN promo_payouts p ON p.claim_id = c.claim_id
           WHERE c.status IN ('FEE_CONFIRMED', 'PAYOUT_SENT') AND p.claim_id IS NULL
           UNION ALL
           SELECT ${hiExpr('reserved_referral_raw')} AS hi_v, ${loExpr('reserved_referral_raw')} AS lo_v
           FROM presale_order_reservations
           WHERE referral_status = 'RESERVED'
           UNION ALL
           SELECT ${hiExpr('rc.amount_raw')} AS hi_v, ${loExpr('rc.amount_raw')} AS lo_v
           FROM presale_referral_credits rc
           WHERE rc.status IN ('PENDING', 'CREDITING', 'NEEDS_REVIEW')
             AND NOT EXISTS (
               SELECT 1 FROM presale_order_reservations r
               WHERE r.order_id = rc.order_id AND r.referral_status = 'RESERVED'
             )
         )`,
      )
      .bind(...confirmedGuard.args)
      .first();
    return BigInt(row?.sum_hi || 0) * DEC9 + BigInt(row?.sum_lo || 0);
  }

  /**
   * Single D1 transaction (db.batch) for creating a payable mall order:
   * - Enforces pool cap, optional personal quota, presale hot-wallet inventory, promo hot-wallet inventory,
   *   and presale_promo (48,000,000 A9) budget reservation atomically (protecting open legacy obligations).
   * - Any 0-row SQL update or concurrent conflict triggers a NOT NULL rollback of the ENTIRE batch.
   * - Requires the order reservation and payout debit tables before accepting any new order.
   */
  async createOrderAtomic(o, resv, { capA9Raw, userQuotaNano, nowSec, budgetLedger = null, inventorySnapshot = null } = {}) {
    await this._assertOrderSchema();

    const addA9 = split9(o.a9AmountRaw);
    const capA9 = split9(capA9Raw);
    const hasUserQuota = userQuotaNano !== null && userQuotaNano !== undefined;
    const newPresaleNeed = BigInt(o.a9AmountRaw) + BigInt(resv.reservedBonusRaw || 0n);
    const newRefNeed = BigInt(resv.reservedReferralRaw || 0n);
    const budgetNeed = BigInt(resv.reservedBonusRaw || 0n) + newRefNeed;

    const bonusColExpr = `COALESCE(
      CASE WHEN r.bonus_status = 'SETTLED' THEN r.settled_bonus_raw
           WHEN r.bonus_status = 'RESERVED' THEN r.reserved_bonus_raw
           WHEN o.bonus_rolled = 1 THEN o.bonus_a9_raw
           ELSE '0' END, '0')`;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const legacyProtectedRaw = budgetNeed > 0n ? await this._sumOpenLegacyUnreservedPresaleBudget() : 0n;
      const budgetPrep = budgetNeed > 0n && budgetLedger && typeof budgetLedger.prepareAtomicReserve === 'function'
        ? await budgetLedger.prepareAtomicReserve('presale_promo', budgetNeed, nowSec, { extraReservedRaw: legacyProtectedRaw })
        : null;

      let whereClause = `WHERE EXISTS (
             SELECT 1 FROM (
               SELECT
                 (COALESCE(SUM(${hiExpr('a9_amount_raw')}), 0) + CAST(? AS INTEGER)
                   + (COALESCE(SUM(${loExpr('a9_amount_raw')}), 0) + CAST(? AS INTEGER)) / 1000000000) AS tot_hi,
                 ((COALESCE(SUM(${loExpr('a9_amount_raw')}), 0) + CAST(? AS INTEGER)) % 1000000000) AS tot_lo
               FROM presale_orders WHERE ${RESERVING_SQL}
             ) WHERE tot_hi < CAST(? AS INTEGER) OR (tot_hi = CAST(? AS INTEGER) AND tot_lo <= CAST(? AS INTEGER))
           )`;
      const tailArgs = [addA9.hi, addA9.lo, addA9.lo, nowSec, capA9.hi, capA9.hi, capA9.lo];

      if (hasUserQuota) {
        const addTon = split9(o.tonNano);
        const capTon = split9(userQuotaNano);
        const aliases = addressAliases(o.walletAddress);
        const aliasPlaceholders = aliases.map(() => '?').join(', ');
        whereClause += `
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
        tailArgs.push(
          addTon.hi, addTon.lo, addTon.lo, o.walletKey, ...aliases, nowSec, capTon.hi, capTon.hi, capTon.lo,
        );
      }

      if (inventorySnapshot?.presale) {
        const addPresale = split9(newPresaleNeed);
        const capPresale = split9(inventorySnapshot.presale.a9Raw);
        const presaleConfirmedGuard = this._confirmedPayoutGuard(inventorySnapshot.presale, 'presale_payouts');
        whereClause += `
           AND EXISTS (
             SELECT 1 FROM (
               SELECT
                 (COALESCE(SUM(hi_v), 0) + CAST(? AS INTEGER)
                   + (COALESCE(SUM(lo_v), 0) + CAST(? AS INTEGER)) / 1000000000) AS tot_hi,
                 ((COALESCE(SUM(lo_v), 0) + CAST(? AS INTEGER)) % 1000000000) AS tot_lo
               FROM (
                 SELECT ${hiExpr('amount')} AS hi_v, ${loExpr('amount')} AS lo_v
                 FROM presale_payouts
                 WHERE kind = 'A9' AND (
                   status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT', 'NEEDS_REVIEW')
                   ${presaleConfirmedGuard.sql}
                 )
                 UNION ALL
                 SELECT
                   ${hiExpr('o.a9_amount_raw')} + ${hiExpr(bonusColExpr)} AS hi_v,
                   ${loExpr('o.a9_amount_raw')} + ${loExpr(bonusColExpr)} AS lo_v
                 FROM presale_orders o
                 LEFT JOIN presale_order_reservations r ON r.order_id = o.order_id
                 WHERE (
                   (o.status IN ('PENDING_PAYMENT', 'PENDING_TON') AND (o.expires_at = 0 OR o.expires_at >= ?))
                   OR o.status IN ('PAYMENT_CONFIRMED', 'NEEDS_REVIEW', 'PAID_A9')
                 )
                 AND NOT EXISTS (SELECT 1 FROM presale_payouts p WHERE p.order_id = o.order_id AND p.kind = 'A9')
               )
             ) WHERE tot_hi < CAST(? AS INTEGER) OR (tot_hi = CAST(? AS INTEGER) AND tot_lo <= CAST(? AS INTEGER))
           )`;
        tailArgs.push(
          addPresale.hi, addPresale.lo, addPresale.lo,
          ...presaleConfirmedGuard.args,
          nowSec,
          capPresale.hi, capPresale.hi, capPresale.lo,
        );
      }

      if (newRefNeed > 0n && inventorySnapshot?.promo) {
        const addRef = split9(newRefNeed);
        const capPromo = split9(inventorySnapshot.promo.a9Raw);
        const promoConfirmedGuard = this._confirmedPayoutGuard(inventorySnapshot.promo, 'promo_payouts');
        whereClause += `
           AND EXISTS (
             SELECT 1 FROM (
               SELECT
                 (COALESCE(SUM(hi_v), 0) + CAST(? AS INTEGER)
                   + (COALESCE(SUM(lo_v), 0) + CAST(? AS INTEGER)) / 1000000000) AS tot_hi,
                 ((COALESCE(SUM(lo_v), 0) + CAST(? AS INTEGER)) % 1000000000) AS tot_lo
               FROM (
                 SELECT ${hiExpr('claimable_raw')} AS hi_v, ${loExpr('claimable_raw')} AS lo_v
                 FROM promo_balances WHERE claimable_raw != '0'
                 UNION ALL
                 SELECT ${hiExpr('amount_raw')} AS hi_v, ${loExpr('amount_raw')} AS lo_v
                 FROM promo_payouts
                 WHERE status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT', 'NEEDS_REVIEW')
                    ${promoConfirmedGuard.sql}
                 UNION ALL
                 SELECT ${hiExpr('c.amount_raw')} AS hi_v, ${loExpr('c.amount_raw')} AS lo_v
                 FROM promo_claims c
                 LEFT JOIN promo_payouts p ON p.claim_id = c.claim_id
                 WHERE c.status IN ('FEE_CONFIRMED', 'PAYOUT_SENT') AND p.claim_id IS NULL
                 UNION ALL
                 SELECT ${hiExpr('reserved_referral_raw')} AS hi_v, ${loExpr('reserved_referral_raw')} AS lo_v
                 FROM presale_order_reservations
                 WHERE referral_status = 'RESERVED'
                 UNION ALL
                 SELECT ${hiExpr('rc.amount_raw')} AS hi_v, ${loExpr('rc.amount_raw')} AS lo_v
                 FROM presale_referral_credits rc
                 WHERE rc.status IN ('PENDING', 'CREDITING', 'NEEDS_REVIEW')
                   AND NOT EXISTS (
                     SELECT 1 FROM presale_order_reservations r
                     WHERE r.order_id = rc.order_id AND r.referral_status = 'RESERVED'
                   )
               )
             ) WHERE tot_hi < CAST(? AS INTEGER) OR (tot_hi = CAST(? AS INTEGER) AND tot_lo <= CAST(? AS INTEGER))
           )`;
        tailArgs.push(
          addRef.hi, addRef.lo, addRef.lo,
          ...promoConfirmedGuard.args,
          capPromo.hi, capPromo.hi, capPromo.lo,
        );
      }

      const stmts = [
        this.db
          .prepare(
            `INSERT INTO presale_orders
               (order_id, wallet_address, wallet_key, tg_user_id, referrer_id, sku_id, open_mode, ton_nano, a9_amount_raw, memo, status,
                refund_ton_nano, expires_at, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PAYMENT', '0', ?, ?, ?
             ${whereClause}`,
          )
          .bind(
            o.orderId, o.walletAddress, o.walletKey, o.tgUserId, o.referrerId, o.skuId || null, o.openMode || 'INSTANT',
            o.tonNano.toString(), o.a9AmountRaw.toString(), o.memo,
            o.expiresAt, o.createdAt, o.updatedAt,
            ...tailArgs,
          ),
        // Statement 2: base_a9_raw is NOT NULL; if Statement 1 inserted 0 rows, subquery returns NULL -> full batch rollback!
        this.db
          .prepare(
            `INSERT INTO presale_order_reservations
               (order_id, sku_id, base_a9_raw, reserved_bonus_raw, settled_bonus_raw, released_bonus_raw,
                reserved_referral_raw, referral_bps, max_boost_bps, bonus_status, referral_status, status,
                legacy_backfilled, snapshot_network, snapshot_jetton_master, snapshot_presale_wallet,
                snapshot_promo_wallet, snapshot_at, created_at, updated_at)
             VALUES (
               ?, ?,
               (SELECT a9_amount_raw FROM presale_orders WHERE order_id = ?),
               ?, '0', '0',
               ?, ?, ?, ?, ?, 'ACTIVE',
               0, ?, ?, ?, ?, ?, ?, ?
             )`,
          )
          .bind(
            o.orderId,
            resv.skuId || null,
            o.orderId,
            BigInt(resv.reservedBonusRaw || 0n).toString(),
            BigInt(resv.reservedReferralRaw || 0n).toString(),
            Number(resv.referralBps || 0),
            Number(resv.maxBoostBps || 0),
            resv.bonusStatus,
            resv.referralStatus,
            resv.snapshotNetwork || null,
            resv.snapshotJettonMaster || null,
            resv.snapshotPresaleWallet || null,
            resv.snapshotPromoWallet || null,
            resv.snapshotAt ?? null,
            nowSec,
            nowSec,
          ),
      ];

      if (budgetPrep) {
        stmts.push(
          budgetPrep.buildStrictUpdateStmt(
            ` AND EXISTS (SELECT 1 FROM presale_orders WHERE order_id = ?)
              AND EXISTS (SELECT 1 FROM (${this._legacyBudgetHoldSql()})
                          WHERE sum_hi + sum_lo / 1000000000 = CAST(? AS INTEGER)
                            AND sum_lo % 1000000000 = CAST(? AS INTEGER))`,
            [o.orderId, (legacyProtectedRaw / DEC9).toString(), (legacyProtectedRaw % DEC9).toString()],
          ),
        );
      }

      try {
        await this.db.batch(stmts);
        return { ok: true };
      } catch (e) {
        if (!isNotNullOrConstraint(e)) throw e;
        // Check whether promo_budget_ledger CAS conflicted concurrently -> retry with fresh snapshot
        if (budgetPrep && budgetLedger && typeof budgetLedger.getBucket === 'function') {
          const curBucket = await budgetLedger.getBucket('presale_promo');
          if ((curBucket && curBucket.spentRaw !== budgetPrep.curSpentStr)
              || await this._sumOpenLegacyUnreservedPresaleBudget() !== legacyProtectedRaw) {
            continue;
          }
        }
        // Diagnose exact deterministic rejection reason
        const { reservedA9Raw, userReservedNano } = await this.sumReserved(nowSec, o.walletKey);
        if (hasUserQuota && userReservedNano + BigInt(o.tonNano) > BigInt(userQuotaNano)) {
          return { ok: false, code: 'OVER_QUOTA' };
        }
        if (reservedA9Raw >= BigInt(capA9Raw)) return { ok: false, code: 'SOLD_OUT' };
        if (reservedA9Raw + BigInt(o.a9AmountRaw) > BigInt(capA9Raw)) return { ok: false, code: 'EXCEEDS_POOL' };
        if (inventorySnapshot?.presale) {
          const usedPresale = await this._presaleOutstandingA9(nowSec, inventorySnapshot.presale);
          if (usedPresale + newPresaleNeed > inventorySnapshot.presale.a9Raw) {
            return { ok: false, code: 'HOT_WALLET_LOW_INVENTORY' };
          }
        }
        if (newRefNeed > 0n && inventorySnapshot?.promo) {
          const usedPromo = await this._promoOutstandingA9(inventorySnapshot.promo);
          if (usedPromo + newRefNeed > inventorySnapshot.promo.a9Raw) {
            return { ok: false, code: 'PROMO_WALLET_LOW_INVENTORY' };
          }
        }
        return { ok: false, code: 'EXCEEDS_POOL' };
      }
    }
    throw new PresaleError('ORDER_CONFLICT', 'concurrent order reservation conflict, please retry');
  }

  /**
   * Single D1 transaction (db.batch) for confirmed order bonus roll + payout queue + unused bonus release.
   */
  async queuePayoutAtomic(orderId, fromStatus, patch, p, { settledBonusRaw = 0n, unusedBonusRaw = 0n, budgetLedger = null, nowSec = Math.floor(Date.now() / 1000) } = {}) {
    const set = buildSet(patch, ORDER_COLS);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const releasePrep = BigInt(unusedBonusRaw) > 0n && budgetLedger && typeof budgetLedger.prepareAtomicRelease === 'function'
        ? await budgetLedger.prepareAtomicRelease('presale_promo', unusedBonusRaw, nowSec)
        : null;

      const stmts = [
        this.db
          .prepare(
            `INSERT INTO presale_payouts
               (payout_id, order_id, inbound_tx_hash, kind, recipient, amount, query_id, status, attempts, ambiguous, tx_hash, last_error, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?
             WHERE EXISTS (SELECT 1 FROM presale_orders WHERE order_id = ? AND status = ?)
               AND EXISTS (SELECT 1 FROM presale_order_reservations WHERE order_id = ? AND bonus_status = 'RESERVED')
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            p.payoutId, p.orderId, p.inboundTxHash, p.kind, p.recipient, p.amount, p.queryId, p.status, p.attempts, 0, p.createdAt, p.updatedAt,
            orderId, fromStatus, orderId,
          ),
        this.db
          .prepare(`UPDATE presale_orders SET ${set.sql} WHERE order_id = ? AND status = ?`)
          .bind(...set.vals, orderId, fromStatus),
        this.db
          .prepare(
            `UPDATE presale_order_reservations
             SET settled_bonus_raw = CASE
                   WHEN bonus_status = 'RESERVED'
                    AND EXISTS (SELECT 1 FROM presale_orders WHERE order_id = ? AND status = 'PAYOUT_PENDING' AND bonus_rolled = 1)
                    AND EXISTS (SELECT 1 FROM presale_payouts WHERE payout_id = ?)
                   THEN ? ELSE NULL END,
                 released_bonus_raw = ?,
                 bonus_status = 'SETTLED',
                 status = CASE WHEN referral_status IN ('NONE', 'CREDITED', 'RELEASED') THEN 'COMPLETED' ELSE status END,
                 updated_at = ?
             WHERE order_id = ?`,
          )
          .bind(orderId, p.payoutId, BigInt(settledBonusRaw).toString(), BigInt(unusedBonusRaw).toString(), nowSec, orderId),
      ];

      if (releasePrep) {
        stmts.push(
          releasePrep.buildStrictUpdateStmt(
            " AND EXISTS (SELECT 1 FROM presale_order_reservations WHERE order_id = ? AND bonus_status = 'SETTLED')",
            [orderId],
          ),
        );
      }

      try {
        const out = await this.db.batch(stmts);
        return changes(out?.[1]) === 1;
      } catch (e) {
        if (!isNotNullOrConstraint(e)) throw e;
        const curOrd = await this.getOrder(orderId);
        if (!curOrd || curOrd.status !== fromStatus) return false;
        const curRes = await this.getReservation(orderId);
        if (!curRes || curRes.bonusStatus !== 'RESERVED') return false;
        continue;
      }
    }
    throw new PresaleError('QUEUE_PAYOUT_CONFLICT', 'concurrent payout queue conflict, please retry');
  }

  async markReservationBonusSettled(orderId, settledBonusRaw, releasedBonusRaw, nowSec) {
    try {
      const res = await this.db
        .prepare(
          `UPDATE presale_order_reservations
           SET settled_bonus_raw = ?,
               released_bonus_raw = ?,
               bonus_status = 'SETTLED',
               status = CASE WHEN referral_status IN ('NONE', 'CREDITED', 'RELEASED') THEN 'COMPLETED' ELSE status END,
               updated_at = ?
           WHERE order_id = ? AND bonus_status = 'RESERVED'`,
        )
        .bind(BigInt(settledBonusRaw).toString(), BigInt(releasedBonusRaw).toString(), nowSec, orderId)
        .run();
      return changes(res) === 1;
    } catch (e) {
      if (isMissingTableErr(e)) return false;
      throw e;
    }
  }

  async markReservationReferralCredited(orderId, nowSec) {
    try {
      const res = await this.db
        .prepare(
          `UPDATE presale_order_reservations
           SET referral_status = 'CREDITED',
               status = CASE WHEN bonus_status IN ('SETTLED', 'RELEASED') THEN 'COMPLETED' ELSE status END,
               updated_at = ?
           WHERE order_id = ? AND referral_status = 'RESERVED'`,
        )
        .bind(nowSec, orderId)
        .run();
      return changes(res) === 1;
    } catch (e) {
      if (isMissingTableErr(e)) return false;
      throw e;
    }
  }

  /**
   * Release presale_promo reservations for expired unpaid orders (mutually exclusive with commitInbound)
   * and refunded/cancelled orders that have NO active/in-flight/ambiguous A9 payout or referral credit.
   */
  async releaseExpiredOrRefundedReservations(nowSec, { budgetLedger = null, limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit || 50))));
    let rows = [];
    try {
      const res = await this.db
        .prepare(
          `SELECT r.*, o.status AS order_status, o.expires_at AS order_expires_at, o.inbound_tx_hash AS order_inbound_tx_hash
           FROM presale_order_reservations r
           JOIN presale_orders o ON o.order_id = r.order_id
           WHERE r.status = 'ACTIVE'
             AND (
               (o.status IN ('PENDING_PAYMENT', 'PENDING_TON') AND o.inbound_tx_hash IS NULL AND o.expires_at > 0 AND o.expires_at < ?)
               OR o.status IN ('REFUNDED', 'REFUNDED_FREE', 'REFUNDED_MINUS_FEE', 'CANCELLED')
             )
             AND NOT EXISTS (
               SELECT 1 FROM presale_payouts p
               WHERE p.order_id = r.order_id AND p.kind = 'A9'
                 AND p.status IN ('PENDING', 'BROADCASTING', 'SENT', 'RETRY', 'CONFIRMED', 'NEEDS_REVIEW')
             )
             AND NOT EXISTS (
               SELECT 1 FROM presale_referral_credits c
               WHERE c.order_id = r.order_id
                 AND c.status IN ('PENDING', 'CREDITING', 'CREDITED', 'NEEDS_REVIEW')
             )
           ORDER BY r.created_at ASC
           LIMIT ?`,
        )
        .bind(nowSec, safeLimit)
        .all();
      rows = res?.results || [];
    } catch (e) {
      if (isMissingTableErr(e)) return { expiredReleased: 0, refundedReleased: 0, releasedRaw: '0' };
      throw e;
    }

    let expiredReleased = 0;
    let refundedReleased = 0;
    let releasedTotal = 0n;

    for (const row of rows) {
      const r = rowToReservation(row);
      const isExpiredUnpaid = ['PENDING_PAYMENT', 'PENDING_TON'].includes(row.order_status);
      const delta = r.legacyBackfilled
        ? 0n
        : (r.bonusStatus === 'RESERVED' ? r.reservedBonusRaw : 0n) + (r.referralStatus === 'RESERVED' ? r.reservedReferralRaw : 0n);

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const releasePrep = delta > 0n && budgetLedger && typeof budgetLedger.prepareAtomicRelease === 'function'
          ? await budgetLedger.prepareAtomicRelease('presale_promo', delta, nowSec)
          : null;

        const stmts = [];
        if (isExpiredUnpaid) {
          stmts.push(
            this.db
              .prepare(
                `UPDATE presale_orders
                 SET status = 'EXPIRED', updated_at = ?
                 WHERE order_id = ?
                   AND status IN ('PENDING_PAYMENT', 'PENDING_TON')
                   AND inbound_tx_hash IS NULL
                   AND expires_at > 0 AND expires_at < ?`,
              )
              .bind(nowSec, r.orderId, nowSec),
          );
          stmts.push(
            this.db
              .prepare(
                `UPDATE presale_order_reservations
                 SET bonus_status = CASE WHEN bonus_status = 'RESERVED' THEN 'RELEASED' ELSE bonus_status END,
                     released_bonus_raw = CASE WHEN bonus_status = 'RESERVED' THEN reserved_bonus_raw ELSE released_bonus_raw END,
                     referral_status = CASE WHEN referral_status = 'RESERVED' THEN 'RELEASED' ELSE referral_status END,
                     status = CASE
                       WHEN status = 'ACTIVE'
                        AND EXISTS (SELECT 1 FROM presale_orders WHERE order_id = ? AND status = 'EXPIRED')
                        AND NOT EXISTS (SELECT 1 FROM presale_payouts WHERE order_id = ? AND kind = 'A9')
                       THEN 'RELEASED' ELSE NULL END,
                     updated_at = ?
                 WHERE order_id = ?`,
              )
              .bind(r.orderId, r.orderId, nowSec, r.orderId),
          );
        } else {
          stmts.push(
            this.db
              .prepare(
                `UPDATE presale_order_reservations
                 SET bonus_status = CASE WHEN bonus_status = 'RESERVED' THEN 'RELEASED' ELSE bonus_status END,
                     released_bonus_raw = CASE WHEN bonus_status = 'RESERVED' THEN reserved_bonus_raw ELSE released_bonus_raw END,
                     referral_status = CASE WHEN referral_status = 'RESERVED' THEN 'RELEASED' ELSE referral_status END,
                     status = CASE
                       WHEN status = 'ACTIVE'
                        AND EXISTS (SELECT 1 FROM presale_orders WHERE order_id = ? AND status IN ('REFUNDED', 'REFUNDED_FREE', 'REFUNDED_MINUS_FEE', 'CANCELLED'))
                        AND NOT EXISTS (
                          SELECT 1 FROM presale_payouts
                          WHERE order_id = ? AND kind = 'A9'
                            AND status IN ('PENDING', 'BROADCASTING', 'SENT', 'RETRY', 'CONFIRMED', 'NEEDS_REVIEW')
                        )
                       THEN 'RELEASED' ELSE NULL END,
                     updated_at = ?
                 WHERE order_id = ?`,
              )
              .bind(r.orderId, r.orderId, nowSec, r.orderId),
          );
        }

        if (releasePrep) {
          stmts.push(
            releasePrep.buildStrictUpdateStmt(
              " AND EXISTS (SELECT 1 FROM presale_order_reservations WHERE order_id = ? AND status = 'RELEASED')",
              [r.orderId],
            ),
          );
        }

        try {
          await this.db.batch(stmts);
          if (isExpiredUnpaid) expiredReleased += 1;
          else refundedReleased += 1;
          releasedTotal += delta;
          break;
        } catch (e) {
          if (!isNotNullOrConstraint(e)) throw e;
          const freshRes = await this.getReservation(r.orderId);
          if (!freshRes || freshRes.status !== 'ACTIVE') break;
          const freshOrd = await this.getOrder(r.orderId);
          if (isExpiredUnpaid && (!freshOrd || !['PENDING_PAYMENT', 'PENDING_TON'].includes(freshOrd.status) || freshOrd.inboundTxHash)) {
            break; // Concurrent payment confirmation won -> do NOT release!
          }
          continue;
        }
      }
    }

    return { expiredReleased, refundedReleased, releasedRaw: releasedTotal.toString() };
  }
}

/**
 * Idempotent reconciliation & backfill for pre-0017 legacy presale orders.
 * - For determinable active/paid/pending-referral legacy orders, atomically reserves their
 *   unreserved bonus + 6% referral exposure into presale_promo (legacy_backfilled = 0) so
 *   new orders CANNOT crowd out pre-0017 paid orders and payouts settle cleanly without NEEDS_REVIEW.
 * - If budget headroom is exhausted or SKU/obligation is ambiguous, records OPEN
 *   LEGACY_PRESALE_UNRESERVED items in actuarial_reconciliation_items which ALSO protect
 *   new-order budget headroom during createOrderAtomic.
 */
export async function reconcileLegacyPresaleOrders(db, nowSec = Math.floor(Date.now() / 1000), { budgetLedger = null } = {}) {
  const ledger = budgetLedger || new D1PromoBudgetLedger({ db });
  await db.prepare(`UPDATE actuarial_reconciliation_items
    SET evidenced_raw = '0', unexplained_raw = recorded_raw,
        detail_json = json_remove(detail_json, '$.hasCreditAndBudgetEvidence'), updated_at = ?
    WHERE category = 'LEGACY_REFERRAL_CREDITING_REVIEW' AND status = 'OPEN' AND evidenced_raw != '0'`)
    .bind(nowSec).run();
  const res = await db
    .prepare(
      `SELECT o.*, c.status AS credit_status, c.amount_raw AS credit_amount_raw
       FROM presale_orders o
       LEFT JOIN presale_order_reservations r ON r.order_id = o.order_id
       LEFT JOIN presale_referral_credits c ON c.order_id = o.order_id
       WHERE r.order_id IS NULL
       ORDER BY o.created_at ASC`,
    )
    .all();
  const rows = res?.results || [];
  let backfilled = 0;
  let reservedBudgetCount = 0;
  let reconciliationLogged = 0;
  let skippedTerminal = 0;

  for (const row of rows) {
    const status = String(row.status || '');
    const isExpiredUnpaid = ['PENDING_PAYMENT', 'PENDING_TON'].includes(status)
      && Number(row.expires_at || 0) > 0 && Number(row.expires_at) < nowSec;
    const isClosedRefund = ['REFUNDED', 'REFUNDED_FREE', 'REFUNDED_MINUS_FEE', 'EXPIRED', 'CANCELLED', 'DUST_IGNORED'].includes(status);
    const hasPendingReferral = ['PENDING', 'CREDITING', 'NEEDS_REVIEW'].includes(String(row.credit_status || ''));
    const isCompletedNoPendingRef = status === 'COMPLETED' && !hasPendingReferral;

    if (isExpiredUnpaid || isClosedRefund || isCompletedNoPendingRef) {
      skippedTerminal += 1;
      continue;
    }

    const skuId = row.sku_id || CHEST_MALL_NANO_TO_SKU[String(row.ton_nano || '')] || null;
    const pack = skuId ? CHEST_MALL_CATALOG[skuId] : null;
    const baseA9Raw = BigInt(row.a9_amount_raw || '0');
    const bonusRolled = Number(row.bonus_rolled || 0) === 1;
    const bonusA9Raw = BigInt(row.bonus_a9_raw || '0');
    const hasRef = Boolean(row.referrer_id && addressKey(row.referrer_id) !== (row.wallet_key || addressKey(row.wallet_address)));
    const expectedRefRaw = hasRef ? (baseA9Raw * REFERRAL_BPS) / 100n : 0n;

    if (!pack) {
      const itemId = `legacy_presale_ambiguous:${row.order_id}`;
      const ins = await db
        .prepare(
          `INSERT OR IGNORE INTO actuarial_reconciliation_items
             (item_id, category, entity_key, recorded_raw, evidenced_raw, unexplained_raw, detail_json, status, created_at, updated_at)
           VALUES (?, 'LEGACY_PRESALE_UNRESERVED', ?, ?, '0', ?, ?, 'OPEN', ?, ?)`,
        )
        .bind(
          itemId,
          String(row.order_id),
          baseA9Raw.toString(),
          baseA9Raw.toString(),
          JSON.stringify({ orderId: row.order_id, status, tonNano: String(row.ton_nano || '0'), reason: 'unknown_legacy_sku' }),
          nowSec,
          nowSec,
        )
        .run();
      if (changes(ins) === 1) reconciliationLogged += 1;
      continue;
    }

    const reservedBonusRaw = bonusRolled ? bonusA9Raw : BigInt(pack.maxBoostA9Raw || '0');
    const settledBonusRaw = bonusRolled ? bonusA9Raw : 0n;
    const bonusStatus = bonusRolled ? 'SETTLED' : (reservedBonusRaw > 0n ? 'RESERVED' : 'SETTLED');
    const creditStatus = String(row.credit_status || '');
    const referralAmbiguous = hasRef && (creditStatus === 'CREDITING' || creditStatus === 'NEEDS_REVIEW');
    const referralStatus = !hasRef
      ? 'NONE'
      : (creditStatus === 'CREDITED' ? 'CREDITED' : 'RESERVED');
    const resStatus = bonusStatus === 'SETTLED' && (referralStatus === 'NONE' || referralStatus === 'CREDITED')
      ? 'COMPLETED'
      : ((status === 'NEEDS_REVIEW' || referralAmbiguous) ? 'NEEDS_REVIEW' : 'ACTIVE');

    // 对处于 CREDITING / NEEDS_REVIEW 的存量返佣，旧版可能已完成预算扣减及/或推广余额入账：
    // 严禁自动重复扣减 presale_promo 预算！先核查既有入账与扣账证据，并转入对账清单保留责任。
    const bonusAutoReserve = bonusStatus === 'RESERVED' ? reservedBonusRaw : 0n;
    const referralAutoReserve = (referralStatus === 'RESERVED' && !referralAmbiguous) ? expectedRefRaw : 0n;
    const autoReserveNeed = bonusAutoReserve + referralAutoReserve;

    if (referralAmbiguous && expectedRefRaw > 0n) {
      // The old ledger has no per-order budget or balance entry for an interrupted credit.
      const disputedRaw = BigInt(row.credit_amount_raw || '0');
      const holdRaw = disputedRaw > 0n ? disputedRaw : expectedRefRaw;
      const itemId = `legacy_referral_review:${row.order_id}`;
      const insAmb = await db
        .prepare(
          `INSERT OR IGNORE INTO actuarial_reconciliation_items
             (item_id, category, entity_key, recorded_raw, evidenced_raw, unexplained_raw, detail_json, status, created_at, updated_at)
           VALUES (?, 'LEGACY_REFERRAL_CREDITING_REVIEW', ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
        )
        .bind(
          itemId,
          String(row.order_id),
          holdRaw.toString(),
          '0',
          holdRaw.toString(),
          JSON.stringify({
            orderId: row.order_id,
            orderStatus: status,
            creditStatus,
            referrer: String(row.referrer_id || ''),
            expectedRefRaw: expectedRefRaw.toString(),
            holdRaw: holdRaw.toString(),
            reason: 'legacy_referral_crediting_or_needs_review_no_auto_deduct',
          }),
          nowSec,
          nowSec,
        )
        .run();
      if (changes(insAmb) === 1) reconciliationLogged += 1;
    }

    let reservedInBudget = false;
    if (autoReserveNeed > 0n && typeof ledger?.prepareAtomicReserve === 'function') {
      const legacyFlag = referralAmbiguous ? 1 : 0;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        let budgetPrep = null;
        try {
          budgetPrep = await ledger.prepareAtomicReserve('presale_promo', autoReserveNeed, nowSec);
        } catch (e) {
          if (e?.code === 'PROMO_BUDGET_EXHAUSTED') break;
          throw e;
        }
        if (!budgetPrep) break;
        try {
          const out = await db.batch([
            db
              .prepare(
                `INSERT INTO presale_order_reservations
                   (order_id, sku_id, base_a9_raw, reserved_bonus_raw, settled_bonus_raw, released_bonus_raw,
                    reserved_referral_raw, referral_bps, max_boost_bps, bonus_status, referral_status, status,
                    legacy_backfilled, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, '0', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                String(row.order_id),
                skuId,
                baseA9Raw.toString(),
                reservedBonusRaw.toString(),
                settledBonusRaw.toString(),
                expectedRefRaw.toString(),
                hasRef ? Number(REFERRAL_BPS) : 0,
                Number(pack.maxBoostBps || 0),
                bonusStatus,
                referralStatus,
                resStatus,
                legacyFlag,
                nowSec,
                nowSec,
              ),
            budgetPrep.buildStrictUpdateStmt(
              ' AND EXISTS (SELECT 1 FROM presale_order_reservations WHERE order_id = ?)',
              [String(row.order_id)],
            ),
          ]);
          if (changes(out?.[0]) === 1) {
            backfilled += 1;
            reservedBudgetCount += 1;
            reservedInBudget = true;
          }
          break;
        } catch (e) {
          if (isUnique(e)) {
            reservedInBudget = true; // already backfilled concurrently
            break;
          }
          if (isNotNullOrConstraint(e)) continue;
          throw e;
        }
      }
    }

    if (!reservedInBudget) {
      const insRes = await db
        .prepare(
          `INSERT OR IGNORE INTO presale_order_reservations
             (order_id, sku_id, base_a9_raw, reserved_bonus_raw, settled_bonus_raw, released_bonus_raw,
              reserved_referral_raw, referral_bps, max_boost_bps, bonus_status, referral_status, status,
              legacy_backfilled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, '0', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          String(row.order_id),
          skuId,
          baseA9Raw.toString(),
          reservedBonusRaw.toString(),
          settledBonusRaw.toString(),
          expectedRefRaw.toString(),
          hasRef ? Number(REFERRAL_BPS) : 0,
          Number(pack.maxBoostBps || 0),
          bonusStatus,
          referralStatus,
          resStatus,
          nowSec,
          nowSec,
        )
        .run();
      if (changes(insRes) === 1) backfilled += 1;

      if (autoReserveNeed > 0n) {
        const itemId = `legacy_presale_unreserved:${row.order_id}`;
        const insRec = await db
          .prepare(
            `INSERT OR IGNORE INTO actuarial_reconciliation_items
               (item_id, category, entity_key, recorded_raw, evidenced_raw, unexplained_raw, detail_json, status, created_at, updated_at)
             VALUES (?, 'LEGACY_PRESALE_UNRESERVED', ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
          )
          .bind(
            itemId,
            String(row.order_id),
            autoReserveNeed.toString(),
            autoReserveNeed.toString(),
            '0',
            JSON.stringify({
              orderId: row.order_id,
              status,
              skuId,
              bonusStatus,
              referralStatus,
              reservedBonusRaw: reservedBonusRaw.toString(),
              reservedReferralRaw: expectedRefRaw.toString(),
              reason: 'budget_exhausted_during_reconcile',
            }),
            nowSec,
            nowSec,
          )
          .run();
        if (changes(insRec) === 1) reconciliationLogged += 1;
      }
    }
  }

  return { scanned: rows.length, backfilled, reservedBudgetCount, reconciliationLogged, skippedTerminal };
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

/**
 * Idempotent reconciliation & backfill for pre-0017 legacy 48H pending vault balances.
 * - ONLY backfills pending_reward_vouchers (with legacy_backfilled = 1, never re-deducting promo_budget_ledger)
 *   when source, amount, expiry window, and unactivated status reconcile 1:1 with prediction_rewards.pending_activation_raw.
 * - Unattributable or mismatched legacy balances are NEVER guessed or auto-reclaimed; they remain claimable under
 *   existing rules and are logged to actuarial_reconciliation_items for manual audit.
 */
export async function backfillLegacyPendingVouchers(db, nowSec = Math.floor(Date.now() / 1000)) {
  const rowsRes = await db
    .prepare(
      `SELECT user_id, pending_activation_raw, pending_expires_at
       FROM prediction_rewards
       WHERE pending_activation_raw != '0'
       ORDER BY user_id ASC`,
    )
    .all();
  const rows = rowsRes?.results || [];
  let scanned = 0;
  let alreadyCovered = 0;
  let backfilledUsers = 0;
  let backfilledVouchers = 0;
  let reconciliationLogged = 0;

  for (const r of rows) {
    const uid = String(r.user_id);
    const pendingRaw = BigInt(String(r.pending_activation_raw || '0'));
    if (pendingRaw <= 0n) continue;
    scanned += 1;

    const existingRes = await db
      .prepare("SELECT voucher_id, amount_raw FROM pending_reward_vouchers WHERE user_id = ? AND status = 'PENDING'")
      .bind(uid)
      .all();
    const existingRows = existingRes?.results || [];
    const existingIds = new Set(existingRows.map((x) => String(x.voucher_id)));
    let existingSum = 0n;
    for (const x of existingRows) existingSum += BigInt(String(x.amount_raw || '0'));

    if (existingSum === pendingRaw) {
      alreadyCovered += 1;
      continue;
    }

    const expiresAtMs = r.pending_expires_at === null || r.pending_expires_at === undefined ? null : Number(r.pending_expires_at);
    const remainingNeed = pendingRaw > existingSum ? pendingRaw - existingSum : 0n;

    if (expiresAtMs === null || remainingNeed === 0n) {
      const itemId = `legacy_pending_unattributable:${uid}`;
      const ins = await db
        .prepare(
          `INSERT OR IGNORE INTO actuarial_reconciliation_items
             (item_id, category, entity_key, recorded_raw, evidenced_raw, unexplained_raw, detail_json, status, created_at, updated_at)
           VALUES (?, 'LEGACY_PENDING_UNATTRIBUTABLE', ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
        )
        .bind(
          itemId,
          uid,
          pendingRaw.toString(),
          existingSum.toString(),
          (pendingRaw > existingSum ? pendingRaw - existingSum : existingSum - pendingRaw).toString(),
          JSON.stringify({ userId: uid, pendingExpiresAt: expiresAtMs, reason: expiresAtMs === null ? 'missing_expiry_timestamp' : 'existing_vouchers_exceed_pending' }),
          nowSec,
          nowSec,
        )
        .run();
      if (changes(ins) === 1) reconciliationLogged += 1;
      continue;
    }

    const windowStartSec = Math.floor((expiresAtMs - VOUCHER_TTL_MS) / 1000) - 1;
    const windowEndSec = Math.ceil(expiresAtMs / 1000);

    const lastActRow = await db
      .prepare('SELECT MAX(created_at) AS last_act FROM prediction_activations WHERE user_id = ?')
      .bind(uid)
      .first();
    const lastActSec = Number(lastActRow?.last_act || 0);
    const minGrantSec = Math.max(windowStartSec, lastActSec);

    const candidates = [];

    // 1) Free Bronze / Silver & Warmup chests opened inside window after last activation
    const chestRes = await db
      .prepare(
        `SELECT chest_id, source, tier, base_a9_raw, boost_a9_raw, opened_at
         FROM user_chests
         WHERE owner_user_id = ? AND status = 'OPENED'
           AND (source = 'WARMUP_ROUND' OR (source = 'FREE_TIER' AND tier IN ('bronze', 'silver')))
           AND opened_at IS NOT NULL AND opened_at >= ? AND opened_at <= ?
         ORDER BY opened_at ASC`,
      )
      .bind(uid, minGrantSec, windowEndSec)
      .all();
    for (const c of chestRes?.results || []) {
      const vId = `chest:${c.chest_id}`;
      if (existingIds.has(vId)) continue;
      const amt = BigInt(String(c.base_a9_raw || '0')) + BigInt(String(c.boost_a9_raw || '0'));
      if (amt <= 0n) continue;
      const isWarmup = String(c.source) === 'WARMUP_ROUND';
      candidates.push({
        voucherId: vId,
        sourceBucket: isWarmup ? 'warmup' : 'free_chest_captain',
        sourceKind: isWarmup ? 'WARMUP_CHEST' : 'FREE_CHEST',
        sourceRef: String(c.chest_id),
        amountRaw: amt,
        grantAtSec: Number(c.opened_at),
      });
    }

    // 2) Captain founding bonus granted inside window after last activation
    const capRes = await db
      .prepare(
        `SELECT team_id, amount_raw, created_at
         FROM captain_founding_bonuses
         WHERE captain_user_id = ? AND created_at >= ? AND created_at <= ?
         ORDER BY created_at ASC`,
      )
      .bind(uid, minGrantSec, windowEndSec)
      .all();
    for (const cb of capRes?.results || []) {
      const vId = `captain:${cb.team_id}`;
      if (existingIds.has(vId)) continue;
      const amt = BigInt(String(cb.amount_raw || '0'));
      if (amt <= 0n) continue;
      candidates.push({
        voucherId: vId,
        sourceBucket: 'free_chest_captain',
        sourceKind: 'CAPTAIN_FOUNDING',
        sourceRef: String(cb.team_id),
        amountRaw: amt,
        grantAtSec: Number(cb.created_at),
      });
    }

    // 3) Settled prediction win / first-loss bonuses settled inside window after last activation
    const predRes = await db
      .prepare(
        `SELECT b.round_id, b.status, b.reward_raw, pr.settled_at
         FROM prediction_bets b
         JOIN prediction_rounds pr ON pr.round_id = b.round_id
         WHERE b.user_id = ?
           AND b.status IN ('WON_PENDING_ACTIVATION', 'LOST_FIRST_BONUS')
           AND b.reward_raw != '0'
           AND pr.settled_at >= ? AND pr.settled_at <= ?
         ORDER BY pr.settled_at ASC`,
      )
      .bind(uid, minGrantSec, windowEndSec)
      .all();
    for (const pb of predRes?.results || []) {
      const isWin = String(pb.status) === 'WON_PENDING_ACTIVATION';
      const vId = `${isWin ? 'pred_win' : 'pred_fl'}:${pb.round_id}:${uid}`;
      if (existingIds.has(vId)) continue;
      const amt = BigInt(String(pb.reward_raw || '0'));
      if (amt <= 0n) continue;
      candidates.push({
        voucherId: vId,
        sourceBucket: 'prediction',
        sourceKind: isWin ? 'PREDICTION_WIN' : 'PREDICTION_FIRST_LOSS',
        sourceRef: `round:${pb.round_id}`,
        amountRaw: amt,
        grantAtSec: Number(pb.settled_at),
      });
    }

    let evidencedSum = 0n;
    for (const c of candidates) evidencedSum += c.amountRaw;

    if (candidates.length > 0 && evidencedSum === remainingNeed) {
      const stmts = candidates.map((c) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO pending_reward_vouchers
               (voucher_id, user_id, source_bucket, source_kind, source_ref, amount_raw, expires_at_ms, status, activation_id, legacy_backfilled, resolved_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, 1, NULL, ?, ?)`,
          )
          .bind(
            c.voucherId,
            uid,
            c.sourceBucket,
            c.sourceKind,
            c.sourceRef,
            c.amountRaw.toString(),
            expiresAtMs,
            c.grantAtSec,
            nowSec,
          ),
      );
      const out = await db.batch(stmts);
      const inserted = out.reduce((n, resItem) => n + changes(resItem), 0);
      if (inserted > 0) {
        backfilledUsers += 1;
        backfilledVouchers += inserted;
      }
    } else {
      const totalEvidenced = existingSum + evidencedSum;
      const diff = pendingRaw > totalEvidenced ? pendingRaw - totalEvidenced : totalEvidenced - pendingRaw;
      const itemId = `legacy_pending_unattributable:${uid}`;
      const ins = await db
        .prepare(
          `INSERT OR IGNORE INTO actuarial_reconciliation_items
             (item_id, category, entity_key, recorded_raw, evidenced_raw, unexplained_raw, detail_json, status, created_at, updated_at)
           VALUES (?, 'LEGACY_PENDING_UNATTRIBUTABLE', ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
        )
        .bind(
          itemId,
          uid,
          pendingRaw.toString(),
          totalEvidenced.toString(),
          diff.toString(),
          JSON.stringify({
            userId: uid,
            pendingExpiresAt: expiresAtMs,
            candidateCount: candidates.length,
            reason: 'source_amount_mismatch',
          }),
          nowSec,
          nowSec,
        )
        .run();
      if (changes(ins) === 1) reconciliationLogged += 1;
    }
  }

  return { scanned, alreadyCovered, backfilledUsers, backfilledVouchers, reconciliationLogged };
}
