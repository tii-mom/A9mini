// A9 Protocol v17.0 — 8% Pass-Round Stake Referral Credits & Per-Round Equal Airdrop Draws.
// Strictly reuses 0014_v17_price_unlock.sql tables (stake_referral_credits, round_jackpot_draws)
// and promo_budget_ledger buckets (stake_referral: 200M A9, round_airdrop: 50M A9).
import { addressKey, addressAliases, normalizeTonAddress } from './ton-address.mjs';
import { BudgetError, PROMO_BUDGET_BUCKETS } from './promo-budget.mjs';

export const STAKE_REFERRAL_BPS = 800n;
export const BPS_DENOMINATOR = 10000n;
export const DEFAULT_AIRDROP_PRIZE_RAW = (100_000n * 1_000_000_000n).toString();

const changes = (r) => Number(r?.meta?.changes ?? r?.changes ?? 0);

export class V17RewardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function maskWalletAddress(addr) {
  const s = String(addr || '').trim();
  if (!s) return '—';
  if (s.length <= 10) return s;
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

export function buildStakeReferralCreditId(roundId, refereeWallet) {
  const rId = Number(roundId);
  const refKey = addressKey(refereeWallet);
  return `stake_ref:${rId}:${refKey}`;
}

export function computeStakeReferralCommissionRaw(refereeRewardRaw) {
  let reward;
  try {
    reward = BigInt(String(refereeRewardRaw ?? '0'));
  } catch {
    throw new V17RewardError('BAD_AMOUNT', 'refereeRewardRaw must be an integer string');
  }
  if (reward <= 0n) {
    throw new V17RewardError('BAD_AMOUNT', 'refereeRewardRaw must be positive');
  }
  return (reward * STAKE_REFERRAL_BPS) / BPS_DENOMINATOR;
}

/**
 * Deterministic equal-probability winner selection using SHA-256(seedHash + ":" + roundId).
 * Deduplicates participants by canonical addressKey and sorts lexicographically for full auditability.
 */
export async function pickDeterministicAirdropWinner(roundId, participants, seedHash) {
  const rId = Number(roundId);
  if (!Number.isInteger(rId) || rId < 1) {
    throw new V17RewardError('BAD_ROUND_ID', 'roundId must be a positive integer');
  }
  const cleanSeed = String(seedHash || '').trim();
  if (!cleanSeed) {
    throw new V17RewardError('BAD_SEED_HASH', 'seedHash is required');
  }
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new V17RewardError('NO_PARTICIPANTS', 'at least one participant wallet is required');
  }

  const byKey = new Map();
  for (const raw of participants) {
    const w = String(raw || '').trim();
    if (!w) continue;
    if (!normalizeTonAddress(w)) {
      throw new V17RewardError('BAD_WALLET', 'every participant must be a valid TON address');
    }
    const key = addressKey(w);
    if (!byKey.has(key)) byKey.set(key, w);
  }
  const sortedKeys = Array.from(byKey.keys()).sort();
  if (sortedKeys.length === 0) {
    throw new V17RewardError('NO_PARTICIPANTS', 'at least one valid participant wallet is required');
  }

  const input = new TextEncoder().encode(`${cleanSeed}:${rId}`);
  const hashBuf = await crypto.subtle.digest('SHA-256', input);
  const bytes = new Uint8Array(hashBuf);
  let idxNum = 0n;
  for (let i = 0; i < 8; i += 1) {
    idxNum = (idxNum << 8n) | BigInt(bytes[i]);
  }
  const winnerIdx = Number(idxNum % BigInt(sortedKeys.length));
  return {
    winnerWallet: byKey.get(sortedKeys[winnerIdx]),
    winnerKey: sortedKeys[winnerIdx],
    participantCount: sortedKeys.length,
    winnerIndex: winnerIdx,
  };
}

function validateWalletPair(referrerWallet, refereeWallet) {
  const ref = String(referrerWallet || '').trim();
  const fee = String(refereeWallet || '').trim();
  if (!ref || !fee) {
    throw new V17RewardError('BAD_WALLET', 'referrerWallet and refereeWallet are required');
  }
  if (!normalizeTonAddress(ref) || !normalizeTonAddress(fee)) {
    throw new V17RewardError('BAD_WALLET', 'referrerWallet and refereeWallet must be valid TON addresses');
  }
  if (addressKey(ref) === addressKey(fee)) {
    throw new V17RewardError('SELF_REFERRAL', 'referrerWallet cannot equal refereeWallet');
  }
  return { referrerWallet: ref, refereeWallet: fee };
}

function parsePositiveBigInt(val, label) {
  let n;
  try {
    n = BigInt(String(val ?? '0'));
  } catch {
    throw new V17RewardError('BAD_AMOUNT', `${label} must be an integer string`);
  }
  if (n <= 0n) throw new V17RewardError('BAD_AMOUNT', `${label} must be positive`);
  return n;
}

function formatCreditRow(r, { maskReferee = true } = {}) {
  return {
    creditId: String(r.creditId ?? r.credit_id),
    roundId: Number(r.roundId ?? r.round_id),
    referrerWallet: String(r.referrerWallet ?? r.referrer_wallet),
    refereeWallet: maskReferee
      ? maskWalletAddress(r.refereeWallet ?? r.referee_wallet)
      : String(r.refereeWallet ?? r.referee_wallet),
    refereeRewardRaw: String(r.refereeRewardRaw ?? r.referee_reward_raw),
    commissionRaw: String(r.commissionRaw ?? r.commission_raw),
    status: String(r.status || 'PENDING'),
    createdAt: Number(r.createdAt ?? r.created_at ?? 0),
  };
}

function formatDrawRow(r, { maskWinner = true } = {}) {
  const rawWinner = String(r.winnerWallet ?? r.winner_wallet ?? '');
  return {
    roundId: Number(r.roundId ?? r.round_id),
    seedHash: String(r.seedHash ?? r.seed_hash),
    winnerWallet: maskWinner ? maskWalletAddress(rawWinner) : rawWinner,
    prizeRaw: String(r.prizeRaw ?? r.prize_raw),
    status: String(r.status || 'PENDING'),
    createdAt: Number(r.createdAt ?? r.created_at ?? 0),
  };
}

async function resolveBucketRemaining(budgetLedger, bucketKey) {
  const defaultCap = String(PROMO_BUDGET_BUCKETS[bucketKey] || '0');
  if (budgetLedger && typeof budgetLedger.getBucket === 'function') {
    try {
      const b = await budgetLedger.getBucket(bucketKey);
      if (b && b.remainingRaw !== undefined) {
        return {
          bucketCapRaw: String(b.capRaw || defaultCap),
          bucketRemainingRaw: String(b.remainingRaw),
        };
      }
    } catch {
      // fall through to default cap
    }
  }
  return { bucketCapRaw: defaultCap, bucketRemainingRaw: defaultCap };
}

export class V17RewardEngine {
  constructor() {
    this.stakeReferralCredits = new Map(); // creditId -> row
    this.airdropDraws = new Map();         // roundId -> row
  }

  async settleStakeReferral(
    { roundId, referrerWallet, refereeWallet, refereeRewardRaw, promoEngine = null, budgetLedger = null },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    const rId = Number(roundId);
    if (!Number.isInteger(rId) || rId < 1) {
      throw new V17RewardError('BAD_ROUND_ID', 'roundId must be a positive integer');
    }
    const pair = validateWalletPair(referrerWallet, refereeWallet);
    const rewardBig = parsePositiveBigInt(refereeRewardRaw, 'refereeRewardRaw');
    const commissionBig = computeStakeReferralCommissionRaw(rewardBig);
    const creditId = buildStakeReferralCreditId(rId, pair.refereeWallet);

    let rec = this.stakeReferralCredits.get(creditId);
    if (rec && rec.status === 'CREDITED') {
      return { ...formatCreditRow(rec, { maskReferee: false }), duplicate: true, budgetExhausted: false };
    }
    if (!rec) {
      rec = {
        creditId,
        roundId: rId,
        referrerWallet: pair.referrerWallet,
        refereeWallet: pair.refereeWallet,
        refereeRewardRaw: rewardBig.toString(),
        commissionRaw: commissionBig.toString(),
        status: 'PENDING',
        createdAt: Number(nowSec),
      };
      this.stakeReferralCredits.set(creditId, rec);
    }

    const effectiveCommission = BigInt(rec.commissionRaw);
    if (effectiveCommission <= 0n) {
      return { ...formatCreditRow(rec, { maskReferee: false }), duplicate: false, budgetExhausted: false };
    }

    let reserved = false;
    if (budgetLedger && typeof budgetLedger.reserve === 'function') {
      try {
        const rsv = await budgetLedger.reserve('stake_referral', effectiveCommission.toString(), nowSec);
        reserved = !rsv?.legacySkipped;
      } catch (e) {
        if (e instanceof BudgetError && e.code === 'PROMO_BUDGET_EXHAUSTED') {
          return { ...formatCreditRow(rec, { maskReferee: false }), duplicate: false, budgetExhausted: true };
        }
        throw e;
      }
    }

    if (rec.status !== 'PENDING') {
      if (reserved && budgetLedger && typeof budgetLedger.release === 'function') {
        await budgetLedger.release('stake_referral', effectiveCommission.toString(), nowSec);
      }
      return { ...formatCreditRow(rec, { maskReferee: false }), duplicate: true, budgetExhausted: false };
    }

    rec.status = 'CREDITED';
    try {
      if (promoEngine && typeof promoEngine.creditReward === 'function') {
        await promoEngine.creditReward(rec.referrerWallet, effectiveCommission, nowSec);
      }
    } catch (e) {
      rec.status = 'PENDING';
      if (reserved && budgetLedger && typeof budgetLedger.release === 'function') {
        await budgetLedger.release('stake_referral', effectiveCommission.toString(), nowSec);
      }
      throw e;
    }

    return { ...formatCreditRow(rec, { maskReferee: false }), duplicate: false, budgetExhausted: false };
  }

  async getUserStakeReferrals(walletAddress, { limit = 50 } = {}) {
    const cleanWallet = String(walletAddress || '').trim();
    if (!cleanWallet) {
      return {
        walletAddress: null,
        totalCommissionRaw: '0',
        creditedRaw: '0',
        pendingRaw: '0',
        count: 0,
        items: [],
      };
    }
    const targetKey = addressKey(cleanWallet);
    const lim = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
    const matched = Array.from(this.stakeReferralCredits.values())
      .filter((r) => addressKey(r.referrerWallet) === targetKey)
      .sort((a, b) => (b.createdAt - a.createdAt) || (b.roundId - a.roundId));

    let totalCommission = 0n;
    let credited = 0n;
    let pending = 0n;
    for (const r of matched) {
      const c = BigInt(r.commissionRaw || '0');
      totalCommission += c;
      if (r.status === 'CREDITED') credited += c;
      else pending += c;
    }

    return {
      walletAddress: cleanWallet,
      totalCommissionRaw: totalCommission.toString(),
      creditedRaw: credited.toString(),
      pendingRaw: pending.toString(),
      count: matched.length,
      items: matched.slice(0, lim).map((r) => formatCreditRow(r, { maskReferee: true })),
    };
  }

  async drawRoundAirdrop(
    { roundId, participants, seedHash, prizeRaw = DEFAULT_AIRDROP_PRIZE_RAW, promoEngine = null, budgetLedger = null },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    const rId = Number(roundId);
    if (!Number.isInteger(rId) || rId < 1) {
      throw new V17RewardError('BAD_ROUND_ID', 'roundId must be a positive integer');
    }
    const prizeBig = parsePositiveBigInt(prizeRaw, 'prizeRaw');
    if (!promoEngine || typeof promoEngine.creditReward !== 'function') {
      throw new V17RewardError('PROMO_ENGINE_REQUIRED', 'promoEngine is required for round airdrop draw');
    }

    let rec = this.airdropDraws.get(rId);
    if (rec && rec.status === 'CREDITED') {
      return { ...formatDrawRow(rec, { maskWinner: false }), duplicate: true, budgetExhausted: false };
    }
    if (!rec) {
      const picked = await pickDeterministicAirdropWinner(rId, participants, seedHash);
      rec = {
        roundId: rId,
        seedHash: String(seedHash).trim(),
        winnerWallet: picked.winnerWallet,
        prizeRaw: prizeBig.toString(),
        status: 'PENDING',
        createdAt: Number(nowSec),
      };
      this.airdropDraws.set(rId, rec);
    } else if (rec.status === 'PENDING' && rec.prizeRaw !== prizeBig.toString()) {
      rec.prizeRaw = prizeBig.toString();
    }

    const effectivePrize = BigInt(rec.prizeRaw);
    let reserved = false;
    if (budgetLedger && typeof budgetLedger.reserve === 'function') {
      try {
        const rsv = await budgetLedger.reserve('round_airdrop', effectivePrize.toString(), nowSec);
        reserved = !rsv?.legacySkipped;
      } catch (e) {
        if (e instanceof BudgetError && e.code === 'PROMO_BUDGET_EXHAUSTED') {
          return { ...formatDrawRow(rec, { maskWinner: false }), duplicate: false, budgetExhausted: true };
        }
        throw e;
      }
    }

    if (rec.status !== 'PENDING') {
      if (reserved && budgetLedger && typeof budgetLedger.release === 'function') {
        await budgetLedger.release('round_airdrop', effectivePrize.toString(), nowSec);
      }
      return { ...formatDrawRow(rec, { maskWinner: false }), duplicate: true, budgetExhausted: false };
    }

    rec.status = 'CREDITED';
    try {
      if (promoEngine && typeof promoEngine.creditReward === 'function') {
        await promoEngine.creditReward(rec.winnerWallet, effectivePrize, nowSec);
      }
    } catch (e) {
      rec.status = 'PENDING';
      if (reserved && budgetLedger && typeof budgetLedger.release === 'function') {
        await budgetLedger.release('round_airdrop', effectivePrize.toString(), nowSec);
      }
      throw e;
    }

    return { ...formatDrawRow(rec, { maskWinner: false }), duplicate: false, budgetExhausted: false };
  }

  async listAirdropDraws({ roundId = null, limit = 20, budgetLedger = null } = {}) {
    const lim = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    let rows = Array.from(this.airdropDraws.values());
    if (roundId !== null && roundId !== undefined && String(roundId).trim() !== '') {
      const rId = Number(roundId);
      rows = rows.filter((r) => r.roundId === rId);
    }
    rows.sort((a, b) => b.roundId - a.roundId);
    const bucket = await resolveBucketRemaining(budgetLedger, 'round_airdrop');
    return {
      items: rows.slice(0, lim).map((r) => formatDrawRow(r, { maskWinner: true })),
      ...bucket,
    };
  }
}

export class D1V17RewardEngine {
  constructor({ db }) {
    if (!db) throw new Error('Cloudflare D1 binding (env.DB) is required');
    this.db = db;
  }

  /**
   * 原子单事务落库：在同一 D1 db.batch() 内同时完成「预算扣减 + 记录置 CREDITED + promo_balances 累加」，
   * 杜绝三步非原子写库导致的双发、永久吞奖或预算泄漏。
   */
  async _atomicBatchCredit({
    table,
    idCol,
    idVal,
    bucketKey,
    targetWallet,
    amountBig,
    budgetLedger,
    nowSec,
  }) {
    const walletKey = addressKey(targetWallet);
    const aliases = Array.from(new Set([walletKey, targetWallet, ...addressAliases(targetWallet)].filter(Boolean)));
    const placeholders = aliases.map(() => '?').join(', ');

    for (let attempt = 0; attempt < 8; attempt += 1) {
      // 确保目标钱包在 promo_balances 存在余额行
      let balRow = await this.db
        .prepare(`SELECT wallet_address, claimable_raw FROM promo_balances WHERE wallet_address IN (${placeholders}) LIMIT 1`)
        .bind(...aliases)
        .first();
      if (!balRow) {
        await this.db
          .prepare(
            `INSERT OR IGNORE INTO promo_balances (wallet_address, claimable_raw, total_claimed_raw, updated_at)
             VALUES (?, '0', '0', ?)`,
          )
          .bind(walletKey, nowSec)
          .run();
        balRow = await this.db
          .prepare(`SELECT wallet_address, claimable_raw FROM promo_balances WHERE wallet_address IN (${placeholders}) LIMIT 1`)
          .bind(...aliases)
          .first();
      }
      if (!balRow) continue;

      const balWallet = String(balRow.wallet_address);
      const curClaimableStr = String(balRow.claimable_raw || '0');
      const nextClaimableStr = (BigInt(curClaimableStr) + amountBig).toString();

      let budgetPrep = null;
      if (budgetLedger && typeof budgetLedger.prepareAtomicReserve === 'function') {
        budgetPrep = await budgetLedger.prepareAtomicReserve(bucketKey, amountBig.toString(), nowSec);
      }

      const stmts = [];
      // 1) 状态 PENDING -> CREDITED（附带余额与预算快照守卫，防止任何半提交）
      const guardSql =
        ` AND EXISTS (SELECT 1 FROM promo_balances WHERE wallet_address = ? AND claimable_raw = ?)` +
        (budgetPrep ? budgetPrep.guardSql : '');
      const guardArgs = [balWallet, curClaimableStr, ...(budgetPrep ? budgetPrep.guardArgs : [])];
      stmts.push(
        this.db
          .prepare(
            `UPDATE ${table}
             SET status = CASE
               WHEN status = 'PENDING'${guardSql} THEN 'CREDITED'
               ELSE NULL
             END
             WHERE ${idCol} = ?`,
          )
          .bind(...guardArgs, idVal),
      );

      // 2) 预算扣减（仅当主记录已转为 CREDITED 时执行）
      if (budgetPrep) {
        stmts.push(
          this.db
            .prepare(
              `UPDATE promo_budget_ledger
               SET spent_raw = CASE
                     WHEN spent_raw = ?
                      AND EXISTS (SELECT 1 FROM ${table} WHERE ${idCol} = ? AND status = 'CREDITED')
                     THEN ?
                     ELSE NULL
                   END,
                   updated_at = ?
               WHERE bucket_key = ?`,
            )
            .bind(budgetPrep.curSpentStr, idVal, budgetPrep.nextSpentStr, nowSec, budgetPrep.bucketKey),
        );
      }

      // 3) promo_balances 累加（仅当主记录已转为 CREDITED 时执行）
      stmts.push(
        this.db
          .prepare(
            `UPDATE promo_balances
             SET claimable_raw = CASE
                   WHEN claimable_raw = ?
                    AND EXISTS (SELECT 1 FROM ${table} WHERE ${idCol} = ? AND status = 'CREDITED')
                   THEN ?
                   ELSE NULL
                 END,
                 updated_at = ?
             WHERE wallet_address = ?`,
          )
          .bind(curClaimableStr, idVal, nextClaimableStr, nowSec, balWallet),
      );

      try {
        const res = await this.db.batch(stmts);
        if (changes(res?.[0]) === 1 && changes(res?.[stmts.length - 1]) === 1) {
          return { credited: true, duplicate: false };
        }
      } catch (e) {
        if (!/NOT NULL|UNIQUE|constraint/i.test(String(e?.message || e))) throw e;
        // 并发冲突：先检查目标行是否已被并发请求成功置为 CREDITED
        const cur = await this.db
          .prepare(`SELECT status FROM ${table} WHERE ${idCol} = ? LIMIT 1`)
          .bind(idVal)
          .first();
        if (cur && String(cur.status) === 'CREDITED') {
          return { credited: false, duplicate: true };
        }
        continue;
      }
    }
    throw new V17RewardError('CONFLICT', 'reward settlement CAS conflict, please retry');
  }

  async settleStakeReferral(
    { roundId, referrerWallet, refereeWallet, refereeRewardRaw, promoEngine = null, budgetLedger = null },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    const rId = Number(roundId);
    if (!Number.isInteger(rId) || rId < 1) {
      throw new V17RewardError('BAD_ROUND_ID', 'roundId must be a positive integer');
    }
    const pair = validateWalletPair(referrerWallet, refereeWallet);
    const rewardBig = parsePositiveBigInt(refereeRewardRaw, 'refereeRewardRaw');
    const commissionBig = computeStakeReferralCommissionRaw(rewardBig);
    if (commissionBig <= 0n) {
      throw new V17RewardError('BAD_AMOUNT', 'computed 8% commission must be positive');
    }
    if (!promoEngine || typeof promoEngine.creditReward !== 'function') {
      throw new V17RewardError('PROMO_ENGINE_REQUIRED', 'promoEngine is required for D1 stake referral settlement');
    }
    const creditId = buildStakeReferralCreditId(rId, pair.refereeWallet);

    await this.db
      .prepare(
        `INSERT OR IGNORE INTO stake_referral_credits
           (credit_id, round_id, referrer_wallet, referee_wallet, referee_reward_raw, commission_raw, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      )
      .bind(
        creditId,
        rId,
        pair.referrerWallet,
        pair.refereeWallet,
        rewardBig.toString(),
        commissionBig.toString(),
        Number(nowSec),
      )
      .run();

    const row = await this.db
      .prepare('SELECT * FROM stake_referral_credits WHERE credit_id = ? LIMIT 1')
      .bind(creditId)
      .first();
    if (!row) {
      throw new V17RewardError('STORAGE_ERROR', 'failed to persist stake_referral_credits row');
    }
    if (String(row.status) === 'CREDITED') {
      return { ...formatCreditRow(row, { maskReferee: false }), duplicate: true, budgetExhausted: false };
    }

    const effectiveCommission = BigInt(String(row.commission_raw || '0'));
    if (effectiveCommission <= 0n) {
      return { ...formatCreditRow(row, { maskReferee: false }), duplicate: false, budgetExhausted: false };
    }

    // 同库 D1PromoStore 走单事务 db.batch()（零窗口防双发/吞奖/泄漏）
    if (promoEngine.db === this.db) {
      try {
        const out = await this._atomicBatchCredit({
          table: 'stake_referral_credits',
          idCol: 'credit_id',
          idVal: creditId,
          bucketKey: 'stake_referral',
          targetWallet: String(row.referrer_wallet),
          amountBig: effectiveCommission,
          budgetLedger,
          nowSec,
        });
        const latest = await this.db
          .prepare('SELECT * FROM stake_referral_credits WHERE credit_id = ? LIMIT 1')
          .bind(creditId)
          .first();
        return { ...formatCreditRow(latest || { ...row, status: 'CREDITED' }, { maskReferee: false }), duplicate: out.duplicate, budgetExhausted: false };
      } catch (e) {
        if (e instanceof BudgetError && e.code === 'PROMO_BUDGET_EXHAUSTED') {
          return { ...formatCreditRow(row, { maskReferee: false }), duplicate: false, budgetExhausted: true };
        }
        throw e;
      }
    }

    // 外部/测试自定义 promoEngine 降级路径：严格 CAS + 失败原子补偿释放
    let reserved = false;
    if (budgetLedger && typeof budgetLedger.reserve === 'function') {
      try {
        const rsv = await budgetLedger.reserve('stake_referral', effectiveCommission.toString(), nowSec);
        reserved = !rsv?.legacySkipped;
      } catch (e) {
        if (e instanceof BudgetError && e.code === 'PROMO_BUDGET_EXHAUSTED') {
          return { ...formatCreditRow(row, { maskReferee: false }), duplicate: false, budgetExhausted: true };
        }
        throw e;
      }
    }

    const casRes = await this.db
      .prepare("UPDATE stake_referral_credits SET status = 'CREDITED' WHERE credit_id = ? AND status = 'PENDING'")
      .bind(creditId)
      .run();
    if (changes(casRes) !== 1) {
      if (reserved && budgetLedger && typeof budgetLedger.release === 'function') {
        await budgetLedger.release('stake_referral', effectiveCommission.toString(), nowSec);
      }
      const latest = await this.db
        .prepare('SELECT * FROM stake_referral_credits WHERE credit_id = ? LIMIT 1')
        .bind(creditId)
        .first();
      return { ...formatCreditRow(latest || row, { maskReferee: false }), duplicate: true, budgetExhausted: false };
    }

    try {
      await promoEngine.creditReward(String(row.referrer_wallet), effectiveCommission, nowSec);
    } catch (e) {
      await this.db
        .prepare("UPDATE stake_referral_credits SET status = 'PENDING' WHERE credit_id = ? AND status = 'CREDITED'")
        .bind(creditId)
        .run();
      if (reserved && budgetLedger && typeof budgetLedger.release === 'function') {
        await budgetLedger.release('stake_referral', effectiveCommission.toString(), nowSec);
      }
      throw e;
    }

    return { ...formatCreditRow({ ...row, status: 'CREDITED' }, { maskReferee: false }), duplicate: false, budgetExhausted: false };
  }

  async getUserStakeReferrals(walletAddress, { limit = 50 } = {}) {
    const cleanWallet = String(walletAddress || '').trim();
    if (!cleanWallet) {
      return {
        walletAddress: null,
        totalCommissionRaw: '0',
        creditedRaw: '0',
        pendingRaw: '0',
        count: 0,
        items: [],
      };
    }
    const lim = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
    const aliases = Array.from(new Set([cleanWallet, ...addressAliases(cleanWallet), addressKey(cleanWallet)].filter(Boolean)));
    const placeholders = aliases.map(() => '?').join(', ');
    const res = await this.db
      .prepare(
        `SELECT * FROM stake_referral_credits
         WHERE referrer_wallet IN (${placeholders})
         ORDER BY created_at DESC, round_id DESC`,
      )
      .bind(...aliases)
      .all();

    const rows = res?.results || [];
    let totalCommission = 0n;
    let credited = 0n;
    let pending = 0n;
    for (const r of rows) {
      const c = BigInt(String(r.commission_raw || '0'));
      totalCommission += c;
      if (String(r.status) === 'CREDITED') credited += c;
      else pending += c;
    }

    return {
      walletAddress: cleanWallet,
      totalCommissionRaw: totalCommission.toString(),
      creditedRaw: credited.toString(),
      pendingRaw: pending.toString(),
      count: rows.length,
      items: rows.slice(0, lim).map((r) => formatCreditRow(r, { maskReferee: true })),
    };
  }

  async drawRoundAirdrop(
    { roundId, participants, seedHash, prizeRaw = DEFAULT_AIRDROP_PRIZE_RAW, promoEngine = null, budgetLedger = null },
    nowSec = Math.floor(Date.now() / 1000),
  ) {
    const rId = Number(roundId);
    if (!Number.isInteger(rId) || rId < 1) {
      throw new V17RewardError('BAD_ROUND_ID', 'roundId must be a positive integer');
    }
    const prizeBig = parsePositiveBigInt(prizeRaw, 'prizeRaw');
    if (!promoEngine || typeof promoEngine.creditReward !== 'function') {
      throw new V17RewardError('PROMO_ENGINE_REQUIRED', 'promoEngine is required for D1 round airdrop draw');
    }

    let row = await this.db
      .prepare('SELECT * FROM round_jackpot_draws WHERE round_id = ? LIMIT 1')
      .bind(rId)
      .first();

    if (row && String(row.status) === 'CREDITED') {
      return { ...formatDrawRow(row, { maskWinner: false }), duplicate: true, budgetExhausted: false };
    }

    if (!row) {
      const picked = await pickDeterministicAirdropWinner(rId, participants, seedHash);
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO round_jackpot_draws
             (round_id, seed_hash, winner_wallet, prize_raw, status, created_at)
           VALUES (?, ?, ?, ?, 'PENDING', ?)`,
        )
        .bind(rId, String(seedHash).trim(), picked.winnerWallet, prizeBig.toString(), Number(nowSec))
        .run();
      row = await this.db
        .prepare('SELECT * FROM round_jackpot_draws WHERE round_id = ? LIMIT 1')
        .bind(rId)
        .first();
      if (!row) {
        throw new V17RewardError('STORAGE_ERROR', 'failed to persist round_jackpot_draws row');
      }
      if (String(row.status) === 'CREDITED') {
        return { ...formatDrawRow(row, { maskWinner: false }), duplicate: true, budgetExhausted: false };
      }
    } else if (String(row.status) === 'PENDING' && String(row.prize_raw) !== prizeBig.toString()) {
      // 允许管理员在 PENDING（如预算不足后）调低奖金重跑
      await this.db
        .prepare("UPDATE round_jackpot_draws SET prize_raw = ? WHERE round_id = ? AND status = 'PENDING'")
        .bind(prizeBig.toString(), rId)
        .run();
      row = { ...row, prize_raw: prizeBig.toString() };
    }

    const effectivePrize = BigInt(String(row.prize_raw || '0'));

    if (promoEngine.db === this.db) {
      try {
        const out = await this._atomicBatchCredit({
          table: 'round_jackpot_draws',
          idCol: 'round_id',
          idVal: rId,
          bucketKey: 'round_airdrop',
          targetWallet: String(row.winner_wallet),
          amountBig: effectivePrize,
          budgetLedger,
          nowSec,
        });
        const latest = await this.db
          .prepare('SELECT * FROM round_jackpot_draws WHERE round_id = ? LIMIT 1')
          .bind(rId)
          .first();
        return { ...formatDrawRow(latest || { ...row, status: 'CREDITED' }, { maskWinner: false }), duplicate: out.duplicate, budgetExhausted: false };
      } catch (e) {
        if (e instanceof BudgetError && e.code === 'PROMO_BUDGET_EXHAUSTED') {
          return { ...formatDrawRow(row, { maskWinner: false }), duplicate: false, budgetExhausted: true };
        }
        throw e;
      }
    }

    let reserved = false;
    if (budgetLedger && typeof budgetLedger.reserve === 'function') {
      try {
        const rsv = await budgetLedger.reserve('round_airdrop', effectivePrize.toString(), nowSec);
        reserved = !rsv?.legacySkipped;
      } catch (e) {
        if (e instanceof BudgetError && e.code === 'PROMO_BUDGET_EXHAUSTED') {
          return { ...formatDrawRow(row, { maskWinner: false }), duplicate: false, budgetExhausted: true };
        }
        throw e;
      }
    }

    const casRes = await this.db
      .prepare("UPDATE round_jackpot_draws SET status = 'CREDITED' WHERE round_id = ? AND status = 'PENDING'")
      .bind(rId)
      .run();
    if (changes(casRes) !== 1) {
      if (reserved && budgetLedger && typeof budgetLedger.release === 'function') {
        await budgetLedger.release('round_airdrop', effectivePrize.toString(), nowSec);
      }
      const latest = await this.db
        .prepare('SELECT * FROM round_jackpot_draws WHERE round_id = ? LIMIT 1')
        .bind(rId)
        .first();
      return { ...formatDrawRow(latest || row, { maskWinner: false }), duplicate: true, budgetExhausted: false };
    }

    try {
      await promoEngine.creditReward(String(row.winner_wallet), effectivePrize, nowSec);
    } catch (e) {
      await this.db
        .prepare("UPDATE round_jackpot_draws SET status = 'PENDING' WHERE round_id = ? AND status = 'CREDITED'")
        .bind(rId)
        .run();
      if (reserved && budgetLedger && typeof budgetLedger.release === 'function') {
        await budgetLedger.release('round_airdrop', effectivePrize.toString(), nowSec);
      }
      throw e;
    }

    return { ...formatDrawRow({ ...row, status: 'CREDITED' }, { maskWinner: false }), duplicate: false, budgetExhausted: false };
  }

  async listAirdropDraws({ roundId = null, limit = 20, budgetLedger = null } = {}) {
    const lim = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    let rows = [];
    if (roundId !== null && roundId !== undefined && String(roundId).trim() !== '') {
      const rId = Number(roundId);
      const res = await this.db
        .prepare('SELECT * FROM round_jackpot_draws WHERE round_id = ? LIMIT 1')
        .bind(rId)
        .all();
      rows = res?.results || [];
    } else {
      const res = await this.db
        .prepare('SELECT * FROM round_jackpot_draws ORDER BY round_id DESC LIMIT ?')
        .bind(lim)
        .all();
      rows = res?.results || [];
    }
    const bucket = await resolveBucketRemaining(budgetLedger, 'round_airdrop');
    return {
      items: rows.map((r) => formatDrawRow(r, { maskWinner: true })),
      ...bucket,
    };
  }
}
