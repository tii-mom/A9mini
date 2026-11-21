#!/usr/bin/env node
// A9 Protocol v15 — Minimalist 4-contract deployment CLI (default dry-run).
import { spawnSync } from 'node:child_process';
import { loadParams, verifyV15Artifacts, V15_ROOT } from './lib/v15-core.mjs';

function parseArgs(argv) {
  const out = { profile: process.env.A9_PROFILE || process.env.A9_NETWORK || 'testnet', execute: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile' || argv[i] === '--network') out.profile = argv[++i];
    else if (argv[i] === '--execute') out.execute = true;
    else if (argv[i] === '--dry-run') out.execute = false;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const { profile, data: p } = loadParams(args.profile);
const artifacts = verifyV15Artifacts(V15_ROOT);

console.log(`[v15-deploy] Verified ${artifacts.length} compiled artifacts against ci/artifacts.sha256`);
console.log(`[v15-deploy] Profile loaded: ${profile} (network=${p.network})`);

if (args.execute) {
  if (process.env.OPS_EXECUTE !== '1' || process.env.OPS_CONFIRM !== 'YES') {
    console.error('Refusing --execute: set OPS_EXECUTE=1 and OPS_CONFIRM=YES');
    process.exit(1);
  }
  if (p.network === 'mainnet' && process.env.OPS_CONFIRM_MAINNET !== 'YES') {
    console.error('Refusing mainnet --execute: set OPS_CONFIRM_MAINNET=YES');
    process.exit(1);
  }
} else {
  console.log('[v15-deploy] DRY-RUN mode: no on-chain transaction will be broadcast.');
  console.log('[v15-deploy] Summary:', JSON.stringify({
    network: p.network,
    totalSupplyA9: (BigInt(p.supply.totalSupplyRaw) / 1_000_000_000n).toString(),
    rcFundingA9: (BigInt(p.supply.rcFundingRaw) / 1_000_000_000n).toString(),
    timing: p.timing,
    promoUserFeeTon: p.promoHotWallet.userFeeTon,
  }, null, 2));
  process.exit(0);
}

const env = {
  ...process.env,
  A9_NETWORK: p.network,
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
  A9_OBS_SECONDS: String(p.timing.observationSeconds),
  A9_CANDLE_COUNT: String(p.timing.candleCount),
  A9_MIN_QUALIFIED: String(p.timing.minQualifiedCandles),
  A9_ABORT_TIMEOUT_SECONDS: String(p.timing.abortTimeoutSeconds),
  A9_FALLBACK_UNLOCK_SECONDS: String(p.timing.fallbackUnlockSeconds),
  A9_INACTIVITY_BURN_SECONDS: String(p.timing.inactivityBurnSeconds),
  A9_TON_MASTER: p.deployTon.jettonMaster,
  A9_TON_MINT_TOTAL: p.deployTon.mintTotal,
  A9_TON_MINT_FORWARD: p.deployTon.mintForward,
  A9_TON_RC: p.deployTon.roundController,
  A9_TON_FUNDING: p.deployTon.fundingTransfer,
  OPS_EXECUTE: 'true',
};

const res = spawnSync('acton', ['script', '--net', p.network, '../ops/tolk/deploy_v15.tolk'], {
  cwd: V15_ROOT,
  env,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
