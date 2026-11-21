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
  const safe = Number.isFinite(num) ? num : 0;
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
  const colors = ['#FA660F', '#F25C05', '#1F2439'];

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
}

export function openChoiceSheet({ title, options, selected, onSelect }) {
  A9Haptic.light();
  openModal(`
    <div class="sheet-handle"></div>
    <div class="row-between">
      <div class="card-title">${title}</div>
      <button class="icon-btn" id="sheet-close" aria-label="Close">${icon('x', 15)}</button>
    </div>
    <div class="col-gap">
      ${options.map(opt => `
        <div class="list-row clickable ${opt.value === selected ? 'is-me' : ''}" data-choice-val="${opt.value}">
          <div>
            <div style="font-weight:600;font-size:13.5px;">${opt.label}</div>
            ${opt.sub ? `<div class="num-xs text-muted" style="margin-top:2px;">${opt.sub}</div>` : ''}
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
  const min = Math.min(...points) - 0.001;
  const max = Math.max(...points) + 0.001;
  const span = Math.max(0.002, max - min);
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
 * 3-Moment Interactive Slider:
 * 1. Drag: rAF-throttled smooth follow, single light haptic+tick at 80% threshold, 180ms rebound
 * 2. Submit: immediate "确认中" state
 * 3. Result: caller displays result & recovers if cancelled/failed
 * Also supports keyboard Enter/Space on the handle.
 */
export function mountSlider(containerEl, { label = '右滑确认', onConfirm }) {
  if (!containerEl) return;
  cleanupActiveInteractions();
  activeSliderAbort = new AbortController();
  const { signal } = activeSliderAbort;

  containerEl.innerHTML = `
    <div class="a9-slider">
      <div class="a9-slider-fill"></div>
      <div class="a9-slider-label">
        <span class="slider-text">${label}</span>
        <span class="chevron-seq text-green"><span>›</span><span>›</span><span>›</span></span>
      </div>
      <div class="a9-slider-handle" role="slider" tabindex="0" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">${icon('arrowRight', 19)}</div>
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
    slider.classList.remove('armed');
    slider.classList.add('completed');
    burstParticles(slider);
    A9Haptic.success();
    A9Audio.confirm();
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
        A9Haptic.light();
        A9Audio.tick();
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
    startX = getClientX(e);
    latestX = startX;
    maxDrag = Math.max(1, slider.clientWidth - handle.clientWidth - 8);
    handle.style.transition = 'none';
    fill.style.transition = 'none';
    handle.style.transform = 'scale(0.95)';
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
      slider.classList.remove('armed');
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

/**
 * Signature 24H Qualification Slot Matrix (2x12)
 * - 4 unmistakable shape + color states: bull (solid green), bear (solid red + notch), active (orange outline), pending (hollow gray)
 * - Explicit dual progress labels: 已确认 X/24 · 已达标 Y/16
 * - Clean data freshness indicator & top-right "全部记录 ›" link
 */
export function renderCorridorRadar(candles, targetPrice, activeCandleSec, livePrice, meta = {}) {
  const required = Number(meta.minQualified) || 16;
  const passed = Number.isFinite(meta.qualified) ? Number(meta.qualified)
    : candles.filter(c => c.status === 'closed' && c.bull).length;
  const confirmedSlots = candles.filter(c => c.status === 'closed').length;
  const activeCandle = candles.find(c => c.status === 'active');
  const activeIdx = activeCandle?.index || meta.seen || 0;
  const hasActive = Boolean(activeCandle);
  const priceText = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)))
    ? L('暂不可用', 'Unavailable') : `$${Number(v).toFixed(4)}`;
  const freshLabel = meta.stale
    ? L('更新中', 'Updating')
    : (livePrice === null || livePrice === undefined ? L('暂不可用', 'Unavailable') : L('实时', 'Live'));

  const cellsHtml = candles.map(c => {
    const cls = c.status === 'pending'
      ? 'pending'
      : c.status === 'active'
        ? 'active'
        : (c.bull ? 'bull' : 'bear');
    const priceAttr = c.p === null || c.p === undefined ? L('未开始', 'Pending') : priceText(c.p);
    return `
      <div class="candle-cell ${cls}" role="button" tabindex="0"
        data-candle-idx="${c.index}"
        data-candle-price="${priceAttr}"
        data-candle-bull="${Boolean(c.bull)}"
        data-candle-status="${c.status}"
        data-candle-confirmed="${c.status === 'closed'}"
        aria-label="${L(`第 ${c.index} 时段`, `Slot ${c.index}`)}">
        <div class="candle-body-wrap">
          <div class="candle-bar"></div>
        </div>
        <span class="candle-idx">${c.status === 'active' ? `${c.index}*` : c.index}</span>
      </div>
    `;
  }).join('');

  const sprintBadge = meta.sprint4h
    ? `<span class="chip chip-red" style="height:20px;font-size:10px;padding:0 7px;">${L('最后 4H 赛点冲刺', 'Last 4H Sprint')}</span>`
    : '';

  return `
    <div class="card" id="a9-radar-card">
      <div class="card-header" style="margin-bottom:8px;">
        <div class="row-start" style="gap:6px;flex-wrap:wrap;">
          <div class="card-title">${icon('radar', 15, 'text-green')} ${L('24H 时段记录', '24H Slot Record')}</div>
          ${sprintBadge}
        </div>
        <div class="row-start" style="gap:10px;">
          <button class="text-link-btn" type="button" data-x-share="round" style="color:var(--text-secondary);">${icon('xBrand', 12)} ${L('晒赛点', 'Share')}</button>
          <button class="text-link-btn" type="button" data-nav="/observation/records">${L('全部记录', 'All')} ${icon('chevronRight', 13)}</button>
        </div>
      </div>

      <div class="metric-strip" style="margin:6px 0 10px;padding:9px 0;">
        <div class="metric-cell">
          <span class="num-xs text-muted">${L('目标底价', 'Target Price')}</span>
          <span class="num-md">${targetPrice === null || targetPrice === undefined ? L('待定', 'TBD') : priceText(targetPrice)}</span>
        </div>
        <div class="metric-cell">
          <div class="row-between">
            <span class="num-xs text-muted">${L('判定均价', 'Judge TWAP')}</span>
            <span class="num-xs text-muted">${freshLabel}</span>
          </div>
          <span class="num-md text-green" id="live-twap-val">${priceText(livePrice)}</span>
        </div>
      </div>

      <div class="row-between num-xs" style="margin-bottom:8px;" id="radar-counts">
        <span class="text-sec">${L(`已确认 ${confirmedSlots}/24 段`, `${confirmedSlots}/24 confirmed`)}</span>
        <span class="text-green mono" style="font-weight:600;">${L(`已达标 ${passed}/${required} 段`, `${passed}/${required} qualified`)}</span>
      </div>

      <div class="corridor-wrap">
        <div class="candle-grid" id="a9-radar-grid">${cellsHtml}</div>
      </div>

      <div class="candle-inspector" id="candle-inspector" style="margin-top:10px;margin-bottom:0;">
        <span class="text-sec">${hasActive
          ? L(`第 ${activeIdx} 段 · 进行中（尚未确认）`, `Slot #${activeIdx} · In progress`)
          : L(`已确认 ${confirmedSlots}/24 段 · 点按任意格查看依据`, `${confirmedSlots}/24 confirmed · Tap a slot`)}</span>
        <span class="text-green mono" id="active-candle-cd">${hasActive ? `${L('剩余', 'Left')} ${formatTimer(activeCandleSec || 0).slice(3)}` : '—'}</span>
      </div>

      <div class="radar-legend" aria-hidden="true">
        <span class="legend-item"><span class="legend-dot bull"></span>${L('达标', 'Met')}</span>
        <span class="legend-item"><span class="legend-dot bear"></span>${L('未达标', 'Missed')}</span>
        <span class="legend-item"><span class="legend-dot active"></span>${L('进行中', 'Live')}</span>
        <span class="legend-item"><span class="legend-dot pending"></span>${L('未开始', 'Pending')}</span>
      </div>
    </div>
  `;
}

/**
 * In-Place Incremental 24H Radar & Observation Progress Updater
 * - Smooth 210ms transition ONLY when a slot actually transitions active -> closed
 * - Progress bar advances ONLY when qualified count actually changes
 * - Silent & vibration-free for all automatic/background updates
 */
export function syncRadarInPlace(round, { batch = false } = {}) {
  const grid = document.getElementById('a9-radar-grid');
  if (!grid || !Array.isArray(round.candles)) return;

  const required = round.minQualifiedCandles || 16;
  const passed = round.qualifiedCandles || 0;
  const need = Math.max(0, required - passed);
  const confirmedSlots = round.candles.filter(c => c.status === 'closed').length;
  const priceText = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)))
    ? L('暂不可用', 'Unavailable') : `$${Number(v).toFixed(4)}`;

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

    const idxEl = cell.querySelector('.candle-idx');
    if (idxEl) idxEl.textContent = c.status === 'active' ? `${c.index}*` : String(c.index);

    if (!batch && !reduced && prevStatus === 'active' && c.status === 'closed') {
      cell.classList.add('anim-slot-confirmed');
      setTimeout(() => cell.classList.remove('anim-slot-confirmed'), 240);
    }
  });

  // Update dual counts
  const countsEl = document.getElementById('radar-counts');
  if (countsEl) {
    countsEl.innerHTML = `
      <span class="text-sec">${L(`已确认 ${confirmedSlots}/24 段`, `${confirmedSlots}/24 confirmed`)}</span>
      <span class="text-green mono" style="font-weight:600;">${L(`已达标 ${passed}/${required} 段`, `${passed}/${required} qualified`)}</span>
    `;
  }

  // Update hero observation count & progress bar ONLY when qualified count changed
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

/** Bind tap & keyboard inspection on any rendered 24H crystal slot matrix (Home & Proof Detail) */
export function bindCorridorRadarEvents(root) {
  if (!root) return;
  const selectCandle = (cell) => {
    A9Haptic.light();
    root.querySelectorAll('.candle-cell.selected').forEach(c => c.classList.remove('selected'));
    cell.classList.add('selected');
    const idx = cell.dataset.candleIdx;
    const p = cell.dataset.candlePrice;
    const status = cell.dataset.candleStatus;
    const confirmed = cell.dataset.candleConfirmed === 'true';
    const stateLabel = status === 'pending'
      ? L('未开始', 'Pending')
      : confirmed
        ? L('已确认', 'Confirmed')
        : L('进行中（尚未确认）', 'In progress');
    const resultLabel = !confirmed ? '' : (cell.dataset.candleBull === 'true' ? L(' · 达标', ' · Met') : L(' · 未达标', ' · Missed'));
    const insp = root.querySelector('#candle-inspector');
    if (insp) {
      const valCls = confirmed ? (cell.dataset.candleBull === 'true' ? 'text-green' : 'text-red') : 'text-sec';
      insp.innerHTML = `<span class="text-sec">${L(`第 ${idx} 段`, `Slot #${idx}`)} · ${stateLabel}</span><span class="${valCls} mono">${p}${resultLabel}</span>`;
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
          <div style="font-weight:700;font-size:13.5px;">${L('邀请好友 · 邀请奖励 12%', 'Invite Friends · 12% Referral')}</div>
          <div class="num-xs text-sec">${L('团队奖励 18% · 一键生成海报', '18% Team Bonus · 1-tap poster')}</div>
        </div>
      </div>
      <span class="chip chip-muted">${L('去分享', 'Share')} ${icon('chevronRight', 11)}</span>
    </div>
  `;
}
