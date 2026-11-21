#!/usr/bin/env node
// A9 Protocol v15 — Minimalist round operations CLI (default dry-run).
// Actions: open-round | settle-round | abort-round | burn-inactive
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  loadParams,
  assertTargetInCorridor,
  aggregateCandles,
  V15_ROOT,
} from './lib/v15-core.mjs';

function parseArgs(argv) {
  const out = { execute: false, profile: process.env.A9_PROFILE || process.env.A9_NETWORK || 'testnet', queryId: String(Date.now()) };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--action') out.action = argv[++i];
    else if (a === '--profile' || a === '--network') out.profile = argv[++i];
    else if (a === '--round') out.round = Number(argv[++i]);
    else if (a === '--twap') out.twap = argv[++i];
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--candles-file') out.candlesFile = argv[++i];
    else if (a === '--qualified') out.qualified = Number(argv[++i]);
    else if (a === '--candle-hash') out.candleHash = argv[++i];
    else if (a === '--signer') out.signer = argv[++i];
    else if (a === '--query-id') out.queryId = argv[++i];
    else if (a === '--execute') out.execute = true;
    else if (a === '--dry-run') out.execute = false;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.action) {
  console.error('Usage: node scripts/round-ops.mjs --action <open-round|settle-round|abort-round|burn-inactive> [options]');
  process.exit(1);
}

const { data: p } = loadParams(args.profile);
const env = { ...process.env, A9_OP_ACTION: args.action, A9_QUERY_ID: args.queryId };

if (args.action === 'open-round') {
  const roundId = Number(args.round || 1);
  const twap = args.twap ?? '0';
  const target = args.target;
  if (!target) throw new Error('--target <usd_e8> is required');
  const check = assertTargetInCorridor(roundId, twap, target, p.econ.p0UsdE8);
  console.log(`[round-ops] OpenRound #${roundId} corridor OK: base=${check.base}, target=${check.target} in [${check.minTarget}, ${check.maxTarget}]`);
  env.A9_TWAP_24H_USD_E8 = String(twap);
  env.A9_TARGET_PRICE_USD_E8 = String(target);
  env.A9_SIGNER_WALLET = args.signer || process.env.A9_OPENER_WALLET || 'opener';
} else if (args.action === 'settle-round') {
  if (!args.round) throw new Error('--round <id> is required');
  let qualified = args.qualified;
  let candleHashDec = args.candleHash ? BigInt(args.candleHash).toString() : null;
  if (args.candlesFile) {
    if (!args.target) throw new Error('--target <usd_e8> is required with --candles-file');
    const candles = JSON.parse(readFileSync(args.candlesFile, 'utf8'));
    const agg = aggregateCandles(args.round, args.target, candles, p.timing.candleCount);
    qualified = agg.qualifiedCandles;
    candleHashDec = agg.candleHashDec;
    console.log(`[round-ops] Aggregated ${p.timing.candleCount} candles: qualified=${qualified}/${p.timing.candleCount}, hash=${agg.candleHashHex}`);
  }
  if (qualified == null || !candleHashDec) {
    throw new Error('provide either --candles-file <json> --target <usd_e8> or --qualified <n> --candle-hash <0x...>');
  }
  env.A9_ROUND_ID = String(args.round);
  env.A9_QUALIFIED_CANDLES = String(qualified);
  env.A9_CANDLE_HASH = candleHashDec;
  env.A9_SIGNER_WALLET = args.signer || process.env.A9_KEEPER_WALLET || 'keeper';
} else if (args.action === 'abort-round' || args.action === 'burn-inactive') {
  env.A9_SIGNER_WALLET = args.signer || process.env.A9_KEEPER_WALLET || 'keeper';
} else {
  throw new Error(`unknown action: ${args.action}`);
}

if (!args.execute) {
  console.log('[round-ops] DRY-RUN complete. Re-run with --execute OPS_EXECUTE=1 OPS_CONFIRM=YES to broadcast.');
  process.exit(0);
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
const res = spawnSync('acton', ['script', '--net', p.network, '../ops/tolk/round_ops_v15.tolk'], {
  cwd: V15_ROOT,
  env,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
