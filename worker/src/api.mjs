// A9 Protocol v15 — Unified API router (compatible with Cloudflare Worker & Node HTTP).
// Uses `await` on all storage/engine calls to support both sync in-memory engines and async D1 stores.
import { buildV15ConfigPayload, mapV15RoundDetail, computeTicketClaimPreview } from './v15-indexer.mjs';
import { PromoError } from './promo-hotwallet.mjs';
import { PresaleError } from './presale-hotwallet.mjs';
import { BudgetError } from './promo-budget.mjs';
import {
  ChestError,
  CHEST_MALL_CATALOG,
  PAID_CHEST_CRIT_TIERS,
  FREE_CHEST_CHAIN,
  CAPTAIN_FOUNDING_BONUS_RAW,
  CAPTAIN_MIN_TG_MEMBERS,
  CAPTAIN_MIN_TEAM_MEMBERS,
  CHEST_DELIVERY_GAS_GRAM,
  CHEST_DELIVERY_GAS_NANO,
  CHEST_REFUND_GAS_GRAM,
  CHEST_REFUND_GAS_NANO,
  summarizeUserChestHoldings,
} from './chest-engine.mjs';
import { GrowthError, renderOgCardPng, renderOgCardSvg, renderOgLandingHtml } from './growth-engine.mjs';
import { SocialError, parseStartAppParam, createTelegramBotGroupVerifier } from './social-store.mjs';
import { AuthError, MemoryIdentityStore, allowedProofDomains, createRequestAuth, expectedChainId, verifyTonProof } from './auth.mjs';
import { TelegramBroadcaster } from './tg-broadcaster.mjs';
import { addressKey, normalizeTonAddress } from './ton-address.mjs';

function ok(data, status = 200) {
  return { status, body: { ok: true, data, ts: Date.now() } };
}

function publicBinding(b) {
  if (!b) return null;
  return {
    address: b.walletAddress,
    walletKey: b.walletKey,
    boundAt: b.boundAt,
    pendingSwitch: b.pending ? { address: b.pending.walletAddress, effectiveAt: b.pending.effectiveAt } : null,
  };
}

/**
 * 战队视图权限裁剪（P0-H）：
 * 仅对战队队长本人返回内部 tgChatId；普通成员仅可见战队公开/成员信息，绝不泄露内部群 ID。
 */
function sanitizeTeamView(team, viewerWalletKey) {
  if (!team) return null;
  const isCaptain = Boolean(viewerWalletKey) && addressKey(team.captainWallet) === viewerWalletKey;
  const base = {
    teamId: team.teamId,
    name: team.name,
    captainWallet: team.captainWallet,
    tgGroupHandle: team.tgGroupHandle || null,
    bindStatus: team.bindStatus,
    memberCount: Number(team.memberCount || 0),
    tgMemberCount: Number(team.tgMemberCount || 0),
    role: isCaptain ? 'captain' : 'member',
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
  if (isCaptain) base.tgChatId = team.tgChatId || null;
  return base;
}

/** 公开宝箱查询脱敏：移除宝箱主 TG ID、钱包键与订单号，防隐私关联泄露。 */
function sanitizePublicChest(chest) {
  if (!chest || typeof chest !== 'object') return chest;
  const { ownerUserId: _u, ownerWalletKey: _w, orderId: _o, ...pub } = chest;
  return pub;
}

function formatWholeA9FromRaw(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const n = BigInt(String(raw));
    if (n <= 0n) return null;
    return (n / 1_000_000_000n).toLocaleString('en-US');
  } catch {
    return null;
  }
}

function formatExactA9FromRaw(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const n = BigInt(String(raw));
    if (n <= 0n) return null;
    const whole = (n / 1_000_000_000n).toLocaleString('en-US');
    const frac = String(n % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  } catch {
    return null;
  }
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

function timingSafeEqualStr(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function extractHeader(headers = {}, targetName = '') {
  const want = String(targetName || '').toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (String(k).toLowerCase() === want && v !== undefined && v !== null) {
      return String(v).trim();
    }
  }
  return '';
}

function resolveTicketRoundRange(query = {}, stateStore = null) {
  const ps = stateStore?.getProtocolState?.() || null;
  let currentRoundId = Number(ps?.currentRoundId || 0);
  if (!Number.isInteger(currentRoundId) || currentRoundId < 0) currentRoundId = 0;
  if (currentRoundId === 0) {
    const listed = stateStore?.listRounds?.() || [];
    for (const r of listed) {
      const id = Number(r?.roundId || 0);
      if (Number.isInteger(id) && id > currentRoundId) currentRoundId = id;
    }
  }

  const hasFrom = query.fromRound !== undefined && query.fromRound !== null && String(query.fromRound).trim() !== '';
  const hasTo = query.toRound !== undefined && query.toRound !== null && String(query.toRound).trim() !== '';

  let fromRound = null;
  let toRound = null;
  if (hasFrom || hasTo) {
    fromRound = hasFrom ? Number(query.fromRound) : 1;
    toRound = hasTo ? Number(query.toRound) : (currentRoundId > 0 ? currentRoundId : fromRound);
    if (!Number.isInteger(fromRound) || fromRound < 1 || !Number.isInteger(toRound) || toRound < 1 || fromRound > toRound) {
      return { error: 'fromRound and toRound must be positive integers with fromRound <= toRound' };
    }
    if (toRound - fromRound + 1 > 10) {
      return { error: 'ticket round range cannot exceed 10 rounds per request' };
    }
  } else if (currentRoundId > 0) {
    // 默认覆盖最近 8 轮，确保最坏情况也不撞穿 Workers 50 Subrequest 上限
    toRound = currentRoundId;
    fromRound = Math.max(1, currentRoundId - 7);
  }

  const roundIds = [];
  if (fromRound !== null && toRound !== null) {
    for (let id = fromRound; id <= toRound; id += 1) roundIds.push(id);
  }
  return { fromRound, toRound, currentRoundId, roundIds };
}

async function checkRunnerHeartbeatGate(roles, env, runnerHeartbeatReader, nowSec) {
  if (env?.A9_REQUIRE_RUNNER_HEARTBEAT !== '1') return { ok: true };
  if (typeof runnerHeartbeatReader !== 'function') {
    return { ok: false, reason: 'runner heartbeat reader unavailable' };
  }
  const maxStaleSec = Math.max(30, Number(env.A9_RUNNER_HEARTBEAT_MAX_STALE_SEC || 120));
  let rows = [];
  try {
    rows = (await runnerHeartbeatReader()) || [];
  } catch (e) {
    return { ok: false, reason: e?.message || 'failed to query runner heartbeats' };
  }
  const expectedNetwork = String(env?.A9_NETWORK || '').trim().toLowerCase();
  const matched = rows.filter((r) => roles.includes(String(r.role || '').toLowerCase()));
  if (!matched.length) {
    return { ok: false, reason: `no heartbeat recorded for roles: ${roles.join('/')}` };
  }
  let newestOkAt = 0;
  for (const r of matched) {
    const rowNet = String(r.network || '').trim().toLowerCase();
    if (expectedNetwork && rowNet !== expectedNetwork) continue;
    let meta = r.meta && typeof r.meta === 'object' ? r.meta : null;
    if (!meta && typeof r.meta_json === 'string' && r.meta_json.trim()) {
      try { meta = JSON.parse(r.meta_json); } catch { continue; }
    }
    const status = String(r.status ?? meta?.status ?? 'ok').toLowerCase();
    // P1-2: 仅认可 status === 'ok' 且非 DRY-RUN（executeLive !== false）的同网心跳
    if (status !== 'ok') continue;
    if (meta && meta.executeLive === false) continue;
    const ts = Number(r.lastSeenAt ?? r.last_seen_at ?? r.lastOkAt ?? r.last_ok_at ?? r.lastTickAt ?? 0);
    if (Number.isFinite(ts) && ts > newestOkAt) newestOkAt = ts;
  }
  if (!newestOkAt || nowSec - newestOkAt > maxStaleSec) {
    return {
      ok: false,
      reason: newestOkAt
        ? `payout runner heartbeat stale (${Math.max(0, nowSec - newestOkAt)}s > ${maxStaleSec}s)`
        : 'payout runner has no healthy heartbeat',
    };
  }
  return { ok: true, lastSeenAt: newestOkAt };
}

export function createApiRouter({
  env = {},
  stateStore,
  promoEngine = null,
  presaleEngine = null,
  socialStore = null,
  predictionEngine = null,
  progressionEngine = null,
  chestEngine = null,
  budgetLedger = null,
  userReader = null,
  identityStore = new MemoryIdentityStore(),
  publicKeyResolver = null,
  walletStateResolver = null,
  telegramGroupVerifier = null,
  broadcaster = null,
  healthChecker = null,
  runnerHeartbeatReader = null,
  candleWriter = null,
}) {
  // M-5: 24h 换绑冷静期到期晋升时自动将旧钱包推广余额原子合并至新钱包，且仅在无在途领奖单时放行晋升
  if (promoEngine && typeof promoEngine.mergeBalance === 'function' && identityStore && typeof identityStore === 'object' && !identityStore.onWalletRebound) {
    identityStore.onWalletRebound = async ({ fromWalletAddress, toWalletAddress, nowSec: rebindNow }) => {
      await promoEngine.mergeBalance(fromWalletAddress, toWalletAddress, rebindNow);
    };
  }
  if (promoEngine && typeof promoEngine.hasPendingClaim === 'function' && identityStore && typeof identityStore === 'object' && !identityStore.canPromoteRebind) {
    identityStore.canPromoteRebind = async ({ fromWalletAddress, nowSec: rebindNow }) =>
      !(await promoEngine.hasPendingClaim(fromWalletAddress, rebindNow));
  }
  return async function handleRequest({ method, pathname, query = {}, body = null, headers = {}, origin = '', nowSec = Math.floor(Date.now() / 1000) }) {
    const auth = createRequestAuth({ env, headers, identityStore, nowSec });
    try {
      if (method === 'GET' && pathname === '/api/health') {
        if (typeof healthChecker === 'function') {
          const checks = await healthChecker({ nowSec });
          const healthy = checks?.ok !== false;
          const isAdmin = Boolean(env.A9_ADMIN_TOKEN) && timingSafeEqualStr(extractAdminToken(headers), env.A9_ADMIN_TOKEN);
          const safeChecks = isAdmin
            ? checks
            : {
                ok: healthy,
                db: checks?.db ? { bound: Boolean(checks.db.bound), ok: Boolean(checks.db.ok) } : undefined,
                cacheAgeSec: checks?.cacheAgeSec ?? null,
                runnerHeartbeats: Array.isArray(checks?.runnerHeartbeats)
                  ? checks.runnerHeartbeats.map((r) => ({
                      runnerId: r.runnerId,
                      role: r.role,
                      network: r.network,
                      lastSeenAt: r.lastSeenAt,
                      meta: r.meta ? { status: String(r.meta.status || 'ok') } : null,
                    }))
                  : [],
              };
          return ok(
            {
              service: 'a9mini-v15-worker',
              status: healthy ? 'ok' : 'degraded',
              version: '16.2.0',
              checks: safeChecks,
            },
            healthy ? 200 : 503,
          );
        }
        return ok({ service: 'a9mini-v15-worker', status: 'ok', version: '16.2.0' });
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
              deliveryFeeNano: presaleEngine.deliveryFeeNano.toString(),
              refundFeeNano: presaleEngine.refundFeeNano.toString(),
              open: presaleEngine.open,
            }
          : { enabled: false, address: null, rateA9PerTon: null, rateA9PerGram: null, open: false };
        base.chestMall = {
          enabled: Boolean(chestEngine),
          skus: Object.values(CHEST_MALL_CATALOG),
          critTiers: PAID_CHEST_CRIT_TIERS,
          deliveryFeeGram: CHEST_DELIVERY_GAS_GRAM,
          deliveryFeeNano: CHEST_DELIVERY_GAS_NANO,
          refundFeeGram: CHEST_REFUND_GAS_GRAM,
          refundFeeNano: CHEST_REFUND_GAS_NANO,
          freeTiers: FREE_CHEST_CHAIN,
          captainFoundingBonusRaw: CAPTAIN_FOUNDING_BONUS_RAW.toString(),
          captainMinTgMembers: CAPTAIN_MIN_TG_MEMBERS,
          captainMinTeamMembers: CAPTAIN_MIN_TEAM_MEMBERS,
        };
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

      if (method === 'GET' && pathname === '/api/me/notifications') {
        const id = await auth.telegram();
        if (!socialStore || typeof socialStore.getNotificationPrefs !== 'function') {
          return ok({
            tgUserId: id.telegramUserId,
            settlementPush: true,
            hourlyCandlePush: false,
            subscribedExplicitly: false,
            updatedAt: null,
          });
        }
        return ok(await socialStore.getNotificationPrefs(id.telegramUserId));
      }

      if (method === 'POST' && pathname === '/api/me/notifications') {
        const id = await auth.telegram();
        if (typeof body?.settlementPush !== 'boolean') {
          return err('BAD_REQUEST', 'settlementPush boolean is required', 400);
        }
        if (!socialStore || typeof socialStore.setNotificationPrefs !== 'function') {
          return err('SERVICE_UNAVAILABLE', 'notification store unavailable', 503);
        }
        return ok(await socialStore.setNotificationPrefs(id.telegramUserId, { settlementPush: body.settlementPush }, nowSec));
      }

      if (method === 'POST' && pathname === '/api/telegram/webhook') {
        const expectedSecret = String(env.A9_TG_WEBHOOK_SECRET || '').trim();
        if (!expectedSecret) {
          return err('WEBHOOK_NOT_CONFIGURED', 'telegram webhook secret is not configured', 503);
        }
        const providedSecret = extractHeader(headers, 'x-telegram-bot-api-secret-token');
        if (!timingSafeEqualStr(providedSecret, expectedSecret)) {
          return err('UNAUTHORIZED', 'invalid telegram webhook secret token', 401);
        }

        const msg = body?.message || body?.edited_message || null;
        if (!msg?.text || msg?.chat?.id === undefined || msg?.chat?.id === null) {
          return ok({ handled: false, ignored: true });
        }

        const cmdMatch = String(msg.text).trim().match(/^\/(start|status|help)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
        if (!cmdMatch) {
          return ok({ handled: false, ignored: true });
        }

        const command = cmdMatch[1].toLowerCase();
        const rawArg = String(cmdMatch[2] || '').trim().split(/\s+/)[0] || '';
        const chatId = String(msg.chat.id);
        const chatType = String(msg.chat.type || 'private').toLowerCase();
        const fromUserId = msg.from?.id ? String(msg.from.id) : null;
        const replyToMessageId = msg.message_id ?? null;
        const botHandle = String(env.A9_TG_BOT_HANDLE || 'A9_TonBot').replace(/^@/, '').trim() || 'A9_TonBot';

        let replyText = '';
        let buttonText = null;
        let buttonUrl = null;

        if (command === 'start') {
          if (chatType === 'private' && fromUserId && socialStore && typeof socialStore.ensureDefaultNotificationPrefs === 'function') {
            try {
              await socialStore.ensureDefaultNotificationPrefs(fromUserId, nowSec);
            } catch {
              // ignore non-critical notification init error
            }
          }
          const safePayload = /^[A-Za-z0-9_-]{1,64}$/.test(rawArg) ? rawArg : null;
          if (safePayload && fromUserId && socialStore && typeof socialStore.bindReferral === 'function') {
            const parsed = parseStartAppParam(safePayload);
            if (parsed?.referrerId) {
              try {
                await socialStore.bindReferral(fromUserId, parsed.referrerId, nowSec);
              } catch {
                // ignore self/cycle referral rejections
              }
            }
          }
          const lines = [
            'A9 · 财富大冒险官方助手（TON v16.2）',
            '1. 新人 0 GRAM 秒开 200 A9 青铜新手箱并参与 24H 预言擂台（5 阶免费箱最高 200,000 A9）',
            '2. 宝箱商城 0.99–500 GRAM 共 6 档纯整数 A9 保底直发、不限个人购箱额度，免助力随机暴击最高 +300,000 A9',
            '3. 链上质押满 16/24 时段通关退 100% 本金 + 20% 秒领 + 余下 80% 分 40 天按秒线性释放，未达标销毁当轮本金 BURN',
          ];
          if (chatType === 'private') {
            lines.push('默认已开启轮次结算私聊提醒，可在小程序「我的 -> 系统设置」随时开关。');
          }
          replyText = lines.join('\n');
          buttonText = '打开 A9 · 财富大冒险';
          buttonUrl = `https://t.me/${botHandle}?startapp=${encodeURIComponent(safePayload || 'market')}`;
        } else if (command === 'status') {
          const ps = stateStore?.getProtocolState?.() || null;
          const curId = Number(ps?.currentRoundId || 0);
          const item = curId > 0 ? stateStore?.getRound?.(curId) : null;
          const detail = item ? mapV15RoundDetail(curId, item.round, item.candles, nowSec, stateStore.getTiming()) : null;
          if (!ps?.dataAvailable || !detail) {
            replyText = '当前链上轮次数据待核验（尚未开轮或正在同步 TonCenter 节点，绝不展示模拟数值）。请稍后再试或进入小程序核验。';
            buttonText = '进入小程序查看链上状态';
            buttonUrl = `https://t.me/${botHandle}?startapp=market`;
          } else {
            const targetUsdNum = detail.targetPriceUsdE8 ? Number(detail.targetPriceUsdE8) : 0;
            const targetUsdStr = targetUsdNum > 0 ? `$${(targetUsdNum / 1e8).toFixed(4)}` : '待核验';
            const poolStr = formatWholeA9FromRaw(detail.rewardBudgetRaw) || '待核验';
            const qualified = Number(detail.qualifiedCandles ?? 0);
            replyText = [
              `第 #${curId} 轮链上战况（v16.2）`,
              `轮次阶段：${detail.state}`,
              `目标底价：${targetUsdStr}`,
              `本轮奖励池：${poolStr} A9（单轮上限 15x）`,
              `24H 达标进度：${qualified}/24 时段（>= 16 通关派奖，< 16 销毁 BURN）`,
            ].join('\n');
            buttonText = `查看第 #${curId} 轮实时走势`;
            buttonUrl = `https://t.me/${botHandle}?startapp=${encodeURIComponent(`round_${curId}`)}`;
          }
        } else {
          replyText = [
            'A9 · 财富大冒险 Bot 命令与安全指南',
            '/start — 打开 Mini App 并绑定邀请归因',
            '/status — 实时查询链上轮次与 24H 达标进度',
            '/help — 查看玩法规则与资金安全红线',
            '核心规则：24H TWAP 达标 >= 16/24 时段通关，未达标本金与半数奖池执行销毁 BURN；超 7 天未结算支持无许可 AbortRound 退回本金。',
            '安全提示：严禁未下单直接向热钱包转账；商城购箱含 +0.06 GRAM 配送 Gas，逾期/异常自动退款固定扣除 0.03 GRAM Gas。',
          ].join('\n');
          buttonText = '阅读完整闯关指南';
          buttonUrl = `https://t.me/${botHandle}?startapp=rules`;
        }

        const replySender =
          broadcaster && typeof broadcaster.sendBotReply === 'function'
            ? broadcaster
            : (env.A9_BOT_TOKEN
                ? new TelegramBroadcaster({ enabled: false, botToken: env.A9_BOT_TOKEN, botHandle })
                : null);
        const sendRes = replySender
          ? await replySender.sendBotReply({ chatId, text: replyText, buttonText, buttonUrl, replyToMessageId })
          : { sent: false, reason: 'NO_BROADCASTER' };

        return ok({
          handled: true,
          command,
          chatId,
          replied: Boolean(sendRes?.sent),
          sendReason: sendRes?.reason || null,
          replyText,
        });
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
          walletStateResolver,
          nowSec,
        });
        if (purpose === 'bind') {
          // M-5: 若当前钱包存在在途推广领奖（PENDING_GAS/GAS_CONFIRMED/PAYOUT_SENT），阻断发起换绑
          const existingBinding = await identityStore.getBinding(id.telegramUserId, nowSec);
          if (
            existingBinding &&
            addressKey(address) !== existingBinding.walletKey &&
            promoEngine &&
            typeof promoEngine.hasPendingClaim === 'function' &&
            (await promoEngine.hasPendingClaim(existingBinding.walletAddress, nowSec))
          ) {
            return err('PENDING_CLAIM_ACTIVE', 'cannot initiate wallet rebind while a promo claim is in progress', 409);
          }
          const res = await identityStore.bindVerifiedWallet(id.telegramUserId, address, nowSec);
          if (socialStore && typeof socialStore.syncWarmupWalletForUser === 'function') {
            try {
              let walletActive = false;
              if (walletStateResolver) {
                const ws = await walletStateResolver(address).catch(() => null);
                walletActive = ws?.state === 'active';
              }
              const synced = await socialStore.syncWarmupWalletForUser(
                { tgUserId: id.telegramUserId, walletAddress: address, walletActive },
                nowSec,
              );
              if (chestEngine && typeof chestEngine.syncWarmupChestProgress === 'function') {
                for (const item of synced || []) {
                  if (item?.referrerUpdated) {
                    const cfg = typeof socialStore.getWarmupRoundConfig === 'function'
                      ? await socialStore.getWarmupRoundConfig(item.roundId)
                      : {};
                    await chestEngine.syncWarmupChestProgress(
                      {
                        userId: item.referrerUpdated.tgUserId,
                        roundId: item.roundId,
                        validInvites: item.referrerUpdated.validInvites,
                        config: {
                          baseA9Raw: cfg.chestBaseA9Raw,
                          stepA9Raw: cfg.chestStepA9Raw,
                          minInvites: cfg.chestMinInvites,
                          maxInvites: cfg.chestMaxInvites,
                        },
                      },
                      nowSec,
                    );
                  }
                }
              }
            } catch (_) {
              // 预热钱包回溯不阻断主钱包绑定成功返回
            }
          }
          return ok({ telegramUserId: id.telegramUserId, status: res.status, wallet: publicBinding(res.binding), keySource: verified.keySource });
        }
        const cur = await identityStore.getBinding(id.telegramUserId, nowSec);
        if (!cur || addressKey(address) !== cur.walletKey) {
          return err('FORBIDDEN', 'this action needs a proof from the currently bound wallet', 403);
        }
        if (purpose === 'unbind') {
          // M-5: 钱包存在未领取推广余额或在途领奖单时禁止解绑，防止资产孤立
          if (promoEngine) {
            const bal = await promoEngine.getBalance(cur.walletAddress);
            const claimable = BigInt(bal?.claimableRaw || '0');
            const hasPending = typeof promoEngine.hasPendingClaim === 'function'
              ? await promoEngine.hasPendingClaim(cur.walletAddress, nowSec)
              : false;
            if (claimable > 0n || hasPending) {
              return err('PROMO_BALANCE_UNCLAIMED', 'please claim your pending promo balance before unbinding wallet', 409);
            }
          }
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
        const envName = String(env.A9_ENVIRONMENT || '').trim().toLowerCase();
        const netName = String(env.A9_NETWORK || '').trim().toLowerCase();
        const strictWalletCheck =
          Boolean(String(env.TONCENTER_API_BASE || '').trim()) ||
          envName === 'production' ||
          envName === 'candidate' ||
          netName === 'mainnet';
        if (strictWalletCheck && !normalizeTonAddress(wallet)) {
          return err('BAD_REQUEST', 'invalid TON wallet address', 400);
        }
        const range = resolveTicketRoundRange(query, stateStore);
        if (range.error) return err('BAD_REQUEST', range.error, 400);
        let onchain = { jettonWallet: null, a9BalanceRaw: null, balanceAvailable: false, tickets: [], ticketsAvailable: false, onchainAvailable: false };
        if (userReader) {
          try {
            const read = await userReader(wallet, {
              fromRound: range.fromRound,
              toRound: range.toRound,
              roundIds: range.roundIds,
            });
            if (read && typeof read === 'object') onchain = read;
          } catch (_) {
            // 链上查询异常时保留 null 与不可用标记，绝不返回余额 0（P0-G）。
          }
        }
        const psForPreview = stateStore?.getProtocolState?.() || null;
        const timingForPreview = stateStore?.getTiming?.() || {};
        let totalClaimableRaw = 0n;
        let totalLockedRaw = 0n;
        const enrichedTickets = Array.isArray(onchain.tickets)
          ? onchain.tickets.map((t) => {
              const roundItem = stateStore?.getRound?.(t.roundId) || null;
              const preview = computeTicketClaimPreview(t, roundItem?.round || null, psForPreview, nowSec, timingForPreview);
              totalClaimableRaw += BigInt(preview.claimableTotalRaw || '0');
              totalLockedRaw += BigInt(preview.lockedRemainingRaw || '0');
              return { ...t, ...preview };
            })
          : [];
        let owner = false;
        let viewerKey = null;
        try {
          const verifiedWallet = await auth.wallet(wallet);
          owner = true;
          viewerKey = verifiedWallet.binding.walletKey;
        } catch (_) {
          owner = false;
        }
        const promo = owner && promoEngine ? await promoEngine.getBalance(wallet) : null;
        const presaleQuota = owner && presaleEngine ? await presaleEngine.getQuota(wallet, nowSec) : null;
        const rawTeam = owner && socialStore ? await socialStore.getTeamByWallet(wallet) : null;
        const team = sanitizeTeamView(rawTeam, viewerKey);
        return ok({
          walletAddress: wallet,
          ...onchain,
          tickets: enrichedTickets,
          claimableRaw: onchain.ticketsAvailable ? totalClaimableRaw.toString() : null,
          lockedRaw: onchain.ticketsAvailable ? totalLockedRaw.toString() : null,
          ticketRange: {
            fromRound: range.fromRound,
            toRound: range.toRound,
            currentRoundId: range.currentRoundId,
          },
          promo,
          presaleQuota,
          team,
          privateDataVisible: owner,
        });
      }

      // Promo hot-wallet (0.06 GRAM user-covered gas)
      if (method === 'POST' && pathname === '/api/promo/intent') {
        if (!promoEngine) return err('PROMO_DISABLED', 'promo hot wallet not configured', 503);
        const hb = await checkRunnerHeartbeatGate(['promo', 'payout_daemon', 'daemon'], env, runnerHeartbeatReader, nowSec);
        if (!hb.ok) return err('PAYOUT_RUNNER_OFFLINE', `推广出账进程离线或心跳超时：${hb.reason}`, 503);
        const { binding, walletAddress } = await auth.wallet(body?.walletAddress || null);
        if (binding?.pending) {
          return err('PENDING_REBIND_ACTIVE', 'cannot create promo claim intent while a wallet rebind is pending; cancel rebind or wait for switch', 409);
        }
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
        if (presaleEngine.open) {
          const hb = await checkRunnerHeartbeatGate(['presale', 'payout_daemon', 'daemon'], env, runnerHeartbeatReader, nowSec);
          if (!hb.ok) return err('PAYOUT_RUNNER_OFFLINE', `出账签名进程离线或心跳超时：${hb.reason}`, 503);
        }
        const skuId = body?.skuId ? String(body.skuId).trim() : null;
        const openMode = body?.openMode ? String(body.openMode).trim().toUpperCase() : null;
        const amount = body?.tonAmount ?? body?.gramAmount;
        if (!skuId && (amount === undefined || amount === null || amount === '')) {
          return err('BAD_REQUEST', 'gramAmount or skuId required', 400);
        }
        const rawRef = String(body?.referrerId || '').trim() || null;
        if (socialStore && rawRef) await socialStore.bindReferral(walletAddress, rawRef, nowSec, { aliases: [identity.telegramUserId] });
        const effectiveRef = socialStore ? ((await socialStore.getReferrer(walletAddress)) || (await socialStore.getReferrer(identity.telegramUserId))) : null;
        return ok(await presaleEngine.createOrderIntent(walletAddress, amount ?? null, nowSec, { referrerId: effectiveRef, tgUserId: identity.telegramUserId, skuId, openMode }));
      }

      const poMatch = method === 'GET' && pathname.match(/^\/api\/presale\/orders\/(.+)$/);
      if (poMatch) {
        if (!presaleEngine) return err('PRESALE_DISABLED', 'presale hot wallet not configured', 503);
        const { walletAddress } = await auth.wallet(decodeURIComponent(poMatch[1]));
        return ok(await presaleEngine.listOrders(walletAddress));
      }

      // Warm-up v2: Pre-Round Reservations, Intent Tiers & Viral Warm-Up Chests (zero contract changes)
      const resolveUpcomingWarmupRoundId = () => {
        const ps = stateStore?.getProtocolState?.() || null;
        const curId = Number(ps?.currentRoundId || 0);
        if (!Number.isInteger(curId) || curId <= 0) return 1;
        return curId + 1;
      };
      const buildWarmupInviteLink = (rId, tgUid) => {
        const handle = String(env.A9_TG_BOT_HANDLE || 'A9_TonBot').replace(/^@/, '').trim() || 'A9_TonBot';
        return `https://t.me/${handle}?startapp=${encodeURIComponent(`warmup_${rId}_${tgUid}`)}`;
      };

      if (method === 'GET' && pathname === '/api/warmup/current') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const ps = stateStore?.getProtocolState?.() || null;
        const currentOnchainRoundId = Number(ps?.currentRoundId || 0);
        const requestedRoundId = query.roundId ? Number(query.roundId) : resolveUpcomingWarmupRoundId();
        if (!Number.isInteger(requestedRoundId) || requestedRoundId < 1) {
          return err('BAD_REQUEST', 'roundId must be a positive integer', 400);
        }
        const config = typeof socialStore.getWarmupRoundConfig === 'function'
          ? await socialStore.getWarmupRoundConfig(requestedRoundId)
          : { roundId: requestedRoundId, status: 'OPEN', plannedOpenAt: null, targetUsers: 500 };
        const stats = typeof socialStore.getWarmupRoundStats === 'function'
          ? await socialStore.getWarmupRoundStats(requestedRoundId)
          : { roundId: requestedRoundId, totalRegistered: 0, walletBoundCount: 0, activeWalletCount: 0, remindEnabledCount: 0 };

        let myReservation = null;
        let myWarmupChest = null;
        let inviteDeepLink = null;
        try {
          const id = await auth.telegram();
          if (typeof socialStore.getWarmupReservation === 'function') {
            myReservation = await socialStore.getWarmupReservation(requestedRoundId, id.telegramUserId);
          }
          if (chestEngine && typeof chestEngine.getWarmupRoundChest === 'function') {
            myWarmupChest = await chestEngine.getWarmupRoundChest(id.telegramUserId, requestedRoundId);
          }
          inviteDeepLink = buildWarmupInviteLink(requestedRoundId, id.telegramUserId);
        } catch (_) {
          // 匿名浏览仍可查看公开预约人数与目标进度
        }
        return ok({
          roundId: requestedRoundId,
          currentOnchainRoundId,
          open: config.status === 'OPEN',
          config,
          stats,
          myReservation,
          myWarmupChest,
          inviteDeepLink,
        });
      }

      if (method === 'POST' && pathname === '/api/warmup/register') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const id = await auth.telegram();
        const targetRoundId = body?.roundId ? Number(body.roundId) : resolveUpcomingWarmupRoundId();
        if (!Number.isInteger(targetRoundId) || targetRoundId < 1) {
          return err('BAD_REQUEST', 'roundId must be a positive integer', 400);
        }
        const binding = await identityStore.getBinding(id.telegramUserId, nowSec);
        const boundWallet = binding?.walletAddress || null;
        let walletActive = false;
        if (boundWallet && walletStateResolver) {
          try {
            const ws = await walletStateResolver(boundWallet);
            walletActive = ws?.state === 'active';
          } catch (_) {
            walletActive = false;
          }
        }
        const result = await socialStore.reserveWarmup(
          {
            roundId: targetRoundId,
            tgUserId: id.telegramUserId,
            walletAddress: boundWallet,
            walletActive,
            referrerId: body?.referrerId || null,
            intentTier: body?.intentTier,
            remindEnabled: body?.remindEnabled,
          },
          nowSec,
        );
        const roundCfg = typeof socialStore.getWarmupRoundConfig === 'function'
          ? await socialStore.getWarmupRoundConfig(targetRoundId)
          : {};
        const chestCfg = {
          baseA9Raw: roundCfg.chestBaseA9Raw,
          stepA9Raw: roundCfg.chestStepA9Raw,
          minInvites: roundCfg.chestMinInvites,
          maxInvites: roundCfg.chestMaxInvites,
        };
        let warmupChest = null;
        let starterGranted = false;
        if (chestEngine) {
          if (typeof chestEngine.ensureWarmupRoundChest === 'function') {
            const wc = await chestEngine.ensureWarmupRoundChest(
              {
                userId: id.telegramUserId,
                roundId: targetRoundId,
                walletAddress: boundWallet,
                validInvites: result.reservation.validInvites,
                config: chestCfg,
              },
              nowSec,
            );
            warmupChest = wc?.chest || null;
          }
          if (typeof chestEngine.claimStarterBronzeChests === 'function') {
            const st = await chestEngine.claimStarterBronzeChests(
              { userId: id.telegramUserId, walletAddress: boundWallet },
              nowSec,
            );
            starterGranted = Boolean(st?.created);
          }
          if (result.referrerUpdated && typeof chestEngine.syncWarmupChestProgress === 'function') {
            await chestEngine.syncWarmupChestProgress(
              {
                userId: result.referrerUpdated.tgUserId,
                roundId: targetRoundId,
                validInvites: result.referrerUpdated.validInvites,
                config: chestCfg,
              },
              nowSec,
            );
          }
        }
        const stats = typeof socialStore.getWarmupRoundStats === 'function'
          ? await socialStore.getWarmupRoundStats(targetRoundId)
          : null;
        return ok({
          roundId: targetRoundId,
          reservation: result.reservation,
          stats,
          warmupChest,
          starterGranted,
          inviteDeepLink: buildWarmupInviteLink(targetRoundId, id.telegramUserId),
        });
      }

      if (method === 'POST' && pathname === '/api/warmup/cancel') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const id = await auth.telegram();
        const targetRoundId = body?.roundId ? Number(body.roundId) : resolveUpcomingWarmupRoundId();
        const resCancel = await socialStore.cancelWarmupReservation({ roundId: targetRoundId, tgUserId: id.telegramUserId }, nowSec);
        if (resCancel?.referrerUpdated && chestEngine && typeof chestEngine.syncWarmupChestProgress === 'function') {
          const cfg = typeof socialStore.getWarmupRoundConfig === 'function'
            ? await socialStore.getWarmupRoundConfig(targetRoundId)
            : {};
          await chestEngine.syncWarmupChestProgress(
            {
              userId: resCancel.referrerUpdated.tgUserId,
              roundId: targetRoundId,
              validInvites: resCancel.referrerUpdated.validInvites,
              config: {
                baseA9Raw: cfg.chestBaseA9Raw,
                stepA9Raw: cfg.chestStepA9Raw,
                minInvites: cfg.chestMinInvites,
                maxInvites: cfg.chestMaxInvites,
              },
            },
            nowSec,
          );
        }
        const stats = typeof socialStore.getWarmupRoundStats === 'function'
          ? await socialStore.getWarmupRoundStats(targetRoundId)
          : null;
        return ok({ roundId: targetRoundId, reservation: resCancel, stats });
      }

      if (method === 'GET' && pathname === '/api/warmup/leaderboard') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const roundId = Number(query.roundId || resolveUpcomingWarmupRoundId());
        // 步骤 2 口径对齐：移除旧版 WARMUP_TIERS（单轮 800 万 A9）兜底回退，仅返回 v2 预约邀请榜
        if (typeof socialStore.getWarmupLeaderboardV2 === 'function') {
          return ok(await socialStore.getWarmupLeaderboardV2(roundId, 50));
        }
        return ok([]);
      }

      if (method === 'POST' && pathname === '/api/team/bind-tg') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const { walletAddress } = await auth.wallet(body?.captainWallet || null);
        // 仅提交群名时始终进入 verifying 待核验状态，必须经 /api/team/verify-tg 核验机器人入群与管理员权限后才转为 bound
        return ok(await socialStore.createOrBindTeamGroup({
          teamId: body?.teamId, name: body?.name, captainWallet: walletAddress, tgGroupHandle: body?.tgGroupHandle, tgChatId: body?.tgChatId ?? null,
        }, nowSec));
      }

      if (method === 'POST' && pathname === '/api/team/verify-tg') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const { identity, binding, walletAddress } = await auth.wallet(body?.captainWallet || null);
        const verifier = telegramGroupVerifier || createTelegramBotGroupVerifier(env.A9_BOT_TOKEN);
        const team = await socialStore.verifyTeamGroupBinding(
          {
            teamId: body?.teamId,
            captainWallet: walletAddress,
            telegramUserId: identity.telegramUserId,
            telegramVerifier: verifier,
          },
          nowSec,
        );
        const view = sanitizeTeamView(team, binding.walletKey);
        if (chestEngine) {
          view.captainBonus = await chestEngine.grantCaptainFoundingBonus(
            {
              teamId: team.teamId,
              tgChatId: team.tgChatId || null,
              captainUserId: identity.telegramUserId,
              captainWallet: walletAddress,
              tgMemberCount: team.tgMemberCount,
              teamMemberCount: Number(team.memberCount || 0),
              predictionEngine,
              budgetLedger,
            },
            nowSec,
          );
        }
        return ok(view);
      }

      if (method === 'POST' && pathname === '/api/referral/attribution') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const id = await auth.telegram();
        const binding = await identityStore.getBinding(id.telegramUserId, nowSec);
        const aliases = [];
        if (binding?.walletAddress) aliases.push(binding.walletAddress);
        if (binding?.walletKey) aliases.push(binding.walletKey);

        const rawStartApp = body?.startapp ?? body?.startParam ?? null;
        const parsed = rawStartApp !== null && rawStartApp !== undefined && String(rawStartApp).trim() !== ''
          ? parseStartAppParam(rawStartApp)
          : null;
        if (rawStartApp && !parsed) {
          return err('BAD_STARTAPP', 'invalid startapp deep-link parameter', 400);
        }
        const candidateRef = parsed?.referrerId || (body?.referrerId ? String(body.referrerId).trim() : null);
        const bound = candidateRef
          ? await socialStore.bindReferral(id.telegramUserId, candidateRef, nowSec, { aliases })
          : null;
        const currentReferrer = await socialStore.getReferrer(id.telegramUserId)
          || (binding?.walletAddress ? await socialStore.getReferrer(binding.walletAddress) : null);
        return ok({
          telegramUserId: id.telegramUserId,
          parsed,
          bound,
          referrerId: currentReferrer || null,
        });
      }

      if (method === 'POST' && pathname === '/api/team/join') {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const { identity, binding, walletAddress } = await auth.wallet(body?.walletAddress || null);
        const team = await socialStore.joinTeam({ teamId: body?.teamId, walletAddress, referrerId: body?.referrerId || null, aliases: [identity.telegramUserId] }, nowSec);
        return ok(sanitizeTeamView(team, binding.walletKey));
      }

      // 战队查询访问边界（P0-H）：必须为已验签且绑定该钱包的本人，严禁向匿名或跨用户泄露内部 tgChatId、私人关联与后台绑定状态。
      const teamMatch = method === 'GET' && pathname.match(/^\/api\/team\/(.+)$/);
      if (teamMatch) {
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        const requestedWallet = decodeURIComponent(teamMatch[1]);
        const { binding, walletAddress } = await auth.wallet(requestedWallet);
        const team = await socialStore.getTeamByWallet(walletAddress);
        return ok(sanitizeTeamView(team, binding.walletKey));
      }

      // 24H PASS/BURN prediction (M-3: requires bound active TON wallet; userId = verified Telegram user id).
      if (method === 'POST' && pathname === '/api/prediction/bet') {
        if (!predictionEngine) return err('PREDICTION_DISABLED', 'prediction engine not configured', 503);
        const { identity: id, walletAddress } = await auth.wallet(body?.walletAddress || null);
        if (body?.userId && String(body.userId) !== id.telegramUserId) return err('FORBIDDEN', 'userId does not match the signed-in Telegram user', 403);
        if (walletStateResolver) {
          let ws = null;
          try {
            ws = await walletStateResolver(walletAddress);
          } catch (e) {
            return err('WALLET_STATE_UNAVAILABLE', `无法核验钱包链上状态：${e?.message || 'RPC error'}`, 503);
          }
          if (ws?.state !== 'active') {
            return err('WALLET_NOT_ACTIVE', '预测竞猜需要已激活（active）的 TON 链上钱包', 400);
          }
        }

        // 严格依据服务端链上轮次与质押截止时间判断预测窗口（防止观察期明牌后下注）
        const requestedRoundId = Number(body?.roundId);
        const ps = stateStore?.getProtocolState?.() || null;
        if (ps && ps.dataAvailable === false) {
          return err('CHAIN_STATE_UNAVAILABLE', 'on-chain round state unavailable for prediction betting', 503);
        }
        const chainRound = Number.isInteger(requestedRoundId) && requestedRoundId > 0
          ? stateStore?.getRound?.(requestedRoundId)
          : null;
        if (ps?.dataAvailable === true || chainRound) {
          const currentRoundId = Number(ps?.currentRoundId || 0);
          if (!Number.isInteger(requestedRoundId) || requestedRoundId <= 0 || (currentRoundId > 0 && requestedRoundId !== currentRoundId)) {
            return err('ROUND_NOT_OPEN', 'prediction betting is only open for the active on-chain round', 400);
          }
          if (!chainRound || !chainRound.round || Number(chainRound.round.status) !== 1) {
            return err('ROUND_NOT_OPEN', 'target round is not open for prediction betting', 400);
          }
          const stakeOpenAt = Number(chainRound.round.stakeOpenAt || 0);
          const stakeCloseAt = Number(chainRound.round.stakeCloseAt || 0);
          if (stakeOpenAt > 0 && nowSec < stakeOpenAt) {
            return err('ROUND_NOT_OPEN', 'prediction betting has not opened yet', 400);
          }
          if (stakeCloseAt <= 0 || nowSec >= stakeCloseAt) {
            return err('BETTING_CLOSED', 'prediction betting closed when staking ended', 400);
          }
        }

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

        // Anti-sybil real-capital check (3 qualifying paths):
        // (1) Self >= 1 COMPLETED Chest Mall order, OR (2) >= 1 on-chain StakeTicket,
        // OR (3) >= 1 direct invitee completed a real Chest Mall order (0 GRAM self-spend unlock).
        const hasCompletedPresale = presaleEngine ? await presaleEngine.hasCompletedPurchase(walletAddress) : false;
        let hasStakeTicket = false;
        if (!hasCompletedPresale && userReader) {
          const portfolio = await userReader(walletAddress);
          hasStakeTicket = Array.isArray(portfolio?.tickets) && portfolio.tickets.length > 0;
        }
        const idemKey = String(body?.activationId || headers['x-idempotency-key'] || headers['X-Idempotency-Key'] || '').trim() || null;
        let hasDirectPaidInvitee = false;
        if (!hasCompletedPresale && !hasStakeTicket && socialStore && presaleEngine && typeof socialStore.listDirectReferees === 'function') {
          const directReferees = await socialStore.listDirectReferees([identity.telegramUserId, walletAddress]);
          const candidateWallets = new Set(directReferees);
          for (const ref of directReferees) {
            if (/^\d{1,20}$/.test(String(ref)) && identityStore) {
              const refWallet = typeof identityStore.getCurrentWalletAddress === 'function'
                ? await identityStore.getCurrentWalletAddress(String(ref))
                : (await identityStore.getBinding?.(String(ref), nowSec))?.walletAddress;
              if (refWallet) candidateWallets.add(refWallet);
            }
          }
          if (candidateWallets.size > 0 && typeof presaleEngine.hasCompletedPurchaseForAny === 'function') {
            hasDirectPaidInvitee = await presaleEngine.hasCompletedPurchaseForAny([...candidateWallets]);
          }
        }
        return ok(
          await predictionEngine.activateToPromo(identity.telegramUserId, walletAddress, promoEngine, {
            qualified: hasCompletedPresale || hasStakeTicket || hasDirectPaidInvitee,
            nowMs: nowSec * 1000,
            activationId: idemKey,
          }),
        );
      }

      // ---------------------------------------------------------------------
      // Unified Chest Mall & Viral Social Assist Endpoints
      // ---------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/chests/me') {
        if (!chestEngine) return err('CHEST_DISABLED', 'chest engine not configured', 503);
        const id = await auth.telegram();
        const binding = await identityStore.getBinding(id.telegramUserId, nowSec);
        // 幂等补建该用户已确认（COMPLETED）但因瞬态故障尚未生成的商城膨胀箱
        if (presaleEngine && typeof presaleEngine.ensureShopBoostChests === 'function' && binding?.walletAddress) {
          try {
            await presaleEngine.ensureShopBoostChests(binding.walletAddress, nowSec);
          } catch (_) {
            // 补建失败不阻断列表读取，下次查询继续幂等重试
          }
        }
        const lists = await chestEngine.listUserChests(id.telegramUserId);
        // 合并已成交商城订单（含 INSTANT 直接开箱与 BOOST 膨胀箱，按 orderId 去重），确保 5 种宝箱持有统计口径一致
        let completedShopOrders = [];
        if (presaleEngine && binding?.walletAddress && typeof presaleEngine.listOrders === 'function') {
          try {
            const orders = await presaleEngine.listOrders(binding.walletAddress);
            completedShopOrders = (Array.isArray(orders) ? orders : []).filter((o) => o?.status === 'COMPLETED');
          } catch (_) {
            completedShopOrders = [];
          }
        }
        const chestHoldings = summarizeUserChestHoldings({
          freeChests: lists.freeChests,
          shopChests: lists.shopChests,
          completedShopOrders,
        });
        return ok({
          catalog: Object.values(CHEST_MALL_CATALOG),
          critTiers: PAID_CHEST_CRIT_TIERS,
          freeTiers: FREE_CHEST_CHAIN,
          ...lists,
          chestHoldings,
        });
      }

      if (method === 'POST' && pathname === '/api/chests/starter') {
        if (!chestEngine) return err('CHEST_DISABLED', 'chest engine not configured', 503);
        const id = await auth.telegram();
        const binding = await identityStore.getBinding(id.telegramUserId, nowSec);
        return ok(
          await chestEngine.claimStarterBronzeChests(
            { userId: id.telegramUserId, walletAddress: binding?.walletAddress || null },
            nowSec,
          ),
        );
      }

      if (method === 'POST' && pathname === '/api/chests/open-all') {
        if (!chestEngine) return err('CHEST_DISABLED', 'chest engine not configured', 503);
        if (env.A9_CHEST_OPEN_ENABLED !== '1') {
          return err('CHEST_OPEN_DISABLED', '当前真实模式处于只读验收阶段，宝箱开箱入账暂未开放', 403);
        }
        const { identity, walletAddress } = await auth.wallet(body?.walletAddress || null);
        return ok(
          await chestEngine.openAllChests(
            {
              userId: identity.telegramUserId,
              walletAddress,
              tier: body?.tier ? String(body.tier).trim().toLowerCase() : null,
              promoEngine,
              budgetLedger,
            },
            nowSec,
          ),
        );
      }

      const chestAssistMatch = method === 'POST' && pathname.match(/^\/api\/chests\/([^/]+)\/assist$/);
      if (chestAssistMatch) {
        if (!chestEngine) return err('CHEST_DISABLED', 'chest engine not configured', 503);
        const chestId = decodeURIComponent(chestAssistMatch[1]);
        const { identity, walletAddress } = await auth.wallet(body?.walletAddress || null);
        if (!walletStateResolver) {
          return err('WALLET_STATE_UNAVAILABLE', '链上钱包状态核验服务未配置', 503);
        }
        let walletState;
        try {
          walletState = await walletStateResolver(walletAddress);
        } catch (e) {
          return err('WALLET_STATE_UNAVAILABLE', `无法核验钱包链上状态：${e?.message || 'RPC error'}`, 503);
        }
        // TonCenterClient.fetchWalletAccountState 返回 { state: 'active' | 'uninitialized' | 'frozen', codeBoc }
        const walletActive = walletState?.state === 'active';
        const assistRes = await chestEngine.assistChest(
          {
            chestId,
            helperUserId: identity.telegramUserId,
            helperWalletAddress: walletAddress,
            walletActive,
          },
          nowSec,
        );
        if (broadcaster && typeof broadcaster.notifyChestAssistProgress === 'function' && assistRes?.chest) {
          try {
            await broadcaster.notifyChestAssistProgress({ chest: assistRes.chest, paidBoost: false, addedAssists: 1, nowSec });
          } catch (_) {
            // 提醒推送失败不影响助力成功返回
          }
        }
        return ok(assistRes);
      }

      const chestOpenMatch = method === 'POST' && pathname.match(/^\/api\/chests\/([^/]+)\/open$/);
      if (chestOpenMatch) {
        if (!chestEngine) return err('CHEST_DISABLED', 'chest engine not configured', 503);
        // 独立开箱入账门禁：必须显式设置 A9_CHEST_OPEN_ENABLED=1（与 A9_PRESALE_OPEN 购箱开关完全解耦）
        if (env.A9_CHEST_OPEN_ENABLED !== '1') {
          return err('CHEST_OPEN_DISABLED', '当前真实模式处于只读验收阶段，宝箱开箱入账暂未开放', 403);
        }
        const chestId = decodeURIComponent(chestOpenMatch[1]);
        const tgId = await auth.telegram();
        const targetChest = typeof chestEngine.getChest === 'function' ? await chestEngine.getChest(chestId) : null;
        if (targetChest && targetChest.source === 'WARMUP_ROUND') {
          const binding = await identityStore.getBinding(tgId.telegramUserId, nowSec);
          return ok(
            await chestEngine.openChest(
              {
                chestId,
                userId: tgId.telegramUserId,
                walletAddress: binding?.walletAddress || null,
                promoEngine,
                predictionEngine,
                budgetLedger,
              },
              nowSec,
            ),
          );
        }
        const { identity, walletAddress } = await auth.wallet(body?.walletAddress || null);
        let teamVolumeNano = 0n;
        let teamTgMemberCount = 0;
        if (socialStore && presaleEngine) {
          const selfKey = addressKey(walletAddress);
          const wallets = new Set([walletAddress]);
          const directRefKeys = new Set([selfKey]);
          const minCreatedAtByWallet = new Map();
          if (typeof socialStore.listDirectReferees === 'function') {
            const refs = await socialStore.listDirectReferees([identity.telegramUserId, walletAddress]);
            for (const r of refs) {
              wallets.add(r);
              directRefKeys.add(addressKey(r));
              if (/^\d{1,20}$/.test(String(r)) && identityStore) {
                const refWallet = typeof identityStore.getCurrentWalletAddress === 'function'
                  ? await identityStore.getCurrentWalletAddress(String(r))
                  : (await identityStore.getBinding?.(String(r), nowSec))?.walletAddress;
                if (refWallet) {
                  wallets.add(refWallet);
                  directRefKeys.add(addressKey(refWallet));
                }
              }
            }
          }
          // M-1: 严格隔离免费箱战队业绩归属——仅队长可计入战队 TG 群人数与成员入队后成交额；普通成员仅计本人与直推
          const myTeam = await socialStore.getTeamByWallet(walletAddress);
          const isCaptain = Boolean(myTeam && addressKey(myTeam.captainWallet) === selfKey);
          if (isCaptain) {
            if (myTeam.bindStatus === 'bound') teamTgMemberCount = Number(myTeam.tgMemberCount || 0);
            if (typeof socialStore.listTeamMembersWithJoinTime === 'function') {
              const members = await socialStore.listTeamMembersWithJoinTime(myTeam.teamId);
              for (const m of members) {
                if (!m?.walletAddress) continue;
                wallets.add(m.walletAddress);
                const mk = addressKey(m.walletAddress);
                if (!directRefKeys.has(mk)) {
                  minCreatedAtByWallet.set(mk, Number(m.joinedAt || 0));
                }
              }
            } else if (typeof socialStore.listTeamMemberWallets === 'function') {
              const members = await socialStore.listTeamMemberWallets(myTeam.teamId);
              for (const m of members) wallets.add(m);
            }
          }
          if (typeof presaleEngine.sumCompletedVolumeNano === 'function') {
            teamVolumeNano = await presaleEngine.sumCompletedVolumeNano([...wallets], { minCreatedAtByWallet });
          }
        }
        return ok(
          await chestEngine.openChest(
            {
              chestId,
              userId: identity.telegramUserId,
              walletAddress,
              teamVolumeNano,
              teamTgMemberCount,
              promoEngine,
              predictionEngine,
              budgetLedger,
            },
            nowSec,
          ),
        );
      }

      if (method === 'GET' && pathname === '/api/chests/crit-feed') {
        if (!chestEngine) return err('CHEST_DISABLED', 'chest engine not configured', 503);
        const list = typeof chestEngine.listRecentCritFeed === 'function'
          ? await chestEngine.listRecentCritFeed({ limit: Number(query.limit) || 12 })
          : [];
        return ok({ items: list });
      }

      const chestGetMatch = method === 'GET' && pathname.match(/^\/api\/chests\/([^/]+)$/);
      if (chestGetMatch) {
        if (!chestEngine) return err('CHEST_DISABLED', 'chest engine not configured', 503);
        const chest = await chestEngine.getChest(decodeURIComponent(chestGetMatch[1]));
        if (!chest) return err('CHEST_NOT_FOUND', 'chest not found', 404);
        return ok(sanitizePublicChest(chest));
      }

      // Phase 3: Handbook Stamp & Non-Financial Progression (strictly tied to verified Telegram user)
      const progUserMatch = method === 'GET' && pathname.match(/^\/api\/progression\/(?:user\/)?(.+)$/);
      if (progUserMatch) {
        if (!progressionEngine) return err('PROGRESSION_DISABLED', 'progression engine not configured', 503);
        const id = await auth.telegram();
        const requested = decodeURIComponent(progUserMatch[1]);
        if (requested !== 'me' && requested !== id.telegramUserId) {
          return err('FORBIDDEN', 'cannot read another user\'s progression record', 403);
        }
        const roundId = query.roundId ? Number(query.roundId) : (stateStore.getProtocolState().currentRoundId || 1);
        let hasPredictionBet = false;
        if (predictionEngine && roundId) {
          const predSummary = await predictionEngine.getUserSummary(id.telegramUserId, roundId);
          hasPredictionBet = Boolean(predSummary?.currentBet);
        }
        return ok(await progressionEngine.getUserSummary(id.telegramUserId, nowSec, { hasPredictionBet }));
      }

      if (method === 'POST' && pathname === '/api/progression/claim') {
        if (!progressionEngine) return err('PROGRESSION_DISABLED', 'progression engine not configured', 503);
        const id = await auth.telegram();
        if (body?.userId && String(body.userId) !== id.telegramUserId) {
          return err('FORBIDDEN', 'userId does not match the signed-in Telegram user', 403);
        }
        const roundId = body?.roundId ? Number(body.roundId) : (stateStore.getProtocolState().currentRoundId || 1);
        let hasPredictionBet = false;
        if (predictionEngine && roundId) {
          const predSummary = await predictionEngine.getUserSummary(id.telegramUserId, roundId);
          hasPredictionBet = Boolean(predSummary?.currentBet);
        }
        return ok(
          await progressionEngine.claimTask(
            {
              userId: id.telegramUserId,
              taskKey: body?.taskKey,
              hasPredictionBet,
            },
            nowSec,
          ),
        );
      }

      // Admin: anomalous inbound transfers (no valid order / wrong sender / amount mismatch ...)
      if (pathname === '/api/admin/presale/anomalies' || pathname.startsWith('/api/admin/presale/anomalies/')) {
        const expectedToken = String(env.A9_ADMIN_TOKEN || '').trim();
        const providedToken = extractAdminToken(headers);
        if (!timingSafeEqualStr(providedToken, expectedToken)) {
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
        if (!timingSafeEqualStr(providedToken, expectedToken)) {
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
          await predictionEngine.settleRoundBets(roundId, body.passed, actualQualified, poolArg, nowSec * 1000, { budgetLedger }),
        );
      }

      // Admin: Pre-Round Warm-Up funnel summary & round schedule config
      if (pathname === '/api/admin/warmup/summary' || pathname === '/api/admin/warmup/round') {
        const expectedToken = String(env.A9_ADMIN_TOKEN || '').trim();
        const providedToken = extractAdminToken(headers);
        if (!timingSafeEqualStr(providedToken, expectedToken)) {
          return err('UNAUTHORIZED', 'invalid or missing admin token', 401);
        }
        if (!socialStore) return err('SOCIAL_DISABLED', 'social store not configured', 503);
        if (method === 'GET' && pathname === '/api/admin/warmup/summary') {
          const roundId = query.roundId ? Number(query.roundId) : resolveUpcomingWarmupRoundId();
          if (!Number.isInteger(roundId) || roundId < 1) {
            return err('BAD_REQUEST', 'roundId must be a positive integer', 400);
          }
          const chainRound = stateStore?.getRound?.(roundId) || null;
          const actualOnchainStakers = chainRound?.round ? Number(chainRound.round.stakeCount || 0) : null;
          let readyWalletSet = null;
          if (presaleEngine && typeof presaleEngine.hasCompletedPurchase === 'function') {
            try {
              const completed = typeof presaleEngine.repo?.listOrdersByStatus === 'function'
                ? await presaleEngine.repo.listOrdersByStatus('COMPLETED')
                : [];
              readyWalletSet = new Set(completed.map((o) => o.walletKey || addressKey(o.walletAddress)));
            } catch (_) {
              readyWalletSet = null;
            }
          }
          return ok(await socialStore.getWarmupAdminSummary(roundId, { readyWalletSet, actualOnchainStakers }));
        }
        if (method === 'POST' && pathname === '/api/admin/warmup/round') {
          const roundId = Number(body?.roundId || resolveUpcomingWarmupRoundId());
          return ok(await socialStore.upsertWarmupRoundConfig({
            roundId,
            status: body?.status,
            plannedOpenAt: body?.plannedOpenAt,
            targetUsers: body?.targetUsers,
            chestBaseA9Raw: body?.chestBaseA9Raw,
            chestStepA9Raw: body?.chestStepA9Raw,
            chestMinInvites: body?.chestMinInvites,
            chestMaxInvites: body?.chestMaxInvites,
          }, nowSec));
        }
        return err('NOT_FOUND', 'route not found', 404);
      }

      // Admin: Idempotent 1H TWAP candle upsert into round_candles (used by Keeper/Oracle pipeline)
      const adminCandlesMatch = method === 'POST' && pathname.match(/^\/api\/admin\/rounds\/(\d+)\/candles$/);
      if (adminCandlesMatch) {
        const expectedToken = String(env.A9_ADMIN_TOKEN || '').trim();
        const providedToken = extractAdminToken(headers);
        if (!timingSafeEqualStr(providedToken, expectedToken)) {
          return err('UNAUTHORIZED', 'invalid or missing admin token', 401);
        }
        if (typeof candleWriter !== 'function') {
          return err('CANDLE_WRITER_UNAVAILABLE', 'round candle writer not configured', 503);
        }
        const roundId = Number(adminCandlesMatch[1]);
        if (!Number.isInteger(roundId) || roundId < 1) {
          return err('BAD_REQUEST', 'roundId must be a positive integer', 400);
        }
        const rawCandles = Array.isArray(body?.candles) ? body.candles : null;
        if (!rawCandles || rawCandles.length < 1 || rawCandles.length > 24) {
          return err('BAD_REQUEST', 'candles array (1..24 items) is required', 400);
        }
        const seenIdx = new Set();
        const normalized = [];
        for (const item of rawCandles) {
          const idx = Number(item?.candleIndex);
          const pStart = Number(item?.periodStart);
          const pEnd = Number(item?.periodEnd);
          const twapStr = String(item?.twapPriceUsdE8 ?? '').trim();
          const qualRaw = item?.qualified;
          const qualValid = typeof qualRaw === 'boolean' || qualRaw === 0 || qualRaw === 1;
          if (
            !Number.isInteger(idx) || idx < 0 || idx > 23 ||
            seenIdx.has(idx) ||
            !Number.isInteger(pStart) || pStart <= 0 ||
            !Number.isInteger(pEnd) || pEnd <= pStart ||
            !/^\d+$/.test(twapStr) ||
            !qualValid
          ) {
            return err('BAD_REQUEST', 'invalid candle item (require unique candleIndex 0..23, periodEnd > periodStart > 0, integer twapPriceUsdE8, boolean qualified)', 400);
          }
          seenIdx.add(idx);
          normalized.push({
            candleIndex: idx,
            periodStart: pStart,
            periodEnd: pEnd,
            twapPriceUsdE8: twapStr,
            qualified: Boolean(qualRaw),
          });
        }
        normalized.sort((a, b) => a.candleIndex - b.candleIndex);
        await candleWriter(roundId, normalized, nowSec);
        return ok({ roundId, upsertedCount: normalized.length, candles: normalized });
      }

      // Plan 3: Dynamic OG / Story PNG raster image (/c/img/:type/:id.png)
      const ogPngMatch = method === 'GET' && pathname.match(/^\/c\/img\/(round|burn|proof|bet|chest)\/([^/]+)\.png$/);
      if (ogPngMatch) {
        const [, type, id] = ogPngMatch;
        const ratio = query.ratio === '9x16' ? '9x16' : '16x9';
        if (type === 'chest') {
          const chest = chestEngine ? await chestEngine.getChest(id) : null;
          const rewardStr = chest ? formatExactA9FromRaw(chest.source === 'SHOP_BOOST' ? (BigInt(chest.baseA9Raw) + BigInt(chest.boostA9Raw)).toString() : chest.baseA9Raw) : null;
          const pngBytes = await renderOgCardPng({
            type: 'chest',
            roundId: null,
            hasData: Boolean(chest),
            state: chest ? `${chest.currentAssists}/${chest.requiredAssists} ASSISTS` : 'CHEST ASSIST',
            qualified: chest ? chest.currentAssists : null,
            totalSlots: chest ? chest.requiredAssists : 2,
            targetUsd: chest ? `${chest.labelEn}` : 'A9 CHEST',
            budgetA9: rewardStr,
            ratio,
          });
          return { status: 200, contentType: 'image/png', rawBody: pngBytes };
        }
        const parsedId = Number(id);
        const curId = Number(stateStore.getProtocolState()?.currentRoundId || 0);
        const rId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : (curId > 0 ? curId : null);
        const item = rId ? stateStore.getRound(rId) : null;
        const detail = item ? mapV15RoundDetail(rId, item.round, item.candles, nowSec, stateStore.getTiming()) : null;
        const targetNum = detail?.targetPriceUsdE8 ? Number(detail.targetPriceUsdE8) : 0;
        const pngBytes = await renderOgCardPng({
          type,
          roundId: rId,
          hasData: Boolean(detail),
          state: detail?.state || 'UNVERIFIED',
          qualified: detail ? detail.qualifiedCandles : null,
          targetUsd: targetNum > 0 ? `$${(targetNum / 1e8).toFixed(4)}` : '--',
          budgetA9: formatWholeA9FromRaw(detail?.rewardBudgetRaw),
          ratio,
        });
        return { status: 200, contentType: 'image/png', rawBody: pngBytes };
      }

      // Backward-compatible SVG card (/c/img/:type/:id.svg)
      const ogImgMatch = method === 'GET' && pathname.match(/^\/c\/img\/(round|burn|proof|bet|chest)\/([^/]+)\.svg$/);
      if (ogImgMatch) {
        const [, type, id] = ogImgMatch;
        if (type === 'chest') {
          const chest = chestEngine ? await chestEngine.getChest(id) : null;
          const rewardStr = chest ? formatExactA9FromRaw(chest.source === 'SHOP_BOOST' ? (BigInt(chest.baseA9Raw) + BigInt(chest.boostA9Raw)).toString() : chest.baseA9Raw) : null;
          const svg = renderOgCardSvg({
            type: 'chest',
            roundId: null,
            hasData: Boolean(chest),
            state: chest ? `${chest.currentAssists}/${chest.requiredAssists} ASSISTS` : 'CHEST ASSIST',
            qualified: chest ? chest.currentAssists : null,
            totalSlots: chest ? chest.requiredAssists : 2,
            targetUsd: chest ? `${chest.labelEn}` : 'A9 CHEST',
            budgetA9: rewardStr,
          });
          return { status: 200, contentType: 'image/svg+xml; charset=utf-8', rawBody: svg };
        }
        const parsedId = Number(id);
        const curId = Number(stateStore.getProtocolState()?.currentRoundId || 0);
        const rId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : (curId > 0 ? curId : null);
        const item = rId ? stateStore.getRound(rId) : null;
        const detail = item ? mapV15RoundDetail(rId, item.round, item.candles, nowSec, stateStore.getTiming()) : null;
        const targetNum = detail?.targetPriceUsdE8 ? Number(detail.targetPriceUsdE8) : 0;
        const svg = renderOgCardSvg({
          type,
          roundId: rId,
          hasData: Boolean(detail),
          state: detail?.state || 'UNVERIFIED',
          qualified: detail ? detail.qualifiedCandles : null,
          targetUsd: targetNum > 0 ? `$${(targetNum / 1e8).toFixed(4)}` : '—',
          budgetA9: formatWholeA9FromRaw(detail?.rewardBudgetRaw),
        });
        return { status: 200, contentType: 'image/svg+xml; charset=utf-8', rawBody: svg };
      }

      const ogPageMatch = method === 'GET' && pathname.match(/^\/c\/(round|burn|proof|bet|chest)\/([^/]+)$/);
      if (ogPageMatch) {
        const [, type, id] = ogPageMatch;
        const imgBase = (env.A9_API_ORIGIN || origin || env.A9_PUBLIC_ORIGIN || '').replace(/\/+$/, '');
        const botHandle = env.A9_TG_BOT_HANDLE || 'A9_TonBot';
        const ref = query.ref ? `_${String(query.ref).replace(/[^a-zA-Z0-9_-]/g, '')}` : '';
        if (type === 'chest') {
          const chest = chestEngine ? await chestEngine.getChest(id) : null;
          const title = chest ? `A9 Chest Mall · ${chest.labelEn} (${chest.currentAssists}/${chest.requiredAssists} Assists)` : 'A9 Chest Mall · Co-Op Gift & Instant 200 A9 Chest';
          const description = chest
            ? `Connect active TON wallet to assist (${chest.currentAssists}/${chest.requiredAssists}) and instantly open your own 200 A9 Bronze Starter Chest.`
            : 'Connect active TON wallet to assist your friend and instantly open your own 200 A9 Bronze Starter Chest.';
          const html = renderOgLandingHtml({
            type: 'chest',
            id,
            title,
            description,
            imageUrl: `${imgBase}/c/img/chest/${encodeURIComponent(id)}.png`,
            tgDeepLink: `https://t.me/${botHandle}?startapp=chest_${encodeURIComponent(id)}${ref}`,
            width: 1200,
            height: 630,
          });
          return { status: 200, contentType: 'text/html; charset=utf-8', rawBody: html };
        }
        const parsedId = Number(id);
        const curId = Number(stateStore.getProtocolState()?.currentRoundId || 0);
        const rId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : (curId > 0 ? curId : null);
        const item = rId ? stateStore.getRound(rId) : null;
        const detail = item ? mapV15RoundDetail(rId, item.round, item.candles, nowSec, stateStore.getTiming()) : null;
        const budgetA9 = formatWholeA9FromRaw(detail?.rewardBudgetRaw);
        const roundLabel = rId ? `Round #${rId}` : 'Live Status';
        // 无真实链上数据源时，绝不输出硬编码的固定奖池数字（P0-G）。
        const description = detail
          ? `24H 16/24 Hourly Slots${budgetA9 ? ` · ${budgetA9} A9 Pool` : ''} · 100% On-Chain TON TEP-74`
          : 'A9 Protocol on TON · On-chain round data pending verification';
        const html = renderOgLandingHtml({
          type,
          id,
          title: `A9 Protocol · ${roundLabel} (${type.toUpperCase()})`,
          description,
          imageUrl: `${imgBase}/c/img/${type}/${encodeURIComponent(id)}.png`,
          tgDeepLink: `https://t.me/${botHandle}?startapp=${type}_${encodeURIComponent(id)}${ref}`,
          width: 1200,
          height: 630,
        });
        return { status: 200, contentType: 'text/html; charset=utf-8', rawBody: html };
      }

      return err('NOT_FOUND', `route not found: ${method} ${pathname}`, 404);
    } catch (e) {
      if (e instanceof AuthError) return err(e.code, e.message, e.status || 401);
      if (e instanceof BudgetError) return err(e.code, e.message, e.code === 'PROMO_BUDGET_EXHAUSTED' ? 503 : 400);
      if (e instanceof SocialError) return err(e.code, e.message, e.code === 'NOT_CAPTAIN' ? 403 : 400);
      if (e instanceof ChestError) return err(e.code, e.message, e.code === 'FORBIDDEN' ? 403 : 400);
      if (e instanceof PromoError || e instanceof PresaleError || e instanceof GrowthError) {
        return err(e.code, e.message, 400);
      }
      console.error('[a9-api] unhandled internal error:', e?.stack || e?.message || e);
      return err('INTERNAL_ERROR', 'internal server error', 500);
    }
  };
}
