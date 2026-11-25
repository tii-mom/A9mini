#!/usr/bin/env node
// A9 Protocol v15 — Minimalist 4-contract deployment CLI (default dry-run).
import { spawnSync } from 'node:child_process';
import { validateDeployPreflight, withActonNetworkKeyEnv } from './lib/v15-core.mjs';

function parseArgs(argv) {
  const out = {
    profile: process.env.A9_PROFILE || process.env.A9_NETWORK || 'testnet',
    execute: false,
    strict: false,
    skipMetadataProbe: false,
    protocol: process.env.A9_PROTOCOL_VERSION || 'v17',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile' || argv[i] === '--network') out.profile = argv[++i];
    else if (argv[i] === '--protocol') out.protocol = argv[++i];
    else if (argv[i] === '--execute') out.execute = true;
    else if (argv[i] === '--strict') out.strict = true;
    else if (argv[i] === '--skip-metadata-probe') out.skipMetadataProbe = true;
    else if (argv[i] === '--dry-run') out.execute = false;
  }
  return out;
}

async function probeMainnetMetadataUri(uri) {
  const res = await fetch(uri, { method: 'GET', signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`A9_METADATA_URI returned HTTP ${res.status} (${uri})`);
  }
  let meta;
  try {
    meta = await res.json();
  } catch {
    throw new Error(`A9_METADATA_URI did not return valid JSON (${uri})`);
  }
  if (!meta || typeof meta !== 'object') throw new Error('metadata JSON is not an object');
  if (String(meta.symbol || '').trim() !== 'A9') throw new Error(`metadata.symbol must be "A9", got "${meta.symbol}"`);
  if (String(meta.decimals ?? '').trim() !== '9') throw new Error(`metadata.decimals must be "9", got "${meta.decimals}"`);
  if (!String(meta.name || '').trim()) throw new Error('metadata.name is empty');
  const imgUrl = String(meta.image || '').trim();
  if (!/^https:\/\//i.test(imgUrl)) throw new Error(`metadata.image must be https:// URL, got "${imgUrl}"`);
  const imgRes = await fetch(imgUrl, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
  if (!imgRes.ok) {
    const getRes = await fetch(imgUrl, { method: 'GET', signal: AbortSignal.timeout(10000) });
    if (!getRes.ok) throw new Error(`metadata.image unreachable (HTTP ${getRes.status}): ${imgUrl}`);
  }
  return meta;
}

const args = parseArgs(process.argv.slice(2));
const preflight = validateDeployPreflight({
  protocol: args.protocol,
  profile: args.profile,
  env: process.env,
  execute: args.execute,
  strict: args.strict,
});
const { profile, params: p, protocolRoot, artifacts } = preflight;

const metadataUri = String(process.env.A9_METADATA_URI || '').trim();
if (p.network === 'mainnet' && !args.skipMetadataProbe && (args.strict || args.execute) && /^https:\/\//i.test(metadataUri)) {
  try {
    const probed = await probeMainnetMetadataUri(metadataUri);
    console.log(`[${args.protocol}-deploy] Metadata probe OK: ${probed.name} (${probed.symbol}, decimals=${probed.decimals})`);
  } catch (e) {
    console.error(`[${args.protocol}-deploy] Metadata probe FAILED: ${e?.message || e}`);
    process.exit(1);
  }
}

console.log(`[${args.protocol}-deploy] Verified ${artifacts.length} compiled artifacts against ci/artifacts.sha256`);
console.log(`[${args.protocol}-deploy] Profile loaded: ${profile} (network=${p.network})`);

if (!args.execute) {
  console.log(`[${args.protocol}-deploy] DRY-RUN mode: no on-chain transaction will be broadcast.`);
  console.log(`[${args.protocol}-deploy] Summary:`, JSON.stringify({
    protocol: args.protocol,
    network: p.network,
    totalSupplyA9: (BigInt(p.supply.totalSupplyRaw) / 1_000_000_000n).toString(),
    rcFundingA9: (BigInt(p.supply.rcFundingRaw) / 1_000_000_000n).toString(),
    timing: p.timing,
    promoUserFeeTon: p.promoHotWallet.userFeeTon,
    artifacts: artifacts.map((a) => ({ path: a.relPath, sha256: a.sha256 })),
    derivedAddresses: preflight.derivedAddresses || null,
    missingRequiredForExecute: preflight.missing,
    invalidConfigForExecute: preflight.invalid,
    warnings: preflight.warnings,
    readyForExecute: preflight.readyForExecute,
  }, null, 2));
  process.exit(preflight.invalid.length > 0 ? 1 : 0);
}

const env = {
  ...withActonNetworkKeyEnv(p.network, process.env),
  A9_NETWORK: p.network,
  A9_PROTOCOL_VERSION: args.protocol,
  A9_METADATA_URI: process.env.A9_METADATA_URI || '',
  A9_TOTAL_SUPPLY_RAW: p.supply.totalSupplyRaw,
  A9_REWARD_POOL_RAW: p.supply.rewardPoolRaw,
  A9_TEAM_POOL_RAW: p.supply.teamPoolRaw,
  A9_RC_FUNDING_RAW: p.supply.rcFundingRaw,
  A9_P0_USD_E8: p.econ.p0UsdE8,
  A9_ROUND_REWARD_RAW: p.econ.roundRewardRaw,
  A9_TEAM_ROUND_RAW: p.econ.teamRoundRaw,
  A9_MIN_STAKE_RAW: p.econ.minStakeRaw,
  A9_STAKE_SECONDS: String(p.timing.stakeDurationSeconds),
  A9_EARLY_WINDOW_SECONDS: String(p.timing.earlyWindowSeconds || 21600),
  A9_OBS_SECONDS: String(p.timing.observationSeconds),
  A9_CANDLE_COUNT: String(p.timing.candleCount),
  A9_MIN_QUALIFIED: String(p.timing.minQualifiedCandles),
  A9_ABORT_TIMEOUT_SECONDS: String(p.timing.abortTimeoutSeconds),
  A9_VESTING_SECONDS: String(p.timing.vestingSeconds),
  A9_TON_MASTER: p.deployTon.jettonMaster,
  A9_TON_MINT_TOTAL: p.deployTon.mintTotal,
  A9_TON_MINT_FORWARD: p.deployTon.mintForward,
  A9_TON_RC: p.deployTon.roundController,
  A9_TON_FUNDING: p.deployTon.fundingTransfer,
  OPS_EXECUTE: 'true',
};

const deployScript = args.protocol === 'v16' ? '../ops/tolk/deploy_v16.tolk' : '../ops/tolk/deploy_v17.tolk';
const res = spawnSync('acton', ['script', '--net', p.network, deployScript], {
  cwd: protocolRoot,
  env,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
