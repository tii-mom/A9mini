#!/usr/bin/env node
// A9 Protocol v15 — Batch A security & mode-isolation regression suite.
// Each test evaluates the real ESM module graph in a fresh Node subprocess to prevent module-cache cross-talk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const JS_DIR = dirname(fileURLToPath(import.meta.url));
const JS_URL = pathToFileURL(JS_DIR).href.replace(/\/+$/, '');

function runScenario(opts, scriptBody) {
  const bootstrap = `
const opts = ${JSON.stringify(opts)};
const url = new URL(opts.href);
function createStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    _dump() { return Object.fromEntries(map.entries()); },
  };
}
const localStorage = createStorage();
const sessionStorage = createStorage();
const sdkCalls = { openModal: 0, disconnect: 0, sendTransaction: 0, lastTx: null };
const fetchCalls = [];

class FakeTonConnectUI {
  constructor(initOpts) {
    this.opts = initOpts;
    this.connected = Boolean(opts.sdkConnected);
    this.uiOptions = {};
    this._cb = null;
  }
  onStatusChange(cb) {
    this._cb = cb;
    if (this.connected) cb({ account: { address: '0:' + '11'.repeat(32) } });
  }
  async openModal() { sdkCalls.openModal += 1; }
  async disconnect() {
    sdkCalls.disconnect += 1;
    this.connected = false;
    this._cb?.(null);
  }
  async sendTransaction(tx) {
    sdkCalls.sendTransaction += 1;
    sdkCalls.lastTx = tx;
    return { boc: 'REAL_SIGNED_BOC' };
  }
}

globalThis.window = {
  location: {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
  },
  __A9_CONFIG__: opts.injectedConfig || {},
  TON_CONNECT_UI: opts.sdkAvailable !== false ? { TonConnectUI: FakeTonConnectUI } : undefined,
  Telegram: opts.startParam
    ? { WebApp: { initData: 'user=%7B%22id%22%3A123%7D', initDataUnsafe: { start_param: opts.startParam, user: { id: 123 } } } }
    : undefined,
  matchMedia: () => ({ matches: false }),
  open: () => {},
};
globalThis.document = {
  documentElement: { dataset: { theme: 'dark' } },
  querySelector: () => null,
  getElementById: () => null,
  addEventListener: () => {},
  createElement: () => ({ className: '', style: {}, setAttribute() {}, remove() {}, querySelector: () => null }),
  body: { appendChild() {} },
};
globalThis.localStorage = localStorage;
globalThis.sessionStorage = sessionStorage;
globalThis.fetch = async (target, init = {}) => {
  fetchCalls.push({ url: String(target), method: init.method || 'GET', body: init.body || null });
  return {
    ok: true,
    status: 200,
    async json() { return { ok: true, data: { payTo: 'EQ_FAKE', memo: 'claim:1', tonNano: '5000000000' }, ts: Date.now() }; },
  };
};
const JS_URL = ${JSON.stringify(JS_URL)};
(async () => {
${scriptBody}
})().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error((res.stderr || res.stdout || `exit ${res.status}`).trim());
  }
  const lines = String(res.stdout || '').trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1] || '{}');
}

test('Production blocks arbitrary ?api= URL override while preserving deployed apiBase', () => {
  const out = runScenario(
    {
      href: 'https://a9.lat/?mode=live&api=https://evil.attacker.invalid',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat' },
    },
    `
      const { config } = await import(JS_URL + '/config.js');
      console.log(JSON.stringify({ mode: config.mode, apiBase: config.apiBase, rejected: config.apiOverrideRejected }));
    `,
  );
  assert.equal(out.mode, 'live');
  assert.equal(out.apiBase, 'https://api.a9.lat');
  assert.equal(out.rejected, true);
});

test('Production allows ?api= only when origin is explicitly allowlisted', () => {
  const out = runScenario(
    {
      href: 'https://a9.lat/?mode=live&api=https://staging-api.a9.lat/v1/',
      injectedConfig: {
        mode: 'live',
        apiBase: 'https://api.a9.lat',
        allowedApiOrigins: ['https://staging-api.a9.lat'],
      },
    },
    `
      const { config } = await import(JS_URL + '/config.js');
      console.log(JSON.stringify({ apiBase: config.apiBase, rejected: config.apiOverrideRejected }));
    `,
  );
  assert.equal(out.apiBase, 'https://staging-api.a9.lat/v1');
  assert.equal(out.rejected, false);
});

test('Local dev preserves loopback ?api= override but rejects remote untrusted origin and bad protocols', () => {
  const okLocal = runScenario(
    { href: 'http://127.0.0.1:8091/?mode=live&api=http://127.0.0.1:8799' },
    `
      const { config } = await import(JS_URL + '/config.js');
      console.log(JSON.stringify({ apiBase: config.apiBase, rejected: config.apiOverrideRejected }));
    `,
  );
  assert.equal(okLocal.apiBase, 'http://127.0.0.1:8799');
  assert.equal(okLocal.rejected, false);

  const badRemote = runScenario(
    { href: 'http://127.0.0.1:8091/?mode=live&api=https://evil.attacker.invalid' },
    `
      const { config } = await import(JS_URL + '/config.js');
      console.log(JSON.stringify({ apiBase: config.apiBase, rejected: config.apiOverrideRejected }));
    `,
  );
  assert.equal(badRemote.apiBase, '');
  assert.equal(badRemote.rejected, true);

  const badProto = runScenario(
    { href: 'https://a9.lat/?mode=live&api=javascript:alert(1)' },
    `
      const { config } = await import(JS_URL + '/config.js');
      console.log(JSON.stringify({ apiBase: config.apiBase, rejected: config.apiOverrideRejected }));
    `,
  );
  assert.equal(badProto.apiBase, '');
  assert.equal(badProto.rejected, true);
});

test('Live mode blocks all wallet sends and fund order requests even with connected wallet', () => {
  const out = runScenario(
    {
      href: 'https://a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat' },
      sdkConnected: true,
    },
    `
      const { store } = await import(JS_URL + '/store.js');
      const { tonConnect } = await import(JS_URL + '/tonconnect.js');
      const { requestPromoClaimIntent, requestPresaleIntent, activatePredictionReward } = await import(JS_URL + '/data.js');

      store.update((s) => {
        s.round.stakingEnabled = true;
        s.round.protocolConfig = { contracts: { roundController: 'EQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCc8-' } };
      });
      tonConnect.init();

      const results = {};
      const tryCall = async (name, fn) => {
        try { await fn(); results[name] = 'ALLOWED'; }
        catch (e) { results[name] = e?.code || e?.message || 'ERR'; }
      };

      await tryCall('dispatch', () => tonConnect._dispatch({ validUntil: 9999999999, messages: [{ address: 'EQ_X', amount: '1000000000' }] }));
      await tryCall('sendStakeTransaction', () => tonConnect.sendStakeTransaction(100, 'EQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCc8-'));
      await tryCall('sendV15StakeA9', () => tonConnect.sendV15StakeA9({
        userJettonWallet: 'EQCzAIXCKhfHughvMdreCWrkRpxNtHSVoXjm5V0eKbLWG3kB',
        roundController: 'EQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCc8-',
        userAddress: '0:' + '11'.repeat(32),
        amountA9Raw: '1000000000000',
        roundId: 1,
      }));
      await tryCall('sendV15TicketClaim', () => tonConnect.sendV15TicketClaim('EQ_TICKET'));
      await tryCall('sendV15PromoFee', () => tonConnect.sendV15PromoFee({ payTo: 'EQ_PROMO', feeRequiredNano: '60000000', memo: 'claim:abc123' }));
      await tryCall('requestPromoClaimIntent', () => requestPromoClaimIntent('0:' + '11'.repeat(32)));
      await tryCall('requestPresaleIntent', () => requestPresaleIntent('0:' + '11'.repeat(32), 10));
      await tryCall('activatePredictionReward', () => activatePredictionReward('123', '0:' + '11'.repeat(32)));

      console.log(JSON.stringify({
        fundsEnabled: store.fundsEnabled,
        sdkConnected: tonConnect.ui?.connected,
        sendTransactionCalls: sdkCalls.sendTransaction,
        fetchCallsCount: fetchCalls.length,
        results,
        ls: localStorage._dump(),
      }));
    `,
  );

  assert.equal(out.fundsEnabled, false);
  assert.equal(out.sdkConnected, true);
  assert.equal(out.sendTransactionCalls, 0);
  assert.equal(out.fetchCallsCount, 0);
  for (const [k, v] of Object.entries(out.results)) {
    assert.equal(v, 'LIVE_FUNDS_DISABLED', `expected ${k} to throw LIVE_FUNDS_DISABLED, got ${v}`);
  }
  assert.deepEqual(Object.keys(out.ls), ['a9_ui_prefs_v1']);
  const prefs = JSON.parse(out.ls.a9_ui_prefs_v1);
  assert.deepEqual(Object.keys(prefs).sort(), ['settings', 'user']);
  assert.deepEqual(Object.keys(prefs.user).sort(), ['autoRenew', 'profileMode']);
});

test('Demo mode NEVER triggers real wallet sendTransaction even when wallet SDK is connected', () => {
  const out = runScenario(
    {
      href: 'http://127.0.0.1:8091/?mode=demo',
      sdkConnected: true,
    },
    `
      const { tonConnect } = await import(JS_URL + '/tonconnect.js');
      tonConnect.init();
      const r1 = await tonConnect.sendStakeTransaction(100, 'EQD_DEMO_A9_POOL');
      const r2 = await tonConnect.sendV15TicketClaim('EQD_DEMO_TICKET');
      const r3 = await tonConnect.sendV15PromoFee({ payTo: 'EQD_DEMO_PROMO', feeRequiredNano: '60000000', memo: 'claim:demo01' });
      const r4 = await tonConnect._dispatch({ validUntil: 9999999999, messages: [{ address: 'EQ_ANY', amount: '1000000000' }] });
      console.log(JSON.stringify({
        sdkConnected: tonConnect.ui?.connected,
        sendTransactionCalls: sdkCalls.sendTransaction,
        simFlags: [r1?.simulated, r2?.simulated, r3?.simulated, r4?.simulated],
        fetchCallsCount: fetchCalls.length,
      }));
    `,
  );

  assert.equal(out.sdkConnected, true);
  assert.equal(out.sendTransactionCalls, 0, 'demo mode MUST NOT invoke connected wallet sendTransaction');
  assert.deepEqual(out.simFlags, [true, true, true, true]);
  assert.equal(out.fetchCallsCount, 0);
});

test('Telegram deep-link parser sanitizes untrusted start_param values', () => {
  const out = runScenario(
    {
      href: 'https://a9.lat/?mode=live',
      startParam: 'proof_R03"><script>alert(1)</script>_ref$evil',
    },
    `
      const { A9TMA } = await import(JS_URL + '/tma.js');
      console.log(JSON.stringify(A9TMA.parseStartParam()));
    `,
  );
  assert.ok(out);
  assert.equal(/[<>"'$]/.test(out.id), false);
  assert.equal(/[<>"'$]/.test(out.ref), false);
  assert.equal(/[<>"'$]/.test(out.route), false);
});
