#!/usr/bin/env node
// A9 Protocol v15 — Offline ops self-test (zero external dependencies).
import assert from 'node:assert/strict';
import { formatTonAddress } from '../../worker/src/ton-address.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadParams,
  verifyV15Artifacts,
  computeCorridor,
  assertTargetInCorridor,
  aggregateCandles,
  previewWinSettlement,
  validateDeployPreflight,
} from './lib/v15-core.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

console.log('Running A9 v15 ops offline self-test...');

test('v15 compiled artifacts match ci/artifacts.sha256 (4 contracts)', () => {
  const list = verifyV15Artifacts();
  assert.equal(list.length, 4);
});

test('testnet / testnet-fast / mainnet param profiles validate cleanly', () => {
  const t = loadParams('testnet').data;
  const tf = loadParams('testnet-fast').data;
  const m = loadParams('mainnet').data;
  assert.equal(t.network, 'testnet');
  assert.equal(tf.profile, 'testnet-fast');
  assert.equal(m.network, 'mainnet');
  assert.equal(m.timing.stakeDurationSeconds, 129600);
  assert.equal(m.timing.inactivityBurnSeconds, 7776000);
});

test('OpenRound [1.5x, 2.5x] corridor math and bounds check', () => {
  const c1 = computeCorridor(1, 0, 116000);
  assert.equal(c1.minTarget, 174000n);
  assert.equal(c1.maxTarget, 290000n);
  assertTargetInCorridor(1, 0, 232000, 116000);
  assert.throws(() => assertTargetInCorridor(1, 0, 173999, 116000));
  assert.throws(() => assertTargetInCorridor(2, 0, 232000, 116000));
});

test('24-candle off-chain aggregation produces deterministic candleHash', () => {
  const candles = Array.from({ length: 24 }, (_, i) => ({
    start: 1000 + i * 3600,
    end: 1000 + (i + 1) * 3600,
    twapUsdE8: i < 18 ? 250000 : 200000,
  }));
  const a1 = aggregateCandles(1, 232000, candles);
  const a2 = aggregateCandles(1, 232000, candles);
  assert.equal(a1.qualifiedCandles, 18);
  assert.equal(a1.candleHashHex, a2.candleHashHex);
  assert.equal(a1.candleHashHex.length, 66);
});

test('v15 win settlement math matches on-chain 15x cap, team ratio, and 3-tier unlock', () => {
  const A9 = 1_000_000_000n;
  const r1 = previewWinSettlement({
    budgetRaw: 700_000_000n * A9,
    totalStakeRaw: 2_000n * A9,
    teamBudgetRaw: 120_000_000n * A9,
    nextSuccessCount: 1,
  });
  assert.equal(r1.distributable, 30_000n * A9);
  assert.equal(r1.teamReleased, 5_142_857_142_857n);
  assert.equal(r1.immediateBps, 2000);
  assert.equal(r1.lockedSlices, 4);

  const r11 = previewWinSettlement({
    budgetRaw: 700_000_000n * A9,
    totalStakeRaw: 50_000_000n * A9,
    teamBudgetRaw: 120_000_000n * A9,
    nextSuccessCount: 11,
  });
  assert.equal(r11.distributable, 700_000_000n * A9);
  assert.equal(r11.immediateBps, 10000);
  assert.equal(r11.lockedSlices, 0);
});

test('validateDeployPreflight rejects malformed URI, invalid/wrong-network TON addresses, stub/invalid wallet sections, and Acton read-only resolution failures', () => {
  const tmpWallets = join(tmpdir(), `a9-selftest-wallets-${process.pid}.toml`);
  const tmpStubWallets = join(tmpdir(), `a9-selftest-stub-wallets-${process.pid}.toml`);
  writeFileSync(
    tmpWallets,
    '[wallets.deployer]\nversion = "v4r2"\nmnemonic = "word1 word2 word3"\n[wallets.treasury]\nversion = "v4r2"\nmnemonic = "word4 word5 word6"\n',
    'utf8',
  );
  // Section header exists, but wallet body is empty / invalid
  writeFileSync(tmpStubWallets, '[wallets.fake]\n[wallets.empty_ver]\nversion = "v4r2"\n', 'utf8');

  const hash = new Uint8Array(32).fill(0x55);
  const TESTNET_ADDR = formatTonAddress(0, hash, { bounceable: true, testOnly: true });
  const MAINNET_ADDR = formatTonAddress(0, hash, { bounceable: true, testOnly: false });
  const validEnv = {
    A9_METADATA_URI: 'https://a9.lat/a9.json',
    A9_DEPLOY_WALLET: 'deployer',
    A9_TREASURY_WALLET: 'treasury',
    A9_KEEPER_ADDRESS: TESTNET_ADDR,
    A9_TEAM_WALLET_ADDRESS: TESTNET_ADDR,
  };
  let capturedActon = null;
  const okActonSpawn = (cmd, args, opts) => {
    capturedActon = { cmd, args, env: opts.env };
    return {
      status: 0,
      stdout: 'Deployer = kQ_mock_deployer\nTreasury = kQ_mock_treasury\nDRY-RUN: no on-chain messages sent.\n',
      stderr: '',
    };
  };
  const failActonSpawn = () => ({
    status: 1,
    stdout: '',
    stderr: 'Error: failed to resolve wallet "deployer": invalid mnemonic\n',
  });

  const failMissingSpawn = () => ({
    status: 1,
    stdout: '',
    stderr: 'Error: wallet "missing" not found in wallets.toml\n',
  });

  try {
    const ok = validateDeployPreflight({
      protocol: 'v16',
      profile: 'testnet-fast',
      env: validEnv,
      strict: true,
      spawnImpl: okActonSpawn,
    });
    assert.equal(ok.readyForExecute, true);
    assert.equal(ok.invalid.length, 0);
    assert.equal(capturedActon.cmd, 'acton');
    assert.equal(capturedActon.env.OPS_EXECUTE, 'false');

    // 1) Incomplete URI ("https://") -> invalid & throws in strict mode
    const badUri = validateDeployPreflight({ protocol: 'v16', profile: 'testnet-fast', env: { ...validEnv, A9_METADATA_URI: 'https://' }, strict: false, spawnImpl: okActonSpawn });
    assert.equal(badUri.readyForExecute, false);
    assert.ok(badUri.invalid.some((x) => x.includes('A9_METADATA_URI')));
    assert.throws(() => validateDeployPreflight({ protocol: 'v16', profile: 'testnet-fast', env: { ...validEnv, A9_METADATA_URI: 'https://' }, strict: true, spawnImpl: okActonSpawn }), /A9_METADATA_URI/);

    // 2) Invalid TON address ("invalid") -> invalid & throws in strict mode
    assert.throws(() => validateDeployPreflight({ protocol: 'v16', profile: 'testnet-fast', env: { ...validEnv, A9_KEEPER_ADDRESS: 'invalid' }, strict: true, spawnImpl: okActonSpawn }), /A9_KEEPER_ADDRESS/);

    // 3) Mainnet-only friendly address on testnet -> rejected; testnet-only address on mainnet -> rejected
    assert.throws(() => validateDeployPreflight({ protocol: 'v16', profile: 'testnet-fast', env: { ...validEnv, A9_TEAM_WALLET_ADDRESS: MAINNET_ADDR }, strict: true, spawnImpl: okActonSpawn }), /mainnet-only friendly address/);
    assert.throws(() => validateDeployPreflight({ protocol: 'v16', profile: 'mainnet', env: { ...validEnv, A9_KEEPER_ADDRESS: TESTNET_ADDR, A9_TEAM_WALLET_ADDRESS: TESTNET_ADDR }, strict: true, spawnImpl: okActonSpawn }), /testnet-only address/);

    // 4) Unresolvable Acton wallet ("missing") -> rejected via Acton read-only resolution
    assert.throws(() => validateDeployPreflight({ protocol: 'v16', profile: 'testnet-fast', env: { ...validEnv, A9_DEPLOY_WALLET: 'missing' }, strict: true, spawnImpl: failMissingSpawn }), /Acton read-only wallet\/deploy resolution failed/);

    // 5) Empty section ([wallets.fake]) or invalid credentials -> rejected via Acton read-only resolution
    const actonFail = validateDeployPreflight({
      protocol: 'v16',
      profile: 'testnet-fast',
      env: { ...validEnv, A9_DEPLOY_WALLET: 'fake' },
      strict: false,
      spawnImpl: failActonSpawn,
    });
    assert.equal(actonFail.readyForExecute, false);
    assert.ok(actonFail.invalid.some((x) => x.includes('Acton read-only wallet/deploy resolution failed')));
    assert.throws(() => validateDeployPreflight({
      protocol: 'v16',
      profile: 'testnet-fast',
      env: { ...validEnv, A9_DEPLOY_WALLET: 'fake' },
      strict: true,
      spawnImpl: failActonSpawn,
    }), /Acton read-only wallet\/deploy resolution failed/);
  } finally {
    try { unlinkSync(tmpWallets); } catch {}
    try { unlinkSync(tmpStubWallets); } catch {}
  }
});

console.log(`All ${passed} v15 ops self-tests passed.`);
