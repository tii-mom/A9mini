#!/usr/bin/env node
// A9 Protocol v16.1 — Telegram Bot Webhook, Commands & Menu Button Setup Script.
// Default --dry-run (zero network requests); live calls require --execute AND OPS_EXECUTE=1.
import { pathToFileURL } from 'node:url';

const SECRET_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

export function maskSecret(value) {
  const s = String(value || '').trim();
  if (!s) return '(unset)';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

function assertHttpsUrl(raw, label) {
  const s = String(raw || '').trim();
  if (!s) throw new Error(`${label} is required`);
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`${label} is not a valid URL: ${s}`);
  }
  if (u.protocol !== 'https:' || !u.hostname) {
    throw new Error(`${label} must use https:// protocol: ${s}`);
  }
  return u.href.replace(/\/+$/, '');
}

export function buildBotSetupPlan({
  webhookUrl = '',
  appUrl = '',
  secretToken = '',
  deleteWebhook = false,
} = {}) {
  const normalizedAppUrl = assertHttpsUrl(appUrl, 'appUrl');
  const calls = [];

  if (deleteWebhook) {
    calls.push({
      method: 'deleteWebhook',
      body: { drop_pending_updates: false },
      summary: { drop_pending_updates: false },
    });
  } else {
    const normalizedWebhookUrl = assertHttpsUrl(webhookUrl, 'webhookUrl');
    const cleanSecret = String(secretToken || '').trim();
    if (!SECRET_TOKEN_RE.test(cleanSecret)) {
      throw new Error('secretToken must be 16..256 chars matching [A-Za-z0-9_-] (cannot use short or unsafe tokens)');
    }
    calls.push({
      method: 'setWebhook',
      body: {
        url: normalizedWebhookUrl,
        secret_token: cleanSecret,
        allowed_updates: ['message', 'edited_message'],
        drop_pending_updates: false,
      },
      summary: {
        url: normalizedWebhookUrl,
        secret_token: maskSecret(cleanSecret),
        allowed_updates: ['message', 'edited_message'],
        drop_pending_updates: false,
      },
    });
  }

  calls.push({
    method: 'setMyCommands',
    body: {
      commands: [
        { command: 'start', description: '打开 A9 财富大冒险 · 领青铜箱与绑归因' },
        { command: 'status', description: '查看链上当前轮次与 24H 达标战况' },
        { command: 'help', description: '查看玩法规则、+0.06/0.03 GRAM Gas 与安全提示' },
      ],
    },
    summary: { commandCount: 3, commands: ['start', 'status', 'help'] },
  });

  calls.push({
    method: 'setChatMenuButton',
    body: {
      menu_button: {
        type: 'web_app',
        text: '进入 A9 财富大冒险',
        web_app: { url: normalizedAppUrl },
      },
    },
    summary: {
      menu_button: {
        type: 'web_app',
        text: '进入 A9 财富大冒险',
        web_app: { url: normalizedAppUrl },
      },
    },
  });

  return {
    deleteWebhook: Boolean(deleteWebhook),
    appUrl: normalizedAppUrl,
    calls,
  };
}

export async function executeBotSetup({
  execute = false,
  opsExecuteEnv = process.env.OPS_EXECUTE || '',
  botToken = '',
  webhookUrl = '',
  appUrl = '',
  secretToken = '',
  deleteWebhook = false,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const plan = buildBotSetupPlan({ webhookUrl, appUrl, secretToken, deleteWebhook });
  const isLive = Boolean(execute);
  if (isLive) {
    if (String(opsExecuteEnv).trim() !== '1') {
      throw new Error('Refusing --execute without OPS_EXECUTE=1');
    }
    if (!String(botToken || '').trim()) {
      throw new Error('botToken (A9_BOT_TOKEN) is required in --execute mode');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch implementation is required in --execute mode');
    }
  }

  logger.log(
    `[setup-tg-bot] mode=${isLive ? 'EXECUTE' : 'DRY-RUN'} botToken=${maskSecret(botToken)} calls=${plan.calls.length}`,
  );
  for (const call of plan.calls) {
    logger.log(`[setup-tg-bot] -> ${call.method}: ${JSON.stringify(call.summary)}`);
  }

  if (!isLive) {
    return { executed: false, dryRun: true, plan };
  }

  const doFetch = fetchImpl === globalThis.fetch ? (...args) => globalThis.fetch(...args) : fetchImpl;
  const cleanToken = String(botToken).trim();
  const results = [];
  for (const call of plan.calls) {
    const endpoint = `https://api.telegram.org/bot${cleanToken}/${call.method}`;
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(call.body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      throw new Error(`Telegram ${call.method} failed (HTTP ${res.status}): ${json?.description || 'unknown error'}`);
    }
    results.push({ method: call.method, ok: true, result: json.result ?? true });
    logger.log(`[setup-tg-bot] [OK] ${call.method}`);
  }
  return { executed: true, dryRun: false, plan, results };
}

function parseArgs(argv) {
  const out = {
    execute: false,
    deleteWebhook: false,
    webhookUrl:
      process.env.A9_WEBHOOK_URL ||
      (process.env.A9_API_ORIGIN ? `${String(process.env.A9_API_ORIGIN).replace(/\/+$/, '')}/api/telegram/webhook` : ''),
    appUrl: process.env.A9_PUBLIC_ORIGIN || 'https://app.a9.lat',
    botToken: process.env.A9_BOT_TOKEN || '',
    secretToken: process.env.A9_TG_WEBHOOK_SECRET || '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--execute') out.execute = true;
    else if (a === '--dry-run') out.execute = false;
    else if (a === '--delete-webhook') out.deleteWebhook = true;
    else if (a === '--webhook-url') out.webhookUrl = argv[++i] || '';
    else if (a === '--app-url') out.appUrl = argv[++i] || '';
    else if (a === '--bot-token') out.botToken = argv[++i] || '';
    else if (a === '--secret') out.secretToken = argv[++i] || '';
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  executeBotSetup(args).catch((e) => {
    console.error(`[setup-tg-bot] ERROR: ${e?.message || e}`);
    process.exit(1);
  });
}
