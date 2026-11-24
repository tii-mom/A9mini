/**
 * 只读数据层：复用 BAM 的 API 契约 / 类型口径 / 焦点轮选择逻辑
 *
 * BAM 版本（对接记录）：见 config.js 的 BAM_SOURCE。
 * 真实模式只读取 /api/config、/api/rounds、/api/rounds/:id：服务端状态 + 时间戳驱动
 * 轮次阶段、倒计时、目标价、判定均价与达标时段；前端不再用本地随机数推演这些值。
 * 演示模式返回 js/demo-data.js 中明确标识的测试数据，页面顶部会显示来源标记。
 */

import { config, apiUrl } from './config.js';
import {
  demoFixture,
  demoPredictionRound,
  demoPredictionUser,
  demoPredictionBet,
  demoPredictionActivate,
  demoProgressionUser,
  demoProgressionClaim,
  demoChestsMe,
  demoClaimStarterChests,
  demoGetChest,
  demoAssistChest,
  demoOpenChest
} from './demo-data.js';
import { A9TMA } from './tma.js';

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
  warmupRegister: '/api/warmup/register',
  warmupCancel: '/api/warmup/cancel',
  warmupLeaderboard: '/api/warmup/leaderboard',
  teamJoin: '/api/team/join',
  teamBindTg: '/api/team/bind-tg',
  teamVerifyTg: '/api/team/verify-tg',
  referralAttribution: '/api/referral/attribution',
  chestsMe: '/api/chests/me',
  chestsStarter: '/api/chests/starter',
  chestDetail: (id) => `/api/chests/${encodeURIComponent(id)}`,
  chestAssist: (id) => `/api/chests/${encodeURIComponent(id)}/assist`,
  chestOpen: (id) => `/api/chests/${encodeURIComponent(id)}/open`,
  me: '/api/me',
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

/** BAM ApiResponse<T> 信封：{ ok, data, ts } | { ok:false, error:{code,message} } */
async function request(path, { timeoutMs = config.timeoutMs, method = 'GET', body: payload, headers: extraHeaders = null } = {}) {
  // apiBase 为空表示同源（本地 dev-server 已把 /api/* 代理到 BAM worker），不是配置缺失。
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const init = { method, signal: controller.signal, credentials: 'same-origin', headers: { ...(extraHeaders || {}) } };
    if (payload !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }
    // 真实模式：附带 Telegram 原始 initData，由服务端验签确定用户身份（P0-1）。
    // 演示模式永不附带，演示身份不能冒充已认证用户。
    const initData = config.isDemo ? '' : A9TMA.getRawInitData();
    if (initData) init.headers.authorization = `tma ${initData}`;
    const res = await fetch(apiUrl(path), init);
    let body;
    try {
      body = await res.json();
    } catch (_) {
      throw new ApiError('BAD_RESPONSE', `接口返回非 JSON（HTTP ${res.status}）`, res.status);
    }
    if (!body || typeof body !== 'object' || !('ok' in body)) {
      throw new ApiError('BAD_RESPONSE', '接口返回格式错误', res.status);
    }
    if (typeof body.ts === 'number' && Number.isFinite(body.ts) && body.ts > 1_000_000_000_000) {
      serverClockOffsetMs = body.ts - Date.now();
    }
    if (!body.ok) throw new ApiError(body.error?.code || 'API_ERROR', body.error?.message || '接口返回错误', res.status);
    return body.data;
  } catch (e) {
    if (timedOut) throw new ApiError('NETWORK', '请求超时，请重试', 408);
    if (e instanceof ApiError) throw e;
    throw new ApiError('NETWORK', '网络异常或接口不可达，请重试', 0);
  } finally {
    clearTimeout(timer);
  }
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

/** 读取只读快照。失败时保留上一次成功数据并标记 stale，交由页面提示重试。 */
export async function loadSnapshot() {
  if (config.isDemo) {
    const fixture = demoFixture();
    lastGoodSnapshot = fixture;
    return fixture;
  }

  try {
    const [protocolConfig, rounds] = await Promise.all([
      request(ENDPOINTS.config),
      request(ENDPOINTS.rounds)
    ]);
    if (!protocolConfig || !Array.isArray(rounds)) {
      throw new ApiError('BAD_RESPONSE', '接口返回配置或轮次格式错误');
    }
    const focus = pickFocusRound(rounds);
    // 轮次尚未开启（/api/config 正常、/api/rounds 为空）时允许进入只读广场与宝箱商城；
    // detail 置 null，由各页面明确显示“等待核验”，绝不伪造任何轮次或价格数据。
    const detail = focus ? await request(ENDPOINTS.round(focus.roundId)) : null;
    const snapshot = {
      source: 'api',
      label: '实时数据',
      fetchedAt: Date.now(),
      config: protocolConfig,
      rounds,
      detail,
      stale: false
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
  const candleCount = c.candleCount || 24;
  const minQualified = c.minQualifiedCandles || 16;
  const target = d.targetLocked === false ? null : e8ToUsd(d.targetPriceUsdE8);
  const judgePrice = d.priceValid === false ? null : e8ToUsd(d.priceUsdE8);
  const seen = Number(d.candlesSeen) || 0;
  const confirmed = Array.isArray(d.candles) ? d.candles.length : seen;
  const qualified = Number.isInteger(d.qualifiedCandles) && d.qualifiedCandles >= 0 && d.qualifiedCandles <= 24 ? d.qualifiedCandles : null;
  const liveIndex = d.live ? Number(d.live.candleIndex) : -1;
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
      const missing = !Array.isArray(d.candles) || periodEnded || i < seen ||
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
    countdownSec: d.secondsRemaining === null || d.secondsRemaining === undefined ? null : Number(d.secondsRemaining),
    nextState: d.nextState || null,
    candlesSeen: seen,
    candlesConfirmed: confirmed,
    qualifiedCandles: qualified,
    minQualifiedCandles: minQualified,
    needMore: qualified === null ? null : Math.max(0, minQualified - qualified),
    candles,
    activeCandleSec: liveIndex >= 0 && d.secondsRemaining !== null ? Math.max(0, Number(d.secondsRemaining)) : 0,
    rewardBudgetRaw: d.rewardBudgetRaw || c.roundRewardRaw || null,
    rewardBudgetA9: rawToA9(d.rewardBudgetRaw, decimals),
    totalStakedRaw: d.totalAcceptedStakeRaw ?? null,
    totalWeightRaw: d.totalWeightRaw ?? null,
    stakerCount: Number(d.stakerCount ?? d.entryCount) || 0,
    entryCount: Number(d.entryCount) || 0,
    successCount: Number.isInteger(c.poolState?.successCount) ? c.poolState.successCount : null,
    unlock: d.unlock || null,
    poolState: c.poolState || null,
    promoHotWallet: c.promoHotWallet || null,
    chestMall: c.chestMall || null,
    protocolConfig: c,
    result: d.result || null,
    updatedAt: d.updatedAt || snapshot.fetchedAt,
    source: snapshot.source,
    sourceLabel: snapshot.label,
    fetchedAt: snapshot.fetchedAt,
    stale: Boolean(snapshot.stale),
    stakingEnabled: Boolean(c.contracts?.stakingEnabled)
  };
  currentView = view;
  return view;
}

const LIVE_FUNDS_DISABLED_MSG = '当前真实模式处于只读验收阶段，资金订单与钱包交易暂未开放';

function assertFundsAllowedInMode() {
  if (!config.isDemo && !config.liveFundsEnabled) {
    throw new ApiError('LIVE_FUNDS_DISABLED', LIVE_FUNDS_DISABLED_MSG);
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

/** 24H 生死预言局：读取本轮多空实时比例 */
export async function fetchPredictionRound(roundId, stage = 'observation') {
  if (config.isDemo) return demoPredictionRound(roundId, stage);
  return request(ENDPOINTS.predictionRound(roundId));
}

/** 24H 生死预言局：读取当前用户本轮下注与待激活奖励 */
export async function fetchPredictionUser(userId, roundId) {
  if (!userId) return { userId: null, pendingActivationRaw: '0', activatedRaw: '0', currentBet: null };
  if (config.isDemo) return demoPredictionUser(userId, roundId);
  return request(ENDPOINTS.predictionUser(userId, roundId));
}

/** 24H 生死预言局：提交单轮多空预言（0 TON 参战） */
export async function submitPredictionBet({ roundId, userId, side, guessSlots, referrerId }) {
  if (!userId) throw new ApiError('IDENTITY_REQUIRED', '请在 Telegram 内打开或先连接 TON 钱包后再提交预言');
  if (config.isDemo) {
    try {
      return demoPredictionBet({ roundId, userId, side, guessSlots, referrerId });
    } catch (e) {
      throw new ApiError('DEMO_BET_ERR', e.message);
    }
  }
  const payload = { roundId: Number(roundId), userId: String(userId), side };
  if (guessSlots !== null && guessSlots !== undefined && guessSlots !== '') {
    payload.guessSlots = Math.max(0, Math.min(24, Math.floor(Number(guessSlots))));
  }
  if (referrerId) payload.referrerId = String(referrerId);
  return request(ENDPOINTS.predictionBet, { method: 'POST', body: payload });
}

/** 24H 生死预言局：激活待激活预言奖励到 promo_balances（live 只读阶段拦截，实盘态附带幂等键） */
export async function activatePredictionReward(userId, walletAddress, activationId = null) {
  if (!userId) throw new ApiError('IDENTITY_REQUIRED', '请在 Telegram 内打开或先连接 TON 钱包');
  if (!walletAddress) throw new ApiError('WALLET_REQUIRED', '请先连接 TON 钱包以激活奖励');
  if (config.isDemo) {
    try {
      return demoPredictionActivate(userId, walletAddress);
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

/** 阶段三：手账集章成长进度读取（非金融成长数据） */
export async function fetchProgressionUser(userId, roundId = null) {
  if (config.isDemo) return demoProgressionUser(userId || 'demo_user_01', roundId);
  if (!A9TMA.getRawInitData()) return null;
  return request(ENDPOINTS.progressionMe(roundId));
}

/** 阶段三：手账集章任务与成就领取（服务端幂等防重领） */
export async function claimProgressionTask({ userId, taskKey, roundId = null }) {
  if (config.isDemo) {
    try {
      return demoProgressionClaim({ userId: userId || 'demo_user_01', taskKey, roundId });
    } catch (e) {
      throw new ApiError('DEMO_CLAIM_ERR', e.message);
    }
  }
  if (!A9TMA.getRawInitData()) {
    throw new ApiError('IDENTITY_REQUIRED', '请在 Telegram 小程序内打开以完成手账盖章');
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

/** 预热报名（透传 roundId 与 referrerId） */
export async function registerWarmup({ roundId = null, walletAddress, userId, referrerId }) {
  return request(ENDPOINTS.warmupRegister, {
    method: 'POST',
    body: withReferrer({ roundId: roundId ? Number(roundId) : undefined, walletAddress: walletAddress || null, userId: userId || null }, referrerId)
  });
}

/** 取消本轮开局预热报名 */
export async function cancelWarmup({ roundId = null, walletAddress, userId }) {
  return request(ENDPOINTS.warmupCancel, {
    method: 'POST',
    body: { roundId: roundId ? Number(roundId) : undefined, walletAddress: walletAddress || null, userId: userId || null }
  });
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
    throw new ApiError('IDENTITY_REQUIRED', '请在 Telegram 小程序内以队长身份提交群组绑定');
  }
  return request(ENDPOINTS.teamBindTg, {
    method: 'POST',
    body: { teamId: String(teamId), name: name ? String(name) : undefined, tgGroupHandle: String(tgGroupHandle) }
  });
}

/** 阶段五：战队队长发起 Telegram 群真实权限核验 */
export async function verifyTeamGroupTg({ teamId }) {
  if (!A9TMA.getRawInitData()) {
    throw new ApiError('IDENTITY_REQUIRED', '请在 Telegram 小程序内以队长身份发起群核验');
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

/** 读取用户统一持仓与额度（A9 JettonWallet / 质押凭证 / 推广 / 商行 / 商会），支持可选历史轮次分页。 */
export async function fetchUserPortfolio(walletAddress, { fromRound = null, toRound = null } = {}) {
  return request(ENDPOINTS.userProfile(walletAddress, { fromRound, toRound }));
}

/**
 * v16 口径奖励估算（非承诺）：
 * 可分奖励 = min(本轮预算, 全轮实缴本金 × 15)，个人按早鸟权重占比瓜分，结算后以链上实际为准。
 * v16 合约原生以 A9 质押，不再依赖已废弃的 tonUsdE8 折算。
 */
export function estimateRewardA9(amountA9Input, view = currentView, { weightMultiplier = 1 } = {}) {
  const amountA9 = Number(amountA9Input);
  if (!view || !Number.isFinite(amountA9) || amountA9 <= 0) return null;
  const c = view.protocolConfig || {};
  const decimals = c.token?.decimals ?? 9;
  const budget = rawToA9(view.rewardBudgetRaw, decimals);
  if (budget === null || budget <= 0) return null;

  const totalWeight = rawToA9(view.totalWeightRaw, decimals) || 0;
  const totalStake = rawToA9(view.totalStakedRaw, decimals) || 0;
  const capMultiplier = Number(c.maxRewardCapMultiplier) || 15;
  const distributable = Math.min(budget, (totalStake + amountA9) * capMultiplier);
  const denom = totalWeight + effectiveWeight;
  return denom > 0 ? (distributable * effectiveWeight) / denom : 0;
}

export function fetchWarmupRank(roundId) {
  return request(ENDPOINTS.warmupLeaderboard + '?roundId=' + encodeURIComponent(roundId));
}

/** 宝箱商城：读取当前用户的免费宝箱链与商城膨胀宝箱 */
export async function fetchMyChests() {
  if (config.isDemo) return demoChestsMe();
  if (!A9TMA.getRawInitData()) return null;
  return request(ENDPOINTS.chestsMe);
}

/** 宝箱商城：首次领取青铜宝箱 #1（激活免费宝箱链） */
export async function claimStarterChests() {
  if (config.isDemo) return demoClaimStarterChests();
  if (!A9TMA.getRawInitData()) throw new ApiError('IDENTITY_REQUIRED', '请在 Telegram 小程序内打开');
  return request(ENDPOINTS.chestsStarter, { method: 'POST', body: {} });
}

/** 宝箱助力落地页：公开读取指定宝箱进度 */
export async function fetchChestById(chestId) {
  if (config.isDemo) return demoGetChest(chestId);
  return request(ENDPOINTS.chestDetail(chestId));
}

/** 宝箱助力：连接已激活 TON 钱包为好友助力，顺手自动领青铜宝箱 #1 */
export async function assistChestById(chestId, walletAddress = null) {
  if (config.isDemo) {
    try { return demoAssistChest(chestId); } catch (e) { throw new ApiError('DEMO_ASSIST_ERR', e.message); }
  }
  if (!A9TMA.getRawInitData()) throw new ApiError('IDENTITY_REQUIRED', '请在 Telegram 小程序内打开后助力');
  return request(ENDPOINTS.chestAssist(chestId), { method: 'POST', body: { walletAddress: walletAddress || null } });
}

/** 宝箱开箱：领取免费宝箱奖励或商城膨胀增量 A9（live 只读阶段统一拦截，不发写请求） */
export async function openChestById(chestId, stateForDemo = null, walletAddress = null) {
  if (config.isDemo) {
    try { return demoOpenChest(stateForDemo, chestId); } catch (e) { throw new ApiError('DEMO_OPEN_ERR', e.message); }
  }
  assertFundsAllowedInMode();
  if (!A9TMA.getRawInitData()) throw new ApiError('IDENTITY_REQUIRED', '请在 Telegram 小程序内打开后开箱');
  return request(ENDPOINTS.chestOpen(chestId), { method: 'POST', body: { walletAddress: walletAddress || null } });
}

/** 宝箱商城下单（live 只读阶段统一拦截，不发网络订单请求） */
export async function requestChestPurchaseIntent({ walletAddress, skuId, openMode = 'BOOST', referrerId = null }) {
  assertFundsAllowedInMode();
  return request(ENDPOINTS.presaleIntent, {
    method: 'POST',
    body: withReferrer({ walletAddress, skuId, openMode }, referrerId)
  });
}
  const mult = Number.isFinite(Number(weightMultiplier)) && Number(weightMultiplier) > 0 ? Number(weightMultiplier) : 1;
  const effectiveWeight = amountA9 * mult;
