#!/usr/bin/env node
// A9 Protocol v15 — Batch A security & mode-isolation regression suite.
// Each test evaluates the real ESM module graph in a fresh Node subprocess to prevent module-cache cross-talk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
      const { requestPromoClaimIntent, requestPresaleIntent, activatePredictionReward, requestChestPurchaseIntent, openChestById } = await import(JS_URL + '/data.js');

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
      await tryCall('requestChestPurchaseIntent', () => requestChestPurchaseIntent({ walletAddress: '0:' + '11'.repeat(32), skuId: 'chest_bronze', openMode: 'BOOST' }));
      await tryCall('openChestById', () => openChestById('ch_live_test', null, '0:' + '11'.repeat(32)));
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

test('Live mode allows Plaza & Chest Mall read-only view when /api/config is healthy and /api/rounds is empty (no fake round data)', () => {
  const out = runScenario(
    {
      href: 'https://a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat' },
    },
    `
      globalThis.fetch = async (target) => {
        const u = String(target);
        if (u.endsWith('/api/config')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                ok: true,
                data: {
                  protocolVersion: 'v16',
                  network: 'mainnet',
                  presaleHotWallet: { enabled: true, open: false },
                  poolState: { dataAvailable: false, currentRoundId: null, poolRemainingRaw: null },
                  chestMall: { enabled: true, skus: [] },
                },
                ts: Date.now(),
              };
            },
          };
        }
        if (u.endsWith('/api/rounds')) {
          return { ok: true, status: 200, async json() { return { ok: true, data: [], ts: Date.now() }; } };
        }
        throw new Error('unexpected fetch: ' + u);
      };
      const { loadSnapshot, mapRoundView } = await import(JS_URL + '/data.js');
      const snap = await loadSnapshot();
      const view = mapRoundView(snap);
      console.log(JSON.stringify({
        hasConfig: Boolean(snap.config?.chestMall?.enabled),
        detail: snap.detail,
        stage: view.stage,
        currentRound: view.currentRound,
        targetPrice: view.targetPrice,
        twap24h: view.twap24h,
        rewardBudgetA9: view.rewardBudgetA9,
        poolAvailable: view.poolState?.dataAvailable,
      }));
    `,
  );
  assert.equal(out.hasConfig, true);
  assert.equal(out.detail, null);
  assert.equal(out.stage, null);
  assert.equal(out.currentRound, null);
  assert.equal(out.targetPrice, null);
  assert.equal(out.twap24h, null);
  assert.equal(out.rewardBudgetA9, null);
  assert.equal(out.poolAvailable, false);
});

test('W1: startapp parser preserves underscore TON addresses, supports gallery/chest, and marks nav tokens non-attribution', () => {
  const parse = (param) => runScenario(
    { href: `https://a9.lat/?mode=live&startapp=${encodeURIComponent(param)}` },
    `
      const { A9TMA } = await import(JS_URL + '/tma.js');
      console.log(JSON.stringify(A9TMA.parseStartParam()));
    `,
  );
  const invTon = parse('invite_UQAbc_def_123');
  assert.equal(invTon.type, 'invite');
  assert.equal(invTon.ref, 'UQAbc_def_123');
  assert.equal(invTon.isAttribution, true);

  const invTeam = parse('invite_TM-0001_UQAbc_def');
  assert.equal(invTeam.teamId, 'TM-0001');
  assert.equal(invTeam.ref, 'UQAbc_def');
  assert.equal(invTeam.isAttribution, true);

  const gal = parse('gallery_act-01_1001');
  assert.equal(gal.type, 'gallery');
  assert.equal(gal.route, '/gallery');
  assert.equal(gal.ref, '1001');
  assert.equal(gal.isAttribution, true);

  const navClaim = parse('claim');
  assert.equal(navClaim.route, '/claim');
  assert.equal(navClaim.isAttribution, false);
});

test('W1: localStorage only persists under single allowlisted key a9_ui_prefs_v1 (theme & sound migrated)', () => {
  const out = runScenario(
    { href: 'https://a9.lat/?mode=live' },
    `
      localStorage.setItem('a9_theme_mode', 'dark');
      localStorage.setItem('a9_sound_enabled', '1');
      const { store } = await import(JS_URL + '/store.js');
      const { A9Audio } = await import(JS_URL + '/audio.js');
      A9Audio.toggle();
      store.persistPrefs();
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) keys.push(localStorage.key(i));
      const prefs = JSON.parse(localStorage.getItem('a9_ui_prefs_v1') || '{}');
      console.log(JSON.stringify({ keys, themeMode: prefs?.settings?.themeMode, soundEnabled: prefs?.settings?.soundEnabled }));
    `,
  );
  assert.deepEqual(out.keys, ['a9_ui_prefs_v1']);
  assert.equal(out.themeMode, 'dark');
  assert.equal(out.soundEnabled, false);
});

test('W2: URL parameter cannot enable liveFundsEnabled; only explicit injected config activates all 4 live wallet flows', () => {
  // 1) Attempting ?liveFundsEnabled=1 in URL must stay disabled
  const blocked = runScenario(
    {
      href: 'https://a9.lat/?mode=live&liveFundsEnabled=1',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat' },
      sdkConnected: true,
    },
    `
      const { config } = await import(JS_URL + '/config.js');
      const { store } = await import(JS_URL + '/store.js');
      const { tonConnect } = await import(JS_URL + '/tonconnect.js');
      tonConnect.init();
      let code = null;
      try {
        await tonConnect.sendV15PresaleTx({ payTo: 'EQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCc8-', tonNano: '990000000', memo: 'buy:ord_1' });
      } catch (e) { code = e?.code || null; }
      console.log(JSON.stringify({ liveFundsEnabled: config.liveFundsEnabled, fundsEnabled: store.fundsEnabled, code, txCount: sdkCalls.sendTransaction }));
    `,
  );
  assert.equal(blocked.liveFundsEnabled, false);
  assert.equal(blocked.fundsEnabled, false);
  assert.equal(blocked.code, 'LIVE_FUNDS_DISABLED');
  assert.equal(blocked.txCount, 0);

  // 2) Explicit injected liveFundsEnabled: true enables all 4 real TON Connect wallet flows (and follows server v16 stake version)
  const enabled = runScenario(
    {
      href: 'https://a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat', liveFundsEnabled: true },
      sdkConnected: true,
      startParam: 'invite_100',
    },
    `
      const { config } = await import(JS_URL + '/config.js');
      const { store } = await import(JS_URL + '/store.js');
      const { tonConnect } = await import(JS_URL + '/tonconnect.js');
      const { requestChestPurchaseIntent, openChestById } = await import(JS_URL + '/data.js');

      store.update((s) => {
        s.round.protocolConfig = { protocolVersion: 'v16', stakeProtocolVersion: 'v16' };
      });
      tonConnect.init();

      const txs = [];
      const origSend = tonConnect.ui.sendTransaction.bind(tonConnect.ui);
      tonConnect.ui.sendTransaction = async (tx) => { txs.push(tx); return origSend(tx); };

      const rPresale = await tonConnect.sendV15PresaleTx({
        payTo: 'kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT18',
        tonNano: '990000000',
        memo: 'buy:ord_live_1',
      });
      const rPromo = await tonConnect.sendV15PromoFee({
        payTo: 'kQAZFnSDKMIwiflOo8YWiNweqnxTRuwejtg7qmic4pjf1rIP',
        feeRequiredNano: '60000000',
        memo: 'claim:cl_live_1',
      });
      const rStake = await tonConnect.sendV15StakeA9({
        userJettonWallet: 'kQAZFnSDKMIwiflOo8YWiNweqnxTRuwejtg7qmic4pjf1rIP',
        roundController: 'kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT18',
        userAddress: '0:' + '11'.repeat(32),
        amountA9Raw: '1000000000000',
        roundId: 256,
      });
      const rClaim = await tonConnect.sendV15TicketClaim('kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT18');

      await requestChestPurchaseIntent({ walletAddress: '0:' + '11'.repeat(32), skuId: 'chest_bronze', openMode: 'BOOST' });
      await openChestById('ch_live_1', null, '0:' + '11'.repeat(32));

      console.log(JSON.stringify({
        liveFundsEnabled: config.liveFundsEnabled,
        fundsEnabled: store.fundsEnabled,
        txCount: sdkCalls.sendTransaction,
        simulatedFlags: [rPresale.simulated, rPromo.simulated, rStake.simulated, rClaim.simulated],
        amounts: txs.map((t) => t.messages[0].amount),
        fetchUrls: fetchCalls.map((f) => f.url),
      }));
    `,
  );

  assert.equal(enabled.liveFundsEnabled, true);
  assert.equal(enabled.fundsEnabled, true);
  assert.equal(enabled.txCount, 4);
  assert.deepEqual(enabled.simulatedFlags, [false, false, false, false]);
  assert.deepEqual(enabled.amounts, ['990000000', '60000000', '300000000', '220000000']);
  assert.ok(enabled.fetchUrls.some((u) => u.endsWith('/api/presale/intent')));
  assert.ok(enabled.fetchUrls.some((u) => u.endsWith('/api/chests/ch_live_1/open')));
});

test('P1-5: /market alias route exists, share.js uses protocolConfig.botHandle, and cancelWarmup posts /api/warmup/cancel', () => {
  const routerSrc = readFileSync(join(JS_DIR, 'router.js'), 'utf8');
  assert.match(routerSrc, /path:\s*'\/market'[^}]*render:\s*renderInternalMarket/);

  const out = runScenario(
    {
      href: 'https://a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat' },
    },
    `
      const { store } = await import(JS_URL + '/store.js');
      const { buildTmaDeepLink } = await import(JS_URL + '/share.js');
      const { cancelWarmup } = await import(JS_URL + '/data.js');

      store.update((s) => {
        s.round.protocolConfig = { botHandle: 'A9OfficialTestBot' };
      });
      const deepLink = buildTmaDeepLink('invite_999');
      await cancelWarmup({ roundId: 4, walletAddress: '0:' + '11'.repeat(32), userId: 'tg_999' });

      console.log(JSON.stringify({
        deepLink,
        lastFetch: fetchCalls[fetchCalls.length - 1],
      }));
    `,
  );
  assert.equal(out.deepLink, 'https://t.me/A9OfficialTestBot?startapp=invite_999');
  assert.ok(out.lastFetch.url.endsWith('/api/warmup/cancel'));
  assert.equal(out.lastFetch.method, 'POST');
});

test('Phase 0: liveRound(/round) preserves staking gate across read-only, closed window, and open participation', () => {
  const domStub = `
      const stubEl = () => ({
        addEventListener() {},
        classList: { add() {}, remove() {}, toggle() {} },
        querySelector: () => ({ onclick: null, style: {}, classList: { add() {}, remove() {}, toggle() {} }, textContent: '' }),
        querySelectorAll: () => [],
        set innerHTML(_v) {},
        style: {},
        dataset: {},
      });
      globalThis.window.addEventListener = () => {};
      globalThis.window.scrollTo = () => {};
      globalThis.document.getElementById = () => stubEl();
      globalThis.document.body = { dataset: {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } };
      globalThis.requestAnimationFrame = () => 0;
      globalThis.setInterval = () => 0;
  `;
  // 1) Read-only live mode (liveFundsEnabled=false): button stays disabled even during participation
  const readOnly = runScenario(
    {
      href: 'https://a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat', liveFundsEnabled: false },
    },
    `
      ${domStub}
      const { liveRound } = await import(JS_URL + '/pages/wealthverse.js');
      const html = liveRound({ currentRound: 1, stage: 'participation', stakeOpenAt: 1700000000, stakeCloseAt: 1700086400, candles: [] });
      console.log(JSON.stringify({
        hasStakeHref: html.includes('href="#/challenge/confirm"'),
        hasDisabledBtn: html.includes('disabled>'),
      }));
    `,
  );
  assert.equal(readOnly.hasStakeHref, false);
  assert.equal(readOnly.hasDisabledBtn, true);

  // 2) liveFundsEnabled=true: opens #/challenge/confirm ONLY during participation, stays disabled during observation
  const liveEnabled = runScenario(
    {
      href: 'https://a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat', liveFundsEnabled: true },
    },
    `
      ${domStub}
      const { liveRound } = await import(JS_URL + '/pages/wealthverse.js');
      const htmlPart = liveRound({ currentRound: 1, stage: 'participation', stakeOpenAt: 1700000000, stakeCloseAt: 1700086400, candles: [] });
      const htmlObs = liveRound({ currentRound: 1, stage: 'observation', stakeOpenAt: 1700000000, stakeCloseAt: 1700086400, candles: [] });
      console.log(JSON.stringify({
        partHasStakeHref: htmlPart.includes('href="#/challenge/confirm"'),
        partHasDisabledBtn: htmlPart.includes('disabled>'),
        obsHasStakeHref: htmlObs.includes('href="#/challenge/confirm"'),
        obsHasDisabledBtn: htmlObs.includes('disabled>'),
      }));
    `,
  );
  assert.equal(liveEnabled.partHasStakeHref, true);
  assert.equal(liveEnabled.partHasDisabledBtn, false);
  assert.equal(liveEnabled.obsHasStakeHref, false);
  assert.equal(liveEnabled.obsHasDisabledBtn, true);
});

test('P0-1 / P0-4 / P0-5: default v16 config, live Chest Mall never falls back to DEMO_CHEST_SKUS, and stake unit is A9', () => {
  const out = runScenario(
    {
      href: 'https://a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat', liveFundsEnabled: false },
    },
    `
      const { config } = await import(JS_URL + '/config.js');
      const { store } = await import(JS_URL + '/store.js');
      const { renderInternalMarket } = await import(JS_URL + '/pages/warmup_market.js');
      // Simulate server response WITHOUT chestMall.skus
      store.update((s) => { s.round.chestMall = null; });
      const root = {
        isConnected: true,
        innerHTML: '',
        querySelector() { return null; },
        querySelectorAll() { return []; },
      };
      renderInternalMarket(root, () => {});
      console.log(JSON.stringify({
        stakeProto: config.stakeProtocolVersion,
        hasUnavailableCard: root.innerHTML.includes('live-chest-skus-unavailable'),
        leakedDemoPrice: root.innerHTML.includes('0.99 GRAM</span>'),
      }));
    `,
  );
  assert.equal(out.stakeProto, 'v16');
  assert.equal(out.hasUnavailableCard, true);
  assert.equal(out.leakedDemoPrice, false);

  const wvSrc = readFileSync(join(JS_DIR, 'pages', 'wealthverse.js'), 'utf8');
  const rhSrc = readFileSync(join(JS_DIR, 'pages', 'round_hub.js'), 'utf8');
  const pfSrc = readFileSync(join(JS_DIR, 'pages', 'profile.js'), 'utf8');
  assert.match(wvSrc, /(?:最低|≥)\s*1,000 A9/);
  assert.doesNotMatch(wvSrc, /最低 10 GRAM/);
  assert.doesNotMatch(rhSrc, /最低参与 10 GRAM/);
  assert.doesNotMatch(pfSrc, /最低 10 GRAM/);
});

test('Strict CSP guardrail: index.html has zero inline <script> blocks and _headers removes script-src unsafe-inline', () => {
  const miniAppDir = dirname(JS_DIR);
  const indexHtml = readFileSync(join(miniAppDir, 'index.html'), 'utf8');
  const scriptMatches = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scriptMatches.length >= 4, 'expected at least 4 external <script> tags');
  for (const [, attrs, body] of scriptMatches) {
    assert.match(attrs, /\bsrc\s*=\s*["'][^"']+["']/i, `<script> missing src attribute: ${attrs}`);
    assert.equal(body.trim(), '', `inline <script> body must be empty, found: ${body.trim().slice(0, 40)}`);
  }
  assert.match(indexHtml, /<script\s+src="\.\/js\/theme-init\.js"><\/script>/);
  assert.match(indexHtml, /<script\s+src="\.\/js\/runtime-config\.js"><\/script>/);

  const headersTxt = readFileSync(join(miniAppDir, '_headers'), 'utf8');
  const cspMatch = headersTxt.match(/Content-Security-Policy:\s*([^\r\n]+)/i);
  assert.ok(cspMatch, 'Content-Security-Policy header missing');
  const scriptSrcMatch = cspMatch[1].match(/script-src\s+([^;]+)/i);
  assert.ok(scriptSrcMatch, 'script-src directive missing in CSP');
  assert.doesNotMatch(scriptSrcMatch[1], /'unsafe-inline'/i, 'script-src must not allow unsafe-inline');
});

test('Wave 2: shouldDeferRouteRender, buildTonviewerUrl, pendingTxManager (sessionStorage-only), confirmBeforeSign & manifests', () => {
  const miniAppDir = dirname(JS_DIR);
  const a9Meta = JSON.parse(readFileSync(join(miniAppDir, 'a9.json'), 'utf8'));
  const tcManifest = JSON.parse(readFileSync(join(miniAppDir, 'tonconnect-manifest.json'), 'utf8'));
  assert.equal(tcManifest.url, 'https://app.a9.lat');
  assert.ok(Array.isArray(a9Meta.websites) && a9Meta.websites.includes(tcManifest.url));
  assert.equal(a9Meta.image, 'https://app.a9.lat/assets/token/a9-token-2048.png');
  assert.equal(tcManifest.iconUrl, a9Meta.image);
  assert.ok(readFileSync(join(miniAppDir, 'assets', 'token', 'a9-token-2048.png')).byteLength > 1024);

  const appSrc = readFileSync(join(JS_DIR, 'app.js'), 'utf8');
  assert.match(appSrc, /shouldDeferRouteRender/);
  assert.match(appSrc, /pendingDeferredRender/);

  const out = runScenario(
    {
      href: 'https://app.a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat', liveFundsEnabled: true },
    },
    `
      const { store } = await import(JS_URL + '/store.js');
      const { tonConnect } = await import(JS_URL + '/tonconnect.js');
      const {
        shouldDeferRouteRender,
        buildTonviewerUrl,
        pendingTxManager,
        SESSION_PENDING_TX_KEY,
        renderPendingTxBannerHtml,
      } = await import(JS_URL + '/tx-ux.js');

      store.persistPrefs();

      const mkClassList = (hidden) => ({ contains: (c) => c === 'hidden' && hidden, add() {}, remove() {} });
      const idleDoc = {
        getElementById: (id) => id === 'modal-root' || id === 'sim-drawer' ? { classList: mkClassList(true) } : null,
        activeElement: { tagName: 'BODY' },
      };
      const modalOpenDoc = {
        getElementById: (id) => id === 'modal-root' ? { classList: mkClassList(false) } : { classList: mkClassList(true) },
        activeElement: { tagName: 'BODY' },
      };
      const drawerOpenDoc = {
        getElementById: (id) => id === 'sim-drawer' ? { classList: mkClassList(false) } : { classList: mkClassList(true) },
        activeElement: { tagName: 'BODY' },
      };
      const inputFocusedDoc = {
        getElementById: () => ({ classList: mkClassList(true) }),
        activeElement: { tagName: 'INPUT' },
      };

      const deferChecks = {
        idle: shouldDeferRouteRender(idleDoc),
        modal: shouldDeferRouteRender(modalOpenDoc),
        drawer: shouldDeferRouteRender(drawerOpenDoc),
        input: shouldDeferRouteRender(inputFocusedDoc),
      };

      const addr = 'UQBqTR8EYSz-uNKIBODC-3z0vOFlqoBGzLJb38wJOvCuiwbX';
      const mainnetUrl = buildTonviewerUrl(addr, 'mainnet');
      const testnetUrl = buildTonviewerUrl(addr, 'testnet');

      // 模拟 DOM 弹窗节点测试 tonConnect.confirmBeforeSign 的拦截与放行行为
      const modalEls = new Map();
      const modalRootEl = {
        classList: { add() { this.hidden = true; }, remove() { this.hidden = false; }, contains(c) { return c === 'hidden' && Boolean(this.hidden); } },
        set innerHTML(html) {
          this._html = String(html);
          const okDisabled = /id="tx-confirm-ok"[^>]*disabled/.test(this._html);
          modalEls.set('tx-confirm-ok', { disabled: okDisabled, onclick: null });
          modalEls.set('tx-confirm-cancel', { onclick: null });
          modalEls.set('tx-confirm-close', { onclick: null });
          modalEls.set('tx-confirm-copy-addr', { onclick: null });
        },
        get innerHTML() { return this._html || ''; },
      };
      globalThis.document.getElementById = (id) => (id === 'modal-root' ? modalRootEl : modalEls.get(id) || null);

      const pBlocked = tonConnect.confirmBeforeSign({
        title: 'Confirm',
        targetAddress: addr,
        principalText: '1,000 A9',
        gasText: '0.30 GRAM',
        totalText: '1,000 A9 + 0.30 GRAM',
        insufficientReason: '余额不足',
      });
      const blockedHasAlert = modalRootEl.innerHTML.includes('余额不足') && modalRootEl.innerHTML.includes('tonviewer.com/' + addr);
      const blockedOkDisabled = Boolean(modalEls.get('tx-confirm-ok')?.disabled);
      modalEls.get('tx-confirm-cancel')?.onclick?.();
      const blockedResolved = await pBlocked;

      const pAccepted = tonConnect.confirmBeforeSign({
        title: 'Confirm',
        targetAddress: addr,
        principalText: '1,000 A9',
        gasText: '0.30 GRAM',
        totalText: '1,000 A9 + 0.30 GRAM',
      });
      const acceptedOkDisabled = Boolean(modalEls.get('tx-confirm-ok')?.disabled);
      modalEls.get('tx-confirm-ok')?.onclick?.();
      const acceptedResolved = await pAccepted;

      // Pending 状态机生命周期：signed -> confirming -> confirmed & timeout，绝不写 localStorage
      const statuses = [];
      const unsub = pendingTxManager.subscribe((tx) => statuses.push(tx ? tx.status : 'cleared'));
      const started = pendingTxManager.start({
        kind: 'stake',
        title: '质押测试',
        titleEn: 'Stake Test',
        amountText: '1,000 A9',
        explorerAddress: addr,
      });
      const lockedDuringSigned = pendingTxManager.isLocked('stake');
      const pollConfirmed = await pendingTxManager.pollUntilConfirmed({
        txId: started.id,
        intervalMs: 1,
        maxAttempts: 5,
        checkFn: async (attempt) => attempt >= 2,
      });
      const lockedAfterConfirmed = pendingTxManager.isLocked('stake');
      const sessionRaw = sessionStorage.getItem(SESSION_PENDING_TX_KEY);
      const bannerConfirmed = renderPendingTxBannerHtml(pendingTxManager.getActive(), 'mainnet');

      const started2 = pendingTxManager.start({ kind: 'claim', title: '领奖测试', explorerAddress: addr });
      const pollTimeout = await pendingTxManager.pollUntilConfirmed({
        txId: started2.id,
        intervalMs: 1,
        maxAttempts: 2,
        checkFn: async () => false,
      });
      const lockedAfterTimeout = pendingTxManager.isLocked('claim');
      const finalActiveStatus = pendingTxManager.getActive()?.status;
      unsub();

      console.log(JSON.stringify({
        deferChecks,
        mainnetUrl,
        testnetUrl,
        blockedHasAlert,
        blockedOkDisabled,
        blockedResolved,
        acceptedOkDisabled,
        acceptedResolved,
        statuses,
        lockedDuringSigned,
        pollConfirmedOk: pollConfirmed.confirmed,
        lockedAfterConfirmed,
        hasSessionKey: Boolean(sessionRaw),
        sessionParsedKind: JSON.parse(sessionRaw || '{}').kind || null,
        bannerHasTonviewer: bannerConfirmed.includes('https://tonviewer.com/' + addr),
        pollTimeoutFlag: Boolean(pollTimeout.timeout),
        lockedAfterTimeout,
        finalActiveStatus,
        lsKeys: Object.keys(localStorage._dump()),
        ssKeys: Object.keys(sessionStorage._dump()),
      }));
    `,
  );

  assert.deepEqual(out.deferChecks, { idle: false, modal: true, drawer: true, input: true });
  assert.match(out.mainnetUrl, /^https:\/\/tonviewer\.com\/UQ/);
  assert.match(out.testnetUrl, /^https:\/\/testnet\.tonviewer\.com\/UQ/);
  assert.equal(out.blockedHasAlert, true);
  assert.equal(out.blockedOkDisabled, true);
  assert.equal(out.blockedResolved, false);
  assert.equal(out.acceptedOkDisabled, false);
  assert.equal(out.acceptedResolved, true);
  assert.equal(out.lockedDuringSigned, true);
  assert.equal(out.pollConfirmedOk, true);
  assert.equal(out.lockedAfterConfirmed, false);
  assert.equal(out.hasSessionKey, true);
  assert.equal(out.sessionParsedKind, 'stake');
  assert.equal(out.bannerHasTonviewer, true);
  assert.equal(out.pollTimeoutFlag, true);
  assert.equal(out.lockedAfterTimeout, false);
  assert.equal(out.finalActiveStatus, 'timeout');
  assert.ok(out.statuses.includes('signed'));
  assert.ok(out.statuses.includes('confirming'));
  assert.ok(out.statuses.includes('confirmed'));
  assert.ok(out.statuses.includes('timeout'));
  assert.deepEqual(out.lsKeys, ['a9_ui_prefs_v1']);
  assert.deepEqual(out.ssKeys, ['a9_pending_tx_v1']);
});

