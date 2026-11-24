// A9 Protocol v15 — 极简 Telegram 战队群实时战报播报器
// 仅面向已通过四重真实核验的战队群（bind_status = 'bound' 且具备真实 tg_chat_id）做单向高潮播报：
//   1) ROUND_OPEN     : 新轮开启（前 1/3 时段 2.0x 早鸟权重窗口）
//   2) WHALE_EXCHANGE : 纯内盘大额兑换确认成交捷报（默认 >= 50 GRAM，仅推送买家所属战队群）
//   3) SPRINT_4H      : 24H 观察期最后 4 小时警报（兼容有无实时 1H K 线源）
//   4) ROUND_SETTLE   : 结算战报（通关派奖 / 100% 销毁 BURN）
//
// 安全边界：
//   - 默认关闭（需显式 A9_BROADCAST_ENABLED=1）。
//   - 生产由 D1 tg_broadcast_events(event_key PRIMARY KEY) 保证多实例绝不重复推群。
//   - 每次推送异常静默记录日志，绝不阻塞链上同步或预售发币主链路。
//   - 群主专属归因按钮采用短 ID（invite_<teamId>_<captainTgUserId>），严格控制在 Telegram 64 字节上限内。

import { formatUnits } from './money.mjs';
import { CHEST_MALL_CATALOG, CHEST_MALL_NANO_TO_SKU } from './chest-engine.mjs';

const TON_NANO = 1_000_000_000n;
const A9_RAW = 1_000_000_000n;
const DEFAULT_WHALE_MIN_GRAM = 50n;

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskWallet(addr) {
  const s = String(addr || '').trim();
  if (s.length <= 10) return s || 'A9-MEMBER';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function formatGroupedUnits(rawBigInt, decimals = 9) {
  const plain = formatUnits(rawBigInt, decimals);
  const [intPart, fracPart] = plain.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fracPart ? `${grouped}.${fracPart}` : grouped;
}

function formatWholeNumber(rawStr) {
  try {
    const whole = BigInt(rawStr || '0') / A9_RAW;
    return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  } catch {
    return '0';
  }
}

function formatUsdFromE8(e8) {
  const n = Number(e8 || 0);
  if (!Number.isFinite(n) || n <= 0) return '待核验';
  return `$${(n / 1e8).toFixed(4)}`;
}

/** 构造严格符合 Telegram startapp 64 字节上限的归因深链。 */
export function buildTeamDeepLink({ botHandle = 'A9_TonBot', teamId = null, captainTgUserId = null, fallbackParam = 'market' }) {
  const handle = String(botHandle || 'A9_TonBot').replace(/^@/, '').trim() || 'A9_TonBot';
  const cleanTeam = teamId ? String(teamId).replace(/[^A-Za-z0-9-]/g, '').slice(0, 24) : '';
  const cleanCaptain = captainTgUserId ? String(captainTgUserId).replace(/[^A-Za-z0-9-]/g, '').slice(0, 24) : '';

  let param = String(fallbackParam || 'market').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (cleanTeam && cleanCaptain) {
    const candidate = `invite_${cleanTeam}_${cleanCaptain}`;
    if (candidate.length <= 64) param = candidate;
  } else if (cleanCaptain) {
    const candidate = `invite_${cleanCaptain}`;
    if (candidate.length <= 64) param = candidate;
  } else if (cleanTeam) {
    const candidate = `invite_${cleanTeam}`;
    if (candidate.length <= 64) param = candidate;
  }
  return `https://t.me/${handle}?startapp=${encodeURIComponent(param)}`;
}

/** 内存去重日志（供本地单机 server.mjs 与单元测试使用）。 */
export class MemoryBroadcastLog {
  constructor() {
    this.events = new Map();
  }

  async has(eventKey) {
    return this.events.has(String(eventKey));
  }

  async tryClaim(eventKey, eventType, nowSec = Math.floor(Date.now() / 1000)) {
    const k = String(eventKey);
    if (this.events.has(k)) return false;
    this.events.set(k, { eventKey: k, eventType: String(eventType), sentCount: 0, createdAt: nowSec });
    return true;
  }

  async markSent(eventKey, sentCount) {
    const rec = this.events.get(String(eventKey));
    if (rec) rec.sentCount = Number(sentCount || 0);
  }

  async release(eventKey) {
    return this.events.delete(String(eventKey));
  }
}

/** Cloudflare D1 原子去重日志（多实例 Worker 并发安全）。 */
export class D1BroadcastLog {
  constructor({ db }) {
    if (!db) throw new Error('Cloudflare D1 binding (env.DB) is required');
    this.db = db;
  }

  async has(eventKey) {
    const row = await this.db
      .prepare('SELECT 1 AS hit FROM tg_broadcast_events WHERE event_key = ? LIMIT 1')
      .bind(String(eventKey))
      .first();
    return Boolean(row?.hit);
  }

  async tryClaim(eventKey, eventType, nowSec = Math.floor(Date.now() / 1000)) {
    const res = await this.db
      .prepare('INSERT OR IGNORE INTO tg_broadcast_events (event_key, event_type, sent_count, created_at) VALUES (?, ?, 0, ?)')
      .bind(String(eventKey), String(eventType), nowSec)
      .run();
    return Number(res?.meta?.changes ?? res?.changes ?? 0) === 1;
  }

  async markSent(eventKey, sentCount) {
    await this.db
      .prepare('UPDATE tg_broadcast_events SET sent_count = ? WHERE event_key = ?')
      .bind(Number(sentCount || 0), String(eventKey))
      .run();
  }

  async release(eventKey) {
    const res = await this.db
      .prepare('DELETE FROM tg_broadcast_events WHERE event_key = ?')
      .bind(String(eventKey))
      .run();
    return Number(res?.meta?.changes ?? res?.changes ?? 0) > 0;
  }
}

export class TelegramBroadcaster {
  constructor({
    enabled = false,
    botToken = '',
    botHandle = 'A9_TonBot',
    publicOrigin = '',
    apiOrigin = '',
    officialChannelId = '',
    whaleMinGram = DEFAULT_WHALE_MIN_GRAM,
    socialStore = null,
    identityStore = null,
    dedupLog = null,
    fetchImpl = globalThis.fetch,
    delayMs = 100,
    logger = console,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.botToken = String(botToken || '').trim();
    this.botHandle = String(botHandle || 'A9_TonBot').replace(/^@/, '').trim() || 'A9_TonBot';
    this.publicOrigin = String(publicOrigin || '').replace(/\/+$/, '');
    this.apiOrigin = String(apiOrigin || publicOrigin || '').replace(/\/+$/, '');
    this.officialChannelId = String(officialChannelId || '').trim() || null;
    const minGram = BigInt(String(whaleMinGram ?? DEFAULT_WHALE_MIN_GRAM));
    this.whaleMinNano = minGram > 0n ? minGram * TON_NANO : 0n;
    this.socialStore = socialStore;
    this.identityStore = identityStore;
    this.dedupLog = dedupLog || new MemoryBroadcastLog();
    // Cloudflare workerd 禁止以 this.fetchImpl(...) 形式调用默认 globalThis.fetch（会触发 Illegal invocation）
    this.fetchImpl = fetchImpl === globalThis.fetch && typeof globalThis.fetch === 'function'
      ? (...args) => globalThis.fetch(...args)
      : fetchImpl;
    this.delayMs = Number.isFinite(Number(delayMs)) ? Math.max(0, Number(delayMs)) : 100;
    this.logger = logger;
  }

  _canSend() {
    return this.enabled && Boolean(this.botToken) && typeof this.fetchImpl === 'function';
  }

  async _resolveCaptainTgId(team) {
    if (!team?.captainWallet || !this.identityStore || typeof this.identityStore.getTelegramUserIdByWallet !== 'function') {
      return null;
    }
    try {
      return await this.identityStore.getTelegramUserIdByWallet(team.captainWallet);
    } catch {
      return null;
    }
  }

  async _sendTelegram({ chatId, text, photoUrl = null, buttonText = null, buttonUrl = null, replyToMessageId = null }) {
    const base = `https://api.telegram.org/bot${this.botToken}`;
    const replyMarkup = buttonText && buttonUrl
      ? { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] }
      : undefined;

    const usePhoto = Boolean(photoUrl && /^https?:\/\//i.test(photoUrl));
    const endpoint = usePhoto ? `${base}/sendPhoto` : `${base}/sendMessage`;
    const payload = usePhoto
      ? { chat_id: String(chatId), photo: photoUrl, caption: text, reply_markup: replyMarkup }
      : { chat_id: String(chatId), text, disable_web_page_preview: true, reply_markup: replyMarkup };
    if (replyToMessageId !== null && replyToMessageId !== undefined && Number.isFinite(Number(replyToMessageId))) {
      payload.reply_to_message_id = Number(replyToMessageId);
    }

    const res = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      const err = new Error(`Telegram API error (${res.status}): ${json?.description || 'unknown'}`);
      err.status = res.status;
      const rawRetryAfter = json?.parameters?.retry_after ?? res.headers?.get?.('retry-after');
      const retryAfterNum = Number(rawRetryAfter);
      if (Number.isFinite(retryAfterNum) && retryAfterNum > 0) {
        err.retryAfterSec = Math.ceil(retryAfterNum);
      }
      throw err;
    }
    return json.result;
  }

  async _broadcastToTargets({ eventKey, eventType, targets, buildPayload, nowSec }) {
    if (!this._canSend()) return { skipped: true, reason: 'DISABLED', sentCount: 0 };
    if (!targets.length) return { skipped: true, reason: 'NO_TARGETS', sentCount: 0 };

    const claimed = await this.dedupLog.tryClaim(eventKey, eventType, nowSec);
    if (!claimed) return { skipped: true, reason: 'DUPLICATE', sentCount: 0 };

    let sentCount = 0;
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      if (i > 0 && this.delayMs > 0) await sleep(this.delayMs);
      try {
        const msg = await buildPayload(target);
        await this._sendTelegram({ chatId: target.chatId, ...msg });
        sentCount += 1;
      } catch (e) {
        this.logger?.error?.(`[tg-broadcaster] ${eventKey} -> ${target.chatId} failed:`, e?.message || e);
      }
    }
    try {
      await this.dedupLog.markSent(eventKey, sentCount);
    } catch (e) {
      this.logger?.error?.(`[tg-broadcaster] markSent(${eventKey}) failed:`, e?.message || e);
    }
    return { skipped: false, eventKey, eventType, sentCount };
  }

  async _collectGlobalTargets() {
    const targets = [];
    const seen = new Set();
    if (this.socialStore && typeof this.socialStore.listBoundTeams === 'function') {
      const teams = await this.socialStore.listBoundTeams();
      for (const team of teams || []) {
        if (!team?.tgChatId || seen.has(String(team.tgChatId))) continue;
        seen.add(String(team.tgChatId));
        targets.push({ chatId: String(team.tgChatId), team });
      }
    }
    if (this.officialChannelId && !seen.has(this.officialChannelId)) {
      targets.push({ chatId: this.officialChannelId, team: null });
    }
    return targets;
  }

  /**
   * 链上轮次状态巡检入口：自动检测并幂等推送事件 ① 新轮开启、③ 最后 4 小时警报、④ 结算战报。
   */
  async processRoundSnapshot({ roundId, round, candles = [], nowSec = Math.floor(Date.now() / 1000), observationSeconds = 86400 }) {
    if (!this._canSend() || !roundId || !round) return [];
    const results = [];
    const rId = Number(roundId);
    const status = Number(round.status);
    const stakeCloseAt = Number(round.stakeCloseAt || 0);
    const obsEnd = stakeCloseAt > 0 ? stakeCloseAt + Number(observationSeconds || 86400) : 0;

    // 事件 ①：新轮开启（入场期 2.0x 早鸟黄金窗口）
    if (status === 1 && stakeCloseAt > nowSec) {
      results.push(await this.broadcastRoundOpen({ roundId: rId, round, nowSec }));
      results.push(await this.sendWarmupOpeningReminders({ roundId: rId, round, nowSec }));
    }

    // 事件 ③：24H 观察期最后 4 小时冲刺/焦灼警报
    if (status === 1 && stakeCloseAt > 0 && nowSec >= stakeCloseAt && obsEnd > nowSec && (obsEnd - nowSec) <= 14400) {
      const candlesSeen = Array.isArray(candles) ? candles.length : 0;
      const qualFromCandles = candlesSeen > 0 ? candles.filter((c) => Boolean(c.qualified)).length : null;
      const shouldFire = qualFromCandles === null || (qualFromCandles >= 12 && qualFromCandles <= 15);
      if (shouldFire) {
        results.push(await this.broadcastLast4hAlert({
          roundId: rId,
          round,
          qualifiedCandles: qualFromCandles,
          secondsLeft: obsEnd - nowSec,
          nowSec,
        }));
      }
    }

    // 事件 ④：链上结算完成（通关派奖 / 未通关销毁 BURN）
    if (status === 2 || status === 3) {
      results.push(await this.broadcastRoundSettle({
        roundId: rId,
        round,
        passed: status === 2,
        qualifiedCandles: Number(round.qualifiedCandles || 0),
        nowSec,
      }));
      results.push(await this.sendPersonalRoundSettleReminders({
        roundId: rId,
        round,
        passed: status === 2,
        qualifiedCandles: Number(round.qualifiedCandles || 0),
        nowSec,
      }));
    }

    return results;
  }

  /** ① 新轮开启（2.0x 早鸟权重窗口） */
  async broadcastRoundOpen({ roundId, round, nowSec = Math.floor(Date.now() / 1000) }) {
    const targets = await this._collectGlobalTargets();
    const targetUsd = formatUsdFromE8(round?.targetPriceUsdE8);
    const poolStr = formatWholeNumber(round?.rewardBudgetRaw || '700000000000000000');
    const photoUrl = this.apiOrigin ? `${this.apiOrigin}/c/img/round/${roundId}.png` : null;

    return this._broadcastToTargets({
      eventKey: `open:${roundId}`,
      eventType: 'ROUND_OPEN',
      targets,
      nowSec,
      buildPayload: async ({ team }) => {
        const captainTgId = team ? await this._resolveCaptainTgId(team) : null;
        const url = buildTeamDeepLink({
          botHandle: this.botHandle,
          teamId: team?.teamId || null,
          captainTgUserId: captainTgId,
          fallbackParam: `round_${roundId}`,
        });
        return {
          photoUrl,
          text: [
            `第 #${roundId} 轮开启：前段 2.0x 早鸟权重窗口已开放`,
            `目标底价：${targetUsd}`,
            `本轮奖励池：${poolStr} A9（单轮上限 15x，早鸟权重 2.0x / 1.4x / 1.0x）`,
            team ? `所属战队：${team.name}（点击下方入口自动绑定本队邀请归因）` : '规则透明可查，按链上实际结算为准。',
          ].join('\n'),
          buttonText: '进入 A9 财富大冒险 · 抢占 2.0x 早鸟',
          buttonUrl: url,
        };
      },
    });
  }

  /** ② 纯内盘大额兑换确认成交捷报（默认 >= 50 GRAM，仅推送买家所属已核验战队群） */
  async broadcastWhaleExchange({ order, nowSec = Math.floor(Date.now() / 1000) }) {
    if (!this._canSend() || !order || this.whaleMinNano <= 0n) {
      return { skipped: true, reason: 'DISABLED', sentCount: 0 };
    }
    const tonNano = BigInt(String(order.tonNano || '0'));
    if (tonNano < this.whaleMinNano) {
      return { skipped: true, reason: 'BELOW_THRESHOLD', sentCount: 0 };
    }
    if (!this.socialStore || typeof this.socialStore.getTeamByWallet !== 'function') {
      return { skipped: true, reason: 'NO_SOCIAL_STORE', sentCount: 0 };
    }
    const team = await this.socialStore.getTeamByWallet(order.walletAddress);
    if (!team || team.bindStatus !== 'bound' || !team.tgChatId) {
      return { skipped: true, reason: 'NO_BOUND_TEAM', sentCount: 0 };
    }

    const gramText = formatGroupedUnits(tonNano, 9);
    const a9Text = formatGroupedUnits(BigInt(String(order.a9AmountRaw || '0')), 9);

    return this._broadcastToTargets({
      eventKey: `whale:${order.orderId}`,
      eventType: 'WHALE_EXCHANGE',
      targets: [{ chatId: String(team.tgChatId), team }],
      nowSec,
      buildPayload: async ({ team: t }) => {
        const captainTgId = await this._resolveCaptainTgId(t);
        const url = buildTeamDeepLink({
          botHandle: this.botHandle,
          teamId: t.teamId,
          captainTgUserId: captainTgId,
          fallbackParam: 'market',
        });
        const sku = CHEST_MALL_CATALOG[order.skuId || CHEST_MALL_NANO_TO_SKU[String(tonNano)] || ''];
        const chestLabel = sku ? `${sku.zh}（${sku.priceGram} GRAM）` : `${gramText} GRAM 宝箱商城订单`;
        return {
          text: [
            `战队大额开箱捷报 · ${t.name}`,
            `成员 ${maskWallet(order.walletAddress)} 刚在宝箱商城购入【${chestLabel}】：`,
            `实付 ${gramText} GRAM → 本金已确认入账 ${a9Text} A9（固定报价 1 GRAM = 2,002 A9）`,
            `链上成交可查，本队同步享有 6% 邀友奖励归因。`,
          ].join('\n'),
          buttonText: '前往宝箱商城查看档位',
          buttonUrl: url,
        };
      },
    });
  }

  /** ③ 观察期最后 4 小时警报 */
  async broadcastLast4hAlert({ roundId, round, qualifiedCandles = null, secondsLeft = 0, nowSec = Math.floor(Date.now() / 1000) }) {
    const targets = await this._collectGlobalTargets();
    const hoursLeft = Math.max(1, Math.ceil(Number(secondsLeft || 0) / 3600));
    const targetUsd = formatUsdFromE8(round?.targetPriceUsdE8);
    const photoUrl = this.apiOrigin ? `${this.apiOrigin}/c/img/round/${roundId}.png` : null;
    const progressLine = qualifiedCandles !== null
      ? `当前已达标 ${qualifiedCandles}/24 时段，还差 ${Math.max(0, 16 - qualifiedCandles)} 根小时线过关，否则按合约执行 100% 销毁 BURN。`
      : `距本轮 24H 观察期结束不足 ${hoursLeft} 小时（目标底价 ${targetUsd}），满 16/24 时段通关派奖，未达标将链上执行销毁 BURN。`;

    return this._broadcastToTargets({
      eventKey: `sprint:${roundId}`,
      eventType: 'SPRINT_4H',
      targets,
      nowSec,
      buildPayload: async ({ team }) => {
        const captainTgId = team ? await this._resolveCaptainTgId(team) : null;
        const url = buildTeamDeepLink({
          botHandle: this.botHandle,
          teamId: team?.teamId || null,
          captainTgUserId: captainTgId,
          fallbackParam: `bet_${roundId}`,
        });
        return {
          photoUrl,
          text: [
            `第 #${roundId} 轮最后 ${hoursLeft} 小时赛点警报`,
            progressLine,
            `0 GRAM 免费进入 24H 预言擂台站队（PASS / BURN）。`,
          ].join('\n'),
          buttonText: '打开 24H 实时战况与预言擂台',
          buttonUrl: url,
        };
      },
    });
  }

  /** ④ 链上结算战报（通关派奖 / 未通关销毁 BURN，附本群集体预言战绩） */
  async broadcastRoundSettle({ roundId, round, passed, qualifiedCandles = 0, groupStatsResolver = null, nowSec = Math.floor(Date.now() / 1000) }) {
    const targets = await this._collectGlobalTargets();
    const poolStr = formatWholeNumber(round?.rewardBudgetRaw || '0');
    const photoUrl = this.apiOrigin
      ? `${this.apiOrigin}/c/img/${passed ? 'round' : 'burn'}/${roundId}.png`
      : null;

    return this._broadcastToTargets({
      eventKey: `settle:${roundId}`,
      eventType: 'ROUND_SETTLE',
      targets,
      nowSec,
      buildPayload: async ({ team }) => {
        const captainTgId = team ? await this._resolveCaptainTgId(team) : null;
        const url = buildTeamDeepLink({
          botHandle: this.botHandle,
          teamId: team?.teamId || null,
          captainTgUserId: captainTgId,
          fallbackParam: passed ? `round_${roundId}` : `burn_${roundId}`,
        });
        let squadLine = '';
        if (team && typeof groupStatsResolver === 'function') {
          try {
            const gs = await groupStatsResolver(team, roundId);
            if (gs && Number(gs.participants) > 0) {
              squadLine = `本群本轮共 ${gs.participants} 人参战 24H 预言，命中率 ${gs.winRatePct}%。`;
            }
          } catch {
            squadLine = '';
          }
        }
        const baseLines = passed
          ? [
              `第 #${roundId} 轮结算战报：通关派奖（${qualifiedCandles}/24 时段达标）`,
              `本轮奖励池 ${poolStr} A9 已按权重结算开放领取，24H 预言擂台奖励同步发放至待激活金库。`,
            ]
          : [
              `第 #${roundId} 轮结算战报：未达标 · 销毁 BURN（${qualifiedCandles}/24 时段）`,
              `未满 16/24 达标线，合约已链上执行 100% 质押本金与半数奖池永久销毁 BURN；24H 预言擂台已同步结算。`,
            ];
        if (squadLine) baseLines.push(squadLine);
        return {
          photoUrl,
          text: baseLines.join('\n'),
          buttonText: passed ? '查看通关结算与领取明细' : '查看链上销毁 BURN 战报',
          buttonUrl: url,
        };
      },
    });
  }

  /** ⑤ 6% 宝箱商城返佣入账私聊群主/邀请人报喜 */
  async notifyReferralCommission({ order, credit, nowSec = Math.floor(Date.now() / 1000) }) {
    if (!this._canSend() || !credit?.referrer || !credit?.orderId) {
      return { skipped: true, reason: 'DISABLED', sentCount: 0 };
    }
    let recipientTgId = null;
    const ref = String(credit.referrer).trim();
    if (/^\d{1,20}$/.test(ref)) {
      recipientTgId = ref;
    } else if (this.identityStore && typeof this.identityStore.getTelegramUserIdByWallet === 'function') {
      try {
        recipientTgId = await this.identityStore.getTelegramUserIdByWallet(ref);
      } catch {
        recipientTgId = null;
      }
    }
    if (!recipientTgId) return { skipped: true, reason: 'NO_TG_RECIPIENT', sentCount: 0 };

    const commText = formatGroupedUnits(BigInt(String(credit.amountRaw || '0')), 9);
    const tonNano = order ? BigInt(String(order.tonNano || '0')) : 0n;
    const sku = order ? CHEST_MALL_CATALOG[order.skuId || CHEST_MALL_NANO_TO_SKU[String(tonNano)] || ''] : null;
    const itemText = sku ? `${sku.zh}（${sku.priceGram} GRAM）` : `${formatGroupedUnits(tonNano, 9)} GRAM 商城订单`;
    const url = buildTeamDeepLink({ botHandle: this.botHandle, fallbackParam: 'market' });

    return this._broadcastToTargets({
      eventKey: `comm:${credit.orderId}`,
      eventType: 'REFERRAL_COMMISSION',
      targets: [{ chatId: String(recipientTgId), team: null }],
      nowSec,
      buildPayload: async () => ({
        text: [
          `返佣到账提醒：+ ${commText} A9`,
          `你的战队成员/直邀好友刚在宝箱商城完成【${itemText}】，你的 6% 永久返佣已实时入账，随时可提现！`,
        ].join('\n'),
        buttonText: '打开金库查看返佣余额',
        buttonUrl: url,
      }),
    });
  }

  /** ⑥ 新轮开启时向已开启提醒的预热预约用户批量发送私聊通知（按人回写 reminded_at 防重发，400/403 永久失败自动跳过防队头阻塞） */
  async sendWarmupOpeningReminders({ roundId, round = null, limit = 25, nowSec = Math.floor(Date.now() / 1000) }) {
    if (!this._canSend()) return { skipped: true, reason: 'DISABLED', sentCount: 0 };
    if (!this.socialStore || typeof this.socialStore.listPendingWarmupReminders !== 'function') {
      return { skipped: true, reason: 'NO_SOCIAL_STORE', sentCount: 0 };
    }
    const rId = Math.floor(Number(roundId));
    if (!Number.isInteger(rId) || rId < 1) return { skipped: true, reason: 'INVALID_ROUND_ID', sentCount: 0 };
    const pending = await this.socialStore.listPendingWarmupReminders(rId, limit);
    if (!pending || !pending.length) {
      return { skipped: true, reason: 'NO_PENDING_REMINDERS', sentCount: 0 };
    }
    const targetUsd = formatUsdFromE8(round?.targetPriceUsdE8);
    const hasBudget = Boolean(round?.rewardBudgetRaw && /^\d+$/.test(String(round.rewardBudgetRaw)) && BigInt(String(round.rewardBudgetRaw)) > 0n);
    const poolPart = hasBudget ? ` · 本轮奖励池 ${formatWholeNumber(round.rewardBudgetRaw)} A9` : '';
    const url = buildTeamDeepLink({ botHandle: this.botHandle, fallbackParam: `round_${rId}` });

    let sentCount = 0;
    let failedPermanentCount = 0;
    let rateLimited = false;
    let retryAfterSec = null;
    for (let i = 0; i < pending.length; i += 1) {
      const rec = pending[i];
      if (!rec?.tgUserId || !/^\d{1,20}$/.test(String(rec.tgUserId))) continue;
      if (i > 0 && this.delayMs > 0) await sleep(this.delayMs);
      try {
        await this._sendTelegram({
          chatId: String(rec.tgUserId),
          text: [
            `你预约的第 #${rId} 轮已正式开启！`,
            `前段 2.0x 早鸟权重窗口开放中（2.0x / 1.4x / 1.0x）· 目标底价 ${targetUsd}${poolPart}`,
            `本轮最低质押 1,000 A9；参与闯关或购箱即可激活你预热宝箱中的待解锁 A9 奖励。`,
          ].join('\n'),
          buttonText: `立即进入第 #${rId} 轮（抢 2.0x 早鸟）`,
          buttonUrl: url,
        });
        if (typeof this.socialStore.markWarmupReminded === 'function') {
          await this.socialStore.markWarmupReminded(rId, rec.tgUserId, nowSec);
        }
        sentCount += 1;
      } catch (e) {
        const st = Number(e?.status || 0);
        if (st === 429) {
          rateLimited = true;
          retryAfterSec = e?.retryAfterSec || null;
          this.logger?.error?.(`[tg-broadcaster] warmup reminder r${rId} rate-limited (retry_after=${retryAfterSec ?? 'unknown'})`);
          break;
        }
        if (st === 400 || st === 403) {
          failedPermanentCount += 1;
          if (typeof this.socialStore.markWarmupReminded === 'function') {
            await this.socialStore.markWarmupReminded(rId, rec.tgUserId, nowSec);
          }
        }
        this.logger?.error?.(`[tg-broadcaster] warmup reminder r${rId} -> ${rec.tgUserId} failed:`, e?.message || e);
      }
    }
    return {
      skipped: false,
      eventType: 'WARMUP_OPEN_REMINDER',
      roundId: rId,
      sentCount,
      failedPermanentCount,
      rateLimited,
      retryAfterSec,
      attempted: pending.length,
      hasMore: pending.length >= limit || rateLimited,
    };
  }

  /** ⑦ 48H 待激活金库到期前 6 小时温和私聊提醒（按 (userId, pendingExpiresAt) 去重，每个过期周期仅触达一次） */
  async sendPendingVaultExpiryReminders({
    predictionEngine = null,
    windowSec = 6 * 3600,
    limit = 25,
    nowSec = Math.floor(Date.now() / 1000),
  } = {}) {
    if (!this._canSend()) return { skipped: true, reason: 'DISABLED', sentCount: 0 };
    if (!predictionEngine || typeof predictionEngine.listExpiringPendingVaults !== 'function') {
      return { skipped: true, reason: 'NO_PREDICTION_ENGINE', sentCount: 0 };
    }
    const nowMs = Number(nowSec) * 1000;
    const windowMs = Math.max(60, Number(windowSec || 6 * 3600)) * 1000;
    const candidates = await predictionEngine.listExpiringPendingVaults({ nowMs, windowMs, limit });
    if (!candidates || !candidates.length) {
      return { skipped: true, reason: 'NO_EXPIRING_VAULTS', sentCount: 0 };
    }

    const url = buildTeamDeepLink({ botHandle: this.botHandle, fallbackParam: 'market' });
    let sentCount = 0;
    let skippedDuplicateCount = 0;
    let failedPermanentCount = 0;
    let rateLimited = false;
    let retryAfterSec = null;

    for (let i = 0; i < candidates.length; i += 1) {
      const item = candidates[i];
      const uid = String(item?.userId || '').trim();
      if (!/^\d{1,20}$/.test(uid)) continue;
      const expMs = Number(item?.pendingExpiresAt || 0);
      if (!Number.isFinite(expMs) || expMs <= nowMs) continue;

      const eventKey = `vault_exp:${uid}:${expMs}`;
      const claimed = await this.dedupLog.tryClaim(eventKey, 'VAULT_EXPIRY_6H', nowSec);
      if (!claimed) {
        skippedDuplicateCount += 1;
        continue;
      }

      if (sentCount > 0 && this.delayMs > 0) await sleep(this.delayMs);
      const hoursLeft = Math.max(1, Math.ceil((expMs - nowMs) / 3600000));
      const a9Text = formatGroupedUnits(BigInt(String(item.pendingActivationRaw || '0')), 9);

      try {
        await this._sendTelegram({
          chatId: uid,
          text: [
            `待激活金库到期提醒：你还有 ${a9Text} A9 免费奖励将在约 ${hoursLeft} 小时后过期`,
            `在宝箱商城购任意宝箱（0.99 GRAM 起）、参与链上质押，或直邀 1 位好友购箱，即可立即激活入账并永久保留。`,
          ].join('\n'),
          buttonText: '前往激活待领 A9 奖励',
          buttonUrl: url,
        });
        await this.dedupLog.markSent(eventKey, 1);
        sentCount += 1;
      } catch (e) {
        const st = Number(e?.status || 0);
        if (st === 429) {
          rateLimited = true;
          retryAfterSec = e?.retryAfterSec || null;
          if (typeof this.dedupLog.release === 'function') {
            await this.dedupLog.release(eventKey).catch(() => {});
          }
          this.logger?.error?.(`[tg-broadcaster] vault expiry reminder rate-limited (retry_after=${retryAfterSec ?? 'unknown'})`);
          break;
        }
        if (st === 400 || st === 403) {
          failedPermanentCount += 1;
        }
        this.logger?.error?.(`[tg-broadcaster] vault expiry reminder -> ${uid} failed:`, e?.message || e);
      }
    }

    return {
      skipped: false,
      eventType: 'VAULT_EXPIRY_6H',
      sentCount,
      skippedDuplicateCount,
      failedPermanentCount,
      rateLimited,
      retryAfterSec,
      attempted: candidates.length,
    };
  }

  /** Bot Webhook 命令即时回复（不受群主动广播总开关 A9_BROADCAST_ENABLED=1 阻断） */
  async sendBotReply({ chatId, text, photoUrl = null, buttonText = null, buttonUrl = null, replyToMessageId = null }) {
    if (!this.botToken || typeof this.fetchImpl !== 'function') {
      return { sent: false, reason: 'BOT_NOT_CONFIGURED' };
    }
    const cid = String(chatId || '').trim();
    const bodyText = String(text || '').trim();
    if (!cid || !bodyText) {
      return { sent: false, reason: 'BAD_REPLY_PAYLOAD' };
    }
    try {
      await this._sendTelegram({
        chatId: cid,
        text: bodyText,
        photoUrl,
        buttonText,
        buttonUrl,
        replyToMessageId,
      });
      return { sent: true };
    } catch (e) {
      this.logger?.error?.(`[tg-broadcaster] sendBotReply -> ${cid} failed:`, e?.message || e);
      return {
        sent: false,
        reason: 'SEND_FAILED',
        status: Number(e?.status || 0),
        error: e?.message || 'SEND_FAILED',
      };
    }
  }

  /** ⑧ 轮次结算个人私聊通知队列（按 user_notification_prefs 分批推送，429 立即中止续跑，400/403 自动退订） */
  async sendPersonalRoundSettleReminders({
    roundId,
    round = null,
    passed,
    qualifiedCandles = 0,
    limit = 25,
    nowSec = Math.floor(Date.now() / 1000),
  } = {}) {
    if (!this._canSend()) return { skipped: true, reason: 'DISABLED', sentCount: 0 };
    if (!this.socialStore) return { skipped: true, reason: 'NO_SOCIAL_STORE', sentCount: 0 };

    const rId = Math.floor(Number(roundId));
    if (!Number.isInteger(rId) || rId < 1) {
      return { skipped: true, reason: 'INVALID_ROUND_ID', sentCount: 0 };
    }

    const lim = Math.max(1, Math.min(200, Math.floor(Number(limit) || 25)));
    let pendingUids = [];
    if (typeof this.socialStore.listPendingSettlementPushUsers === 'function') {
      pendingUids = await this.socialStore.listPendingSettlementPushUsers(rId, { limit: lim });
    } else if (typeof this.socialStore.listSettlementPushSubscribers === 'function') {
      const allSubs = await this.socialStore.listSettlementPushSubscribers({ limit: 10000 });
      for (const uid of allSubs) {
        if (pendingUids.length >= lim) break;
        const already = await this.dedupLog.has(`settle_dm:${rId}:${uid}`);
        if (!already) pendingUids.push(String(uid));
      }
    } else {
      return { skipped: true, reason: 'NO_SUBSCRIBER_QUERY', sentCount: 0 };
    }

    if (!pendingUids.length) {
      return { skipped: true, reason: 'NO_PENDING_SUBSCRIBERS', sentCount: 0 };
    }

    const poolStr = formatWholeNumber(round?.rewardBudgetRaw || '0');
    const isPass = Boolean(passed);
    const url = buildTeamDeepLink({
      botHandle: this.botHandle,
      fallbackParam: isPass ? 'claim' : `burn_${rId}`,
    });
    const text = (isPass
      ? [
          `第 #${rId} 轮结算通知：通关派奖（${qualifiedCandles}/24 时段达标）`,
          `本轮奖励池 ${poolStr} A9 已按权重结算开放领取，24H 预言擂台奖励已同步结算。`,
          `可在小程序「我的 -> 系统设置」随时开关本提醒。`,
        ]
      : [
          `第 #${rId} 轮结算通知：未达标 · 销毁 BURN（${qualifiedCandles}/24 时段）`,
          `未满 16/24 达标线，合约已执行 100% 质押本金与半数奖池永久销毁 BURN，24H 预言擂台已同步结算。`,
          `可在小程序「我的 -> 系统设置」随时开关本提醒。`,
        ]
    ).join('\n');
    const buttonText = isPass ? '查看通关结算与领取奖励' : '查看销毁战报与预言金库';

    let sentCount = 0;
    let skippedDuplicateCount = 0;
    let failedPermanentCount = 0;
    let autoDisabledCount = 0;
    let failedTransientCount = 0;
    let rateLimited = false;
    let retryAfterSec = null;

    for (let i = 0; i < pendingUids.length; i += 1) {
      const uid = String(pendingUids[i] || '').trim();
      if (!/^\d{1,20}$/.test(uid)) continue;
      const eventKey = `settle_dm:${rId}:${uid}`;
      const claimed = await this.dedupLog.tryClaim(eventKey, 'ROUND_SETTLE_DM', nowSec);
      if (!claimed) {
        skippedDuplicateCount += 1;
        continue;
      }

      if (sentCount > 0 && this.delayMs > 0) await sleep(this.delayMs);
      try {
        await this._sendTelegram({
          chatId: uid,
          text,
          buttonText,
          buttonUrl: url,
        });
        await this.dedupLog.markSent(eventKey, 1);
        sentCount += 1;
      } catch (e) {
        const st = Number(e?.status || 0);
        if (st === 429) {
          rateLimited = true;
          retryAfterSec = e?.retryAfterSec || null;
          if (typeof this.dedupLog.release === 'function') {
            await this.dedupLog.release(eventKey).catch(() => {});
          }
          this.logger?.error?.(`[tg-broadcaster] settle dm r${rId} rate-limited (retry_after=${retryAfterSec ?? 'unknown'})`);
          break;
        }
        if (st === 400 || st === 403) {
          failedPermanentCount += 1;
          if (typeof this.socialStore.disableSettlementPush === 'function') {
            try {
              await this.socialStore.disableSettlementPush(uid, nowSec);
              autoDisabledCount += 1;
            } catch (disErr) {
              this.logger?.error?.(`[tg-broadcaster] disableSettlementPush(${uid}) failed:`, disErr?.message || disErr);
            }
          }
        } else {
          failedTransientCount += 1;
          if (typeof this.dedupLog.release === 'function') {
            await this.dedupLog.release(eventKey).catch(() => {});
          }
        }
        this.logger?.error?.(`[tg-broadcaster] settle dm r${rId} -> ${uid} failed:`, e?.message || e);
      }
    }

    return {
      skipped: false,
      eventType: 'ROUND_SETTLE_DM',
      roundId: rId,
      sentCount,
      skippedDuplicateCount,
      failedPermanentCount,
      autoDisabledCount,
      failedTransientCount,
      rateLimited,
      retryAfterSec,
      attempted: pendingUids.length,
      hasMore: pendingUids.length >= lim || rateLimited,
    };
  }
}
