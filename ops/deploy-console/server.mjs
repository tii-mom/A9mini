#!/usr/bin/env node
/**
 * A9 v16.2 本地零私钥「手机 W5 钱包扫码」主网 5 步部署控制台服务
 *
 * - 仅监听 127.0.0.1:8799，绝不读取/存储任何私钥或助记词
 * - 通过 TonCenter v3 Mainnet API 批量单次查询全部 6 个地址状态，串行节流调用只读 getMethod，
 *   即使在零 API Key 的公共限速（1 RPS）下也可稳定实时核验余额与 5 步链上真实进度
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { parseBoc, parseStateInit } from '../../worker/src/ton-cell.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTonAddress } from '../../a9-mini-app/js/v15-tx.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BUNDLE_PATH = resolve(__dirname, 'bundle-mainnet-v17.0.json');
const PORT = Number(process.env.A9_DEPLOY_CONSOLE_PORT || 8799);
const TONCENTER_V3_BASE = (process.env.TONCENTER_V3_BASE || 'https://toncenter.com/api/v3').replace(/\/+$/, '');
const TONCENTER_KEY = (process.env.TONCENTER_API_KEY || process.env.TONCENTER_MAINNET_API_KEY || '').trim();
const MIN_INTERVAL_MS = TONCENTER_KEY ? 180 : 1150;

const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8'));

function toRawLower(addr) {
  const s = String(addr || '').trim();
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  try {
    const p = parseTonAddress(s);
    const hex = Array.from(p.hash, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${p.workchain}:${hex}`;
  } catch {
    return s.toLowerCase();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let lastTcCallTs = 0;
async function tcV3Fetch(path, opts = {}, attempt = 0) {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastTcCallTs);
  if (wait > 0) await sleep(wait);
  lastTcCallTs = Date.now();

  const url = `${TONCENTER_V3_BASE}${path}`;
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'a9-deploy-console/16.2',
  };
  if (TONCENTER_KEY) headers['X-API-Key'] = TONCENTER_KEY;

  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000), headers: { ...headers, ...(opts.headers || {}) } });
  if (res.status === 429 && attempt < 2) {
    await sleep(1300 * (attempt + 1));
    return tcV3Fetch(path, opts, attempt + 1);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error(json?.error || `TonCenter v3 HTTP ${res.status}`);
  }
  return json;
}

function fail(code) { throw new Error(code); }

// The shared parser handles cells; enforce the complete BoC envelope and CRC here.
export function parseConsoleBoc(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) fail('INVALID_BOC_ENCODING');
  const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length < 10 || bytes.length > 65536 || bytes.readUInt32BE(0) !== 0xb5ee9c72) fail('INVALID_BOC');
  if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')) fail('INVALID_BOC_ENCODING');
  const flags = bytes[4], size = flags & 7, offsetBytes = bytes[5];
  if ((flags & 0x38) || size < 1 || size > 4 || offsetBytes < 1 || offsetBytes > 6) fail('INVALID_BOC_HEADER');
  let pos = 6;
  const read = (n) => { if (pos + n > bytes.length) fail('TRUNCATED_BOC'); let v = 0; while (n--) v = v * 256 + bytes[pos++]; return v; };
  const cells = read(size), roots = read(size), absent = read(size), total = read(offsetBytes);
  if (!cells || roots !== 1 || absent !== 0) fail('INVALID_BOC_ROOTS');
  const end = pos + roots * size + ((flags & 128) ? cells * offsetBytes : 0) + total;
  if (!Number.isSafeInteger(end) || end + ((flags & 64) ? 4 : 0) !== bytes.length) fail('INVALID_BOC_LENGTH');
  // parseBoc intentionally tolerates envelope padding; the console must not.
  let cellPos = pos + roots * size + ((flags & 128) ? cells * offsetBytes : 0);
  for (let i = 0; i < cells; i++) {
    if (cellPos + 2 > end) fail('TRUNCATED_BOC');
    const refs = bytes[cellPos] & 7, descriptor = bytes[cellPos + 1];
    if (refs > 4) fail('INVALID_BOC_REFS');
    cellPos += 2 + Math.ceil(descriptor / 2) + refs * size;
    if (cellPos > end) fail('TRUNCATED_BOC');
  }
  if (cellPos !== end) fail('TRAILING_BOC_CONTENT');
  if (flags & 64) {
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(0, end)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0); }
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32LE(end)) fail('INVALID_BOC_CRC');
  }
  const parsed = parseBoc(bytes);
  if (parsed.length !== 1) fail('INVALID_BOC_ROOTS');
  return parsed[0];
}

export function parseStackAddress(entry) {
  if (!entry || !['cell', 'slice'].includes(entry.type)) fail('INVALID_ADDRESS_STACK');
  const cell = parseConsoleBoc(entry.value);
  if (cell.exotic || cell.refs.length) fail('INVALID_ADDRESS_CELL');
  const tag = Number(cell.readBits(0, 2));
  if (tag === 0 && cell.bits === 2) return null;
  if (tag !== 2 || cell.bits !== 267 || cell.readBits(2, 1) !== 0n) fail('INVALID_ADDRESS_CELL');
  let wc = Number(cell.readBits(3, 8)); if (wc > 127) wc -= 256;
  return `${wc}:${cell.readBits(11, 256).toString(16).padStart(64, '0')}`;
}

function parseV3Num(entry) {
  if (entry?.type !== 'num' || typeof entry.value !== 'string' || !/^(?:-?0x[0-9a-f]+|-?[0-9]+)$/i.test(entry.value)) fail('INVALID_NUMBER_STACK');
  return /^-0x/i.test(entry.value) ? -BigInt(entry.value.slice(1)) : BigInt(entry.value);
}

function canonicalHash(value) {
  if (typeof value !== 'string') fail('MISSING_CODE_HASH');
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length !== 32 || bytes.toString('base64').replace(/=+$/, '') !== value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')) fail('INVALID_CODE_HASH');
  return bytes.toString('hex');
}

export async function loadLockedCodeHashes(deployBundle = bundle) {
  const hashes = {};
  for (const name of ['JettonMaster', 'JettonWallet', 'RoundController', 'StakeTicket']) {
    const relPath = `build/${name}.json`;
    const file = readFileSync(resolve(REPO_ROOT, 'v17', relPath));
    const locked = deployBundle.artifactsSha256.find((a) => a.relPath === relPath)?.sha256;
    if (!locked || createHash('sha256').update(file).digest('hex') !== locked) fail('LOCKED_ARTIFACT_MISMATCH');
    hashes[name] = await parseConsoleBoc(JSON.parse(file).code_boc64).hashHex();
  }
  for (const [step, name] of [[1, 'JettonMaster'], [4, 'RoundController']]) {
    const root = parseConsoleBoc(deployBundle.steps.find((s) => s.step === step)?.message?.stateInit);
    if (await parseStateInit(root).code.hashHex() !== hashes[name]) fail('BUNDLE_CODE_MISMATCH');
    if (`0:${await root.hashHex()}` !== toRawLower(deployBundle.contracts[name === 'JettonMaster' ? 'jettonMaster' : 'roundController'])) fail('BUNDLE_STATEINIT_ADDRESS_MISMATCH');
  }
  return hashes;
}

// Injection is for deterministic RPC regression tests; production always uses tcV3Fetch.
export async function queryLiveDeployStatusOnce({ deployBundle = bundle, fetchJson = tcV3Fetch, lockedCodeHashes = null } = {}) {
  const now = Date.now(), { roles, contracts } = deployBundle;
  const unknown = () => ({ ok: false, state: 'unknown', balanceNano: null, balanceGram: null });
  const data = {
    checkedAt: now, verified: false, errors: [],
    wallets: { deployer: unknown(), treasury: unknown() },
    contracts: { jettonMaster: { ...unknown(), totalSupplyRaw: null, mintable: null, adminRenounced: null }, roundController: unknown(), treasuryJettonWallet: { ...unknown(), a9Raw: null }, rcJettonWallet: { ...unknown(), a9Raw: null } },
    steps: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, { done: false, unlocked: false }])), allDone: false,
  };
  try {
    const hashes = lockedCodeHashes || await loadLockedCodeHashes(deployBundle);
    const allAddrs = [roles.deployer, roles.treasury, contracts.jettonMaster, contracts.roundController, contracts.treasuryJettonWallet, contracts.rcJettonWallet];
    const expected = new Set(allAddrs.map(toRawLower));
    const response = await fetchJson(`/accountStates?${allAddrs.map((a) => `address=${encodeURIComponent(a)}`).join('&')}&include_boc=false`);
    if (!response || !Array.isArray(response.accounts) || response.ok === false) fail('INVALID_ACCOUNT_RESPONSE');
    const states = new Map();
    for (const acc of response.accounts) {
      if (!acc || typeof acc.address !== 'string') fail('INVALID_ACCOUNT_ENTRY');
      const key = toRawLower(acc.address);
      if (!expected.has(key) || states.has(key)) fail('UNEXPECTED_OR_DUPLICATE_ACCOUNT');
      if (!['active', 'uninit', 'uninitialized', 'nonexist'].includes(acc.status)) fail('INVALID_ACCOUNT_STATE');
      if (typeof acc.balance !== 'string' || !/^[0-9]+$/.test(acc.balance)) fail('INVALID_ACCOUNT_BALANCE');
      const amount = BigInt(acc.balance);
      states.set(key, { ok: true, state: acc.status === 'active' ? 'active' : 'uninitialized', balanceNano: amount.toString(), balanceGram: `${amount / 1000000000n}.${(amount % 1000000000n).toString().padStart(9, '0')}`, codeHash: acc.status === 'active' ? canonicalHash(acc.code_hash) : null });
    }
    if (states.size !== expected.size) fail('MISSING_ACCOUNT_STATE');
    const pick = (address) => ({ ...states.get(toRawLower(address)) });
    data.wallets.deployer = pick(roles.deployer); data.wallets.treasury = pick(roles.treasury);
    for (const [field, name] of [['jettonMaster', 'JettonMaster'], ['roundController', 'RoundController'], ['treasuryJettonWallet', 'JettonWallet'], ['rcJettonWallet', 'JettonWallet']]) {
      Object.assign(data.contracts[field], pick(contracts[field]));
      if (data.contracts[field].state === 'active' && data.contracts[field].codeHash !== hashes[name]) fail('ACTIVE_CODE_MISMATCH');
    }
    const get = async (address, method) => {
      const r = await fetchJson('/runGetMethod', { method: 'POST', body: JSON.stringify({ address, method, stack: [] }) });
      if (!r || r.ok === false || ![0, 1].includes(r.exit_code) || !Array.isArray(r.stack)) fail('GETTER_UNAVAILABLE');
      return r.stack;
    };
    const master = data.contracts.jettonMaster, rc = data.contracts.roundController;
    let supply = 0n, mintable = null, admin = null;
    if (master.state === 'active') {
      const stack = await get(contracts.jettonMaster, 'get_jetton_data');
      if (stack.length < 3) fail('INCOMPLETE_JETTON_DATA');
      supply = parseV3Num(stack[0]); const flag = parseV3Num(stack[1]);
      if (supply < 0n || ![0n, -1n].includes(flag)) fail('INVALID_JETTON_DATA');
      mintable = flag === -1n; admin = parseStackAddress(stack[2]);
      Object.assign(master, { totalSupplyRaw: supply.toString(), mintable, adminRenounced: !mintable && admin === null });
    }
    const readWallet = async (field, expectedOwner) => {
      const wallet = data.contracts[field]; let amount = 0n;
      if (wallet.state === 'active') {
        const stack = await get(contracts[field], 'get_wallet_data');
        if (stack.length < 3) fail('INCOMPLETE_WALLET_DATA');
        amount = parseV3Num(stack[0]);
        if (amount < 0n || parseStackAddress(stack[1]) !== toRawLower(expectedOwner) || parseStackAddress(stack[2]) !== toRawLower(contracts.jettonMaster)) fail('INVALID_JETTON_WALLET_DATA');
      }
      wallet.a9Raw = amount.toString(); return amount;
    };
    const tw = await readWallet('treasuryJettonWallet', roles.treasury), rw = await readWallet('rcJettonWallet', contracts.roundController);
    const total = 10000000000000000000n, funding = 8200000000000000000n;
    if (supply !== 0n && supply !== total) fail('UNEXPECTED_TOTAL_SUPPLY');
    if (rw > funding) fail('UNEXPECTED_RC_FUNDING');
    const treasuryAdmin = admin === toRawLower(roles.treasury);
    const validMinter = (supply === 0n && mintable === true && treasuryAdmin)
      || (supply === total && mintable === false && (treasuryAdmin || admin === null));
    if (master.state === 'active' && !validMinter) fail('UNEXPECTED_MINTER_STATE');
    if (master.state !== 'active' && (rc.state === 'active' || tw !== 0n || rw !== 0n)) fail('UNEXPECTED_DEPLOYMENT_ORDER');
    if (supply === total && tw !== total && rw !== funding) fail('MINT_RECEIPT_UNCONFIRMED');
    const done1 = master.state === 'active', done2 = done1 && supply === total && (tw === total || rw === funding), done3 = done2 && master.adminRenounced === true, done4 = rc.state === 'active', done5 = done4 && rw === funding;
    data.steps = {
      1: { done: done1, unlocked: !done1 },
      2: { done: done2, unlocked: done1 && supply === 0n && mintable === true && treasuryAdmin && tw === 0n && rw === 0n },
      3: { done: done3, unlocked: done2 && !done3 && mintable === false && treasuryAdmin },
      4: { done: done4, unlocked: done3 && !done4 },
      5: { done: done5, unlocked: done3 && done4 && !done5 && rw === 0n && tw >= funding },
    };
    data.allDone = done1 && done2 && done3 && done4 && done5;
    data.verified = true;
  } catch (error) {
    // Never preserve an earlier unlocked state, or expose upstream error text/secrets.
    data.errors = [/^[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'STATUS_VERIFICATION_FAILED'];
    for (const step of Object.values(data.steps)) step.unlocked = false;
    data.allDone = false;
  }
  return data;
}

let statusCache = { ts: 0, data: null };
let inFlight = null;

async function fetchLiveDeployStatus(force = false) {
  if (!force && statusCache.data && Date.now() - statusCache.ts < 6000) {
    return statusCache.data;
  }
  if (!inFlight) {
    inFlight = queryLiveDeployStatusOnce().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/api/bundle') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(bundle));
      return;
    }
    if (p === '/api/status') {
      const force = url.searchParams.get('force') === '1';
      const data = await fetchLiveDeployStatus(force);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, data }));
      return;
    }
    if (p === '/vendor/tonconnect-ui.min.js') {
      const vendorPath = resolve(REPO_ROOT, 'a9-mini-app/js/vendor/tonconnect-ui.min.js');
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(readFileSync(vendorPath));
      return;
    }
    if (p === '/vendor/v15-tx.js') {
      const txPath = resolve(REPO_ROOT, 'a9-mini-app/js/v15-tx.js');
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(readFileSync(txPath));
      return;
    }
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = resolve(__dirname, rel);
    if (!file.startsWith(__dirname) || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`A9 v17.0 Zero-Key Mainnet Deploy Console listening on http://127.0.0.1:${PORT}`);
  });
}
