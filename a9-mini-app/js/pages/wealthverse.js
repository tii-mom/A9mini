import { fetchUserPortfolio, fetchProgressionUser, claimProgressionTask, fetchMyChests, getEffectiveUserId, PROTOCOL_SPECS } from '../data.js';

import { L } from '../i18n.js';
import { config } from '../config.js';
import { store } from '../store.js';
import { icon } from '../icons.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { A9Audio } from '../audio.js';
import { burstParticles, escapeHtml, formatNum, showToast } from '../components.js';

import { canonicalWalletKey } from '../tonconnect.js';
import { renderNintendoGateIcon } from '../paper-art.js';
import {
  BOXHEADS_SERIES,
  CHEST_TIER_ORDER,
  CHEST_TIER_META,
  WEALTH_TIER_USD,
  getBoxheadItem,
  characterArt,
  characterCardArt,
  summarizeChestCounts,
  evaluateActivityUnlock,
  evaluateWealthUnlock,
} from '../wealth-art.js';
import { buildStartAppLink } from '../share.js';

const link = (path, label, glyph) =>
  `<a href="#${path}">${icon(glyph, 16)}${label}</a>`;
const waiting = () => L('待核验', 'Awaiting verification');

let activeGallerySeries = 'activity';
let galleryChestCache = {
  loaded: false,
  counts: summarizeChestCounts(null),
};
let galleryWealthCache = {
  wallet: null,
  loaded: false,
  available: false,
  holdingUsd: 0,
};

function portrait(n, series = 'activity', { lazy = false } = {}) {
  const code = series === 'wealth' ? 'WLT' : 'ACT';
  const attrs = lazy
    ? ' loading="lazy" decoding="async" width="68" height="68"'
    : ' decoding="async" fetchpriority="high" width="120" height="120"';
  return `<img class="wv-person" src="${characterArt(n, series)}" alt="${code} 0${n}"${attrs}>`;
}

export function stageLabel(stage) {
  const stages = {
    warmup: ['开局倒计时', 'Pre-round'],
    participation: ['火热入场', 'Entry open'],
    observation: ['12H 冲价中', '12H Push'],
    settlement_success: ['通关派奖', 'Passed · Payout'],
    settlement_burn: ['未通关 · 自动止损', 'Auto Stop-Loss'],
    halted: ['异常中止 · 退回本金', 'Aborted · Refund'],
  };
  return stages[stage] ? L(...stages[stage]) : waiting();
}

function toFiniteNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function priceOrDash(v) {
  const n = toFiniteNum(v);
  return n === null || n <= 0 ? '—' : `$${n.toFixed(4)}`;
}

function handbookLevelTitle(lv) {
  const n = Math.max(1, Number(lv) || 1);
  const titles = [
    ['新手玩家', 'Quest Rookie'],
    ['集章学徒', 'Stamp Apprentice'],
    ['印章记录员', 'Stamp Keeper'],
    ['沙盘绘制师', 'Sandtable Crafter'],
    ['金箔典藏家', 'Foil Collector'],
  ];
  return L(...titles[Math.min(titles.length - 1, n - 1)]);
}

/**
 * 阶段三：广场每日集章卡（Daily Stamp Card）
 * - 每日 4 枚通关印章（打卡 / 0 GRAM 预言 / 12H 巡视 / 战报分享）+ 满章加赠 + 成长等级与成就徽章
 * - 显式标明：非链上代币资产，不可交易或直接兑换 A9 / GRAM
 */
export function renderHandbookStampCard() {
  const prog = store.state.progression || {};
  const r = store.state.round;
  const pred = store.state.prediction;
  const hasTgAuth = config.isDemo || Boolean(A9TMA.getRawInitData());

  if (!config.isDemo && !hasTgAuth) {
    return `
      <section class="card handbook-stamp-card" id="a9-handbook-card">
        <div class="row-between">
          <div class="card-title">${icon('checkCircle', 15, 'text-green')} ${L('广场每日印章', 'Plaza Daily Stamps')}</div>
          <span class="chip chip-muted">${L('游戏成长数据', 'In-Game EXP')}</span>
        </div>
        <p class="num-xs text-sec" style="margin:8px 0 0;line-height:1.5;">${L('请在 Telegram 小程序内打开以同步你的每日集章进度、连续打卡天数与成长等级（非代币资产，不可兑换 A9/GRAM）。', 'Open inside Telegram Mini App to sync your daily stamps, streak and handbook level (non-financial growth data).')}</p>
      </section>
    `;
  }

  if (!config.isDemo && prog.error) {
    return `
      <section class="card handbook-stamp-card" id="a9-handbook-card">
        <div class="row-between">
          <div class="card-title">${icon('shieldAlert', 15, 'text-red')} ${L('广场每日印章', 'Plaza Daily Stamps')}</div>
          <button class="btn btn-secondary btn-sm" id="btn-prog-retry" type="button">${L('重试读取', 'Retry')}</button>
        </div>
        <p class="num-xs text-muted" style="margin:6px 0 0;">${L('每日集章数据暂不可读取，请点击重试。', 'Handbook progression unavailable. Tap to retry.')}</p>
      </section>
    `;
  }

  const todaySet = new Set(Array.isArray(prog.todayClaims) ? prog.todayClaims : []);
  const achClaimed = new Set(Array.isArray(prog.achievementsClaimed) ? prog.achievementsClaimed : []);
  const unlockableAch = Array.isArray(prog.unlockableAchievements) ? prog.unlockableAchievements : [];
  const hasPredBet = Boolean(pred?.currentBet);

  const dailyTasks = [
    {
      key: 'daily_checkin',
      zh: '广场打卡',
      en: 'Check-in',
      exp: 30,
      done: todaySet.has('daily_checkin'),
      actionZh: '盖打卡章',
      actionEn: 'Stamp',
    },
    {
      key: 'daily_prediction',
      zh: '达标竞猜',
      en: '12H Guess',
      exp: 50,
      done: todaySet.has('daily_prediction'),
      actionZh: hasPredBet ? '盖竞猜章' : '先去竞猜',
      actionEn: hasPredBet ? 'Stamp' : 'Go Guess',
    },
    {
      key: 'daily_observe',
      zh: '12H 巡视',
      en: '12H Inspect',
      exp: 30,
      done: todaySet.has('daily_observe'),
      actionZh: '盖巡视章',
      actionEn: 'Stamp',
    },
    {
      key: 'daily_share',
      zh: '卡片分享',
      en: 'Share Card',
      exp: 40,
      done: todaySet.has('daily_share'),
      actionZh: '盖分享章',
      actionEn: 'Stamp',
    },
  ];

  const achLabels = {
    ach_first_stamp: [L('初枚印章', 'First Stamp'), 50],
    ach_streak_3:    [L('三日连签', '3d Streak'), 120],
    ach_pred_pioneer:[L('竞猜观星', 'Predictor'), 100],
    ach_stamp_10:    [L('十章典藏', '10 Stamps'), 200],
  };

  const fullBonusReady = prog.allDailyStampsDone && !prog.dailyFullBonusClaimed;
  const nextAchKey = unlockableAch[0] || null;

  return `
    <section class="card handbook-stamp-card" id="a9-handbook-card" data-round="${r.currentRound ?? 1}">
      <div class="row-between" style="margin-bottom:6px;">
        <div class="row-start" style="gap:6px;flex-wrap:wrap;">
          <strong class="card-title">${L('广场每日印章', 'Plaza Daily Stamps')}</strong>
          <span class="chip chip-gold">Lv.${prog.level || 1} · ${handbookLevelTitle(prog.level)}</span>
        </div>
        <span class="chip chip-muted mono">${L('连签', 'Streak')} ${prog.checkinStreak || 0}${L('天', 'd')} · ${prog.dailyDoneCount || 0}/4</span>
      </div>

      <div class="row-between num-xs text-muted" style="margin-bottom:4px;">
        <span>${L('集章经验', 'Stamp EXP')} <b class="mono" style="color:var(--ink);">${prog.exp || 0} EXP</b>（${prog.currentLevelExp || 0}/${prog.expPerLevel || 200}）</span>
        <span>${L('游戏内成长 · 非代币资产', 'In-game growth · non-token')}</span>
      </div>
      <div class="progress-track" style="height:6px;margin-bottom:10px;">
        <div class="progress-fill" style="width:${prog.progressPct || 0}%"></div>
      </div>

      <div class="handbook-stamp-grid" role="group" aria-label="${L('每日集章任务', 'Daily stamp missions')}">
        ${dailyTasks.map((t) => `
          <button type="button" class="handbook-stamp-cell ${t.done ? 'stamped' : ''}"
            data-stamp-task="${t.key}"
            aria-pressed="${t.done}">
            <span class="handbook-seal" aria-hidden="true">${t.done ? '✓' : '+'}</span>
            <strong class="handbook-task-name">${L(t.zh, t.en)}</strong>
            <small class="handbook-task-meta">${t.done ? L('已盖章', 'Stamped') : `+${t.exp} EXP`}</small>
          </button>
        `).join('')}
      </div>

      ${fullBonusReady ? `
        <button type="button" class="btn btn-primary btn-sm" data-stamp-task="daily_full_bonus" style="width:100%;margin-top:10px;min-height:38px;">
          ${icon('checkCircle', 14)} ${L('今日 4 章集齐 · 领取满章加赠 (+80 EXP)', 'All 4 Stamps Done · Claim +80 EXP Bonus')}
        </button>
      ` : nextAchKey && achLabels[nextAchKey] ? `
        <button type="button" class="btn btn-secondary btn-sm" data-stamp-task="${nextAchKey}" style="width:100%;margin-top:10px;min-height:38px;border-color:var(--nt-gold-edge);background:var(--nt-gold-soft);">
          ${icon('trophy', 14, 'text-gold')} ${L(`解锁成就印章「${achLabels[nextAchKey][0]}」(+${achLabels[nextAchKey][1]} EXP)`, `Claim Achievement "${achLabels[nextAchKey][0]}" (+${achLabels[nextAchKey][1]} EXP)`)}
        </button>
      ` : ''}

      <div class="handbook-ach-row" aria-label="${L('成就印章图鉴', 'Achievement stamps')}">
        ${Object.entries(achLabels).map(([key, [label]]) => {
          const owned = achClaimed.has(key);
          return `<span class="handbook-ach-pill ${owned ? 'owned' : ''}">${owned ? '✓ ' : ''}${label}</span>`;
        }).join('')}
      </div>
    </section>
  `;
}

/**
 * 我的顶部极简头像栏：仅展示头像、钱包地址、GRAM 余额与图鉴入口
 */
export function identityStage({ modePill = '', walletAddr, gramText }) {
  return `<section class="card row-between"><div><div class="card-title">${L('我的钱包', 'My Wallet')}</div>
    <span class="mono">${escapeHtml(walletAddr)}</span><div class="mono">${escapeHtml(gramText)}</div></div>${modePill}</section>`;
}

function repaintHandbookCard(root, navigate) {
  const cardEl = root.querySelector('#a9-handbook-card');
  if (!cardEl) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = renderHandbookStampCard().trim();
  const nextEl = wrap.firstElementChild;
  if (nextEl) {
    cardEl.replaceWith(nextEl);
    bindHandbookStampEvents(root, navigate);
  }
}

export async function syncProgressionState(root, navigate) {
  const { round, user } = store.state;
  const uid = getEffectiveUserId(user);
  const roundId = round.currentRound || 1;
  try {
    const data = await fetchProgressionUser(uid, roundId);
    if (!data) return;
    store.update((s) => {
      Object.assign(s.progression, data, { loaded: true, error: false });
    });
    if (root && root.isConnected) repaintHandbookCard(root, navigate);
  } catch {
    store.update((s) => {
      s.progression.error = true;
    });
    if (root && root.isConnected) repaintHandbookCard(root, navigate);
  }
}

function bindHandbookStampEvents(root, navigate) {
  const card = root.querySelector('#a9-handbook-card');
  if (!card) return;
  const retryBtn = card.querySelector('#btn-prog-retry');
  if (retryBtn) {
    retryBtn.onclick = () => {
      A9Haptic.light();
      syncProgressionState(root, navigate);
    };
  }

  card.querySelectorAll('[data-stamp-task]').forEach((btn) => {
    btn.onclick = async () => {
      const taskKey = btn.dataset.stampTask;
      if (!taskKey) return;
      const todaySet = new Set(store.state.progression?.todayClaims || []);
      const achSet = new Set(store.state.progression?.achievementsClaimed || []);
      if (todaySet.has(taskKey) || achSet.has(taskKey)) {
        A9Haptic.light();
        showToast(L('该印章已盖章领取', 'Stamp already claimed'));
        return;
      }

      if (taskKey === 'daily_prediction' && !store.state.prediction?.currentBet) {
        A9Haptic.light();
        A9Audio.tick();
        store.state.referral.pendingScrollTarget = 'prediction';
        showToast(L('请先完成本轮 0 GRAM 12H 预言擂台后盖章', 'Complete your 0 GRAM 12H prediction first'));
        if (navigate) navigate('/round');
        else window.location.hash = '#/round';
        return;
      }

      const uid = getEffectiveUserId(store.state.user);
      const roundId = store.state.round.currentRound || 1;
      btn.disabled = true;
      try {
        const res = await claimProgressionTask({ userId: uid, taskKey, roundId });
        A9Haptic.success();
        A9Audio.stamp();
        burstParticles(btn);
        if (res?.progression) {
          store.update((s) => {
            Object.assign(s.progression, res.progression, { loaded: true, error: false });
          });
        }
        showToast(L(`已盖章 · +${res?.expAwarded || 0} EXP（集章成长数据）`, `Stamped · +${res?.expAwarded || 0} EXP`));
        if (root.isConnected) {
          repaintHandbookCard(root, navigate);
          const stampedBtn = root.querySelector(`[data-stamp-task="${taskKey}"]`);
          if (stampedBtn) {
            stampedBtn.classList.add('anim-slot-confirmed');
            setTimeout(() => stampedBtn.classList.remove('anim-slot-confirmed'), 260);
          }
        }
      } catch (e) {
        A9Haptic.error();
        showToast(e?.message || L('盖章失败，请重试', 'Stamp failed, please retry'), 'amber');
        btn.disabled = false;
      }
    };
  });
}

/** 弹出 v17.0 合约防 Rug 链上验真卡（展示实时奖池余量、admin_address = addr_none、7天 AbortRound 逃生舱、code_hash 与 Tonviewer 查验） */
function demoProgressionInitSnapshot(uid, roundId) {
  return {
    exp: 160,
    level: 1,
    expPerLevel: 200,
    currentLevelExp: 160,
    nextLevelExp: 200,
    progressPct: 80,
    checkinStreak: 2,
    totalStamps: 5,
    dailyDoneCount: 1,
    dailyTotalCount: 4,
    allDailyStampsDone: false,
    dailyFullBonusClaimed: false,
    todayClaims: ['daily_observe'],
    achievementsClaimed: ['ach_first_stamp'],
    unlockableAchievements: []
  };
}

/** 计算演示模式当前 A9 持仓估值（仅演示态使用，绝不伪造链上数据） */
function getDemoA9HoldingUsd() {
  const u = store.state.user || {};
  const r = store.state.round || {};
  const totalA9 = (Number(u.a9Available) || 0) + (Number(u.a9Claimable) || 0) + (Number(u.a9Locked) || 0);
  const price = Number(r.livePrice) || Number(r.twap24h) || 0.0025;
  return Math.round(totalA9 * price);
}

/** 从 /api/user/:wallet 返回的真实链上持仓与当前均价计算美元市值 */
function computeLiveA9HoldingUsd(portfolio, round) {
  let totalRaw = 0n;
  let hasOnchainData = false;
  if (
    portfolio?.balanceAvailable !== false &&
    typeof portfolio?.a9BalanceRaw === 'string' &&
    /^\d+$/.test(portfolio.a9BalanceRaw)
  ) {
    totalRaw += BigInt(portfolio.a9BalanceRaw);
    hasOnchainData = true;
  }
  if (Array.isArray(portfolio?.tickets)) {
    for (const t of portfolio.tickets) {
      if (!t?.principalDone && typeof t?.amountRaw === 'string' && /^\d+$/.test(t.amountRaw)) {
        totalRaw += BigInt(t.amountRaw);
        hasOnchainData = true;
      }
    }
  }
  const price = Number(round?.livePrice) || Number(round?.twap24h) || 0;
  if (!hasOnchainData || price <= 0) {
    return { available: false, holdingUsd: 0 };
  }
  const totalA9 = Number(totalRaw) / 1e9;
  return { available: true, holdingUsd: Math.round(totalA9 * price * 100) / 100 };
}

/** 获取当前生效的 A9 持仓美元估值（演示模式取模拟持仓，真实模式取链上只读接口） */
function getEffectiveA9HoldingUsd() {
  if (config.isDemo) return { available: true, holdingUsd: getDemoA9HoldingUsd() };
  const addr = store.state.user?.address || null;
  if (!addr || galleryWealthCache.wallet !== addr || !galleryWealthCache.available) {
    return { available: false, holdingUsd: 0 };
  }
  return { available: true, holdingUsd: galleryWealthCache.holdingUsd };
}

/** 计算图鉴各阶位解锁集合（宝箱持有系列按 5 种宝箱累计数量，市值系列按 A9 持仓市值） */
function computeUnlockedTiers(series = 'activity', chestCounts = galleryChestCache.counts) {
  const unlocked = new Set();
  if (series === 'wealth') {
    const w = getEffectiveA9HoldingUsd();
    if (!w.available) return unlocked;
    BOXHEADS_SERIES.wealth.items.forEach((it) => {
      if (evaluateWealthUnlock(it, w.holdingUsd).unlocked) unlocked.add(it.tier);
    });
    return unlocked;
  }
  BOXHEADS_SERIES.activity.items.forEach((it) => {
    if (evaluateActivityUnlock(it, chestCounts).unlocked) unlocked.add(it.tier);
  });
  return unlocked;
}

/** 解析图鉴路由参数（兼容 1-9、act-01..09、wlt-01..09） */
function parseGalleryParam(param) {
  const raw = String(param || '').trim().toLowerCase();
  if (raw.startsWith('wlt-')) {
    const n = Number(raw.slice(4));
    return { series: 'wealth', tier: n >= 1 && n <= 9 ? n : 1 };
  }
  if (raw.startsWith('act-')) {
    const n = Number(raw.slice(4));
    return { series: 'activity', tier: n >= 1 && n <= 9 ? n : 1 };
  }
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 9) {
    return { series: activeGallerySeries, tier: n };
  }
  return {
    series: activeGallerySeries || (store.state.user.previewSeries || 'activity'),
    tier: store.state.user.previewTier || 1,
  };
}

/** 进化图鉴（#/gallery）：双轨形象展示台 + 宝箱进度追踪 + 稳定 3D 翻卡 + 3×3 收集册 */
export function gallery(root, navigate, param) {
  const parsed = parseGalleryParam(param);
  activeGallerySeries = parsed.series === 'wealth' ? 'wealth' : 'activity';
  const selected = parsed.tier;

  const renderGalleryView = () => {
    if (!root || !root.isConnected) return;
    const seriesMeta = BOXHEADS_SERIES[activeGallerySeries];
    const item = getBoxheadItem(selected, activeGallerySeries);
    const chestCounts = galleryChestCache.counts;
    const wealthInfo = getEffectiveA9HoldingUsd();
    const actUnlocked = computeUnlockedTiers('activity', chestCounts);
    const wltUnlocked = computeUnlockedTiers('wealth', chestCounts);
    const curUnlockedSet = activeGallerySeries === 'wealth' ? wltUnlocked : actUnlocked;
    const canEvaluate = activeGallerySeries === 'activity'
      ? (config.isDemo || galleryChestCache.loaded)
      : wealthInfo.available;
    const isSelectedUnlocked = canEvaluate ? curUnlockedSet.has(selected) : false;
    const code = seriesMeta.code;

    const actEval = activeGallerySeries === 'activity' ? evaluateActivityUnlock(item, chestCounts) : null;
    const wltEval = activeGallerySeries === 'wealth' ? evaluateWealthUnlock(item, wealthInfo.holdingUsd) : null;

    const unlockHint = L(item.hintZh, item.hintEn);
    let progressText = '';
    let progressPct = 0;
    if (activeGallerySeries === 'activity' && actEval) {
      const tierMeta = CHEST_TIER_META[actEval.chestTier] || CHEST_TIER_META.bronze;
      progressPct = canEvaluate ? actEval.progressPct : 0;
      if (!canEvaluate) {
        progressText = L('同步宝箱数据中…', 'Syncing chests…');
      } else if (actEval.requireAllTypes) {
        progressText = L(
          `已集 ${actEval.distinctTypes}/5 种 · 钻石 ${actEval.current}/${actEval.target}`,
          `${actEval.distinctTypes}/5 types · Dia ${actEval.current}/${actEval.target}`,
        );
      } else {
        progressText = `${L(tierMeta.shortZh, tierMeta.shortEn)} ${Math.min(actEval.current, actEval.target)}/${actEval.target}`;
      }
    } else if (wltEval) {
      progressPct = canEvaluate ? wltEval.progressPct : 0;
      if (canEvaluate) {
        progressText = `$${formatNum(wltEval.current)} / $${formatNum(wltEval.target)}`;
      } else if (!store.state.user?.address) {
        progressText = L('连接钱包核验持仓', 'Connect wallet to verify');
      } else {
        progressText = L('同步链上持仓中…', 'Syncing on-chain balance…');
      }
    }

    const statusBadgeText = !canEvaluate
      ? L('待核验', 'TBD')
      : isSelectedUnlocked
        ? L('已解锁', 'Owned')
        : L('未解锁', 'Locked');
    const isEquipped = (store.state.user.previewSeries || 'activity') === activeGallerySeries
      && Number(store.state.user.previewTier || 1) === selected;
    const canEquip = config.isDemo || isSelectedUnlocked;
    const targetChestTier = activeGallerySeries === 'activity' ? item.unlockRule?.chestTier : null;

    root.innerHTML =
      `<div class="seg-tabs gallery-series-tabs" id="boxhead-series-tabs">
        <button class="seg-tab ${activeGallerySeries === 'activity' ? 'active' : ''}" data-boxhead-series="activity" type="button">
          <span>${L('宝箱持有', 'Chests')}</span>
          <em class="seg-tab-count mono">${(config.isDemo || galleryChestCache.loaded) ? `${actUnlocked.size}/9` : '9'}</em>
        </button>
        <button class="seg-tab ${activeGallerySeries === 'wealth' ? 'active' : ''}" data-boxhead-series="wealth" type="button">
          <span>${L('A9 市值', 'Wealth')}</span>
          <em class="seg-tab-count mono">${wealthInfo.available ? `${wltUnlocked.size}/9` : '9'}</em>
        </button>
      </div>` +
      `<section class="wv-hero wv-gallery-hero series-${activeGallerySeries}">
        <div class="boxhead-stage-meta">
          <span class="chip ${activeGallerySeries === 'wealth' ? 'chip-gold' : 'chip-cyan'} mono">${code} 0${selected} · ${item.rarity}</span>
          <button type="button" class="boxhead-flip-btn" id="btn-flip-boxhead" aria-pressed="false">
            ${icon('refresh', 13)} <span id="btn-flip-label">${L('翻看卡背', 'Flip Back')}</span>
          </button>
        </div>

        <div class="boxhead-flip-scene" id="gallery-standee-stage" role="button" tabindex="0" aria-label="${L('轻点翻转查看卡背', 'Tap to flip card')}">
          <div class="boxhead-flip-card" id="boxhead-flip-card">
            <div class="boxhead-face front series-${activeGallerySeries}">
              <div class="boxhead-stage-aura" aria-hidden="true"></div>
              ${activeGallerySeries === 'wealth' ? '<div class="standee-slot" aria-hidden="true"></div>' : ''}
              <img class="wv-person${canEvaluate && !isSelectedUnlocked ? ' is-locked-preview' : ''}" id="boxhead-avatar-img" src="${item.avatar}" alt="${code} 0${selected}" width="160" height="160" loading="lazy" decoding="async">
            </div>
            <div class="boxhead-face back">
              <img class="boxhead-card-img" id="boxhead-backing-card" src="${item.card}" alt="${code} 0${selected} ${L('精装卡背', 'Backing Card')}" width="240" height="320" loading="lazy" decoding="async">
            </div>
          </div>
        </div>

        <div class="wv-copy">
          <div class="row-start" style="justify-content:center;gap:6px;flex-wrap:wrap;">
            <h1>${L(item.nameZh, item.nameEn)}</h1>
            <span class="chip ${isSelectedUnlocked ? 'chip-green' : 'chip-muted'}" style="min-height:20px;font-size:10px;">${statusBadgeText}</span>
          </div>
          <p class="gallery-trait-line">${L(item.traitZh, item.traitEn)}</p>
          <p class="gallery-voice-pill">“${L(item.voiceZh, item.voiceEn)}”</p>
        </div>

        <div class="gallery-unlock-panel ${isSelectedUnlocked ? 'is-done' : ''}">
          <div class="row-between" style="gap:8px;">
            <span class="gallery-unlock-label">${unlockHint}</span>
            <strong class="gallery-unlock-stat mono">${progressText}</strong>
          </div>
          <div class="progress-track gallery-progress-track">
            <div class="progress-fill ${activeGallerySeries === 'wealth' ? 'is-gold' : ''}" style="width:${progressPct}%;"></div>
          </div>
          ${activeGallerySeries === 'activity' && !isSelectedUnlocked ? `
            <div class="row-between gallery-unlock-foot">
              <span>${L('免费助力开箱与宝箱商城购箱均计入数量', 'Both free assist & Chest Mall chests count')}</span>
              <a class="gallery-unlock-cta" href="#/internal/market">${L('去获取宝箱', 'Get Chests')} ›</a>
            </div>
          ` : ''}
        </div>

        <div class="gallery-action-bar">
          <button class="btn btn-primary btn-sm" id="wv-export" type="button">${icon('download', 14)} ${L('保存', 'Save')}</button>
          ${canEquip ? `<button class="btn btn-secondary btn-sm" id="wv-set-avatar" type="button" ${isEquipped ? 'disabled' : ''}>${icon('checkCircle', 14)} ${isEquipped ? L('使用中', 'Equipped') : L('设为头像', 'Equip')}</button>` : ''}
          <button class="btn btn-secondary btn-sm" id="wv-share-tg" type="button" aria-label="Telegram">${icon('send', 14)} TG</button>
          <button class="btn btn-secondary btn-sm" id="wv-share-x" type="button" aria-label="X">${icon('xBrand', 13)} X</button>
        </div>
      </section>` +
      (activeGallerySeries === 'activity' ? `
        <div class="chest-tally-strip" aria-label="${L('我的 5 种宝箱统计', 'My 5 Chest Types')}">
          ${CHEST_TIER_ORDER.map((tierKey) => {
            const meta = CHEST_TIER_META[tierKey];
            const cnt = chestCounts[tierKey] || 0;
            const isTarget = targetChestTier === tierKey || Boolean(item.unlockRule?.requireAllTypes);
            return `<div class="chest-tally-pill tone-${meta.tone}${isTarget ? ' is-target' : ''}${cnt > 0 ? ' has-any' : ''}">
              <span class="chest-tally-dot" aria-hidden="true"></span>
              <span class="chest-tally-name">${L(meta.shortZh, meta.shortEn)}</span>
              <b class="mono">${cnt}</b>
            </div>`;
          }).join('')}
        </div>
      ` : '') +
      `<div class="row-between" style="padding:2px 2px 0;">
        <span class="section-kicker" style="padding:0;">${L(seriesMeta.labelZh, seriesMeta.labelEn)} · ${code} 01–09</span>
        <span class="chip ${canEvaluate ? 'chip-gold' : 'chip-muted'} mono" style="min-height:20px;font-size:10px;">${canEvaluate ? `${curUnlockedSet.size} / 9` : L('待核验', 'Pending')}</span>
      </div>` +
      `<nav class="wv-gallery series-${activeGallerySeries}">${seriesMeta.items.map((it) => {
        const idx = it.tier;
        const locked = canEvaluate ? !curUnlockedSet.has(idx) : true;
        return `<a href="#/gallery/${it.id}" data-gallery-pick="${it.id}" class="${locked ? 'is-locked' : ''}" aria-current="${idx === selected ? 'true' : 'false'}">
          <span class="gallery-slot-num mono">0${idx}</span>
          <span class="gallery-slot-badge" aria-hidden="true">${locked ? '·' : '✓'}</span>
          ${portrait(idx, activeGallerySeries, { lazy: true })}
          <b>${L(it.nameZh, it.nameEn)}</b>
          <small class="gallery-slot-req mono">${L(it.shortReqZh, it.shortReqEn)}</small>
        </a>`;
      }).join('')}</nav>`;

    // 预加载当前卡片精装卡背，确保 3D 翻转零延迟闪烁
    const preloadBack = new Image();
    preloadBack.decoding = 'async';
    preloadBack.src = item.card;

    // 3×3 卡册点选使用 replace 切换，不污染浏览器返回历史
    root.querySelectorAll('[data-gallery-pick]').forEach((el) => {
      el.onclick = (e) => {
        e.preventDefault();
        const id = el.dataset.galleryPick;
        if (!id) return;
        A9Haptic.light();
        A9Audio.tick();
        navigate(`/gallery/${id}`, { replace: true });
      };
    });

    // 双系列切换（同样使用 replace，保证一键直接返回上级页面）
    root.querySelectorAll('[data-boxhead-series]').forEach((btn) => {
      btn.onclick = () => {
        const nextSeries = btn.dataset.boxheadSeries;
        if (nextSeries === activeGallerySeries) return;
        A9Haptic.light();
        A9Audio.tick();
        activeGallerySeries = nextSeries;
        const nextPrefix = nextSeries === 'wealth' ? 'wlt' : 'act';
        navigate(`/gallery/${nextPrefix}-0${selected}`, { replace: true });
      };
    });

    // 3D 翻卡（点击卡片或按钮均可翻转，严格兼容 Safari/WebKit）
    const flipStage = root.querySelector('#gallery-standee-stage');
    const flipCard = root.querySelector('#boxhead-flip-card');
    const flipBtn = root.querySelector('#btn-flip-boxhead');
    const flipLabel = root.querySelector('#btn-flip-label');
    let isFlipped = false;
    const setFlipped = (next) => {
      isFlipped = Boolean(next);
      A9Haptic.light();
      A9Audio.flip();
      if (flipCard) flipCard.classList.toggle('is-flipped', isFlipped);
      if (flipBtn) flipBtn.setAttribute('aria-pressed', String(isFlipped));
      if (flipLabel) flipLabel.textContent = isFlipped ? L('翻回正面', 'Front') : L('翻看卡背', 'Flip Back');
    };
    if (flipBtn) flipBtn.onclick = () => setFlipped(!isFlipped);
    if (flipStage) {
      flipStage.onclick = () => setFlipped(!isFlipped);
      flipStage.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFlipped(!isFlipped); } };
    }

    const equipBtn = root.querySelector('#wv-set-avatar');
    if (equipBtn) {
      equipBtn.onclick = () => {
        A9Haptic.success();
        A9Audio.flip();
        store.update((state) => {
          state.user.previewTier = selected;
          state.user.previewSeries = activeGallerySeries;
        });
        showToast(L(`已将「${item.nameZh}」设为头像`, `Equipped "${item.nameEn}"`));
        navigate('/profile');
      };
    }

    // 社交分享（TG & X）
    const shareLink = buildStartAppLink('gallery', item.id);
    const shareCopy = L(
      `我在 A9 收藏了【${code} 0${selected} · ${item.nameZh}】(${item.rarity})：`,
      `Collected [${code} 0${selected} · ${item.nameEn}] (${item.rarity}) on A9:`
    );
    const tgBtn = root.querySelector('#wv-share-tg');
    if (tgBtn) {
      tgBtn.onclick = () => {
        A9Haptic.light();
        A9TMA.shareInvite(shareLink, shareCopy);
        showToast(L('已调起 Telegram 分享', 'Opened Telegram share'));
      };
    }
    const xBtn = root.querySelector('#wv-share-x');
    if (xBtn) {
      xBtn.onclick = () => {
        A9Haptic.light();
        const intentUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(shareCopy)}&url=${encodeURIComponent(shareLink)}`;
        A9TMA.openExternalLink(intentUrl);
        showToast(L('已打开 X 分享', 'Opened X share'));
      };
    }

    // 保存收藏卡 PNG
    root.querySelector('#wv-export').onclick = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 960;
      const ctx = canvas.getContext('2d');
      const cardImg = new Image();
      cardImg.src = item.card;
      await cardImg.decode().catch(() => {});

      const isDarkCard = activeGallerySeries === 'wealth';
      ctx.fillStyle = isDarkCard ? '#15161A' : '#F4F5F8';
      ctx.fillRect(0, 0, 720, 960);

      ctx.fillStyle = isDarkCard ? '#262832' : '#C8CDD9';
      ctx.beginPath();
      ctx.roundRect(36, 44, 648, 876, 34);
      ctx.fill();
      ctx.fillStyle = isDarkCard ? '#1E2027' : '#FFFFFF';
      ctx.beginPath();
      ctx.roundRect(36, 36, 648, 876, 34);
      ctx.fill();

      ctx.fillStyle = '#A3000D';
      ctx.beginPath();
      ctx.roundRect(72, 74, 88, 48, 14);
      ctx.fill();
      ctx.fillStyle = '#E60012';
      ctx.beginPath();
      ctx.roundRect(72, 68, 88, 48, 14);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText('A9', 96, 102);

      ctx.fillStyle = isDarkCard ? '#D6D8E1' : '#505565';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText(`BOXHEADS S01 · ${code} 0${selected} · ${item.rarity}`, 178, 100);

      if (cardImg.complete && cardImg.naturalWidth) {
        const maxW = 540;
        const maxH = 610;
        const scale = Math.min(maxW / cardImg.naturalWidth, maxH / cardImg.naturalHeight);
        const dw = cardImg.naturalWidth * scale;
        const dh = cardImg.naturalHeight * scale;
        const dx = (720 - dw) / 2;
        const dy = 148 + (maxH - dh) / 2;
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.24)';
        ctx.shadowBlur = 22;
        ctx.shadowOffsetY = 10;
        ctx.drawImage(cardImg, dx, dy, dw, dh);
        ctx.restore();
      }

      ctx.fillStyle = isDarkCard ? '#F5F6FA' : '#171920';
      ctx.font = 'bold 42px sans-serif';
      ctx.fillText(L(item.nameZh, item.nameEn), 72, 822);
      ctx.fillStyle = isDarkCard ? '#9BA0B2' : '#505565';
      ctx.font = '22px sans-serif';
      ctx.fillText(`${code} 0${selected} · ${unlockHint}`, 72, 868);

      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `A9-boxhead-${item.id}-card.png`;
      a.click();
      A9Haptic.success();
      showToast(L('收藏卡 PNG 已保存', 'Card PNG saved'));
    };
  };

  renderGalleryView();

  // 异步同步用户 5 种宝箱累计数量，同步完成后无缝刷新图鉴解锁态与进度条
  fetchMyChests()
    .then((res) => {
      const nextCounts = summarizeChestCounts(res);
      const prevKey = JSON.stringify(galleryChestCache.counts);
      const nextKey = JSON.stringify(nextCounts);
      const shouldRepaint = !galleryChestCache.loaded || prevKey !== nextKey;
      galleryChestCache = { loaded: true, counts: nextCounts };
      if (shouldRepaint && root && root.isConnected) {
        renderGalleryView();
      }
    })
    .catch(() => {});

  // 真实模式下同步已连接钱包的链上 A9 持仓估值（可用 A9 + 质押凭证本金），用于 A1–A9 市值解锁
  if (!config.isDemo) {
    const addr = store.state.user?.address || null;
    if (addr) {
      fetchUserPortfolio(addr)
        .then((portfolio) => {
          if (store.state.user?.address !== addr) return;
          const next = computeLiveA9HoldingUsd(portfolio, store.state.round);
          const changed =
            galleryWealthCache.wallet !== addr ||
            galleryWealthCache.available !== next.available ||
            galleryWealthCache.holdingUsd !== next.holdingUsd;
          galleryWealthCache = {
            wallet: addr,
            loaded: true,
            available: next.available,
            holdingUsd: next.holdingUsd,
          };
          if (changed && root && root.isConnected) {
            renderGalleryView();
          }
        })
        .catch(() => {});
    }
  }
}

/**
 * 奖金金库（#/rewards）：
 * v17.0 极简 14 天逐秒解锁机制（通关退 100% 本金 + 秒提 20% 奖金，余下 80% 分 14 天每日 +5.71% 逐秒解锁，支持随时 3 折急提，永久累计不倒扣）
 */
export function rewards(root) {
  const n = store.state.round.successCount;
  const u = store.state.user;
  const lockedNum = config.isDemo && Number.isFinite(Number(u.a9Locked)) ? Number(u.a9Locked) : null;
  const dailyRateNum = lockedNum !== null ? Math.round(lockedNum * (PROTOCOL_SPECS.dailyUnlockPct / 80)) : null;

  const amounts = [
    [L('已解锁待领取', 'Unlocked & Claimable'), config.isDemo ? u.a9Claimable : null],
    [L('14 天逐秒待解锁', '14D Per-Second Unlock'), lockedNum],
    [L('每日解锁速率（5.71%/天）', 'Daily Unlock Rate (5.71%/day)'), dailyRateNum],
  ];
  const balances = amounts
    .map(
      ([label, amount]) =>
        `<div class="list-row"><span>${label}</span><b class="mono">${amount == null ? waiting() : amount.toLocaleString('en-US') + ' A9'}</b></div>`,
    )
    .join('');

  root.innerHTML = `
    <div class="col-gap anim-page-enter">
      <section class="card card-hero wv-vault-summary">
        <div class="row-between">
          <div>
            <span class="diorama-kicker">A9 / TREASURY · v17.0</span>
            <h2 style="margin:3px 0 0;font-size:19px;font-weight:900;">${L('14 天逐秒解锁 + 3 折急提', '14D Unlock + Instant Cashout')}</h2>
            <p class="num-xs text-sec" style="margin:4px 0 0;">${L('通关秒提', 'Instant')} <b class="mono text-gold">${PROTOCOL_SPECS.immediateUnlockPct}%</b> · ${L('余下 80% 每日解锁', 'Remaining 80% unlocks')} <b class="mono" style="color:var(--ink);">${PROTOCOL_SPECS.dailyUnlockPct}%/${L('天', 'day')}</b> · ${L('全网通关', 'Wins')} <b class="mono" style="color:var(--ink);">${n ?? waiting()}</b></p>
          </div>
          <span class="nt-art-badge tone-blue" aria-hidden="true">${renderNintendoGateIcon('vault', 36)}</span>
        </div>
        <div class="wv-steps" style="margin-top:12px;">
          ${[
            [L('第 0 天 · 通关', 'Day 0 · Pass'), '20%', L('即时秒提', 'Instant'), L('+ 100% 本金', '+ 100% Principal')],
            [L('第 1–14 天', 'Days 1–14'), '+5.71%', L('逐秒解锁', 'Per Day'), L('永久累计不倒扣', 'Never Forfeited')],
            [L('急提通道', 'Fast Cashout'), '30%', L('未解锁 3 折秒提', '30% Now'), L('7 折永久销毁', '70% Burned')],
          ].map(([stage, pct, sub, foot], i) => `
            <article class="${i === 0 ? 'current' : ''}">
              <small>${stage}</small>
              <strong>${pct}</strong>
              ${sub}
              <p>${foot}</p>
            </article>
          `).join('')}
        </div>
      </section>

      <section class="card">
        <div class="card-header" style="margin-bottom:4px;">
          <h3 class="card-title">${icon('wallet', 15, 'text-gold')} ${L('我的金库余额', 'My Vault Balances')}</h3>
          <span class="chip ${config.isDemo ? 'chip-muted' : 'chip-gold'}">${config.isDemo ? L('演示数据', 'DEMO') : L('待核验', 'PENDING')}</span>
        </div>
        <div>${balances}</div>
        <p class="num-xs text-muted" style="margin:10px 0 0;line-height:1.5;">${L('通关奖励 20% 秒提 + 14 天逐秒解锁（支持 3 折急提，7 折销毁），永不倒扣；未通关永不爆仓 · 自动止损（头矿 6H 退 95% / 普通退 90%） · 奖池分完为止', 'Winning rewards unlock via 20% Instant + 14D Per-Second Unlock (Instant Cashout 30% Now / 70% Burn); failed rounds use No Liquidation · Auto Stop-Loss (95% First 6H / 90% Standard) · until pool exhaustion')}</p>
      </section>

      <nav class="wv-links">${link('/claim', L('金库领奖', 'Claim Prizes'), 'unlock')}${link('/profile', L('我的档案', 'My Profile'), 'wallet')}</nav>
    </div>
  `;
}

export function tower(round) {
  const totalSlots = Number(round.candleCount) || 12;
  const required = Number(round.minQualifiedCandles) || 8;
  const labels = {
    unknown: L('待核验', 'Pending'),
    pending: L('未开始', 'Upcoming'),
    active: L('冲价中', 'Pushing'),
    pass: L('达标', 'Met'),
    miss: L('未达标', 'Missed'),
  };
  const symbols = { unknown: '?', pending: '·', active: '◉', pass: '✓', miss: '×' };
  const confirmedCount = Array.isArray(round.candles)
    ? round.candles.filter((c) => c.confirmed || c.status === 'closed').length
    : (round.candlesSeen ?? 0);
  return `<section class="wv-tower">
    <div class="row-between" style="margin-bottom:6px;">
      <div>
        <small>12H / PUSH BOARD</small>
        <h2 style="margin:2px 0 0;">${L('12H 冲价集章板', '12H Push Board')}</h2>
      </div>
      <span class="chip chip-muted mono">${L('已确认', 'Confirmed')} ${confirmedCount}/${totalSlots}</span>
    </div>
    <div class="wv-windows">${Array.from(
      { length: totalSlots },
      (_, i) => {
        const c = round.candles?.[i];
        const state = c?.confirmed
          ? (c.bull ? 'pass' : 'miss')
          : labels[c?.status]
            ? c.status
            : 'unknown';
        return `<span data-state="${state}"><i>${symbols[state]}</i><b>${String(i + 1).padStart(2, '0')}</b></span>`;
      },
    ).join('')}</div>
    <p>${L('已达标', 'Qualified')} <b class="mono">${round.qualifiedCandles ?? '—'} / ${required}</b> · ${round.qualifiedCandles >= required && round.stage === 'observation' ? L('等待结算', 'Awaiting settlement') : L(`达标门槛 ${required} 段`, `${required} slots to pass`)}</p>
  </section>`;
}

function exactA9(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const digits = raw.padStart(10, '0');
  const fraction = digits.slice(-9).replace(/0+$/, '');
  return (
    BigInt(digits.slice(0, -9)).toLocaleString('en-US') +
    (fraction ? '.' + fraction : '') +
    ' A9'
  );
}

export function portfolioPanel(root, guild = false, onPortfolio) {
  const { user } = store.state;
  const panel = document.createElement('section');
  panel.className = guild ? 'card col-gap' : 'card card-hero col-gap';
  if (guild) root.prepend(panel);
  else root.append(panel);
  const links = guild
    ? [
        ['/team/profile', '战队名片', 'Squad Card'],
        ['/team/bind-tg', '绑定 TG 群', 'Link TG Group'],
        ['/team/invite', '邀友赢奖', 'Invite & Earn'],
        ['/leaderboard', '财富榜', 'Rich List'],
      ]
    : [
        ['/claim', '金库领奖', 'Claim Prizes'],
        ['/ledger', '收益账本', 'Reward Ledger'],
        ['/proof', '闯关凭证', 'Quest Pass'],
        ['/renew', '开盘提醒', 'Open Alert'],
        ['/settings', '偏好设置', 'Settings'],
      ];
  function show(data, state, isError = false) {
    onPortfolio?.(data);
    panel.replaceChildren();
    const row = (label, value) => {
      const el = document.createElement('div');
      el.className = 'list-row';
      const name = document.createElement('span');
      name.textContent = label;
      const amount = document.createElement('b');
      amount.className = 'mono';
      amount.textContent = value;
      el.append(name, amount);
      panel.append(el);
    };
    if (guild) {
      row(L('战队', 'Squad'), data?.team?.name || waiting());
      row(L('成员', 'Members'), data?.team?.memberCount ?? waiting());
      row(
        L('职位', 'Role'),
        data?.team?.role === 'captain' || (Boolean(user.address) && Boolean(data?.team?.captainWallet) && canonicalWalletKey(data.team.captainWallet) === canonicalWalletKey(user.address))
          ? L('队长', 'Captain')
          : data?.team
            ? L('成员', 'Member')
            : waiting(),
      );
    } else {
      const balance =
        data?.balanceAvailable !== false &&
        data?.jettonWallet &&
        typeof data.a9BalanceRaw === 'string' &&
        /^\d+$/.test(data.a9BalanceRaw)
          ? exactA9(data.a9BalanceRaw)
          : null;
      row(L('可用 A9', 'Available A9'), balance ?? waiting());
      const active = (data?.tickets || []).filter(
        (t) => !t.principalDone && /^\d+$/.test(t.amountRaw),
      );
      for (const ticket of active)
        row(
          L('凭证本金 · 第', 'Ticket principal · R') + ticket.roundId + L(' 轮', ''),
          exactA9(ticket.amountRaw),
        );
      if (!active.length) row(L('锁仓中 A9', 'Locked A9'), waiting());
      for (const labels of [
        ['已解锁待领取', 'Unlocked, unclaimed'],
        ['14 天逐秒待解锁', '14D Per-Second Unlock'],
      ])
        row(L(...labels), waiting());
    }
    const status = document.createElement('p');
    status.className = `num-xs ${isError ? 'text-red' : 'text-muted'}`;
    status.style.margin = '2px 0';
    status.textContent = state;
    panel.append(status);
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.textContent = user.address
      ? (isError ? L('重试读取', 'Retry') : L('重新读取', 'Read again'))
      : L('连接钱包', 'Connect wallet');
    btn.onclick = () =>
      user.address
        ? refresh()
        : document.getElementById('btn-wallet-pill')?.click();
    panel.append(btn);
    const nav = document.createElement('nav');
    nav.className = 'wv-links';
    nav.innerHTML = links
      .map(([path, zh, en]) => link(path, L(zh, en), 'chevronRight'))
      .join('');
    panel.append(nav);
  }
  async function refresh() {
    const addr = user.address;
    show(
      null,
      addr
        ? L('正在读取钱包数据…', 'Reading wallet…')
        : L('未连接钱包 · 连接后可核验链上余额与凭证', 'Connect a wallet to verify balances and tickets'),
    );
    if (!addr) return;
    try {
      const data = await fetchUserPortfolio(addr);
      if (
        panel.isConnected &&
        store.state.user.address === addr &&
        data.walletAddress === addr
      )
        show(data, L('来源 · 钱包只读接口（真实只读）', 'Source · read-only wallet API'));
    } catch {
      if (panel.isConnected && store.state.user.address === addr)
        show(null, L('读取失败 · 请检查网络后重试', 'Read failed · check network and retry'), true);
    }
  }
  refresh();
}

export function liveRound(r) {
  const time = (value) => {
    if (!Number.isFinite(value) || value <= 0) return waiting();
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime())
      ? waiting()
      : date.toLocaleString(L('zh-CN', 'en-US'), { timeZone: 'UTC' }) + ' UTC';
  };
  const canLiveStake = !config.isDemo && store.fundsEnabled && r.stage === 'participation';
  const hasPool = r.rewardBudgetA9 !== null && r.rewardBudgetA9 !== undefined && Number.isFinite(Number(r.rewardBudgetA9));
  const chipCls = r.stage === 'settlement_success' ? 'chip-green' : r.stage === 'settlement_burn' ? 'chip-red' : 'chip-gold';
  return `<section class="card card-hero">
    <div class="row-between" style="margin-bottom:8px;">
      <span class="chip ${chipCls} mono">${L('第', 'R')} ${r.currentRound ?? '—'} ${L('轮', '')} · ${stageLabel(r.stage)}</span>
      <span class="num-xs text-muted mono">v17.0 · 5× ${L('封顶', 'Cap')}</span>
    </div>
    <div class="num-xs text-muted">${L('涨价解锁 · 本轮奖池', 'Price-Unlock Round Pool')}</div>
    <div class="num-hero" style="margin-top:3px;">${hasPool ? `${formatNum(r.rewardBudgetA9)} <span class="num-md text-green">A9</span>` : waiting()}</div>
    <div class="metric-strip cols-3">
      <div class="metric-cell"><span class="num-xs text-muted">${L('目标底价', 'Target')}</span><span class="num-sm mono">${priceOrDash(r.targetPrice)}</span></div>
      <div class="metric-cell"><span class="num-xs text-muted">${L('1H 均价', '1H TWAP')}</span><span class="num-sm mono text-green">${priceOrDash(r.twap24h ?? r.livePrice)}</span></div>
      <div class="metric-cell"><span class="num-xs text-muted">${L('自动止损', 'Auto Stop-Loss')}</span><span class="num-sm mono">5% / 10%</span></div>
    </div>
    <div class="num-xs text-sec" style="margin-bottom:10px;">${L('24H 锁仓窗口', '24H Lock Window')}: ${time(r.stakeOpenAt)} — ${time(r.stakeCloseAt)} · ${L('永不爆仓 · 未达 8/12 退 95%/90%', 'No Liquidation · < 8/12 refunds 95%/90%')}</div>
    ${canLiveStake
      ? `<a class="btn btn-primary" href="#/challenge/confirm">${icon('bolt', 15)} ${L('100 A9 起锁仓参与本轮', 'Lock from 100 A9 in Round')}</a>`
      : `<button class="btn btn-secondary" disabled>${store.fundsEnabled ? L('当前非锁仓窗口', 'Lock window closed') : L('真实只读 · 暂未开放锁仓', 'Live read-only · locking disabled')}</button>`}
  </section>
  ${tower(r)}<nav class="wv-links">${link('/observation/records', L('12H 冲价明细', '12H Slots'), 'clock')}${link('/rewards', L('14天解锁', '14D Unlock'), 'unlock')}${link('/warmup', L('预热', 'Warm-up'), 'bolt')}${link('/rules', L('规则', 'Rules'), 'book')}</nav>`;
}
