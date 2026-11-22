// Test helpers: a real-SQLite Cloudflare D1 adapter (node:sqlite) and Telegram auth headers.
// Using real SQLite means UNIQUE constraints, conditional UPDATEs and batch rollback are
// exercised exactly as D1 would run them, instead of a string-matching mock.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { signTelegramInitData } from '../../src/auth.mjs';

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
export const MIGRATIONS = ['../../migrations/0001_baseline_v15.sql', '../../migrations/0002_p0_identity_presale_state.sql'];

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
  const res = await engine.ingestInbound({ txHash, finality: 'finalized', to: engine.hotWalletAddress, from: wallet, valueNano: order.tonNano, memo: order.memo }, nowSec + 1);
  if (res.action !== 'CONFIRM') throw new Error(`expected CONFIRM, got ${res.action}/${res.reason}`);
  await engine.queueConfirmedPayouts(nowSec + 2);
  await engine.processPayouts(nowSec + 3, {
    a9Broadcaster: async () => ({ txHash: `out-${txHash}` }),
    verifier: async (p) => ({ state: 'CONFIRMED', txHash: p.txHash }),
  });
  return engine.getOrder(order.orderId);
}
