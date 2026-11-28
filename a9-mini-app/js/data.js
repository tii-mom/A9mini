/**
 * 只读数据层：复用 BAM 的 API 契约 / 类型口径 / 焦点轮选择逻辑
 *
 * BAM 版本（对接记录）：见 config.js 的 BAM_SOURCE。
 * 真实模式只读取 /api/config、/api/rounds、/api/rounds/:id：服务端状态 + 时间戳驱动
 * 轮次阶段、倒计时、目标价、判定均价与达标时段；前端不再用本地随机数推演这些值。
 * 演示模式返回 js/demo-data.js 中明确标识的测试数据，页面顶部会显示来源标记。
 */

import { config, apiUrl } from './config.js';
import { loadDemoModule } from './demo-loader.js';
import { A9TMA } from './tma.js';
import { L } from './i18n.js';

/** v17.0 涨价解锁（Price-Unlock）唯一前端展示口径常量源（Single Source of Truth） */
export const PROTOCOL_SPECS = Object.freeze({
  version: 'v17.0',
  referralPct: 6,
  stakeReferralPct: 8,
  chestBoostMinPct: 0,
  chestBoostMaxPct: 66.7,
  deliveryFeeGram: 0.06,
  refundGasGram: 0.03,
  stakeGasGram: 0.30,
  claimGasGram: 0.22,
  dualClaimGasGram: 0.34,
  minStakeA9: 100,
  maxRewardMultiplier: 5,
  lockHours: 24,
  first6hHours: 6,
  pushHours: 12,
  passRequired: 8,
  passTotal: 12,
  corridorMinPct: 30,
  corridorMaxPct: 100,
  immediateUnlockPct: 20,
  linearVestingDays: 14,
  dailyUnlockPct: 5.71,
  failEarlyStopLossPct: 5,
  failLateStopLossPct: 10,
  earlyExitBurnPct: 15,
  instantCashoutPct: 30,
  instantCashoutBurnPct: 70,
  promoCapA9: 550_000_000,
  totalSupplyA9: 10_000_000_000,
  rewardPoolA9: 7_000_000_000,
  abortTimeoutDays: 7,
});

/** 与 A9mini/worker 后端契约保持一致的统一端点表。 */
export const ENDPOINTS = Object.freeze({
  health: '/api/health',
  config: '/api/config',
  rounds: '/api/rounds',
  round: (id) => `/api/rounds/${id}`,
  promoIntent: '/api/promo/intent',
  promoClaim: (id) => `/api/promo/claim/${id}`,
  promoBalance: (addr) => `/api/promo/balance/${encodeURIComponent(addr)}`,
  predictionBet: '/api/prediction/bet',
  predictionRound: (id) => `/api/prediction/round/${encodeURIComponent(id)}`,
  predictionUser: (userId, roundId) => `/api/prediction/user/${encodeURIComponent(userId)}${roundId !== undefined && roundId !== null ? `?roundId=${encodeURIComponent(roundId)}` : ''}`,
  predictionActivate: '/api/prediction/activate',
  progressionMe: (roundId) => `/api/progression/me${roundId !== undefined && roundId !== null ? `?roundId=${encodeURIComponent(roundId)}` : ''}`,
  progressionClaim: '/api/progression/claim',
  userProfile: (wallet, { fromRound = null, toRound = null } = {}) => {
    const qs = new URLSearchParams();
    if (fromRound !== null && fromRound !== undefined) qs.set('fromRound', String(fromRound));
    if (toRound !== null && toRound !== undefined) qs.set('toRound', String(toRound));
    const q = qs.toString();
    return `/api/user/${encodeURIComponent(wallet)}${q ? `?${q}` : ''}`;
  },
  presaleIntent: '/api/presale/intent',
  presaleQuota: (addr) => `/api/presale/quota/${encodeURIComponent(addr)}`,
  presaleOrders: (addr) => `/api/presale/orders/${encodeURIComponent(addr)}`,
  warmupCurrent: (roundId = null) => `/api/warmup/current${roundId ? `?roundId=${encodeURIComponent(roundId)}` : ''}`,
  warmupRegister: '/api/warmup/register',
  warmupCancel: '/api/warmup/cancel',
  warmupLeaderboard: '/api/warmup/leaderboard',
  teamByWallet: wallet => `/api/team/${encodeURIComponent(wallet)}`,
  teamJoin: '/api/team/join',
  teamBindTg: '/api/team/bind-tg',
  teamVerifyTg: '/api/team/verify-tg',
  referralAttribution: '/api/referral/attribution',
  chestsMe: '/api/chests/me',
  chestsStarter: '/api/chests/starter',
  chestDetail: (id) => `/api/chests/${encodeURIComponent(id)}`,
  chestAssist: (id) => `/api/chests/${encodeURIComponent(id)}/assist`,
  chestOpen: (id) => `/api/chests/${encodeURIComponent(id)}/open`,
  chestsOpenAll: '/api/chests/open-all',
  chestsCritFeed: (limit = 12) => `/api/chests/crit-feed?limit=${encodeURIComponent(limit)}`,
  v17StakeReferralMe: (limit = 50) => `/api/v17/stake-referral/me?limit=${encodeURIComponent(limit)}`,
  v17AirdropDraws: ({ roundId = null, limit = 10 } = {}) => {
    const qs = new URLSearchParams();
    if (roundId !== null && roundId !== undefined) qs.set('roundId', String(roundId));
    if (limit !== null && limit !== undefined) qs.set('limit', String(limit));
    const q = qs.toString();
    return `/api/v17/airdrop/draws${q ? `?${q}` : ''}`;
  },
  me: '/api/me',
  meNotifications: '/api/me/notifications',
  tonProofPayload: '/api/auth/ton-proof/payload',
  tonProofVerify: '/api/auth/ton-proof/verify'
});

export class ApiError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

let serverClockOffsetMs = 0;

/** 返回经服务端信封 ts 校偏后的当前毫秒时间戳，抗客户端设备时钟偏差与后台休眠。 */
export function serverNowMs() {
  return Date.now() + serverClockOffsetMs;
}

/** 飞行中请求去重（仅限只读请求） */
const inflightRequests = new Map();

/** 生成请求去重键：纳入路径、方法、认证身份、有效头与超时 */
function makeRequestKey(path, method, initData, extraHeaders, timeoutMs) {
  const headers = Object.entries(extraHeaders || {}).map(([key, value]) => [key.toLowerCase(), String(value)]).sort(([a], [b]) => a.localeCompare(b));
  // This key stays in memory only; never log it or persist authentication data.
  return JSON.stringify([config.isDemo, config.network, apiUrl(path), method, initData, timeoutMs, headers]);
}

/** BAM ApiResponse<T> 信封：{ ok, data, ts } | { ok:false, error:{code,message} } */
async function request(path, { timeoutMs = config.timeoutMs, method = 'GET', body: payload, headers: extraHeaders = null } = {}) {
  // 只读请求去重：同一路径、方法、身份、头、超时在途时复用 Promise
  const initData = config.isDemo ? '' : A9TMA.getRawInitData();
  const isReadOnly = payload === undefined && (method === 'GET' || method === 'HEAD');
  const requestKey = isReadOnly ? makeRequestKey(path, method, initData, extraHeaders, timeoutMs) : null;

  if (isReadOnly && requestKey && inflightRequests.has(requestKey)) {
    return inflightRequests.get(requestKey);
  }

  // apiBase 为空表示同源（本地 dev-server 已把 /api/* 代理到 BAM worker），不是配置缺失。
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  const executeRequest = async () => {
    try {
      const init = { method, signal: controller.signal, credentials: 'same-origin', headers: { ...(extraHeaders || {}) } };
      if (payload !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(payload);
      }
      // 真实模式：附带 Telegram 原始 initData，由服务端验签确定用户身份（P0-1）。
      // 演示模式永不附带，演示身份不能冒充已认证用户。
      if (initData) init.headers.authorization = `tma ${initData}`;
      const res = await fetch(apiUrl(path), init);
      let body;
      try {
        body = await res.json();
      } catch (_) {
        throw new ApiError('BAD_RESPONSE', L(`接口返回非 JSON（HTTP ${res.status}）`, `Non-JSON API response (HTTP ${res.status})`), res.status);
      }
      if (!body || typeof body !== 'object' || !('ok' in body)) {
        throw new ApiError('BAD_RESPONSE', L('接口返回格式错误', 'Malformed API response'), res.status);
      }
      if (typeof body.ts === 'number' && Number.isFinite(body.ts) && body.ts > 1_000_000_000_000) {
        serverClockOffsetMs = body.ts - Date.now();
      }
      if (!body.ok) throw new ApiError(body.error?.code || 'API_ERROR', body.error?.message || L('接口返回错误', 'API error'), res.status);
      return body.data;
    } catch (e) {
      if (timedOut) throw new ApiError('NETWORK', L('请求超时，请重试', 'Request timed out; please retry'), 408);
      if (e instanceof ApiError) throw e;
      throw new ApiError('NETWORK', L('网络异常或接口不可达，请重试', 'Network error or API unreachable; please retry'), 0);
    } finally {
      clearTimeout(timer);
    }
  };

  const promise = executeRequest();

  // 只读请求缓存飞行中 Promise，捕获 rejection 避免未处理错误
  if (isReadOnly && requestKey) {
    inflightRequests.set(requestKey, promise);
    promise.then(() => {
      if (inflightRequests.get(requestKey) === promise) inflightRequests.delete(requestKey);
    }, () => {
      // 失败或完成后清理，允许重试
      inflightRequests.delete(requestKey);
    });
  }

  return promise;
}

/** 焦点轮：进行中最高轮 → 最近已开启轮 → 第一轮（与 BAM buildRoundDetail/focusRound 一致）。 */
function pickFocusRound(rounds) {
  const list = Array.isArray(rounds) ? rounds : [];
  const opened = list.filter(r => r.state !== 'UNOPENED');
  const active = opened.filter(r => ['STAKING_OPEN', 'STAKING_CLOSED', 'OBSERVING', 'ORACLE_PAUSED', 'SETTLING_SUCCESS', 'SETTLING_FAILURE'].includes(r.state));
  if (active.length) return active[active.length - 1];
  if (opened.length) return opened[opened.length - 1];
  return list[0] || null;
}

let lastGoodSnapshot = null;
let currentView = null;

/** 读取内存中的最近一次成功快照（绝不使用 sessionStorage/localStorage 持久化）。 */
export function getLastGoodSnapshot() {
  return lastGoodSnapshot;
}

/** 读取只读快照。先并发拉取 config + rounds 并可选通过 onPartial 先行渲染，再补齐当前轮详情 detail；失败时保留内存 lastGoodSnapshot 并标记 stale。 */
export async function loadSnapshot({ onPartial } = {}) {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    const fixture = demo.demoFixture();
    lastGoodSnapshot = fixture;
    return fixture;
  }

  try {
    const [protocolConfig, rounds] = await Promise.all([
      request(ENDPOINTS.config),
      request(ENDPOINTS.rounds)
    ]);
    if (!protocolConfig || !Array.isArray(rounds)) {
      throw new ApiError('BAD_RESPONSE', L('接口返回配置或轮次格式错误', 'Invalid protocol config or rounds response'));
    }
    const focus = pickFocusRound(rounds);
    // 轮次尚未开启（/api/config 正常、/api/rounds 为空）时允许进入只读广场与宝箱商城；
    // detail 置 null，由各页面明确显示“待确认”，绝不伪造任何轮次或价格数据。
    if (!focus) {
      const snapshot = {
        source: 'api',
        label: L('实时数据', 'Live'),
        fetchedAt: Date.now(),
        config: protocolConfig,
        rounds,
        detail: null,
        stale: false,
        partial: false,
      };
      lastGoodSnapshot = snapshot;
      return snapshot;
    }

    const partialSnapshot = {
      source: 'api',
      label: L('实时数据', 'Live'),
      fetchedAt: Date.now(),
      config: protocolConfig,
      rounds,
      detail: focus,
      stale: false,
      partial: true,
    };
    if (typeof onPartial === 'function') {
      try { onPartial(partialSnapshot); } catch (_) {}
    }

    let detail = null;
    try {
      detail = await request(ENDPOINTS.round(focus.roundId));
    } catch (detailError) {
      if (lastGoodSnapshot && Number(lastGoodSnapshot.detail?.roundId) === Number(focus.roundId)) {
        return {
          ...lastGoodSnapshot,
          config: protocolConfig,
          rounds,
          stale: true,
          detailStale: true,
          staleReason: detailError?.message || '',
          error: detailError,
        };
      }
      const fallbackPartial = {
        ...partialSnapshot,
        partial: false,
        stale: true,
        detailStale: true,
        staleReason: detailError?.message || '',
        error: detailError,
      };
      lastGoodSnapshot = fallbackPartial;
      return fallbackPartial;
    }

    const snapshot = {
      source: 'api',
      label: L('实时数据', 'Live'),
      fetchedAt: Date.now(),
      config: protocolConfig,
      rounds,
      detail,
      stale: false,
      partial: false,
    };
    lastGoodSnapshot = snapshot;
    return snapshot;
  } catch (error) {
    if (lastGoodSnapshot) {
      return { ...lastGoodSnapshot, stale: true, staleReason: error.message, error };
    }
    throw error;
  }
}

/** USD_E8 → USD number。无效值或 0 返回 null，绝不能把 0 当成真实价格展示。 */
export function e8ToUsd(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 1e8;
}

/** raw（9 位精度）→ A9 数值，仅展示用。 */
export function rawToA9(raw, decimals = 9) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n / Math.pow(10, decimals);
}

const STAGE_BY_STATE = {
  UNOPENED: 'warmup',
  STAKING_OPEN: 'participation',
  STAKING_CLOSED: 'participation',
  OBSERVING: 'observation',
  ORACLE_PAUSED: 'observation',
  SETTLING_SUCCESS: 'observation',
  SUCCEEDED: 'settlement_success',
  SETTLING_FAILURE: 'observation',
  FAILED_PERMANENT: 'settlement_burn',
  TECHNICAL_ABORTED: 'halted'
};

/** BAM RoundDetail → a9mini 首页视图模型。服务端值优先，缺失值用 null（UI 显示明确状态）。 */
export function mapRoundView(snapshot) {
  const d = snapshot.detail || {};
  const c = snapshot.config || {};
  const decimals = c.token?.decimals ?? 9;
  const candleCount = c.candleCount || 12;
  const minQualified = c.minQualifiedCandles || 8;
  const target = d.targetLocked === false ? null : e8ToUsd(d.targetPriceUsdE8);
  const judgePrice = d.priceValid === false ? null : e8ToUsd(d.priceUsdE8);
  const finiteNonNegIntOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const seen = finiteNonNegIntOrNull(d.candlesSeen);
  const confirmed = Array.isArray(d.candles) ? d.candles.length : seen;
  const qualified = Number.isInteger(d.qualifiedCandles) && d.qualifiedCandles >= 0 && d.qualifiedCandles <= candleCount ? d.qualifiedCandles : null;
  const liveIndex = d.state === 'OBSERVING' && d.live?.candleIndex != null ? Number(d.live.candleIndex) : -1;
  const toMillis = value => Number(value) > 0 ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : null;
  const slotMs = Number(c.candleSeconds ?? 3600) * 1000;
  const observationStart = toMillis(d.observationStart ?? d.stakeCloseAt);
  const activeCandleEndAt = Number.isInteger(liveIndex) && liveIndex >= 0 && liveIndex < candleCount
    ? (toMillis(d.live?.periodEnd) ?? (observationStart && slotMs > 0 ? observationStart + (liveIndex + 1) * slotMs : null))
    : null;
  const livePrice = d.live ? e8ToUsd(d.live.twapPriceUsdE8) : judgePrice;

  const confirmedMap = new Map(
    (d.candles || []).map(x => [Number(x.candleIndex), {
      index: Number(x.candleIndex) + 1,
      status: typeof x.qualified === 'boolean' ? 'closed' : 'unknown',
      confirmed: typeof x.qualified === 'boolean',
      bull: typeof x.qualified === 'boolean' ? x.qualified : null,
      p: e8ToUsd(x.twapPriceUsdE8),
      coverageBps: x.coverageBps,
      digest: x.dataDigest
    }])
  );

  const periodEnded = ['SUCCEEDED','FAILED_PERMANENT','TECHNICAL_ABORTED','SETTLING_SUCCESS','SETTLING_FAILURE'].includes(d.state);
  const candles = [];
  for (let i = 0; i < candleCount; i++) {
    if (confirmedMap.has(i)) {
      candles.push(confirmedMap.get(i));
    } else if (i === liveIndex) {
      candles.push({
        index: i + 1,
        status: 'active',
        confirmed: false,
        tentative: true,
        bull: Boolean(d.live?.qualifiedTentative),
        p: livePrice,
        progressBps: Number(d.live?.progressBps) || 0
      });
    } else {
      const missing = !Array.isArray(d.candles) || periodEnded || (seen !== null && i < seen) ||
        (d.state === 'OBSERVING' && (liveIndex < 0 || i < liveIndex));
      candles.push({ index: i + 1, status: missing ? 'unknown' : 'pending', confirmed: false, bull: null, p: null });
    }
  }

  const view = {
    stage: STAGE_BY_STATE[d.state] || null,
    rawState: d.state || null,
    currentRound: Number(d.roundId) || null,
    openEnded: c.openEnded !== false,
    totalRounds: c.openEnded !== false ? null : (Number(c.roundCount) || null),
    targetPrice: target,
    twap24h: judgePrice,
    livePrice: livePrice ?? judgePrice,
    priceValid: d.priceValid !== false,
    priceChangePct: null,
    stakeOpenAt: d.stakeOpenAt ?? null,
    stakeCloseAt: d.stakeCloseAt ?? null,
    earlyCloseAt: d.earlyCloseAt ?? (d.stakeOpenAt ? Number(d.stakeOpenAt) + Number(d.earlyWindowSeconds || c.earlyWindowSeconds || 21600) : null),
    earlyWindowSeconds: Number(d.earlyWindowSeconds || c.earlyWindowSeconds || 21600),
    inFirst6h: Boolean(d.inFirst6h),
    earlySecondsRemaining: finiteNonNegIntOrNull(d.earlySecondsRemaining),
    earlyStakeRaw: d.earlyStakeRaw ?? null,
    countdownSec: d.secondsRemaining === null || d.secondsRemaining === undefined ? null : Number(d.secondsRemaining),
    nextState: d.nextState || null,
    candlesSeen: seen,
    candlesConfirmed: confirmed,
    qualifiedCandles: qualified,
    minQualifiedCandles: minQualified,
    needMore: qualified === null ? null : Math.max(0, minQualified - qualified),
    candles,
    activeCandleEndAt,
    activeCandleSec: activeCandleEndAt ? Math.max(0, Math.ceil((activeCandleEndAt - serverNowMs()) / 1000)) : null,
    rewardBudgetRaw: d.rewardBudgetRaw ?? null,
    nextRoundCarryRaw: c.poolState?.dataAvailable === true && Number(c.poolState.currentRoundId) === Number(d.roundId)
      ? (c.poolState.carryRaw ?? null) : null,
    rewardBudgetA9: rawToA9(d.rewardBudgetRaw, decimals),
    totalStakedRaw: d.totalAcceptedStakeRaw ?? null,
    totalWeightRaw: d.totalWeightRaw ?? null,
    stakerCount: finiteNonNegIntOrNull(d.stakerCount ?? d.entryCount),
    entryCount: finiteNonNegIntOrNull(d.entryCount),
    successCount: Number.isInteger(c.poolState?.successCount) ? c.poolState.successCount : null,
    unlock: d.unlock || null,
    poolState: c.poolState || null,
    promoHotWallet: c.promoHotWallet || null,
    chestMall: c.chestMall || null,
    protocolConfig: c,
    result: d.result || null,
    updatedAt: d.updatedAt ?? c.syncedAt ?? null,
    source: snapshot.source,
    sourceLabel: snapshot.label,
    fetchedAt: snapshot.fetchedAt,
    stale: Boolean(snapshot.stale),
    detailLoading: Boolean(snapshot.partial),
    detailStale: Boolean(snapshot.detailStale),
    staleReason: snapshot.staleReason || null,
    stakingEnabled: Boolean(c.contracts?.stakingEnabled),
    rounds: Array.isArray(snapshot.rounds) ? snapshot.rounds : [],
  };
  currentView = view;
  return view;
}

function assertFundsAllowedInMode() {
  if (!config.isDemo && !config.liveFundsEnabled) {
    throw new ApiError(
      'LIVE_FUNDS_DISABLED',
      L('当前真实模式处于只读验收阶段，资金订单与钱包交易暂未开放', 'Live mode is currently read-only; fund orders and wallet signing are disabled')
    );
  }
}

/** 请求生成推广奖励 0.06 GRAM 领奖单（live 只读阶段统一拦截，不发网络订单请求）。 */
export async function requestPromoClaimIntent(walletAddress) {
  assertFundsAllowedInMode();
  return request(ENDPOINTS.promoIntent, {
    method: 'POST',
    body: { walletAddress }
  });
}

/** 查询当前钱包的推广可领余额（真实只读接口）。 */
export async function fetchPromoBalance(walletAddress) {
  if (!walletAddress) return null;
  return request(ENDPOINTS.promoBalance(walletAddress));
}

/** 查询单笔推广领奖单状态（轮询热钱包自动出账进度）。 */
export async function fetchPromoClaim(claimId) {
  if (!claimId) return null;
  return request(ENDPOINTS.promoClaim(claimId));
}

/** 查询当前钱包的宝箱商城/固定兑换额度（真实只读接口）。 */
export async function fetchPresaleQuota(walletAddress) {
  if (!walletAddress) return null;
  return request(ENDPOINTS.presaleQuota(walletAddress));
}

/** 查询当前钱包的宝箱商城/固定兑换订单与退款明细（真实只读接口）。 */
export async function fetchPresaleOrders(walletAddress) {
  if (!walletAddress) return [];
  return request(ENDPOINTS.presaleOrders(walletAddress));
}

/**
 * 解析可用于预言局与推荐归因的真实用户 ID：
 * - live 模式下：仅允许真实 Telegram initData userId 或已连接钱包地址；两者均无时返回 null（绝不使用假 ID 4402919）。
 * - demo 模式下：允许使用 demo_user_01。
 */
export function getEffectiveUserId(user) {
  const realTgUser = A9TMA.getRealTelegramUser();
  // 真实模式：服务端只认可已验签的 Telegram 用户；钱包地址不再充当用户 ID。
  if (!config.isDemo) return realTgUser?.id ? String(realTgUser.id) : null;
  if (realTgUser?.id) return String(realTgUser.id);
  if (user?.connected && user?.address) return String(user.address);
  return 'demo_user_01';
}

/** 当前 Telegram 身份与服务端确认的钱包绑定（真实模式；演示模式返回 null）。 */
export async function fetchMe() {
  if (config.isDemo || !A9TMA.getRawInitData()) return null;
  return request(ENDPOINTS.me);
}

/** TON Connect ton_proof：向服务端申请一次性签名载荷。 */
export async function requestTonProofPayload() {
  return request(ENDPOINTS.tonProofPayload, { method: 'POST', body: {} });
}

/**
 * TON Connect ton_proof：提交钱包签名，由服务端验证地址、网络、StateInit、公钥与签名。
 * purpose: 'bind'（绑定 / 申请换绑）| 'unbind'（解除绑定，需当前钱包签名）| 'cancel_rebind'。
 * 注意：前端断开钱包连接不会解除服务端长期绑定。
 */
export async function submitTonProof({ address, network, publicKey, walletStateInit, proof, purpose = 'bind' }) {
  return request(ENDPOINTS.tonProofVerify, { method: 'POST', body: { address, network, publicKey, walletStateInit, proof, purpose } });
}

/** 12H 预言擂台：读取本轮多空实时比例 */
export async function fetchPredictionRound(roundId, stage = 'observation') {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    return demo.demoPredictionRound(roundId, stage);
  }
  return request(ENDPOINTS.predictionRound(roundId));
}

/** 12H 预言擂台：读取当前用户本轮下注与待激活奖励 */
export async function fetchPredictionUser(userId, roundId) {
  if (!userId) return { userId: null, pendingActivationRaw: '0', activatedRaw: '0', currentBet: null };
  if (config.isDemo) {
    const demo = await loadDemoModule();
    return demo.demoPredictionUser(userId, roundId);
  }
  return request(ENDPOINTS.predictionUser(userId, roundId));
}

/** 12H 预言擂台：提交单轮多空预言（0 GRAM 参战） */
export async function submitPredictionBet({ roundId, userId, side, guessSlots, referrerId }) {
  if (!userId) throw new ApiError('IDENTITY_REQUIRED', L('请在 Telegram 内打开或先连接 TON 钱包后再提交预言', 'Open inside Telegram or connect a TON wallet before predicting'));
  if (config.isDemo) {
    const demo = await loadDemoModule();
    try {
      return demo.demoPredictionBet({ roundId, userId, side, guessSlots, referrerId });
    } catch (e) {
      throw new ApiError('DEMO_BET_ERR', e.message);
    }
  }
  const payload = { roundId: Number(roundId), userId: String(userId), side };
  if (guessSlots !== null && guessSlots !== undefined && guessSlots !== '') {
    payload.guessSlots = Math.max(0, Math.min(12, Math.floor(Number(guessSlots))));
  }
  if (referrerId) payload.referrerId = String(referrerId);
  return request(ENDPOINTS.predictionBet, { method: 'POST', body: payload });
}

/** 12H 预言擂台：激活待激活预言奖励到 promo_balances（live 只读阶段拦截，实盘态附带幂等键） */
export async function activatePredictionReward(userId, walletAddress, activationId = null) {
  if (!userId) throw new ApiError('IDENTITY_REQUIRED', L('请在 Telegram 内打开或先连接 TON 钱包', 'Open inside Telegram or connect a TON wallet'));
  if (!walletAddress) throw new ApiError('WALLET_REQUIRED', L('请先连接 TON 钱包以激活奖励', 'Connect a TON wallet to activate rewards'));
  if (config.isDemo) {
    const demo = await loadDemoModule();
    try {
      return demo.demoPredictionActivate(userId, walletAddress);
    } catch (e) {
      throw new ApiError('DEMO_ACTIVATE_ERR', e.message);
    }
  }
  assertFundsAllowedInMode();
  const idemKey = activationId || `act:${userId}:${Date.now()}`;
  return request(ENDPOINTS.predictionActivate, {
    method: 'POST',
    headers: { 'x-idempotency-key': idemKey },
    body: { userId: String(userId), walletAddress: String(walletAddress), activationId: idemKey }
  });
}

/** 阶段三：每日集章成长进度读取（非金融成长数据） */
export async function fetchProgressionUser(userId, roundId = null) {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    return demo.demoProgressionUser(userId || 'demo_user_01', roundId);
  }
  if (!A9TMA.getRawInitData()) return null;
  return request(ENDPOINTS.progressionMe(roundId));
}

/** 阶段三：每日集章任务与成就领取（服务端幂等防重领） */
export async function claimProgressionTask({ userId, taskKey, roundId = null }) {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    try {
      return demo.demoProgressionClaim({ userId: userId || 'demo_user_01', taskKey, roundId });
    } catch (e) {
      throw new ApiError('DEMO_CLAIM_ERR', e.message);
    }
  }
  if (!A9TMA.getRawInitData()) {
    throw new ApiError('IDENTITY_REQUIRED', L('请在 Telegram 小程序内打开以完成每日打卡盖章', 'Open inside Telegram Mini App for daily check-in'));
  }
  return request(ENDPOINTS.progressionClaim, {
    method: 'POST',
    body: { taskKey: String(taskKey), roundId: roundId ? Number(roundId) : null }
  });
}

/** 全链路归因辅助：仅当 referrerId 非空时附加到请求体 */
function withReferrer(body, referrerId) {
  const clean = String(referrerId || '').trim();
  return clean ? { ...body, referrerId: clean } : body;
}

/** 统一规范化 /api/warmup/current 返回结构（严守 P0-G：未知/缺失字段严格保留 null，绝不伪造 0 或硬编码 2-5 阶梯） */
export function normalizeWarmupCurrent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cfg = raw.config && typeof raw.config === 'object' ? raw.config : {};
  const st = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  const optNonNegNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const optFiniteNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const roundId = optFiniteNum(raw.roundId ?? cfg.roundId ?? st.roundId);
  const totalRegistered = optNonNegNum(st.totalRegistered);
  const targetUsers = optNonNegNum(cfg.targetUsers);
  const progressPct = (totalRegistered !== null && targetUsers !== null && targetUsers > 0)
    ? Math.max(0, Math.min(100, Math.round((totalRegistered / targetUsers) * 100)))
    : null;
  const chest = raw.myWarmupChest || null;
  let chestTotalA9Raw = null;
  if (chest) {
    try {
      chestTotalA9Raw = (BigInt(String(chest.baseA9Raw || '0')) + BigInt(String(chest.boostA9Raw || '0'))).toString();
    } catch (_) {
      chestTotalA9Raw = typeof chest.baseA9Raw === 'string' ? chest.baseA9Raw : null;
    }
  }
  const openAtRaw = optFiniteNum(cfg.plannedOpenAt ?? cfg.plannedOpenAtMs);
  const plannedOpenAtMs = openAtRaw !== null && openAtRaw > 0
    ? (openAtRaw < 1e12 ? openAtRaw * 1000 : openAtRaw)
    : null;
  return {
    roundId: roundId !== null && roundId >= 1 ? roundId : null,
    currentOnchainRoundId: optFiniteNum(raw.currentOnchainRoundId),
    open: Boolean(raw.open ?? true) && String(cfg.status || 'OPEN') === 'OPEN',
    config: {
      ...cfg,
      roundId: roundId !== null && roundId >= 1 ? roundId : null,
      status: String(cfg.status || 'OPEN'),
      targetUsers,
      plannedOpenAt: openAtRaw !== null && openAtRaw > 0 ? openAtRaw : null,
      plannedOpenAtMs,
      chestMinInvites: optFiniteNum(cfg.chestMinInvites),
      chestMaxInvites: optFiniteNum(cfg.chestMaxInvites),
    },
    stats: {
      roundId: roundId !== null && roundId >= 1 ? roundId : null,
      totalRegistered,
      walletBoundCount: optNonNegNum(st.walletBoundCount),
      activeWalletCount: optNonNegNum(st.activeWalletCount),
      remindEnabledCount: optNonNegNum(st.remindEnabledCount),
      targetUsers,
      progressPct,
    },
    myReservation: raw.myReservation || null,
    isReserved: Boolean(raw.myReservation && raw.myReservation.status === 'ACTIVE'),
    myWarmupChest: chest ? { ...chest, totalA9Raw: chestTotalA9Raw } : null,
    inviteDeepLink: typeof raw.inviteDeepLink === 'string' ? raw.inviteDeepLink : '',
  };
}

/** 读取当前/下一轮预热预约总人数、目标进度与个人预热宝箱状态 */
export async function fetchWarmupCurrent(roundId = null) {
  const raw = config.isDemo ? (await loadDemoModule()).demoWarmupCurrent() : await request(ENDPOINTS.warmupCurrent(roundId));
  return normalizeWarmupCurrent(raw);
}

/** 预热报名（零门槛 TG 预约，支持透传 roundId、referrerId、可选 intentTier 与 remindEnabled） */
export async function registerWarmup({ roundId = null, walletAddress = null, userId = null, referrerId = null, intentTier = undefined, remindEnabled = undefined } = {}) {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    return demo.demoWarmupRegister({ intentTier, remindEnabled });
  }
  const payload = {
    roundId: roundId ? Number(roundId) : undefined,
    walletAddress: walletAddress || null,
    userId: userId || null
  };
  if (intentTier !== undefined) payload.intentTier = intentTier;
  if (remindEnabled !== undefined) payload.remindEnabled = Boolean(remindEnabled);
  return request(ENDPOINTS.warmupRegister, {
    method: 'POST',
    body: withReferrer(payload, referrerId)
  });
}

/** 取消本轮开局预热报名 */
export async function cancelWarmup({ roundId = null, walletAddress = null, userId = null } = {}) {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    return demo.demoWarmupCancel();
  }
  return request(ENDPOINTS.warmupCancel, {
    method: 'POST',
    body: { roundId: roundId ? Number(roundId) : undefined, walletAddress: walletAddress || null, userId: userId || null }
  });
}

export async function fetchWalletTeam(wallet) {
  if (!wallet) return null;
  return request(ENDPOINTS.teamByWallet(wallet));
}

/** 加入团队（透传 referrerId） */
export async function joinTeam({ teamId, walletAddress, userId, referrerId }) {
  return request(ENDPOINTS.teamJoin, {
    method: 'POST',
    body: withReferrer({ teamId: String(teamId), walletAddress: walletAddress || null, userId: userId || null }, referrerId)
  });
}

/** 请求生成 A9 兑换屋支付单（纯 1 GRAM = 2,002 A9 内盘固定兑换；live 只读阶段统一拦截，不发网络订单请求）。 */
export async function requestPresaleIntent(walletAddress, tonAmount, referrerId = null) {
  assertFundsAllowedInMode();
  return request(ENDPOINTS.presaleIntent, {
    method: 'POST',
    body: withReferrer({ walletAddress, tonAmount }, referrerId)
  });
}

/** 阶段五：战队队长提交 Telegram 群名进入待核验状态（verifying，绝不直接置为 bound） */
export async function bindTeamGroupTg({ teamId, name = null, tgGroupHandle }) {
  if (!A9TMA.getRawInitData()) {
    throw new ApiError('IDENTITY_REQUIRED', L('请在 Telegram 小程序内以队长身份提交群组绑定', 'Open inside Telegram Mini App as captain to link a group'));
  }
  return request(ENDPOINTS.teamBindTg, {
    method: 'POST',
    body: { teamId: String(teamId), name: name ? String(name) : undefined, tgGroupHandle: String(tgGroupHandle) }
  });
}

/** 阶段五：战队队长发起 Telegram 群真实权限核验 */
export async function verifyTeamGroupTg({ teamId }) {
  if (!A9TMA.getRawInitData()) {
    throw new ApiError('IDENTITY_REQUIRED', L('请在 Telegram 小程序内以队长身份发起群核验', 'Open inside Telegram Mini App as captain to verify the group'));
  }
  return request(ENDPOINTS.teamVerifyTg, {
    method: 'POST',
    body: { teamId: String(teamId) }
  });
}

/** 阶段五：提交 Telegram startapp 深链邀请归因 */
export async function submitStartAppAttribution({ startParam, referrerId = null }) {
  if (!A9TMA.getRawInitData()) return null;
  return request(ENDPOINTS.referralAttribution, {
    method: 'POST',
    body: { startapp: startParam || '', referrerId: referrerId || null }
  });
}

/** 读取用户统一持仓与额度（A9 JettonWallet / 质押凭证 / 推广 / 商城 / 战队），支持可选历史轮次分页。 */
export async function fetchUserPortfolio(walletAddress, { fromRound = null, toRound = null } = {}) {
  return request(ENDPOINTS.userProfile(walletAddress, { fromRound, toRound }));
}

/**
 * v17 涨价解锁口径奖励估算（非承诺）：
 * 全员 1 A9 = 1 份公平平分，单轮封顶 5x，可分奖励 = min(本轮预算, 全轮总锁仓 × 5)，结算后以链上实际为准。
 */
function nonNegativeRaw(value) {
  return /^\d+$/.test(String(value)) ? BigInt(value) : null;
}

export function stakeTicketAmount(portfolio, roundId) {
  if (portfolio?.ticketsAvailable !== true || !Array.isArray(portfolio.tickets)) return null;
  const ticket = portfolio.tickets.find(t => String(t.roundId) === String(roundId));
  if (!ticket) return 0n;
  if (ticket.pending || ticket.exited || !/^\d+$/.test(ticket.amountRaw)) return null;
  return BigInt(ticket.amountRaw);
}

export function formatRoundA9(raw) {
  const amount = nonNegativeRaw(raw);
  if (amount === null) return '—';
  const whole = (amount / 1_000_000_000n).toLocaleString('en-US');
  const fraction = String(amount % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
  return `${whole}${fraction ? '.' + fraction : ''} A9`;
}

export function estimateRewardRaw(amountA9Input, view = currentView) {
  if (!view || view.stale || view.detailStale || view.detailLoading) return null;
  const parts = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(amountA9Input));
  if (!parts) return null;
  const amount = BigInt(parts[1]) * 1_000_000_000n + BigInt((parts[2] || '').padEnd(9, '0'));
  const budget = nonNegativeRaw(view.rewardBudgetRaw);
  const currentStake = nonNegativeRaw(view.totalStakedRaw);
  if (amount <= 0n || budget === null || currentStake === null) return null;

  const totalStake = currentStake + amount;
  const cap = totalStake * BigInt(PROTOCOL_SPECS.maxRewardMultiplier);
  return ((budget < cap ? budget : cap) * amount / totalStake).toString();
}

export function estimateRewardA9(amountA9Input, view = currentView) {
  return rawToA9(estimateRewardRaw(amountA9Input, view));
}

export function fetchWarmupRank(roundId) {
  return request(ENDPOINTS.warmupLeaderboard + '?roundId=' + encodeURIComponent(roundId));
}

/** 宝箱商城：读取当前用户的免费宝箱链与商城膨胀宝箱 */
export async function fetchMyChests() {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    return demo.demoChestsMe();
  }
  if (!A9TMA.getRawInitData()) return null;
  return request(ENDPOINTS.chestsMe);
}

/** 宝箱商城：首次领取新手青铜宝箱（激活免费宝箱链） */
export async function claimStarterChests() {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    return demo.demoClaimStarterChests();
  }
  if (!A9TMA.getRawInitData()) throw new ApiError('IDENTITY_REQUIRED', L('请在 Telegram 小程序内打开', 'Open inside Telegram Mini App'));
  return request(ENDPOINTS.chestsStarter, { method: 'POST', body: {} });
}

/** 宝箱助力落地页：公开读取指定宝箱进度 */
export async function fetchChestById(chestId) {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    return demo.demoGetChest(chestId);
  }
  return request(ENDPOINTS.chestDetail(chestId));
}

/** 宝箱助力：连接已激活 TON 钱包为好友助力，立得可秒开的 200 A9 新手青铜宝箱 */
export async function assistChestById(chestId, walletAddress = null) {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    try { return demo.demoAssistChest(chestId); } catch (e) { throw new ApiError('DEMO_ASSIST_ERR', e.message); }
  }
  if (!A9TMA.getRawInitData()) throw new ApiError('IDENTITY_REQUIRED', L('请在 Telegram 小程序内打开后助力', 'Open inside Telegram Mini App to assist'));
  return request(ENDPOINTS.chestAssist(chestId), { method: 'POST', body: { walletAddress: walletAddress || null } });
}

/** 宝箱开箱：领取免费宝箱奖励或商城膨胀增量 A9（live 只读阶段统一拦截，不发写请求） */
export async function openChestById(chestId, stateForDemo = null, walletAddress = null) {
  const cid = String(chestId || '').trim();
  if (config.isDemo) {
    const demo = await loadDemoModule();
    try {
      if (cid.startsWith('ch_demo_wu_') || cid.startsWith('demo_warmup_chest_')) {
        return demo.demoOpenWarmupChest(stateForDemo, cid);
      }
      return demo.demoOpenChest(stateForDemo, cid);
    } catch (e) { throw new ApiError('DEMO_OPEN_ERR', e.message); }
  }
  if (cid.startsWith('ch_demo_') || cid.startsWith('demo_')) {
    throw new ApiError('MODE_MISMATCH', L('演示宝箱不可在真实模式下开启', 'Demo chests cannot be opened in Live mode'));
  }
  assertFundsAllowedInMode();
  if (!A9TMA.getRawInitData()) throw new ApiError('IDENTITY_REQUIRED', L('请在 Telegram 小程序内打开后开箱', 'Open inside Telegram Mini App to open chest'));
  return request(ENDPOINTS.chestOpen(chestId), { method: 'POST', body: { walletAddress: walletAddress || null } });
}

/** 宝箱批量一键开启（支持全开或按档位全开；live 只读阶段统一拦截） */
export async function openAllChests({ tier = null, stateForDemo = null, walletAddress = null } = {}) {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    try { return demo.demoOpenAllChests(stateForDemo, tier); } catch (e) { throw new ApiError('DEMO_OPEN_ALL_ERR', e.message); }
  }
  assertFundsAllowedInMode();
  if (!A9TMA.getRawInitData()) throw new ApiError('IDENTITY_REQUIRED', L('请在 Telegram 小程序内打开后一键开箱', 'Open inside Telegram Mini App to open all chests'));
  return request(ENDPOINTS.chestsOpenAll, {
    method: 'POST',
    body: { walletAddress: walletAddress || null, tier: tier || null }
  });
}

/** 宝箱商城实时手气爆棚捷报（公开只读；Live 模式空态返回空数组，绝不伪造） */
export async function fetchChestCritFeed(limit = 12) {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    return demo.demoChestCritFeed(limit)?.items || [];
  }
  const data = await request(ENDPOINTS.chestsCritFeed(limit));
  return Array.isArray(data?.items) ? data.items : [];
}

/** 宝箱商城下单（live 只读阶段统一拦截，不发网络订单请求） */
export async function requestChestPurchaseIntent({ walletAddress, skuId, openMode = 'INSTANT', referrerId = null }) {
  assertFundsAllowedInMode();
  return request(ENDPOINTS.presaleIntent, {
    method: 'POST',
    body: withReferrer({ walletAddress, skuId, openMode }, referrerId)
  });
}

/** 读取 Telegram 私聊结算提醒偏好（Demo 返回模拟，Live 无 initData 返回 null） */
export async function fetchNotificationPrefs() {
  if (config.isDemo) {
    return {
      tgUserId: 'demo',
      settlementPush: true,
      hourlyCandlePush: false,
      subscribedExplicitly: true,
      updatedAt: null,
    };
  }
  if (!A9TMA.getRawInitData()) return null;
  return request(ENDPOINTS.meNotifications);
}

/** 更新 Telegram 私聊结算提醒开关（真实持久化到服务端） */
export async function updateNotificationPrefs({ settlementPush }) {
  if (config.isDemo) {
    return {
      tgUserId: 'demo',
      settlementPush: Boolean(settlementPush),
      hourlyCandlePush: false,
      subscribedExplicitly: true,
      updatedAt: Math.floor(Date.now() / 1000),
    };
  }
  if (!A9TMA.getRawInitData()) throw new ApiError('IDENTITY_REQUIRED', L('请在 Telegram 小程序内打开', 'Open inside Telegram Mini App'));
  return request(ENDPOINTS.meNotifications, {
    method: 'POST',
    body: { settlementPush: Boolean(settlementPush) },
  });
}

/** v17.0 好友通关 8% 返佣明细（Demo 返回演示数据；Live 严格读取服务端真实数据，无 initData 返回 null） */
export async function fetchMyStakeReferrals(limit = 50) {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    return demo.demoStakeReferralsMe(limit);
  }
  if (!A9TMA.getRawInitData()) return null;
  return request(ENDPOINTS.v17StakeReferralMe(limit));
}

/** v17.0 每轮等权空投抽奖公示（公开只读；Live 空态返回空数组，绝不回退演示数据） */
export async function fetchRoundAirdropDraws({ roundId = null, limit = 10 } = {}) {
  if (config.isDemo) {
    const demo = await loadDemoModule();
    return demo.demoRoundAirdropDraws(limit);
  }
  return request(ENDPOINTS.v17AirdropDraws({ roundId, limit }));
}
