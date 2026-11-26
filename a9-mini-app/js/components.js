/**
 * A9 Precision Components (Engineering Spec v2)
 * - Signature 24H Qualification Slot Matrix (2x12, 4 shape/color states, in-place diffing)
 * - Multimodal 3-Moment Slider (rAF-throttled, single 80% threshold tick, 180ms rebound, keyboard accessible)
 * - Clean listener & rAF lifecycle teardown
 */

import { A9Haptic, isReducedMotion } from './tma.js';
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
  if (isReducedMotion()) return;
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
  const oneLine = str.replace(/\s+/g, ' ').trim();
  const toastMsg = oneLine.length > 36 || str.includes('\n')
    ? prefix
    : `${prefix}: ${oneLine}`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(str).then(
      () => showToast(toastMsg),
      () => {
        legacyCopy(str);
        showToast(toastMsg);
      }
    );
  } else {
    legacyCopy(str);
    showToast(toastMsg);
  }
}

const MODAL_FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let modalPrevFocus = null;
let modalScrollLocked = false;

function setModalScrollLock(locked) {
  if (typeof document === 'undefined') return;
  modalScrollLocked = Boolean(locked);
  document.documentElement?.classList?.toggle?.('modal-open', modalScrollLocked);
  document.body?.classList?.toggle?.('modal-open', modalScrollLocked);
}

function isElementFocusable(el, root) {
  if (!el) return false;
  if (el.disabled === true || el.hidden === true) return false;
  if (el.getAttribute?.('aria-hidden') === 'true') return false;
  const rawTabIndex = el.getAttribute?.('tabindex');
  if (rawTabIndex !== null && rawTabIndex !== undefined && rawTabIndex !== '') {
    const parsedTab = Number(rawTabIndex);
    if (Number.isFinite(parsedTab) && parsedTab < 0) return false;
  } else if (typeof el.tabIndex === 'number' && el.tabIndex < 0) {
    return false;
  }
  if (typeof el.closest === 'function' && el.closest('.hidden, [hidden], [inert], [aria-hidden="true"]')) {
    return false;
  }
  const getCS = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
    ? window.getComputedStyle
    : null;
  let cur = el;
  while (cur && cur !== root) {
    if (cur.inert === true || cur.hidden === true || cur.classList?.contains?.('hidden')) return false;
    if (getCS) {
      try {
        const cs = getCS(cur);
        if (cs) {
          if (cs.display === 'none') return false;
          if (cur === el && (cs.visibility === 'hidden' || cs.visibility === 'collapse')) return false;
        }
      } catch (_) {}
    } else if (cur.style) {
      if (cur.style.display === 'none') return false;
      if (cur === el && (cur.style.visibility === 'hidden' || cur.style.visibility === 'collapse')) return false;
    }
    cur = cur.parentElement;
  }
  return true;
}

function getModalFocusables(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return Array.from(root.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)).filter((el) => isElementFocusable(el, root));
}

function isModalOpen(root) {
  return Boolean(root && typeof root.classList?.contains === 'function' && !root.classList.contains('hidden'));
}

export function openModal(html) {
  const root = document.getElementById('modal-root');
  if (!root) return;
  const wasOpen = isModalOpen(root);
  // 若上一个弹层尚未关闭就被新弹层覆写，先触发 idle 信号，防止 openTxRiskConfirmModal 等等待弹层关闭的 Promise 永久悬挂；同时保留原始打开前焦点
  if (wasOpen && root.innerHTML) {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('a9:interaction-idle'));
    }
  } else {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    modalPrevFocus = active && active !== document.body && active !== document.documentElement ? active : null;
    setModalScrollLock(true);
  }
  root.innerHTML = `<div class="modal-sheet" tabindex="-1">${html}</div>`;
  const sheet = typeof root.querySelector === 'function' ? root.querySelector('.modal-sheet') : null;
  const titleEl = typeof sheet?.querySelector === 'function' ? sheet.querySelector('.card-title, h1, h2, h3') : null;
  if (titleEl) {
    if (!titleEl.id) titleEl.id = 'a9-modal-title';
    root.setAttribute?.('aria-labelledby', titleEl.id);
  } else {
    root.removeAttribute?.('aria-labelledby');
  }
  root.classList.remove('hidden');
  root.onclick = (e) => {
    if (e.target === root) closeModal();
  };
  const focusables = getModalFocusables(root);
  const initialTarget = focusables[0] || sheet;
  try {
    initialTarget?.focus?.({ preventScroll: true });
  } catch (_) {
    try { initialTarget?.focus?.(); } catch (_) {}
  }
}

document.addEventListener('keydown', (e) => {
  const root = document.getElementById('modal-root');
  if (!isModalOpen(root)) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal();
    return;
  }
  if (e.key === 'Tab') {
    const focusables = getModalFocusables(root);
    if (!focusables.length) {
      e.preventDefault();
      root.querySelector?.('.modal-sheet')?.focus?.();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const inside = typeof root.contains === 'function' ? root.contains(active) : true;
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus?.();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus?.();
    }
  }
});

export function closeModal() {
  const root = document.getElementById('modal-root');
  if (!root) return;
  const wasOpen = isModalOpen(root) || Boolean(root.innerHTML);
  root.classList.add('hidden');
  root.removeAttribute?.('aria-labelledby');
  root.innerHTML = '';
  if (modalScrollLocked) setModalScrollLock(false);
  const toRestore = modalPrevFocus;
  modalPrevFocus = null;
  if (wasOpen && toRestore && toRestore.isConnected !== false && typeof toRestore.focus === 'function') {
    try {
      toRestore.focus({ preventScroll: true });
    } catch (_) {
      try { toRestore.focus(); } catch (_) {}
    }
  }
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
        <div class="list-row clickable ${opt.value === selected ? 'is-me' : ''}" role="button" tabindex="0" data-choice-val="${escapeHtml(opt.value)}">
          <div style="text-align:left;">
            <div style="font-weight:600;font-size:13.5px;">${escapeHtml(opt.label)}</div>
            ${opt.sub ? `<div class="num-xs text-muted" style="margin-top:2px;">${escapeHtml(opt.sub)}</div>` : ''}
          </div>
          ${opt.value === selected ? `<span class="text-green">${icon('check', 16)}</span>` : '<span aria-hidden="true"></span>'}
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
export function mountSlider(containerEl, { label = L('右滑确认', 'Slide to Confirm'), onConfirm, onProgress = null, silentConfirmAudio = false }) {
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
  const finalText = `${prefix}${formatNum(target, decimals)}${suffix}`;
  if (isReducedMotion()) {
    el.textContent = finalText;
    return;
  }
  const t0 = performance.now();
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);
  function frame(now) {
    if (el.isConnected === false) return;
    if (isReducedMotion()) {
      el.textContent = finalText;
      return;
    }
    const p = Math.min(1, (now - t0) / duration);
    el.textContent = `${prefix}${formatNum(target * easeOut(p), decimals)}${suffix}`;
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** 领奖开箱抛物线金币动画（由宝箱飞向目标金额胶囊，尊重 reduced-motion） */
export function launchCoinArc(fromEl, toEl, count = 6) {
  if (!fromEl || !toEl) return;
  if (isReducedMotion()) return;
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
 * A9 标志性 12H 冲价手盖圆章矩阵
 * - 双分母顶标：已确认 X/12 · 已达标 Y/8
 * - 每格同时用编号 + 几何状态符号（✓ 达标 / × 未达标 / ◉ 冲价中青蓝 / · 未开始），颜色只作辅助
 * - 固定高度底部判定依据栏：并列展示本段 1H 均价、目标底价与明确结论，切格绝不跳动
 */
function buildInspectorHtml(slotInfo, targetPrice, activeCandleSec) {
  const targetStr = targetPrice === null || targetPrice === undefined || !Number.isFinite(Number(targetPrice)) || Number(targetPrice) <= 0
    ? L('待定', 'TBD') : `$${Number(targetPrice).toFixed(4)}`;
  const idx = slotInfo.index;
  const status = slotInfo.status;
  const confirmed = status === 'closed';
  const bull = Boolean(slotInfo.bull);
  const priceStr = slotInfo.priceText;

  let verdictText = L('未开始', 'Upcoming');
  let verdictCls = 'text-muted';
  let explain = L('等待到达该时段后再采集 1H 均价', 'Awaiting slot window');

  if (confirmed) {
    if (bull) {
      verdictText = L('已达标 ✓', 'Qualified ✓');
      verdictCls = 'text-green';
      explain = `${L('本段 1H 均价', 'Slot 1H TWAP')} ${priceStr} ≥ ${L('目标价', 'Target')} ${targetStr}`;
    } else {
      verdictText = L('未达标 ×', 'Missed ×');
      verdictCls = 'text-red';
      explain = `${L('本段 1H 均价', 'Slot 1H TWAP')} ${priceStr} < ${L('目标价', 'Target')} ${targetStr}`;
    }
  } else if (status === 'active') {
    verdictText = L('进行中 · 确认后盖章', 'Live · seals on close');
    verdictCls = 'text-gold';
    explain = `${L('当前均价', 'Current')} ${priceStr} · ${L('目标价', 'Target')} ${targetStr}`;
  } else if (status === 'unknown') {
    verdictText = L('数据待核验', 'Pending verification');
    verdictCls = 'text-muted';
    explain = L('该时段数据暂缺，请稍后刷新', 'Slot data pending verification');
  }

  const rightTimer = status === 'active'
    ? `<span class="text-gold mono" id="active-candle-cd">${L('进行中', 'Live')} · ${activeCandleSec > 0 ? formatTimer(activeCandleSec).slice(activeCandleSec >= 3600 ? 0 : 3) : L('待确认', 'Awaiting confirmation')}</span>`
    : `<span class="mono ${verdictCls}">${verdictText}</span>`;

  return `
    <div class="inspector-top">
      <span>${L(`第 ${idx} 时段`, `Slot #${idx}`)}</span>
      ${rightTimer}
    </div>
    <div class="inspector-basis">
      <span>${explain}</span>
      ${status === 'active' ? `<span class="text-gold">${L('确认后盖章', 'Seals hourly')}</span>` : ''}
    </div>
  `;
}

function renderStampCellInner(status, bull, index) {
  const numStr = String(index).padStart(2, '0');
  if (status === 'closed') {
    return `<span class="sw-stamp-mark" aria-hidden="true">${bull ? '✓' : '×'}</span><span class="sw-stamp-num">${numStr}</span>`;
  }
  if (status === 'active') {
    return `<span class="sw-stamp-dot" aria-hidden="true"></span><span class="sw-stamp-live-tag">${L('进行中', 'Live')}</span>`;
  }
  return `<span class="sw-stamp-num">${numStr}</span>`;
}

export function renderCorridorRadar(candles, targetPrice, activeCandleSec, livePrice, meta = {}) {
  const totalSlots = 12;
  const required = Number(meta.minQualified) || 8;
  const normalized = Array.from({ length: totalSlots }, (_, i) => {
    const idx = i + 1;
    const found = (candles || []).find((c) => c.index === idx) || (candles || [])[i] || null;
    if (!found) return { index: idx, status: 'pending', bull: false, p: null };
    const status = found.confirmed || found.status === 'closed'
      ? 'closed'
      : found.status === 'active'
        ? 'active'
        : 'pending';
    return { index: idx, status, bull: Boolean(found.bull), p: found.p ?? null };
  });

  const passed = Number.isFinite(meta.qualified) ? Number(meta.qualified)
    : normalized.filter((c) => c.status === 'closed' && c.bull).length;
  const confirmedSlots = Number.isFinite(meta.seen) ? Number(meta.seen)
    : normalized.filter((c) => c.status === 'closed').length;
  const activeCandle = normalized.find((c) => c.status === 'active');
  const lastConfirmed = [...normalized].reverse().find((c) => c.status === 'closed');
  const defaultSlot = activeCandle || lastConfirmed || normalized[0];
  const priceText = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) || Number(v) <= 0)
    ? '—' : `$${Number(v).toFixed(4)}`;
  const targetStr = priceText(targetPrice);
  const lastConfirmedPrice = lastConfirmed ? priceText(lastConfirmed.p) : priceText(livePrice);

  const cellsHtml = normalized.map((c) => {
    const stateCls = c.status === 'closed'
      ? (c.bull ? 'is-pass' : 'is-miss')
      : c.status === 'active'
        ? 'is-active'
        : 'is-pending';
    const isSel = c.index === defaultSlot.index;
    const pText = c.p === null || c.p === undefined ? '—' : priceText(c.p);
    return `
      <button type="button" class="sw-stamp-cell ${stateCls}${isSel ? ' is-selected' : ''}"
        data-candle-idx="${c.index}"
        data-candle-price="${pText}"
        data-candle-bull="${Boolean(c.bull)}"
        data-candle-status="${c.status}"
        data-candle-confirmed="${c.status === 'closed'}"
        aria-pressed="${isSel}"
        aria-label="${L(`第 ${c.index} 时段`, `Slot ${c.index}`)}">
        ${renderStampCellInner(c.status, c.bull, c.index)}
      </button>
    `;
  }).join('');

  const initSlotInfo = {
    index: defaultSlot.index,
    status: defaultSlot.status,
    bull: defaultSlot.bull,
    priceText: defaultSlot.p === null || defaultSlot.p === undefined ? '—' : priceText(defaultSlot.p)
  };

  return `
    <div class="card" id="a9-radar-card" data-target-price="${targetPrice ?? ''}">
      <div class="card-header" style="margin-bottom:8px;">
        <div class="card-title">${icon('stamp', 15, 'text-gold')} ${L('12H 关卡印章盘', '12H Stamp Board')}</div>
        <span class="num-xs text-muted mono">${L('已确认', 'Confirmed')} ${confirmedSlots}/12 · ${L('达标', 'Qualified')} ${passed}/${required}</span>
      </div>

      <div class="sw-stamp-grid" id="a9-radar-grid" role="group" aria-label="${L('12H 冲价时段印章', '12H push slot stamps')}">${cellsHtml}</div>

      <div class="candle-inspector" id="candle-inspector" aria-live="polite">
        ${buildInspectorHtml(initSlotInfo, targetPrice, activeCandleSec)}
      </div>

      <div class="row-between num-xs text-muted" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--card-border);">
        <span>${L('目标价', 'Target')} <b class="mono" style="color:var(--ink);">${targetStr}</b></span>
        <span>${L('最近确认 1H 均价', 'Last Confirmed 1H')} <b class="mono text-green" id="live-twap-val">${lastConfirmedPrice}</b></span>
      </div>
    </div>
  `;
}

/**
 * 增量原位更新 12H 冲价盘
 * - 平时保持安静，仅当某格真实从 active 转为 closed 时触发单格轻压动画
 */
export function syncRadarInPlace(round, { batch = false } = {}) {
  const grid = document.getElementById('a9-radar-grid');
  if (!grid || !Array.isArray(round.candles)) return;

  const required = round.minQualifiedCandles || 8;
  const passed = (round.qualifiedCandles !== null && round.qualifiedCandles !== undefined && Number.isFinite(Number(round.qualifiedCandles)))
    ? Number(round.qualifiedCandles)
    : null;
  const need = passed === null ? null : Math.max(0, required - passed);
  const priceText = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) <= 0)
    ? '—' : `$${Number(v).toFixed(4)}`;

  const reduced = isReducedMotion();

  round.candles.forEach((c) => {
    const cell = grid.querySelector(`[data-candle-idx="${c.index}"]`);
    if (!cell) return;
    const prevStatus = cell.dataset.candleStatus;
    const status = c.confirmed || c.status === 'closed' ? 'closed' : c.status === 'active' ? 'active' : 'pending';
    const stateCls = status === 'closed' ? (c.bull ? 'is-pass' : 'is-miss') : status === 'active' ? 'is-active' : 'is-pending';
    const wasSelected = cell.classList.contains('is-selected');

    cell.className = `sw-stamp-cell ${stateCls}${wasSelected ? ' is-selected' : ''}`;
    cell.dataset.candleStatus = status;
    cell.dataset.candleBull = String(Boolean(c.bull));
    cell.dataset.candleConfirmed = String(status === 'closed');
    cell.dataset.candlePrice = c.p === null || c.p === undefined ? '—' : priceText(c.p);
    cell.innerHTML = renderStampCellInner(status, Boolean(c.bull), c.index);

    if (!batch && !reduced && prevStatus === 'active' && status === 'closed') {
      cell.classList.add('anim-stamp-press');
      if (c.bull) A9Audio.scaleChime(passed);
      else A9Audio.stamp();
      setTimeout(() => cell.classList.remove('anim-stamp-press'), 300);
    }
  });

  const passedDisplay = passed === null ? '—' : String(passed);
  const heroNum = document.getElementById('obs-passed-num');
  const prevPassed = heroNum && heroNum.dataset.val !== '' && heroNum.dataset.val !== '—' ? Number(heroNum.dataset.val) : passed;
  if (heroNum && String(heroNum.dataset.val ?? '') !== passedDisplay) {
    heroNum.dataset.val = passedDisplay;
    heroNum.innerHTML = `<span class="ratio-cur">${passedDisplay}</span><span class="ratio-sep">/</span><span class="ratio-req">${required}</span>`;
  }

  const fillEl = document.getElementById('obs-progress-fill');
  if (fillEl) {
    const pct = passed === null ? 0 : Math.round(Math.min(100, (passed / required) * 100));
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
    needEl.textContent = need === null
      ? L('链上达标进度同步中…', 'Syncing qualified slots…')
      : (need === 0
        ? L('已达通关门槛，等待结算', 'Threshold met · awaiting settlement')
        : L(`还差 ${need} 个达标时段通关`, `${need} more qualifying slots needed`));
  }
}

/** 绑定 12H 冲价盘点选事件（稳态输出判定依据，零跳动） */
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
    root.querySelectorAll('.sw-stamp-cell.is-selected').forEach((c) => {
      c.classList.remove('is-selected');
      c.setAttribute('aria-pressed', 'false');
    });
    cell.classList.add('is-selected');
    cell.setAttribute('aria-pressed', 'true');
    const insp = root.querySelector('#candle-inspector');
    if (insp) {
      const activeTimer = insp.querySelector('#active-candle-cd')?.textContent;
      insp.innerHTML = buildInspectorHtml({
        index: idx,
        status: cell.dataset.candleStatus,
        bull: isBull,
        priceText: cell.dataset.candlePrice
      }, targetPrice, null);
      const timer = insp.querySelector('#active-candle-cd');
      if (timer && activeTimer) timer.textContent = activeTimer;
    }
  };

  root.querySelectorAll('[data-candle-idx]').forEach((cell) => {
    cell.onclick = () => selectCandle(cell);
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
