// A9 — minimal TON cell / BoC toolkit (zero dependencies; Workers + Node).
// Scope: ordinary + level-0 exotic (library) cells, which is everything a wallet StateInit
// contains. Used to verify TON Connect ton_proof StateInit -> address and to read wallet
// public keys, matching the official reference
// (ton-connect/demo-dapp-with-react-ui src/server/services/ton-proof-service.ts).

export class CellError extends Error {
  constructor(message) {
    super(message);
    this.code = 'BAD_CELL';
  }
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function b64ToBytes(s) {
  const str = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(str + '='.repeat((4 - (str.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** A cell: `bits` significant bits stored in `data` (byte-padded with completion tag). */
export class Cell {
  constructor({ bits, data, refs = [], exotic = false }) {
    if (bits < 0 || bits > 1023) throw new CellError('cell bit length out of range');
    if (refs.length > 4) throw new CellError('too many refs');
    this.bits = bits;
    this.data = data; // Uint8Array of ceil(bits/8) bytes, completion tag already applied
    this.refs = refs;
    this.exotic = exotic;
    this._hash = null;
    this._depth = null;
  }

  depth() {
    if (this._depth === null) this._depth = this.refs.length ? Math.max(...this.refs.map((r) => r.depth())) + 1 : 0;
    return this._depth;
  }

  descriptors() {
    const d1 = this.refs.length + (this.exotic ? 8 : 0); // level 0 only
    const d2 = Math.floor(this.bits / 8) + Math.ceil(this.bits / 8);
    return [d1, d2];
  }

  /** Representation hash (TVM whitepaper §3.1.5) as Uint8Array(32). */
  async hash() {
    if (this._hash) return this._hash;
    if (this.exotic) {
      // Only library cells (type 2) are level 0 and allowed here.
      if (this.bits !== 8 + 256 || this.data[0] !== 2) throw new CellError('unsupported exotic cell');
    }
    const [d1, d2] = this.descriptors();
    const parts = [new Uint8Array([d1, d2]), this.data];
    for (const r of this.refs) {
      const d = r.depth();
      parts.push(new Uint8Array([(d >> 8) & 0xff, d & 0xff]));
    }
    for (const r of this.refs) parts.push(await r.hash());
    const len = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    this._hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return this._hash;
  }

  async hashHex() {
    return hex(await this.hash());
  }

  /** Read `n` bits starting at bit offset `pos` as BigInt. */
  readBits(pos, n) {
    if (pos + n > this.bits) throw new CellError('read past end of cell');
    let v = 0n;
    for (let i = 0; i < n; i += 1) {
      const bit = (this.data[(pos + i) >> 3] >> (7 - ((pos + i) & 7))) & 1;
      v = (v << 1n) | BigInt(bit);
    }
    return v;
  }
}

/** Build a cell from a bit string like "00110" plus refs (test / serialisation helper). */
export function cellFromBits(bitStr, refs = [], exotic = false) {
  const bits = bitStr.length;
  const nbytes = Math.ceil(bits / 8);
  const data = new Uint8Array(nbytes);
  for (let i = 0; i < bits; i += 1) if (bitStr[i] === '1') data[i >> 3] |= 0x80 >> (i & 7);
  if (bits % 8) data[bits >> 3] |= 0x80 >> (bits & 7); // completion tag
  return new Cell({ bits, data, refs, exotic });
}

/** Parse a bag-of-cells (base64 / base64url / Uint8Array). Returns root cells. */
export function parseBoc(input) {
  const b = input instanceof Uint8Array ? input : b64ToBytes(input);
  const magic = hex(b.subarray(0, 4));
  if (magic !== 'b5ee9c72') throw new CellError(`unsupported BoC magic ${magic}`);
  const flags = b[4];
  const hasIdx = (flags & 0x80) !== 0;
  const size = flags & 0x07;
  const offBytes = b[5];
  if (size < 1 || size > 4 || offBytes < 1 || offBytes > 8) throw new CellError('bad BoC header');
  let p = 6;
  const rd = (n) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = v * 256 + b[p + i];
    p += n;
    return v;
  };
  const cellCount = rd(size);
  const rootCount = rd(size);
  const absent = rd(size);
  rd(offBytes); // tot_cells_size
  if (absent !== 0) throw new CellError('absent cells not supported');
  if (cellCount > 4096) throw new CellError('BoC too large');
  const roots = [];
  for (let i = 0; i < rootCount; i += 1) roots.push(rd(size));
  if (hasIdx) p += cellCount * offBytes;
  const raw = [];
  for (let i = 0; i < cellCount; i += 1) {
    if (p + 2 > b.length) throw new CellError('truncated BoC');
    const d1 = b[p];
    const d2 = b[p + 1];
    p += 2;
    const nref = d1 & 7;
    const exotic = (d1 & 8) !== 0;
    const level = d1 >> 5;
    if (level !== 0) throw new CellError('cells with level > 0 not supported');
    if (nref > 4) throw new CellError('bad ref count');
    const nbytes = Math.ceil(d2 / 2);
    const data = b.slice(p, p + nbytes);
    p += nbytes;
    let bits = nbytes * 8;
    if (d2 % 2) {
      const last = data[nbytes - 1];
      if (!last) throw new CellError('bad completion tag');
      let tz = 0;
      while (((last >> tz) & 1) === 0) tz += 1;
      bits = nbytes * 8 - tz - 1;
    }
    const refs = [];
    for (let r = 0; r < nref; r += 1) refs.push(rd(size));
    raw.push({ bits, data, refs, exotic });
  }
  const cells = new Array(cellCount);
  for (let i = cellCount - 1; i >= 0; i -= 1) {
    const r = raw[i];
    for (const ri of r.refs) if (ri <= i || ri >= cellCount) throw new CellError('BoC ref order invalid');
    cells[i] = new Cell({ bits: r.bits, data: r.data, refs: r.refs.map((ri) => cells[ri]), exotic: r.exotic });
  }
  return roots.map((i) => cells[i]);
}

/** Serialise a single-root cell tree to base64 BoC (no index, no CRC). */
export async function serializeBoc(root) {
  const index = new Map();
  // Topological order (parents before children) with de-duplication of identical cells.
  const sorted = [];
  const state = new Map();
  const topo = async (c) => {
    const h = await c.hashHex();
    if (state.get(h) === 2) return;
    state.set(h, 1);
    for (const r of c.refs) await topo(r);
    state.set(h, 2);
    sorted.push(c);
  };
  await topo(root);
  sorted.reverse();
  for (let i = 0; i < sorted.length; i += 1) index.set(await sorted[i].hashHex(), i);
  const size = sorted.length < 256 ? 1 : 2;
  const body = [];
  for (const c of sorted) {
    const [d1, d2] = c.descriptors();
    body.push(d1, d2, ...c.data);
    for (const r of c.refs) {
      const ri = index.get(await r.hashHex());
      if (size === 1) body.push(ri);
      else body.push(ri >> 8, ri & 0xff);
    }
  }
  const tot = body.length;
  const offBytes = tot < 256 ? 1 : tot < 65536 ? 2 : 4;
  const num = (v, n) => Array.from({ length: n }, (_, i) => (v >> (8 * (n - 1 - i))) & 0xff);
  const head = [0xb5, 0xee, 0x9c, 0x72, size, offBytes, ...num(sorted.length, size), ...num(1, size), ...num(0, size), ...num(tot, offBytes), ...num(0, size)];
  return bytesToB64(new Uint8Array([...head, ...body]));
}

/**
 * Parse StateInit (TL-B): split_depth:(Maybe (## 5)) special:(Maybe TickTock)
 * code:(Maybe ^Cell) data:(Maybe ^Cell) library:(Maybe ^Cell).
 */
export function parseStateInit(cell) {
  let pos = 0;
  let ref = 0;
  const bit = () => Number(cell.readBits(pos++, 1));
  if (bit()) pos += 5;
  if (bit()) pos += 2;
  const code = bit() ? cell.refs[ref++] : null;
  const data = bit() ? cell.refs[ref++] : null;
  const library = bit() ? cell.refs[ref++] : null;
  if (!code || !data) throw new CellError('StateInit must contain code and data');
  if (ref !== cell.refs.length || pos !== cell.bits) throw new CellError('StateInit has trailing content');
  return { code, data, library };
}

/**
 * Standard wallet code identities -> where the 256-bit public key sits in the data cell.
 * Hashes reproduced from the official @ton/ton wallet code BoCs (see worker/tests/fixtures).
 * A code cell that is a library cell (exotic type 2) is identified by the library hash.
 */
export const KNOWN_WALLETS = Object.freeze({
  b61041a58a7980b946e8fb9e198e3c904d24799ffa36574ea4251c41a566f581: { version: 'v3r1', keyOffset: 64 },
  '84dafa449f98a6987789ba232358072bc0f76dc4524002a5d0918b9a75d2d599': { version: 'v3r2', keyOffset: 64 },
  feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0: { version: 'v4r2', keyOffset: 64 },
  e4cf3b2f4c6d6a61ea0f2b5447d266785b26af3637db2deee6bcd1aa826f3412: { version: 'v5beta', keyOffset: 1 + 32 + 80 },
  '20834b7b72b112147e1b2fb457b84e74d1a30f04f737d4f62a668e9552d2b72f': { version: 'v5r1', keyOffset: 1 + 32 + 32 },
});

/**
 * Telegram Wallet (WalletTg) 不可变 trampoline 合约代码哈希（来源：TON 官方 ton_proof 文档）。
 * WalletTg 支持密钥轮换，因此严禁仅凭 StateInit 静态取公钥，必须校验链上活跃状态与代码哈希后调用 get_public_key()。
 */
export const WALLET_TG_TRAMPOLINE_HASH = '9149ae51c1e4689710cebf7830297b16acfbadb363a920a537893e7ffeeca768';

export async function codeIdentity(code) {
  if (code.exotic) return hex(code.data.subarray(1, 33)); // library cell: type byte + 256-bit hash
  return code.hashHex();
}

/** 解析单个链上合约代码 BoC 并返回其规范代码身份哈希（支持普通 cell 与 library cell）。 */
export async function inspectCodeBocIdentity(codeBoc) {
  const roots = parseBoc(codeBoc);
  if (roots.length !== 1) throw new CellError('code BoC must have exactly one root');
  return codeIdentity(roots[0]);
}

/**
 * Decode a wallet StateInit (base64 BoC).
 * Returns { addressHashHex, codeId, walletKind, version, publicKeyHex }.
 * walletKind: 'standard' | 'wallet_tg' | 'unsupported'
 */
export async function inspectWalletStateInit(stateInitB64) {
  const roots = parseBoc(stateInitB64);
  if (roots.length !== 1) throw new CellError('StateInit BoC must have exactly one root');
  const root = roots[0];
  const { code, data } = parseStateInit(root);
  const id = (await codeIdentity(code)).toLowerCase();
  const known = KNOWN_WALLETS[id] || null;
  if (known) {
    const publicKeyHex = data.readBits(known.keyOffset, 256).toString(16).padStart(64, '0');
    return { addressHashHex: await root.hashHex(), codeId: id, walletKind: 'standard', version: known.version, publicKeyHex };
  }
  if (id === WALLET_TG_TRAMPOLINE_HASH) {
    return { addressHashHex: await root.hashHex(), codeId: id, walletKind: 'wallet_tg', version: 'wallet_tg', publicKeyHex: null };
  }
  return { addressHashHex: await root.hashHex(), codeId: id, walletKind: 'unsupported', version: null, publicKeyHex: null };
}
