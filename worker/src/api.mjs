// A9 Protocol v15 — Unified API router (compatible with Cloudflare Worker & Node HTTP).
// Uses `await` on all storage/engine calls to support both sync in-memory engines and async D1 stores.
import { buildV15ConfigPayload, mapV15RoundDetail } from './v15-indexer.mjs';
import { PromoError } from './promo-hotwallet.mjs';
import { PresaleError } from './presale-hotwallet.mjs';
import { GrowthError, renderOgCardPng, renderOgCardSvg, renderOgLandingHtml } from './growth-engine.mjs';

function ok(data, status = 200) {
  return { status, body: { ok: true, data, ts: Date.now() } };
}

function err(code, message, status = 400) {
  return { status, body: { ok: false, error: { code, message }, ts: Date.now() } };
}

function extractAdminToken(headers = {}) {
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (lk === 'x-a9-admin-token' && v) return String(v).trim();
    if (lk === 'authorization' && typeof v === 'string' && v.toLowerCase().startsWith('bearer ')) {
      return v.slice(7).trim();
    }
  }
  return '';
}

export function createApiRouter({ env = {}, stateStore, promoEngine = null, presaleEngine = null, socialStore = null, predictionEngine = null, userReader = null }) {
  return async function handleRequest({ method, pathname, query = {}, body = null, headers = {}, nowSec = Math.floor(Date.now() / 1000) }) {
    try {
      if (method === 'GET' && pathname === '/api/health') {
        return ok({ service: 'a9mini-v15-worker', status: 'ok', version: '15.0.0' });
      }

      if (method === 'GET' && pathname === '/api/config') {
        const ps = stateStore.getProtocolState();
        const base = buildV15ConfigPayload(env, ps);
        base.presaleHotWallet = presaleEngine
          ? { enabled: true, address: presaleEngine.hotWalletAddress, rateA9PerTon: Number(presaleEngine.rateA9PerTon), open: presaleEngine.open }
          : { enabled: false, address: null, rateA9PerTon: null, open: false };
        return ok(base);
      }

      if (method === 'GET' && pathname === '/api/rounds') {
        const list = stateStore.listRounds().map((item) =>
          mapV15RoundDetail(item.roundId, item.round, item.candles, nowSec, stateStore.getTiming()),
        );
        return ok(list);
      }

      const roundMatch = method === 'GET' && pathname.match(/^\/api\/rounds\/(\d+)$/);
      if (roundMatch) {
        const id = Number(roundMatch[1]);
        const item = stateStore.getRound(id);
        if (!item) return err('NOT_FOUND', `round ${id} not found`, 404);
        return ok(mapV15RoundDetail(id, item.round, item.candles, nowSec, stateStore.getTiming()));
      }

      // Unified user portfolio endpoint (on-chain jetton wallet/tickets + promo + presale + team)
      const userMatch = method === 'GET' && pathname.match(/^\/api\/user\/(.+)$/);
      if (userMatch) {
        const wallet = decodeURIComponent(userMatch[1]);
        const onchain = userReader ? await userReader(wallet) : { jettonWallet: null, a9BalanceRaw: null, tickets: [] };
        const promo = promoEngine ? await promoEngine.getBalance(wallet) : null;
        const presaleQuota = presaleEngine ? await presaleEngine.getQuota(wallet) : null;
        const team = socialStore ? await socialStore.getTeamByWallet(wallet) : null;
        return ok({ walletAddress: wallet, ...onchain, promo, presaleQuota, team });
      }

      // Promo hot-wallet (0.06 TON user-covered gas)
      if (method === 'POST' && pathname === '/api/promo/intent') {
        if (!promoEngine) return err('PROMO_DISABLED', 'promo hot wallet not configured', 503);
        const wallet = String(body?.walletAddress || '').trim();
        if (!wallet) return err('BAD_REQUEST', 'walletAddress is required', 400);
        return ok(await promoEngine.createClaimIntent(wallet, nowSec));
      }

      const claimMatch = method === 'GET' && pathname.match(/^\/api\/promo\/claim\/([a-f0-9]+)$/i);
      if (claimMatch) {
        if (!promoEngine) return err('PROMO_DISABLED', 'promo hot wallet not configured', 503);
        const c = await promoEngine.getClaim(claimMatch[1]);
        if (!c) return err('NOT_FOUND', 'claim not found', 404);
        return ok(c);
      }

      const balMatch = method === 'GET' && pathname.match(/^\/api\/promo\/balance\/(.+)$/);
      if (balMatch) {
        if (!promoEngine) return err('PROMO_DISABLED', 'promo hot wallet not configured', 503);
        return ok(await promoEngine.getBalance(decodeURIComponent(balMatch[1])));
      }

      // Presale hot-wallet (0-contract internal market + first-touch referral binding)
      const pqMatch = method === 'GET' && pathname.match(/^\/api\/presale\/quota\/(.+)$/);
      if (pqMatch) {
        if (!presaleEngine) return err('PRESALE_DISABLED', 'presale hot wallet not configured', 503);
        return ok(await presaleEngine.getQuota(decodeURIComponent(pqMatch[1])));
      }

      if (method === 'POST' && pathname === '/api/presale/intent') {
        if (!presaleEngine) return err('PRESALE_DISABLED', 'presale hot wallet not configured', 503);
        const wallet = String(body?.walletAddress || '').trim();
        const tonAmount = Number(body?.tonAmount);
        if (!wallet || !Number.isFinite(tonAmount)) return err('BAD_REQUEST', 'walletAddress and tonAmount required', 400);
        const rawRef = String(body?.referrerId || '').trim() || null;
        if (socialStore && rawRef) {
          await socialStore.bindReferral(wallet, rawRef, nowSec);
        }
        const effectiveRef = (socialStore ? await socialStore.getReferrer(wallet) : null) || rawRef;
        return ok(await presaleEngine.createOrderIntent(wallet, tonAmount, nowSec, { referrerId: effectiveRef }));
      }

      const poMatch = method === 'GET' && pathname.match(/^\/api\/presale\/orders\/(.+)$/);
      if (poMatch) {
        if (!presaleEngine) return err('PRESALE_DISABLED', 'presale hot wallet not configured', 503);
        return ok(await presaleEngine.listOrders(decodeURIComponent(poMatch[1])));
      }

      // Warm-up & Team social endpoints
      if (method === 'POST' && pathname === '/api/warmup/register') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        return ok(await socialStore.registerWarmup(body || {}, nowSec));
      }

      if (method === 'POST' && pathname === '/api/warmup/cancel') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        return ok(await socialStore.cancelWarmup(body || {}, nowSec));
      }

      if (method === 'GET' && pathname === '/api/warmup/leaderboard') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const roundId = Number(query.roundId || stateStore.getProtocolState().currentRoundId || 1);
        return ok(await socialStore.getWarmupLeaderboard(roundId, 50));
      }

      if (method === 'POST' && pathname === '/api/team/bind-tg') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        return ok(await socialStore.createOrBindTeamGroup(body || {}, nowSec));
      }

      if (method === 'POST' && pathname === '/api/team/join') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        return ok(await socialStore.joinTeam(body || {}, nowSec));
      }

      const teamMatch = method === 'GET' && pathname.match(/^\/api\/team\/(.+)$/);
      if (teamMatch) {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        return ok(await socialStore.getTeamByWallet(decodeURIComponent(teamMatch[1])));
      }

      // Plan 1: 24H PASS/BURN Prediction endpoints (0 TON entry + anti-sybil activation)
      if (method === 'POST' && pathname === '/api/prediction/bet') {
        if (!predictionEngine) return err('PREDICTION_DISABLED', 'prediction engine not configured', 503);
        if (socialStore && body?.userId && body?.referrerId) {
          await socialStore.bindReferral(body.userId, body.referrerId, nowSec);
        }
        return ok(await predictionEngine.placeBet(body || {}, nowSec));
      }

      const predStatsMatch = method === 'GET' && pathname.match(/^\/api\/prediction\/round\/(\d+)$/);
      if (predStatsMatch) {
        if (!predictionEngine) return err('PREDICTION_DISABLED', 'prediction engine not configured', 503);
        return ok(await predictionEngine.getRoundStats(Number(predStatsMatch[1])));
      }

      const predUserMatch = method === 'GET' && pathname.match(/^\/api\/prediction\/user\/(.+)$/);
      if (predUserMatch) {
        if (!predictionEngine) return err('PREDICTION_DISABLED', 'prediction engine not configured', 503);
        const roundId = query.roundId ? Number(query.roundId) : stateStore.getProtocolState().currentRoundId;
        return ok(await predictionEngine.getUserSummary(decodeURIComponent(predUserMatch[1]), roundId));
      }

      if (method === 'POST' && pathname === '/api/prediction/activate') {
        if (!predictionEngine) return err('PREDICTION_DISABLED', 'prediction engine not configured', 503);
        const { userId, walletAddress } = body || {};
        if (!userId || !walletAddress) return err('BAD_REQUEST', 'userId and walletAddress required', 400);

        // Anti-sybil real-capital verification: >= 1 PAID_A9 presale order OR >= 1 on-chain StakeTicket
        const orders = presaleEngine ? await presaleEngine.listOrders(walletAddress) : [];
        const hasPaidPresale = Array.isArray(orders) && orders.some((o) => o.status === 'PAID_A9');
        let hasStakeTicket = false;
        if (!hasPaidPresale && userReader) {
          const portfolio = await userReader(walletAddress);
          hasStakeTicket = Array.isArray(portfolio?.tickets) && portfolio.tickets.length > 0;
        }
        const qualified = hasPaidPresale || hasStakeTicket;

        return ok(
          await predictionEngine.activateToPromo(userId, walletAddress, promoEngine, {
            qualified,
            nowMs: nowSec * 1000,
          }),
        );
      }

      // Admin endpoint for ops/Cron to settle a prediction round explicitly
      if (method === 'POST' && pathname === '/api/admin/prediction/settle') {
        const expectedToken = String(env.A9_ADMIN_TOKEN || '').trim();
        const providedToken = extractAdminToken(headers);
        if (!expectedToken || !providedToken || providedToken !== expectedToken) {
          return err('UNAUTHORIZED', 'invalid or missing admin token', 401);
        }
        if (!predictionEngine) return err('PREDICTION_DISABLED', 'prediction engine not configured', 503);
        const roundId = Number(body?.roundId);
        const actualQualified = Number(body?.actualQualified);
        if (!Number.isInteger(roundId) || roundId < 1 || typeof body?.passed !== 'boolean' || !Number.isInteger(actualQualified) || actualQualified < 0 || actualQualified > 24) {
          return err('BAD_REQUEST', 'roundId (>=1), passed (boolean), and actualQualified (0..24) are required', 400);
        }
        const poolArg = body?.poolA9Raw !== undefined && body?.poolA9Raw !== null
          ? body.poolA9Raw
          : predictionEngine.defaultPoolA9Raw;
        return ok(
          await predictionEngine.settleRoundBets(roundId, body.passed, actualQualified, poolArg, nowSec * 1000),
        );
      }

      // Plan 3: Dynamic OG / Story PNG raster image (/c/img/:type/:id.png)
      const ogPngMatch = method === 'GET' && pathname.match(/^\/c\/img\/(round|burn|proof|bet)\/([^/]+)\.png$/);
      if (ogPngMatch) {
        const [, type, id] = ogPngMatch;
        const rId = Number(id) || stateStore.getProtocolState().currentRoundId || 1;
        const item = stateStore.getRound(rId);
        const detail = item ? mapV15RoundDetail(rId, item.round, item.candles, nowSec, stateStore.getTiming()) : null;
        const ratio = query.ratio === '9x16' ? '9x16' : '16x9';
        const pngBytes = await renderOgCardPng({
          type,
          roundId: rId,
          state: detail?.state || 'OBSERVING',
          qualified: detail?.qualifiedCandles || 0,
          targetUsd: detail?.targetPriceUsdE8 ? `$${(Number(detail.targetPriceUsdE8) / 1e8).toFixed(4)}` : '$0.0023',
          ratio,
        });
        return { status: 200, contentType: 'image/png', rawBody: pngBytes };
      }

      // Backward-compatible SVG card (/c/img/:type/:id.svg)
      const ogImgMatch = method === 'GET' && pathname.match(/^\/c\/img\/(round|burn|proof|bet)\/([^/]+)\.svg$/);
      if (ogImgMatch) {
        const [, type, id] = ogImgMatch;
        const rId = Number(id) || stateStore.getProtocolState().currentRoundId || 1;
        const item = stateStore.getRound(rId);
        const detail = item ? mapV15RoundDetail(rId, item.round, item.candles, nowSec, stateStore.getTiming()) : null;
        const svg = renderOgCardSvg({
          type,
          roundId: rId,
          state: detail?.state || 'OBSERVING',
          qualified: detail?.qualifiedCandles || 0,
          targetUsd: detail?.targetPriceUsdE8 ? `$${(Number(detail.targetPriceUsdE8) / 1e8).toFixed(4)}` : '—',
        });
        return { status: 200, contentType: 'image/svg+xml; charset=utf-8', rawBody: svg };
      }

      const ogPageMatch = method === 'GET' && pathname.match(/^\/c\/(round|burn|proof|bet)\/([^/]+)$/);
      if (ogPageMatch) {
        const [, type, id] = ogPageMatch;
        const rId = Number(id) || stateStore.getProtocolState().currentRoundId || 1;
        const base = (env.A9_PUBLIC_ORIGIN || '').replace(/\/+$/, '');
        const botHandle = env.A9_TG_BOT_HANDLE || 'A9ProtocolBot';
        const ref = query.ref ? `_${String(query.ref).replace(/[^a-zA-Z0-9_-]/g, '')}` : '';
        const html = renderOgLandingHtml({
          type,
          id,
          title: `A9 Protocol · Round #${rId} (${type.toUpperCase()})`,
          description: '24H 16/24 Hourly Slots · 700,000,000 A9 Pool · 100% On-Chain TON TEP-74',
          imageUrl: `${base}/c/img/${type}/${encodeURIComponent(id)}.png`,
          tgDeepLink: `https://t.me/${botHandle}?startapp=${type}_${encodeURIComponent(id)}${ref}`,
          width: 1200,
          height: 630,
        });
        return { status: 200, contentType: 'text/html; charset=utf-8', rawBody: html };
      }

      return err('NOT_FOUND', `route not found: ${method} ${pathname}`, 404);
    } catch (e) {
      if (e instanceof PromoError || e instanceof PresaleError || e instanceof GrowthError) {
        return err(e.code, e.message, 400);
      }
      return err('INTERNAL_ERROR', e.message || 'internal error', 500);
    }
  };
}
