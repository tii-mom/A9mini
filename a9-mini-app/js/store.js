/**
 * A9 Centralized Reactive State Store
 *
 * 持久化边界（本轮迁移的关键改动）：
 *   localStorage 只保存 UI 偏好（语言、资产视图、自动续期开关），
 *   余额 / 凭证 / 轮次 / 行情 / 团队 / 账单一律不落盘。
 *   这样演示模式的模拟资金数据不会通过缓存进入真实模式。
 *
 * 所有模拟资金动作都转发到 js/demo-data.js，并在真实模式下直接拒绝。
 */

import { config } from './config.js';
import { demoFundsStake, demoFundsClaim, demoFundsBuy, demoFundsClaimPromo, applyDemoInitialState, resetDemoPrediction } from './demo-data.js';

const STORAGE_KEY = 'a9_ui_prefs_v1';
const REF_SESSION_KEY = 'a9_referrer_id_v1';

function createInitialCandles() {
  // 演示模式初始雷达（真实模式由 data.js 的服务端快照覆盖）
  const pattern = [
    { h: 24, bull: true,  p: 0.1868 },
    { h: 28, bull: true,  p: 0.1892 },
    { h: 18, bull: false, p: 0.1821 },
    { h: 26, bull: true,  p: 0.1880 },
    { h: 22, bull: true,  p: 0.1874 },
    { h: 30, bull: true,  p: 0.1912 },
    { h: 20, bull: false, p: 0.1835 },
    { h: 25, bull: true,  p: 0.1888 },
    { h: 21, bull: true,  p: 0.1869 },
    { h: 29, bull: true,  p: 0.1904 },
    { h: 17, bull: false, p: 0.1819 },
    { h: 26, bull: true,  p: 0.1891 },
    { h: 24, bull: true,  p: 0.1886 },
    { h: 27, bull: true,  p: 0.1901 },
    { h: 23, bull: true,  p: 0.1895 },
    { h: 26, bull: true,  p: 0.1910, active: true }
  ];
  const candles = [];
  for (let i = 1; i <= 24; i++) {
    if (i <= 16) {
      candles.push({ index: i, status: i === 16 ? 'active' : 'closed', confirmed: i < 16, ...pattern[i - 1] });
    } else {
      candles.push({ index: i, status: 'pending', confirmed: false, h: 12, bull: true, p: null });
    }
  }
  return candles;
}

const DEFAULT_STATE = {
  user: {
    connected: false,
    tgBound: false,
    address: null,
    shortAddress: null,
    username: null,
    vipLevel: '—',
    weightMultiplier: 1,
    tonBalance: 0,
    a9Available: 0,
    a9Claimable: 0,
    a9Locked: 0,
    a9TotalEarned: 0,
    profileMode: 'active', // 'active' | 'empty'
    autoRenew: true,
    renewMultiplier: 2.0,
    warmupRegistered: false,
    warmupInvites: 0,
    warmupDistStatus: 'pending_freeze'
  },
  round: {
    currentRound: 1,
    openEnded: true,
    totalRounds: null,
    stage: 'participation',
    targetPrice: null,
    twap24h: null,
    livePrice: null,
    priceHistory: [],
    quickStakeTon: 100,
    priceChangePct: null,
    tonUsd: 3.00,
    poolA9: 700000000,
    teamPoolA9: 120000000,
    totalStakedTon: 0,
    totalTraders: 0,
    countdownSec: null,
    earlyBirdSec: null,
    activeCandleSec: 0,
    candles: createInitialCandles(),
    myStakeTon: 0,
    myWeight: 0,
    myEarlyTier: 2.0,
    // 服务端驱动字段（由 js/data.js 的 mapRoundView 注入）
    qualifiedCandles: 0,
    candlesConfirmed: 0,
    minQualifiedCandles: 16,
    needMore: 16,
    source: null,
    sourceLabel: null,
    fetchedAt: null,
    stale: false,
    stakingEnabled: false
  },
  certificates: [],
  ledger: [],
  market: {
    rateA9PerTon: 2002,
    minOrderTon: 5,
    maxOrderTon: 200,
    hardCapTon: 1000,
    unlockedQuotaTon: 750,
    usedQuotaTon: 150,
    soldOut: false,
    records: []
  },
  team: {
    role: 'none',
    id: null,
    name: null,
    level: 0,
    boostPct: 0,
    membersActive: 0,
    membersTotal: 0,
    directInvites: 0,
    teamStakedTon: 0,
    teamStakedTarget: 0,
    captainDividendTon: 0,
    captainHistoryTon: 0,
    captainHistoryA9: 0,
    tgGroupBound: false,
    tgGroupHandle: null,
    tgGroupMembers: 0,
    recruitMinTon: 50,
    topMembers: []
  },
  risk: {
    status: 'UNKNOWN',
    latencyMs: null,
    oracleDeviationPct: null,
    blockHeight: null,
    activeRpc: null
  },
  prediction: {
    roundId: null,
    passCount: 0,
    burnCount: 0,
    total: 0,
    passPct: 50,
    burnPct: 50,
    settled: false,
    winningSide: null,
    pendingActivationRaw: '0',
    activatedRaw: '0',
    currentBet: null,
    streak: 0,
    winRate: null,
    inviteBoostCount: 0,
    pendingExpiresAt: null,
    expanded: null,
    loaded: false
  },
  referral: {
    referrerId: null,
    pendingScrollTarget: null
  },
  settings: {
    language: 'zh-CN',
    hapticsEnabled: true,
    hourlyCandlePush: true,
    settlementPush: true,
    rankDefensePush: true,
    reducedMotion: false
  }
};

/** 仅恢复 UI 偏好，绝不恢复任何资金/轮次数据。演示模式下注入内存态演示样本。 */
function loadState() {
  const state = structuredClone(DEFAULT_STATE);
  if (config.isDemo) applyDemoInitialState(state);
  try {
    const savedRef = sessionStorage.getItem(REF_SESSION_KEY);
    if (savedRef) state.referral.referrerId = savedRef;
  } catch (_) {}
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (parsed && typeof parsed === 'object') {
      if (parsed.settings && typeof parsed.settings === 'object') {
        state.settings = { ...state.settings, ...parsed.settings };
      }
      if (parsed.user && typeof parsed.user === 'object') {
        if (typeof parsed.user.profileMode === 'string') state.user.profileMode = parsed.user.profileMode;
        if (typeof parsed.user.autoRenew === 'boolean') state.user.autoRenew = parsed.user.autoRenew;
      }
    }
  } catch (_) {
    // 偏好损坏时静默回退到默认值
  }
  return state;
}

class A9Store {
  constructor() {
    this.state = loadState();
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    this.persistPrefs();
    this.listeners.forEach(fn => fn(this.state));
  }

  persistPrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        settings: this.state.settings,
        user: {
          profileMode: this.state.user.profileMode,
          autoRenew: this.state.user.autoRenew
        }
      }));
    } catch (_) {}
  }

  update(mutator) {
    mutator(this.state);
    this.notify();
  }

  setReferrerId(ref) {
    const clean = String(ref || '').trim();
    if (!clean) return;
    this.state.referral.referrerId = clean;
    try { sessionStorage.setItem(REF_SESSION_KEY, clean); } catch (_) {}
  }

  reset() {
    const lang = this.state.settings.language;
    const ref = this.state.referral.referrerId;
    this.state = structuredClone(DEFAULT_STATE);
    if (config.isDemo) {
      resetDemoPrediction();
      applyDemoInitialState(this.state);
    }
    this.state.settings.language = lang;
    this.state.referral.referrerId = ref;
    this.notify();
  }

  /* ---------------- 资金动作：仅 demo 模式允许模拟；live 模式严格只读禁用 ---------------- */

  get fundsEnabled() {
    return Boolean(config.isDemo);
  }

  stakeTon(amount) {
    if (!config.isDemo) return null;
    const cert = demoFundsStake(this.state, amount);
    if (cert) this.notify();
    return cert;
  }

  claimRewards() {
    if (!config.isDemo) return 0;
    const claimed = demoFundsClaim(this.state);
    if (claimed > 0) this.notify();
    return claimed;
  }

  claimPromoDemo() {
    if (!config.isDemo) return { error: '当前真实模式为只读阶段，推广奖励领取与资金支付暂未开放' };
    const result = demoFundsClaimPromo(this.state);
    this.notify();
    return result;
  }

  buyInternalMarket(tonAmount) {
    if (!config.isDemo) return { error: '当前真实模式为只读阶段，内盘买币与资金支付暂未开放' };
    const result = demoFundsBuy(this.state, tonAmount);
    if (!result.error) this.notify();
    return result;
  }
}

export const store = new A9Store();
