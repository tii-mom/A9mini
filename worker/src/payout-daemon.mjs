#!/usr/bin/env node
/**
 * A9 Protocol W2 — Standalone Production Signing & Payout Daemon (Shared D1 Ledger).
 *
 * Bridges Cloudflare Worker (cf-worker.mjs writing D1) with the on-chain signing environment:
 * - Connects to the SAME persistent D1 ledger via Cloudflare D1 HTTP API (production) or a
 *   persistent local SQLite file (isolated testnet / crash-recovery drills).
 * - Drives both PresalePayoutRunner (A9 payout + GRAM passive/anomaly refund + 6% referral credit)
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
import { D1PromoBudgetLedger } from './promo-budget.mjs';
import { resolvePredictionConfig } from './prediction-config.mjs';
import { D1IdentityStore } from './auth.mjs';
import { D1SocialStore, D1PredictionEngine, D1PresaleStore } from './d1-growth-store.mjs';
import { D1ChestEngine } from './d1-chest-store.mjs';
import { TelegramBroadcaster, D1BroadcastLog } from './tg-broadcaster.mjs';
import { PresalePayoutRunner } from './presale-runner.mjs';
import { PromoPayoutRunner } from './promo-runner.mjs';
import { createActonPromoBroadcaster, createActonGramRefundBroadcaster } from './acton-broadcaster.mjs';
import { addressKey, parseTonAddress } from './ton-address.mjs';

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
  if (network === 'mainnet' && /testnet\.toncenter\.com/i.test(String(env.TONCENTER_API_BASE))) {
    throw new Error('Mainnet daemon cannot use testnet.toncenter.com as TONCENTER_API_BASE');
  }

  const assertDaemonAddr = (label, raw) => {
    const parsed = parseTonAddress(raw);
    if (!parsed || parsed.workchain !== 0) {
      throw new Error(`Invalid Basechain TON address for ${label}: ${raw}`);
    }
    if (network === 'mainnet' && parsed.testOnly === true) {
      throw new Error(`${label} cannot use a testnet-only address on mainnet: ${raw}`);
    }
  };

  const promoAddr = String(env.A9_PROMO_HOT_WALLET_ADDRESS || '').trim() || null;
  const presaleAddr = String(env.A9_PRESALE_HOT_WALLET_ADDRESS || '').trim() || null;
  if (!promoAddr && !presaleAddr) {
    throw new Error('At least one of A9_PROMO_HOT_WALLET_ADDRESS or A9_PRESALE_HOT_WALLET_ADDRESS must be configured');
  }
  if (promoAddr) assertDaemonAddr('A9_PROMO_HOT_WALLET_ADDRESS', promoAddr);
  if (presaleAddr) assertDaemonAddr('A9_PRESALE_HOT_WALLET_ADDRESS', presaleAddr);
  if (promoAddr && presaleAddr && addressKey(promoAddr) === addressKey(presaleAddr)) {
    throw new Error('Hot wallet isolation violated: A9_PRESALE_HOT_WALLET_ADDRESS must be distinct from A9_PROMO_HOT_WALLET_ADDRESS');
  }
  const jettonMasterTrim = String(env.A9_JETTON_MASTER_ADDRESS || '').trim();
  if (jettonMasterTrim) assertDaemonAddr('A9_JETTON_MASTER_ADDRESS', jettonMasterTrim);

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
    protocolVersion: (() => {
      const raw = String(env.A9_PROTOCOL_VERSION ?? '').trim().toLowerCase();
      if (!raw) return 'v17';
      if (raw === 'v17' || raw === 'v16') return raw;
      throw new Error(`Unsupported A9_PROTOCOL_VERSION: "${env.A9_PROTOCOL_VERSION}" (expected "v17" or "v16")`);
    })(),
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
  } catch (e) {
    if (!/no such table/i.test(String(e?.message || e))) throw e;
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

  const budgetLedger = new D1PromoBudgetLedger({ db: ledger });
  const promoEngine = cfg.promoAddr
    ? new D1PromoStore({
        db: ledger,
        hotWalletAddress: cfg.promoAddr,
        userFeeNano: env.A9_PROMO_USER_FEE_NANO || '60000000',
        transferGasNano: env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
      })
    : null;
  const canPromoteRebind = promoEngine && typeof promoEngine.hasPendingClaim === 'function'
    ? async ({ fromWalletAddress, nowSec: checkNow }) => !(await promoEngine.hasPendingClaim(fromWalletAddress, checkNow))
    : null;
  const identityStore = new D1IdentityStore({ db: ledger, promoEngine, canPromoteRebind, strictAtomicRebind: true });
  const socialStore = new D1SocialStore({ db: ledger });
  const chestEngine = new D1ChestEngine({ db: ledger, budgetLedger });
  const broadcaster = new TelegramBroadcaster({
    enabled: env.A9_BROADCAST_ENABLED === '1',
    botToken: env.A9_BOT_TOKEN || '',
    botHandle: env.A9_TG_BOT_HANDLE || 'A9_TonBot',
    publicOrigin: env.A9_PUBLIC_ORIGIN || '',
    apiOrigin: env.A9_API_ORIGIN || env.A9_PUBLIC_ORIGIN || '',
    officialChannelId: env.A9_OFFICIAL_CHANNEL_ID || '',
    whaleMinGram: env.A9_BROADCAST_WHALE_MIN_GRAM || '50',
    socialStore,
    identityStore,
    dedupLog: new D1BroadcastLog({ db: ledger }),
  });

  const predCfg = resolvePredictionConfig(env);
  const predictionEngine = new D1PredictionEngine({
    db: ledger,
    defaultPoolA9Raw: predCfg.defaultPoolA9RawStr,
    firstLossBonusRaw: predCfg.firstLossBonusRaw,
    firstLossCapRaw: predCfg.firstLossCapRaw,
    budgetLedger,
  });

  const presaleEngine = cfg.presaleAddr
    ? new D1PresaleStore({
        db: ledger,
        hotWalletAddress: cfg.presaleAddr,
        rateA9PerTon: BigInt(env.A9_PRESALE_RATE_A9_PER_TON || '2002'),
        minOrderTon: BigInt(env.A9_PRESALE_MIN_ORDER_TON || '5'),
        maxOrderTon: BigInt(env.A9_PRESALE_MAX_ORDER_TON || '500'),
        open: env.A9_PRESALE_OPEN === '1',
        deliveryFeeNano: env.A9_PRESALE_DELIVERY_FEE_NANO || undefined,
        refundFeeNano: env.A9_PRESALE_REFUND_FEE_NANO || undefined,
        userFaultFeeNano: env.A9_PRESALE_USER_FAULT_FEE_NANO || null,
        promoEngine,
        socialStore,
        identityStore,
        predictionEngine,
        chestEngine,
        budgetLedger,
        broadcaster,
      })
    : null;

  const projectRoot = resolve(__dirname, `../../${cfg.protocolVersion}`);
  const resolvedPromoBc = promoBroadcaster || (cfg.executeLive && cfg.promoAddr
    ? createActonPromoBroadcaster({
        network: cfg.network,
        hotWalletName: cfg.promoWalletName,
        expectedHotWalletAddress: cfg.promoAddr,
        jettonMasterAddress: cfg.jettonMasterAddress,
        transferGasNano: env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
        projectRoot,
        baseEnv: env,
      })
    : null);

  const resolvedPresaleA9Bc = presaleA9Broadcaster || (cfg.executeLive && cfg.presaleAddr
    ? createActonPromoBroadcaster({
        network: cfg.network,
        hotWalletName: cfg.presaleWalletName,
        expectedHotWalletAddress: cfg.presaleAddr,
        jettonMasterAddress: cfg.jettonMasterAddress,
        transferGasNano: env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
        projectRoot,
        baseEnv: env,
      })
    : null);

  const resolvedRefundBc = presaleRefundBroadcaster || (cfg.executeLive && cfg.presaleAddr
    ? createActonGramRefundBroadcaster({
        network: cfg.network,
        hotWalletName: cfg.presaleWalletName,
        expectedHotWalletAddress: cfg.presaleAddr,
        projectRoot,
        baseEnv: env,
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

  async function probeHotWalletInventory(nowSec) {
    const shouldProbe = (cfg.executeLive || env.A9_CHECK_HOT_WALLET_INVENTORY === '1')
      && Boolean(cfg.jettonMasterAddress)
      && typeof tc?.fetchAccountBalanceNano === 'function'
      && (typeof tc?.fetchHotWalletInventoryState === 'function' || typeof tc?.fetchUserJettonWallet === 'function');
    if (!shouldProbe) return null;

    const minGramNano = BigInt(env.A9_HOT_WALLET_MIN_GRAM_NANO || '100000000'); // 0.10 GRAM gas floor
    const minPresaleA9Raw = BigInt(env.A9_PRESALE_MIN_A9_RAW || '2500000000000'); // 2,500 A9 (1 Bronze max payout)
    const minPromoA9Raw = BigInt(env.A9_PROMO_MIN_A9_RAW || '200000000000'); // 200 A9 floor

    const sumBigInt = (rows, col) => {
      let acc = 0n;
      for (const r of rows || []) {
        const v = String(r?.[col] ?? '0').trim();
        if (/^\d+$/.test(v)) acc += BigInt(v);
      }
      return acc;
    };

    const readInventoryState = async (owner, previous, confirmedRows) => {
      if (typeof tc.fetchHotWalletInventoryState !== 'function') {
        // Legacy adapters can report a balance but cannot prove which debits it includes.
        const jw = await tc.fetchUserJettonWallet(cfg.jettonMasterAddress, owner);
        if (!jw?.balanceAvailable || jw.a9BalanceRaw === null) throw new Error('Hot wallet A9 balance unavailable');
        return { a9Raw: BigInt(jw.a9BalanceRaw), uncovered: sumBigInt(confirmedRows, 'amount') };
      }

      const jw = await tc.fetchHotWalletInventoryState(cfg.jettonMasterAddress, owner);
      const { jettonWallet, walletLt } = jw;
      if (previous?.network === cfg.network && addressKey(previous.jettonMaster) === addressKey(cfg.jettonMasterAddress)
          && addressKey(previous.walletAddress) === addressKey(owner)
          && addressKey(previous.jettonWallet) === addressKey(jettonWallet) && previous.walletLt
          && (BigInt(walletLt) < BigInt(previous.walletLt)
              || (walletLt === previous.walletLt && previous.a9Raw !== jw.a9BalanceRaw))) {
        throw new Error('JettonWallet inventory state regressed or changed at the same logical time');
      }

      const scope = [cfg.network, addressKey(cfg.jettonMasterAddress), addressKey(jettonWallet)];
      const cached = (await ledger.prepare(
        'SELECT tx_hash, debit_lt FROM hot_wallet_payout_debits WHERE network = ? AND jetton_master = ? AND jetton_wallet = ?',
      ).bind(...scope).all())?.results || [];
      const debits = new Map(cached.map((row) => [row.tx_hash, BigInt(row.debit_lt)]));
      const missing = confirmedRows.filter((row) => row.tx_hash && !debits.has(row.tx_hash));
      // Bound RPC work per tick. Rotate through unresolved entries so one missing receipt cannot starve later ones.
      const batchSize = 8;
      const offset = (state.ticks * batchSize) % (missing.length || 1);
      const toCheck = missing.slice(offset, offset + batchSize);
      for (const { tx_hash: hash } of toCheck) {
        let debitLt;
        try {
          debitLt = await tc.fetchHotWalletPayoutDebitLt(jettonWallet, owner, hash);
        } catch (e) {
          logger.error('[payout-daemon] debit receipt unavailable:', e?.message || String(e));
          break;
        }
        if (!/^[1-9]\d{0,19}$/.test(typeof debitLt === 'string' ? debitLt : '')) continue;
        await ledger.prepare(
          `INSERT OR IGNORE INTO hot_wallet_payout_debits
           (network, jetton_master, jetton_wallet, tx_hash, debit_lt) VALUES (?, ?, ?, ?, ?)`,
        ).bind(...scope, hash, debitLt).run();
        debits.set(hash, BigInt(debitLt));
      }
      const head = BigInt(walletLt);
      const uncovered = sumBigInt(confirmedRows.filter(({ tx_hash: hash }) => !debits.has(hash) || debits.get(hash) > head), 'amount');
      return { a9Raw: BigInt(jw.a9BalanceRaw), jettonWallet, walletLt, uncovered };
    };

    const prevRow = await ledger.prepare('SELECT meta_json FROM runner_heartbeats WHERE runner_id = ? LIMIT 1')
      .bind(cfg.runnerId).first();
    const prevInv = prevRow?.meta_json ? JSON.parse(prevRow.meta_json)?.inventory : null;
    const stableState = (previous) => previous?.walletLt ? {
      network: previous.network,
      jettonMaster: previous.jettonMaster,
      walletAddress: previous.walletAddress,
      jettonWallet: previous.jettonWallet,
      walletLt: previous.walletLt,
      a9Raw: previous.a9Raw,
    } : {};

    const inventory = {};

    if (cfg.presaleAddr) {
      try {
        let reservedA9 = 0n;
        let reservedGram = 0n;
        let confirmedA9Rows = [];
        try {
          const pRows = (await ledger.prepare("SELECT payout_id, kind, amount, status, tx_hash, updated_at FROM presale_payouts WHERE status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT', 'NEEDS_REVIEW', 'CONFIRMED')").all())?.results || [];
          for (const r of pRows) {
            const amt = /^\d+$/.test(String(r.amount || '')) ? BigInt(r.amount) : 0n;
            if (r.status === 'CONFIRMED') {
              if (r.kind === 'A9') confirmedA9Rows.push(r);
              continue;
            }
            if (r.kind === 'A9') reservedA9 += amt;
            else if (r.kind === 'REFUND') reservedGram += amt;
          }
          const oRows = (await ledger.prepare("SELECT o.order_id, o.a9_amount_raw, o.bonus_a9_raw, o.bonus_rolled, o.status, o.expires_at, r.reserved_bonus_raw, r.settled_bonus_raw, r.bonus_status FROM presale_orders o LEFT JOIN presale_order_reservations r ON r.order_id = o.order_id WHERE o.status IN ('PENDING_PAYMENT', 'PAYMENT_CONFIRMED')").all())?.results || [];
          for (const o of oRows) {
            if (o.status === 'PENDING_PAYMENT' && Number(o.expires_at || 0) > 0 && Number(o.expires_at) < nowSec) continue;
            const base = /^\d+$/.test(String(o.a9_amount_raw || '')) ? BigInt(o.a9_amount_raw) : 0n;
            if (o.bonus_status === 'SETTLED') {
              reservedA9 += base + BigInt(String(o.settled_bonus_raw || '0'));
            } else if (o.bonus_status === 'RESERVED') {
              reservedA9 += base + BigInt(String(o.reserved_bonus_raw || '0'));
            } else if (Number(o.bonus_rolled || 0) === 1) {
              reservedA9 += base + BigInt(String(o.bonus_a9_raw || '0'));
            } else {
              reservedA9 += (base * 16667n + 9999n) / 10000n;
            }
          }
        } catch (dbErr) {
          if (!/no such table/i.test(String(dbErr?.message || dbErr))) throw dbErr;
        }
        const gramNano = await tc.fetchAccountBalanceNano(cfg.presaleAddr);
        const { a9Raw, jettonWallet, walletLt, uncovered } = await readInventoryState(cfg.presaleAddr, prevInv?.presale, confirmedA9Rows);
        reservedA9 += uncovered;
        const gramAvailableNano = gramNano > reservedGram ? gramNano - reservedGram : 0n;
        const a9AvailableRaw = a9Raw > reservedA9 ? a9Raw - reservedA9 : 0n;
        const ok = gramAvailableNano >= minGramNano && a9AvailableRaw >= minPresaleA9Raw;
        inventory.presale = {
          ok,
          network: cfg.network,
          jettonMaster: cfg.jettonMasterAddress,
          walletAddress: cfg.presaleAddr,
          fetchedAt: nowSec,
          ...(walletLt ? { jettonWallet, walletLt } : {}),
          gramNano: gramNano.toString(),
          gramAvailableNano: gramAvailableNano.toString(),
          a9Raw: a9Raw.toString(),
          a9AvailableRaw: a9AvailableRaw.toString(),
          reservedA9Raw: reservedA9.toString(),
          reservedGramNano: reservedGram.toString(),
          reason: ok ? null : (gramAvailableNano < minGramNano ? 'LOW_GRAM_GAS' : 'LOW_A9_INVENTORY'),
        };
      } catch (e) {
        inventory.presale = { ...stableState(prevInv?.presale), ok: false, fetchedAt: nowSec, reason: e?.message || 'INVENTORY_PROBE_FAILED' };
      }
    }

    if (cfg.promoAddr) {
      try {
        let reservedA9 = 0n;
        let confirmedPromoRows = [];
        try {
          // 一笔责任只算一次：claimable_raw 已包含 PENDING_FEE 待付费领取，不重复叠加 PENDING_FEE；
          // 叠加未终局 promo_payouts、已扣余额但尚未生成 payout 的 FEE_CONFIRMED/PAYOUT_SENT 领取，以及商城订单已预留未入账的 6% 返佣。
          const bRows = (await ledger.prepare("SELECT claimable_raw FROM promo_balances WHERE claimable_raw != '0'").all())?.results || [];
          reservedA9 += sumBigInt(bRows, 'claimable_raw');
          const pRows = (await ledger.prepare("SELECT payout_id, amount_raw AS amount, status, tx_hash, updated_at FROM promo_payouts WHERE status IN ('PENDING', 'BROADCASTING', 'RETRY', 'SENT', 'NEEDS_REVIEW', 'CONFIRMED')").all())?.results || [];
          for (const r of pRows) {
            if (r.status === 'CONFIRMED') {
              confirmedPromoRows.push(r);
              continue;
            }
            const amt = /^\d+$/.test(String(r.amount || '')) ? BigInt(r.amount) : 0n;
            reservedA9 += amt;
          }
          const cRows = (await ledger.prepare("SELECT c.amount_raw FROM promo_claims c LEFT JOIN promo_payouts p ON p.claim_id = c.claim_id WHERE c.status IN ('FEE_CONFIRMED', 'PAYOUT_SENT') AND p.claim_id IS NULL").all())?.results || [];
          reservedA9 += sumBigInt(cRows, 'amount_raw');
          try {
            const rRows = (await ledger.prepare("SELECT reserved_referral_raw FROM presale_order_reservations WHERE referral_status = 'RESERVED'").all())?.results || [];
            reservedA9 += sumBigInt(rRows, 'reserved_referral_raw');
            const rcRows = (await ledger.prepare("SELECT rc.amount_raw FROM presale_referral_credits rc WHERE rc.status IN ('PENDING', 'CREDITING', 'NEEDS_REVIEW') AND NOT EXISTS (SELECT 1 FROM presale_order_reservations r WHERE r.order_id = rc.order_id AND r.referral_status = 'RESERVED')").all())?.results || [];
            reservedA9 += sumBigInt(rcRows, 'amount_raw');
          } catch (resErr) {
            if (!/no such table/i.test(String(resErr?.message || resErr))) throw resErr;
          }
        } catch (dbErr) {
          if (!/no such table/i.test(String(dbErr?.message || dbErr))) throw dbErr;
        }
        const gramNano = await tc.fetchAccountBalanceNano(cfg.promoAddr);
        const { a9Raw, jettonWallet, walletLt, uncovered } = await readInventoryState(cfg.promoAddr, prevInv?.promo, confirmedPromoRows);
        reservedA9 += uncovered;
        const a9AvailableRaw = a9Raw > reservedA9 ? a9Raw - reservedA9 : 0n;
        const ok = gramNano >= minGramNano && a9AvailableRaw >= minPromoA9Raw;
        inventory.promo = {
          ok,
          network: cfg.network,
          jettonMaster: cfg.jettonMasterAddress,
          walletAddress: cfg.promoAddr,
          fetchedAt: nowSec,
          ...(walletLt ? { jettonWallet, walletLt } : {}),
          gramNano: gramNano.toString(),
          gramAvailableNano: gramNano.toString(),
          a9Raw: a9Raw.toString(),
          a9AvailableRaw: a9AvailableRaw.toString(),
          reservedA9Raw: reservedA9.toString(),
          reason: ok ? null : (gramNano < minGramNano ? 'LOW_GRAM_GAS' : 'LOW_A9_INVENTORY'),
        };
      } catch (e) {
        inventory.promo = { ...stableState(prevInv?.promo), ok: false, fetchedAt: nowSec, reason: e?.message || 'INVENTORY_PROBE_FAILED' };
      }
    }

    return inventory;
  }

  async function runOnce(nowSec = Math.floor(Date.now() / 1000)) {
    const out = { nowSec, executeLive: cfg.executeLive, presale: null, promo: null, inventory: null, errors: [] };
    if (presaleRunner) {
      try {
        out.presale = await presaleRunner.tick(nowSec);
      } catch (e) {
        const msg = e?.message || String(e);
        out.errors.push(`presale: ${msg}`);
        logger.error('[payout-daemon] presale tick error:', msg);
      }
    }
    if (promoRunner) {
      try {
        out.promo = await promoRunner.tick(nowSec);
      } catch (e) {
        const msg = e?.message || String(e);
        out.errors.push(`promo: ${msg}`);
        logger.error('[payout-daemon] promo tick error:', msg);
      }
    }
    const presaleErrors = (out.presale?.errors?.length || 0) + (out.presale ? 0 : (presaleRunner ? 1 : 0));
    const promoErrors = (out.promo?.errors?.length || 0) + (out.promo ? 0 : (promoRunner ? 1 : 0));
    const allSkipped = Boolean(
      (!presaleRunner || out.presale?.skipped === true)
      && (!promoRunner || out.promo?.skipped === true)
      && (presaleRunner || promoRunner),
    );
    if (!allSkipped) {
      out.inventory = await probeHotWalletInventory(nowSec);
      if (out.inventory?.presale && out.inventory.presale.ok === false) {
        out.errors.push(`presale_inventory: ${out.inventory.presale.reason}`);
      }
      if (out.inventory?.promo && out.inventory.promo.ok === false) {
        out.errors.push(`promo_inventory: ${out.inventory.promo.reason}`);
      }
    }
    const totalErrors = out.errors.length + presaleErrors + promoErrors;
    state.lastTickAt = nowSec;
    state.ticks += 1;
    state.lastSummary = out;
    state.lastError = out.errors.length
      ? out.errors.join(' | ')
      : (totalErrors > 0 ? `runner errors (presale=${presaleErrors}, promo=${promoErrors})` : null);

    // P1-2 防伪造健康心跳：若所有 runner 均处于 skipped（上轮卡死重入），绝不刷新心跳时间戳
    if (!allSkipped) {
      await recordRunnerHeartbeat(ledger, {
        runnerId: cfg.runnerId,
        role: 'payout_daemon',
        network: cfg.network,
        nowSec,
        meta: {
          status: totalErrors === 0 ? 'ok' : 'degraded',
          executeLive: cfg.executeLive,
          presaleErrors,
          promoErrors,
          lastError: state.lastError,
          ...(out.inventory ? { inventory: out.inventory } : {}),
        },
      });
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
      } finally {
        setTimeout(loop, daemon.config.intervalMs);
      }
    };
    await loop();
  }
}
