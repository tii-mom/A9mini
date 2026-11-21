// A9 Protocol v15 — Zero-dependency core ops library (Node 20+ ESM).
// Covers: artifact SHA-256 verification, params validation, [1.5x, 2.5x] corridor math,
// 24-candle off-chain aggregation + deterministic candleHash, and v15 conservation math.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const OPS_ROOT = resolve(__dirname, '../..');
export const V15_ROOT = resolve(OPS_ROOT, '../v15');

export const BPS = 10000n;
export const MAX_REWARD_MULTIPLIER = 15n;

const A9 = 1_000_000_000n;
const TON = 1_000_000_000n;

const SHARED_SUPPLY = {
  decimals: 9,
  totalSupplyRaw: String(10_000_000_000n * A9),
  rewardPoolRaw: String(7_000_000_000n * A9),
  teamPoolRaw: String(1_200_000_000n * A9),
  rcFundingRaw: String(8_200_000_000n * A9),
};

const SHARED_ECON = {
  p0UsdE8: '116000',
  roundRewardRaw: String(700_000_000n * A9),
  teamRoundRaw: String(120_000_000n * A9),
  minStakeRaw: String(1_000n * A9),
  maxRewardMultiplier: 15,
};

const PROD_TIMING = {
  stakeDurationSeconds: 129600,
  observationSeconds: 86400,
  candleCount: 24,
  minQualifiedCandles: 16,
  abortTimeoutSeconds: 604800,
  fallbackUnlockSeconds: 2592000,
  inactivityBurnSeconds: 7776000,
};

export const PROFILES = {
  testnet: {
    version: '15.0.0',
    network: 'testnet',
    profile: 'testnet',
    supply: SHARED_SUPPLY,
    econ: SHARED_ECON,
    timing: PROD_TIMING,
    deployTon: {
      jettonMaster: String(1n * TON),
      mintTotal: String(500_000_000n),
      mintForward: String(300_000_000n),
      roundController: String(3n * TON),
      fundingTransfer: String(200_000_000n),
    },
    promoHotWallet: { userFeeTon: '0.06', transferGasTon: '0.05' },
  },
  'testnet-fast': {
    version: '15.0.0',
    network: 'testnet',
    profile: 'testnet-fast',
    supply: SHARED_SUPPLY,
    econ: SHARED_ECON,
    timing: {
      stakeDurationSeconds: 120,
      observationSeconds: 60,
      candleCount: 24,
      minQualifiedCandles: 16,
      abortTimeoutSeconds: 120,
      fallbackUnlockSeconds: 300,
      inactivityBurnSeconds: 600,
    },
    deployTon: {
      jettonMaster: String(500_000_000n),
      mintTotal: String(500_000_000n),
      mintForward: String(300_000_000n),
      roundController: String(1_500_000_000n),
      fundingTransfer: String(200_000_000n),
    },
    promoHotWallet: { userFeeTon: '0.06', transferGasTon: '0.05' },
  },
  mainnet: {
    version: '15.0.0',
    network: 'mainnet',
    profile: 'mainnet',
    supply: SHARED_SUPPLY,
    econ: SHARED_ECON,
    timing: PROD_TIMING,
    deployTon: {
      jettonMaster: String(250_000_000n),
      mintTotal: String(300_000_000n),
      mintForward: String(150_000_000n),
      roundController: String(800_000_000n),
      fundingTransfer: String(150_000_000n),
    },
    promoHotWallet: { userFeeTon: '0.06', transferGasTon: '0.05' },
  },
};

export function loadParams(profileName = 'testnet') {
  const data = PROFILES[profileName];
  if (!data) throw new Error(`unknown profile: ${profileName} (expected: ${Object.keys(PROFILES).join(', ')})`);
  validateParams(data);
  return { profile: profileName, data };
}

export function validateParams(p) {
  if (p.version !== '15.0.0') throw new Error(`unexpected version: ${p.version}`);
  if (p.network !== 'testnet' && p.network !== 'mainnet') {
    throw new Error(`network must be testnet or mainnet, got ${p.network}`);
  }
  const total = BigInt(p.supply.totalSupplyRaw);
  const reward = BigInt(p.supply.rewardPoolRaw);
  const team = BigInt(p.supply.teamPoolRaw);
  const funding = BigInt(p.supply.rcFundingRaw);
  if (total !== 10_000_000_000_000_000_000n) throw new Error('totalSupplyRaw must be 10B * 1e9');
  if (reward + team !== funding) throw new Error('rewardPoolRaw + teamPoolRaw must equal rcFundingRaw');
  if (funding > total) throw new Error('rcFundingRaw exceeds totalSupplyRaw');
  if (BigInt(p.econ.minStakeRaw) <= 0n) throw new Error('minStakeRaw must be positive');
  if (p.timing.minQualifiedCandles > p.timing.candleCount || p.timing.candleCount <= 0) {
    throw new Error('invalid candleCount / minQualifiedCandles');
  }
  if (p.network === 'mainnet' && p.timing.stakeDurationSeconds < 3600) {
    throw new Error('mainnet stakeDurationSeconds too short');
  }
  return true;
}

export function verifyV15Artifacts(v15Root = V15_ROOT) {
  const manifestPath = resolve(v15Root, 'ci/artifacts.sha256');
  const lines = readFileSync(manifestPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const results = [];
  for (const line of lines) {
    const [expectedHash, relPath] = line.split(/\s+/);
    const fullPath = resolve(v15Root, relPath);
    const actualHash = createHash('sha256').update(readFileSync(fullPath)).digest('hex');
    if (actualHash !== expectedHash) {
      throw new Error(`artifact hash mismatch for ${relPath}: expected ${expectedHash}, got ${actualHash}`);
    }
    results.push({ relPath, sha256: actualHash });
  }
  if (results.length !== 4) throw new Error(`expected 4 v15 artifacts, found ${results.length}`);
  return results;
}

// v15 corridor: [floor(base * 3 / 2), floor(base * 5 / 2)]
export function computeCorridor(roundId, twap24hUsdE8, p0UsdE8) {
  const twap = BigInt(twap24hUsdE8);
  const p0 = BigInt(p0UsdE8);
  const base = roundId === 1 && twap === 0n ? p0 : twap;
  if (base <= 0n) throw new Error('basePrice must be > 0 (twap24h=0 only allowed on Round 1)');
  return {
    base,
    minTarget: (base * 3n) / 2n,
    maxTarget: (base * 5n) / 2n,
  };
}

export function assertTargetInCorridor(roundId, twap24hUsdE8, targetPriceUsdE8, p0UsdE8) {
  const { base, minTarget, maxTarget } = computeCorridor(roundId, twap24hUsdE8, p0UsdE8);
  const target = BigInt(targetPriceUsdE8);
  if (target < minTarget || target > maxTarget) {
    throw new Error(`target ${target} outside [1.5x, 2.5x] corridor [${minTarget}, ${maxTarget}] for base ${base}`);
  }
  return { base, minTarget, maxTarget, target };
}

// Aggregate 24 hourly candles off-chain into single-tx SettleRound inputs
export function aggregateCandles(roundId, targetPriceUsdE8, candles, expectedCount = 24) {
  if (!Array.isArray(candles) || candles.length !== expectedCount) {
    throw new Error(`expected ${expectedCount} candles, got ${candles?.length ?? 0}`);
  }
  const target = BigInt(targetPriceUsdE8);
  let qualifiedCandles = 0;
  const canonical = candles.map((c, idx) => {
    const price = BigInt(c.twapUsdE8);
    if (price <= 0n) throw new Error(`candle[${idx}] twapUsdE8 must be > 0`);
    if (price >= target) qualifiedCandles += 1;
    return { index: idx, start: Number(c.start), end: Number(c.end), twapUsdE8: price.toString() };
  });
  const payload = JSON.stringify({ version: 'a9-v15-candles', roundId, targetPriceUsdE8: target.toString(), candles: canonical });
  const hashHex = createHash('sha256').update(payload).digest('hex');
  return {
    roundId,
    qualifiedCandles,
    candleHashHex: `0x${hashHex}`,
    candleHashDec: BigInt(`0x${hashHex}`).toString(),
    canonicalJson: payload,
  };
}

// Mirror of RoundController.tolk v15 win settlement math for off-chain verification
export function previewWinSettlement({ budgetRaw, totalStakeRaw, teamBudgetRaw, nextSuccessCount }) {
  const budget = BigInt(budgetRaw);
  const stake = BigInt(totalStakeRaw);
  const teamBudget = BigInt(teamBudgetRaw);
  const cap = stake * MAX_REWARD_MULTIPLIER;
  const distributable = budget < cap ? budget : cap;
  const carryDelta = budget - distributable;
  const teamReleased = budget > 0n ? (teamBudget * distributable) / budget : 0n;
  const teamCarryAfter = teamBudget - teamReleased;
  const immediateBps = nextSuccessCount <= 5 ? 2000n : nextSuccessCount <= 10 ? 4000n : 10000n;
  const lockedSlices = nextSuccessCount <= 5 ? 4 : nextSuccessCount <= 10 ? 2 : 0;
  const immediateTotal = (distributable * immediateBps) / BPS;
  const lockedTotal = distributable - immediateTotal;
  return {
    distributable,
    carryDelta,
    teamReleased,
    teamCarryAfter,
    immediateBps: Number(immediateBps),
    lockedSlices,
    immediateTotal,
    lockedTotal,
  };
}
