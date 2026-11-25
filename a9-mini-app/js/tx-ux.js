/**
 * A9 加密用户高频交互底座 (Wave 2)
 * - 交互态防重绘守卫 (shouldDeferRouteRender)：防止后台轮询打断弹窗、抽屉或输入焦点
 * - 签名前风控确认卡 (openTxRiskConfirmModal)：展示合约/热钱包缩写地址、一键复制、Tonviewer 链上查验与资金分解
 * - 交易 Pending 状态机 (pendingTxManager)：纯内存 + sessionStorage (a9_pending_tx_v1)，绝不写入 localStorage
 */

import { escapeHtml, copyText, openModal, closeModal } from './components.js';
import { icon } from './icons.js';
import { L } from './i18n.js';
import { A9Haptic } from './tma.js';

export const SESSION_PENDING_TX_KEY = 'a9_pending_tx_v1';
const PENDING_TX_MAX_AGE_MS = 10 * 60 * 1000;
const INTERACTION_IDLE_EVENT = 'a9:interaction-idle';
const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function getSafeSessionStorage() {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch (_) {
    return null;
  }
}

/** 判断当前用户是否处于弹窗、抽屉或表单输入中，若是则延迟后台轮询引发的整页重绘。 */
export function shouldDeferRouteRender(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return false;
  try {
    const modalRoot = doc.getElementById?.('modal-root');
    if (modalRoot && modalRoot.classList && !modalRoot.classList.contains('hidden')) {
      return true;
    }
    const simDrawer = doc.getElementById?.('sim-drawer');
    if (simDrawer && simDrawer.classList && !simDrawer.classList.contains('hidden')) {
      return true;
    }
    const active = doc.activeElement;
    if (active) {
      const tag = String(active.tagName || '').toUpperCase();
      if (EDITABLE_TAGS.has(tag) || active.isContentEditable === true) {
        return true;
      }
    }
  } catch (_) {
    return false;
  }
  return false;
}

/** 缩短 TON 合约或钱包地址以便在紧凑卡片内清晰展示。 */
export function shortAddress(address, head = 6, tail = 6) {
  const s = String(address || '').trim();
  if (!s) return '—';
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** 根据网络类型构造 Tonviewer 链上查验 URL（mainnet / testnet）。 */
export function buildTonviewerUrl(address, network = 'mainnet') {
  const addr = String(address || '').trim();
  if (!addr) return '';
  const isTestnet = String(network || '').trim().toLowerCase() === 'testnet';
  const host = isTestnet ? 'testnet.tonviewer.com' : 'tonviewer.com';
  return `https://${host}/${encodeURIComponent(addr)}`;
}

/**
 * 统一签名前透明化风控确认弹窗。
 * 用户点击遮罩、关闭或按 Esc 时均保证 resolve(false)，避免调用方锁定状态悬挂。
 */
export function openTxRiskConfirmModal({
  title,
  contractLabel,
  targetAddress,
  network = 'mainnet',
  principalText,
  gasText,
  totalText,
  memo = '',
  note = '',
  insufficientReason = '',
  confirmText,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (accepted, { close = true } = {}) => {
      if (settled) return;
      settled = true;
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener(INTERACTION_IDLE_EVENT, onModalClosed);
      }
      if (close) closeModal();
      resolve(Boolean(accepted));
    };
    const onModalClosed = () => finish(false, { close: false });

    const addrStr = String(targetAddress || '').trim();
    const explorerUrl = buildTonviewerUrl(addrStr, network);
    const blockedReason = String(insufficientReason || '').trim();
    const isNetTest = String(network || '').trim().toLowerCase() === 'testnet';
    const netLabel = isNetTest ? 'TON TESTNET' : 'TON MAINNET';

    openModal(`
      <div class="sheet-handle"></div>
      <div class="row-between" style="margin-bottom:10px;">
        <div class="card-title">${icon('shieldCheck', 17, 'text-green')} ${escapeHtml(title || L('交易签名前确认', 'Pre-Sign Security Check'))}</div>
        <button class="icon-btn" id="tx-confirm-close" type="button" aria-label="${L('关闭', 'Close')}">${icon('x', 15)}</button>
      </div>

      <div class="sub-tile" style="margin-bottom:10px;">
        <div class="row-between" style="margin-bottom:6px;">
          <span class="num-xs text-muted">${escapeHtml(contractLabel || L('目标链上地址', 'Target Address'))}</span>
          <span class="chip ${isNetTest ? 'chip-amber' : 'chip-cyan'} mono">${netLabel}</span>
        </div>
        <div class="row-between" style="gap:8px;">
          <span class="mono num-sm" style="font-weight:700;" title="${escapeHtml(addrStr)}">${escapeHtml(shortAddress(addrStr, 8, 6))}</span>
          <div class="row-start" style="gap:6px;">
            ${addrStr ? `<button class="pill-trigger neutral" id="tx-confirm-copy-addr" type="button">${icon('copy', 11)} ${L('复制', 'Copy')}</button>` : ''}
            ${explorerUrl ? `<a class="pill-trigger" href="${escapeHtml(explorerUrl)}" target="_blank" rel="noopener noreferrer">${L('链上查验', 'Tonviewer')} ${icon('external', 11)}</a>` : ''}
          </div>
        </div>
      </div>

      <div class="card" style="padding:10px 12px;margin-bottom:10px;">
        <div class="check-list">
          ${principalText ? `<div class="check-row"><span class="text-sec">${L('本金 / 资产', 'Principal / Asset')}</span><span class="mono" style="font-weight:700;">${escapeHtml(principalText)}</span></div>` : ''}
          ${gasText ? `<div class="check-row"><span class="text-sec">${L('链上 Gas / 手续费', 'On-Chain Gas / Fee')}</span><span class="mono text-sec">${escapeHtml(gasText)}</span></div>` : ''}
          ${totalText ? `<div class="check-row"><span class="text-sec">${L('本次合计签名', 'Total Signature')}</span><span class="mono text-green" style="font-weight:800;">${escapeHtml(totalText)}</span></div>` : ''}
          ${memo ? `<div class="check-row"><span class="text-sec">Memo</span><span class="mono num-xs">${escapeHtml(memo)}</span></div>` : ''}
        </div>
      </div>

      ${note ? `<div class="num-xs text-sec" style="margin-bottom:10px;line-height:1.5;">${escapeHtml(note)}</div>` : ''}

      ${blockedReason ? `
        <div class="card" id="tx-confirm-insufficient" style="border-color:var(--nt-red, #E60012);background:var(--nt-rose-soft, rgba(230,0,18,0.08));margin-bottom:10px;padding:10px 12px;">
          <div class="row-start num-xs text-red" style="font-weight:700;gap:6px;">${icon('shieldAlert', 14, 'text-red')} <span>${escapeHtml(blockedReason)}</span></div>
        </div>
      ` : ''}

      <div class="col-gap">
        <button class="btn ${blockedReason ? 'btn-secondary' : 'btn-primary'}" id="tx-confirm-ok" type="button" ${blockedReason ? 'disabled' : ''}>
          ${icon(blockedReason ? 'lock' : 'bolt', 16)} ${escapeHtml(blockedReason ? L('无法继续 · 请先满足前置条件', 'Blocked · Check Requirements') : (confirmText || L('确认参数并前往钱包签名', 'Confirm & Sign in Wallet')))}
        </button>
        <button class="btn btn-secondary" id="tx-confirm-cancel" type="button">${L('取消', 'Cancel')}</button>
      </div>
    `);

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener(INTERACTION_IDLE_EVENT, onModalClosed);
    }

    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) {
      finish(false, { close: false });
      return;
    }

    const copyBtn = doc.getElementById('tx-confirm-copy-addr');
    if (copyBtn && addrStr) {
      copyBtn.onclick = () => copyText(addrStr, L('已复制合约/钱包地址', 'Address copied'));
    }
    const closeBtn = doc.getElementById('tx-confirm-close');
    if (closeBtn) closeBtn.onclick = () => { A9Haptic.light(); finish(false); };
    const cancelBtn = doc.getElementById('tx-confirm-cancel');
    if (cancelBtn) cancelBtn.onclick = () => { A9Haptic.light(); finish(false); };
    const okBtn = doc.getElementById('tx-confirm-ok');
    if (okBtn && !blockedReason) {
      okBtn.onclick = () => {
        A9Haptic.medium();
        finish(true);
      };
    }
  });
}

export class PendingTxManager {
  constructor() {
    this._tx = this._readFromSession({ degradeInFlight: true });
    this._listeners = new Set();
    this._pollSeq = 0;
  }

  _readFromSession({ degradeInFlight = false } = {}) {
    const ss = getSafeSessionStorage();
    if (!ss) return null;
    try {
      const raw = ss.getItem(SESSION_PENDING_TX_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.id) return null;
      if (Date.now() - Number(parsed.startedAt || 0) > PENDING_TX_MAX_AGE_MS) {
        ss.removeItem(SESSION_PENDING_TX_KEY);
        return null;
      }
      if (degradeInFlight && (parsed.status === 'signed' || parsed.status === 'confirming')) {
        parsed.status = 'timeout';
        parsed.detail = parsed.detail || '页面已重新加载，请前往 Tonviewer 核验该笔链上交易状态。';
        parsed.detailEn = parsed.detailEn || 'Page reloaded; please verify this transaction on Tonviewer.';
        parsed.updatedAt = Date.now();
        ss.setItem(SESSION_PENDING_TX_KEY, JSON.stringify(parsed));
      }
      return parsed;
    } catch (_) {
      return null;
    }
  }

  _writeToSession(tx) {
    const ss = getSafeSessionStorage();
    if (!ss) return;
    try {
      if (!tx) ss.removeItem(SESSION_PENDING_TX_KEY);
      else ss.setItem(SESSION_PENDING_TX_KEY, JSON.stringify(tx));
    } catch (_) {}
  }

  _emit() {
    const snap = this.getActive();
    for (const fn of this._listeners) {
      try { fn(snap); } catch (_) {}
    }
  }

  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  getActive() {
    if (!this._tx) this._tx = this._readFromSession();
    if (this._tx && Date.now() - Number(this._tx.startedAt || 0) > PENDING_TX_MAX_AGE_MS) {
      this._tx = null;
      this._writeToSession(null);
    }
    return this._tx ? { ...this._tx } : null;
  }

  /** 若同类型（或全局）存在已签名/链上确认中的未完结交易，返回 true 防止重复连点。 */
  isLocked(kind = null) {
    const tx = this.getActive();
    if (!tx) return false;
    if (tx.status !== 'signed' && tx.status !== 'confirming') return false;
    return kind ? tx.kind === kind : true;
  }

  start({
    kind = 'tx',
    title = '链上交易处理中',
    titleEn = 'Transaction Pending',
    amountText = '',
    explorerAddress = '',
    refId = '',
    targetRoute = '',
    maxAttempts = 12,
  } = {}) {
    const now = Date.now();
    this._pollSeq += 1;
    this._tx = {
      id: `${kind}_${now}_${this._pollSeq}`,
      kind: String(kind),
      title: String(title),
      titleEn: String(titleEn),
      amountText: String(amountText || ''),
      explorerAddress: String(explorerAddress || ''),
      refId: String(refId || ''),
      targetRoute: String(targetRoute || ''),
      status: 'signed',
      attempt: 0,
      maxAttempts: Math.max(1, Number(maxAttempts) || 12),
      detail: '',
      detailEn: '',
      startedAt: now,
      updatedAt: now,
    };
    this._writeToSession(this._tx);
    this._emit();
    return this.getActive();
  }

  setStatus(status, extra = {}) {
    const cur = this.getActive();
    if (!cur) return null;
    const allowed = new Set(['signed', 'confirming', 'confirmed', 'timeout']);
    if (!allowed.has(status)) return cur;
    this._tx = {
      ...cur,
      ...extra,
      status,
      updatedAt: Date.now(),
    };
    this._writeToSession(this._tx);
    this._emit();
    return this.getActive();
  }

  clear() {
    this._pollSeq += 1;
    this._tx = null;
    this._writeToSession(null);
    this._emit();
  }

  /**
   * 短间隔后台轮询链上/订单终态（默认 4s × 12 次），到账即收口通知并解锁。
   */
  async pollUntilConfirmed({
    txId = null,
    checkFn,
    intervalMs = 4000,
    maxAttempts = 12,
    onConfirmed = null,
    onTimeout = null,
  } = {}) {
    if (typeof checkFn !== 'function') return { confirmed: false };
    const seq = ++this._pollSeq;
    const total = Math.max(1, Number(maxAttempts) || 12);
    const delay = Math.max(0, Number(intervalMs) ?? 4000);
    const matchesTx = () => {
      if (seq !== this._pollSeq) return false;
      const cur = this.getActive();
      return Boolean(cur && (!txId || cur.id === txId));
    };

    if (!matchesTx()) return { confirmed: false };
    this.setStatus('confirming', { attempt: 0, maxAttempts: total });

    for (let i = 1; i <= total; i += 1) {
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
      if (!matchesTx()) return { confirmed: false, aborted: true };
      this.setStatus('confirming', { attempt: i, maxAttempts: total });
      try {
        const res = await checkFn(i);
        if (!matchesTx()) return { confirmed: false, aborted: true };
        if (res && (res === true || res.confirmed)) {
          this.setStatus('confirmed', {
            attempt: i,
            detail: res.detail || '',
            detailEn: res.detailEn || '',
          });
          A9Haptic.success();
          if (onConfirmed) await onConfirmed(res);
          return { confirmed: true, result: res };
        }
        if (res && res.terminal) {
          this.clear();
          return { confirmed: false, terminal: true, result: res };
        }
      } catch (_) {
        // 单次网络抖动不终止后续确认轮询
      }
    }

    if (!matchesTx()) return { confirmed: false, aborted: true };
    this.setStatus('timeout', { attempt: total, maxAttempts: total });
    if (onTimeout) await onTimeout();
    return { confirmed: false, timeout: true };
  }
}

export const pendingTxManager = new PendingTxManager();

/** 渲染顶部的全局在途交易状态条（#a9-pending-tx-bar 内使用，零 Emoji）。 */
export function renderPendingTxBannerHtml(tx, network = 'mainnet') {
  if (!tx) return '';
  const statusMap = {
    signed: {
      chipCls: 'chip-gold',
      chipZh: '已签名',
      chipEn: 'SIGNED',
      descZh: '交易已广播至 TON 网络，正在等待区块回执…',
      descEn: 'Signed and broadcast to TON, awaiting block receipt…',
      border: 'var(--gold-border)',
      ic: 'bolt',
      icCls: 'text-gold',
    },
    confirming: {
      chipCls: 'chip-cyan',
      chipZh: `确认中 ${tx.attempt || 0}/${tx.maxAttempts || 12}`,
      chipEn: `CONFIRMING ${tx.attempt || 0}/${tx.maxAttempts || 12}`,
      descZh: '正在核验链上到账状态，请勿重复签名提交…',
      descEn: 'Verifying on-chain finality; duplicate clicks locked…',
      border: 'var(--card-border-strong, var(--card-border))',
      ic: 'clock',
      icCls: 'text-cyan',
    },
    confirmed: {
      chipCls: 'chip-green',
      chipZh: '已到账确认',
      chipEn: 'CONFIRMED',
      descZh: tx.detail || '链上交易已确认完成，资产或凭证已更新。',
      descEn: tx.detailEn || 'Transaction confirmed on-chain; assets updated.',
      border: 'var(--nt-green)',
      ic: 'checkCircle',
      icCls: 'text-green',
    },
    timeout: {
      chipCls: 'chip-amber',
      chipZh: '确认超时提示',
      chipEn: 'VERIFY ON CHAIN',
      descZh: tx.detail || '区块确认耗时长于预期，请前往 Tonviewer 核验最终结果。',
      descEn: tx.detailEn || 'Taking longer than usual; please verify finality on Tonviewer.',
      border: 'var(--gold-border)',
      ic: 'alert',
      icCls: 'text-gold',
    },
  };
  const meta = statusMap[tx.status] || statusMap.confirming;
  const explorerUrl = tx.explorerAddress ? buildTonviewerUrl(tx.explorerAddress, network) : '';
  const canDismiss = tx.status === 'confirmed' || tx.status === 'timeout';

  return `
    <div class="card" id="a9-pending-tx-bar" style="border-color:${meta.border};padding:10px 12px;margin-bottom:2px;">
      <div class="row-between" style="gap:8px;">
        <div class="row-start" style="font-weight:700;font-size:13px;gap:6px;min-width:0;">
          ${icon(meta.ic, 15, meta.icCls)}
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(L(tx.title || '链上交易处理中', tx.titleEn || tx.title || 'Transaction Pending'))}${tx.amountText ? ` · ${escapeHtml(tx.amountText)}` : ''}</span>
        </div>
        <div class="row-start" style="gap:6px;flex-shrink:0;">
          <span class="chip ${meta.chipCls} mono">${escapeHtml(L(meta.chipZh, meta.chipEn))}</span>
          ${canDismiss ? `<button class="icon-btn" id="btn-dismiss-pending-tx" type="button" aria-label="${L('关闭提示', 'Dismiss')}" style="width:26px;height:26px;">${icon('x', 13)}</button>` : ''}
        </div>
      </div>
      <div class="row-between" style="margin-top:6px;gap:8px;">
        <span class="num-xs text-sec" style="line-height:1.4;">${escapeHtml(L(meta.descZh, meta.descEn))}</span>
        ${explorerUrl ? `<a class="pill-trigger neutral" href="${escapeHtml(explorerUrl)}" target="_blank" rel="noopener noreferrer" style="flex-shrink:0;">Tonviewer ${icon('external', 11)}</a>` : ''}
      </div>
    </div>
  `;
}
