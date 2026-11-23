// A9 Protocol v15 — Warm-Up Leaderboard, Team / TG-Group Binding & First-Touch Referral Store.
// Backed by in-memory maps locally and schema.sql tables in D1 production.
import { addressKey } from './ton-address.mjs';

export const WARMUP_TIERS = Object.freeze([
  { minRank: 1, maxRank: 10, rewardA9: 400000 },
  { minRank: 11, maxRank: 25, rewardA9: 160000 },
  { minRank: 26, maxRank: 50, rewardA9: 64000 },
]);

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

  // 2) (round|burn|proof|bet|chest)_<targetId>[_<referrerId>]
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
  const m = raw.match(/^(round|burn|proof|bet|chest)_([^_]+)(?:_(.+))?$/i);
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

  return async function verifyWithTelegram({ tgGroupHandle, tgChatId, telegramUserId }) {
    const chatRef = tgChatId || tgGroupHandle;
    if (!chatRef) {
      return { botInGroup: false, operatorIsAdmin: false, chatId: null, reason: 'MISSING_CHAT_REF' };
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
    // teamId -> { teamId, name, captainWallet, tgGroupHandle, tgChatId, bindStatus, members: Set }
    this.teams = new Map();
    this.memberTeam = new Map(); // wallet -> teamId
    // subjectKey (walletAddress or tgUserId) -> { subjectKey, referrerId, boundAt }
    this.referrals = new Map();
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
    return this.referrals.get(subj)?.referrerId || null;
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
    { roundId = 1, walletAddress, referrerWallet = null, referrerId = null },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    if (!walletAddress) throw new Error('walletAddress required');
    const rawRef = String(referrerId || referrerWallet || '').trim() || null;
    if (rawRef) {
      this.bindReferral(walletAddress, rawRef, nowSec);
    }
    const effectiveRef = this.getReferrer(walletAddress);

    const key = `${roundId}:${walletAddress}`;
    const existing = this.warmups.get(key);
    if (existing && existing.status === 'ACTIVE') return existing;

    const rec = {
      roundId: Number(roundId),
      walletAddress,
      referrerWallet: effectiveRef && effectiveRef !== walletAddress ? effectiveRef : null,
      validInvites: existing?.validInvites || 0,
      status: 'ACTIVE',
      createdAt: existing?.createdAt || nowSec,
      updatedAt: nowSec,
    };
    this.warmups.set(key, rec);

    // Credit valid invite to referrer if registered in the same round
    if (rec.referrerWallet) {
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

  joinTeam({ teamId, walletAddress, referrerId = null }, nowSec = Math.floor(Date.now() / 1000)) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team ${teamId} not found`);
    if (referrerId) {
      this.bindReferral(walletAddress, referrerId, nowSec);
    }
    team.members.add(walletAddress);
    team.updatedAt = nowSec;
    this.memberTeam.set(walletAddress, teamId);
    return this.formatTeam(team);
  }

  getTeamByWallet(walletAddress) {
    const teamId = this.memberTeam.get(walletAddress);
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
}
