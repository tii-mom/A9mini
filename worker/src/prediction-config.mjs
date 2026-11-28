// A9 Protocol v17 — Unified Prediction Pool & First-Loss Config Resolver.
// Shared single source of truth across Cloudflare Worker fetch, Cron scheduled,
// Payout Daemon, local Node server, and Admin settle override validation.

import { PROMO_BUDGET_BUCKETS } from './promo-budget.mjs';

export const DEFAULT_PREDICTION_POOL_A9_RAW = 1_000_000_000_000_000n; // 1,000,000 A9
export const DEFAULT_PRED_FIRST_LOSS_BONUS_RAW = 500_000_000_000n;    // 500 A9 (0 = disabled)
export const DEFAULT_PRED_FIRST_LOSS_CAP_RAW = 200_000_000_000_000n;  // 200,000 A9 / round (0 = disabled)
export const PREDICTION_BUCKET_CAP_RAW = BigInt(PROMO_BUDGET_BUCKETS.prediction); // 100,000,000 A9

export class PredictionConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isAbsent(val) {
  return val === undefined || val === null || (typeof val === 'string' && val.trim() === '');
}

/**
 * Strictly parse a minimal-unit integer string (no decimals, signs, scientific notation, or non-digits).
 * Distinguishes absent (returns defaultVal) from invalid (throws PredictionConfigError).
 */
function parseStrictUintString(raw, name, defaultVal, { allowZero = false, maxVal = PREDICTION_BUCKET_CAP_RAW } = {}) {
  if (isAbsent(raw)) return defaultVal;
  if (typeof raw !== 'string' && typeof raw !== 'bigint') {
    throw new PredictionConfigError(
      'BAD_PREDICTION_CONFIG',
      `${name} must be a base-10 integer minimal-unit string`,
    );
  }
  const str = typeof raw === 'bigint' ? raw.toString() : raw.trim();
  const pattern = allowZero ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (!pattern.test(str)) {
    throw new PredictionConfigError(
      'BAD_PREDICTION_CONFIG',
      `${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer minimal-unit string (got "${str}")`,
    );
  }
  const n = BigInt(str);
  if (maxVal !== null && maxVal !== undefined && n > maxVal) {
    throw new PredictionConfigError(
      'BAD_PREDICTION_CONFIG',
      `${name} (${str}) exceeds allowed ceiling (${maxVal.toString()})`,
    );
  }
  return n;
}

/**
 * Resolve prediction pool and first-loss parameters from environment variables.
 * - A9_PREDICTION_POOL_A9_RAW defaults to 1,000,000 A9 (1000000000000000 raw).
 * - A9_PRED_FIRST_LOSS_BONUS_RAW defaults to 500 A9 (0 disables first-loss bonus).
 * - A9_PRED_FIRST_LOSS_CAP_RAW defaults to 200,000 A9 / round (0 disables cap payouts).
 */
export function resolvePredictionConfig(env = {}) {
  const defaultPoolA9Raw = parseStrictUintString(
    env?.A9_PREDICTION_POOL_A9_RAW,
    'A9_PREDICTION_POOL_A9_RAW',
    DEFAULT_PREDICTION_POOL_A9_RAW,
    { allowZero: false, maxVal: PREDICTION_BUCKET_CAP_RAW },
  );
  const firstLossBonusRaw = parseStrictUintString(
    env?.A9_PRED_FIRST_LOSS_BONUS_RAW,
    'A9_PRED_FIRST_LOSS_BONUS_RAW',
    DEFAULT_PRED_FIRST_LOSS_BONUS_RAW,
    { allowZero: true, maxVal: PREDICTION_BUCKET_CAP_RAW },
  );
  const firstLossCapRaw = parseStrictUintString(
    env?.A9_PRED_FIRST_LOSS_CAP_RAW,
    'A9_PRED_FIRST_LOSS_CAP_RAW',
    DEFAULT_PRED_FIRST_LOSS_CAP_RAW,
    { allowZero: true, maxVal: PREDICTION_BUCKET_CAP_RAW },
  );
  return {
    defaultPoolA9Raw,
    defaultPoolA9RawStr: defaultPoolA9Raw.toString(),
    firstLossBonusRaw,
    firstLossCapRaw,
  };
}

/**
 * Validate admin settle override `poolA9Raw`.
 * - Absent -> falls back to the environment's approved single-round ceiling (`approvedRoundPoolCapRaw`).
 * - Present -> must be a positive base-10 integer minimal-unit string AND <= `approvedRoundPoolCapRaw`.
 *   Never allows using the 100,000,000 A9 lifecycle bucket cap as a single-round override ceiling.
 */
export function validateAdminPredictionPoolOverride(rawOverride, approvedRoundPoolCapRaw) {
  const cap = BigInt(String(approvedRoundPoolCapRaw ?? DEFAULT_PREDICTION_POOL_A9_RAW));
  if (cap <= 0n) {
    throw new PredictionConfigError('BAD_PREDICTION_CONFIG', 'approvedRoundPoolCapRaw must be positive');
  }
  if (rawOverride === undefined || rawOverride === null) {
    return cap.toString();
  }
  if (typeof rawOverride !== 'string') {
    throw new PredictionConfigError(
      'BAD_REQUEST',
      'poolA9Raw must be a positive integer minimal-unit string',
    );
  }
  const str = rawOverride.trim();
  if (!/^[1-9]\d*$/.test(str)) {
    throw new PredictionConfigError(
      'BAD_REQUEST',
      'poolA9Raw must be a positive integer minimal-unit string (no decimals, signs, or zero)',
    );
  }
  const val = BigInt(str);
  if (val > cap) {
    throw new PredictionConfigError(
      'BAD_REQUEST',
      `poolA9Raw (${str}) exceeds approved single-round pool cap (${cap.toString()})`,
    );
  }
  return val.toString();
}
