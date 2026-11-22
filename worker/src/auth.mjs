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
import { inspectWalletStateInit, inspectCodeBocIdentity, WALLET_TG_TRAMPOLINE_HASH } from './ton-cell.mjs';

/** initData older than this is rejected (seconds). Owner to confirm; see phase-1 report. */
export const INIT_DATA_MAX_AGE_SEC = 24 * 3600;
/** A ton_proof payload must be used within this window (seconds). */
export const TON_PROOF_PAYLOAD_TTL_SEC = 15 * 60;
/** Accepted clock skew between the wallet's proof timestamp and the server (seconds). */
export const TON_PROOF_MAX_SKEW_SEC = 10 * 60;
/** A switch to a DIFFERENT wallet only takes effect after this delay unless cancelled by the
 * currently bound wallet (protects against a replayed/stolen initData). Owner to confirm. */
export const REBIND_DELAY_SEC = 72 * 3600;

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

/** TON Connect CHAIN ids. */
export const TON_CHAIN = Object.freeze({ mainnet: '-239', testnet: '-3' });

export function expectedChainId(env = {}) {
  const net = String(env.A9_NETWORK || '').trim().toLowerCase();
  return TON_CHAIN[net] || null;
}

function proofMessageDigest({ workchain, hash, domain, timestamp, payload }) {
  const domainBytes = enc.encode(domain);
  const wc = new Uint8Array(4);
  new DataView(wc.buffer).setInt32(0, workchain, false); // big-endian
  const dl = new Uint8Array(4);
  new DataView(dl.buffer).setUint32(0, domainBytes.length, true); // little-endian
  const tsb = new Uint8Array(8);
  new DataView(tsb.buffer).setBigUint64(0, BigInt(timestamp), true); // little-endian
  return concatBytes(enc.encode('ton-proof-item-v2/'), wc, hash, dl, domainBytes, tsb, enc.encode(String(payload || '')));
}

/**
 * Low-level ton_proof signature check (ton-proof-item-v2): ed25519 over
 * sha256(0xffff ++ "ton-connect" ++ sha256(message)). Same byte layout as the official
 * reference implementation (ton-connect demo-dapp-with-react-ui ton-proof-service.ts).
 */
export async function verifyTonProofSignature({ address, proof, publicKeyHex, allowedDomains = [], nowSec = Math.floor(Date.now() / 1000), maxSkewSec = TON_PROOF_MAX_SKEW_SEC }) {
  const parsed = parseTonAddress(address);
  if (!parsed) throw new AuthError('PROOF_INVALID', 'wallet address is not a valid TON address', 400);
  if (!proof || typeof proof !== 'object') throw new AuthError('PROOF_INVALID', 'ton_proof missing', 400);
  const domain = String(proof.domain?.value || '');
  if (!domain || Number(proof.domain?.lengthBytes) !== enc.encode(domain).length) {
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
  const message = proofMessageDigest({ workchain: parsed.workchain, hash: parsed.hash, domain, timestamp: ts, payload: proof.payload });
  const full = concatBytes(new Uint8Array([0xff, 0xff]), enc.encode('ton-connect'), await sha256(message));
  const digest = await sha256(full);
  const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
  const ok = await crypto.subtle.verify('Ed25519', key, sig, digest);
  if (!ok) throw new AuthError('PROOF_INVALID', 'ton_proof signature does not match wallet key', 400);
  return true;
}

/**
 * 完整 ton_proof 校验（P0-F 严格公钥信任边界，严格对照 TON 官方 ton-proof 文档）：
 *   1. 网络：account.chain 必须等于服务端 A9_NETWORK；主网拒绝 test-only 地址；
 *   2. StateInit：必须提供 walletStateInit 且其 cell 哈希等于钱包地址哈希；
 *   3. 公钥信任边界：
 *      - 已审核的标准固定公钥钱包（v3r1/v3r2/v4r2/v5beta/v5r1）：通过可信代码哈希识别版本，
 *        从 StateInit data 解析公钥；若可读取链上 get_public_key 则校验二者一致；
 *      - WalletTg（trampoline 代码哈希）：必须校验链上账户已部署且为 active、链上当前代码身份
 *        仍匹配 trampoline 哈希，再通过 get_public_key() 获取当前活跃签名公钥；
 *      - 未审核的非标准合约：默认拒绝（PROOF_UNSUPPORTED_WALLET），绝不因链上存在 get_public_key 而信任；
 *   4. 若上报了 account.publicKey 必须与解析出的公钥一致；校验域名白名单、±maxSkewSec 时间戳与 Ed25519 签名。
 * 一次性服务端挑战载荷须由调用方在进入本函数前先消费。
 */
export async function verifyTonProof({
  address,
  network,
  publicKey = null,
  proof,
  expectedNetwork,
  allowedDomains = [],
  chainPublicKeyResolver = null,
  walletStateResolver = null,
  nowSec = Math.floor(Date.now() / 1000),
  maxSkewSec = TON_PROOF_MAX_SKEW_SEC,
}) {
  const parsed = parseTonAddress(address);
  if (!parsed) throw new AuthError('PROOF_INVALID', 'wallet address is not a valid TON address', 400);
  if (!expectedNetwork) throw new AuthError('AUTH_UNCONFIGURED', 'A9_NETWORK is not configured', 503);
  if (String(network ?? '') !== String(expectedNetwork)) {
    throw new AuthError('PROOF_WRONG_NETWORK', `wallet is on network ${network}, expected ${expectedNetwork}`, 400);
  }
  if (parsed.testOnly === true && expectedNetwork === TON_CHAIN.mainnet) {
    throw new AuthError('PROOF_WRONG_NETWORK', 'test-only address used on mainnet', 400);
  }
  const stateInit = proof?.state_init || proof?.stateInit || null;
  if (!stateInit) throw new AuthError('PROOF_INVALID', 'ton_proof walletStateInit is required', 400);
  let init;
  try {
    init = await inspectWalletStateInit(stateInit);
  } catch (e) {
    throw new AuthError('PROOF_INVALID', `walletStateInit unreadable: ${e.message}`, 400);
  }
  const addrHashHex = Array.from(parsed.hash, (b) => b.toString(16).padStart(2, '0')).join('');
  if (init.addressHashHex !== addrHashHex) throw new AuthError('PROOF_INVALID', 'walletStateInit does not hash to the wallet address', 400);

  // 未审核的非标准合约默认拒绝，严禁仅凭链上 get_public_key 信任未知合约。
  if (init.walletKind === 'unsupported') {
    throw new AuthError('PROOF_UNSUPPORTED_WALLET', 'unsupported or unreviewed wallet contract', 400);
  }

  let publicKeyHex = '';
  let keySource = '';

  if (init.walletKind === 'standard') {
    const initKey = init.publicKeyHex;
    let chainKey = null;
    if (typeof chainPublicKeyResolver === 'function') {
      try {
        chainKey = (await chainPublicKeyResolver(address)) || null;
      } catch {
        chainKey = null; // 未部署的标准钱包链上尚无 get-method，可凭可信 StateInit 校验
      }
    }
    if (chainKey && initKey && chainKey.toLowerCase() !== initKey.toLowerCase()) {
      throw new AuthError('PROOF_INVALID', 'on-chain public key differs from walletStateInit key', 400);
    }
    publicKeyHex = String(initKey || '').toLowerCase();
    keySource = chainKey ? 'chain+state_init' : 'state_init';
  } else if (init.walletKind === 'wallet_tg') {
    // WalletTg（支持密钥轮换）：必须先校验链上账户为 active 且当前代码哈希等于 trampoline，再调 get_public_key()。
    if (typeof walletStateResolver !== 'function' || typeof chainPublicKeyResolver !== 'function') {
      throw new AuthError('WALLET_STATE_UNAVAILABLE', 'on-chain account state and public key resolvers are required for WalletTg', 503);
    }
    let liveState;
    try {
      liveState = await walletStateResolver(address);
    } catch {
      throw new AuthError('WALLET_STATE_UNAVAILABLE', 'failed to query live account state for WalletTg', 400);
    }
    if (!liveState || liveState.state !== 'active') {
      throw new AuthError('PROOF_WALLET_NOT_ACTIVE', 'WalletTg account must be deployed and active on-chain', 400);
    }
    let liveCodeId = null;
    if (liveState.codeId) {
      liveCodeId = String(liveState.codeId).toLowerCase();
    } else if (liveState.codeBoc) {
      try {
        liveCodeId = (await inspectCodeBocIdentity(liveState.codeBoc)).toLowerCase();
      } catch {
        liveCodeId = null;
      }
    }
    if (!liveCodeId || liveCodeId !== WALLET_TG_TRAMPOLINE_HASH) {
      throw new AuthError('PROOF_CODE_MISMATCH', 'live WalletTg code hash does not match trusted trampoline', 400);
    }
    let chainKey = null;
    try {
      chainKey = (await chainPublicKeyResolver(address)) || null;
    } catch {
      chainKey = null;
    }
    if (!chainKey) {
      throw new AuthError('WALLET_PUBKEY_UNAVAILABLE', 'failed to read active public key from WalletTg', 400);
    }
    publicKeyHex = String(chainKey).toLowerCase();
    keySource = 'wallet_tg_chain';
  }

  if (!publicKeyHex) throw new AuthError('WALLET_PUBKEY_UNAVAILABLE', 'wallet public key unavailable', 400);
  if (publicKey && String(publicKey).toLowerCase() !== publicKeyHex) {
    throw new AuthError('PROOF_INVALID', 'reported publicKey does not match wallet key', 400);
  }
  await verifyTonProofSignature({ address, proof, publicKeyHex, allowedDomains, nowSec, maxSkewSec });
  return {
    publicKeyHex,
    keySource,
    walletVersion: init.version,
  };
}

// ---------------------------------------------------------------------------
// Identity stores: single-use ton_proof payloads + Telegram <-> wallet bindings
//
// Binding rules (owner-confirmed): one wallet <-> one Telegram account. Disconnecting the
// wallet in the UI does NOT remove the server binding. Changing the binding needs a fresh
// ton_proof:
//   * first binding                      -> immediate
//   * same wallet again                  -> refresh, clears any pending switch
//   * different wallet ("rebind")        -> PENDING for REBIND_DELAY_SEC, then effective;
//                                           the currently bound wallet can cancel it
//   * unbind / cancel pending switch     -> requires ton_proof from the CURRENT wallet
// Recovery when the old wallet is lost = the delayed rebind.
// ---------------------------------------------------------------------------
function walletBoundElsewhere() {
  return new AuthError('WALLET_BOUND_ELSEWHERE', 'this wallet is already bound to another Telegram account', 409);
}

function viewBinding(b) {
  if (!b) return null;
  return {
    telegramUserId: b.telegramUserId,
    walletAddress: b.walletAddress,
    walletKey: b.walletKey,
    boundAt: b.boundAt,
    pending: b.pendingWalletKey ? { walletAddress: b.pendingWalletAddress, walletKey: b.pendingWalletKey, effectiveAt: b.pendingEffectiveAt } : null,
  };
}

export class MemoryIdentityStore {
  constructor() {
    this.payloads = new Map(); // payload -> { tg, expiresAt, usedAt }
    this.bindings = new Map(); // tg -> binding row
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

  _ownerOf(walletKey) {
    for (const b of this.bindings.values()) if (b.walletKey === walletKey) return b.telegramUserId;
    return null;
  }

  async bindVerifiedWallet(tg, walletAddress, nowSec, { rebindDelaySec = REBIND_DELAY_SEC } = {}) {
    const id = String(tg);
    const key = addressKey(walletAddress);
    const owner = this._ownerOf(key);
    if (owner && owner !== id) throw walletBoundElsewhere();
    const cur = this.bindings.get(id);
    if (!cur) {
      const b = { telegramUserId: id, walletAddress, walletKey: key, boundAt: nowSec, pendingWalletAddress: null, pendingWalletKey: null, pendingEffectiveAt: null };
      this.bindings.set(id, b);
      return { status: 'BOUND', binding: viewBinding(b) };
    }
    if (cur.walletKey === key) {
      Object.assign(cur, { walletAddress, pendingWalletAddress: null, pendingWalletKey: null, pendingEffectiveAt: null });
      return { status: 'UNCHANGED', binding: viewBinding(cur) };
    }
    Object.assign(cur, { pendingWalletAddress: walletAddress, pendingWalletKey: key, pendingEffectiveAt: nowSec + rebindDelaySec });
    return { status: 'PENDING_REBIND', binding: viewBinding(cur) };
  }

  /** Store-level helper (tests / ops tooling). The API only calls it after a verified ton_proof. */
  async bindWallet(tg, walletAddress, nowSec) {
    return (await this.bindVerifiedWallet(tg, walletAddress, nowSec)).binding;
  }

  async getBinding(tg, nowSec = Math.floor(Date.now() / 1000)) {
    const b = this.bindings.get(String(tg));
    if (!b) return null;
    if (b.pendingWalletKey && b.pendingEffectiveAt <= nowSec) {
      const owner = this._ownerOf(b.pendingWalletKey);
      if (!owner || owner === b.telegramUserId) {
        Object.assign(b, { walletAddress: b.pendingWalletAddress, walletKey: b.pendingWalletKey, boundAt: nowSec });
      }
      Object.assign(b, { pendingWalletAddress: null, pendingWalletKey: null, pendingEffectiveAt: null });
    }
    return viewBinding(b);
  }

  async cancelPendingRebind(tg) {
    const b = this.bindings.get(String(tg));
    if (!b || !b.pendingWalletKey) return false;
    Object.assign(b, { pendingWalletAddress: null, pendingWalletKey: null, pendingEffectiveAt: null });
    return true;
  }

  async unbindWallet(tg) {
    return this.bindings.delete(String(tg));
  }
}

function rowToBinding(r) {
  if (!r) return null;
  return {
    telegramUserId: String(r.tg_user_id),
    walletAddress: r.wallet_address,
    walletKey: r.wallet_key,
    boundAt: Number(r.bound_at),
    pendingWalletAddress: r.pending_wallet_address || null,
    pendingWalletKey: r.pending_wallet_key || null,
    pendingEffectiveAt: r.pending_effective_at === null || r.pending_effective_at === undefined ? null : Number(r.pending_effective_at),
  };
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

  /** Single conditional UPDATE: at most one caller can ever consume a payload. */
  async consumeProofPayload(payload, tg, nowSec) {
    const res = await this.db
      .prepare('UPDATE auth_ton_proof_payloads SET used_at = ? WHERE payload = ? AND tg_user_id = ? AND used_at IS NULL AND expires_at >= ?')
      .bind(nowSec, String(payload || ''), String(tg), nowSec)
      .run();
    return Number(res?.meta?.changes || 0) === 1;
  }

  async _row(tg) {
    return rowToBinding(await this.db.prepare('SELECT * FROM wallet_bindings WHERE tg_user_id = ?').bind(String(tg)).first());
  }

  async _ownerOf(walletKey) {
    const r = await this.db.prepare('SELECT tg_user_id FROM wallet_bindings WHERE wallet_key = ?').bind(walletKey).first();
    return r ? String(r.tg_user_id) : null;
  }

  async bindVerifiedWallet(tg, walletAddress, nowSec, { rebindDelaySec = REBIND_DELAY_SEC } = {}) {
    const id = String(tg);
    const key = addressKey(walletAddress);
    const owner = await this._ownerOf(key);
    if (owner && owner !== id) throw walletBoundElsewhere();
    const cur = await this._row(id);
    try {
      if (!cur) {
        await this.db
          .prepare('INSERT INTO wallet_bindings (tg_user_id, wallet_address, wallet_key, bound_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .bind(id, walletAddress, key, nowSec, nowSec)
          .run();
        return { status: 'BOUND', binding: viewBinding(await this._row(id)) };
      }
      if (cur.walletKey === key) {
        await this.db
          .prepare('UPDATE wallet_bindings SET wallet_address = ?, pending_wallet_address = NULL, pending_wallet_key = NULL, pending_effective_at = NULL, updated_at = ? WHERE tg_user_id = ?')
          .bind(walletAddress, nowSec, id)
          .run();
        return { status: 'UNCHANGED', binding: viewBinding(await this._row(id)) };
      }
      await this.db
        .prepare('UPDATE wallet_bindings SET pending_wallet_address = ?, pending_wallet_key = ?, pending_effective_at = ?, updated_at = ? WHERE tg_user_id = ?')
        .bind(walletAddress, key, nowSec + rebindDelaySec, nowSec, id)
        .run();
      return { status: 'PENDING_REBIND', binding: viewBinding(await this._row(id)) };
    } catch (e) {
      if (/UNIQUE/i.test(String(e?.message))) throw walletBoundElsewhere();
      throw e;
    }
  }

  /** Store-level helper (tests / ops tooling). The API only calls it after a verified ton_proof. */
  async bindWallet(tg, walletAddress, nowSec) {
    return (await this.bindVerifiedWallet(tg, walletAddress, nowSec)).binding;
  }

  async getBinding(tg, nowSec = Math.floor(Date.now() / 1000)) {
    const b = await this._row(tg);
    if (!b) return null;
    if (b.pendingWalletKey && b.pendingEffectiveAt <= nowSec) {
      try {
        // wallet_key is UNIQUE: promotion fails (and the pending switch is dropped) if the
        // target wallet was bound to someone else meanwhile.
        await this.db
          .prepare(
            `UPDATE wallet_bindings SET wallet_address = pending_wallet_address, wallet_key = pending_wallet_key, bound_at = ?,
               pending_wallet_address = NULL, pending_wallet_key = NULL, pending_effective_at = NULL, updated_at = ?
             WHERE tg_user_id = ? AND pending_wallet_key IS NOT NULL AND pending_effective_at <= ?`,
          )
          .bind(nowSec, nowSec, String(tg), nowSec)
          .run();
      } catch (e) {
        if (!/UNIQUE/i.test(String(e?.message))) throw e;
        await this.cancelPendingRebind(tg);
      }
      return viewBinding(await this._row(tg));
    }
    return viewBinding(b);
  }

  async cancelPendingRebind(tg) {
    const res = await this.db
      .prepare('UPDATE wallet_bindings SET pending_wallet_address = NULL, pending_wallet_key = NULL, pending_effective_at = NULL WHERE tg_user_id = ? AND pending_wallet_key IS NOT NULL')
      .bind(String(tg))
      .run();
    return Number(res?.meta?.changes || 0) > 0;
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
      const binding = identityStore ? await identityStore.getBinding(id.telegramUserId, nowSec) : null;
      if (!binding) throw new AuthError('WALLET_NOT_VERIFIED', 'connect and verify your wallet first', 403);
      if (claimedWallet && addressKey(claimedWallet) !== binding.walletKey) {
        throw new AuthError('FORBIDDEN', 'this wallet is not bound to your account', 403);
      }
      return { identity: id, binding, walletAddress: binding.walletAddress };
    },
  };
}
