#!/usr/bin/env node
// A9 Protocol v15 — Offline ops self-test (zero external dependencies).
import assert from 'node:assert/strict';
import { formatTonAddress } from '../../worker/src/ton-address.mjs';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadParams,
  verifyV15Artifacts,
  resolveProtocolRoot,
  computeCorridor,
  assertTargetInCorridor,
  aggregateCandles,
  previewWinSettlement,
  validateDeployPreflight,
  withActonNetworkKeyEnv,
} from './lib/v15-core.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

console.log('Running A9 v15 ops offline self-test...');

test('v17 compiled artifacts match ci/artifacts.sha256 (4 contracts) and invalid protocol throws', () => {
  const list = verifyV15Artifacts();
  assert.equal(list.length, 4);
  assert.throws(() => resolveProtocolRoot('v15'), /must be v17 or v16/);
  assert.throws(() => resolveProtocolRoot('v14'), /must be v17 or v16/);
});

test('testnet / testnet-fast / mainnet param profiles validate cleanly', () => {
  const t = loadParams('testnet').data;
  const tf = loadParams('testnet-fast').data;
  const m = loadParams('mainnet').data;
  assert.equal(t.network, 'testnet');
  assert.equal(tf.profile, 'testnet-fast');
  assert.equal(m.network, 'mainnet');
  assert.equal(m.timing.stakeDurationSeconds, 86400);
  assert.equal(m.timing.earlyWindowSeconds, 21600);
  assert.equal(m.timing.observationSeconds, 43200);
  assert.equal(m.timing.candleCount, 12);
  assert.equal(m.timing.minQualifiedCandles, 8);
  assert.equal(m.timing.vestingSeconds, 1209600);
});

test('OpenRound [1.30x, 2.00x] corridor math and bounds check', () => {
  const c1 = computeCorridor(1, 0, 116000);
  assert.equal(c1.minTarget, 150800n);
  assert.equal(c1.maxTarget, 232000n);
  assertTargetInCorridor(1, 0, 150800, 116000);
  assert.throws(() => assertTargetInCorridor(1, 0, 150799, 116000));
  assert.throws(() => assertTargetInCorridor(2, 0, 232000, 116000));
});

test('12-candle off-chain aggregation produces deterministic candleHash', () => {
  const candles = Array.from({ length: 12 }, (_, i) => ({
    start: 1000 + i * 3600,
    end: 1000 + (i + 1) * 3600,
    twapUsdE8: i < 9 ? 160000 : 120000,
  }));
  const a1 = aggregateCandles(1, 150800, candles);
  const a2 = aggregateCandles(1, 150800, candles);
  assert.equal(a1.qualifiedCandles, 9);
  assert.equal(a1.candleHashHex, a2.candleHashHex);
  assert.equal(a1.candleHashHex.length, 66);
});

test('v17.0 win settlement math matches on-chain 5x cap, team ratio, and 20% + 14d linear vesting', () => {
  const A9 = 1_000_000_000n;
  const r1 = previewWinSettlement({
    budgetRaw: 700_000_000n * A9,
    totalStakeRaw: 2_000n * A9,
    teamBudgetRaw: 120_000_000n * A9,
  });
  assert.equal(r1.distributable, 10_000n * A9);
  assert.equal(r1.teamReleased, 1_714_285_714_285n);
  assert.equal(r1.immediateBps, 2000);
  assert.equal(r1.vestingSeconds, 1209600);
  assert.equal(r1.immediateTotal, 2_000n * A9);
  assert.equal(r1.lockedTotal, 8_000n * A9);

  const r11 = previewWinSettlement({
    budgetRaw: 700_000_000n * A9,
    totalStakeRaw: 200_000_000n * A9,
    teamBudgetRaw: 120_000_000n * A9,
  });
  assert.equal(r11.distributable, 700_000_000n * A9);
  assert.equal(r11.immediateBps, 2000);
  assert.equal(r11.immediateTotal, 140_000_000n * A9);
  assert.equal(r11.lockedTotal, 560_000_000n * A9);
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
      stdout: `Deployer = ${TESTNET_ADDR}\nTreasury = ${TESTNET_ADDR}\nJettonMaster = ${TESTNET_ADDR}\nRoundController = ${TESTNET_ADDR}\nDRY-RUN: no on-chain messages sent.\n`,
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

test('W2: aggregateCandles rejects non-contiguous, duplicated, mismatched-step, or unaligned observation windows', () => {
  const base = 1700000000;
  const good = Array.from({ length: 24 }, (_, i) => ({
    start: base + i * 3600,
    end: base + (i + 1) * 3600,
    twapUsdE8: 250000,
  }));
  const aligned = aggregateCandles(3, 232000, good, 24, { stakeCloseAt: base, observationSeconds: 86400 });
  assert.equal(aligned.windowStart, base);
  assert.equal(aligned.windowEnd, base + 86400);
  assert.equal(aligned.stepSeconds, 3600);

  // Gap between candle 4 and candle 5
  const gapped = good.map((c, i) => (i >= 5 ? { ...c, start: c.start + 60, end: c.end + 60 } : c));
  assert.throws(() => aggregateCandles(3, 232000, gapped, 24), /not contiguous/);

  // Duplicated timestamp
  const dup = good.map((c, i) => (i === 2 ? { ...good[1] } : c));
  assert.throws(() => aggregateCandles(3, 232000, dup, 24), /not contiguous/);

  // Mismatched duration
  const badStep = good.map((c, i) => (i === 0 ? { ...c, end: c.start + 1800 } : c));
  assert.throws(() => aggregateCandles(3, 232000, badStep, 24, { observationSeconds: 86400 }), /does not match expected step/);

  // Observation window misalignment
  assert.throws(() => aggregateCandles(3, 232000, good, 24, { stakeCloseAt: base + 3600, observationSeconds: 86400 }), /does not align with stakeCloseAt/);
});

test('W2: round-ops enforces explicit --round on open-round, blocks mainnet candle bypass, and rejects out-of-range --qualified', () => {
  const roundOpsPath = new URL('./round-ops.mjs', import.meta.url).pathname;

  // 1) open-round without --round must fail (no silent default to round 1)
  const rNoRound = spawnSync(process.execPath, [roundOpsPath, '--action', 'open-round', '--profile', 'testnet', '--target', '232000'], { encoding: 'utf8' });
  assert.notEqual(rNoRound.status, 0);
  assert.match(rNoRound.stderr, /--round <id> is required/);

  // 2) mainnet settle-round without --candles-file must fail
  const rMainnetBypass = spawnSync(process.execPath, [
    roundOpsPath, '--action', 'settle-round', '--profile', 'mainnet', '--round', '1', '--qualified', '18', '--candle-hash', '0x1234',
  ], { encoding: 'utf8' });
  assert.notEqual(rMainnetBypass.status, 0);
  assert.match(rMainnetBypass.stderr, /mainnet settle-round requires --candles-file/);

  // 2b) mainnet settle-round with --candles-file but missing --stake-close-at must fail
  const rMainnetNoCloseAt = spawnSync(process.execPath, [
    roundOpsPath, '--action', 'settle-round', '--profile', 'mainnet', '--round', '1', '--target', '232000', '--candles-file', '/tmp/unused.json',
  ], { encoding: 'utf8' });
  assert.notEqual(rMainnetNoCloseAt.status, 0);
  assert.match(rMainnetNoCloseAt.stderr, /mainnet settle-round requires --stake-close-at/);

  // 3) testnet settle-round with out-of-range --qualified=25 must fail
  const rBadQual = spawnSync(process.execPath, [
    roundOpsPath, '--action', 'settle-round', '--profile', 'testnet', '--round', '1', '--qualified', '25', '--candle-hash', '0x1234',
  ], { encoding: 'utf8' });
  assert.notEqual(rBadQual.status, 0);
  assert.match(rBadQual.stderr, /--qualified must be an integer in 0\.\.12/);
});

test('Mainnet preflight hardening: Acton network API key mapping, ample mainnet deployTon, and Basechain-only role guard', () => {
  const m = loadParams('mainnet').data;
  assert.equal(m.version, '17.0.0');
  assert.ok(BigInt(m.deployTon.jettonMaster) >= 500_000_000n);
  assert.ok(BigInt(m.deployTon.mintTotal) >= BigInt(m.deployTon.mintForward) + 100_000_000n);
  assert.ok(BigInt(m.deployTon.roundController) >= 1_500_000_000n);

  const mappedMainnet = withActonNetworkKeyEnv('mainnet', { TONCENTER_API_KEY: 'key_main_123' });
  assert.equal(mappedMainnet.TONCENTER_MAINNET_API_KEY, 'key_main_123');
  const mappedTestnet = withActonNetworkKeyEnv('testnet', { TONCENTER_API_KEY: 'key_test_456' });
  assert.equal(mappedTestnet.TONCENTER_TESTNET_API_KEY, 'key_test_456');

  const hash = new Uint8Array(32).fill(0x33);
  const MAINNET_ADDR = formatTonAddress(0, hash, { bounceable: true, testOnly: false });
  const MASTERCHAIN_ADDR = `-1:${'33'.repeat(32)}`;
  const okSpawn = () => ({
    status: 0,
    stdout: `Deployer = ${MAINNET_ADDR}\nTreasury = ${MAINNET_ADDR}\nJettonMaster = ${MAINNET_ADDR}\nRoundController = ${MAINNET_ADDR}\nDRY-RUN: no on-chain messages sent.\n`,
    stderr: '',
  });

  // Mainnet strict mode must reject missing TONCENTER_MAINNET_API_KEY / TONCENTER_API_KEY
  assert.throws(() => validateDeployPreflight({
    protocol: 'v17',
    profile: 'mainnet',
    env: {
      A9_METADATA_URI: 'https://app.a9.lat/a9.json',
      A9_DEPLOY_WALLET: 'deployer',
      A9_TREASURY_WALLET: 'treasury',
      A9_KEEPER_ADDRESS: MAINNET_ADDR,
      A9_TEAM_WALLET_ADDRESS: MAINNET_ADDR,
    },
    strict: true,
    spawnImpl: okSpawn,
  }), /TONCENTER_MAINNET_API_KEY/);

  // Masterchain (-1) role address must be rejected on v17
  assert.throws(() => validateDeployPreflight({
    protocol: 'v17',
    profile: 'mainnet',
    env: {
      A9_METADATA_URI: 'https://app.a9.lat/a9.json',
      A9_DEPLOY_WALLET: 'deployer',
      A9_TREASURY_WALLET: 'treasury',
      A9_KEEPER_ADDRESS: MAINNET_ADDR,
      A9_TEAM_WALLET_ADDRESS: MASTERCHAIN_ADDR,
      TONCENTER_API_KEY: 'key_main_123',
    },
    strict: true,
    spawnImpl: okSpawn,
  }), /Basechain workchain=0/);

  // Valid v17 mainnet preflight must invoke deploy_v17.tolk
  let invokedScript = '';
  const okV17 = validateDeployPreflight({
    protocol: 'v17',
    profile: 'mainnet',
    env: {
      A9_METADATA_URI: 'https://app.a9.lat/a9.json',
      A9_DEPLOY_WALLET: 'deployer',
      A9_TREASURY_WALLET: 'treasury',
      A9_KEEPER_ADDRESS: MAINNET_ADDR,
      A9_TEAM_WALLET_ADDRESS: MAINNET_ADDR,
      TONCENTER_API_KEY: 'key_main_123',
    },
    strict: true,
    spawnImpl: (_cmd, args) => {
      invokedScript = (args || []).join(' ');
      return okSpawn();
    },
  });
  assert.ok(okV17 && okV17.protocol === 'v17');
  assert.equal(okV17.readyForExecute, false, 'mainnet synchronous validation cannot grant online readiness');
  assert.match(invokedScript, /deploy_v17\.tolk/);
});

console.log(`All ${passed} v15 ops self-tests passed.`);
