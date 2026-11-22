#!/usr/bin/env node
// A9 Protocol v15 — Zero-dependency local Node HTTP API server (default 127.0.0.1:8799).
// Automatically switches to live TonCenter sync when TONCENTER_API_BASE + A9_ROUND_CONTROLLER_ADDRESS are set.
import { createServer } from 'node:http';
import { createApiRouter } from './api.mjs';
import { PromoHotWalletEngine } from './promo-hotwallet.mjs';
import { PresaleHotWalletEngine } from './presale-hotwallet.mjs';
import { SocialStore } from './social-store.mjs';
import { PredictionEngine, ProgressionEngine } from './growth-engine.mjs';
import { TonCenterClient } from './toncenter.mjs';
import { PromoPayoutRunner } from './promo-runner.mjs';
import { PresalePayoutRunner } from './presale-runner.mjs';
import { MemoryIdentityStore } from './auth.mjs';

const port = Number(process.env.A9_PORT || 8799);
const host = process.env.A9_HOST || '127.0.0.1';

// 未配置链上数据源时默认返回空状态（dataAvailable=false），绝不伪造示例轮次、价格、质押额或人数（P0-G）。
let liveState = {
  protocolState: {
    dataAvailable: false,
    currentRoundId: null,
    successCount: null,
    poolRemainingRaw: null,
    carryRaw: null,
    teamPoolRemainingRaw: null,
    teamCarryRaw: null,
    lastSuccessAt: null,
    endAt: null,
  },
  rounds: new Map(),
};

const stateStore = {
  getTiming: () => ({ observationSeconds: Number(process.env.A9_OBS_SECONDS || 86400) }),
  getProtocolState: () => liveState.protocolState,
  listRounds: () => Array.from(liveState.rounds.values()).sort((a, b) => a.roundId - b.roundId),
  getRound: (id) => liveState.rounds.get(Number(id)) || null,
};

const promoEngine = process.env.A9_PROMO_HOT_WALLET_ADDRESS
  ? new PromoHotWalletEngine({
      hotWalletAddress: process.env.A9_PROMO_HOT_WALLET_ADDRESS,
      userFeeNano: process.env.A9_PROMO_USER_FEE_NANO || '60000000',
      transferGasNano: process.env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
    })
  : null;

const socialStore = new SocialStore();
const predictionEngine = new PredictionEngine();
const progressionEngine = new ProgressionEngine();

// 兑换业务须独立配置 A9_PRESALE_HOT_WALLET_ADDRESS 且默认关闭（A9_PRESALE_OPEN=1 显式开启）。
const presaleHotAddr = process.env.A9_PRESALE_HOT_WALLET_ADDRESS || null;
const presaleEngine = presaleHotAddr
  ? new PresaleHotWalletEngine({
      hotWalletAddress: presaleHotAddr,
      rateA9PerTon: BigInt(process.env.A9_PRESALE_RATE_A9_PER_TON || '2002'),
      minOrderTon: BigInt(process.env.A9_PRESALE_MIN_ORDER_TON || '5'),
      maxOrderTon: BigInt(process.env.A9_PRESALE_MAX_ORDER_TON || '200'),
      open: process.env.A9_PRESALE_OPEN === '1',
      userFaultFeeNano: process.env.A9_PRESALE_USER_FAULT_FEE_NANO || null,
      promoEngine,
      socialStore,
    })
  : null;

let userReader = null;
let publicKeyResolver = null;
let walletStateResolver = null;
const identityStore = new MemoryIdentityStore();

// Optional live TonCenter chain sync + promo/presale hot-wallet dry-run/live runners
if (process.env.TONCENTER_API_BASE && process.env.A9_ROUND_CONTROLLER_ADDRESS) {
  const tc = new TonCenterClient({
    apiBase: process.env.TONCENTER_API_BASE,
    apiKey: process.env.TONCENTER_API_KEY || '',
  });
  const rcAddr = process.env.A9_ROUND_CONTROLLER_ADDRESS;
  const jmAddr = process.env.A9_JETTON_MASTER_ADDRESS || null;
  publicKeyResolver = (addr) => tc.fetchWalletPublicKey(addr);
  walletStateResolver = (addr) => tc.fetchWalletAccountState(addr);

  userReader = (wallet) => tc.fetchUserPortfolio(wallet, {
    jettonMasterAddress: jmAddr,
    roundControllerAddress: rcAddr,
    roundIds: Array.from(liveState.rounds.keys()),
  });

  const syncChain = async () => {
    try {
      const ps = await tc.fetchProtocolState(rcAddr);
      liveState.protocolState = { dataAvailable: true, ...ps };
      if (ps.currentRoundId > 0) {
        // Refresh recent rounds & any active locked rounds so burnedSlices / unlockedSlices stay fresh
        const startId = Math.max(1, ps.currentRoundId - 5);
        for (let rId = startId; rId <= ps.currentRoundId; rId += 1) {
          const rd = await tc.fetchRound(rcAddr, rId);
          const existing = liveState.rounds.get(rId);
          liveState.rounds.set(rId, {
            roundId: rId,
            round: rd,
            candles: existing?.candles || [],
          });
          // Auto-settle prediction pool when on-chain round reaches SUCCEEDED (2) or FAILED (3)
          if (rd.status === 2 || rd.status === 3) {
            const stats = await predictionEngine.getRoundStats(rId);
            if (!stats.settled) {
              const res = await predictionEngine.settleRoundBets(rId, rd.status === 2, Number(rd.qualifiedCandles || 0));
              console.log(`[a9mini-v15-worker] Auto-settled prediction round #${rId}: winSide=${res.winSide}, winners=${res.winnersCount}`);
            }
          }
        }
      }
    } catch (e) {
      console.error('[a9mini-v15-worker] TonCenter sync error:', e.message);
    }
  };
  syncChain();
  setInterval(syncChain, Number(process.env.A9_SYNC_INTERVAL_MS || 10000));

  const executeLive = process.env.OPS_EXECUTE === '1';
  let sharedBroadcaster = null;
  if (executeLive && jmAddr) {
    const { createActonPromoBroadcaster } = await import('./acton-broadcaster.mjs');
    sharedBroadcaster = createActonPromoBroadcaster({
      network: process.env.A9_NETWORK || 'testnet',
      hotWalletName: process.env.A9_PROMO_HOT_WALLET_NAME || 'promoHotWallet',
      jettonMasterAddress: jmAddr,
      transferGasNano: process.env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
    });
  }

  if (promoEngine) {
    const runner = new PromoPayoutRunner({
      engine: promoEngine,
      tonCenter: tc,
      broadcaster: sharedBroadcaster,
      execute: executeLive && Boolean(sharedBroadcaster),
    });
    setInterval(() => runner.tick().catch((e) => console.error('[promo-runner] error:', e.message)), 10000);
  }

  if (presaleEngine) {
    let presaleBroadcaster = sharedBroadcaster;
    if (executeLive && jmAddr && process.env.A9_PRESALE_HOT_WALLET_NAME && process.env.A9_PRESALE_HOT_WALLET_NAME !== (process.env.A9_PROMO_HOT_WALLET_NAME || 'promoHotWallet')) {
      const { createActonPromoBroadcaster } = await import('./acton-broadcaster.mjs');
      presaleBroadcaster = createActonPromoBroadcaster({
        network: process.env.A9_NETWORK || 'testnet',
        hotWalletName: process.env.A9_PRESALE_HOT_WALLET_NAME,
        jettonMasterAddress: jmAddr,
        transferGasNano: process.env.A9_PROMO_TRANSFER_GAS_NANO || '50000000',
      });
    }
    const presaleRunner = new PresalePayoutRunner({
      engine: presaleEngine,
      tonCenter: tc,
      a9Broadcaster: presaleBroadcaster,
      // No on-chain payout verifier is wired yet: broadcast payouts stay PAYOUT_SENT (never
      // auto-COMPLETED) and any uncertain attempt goes to NEEDS_REVIEW instead of re-sending.
      payoutVerifier: null,
      promoEngine,
      execute: executeLive && Boolean(presaleBroadcaster),
    });
    setInterval(() => presaleRunner.tick().catch((e) => console.error('[presale-runner] error:', e.message)), 10000);
  }
}

const router = createApiRouter({ env: process.env, stateStore, promoEngine, presaleEngine, socialStore, predictionEngine, progressionEngine, userReader, identityStore, publicKeyResolver, walletStateResolver });

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${host}:${port}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, x-a9-admin-token, x-telegram-init-data',
    });
    res.end();
    return;
  }
  let body = null;
  if (req.method === 'POST') {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
  }
  const query = Object.fromEntries(url.searchParams.entries());
  const out = await router({ method: req.method, pathname: url.pathname, query, body, headers: req.headers });
  const headers = {
    'content-type': out.contentType || 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  };
  if (out.contentType?.startsWith('image/')) {
    headers['cache-control'] = 'public, max-age=60';
  }
  res.writeHead(out.status, headers);
  if (out.rawBody !== undefined) {
    res.end(out.rawBody instanceof Uint8Array ? Buffer.from(out.rawBody) : out.rawBody);
  } else {
    res.end(JSON.stringify(out.body));
  }
});

server.listen(port, host, () => {
  console.log(`[a9mini-v15-worker] listening on http://${host}:${port}`);
});
