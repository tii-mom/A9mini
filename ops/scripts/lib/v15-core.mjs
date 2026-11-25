// A9 Protocol v15 — Zero-dependency core ops library (Node 20+ ESM).
// Covers: artifact SHA-256 verification, params validation, [1.5x, 2.5x] corridor math,
// 24-candle off-chain aggregation + deterministic candleHash, and v15 conservation math.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const OPS_ROOT = resolve(__dirname, '../..');
export const V16_ROOT = resolve(OPS_ROOT, '../v16');
export function resolveProtocolRoot(protocolVersion = 'v16') {
  if (protocolVersion === 'v16') return V16_ROOT;
  throw new Error(`--protocol must be v16, got ${protocolVersion}`);
}


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
  vestingSeconds: 3456000, // 40d linear vesting (80% / 40d = 2%/day)
};

export const PROFILES = {
  testnet: {
    version: '16.2.0',
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
    version: '16.2.0',
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
      vestingSeconds: 1200, // 20m fast linear vesting for testnet end-to-end verification
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
    version: '16.2.0',
    network: 'mainnet',
    profile: 'mainnet',
    supply: SHARED_SUPPLY,
    econ: SHARED_ECON,
    timing: PROD_TIMING,
    deployTon: {
      jettonMaster: String(500_000_000n),
      mintTotal: String(500_000_000n),
      mintForward: String(250_000_000n),
      roundController: String(1_500_000_000n),
      fundingTransfer: String(250_000_000n),
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
  if (p.version !== '16.2.0') throw new Error(`unexpected version: ${p.version}`);
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

export function verifyV15Artifacts(protocolRoot = V16_ROOT) {
  const manifestPath = resolve(protocolRoot, 'ci/artifacts.sha256');
  const lines = readFileSync(manifestPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const results = [];
  for (const line of lines) {
    const [expectedHash, relPath] = line.split(/\s+/);
    const fullPath = resolve(protocolRoot, relPath);
    const actualHash = createHash('sha256').update(readFileSync(fullPath)).digest('hex');
    if (actualHash !== expectedHash) {
      throw new Error(`artifact hash mismatch for ${relPath}: expected ${expectedHash}, got ${actualHash}`);
    }
    results.push({ relPath, sha256: actualHash });
  }
  if (results.length !== 4) throw new Error(`expected 4 contract artifacts, found ${results.length}`);
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
export function aggregateCandles(roundId, targetPriceUsdE8, candles, expectedCount = 24, opts = {}) {
  const rId = Number(roundId);
  if (!Number.isInteger(rId) || rId < 1) {
    throw new Error(`roundId must be a positive integer, got ${roundId}`);
  }
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    throw new Error(`expectedCount must be a positive integer, got ${expectedCount}`);
  }
  if (!Array.isArray(candles) || candles.length !== expectedCount) {
    throw new Error(`expected ${expectedCount} candles, got ${candles?.length ?? 0}`);
  }
  const target = BigInt(targetPriceUsdE8);
  if (target <= 0n) {
    throw new Error('targetPriceUsdE8 must be > 0');
  }

  const observationSeconds = opts?.observationSeconds !== undefined && opts?.observationSeconds !== null
    ? Number(opts.observationSeconds)
    : null;
  let expectedStep = opts?.stepSeconds !== undefined && opts?.stepSeconds !== null
    ? Number(opts.stepSeconds)
    : null;
  if (observationSeconds !== null) {
    if (!Number.isInteger(observationSeconds) || observationSeconds <= 0) {
      throw new Error(`invalid observationSeconds: ${opts.observationSeconds}`);
    }
    if (observationSeconds % expectedCount !== 0) {
      throw new Error(`observationSeconds (${observationSeconds}) must be divisible by expectedCount (${expectedCount})`);
    }
    const derivedStep = observationSeconds / expectedCount;
    if (expectedStep !== null && expectedStep !== derivedStep) {
      throw new Error(`stepSeconds (${expectedStep}) does not match observationSeconds / expectedCount (${derivedStep})`);
    }
    expectedStep = derivedStep;
  }
  if (expectedStep !== null && (!Number.isInteger(expectedStep) || expectedStep <= 0)) {
    throw new Error(`invalid stepSeconds: ${expectedStep}`);
  }

  let qualifiedCandles = 0;
  let inferredStep = expectedStep;
  const canonical = candles.map((c, idx) => {
    if (!c || typeof c !== 'object') throw new Error(`candle[${idx}] must be an object`);
    const start = Number(c.start);
    const end = Number(c.end);
    if (!Number.isInteger(start) || start <= 0) {
      throw new Error(`candle[${idx}].start must be a positive unix timestamp integer, got ${c.start}`);
    }
    if (!Number.isInteger(end) || end <= start) {
      throw new Error(`candle[${idx}].end (${c.end}) must be an integer > start (${c.start})`);
    }
    const duration = end - start;
    if (inferredStep === null) inferredStep = duration;
    if (duration !== inferredStep) {
      throw new Error(`candle[${idx}] duration (${duration}s) does not match expected step (${inferredStep}s)`);
    }
    const price = BigInt(c.twapUsdE8);
    if (price <= 0n) throw new Error(`candle[${idx}] twapUsdE8 must be > 0`);
    if (price >= target) qualifiedCandles += 1;
    return { index: idx, start, end, twapUsdE8: price.toString() };
  });

  // 严格校验时间轴连续单调，杜绝重复 K 线、倒序或漏时段
  for (let i = 1; i < canonical.length; i += 1) {
    if (canonical[i].start !== canonical[i - 1].end) {
      throw new Error(
        `candle[${i}] start (${canonical[i].start}) is not contiguous with candle[${i - 1}].end (${canonical[i - 1].end})`,
      );
    }
  }

  // 若调用方传入质押截止时间戳（观察窗起点），严格校验首尾对齐观察窗
  if (opts?.stakeCloseAt !== undefined && opts?.stakeCloseAt !== null) {
    const stakeCloseAt = Number(opts.stakeCloseAt);
    if (!Number.isInteger(stakeCloseAt) || stakeCloseAt <= 0) {
      throw new Error(`invalid stakeCloseAt: ${opts.stakeCloseAt}`);
    }
    if (canonical[0].start !== stakeCloseAt) {
      throw new Error(`candle[0].start (${canonical[0].start}) does not align with stakeCloseAt (${stakeCloseAt})`);
    }
    if (observationSeconds !== null) {
      const expectedEnd = stakeCloseAt + observationSeconds;
      const actualEnd = canonical[canonical.length - 1].end;
      if (actualEnd !== expectedEnd) {
        throw new Error(`last candle end (${actualEnd}) does not align with stakeCloseAt + observationSeconds (${expectedEnd})`);
      }
    }
  }

  const payload = JSON.stringify({ version: 'a9-v15-candles', roundId: rId, targetPriceUsdE8: target.toString(), candles: canonical });
  const hashHex = createHash('sha256').update(payload).digest('hex');
  return {
    roundId: rId,
    qualifiedCandles,
    candleHashHex: `0x${hashHex}`,
    candleHashDec: BigInt(`0x${hashHex}`).toString(),
    canonicalJson: payload,
    windowStart: canonical[0].start,
    windowEnd: canonical[canonical.length - 1].end,
    stepSeconds: inferredStep,
  };
}

// Mirror of RoundController.tolk v16.2 win settlement math (constant 20% immediate + 80% 40-day linear vesting)
export function previewWinSettlement({ budgetRaw, totalStakeRaw, teamBudgetRaw, vestingSeconds = 3456000 }) {
  const budget = BigInt(budgetRaw);
  const stake = BigInt(totalStakeRaw);
  const teamBudget = BigInt(teamBudgetRaw);
  const cap = stake * MAX_REWARD_MULTIPLIER;
  const distributable = budget < cap ? budget : cap;
  const carryDelta = budget - distributable;
  const teamReleased = budget > 0n ? (teamBudget * distributable) / budget : 0n;
  const teamCarryAfter = teamBudget - teamReleased;
  const immediateBps = 2000n;
  const immediateTotal = (distributable * immediateBps) / BPS;
  const lockedTotal = distributable - immediateTotal;
  return {
    distributable,
    carryDelta,
    teamReleased,
    teamCarryAfter,
    immediateBps: Number(immediateBps),
    vestingSeconds: Number(vestingSeconds),
    immediateTotal,
    lockedTotal,
  };
}

function crc16Ccitt(data) {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function parseTonAddressForOps(input) {
  const a = String(input || '').trim();
  if (!a) return null;
  const raw = a.match(/^(-?\d{1,3}):([0-9a-fA-F]{64})$/);
  if (raw) {
    const wc = Number(raw[1]);
    if (wc !== 0 && wc !== -1) return null;
    return { workchain: wc, bounceable: null, testOnly: null, format: 'raw' };
  }
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(a)) return null;
  let bytes;
  try {
    bytes = Buffer.from(a.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return null;
  }
  if (bytes.length !== 36) return null;
  const expected = (bytes[34] << 8) | bytes[35];
  if (crc16Ccitt(bytes.subarray(0, 34)) !== expected) return null;
  const tag = bytes[0];
  const testOnly = (tag & 0x80) !== 0;
  const base = tag & 0x7f;
  if (base !== 0x11 && base !== 0x51) return null;
  const wcByte = bytes[1];
  const workchain = wcByte === 0xff ? -1 : wcByte;
  if (workchain !== 0 && workchain !== -1) return null;
  return { workchain, bounceable: base === 0x11, testOnly, format: 'friendly' };
}

export function validateMetadataUri(uri) {
  const raw = String(uri || '').trim();
  if (!raw || /\s/.test(raw)) return { ok: false, reason: 'must be a non-empty https:// or ipfs:// URI without spaces' };
  if (/^https:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, reason: 'invalid https:// URL' };
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname || !parsed.hostname.includes('.') || /^\.|\.$/.test(parsed.hostname)) {
      return { ok: false, reason: 'https:// URI must include a valid host (e.g. https://a9.lat/a9.json)' };
    }
    return { ok: true };
  }
  if (/^ipfs:\/\//i.test(raw)) {
    const rest = raw.slice(7);
    if (!/^[A-Za-z0-9]{16,}(\/[^\s]*)?$/.test(rest)) {
      return { ok: false, reason: 'ipfs:// URI must include a valid CID' };
    }
    return { ok: true };
  }
  return { ok: false, reason: 'must use https:// or ipfs:// scheme' };
}

const RESERVED_TOML_SECTIONS = new Set([
  'global', 'default', 'package', 'toolchain', 'test', 'fmt', 'import-mappings', 'networks', 'contracts', 'wallets',
]);

const WALLET_CREDENTIAL_KEYS = new Set([
  'mnemonic', 'secret_key', 'private_key', 'seed', 'key', 'mnemonic_env', 'secret_key_env', 'private_key_env',
]);

export function discoverActonWallets(protocolRoot, env = process.env, explicitWalletFiles = null) {
  const candidates = Array.isArray(explicitWalletFiles)
    ? explicitWalletFiles
    : [
        env.ACTON_WALLETS_FILE || null,
        resolve(protocolRoot, 'wallets.toml'),
        resolve(protocolRoot, 'global.wallets.toml'),
        env.HOME ? resolve(env.HOME, '.config/acton/wallets/wallets.toml') : null,
        env.HOME ? resolve(env.HOME, '.config/acton/wallets/global.wallets.toml') : null,
      ].filter(Boolean);

  const walletSections = new Map();
  const readableFiles = [];
  for (const filePath of candidates) {
    let text;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    readableFiles.push(filePath);
    let currentWallet = null;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (!line) continue;
      if (line.startsWith('[')) {
        const nested = line.match(/^\[wallets\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\]$/);
        if (nested) {
          currentWallet = nested[1] || nested[2] || nested[3];
          if (!walletSections.has(currentWallet)) walletSections.set(currentWallet, new Map());
          continue;
        }
        const top = line.match(/^\[(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\]$/);
        if (top) {
          const name = top[1] || top[2] || top[3];
          if (!RESERVED_TOML_SECTIONS.has(name.toLowerCase())) {
            currentWallet = name;
            if (!walletSections.has(currentWallet)) walletSections.set(currentWallet, new Map());
            continue;
          }
        }
        currentWallet = null;
        continue;
      }
      if (currentWallet) {
        const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
        if (kv) {
          const k = kv[1].trim().toLowerCase();
          const v = kv[2].trim().replace(/^["']|["']$/g, '').trim();
          walletSections.get(currentWallet).set(k, v);
        }
      }
    }
  }

  const walletNames = new Set();
  const emptyOrInvalidWallets = new Set();
  for (const [name, fields] of walletSections.entries()) {
    const hasCred = Array.from(fields.entries()).some(
      ([k, v]) => WALLET_CREDENTIAL_KEYS.has(k) && v.length > 0,
    );
    if (hasCred) walletNames.add(name);
    else emptyOrInvalidWallets.add(name);
  }
  return { walletNames, emptyOrInvalidWallets, readableFiles };
}

/**
 * 将 TONCENTER_API_KEY 自动映射为 Acton 1.1.0 实际读取的
 * TONCENTER_MAINNET_API_KEY / TONCENTER_TESTNET_API_KEY，防止静默退回 1 RPS 匿名限流。
 */
export function withActonNetworkKeyEnv(network, baseEnv = process.env) {
  const fallback = String(baseEnv?.TONCENTER_API_KEY || '').trim();
  if (network === 'mainnet') {
    const k = String(baseEnv?.TONCENTER_MAINNET_API_KEY || fallback).trim();
    return { ...baseEnv, ...(k ? { TONCENTER_MAINNET_API_KEY: k } : {}) };
  }
  if (network === 'testnet') {
    const k = String(baseEnv?.TONCENTER_TESTNET_API_KEY || fallback).trim();
    return { ...baseEnv, ...(k ? { TONCENTER_TESTNET_API_KEY: k } : {}) };
  }
  return { ...baseEnv };
}

/**
 * Invoke the exact deployment script (`ops/tolk/deploy_v15.tolk` or `ops/tolk/deploy_v16.tolk`)
 * with OPS_EXECUTE=false so Acton itself resolves A9_DEPLOY_WALLET and A9_TREASURY_WALLET via
 * `scripts.wallet(...)` in read-only mode without broadcasting any on-chain message.
 */
export function verifyActonWalletsReadOnly({
  protocol,
  params,
  protocolRoot,
  env = process.env,
  spawnImpl = spawnSync,
}) {
  const dryEnv = {
    ...withActonNetworkKeyEnv(params.network, env),
    A9_NETWORK: params.network,
    A9_PROTOCOL_VERSION: protocol,
    A9_TOTAL_SUPPLY_RAW: params.supply.totalSupplyRaw,
    A9_REWARD_POOL_RAW: params.supply.rewardPoolRaw,
    A9_TEAM_POOL_RAW: params.supply.teamPoolRaw,
    A9_RC_FUNDING_RAW: params.supply.rcFundingRaw,
    A9_P0_USD_E8: params.econ.p0UsdE8,
    A9_ROUND_REWARD_RAW: params.econ.roundRewardRaw,
    A9_TEAM_ROUND_RAW: params.econ.teamRoundRaw,
    A9_MIN_STAKE_RAW: params.econ.minStakeRaw,
    A9_STAKE_SECONDS: String(params.timing.stakeDurationSeconds),
    A9_OBS_SECONDS: String(params.timing.observationSeconds),
    A9_CANDLE_COUNT: String(params.timing.candleCount),
    A9_MIN_QUALIFIED: String(params.timing.minQualifiedCandles),
    A9_ABORT_TIMEOUT_SECONDS: String(params.timing.abortTimeoutSeconds),
    A9_VESTING_SECONDS: String(params.timing.vestingSeconds),
    A9_TON_MASTER: params.deployTon.jettonMaster,
    A9_TON_MINT_TOTAL: params.deployTon.mintTotal,
    A9_TON_MINT_FORWARD: params.deployTon.mintForward,
    A9_TON_RC: params.deployTon.roundController,
    A9_TON_FUNDING: params.deployTon.fundingTransfer,
    OPS_EXECUTE: 'false',
    OPS_CONFIRM: '',
    OPS_CONFIRM_MAINNET: '',
  };
  const deployScript = '../ops/tolk/deploy_v16.tolk';
  const res = spawnImpl('acton', ['script', '--net', params.network, deployScript], {
    cwd: protocolRoot,
    env: dryEnv,
    encoding: 'utf8',
  });
  const stdout = String(res?.stdout || '');
  const stderr = String(res?.stderr || '');
  const errMsg = res?.error ? String(res.error.message || res.error) : '';
  if (res?.status !== 0 || !stdout.includes('DRY-RUN: no on-chain messages sent.')) {
    const detail = (stderr || stdout || errMsg || `exit status ${res?.status}`).trim().split('\n').slice(-4).join(' | ');
    return { ok: false, error: `Acton read-only wallet/deploy resolution failed: ${detail}` };
  }
  return { ok: true, stdout };
}

export function parseActonDerivedAddresses(stdout = '') {
  const pick = (label) => {
    const re = new RegExp(`^${label}\\s*=\\s*(\\S+)`, 'm');
    const m = String(stdout).match(re);
    return m ? m[1] : null;
  };
  const jettonMaster = pick('JettonMaster');
  const roundController = pick('RoundController');
  const deployer = pick('Deployer');
  const treasury = pick('Treasury');
  if (!jettonMaster && !roundController && !deployer && !treasury) return null;
  return { jettonMaster, roundController, deployer, treasury };
}

/**
 * Unified deployment preflight validator shared by BOTH --dry-run and --execute paths.
 * Checks: protocol root + 4 artifact SHA-256 hashes, network/supply conservation,
 * full metadata URI, TON role addresses + network match, Acton wallet resolvability
 * (both TOML structure and real read-only Acton `scripts.wallet()` resolution),
 * and execution confirmation gates.
 */
export function validateDeployPreflight({
  protocol = 'v16',
  profile = 'testnet',
  env = process.env,
  execute = false,
  strict = false,
  walletFiles = null,
  spawnImpl = spawnSync,
} = {}) {
  const { profile: resolvedProfile, data: params } = loadParams(profile);
  const protocolRoot = resolveProtocolRoot(protocol);
  const artifacts = verifyV15Artifacts(protocolRoot);

  const missing = [];
  const invalid = [];
  const warnings = [];

  const metadataUri = String(env.A9_METADATA_URI || '').trim();
  if (!metadataUri) {
    missing.push('A9_METADATA_URI (must be a valid https:// or ipfs:// URI; JettonMaster renounces admin immediately after MintOnce)');
  } else {
    const uriCheck = validateMetadataUri(metadataUri);
    if (!uriCheck.ok) {
      invalid.push(`A9_METADATA_URI="${metadataUri}" (${uriCheck.reason})`);
    }
  }

  const validateRoleAddress = (key, required) => {
    const val = String(env[key] || '').trim();
    if (!val) {
      if (required) missing.push(key);
      return;
    }
    const parsed = parseTonAddressForOps(val);
    if (!parsed) {
      invalid.push(`${key}="${val}" (not a valid TON address)`);
      return;
    }
    if (parsed.workchain !== 0) {
      invalid.push(`${key}="${val}" (must be Basechain workchain=0; Masterchain -1 is unsupported)`);
      return;
    }
    if (params.network === 'mainnet' && parsed.testOnly === true) {
      invalid.push(`${key}="${val}" (testnet-only address cannot be used on mainnet)`);
    } else if (params.network === 'testnet' && parsed.testOnly === false) {
      invalid.push(`${key}="${val}" (mainnet-only friendly address cannot be used on testnet; use kQ/0Q or raw 0:...)`);
    }
  };

  validateRoleAddress('A9_KEEPER_ADDRESS', true);
  validateRoleAddress('A9_TEAM_WALLET_ADDRESS', true);
  if (String(env.A9_ROUND_OPENER_ADDRESS || '').trim()) {
    validateRoleAddress('A9_ROUND_OPENER_ADDRESS', false);
  } else {
    warnings.push('A9_ROUND_OPENER_ADDRESS unset (will default to A9_KEEPER_ADDRESS)');
  }

  if (params.network === 'mainnet' && !String(env.TONCENTER_MAINNET_API_KEY || env.TONCENTER_API_KEY || '').trim()) {
    missing.push('TONCENTER_MAINNET_API_KEY (or TONCENTER_API_KEY) required for mainnet Acton deployment');
  }

  for (const key of ['A9_DEPLOY_WALLET', 'A9_TREASURY_WALLET']) {
    const name = String(env[key] || '').trim();
    if (!name) {
      missing.push(key);
      continue;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      invalid.push(`${key}="${name}" (invalid Acton wallet name)`);
    }
  }

  // Let Acton itself decide whether A9_DEPLOY_WALLET and A9_TREASURY_WALLET are resolvable
  // via the exact read-only deploy script path (OPS_EXECUTE=false, zero on-chain tx).
  let derivedAddresses = null;
  if (missing.length === 0 && invalid.length === 0) {
    const actonCheck = verifyActonWalletsReadOnly({ protocol, params, protocolRoot, env, spawnImpl });
    if (!actonCheck.ok) {
      invalid.push(actonCheck.error);
    } else {
      derivedAddresses = parseActonDerivedAddresses(actonCheck.stdout);
    }
  }

  const gateErrors = [];
  if (execute) {
    if (env.OPS_EXECUTE !== '1' || env.OPS_CONFIRM !== 'YES') {
      gateErrors.push('OPS_EXECUTE=1 and OPS_CONFIRM=YES required for --execute');
    }
    if (params.network === 'mainnet' && env.OPS_CONFIRM_MAINNET !== 'YES') {
      gateErrors.push('OPS_CONFIRM_MAINNET=YES required for mainnet --execute');
    }
  }

  const fatal = [...gateErrors, ...((execute || strict) ? [...missing, ...invalid] : [])];
  if (fatal.length) {
    throw new Error(`Deploy preflight failed (${protocol}/${resolvedProfile}): ${fatal.join('; ')}`);
  }

  return {
    protocol,
    profile: resolvedProfile,
    params,
    protocolRoot,
    artifacts,
    derivedAddresses,
    missing,
    invalid,
    warnings,
    readyForExecute: missing.length === 0 && invalid.length === 0 && gateErrors.length === 0,
  };
}
