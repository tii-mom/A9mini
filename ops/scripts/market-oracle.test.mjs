// A9 v17 任务 A 专项测试：真实行情提供方契约、定点 TWAP 精度、异常边界与确定性重放。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDecimalToUsdE8,
  validatePoolBinding,
  verifyStonfiPoolMetadata,
  normalizeGeckoTerminalTrades,
  computeWindowTwapUsdE8,
  buildSettlementInputBundle,
  verifySettlementInputBundle,
  buildOpenRoundTwapPlan,
  MarketSampleArchive,
  sha256Hex,
  fetchJsonWithRetry,
  fetchRealProviderSamples,
} from './lib/market-oracle.mjs';

// 测试用合法主网 basechain 地址（仅格式测试，非真实已部署主网池）
const MAINNET_POOL = 'EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt';
const MAINNET_A9_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const MAINNET_QUOTE_TON = 'EQCM3B12QK1e4yZSf8GtBRT0aLMNyEsBc_DhVfRRtOEffLez';
const TESTNET_ADDR = '0QCLc8xomAGwuxafaDmEyvxyLTqbzAS5L6JMZScKDVFRXM6X';

const BASE_BINDING = {
  network: 'mainnet',
  provider: 'geckoterminal-trades',
  dex: 'stonfi',
  poolAddress: MAINNET_POOL,
  a9JettonMaster: MAINNET_A9_MASTER,
  quoteAsset: 'GRAM',
  quoteAssetAddress: MAINNET_QUOTE_TON,
};

test('A-01 parseDecimalToUsdE8 纯字符串定点解析，杜绝浮点精度丢失并拒绝非法输入', () => {
  assert.equal(parseDecimalToUsdE8('0.00116'), 116000n);
  assert.equal(parseDecimalToUsdE8('1.234567899'), 123456789n); // 第 9 位向下截断
  assert.equal(parseDecimalToUsdE8('123456789.00000001'), 12345678900000001n);
  assert.throws(() => parseDecimalToUsdE8(0.00116), /decimal string/);
  assert.throws(() => parseDecimalToUsdE8('1.16e-3'), /plain decimal string/);
  assert.throws(() => parseDecimalToUsdE8('0'), /underflowed/);
  assert.throws(() => parseDecimalToUsdE8('-0.001'), /plain decimal string/);
  assert.throws(() => parseDecimalToUsdE8('0.000000001'), /underflowed/);
});

test('A-02 STON.fi 池元数据与 GeckoTerminal trades 真实回包契约校验', () => {
  const stonfiPayload = {
    pool: {
      address: MAINNET_POOL,
      token0_address: MAINNET_A9_MASTER,
      token1_address: MAINNET_QUOTE_TON,
      deprecated: false,
      reserve0: '500000000000000',
      reserve1: '250000000000',
    },
  };
  const verified = verifyStonfiPoolMetadata(stonfiPayload, BASE_BINDING);
  assert.equal(verified.ok, true);
  assert.equal(verified.poolAddress, MAINNET_POOL);

  // 池不匹配、A9 JettonMaster 不匹配、主网混入测试网地址均拒绝
  assert.throws(
    () => verifyStonfiPoolMetadata({ pool: { ...stonfiPayload.pool, token0_address: MAINNET_QUOTE_TON } }, BASE_BINDING),
    /does not contain A9 JettonMaster/,
  );
  assert.throws(
    () => verifyStonfiPoolMetadata({ pool: { ...stonfiPayload.pool, deprecated: true } }, BASE_BINDING),
    /deprecated/,
  );
  assert.throws(
    () => validatePoolBinding({ ...BASE_BINDING, poolAddress: TESTNET_ADDR }),
    /testnet-only address on mainnet/,
  );

  const geckoPayload = {
    data: [
      {
        id: 'ton_tx_1',
        type: 'trade',
        attributes: {
          block_timestamp: '2026-11-27T01:00:00Z',
          tx_hash: '0xaaa1',
          from_token_address: MAINNET_A9_MASTER,
          to_token_address: MAINNET_QUOTE_TON,
          price_from_in_usd: '0.00174000',
          price_to_in_usd: '5.12000000',
        },
      },
      {
        id: 'ton_tx_2',
        type: 'trade',
        attributes: {
          block_timestamp: '2026-11-27T01:30:00Z',
          tx_hash: '0xaaa2',
          from_token_address: MAINNET_QUOTE_TON,
          to_token_address: MAINNET_A9_MASTER,
          price_from_in_usd: '5.13000000',
          price_to_in_usd: '0.00180000',
        },
      },
    ],
  };
  const samples = normalizeGeckoTerminalTrades(geckoPayload, BASE_BINDING);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].priceUsdE8, '174000');
  assert.equal(samples[1].priceUsdE8, '180000');

  // 无关代币成交必须拒绝
  assert.throws(
    () => normalizeGeckoTerminalTrades({
      data: [{
        attributes: {
          block_timestamp: '2026-11-27T01:00:00Z',
          from_token_address: MAINNET_QUOTE_TON,
          to_token_address: MAINNET_POOL,
          price_from_in_usd: '5.0',
          price_to_in_usd: '1.0',
        },
      }],
    }, BASE_BINDING),
    /does not match A9 JettonMaster/,
  );
});

test('A-03 严格时间加权 TWAP 数学口径（证明非 OHLC 均值/非样本简单均值）', () => {
  // 窗口 [1000, 4600) 共 3600s：
  // 前 3000s 价格为 100000，最后 600s 涨至 220000。
  // 真正 TWAP = (100000*3000 + 220000*600) / 3600 = 432,000,000 / 3600 = 120000。
  // 样本算术均值/OHLC 均值 = 160000（明显错误，绝不能用）。
  const res = computeWindowTwapUsdE8(
    [
      { ts: 900, priceUsdE8: '100000' },
      { ts: 4000, priceUsdE8: '220000' },
    ],
    1000,
    4600,
    { observedUntil: 4600 },
  );
  assert.equal(res.twapUsdE8, '120000');
  assert.equal(res.inWindowTransitions, 1);

  // 乱序输入应与正序输入产出完全相同的定点 TWAP
  const shuffled = computeWindowTwapUsdE8(
    [
      { ts: 4000, priceUsdE8: '220000' },
      { ts: 900, priceUsdE8: '100000' },
    ],
    1000,
    4600,
    { observedUntil: 4600 },
  );
  assert.equal(shuffled.twapUsdE8, res.twapUsdE8);
});

test('A-04 缺锚定、陈旧数据、重叠价格冲突、重复 txHash 冲突一律拒绝', () => {
  // 缺少起点锚定价
  assert.throws(
    () => computeWindowTwapUsdE8([{ ts: 1001, priceUsdE8: '175000' }], 1000, 4600, { observedUntil: 4600 }),
    /missing anchor price/,
  );
  // 锚定价过于陈旧
  assert.throws(
    () => computeWindowTwapUsdE8([{ ts: 100, priceUsdE8: '175000' }], 100000, 103600, { observedUntil: 103600, maxAnchorAgeSeconds: 3600 }),
    /too stale/,
  );
  // 数据源未覆盖到窗口结束（提前结算/截断）
  assert.throws(
    () => computeWindowTwapUsdE8([{ ts: 900, priceUsdE8: '175000' }], 1000, 4600, { observedUntil: 4599 }),
    /stale market feed/,
  );
  // 同一时间戳价格冲突
  assert.throws(
    () => computeWindowTwapUsdE8(
      [
        { ts: 1000, priceUsdE8: '175000' },
        { ts: 1000, priceUsdE8: '176000' },
      ],
      1000,
      4600,
      { observedUntil: 4600 },
    ),
    /conflicting prices at identical timestamp/,
  );
  // 相同 txHash 但不同价格冲突
  assert.throws(
    () => computeWindowTwapUsdE8(
      [
        { ts: 1000, priceUsdE8: '175000', txHash: '0xdup' },
        { ts: 1010, priceUsdE8: '176000', txHash: '0xdup' },
      ],
      1000,
      4600,
      { observedUntil: 4600 },
    ),
    /conflicting duplicate txHash/,
  );
});

function usdE8ToDecimalStr(usdE8Str) {
  const v = BigInt(usdE8Str);
  const whole = v / 100_000_000n;
  const frac = (v % 100_000_000n).toString().padStart(8, '0');
  return `${whole}.${frac}`;
}

function makeProviderRawPayload(binding, trades = []) {
  return {
    poolMetadata: {
      pool: {
        address: binding.poolAddress,
        token0_address: binding.a9JettonMaster,
        token1_address: binding.quoteAssetAddress || MAINNET_QUOTE_TON,
        deprecated: false,
      },
    },
    trades: {
      data: trades.map((s, idx) => ({
        id: `trade_${s.ts}_${idx}`,
        type: 'trade',
        attributes: {
          block_timestamp: new Date(s.ts * 1000).toISOString(),
          tx_hash: s.txHash || `0xtx_${s.ts}_${idx}`,
          from_token_address: binding.a9JettonMaster,
          to_token_address: binding.quoteAssetAddress || MAINNET_QUOTE_TON,
          price_from_in_usd: usdE8ToDecimalStr(s.priceUsdE8),
          price_to_in_usd: '5.00000000',
        },
      })),
    },
  };
}

function makePaginationForTrades(trades, pageLimit = 100) {
  if (trades.length === 0) {
    return {
      pageLimit,
      pages: [{ pageIndex: 0, cursorIn: null, nextCursor: null, itemCount: 0, oldestTs: null, newestTs: null }],
    };
  }
  const tsList = trades.map((t) => t.ts);
  return {
    pageLimit,
    pages: [{
      pageIndex: 0,
      cursorIn: null,
      nextCursor: null,
      itemCount: trades.length,
      oldestTs: Math.min(...tsList),
      newestTs: Math.max(...tsList),
    }],
  };
}

function makeCoverage(start, end, binding, step = 1800, samples = []) {
  const segs = [];
  for (let t = start; t < end; t += step) {
    const segEnd = Math.min(end, t + step);
    const isFirst = t === start;
    const segTrades = samples.filter((s) => (isFirst ? s.ts <= segEnd : (s.ts > t && s.ts <= segEnd)));
    const rawPayload = makeProviderRawPayload(binding, segTrades);
    segs.push({
      start: t,
      end: segEnd,
      fetchedAt: segEnd,
      provider: binding.provider,
      poolAddress: binding.poolAddress,
      rawPayload,
      rawSha256: sha256Hex(rawPayload),
      pagination: makePaginationForTrades(segTrades, 100),
    });
  }
  return segs;
}

test('A-05 12 根 1H 完整结算包构建、连续覆盖证明、重启重放哈希一致、篡改与池不符拒绝', () => {
  const stakeCloseAt = 1795700000;
  const obsEnd = stakeCloseAt + 43200;
  const target = '174000';
  // 构造跨 12H 的真实成交序列：前 3H 低于目标价，后 9H 高于目标价 -> 应恰好 9/12 达标
  const samples = [
    { ts: stakeCloseAt - 600, priceUsdE8: '160000', txHash: '0x0' },
    { ts: stakeCloseAt + 3 * 3600, priceUsdE8: '180000', txHash: '0x1' },
    { ts: stakeCloseAt + 8 * 3600, priceUsdE8: '190000', txHash: '0x2' },
  ];
  const coverageSegments = makeCoverage(stakeCloseAt, obsEnd, BASE_BINDING, 1800, samples);

  const b1 = buildSettlementInputBundle({
    roundId: 1,
    targetPriceUsdE8: target,
    stakeCloseAt,
    observationSeconds: 43200,
    candleCount: 12,
    coverageSegments,
    observedUntil: obsEnd,
    binding: BASE_BINDING,
  });
  // 模拟进程重启后用乱序覆盖段重放（完全从原始回包重建样本），必须得出完全相同的 candleHash 与 outputSha256
  const b2 = buildSettlementInputBundle({
    roundId: 1,
    targetPriceUsdE8: target,
    stakeCloseAt,
    observationSeconds: 43200,
    candleCount: 12,
    coverageSegments: [...coverageSegments].reverse(),
    observedUntil: obsEnd,
    binding: BASE_BINDING,
  });

  assert.equal(b1.qualifiedCandles, 9);
  assert.equal(b1.broadcasted, false);
  assert.equal(b1.candleHashHex, b2.candleHashHex);
  assert.equal(b1.outputSha256, b2.outputSha256);

  const v = verifySettlementInputBundle(b1, BASE_BINDING);
  assert.equal(v.ok, true);
  assert.equal(v.qualifiedCandles, 9);

  // 篡改单根价格必须被重放验真拒绝
  const tampered = structuredClone(b1);
  tampered.candles[0].twapUsdE8 = '999999';
  assert.throws(() => verifySettlementInputBundle(tampered, BASE_BINDING), /mismatch on replay/);

  // 篡改池绑定必须被拒绝
  assert.throws(
    () => verifySettlementInputBundle(b1, { ...BASE_BINDING, quoteAsset: 'USDT' }),
    /pool binding mismatch/,
  );

  // 开轮 24H 基准 TWAP 走廊验证（样本由覆盖段原始回包确定性派生）
  const openSamples = [
    { ts: stakeCloseAt - 86400, priceUsdE8: '120000', txHash: '0xopen1' },
    { ts: stakeCloseAt - 43200, priceUsdE8: '140000', txHash: '0xopen2' },
  ];
  const openPlan = buildOpenRoundTwapPlan({
    roundId: 2,
    referenceTime: stakeCloseAt,
    windowSeconds: 86400,
    coverageSegments: makeCoverage(stakeCloseAt - 86400, stakeCloseAt, BASE_BINDING, 3600, openSamples),
    observedUntil: stakeCloseAt,
    targetPriceUsdE8: '200000', // base=130000, corridor=[169000, 260000]
    binding: BASE_BINDING,
  });
  assert.equal(openPlan.twap24hUsdE8, '130000');
  assert.equal(openPlan.broadcasted, false);
});

test('A-06 上游服务失败有限重试，失败耗尽 fail-closed 绝不用 0 或演示数据补齐', async () => {
  let calls = 0;
  const flakyFetch = async () => {
    calls += 1;
    if (calls < 3) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, attempt: calls }) };
  };
  const okRes = await fetchJsonWithRetry('https://example.invalid/trades', {
    fetchImpl: flakyFetch,
    maxAttempts: 3,
    baseDelayMs: 0,
  });
  assert.equal(okRes.attempt, 3);

  // 持续 503 必须抛错，不能返回空数组或 0 价格
  await assert.rejects(
    () => fetchRealProviderSamples({
      binding: BASE_BINDING,
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      maxAttempts: 2,
      baseDelayMs: 0,
    }),
    /upstream HTTP 503/,
  );
});

test('A-07 复现修复：单个旧样本加 observedUntil 不得冒充完整历史，必须提供连续无缺口采集覆盖证明', () => {
  const stakeCloseAt = 1795700000;
  const obsEnd = stakeCloseAt + 43200;
  const singleOldSample = [{ ts: stakeCloseAt - 600, priceUsdE8: '180000', txHash: '0xold' }];

  // 缺失 coverageSegments（仅传单样本 + observedUntil）必须拒绝
  assert.throws(
    () => buildSettlementInputBundle({
      roundId: 1,
      targetPriceUsdE8: '174000',
      stakeCloseAt,
      observationSeconds: 43200,
      candleCount: 12,
      samples: singleOldSample,
      observedUntil: obsEnd,
      binding: BASE_BINDING,
    }),
    /coverageSegments|continuous coverage/i,
  );

  // 单段跨度超过 maxSegmentSeconds（3600s）必须拒绝
  assert.throws(
    () => buildSettlementInputBundle({
      roundId: 1,
      targetPriceUsdE8: '174000',
      stakeCloseAt,
      observationSeconds: 43200,
      candleCount: 12,
      samples: singleOldSample,
      observedUntil: obsEnd,
      binding: BASE_BINDING,
      coverageSegments: [
        { start: stakeCloseAt, end: stakeCloseAt + 18000, fetchedAt: stakeCloseAt + 18000, provider: BASE_BINDING.provider, poolAddress: BASE_BINDING.poolAddress, rawSha256: '0x' + '11'.repeat(32) },
      ],
    }),
    /exceeds maxSegmentSeconds/i,
  );

  // 合法步长（1800s）但中间漏采 3600s 缺口必须被 coverage gap 拒绝
  const gappedSegments = [
    ...makeCoverage(stakeCloseAt, stakeCloseAt + 18000, BASE_BINDING, 1800),
    ...makeCoverage(stakeCloseAt + 21600, obsEnd, BASE_BINDING, 1800),
  ];
  assert.throws(
    () => buildSettlementInputBundle({
      roundId: 1,
      targetPriceUsdE8: '174000',
      stakeCloseAt,
      observationSeconds: 43200,
      candleCount: 12,
      samples: singleOldSample,
      observedUntil: obsEnd,
      binding: BASE_BINDING,
      coverageSegments: gappedSegments,
    }),
    /coverage gap/i,
  );
});

test('A-08 复现修复：round-ops 主网结算必须用可信配置校验池与代币绑定，不能只信输入包自声明', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'a9-roundops-bind-'));
  try {
    const stakeCloseAt = 1795700000;
    const obsEnd = stakeCloseAt + 43200;
    const anchorSample = [{ ts: stakeCloseAt - 60, priceUsdE8: '180000', txHash: '0x1' }];
    const coverageSegments = makeCoverage(stakeCloseAt, obsEnd, BASE_BINDING, 1800, anchorSample);
    const bundle = buildSettlementInputBundle({
      roundId: 1,
      targetPriceUsdE8: '174000',
      stakeCloseAt,
      observationSeconds: 43200,
      candleCount: 12,
      observedUntil: obsEnd,
      binding: BASE_BINDING,
      coverageSegments,
    });
    const filePath = join(dir, 'bundle.json');
    writeFileSync(filePath, JSON.stringify(bundle), 'utf8');

    // 主网缺少可信池/代币配置时，round-ops 必须拒绝
    const noTrusted = spawnSync(
      'node',
      ['ops/scripts/round-ops.mjs', '--profile', 'mainnet', '--action', 'settle-round', '--round', '1', '--target', '174000', '--stake-close-at', String(stakeCloseAt), '--candles-file', filePath, '--offline'],
      { encoding: 'utf8', env: { PATH: process.env.PATH } },
    );
    assert.notEqual(noTrusted.status, 0);
    assert.match(noTrusted.stderr, /A9_MARKET_POOL_ADDRESS|trusted market binding/i);

    // 主网可信配置池地址与输入包自声明不一致时，round-ops 必须拒绝
    const mismatched = spawnSync(
      'node',
      ['ops/scripts/round-ops.mjs', '--profile', 'mainnet', '--action', 'settle-round', '--round', '1', '--target', '174000', '--stake-close-at', String(stakeCloseAt), '--candles-file', filePath, '--offline'],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          A9_MARKET_POOL_ADDRESS: MAINNET_QUOTE_TON,
          A9_JETTON_MASTER_ADDRESS: MAINNET_A9_MASTER,
          A9_MARKET_QUOTE_ASSET: 'GRAM',
        },
      },
    );
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stderr, /pool binding mismatch/i);

    // 池配置正确仍不能把合成夹具作为主网真实采集证据
    const matched = spawnSync(
      'node',
      ['ops/scripts/round-ops.mjs', '--profile', 'mainnet', '--action', 'settle-round', '--round', '1', '--target', '174000', '--stake-close-at', String(stakeCloseAt), '--candles-file', filePath, '--offline'],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          A9_MARKET_POOL_ADDRESS: MAINNET_POOL,
          A9_JETTON_MASTER_ADDRESS: MAINNET_A9_MASTER,
          A9_MARKET_QUOTE_ASSET: 'GRAM',
          A9_MARKET_PROVIDER: BASE_BINDING.provider,
        },
      },
    );
    assert.notEqual(matched.status, 0);
    assert.match(matched.stderr, /RECENT_CAPTURE_REQUIRED/);

    // 验证 MarketSampleArchive 原子归档与重启续跑（携带完整可重放原始回包与真实游标分页，样本自动从 rawPayload 派生）
    const archivePath = join(dir, 'archive.json');
    const arch1 = new MarketSampleArchive(archivePath, BASE_BINDING);
    const pollTrades = [{ ts: stakeCloseAt - 60, priceUsdE8: '180000', txHash: '0xarch1' }];
    const pollRaw = makeProviderRawPayload(BASE_BINDING, pollTrades);
    arch1.appendPoll({
      start: stakeCloseAt,
      end: stakeCloseAt + 1800,
      fetchedAt: stakeCloseAt + 1800,
      rawPayload: pollRaw,
      pagination: makePaginationForTrades(pollTrades, 100),
    });
    const arch2 = new MarketSampleArchive(archivePath, BASE_BINDING);
    const loaded = arch2.load();
    assert.equal(loaded.coverageSegments.length, 1);
    assert.equal(loaded.samples.length, 1);
    assert.equal(loaded.samples[0].priceUsdE8, '180000');
    assert.equal(loaded.coverageSegments[0].rawSha256, sha256Hex(pollRaw));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A-09 反例复现：行情覆盖证明必须绑定可重放原始回包与完整分页，禁止 appendPoll 自声明空白区间，且主网禁止原始 candles 数组绕过', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'a9-oracle-strict-'));
  try {
    const stakeCloseAt = 1795700000;
    const obsEnd = stakeCloseAt + 43200;
    const anchor = [{ ts: stakeCloseAt - 60, priceUsdE8: '180000', txHash: '0x1' }];

    // 反例 1：MarketSampleArchive.appendPoll 仅凭自声明 start/end、缺少可重放原始回包与分页边界证明必须拒绝
    const arch = new MarketSampleArchive(join(dir, 'arch.json'), BASE_BINDING);
    assert.throws(
      () => arch.appendPoll({ start: stakeCloseAt, end: stakeCloseAt + 1800, fetchedAt: stakeCloseAt + 1800 }),
      /rawPayload|pagination/i,
    );

    // 反例 2a：coverageSegments 缺少 rawPayload 必须拒绝
    const missingRawSegs = makeCoverage(stakeCloseAt, obsEnd, BASE_BINDING, 1800, anchor).map(({ rawPayload: _r, ...rest }) => rest);
    assert.throws(
      () => buildSettlementInputBundle({
        roundId: 1,
        targetPriceUsdE8: '174000',
        stakeCloseAt,
        observationSeconds: 43200,
        candleCount: 12,
        coverageSegments: missingRawSegs,
        observedUntil: obsEnd,
        binding: BASE_BINDING,
      }),
      /rawPayload/i,
    );

    // 反例 2b：分页被截断（页满且 oldestTs > seg.start，可能漏采成交）必须拒绝
    const truncatedSamples = [
      { ts: stakeCloseAt + 1200, priceUsdE8: '180000', txHash: '0xt1' },
      { ts: stakeCloseAt + 1500, priceUsdE8: '181000', txHash: '0xt2' },
    ];
    const truncatedSegs = makeCoverage(stakeCloseAt, obsEnd, BASE_BINDING, 1800, anchor);
    truncatedSegs[1].rawPayload = makeProviderRawPayload(BASE_BINDING, truncatedSamples);
    truncatedSegs[1].rawSha256 = sha256Hex(truncatedSegs[1].rawPayload);
    // 故意设置 pageLimit=2，itemCount=2（满页），但 oldestTs = stakeCloseAt+1200 < seg[1].start? 不，seg[1].start = stakeCloseAt+1800，我们放 seg[1].start + 1200 使其 > seg[1].start
    const midSamples = [
      { ts: stakeCloseAt + 2400, priceUsdE8: '180000', txHash: '0xt3' },
      { ts: stakeCloseAt + 2700, priceUsdE8: '181000', txHash: '0xt4' },
    ];
    truncatedSegs[1].rawPayload = makeProviderRawPayload(BASE_BINDING, midSamples);
    truncatedSegs[1].rawSha256 = sha256Hex(truncatedSegs[1].rawPayload);
    truncatedSegs[1].pagination = {
      pageLimit: 2,
      pages: [{ pageIndex: 0, cursorIn: null, nextCursor: 'cursor_more', itemCount: 2, oldestTs: stakeCloseAt + 2400, newestTs: stakeCloseAt + 2700 }],
    };
    assert.throws(
      () => buildSettlementInputBundle({
        roundId: 1,
        targetPriceUsdE8: '174000',
        stakeCloseAt,
        observationSeconds: 43200,
        candleCount: 12,
        coverageSegments: truncatedSegs,
        observedUntil: obsEnd,
        binding: BASE_BINDING,
      }),
      /truncated before segment start|missed trades/i,
    );

    // 反例 2c：rawSha256 与 rawPayload 不符必须拒绝
    const badHashSegs = makeCoverage(stakeCloseAt, obsEnd, BASE_BINDING, 1800, anchor);
    badHashSegs[0].rawSha256 = '0x' + 'ff'.repeat(32);
    assert.throws(
      () => buildSettlementInputBundle({
        roundId: 1,
        targetPriceUsdE8: '174000',
        stakeCloseAt,
        observationSeconds: 43200,
        candleCount: 12,
        coverageSegments: badHashSegs,
        observedUntil: obsEnd,
        binding: BASE_BINDING,
      }),
      /rawSha256 mismatch/i,
    );

    // 反例 3：主网 round-ops settle-round 传入原始 candles 数组必须被拒绝，不能绕过！
    const rawCandles = Array.from({ length: 12 }, (_, i) => ({
      start: stakeCloseAt + i * 3600,
      end: stakeCloseAt + (i + 1) * 3600,
      twapUsdE8: '180000',
    }));
    const rawCandlesPath = join(dir, 'raw-candles.json');
    writeFileSync(rawCandlesPath, JSON.stringify(rawCandles), 'utf8');
    const bypassRes = spawnSync(
      'node',
      ['ops/scripts/round-ops.mjs', '--profile', 'mainnet', '--action', 'settle-round', '--round', '1', '--target', '174000', '--stake-close-at', String(stakeCloseAt), '--candles-file', rawCandlesPath, '--offline'],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          A9_MARKET_POOL_ADDRESS: MAINNET_POOL,
          A9_JETTON_MASTER_ADDRESS: MAINNET_A9_MASTER,
        },
      },
    );
    assert.notEqual(bypassRes.status, 0);
    assert.match(bypassRes.stderr, /raw candles array.*forbidden|verified market settlement input bundle/i);

    // 测试网隔离兼容路径仍可正常运行原始 candles 数组
    const testnetCompatRes = spawnSync(
      'node',
      ['ops/scripts/round-ops.mjs', '--profile', 'testnet', '--action', 'settle-round', '--round', '1', '--target', '174000', '--stake-close-at', String(stakeCloseAt), '--candles-file', rawCandlesPath, '--offline'],
      { encoding: 'utf8', env: { PATH: process.env.PATH } },
    );
    assert.equal(testnetCompatRes.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A-10 证据链反例复现：rawPayload 为无关对象/错结构/错池代币/价格与 samples 不一致时 build 与 verify（含 CLI）均必须失败，并验证脱敏真实提供方夹具', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'a9-oracle-chain-'));
  try {
    const stakeCloseAt = 1795700000;
    const obsEnd = stakeCloseAt + 43200;
    const anchor = [{ ts: stakeCloseAt - 60, priceUsdE8: '180000', txHash: '0x1' }];

    // 1) rawPayload 为无关对象 -> build 失败
    const unrelatedSegs = makeCoverage(stakeCloseAt, obsEnd, BASE_BINDING, 1800, anchor).map((seg) => {
      const rawPayload = { unrelated: true, note: 'not a provider response' };
      return { ...seg, rawPayload, rawSha256: sha256Hex(rawPayload) };
    });
    assert.throws(
      () => buildSettlementInputBundle({
        roundId: 1, targetPriceUsdE8: '174000', stakeCloseAt, observationSeconds: 43200, candleCount: 12,
        coverageSegments: unrelatedSegs, observedUntil: obsEnd, binding: BASE_BINDING,
      }),
      /poolMetadata|trades|provider/i,
    );

    // 2) rawPayload 为错误池/代币 -> build 失败
    const wrongPoolSegs = makeCoverage(stakeCloseAt, obsEnd, BASE_BINDING, 1800, anchor);
    wrongPoolSegs[0].rawPayload.poolMetadata.pool.token0_address = MAINNET_QUOTE_TON;
    wrongPoolSegs[0].rawSha256 = sha256Hex(wrongPoolSegs[0].rawPayload);
    assert.throws(
      () => buildSettlementInputBundle({
        roundId: 1, targetPriceUsdE8: '174000', stakeCloseAt, observationSeconds: 43200, candleCount: 12,
        coverageSegments: wrongPoolSegs, observedUntil: obsEnd, binding: BASE_BINDING,
      }),
      /does not contain A9 JettonMaster/i,
    );

    // 3) rawPayload 中成交价格与独立传入 samples 不一致 -> build 失败
    const realSamples = [{ ts: stakeCloseAt - 60, priceUsdE8: '100000', txHash: '0xreal1' }];
    const decoupledSegs = makeCoverage(stakeCloseAt, obsEnd, BASE_BINDING, 1800, realSamples);
    assert.throws(
      () => buildSettlementInputBundle({
        roundId: 1, targetPriceUsdE8: '174000', stakeCloseAt, observationSeconds: 43200, candleCount: 12,
        samples: [{ ts: stakeCloseAt - 60, priceUsdE8: '250000', txHash: '0xreal1' }],
        coverageSegments: decoupledSegs, observedUntil: obsEnd, binding: BASE_BINDING,
      }),
      /SAMPLES_EVIDENCE_MISMATCH/i,
    );

    // 4) 合法构建后篡改输入包中的 samples（即使重算 outputSha256 仍与 rawPayload 脱钩）-> verify-settle CLI 必须失败
    const validBundle = buildSettlementInputBundle({
      roundId: 1, targetPriceUsdE8: '174000', stakeCloseAt, observationSeconds: 43200, candleCount: 12,
      coverageSegments: makeCoverage(stakeCloseAt, obsEnd, BASE_BINDING, 1800, anchor),
      observedUntil: obsEnd, binding: BASE_BINDING,
    });
    const forgedBundle = structuredClone(validBundle);
    forgedBundle.samples[0].priceUsdE8 = '999999';
    const forgedPath = join(dir, 'forged-bundle.json');
    writeFileSync(forgedPath, JSON.stringify(forgedBundle), 'utf8');
    const cliVerifyBad = spawnSync(
      'node',
      ['ops/scripts/market-feed.mjs', '--action', 'verify-settle', '--profile', 'mainnet', '--input', forgedPath],
      { encoding: 'utf8' },
    );
    assert.notEqual(cliVerifyBad.status, 0);
    assert.match(cliVerifyBad.stderr, /SAMPLES_EVIDENCE_MISMATCH/i);

    // 5) 脱敏真实提供方夹具端到端构建与重放验真（包含无成交片段与真实成交片段）
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/market-provider-sanitized-fixture.json', import.meta.url), 'utf8'));
    const fixtureStart = Math.floor(Date.parse('2026-11-27T01:30:00Z') / 1000);
    const fixtureObsEnd = fixtureStart + 43200;
    const fixtureSegs = makeCoverage(fixtureStart, fixtureObsEnd, fixture.binding, 1800, []);
    // 首段注入脱敏真实回包（含 2 笔真实结构成交），其余 23 段为已证明无成交片段（noTrades=true）
    fixtureSegs[0].rawPayload = { poolMetadata: fixture.poolMetadata, trades: fixture.trades };
    fixtureSegs[0].rawSha256 = sha256Hex(fixtureSegs[0].rawPayload);
    fixtureSegs[0].pagination = {
      pageLimit: 100,
      pages: [{
        pageIndex: 0,
        cursorIn: null,
        nextCursor: null,
        itemCount: 2,
        oldestTs: Math.floor(Date.parse('2026-11-27T01:00:00Z') / 1000),
        newestTs: Math.floor(Date.parse('2026-11-27T01:30:00Z') / 1000),
      }],
    };
    const fixtureBundle = buildSettlementInputBundle({
      roundId: 1,
      targetPriceUsdE8: '174000',
      stakeCloseAt: fixtureStart,
      observationSeconds: 43200,
      candleCount: 12,
      coverageSegments: fixtureSegs,
      observedUntil: fixtureObsEnd,
      binding: fixture.binding,
    });
    assert.equal(fixtureBundle.qualifiedCandles, 12);
    assert.equal(fixtureBundle.coverageSegments[0].noTrades, false);
    assert.equal(fixtureBundle.coverageSegments[1].noTrades, true);
    const verifiedFixture = verifySettlementInputBundle(fixtureBundle, fixture.binding);
    assert.equal(verifiedFixture.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
