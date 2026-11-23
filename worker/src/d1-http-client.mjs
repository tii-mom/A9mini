// A9 Protocol W2 — Cloudflare D1 REST API & local SQLite-file persistence adapters.
// Exposes the exact Cloudflare Worker env.DB interface (prepare/bind/first/all/run/batch)
// so an external signing daemon (payout-daemon.mjs) shares the SAME production D1 ledger
// with cf-worker.mjs without any in-memory split.

import { DatabaseSync } from 'node:sqlite';

/**
 * Create a Cloudflare D1-compatible client backed by Cloudflare's D1 HTTP REST API.
 * Credentials are strictly injected via environment variables (never stored in repo).
 */
export function createD1HttpClient({
  accountId,
  databaseId,
  apiToken,
  apiBase = 'https://api.cloudflare.com/client/v4',
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  if (!accountId || !databaseId || !apiToken) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN are required');
  }
  const baseUrl = `${String(apiBase).replace(/\/+$/, '')}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
  const doFetch = fetchImpl === globalThis.fetch && typeof globalThis.fetch === 'function'
    ? (...args) => globalThis.fetch(...args)
    : fetchImpl;

  async function execStatements(items) {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    // Cloudflare D1 /query accepts single { sql, params } or batch payload depending on endpoint;
    // when multiple statements are passed, send sequential or atomic batch array via /query.
    const payload = items.length === 1
      ? { sql: items[0].sql, params: items[0].params }
      : { batch: items.map((x) => ({ sql: x.sql, params: x.params })) };
    const res = await doFetch(baseUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success || !Array.isArray(body.result)) {
      const msg = body?.errors?.map((e) => e.message).join('; ') || `D1 HTTP ${res.status}`;
      throw new Error(`D1 HTTP query failed: ${msg}`);
    }
    return body.result.map((entry) => {
      if (entry?.success === false) {
        throw new Error(entry.error || 'D1 statement failed');
      }
      return {
        results: Array.isArray(entry?.results) ? entry.results : [],
        meta: {
          changes: Number(entry?.meta?.changes ?? 0),
          last_row_id: entry?.meta?.last_row_id ?? null,
        },
      };
    });
  }

  function makeStmt(sql, params = []) {
    return {
      sql,
      params,
      bind(...args) {
        return makeStmt(sql, args);
      },
      async first() {
        const [out] = await execStatements([{ sql, params }]);
        return out.results[0] ?? null;
      },
      async all() {
        const [out] = await execStatements([{ sql, params }]);
        return out;
      },
      async run() {
        const [out] = await execStatements([{ sql, params }]);
        return out;
      },
    };
  }

  return {
    prepare(sql) {
      return makeStmt(sql, []);
    },
    async batch(stmts) {
      if (!Array.isArray(stmts) || stmts.length === 0) return [];
      return execStatements(stmts.map((s) => ({ sql: s.sql, params: s.params || [] })));
    },
  };
}

/**
 * Create a Cloudflare D1-compatible client backed by a persistent local SQLite file
 * (used for isolated testnet crash-recovery drills and standalone VPS SQLite mode).
 */
export function createSqliteFileD1(filePath) {
  if (!filePath) throw new Error('SQLite database file path is required');
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const plain = (row) => (row && typeof row === 'object' ? { ...row } : row);

  const makeStmt = (sql, args = []) => {
    const run = () => {
      const s = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) {
        return { results: s.all(...args).map(plain), meta: { changes: 0 } };
      }
      const r = s.run(...args);
      return { results: [], meta: { changes: Number(r.changes || 0), last_row_id: Number(r.lastInsertRowid || 0) } };
    };
    return {
      sql,
      args,
      bind(...a) { return makeStmt(sql, a); },
      async first() { return run().results[0] ?? null; },
      async all() { return run(); },
      async run() { return run(); },
      _run: run,
    };
  };

  return {
    prepare(sql) { return makeStmt(sql); },
    async batch(stmts) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = stmts.map((s) => s._run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      }
    },
    exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
  };
}
