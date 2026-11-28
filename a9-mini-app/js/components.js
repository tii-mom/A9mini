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

const interactionCleanups = new Set();
let heavyMod = null;
let heavyPromise = null;
let heavyLoader = () => import('./components-heavy.js');

/** 注册可卸载交互清理器（由按需加载的复杂组件模块注册） */
export function registerInteractionCleanup(fn) {
  if (typeof fn === 'function') interactionCleanups.add(fn);
}

export function cleanupActiveInteractions() {
  for (const fn of interactionCleanups) {
    try { fn(); } catch (_) {}
  }
}

/** 由 components-heavy.js 加载完成时自我注册，便于同步查询 */
export function registerHeavyComponentsModule(mod) {
  if (mod) heavyMod = mod;
}

/** 获取已加载的复杂组件模块（不触发网络请求） */
export function peekHeavyComponents() {
  return heavyMod;
}

/** 按需加载复杂组件模块（并发去重，失败自动清理以便重试） */
export function loadHeavyComponents() {
  if (heavyMod) return Promise.resolve(heavyMod);
  if (!heavyPromise) {
    let raw;
    try { raw = Promise.resolve(heavyLoader()); } catch (err) { raw = Promise.reject(err); }
    heavyPromise = raw
      .then((mod) => {
        heavyMod = mod;
        return mod;
      })
      .catch(() => {
        heavyPromise = null;
        return null;
      });
  }
  return heavyPromise;
}

/** 测试专用钩子：替换或重置复杂组件加载器 */
export function __setHeavyComponentsLoaderForTest(loader) {
  heavyMod = null;
  heavyPromise = null;
  heavyLoader = typeof loader === 'function' ? loader : () => import('./components-heavy.js');
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

export function openModal(html, { quest = false } = {}) {
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
  root.innerHTML = `<div class="modal-sheet${quest ? ' modal-sheet--quest' : ''}" tabindex="-1">${html}</div>`;
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

export function openChoiceSheet({ title, subtitle = '', options = [], selected, onSelect, cancelLabel = '' }) {
  A9Haptic.light();
  const safeCancel = cancelLabel || L('取消', 'Cancel');
  const selectedIdx = Math.max(0, options.findIndex((opt) => String(opt.value) === String(selected)));
  const activeCheckHtml = `<span class="chip chip-green" style="min-height:22px;padding:0 7px;">${icon('check', 12)} ${L('当前', 'Active')}</span>`;

  openModal(`
    <div class="sheet-handle"></div>
    <div class="row-between">
      <div style="min-width:0;">
        <div class="card-title">${escapeHtml(title)}</div>
        ${subtitle ? `<div class="sw-sheet-subtitle">${escapeHtml(subtitle)}</div>` : ''}
      </div>
      <button type="button" class="icon-btn" id="sheet-close" aria-label="${L('关闭', 'Close')}">${icon('x', 15)}</button>
    </div>
    <div class="sw-menu-group" id="sheet-radiogroup" role="radiogroup" aria-label="${escapeHtml(title)}">
      ${options.map((opt, idx) => {
        const isSel = idx === selectedIdx && options.length > 0;
        const iconHtml = opt.icon
          ? `<span class="sw-row-icon ${escapeHtml(opt.tone || (isSel ? 'is-green' : 'is-muted'))}" aria-hidden="true">${icon(opt.icon, 16)}</span>`
          : '';
        return `
          <button type="button" class="sw-menu-row sw-sheet-choice-row ${isSel ? 'is-selected' : ''}" role="radio" aria-checked="${isSel}" tabindex="${isSel ? '0' : '-1'}" data-choice-val="${escapeHtml(opt.value)}" data-choice-idx="${idx}">
            ${iconHtml}
            <div class="sw-menu-left">
              <span class="sw-menu-title">${escapeHtml(opt.label)}</span>
              ${opt.sub ? `<span class="sw-menu-sub">${escapeHtml(opt.sub)}</span>` : ''}
            </div>
            <div class="sw-menu-right" data-choice-indicator="1">
              ${isSel ? activeCheckHtml : ''}
            </div>
          </button>
        `;
      }).join('')}
    </div>
    <button type="button" class="btn btn-secondary sw-sheet-cancel" id="sheet-cancel">${escapeHtml(safeCancel)}</button>
  `);

  const closeBtn = document.getElementById('sheet-close');
  if (closeBtn) closeBtn.onclick = closeModal;
  const cancelBtn = document.getElementById('sheet-cancel');
  if (cancelBtn) cancelBtn.onclick = closeModal;

  const groupEl = document.getElementById('sheet-radiogroup');
  const rows = Array.from(document.querySelectorAll('[data-choice-val]'));

  const setActiveRadio = (nextIdx, { moveFocus = false } = {}) => {
    if (!rows.length) return;
    const wrapped = ((nextIdx % rows.length) + rows.length) % rows.length;
    rows.forEach((btn, idx) => {
      const checked = idx === wrapped;
      btn.setAttribute('aria-checked', String(checked));
      btn.setAttribute('tabindex', checked ? '0' : '-1');
      btn.classList?.toggle?.('is-selected', checked);
      const indicator = btn.querySelector?.('[data-choice-indicator]');
      if (indicator) indicator.innerHTML = checked ? activeCheckHtml : '';
    });
    if (moveFocus) {
      try {
        rows[wrapped].focus?.({ preventScroll: true });
      } catch (_) {
        try { rows[wrapped].focus?.(); } catch (_) {}
      }
    }
  };

  const commitRadio = (row) => {
    A9Haptic.tick();
    const val = row.dataset.choiceVal;
    closeModal();
    if (onSelect) onSelect(val);
  };

  rows.forEach((row, idx) => {
    row.onclick = () => {
      setActiveRadio(idx, { moveFocus: false });
      commitRadio(row);
    };
    row.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        A9Haptic.tick();
        setActiveRadio(idx + 1, { moveFocus: true });
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        A9Haptic.tick();
        setActiveRadio(idx - 1, { moveFocus: true });
      } else if (e.key === 'Home') {
        e.preventDefault();
        A9Haptic.tick();
        setActiveRadio(0, { moveFocus: true });
      } else if (e.key === 'End') {
        e.preventDefault();
        A9Haptic.tick();
        setActiveRadio(rows.length - 1, { moveFocus: true });
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        commitRadio(row);
      }
    };
  });

  if (rows[selectedIdx]) {
    try {
      rows[selectedIdx].focus?.({ preventScroll: true });
    } catch (_) {
      try { rows[selectedIdx].focus?.(); } catch (_) {}
    }
  } else if (groupEl) {
    try { groupEl.focus?.({ preventScroll: true }); } catch (_) {}
  }
}

export function openActionSheet({ title, subtitle = '', items = [], dangerItems = [], cancelLabel = '' }) {
  A9Haptic.light();
  const safeCancel = cancelLabel || L('取消', 'Cancel');
  const renderRows = (list, group) => list.map((item, idx) => `
    <button type="button" class="sw-menu-row sw-sheet-choice-row ${group === 'danger' ? 'is-danger-row' : ''}" data-sheet-group="${group}" data-sheet-idx="${idx}" ${item.disabled ? 'disabled' : ''}>
      ${item.icon ? `<span class="sw-row-icon ${escapeHtml(item.tone || (group === 'danger' ? 'is-red' : 'is-blue'))}" aria-hidden="true">${icon(item.icon, 16)}</span>` : ''}
      <div class="sw-menu-left">
        <span class="sw-menu-title">${escapeHtml(item.label)}</span>
        ${item.sub ? `<span class="sw-menu-sub">${escapeHtml(item.sub)}</span>` : ''}
      </div>
      <div class="sw-menu-right">
        ${item.badge ? `<span class="sw-menu-amount ${escapeHtml(item.badgeCls || '')}" style="font-size:12.5px;">${escapeHtml(item.badge)}</span>` : ''}
        <span class="sw-menu-arrow" aria-hidden="true">›</span>
      </div>
    </button>
  `).join('');

  openModal(`
    <div class="sheet-handle"></div>
    <div class="row-between">
      <div style="min-width:0;">
        <div class="card-title">${escapeHtml(title)}</div>
        ${subtitle ? `<div class="sw-sheet-subtitle">${escapeHtml(subtitle)}</div>` : ''}
      </div>
      <button type="button" class="icon-btn" id="sheet-close" aria-label="${L('关闭', 'Close')}">${icon('x', 15)}</button>
    </div>
    ${items.length ? `<div class="sw-menu-group">${renderRows(items, 'normal')}</div>` : ''}
    ${dangerItems.length ? `
      <div class="sw-sheet-danger-wrap">
        <div class="sw-section-label text-red" style="margin-bottom:5px;">${L('谨慎操作', 'Caution')}</div>
        <div class="sw-menu-group sw-sheet-danger-group">${renderRows(dangerItems, 'danger')}</div>
      </div>
    ` : ''}
    <button type="button" class="btn btn-secondary sw-sheet-cancel" id="sheet-cancel">${escapeHtml(safeCancel)}</button>
  `);

  const closeBtn = document.getElementById('sheet-close');
  if (closeBtn) closeBtn.onclick = closeModal;
  const cancelBtn = document.getElementById('sheet-cancel');
  if (cancelBtn) cancelBtn.onclick = closeModal;
  document.querySelectorAll('[data-sheet-group]').forEach((btn) => {
    btn.onclick = () => {
      const group = btn.dataset.sheetGroup;
      const idx = Number(btn.dataset.sheetIdx);
      const target = group === 'danger' ? dangerItems[idx] : items[idx];
      if (!target || target.disabled) return;
      A9Haptic.tick();
      if (target.keepOpen !== true) closeModal();
      if (typeof target.onSelect === 'function') target.onSelect();
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
