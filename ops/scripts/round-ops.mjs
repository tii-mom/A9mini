#!/usr/bin/env node
// A9 Protocol v15 — Minimalist round operations CLI (default dry-run).
// Actions: open-round | settle-round | abort-round | burn-inactive
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  loadParams,
  assertTargetInCorridor,
  aggregateCandles,
  resolveProtocolRoot,
  parseTonAddressForOps,
  withActonNetworkKeyEnv,
} from './lib/v15-core.mjs';

function parseArgs(argv) {
  const out = {
    execute: false,
    offline: false,
    strict: false,
    protocol: process.env.A9_PROTOCOL_VERSION || 'v16',
    profile: process.env.A9_PROFILE || process.env.A9_NETWORK || 'testnet',
    queryId: String(Date.now()),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--action') out.action = argv[++i];
    else if (a === '--profile' || a === '--network') out.profile = argv[++i];
    else if (a === '--protocol') out.protocol = argv[++i];
    else if (a === '--round') out.round = Number(argv[++i]);
    else if (a === '--twap') out.twap = argv[++i];
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--candles-file') out.candlesFile = argv[++i];
    else if (a === '--stake-close-at') out.stakeCloseAt = Number(argv[++i]);
    else if (a === '--qualified') out.qualified = Number(argv[++i]);
    else if (a === '--candle-hash') out.candleHash = argv[++i];
    else if (a === '--signer') out.signer = argv[++i];
    else if (a === '--query-id') out.queryId = argv[++i];
    else if (a === '--execute') out.execute = true;
    else if (a === '--offline') out.offline = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--dry-run') out.execute = false;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.action) {
  console.error('Usage: node scripts/round-ops.mjs --action <open-round|settle-round|abort-round|burn-inactive> [options]');
  process.exit(1);
}

const protocolRoot = resolveProtocolRoot(args.protocol);
const maxRoundId = 0xffffffff;
if (args.round !== undefined && (!Number.isInteger(args.round) || args.round < 1 || args.round > maxRoundId)) {
  throw new Error(`--round must be 1..${maxRoundId} for ${args.protocol}`);
}
const { data: p } = loadParams(args.profile);
const env = {
  ...withActonNetworkKeyEnv(p.network, process.env),
  A9_NETWORK: p.network,
  A9_OP_ACTION: args.action,
  A9_QUERY_ID: args.queryId,
};

if (args.action === 'open-round') {
  if (!args.round) {
    throw new Error('--round <id> is required for open-round (refusing to default to round 1)');
  }
  const roundId = Number(args.round);
  const twap = args.twap ?? '0';
  const target = args.target;
  if (!target) throw new Error('--target <usd_e8> is required');
  const check = assertTargetInCorridor(roundId, twap, target, p.econ.p0UsdE8);
  console.log(`[round-ops] OpenRound #${roundId} corridor OK: base=${check.base}, target=${check.target} in [${check.minTarget}, ${check.maxTarget}]`);
  env.A9_EXPECTED_ROUND_ID = String(roundId);
  env.A9_TWAP_24H_USD_E8 = String(twap);
  env.A9_TARGET_PRICE_USD_E8 = String(target);
  env.A9_SIGNER_WALLET = args.signer || process.env.A9_OPENER_WALLET || 'opener';
} else if (args.action === 'settle-round') {
  if (!args.round) throw new Error('--round <id> is required');
  let qualified = args.qualified;
  let candleHashDec = null;
  if (args.candlesFile) {
    if (!args.target) throw new Error('--target <usd_e8> is required with --candles-file');
    if (p.network === 'mainnet' && (!Number.isInteger(args.stakeCloseAt) || args.stakeCloseAt <= 0)) {
      throw new Error('mainnet settle-round requires --stake-close-at <unix_sec> to verify 24h observation window alignment');
    }
    const candles = JSON.parse(readFileSync(args.candlesFile, 'utf8'));
    const canEnforceObs = p.timing.observationSeconds % p.timing.candleCount === 0;
    const agg = aggregateCandles(args.round, args.target, candles, p.timing.candleCount, {
      ...(canEnforceObs ? { observationSeconds: p.timing.observationSeconds } : {}),
      ...(args.stakeCloseAt !== undefined ? { stakeCloseAt: args.stakeCloseAt } : {}),
    });
    qualified = agg.qualifiedCandles;
    candleHashDec = agg.candleHashDec;
    console.log(`[round-ops] Aggregated ${p.timing.candleCount} candles: qualified=${qualified}/${p.timing.candleCount}, window=[${agg.windowStart}..${agg.windowEnd}], hash=${agg.candleHashHex}`);
  } else {
    if (p.network === 'mainnet') {
      throw new Error('mainnet settle-round requires --candles-file <json> --target <usd_e8>; manual --qualified/--candle-hash bypass is forbidden on mainnet');
    }
    if (args.candleHash) {
      const h = BigInt(args.candleHash);
      if (h <= 0n || h >= (1n << 256n)) {
        throw new Error('--candle-hash must be a positive uint256');
      }
      candleHashDec = h.toString();
    }
  }
  if (qualified == null || !candleHashDec) {
    throw new Error('provide either --candles-file <json> --target <usd_e8> or --qualified <n> --candle-hash <0x...>');
  }
  if (!Number.isInteger(qualified) || qualified < 0 || qualified > p.timing.candleCount) {
    throw new Error(`--qualified must be an integer in 0..${p.timing.candleCount}, got ${qualified}`);
  }
  env.A9_ROUND_ID = String(args.round);
  env.A9_EXPECTED_ROUND_ID = String(args.round);
  if (args.target) env.A9_EXPECTED_TARGET_USD_E8 = String(args.target);
  if (Number.isInteger(args.stakeCloseAt) && args.stakeCloseAt > 0) {
    env.A9_EXPECTED_STAKE_CLOSE_AT = String(args.stakeCloseAt);
  }
  env.A9_QUALIFIED_CANDLES = String(qualified);
  env.A9_CANDLE_HASH = candleHashDec;
  env.A9_SIGNER_WALLET = args.signer || process.env.A9_KEEPER_WALLET || 'keeper';
} else if (args.action === 'abort-round' || args.action === 'burn-inactive') {
  env.A9_SIGNER_WALLET = args.signer || process.env.A9_KEEPER_WALLET || 'keeper';
} else {
  throw new Error(`unknown action: ${args.action}`);
}

const rcAddr = String(env.A9_ROUND_CONTROLLER_ADDRESS || '').trim();
if (rcAddr) {
  const parsedRc = parseTonAddressForOps(rcAddr);
  if (!parsedRc || parsedRc.workchain !== 0) {
    throw new Error(`Invalid A9_ROUND_CONTROLLER_ADDRESS: ${rcAddr}`);
  }
  if (p.network === 'mainnet' && parsedRc.testOnly === true) {
    throw new Error('A9_ROUND_CONTROLLER_ADDRESS cannot be a testnet address on mainnet');
  }
}

if (!args.execute) {
  if (!args.offline && rcAddr) {
    env.OPS_EXECUTE = 'false';
    const dryRes = spawnSync('acton', ['script', '--net', p.network, '../ops/tolk/round_ops_v16.tolk'], {
      cwd: protocolRoot,
      env,
      stdio: 'inherit',
    });
    if (dryRes.status !== 0) process.exit(dryRes.status ?? 1);
  } else if (args.strict && !rcAddr) {
    console.error('Refusing strict dry-run without A9_ROUND_CONTROLLER_ADDRESS');
    process.exit(1);
  } else {
    console.log('[round-ops] Offline DRY-RUN parameter check complete (set A9_ROUND_CONTROLLER_ADDRESS to run on-chain cross-checks).');
  }
  console.log('[round-ops] DRY-RUN complete. Re-run with --execute OPS_EXECUTE=1 OPS_CONFIRM=YES to broadcast.');
  process.exit(0);
}

if (!rcAddr) {
  console.error('Refusing --execute: A9_ROUND_CONTROLLER_ADDRESS is required');
  process.exit(1);
}
if (process.env.OPS_EXECUTE !== '1' || process.env.OPS_CONFIRM !== 'YES') {
  console.error('Refusing --execute: set OPS_EXECUTE=1 and OPS_CONFIRM=YES');
  process.exit(1);
}
if (p.network === 'mainnet' && process.env.OPS_CONFIRM_MAINNET !== 'YES') {
  console.error('Refusing mainnet --execute: set OPS_CONFIRM_MAINNET=YES');
  process.exit(1);
}

env.OPS_EXECUTE = 'true';
const res = spawnSync('acton', ['script', '--net', p.network, '../ops/tolk/round_ops_v16.tolk'], {
  cwd: protocolRoot,
  env,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
