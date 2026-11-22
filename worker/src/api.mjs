// A9 Protocol v15 — Unified API router (compatible with Cloudflare Worker & Node HTTP).
// Uses `await` on all storage/engine calls to support both sync in-memory engines and async D1 stores.
import { buildV15ConfigPayload, mapV15RoundDetail } from './v15-indexer.mjs';
import { PromoError } from './promo-hotwallet.mjs';
import { PresaleError } from './presale-hotwallet.mjs';
import { GrowthError, renderOgCardPng, renderOgCardSvg, renderOgLandingHtml } from './growth-engine.mjs';
import { AuthError, MemoryIdentityStore, allowedProofDomains, createRequestAuth, expectedChainId, verifyTonProof } from './auth.mjs';
import { addressKey, normalizeTonAddress } from './ton-address.mjs';

function ok(data, status = 200) {
  return { status, body: { ok: true, data, ts: Date.now() } };
}

function publicBinding(b) {
  if (!b) return null;
  return {
    address: b.walletAddress,
    boundAt: b.boundAt,
    pendingSwitch: b.pending ? { address: b.pending.walletAddress, effectiveAt: b.pending.effectiveAt } : null,
  };
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

export function createApiRouter({
  env = {},
  stateStore,
  promoEngine = null,
  presaleEngine = null,
  socialStore = null,
  predictionEngine = null,
  userReader = null,
  identityStore = new MemoryIdentityStore(),
  publicKeyResolver = null,
}) {
  return async function handleRequest({ method, pathname, query = {}, body = null, headers = {}, nowSec = Math.floor(Date.now() / 1000) }) {
    const auth = createRequestAuth({ env, headers, identityStore, nowSec });
    try {
      if (method === 'GET' && pathname === '/api/health') {
        return ok({ service: 'a9mini-v15-worker', status: 'ok', version: '15.0.0' });
      }

      if (method === 'GET' && pathname === '/api/config') {
        const ps = stateStore.getProtocolState();
        const base = buildV15ConfigPayload(env, ps);
        base.presaleHotWallet = presaleEngine
          ? {
              enabled: true,
              address: presaleEngine.hotWalletAddress,
              rateA9PerTon: Number(presaleEngine.rateA9PerTon),
              rateA9PerGram: presaleEngine.rateA9PerTon.toString(),
              rateKind: 'PROTOCOL_FIXED_QUOTE',
              minOrderNano: presaleEngine.minOrderNano.toString(),
              maxOrderNano: presaleEngine.maxOrderNano.toString(),
              open: presaleEngine.open,
            }
          : { enabled: false, address: null, rateA9PerTon: null, rateA9PerGram: null, open: false };
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

      // ---------------------------------------------------------------------
      // Identity (P0-1): Telegram initData + TON Connect ton_proof wallet binding
      // ---------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/me') {
        const id = await auth.telegram();
        const binding = await identityStore.getBinding(id.telegramUserId, nowSec);
        return ok({ telegramUserId: id.telegramUserId, user: id.user, wallet: publicBinding(binding) });
      }

      if (method === 'POST' && pathname === '/api/auth/ton-proof/payload') {
        const id = await auth.telegram();
        return ok(await identityStore.issueProofPayload(id.telegramUserId, nowSec));
      }

      // purpose: 'bind' (default) | 'unbind' | 'cancel_rebind'. Every binding change needs a
      // fresh single-use proof; unbind / cancel need a proof from the CURRENTLY bound wallet.
      if (method === 'POST' && pathname === '/api/auth/ton-proof/verify') {
        const id = await auth.telegram();
        const address = String(body?.address || '').trim();
        const proof = body?.proof || null;
        const purpose = String(body?.purpose || 'bind');
        if (!['bind', 'unbind', 'cancel_rebind'].includes(purpose)) return err('BAD_REQUEST', 'unknown purpose', 400);
        if (!normalizeTonAddress(address) || !proof?.payload) return err('BAD_REQUEST', 'address and ton_proof are required', 400);
        // Single-use, issued to THIS Telegram user, not expired. Consumed before any other check.
        if (!(await identityStore.consumeProofPayload(proof.payload, id.telegramUserId, nowSec))) {
          return err('PROOF_INVALID', 'ton_proof payload unknown, expired or already used', 400);
        }
        const verified = await verifyTonProof({
          address,
          network: body?.network,
          publicKey: body?.publicKey || null,
          proof: { ...proof, state_init: proof.state_init || body?.walletStateInit || null },
          expectedNetwork: expectedChainId(env),
          allowedDomains: allowedProofDomains(env),
          chainPublicKeyResolver: publicKeyResolver,
          nowSec,
        });
        if (purpose === 'bind') {
          const res = await identityStore.bindVerifiedWallet(id.telegramUserId, address, nowSec);
          return ok({ telegramUserId: id.telegramUserId, status: res.status, wallet: publicBinding(res.binding), keySource: verified.keySource });
        }
        const cur = await identityStore.getBinding(id.telegramUserId, nowSec);
        if (!cur || addressKey(address) !== cur.walletKey) {
          return err('FORBIDDEN', 'this action needs a proof from the currently bound wallet', 403);
        }
        if (purpose === 'unbind') {
          await identityStore.unbindWallet(id.telegramUserId);
          return ok({ telegramUserId: id.telegramUserId, status: 'UNBOUND', wallet: null });
        }
        await identityStore.cancelPendingRebind(id.telegramUserId);
        return ok({ telegramUserId: id.telegramUserId, status: 'REBIND_CANCELLED', wallet: publicBinding(await identityStore.getBinding(id.telegramUserId, nowSec)) });
      }

      // Unified user portfolio. On-chain data is public; promo / presale / team private parts are
      // returned only to the Telegram user whose verified wallet binding matches the path.
      const userMatch = method === 'GET' && pathname.match(/^\/api\/user\/(.+)$/);
      if (userMatch) {
        const wallet = decodeURIComponent(userMatch[1]);
        const onchain = userReader ? await userReader(wallet) : { jettonWallet: null, a9BalanceRaw: null, tickets: [] };
        let owner = false;
        try {
          await auth.wallet(wallet);
          owner = true;
        } catch (_) {
          owner = false;
        }
        const promo = owner && promoEngine ? await promoEngine.getBalance(wallet) : null;
        const presaleQuota = owner && presaleEngine ? await presaleEngine.getQuota(wallet, nowSec) : null;
        const team = owner && socialStore ? await socialStore.getTeamByWallet(wallet) : null;
        return ok({ walletAddress: wallet, ...onchain, promo, presaleQuota, team, privateDataVisible: owner });
      }

      // Promo hot-wallet (0.06 GRAM user-covered gas)
      if (method === 'POST' && pathname === '/api/promo/intent') {
        if (!promoEngine) return err('PROMO_DISABLED', 'promo hot wallet not configured', 503);
        const { walletAddress } = await auth.wallet(body?.walletAddress || null);
        return ok(await promoEngine.createClaimIntent(walletAddress, nowSec));
      }

      const claimMatch = method === 'GET' && pathname.match(/^\/api\/promo\/claim\/([a-f0-9]+)$/i);
      if (claimMatch) {
        if (!promoEngine) return err('PROMO_DISABLED', 'promo hot wallet not configured', 503);
        const { binding } = await auth.wallet();
        const c = await promoEngine.getClaim(claimMatch[1]);
        if (!c || addressKey(c.walletAddress) !== binding.walletKey) return err('NOT_FOUND', 'claim not found', 404);
        return ok(c);
      }

      const balMatch = method === 'GET' && pathname.match(/^\/api\/promo\/balance\/(.+)$/);
      if (balMatch) {
        if (!promoEngine) return err('PROMO_DISABLED', 'promo hot wallet not configured', 503);
        const { walletAddress } = await auth.wallet(decodeURIComponent(balMatch[1]));
        return ok(await promoEngine.getBalance(walletAddress));
      }

      // Presale hot-wallet (A9 fixed-rate exchange; real entry stays closed in the UI)
      const pqMatch = method === 'GET' && pathname.match(/^\/api\/presale\/quota\/(.+)$/);
      if (pqMatch) {
        if (!presaleEngine) return err('PRESALE_DISABLED', 'presale hot wallet not configured', 503);
        const { walletAddress } = await auth.wallet(decodeURIComponent(pqMatch[1]));
        return ok(await presaleEngine.getQuota(walletAddress, nowSec));
      }

      if (method === 'POST' && pathname === '/api/presale/intent') {
        if (!presaleEngine) return err('PRESALE_DISABLED', 'presale hot wallet not configured', 503);
        const { identity, walletAddress } = await auth.wallet(body?.walletAddress || null);
        const amount = body?.tonAmount ?? body?.gramAmount;
        if (amount === undefined || amount === null || amount === '') return err('BAD_REQUEST', 'gramAmount required', 400);
        const rawRef = String(body?.referrerId || '').trim() || null;
        if (socialStore && rawRef) await socialStore.bindReferral(walletAddress, rawRef, nowSec);
        const effectiveRef = socialStore ? await socialStore.getReferrer(walletAddress) : null;
        return ok(await presaleEngine.createOrderIntent(walletAddress, amount, nowSec, { referrerId: effectiveRef, tgUserId: identity.telegramUserId }));
      }

      const poMatch = method === 'GET' && pathname.match(/^\/api\/presale\/orders\/(.+)$/);
      if (poMatch) {
        if (!presaleEngine) return err('PRESALE_DISABLED', 'presale hot wallet not configured', 503);
        const { walletAddress } = await auth.wallet(decodeURIComponent(poMatch[1]));
        return ok(await presaleEngine.listOrders(walletAddress));
      }

      // Warm-up & Team social endpoints (acting wallet always comes from the verified binding)
      if (method === 'POST' && pathname === '/api/warmup/register') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const { walletAddress } = await auth.wallet(body?.walletAddress || null);
        return ok(await socialStore.registerWarmup({ roundId: body?.roundId, walletAddress, referrerId: body?.referrerId || null }, nowSec));
      }

      if (method === 'POST' && pathname === '/api/warmup/cancel') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const { walletAddress } = await auth.wallet(body?.walletAddress || null);
        return ok(await socialStore.cancelWarmup({ roundId: body?.roundId, walletAddress }, nowSec));
      }

      if (method === 'GET' && pathname === '/api/warmup/leaderboard') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const roundId = Number(query.roundId || stateStore.getProtocolState().currentRoundId || 1);
        return ok(await socialStore.getWarmupLeaderboard(roundId, 50));
      }

      if (method === 'POST' && pathname === '/api/team/bind-tg') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const { walletAddress } = await auth.wallet(body?.captainWallet || null);
        // NOTE: real Telegram group/admin verification lands in phase 6 (P5-2). Until then the
        // store records the request but must not report it as verified (see social store).
        return ok(await socialStore.createOrBindTeamGroup({
          teamId: body?.teamId, name: body?.name, captainWallet: walletAddress, tgGroupHandle: body?.tgGroupHandle, tgChatId: body?.tgChatId ?? null,
        }, nowSec));
      }

      if (method === 'POST' && pathname === '/api/team/join') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const { walletAddress } = await auth.wallet(body?.walletAddress || null);
        return ok(await socialStore.joinTeam({ teamId: body?.teamId, walletAddress, referrerId: body?.referrerId || null }, nowSec));
      }

      const teamMatch = method === 'GET' && pathname.match(/^\/api\/team\/(.+)$/);
      if (teamMatch) {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        return ok(await socialStore.getTeamByWallet(decodeURIComponent(teamMatch[1])));
      }

      // 24H PASS/BURN prediction (free entry). userId = verified Telegram user id, never the body.
      if (method === 'POST' && pathname === '/api/prediction/bet') {
        if (!predictionEngine) return err('PREDICTION_DISABLED', 'prediction engine not configured', 503);
        const id = await auth.telegram();
        if (body?.userId && String(body.userId) !== id.telegramUserId) return err('FORBIDDEN', 'userId does not match the signed-in Telegram user', 403);
        const ref = String(body?.referrerId || '').trim() || null;
        if (socialStore && ref) await socialStore.bindReferral(id.telegramUserId, ref, nowSec);
        return ok(await predictionEngine.placeBet({
          roundId: body?.roundId, userId: id.telegramUserId, side: body?.side, guessSlots: body?.guessSlots ?? null, referrerId: ref,
        }, nowSec));
      }

      const predStatsMatch = method === 'GET' && pathname.match(/^\/api\/prediction\/round\/(\d+)$/);
      if (predStatsMatch) {
        if (!predictionEngine) return err('PREDICTION_DISABLED', 'prediction engine not configured', 503);
        return ok(await predictionEngine.getRoundStats(Number(predStatsMatch[1])));
      }

      const predUserMatch = method === 'GET' && pathname.match(/^\/api\/prediction\/user\/(.+)$/);
      if (predUserMatch) {
        if (!predictionEngine) return err('PREDICTION_DISABLED', 'prediction engine not configured', 503);
        const id = await auth.telegram();
        const requested = decodeURIComponent(predUserMatch[1]);
        if (requested !== 'me' && requested !== id.telegramUserId) return err('FORBIDDEN', 'cannot read another user\'s prediction record', 403);
        const roundId = query.roundId ? Number(query.roundId) : stateStore.getProtocolState().currentRoundId;
        return ok(await predictionEngine.getUserSummary(id.telegramUserId, roundId));
      }

      if (method === 'POST' && pathname === '/api/prediction/activate') {
        if (!predictionEngine) return err('PREDICTION_DISABLED', 'prediction engine not configured', 503);
        const { identity, walletAddress } = await auth.wallet(body?.walletAddress || null);
        if (body?.userId && String(body.userId) !== identity.telegramUserId) return err('FORBIDDEN', 'userId does not match the signed-in Telegram user', 403);

        // Anti-sybil real-capital check (unchanged rule): >= 1 COMPLETED fixed-rate exchange order
        // (payout confirmed on chain) OR >= 1 on-chain StakeTicket for the VERIFIED wallet.
        const hasCompletedPresale = presaleEngine ? await presaleEngine.hasCompletedPurchase(walletAddress) : false;
        let hasStakeTicket = false;
        if (!hasCompletedPresale && userReader) {
          const portfolio = await userReader(walletAddress);
          hasStakeTicket = Array.isArray(portfolio?.tickets) && portfolio.tickets.length > 0;
        }
        return ok(
          await predictionEngine.activateToPromo(identity.telegramUserId, walletAddress, promoEngine, {
            qualified: hasCompletedPresale || hasStakeTicket,
            nowMs: nowSec * 1000,
          }),
        );
      }

      // Admin: anomalous inbound transfers (no valid order / wrong sender / amount mismatch ...)
      if (pathname === '/api/admin/presale/anomalies' || pathname.startsWith('/api/admin/presale/anomalies/')) {
        const expectedToken = String(env.A9_ADMIN_TOKEN || '').trim();
        const providedToken = extractAdminToken(headers);
        if (!expectedToken || !providedToken || providedToken !== expectedToken) {
          return err('UNAUTHORIZED', 'invalid or missing admin token', 401);
        }
        if (!presaleEngine) return err('PRESALE_DISABLED', 'presale hot wallet not configured', 503);
        if (method === 'GET' && pathname === '/api/admin/presale/anomalies') {
          const list = await presaleEngine.listAnomalies(query.status || 'OPEN');
          return ok(list);
        }
        const m = method === 'POST' && pathname.match(/^\/api\/admin\/presale\/anomalies\/([^/]+)\/resolve$/);
        if (m) {
          return ok(await presaleEngine.resolveAnomaly(decodeURIComponent(m[1]), {
            decision: body?.decision, faultParty: body?.faultParty, operator: body?.operator, note: body?.note,
          }, nowSec));
        }
        return err('NOT_FOUND', 'route not found', 404);
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
          targetUsd: detail?.targetPriceUsdE8 ? `$${(Number(detail.targetPriceUsdE8) / 1e8).toFixed(4)}` : '--',
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
      if (e instanceof AuthError) return err(e.code, e.message, e.status || 401);
      if (e instanceof PromoError || e instanceof PresaleError || e instanceof GrowthError) {
        return err(e.code, e.message, 400);
      }
      return err('INTERNAL_ERROR', e.message || 'internal error', 500);
    }
  };
}
