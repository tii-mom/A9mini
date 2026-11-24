#!/usr/bin/env node
// A9 Protocol v16.1 — Wave 3 Telegram Bot Productionization & Notification Preferences Test Suite.
// Covers Memory & Real SQLite D1 (0001..0013) parity, webhook security, commands, DM queue 429/403, and ops setup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiRouter } from '../src/api.mjs';
import { SocialStore } from '../src/social-store.mjs';
import { D1SocialStore } from '../src/d1-growth-store.mjs';
import { TelegramBroadcaster, MemoryBroadcastLog, D1BroadcastLog } from '../src/tg-broadcaster.mjs';
import { MemoryIdentityStore, D1IdentityStore } from '../src/auth.mjs';
import {
  TEST_BOT_TOKEN,
  MIGRATIONS,
  FRESH_SCHEMA,
  createSqliteD1,
  tgHeaders,
} from './helpers/test-env.mjs';
import { buildBotSetupPlan, executeBotSetup, maskSecret } from '../../ops/scripts/setup-tg-bot.mjs';

const WEBHOOK_SECRET = 'wh_sec_test_a9_prod_2026_abcdef';

function createRoundStateStore(activeRound = null) {
  const ps = activeRound
    ? {
        dataAvailable: true,
        currentRoundId: activeRound.roundId,
        successCount: 2,
        poolRemainingRaw: '7000000000000000000',
        carryRaw: '0',
        teamPoolRemainingRaw: '1200000000000000000',
        teamCarryRaw: '0',
      }
    : {
        dataAvailable: false,
        currentRoundId: null,
        successCount: null,
        poolRemainingRaw: null,
        carryRaw: null,
        teamPoolRemainingRaw: null,
        teamCarryRaw: null,
      };
  return {
    getTiming: () => ({ observationSeconds: 86400 }),
    getProtocolState: () => ps,
    listRounds: () => (activeRound ? [activeRound] : []),
    getRound: (id) => (activeRound && Number(id) === activeRound.roundId ? activeRound : null),
  };
}

function makeRecorderFetch(rulesFn = null) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const rec = { url: String(url), method: init.method || 'GET', body };
    calls.push(rec);
    if (typeof rulesFn === 'function') {
      const custom = await rulesFn(rec, calls.length);
      if (custom) return custom;
    }
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      async json() {
        return { ok: true, result: { message_id: calls.length } };
      },
    };
  };
  return { calls, fetchImpl };
}

await test('Webhook Secret auth: fail-closed 503 when unset, 401 on bad/missing secret, 200 & ignores non-commands', async () => {
  const socialStore = new SocialStore();
  const stateStore = createRoundStateStore(null);

  const unconfigured = createApiRouter({ env: {}, stateStore, socialStore });
  const r503 = await unconfigured({
    method: 'POST',
    pathname: '/api/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: { message: { message_id: 1, chat: { id: 1001, type: 'private' }, from: { id: 1001 }, text: '/start' } },
  });
  assert.equal(r503.status, 503);
  assert.equal(r503.body.error.code, 'WEBHOOK_NOT_CONFIGURED');

  const { calls, fetchImpl } = makeRecorderFetch();
  const broadcaster = new TelegramBroadcaster({
    enabled: false,
    botToken: TEST_BOT_TOKEN,
    botHandle: 'A9_TonBot',
    socialStore,
    fetchImpl,
    delayMs: 0,
  });
  const router = createApiRouter({
    env: { A9_BOT_TOKEN: TEST_BOT_TOKEN, A9_TG_BOT_HANDLE: 'A9_TonBot', A9_TG_WEBHOOK_SECRET: WEBHOOK_SECRET },
    stateStore,
    socialStore,
    broadcaster,
  });

  const r401Missing = await router({
    method: 'POST',
    pathname: '/api/telegram/webhook',
    headers: {},
    body: { message: { message_id: 2, chat: { id: 1001, type: 'private' }, from: { id: 1001 }, text: '/start' } },
  });
  assert.equal(r401Missing.status, 401);

  const r401Wrong = await router({
    method: 'POST',
    pathname: '/api/telegram/webhook',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong_secret_token' },
    body: { message: { message_id: 3, chat: { id: 1001, type: 'private' }, from: { id: 1001 }, text: '/start' } },
  });
  assert.equal(r401Wrong.status, 401);

  const rIgnored = await router({
    method: 'POST',
    pathname: '/api/telegram/webhook',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
    body: { message: { message_id: 4, chat: { id: 1001, type: 'private' }, from: { id: 1001 }, text: 'just chatting' } },
  });
  assert.equal(rIgnored.status, 200);
  assert.equal(rIgnored.body.data.handled, false);
  assert.equal(rIgnored.body.data.ignored, true);
  assert.equal(calls.length, 0);
});

await test('Webhook commands (/start, /status, /help) reply even when A9_BROADCAST_ENABLED=0 and never overwrite opt-out', async () => {
  const socialStore = new SocialStore();
  // Pre-seed user 9002 as opted out so /start must NOT clobber their preference
  socialStore.setNotificationPrefs('9002', { settlementPush: false }, 900);

  const { calls, fetchImpl } = makeRecorderFetch();
  const broadcaster = new TelegramBroadcaster({
    enabled: false, // A9_BROADCAST_ENABLED=0 must NOT block webhook interactive command replies
    botToken: TEST_BOT_TOKEN,
    botHandle: 'A9_TonBot',
    socialStore,
    fetchImpl,
    delayMs: 0,
  });

  const routerEmpty = createApiRouter({
    env: { A9_BOT_TOKEN: TEST_BOT_TOKEN, A9_TG_BOT_HANDLE: 'A9_TonBot', A9_TG_WEBHOOK_SECRET: WEBHOOK_SECRET },
    stateStore: createRoundStateStore(null),
    socialStore,
    broadcaster,
  });

  // 1) /start with invite payload -> binds attribution & creates default notification pref
  const resStart1 = await routerEmpty({
    method: 'POST',
    pathname: '/api/telegram/webhook',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
    body: { message: { message_id: 10, chat: { id: 9001, type: 'private' }, from: { id: 9001 }, text: '/start@A9_TonBot invite_777888' } },
    nowSec: 1000,
  });
  assert.equal(resStart1.status, 200);
  assert.equal(resStart1.body.data.command, 'start');
  assert.equal(resStart1.body.data.replied, true);
  assert.equal(socialStore.getReferrer('9001'), '777888');
  assert.equal(socialStore.getNotificationPrefs('9001').settlementPush, true);
  assert.equal(socialStore.getNotificationPrefs('9001').subscribedExplicitly, true);

  // 2) /start for opted-out user -> keeps settlementPush === false
  await routerEmpty({
    method: 'POST',
    pathname: '/api/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: { message: { message_id: 11, chat: { id: 9002, type: 'private' }, from: { id: 9002 }, text: '/start' } },
    nowSec: 1001,
  });
  assert.equal(socialStore.getNotificationPrefs('9002').settlementPush, false);

  // 3) /status with unavailable chain data -> reports unverified, no fake metrics
  const resStatusEmpty = await routerEmpty({
    method: 'POST',
    pathname: '/api/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: { message: { message_id: 12, chat: { id: 9001, type: 'private' }, from: { id: 9001 }, text: '/status' } },
    nowSec: 1002,
  });
  assert.equal(resStatusEmpty.status, 200);
  assert.ok(resStatusEmpty.body.data.replyText.includes('待核验'));
  assert.ok(!resStatusEmpty.body.data.replyText.includes('700,000,000'));

  // 4) /status with real active round (14 qualified candles out of 16 seen)
  const activeRound = {
    roundId: 3,
    round: {
      status: 1,
      targetPriceUsdE8: '23200000',
      twap24hUsdE8: '24000000',
      stakeOpenAt: 1000,
      stakeCloseAt: 2000,
      settledAt: 0,
      totalStakeRaw: '10000000000000',
      totalWeightRaw: '15000000000000',
      rewardBudgetRaw: '700000000000000000',
      qualifiedCandles: 0,
      candleHash: '0xabc',
      immediateBps: 0,
      lockedSlices: 0,
      unlockedSlices: 0,
      burnedSlices: 0,
      lockedTotalRaw: '0',
      stakeCount: 12,
    },
    candles: Array.from({ length: 16 }, (_, idx) => ({
      candleIndex: idx,
      qualified: idx < 14,
      twapPriceUsdE8: idx < 14 ? '24000000' : '21000000',
    })),
  };
  const routerLive = createApiRouter({
    env: { A9_BOT_TOKEN: TEST_BOT_TOKEN, A9_TG_BOT_HANDLE: 'A9_TonBot', A9_TG_WEBHOOK_SECRET: WEBHOOK_SECRET },
    stateStore: createRoundStateStore(activeRound),
    socialStore,
    broadcaster,
  });
  const resStatusLive = await routerLive({
    method: 'POST',
    pathname: '/api/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: { message: { message_id: 13, chat: { id: 9001, type: 'private' }, from: { id: 9001 }, text: '/status' } },
    nowSec: 2500,
  });
  assert.equal(resStatusLive.status, 200);
  assert.ok(resStatusLive.body.data.replyText.includes('#3'));
  assert.ok(resStatusLive.body.data.replyText.includes('$0.2320'));
  assert.ok(resStatusLive.body.data.replyText.includes('700,000,000 A9'));
  assert.ok(resStatusLive.body.data.replyText.includes('14/24'));

  // 5) /help mentions 0.06 GRAM, 0.03 GRAM, AbortRound
  const resHelp = await routerLive({
    method: 'POST',
    pathname: '/api/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: { message: { message_id: 14, chat: { id: 9001, type: 'private' }, from: { id: 9001 }, text: '/help' } },
    nowSec: 2501,
  });
  assert.equal(resHelp.status, 200);
  assert.ok(resHelp.body.data.replyText.includes('0.06 GRAM'));
  assert.ok(resHelp.body.data.replyText.includes('0.03 GRAM'));
  assert.ok(resHelp.body.data.replyText.includes('AbortRound'));
  assert.equal(calls.length, 5);
  assert.ok(calls[0].body.reply_markup.inline_keyboard[0][0].url.includes('startapp=invite_777888'));
});

await test('GET/POST /api/me/notifications enforces TG auth, validates boolean, and persists in Memory + D1 (0001..0013)', async () => {
  for (const kind of ['memory', 'd1-migrations', 'd1-fresh']) {
    let socialStore;
    let db = null;
    if (kind === 'memory') {
      socialStore = new SocialStore();
    } else {
      db = createSqliteD1(kind === 'd1-migrations' ? MIGRATIONS : FRESH_SCHEMA);
      socialStore = new D1SocialStore({ db });
    }
    const router = createApiRouter({
      env: { A9_BOT_TOKEN: TEST_BOT_TOKEN },
      stateStore: createRoundStateStore(null),
      socialStore,
    });

    const unauth = await router({ method: 'GET', pathname: '/api/me/notifications', headers: {} });
    assert.equal(unauth.status, 401, kind);

    const headers = await tgHeaders(55100, { nowSec: 1000 });
    const g0 = await router({ method: 'GET', pathname: '/api/me/notifications', headers, nowSec: 1000 });
    assert.equal(g0.status, 200, kind);
    assert.equal(g0.body.data.settlementPush, true, kind);
    assert.equal(g0.body.data.hourlyCandlePush, false, kind);
    assert.equal(g0.body.data.subscribedExplicitly, false, kind);

    const bad = await router({
      method: 'POST',
      pathname: '/api/me/notifications',
      headers,
      body: { settlementPush: 'yes' },
      nowSec: 1001,
    });
    assert.equal(bad.status, 400, kind);

    const pOff = await router({
      method: 'POST',
      pathname: '/api/me/notifications',
      headers,
      body: { settlementPush: false },
      nowSec: 1002,
    });
    assert.equal(pOff.status, 200, kind);
    assert.equal(pOff.body.data.settlementPush, false, kind);
    assert.equal(pOff.body.data.subscribedExplicitly, true, kind);

    const g1 = await router({ method: 'GET', pathname: '/api/me/notifications', headers, nowSec: 1003 });
    assert.equal(g1.body.data.settlementPush, false, kind);

    const pOn = await router({
      method: 'POST',
      pathname: '/api/me/notifications',
      headers,
      body: { settlementPush: true },
      nowSec: 1004,
    });
    assert.equal(pOn.status, 200, kind);
    assert.equal(pOn.body.data.settlementPush, true, kind);
  }
});

await test('TelegramBroadcaster uses apiOrigin for /c/img/*.png and 6% referral copy (zero 12%)', async () => {
  const socialStore = new SocialStore();
  const identityStore = new MemoryIdentityStore();
  const buyerWallet = 'UQ' + 'A'.repeat(46);
  const captainWallet = 'UQ' + 'B'.repeat(46);
  const team = socialStore.createOrBindTeamGroup({
    teamId: 'T-API-TEST',
    name: 'Test Squad',
    captainWallet,
    tgGroupHandle: '@testsquad',
  }, 100);
  await socialStore.verifyTeamGroupBinding({
    teamId: 'T-API-TEST',
    captainWallet,
    telegramUserId: '777',
    telegramVerifier: async () => ({ botInGroup: true, operatorIsAdmin: true, chatId: '-100123456', tgMemberCount: 80 }),
  }, 101);
  socialStore.joinTeam({ teamId: 'T-API-TEST', walletAddress: buyerWallet }, 102);

  const { calls, fetchImpl } = makeRecorderFetch();
  const broadcaster = new TelegramBroadcaster({
    enabled: true,
    botToken: TEST_BOT_TOKEN,
    botHandle: 'A9_TonBot',
    publicOrigin: 'https://app.a9.lat',
    apiOrigin: 'https://api.a9.lat',
    whaleMinGram: '50',
    socialStore,
    identityStore,
    dedupLog: new MemoryBroadcastLog(),
    fetchImpl,
    delayMs: 0,
  });

  await broadcaster.broadcastRoundOpen({
    roundId: 5,
    round: { targetPriceUsdE8: '15000000', rewardBudgetRaw: '700000000000000000' },
    nowSec: 200,
  });
  await broadcaster.broadcastLast4hAlert({
    roundId: 5,
    round: { targetPriceUsdE8: '15000000' },
    qualifiedCandles: 13,
    secondsLeft: 7200,
    nowSec: 201,
  });
  await broadcaster.broadcastRoundSettle({
    roundId: 5,
    round: { rewardBudgetRaw: '700000000000000000' },
    passed: false,
    qualifiedCandles: 10,
    nowSec: 202,
  });
  await broadcaster.broadcastWhaleExchange({
    order: {
      orderId: 'ord_whale_1',
      walletAddress: buyerWallet,
      tonNano: '60000000000',
      a9AmountRaw: '120120000000000',
    },
    nowSec: 203,
  });
  await broadcaster.notifyReferralCommission({
    order: { orderId: 'ord_comm_1', tonNano: '10000000000', skuId: 'chest_silver' },
    credit: { orderId: 'ord_comm_1', referrer: '888999', amountRaw: '1201200000000' },
    nowSec: 204,
  });

  assert.equal(calls.length, 5);
  assert.equal(calls[0].body.photo, 'https://api.a9.lat/c/img/round/5.png');
  assert.equal(calls[1].body.photo, 'https://api.a9.lat/c/img/round/5.png');
  assert.equal(calls[2].body.photo, 'https://api.a9.lat/c/img/burn/5.png');
  assert.ok(!JSON.stringify(calls).includes('https://app.a9.lat/c/img/'));
  assert.ok(calls[3].body.text.includes('6%'));
  assert.ok(!calls[3].body.text.includes('12%'));
  assert.ok(calls[4].body.text.includes('6%'));
  assert.ok(!calls[4].body.text.includes('12%'));
});

await test('sendPersonalRoundSettleReminders handles batching, 429 release+halt+resume, and 400/403 auto-unsubscribe (Memory & D1)', async () => {
  for (const kind of ['memory', 'd1']) {
    let socialStore;
    let dedupLog;
    if (kind === 'memory') {
      socialStore = new SocialStore();
      dedupLog = new MemoryBroadcastLog();
    } else {
      const db = createSqliteD1(MIGRATIONS);
      socialStore = new D1SocialStore({ db });
      dedupLog = new D1BroadcastLog({ db });
    }

    await socialStore.setNotificationPrefs('101', { settlementPush: true }, 10);
    await socialStore.setNotificationPrefs('102', { settlementPush: false }, 11);
    await socialStore.setNotificationPrefs('103', { settlementPush: true }, 12);
    await socialStore.setNotificationPrefs('104', { settlementPush: true }, 13);
    await socialStore.setNotificationPrefs('105', { settlementPush: true }, 14);

    let mode = 'pass1';
    const { calls, fetchImpl } = makeRecorderFetch((rec) => {
      const cid = String(rec.body.chat_id);
      if (mode === 'pass1' && cid === '103') {
        return {
          ok: false,
          status: 429,
          headers: new Map(),
          async json() {
            return { ok: false, description: 'Too Many Requests: retry after 17', parameters: { retry_after: 17 } };
          },
        };
      }
      if (mode === 'pass2' && cid === '103') {
        return {
          ok: false,
          status: 403,
          headers: new Map(),
          async json() {
            return { ok: false, description: 'Forbidden: bot was blocked by the user' };
          },
        };
      }
      return null;
    });

    const broadcaster = new TelegramBroadcaster({
      enabled: true,
      botToken: TEST_BOT_TOKEN,
      botHandle: 'A9_TonBot',
      socialStore,
      dedupLog,
      fetchImpl,
      delayMs: 0,
    });

    const round = { status: 2, rewardBudgetRaw: '700000000000000000', qualifiedCandles: 18 };

    // Pass 1: sends 101, skips 102 (opted out), hits 429 on 103 -> releases settle_dm:7:103 & halts before 104/105
    const r1 = await broadcaster.sendPersonalRoundSettleReminders({ roundId: 7, round, passed: true, qualifiedCandles: 18, limit: 25, nowSec: 100 });
    assert.equal(r1.sentCount, 1, kind);
    assert.equal(r1.rateLimited, true, kind);
    assert.equal(r1.retryAfterSec, 17, kind);
    assert.deepEqual(calls.map((c) => c.body.chat_id), ['101', '103'], kind);
    assert.equal(await dedupLog.has('settle_dm:7:103'), false, kind);

    // Pass 2 (limit=2): skips 101/102, tries 103 (403 -> auto-disables settlementPush=false, keeps dedup), sends 104
    mode = 'pass2';
    const r2 = await broadcaster.sendPersonalRoundSettleReminders({ roundId: 7, round, passed: true, qualifiedCandles: 18, limit: 2, nowSec: 200 });
    assert.equal(r2.sentCount, 1, kind);
    assert.equal(r2.failedPermanentCount, 1, kind);
    assert.equal(r2.autoDisabledCount, 1, kind);
    assert.equal((await socialStore.getNotificationPrefs('103')).settlementPush, false, kind);
    assert.equal(await dedupLog.has('settle_dm:7:103'), true, kind);
    assert.deepEqual(calls.slice(2).map((c) => c.body.chat_id), ['103', '104'], kind);

    // Pass 3: sends remaining 105
    mode = 'pass3';
    const r3 = await broadcaster.sendPersonalRoundSettleReminders({ roundId: 7, round, passed: true, qualifiedCandles: 18, limit: 25, nowSec: 300 });
    assert.equal(r3.sentCount, 1, kind);
    assert.deepEqual(calls.slice(4).map((c) => c.body.chat_id), ['105'], kind);

    // Pass 4: no pending subscribers left
    const r4 = await broadcaster.sendPersonalRoundSettleReminders({ roundId: 7, round, passed: true, qualifiedCandles: 18, limit: 25, nowSec: 400 });
    assert.equal(r4.skipped, true, kind);
    assert.equal(r4.reason, 'NO_PENDING_SUBSCRIBERS', kind);
  }
});

await test('ops/scripts/setup-tg-bot.mjs enforces dry-run, HTTPS/secret validation, and never logs raw secrets', async () => {
  const logs = [];
  const silentLogger = { log: (m) => logs.push(String(m)) };
  const fakeToken = '987654:ABC_SECRET_BOT_TOKEN_XYZ';
  const fakeSecret = 'super_secret_webhook_token_123456';

  assert.throws(() => buildBotSetupPlan({ webhookUrl: 'http://api.a9.lat/hook', appUrl: 'https://app.a9.lat', secretToken: fakeSecret }));
  assert.throws(() => buildBotSetupPlan({ webhookUrl: 'https://api.a9.lat/hook', appUrl: 'https://app.a9.lat', secretToken: 'short' }));

  const dryFetch = { called: false };
  const dryRes = await executeBotSetup({
    execute: false,
    opsExecuteEnv: '',
    botToken: fakeToken,
    webhookUrl: 'https://api.a9.lat/api/telegram/webhook',
    appUrl: 'https://app.a9.lat',
    secretToken: fakeSecret,
    fetchImpl: async () => { dryFetch.called = true; return { ok: true, status: 200, async json() { return { ok: true }; } }; },
    logger: silentLogger,
  });
  assert.equal(dryRes.dryRun, true);
  assert.equal(dryRes.executed, false);
  assert.equal(dryFetch.called, false);
  assert.ok(!logs.join('\n').includes(fakeToken));
  assert.ok(!logs.join('\n').includes(fakeSecret));

  await assert.rejects(() => executeBotSetup({
    execute: true,
    opsExecuteEnv: '',
    botToken: fakeToken,
    webhookUrl: 'https://api.a9.lat/api/telegram/webhook',
    appUrl: 'https://app.a9.lat',
    secretToken: fakeSecret,
    logger: silentLogger,
  }));

  const { calls, fetchImpl } = makeRecorderFetch();
  const liveLogs = [];
  const liveRes = await executeBotSetup({
    execute: true,
    opsExecuteEnv: '1',
    botToken: fakeToken,
    webhookUrl: 'https://api.a9.lat/api/telegram/webhook',
    appUrl: 'https://app.a9.lat',
    secretToken: fakeSecret,
    fetchImpl,
    logger: { log: (m) => liveLogs.push(String(m)) },
  });
  assert.equal(liveRes.executed, true);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.endsWith('/setWebhook'));
  assert.equal(calls[0].body.secret_token, fakeSecret);
  assert.ok(calls[1].url.endsWith('/setMyCommands'));
  assert.ok(calls[2].url.endsWith('/setChatMenuButton'));
  assert.ok(!liveLogs.join('\n').includes(fakeToken));
  assert.ok(!liveLogs.join('\n').includes(fakeSecret));
  assert.equal(maskSecret('short'), '***');
});
