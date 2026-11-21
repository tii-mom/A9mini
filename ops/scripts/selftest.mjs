#!/usr/bin/env node
// A9 Protocol v15 — Offline ops self-test (zero external dependencies).
import assert from 'node:assert/strict';
import {
  loadParams,
  verifyV15Artifacts,
  computeCorridor,
  assertTargetInCorridor,
  aggregateCandles,
  previewWinSettlement,
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

console.log(`All ${passed} v15 ops self-tests passed.`);
