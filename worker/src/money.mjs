// A9 — exact decimal <-> integer unit conversion. Never use floats for money.
// GRAM (TON-chain native coin) and A9 both use 9 decimals on-chain.

export class MoneyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Parse a non-negative decimal amount ("5.99", 13.99, "200") into integer base units.
 * Rejects exponents, negatives, NaN and more fractional digits than `decimals`.
 */
export function parseDecimalUnits(value, decimals = 9) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new MoneyError('BAD_AMOUNT', 'amount must be non-negative');
    return value * 10n ** BigInt(decimals);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new MoneyError('BAD_AMOUNT', 'amount must be a finite number');
  }
  const s = String(value ?? '').trim();
  const m = s.match(/^(\d{1,15})(?:\.(\d+))?$/);
  if (!m) throw new MoneyError('BAD_AMOUNT', 'amount must be a plain decimal like 5 or 5.99');
  const frac = m[2] || '';
  if (frac.length > decimals) {
    throw new MoneyError('BAD_AMOUNT', `amount supports at most ${decimals} decimal places`);
  }
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Format integer base units as a plain decimal string without trailing zeros ("3983.98"). */
export function formatUnits(raw, decimals = 9) {
  const v = BigInt(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
