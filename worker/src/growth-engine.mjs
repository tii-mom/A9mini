// A9 Protocol v15 — Viral Growth Backend Engine (Zero Contract Changes):
//   1) Plan 1: 24H PASS/BURN Prediction Pool (0 TON entry, up to 2.0x invite+exact boost,
//      anti-sybil activation -> promo_balances, streak/winRate/pendingExpiresAt)
//   2) Plan 3: Dynamic OG / Twitter Card (/c/:type/:id + /c/img/:type/:id.png & .svg)
//      including 1200x630 landscape PNG (X/TG OG) & 1080x1920 9:16 portrait PNG (TG Story)

export class GrowthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const VOUCHER_TTL_MS = 2 * 86400 * 1000; // 2 rounds / 48h

export class PredictionEngine {
  constructor({ defaultPoolA9Raw = '1000000000000000' } = {}) { // default 1,000,000 A9 per round
    this.defaultPoolA9Raw = BigInt(defaultPoolA9Raw);
    // key: `${roundId}:${userId}` -> bet record
    this.bets = new Map();
    // key: `${roundId}:${referrerId}` -> Set<inviteeUserId>
    this.roundInvites = new Map();
    // userId -> { pendingActivationRaw, activatedRaw, pendingExpiresAt, totalSettled, totalWon, streak }
    this.userStats = new Map();
    // roundId -> 'PASS' | 'BURN'
    this.settledRounds = new Map();
  }

  _getOrCreateStats(uid) {
    let st = this.userStats.get(uid);
    if (!st) {
      st = {
        pendingActivationRaw: 0n,
        activatedRaw: 0n,
        pendingExpiresAt: null,
        totalSettled: 0,
        totalWon: 0,
        streak: 0,
      };
      this.userStats.set(uid, st);
    }
    return st;
  }

  placeBet({ roundId, userId, side, guessSlots = null, referrerId = null }, nowSec = Math.floor(Date.now() / 1000)) {
    const rId = Number(roundId);
    const uid = String(userId || '').trim();
    const normSide = String(side || '').toUpperCase();
    if (!uid || !Number.isInteger(rId) || rId < 1) throw new GrowthError('BAD_REQUEST', 'valid roundId and userId required');
    if (normSide !== 'PASS' && normSide !== 'BURN') throw new GrowthError('BAD_REQUEST', 'side must be PASS or BURN');
    if (this.settledRounds.has(rId)) throw new GrowthError('ROUND_SETTLED', `round ${rId} prediction already settled`);

    const key = `${rId}:${uid}`;
    if (this.bets.has(key)) throw new GrowthError('ALREADY_BET', 'user already placed a prediction for this round');

    const slots = guessSlots === null || guessSlots === undefined ? null : Number(guessSlots);
    if (slots !== null && (!Number.isInteger(slots) || slots < 0 || slots > 24)) {
      throw new GrowthError('BAD_REQUEST', 'guessSlots must be 0..24');
    }

    const cleanRef = referrerId && String(referrerId).trim() !== uid ? String(referrerId).trim() : null;
    if (cleanRef) {
      const invKey = `${rId}:${cleanRef}`;
      let set = this.roundInvites.get(invKey);
      if (!set) {
        set = new Set();
        this.roundInvites.set(invKey, set);
      }
      set.add(uid);
    }

    const rec = {
      roundId: rId,
      userId: uid,
      side: normSide,
      guessSlots: slots,
      referrerId: cleanRef,
      status: 'OPEN',
      rewardRaw: '0',
      createdAt: nowSec,
    };
    this.bets.set(key, rec);
    return rec;
  }

  getInviteBoostCount(roundId, userId) {
    if (!roundId || !userId) return 0;
    const set = this.roundInvites.get(`${Number(roundId)}:${String(userId).trim()}`);
    return set ? Math.min(5, set.size) : 0;
  }

  getRoundStats(roundId) {
    const rId = Number(roundId);
    let passCount = 0;
    let burnCount = 0;
    for (const b of this.bets.values()) {
      if (b.roundId !== rId) continue;
      if (b.side === 'PASS') passCount += 1;
      else burnCount += 1;
    }
    const total = passCount + burnCount;
    const winningSide = this.settledRounds.get(rId) || null;
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

  /**
   * Settle all predictions for roundId once the round finishes.
   * Weight base = 10n (1.0x):
   *   +5n (+0.5x) for exact qualified slot guess
   *   +min(5, inviteBoostCount) (+0.1x per friend invited in roundId, max +0.5x)
   *   Capped at 20n (2.0x).
   * Updates streak, winRate, and pendingExpiresAt (nowMs + 48h).
   */
  settleRoundBets(roundId, passed, actualQualified, poolA9Raw = this.defaultPoolA9Raw, nowMs = Date.now()) {
    const rId = Number(roundId);
    if (this.settledRounds.has(rId)) throw new GrowthError('ROUND_SETTLED', `round ${rId} already settled`);
    const winSide = passed ? 'PASS' : 'BURN';
    const pool = BigInt(poolA9Raw);

    const winners = [];
    let totalWeight = 0n;
    for (const b of this.bets.values()) {
      if (b.roundId !== rId) continue;
      const st = this._getOrCreateStats(b.userId);
      st.totalSettled += 1;
      if (b.side === winSide) {
        st.totalWon += 1;
        st.streak += 1;
        const exactBoost = b.guessSlots !== null && b.guessSlots === Number(actualQualified) ? 5n : 0n;
        const inviteBoost = BigInt(this.getInviteBoostCount(rId, b.userId));
        const rawW = 10n + exactBoost + inviteBoost;
        const weight = rawW > 20n ? 20n : rawW;
        winners.push({ bet: b, weight });
        totalWeight += weight;
      } else {
        st.streak = 0;
        b.status = 'LOST';
        b.rewardRaw = '0';
      }
    }

    let distributed = 0n;
    for (const { bet, weight } of winners) {
      const amt = totalWeight > 0n ? (pool * weight) / totalWeight : 0n;
      bet.status = 'WON_PENDING_ACTIVATION';
      bet.rewardRaw = amt.toString();
      distributed += amt;
      const st = this._getOrCreateStats(bet.userId);
      st.pendingActivationRaw += amt;
      st.pendingExpiresAt = nowMs + VOUCHER_TTL_MS;
    }

    this.settledRounds.set(rId, winSide);
    return { roundId: rId, winSide, winnersCount: winners.length, distributedRaw: distributed.toString() };
  }

  /**
   * Anti-sybil activation: requires qualified === true (at least 1 PAID_A9 presale order OR
   * 1 real on-chain StakeTicket) and non-expired voucher. Moves pending rewards into promoEngine.
   */
  activateToPromo(userId, walletAddress, promoEngine, { qualified = false, nowMs = Date.now() } = {}) {
    const uid = String(userId || '').trim();
    if (qualified !== true) {
      throw new GrowthError(
        'ACTIVATION_REQUIREMENT_UNMET',
        '请先完成至少 1 笔商行兑换或链上质押后再激活',
      );
    }

    const st = this.userStats.get(uid);
    if (!st || st.pendingActivationRaw <= 0n) {
      return { userId: uid, walletAddress, activatedRaw: '0' };
    }

    if (st.pendingExpiresAt !== null && nowMs > st.pendingExpiresAt) {
      st.pendingActivationRaw = 0n;
      st.pendingExpiresAt = null;
      throw new GrowthError('VOUCHER_EXPIRED', '待激活预言奖励已过期');
    }

    const amt = st.pendingActivationRaw;
    st.pendingActivationRaw = 0n;
    st.pendingExpiresAt = null;
    st.activatedRaw += amt;
    const result = { userId: uid, walletAddress, activatedRaw: amt.toString() };
    if (promoEngine && typeof promoEngine.creditReward === 'function') {
      const maybePromise = promoEngine.creditReward(walletAddress, amt);
      if (maybePromise && typeof maybePromise.then === 'function') {
        return maybePromise.then(() => result);
      }
    }
    return result;
  }

  getUserSummary(userId, roundId = null) {
    const uid = String(userId || '').trim();
    const st = this.userStats.get(uid) || {
      pendingActivationRaw: 0n,
      activatedRaw: 0n,
      pendingExpiresAt: null,
      totalSettled: 0,
      totalWon: 0,
      streak: 0,
    };
    const currentBet = roundId ? (this.bets.get(`${Number(roundId)}:${uid}`) || null) : null;
    const inviteBoostCount = roundId ? this.getInviteBoostCount(roundId, uid) : 0;
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
}

// ---------------------------------------------------------------------------
// Phase 3: Handbook Stamp & Non-Financial Progression Engine
// ---------------------------------------------------------------------------
export const EXP_PER_LEVEL = 200;

export const DAILY_STAMP_KEYS = Object.freeze([
  'daily_checkin',
  'daily_prediction',
  'daily_observe',
  'daily_share',
]);

export const PROGRESSION_TASKS = Object.freeze({
  daily_checkin: {
    key: 'daily_checkin',
    kind: 'daily',
    exp: 30,
    periodType: 'DAILY',
    zh: '主城打卡章',
    en: 'City Check-in Stamp',
  },
  daily_prediction: {
    key: 'daily_prediction',
    kind: 'daily',
    exp: 50,
    periodType: 'DAILY',
    zh: '24H 竞猜章',
    en: '24H Prediction Stamp',
  },
  daily_observe: {
    key: 'daily_observe',
    kind: 'daily',
    exp: 30,
    periodType: 'DAILY',
    zh: '24H 巡视章',
    en: '24H Logbook Stamp',
  },
  daily_share: {
    key: 'daily_share',
    kind: 'daily',
    exp: 40,
    periodType: 'DAILY',
    zh: '纸艺分享章',
    en: 'Paper Share Stamp',
  },
  daily_full_bonus: {
    key: 'daily_full_bonus',
    kind: 'bonus',
    exp: 80,
    periodType: 'DAILY',
    zh: '今日满章加赠',
    en: 'Daily Full Stamp Bonus',
  },
  ach_first_stamp: {
    key: 'ach_first_stamp',
    kind: 'achievement',
    exp: 50,
    periodType: 'ONCE',
    zh: '初入手账',
    en: 'First Stamp',
  },
  ach_streak_3: {
    key: 'ach_streak_3',
    kind: 'achievement',
    exp: 120,
    periodType: 'ONCE',
    zh: '三日连签章',
    en: '3-Day Streak',
  },
  ach_pred_pioneer: {
    key: 'ach_pred_pioneer',
    kind: 'achievement',
    exp: 100,
    periodType: 'ONCE',
    zh: '竞猜观星者',
    en: 'Prediction Pioneer',
  },
  ach_stamp_10: {
    key: 'ach_stamp_10',
    kind: 'achievement',
    exp: 200,
    periodType: 'ONCE',
    zh: '十章收藏家',
    en: '10-Stamp Collector',
  },
});

export function utcDayFromSec(nowSec = Math.floor(Date.now() / 1000)) {
  const sec = Number.isFinite(Number(nowSec)) ? Number(nowSec) : Math.floor(Date.now() / 1000);
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

export function prevUtcDay(dayStr) {
  if (!dayStr || !/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) return null;
  const [y, m, d] = dayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 86400 * 1000).toISOString().slice(0, 10);
}

export function levelFromExp(exp) {
  const safeExp = Math.max(0, Math.floor(Number(exp) || 0));
  return Math.floor(safeExp / EXP_PER_LEVEL) + 1;
}

export function computeEffectiveStreak(checkinStreak, lastCheckinDay, todayStr) {
  const s = Math.max(0, Number(checkinStreak) || 0);
  if (!lastCheckinDay || s === 0) return 0;
  if (lastCheckinDay === todayStr || lastCheckinDay === prevUtcDay(todayStr) || lastCheckinDay > todayStr) {
    return s;
  }
  return 0;
}

export function buildProgressionSummary({
  userId,
  exp = 0,
  checkinStreak = 0,
  lastCheckinDay = null,
  totalStamps = 0,
  todayStr,
  todayClaims = [],
  onceClaims = [],
  hasPredictionBet = false,
  hasEverPredicted = false,
}) {
  const safeExp = Math.max(0, Math.floor(Number(exp) || 0));
  const level = levelFromExp(safeExp);
  const currentLevelExp = safeExp % EXP_PER_LEVEL;
  const effectiveStreak = computeEffectiveStreak(checkinStreak, lastCheckinDay, todayStr);
  const todaySet = new Set(todayClaims);
  const onceSet = new Set(onceClaims);
  const dailyDoneCount = DAILY_STAMP_KEYS.filter((k) => todaySet.has(k)).length;
  const allDailyStampsDone = dailyDoneCount === DAILY_STAMP_KEYS.length;

  return {
    userId: String(userId),
    assetNature: 'NON_FINANCIAL_GAME_PROGRESSION',
    tradable: false,
    convertibleToA9: false,
    todayUtc: todayStr,
    exp: safeExp,
    level,
    expPerLevel: EXP_PER_LEVEL,
    currentLevelExp,
    nextLevelExp: EXP_PER_LEVEL,
    progressPct: Math.min(100, Math.round((currentLevelExp / EXP_PER_LEVEL) * 100)),
    checkinStreak: effectiveStreak,
    lastCheckinDay: lastCheckinDay || null,
    totalStamps: Math.max(0, Number(totalStamps) || 0),
    dailyDoneCount,
    dailyTotalCount: DAILY_STAMP_KEYS.length,
    allDailyStampsDone,
    dailyFullBonusClaimed: todaySet.has('daily_full_bonus'),
    todayClaims: Array.from(todaySet),
    achievementsClaimed: Array.from(onceSet),
    unlockableAchievements: [
      ...(totalStamps >= 1 && !onceSet.has('ach_first_stamp') ? ['ach_first_stamp'] : []),
      ...(effectiveStreak >= 3 && !onceSet.has('ach_streak_3') ? ['ach_streak_3'] : []),
      ...((hasPredictionBet || hasEverPredicted || todaySet.has('daily_prediction')) && !onceSet.has('ach_pred_pioneer') ? ['ach_pred_pioneer'] : []),
      ...(totalStamps >= 10 && !onceSet.has('ach_stamp_10') ? ['ach_stamp_10'] : []),
    ],
  };
}

export class ProgressionEngine {
  constructor() {
    // userId -> { exp, level, checkinStreak, lastCheckinDay, totalStamps, updatedAt }
    this.users = new Map();
    // `${userId}:${taskKey}:${periodKey}` -> { userId, taskKey, periodKey, expAwarded, claimedAt }
    this.claims = new Map();
  }

  _getOrCreateUser(uid) {
    let u = this.users.get(uid);
    if (!u) {
      u = {
        userId: uid,
        exp: 0,
        level: 1,
        checkinStreak: 0,
        lastCheckinDay: null,
        totalStamps: 0,
        updatedAt: 0,
      };
      this.users.set(uid, u);
    }
    return u;
  }

  getUserSummary(userId, nowSec = Math.floor(Date.now() / 1000), { hasPredictionBet = false } = {}) {
    const uid = String(userId || '').trim();
    if (!uid) throw new GrowthError('BAD_REQUEST', 'userId required');
    const todayStr = utcDayFromSec(nowSec);
    const u = this._getOrCreateUser(uid);
    const todayClaims = [];
    const onceClaims = [];
    let hasEverPredicted = Boolean(hasPredictionBet);
    for (const c of this.claims.values()) {
      if (c.userId !== uid) continue;
      if (c.periodKey === todayStr) todayClaims.push(c.taskKey);
      if (c.periodKey === 'ONCE') onceClaims.push(c.taskKey);
      if (c.taskKey === 'daily_prediction') hasEverPredicted = true;
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

  claimTask({ userId, taskKey, hasPredictionBet = false }, nowSec = Math.floor(Date.now() / 1000)) {
    const uid = String(userId || '').trim();
    const tKey = String(taskKey || '').trim();
    if (!uid || !tKey) throw new GrowthError('BAD_REQUEST', 'userId and taskKey required');
    const task = PROGRESSION_TASKS[tKey];
    if (!task) throw new GrowthError('UNKNOWN_TASK', `unknown progression task: ${tKey}`);

    const todayStr = utcDayFromSec(nowSec);
    const periodKey = task.periodType === 'ONCE' ? 'ONCE' : todayStr;
    const claimId = `${uid}:${tKey}:${periodKey}`;
    if (this.claims.has(claimId)) {
      throw new GrowthError('ALREADY_CLAIMED', '该手账印章已盖章领取，不可重复领取');
    }

    const u = this._getOrCreateUser(uid);
    const curStreak = computeEffectiveStreak(u.checkinStreak, u.lastCheckinDay, todayStr);

    // 校验任务前置条件
    if (tKey === 'daily_prediction' && !hasPredictionBet) {
      throw new GrowthError('TASK_PREREQUISITE_UNMET', '请先参与本轮 0 GRAM 24H 达标竞猜后再盖章');
    }
    if (tKey === 'daily_full_bonus') {
      const allDone = DAILY_STAMP_KEYS.every((k) => this.claims.has(`${uid}:${k}:${todayStr}`));
      if (!allDone) {
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
        for (const c of this.claims.values()) {
          if (c.userId === uid && c.taskKey === 'daily_prediction') {
            hasEverPred = true;
            break;
          }
        }
      }
      if (!hasEverPred) {
        throw new GrowthError('TASK_PREREQUISITE_UNMET', '需完成至少 1 次 24H 达标竞猜后解锁');
      }
    }
    if (tKey === 'ach_stamp_10' && u.totalStamps < 10) {
      throw new GrowthError('TASK_PREREQUISITE_UNMET', '累计集齐 10 枚手账印章后解锁');
    }

    this.claims.set(claimId, {
      userId: uid,
      taskKey: tKey,
      periodKey,
      expAwarded: task.exp,
      claimedAt: nowSec,
    });

    if (tKey === 'daily_checkin') {
      if (u.lastCheckinDay === todayStr) {
        u.checkinStreak = Math.max(1, u.checkinStreak);
      } else if (u.lastCheckinDay === prevUtcDay(todayStr)) {
        u.checkinStreak += 1;
      } else {
        u.checkinStreak = 1;
      }
      u.lastCheckinDay = todayStr;
    }

    u.exp += task.exp;
    u.level = levelFromExp(u.exp);
    if (task.kind === 'daily') {
      u.totalStamps += 1;
    }
    u.updatedAt = nowSec;

    return {
      claimedTask: tKey,
      periodKey,
      expAwarded: task.exp,
      progression: this.getUserSummary(uid, nowSec, { hasPredictionBet }),
    };
  }
}

// ---------------------------------------------------------------------------
// Dynamic OG Card SVG & Landing HTML
// ---------------------------------------------------------------------------
function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Generate warm cotton paper (#F5F0E6) + coral red (#E8453C) 1200x630 SVG card. */
export function renderOgCardSvg({
  type = 'round',
  roundId = null,
  hasData = true,
  state = 'UNVERIFIED',
  qualified = null,
  totalSlots = 24,
  targetUsd = '—',
  budgetA9 = null,
  subtitle = '',
}) {
  const verified = Boolean(hasData && roundId);
  const isBurn = verified && (type === 'burn' || state === 'FAILED_PERMANENT');
  const accent = isBurn ? '#D94860' : '#E8453C';
  const qualNum = verified && Number.isInteger(qualified) ? qualified : null;
  const roundLabel = roundId ? `#${roundId}` : 'PENDING';
  const titleMap = {
    round: verified ? `A9 ROUND ${roundLabel} · ${qualNum ?? '—'}/${totalSlots} SLOTS` : `A9 ROUND ${roundLabel} · DATA PENDING`,
    burn: verified ? `A9 ROUND ${roundLabel} · 100% BURN MONUMENT` : `A9 ROUND ${roundLabel} · DATA PENDING`,
    proof: verified ? `A9 ROUND ${roundLabel} · ON-CHAIN STAKE PROOF` : `A9 ROUND ${roundLabel} · DATA PENDING`,
    bet: verified ? `A9 ROUND ${roundLabel} · 24H PASS vs BURN` : `A9 ROUND ${roundLabel} · DATA PENDING`,
  };
  const title = titleMap[type] || titleMap.round;
  const poolPart = budgetA9 ? `Pool ${budgetA9} A9` : 'Pool Pending Verification';
  const sub = subtitle || (!verified
    ? 'On-Chain Data Pending Verification · TON TEP-74'
    : (isBurn ? 'Principal & Pool Burned On-Chain · Witnessed on TON' : `Target ${targetUsd || '—'} · ${poolPart} · Up to 15x`));

  const bars = [];
  for (let i = 0; i < 24; i += 1) {
    const x = 60 + i * 45;
    const fill = qualNum !== null && i < qualNum ? '#2DA069' : (isBurn ? '#D94860' : '#E4DDD0');
    bars.push(`<rect x="${x}" y="380" width="32" height="92" rx="8" fill="${fill}" />`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#F5F0E6"/>
  <rect x="28" y="34" width="1144" height="568" rx="32" fill="#D8CEBC"/>
  <rect x="28" y="26" width="1144" height="568" rx="32" fill="#FFFFFF" stroke="#E4DDD0" stroke-width="2"/>
  <text x="60" y="108" fill="${accent}" font-family="monospace" font-size="28" font-weight="700" letter-spacing="4">A9 PAPER CRAFT // TON</text>
  <text x="60" y="210" fill="#2B2523" font-family="sans-serif" font-size="56" font-weight="700">${escapeXml(title)}</text>
  <text x="60" y="276" fill="#675E58" font-family="monospace" font-size="28">${escapeXml(sub)}</text>
  ${bars.join('\n  ')}
  <text x="60" y="546" fill="#9A8F86" font-family="monospace" font-size="24">16 / 24 HOURLY SLOTS TO PASS · 100% ON-CHAIN TON TEP-74</text>
</svg>`;
}

/** Generate OG / Twitter Card HTML landing page with PNG og:image & Telegram Mini App deep-link. */
export function renderOgLandingHtml({ type, id, title, description, imageUrl, tgDeepLink, width = 1200, height = 630 }) {
  const safeTitle = escapeXml(title);
  const safeDesc = escapeXml(description);
  const safeImg = escapeXml(imageUrl);
  const safeLink = escapeXml(tgDeepLink);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDesc}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:image" content="${safeImg}" />
  <meta property="og:image:width" content="${width}" />
  <meta property="og:image:height" content="${height}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${safeImg}" />
  <meta http-equiv="refresh" content="1;url=${safeLink}" />
</head>
<body style="background:#F5F0E6;color:#2B2523;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
  <div style="text-align:center;padding:28px;background:#FFFFFF;border:2px solid #E4DDD0;border-bottom:6px solid #D8CEBC;border-radius:24px;max-width:520px;">
    <h2>${safeTitle}</h2>
    <p style="color:#675E58;">${safeDesc}</p>
    <a href="${safeLink}" style="display:inline-block;margin-top:16px;padding:12px 24px;border-radius:14px;background:#E8453C;border-bottom:4px solid #B82D25;color:#fff;text-decoration:none;font-weight:700;">Open A9 Mini App on Telegram</a>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Zero-Dependency Pure-JS PNG Raster Card Renderer (Node 18+ & Cloudflare Worker)
// Supports 1200x630 (X / TG OG Card) and 1080x1920 (ratio='9x16' TG Story)
// ---------------------------------------------------------------------------
const FONT_5X7 = {
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x06, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '#': [0x0a, 0x0a, 0x1f, 0x0a, 0x1f, 0x0a, 0x0a],
  '/': [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  '$': [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04],
  '%': [0x19, 0x19, 0x02, 0x04, 0x08, 0x13, 0x13],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
};

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlibCompress(raw) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const ch of chunks) {
    merged.set(ch, offset);
    offset += ch.length;
  }
  return merged;
}

/**
 * Render an OG / Story PNG raster card (returns Uint8Array).
 * Default: 1200x630 (X / TG OG Card). Pass ratio: '9x16' for 1080x1920 (TG Story).
 */
export async function renderOgCardPng({
  type = 'round',
  roundId = null,
  hasData = true,
  state = 'UNVERIFIED',
  qualified = null,
  totalSlots = 24,
  targetUsd = '--',
  budgetA9 = null,
  ratio = '16x9',
} = {}) {
  const portrait = ratio === '9x16';
  const width = portrait ? 1080 : 1200;
  const height = portrait ? 1920 : 630;
  const stride = 1 + width * 3;
  const raw = new Uint8Array(height * stride);

  const verified = Boolean(hasData && roundId);
  const isBurn = verified && (type === 'burn' || state === 'FAILED_PERMANENT');
  const accent = isBurn ? [0xd9, 0x48, 0x60] : [0xe8, 0x45, 0x3c];
  const green = [0x2d, 0xa0, 0x69];
  const mutedBar = isBurn ? [0xf2, 0xd4, 0xd9] : [0xe4, 0xdd, 0xd0];
  const white = [0x2b, 0x25, 0x23]; // cocoa ink text on warm cotton paper
  const silver = [0x67, 0x5e, 0x58];

  // 1. Background fill (#F5F0E6 warm cotton paper)
  for (let y = 0; y < height; y += 1) {
    const rowOff = y * stride;
    raw[rowOff] = 0; // PNG filter type 0 (None)
    for (let x = 0; x < width; x += 1) {
      const p = rowOff + 1 + x * 3;
      raw[p] = 0xf5;
      raw[p + 1] = 0xf0;
      raw[p + 2] = 0xe6;
    }
  }

  const fillRect = (x0, y0, w, h, rgb) => {
    const xStart = Math.max(0, Math.floor(x0));
    const yStart = Math.max(0, Math.floor(y0));
    const xEnd = Math.min(width, Math.floor(x0 + w));
    const yEnd = Math.min(height, Math.floor(y0 + h));
    for (let y = yStart; y < yEnd; y += 1) {
      let p = y * stride + 1 + xStart * 3;
      for (let x = xStart; x < xEnd; x += 1) {
        raw[p] = rgb[0];
        raw[p + 1] = rgb[1];
        raw[p + 2] = rgb[2];
        p += 3;
      }
    }
  };

  const drawText = (text, x, y, scale, rgb) => {
    const str = String(text || '').toUpperCase();
    let cx = x;
    for (let i = 0; i < str.length; i += 1) {
      const glyph = FONT_5X7[str[i]] || FONT_5X7[' '];
      for (let row = 0; row < 7; row += 1) {
        const bits = glyph[row];
        for (let col = 0; col < 5; col += 1) {
          if (bits & (1 << (4 - col))) {
            fillRect(cx + col * scale, y + row * scale, scale, scale, rgb);
          }
        }
      }
      cx += 6 * scale;
    }
  };

  // 2. Outer accent frame
  const pad = portrait ? 44 : 28;
  const bw = 4;
  fillRect(pad, pad, width - pad * 2, bw, accent);
  fillRect(pad, height - pad - bw, width - pad * 2, bw, accent);
  fillRect(pad, pad, bw, height - pad * 2, accent);
  fillRect(width - pad - bw, pad, bw, height - pad * 2, accent);

  const roundLabel = roundId ? `#${roundId}` : 'PENDING';
  const headlineMap = {
    round: `ROUND ${roundLabel}`,
    burn: `ROUND ${roundLabel} BURN`,
    proof: `ROUND ${roundLabel} PROOF`,
    bet: `ROUND ${roundLabel} BET`,
  };
  const headline = verified ? (headlineMap[type] || headlineMap.round) : `ROUND ${roundLabel}`;
  const qualNum = verified && Number.isInteger(qualified) ? qualified : null;
  const slotText = verified && qualNum !== null ? `${qualNum}/${totalSlots} SLOTS` : 'DATA PENDING';
  const cleanTarget = verified ? (String(targetUsd || '--').replace(/[^0-9.$-]/g, '') || '--') : '--';
  const cleanBudget = verified && budgetA9 ? String(budgetA9).replace(/[^0-9A-Za-z]/g, '') : null;
  const poolLine = cleanBudget ? `POOL ${cleanBudget} A9  UP TO 15X` : 'ON-CHAIN DATA PENDING';
  const landscapeMeta = !verified
    ? 'ON-CHAIN DATA PENDING VERIFICATION'
    : (isBurn ? '100% BURN MONUMENT  ON-CHAIN TON' : `TARGET ${cleanTarget}${cleanBudget ? `  POOL ${cleanBudget} A9` : '  POOL PENDING'}`);

  if (portrait) {
    // 1080x1920 TG Story vertical layout
    drawText('A9 PROTOCOL // TON', 96, 160, 6, accent);
    drawText(headline, 96, 300, 12, white);
    drawText(slotText, 96, 450, 14, isBurn ? accent : green);
    drawText(!verified ? 'PENDING VERIFICATION' : (isBurn ? '100% BURN MONUMENT' : `TARGET ${cleanTarget}`), 96, 610, 6, silver);
    drawText(poolLine, 96, 690, 5, silver);

    // 24H crystal grid: 6 columns x 4 rows
    const cellW = 132;
    const cellH = 132;
    const gap = 22;
    const gridX = 96;
    const gridY = 820;
    for (let i = 0; i < 24; i += 1) {
      const col = i % 6;
      const row = Math.floor(i / 6);
      const fill = qualNum !== null && i < qualNum ? green : mutedBar;
      fillRect(gridX + col * (cellW + gap), gridY + row * (cellH + gap), cellW, cellH, fill);
    }

    drawText('16/24 HOURLY SLOTS TO PASS', 96, 1560, 5, silver);
    drawText('100% ON-CHAIN TON TEP-74', 96, 1640, 5, accent);
  } else {
    // 1200x630 X / Telegram OG landscape layout
    drawText('A9 PROTOCOL // TON', 64, 72, 4, accent);
    drawText(`${headline}  ${slotText}`, 64, 150, 8, white);
    drawText(landscapeMeta, 64, 250, 4, silver);

    // 24 slot bars across 1072px
    for (let i = 0; i < 24; i += 1) {
      const bx = 64 + i * 45;
      const fill = qualNum !== null && i < qualNum ? green : mutedBar;
      fillRect(bx, 340, 32, 128, fill);
    }

    drawText('16/24 HOURLY SLOTS TO PASS  100% ON-CHAIN TEP-74', 64, 526, 3, silver);
  }

  // 3. Encode PNG
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const compressed = await zlibCompress(raw);
  const ihdr = pngChunk('IHDR', ihdrData);
  const idat = pngChunk('IDAT', compressed);
  const iend = pngChunk('IEND', new Uint8Array(0));

  const png = new Uint8Array(sig.length + ihdr.length + idat.length + iend.length);
  let pos = 0;
  for (const part of [sig, ihdr, idat, iend]) {
    png.set(part, pos);
    pos += part.length;
  }
  return png;
}
