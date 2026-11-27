#!/usr/bin/env node
// A9 Protocol v15 — Minimalist 4-contract deployment CLI (default dry-run).
import { spawnSync } from 'node:child_process';
import { withActonNetworkKeyEnv } from './lib/v15-core.mjs';
import { readFileSync } from 'node:fs';
import { checkDeploymentReadiness } from './lib/deploy-readiness.mjs';

function parseArgs(argv) {
  const out = {
    profile: process.env.A9_PROFILE || process.env.A9_NETWORK || 'testnet',
    execute: false,
    strict: false,
    deploymentMode: 'local',
    signerManifestPath: null,
    protocol: process.env.A9_PROTOCOL_VERSION || 'v17',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile' || argv[i] === '--network') out.profile = argv[++i];
    else if (argv[i] === '--protocol') out.protocol = argv[++i];
    else if (argv[i] === '--execute') out.execute = true;
    else if (argv[i] === '--strict') out.strict = true;
    else if (argv[i] === '--deployment-mode') out.deploymentMode = argv[++i];
    else if (argv[i] === '--signer-manifest') out.signerManifestPath = argv[++i];
    else if (argv[i] === '--skip-metadata-probe') throw new Error('Metadata probe cannot be bypassed');
    else if (argv[i] === '--dry-run') out.execute = false;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
let signerManifest = null;
try {
  if (args.signerManifestPath) signerManifest = JSON.parse(readFileSync(args.signerManifestPath, 'utf8'));
} catch {
  console.log(JSON.stringify({ readyForExecute: false, errors: ['SIGNER_MANIFEST_UNREADABLE'] }));
  process.exit(1);
}
const preflight = await checkDeploymentReadiness({
  protocol: args.protocol, profile: args.profile, env: process.env, execute: args.execute,
  deploymentMode: args.deploymentMode, signerManifest,
});
console.log(`[${args.protocol}-deploy] ${args.execute ? 'Execution preflight' : 'DRY-RUN: no on-chain transaction will be broadcast.'}`);
console.log(JSON.stringify({
  protocol: args.protocol, network: preflight.params?.network,
  deploymentMode: preflight.deploymentMode,
  derivedAddresses: preflight.derivedAddresses || null,
  checks: preflight.checks, errors: preflight.errors,
  readyForExecute: preflight.readyForExecute,
  readyForExternalDeployment: preflight.readyForExternalDeployment,
  readyForPayouts: preflight.readyForPayouts,
}, null, 2));
if (!args.execute) process.exit(preflight.readyForExecute || preflight.readyForExternalDeployment ? 0 : 1);
if (!preflight.readyForExecute) process.exit(1);
const { params: p, protocolRoot } = preflight;

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
