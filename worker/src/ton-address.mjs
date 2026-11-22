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

function bytesToB64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}

/** 将已解析的 TON 地址编码为标准 48 字符 base64url 友好地址。 */
export function formatTonAddress(workchain, hash, { bounceable = true, testOnly = false } = {}) {
  const out = new Uint8Array(36);
  out[0] = (bounceable ? 0x11 : 0x51) | (testOnly ? 0x80 : 0x00);
  out[1] = workchain === -1 ? 0xff : workchain & 0xff;
  out.set(hash, 2);
  const crc = crc16(out.subarray(0, 34));
  out[34] = (crc >> 8) & 0xff;
  out[35] = crc & 0xff;
  return bytesToB64Url(out);
}

/**
 * 返回同一 TON 地址的所有规范表示（raw + 主网/测试网 bounceable/non-bounceable + 原始输入），
 * 用于兼容尚未回填 wallet_key 的历史记录单语句原子匹配。
 */
export function addressAliases(input) {
  const trimmed = String(input || '').trim();
  const p = parseTonAddress(trimmed);
  if (!p) return trimmed ? [trimmed] : [];
  const raw = `${p.workchain}:${hex(p.hash)}`;
  const forms = [
    raw,
    formatTonAddress(p.workchain, p.hash, { bounceable: true, testOnly: false }),
    formatTonAddress(p.workchain, p.hash, { bounceable: false, testOnly: false }),
    formatTonAddress(p.workchain, p.hash, { bounceable: true, testOnly: true }),
    formatTonAddress(p.workchain, p.hash, { bounceable: false, testOnly: true }),
  ];
  if (trimmed && !forms.includes(trimmed)) forms.push(trimmed);
  return forms;
}

export function sameAddress(a, b) {
  const ka = addressKey(a);
  return Boolean(ka) && ka === addressKey(b);
}
