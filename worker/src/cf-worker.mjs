// A9 Protocol v15 — Cloudflare Worker production/testnet entrypoint.
// Automatically switches to D1 persistence when env.DB is bound; falls back to memory locally.
import { createApiRouter } from './api.mjs';
import { TonCenterClient } from './toncenter.mjs';
import { PromoHotWalletEngine } from './promo-hotwallet.mjs';
import { PresaleHotWalletEngine } from './presale-hotwallet.mjs';
import { SocialStore } from './social-store.mjs';
import { PredictionEngine, ProgressionEngine } from './growth-engine.mjs';
import { ChestEngine } from './chest-engine.mjs';
import { D1ChestEngine } from './d1-chest-store.mjs';
import { D1PromoStore } from './d1-promo-store.mjs';
import { D1SocialStore, D1PredictionEngine, D1ProgressionEngine, D1PresaleStore } from './d1-growth-store.mjs';
import { D1PromoBudgetLedger, MemoryPromoBudgetLedger } from './promo-budget.mjs';
import { D1V17RewardEngine, V17RewardEngine } from './v17-rewards.mjs';
import { D1IdentityStore, MemoryIdentityStore } from './auth.mjs';
import { TelegramBroadcaster, D1BroadcastLog, MemoryBroadcastLog } from './tg-broadcaster.mjs';
import { addressKey, parseTonAddress } from './ton-address.mjs';

function timingSafeEqualStr(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function isStrictDeployEnv(env = {}) {
  const e = String(env.A9_ENVIRONMENT || '').trim().toLowerCase();
  const net = String(env.A9_NETWORK || '').trim().toLowerCase();
  return e === 'production' || e === 'candidate' || net === 'mainnet';
}

function resolveCorsOrigin(request, env = {}) {
  const rawList = [
    env.A9_PUBLIC_ORIGIN || '',
    ...String(env.A9_ALLOWED_ORIGINS || '').split(','),
  ]
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (!rawList.length) {
    // 生产与候选环境未配置 CORS 白名单时绝不退化为通配符 '*'
    return isStrictDeployEnv(env) ? null : '*';
  }
  const reqOrigin = String(request?.headers?.get?.('origin') || '').trim().replace(/\/+$/, '');
  if (reqOrigin) {
    return rawList.includes(reqOrigin) ? reqOrigin : null;
  }
  return rawList[0];
}

function corsHeaders(contentType = 'application/json; charset=utf-8', extra = {}, origin = '*') {
  return {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(origin ? { 'access-control-allow-origin': origin } : {}),
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-a9-admin-token, x-telegram-init-data, x-idempotency-key',
    ...(origin !== '*' ? { vary: 'Origin' } : {}),
    ...extra,
  };
}

export function buildNormalizedOgCacheUrl(url) {
  const u = new URL(url.origin + url.pathname);
  const ratio = String(url.searchParams.get('ratio') || '').trim().toLowerCase();
  if (ratio === '16x9' || ratio === '9x16') {
    u.searchParams.set('ratio', ratio);
  }
  return u.toString();
}

const CHAIN_CACHE_TTL_SEC = 15;
const CHAIN_CACHE_STALE_MAX_SEC = 60;

export function routeNeedsChainState(pathname, request = null, body = null, env = {}) {
  if (pathname === '/api/telegram/webhook') {
    const expected = String(env?.A9_TG_WEBHOOK_SECRET || '').trim();
    const provided = String(request?.headers?.get?.('x-telegram-bot-api-secret-token') || '').trim();
    if (!expected || !timingSafeEqualStr(provided, expected)) return false;
    const text = String(body?.message?.text || body?.edited_message?.text || '').trim();
    return /^\/status(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text);
  }
  return (
    pathname === '/api/config' ||
    pathname === '/api/rounds' ||
    pathname.startsWith('/api/rounds/') ||
    pathname.startsWith('/api/user/') ||
    pathname === '/api/prediction/bet' ||
    pathname.startsWith('/api/prediction/user/') ||
    pathname.startsWith('/api/prediction/activate') ||
    pathname.startsWith('/api/progression/') ||
    pathname.startsWith('/api/warmup/') ||
    pathname.startsWith('/api/admin/warmup/') ||
    pathname.startsWith('/c/')
  );
}

const STATUS_NAME_TO_CODE = { UNOPENED: 0, ACTIVE: 1, SUCCEEDED: 2, FAILED: 3, ABORTED: 4 };
const STATUS_CODE_TO_NAME = ['UNOPENED', 'ACTIVE', 'SUCCEEDED', 'FAILED', 'ABORTED'];

async function readCandlesFromD1(db, minRoundId) {
  const candlesByRound = new Map();
  if (!db) return candlesByRound;
  try {
    const cRes = await db
      .prepare('SELECT * FROM round_candles WHERE round_id >= ? ORDER BY round_id ASC, candle_index ASC')
      .bind(Number(minRoundId || 0))
      .all();
    for (const c of cRes?.results || []) {
      const rId = Number(c.round_id);
      if (!candlesByRound.has(rId)) candlesByRound.set(rId, []);
      candlesByRound.get(rId).push({
        candleIndex: Number(c.candle_index),
        periodStart: Number(c.period_start),
        periodEnd: Number(c.period_end),
        twapPriceUsdE8: String(c.twap_price_usd_e8),
        qualified: Number(c.qualified) === 1,
      });
    }
  } catch {
    // ignore D1 candle read failure
  }
  return candlesByRound;
}

export async function readCachedRoundsFromD1(db, nowSec) {
  try {
    const rRes = await db
      .prepare('SELECT * FROM rounds_cache ORDER BY round_id DESC LIMIT 12')
      .all();
    const rows = (rRes?.results || []).slice().sort((a, b) => Number(a.round_id || 0) - Number(b.round_id || 0));
    if (!rows.length) return null;
    const latestUpdated = Math.max(...rows.map((r) => Number(r.updated_at || 0)));
    if (nowSec - latestUpdated > CHAIN_CACHE_TTL_SEC) return null;

    const minRoundId = Number(rows[0].round_id || 0);
    const candlesByRound = await readCandlesFromD1(db, minRoundId);

    const rounds = rows.map((r) => ({
      roundId: Number(r.round_id),
      round: {
        status: STATUS_NAME_TO_CODE[String(r.status)] ?? Number(r.status || 0),
        targetPriceUsdE8: String(r.target_price_usd_e8 || '0'),
        twap24hUsdE8: String(r.twap_24h_usd_e8 || '0'),
        stakeOpenAt: Number(r.stake_open_at || 0),
        stakeCloseAt: Number(r.stake_close_at || 0),
        settledAt: Number(r.settled_at || 0),
        totalStakeRaw: String(r.total_stake_raw || '0'),
        earlyStakeRaw: String(r.early_stake_raw || '0'),
        totalWeightRaw: String(r.total_weight_raw || r.total_stake_raw || '0'),
        rewardBudgetRaw: String(r.reward_budget_raw || '0'),
        qualifiedCandles: Number(r.qualified_candles || 0),
        candleHash: String(r.candle_hash || '0x0'),
        immediateBps: Number(r.immediate_bps || 2000),
        vestingSeconds: Number(r.vesting_seconds || 1209600),
        earlyWindowSeconds: Number(r.early_window_seconds || 21600),
        lockedSlices: Number(r.locked_slices || 0),
        unlockedSlices: Number(r.unlocked_slices || 0),
        burnedSlices: Number(r.burned_slices || 0),
        lockedTotalRaw: String(r.locked_total_raw || '0'),
        stakeCount: Number(r.stake_count || 0),
      },
      candles: candlesByRound.get(Number(r.round_id)) || [],
    }));
    return rounds;
  } catch {
    return null;
  }
}

export async function writeCandlesToD1(db, roundId, candles) {
  if (!db || !Array.isArray(candles) || !candles.length) return 0;
  const rId = Number(roundId);
  const stmts = candles.map((c) =>
    db
      .prepare(
        `INSERT INTO round_candles (
           round_id, candle_index, period_start, period_end, twap_price_usd_e8, qualified
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(round_id, candle_index) DO UPDATE SET
           period_start = excluded.period_start,
           period_end = excluded.period_end,
           twap_price_usd_e8 = excluded.twap_price_usd_e8,
           qualified = excluded.qualified`,
      )
      .bind(
        rId,
        Number(c.candleIndex),
        Number(c.periodStart),
        Number(c.periodEnd),
        String(c.twapPriceUsdE8),
        c.qualified ? 1 : 0,
      ),
  );
  await db.batch(stmts);
  return stmts.length;
}

async function writeRoundsCacheToD1(db, rounds, nowSec) {
  if (!db || !rounds.length) return;
  try {
    const stmts = rounds.map(({ roundId, round }) =>
      db
        .prepare(
          `INSERT INTO rounds_cache (
             round_id, status, target_price_usd_e8, twap_24h_usd_e8, stake_open_at, stake_close_at,
             settled_at, total_stake_raw, early_stake_raw, total_weight_raw, reward_budget_raw, qualified_candles,
             candle_hash, immediate_bps, vesting_seconds, early_window_seconds, unlock_model,
             locked_slices, unlocked_slices, burned_slices, locked_total_raw,
             stake_count, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(round_id) DO UPDATE SET
             status = excluded.status,
             target_price_usd_e8 = excluded.target_price_usd_e8,
             twap_24h_usd_e8 = excluded.twap_24h_usd_e8,
             stake_open_at = excluded.stake_open_at,
             stake_close_at = excluded.stake_close_at,
             settled_at = excluded.settled_at,
             total_stake_raw = excluded.total_stake_raw,
             early_stake_raw = excluded.early_stake_raw,
             total_weight_raw = excluded.total_weight_raw,
             reward_budget_raw = excluded.reward_budget_raw,
             qualified_candles = excluded.qualified_candles,
             candle_hash = excluded.candle_hash,
             immediate_bps = excluded.immediate_bps,
             vesting_seconds = excluded.vesting_seconds,
             early_window_seconds = excluded.early_window_seconds,
             unlock_model = excluded.unlock_model,
             locked_slices = excluded.locked_slices,
             unlocked_slices = excluded.unlocked_slices,
             burned_slices = excluded.burned_slices,
             locked_total_raw = excluded.locked_total_raw,
             stake_count = excluded.stake_count,
             updated_at = excluded.updated_at`,
        )
        .bind(
          Number(roundId),
          STATUS_CODE_TO_NAME[Number(round.status)] || String(round.status),
          String(round.targetPriceUsdE8 || '0'),
          String(round.twap24hUsdE8 || '0'),
          Number(round.stakeOpenAt || 0),
          Number(round.stakeCloseAt || 0),
          Number(round.settledAt || 0),
          String(round.totalStakeRaw || '0'),
          String(round.earlyStakeRaw || '0'),
          String(round.totalWeightRaw || round.totalStakeRaw || '0'),
          String(round.rewardBudgetRaw || '0'),
          Number(round.qualifiedCandles || 0),
          String(round.candleHash || '0x0'),
          Number(round.immediateBps || 2000),
          Number(round.vestingSeconds || 1209600),
          Number(round.earlyWindowSeconds || 21600),
          'LINEAR_14D',
          Number(round.lockedSlices || 0),
          Number(round.unlockedSlices || 0),
          Number(round.burnedSlices || 0),
          String(round.lockedTotalRaw || '0'),
          Number(round.stakeCount || 0),
          nowSec,
        ),
    );
    await db.batch(stmts);
  } catch (e) {
    console.error('[a9mini-v15-worker] writeRoundsCacheToD1 error:', e?.message || e);
  }
}

// Module-scoped fallbacks for ephemeral preview/dev environments without D1 bindings
const memBudgetLedger = new MemoryPromoBudgetLedger();
const memSocialStore = new SocialStore();
const memChestEngine = new ChestEngine({ budgetLedger: memBudgetLedger });
const memPredictionEngine = new PredictionEngine({ budgetLedger: memBudgetLedger });
const memProgressionEngine = new ProgressionEngine();
const memV17RewardEngine = new V17RewardEngine();
const memIdentityStore = new MemoryIdentityStore();
const memBroadcastLog = new MemoryBroadcastLog();
// 按 `${apiBase}:${rcAddr}` 分桶存储链上缓存，防止同 isolate 多环境配置串数据
const memChainCacheByTarget = new Map();

function buildBroadcaster(env, { socialStore, identityStore, hasD1 }) {
  return new TelegramBroadcaster({
    enabled: env.A9_BROADCAST_ENABLED === '1',
    botToken: env.A9_BOT_TOKEN || '',
    botHandle: env.A9_TG_BOT_HANDLE || 'A9_TonBot',
    publicOrigin: env.A9_PUBLIC_ORIGIN || '',
    apiOrigin: env.A9_API_ORIGIN || env.A9_PUBLIC_ORIGIN || '',
    officialChannelId: env.A9_OFFICIAL_CHANNEL_ID || '',
    whaleMinGram: env.A9_BROADCAST_WHALE_MIN_GRAM || '50',
    socialStore,
    identityStore,
    dedupLog: hasD1 ? new D1BroadcastLog({ db: env.DB }) : memBroadcastLog,
  });
}

const CANDIDATE_REQUIRED_VARS = [
  'A9_JETTON_MASTER_ADDRESS',
  'A9_ROUND_CONTROLLER_ADDRESS',
  'A9_PROMO_HOT_WALLET_ADDRESS',
  'A9_PRESALE_HOT_WALLET_ADDRESS',
  'A9_PUBLIC_ORIGIN',
  'A9_TON_PROOF_DOMAINS',
  'A9_ALLOWED_ORIGINS',
];

export function validateCandidateEnv(env = {}) {
  // P1-3 双热钱包强制隔离校验：只要两项同时配置，严禁归一化后指向同一钱包地址
  const promoHot = String(env.A9_PROMO_HOT_WALLET_ADDRESS || '').trim();
  const presaleHot = String(env.A9_PRESALE_HOT_WALLET_ADDRESS || '').trim();
  if (promoHot && presaleHot && addressKey(promoHot) === addressKey(presaleHot)) {
    return {
      ok: false,
      missing: ['A9_PRESALE_HOT_WALLET_ADDRESS!=A9_PROMO_HOT_WALLET_ADDRESS'],
      code: 'HOT_WALLET_ISOLATION_VIOLATION',
    };
  }
  const envName = String(env.A9_ENVIRONMENT || '').trim().toLowerCase();
  const netName = String(env.A9_NETWORK || '').trim().toLowerCase();
  const rawProtoVer = String(env.A9_PROTOCOL_VERSION || '').trim().toLowerCase();
  const protoVer = rawProtoVer || 'v17';
  const isProduction = envName === 'production' || netName === 'mainnet';
  if (isProduction) {
    const missing = [];
    // 生产环境严禁无 D1 绑定时静默退回内存 Store
    if (!env.DB) missing.push('DB');
    // 主网/生产默认按 v17/v16 强检全部关键合约与域名白名单，防漏配 A9_PROTOCOL_VERSION 绕过门禁
    if (protoVer === 'v17' || protoVer === 'v16') {
      for (const key of CANDIDATE_REQUIRED_VARS) {
        if (!String(env[key] || '').trim()) missing.push(key);
      }
    }
    // 若开启兑换/购箱写入口，必须具备独立预售热钱包、Bot Token 与域名白名单
    if (env.A9_PRESALE_OPEN === '1') {
      if (!String(env.A9_PRESALE_HOT_WALLET_ADDRESS || '').trim() && !missing.includes('A9_PRESALE_HOT_WALLET_ADDRESS')) {
        missing.push('A9_PRESALE_HOT_WALLET_ADDRESS');
      }
      if (!String(env.A9_BOT_TOKEN || '').trim()) missing.push('A9_BOT_TOKEN');
      if (!String(env.A9_PUBLIC_ORIGIN || '').trim() && !String(env.A9_TON_PROOF_DOMAINS || '').trim()) {
        missing.push('A9_PUBLIC_ORIGIN|A9_TON_PROOF_DOMAINS');
      }
    }
    if (missing.length) {
      return { ok: false, missing, code: 'PRODUCTION_CONFIG_INCOMPLETE' };
    }
    // 主网/生产环境额外强检所有已配置合约/热钱包地址为 Basechain(workchain=0) 非 testOnly，且禁止指向 testnet TonCenter
    const invalid = [];
    for (const addrKey of [
      'A9_JETTON_MASTER_ADDRESS',
      'A9_ROUND_CONTROLLER_ADDRESS',
      'A9_PROMO_HOT_WALLET_ADDRESS',
      'A9_PRESALE_HOT_WALLET_ADDRESS',
    ]) {
      const val = String(env[addrKey] || '').trim();
      if (!val) continue;
      const parsed = parseTonAddress(val);
      if (!parsed || parsed.workchain !== 0 || (netName === 'mainnet' && parsed.testOnly === true)) {
        invalid.push(`${addrKey}:invalid_mainnet_basechain`);
      }
    }
    if (netName === 'mainnet') {
      for (const rpcKey of ['TONCENTER_API_BASE', 'TONCENTER_V3_API_BASE']) {
        const rpc = String(env[rpcKey] || '').trim().toLowerCase();
        if (rpc && rpc.includes('testnet.toncenter.com')) {
          invalid.push(`${rpcKey}:testnet_endpoint_on_mainnet`);
        }
      }
    }
    if (invalid.length) {
      return { ok: false, missing: invalid, code: 'PRODUCTION_CONFIG_INVALID' };
    }
    return { ok: true, missing: [], code: null };
  }
  const isCandidate = envName === 'candidate' || rawProtoVer === 'v17' || rawProtoVer === 'v16';
  if (isCandidate) {
    const missing = [];
    if (!env.DB) missing.push('DB');
    for (const key of CANDIDATE_REQUIRED_VARS) {
      if (!String(env[key] || '').trim()) missing.push(key);
    }
    return { ok: missing.length === 0, missing, code: 'CANDIDATE_CONFIG_INCOMPLETE' };
  }
  return { ok: true, missing: [], code: null };
}

export const validateDeployEnv = validateCandidateEnv;

// Per-isolate lightweight sliding-window rate limiter for D1 write endpoints & OG image misses.
const RATE_LIMIT_BUCKETS = new Map();
const RATE_LIMIT_MAX_BUCKETS = 2000;
const RATE_LIMIT_RULES = Object.freeze([
  { method: 'POST', prefix: '/api/auth/ton-proof/payload', limit: 20, windowSec: 60 },
  { method: 'POST', prefix: '/api/auth/ton-proof/verify', limit: 20, windowSec: 60 },
  { method: 'POST', prefix: '/api/me/notifications', limit: 30, windowSec: 60 },
  { method: 'POST', prefix: '/api/telegram/webhook', limit: 2000, windowSec: 60 },
  { method: 'POST', prefix: '/api/admin/', limit: 60, windowSec: 60 },
  { method: 'GET', prefix: '/api/admin/', limit: 60, windowSec: 60 },
  { method: 'POST', prefix: '/api/warmup/register', limit: 30, windowSec: 60 },
  { method: 'POST', prefix: '/api/warmup/cancel', limit: 30, windowSec: 60 },
  { method: 'POST', prefix: '/api/prediction/bet', limit: 30, windowSec: 60 },
  { method: 'POST', prefix: '/api/prediction/activate', limit: 20, windowSec: 60 },
  { method: 'POST', prefix: '/api/presale/intent', limit: 20, windowSec: 60 },
  { method: 'POST', prefix: '/api/promo/intent', limit: 20, windowSec: 60 },
  { method: 'POST', prefix: '/api/team/bind-tg', limit: 20, windowSec: 60 },
  { method: 'POST', prefix: '/api/team/verify-tg', limit: 20, windowSec: 60 },
  { method: 'POST', prefix: '/api/team/join', limit: 30, windowSec: 60 },
  { method: 'POST', prefix: '/api/progression/claim', limit: 30, windowSec: 60 },
  { method: 'POST', prefix: '/api/referral/attribution', limit: 30, windowSec: 60 },
  { method: 'GET', prefix: '/api/chests/me', limit: 60, windowSec: 60 },
  { method: 'POST', prefix: '/api/chests/starter', limit: 30, windowSec: 60 },
  { method: 'POST', prefix: '/api/chests/open-all', limit: 10, windowSec: 60 },
  { method: 'POST', prefix: '/api/chests/', limit: 30, windowSec: 60 },
  { method: 'GET', prefix: '/api/v17/', limit: 60, windowSec: 60 },
  { method: 'GET', prefix: '/api/user/', limit: 30, windowSec: 60 },
  { method: 'GET', prefix: '/c/img/', limit: 60, windowSec: 60 },
]);

function extractClientIp(request) {
  const cfIp = request?.headers?.get?.('cf-connecting-ip');
  if (cfIp) return String(cfIp).trim();
  const xff = request?.headers?.get?.('x-forwarded-for');
  if (xff) return String(xff).split(',')[0].trim();
  return 'unknown';
}

export function checkEdgeRateLimit(method, pathname, clientIp, nowSec, env = {}) {
  if (env.A9_RATE_LIMIT_DISABLED === '1') return { allowed: true };
  const rule = RATE_LIMIT_RULES.find((r) => r.method === method && (r.prefix.endsWith('/') ? pathname.startsWith(r.prefix) : pathname === r.prefix));
  if (!rule) return { allowed: true };
  if (RATE_LIMIT_BUCKETS.size >= RATE_LIMIT_MAX_BUCKETS) {
    for (const [k, rec] of RATE_LIMIT_BUCKETS) {
      if (rec.resetAt <= nowSec) RATE_LIMIT_BUCKETS.delete(k);
    }
    if (RATE_LIMIT_BUCKETS.size >= RATE_LIMIT_MAX_BUCKETS) RATE_LIMIT_BUCKETS.clear();
  }
  const key = `${rule.method}:${rule.prefix}:${clientIp}`;
  const cur = RATE_LIMIT_BUCKETS.get(key);
  if (!cur || cur.resetAt <= nowSec) {
    RATE_LIMIT_BUCKETS.set(key, { count: 1, resetAt: nowSec + rule.windowSec });
    return { allowed: true };
  }
  if (cur.count >= rule.limit) {
    return { allowed: false, retryAfter: Math.max(1, cur.resetAt - nowSec) };
  }
  cur.count += 1;
  return { allowed: true };
}

export default {
  async fetch(request, env = {}, ctx = null) {
    const corsOrigin = resolveCorsOrigin(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders('application/json; charset=utf-8', {}, corsOrigin) });
    }
    const candCheck = validateDeployEnv(env);
    if (!candCheck.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: candCheck.code || 'CANDIDATE_CONFIG_INCOMPLETE',
            message: `Deployment environment missing required bindings/config: ${candCheck.missing.join(', ')}`,
            missing: candCheck.missing,
          },
        }),
        { status: 503, headers: corsHeaders('application/json; charset=utf-8', {}, corsOrigin) },
      );
    }
    const url = new URL(request.url);
    const nowSecPre = Math.floor(Date.now() / 1000);
    const isOgImg = request.method === 'GET' && url.pathname.startsWith('/c/img/');
    const edgeCache = isOgImg && typeof caches !== 'undefined' && caches?.default ? caches.default : null;
    const edgeCacheKey = edgeCache ? new Request(buildNormalizedOgCacheUrl(url), { method: 'GET' }) : null;
    if (edgeCache && edgeCacheKey) {
      try {
        const cachedResp = await edgeCache.match(edgeCacheKey);
        if (cachedResp) return cachedResp;
      } catch {
        // Ignore cache read failures and fall through to origin render
      }
    }
    const rl = checkEdgeRateLimit(request.method, url.pathname, extractClientIp(request), nowSecPre, env);
    if (!rl.allowed) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: 'RATE_LIMITED', message: 'too many requests, please retry shortly' },
          ts: Date.now(),
        }),
        { status: 429, headers: corsHeaders('application/json; charset=utf-8', { 'retry-after': String(rl.retryAfter) }, corsOrigin) },
      );
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const headers = Object.fromEntries(request.headers.entries());
    let body = null;
    if (request.method === 'POST') {
      try { body = await request.json(); } catch { body = {}; }
    }

    const tc = env.TONCENTER_API_BASE
      ? new TonCenterClient({
          apiBase: env.TONCENTER_API_BASE,
          v3ApiBase: env.TONCENTER_V3_API_BASE || null,
          apiKey: env.TONCENTER_API_KEY || '',
          testnet: String(env.A9_NETWORK || '').trim().toLowerCase() === 'testnet',
        })
      : null;

    const rcAddr = env.A9_ROUND_CONTROLLER_ADDRESS || null;
    const jmAddr = env.A9_JETTON_MASTER_ADDRESS || null;
    const hasD1 = Boolean(env.DB);
    const nowSec = Math.floor(Date.now() / 1000);

    // 无链上数据源时不伪造剩余奖池或轮次（P0-G）。
    let ps = { dataAvailable: false, currentRoundId: null, successCount: null, poolRemainingRaw: null, carryRaw: null, teamPoolRemainingRaw: null, teamCarryRaw: null };
    let rounds = [];

    if (tc && rcAddr && routeNeedsChainState(url.pathname, request, body, env)) {
      const cacheKey = `${env.TONCENTER_API_BASE || ''}:${rcAddr}`;
      const cached = memChainCacheByTarget.get(cacheKey) || null;
      const memFresh = cached?.ps && (nowSec - cached.fetchedAt) <= CHAIN_CACHE_TTL_SEC;
      if (memFresh) {
        ps = cached.ps;
        rounds = cached.rounds;
      } else {
        const d1Rounds = hasD1 ? await readCachedRoundsFromD1(env.DB, nowSec) : null;
        try {
          ps = { dataAvailable: true, ...(await tc.fetchProtocolState(rcAddr)) };
          if (d1Rounds && d1Rounds.length && d1Rounds[d1Rounds.length - 1].roundId === ps.currentRoundId) {
            rounds = d1Rounds;
          } else if (ps.currentRoundId > 0) {
            const startId = Math.max(1, ps.currentRoundId - 5);
            const candlesByRound = hasD1 ? await readCandlesFromD1(env.DB, startId) : new Map();
            const fetched = [];
            for (let rId = startId; rId <= ps.currentRoundId; rId += 1) {
              const rd = await tc.fetchRound(rcAddr, rId);
              const existingCandles =
                candlesByRound.get(rId) ||
                d1Rounds?.find((x) => x.roundId === rId)?.candles ||
                [];
              fetched.push({ roundId: rId, round: rd, candles: existingCandles });
            }
            rounds = fetched;
            if (hasD1) await writeRoundsCacheToD1(env.DB, rounds, nowSec);
          }
          memChainCacheByTarget.set(cacheKey, { fetchedAt: nowSec, ps, rounds });
        } catch {
          // 仅允许在最大容忍窗口（60s）内短时降级读缓存，超时后绝不拿陈旧快照冒充实时状态
          if (cached?.ps && (nowSec - cached.fetchedAt) <= CHAIN_CACHE_STALE_MAX_SEC) {
            ps = cached.ps;
            rounds = cached.rounds;
          } else {
            ps = { dataAvailable: false, currentRoundId: null, successCount: null, poolRemainingRaw: null, carryRaw: null, teamPoolRemainingRaw: null, teamCarryRaw: null };
          }
        }
      }
    }

    const stateStore = {
      getTiming: () => ({
        observationSeconds: Number(env.A9_OBS_SECONDS || 43200),
        vestingSeconds: Number(env.A9_VESTING_SECONDS || 1209600),
        earlyWindowSeconds: Number(env.A9_EARLY_WINDOW_SECONDS || 21600),
      }),
      getProtocolState: () => ps,
      listRounds: () => rounds,
      getRound: (id) => rounds.find((r) => r.roundId === Number(id)) || null,
    };

    const budgetLedger = hasD1 ? new D1PromoBudgetLedger({ db: env.DB }) : memBudgetLedger;
    const promoEngine = env.A9_PROMO_HOT_WALLET_ADDRESS
      ? (hasD1
          ? new D1PromoStore({
              db: env.DB,
              hotWalletAddress: env.A9_PROMO_HOT_WALLET_ADDRESS,
              userFeeNano: env.A9_PROMO_USER_FEE_NANO || '60000000',
              transferGasNano: env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
            })
          : new PromoHotWalletEngine({
              hotWalletAddress: env.A9_PROMO_HOT_WALLET_ADDRESS,
              userFeeNano: env.A9_PROMO_USER_FEE_NANO || '60000000',
              transferGasNano: env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
            }))
      : null;
    const onWalletRebound = promoEngine
      ? ({ fromWalletAddress, toWalletAddress, nowSec: rebindNow }) => promoEngine.mergeBalance(fromWalletAddress, toWalletAddress, rebindNow)
      : null;
    const canPromoteRebind = promoEngine && typeof promoEngine.hasPendingClaim === 'function'
      ? async ({ fromWalletAddress, nowSec: rebindNow }) => !(await promoEngine.hasPendingClaim(fromWalletAddress, rebindNow))
      : null;
    const identityStore = hasD1 ? new D1IdentityStore({ db: env.DB, onWalletRebound, canPromoteRebind }) : memIdentityStore;
    if (!hasD1) {
      if (onWalletRebound) identityStore.onWalletRebound = onWalletRebound;
      if (canPromoteRebind) identityStore.canPromoteRebind = canPromoteRebind;
    }
    const socialStore = hasD1 ? new D1SocialStore({ db: env.DB }) : memSocialStore;
    const predOpts = {
      firstLossBonusRaw: env.A9_PRED_FIRST_LOSS_BONUS_RAW,
      firstLossCapRaw: env.A9_PRED_FIRST_LOSS_CAP_RAW,
      budgetLedger,
    };
    const predictionEngine = hasD1 ? new D1PredictionEngine({ db: env.DB, ...predOpts }) : memPredictionEngine;
    const progressionEngine = hasD1 ? new D1ProgressionEngine({ db: env.DB }) : memProgressionEngine;
    const chestEngine = hasD1 ? new D1ChestEngine({ db: env.DB, budgetLedger }) : memChestEngine;
    const v17RewardEngine = hasD1 ? new D1V17RewardEngine({ db: env.DB }) : memV17RewardEngine;
    const broadcaster = buildBroadcaster(env, { socialStore, identityStore, hasD1 });

    // 兑换业务必须显式配置独立热钱包，不再静默回退到推广热钱包；默认关闭，须显式设置 A9_PRESALE_OPEN=1 才开启。
    const presaleHotAddr = env.A9_PRESALE_HOT_WALLET_ADDRESS || null;
    const presaleOpts = {
      hotWalletAddress: presaleHotAddr,
      rateA9PerTon: BigInt(env.A9_PRESALE_RATE_A9_PER_TON || '2002'),
      minOrderTon: BigInt(env.A9_PRESALE_MIN_ORDER_TON || '5'),
      maxOrderTon: BigInt(env.A9_PRESALE_MAX_ORDER_TON || '500'),
      defaultQuotaTon: env.A9_PRESALE_DEFAULT_QUOTA_TON ? BigInt(env.A9_PRESALE_DEFAULT_QUOTA_TON) : null,
      open: env.A9_PRESALE_OPEN === '1',
      deliveryFeeNano: env.A9_PRESALE_DELIVERY_FEE_NANO || undefined,
      refundFeeNano: env.A9_PRESALE_REFUND_FEE_NANO || undefined,
      userFaultFeeNano: env.A9_PRESALE_USER_FAULT_FEE_NANO || null,
      promoEngine,
      predictionEngine,
      socialStore,
      identityStore,
      chestEngine,
      budgetLedger,
      broadcaster,
    };
    const presaleEngine = presaleHotAddr
      ? (hasD1 ? new D1PresaleStore({ db: env.DB, ...presaleOpts }) : new PresaleHotWalletEngine(presaleOpts))
      : null;

    const readRunnerHeartbeats = hasD1
      ? async () => {
          try {
            const res = await env.DB
              .prepare('SELECT runner_id, role, network, last_seen_at, meta_json FROM runner_heartbeats ORDER BY last_seen_at DESC')
              .all();
            return (res?.results || []).map((r) => {
              let meta = null;
              if (r.meta_json) {
                try { meta = JSON.parse(String(r.meta_json)); } catch { meta = { status: 'invalid' }; }
              }
              return {
                runnerId: String(r.runner_id),
                role: String(r.role),
                network: String(r.network || ''),
                lastSeenAt: Number(r.last_seen_at || 0),
                meta,
              };
            });
          } catch {
            return [];
          }
        }
      : async () => [];

    const healthChecker = async ({ nowSec: checkNow }) => {
      const cacheKey = rcAddr ? `${env.TONCENTER_API_BASE || ''}:${rcAddr}` : null;
      const cached = cacheKey ? memChainCacheByTarget.get(cacheKey) : null;
      const cacheAgeSec = cached?.fetchedAt ? Math.max(0, checkNow - cached.fetchedAt) : null;
      let dbOk = !hasD1;
      let dbError = null;
      if (hasD1) {
        try {
          const row = await env.DB.prepare('SELECT 1 AS ok').first();
          dbOk = Number(row?.ok) === 1;
        } catch (e) {
          dbOk = false;
          dbError = e?.message || 'D1 health probe failed';
        }
      }
      const runnerHeartbeats = dbOk && hasD1 ? await readRunnerHeartbeats() : [];
      return {
        ok: dbOk,
        db: { bound: hasD1, ok: dbOk, ...(dbError ? { error: dbError } : {}) },
        cacheAgeSec,
        runnerHeartbeats,
      };
    };

    const userReader = (tc && (jmAddr || rcAddr))
      ? (wallet, rangeOpts = {}) => {
          let roundIds = Array.isArray(rangeOpts?.roundIds) && rangeOpts.roundIds.length
            ? rangeOpts.roundIds
            : null;
          if (!roundIds) {
            const cur = Number(ps.currentRoundId || 0);
            if (cur > 0) {
              const startId = Math.max(1, cur - 7);
              roundIds = [];
              for (let id = startId; id <= cur; id += 1) roundIds.push(id);
            } else {
              roundIds = rounds.map((r) => r.roundId);
            }
          }
          return tc.fetchUserPortfolio(wallet, {
            jettonMasterAddress: jmAddr,
            roundControllerAddress: rcAddr,
            roundIds,
          });
        }
      : null;

    const candleWriter = hasD1
      ? async (roundId, candles) => {
          await writeCandlesToD1(env.DB, roundId, candles);
          if (rcAddr) {
            memChainCacheByTarget.delete(`${env.TONCENTER_API_BASE || ''}:${rcAddr}`);
          }
        }
      : null;

    const router = createApiRouter({
      env,
      stateStore,
      promoEngine,
      presaleEngine,
      socialStore,
      predictionEngine,
      progressionEngine,
      chestEngine,
      budgetLedger,
      v17RewardEngine,
      userReader,
      identityStore,
      publicKeyResolver: tc ? (addr) => tc.fetchWalletPublicKey(addr) : null,
      walletStateResolver: tc ? (addr) => tc.fetchWalletAccountState(addr) : null,
      broadcaster,
      healthChecker,
      runnerHeartbeatReader: readRunnerHeartbeats,
      candleWriter,
    });
    const out = await router({ method: request.method, pathname: url.pathname, query, body, headers, origin: url.origin });

    if (out.rawBody !== undefined) {
      const extra = {};
      if (out.contentType?.startsWith('image/')) {
        extra['cache-control'] = 'public, max-age=60, s-maxage=60';
      }
      if (out.contentType?.startsWith('text/html') || out.contentType?.startsWith('image/svg+xml')) {
        extra['content-security-policy'] = "default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";
      }
      const resp = new Response(out.rawBody, {
        status: out.status,
        headers: corsHeaders(out.contentType || 'text/plain; charset=utf-8', extra, corsOrigin),
      });
      if (edgeCache && edgeCacheKey && out.status === 200 && out.contentType?.startsWith('image/')) {
        const putPromise = edgeCache.put(edgeCacheKey, resp.clone()).catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(putPromise);
        else await putPromise;
      }
      return resp;
    }
    return new Response(JSON.stringify(out.body), { status: out.status, headers: corsHeaders('application/json; charset=utf-8', {}, corsOrigin) });
  },

  /** Cloudflare Cron 定时巡检：同步链上最新轮次写入 D1 缓存、自动结算预言池并幂等推送战队 TG 群战报。 */
  async scheduled(_controller, env = {}) {
    const candCheck = validateCandidateEnv(env);
    if (!candCheck.ok) {
      throw new Error(`Candidate scheduled job aborted: missing ${candCheck.missing.join(', ')}`);
    }
    if (!env.TONCENTER_API_BASE || !env.A9_ROUND_CONTROLLER_ADDRESS) return;
    const tc = new TonCenterClient({
      apiBase: env.TONCENTER_API_BASE,
      v3ApiBase: env.TONCENTER_V3_API_BASE || null,
      apiKey: env.TONCENTER_API_KEY || '',
      testnet: String(env.A9_NETWORK || '').trim().toLowerCase() === 'testnet',
    });
    const hasD1 = Boolean(env.DB);
    const budgetLedger = hasD1 ? new D1PromoBudgetLedger({ db: env.DB }) : memBudgetLedger;
    const identityStore = hasD1 ? new D1IdentityStore({ db: env.DB }) : memIdentityStore;
    const socialStore = hasD1 ? new D1SocialStore({ db: env.DB }) : memSocialStore;
    const predictionEngine = hasD1
      ? new D1PredictionEngine({
          db: env.DB,
          firstLossBonusRaw: env.A9_PRED_FIRST_LOSS_BONUS_RAW,
          firstLossCapRaw: env.A9_PRED_FIRST_LOSS_CAP_RAW,
          budgetLedger,
        })
      : memPredictionEngine;
    const broadcaster = buildBroadcaster(env, { socialStore, identityStore, hasD1 });

    const obsSec = Number(env.A9_OBS_SECONDS || 43200);
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      const ps = await tc.fetchProtocolState(env.A9_ROUND_CONTROLLER_ADDRESS);
      if (!ps?.currentRoundId || ps.currentRoundId <= 0) return;
      const startId = Math.max(1, ps.currentRoundId - 5);
      const candlesByRound = hasD1 ? await readCandlesFromD1(env.DB, startId) : new Map();
      const synced = [];
      for (let rId = startId; rId <= ps.currentRoundId; rId += 1) {
        const rd = await tc.fetchRound(env.A9_ROUND_CONTROLLER_ADDRESS, rId);
        const roundCandles = candlesByRound.get(rId) || [];
        synced.push({ roundId: rId, round: rd, candles: roundCandles });
        if (rId >= Math.max(1, ps.currentRoundId - 1)) {
          if (rd.status === 2 || rd.status === 3) {
            try {
              const stats = await predictionEngine.getRoundStats(rId);
              if (!stats.settled) {
                await predictionEngine.settleRoundBets(rId, rd.status === 2, Number(rd.qualifiedCandles || 0));
              }
            } catch (settleErr) {
              console.error(`[a9mini-v15-worker] round #${rId} prediction settle error:`, settleErr?.message || settleErr);
            }
          }
          try {
            await broadcaster.processRoundSnapshot({
              roundId: rId,
              round: rd,
              candles: roundCandles,
              nowSec,
              observationSeconds: obsSec,
              dmLimit: 10,
            });
          } catch (bcErr) {
            console.error(`[a9mini-v15-worker] round #${rId} broadcast error:`, bcErr?.message || bcErr);
          }
        }
      }
      if (hasD1) await writeRoundsCacheToD1(env.DB, synced, nowSec);
      const cacheKey = `${env.TONCENTER_API_BASE || ''}:${env.A9_ROUND_CONTROLLER_ADDRESS}`;
      memChainCacheByTarget.set(cacheKey, { fetchedAt: nowSec, ps: { dataAvailable: true, ...ps }, rounds: synced });
    } catch (e) {
      console.error('[a9mini-v15-worker] scheduled sync error:', e?.message || e);
    } finally {
      try {
        await broadcaster.sendPendingVaultExpiryReminders({ predictionEngine, limit: 10, nowSec });
      } catch (remErr) {
        console.error('[a9mini-v15-worker] vault expiry reminder error:', remErr?.message || remErr);
      }
      // 定期清理过期超过 24 小时的 ton_proof 挑战记录，防止 D1 存储被恶意刷爆
      if (hasD1) {
        try {
          await env.DB
            .prepare('DELETE FROM auth_ton_proof_payloads WHERE expires_at < ?')
            .bind(nowSec - 86400)
            .run();
        } catch (cleanupErr) {
          console.error('[a9mini-v15-worker] auth payload cleanup error:', cleanupErr?.message || cleanupErr);
        }
      }
    }
  },
};
