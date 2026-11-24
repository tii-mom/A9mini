// A9 Protocol v15 — Warm-Up Leaderboard, Team / TG-Group Binding & First-Touch Referral Store.
// Backed by in-memory maps locally and schema.sql tables in D1 production.
import { addressKey, addressAliases } from './ton-address.mjs';

export const TEAM_SWITCH_COOLDOWN_SEC = 7 * 86400;

export const WARMUP_TIERS = Object.freeze([
  { minRank: 1, maxRank: 10, rewardA9: 400000 },
  { minRank: 11, maxRank: 25, rewardA9: 160000 },
  { minRank: 26, maxRank: 50, rewardA9: 64000 },
]);

export const WARMUP_INTENT_TIERS = Object.freeze(['1000', '5000', '20000_plus', 'watching']);
export const WARMUP_INTENT_A9_ESTIMATE = Object.freeze({ '1000': 1000, '5000': 5000, '20000_plus': 20000, watching: 0 });
export const DEFAULT_WARMUP_ROUND_CONFIG = Object.freeze({
  status: 'OPEN',
  plannedOpenAt: null,
  targetUsers: 500,
  chestBaseA9Raw: '300000000000',
  chestStepA9Raw: '200000000000',
  chestMinInvites: 2,
  chestMaxInvites: 5,
});

export function normalizeWarmupIntentTier(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim() === '') return null;
  const v = String(raw).trim();
  if (!WARMUP_INTENT_TIERS.includes(v)) {
    throw new SocialError('BAD_INTENT_TIER', `invalid intentTier: ${v}`);
  }
  return v;
}

export function maskWarmupUser(tgUserId, walletAddress = null) {
  if (walletAddress && String(walletAddress).length > 10) {
    const w = String(walletAddress);
    return `${w.slice(0, 4)}...${w.slice(-4)}`;
  }
  const uid = String(tgUserId || '');
  if (uid.length <= 4) return `TG#${uid}`;
  return `TG#${uid.slice(0, 2)}***${uid.slice(-3)}`;
}

export function rewardForWarmupRank(rank) {
  const tier = WARMUP_TIERS.find((t) => rank >= t.minRank && rank <= t.maxRank);
  return tier ? tier.rewardA9 : 0;
}

export class SocialError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 解析并规范化 Telegram Mini App startapp 归因深链参数（阶段六/阶段五要求）。
 * 仅接受 [A-Za-z0-9_-]{1,64}，拒绝任何注入或畸形参数。
 */
export function parseStartAppParam(rawParam) {
  const raw = String(rawParam || '').trim();
  if (!raw || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return null;

  // 1) invite_<teamId>_<referrerId> or invite_<referrerId>
  // 注意：TON base64url 友好地址或钱包标识本身可能含 '_'，因此仅当首段是明确商会 ID（G-* / T-* / TM-* / TEAM-*）时才拆出 teamId，其余完整保留为 referrerId。
  if (raw.startsWith('invite_')) {
    const rest = raw.slice('invite_'.length);
    if (!rest) return null;
    const teamMatch = rest.match(/^((?:G|T|TM|TEAM)-[A-Za-z0-9-]+)_(.+)$/i);
    if (teamMatch) {
      return {
        raw,
        kind: 'invite',
        teamId: teamMatch[1],
        targetId: teamMatch[1],
        referrerId: teamMatch[2],
      };
    }
    return { raw, kind: 'invite', teamId: null, targetId: null, referrerId: rest };
  }

  // 1b) warmup | warmup_<roundId> | warmup_<roundId>_<referrerId>
  if (/^warmup(?:_(.+))?$/i.test(raw)) {
    const rest = raw.slice('warmup'.length).replace(/^_/, '');
    if (!rest) return { raw, kind: 'warmup', teamId: null, targetId: null, referrerId: null };
    const wm = rest.match(/^(\d+)(?:_(.+))?$/);
    if (wm) {
      return { raw, kind: 'warmup', teamId: null, targetId: wm[1], referrerId: wm[2] || null };
    }
    return { raw, kind: 'warmup', teamId: null, targetId: null, referrerId: rest };
  }

  // 2) (round|burn|proof|bet|chest|gallery)_<targetId>[_<referrerId>]
  const chestM = raw.match(/^chest_(ch_[A-Za-z0-9]+)(?:_(.+))?$/i);
  if (chestM) {
    return {
      raw,
      kind: 'chest',
      teamId: null,
      targetId: chestM[1],
      referrerId: chestM[2] || null,
    };
  }
  const m = raw.match(/^(round|burn|proof|bet|chest|gallery)_([^_]+)(?:_(.+))?$/i);
  if (m) {
    const [, kind, targetId, referrerId] = m;
    return {
      raw,
      kind: kind.toLowerCase(),
      teamId: null,
      targetId: targetId || null,
      referrerId: referrerId || null,
    };
  }

  return null;
}

/**
 * 默认 Telegram Bot API 群权限核验器（当配置了 A9_BOT_TOKEN 且未注入自定义测试核验器时使用）。
 */
export function createTelegramBotGroupVerifier(botToken, fetchImpl = globalThis.fetch) {
  const token = String(botToken || '').trim();
  if (!token || typeof fetchImpl !== 'function') return null;
  // 保持 globalThis 作为默认 fetch 的 receiver，避免 Cloudflare workerd 抛出 Illegal invocation
  const doFetch = fetchImpl === globalThis.fetch ? (...args) => globalThis.fetch(...args) : fetchImpl;
  const baseUrl = `https://api.telegram.org/bot${token}`;
  let cachedBotId = null;

  return async function verifyWithTelegram({ tgGroupHandle, tgChatId, telegramUserId }) {
    const chatRef = tgChatId || tgGroupHandle;
    if (!chatRef) {
      return { botInGroup: false, operatorIsAdmin: false, chatId: null, reason: 'MISSING_CHAT_REF' };
    }
    if (!cachedBotId) {
      const meRes = await doFetch(`${baseUrl}/getMe`);
      const meJson = await meRes.json().catch(() => null);
      if (!meJson?.ok || !meJson?.result?.id) {
        return { botInGroup: false, operatorIsAdmin: false, chatId: null, reason: 'BOT_IDENTITY_UNAVAILABLE' };
      }
      cachedBotId = String(meJson.result.id);
    }
    const chatRes = await doFetch(`${baseUrl}/getChat?chat_id=${encodeURIComponent(chatRef)}`);
    const chatJson = await chatRes.json().catch(() => null);
    if (!chatJson?.ok || !chatJson?.result?.id) {
      return { botInGroup: false, operatorIsAdmin: false, chatId: null, reason: 'CHAT_NOT_ACCESSIBLE' };
    }
    const chat = chatJson.result;
    if (chat.type !== 'group' && chat.type !== 'supergroup') {
      return { botInGroup: false, operatorIsAdmin: false, chatId: null, reason: 'NOT_A_GROUP' };
    }
    const canonicalChatId = String(chat.id);
    const canonicalHandle = chat.username ? `@${chat.username}` : (tgGroupHandle || null);

    // 核验 Bot 自身已真实入群且未被踢出或禁言（防公开超级群未拉 Bot 套领 5,000 A9）
    const botMemRes = await doFetch(
      `${baseUrl}/getChatMember?chat_id=${encodeURIComponent(canonicalChatId)}&user_id=${encodeURIComponent(cachedBotId)}`,
    );
    const botMemJson = await botMemRes.json().catch(() => null);
    const botStatus = botMemJson?.ok ? String(botMemJson?.result?.status || '') : '';
    const botCanSend = botStatus === 'administrator' || botStatus === 'creator' || botStatus === 'member'
      || (botStatus === 'restricted' && botMemJson?.result?.is_member === true && botMemJson?.result?.can_send_messages !== false);
    if (!botCanSend) {
      return { botInGroup: false, operatorIsAdmin: false, chatId: canonicalChatId, groupHandle: canonicalHandle, reason: 'BOT_NOT_IN_GROUP' };
    }

    // 核验操作者在目标群内的管理员权限
    const memRes = await doFetch(
      `${baseUrl}/getChatMember?chat_id=${encodeURIComponent(canonicalChatId)}&user_id=${encodeURIComponent(String(telegramUserId))}`,
    );
    const memJson = await memRes.json().catch(() => null);
    if (!memJson?.ok || !memJson?.result?.status) {
      return { botInGroup: false, operatorIsAdmin: false, chatId: canonicalChatId, groupHandle: canonicalHandle, reason: 'MEMBER_CHECK_FAILED' };
    }
    const status = memJson.result.status;
    const operatorIsAdmin = status === 'creator' || status === 'administrator';
    let tgMemberCount = 0;
    try {
      const cntRes = await doFetch(`${baseUrl}/getChatMemberCount?chat_id=${encodeURIComponent(canonicalChatId)}`);
      const cntJson = await cntRes.json().catch(() => null);
      if (cntJson?.ok && Number.isFinite(Number(cntJson.result))) {
        tgMemberCount = Number(cntJson.result);
      }
    } catch {
      tgMemberCount = 0;
    }
    return {
      botInGroup: true,
      operatorIsAdmin,
      chatId: canonicalChatId,
      groupHandle: canonicalHandle,
      tgMemberCount,
      reason: operatorIsAdmin ? 'OK' : 'NOT_GROUP_ADMIN',
    };
  };
}

export class SocialStore {
  constructor() {
    // key: `${roundId}:${wallet}` -> { roundId, walletAddress, referrerWallet, validInvites, status, updatedAt }
    this.warmups = new Map();
    // v2 pre-round reservations: key `${roundId}:${tgUserId}`
    this.warmupRounds = new Map();
    this.warmupReservations = new Map();
    // teamId -> { teamId, name, captainWallet, tgGroupHandle, tgChatId, bindStatus, members: Set, memberJoinedAt: Map }
    this.teams = new Map();
    this.memberTeam = new Map(); // wallet -> teamId
    this.memberJoinedAt = new Map(); // walletKey -> joinedAtSec
    // subjectKey (walletAddress or tgUserId) -> { subjectKey, referrerId, boundAt }
    this.referrals = new Map();
    // tgUserId -> { tgUserId, settlementPush: boolean, updatedAt: number }
    this.notificationPrefs = new Map();
  }

  /**
   * First-Touch referral attribution binding.
   * - Immutable once bound (never overwritten).
   * - Rejects self-referral (subjectKey === referrerId).
   * - Rejects mutual / cyclic referral chains (e.g. A -> B then B -> A).
   */
  bindReferral(subjectKey, referrerId, nowSec = Math.floor(Date.now() / 1000), { aliases = [] } = {}) {
    const subj = String(subjectKey || '').trim();
    const ref = String(referrerId || '').trim();
    if (!subj || !ref) return null;

    const allSubjects = [subj, ...aliases.map((a) => String(a || '').trim()).filter(Boolean)];
    const refKey = addressKey(ref);
    for (const s of allSubjects) {
      if (s === ref || addressKey(s) === refKey) return null;
    }

    // 若本人或任一关联标识（如 TG ID 与绑定钱包）已有首次归因，保持首次归因不变
    for (const s of allSubjects) {
      const existing = this.referrals.get(s);
      if (existing) {
        if (!this.referrals.has(subj)) {
          this.referrals.set(subj, { subjectKey: subj, referrerId: existing.referrerId, boundAt: existing.boundAt });
        }
        return this.referrals.get(subj);
      }
    }

    // Anti-cycle walk: ensure `subj` (or any alias) is not already an ancestor of `ref`
    const subjectKeys = new Set(allSubjects.map((s) => addressKey(s)));
    let cursor = ref;
    for (let depth = 0; depth < 8 && cursor; depth += 1) {
      const parent = this.referrals.get(cursor)?.referrerId || null;
      if (!parent) break;
      if (allSubjects.includes(parent) || subjectKeys.has(addressKey(parent))) return null;
      cursor = parent;
    }

    const rec = { subjectKey: subj, referrerId: ref, boundAt: nowSec };
    for (const s of allSubjects) {
      if (!this.referrals.has(s)) {
        this.referrals.set(s, { subjectKey: s, referrerId: ref, boundAt: nowSec });
      }
    }
    return rec;
  }

  getReferrer(subjectKey) {
    const subj = String(subjectKey || '').trim();
    if (!subj) return null;
    const direct = this.referrals.get(subj);
    if (direct) return direct.referrerId;
    for (const alias of addressAliases(subj)) {
      const hit = this.referrals.get(alias);
      if (hit) return hit.referrerId;
    }
    const key = addressKey(subj);
    if (key && key !== subj) {
      const hit = this.referrals.get(key);
      if (hit) return hit.referrerId;
    }
    return null;
  }

  listDirectReferees(referrerKeys = []) {
    const keySet = new Set();
    for (const k of referrerKeys || []) {
      const clean = String(k || '').trim();
      if (!clean) continue;
      keySet.add(clean);
      keySet.add(addressKey(clean));
    }
    if (!keySet.size) return [];
    const out = new Set();
    for (const [subj, rec] of this.referrals.entries()) {
      if (keySet.has(rec.referrerId) || keySet.has(addressKey(rec.referrerId))) {
        out.add(subj);
      }
    }
    return Array.from(out);
  }

  registerWarmup(
    { roundId = 1, walletAddress, referrerWallet = null, referrerId = null, aliases = [] },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    if (!walletAddress) throw new Error('walletAddress required');
    const rawRef = String(referrerId || referrerWallet || '').trim() || null;
    if (rawRef) {
      this.bindReferral(walletAddress, rawRef, nowSec, { aliases });
    }
    let effectiveRef = this.getReferrer(walletAddress);
    if (!effectiveRef && Array.isArray(aliases)) {
      for (const a of aliases) {
        effectiveRef = this.getReferrer(a);
        if (effectiveRef) break;
      }
    }

    const key = `${roundId}:${walletAddress}`;
    const existing = this.warmups.get(key);
    if (existing && existing.status === 'ACTIVE') return existing;

    const isFirstSignup = !existing;
    const rec = {
      roundId: Number(roundId),
      walletAddress,
      referrerWallet: effectiveRef && addressKey(effectiveRef) !== addressKey(walletAddress) ? effectiveRef : null,
      validInvites: existing?.validInvites || 0,
      status: 'ACTIVE',
      createdAt: existing?.createdAt || nowSec,
      updatedAt: nowSec,
    };
    this.warmups.set(key, rec);

    // 仅在首次报名时计入推荐人有效邀请，防止反复 cancel -> register 刷榜
    if (isFirstSignup && rec.referrerWallet) {
      const refKey = `${roundId}:${rec.referrerWallet}`;
      const ref = this.warmups.get(refKey);
      if (ref && ref.status === 'ACTIVE') {
        ref.validInvites += 1;
        ref.updatedAt = nowSec;
      }
    }
    return rec;
  }

  cancelWarmup({ roundId = 1, walletAddress }, nowSec = Math.floor(Date.now() / 1000)) {
    const key = `${roundId}:${walletAddress}`;
    const rec = this.warmups.get(key);
    if (!rec) return null;
    rec.status = 'CANCELLED';
    rec.updatedAt = nowSec;
    return rec;
  }

  getWarmupLeaderboard(roundId = 1, limit = 50) {
    const active = Array.from(this.warmups.values())
      .filter((r) => r.roundId === Number(roundId) && r.status === 'ACTIVE')
      .sort((a, b) => (b.validInvites - a.validInvites) || (a.createdAt - b.createdAt))
      .slice(0, limit);

    return active.map((r, i) => ({
      rank: i + 1,
      walletAddress: r.walletAddress,
      validInvites: r.validInvites,
      estRewardA9: rewardForWarmupRank(i + 1),
    }));
  }

  createOrBindTeamGroup({ teamId, name, captainWallet, tgGroupHandle, tgChatId = null }, nowSec = Math.floor(Date.now() / 1000)) {
    if (!teamId || !captainWallet) throw new SocialError('BAD_REQUEST', 'teamId and captainWallet required');
    const cur = this.teams.get(teamId) || {
      teamId,
      name: name || teamId,
      captainWallet,
      tgGroupHandle: null,
      tgChatId: null,
      bindStatus: 'unbound',
      members: new Set([captainWallet]),
      memberJoinedAt: new Map([[addressKey(captainWallet), nowSec]]),
      createdAt: nowSec,
      updatedAt: nowSec,
    };
    if (addressKey(cur.captainWallet) !== addressKey(captainWallet)) {
      throw new SocialError('NOT_CAPTAIN', 'only captain can bind TG group');
    }
    if (name) cur.name = name;
    if (tgGroupHandle) {
      cur.tgGroupHandle = tgGroupHandle;
      cur.tgChatId = tgChatId;
      // 仅输入 @群名 绝不标记为已绑定，必须经 verifyTeamGroupBinding 核验机器人与管理员权限后才转为 bound
      cur.bindStatus = 'verifying';
    }
    cur.updatedAt = nowSec;
    this.teams.set(teamId, cur);
    this.memberTeam.set(captainWallet, teamId);
    if (!this.memberJoinedAt.has(addressKey(captainWallet))) {
      this.memberJoinedAt.set(addressKey(captainWallet), nowSec);
    }
    return this.formatTeam(cur);
  }

  /**
   * 阶段五：核验机器人入群状态、操作者群管理员权限及防同名群冲突。
   * - 若原先已绑定但机器人被移出或操作者失去群管理员权限，状态自动降级为 'expired'。
   * - 若目标群（按真实 tgChatId 唯一标识）已被其他商会绑定，拒绝绑定（GROUP_ALREADY_BOUND）。
   */
  async verifyTeamGroupBinding(
    { teamId, captainWallet, telegramUserId, telegramVerifier },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    if (!teamId || !captainWallet) throw new SocialError('BAD_REQUEST', 'teamId and captainWallet required');
    const cur = this.teams.get(teamId);
    if (!cur) throw new SocialError('TEAM_NOT_FOUND', `team ${teamId} not found`);
    if (addressKey(cur.captainWallet) !== addressKey(captainWallet)) {
      throw new SocialError('NOT_CAPTAIN', 'only captain can verify TG group binding');
    }
    if (!cur.tgGroupHandle && !cur.tgChatId) {
      throw new SocialError('BAD_REQUEST', 'no Telegram group handle submitted for verification');
    }
    if (typeof telegramVerifier !== 'function') {
      return this.formatTeam(cur);
    }

    const check = await telegramVerifier({
      teamId,
      tgGroupHandle: cur.tgGroupHandle,
      tgChatId: cur.tgChatId,
      telegramUserId,
    });

    if (!check?.botInGroup || !check?.chatId) {
      cur.bindStatus = cur.bindStatus === 'bound' ? 'expired' : 'verifying';
      cur.updatedAt = nowSec;
      throw new SocialError('BOT_NOT_IN_GROUP', '机器人尚未加入该群组或无访问权限');
    }

    const canonicalChatId = String(check.chatId);
    // 防同名群或群 ID 冒用：同一真实 tgChatId 不能被两个战队同时绑定
    for (const other of this.teams.values()) {
      if (other.teamId !== teamId && other.tgChatId === canonicalChatId && other.bindStatus === 'bound') {
        throw new SocialError('GROUP_ALREADY_BOUND', '该 Telegram 群组已被其他战队绑定');
      }
    }

    if (!check.operatorIsAdmin) {
      if (cur.bindStatus === 'bound') {
        cur.bindStatus = 'expired';
        cur.updatedAt = nowSec;
      }
      throw new SocialError('NOT_GROUP_ADMIN', '操作者不是该 Telegram 群组的管理员');
    }

    cur.tgChatId = canonicalChatId;
    if (check.groupHandle) cur.tgGroupHandle = String(check.groupHandle);
    if (Number.isFinite(Number(check.tgMemberCount))) cur.tgMemberCount = Number(check.tgMemberCount);
    cur.bindStatus = 'bound';
    cur.updatedAt = nowSec;
    return this.formatTeam(cur);
  }

  joinTeam({ teamId, walletAddress, referrerId = null, aliases = [] }, nowSec = Math.floor(Date.now() / 1000)) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team ${teamId} not found`);
    const wKey = addressKey(walletAddress);
    let prevTeamId = this.memberTeam.get(walletAddress);
    if (!prevTeamId) {
      for (const alias of addressAliases(walletAddress)) {
        prevTeamId = this.memberTeam.get(alias);
        if (prevTeamId) break;
      }
    }
    if (prevTeamId && prevTeamId !== teamId) {
      const prevJoinedAt = Number(this.memberJoinedAt.get(wKey) || 0);
      if (prevJoinedAt > 0 && nowSec < prevJoinedAt + TEAM_SWITCH_COOLDOWN_SEC) {
        throw new SocialError('TEAM_SWITCH_COOLDOWN', '更换战队需间隔 7 天冷却期');
      }
    }
    if (referrerId) {
      this.bindReferral(walletAddress, referrerId, nowSec, { aliases });
    }
    if (prevTeamId && prevTeamId !== teamId) {
      const prevTeam = this.teams.get(prevTeamId);
      if (prevTeam) {
        for (const m of Array.from(prevTeam.members)) {
          if (addressKey(m) === wKey) prevTeam.members.delete(m);
        }
        prevTeam.memberJoinedAt?.delete(wKey);
        prevTeam.updatedAt = nowSec;
      }
    }
    team.members.add(walletAddress);
    if (!team.memberJoinedAt) team.memberJoinedAt = new Map();
    if (prevTeamId !== teamId || !team.memberJoinedAt.has(wKey)) {
      team.memberJoinedAt.set(wKey, nowSec);
      this.memberJoinedAt.set(wKey, nowSec);
    }
    team.updatedAt = nowSec;
    this.memberTeam.set(walletAddress, teamId);
    return this.formatTeam(team);
  }

  getTeamByWallet(walletAddress) {
    let teamId = this.memberTeam.get(walletAddress);
    if (!teamId) {
      for (const alias of addressAliases(walletAddress)) {
        teamId = this.memberTeam.get(alias);
        if (teamId) break;
      }
    }
    if (!teamId) return null;
    const team = this.teams.get(teamId);
    return team ? this.formatTeam(team) : null;
  }

  /** 返回全部已通过四重真实核验（bindStatus === 'bound' 且具备真实 tgChatId）的战队群。 */
  listBoundTeams() {
    const out = [];
    for (const t of this.teams.values()) {
      if (t.bindStatus === 'bound' && t.tgChatId) {
        out.push(this.formatTeam(t));
      }
    }
    return out;
  }

  listTeamMemberWallets(teamId) {
    const t = this.teams.get(teamId);
    return t ? Array.from(t.members) : [];
  }

  listTeamMembersWithJoinTime(teamId) {
    const t = this.teams.get(teamId);
    if (!t) return [];
    return Array.from(t.members).map((walletAddress) => ({
      walletAddress,
      joinedAt: Number(t.memberJoinedAt?.get(addressKey(walletAddress)) ?? t.createdAt ?? 0),
    }));
  }

  formatTeam(t) {
    return {
      teamId: t.teamId,
      name: t.name,
      captainWallet: t.captainWallet,
      tgGroupHandle: t.tgGroupHandle,
      tgChatId: t.tgChatId,
      bindStatus: t.bindStatus,
      memberCount: t.members.size,
      tgMemberCount: Number(t.tgMemberCount || 0),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Warm-Up v2: Pre-Round Reservations, Intent Tiers & Viral Chest Linkage
  // -------------------------------------------------------------------------
  getWarmupRoundConfig(roundId) {
    const rId = Number(roundId || 1);
    const saved = this.warmupRounds.get(rId);
    return {
      roundId: rId,
      ...DEFAULT_WARMUP_ROUND_CONFIG,
      ...(saved || {}),
    };
  }

  upsertWarmupRoundConfig(
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
    const cur = this.getWarmupRoundConfig(rId);
    const nextStatus = status !== undefined ? String(status).trim().toUpperCase() : cur.status;
    if (!['OPEN', 'PAUSED', 'CLOSED'].includes(nextStatus)) throw new SocialError('BAD_REQUEST', 'invalid warmup round status');
    const nextTarget = targetUsers !== undefined ? Math.max(1, Number(targetUsers)) : cur.targetUsers;
    const nextMin = chestMinInvites !== undefined ? Math.max(1, Number(chestMinInvites)) : cur.chestMinInvites;
    const nextMax = chestMaxInvites !== undefined ? Math.max(nextMin, Number(chestMaxInvites)) : Math.max(nextMin, cur.chestMaxInvites);
    const next = {
      roundId: rId,
      status: nextStatus,
      plannedOpenAt: plannedOpenAt === undefined ? cur.plannedOpenAt : (plannedOpenAt === null ? null : Number(plannedOpenAt)),
      targetUsers: Number.isFinite(nextTarget) ? nextTarget : DEFAULT_WARMUP_ROUND_CONFIG.targetUsers,
      chestBaseA9Raw: chestBaseA9Raw !== undefined ? String(BigInt(String(chestBaseA9Raw))) : cur.chestBaseA9Raw,
      chestStepA9Raw: chestStepA9Raw !== undefined ? String(BigInt(String(chestStepA9Raw))) : cur.chestStepA9Raw,
      chestMinInvites: nextMin,
      chestMaxInvites: nextMax,
      createdAt: cur.createdAt || nowSec,
      updatedAt: nowSec,
    };
    this.warmupRounds.set(rId, next);
    return next;
  }

  _recomputeReferrerInvites(roundId, refId, nowSec) {
    const rId = Number(roundId);
    const refRec = this._findActiveReservationByRef(rId, refId);
    if (!refRec) return null;
    const candidates = new Set([refRec.tgUserId, refRec.walletAddress, refRec.walletKey].filter(Boolean));
    let rawInvites = 0;
    let validInvites = 0;
    for (const r of this.warmupReservations.values()) {
      if (r.roundId !== rId || r.status !== 'ACTIVE' || r.tgUserId === refRec.tgUserId) continue;
      if (!r.referrerTgId || !candidates.has(r.referrerTgId)) continue;
      rawInvites += 1;
      if (r.walletKey && r.walletActive) validInvites += 1;
    }
    refRec.rawInvites = rawInvites;
    refRec.validInvites = validInvites;
    refRec.updatedAt = nowSec;
    return { tgUserId: refRec.tgUserId, rawInvites, validInvites };
  }

  reserveWarmup(
    { roundId = 1, tgUserId, walletAddress = null, walletActive = false, referrerId = null, intentTier = undefined, remindEnabled = undefined },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    const rId = Number(roundId);
    const uid = String(tgUserId || '').trim();
    if (!uid || !Number.isInteger(rId) || rId < 1) throw new SocialError('BAD_REQUEST', 'valid roundId and tgUserId required');
    const cfg = this.getWarmupRoundConfig(rId);
    if (cfg.status !== 'OPEN') throw new SocialError('WARMUP_CLOSED', '本轮预热预约当前未开放');

    const normIntent = normalizeWarmupIntentTier(intentTier);
    const cleanWallet = walletAddress ? String(walletAddress).trim() : null;
    const wKey = cleanWallet ? addressKey(cleanWallet) : null;
    if (wKey) {
      for (const other of this.warmupReservations.values()) {
        if (other.roundId === rId && other.walletKey === wKey && other.tgUserId !== uid) {
          throw new SocialError('WALLET_ALREADY_RESERVED', '该 TON 钱包已在本轮完成预热预约');
        }
      }
    }

    const rawRef = String(referrerId || '').trim() || null;
    if (rawRef && rawRef !== uid) {
      this.bindReferral(uid, rawRef, nowSec, { aliases: cleanWallet ? [cleanWallet] : [] });
    }
    const storedRef = this.getReferrer(uid) || (cleanWallet ? this.getReferrer(cleanWallet) : null) || rawRef;
    const effectiveRef = storedRef && storedRef !== uid && (!wKey || addressKey(storedRef) !== wKey) ? storedRef : null;

    const key = `${rId}:${uid}`;
    const existing = this.warmupReservations.get(key);
    const isNewSignup = !existing;
    const rec = existing || {
      roundId: rId,
      tgUserId: uid,
      walletAddress: null,
      walletKey: null,
      walletActive: false,
      referrerTgId: effectiveRef,
      intentTier: null,
      remindEnabled: true,
      remindedAt: null,
      rawInvites: 0,
      validInvites: 0,
      status: 'ACTIVE',
      createdAt: nowSec,
      updatedAt: nowSec,
    };

    rec.status = 'ACTIVE';
    if (cleanWallet) {
      rec.walletAddress = cleanWallet;
      rec.walletKey = wKey;
      rec.walletActive = Boolean(rec.walletActive || walletActive);
    }
    if (!rec.referrerTgId && effectiveRef) rec.referrerTgId = effectiveRef;
    if (normIntent !== undefined) rec.intentTier = normIntent;
    if (remindEnabled !== undefined) rec.remindEnabled = Boolean(remindEnabled);
    rec.updatedAt = nowSec;
    this.warmupReservations.set(key, rec);

    this._recomputeReferrerInvites(rId, uid, nowSec);
    let referrerUpdated = null;
    if (rec.referrerTgId) {
      const updated = this._recomputeReferrerInvites(rId, rec.referrerTgId, nowSec);
      if (updated && updated.tgUserId !== uid) referrerUpdated = updated;
    }

    return { reservation: this._formatReservation(rec), referrerUpdated, isNewSignup };
  }

  _findActiveReservationByRef(roundId, refId) {
    const rId = Number(roundId);
    const clean = String(refId || '').trim();
    if (!clean) return null;
    const direct = this.warmupReservations.get(`${rId}:${clean}`);
    if (direct && direct.status === 'ACTIVE') return direct;
    const refKey = addressKey(clean);
    for (const r of this.warmupReservations.values()) {
      if (r.roundId === rId && r.status === 'ACTIVE' && r.walletKey && r.walletKey === refKey) return r;
    }
    return null;
  }

  syncWarmupWalletForUser({ tgUserId, walletAddress, walletActive = false, roundIds = null }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(tgUserId || '').trim();
    const cleanWallet = String(walletAddress || '').trim();
    if (!uid || !cleanWallet) return [];
    const wKey = addressKey(cleanWallet);
    const allowed = Array.isArray(roundIds) ? new Set(roundIds.map(Number)) : null;
    const updates = [];

    for (const rec of this.warmupReservations.values()) {
      if (rec.tgUserId !== uid || rec.status !== 'ACTIVE') continue;
      if (allowed && !allowed.has(rec.roundId)) continue;
      let conflict = false;
      for (const other of this.warmupReservations.values()) {
        if (other.roundId === rec.roundId && other.walletKey === wKey && other.tgUserId !== uid) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;
      rec.walletAddress = cleanWallet;
      rec.walletKey = wKey;
      rec.walletActive = Boolean(rec.walletActive || walletActive);
      rec.updatedAt = nowSec;
      let referrerUpdated = null;
      if (rec.referrerTgId) {
        const updated = this._recomputeReferrerInvites(rec.roundId, rec.referrerTgId, nowSec);
        if (updated && updated.tgUserId !== uid) referrerUpdated = updated;
      }
      updates.push({ roundId: rec.roundId, reservation: this._formatReservation(rec), referrerUpdated });
    }
    return updates;
  }

  cancelWarmupReservation({ roundId = 1, tgUserId }, nowSec = Math.floor(Date.now() / 1000)) {
    const rId = Number(roundId);
    const uid = String(tgUserId || '').trim();
    const rec = this.warmupReservations.get(`${rId}:${uid}`);
    if (!rec) return null;
    rec.status = 'CANCELLED';
    rec.updatedAt = nowSec;
    let referrerUpdated = null;
    if (rec.referrerTgId) {
      const updated = this._recomputeReferrerInvites(rId, rec.referrerTgId, nowSec);
      if (updated && updated.tgUserId !== uid) referrerUpdated = updated;
    }
    return { ...this._formatReservation(rec), referrerUpdated };
  }

  getWarmupReservation(roundId, tgUserId) {
    const rec = this.warmupReservations.get(`${Number(roundId)}:${String(tgUserId || '').trim()}`);
    return rec ? this._formatReservation(rec) : null;
  }

  getWarmupRoundStats(roundId) {
    const rId = Number(roundId);
    let totalRegistered = 0;
    let walletBoundCount = 0;
    let activeWalletCount = 0;
    let remindEnabledCount = 0;
    for (const r of this.warmupReservations.values()) {
      if (r.roundId !== rId || r.status !== 'ACTIVE') continue;
      totalRegistered += 1;
      if (r.walletKey) walletBoundCount += 1;
      if (r.walletActive) activeWalletCount += 1;
      if (r.remindEnabled) remindEnabledCount += 1;
    }
    return { roundId: rId, totalRegistered, walletBoundCount, activeWalletCount, remindEnabledCount };
  }

  getWarmupLeaderboardV2(roundId = 1, limit = 50) {
    const rId = Number(roundId);
    return Array.from(this.warmupReservations.values())
      .filter((r) => r.roundId === rId && r.status === 'ACTIVE')
      .sort((a, b) => (b.validInvites - a.validInvites) || (b.rawInvites - a.rawInvites) || (a.createdAt - b.createdAt))
      .slice(0, limit)
      .map((r, i) => ({
        rank: i + 1,
        label: maskWarmupUser(r.tgUserId, r.walletAddress),
        walletAddress: maskWarmupUser(r.tgUserId, r.walletAddress),
        validInvites: r.validInvites,
        rawInvites: r.rawInvites,
        walletBound: Boolean(r.walletKey),
      }));
  }

  getWarmupAdminSummary(roundId, { readyWalletSet = null, actualOnchainStakers = null } = {}) {
    const rId = Number(roundId);
    const config = this.getWarmupRoundConfig(rId);
    const intentBreakdown = { '1000': 0, '5000': 0, '20000_plus': 0, watching: 0, unset: 0 };
    let totalActive = 0;
    let totalCancelled = 0;
    let walletBoundCount = 0;
    let activeWalletCount = 0;
    let remindEnabledCount = 0;
    let remindedCount = 0;
    let readyCapitalCount = 0;
    let estimatedIntentA9Min = 0;
    const activeRows = [];

    for (const r of this.warmupReservations.values()) {
      if (r.roundId !== rId) continue;
      if (r.status !== 'ACTIVE') {
        totalCancelled += 1;
        continue;
      }
      totalActive += 1;
      activeRows.push(r);
      if (r.walletKey) walletBoundCount += 1;
      if (r.walletActive) activeWalletCount += 1;
      if (r.remindEnabled) remindEnabledCount += 1;
      if (r.remindedAt) remindedCount += 1;
      if (readyWalletSet && r.walletKey && readyWalletSet.has(r.walletKey)) readyCapitalCount += 1;
      if (r.intentTier && Object.prototype.hasOwnProperty.call(intentBreakdown, r.intentTier)) {
        intentBreakdown[r.intentTier] += 1;
        estimatedIntentA9Min += WARMUP_INTENT_A9_ESTIMATE[r.intentTier] || 0;
      } else {
        intentBreakdown.unset += 1;
      }
    }
    const topInviters = activeRows
      .filter((r) => r.rawInvites > 0 || r.validInvites > 0)
      .sort((a, b) => (b.validInvites - a.validInvites) || (b.rawInvites - a.rawInvites) || (a.createdAt - b.createdAt))
      .slice(0, 20)
      .map((r, i) => ({
        rank: i + 1,
        tgUserId: r.tgUserId,
        walletAddress: r.walletAddress,
        validInvites: r.validInvites,
        rawInvites: r.rawInvites,
        intentTier: r.intentTier,
      }));
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

  listPendingWarmupReminders(roundId, limit = 25) {
    const rId = Number(roundId);
    return Array.from(this.warmupReservations.values())
      .filter((r) => r.roundId === rId && r.status === 'ACTIVE' && r.remindEnabled && !r.remindedAt)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map((r) => this._formatReservation(r));
  }

  markWarmupReminded(roundId, tgUserId, nowSec = Math.floor(Date.now() / 1000)) {
    const rec = this.warmupReservations.get(`${Number(roundId)}:${String(tgUserId || '').trim()}`);
    if (!rec || rec.remindedAt) return false;
    rec.remindedAt = nowSec;
    rec.updatedAt = nowSec;
    return true;
  }

  getNotificationPrefs(tgUserId) {
    const uid = String(tgUserId || '').trim();
    if (!uid) throw new SocialError('BAD_REQUEST', 'tgUserId required');
    const rec = this.notificationPrefs.get(uid);
    return {
      tgUserId: uid,
      settlementPush: rec ? Boolean(rec.settlementPush) : true,
      hourlyCandlePush: false,
      subscribedExplicitly: Boolean(rec),
      updatedAt: rec ? Number(rec.updatedAt) : null,
    };
  }

  setNotificationPrefs(tgUserId, { settlementPush }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(tgUserId || '').trim();
    if (!uid) throw new SocialError('BAD_REQUEST', 'tgUserId required');
    const next = Boolean(settlementPush);
    this.notificationPrefs.set(uid, {
      tgUserId: uid,
      settlementPush: next,
      updatedAt: Number(nowSec),
    });
    return {
      tgUserId: uid,
      settlementPush: next,
      hourlyCandlePush: false,
      subscribedExplicitly: true,
      updatedAt: Number(nowSec),
    };
  }

  ensureDefaultNotificationPrefs(tgUserId, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(tgUserId || '').trim();
    if (!uid) throw new SocialError('BAD_REQUEST', 'tgUserId required');
    if (!this.notificationPrefs.has(uid)) {
      this.notificationPrefs.set(uid, {
        tgUserId: uid,
        settlementPush: true,
        updatedAt: Number(nowSec),
      });
    }
    return this.getNotificationPrefs(uid);
  }

  disableSettlementPush(tgUserId, nowSec = Math.floor(Date.now() / 1000)) {
    return this.setNotificationPrefs(tgUserId, { settlementPush: false }, nowSec);
  }

  listSettlementPushSubscribers({ limit = 25, maxUpdatedAt = null } = {}) {
    const lim = Math.max(1, Math.min(10000, Math.floor(Number(limit) || 25)));
    const cutoff = maxUpdatedAt !== null && maxUpdatedAt !== undefined && Number(maxUpdatedAt) > 0
      ? Number(maxUpdatedAt)
      : null;
    return Array.from(this.notificationPrefs.values())
      .filter((r) => Boolean(r.settlementPush) && (cutoff === null || Number(r.updatedAt || 0) <= cutoff))
      .sort((a, b) => (a.updatedAt - b.updatedAt) || String(a.tgUserId).localeCompare(String(b.tgUserId)))
      .slice(0, lim)
      .map((r) => String(r.tgUserId));
  }

  _formatReservation(r) {
    return {
      roundId: Number(r.roundId),
      tgUserId: String(r.tgUserId),
      walletAddress: r.walletAddress || null,
      walletKey: r.walletKey || null,
      walletActive: Boolean(r.walletActive),
      referrerTgId: r.referrerTgId || null,
      intentTier: r.intentTier || null,
      remindEnabled: Boolean(r.remindEnabled),
      remindedAt: r.remindedAt ? Number(r.remindedAt) : null,
      rawInvites: Number(r.rawInvites || 0),
      validInvites: Number(r.validInvites || 0),
      status: r.status,
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
    };
  }
}
