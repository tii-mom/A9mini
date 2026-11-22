// A9 — TON address parsing / normalisation (zero-dependency, Workers + Node).
// Friendly (base64 / base64url, 48 chars) and raw ("wc:hex64") forms are both accepted.
// normalizeTonAddress() returns the canonical raw form "wc:hex64" (lower-case) or null.

function b64ToBytes(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
}

function crc16(data) {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Parse a TON address. Returns { workchain, hash: Uint8Array(32), bounceable, testOnly } or null. */
export function parseTonAddress(input) {
  const a = String(input || '').trim();
  if (!a) return null;
  const raw = a.match(/^(-?\d{1,3}):([0-9a-fA-F]{64})$/);
  if (raw) {
    const wc = Number(raw[1]);
    if (wc !== 0 && wc !== -1) return null;
    const hash = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) hash[i] = parseInt(raw[2].slice(i * 2, i * 2 + 2), 16);
    return { workchain: wc, hash, bounceable: null, testOnly: null };
  }
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(a)) return null;
  let bytes;
  try {
    bytes = b64ToBytes(a);
  } catch {
    return null;
  }
  if (bytes.length !== 36) return null;
  const expected = (bytes[34] << 8) | bytes[35];
  if (crc16(bytes.subarray(0, 34)) !== expected) return null;
  const tag = bytes[0];
  const testOnly = (tag & 0x80) !== 0;
  const base = tag & 0x7f;
  if (base !== 0x11 && base !== 0x51) return null;
  const wcByte = bytes[1];
  const workchain = wcByte === 0xff ? -1 : wcByte;
  if (workchain !== 0 && workchain !== -1) return null;
  return { workchain, hash: bytes.slice(2, 34), bounceable: base === 0x11, testOnly };
}

/** Canonical "wc:hex64" or null when the input is not a valid TON address. */
export function normalizeTonAddress(input) {
  const p = parseTonAddress(input);
  return p ? `${p.workchain}:${hex(p.hash)}` : null;
}

/**
 * Stable comparison key. Valid TON addresses collapse to their raw form, so friendly
 * bounceable / non-bounceable / raw spellings of one wallet compare equal. Inputs that are not
 * parseable (unit-test placeholders) fall back to the trimmed string.
 */
export function addressKey(input) {
  return normalizeTonAddress(input) || String(input || '').trim();
}

export function sameAddress(a, b) {
  const ka = addressKey(a);
  return Boolean(ka) && ka === addressKey(b);
}
