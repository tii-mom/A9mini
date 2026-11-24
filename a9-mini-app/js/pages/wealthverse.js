import { fetchUserPortfolio, fetchProgressionUser, claimProgressionTask, fetchWarmupCurrent, fetchMyChests, getEffectiveUserId, submitPredictionBet, rawToA9, PROTOCOL_SPECS } from '../data.js';
import { renderPlazaCompactBanner } from './round_stages.js';
import { L } from '../i18n.js';
import { config } from '../config.js';
import { store } from '../store.js';
import { icon } from '../icons.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { A9Audio } from '../audio.js';
import { burstParticles, copyText, escapeHtml, formatNum, formatTimer, openModal, closeModal, renderLiveSparkline, showToast } from '../components.js';
import { buildTonviewerUrl, shortAddress } from '../tx-ux.js';
import { DIORAMA_BACKDROP, renderCitySandtable, renderNintendoGateIcon } from '../paper-art.js';
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
  const attrs = lazy ? ' loading="lazy" decoding="async" width="68" height="68"' : ' decoding="async"';
  return `<img class="wv-person" src="${characterArt(n, series)}" alt="${code} 0${n}"${attrs}>`;
}

export function stageLabel(stage) {
  const stages = {
    warmup: ['开局倒计时', 'Pre-round'],
    participation: ['火热入场', 'Entry open'],
    observation: ['24H 闯关中', '24H Quest'],
    settlement_success: ['通关派奖', 'Passed · Payout'],
    settlement_burn: ['未通关 · 销毁', 'Failed · Burn'],
    halted: ['异常中止 · 退回本金', 'Aborted · Refund'],
  };
  return stages[stage] ? L(...stages[stage]) : waiting();
}

function priceOrDash(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) || Number(v) <= 0
    ? '—'
    : `$${Number(v).toFixed(4)}`;
}

function unlockPctByWins(n) {
  if (!Number.isFinite(Number(n)) || Number(n) <= 0) return null;
  if (n <= 5) return '20%';
  if (n <= 10) return '40%';
  return '100%';
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
 * - 每日 4 枚通关印章（打卡 / 0 GRAM 预言 / 24H 巡视 / 战报分享）+ 满章加赠 + 成长等级与成就徽章
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
      en: '24H Guess',
      exp: 50,
      done: todaySet.has('daily_prediction'),
      actionZh: hasPredBet ? '盖竞猜章' : '先去竞猜',
      actionEn: hasPredBet ? 'Stamp' : 'Go Guess',
    },
    {
      key: 'daily_observe',
      zh: '24H 巡视',
      en: '24H Inspect',
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
export function identityStage({ modePill = '', walletAddr = '', gramText = '', walletTag = '' } = {}) {
  const tier = store.state.user.previewTier || 1;
  const series = store.state.user.previewSeries || 'activity';
  const shownTier = tier;
  const item = getBoxheadItem(shownTier, series);
  const addrDisplay = walletAddr || walletTag || L('未连接钱包', 'Not connected');
  const gramDisplay = gramText || '— GRAM';

  return `<section class="wv-hero profile-identity-bar">
    <div class="identity-thumb series-${series}" id="identity-standee-stage">
      ${series === 'wealth' ? '<div class="identity-base" aria-hidden="true"></div>' : ''}
      ${portrait(shownTier, series)}
    </div>
    <div class="identity-meta">
      <div class="identity-name-row">
        <span class="identity-name-pill series-${series}">${escapeHtml(L(item.nameZh, item.nameEn))}</span>
        ${modePill || ''}
      </div>
      <div class="identity-addr-row">
        <span class="identity-addr mono">${escapeHtml(addrDisplay)}</span>
      </div>
      <div class="identity-gram mono">${escapeHtml(gramDisplay)}</div>
    </div>
    <a class="peel-badge identity-gallery-link" href="#/gallery/${item.id}">${L('图鉴', 'Gallery')} ›</a>
  </section>`;
}

/** 为背包身份栏头像绑定 360° 翻身试穿交互（仅演示模式） */
export function bindIdentityStage(root, onRerender) {
  if (!config.isDemo || !root) return;
  const img = root.querySelector('#identity-standee-stage .wv-person');
  if (!img) return;
  img.onclick = () => {
    A9Haptic.light();
    A9Audio.flip();
    burstParticles(img);
    const nextTier = ((store.state.user.previewTier || 1) % 9) + 1;
    store.update((state) => {
      state.user.previewTier = nextTier;
    });
    img.classList.remove('paper-flipping');
    void img.offsetWidth;
    img.classList.add('paper-flipping');
    setTimeout(() => {
      if (!root.isConnected) return;
      if (onRerender) {
        onRerender();
        const nextImg = root.querySelector('#identity-standee-stage .wv-person');
        if (nextImg) nextImg.classList.add('paper-flipping');
      }
    }, 240);
  };
}

/**
 * 主城首屏（#/challenge）：重心看「轮次进展」
 * 第一张主卡随阶段动态切换唯一视觉大数字焦点，奖池/权重/上限收为轻摘要；
 * 中层 4 枚任天堂服务入口；第二层为 24H 预言、全局解锁与返佣。
 */
export function city() {
  const r = store.state.round;
  const pred = store.state.prediction;
  const required = Number(r.minQualifiedCandles) || 16;
  const passed = r.qualifiedCandles ?? null;
  const confirmed = Array.isArray(r.candles)
    ? r.candles.filter((c) => c.confirmed || c.status === 'closed').length
    : (r.candlesSeen ?? null);
  const need = passed === null ? null : Math.max(0, required - passed);
  const awaitingSettle = r.stage === 'observation' && ((passed !== null && passed >= required) || r.nextState === 'AWAITING_SETTLE');
  const wins = r.successCount;
  const unlockPct = unlockPctByWins(wins);
  const candleSeries = Array.isArray(r.candles)
    ? r.candles.map((c) => Number(c?.p)).filter((v) => Number.isFinite(v) && v > 0)
    : [];
  const history = Array.isArray(r.priceHistory) && r.priceHistory.length > 1
    ? r.priceHistory
    : (candleSeries.length > 1 ? candleSeries.slice(-12) : []);

  const cdText = r.countdownSec === null || r.countdownSec === undefined
    ? '—'
    : formatTimer(r.countdownSec);

  const hasPoolBudget = r.rewardBudgetA9 !== null && r.rewardBudgetA9 !== undefined && Number.isFinite(Number(r.rewardBudgetA9));
  const refPrice = r.priceValid !== false ? Number(r.livePrice || r.twap24h || 0) : 0;
  const poolUsdEst = hasPoolBudget && refPrice > 0 ? Number(r.rewardBudgetA9) * refPrice : null;
  const hpPct = passed !== null && required > 0
    ? Math.max(0, Math.min(100, Math.round((passed / required) * 100)))
    : 0;

  // 24 颗微型实体进度点 + 外露 8px 迷你赛点条（观察与结算态展示）
  const slotStates = Array.from({ length: 24 }, (_, i) => {
    const c = Array.isArray(r.candles) ? r.candles.find((x) => x.index === i + 1) || r.candles[i] : null;
    return c?.confirmed
      ? (c.bull ? 'pass' : 'miss')
      : c?.status === 'active'
        ? 'active'
        : c?.status === 'pending'
          ? 'pending'
          : 'unknown';
  });
  const slotDots = slotStates.map((state, i) => `<i class="slot-dot ${state}${i === 15 ? ' threshold' : ''}" aria-hidden="true"></i>`).join('');
  const miniStripCells = slotStates.map((state, i) => `<i class="plaza-mini-cell ${state}${i === 15 ? ' threshold' : ''}" aria-hidden="true"></i>`).join('');

  // 首屏主卡聚焦 3 大核心焦点：1) 本轮奖池 A9/估值  2) 16/24 通关血条视觉  3) 唯一主行动按钮
  let poolKicker = L('本轮用户奖池（上限 15×）', 'ROUND REWARD POOL (15× CAP)');
  let poolMainHtml = hasPoolBudget
    ? `${formatNum(r.rewardBudgetA9)} <span class="focus-unit">A9</span>`
    : `<span>${waiting()}</span>`;
  let poolSubHtml = poolUsdEst !== null
    ? `${L('按当前均价参考估值约', 'Est. value at current TWAP')} <b class="mono">$${formatNum(poolUsdEst, 2)}</b>`
    : L('≥ 1,000 A9 参与 · 早鸟 2.0× / 1.4× / 1.0×', '≥ 1,000 A9 entry · Early 2.0× / 1.4× / 1.0×');
  let hpLabel = L('24H 通关血条（16/24 达标）', '24H PASS BAR (16/24 GOAL)');
  let hpBadge = passed !== null ? `${passed} / ${required}` : L('待核验', 'Pending');
  let hpHint = '';
  let hpTone = '';
  let ctaHref = '#/round';
  let ctaText = L('查看本轮进度', 'View round progress');
  let dotTone = '';
  let showSlotTrack = false;

  if (r.stage === 'participation') {
    poolKicker = L('火热入场 · 本轮奖池（早鸟 2.0×）', 'ENTRY OPEN · ROUND POOL (2.0×)');
    hpLabel = L('开盘入场窗口 · 准备冲击 16/24', 'ENTRY WINDOW · READY FOR 16/24');
    hpBadge = L('早鸟 2.0×', '2.0× EARLY');
    hpHint = L('最低 1,000 A9 参与 · 24H 达标 ≥ 16 格即通关', 'Min 1,000 A9 · 16+/24 hourly slots to pass');
    hpTone = 'gold';
    ctaText = L('立即查看参与入口', 'Enter Current Round');
    dotTone = 'gold';
  } else if (r.stage === 'warmup') {
    poolKicker = L('开局倒计时 · 本轮预热池', 'PRE-ROUND · WARM-UP POOL');
    if (!hasPoolBudget && config.isDemo) {
      poolMainHtml = `8,000,000 <span class="focus-unit">A9</span>`;
    }
    hpLabel = L('下轮开局预热中', 'NEXT ROUND WARM-UP');
    hpBadge = L('0 成本预约', '0-COST');
    hpHint = L('提前预约锁定开轮提醒与专属预热宝箱', 'Reserve early for opening alerts & Warm-Up Chest');
    hpTone = 'gold';
    ctaHref = '#/warmup';
    ctaText = L('前往开局预热', 'Open Warm-Up');
    dotTone = 'gold';
  } else if (awaitingSettle) {
    hpBadge = `${passed ?? required} / ${required}`;
    hpHint = L(`已达 16 格通关线（已确认 ${confirmed ?? '—'}/24），等待链上结算`, `16-slot threshold met (${confirmed ?? '—'}/24 confirmed), awaiting settle`);
    hpTone = 'pass';
    ctaText = L('查看结算进度', 'View settlement');
    showSlotTrack = true;
  } else if (r.stage === 'observation') {
    hpBadge = passed !== null ? `${passed} / ${required}` : L('待核验', 'Pending');
    const remSlots = confirmed !== null && Number.isFinite(Number(confirmed)) ? Math.max(0, 24 - Number(confirmed)) : null;
    hpHint = need === null
      ? L('时段数据待核验 · 点击下方查看 24H 明细', 'Slot data pending verification')
      : remSlots !== null && remSlots < need
        ? L(`剩 ${remSlots} 格（差 ${need} 格达标）· 关注链上结算`, `${remSlots} slot(s) left (need ${need}) · watch settlement`)
        : remSlots !== null
          ? L(`剩 ${remSlots} 格 · 只需再过 ${need} 格即通关`, `${remSlots} left · need ${need} more to pass`)
          : L(`距通关还差 ${need} 格 · 已确认 ${confirmed ?? '—'}/24 段`, `${need} more slot(s) to pass · ${confirmed ?? '—'}/24 confirmed`);
    ctaText = L('进入 24H 观测盘', 'Open 24H Board');
    dotTone = 'cyan';
    showSlotTrack = true;
  } else if (r.stage === 'settlement_success') {
    hpBadge = `${passed ?? required} / ${required}`;
    hpHint = L('本轮已达标通关 · 凭证奖励可前往金库核对领取', 'Round passed · check Claim Vault for unlocked A9');
    hpTone = 'pass';
    ctaText = L('查看通关结算', 'View Passed Result');
    showSlotTrack = true;
  } else if (r.stage === 'settlement_burn') {
    hpBadge = `${passed ?? 0} / ${required}`;
    hpHint = L('未达 16/24 达标线 · 已按 v16.1 规则执行链上销毁 BURN', 'Below 16/24 · on-chain BURN executed per v16.1');
    hpTone = 'burn';
    ctaText = L('查看销毁存证', 'View Burn Proof');
    dotTone = 'red';
    showSlotTrack = true;
  } else if (r.stage === 'halted') {
    hpBadge = L('安全中止', 'ABORTED');
    hpHint = L('触发预言机/超时安全保护 · 参与本金原路退回', 'Safety halt triggered · staked principal refunded');
    hpTone = 'gold';
    ctaText = L('查看退款存证', 'View Refund Proof');
    dotTone = 'gold';
  } else {
    hpBadge = waiting();
    hpHint = L('正在同步链上轮次状态', 'Syncing on-chain round status');
  }

  const gates = [
    ['/internal/market',          'market', L('宝箱商城', 'Chest Mall'),  L('0.99 GRAM起', 'From 0.99 GRAM')],
    ['/internal/market?tab=free', 'trophy', L('免费宝箱', 'Free Chests'), L('同行领 A9', 'Co-Op A9')],
    ['/rewards',                  'vault',  L('奖金金库', 'Vault'),       L('连胜解锁', 'Vesting')],
    ['/rules',                    'rules',  L('闯关指南', 'Guide'),       L('常见问题', 'FAQ Guide')],
  ];

  const showPredRatio = config.isDemo || (pred?.loaded && Number(pred.total) > 0);
  const passPct = Number.isFinite(Number(pred?.passPct)) ? Number(pred.passPct) : 61;
  const burnPct = Number.isFinite(Number(pred?.burnPct)) ? Number(pred.burnPct) : 39;

  // 按真实轮次状态与赛点驱动广场动态沙盘情绪
  const isSprint4h = r.stage === 'observation' && Number(r.countdownSec) > 0 && Number(r.countdownSec) <= 14400;
  const isRedAlert = (isSprint4h && passed !== null && passed >= 12 && passed <= 15) || r.stage === 'settlement_burn';
  const isMatchPoint = r.stage === 'observation' && !awaitingSettle && (isSprint4h || (passed !== null && passed >= Math.max(1, required - 2) && passed < required));
  const sandtableMood = r.stage === 'warmup'
    ? 'warmup'
    : r.stage === 'participation'
      ? 'participation'
      : (r.stage === 'settlement_success' || awaitingSettle)
        ? 'pass'
        : r.stage === 'settlement_burn'
          ? 'burn'
          : isMatchPoint
            ? 'matchpoint'
            : 'observation';

  const prog = store.state.progression || {};
  const curBet = pred?.currentBet || null;
  const predSettled = Boolean(pred?.settled || r.stage === 'settlement_success' || r.stage === 'settlement_burn');

  return `<section class="wv-hero game-city anim-page-enter">
    ${renderPlazaCompactBanner(pred, r)}

    <div class="diorama-stage city-hub-stage${isRedAlert ? ' alert-red-mode' : ''}" data-mood="${sandtableMood}">

      <div class="city-hub-top">
        <div class="city-round-pill">
          <span class="live-dot ${dotTone}"></span>
          <span>${L('第', 'R')} ${r.currentRound ?? '—'} ${L('轮', '')} · ${stageLabel(r.stage)}</span>
          ${isMatchPoint ? `<span class="chip chip-gold" style="min-height:18px;font-size:9.5px;padding:0 6px;">${L('赛点', 'MATCH PT')}</span>` : ''}
        </div>
        <div class="row-start" style="gap:5px;">
          <button type="button" class="plaza-trust-capsule" id="btn-plaza-trust-badge" title="${L('v16.1 合约已弃权 · 奖池链上可查', 'v16.1 Renounced · On-Chain Verified')}">
            ${icon('shieldCheck', 12, 'text-green')}
            <span>${L('已弃权', 'v16.1')}</span>
          </button>
          <div class="city-cd-badge" title="${L('当前阶段剩余时间', 'Time remaining')}">
            ${icon('clock', 12)}
            <span id="round-cd" class="mono">${cdText}</span>
          </div>
        </div>
      </div>

      <div class="plaza-pool-hero">
        <span class="diorama-kicker">${poolKicker}</span>
        <div class="city-focus-val">${poolMainHtml}</div>
        <p class="city-focus-sub">${poolSubHtml}</p>
      </div>

      <div class="plaza-hp-card${isMatchPoint ? ' is-matchpoint' : ''}${hpTone ? ` tone-${hpTone}` : ''}">
        <div class="row-between" style="margin-bottom:5px;">
          <span class="num-xs" style="font-weight:800;color:var(--ink);">${hpLabel}</span>
          <span class="chip ${hpTone === 'burn' ? 'chip-red' : hpTone === 'gold' ? 'chip-gold' : 'chip-green'} mono">${hpBadge}</span>
        </div>
        ${showSlotTrack ? `
          <div class="plaza-mini-strip" id="plaza-mini-strip" title="${L('24H 时段赛点条（红线为第 16 格通关线）', '24H slot strip (red mark = slot 16 goal)')}">${miniStripCells}</div>
          <div class="plaza-hp-track" aria-label="${L('16/24 通关进度血条', '16/24 pass bar')}">
            <div class="plaza-hp-fill${hpTone === 'burn' ? ' is-burn' : ''}" style="width:${hpPct}%;"></div>
          </div>
          <div class="row-between num-xs text-sec" style="margin:5px 0 0;font-weight:700;gap:6px;">
            <span>${hpHint}</span>
            <span class="mono text-green" id="live-twap-val">${priceOrDash(r.twap24h ?? r.livePrice)}</span>
          </div>
          <details class="plaza-slots-drawer" id="plaza-slots-drawer">
            <summary class="plaza-slots-summary">
              <span>${L('展开 24H 详情与目标底价', '24H Details & Target')} (${priceOrDash(r.targetPrice)})</span>
              <span class="num-xs text-muted">▾</span>
            </summary>
            <a class="city-slot-strip${isMatchPoint ? ' is-matchpoint' : ''}" href="#/observation/records">
              <div class="city-slot-dots" aria-label="${L('24H 时段进度', '24H slot progress')}">${slotDots}</div>
              <div class="row-between city-price-inline">
                <span>${L('目标', 'Target')} <b class="mono">${priceOrDash(r.targetPrice)}</b></span>
                <span class="row-start" style="gap:6px;">
                  <span>${L('均价', 'TWAP')} <b class="mono text-green">${priceOrDash(r.twap24h ?? r.livePrice)}</b></span>
                  ${history.length > 1 ? renderLiveSparkline(history) : ''}
                </span>
              </div>
            </a>
          </details>
        ` : `
          <div class="num-xs text-sec" style="margin-bottom:6px;font-weight:700;">${hpHint}</div>
          <div class="row-between num-xs" style="padding:6px 9px;border-radius:10px;background:var(--paper-tray);">
            <span>${L('目标底价', 'Target')} <b class="mono">${priceOrDash(r.targetPrice)}</b></span>
            <span>${L('均价', 'TWAP')} <b class="mono text-green" id="live-twap-val">${priceOrDash(r.twap24h ?? r.livePrice)}</b></span>
          </div>
        `}
      </div>

      <a class="game-play" href="${ctaHref}">${ctaText} ›</a>
    </div>

    <nav class="game-gates">
      ${gates.map(([path, asset, label, sub]) => `
        <a href="#${path}">
          <span class="nt-gate-icon-wrap" aria-hidden="true">${renderNintendoGateIcon(asset, 30)}</span>
          <span>${label}</span>
          <small>${sub}</small>
        </a>
      `).join('')}
    </nav>

    <div class="card clickable city-pred-card${isRedAlert ? ' alert-red-mode' : ''}" id="city-pred-jump" role="button" tabindex="0">
      <div class="row-between">
        <div class="row-start">
          <span class="chip ${isRedAlert ? 'chip-red' : 'chip-green'}">${isRedAlert ? L('最后 4H 红警', '4H RED ALERT') : L('0 GRAM 免费猜', '0 GRAM Free')}</span>
          <strong class="city-pred-title">${L('24H 预言擂台', '24H Prediction Arena')}</strong>
        </div>
        <span class="city-pred-go" id="city-pred-status">${curBet ? (curBet.side === 'BURN' ? L('已押 BURN', 'Locked BURN') : L('已押 PASS', 'Locked PASS')) : L('进擂台', 'Arena')} ›</span>
      </div>
      <p class="city-pred-desc">${L('0 GRAM 押 PASS / BURN · 新人首轮保底 500 A9 赠金', '0 GRAM PASS / BURN · 500 A9 rookie floor')}</p>
      ${showPredRatio ? `
        <div class="city-pred-bar-wrap">
          <div class="row-between num-xs">
            <span class="text-green" style="font-weight:800;">${L('通关多军 PASS', 'PASS')} ${passPct}%</span>
            <span class="text-red" style="font-weight:800;">${L('销毁空军 BURN', 'BURN')} ${burnPct}%</span>
          </div>
          <div class="pred-split-bar pred-versus-bar" style="height:8px;margin-top:4px;">
            <div class="pred-split-pass" style="width:${passPct}%;"></div>
            <div class="pred-split-burn" style="width:${burnPct}%;"></div>
          </div>
        </div>
      ` : ''}
      <div id="plaza-pred-action-slot">
        ${!predSettled && !curBet ? `
          <div class="grid-2 plaza-quick-pred" style="gap:8px;margin-top:10px;">
            <button type="button" class="pred-side-btn pass" data-plaza-pred-side="PASS" style="min-height:38px;font-size:12.5px;">${icon('checkCircle', 14)} ${L('0 GRAM 押 PASS', '0 GRAM PASS')}</button>
            <button type="button" class="pred-side-btn burn" data-plaza-pred-side="BURN" style="min-height:38px;font-size:12.5px;">${icon('flame', 14)} ${L('0 GRAM 押 BURN', '0 GRAM BURN')}</button>
          </div>
        ` : (!predSettled && curBet ? `
          <div class="plaza-pred-followup">
            <button type="button" class="btn btn-secondary btn-sm" data-plaza-pred-share="${curBet.side}" style="width:100%;min-height:36px;">${icon('send', 13)} ${L('发群战报', 'Share Call')}</button>
            <a class="btn btn-primary btn-sm" href="#/internal/market" data-plaza-stop="1" style="width:100%;min-height:36px;">${icon('bolt', 13)} ${L('0.99 购箱抽暴击', '0.99 Crit Chest')}</a>
          </div>
        ` : '')}
      </div>
    </div>

    <a class="card clickable" id="city-warmup-card" href="#/warmup" style="display:block;text-decoration:none;color:inherit;">
      <div class="row-between" style="margin-bottom:6px;">
        <div class="row-start" style="gap:6px;">
          <span class="chip chip-gold" id="city-warmup-round">${L(`第 ${(Number(r.currentRound) || 0) + 1} 轮预热`, `R${(Number(r.currentRound) || 0) + 1} Warm-Up`)}</span>
          <strong style="font-size:14px;">${L('下一轮开局预约 · 领预热宝箱', 'Next Round Reserve · Free Chest')}</strong>
        </div>
        <span class="num-xs text-green" id="city-warmup-cta" style="font-weight:800;">${L('去预约', 'Reserve')} ›</span>
      </div>
      <div class="row-between num-xs text-sec" style="margin-bottom:5px;">
        <span id="city-warmup-count">${L('正在同步全网预约人数…', 'Syncing reservation count…')}</span>
        <span class="mono" id="city-warmup-pct">—</span>
      </div>
      <div class="progress-track" style="height:6px;"><div class="progress-fill" id="city-warmup-fill" style="width:0%;"></div></div>
    </a>

    <div class="city-meta-grid">
      <a class="city-meta-tile" href="#/rewards">
        <small>${L('全网累计达标', 'Global Wins')}</small>
        <strong>${wins == null ? waiting() : `${wins} ${L('轮', 'wins')}`}</strong>
        <span>${unlockPct ? L(`当前即时解锁 ${unlockPct}`, `${unlockPct} instant`) : L('查看连胜解锁', 'Vesting tiers')} ›</span>
      </a>
      <a class="city-meta-tile" href="#/team/invite">
        <small>${L('直推宝箱返佣', 'Direct Referral')}</small>
        <strong>6%</strong>
        <span>${L('生成招募海报', 'Invite poster')} ›</span>
      </a>
    </div>

    <details class="handbook-collapse" id="a9-handbook-collapse">
      <summary class="handbook-collapse-summary">
        <span class="row-start" style="gap:6px;">
          ${icon('checkCircle', 14, 'text-green')}
          <strong>${L('日常集章打卡', 'Daily Stamp Check-in')}</strong>
          <span class="chip chip-muted mono" style="height:19px;font-size:10px;padding:0 6px;">Lv.${prog.level || 1} · ${prog.dailyDoneCount || 0}/4</span>
        </span>
        <span class="num-xs text-muted">${L('展开盖章', 'Expand')} ▾</span>
      </summary>
      <div class="handbook-collapse-body">
        ${renderHandbookStampCard()}
      </div>
    </details>
  </section>`;
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

      // 若点击 0 GRAM 竞猜章但本轮尚未提交竞猜，直接引导跳转到挑战页竞猜卡
      if (taskKey === 'daily_prediction' && !store.state.prediction?.currentBet) {
        A9Haptic.light();
        A9Audio.tick();
        store.state.referral.pendingScrollTarget = 'prediction';
        showToast(L('请先完成本轮 0 GRAM 24H 预言擂台后盖章', 'Complete your 0 GRAM 24H prediction first'));
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

/** 弹出 v16.1 合约防 Rug 链上验真卡（展示实时奖池余量、admin_address = addr_none、7天 AbortRound 逃生舱、code_hash 与 Tonviewer 查验） */
function openContractTrustModal(navigate) {
  A9Haptic.light();
  const r = store.state.round || {};
  const cfg = r.protocolConfig || {};
  const contracts = cfg.contracts || {};
  const network = cfg.network || config.network || 'mainnet';
  const rcAddr = String(contracts.roundController || '').trim();
  const jmAddr = String(contracts.jettonMaster || contracts.a9JettonMaster || '').trim();
  const rcUrl = rcAddr ? buildTonviewerUrl(rcAddr, network) : '';
  const jmUrl = jmAddr ? buildTonviewerUrl(jmAddr, network) : '';
  const poolRemA9 = r.poolState?.poolRemainingRaw ? rawToA9(r.poolState.poolRemainingRaw) : (r.rewardPoolA9 ?? null);
  const codeHash = cfg.roundControllerCodeHash || cfg.codeHash || null;

  const addrRow = (title, addr, url, copyId) => `
    <div class="sub-tile" style="padding:9px 11px;">
      <div class="row-between" style="margin-bottom:4px;">
        <span class="num-xs text-muted">${title}</span>
        <span class="chip ${addr ? 'chip-green' : 'chip-muted'} mono" style="min-height:18px;font-size:9.5px;">${addr ? String(network).toUpperCase() : L('待接入', 'PENDING')}</span>
      </div>
      ${addr ? `
        <div class="row-between" style="gap:6px;">
          <span class="mono num-xs" style="font-weight:800;" title="${escapeHtml(addr)}">${escapeHtml(shortAddress(addr, 8, 6))}</span>
          <div class="row-start" style="gap:6px;">
            <button class="pill-trigger neutral" id="${copyId}" type="button">${icon('copy', 11)} ${L('复制', 'Copy')}</button>
            <a class="pill-trigger" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Tonviewer ${icon('external', 11)}</a>
          </div>
        </div>
      ` : `<div class="num-xs text-sec">${L('主网合约地址同步后自动开放 Tonviewer 直连查验', 'Tonviewer link activates once mainnet contract config syncs')}</div>`}
    </div>
  `;

  openModal(`
    <div class="sheet-handle"></div>
    <div class="row-between" style="margin-bottom:8px;">
      <div class="card-title">${icon('shieldCheck', 17, 'text-green')} ${L('v16.1 合约链上防 Rug 验真', 'v16.1 On-Chain Anti-Rug Proof')}</div>
      <button class="icon-btn" id="trust-modal-close" type="button" aria-label="${L('关闭', 'Close')}">${icon('x', 15)}</button>
    </div>
    <div class="trust-modal-scroll">
      <div class="sub-tile" style="padding:9px 11px;margin-bottom:10px;">
        <div class="check-list">
          <div class="check-row"><span class="text-sec">${L('管理员权限', 'Admin')}</span><span class="mono text-green" style="font-weight:800;">admin_address = addr_none</span></div>
          <div class="check-row"><span class="text-sec">${L('链上剩余奖池', 'Pool Remaining')}</span><span class="mono text-green" style="font-weight:800;">${poolRemA9 !== null && Number.isFinite(Number(poolRemA9)) ? `${formatNum(Math.round(Number(poolRemA9)))} A9` : L('待同步', 'Pending')}</span></div>
          <div class="check-row"><span class="text-sec">${L('逃生舱机制', 'Escape Hatch')}</span><span class="mono" style="font-weight:700;">${L('7 天 AbortRound 无许可退本', '7d Permissionless AbortRound')}</span></div>
          <div class="check-row"><span class="text-sec">${L('推广熔断硬顶', 'Promo Cap')}</span><span class="mono">${formatNum(PROTOCOL_SPECS.promoCapA9)} A9</span></div>
          <div class="check-row"><span class="text-sec">code_hash</span><span class="mono num-xs">${codeHash ? escapeHtml(`${String(codeHash).slice(0, 10)}…${String(codeHash).slice(-6)}`) : L('Tonviewer 字节码直查', 'Inspect on Tonviewer')}</span></div>
        </div>
      </div>
      <div class="col-gap" style="gap:8px;margin-bottom:12px;">
        ${addrRow(L('主控合约 RoundController', 'RoundController Contract'), rcAddr, rcUrl, 'btn-copy-rc-addr')}
        ${addrRow(L('代币合约 JettonMaster (已弃权)', 'JettonMaster (Renounced)'), jmAddr, jmUrl, 'btn-copy-jm-addr')}
      </div>
      <div class="col-gap" style="gap:8px;">
        <button class="btn btn-primary" id="btn-trust-go-audit" type="button">${icon('shieldCheck', 15)} ${L('前往完整链上验真看板', 'Open Full Audit Board')}</button>
        <button class="btn btn-secondary" id="btn-trust-close" type="button">${L('关闭', 'Close')}</button>
      </div>
    </div>
  `);

  const close = () => { A9Haptic.light(); closeModal(); };
  const xBtn = document.getElementById('trust-modal-close');
  if (xBtn) xBtn.onclick = close;
  const cBtn = document.getElementById('btn-trust-close');
  if (cBtn) cBtn.onclick = close;
  const copyRc = document.getElementById('btn-copy-rc-addr');
  if (copyRc && rcAddr) copyRc.onclick = () => copyText(rcAddr, L('已复制 RoundController 地址', 'RoundController address copied'));
  const copyJm = document.getElementById('btn-copy-jm-addr');
  if (copyJm && jmAddr) copyJm.onclick = () => copyText(jmAddr, L('已复制 JettonMaster 地址', 'JettonMaster address copied'));
  const auditBtn = document.getElementById('btn-trust-go-audit');
  if (auditBtn) {
    auditBtn.onclick = () => {
      A9Haptic.light();
      closeModal();
      if (navigate) navigate('/risk/audit');
      else window.location.hash = '#/risk/audit';
    };
  }
}

/** 渲染广场并绑定信任徽章、每日集章与首屏 0 GRAM 一键预言交互 */
export function renderCity(root, navigate) {
  if (config.isDemo && !store.state.progression.loaded) {
    const uid = getEffectiveUserId(store.state.user);
    const data = demoProgressionInitSnapshot(uid, store.state.round.currentRound || 3);
    Object.assign(store.state.progression, data, { loaded: true, error: false });
  }
  root.innerHTML = city();
  bindHandbookStampEvents(root, navigate);
  syncProgressionState(root, navigate);
  hydrateCityWarmupCard(root);

  const trustBtn = root.querySelector('#btn-plaza-trust-badge');
  if (trustBtn) {
    trustBtn.onclick = () => openContractTrustModal(navigate);
  }

  const miniStrip = root.querySelector('#plaza-mini-strip');
  const slotsDrawer = root.querySelector('#plaza-slots-drawer');
  if (miniStrip && slotsDrawer) {
    miniStrip.onclick = () => {
      A9Haptic.tick();
      slotsDrawer.open = !slotsDrawer.open;
    };
  }

  const bindPlazaFollowup = () => {
    root.querySelectorAll('[data-plaza-stop]').forEach((el) => {
      el.onclick = (e) => e.stopPropagation();
    });
    root.querySelectorAll('[data-plaza-pred-share]').forEach((shareBtn) => {
      shareBtn.onclick = (e) => {
        e.stopPropagation();
        A9Haptic.light();
        const side = shareBtn.dataset.plazaPredShare === 'BURN' ? 'BURN' : 'PASS';
        const roundId = store.state.round?.currentRound || 1;
        const shareLink = buildStartAppLink('bet', roundId);
        const sideText = side === 'BURN' ? L('销毁 BURN', 'BURN') : L('通关 PASS', 'PASS');
        const copy = L(
          `我在 A9 第 ${roundId} 轮 24H 预言擂台 0 GRAM 押了【${sideText}】，新人首轮保底 500 A9 赠金，来站队对赌：`,
          `I locked [${sideText}] for 0 GRAM in A9 Round #${roundId} 24H Arena (500 A9 rookie floor):`
        );
        A9TMA.shareInvite(shareLink, copy);
        showToast(L('已调起 Telegram 群分享战报', 'Opened Telegram share'));
      };
    });
  };
  bindPlazaFollowup();

  root.querySelectorAll('[data-plaza-pred-side]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const side = btn.dataset.plazaPredSide;
      const uid = getEffectiveUserId(store.state.user);
      const roundId = store.state.round?.currentRound || 1;
      if (!uid) {
        A9Haptic.warning();
        showToast(L('请在 Telegram 内打开或先连接 TON 钱包', 'Open in Telegram or connect TON wallet first'), 'amber');
        return;
      }
      const allBtns = root.querySelectorAll('[data-plaza-pred-side]');
      allBtns.forEach((b) => { b.disabled = true; });
      try {
        await submitPredictionBet({
          roundId,
          userId: uid,
          side,
          guessSlots: null,
          referrerId: store.state.referral.referrerId,
        });
        A9Haptic.success();
        A9Audio.confirm();
        burstParticles(btn);
        store.update((s) => {
          s.prediction.currentBet = { side, guessSlots: null };
        });
        showToast(L(`已 0 GRAM 锁定本轮立场：${side === 'BURN' ? '销毁 BURN' : '通关 PASS'}`, `0 GRAM prediction locked: ${side}`));
        if (root.isConnected) {
          const statusEl = root.querySelector('#city-pred-status');
          if (statusEl) statusEl.textContent = `${side === 'BURN' ? L('已押 BURN', 'Locked BURN') : L('已押 PASS', 'Locked PASS')} ›`;
          const slotEl = root.querySelector('#plaza-pred-action-slot');
          if (slotEl) {
            slotEl.innerHTML = `
              <div class="plaza-pred-followup">
                <button type="button" class="btn btn-secondary btn-sm" data-plaza-pred-share="${side}" style="width:100%;min-height:36px;">${icon('send', 13)} ${L('发群战报', 'Share Call')}</button>
                <a class="btn btn-primary btn-sm" href="#/internal/market" data-plaza-stop="1" style="width:100%;min-height:36px;">${icon('bolt', 13)} ${L('0.99 购箱抽暴击', '0.99 Crit Chest')}</a>
              </div>
            `;
            bindPlazaFollowup();
          }
        }
      } catch (err) {
        A9Haptic.error();
        showToast(err?.message || L('提交预言失败，请重试', 'Prediction submit failed'), 'error');
        allBtns.forEach((b) => { b.disabled = false; });
      }
    };
  });

  const predCard = root.querySelector('#city-pred-jump');
  if (predCard) {
    const goPred = () => {
      A9Haptic.light();
      A9Audio.tick();
      store.state.referral.pendingScrollTarget = 'prediction';
      if (navigate) navigate('/round');
      else window.location.hash = '#/round';
    };
    predCard.onclick = goPred;
    predCard.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        goPred();
      }
    };
  }
}

async function hydrateCityWarmupCard(root) {
  const card = root.querySelector('#city-warmup-card');
  if (!card) return;
  try {
    const data = await fetchWarmupCurrent();
    if (!card.isConnected || !data) return;
    const rid = Number(data.roundId) || ((Number(data.currentOnchainRoundId ?? store.state.round?.currentRound) || 0) + 1);
    const regCount = Number(data.stats?.totalRegistered ?? 0);
    const target = Number(data.stats?.targetUsers ?? 0);
    const pct = Math.max(0, Math.min(100, Number(data.stats?.progressPct ?? 0)));
    const reserved = Boolean(data.isReserved);
    const open = Boolean(data.open);
    const roundEl = card.querySelector('#city-warmup-round');
    const ctaEl = card.querySelector('#city-warmup-cta');
    const countEl = card.querySelector('#city-warmup-count');
    const pctEl = card.querySelector('#city-warmup-pct');
    const fillEl = card.querySelector('#city-warmup-fill');
    if (roundEl) roundEl.textContent = L(`第 ${rid} 轮预热`, `R${rid} Warm-Up`);
    if (ctaEl) ctaEl.textContent = !open ? L('已截止 ›', 'Closed ›') : reserved ? L('已预约 · 查宝箱 ›', 'Reserved · Chest ›') : L('一键预约 ›', 'Reserve ›');
    if (countEl) {
      countEl.textContent = target > 0
        ? L(`已预约 ${formatNum(regCount)} / 目标 ${formatNum(target)} 人`, `${formatNum(regCount)} / ${formatNum(target)} reserved`)
        : L(`已预约 ${formatNum(regCount)} 人`, `${formatNum(regCount)} reserved`);
    }
    if (pctEl) pctEl.textContent = target > 0 ? `${pct}%` : '—';
    if (fillEl) fillEl.style.width = `${pct}%`;
  } catch (_) {
    const countEl = card.querySelector('#city-warmup-count');
    if (countEl && card.isConnected) countEl.textContent = L('点击进入下一轮预热预约与宝箱页', 'Tap to open Next Round Warm-Up & Chest');
  }
}

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
              <img class="wv-person${canEvaluate && !isSelectedUnlocked ? ' is-locked-preview' : ''}" id="boxhead-avatar-img" src="${item.avatar}" alt="${code} 0${selected}">
            </div>
            <div class="boxhead-face back">
              <img class="boxhead-card-img" id="boxhead-backing-card" src="${item.card}" alt="${code} 0${selected} ${L('精装卡背', 'Backing Card')}">
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
 * 奖励宝库（#/rewards）：
 * 明确拆分为「1. 当前解锁档位与资产状态」与「2. 三阶水晶概念美术预览（非持仓）」两大独立分区
 */
export function rewards(root) {
  const n = store.state.round.successCount;
  const u = store.state.user;
  const activeStepIdx = n > 0 ? (n <= 5 ? 0 : n <= 10 ? 1 : 2) : -1;
  const curUnlockLabel = activeStepIdx === 0 ? '20%' : activeStepIdx === 1 ? '40%' : activeStepIdx === 2 ? '100%' : waiting();

  const amounts = [
    [L('已解锁待领取', 'Unlocked and claimable'), config.isDemo ? u.a9Claimable : null],
    [L('待解锁份额', 'Locked shares'), config.isDemo ? u.a9Locked : null],
    [L('已销毁份额', 'Burned shares'), null],
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
            <span class="diorama-kicker">A9 / TREASURY</span>
            <h2 style="margin:3px 0 0;font-size:19px;font-weight:900;">${L('当前解锁档位', 'Current Vesting Tier')}</h2>
            <p class="num-xs text-sec" style="margin:4px 0 0;">${L('全网累计达标', 'Global wins')} · <b class="mono" style="color:var(--ink);">${n ?? waiting()}</b> · ${L('即时解锁', 'Instant')} <b class="mono text-gold">${curUnlockLabel}</b></p>
          </div>
          <span class="nt-art-badge tone-blue" aria-hidden="true">${renderNintendoGateIcon('vault', 36)}</span>
        </div>
        <div class="wv-steps" style="margin-top:12px;">
          ${[
            ['1–5', '20%', '4 × 20%'],
            ['6–10', '40%', '2 × 30%'],
            ['11+', '100%', '—'],
          ].map(([range, pct, rest], i) => `
            <article class="${activeStepIdx === i ? 'current' : ''}">
              <small>${L('累计成功', 'Wins')} ${range}</small>
              <strong>${pct}</strong>
              ${L('即时解锁', 'Immediate')}
              <p>${rest}</p>
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
        <p class="num-xs text-muted" style="margin:10px 0 0;line-height:1.5;">${L('失败将销毁对应待解锁份额 · 奖池分完为止', 'Loss burns scheduled slice · until pool exhaustion')}</p>
      </section>

      <nav class="wv-links">${link('/claim', L('金库领奖', 'Claim Prizes'), 'unlock')}${link('/profile', L('我的档案', 'My Profile'), 'wallet')}</nav>
    </div>
  `;
}

export function tower(round) {
  const labels = {
    unknown: L('待核验', 'Pending'),
    pending: L('未开始', 'Upcoming'),
    active: L('观察中', 'Observing'),
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
        <small>24H / STAMP BOARD</small>
        <h2 style="margin:2px 0 0;">${L('24H 观测集章板', '24H Stamp Board')}</h2>
      </div>
      <span class="chip chip-muted mono">${L('已确认', 'Confirmed')} ${confirmedCount}/24</span>
    </div>
    <div class="wv-windows">${Array.from(
      { length: 24 },
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
    <p>${L('已达标', 'Qualified')} <b class="mono">${round.qualifiedCandles ?? '—'} / 16</b> · ${round.qualifiedCandles >= 16 && round.stage === 'observation' ? L('等待结算', 'Awaiting settlement') : L('达标门槛 16 段', '16 slots to pass')}</p>
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

export function portfolioPanel(root, guild = false) {
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
        ['/renew', '自动连闯', 'Auto-Continue'],
        ['/settings', '偏好设置', 'Settings'],
      ];
  function show(data, state, isError = false) {
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
        data?.team?.role === 'captain' || (data?.team?.captainWallet === user.address && user.address)
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
      if (!active.length) row(L('质押中 A9', 'Staked A9'), waiting());
      for (const labels of [
        ['已解锁待领取', 'Unlocked, unclaimed'],
        ['待解锁', 'Locked rewards'],
        ['已销毁', 'Burned shares'],
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
  return `<section class="wv-tower"><small>A9 / ROUND ${r.currentRound ?? '—'}</small><h2>${stageLabel(r.stage)}</h2>
    <p>${L('参与窗口', 'Entry window')} · ${time(r.stakeOpenAt)} — ${time(r.stakeCloseAt)}</p>
    <p>${L('早鸟权重仅影响奖励分配份额', 'Early weights affect allocation only')} · 2.0× / 1.4× / 1.0×</p>
    <p>${L('失败将销毁该轮质押的 A9 本金。', 'Failure burns the A9 principal staked in the round.')}</p>
    ${canLiveStake
      ? `<a class="btn btn-primary" style="margin-top:12px;" href="#/challenge/confirm">${icon('bolt', 15)} ${L('质押 A9 参与本轮闯关', 'Stake A9 in Current Round')}</a>`
      : `<button class="btn btn-secondary" style="margin-top:12px;" disabled>${store.fundsEnabled ? L('当前轮次非入场窗口', 'Staking window closed') : L('真实模式只读 · 质押签名暂未开放', 'Live read-only · staking disabled')}</button>`}</section>
    ${tower(r)}<nav class="wv-links">${link('/observation/records', L('时段明细', 'Slot details'), 'clock')}${link('/rewards', L('解锁阶段', 'Vesting'), 'unlock')}${link('/warmup', L('预热', 'Warm-up'), 'bolt')}${link('/rules', L('规则', 'Rules'), 'book')}</nav>`;
}
