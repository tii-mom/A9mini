// Test helpers: a real-SQLite Cloudflare D1 adapter (node:sqlite) and Telegram auth headers.
// Using real SQLite means UNIQUE constraints, conditional UPDATEs and batch rollback are
// exercised exactly as D1 would run them, instead of a string-matching mock.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { signTelegramInitData } from '../../src/auth.mjs';
import { cellFromBits, serializeBoc, parseBoc, V5R1_BASE_WALLET_ID } from '../../src/ton-cell.mjs';

const require = createRequire(import.meta.url);

export const TEST_BOT_TOKEN = '123456:TEST_BOT_TOKEN_FOR_UNIT_TESTS';

const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));
const plain = (row) => (row ? { ...row } : null);

export function createSqliteD1(sqlFiles = []) {
  const db = new DatabaseSync(':memory:');
  for (const f of sqlFiles) db.exec(readFileSync(new URL(f, import.meta.url), 'utf8'));
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      _sql: sql,
      _args: () => args,
      bind(...a) { args = a; return stmt; },
      async first() { return plain(db.prepare(sql).get(...norm(args))); },
      async all() { return { results: db.prepare(sql).all(...norm(args)).map(plain) }; },
      async run() { const r = db.prepare(sql).run(...norm(args)); return { success: true, meta: { changes: Number(r.changes) } }; },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => {
          const r = db.prepare(s._sql).run(...norm(s._args()));
          return { success: true, meta: { changes: Number(r.changes) } };
        });
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    exec: (sql) => db.exec(sql),
    /** Full dump of every table, for "dry-run writes nothing" assertions. */
    dump() {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all().map(plain)]));
    },
  };
}

export const FRESH_SCHEMA = ['../../schema.sql'];
export const MIGRATIONS = [
  '../../migrations/0001_baseline_v15.sql',
  '../../migrations/0002_p0_identity_presale_state.sql',
  '../../migrations/0003_anomalies_and_rebind.sql',
  '../../migrations/0004_presale_payouts_uniqueness.sql',
  '../../migrations/0005_phase3_progression_stamps.sql',
  '../../migrations/0006_phase4_6_sticker_packs_inventory.sql',
  '../../migrations/0007_tg_broadcast_events.sql',
  '../../migrations/0008_prediction_activations.sql',
  '../../migrations/0009_chest_mall_and_assists.sql',
  '../../migrations/0010_w2_runner_cursors_and_promo_payouts.sql',
  '../../migrations/0011_warmup_reservations_v2.sql',
  '../../migrations/0012_actuarial_hardening.sql',
  '../../migrations/0013_user_notification_prefs.sql',
  '../../migrations/0014_v17_price_unlock.sql',
  '../../migrations/0015_v17_1_chest_direct_payout.sql',
  '../../migrations/0016_v17_finality_snapshots.sql',
  '../../migrations/0017_actuarial_reservations_and_vouchers.sql',
  '../../migrations/0018_hot_wallet_payout_debits.sql',
];
export const WAVE1A_MIGRATIONS = MIGRATIONS.slice(0, 15);
export const PRE_0017_MIGRATIONS = MIGRATIONS.slice(0, 16);

/** Async dump of every user table; works for the SQLite adapter and for real (Miniflare) D1. */
export async function dumpDb(db) {
  const t = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all();
  const out = [];
  for (const { name } of t.results) out.push([name, (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results]);
  return JSON.stringify(out);
}

let cachedMiniflareClass;
async function resolveMiniflareClass() {
  if (cachedMiniflareClass !== undefined) return cachedMiniflareClass;
  const override = process.env.MINIFLARE_MODULE;
  if (override === 'none') {
    cachedMiniflareClass = null;
    return null;
  }
  if (override) {
    try {
      const mod = await import(override);
      cachedMiniflareClass = mod.Miniflare || mod.default?.Miniflare || null;
      return cachedMiniflareClass;
    } catch {
      try {
        const mod = require(override);
        cachedMiniflareClass = mod.Miniflare || null;
        return cachedMiniflareClass;
      } catch {
        cachedMiniflareClass = null;
        return null;
      }
    }
  }
  try {
    const mod = require('miniflare');
    if (mod?.Miniflare) {
      cachedMiniflareClass = mod.Miniflare;
      return cachedMiniflareClass;
    }
  } catch {}
  try {
    const cache = resolve(homedir(), '.npm/_npx');
    const found = [];
    if (existsSync(cache)) {
      for (const folder of readdirSync(cache)) {
        const pkgPath = resolve(cache, folder, 'node_modules', 'miniflare', 'package.json');
        if (!existsSync(pkgPath)) continue;
        const info = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (typeof info?.version === 'string' && !info.version.includes('-')) {
          found.push({ version: info.version, path: dirname(pkgPath) });
        }
      }
    }
    found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    if (found.length) {
      const mod = require(found[0].path);
      cachedMiniflareClass = mod?.Miniflare || null;
      return cachedMiniflareClass;
    }
  } catch {}
  cachedMiniflareClass = null;
  return null;
}

/**
 * Real Cloudflare D1 (workerd SQLite via Miniflare), auto-discovering local node_modules
 * or cached stable `~/.npm/_npx` Miniflare (same resolution as ops/scripts/local-v17-candidate.mjs).
 * Returns null only when Miniflare is unavailable or MINIFLARE_MODULE=none.
 */
export async function createMiniflareD1(sqlFiles = FRESH_SCHEMA) {
  const Miniflare = await resolveMiniflareClass();
  if (!Miniflare) return null;
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null); } }', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB');
  for (const f of sqlFiles) {
    const sql = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
    const stmts = sql.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean);
    await db.batch(stmts.map((x) => db.prepare(x)));
  }
  return { db, dispose: () => mf.dispose() };
}

/** Authorization header carrying correctly signed initData for a Telegram user id. */
export async function tgHeaders(userId, { botToken = TEST_BOT_TOKEN, authDate = null, nowSec = 1000, extra = {} } = {}) {
  const initData = await signTelegramInitData({
    auth_date: String(authDate ?? nowSec),
    query_id: 'AAE-test',
    user: { id: Number(userId), first_name: `u${userId}`, username: `u${userId}` },
    ...extra,
  }, botToken);
  return { authorization: `tma ${initData}` };
}

/** Drive one presale order all the way to COMPLETED with fake broadcaster + verifier. */
export async function completePurchase(engine, wallet, gram, nowSec, { txHash = `in-${wallet}-${nowSec}` } = {}) {
  const order = await engine.createOrderIntent(wallet, gram, nowSec);
  const res = await engine.ingestInbound({ txHash, finality: 'finalized', to: engine.hotWalletAddress, from: wallet, valueNano: order.payTonNano, memo: order.memo }, nowSec + 1);
  if (res.action !== 'CONFIRM') throw new Error(`expected CONFIRM, got ${res.action}/${res.reason}`);
  await engine.queueConfirmedPayouts(nowSec + 2);
  await engine.processPayouts(nowSec + 3, {
    a9Broadcaster: async () => ({ txHash: `out-${txHash}` }),
    verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }),
  });
  return engine.getOrder(order.orderId);
}


export const PROOF_FIXTURES = JSON.parse(readFileSync(new URL('../fixtures/ton-proof-fixtures.json', import.meta.url), 'utf8'));

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A synthetic but structurally real wallet v4r2 (official code BoC + data with our key). */
export async function makeV4R2Wallet() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const [code] = parseBoc(PROOF_FIXTURES.walletCodes.v4r2);
  const bitsOf = (n, w) => BigInt(n).toString(2).padStart(w, '0');
  const data = cellFromBits(bitsOf(0, 32) + bitsOf(698983191, 32) + Array.from(pub, (b) => b.toString(2).padStart(8, '0')).join('') + '0');
  const root = cellFromBits('00110', [code, data]);
  const stateInit = await serializeBoc(root);
  return { kp, pubHex: toHex(pub), stateInit, address: `0:${await root.hashHex()}` };
}

/** A synthetic but structurally real W5 (v5r1) wallet using official @ton/ton v5r1 code BoC. */
export async function makeV5R1Wallet({ network = '-3', subwallet = 0, isSignatureAllowed = true, walletId = null } = {}) {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const [code] = parseBoc(PROOF_FIXTURES.walletCodes.v5r1);
  const baseId = V5R1_BASE_WALLET_ID[String(network)];
  if (walletId === null && baseId === undefined) throw new Error(`Unsupported W5 network: ${network}`);
  const resolvedWalletId = walletId !== null ? (Number(walletId) >>> 0) : ((baseId ^ Number(subwallet)) >>> 0);
  const bitsOf = (n, w) => BigInt(n >>> 0).toString(2).padStart(w, '0');
  const data = cellFromBits(
    (isSignatureAllowed ? '1' : '0')
    + bitsOf(0, 32)
    + bitsOf(resolvedWalletId, 32)
    + Array.from(pub, (b) => b.toString(2).padStart(8, '0')).join('')
    + '0',
  );
  const root = cellFromBits('00110', [code, data]);
  const stateInit = await serializeBoc(root);
  return { kp, pubHex: toHex(pub), walletId: resolvedWalletId, network: String(network), isSignatureAllowed, stateInit, address: `0:${await root.hashHex()}` };
}

/** Sign a ton-proof-item-v2 exactly as a wallet does. */
export async function signTonProof(w, { payload, domain = 'a9.example', timestamp, address = w.address, key = w.kp.privateKey }) {
  const enc = new TextEncoder();
  const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  const [wcStr, hashHex] = address.split(':');
  const wc = new Uint8Array(4); new DataView(wc.buffer).setInt32(0, Number(wcStr), false);
  const hash = new Uint8Array(hashHex.match(/../g).map((h) => parseInt(h, 16)));
  const db = enc.encode(domain);
  const dl = new Uint8Array(4); new DataView(dl.buffer).setUint32(0, db.length, true);
  const ts = new Uint8Array(8); new DataView(ts.buffer).setBigUint64(0, BigInt(timestamp), true);
  const msg = cat(enc.encode('ton-proof-item-v2/'), wc, hash, dl, db, ts, enc.encode(payload));
  const full = cat(new Uint8Array([0xff, 0xff]), enc.encode('ton-connect'), new Uint8Array(await crypto.subtle.digest('SHA-256', msg)));
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, new Uint8Array(await crypto.subtle.digest('SHA-256', full))));
  return { timestamp, domain: { lengthBytes: db.length, value: domain }, payload, signature: btoa(String.fromCharCode(...sig)), state_init: w.stateInit };
}
