// A9 Protocol v17.0 — Global Off-Chain Promo Budget Ledger (6 Buckets: 300M Legacy + 250M v17 Referral/Airdrop).
// Enforces BigInt decimal string + CAS atomic deduction across 6 independent buckets
// for both in-memory engines and Cloudflare D1 databases.

export const A9_RAW = 1_000_000_000n;

export const PROMO_BUDGET_BUCKETS = Object.freeze({
  presale_promo: (48_000_000n * A9_RAW).toString(),       // 48,000,000 A9 (6% referral + shop boost)
  free_chest_captain: (100_000_000n * A9_RAW).toString(), // 100,000,000 A9 (free chests + captain founding)
  prediction: (100_000_000n * A9_RAW).toString(),         // 100,000,000 A9 (12H prediction + first-loss)
  warmup: (52_000_000n * A9_RAW).toString(),              // 52,000,000 A9 (warmup round chests)
  stake_referral: (200_000_000n * A9_RAW).toString(),     // 200,000,000 A9 (v17 8% pass-round stake referral)
  round_airdrop: (50_000_000n * A9_RAW).toString(),       // 50,000,000 A9 (v17 per-round equal airdrop raffle)
});

const changes = (r) => Number(r?.meta?.changes ?? r?.changes ?? 0);
const isMissingTableErr = (e) => /no such table/i.test(String(e?.message || e));

export class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class MemoryPromoBudgetLedger {
  constructor({ caps = PROMO_BUDGET_BUCKETS } = {}) {
    this.buckets = new Map();
    for (const [k, cap] of Object.entries(caps || PROMO_BUDGET_BUCKETS)) {
      this.buckets.set(String(k), {
        bucketKey: String(k),
        capRaw: BigInt(String(cap)),
        spentRaw: 0n,
        updatedAt: 0,
      });
    }
  }

  async getBucket(bucketKey) {
    const b = this.buckets.get(String(bucketKey));
    if (!b) throw new BudgetError('BAD_BUDGET_BUCKET', `unknown promo budget bucket: ${bucketKey}`);
    const remaining = b.capRaw > b.spentRaw ? b.capRaw - b.spentRaw : 0n;
    return {
      bucketKey: b.bucketKey,
      capRaw: b.capRaw.toString(),
      spentRaw: b.spentRaw.toString(),
      remainingRaw: remaining.toString(),
      updatedAt: b.updatedAt,
    };
  }

  async listBuckets() {
    const out = [];
    for (const k of this.buckets.keys()) out.push(await this.getBucket(k));
    return out;
  }

  async setBucketCap(bucketKey, capRaw, nowSec = Math.floor(Date.now() / 1000)) {
    const key = String(bucketKey);
    const cap = BigInt(String(capRaw));
    if (cap < 0n) throw new BudgetError('BAD_AMOUNT', 'capRaw cannot be negative');
    const cur = this.buckets.get(key) || { bucketKey: key, capRaw: cap, spentRaw: 0n, updatedAt: nowSec };
    cur.capRaw = cap;
    cur.updatedAt = nowSec;
    this.buckets.set(key, cur);
    return this.getBucket(key);
  }

  async reserve(bucketKey, deltaRaw, nowSec = Math.floor(Date.now() / 1000)) {
    const delta = BigInt(String(deltaRaw || '0'));
    if (delta <= 0n) return { bucketKey: String(bucketKey), reservedRaw: '0' };
    const b = this.buckets.get(String(bucketKey));
    if (!b) throw new BudgetError('BAD_BUDGET_BUCKET', `unknown promo budget bucket: ${bucketKey}`);
    if (b.spentRaw + delta > b.capRaw) {
      throw new BudgetError(
        'PROMO_BUDGET_EXHAUSTED',
        `推广子池 ${b.bucketKey} 预算已耗尽，已触发熔断保护`,
      );
    }
    b.spentRaw += delta;
    b.updatedAt = nowSec;
    return {
      bucketKey: b.bucketKey,
      reservedRaw: delta.toString(),
      spentRaw: b.spentRaw.toString(),
      remainingRaw: (b.capRaw - b.spentRaw).toString(),
    };
  }

  async release(bucketKey, deltaRaw, nowSec = Math.floor(Date.now() / 1000)) {
    const delta = BigInt(String(deltaRaw || '0'));
    if (delta <= 0n) return { bucketKey: String(bucketKey), releasedRaw: '0' };
    const b = this.buckets.get(String(bucketKey));
    if (!b) throw new BudgetError('BAD_BUDGET_BUCKET', `unknown promo budget bucket: ${bucketKey}`);
    const released = b.spentRaw >= delta ? delta : b.spentRaw;
    b.spentRaw -= released;
    b.updatedAt = nowSec;
    return {
      bucketKey: b.bucketKey,
      releasedRaw: released.toString(),
      spentRaw: b.spentRaw.toString(),
      remainingRaw: (b.capRaw - b.spentRaw).toString(),
    };
  }
}

export class D1PromoBudgetLedger {
  constructor({ db, caps = PROMO_BUDGET_BUCKETS }) {
    if (!db) throw new Error('Cloudflare D1 binding (env.DB) is required');
    this.db = db;
    this.caps = { ...PROMO_BUDGET_BUCKETS, ...(caps || {}) };
  }

  async _ensureRow(bucketKey, nowSec = 0) {
    const key = String(bucketKey);
    const defaultCap = this.caps[key];
    if (defaultCap === undefined) {
      throw new BudgetError('BAD_BUDGET_BUCKET', `unknown promo budget bucket: ${key}`);
    }
    try {
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO promo_budget_ledger (bucket_key, cap_raw, spent_raw, updated_at)
           VALUES (?, ?, '0', ?)`,
        )
        .bind(key, String(defaultCap), nowSec)
        .run();
      return await this.db
        .prepare('SELECT bucket_key, cap_raw, spent_raw, updated_at FROM promo_budget_ledger WHERE bucket_key = ? LIMIT 1')
        .bind(key)
        .first();
    } catch (e) {
      if (isMissingTableErr(e)) return null;
      throw e;
    }
  }

  async getBucket(bucketKey) {
    const row = await this._ensureRow(bucketKey);
    if (!row) return null;
    const cap = BigInt(String(row.cap_raw || '0'));
    const spent = BigInt(String(row.spent_raw || '0'));
    const remaining = cap > spent ? cap - spent : 0n;
    return {
      bucketKey: String(row.bucket_key),
      capRaw: cap.toString(),
      spentRaw: spent.toString(),
      remainingRaw: remaining.toString(),
      updatedAt: Number(row.updated_at || 0),
    };
  }

  async listBuckets() {
    const out = [];
    for (const key of Object.keys(this.caps)) {
      const b = await this.getBucket(key);
      if (b) out.push(b);
    }
    return out;
  }

  async setBucketCap(bucketKey, capRaw, nowSec = Math.floor(Date.now() / 1000)) {
    const key = String(bucketKey);
    const cap = BigInt(String(capRaw));
    if (cap < 0n) throw new BudgetError('BAD_AMOUNT', 'capRaw cannot be negative');
    await this._ensureRow(key, nowSec);
    await this.db
      .prepare('UPDATE promo_budget_ledger SET cap_raw = ?, updated_at = ? WHERE bucket_key = ?')
      .bind(cap.toString(), nowSec, key)
      .run();
    return this.getBucket(key);
  }

  /**
   * Prepare CAS guard SQL and UPDATE statement to embed inside a caller's atomic db.batch().
   * Returns null only when delta <= 0 or legacy DB lacks promo_budget_ledger table.
   * Throws BudgetError('PROMO_BUDGET_EXHAUSTED') immediately if current spent + delta > cap.
   */
  async prepareAtomicReserve(bucketKey, deltaRaw, nowSec = Math.floor(Date.now() / 1000), { extraReservedRaw = 0n } = {}) {
    const delta = BigInt(String(deltaRaw || '0'));
    if (delta <= 0n) return null;
    const row = await this._ensureRow(bucketKey, nowSec);
    if (!row) return null; // legacy DB without migration 0012
    const cap = BigInt(String(row.cap_raw || '0'));
    const curSpent = BigInt(String(row.spent_raw || '0'));
    const extraReserved = BigInt(String(extraReservedRaw || '0'));
    const nextSpent = curSpent + delta;
    if (nextSpent + extraReserved > cap) {
      throw new BudgetError(
        'PROMO_BUDGET_EXHAUSTED',
        `推广子池 ${bucketKey} 预算已耗尽，已触发熔断保护`,
      );
    }
    const curSpentStr = curSpent.toString();
    const nextSpentStr = nextSpent.toString();
    const key = String(bucketKey);
    return {
      bucketKey: key,
      curSpentStr,
      nextSpentStr,
      guardSql: ' AND EXISTS (SELECT 1 FROM promo_budget_ledger WHERE bucket_key = ? AND spent_raw = ?)',
      guardArgs: [key, curSpentStr],
      buildUpdateStmt: (extraCondSql = '', extraArgs = []) =>
        this.db
          .prepare(
            `UPDATE promo_budget_ledger
             SET spent_raw = ?, updated_at = ?
             WHERE bucket_key = ? AND spent_raw = ?${extraCondSql}`,
          )
          .bind(nextSpentStr, nowSec, key, curSpentStr, ...extraArgs),
      /** Strict NOT NULL CAS update that forces a full db.batch() rollback on 0-row/concurrent mismatch. */
      buildStrictUpdateStmt: (extraCondSql = '', extraArgs = []) =>
        this.db
          .prepare(
            `UPDATE promo_budget_ledger
             SET spent_raw = CASE
                   WHEN spent_raw = ?${extraCondSql} THEN ?
                   ELSE NULL
                 END,
                 updated_at = ?
             WHERE bucket_key = ?`,
          )
          .bind(curSpentStr, ...extraArgs, nextSpentStr, nowSec, key),
    };
  }

  /**
   * Prepare atomic CAS release statement to embed inside a caller's db.batch().
   * Forces a full batch rollback via NOT NULL constraint if spent_raw changed concurrently.
   */
  async prepareAtomicRelease(bucketKey, deltaRaw, nowSec = Math.floor(Date.now() / 1000)) {
    const delta = BigInt(String(deltaRaw || '0'));
    if (delta <= 0n) return null;
    const row = await this._ensureRow(bucketKey, nowSec);
    if (!row) return null;
    const curSpent = BigInt(String(row.spent_raw || '0'));
    const released = curSpent >= delta ? delta : curSpent;
    const nextSpent = curSpent - released;
    const curSpentStr = curSpent.toString();
    const nextSpentStr = nextSpent.toString();
    const key = String(bucketKey);
    return {
      bucketKey: key,
      curSpentStr,
      nextSpentStr,
      releasedRaw: released.toString(),
      guardSql: ' AND EXISTS (SELECT 1 FROM promo_budget_ledger WHERE bucket_key = ? AND spent_raw = ?)',
      guardArgs: [key, curSpentStr],
      buildStrictUpdateStmt: (extraCondSql = '', extraArgs = []) =>
        this.db
          .prepare(
            `UPDATE promo_budget_ledger
             SET spent_raw = CASE
                   WHEN spent_raw = ?${extraCondSql} THEN ?
                   ELSE NULL
                 END,
                 updated_at = ?
             WHERE bucket_key = ?`,
          )
          .bind(curSpentStr, ...extraArgs, nextSpentStr, nowSec, key),
    };
  }

  /** Standalone atomic CAS reservation for single-bucket deductions (e.g. referral credits / prediction settle). */
  async reserve(bucketKey, deltaRaw, nowSec = Math.floor(Date.now() / 1000)) {
    const delta = BigInt(String(deltaRaw || '0'));
    if (delta <= 0n) return { bucketKey: String(bucketKey), reservedRaw: '0' };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const prep = await this.prepareAtomicReserve(bucketKey, delta, nowSec);
      if (!prep) return { bucketKey: String(bucketKey), reservedRaw: '0', legacySkipped: true };
      const res = await prep.buildUpdateStmt().run();
      if (changes(res) === 1) {
        return {
          bucketKey: prep.bucketKey,
          reservedRaw: delta.toString(),
          spentRaw: prep.nextSpentStr,
        };
      }
    }
    throw new BudgetError('BUDGET_CONFLICT', '推广预算池并发扣减冲突，请重试');
  }

  /** Standalone atomic CAS compensating release when an upstream payout CAS loses or fails. */
  async release(bucketKey, deltaRaw, nowSec = Math.floor(Date.now() / 1000)) {
    const delta = BigInt(String(deltaRaw || '0'));
    const key = String(bucketKey);
    if (delta <= 0n) return { bucketKey: key, releasedRaw: '0' };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const row = await this._ensureRow(key, nowSec);
      if (!row) return { bucketKey: key, releasedRaw: '0', legacySkipped: true };
      const curSpent = BigInt(String(row.spent_raw || '0'));
      const released = curSpent >= delta ? delta : curSpent;
      const nextSpent = curSpent - released;
      const res = await this.db
        .prepare(
          `UPDATE promo_budget_ledger
           SET spent_raw = ?, updated_at = ?
           WHERE bucket_key = ? AND spent_raw = ?`,
        )
        .bind(nextSpent.toString(), nowSec, key, curSpent.toString())
        .run();
      if (changes(res) === 1) {
        return {
          bucketKey: key,
          releasedRaw: released.toString(),
          spentRaw: nextSpent.toString(),
        };
      }
    }
    throw new BudgetError('BUDGET_CONFLICT', '推广预算池并发归还冲突，请重试');
  }
}
