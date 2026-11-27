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
import { isDemoReady, loadDemoModule, peekDemoModule } from './demo-loader.js';

const STORAGE_KEY = 'a9_ui_prefs_v1';
const REF_SESSION_KEY = 'a9_referrer_id_v1';

const DEFAULT_STATE = {
  user: {
    connected: false,
    walletVerified: false,
    walletVerificationState: 'unverified', // 'fresh_proof' | 'restored_binding' | 'unverified'
    tgBound: false,
    address: null,
    shortAddress: null,
    username: null,
    vipLevel: '—',
    weightMultiplier: 1,
    tonBalance: null,
    a9Available: null,
    a9Claimable: null,
    a9Locked: null,
    a9TotalEarned: null,
    profileMode: 'active', // 'active' | 'empty'
    autoRenew: true,
    renewMultiplier: 2.0,
    warmupRegistered: false,
    warmupInvites: 0,
    warmupDistStatus: 'pending_freeze'
  },
  round: {
    currentRound: null,
    openEnded: true,
    totalRounds: null,
    stage: null,
    targetPrice: null,
    twap24h: null,
    livePrice: null,
    priceHistory: [],
    quickStakeTon: null,
    priceChangePct: null,
    tonUsd: null,
    poolA9: null,
    teamPoolA9: null,
    totalStakedTon: null,
    totalTraders: null,
    countdownSec: null,
    earlyBirdSec: null,
    activeCandleSec: 0,
    candles: [],
    myStakeTon: 0,
    myWeight: 0,
    myEarlyTier: 2.0,
    // 服务端驱动字段（由 js/data.js 的 mapRoundView 注入）
    qualifiedCandles: null,
    candlesConfirmed: null,
    minQualifiedCandles: 8,
    needMore: null,
    source: null,
    sourceLabel: null,
    fetchedAt: null,
    stale: false,
    stakingEnabled: false
  },
  certificates: [],
  ledger: [],
  market: {
    rateA9PerTon: null,
    minOrderTon: null,
    maxOrderTon: null,
    hardCapTon: null,
    unlockedQuotaTon: null,
    usedQuotaTon: null,
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
  progression: {
    exp: 0,
    level: 1,
    expPerLevel: 200,
    currentLevelExp: 0,
    nextLevelExp: 200,
    progressPct: 0,
    checkinStreak: 0,
    totalStamps: 0,
    dailyDoneCount: 0,
    dailyTotalCount: 4,
    allDailyStampsDone: false,
    dailyFullBonusClaimed: false,
    todayClaims: [],
    achievementsClaimed: [],
    unlockableAchievements: [],
    loaded: false,
    error: false
  },
  referral: {
    referrerId: null,
    pendingScrollTarget: null
  },
  settings: {
    language: 'zh-CN',
    themeMode: 'light',
    soundEnabled: false,
    hapticsEnabled: true,
    hourlyCandlePush: true,
    settlementPush: true,
    rankDefensePush: true,
    reducedMotion: false,
    hidePlazaHowToPlay: false
  }
};

/** 仅恢复 UI 偏好，绝不恢复任何资金/轮次数据。演示模式样本通过 ensureDemoReady() 异步注入。 */
function loadState() {
  const state = structuredClone(DEFAULT_STATE);
  const demoMod = peekDemoModule();
  if (demoMod) demoMod.applyDemoInitialState(state);
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
    // 兼容迁移旧版散落键到唯一白名单键 a9_ui_prefs_v1 并立即落盘、清理旧键
    let migrated = false;
    const legacyTheme = localStorage.getItem('a9_theme_mode');
    if ((legacyTheme === 'dark' || legacyTheme === 'light') && !parsed?.settings?.themeMode) {
      state.settings.themeMode = legacyTheme;
      migrated = true;
    }
    const legacySound = localStorage.getItem('a9_sound_enabled');
    if ((legacySound === '1' || legacySound === '0') && typeof parsed?.settings?.soundEnabled !== 'boolean') {
      state.settings.soundEnabled = legacySound === '1';
      migrated = true;
    }
    if (legacyTheme !== null) {
      localStorage.removeItem('a9_theme_mode');
      migrated = true;
    }
    if (legacySound !== null) {
      localStorage.removeItem('a9_sound_enabled');
      migrated = true;
    }
    if (migrated) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        settings: state.settings,
        user: { profileMode: state.user.profileMode, autoRenew: state.user.autoRenew }
      }));
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
    this._demoHydrated = Boolean(peekDemoModule());
    this._demoReadyPromise = null;
    this._resetPendingDuringLoad = false;
  }

  get demoReady() {
    return Boolean(config.isDemo && this._demoHydrated && isDemoReady());
  }

  /**
   * Demo 模式异步按需加载并注入演示初始态（并发共享同一 Promise；失败后清理以便重试）。
   * Live 模式永不加载 demo-data.js，直接返回 false。
   */
  async ensureDemoReady(importer = null) {
    if (!config.isDemo) return false;
    if (this._demoHydrated && isDemoReady()) return true;
    if (this._demoReadyPromise) return this._demoReadyPromise;
    this._demoReadyPromise = loadDemoModule(importer)
      .then((mod) => {
        if (!mod) return false;
        if (!this._demoHydrated) {
          const savedSettings = structuredClone(this.state.settings);
          const savedProfileMode = this.state.user.profileMode;
          const savedAutoRenew = this.state.user.autoRenew;
          const savedRef = this.state.referral.referrerId;
          const savedPendingScroll = this.state.referral.pendingScrollTarget;
          if (this._resetPendingDuringLoad) {
            this._resetPendingDuringLoad = false;
            mod.resetDemoPrediction();
          }
          mod.applyDemoInitialState(this.state);
          this.state.settings = { ...this.state.settings, ...savedSettings };
          if (typeof savedProfileMode === 'string') this.state.user.profileMode = savedProfileMode;
          if (typeof savedAutoRenew === 'boolean') this.state.user.autoRenew = savedAutoRenew;
          if (savedRef) this.state.referral.referrerId = savedRef;
          if (savedPendingScroll) this.state.referral.pendingScrollTarget = savedPendingScroll;
          this._demoHydrated = true;
          this.notify();
        }
        return true;
      })
      .catch((err) => {
        this._demoReadyPromise = null;
        throw err;
      });
    return this._demoReadyPromise;
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

  /** 将 loadSnapshot() + mapRoundView() 产出的实时轮次视图合并入 store.state.round。 */
  applyLiveRound(view) {
    if (!view || typeof view !== 'object') return;
    this.update((s) => {
      Object.assign(s.round, view);
    });
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
    this.state.settings.language = lang;
    this.state.referral.referrerId = ref;
    if (config.isDemo) {
      const demoMod = peekDemoModule();
      if (demoMod) {
        demoMod.resetDemoPrediction();
        demoMod.applyDemoInitialState(this.state);
        this.state.settings.language = lang;
        this.state.referral.referrerId = ref;
        this._demoHydrated = true;
      } else {
        this._demoHydrated = false;
        this._resetPendingDuringLoad = true;
        if (!this._demoReadyPromise) {
          this.ensureDemoReady().catch(() => {});
        }
      }
    }
    this.notify();
  }

  /* ---------------- 资金动作：demo 模式允许模拟；live 模式须显式开启 config.liveFundsEnabled ---------------- */

  get fundsEnabled() {
    return Boolean(config.isDemo || config.liveFundsEnabled);
  }

  stakeTon(amount) {
    if (!config.isDemo) return null;
    const demoMod = peekDemoModule();
    if (!demoMod || !this._demoHydrated) return null;
    const cert = demoMod.demoFundsStake(this.state, amount);
    if (cert) this.notify();
    return cert;
  }

  claimRewards() {
    if (!config.isDemo) return 0;
    const demoMod = peekDemoModule();
    if (!demoMod || !this._demoHydrated) return 0;
    const claimed = demoMod.demoFundsClaim(this.state);
    if (claimed > 0) this.notify();
    return claimed;
  }

  claimPromoDemo() {
    const en = this.state.settings?.language === 'en-US';
    if (!config.isDemo) {
      return { error: en ? 'Live mode is read-only; promo claims and payments are disabled' : '当前真实模式为只读阶段，邀友奖励领取与资金支付暂未开放' };
    }
    const demoMod = peekDemoModule();
    if (!demoMod || !this._demoHydrated) {
      return { error: en ? 'Demo data is still loading; retry shortly' : '演示数据正在加载，请稍后重试' };
    }
    const result = demoMod.demoFundsClaimPromo(this.state);
    this.notify();
    return result;
  }

  buyInternalMarket(tonAmount) {
    const en = this.state.settings?.language === 'en-US';
    if (!config.isDemo) {
      return { error: en ? 'Live mode is read-only; Chest Mall purchases are disabled' : '当前真实模式为只读阶段，宝箱商城购买与资金支付暂未开放' };
    }
    const demoMod = peekDemoModule();
    if (!demoMod || !this._demoHydrated) {
      return { error: en ? 'Demo data is still loading; retry shortly' : '演示数据正在加载，请稍后重试' };
    }
    const result = demoMod.demoFundsBuy(this.state, tonAmount);
    if (!result.error) this.notify();
    return result;
  }
}

export const store = new A9Store();
