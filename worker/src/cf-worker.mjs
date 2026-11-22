// A9 Protocol v15 — Cloudflare Worker production/testnet entrypoint.
// Automatically switches to D1 persistence when env.DB is bound; falls back to memory locally.
import { createApiRouter } from './api.mjs';
import { TonCenterClient } from './toncenter.mjs';
import { PromoHotWalletEngine } from './promo-hotwallet.mjs';
import { PresaleHotWalletEngine } from './presale-hotwallet.mjs';
import { SocialStore } from './social-store.mjs';
import { PredictionEngine, ProgressionEngine, InventoryEngine } from './growth-engine.mjs';
import { D1PromoStore } from './d1-promo-store.mjs';
import { D1SocialStore, D1PredictionEngine, D1ProgressionEngine, D1InventoryEngine, D1PresaleStore } from './d1-growth-store.mjs';
import { D1IdentityStore, MemoryIdentityStore } from './auth.mjs';

function corsHeaders(contentType = 'application/json; charset=utf-8', extra = {}) {
  return {
    'content-type': contentType,
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-a9-admin-token, x-telegram-init-data',
    ...extra,
  };
}

// Module-scoped fallbacks for ephemeral preview/dev environments without D1 bindings
const memSocialStore = new SocialStore();
const memPredictionEngine = new PredictionEngine();
const memProgressionEngine = new ProgressionEngine();
const memInventoryEngine = new InventoryEngine();
const memIdentityStore = new MemoryIdentityStore();

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const url = new URL(request.url);
    const query = Object.fromEntries(url.searchParams.entries());
    const headers = Object.fromEntries(request.headers.entries());
    let body = null;
    if (request.method === 'POST') {
      try { body = await request.json(); } catch { body = {}; }
    }

    const tc = env.TONCENTER_API_BASE
      ? new TonCenterClient({ apiBase: env.TONCENTER_API_BASE, apiKey: env.TONCENTER_API_KEY || '' })
      : null;

    const rcAddr = env.A9_ROUND_CONTROLLER_ADDRESS || null;
    const jmAddr = env.A9_JETTON_MASTER_ADDRESS || null;
    // 无链上数据源时不伪造剩余奖池或轮次（P0-G）。
    let ps = { dataAvailable: false, currentRoundId: null, successCount: null, poolRemainingRaw: null, carryRaw: null, teamPoolRemainingRaw: null, teamCarryRaw: null };
    const rounds = [];

    if (tc && rcAddr) {
      try {
        ps = { dataAvailable: true, ...(await tc.fetchProtocolState(rcAddr)) };
        if (ps.currentRoundId > 0) {
          const startId = Math.max(1, ps.currentRoundId - 5);
          for (let rId = startId; rId <= ps.currentRoundId; rId += 1) {
            const rd = await tc.fetchRound(rcAddr, rId);
            rounds.push({ roundId: rId, round: rd, candles: [] });
          }
        }
      } catch {
        ps = { dataAvailable: false, currentRoundId: null, successCount: null, poolRemainingRaw: null, carryRaw: null, teamPoolRemainingRaw: null, teamCarryRaw: null };
      }
    }

    const stateStore = {
      getTiming: () => ({ observationSeconds: Number(env.A9_OBS_SECONDS || 86400) }),
      getProtocolState: () => ps,
      listRounds: () => rounds,
      getRound: (id) => rounds.find((r) => r.roundId === Number(id)) || null,
    };

    const hasD1 = Boolean(env.DB);
    const socialStore = hasD1 ? new D1SocialStore({ db: env.DB }) : memSocialStore;
    const predictionEngine = hasD1 ? new D1PredictionEngine({ db: env.DB }) : memPredictionEngine;
    const progressionEngine = hasD1 ? new D1ProgressionEngine({ db: env.DB }) : memProgressionEngine;
    const inventoryEngine = hasD1 ? new D1InventoryEngine({ db: env.DB }) : memInventoryEngine;

    const promoEngine = env.A9_PROMO_HOT_WALLET_ADDRESS
      ? (hasD1
          ? new D1PromoStore({
              db: env.DB,
              hotWalletAddress: env.A9_PROMO_HOT_WALLET_ADDRESS,
              userFeeNano: env.A9_PROMO_USER_FEE_NANO || '60000000',
            })
          : new PromoHotWalletEngine({
              hotWalletAddress: env.A9_PROMO_HOT_WALLET_ADDRESS,
              userFeeNano: env.A9_PROMO_USER_FEE_NANO || '60000000',
              transferGasNano: env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
            }))
      : null;

    // 兑换业务必须显式配置独立热钱包，不再静默回退到推广热钱包；默认关闭，须显式设置 A9_PRESALE_OPEN=1 才开启。
    const presaleHotAddr = env.A9_PRESALE_HOT_WALLET_ADDRESS || null;
    const presaleOpts = {
      hotWalletAddress: presaleHotAddr,
      rateA9PerTon: BigInt(env.A9_PRESALE_RATE_A9_PER_TON || '2002'),
      minOrderTon: BigInt(env.A9_PRESALE_MIN_ORDER_TON || '5'),
      maxOrderTon: BigInt(env.A9_PRESALE_MAX_ORDER_TON || '200'),
      open: env.A9_PRESALE_OPEN === '1',
      // Only set after the user-fault fee rule is published and approved (unset = full refunds).
      userFaultFeeNano: env.A9_PRESALE_USER_FAULT_FEE_NANO || null,
      promoEngine,
      socialStore,
      inventoryEngine,
    };
    const presaleEngine = presaleHotAddr
      ? (hasD1 ? new D1PresaleStore({ db: env.DB, ...presaleOpts }) : new PresaleHotWalletEngine(presaleOpts))
      : null;

    const userReader = (tc && (jmAddr || rcAddr))
      ? (wallet) => tc.fetchUserPortfolio(wallet, {
          jettonMasterAddress: jmAddr,
          roundControllerAddress: rcAddr,
          roundIds: rounds.map((r) => r.roundId),
        })
      : null;

    const router = createApiRouter({
      env,
      stateStore,
      promoEngine,
      presaleEngine,
      socialStore,
      predictionEngine,
      progressionEngine,
      inventoryEngine,
      userReader,
      identityStore: hasD1 ? new D1IdentityStore({ db: env.DB }) : memIdentityStore,
      publicKeyResolver: tc ? (addr) => tc.fetchWalletPublicKey(addr) : null,
      walletStateResolver: tc ? (addr) => tc.fetchWalletAccountState(addr) : null,
    });
    const out = await router({ method: request.method, pathname: url.pathname, query, body, headers });

    if (out.rawBody !== undefined) {
      const extra = out.contentType?.startsWith('image/') ? { 'cache-control': 'public, max-age=60' } : {};
      return new Response(out.rawBody, {
        status: out.status,
        headers: corsHeaders(out.contentType || 'text/plain; charset=utf-8', extra),
      });
    }
    return new Response(JSON.stringify(out.body), { status: out.status, headers: corsHeaders() });
  },
};
