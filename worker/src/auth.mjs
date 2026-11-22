// A9 — server-side identity: Telegram WebApp initData verification, TON Connect ton_proof
// wallet-ownership verification, and the Telegram <-> wallet binding store.
// Uses Web Crypto only, so the same code runs in Cloudflare Workers and Node >= 20.
//
// Rules enforced here (P0-1):
//   * The Telegram user id is taken ONLY from initData whose HMAC verifies with the bot token.
//   * A wallet is only "ours" after a single-use, server-issued ton_proof payload is signed by
//     the wallet's on-chain public key. Client-supplied userId / walletAddress never select
//     the account that is read or mutated.
import { addressKey, parseTonAddress } from './ton-address.mjs';

/** initData older than this is rejected (seconds). Owner to confirm; see phase-1 report. */
export const INIT_DATA_MAX_AGE_SEC = 24 * 3600;
/** A ton_proof payload must be used within this window (seconds). */
export const TON_PROOF_PAYLOAD_TTL_SEC = 15 * 60;
/** Accepted clock skew between the wallet's proof timestamp and the server (seconds). */
export const TON_PROOF_MAX_SKEW_SEC = 15 * 60;

export class AuthError extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const enc = new TextEncoder();

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function concatBytes(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function timingSafeEqualHex(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function b64Decode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(h) {
  const s = String(h || '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export function randomHex(bytes = 32) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

/** Build the data-check-string exactly as Telegram defines it: all fields but `hash`, sorted by key. */
function dataCheckString(params) {
  return [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** Sign initData fields with a bot token (used by tests and local tooling only). */
export async function signTelegramInitData(fields, botToken) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const secret = await hmacSha256(enc.encode('WebAppData'), enc.encode(botToken));
  params.set('hash', toHex(await hmacSha256(secret, enc.encode(dataCheckString(params)))));
  return params.toString();
}

/** Verify raw Telegram WebApp initData. Returns a verified Telegram identity or throws AuthError. */
export async function verifyTelegramInitData(initData, botToken, { nowSec = Math.floor(Date.now() / 1000), maxAgeSec = INIT_DATA_MAX_AGE_SEC } = {}) {
  if (!botToken) throw new AuthError('AUTH_UNCONFIGURED', 'server Telegram bot token is not configured', 503);
  const raw = String(initData || '').trim();
  if (!raw) throw new AuthError('AUTH_REQUIRED', 'Telegram initData is required');
  let params;
  try {
    params = new URLSearchParams(raw);
  } catch {
    throw new AuthError('AUTH_INVALID', 'malformed initData');
  }
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-fA-F]{64}$/.test(hash)) throw new AuthError('AUTH_INVALID', 'initData hash missing');
  const secret = await hmacSha256(enc.encode('WebAppData'), enc.encode(botToken));
  const expected = toHex(await hmacSha256(secret, enc.encode(dataCheckString(params))));
  if (!timingSafeEqualHex(expected, hash)) throw new AuthError('AUTH_INVALID', 'initData signature mismatch');

  const authDate = Number(params.get('auth_date'));
  if (!Number.isInteger(authDate) || authDate <= 0) throw new AuthError('AUTH_INVALID', 'initData auth_date missing');
  if (authDate > nowSec + 60) throw new AuthError('AUTH_INVALID', 'initData auth_date is in the future');
  if (nowSec - authDate > maxAgeSec) throw new AuthError('AUTH_EXPIRED', 'initData has expired, reopen the Mini App');

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    user = null;
  }
  const id = Number(user?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AuthError('AUTH_INVALID', 'initData user missing');
  return {
    kind: 'telegram',
    telegramUserId: String(id),
    user: {
      id: String(id),
      username: user.username || null,
      firstName: user.first_name || null,
      languageCode: user.language_code || null,
    },
    authDate,
    startParam: params.get('start_param') || null,
  };
}

/** Extract raw initData from request headers: `Authorization: tma <initData>` or `x-telegram-init-data`. */
export function extractInitData(headers = {}) {
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    const val = Array.isArray(v) ? v[0] : v;
    if (typeof val !== 'string') continue;
    if (lk === 'authorization' && val.toLowerCase().startsWith('tma ')) return val.slice(4).trim();
    if (lk === 'x-telegram-init-data' && val) return val.trim();
  }
  return '';
}

/**
 * Verify a TON Connect `ton_proof` (ton-proof-item-v2) against a known wallet public key.
 * See https://docs.ton.org/develop/dapps/ton-connect/sign — signature is ed25519 over
 * sha256(0xffff ++ "ton-connect" ++ sha256(message)).
 */
export async function verifyTonProofSignature({ address, proof, publicKeyHex, allowedDomains = [], nowSec = Math.floor(Date.now() / 1000), maxSkewSec = TON_PROOF_MAX_SKEW_SEC }) {
  const parsed = parseTonAddress(address);
  if (!parsed) throw new AuthError('PROOF_INVALID', 'wallet address is not a valid TON address', 400);
  if (!proof || typeof proof !== 'object') throw new AuthError('PROOF_INVALID', 'ton_proof missing', 400);
  const domain = String(proof.domain?.value || '');
  const domainBytes = enc.encode(domain);
  if (!domain || Number(proof.domain?.lengthBytes) !== domainBytes.length) {
    throw new AuthError('PROOF_INVALID', 'ton_proof domain malformed', 400);
  }
  const allowed = allowedDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) throw new AuthError('AUTH_UNCONFIGURED', 'ton_proof allowed domains are not configured', 503);
  if (!allowed.includes(domain.toLowerCase())) throw new AuthError('PROOF_INVALID', 'ton_proof domain not allowed', 400);
  const ts = Number(proof.timestamp);
  if (!Number.isSafeInteger(ts) || Math.abs(nowSec - ts) > maxSkewSec) {
    throw new AuthError('PROOF_EXPIRED', 'ton_proof timestamp outside accepted window', 400);
  }
  const pub = hexToBytes(publicKeyHex);
  if (!pub || pub.length !== 32) throw new AuthError('PROOF_INVALID', 'wallet public key unavailable', 400);
  let sig;
  try {
    sig = b64Decode(proof.signature);
  } catch {
    sig = null;
  }
  if (!sig || sig.length !== 64) throw new AuthError('PROOF_INVALID', 'ton_proof signature malformed', 400);

  const wc = new Uint8Array(4);
  new DataView(wc.buffer).setInt32(0, parsed.workchain, false);
  const dl = new Uint8Array(4);
  new DataView(dl.buffer).setUint32(0, domainBytes.length, true);
  const tsb = new Uint8Array(8);
  new DataView(tsb.buffer).setBigUint64(0, BigInt(ts), true);
  const message = concatBytes(enc.encode('ton-proof-item-v2/'), wc, parsed.hash, dl, domainBytes, tsb, enc.encode(String(proof.payload || '')));
  const full = concatBytes(new Uint8Array([0xff, 0xff]), enc.encode('ton-connect'), await sha256(message));
  const digest = await sha256(full);
  const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
  const ok = await crypto.subtle.verify('Ed25519', key, sig, digest);
  if (!ok) throw new AuthError('PROOF_INVALID', 'ton_proof signature does not match wallet key', 400);
  return true;
}

// ---------------------------------------------------------------------------
// Identity stores: single-use ton_proof payloads + Telegram <-> wallet bindings
// ---------------------------------------------------------------------------
function formatBinding(tg, walletAddress, walletKey, boundAt) {
  return { telegramUserId: tg, walletAddress, walletKey, boundAt };
}

export class MemoryIdentityStore {
  constructor() {
    this.payloads = new Map(); // payload -> { tg, expiresAt, usedAt }
    this.bindings = new Map(); // tg -> binding
  }

  async issueProofPayload(tg, nowSec, ttlSec = TON_PROOF_PAYLOAD_TTL_SEC) {
    const payload = randomHex(32);
    this.payloads.set(payload, { tg: String(tg), expiresAt: nowSec + ttlSec, usedAt: null });
    return { payload, expiresAt: nowSec + ttlSec };
  }

  async consumeProofPayload(payload, tg, nowSec) {
    const p = this.payloads.get(String(payload || ''));
    if (!p || p.tg !== String(tg) || p.usedAt !== null || p.expiresAt < nowSec) return false;
    p.usedAt = nowSec;
    return true;
  }

  async bindWallet(tg, walletAddress, nowSec) {
    const key = addressKey(walletAddress);
    for (const b of this.bindings.values()) {
      if (b.walletKey === key && b.telegramUserId !== String(tg)) {
        throw new AuthError('WALLET_BOUND_ELSEWHERE', 'this wallet is already bound to another Telegram account', 409);
      }
    }
    const b = formatBinding(String(tg), walletAddress, key, nowSec);
    this.bindings.set(String(tg), b);
    return b;
  }

  async getBinding(tg) {
    return this.bindings.get(String(tg)) || null;
  }

  async unbindWallet(tg) {
    return this.bindings.delete(String(tg));
  }
}

export class D1IdentityStore {
  constructor({ db }) {
    if (!db) throw new Error('D1 binding required');
    this.db = db;
  }

  async issueProofPayload(tg, nowSec, ttlSec = TON_PROOF_PAYLOAD_TTL_SEC) {
    const payload = randomHex(32);
    await this.db
      .prepare('INSERT INTO auth_ton_proof_payloads (payload, tg_user_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)')
      .bind(payload, String(tg), nowSec + ttlSec, nowSec)
      .run();
    return { payload, expiresAt: nowSec + ttlSec };
  }

  async consumeProofPayload(payload, tg, nowSec) {
    const res = await this.db
      .prepare('UPDATE auth_ton_proof_payloads SET used_at = ? WHERE payload = ? AND tg_user_id = ? AND used_at IS NULL AND expires_at >= ?')
      .bind(nowSec, String(payload || ''), String(tg), nowSec)
      .run();
    return Number(res?.meta?.changes || 0) === 1;
  }

  async bindWallet(tg, walletAddress, nowSec) {
    const key = addressKey(walletAddress);
    const other = await this.db
      .prepare('SELECT tg_user_id FROM wallet_bindings WHERE wallet_key = ? AND tg_user_id <> ?')
      .bind(key, String(tg))
      .first();
    if (other) throw new AuthError('WALLET_BOUND_ELSEWHERE', 'this wallet is already bound to another Telegram account', 409);
    try {
      await this.db
        .prepare(
          `INSERT INTO wallet_bindings (tg_user_id, wallet_address, wallet_key, bound_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(tg_user_id) DO UPDATE SET
             wallet_address = excluded.wallet_address,
             wallet_key = excluded.wallet_key,
             bound_at = excluded.bound_at,
             updated_at = excluded.updated_at`,
        )
        .bind(String(tg), walletAddress, key, nowSec, nowSec)
        .run();
    } catch (e) {
      if (/UNIQUE/i.test(String(e?.message))) {
        throw new AuthError('WALLET_BOUND_ELSEWHERE', 'this wallet is already bound to another Telegram account', 409);
      }
      throw e;
    }
    return formatBinding(String(tg), walletAddress, key, nowSec);
  }

  async getBinding(tg) {
    const r = await this.db
      .prepare('SELECT tg_user_id, wallet_address, wallet_key, bound_at FROM wallet_bindings WHERE tg_user_id = ?')
      .bind(String(tg))
      .first();
    return r ? formatBinding(String(r.tg_user_id), r.wallet_address, r.wallet_key, Number(r.bound_at)) : null;
  }

  async unbindWallet(tg) {
    const res = await this.db.prepare('DELETE FROM wallet_bindings WHERE tg_user_id = ?').bind(String(tg)).run();
    return Number(res?.meta?.changes || 0) > 0;
  }
}

/** Comma-separated A9_TON_PROOF_DOMAINS, falling back to the host of A9_PUBLIC_ORIGIN. */
export function allowedProofDomains(env = {}) {
  const list = String(env.A9_TON_PROOF_DOMAINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  try {
    return env.A9_PUBLIC_ORIGIN ? [new URL(env.A9_PUBLIC_ORIGIN).host] : [];
  } catch {
    return [];
  }
}

/**
 * Per-request auth context. Lazily verifies initData once; helpers throw AuthError so the router
 * maps them to 401/403/503 without leaking account existence.
 */
export function createRequestAuth({ env = {}, headers = {}, identityStore, nowSec }) {
  let cached;
  const botToken = env.A9_BOT_TOKEN || '';
  return {
    async telegram() {
      if (cached === undefined) {
        cached = null;
        const initData = extractInitData(headers);
        if (!initData) throw new AuthError('AUTH_REQUIRED', 'open inside Telegram to use this feature');
        cached = await verifyTelegramInitData(initData, botToken, { nowSec });
      }
      if (!cached) throw new AuthError('AUTH_REQUIRED', 'open inside Telegram to use this feature');
      return cached;
    },
    async optionalTelegram() {
      if (!extractInitData(headers)) return null;
      try {
        return await this.telegram();
      } catch {
        return null;
      }
    },
    /** Verified identity + server-bound wallet. If `claimedWallet` is given it must match the binding. */
    async wallet(claimedWallet = null) {
      const id = await this.telegram();
      const binding = identityStore ? await identityStore.getBinding(id.telegramUserId) : null;
      if (!binding) throw new AuthError('WALLET_NOT_VERIFIED', 'connect and verify your wallet first', 403);
      if (claimedWallet && addressKey(claimedWallet) !== binding.walletKey) {
        throw new AuthError('FORBIDDEN', 'this wallet is not bound to your account', 403);
      }
      return { identity: id, binding, walletAddress: binding.walletAddress };
    },
  };
}
