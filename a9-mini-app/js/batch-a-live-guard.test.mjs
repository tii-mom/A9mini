#!/usr/bin/env node
// A9 Protocol v15 — Batch A security & mode-isolation regression suite.
// Each test evaluates the real ESM module graph in a fresh Node subprocess to prevent module-cache cross-talk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
const sdkCalls = { openModal: 0, disconnect: 0, sendTransaction: 0, lastTx: null, constructed: 0, setConnectParams: 0 };
const fetchCalls = [];
const createdElements = [];
if (opts.storageSeed) for (const [k, v] of Object.entries(opts.storageSeed)) localStorage.setItem(k, v);

class FakeTonConnectUI {
  constructor(initOpts) {
    sdkCalls.constructed += 1;
    this.opts = initOpts;
    this.connected = Boolean(opts.sdkConnected);
    this.uiOptions = {};
    this._cb = null;
  }
  setConnectRequestParameters() { sdkCalls.setConnectParams += 1; }
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
  createElement: (tag) => { createdElements.push(String(tag)); return { className: '', style: {}, setAttribute() {}, remove() {}, querySelector: () => null }; },
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
      await tryCall('sendV15TicketClaimInstant', () => tonConnect.sendV15TicketClaim('EQ_TICKET', 99n, { instantDiscount: true }));
      await tryCall('sendV17TicketEarlyExit', () => tonConnect.sendV17TicketEarlyExit('EQ_TICKET'));
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
                  protocolVersion: 'v17',
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
  assert.equal(invTeam.route, '/team?invite=TM-0001');
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

  // 2) Explicit injected liveFundsEnabled: true enables all real TON Connect wallet flows (including v17 EarlyExit & Instant Cashout)
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
        s.round.protocolConfig = { protocolVersion: 'v17', stakeProtocolVersion: 'v17' };
      });
      tonConnect.init();
      // 等待 init() 触发的异步 _verifyOwnership 微任务完成，避免后续与测试状态设置产生竞态
      await new Promise((r) => setTimeout(r, 10));

      // expectedChain 为空（未注入 network 且未同步 /api/config.network）时必须先以 WRONG_WALLET_NETWORK 阻断
      let missingExpectedChainCode = null;
      try {
        await tonConnect.sendV15PresaleTx({
          payTo: 'kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT18',
          tonNano: '990000000',
          memo: 'buy:ord_noexpectedchain',
        });
      } catch (e) { missingExpectedChainCode = e?.code || null; }
      if (missingExpectedChainCode !== 'WRONG_WALLET_NETWORK') {
        throw new Error('Expected WRONG_WALLET_NETWORK on missing expectedChain, got: ' + missingExpectedChainCode);
      }

      // 注入服务端协议网络 testnet 后，钱包未上报 chain（空 walletChain）时仍以 WRONG_WALLET_NETWORK 阻断
      store.update((s) => { s.round.protocolConfig.network = 'testnet'; });
      let emptyChainCode = null;
      try {
        await tonConnect.sendV15PresaleTx({
          payTo: 'kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT18',
          tonNano: '990000000',
          memo: 'buy:ord_nochain',
        });
      } catch (e) { emptyChainCode = e?.code || null; }
      if (emptyChainCode !== 'WRONG_WALLET_NETWORK') {
        throw new Error('Expected WRONG_WALLET_NETWORK on empty chain, got: ' + emptyChainCode);
      }

      store.update((s) => { s.user.walletChain = '-3'; });

      // 未完成 ton_proof 归属验证时，_dispatch 必须直接拦截（防 TOCTOU 绕过）
      let unverifiedCode = null;
      try {
        await tonConnect.sendV15PresaleTx({
          payTo: 'kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT18',
          tonNano: '990000000',
          memo: 'buy:ord_unverified',
        });
      } catch (e) { unverifiedCode = e?.code || null; }
      if (unverifiedCode !== 'WALLET_NOT_VERIFIED') {
        throw new Error('Expected WALLET_NOT_VERIFIED before ton_proof, got: ' + unverifiedCode);
      }

      store.update((s) => {
        s.user.walletVerified = true;
        s.user.walletVerificationState = 'fresh_proof';
      });

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
      const rInstant = await tonConnect.sendV15TicketClaim('kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT18', 101n, { instantDiscount: true });
      const rEarlyExit = await tonConnect.sendV17TicketEarlyExit('kQDo-Kai2-tgKj_AErlFDfDyiA0jO2U4RvJaX45OykVMCT18', 102n);

      await requestChestPurchaseIntent({ walletAddress: '0:' + '11'.repeat(32), skuId: 'chest_bronze', openMode: 'BOOST' });
      await openChestById('ch_live_1', null, '0:' + '11'.repeat(32));

      console.log(JSON.stringify({
        liveFundsEnabled: config.liveFundsEnabled,
        fundsEnabled: store.fundsEnabled,
        txCount: sdkCalls.sendTransaction,
        simulatedFlags: [rPresale.simulated, rPromo.simulated, rStake.simulated, rClaim.simulated, rInstant.simulated, rEarlyExit.simulated],
        amounts: txs.map((t) => t.messages[0].amount),
        fetchUrls: fetchCalls.map((f) => f.url),
      }));
    `,
  );

  assert.equal(enabled.liveFundsEnabled, true);
  assert.equal(enabled.fundsEnabled, true);
  assert.equal(enabled.txCount, 6);
  assert.deepEqual(enabled.simulatedFlags, [false, false, false, false, false, false]);
  assert.deepEqual(enabled.amounts, ['990000000', '60000000', '300000000', '220000000', '340000000', '340000000']);
  assert.ok(enabled.fetchUrls.some((u) => u.endsWith('/api/presale/intent')));
  assert.ok(enabled.fetchUrls.some((u) => u.endsWith('/api/chests/ch_live_1/open')));
});

test('P1-5: /market alias route exists, share.js uses protocolConfig.botHandle, and cancelWarmup posts /api/warmup/cancel', () => {
  const routerSrc = readFileSync(join(JS_DIR, 'router.js'), 'utf8');
  assert.match(routerSrc, /path:\s*'\/market'[^}]*load:[^}]*m\.renderInternalMarket/);

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

test('P0-1 / P0-4 / P0-5: default v17 config, live Chest Mall never falls back to DEMO_CHEST_SKUS, and stake unit is A9', () => {
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
  assert.equal(out.stakeProto, 'v17');
  assert.equal(out.hasUnavailableCard, true);
  assert.equal(out.leakedDemoPrice, false);

  const wvSrc = readFileSync(join(JS_DIR, 'pages', 'wealthverse.js'), 'utf8');
  const rhSrc = readFileSync(join(JS_DIR, 'pages', 'round_hub.js'), 'utf8');
  const pfSrc = readFileSync(join(JS_DIR, 'pages', 'profile.js'), 'utf8');
  assert.match(wvSrc, /(?:最低|≥|100 A9 起)/);
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

test('PROTOCOL_SPECS single source of truth & Live renderRiskAudit invariants check', () => {
  const collectJsFiles = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (entry === 'vendor') continue;
      const st = statSync(p);
      if (st.isDirectory()) out.push(...collectJsFiles(p));
      else if (entry.endsWith('.js')) out.push(p);
    }
    return out;
  };
  const jsFiles = collectJsFiles(JS_DIR);
  const referencedKeys = [];
  for (const file of jsFiles) {
    const txt = readFileSync(file, 'utf8');
    for (const m of txt.matchAll(/\bPROTOCOL_SPECS\.([A-Za-z0-9_]+)/g)) {
      referencedKeys.push({ file, key: m[1] });
    }
  }
  assert.ok(referencedKeys.length > 0, 'expected PROTOCOL_SPECS references');

  const out = runScenario(
    {
      href: 'https://app.a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat', liveFundsEnabled: false },
    },
    `
      const mkNode = () => ({
        addEventListener() {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return true; } },
        querySelector: (sel) => (sel === '#btn-wallet-pill' || sel === '#dock-pill' ? mkNode() : null),
        querySelectorAll: () => [],
        insertAdjacentHTML() {},
        setAttribute() {},
        getAttribute() { return null; },
        remove() {},
        set innerHTML(_v) {},
        style: {},
        dataset: {},
        textContent: '',
        onclick: null,
        animate: () => ({ finished: Promise.resolve() }),
      });
      const stubEl = mkNode;
      globalThis.window.addEventListener = () => {};
      globalThis.window.scrollTo = () => {};
      Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
      globalThis.document = {
        documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' },
        body: { dataset: {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => stubEl(),
        addEventListener: () => {},
        createElement: () => stubEl(),
      };
      globalThis.requestAnimationFrame = () => 0;
      globalThis.setInterval = () => 0;
      globalThis.fetch = async (target) => {
        const u = String(target);
        if (u.endsWith('/api/config')) {
          return { ok: true, status: 200, async json() { return { ok: true, data: { protocolVersion: 'v17', network: 'mainnet', poolState: { dataAvailable: true, currentRoundId: 1, poolRemainingRaw: '7000000000000000000' } }, ts: Date.now() }; } };
        }
        return { ok: true, status: 200, async json() { return { ok: true, data: [], ts: Date.now() }; } };
      };

      const { PROTOCOL_SPECS } = await import(JS_URL + '/data.js');
      const { store } = await import(JS_URL + '/store.js');
      const { renderRiskAudit } = await import(JS_URL + '/pages/system.js');
      const { renderPlazaCompactBanner, renderPendingVaultBanner } = await import(JS_URL + '/pages/round_stages.js');

      store.update((s) => {
        s.settings.language = 'zh-CN';
        s.round.protocolConfig = {
          network: 'mainnet',
          contracts: { roundController: 'UQBqTR8EYSz-uNKIBODC-3z0vOFlqoBGzLJb38wJOvCuiwbX' },
        };
        s.round.poolState = { poolRemainingRaw: '7000000000000000000' };
      });

      const refList = ${JSON.stringify(referencedKeys)};
      const missingKeys = refList
        .filter((item) => PROTOCOL_SPECS[item.key] === undefined)
        .map((item) => item.file + ':' + item.key);

      const auditRoot = { isConnected: true, innerHTML: '', querySelector() { return null; } };
      renderRiskAudit(auditRoot);

      store.update((s) => {
        s.round.protocolConfig = {
          network: 'testnet',
          contracts: { roundController: 'kQCqh657Pt1LpQQWpherJOWcz6YG-wS_xpGFLMcRLxROgpm_', adminRenounced: true },
        };
        s.round.poolState = { dataAvailable: true, poolRemainingRaw: '7000000000000000000' };
      });
      const verifiedAuditRoot = { isConnected: true, innerHTML: '', querySelector() { return null; } };
      renderRiskAudit(verifiedAuditRoot);

      store.update((s) => {
        s.round.protocolConfig = { network: 'mainnet', contracts: {} };
        s.round.poolState = null;
      });
      const pendingAuditRoot = { isConnected: true, innerHTML: '', querySelector() { return null; } };
      renderRiskAudit(pendingAuditRoot);

      const compactBanner = renderPlazaCompactBanner({ pendingActivationRaw: '300000000000', loaded: true }, {});
      const vaultBanner = renderPendingVaultBanner({ pendingActivationRaw: '300000000000', loaded: true }, {});

      console.log(JSON.stringify({
        missingKeys,
        hasCap: auditRoot.innerHTML.includes('550,000,000 A9'),
        hasRules: auditRoot.innerHTML.includes('8/12 · 5× · 6%'),
        hasUndefined: /\\bundefined\\b/.test(auditRoot.innerHTML),
        unverifiedRcHasRenounced: auditRoot.innerHTML.includes('已弃权'),
        verifiedAuditHasRenounced: verifiedAuditRoot.innerHTML.includes('已弃权'),
        pendingAuditHasWait: pendingAuditRoot.innerHTML.includes('待核验'),
        pendingAuditHasRenounced: pendingAuditRoot.innerHTML.includes('已弃权'),
        compactExact: compactBanner.includes('1,800 A9'),
        vaultExact: vaultBanner.includes('1,800 A9'),
      }));
    `,
  );

  assert.deepEqual(out.missingKeys, []);
  assert.equal(out.hasCap, true);
  assert.equal(out.hasRules, true);
  assert.equal(out.hasUndefined, false);
  assert.equal(out.unverifiedRcHasRenounced, false);
  assert.equal(out.verifiedAuditHasRenounced, true);
  assert.equal(out.pendingAuditHasWait, true);
  assert.equal(out.pendingAuditHasRenounced, false);
  assert.equal(out.compactExact, true);
  assert.equal(out.vaultExact, true);
});

test('PendingTxManager degrades in-flight signed/confirming session tx to timeout on cold reload', () => {
  const out = runScenario(
    {
      href: 'https://app.a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat', liveFundsEnabled: false },
    },
    `
      const { PendingTxManager, renderPendingTxBannerHtml, SESSION_PENDING_TX_KEY } = await import(JS_URL + '/tx-ux.js');
      const addr = 'UQBqTR8EYSz-uNKIBODC-3z0vOFlqoBGzLJb38wJOvCuiwbX';
      const now = Date.now();

      sessionStorage.setItem(SESSION_PENDING_TX_KEY, JSON.stringify({
        id: 'stake_reload_1',
        kind: 'stake',
        title: '质押测试',
        titleEn: 'Stake Test',
        explorerAddress: addr,
        status: 'signed',
        attempt: 0,
        maxAttempts: 12,
        startedAt: now - 5000,
        updatedAt: now - 5000,
      }));
      const mgr1 = new PendingTxManager();
      const act1 = mgr1.getActive();
      const locked1 = mgr1.isLocked('stake');
      const stored1 = JSON.parse(sessionStorage.getItem(SESSION_PENDING_TX_KEY) || '{}');
      const html1 = renderPendingTxBannerHtml(act1, 'mainnet');

      sessionStorage.setItem(SESSION_PENDING_TX_KEY, JSON.stringify({
        id: 'claim_reload_2',
        kind: 'claim',
        title: '领奖测试',
        titleEn: 'Claim Test',
        explorerAddress: addr,
        status: 'confirming',
        attempt: 4,
        maxAttempts: 12,
        startedAt: now - 8000,
        updatedAt: now - 1000,
      }));
      const mgr2 = new PendingTxManager();
      const act2 = mgr2.getActive();
      const locked2 = mgr2.isLocked();

      console.log(JSON.stringify({
        status1: act1?.status,
        storedStatus1: stored1?.status,
        locked1,
        hasTonviewer: html1.includes('https://tonviewer.com/' + addr),
        hasDismiss: html1.includes('id="btn-dismiss-pending-tx"'),
        hasReloadDetail: html1.includes('页面已重新加载'),
        status2: act2?.status,
        locked2,
      }));
    `,
  );

  assert.equal(out.status1, 'timeout');
  assert.equal(out.storedStatus1, 'timeout');
  assert.equal(out.locked1, false);
  assert.equal(out.hasTonviewer, true);
  assert.equal(out.hasDismiss, true);
  assert.equal(out.hasReloadDetail, true);
  assert.equal(out.status2, 'timeout');
  assert.equal(out.locked2, false);
});

test('Settings page disables hourlyCandlePush in Live mode and syncs settlementPush via /api/me/notifications', () => {
  const nonTgOut = runScenario(
    {
      href: 'https://app.a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat', liveFundsEnabled: false },
    },
    `
      const mkNode = () => ({
        addEventListener() {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return true; } },
        querySelector: (sel) => (sel === '#btn-wallet-pill' || sel === '#dock-pill' ? mkNode() : null),
        querySelectorAll: () => [],
        insertAdjacentHTML() {},
        setAttribute() {},
        getAttribute() { return null; },
        remove() {},
        set innerHTML(_v) {},
        style: {},
        dataset: {},
        textContent: '',
        onclick: null,
        animate: () => ({ finished: Promise.resolve() }),
      });
      globalThis.window.addEventListener = () => {};
      globalThis.window.scrollTo = () => {};
      Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
      globalThis.document = {
        documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' },
        body: { dataset: {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => mkNode(),
        addEventListener: () => {},
        createElement: () => mkNode(),
      };
      globalThis.requestAnimationFrame = () => 0;
      globalThis.setInterval = () => 0;

      const { store } = await import(JS_URL + '/store.js');
      const { renderSettingsPage, resetLiveNotificationCacheForTest } = await import(JS_URL + '/pages/system.js');
      store.update((s) => { s.settings.language = 'zh-CN'; });
      resetLiveNotificationCacheForTest();
      const root = {
        isConnected: true,
        innerHTML: '',
        querySelector() { return null; },
        querySelectorAll() { return []; },
      };
      renderSettingsPage(root);
      console.log(JSON.stringify({
        hourlyDisabled: /id="set-hourly-push-switch"[^>]*disabled/.test(root.innerHTML) || root.innerHTML.includes('id="set-hourly-push-switch" role="switch" aria-checked="false" aria-disabled="true"'),
        hourlyText: root.innerHTML.includes('个人整点推送暂未开放'),
        settleDisabledNonTg: /class="a9-switch disabled" id="set-settlement-push-switch"/.test(root.innerHTML),
        settleNonTgHint: root.innerHTML.includes('请在 Telegram 小程序内打开以管理结算私聊提醒'),
        notifFetchCount: fetchCalls.filter((c) => String(c.url).includes('/api/me/notifications')).length,
      }));
    `,
  );

  assert.equal(nonTgOut.hourlyText, true);
  assert.equal(nonTgOut.hourlyDisabled, true);
  assert.equal(nonTgOut.settleDisabledNonTg, true);
  assert.equal(nonTgOut.settleNonTgHint, true);
  assert.equal(nonTgOut.notifFetchCount, 0);

  const tgOut = runScenario(
    {
      href: 'https://app.a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat', liveFundsEnabled: false },
      startParam: 'market',
    },
    `
      const mkNode = () => ({
        addEventListener() {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return true; } },
        querySelector: (sel) => (sel === '#btn-wallet-pill' || sel === '#dock-pill' ? mkNode() : null),
        querySelectorAll: () => [],
        insertAdjacentHTML() {},
        appendChild() {},
        replaceWith() {},
        setAttribute() {},
        getAttribute() { return null; },
        remove() {},
        set innerHTML(_v) {},
        style: {},
        dataset: {},
        textContent: '',
        onclick: null,
        animate: () => ({ finished: Promise.resolve() }),
      });
      globalThis.window.addEventListener = () => {};
      globalThis.window.scrollTo = () => {};
      Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
      globalThis.document = {
        documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' },
        body: { dataset: {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => mkNode(),
        addEventListener: () => {},
        createElement: () => mkNode(),
      };
      globalThis.requestAnimationFrame = () => 0;
      globalThis.setInterval = () => 0;

      let serverPref = true;
      let failNextPost = false;
      const netLog = [];
      globalThis.fetch = async (target, init = {}) => {
        const u = String(target);
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : null;
        if (u.endsWith('/api/me/notifications')) {
          netLog.push({ u, method, body });
        }
        if (u.endsWith('/api/me/notifications') && method === 'GET') {
          return { ok: true, status: 200, async json() { return { ok: true, data: { tgUserId: '123', settlementPush: serverPref, hourlyCandlePush: false }, ts: Date.now() }; } };
        }
        if (u.endsWith('/api/me/notifications') && method === 'POST') {
          if (failNextPost) {
            return { ok: false, status: 500, async json() { return { ok: false, error: { code: 'ERR', message: 'save failed' }, ts: Date.now() }; } };
          }
          serverPref = Boolean(body.settlementPush);
          return { ok: true, status: 200, async json() { return { ok: true, data: { tgUserId: '123', settlementPush: serverPref, hourlyCandlePush: false }, ts: Date.now() }; } };
        }
        return { ok: true, status: 200, async json() { return { ok: true, data: {}, ts: Date.now() }; } };
      };

      function makeSwitchEl() {
        const classes = new Set();
        const attrs = {};
        return {
          isConnected: true,
          classList: {
            add(c) { classes.add(c); },
            remove(c) { classes.delete(c); },
            toggle(c, force) {
              const on = force === undefined ? !classes.has(c) : Boolean(force);
              if (on) classes.add(c); else classes.delete(c);
            },
            contains(c) { return classes.has(c); },
          },
          setAttribute(k, v) { attrs[k] = String(v); },
          getAttribute(k) { return attrs[k] ?? null; },
          onclick: null,
          onkeydown: null,
        };
      }

      const settleSw = makeSwitchEl();
      const settleSub = { isConnected: true, textContent: '' };
      const root = {
        isConnected: true,
        innerHTML: '',
        querySelector(sel) {
          if (sel === '#set-settlement-push-switch') return settleSw;
          if (sel === '#set-settlement-push-sub') return settleSub;
          return null;
        },
        querySelectorAll() { return []; },
      };

      const { store } = await import(JS_URL + '/store.js');
      const { renderSettingsPage, resetLiveNotificationCacheForTest } = await import(JS_URL + '/pages/system.js');
      store.update((s) => { s.settings.language = 'zh-CN'; s.settings.settlementPush = false; });
      resetLiveNotificationCacheForTest();
      renderSettingsPage(root);
      await new Promise((r) => setTimeout(r, 20));
      const afterLoad = {
        on: settleSw.classList.contains('on'),
        ariaChecked: settleSw.getAttribute('aria-checked'),
        sub: settleSub.textContent,
      };

      await settleSw.onclick();
      const afterToggleOff = {
        on: settleSw.classList.contains('on'),
        ariaChecked: settleSw.getAttribute('aria-checked'),
        serverPref,
      };

      failNextPost = true;
      await settleSw.onclick();
      const afterFailedToggle = {
        on: settleSw.classList.contains('on'),
        ariaChecked: settleSw.getAttribute('aria-checked'),
        serverPref,
      };

      console.log(JSON.stringify({
        afterLoad,
        afterToggleOff,
        afterFailedToggle,
        netLog,
        lsKeys: Object.keys(localStorage._dump()),
      }));
    `,
  );

  assert.equal(tgOut.afterLoad.on, true);
  assert.equal(tgOut.afterLoad.ariaChecked, 'true');
  assert.ok(tgOut.afterLoad.sub.includes('结算与领取提醒偏好已开启'));
  assert.equal(tgOut.afterToggleOff.on, false);
  assert.equal(tgOut.afterToggleOff.ariaChecked, 'false');
  assert.equal(tgOut.afterToggleOff.serverPref, false);
  assert.equal(tgOut.afterFailedToggle.on, false);
  assert.equal(tgOut.afterFailedToggle.ariaChecked, 'false');
  assert.equal(tgOut.netLog.length, 3);
  assert.equal(tgOut.netLog[0].method, 'GET');
  assert.equal(tgOut.netLog[1].method, 'POST');
  assert.deepEqual(tgOut.netLog[1].body, { settlementPush: false });
  assert.deepEqual(tgOut.lsKeys, ['a9_ui_prefs_v1']);
});

test('Batch C: lockMode blocks ?mode=demo, TON Connect enforces mainnet chain & injects network/from/twaReturnUrl, and static compliance files exist', () => {
  const lockedOut = runScenario(
    {
      href: 'https://app.a9.lat/?mode=demo',
      injectedConfig: { mode: 'live', lockMode: true, network: 'mainnet', apiBase: 'https://api.a9.lat', liveFundsEnabled: true },
      sdkConnected: true,
    },
    `
      const { config } = await import(JS_URL + '/config.js');
      const { store } = await import(JS_URL + '/store.js');
      const { tonConnect } = await import(JS_URL + '/tonconnect.js');
      tonConnect.init();

      // Inject wrong testnet chain (-3) on mainnet config -> must block
      store.update((s) => { s.user.walletChain = '-3'; });
      let wrongChainCode = null;
      try {
        await tonConnect.sendV15TicketClaim('0:' + '55'.repeat(32));
      } catch (e) {
        wrongChainCode = e.code || e.message;
      }

      // Switch to mainnet chain (-239) outside Telegram Mini App -> must block with WALLET_NOT_VERIFIED
      store.update((s) => { s.user.walletChain = '-239'; s.user.walletVerificationState = 'restored_binding'; });
      let nonTmaCode = null;
      try {
        await tonConnect.sendV15TicketClaim('0:' + '55'.repeat(32));
      } catch (e) {
        nonTmaCode = e.code || e.message;
      }

      // Inside Telegram Mini App with restored_binding -> succeeds and injects network: '-239' + from
      window.Telegram = { WebApp: { initData: 'user=%7B%22id%22%3A123%7D' } };
      await tonConnect.sendV15TicketClaim('0:' + '55'.repeat(32));

      console.log(JSON.stringify({
        mode: config.mode,
        lockMode: config.lockMode,
        expectedChainId: config.expectedChainId,
        twaReturnUrl: tonConnect.ui?.opts?.actionsConfiguration?.twaReturnUrl || null,
        wrongChainCode,
        nonTmaCode,
        sentNetwork: sdkCalls.lastTx?.network || null,
        sentFrom: sdkCalls.lastTx?.from || null,
      }));
    `,
  );

  assert.equal(lockedOut.mode, 'live');
  assert.equal(lockedOut.lockMode, true);
  assert.equal(lockedOut.expectedChainId, '-239');
  assert.equal(lockedOut.twaReturnUrl, 'https://t.me/A9_TonBot?startapp=tonconnect');
  assert.equal(lockedOut.wrongChainCode, 'WRONG_WALLET_NETWORK');
  assert.equal(lockedOut.nonTmaCode, 'WALLET_NOT_VERIFIED');
  assert.equal(lockedOut.sentNetwork, '-239');
  assert.equal(lockedOut.sentFrom, '0:' + '11'.repeat(32));

  // Verify manifest & static legal pages (zero inline scripts) and no-cache headers
  const appRoot = dirname(JS_DIR);
  const manifest = JSON.parse(readFileSync(join(appRoot, 'tonconnect-manifest.json'), 'utf8'));
  assert.equal(manifest.termsOfUseUrl, 'https://app.a9.lat/terms.html');
  assert.equal(manifest.privacyPolicyUrl, 'https://app.a9.lat/privacy.html');
  for (const page of ['terms.html', 'privacy.html']) {
    const html = readFileSync(join(appRoot, page), 'utf8');
    assert.ok(html.includes('A9'), `${page} must exist and describe A9`);
    assert.ok(!/<script/i.test(html), `${page} must contain zero inline scripts`);
  }
  const headersText = readFileSync(join(appRoot, '_headers'), 'utf8');
  assert.ok(headersText.includes('/js/runtime-config.js'));
  assert.ok(headersText.includes('Cache-Control: no-cache, must-revalidate'));

  // P1-4 & P2-1 regression checks: isolated route viewHost prevents stale async overwrite/timer leaks; XSS escaping complete
  const appSrc = readFileSync(join(JS_DIR, 'app.js'), 'utf8');
  assert.ok(appSrc.includes("viewHost.className = 'route-view-host'"), 'app.js must mount each route in a fresh viewHost');
  assert.ok(appSrc.includes('mainEl.replaceChildren(viewHost)'), 'app.js must replace mainEl children so old root.isConnected turns false');
  assert.ok(appSrc.includes('getCachedRouteHandler(route)') && appSrc.includes('const render = await loadRouteHandler(route)') && appSrc.includes('if (seq !== routeRenderSeq) return;') && appSrc.includes('render(renderTarget, navigate, param, query)'), 'app.js must use loadRouteHandler/getCachedRouteHandler with routeRenderSeq guard and isolated renderTarget');

  const profileSrc = readFileSync(join(JS_DIR, 'pages/profile.js'), 'utf8');
  assert.ok(profileSrc.includes('${escapeHtml(txHash)}'), 'profile.js must escape txHash');
  const systemSrc = readFileSync(join(JS_DIR, 'pages/system.js'), 'utf8');
  assert.ok(systemSrc.includes('${escapeHtml(ev.detail)}'), 'system.js must escape audit log detail');

  // v17.0 14-day per-second unlock + instant cashout consistency checks
  const dataSrc = readFileSync(join(JS_DIR, 'data.js'), 'utf8');
  assert.ok(dataSrc.includes("version: 'v17.0'"), 'PROTOCOL_SPECS must declare v17.0');
  assert.ok(dataSrc.includes('immediateUnlockPct: 20') && dataSrc.includes('linearVestingDays: 14') && dataSrc.includes('minStakeA9: 100'));
  const wvSrc = readFileSync(join(JS_DIR, 'pages/wealthverse.js'), 'utf8');
  assert.ok(wvSrc.includes('14 天逐秒解锁'), 'wealthverse rewards view must describe 14-day per-second unlock');
  assert.ok(!wvSrc.includes('4 × 20%'), 'wealthverse rewards view must not retain legacy 3-tier slices');
  const rhSrc = readFileSync(join(JS_DIR, 'pages/round_hub.js'), 'utf8');
  assert.ok(rhSrc.includes('14 天逐秒解锁进度'), 'round_hub must describe 14-day unlock curve');
  assert.ok(!rhSrc.includes('4×20%'), 'round_hub must not retain legacy 3-tier vesting');
  const termsHtml = readFileSync(join(appRoot, 'terms.html'), 'utf8');
  assert.ok(termsHtml.includes('v17.0') && termsHtml.includes('14 天'), 'terms.html must match v17.0 14-day unlock');

  // v17.1 guardrails: zero 暴击 copy, zero #cert-renew-switch, Live null-value guard in Plaza & 3 scenario posters, confirm ?amt= validation
  const wmSrc = readFileSync(join(JS_DIR, 'pages/warmup_market.js'), 'utf8');
  const shareSrc = readFileSync(join(JS_DIR, 'share.js'), 'utf8');
  const posterSrc = readFileSync(join(JS_DIR, 'poster.js'), 'utf8');
  const teamSrc = readFileSync(join(JS_DIR, 'pages/team.js'), 'utf8');
  assert.ok(!wmSrc.includes('暴击'), 'warmup_market.js must not contain 暴击 copy');
  assert.ok(!shareSrc.includes('暴击'), 'share.js must not contain 暴击 copy');
  assert.ok(!wvSrc.includes('暴击'), 'wealthverse.js must not contain 暴击 copy');
  assert.ok(!profileSrc.includes('cert-renew-switch'), 'profile.js must remove #cert-renew-switch');
  assert.ok(rhSrc.includes('parseConfirmAmtParam'), 'round_hub.js must validate #/challenge/confirm?amt= as positive integer');
  assert.ok(posterSrc.includes('export function renderScenarioPoster'), 'poster.js must export renderScenarioPoster');
  assert.ok(!wvSrc.includes('$0.0130') && !wvSrc.includes('+14.2%'), 'wealthverse.js must never hardcode demo prices or percentages');
  assert.ok(!posterSrc.includes('$0.0130') && !posterSrc.includes('+14.2%'), 'poster.js must never hardcode demo prices or percentages');
  assert.ok(!teamSrc.includes('$0.0130') && !teamSrc.includes('+14.2%'), 'team.js must never hardcode demo prices or percentages');
});

test('Global v17.1 terminology guardrail across Mini App, Bot, Official Web, and Worker', () => {
  const repoRoot = join(JS_DIR, '../..');
  const checkedFiles = [
    'a9-mini-app/js/router.js',
    'a9-mini-app/js/components.js',
    'a9-mini-app/js/i18n.js',
    'a9-mini-app/js/tonconnect.js',
    'a9-mini-app/js/chest-theater.js',
    'a9-mini-app/js/poster.js',
    'a9-mini-app/js/share.js',
    'a9-mini-app/js/pages/round_hub.js',
    'a9-mini-app/js/pages/round_stages.js',
    'a9-mini-app/js/pages/profile.js',
    'a9-mini-app/js/pages/plaza.js',
    'a9-mini-app/js/pages/wealthverse.js',
    'a9-mini-app/js/pages/system.js',
    'a9-mini-app/js/pages/team.js',
    'a9-mini-app/js/pages/warmup_market.js',
    'a9-mini-app/assets/boxheads/manifest.json',
    'a9-mini-app/a9.json',
    'a9-mini-app/terms.html',
    'a9-mini-app/privacy.html',
    'a9-mini-app/bot/a9_bot.py',
    'a9-official-web/index.html',
    'a9-official-web/js/data.js',
    'a9-official-web/redpaper/index.html',
    'worker/src/tg-broadcaster.mjs',
    'worker/src/growth-engine.mjs',
    'worker/src/d1-growth-store.mjs',
    'worker/src/api.mjs',
    'ops/scripts/setup-tg-bot.mjs',
  ];
  const forbiddenPatterns = [
    /24H\s*(观测盘|印章簿|预言|观察|考核|闯关中|竞猜|巡视|达标竞猜|Observe|Stamp Log|Observation Board|Prediction Stamp|Logbook Stamp|Guess|Inspect|Quest)/,
    /16\s*\/\s*24/,
    /\/\s*24\b/,
    /max="24"/,
    /\{q\}\/24/,
    /\b15[xX]\b/,
    /100% BURN MONUMENT/,
    /A9 PAPER CRAFT/,
    /自动连闯/,
    /Auto-Continue/,
    /Early Bird/,
    /\b700M\b/,
    /\b200M\b/,
    /1 GRAM = 2,002 A9/,
    /链上质押/,
    /暴击/,
    /早鸟/,
    /Early 6H/,
    /First-6H/,
    /\bNo Liq\b/,
    /Zero Liquidation/,
    /30% Cashout/i,
    /Stake Rebate/,
    /销毁 BURN/,
    /销毁警报/,
    /销毁空军/,
    /1,500–1\.3M/,
    /cert-renew-switch/,
  ];
  const violations = [];
  for (const rel of checkedFiles) {
    const content = readFileSync(join(repoRoot, rel), 'utf8');
    for (const rx of forbiddenPatterns) {
      const m = content.match(rx);
      if (m) violations.push(`${rel}: matched ${rx} (${m[0]})`);
    }
  }
  assert.deepEqual(violations, [], `Global terminology regressions found:\n${violations.join('\n')}`);
});

test('P1-cleanup: repeated A9TMA.init() registers visualViewport.resize listener only once', () => {
  const out = runScenario(
    { href: 'https://app.a9.lat/?mode=live' },
    `
      const vvListeners = [];
      const tgEvents = [];
      window.visualViewport = {
        height: 640,
        addEventListener(type, fn) { vvListeners.push({ type, fn }); },
      };
      document.documentElement.style = { setProperty() {}, removeProperty() {} };

      const { A9TMA } = await import(JS_URL + '/tma.js');
      A9TMA.init();
      A9TMA.init();
      const countWithoutTg = vvListeners.filter((x) => x.type === 'resize').length;

      window.Telegram = {
        WebApp: {
          ready() {},
          expand() {},
          disableVerticalSwipes() {},
          setHeaderColor() {},
          setBackgroundColor() {},
          setBottomBarColor() {},
          onEvent(ev) { tgEvents.push(ev); },
        },
      };
      A9TMA.init();
      A9TMA.init();
      const countWithTg = vvListeners.filter((x) => x.type === 'resize').length;
      const tgViewportEvents = tgEvents.filter((ev) => ev === 'viewportChanged').length;

      console.log(JSON.stringify({ countWithoutTg, countWithTg, tgViewportEvents }));
    `,
  );

  assert.equal(out.countWithoutTg, 1);
  assert.equal(out.countWithTg, 1);
  assert.equal(out.tgViewportEvents, 1);
});

test('P2-1a: loadRouteHandler dedupes concurrent loads and retries cleanly after failure', () => {
  const out = runScenario(
    { href: 'https://app.a9.lat/?mode=live' },
    `
      const { getCachedRouteHandler, loadRouteHandler } = await import(JS_URL + '/router.js');

      let dedupeLoadCalls = 0;
      let resolveDedupe;
      let markEntered;
      const loaderEntered = new Promise((res) => { markEntered = res; });
      const dedupeRoute = {
        path: '/__test_dedupe',
        load: () => {
          dedupeLoadCalls += 1;
          return new Promise((res) => {
            resolveDedupe = () => res(() => 'DEDUPE_OK');
            markEntered();
          });
        },
      };
      const p1 = loadRouteHandler(dedupeRoute);
      const p2 = loadRouteHandler(dedupeRoute);
      await loaderEntered;
      resolveDedupe();
      const [h1, h2] = await Promise.all([p1, p2]);
      const dedupeCached = getCachedRouteHandler(dedupeRoute) === h1 && h1 === h2;

      let retryLoadCalls = 0;
      const retryRoute = {
        path: '/__test_retry',
        load: async () => {
          retryLoadCalls += 1;
          if (retryLoadCalls === 1) throw new Error('TEMP_NET_ERR');
          return () => 'RETRY_OK';
        },
      };
      let firstFailed = false;
      try { await loadRouteHandler(retryRoute); } catch (_) { firstFailed = true; }
      const cachedAfterFail = Boolean(getCachedRouteHandler(retryRoute));
      const retryHandler = await loadRouteHandler(retryRoute);
      const cachedAfterRetry = getCachedRouteHandler(retryRoute) === retryHandler;

      console.log(JSON.stringify({
        dedupeLoadCalls,
        dedupeCached,
        firstFailed,
        cachedAfterFail,
        retryLoadCalls,
        cachedAfterRetry,
      }));
    `,
  );

  assert.equal(out.dedupeLoadCalls, 1);
  assert.equal(out.dedupeCached, true);
  assert.equal(out.firstFailed, true);
  assert.equal(out.cachedAfterFail, false);
  assert.equal(out.retryLoadCalls, 2);
  assert.equal(out.cachedAfterRetry, true);
});

test('P2-3: demo-data.js is lazy-loaded only in Demo mode with failure retry, concurrent ensureDemoReady, reset, and sync fund contracts', () => {
  // 1) Static import guard: zero static imports of demo-data.js across a9-mini-app/js/
  const collectJs = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'vendor') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) out.push(...collectJs(p));
      else if (entry.endsWith('.js')) out.push(p);
    }
    return out;
  };
  const staticDemoImports = [];
  for (const file of collectJs(JS_DIR)) {
    const src = readFileSync(file, 'utf8');
    if (/^\s*import\s+[\s\S]*?from\s+['"][^'"]*demo-data\.js['"]/m.test(src)) {
      staticDemoImports.push(file);
    }
  }
  assert.deepEqual(staticDemoImports, [], `Unexpected static demo-data.js imports: ${staticDemoImports.join(', ')}`);

  // 2) Live mode never loads demo-data.js
  const liveOut = runScenario(
    {
      href: 'https://app.a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat', liveFundsEnabled: false },
    },
    `
      const { store } = await import(JS_URL + '/store.js');
      const { isDemoReady, peekDemoModule, loadDemoModule } = await import(JS_URL + '/demo-loader.js');
      const ensured = await store.ensureDemoReady();
      const loaded = await loadDemoModule();
      const stakeRes = store.stakeTon(100);
      const claimRes = store.claimRewards();
      const promoRes = store.claimPromoDemo();
      const buyRes = store.buyInternalMarket(5);
      console.log(JSON.stringify({
        ensured,
        loaded,
        isReady: isDemoReady(),
        peek: peekDemoModule(),
        stakeRes,
        claimRes,
        promoHasError: Boolean(promoRes?.error),
        buyHasError: Boolean(buyRes?.error),
      }));
    `,
  );
  assert.equal(liveOut.ensured, false);
  assert.equal(liveOut.loaded, null);
  assert.equal(liveOut.isReady, false);
  assert.equal(liveOut.peek, null);
  assert.equal(liveOut.stakeRes, null);
  assert.equal(liveOut.claimRes, 0);
  assert.equal(liveOut.promoHasError, true);
  assert.equal(liveOut.buyHasError, true);

  // 3) Demo mode: pre-ready sync contracts, failure retry, concurrent ensureDemoReady, UI pref & referrer preservation, reset, post-ready fund ops
  const demoOut = runScenario(
    {
      href: 'http://127.0.0.1:8091/?mode=demo',
    },
    `
      localStorage.setItem('a9_ui_prefs_v1', JSON.stringify({
        settings: { themeMode: 'dark', language: 'en-US' },
        user: { profileMode: 'empty', autoRenew: false },
      }));
      const { store } = await import(JS_URL + '/store.js');
      const { isDemoReady, peekDemoModule } = await import(JS_URL + '/demo-loader.js');

      store.setReferrerId('REF_DEEP_42');
      const preReady = {
        demoReady: store.demoReady,
        isReady: isDemoReady(),
        stake: store.stakeTon(100),
        claim: store.claimRewards(),
        promoHasError: Boolean(store.claimPromoDemo()?.error),
        buyHasError: Boolean(store.buyInternalMarket(5)?.error),
      };

      let loadFailed = false;
      try {
        await store.ensureDemoReady(() => Promise.reject(new Error('DEMO_NET_FAIL')));
      } catch (_) {
        loadFailed = true;
      }
      const afterFail = {
        loadFailed,
        demoReady: store.demoReady,
        isReady: isDemoReady(),
      };

      const [r1, r2] = await Promise.all([store.ensureDemoReady(), store.ensureDemoReady()]);
      const hydrated = {
        r1,
        r2,
        demoReady: store.demoReady,
        isReady: isDemoReady(),
        hasSquads: Array.isArray(peekDemoModule()?.DEMO_SQUADS) && peekDemoModule().DEMO_SQUADS.length > 0,
        connected: store.state.user.connected,
        themeMode: store.state.settings.themeMode,
        language: store.state.settings.language,
        profileMode: store.state.user.profileMode,
        referrerId: store.state.referral.referrerId,
        certsCount: store.state.certificates.length,
      };

      const balBeforeStake = store.state.user.a9Available;
      const certsBeforeStake = store.state.certificates.length;
      const belowMinCert = store.stakeTon(50);
      const belowMinUnchanged = store.state.user.a9Available === balBeforeStake && store.state.certificates.length === certsBeforeStake;

      const stakeCert = store.stakeTon(200);
      const validStakeDeducted = store.state.user.a9Available === balBeforeStake - 200;
      const buyRes = store.buyInternalMarket(5);
      const promoRes = store.claimPromoDemo();

      store.reset();
      const afterReset = {
        demoReady: store.demoReady,
        connected: store.state.user.connected,
        language: store.state.settings.language,
        referrerId: store.state.referral.referrerId,
        certsCount: store.state.certificates.length,
      };

      console.log(JSON.stringify({
        preReady,
        afterFail,
        hydrated,
        postOps: {
          belowMinCert,
          belowMinUnchanged,
          staked: Boolean(stakeCert && stakeCert.id),
          validStakeDeducted,
          bought: Boolean(buyRes && !buyRes.error),
          promoClaimed: Boolean(promoRes && !promoRes.error),
        },
        afterReset,
      }));
    `,
  );

  assert.equal(demoOut.preReady.demoReady, false);
  assert.equal(demoOut.preReady.isReady, false);
  assert.equal(demoOut.preReady.stake, null);
  assert.equal(demoOut.preReady.claim, 0);
  assert.equal(demoOut.preReady.promoHasError, true);
  assert.equal(demoOut.preReady.buyHasError, true);

  assert.equal(demoOut.afterFail.loadFailed, true);
  assert.equal(demoOut.afterFail.demoReady, false);
  assert.equal(demoOut.afterFail.isReady, false);

  assert.equal(demoOut.hydrated.r1, true);
  assert.equal(demoOut.hydrated.r2, true);
  assert.equal(demoOut.hydrated.demoReady, true);
  assert.equal(demoOut.hydrated.isReady, true);
  assert.equal(demoOut.hydrated.hasSquads, true);
  assert.equal(demoOut.hydrated.connected, true);
  assert.equal(demoOut.hydrated.themeMode, 'dark');
  assert.equal(demoOut.hydrated.language, 'en-US');
  assert.equal(demoOut.hydrated.profileMode, 'empty');
  assert.equal(demoOut.hydrated.referrerId, 'REF_DEEP_42');
  assert.ok(demoOut.hydrated.certsCount > 0);

  assert.equal(demoOut.postOps.belowMinCert, null);
  assert.equal(demoOut.postOps.belowMinUnchanged, true);
  assert.equal(demoOut.postOps.staked, true);
  assert.equal(demoOut.postOps.validStakeDeducted, true);
  assert.equal(demoOut.postOps.bought, true);
  assert.equal(demoOut.postOps.promoClaimed, true);

  assert.equal(demoOut.afterReset.demoReady, true);
  assert.equal(demoOut.afterReset.connected, true);
  assert.equal(demoOut.afterReset.language, 'en-US');
  assert.equal(demoOut.afterReset.referrerId, 'REF_DEEP_42');
  assert.equal(demoOut.afterReset.certsCount, demoOut.hydrated.certsCount);

  // 4) Concurrent reset() during in-flight ensureDemoReady(): hydrates strictly once & preserves language + referrer
  const raceOut = runScenario(
    {
      href: 'http://127.0.0.1:8091/?mode=demo',
    },
    `
      const { store } = await import(JS_URL + '/store.js');
      const realDemo = await import(JS_URL + '/demo-data.js');
      let applyCalls = 0;
      let resetPredCalls = 0;
      let releaseImport;
      let markEntered;
      const entered = new Promise((res) => { markEntered = res; });
      const wrappedDemo = {
        ...realDemo,
        applyDemoInitialState(s) {
          applyCalls += 1;
          return realDemo.applyDemoInitialState(s);
        },
        resetDemoPrediction() {
          resetPredCalls += 1;
          return realDemo.resetDemoPrediction();
        },
      };
      const deferredImporter = () => new Promise((res) => {
        releaseImport = () => res(wrappedDemo);
        markEntered();
      });

      const p1 = store.ensureDemoReady(deferredImporter);
      await entered;
      store.state.settings.language = 'en-US';
      store.setReferrerId('REF_RACE_99');
      store.reset();
      const p2 = store.ensureDemoReady();
      releaseImport();
      const [res1, res2] = await Promise.all([p1, p2]);

      console.log(JSON.stringify({
        res1,
        res2,
        applyCalls,
        resetPredCalls,
        demoReady: store.demoReady,
        connected: store.state.user.connected,
        language: store.state.settings.language,
        referrerId: store.state.referral.referrerId,
      }));
    `,
  );

  assert.equal(raceOut.res1, true);
  assert.equal(raceOut.res2, true);
  assert.equal(raceOut.applyCalls, 1);
  assert.equal(raceOut.resetPredCalls, 1);
  assert.equal(raceOut.demoReady, true);
  assert.equal(raceOut.connected, true);
  assert.equal(raceOut.language, 'en-US');
  assert.equal(raceOut.referrerId, 'REF_RACE_99');

  // 5) Demo console guard: openSimDrawer locks controls when !store.demoReady and exposes retry button
  const appSrc = readFileSync(join(JS_DIR, 'app.js'), 'utf8');
  assert.ok(appSrc.includes('if (!store.demoReady)'), 'openSimDrawer must lock controls when Demo is not ready');
  assert.ok(appSrc.includes('id="sim-retry-demo"'), 'openSimDrawer must provide retry button when Demo load failed');
});

// ---------------------------------------------------------------------------
// v17 候选测试网真机验收修复回归：钱包回跳句柄 + 回跳启动参数识别
// ---------------------------------------------------------------------------

const CANDIDATE_PAGE = 'https://a9-v17-testnet-candidate.pages.dev/';
const CANDIDATE_API = 'https://a9-v17-testnet-candidate.348421501.workers.dev';
const CANDIDATE_LIVE_CFG = { mode: 'live', lockMode: true, network: 'testnet', apiBase: CANDIDATE_API, liveFundsEnabled: false, stakeProtocolVersion: 'v17' };

const RESTORE_PROBE = `
  const { tonConnect } = await import(JS_URL + '/tonconnect.js');
  tonConnect.restoreOnStartup(() => {});
  await Promise.resolve(); await Promise.resolve();
  const actions = tonConnect.ui?.opts?.actionsConfiguration || {};
  console.log(JSON.stringify({
    sdkReady: tonConnect.sdkReady,
    constructed: sdkCalls.constructed,
    scriptInjections: createdElements.filter((t) => t === 'script').length,
    openModal: sdkCalls.openModal,
    twaReturnUrl: Object.prototype.hasOwnProperty.call(actions, 'twaReturnUrl') ? actions.twaReturnUrl : null,
  }));
`;

test('C-restore-1: SDK-generated hyphen return param (tonconnect-…) preloads the wallet SDK with no stored session', () => {
  for (const startParam of ['tonconnect', 'tonconnect-AbC123', 'tonconnect_legacy', 'tc_ret_abc', 'TONCONNECT-Return', 'tc_ret']) {
    const out = runScenario(
      { href: CANDIDATE_PAGE, injectedConfig: CANDIDATE_LIVE_CFG, startParam, sdkAvailable: false },
      RESTORE_PROBE,
    );
    assert.equal(out.sdkReady, false, `${startParam}: SDK unavailable must stay not-ready`);
    assert.equal(out.scriptInjections, 1, `${startParam}: return param must trigger exactly one SDK preload`);
    assert.equal(out.openModal, 0, `${startParam}: restore must never auto-open the wallet modal`);
  }
  for (const href of [`${CANDIDATE_PAGE}#tgWebAppStartParam=tonconnect-AbC123`, `${CANDIDATE_PAGE}?tc_ret=state-back`, `${CANDIDATE_PAGE}?startapp=tonconnect`, `${CANDIDATE_PAGE}?startapp=tonconnect-AbC123`]) {
    const out = runScenario({ href, injectedConfig: CANDIDATE_LIVE_CFG, sdkAvailable: false }, RESTORE_PROBE);
    assert.equal(out.scriptInjections, 1, `${href}: return URL marker must trigger SDK preload`);
  }
});

test('C-restore-2: an existing stored bridge session preloads the SDK without any return param', () => {
  const out = runScenario(
    {
      href: CANDIDATE_PAGE,
      injectedConfig: CANDIDATE_LIVE_CFG,
      sdkAvailable: false,
      storageSeed: { 'ton-connect-storage_bridge-connection': '{"connectionType":"http","connectEvent":{}}' },
    },
    RESTORE_PROBE,
  );
  assert.equal(out.scriptInjections, 1);
  assert.equal(out.openModal, 0);
});

test('C-restore-3: when the SDK object already exists, restore initializes synchronously without await and never opens the modal', () => {
  for (const opts of [
    { startParam: 'tonconnect-AbC123' },
    { storageSeed: { 'ton-connect-storage_bridge-connection': '{}' } },
  ]) {
    const out = runScenario(
      { href: CANDIDATE_PAGE, injectedConfig: CANDIDATE_LIVE_CFG, sdkAvailable: true, ...opts },
      `
      const { tonConnect } = await import(JS_URL + '/tonconnect.js');
      const before = sdkCalls.constructed;
      tonConnect.restoreOnStartup(() => {});
      const readySync = tonConnect.sdkReady === true && sdkCalls.constructed === before + 1;
      console.log(JSON.stringify({ readySync, sdkReady: tonConnect.sdkReady, constructed: sdkCalls.constructed, openModal: sdkCalls.openModal }));
      `,
    );
    assert.equal(out.readySync, true, 'init must complete synchronously inside restoreOnStartup');
    assert.equal(out.constructed, 1, 'exactly one SDK instance must be created');
    assert.equal(out.openModal, 0);
  }
});

test('C-restore-4: Demo never loads the wallet SDK, even with a stored session and a return param', () => {
  const out = runScenario(
    {
      href: `${CANDIDATE_PAGE}?mode=demo`,
      injectedConfig: { mode: 'demo' },
      startParam: 'tonconnect-AbC123',
      sdkAvailable: false,
      storageSeed: { 'ton-connect-storage_bridge-connection': '{}' },
    },
    RESTORE_PROBE,
  );
  assert.equal(out.scriptInjections, 0);
  assert.equal(out.constructed, 0);
  assert.equal(out.sdkReady, false);
});

test('C-restore-5: plain Live with no session and a non-return start param must not preload the SDK early', () => {
  for (const opts of [{ startParam: 'market' }, { startParam: 'invite_100_REF' }, {}]) {
    const out = runScenario({ href: CANDIDATE_PAGE, injectedConfig: CANDIDATE_LIVE_CFG, sdkAvailable: false, ...opts }, RESTORE_PROBE);
    assert.equal(out.scriptInjections, 0, `${JSON.stringify(opts)}: no early SDK load`);
    assert.equal(out.constructed, 0);
  }
});

const RETURN_URL_PROBE = `
  const { store } = await import(JS_URL + '/store.js');
  const { tonConnect } = await import(JS_URL + '/tonconnect.js');
  if (SERVER_HANDLE) store.update((s) => { s.round.protocolConfig = { botHandle: SERVER_HANDLE }; });
  tonConnect.restoreOnStartup(() => {});
  const actions = tonConnect.ui?.opts?.actionsConfiguration || {};
  let guardCode = null;
  try { tonConnect.assertReturnEntryReady(); }
  catch (e) { guardCode = e?.code || null; }
  console.log(JSON.stringify({
    twaReturnUrl: Object.prototype.hasOwnProperty.call(actions, 'twaReturnUrl') ? actions.twaReturnUrl : null,
    returnStrategy: Object.prototype.hasOwnProperty.call(actions, 'returnStrategy') ? actions.returnStrategy : null,
    returnEntryUrl: tonConnect.returnEntry?.url || null,
    returnEntryError: tonConnect.returnEntryError,
    guardCode,
  }));
`;

test('C-return-1: candidate runtime-config botHandle drives twaReturnUrl; Testnet never falls back to the production bot', () => {
  const cases = [
    { name: 'candidate injected test bot', injected: { ...CANDIDATE_LIVE_CFG, botHandle: 'A9_TestnetBot' }, server: null, expect: 'https://t.me/A9_TestnetBot?startapp=tonconnect' },
    { name: 'candidate injected handle with @', injected: { ...CANDIDATE_LIVE_CFG, botHandle: '@A9_TestnetBot' }, server: null, expect: 'https://t.me/A9_TestnetBot?startapp=tonconnect' },
    { name: 'testnet nothing injected -> no production fallback', injected: CANDIDATE_LIVE_CFG, server: null, expect: null },
    // 测试网一律拒绝正式 Bot 句柄：显式注入、服务端下发、大小写变体都不允许
    { name: 'testnet rejects injected production handle', injected: { ...CANDIDATE_LIVE_CFG, botHandle: 'A9_TonBot' }, server: null, expect: null },
    { name: 'testnet rejects lower-case production handle', injected: { ...CANDIDATE_LIVE_CFG, botHandle: 'a9_tonbot' }, server: null, expect: null },
    { name: 'testnet rejects upper-case production handle', injected: { ...CANDIDATE_LIVE_CFG, botHandle: 'A9_TONBOT' }, server: null, expect: null },
    { name: 'testnet rejects @-prefixed mixed-case production handle', injected: { ...CANDIDATE_LIVE_CFG, botHandle: '@a9_TonBot' }, server: null, expect: null },
    { name: 'testnet rejects server-provided production handle', injected: CANDIDATE_LIVE_CFG, server: 'A9_TonBot', expect: null },
    { name: 'testnet rejects server-provided mixed-case production handle', injected: CANDIDATE_LIVE_CFG, server: 'a9_TONBOT', expect: null },
    { name: 'testnet skips rejected injected handle and uses valid server handle', injected: { ...CANDIDATE_LIVE_CFG, botHandle: 'A9_TonBot' }, server: 'A9_TestnetBot', expect: 'https://t.me/A9_TestnetBot?startapp=tonconnect' },
    { name: 'testnet server-provided handle', injected: CANDIDATE_LIVE_CFG, server: 'A9_TestnetBot', expect: 'https://t.me/A9_TestnetBot?startapp=tonconnect' },
    { name: 'testnet invalid injected handle, no server handle', injected: { ...CANDIDATE_LIVE_CFG, botHandle: 'bad handle!' }, server: null, expect: null },
    { name: 'testnet URL-shaped injected handle is rejected', injected: { ...CANDIDATE_LIVE_CFG, botHandle: 'https://evil.example' }, server: null, expect: null },
    { name: 'injected handle wins over server handle', injected: { ...CANDIDATE_LIVE_CFG, botHandle: 'A9_TestnetBot' }, server: 'A9_OtherBot', expect: 'https://t.me/A9_TestnetBot?startapp=tonconnect' },
  ];
  for (const c of cases) {
    const out = runScenario(
      { href: CANDIDATE_PAGE, injectedConfig: c.injected, sdkAvailable: true },
      `const SERVER_HANDLE = ${JSON.stringify(c.server)};\n${RETURN_URL_PROBE}`,
    );
    assert.equal(out.twaReturnUrl, c.expect, c.name);
    assert.equal(out.returnEntryUrl, c.expect, `${c.name}: resolved entry url`);
    if (c.expect) {
      assert.equal(out.returnStrategy, null, `${c.name}: no returnStrategy override when entry exists`);
      assert.equal(out.returnEntryError, null, `${c.name}: no entry error`);
      assert.equal(out.guardCode, null, `${c.name}: guard passes`);
    } else {
      // 无有效入口必须显式失败：不传裸 Bot URL，改为 returnStrategy=none 并暴露错误码
      assert.equal(out.returnStrategy, 'none', `${c.name}: explicit no-return fallback`);
      assert.equal(out.returnEntryError, 'WALLET_RETURN_ENTRY_MISSING', `${c.name}: explicit error code`);
      assert.equal(out.guardCode, 'WALLET_RETURN_ENTRY_MISSING', `${c.name}: guard blocks wallet launch`);
    }
  }
});

test('C-return-2: Mainnet keeps the historical production default when no handle is configured', () => {
  const mainnetCfg = { mode: 'live', lockMode: true, network: 'mainnet', apiBase: 'https://api.a9.lat', liveFundsEnabled: false };
  const dflt = runScenario(
    { href: 'https://app.a9.lat/', injectedConfig: mainnetCfg, sdkAvailable: true },
    `const SERVER_HANDLE = null;\n${RETURN_URL_PROBE}`,
  );
  assert.equal(dflt.twaReturnUrl, 'https://t.me/A9_TonBot?startapp=tonconnect');
  const explicit = runScenario(
    { href: 'https://app.a9.lat/', injectedConfig: { ...mainnetCfg, botHandle: 'A9_OfficialBot' }, sdkAvailable: true },
    `const SERVER_HANDLE = null;\n${RETURN_URL_PROBE}`,
  );
  assert.equal(explicit.twaReturnUrl, 'https://t.me/A9_OfficialBot?startapp=tonconnect');
  // 主网与测试网入口隔离：测试网配置绝不接受 A9_TonBot，主网默认也不指向测试 Bot
  assert.notEqual(dflt.twaReturnUrl, 'https://t.me/A9_TestnetBot?startapp=tonconnect');
});

test('C-return-3: SDK loader keeps SRI + crossorigin and funds gates are untouched', () => {
  const src = readFileSync(join(JS_DIR, 'tonconnect.js'), 'utf8');
  assert.match(src, /script\.integrity = 'sha384-ej0rYqvkb978ljOWDi1iAt5spb5B7sRdf1g8Hii30vS72XLjxoCPCmx5seE7s05g'/);
  assert.match(src, /script\.crossOrigin = 'anonymous'/);
  assert.match(src, /script\.src = '\.\/js\/vendor\/tonconnect-ui\.min\.js'/);
  // 回跳入口必须带 startapp=tonconnect，才会打开 Main Mini App 而不是 Bot 聊天页
  assert.match(src, /https:\/\/t\.me\/\$\{handle\}\?startapp=tonconnect/);
  // 签名瞬间守卫与 _dispatch 防重入口保持原样
  assert.match(src, /this\.assertWalletReadyForLiveTx\(\);\s*\n\s*const expectedChain = this\.getExpectedChainId\(\);\s*\n\s*const fromAddr/);
  assert.match(src, /if \(!liveFundsReady\(\)\) throw createFundsDisabledError\(\);/);
});

test('Telegram launch fragment opens Quest without consuming SDK data or masking invalid routes', () => {
  const out = runScenario(
    { href: 'https://candidate.invalid/?mode=live#tgWebAppData=user%3Dfixture&tgWebAppVersion=9.6' },
    `
      const { matchRoute } = await import(JS_URL + '/router.js');
      const originalHash = window.location.hash;
      const launches = [originalHash,
        '#tgWebAppVersion=9.6&tgWebAppData=user%3Dfixture&tgWebAppPlatform=macos',
        '#tgWebAppData=user%3Dfixture&tgWebAppStartParam=tonconnect-fixture'];
      console.log(JSON.stringify({
        routes: launches.map(hash => matchRoute(hash).route.path),
        unchanged: window.location.hash === originalHash,
        invalid: matchRoute('#/does-not-exist').route.path,
        fake: matchRoute('#tgWebAppBogus=fixture').route.path,
        deepLink: matchRoute('#/round?panel=prediction').route.path,
        panel: matchRoute('#/round?panel=prediction').query.panel,
      }));
    `,
  );
  assert.deepEqual(out.routes, ['/round', '/round', '/round']);
  assert.equal(out.unchanged, true);
  assert.equal(out.invalid, '/404');
  assert.equal(out.fake, '/404');
  assert.equal(out.deepLink, '/round');
  assert.equal(out.panel, 'prediction');
});

test('Wallet display uses friendly network format while SDK identity and funds gates stay unchanged', () => {
  const out = runScenario(
    { href: 'https://candidate.invalid/?mode=live', injectedConfig: { network: 'testnet', liveFundsEnabled: false } },
    `
      const { tonConnect, walletDisplayAddress, canonicalWalletKey } = await import(JS_URL + '/tonconnect.js');
      const { store } = await import(JS_URL + '/store.js');
      const { parseTonAddress } = await import(JS_URL + '/v15-tx.js');
      const raw = '0:' + '11'.repeat(32);
      tonConnect.init();
      await tonConnect.ui._cb({account: {address: raw, chain: '-3'}});
      const testDisplay = walletDisplayAddress(raw, '-3');
      console.log(JSON.stringify({
        rawUnchanged: store.state.user.address === raw,
        short: store.state.user.shortAddress,
        friendly: testDisplay,
        sameIdentity: canonicalWalletKey(testDisplay) === canonicalWalletKey(raw),
        testFlag: parseTonAddress(testDisplay).testOnly,
        mainFlag: parseTonAddress(walletDisplayAddress(raw, '-239')).testOnly,
        unknown: walletDisplayAddress(raw, null),
        malformed: walletDisplayAddress('invalid', '-3'),
        raw, funds: store.fundsEnabled, sends: sdkCalls.sendTransaction,
      }));
    `,
  );
  assert.equal(out.rawUnchanged, true);
  assert.equal(out.sameIdentity, true);
  assert.equal(out.testFlag, true);
  assert.equal(out.mainFlag, false);
  assert.equal(out.short, out.friendly.slice(0, 6) + '...' + out.friendly.slice(-6));
  assert.equal(out.unknown, out.raw);
  assert.equal(out.malformed, 'invalid');
  assert.equal(out.funds, false);
  assert.equal(out.sends, 0);
});

test('openChoiceSheet supports WAI-ARIA radiogroup arrow keys, Home/End, Escape cancel, and focus restoration', () => {
  const out = runScenario(
    {
      href: 'https://a9.lat/?mode=live',
      injectedConfig: { mode: 'live', apiBase: 'https://api.a9.lat', liveFundsEnabled: false },
    },
    `
      const docListeners = {};
      const mkClassList = (initial = []) => {
        const set = new Set(initial);
        return {
          add(...cls) { cls.forEach((c) => set.add(c)); },
          remove(...cls) { cls.forEach((c) => set.delete(c)); },
          toggle(c, force) {
            const on = force === undefined ? !set.has(c) : Boolean(force);
            if (on) set.add(c); else set.delete(c);
            return on;
          },
          contains(c) { return set.has(c); },
        };
      };

      let activeEl = null;
      const makeBtn = (id, attrs = {}, classes = []) => {
        const attrMap = new Map(Object.entries(attrs).map(([k, v]) => [k, String(v)]));
        const indicator = { innerHTML: '' };
        const el = {
          id,
          isConnected: true,
          disabled: false,
          hidden: false,
          dataset: { choiceVal: attrMap.get('data-choice-val') || '' },
          classList: mkClassList(classes),
          style: {},
          onclick: null,
          onkeydown: null,
          focusCalls: 0,
          focus() { this.focusCalls += 1; activeEl = this; },
          setAttribute(k, v) { attrMap.set(k, String(v)); },
          getAttribute(k) { return attrMap.has(k) ? attrMap.get(k) : null; },
          removeAttribute(k) { attrMap.delete(k); },
          querySelector(sel) { return sel === '[data-choice-indicator]' ? indicator : null; },
          _indicator: indicator,
        };
        return el;
      };

      const triggerBtn = makeBtn('btn-header-more');
      let choiceRows = [];
      let closeBtn = null;
      let cancelBtn = null;
      let modalSheet = null;
      const modalRoot = {
        id: 'modal-root',
        classList: mkClassList(['hidden']),
        _html: '',
        setAttribute() {},
        removeAttribute() {},
        contains(el) { return choiceRows.includes(el) || el === closeBtn || el === cancelBtn || el === modalSheet; },
        querySelector(sel) {
          if (sel === '.modal-sheet') return modalSheet;
          return null;
        },
        querySelectorAll() {
          return [closeBtn, ...choiceRows, cancelBtn].filter(Boolean);
        },
        set innerHTML(html) {
          this._html = String(html || '');
          if (!this._html) {
            choiceRows = [];
            closeBtn = null;
            cancelBtn = null;
            modalSheet = null;
            return;
          }
          modalSheet = makeBtn('sheet-box', { tabindex: '-1' });
          closeBtn = makeBtn('sheet-close');
          cancelBtn = makeBtn('sheet-cancel');
          choiceRows = [];
          const rx = /<button[^>]*data-choice-val="([^"]+)"[^>]*>/g;
          let m;
          while ((m = rx.exec(this._html)) !== null) {
            const tag = m[0];
            const val = m[1];
            const checked = /aria-checked="true"/.test(tag) ? 'true' : 'false';
            const tab = (tag.match(/tabindex="([^"]+)"/) || [])[1] || '-1';
            const classes = /is-selected/.test(tag) ? ['is-selected'] : [];
            choiceRows.push(makeBtn('opt-' + val, {
              role: 'radio',
              'aria-checked': checked,
              tabindex: tab,
              'data-choice-val': val,
            }, classes));
          }
        },
        get innerHTML() { return this._html; },
      };

      globalThis.document = {
        documentElement: { dataset: { theme: 'light' }, classList: mkClassList() },
        body: { classList: mkClassList(), appendChild() {} },
        get activeElement() { return activeEl; },
        getElementById(id) {
          if (id === 'modal-root') return modalRoot;
          if (id === 'sheet-close') return closeBtn;
          if (id === 'sheet-cancel') return cancelBtn;
          if (id === 'sheet-radiogroup') return modalSheet;
          return null;
        },
        querySelectorAll(sel) {
          if (sel === '[data-choice-val]') return choiceRows;
          return [];
        },
        querySelector: () => null,
        addEventListener(type, fn) {
          (docListeners[type] ||= []).push(fn);
        },
        createElement: () => ({ className: '', style: {}, setAttribute() {}, remove() {}, querySelector: () => null }),
      };

      const { openChoiceSheet } = await import(JS_URL + '/components.js');
      const selectedLog = [];
      const options = [
        { value: 'system', label: 'System' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ];

      // 1) Open -> verify initial selected radio focus & roving tabindex -> ArrowDown wraps -> Escape cancels & restores focus
      triggerBtn.focus();
      openChoiceSheet({ title: 'Theme', options, selected: 'light', onSelect: (v) => selectedLog.push(v) });
      const initialFocusId = activeEl?.id;
      const initialTabs = choiceRows.map((r) => r.getAttribute('tabindex'));
      const initialChecked = choiceRows.map((r) => r.getAttribute('aria-checked'));

      const fireKey = (el, key) => {
        let prevented = false;
        el?.onkeydown?.({ key, preventDefault() { prevented = true; } });
        return prevented;
      };
      fireKey(activeEl, 'ArrowDown'); // light -> dark
      const afterDownFocus = activeEl?.id;
      fireKey(activeEl, 'ArrowDown'); // dark -> system (wrap)
      const afterWrapFocus = activeEl?.id;
      fireKey(activeEl, 'End');       // -> dark
      const afterEndFocus = activeEl?.id;
      fireKey(activeEl, 'Home');      // -> system
      const afterHomeFocus = activeEl?.id;
      const tabsAfterHome = choiceRows.map((r) => r.getAttribute('tabindex'));
      const checkedAfterHome = choiceRows.map((r) => r.getAttribute('aria-checked'));

      // Dispatch Escape on document
      (docListeners.keydown || []).forEach((fn) => fn({ key: 'Escape', preventDefault() {} }));
      const closedAfterEscape = modalRoot.classList.contains('hidden');
      const focusAfterEscape = activeEl?.id;
      const selectedAfterEscape = [...selectedLog];

      // 2) Reopen -> ArrowUp wraps (system -> dark) -> Enter commits 'dark' & restores focus
      triggerBtn.focus();
      openChoiceSheet({ title: 'Theme', options, selected: 'system', onSelect: (v) => selectedLog.push(v) });
      fireKey(activeEl, 'ArrowUp');
      fireKey(activeEl, 'Enter');
      const closedAfterEnter = modalRoot.classList.contains('hidden');
      const focusAfterEnter = activeEl?.id;

      console.log(JSON.stringify({
        initialFocusId,
        initialTabs,
        initialChecked,
        afterDownFocus,
        afterWrapFocus,
        afterEndFocus,
        afterHomeFocus,
        tabsAfterHome,
        checkedAfterHome,
        closedAfterEscape,
        focusAfterEscape,
        selectedAfterEscape,
        closedAfterEnter,
        focusAfterEnter,
        selectedLog,
      }));
    `,
  );

  assert.equal(out.initialFocusId, 'opt-light');
  assert.deepEqual(out.initialTabs, ['-1', '0', '-1']);
  assert.deepEqual(out.initialChecked, ['false', 'true', 'false']);
  assert.equal(out.afterDownFocus, 'opt-dark');
  assert.equal(out.afterWrapFocus, 'opt-system');
  assert.equal(out.afterEndFocus, 'opt-dark');
  assert.equal(out.afterHomeFocus, 'opt-system');
  assert.deepEqual(out.tabsAfterHome, ['0', '-1', '-1']);
  assert.deepEqual(out.checkedAfterHome, ['true', 'false', 'false']);
  assert.equal(out.closedAfterEscape, true);
  assert.equal(out.focusAfterEscape, 'btn-header-more');
  assert.deepEqual(out.selectedAfterEscape, []);
  assert.equal(out.closedAfterEnter, true);
  assert.equal(out.focusAfterEnter, 'btn-header-more');
  assert.deepEqual(out.selectedLog, ['dark']);
});

test('Testnet accuracy: #/ledger Tonviewer link targets testnet.tonviewer.com, unsynced mapRoundView keeps updatedAt=null, and Settings shows TON 测试网只读', () => {
  const out = runScenario(
    {
      href: 'https://candidate.invalid/?mode=live',
      injectedConfig: { mode: 'live', lockMode: true, network: 'testnet', apiBase: 'https://candidate-api.invalid', liveFundsEnabled: false, botHandle: 'A9_TestnetBot' },
    },
    `
      let openedUrl = null;
      const stubEl = () => ({
        addEventListener() {},
        replaceChildren() {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        querySelector: () => stubEl(),
        querySelectorAll: () => [],
        insertAdjacentHTML() {},
        setAttribute() {},
        getAttribute() { return null; },
        remove() {},
        set innerHTML(_v) {},
        style: {},
        dataset: {},
        textContent: '',
        onclick: null,
        animate: () => ({ finished: Promise.resolve() }),
      });
      globalThis.window.open = (u) => { openedUrl = String(u); };
      globalThis.window.addEventListener = () => {};
      globalThis.window.scrollTo = () => {};
      Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
      globalThis.document = {
        documentElement: { dataset: { theme: 'light' }, lang: 'zh-CN' },
        body: { dataset: {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => stubEl(),
        addEventListener: () => {},
        createElement: () => stubEl(),
      };
      globalThis.requestAnimationFrame = () => 0;
      globalThis.setInterval = () => 0;
      const { store } = await import(JS_URL + '/store.js');
      const { mapRoundView } = await import(JS_URL + '/data.js');
      const { renderLedgerPage } = await import(JS_URL + '/pages/profile.js');
      const { renderSettingsPage, renderRiskAudit } = await import(JS_URL + '/pages/system.js');

      const unsyncedView = mapRoundView({
        config: { network: 'testnet', contracts: { roundController: 'kQCqh657Pt1LpQQWpherJOWcz6YG-wS_xpGFLMcRLxROgpm_' } },
        round: null,
        fetchedAt: 1795432500000,
        source: 'live-api',
        label: 'Testnet API',
      });
      store.applyLiveRound(unsyncedView);
      store.update((s) => {
        s.settings.language = 'zh-CN';
        s.user.connected = true;
        s.user.address = 'kQDxFSGKNebK5CmEzbDuUEWmR6ME86dTlOwCXKCXCYUzFS40';
      });

      const tvBtn = { onclick: null };
      const ledgerRoot = {
        isConnected: true,
        innerHTML: '',
        querySelector(sel) { return sel === '#btn-ledger-tonviewer' ? tvBtn : null; },
        querySelectorAll() { return []; },
      };
      renderLedgerPage(ledgerRoot);
      tvBtn.onclick?.();

      const settingsRoot = { isConnected: true, innerHTML: '', querySelector() { return null; }, querySelectorAll() { return []; } };
      renderSettingsPage(settingsRoot);

      const auditRoot = { isConnected: true, innerHTML: '', querySelector() { return null; } };
      renderRiskAudit(auditRoot);

      console.log(JSON.stringify({
        unsyncedUpdatedAt: unsyncedView.updatedAt,
        openedUrl,
        settingsTestnetLabel: settingsRoot.innerHTML.includes('TON 测试网只读'),
        auditPendingSync: auditRoot.innerHTML.includes('待同步'),
      }));
    `,
  );

  assert.equal(out.unsyncedUpdatedAt, null);
  assert.ok(out.openedUrl?.startsWith('https://testnet.tonviewer.com/'), `expected testnet.tonviewer.com, got ${out.openedUrl}`);
  assert.equal(out.settingsTestnetLabel, true);
  assert.equal(out.auditPendingSync, true);
});

test('UX Phase 1: index.html uses defer (not async) for Telegram SDK, loadSnapshot streams config+rounds before detail, unknown values never become 0, and offline falls back to memory lastGoodSnapshot only', () => {
  const indexHtml = readFileSync(join(JS_DIR, '..', 'index.html'), 'utf8');
  assert.match(
    indexHtml,
    /<script\s+defer\s+src="https:\/\/telegram\.org\/js\/telegram-web-app\.js"><\/script>/,
    'Telegram WebApp SDK must use defer (never async or render-blocking sync)'
  );
  assert.doesNotMatch(indexHtml, /telegram-web-app\.js[^>]*\basync\b/, 'Telegram WebApp SDK must never use async');
  assert.ok(indexHtml.includes('href="#/market"'), 'Static first-paint shell must expose Chest Mall entry');
  assert.ok(indexHtml.includes('id="app-tabbar"'), 'Static first-paint shell must include bottom navigation');

  const out = runScenario(
    {
      href: 'https://app.a9.lat/?mode=live',
      injectedConfig: CANDIDATE_LIVE_CFG,
    },
    `
      let failAll = false;
      const callOrder = [];
      let releaseDetail;
      const detailGate = new Promise((resolve) => { releaseDetail = resolve; });
      globalThis.fetch = async (target) => {
        const u = String(target);
        callOrder.push(u.replace(/^https?:\\/\\/[^/]+/, ''));
        if (failAll) throw new Error('network down');
        if (u.endsWith('/api/config')) {
          return { ok: true, status: 200, async json() { return { ok: true, data: { network: 'testnet', candleCount: 12, minQualifiedCandles: 8, token: { symbol: 'A9', decimals: 9 } }, ts: Date.now() }; } };
        }
        if (u.endsWith('/api/rounds')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                ok: true,
                data: [{ roundId: 6, state: 'OBSERVING', targetPriceUsdE8: '210000', priceUsdE8: '150000', priceValid: true }],
                ts: Date.now(),
              };
            },
          };
        }
        if (u.endsWith('/api/rounds/6')) {
          await detailGate;
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                ok: true,
                data: {
                  roundId: 6,
                  state: 'OBSERVING',
                  targetPriceUsdE8: '210000',
                  priceUsdE8: '180000',
                  priceValid: true,
                  candlesSeen: 4,
                  qualifiedCandles: 3,
                  rewardBudgetRaw: '700000000000000000',
                  entryCount: 12,
                  candles: [],
                },
                ts: Date.now(),
              };
            },
          };
        }
        throw new Error('unexpected url: ' + u);
      };

      const { loadSnapshot, mapRoundView } = await import(JS_URL + '/data.js');
      const partials = [];
      const snapPromise = loadSnapshot({
        onPartial: (p) => {
          partials.push(mapRoundView(p));
          releaseDetail();
        },
      });
      const finalSnap = await snapPromise;
      const finalView = mapRoundView(finalSnap);

      // 模拟随后断网：应命中内存 lastGoodSnapshot 并标 stale=true，且不写 localStorage / sessionStorage
      failAll = true;
      const staleSnap = await loadSnapshot();

      console.log(JSON.stringify({
        callOrder,
        partialCount: partials.length,
        partialDetailLoading: partials[0]?.detailLoading,
        partialRound: partials[0]?.currentRound,
        partialCandlesSeen: partials[0]?.candlesSeen,
        partialStakerCount: partials[0]?.stakerCount,
        partialRewardBudgetA9: partials[0]?.rewardBudgetA9,
        finalDetailLoading: finalView.detailLoading,
        finalCandlesSeen: finalView.candlesSeen,
        finalEntryCount: finalView.entryCount,
        finalRewardBudgetA9: finalView.rewardBudgetA9,
        staleFlag: staleSnap.stale,
        staleRound: staleSnap.detail?.roundId,
        localStorageKeys: Object.keys(localStorage._dump()),
        sessionStorageKeys: Object.keys(sessionStorage._dump()),
      }));
    `,
  );

  assert.deepEqual(out.callOrder.slice(0, 3), ['/api/config', '/api/rounds', '/api/rounds/6']);
  assert.equal(out.partialCount, 1);
  assert.equal(out.partialDetailLoading, true);
  assert.equal(out.partialRound, 6);
  assert.equal(out.partialCandlesSeen, null, 'missing candlesSeen must stay null, never 0');
  assert.equal(out.partialStakerCount, null, 'missing stakerCount must stay null, never 0');
  assert.equal(out.partialRewardBudgetA9, null, 'missing rewardBudgetA9 must stay null, never 0');
  assert.equal(out.finalDetailLoading, false);
  assert.equal(out.finalCandlesSeen, 4);
  assert.equal(out.finalEntryCount, 12);
  assert.equal(out.finalRewardBudgetA9, 700000000);
  assert.equal(out.staleFlag, true);
  assert.equal(out.staleRound, 6);
  assert.deepEqual(out.localStorageKeys, []);
  assert.deepEqual(out.sessionStorageKeys, []);
});


