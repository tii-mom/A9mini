/**
 * A9 Precision Components (Engineering Spec v2)
 * - Signature 24H Qualification Slot Matrix (2x12, 4 shape/color states, in-place diffing)
 * - Multimodal 3-Moment Slider (rAF-throttled, single 80% threshold tick, 180ms rebound, keyboard accessible)
 * - Clean listener & rAF lifecycle teardown
 */

import { A9Haptic } from './tma.js';
import { A9Audio } from './audio.js';
import { icon } from './icons.js';
import { L } from './i18n.js';

let activeSliderAbort = null;
let activeSliderRaf = 0;

export function cleanupActiveInteractions() {
  if (activeSliderRaf) {
    cancelAnimationFrame(activeSliderRaf);
    activeSliderRaf = 0;
  }
  if (activeSliderAbort) {
    activeSliderAbort.abort();
    activeSliderAbort = null;
  }
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatNum(n, decimals = 0) {
  const num = Number(n);
  if (n === null || n === undefined || n === '' || !Number.isFinite(num)) return '—';
  const safe = num;
  return safe.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

export function formatTimer(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

export function burstParticles(originEl) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const rect = originEl?.getBoundingClientRect();
  const cx = rect ? rect.left + rect.width * 0.8 : window.innerWidth / 2;
  const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
  const colors = ['#E60012', '#F2B21B', '#14B064', '#2F80ED'];

  for (let i = 0; i < 12; i++) {
    const p = document.createElement('span');
    p.className = 'spark-particle';
    const angle = (Math.PI * 2 * i) / 12 + (Math.random() - 0.5) * 0.35;
    const dist = 32 + Math.random() * 44;
    p.style.left = `${cx}px`;
    p.style.top = `${cy}px`;
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--tx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--ty', `${Math.sin(angle) * dist}px`);
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 580);
  }
}



export function showToast(message, type = 'success') {
  const root = document.getElementById('toast-container');
  if (!root) return;
  if (type === 'error') A9Audio.error();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = type === 'error'
    ? icon('shieldAlert', 15, 'text-red')
    : type === 'amber'
      ? icon('alert', 15, 'text-gold')
      : icon('bolt', 15, 'text-green');
  el.innerHTML = `${ic}<span>${escapeHtml(message)}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 180ms ease';
    setTimeout(() => el.remove(), 200);
  }, 2400);
}

function legacyCopy(str) {
  try {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

export function copyText(text, label) {
  A9Haptic.light();
  const str = String(text ?? '');
  const prefix = label || L('已复制', 'Copied');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(str).then(
      () => showToast(`${prefix}: ${str}`),
      () => {
        legacyCopy(str);
        showToast(`${prefix}: ${str}`);
      }
    );
  } else {
    legacyCopy(str);
    showToast(`${prefix}: ${str}`);
  }
}

export function openModal(html) {
  const root = document.getElementById('modal-root');
  if (!root) return;
  root.innerHTML = `<div class="modal-sheet">${html}</div>`;
  root.classList.remove('hidden');
  root.onclick = (e) => {
    if (e.target === root) closeModal();
  };
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

export function closeModal() {
  const root = document.getElementById('modal-root');
  if (!root) return;
  root.classList.add('hidden');
  root.innerHTML = '';
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('a9:interaction-idle'));
  }
}

export function openChoiceSheet({ title, options, selected, onSelect }) {
  A9Haptic.light();
  openModal(`
    <div class="sheet-handle"></div>
    <div class="row-between">
      <div class="card-title">${escapeHtml(title)}</div>
      <button class="icon-btn" id="sheet-close" aria-label="Close">${icon('x', 15)}</button>
    </div>
    <div class="col-gap">
      ${options.map(opt => `
        <div class="list-row clickable ${opt.value === selected ? 'is-me' : ''}" data-choice-val="${escapeHtml(opt.value)}">
          <div>
            <div style="font-weight:600;font-size:13.5px;">${escapeHtml(opt.label)}</div>
            ${opt.sub ? `<div class="num-xs text-muted" style="margin-top:2px;">${escapeHtml(opt.sub)}</div>` : ''}
          </div>
          ${opt.value === selected ? `<span class="text-green">${icon('check', 16)}</span>` : ''}
        </div>
      `).join('')}
    </div>
  `);
  const closeBtn = document.getElementById('sheet-close');
  if (closeBtn) closeBtn.onclick = closeModal;
  document.querySelectorAll('[data-choice-val]').forEach(row => {
    row.onclick = () => {
      A9Haptic.tick();
      const val = row.dataset.choiceVal;
      closeModal();
      if (onSelect) onSelect(val);
    };
  });
}

export function renderProgressRing(pct, label, color = 'var(--green)') {
  const r = 24;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return `
    <div class="ring-wrap">
      <svg width="58" height="58" viewBox="0 0 58 58">
        <circle cx="29" cy="29" r="${r}" fill="none" stroke="var(--ring-track)" stroke-width="4.5"/>
        <circle cx="29" cy="29" r="${r}" fill="none" stroke="${color}" stroke-width="4.5" stroke-linecap="round"
          stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
      </svg>
      <span class="ring-label">${label}</span>
    </div>
  `;
}

export function buildSparklineSvgPath(points = [0.1862, 0.1871, 0.1865, 0.1884, 0.1896, 0.1910]) {
  const w = 86;
  const h = 28;
  const rawMin = Math.min(...points);
  const rawMax = Math.max(...points);
  const pad = Math.max((rawMax - rawMin) * 0.28, Math.abs(rawMax) * 0.004, 1e-6);
  const min = rawMin - pad;
  const max = rawMax + pad;
  const span = Math.max(1e-6, max - min);
  const coords = points.map((v, i) => {
    const x = 2 + (i / Math.max(1, points.length - 1)) * (w - 6);
    const y = h - 4 - ((v - min) / span) * (h - 8);
    return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) };
  });
  const line = coords.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x} ${pt.y}`).join(' ');
  const last = coords[coords.length - 1];
  const area = `${line} L${last.x} ${h} L${coords[0].x} ${h} Z`;
  return { line, area, last };
}

export function renderLiveSparkline(points) {
  const { line, area, last } = buildSparklineSvgPath(points);
  return `
    <svg class="sparkline-svg" id="live-sparkline-svg" viewBox="0 0 88 30" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="a9-spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--green)" stop-opacity="0.20"/>
          <stop offset="100%" stop-color="var(--green)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path id="spark-area" d="${area}" fill="url(#a9-spark-grad)"/>
      <path id="spark-line" d="${line}" stroke="var(--green)" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>
      <circle id="spark-dot" cx="${last.x}" cy="${last.y}" r="2.8" fill="var(--green)"/>
    </svg>
  `;
}

/**
 * 3-Moment Interactive Slider（木质棘轮拟音 + 每 10% 震动同步 + 实时进度回调 + 初始零毛边）
 */
export function mountSlider(containerEl, { label = '右滑确认', onConfirm, onProgress = null, silentConfirmAudio = false }) {
  if (!containerEl) return;
  cleanupActiveInteractions();
  activeSliderAbort = new AbortController();
  const { signal } = activeSliderAbort;

  containerEl.innerHTML = `
    <div class="a9-slider">
      <div class="a9-slider-fill"></div>
      <div class="a9-slider-label">
        <span class="slider-text">${escapeHtml(label)}</span>
        <span class="chevron-seq text-green"><span>›</span><span>›</span><span>›</span></span>
      </div>
      <div class="a9-slider-handle" role="slider" tabindex="0" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">${icon('arrowRight', 19)}</div>
    </div>
  `;

  const slider = containerEl.querySelector('.a9-slider');
  const handle = containerEl.querySelector('.a9-slider-handle');
  const fill = containerEl.querySelector('.a9-slider-fill');
  const labelEl = containerEl.querySelector('.a9-slider-label');

  const SNAP_THRESHOLD = 0.80;
  const SPRING_EASING = 'cubic-bezier(0.22, 1.2, 0.36, 1.0)';
  const REBOUND_MS = 180;
  const SNAP_MS = 150;

  let dragging = false;
  let completed = false;
  let armedNotified = false;
  let lastRatchetStep = 0;
  let startX = 0;
  let maxDrag = 0;
  let latestX = 0;
  let progress = 0;

  const getClientX = (e) => (e.touches ? e.touches[0].clientX : e.clientX);

  const commitConfirm = () => {
    if (completed) return;
    completed = true;
    maxDrag = Math.max(1, slider.clientWidth - handle.clientWidth - 8);
    handle.style.transition = `left ${SNAP_MS}ms cubic-bezier(0, 0, 0.2, 1), transform ${SNAP_MS}ms ease`;
    fill.style.transition = `width ${SNAP_MS}ms cubic-bezier(0, 0, 0.2, 1)`;
    handle.style.left = `${maxDrag + 4}px`;
    fill.style.width = '100%';
    handle.style.transform = 'scale(1)';
    handle.innerHTML = icon('check', 19);
    labelEl.textContent = L('确认中…', 'Confirming…');
    slider.classList.remove('armed', 'dragging');
    slider.classList.add('completed');
    if (onProgress) onProgress(1);
    burstParticles(slider);
    A9Haptic.success();
    if (!silentConfirmAudio) A9Audio.confirm();
    setTimeout(() => onConfirm && onConfirm(), 180);
  };

  const paintFrame = () => {
    activeSliderRaf = 0;
    if (!dragging || completed) return;
    const delta = Math.max(0, Math.min(latestX - startX, maxDrag));
    progress = delta / maxDrag;
    handle.style.left = `${delta + 4}px`;
    fill.style.width = `${(progress * 100).toFixed(1)}%`;
    handle.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    if (onProgress) onProgress(progress);

    // 每经过 10% 刻度触发木质棘轮咔哒声 + 轻触觉震动
    const ratchetStep = Math.floor(progress * 10);
    if (ratchetStep > lastRatchetStep && ratchetStep >= 1 && ratchetStep <= 9) {
      lastRatchetStep = ratchetStep;
      A9Haptic.tick();
      A9Audio.ratchet(ratchetStep);
    } else if (ratchetStep < lastRatchetStep) {
      lastRatchetStep = ratchetStep;
    }

    const isArmed = progress >= SNAP_THRESHOLD;
    if (isArmed && !slider.classList.contains('armed')) {
      slider.classList.add('armed');
      const txt = labelEl.querySelector('.slider-text');
      if (txt) {
        if (!txt.dataset.orig) txt.dataset.orig = txt.textContent;
        txt.textContent = L('松手确认', 'Release to Confirm');
      }
      if (!armedNotified) {
        armedNotified = true;
        A9Haptic.medium();
      }
    } else if (!isArmed && slider.classList.contains('armed')) {
      slider.classList.remove('armed');
      const txt = labelEl.querySelector('.slider-text');
      if (txt && txt.dataset.orig) txt.textContent = txt.dataset.orig;
    }
  };

  const onStart = (e) => {
    if (completed) return;
    dragging = true;
    armedNotified = false;
    lastRatchetStep = 0;
    startX = getClientX(e);
    latestX = startX;
    maxDrag = Math.max(1, slider.clientWidth - handle.clientWidth - 8);
    slider.classList.add('dragging');
    handle.style.transition = 'none';
    fill.style.transition = 'none';
    handle.style.transform = 'scale(0.95)';
    A9Haptic.light();
  };

  const onMove = (e) => {
    if (!dragging || completed) return;
    latestX = getClientX(e);
    if (!activeSliderRaf) {
      activeSliderRaf = requestAnimationFrame(paintFrame);
    }
  };

  const onEnd = () => {
    if (!dragging || completed) return;
    dragging = false;
    if (activeSliderRaf) {
      cancelAnimationFrame(activeSliderRaf);
      activeSliderRaf = 0;
    }

    if (progress >= SNAP_THRESHOLD) {
      commitConfirm();
    } else {
      handle.style.transition = `left ${REBOUND_MS}ms ${SPRING_EASING}, transform 120ms ease`;
      fill.style.transition = `width ${REBOUND_MS}ms ${SPRING_EASING}`;
      handle.style.left = '4px';
      fill.style.width = '0%';
      handle.style.transform = 'scale(1)';
      progress = 0;
      armedNotified = false;
      lastRatchetStep = 0;
      slider.classList.remove('armed', 'dragging');
      if (onProgress) onProgress(0);
      const txt = labelEl.querySelector('.slider-text');
      if (txt && txt.dataset.orig) txt.textContent = txt.dataset.orig;
    }
  };

  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commitConfirm();
    }
  }, { signal });

  handle.addEventListener('mousedown', onStart, { signal });
  handle.addEventListener('touchstart', onStart, { passive: true, signal });
  window.addEventListener('mousemove', onMove, { signal });
  window.addEventListener('touchmove', onMove, { passive: true, signal });
  window.addEventListener('mouseup', onEnd, { signal });
  window.addEventListener('touchend', onEnd, { signal });
}

export function animateSlotCounter(el, target, { duration = 420, decimals = 0, prefix = '', suffix = '' } = {}) {
  if (!el) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = `${prefix}${formatNum(target, decimals)}${suffix}`;
    return;
  }
  const t0 = performance.now();
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);
  function frame(now) {
    const p = Math.min(1, (now - t0) / duration);
    el.textContent = `${prefix}${formatNum(target * easeOut(p), decimals)}${suffix}`;
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** 领奖开箱抛物线金币动画（由宝箱飞向目标金额胶囊，尊重 reduced-motion） */
export function launchCoinArc(fromEl, toEl, count = 6) {
  if (!fromEl || !toEl) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const from = fromEl.getBoundingClientRect();
  const to = toEl.getBoundingClientRect();
  const sx = from.left + from.width / 2;
  const sy = from.top + from.height * 0.42;
  const dx = (to.left + to.width / 2) - sx;
  const dy = (to.top + to.height / 2) - sy;

  for (let i = 0; i < count; i++) {
    const coin = document.createElement('span');
    coin.className = 'flying-coin';
    coin.textContent = 'A9';
    const spread = (i - (count - 1) / 2) * 26;
    coin.style.left = `${sx - 12}px`;
    coin.style.top = `${sy - 12}px`;
    coin.style.setProperty('--mx', `${spread}px`);
    coin.style.setProperty('--my', `${-44 - (i % 3) * 18}px`);
    coin.style.setProperty('--tx', `${dx + spread * 0.16}px`);
    coin.style.setProperty('--ty', `${dy}px`);
    coin.style.animationDelay = `${i * 48}ms`;
    document.body.appendChild(coin);
    setTimeout(() => coin.remove(), 740 + i * 48);
  }
}

/**
 * A9 标志性 24H 手盖圆章观测矩阵 (4x6)
 * - 双分母顶标：已确认 X/24 · 已达标 Y/16
 * - 每格同时用编号 + 几何状态符号（✓ 达标 / × 未达标 / ◉ 观察中青蓝 / · 未开始），颜色只作辅助
 * - 固定高度底部判定依据栏：并列展示本段均价、目标底价与明确结论，切格绝不跳动
 */
function slotSymbol(status, bull) {
  if (status === 'pending') return '·';
  if (status === 'active') return '◉';
  return bull ? '✓' : '×';
}

function buildInspectorHtml(slotInfo, targetPrice, activeCandleSec) {
  const targetStr = targetPrice === null || targetPrice === undefined || !Number.isFinite(Number(targetPrice)) || Number(targetPrice) <= 0
    ? L('待定', 'TBD') : `$${Number(targetPrice).toFixed(4)}`;
  const idx = slotInfo.index;
  const status = slotInfo.status;
  const confirmed = status === 'closed';
  const bull = Boolean(slotInfo.bull);
  const priceStr = slotInfo.priceText;

  let verdictText = L('尚未开始', 'Upcoming');
  let verdictCls = 'text-muted';
  let explain = L('等待到达该时段后再开始采集判定均价', 'Awaiting slot window');

  if (confirmed) {
    if (bull) {
      verdictText = L('已核验达标 ✓', 'Met ✓');
      verdictCls = 'text-green';
      explain = `${L('本段均价', 'Slot')} ${priceStr} ≥ ${L('目标', 'Target')} ${targetStr}`;
    } else {
      verdictText = L('已确认未达标 ×', 'Missed ×');
      verdictCls = 'text-red';
      explain = `${L('本段均价', 'Slot')} ${priceStr} < ${L('目标', 'Target')} ${targetStr}`;
    }
  } else if (status === 'active') {
    verdictText = L('观察中 · 待确认', 'Observing · pending');
    verdictCls = 'text-cyan';
    explain = `${L('当前均价', 'Now')} ${priceStr} · ${L('目标', 'Target')} ${targetStr}`;
  } else if (status === 'unknown') {
    verdictText = L('数据待核验', 'Awaiting verification');
    verdictCls = 'text-muted';
    explain = L('该时段数据暂缺，请稍后重试核验', 'Slot data pending verification');
  }

  const rightTimer = status === 'active'
    ? `<span class="text-cyan mono" id="active-candle-cd">${L('剩余', 'Left')} ${formatTimer(activeCandleSec || 0).slice(3)}</span>`
    : `<span class="mono ${verdictCls}">${verdictText}</span>`;

  return `
    <div class="inspector-top">
      <span>${L(`第 ${idx} 时段`, `Slot #${idx}`)}</span>
      ${rightTimer}
    </div>
    <div class="inspector-basis">
      <span>${explain}</span>
      ${status === 'active' ? `<span class="text-cyan">${L('整点盖章', 'Hourly seal')}</span>` : ''}
    </div>
  `;
}

export function renderCorridorRadar(candles, targetPrice, activeCandleSec, livePrice, meta = {}) {
  const required = Number(meta.minQualified) || 16;
  const passed = Number.isFinite(meta.qualified) ? Number(meta.qualified)
    : candles.filter(c => c.status === 'closed' && c.bull).length;
  const confirmedSlots = candles.filter(c => c.status === 'closed').length;
  const activeCandle = candles.find(c => c.status === 'active');
  const defaultSlot = activeCandle || candles[Math.max(0, confirmedSlots - 1)] || candles[0] || { index: 1, status: 'pending', p: null, bull: false };
  const priceText = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)))
    ? L('待核验', 'Pending') : `$${Number(v).toFixed(4)}`;
  const targetStr = (targetPrice === null || targetPrice === undefined || !Number.isFinite(Number(targetPrice)) || Number(targetPrice) <= 0)
    ? L('待定', 'TBD') : `$${Number(targetPrice).toFixed(4)}`;

  const cellsHtml = candles.map(c => {
    const cls = c.status === 'pending'
      ? 'pending'
      : c.status === 'active'
        ? 'active'
        : (c.bull ? 'bull' : 'bear');
    const isSel = c.index === defaultSlot.index;
    const pText = c.p === null || c.p === undefined ? L('未开始', 'Pending') : priceText(c.p);
    const sym = slotSymbol(c.status, c.bull);
    return `
      <div class="candle-cell ${cls}${isSel ? ' selected' : ''}" role="button" tabindex="0"
        data-candle-idx="${c.index}"
        data-candle-price="${pText}"
        data-candle-bull="${Boolean(c.bull)}"
        data-candle-status="${c.status}"
        data-candle-confirmed="${c.status === 'closed'}"
        aria-label="${L(`第 ${c.index} 时段`, `Slot ${c.index}`)}">
        <span class="candle-sym" aria-hidden="true">${sym}</span>
        <span class="candle-idx">${String(c.index).padStart(2, '0')}</span>
      </div>
    `;
  }).join('');

  const isMatchPoint = Boolean(meta.sprint4h) || (passed >= Math.max(1, required - 2) && passed < required);
  const sprintBadge = meta.sprint4h
    ? `<span class="chip chip-red" style="height:20px;font-size:10px;padding:0 7px;">${L('最后 4H 冲刺', 'Last 4H')}</span>`
    : (isMatchPoint ? `<span class="chip chip-gold" style="height:20px;font-size:10px;padding:0 7px;">${L('赛点冲刺', 'Match Point')}</span>` : '');

  const initSlotInfo = {
    index: defaultSlot.index,
    status: defaultSlot.status,
    bull: defaultSlot.bull,
    priceText: defaultSlot.p === null || defaultSlot.p === undefined ? L('待核验', 'Pending') : priceText(defaultSlot.p)
  };

  return `
    <div class="card${isMatchPoint ? ' is-matchpoint' : ''}" id="a9-radar-card" data-target-price="${targetPrice ?? ''}">
      <div class="card-header" style="margin-bottom:8px;">
        <div class="row-start" style="gap:6px;flex-wrap:wrap;">
          <div class="card-title">${icon('radar', 15, 'text-cyan')} ${L('24H 观测盘', '24H Observation Board')}</div>
          ${sprintBadge}
        </div>
        <div class="row-start" style="gap:10px;">
          <button class="text-link-btn" type="button" data-x-share="round" style="color:var(--text-secondary);">${icon('xBrand', 12)} ${L('分享', 'Share')}</button>
          <button class="text-link-btn" type="button" data-nav="/observation/records">${L('集章明细', 'Details')} ${icon('chevronRight', 13)}</button>
        </div>
      </div>

      <div class="radar-dual-counts" id="radar-counts">
        <div class="radar-count-box">
          <small>${L('已确认时段', 'Confirmed')}</small>
          <b>${confirmedSlots} / 24</b>
        </div>
        <div class="radar-count-box pass">
          <small>${L('已达标门槛', 'Qualified')}</small>
          <b>${passed} / ${required}</b>
        </div>
      </div>

      <div class="corridor-wrap">
        <div class="candle-grid" id="a9-radar-grid">${cellsHtml}</div>
      </div>

      <div class="candle-inspector" id="candle-inspector" aria-live="polite">
        ${buildInspectorHtml(initSlotInfo, targetPrice, activeCandleSec)}
      </div>

      <div class="radar-legend" aria-hidden="true">
        <span class="legend-item"><span class="legend-dot bull"></span>${L('达标 ✓', 'Met ✓')}</span>
        <span class="legend-item"><span class="legend-dot bear"></span>${L('未达 ×', 'Miss ×')}</span>
        <span class="legend-item"><span class="legend-dot active"></span>${L('观察中 ◉', 'Live ◉')}</span>
        <span class="legend-item"><span class="legend-dot pending"></span>${L('未开始', 'Soon')}</span>
      </div>

      <div class="row-between num-xs text-muted" style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--card-border);">
        <span>${L('目标底价', 'Target')} <b class="mono" style="color:var(--ink);">${targetStr}</b></span>
        <span>${L('判定均价', 'TWAP')} <b class="mono text-green" id="live-twap-val">${priceText(livePrice)}</b></span>
      </div>
    </div>
  `;
}

/**
 * 增量原位更新 24H 观测盘
 * - 平时保持安静，仅当某格真实从 active 转为 closed 时触发短促盖章动画
 */
export function syncRadarInPlace(round, { batch = false } = {}) {
  const grid = document.getElementById('a9-radar-grid');
  if (!grid || !Array.isArray(round.candles)) return;

  const required = round.minQualifiedCandles || 16;
  const passed = round.qualifiedCandles || 0;
  const need = Math.max(0, required - passed);
  const confirmedSlots = round.candles.filter(c => c.status === 'closed').length;
  const priceText = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)))
    ? L('待核验', 'Pending') : `$${Number(v).toFixed(4)}`;

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  round.candles.forEach(c => {
    const cell = grid.querySelector(`[data-candle-idx="${c.index}"]`);
    if (!cell) return;
    const prevStatus = cell.dataset.candleStatus;
    const nextCls = c.status === 'pending' ? 'pending' : c.status === 'active' ? 'active' : (c.bull ? 'bull' : 'bear');
    const wasSelected = cell.classList.contains('selected');

    cell.className = `candle-cell ${nextCls}${wasSelected ? ' selected' : ''}`;
    cell.dataset.candleStatus = c.status;
    cell.dataset.candleBull = String(Boolean(c.bull));
    cell.dataset.candleConfirmed = String(c.status === 'closed');
    cell.dataset.candlePrice = c.p === null || c.p === undefined ? L('未开始', 'Pending') : priceText(c.p);

    const symEl = cell.querySelector('.candle-sym');
    if (symEl) symEl.textContent = slotSymbol(c.status, c.bull);
    const idxEl = cell.querySelector('.candle-idx');
    if (idxEl) idxEl.textContent = String(c.index).padStart(2, '0');

    if (!batch && !reduced && prevStatus === 'active' && c.status === 'closed') {
      cell.classList.add('anim-slot-flip');
      if (c.bull) A9Audio.scaleChime(passed);
      else A9Audio.stamp();
      setTimeout(() => cell.classList.remove('anim-slot-flip'), 360);
    }
  });

  const countsEl = document.getElementById('radar-counts');
  if (countsEl) {
    countsEl.innerHTML = `
      <div class="radar-count-box">
        <small>${L('已确认时段', 'Confirmed')}</small>
        <b>${confirmedSlots} / 24</b>
      </div>
      <div class="radar-count-box pass">
        <small>${L('已达标门槛', 'Qualified')}</small>
        <b>${passed} / ${required}</b>
      </div>
    `;
  }

  const heroNum = document.getElementById('obs-passed-num');
  const prevPassed = heroNum ? Number(heroNum.dataset.val) : passed;
  if (heroNum && prevPassed !== passed) {
    heroNum.dataset.val = String(passed);
    heroNum.innerHTML = `<span class="ratio-cur">${passed}</span><span class="ratio-sep">/</span><span class="ratio-req">${required}</span>`;
  }

  const fillEl = document.getElementById('obs-progress-fill');
  if (fillEl) {
    const pct = Math.round(Math.min(100, (passed / required) * 100));
    if (batch || prevPassed === passed) {
      fillEl.classList.add('no-anim');
      fillEl.style.width = `${pct}%`;
      void fillEl.offsetWidth;
      fillEl.classList.remove('no-anim');
    } else {
      fillEl.classList.remove('no-anim');
      fillEl.style.width = `${pct}%`;
    }
  }

  const needEl = document.getElementById('obs-need-text');
  if (needEl) {
    needEl.textContent = need === 0
      ? L('已达本轮达标门槛，等待结算确认', 'Threshold met, awaiting settlement')
      : L(`还差 ${need} 个达标时段`, `${need} more qualified slots needed`);
  }
}

/** 绑定 24H 观测盘点选事件（稳态输出判定依据，零跳动） */
export function bindCorridorRadarEvents(root) {
  if (!root) return;
  const card = root.querySelector('#a9-radar-card');
  const rawTarget = card?.dataset?.targetPrice;
  const targetPrice = rawTarget ? Number(rawTarget) : null;

  const selectCandle = (cell) => {
    A9Haptic.light();
    const isConfirmed = cell.dataset.candleConfirmed === 'true';
    const isBull = cell.dataset.candleBull === 'true';
    const idx = Number(cell.dataset.candleIdx);
    if (isConfirmed && isBull) A9Audio.scaleChime(idx);
    else if (isConfirmed) A9Audio.stamp();
    else A9Audio.pageTurn();
    root.querySelectorAll('.candle-cell.selected').forEach(c => c.classList.remove('selected'));
    cell.classList.add('selected');
    cell.classList.remove('anim-slot-flip');
    void cell.offsetWidth;
    cell.classList.add('anim-slot-flip');
    setTimeout(() => cell.classList.remove('anim-slot-flip'), 340);
    const insp = root.querySelector('#candle-inspector');
    if (insp) {
      insp.innerHTML = buildInspectorHtml({
        index: idx,
        status: cell.dataset.candleStatus,
        bull: isBull,
        priceText: cell.dataset.candlePrice
      }, targetPrice, 0);
    }
  };

  root.querySelectorAll('[data-candle-idx]').forEach(cell => {
    cell.onclick = () => selectCandle(cell);
    cell.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectCandle(cell);
      }
    };
  });
}

/** 04 Sliding Highlight: Automatically sync elastic highlight pill inside all .seg-tabs */
export function syncSlidingSegTabs(root = document) {
  if (!root) return;
  root.querySelectorAll('.seg-tabs').forEach(bar => {
    const active = bar.querySelector('.seg-tab.active');
    if (!active) return;
    let pill = bar.querySelector('.seg-slider-pill');
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'seg-slider-pill';
      pill.setAttribute('aria-hidden', 'true');
      bar.insertBefore(pill, bar.firstChild);
      bar.classList.add('has-slider');
    }
    const w = active.offsetWidth;
    const x = active.offsetLeft;
    if (w > 0) {
      pill.style.width = `${w}px`;
      pill.style.transform = `translateX(${x}px)`;
    }
  });
}

export function renderViralStrip() {
  return `
    <div class="viral-strip" data-nav="/team/invite" role="button" tabindex="0">
      <div class="row-start">
        <span class="icon-badge amber">${icon('qr', 16)}</span>
        <div>
          <div style="font-weight:700;font-size:13.5px;">${L('邀请好友 · 邀请奖励 6%', 'Invite Friends · 6% Referral')}</div>
          <div class="num-xs text-sec">${L('宝箱直推 6% · 一键生成海报', '6% Chest Referral · 1-tap poster')}</div>
        </div>
      </div>
      <span class="chip chip-muted">${L('去分享', 'Share')} ${icon('chevronRight', 11)}</span>
    </div>
  `;
}
