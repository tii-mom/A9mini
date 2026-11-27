// A9 协议 v17 — 真实行情采集、池绑定核验与定点 TWAP 标准化适配层（零外部依赖，Node 20+ ESM）。
// 严格口径：
// - 价格单位统一为 USD * 1e8 的 BigInt 定点整数（usd_e8），严禁经过 IEEE-754 浮点计算。
// - TWAP 严格按阶梯函数时间加权积分 floor(sum(price_k * dt_k) / windowDuration) 计算，
//   严禁以现价、OHLC 四价均值或样本算术均值冒充 TWAP。
// - 缺失锚定样本、数据源覆盖未达窗口终点、时间重叠冲突、网络/池/资产不匹配时一律 fail-closed 拒绝。
// - 本模块仅负责采集、标准化、证据固化与可重放验真，绝不自动签名或广播任何链上交易。
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  aggregateCandles,
  assertTargetInCorridor,
  parseTonAddressForOps,
} from './v15-core.mjs';

export const ORACLE_BUNDLE_VERSION = 'a9-v17-market-settlement-input-v1';
export const ORACLE_OPEN_PLAN_VERSION = 'a9-v17-market-open-plan-v1';
export const USD_E8_SCALE = 100_000_000n;
export const DEFAULT_MAX_ANCHOR_AGE_SECONDS = 86400; // 起点前锚定样本最大允许陈旧时长（默认 24H）
export const DEFAULT_MAX_COVERAGE_SEGMENT_SECONDS = 3600; // 单次连续采集覆盖片段最大允许跨度（默认 1H）

/**
 * 确定性 JSON 序列化（递归按 key 排序），确保跨进程/重启重放哈希完全一致。
 */
export function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(value[k])}`).join(',')}}`;
}

export function sha256Hex(data) {
  const input = typeof data === 'string' || Buffer.isBuffer(data) ? data : canonicalJsonStringify(data);
  return `0x${createHash('sha256').update(input).digest('hex')}`;
}

/**
 * 纯字符串十进制价格转 USD * 1e8 定点 BigInt（向下取整，拒绝浮点、科学计数法、负数或 0）。
 * 例："0.00116" -> 116000n；"1.234567899" -> 123456789n。
 */
export function parseDecimalToUsdE8(rawValue, label = 'priceUsd') {
  if (typeof rawValue === 'bigint') {
    if (rawValue <= 0n) throw new Error(`${label} must be > 0`);
    return rawValue;
  }
  if (typeof rawValue !== 'string') {
    throw new Error(`${label} must be a decimal string to avoid floating-point drift, got ${typeof rawValue}`);
  }
  const trimmed = rawValue.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new Error(`${label} must be a positive plain decimal string (no scientific notation/sign), got "${rawValue}"`);
  }
  const [intPart, fracPart = ''] = trimmed.split('.');
  const frac8 = (fracPart + '00000000').slice(0, 8);
  const scaled = BigInt(intPart) * USD_E8_SCALE + BigInt(frac8);
  if (scaled <= 0n) {
    throw new Error(`${label} underflowed to 0 at usd_e8 precision: "${rawValue}"`);
  }
  return scaled;
}

/**
 * 严格解析 unix 秒级整数时间戳或 ISO-8601 UTC 字符串为整数秒。
 */
export function parseUnixSeconds(rawValue, label = 'timestamp') {
  if (typeof rawValue === 'number') {
    if (!Number.isInteger(rawValue) || rawValue <= 0) {
      throw new Error(`${label} must be a positive integer unix timestamp, got ${rawValue}`);
    }
    return rawValue;
  }
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isSafeInteger(n) || n <= 0) {
        throw new Error(`${label} invalid integer unix timestamp: ${rawValue}`);
      }
      return n;
    }
    // 仅接受带时区（Z 或 +/-HH:MM）的 ISO-8601 时间，杜绝本机时区漂移
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
      throw new Error(`${label} must be unix seconds or timezone-explicit ISO-8601, got "${rawValue}"`);
    }
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`${label} unparseable ISO timestamp: "${rawValue}"`);
    }
    return Math.floor(ms / 1000);
  }
  throw new Error(`${label} unsupported timestamp type: ${typeof rawValue}`);
}

/**
 * 归一化 TON 地址以便比对（同时校验 workchain 与网络一致性）。
 */
export function assertNetworkAddress(address, network, label = 'address') {
  const clean = String(address || '').trim();
  const parsed = parseTonAddressForOps(clean);
  if (!parsed || parsed.workchain !== 0) {
    throw new Error(`${label} is not a valid TON basechain address: "${address}"`);
  }
  if (network === 'mainnet' && parsed.testOnly === true) {
    throw new Error(`${label} cannot be a testnet-only address on mainnet: "${address}"`);
  }
  return clean;
}

/**
 * 核验并标准化池绑定信息（网络、数据提供方、池地址、A9 JettonMaster、报价资产）。
 */
export function validatePoolBinding(binding) {
  if (!binding || typeof binding !== 'object') {
    throw new Error('pool binding is required');
  }
  const network = String(binding.network || '').trim().toLowerCase();
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error(`binding.network must be mainnet or testnet, got "${binding.network}"`);
  }
  const provider = String(binding.provider || '').trim();
  if (!provider) {
    throw new Error('binding.provider is required (e.g. "geckoterminal-trades" or "stonfi-archive")');
  }
  const poolAddress = assertNetworkAddress(binding.poolAddress, network, 'binding.poolAddress');
  const a9JettonMaster = assertNetworkAddress(binding.a9JettonMaster, network, 'binding.a9JettonMaster');
  const quoteAsset = String(binding.quoteAsset || '').trim().toUpperCase();
  if (!quoteAsset || !/^[A-Z0-9._-]{2,16}$/.test(quoteAsset)) {
    throw new Error(`binding.quoteAsset is invalid: "${binding.quoteAsset}"`);
  }
  const quoteAssetAddress = binding.quoteAssetAddress
    ? assertNetworkAddress(binding.quoteAssetAddress, network, 'binding.quoteAssetAddress')
    : null;
  const dex = String(binding.dex || 'stonfi').trim().toLowerCase();
  if (!dex) {
    throw new Error('binding.dex is required');
  }
  return {
    network,
    provider,
    dex,
    poolAddress,
    a9JettonMaster,
    quoteAsset,
    quoteAssetAddress,
    priceUnit: 'usd_e8',
    priceScale: USD_E8_SCALE.toString(),
  };
}

/**
 * 校验 STON.fi /v1/pools/{pool} 回包与预期池绑定完全一致。
 * 参考真实回包结构：{ pool: { address, token0_address, token1_address, deprecated, reserve0, reserve1 } }
 */
export function verifyStonfiPoolMetadata(payload, expectedBinding) {
  const binding = validatePoolBinding(expectedBinding);
  const pool = payload?.pool && typeof payload.pool === 'object' ? payload.pool : payload;
  if (!pool || typeof pool !== 'object') {
    throw new Error('STON.fi pool payload is missing pool object');
  }
  const poolAddr = String(pool.address || '').trim();
  if (!poolAddr || poolAddr !== binding.poolAddress) {
    throw new Error(`STON.fi pool address mismatch: expected ${binding.poolAddress}, got ${poolAddr || '<empty>'}`);
  }
  if (pool.deprecated === true) {
    throw new Error(`STON.fi pool ${poolAddr} is marked deprecated`);
  }
  const t0 = String(pool.token0_address || '').trim();
  const t1 = String(pool.token1_address || '').trim();
  if (!t0 || !t1) {
    throw new Error('STON.fi pool payload missing token0_address/token1_address');
  }
  const tokens = new Set([t0, t1]);
  if (!tokens.has(binding.a9JettonMaster)) {
    throw new Error(`STON.fi pool ${poolAddr} does not contain A9 JettonMaster ${binding.a9JettonMaster}`);
  }
  if (binding.quoteAssetAddress && !tokens.has(binding.quoteAssetAddress)) {
    throw new Error(`STON.fi pool ${poolAddr} does not contain quoteAssetAddress ${binding.quoteAssetAddress}`);
  }
  return {
    ok: true,
    poolAddress: poolAddr,
    token0Address: t0,
    token1Address: t1,
    reserve0: pool.reserve0 !== undefined ? String(pool.reserve0) : null,
    reserve1: pool.reserve1 !== undefined ? String(pool.reserve1) : null,
  };
}

/**
 * 标准化 GeckoTerminal Public API v2 逐笔成交回包：
 * GET /api/v2/networks/ton/pools/{pool_address}/trades
 * 严格要求成交中包含 binding.a9JettonMaster，仅取对应的精确十进制 USD 价格字符串。
 */
export function normalizeGeckoTerminalTrades(payload, expectedBinding) {
  const binding = validatePoolBinding(expectedBinding);
  if (binding.network !== 'mainnet') {
    throw new Error('GeckoTerminal TON public API only serves TON mainnet pools');
  }
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error('GeckoTerminal trades payload must contain data array');
  }
  const samples = [];
  for (let i = 0; i < payload.data.length; i += 1) {
    const item = payload.data[i];
    const attrs = item?.attributes;
    if (!attrs || typeof attrs !== 'object') {
      throw new Error(`GeckoTerminal trade[${i}] missing attributes`);
    }
    const ts = parseUnixSeconds(attrs.block_timestamp, `trade[${i}].block_timestamp`);
    const fromAddr = String(attrs.from_token_address || '').trim();
    const toAddr = String(attrs.to_token_address || '').trim();
    let priceStr = null;
    if (fromAddr === binding.a9JettonMaster) {
      priceStr = attrs.price_from_in_usd;
    } else if (toAddr === binding.a9JettonMaster) {
      priceStr = attrs.price_to_in_usd;
    } else {
      throw new Error(
        `GeckoTerminal trade[${i}] does not match A9 JettonMaster ${binding.a9JettonMaster} (from=${fromAddr}, to=${toAddr})`,
      );
    }
    const priceUsdE8 = parseDecimalToUsdE8(String(priceStr ?? ''), `trade[${i}].priceUsd`);
    const txHash = String(attrs.tx_hash || item?.id || '').trim() || null;
    samples.push({
      ts,
      priceUsdE8: priceUsdE8.toString(),
      txHash,
      sourceIndex: i,
    });
  }
  return samples;
}

/**
 * 校验并规范化观察样本序列（排序、去重、检测同一时刻价格冲突与同一 txHash 冲突）。
 */
export function normalizePriceSamples(rawSamples) {
  if (!Array.isArray(rawSamples) || rawSamples.length === 0) {
    throw new Error('at least one price observation sample is required');
  }
  const seenTx = new Map();
  const parsed = rawSamples.map((s, idx) => {
    if (!s || typeof s !== 'object') {
      throw new Error(`sample[${idx}] must be an object`);
    }
    const ts = parseUnixSeconds(s.ts ?? s.timestamp, `sample[${idx}].ts`);
    const priceUsdE8 = s.priceUsdE8 !== undefined && s.priceUsdE8 !== null
      ? (() => {
          const p = BigInt(s.priceUsdE8);
          if (p <= 0n) throw new Error(`sample[${idx}].priceUsdE8 must be > 0`);
          return p;
        })()
      : parseDecimalToUsdE8(s.priceUsd, `sample[${idx}].priceUsd`);
    const txHash = s.txHash ? String(s.txHash).trim() : null;
    if (txHash) {
      const prev = seenTx.get(txHash);
      if (prev) {
        if (prev.ts !== ts || prev.priceUsdE8 !== priceUsdE8) {
          throw new Error(`conflicting duplicate txHash ${txHash} in price samples`);
        }
      } else {
        seenTx.set(txHash, { ts, priceUsdE8 });
      }
    }
    return { ts, priceUsdE8, txHash };
  });

  // 按时间单调排序；相同时间戳若价格不同立即拒绝（防止重叠/双源冲突），相同则幂等去重
  parsed.sort((a, b) => a.ts - b.ts);
  const deduped = [];
  for (const item of parsed) {
    const last = deduped[deduped.length - 1];
    if (last && last.ts === item.ts) {
      if (last.priceUsdE8 !== item.priceUsdE8) {
        throw new Error(
          `conflicting prices at identical timestamp ${item.ts}: ${last.priceUsdE8} vs ${item.priceUsdE8}`,
        );
      }
      continue;
    }
    deduped.push(item);
  }
  return deduped;
}

/**
 * 严格时间加权平均价（TWAP）计算：
 * 区间 [windowStart, windowEnd) 上，价格按阶梯函数连续生效（左闭右开）：
 *   TWAP = floor( sum(price_k * dt_k) / (windowEnd - windowStart) )
 * 强制约束：
 * 1. observedUntil >= windowEnd（数据源必须完整覆盖至窗口结束，防截断或提前结算）。
 * 2. 必须存在窗口起点锚定价（t <= windowStart），且起点锚定样本距 windowStart 不超过 maxAnchorAgeSeconds。
 * 3. 全程纯 BigInt 定点运算，零浮点误差。
 */
export function computeWindowTwapUsdE8(rawSamples, windowStart, windowEnd, opts = {}) {
  const start = parseUnixSeconds(windowStart, 'windowStart');
  const end = parseUnixSeconds(windowEnd, 'windowEnd');
  if (end <= start) {
    throw new Error(`windowEnd (${end}) must be > windowStart (${start})`);
  }
  const observedUntil = parseUnixSeconds(opts.observedUntil, 'observedUntil');
  if (observedUntil < end) {
    throw new Error(`stale market feed: observedUntil (${observedUntil}) < windowEnd (${end})`);
  }
  const maxAnchorAgeSeconds = opts.maxAnchorAgeSeconds !== undefined
    ? Number(opts.maxAnchorAgeSeconds)
    : DEFAULT_MAX_ANCHOR_AGE_SECONDS;
  if (!Number.isInteger(maxAnchorAgeSeconds) || maxAnchorAgeSeconds < 0) {
    throw new Error(`invalid maxAnchorAgeSeconds: ${opts.maxAnchorAgeSeconds}`);
  }

  const samples = normalizePriceSamples(rawSamples);

  // 寻找 t <= start 的最近锚定价
  let anchor = null;
  for (const s of samples) {
    if (s.ts <= start) anchor = s;
    else break;
  }
  if (!anchor) {
    throw new Error(`missing anchor price at or before windowStart (${start})`);
  }
  if (start - anchor.ts > maxAnchorAgeSeconds) {
    throw new Error(
      `anchor price at ${anchor.ts} is too stale for windowStart ${start} (age=${start - anchor.ts}s > ${maxAnchorAgeSeconds}s)`,
    );
  }

  let cursor = start;
  let currentPrice = anchor.priceUsdE8;
  let weightedSum = 0n;
  let inWindowTransitions = 0;

  for (const s of samples) {
    if (s.ts <= start) continue;
    if (s.ts >= end) break;
    const dt = BigInt(s.ts - cursor);
    weightedSum += currentPrice * dt;
    cursor = s.ts;
    currentPrice = s.priceUsdE8;
    inWindowTransitions += 1;
  }

  const tailDt = BigInt(end - cursor);
  weightedSum += currentPrice * tailDt;

  const duration = BigInt(end - start);
  const twapUsdE8 = weightedSum / duration;
  if (twapUsdE8 <= 0n) {
    throw new Error(`computed TWAP must be > 0 for window [${start}, ${end})`);
  }

  return {
    start,
    end,
    durationSeconds: end - start,
    twapUsdE8: twapUsdE8.toString(),
    anchorTs: anchor.ts,
    anchorPriceUsdE8: anchor.priceUsdE8.toString(),
    inWindowTransitions,
  };
}

/**
 * 严格提供方回包解析器：从归档原始回包确定性重建价格样本。
 * 强制校验：
 * 1. rawPayload 必须包含真实池元数据 poolMetadata（经 verifyStonfiPoolMetadata 核验池地址与代币绑定）；
 * 2. rawPayload.trades 必须符合 GeckoTerminal JSON:API 契约（经 normalizeGeckoTerminalTrades 核验每笔成交）；
 * 3. 每笔成交时间不得晚于 fetchedAt（防未来时间伪造）。
 */
export function extractVerifiedSamplesFromRawPayload(rawPayload, binding, { fetchedAt = null } = {}) {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    throw new Error('rawPayload must be a provider response object containing poolMetadata and trades');
  }
  if (!rawPayload.poolMetadata || typeof rawPayload.poolMetadata !== 'object') {
    throw new Error('rawPayload missing required poolMetadata for pool/token binding verification');
  }
  if (!rawPayload.trades || !Array.isArray(rawPayload.trades.data)) {
    throw new Error('rawPayload missing required trades.data array');
  }
  const poolCheck = verifyStonfiPoolMetadata(rawPayload.poolMetadata, binding);
  const samples = normalizeGeckoTerminalTrades(rawPayload.trades, binding);
  if (fetchedAt !== null && fetchedAt !== undefined) {
    const fTs = parseUnixSeconds(fetchedAt, 'fetchedAt');
    for (const s of samples) {
      if (s.ts > fTs) {
        throw new Error(`trade timestamp (${s.ts}) exceeds segment fetchedAt (${fTs})`);
      }
    }
  }
  return { poolCheck, samples };
}

/**
 * 校验单条抓取的真实分页游标链、原始回包哈希、样本重建与「无成交 vs 漏采」边界证明。
 */
function validateCoveragePaginationAndEvidence(seg, idx, binding, segStart, fetchedAt) {
  if (!seg.rawPayload || typeof seg.rawPayload !== 'object') {
    throw new Error(`coverageSegments[${idx}] missing replayable rawPayload evidence`);
  }
  const expectedRawSha = sha256Hex(seg.rawPayload);
  const rawSha = String(seg.rawSha256 || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(rawSha) || rawSha !== expectedRawSha) {
    throw new Error(`coverageSegments[${idx}] rawSha256 mismatch against rawPayload`);
  }

  // 严格从 rawPayload 重建真实样本并校验池/代币绑定
  const { samples: derivedSamples } = extractVerifiedSamplesFromRawPayload(seg.rawPayload, binding, { fetchedAt });

  if (seg.rawPayload.capture) {
    const samples = verifyRecentTradesCapture(seg.rawPayload, binding, segStart, seg.end ?? segStart + 1, fetchedAt);
    if (seg.pagination?.kind !== 'bounded-recent-feed' || seg.pagination.cursorSupported !== false
        || seg.pagination.fetchedCount !== samples.length || seg.pagination.responseCap !== RECENT_TRADES_CAP) {
      throw new Error('RECENT_CAPTURE_METADATA_MISMATCH');
    }
    return {derivedSamples: relevantWindowSamples(samples, segStart, seg.end), noTrades: !samples.some(s => s.ts >= segStart && s.ts < seg.end),
      rawPayload: seg.rawPayload, rawSha256: expectedRawSha, pagination: seg.pagination};
  }
  const pg = seg.pagination;
  if (!pg || typeof pg !== 'object') {
    throw new Error(`coverageSegments[${idx}] missing pagination/cursor integrity metadata`);
  }
  const pageLimit = Number(pg.pageLimit);
  if (!Number.isInteger(pageLimit) || pageLimit <= 0) {
    throw new Error(`coverageSegments[${idx}] invalid pagination.pageLimit`);
  }
  if (!Array.isArray(pg.pages) || pg.pages.length === 0) {
    throw new Error(`coverageSegments[${idx}] pagination.pages must be a non-empty array of real fetched pages`);
  }

  let totalItemCount = 0;
  for (let p = 0; p < pg.pages.length; p += 1) {
    const page = pg.pages[p];
    if (!page || typeof page !== 'object') {
      throw new Error(`coverageSegments[${idx}].pagination.pages[${p}] must be an object`);
    }
    if (Number(page.pageIndex) !== p) {
      throw new Error(`coverageSegments[${idx}].pagination.pages[${p}] invalid pageIndex`);
    }
    if (p === 0) {
      if (page.cursorIn !== null && page.cursorIn !== undefined) {
        throw new Error(`coverageSegments[${idx}] first page cursorIn must be null`);
      }
    } else {
      const prevNext = pg.pages[p - 1].nextCursor;
      if (prevNext === null || prevNext === undefined || prevNext === '' || page.cursorIn !== prevNext) {
        throw new Error(`coverageSegments[${idx}] broken pagination cursor chain at page ${p}`);
      }
    }
    const itemCount = Number(page.itemCount);
    if (!Number.isInteger(itemCount) || itemCount < 0 || itemCount > pageLimit) {
      throw new Error(`coverageSegments[${idx}].pagination.pages[${p}] invalid itemCount ${page.itemCount}`);
    }
    totalItemCount += itemCount;
  }

  // 真实解析出的成交条数必须严格等于分页记录总条数（杜绝伪造计数）
  if (totalItemCount !== derivedSamples.length) {
    throw new Error(
      `coverageSegments[${idx}] derived trade count (${derivedSamples.length}) != pagination totalItemCount (${totalItemCount})`,
    );
  }

  const lastPage = pg.pages[pg.pages.length - 1];
  const firstPage = pg.pages[0];
  let noTrades = false;

  if (derivedSamples.length === 0) {
    // 明确区分无成交与漏采：仅当单页返回 0 条且 nextCursor === null（未截断）时确认本片段确实无成交
    if (pg.pages.length !== 1 || lastPage.itemCount !== 0 || (lastPage.nextCursor !== null && lastPage.nextCursor !== undefined)) {
      throw new Error(`coverageSegments[${idx}] zero-trade segment has inconsistent pagination cursor (possible missed trades)`);
    }
    noTrades = true;
  } else {
    const tsList = derivedSamples.map((s) => s.ts);
    const minParsedTs = Math.min(...tsList);
    const maxParsedTs = Math.max(...tsList);
    if (Number(lastPage.oldestTs) !== minParsedTs || Number(firstPage.newestTs) !== maxParsedTs) {
      throw new Error(
        `coverageSegments[${idx}] pagination timestamps [oldest=${lastPage.oldestTs}, newest=${firstPage.newestTs}] do not match parsed trades [${minParsedTs}, ${maxParsedTs}]`,
      );
    }
    const exhaustedAllHistory = lastPage.itemCount < pageLimit && (lastPage.nextCursor === null || lastPage.nextCursor === undefined);
    const coveredBackToStart = minParsedTs <= segStart;
    if (!exhaustedAllHistory && !coveredBackToStart) {
      throw new Error(
        `coverageSegments[${idx}] pagination truncated before segment start (${minParsedTs} > ${segStart}) with full page (${lastPage.itemCount}/${pageLimit}); possible missed trades`,
      );
    }
  }

  return {
    derivedSamples,
    noTrades,
    rawPayload: seg.rawPayload,
    rawSha256: expectedRawSha,
    pagination: {
      pageLimit,
      pages: pg.pages.map((p) => ({
        pageIndex: Number(p.pageIndex),
        cursorIn: p.cursorIn ?? null,
        nextCursor: p.nextCursor ?? null,
        itemCount: Number(p.itemCount),
        oldestTs: p.oldestTs ?? null,
        newestTs: p.newestTs ?? null,
      })),
    },
  };
}

/**
 * 校验连续采集覆盖证明（coverageSegments），并确定性重建所有价格样本。
 */
export function verifyContinuousCoverageSegments(
  coverageSegments,
  windowStart,
  windowEnd,
  binding,
  { maxSegmentSeconds = DEFAULT_MAX_COVERAGE_SEGMENT_SECONDS } = {},
) {
  const start = parseUnixSeconds(windowStart, 'windowStart');
  const end = parseUnixSeconds(windowEnd, 'windowEnd');
  if (end <= start) throw new Error(`windowEnd (${end}) must be > windowStart (${start})`);
  const normBinding = validatePoolBinding(binding);
  if (!Array.isArray(coverageSegments) || coverageSegments.length === 0) {
    throw new Error('continuous coverageSegments are required (single old sample + observedUntil cannot prove full history)');
  }
  const maxSeg = Number(maxSegmentSeconds);
  if (!Number.isInteger(maxSeg) || maxSeg <= 0) {
    throw new Error(`invalid maxSegmentSeconds: ${maxSegmentSeconds}`);
  }

  const allDerivedSamples = [];
  const normalized = coverageSegments.map((seg, idx) => {
    if (!seg || typeof seg !== 'object') {
      throw new Error(`coverageSegments[${idx}] must be an object`);
    }
    const s = parseUnixSeconds(seg.start, `coverageSegments[${idx}].start`);
    const e = parseUnixSeconds(seg.end, `coverageSegments[${idx}].end`);
    const fetchedAt = parseUnixSeconds(seg.fetchedAt, `coverageSegments[${idx}].fetchedAt`);
    if (e <= s) {
      throw new Error(`coverageSegments[${idx}] end (${e}) must be > start (${s})`);
    }
    if (e - s > maxSeg) {
      throw new Error(`coverageSegments[${idx}] duration (${e - s}s) exceeds maxSegmentSeconds (${maxSeg}s)`);
    }
    if (fetchedAt < e) {
      throw new Error(`coverageSegments[${idx}] fetchedAt (${fetchedAt}) < end (${e})`);
    }
    if (String(seg.provider || '').trim() !== normBinding.provider) {
      throw new Error(`coverageSegments[${idx}] provider mismatch`);
    }
    if (String(seg.poolAddress || '').trim() !== normBinding.poolAddress) {
      throw new Error(`coverageSegments[${idx}] poolAddress mismatch`);
    }
    const ev = validateCoveragePaginationAndEvidence(seg, idx, normBinding, s, fetchedAt);
    allDerivedSamples.push(...ev.derivedSamples);
    return {
      start: s,
      end: e,
      fetchedAt,
      provider: normBinding.provider,
      poolAddress: normBinding.poolAddress,
      noTrades: ev.noTrades,
      rawSha256: ev.rawSha256,
      pagination: ev.pagination,
      rawPayload: ev.rawPayload,
    };
  });

  normalized.sort((a, b) => (a.start - b.start) || (a.end - b.end));

  let coveredUntil = null;
  for (const seg of normalized) {
    if (seg.end <= start) continue;
    if (seg.start >= end) break;
    if (coveredUntil === null) {
      if (seg.start > start) {
        throw new Error(`coverage gap at window start: missing [${start}, ${seg.start})`);
      }
      coveredUntil = seg.end;
    } else {
      if (seg.start > coveredUntil) {
        throw new Error(`coverage gap detected: missing [${coveredUntil}, ${seg.start})`);
      }
      if (seg.end > coveredUntil) coveredUntil = seg.end;
    }
  }
  if (coveredUntil === null || coveredUntil < end) {
    throw new Error(`coverage gap at window end: covered until ${coveredUntil ?? '<none>'}, expected >= ${end}`);
  }

  const canonicalDerivedSamples = allDerivedSamples.length > 0
    ? normalizePriceSamples(allDerivedSamples).map((x) => ({
        ts: x.ts,
        priceUsdE8: x.priceUsdE8.toString(),
        ...(x.txHash ? { txHash: x.txHash } : {}),
      }))
    : [];

  return {
    ok: true,
    segmentCount: normalized.length,
    segments: normalized,
    derivedSamples: canonicalDerivedSamples,
    coverageProofSha256: sha256Hex(normalized),
  };
}

/**
 * 构建 12 根连续 1H 结算输入包（带来源、时间边界、连续覆盖证明、原始证据哈希、定点 TWAP 与可重放总哈希）。
 * 默认仅输出待核验结算输入包，不广播任何交易。
 */
export function buildSettlementInputBundle({
  roundId,
  targetPriceUsdE8,
  stakeCloseAt,
  observationSeconds = 43200,
  candleCount = 12,
  samples,
  coverageSegments,
  observedUntil,
  binding,
  rawEvidence = null,
  maxAnchorAgeSeconds = DEFAULT_MAX_ANCHOR_AGE_SECONDS,
  maxCoverageSegmentSeconds = DEFAULT_MAX_COVERAGE_SEGMENT_SECONDS,
}) {
  const normalizedBinding = validatePoolBinding(binding);
  const rId = Number(roundId);
  if (!Number.isInteger(rId) || rId < 1) {
    throw new Error(`roundId must be a positive integer, got ${roundId}`);
  }
  const target = BigInt(targetPriceUsdE8);
  if (target <= 0n) {
    throw new Error('targetPriceUsdE8 must be > 0');
  }
  const closeAt = parseUnixSeconds(stakeCloseAt, 'stakeCloseAt');
  const obsSec = Number(observationSeconds);
  const count = Number(candleCount);
  if (!Number.isInteger(obsSec) || obsSec <= 0 || !Number.isInteger(count) || count < 1 || obsSec % count !== 0) {
    throw new Error(`invalid observationSeconds (${observationSeconds}) / candleCount (${candleCount})`);
  }
  const stepSeconds = obsSec / count;
  const windowEnd = closeAt + obsSec;
  const obsUntil = parseUnixSeconds(observedUntil, 'observedUntil');
  if (obsUntil < windowEnd) {
    throw new Error(`observation window not complete: observedUntil (${obsUntil}) < windowEnd (${windowEnd})`);
  }

  // 强制校验连续采集覆盖证明，并直接从原始提供方回包确定性派生所有价格样本
  const coverage = verifyContinuousCoverageSegments(
    coverageSegments,
    closeAt,
    windowEnd,
    normalizedBinding,
    { maxSegmentSeconds: maxCoverageSegmentSeconds },
  );

  // 严禁原始证据与独立传入 samples 各自自洽却互不关联：
  // 若调用方同时传入了 samples，必须与原始回包确定性派生的样本逐笔完全一致！
  if (samples !== undefined && samples !== null) {
    const providedCanonical = normalizePriceSamples(samples).map((s) => ({
      ts: s.ts,
      priceUsdE8: s.priceUsdE8.toString(),
      ...(s.txHash ? { txHash: s.txHash } : {}),
    }));
    if (canonicalJsonStringify(providedCanonical) !== canonicalJsonStringify(coverage.derivedSamples)) {
      throw new Error(
        'SAMPLES_EVIDENCE_MISMATCH: provided samples do not match samples deterministically derived from rawPayload evidence',
      );
    }
  }

  const normalizedSamples = normalizePriceSamples(coverage.derivedSamples);
  const candles = [];
  for (let i = 0; i < count; i += 1) {
    const start = closeAt + i * stepSeconds;
    const end = start + stepSeconds;
    const w = computeWindowTwapUsdE8(normalizedSamples, start, end, {
      observedUntil: obsUntil,
      maxAnchorAgeSeconds,
    });
    candles.push({
      index: i,
      start: w.start,
      end: w.end,
      twapUsdE8: w.twapUsdE8,
      anchorTs: w.anchorTs,
      inWindowTransitions: w.inWindowTransitions,
    });
  }

  const agg = aggregateCandles(rId, target.toString(), candles, count, {
    observationSeconds: obsSec,
    stakeCloseAt: closeAt,
  });

  const canonicalSamples = normalizedSamples.map((s) => ({
    ts: s.ts,
    priceUsdE8: s.priceUsdE8.toString(),
    ...(s.txHash ? { txHash: s.txHash } : {}),
  }));
  const rawEvidenceSha256 = sha256Hex(rawEvidence !== null ? rawEvidence : canonicalSamples);

  const corePayload = {
    version: ORACLE_BUNDLE_VERSION,
    method: 'STEP_TWAP_FLOOR_USD_E8',
    binding: normalizedBinding,
    roundId: rId,
    targetPriceUsdE8: target.toString(),
    stakeCloseAt: closeAt,
    observationSeconds: obsSec,
    candleCount: count,
    stepSeconds,
    windowStart: agg.windowStart,
    windowEnd: agg.windowEnd,
    observedUntil: obsUntil,
    maxAnchorAgeSeconds,
    maxCoverageSegmentSeconds,
    coverageSegments: coverage.segments,
    coverageProofSha256: coverage.coverageProofSha256,
    sampleCount: canonicalSamples.length,
    samples: canonicalSamples,
    candles,
    qualifiedCandles: agg.qualifiedCandles,
    candleHashHex: agg.candleHashHex,
    candleHashDec: agg.candleHashDec,
    rawEvidenceSha256,
  };

  return {
    ...corePayload,
    outputSha256: sha256Hex(corePayload),
    broadcasted: false,
  };
}

/**
 * 确定性重放验真：校验结算输入包的池绑定、连续覆盖证明、样本重算 TWAP、aggregateCandles 与 outputSha256。
 */
export function verifySettlementInputBundle(bundle, expectedBinding = null) {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('settlement input bundle is required');
  }
  if (bundle.version !== ORACLE_BUNDLE_VERSION) {
    throw new Error(`unsupported settlement bundle version: ${bundle.version}`);
  }
  if (bundle.method !== 'STEP_TWAP_FLOOR_USD_E8') {
    throw new Error(`unsupported TWAP method: ${bundle.method}`);
  }
  const actualBinding = validatePoolBinding(bundle.binding);
  if (expectedBinding) {
    const exp = validatePoolBinding(expectedBinding);
    if (
      actualBinding.network !== exp.network ||
      actualBinding.poolAddress !== exp.poolAddress ||
      actualBinding.a9JettonMaster !== exp.a9JettonMaster ||
      actualBinding.quoteAsset !== exp.quoteAsset
    ) {
      throw new Error('settlement bundle pool binding mismatch against expected binding');
    }
  }

  const recomputed = buildSettlementInputBundle({
    roundId: bundle.roundId,
    targetPriceUsdE8: bundle.targetPriceUsdE8,
    stakeCloseAt: bundle.stakeCloseAt,
    observationSeconds: bundle.observationSeconds,
    candleCount: bundle.candleCount,
    // 重放验真时强制从 coverageSegments[].rawPayload 重新解析重建样本，并与 bundle.samples 逐项比对
    samples: bundle.samples,
    coverageSegments: bundle.coverageSegments,
    observedUntil: bundle.observedUntil,
    binding: actualBinding,
    maxAnchorAgeSeconds: bundle.maxAnchorAgeSeconds,
    maxCoverageSegmentSeconds: bundle.maxCoverageSegmentSeconds,
  });

  if (canonicalJsonStringify(recomputed.samples) !== canonicalJsonStringify(bundle.samples)) {
    throw new Error('SAMPLES_EVIDENCE_MISMATCH: settlement bundle samples do not match replay from rawPayload');
  }

  if (recomputed.coverageProofSha256 !== bundle.coverageProofSha256) {
    throw new Error('settlement bundle coverageProofSha256 mismatch on replay');
  }
  if (recomputed.candleHashHex !== bundle.candleHashHex || recomputed.candleHashDec !== bundle.candleHashDec) {
    throw new Error(
      `settlement bundle candleHash mismatch on replay: expected ${recomputed.candleHashHex}, got ${bundle.candleHashHex}`,
    );
  }
  if (recomputed.qualifiedCandles !== bundle.qualifiedCandles) {
    throw new Error(
      `settlement bundle qualifiedCandles mismatch on replay: expected ${recomputed.qualifiedCandles}, got ${bundle.qualifiedCandles}`,
    );
  }
  if (canonicalJsonStringify(recomputed.candles) !== canonicalJsonStringify(bundle.candles)) {
    throw new Error('settlement bundle candles mismatch on replay');
  }
  const { outputSha256, broadcasted: _b, ...rest } = bundle;
  const expectedOutputHash = sha256Hex(rest);
  if (expectedOutputHash !== outputSha256) {
    throw new Error(`settlement bundle outputSha256 mismatch: expected ${expectedOutputHash}, got ${outputSha256}`);
  }
  return {
    ok: true,
    roundId: recomputed.roundId,
    qualifiedCandles: recomputed.qualifiedCandles,
    candleHashHex: recomputed.candleHashHex,
    candleHashDec: recomputed.candleHashDec,
    coverageProofSha256: recomputed.coverageProofSha256,
    outputSha256: expectedOutputHash,
    binding: actualBinding,
  };
}

/**
 * 构建开轮 24H 基准 TWAP 与走廊核验计划（要求连续采集覆盖证明，默认不广播）。
 */
export function buildOpenRoundTwapPlan({
  roundId,
  referenceTime,
  windowSeconds = 86400,
  samples,
  coverageSegments,
  observedUntil,
  targetPriceUsdE8,
  p0UsdE8 = '116000',
  binding,
  rawEvidence = null,
  maxAnchorAgeSeconds = DEFAULT_MAX_ANCHOR_AGE_SECONDS,
  maxCoverageSegmentSeconds = DEFAULT_MAX_COVERAGE_SEGMENT_SECONDS,
}) {
  const normalizedBinding = validatePoolBinding(binding);
  const rId = Number(roundId);
  if (!Number.isInteger(rId) || rId < 1) {
    throw new Error(`roundId must be a positive integer, got ${roundId}`);
  }
  const refTs = parseUnixSeconds(referenceTime, 'referenceTime');
  const winSec = Number(windowSeconds);
  if (!Number.isInteger(winSec) || winSec <= 0) {
    throw new Error(`invalid windowSeconds: ${windowSeconds}`);
  }
  const windowStart = refTs - winSec;
  if (windowStart <= 0) {
    throw new Error('referenceTime - windowSeconds must be > 0');
  }
  const coverage = verifyContinuousCoverageSegments(
    coverageSegments,
    windowStart,
    refTs,
    normalizedBinding,
    { maxSegmentSeconds: maxCoverageSegmentSeconds },
  );
  if (samples !== undefined && samples !== null) {
    const providedCanonical = normalizePriceSamples(samples).map((s) => ({
      ts: s.ts,
      priceUsdE8: s.priceUsdE8.toString(),
      ...(s.txHash ? { txHash: s.txHash } : {}),
    }));
    if (canonicalJsonStringify(providedCanonical) !== canonicalJsonStringify(coverage.derivedSamples)) {
      throw new Error(
        'SAMPLES_EVIDENCE_MISMATCH: provided samples do not match samples deterministically derived from rawPayload evidence',
      );
    }
  }
  const twap = computeWindowTwapUsdE8(coverage.derivedSamples, windowStart, refTs, {
    observedUntil,
    maxAnchorAgeSeconds,
  });
  const corridor = assertTargetInCorridor(rId, twap.twapUsdE8, targetPriceUsdE8, p0UsdE8);
  const normalizedSamples = coverage.derivedSamples;
  const core = {
    version: ORACLE_OPEN_PLAN_VERSION,
    method: 'STEP_TWAP_FLOOR_USD_E8',
    binding: normalizedBinding,
    roundId: rId,
    windowStart,
    windowEnd: refTs,
    observedUntil: parseUnixSeconds(observedUntil, 'observedUntil'),
    coverageProofSha256: coverage.coverageProofSha256,
    twap24hUsdE8: twap.twapUsdE8,
    targetPriceUsdE8: corridor.target.toString(),
    corridorMinUsdE8: corridor.minTarget.toString(),
    corridorMaxUsdE8: corridor.maxTarget.toString(),
    sampleCount: normalizedSamples.length,
    rawEvidenceSha256: sha256Hex(rawEvidence !== null ? rawEvidence : normalizedSamples),
  };
  return {
    ...core,
    outputSha256: sha256Hex(core),
    broadcasted: false,
  };
}

/**
 * 连续行情采集归档器（原子落盘、重启可续跑、保存不可变原始样本与连续覆盖片段）。
 */
export class MarketSampleArchive {
  constructor(filePath, binding) {
    if (!filePath) throw new Error('archive filePath is required');
    this.filePath = filePath;
    this.binding = validatePoolBinding(binding);
  }

  load() {
    if (!existsSync(this.filePath)) {
      return {
        version: 'a9-v17-market-archive-v1',
        binding: this.binding,
        samples: [],
        coverageSegments: [],
      };
    }
    const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
    const existingBinding = validatePoolBinding(data.binding);
    if (
      existingBinding.network !== this.binding.network
      || existingBinding.poolAddress !== this.binding.poolAddress
      || existingBinding.a9JettonMaster !== this.binding.a9JettonMaster
    ) {
      throw new Error('archive file pool binding does not match configured binding');
    }
    return data;
  }

  _atomicSave(data) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.filePath);
  }

  appendPoll({ start, end, fetchedAt, rawPayload, pagination }) {
    const s = parseUnixSeconds(start, 'poll.start');
    const e = parseUnixSeconds(end, 'poll.end');
    const f = parseUnixSeconds(fetchedAt, 'poll.fetchedAt');
    if (e <= s || f < e) throw new Error('invalid poll coverage boundaries');
    if (!rawPayload || typeof rawPayload !== 'object') {
      throw new Error('appendPoll requires replayable rawPayload (self-declared empty coverage intervals are forbidden)');
    }
    const rawSha256 = sha256Hex(rawPayload);
    const verifiedEv = validateCoveragePaginationAndEvidence(
      { rawPayload, rawSha256, pagination, end: e },
      0,
      this.binding,
      s,
      f,
    );

    const cur = this.load();
    const duplicate = cur.coverageSegments.find(x => x.start === s && x.end === e && x.rawSha256 === rawSha256);
    if (duplicate) return cur;
    const lastEnd = Math.max(0, ...cur.coverageSegments.map(x => x.end));
    if (lastEnd && s > lastEnd) throw new Error('ARCHIVE_COVERAGE_GAP: poll does not overlap previous capture');
    const mergedRawSamples = [...cur.samples, ...verifiedEv.derivedSamples];
    const normalizedSamples = mergedRawSamples.length > 0
      ? normalizePriceSamples(mergedRawSamples).map((x) => ({
          ts: x.ts,
          priceUsdE8: x.priceUsdE8.toString(),
          ...(x.txHash ? { txHash: x.txHash } : {}),
        }))
      : [];

    const segment = {
      start: s,
      end: e,
      fetchedAt: f,
      provider: this.binding.provider,
      poolAddress: this.binding.poolAddress,
      noTrades: verifiedEv.noTrades,
      rawSha256: verifiedEv.rawSha256,
      pagination: verifiedEv.pagination,
      rawPayload: verifiedEv.rawPayload,
    };

    const next = {
      version: 'a9-v17-market-archive-v1',
      binding: this.binding,
      samples: normalizedSamples,
      observedUntil: Math.max(e, cur.observedUntil || 0),
      coverageSegments: [...cur.coverageSegments, segment],
    };
    this._atomicSave(next);
    return next;
  }
}

/**
 * 带有限重试与超时保护的上游 JSON 采集（失败时 fail-closed，绝不返回 0 或演示数据）。
 */
export async function fetchJsonWithRetry(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is unavailable');
  }
  const maxAttempts = Math.max(1, Number(opts.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, Number(opts.baseDelayMs ?? 250));
  const timeoutMs = Math.max(100, Number(opts.timeoutMs ?? 8000));
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...(opts.headers || {}) },
        signal: controller.signal,
      });
      if (res.ok) {
        const value = await res.json();
        clearTimeout(timer);
        return value;
      }
      clearTimeout(timer);
      const retryable = res.status === 429 || res.status >= 500;
      const err = new Error(`upstream HTTP ${res.status} for ${url}`);
      err.status = res.status;
      if (!retryable || attempt === maxAttempts) {
        throw err;
      }
      lastErr = err;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const isNonRetryableHttp = err && typeof err.status === 'number' && err.status >= 400 && err.status < 500 && err.status !== 429;
      if (isNonRetryableHttp || attempt === maxAttempts) {
        throw err;
      }
    }
    if (baseDelayMs > 0) {
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastErr || new Error(`upstream request failed for ${url}`);
}

/**
 * 从真实提供方采集池元数据与逐笔成交（默认只读，不落链、不广播）。
 * 注意：GeckoTerminal 公开 /trades 接口仅保留最近窗口内成交，若未能覆盖完整 12H/24H，
 * computeWindowTwapUsdE8 会因缺锚定或覆盖不足自动 fail-closed 拒绝，必须配合归档采样器使用。
 */
// Older feed history is retained in raw evidence, but irrelevant prices must not
// introduce false same-second conflicts outside the requested interval.
function relevantWindowSamples(samples, start, end) {
  const older = samples.filter(s => s.ts <= start);
  const anchorTs = older.length ? Math.max(...older.map(s => s.ts)) : null;
  return samples.filter(s => (s.ts === anchorTs) || (s.ts > start && s.ts < end));
}

export const RECENT_TRADES_CAPTURE_VERSION = 'geckoterminal-ton-recent-v1';
export const RECENT_TRADES_CAP = 300;

/** Captured HTTP evidence is replayable provider evidence, not a cryptographic chain proof.
 * Public trades is a bounded recent feed: no fabricated historical cursor or exhaustion flag.
 */
export function verifyRecentTradesCapture(rawPayload, binding, start, end, fetchedAt) {
  const cap = rawPayload?.capture;
  if (cap?.version !== RECENT_TRADES_CAPTURE_VERSION) throw new Error('RECENT_CAPTURE_REQUIRED: missing real fetch capture');
  const b = validatePoolBinding(binding);
  const expectedPool = `https://api.ston.fi/v1/pools/${encodeURIComponent(b.poolAddress)}`;
  const expectedTrades = `https://api.geckoterminal.com/api/v2/networks/ton/pools/${encodeURIComponent(b.poolAddress)}/trades`;
  if (cap.poolUrl !== expectedPool || cap.tradesUrl !== expectedTrades || cap.method !== 'GET') {
    throw new Error('CAPTURE_ENDPOINT_MISMATCH');
  }
  const requestedAt = parseUnixSeconds(cap.requestedAt, 'capture.requestedAt');
  const completedAt = parseUnixSeconds(cap.completedAt, 'capture.completedAt');
  if (completedAt < requestedAt || completedAt !== fetchedAt || end > requestedAt) throw new Error('CAPTURE_TIME_MISMATCH');
  if (requestedAt - start >= 86400) throw new Error('RECENT_WINDOW_EXCEEDED: cannot prove history beyond recent feed');
  const {samples} = extractVerifiedSamplesFromRawPayload(rawPayload, b, {fetchedAt});
  if (!samples.length) throw new Error('EMPTY_RECENT_FEED_UNPROVEN: empty response cannot prove historical no-trades');
  if (samples.length > RECENT_TRADES_CAP) throw new Error('RECENT_FEED_SCHEMA_MISMATCH');
  const oldest = Math.min(...samples.map(s => s.ts));
  if (oldest > start) throw new Error('RECENT_FEED_TRUNCATED: oldest trade does not reach requested boundary');
  return samples;
}

export async function fetchRealProviderSamples({
  binding, verifyPool = true, fetchImpl, maxAttempts = 3, baseDelayMs = 250,
  timeoutMs = 8000, sleep, nowSec, clock = () => Math.floor(Date.now() / 1000),
} = {}) {
  const b = validatePoolBinding(binding);
  if (b.network !== 'mainnet') throw new Error('real provider fetch is only defined for TON mainnet STON.fi pools');
  if (!verifyPool) throw new Error('POOL_VERIFICATION_REQUIRED');
  const poolUrl = `https://api.ston.fi/v1/pools/${encodeURIComponent(b.poolAddress)}`;
  const tradesUrl = `https://api.geckoterminal.com/api/v2/networks/ton/pools/${encodeURIComponent(b.poolAddress)}/trades`;
  const requestedAt = parseUnixSeconds(nowSec ?? clock(), 'requestedAt');
  const opts = {fetchImpl, maxAttempts, baseDelayMs, timeoutMs, sleep};
  const poolMetadata = await fetchJsonWithRetry(poolUrl, opts);
  const poolVerification = verifyStonfiPoolMetadata(poolMetadata, b);
  const trades = await fetchJsonWithRetry(tradesUrl, opts);
  const completedAt = parseUnixSeconds(nowSec ?? clock(), 'completedAt');
  const rawPayload = {poolMetadata, trades, capture: {
    version: RECENT_TRADES_CAPTURE_VERSION, method: 'GET', poolUrl, tradesUrl, requestedAt, completedAt,
    historyWindowSeconds: 86400, responseCap: RECENT_TRADES_CAP,
  }};
  const {samples} = extractVerifiedSamplesFromRawPayload(rawPayload, b, {fetchedAt: completedAt});
  return {binding: b, poolVerification, samples, rawPayload, rawEvidence: rawPayload,
    observedUntil: requestedAt, fetchedAt: completedAt,
    // Informational only: no claim of complete history until a boundary is checked.
    pagination: {kind: 'bounded-recent-feed', cursorSupported: false, fetchedCount: samples.length, responseCap: RECENT_TRADES_CAP},
  };
}

/** Convert a real fetch result to archive input without hand-authored pagination. */
export function createRecentPoll(result, {start, end = result.observedUntil} = {}) {
  start = parseUnixSeconds(start, 'poll.start'); end = parseUnixSeconds(end, 'poll.end');
  const samples = verifyRecentTradesCapture(result.rawPayload, result.binding, start, end, result.fetchedAt);
  return {start, end, fetchedAt: result.fetchedAt, rawPayload: result.rawPayload,
    pagination: {kind: 'bounded-recent-feed', cursorSupported: false, fetchedCount: samples.length, responseCap: RECENT_TRADES_CAP}};
}

export function assertRealCaptureEvidence(segments, binding) {
  if (!Array.isArray(segments) || !segments.length) throw new Error('RECENT_CAPTURE_REQUIRED');
  for (const seg of segments) verifyRecentTradesCapture(seg.rawPayload, binding, seg.start, seg.end, seg.fetchedAt);
}
