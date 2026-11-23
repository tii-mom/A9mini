import { fetchUserPortfolio, fetchProgressionUser, claimProgressionTask, getEffectiveUserId } from '../data.js';
import { renderPendingVaultBanner, renderEarlyBirdBanner } from './round_stages.js';
import { L } from '../i18n.js';
import { config } from '../config.js';
import { store } from '../store.js';
import { icon } from '../icons.js';
import { A9Haptic, A9TMA } from '../tma.js';
import { A9Audio } from '../audio.js';
import { burstParticles, formatNum, formatTimer, renderLiveSparkline, showToast } from '../components.js';
import { DIORAMA_BACKDROP, renderCitySandtable } from '../paper-art.js';
import { BOXHEADS_SERIES, getBoxheadItem, characterArt, characterCardArt } from '../wealth-art.js';
import { buildStartAppLink } from '../share.js';

const link = (path, label, glyph) =>
  `<a href="#${path}">${icon(glyph, 16)}${label}</a>`;
const waiting = () => L('待核验', 'Awaiting verification');

const WEALTH_TIER_USD = [100, 500, 1500, 5000, 15000, 50000, 150000, 500000, 1000000];
let activeGallerySeries = 'activity';

function portrait(n, series = 'activity') {
  const code = series === 'wealth' ? 'WLT' : 'ACT';
  return `<img class="wv-person" src="${characterArt(n, series)}" alt="${code} 0${n}">`;
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
    ['折纸旅人', 'Paper Traveler'],
    ['集章学徒', 'Stamp Apprentice'],
    ['手账记录员', 'Logbook Keeper'],
    ['沙盘绘制师', 'Sandtable Crafter'],
    ['金箔典藏家', 'Foil Collector'],
  ];
  return L(...titles[Math.min(titles.length - 1, n - 1)]);
}

/**
 * 阶段三：广场手账集章卡（Handbook Stamp Card）
 * - 每日 4 枚手盖橡皮圆章（打卡 / 0 GRAM 预言 / 24H 巡视 / 纸艺分享）+ 满章加赠 + 成长等级与成就徽章
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
          <div class="card-title">${icon('checkCircle', 15, 'text-green')} ${L('广场集章手账', 'Plaza Stamp Logbook')}</div>
          <span class="chip chip-muted">${L('游戏成长数据', 'In-Game EXP')}</span>
        </div>
        <p class="num-xs text-sec" style="margin:8px 0 0;line-height:1.5;">${L('请在 Telegram 小程序内打开以同步你的每日集章进度、连续打卡天数与手账等级（非代币资产，不可兑换 A9/GRAM）。', 'Open inside Telegram Mini App to sync your daily stamps, streak and handbook level (non-financial growth data).')}</p>
      </section>
    `;
  }

  if (!config.isDemo && prog.error) {
    return `
      <section class="card handbook-stamp-card" id="a9-handbook-card">
        <div class="row-between">
          <div class="card-title">${icon('shieldAlert', 15, 'text-red')} ${L('广场集章手账', 'Plaza Stamp Logbook')}</div>
          <button class="btn btn-secondary btn-sm" id="btn-prog-retry" type="button">${L('重试读取', 'Retry')}</button>
        </div>
        <p class="num-xs text-muted" style="margin:6px 0 0;">${L('手账集章数据暂不可读取，请点击重试。', 'Handbook progression unavailable. Tap to retry.')}</p>
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
      zh: '纸艺分享',
      en: 'Share Card',
      exp: 40,
      done: todaySet.has('daily_share'),
      actionZh: '盖分享章',
      actionEn: 'Stamp',
    },
  ];

  const achLabels = {
    ach_first_stamp: [L('初入手账', 'First Stamp'), 50],
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
          <strong class="card-title">${L('广场集章手账', 'Plaza Stamp Logbook')}</strong>
          <span class="chip chip-gold">Lv.${prog.level || 1} · ${handbookLevelTitle(prog.level)}</span>
        </div>
        <span class="chip chip-muted mono">${L('连签', 'Streak')} ${prog.checkinStreak || 0}${L('天', 'd')} · ${prog.dailyDoneCount || 0}/4</span>
      </div>

      <div class="row-between num-xs text-muted" style="margin-bottom:4px;">
        <span>${L('手账经验', 'Handbook EXP')} <b class="mono" style="color:var(--ink);">${prog.exp || 0} EXP</b>（${prog.currentLevelExp || 0}/${prog.expPerLevel || 200}）</span>
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
 * 背包顶部紧凑横向「个人身份纸艺铭牌栏」(~112px)
 * - 不与下方待处理领取、资产与凭证抢夺首屏，同时完整保留角色立牌 + 360° 翻身试穿 + 图鉴入口
 */
export function identityStage({ modePill = '', walletTag = '' } = {}) {
  const tier = store.state.user.previewTier || 1;
  const series = config.isDemo ? (store.state.user.previewSeries || 'activity') : 'activity';
  const shownTier = config.isDemo ? tier : 1;
  const item = getBoxheadItem(shownTier, series);
  const code = series === 'wealth' ? 'WLT' : 'ACT';
  const heading = config.isDemo ? `${code} 0${shownTier} · ${L(item.nameZh, item.nameEn)}` : L('身份待核验', 'Identity pending');
  const subtitle = config.isDemo
    ? `${L(item.traitZh, item.traitEn)} · ${L('轻点头像切换预览', 'Tap to flip')}`
    : L('连接钱包后核验 A9 持仓阶位', 'Connect wallet to verify A9 tier');

  return `<section class="wv-hero profile-identity-bar">
    <div class="identity-thumb series-${series}" id="identity-standee-stage">
      ${series === 'wealth' ? '<div class="identity-base" aria-hidden="true"></div>' : ''}
      ${portrait(shownTier, series)}
    </div>
    <div class="identity-meta">
      <div class="row-between" style="gap:6px;">
        <span class="diorama-kicker">${config.isDemo ? `BOXHEADS · ${code} 0${shownTier}` : 'ON-CHAIN ID'}</span>
        ${modePill || ''}
      </div>
      <h1>${heading}</h1>
      <p>${walletTag || subtitle}</p>
      ${walletTag ? `<small>${subtitle}</small>` : ''}
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
 * 中层 4 枚折纸服务入口；第二层为 24H 预言、全局解锁与返佣。
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

  const poolSummary = r.rewardBudgetA9 === null || r.rewardBudgetA9 === undefined
    ? `${L('奖池', 'Pool')} ${waiting()}`
    : `${L('奖池', 'Pool')} ${formatNum(r.rewardBudgetA9)} A9`;

  // 24 颗微型纸艺进度点（观察与结算态展示）
  const slotDots = Array.from({ length: 24 }, (_, i) => {
    const c = Array.isArray(r.candles) ? r.candles.find((x) => x.index === i + 1) || r.candles[i] : null;
    const state = c?.confirmed
      ? (c.bull ? 'pass' : 'miss')
      : c?.status === 'active'
        ? 'active'
        : c?.status === 'pending'
          ? 'pending'
          : 'unknown';
    return `<i class="slot-dot ${state}${i === 15 ? ' threshold' : ''}" aria-hidden="true"></i>`;
  }).join('');

  // 按当前轮次阶段确定唯一焦点数字、副说明与精准动词按钮
  let focusKicker = L('本轮达标进展', 'ROUND PROGRESS');
  let focusHtml = '';
  let focusSub = '';
  let ctaText = L('查看本轮进度', 'View round progress');
  let dotTone = '';
  let showSlotTrack = false;

  if (r.stage === 'participation') {
    focusKicker = L('参与窗口开放中 · 早鸟权重', 'ENTRY OPEN · EARLY WEIGHT');
    focusHtml = `<span class="focus-accent-gold">2.0×</span> <span class="focus-unit">${L('首段早鸟', 'Early Tier')}</span>`;
    focusSub = L('最低 10 GRAM 参与 · 权重档位 2.0× / 1.4× / 1.0×', 'From 10 GRAM · Weight tiers 2.0× / 1.4× / 1.0×');
    ctaText = L('查看参与条件', 'Check entry rules');
    dotTone = 'gold';
  } else if (r.stage === 'warmup') {
    focusKicker = L('预热报名中 · 本轮预热池', 'WARM-UP OPEN · POOL');
    focusHtml = `${config.isDemo ? '8,000,000' : waiting()} <span class="focus-unit">A9</span>`;
    focusSub = L('免费报名冲榜 · 前 50 名享阶梯预热奖励', 'Free entry · Top 50 tiered rewards');
    ctaText = L('查看预热进度', 'View warm-up');
    dotTone = 'gold';
  } else if (awaitingSettle) {
    focusKicker = L('已达标门槛 · 等待结算', 'THRESHOLD MET · AWAITING SETTLE');
    focusHtml = `<span class="focus-accent-green">${passed ?? required}</span><span class="focus-slash">/</span><span class="focus-denom">${required}</span> <span class="focus-unit">${L('个达标时段', 'met')}</span>`;
    focusSub = confirmed !== null
      ? L(`已确认 ${confirmed} / 24 段 · 等待链上最终结算`, `${confirmed}/24 confirmed · awaiting settlement`)
      : L('已满足达标条件 · 等待结算确认', 'Condition met · awaiting settlement');
    ctaText = L('查看本轮进度', 'View progress');
    showSlotTrack = true;
  } else if (r.stage === 'observation') {
    focusKicker = L('24H 达标时段进度', '24H QUALIFIED SLOTS');
    focusHtml = `<span class="focus-accent-green">${passed ?? '—'}</span><span class="focus-slash">/</span><span class="focus-denom">${required}</span> <span class="focus-unit">${L('个达标时段', 'qualified')}</span>`;
    focusSub = need === null
      ? L('时段数据待核验 · 点击进入核对明细', 'Slot data pending verification')
      : L(`已确认 ${confirmed ?? '—'}/24 段 · 还差 ${need} 个达标时段`, `${confirmed ?? '—'}/24 confirmed · ${need} more needed`);
    ctaText = L('查看时段记录', 'View slot records');
    dotTone = 'cyan';
    showSlotTrack = true;
  } else if (r.stage === 'settlement_success') {
    focusKicker = L('本轮结算结果 · 已达标', 'SETTLED · PASSED');
    focusHtml = `<span class="focus-accent-green">${L('本轮达标', 'Passed')}</span> <span class="focus-unit">${passed ?? required}/${required}</span>`;
    focusSub = config.isDemo
      ? L('凭证奖励已核算，可进入明细核对并领取', 'Rewards settled; view details to claim')
      : L('可进入明细核验个人凭证结算结果', 'Check personal ticket settlement status');
    ctaText = L('查看结算明细', 'View settlement');
    showSlotTrack = true;
  } else if (r.stage === 'settlement_burn') {
    focusKicker = L('本轮结算结果 · 未达标', 'SETTLED · MISSED');
    focusHtml = `<span class="focus-accent-rose">${L('未达标 ×', 'Missed ×')}</span> <span class="focus-unit">${passed ?? 0}/${required}</span>`;
    focusSub = L('未满足 16/24 达标门槛 · 按规则处理本金与奖池', 'Below 16/24 threshold · processed per v15 rules');
    ctaText = L('查看结算明细', 'View settlement');
    dotTone = 'red';
    showSlotTrack = true;
  } else if (r.stage === 'halted') {
    focusKicker = L('安全保护 · 异常中止', 'SAFETY HALT');
    focusHtml = `<span class="focus-accent-gold">${L('异常中止 · 退回本金', 'Aborted · Refund')}</span>`;
    focusSub = L('触发预言机安全保护 · 参与本金按规则原路退回', 'Oracle halt triggered · principal refunded');
    ctaText = L('查看保护说明', 'View halt status');
    dotTone = 'gold';
  } else {
    focusKicker = L('当前轮次状态', 'ROUND STATUS');
    focusHtml = `<span>${waiting()}</span>`;
    focusSub = L('正在等待服务端同步轮次信息', 'Awaiting server round sync');
  }

  const gates = [
    ['/internal/market',          'market', L('宝箱商城', 'Chest Mall'),  L('0.99 GRAM起', 'From 0.99 GRAM')],
    ['/internal/market?tab=free', 'trophy', L('免费宝箱', 'Free Chests'), L('助力领 A9', 'Assist A9')],
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
  return `<section class="wv-hero game-city anim-page-enter">
    ${renderPendingVaultBanner(pred, r)}
    ${renderEarlyBirdBanner(r)}

    <div class="diorama-stage city-hub-stage${isRedAlert ? ' alert-red-mode' : ''}" data-mood="${sandtableMood}">
      ${renderCitySandtable(sandtableMood)}

      <div class="city-hub-top">
        <div class="city-round-pill">
          <span class="live-dot ${dotTone}"></span>
          <span>${L('第', 'R')} ${r.currentRound ?? '—'} ${L('轮', '')} · ${stageLabel(r.stage)}</span>
          ${isMatchPoint ? `<span class="chip chip-gold" style="min-height:18px;font-size:9.5px;padding:0 6px;">${L('赛点', 'MATCH PT')}</span>` : ''}
        </div>
        <div class="city-cd-badge" title="${L('当前阶段剩余时间', 'Time remaining')}">
          ${icon('clock', 12)}
          <span id="round-cd" class="mono">${cdText}</span>
        </div>
      </div>

      <div class="city-focus-block">
        <div class="city-focus-copy">
          <span class="diorama-kicker">${focusKicker}</span>
          <div class="city-focus-val">${focusHtml}</div>
          <p class="city-focus-sub">${focusSub}</p>
        </div>
        <img class="city-hub-emblem" src="./assets/paper-craft/tower.png" alt="" aria-hidden="true">
      </div>

      ${showSlotTrack ? `
        <a class="city-slot-strip${isMatchPoint ? ' is-matchpoint' : ''}" href="#/observation/records">
          <div class="city-slot-dots" aria-label="${L('24H 时段进度', '24H slot progress')}">${slotDots}</div>
          <div class="row-between city-price-inline">
            <span>${L('目标', 'Target')} <b class="mono">${priceOrDash(r.targetPrice)}</b></span>
            <span class="row-start" style="gap:6px;">
              <span>${L('均价', 'TWAP')} <b class="mono text-green" id="live-twap-val">${priceOrDash(r.twap24h ?? r.livePrice)}</b></span>
              ${history.length > 1 ? renderLiveSparkline(history) : ''}
            </span>
          </div>
        </a>
      ` : `
        <div class="city-price-strip">
          <div class="city-price-cell">
            <span class="num-xs text-muted">${L('目标底价', 'Target Price')}</span>
            <strong class="mono">${priceOrDash(r.targetPrice)}</strong>
          </div>
          <div class="city-price-cell live">
            <div class="city-price-live-copy">
              <span class="num-xs text-muted">${L('当前判定均价', 'Judge TWAP')}</span>
              <strong class="mono text-green" id="live-twap-val">${priceOrDash(r.twap24h ?? r.livePrice)}</strong>
            </div>
            ${history.length > 1 ? renderLiveSparkline(history) : ''}
          </div>
        </div>
      `}

      <a class="game-play" href="#/round">${ctaText} ›</a>

      <div class="city-pool-summary">
        <span>${poolSummary}</span>
        <span>${L('早鸟 2.0× · 上限 15×', 'Early 2.0× · 15× Cap')}</span>
      </div>
    </div>

    <nav class="game-gates">
      ${gates.map(([path, asset, label, sub]) => `
        <a href="#${path}">
          <img src="./assets/paper-craft/${asset}.png" alt="">
          <span>${label}</span>
          <small>${sub}</small>
        </a>
      `).join('')}
    </nav>

    <div class="section-kicker">${L('24H 预言对抗与协议生态', '24H PREDICTION & PROTOCOL')}</div>

    <div class="card clickable city-pred-card${isRedAlert ? ' alert-red-mode' : ''}" id="city-pred-jump" role="button" tabindex="0">
      <div class="row-between">
        <div class="row-start">
          <span class="chip ${isRedAlert ? 'chip-red' : 'chip-green'}">${isRedAlert ? L('最后 4H 红警', '4H RED ALERT') : L('0 GRAM 免费猜', '0 GRAM Free')}</span>
          <strong class="city-pred-title">${L('24H 预言擂台', '24H Prediction Arena')}</strong>
        </div>
        <span class="city-pred-go">${L('立即站队', 'Pick Side')} ›</span>
      </div>
      <p class="city-pred-desc">${L('0 GRAM 站队通关 PASS 或销毁 BURN，新人首轮参与保底 500 A9 待解锁体验金。', 'Call PASS or BURN for 0 GRAM. First-round rookies get a 500 A9 vault floor.')}</p>
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
    </div>

    <div class="city-meta-grid">
      <a class="city-meta-tile" href="#/rewards">
        <small>${L('全网累计达标', 'Global Wins')}</small>
        <strong>${wins == null ? waiting() : `${wins} ${L('轮', 'wins')}`}</strong>
        <span>${unlockPct ? L(`当前即时解锁 ${unlockPct}`, `${unlockPct} instant`) : L('查看连胜解锁', 'Vesting tiers')} ›</span>
      </a>
      <a class="city-meta-tile" href="#/team/invite">
        <small>${L('邀友奖励体系', 'Invite Rewards')}</small>
        <strong>12% + 18%</strong>
        <span>${L('生成邀请海报', 'Invite poster')} ›</span>
      </a>
    </div>

    <details class="handbook-collapse" id="a9-handbook-collapse">
      <summary class="handbook-collapse-summary">
        <span class="row-start" style="gap:6px;">
          ${icon('checkCircle', 14, 'text-green')}
          <strong>${L('日常集章手账', 'Daily Stamp Logbook')}</strong>
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
        showToast(L(`已盖章 · +${res?.expAwarded || 0} EXP（手账成长数据）`, `Stamped · +${res?.expAwarded || 0} EXP`));
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

/** 渲染主城并绑定手账集章与 24H 竞猜直达交互 */
export function renderCity(root, navigate) {
  if (config.isDemo && !store.state.progression.loaded) {
    const uid = getEffectiveUserId(store.state.user);
    const data = demoProgressionInitSnapshot(uid, store.state.round.currentRound || 3);
    Object.assign(store.state.progression, data, { loaded: true, error: false });
  }
  root.innerHTML = city();
  bindHandbookStampEvents(root, navigate);
  syncProgressionState(root, navigate);

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

/** 计算演示模式当前图鉴已解锁阶位（区分互动解锁 vs A9 市值达标，绝不伪造链上数据） */
function computeDemoUnlockedTiers(series = 'activity') {
  const st = store.state;
  if (series === 'wealth') {
    const holdingUsd = getDemoA9HoldingUsd();
    const unlocked = new Set();
    WEALTH_TIER_USD.forEach((threshold, i) => {
      if (holdingUsd >= threshold) unlocked.add(i + 1);
    });
    return unlocked;
  }
  const unlocked = new Set([1, 2, 3]);
  const stamps = Number(st.progression?.totalStamps || 0);
  const level = Number(st.progression?.level || 1);
  if ((st.market?.records || []).length > 0) unlocked.add(4);
  if ((st.certificates || []).length > 0) unlocked.add(5);
  if (st.team?.role !== 'none' || stamps >= 6) unlocked.add(6);
  if (Number(st.round?.successCount || 0) >= 3 || stamps >= 6) unlocked.add(7);
  if (level >= 3) unlocked.add(8);
  if (unlocked.size >= 8) unlocked.add(9);
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

/** 身份图鉴（#/gallery）：双轨 18 阶 Boxheads 收集册 + 1 对 1 精装卡背 3D 翻转 + 卡背导出与社交分享 */
export function gallery(root, navigate, param) {
  const parsed = parseGalleryParam(param);
  activeGallerySeries = parsed.series === 'wealth' ? 'wealth' : 'activity';
  const selected = parsed.tier;
  const seriesMeta = BOXHEADS_SERIES[activeGallerySeries];
  const item = getBoxheadItem(selected, activeGallerySeries);
  const demoUnlocked = config.isDemo ? computeDemoUnlockedTiers(activeGallerySeries) : new Set();
  const isSelectedUnlocked = config.isDemo ? demoUnlocked.has(selected) : false;
  const holdingUsd = config.isDemo ? getDemoA9HoldingUsd() : null;
  const wealthReqUsd = WEALTH_TIER_USD[selected - 1];
  const code = seriesMeta.code;

  const unlockText = activeGallerySeries === 'wealth'
    ? (config.isDemo
        ? L(`A9 持仓市值门槛 $${formatNum(wealthReqUsd)}（演示持仓约 $${formatNum(holdingUsd)}）`, `A9 holding threshold $${formatNum(wealthReqUsd)} (Demo ~$${formatNum(holdingUsd)})`)
        : L('仅当持有 A9 代币市值达到该阶梯后解锁 · 请连接钱包核验', 'Unlocked only when held A9 value reaches tier · Connect wallet to verify'))
    : L(item.hintZh, item.hintEn);

  root.innerHTML =
    `<div class="seg-tabs" id="boxhead-series-tabs" style="margin-bottom:2px;">
      <button class="seg-tab ${activeGallerySeries === 'activity' ? 'active' : ''}" data-boxhead-series="activity" type="button">${L('互动解锁 (9)', 'Activity (9)')}</button>
      <button class="seg-tab ${activeGallerySeries === 'wealth' ? 'active' : ''}" data-boxhead-series="wealth" type="button">${L('A9 市值达标 (9)', 'A9 Wealth (9)')}</button>
    </div>` +
    `<section class="wv-hero wv-gallery-hero ${selected >= 7 ? 'diorama-stage prism' : 'diorama-stage'} series-${activeGallerySeries}">
      ${DIORAMA_BACKDROP}
      <div class="boxhead-stage-meta">
        <span class="chip ${activeGallerySeries === 'wealth' ? 'chip-gold' : 'chip-cyan'}">${L(seriesMeta.badgeZh, seriesMeta.badgeEn)}</span>
        <span class="chip chip-muted mono">${code} 0${selected} · ${item.rarity}</span>
      </div>
      <div class="boxhead-flip-scene" id="gallery-standee-stage">
        <div class="speech-bubble hidden" id="gallery-speech-bubble" role="status">“${L(item.voiceZh, item.voiceEn)}”</div>
        <div class="boxhead-flip-card" id="boxhead-flip-card">
          <div class="boxhead-face front series-${activeGallerySeries}">
            ${activeGallerySeries === 'wealth' ? '<div class="standee-slot" aria-hidden="true"></div>' : ''}
            <img class="wv-person${config.isDemo && !isSelectedUnlocked ? ' is-locked-preview' : ''}" id="boxhead-avatar-img" src="${item.avatar}" alt="${code} 0${selected}">
          </div>
          <div class="boxhead-face back">
            <img class="boxhead-card-img" id="boxhead-backing-img" src="${characterCardArt(selected, activeGallerySeries)}" alt="${code} 0${selected} Backing Card">
          </div>
        </div>
      </div>
      <button type="button" class="boxhead-flip-btn" id="btn-flip-boxhead" aria-pressed="false">
        ${icon('refresh', 13)} <span id="btn-flip-label">${L('翻转查看精装卡背', 'Flip to Backing Card')}</span>
      </button>
      <div class="wv-copy">
        <small>${config.isDemo ? (isSelectedUnlocked ? L('已点亮收藏 · 轻点形象听台词', 'Collected · Tap avatar for quote') : L('未解锁槽位 · 预览卡背与形象', 'Locked slot · Preview only')) : L('链上核验待开启 · 形象与卡背预览', 'On-chain pending · Preview')}</small>
        <h1>${L(item.nameZh, item.nameEn)}</h1>
        <p>${L(item.traitZh, item.traitEn)}</p>
        <div class="num-xs ${isSelectedUnlocked ? 'text-green' : 'text-gold'}" style="margin-top:4px;font-weight:800;">${unlockText}</div>
      </div>
    </section>` +
    `<div class="row-between" style="padding:2px 2px 0;">
      <span class="section-kicker" style="padding:0;">${activeGallerySeries === 'wealth' ? L('WLT 01–09 持仓大佬卡册', 'WLT 01–09 WEALTH ALBUM') : L('ACT 01–09 平台互动卡册', 'ACT 01–09 ACTIVITY ALBUM')}</span>
      <span class="chip ${config.isDemo ? 'chip-gold' : 'chip-muted'}" style="min-height:20px;font-size:10px;">${config.isDemo ? L(`演示已集 ${demoUnlocked.size} / 9`, `Demo ${demoUnlocked.size} / 9`) : L('待链上核验', 'Awaiting verify')}</span>
    </div>` +
    `<nav class="wv-gallery series-${activeGallerySeries}">${seriesMeta.items.map((it) => {
      const idx = it.tier;
      const locked = config.isDemo ? !demoUnlocked.has(idx) : true;
      return `<a href="#/gallery/${it.id}" class="${locked ? 'is-locked' : ''}" aria-current="${idx === selected ? 'true' : 'false'}">
        <span class="gallery-slot-badge">${locked ? (config.isDemo ? L('未解锁', 'Lock') : L('待验', 'TBD')) : '✓'}</span>
        ${portrait(idx, activeGallerySeries)}
        <b>${code} 0${idx}</b>${L(it.nameZh, it.nameEn)}
      </a>`;
    }).join('')}</nav>` +
    `<div class="card num-xs text-sec">${L(seriesMeta.descZh, seriesMeta.descEn)}</div>` +
    `<div class="col-gap" style="gap:8px;">
      <button class="btn btn-primary" id="wv-export" type="button">${icon('download', 15)} ${L('保存精装卡背 PNG', 'Save Backing Card PNG')}</button>
      <div class="grid-2">
        <button class="btn btn-secondary" id="wv-share-tg" type="button">${icon('send', 14)} ${L('分享至 TG', 'Share TG')}</button>
        <button class="btn btn-secondary" id="wv-share-x" type="button">${icon('xBrand', 14)} ${L('分享至 X', 'Share X')}</button>
      </div>
    </div>`;
  root.style.setProperty('--wv-hue', (selected - 1) * 19 + 'deg');

  // 双系列切换（互动解锁 vs A9 市值达标）
  root.querySelectorAll('[data-boxhead-series]').forEach((btn) => {
    btn.onclick = () => {
      const nextSeries = btn.dataset.boxheadSeries;
      if (nextSeries === activeGallerySeries) return;
      A9Haptic.light();
      A9Audio.tick();
      activeGallerySeries = nextSeries;
      const nextPrefix = nextSeries === 'wealth' ? 'wlt' : 'act';
      navigate(`/gallery/${nextPrefix}-0${selected}`);
    };
  });

  // 3D 翻卡（形象 <-> 1对1精装卡背）
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
    if (flipLabel) {
      flipLabel.textContent = isFlipped
        ? L('翻回纸箱人形象', 'Flip to Boxhead Avatar')
        : L('翻转查看精装卡背', 'Flip to Backing Card');
    }
  };
  if (flipBtn) flipBtn.onclick = () => setFlipped(!isFlipped);
  const backFace = root.querySelector('.boxhead-face.back');
  if (backFace) backFace.onclick = () => setFlipped(false);

  // 正面形象轻点触发专属语音气泡与纸屑
  const standee = root.querySelector('#boxhead-avatar-img');
  const bubble = root.querySelector('#gallery-speech-bubble');
  let bubbleTimer = 0;
  if (standee) {
    standee.onclick = () => {
      if (isFlipped) return;
      A9Haptic.light();
      A9Audio.flip();
      burstParticles(standee);
      standee.classList.remove('paper-flipping');
      void standee.offsetWidth;
      standee.classList.add('paper-flipping');
      if (bubble) {
        clearTimeout(bubbleTimer);
        bubble.classList.remove('hidden');
        bubble.style.animation = 'none';
        void bubble.offsetWidth;
        bubble.style.animation = '';
        bubbleTimer = setTimeout(() => {
          if (bubble.isConnected) bubble.classList.add('hidden');
        }, 2800);
      }
    };
  }

  if (config.isDemo) {
    const preview = document.createElement('button');
    preview.className = 'btn btn-secondary';
    preview.type = 'button';
    preview.textContent = L('设为我的档案头像（演示预览）', 'Set as My Profile Avatar (Demo)');
    preview.onclick = () => {
      A9Haptic.success();
      A9Audio.flip();
      store.update((state) => {
        state.user.previewTier = selected;
        state.user.previewSeries = activeGallerySeries;
      });
      navigate('/profile');
    };
    root.append(preview);
  }

  // 社交分享（TG & X）
  const shareLink = buildStartAppLink('gallery', item.id);
  const shareCopy = L(
    `我在 A9 BOXHEADS ARCHIVE 收藏了【${code} 0${selected} · ${item.nameZh}】(${item.rarity}) 精装卡背！来 A9 广场集章闯关解锁你的专属抽象纸箱人：`,
    `Collected [${code} 0${selected} · ${item.nameEn}] (${item.rarity}) backing card in A9 BOXHEADS ARCHIVE! Unlock yours in A9 Plaza:`
  );
  const tgBtn = root.querySelector('#wv-share-tg');
  if (tgBtn) {
    tgBtn.onclick = () => {
      A9Haptic.light();
      A9TMA.shareInvite(shareLink, shareCopy);
      showToast(L('已调起 Telegram 分享卡背', 'Opened Telegram share'));
    };
  }
  const xBtn = root.querySelector('#wv-share-x');
  if (xBtn) {
    xBtn.onclick = () => {
      A9Haptic.light();
      const intentUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(shareCopy)}&url=${encodeURIComponent(shareLink)}`;
      A9TMA.openExternalLink(intentUrl);
      showToast(L('已打开 X 分享页面', 'Opened X share'));
    };
  }

  // 保存精装卡背 PNG（720×960 典藏分享图，以 1 对 1 专属卡背为核心主体）
  root.querySelector('#wv-export').onclick = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 960;
    const ctx = canvas.getContext('2d');
    const cardImg = new Image();
    cardImg.src = characterCardArt(selected, activeGallerySeries);
    await cardImg.decode().catch(() => {});

    const isDarkCard = activeGallerySeries === 'wealth';
    ctx.fillStyle = isDarkCard ? '#161619' : '#F6F6F8';
    ctx.fillRect(0, 0, 720, 960);

    ctx.fillStyle = isDarkCard ? '#262832' : '#D1D4DF';
    ctx.beginPath();
    ctx.roundRect(36, 44, 648, 876, 34);
    ctx.fill();
    ctx.fillStyle = isDarkCard ? '#1E2028' : '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(36, 36, 648, 876, 34);
    ctx.fill();

    ctx.fillStyle = '#A8000E';
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

    ctx.fillStyle = isDarkCard ? '#D6D8E1' : '#565B6B';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(`BOXHEADS ARCHIVE S01 · ${code} 0${selected} · ${item.rarity}`, 178, 100);

    if (cardImg.complete && cardImg.naturalWidth) {
      const maxW = 540;
      const maxH = 610;
      const scale = Math.min(maxW / cardImg.naturalWidth, maxH / cardImg.naturalHeight);
      const dw = cardImg.naturalWidth * scale;
      const dh = cardImg.naturalHeight * scale;
      const dx = (720 - dw) / 2;
      const dy = 148 + (maxH - dh) / 2;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 12;
      ctx.drawImage(cardImg, dx, dy, dw, dh);
      ctx.restore();
    }

    ctx.fillStyle = isDarkCard ? '#F5F6FA' : '#1B1D24';
    ctx.font = 'bold 42px sans-serif';
    ctx.fillText(`${code} 0${selected} · ${L(item.nameZh, item.nameEn)}`, 72, 822);
    ctx.fillStyle = isDarkCard ? '#9BA0B2' : '#565B6B';
    ctx.font = '22px sans-serif';
    ctx.fillText(
      activeGallerySeries === 'wealth'
        ? L('A9 市值达标专属精装卡背 · BOXHEADS ARCHIVE', 'A9 Wealth Tier Backing Card · BOXHEADS ARCHIVE')
        : L('A9 平台互动专属精装卡背 · BOXHEADS ARCHIVE', 'A9 Activity Tier Backing Card · BOXHEADS ARCHIVE'),
      72,
      868,
    );

    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `A9-boxhead-${item.id}-card.png`;
    a.click();
    A9Haptic.success();
    showToast(L('精装卡背 PNG 已保存，可直接分享至社交平台', 'Backing card PNG saved for sharing'));
  };
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
          <img src="./assets/paper-craft/vault.png" alt="" style="width:54px;height:54px;filter:var(--paper-cut-shadow);flex-shrink:0;">
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
        <p class="num-xs text-muted" style="margin:10px 0 0;line-height:1.5;">${L('失败轮可能按规则销毁此前未解锁份额；轮次持续开放至奖池耗尽。', 'Failure can burn prior locked shares. Rounds continue until pool exhaustion.')}</p>
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
  panel.className = 'card col-gap';
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
        ['/records', '闯关战绩', 'Quest History'],
        ['/proof', '闯关凭证', 'Quest Pass'],
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
