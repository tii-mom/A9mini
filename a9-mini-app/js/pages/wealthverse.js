import { fetchUserPortfolio } from '../data.js';
import { L } from '../i18n.js';
import { config } from '../config.js';
import { store } from '../store.js';
import { icon } from '../icons.js';
import { A9Haptic } from '../tma.js';
import { A9Audio } from '../audio.js';
import { burstParticles, formatNum, formatTimer, renderLiveSparkline } from '../components.js';
import { DIORAMA_BACKDROP, CITY_SANDTABLE_BACKDROP } from '../paper-art.js';
import { tiers, characterArt } from '../wealth-art.js';

const link = (path, label, glyph) =>
  `<a href="#${path}">${icon(glyph, 18)}${label}</a>`;
const waiting = () => L('等待核验', 'Awaiting verification');

function portrait(n) {
  return `<img class="wv-person" src="${characterArt(n)}" alt="A${n}">`;
}

function hero(title, tag, content = '', figure = '', cls = '') {
  return `<section class="wv-hero ${cls}"><div class="wv-scenery"></div>${figure}<div class="wv-copy"><small>${tag}</small><h1>${title}</h1>${content}</div></section>`;
}

export function stageLabel(stage) {
  const stages = {
    warmup: ['预热', 'Warm-up'],
    participation: ['参与中', 'Entry open'],
    observation: ['观察中', 'Observing'],
    settlement_success: ['已结算 · 达标', 'Settled · passed'],
    settlement_burn: ['已结算 · 未达标', 'Settled · missed'],
    halted: ['技术中止', 'Aborted'],
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

/**
 * 个人身份立体书展示台（供「背包 / 我的」页面顶部使用）
 * - 完整保留方案 A 三层景深立体剧场、厚卡纸立牌插槽与右上角微翘贴纸「身份图鉴 ›」
 * - 演示模式支持轻点立牌 360° 翻身切换 A1–A9 试穿；实时模式严格标注持仓待核验
 */
export function identityStage({ modePill = '', walletTag = '' } = {}) {
  const tier = store.state.user.previewTier || 1;
  const shownTier = config.isDemo ? tier : 1;
  const [zh, en, traitZh, traitEn] = tiers[shownTier - 1];
  const isPrism = config.isDemo && shownTier >= 7;
  const heading = config.isDemo ? `A${shownTier} · ${L(zh, en)}` : L('身份待核验', 'Identity pending');
  const subtitle = config.isDemo
    ? `${L(traitZh, traitEn)} · ${L('轻点立牌翻身换装', 'Tap to flip')}`
    : L('连接钱包后核验持仓阶位', 'Connect wallet to verify tier');

  return `<section class="wv-hero profile-identity-stage">
    <div class="diorama-stage ${isPrism ? 'prism' : ''}">
      ${DIORAMA_BACKDROP}
      <header class="edition-heading">
        <div>
          <span class="diorama-kicker">MY IDENTITY · ${config.isDemo ? `STICKER 0${shownTier}` : 'ON-CHAIN'}</span>
          <h1>${heading}</h1>
        </div>
        <a class="peel-badge" href="#/gallery">${L('身份图鉴', 'Gallery')} ›</a>
      </header>
      <div class="edition-art ${config.isDemo ? '' : 'unverified-standee'}" id="identity-standee-stage">
        <div class="standee-slot" aria-hidden="true"></div>
        ${portrait(shownTier)}
        ${config.isDemo ? '' : `<span class="standee-verify-stamp">${L('示意立牌 · 阶位待核验', 'Preview · tier pending')}</span>`}
      </div>
      <div class="edition-caption">
        <div class="identity-caption-copy">
          <b>${walletTag || (config.isDemo ? L('演示试穿形态', 'Demo preview') : L('只读核验视图', 'Read-only view'))}</b>
          <span>${subtitle}</span>
        </div>
        ${modePill || ''}
      </div>
    </div>
  </section>`;
}

/** 为背包身份立体台绑定 360° 纸片翻身试穿交互（仅演示模式生效） */
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
 * 方案 A · 主城首屏立体书态势沙盘（从项目转化与用户心智重构）
 * 1. 核心态势沙盘：轮次阶段 + 实时倒计时 + 奖池总额 + 目标价/判定均价/迷你走势 + 24H 微型打孔战况轨 + 唯一朱红主 CTA
 * 2. 四宫格厚卡纸生态入口：商行 / 奖励宝库 / 荣誉排行 / 玩法规则（附清晰业务微副标）
 * 3. 高转化副卡：0 TON 24H 生死预言速览 + 全网解锁阶段 / 邀友 12% 双格卡片
 */
export function city() {
  const r = store.state.round;
  const pred = store.state.prediction;
  const required = Number(r.minQualifiedCandles) || 16;
  const passed = r.qualifiedCandles ?? null;
  const need = passed === null ? null : Math.max(0, required - passed);
  const wins = r.successCount;
  const unlockPct = unlockPctByWins(wins);
  const candleSeries = Array.isArray(r.candles)
    ? r.candles.map((c) => Number(c?.p)).filter((v) => Number.isFinite(v) && v > 0)
    : [];
  const history = Array.isArray(r.priceHistory) && r.priceHistory.length > 1
    ? r.priceHistory
    : (candleSeries.length > 1 ? candleSeries.slice(-12) : []);

  const ctaByStage = {
    warmup: L('进入轮次挑战 · 免费报名预热', 'Enter Challenge · Join Warm-Up'),
    participation: L('进入轮次挑战 · 抢占早鸟权重', 'Enter Challenge · Claim Early Weight'),
    observation: L('进入轮次挑战 · 追踪 24H 战况', 'Enter Challenge · Track 24H Battle'),
    settlement_success: L('进入轮次挑战 · 领取本轮奖励', 'Enter Challenge · Claim Rewards'),
    settlement_burn: L('进入轮次挑战 · 查看销毁存证', 'Enter Challenge · View Burn Proof'),
    halted: L('进入轮次挑战 · 查看保护说明', 'Enter Challenge · View Status'),
  };
  const ctaText = ctaByStage[r.stage] || L('进入轮次挑战', 'Enter challenge');

  // 24 颗微型橡皮圆点战况轨道（反映真实 candles 状态）
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

  const slotHint = passed === null
    ? L('时段数据待核验', 'Slots pending')
    : need === 0 && r.stage === 'observation'
      ? L('已达门槛 · 等待结算', 'Threshold met · awaiting settle')
      : need === 0
        ? L('已达标完成', 'Qualified')
        : L(`距达标还差 ${need} 段`, `${need} more to pass`);

  const poolDisplay = r.rewardBudgetA9 === null || r.rewardBudgetA9 === undefined
    ? `<span class="city-pool-pending">${waiting()}</span>`
    : `${formatNum(r.rewardBudgetA9)} <span class="city-pool-unit">A9</span>`;

  const cdText = r.countdownSec === null || r.countdownSec === undefined
    ? '—'
    : formatTimer(r.countdownSec);

  const gates = [
    ['/internal/market', 'market', L('主城商行', 'Market'),   L('固定兑换', 'Swap A9')],
    ['/rewards',         'vault',  L('奖励宝库', 'Rewards'),  L('阶梯解锁', 'Vesting')],
    ['/leaderboard',     'trophy', L('荣誉排行', 'Rankings'), L('全网榜单', 'Top Ranks')],
    ['/rules',           'rules',  L('玩法规则', 'Rules'),    L('3 步看懂', '3-Step Guide')],
  ];

  const showPredRatio = config.isDemo || (pred?.loaded && Number(pred.total) > 0);
  const passPct = Number.isFinite(Number(pred?.passPct)) ? Number(pred.passPct) : 64;
  const burnPct = Number.isFinite(Number(pred?.burnPct)) ? Number(pred.burnPct) : 36;

  return `<section class="wv-hero game-city anim-page-enter">
    <div class="diorama-stage city-hub-stage">
      ${CITY_SANDTABLE_BACKDROP}

      <div class="city-hub-top">
        <div class="city-round-pill">
          <span class="live-dot ${r.stage === 'settlement_burn' ? 'red' : r.stage === 'halted' ? 'amber' : ''}"></span>
          <span>${L('第', 'R')} ${r.currentRound ?? '—'} ${L('轮', '')} · ${stageLabel(r.stage)}</span>
        </div>
        <div class="city-cd-badge" title="${L('当前阶段剩余时间', 'Time remaining')}">
          ${icon('clock', 12)}
          <span id="round-cd" class="mono">${cdText}</span>
        </div>
      </div>

      <div class="city-pool-hero">
        <div class="city-pool-copy">
          <span class="diorama-kicker">${L('本轮用户奖励池', 'ROUND REWARD POOL')}</span>
          <div class="city-pool-val">${poolDisplay}</div>
          <div class="city-pool-meta">
            <span class="chip chip-gold">${L('早鸟最高 2.0×', 'Early 2.0×')}</span>
            <span class="chip chip-muted">${L('单轮上限 15×', '15× Cap')}</span>
          </div>
        </div>
        <img class="city-hub-emblem" src="./assets/paper-craft/tower.svg" alt="" aria-hidden="true">
      </div>

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

      <a class="city-slot-strip" href="#/observation/records">
        <div class="row-between">
          <span class="city-slot-title"><b>${passed ?? '—'} / ${required}</b> ${L('达标时段', 'qualified slots')}</span>
          <span class="city-slot-hint">${slotHint} ›</span>
        </div>
        <div class="city-slot-dots" aria-label="${L('24H 时段进度', '24H slot progress')}">${slotDots}</div>
      </a>

      <a class="game-play" href="#/round">${ctaText} ›</a>
    </div>

    <nav class="game-gates">
      ${gates.map(([path, asset, label, sub]) => `
        <a href="#${path}">
          <img src="./assets/paper-craft/${asset}.svg" alt="">
          <span>${label}</span>
          <small>${sub}</small>
        </a>
      `).join('')}
    </nav>

    <div class="card city-pred-card" id="city-pred-jump" role="button" tabindex="0">
      <div class="row-between">
        <div class="row-start">
          <span class="chip chip-green">${L('0 GRAM 参战', '0 GRAM')}</span>
          <strong class="city-pred-title">${L('24H 生死预言局', '24H Prediction Arena')}</strong>
        </div>
        <span class="city-pred-go">${L('去站队', 'Join')} ›</span>
      </div>
      <p class="city-pred-desc">${L('免费预测本轮达标或销毁，命中可赢取 A9 加成补贴券。', 'Predict PASS or BURN for free and win A9 bonus vouchers.')}</p>
      ${showPredRatio ? `
        <div class="city-pred-bar-wrap">
          <div class="row-between num-xs">
            <span class="text-green">PASS ${passPct}%</span>
            <span class="text-red">BURN ${burnPct}%</span>
          </div>
          <div class="pred-split-bar" style="height:7px;margin-top:4px;">
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
        <span>${unlockPct ? L(`当前即时解锁 ${unlockPct}`, `${unlockPct} instant unlock`) : L('查看三阶解锁规则', 'View vesting tiers')} ›</span>
      </a>
      <a class="city-meta-tile" href="#/team/invite">
        <small>${L('推广返佣体系', 'Referral Bonus')}</small>
        <strong>12% + 18%</strong>
        <span>${L('生成专属邀请海报', 'Create invite poster')} ›</span>
      </a>
    </div>
  </section>`;
}

/** 渲染主城并绑定 24H 预言直达交互 */
export function renderCity(root, navigate) {
  root.innerHTML = city();
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

export function gallery(root, navigate, param) {
  const n = Number(param) || 1;
  const selected = n >= 1 && n <= 9 && Number.isInteger(n) ? n : 1;
  const [zh, en, detail, desc] = tiers[selected - 1];
  root.innerHTML =
    `<section class="wv-hero wv-gallery-hero ${selected >= 7 ? 'diorama-stage prism' : 'diorama-stage'}">
      ${DIORAMA_BACKDROP}
      <div class="edition-art" id="gallery-standee-stage" style="width:100%;height:178px;margin-bottom:2px;">
        <div class="standee-slot" aria-hidden="true"></div>
        ${portrait(selected)}
      </div>
      <div class="wv-copy">
        <small>A${selected} / ${L('角色预览', 'Character preview')}</small>
        <h1>${L(zh, en)}</h1>
        <p>${L(detail, desc)}</p>
      </div>
    </section>` +
    `<nav class="wv-gallery">${tiers.map(([a, b], i) => `<a href="#/gallery/${i + 1}" aria-current="${i + 1 === selected ? 'true' : 'false'}">${portrait(i + 1)}<b>A${i + 1}</b>${L(a, b)}</a>`).join('')}</nav><div class="card">${L('当前身份与下一阶条件待核验。称谓为设计预览。', 'Identity and next-tier conditions await verification. Titles are previews.')}</div><button class="btn btn-primary" id="wv-export">${L('保存角色预览卡', 'Save preview card')}</button>`;
  root.style.setProperty('--wv-hue', (selected - 1) * 19 + 'deg');

  const standee = root.querySelector('#gallery-standee-stage .wv-person');
  if (standee) {
    standee.onclick = () => {
      A9Haptic.light();
      A9Audio.flip();
      burstParticles(standee);
      standee.classList.remove('paper-flipping');
      void standee.offsetWidth;
      standee.classList.add('paper-flipping');
    };
  }

  if (config.isDemo) {
    const preview = document.createElement('button');
    preview.className = 'btn btn-secondary';
    preview.textContent = L('在背包舞台试穿', 'Preview in Vault stage');
    preview.onclick = () => {
      A9Haptic.light();
      A9Audio.flip();
      store.update((state) => {
        state.user.previewTier = selected;
      });
      navigate('/profile');
    };
    root.append(preview);
  }

  root.querySelector('#wv-export').onclick = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 960;
    const ctx = canvas.getContext('2d');
    const img = root.querySelector('.wv-hero .wv-person');
    if (img && !img.complete) await img.decode().catch(() => {});

    // 方案 A 暖棉纸立体书卡片导出风格
    ctx.fillStyle = '#F5F0E6';
    ctx.fillRect(0, 0, 720, 960);

    ctx.fillStyle = '#D6CBB9';
    ctx.beginPath();
    ctx.roundRect(42, 48, 636, 868, 36);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(42, 38, 636, 868, 36);
    ctx.fill();

    ctx.save();
    ctx.strokeStyle = 'rgba(178, 162, 138, 0.55)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([9, 8]);
    ctx.beginPath();
    ctx.roundRect(58, 54, 604, 836, 26);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#B82D25';
    ctx.beginPath();
    ctx.roundRect(82, 84, 96, 54, 16);
    ctx.fill();
    ctx.fillStyle = '#E8453C';
    ctx.beginPath();
    ctx.roundRect(82, 78, 96, 54, 16);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('A9', 108, 116);

    ctx.fillStyle = '#6A615B';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(`STICKER 0${selected} · PAPER CRAFT`, 198, 114);

    ctx.fillStyle = '#ECE6DA';
    ctx.beginPath();
    ctx.ellipse(360, 686, 170, 26, 0, 0, Math.PI * 2);
    ctx.fill();

    if (img?.complete && img.naturalWidth) {
      const scale = Math.min(480 / img.naturalWidth, 500 / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      ctx.drawImage(img, (720 - dw) / 2, 178 + (500 - dh) / 2, dw, dh);
    }

    ctx.fillStyle = '#2B2523';
    ctx.font = 'bold 50px sans-serif';
    ctx.fillText(`A${selected} · ${L(zh, en)}`, 82, 782);
    ctx.fillStyle = '#6A615B';
    ctx.font = '26px sans-serif';
    ctx.fillText(
      L('A9 财富进化世界 · 暖棉纸典藏卡', 'A9 Wealthverse · Paper Craft Card'),
      82,
      838,
    );

    const a = document.createElement('a');
    a.href = canvas.toDataURL();
    a.download = `A9-preview-${selected}.png`;
    a.click();
  };
}

export function rewards(root) {
  const n = store.state.round.successCount;
  const u = store.state.user;
  const amounts = [
    [
      L('已解锁待领取', 'Unlocked and claimable'),
      config.isDemo ? u.a9Claimable : null,
    ],
    [L('待解锁', 'Locked'), config.isDemo ? u.a9Locked : null],
    [L('已销毁', 'Burned'), null],
  ];
  const balances = amounts
    .map(
      ([label, amount]) =>
        `<div class="list-row"><span>${label}</span><b>${amount == null ? waiting() : amount.toLocaleString('en-US') + ' A9'}</b></div>`,
    )
    .join('');

  const crystals = [
    ['crystal-basic',     L('初阶', 'Basic')],
    ['crystal-starlight', L('星辉', 'Starlight')],
    ['crystal-legendary', L('传说', 'Legendary')],
  ];
  const crystalPreview = `<section class="card"><h2 class="card-title">${L('水晶美术预览', 'Crystal art preview')}</h2>
    <div class="crystal-preview">${crystals.map(([id, name]) => `<figure><img src="./assets/paper-craft/${id}.svg" alt="" loading="lazy"><figcaption>${name}</figcaption></figure>`).join('')}</div></section>`;
  root.innerHTML =
    hero(
      L('奖励宝库', 'Reward Vault'),
      'A9 / TREASURY',
      `<p>${L('全网累计成功', 'Global successes')} · ${n ?? waiting()}</p>`,
      `<img src="./assets/paper-craft/vault.svg" alt="" style="width:76px;height:76px;filter:var(--paper-cut-shadow);">`,
      'wv-vault',
    ) +
    `<div class="wv-steps">${[
      ['1–5', '20%', '4 × 20%'],
      ['6–10', '40%', '2 × 30%'],
      ['11+', '100%', '—'],
    ]
      .map(
        ([range, pct, rest], i) =>
          `<article class="${n > 0 && (n <= 5 ? 0 : n <= 10 ? 1 : 2) === i ? 'current' : ''}"><small>${L('累计成功', 'Wins')} ${range}</small><strong>${pct}</strong>${L('即时解锁', 'Immediate')}<p>${rest}</p></article>`,
      )
      .join(
        '',
      )}</div><div class="card col-gap">${balances}</div><div class="card">${L('失败可能销毁此前未解锁的份额。轮次持续至奖池耗尽。', 'Failure can burn prior locked shares. Rounds continue until pool exhaustion.')}</div>${crystalPreview}<nav class="wv-links">${link('/claim', L('领取明细', 'Claim details'), 'unlock')}${link('/profile', L('我的资产', 'My assets'), 'wallet')}</nav>`;
}

export function tower(round) {
  const labels = {
    unknown: L('数据暂缺', 'Unavailable'),
    pending: L('未开始', 'Upcoming'),
    active: L('观察中', 'Observing'),
    pass: L('达标', 'Met'),
    miss: L('未达标', 'Missed'),
  };
  return `<section class="wv-tower"><small>24H / OBSERVATORY</small><h2>${L('财富挑战塔', 'Challenge Tower')}</h2><div class="wv-windows">${Array.from(
    { length: 24 },
    (_, i) => {
      const c = round.candles?.[i];
      const state = c?.confirmed
        ? c.bull
          ? 'pass'
          : 'miss'
        : labels[c?.status]
          ? c.status
          : 'unknown';
      return `<span data-state="${state}"><b>${String(i + 1).padStart(2, '0')}</b>${labels[state]}</span>`;
    },
  ).join(
    '',
  )}</div><p>${round.qualifiedCandles ?? '—'} / 16 · ${round.qualifiedCandles >= 16 && round.stage === 'observation' ? L('等待结算', 'Awaiting settlement') : L('达标门槛', 'Qualifying threshold')}</p></section>`;
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
        ['/team/profile', '商会资料', 'Guild profile'],
        ['/team/bind-tg', '群组绑定', 'Group binding'],
        ['/team/invite', '邀请', 'Invite'],
        ['/leaderboard', '排行榜', 'Rankings'],
      ]
    : [
        ['/claim', '领取明细', 'Claims'],
        ['/ledger', '账单', 'Ledger'],
        ['/records', '历史领取', 'History'],
        ['/proof', '质押凭证', 'Tickets'],
        ['/settings', '设置', 'Settings'],
      ];
  function show(data, state) {
    panel.replaceChildren();
    const row = (label, value) => {
      const el = document.createElement('div');
      el.className = 'list-row';
      const name = document.createElement('span');
      name.textContent = label;
      const amount = document.createElement('b');
      amount.textContent = value;
      el.append(name, amount);
      panel.append(el);
    };
    if (guild) {
      row(L('商会', 'Guild'), data?.team?.name || waiting());
      row(L('成员', 'Members'), data?.team?.memberCount ?? waiting());
      row(
        L('职位', 'Role'),
        data?.team?.captainWallet === user.address && user.address
          ? L('会长', 'Captain')
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
          L('凭证本金 · 轮次', 'Ticket principal · round') +
            ' ' +
            ticket.roundId,
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
    status.className = 'num-xs text-muted';
    status.style.margin = '2px 0';
    status.textContent = state;
    panel.append(status);
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.textContent = user.address
      ? L('重新读取', 'Read again')
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
        ? L('正在读取钱包', 'Reading wallet')
        : L('请连接钱包', 'Connect a wallet'),
    );
    if (!addr) return;
    try {
      const data = await fetchUserPortfolio(addr);
      if (
        panel.isConnected &&
        store.state.user.address === addr &&
        data.walletAddress === addr
      )
        show(data, L('来源 · 钱包只读接口', 'Source · read-only wallet API'));
    } catch {
      if (panel.isConnected && store.state.user.address === addr)
        show(null, L('钱包数据读取失败', 'Wallet read failed'));
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
  return `<section class="wv-tower"><small>A9 / ROUND ${r.currentRound ?? '—'}</small><h2>${stageLabel(r.stage)}</h2>
    <p>${L('参与窗口', 'Entry window')} · ${time(r.stakeOpenAt)} — ${time(r.stakeCloseAt)}</p>
    <p>${L('早鸟权重仅影响奖励分配份额', 'Early weights affect allocation only')} · 2.0× / 1.4× / 1.0×</p>
    <p>${L('失败将销毁该轮质押的 A9 本金。', 'Failure burns the A9 principal staked in the round.')}</p>
    <button class="btn btn-secondary" style="margin-top:12px;" disabled>${L('只读 · 质押签名已关闭', 'Read-only · staking disabled')}</button></section>
    ${tower(r)}<nav class="wv-links">${link('/observation/records', L('时段明细', 'Slot details'), 'clock')}${link('/rewards', L('解锁阶段', 'Vesting'), 'unlock')}${link('/warmup', L('预热', 'Warm-up'), 'bolt')}${link('/rules', L('规则', 'Rules'), 'book')}</nav>`;
}
