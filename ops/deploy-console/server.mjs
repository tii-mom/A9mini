#!/usr/bin/env node
/**
 * A9 v16.2 本地零私钥「手机 W5 钱包扫码」主网 5 步部署控制台服务
 *
 * - 仅监听 127.0.0.1:8799，绝不读取/存储任何私钥或助记词
 * - 通过 TonCenter v3 Mainnet API 批量单次查询全部 6 个地址状态，串行节流调用只读 getMethod，
 *   即使在零 API Key 的公共限速（1 RPS）下也可稳定实时核验余额与 5 步链上真实进度
 */
import http from 'node:http';
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

  const res = await fetch(url, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
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

async function fetchAccountStatesBatch(addresses) {
  const qs = addresses.map((a) => `address=${encodeURIComponent(a)}`).join('&');
  const json = await tcV3Fetch(`/accountStates?${qs}&include_boc=false`);
  const map = new Map();
  for (const acc of json?.accounts || []) {
    const rawKey = toRawLower(acc.address);
    const rawStatus = String(acc.status || 'uninit');
    const state = rawStatus === 'uninit' ? 'uninitialized' : rawStatus;
    const balanceNano = String(acc.balance || '0');
    map.set(rawKey, {
      ok: true,
      state,
      balanceNano,
      balanceGram: (Number(BigInt(balanceNano)) / 1e9).toFixed(4),
    });
  }
  return map;
}

async function runGetMethodV3(address, method, stack = []) {
  try {
    const r = await tcV3Fetch('/runGetMethod', {
      method: 'POST',
      body: JSON.stringify({ address, method, stack }),
    });
    if (r.exit_code !== 0 && r.exit_code !== 1) {
      return { ok: false, exitCode: r.exit_code };
    }
    return { ok: true, stack: r.stack || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function parseV3Num(entry) {
  if (!entry || entry.type !== 'num') return null;
  const raw = String(entry.value ?? '').trim();
  try {
    if (raw.startsWith('-0x') || raw.startsWith('-0X')) {
      return -BigInt(`0x${raw.slice(3)}`);
    }
    return BigInt(raw);
  } catch {
    return null;
  }
}

function isAddrNoneV3(entry) {
  if (!entry) return false;
  if (entry.type === 'null' || entry.type === 'none') return true;
  if ((entry.type === 'cell' || entry.type === 'slice') && typeof entry.value === 'string') {
    // addr_none 仅 2 bit (00)，BOC 字节数远小于标准 267-bit 地址（约 46~55 字节）
    const buf = Buffer.from(entry.value, 'base64');
    return buf.length <= 20;
  }
  return false;
}

const DEFAULT_UNINIT = { ok: true, state: 'uninitialized', balanceNano: '0', balanceGram: '0.0000' };

let statusCache = { ts: 0, data: null };
let inFlight = null;

async function queryLiveDeployStatusOnce() {
  const now = Date.now();
  const { roles, contracts } = bundle;
  const allAddrs = [
    roles.deployer,
    roles.treasury,
    contracts.jettonMaster,
    contracts.roundController,
    contracts.treasuryJettonWallet,
    contracts.rcJettonWallet,
  ];

  const stateMap = await fetchAccountStatesBatch(allAddrs);
  const pick = (addr) => ({ ...(stateMap.get(toRawLower(addr)) || DEFAULT_UNINIT) });

  const deployerInfo = pick(roles.deployer);
  const treasuryInfo = pick(roles.treasury);
  const masterInfo = pick(contracts.jettonMaster);
  const rcInfo = pick(contracts.roundController);
  const treasuryJwInfo = pick(contracts.treasuryJettonWallet);
  const rcJwInfo = pick(contracts.rcJettonWallet);

  const masterActive = masterInfo.state === 'active';
  const rcActive = rcInfo.state === 'active';

  let totalSupplyRaw = '0';
  let mintable = null;
  let adminRenounced = false;
  if (masterActive) {
    const jm = await runGetMethodV3(contracts.jettonMaster, 'get_jetton_data');
    if (jm.ok && jm.stack.length >= 3) {
      const sup = parseV3Num(jm.stack[0]);
      const mintFlag = parseV3Num(jm.stack[1]);
      totalSupplyRaw = sup !== null ? sup.toString() : '0';
      mintable = mintFlag !== null ? mintFlag !== 0n : null;
      adminRenounced = isAddrNoneV3(jm.stack[2]) && mintable === false;
    }
  }

  let treasuryA9Raw = '0';
  if (treasuryJwInfo.state === 'active') {
    const tw = await runGetMethodV3(contracts.treasuryJettonWallet, 'get_wallet_data');
    if (tw.ok && tw.stack.length >= 1) {
      const bal = parseV3Num(tw.stack[0]);
      if (bal !== null) treasuryA9Raw = bal.toString();
    }
  }

  let rcA9Raw = '0';
  if (rcJwInfo.state === 'active') {
    const rw = await runGetMethodV3(contracts.rcJettonWallet, 'get_wallet_data');
    if (rw.ok && rw.stack.length >= 1) {
      const bal = parseV3Num(rw.stack[0]);
      if (bal !== null) rcA9Raw = bal.toString();
    }
  }

  const TEN_B = 10_000_000_000_000_000_000n;
  const EIGHT_TWO_B = 8_200_000_000_000_000_000n;
  const supBi = BigInt(totalSupplyRaw);
  const twBi = BigInt(treasuryA9Raw);
  const rcBi = BigInt(rcA9Raw);

  const step1Done = masterActive;
  const step2Done = step1Done && supBi === TEN_B && (twBi === TEN_B || rcBi === EIGHT_TWO_B);
  const step3Done = step2Done && adminRenounced;
  const step4Done = rcActive;
  const step5Done = step4Done && rcBi === EIGHT_TWO_B;

  const data = {
    checkedAt: now,
    wallets: { deployer: deployerInfo, treasury: treasuryInfo },
    contracts: {
      jettonMaster: { ...masterInfo, totalSupplyRaw, mintable, adminRenounced },
      roundController: rcInfo,
      treasuryJettonWallet: { ...treasuryJwInfo, a9Raw: treasuryA9Raw },
      rcJettonWallet: { ...rcJwInfo, a9Raw: rcA9Raw },
    },
    steps: {
      1: { done: step1Done, unlocked: !step1Done },
      2: { done: step2Done, unlocked: step1Done && !step2Done },
      3: { done: step3Done, unlocked: step2Done && !step3Done },
      4: { done: step4Done, unlocked: step3Done && !step4Done },
      5: { done: step5Done, unlocked: step4Done && !step5Done && twBi >= EIGHT_TWO_B },
    },
    allDone: step1Done && step2Done && step3Done && step4Done && step5Done,
  };
  statusCache = { ts: Date.now(), data };
  return data;
}

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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`A9 v17.0 Zero-Key Mainnet Deploy Console listening on http://127.0.0.1:${PORT}`);
});
