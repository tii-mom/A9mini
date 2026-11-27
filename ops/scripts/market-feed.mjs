#!/usr/bin/env node
// A9 协议 v17 — 行情采集与结算输入包标准化 CLI（严格只读，默认不广播）。
// 子命令：
//   build-settle  从归档样本 JSON 构建 12 根 1H 定点 TWAP 结算输入包
//   verify-settle 确定性重放验真已有结算输入包
//   build-open    构建开轮 24H 基准 TWAP 与走廊核验计划
import { readFileSync, writeFileSync } from 'node:fs';
import {
  buildSettlementInputBundle,
  verifySettlementInputBundle,
  buildOpenRoundTwapPlan,
  assertRealCaptureEvidence,
} from './lib/market-oracle.mjs';
import { collectMarketOnce } from './lib/market-collector.mjs';
import { loadParams } from './lib/v15-core.mjs';

function parseArgs(argv) {
  const out = {
    action: '',
    profile: process.env.A9_PROFILE || process.env.A9_NETWORK || 'mainnet',
    input: '',
    output: '',
    round: null,
    target: '',
    stakeCloseAt: null,
    observedUntil: null,
    referenceTime: null,
    windowSeconds: 86400,
    pool: '',
    jettonMaster: '',
    quoteAsset: 'GRAM',
    provider: 'stonfi-archive',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--start') out.start = Number(argv[++i]);
    else if (a === '--action') out.action = argv[++i];
    else if (a === '--profile' || a === '--network') out.profile = argv[++i];
    else if (a === '--input') out.input = argv[++i];
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--round') out.round = Number(argv[++i]);
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--stake-close-at') out.stakeCloseAt = Number(argv[++i]);
    else if (a === '--observed-until') out.observedUntil = Number(argv[++i]);
    else if (a === '--reference-time') out.referenceTime = Number(argv[++i]);
    else if (a === '--window-seconds') out.windowSeconds = Number(argv[++i]);
    else if (a === '--pool') out.pool = argv[++i];
    else if (a === '--jetton-master') out.jettonMaster = argv[++i];
    else if (a === '--quote-asset') out.quoteAsset = argv[++i];
    else if (a === '--provider') out.provider = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.action || !args.input) {
  console.error(
    'Usage: node ops/scripts/market-feed.mjs --action <collect|build-settle|verify-settle|build-open> --input <json> [--output <json>] ...',
  );
  process.exit(1);
}

const { data: params } = loadParams(args.profile);
const raw = JSON.parse(readFileSync(args.input, 'utf8'));
if (args.action === 'collect') {
  if (!args.output) throw new Error('--output archive path required');
  if (params.network !== 'mainnet') throw new Error('public provider is mainnet-only; this is read-only HTTP, not mainnet deployment');
  const result = await collectMarketOnce({archivePath:args.output, binding:raw.binding || raw, start:args.start});
  console.log(JSON.stringify(result,null,2));
  process.exit(0);
}


if (args.action === 'verify-settle') {
  if (raw.observationSeconds !== params.timing.observationSeconds || raw.candleCount !== params.timing.candleCount) throw new Error('SETTLEMENT_PROFILE_TIMING_MISMATCH');
  const expectedBinding = args.pool && args.jettonMaster
    ? {
        network: params.network,
        provider: args.provider,
        poolAddress: args.pool,
        a9JettonMaster: args.jettonMaster,
        quoteAsset: args.quoteAsset,
      }
    : null;
  const res = verifySettlementInputBundle(raw, expectedBinding);
  if (params.network === 'mainnet') assertRealCaptureEvidence(raw.coverageSegments, res.binding);
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}

const binding = raw.binding || {
  network: params.network,
  provider: args.provider,
  poolAddress: args.pool,
  a9JettonMaster: args.jettonMaster,
  quoteAsset: args.quoteAsset,
};

if (params.network === 'mainnet') assertRealCaptureEvidence(raw.coverageSegments, binding);
let result;
if (args.action === 'build-settle') {
  result = buildSettlementInputBundle({
    roundId: args.round ?? raw.roundId,
    targetPriceUsdE8: args.target || raw.targetPriceUsdE8,
    stakeCloseAt: args.stakeCloseAt ?? raw.stakeCloseAt,
    observationSeconds: params.timing.observationSeconds,
    candleCount: params.timing.candleCount,
    samples: raw.samples,
    coverageSegments: raw.coverageSegments,
    observedUntil: args.observedUntil ?? raw.observedUntil,
    binding,
    rawEvidence: raw.rawEvidence ?? raw.samples,
  });
} else if (args.action === 'build-open') {
  result = buildOpenRoundTwapPlan({
    roundId: args.round ?? raw.roundId,
    referenceTime: args.referenceTime ?? raw.referenceTime,
    windowSeconds: args.windowSeconds,
    samples: raw.samples,
    coverageSegments: raw.coverageSegments,
    observedUntil: args.observedUntil ?? raw.observedUntil,
    targetPriceUsdE8: args.target || raw.targetPriceUsdE8,
    p0UsdE8: params.econ.p0UsdE8,
    binding,
    rawEvidence: raw.rawEvidence ?? raw.samples,
  });
} else {
  throw new Error(`unknown action: ${args.action}`);
}

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (args.output) {
  writeFileSync(args.output, serialized, 'utf8');
  console.log(`[market-feed] Wrote ${args.action} output to ${args.output} (sha256=${result.outputSha256}, broadcasted=false)`);
} else {
  process.stdout.write(serialized);
}
