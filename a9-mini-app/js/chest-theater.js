/**
 * A9 任天堂第一方 6 档专属交互式开箱剧场
 * - 100% 复用现役 chest-art.js 6 档 4 图层原画（阴影/底座/箱盖/锁扣）
 * - 6 档独立分层剧场背景 + 实体 3D 赛璐璐台座 + 环境微尘 + 6→160 枚阶梯式 3D 弹跳金币瀑布
 * - 天降砸台 → 1~3 敲连击渗币（或长按满蓄）→ 顿帧 → 前 5% 假动作逆转金光 → 两段式合体直发结算
 * - 完整支持中英双语、随时跳过、音效一键开关、prefers-reduced-motion 与弹窗关闭零泄漏清理
 */

import { renderChestSvg, renderA9CoinSvg, CHEST_TIER_META } from './chest-art.js';
import { A9Audio } from './audio.js';
import { A9Haptic, A9TMA } from './tma.js';
import { openModal, closeModal, escapeHtml, formatNum, showToast } from './components.js';
import { icon } from './icons.js';
import { L } from './i18n.js';
import { buildTmaDeepLink, getShareRef } from './share.js';
import { PROTOCOL_SPECS } from './data.js';

const THEATER_TIER_SPECS = {
  bronze: {
    id: 'bronze',
    tapsNeeded: 1, holdMs: 400, hitstopMs: 55,
    coins: 6, jackpotCoins: 10, leakCoinsPerTap: 1, coinWaves: 1, coinScale: 0.90,
    sceneZh: '暖木工坊台', sceneEn: 'Timber Workshop',
    ringColor: '#E69F68', beamColor: '#FFE082', halo: '#C97A42', rays: '#F6C99E', innerGlow: '#FFE082',
    btnClass: 'is-red', cinema: false, shake: 'shake-sm',
    flashBg: 'radial-gradient(circle at 50% 38%, rgba(255,248,220,0.88), rgba(201,122,66,0.30) 50%, transparent 74%)',
    sparks: 16, rings: 1, speedLines: false, ambientColor: '#F4BE88', ambientKind: 'dot',
    colors: ['#FFC412', '#C97A42', '#E69F68', '#FFF08A'],
  },
  silver: {
    id: 'silver',
    tapsNeeded: 2, holdMs: 560, hitstopMs: 70,
    coins: 14, jackpotCoins: 22, leakCoinsPerTap: 1, coinWaves: 1, coinScale: 0.95,
    sceneZh: '冰霜银盾台', sceneEn: 'Frost Shield Stage',
    ringColor: '#60A5FA', beamColor: '#CFE8FF', halo: '#3B82F6', rays: '#CFE8FF', innerGlow: '#BFDBFE',
    btnClass: 'is-red', cinema: false, shake: 'shake-sm',
    flashBg: 'radial-gradient(circle at 50% 38%, rgba(248,250,252,0.95), rgba(37,116,232,0.38) 48%, transparent 76%)',
    sparks: 30, rings: 1, speedLines: false, ambientColor: '#93C5FD', ambientKind: 'diamond',
    colors: ['#FFFFFF', '#3B82F6', '#CFE8FF', '#FFC412'],
  },
  gold: {
    id: 'gold',
    tapsNeeded: 2, holdMs: 660, hitstopMs: 85,
    coins: 28, jackpotCoins: 42, leakCoinsPerTap: 2, coinWaves: 2, coinScale: 1.0,
    sceneZh: '红金宝库台', sceneEn: 'Crimson Gold Vault',
    ringColor: '#FFC412', beamColor: '#FFF08A', halo: '#F7BE2C', rays: '#FFE899', innerGlow: '#FFF08A',
    btnClass: 'is-red', cinema: false, shake: 'shake-md',
    flashBg: 'radial-gradient(circle at 50% 38%, rgba(255,252,230,0.96), rgba(247,190,44,0.52) 48%, transparent 78%)',
    sparks: 48, rings: 2, speedLines: true, ambientColor: '#FFE066', ambientKind: 'star',
    colors: ['#FFC412', '#E60012', '#FFF08A', '#12A85D', '#FFFFFF'],
  },
  platinum: {
    id: 'platinum',
    tapsNeeded: 3, holdMs: 760, hitstopMs: 95,
    coins: 46, jackpotCoins: 68, leakCoinsPerTap: 2, coinWaves: 2, coinScale: 1.04,
    sceneZh: '紫晶星轨台', sceneEn: 'Amethyst Orbit Stage',
    ringColor: '#A78BFA', beamColor: '#E0DCFF', halo: '#6D5DF6', rays: '#D7D2FF', innerGlow: '#C4B5FD',
    btnClass: 'is-red', cinema: true, shake: 'shake-md',
    flashBg: 'radial-gradient(circle at 50% 38%, rgba(255,255,255,0.97), rgba(109,93,246,0.52) 48%, transparent 80%)',
    sparks: 64, rings: 2, speedLines: true, ambientColor: '#C4B5FD', ambientKind: 'diamond',
    colors: ['#8B5CF6', '#C4B5FD', '#FFFFFF', '#FFC412', '#38BDF8'],
  },
  diamond: {
    id: 'diamond',
    tapsNeeded: 3, holdMs: 860, hitstopMs: 110,
    coins: 72, jackpotCoins: 102, leakCoinsPerTap: 3, coinWaves: 3, coinScale: 1.08,
    sceneZh: '冰钻皇冠祭坛', sceneEn: 'Diamond Crown Altar',
    ringColor: '#29C7FF', beamColor: '#B8F3FF', halo: '#29C7FF', rays: '#B8F3FF', innerGlow: '#7EE8FF',
    btnClass: 'is-red', cinema: true, shake: 'shake-md',
    flashBg: 'radial-gradient(circle at 50% 38%, rgba(255,255,255,1), rgba(41,199,255,0.62) 44%, rgba(255,212,59,0.32) 72%, transparent 86%)',
    sparks: 88, rings: 2, speedLines: true, ambientColor: '#7AE8FF', ambientKind: 'diamond',
    colors: ['#29C7FF', '#B8F3FF', '#FFD43B', '#FFFFFF', '#E60012'],
  },
  legendary: {
    id: 'legendary',
    tapsNeeded: 3, holdMs: 960, hitstopMs: 130,
    coins: 118, jackpotCoins: 160, leakCoinsPerTap: 4, coinWaves: 3, coinScale: 1.14,
    sceneZh: '帝王红金圣殿', sceneEn: 'Imperial Red-Gold Sanctuary',
    ringColor: '#FFC412', beamColor: '#FFE082', halo: '#E60012', rays: '#FFE082', innerGlow: '#FFC412',
    btnClass: 'is-epic', cinema: true, shake: 'shake-epic',
    flashBg: 'radial-gradient(circle at 50% 36%, rgba(255,255,255,1), rgba(255,196,18,0.88) 34%, rgba(230,0,18,0.58) 66%, transparent 88%)',
    sparks: 126, rings: 3, speedLines: true, ambientColor: '#FFC412', ambientKind: 'star',
    colors: ['#FFC412', '#E60012', '#FFFFFF', '#FF6B78', '#12A85D'],
  },
};

/** 渲染 6 档专属任天堂剧场背景（天穹渐变 + 波普几何纹理 + 太阳光束 + 透视舞台地平线） */
function renderStageBackdropSvg(tierId) {
  const cfg = {
    bronze: {
      skyTop: '#241712', skyMid: '#4A2B1B', skyBot: '#19110E',
      glow: '#E69F68', ray: '#F4BE88', floorTop: '#331E15', floorLine: '#6B4229',
      pattern: `<pattern id="ct-p-bronze" width="26" height="26" patternUnits="userSpaceOnUse">
        <circle cx="13" cy="13" r="2.2" fill="#F4BE88" opacity="0.11"/>
      </pattern><rect width="480" height="310" fill="url(#ct-p-bronze)"/>`,
      arch: `<path d="M56 320V145C56 64 138 22 240 22C342 22 424 64 424 145V320" fill="none" stroke="#E69F68" stroke-opacity="0.14" stroke-width="3"/>
             <rect x="26" y="42" width="16" height="270" rx="8" fill="#6B3D23" opacity="0.26"/>
             <rect x="438" y="42" width="16" height="270" rx="8" fill="#6B3D23" opacity="0.26"/>`,
    },
    silver: {
      skyTop: '#0F1B2E', skyMid: '#1E3A5F', skyBot: '#0B1320',
      glow: '#7CC0FF', ray: '#DCEBFF', floorTop: '#162742', floorLine: '#4874A8',
      pattern: `<pattern id="ct-p-silver" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
        <rect width="12" height="28" fill="#CFE4FF" opacity="0.06"/>
      </pattern><rect width="480" height="310" fill="url(#ct-p-silver)"/>`,
      arch: `<polygon points="240,26 420,164 240,302 60,164" fill="none" stroke="#B8D8FF" stroke-opacity="0.15" stroke-width="2.5"/>
             <polygon points="240,56 382,164 240,272 98,164" fill="none" stroke="#62A5FF" stroke-opacity="0.16" stroke-width="1.5"/>`,
    },
    gold: {
      skyTop: '#2E1409', skyMid: '#6E3208', skyBot: '#1B0D08',
      glow: '#FFC412', ray: '#FFE27A', floorTop: '#3E1C0A', floorLine: '#C97B0C',
      pattern: `<pattern id="ct-p-gold" width="32" height="32" patternUnits="userSpaceOnUse">
        <path d="M16 4L18.5 13.5L28 16L18.5 18.5L16 28L13.5 18.5L4 16L13.5 13.5Z" fill="#FFE066" opacity="0.08"/>
      </pattern><rect width="480" height="310" fill="url(#ct-p-gold)"/>`,
      arch: `<circle cx="240" cy="186" r="144" fill="none" stroke="#FFC412" stroke-opacity="0.18" stroke-width="3" stroke-dasharray="14 10"/>
             <circle cx="240" cy="186" r="112" fill="none" stroke="#E60012" stroke-opacity="0.22" stroke-width="2"/>`,
    },
    platinum: {
      skyTop: '#14112E', skyMid: '#2D226B', skyBot: '#0E0B20',
      glow: '#9F8FFF', ray: '#D7D2FF', floorTop: '#1D1745', floorLine: '#6D5DF6',
      pattern: `<pattern id="ct-p-plat" width="36" height="31" patternUnits="userSpaceOnUse">
        <polygon points="18,1 35,10 35,21 18,30 1,21 1,10" fill="none" stroke="#B9B0FF" stroke-opacity="0.10" stroke-width="1.2"/>
      </pattern><rect width="480" height="310" fill="url(#ct-p-plat)"/>`,
      arch: `<polygon points="240,18 394,104 394,268 240,354 86,268 86,104" fill="none" stroke="#A79BFF" stroke-opacity="0.20" stroke-width="2.5"/>
             <circle cx="240" cy="186" r="126" fill="none" stroke="#FFFFFF" stroke-opacity="0.12" stroke-width="1.5" stroke-dasharray="4 8"/>`,
    },
    diamond: {
      skyTop: '#061B33', skyMid: '#0D4B7A', skyBot: '#051224',
      glow: '#4CE0FF', ray: '#D2F8FF', floorTop: '#0A2D4F', floorLine: '#29C7FF',
      pattern: `<pattern id="ct-p-dia" width="34" height="34" patternUnits="userSpaceOnUse">
        <path d="M17 0L34 17L17 34L0 17Z" fill="none" stroke="#9EEFFF" stroke-opacity="0.11" stroke-width="1.2"/>
      </pattern><rect width="480" height="310" fill="url(#ct-p-dia)"/>`,
      arch: `<polygon points="240,14 338,70 398,186 338,302 240,358 142,302 82,186 142,70" fill="none" stroke="#7AE8FF" stroke-opacity="0.24" stroke-width="2.5"/>
             <polygon points="240,42 320,88 368,186 320,284 240,330 160,284 112,186 160,88" fill="none" stroke="#FFD43B" stroke-opacity="0.18" stroke-width="1.8"/>`,
    },
    legendary: {
      skyTop: '#1D060D', skyMid: '#590817', skyBot: '#13050C',
      glow: '#FFC412', ray: '#FFE27A', floorTop: '#2E0A14', floorLine: '#E60012',
      pattern: `<pattern id="ct-p-leg" width="36" height="36" patternUnits="userSpaceOnUse">
        <path d="M18 3L21 15L33 18L21 21L18 33L15 21L3 18L15 15Z" fill="#FFC412" opacity="0.09"/>
      </pattern><rect width="480" height="310" fill="url(#ct-p-leg)"/>`,
      arch: `
        <rect x="20" y="0" width="22" height="315" fill="url(#ct-col-grad)" opacity="0.45"/>
        <rect x="438" y="0" width="22" height="315" fill="url(#ct-col-grad)" opacity="0.45"/>
        <path d="M44 315V136C44 48 130 14 240 14C350 14 436 48 436 136V315" fill="none" stroke="#FFC412" stroke-opacity="0.30" stroke-width="3.2"/>
        <circle cx="240" cy="186" r="154" fill="none" stroke="#FFC412" stroke-opacity="0.24" stroke-width="2.4" stroke-dasharray="18 8"/>
        <circle cx="240" cy="186" r="120" fill="none" stroke="#FF4D5E" stroke-opacity="0.32" stroke-width="2"/>`,
    },
  }[tierId] || {};

  const rays = Array.from({ length: 12 }, (_, i) => {
    const a1 = ((i * 30 - 6) * Math.PI) / 180;
    const a2 = ((i * 30 + 6) * Math.PI) / 180;
    const r = 340;
    const x1 = (240 + Math.cos(a1) * r).toFixed(1);
    const y1 = (186 + Math.sin(a1) * r).toFixed(1);
    const x2 = (240 + Math.cos(a2) * r).toFixed(1);
    const y2 = (186 + Math.sin(a2) * r).toFixed(1);
    return `<polygon points="240,186 ${x1},${y1} ${x2},${y2}" fill="${cfg.ray}" opacity="${i % 2 === 0 ? 0.11 : 0.06}"/>`;
  }).join('');

  return `<svg viewBox="0 0 480 540" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient id="ct-sky-${tierId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${cfg.skyTop}"/>
        <stop offset="48%" stop-color="${cfg.skyMid}"/>
        <stop offset="100%" stop-color="${cfg.skyBot}"/>
      </linearGradient>
      <radialGradient id="ct-spot-${tierId}" cx="50%" cy="35%" r="54%">
        <stop offset="0%" stop-color="${cfg.glow}" stop-opacity="0.42"/>
        <stop offset="55%" stop-color="${cfg.glow}" stop-opacity="0.10"/>
        <stop offset="100%" stop-color="${cfg.skyBot}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="ct-floor-${tierId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${cfg.floorTop}" stop-opacity="0.96"/>
        <stop offset="100%" stop-color="${cfg.skyBot}" stop-opacity="1"/>
      </linearGradient>
      <linearGradient id="ct-col-grad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#FFC412" stop-opacity="0.55"/>
        <stop offset="50%" stop-color="#6E0B1A" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#FFC412" stop-opacity="0.15"/>
      </linearGradient>
    </defs>
    <rect width="480" height="540" fill="url(#ct-sky-${tierId})"/>
    ${cfg.pattern || ''}
    <g class="ct-backdrop-spin">${rays}</g>
    <rect width="480" height="540" fill="url(#ct-spot-${tierId})"/>
    ${cfg.arch || ''}
    <path d="M0 286 Q240 264 480 286 L480 540 L0 540 Z" fill="url(#ct-floor-${tierId})"/>
    <path d="M0 286 Q240 264 480 286" fill="none" stroke="${cfg.floorLine}" stroke-width="2.5" opacity="0.65"/>
    <g stroke="${cfg.floorLine}" stroke-opacity="0.22" stroke-width="1.2">
      <line x1="240" y1="275" x2="240" y2="540"/>
      <line x1="180" y1="278" x2="60" y2="540"/>
      <line x1="300" y1="278" x2="420" y2="540"/>
      <line x1="115" y1="282" x2="-40" y2="460"/>
      <line x1="365" y1="282" x2="520" y2="460"/>
      <ellipse cx="240" cy="300" rx="185" ry="26" fill="none"/>
    </g>
  </svg>`;
}

/** 渲染 6 档专属 3D 赛璐璐粗描边展示台座 */
function renderPedestalSvg(tierId) {
  const palette = {
    bronze:    { top: '#B56D3B', rim: '#783E1B', side: '#5C2E12', glow: '#F4BE88', accent: '#E69F68' },
    silver:    { top: '#C7D6EA', rim: '#7C94B4', side: '#4A607D', glow: '#93C5FD', accent: '#FFFFFF' },
    gold:      { top: '#F7C238', rim: '#C97B08', side: '#8A4800', glow: '#FFE27A', accent: '#E60012' },
    platinum:  { top: '#D8D4FF', rim: '#7364F5', side: '#4335A8', glow: '#B9B0FF', accent: '#FFFFFF' },
    diamond:   { top: '#7EE8FF', rim: '#0EA5E9', side: '#035991', glow: '#9EEFFF', accent: '#FFD43B' },
    legendary: { top: '#432A4F', rim: '#E60012', side: '#230D1B', glow: '#FFC412', accent: '#FFC412' },
  }[tierId] || { top: '#F7C238', rim: '#C97B08', side: '#8A4800', glow: '#FFE27A', accent: '#E60012' };
  const stroke = '#171920';
  return `<svg viewBox="0 0 220 72" width="100%" height="100%" fill="none" aria-hidden="true">
    <ellipse cx="110" cy="59" rx="94" ry="12" fill="rgba(0,0,0,0.48)"/>
    <ellipse cx="110" cy="56" rx="86" ry="10" fill="${palette.glow}" opacity="0.22"/>
    <path d="M28 33 V49 C28 58 65 65 110 65 C155 65 192 58 192 49 V33 Z" fill="${palette.side}" stroke="${stroke}" stroke-width="2.6"/>
    <path d="M28 39 C28 48 65 55 110 55 C155 55 192 48 192 39" fill="none" stroke="${palette.rim}" stroke-width="4"/>
    <ellipse cx="110" cy="33" rx="82" ry="18" fill="${palette.top}" stroke="${stroke}" stroke-width="2.6"/>
    <ellipse cx="110" cy="33" rx="68" ry="13" fill="none" stroke="${palette.accent}" stroke-width="2" opacity="0.65"/>
    <path d="M52 25 C70 19 102 18 134 20" stroke="#FFFFFF" stroke-width="2.8" stroke-linecap="round" opacity="0.58"/>
    <rect x="96" y="48" width="28" height="10" rx="5" fill="${palette.accent}" stroke="${stroke}" stroke-width="2"/>
    <circle cx="56" cy="49" r="3.2" fill="${palette.accent}" stroke="${stroke}" stroke-width="1.6"/>
    <circle cx="164" cy="49" r="3.2" fill="${palette.accent}" stroke="${stroke}" stroke-width="1.6"/>
  </svg>`;
}

let activeTheaterCleanup = null;

/**
 * 打开 6 档专属任天堂交互式开箱剧场弹窗
 */
export function openChestUnboxingTheater({
  tier = 'gold',
  title = '',
  totalA9 = 0,
  baseA9 = 0,
  bonusA9 = null,
  openedCount = 1,
  nextUnlocked = null,
  critCount = 0,
  legendaryCount = 0,
  budgetCapped = false,
} = {}) {
  if (typeof activeTheaterCleanup === 'function') {
    activeTheaterCleanup();
    activeTheaterCleanup = null;
  }

  const tierKey = THEATER_TIER_SPECS[tier] ? tier : 'gold';
  const spec = THEATER_TIER_SPECS[tierKey];
  const tierMeta = CHEST_TIER_META[tierKey] || CHEST_TIER_META.gold;
  const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  const hasPaidSplit = Number(baseA9) > 0;
  const resolvedBaseA9 = hasPaidSplit ? Math.max(0, Math.round(Number(baseA9))) : 0;
  const resolvedBonusA9 = bonusA9 !== null && bonusA9 !== undefined
    ? Math.max(0, Math.round(Number(bonusA9)))
    : (hasPaidSplit ? Math.max(0, Math.round(Number(totalA9) - Number(baseA9))) : Math.max(0, Math.round(Number(totalA9))));
  const roundedTotal = hasPaidSplit
    ? (resolvedBaseA9 + resolvedBonusA9)
    : Math.max(0, Math.round(Number(totalA9)));

  const isJackpot = Number(legendaryCount) > 0;
  const isLucky = !isJackpot && Number(critCount) > 0;
  const targetCoinCount = isJackpot ? spec.jackpotCoins : spec.coins;
  const chestLabel = title || L(`${tierMeta.shortZh}宝箱`, `${tierMeta.shortEn} Chest`);
  const topBadgeText = openedCount > 1
    ? `${chestLabel} × ${openedCount}`
    : chestLabel;
  const hasShareBtn = hasPaidSplit || isJackpot || isLucky;

  const capNoteHtml = budgetCapped
    ? `<div class="ct-note">${L(`${formatNum(PROTOCOL_SPECS.promoCapA9)} A9 活动加赠池已达上限，100% 保底本金不受影响`, `${formatNum(PROTOCOL_SPECS.promoCapA9)} A9 bonus pool reached cap; 100% base principal unaffected`)}</div>`
    : '';
  const nextNoteHtml = nextUnlocked
    ? `<div class="ct-note is-green">${L(`已解锁下一档「${escapeHtml(nextUnlocked.labelZh || '')}」`, `Unlocked ${escapeHtml(nextUnlocked.labelEn || '')}`)}</div>`
    : '';

  const splitHtml = hasPaidSplit
    ? `<div class="ct-split-grid">
         <div class="ct-subcard">
           <small>${L('1. 保底本金（稳拿）', '1. Base Principal')}</small>
           <strong id="ct-res-base">${formatNum(resolvedBaseA9, 0)} A9</strong>
         </div>
         <div class="ct-subcard is-bonus" id="ct-bonus-card">
           <small>${L('2. 随机加赠（合体）', '2. Random Bonus')}</small>
           <strong id="ct-res-bonus">${L('揭晓中…', 'Revealing…')}</strong>
         </div>
       </div>`
    : '';

  openModal(`
    <div id="ct-shell" class="ct-shell tier-${tierKey}">
      <div class="ct-backdrop">${renderStageBackdropSvg(tierKey)}</div>
      <canvas id="ct-ambient-canvas" class="ct-ambient-canvas"></canvas>
      <div class="ct-vignette"></div>
      <div id="ct-fakeout-banner" class="ct-fakeout-banner">${L('超频逆转 · 前 5% 手气爆棚！', 'OVERDRIVE · TOP 5% LUCKY ROLL!')}</div>
      <canvas id="ct-fx-canvas" class="ct-fx-canvas"></canvas>
      <div id="ct-flash" class="ct-flash" style="background:${spec.flashBg};"></div>

      <div class="ct-camera">
        <div class="ct-topbar">
          <div class="ct-topbar-left">
            <span class="ct-hud-pill">${escapeHtml(topBadgeText)}</span>
            <span class="ct-hud-pill is-gold mono">${L(`${spec.coins} 币`, `${spec.coins} coins`)}</span>
          </div>
          <div class="ct-topbar-right">
            <button type="button" id="ct-sound-btn" class="ct-hud-btn" aria-label="${L('切换音效', 'Toggle Sound')}">
              ${A9Audio.isEnabled() ? L('音效开', 'SFX ON') : L('静音', 'MUTED')}
            </button>
            <button type="button" id="ct-skip-btn" class="ct-hud-btn">${L('跳过', 'Skip')}</button>
          </div>
        </div>

        <div id="ct-tap-pips" class="ct-pips-row" aria-label="${L('破封进度', 'Seal progress')}"></div>

        <div id="ct-rig-wrap" class="ct-rig-wrap">
          <div class="ct-pedestal">${renderPedestalSvg(tierKey)}</div>
          <div id="ct-rig" class="ct-rig sm-drop tier-${tierKey}" role="button" tabindex="0" aria-label="${L('点击敲击或长按开启宝箱', 'Tap or hold to open chest')}">
            <div class="ct-aura-halo" style="background:${spec.halo};"></div>
            <svg class="ct-hold-ring" viewBox="0 0 164 164" aria-hidden="true">
              <circle class="ct-hold-track" cx="82" cy="82" r="72" />
              <circle id="ct-hold-fill" class="ct-hold-fill" cx="82" cy="82" r="72" style="stroke:${spec.ringColor};" />
            </svg>
            <svg class="ct-god-beams" viewBox="0 0 240 168" aria-hidden="true">
              <defs>
                <linearGradient id="ct-beam-grad-${tierKey}" x1="0" y1="1" x2="0" y2="0">
                  <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.95" />
                  <stop offset="55%" stop-color="${spec.beamColor}" stop-opacity="0.52" />
                  <stop offset="100%" stop-color="${spec.beamColor}" stop-opacity="0" />
                </linearGradient>
              </defs>
              <polygon points="120,122 68,0 172,0" fill="url(#ct-beam-grad-${tierKey})" />
              <polygon points="120,122 20,24 76,0" fill="url(#ct-beam-grad-${tierKey})" opacity="0.65" />
              <polygon points="120,122 164,0 220,24" fill="url(#ct-beam-grad-${tierKey})" opacity="0.65" />
            </svg>
            <svg class="ct-burst-rays" viewBox="0 0 200 200" aria-hidden="true">
              <g fill="${spec.rays}" opacity="0.46">
                <polygon points="100,100 91,0 109,0" />
                <polygon points="100,100 148,14 162,26" />
                <polygon points="100,100 186,52 196,68" />
                <polygon points="100,100 200,91 200,109" />
                <polygon points="100,100 186,148 174,162" />
                <polygon points="100,100 148,186 132,196" />
                <polygon points="100,100 109,200 91,200" />
                <polygon points="100,100 52,186 38,174" />
                <polygon points="100,100 14,148 4,132" />
                <polygon points="100,100 0,109 0,91" />
                <polygon points="100,100 14,52 26,38" />
                <polygon points="100,100 52,14 68,4" />
              </g>
            </svg>
            <div class="ct-inner-glow" style="background:${spec.innerGlow};"></div>
            <div style="position:relative;z-index:10;">${renderChestSvg(tierKey, { size: 128 })}</div>
          </div>
        </div>

        <div class="ct-panel">
          <!-- 视图 A：连敲 / 长按破封 -->
          <div id="ct-view-sealed">
            <div class="ct-panel-head" style="margin-bottom:5px;">
              <div id="ct-sealed-title" class="ct-title"></div>
              <span class="ct-leak-hint">${L(`每敲渗出 ${spec.leakCoinsPerTap} 币`, `${spec.leakCoinsPerTap} coin/tap`)}</span>
            </div>
            <div class="ct-subline" style="margin-bottom:9px;">
              ${hasPaidSplit
                ? L('付款已确认，破封立即揭晓本金 + 随机加赠合并直发金额', 'Payment confirmed. Break the seal to reveal base + random bonus.')
                : L('奖励已就绪，点击或长按破封领取本次宝箱奖励', 'Reward ready. Tap or hold to break the seal and claim.')}
            </div>
            <button type="button" id="ct-btn-open" class="ct-action-btn ${spec.btnClass}"></button>
            <div class="ct-footline" style="margin-top:7px;">
              <span>${L('点上方宝箱本体同样可连敲', 'Tap the chest directly too')}</span>
              <span class="ct-footline-green">${hasPaidSplit ? L('1 笔直发 TON 钱包', 'Direct to TON Wallet') : L('立即入账', 'Instant Credit')}</span>
            </div>
          </div>

          <!-- 视图 B：顿帧 / 假动作逆转高潮 -->
          <div id="ct-view-climax" class="ct-hidden" style="padding:14px 0;">
            <div id="ct-climax-title" class="ct-title" style="color:#FDE047;font-size:15px;">${L('破封临界！', 'BREAKING SEAL!')}</div>
            <div id="ct-climax-sub" class="ct-subline mono" style="text-align:center;margin-top:4px;">${L('能量蓄满揭晓中…', 'Unleashing reward…')}</div>
          </div>

          <!-- 视图 C：两段式合体结算 -->
          <div id="ct-view-revealed" class="ct-hidden" style="display:flex;flex-direction:column;gap:8px;">
            <div class="ct-tag-row">
              <span id="ct-roll-tag" class="ct-tag"></span>
              <span class="ct-tag is-direct">${hasPaidSplit ? L('已 1 笔直发钱包', 'Sent Directly to Wallet') : L('开箱已入账', 'Chest Credited')}</span>
            </div>

            <div class="ct-amount-row">
              ${renderA9CoinSvg({ size: 26 })}
              <span id="ct-amount-roller" class="ct-amount-num">+${formatNum(hasPaidSplit ? resolvedBaseA9 : roundedTotal, 0)}</span>
              <span class="ct-amount-unit">A9</span>
            </div>

            ${splitHtml}
            ${capNoteHtml}
            ${nextNoteHtml}

            <div class="ct-cta-grid">
              <button type="button" id="ct-btn-stake" class="ct-action-btn is-red">
                ${icon('bolt', 13)} ${L('带这笔进头矿 6H', 'Lock in First 6H')}
              </button>
              <button type="button" id="ct-btn-collect" class="ct-action-btn is-ghost">
                ${icon('checkCircle', 13)} ${L('收入钱包', 'Keep in Wallet')}
              </button>
            </div>
            ${hasShareBtn ? `<button type="button" id="ct-btn-share" class="ct-share-link">${icon('send', 12)} ${L('炫耀开箱喜报给群友', 'Share Unboxing Report')}</button>` : ''}
          </div>
        </div>

        <div class="ct-bottom-status">
          <span>${L(spec.sceneZh, spec.sceneEn)} · ${L(`${spec.tapsNeeded} 敲破封`, `${spec.tapsNeeded}-Tap Seal`)}</span>
          <span id="ct-wallet-toast">${L('可连敲或长按', 'Tap or Hold')}</span>
        </div>
      </div>
    </div>
  `);

  const elShell = document.getElementById('ct-shell');
  const ambCanvas = document.getElementById('ct-ambient-canvas');
  const fxCanvas = document.getElementById('ct-fx-canvas');
  if (!elShell || !ambCanvas || !fxCanvas) return;

  const a2d = ambCanvas.getContext('2d');
  const c2d = fxCanvas.getContext('2d');
  const elRigWrap = document.getElementById('ct-rig-wrap');
  const elRig = document.getElementById('ct-rig');
  const elHoldFill = document.getElementById('ct-hold-fill');
  const elFlash = document.getElementById('ct-flash');
  const elFakeoutBanner = document.getElementById('ct-fakeout-banner');
  const elTapPips = document.getElementById('ct-tap-pips');
  const elSoundBtn = document.getElementById('ct-sound-btn');
  const elSkipBtn = document.getElementById('ct-skip-btn');
  const elSealed = document.getElementById('ct-view-sealed');
  const elClimax = document.getElementById('ct-view-climax');
  const elRevealed = document.getElementById('ct-view-revealed');
  const elSealedTitle = document.getElementById('ct-sealed-title');
  const elBtnOpen = document.getElementById('ct-btn-open');
  const elClimaxTitle = document.getElementById('ct-climax-title');
  const elClimaxSub = document.getElementById('ct-climax-sub');
  const elRollTag = document.getElementById('ct-roll-tag');
  const elRoller = document.getElementById('ct-amount-roller');
  const elResBonus = document.getElementById('ct-res-bonus');
  const elBonusCard = document.getElementById('ct-bonus-card');
  const elWalletToast = document.getElementById('ct-wallet-toast');

  let destroyed = false;
  let phase = 'idle'; // idle | climax | burst
  let taps = 0;
  let holdStart = 0;
  let holdRaf = 0;
  let fxRaf = 0;
  let ambRaf = 0;
  let rollRaf = 0;
  const timers = [];

  let ambParticles = [];
  let coins = [];
  let sparks = [];
  let shockwaves = [];
  let speedLines = [];
  let dusts = [];

  const schedule = (fn, ms) => {
    const id = setTimeout(() => {
      if (!destroyed && elShell.isConnected) fn();
    }, ms);
    timers.push(id);
    return id;
  };

  const cleanup = () => {
    if (destroyed) return;
    destroyed = true;
    timers.forEach((id) => clearTimeout(id));
    timers.length = 0;
    if (holdRaf) cancelAnimationFrame(holdRaf);
    if (fxRaf) cancelAnimationFrame(fxRaf);
    if (ambRaf) cancelAnimationFrame(ambRaf);
    if (rollRaf) cancelAnimationFrame(rollRaf);
    window.removeEventListener('resize', resizeCanvases);
    window.removeEventListener('a9:interaction-idle', cleanup);
    if (activeTheaterCleanup === cleanup) activeTheaterCleanup = null;
  };
  activeTheaterCleanup = cleanup;

  function resizeCanvases() {
    if (destroyed || !elShell.isConnected) return;
    const rect = elShell.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const [cv, ctx] of [[ambCanvas, a2d], [fxCanvas, c2d]]) {
      cv.width = Math.max(1, Math.floor(rect.width * dpr));
      cv.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function initAmbient() {
    const rect = elShell.getBoundingClientRect();
    const w = rect.width || 360;
    const h = rect.height || 470;
    const count = tierKey === 'legendary' ? 24 : tierKey === 'diamond' ? 20 : 14;
    ambParticles = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h * 0.78,
      vy: -(0.18 + Math.random() * 0.40),
      vx: (Math.random() - 0.5) * 0.22,
      size: 1.8 + Math.random() * 2.8,
      alpha: 0.16 + Math.random() * 0.40,
      twinkle: Math.random() * Math.PI * 2,
      color: spec.ambientColor,
      kind: spec.ambientKind,
    }));
  }

  function tickAmbient() {
    if (destroyed || !elShell.isConnected) {
      cleanup();
      return;
    }
    const rect = elShell.getBoundingClientRect();
    const w = rect.width || 360;
    const h = rect.height || 470;
    a2d.clearRect(0, 0, w, h);
    for (const p of ambParticles) {
      p.x += p.vx;
      p.y += p.vy;
      p.twinkle += 0.04;
      if (p.y < -10) { p.y = h * 0.72; p.x = Math.random() * w; }
      if (p.x < -10) p.x = w + 10;
      if (p.x > w + 10) p.x = -10;
      const a = p.alpha * (0.55 + 0.45 * Math.sin(p.twinkle));
      a2d.save();
      a2d.globalAlpha = a;
      a2d.fillStyle = p.color;
      a2d.translate(p.x, p.y);
      if (p.kind === 'star') {
        a2d.fillRect(-p.size, -0.9, p.size * 2, 1.8);
        a2d.fillRect(-0.9, -p.size, 1.8, p.size * 2);
      } else if (p.kind === 'diamond') {
        a2d.beginPath();
        a2d.moveTo(0, -p.size); a2d.lineTo(p.size * 0.7, 0);
        a2d.lineTo(0, p.size); a2d.lineTo(-p.size * 0.7, 0);
        a2d.closePath(); a2d.fill();
      } else {
        a2d.beginPath(); a2d.arc(0, 0, p.size * 0.75, 0, Math.PI * 2); a2d.fill();
      }
      a2d.restore();
    }
    ambRaf = requestAnimationFrame(tickAmbient);
  }

  function getAnchors() {
    const sRect = elShell.getBoundingClientRect();
    const rRect = elRig.getBoundingClientRect();
    return {
      cx: rRect.left - sRect.left + rRect.width / 2,
      cy: rRect.top - sRect.top + rRect.height * 0.48,
      pedestalY: rRect.bottom - sRect.top + 6,
      floorY: sRect.height - 18,
      w: sRect.width,
      h: sRect.height,
    };
  }

  function drawNintendoCoin(c) {
    const cosA = Math.cos(c.flip);
    const sx = Math.max(0.18, Math.abs(cosA));
    const alpha = Math.max(0, Math.min(1, c.life * 1.35));

    const distToFloor = Math.max(0, c.floorY - c.y);
    if (distToFloor < 90) {
      const shScale = Math.max(0.2, 1 - distToFloor / 95);
      c2d.save();
      c2d.globalAlpha = alpha * 0.28 * shScale;
      c2d.fillStyle = '#090B12';
      c2d.beginPath();
      c2d.ellipse(c.x, c.floorY + c.r * 0.55, c.r * 0.9 * shScale, c.r * 0.26 * shScale, 0, 0, Math.PI * 2);
      c2d.fill();
      c2d.restore();
    }

    if (c.hero && c.trail.length > 1) {
      c2d.save();
      for (let i = 0; i < c.trail.length; i++) {
        const pt = c.trail[i];
        c2d.globalAlpha = alpha * (i / c.trail.length) * 0.22;
        c2d.fillStyle = '#FFF08A';
        c2d.beginPath();
        c2d.arc(pt.x, pt.y, c.r * 0.52, 0, Math.PI * 2);
        c2d.fill();
      }
      c2d.restore();
    }

    c2d.save();
    c2d.globalAlpha = alpha;
    c2d.translate(c.x, c.y);

    const edgeOffset = (1 - sx) * (c.hero ? 3.2 : 2.2) * (cosA >= 0 ? 1 : -1);
    c2d.save();
    c2d.translate(edgeOffset, 1.2);
    c2d.scale(sx, 1);
    c2d.beginPath();
    c2d.arc(0, 0, c.r, 0, Math.PI * 2);
    c2d.fillStyle = '#BA7A04';
    c2d.fill();
    c2d.lineWidth = 1.6;
    c2d.strokeStyle = '#171920';
    c2d.stroke();
    c2d.restore();

    c2d.scale(sx, 1);
    c2d.beginPath();
    c2d.arc(0, 0, c.r, 0, Math.PI * 2);
    c2d.fillStyle = c.hero ? '#FFD43B' : '#FFC412';
    c2d.fill();
    c2d.lineWidth = 1.8;
    c2d.strokeStyle = '#171920';
    c2d.stroke();

    c2d.beginPath();
    c2d.arc(0, 0, c.r * 0.68, 0, Math.PI * 2);
    c2d.strokeStyle = '#FFF3A8';
    c2d.lineWidth = 1.25;
    c2d.stroke();

    if (sx > 0.45 && c.r >= 7.8) {
      c2d.fillStyle = '#171920';
      c2d.font = `900 ${Math.round(c.r * 0.78)}px ui-monospace, Menlo, sans-serif`;
      c2d.textAlign = 'center';
      c2d.textBaseline = 'middle';
      c2d.fillText('A9', 0, 0.7);
    }
    c2d.restore();
  }

  function tickFx() {
    if (destroyed || !elShell.isConnected) {
      fxRaf = 0;
      return;
    }
    const rect = elShell.getBoundingClientRect();
    c2d.clearRect(0, 0, rect.width, rect.height);

    dusts = dusts.filter((d) => d.alpha > 0.03);
    for (const d of dusts) {
      d.x += d.vx; d.y += d.vy; d.vx *= 0.92; d.r += 0.35; d.alpha *= 0.89;
      c2d.save(); c2d.globalAlpha = d.alpha; c2d.fillStyle = d.color;
      c2d.beginPath(); c2d.arc(d.x, d.y, d.r, 0, Math.PI * 2); c2d.fill(); c2d.restore();
    }

    speedLines = speedLines.filter((l) => l.alpha > 0.04);
    for (const l of speedLines) {
      l.r0 += l.speed; l.alpha *= 0.87;
      c2d.save(); c2d.globalAlpha = l.alpha; c2d.strokeStyle = l.color; c2d.lineWidth = 2.4;
      c2d.beginPath();
      c2d.moveTo(l.x + Math.cos(l.angle) * l.r0, l.y + Math.sin(l.angle) * l.r0);
      c2d.lineTo(l.x + Math.cos(l.angle) * (l.r0 + l.len), l.y + Math.sin(l.angle) * (l.r0 + l.len));
      c2d.stroke(); c2d.restore();
    }

    shockwaves = shockwaves.filter((w) => w.alpha > 0.02);
    for (const w of shockwaves) {
      if (w.delay > 0) { w.delay -= 1; continue; }
      w.r += (w.maxR - w.r) * 0.16; w.alpha *= 0.90;
      c2d.save(); c2d.globalAlpha = Math.max(0, w.alpha); c2d.strokeStyle = w.color; c2d.lineWidth = Math.max(1, w.lw * w.alpha);
      c2d.beginPath(); c2d.arc(w.x, w.y, w.r, 0, Math.PI * 2); c2d.stroke(); c2d.restore();
    }

    coins = coins.filter((c) => c.life > 0.02);
    for (const c of coins) {
      if (c.hero) {
        c.trail.push({ x: c.x, y: c.y });
        if (c.trail.length > 4) c.trail.shift();
      }
      c.x += c.vx; c.y += c.vy; c.vy += 0.28; c.vx *= 0.992; c.flip += c.vflip;
      if (c.y >= c.floorY && c.vy > 0) {
        c.y = c.floorY;
        c.vy = -c.vy * 0.48;
        c.vx *= 0.78;
        c.bounces += 1;
      }
      c.life -= c.bounces >= 2 ? c.decay * 1.5 : c.decay * 0.45;
      drawNintendoCoin(c);
    }

    sparks = sparks.filter((p) => p.life > 0.02);
    for (const p of sparks) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.11; p.vx *= 0.982; p.rot += p.vrot; p.life -= p.decay;
      c2d.save(); c2d.globalAlpha = Math.max(0, p.life);
      c2d.translate(p.x, p.y); c2d.rotate(p.rot); c2d.fillStyle = p.color;
      if (p.kind === 'diamond') {
        c2d.beginPath(); c2d.moveTo(0, -p.size); c2d.lineTo(p.size * 0.68, 0); c2d.lineTo(0, p.size); c2d.lineTo(-p.size * 0.68, 0); c2d.closePath(); c2d.fill();
      } else if (p.kind === 'star') {
        c2d.fillRect(-p.size, -1.2, p.size * 2, 2.4); c2d.fillRect(-1.2, -p.size, 2.4, p.size * 2);
      } else {
        c2d.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.58);
      }
      c2d.restore();
    }

    if (coins.length || sparks.length || shockwaves.length || speedLines.length || dusts.length) {
      fxRaf = requestAnimationFrame(tickFx);
    } else {
      fxRaf = 0;
    }
  }

  function ensureFxLoop() {
    if (!fxRaf && !reducedMotion) fxRaf = requestAnimationFrame(tickFx);
  }

  function spawnLandingDust() {
    if (reducedMotion) return;
    resizeCanvases();
    const { cx, pedestalY } = getAnchors();
    const n = tierKey === 'legendary' ? 18 : 10;
    for (let i = 0; i < n; i++) {
      const dir = i % 2 === 0 ? -1 : 1;
      dusts.push({
        x: cx + dir * (16 + Math.random() * 24),
        y: pedestalY - 4 + (Math.random() - 0.5) * 6,
        vx: dir * (1.8 + Math.random() * (tierKey === 'legendary' ? 3.8 : 2.2)),
        vy: -(0.5 + Math.random() * 1.4),
        r: 4 + Math.random() * 5,
        alpha: 0.58,
        color: tierKey === 'legendary' ? '#FFE082' : '#E2E8F0',
      });
    }
    ensureFxLoop();
  }

  function spawnTapSparks(step) {
    if (reducedMotion) return;
    resizeCanvases();
    const { cx, cy, pedestalY } = getAnchors();
    shockwaves.push({ x: cx, y: cy, r: 16, maxR: 72 + step * 26, alpha: 0.85, lw: 3.4, color: spec.colors[0], delay: 0 });
    const n = 12 + step * 7;
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.3;
      const spd = 2.2 + Math.random() * (3.0 + step * 1.1);
      sparks.push({
        x: cx, y: cy, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - 1.4,
        size: 3 + Math.random() * 3.8, color: spec.colors[i % spec.colors.length],
        kind: i % 2 === 0 ? 'star' : 'diamond', rot: Math.random() * Math.PI, vrot: 0.22,
        life: 1, decay: 0.028 + Math.random() * 0.015,
      });
    }
    for (let i = 0; i < spec.leakCoinsPerTap; i++) {
      const spread = (Math.random() - 0.5) * 1.7;
      coins.push({
        x: cx + (Math.random() - 0.5) * 18,
        y: cy - 6,
        vx: Math.sin(spread) * (2.2 + Math.random() * 2.8),
        vy: -(4.2 + Math.random() * 2.6),
        r: (7.2 + Math.random() * 2.2) * spec.coinScale,
        flip: Math.random() * Math.PI * 2,
        vflip: 0.22 + Math.random() * 0.16,
        floorY: pedestalY + 8 + Math.random() * 20,
        bounces: 0,
        life: 1,
        decay: 0.012,
        hero: false,
        trail: [],
      });
    }
    ensureFxLoop();
  }

  function pushCoinBatch(count, mode, anchors) {
    const { cx, cy, floorY, w } = anchors;
    for (let i = 0; i < count; i++) {
      const isHero = (tierKey === 'legendary' || tierKey === 'diamond') && i % 5 === 0;
      const baseR = (isHero ? 10.4 : 7.4 + Math.random() * 2.5) * spec.coinScale;
      if (mode === 'rain') {
        coins.push({
          x: 20 + Math.random() * Math.max(40, w - 40),
          y: -14 - Math.random() * 140,
          vx: (Math.random() - 0.5) * 1.6,
          vy: 2.2 + Math.random() * 3.2,
          r: baseR,
          flip: Math.random() * Math.PI * 2,
          vflip: 0.16 + Math.random() * 0.22,
          floorY: floorY - Math.random() * 34,
          bounces: 0,
          life: 1,
          decay: 0.0055 + Math.random() * 0.004,
          hero: isHero,
          trail: [],
        });
      } else {
        const spreadSpan = spec.coins <= 10 ? 1.15 : spec.coins <= 30 ? 1.85 : 2.35;
        const spread = (Math.random() - 0.5) * spreadSpan;
        const upBase = spec.coins <= 10 ? 4.6 : spec.coins <= 30 ? 5.6 : 6.9;
        coins.push({
          x: cx + (Math.random() - 0.5) * 26,
          y: cy - 10,
          vx: Math.sin(spread) * (2.2 + Math.random() * (spec.coins > 60 ? 5.4 : 4.0)),
          vy: -(upBase + Math.random() * (spec.coins > 60 ? 5.4 : 3.6)),
          r: baseR,
          flip: Math.random() * Math.PI * 2,
          vflip: 0.18 + Math.random() * 0.26,
          floorY: floorY - Math.random() * 36,
          bounces: 0,
          life: 1,
          decay: spec.coins > 60 ? 0.0058 + Math.random() * 0.004 : 0.0085 + Math.random() * 0.004,
          hero: isHero,
          trail: [],
        });
      }
    }
    ensureFxLoop();
  }

  function spawnGrandBurstFx() {
    if (reducedMotion) return;
    resizeCanvases();
    const anchors = getAnchors();
    const { cx, cy } = anchors;

    const ringN = spec.rings + (isJackpot ? 1 : 0);
    for (let r = 0; r < ringN; r++) {
      shockwaves.push({
        x: cx, y: cy, r: 18, maxR: 185 + r * 52,
        alpha: 0.96 - r * 0.14, lw: 5.5 - r,
        color: spec.colors[r % spec.colors.length], delay: r * 5,
      });
    }
    if (spec.speedLines || isJackpot) {
      const ln = tierKey === 'legendary' || isJackpot ? 30 : 18;
      for (let i = 0; i < ln; i++) {
        const a = (Math.PI * 2 * i) / ln + Math.random() * 0.08;
        speedLines.push({
          x: cx, y: cy, angle: a, r0: 34 + Math.random() * 24,
          len: 50 + Math.random() * 64, speed: 11 + Math.random() * 6,
          alpha: 0.92, color: i % 2 === 0 ? '#FFFFFF' : spec.colors[0],
        });
      }
    }

    if (spec.coinWaves === 1) {
      pushCoinBatch(targetCoinCount, 'fountain', anchors);
    } else if (spec.coinWaves === 2) {
      const w1 = Math.ceil(targetCoinCount * 0.62);
      const w2 = targetCoinCount - w1;
      pushCoinBatch(w1, 'fountain', anchors);
      schedule(() => pushCoinBatch(w2, 'fountain', getAnchors()), 190);
    } else {
      const w1 = Math.ceil(targetCoinCount * 0.44);
      const w2 = Math.ceil(targetCoinCount * 0.30);
      const w3 = targetCoinCount - w1 - w2;
      pushCoinBatch(w1, 'fountain', anchors);
      schedule(() => pushCoinBatch(w2, 'fountain', getAnchors()), 180);
      schedule(() => pushCoinBatch(w3, 'rain', getAnchors()), 360);
    }

    const sparkN = Math.round(spec.sparks * (isJackpot ? 1.25 : 1));
    for (let i = 0; i < sparkN; i++) {
      const a = (Math.PI * 2 * i) / sparkN + (Math.random() - 0.5) * 0.35;
      const spd = (tierKey === 'legendary' ? 4.4 : 2.6) + Math.random() * 5.6;
      sparks.push({
        x: cx, y: cy, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - 2.2,
        size: 3.4 + Math.random() * 4.6, color: spec.colors[i % spec.colors.length],
        kind: tierKey === 'diamond' || tierKey === 'platinum' ? (i % 2 === 0 ? 'diamond' : 'star') : (i % 3 === 0 ? 'star' : 'rect'),
        rot: Math.random() * Math.PI, vrot: (Math.random() - 0.5) * 0.28,
        life: 1, decay: 0.012 + Math.random() * 0.012,
      });
    }
    ensureFxLoop();
  }

  function setRingProgress(pct) {
    const clamped = Math.max(0, Math.min(1, pct));
    elHoldFill.style.strokeDashoffset = String(452 * (1 - clamped));
  }

  function renderTapPips() {
    elTapPips.innerHTML = Array.from({ length: spec.tapsNeeded }, (_, i) => {
      const lit = i < taps;
      const cls = lit ? (tierKey === 'legendary' ? 'lit-red' : 'lit') : '';
      return `<span class="ct-tap-pip ${cls}"></span>`;
    }).join('');
  }

  function updateSealedCopy() {
    const rem = Math.max(1, spec.tapsNeeded - taps);
    if (taps === 0) {
      elSealedTitle.textContent = spec.tapsNeeded === 1
        ? L('轻敲 1 下即刻弹开', 'Tap Once to Pop Open')
        : L(`连敲 ${spec.tapsNeeded} 下或长按蓄满破封`, `Tap ${spec.tapsNeeded}× or Hold to Break Seal`);
      elBtnOpen.textContent = spec.tapsNeeded === 1
        ? L(`点击开启 ${chestLabel}`, `Open ${chestLabel}`)
        : L(`敲击破封（还需 ${rem} 敲 · 或长按）`, `Tap to Break Seal (${rem} left · or Hold)`);
    } else {
      elSealedTitle.textContent = L(`裂纹渗光！再敲 ${rem} 下轰然破封！`, `Seal Cracking! ${rem} More Tap(s)!`);
      elBtnOpen.textContent = L(`继续敲击！（还差 ${rem} 敲）`, `Keep Tapping! (${rem} left)`);
    }
  }

  function revealBurst(immediate = false) {
    phase = 'burst';
    elShell.classList.remove('is-cinema', 'is-fakeout', 'cam-step-1', 'cam-step-2', 'cam-step-3', 'shake-tap');
    void elShell.offsetWidth;
    if (!immediate && !reducedMotion) {
      elShell.classList.add(spec.shake);
      elFlash.classList.remove('fire');
      void elFlash.offsetWidth;
      elFlash.classList.add('fire');
    }
    elShell.classList.add('sm-phase-burst');
    elRig.className = `ct-rig sm-burst tier-${tierKey}`;
    setRingProgress(0);
    elTapPips.classList.add('ct-hidden');

    elSealed.classList.add('ct-hidden');
    elClimax.classList.add('ct-hidden');
    elRevealed.classList.remove('ct-hidden');
    elSkipBtn.textContent = L('关闭', 'Close');

    if (isJackpot) {
      elRollTag.textContent = L(`超频逆转 · 前 5% 手气爆棚`, `Overdrive · Top 5% Lucky Roll`);
      elRollTag.className = 'ct-tag is-jackpot';
    } else if (isLucky) {
      elRollTag.textContent = L('高区加赠 · 手气极佳', 'High Bonus · Lucky Roll');
      elRollTag.className = 'ct-tag is-lucky';
    } else if (openedCount > 1) {
      elRollTag.textContent = L(`已一键开启 ${openedCount} 个宝箱`, `Opened ${openedCount} Chests`);
      elRollTag.className = 'ct-tag';
    } else {
      elRollTag.textContent = hasPaidSplit
        ? L('保底 + 随机加赠', 'Base + Random Bonus')
        : L('宝箱奖励已开启', 'Chest Reward Opened');
      elRollTag.className = 'ct-tag';
    }

    A9Haptic.success();
    A9Audio.chestGrandBurst(tierKey, isJackpot, targetCoinCount);
    if (!immediate) spawnGrandBurstFx();

    if (immediate || reducedMotion) {
      elRoller.textContent = `+${formatNum(roundedTotal, 0)}`;
      if (elResBonus) elResBonus.textContent = `+${formatNum(resolvedBonusA9, 0)} A9`;
      elWalletToast.textContent = L(`已入账 +${formatNum(roundedTotal, 0)} A9`, `Credited +${formatNum(roundedTotal, 0)} A9`);
      return;
    }

    if (hasPaidSplit) {
      elRoller.textContent = `+${formatNum(resolvedBaseA9, 0)}`;
      elWalletToast.textContent = L('保底入账，加赠合体中…', 'Merging random bonus…');
      schedule(() => {
        if (elResBonus) elResBonus.textContent = `+${formatNum(resolvedBonusA9, 0)} A9`;
        if (elBonusCard) {
          elBonusCard.style.transform = 'scale(1.06)';
          schedule(() => { elBonusCard.style.transform = 'scale(1)'; }, 220);
        }
        const start = performance.now();
        const dur = isJackpot ? 660 : 460;
        const step = (now) => {
          if (destroyed || !elShell.isConnected) return;
          const p = Math.min(1, (now - start) / dur);
          const eased = 1 - Math.pow(1 - p, 3.2);
          elRoller.textContent = `+${formatNum(Math.round(resolvedBaseA9 + resolvedBonusA9 * eased), 0)}`;
          if (p < 1) {
            rollRaf = requestAnimationFrame(step);
          } else {
            elRoller.textContent = `+${formatNum(roundedTotal, 0)}`;
            elRoller.classList.remove('num-bump');
            void elRoller.offsetWidth;
            elRoller.classList.add('num-bump');
            A9Audio.chestBonusMerge();
            elWalletToast.textContent = L(`已 1 笔直发 +${formatNum(roundedTotal, 0)} A9`, `Paid +${formatNum(roundedTotal, 0)} A9`);
          }
        };
        rollRaf = requestAnimationFrame(step);
      }, 360);
    } else {
      const start = performance.now();
      const dur = 480;
      const step = (now) => {
        if (destroyed || !elShell.isConnected) return;
        const p = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        elRoller.textContent = `+${formatNum(Math.round(roundedTotal * eased), 0)}`;
        if (p < 1) {
          rollRaf = requestAnimationFrame(step);
        } else {
          elRoller.textContent = `+${formatNum(roundedTotal, 0)}`;
          elRoller.classList.remove('num-bump');
          void elRoller.offsetWidth;
          elRoller.classList.add('num-bump');
          A9Audio.chestBonusMerge();
          elWalletToast.textContent = L(`已入账 +${formatNum(roundedTotal, 0)} A9`, `Credited +${formatNum(roundedTotal, 0)} A9`);
        }
      };
      rollRaf = requestAnimationFrame(step);
    }
  }

  function enterClimaxAndBurst() {
    if (phase !== 'idle') return;
    if (reducedMotion) {
      revealBurst(true);
      return;
    }
    phase = 'climax';
    elSealed.classList.add('ct-hidden');
    elClimax.classList.remove('ct-hidden');
    elClimaxTitle.textContent = L('破封临界！', 'BREAKING SEAL!');
    elClimaxSub.textContent = L('能量蓄满揭晓中…', 'Unleashing reward…');
    elShell.classList.add('is-cinema', 'cam-step-3');
    elRig.className = `ct-rig sm-hitstop tier-${tierKey}`;

    const fakeoutExtraMs = isJackpot ? 490 : 0;
    if (isJackpot) {
      schedule(() => {
        elShell.classList.add('is-fakeout');
        elRig.className = `ct-rig sm-fakeout tier-${tierKey}`;
        elFakeoutBanner.classList.remove('show');
        void elFakeoutBanner.offsetWidth;
        elFakeoutBanner.classList.add('show');
        elClimaxTitle.textContent = L('超频逆转 · 前 5% 金光觉醒！', 'OVERDRIVE · TOP 5% AWAKENING!');
        elClimaxSub.textContent = L(`金币加码至 ${spec.jackpotCoins} 枚瀑布喷发！`, `${spec.jackpotCoins}-coin cascade unlocked!`);
        A9Haptic.heavy?.() || A9Haptic.medium?.() || A9Haptic.light();
        A9Audio.chestFakeoutUpgrade();
        spawnTapSparks(3);
      }, spec.hitstopMs);
    }

    schedule(() => revealBurst(false), spec.hitstopMs + fakeoutExtraMs);
  }

  function handleTapStrike() {
    if (phase !== 'idle') return;
    taps += 1;
    renderTapPips();
    setRingProgress(taps / spec.tapsNeeded);
    A9Haptic.light();
    A9Audio.chestTapStrike(taps, tierKey, spec.leakCoinsPerTap);
    spawnTapSparks(taps);

    elRigWrap.classList.remove('pedestal-impact');
    void elRigWrap.offsetWidth;
    elRigWrap.classList.add('pedestal-impact');

    elShell.classList.remove('shake-tap', 'cam-step-1', 'cam-step-2', 'cam-step-3');
    void elShell.offsetWidth;
    elShell.classList.add('shake-tap', `cam-step-${Math.min(3, taps)}`);
    if (taps >= 2 && spec.cinema) elShell.classList.add('is-cinema');

    if (taps < spec.tapsNeeded) {
      const crackCls = taps === 1 ? 'crack-1' : 'crack-2';
      const hitCls = taps % 2 === 1 ? 'tap-hit-l' : 'tap-hit-r';
      elRig.className = `ct-rig sm-idle ${crackCls} ${hitCls} tier-${tierKey}`;
      updateSealedCopy();
      elWalletToast.textContent = L(`已敲 ${taps}/${spec.tapsNeeded} 下`, `Tap ${taps}/${spec.tapsNeeded}`);
      schedule(() => elRig.classList.remove('tap-hit-l', 'tap-hit-r'), 280);
      return;
    }
    enterClimaxAndBurst();
  }

  function startHold(e) {
    if (phase !== 'idle') return;
    if (e.type === 'mousedown' && e.button !== 0) return;
    if (holdRaf) { cancelAnimationFrame(holdRaf); holdRaf = 0; }
    holdStart = performance.now();
    let promoted = false;
    const basePct = taps / spec.tapsNeeded;

    const tickHold = (now) => {
      if (destroyed || phase !== 'idle' || !holdStart) return;
      const elapsed = now - holdStart;
      if (elapsed > 140 && !promoted) {
        promoted = true;
        elRig.className = `ct-rig sm-holding crack-2 tier-${tierKey}`;
        if (spec.cinema) elShell.classList.add('is-cinema');
        elShell.classList.add('cam-step-2');
        A9Haptic.light();
        A9Audio.chestTapStrike(Math.max(1, taps + 1), tierKey, spec.leakCoinsPerTap);
      }
      if (promoted) {
        const pct = Math.min(1, basePct + (elapsed - 140) / spec.holdMs);
        setRingProgress(pct);
        elWalletToast.textContent = `${L('蓄力', 'Charge')} ${Math.round(pct * 100)}%`;
        if (pct >= 1) {
          holdStart = 0;
          holdRaf = 0;
          taps = spec.tapsNeeded;
          renderTapPips();
          enterClimaxAndBurst();
          return;
        }
      }
      holdRaf = requestAnimationFrame(tickHold);
    };
    holdRaf = requestAnimationFrame(tickHold);
  }

  function endHold(triggerTapIfShort) {
    if (!holdStart) return;
    const elapsed = performance.now() - holdStart;
    holdStart = 0;
    if (holdRaf) { cancelAnimationFrame(holdRaf); holdRaf = 0; }
    if (phase !== 'idle') return;
    if (elapsed <= 165 && triggerTapIfShort) {
      handleTapStrike();
    } else {
      const crackCls = taps === 1 ? 'crack-1' : taps >= 2 ? 'crack-2' : '';
      elRig.className = `ct-rig sm-idle ${crackCls} tier-${tierKey}`;
      setRingProgress(taps / spec.tapsNeeded);
    }
  }

  // 绑定交互事件（含 touchcancel 与主按钮键盘支持，避免来电/手势中断卡死蓄力态）
  [elRig, elBtnOpen].forEach((el) => {
    el.addEventListener('mousedown', startHold);
    el.addEventListener('mouseup', () => endHold(true));
    el.addEventListener('mouseleave', () => endHold(false));
    el.addEventListener('touchstart', (e) => { e.preventDefault(); startHold(e); }, { passive: false });
    el.addEventListener('touchend', (e) => { e.preventDefault(); endHold(true); }, { passive: false });
    el.addEventListener('touchcancel', () => endHold(false));
  });
  const onStrikeKeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleTapStrike();
    }
  };
  elRig.onkeydown = onStrikeKeydown;
  elBtnOpen.onkeydown = onStrikeKeydown;

  elSoundBtn.onclick = () => {
    const on = A9Audio.toggle();
    elSoundBtn.textContent = on ? L('音效开', 'SFX ON') : L('静音', 'MUTED');
  };

  elSkipBtn.onclick = () => {
    if (phase === 'burst') {
      cleanup();
      closeModal();
      return;
    }
    timers.forEach((id) => clearTimeout(id));
    timers.length = 0;
    if (holdRaf) { cancelAnimationFrame(holdRaf); holdRaf = 0; }
    holdStart = 0;
    revealBurst(true);
  };

  const stakeBtn = document.getElementById('ct-btn-stake');
  if (stakeBtn) {
    stakeBtn.onclick = () => {
      A9Haptic.light();
      cleanup();
      closeModal();
      window.location.hash = roundedTotal > 0 ? `#/challenge/confirm?amt=${roundedTotal}` : '#/challenge/confirm';
    };
  }
  const collectBtn = document.getElementById('ct-btn-collect');
  if (collectBtn) {
    collectBtn.onclick = () => {
      A9Haptic.light();
      cleanup();
      closeModal();
    };
  }
  const shareBtn = document.getElementById('ct-btn-share');
  if (shareBtn) {
    shareBtn.onclick = () => {
      A9Haptic.light();
      const linkUrl = buildTmaDeepLink(`market_${getShareRef()}`);
      const copy = L(
        `手气爆棚！刚在 A9 宝箱商城开出 ${formatNum(roundedTotal, 0)} A9（保底 + 随机加赠合并直发钱包），0.99 GRAM 起试试手气：`,
        `Lucky roll! Just unboxed ${formatNum(roundedTotal, 0)} A9 in A9 Chest Mall (base + random bonus paid directly to wallet). Try from 0.99 GRAM:`
      );
      A9TMA.shareInvite(linkUrl, copy);
      showToast(L('已调起 Telegram 分享开箱喜报', 'Opened Telegram unboxing share'));
    };
  }

  window.addEventListener('resize', resizeCanvases);
  window.addEventListener('a9:interaction-idle', cleanup);

  // 初始化舞台：天降砸台入场 + 底座微沉落尘 + 环境粒子漂浮
  renderTapPips();
  updateSealedCopy();
  resizeCanvases();
  initAmbient();
  if (!reducedMotion) ambRaf = requestAnimationFrame(tickAmbient);

  if (reducedMotion) {
    elRig.className = `ct-rig sm-idle tier-${tierKey}`;
  } else {
    A9Audio.chestDropSlam(tierKey);
    schedule(() => {
      elRigWrap.classList.add('pedestal-impact');
      spawnLandingDust();
    }, 220);
    schedule(() => {
      elRigWrap.classList.remove('pedestal-impact');
      if (phase === 'idle' && taps === 0) {
        elRig.className = `ct-rig sm-idle tier-${tierKey}`;
      }
    }, 500);
  }
}
