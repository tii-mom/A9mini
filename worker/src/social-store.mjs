// A9 Protocol v15 — Warm-Up Leaderboard, Team / TG-Group Binding & First-Touch Referral Store.
// Backed by in-memory maps locally and schema.sql tables in D1 production.

export const WARMUP_TIERS = Object.freeze([
  { minRank: 1, maxRank: 10, rewardA9: 400000 },
  { minRank: 11, maxRank: 25, rewardA9: 160000 },
  { minRank: 26, maxRank: 50, rewardA9: 64000 },
]);

export function rewardForWarmupRank(rank) {
  const tier = WARMUP_TIERS.find((t) => rank >= t.minRank && rank <= t.maxRank);
  return tier ? tier.rewardA9 : 0;
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
  bindReferral(subjectKey, referrerId, nowSec = Math.floor(Date.now() / 1000)) {
    const subj = String(subjectKey || '').trim();
    const ref = String(referrerId || '').trim();
    if (!subj || !ref || subj === ref) return null;

    const existing = this.referrals.get(subj);
    if (existing) return existing;

    // Anti-cycle walk: ensure `subj` is not already an ancestor of `ref`
    let cursor = ref;
    for (let depth = 0; depth < 8 && cursor; depth += 1) {
      const parent = this.referrals.get(cursor)?.referrerId || null;
      if (!parent) break;
      if (parent === subj) return null;
      cursor = parent;
    }

    const rec = { subjectKey: subj, referrerId: ref, boundAt: nowSec };
    this.referrals.set(subj, rec);
    return rec;
  }

  getReferrer(subjectKey) {
    const subj = String(subjectKey || '').trim();
    if (!subj) return null;
    return this.referrals.get(subj)?.referrerId || null;
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
    if (!teamId || !captainWallet) throw new Error('teamId and captainWallet required');
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
    if (cur.captainWallet !== captainWallet) throw new Error('only captain can bind TG group');
    if (name) cur.name = name;
    if (tgGroupHandle) {
      cur.tgGroupHandle = tgGroupHandle;
      cur.tgChatId = tgChatId;
      // Not verified against Telegram yet (bot membership + admin rights land in phase 6).
      cur.bindStatus = 'verifying';
    }
    cur.updatedAt = nowSec;
    this.teams.set(teamId, cur);
    this.memberTeam.set(captainWallet, teamId);
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

  formatTeam(t) {
    return {
      teamId: t.teamId,
      name: t.name,
      captainWallet: t.captainWallet,
      tgGroupHandle: t.tgGroupHandle,
      tgChatId: t.tgChatId,
      bindStatus: t.bindStatus,
      memberCount: t.members.size,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }
}
