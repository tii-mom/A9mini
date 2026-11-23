#!/usr/bin/env node
/**
 * A9 Protocol W2 — Standalone Production Signing & Payout Daemon (Shared D1 Ledger).
 *
 * Bridges Cloudflare Worker (cf-worker.mjs writing D1) with the on-chain signing environment:
 * - Connects to the SAME persistent D1 ledger via Cloudflare D1 HTTP API (production) or a
 *   persistent local SQLite file (isolated testnet / crash-recovery drills).
 * - Drives both PresalePayoutRunner (A9 payout + GRAM passive/anomaly refund + 12% referral credit)
 *   and PromoPayoutRunner (0.06 GRAM fee verification + recoverable A9 payout).
 * - Uses cursor-paginated TonCenter v2/v3 inbound scanning and TonCenter v3 downstream transfer verification.
 * - Dry-run by default: real execution requires `--execute` + `OPS_EXECUTE=1` + `OPS_CONFIRM=YES`
 *   (and `OPS_CONFIRM_MAINNET=YES` for mainnet).
 * - Reports liveness heartbeats to `runner_heartbeats` and optionally serves a read-only `/health` endpoint.
 */
import http from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createD1HttpClient, createSqliteFileD1 } from './d1-http-client.mjs';
import { TonCenterClient } from './toncenter.mjs';
import { D1PromoStore } from './d1-promo-store.mjs';
import { D1IdentityStore } from './auth.mjs';
import { D1SocialStore, D1PresaleStore } from './d1-growth-store.mjs';
import { D1ChestEngine } from './d1-chest-store.mjs';
import { TelegramBroadcaster, D1BroadcastLog } from './tg-broadcaster.mjs';
import { PresalePayoutRunner } from './presale-runner.mjs';
import { PromoPayoutRunner } from './promo-runner.mjs';
import { createActonPromoBroadcaster, createActonGramRefundBroadcaster } from './acton-broadcaster.mjs';
import { addressKey } from './ton-address.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 校验守护进程启动配置（fail-closed）：
 * - 强制要求推广与预售热钱包地址、签名钱包名称严格独立，严禁混用；
 * - 真实执行强制校验多道确认门禁。
 */
export function validateDaemonConfig(env = {}, { executeFlag = false } = {}) {
  const network = String(env.A9_NETWORK || 'testnet').trim().toLowerCase();
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new Error(`Invalid A9_NETWORK: ${network}`);
  }
  const hasD1Http = Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_D1_DATABASE_ID && env.CLOUDFLARE_API_TOKEN);
  const hasSqlite = Boolean(env.A9_SQLITE_PATH);
  if (!hasD1Http && !hasSqlite) {
    throw new Error('Persistent ledger required: set CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_D1_DATABASE_ID/CLOUDFLARE_API_TOKEN or A9_SQLITE_PATH');
  }
  if (!env.TONCENTER_API_BASE) {
    throw new Error('TONCENTER_API_BASE is required');
  }

  const promoAddr = String(env.A9_PROMO_HOT_WALLET_ADDRESS || '').trim() || null;
  const presaleAddr = String(env.A9_PRESALE_HOT_WALLET_ADDRESS || '').trim() || null;
  if (!promoAddr && !presaleAddr) {
    throw new Error('At least one of A9_PROMO_HOT_WALLET_ADDRESS or A9_PRESALE_HOT_WALLET_ADDRESS must be configured');
  }
  if (promoAddr && presaleAddr && addressKey(promoAddr) === addressKey(presaleAddr)) {
    throw new Error('Hot wallet isolation violated: A9_PRESALE_HOT_WALLET_ADDRESS must be distinct from A9_PROMO_HOT_WALLET_ADDRESS');
  }

  const promoWalletName = String(env.A9_PROMO_HOT_WALLET_NAME || '').trim();
  const presaleWalletName = String(env.A9_PRESALE_HOT_WALLET_NAME || '').trim();

  const executeLive = Boolean(executeFlag) && env.OPS_EXECUTE === '1';
  if (executeLive) {
    if (env.OPS_CONFIRM !== 'YES') {
      throw new Error('Refusing live payout daemon without OPS_CONFIRM=YES');
    }
    if (network === 'mainnet' && env.OPS_CONFIRM_MAINNET !== 'YES') {
      throw new Error('Refusing MAINNET payout daemon without OPS_CONFIRM_MAINNET=YES');
    }
    if (!String(env.A9_JETTON_MASTER_ADDRESS || '').trim()) {
      throw new Error('A9_JETTON_MASTER_ADDRESS is required in live execute mode');
    }
    if (promoAddr && !promoWalletName) {
      throw new Error('A9_PROMO_HOT_WALLET_NAME is required when promo hot wallet is enabled in execute mode');
    }
    if (presaleAddr && !presaleWalletName) {
      throw new Error('A9_PRESALE_HOT_WALLET_NAME is required when presale hot wallet is enabled in execute mode');
    }
    if (promoWalletName && presaleWalletName && promoWalletName === presaleWalletName) {
      throw new Error('Hot wallet isolation violated: A9_PRESALE_HOT_WALLET_NAME must be distinct from A9_PROMO_HOT_WALLET_NAME');
    }
  }

  return {
    network,
    executeLive,
    promoAddr,
    presaleAddr,
    promoWalletName,
    presaleWalletName,
    jettonMasterAddress: String(env.A9_JETTON_MASTER_ADDRESS || '').trim() || null,
    protocolVersion: String(env.A9_PROTOCOL_VERSION || 'v15').trim().toLowerCase() === 'v16' ? 'v16' : 'v15',
    runnerId: String(env.A9_RUNNER_ID || `daemon-${network}-${process.pid}`),
    intervalMs: Math.max(2000, Number(env.A9_DAEMON_INTERVAL_MS || 10000)),
    healthPort: Number(env.A9_DAEMON_HEALTH_PORT || 0),
  };
}

export async function recordRunnerHeartbeat(db, { runnerId, role = 'payout_daemon', network, nowSec, meta = {} }) {
  try {
    await db
      .prepare(
        `INSERT INTO runner_heartbeats (runner_id, role, network, last_seen_at, meta_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(runner_id) DO UPDATE SET
           role = excluded.role,
           network = excluded.network,
           last_seen_at = excluded.last_seen_at,
           meta_json = excluded.meta_json`,
      )
      .bind(runnerId, role, network, nowSec, JSON.stringify(meta))
      .run();
  } catch {
    // 兼容未跑 0010 的旧库
  }
}

export function createPayoutDaemon({
  db,
  env = process.env,
  executeFlag = false,
  tonCenter = null,
  promoBroadcaster = null,
  presaleA9Broadcaster = null,
  presaleRefundBroadcaster = null,
  payoutVerifier = null,
  logger = console,
} = {}) {
  const cfg = validateDaemonConfig(env, { executeFlag });
  const ledger = db || (env.A9_SQLITE_PATH
    ? createSqliteFileD1(env.A9_SQLITE_PATH)
    : createD1HttpClient({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        databaseId: env.CLOUDFLARE_D1_DATABASE_ID,
        apiToken: env.CLOUDFLARE_API_TOKEN,
      }));

  const tc = tonCenter || new TonCenterClient({
    apiBase: env.TONCENTER_API_BASE,
    v3ApiBase: env.TONCENTER_V3_API_BASE || null,
    apiKey: env.TONCENTER_API_KEY || '',
    testnet: cfg.network === 'testnet',
  });

  const identityStore = new D1IdentityStore({ db: ledger });
  const socialStore = new D1SocialStore({ db: ledger });
  const chestEngine = new D1ChestEngine({ db: ledger });
  const broadcaster = new TelegramBroadcaster({
    enabled: env.A9_BROADCAST_ENABLED === '1',
    botToken: env.A9_BOT_TOKEN || '',
    botHandle: env.A9_TG_BOT_HANDLE || 'A9ProtocolBot',
    publicOrigin: env.A9_PUBLIC_ORIGIN || '',
    officialChannelId: env.A9_OFFICIAL_CHANNEL_ID || '',
    whaleMinGram: env.A9_BROADCAST_WHALE_MIN_GRAM || '50',
    socialStore,
    identityStore,
    dedupLog: new D1BroadcastLog({ db: ledger }),
  });

  const promoEngine = cfg.promoAddr
    ? new D1PromoStore({
        db: ledger,
        hotWalletAddress: cfg.promoAddr,
        userFeeNano: env.A9_PROMO_USER_FEE_NANO || '60000000',
        transferGasNano: env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
      })
    : null;

  const presaleEngine = cfg.presaleAddr
    ? new D1PresaleStore({
        db: ledger,
        hotWalletAddress: cfg.presaleAddr,
        rateA9PerTon: BigInt(env.A9_PRESALE_RATE_A9_PER_TON || '2002'),
        minOrderTon: BigInt(env.A9_PRESALE_MIN_ORDER_TON || '5'),
        maxOrderTon: BigInt(env.A9_PRESALE_MAX_ORDER_TON || '200'),
        open: env.A9_PRESALE_OPEN === '1',
        userFaultFeeNano: env.A9_PRESALE_USER_FAULT_FEE_NANO || null,
        promoEngine,
        socialStore,
        identityStore,
        chestEngine,
        broadcaster,
      })
    : null;

  const projectRoot = resolve(__dirname, `../../${cfg.protocolVersion}`);
  const resolvedPromoBc = promoBroadcaster || (cfg.executeLive && cfg.promoAddr
    ? createActonPromoBroadcaster({
        network: cfg.network,
        hotWalletName: cfg.promoWalletName,
        jettonMasterAddress: cfg.jettonMasterAddress,
        transferGasNano: env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
        projectRoot,
      })
    : null);

  const resolvedPresaleA9Bc = presaleA9Broadcaster || (cfg.executeLive && cfg.presaleAddr
    ? createActonPromoBroadcaster({
        network: cfg.network,
        hotWalletName: cfg.presaleWalletName,
        jettonMasterAddress: cfg.jettonMasterAddress,
        transferGasNano: env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
        projectRoot,
      })
    : null);

  const resolvedRefundBc = presaleRefundBroadcaster || (cfg.executeLive && cfg.presaleAddr
    ? createActonGramRefundBroadcaster({
        network: cfg.network,
        hotWalletName: cfg.presaleWalletName,
        projectRoot,
      })
    : null);

  const promoRunner = promoEngine
    ? new PromoPayoutRunner({
        engine: promoEngine,
        tonCenter: tc,
        broadcaster: resolvedPromoBc,
        payoutVerifier: payoutVerifier || ((p) => tc.verifyOutboundPayout(cfg.promoAddr, p, { jettonMasterAddress: cfg.jettonMasterAddress })),
        execute: cfg.executeLive && Boolean(resolvedPromoBc),
        logger,
      })
    : null;

  const presaleRunner = presaleEngine
    ? new PresalePayoutRunner({
        engine: presaleEngine,
        tonCenter: tc,
        a9Broadcaster: resolvedPresaleA9Bc,
        tonRefundBroadcaster: resolvedRefundBc,
        payoutVerifier: payoutVerifier || ((p) => tc.verifyOutboundPayout(cfg.presaleAddr, p, { jettonMasterAddress: cfg.jettonMasterAddress })),
        promoEngine,
        execute: cfg.executeLive && Boolean(resolvedPresaleA9Bc),
        logger,
      })
    : null;

  const state = {
    startedAt: Math.floor(Date.now() / 1000),
    lastTickAt: 0,
    ticks: 0,
    lastSummary: null,
    lastError: null,
  };

  async function runOnce(nowSec = Math.floor(Date.now() / 1000)) {
    const out = { nowSec, executeLive: cfg.executeLive, presale: null, promo: null };
    try {
      if (presaleRunner) out.presale = await presaleRunner.tick(nowSec);
      if (promoRunner) out.promo = await promoRunner.tick(nowSec);
      state.lastTickAt = nowSec;
      state.ticks += 1;
      state.lastSummary = out;
      state.lastError = null;
      await recordRunnerHeartbeat(ledger, {
        runnerId: cfg.runnerId,
        role: 'payout_daemon',
        network: cfg.network,
        nowSec,
        meta: {
          executeLive: cfg.executeLive,
          presaleErrors: out.presale?.errors?.length || 0,
          promoErrors: out.promo?.errors?.length || 0,
        },
      });
    } catch (e) {
      state.lastError = e?.message || String(e);
      throw e;
    }
    return out;
  }

  return {
    config: cfg,
    ledger,
    promoEngine,
    presaleEngine,
    promoRunner,
    presaleRunner,
    state,
    runOnce,
  };
}

// CLI entrypoint
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const executeFlag = args.has('--execute');
  const once = args.has('--once');
  const daemon = createPayoutDaemon({ env: process.env, executeFlag });

  let healthServer = null;
  if (daemon.config.healthPort > 0) {
    healthServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          runnerId: daemon.config.runnerId,
          network: daemon.config.network,
          executeLive: daemon.config.executeLive,
          ...daemon.state,
        }));
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    healthServer.listen(daemon.config.healthPort, '127.0.0.1', () => {
      console.log(`[payout-daemon] health endpoint listening on http://127.0.0.1:${daemon.config.healthPort}/health`);
    });
  }

  console.log(`[payout-daemon] started runnerId=${daemon.config.runnerId} network=${daemon.config.network} mode=${daemon.config.executeLive ? 'LIVE-EXECUTE' : 'DRY-RUN'}`);
  if (once) {
    const res = await daemon.runOnce();
    console.log(JSON.stringify(res, null, 2));
    if (healthServer) healthServer.close();
    if (typeof daemon.ledger?.close === 'function') daemon.ledger.close();
  } else {
    const loop = async () => {
      try {
        await daemon.runOnce();
      } catch (e) {
        console.error('[payout-daemon] tick error:', e?.message || e);
      }
    };
    await loop();
    setInterval(loop, daemon.config.intervalMs);
  }
}
