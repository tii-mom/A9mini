/**
 * A9 Quest 公共视觉与安全格式化工具
 * - 严格防护 Number(null) === 0：缺值 / 非有限数值一律展示 '—' 或明确提示
 * - 零 Emoji：全部使用线性 SVG 与宝箱矢量图
 * - 弹层挂载于 #modal-root，自动兼容 tx-ux.js 的 shouldDeferRouteRender
 */

import { escapeHtml, formatNum, formatTimer, openModal, closeModal } from '../components.js';
import { L } from '../i18n.js';

const QUEST_SVG_PATHS = {
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  vault: '<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><circle cx="12" cy="12" r="3.4"/><path d="M12 8.6V7.4M15.4 12h1.2M7 19.5V21M17 19.5V21"/>',
  chest: '<path d="M4 11h16v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="M4 11a8 6 0 0 1 16 0"/><path d="M10 11v3h4v-3"/>',
  team: '<circle cx="9" cy="8" r="3.3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17.2" cy="9" r="2.6"/><path d="M15.8 14.3A5 5 0 0 1 21 19.5"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="3.5"/><path d="M3 10.5h18"/><circle cx="16.5" cy="15.2" r="1.2" fill="currentColor"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 7.6-1.8"/>',
  chevR: '<path d="M9 6l6 6-6 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M9.5 17h5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-4.5"/>',
  chart: '<path d="M4 19h16"/><path d="M6 15l4-4 3 3 5-6"/>',
  exit: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5V5.5M9 8h6"/>',
  gift: '<rect x="3" y="8" width="18" height="5" rx="1.5"/><path d="M5 13v7h14v-7M12 8v12M12 8c-2-4-6-4-6-1.5S9.5 8 12 8zM12 8c2-4 6-4 6-1.5S14.5 8 12 8z"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
};

export function qIcon(name, size = 18, sw = 2) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${QUEST_SVG_PATHS[name] || ''}</svg>`;
}

export const CHEST_TIER_PALETTE = Object.freeze({
  bronze:    { body: '#D0813F', dark: '#8E4E1F', trim: '#F6C08A', soft: 'rgba(208,129,63,.22)', glow: '#3B1D0A' },
  silver:    { body: '#B4BECB', dark: '#6C7889', trim: '#F2F5F9', soft: 'rgba(150,165,185,.25)', glow: '#1E2530' },
  gold:      { body: '#FFC21A', dark: '#C08200', trim: '#FFF1B3', soft: 'rgba(255,194,26,.28)', glow: '#3D2A00' },
  platinum:  { body: '#6FD0C4', dark: '#2F877D', trim: '#E2FFFB', soft: 'rgba(111,208,196,.26)', glow: '#0B2E2A' },
  diamond:   { body: '#3AA6FF', dark: '#155EBA', trim: '#D3EDFF', soft: 'rgba(58,166,255,.25)', glow: '#0A2140' },
  legendary: { body: '#E60012', dark: '#850009', trim: '#FFD44D', soft: 'rgba(230,0,18,.22)', glow: '#4A0B14' },
});

let chestSvgSeq = 0;
export function chestArtSvg(tier = 'gold', w = 96) {
  const key = String(tier || 'gold').toLowerCase();
  const c = CHEST_TIER_PALETTE[key] || CHEST_TIER_PALETTE.gold;
  const clipId = `qcl_${++chestSvgSeq}`;
  const h = Math.round((w * 112) / 120);
  const gem = (key === 'legendary' || key === 'diamond')
    ? `<path d="M60 44l4 4-4 5-4-5z" fill="${key === 'legendary' ? '#FFD44D' : '#FFFFFF'}"/>`
    : `<circle cx="60" cy="51" r="3" fill="${c.dark}"/><rect x="58.5" y="52" width="3" height="6.5" rx="1.5" fill="${c.dark}"/>`;
  return `<svg class="chest-svg" viewBox="0 0 120 112" width="${w}" height="${h}" aria-hidden="true">
    <defs><clipPath id="${clipId}"><path d="M14 52V38a46 26 0 0 1 92 0v14z"/></clipPath></defs>
    <ellipse cx="60" cy="104" rx="44" ry="6" fill="rgba(0,0,0,.18)"/>
    <rect x="14" y="52" width="92" height="48" rx="10" fill="${c.dark}"/>
    <rect x="14" y="50" width="92" height="44" rx="10" fill="${c.body}"/>
    <rect x="14" y="50" width="92" height="8" fill="${c.dark}" opacity=".35"/>
    <rect x="26" y="50" width="10" height="44" fill="${c.trim}" opacity=".92"/>
    <rect x="84" y="50" width="10" height="44" fill="${c.trim}" opacity=".92"/>
    <g class="lid">
      <path d="M14 52V38a46 26 0 0 1 92 0v14z" fill="${c.body}"/>
      <g clip-path="url(#${clipId})"><rect x="26" y="8" width="10" height="46" fill="${c.trim}" opacity=".92"/><rect x="84" y="8" width="10" height="46" fill="${c.trim}" opacity=".92"/><rect x="14" y="46" width="92" height="6" fill="${c.dark}" opacity=".45"/></g>
      <path d="M24 32q16-14 36-15" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="4" stroke-linecap="round"/>
    </g>
    <rect x="50" y="42" width="20" height="23" rx="5.5" fill="${c.trim}" stroke="${c.dark}" stroke-width="2.5"/>
    ${gem}
  </svg>`;
}

/** 严格 null 防护：null/undefined/''/NaN 永不转换为 0。 */
export function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function fmtExactA9(value, { decimals = null, loading = false, unavailable = false } = {}) {
  const n = finiteOrNull(value);
  if (n === null) {
    if (loading) return L('加载中…', 'Loading…');
    if (unavailable) return L('暂不可用', 'Unavailable');
    return '—';
  }
  const d = decimals !== null ? decimals : (Math.abs(n % 1) < 1e-9 ? 0 : 2);
  return `${formatNum(n, d)} A9`;
}

export function fmtIntOrDash(value) {
  const n = finiteOrNull(value);
  if (n === null) return '—';
  return formatNum(Math.floor(n + 1e-9), 0);
}

export function fmtUsdOrDash(value, digits = 6) {
  const n = finiteOrNull(value);
  if (n === null || n <= 0) return '—';
  return `$${n.toFixed(digits)}`;
}

/** 倒计时格式化：countdownMs <= 0 或缺失时绝不显示 00:00:00，必须返回明确状态文案。 */
export function fmtStageCountdown(countdownMs, fallbackLabel = '') {
  const ms = finiteOrNull(countdownMs);
  if (ms === null || ms <= 0) {
    return fallbackLabel || L('待确认', 'Pending');
  }
  const sec = Math.ceil(ms / 1000);
  if (sec <= 0) return fallbackLabel || L('待确认', 'Pending');
  return formatTimer(sec);
}

/** 打开 Quest 风格底部弹层（复用 #modal-root，自动触发 shouldDeferRouteRender）。 */
export function openQuestSheet(title, bodyHtml, { badgeHtml = '', footHtml = '' } = {}) {
  openModal(`
    <div class="sheet-handle"></div>
    <div class="row-between" style="margin-bottom:12px;">
      <div class="card-title" style="font-size:17px;">${escapeHtml(title)}</div>
      <div class="row-start" style="gap:6px;">
        ${badgeHtml}
        <button class="icon-btn" id="q-sheet-close" type="button" aria-label="${L('关闭', 'Close')}">${qIcon('x', 16)}</button>
      </div>
    </div>
    ${bodyHtml}
    ${footHtml ? `<div class="sh-foot">${footHtml}</div>` : ''}
  `);
  const closeBtn = typeof document !== 'undefined' ? document.getElementById('q-sheet-close') : null;
  if (closeBtn) closeBtn.onclick = () => closeModal();
}

export { closeModal as closeQuestSheet };
